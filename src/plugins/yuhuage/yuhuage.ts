import { SearchResult, Link, PluginSearchResult } from '../../models/plugin-result';
import { BaseAsyncPlugin } from '../plugin.manager';
import axios, { AxiosInstance, AxiosResponse } from 'axios';
import * as cheerio from 'cheerio';

// 常量定义
const BaseURL = 'https://www.iyuhuage.fun';
const SearchPath = '/search/';
const UserAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36';
const MaxConcurrency = 5; // 详情页最大并发数
const MaxRetryCount = 2; // 最大重试次数
const CacheTTL = 30 * 60 * 1000; // 缓存过期时间（毫秒）

class YuhuagePlugin extends BaseAsyncPlugin {
  private debugMode: boolean;
  private detailCache: Map<string, Link[]>;
  private cacheTTL: number;
  private rateLimited: boolean;

  constructor() {
    super('yuhuage', 3);
    this.debugMode = false;
    this.detailCache = new Map<string, Link[]>();
    this.cacheTTL = CacheTTL;
    this.rateLimited = false;
  }

  public async Search(keyword: string, ext: Record<string, any>): Promise<SearchResult[]> {
    const result = await this.SearchWithResult(keyword, ext);
    return result.Results;
  }

  public async SearchWithResult(keyword: string, ext: Record<string, any>): Promise<PluginSearchResult> {
    return this.AsyncSearchWithResult(keyword, this.searchImpl.bind(this), this.MainCacheKey, ext);
  }

  private async searchImpl(client: AxiosInstance, keyword: string, ext: Record<string, any>): Promise<SearchResult[]> {
    if (this.debugMode) {
      console.log(`[YUHUAGE] 开始搜索: ${keyword}`);
    }

    // 检查限流状态
    if (this.rateLimited) {
      if (this.debugMode) {
        console.log('[YUHUAGE] 当前处于限流状态，跳过搜索');
      }
      throw new Error('rate limited');
    }

    // 构建搜索URL
    const encodedQuery = encodeURIComponent(keyword);
    const searchURL = `${BaseURL}${SearchPath}${encodedQuery}-1-time.html`;
    
    try {
      // 发送HTTP请求
      const resp = await this.doRequestWithRetry(this.client, searchURL);
      
      if (resp.status === 429) {
        this.rateLimited = true;
        // 60秒后解除限流
        setTimeout(() => {
          this.rateLimited = false;
        }, 60000);
        throw new Error(`[${this.Name()}] 请求被限流`);
      }
      
      if (resp.status !== 200) {
        throw new Error(`[${this.Name()}] HTTP错误: ${resp.status}`);
      }
      
      // 解析搜索结果
      const results = await this.parseSearchResults(resp.data);

      if (this.debugMode) {
        console.log(`[YUHUAGE] 搜索完成，获得 ${results.length} 个结果`);
      }

      // 关键词过滤
      return this.FilterResultsByKeyword(results, keyword);
    } catch (error) {
      throw error;
    }
  }

  private async parseSearchResults(html: string): Promise<SearchResult[]> {
    const $ = cheerio.load(html);

    const results: SearchResult[] = [];
    const detailURLs: string[] = [];

    // 提取搜索结果
    $('.search-item.detail-width').each((i, s) => {
      const title = this.cleanTitle($(s).find('.item-title h3 a').text()).trim();
      const detailHref = $(s).find('.item-title h3 a').attr('href');
      
      if (!detailHref || title === '') {
        return;
      }

      const detailURL = BaseURL + detailHref;
      detailURLs.push(detailURL);

      // 提取基本信息
      const createTime = $(s).find('.item-bar span:contains(创建时间) b').text().trim();
      const size = $(s).find('.item-bar .cpill.blue-pill').text().trim();
      const fileCount = $(s).find('.item-bar .cpill.yellow-pill').text().trim();
      const hot = $(s).find('.item-bar span:contains(热度) b').text().trim();
      const lastDownload = $(s).find('.item-bar span:contains(最近下载) b').text().trim();

      // 构建内容描述
      let content = `创建时间: ${createTime} | 大小: ${size} | 文件数: ${fileCount} | 热度: ${hot}`;
      if (lastDownload) {
        content += ` | 最近下载: ${lastDownload}`;
      }

      const result: SearchResult = {
        Title: title,
        Content: content,
        Channel: '', // 插件搜索结果必须为空字符串
        Tags: ['磁力链接'],
        Datetime: this.parseDateTime(createTime),
        UniqueID: `${this.Name()}-${this.extractHashFromURL(detailURL)}`,
        Links: [],
      };

      results.push(result);
    });

    if (this.debugMode) {
      console.log(`[YUHUAGE] 解析到 ${results.length} 个搜索结果，准备获取详情`);
    }

    // 并发获取详情页链接
    await this.fetchDetailsAsync(detailURLs, results);

    return results;
  }

