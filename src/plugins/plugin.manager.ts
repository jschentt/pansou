import { Injectable } from '@nestjs/common';
import { SearchResult } from '../models/response';
import { AppConfig } from '../config/config';
import axios, { AxiosInstance } from 'axios';

// ============================================================
// 第一部分：接口定义和类型
// ============================================================

// 异步搜索插件接口
export interface AsyncSearchPlugin {
  // Name 返回插件名称
  name(): string;
  
  // Priority 返回插件优先级
  priority(): number;
  
  // AsyncSearch 异步搜索方法
  asyncSearch(
    keyword: string, 
    searchFunc: (client: AxiosInstance, keyword: string, ext: Record<string, any>) => Promise<SearchResult[]>, 
    mainCacheKey: string, 
    ext: Record<string, any>
  ): Promise<SearchResult[]>;
  
  // SetMainCacheKey 设置主缓存键
  setMainCacheKey(key: string): void;
  
  // SetCurrentKeyword 设置当前搜索关键词（用于日志显示）
  setCurrentKeyword(keyword: string): void;
  
  // Search 兼容性方法（内部调用AsyncSearch）
  search(keyword: string, ext: Record<string, any>): Promise<SearchResult[]>;
  
  // SkipServiceFilter 返回是否跳过Service层的关键词过滤
  skipServiceFilter(): boolean;
}

// 支持Web路由的插件接口
export interface PluginWithWebHandler extends AsyncSearchPlugin {
  // RegisterWebRoutes 注册Web路由
  registerWebRoutes(router: any): void;
}

// 支持延迟初始化的插件接口
export interface InitializablePlugin extends AsyncSearchPlugin {
  // Initialize 执行插件初始化
  initialize(): Promise<void>;
}

// 缓存响应结构
export interface CachedResponse {
  results: SearchResult[];
  timestamp: Date;
  complete: boolean;
  lastAccess: Date;
  accessCount: number;
}

// 缓存序列化器接口
export interface CacheSerializer {
  serialize(data: any): Promise<Buffer>;
  deserialize(data: Buffer, target: any): Promise<void>;
}

// ============================================================
// 第二部分：全局变量和注册表
// ============================================================

// 全局异步插件注册表
const globalRegistry = new Map<string, AsyncSearchPlugin>();

// API响应缓存
const apiResponseCache = new Map<string, CachedResponse>();

// 统计数据
let cacheHits = 0;
let cacheMisses = 0;
let asyncCompletions = 0;

// 初始化标志
let initialized = false;

// 默认配置值
const defaultAsyncResponseTimeout = 4000; // 4秒
const defaultPluginTimeout = 30000; // 30秒
const defaultCacheTTL = 60 * 60 * 1000; // 1小时
const defaultMaxBackgroundWorkers = 20;
const defaultMaxBackgroundTasks = 100;

// 缓存访问频率记录
const cacheAccessCount = new Map<string, number>();

// 缓存清理相关变量
let lastCleanupTime = new Date();

// 工作池
let backgroundWorkerPool: Semaphore;

// 全局序列化器引用
let globalCacheSerializer: CacheSerializer | null = null;

// 信号量实现
class Semaphore {
  private permits: number;
  private queue: (() => void)[] = [];

  constructor(permits: number) {
    this.permits = permits;
  }

  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--;
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      this.queue.push(resolve);
    });
  }

  release(): void {
    this.permits++;
    if (this.queue.length > 0) {
      const resolve = this.queue.shift()!;
      resolve();
    }
  }
}

// ============================================================
// 第三部分：插件注册和管理
// ============================================================

// 注册异步插件到全局注册表
export function registerGlobalPlugin(plugin: AsyncSearchPlugin): void {
  if (!plugin) {
    return;
  }

  const name = plugin.name();
  if (!name) {
    return;
  }

  globalRegistry.set(name, plugin);
}

// 获取所有已注册的异步插件
export function getRegisteredPlugins(): AsyncSearchPlugin[] {
  return Array.from(globalRegistry.values());
}

