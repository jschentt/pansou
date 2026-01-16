// GlobalBufferStrategy 全局缓冲策略
export enum GlobalBufferStrategy {
  // 按关键词缓冲
  BufferByKeyword = "keyword",
  
  // 按插件缓冲
  BufferByPlugin = "plugin",
  
  // 按搜索模式缓冲
  BufferByPattern = "pattern",
  
  // 混合缓冲策略
  BufferHybrid = "hybrid"
}

// SearchPattern 搜索模式
export interface SearchPattern {
  // 关键词模式
  KeywordPattern: string;
  // 插件集合
  PluginSet: string[];
  // 时间窗口
  TimeWindow: number;
  // 频率
  Frequency: number;
  // 最后访问时间
  LastAccessTime: Date;
  // 元数据
  Metadata: Record<string, any>;
}

// CacheOperation 缓存操作
export interface CacheOperation {
  Key: string;
  Keyword: string;
  PluginName: string;
  DataSize: number;
  Timestamp: Date;
  Priority: number;
}

// GlobalBuffer 全局缓冲区
export class GlobalBuffer {
  // 基础信息
  ID: string; // 缓冲区ID
  Strategy: GlobalBufferStrategy; // 缓冲策略
  CreatedAt: Date; // 创建时间
  LastUpdatedAt: Date; // 最后更新时间
  
  // 数据存储
  Operations: CacheOperation[]; // 操作列表
  KeywordGroups: Record<string, CacheOperation[]>; // 按关键词分组
  PluginGroups: Record<string, CacheOperation[]>; // 按插件分组
  
  // 统计信息
  TotalOperations: number; // 总操作数
  TotalDataSize: number; // 总数据大小
  CompressRatio: number; // 压缩比例
  
  // 控制参数
  MaxOperations: number; // 最大操作数
  MaxDataSize: number; // 最大数据大小
  MaxAge: number; // 最大存活时间

  // 简单的互斥锁实现
  private mutex: { lock: () => void; unlock: () => void; rLock: () => void; rUnlock: () => void };

  constructor(id: string, strategy: GlobalBufferStrategy, maxOperations: number) {
    this.ID = id;
    this.Strategy = strategy;
    this.CreatedAt = new Date();
    this.LastUpdatedAt = new Date();
    this.Operations = [];
    this.KeywordGroups = {};
    this.PluginGroups = {};
    this.TotalOperations = 0;
    this.TotalDataSize = 0;
    this.CompressRatio = 0;
    this.MaxOperations = maxOperations;
    this.MaxDataSize = maxOperations * 1000; // 估算100KB
    this.MaxAge = 10 * 60 * 1000; // 10分钟最大存活时间

    // 简单的互斥锁实现
    this.mutex = {
      lock: () => {},
      unlock: () => {},
      rLock: () => {},
      rUnlock: () => {}
    };
  }
}

// GlobalBufferStats 全局缓冲区统计
export interface GlobalBufferStats {
  // 缓冲区统计
  ActiveBuffers: number; // 活跃缓冲区数量
  TotalBuffersCreated: number; // 总创建缓冲区数量
  TotalBuffersDestroyed: number; // 总销毁缓冲区数量
  
  // 操作统计
  TotalOperationsBuffered: number; // 总缓冲操作数
  TotalOperationsMerged: number; // 总合并操作数
  TotalDataMerged: number; // 总合并数据大小
  
  // 效率统计
  AverageCompressionRatio: number; // 平均压缩比例
  AverageBufferLifetime: number; // 平均缓冲区生命周期
  HitRate: number; // 命中率
  
  // 性能统计
  LastCleanupTime: Date; // 最后清理时间
  CleanupFrequency: number; // 清理频率
  MemoryUsage: number; // 内存使用量
}

// GlobalBufferManager 全局缓冲区管理器
export class GlobalBufferManager {
  // 配置
  private strategy: GlobalBufferStrategy;
  private maxBuffers: number; // 最大缓冲区数量
  private defaultBufferSize: number; // 默认缓冲区大小
  
  // 缓冲区管理
  private buffers: Record<string, GlobalBuffer>; // 缓冲区映射
  private buffersMutex: { lock: () => void; unlock: () => void; rLock: () => void; rUnlock: () => void };
  
