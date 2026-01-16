// 导入必要的模块
import * as url from 'url';
import * as http from 'http';
import * as https from 'https';
import * as crypto from 'crypto';
import { SearchResult, SearchResponse, MergedLinks, MergedLink, Link } from '../models/plugin-result';
import { PluginManager, AsyncSearchPlugin } from '../plugins/plugin.manager';
import * as cache from '../util/cache/cache_key';
import { EnhancedTwoLevelCache } from '../util/cache/enhanced_two_level_cache';
import { DelayedBatchWriteManager, CacheOperation } from '../util/cache/delayed_batch_write_manager';
import { WorkerPool, Task } from '../util/pool/worker_pool';
import * as util from '../util/http_util';
import { AppConfig } from '../config/config';

// 全局变量
let enhancedTwoLevelCache: EnhancedTwoLevelCache | null = null;
let cacheInitialized: boolean = false;
let globalCacheWriteManager: DelayedBatchWriteManager | null = null;

// 优先关键词列表
const priorityKeywords: string[] = ['合集', '系列', '全', '完', '最新', '附', 'complete'];

// normalizeUrl 标准化URL，将URL编码的中文部分解码为中文，用于去重
export function normalizeUrl(rawUrl: string): string {
  try {
    // 解码URL中的编码字符
    const decoded = decodeURIComponent(rawUrl);
    return decoded;
  } catch {
    // 如果解码失败，返回原始URL
    return rawUrl;
  }
}

// SetGlobalCacheWriteManager 设置全局缓存写入管理器
export function SetGlobalCacheWriteManager(manager: DelayedBatchWriteManager): void {
  globalCacheWriteManager = manager;
}

// GetGlobalCacheWriteManager 获取全局缓存写入管理器
export function GetGlobalCacheWriteManager(): DelayedBatchWriteManager | null {
  return globalCacheWriteManager;
}

// GetEnhancedTwoLevelCache 获取增强版两级缓存实例
export function GetEnhancedTwoLevelCache(): EnhancedTwoLevelCache | null {
  return enhancedTwoLevelCache;
}

// extractKeywordFromCacheKey 从缓存键中提取关键词（简化版）
function extractKeywordFromCacheKey(cacheKey: string): string {
  // 这是一个简化的实现，实际中我们会通过传递来获得关键词
  // 为了演示，这里返回简化的显示
  return '搜索关键词';
}

// logAsyncCacheWithKeyword 异步缓存日志输出辅助函数（带关键词）
function logAsyncCacheWithKeyword(keyword: string, cacheKey: string, format: string, ...args: any[]): void {
  // 检查配置开关
  if (!AppConfig || !AppConfig.AsyncLogEnabled) {
    return;
  }
  
  // 构建显示的关键词信息
  let displayKeyword: string = keyword;
  if (displayKeyword === '') {
    displayKeyword = '未知';
  }
  
  // 将缓存键替换为简化版本+关键词
  let shortKey: string = cacheKey;
  if (shortKey.length > 8) {
    shortKey = shortKey.substring(0, 8) + '...';
  }
  
  // 替换格式字符串中的缓存键
  const enhancedFormat = format.replace(cacheKey, `${shortKey}(关键词:${displayKeyword})`);
  console.log(enhancedFormat, ...args);
}

// 初始化缓存
function initCache(): void {
  if (AppConfig && AppConfig.CacheEnabled) {
    try {
      // 这里需要根据实际的缓存初始化逻辑进行调整
      // 暂时设置为null，后续会在NewSearchService中初始化
      cacheInitialized = true;
    } catch {
      cacheInitialized = false;
    }
  }
}

// 初始化
initCache();

// ResultScore 结果得分结构
interface ResultScore {
  Result: SearchResult;
  TimeScore: number;
  KeywordScore: number;
  PluginScore: number;
  TotalScore: number;
}

// mergeSearchResults 智能合并搜索结果，去重并保留最完整的信息
export function mergeSearchResults(existing: SearchResult[], newResults: SearchResult[]): SearchResult[] {
  // 使用map进行去重和合并，以UniqueID作为唯一标识
  const resultMap: Map<string, SearchResult> = new Map<string, SearchResult>();
  
  // 先添加现有结果
  for (const result of existing) {
    const key: string = generateResultKey(result);
    resultMap.set(key, result);
  }
  
  // 合并新结果，如果UniqueID相同则选择信息更完整的
  for (const newResult of newResults) {
    const key: string = generateResultKey(newResult);
    if (resultMap.has(key)) {
      // 选择信息更完整的结果
      const existingResult: SearchResult = resultMap.get(key)!;
      resultMap.set(key, selectBetterResult(existingResult, newResult));
    } else {
      // 新结果，直接添加
      resultMap.set(key, newResult);
    }
  }
  
  // 转换回切片
  const merged: SearchResult[] = [];
  for (const result of resultMap.values()) {
    merged.push(result);
  }
  
  // 按时间排序（最新的在前）
  merged.sort((a, b) => {
    return b.Datetime.getTime() - a.Datetime.getTime();
  });
  
  return merged;
}

// generateResultKey 生成结果的唯一标识键
function generateResultKey(result: SearchResult): string {
  // 使用UniqueID作为主要标识，如果没有则使用MessageID，最后使用标题
  if (result.UniqueID) {
    return result.UniqueID;
  }
  if (result.MessageID) {
    return result.MessageID;
  }
  return `title_${result.Title}_${result.Channel}`;
}

// selectBetterResult 选择信息更完整的结果
function selectBetterResult(existing: SearchResult, newResult: SearchResult): SearchResult {
  // 计算信息完整度得分
  const existingScore: number = calculateCompletenessScore(existing);
  const newScore: number = calculateCompletenessScore(newResult);
  
  if (newScore > existingScore) {
    return newResult;
  }
  return existing;
}