// 根据名称获取已注册的插件
export function getPluginByName(name: string): [AsyncSearchPlugin | null, boolean] {
  const plugin = globalRegistry.get(name);
  return [plugin || null, !!plugin];
}

@Injectable()
export class PluginManager {
  private plugins: AsyncSearchPlugin[] = [];

  // 注册异步插件
  async registerPlugin(plugin: AsyncSearchPlugin): Promise<void> {
    // 如果插件支持延迟初始化，先执行初始化
    if (this.isInitializablePlugin(plugin)) {
      try {
        await plugin.initialize();
      } catch (error) {
        console.error(`[PluginManager] 插件 ${plugin.name()} 初始化失败: ${error}，跳过注册`);
        return;
      }
    }

    this.plugins.push(plugin);
  }

  // 注册所有全局异步插件
  async registerAllGlobalPlugins(): Promise<void> {
    const allPlugins = getRegisteredPlugins();
    for (const plugin of allPlugins) {
      await this.registerPlugin(plugin);
    }
  }

  // 根据过滤器注册全局异步插件
  async registerGlobalPluginsWithFilter(enabledPlugins: string[] | null): Promise<void> {
    if (!enabledPlugins || enabledPlugins.length === 0) {
      return;
    }

    const allPlugins = getRegisteredPlugins();
    const enabledMap = new Set(enabledPlugins);

    // 只注册在启用列表中的插件
    for (const plugin of allPlugins) {
      if (enabledMap.has(plugin.name())) {
        await this.registerPlugin(plugin);
      }
    }
  }

  // 获取所有注册的异步插件
  getPlugins(): AsyncSearchPlugin[] {
    return this.plugins;
  }

  // 检查插件是否支持延迟初始化
  private isInitializablePlugin(plugin: AsyncSearchPlugin): plugin is InitializablePlugin {
    return 'initialize' in plugin;
  }
}

// ============================================================
// 第四部分：工具函数
// ============================================================

// 根据关键词过滤搜索结果的全局辅助函数
export function filterResultsByKeyword(results: SearchResult[], keyword: string): SearchResult[] {
  if (!keyword) {
    return results;
  }

  // 预估过滤后会保留80%的结果
  const filteredResults: SearchResult[] = [];

  // 将关键词转为小写，用于不区分大小写的比较
  const lowerKeyword = keyword.toLowerCase();

  // 将关键词按空格分割，用于支持多关键词搜索
  const keywords = lowerKeyword.split(/\s+/);

  for (const result of results) {
    // 将标题和内容转为小写
    const lowerTitle = result.title.toLowerCase();
    const lowerContent = result.content.toLowerCase();

    // 检查每个关键词是否在标题或内容中
    let matched = true;
    for (const kw of keywords) {
      // 对于所有关键词，检查是否在标题或内容中
      if (!lowerTitle.includes(kw) && !lowerContent.includes(kw)) {
        matched = false;
        break;
      }
    }

    if (matched) {
      filteredResults.push(result);
    }
  }

  return filteredResults;
}

// ============================================================
// 第五部分：异步插件基础设施（初始化、工作池、缓存）
// ============================================================

// 清理过期API缓存的函数
function cleanupExpiredApiCache(): void {
  const now = new Date();
  // 只有距离上次清理超过30分钟才执行
  if (now.getTime() - lastCleanupTime.getTime() < 30 * 60 * 1000) {
    return;
  }

  let cleanedCount = 0;
  let totalCount = 0;

  // 清理已过期的缓存
  for (const [key, value] of apiResponseCache.entries()) {
    totalCount++;
    const cachedResult = value;
    
    // 使用默认TTL + 30分钟宽限期
    const expireThreshold = defaultCacheTTL + 30 * 60 * 1000;
    if (now.getTime() - cachedResult.timestamp.getTime() > expireThreshold) {
      apiResponseCache.delete(key);
      cacheAccessCount.delete(key);
      cleanedCount++;
    }
  }

  lastCleanupTime = now;

  // 记录清理日志
  if (cleanedCount > 0) {
    console.log(`[Cache] 清理过期缓存: 删除 ${cleanedCount}/${totalCount} 项，释放内存`);
  }
}

