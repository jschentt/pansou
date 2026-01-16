import { Injectable, OnModuleInit } from '@nestjs/common';
import { SearchResult } from '../models/response';
import { PluginSearchResult } from '../models/plugin-result';

export interface AsyncSearchPlugin {
  name(): string;
  priority(): number;
  asyncSearch(keyword: string, searchFunc: (client: any, keyword: string, ext: Record<string, any>) => Promise<SearchResult[]>, mainCacheKey: string, ext: Record<string, any>): Promise<SearchResult[]>;
  setMainCacheKey(key: string): void;
  setCurrentKeyword(keyword: string): void;
  search(keyword: string, ext: Record<string, any>): Promise<SearchResult[]>;
  skipServiceFilter(): boolean;
}

export interface PluginWithWebHandler extends AsyncSearchPlugin {
  registerWebRoutes(router: any): void;
}

export interface InitializablePlugin extends AsyncSearchPlugin {
  initialize(): Promise<void>;
}

interface CachedResponse {
  results: SearchResult[];
  timestamp: number;
  complete: boolean;
  lastAccess: number;
  accessCount: number;
}

interface MainCacheUpdater {
  (cacheKey: string, results: SearchResult[], ttl: number, isFinal: boolean, keyword: string): Promise<void>;
}

@Injectable()
export class PluginManager implements OnModuleInit {
  private plugins: AsyncSearchPlugin[] = [];
  private initialized = false;
  private initLock = false;
  
  // 全局静态变量
  static apiResponseCache = new Map<string, CachedResponse>();
  static backgroundTasksCount = 0;
  static cacheHits = 0;
  static cacheMisses = 0;
  static asyncCompletions = 0;
  static cacheAccessCount = new Map<string, number>();
  static lastCleanupTime = Date.now();
  static cleanupMutex = false;
  
  // 默认配置值
  static defaultAsyncResponseTimeout = 4000;
  static defaultPluginTimeout = 30000;
  static defaultCacheTTL = 3600000; // 1小时
  static defaultMaxBackgroundWorkers = 20;
  static defaultMaxBackgroundTasks = 100;
  
  // 工作池
  private backgroundWorkerPool: any[] = [];
  private maxWorkers = PluginManager.defaultMaxBackgroundWorkers;

  constructor() {
  }

  async onModuleInit() {
    this.initialize();
  }

  private initialize() {
    if (this.initLock || this.initialized) {
      return;
    }

    this.initLock = true;
    
    try {
      // 使用默认工作池大小
      this.backgroundWorkerPool = new Array(this.maxWorkers).fill(null);
      this.initialized = true;
    } finally {
      this.initLock = false;
    }
  }

  // 注册插件
  registerPlugin(plugin: AsyncSearchPlugin): void {
    if (!this.initialized) {
      this.initialize();
    }
    this.plugins.push(plugin);
  }

  // 注册全局插件
  static registerGlobalPlugin(plugin: AsyncSearchPlugin): void {
    // 全局插件注册逻辑
  }

  // 获取所有插件
  getPlugins(): AsyncSearchPlugin[] {
    return this.plugins;
  }

  // 按优先级排序插件
  getSortedPlugins(): AsyncSearchPlugin[] {
    return this.plugins.sort((a, b) => b.priority() - a.priority());
  }

  // 执行搜索
  async search(keyword: string, ext: Record<string, any> = {}): Promise<SearchResult[]> {
    const results: SearchResult[] = [];
    const sortedPlugins = this.getSortedPlugins();

    for (const plugin of sortedPlugins) {
      try {
        const pluginResults = await plugin.search(keyword, ext);
        results.push(...pluginResults);
      } catch (error) {
        console.error(`插件 ${plugin.name()} 搜索失败:`, error);
      }
    }

    return results;
  }

  // 工作池管理
  static acquireWorkerSlot(): boolean {
    if (this.backgroundTasksCount >= this.defaultMaxBackgroundTasks) {
      return false;
    }
    this.backgroundTasksCount++;
    return true;
  }

  static releaseWorkerSlot(): void {
    if (this.backgroundTasksCount > 0) {
      this.backgroundTasksCount--;
    }
  }

  // 缓存管理
  static recordCacheHit(): void {
    this.cacheHits++;
  }

  static recordCacheMiss(): void {
    this.cacheMisses++;
  }

  static recordCacheAccess(cacheKey: string): void {
    const count = this.cacheAccessCount.get(cacheKey) || 0;
    this.cacheAccessCount.set(cacheKey, count + 1);
  }