  private async fetchDetailsAsync(detailURLs: string[], results: SearchResult[]): Promise<void> {
    if (detailURLs.length === 0) {
      return;
    }

    const semaphore = new Semaphore(MaxConcurrency);
    const promises: Promise<void>[] = [];

    for (let i = 0; i < detailURLs.length; i++) {
      if (i >= results.length) {
        break;
      }

      promises.push((async () => {
        await semaphore.acquire();
        try {
          const links = await this.fetchDetailLinks(detailURLs[i]);
          if (links.length > 0) {
            results[i].Links = links;
            if (this.debugMode) {
              console.log(`[YUHUAGE] 为结果设置了 ${links.length} 个链接`);
            }
          } else if (this.debugMode) {
            console.log(`[YUHUAGE] 详情页没有找到有效链接: ${detailURLs[i]}`);
          }
        } finally {
          semaphore.release();
        }
      })());
    }

    await Promise.all(promises);
    
    if (this.debugMode) {
      console.log('[YUHUAGE] 详情页获取完成');
    }
  }

  private async fetchDetailLinks(detailURL: string): Promise<Link[]> {
    // 检查缓存
    if (this.detailCache.has(detailURL)) {
      return this.detailCache.get(detailURL)!;
    }

    const client = axios.create({
      timeout: 15000,
      headers: {
        'User-Agent': UserAgent,
        'Referer': BaseURL + '/',
      },
    });

    for (let retry = 0; retry <= MaxRetryCount; retry++) {
      try {
        const resp = await client.get(detailURL);
        
        if (resp.status !== 200) {
          if (retry < MaxRetryCount) {
            await new Promise(resolve => setTimeout(resolve, (retry + 1) * 1000));
            continue;
          }
          break;
        }
        
        const links = this.parseDetailLinks(resp.data);
        
        // 缓存结果
        if (links.length > 0) {
          this.detailCache.set(detailURL, links);
          // 设置缓存过期
          setTimeout(() => {
            this.detailCache.delete(detailURL);
          }, this.cacheTTL);
        }
        
        return links;
      } catch (error) {
        if (retry < MaxRetryCount) {
          await new Promise(resolve => setTimeout(resolve, (retry + 1) * 1000));
          continue;
        }
        break;
      }
    }

    return [];
  }

  private parseDetailLinks(html: string): Link[] {
    const links: Link[] = [];

    const $ = cheerio.load(html);

    // 提取磁力链接
    $('a.download[href^="magnet:"]').each((i, s) => {
      const href = $(s).attr('href');
      if (href && href !== '') {
        if (this.debugMode) {
          console.log(`[YUHUAGE] 找到磁力链接: ${href}`);
        }
        links.push({
          URL: href,
          Type: 'magnet',
        });
      }
    });

    // 提取迅雷链接
    $('a.download[href^="thunder:"]').each((i, s) => {
      const href = $(s).attr('href');
      if (href && href !== '') {
        if (this.debugMode) {
          console.log(`[YUHUAGE] 找到迅雷链接: ${href}`);
        }
        links.push({
          URL: href,
          Type: 'others',
        });
      }
    });

    if (this.debugMode && links.length > 0) {
      console.log(`[YUHUAGE] 从详情页解析到 ${links.length} 个链接`);
    }

    return links;
  }

  private extractHashFromURL(detailURL: string): string {
    const re = /\/hash\/(\d+)\.html/;
    const matches = re.exec(detailURL);
    if (matches && matches.length > 1) {
      return matches[1];
    }
    return '';
  }

  private cleanTitle(title: string): string {
    let cleaned = title.trim();
    // 移除HTML标签（如<b>标签）
    cleaned = cleaned.replace(/<[^>]*>/g, '');
    // 移除多余的空格
    cleaned = cleaned.replace(/\s+/g, ' ');
    return cleaned.trim();
  }

