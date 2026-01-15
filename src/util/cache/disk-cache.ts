import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { Mutex } from 'async-mutex';
import { Marshal, Unmarshal } from '../json/json';

// 磁盘缓存项元数据
interface DiskCacheMetadata {
  key: string;
  expiry: Date;
  lastUsed: Date;
  size: number;
  lastModified: Date;
}

// DiskCache 磁盘缓存
export class DiskCache {
  private path: string;
  private maxSizeMB: number;
  private metadata: Map<string, DiskCacheMetadata>;
  private mutex: Mutex;
  private currSize: number;
  private cleanupTicker: NodeJS.Timeout | null = null;

  // NewDiskCache 创建新的磁盘缓存
  constructor(path: string, maxSizeMB: number) {
    this.path = path;
    this.maxSizeMB = maxSizeMB;
    this.metadata = new Map<string, DiskCacheMetadata>();
    this.mutex = new Mutex();
    this.currSize = 0;

    // 确保缓存目录存在
    fs.mkdirSync(this.path, { recursive: true, mode: 0o755 });

    // 加载现有缓存元数据
    this.loadMetadata();

    // 启动周期性清理
    this.startCleanupTask();
  }

  // 加载元数据
  private loadMetadata(): void {
    try {
      const files = fs.readdirSync(this.path, { withFileTypes: true });

      for (const file of files) {
        if (file.isDirectory()) {
          continue;
        }

        // 跳过元数据文件
        if (file.name === 'metadata.json') {
          continue;
        }

        // 检查是否为数据文件（非.meta文件）
        if (path.extname(file.name) === '.meta') {
          continue;
        }

        // 读取元数据
        const metadataFile = path.join(this.path, file.name + '.meta');
        if (fs.existsSync(metadataFile)) {
          const data = fs.readFileSync(metadataFile, 'utf-8');
          try {
            const meta = JSON.parse(data.toString()) as DiskCacheMetadata;
            // 转换字符串日期为Date对象
            meta.expiry = new Date(meta.expiry);
            meta.lastUsed = new Date(meta.lastUsed);
            meta.lastModified = new Date(meta.lastModified);
            
            // 更新总大小
            this.currSize += meta.size;
            
            // 存储元数据
            this.metadata.set(meta.key, meta);
          } catch (error) {
            // 忽略解析错误
          }
        }
      }
    } catch (error) {
      // 忽略读取目录错误
    }
  }

  // 保存元数据
  private saveMetadata(key: string, meta: DiskCacheMetadata): void {
    const metadataFile = path.join(this.path, this.getFilename(key) + '.meta');
    const data = JSON.stringify(meta);
    fs.writeFileSync(metadataFile, data, { mode: 0o644 });
  }

  // 获取文件名
  private getFilename(key: string): string {
    const hash = createHash('md5');
    hash.update(key);
    return hash.digest('hex');
  }

  // Set 设置缓存
  async set(key: string, data: Buffer | string, ttl: number): Promise<void> {
    await this.mutex.runExclusive(async () => {
      const bufferData = Buffer.isBuffer(data) ? data : Buffer.from(data);
      
      // 如果已存在，先减去旧项的大小
      if (this.metadata.has(key)) {
        const meta = this.metadata.get(key)!;
        this.currSize -= meta.size;
        // 删除旧文件
        const filename = this.getFilename(key);
        fs.unlinkSync(path.join(this.path, filename));
        fs.unlinkSync(path.join(this.path, filename + '.meta'));
      }

      // 检查空间
      const maxSize = this.maxSizeMB * 1024 * 1024;
      if (this.currSize + bufferData.length > maxSize) {
        // 清理空间
        this.evictLRU(bufferData.length);
      }

      // 获取文件名
      const filename = this.getFilename(key);
      const filePath = path.join(this.path, filename);

      // 确保目录存在（防止外部删除缓存目录）
      fs.mkdirSync(this.path, { recursive: true, mode: 0o755 });

      // 写入文件
      fs.writeFileSync(filePath, bufferData, { mode: 0o644 });

      // 创建元数据
      const now = new Date();
      const meta: DiskCacheMetadata = {
        key,
        expiry: new Date(now.getTime() + ttl),
        lastUsed: now,
        lastModified: now,
        size: bufferData.length,
      };

      // 保存元数据
      this.saveMetadata(key, meta);

      // 更新内存中的元数据
      this.metadata.set(key, meta);
      this.currSize += bufferData.length;
    });
  }

