// 清理目标接口
interface CleanupTarget {
  CleanExpired(): void;
}

// 内存缓存项结构（用于导出）
export interface MemoryCacheItem {
  Data: Buffer;
  TTL: number;
}

// 分片内存缓存项
class ShardedMemoryCacheItem {
  data: Buffer;
  expiry: Date;
  lastUsed: number; // 使用原子操作的时间戳
  lastModified: Date;
  size: number;

  constructor(data: Buffer, expiry: Date, lastModified: Date) {
    this.data = data;
    this.expiry = expiry;
    this.lastUsed = Date.now();
    this.lastModified = lastModified;
    this.size = data.length;
  }
}

// 单个分片
class MemoryCacheShard {
  items: Record<string, ShardedMemoryCacheItem>;
  mutex: { lock: () => void; unlock: () => void; rLock: () => void; rUnlock: () => void };
  currSize: number;

  constructor() {
    this.items = {};
    this.currSize = 0;
    // 简单的互斥锁实现
    this.mutex = {
      lock: () => {},
      unlock: () => {},
      rLock: () => {},
      rUnlock: () => {}
    };
  }
}

// 全局清理任务相关变量（单例模式）
class GlobalCleanupTask {
  private static instance: GlobalCleanupTask;
  private cleanupInterval: NodeJS.Timeout | null;
  private registeredCaches: CleanupTarget[];
  private cacheRegistryMutex: { lock: () => void; unlock: () => void; rLock: () => void; rUnlock: () => void };

  private constructor() {
    this.registeredCaches = [];
    this.cleanupInterval = null;
    this.cacheRegistryMutex = {
      lock: () => {},
      unlock: () => {},
      rLock: () => {},
      rUnlock: () => {}
    };
  }

  static getInstance(): GlobalCleanupTask {
    if (!GlobalCleanupTask.instance) {
      GlobalCleanupTask.instance = new GlobalCleanupTask();
    }
    return GlobalCleanupTask.instance;
  }

  start(): void {
    if (!this.cleanupInterval) {
      this.cleanupInterval = setInterval(() => {
        this.cacheRegistryMutex.rLock();
        const caches = [...this.registeredCaches];
        this.cacheRegistryMutex.rUnlock();
        
        // 并行清理所有注册的缓存
        for (const cache of caches) {
          setTimeout(() => cache.CleanExpired(), 0);
        }
      }, 5 * 60 * 1000); // 每5分钟清理一次
    }
  }

  registerCache(cache: CleanupTarget): void {
    this.cacheRegistryMutex.lock();
    this.registeredCaches.push(cache);
    this.cacheRegistryMutex.unlock();
  }
}

// 分片内存缓存
export class ShardedMemoryCache implements CleanupTarget {
  private shards: MemoryCacheShard[];
  private shardMask: number; // 用于快速取模的掩码
  private maxItems: number;
  private maxSize: number;
  private itemsPerShard: number;
  private sizePerShard: number;
  private diskCache: any; // 磁盘缓存引用
  private diskCacheMutex: { lock: () => void; unlock: () => void; rLock: () => void; rUnlock: () => void };

  // 创建新的分片内存缓存
  static NewShardedMemoryCache(maxItems: number, maxSizeMB: number): ShardedMemoryCache {
    // 动态确定分片数量：基于CPU核心数，但至少4个，最多64个
    let shardCount = require('os').cpus().length * 2;
    if (shardCount < 4) {
      shardCount = 4;
    }
    if (shardCount > 64) {
      shardCount = 64;
    }
    
    // 确保分片数是2的幂，便于使用掩码进行快速取模
    shardCount = ShardedMemoryCache.nextPowerOfTwo(shardCount);
    
    const totalSize = maxSizeMB * 1024 * 1024;
    const itemsPerShard = maxItems / shardCount;
    const sizePerShard = totalSize / shardCount;
    
    const shards: MemoryCacheShard[] = [];
    for (let i = 0; i < shardCount; i++) {
      shards.push(new MemoryCacheShard());
    }
    
    const cache = new ShardedMemoryCache();
    cache.shards = shards;
    cache.shardMask = shardCount - 1; // 用于快速取模
    cache.maxItems = maxItems;
    cache.maxSize = totalSize;
    cache.itemsPerShard = itemsPerShard;
    cache.sizePerShard = sizePerShard;
    cache.diskCache = null;
    cache.diskCacheMutex = {
      lock: () => {},
      unlock: () => {},
      rLock: () => {},
      rUnlock: () => {}
    };
    
    return cache;
  }

