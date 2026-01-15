import * as jwt from 'jsonwebtoken';

// Claims JWT载荷结构
export interface Claims {
  username: string;
  exp?: number;
  iat?: number;
  iss?: string;
}

// GenerateToken 生成JWT token
export function GenerateToken(username: string, secret: string, expiry: number): string {
  if (!username) {
    throw new Error('username cannot be empty');
  }
  if (!secret) {
    throw new Error('secret cannot be empty');
  }

  const claims: Claims = {
    username,
    iss: 'pansou',
  };

  return jwt.sign(claims, secret, { expiresIn: expiry / 1000 }); // 转换为秒
}

// ValidateToken 验证JWT token
export function ValidateToken(tokenString: string, secret: string): Claims {
  if (!tokenString) {
    throw new Error('token cannot be empty');
  }
  if (!secret) {
    throw new Error('secret cannot be empty');
  }

  try {
    const claims = jwt.verify(tokenString, secret) as Claims;
    return claims;
  } catch (error) {
    throw new Error('invalid token');
  }
}
