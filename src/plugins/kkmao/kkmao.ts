import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import cheerio from 'cheerio';
import { SearchResult, Link } from '../../types';
import { Plugin } from '../../types/plugin';

const pluginName = 'kkmao';
const defaultPriority = 2;
const searchTimeout = 12000; // 12 seconds in milliseconds
const detailTimeout = 10000; // 10 seconds in milliseconds
const maxConcurrency = 8;
const cacheTTL = 3600000; // 1 hour in milliseconds
const cacheCleanupInterval = 1800000; // 30 minutes in milliseconds
const searchMaxRetries = 3;
const detailMaxRetries = 2;
const retryBaseDelay = 200; // 200 milliseconds

const articleIDRegex = /\/(\d+)\.html/;
const quarkRegex = /https?:\/\/pan\.quark\.cn\/s\/[0-9A-Za-z]+/;

const pwdPatterns = [
  /提取码[:：]?\s*([0-9A-Za-z]+)/,
  /密码[:：]?\s*([0-9A-Za-z]+)/,
  /pwd\s*[=:：]\s*([0-9A-Za-z]+)/,
  /code\s*[=:：]\s*([0-9A-Za-z]+)/,
];

interface DetailCacheEntry {
  links: Link[];
  expiresAt: number;
}

class KkMaoPlugin implements Plugin {
  private client: AxiosInstance;
  private detailCache: Map<string, DetailCacheEntry> = new Map();

  constructor() {
    this.client = axios.create({
      timeout: searchTimeout,
      maxRedirects: 5,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });

    // 启动缓存清理器
    this.startDetailCacheCleaner();
  }

  name(): string {
    return pluginName;
  }

  displayName(): string {
    return '夸克猫';
  }

  description(): string {
    return '夸克猫 - 网盘资源搜索';
  }

  async search(keyword: string, ext: Record<string, any>): Promise<SearchResult[]> {
    return this.searchImpl(keyword, ext);
  }

  private async searchImpl(keyword: string, ext: Record<string, any>): Promise<SearchResult[]> {
    const searchURL = `https://www.kuakemao.com/?s=${encodeURIComponent(keyword)}`;

    try {
      const config: AxiosRequestConfig = {
        method: 'GET',
        url: searchURL,
        headers: this.getCommonHeaders('https://www.kuakemao.com/'),
        timeout: searchTimeout
      };

      const resp = await this.doRequestWithRetry(config, searchMaxRetries, retryBaseDelay);

      const $ = cheerio.load(resp.data);
      const results: SearchResult[] = [];
      const semaphore = this.createSemaphore(maxConcurrency);

      const promises = [];

      $('article.excerpt').each((_, item) => {
        const $item = $(item);
        const titleSel = $item.find('header h2 a');
        const title = titleSel.text().trim();
        const detailURL = titleSel.attr('href');

        if (!detailURL || title === '') {
          return;
        }

        const articleID = this.extractArticleID(detailURL);
        if (articleID === '') {
          return;
        }

        const summary = $item.find('p.note').text().trim();

        const tags = [];
        const category = $item.find('.meta a.cat').first().text().trim();
        if (category !== '') {
          tags.push(category);
        }

        const rawTime = $item.find('.meta time').text().trim();
        const publishTime = this.parsePublishTime(rawTime);

        const promise = async () => {
          await semaphore.acquire();
          try {
            const links = await this.fetchDetailLinks(detailURL, articleID);
            if (links.length > 0) {
              const uniqueID = `${this.name()}-${articleID}`;

              const result: SearchResult = {
                uniqueId: uniqueID,
                title: title,
                content: summary,
                datetime: publishTime,
                links: links,
                channel: '',
                tags: tags,
                images: [],
                pluginName: this.name(),
                displayName: this.displayName()
              };

              results.push(result);
            }
          } catch (error) {
            console.error(`[${this.name()}] 处理文章失败:`, error);
          } finally {
            semaphore.release();
          }
        };

        promises.push(promise());
      });

      await Promise.all(promises);

      return this.filterResultsByKeyword(results, keyword);
    } catch (error) {
      throw new Error(`[${this.name()}] 搜索失败: ${error}`);
    }
  }