  // 缓存清理
  static cleanupCache() {
    if (this.cleanupMutex) {
      return;
    }

    this.cleanupMutex = true;

    try {
      const now = Date.now();
      const expiredThreshold = now - this.defaultCacheTTL;

      for (const [key, value] of this.apiResponseCache.entries()) {
        const cachedResponse = value as CachedResponse;
        if (cachedResponse.timestamp < expiredThreshold) {
          this.apiResponseCache.delete(key);
        }
      }

      this.lastCleanupTime = now;
    } finally {
      this.cleanupMutex = false;
    }
  }

  // 定期清理缓存
  static scheduleCacheCleanup() {
    setInterval(() => {
      this.cleanupCache();
    }, 300000); // 每5分钟清理一次
  }
}

// 导出获取注册插件的函数
export function getRegisteredPlugins(): AsyncSearchPlugin[] {
  // 实现获取注册插件的逻辑
  return [];
}

// 导出注册全局插件函数
export function registerGlobalPlugin(plugin: AsyncSearchPlugin): void {
  PluginManager.registerGlobalPlugin(plugin);
}

export class BaseAsyncPlugin implements AsyncSearchPlugin {
  private nameValue: string;
  private priorityValue: number;
  private client: any;
  private backgroundClient: any;
  protected cacheTTL: number;
  private mainCacheUpdater: MainCacheUpdater | null = null;
  protected mainCacheKey: string = '';
  private currentKeyword: string = '';
  private finalUpdateTracker: Record<string, boolean> = {};
  private finalUpdateMutex: any;
  private skipServiceFilterValue: boolean;

  constructor(name: string, priority: number, skipServiceFilter: boolean = false) {
    this.nameValue = name;
    this.priorityValue = priority;
    this.skipServiceFilterValue = skipServiceFilter;
    this.cacheTTL = 60 * 60 * 1000; // 默认1小时
    this.finalUpdateTracker = {};
  }

  setMainCacheKey(key: string): void {
    this.mainCacheKey = key;
  }

  setCurrentKeyword(keyword: string): void {
    this.currentKeyword = keyword;
  }

  setMainCacheUpdater(updater: MainCacheUpdater): void {
    this.mainCacheUpdater = updater;
  }

  name(): string {
    return this.nameValue;
  }

  priority(): number {
    return this.priorityValue;
  }

  skipServiceFilter(): boolean {
    return this.skipServiceFilterValue;
  }

  async asyncSearch(
    keyword: string,
    searchFunc: (client: any, keyword: string, ext: Record<string, any>) => Promise<SearchResult[]>,
    mainCacheKey: string,
    ext: Record<string, any> = {}
  ): Promise<SearchResult[]> {
    const now = Date.now();
    const pluginSpecificCacheKey = `${this.nameValue}:${keyword}`;

    // 检查缓存
    const cachedItems = PluginManager.apiResponseCache.get(pluginSpecificCacheKey);
    if (cachedItems) {
      const cachedResult = cachedItems as CachedResponse;
      
      // 缓存完全有效（未过期且完整）
      if (now - cachedResult.timestamp < this.cacheTTL && cachedResult.complete) {
        PluginManager.recordCacheHit();
        PluginManager.recordCacheAccess(pluginSpecificCacheKey);
        
        // 如果缓存接近过期（已用时间超过TTL的80%），在后台刷新缓存
        if (now - cachedResult.timestamp > (this.cacheTTL * 4 / 5)) {
          this.refreshCacheInBackground(keyword, pluginSpecificCacheKey, searchFunc, cachedResult, mainCacheKey, ext);
        }
        
        return cachedResult.results;
      }
      
      // 缓存已过期但有结果，启动后台刷新，同时返回旧结果
      if (cachedResult.results.length > 0) {
        PluginManager.recordCacheHit();
        PluginManager.recordCacheAccess(pluginSpecificCacheKey);
        
        // 标记为部分过期
        if (now - cachedResult.timestamp >= this.cacheTTL) {
          // 在后台刷新缓存
          this.refreshCacheInBackground(keyword, pluginSpecificCacheKey, searchFunc, cachedResult, mainCacheKey, ext);
        }
        
        return cachedResult.results;
      }
    }

    PluginManager.recordCacheMiss();

    // 创建Promise
    return new Promise<SearchResult[]>((resolve, reject) => {
      const resultChan: SearchResult[][] = [];
      const errorChan: Error[] = [];
      let done = false;

      // 启动后台处理
      if (!PluginManager.acquireWorkerSlot()) {
        // 工作池已满，使用快速响应客户端直接处理
        searchFunc({}, keyword, ext)
          .then(results => {
            resolve(results);
            // 缓存结果
            PluginManager.apiResponseCache.set(pluginSpecificCacheKey, {
              results,
              timestamp: now,
              complete: true,
              lastAccess: now,
              accessCount: 1
            });
            // 更新主缓存
            this.updateMainCacheWithFinal(mainCacheKey, results, true);
          })
          .catch(err => {
            reject(err);
          });
        return;
      }

      // 执行搜索
      searchFunc({}, keyword, ext)
        .then(results => {
          PluginManager.releaseWorkerSlot();
          
          // 检查是否存在旧缓存用于合并
          const oldCache = PluginManager.apiResponseCache.get(pluginSpecificCacheKey);
          if (oldCache) {
            const oldCachedResult = oldCache as CachedResponse;
            if (oldCachedResult.results.length > 0) {
              // 创建合并结果集
              const mergedResults: SearchResult[] = [];
              const existingIDs: Record<string, boolean> = {};
              
              // 添加新结果
              for (const r of results) {
                existingIDs[r.uniqueId] = true;
                mergedResults.push(r);
              }
              
              // 添加旧结果中不存在的项
              for (const r of oldCachedResult.results) {
                if (!existingIDs[r.uniqueId]) {
                  mergedResults.push(r);
                }
              }
              
              // 使用合并结果
              results = mergedResults;
            }
          }
          
          resolve(results);
          
          // 更新缓存
          PluginManager.apiResponseCache.set(pluginSpecificCacheKey, {
            results,
            timestamp: now,
            complete: true,
            lastAccess: now,
            accessCount: 1
          });
          
          // 更新主缓存
          this.updateMainCacheWithFinal(mainCacheKey, results, true);
        })
        .catch(err => {
          PluginManager.releaseWorkerSlot();
          reject(err);
        });
    });
  }

