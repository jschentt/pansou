// 导入必要的模块
import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';

// 磁盘缓存项元数据
interface DiskCacheMetadata {
  Key: string;
  Expiry: Date;
  LastUsed: Date;
  Size: number;
  LastModified: Date; // 添加最后修改时间字段
}

// DiskCache 磁盘缓存
export class DiskCache {
  private path: string;
  private maxSizeMB: number;
  private metadata: Map<string, DiskCacheMetadata>;
  private mutex: { lock: () => void; unlock: () => void; rLock: () => void; rUnlock: () => void };
  private currSize: number;
  private cleanupInterval: NodeJS.Timeout | null;

  // NewDiskCache 创建新的磁盘缓存
  static async NewDiskCache(path: string, maxSizeMB: number): Promise<[DiskCache, Error | null]> {
    try {
      // 确保缓存目录存在
      await fs.mkdir(path, { recursive: true });

      const cache = new DiskCache(path, maxSizeMB);

      // 加载现有缓存元数据
      await cache.loadMetadata();

      // 启动周期性清理
      cache.startCleanupTask();

      return [cache, null];
    } catch (err) {
      return [new DiskCache('', 0), err as Error];
    }
  }

  // 构造函数
  constructor(path: string, maxSizeMB: number) {
    this.path = path;
    this.maxSizeMB = maxSizeMB;
    this.metadata = new Map<string, DiskCacheMetadata>();
    this.currSize = 0;
    this.cleanupInterval = null;

    // 简单的互斥锁实现
    this.mutex = {
      lock: () => {},
      unlock: () => {},
      rLock: () => {},
      rUnlock: () => {}
    };
  }

  // 加载元数据
  private async loadMetadata(): Promise<void> {
    this.mutex.lock();
    try {
      // 遍历缓存目录
      const files = await fs.readdir(this.path, { withFileTypes: true });

      for (const file of files) {
        if (file.isDirectory()) {
          continue;
        }

        // 跳过元数据文件
        if (file.name === 'metadata.json') {
          continue;
        }

        // 读取元数据
        const metadataFile = path.join(this.path, file.name + '.meta');
        try {
          const data = await fs.readFile(metadataFile, 'utf8');
          const meta = JSON.parse(data) as DiskCacheMetadata;

          // 更新总大小
          this.currSize += meta.Size;
          
          // 存储元数据
          this.metadata.set(meta.Key, meta);
        } catch {
          // 忽略读取失败的元数据
        }
      }
    } catch {
      // 忽略目录读取失败
    } finally {
      this.mutex.unlock();
    }
  }

  // 保存元数据
  private async saveMetadata(key: string, meta: DiskCacheMetadata): Promise<Error | null> {
    try {
      const metadataFile = path.join(this.path, this.getFilename(key) + '.meta');
      const data = JSON.stringify(meta, null, 2);
      await fs.writeFile(metadataFile, data, 'utf8');
      return null;
    } catch (err) {
      return err as Error;
    }
  }

  // 获取文件名
  private getFilename(key: string): string {
    const hash = crypto.createHash('md5').update(key).digest('hex');
    return hash;
  }

  // Set 设置缓存
  async Set(key: string, data: Buffer, ttl: number): Promise<Error | null> {
    this.mutex.lock();
    try {
      // 如果已存在，先减去旧项的大小
      const existingMeta = this.metadata.get(key);
      if (existingMeta) {
        this.currSize -= existingMeta.Size;
        // 删除旧文件
        const filename = this.getFilename(key);
        try {
          await fs.unlink(path.join(this.path, filename));
          await fs.unlink(path.join(this.path, filename + '.meta'));
        } catch {
          // 忽略删除失败
        }
      }

      // 检查空间
      const maxSize = this.maxSizeMB * 1024 * 1024;
      if (this.currSize + data.length > maxSize) {
        // 清理空间
        await this.evictLRU(data.length);
      }

      // 获取文件名
      const filename = this.getFilename(key);
      const filePath = path.join(this.path, filename);

      // 确保目录存在（防止外部删除缓存目录）
      try {
        await fs.mkdir(this.path, { recursive: true });
      } catch (err) {
        return new Error(`创建缓存目录失败: ${(err as Error).message}`);
      }

      // 写入文件
      try {
        await fs.writeFile(filePath, data);
      } catch (err) {
        return err as Error;
      }

      // 创建元数据
      const now = new Date();
      const meta: DiskCacheMetadata = {
        Key: key,
        Expiry: new Date(now.getTime() + ttl),
        LastUsed: now,
        LastModified: now, // 设置最后修改时间
        Size: data.length,
      };

      // 保存元数据
      if (await this.saveMetadata(key, meta)) {
        // 如果元数据保存失败，删除数据文件
        try {
          await fs.unlink(filePath);
        } catch {
          // 忽略删除失败
        }
        return new Error('保存元数据失败');
      }

      // 更新内存中的元数据
      this.metadata.set(key, meta);
      this.currSize += data.length;

      return null;
    } catch (err) {
      return err as Error;
    } finally {
      this.mutex.unlock();
    }
  }