// calculateCompletenessScore 计算结果信息的完整度得分
function calculateCompletenessScore(result: SearchResult): number {
  let score: number = 0;
  
  // 有UniqueID加分
  if (result.UniqueID) {
    score += 10;
  }
  
  // 有链接信息加分
  if (result.Links && result.Links.length > 0) {
    score += 5;
    // 每个链接额外加分
    score += result.Links.length;
  }
  
  // 有内容加分
  if (result.Content) {
    score += 3;
  }
  
  // 标题长度加分（更详细的标题）
  score += Math.floor(result.Title.length / 10);
  
  // 有频道信息加分
  if (result.Channel) {
    score += 2;
  }
  
  // 有标签加分
  score += result.Tags ? result.Tags.length : 0;
  
  return score;
}

// SearchService 搜索服务
export class SearchService {
  private pluginManager: PluginManager;

  // NewSearchService 创建搜索服务实例并确保缓存可用
  static NewSearchService(pluginManager: PluginManager): SearchService {
    // 检查缓存是否已初始化，如果未初始化则尝试重新初始化
    if (!cacheInitialized && AppConfig && AppConfig.CacheEnabled) {
      try {
        // 这里需要根据实际的缓存初始化逻辑进行调整
        cacheInitialized = true;
      } catch {
        cacheInitialized = false;
      }
    }
    
    // 将主缓存注入到异步插件中
    // injectMainCacheToAsyncPlugins(pluginManager, enhancedTwoLevelCache);
    
    // 确保缓存写入管理器设置了主缓存更新函数
    if (globalCacheWriteManager && enhancedTwoLevelCache) {
      globalCacheWriteManager.SetMainCacheUpdater((key: string, data: any, ttl: number) => {
        return enhancedTwoLevelCache!.SetBothLevels(key, data, ttl);
      });
    }

    return new SearchService(pluginManager);
  }

  // 构造函数
  constructor(pluginManager: PluginManager) {
    this.pluginManager = pluginManager;
  }

  // injectMainCacheToAsyncPlugins 将主缓存系统注入到异步插件中
  private injectMainCacheToAsyncPlugins(pluginManager: PluginManager, mainCache: EnhancedTwoLevelCache | null): void {
    // 如果缓存或插件管理器不可用，直接返回
    if (!mainCache || !pluginManager) {
      return;
    }
    
    // 设置全局序列化器，确保异步插件与主程序使用相同的序列化格式
    const serializer = mainCache.GetSerializer();
    if (serializer) {
      // plugin.SetGlobalCacheSerializer(serializer);
    }
    
    // 创建缓存更新函数（支持IsFinal参数）- 接收原始数据并与现有缓存合并
    const cacheUpdater = async (key: string, newResults: SearchResult[], ttl: number, isFinal: boolean, keyword: string, pluginName: string): Promise<Error | null> => {
      // 优化：如果新结果为空，跳过缓存更新（避免无效操作）
      if (newResults.length === 0) {
        return null;
      }
      
      // 获取现有缓存数据进行合并
      let finalResults: SearchResult[];
      if (mainCache) {
        const [existingData, hit, err] = await mainCache.Get(key);
        if (!err && hit) {
          try {
            const existingResults: SearchResult[] = await mainCache.GetSerializer().Deserialize(existingData!);
            // 合并新旧结果，去重保留最完整的数据
            finalResults = mergeSearchResults(existingResults, newResults);
            if (AppConfig && AppConfig.AsyncLogEnabled) {
              if (keyword) {
                console.log(`🔄 [${pluginName}:${keyword}] 更新缓存| 原有: ${existingResults.length} + 新增: ${newResults.length} = 合并后: ${finalResults.length}`);
              }
            }
          } catch (err) {
            // 反序列化失败，使用新结果
            finalResults = newResults;
            if (AppConfig && AppConfig.AsyncLogEnabled) {
              const displayKey = key.substring(0, 8) + '...';
              if (keyword) {
                console.log(`[异步插件 ${pluginName}] 缓存反序列化失败，使用新结果: ${displayKey}(关键词:${keyword}) | 结果数: ${newResults.length}`);
              } else {
                console.log(`[异步插件 ${pluginName}] 缓存反序列化失败，使用新结果: ${key} | 结果数: ${newResults.length}`);
              }
            }
          }
        } else {
          // 无现有缓存，直接使用新结果
          finalResults = newResults;
          if (AppConfig && AppConfig.AsyncLogEnabled) {
            const displayKey = key.substring(0, 8) + '...';
            if (keyword) {
              console.log(`[异步插件 ${pluginName}] 初始缓存创建: ${displayKey}(关键词:${keyword}) | 结果数: ${newResults.length}`);
            } else {
              console.log(`[异步插件 ${pluginName}] 初始缓存创建: ${key} | 结果数: ${newResults.length}`);
            }
          }
        }
      } else {
        finalResults = newResults;
      }
      
      // 序列化合并后的结果
      let data: Buffer;
      try {
        data = await mainCache!.GetSerializer().Serialize(finalResults);
      } catch (err) {
        console.log(`[缓存更新] 序列化失败: ${key} | 错误: ${err}`);
        return err as Error;
      }
      
      // 先更新内存缓存（立即可见）
      try {
        await mainCache!.SetMemoryOnly(key, data, ttl);
      } catch (err) {
        return new Error(`内存缓存更新失败: ${err}`);
      }
      
      // 使用新的缓存写入管理器处理磁盘写入（智能批处理）
      if (globalCacheWriteManager) {
        const operation: CacheOperation = {
          Key: key,
          Data: finalResults,      // 使用原始数据而不是序列化后的
          TTL: ttl,
          IsFinal: isFinal,
          PluginName: pluginName,
          Keyword: keyword,
          Priority: 2,                 // 中等优先级
          Timestamp: new Date(),
          DataSize: data.length,         // 序列化后的数据大小
        };
        
        // 根据是否为最终结果设置优先级
        if (isFinal) {
          operation.Priority = 1;           // 高优先级
        }
        
        return await globalCacheWriteManager.HandleCacheOperation(operation);
      }
      
      // 兜底：如果缓存写入管理器不可用，使用原有逻辑
      if (isFinal) {
        return await mainCache!.SetBothLevels(key, data, ttl);
      } else {
        return null; // 内存已更新，磁盘稍后批处理
      }
    };
    
    // 获取所有插件
    const plugins = pluginManager.GetPlugins();
    
    // 遍历所有插件，找出异步插件
    for (const p of plugins) {
      // 检查插件是否实现了SetMainCacheUpdater方法
      if (typeof (p as any).SetMainCacheUpdater === 'function') {
        // 为每个插件创建专门的缓存更新函数，绑定插件名称
        const pluginName = p.Name();
        const pluginCacheUpdater = async (key: string, newResults: SearchResult[], ttl: number, isFinal: boolean, keyword: string): Promise<Error | null> => {
          return await cacheUpdater(key, newResults, ttl, isFinal, keyword, pluginName);
        };
        // 注入缓存更新函数
        (p as any).SetMainCacheUpdater(pluginCacheUpdater);
      }
    }
  }

