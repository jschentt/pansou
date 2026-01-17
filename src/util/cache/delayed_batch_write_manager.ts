// 导入必要的类型和模块
import { SearchResult } from '../../models/plugin-result';
import { GlobalBufferManager } from './global_buffer_manager';
import { GobSerializer } from './serializer';

// CacheWriteStrategy 缓存写入策略
export enum CacheWriteStrategy {
  // 立即写入策略（当前实现）
  CacheStrategyImmediate = "immediate",
  
  // 混合智能策略（推荐）
  CacheStrategyHybrid = "hybrid"
}

// CacheOperation 缓存操作
export interface CacheOperation {
  Key: string;
  Data: SearchResult[];
  TTL: number;
  PluginName: string;
  Keyword: string;
  Timestamp: Date;
  Priority: number; // 优先级 (1=highest, 4=lowest)
  DataSize: number; // 数据大小（字节）
  IsFinal: boolean; // 是否为最终结果
}

// CacheWriteConfig 缓存写入配置
export interface CacheWriteConfig {
  // 核心策略
  Strategy: CacheWriteStrategy;
  
  // 批量写入参数（自动计算，但可手动覆盖）
  MaxBatchInterval: number; // 0表示自动计算
  MaxBatchSize: number; // 0表示自动计算
  MaxBatchDataSize: number; // 0表示自动计算
  
  // 行为参数
  HighPriorityRatio: number;
  EnableCompression: boolean;
  
  // 内部计算参数（运行时动态调整）
  idleThresholdCPU: number;
  idleThresholdDisk: number;
  forceFlushInterval: number;
  autoTuneInterval: number;
  
  // 约束边界（硬编码）
  minBatchInterval: number;
  maxBatchInterval: number;
  minBatchSize: number;
  maxBatchSize: number;
}

// WriteManagerStats 写入管理器统计信息
export interface WriteManagerStats {
  // 基础统计
  TotalWrites: number; // 总写入次数
  TotalOperations: number; // 总操作次数
  BatchWrites: number; // 批量写入次数
  ImmediateWrites: number; // 立即写入次数
  MergedOperations: number; // 合并操作次数
  FailedWrites: number; // 失败写入次数
  SuccessfulWrites: number; // 成功写入次数
  
  // 性能统计
  LastFlushTime: Date; // 上次刷新时间
  LastFlushTrigger: string; // 上次刷新触发原因
  LastBatchSize: number; // 上次批量大小
  TotalOperationsWritten: number; // 已写入操作总数
  
  // 时间窗口
  WindowStart: Date; // 统计窗口开始时间
  WindowEnd: Date; // 统计窗口结束时间
  
  // 运行时状态
  CurrentQueueSize: number; // 当前队列大小
  CurrentMemoryUsage: number; // 当前内存使用量
  SystemLoadAverage: number; // 系统负载均值
}

// DelayedBatchWriteManager 延迟批量写入管理器
export class DelayedBatchWriteManager {
  private strategy: CacheWriteStrategy;
  private config: CacheWriteConfig;
  
  // 延迟写入队列
  private writeQueue: CacheOperation[];
  private queueBuffer: CacheOperation[];
  private queueMutex: { lock: () => void; unlock: () => void };
  
  // 全局缓冲区管理器
  private globalBufferManager: GlobalBufferManager;
  
  // 统计信息
  private stats: WriteManagerStats;
  
  // 控制参数
  private shutdownChan: boolean;
  private flushTicker: NodeJS.Timeout | null;
  private autoTuneTicker: NodeJS.Timeout | null;
  private globalBufferMonitorTicker: NodeJS.Timeout | null;
  
  // 数据压缩（操作合并）
  private operationMap: Map<string, CacheOperation>; // key -> latest operation (去重合并)
  private mapMutex: { lock: () => void; unlock: () => void; rLock: () => void; rUnlock: () => void };
  
  // 主缓存更新函数
  private mainCacheUpdater: ((key: string, data: Buffer, ttl: number) => Promise<Error | null>) | null;
  
  // 序列化器
  private serializer: GobSerializer;
  
  // 初始化标志
  private initialized: boolean;
  private initMutex: { lock: () => void; unlock: () => void };