  private parseDateTime(timeStr: string): Date {
    if (timeStr === '') {
      return new Date(0);
    }

    // 尝试不同的时间格式
    const formats = [
      'YYYY-MM-DD HH:mm:ss',
      'YYYY-MM-DD',
      'YYYY/MM/DD HH:mm:ss',
      'YYYY/MM/DD',
    ];

    for (const format of formats) {
      const date = this.parseDate(timeStr, format);
      if (date.getTime() > 0) {
        return date;
      }
    }

    return new Date(0);
  }

  private parseDate(dateString: string, format: string): Date {
    if (format === 'YYYY-MM-DD') {
      const parts = dateString.split('-');
      if (parts.length === 3) {
        const year = parseInt(parts[0]);
        const month = parseInt(parts[1]) - 1;
        const day = parseInt(parts[2]);
        return new Date(year, month, day);
      }
    } else if (format === 'YYYY-MM-DD HH:mm:ss') {
      const parts = dateString.split(' ');
      if (parts.length === 2) {
        const dateParts = parts[0].split('-');
        const timeParts = parts[1].split(':');
        if (dateParts.length === 3 && timeParts.length === 3) {
          const year = parseInt(dateParts[0]);
          const month = parseInt(dateParts[1]) - 1;
          const day = parseInt(dateParts[2]);
          const hour = parseInt(timeParts[0]);
          const minute = parseInt(timeParts[1]);
          const second = parseInt(timeParts[2]);
          return new Date(year, month, day, hour, minute, second);
        }
      }
    } else if (format === 'YYYY/MM/DD') {
      const parts = dateString.split('/');
      if (parts.length === 3) {
        const year = parseInt(parts[0]);
        const month = parseInt(parts[1]) - 1;
        const day = parseInt(parts[2]);
        return new Date(year, month, day);
      }
    } else if (format === 'YYYY/MM/DD HH:mm:ss') {
      const parts = dateString.split(' ');
      if (parts.length === 2) {
        const dateParts = parts[0].split('/');
        const timeParts = parts[1].split(':');
        if (dateParts.length === 3 && timeParts.length === 3) {
          const year = parseInt(dateParts[0]);
          const month = parseInt(dateParts[1]) - 1;
          const day = parseInt(dateParts[2]);
          const hour = parseInt(timeParts[0]);
          const minute = parseInt(timeParts[1]);
          const second = parseInt(timeParts[2]);
          return new Date(year, month, day, hour, minute, second);
        }
      }
    }
    return new Date(0);
  }

  private async doRequestWithRetry(client: AxiosInstance, url: string): Promise<AxiosResponse> {
    const maxRetries = 3;
    let lastError: Error | null = null;

    for (let i = 0; i < maxRetries; i++) {
      if (i > 0) {
        // 指数退避重试
        const backoff = Math.pow(2, i - 1) * 200;
        await new Promise(resolve => setTimeout(resolve, backoff));
      }

      try {
        const resp = await client.get(url, {
          headers: {
            'User-Agent': UserAgent,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
            'Connection': 'keep-alive',
            'Referer': BaseURL + '/',
          },
        });
        if (resp.status === 200) {
          return resp;
        }
      } catch (error) {
        lastError = error as Error;
      }
    }

    throw new Error(`重试 ${maxRetries} 次后仍然失败: ${lastError?.message}`);
  }

  private get client(): AxiosInstance {
    return axios.create({
      timeout: 30000,
      headers: {
        'User-Agent': UserAgent,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Connection': 'keep-alive',
        'Referer': BaseURL + '/',
      },
    });
  }
}

// 信号量实现，用于限制并发数
class Semaphore {
  private maxConcurrency: number;
  private current: number;
  private queue: (() => void)[];

  constructor(maxConcurrency: number) {
    this.maxConcurrency = maxConcurrency;
    this.current = 0;
    this.queue = [];
  }

  async acquire(): Promise<void> {
    if (this.current < this.maxConcurrency) {
      this.current++;
      return;
    }

    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
  }

  release(): void {
    if (this.queue.length > 0) {
      const resolve = this.queue.shift()!;
      resolve();
    } else {
      this.current--;
    }
  }
}

// 注册插件
BaseAsyncPlugin.RegisterGlobalPlugin(new YuhuagePlugin());
