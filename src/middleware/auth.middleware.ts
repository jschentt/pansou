import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { AuthService } from '../services/auth.service';

@Injectable()
export class AuthMiddleware implements NestMiddleware {
  constructor(private readonly authService: AuthService) {}

  async use(req: Request, res: Response, next: NextFunction) {
    // 公开路径不需要认证
    const publicPaths = ['/api/auth/login', '/api/auth/verify', '/api/health'];
    if (publicPaths.includes(req.path)) {
      return next();
    }

    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ error: 'Authorization header is required' });
    }

    const token = authHeader.replace('Bearer ', '');
    if (!token) {
      return res.status(401).json({ error: 'Token is required' });
    }

    // 验证token
    const result = await this.authService.verify(token);
    if (!result.valid) {
      return res.status(401).json({ error: 'Invalid token' });
    }

    // 将用户信息添加到请求对象
    req['user'] = result.username;
    next();
  }
}
