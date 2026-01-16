import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import cheerio from 'cheerio';
import { SearchResult, Link } from '../../types';
import { Plugin } from '../../types/plugin';


// 预编译的正则表达式
const articleIDRegex = /\?p=(\d+)/;

// 链接模式
const linkPatterns = [
  { reg: /https?:\/\/pan\.quark\.cn\/s\/[0-9A-Za-z]+/, typ: 'quark' },
  { reg: /https?:\/\/www\.aliyundrive\.com\/s\/[0-9A-Za-z]+/, typ: 'aliyun' },
  { reg: /https?:\/\/www\.aliyundrive\.com\/drive\/folder\/[0-9A-Za-z]+/, typ: 'aliyun' }
];

// 密码模式
const pwdPatterns = [
  /提取码[:：]?\s*([0-9A-Za-z]+)/,
  /密码[:：]?\s*([0-9A-Za-z]+)/,
  /pwd\s*[=:：]\s*([0-9A-Za-z]+)/,
  /code\s*[=:：]\s*([0-9A-Za-z]+)/
];

// 缓存相关
interface CacheEntry {
  links: Link[];
  expiresAt: number;
}

const detailCache = new Map<string, CacheEntry>();
const cacheTTL = 1 * 60 * 60 * 1000; // 1 hour
const cacheCleanupInterval = 30 * 60 * 1000; // 30 minutes

// 常量定义
const pluginName = 'alupan';
const defaultPriority = 2;
const searchTimeout = 12000; // 12 seconds
const detailTimeout = 10000; // 10 seconds
const maxConcurrency = 12;
const maxIdleConns = 64;
const maxIdlePerHost = 16;
const maxConnsPerHost = 32;
const idleConnLifetime = 90 * 1000; // 90 seconds
const tlsHandshakeTimeout = 10 * 1000; // 10 seconds
const expectContinueTimeout = 1 * 1000; // 1 second
const searchMaxRetries = 3;
const detailMaxRetries = 2;
const retryBaseDelay = 200; // milliseconds

// 性能统计
let searchRequests = 0;
let detailPageRequests = 0;
let cacheHits = 0;
let cacheMisses = 0;

class AlupanPlugin implements Plugin {
  private client: AxiosInstance;

  constructor() {
    this.client = axios.create({
      timeout: searchTimeout,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });

    // 启动缓存清理器
    this.startCacheCleaner();
  }

  name(): string {
    return pluginName;
  }

  displayName(): string {
    return 'alupan';
  }

  description(): string {
    return 'alupan - 网盘资源搜索';
  }

  async search(keyword: string, ext: Record<string, any>): Promise<SearchResult[]> {
    return this.searchImpl(keyword, ext);
  }