  // 统计信息
  private stats: GlobalBufferStats;
  
  // 控制参数
  private cleanupInterval: NodeJS.Timeout | null;
  private initialized: boolean;

  // NewGlobalBufferManager 创建全局缓冲区管理器
  static NewGlobalBufferManager(strategy: GlobalBufferStrategy): GlobalBufferManager {
    // 高并发优化：静默使用插件策略，避免缓冲区爆炸
    if (strategy === GlobalBufferStrategy.BufferHybrid) {
      strategy = GlobalBufferStrategy.BufferByPlugin;
    }
    
    const manager = new GlobalBufferManager();
    manager.strategy = strategy;
    manager.maxBuffers = 50; // 最大50个缓冲区
    manager.defaultBufferSize = 100; // 默认100个操作
    manager.buffers = {};
    manager.stats = {
      ActiveBuffers: 0,
      TotalBuffersCreated: 0,
      TotalBuffersDestroyed: 0,
      TotalOperationsBuffered: 0,
      TotalOperationsMerged: 0,
      TotalDataMerged: 0,
      AverageCompressionRatio: 0,
      AverageBufferLifetime: 0,
      HitRate: 0,
      LastCleanupTime: new Date(),
      CleanupFrequency: 0,
      MemoryUsage: 0
    };
    manager.initialized = false;

    // 简单的互斥锁实现
    manager.buffersMutex = {
      lock: () => {},
      unlock: () => {},
      rLock: () => {},
      rUnlock: () => {}
    };
    
    return manager;
  }

  // Initialize 初始化管理器
  async Initialize(): Promise<void> {
    if (this.initialized) {
      return; // 已经初始化
    }
    
    this.initialized = true;
    
    // 启动定期清理
    this.cleanupInterval = setInterval(() => {
      this.performCleanup();
    }, 5 * 60 * 1000); // 每5分钟清理一次
  }

  // AddOperation 添加操作到全局缓冲区
  async AddOperation(op: CacheOperation): Promise<[GlobalBuffer, boolean]> {
    if (!this.initialized) {
      await this.Initialize();
    }
    
    // 根据策略确定缓冲区ID
    const bufferID = this.determineBufferID(op);
    
    this.buffersMutex.lock();
    try {
      // 获取或创建缓冲区
      let buffer = this.buffers[bufferID];
      if (!buffer) {
        buffer = this.createNewBuffer(bufferID, op);
        this.buffers[bufferID] = buffer;
        this.stats.TotalBuffersCreated++;
        this.stats.ActiveBuffers++;
      }
      
      // 添加操作到缓冲区
      const shouldFlush = this.addOperationToBuffer(buffer, op);
      
      // 更新统计
      this.stats.TotalOperationsBuffered++;
      
      return [buffer, shouldFlush];
    } finally {
      this.buffersMutex.unlock();
    }
  }

  // determineBufferID 确定缓冲区ID
  private determineBufferID(op: CacheOperation): string {
    switch (this.strategy) {
      case GlobalBufferStrategy.BufferByKeyword:
        return `keyword_${op.Keyword}`;
        
      case GlobalBufferStrategy.BufferByPlugin:
        return `plugin_${op.PluginName}`;
        
      case GlobalBufferStrategy.BufferByPattern:
        // 已移除模式分析器，退化为按关键词分组
        return `keyword_${op.Keyword}`;
        
      case GlobalBufferStrategy.BufferHybrid:
        // 混合策略优化：插件+时间窗口（去掉关键词避免高并发爆炸）
        const timeWindow = Math.floor(op.Timestamp.getTime() / (5 * 60 * 1000)); // 5分钟时间窗口
        return `hybrid_${op.PluginName}_${timeWindow}`;
        
      default:
        return `default_${op.Key}`;
    }
  }

  // createNewBuffer 创建新缓冲区
  private createNewBuffer(bufferID: string, firstOp: CacheOperation): GlobalBuffer {
    return new GlobalBuffer(bufferID, this.strategy, this.defaultBufferSize);
  }