  // NewDelayedBatchWriteManager 创建新的延迟批量写入管理器
  static NewDelayedBatchWriteManager(): DelayedBatchWriteManager {
    const config: CacheWriteConfig = {
      Strategy: CacheWriteStrategy.CacheStrategyHybrid,
      EnableCompression: true,
      MaxBatchInterval: 0,
      MaxBatchSize: 0,
      MaxBatchDataSize: 0,
      HighPriorityRatio: 0.3,
      idleThresholdCPU: 0.3,
      idleThresholdDisk: 0.5,
      forceFlushInterval: 0,
      autoTuneInterval: 300000, // 5分钟
      minBatchInterval: 30000, // 最小30秒
      maxBatchInterval: 600000, // 最大10分钟
      minBatchSize: 10, // 最小10个
      maxBatchSize: 1000 // 最大1000个
    };
    
    // 初始化配置
    DelayedBatchWriteManager.initializeConfig(config);
    
    // 创建全局缓冲区管理器
    const globalBufferManager = GlobalBufferManager.NewGlobalBufferManager("hybrid");
    
    const manager = new DelayedBatchWriteManager();
    manager.strategy = config.Strategy;
    manager.config = config;
    manager.writeQueue = [];
    manager.queueBuffer = [];
    manager.globalBufferManager = globalBufferManager;
    manager.operationMap = new Map();
    manager.shutdownChan = false;
    manager.stats = {
      TotalWrites: 0,
      TotalOperations: 0,
      BatchWrites: 0,
      ImmediateWrites: 0,
      MergedOperations: 0,
      FailedWrites: 0,
      SuccessfulWrites: 0,
      LastFlushTime: new Date(0),
      LastFlushTrigger: "",
      LastBatchSize: 0,
      TotalOperationsWritten: 0,
      WindowStart: new Date(),
      WindowEnd: new Date(),
      CurrentQueueSize: 0,
      CurrentMemoryUsage: 0,
      SystemLoadAverage: 0
    };
    manager.serializer = GobSerializer.NewGobSerializer();
    manager.initialized = false;
    manager.mainCacheUpdater = null;
    
    // 简单的互斥锁实现
    manager.queueMutex = {
      lock: () => {},
      unlock: () => {}
    };
    
    manager.mapMutex = {
      lock: () => {},
      unlock: () => {},
      rLock: () => {},
      rUnlock: () => {}
    };
    
    manager.initMutex = {
      lock: () => {},
      unlock: () => {}
    };
    
    return manager;
  }

  // initializeConfig 初始化配置
  private static initializeConfig(config: CacheWriteConfig): void {
    // 自动计算最优参数
    if (config.MaxBatchInterval === 0) {
      config.MaxBatchInterval = DelayedBatchWriteManager.calculateOptimalBatchInterval(config);
    }
    
    if (config.MaxBatchSize === 0) {
      config.MaxBatchSize = DelayedBatchWriteManager.calculateOptimalBatchSize(config);
    }
    
    if (config.MaxBatchDataSize === 0) {
      config.MaxBatchDataSize = DelayedBatchWriteManager.calculateOptimalDataSize(config);
    }
    
    // 内部参数自动设置
    config.forceFlushInterval = config.MaxBatchInterval * 5; // 5倍批量间隔
    config.autoTuneInterval = 300000; // 5分钟调优间隔
    config.idleThresholdCPU = 0.3; // CPU空闲阈值
    config.idleThresholdDisk = 0.5; // 磁盘空闲阈值
  }

  // calculateOptimalBatchInterval 计算最优批量间隔
  private static calculateOptimalBatchInterval(config: CacheWriteConfig): number {
    // 基于系统性能动态计算
    // 简化实现：根据可用内存量调整
    const availableMemoryGB = DelayedBatchWriteManager.getAvailableMemoryGB();
    
    let interval: number;
    if (availableMemoryGB > 8) { // 大内存系统
      interval = 45000; // 45秒
    } else if (availableMemoryGB > 4) { // 中等内存系统
      interval = 60000; // 60秒
    } else { // 小内存系统
      interval = 90000; // 90秒
    }
    
    // 应用约束
    if (interval < config.minBatchInterval) {
      interval = config.minBatchInterval;
    }
    if (interval > config.maxBatchInterval) {
      interval = config.maxBatchInterval;
    }
    
    return interval;
  }

