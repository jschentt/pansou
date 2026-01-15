import { Injectable } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';

interface CacheItem {
  data: any;
  timestamp: number;
  ttl: number;
}

@Injectable()
export class CacheService {
  private memoryCache: Map<string, CacheItem> = new Map();
  private cacheDir: string = path.join(__dirname, '../../cache');
  private cacheEnabled: boolean = true;
  private cacheTTL: number = 60 * 60 * 1000; // 默认1小时

  constructor() {
    // 确保缓存目录存在
    if (!fs.existsSync(this.cacheDir)) {
      fs.mkdirSync(this.cacheDir, { recursive: true });
    }
  }

  async get(key: string): Promise<any | null> {
    if (!this.cacheEnabled) {
      return null;
    }

    // 先从内存缓存获取
    const memoryItem = this.memoryCache.get(key);
    if (memoryItem) {
      if (Date.now() - memoryItem.timestamp < memoryItem.ttl) {
        return memoryItem.data;
      }
      // 内存缓存过期，移除
      this.memoryCache.delete(key);
    }

    // 再从磁盘缓存获取
    const diskPath = this.getDiskPath(key);
    if (fs.existsSync(diskPath)) {
      try {
        const content = fs.readFileSync(diskPath, 'utf8');
        const diskItem: CacheItem = JSON.parse(content);
        if (Date.now() - diskItem.timestamp < diskItem.ttl) {
          // 加载到内存缓存
          this.memoryCache.set(key, diskItem);
          return diskItem.data;
        }
        // 磁盘缓存过期，删除
        fs.unlinkSync(diskPath);
      } catch (error) {
        console.error(`Error reading cache file: ${error}`);
      }
    }

    return null;
  }

  async set(key: string, data: any, ttl?: number): Promise<void> {
    if (!this.cacheEnabled) {
      return;
    }

    const cacheItem: CacheItem = {
      data,
      timestamp: Date.now(),
      ttl: ttl || this.cacheTTL,
    };

    // 保存到内存缓存
    this.memoryCache.set(key, cacheItem);

    // 异步保存到磁盘缓存
    try {
      const diskPath = this.getDiskPath(key);
      fs.writeFileSync(diskPath, JSON.stringify(cacheItem), 'utf8');
    } catch (error) {
      console.error(`Error writing cache file: ${error}`);
    }
  }

  async delete(key: string): Promise<void> {
    // 从内存缓存删除
    this.memoryCache.delete(key);

    // 从磁盘缓存删除
    const diskPath = this.getDiskPath(key);
    if (fs.existsSync(diskPath)) {
      try {
        fs.unlinkSync(diskPath);
      } catch (error) {
        console.error(`Error deleting cache file: ${error}`);
      }
    }
  }

  async clear(): Promise<void> {
    // 清空内存缓存
    this.memoryCache.clear();

    // 清空磁盘缓存
    if (fs.existsSync(this.cacheDir)) {
      try {
        const files = fs.readdirSync(this.cacheDir);
        for (const file of files) {
          fs.unlinkSync(path.join(this.cacheDir, file));
        }
      } catch (error) {
        console.error(`Error clearing disk cache: ${error}`);
      }
    }
  }

  private getDiskPath(key: string): string {
    // 创建一个安全的文件名
    const safeKey = key.replace(/[^a-zA-Z0-9]/g, '_');
    return path.join(this.cacheDir, `${safeKey}.json`);
  }

  setCacheEnabled(enabled: boolean): void {
    this.cacheEnabled = enabled;
  }

  setCacheTTL(ttl: number): void {
    this.cacheTTL = ttl;
  }
}
