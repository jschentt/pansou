import { BaseAsyncPlugin, registerGlobalPlugin } from '../plugin.manager';
import { SearchResult, Link } from '../../models/response';
import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import * as cheerio from 'cheerio';
import * as url from 'url';
import * as crypto from 'crypto';

// 预编译的正则表达式
const detailIDRegex = /\/vod\/detail\/id\/(\d+)\.html/;
const quarkLinkRegex = /https?:\/\/pan\.quark\.cn\/s\/[0-9a-zA-Z]+/;
const yearRegex = /(\d{4})/;

// 超时时间优化
const DefaultTimeout = 8000;
const DetailTimeout = 6000;
// 并发数优化
const MaxConcurrency = 20;

// 缓存相关
interface CacheItem {
  result: SearchResult;
  timestamp: number;
}

const detailCache = new Map<string, CacheItem>();
let lastCleanupTime = Date.now();
const cacheTTL = 1 * 60 * 60 * 1000; // 1小时

// 性能统计
let searchRequests = 0;
let detailPageRequests = 0;
let cacheHits = 0;
let cacheMisses = 0;
let totalSearchTime = 0;
let totalDetailTime = 0;

// LabiPlugin Labi异步插件
class LabiPlugin extends BaseAsyncPlugin {
  private optimizedClient: AxiosInstance;

  constructor() {
    super("labi", 3); // 普通质量插件，优先级3
    this.optimizedClient = this.createOptimizedHTTPClient();
    
    // 启动缓存清理定时器
    this.startCacheCleaner();
  }