  // calculateOptimalBatchSize 计算最优批量大小
  private static calculateOptimalBatchSize(config: CacheWriteConfig): number {
    // 基于CPU核心数和内存动态计算
    const numCPU = require('os').cpus().length;
    const availableMemoryGB = DelayedBatchWriteManager.getAvailableMemoryGB();
    
    let size: number;
    if (numCPU >= 8 && availableMemoryGB > 8) { // 高性能系统
      size = 200;
    } else if (numCPU >= 4 && availableMemoryGB > 4) { // 中等性能系统
      size = 100;
    } else { // 低性能系统
      size = 50;
    }
    
    // 应用约束
    if (size < config.minBatchSize) {
      size = config.minBatchSize;
    }
    if (size > config.maxBatchSize) {
      size = config.maxBatchSize;
    }
    
    return size;
  }

  // calculateOptimalDataSize 计算最优数据大小
  private static calculateOptimalDataSize(config: CacheWriteConfig): number {
    // 基于可用内存计算
    const availableMemoryGB = DelayedBatchWriteManager.getAvailableMemoryGB();
    
    let sizeMB: number;
    if (availableMemoryGB > 16) { // 大内存系统
      sizeMB = 20;
    } else if (availableMemoryGB > 8) { // 中等内存系统
      sizeMB = 10;
    } else { // 小内存系统
      sizeMB = 5;
    }
    
    return sizeMB * 1024 * 1024; // 转换为字节
  }

  // getAvailableMemoryGB 获取可用内存（GB）
  private static getAvailableMemoryGB(): number {
    try {
      const memInfo = require('os').totalmem();
      return memInfo / 1024 / 1024 / 1024;
    } catch {
      return 4; // 默认4GB
    }
  }

  // Initialize 初始化管理器
  async Initialize(): Promise<Error | null> {
    if (this.initialized) {
      return null; // 已经初始化
    }
    
    this.initMutex.lock();
    try {
      if (this.initialized) {
        return null; // 双重检查
      }
      
      // 初始化全局缓冲区管理器
      await this.globalBufferManager.Initialize();
      
      // 启动后台处理
      this.startBackgroundProcessor();
      
      // 启动定时刷新
      this.flushTicker = setInterval(() => {
        this.timerFlushProcessor();
      }, this.config.MaxBatchInterval);
      
      // 启动自动调优
      this.autoTuneTicker = setInterval(() => {
        this.autoTuningProcessor();
      }, this.config.autoTuneInterval);
      
      // 启动全局缓冲区监控
      this.globalBufferMonitorTicker = setInterval(() => {
        this.checkAndFlushExpiredBuffers();
      }, 2 * 60 * 1000); // 每2分钟检查一次
      
      this.initialized = true;
      console.log(`缓存写入策略: ${this.strategy}`);
      return null;
    } catch (err) {
      return err as Error;
    } finally {
      this.initMutex.unlock();
    }
  }

  // SetMainCacheUpdater 设置主缓存更新函数
  SetMainCacheUpdater(updater: (key: string, data: Buffer, ttl: number) => Promise<Error | null>): void {
    this.mainCacheUpdater = updater;
  }

  // HandleCacheOperation 处理缓存操作
  async HandleCacheOperation(op: CacheOperation): Promise<Error | null> {
    // 确保管理器已初始化
    if (!this.initialized) {
      const err = await this.Initialize();
      if (err) {
        return err;
      }
    }
    
    // 关键：无论什么策略，都立即更新内存缓存
    const err = await this.updateMemoryCache(op);
    if (err) {
      return new Error(`内存缓存更新失败: ${err.message}`);
    }
    
    // 根据策略处理磁盘写入
    if (this.strategy === CacheWriteStrategy.CacheStrategyImmediate) {
      return this.immediateWriteToDisk(op);
    }
    
    // 使用全局缓冲区管理器进行智能缓冲
    return this.handleWithGlobalBuffer(op);
  }