  // Search 执行搜索
  async Search(keyword: string, channels: string[], concurrency: number, forceRefresh: boolean, resultType: string, sourceType: string, plugins: string[], cloudTypes: string[], ext: Record<string, any>): Promise<SearchResponse> {
    // 确保ext不为nil
    if (!ext) {
      ext = {};
    }
    
    // 参数预处理
    // 源类型标准化
    if (!sourceType) {
      sourceType = 'all';
    }

    // 插件参数规范化处理
    if (sourceType === 'tg') {
      // 对于只搜索Telegram的请求，忽略插件参数
      plugins = null;
    } else if (sourceType === 'all' || sourceType === 'plugin') {
      // 检查是否为空列表或只包含空字符串
      if (!plugins || plugins.length === 0) {
        plugins = null;
      } else {
        // 检查是否有非空元素
        let hasNonEmpty: boolean = false;
        for (const p of plugins) {
          if (p) {
            hasNonEmpty = true;
            break;
          }
        }

        // 如果全是空字符串，视为未指定
        if (!hasNonEmpty) {
          plugins = null;
        } else {
          // 检查是否包含所有插件
          const allPlugins = this.pluginManager.GetPlugins();
          const allPluginNames: string[] = [];
          for (const p of allPlugins) {
            allPluginNames.push(p.Name().toLowerCase());
          }

          // 创建请求的插件名称集合（忽略空字符串）
          const requestedPlugins: string[] = [];
          for (const p of plugins) {
            if (p) {
              requestedPlugins.push(p.toLowerCase());
            }
          }

          // 如果请求的插件数量与所有插件数量相同，检查是否包含所有插件
          if (requestedPlugins.length === allPluginNames.length) {
            // 创建映射以便快速查找
            const pluginMap: Map<string, boolean> = new Map<string, boolean>();
            for (const p of requestedPlugins) {
              pluginMap.set(p, true);
            }

            // 检查是否包含所有插件
            let allIncluded: boolean = true;
            for (const name of allPluginNames) {
              if (!pluginMap.has(name)) {
                allIncluded = false;
                break;
              }
            }

            // 如果包含所有插件，统一设为nil
            if (allIncluded) {
              plugins = null;
            }
          }
        }
      }
    }
    
    // 如果未指定并发数，使用配置中的默认值
    if (concurrency <= 0) {
      concurrency = AppConfig.DefaultConcurrency;
    }

    // 并行获取TG搜索和插件搜索结果
    let tgResults: SearchResult[] = [];
    let pluginResults: SearchResult[] = [];
    
    // 定义错误变量
    let tgErr: Error | null = null;
    let pluginErr: Error | null = null;

    // 使用Promise.all并行执行
    const promises: Promise<void>[] = [];

    // 如果需要搜索TG
    if (sourceType === 'all' || sourceType === 'tg') {
      promises.push(this.searchTG(keyword, channels, forceRefresh).then(results => {
        tgResults = results;
      }).catch(err => {
        tgErr = err;
      }));
    }

    // 如果需要搜索插件（且插件功能已启用）
    if ((sourceType === 'all' || sourceType === 'plugin') && AppConfig.AsyncPluginEnabled) {
      promises.push(this.searchPlugins(keyword, plugins, forceRefresh, concurrency, ext).then(results => {
        pluginResults = results;
      }).catch(err => {
        pluginErr = err;
      }));
    }

    // 等待所有搜索完成
    await Promise.all(promises);
    
    // 检查错误
    if (tgErr) {
      throw tgErr;
    }
    if (pluginErr) {
      throw pluginErr;
    }
    
    // 合并结果
    const allResults = mergeSearchResults(tgResults, pluginResults);

    // 按照优化后的规则排序结果
    sortResultsByTimeAndKeywords(allResults);

    // 过滤结果，只保留有时间的结果或包含优先关键词的结果或高等级插件结果到Results中
    const filteredForResults: SearchResult[] = [];
    for (const result of allResults) {
      const source = getResultSource(result);
      const pluginLevel = getPluginLevelBySource(source);
      
      // 有时间的结果或包含优先关键词的结果或高等级插件(1-2级)结果保留在Results中
      if (result.Datetime.getTime() > 0 || getKeywordPriority(result.Title) > 0 || pluginLevel <= 2) {
        filteredForResults.push(result);
      }
    }

    // 合并链接按网盘类型分组（使用所有过滤后的结果）
    const mergedLinks = mergeResultsByType(allResults, keyword, cloudTypes);

    // 构建响应
    let total: number;
    if (resultType === 'merged_by_type') {
      // 计算所有类型链接的总数
      total = 0;
      for (const links of Object.values(mergedLinks)) {
        total += links.length;
      }
    } else {
      // 只计算filteredForResults的数量
      total = filteredForResults.length;
    }

    const response: SearchResponse = {
      Total: total,
      Results: filteredForResults, // 使用进一步过滤的结果
      MergedByType: mergedLinks,
    };

    // 根据resultType过滤返回结果
    return filterResponseByType(response, resultType);
  }

