import { Injectable } from '@nestjs/common';
import { SearchResult } from '../models/response';

// 定义缓存策略接口
export enum CacheWriteStrategy {
  IMMEDIATE = 'IMMEDIATE',
  BATCH = 'BATCH',
  DELAYED = 'DELAYED',
}

// 定义缓存操作接口
export interface CacheOperation {
  key: string;
  data: SearchResult[];
  ttl: number;
  pluginName: string;
  keyword: string;
  timestamp: Date;
  priority: number;
  dataSize: number;
  isFinal: boolean;
}

// 延迟批量写入管理器接口
export interface DelayedBatchWriteManager {
  setMainCacheUpdater(updater: (key: string, data: Buffer, ttl: number) => Promise<void>): void;
  initialize(): Promise<void>;
  handleCacheOperation(operation: CacheOperation): Promise<void>;
  shutdown(timeout: number): Promise<void>;
  getStats(): any;
}

// 增强版两级缓存接口
export interface EnhancedTwoLevelCache {
  setBothLevels(key: string, data: Buffer, ttl: number): Promise<void>;
  setMemoryOnly(key: string, data: Buffer, ttl: number): Promise<void>;
  getSerializer(): any;
}

@Injectable()
export class CacheWriteIntegration {
  private batchManager: DelayedBatchWriteManager;
  private mainCache: EnhancedTwoLevelCache;
  private strategy: CacheWriteStrategy;
  private initialized: boolean;

  constructor(mainCache: EnhancedTwoLevelCache) {
    this.mainCache = mainCache;
    this.initialized = false;
    
    // 初始化延迟批量写入管理器
    this.initBatchManager();
  }

  private async initBatchManager(): Promise<void> {
    try {
      // TODO: 实现DelayedBatchWriteManager
      // 目前先使用模拟实现
      this.batchManager = {
        setMainCacheUpdater: (updater: (key: string, data: Buffer, ttl: number) => Promise<void>) => {
          // 存储更新器
        },
        initialize: async () => {
          return Promise.resolve();
        },
        handleCacheOperation: async (operation: CacheOperation) => {
          // 模拟处理缓存操作
          return Promise.resolve();
        },
        shutdown: async (timeout: number) => {
          return Promise.resolve();
        },
        getStats: () => {
          return {};
        },
      };
      
      // 设置主缓存更新函数
      this.batchManager.setMainCacheUpdater(this.createMainCacheUpdater());
      
      // 初始化管理器
      await this.batchManager.initialize();
      
      this.initialized = true;
      
      console.log('[缓存写入集成] 初始化完成');
    } catch (error) {
      console.error('[缓存写入集成] 初始化失败:', error);
      throw error;
    }
  }

  // 创建主缓存更新函数
  private createMainCacheUpdater(): (key: string, data: Buffer, ttl: number) => Promise<void> {
    return async (key: string, data: Buffer, ttl: number) => {
      // 调用现有的缓存系统进行实际写入
      await this.mainCache.setBothLevels(key, data, ttl);
    };
  }

  // 处理缓存写入请求
  async handleCacheWrite(
    key: string,
    results: SearchResult[],
    ttl: number,
    isFinal: boolean,
    keyword: string,
    pluginName: string
  ): Promise<void> {
    if (!this.initialized) {
      throw new Error('缓存写入集成未初始化');
    }
    
    // 计算插件优先级
    const priority = this.getPluginPriority(pluginName);
    
    // 计算数据大小（估算）
    const dataSize = this.estimateDataSize(results);
    
    // 创建缓存操作
    const operation: CacheOperation = {
      key,
      data: results,
      ttl,
      pluginName,
      keyword,
      timestamp: new Date(),
      priority,
      dataSize,
      isFinal,
    };
    
    // 调用批量写入管理器处理
    await this.batchManager.handleCacheOperation(operation);
  }

  // 获取插件优先级
  private getPluginPriority(pluginName: string): number {
    // TODO: 从插件管理器动态获取真实的优先级
    // 目前返回默认值
    return 3;
  }

  // 估算数据大小
  private estimateDataSize(results: SearchResult[]): number {
    // 简化估算：每个结果约500字节
    return results.length * 500;
  }

  // 优雅关闭
  async shutdown(timeout: number): Promise<void> {
    if (!this.initialized) {
      return;
    }
    
    await this.batchManager.shutdown(timeout);
  }

  // 获取统计信息
  getStats(): any {
    if (!this.initialized) {
      return null;
    }
    
    return this.batchManager.getStats();
  }

  // 设置写入策略
  setStrategy(strategy: CacheWriteStrategy): void {
    this.strategy = strategy;
  }

  // 获取当前策略
  getStrategy(): CacheWriteStrategy {
    return this.strategy;
  }
}