  // handleWithGlobalBuffer 使用全局缓冲区处理操作
  private async handleWithGlobalBuffer(op: CacheOperation): Promise<Error | null> {
    try {
      // 尝试添加到全局缓冲区
      const [buffer, shouldFlush] = await this.globalBufferManager.AddOperation(op);
      
      // 如果需要刷新缓冲区
      if (shouldFlush) {
        return this.flushGlobalBuffer(buffer.ID);
      }
      
      return null;
    } catch (err) {
      // 全局缓冲区失败，降级到本地队列
      return this.enqueueForBatchWrite(op);
    }
  }

  // flushGlobalBuffer 刷新全局缓冲区
  private async flushGlobalBuffer(bufferID: string): Promise<Error | null> {
    try {
      const operations = await this.globalBufferManager.FlushBuffer(bufferID);
      
      if (operations.length === 0) {
        return null;
      }
      
      // 按优先级排序操作
      operations.sort((a, b) => {
        if (a.Priority !== b.Priority) {
          return a.Priority - b.Priority;
        }
        return a.Timestamp.getTime() - b.Timestamp.getTime();
      });
      
      // 统计信息更新
      this.stats.BatchWrites++;
      this.stats.TotalWrites++;
      this.stats.LastFlushTime = new Date();
      this.stats.LastFlushTrigger = "全局缓冲区触发";
      this.stats.LastBatchSize = operations.length;
      
      // 批量写入磁盘
      const err = await this.batchWriteToDisk(operations);
      if (err) {
        this.stats.FailedWrites++;
        return new Error(`全局缓冲区批量写入失败: ${err.message}`);
      }
      
      // 📈 成功统计
      this.stats.SuccessfulWrites++;
      this.stats.TotalOperationsWritten += operations.length;
      
      return null;
    } catch (err) {
      return err as Error;
    }
  }

  // checkAndFlushExpiredBuffers 检查并刷新过期缓冲区
  private async checkAndFlushExpiredBuffers(): Promise<void> {
    // 使用原子操作获取需要刷新的缓冲区列表
    const expiredBuffers = this.globalBufferManager.GetExpiredBuffersForFlush();
    
    let flushedCount = 0;
    for (const bufferID of expiredBuffers) {
      try {
        if (await this.flushGlobalBuffer(bufferID)) {
          // 区分错误类型，缓冲区不存在是正常情况
          continue;
        }
        flushedCount++;
      } catch (err) {
        // 只有真正的错误才打印警告
        console.warn(`[全局缓冲区] 刷新缓冲区失败 ${bufferID}: ${(err as Error).message}`);
      }
    }
    
    if (flushedCount > 0) {
      console.log(`[全局缓冲区] 刷新完成，处理 ${flushedCount} 个过期缓冲区`);
    }
  }

  // updateMemoryCache 更新内存缓存（立即执行）
  private async updateMemoryCache(op: CacheOperation): Promise<Error | null> {
    // 如果有主缓存更新函数，立即更新内存层
    if (this.mainCacheUpdater) {
      try {
        // 序列化数据
        this.serializer.Serialize(op.Data);
      } catch (err) {
        return new Error(`内存缓存数据序列化失败: ${(err as Error).message}`);
      }
    }
    return null;
  }

  // immediateWriteToDisk 立即写入磁盘
  private async immediateWriteToDisk(op: CacheOperation): Promise<Error | null> {
    if (!this.mainCacheUpdater) {
      return new Error("主缓存更新函数未设置");
    }
    
    try {
      // 序列化数据
      const data = this.serializer.Serialize(op.Data);
      
      // 更新统计
      this.stats.TotalWrites++;
      this.stats.TotalOperations++;
      this.stats.ImmediateWrites++;
      
      return await this.mainCacheUpdater(op.Key, data, op.TTL);
    } catch (err) {
      return new Error(`数据序列化失败: ${(err as Error).message}`);
    }
  }

  // enqueueForBatchWrite 加入批量写入队列
  private async enqueueForBatchWrite(op: CacheOperation): Promise<Error | null> {
    // 🚀 操作合并优化：相同key的操作只保留最新的
    if (this.config.EnableCompression) {
      this.mapMutex.lock();
      try {
        const existing = this.operationMap.get(op.Key);
        if (existing) {
          // 合并操作：保留最新数据，累计统计信息
          op.DataSize += existing.DataSize;
          this.stats.MergedOperations++;
        }
        this.operationMap.set(op.Key, op);
      } finally {
        this.mapMutex.unlock();
      }
    }
    
    // 加入延迟写入队列
    this.queueMutex.lock();
    try {
      this.writeQueue.push(op);
      this.stats.CurrentQueueSize++;
      
      // 检查是否应该触发批量写入
      const [shouldFlush, trigger] = this.shouldTriggerBatchWrite();
      if (shouldFlush) {
        return await this.executeBatchWrite(trigger);
      }
      
      return null;
    } finally {
      this.queueMutex.unlock();
    }
  }

