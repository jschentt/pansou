// 导入必要的模块和类型
import { ShardedMemoryCache } from './sharded_memory_cache';
import { ShardedDiskCache } from './sharded_disk_cache';
import { GobSerializer } from './serializer';
import { AppConfig } from '../../config/config';

// EnhancedTwoLevelCache 改进的两级缓存
export class EnhancedTwoLevelCache {
  private memory: ShardedMemoryCache;
  private disk: ShardedDiskCache;
  private serializer: GobSerializer;
  private mutex: { lock: () => void; unlock: () => void; rLock: () => void; rUnlock: () => void };

  // NewEnhancedTwoLevelCache 创建新的改进两级缓存
  static NewEnhancedTwoLevelCache(): EnhancedTwoLevelCache {
    // 内存缓存大小为磁盘缓存的60%
    const memCacheMaxItems = 5000;
    const memCacheSizeMB = (AppConfig.CacheMaxSizeMB || 1024) * 3 / 5;
    
    const memCache = ShardedMemoryCache.NewShardedMemoryCache(memCacheMaxItems, memCacheSizeMB);
    memCache.StartCleanupTask();

    // 创建优化的分片磁盘缓存，使用动态分片数量
    const diskCache = ShardedDiskCache.NewOptimizedShardedDiskCache(
      AppConfig.CachePath || './cache',
      AppConfig.CacheMaxSizeMB || 1024
    );

    // 创建序列化器
    const serializer = GobSerializer.NewGobSerializer();

    // 设置内存缓存的磁盘缓存引用，用于LRU淘汰时的备份
    memCache.SetDiskCacheReference(diskCache);

    return new EnhancedTwoLevelCache(memCache, diskCache, serializer);
  }

  // 构造函数
  constructor(memory: ShardedMemoryCache, disk: ShardedDiskCache, serializer: GobSerializer) {
    this.memory = memory;
    this.disk = disk;
    this.serializer = serializer;
    
    // 简单的互斥锁实现
    this.mutex = {
      lock: () => {},
      unlock: () => {},
      rLock: () => {},
      rUnlock: () => {}
    };
  }

  // Set 设置缓存
  async Set(key: string, data: Buffer, ttl: number): Promise<Error | null> {
    // 获取当前时间作为最后修改时间
    const now = new Date();
    
    // 先设置内存缓存（这是快速操作，直接在当前goroutine中执行）
    this.memory.SetWithTimestamp(key, data, ttl, now);
    
    // 异步设置磁盘缓存（这是IO操作，可能较慢）
    setImmediate(() => {
      // 使用独立的goroutine写入磁盘，避免阻塞调用者
      this.disk.Set(key, data, ttl);
    });
    
    return null;
  }

  // SetMemoryOnly 仅更新内存缓存
  SetMemoryOnly(key: string, data: Buffer, ttl: number): Error | null {
    const now = new Date();
    
    // 只更新内存缓存，不触发磁盘写入
    this.memory.SetWithTimestamp(key, data, ttl, now);
    
    return null;
  }

  // SetBothLevels 更新内存和磁盘缓存
  async SetBothLevels(key: string, data: Buffer, ttl: number): Promise<Error | null> {
    const now = new Date();
    
    // 同步更新内存缓存
    this.memory.SetWithTimestamp(key, data, ttl, now);
    
    // 同步更新磁盘缓存，确保数据立即写入
    return this.disk.Set(key, data, ttl);
  }

  // SetWithFinalFlag 根据结果状态选择更新策略
  async SetWithFinalFlag(key: string, data: Buffer, ttl: number, isFinal: boolean): Promise<Error | null> {
    if (isFinal) {
      return this.SetBothLevels(key, data, ttl);
    } else {
      return this.SetMemoryOnly(key, data, ttl);
    }
  }

  // Get 获取缓存
  async Get(key: string): Promise<[Buffer | null, boolean, Error | null]> {
    // 检查内存缓存
    const [memData, memTimestamp, memHit] = this.memory.GetWithTimestamp(key);
    if (memHit && memData) {
      return [memData, true, null];
    }

    // 尝试从磁盘读取数据
    const [diskData, diskHit, diskErr] = await this.disk.Get(key);
    if (!diskErr && diskHit && diskData) {
      // 磁盘缓存命中，更新内存缓存
      const diskLastModified = await this.disk.GetLastModified(key);
      const ttl = (AppConfig.cacheTTLMinutes || 30) * 60 * 1000; // 转换为毫秒
      this.memory.SetWithTimestamp(key, diskData, ttl, diskLastModified || new Date());
      return [diskData, true, null];
    }
    
    return [null, false, null];
  }

  // Delete 删除缓存
  async Delete(key: string): Promise<Error | null> {
    // 从内存缓存删除
    this.memory.Delete(key);
    
    // 从磁盘缓存删除
    return this.disk.Delete(key);
  }

  // Clear 清空所有缓存
  async Clear(): Promise<Error | null> {
    // 清空内存缓存
    this.memory.Clear();
    
    // 清空磁盘缓存
    return this.disk.Clear();
  }

  // SetSerializer 设置序列化器
  SetSerializer(serializer: GobSerializer): void {
    this.mutex.lock();
    try {
      this.serializer = serializer;
    } finally {
      this.mutex.unlock();
    }
  }

  // GetSerializer 获取序列化器
  GetSerializer(): GobSerializer {
    this.mutex.rLock();
    try {
      return this.serializer;
    } finally {
      this.mutex.rUnlock();
    }
  }

  // FlushMemoryToDisk 将内存缓存中的所有数据刷新到磁盘
  async FlushMemoryToDisk(): Promise<Error | null> {
    // 获取内存缓存中的所有键值对
    const allItems = this.memory.GetAllItems();
    
    let lastErr: Error | null = null;
    
    for (const [key, item] of Object.entries(allItems)) {
      // 同步写入到磁盘缓存
      try {
        if (await this.disk.Set(key, item.Data, item.TTL)) {
          lastErr = new Error(`同步失败: ${key}`);
          console.warn(`[内存同步] 同步失败: ${key}`);
        }
      } catch (err) {
        lastErr = err as Error;
        console.warn(`[内存同步] 同步失败: ${key} -> ${(err as Error).message}`);
      }
    }
    
    return lastErr;
  }
}


