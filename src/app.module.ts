import { Module, NestModule, MiddlewareConsumer } from '@nestjs/common';
import { SearchModule } from './modules/search/search.module';
import { AuthModule } from './modules/auth/auth.module';
import { HealthController } from './controllers/health.controller';
import { AuthMiddleware } from './middleware/auth.middleware';
import { LoggerMiddleware } from './middleware/logger.middleware';
import { AuthService } from './services/auth.service';
import { CacheService } from './services/cache.service';

@Module({
  imports: [SearchModule, AuthModule],
  controllers: [HealthController],
  providers: [AuthService, CacheService, LoggerMiddleware],
  exports: [CacheService],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(LoggerMiddleware, AuthMiddleware)
      .forRoutes('*');
  }
}