  private async searchImpl(keyword: string, ext: Record<string, any>): Promise<SearchResult[]> {
    const startTime = Date.now();
    searchRequests++;

    try {
      // 构建搜索URL
      const searchURL = `https://www.aliupan.com/?s=${encodeURIComponent(keyword)}`;

      // 发送请求（带重试机制）
      const config: AxiosRequestConfig = {
        method: 'GET',
        url: searchURL,
        headers: this.getCommonHeaders('https://www.aliupan.com/')
      };

      const resp = await this.doRequestWithRetry(config, searchMaxRetries);

      // 解析搜索结果页面
      const $ = cheerio.load(resp.data);

      // 提取搜索结果
      const results: SearchResult[] = [];
      const semaphore = this.createSemaphore(maxConcurrency);

      const promises = [];

      $('article.excerpt').each((_, item) => {
        const promise = async () => {
          await semaphore.acquire();
          try {
            // 提取标题和详情页链接
            const titleSel = $(item).find('header h2 a');
            const title = titleSel.text().trim();
            const detailURL = titleSel.attr('href');

            if (!detailURL || title === '') {
              return;
            }

            // 提取文章ID
            const articleID = this.extractArticleID(detailURL);
            if (articleID === '') {
              return;
            }

            // 提取分类标签
            const category = $(item).find('header .label').first().text().trim();
            const tags: string[] = [];
            if (category) {
              tags.push(category);
            }

            // 提取摘要
            const summary = $(item).find('p.note').text().trim();

            // 提取发布时间
            const timeText = $(item).find('p .icon-time').parent().text().trim();
            const publishTime = this.parsePublishTime(timeText);

            // 抓取详情页获取网盘链接
            const links = await this.fetchDetailLinks(detailURL, articleID);

            if (links.length > 0) {
              const result: SearchResult = {
                uniqueId: `${this.name()}-${articleID}`,
                title: title,
                content: summary,
                links: links,
                tags: tags,
                channel: '',
                datetime: publishTime,
                images: [],
                pluginName: this.name(),
                displayName: this.displayName()
              };

              results.push(result);
            }
          } catch (error) {
            console.error(`[${this.name()}] 处理搜索结果失败:`, error);
          } finally {
            semaphore.release();
          }
        };

        promises.push(promise());
      });

      // 等待所有请求完成
      await Promise.all(promises);

      // 过滤结果
      const filteredResults = this.filterResultsByKeyword(results, keyword);

      console.log(`[${this.name()}] 搜索结果: ${filteredResults.length} 条`);
      console.log(`[${this.name()}] 搜索耗时: ${Date.now() - startTime}ms`);

      return filteredResults;
    } catch (error) {
      console.error(`[${this.name()}] 搜索失败:`, error);
      return [];
    }
  }

  private extractArticleID(detailURL: string): string {
    const matches = articleIDRegex.exec(detailURL);
    if (matches && matches.length >= 2) {
      return matches[1];
    }
    return '';
  }

  private parsePublishTime(value: string): Date {
    value = value.trim();
    if (!value) {
      return new Date();
    }

    // 处理包含括号的时间格式
    if (value.includes('(') && value.endsWith(')')) {
      const idx = value.indexOf('(');
      value = value.substring(idx + 1, value.length - 1).trim();
    }

    // 尝试多种日期格式
    const layouts = [
      'YYYY-MM-DD',
      'YYYY/MM/DD',
      'YYYY年MM月DD日'
    ];

    // 简单处理，直接尝试转换
    const date = new Date(value);
    if (!isNaN(date.getTime())) {
      return date;
    }

    // 默认返回当前时间
    return new Date();
  }

  private async fetchDetailLinks(detailURL: string, articleID: string): Promise<Link[]> {
    detailPageRequests++;

    // 检查缓存
    const cached = this.getFromCache(articleID);
    if (cached) {
      return cached;
    }

    try {
      // 发送请求（带重试机制）
      const config: AxiosRequestConfig = {
        method: 'GET',
        url: detailURL,
        headers: this.getCommonHeaders(detailURL),
        timeout: detailTimeout
      };

      const resp = await this.doRequestWithRetry(config, detailMaxRetries);

      // 解析详情页
      const $ = cheerio.load(resp.data);

      // 提取网盘链接
      const links = this.extractNetDiskLinks($);

      // 缓存结果
      if (links.length > 0) {
        this.cacheResult(articleID, links);
      }

      return links;
    } catch (error) {
      console.error(`[${this.name()}] 详情页请求失败:`, error);
      return [];
    }
  }

  private extractNetDiskLinks($: cheerio.Root): Link[] {
    const results: Link[] = [];
    const seen = new Set<string>();

    // 从文章内容中提取链接
    $('.article-content a[href]').each((_, node) => {
      const href = $(node).attr('href');
      if (!href) {
        return;
      }

      const trimmedHref = href.trim();
      if (!trimmedHref) {
        return;
      }

      // 分类链接
      const { linkType, normalized } = this.classifyLink(trimmedHref);
      if (!linkType) {
        return;
      }

      // 去重
      if (seen.has(normalized)) {
        return;
      }

      // 提取密码
      const password = this.extractPassword($(node));

      // 添加到结果
      results.push({
        url: normalized,
        type: linkType,
        password: password
      });

      seen.add(normalized);
    });

    return results;
  }

