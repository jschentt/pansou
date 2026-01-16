import { SearchResult, Link, PluginSearchResult } from '../../models/plugin-result';
import { BaseAsyncPlugin } from '../plugin.manager';
import axios, { AxiosInstance, AxiosResponse } from 'axios';
import * as cheerio from 'cheerio';

// 正则表达式
const articleIDRegex = /\/post\/(\d+)\.html/;
const urlRegex = /https?:\/\/[^\s<>'"]+/;

// 链接模式
const linkPatterns = [
  { reg: /https?:\/\/pan\.quark\.cn\/s\/[0-9A-Za-z]+/, typ: 'quark' },
  { reg: /https?:\/\/pan\.quark\.cn\/g\/[0-9A-Za-z]+/, typ: 'quark' },
  { reg: /https?:\/\/www\.aliyundrive\.com\/s\/[0-9A-Za-z]+/, typ: 'aliyun' },
  { reg: /https?:\/\/www\.aliyundrive\.com\/drive\/folder\/[0-9A-Za-z]+/, typ: 'aliyun' },
  { reg: /https?:\/\/pan\.baidu\.com\/s\/[0-9A-Za-z\-_]+/, typ: 'baidu' },
  { reg: /https?:\/\/pan\.xunlei\.com\/s\/[0-9A-Za-z\-_]+/, typ: 'xunlei' },
  { reg: /https?:\/\/123pan\.com\/s\/[0-9A-Za-z]+/, typ: '123' },
];

// 密码模式
const pwdPatterns = [
  /提取码[:：]?\s*([0-9A-Za-z]+)/,
  /密码[:：]?\s*([0-9A-Za-z]+)/,
  /pwd\s*[=:：]\s*([0-9A-Za-z]+)/,
  /code\s*[=:：]\s*([0-9A-Za-z]+)/,
];

// 缓存配置
const cacheTTL = 1 * 60 * 60 * 1000; // 1小时
const cacheCleanupInterval = 30 * 60 * 1000; // 30分钟

// 缓存条目接口
interface CacheEntry {
  links: Link[];
  expiresAt: Date;
}

// 常量定义
const pluginName = 'ypfxw';
const defaultPriority = 2;
const searchTimeout = 12000; // 12秒
const detailTimeout = 10000; // 10秒
const maxConcurrency = 12;
const searchMaxRetries = 3;
const detailMaxRetries = 2;
const retryBaseDelay = 200; // 200毫秒

// 缓存实例
class DetailCache {
  private cache: Map<string, CacheEntry>;
  private cleanupInterval: NodeJS.Timeout | null;

  constructor() {
    this.cache = new Map<string, CacheEntry>();
    this.startCacheCleaner();
  }

  get(key: string): Link[] | null {
    const entry = this.cache.get(key);
    if (entry && entry.expiresAt > new Date() && entry.links.length > 0) {
      return entry.links;
    }
    this.cache.delete(key);
    return null;
  }

  set(key: string, links: Link[]): void {
    if (links.length > 0) {
      this.cache.set(key, {
        links,
        expiresAt: new Date(Date.now() + cacheTTL),
      });
    }
  }

  delete(key: string): void {
    this.cache.delete(key);
  }

  private startCacheCleaner(): void {
    this.cleanupInterval = setInterval(() => {
      const now = new Date();
      this.cache.forEach((entry, key) => {
        if (entry.expiresAt <= now) {
          this.cache.delete(key);
        }
      });
    }, cacheCleanupInterval);
  }

  stopCacheCleaner(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }
}

// 全局缓存实例
const detailCache = new DetailCache();

class YpfxwPlugin extends BaseAsyncPlugin {
  private client: AxiosInstance;

  constructor() {
    super(pluginName, defaultPriority);
    this.client = this.createHttpClient();
  }

  public async Search(keyword: string, ext: Record<string, any>): Promise<SearchResult[]> {
    const result = await this.SearchWithResult(keyword, ext);
    return result.Results;
  }

  public async SearchWithResult(keyword: string, ext: Record<string, any>): Promise<PluginSearchResult> {
    return this.AsyncSearchWithResult(keyword, this.searchImpl.bind(this), this.MainCacheKey, ext);
  }

  private createHttpClient(): AxiosInstance {
    return axios.create({
      timeout: searchTimeout,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Connection': 'keep-alive',
      },
    });
  }

  private async searchImpl(client: AxiosInstance, keyword: string, ext: Record<string, any>): Promise<SearchResult[]> {
    const searchURL = `https://ypfxw.com/search.php?q=${encodeURIComponent(keyword)}`;

    const resp = await this.doRequestWithRetry(this.client, searchURL, searchMaxRetries);

    if (resp.status !== 200) {
      throw new Error(`[${this.Name()}] 搜索返回状态码: ${resp.status}`);
    }

    const $ = cheerio.load(resp.data);

    const results: SearchResult[] = [];
    const detailURLs: { title: string; detailURL: string; summary: string; tags: string[]; publishTime: Date; articleID: string }[] = [];

    // 提取搜索结果
    $('div.list ul > li').each((_i, item) => {
      const titleSel = $(item).find('div.imgr h2 a');
      const title = titleSel.text().trim();
      const detailURL = titleSel.attr('href');

      if (!detailURL || title === '') {
        return;
      }

      const articleID = this.extractArticleID(detailURL);
      if (articleID === '') {
        return;
      }

      const summary = $(item).find('div.imgr p').first().text().trim();

      const category = $(item).find('.info span').first().text().trim();
      const tags: string[] = [];
      if (category !== '') {
        tags.push(category.trim());
      }
      $(item).find('.info span.tag a').each((_j, tag) => {
        const tagText = $(tag).text().trim();
        if (tagText !== '') {
          tags.push(tagText);
        }
      });

      let timeText = '';
      const timeNode = $(item).find('.info span i.fa-clock-o').parent();
      if (timeNode.length > 0) {
        timeText = timeNode.text().trim();
      }
      const publishTime = this.parsePublishTime(timeText);

      detailURLs.push({
        title,
        detailURL,
        summary,
        tags,
        publishTime,
        articleID,
      });
    });

    // 并发获取详情页链接
    const semaphore = new Semaphore(maxConcurrency);
    const promises: Promise<void>[] = [];

    for (const { title, detailURL, summary, tags, publishTime, articleID } of detailURLs) {
      promises.push((async () => {
        await semaphore.acquire();
        try {
          const links = await this.fetchDetailLinks(this.client, detailURL, articleID);
          if (links.length > 0) {
            results.push({
              UniqueID: `${this.Name()}-${articleID}`,
              Title: title,
              Content: summary,
              Links: links,
              Tags: tags,
              Channel: '',
              Datetime: publishTime,
            });
          }
        } finally {
          semaphore.release();
        }
      })());
    }

    await Promise.all(promises);

    // 关键词过滤
    return this.FilterResultsByKeyword(results, keyword);
  }

  private extractArticleID(detailURL: string): string {
    const matches = articleIDRegex.exec(detailURL);
    if (matches && matches.length >= 2) {
      return matches[1];
    }
    return '';
  }

  private parsePublishTime(value: string): Date {
    const trimmed = value.trim();
    if (trimmed === '') {
      return new Date();
    }

    const formats = [
      'YYYY-MM-DD',
      'YYYY-MM-DD HH:mm:ss',
    ];

    for (const format of formats) {
      const date = this.parseDate(trimmed, format);
      if (date.getTime() > 0) {
        return date;
      }
    }

    return new Date();
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
    }
    return new Date(0);
  }

  private async fetchDetailLinks(client: AxiosInstance, detailURL: string, articleID: string): Promise<Link[]> {
    // 检查缓存
    const cachedLinks = detailCache.get(articleID);
    if (cachedLinks) {
      return cachedLinks;
    }

    const resp = await this.doRequestWithRetry(client, detailURL, detailMaxRetries);

    if (resp.status !== 200) {
      return [];
    }

    const $ = cheerio.load(resp.data);
    const links = this.extractNetDiskLinks($);

    if (links.length > 0) {
      detailCache.set(articleID, links);
    }

    return links;
  }

  private extractNetDiskLinks($: cheerio.Root): Link[] {
    const container = $('.article_content');
    if (container.length === 0) {
      return [];
    }

    const results: Link[] = [];
    const seen = new Set<string>();

    // 提取链接标签中的链接
    container.find('a[href]').each((_i, node) => {
      const href = $(node).attr('href');
      if (!href) {
        return;
      }
      const trimmedHref = href.trim();
      if (trimmedHref === '') {
        return;
      }

      const [linkType, normalized] = this.classifyLink(trimmedHref);
      if (linkType === '') {
        return;
      }
      if (seen.has(normalized)) {
        return;
      }

      const password = this.extractPassword($(node));

      results.push({
        Type: linkType,
        URL: normalized,
        Password: password,
      });
      seen.add(normalized);
    });

    // 提取纯文本中的链接
    const text = container.text();
    const plainTextLinks = this.extractPlainTextLinks(text, seen);
    results.push(...plainTextLinks);

    return results;
  }

  private extractPlainTextLinks(text: string, seen: Set<string>): Link[] {
    const links: Link[] = [];
    let match;
    const regex = new RegExp(urlRegex.source, 'g');

    while ((match = regex.exec(text)) !== null) {
      const raw = match[0];
      const [linkType, normalized] = this.classifyLink(raw);
      if (linkType === '') {
        continue;
      }
      if (seen.has(normalized)) {
        continue;
      }

      const start = Math.max(0, match.index - 80);
      const end = Math.min(text.length, match.index + match[0].length + 80);
      const context = text.substring(start, end);
      const password = this.matchPassword(context);

      links.push({
        Type: linkType,
        URL: normalized,
        Password: password,
      });
      seen.add(normalized);
    }

    return links;
  }

  private classifyLink(raw: string): [string, string] {
    for (const pattern of linkPatterns) {
      const match = pattern.reg.exec(raw);
      if (match) {
        return [pattern.typ, match[0]];
      }
    }
    return ['', ''];
  }

  private extractPassword(link: cheerio.Cheerio): string {
    const candidates: string[] = [link.text()];

    const title = link.attr('title');
    if (title) {
      candidates.push(title);
    }

    const parent = link.parent();
    if (parent.length > 0) {
      candidates.push(parent.text());
      const next = parent.next();
      if (next.length > 0) {
        candidates.push(next.text());
      }
    }

    const next = link.next();
    if (next.length > 0) {
      candidates.push(next.text());
    }

    for (const text of candidates) {
      const pwd = this.matchPassword(text);
      if (pwd !== '') {
        return pwd;
      }
    }
    return '';
  }

  private matchPassword(text: string): string {
    const trimmed = text.trim();
    if (trimmed === '') {
      return '';
    }

    for (const pattern of pwdPatterns) {
      const matches = pattern.exec(trimmed);
      if (matches && matches.length >= 2) {
        return matches[1].trim();
      }
    }
    return '';
  }

  private async doRequestWithRetry(client: AxiosInstance, url: string, maxRetries: number): Promise<AxiosResponse> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const resp = await client.get(url, {
          headers: {
            'Referer': url === 'https://ypfxw.com/search.php' ? 'https://ypfxw.com/' : url,
          },
        });

        if (resp.status === 200) {
          return resp;
        }
      } catch (error) {
        lastError = error as Error;
      }

      if (attempt < maxRetries - 1) {
        const backoff = retryBaseDelay * Math.pow(2, attempt);
        await new Promise(resolve => setTimeout(resolve, backoff));
      }
    }

    throw new Error(`重试 ${maxRetries} 次后失败: ${lastError?.message}`);
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
BaseAsyncPlugin.RegisterGlobalPlugin(new YpfxwPlugin());
