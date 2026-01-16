import { DelayedBatchWriteManager } from '../util/cache/delayed_batch_write_manager';
import { EnhancedTwoLevelCache } from '../util/cache/enhanced_two_level_cache';
import { CacheWriteStrategy, CacheOperation } from '../util/cache/delayed_batch_write_manager';
import { SearchResult } from '../models/plugin-result';
import { GetPluginByName } from '../plugins/plugin.manager';

// CacheWriteIntegration 缓存写入集成层
export class CacheWriteIntegration {
  private batchManager: DelayedBatchWriteManager;
  private mainCache: EnhancedTwoLevelCache;
  private strategy: CacheWriteStrategy;
  private initialized: boolean = false;

  // NewCacheWriteIntegration 创建缓存写入集成
  public static async NewCacheWriteIntegration(mainCache: EnhancedTwoLevelCache): Promise<[CacheWriteIntegration, Error | null]> {
    try {
      // 创建延迟批量写入管理器
      const [batchManager, err] = await DelayedBatchWriteManager.NewDelayedBatchWriteManager();
      if (err) {
        return [null, new Error(`创建批量写入管理器失败: ${err.message}`)];
      }
      
      const integration = new CacheWriteIntegration();
      integration.batchManager = batchManager;
      integration.mainCache = mainCache;
      
      // 设置主缓存更新函数
      batchManager.SetMainCacheUpdater(integration.createMainCacheUpdater());
      
      // 初始化管理器
      const initErr = await batchManager.Initialize();
      if (initErr) {
        return [null, new Error(`初始化批量写入管理器失败: ${initErr.message}`)];
      }
      
      integration.initialized = true;
      
      console.log('[缓存写入集成] 初始化完成');
      return [integration, null];
    } catch (error) {
      return [null, error as Error];
    }
  }

  // createMainCacheUpdater 创建主缓存更新函数
  private createMainCacheUpdater(): (key: string, data: Buffer, ttl: number) => Promise<Error | null> {
    return async (key: string, data: Buffer, ttl: number): Promise<Error | null> => {
      // 调用现有的缓存系统进行实际写入
      return await this.mainCache.SetBothLevels(key, data, ttl);
    };
  }

  // HandleCacheWrite 处理缓存写入请求
  public async HandleCacheWrite(key: string, results: SearchResult[], ttl: number, isFinal: boolean, keyword: string, pluginName: string): Promise<Error | null> {
    if (!this.initialized) {
      return new Error('缓存写入集成未初始化');
    }
    
    // 计算插件优先级
    const priority = this.getPluginPriority(pluginName);
    
    // 计算数据大小（估算）
    const dataSize = this.estimateDataSize(results);
    
    // 创建缓存操作
    const operation: CacheOperation = {
      Key: key,
      Data: results,
      TTL: ttl,
      PluginName: pluginName,
      Keyword: keyword,
      Timestamp: new Date(),
      Priority: priority,
      DataSize: dataSize,
      IsFinal: isFinal,
    };
    
    // 调用批量写入管理器处理
    return await this.batchManager.HandleCacheOperation(operation);
  }

  // getPluginPriority 获取插件优先级
  private getPluginPriority(pluginName: string): number {
    // 从插件管理器动态获取真实的优先级
    const [pluginInstance, exists] = GetPluginByName(pluginName);
    if (exists) {
      return pluginInstance.Priority();
    }
    
    // 如果插件不存在，返回默认等级4（最低优先级）
    return 4;
  }

  // estimateDataSize 估算数据大小
  private estimateDataSize(results: SearchResult[]): number {
    // 简化估算：每个结果约500字节
    return results.length * 500;
  }

  // Shutdown 优雅关闭
  public async Shutdown(timeout: number): Promise<Error | null> {
    if (!this.initialized) {
      return null;
    }
    
    return await this.batchManager.Shutdown(timeout);
  }

  // GetStats 获取统计信息
  public GetStats(): any {
    if (!this.initialized) {
      return null;
    }
    
    return this.batchManager.GetStats();
  }

  // SetStrategy 设置写入策略
  public SetStrategy(strategy: CacheWriteStrategy): void {
    this.strategy = strategy;
  }

  // GetStrategy 获取当前策略
  public GetStrategy(): CacheWriteStrategy {
    return this.strategy;
  }
}
