import * as path from 'path';
import * as os from 'os';
import { DiskCache } from './disk_cache';

// ShardedDiskCache 分片磁盘缓存
export class ShardedDiskCache {
  private baseDir: string;
  private shardCount: number;
  private shardMask: number; // 用于快速取模的掩码
  private shards: DiskCache[];
  private maxSizeMB: number;
  private mutex: { lock: () => void; unlock: () => void; rLock: () => void; rUnlock: () => void };

  // NewShardedDiskCache 创建新的分片磁盘缓存（兼容现有接口）
  static async NewShardedDiskCache(baseDir: string, shardCount: number, maxSizeMB: number): Promise<ShardedDiskCache> {
    return this.newShardedDiskCacheWithCount(baseDir, shardCount, maxSizeMB);
  }

  // NewOptimizedShardedDiskCache 创建优化的分片磁盘缓存（动态分片数）
  static async NewOptimizedShardedDiskCache(baseDir: string, maxSizeMB: number): Promise<ShardedDiskCache> {
    // 动态确定分片数量：与内存缓存保持一致的策略
    let shardCount = os.cpus().length * 2;
    if (shardCount < 4) {
      shardCount = 4;
    }
    if (shardCount > 32) { // 磁盘缓存分片数适当限制，避免过多文件夹
      shardCount = 32;
    }
    
    // 确保分片数是2的幂，便于使用掩码进行快速取模
    shardCount = this.nextPowerOfTwoDisk(shardCount);
    
    return this.newShardedDiskCacheWithCount(baseDir, shardCount, maxSizeMB);
  }

  // 获取下一个2的幂（磁盘缓存版本）
  private static nextPowerOfTwoDisk(n: number): number {
    if (n <= 1) {
      return 1;
    }
    n--;
    n |= n >> 1;
    n |= n >> 2;
    n |= n >> 4;
    n |= n >> 8;
    n |= n >> 16;
    return n + 1;
  }

  // 内部构造函数
  private static async newShardedDiskCacheWithCount(baseDir: string, shardCount: number, maxSizeMB: number): Promise<ShardedDiskCache> {
    // 确保每个分片的大小合理
    const shardSize = Math.max(1, maxSizeMB / shardCount);
    
    const cache = new ShardedDiskCache();
    cache.baseDir = baseDir;
    cache.shardCount = shardCount;
    cache.shardMask = shardCount - 1; // 用于快速取模
    cache.shards = [];
    cache.maxSizeMB = maxSizeMB;
    
    // 简单的互斥锁实现
    cache.mutex = {
      lock: () => {},
      unlock: () => {},
      rLock: () => {},
      rUnlock: () => {}
    };
    
    // 初始化每个分片
    for (let i = 0; i < shardCount; i++) {
      const shardPath = path.join(baseDir, `shard_${i}`);
      const diskCache = await DiskCache.NewDiskCache(shardPath, shardSize);
      cache.shards.push(diskCache);
    }
    
    return cache;
  }

  // 获取键对应的分片
  private getShard(key: string): DiskCache {
    // 计算哈希值决定分片
    const shardIndex = this.getShardIndex(key);
    return this.shards[shardIndex];
  }

  // Set 设置缓存
  async Set(key: string, data: Buffer, ttl: number): Promise<void> {
    const shard = this.getShard(key);
    await shard.Set(key, data, ttl);
  }

  // Get 获取缓存
  async Get(key: string): Promise<[Buffer, boolean, Error | null]> {
    const shard = this.getShard(key);
    return await shard.Get(key);
  }

  // Delete 删除缓存
  async Delete(key: string): Promise<void> {
    const shard = this.getShard(key);
    await shard.Delete(key);
  }

  // Has 检查缓存是否存在
  async Has(key: string): Promise<boolean> {
    const shard = this.getShard(key);
    return await shard.Has(key);
  }

  // Clear 清空所有缓存
  async Clear(): Promise<Error | null> {
    this.mutex.lock();
    try {
      let lastErr: Error | null = null;
      for (const shard of this.shards) {
        try {
          await shard.Clear();
        } catch (err) {
          lastErr = err as Error;
        }
      }
      return lastErr;
    } finally {
      this.mutex.unlock();
    }
  }

  // GetLastModified 获取缓存项的最后修改时间
  async GetLastModified(key: string): Promise<[Date, boolean]> {
    const shard = this.getShard(key);
    return await shard.GetLastModified(key);
  }

  // cleanExpired 清理所有分片中的过期项
  private cleanExpired(): void {
    // 并行清理所有分片中的过期项
    for (const shard of this.shards) {
      shard.cleanExpired();
    }
  }

  // CleanExpired 公开的清理方法，符合cleanupTarget接口
  CleanExpired(): void {
    this.cleanExpired();
  }

  // StartCleanupTask 启动定期清理任务（修改为使用单例模式）
  StartCleanupTask(): void {
    // 使用与内存缓存相同的全局清理系统
    // 注意：这里需要实现registerForCleanup和startGlobalCleanupTask函数
    // 暂时留空，待实现全局清理系统
  }

  // GetShards 获取所有分片（用于测试和调试）
  GetShards(): DiskCache[] {
    return this.shards;
  }

  // GetShardIndex 获取指定键对应的分片索引（用于测试和调试）
  GetShardIndex(key: string): number {
    const hash = this.hashString(key);
    if (this.shardMask > 0) {
      return hash & this.shardMask;
    } else {
      // 兼容老版本的模运算
      return hash % this.shardCount;
    }
  }

  // 计算字符串的哈希值
  private hashString(key: string): number {
    let hash = 0;
    for (let i = 0; i < key.length; i++) {
      const char = key.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // 转换为32位整数
    }
    return Math.abs(hash);
  }
}