  private classifyLink(raw: string): { linkType: string; normalized: string } {
    for (const pattern of linkPatterns) {
      const match = raw.match(pattern.reg);
      if (match && match[0]) {
        return {
          linkType: pattern.typ,
          normalized: match[0]
        };
      }
    }
    return {
      linkType: '',
      normalized: ''
    };
  }

  private extractPassword(link: cheerio.Cheerio): string {
    const candidates: string[] = [
      link.text()
    ];

    // 从 title 属性中提取
    const title = link.attr('title');
    if (title) {
      candidates.push(title);
    }

    // 从父元素和兄弟元素中提取
    const parent = link.parent();
    if (parent.length > 0) {
      candidates.push(parent.text());
      const next = parent.next();
      if (next.length > 0) {
        candidates.push(next.text());
      }
    }

    // 从兄弟元素中提取
    const next = link.next();
    if (next.length > 0) {
      candidates.push(next.text());
    }

    // 匹配密码模式
    for (const text of candidates) {
      const password = this.matchPassword(text);
      if (password) {
        return password;
      }
    }

    return '';
  }

  private matchPassword(text: string): string {
    text = text.trim();
    if (!text) {
      return '';
    }

    for (const pattern of pwdPatterns) {
      const matches = pattern.exec(text);
      if (matches && matches.length >= 2) {
        return matches[1].trim();
      }
    }

    return '';
  }

  private getCommonHeaders(referer: string): Record<string, string> {
    return {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'Connection': 'keep-alive',
      'Referer': referer
    };
  }

  private async doRequestWithRetry(config: AxiosRequestConfig, maxRetries: number): Promise<any> {
    let lastErr: any;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const resp = await this.client(config);
        if (resp.status === 200) {
          return resp;
        }
      } catch (error) {
        lastErr = error;
      }

      if (attempt < maxRetries - 1) {
        // 指数退避
        const backoff = retryBaseDelay * Math.pow(2, attempt);
        await this.sleep(backoff);
      }
    }

    throw new Error(`重试 ${maxRetries} 次后失败: ${lastErr}`);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private createSemaphore(maxConcurrency: number): {
    acquire: () => Promise<void>;
    release: () => void;
  } {
    let count = 0;
    const queue: (() => void)[] = [];

    return {
      acquire: async () => {
        if (count < maxConcurrency) {
          count++;
        } else {
          await new Promise<void>(resolve => queue.push(resolve));
        }
      },
      release: () => {
        count--;
        if (queue.length > 0) {
          const resolve = queue.shift();
          if (resolve) resolve();
        }
      }
    };
  }

  private filterResultsByKeyword(results: SearchResult[], keyword: string): SearchResult[] {
    if (!keyword) {
      return results;
    }

    const lowerKeyword = keyword.toLowerCase();
    const parts = lowerKeyword.split(/\s+/);

    return results.filter(result => {
      const target = `${result.title} ${result.content}`.toLowerCase();
      return parts.every(part => target.includes(part));
    });
  }

  private getFromCache(articleID: string): Link[] | null {
    const cached = detailCache.get(articleID);
    if (cached && Date.now() < cached.expiresAt) {
      cacheHits++;
      return cached.links;
    }
    cacheMisses++;
    return null;
  }

  private cacheResult(articleID: string, links: Link[]): void {
    detailCache.set(articleID, {
      links: links,
      expiresAt: Date.now() + cacheTTL
    });
  }

  private startCacheCleaner(): void {
    setInterval(() => {
      const now = Date.now();
      detailCache.forEach((value, key) => {
        if (now > value.expiresAt) {
          detailCache.delete(key);
        }
      });
    }, cacheCleanupInterval);
  }
}

// 导出插件实例
const plugin = new AlupanPlugin();
export default plugin;