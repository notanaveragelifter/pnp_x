import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression, Interval } from '@nestjs/schedule';
import { TwitterApi, TweetV2 } from 'twitter-api-v2';
import { FileStorageService } from '../shared/file-storage.service';
import { SupabaseService } from '../shared/supabase.service';

export interface MentionsFetchMeta {
  target_account: string;
  start_date: string;
  end_date: string;
  last_7_days: boolean;
}

// Derive market_pda for a stored tweet from its entities.urls
// Returns the first matching PDA found (or null if none)
// The tweet we store already has marketPDA on each url when available.
// We still recompute here in case of shape differences.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function pickMarketPDAFromEntities(entities: any): string | null {
  try {
    const urls = entities?.urls || [];
    for (const u of urls) {
      if (u?.marketPDA) return String(u.marketPDA);
      const candidate = u?.expanded_url || u?.url || u?.display_url;
      const pda = extractMarketPDA(candidate);
      if (pda) return pda;
    }
  } catch (_) {}
  return null;
}

@Injectable()
export class MentionsService implements OnModuleInit {
  private readonly logger = new Logger(MentionsService.name);
  private sinceId?: string; // track most recent mention id seen

  constructor(
    private readonly config: ConfigService,
    private readonly twitter: TwitterApi,
    private readonly fileStorage: FileStorageService,
    private readonly supabase: SupabaseService,
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

    if (save && tweets.length > 0) {
      const rows = tweets.map((t) => ({
        tweets_json: t,
        market_pda: this.getMarketPDAFromTweet(t as any),
      }));
      await this.supabase.insertTwitterData(rows);
    }

    return output;
  }

  // Poll every ~15s for new mentions and append immediately
  @Interval(15000)
  async pollNewMentions() {
    const disabled = this.config.get<string>('MENTIONS_POLL_ENABLED');
    if (disabled && disabled.toLowerCase() === 'false') return;

    const targetAccount = this.config.get<string>('TARGET_ACCOUNT') || 'predictandpump';

    try {
      const data = await this.searchMentions(targetAccount, undefined, undefined, this.sinceId);
      const newTweets = data.tweets || [];
      if (newTweets.length === 0) return;

      // Ensure chronological logging (oldest first)
      const chronological = [...newTweets].reverse();
      for (const t of chronological) {
        this.logger.log(`@${targetAccount} mentioned by user ${t.author_id} at ${t.created_at}: ${truncateText(String(t.text))}`);
      }

      // Insert into Supabase: each tweet as a row with tweets_json and market_pda
      const rows = chronological.map((t) => ({
        tweets_json: t,
        market_pda: this.getMarketPDAFromTweet(t as any),
      }));
      await this.supabase.insertTwitterData(rows);

      // Update since_id to the max id just seen among ALL fetched tweets (even if filtered out)
      const maxId = data.maxSeenId || this.sinceId;
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

  // Check if a tweet contains a pnp.exchange/{marketPDA} link
  private hasPnpMarketLink(tweet: Partial<TweetV2> & { entities?: any; text?: string }): boolean {
    const re = /https?:\/\/(?:www\.)?pnp\.exchange\/[A-Za-z0-9][A-Za-z0-9-_]*/i;
    const urls: string[] = (tweet as any)?.entities?.urls?.map((u: any) => u?.expanded_url || u?.url || u?.display_url || '').filter(Boolean) || [];
    if (urls.some((u) => re.test(String(u)))) return true;
    return hasPnpMarketUrlInText(tweet.text);
  }

  // Derive a single market_pda value from a tweet's entities
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private getMarketPDAFromTweet(tweet: any): string | null {
    return pickMarketPDAFromEntities(tweet?.entities) || null;
  }

  private async searchMentions(username: string, startDate?: Date, endDate?: Date, sinceId?: string) {
    const maxResults = 100; // max per page
    // Fetch only mentions of the target account; we'll further filter for pnp.exchange market links below.
    // Adding has:links narrows API results and we still apply a strict URL filter.
    const query = `@${username} has:links -is:retweet`;

    const startTime = startDate ? startDate.toISOString() : undefined;
    const endTime = endDate ? endDate.toISOString() : undefined;

    const tweets: Array<Partial<TweetV2> & { is_mention_of_target: boolean }> = [];
    let maxSeenId: string | undefined = this.sinceId;

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
        // Track max seen id regardless of filter match
        try {
          if (!maxSeenId || BigInt(tweet.id) > BigInt(maxSeenId)) {
            maxSeenId = String(tweet.id);
          }
        } catch (_) {
          // ignore BigInt parsing issues and fallback to last value
          maxSeenId = String(tweet.id);
        }

        // Only keep tweets that contain a pnp.exchange/{marketPDA} style link
        if (!this.hasPnpMarketLink(tweet)) continue;

        // Clone and augment entities with derived marketPDA for pnp.exchange links
        const augmentedEntities: any = tweet.entities
          ? {
              ...tweet.entities,
              urls: (tweet.entities as any)?.urls?.map((u: any) => {
                const urlCandidate = u?.expanded_url || u?.url || u?.display_url || '';
                const marketPDA = extractMarketPDA(urlCandidate);
                return marketPDA ? { ...u, marketPDA } : u;
              }),
            }
          : undefined;

        tweets.push({
          id: tweet.id,
          text: tweet.text,
          created_at: tweet.created_at,
          author_id: tweet.author_id,
          conversation_id: tweet.conversation_id,
          public_metrics: tweet.public_metrics,
          entities: augmentedEntities,
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

    return { tweets, maxSeenId };
  }

  private async fetchLatestMentionId(username: string): Promise<string | undefined> {
    try {
      // Prime using mentions so sinceId advances with the mentions stream
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

// Helper: check if a tweet contains a pnp.exchange/{marketPDA} link
// Accepts links like:
// - https://pnp.exchange/XXXXX
// - http://pnp.exchange/XXXXX
// where XXXXX is at least one URL-safe character (base58-like in practice)
// We look in entities.urls first, then fallback to scanning the text.
function normalizeString(s?: string): string {
  return (s || '').trim();
}

function hasPnpMarketUrlInText(text?: string): boolean {
  const t = normalizeString(text);
  if (!t) return false;
  const re = /https?:\/\/(?:www\.)?pnp\.exchange\/[A-Za-z0-9][A-Za-z0-9-_]*/i;
  return re.test(t);
}

// Extract the market PDA from a pnp.exchange URL
// Examples:
//  - https://pnp.exchange/ABCDEFG => ABCDEFG
//  - https://www.pnp.exchange/ABCDEFG?ref=1 => ABCDEFG
//  - http://pnp.exchange/ABCDEFG/ => ABCDEFG
function extractMarketPDA(rawUrl: string): string | undefined {
  if (!rawUrl) return undefined;
  try {
    // If it's a bare path like pnp.exchange/XXX in display_url, prepend protocol for parsing
    const normalized = rawUrl.startsWith('http') ? rawUrl : `https://${rawUrl}`;
    const u = new URL(normalized);
    if (!/^(?:www\.)?pnp\.exchange$/i.test(u.hostname)) return undefined;
    const path = u.pathname || '';
    const seg = path.replace(/^\//, '').split('/')[0];
    if (!seg) return undefined;
    // Basic validation: first char alnum; allow A-Za-z0-9-_ thereafter
    if (!/^[A-Za-z0-9][A-Za-z0-9-_]*$/.test(seg)) return undefined;
    return seg;
  } catch (_) {
    return undefined;
  }
}

