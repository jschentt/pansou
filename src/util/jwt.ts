import * as jwt from 'jsonwebtoken';

// Claims JWT载荷结构
export interface Claims {
  username: string;
  iat?: number;
  exp?: number;
  iss?: string;
}

// 生成JWT token
export function generateToken(username: string, secret: string, expiry: number): string {
  if (!username) {
    throw new Error('username cannot be empty');
  }
  if (!secret) {
    throw new Error('secret cannot be empty');
  }

  const expirationTime = Math.floor(Date.now() / 1000) + expiry;
  const claims: Claims = {
    username,
    iat: Math.floor(Date.now() / 1000),
    exp: expirationTime,
    iss: 'pansou',
  };

  return jwt.sign(claims, secret, { algorithm: 'HS256' });
}

// 验证JWT token
export function validateToken(tokenString: string, secret: string): Claims {
  if (!tokenString) {
    throw new Error('token cannot be empty');
  }
  if (!secret) {
    throw new Error('secret cannot be empty');
  }

  try {
    const claims = jwt.verify(tokenString, secret, { algorithms: ['HS256'] }) as Claims;
    return claims;
  } catch (error) {
    throw new Error('invalid token');
  }
}