  async search(keyword: string, ext: Record<string, any> = {}): Promise<SearchResult[]> {
    return this.asyncSearch(keyword, (client, kw, e) => this.performSearch(client, kw, e), this.mainCacheKey, ext);
  }

  protected async performSearch(client: any, keyword: string, ext: Record<string, any>): Promise<SearchResult[]> {
    return [];
  }

  private refreshCacheInBackground(
    keyword: string,
    cacheKey: string,
    searchFunc: (client: any, keyword: string, ext: Record<string, any>) => Promise<SearchResult[]>,
    oldCache: CachedResponse,
    originalCacheKey: string,
    ext: Record<string, any> = {}
  ): void {
    if (!PluginManager.acquireWorkerSlot()) {
      return;
    }

    const refreshStart = Date.now();

    searchFunc({}, keyword, ext)
      .then(results => {
        PluginManager.releaseWorkerSlot();
        
        if (results.length === 0) {
          return;
        }

        // 创建合并结果集
        const mergedResults: SearchResult[] = [];
        const existingIDs: Record<string, boolean> = {};
        
        // 添加新结果
        for (const r of results) {
          existingIDs[r.uniqueId] = true;
          mergedResults.push(r);
        }
        
        // 添加旧结果中不存在的项
        for (const r of oldCache.results) {
          if (!existingIDs[r.uniqueId]) {
            mergedResults.push(r);
          }
        }

        // 更新缓存
        PluginManager.apiResponseCache.set(cacheKey, {
          results: mergedResults,
          timestamp: Date.now(),
          complete: true,
          lastAccess: oldCache.lastAccess,
          accessCount: oldCache.accessCount
        });

        // 更新主缓存
        this.updateMainCacheWithFinal(originalCacheKey, mergedResults, true);

        // 记录刷新时间
        const refreshTime = Date.now() - refreshStart;
        console.log(`[${this.nameValue}] 后台刷新完成: ${cacheKey} (耗时: ${refreshTime}ms, 新项目: ${results.length}, 合并项目: ${mergedResults.length})`);
      })
      .catch(() => {
        PluginManager.releaseWorkerSlot();
      });
  }

  private updateMainCache(cacheKey: string, results: SearchResult[]): void {
    this.updateMainCacheWithFinal(cacheKey, results, true);
  }

  private updateMainCacheWithFinal(cacheKey: string, results: SearchResult[], isFinal: boolean): void {
    if (!this.mainCacheUpdater || !cacheKey) {
      return;
    }

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
    if (this.finalUpdateTracker[updateKey]) {
      return;
    }

    // 标记已更新
    this.finalUpdateTracker[updateKey] = true;

    // 更新主缓存
    this.mainCacheUpdater(cacheKey, results, this.cacheTTL, isFinal, this.currentKeyword);
  }

