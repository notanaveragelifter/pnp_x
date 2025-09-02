import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression, Interval } from '@nestjs/schedule';
import { TwitterApi, TweetV2 } from 'twitter-api-v2';
import { FileStorageService } from '../shared/file-storage.service';

export interface MentionsFetchMeta {
  target_account: string;
  start_date: string;
  end_date: string;
  last_7_days: boolean;
}

@Injectable()
export class MentionsService implements OnModuleInit {
  private readonly logger = new Logger(MentionsService.name);
  private sinceId?: string; // track most recent mention id seen

  constructor(
    private readonly config: ConfigService,
    private readonly twitter: TwitterApi,
    private readonly fileStorage: FileStorageService,
  ) {}

  async onModuleInit() {
    // Prime sinceId with the most recent mention so we don't dump old tweets on startup
    try {
      const targetAccount = this.config.get<string>('TARGET_ACCOUNT') || 'predictandpump';
      this.validateCredentials();
      const latest = await this.fetchLatestMentionId(targetAccount);
      if (latest) {
        this.sinceId = latest;
        this.logger.log(`Primed since_id with latest mention id=${latest}`);
      }
    } catch (e) {
      this.logger.warn(`Unable to prime since_id: ${e?.message || e}`);
    }
  }

  // Public method to trigger a fetch on-demand
  async fetchRecentMentions(save = false) {
    const targetAccount = this.config.get<string>('TARGET_ACCOUNT') || 'predictandpump';

    // Compute last 7 days window
    const endDate = new Date();
    const startDate = new Date(endDate.getTime() - 7 * 24 * 60 * 60 * 1000);

    this.validateCredentials();

    this.logger.log(`Fetching mentions for @${targetAccount} from ${startDate.toISOString()} to ${endDate.toISOString()}`);

    const { tweets } = await this.searchMentions(targetAccount, startDate, endDate);

    const output = {
      metadata: {
        count: tweets.length,
        generated_at: new Date().toISOString(),
        query_parameters: {
          target_account: targetAccount,
          start_date: startDate.toISOString(),
          end_date: endDate.toISOString(),
          last_7_days: true,
        },
      },
      tweets,
    };

    if (save) {
      const outputPath = this.config.get<string>('OUTPUT_PATH') || 'data/tweets.json';
      await this.fileStorage.saveJson(outputPath, output);
    }

    return output;
  }

  // Poll every ~15s for new mentions and append immediately
  @Interval(15000)
  async pollNewMentions() {
    const disabled = this.config.get<string>('MENTIONS_POLL_ENABLED');
    if (disabled && disabled.toLowerCase() === 'false') return;

    const targetAccount = this.config.get<string>('TARGET_ACCOUNT') || 'predictandpump';
    const outputPath = this.config.get<string>('OUTPUT_PATH') || 'data/tweets.json';

    try {
      const data = await this.searchMentions(targetAccount, undefined, undefined, this.sinceId);
      const newTweets = data.tweets || [];
      if (newTweets.length === 0) return;

      // Ensure chronological logging (oldest first)
      const chronological = [...newTweets].reverse();
      for (const t of chronological) {
        this.logger.log(`@${targetAccount} mentioned by user ${t.author_id} at ${t.created_at}: ${truncateText(String(t.text))}`);
      }

      // Append to file with metadata update
      await this.fileStorage.appendTweets(outputPath, chronological, {
        target_account: targetAccount,
        last_7_days: true,
      });

      // Update since_id to the max id just seen
      const maxId = newTweets.reduce((acc, t: any) => (acc && BigInt(acc) > BigInt(t.id) ? acc : String(t.id)), this.sinceId);
      if (maxId) this.sinceId = maxId;
    } catch (e) {
      this.logger.warn(`Polling mentions failed: ${e?.message || e}`);
    }
  }

  // Cron to run every hour and save to file
  @Cron(CronExpression.EVERY_HOUR)
  async cronIndexMentions() {
    const enableCron = this.config.get<string>('MENTIONS_CRON_ENABLED');
    if (enableCron && enableCron.toLowerCase() === 'false') {
      return; // allow disabling via env
    }
    try {
      await this.fetchRecentMentions(true);
      this.logger.log('Cron mentions fetch completed');
    } catch (e) {
      this.logger.error(`Cron mentions fetch failed: ${e?.message || e}`);
    }
  }

  private validateCredentials() {
    const bearer = this.config.get<string>('TWITTER_BEARER_TOKEN');
    if (!bearer) {
      throw new Error('TWITTER_BEARER_TOKEN is missing. Add it to your environment.');
    }
  }

  private async searchMentions(username: string, startDate?: Date, endDate?: Date, sinceId?: string) {
    const maxResults = 100; // max per page
    const query = `@${username} -is:retweet`;

    const startTime = startDate ? startDate.toISOString() : undefined;
    const endTime = endDate ? endDate.toISOString() : undefined;

    const tweets: Array<Partial<TweetV2> & { is_mention_of_target: boolean }> = [];

    try {
      const paginator = await this.twitter.v2.search(query, {
        'start_time': startTime,
        'end_time': endTime,
        'since_id': sinceId,
        'max_results': maxResults,
        'tweet.fields': [
          'id',
          'text',
          'created_at',
          'public_metrics',
          'author_id',
          'conversation_id',
          'entities',
          'referenced_tweets',
          'lang',
          'source',
          'in_reply_to_user_id',
        ],
        expansions: ['author_id', 'referenced_tweets.id'],
      });

      for await (const tweet of paginator) {
        tweets.push({
          id: tweet.id,
          text: tweet.text,
          created_at: tweet.created_at,
          author_id: tweet.author_id,
          conversation_id: tweet.conversation_id,
          public_metrics: tweet.public_metrics,
          entities: tweet.entities,
          referenced_tweets: tweet.referenced_tweets,
          lang: tweet.lang,
          source: tweet.source,
          in_reply_to_user_id: (tweet as any).in_reply_to_user_id,
          is_mention_of_target: true,
        });
      }
    } catch (error: any) {
      if (error?.code === 429) {
        this.logger.warn('Rate limit reached while fetching mentions.');
      } else if (typeof error?.message === 'string' && (error.message.includes('400') || error.message.includes('Invalid Request'))) {
        this.logger.error('Twitter API rejected the date range. The recent search API typically only supports last 7 days.');
      } else {
        this.logger.error(`Error fetching mentions: ${error?.message || error}`);
      }
    }

    return { tweets };
  }

  private async fetchLatestMentionId(username: string): Promise<string | undefined> {
    try {
      const res = await this.twitter.v2.search(`@${username} -is:retweet`, {
        max_results: 10,
        'tweet.fields': ['id', 'created_at'],
      });
      const first = res.tweets?.[0];
      return first?.id;
    } catch (e) {
      this.logger.warn(`Failed to fetch latest mention id: ${e?.message || e}`);
      return undefined;
    }
  }
}

function truncateText(text: string, max = 180) {
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
}