// 初始化异步插件配置
function initAsyncPlugin(): void {
  if (initialized) {
    return;
  }

  // 如果配置已加载，则从配置读取工作池大小
  let maxWorkers = defaultMaxBackgroundWorkers;
  if (AppConfig?.asyncMaxBackgroundWorkers) {
    maxWorkers = AppConfig.asyncMaxBackgroundWorkers;
  }

  backgroundWorkerPool = new Semaphore(maxWorkers);

  initialized = true;
}

// 导出的初始化函数
export function initAsyncPluginSystem(): void {
  initAsyncPlugin();
}

// 检查是否可以执行新任务
function canExecuteTask(): boolean {
  // 获取最大任务数
  let maxTasks = defaultMaxBackgroundTasks;
  if (AppConfig?.asyncMaxBackgroundTasks) {
    maxTasks = AppConfig.asyncMaxBackgroundTasks;
  }

  // TODO: 实现任务数限制
  return true;
}

// 记录缓存命中
export function recordCacheHit(): void {
  cacheHits++;
}

// 记录缓存未命中
export function recordCacheMiss(): void {
  cacheMisses++;
}

// 记录异步完成
export function recordAsyncCompletion(): void {
  asyncCompletions++;
}

// 记录缓存访问次数
export function recordCacheAccess(key: string): void {
  // 更新缓存项的访问时间和计数
  if (apiResponseCache.has(key)) {
    const cachedItem = apiResponseCache.get(key)!;
    cachedItem.lastAccess = new Date();
    cachedItem.accessCount++;
    apiResponseCache.set(key, cachedItem);
  }

  // 更新全局访问计数
  if (cacheAccessCount.has(key)) {
    cacheAccessCount.set(key, cacheAccessCount.get(key)! + 1);
  } else {
    cacheAccessCount.set(key, 1);
  }

  // 触发定期清理
  setTimeout(cleanupExpiredApiCache, 0);
}

// ============================================================
// 第六部分：BaseAsyncPlugin 类
// ============================================================

// 基础异步插件类
export class BaseAsyncPlugin implements AsyncSearchPlugin {
  private nameValue: string;
  private priorityValue: number;
  private client: AxiosInstance; // 用于短超时的客户端
  private backgroundClient: AxiosInstance; // 用于长超时的客户端
  private cacheTTL: number; // 内存缓存有效期
  private mainCacheUpdater?: (key: string, results: SearchResult[], ttl: number, isFinal: boolean, keyword: string) => Promise<void>;
  mainCacheKey: string = ''; // 主缓存键
  private currentKeyword: string = ''; // 当前搜索的关键词
  private finalUpdateTracker: Map<string, boolean> = new Map(); // 追踪已更新的最终结果缓存

  constructor(name: string, priority: number, skipServiceFilter: boolean = false) {
    this.nameValue = name;
    this.priorityValue = priority;
    this.skipServiceFilterValue = skipServiceFilter;
    
    // 确保异步插件已初始化
    if (!initialized) {
      initAsyncPlugin();
    }

    // 确定超时和缓存时间
    let responseTimeout = defaultAsyncResponseTimeout;
    let processingTimeout = defaultPluginTimeout;
    let cacheTTL = defaultCacheTTL;

    // 如果配置已初始化，则使用配置中的值
    if (AppConfig?.asyncResponseTimeout) {
      responseTimeout = AppConfig.asyncResponseTimeout;
    }
    if (AppConfig?.pluginTimeout) {
      processingTimeout = AppConfig.pluginTimeout;
    }
    if (AppConfig?.asyncCacheTTLHours) {
      cacheTTL = AppConfig.asyncCacheTTLHours * 60 * 60 * 1000;
    }

    // 创建Axios实例
    this.client = axios.create({
      timeout: responseTimeout,
    });
    
    this.backgroundClient = axios.create({
      timeout: processingTimeout,
    });

    this.cacheTTL = cacheTTL;
  }

  // Name 返回插件名称
  name(): string {
    return this.nameValue;
  }

  // Priority 返回插件优先级
  priority(): number {
    return this.priorityValue;
  }

  // SetMainCacheKey 设置主缓存键
  setMainCacheKey(key: string): void {
    this.mainCacheKey = key;
  }

