// 简单的内存缓存项
class MemoryCacheItem {
  data: Buffer;
  expiry: Date;
  lastUsed: Date;
  lastModified: Date; // 添加最后修改时间
  size: number;

  constructor(data: Buffer, expiry: Date, lastModified: Date) {
    this.data = data;
    this.expiry = expiry;
    this.lastUsed = new Date();
    this.lastModified = lastModified;
    this.size = data.length;
  }
}

// 内存缓存
export class MemoryCache {
  private items: Record<string, MemoryCacheItem>;
  private mutex: { lock: () => void; unlock: () => void; rLock: () => void; rUnlock: () => void };
  private maxItems: number;
  private maxSize: number;
  private currSize: number;

  // 创建新的内存缓存
  static NewMemoryCache(maxItems: number, maxSizeMB: number): MemoryCache {
    return new MemoryCache(maxItems, maxSizeMB);
  }

  constructor(maxItems: number, maxSizeMB: number) {
    this.items = {};
    this.maxItems = maxItems;
    this.maxSize = maxSizeMB * 1024 * 1024;
    this.currSize = 0;
    // 简单的互斥锁实现
    this.mutex = {
      lock: () => {},
      unlock: () => {},
      rLock: () => {},
      rUnlock: () => {}
    };
  }

  // 设置缓存
  Set(key: string, data: Buffer, ttl: number): void {
    this.SetWithTimestamp(key, data, ttl, new Date());
  }

  // SetWithTimestamp 设置缓存，并指定最后修改时间
  SetWithTimestamp(key: string, data: Buffer, ttl: number, lastModified: Date): void {
    this.mutex.lock();
    try {
      // 如果已存在，先减去旧项的大小
      if (this.items[key]) {
        this.currSize -= this.items[key].size;
      }

      // 创建新的缓存项
      const now = new Date();
      const expiry = new Date(now.getTime() + ttl);
      const item = new MemoryCacheItem(data, expiry, lastModified);

      // 检查是否需要清理空间
      if (Object.keys(this.items).length >= this.maxItems || this.currSize + data.length > this.maxSize) {
        this.evict();
      }

      // 存储新项
      this.items[key] = item;
      this.currSize += data.length;
    } finally {
      this.mutex.unlock();
    }
  }

  // 获取缓存
  Get(key: string): [Buffer, boolean] {
    this.mutex.rLock();
    const item = this.items[key];
    this.mutex.rUnlock();

    if (!item) {
      return [Buffer.alloc(0), false];
    }

    // 检查是否过期
    if (new Date().getTime() > item.expiry.getTime()) {
      this.mutex.lock();
      try {
        delete this.items[key];
        this.currSize -= item.size;
      } finally {
        this.mutex.unlock();
      }
      return [Buffer.alloc(0), false];
    }

    // 更新最后使用时间
    this.mutex.lock();
    try {
      item.lastUsed = new Date();
    } finally {
      this.mutex.unlock();
    }

    return [item.data, true];
  }

  // GetWithTimestamp 获取缓存及其最后修改时间
  GetWithTimestamp(key: string): [Buffer, Date, boolean] {
    this.mutex.rLock();
    const item = this.items[key];
    this.mutex.rUnlock();

    if (!item) {
      return [Buffer.alloc(0), new Date(), false];
    }

    // 检查是否过期
    if (new Date().getTime() > item.expiry.getTime()) {
      this.mutex.lock();
      try {
        delete this.items[key];
        this.currSize -= item.size;
      } finally {
        this.mutex.unlock();
      }
      return [Buffer.alloc(0), new Date(), false];
    }

    // 更新最后使用时间
    this.mutex.lock();
    try {
      item.lastUsed = new Date();
    } finally {
      this.mutex.unlock();
    }

    return [item.data, item.lastModified, true];
  }

  // GetLastModified 获取缓存项的最后修改时间
  GetLastModified(key: string): [Date, boolean] {
    this.mutex.rLock();
    try {
      const item = this.items[key];
      if (!item) {
        return [new Date(), false];
      }

      // 检查是否过期
      if (new Date().getTime() > item.expiry.getTime()) {
        return [new Date(), false];
      }

      return [item.lastModified, true];
    } finally {
      this.mutex.rUnlock();
    }
  }

  // 驱逐策略 - LRU
  private evict(): void {
    // 找出最久未使用的项
    let oldestKey: string = '';
    let oldestTime: number = Date.now();

    for (const k in this.items) {
      const v = this.items[k];
      if (v.lastUsed.getTime() < oldestTime) {
        oldestKey = k;
        oldestTime = v.lastUsed.getTime();
      }
    }

    // 如果找到了最久未使用的项，删除它
    if (oldestKey) {
      const item = this.items[oldestKey];
      this.currSize -= item.size;
      delete this.items[oldestKey];
    }
  }

  // 清理过期项
  CleanExpired(): void {
    this.mutex.lock();
    try {
      const now = new Date();
      for (const k in this.items) {
        const v = this.items[k];
        if (now.getTime() > v.expiry.getTime()) {
          this.currSize -= v.size;
          delete this.items[k];
        }
      }
    } finally {
      this.mutex.unlock();
    }
  }

  // 启动定期清理
  StartCleanupTask(): void {
    setInterval(() => {
      this.CleanExpired();
    }, 5 * 60 * 1000); // 每5分钟清理一次
  }
}