  // searchChannel 搜索单个频道
  private async searchChannel(keyword: string, channel: string): Promise<SearchResult[]> {
    // 构建搜索URL
    const searchUrl = util.BuildSearchURL(channel, keyword, '');

    // 使用全局HTTP客户端（已配置代理）
    const client = util.GetHTTPClient();

    // 创建一个带超时的请求
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('搜索超时'));
      }, 4000);

      const req = (searchUrl.startsWith('https') ? https : http).get(searchUrl, (resp) => {
        clearTimeout(timeout);
        let data = '';

        resp.on('data', (chunk) => {
          data += chunk;
        });

        resp.on('end', () => {
          try {
            // 解析响应
            const [results, _, err] = util.ParseSearchResults(data, channel);
            if (err) {
              reject(err);
            } else {
              resolve(results);
            }
          } catch (err) {
            reject(err);
          }
        });
      });

      req.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  // searchTG 搜索TG频道
  private async searchTG(keyword: string, channels: string[], forceRefresh: boolean): Promise<SearchResult[]> {
    // 生成缓存键
    const cacheKey = cache.GenerateTGCacheKey(keyword, channels);
    
    // 如果未启用强制刷新，尝试从缓存获取结果
    if (!forceRefresh && cacheInitialized && AppConfig.CacheEnabled) {
      if (enhancedTwoLevelCache) {
        const [data, hit, err] = await enhancedTwoLevelCache.Get(cacheKey);
        
        if (!err && hit) {
          try {
            const results = await enhancedTwoLevelCache.GetSerializer().Deserialize(data!);
            // 直接返回缓存数据，不检查新鲜度
            return results;
          } catch {
            // 反序列化失败，继续执行搜索
          }
        }
      }
    }
    
    // 缓存未命中或强制刷新，执行实际搜索
    let results: SearchResult[] = [];
    
    // 使用工作池并行搜索多个频道
    const tasks: Task[] = [];
    
    for (const channel of channels) {
      tasks.push(async () => {
        try {
          const channelResults = await this.searchChannel(keyword, channel);
          return channelResults;
        } catch {
          return null;
        }
      });
    }
    
    // 执行搜索任务并获取结果
    const taskResults = await WorkerPool.ExecuteBatchWithTimeout(tasks, channels.length, AppConfig.PluginTimeout);
    
    // 合并所有频道的结果
    for (const result of taskResults) {
      if (result) {
        results = results.concat(result as SearchResult[]);
      }
    }
    
    // 异步缓存结果
    if (cacheInitialized && AppConfig.CacheEnabled) {
      setTimeout(async () => {
        const ttl = AppConfig.CacheTTLMinutes * 60 * 1000; // 转换为毫秒
        
        if (enhancedTwoLevelCache) {
          try {
            const data = await enhancedTwoLevelCache.GetSerializer().Serialize(results);
            await enhancedTwoLevelCache.Set(cacheKey, data, ttl);
          } catch {
            // 缓存失败，忽略
          }
        }
      }, 0);
    }
    
    return results;
  }

  // searchPlugins 搜索插件
  private async searchPlugins(keyword: string, plugins: string[], forceRefresh: boolean, concurrency: number, ext: Record<string, any>): Promise<SearchResult[]> {
    // 确保ext不为nil
    if (!ext) {
      ext = {};
    }

    // 关键：将forceRefresh同步到插件ext["refresh"]
    if (forceRefresh) {
      ext["refresh"] = true;
    }
    
    // 生成缓存键
    const cacheKey = cache.GeneratePluginCacheKey(keyword, plugins);
    
    // 如果未启用强制刷新，尝试从缓存获取结果
    if (!forceRefresh && cacheInitialized && AppConfig.CacheEnabled) {
      if (enhancedTwoLevelCache) {
        const [data, hit, err] = await enhancedTwoLevelCache.Get(cacheKey);
        
        if (!err && hit) {
          try {
            const results = await enhancedTwoLevelCache.GetSerializer().Deserialize(data!);
            // 返回缓存数据
            console.log(`✅ [${keyword}] 命中缓存 结果数: ${results.length}`);
            return results;
          } catch (err) {
            const displayKey = cacheKey.substring(0, 8) + '...';
            console.log(`[主服务] 缓存反序列化失败: ${displayKey}(关键词:${keyword}) | 错误: ${err}`);
          }
        }
      }
    }
    
    // 缓存未命中或强制刷新，执行实际搜索
    
    // 获取所有可用插件
    let availablePlugins: AsyncSearchPlugin[] = [];
    if (this.pluginManager) {
      const allPlugins = this.pluginManager.GetPlugins();
      
      // 确保plugins不为nil并且有非空元素
      const hasPlugins = plugins && plugins.length > 0;
      let hasNonEmptyPlugin = false;
      
      if (hasPlugins) {
        for (const p of plugins) {
          if (p) {
            hasNonEmptyPlugin = true;
            break;
          }
        }
      }
      
      // 只有当plugins数组包含非空元素时才进行过滤
      if (hasPlugins && hasNonEmptyPlugin) {
        const pluginMap: Map<string, boolean> = new Map<string, boolean>();
        for (const p of plugins) {
          if (p) { // 忽略空字符串
            pluginMap.set(p.toLowerCase(), true);
          }
        }
        
        for (const p of allPlugins) {
          if (pluginMap.has(p.Name().toLowerCase())) {
            availablePlugins.push(p);
          }
        }
      } else {
        // 如果plugins为nil、空数组或只包含空字符串，视为未指定，使用所有插件
        availablePlugins = allPlugins;
      }
    }
    
    // 控制并发数
    if (concurrency <= 0) {
      // 使用配置中的默认值
      concurrency = AppConfig.DefaultConcurrency;
    }
    
    // 使用工作池执行并行搜索
    const tasks: Task[] = [];
    for (const p of availablePlugins) {
      tasks.push(async () => {
        // 设置主缓存键和当前关键词
        p.SetMainCacheKey(cacheKey);
        p.SetCurrentKeyword(keyword);
        
        // 调用异步插件的AsyncSearch方法
        try {
          const results = await p.AsyncSearch(keyword, async (client: any, kw: string, extParams: Record<string, any>) => {
            // 使用插件的Search方法作为搜索函数
            return await (p as any).Search(kw, extParams);
          });
          return results;
        } catch {
          return null;
        }
      });
    }

    // 执行任务并合并结果
    const taskResults = await WorkerPool.ExecuteBatchWithTimeout(tasks, concurrency, AppConfig.PluginTimeout);
    
    let finalResults: SearchResult[] = [];
    for (const result of taskResults) {
      if (result) {
        finalResults = finalResults.concat(result as SearchResult[]);
      }
    }

    // 异步缓存结果
    if (cacheInitialized && AppConfig.CacheEnabled) {
      setTimeout(async () => {
        const ttl = AppConfig.CacheTTLMinutes * 60 * 1000; // 转换为毫秒
        
        if (enhancedTwoLevelCache) {
          try {
            const data = await enhancedTwoLevelCache.GetSerializer().Serialize(finalResults);
            await enhancedTwoLevelCache.Set(cacheKey, data, ttl);
          } catch {
            // 缓存失败，忽略
          }
        }
      }, 0);
    }

    return finalResults;
  }
}