  // Get 获取缓存
  async get(key: string): Promise<Buffer | null> {
    let meta: DiskCacheMetadata | undefined;
    await this.mutex.runExclusive(() => {
      meta = this.metadata.get(key);
    });

    if (!meta) {
      return null;
    }

    // 检查是否过期
    if (new Date() > meta.expiry) {
      await this.delete(key);
      return null;
    }

    // 获取文件路径
    const filePath = path.join(this.path, this.getFilename(key));

    // 读取文件
    try {
      const data = fs.readFileSync(filePath);

      // 更新最后使用时间
      await this.mutex.runExclusive(() => {
        meta!.lastUsed = new Date();
        this.saveMetadata(key, meta!);
      });

      return data;
    } catch (error) {
      // 如果文件不存在，删除元数据
      if (fs.existsSync(filePath)) {
        await this.delete(key);
      }
      return null;
    }
  }

  // Delete 删除缓存
  async delete(key: string): Promise<void> {
    await this.mutex.runExclusive(() => {
      const meta = this.metadata.get(key);
      if (!meta) {
        return;
      }

      // 删除文件
      const filename = this.getFilename(key);
      fs.unlinkSync(path.join(this.path, filename));
      fs.unlinkSync(path.join(this.path, filename + '.meta'));

      // 更新元数据
      this.currSize -= meta.size;
      this.metadata.delete(key);
    });
  }

  // Has 检查缓存是否存在
  async has(key: string): Promise<boolean> {
    let exists = false;
    let isExpired = false;
    await this.mutex.runExclusive(() => {
      const meta = this.metadata.get(key);
      exists = !!meta;
      if (exists) {
        isExpired = new Date() > meta!.expiry;
      }
    });

    if (exists && isExpired) {
      // 异步删除过期项
      this.delete(key).catch(() => {});
      return false;
    }

    return exists;
  }

  // 清理过期项
  private cleanExpired(): void {
    const now = new Date();
    this.mutex.runExclusive(() => {
      for (const [key, meta] of this.metadata) {
        if (now > meta.expiry) {
          // 删除文件
          const filename = this.getFilename(key);
          fs.unlinkSync(path.join(this.path, filename));
          fs.unlinkSync(path.join(this.path, filename + '.meta'));
          
          // 更新元数据
          this.currSize -= meta.size;
          this.metadata.delete(key);
        }
      }
    });
  }

  // 驱逐策略 - LRU
  private evictLRU(requiredSpace: number): void {
    this.mutex.runExclusive(() => {
      // 按最后使用时间排序
      interface CacheItem {
        key: string;
        lastUsed: Date;
        size: number;
      }

      const items: CacheItem[] = [];
      for (const [k, v] of this.metadata) {
        items.push({
          key: k,
          lastUsed: v.lastUsed,
          size: v.size,
        });
      }

      // 按最后使用时间排序（从最旧到最新）
      items.sort((a, b) => a.lastUsed.getTime() - b.lastUsed.getTime());

      // 从最久未使用开始删除，直到有足够空间
      const maxSize = this.maxSizeMB * 1024 * 1024;
      for (const item of items) {
        if (this.currSize + requiredSpace <= maxSize) {
          break;
        }

        // 删除文件
        const filename = this.getFilename(item.key);
        const filePath = path.join(this.path, filename);
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
          fs.unlinkSync(path.join(this.path, filename + '.meta'));
          this.currSize -= item.size;
          this.metadata.delete(item.key);
        }
      }
    });
  }

  // 启动定期清理任务
  private startCleanupTask(): void {
    // 每10分钟清理一次过期项
    this.cleanupTicker = setInterval(() => {
      this.cleanExpired();
    }, 10 * 60 * 1000);
  }

  // Clear 清空缓存
  async clear(): Promise<void> {
    await this.mutex.runExclusive(() => {
      // 删除所有缓存文件
      try {
        const files = fs.readdirSync(this.path, { withFileTypes: true });
        for (const file of files) {
          if (!file.isDirectory()) {
            fs.unlinkSync(path.join(this.path, file.name));
          }
        }
      } catch (error) {
        // 忽略错误
      }

      // 重置元数据
      this.metadata.clear();
      this.currSize = 0;
    });
  }

  // GetLastModified 获取缓存项的最后修改时间
  async getLastModified(key: string): Promise<Date | null> {
    let result: Date | null = null;
    await this.mutex.runExclusive(() => {
      const meta = this.metadata.get(key);
      if (meta) {
        result = meta.lastModified;
      }
    });
    return result;
  }

  // Close 关闭缓存，清理资源
  close(): void {
    if (this.cleanupTicker) {
      clearInterval(this.cleanupTicker);
      this.cleanupTicker = null;
    }
  }
}