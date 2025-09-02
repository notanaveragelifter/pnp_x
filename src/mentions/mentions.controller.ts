import { Controller, Get, Param, Query } from '@nestjs/common';
import { MentionsService } from './mentions.service';
import { SupabaseService } from '../shared/supabase.service';

@Controller('mentions')
export class MentionsController {
  constructor(private readonly mentions: MentionsService, private readonly supabase: SupabaseService) {}

  // GET /mentions?save=true
  @Get()
  async getMentions(@Query('save') save?: string) {
    const shouldSave = typeof save === 'string' ? save === 'true' : false;
    return this.mentions.fetchRecentMentions(shouldSave);
  }

  // GET /data/:id -> fetch single row by id
  @Get('/data/:id')
  async getDataById(@Param('id') id: string) {
    const parsed = Number(id);
    if (!Number.isFinite(parsed)) return { error: 'Invalid id' };
    const row = await this.supabase.getTwitterDataById(parsed);
    return row?.tweets_json ?? {};
  }

  // GET /data?from=1&to=10 -> fetch rows in id range
  @Get('/data')
  async getDataInRange(@Query('from') from?: string, @Query('to') to?: string) {
    if (from == null || to == null) {
      return { error: 'Missing from/to query params' };
    }
    const f = Number(from);
    const t = Number(to);
    if (!Number.isFinite(f) || !Number.isFinite(t)) return { error: 'Invalid from/to' };
    const rows = await this.supabase.getTwitterDataInRange(f, t);
    return (rows || []).map((r: any) => r?.tweets_json).filter((x: any) => x != null);
  }
}
