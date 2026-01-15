import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import helmet from 'helmet';
// 暂时移除compression中间件，先让项目运行起来
import { rateLimit } from 'express-rate-limit';
import { Init } from './config/config';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';

async function bootstrap() {
  // 初始化配置
  Init();

  const app = await NestFactory.create(AppModule);

  // 启用CORS
  app.enableCors();

  // 添加安全中间件
  app.use(helmet());

  // 暂时移除压缩中间件，先让项目运行起来
  // app.use(compression());

  // 添加速率限制中间件
  app.use(
    rateLimit({
      windowMs: 15 * 60 * 1000, // 15分钟
      max: 100, // 每个IP最多100个请求
    }),
  );

  // 设置全局前缀
  app.setGlobalPrefix('api');

  // 配置Swagger文档
  const config = new DocumentBuilder()
    .setTitle('Pansou API')
    .setDescription('Pansou 搜索服务 API 文档')
    .setVersion('1.0')
    .addTag('search')
    .addTag('auth')
    .addTag('health')
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api-docs', app, document);

  // 使用配置中的端口
  const port = 3000;
  await app.listen(port);
  console.log(`Application is running on: http://localhost:${port}`);
  console.log(`Swagger documentation is available at: http://localhost:${port}/api-docs`);
}
bootstrap();
