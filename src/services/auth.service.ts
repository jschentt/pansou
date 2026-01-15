import { Injectable, UnauthorizedException, ForbiddenException, InternalServerErrorException } from '@nestjs/common';
import * as jwt from 'jsonwebtoken';
import { AppConfig } from '../config/config';

// 登录请求结构
export interface LoginRequest {
  username: string;
  password: string;
}

// 登录响应结构
export interface LoginResponse {
  token: string;
  expiresAt: number;
  username: string;
}

@Injectable()
export class AuthService {
  async login(credentials: LoginRequest): Promise<LoginResponse> {
    // 验证认证系统是否启用
    if (!AppConfig?.authEnabled) {
      throw new ForbiddenException('认证功能未启用');
    }

    // 验证用户配置是否存在
    if (!AppConfig.authUsers || Object.keys(AppConfig.authUsers).length === 0) {
      throw new InternalServerErrorException('认证系统未正确配置');
    }

    // 验证用户名和密码
    const storedPassword = AppConfig.authUsers[credentials.username];
    if (!storedPassword || storedPassword !== credentials.password) {
      throw new UnauthorizedException('用户名或密码错误');
    }

    // 生成JWT token
    const token = jwt.sign(
      { username: credentials.username },
      AppConfig.authJWTSecret,
      { expiresIn: AppConfig.authTokenExpiry / 1000 } // 转换为秒
    );

    // 返回token和过期时间
    const expiresAt = Date.now() + (AppConfig.authTokenExpiry);
    return {
      token,
      expiresAt,
      username: credentials.username,
    };
  }

  async verify(token: string): Promise<{ valid: boolean; username?: string }> {
    // 如果未启用认证，直接返回有效
    if (!AppConfig?.authEnabled) {
      return {
        valid: true,
        username: undefined,
      };
    }

    try {
      // 验证token
      const decoded = jwt.verify(token, AppConfig.authJWTSecret) as { username: string };
      return {
        valid: true,
        username: decoded.username,
      };
    } catch (error) {
      throw new UnauthorizedException('无效的令牌');
    }
  }

  async logout(token: string): Promise<{ message: string }> {
    // JWT是无状态的，服务端不需要处理注销
    // 客户端删除存储的token即可
    return { message: '退出成功' };
  }
}
