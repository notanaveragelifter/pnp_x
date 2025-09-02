import { Injectable } from '@nestjs/common';
import { promises as fs } from 'fs';
import * as path from 'path';

@Injectable()
export class FileStorageService {
  async saveJson(outputPath: string, data: any) {
    const dir = path.dirname(outputPath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(outputPath, JSON.stringify(data, null, 2), 'utf-8');
    return { path: outputPath };
  }

  async appendTweets(outputPath: string, tweets: any[], meta?: { target_account?: string; last_7_days?: boolean }) {
    const dir = path.dirname(outputPath);
    await fs.mkdir(dir, { recursive: true });

    let current: any = {
      metadata: {
        count: 0,
        generated_at: new Date().toISOString(),
        query_parameters: {
          target_account: meta?.target_account || 'unknown',
          start_date: undefined,
          end_date: undefined,
          last_7_days: meta?.last_7_days === true,
        },
      },
      tweets: [],
    };

    try {
      const existing = await fs.readFile(outputPath, 'utf-8');
      current = JSON.parse(existing);
    } catch (_) {
      // file may not exist; we'll create it
    }

    current.tweets = [...(current.tweets || []), ...tweets];
    current.metadata.count = current.tweets.length;
    current.metadata.generated_at = new Date().toISOString();
    if (meta?.target_account) current.metadata.query_parameters.target_account = meta.target_account;
    if (typeof meta?.last_7_days === 'boolean') current.metadata.query_parameters.last_7_days = meta.last_7_days;

    await fs.writeFile(outputPath, JSON.stringify(current, null, 2), 'utf-8');
    return { path: outputPath, appended: tweets.length, total: current.metadata.count };
  }
}