// filterResponseByType 根据结果类型过滤响应
function filterResponseByType(response: SearchResponse, resultType: string): SearchResponse {
  switch (resultType) {
    case 'merged_by_type':
      // 只返回MergedByType，Results设为nil
      return {
        Total: response.Total,
        MergedByType: response.MergedByType,
        Results: null,
      };
    case 'all':
      return response;
    case 'results':
      // 只返回Results
      return {
        Total: response.Total,
        Results: response.Results,
      };
    default:
      // 默认返回MergedByType
      return {
        Total: response.Total,
        MergedByType: response.MergedByType,
        Results: null,
      };
  }
}

// 根据时间和关键词排序结果
function sortResultsByTimeAndKeywords(results: SearchResult[]): void {
  // 1. 计算每个结果的综合得分
  const scores: ResultScore[] = [];
  
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const source = getResultSource(result);
    
    scores.push({
      Result: result,
      TimeScore: calculateTimeScore(result.Datetime),
      KeywordScore: getKeywordPriority(result.Title),
      PluginScore: getPluginLevelScore(source),
      TotalScore: 0, // 稍后计算
    });
    
    // 计算综合得分
    scores[i].TotalScore = scores[i].TimeScore + 
                          scores[i].KeywordScore + 
                          scores[i].PluginScore;
  }
  
  // 2. 按综合得分排序
  scores.sort((a, b) => {
    return b.TotalScore - a.TotalScore;
  });
  
  // 3. 更新原数组
  for (let i = 0; i < scores.length; i++) {
    results[i] = scores[i].Result;
  }
}

// 计算时间得分
function calculateTimeScore(datetime: Date): number {
  if (!datetime || datetime.getTime() === 0) {
    return 0;
  }
  
  const now = new Date();
  const diff = now.getTime() - datetime.getTime();
  const days = diff / (1000 * 60 * 60 * 24);
  
  // 时间越近得分越高
  if (days < 1) {
    return 100;
  } else if (days < 7) {
    return 80;
  } else if (days < 30) {
    return 60;
  } else if (days < 90) {
    return 40;
  } else {
    return 20;
  }
}

// 获取标题中包含优先关键词的优先级
function getKeywordPriority(title: string): number {
  const lowerTitle = title.toLowerCase();
  for (let i = 0; i < priorityKeywords.length; i++) {
    const keyword = priorityKeywords[i];
    if (lowerTitle.includes(keyword)) {
      // 返回优先级得分（数组索引越小，优先级越高，最高400分）
      return (priorityKeywords.length - i) * 70;
    }
  }
  return 0;
}

// 获取插件等级得分
function getPluginLevelScore(source: string): number {
  // 这里需要根据实际的插件等级系统进行调整
  // 暂时返回默认值
  return 0;
}

// 获取结果来源
function getResultSource(result: SearchResult): string {
  if (result.Channel) {
    // 来自TG频道
    return `tg:${result.Channel}`;
  } else if (result.UniqueID && result.UniqueID.includes('-')) {
    // 来自插件：UniqueID格式通常为 "插件名-ID"
    const parts = result.UniqueID.split('-');
    if (parts.length >= 1) {
      return `plugin:${parts[0]}`;
    }
  }
  // 无法确定来源，使用默认值
  return 'unknown';
}

// 根据来源获取插件等级
function getPluginLevelBySource(source: string): number {
  // 这里需要根据实际的插件等级系统进行调整
  // 暂时返回默认值
  return 3;
}

// extractLinkTitlePairs 用于从消息内容中提取链接-标题对应关系的函数
function extractLinkTitlePairs(content: string): Record<string, string> {
  // 首先尝试使用换行符分割的方法
  if (content.includes('\n')) {
    return extractLinkTitlePairsWithNewlines(content);
  }
  
  // 如果没有换行符，使用正则表达式直接提取
  return extractLinkTitlePairsWithoutNewlines(content);
}