  // addOperationToBuffer 添加操作到缓冲区
  private addOperationToBuffer(buffer: GlobalBuffer, op: CacheOperation): boolean {
    buffer.mutex.lock();
    try {
      // 直接追加（已移除数据合并器）
      buffer.Operations.push(op);
      buffer.TotalOperations++;
      buffer.TotalDataSize += op.DataSize;
      
      // 按关键词分组
      if (!buffer.KeywordGroups[op.Keyword]) {
        buffer.KeywordGroups[op.Keyword] = [];
      }
      buffer.KeywordGroups[op.Keyword].push(op);
      
      // 按插件分组
      if (!buffer.PluginGroups[op.PluginName]) {
        buffer.PluginGroups[op.PluginName] = [];
      }
      buffer.PluginGroups[op.PluginName].push(op);
      
      buffer.LastUpdatedAt = new Date();
      
      // 检查是否应该刷新
      return this.shouldFlushBuffer(buffer);
    } finally {
      buffer.mutex.unlock();
    }
  }

  // shouldFlushBuffer 检查是否应该刷新缓冲区
  private shouldFlushBuffer(buffer: GlobalBuffer): boolean {
    const now = new Date();
    
    // 条件1：操作数量达到阈值
    if (buffer.Operations.length >= buffer.MaxOperations) {
      return true;
    }
    
    // 条件2：数据大小达到阈值
    if (buffer.TotalDataSize >= buffer.MaxDataSize) {
      return true;
    }
    
    // 条件3：缓冲区存活时间过长
    if (now.getTime() - buffer.CreatedAt.getTime() >= buffer.MaxAge) {
      return true;
    }
    
    // 条件4：内存压力（基于全局统计）
    if (this.stats.MemoryUsage > 50 * 1024 * 1024) { // 50MB内存阈值
      return true;
    }
    
    // 条件5：高优先级操作比例达到阈值
    const highPriorityRatio = this.calculateHighPriorityRatio(buffer);
    if (highPriorityRatio > 0.6) { // 60%高优先级阈值
      return true;
    }
    
    return false;
  }

  // calculateHighPriorityRatio 计算高优先级操作比例
  private calculateHighPriorityRatio(buffer: GlobalBuffer): number {
    if (buffer.Operations.length === 0) {
      return 0;
    }
    
    let highPriorityCount = 0;
    for (const op of buffer.Operations) {
      if (op.Priority <= 2) { // 等级1和等级2插件
        highPriorityCount++;
      }
    }
    
    return highPriorityCount / buffer.Operations.length;
  }

  // FlushBuffer 刷新指定缓冲区
  async FlushBuffer(bufferID: string): Promise<CacheOperation[]> {
    this.buffersMutex.lock();
    try {
      const buffer = this.buffers[bufferID];
      if (!buffer) {
        throw new Error(`缓冲区不存在: ${bufferID}`);
      }
      
      buffer.mutex.lock();
      try {
        // 获取所有操作
        const operations = [...buffer.Operations];
        
        // 清空缓冲区
        buffer.Operations = [];
        buffer.KeywordGroups = {};
        buffer.PluginGroups = {};
        buffer.TotalOperations = 0;
        buffer.TotalDataSize = 0;
        
        // 更新压缩比例
        if (operations.length > 0) {
          buffer.CompressRatio = operations.length / buffer.TotalOperations;
        }
        
        return operations;
      } finally {
        buffer.mutex.unlock();
      }
    } finally {
      this.buffersMutex.unlock();
    }
  }

  // FlushAllBuffers 刷新所有缓冲区
  async FlushAllBuffers(): Promise<Record<string, CacheOperation[]>> {
    this.buffersMutex.rLock();
    const bufferIDs = Object.keys(this.buffers);
    this.buffersMutex.rUnlock();
    
    const result: Record<string, CacheOperation[]> = {};
    for (const id of bufferIDs) {
      try {
        const ops = await this.FlushBuffer(id);
        if (ops.length > 0) {
          result[id] = ops;
        }
      } catch (err) {
        // 忽略错误
      }
    }
    
    return result;
  }