  async asyncSearchWithResult(
    keyword: string,
    searchFunc: (client: any, keyword: string, ext: Record<string, any>) => Promise<SearchResult[]>,
    mainCacheKey: string,
    ext: Record<string, any> = {}
  ): Promise<any> {
    const now = Date.now();
    const pluginSpecificCacheKey = `${this.nameValue}:${keyword}`;

    // 检查缓存
    const cachedItems = PluginManager.apiResponseCache.get(pluginSpecificCacheKey);
    if (cachedItems) {
      const cachedResult = cachedItems as CachedResponse;
      
      // 缓存完全有效（未过期且完整）
      if (now - cachedResult.timestamp < this.cacheTTL && cachedResult.complete) {
        PluginManager.recordCacheHit();
        PluginManager.recordCacheAccess(pluginSpecificCacheKey);
        
        // 如果缓存接近过期（已用时间超过TTL的80%），在后台刷新缓存
        if (now - cachedResult.timestamp > (this.cacheTTL * 4 / 5)) {
          this.refreshCacheInBackground(keyword, pluginSpecificCacheKey, searchFunc, cachedResult, mainCacheKey, ext);
        }
        
        return {
          results: cachedResult.results,
          isFinal: cachedResult.complete,
          timestamp: new Date(cachedResult.timestamp),
          source: this.nameValue,
          message: '从缓存获取',
          IsEmpty: cachedResult.results.length === 0,
          Count: cachedResult.results.length,
          GetResults: () => cachedResult.results
        };
      }
      
      // 缓存已过期但有结果，启动后台刷新，同时返回旧结果
      if (cachedResult.results.length > 0) {
        PluginManager.recordCacheHit();
        PluginManager.recordCacheAccess(pluginSpecificCacheKey);
        
        // 标记为部分过期
        if (now - cachedResult.timestamp >= this.cacheTTL) {
          // 在后台刷新缓存
          this.refreshCacheInBackground(keyword, pluginSpecificCacheKey, searchFunc, cachedResult, mainCacheKey, ext);
        }
        
        return {
          results: cachedResult.results,
          isFinal: false,
          timestamp: new Date(cachedResult.timestamp),
          source: this.nameValue,
          message: '缓存已过期，后台刷新中',
          IsEmpty: cachedResult.results.length === 0,
          Count: cachedResult.results.length,
          GetResults: () => cachedResult.results
        };
      }
    }

    PluginManager.recordCacheMiss();

    // 创建Promise
    return new Promise<any>((resolve, reject) => {
      const responseTimeout = 4000; // 默认4秒
      
      const timeoutId = setTimeout(() => {
        // 插件响应超时，后台继续处理
        this.completeSearchInBackground(keyword, searchFunc, pluginSpecificCacheKey, mainCacheKey, ext);
        
        // 存储临时缓存（标记为不完整）
        PluginManager.apiResponseCache.set(pluginSpecificCacheKey, {
          results: [],
          timestamp: now,
          complete: false,
          lastAccess: now,
          accessCount: 1
        });
        
        resolve({
          results: [],
          isFinal: false,
          timestamp: new Date(now),
          source: this.nameValue,
          message: '处理中，后台继续...',
          IsEmpty: true,
          Count: 0,
          GetResults: () => []
        });
      }, responseTimeout);

      // 执行搜索
      searchFunc({}, keyword, ext)
        .then(results => {
          clearTimeout(timeoutId);
          
          // 缓存结果
          PluginManager.apiResponseCache.set(pluginSpecificCacheKey, {
            results,
            timestamp: now,
            complete: true,
            lastAccess: now,
            accessCount: 1
          });
          
          // 更新主缓存
          if (mainCacheKey && this.mainCacheUpdater) {
            this.mainCacheUpdater(mainCacheKey, results, this.cacheTTL, true, this.currentKeyword);
          }
          
          resolve({
            results,
            isFinal: true,
            timestamp: new Date(now),
            source: this.nameValue,
            message: '搜索完成',
            IsEmpty: results.length === 0,
            Count: results.length,
            GetResults: () => results
          });
        })
        .catch(err => {
          clearTimeout(timeoutId);
          reject(err);
        });
    });
  }

  private completeSearchInBackground(
    keyword: string,
    searchFunc: (client: any, keyword: string, ext: Record<string, any>) => Promise<SearchResult[]>,
    pluginCacheKey: string,
    mainCacheKey: string,
    ext: Record<string, any> = {}
  ): void {
    searchFunc({}, keyword, ext)
      .then(results => {
        const now = Date.now();
        
        // 更新插件缓存
        PluginManager.apiResponseCache.set(pluginCacheKey, {
          results,
          timestamp: now,
          complete: true,
          lastAccess: now,
          accessCount: 1
        });
        
        // 更新主缓存
        if (mainCacheKey && this.mainCacheUpdater) {
          this.mainCacheUpdater(mainCacheKey, results, this.cacheTTL, true, this.currentKeyword);
        }
      })
      .catch(() => {
        // 忽略错误
      });
  }
}
