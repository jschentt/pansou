import { Mutex } from 'async-mutex';

// 简单的内存缓存项
interface MemoryCacheItem {
  data: Buffer;
  expiry: Date;
  lastUsed: Date;
  lastModified: Date;
  size: number;
}

// 内存缓存
export class MemoryCache {
  private items: Map<string, MemoryCacheItem>;
  private mutex: Mutex;
  private maxItems: number;
  private maxSize: number;
  private currSize: number;
  private cleanupTicker: NodeJS.Timeout | null = null;

  // 创建新的内存缓存
  constructor(maxItems: number, maxSizeMB: number) {
    this.items = new Map<string, MemoryCacheItem>();
    this.mutex = new Mutex();
    this.maxItems = maxItems;
    this.maxSize = maxSizeMB * 1024 * 1024;
    this.currSize = 0;
  }

  // 设置缓存
  async set(key: string, data: Buffer | string, ttl: number): Promise<void> {
    await this.mutex.runExclusive(() => {
      this.setSync(key, data, ttl, new Date());
    });
  }

  // SetWithTimestamp 设置缓存，并指定最后修改时间
  async setWithTimestamp(key: string, data: Buffer | string, ttl: number, lastModified: Date): Promise<void> {
    await this.mutex.runExclusive(() => {
      this.setSync(key, data, ttl, lastModified);
    });
  }

  // 内部同步设置方法
  private setSync(key: string, data: Buffer | string, ttl: number, lastModified: Date): void {
    const bufferData = Buffer.isBuffer(data) ? data : Buffer.from(data);
    
    // 如果已存在，先减去旧项的大小
    if (this.items.has(key)) {
      const item = this.items.get(key)!;
      this.currSize -= item.size;
    }

    // 创建新的缓存项
    const now = new Date();
    const item: MemoryCacheItem = {
      data: bufferData,
      expiry: new Date(now.getTime() + ttl),
      lastUsed: now,
      lastModified,
      size: bufferData.length,
    };

    // 检查是否需要清理空间
    if (this.items.size >= this.maxItems || this.currSize + bufferData.length > this.maxSize) {
      this.evict();
    }

    // 存储新项
    this.items.set(key, item);
    this.currSize += bufferData.length;
  }

  // 获取缓存
  async get(key: string): Promise<Buffer | null> {
    let item: MemoryCacheItem | undefined;
    let exists = false;
    
    await this.mutex.runExclusive(() => {
      item = this.items.get(key);
      exists = !!item;
      
      // 检查是否过期
      if (exists && new Date() > item!.expiry) {
        // 过期，删除该项
        this.currSize -= item!.size;
        this.items.delete(key);
        exists = false;
        item = undefined;
      }
      
      // 更新最后使用时间
      if (exists) {
        item!.lastUsed = new Date();
      }
    });

    return exists ? item!.data : null;
  }

  // GetWithTimestamp 获取缓存及其最后修改时间
  async getWithTimestamp(key: string): Promise<[Buffer | null, Date | null]> {
    let item: MemoryCacheItem | undefined;
    let exists = false;
    
    await this.mutex.runExclusive(() => {
      item = this.items.get(key);
      exists = !!item;
      
      // 检查是否过期
      if (exists && new Date() > item!.expiry) {
        // 过期，删除该项
        this.currSize -= item!.size;
        this.items.delete(key);
        exists = false;
        item = undefined;
      }
      
      // 更新最后使用时间
      if (exists) {
        item!.lastUsed = new Date();
      }
    });

    return exists ? [item!.data, item!.lastModified] : [null, null];
  }

  // GetLastModified 获取缓存项的最后修改时间
  async getLastModified(key: string): Promise<Date | null> {
    let result: Date | null = null;
    
    await this.mutex.runExclusive(() => {
      const item = this.items.get(key);
      if (item && new Date() <= item.expiry) {
        result = item.lastModified;
      }
    });
    
    return result;
  }

  // 驱逐策略 - LRU
  private evict(): void {
    if (this.items.size === 0) {
      return;
    }

    // 找出最久未使用的项
    let oldestKey = '';
    let oldestTime = new Date(); // 初始化为当前时间

    for (const [k, v] of this.items) {
      if (v.lastUsed < oldestTime) {
        oldestKey = k;
        oldestTime = v.lastUsed;
      }
    }

    // 如果找到了最久未使用的项，删除它
    if (oldestKey !== '') {
      const item = this.items.get(oldestKey)!;
      this.currSize -= item.size;
      this.items.delete(oldestKey);
    }
  }

  // 清理过期项
  async cleanExpired(): Promise<void> {
    await this.mutex.runExclusive(() => {
      const now = new Date();
      for (const [k, v] of this.items) {
        if (now > v.expiry) {
          this.currSize -= v.size;
          this.items.delete(k);
        }
      }
    });
  }

  // 启动定期清理
  startCleanupTask(): void {
    // 每5分钟清理一次过期项
    this.cleanupTicker = setInterval(() => {
      this.cleanExpired().catch(() => {});
    }, 5 * 60 * 1000);
  }

  // 关闭清理任务
  stopCleanupTask(): void {
    if (this.cleanupTicker) {
      clearInterval(this.cleanupTicker);
      this.cleanupTicker = null;
    }
  }

  // 获取当前缓存项数量
  async getSize(): Promise<number> {
    return await this.mutex.runExclusive(() => this.items.size);
  }

  // 获取当前缓存总大小
  async getTotalSize(): Promise<number> {
    return await this.mutex.runExclusive(() => this.currSize);
  }

  // 清空缓存
  async clear(): Promise<void> {
    await this.mutex.runExclusive(() => {
      this.items.clear();
      this.currSize = 0;
    });
  }
}