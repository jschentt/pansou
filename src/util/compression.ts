import * as zlib from 'zlib';
import { Request, Response, NextFunction } from 'express';

// 导入配置
import { AppConfig } from '../config/config';

// GzipMiddleware 返回一个Express中间件，用于压缩HTTP响应
export function GzipMiddleware() {
  return (req: Request, res: Response, next: NextFunction) => {
    // 如果未启用压缩，直接跳过
    if (!AppConfig.enableCompression) {
      next();
      return;
    }
    
    // 检查客户端是否支持gzip
    if (!req.headers['accept-encoding']?.includes('gzip')) {
      next();
      return;
    }
    
    // 保存原始的write和end方法
    const originalWrite = res.write;
    const originalEnd = res.end;
    const chunks: Buffer[] = [];
    
    // 重写write方法
    res.write = function(chunk: Buffer | string, encoding?: BufferEncoding) {
      if (typeof chunk === 'string') {
        chunks.push(Buffer.from(chunk, encoding));
      } else {
        chunks.push(chunk);
      }
      return true;
    };
    
    // 重写end方法
    res.end = function(chunk?: Buffer | string, encoding?: BufferEncoding) {
      if (chunk) {
        if (typeof chunk === 'string') {
          chunks.push(Buffer.from(chunk, encoding));
        } else {
          chunks.push(chunk);
        }
      }
      
      const responseData = Buffer.concat(chunks);
      
      // 如果响应大小小于最小压缩大小，直接返回原始内容
      if (responseData.length < AppConfig.minSizeToCompress) {
        res.setHeader('Content-Length', responseData.length.toString());
        originalWrite.call(res, responseData);
        originalEnd.call(res);
        return true;
      }
      
      // 设置gzip响应头
      res.setHeader('Content-Encoding', 'gzip');
      res.setHeader('Vary', 'Accept-Encoding');
      res.removeHeader('Content-Length');
      
      // 创建gzip写入器
      const gzip = zlib.createGzip({ level: zlib.constants.Z_BEST_SPEED });
      
      // 写入压缩内容
      gzip.on('data', (data) => {
        originalWrite.call(res, data);
      });
      
      gzip.on('end', () => {
        originalEnd.call(res);
      });
      
      gzip.on('error', () => {
        res.setHeader('Content-Length', responseData.length.toString());
        res.removeHeader('Content-Encoding');
        res.removeHeader('Vary');
        originalWrite.call(res, responseData);
        originalEnd.call(res);
      });
      
      gzip.write(responseData);
      gzip.end();
      
      return true;
    };
    
    next();
  };
}

// CompressData 压缩数据
export function CompressData(data: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    zlib.gzip(data, { level: zlib.constants.Z_BEST_SPEED }, (err, compressed) => {
      if (err) {
        reject(err);
      } else {
        resolve(compressed);
      }
    });
  });
}

// DecompressData 解压数据
export function DecompressData(data: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    zlib.gunzip(data, (err, decompressed) => {
      if (err) {
        reject(err);
      } else {
        resolve(decompressed);
      }
    });
  });
}