  private extractArticleID(detailURL: string): string {
    const matches = articleIDRegex.exec(detailURL);
    if (matches && matches[1]) {
      return matches[1];
    }
    return '';
  }

  private parsePublishTime(value: string): Date {
    const trimmedValue = value.trim();
    if (trimmedValue === '') {
      return new Date();
    }

    const layouts = [
      'YYYY-MM-DD',
      'YYYY-MM-DD HH:mm:ss'
    ];

    for (const layout of layouts) {
      const date = new Date(trimmedValue);
      if (!isNaN(date.getTime())) {
        return date;
      }
    }

    return new Date();
  }

  private async fetchDetailLinks(detailURL: string, articleID: string): Promise<Link[]> {
    // 检查缓存
    const cached = this.detailCache.get(articleID);
    if (cached && Date.now() < cached.expiresAt) {
      return cached.links;
    }

    try {
      const config: AxiosRequestConfig = {
        method: 'GET',
        url: detailURL,
        headers: this.getCommonHeaders(detailURL),
        timeout: detailTimeout
      };

      const resp = await this.doRequestWithRetry(config, detailMaxRetries, retryBaseDelay);

      const $ = cheerio.load(resp.data);
      const links = this.extractQuarkLinks($);

      if (links.length > 0) {
        // 更新缓存
        this.detailCache.set(articleID, {
          links: links,
          expiresAt: Date.now() + cacheTTL
        });
      }

      return links;
    } catch (error) {
      console.error(`[${this.name()}] 获取详情链接失败:`, error);
      return [];
    }
  }

  private extractQuarkLinks($: cheerio.Root): Link[] {
    const results: Link[] = [];
    const seen = new Set<string>();

    $('.article-content a[href]').each((_, link) => {
      const $link = $(link);
      const href = $link.attr('href')?.trim();
      if (!href) return;

      const match = quarkRegex.exec(href);
      if (!match) return;

      const loc = match[0];
      if (seen.has(loc)) return;

      const password = this.extractPassword($link);

      results.push({
        url: loc,
        type: 'quark',
        password: password
      });

      seen.add(loc);
    });

    return results;
  }

  private extractPassword(link: cheerio.Cheerio): string {
    if (this.matchPassword(link.text())) {
      return this.matchPassword(link.text());
    }

    const title = link.attr('title');
    if (title && this.matchPassword(title)) {
      return this.matchPassword(title);
    }

    const parent = link.parent();
    if (parent && parent.length > 0) {
      if (this.matchPassword(parent.text())) {
        return this.matchPassword(parent.text());
      }
      const next = parent.next();
      if (next && next.length > 0) {
        if (this.matchPassword(next.text())) {
          return this.matchPassword(next.text());
        }
      }
    }

    const sibling = link.next();
    if (sibling && sibling.length > 0) {
      if (this.matchPassword(sibling.text())) {
        return this.matchPassword(sibling.text());
      }
    }

    return '';
  }

  private matchPassword(text: string): string {
    const trimmedText = text.trim();
    if (trimmedText === '') {
      return '';
    }

    for (const pattern of pwdPatterns) {
      const match = pattern.exec(trimmedText);
      if (match && match[1]) {
        return match[1].trim();
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

  private async doRequestWithRetry(config: AxiosRequestConfig, maxRetries: number, baseDelay: number): Promise<any> {
    let lastError: any;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const resp = await this.client(config);
        if (resp.status === 200) {
          return resp;
        }
      } catch (error) {
        lastError = error;
      }

      if (attempt < maxRetries - 1) {
        const backoff = baseDelay * (1 << attempt);
        await this.sleep(backoff);
      }
    }

    throw new Error(`重试 ${maxRetries} 次后失败: ${lastError}`);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private startDetailCacheCleaner(): void {
    setInterval(() => {
      const now = Date.now();
      this.detailCache.forEach((value, key) => {
        if (now > value.expiresAt) {
          this.detailCache.delete(key);
        }
      });
    }, cacheCleanupInterval);
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
}

// 导出插件实例
const plugin = new KkMaoPlugin();
export default plugin;