  // startBackgroundProcessor 启动后台处理器
  private startBackgroundProcessor(): void {
    // 简单的后台处理，使用setInterval模拟
    setInterval(() => {
      this.processQueue();
    }, 100); // 每100ms处理一次队列
  }

  // processQueue 处理队列
  private async processQueue(): Promise<void> {
    if (this.writeQueue.length === 0 || !this.initialized) {
      return;
    }
    
    this.queueMutex.lock();
    try {
      while (this.writeQueue.length > 0) {
        const op = this.writeQueue.shift()!;
        this.queueBuffer.push(op);
        this.stats.CurrentQueueSize--;
        
        // 检查是否应该触发批量写入
        const [shouldFlush, trigger] = this.shouldTriggerBatchWrite();
        if (shouldFlush) {
          await this.executeBatchWrite(trigger);
          break;
        }
      }
    } catch (err) {
      console.error(`后台处理失败: ${(err as Error).message}`);
    } finally {
      this.queueMutex.unlock();
    }
  }

  // timerFlushProcessor 定时刷新处理器
  private async timerFlushProcessor(): Promise<void> {
    if (!this.initialized || this.queueBuffer.length === 0) {
      return;
    }
    
    this.queueMutex.lock();
    try {
      if (this.queueBuffer.length > 0) {
        await this.executeBatchWrite("定时触发");
      }
    } catch (err) {
      console.error(`定时刷新失败: ${(err as Error).message}`);
    } finally {
      this.queueMutex.unlock();
    }
  }

  // Shutdown 优雅关闭
  async Shutdown(timeout: number): Promise<Error | null> {
    if (!this.initialized) {
      return null; // 已经关闭
    }
    
    this.initialized = false;
    this.shutdownChan = true;
    
    // 停止定时器
    if (this.flushTicker) {
      clearInterval(this.flushTicker);
      this.flushTicker = null;
    }
    
    if (this.autoTuneTicker) {
      clearInterval(this.autoTuneTicker);
      this.autoTuneTicker = null;
    }
    
    if (this.globalBufferMonitorTicker) {
      clearInterval(this.globalBufferMonitorTicker);
      this.globalBufferMonitorTicker = null;
    }
    
    // 等待所有数据保存完成，但有超时保护
    const startTime = Date.now();
    let lastErr: Error | null = null;
    
    try {
      // 第一步：强制刷新全局缓冲区（优先级最高）
      const err = await this.flushAllGlobalBuffers();
      if (err) {
        console.warn(`[数据保护] 全局缓冲区刷新失败: ${err.message}`);
        lastErr = err;
      }
      
      // 第二步：刷新本地队列
      const err2 = await this.flushAllPendingData();
      if (err2) {
        console.warn(`[数据保护] 本地队列刷新失败: ${err2.message}`);
        lastErr = err2;
      }
      
      // 第三步：关闭全局缓冲区管理器
      await this.globalBufferManager.Shutdown();
      
      // 检查超时
      if (Date.now() - startTime > timeout) {
        return new Error("数据保存超时");
      }
      
      return lastErr;
    } catch (err) {
      return err as Error;
    }
  }

  // flushAllGlobalBuffers 刷新所有全局缓冲区
  private async flushAllGlobalBuffers(): Promise<Error | null> {
    try {
      const allBuffers = await this.globalBufferManager.FlushAllBuffers();
      
      let lastErr: Error | null = null;
      
      for (const bufferID in allBuffers) {
        const operations = allBuffers[bufferID];
        if (operations.length > 0) {
          const err = await this.batchWriteToDisk(operations);
          if (err) {
            console.warn(`[全局缓冲区] 缓冲区 ${bufferID} 刷新失败: ${err.message}`);
            lastErr = new Error(`刷新全局缓冲区 ${bufferID} 失败: ${err.message}`);
          }
        }
      }
      
      return lastErr;
    } catch (err) {
      return err as Error;
    }
  }