  // 获取下一个2的幂
  private static nextPowerOfTwo(n: number): number {
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

  // 获取分片
  private getShard(key: string): MemoryCacheShard {
    const hash = this.hashString(key);
    const shardIndex = hash & this.shardMask; // 使用掩码进行快速取模
    return this.shards[shardIndex];
  }

  // 哈希字符串
  private hashString(key: string): number {
    let hash = 0;
    for (let i = 0; i < key.length; i++) {
      const char = key.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // 转换为32位整数
    }
    return Math.abs(hash);
  }

  // 设置缓存
  Set(key: string, data: Buffer, ttl: number): void {
    this.SetWithTimestamp(key, data, ttl, new Date());
  }

  // SetWithTimestamp 设置缓存，并指定最后修改时间
  SetWithTimestamp(key: string, data: Buffer, ttl: number, lastModified: Date): void {
    const shard = this.getShard(key);
    shard.mutex.lock();
    try {
      // 如果已存在，先减去旧项的大小
      if (shard.items[key]) {
        shard.currSize -= shard.items[key].size;
      }
      
      // 创建新的缓存项
      const now = new Date();
      const expiry = new Date(now.getTime() + ttl);
      const item = new ShardedMemoryCacheItem(data, expiry, lastModified);
      
      // 检查是否需要清理空间
      if (Object.keys(shard.items).length >= this.itemsPerShard || shard.currSize + data.length > this.sizePerShard) {
        this.evictFromShard(shard);
      }
      
      // 存储新项
      shard.items[key] = item;
      shard.currSize += data.length;
    } finally {
      shard.mutex.unlock();
    }
  }

  // 获取缓存
  Get(key: string): [Buffer, boolean] {
    const shard = this.getShard(key);
    shard.mutex.rLock();
    const item = shard.items[key];
    shard.mutex.rUnlock();
    
    if (!item) {
      return [Buffer.alloc(0), false];
    }
    
    // 检查是否过期
    if (new Date().getTime() > item.expiry.getTime()) {
      shard.mutex.lock();
      try {
        delete shard.items[key];
        shard.currSize -= item.size;
      } finally {
        shard.mutex.unlock();
      }
      return [Buffer.alloc(0), false];
    }
    
    // 原子操作更新最后使用时间，避免额外的锁
    item.lastUsed = Date.now();
    
    return [item.data, true];
  }

  // GetWithTimestamp 获取缓存及其最后修改时间
  GetWithTimestamp(key: string): [Buffer, Date, boolean] {
    const shard = this.getShard(key);
    shard.mutex.rLock();
    const item = shard.items[key];
    shard.mutex.rUnlock();
    
    if (!item) {
      return [Buffer.alloc(0), new Date(), false];
    }
    
    // 检查是否过期
    if (new Date().getTime() > item.expiry.getTime()) {
      shard.mutex.lock();
      try {
        delete shard.items[key];
        shard.currSize -= item.size;
      } finally {
        shard.mutex.unlock();
      }
      return [Buffer.alloc(0), new Date(), false];
    }
    
    // 原子操作更新最后使用时间
    item.lastUsed = Date.now();
    
    return [item.data, item.lastModified, true];
  }

  // GetLastModified 获取缓存项的最后修改时间
  GetLastModified(key: string): [Date, boolean] {
    const shard = this.getShard(key);
    shard.mutex.rLock();
    try {
      const item = shard.items[key];
      if (!item) {
        return [new Date(), false];
      }
      
      // 检查是否过期
      if (new Date().getTime() > item.expiry.getTime()) {
        return [new Date(), false];
      }
      
      return [item.lastModified, true];
    } finally {
      shard.mutex.rUnlock();
    }
  }

  // 从指定分片中驱逐最久未使用的项（带磁盘备份）
  private evictFromShard(shard: MemoryCacheShard): void {
    let oldestKey: string = '';
    let oldestItem: ShardedMemoryCacheItem | null = null;
    let oldestTime: number = Number.MAX_SAFE_INTEGER;
    
    for (const k in shard.items) {
      const v = shard.items[k];
      const lastUsed = v.lastUsed;
      if (lastUsed < oldestTime) {
        oldestKey = k;
        oldestItem = v;
        oldestTime = lastUsed;
      }
    }
    
    // 如果找到了最久未使用的项，删除它
    if (oldestKey && oldestItem) {
      // 🔥 关键优化：淘汰前检查是否需要刷盘保护
      const diskCache = this.getDiskCacheReference();
      if (new Date().getTime() < oldestItem.expiry.getTime() && diskCache) {
        // 数据还没过期，异步刷新到磁盘保存
        const ttl = oldestItem.expiry.getTime() - Date.now();
        if (ttl > 0) {
          setTimeout(() => {
            diskCache.Set(oldestKey, oldestItem!.data, ttl); // 保持相同TTL
          }, 0);
        }
      }
      
      // 从内存中删除
      shard.currSize -= oldestItem.size;
      delete shard.items[oldestKey];
    }
  }

  // 清理过期项
  CleanExpired(): void {
    const now = new Date();
    
    // 并行清理所有分片
    const promises = this.shards.map((shard) => {
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          shard.mutex.lock();
          try {
            for (const k in shard.items) {
              const v = shard.items[k];
              if (now.getTime() > v.expiry.getTime()) {
                shard.currSize -= v.size;
                delete shard.items[k];
              }
            }
          } finally {
            shard.mutex.unlock();
            resolve();
          }
        }, 0);
      });
    });
    
    Promise.all(promises).catch(() => {});
  }

  // Delete 删除指定键的缓存项
  Delete(key: string): void {
    const shard = this.getShard(key);
    shard.mutex.lock();
    try {
      if (shard.items[key]) {
        shard.currSize -= shard.items[key].size;
        delete shard.items[key];
      }
    } finally {
      shard.mutex.unlock();
    }
  }

  // Clear 清空所有缓存项
  Clear(): void {
    // 并行清理所有分片
    const promises = this.shards.map((shard) => {
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          shard.mutex.lock();
          try {
            shard.items = {};
            shard.currSize = 0;
          } finally {
            shard.mutex.unlock();
            resolve();
          }
        }, 0);
      });
    });
    
    Promise.all(promises).catch(() => {});
  }

  // 启动定期清理（修改为使用单例模式）
  StartCleanupTask(): void {
    const globalCleanupTask = GlobalCleanupTask.getInstance();
    globalCleanupTask.registerCache(this);
    globalCleanupTask.start();
  }

  // SetDiskCacheReference 设置磁盘缓存引用
  SetDiskCacheReference(diskCache: any): void {
    this.diskCacheMutex.lock();
    try {
      this.diskCache = diskCache;
    } finally {
      this.diskCacheMutex.unlock();
    }
  }

  // getDiskCacheReference 获取磁盘缓存引用
  private getDiskCacheReference(): any {
    this.diskCacheMutex.rLock();
    try {
      return this.diskCache;
    } finally {
      this.diskCacheMutex.rUnlock();
    }
  }



  // GetAllItems 获取内存缓存中的所有项
  GetAllItems(): Record<string, MemoryCacheItem> {
    const result: Record<string, MemoryCacheItem> = {};
    const now = new Date();
    
    // 遍历所有分片
    for (const shard of this.shards) {
      shard.mutex.rLock();
      try {
        for (const key in shard.items) {
          const item = shard.items[key];
          // 检查是否过期
          if (item.expiry.getTime() > 0 && now.getTime() > item.expiry.getTime()) {
            continue; // 跳过过期项
          }
          
          // 计算剩余TTL
          let ttl = 0;
          if (item.expiry.getTime() > 0) {
            ttl = item.expiry.getTime() - now.getTime();
            if (ttl <= 0) {
              continue; // 跳过即将过期的项
            }
          }
          
          result[key] = {
            Data: item.data,
            TTL: ttl
          };
        }
      } finally {
        shard.mutex.rUnlock();
      }
    }
    
    return result;
  }
}