// 处理有换行符的情况
function extractLinkTitlePairsWithNewlines(content: string): Record<string, string> {
  // 结果映射：链接URL -> 对应标题
  const linkTitleMap: Record<string, string> = {};
  
  // 按行分割内容
  const lines = content.split('\n');
  
  // 链接正则表达式
  const linkRegex = /https?:\/\/[^\s"']+/g;
  
  // 第一遍扫描：识别标题-链接对
  let lastTitle = '';
  let lastTitleIndex = -1;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '') {
      continue;
    }
    
    // 检查当前行是否包含链接
    const links = line.match(linkRegex) || [];
    
    if (links.length > 0) {
      // 当前行包含链接
      
      // 检查是否是标准链接行（以"链接："、"地址："等开头）
      const isStandardLinkLine = isLinkLine(line);
      
      if (isStandardLinkLine && lastTitle) {
        // 标准链接行，使用上一个标题
        for (const link of links) {
          linkTitleMap[link] = lastTitle;
        }
      } else if (!isStandardLinkLine) {
        // 非标准链接行，可能是"标题：链接"格式
        const titleFromLine = extractTitleFromLinkLine(line);
        if (titleFromLine) {
          // 是"标题：链接"格式
          for (const link of links) {
            linkTitleMap[link] = titleFromLine;
          }
        } else if (lastTitle) {
          // 其他情况，使用上一个标题
          for (const link of links) {
            linkTitleMap[link] = lastTitle;
          }
        }
      }
    } else {
      // 当前行不包含链接，可能是标题行
      // 检查下一行是否为链接行
      if (i + 1 < lines.length) {
        const nextLine = lines[i + 1].trim();
        if (isLinkLine(nextLine) || linkRegex.test(nextLine)) {
          // 下一行是链接行或包含链接，当前行很可能是标题
          lastTitle = cleanTitle(line);
          lastTitleIndex = i;
        }
      } else {
        // 最后一行，也可能是标题
        lastTitle = cleanTitle(line);
        lastTitleIndex = i;
      }
    }
  }
  
  // 第二遍扫描：处理没有匹配到标题的链接
  // 为每个链接找到最近的上文标题
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '') {
      continue;
    }
    
    const links = line.match(linkRegex) || [];
    if (links.length === 0) {
      continue;
    }
    
    for (const link of links) {
      if (!linkTitleMap[link]) {
        // 链接没有匹配到标题，尝试找最近的上文标题
        let nearestTitle = '';
        
        // 向上查找最近的标题行
        for (let j = i - 1; j >= 0; j--) {
          if (j === lastTitleIndex || (j + 1 < lines.length && 
              linkRegex.test(lines[j + 1]) && 
              !linkRegex.test(lines[j]))) {
            const candidateTitle = cleanTitle(lines[j]);
            if (candidateTitle) {
              nearestTitle = candidateTitle;
              break;
            }
          }
        }
        
        if (nearestTitle) {
          linkTitleMap[link] = nearestTitle;
        }
      }
    }
  }
  
  return linkTitleMap;
}

// 处理没有换行符的情况
function extractLinkTitlePairsWithoutNewlines(content: string): Record<string, string> {
  // 结果映射：链接URL -> 对应标题
  const linkTitleMap: Record<string, string> = {};
  
  // 使用精确的网盘链接正则表达式集合，避免贪婪匹配
  const linkPatterns = [
    util.TianyiPanPattern,  // 天翼云盘
    util.BaiduPanPattern,   // 百度网盘
    util.QuarkPanPattern,   // 夸克网盘
    util.AliyunPanPattern,  // 阿里云盘
    util.UCPanPattern,      // UC网盘
    util.Pan123Pattern,     // 123网盘
    util.Pan115Pattern,     // 115网盘
    util.XunleiPanPattern,  // 迅雷网盘
  ];
  
  // 收集所有链接及其位置
  interface LinkInfo {
    url: string;
    pos: number;
  }
  const allLinks: LinkInfo[] = [];
  
  // 使用各个精确正则表达式查找链接
  for (const pattern of linkPatterns) {
    let match;
    while ((match = pattern.exec(content)) !== null) {
      allLinks.push({ url: match[0], pos: match.index });
    }
  }
  
  // 按位置排序
  allLinks.sort((a, b) => a.pos - b.pos);
  
  // URL标准化和去重
  const uniqueLinks: Record<string, string> = {}; // 标准化URL -> 原始URL
  const links: string[] = [];
  
  for (const linkInfo of allLinks) {
    // 标准化URL（将URL编码转换为中文）
    const normalized = normalizeUrl(linkInfo.url);
    
    // 如果这个标准化URL还没有见过，则保留
    if (!uniqueLinks[normalized]) {
      uniqueLinks[normalized] = linkInfo.url;
      links.push(linkInfo.url);
    }
  }
  
  if (links.length === 0) {
    return linkTitleMap;
  }
  
  // 使用链接位置分割内容
  const segments: string[] = [];
  let lastPos = 0;
  
  // 查找每个链接的位置，并提取链接前的文本作为段落
  for (let i = 0; i < links.length; i++) {
    const link = links[i];
    const idx = content.indexOf(link, lastPos);
    if (idx === -1) {
      // 链接在content中不存在，跳过
      continue;
    }
    const pos = idx;
    if (pos > lastPos) {
      segments[i] = content.substring(lastPos, pos);
    }
    lastPos = pos + link.length;
  }
  
  // 最后一段
  if (lastPos < content.length) {
    segments[links.length] = content.substring(lastPos);
  }
  
  // 从每个段落中提取标题
  for (let i = 0; i < links.length; i++) {
    const link = links[i];
    // 当前链接的标题应该在当前段落的末尾
    let title = '';
    
    // 如果是第一个链接
    if (i === 0) {
      // 提取第一个段落作为标题
      title = extractTitleBeforeLink(segments[i]);
    } else {
      // 从上一个链接后的文本中提取标题
      title = extractTitleBeforeLink(segments[i]);
    }
    
    // 如果提取到了标题，保存链接-标题对应关系
    if (title) {
      linkTitleMap[link] = title;
    }
  }
  
  return linkTitleMap;
}

// 从文本中提取链接前的标题
function extractTitleBeforeLink(text: string): string {
  // 移除可能的链接前缀词
  const trimmedText = text.trim();
  
  // 查找"链接："前的文本作为标题
  const linkIndex = trimmedText.indexOf('链接：');
  if (linkIndex > 0) {
    return cleanTitle(trimmedText.substring(0, linkIndex));
  }
  
  // 尝试匹配常见的标题模式
  const titlePattern = /([^链地资网\s]+?(?:\([^)]+\))?(?:\s*\d+K)?(?:\s*臻彩)?(?:\s*MAX)?(?:\s*HDR)?(?:\s*更(?:新)?\d+集))$/;
  const matches = trimmedText.match(titlePattern);
  if (matches && matches.length > 1) {
    return cleanTitle(matches[1]);
  }
  
  return cleanTitle(trimmedText);
}

