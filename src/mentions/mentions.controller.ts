import { Controller, Get, Query } from '@nestjs/common';
import { MentionsService } from './mentions.service';

@Controller('mentions')
export class MentionsController {
  constructor(private readonly mentions: MentionsService) {}

  // GET /mentions?save=true
  @Get()
  async getMentions(@Query('save') save?: string) {
    const shouldSave = typeof save === 'string' ? save === 'true' : false;
    return this.mentions.fetchRecentMentions(shouldSave);
  }
}
