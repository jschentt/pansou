import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import * as cheerio from 'cheerio';
import { SearchResult, Link, PluginSearchResult } from '../../../model';
import { FilterResultsByKeyword } from '../../../util/plugin.util';

// 常量定义
const DefaultTimeout = 8000; // 默认超时时间：8秒
const DetailTimeout = 6000; // 详情页超时时间：6秒
const MaxConcurrency = 20; // 并发数限制

// 缓存有效期（1小时）
const cacheTTL = 1 * 60 * 60 * 1000;

// 正则表达式
const detailIDRegex = /\/vod\/detail\/id\/(\d+)\.html/;
const ucLinkRegex = /https?:\/\/drive\.uc\.cn\/s\/[0-9a-zA-Z]+(\?[^"'\s]*)?/;
const yearRegex = /(\d{4})/;

// 缓存项结构
interface CachedDetail {
  result: SearchResult;
  timestamp: number;
}

// 缓存管理
class CacheManager {
  private detailCache = new Map<string, CachedDetail>();
  private lastCleanupTime = Date.now();
  private cleanerInterval: NodeJS.Timeout | null = null;

  constructor() {
    // 启动缓存清理定时器
    this.startCacheCleaner();
  }

  // 启动缓存清理定时器
  private startCacheCleaner() {
    if (this.cleanerInterval) {
      clearInterval(this.cleanerInterval);
    }
    // 每30分钟清理一次过期缓存
    this.cleanerInterval = setInterval(() => {
      this.cleanExpiredCache();
    }, 30 * 60 * 1000);
  }

  // 清理过期缓存
  private cleanExpiredCache() {
    const now = Date.now();
    for (const [key, value] of this.detailCache.entries()) {
      if (now - value.timestamp > cacheTTL) {
        this.detailCache.delete(key);
      }
    }
    this.lastCleanupTime = now;
  }

  // 获取详情页缓存
  getDetailCache(itemID: string): SearchResult | null {
    const cached = this.detailCache.get(itemID);
    if (!cached) {
      return null;
    }
    // 检查缓存是否过期
    if (Date.now() - cached.timestamp > cacheTTL) {
      this.detailCache.delete(itemID);
      return null;
    }
    return cached.result;
  }

  // 设置详情页缓存
  setDetailCache(itemID: string, result: SearchResult) {
    this.detailCache.set(itemID, {
      result,
      timestamp: Date.now()
    });
  }
}

// 创建全局缓存实例
const cacheManager = new CacheManager();

// 信号量类，用于限制并发数
class Semaphore {
  private semaphore: number;
  private waiters: (() => void)[] = [];

  constructor(initial: number) {
    this.semaphore = initial;
  }

  // 获取信号量
  async acquire(): Promise<void> {
    if (this.semaphore > 0) {
      this.semaphore--;
      return;
    }
    return new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  // 释放信号量
  release(): void {
    if (this.waiters.length > 0) {
      const resolve = this.waiters.shift()!;
      resolve();
    } else {
      this.semaphore++;
    }
  }
}

// ShandianPlugin 闪电插件
class ShandianPlugin {
  private client: AxiosInstance;
  private MainCacheKey: string;
  private name: string;

  constructor() {
    this.client = axios.create({
      timeout: DefaultTimeout,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
        'Cache-Control': 'max-age=0',
        'Referer': 'http://1.95.79.193/',
      },
      httpsAgent: new (require('https').Agent)({
        rejectUnauthorized: false
      })
    });

    this.MainCacheKey = 'shandian';
    this.name = 'shandian';
  }

  // Name 返回插件名称
  Name(): string {
    return this.name;
  }

  // Search 执行搜索并返回结果（兼容性方法）
  async Search(keyword: string, ext: Record<string, any>): Promise<SearchResult[]> {
    const result = await this.SearchWithResult(keyword, ext);
    return result.Results;
  }

  // SearchWithResult 执行搜索并返回包含IsFinal标记的结果
  async SearchWithResult(keyword: string, ext: Record<string, any>): Promise<PluginSearchResult> {
    return this.AsyncSearchWithResult(keyword, this.searchImpl.bind(this), this.MainCacheKey, ext);
  }

  // AsyncSearchWithResult 异步搜索实现
  private async AsyncSearchWithResult(keyword: string, searchImpl: (client: AxiosInstance, keyword: string, ext: Record<string, any>) => Promise<SearchResult[]>, cacheKey: string, ext: Record<string, any>): Promise<PluginSearchResult> {
    const results = await searchImpl(this.client, keyword, ext);
    
    return {
      Results: results,
      IsFinal: true,
      CacheKey: cacheKey
    };
  }

  // searchImpl 实现搜索逻辑
  private async searchImpl(client: AxiosInstance, keyword: string, ext: Record<string, any>): Promise<SearchResult[]> {
    // 1. 构建搜索URL
    const searchURL = `http://1.95.79.193/index.php/vod/search/wd/${encodeURIComponent(keyword)}.html`;
    
    // 2. 创建请求配置
    const requestConfig: AxiosRequestConfig = {
      method: 'GET',
      url: searchURL,
      timeout: DefaultTimeout
    };
    
    // 3. 发送请求（带重试机制）
    let response;
    try {
      response = await this.doRequestWithRetry(client, requestConfig);
    } catch (err) {
      throw new Error(`[${this.Name()}] 搜索请求失败: ${err instanceof Error ? err.message : String(err)}`);
    }
    
    if (response.status !== 200) {
      throw new Error(`[${this.Name()}] 搜索请求返回状态码: ${response.status}`);
    }
    
    // 4. 解析搜索结果页面
    const doc = cheerio.load(response.data);
    
    // 5. 提取搜索结果
    const results: SearchResult[] = [];
    
    doc('.module-search-item').each((i, element) => {
      const s = doc(element);
      const result = this.parseSearchItem(doc, s, keyword);
      if (result.UniqueID !== '') {
        results.push(result);
      }
    });
    
    // 6. 异步获取详情页信息
    const enhancedResults = await this.enhanceWithDetails(client, results);
    
    // 7. 关键词过滤
    return FilterResultsByKeyword(enhancedResults, keyword);
  }

  // parseSearchItem 解析单个搜索结果项
  private parseSearchItem($: cheerio.CheerioAPI, s: cheerio.Cheerio, keyword: string): SearchResult {
    const result: SearchResult = {
      MessageID: '',
      UniqueID: '',
      Title: '',
      Content: '',
      Datetime: new Date(0), // 使用零值时间
      Links: [],
      Channel: '',
      Tags: []
    };
    
    // 提取详情页链接和ID
    const detailLink = s.find('.module-item-pic a').first().attr('href');
    if (!detailLink) {
      return result;
    }
    
    // 提取ID
    const matches = detailLink.match(detailIDRegex);
    if (matches?.length < 2) {
      return result;
    }
    
    const itemID = matches[1];
    result.UniqueID = `${this.Name()}-${itemID}`;
    result.MessageID = result.UniqueID;
    
    // 提取标题
    const titleElement = s.find('.video-info-header h3 a');
    result.Title = titleElement.text().trim();
    
    // 提取资源类型/质量
    const qualityElement = s.find('.video-serial');
    const quality = qualityElement.text().trim();
    
    // 提取分类信息
    const tags: string[] = [];
    s.find('.video-info-aux .tag-link a').each((i, tag) => {
      const tagText = $(tag).text().trim();
      if (tagText !== '') {
        tags.push(tagText);
      }
    });
    result.Tags = tags;
    
    // 提取导演信息
    let director = '';
    s.find('.video-info-items').each((i, item) => {
      const title = $(item).find('.video-info-itemtitle').text().trim();
      if (title.includes('导演')) {
        director = $(item).find('.video-info-actor a').text().trim();
      }
    });
    
    // 提取主演信息
    const actors: string[] = [];
    s.find('.video-info-items').each((i, item) => {
      const title = $(item).find('.video-info-itemtitle').text().trim();
      if (title.includes('主演')) {
        $(item).find('.video-info-actor a').each((j, actor) => {
          const actorName = $(actor).text().trim();
          if (actorName !== '') {
            actors.push(actorName);
          }
        });
      }
    });
    
    // 提取剧情简介
    let plot = '';
    s.find('.video-info-items').filter((i, item) => {
      const title = $(item).find('.video-info-itemtitle').text().trim();
      return title.includes('剧情');
    }).each((i, item) => {
      plot = $(item).find('.video-info-item').text().trim();
    });
    
    // 构建内容描述
    const contentParts: string[] = [];
    if (quality !== '') {
      contentParts.push(`【${quality}】`);
    }
    if (director !== '') {
      contentParts.push(`导演：${director}`);
    }
    if (actors.length > 0) {
      const actorStr = actors.slice(0, Math.min(3, actors.length)).join('、'); // 只显示前3个演员
      if (actors.length > 3) {
        contentParts.push(`主演：${actorStr}等`);
      } else {
        contentParts.push(`主演：${actorStr}`);
      }
    }
    if (plot !== '') {
      contentParts.push(plot);
    }
    
    result.Content = contentParts.join('\n');
    result.Channel = ''; // 插件搜索结果不设置频道名
    result.Datetime = new Date(0); // 使用零值时间
    
    return result;
  }

  // enhanceWithDetails 异步获取详情页信息以获取下载链接
  private async enhanceWithDetails(client: AxiosInstance, results: SearchResult[]): Promise<SearchResult[]> {
    const enhancedResults: SearchResult[] = [];
    const semaphore = new Semaphore(MaxConcurrency);

    // 创建详情页请求任务
    const tasks = results.map(async (result) => {
      await semaphore.acquire();
      
      try {
        // 从UniqueID提取ID
        const parts = result.UniqueID.split('-');
        if (parts.length < 2) {
          return result;
        }
        
        const itemID = parts[1];
        
        // 检查缓存
        const cachedResult = cacheManager.getDetailCache(itemID);
        if (cachedResult) {
          return cachedResult;
        }
        
        // 获取详情页链接
        const detailLinks = await this.fetchDetailLinks(client, itemID);
        
        // 复制结果并添加链接
        const enhancedResult: SearchResult = {
          ...result,
          Links: detailLinks
        };
        
        // 缓存结果
        cacheManager.setDetailCache(itemID, enhancedResult);
        
        return enhancedResult;
      } catch (err) {
        // 错误时返回原始结果
        return result;
      } finally {
        semaphore.release();
      }
    });

    // 等待所有任务完成
    const completedResults = await Promise.all(tasks);
    
    // 过滤掉空结果
    completedResults.forEach(result => {
      if (result.UniqueID !== '') {
        enhancedResults.push(result);
      }
    });

    return enhancedResults;
  }

  // doRequestWithRetry 带重试机制的HTTP请求
  private async doRequestWithRetry(client: AxiosInstance, config: AxiosRequestConfig, maxRetries: number = 3): Promise<any> {
    let lastErr: Error | null = null;
    
    for (let i = 0; i < maxRetries; i++) {
      if (i > 0) {
        // 指数退避
        const backoff = Math.min(2000 * Math.pow(2, i - 1), 10000); // 最大10秒
        await new Promise(resolve => setTimeout(resolve, backoff));
      }
      
      try {
        const response = await client.request(config);
        if (response.status === 200) {
          return response;
        }
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error(String(err));
      }
    }
    
    throw new Error(`重试 ${maxRetries} 次后仍然失败: ${lastErr?.message}`);
  }

  // fetchDetailLinks 获取详情页的下载链接
  private async fetchDetailLinks(client: AxiosInstance, itemID: string): Promise<Link[]> {
    const detailURL = `http://1.95.79.193/index.php/vod/detail/id/${itemID}.html`;
    
    // 创建请求配置
    const requestConfig: AxiosRequestConfig = {
      method: 'GET',
      url: detailURL,
      timeout: DetailTimeout
    };
    
    // 发送请求（带重试）
    let response;
    try {
      response = await this.doRequestWithRetry(client, requestConfig);
    } catch (err) {
      return [];
    }
    
    if (response.status !== 200) {
      return [];
    }
    
    const doc = cheerio.load(response.data);
    
    const links: Link[] = [];
    
    // 查找下载链接区域
    doc('#download-list .module-row-one').each((i, element) => {
      const s = doc(element);
      
      // 从data-clipboard-text属性提取链接
      const linkURL = s.find('[data-clipboard-text]').attr('data-clipboard-text');
      if (linkURL) {
        // 过滤掉无效链接
        if (this.isValidNetworkDriveURL(linkURL) && ucLinkRegex.test(linkURL)) {
          const link: Link = {
            Type: 'uc',
            URL: linkURL,
            Password: '', // UC云盘通常不需要密码
          };
          links.push(link);
        }
      }
      
      // 也检查直接的href属性
      s.find('a[href]').each((j, a) => {
        const href = doc(a).attr('href');
        if (href) {
          // 过滤掉无效链接
          if (this.isValidNetworkDriveURL(href) && ucLinkRegex.test(href)) {
            // 避免重复添加
            const isDuplicate = links.some(existingLink => existingLink.URL === href);
            
            if (!isDuplicate) {
              const link: Link = {
                Type: 'uc',
                URL: href,
                Password: '',
              };
              links.push(link);
            }
          }
        }
      });
    });
    
    return links;
  }

  // isValidNetworkDriveURL 检查URL是否为有效的网盘链接
  private isValidNetworkDriveURL(urlStr: string): boolean {
    // 过滤掉明显无效的链接
    if (urlStr.includes('javascript:') || 
       urlStr.includes('#') ||
       urlStr === '' ||
       !urlStr.startsWith('http')) {
      return false;
    }
    
    // 对于shandian插件，只检查UC网盘格式
    return ucLinkRegex.test(urlStr);
  }
}

// 创建并导出插件实例
export default new ShandianPlugin();