// 判断一行是否为链接行（主要包含链接的行）
function isLinkLine(line: string): boolean {
  const lowerLine = line.toLowerCase();
  return lowerLine.startsWith('链接：') || 
         lowerLine.startsWith('地址：') ||
         lowerLine.startsWith('资源地址：') ||
         lowerLine.startsWith('网盘：') ||
         lowerLine.startsWith('网盘地址：') ||
         lowerLine.startsWith('链接:');
}

// 从链接行中提取可能的标题
function extractTitleFromLinkLine(line: string): string {
  // 处理"标题：链接"格式
  const parts = line.split('：', 2);
  if (parts.length === 2 && !parts[0].includes('http') &&
      !isLinkPrefix(parts[0])) {
    return cleanTitle(parts[0]);
  }
  
  // 处理"标题:链接"格式（半角冒号）
  const parts2 = line.split(':', 2);
  if (parts2.length === 2 && !parts2[0].includes('http') &&
      !isLinkPrefix(parts2[0])) {
    return cleanTitle(parts2[0]);
  }
  
  return '';
}

// 判断是否为链接前缀词（包括网盘名称）
function isLinkPrefix(text: string): boolean {
  const lowerText = text.toLowerCase().trim();
  
  // 标准链接前缀词
  if (lowerText === '链接' || 
     lowerText === '地址' || 
     lowerText === '资源地址' || 
     lowerText === '网盘' || 
     lowerText === '网盘地址') {
    return true;
  }
  
  // 网盘名称（防止误将网盘名称当作标题）
  const cloudDiskNames = [
    // 夸克网盘
    '夸克', '夸克网盘', 'quark', '夸克云盘',
    
    // 百度网盘
    '百度', '百度网盘', 'baidu', '百度云', 'bdwp', 'bdpan',
    
    // 迅雷网盘
    '迅雷', '迅雷网盘', 'xunlei', '迅雷云盘',
    
    // 115网盘
    '115', '115网盘', '115云盘',
    
    // 123网盘
    '123', '123pan', '123网盘', '123云盘',
    
    // 阿里云盘
    '阿里', '阿里云', '阿里云盘', 'aliyun', 'alipan', '阿里网盘',
    
    // 天翼云盘
    '天翼', '天翼云', '天翼云盘', 'tianyi', '天翼网盘',
    
    // UC网盘
    'uc', 'uc网盘', 'uc云盘',
    
    // 移动云盘
    '移动', '移动云', '移动云盘', 'caiyun', '彩云',
    
    // PikPak
    'pikpak', 'pikpak网盘',
  ];
  
  for (const name of cloudDiskNames) {
    if (lowerText === name) {
      return true;
    }
  }
  
  return false;
}

// 清理标题文本
function cleanTitle(title: string): string {
  // 移除常见的无关前缀
  let cleanedTitle = title.trim();
  cleanedTitle = cleanedTitle.replace(/^名称：/, '');
  cleanedTitle = cleanedTitle.replace(/^标题：/, '');
  cleanedTitle = cleanedTitle.replace(/^片名：/, '');
  cleanedTitle = cleanedTitle.replace(/^名称:/, '');
  cleanedTitle = cleanedTitle.replace(/^标题:/, '');
  cleanedTitle = cleanedTitle.replace(/^片名:/, '');
  
  // 移除表情符号和特殊字符
  cleanedTitle = cleanedTitle.replace(/[\p{So}\p{Sk}]/gu, '');
  
  return cleanedTitle.trim();
}

// 判断一行是否为空或只包含空白字符
function isEmpty(line: string): boolean {
  return line.trim() === '';
}

