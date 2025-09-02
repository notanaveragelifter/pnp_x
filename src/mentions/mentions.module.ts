import { Module } from '@nestjs/common';
import { MentionsService } from './mentions.service';
import { MentionsController } from './mentions.controller';
import { TwitterClientProvider } from './twitter.provider';
import { FileStorageService } from '../shared/file-storage.service';
import { SupabaseService } from '../shared/supabase.service';

@Module({
  imports: [],
  controllers: [MentionsController],
  providers: [MentionsService, TwitterClientProvider, FileStorageService, SupabaseService],
  exports: [MentionsService],
})
export class MentionsModule {}
