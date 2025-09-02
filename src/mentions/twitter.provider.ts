import { Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TwitterApi } from 'twitter-api-v2';

export const TwitterClientProvider: Provider = {
  provide: TwitterApi,
  useFactory: (config: ConfigService) => {
    const token = config.get<string>('TWITTER_BEARER_TOKEN');
    if (!token) {
      throw new Error('TWITTER_BEARER_TOKEN is missing. Set it in your environment.');
    }
    return new TwitterApi(token);
  },
  inject: [ConfigService],
};