  // SetCurrentKeyword 设置当前搜索关键词
  setCurrentKeyword(keyword: string): void {
    this.currentKeyword = keyword;
  }

  // SkipServiceFilter 返回是否跳过Service层的关键词过滤
  private skipServiceFilterValue: boolean = false;
  skipServiceFilter(): boolean {
    return this.skipServiceFilterValue;
  }

  // GetClient 返回短超时客户端
  getClient(): AxiosInstance {
    return this.client;
  }

  // SetMainCacheUpdater 设置主缓存更新函数
  setMainCacheUpdater(updater: (key: string, results: SearchResult[], ttl: number, isFinal: boolean, keyword: string) => Promise<void>): void {
    this.mainCacheUpdater = updater;
  }

  // AsyncSearch 异步搜索基础方法
  async asyncSearch(
    keyword: string,
    searchFunc: (client: AxiosInstance, keyword: string, ext: Record<string, any>) => Promise<SearchResult[]>,
    mainCacheKey: string,
    ext: Record<string, any>
  ): Promise<SearchResult[]> {
    // 确保ext不为nil
    if (!ext) {
      ext = {};
    }

    const now = new Date();

    // 修改缓存键，确保包含插件名称
    const pluginSpecificCacheKey = `${this.nameValue}:${keyword}`;

    // 检查缓存
    if (apiResponseCache.has(pluginSpecificCacheKey)) {
      const cachedResult = apiResponseCache.get(pluginSpecificCacheKey)!;

      // 缓存完全有效（未过期且完整）
      if (now.getTime() - cachedResult.timestamp.getTime() < this.cacheTTL && cachedResult.complete) {
        recordCacheHit();
        recordCacheAccess(pluginSpecificCacheKey);

        // 如果缓存接近过期，在后台刷新缓存
        if (now.getTime() - cachedResult.timestamp.getTime() > (this.cacheTTL * 4 / 5)) {
          this.refreshCacheInBackground(keyword, pluginSpecificCacheKey, searchFunc, cachedResult, mainCacheKey, ext);
        }

        return cachedResult.results;
      }

      // 缓存已过期但有结果，启动后台刷新，同时返回旧结果
      if (cachedResult.results.length > 0) {
        recordCacheHit();
        recordCacheAccess(pluginSpecificCacheKey);

        // 标记为部分过期
        if (now.getTime() - cachedResult.timestamp.getTime() >= this.cacheTTL) {
          // 在后台刷新缓存
          this.refreshCacheInBackground(keyword, pluginSpecificCacheKey, searchFunc, cachedResult, mainCacheKey, ext);
        }

        return cachedResult.results;
      }
    }

    recordCacheMiss();

    // 尝试获取工作槽
    if (!canExecuteTask()) {
      // 工作池已满，使用快速响应客户端直接处理
      try {
        const results = await searchFunc(this.client, keyword, ext);
        
        // 缓存结果
        apiResponseCache.set(pluginSpecificCacheKey, {
          results,
          timestamp: now,
          complete: true,
          lastAccess: now,
          accessCount: 1,
        });

        // 更新主缓存
        this.updateMainCacheWithFinal(mainCacheKey, results, true);

        return results;
      } catch (error) {
        throw error;
      }
    }

    // 尝试获取工作槽
    await backgroundWorkerPool.acquire();

    try {
      // 执行搜索
      let results = await searchFunc(this.backgroundClient, keyword, ext);
      
      // 检查是否存在旧缓存
      let accessCount = 1;
      let lastAccess = now;

      if (apiResponseCache.has(pluginSpecificCacheKey)) {
        const oldCache = apiResponseCache.get(pluginSpecificCacheKey)!;
        accessCount = oldCache.accessCount;
        lastAccess = oldCache.lastAccess;

        // 合并结果（新结果优先）
        if (oldCache.results.length > 0) {
          // 创建合并结果集
          const mergedResults: SearchResult[] = [];

          // 创建已有结果ID的映射
          const existingIDs = new Set<string>();
          for (const r of results) {
            existingIDs.add(r.uniqueId);
            mergedResults.push(r);
          }

          // 添加旧结果中不存在的项
          for (const r of oldCache.results) {
            if (!existingIDs.has(r.uniqueId)) {
              mergedResults.push(r);
            }
          }

          // 使用合并结果
          results = mergedResults;
        }
      }

      apiResponseCache.set(pluginSpecificCacheKey, {
        results,
        timestamp: now,
        complete: true,
        lastAccess,
        accessCount,
      });
      
      recordAsyncCompletion();

      // 更新主缓存
      this.updateMainCacheWithFinal(mainCacheKey, results, true);

      return results;
    } finally {
      backgroundWorkerPool.release();
    }
  }

