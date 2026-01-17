import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import * as cheerio from 'cheerio';
import { SearchResult, Link, PluginSearchResult } from '../../../model';
import { FilterResultsByKeyword } from '../../../util/plugin.util';

// 常量定义
const SearchURL = 'https://thpibay.xyz/search/%s/1/99/0';
const SearchPageURL = 'https://thpibay.xyz/search/%s/%d/99/0';
const DefaultTimeout = 10000; // 默认超时时间：10秒
const MaxConcurrency = 200; // 并发数限制
const MaxPages = 30; // 最大分页数（避免无限请求）
const CacheTTL = 24 * 60 * 60 * 1000; // 缓存有效期：24小时

// 预编译正则表达式
const magnetLinkRegex = /magnet:\?xt=urn:btih:[0-9a-fA-F]{40}[^"'\s]*/;
const torrentIDRegex = /\/torrent\/(\d+)\//;
const timeFormat1Regex = /(\d{2}-\d{2})\s+(\d{2}:\d{2})/; // MM-DD HH:MM
const timeFormat2Regex = /(\d{2}-\d{2})\s+(\d{4})/;      // MM-DD YYYY
const fileSizeRegex = /Size\s+([0-9.]+)\s*(&nbsp;)?\s*([KMGT]?i?B)/;

// 缓存的页面响应
interface PageResponse {
  Results: SearchResult[];
  TotalPage: number;
  Timestamp: number;
}

// 缓存管理
class CacheManager {
  private pageCache = new Map<string, PageResponse>();
  private lastCacheCleanTime = Date.now();

  constructor() {
    // 启动缓存清理定时器
    this.startCacheCleaner();
  }

  // 启动缓存清理定时器
  private startCacheCleaner() {
    setInterval(() => {
      const now = Date.now();
      this.pageCache.forEach((item, key) => {
        if (now - item.Timestamp > CacheTTL) {
          this.pageCache.delete(key);
        }
      });
      this.lastCacheCleanTime = now;
    }, CacheTTL);
  }

  // 获取页面缓存
  getPageCache(key: string): PageResponse | null {
    const item = this.pageCache.get(key);
    if (!item) return null;

    // 检查缓存是否过期
    if (Date.now() - item.Timestamp > CacheTTL) {
      this.pageCache.delete(key);
      return null;
    }

    return item;
  }

  // 设置页面缓存
  setPageCache(key: string, response: PageResponse): void {
    this.pageCache.set(key, response);
  }

  // 清空所有缓存
  clearAll(): void {
    this.pageCache.clear();
  }
}

// 创建全局缓存实例
const cacheManager = new CacheManager();

// 信号量类
class Semaphore {
  private count: number;
  private queue: ((value: void) => void)[] = [];

  constructor(initialCount: number) {
    this.count = initialCount;
  }

  async acquire(): Promise<void> {
    if (this.count > 0) {
      this.count--;
      return;
    }

    return new Promise<void>(resolve => {
      this.queue.push(resolve);
    });
  }

  release(): void {
    this.count++;
    if (this.queue.length > 0) {
      const resolve = this.queue.shift()!;
      resolve();
    }
  }
}

// ThePirateBayPlugin 海盗湾搜索插件
class ThePirateBayPlugin {
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
        'Referer': 'https://thpibay.xyz/',
      },
      httpsAgent: new (require('https').Agent)({
        rejectUnauthorized: false
      })
    });

    this.MainCacheKey = 'thepiratebay';
    this.name = 'thepiratebay';
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

  // searchImpl 实现具体的搜索逻辑（支持分页）
  private async searchImpl(client: AxiosInstance, keyword: string, ext: Record<string, any>): Promise<SearchResult[]> {
    // 检查是否提供了英文标题参数 - 对英文搜索更友好
    let searchKeyword = keyword;
    if (ext && ext.title_en && typeof ext.title_en === 'string' && ext.title_en !== '') {
      searchKeyword = ext.title_en;
    }
    
    const encodedKeyword = encodeURIComponent(searchKeyword);
    const allResults: SearchResult[] = [];
    
    // 1. 搜索第一页，获取总页数
    const [firstPageResults, totalPages] = await this.searchPage(client, encodedKeyword, 1);
    allResults.push(...firstPageResults);
    
    // 2. 如果有多页，并发搜索其他页面（限制最大页数）
    const maxPagesToSearch = Math.min(totalPages, MaxPages);
    
    if (totalPages > 1 && maxPagesToSearch > 1) {
      // 并发搜索其他页面
      const semaphore = new Semaphore(MaxConcurrency);
      const pageResults = new Map<number, SearchResult[]>();
      
      // 创建获取页面结果的Promise数组
      const pagePromises = Array.from({ length: maxPagesToSearch - 1 }, async (_, index) => {
        const page = index + 2;
        await semaphore.acquire();
        
        try {
          const [results] = await this.searchPage(client, encodedKeyword, page);
          if (results.length > 0) {
            pageResults.set(page, results);
          }
        } catch (err) {
          // 忽略单页错误
        } finally {
          semaphore.release();
        }
      });
      
      // 等待所有页面请求完成
      await Promise.all(pagePromises);
      
      // 按页码顺序合并所有页面的结果
      for (let page = 2; page <= maxPagesToSearch; page++) {
        if (pageResults.has(page)) {
          allResults.push(...pageResults.get(page)!);
        }
      }
    }
    
    // 3. 过滤关键词匹配的结果 - 使用处理后的搜索关键词进行过滤
    return FilterResultsByKeyword(allResults, searchKeyword);
  }

  // searchPage 搜索指定页面
  private async searchPage(client: AxiosInstance, encodedKeyword: string, page: number): Promise<[SearchResult[], number]> {
    // 1. 构建搜索URL
    const searchURL = page === 1
      ? SearchURL.replace('%s', encodedKeyword)
      : SearchPageURL.replace('%s', encodedKeyword).replace('%d', page.toString());
    
    // 2. 检查缓存
    const cacheKey = `${encodedKeyword}-page-${page}`;
    const cachedResponse = cacheManager.getPageCache(cacheKey);
    if (cachedResponse) {
      return [cachedResponse.Results, cachedResponse.TotalPage];
    }
    
    // 3. 创建请求配置
    const requestConfig: AxiosRequestConfig = {
      method: 'GET',
      url: searchURL,
      timeout: DefaultTimeout
    };
    
    // 4. 发送HTTP请求（带重试机制）
    let response;
    try {
      response = await this.doRequestWithRetry(client, requestConfig);
    } catch (err) {
      throw new Error(`[${this.Name()}] 第${page}页搜索请求失败: ${err instanceof Error ? err.message : String(err)}`);
    }
    
    // 5. 检查状态码
    if (response.status !== 200) {
      throw new Error(`[${this.Name()}] 第${page}页请求返回状态码: ${response.status}`);
    }
    
    // 6. 解析HTML响应
    const $ = cheerio.load(response.data);
    
    // 7. 解析分页信息（只在第一页解析）
    let totalPages = 1;
    if (page === 1) {
      totalPages = this.parseTotalPages($);
    }
    
    // 8. 提取搜索结果
    const results: SearchResult[] = [];
    $('table#searchResult tr').each((i, element) => {
      const s = $(element);
      
      // 跳过表头
      if (s.hasClass('header')) {
        return;
      }
      
      const result = this.parseSearchResultItem($, s);
      if (result) {
        results.push(result);
      }
    });
    
    // 9. 缓存结果
    const pageResponse: PageResponse = {
      Results: results,
      TotalPage: totalPages,
      Timestamp: Date.now()
    };
    cacheManager.setPageCache(cacheKey, pageResponse);
    
    return [results, totalPages];
  }

  // parseTotalPages 解析总页数
  private parseTotalPages($: cheerio.CheerioAPI): number {
    let maxPage = 1;
    
    // 查找分页信息，ThePirateBay的分页在底部
    // 格式: <b>1</b> <a href="/search/...">2</a> <a href="/search/...">3</a> ...
    
    $('table#searchResult').next().find('a').each((i, element) => {
      const s = $(element);
      const href = s.attr('href');
      if (!href) {
        return;
      }
      
      // 从URL中提取页码: /search/keyword/PAGE/99/0
      const parts = href.split('/');
      if (parts.length >= 4) {
        const pageStr = parts[3];
        if (pageStr !== '') {
          const pageNum = parseInt(pageStr, 10);
          if (!isNaN(pageNum) && pageNum > maxPage) {
            maxPage = pageNum;
          }
        }
      }
    });
    
    // 也检查分页导航区域
    $('td[colspan="9"] a').each((i, element) => {
      const s = $(element);
      const pageText = s.text().trim();
      const pageNum = parseInt(pageText, 10);
      if (!isNaN(pageNum) && pageNum > maxPage) {
        maxPage = pageNum;
      }
    });
    
    // 限制最大页数，避免过度请求
    if (maxPage > MaxPages) {
      maxPage = MaxPages;
    }
    
    return maxPage;
  }

  // parseSearchResultItem 解析单个搜索结果项
  private parseSearchResultItem($: cheerio.CheerioAPI, s: cheerio.Cheerio): SearchResult | null {
    // 获取详情页链接和标题
    const titleElement = s.find('.detName a.detLink').first();
    if (titleElement.length === 0) {
      return null;
    }
    
    let title = titleElement.text().trim();
    if (title === '') {
      return null;
    }
    
    // 优化标题格式：将'.'替换为空格，便于关键词匹配
    title = title.replace(/\./g, ' ');
    
    let detailURL = titleElement.attr('href');
    if (!detailURL || detailURL === '') {
      return null;
    }
    
    // 补全URL
    if (detailURL.startsWith('/')) {
      detailURL = 'https://thpibay.xyz' + detailURL;
    }
    
    // 提取种子ID
    const matches = detailURL.match(torrentIDRegex);
    if (!matches || matches.length < 2) {
      return null;
    }
    const torrentID = matches[1];
    
    // 获取磁力链接
    const magnetElement = s.find('a[href^="magnet:"]').first();
    const magnetURL = magnetElement.attr('href');
    if (!magnetURL || magnetURL === '') {
      return null; // ThePirateBay只提供磁力链接，没有磁力链接就跳过
    }
    
    // 验证磁力链接格式
    if (!magnetLinkRegex.test(magnetURL)) {
      return null;
    }
    
    // 获取分类信息
    const tags: string[] = [];
    s.find('.vertTh a').each((i, elem) => {
      const tag = $(elem).text().trim();
      if (tag !== '') {
        tags.push(tag);
      }
    });
    
    // 获取种子元数据（文件大小、上传时间、上传者等）
    const detDesc = s.find('.detDesc').text();
    
    // 解析上传时间
    const datetime = this.parseUploadTime(detDesc);
    
    // 提取文件大小信息
    let content = '';
    const sizeMatch = detDesc.match(fileSizeRegex);
    if (sizeMatch && sizeMatch.length > 0) {
      content = `文件大小: ${sizeMatch[1]}${sizeMatch[3]}`;
    }
    
    // 添加其他元数据信息
    if (content !== '') {
      content += ', ';
    }
    content += `上传信息: ${detDesc.trim()}`;
    
    // 获取Seeders和Leechers数量
    const seeders = s.find('td').eq(2).text().trim();
    const leechers = s.find('td').eq(3).text().trim();
    
    if (seeders !== '' && leechers !== '') {
      content += `, Seeders: ${seeders}, Leechers: ${leechers}`;
    }
    
    // 创建磁力链接
    const magnetLink: Link = {
      Type: 'magnet',
      URL: magnetURL,
      Password: '', // 磁力链接不需要密码
    };
    
    return {
      MessageID: `${this.Name()}-${torrentID}`,
      UniqueID: `${this.Name()}-${torrentID}`,
      Title: title,
      Content: content,
      Datetime: datetime,
      Tags: tags,
      Links: [magnetLink],
      Channel: '', // 插件搜索结果，Channel必须为空
    };
  }

  // parseUploadTime 解析上传时间的两种格式
  private parseUploadTime(timeStr: string): Date {
    // 去除&nbsp;
    timeStr = timeStr.replace(/&nbsp;/g, ' ');
    
    // 格式1: "07-28 05:35" (当年)
    const matches1 = timeStr.match(timeFormat1Regex);
    if (matches1 && matches1.length >= 3) {
      const currentYear = new Date().getFullYear();
      const fullTimeStr = `${currentYear}-${matches1[1]} ${matches1[2]}`;
      const parsedTime = new Date(fullTimeStr);
      if (!isNaN(parsedTime.getTime())) {
        return parsedTime;
      }
    }
    
    // 格式2: "10-30 2023" (历史)
    const matches2 = timeStr.match(timeFormat2Regex);
    if (matches2 && matches2.length >= 3) {
      const dateStr = `${matches2[2]}-${matches2[1]}`; // YYYY-MM-DD
      const parsedTime = new Date(dateStr);
      if (!isNaN(parsedTime.getTime())) {
        return parsedTime;
      }
    }
    
    // 默认返回当前时间
    return new Date();
  }

  // doRequestWithRetry 带重试机制的HTTP请求
  private async doRequestWithRetry(client: AxiosInstance, config: AxiosRequestConfig, maxRetries: number = 3): Promise<any> {
    let lastErr: Error | null = null;
    
    for (let i = 0; i < maxRetries; i++) {
      if (i > 0) {
        // 指数退避重试
        const backoff = Math.min(2 ** (i - 1) * 200, 10000);
        await new Promise(resolve => setTimeout(resolve, backoff));
      }
      
      try {
        // 发送请求
        const response = await client.request(config);
        if (response.status === 200) {
          return response;
        }
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error(String(err));
      }
    }
    
    throw lastErr || new Error(`重试 ${maxRetries} 次后仍然失败`);
  }
}

// 创建并导出插件实例
export default new ThePirateBayPlugin();