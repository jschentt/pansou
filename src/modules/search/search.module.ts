import { Module } from '@nestjs/common';
import { SearchController } from './search.controller';
import { SearchService } from '../../services/search.service';
import { CacheService } from '../../services/cache.service';

@Module({
  controllers: [SearchController],
  providers: [SearchService, CacheService],
})
export class SearchModule {}
