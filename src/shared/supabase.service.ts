import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

@Injectable()
export class SupabaseService {
  private client: SupabaseClient;

  constructor(private readonly config: ConfigService) {
    const url = this.config.get<string>('SUPABASE_URL');
    const key = this.config.get<string>('SUPABASE_SERVICE_KEY') || this.config.get<string>('SUPABASE_ANON_KEY');
    if (!url || !key) {
      throw new Error('SUPABASE_URL or SUPABASE_SERVICE_KEY/ANON_KEY missing in environment.');
    }
    this.client = createClient(url, key);
  }

  async insertTwitterData(rows: Array<{ tweets_json: any; market_pda: string | null }>) {
    const { data, error } = await this.client.from('twitter_data').insert(rows);
    if (error) throw error;
    return data;
  }

  async getTwitterDataById(id: number) {
    const { data, error } = await this.client
      .from('twitter_data')
      .select('*')
      .eq('id', id)
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    return data;
  }

  async getTwitterDataInRange(from: number, to: number) {
    const low = Math.min(from, to);
    const high = Math.max(from, to);
    const { data, error } = await this.client
      .from('twitter_data')
      .select('*')
      .gte('id', low)
      .lte('id', high)
      .order('id', { ascending: true });
    if (error) throw error;
    return data;
  }
}