  // Get 获取缓存
  async Get(key: string): Promise<[Buffer | null, boolean, Error | null]> {
    this.mutex.rLock();
    const meta = this.metadata.get(key);
    this.mutex.rUnlock();

    if (!meta) {
      return [null, false, null];
    }

    // 检查是否过期
    const now = new Date();
    if (now > meta.Expiry) {
      await this.Delete(key);
      return [null, false, null];
    }

    // 获取文件路径
    const filePath = path.join(this.path, this.getFilename(key));

    // 读取文件
    try {
      const data = await fs.readFile(filePath);

      // 更新最后使用时间
      this.mutex.lock();
      try {
        meta.LastUsed = now;
        await this.saveMetadata(key, meta);
      } finally {
        this.mutex.unlock();
      }

      return [data, true, null];
    } catch (err) {
      // 如果文件不存在，删除元数据
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        await this.Delete(key);
      }
      return [null, false, err as Error];
    }
  }

  // Delete 删除缓存
  async Delete(key: string): Promise<Error | null> {
    this.mutex.lock();
    try {
      const meta = this.metadata.get(key);
      if (!meta) {
        return null;
      }

      // 删除文件
      const filename = this.getFilename(key);
      try {
        await fs.unlink(path.join(this.path, filename));
        await fs.unlink(path.join(this.path, filename + '.meta'));
      } catch {
        // 忽略删除失败
      }

      // 更新元数据
      this.currSize -= meta.Size;
      this.metadata.delete(key);

      return null;
    } catch (err) {
      return err as Error;
    } finally {
      this.mutex.unlock();
    }
  }

  // Has 检查缓存是否存在
  async Has(key: string): Promise<boolean> {
    this.mutex.rLock();
    const meta = this.metadata.get(key);
    this.mutex.rUnlock();

    if (!meta) {
      return false;
    }

    // 检查是否过期
    const now = new Date();
    if (now > meta.Expiry) {
      // 异步删除过期项
      setImmediate(() => this.Delete(key));
      return false;
    }

    return true;
  }

  // 清理过期项
  private async cleanExpired(): Promise<void> {
    this.mutex.lock();
    try {
      const now = new Date();
      const expiredKeys: string[] = [];

      // 找出所有过期项
      for (const [key, meta] of this.metadata.entries()) {
        if (now > meta.Expiry) {
          expiredKeys.push(key);
        }
      }

      // 删除过期项
      for (const key of expiredKeys) {
        const meta = this.metadata.get(key);
        if (meta) {
          // 删除文件
          const filename = this.getFilename(key);
          try {
            await fs.unlink(path.join(this.path, filename));
            await fs.unlink(path.join(this.path, filename + '.meta'));
          } catch {
            // 忽略删除失败
          }
          this.currSize -= meta.Size;
          this.metadata.delete(key);
        }
      }
    } catch {
      // 忽略清理失败
    } finally {
      this.mutex.unlock();
    }
  }

  // 驱逐策略 - LRU
  private async evictLRU(requiredSpace: number): Promise<void> {
    this.mutex.lock();
    try {
      // 按最后使用时间排序
      interface CacheItem {
        key: string;
        lastUsed: Date;
        size: number;
      }

      const items: CacheItem[] = [];
      for (const [key, meta] of this.metadata.entries()) {
        items.push({
          key,
          lastUsed: meta.LastUsed,
          size: meta.Size,
        });
      }

      // 按最后使用时间排序
      items.sort((a, b) => a.lastUsed.getTime() - b.lastUsed.getTime());

      // 从最久未使用开始删除，直到有足够空间
      const maxSize = this.maxSizeMB * 1024 * 1024;
      for (const item of items) {
        if (this.currSize + requiredSpace <= maxSize) {
          break;
        }

        // 删除文件
        const filename = this.getFilename(item.key);
        try {
          await fs.unlink(path.join(this.path, filename));
          await fs.unlink(path.join(this.path, filename + '.meta'));
        } catch {
          // 忽略删除失败
        }
        this.currSize -= item.size;
        this.metadata.delete(item.key);
      }
    } catch {
      // 忽略驱逐失败
    } finally {
      this.mutex.unlock();
    }
  }

  // 启动定期清理任务
  private startCleanupTask(): void {
    // 每10分钟清理一次过期项
    this.cleanupInterval = setInterval(() => {
      this.cleanExpired();
    }, 10 * 60 * 1000);
  }

  // Clear 清空缓存
  async Clear(): Promise<Error | null> {
    this.mutex.lock();
    try {
      // 删除所有缓存文件
      try {
        const files = await fs.readdir(this.path, { withFileTypes: true });
        for (const file of files) {
          if (file.isDirectory()) {
            continue;
          }
          await fs.unlink(path.join(this.path, file.name));
        }
      } catch (err) {
        return err as Error;
      }

      // 重置元数据
      this.metadata.clear();
      this.currSize = 0;

      return null;
    } catch (err) {
      return err as Error;
    } finally {
      this.mutex.unlock();
    }
  }

  // GetLastModified 获取缓存项的最后修改时间
  async GetLastModified(key: string): Promise<[Date | null, boolean]> {
    this.mutex.rLock();
    try {
      const meta = this.metadata.get(key);
      if (!meta) {
        return [null, false];
      }
      return [meta.LastModified, true];
    } catch {
      return [null, false];
    } finally {
      this.mutex.rUnlock();
    }
  }

  // Shutdown 关闭缓存
  Shutdown(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }
}