  // performCleanup 执行清理
  private performCleanup(): void {
    const now = new Date();
    
    this.buffersMutex.lock();
    try {
      const toDelete: string[] = [];
      
      for (const id in this.buffers) {
        const buffer = this.buffers[id];
        buffer.mutex.rLock();
        
        // 清理条件：空缓冲区且超过6分钟未活动（避免与监控冲突）
        if (buffer.Operations.length === 0 && now.getTime() - buffer.LastUpdatedAt.getTime() > 6 * 60 * 1000) {
          toDelete.push(id);
        }
        
        buffer.mutex.rUnlock();
      }
      
      // 删除过期缓冲区
      for (const id of toDelete) {
        delete this.buffers[id];
        this.stats.TotalBuffersDestroyed++;
        this.stats.ActiveBuffers--;
      }
      
      // 更新清理统计
      const lastCleanupTime = this.stats.LastCleanupTime;
      this.stats.LastCleanupTime = now;
      this.stats.CleanupFrequency = now.getTime() - lastCleanupTime.getTime();
      
      // 计算内存使用量
      this.updateMemoryUsage();
      
    } finally {
      this.buffersMutex.unlock();
    }
  }

  // updateMemoryUsage 更新内存使用量估算
  private updateMemoryUsage(): void {
    let totalMemory = 0;
    
    for (const id in this.buffers) {
      const buffer = this.buffers[id];
      buffer.mutex.rLock();
      totalMemory += buffer.TotalDataSize;
      buffer.mutex.rUnlock();
    }
    
    this.stats.MemoryUsage = totalMemory;
  }

  // Shutdown 优雅关闭
  async Shutdown(): Promise<void> {
    if (!this.initialized) {
      return;
    }
    
    this.initialized = false;
    
    // 停止后台任务
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    
    // 刷新所有缓冲区
    const flushedBuffers = await this.FlushAllBuffers();
    let totalOperations = 0;
    for (const ops of Object.values(flushedBuffers)) {
      totalOperations += ops.length;
    }
  }

  // GetStats 获取统计信息
  GetStats(): GlobalBufferStats {
    const stats = { ...this.stats };
    
    // 计算平均压缩比例
    if (stats.TotalOperationsBuffered > 0) {
      stats.AverageCompressionRatio = stats.TotalOperationsMerged / stats.TotalOperationsBuffered;
    }
    
    // 计算命中率
    if (stats.TotalOperationsBuffered > 0) {
      stats.HitRate = stats.TotalOperationsMerged / stats.TotalOperationsBuffered;
    }
    
    return stats;
  }

  // GetBufferInfo 获取缓冲区信息
  GetBufferInfo(): Record<string, any> {
    this.buffersMutex.rLock();
    try {
      const info: Record<string, any> = {};
      
      for (const id in this.buffers) {
        const buffer = this.buffers[id];
        buffer.mutex.rLock();
        const bufferInfo = {
          id: id,
          strategy: buffer.Strategy,
          created_at: buffer.CreatedAt,
          last_updated_at: buffer.LastUpdatedAt,
          total_operations: buffer.TotalOperations,
          total_data_size: buffer.TotalDataSize,
          compress_ratio: buffer.CompressRatio,
          keyword_groups: Object.keys(buffer.KeywordGroups).length,
          plugin_groups: Object.keys(buffer.PluginGroups).length,
        };
        buffer.mutex.rUnlock();
        
        info[id] = bufferInfo;
      }
      
      return info;
    } finally {
      this.buffersMutex.rUnlock();
    }
  }

  // GetExpiredBuffersForFlush 原子地获取需要刷新的过期缓冲区列表
  GetExpiredBuffersForFlush(): string[] {
    this.buffersMutex.rLock();
    try {
      const now = new Date();
      const expiredBuffers: string[] = [];
      
      for (const id in this.buffers) {
        const buffer = this.buffers[id];
        // 快速预检查：先检查时间，减少锁竞争
        if (now.getTime() - buffer.LastUpdatedAt.getTime() <= 4 * 60 * 1000) {
          continue; // 跳过未过期的缓冲区
        }
        
        buffer.mutex.rLock();
        // 双重检查：确保在锁保护下再次验证
        if (now.getTime() - buffer.LastUpdatedAt.getTime() > 4 * 60 * 1000 && buffer.Operations.length > 0) {
          expiredBuffers.push(id);
        }
        buffer.mutex.rUnlock();
      }
      
      return expiredBuffers;
    } finally {
      this.buffersMutex.rUnlock();
    }
  }
}