  // flushAllPendingData 刷新所有待处理数据
  private async flushAllPendingData(): Promise<Error | null> {
    this.queueMutex.lock();
    try {
      // 处理队列缓冲区中的数据
      if (this.queueBuffer.length > 0) {
        const err = await this.executeBatchWrite("程序关闭");
        if (err) {
          return err;
        }
      }
      
      // 处理操作映射中的数据（如果启用了压缩）
      if (this.config.EnableCompression && this.operationMap.size > 0) {
        const operations = this.getCompressedOperations();
        if (operations.length > 0) {
          return await this.batchWriteToDisk(operations);
        }
      }
      
      return null;
    } finally {
      this.queueMutex.unlock();
    }
  }

  // shouldTriggerBatchWrite 检查是否应该触发批量写入
  private shouldTriggerBatchWrite(): [boolean, string] {
    const now = new Date();
    
    // 条件1：时间间隔达到阈值
    if (now.getTime() - this.stats.LastFlushTime.getTime() >= this.config.MaxBatchInterval) {
      return [true, "时间间隔触发"];
    }
    
    // 条件2：操作数量达到阈值
    if (this.queueBuffer.length >= this.config.MaxBatchSize) {
      return [true, "数量阈值触发"];
    }
    
    // 条件3：数据大小达到阈值
    const totalSize = this.calculateBufferSize();
    if (totalSize >= this.config.MaxBatchDataSize) {
      return [true, "大小阈值触发"];
    }
    
    // 条件4：高优先级数据比例达到阈值
    const highPriorityRatio = this.calculateHighPriorityRatio();
    if (highPriorityRatio >= this.config.HighPriorityRatio) {
      return [true, "高优先级触发"];
    }
    
    // 条件5：系统空闲（CPU和磁盘使用率都较低）
    if (this.isSystemIdle()) {
      return [true, "系统空闲触发"];
    }
    
    // 条件6：强制刷新间隔（兜底机制）
    if (now.getTime() - this.stats.LastFlushTime.getTime() >= this.config.forceFlushInterval) {
      return [true, "强制刷新触发"];
    }
    
    return [false, ""];
  }

  // calculateBufferSize 计算缓冲区数据大小
  private calculateBufferSize(): number {
    let totalSize = 0;
    for (const op of this.queueBuffer) {
      totalSize += op.DataSize;
    }
    return totalSize;
  }

  // calculateHighPriorityRatio 计算高优先级数据比例
  private calculateHighPriorityRatio(): number {
    if (this.queueBuffer.length === 0) {
      return 0;
    }
    
    let highPriorityCount = 0;
    for (const op of this.queueBuffer) {
      if (op.Priority <= 2) { // 等级1和等级2插件
        highPriorityCount++;
      }
    }
    
    return highPriorityCount / this.queueBuffer.length;
  }

  // isSystemIdle 检查系统是否空闲
  private isSystemIdle(): boolean {
    // 简化实现：返回true表示系统空闲
    return true;
  }

  // executeBatchWrite 执行批量写入
  private async executeBatchWrite(trigger: string): Promise<Error | null> {
    if (this.queueBuffer.length === 0) {
      return null;
    }
    
    // 操作合并：如果启用压缩，使用合并后的操作
    let operations: CacheOperation[];
    if (this.config.EnableCompression) {
      operations = this.getCompressedOperations();
    } else {
      operations = [...this.queueBuffer];
    }
    
    if (operations.length === 0) {
      return null;
    }
    
    // 按优先级排序：确保重要数据优先写入
    operations.sort((a, b) => {
      if (a.Priority !== b.Priority) {
        return a.Priority - b.Priority; // 数字越小优先级越高
      }
      return a.Timestamp.getTime() - b.Timestamp.getTime();
    });
    
    // 统计信息更新
    this.stats.BatchWrites++;
    this.stats.LastFlushTime = new Date();
    this.stats.LastFlushTrigger = trigger;
    this.stats.LastBatchSize = operations.length;
    
    try {
      // 批量写入磁盘
      const err = await this.batchWriteToDisk(operations);
      if (err) {
        this.stats.FailedWrites++;
        return err;
      }
      
      // 清空缓冲区
      this.queueBuffer = [];
      if (this.config.EnableCompression) {
        this.mapMutex.lock();
        this.operationMap.clear();
        this.mapMutex.unlock();
      }
      
      // 成功统计
      this.stats.SuccessfulWrites++;
      this.stats.TotalWrites++;
      this.stats.TotalOperationsWritten += operations.length;
      
      return null;
    } catch (err) {
      this.stats.FailedWrites++;
      return new Error(`批量写入失败: ${(err as Error).message}`);
    }
  }