// 将搜索结果按网盘类型分组
function mergeResultsByType(results: SearchResult[], keyword: string, cloudTypes: string[]): MergedLinks {
  // 创建合并结果的映射
  const mergedLinks: MergedLinks = {};

  // 用于去重的映射，键为URL
  const uniqueLinks: Record<string, MergedLink> = {};

  // 将关键词转为小写，用于不区分大小写的匹配
  const lowerKeyword = keyword.toLowerCase();

  // 遍历所有搜索结果
  for (const result of results) {
    // 提取消息中的链接-标题对应关系
    const linkTitleMap = extractLinkTitlePairs(result.Content);
    
    // 如果没有从内容中提取到标题，尝试直接从内容中匹配
    if (Object.keys(linkTitleMap).length === 0 && result.Links && result.Links.length > 0 && !result.Content.includes('\n')) {
      // 这是没有换行符的情况，尝试直接匹配
      const content = result.Content;
      
      // 支持多种网盘链接前缀
      const linkPrefixes = ['天翼链接：', '百度链接：', '夸克链接：', '阿里链接：', 'UC链接：', '115链接：', '迅雷链接：', '123链接：', '链接：'];
      
      let parts: string[] = [];
      
      // 尝试找到匹配的前缀
      for (const prefix of linkPrefixes) {
        if (content.includes(prefix)) {
          parts = content.split(prefix);
          break;
        }
      }
      
      // 如果找到了匹配的前缀并且分割成功
      if (parts.length > 1 && result.Links.length <= parts.length - 1) {
        // 第一部分是第一个标题
        const titles: string[] = [];
        titles.push(cleanTitle(parts[0]));
        
        // 处理每个包含链接的部分，提取标题
        for (let i = 1; i < parts.length - 1; i++) {
          const part = parts[i];
          // 找到链接的结束位置，使用更通用的分隔符
          let linkEnd = -1;
          for (let j = 0; j < part.length; j++) {
            const c = part[j];
            // 扩展分隔符列表，包含更多可能的字符
            if (c === ' ' || c === '窃' || c === '东' || c === '迎' || c === '千' || c === '我' || c === '恋' || c === '将' || c === '野' || 
               c === '合' || c === '集' || c === '天' || c === '翼' || c === '网' || c === '盘' || c === '(' || c === '（') {
              linkEnd = j;
              break;
            }
          }
          
          if (linkEnd > 0) {
            // 提取标题
            const title = cleanTitle(part.substring(linkEnd));
            titles.push(title);
          }
        }
        
        // 将标题与链接关联
        for (let i = 0; i < result.Links.length; i++) {
          const link = result.Links[i];
          if (i < titles.length) {
            linkTitleMap[link.URL] = titles[i];
          }
        }
      }
    }
    
    for (const link of result.Links) {
      // 优先使用链接的WorkTitle字段，如果为空则回退到传统方式
      let title = result.Title; // 默认使用消息标题
      
      if (link.WorkTitle) {
        // 如果链接有WorkTitle字段，优先使用
        title = link.WorkTitle;
      } else {
        // 如果没有WorkTitle，使用传统方式从映射中获取该链接对应的标题
        // 查找完全匹配的链接
        if (linkTitleMap[link.URL] && linkTitleMap[link.URL] !== '') {
          title = linkTitleMap[link.URL]; // 如果找到特定标题，则使用它
        } else {
          // 如果没有找到完全匹配的链接，尝试查找前缀匹配的链接
          for (const mappedLink in linkTitleMap) {
            if (linkTitleMap.hasOwnProperty(mappedLink) && link.URL.startsWith(mappedLink)) {
              title = linkTitleMap[mappedLink];
              break;
            }
          }
        }
      }
      
      // 检查插件是否需要跳过Service层过滤
      let skipKeywordFilter = false;
      if (result.UniqueID && result.UniqueID.includes('-')) {
        const parts = result.UniqueID.split('-', 2);
        if (parts.length >= 1) {
          const pluginName = parts[0];
          // 通过插件注册表动态获取过滤设置
          // 这里需要根据实际的插件管理系统进行调整
        }
      }
      
      // 关键词过滤：现在我们有了准确的链接-标题对应关系，只需检查每个链接的具体标题
      if (!skipKeywordFilter && keyword) {
        // 只检查链接的具体标题，无论是TG来源还是插件来源
        if (!title.toLowerCase().includes(lowerKeyword)) {
          continue;
        }
      }
      
      // 确定数据来源
      let source = '';
      if (result.Channel) {
        // 来自TG频道
        source = `tg:${result.Channel}`;
      } else if (result.UniqueID && result.UniqueID.includes('-')) {
        // 来自插件：UniqueID格式通常为 "插件名-ID"
        const parts = result.UniqueID.split('-', 2);
        if (parts.length >= 1) {
          source = `plugin:${parts[0]}`;
        }
      } else {
        // 无法确定来源，使用默认值
        source = 'unknown';
      }
      
      // 赋值给Note前，支持多个关键词裁剪
      title = util.CutTitleByKeywords(title, ['简介', '描述']);
      
      // 优先使用链接自己的时间，如果没有则使用搜索结果的时间
      let linkDatetime = result.Datetime;
      if (link.Datetime && link.Datetime.getTime() > 0) {
        linkDatetime = link.Datetime;
      }
      
      const mergedLink: MergedLink = {
        URL: link.URL,
        Password: link.Password,
        Note: title, // 使用找到的特定标题
        Datetime: linkDatetime,
        Source: source, // 添加数据来源字段
        Images: result.Images, // 添加TG消息中的图片链接
      };

      // 检查是否已存在相同URL的链接
      if (uniqueLinks[link.URL]) {
        // 如果已存在，只有当当前链接的时间更新时才替换
        if (mergedLink.Datetime.getTime() > uniqueLinks[link.URL].Datetime.getTime()) {
          uniqueLinks[link.URL] = mergedLink;
        }
      } else {
        // 如果不存在，直接添加
        uniqueLinks[link.URL] = mergedLink;
      }
    }
  }

  // 为保持排序顺序，按原始results顺序处理链接，而不是随机遍历map
  // 创建一个有序的链接列表，按原始results中的顺序
  const orderedLinks: MergedLink[] = [];
  const linkTypeMap: Record<string, string> = {}; // URL -> Type的映射
  
  // 按原始results的顺序收集唯一链接
  for (const result of results) {
    for (const link of result.Links) {
      if (uniqueLinks[link.URL]) {
        // 检查是否已经添加过这个链接
        let found = false;
        for (const existing of orderedLinks) {
          if (existing.URL === link.URL) {
            found = true;
            break;
          }
        }
        if (!found) {
          orderedLinks.push(uniqueLinks[link.URL]);
          linkTypeMap[link.URL] = link.Type;
        }
      }
    }
  }
  
  // 将有序链接按类型分组
  for (const mergedLink of orderedLinks) {
    // 从预建的映射中获取链接类型
    let linkType = linkTypeMap[mergedLink.URL];
    if (!linkType) {
      linkType = 'unknown';
    }

    // 添加到对应类型的列表中
    if (!mergedLinks[linkType]) {
      mergedLinks[linkType] = [];
    }
    mergedLinks[linkType].push(mergedLink);
  }

  // 如果指定了cloudTypes，则过滤结果
  if (cloudTypes && cloudTypes.length > 0) {
    // 创建过滤后的结果映射
    const filteredLinks: MergedLinks = {};
    
    // 将cloudTypes转换为map以提高查找性能
    const allowedTypes: Record<string, boolean> = {};
    for (const cloudType of cloudTypes) {
      allowedTypes[cloudType.toLowerCase().trim()] = true;
    }
    
    // 只保留指定类型的链接
    for (const linkType in mergedLinks) {
      if (mergedLinks.hasOwnProperty(linkType)) {
        if (allowedTypes[linkType.toLowerCase()]) {
          filteredLinks[linkType] = mergedLinks[linkType];
        }
      }
    }
    
    return filteredLinks;
  }

  return mergedLinks;
}

// 导出
export { SearchService };