  // Search 兼容性方法
  async search(keyword: string, ext: Record<string, any>): Promise<SearchResult[]> {
    // TODO: 实现兼容性方法
    return [];
  }

  // 在后台刷新缓存
  private refreshCacheInBackground(
    keyword: string,
    cacheKey: string,
    searchFunc: (client: AxiosInstance, keyword: string, ext: Record<string, any>) => Promise<SearchResult[]>,
    oldCache: CachedResponse,
    originalCacheKey: string,
    ext: Record<string, any>
  ): void {
    // 确保ext不为nil
    if (!ext) {
      ext = {};
    }

    // 尝试获取工作槽
    backgroundWorkerPool.acquire().then(() => {
      // 执行搜索
      searchFunc(this.backgroundClient, keyword, ext)
        .then(results => {
          if (results.length > 0) {
            // 创建合并结果集
            const mergedResults: SearchResult[] = [];

            // 创建已有结果ID的映射
            const existingIDs = new Set<string>();
            for (const r of results) {
              existingIDs.add(r.uniqueId);
              mergedResults.push(r);
            }

            // 添加旧结果中不存在的项
            for (const r of oldCache.results) {
              if (!existingIDs.has(r.uniqueId)) {
                mergedResults.push(r);
              }
            }

            // 更新缓存
            apiResponseCache.set(cacheKey, {
              results: mergedResults,
              timestamp: new Date(),
              complete: true,
              lastAccess: oldCache.lastAccess,
              accessCount: oldCache.accessCount,
            });

            // 更新主缓存
            this.updateMainCacheWithFinal(originalCacheKey, mergedResults, true);
          }
        })
        .catch(() => {
          // 忽略搜索错误
        })
        .finally(() => {
          backgroundWorkerPool.release();
        });
    }).catch(() => {
      // 忽略获取工作槽错误
    });
  }

  // 更新主缓存系统
  private updateMainCacheWithFinal(cacheKey: string, results: SearchResult[], isFinal: boolean): void {
    // 如果主缓存更新函数为空或缓存键为空，直接返回
    if (!this.mainCacheUpdater || !cacheKey) {
      return;
    }

    // 如果新结果为空，跳过缓存更新
    if (results.length === 0) {
      return;
    }

    // 生成结果数据的简单哈希标识
    let dataHash = `${results.length}_${results[0].uniqueId}`;
    if (results.length > 1) {
      dataHash += `_${results[results.length - 1].uniqueId}`;
    }
    const updateKey = `final_${this.nameValue}_${cacheKey}_${dataHash}_${isFinal}`;

    // 检查是否已经处理过相同的数据
    if (this.finalUpdateTracker.has(updateKey)) {
      return;
    }

    // 标记已更新
    this.finalUpdateTracker.set(updateKey, true);

    // 更新主缓存
    this.mainCacheUpdater(cacheKey, results, this.cacheTTL, isFinal, this.currentKeyword)
      .catch(error => {
        console.error(`❌ [${this.nameValue}] 主缓存更新失败: ${cacheKey} | 错误: ${error}`);
      });
  }
}

// ============================================================
// 第七部分：全局序列化器
// ============================================================

// 设置全局缓存序列化器
export function setGlobalCacheSerializer(serializer: CacheSerializer): void {
  globalCacheSerializer = serializer;
}

// 获取全局缓存序列化器
export function getGlobalCacheSerializer(): CacheSerializer | null {
  return globalCacheSerializer;
}