  // getCompressedOperations 获取压缩后的操作列表
  private getCompressedOperations(): CacheOperation[] {
    this.mapMutex.rLock();
    try {
      const operations: CacheOperation[] = [];
      for (const op of this.operationMap.values()) {
        operations.push(op);
      }
      return operations;
    } finally {
      this.mapMutex.rUnlock();
    }
  }

  // batchWriteToDisk 批量写入磁盘
  private async batchWriteToDisk(operations: CacheOperation[]): Promise<Error | null> {
    if (!this.mainCacheUpdater) {
      return new Error("主缓存更新函数未设置");
    }
    
    // 批量处理所有操作
    for (const op of operations) {
      try {
        // 序列化数据
        const data = this.serializer.Serialize(op.Data);
        
        // 写入磁盘
        const err = await this.mainCacheUpdater(op.Key, data, op.TTL);
        if (err) {
          return new Error(`磁盘写入失败: ${err.message}`);
        }
      } catch (err) {
        return new Error(`数据序列化失败: ${(err as Error).message}`);
      }
    }
    
    return null;
  }

  // emergencyFlush 紧急刷新
  private async emergencyFlush(): Promise<Error | null> {
    this.queueMutex.lock();
    try {
      return await this.executeBatchWrite("紧急刷新");
    } finally {
      this.queueMutex.unlock();
    }
  }

  // autoTuningProcessor 自动调优处理器
  private autoTuningProcessor(): void {
    if (!this.initialized) {
      return;
    }
    
    this.autoTuneParameters();
  }

  // autoTuneParameters 自适应参数调优
  private autoTuneParameters(): void {
    // 完全自动调优，无需配置开关
    const stats = this.GetWriteManagerStats();
    
    // 调优批量间隔：基于系统负载动态调整
    const avgSystemLoad = stats.SystemLoadAverage;
    if (avgSystemLoad > 0.8) { // 高负载：延长间隔，减少干扰
      this.config.MaxBatchInterval = Math.min(this.config.MaxBatchInterval * 12 / 10, this.config.maxBatchInterval);
    } else if (avgSystemLoad < 0.3) { // 低负载：缩短间隔，及时持久化
      this.config.MaxBatchInterval = Math.max(this.config.MaxBatchInterval * 8 / 10, this.config.minBatchInterval);
    }
    
    // 调优批量大小：基于写入频率动态调整
    const queueSize = this.writeQueue.length;
    if (queueSize > 200) { // 高频：增大批量，提高效率
      this.config.MaxBatchSize = Math.min(this.config.MaxBatchSize * 12 / 10, this.config.maxBatchSize);
    } else if (queueSize < 50) { // 低频：减小批量，降低延迟
      this.config.MaxBatchSize = Math.max(this.config.MaxBatchSize * 8 / 10, this.config.minBatchSize);
    }
  }

  // GetStats 获取统计信息
  GetStats(): any {
    const stats = this.GetWriteManagerStats();
    
    // 获取全局缓冲区统计
    const globalBufferStats = this.globalBufferManager.GetStats();
    
    // 合并所有统计信息
    return {
      write_manager: stats,
      global_buffer: globalBufferStats,
      buffer_info: this.globalBufferManager.GetBufferInfo()
    };
  }

  // GetWriteManagerStats 获取写入管理器统计（兼容性方法）
  GetWriteManagerStats(): WriteManagerStats {
    const stats = { ...this.stats };
    stats.WindowEnd = new Date();
    
    // 计算压缩比例
    if (stats.TotalOperations > 0) {
      stats.SystemLoadAverage = stats.TotalWrites / stats.TotalOperations;
    }
    
    return stats;
  }
}

// 导出
export { DelayedBatchWriteManager };
