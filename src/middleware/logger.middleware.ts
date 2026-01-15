import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';

@Injectable()
export class LoggerMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction) {
    const startTime = Date.now();
    const { method, originalUrl, ip } = req;
    const userAgent = req.get('user-agent') || '';

    // 监听响应结束事件
    res.on('finish', () => {
      const endTime = Date.now();
      const duration = endTime - startTime;
      const { statusCode } = res;
      
      // 记录请求信息
      console.log(
        `${new Date().toISOString()} - ${method} ${originalUrl} - ${statusCode} - ${duration}ms - ${ip} - ${userAgent}`
      );
    });

    next();
  }
}