  // 创建优化的HTTP客户端
  private createOptimizedHTTPClient(): AxiosInstance {
    return axios.create({
      timeout: DefaultTimeout,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
        'Cache-Control': 'max-age=0',
        'Referer': 'http://xiaocge.fun/',
      },
    });
  }

  // 搜索实现
  private async searchImpl(client: AxiosInstance, keyword: string, ext: Record<string, any>): Promise<SearchResult[]> {
    // 1. 构建搜索URL
    const searchURL = `http://xiaocge.fun/index.php/vod/search/wd/${encodeURIComponent(keyword)}.html`;
    
    // 2. 发送请求（带重试机制）
    const resp = await this.doRequestWithRetry(client, searchURL);
    
    // 3. 解析搜索结果页面
    const $ = cheerio.load(resp.data);
    
    // 4. 提取搜索结果
    const results: SearchResult[] = [];
    
    $('.module-search-item').each((i, s) => {
      const result = this.parseSearchItem(cheerio.load($(s).html() || ''), keyword);
      if (result.uniqueID !== '') {
        results.push(result);
      }
    });
    
    // 5. 异步获取详情页信息
    const enhancedResults = await this.enhanceWithDetails(client, results);
    
    // 6. 关键词过滤
    return enhancedResults.filter(result => 
      result.title.toLowerCase().includes(keyword.toLowerCase()) ||
      result.content.toLowerCase().includes(keyword.toLowerCase())
    );
  }

  // 解析单个搜索结果项
  private parseSearchItem($: cheerio.Root, keyword: string): SearchResult {
    const result = new SearchResult();
    
    // 提取详情页链接和ID
    const detailLink = $('.module-item-pic a').first().attr('href') || '';
    if (!detailLink) {
      return result;
    }
    
    // 提取ID
    const matches = detailIDRegex.exec(detailLink);
    if (!matches || matches.length < 2) {
      return result;
    }
    
    const itemID = matches[1];
    result.uniqueID = `${this.pluginName}-${itemID}`;
    
    // 提取标题
    const titleElement = $('.video-info-header h3 a');
    result.title = titleElement.text().trim();
    
    // 提取资源类型/质量
    const qualityElement = $('.video-serial');
    const quality = qualityElement.text().trim();
    
    // 提取分类信息
    const tags: string[] = [];
    $('.video-info-aux .tag-link a').each((i, tag) => {
      const tagText = $(tag).text().trim();
      if (tagText) {
        tags.push(tagText);
      }
    });
    result.tags = tags;
    
    // 提取导演信息
    let director = '';
    $('.video-info-items').each((i, item) => {
      const title = $(item).find('.video-info-itemtitle').text().trim();
      if (title.includes('导演')) {
        director = $(item).find('.video-info-actor a').text().trim();
      }
    });
    
    // 提取主演信息
    const actors: string[] = [];
    $('.video-info-items').each((i, item) => {
      const title = $(item).find('.video-info-itemtitle').text().trim();
      if (title.includes('主演')) {
        $(item).find('.video-info-actor a').each((j, actor) => {
          const actorName = $(actor).text().trim();
          if (actorName) {
            actors.push(actorName);
          }
        });
      }
    });
    
    // 提取剧情简介
    let plot = '';
    $('.video-info-items').each((i, item) => {
      const title = $(item).find('.video-info-itemtitle').text().trim();
      if (title.includes('剧情')) {
        plot = $(item).find('.video-info-item').text().trim();
      }
    });

    // 提取封面图片
    const images: string[] = [];
    const picURL = $('.module-item-pic > img').attr('data-src') || '';
    if (picURL) {
      images.push(picURL);
    }

    // 构建内容描述
    const contentParts: string[] = [];
    if (quality) {
      contentParts.push(`【${quality}】`);
    }
    if (director) {
      contentParts.push(`导演：${director}`);
    }
    if (actors.length > 0) {
      const actorStr = actors.slice(0, Math.min(3, actors.length)).join('、');
      if (actors.length > 3) {
        contentParts.push(`主演：${actorStr}等`);
      } else {
        contentParts.push(`主演：${actorStr}`);
      }
    }
    if (plot) {
      contentParts.push(plot);
    }

    result.content = contentParts.join('\n');
    result.channel = '';
    result.datetime = new Date(0);
    result.links = [];
    result.images = images;

    return result;
  }

  // 异步获取详情页信息以获取下载链接
  private async enhanceWithDetails(client: AxiosInstance, results: SearchResult[]): Promise<SearchResult[]> {
    const enhancedResults: SearchResult[] = [];
    
    // 限制并发数
    const semaphore = new Semaphore(MaxConcurrency);
    
    const promises = results.map(async (result) => {
      await semaphore.acquire();
      try {
        // 从uniqueID提取ID
        const parts = result.uniqueID.split('-');
        if (parts.length < 2) {
          return result;
        }
        
        const itemID = parts[1];
        
        // 检查缓存
        const cached = this.getFromCache(itemID);
        if (cached) {
          return cached;
        }
        
        // 获取详情页链接和图片
        const { links, images } = await this.fetchDetailLinksAndImages(client, itemID);
        
        // 合并结果
        const enhancedResult = { ...result };
        enhancedResult.links = links;
        
        // 合并图片：优先使用详情页的海报，如果没有则使用搜索结果的图片
        if (images.length > 0) {
          enhancedResult.images = images;
        }
        
        // 缓存结果
        this.cacheResult(itemID, enhancedResult);
        
        return enhancedResult;
      } finally {
        semaphore.release();
      }
    });
    
    return Promise.all(promises);
  }

  // 带重试机制的HTTP请求
  private async doRequestWithRetry(client: AxiosInstance, url: string, config: AxiosRequestConfig = {}): Promise<any> {
    const maxRetries = 3;
    
    for (let i = 0; i < maxRetries; i++) {
      if (i > 0) {
        // 指数退避
        const backoff = Math.pow(2, i - 1) * 200;
        await new Promise(resolve => setTimeout(resolve, backoff));
      }
      
      try {
        const response = await client.get(url, {
          ...config,
          timeout: config.timeout || DefaultTimeout,
        });
        
        if (response.status === 200) {
          return response;
        }
      } catch (error) {
        // 继续重试
      }
    }
    
    throw new Error(`重试 ${maxRetries} 次后仍然失败`);
  }

  // 获取详情页的下载链接和图片
  private async fetchDetailLinksAndImages(client: AxiosInstance, itemID: string): Promise<{ links: Link[], images: string[] }> {
    const detailURL = `http://xiaocge.fun/index.php/vod/detail/id/${itemID}.html`;
    
    try {
      const resp = await this.doRequestWithRetry(client, detailURL, { timeout: DetailTimeout });
      const $ = cheerio.load(resp.data);
      
      const links: Link[] = [];
      const images: string[] = [];
      
      // 提取详情页的海报图片
      const posterURL = $('.module-item-pic > img').attr('data-src') || '';
      if (posterURL) {
        images.push(posterURL);
      }
      
      // 查找下载链接区域
      $('#download-list .module-row-one').each((i, s) => {
        // 从data-clipboard-text属性提取链接
        const linkURL = $(s).find('[data-clipboard-text]').attr('data-clipboard-text') || '';
        if (linkURL) {
          // 过滤掉无效链接
          if (this.isValidNetworkDriveURL(linkURL) && quarkLinkRegex.test(linkURL)) {
            const link = new Link();
            link.type = 'quark';
            link.url = linkURL;
            link.password = ''; // 夸克网盘通常不需要密码
            links.push(link);
          }
        }
        
        // 也检查直接的href属性
        $(s).find('a[href]').each((j, a) => {
          const linkURL = $(a).attr('href') || '';
          // 过滤掉无效链接
          if (this.isValidNetworkDriveURL(linkURL) && quarkLinkRegex.test(linkURL)) {
            // 避免重复添加
            const isDuplicate = links.some(existingLink => existingLink.url === linkURL);
            if (!isDuplicate) {
              const link = new Link();
              link.type = 'quark';
              link.url = linkURL;
              link.password = '';
              links.push(link);
            }
          }
        });
      });
      
      return { links, images };
    } catch (error) {
      return { links: [], images: [] };
    }
  }

  // 检查URL是否为有效的网盘链接
  private isValidNetworkDriveURL(url: string): boolean {
    // 过滤掉明显无效的链接
    if (url.includes('javascript:') || 
        url.includes('#') ||
        url === '' ||
        !url.startsWith('http')) {
      return false;
    }
    
    // 对于labi插件，只检查夸克网盘格式
    return quarkLinkRegex.test(url);
  }

  // 缓存相关方法
  private getFromCache(itemID: string): SearchResult | null {
    const cached = detailCache.get(itemID);
    if (cached) {
      const now = Date.now();
      if (now - cached.timestamp < cacheTTL) {
        return cached.result;
      } else {
        // 缓存过期，移除
        detailCache.delete(itemID);
      }
    }
    return null;
  }

  private cacheResult(itemID: string, result: SearchResult): void {
    detailCache.set(itemID, {
      result,
      timestamp: Date.now(),
    });
  }

  // 启动缓存清理定时器
  private startCacheCleaner(): void {
    setInterval(() => {
      const now = Date.now();
      detailCache.forEach((value, key) => {
        if (now - value.timestamp > cacheTTL) {
          detailCache.delete(key);
        }
      });
    }, 30 * 60 * 1000); // 每30分钟清理一次
  }
}

// 信号量实现，用于限制并发
class Semaphore {
  private count: number;
  private queue: (() => void)[] = [];

  constructor(count: number) {
    this.count = count;
  }

  async acquire(): Promise<void> {
    if (this.count > 0) {
      this.count--;
    } else {
      await new Promise<void>((resolve) => {
        this.queue.push(resolve);
      });
    }
  }

  release(): void {
    if (this.queue.length > 0) {
      const resolve = this.queue.shift();
      if (resolve) {
        resolve();
      }
    } else {
      this.count++;
    }
  }
}

// 创建并注册插件
const labiPlugin = new LabiPlugin();
registerGlobalPlugin(labiPlugin);

export type { LabiPlugin };
export const LabiPluginInstance = labiPlugin;