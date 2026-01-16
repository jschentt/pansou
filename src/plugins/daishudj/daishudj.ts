import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios';
import { BaseAsyncPlugin } from '../plugin.manager';
import { SearchResult, Link } from '../../models/plugin-result';
import * as cheerio from 'cheerio';

// 正则表达式
const idRegex = /\/(\d+)\//;
const textURLReg = /https?:\/\/[^\s<>'"]+/g;

// 链接模式
const linkPatterns = [
  { reg: /https?:\/\/pan\.quark\.cn\/(s|g)\/[0-9A-Za-z]+/, typ: "quark" },
  { reg: /https?:\/\/(?:www\.)?(aliyundrive\.com|alipan\.com)\/s\/[0-9A-Za-z]+/, typ: "aliyun" },
  { reg: /https?:\/\/pan\.baidu\.com\/s\/[0-9A-Za-z\-_]+/, typ: "baidu" },
  { reg: /https?:\/\/pan\.xunlei\.com\/s\/[0-9A-Za-z\-_]+/, typ: "xunlei" },
  { reg: /https?:\/\/drive\.uc\.cn\/s\/[0-9A-Za-z]+/, typ: "uc" },
  { reg: /https?:\/\/(?:www\.)?mypikpak\.com\/s\/[0-9A-Za-z]+/, typ: "pikpak" },
  { reg: /https?:\/\/caiyun\.139\.com\/[^\s]+/, typ: "mobile" },
  { reg: /magnet:\?xt=urn:btih:[0-9A-Za-z]+/, typ: "magnet" },
  { reg: /https?:\/\/(?:www\.)?(123pan\.com|123pan\.cn|123684\.com|123685\.com|123912\.com|123592\.com)\/s\/[0-9A-Za-z]+/, typ: "123" },
];

// 密码模式
const passwordPatterns = [
  /提取码[:：]?\s*([0-9A-Za-z]+)/,
  /密码[:：]?\s*([0-9A-Za-z]+)/,
  /pwd\s*[=:：]\s*([0-9A-Za-z]+)/,
  /code\s*[=:：]\s*([0-9A-Za-z]+)/,
];

// 缓存相关
interface CacheEntry {
  links: Link[];
  expiresAt: number;
}

const detailCache = new Map<string, CacheEntry>();
const cacheTTL = 1 * 60 * 60 * 1000; // 1小时
const cacheCleanupInterval = 30 * 60 * 1000; // 30分钟

// 常量定义
const pluginName = "daishudj";
const defaultPriority = 3;
const searchTimeout = 10 * 1000; // 10秒
const detailTimeout = 8 * 1000; // 8秒
const maxConcurrency = 10;
const maxRetries = 3;
const retryBaseDelay = 200; // 200毫秒

export class DaishuPlugin extends BaseAsyncPlugin {
  constructor() {
    super(pluginName, defaultPriority);
    this.startCacheCleaner();
  }

  Name(): string {
    return pluginName;
  }

  DisplayName(): string {
    return '袋鼠短剧';
  }

  Description(): string {
    return '袋鼠短剧 - 网盘资源搜索引擎';
  }

  protected async searchImpl(client: AxiosInstance, keyword: string): Promise<SearchResult[]> {
    try {
      const searchURL = `https://www.daishuduanju.com/?s=${encodeURIComponent(keyword)}`;

      const resp = await this.doRequestWithRetry(client, searchURL, 'https://www.daishuduanju.com/');

      if (resp.status !== 200) {
        throw new Error(`搜索返回状态码: ${resp.status}`);
      }

      const $ = cheerio.load(resp.data);
      const results: SearchResult[] = [];
      const semaphore = new Semaphore(maxConcurrency);
      const tasks: Promise<void>[] = [];

      $('.item-jx.item-blog').each((_, element) => {
        const item = $(element);
        const titleSel = item.find('.subtitle h5 a');
        const title = titleSel.text().trim();
        const detailURL = titleSel.attr('href');

        if (!detailURL || title === '') {
          return;
        }

        const postID = extractPostID(detailURL);
        if (!postID) {
          return;
        }

        const summary = item.find('.subtitle p.pdesc').text().trim();

        const tags: string[] = [];
        const cat = item.find('.sortbox a.sort').text().trim();
        if (cat) {
          tags.push(cat);
        }

        const dateText = item.find('.pmbox .time').text().trim();
        const publishTime = parseChineseDate(dateText);

        tasks.push((async () => {
          await semaphore.acquire();
          try {
            const links = await this.fetchDetailLinks(client, detailURL, postID);
            if (links.length > 0) {
              results.push({
                UniqueID: `${this.Name()}-${postID}`,
                Title: title,
                Content: summary,
                Links: links,
                Tags: tags,
                Channel: '',
                Datetime: publishTime,
                MessageID: `${this.Name()}-${postID}`
              });
            }
          } catch (error) {
            console.error(`[${this.Name()}] 获取详情页链接失败:`, error);
          } finally {
            semaphore.release();
          }
        })());
      });

      await Promise.all(tasks);

      if (results.length === 0) {
        throw new Error('未找到相关资源');
      }

      return this.filterResultsByKeyword(results, keyword);
    } catch (error) {
      console.error(`[${this.Name()}] 搜索失败:`, error);
      return [];
    }
  }

  private async fetchDetailLinks(client: AxiosInstance, detailURL: string, postID: string): Promise<Link[]> {
    // 检查缓存
    if (detailCache.has(postID)) {
      const entry = detailCache.get(postID);
      if (entry && Date.now() < entry.expiresAt && entry.links.length > 0) {
        return entry.links;
      }
      detailCache.delete(postID);
    }

    try {
      const resp = await this.doRequestWithRetry(client, detailURL, 'https://www.daishuduanju.com/');

      if (resp.status !== 200) {
        return [];
      }

      const $ = cheerio.load(resp.data);

      let container = $('.article-body');
      if (container.length === 0) {
        container = $('article.post');
      }
      if (container.length === 0) {
        container = $('body');
      }

      const links = extractLinks($, container);
      
      // 缓存结果
      if (links.length > 0) {
        detailCache.set(postID, {
          links,
          expiresAt: Date.now() + cacheTTL
        });
      }

      return links;
    } catch (error) {
      console.error(`[${this.Name()}] 获取详情页链接失败:`, error);
      return [];
    }
  }

  private async doRequestWithRetry(client: AxiosInstance, url: string, referer: string): Promise<AxiosResponse> {
    let lastError: any = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const resp = await client.get(url, {
          headers: this.setCommonHeaders(referer),
          timeout: searchTimeout
        });

        if (resp.status === 200) {
          return resp;
        }
      } catch (error) {
        lastError = error;
        if (attempt < maxRetries - 1) {
          const backoff = retryBaseDelay * Math.pow(2, attempt);
          await new Promise(resolve => setTimeout(resolve, backoff));
        }
      }
    }

    throw new Error(`重试 ${maxRetries} 次后失败: ${lastError?.message}`);
  }

  private setCommonHeaders(referer: string): Record<string, string> {
    return {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'Connection': 'keep-alive',
      'Referer': referer
    };
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

  private filterResultsByKeyword(results: SearchResult[], keyword: string): SearchResult[] {
    const keywords = keyword.split(/\s+/).filter(k => k.length > 0);
    if (keywords.length === 0) {
      return results;
    }

    return results.filter(result => {
      const titleLower = result.Title.toLowerCase();
      const contentLower = result.Content.toLowerCase();
      return keywords.every(k => {
        const keywordLower = k.toLowerCase();
        return titleLower.includes(keywordLower) || contentLower.includes(keywordLower);
      });
    });
  }
}

// 辅助函数
function extractPostID(detailURL: string): string {
  const matches = detailURL.match(idRegex);
  if (matches && matches.length >= 2) {
    return matches[1];
  }
  return '';
}

function parseChineseDate(value: string): Date {
  value = value.trim();
  if (value === '') {
    return new Date();
  }
  
  value = value.replace(/年/g, '-');
  value = value.replace(/月/g, '-');
  value = value.replace(/日/g, '');
  
  const formats = [
    'YYYY-MM-DD HH:mm',
    'YYYY-MM-DD'
  ];
  
  for (const format of formats) {
    const date = parseDate(value, format);
    if (!isNaN(date.getTime())) {
      return date;
    }
  }
  
  return new Date();
}

function parseDate(dateStr: string, format: string): Date {
  if (format === 'YYYY-MM-DD') {
    const parts = dateStr.split('-');
    if (parts.length === 3) {
      return new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
    }
  } else if (format === 'YYYY-MM-DD HH:mm') {
    const parts = dateStr.split(' ');
    if (parts.length === 2) {
      const dateParts = parts[0].split('-');
      const timeParts = parts[1].split(':');
      if (dateParts.length === 3 && timeParts.length === 2) {
        return new Date(
          parseInt(dateParts[0]),
          parseInt(dateParts[1]) - 1,
          parseInt(dateParts[2]),
          parseInt(timeParts[0]),
          parseInt(timeParts[1])
        );
      }
    }
  }
  return new Date(0);
}

function extractLinks($: cheerio.CheerioAPI, container: cheerio.Cheerio): Link[] {
  const results: Link[] = [];
  const seen = new Set<string>();

  // 从<a>标签提取链接
  container.find('a[href]').each((_, element) => {
    const node = $(element);
    const href = node.attr('href');
    if (!href) return;

    const trimmedHref = href.trim();
    if (trimmedHref === '') return;

    const { linkType, normalized } = classifyLink(trimmedHref);
    if (linkType === '') return;
    if (seen.has(normalized)) return;

    const password = extractPassword($, node);

    results.push({
      Type: linkType,
      URL: normalized,
      Password: password
    });
    seen.add(normalized);
  });

  // 从文本中提取链接
  const text = container.text();
  let match;
  while ((match = textURLReg.exec(text)) !== null) {
    const raw = match[0];
    const { linkType, normalized } = classifyLink(raw);
    if (linkType === '') continue;
    if (seen.has(normalized)) continue;

    const context = substring(text, match.index - 80, match.index + match[0].length + 80);
    const password = matchPassword(context);

    results.push({
      Type: linkType,
      URL: normalized,
      Password: password
    });
    seen.add(normalized);
  }

  return results;
}

function classifyLink(raw: string): { linkType: string; normalized: string } {
  for (const pattern of linkPatterns) {
    const match = raw.match(pattern.reg);
    if (match && match[0]) {
      return {
        linkType: pattern.typ,
        normalized: match[0]
      };
    }
  }
  return { linkType: '', normalized: '' };
}

function extractPassword($: cheerio.CheerioAPI, node: cheerio.Cheerio): string {
  const candidates: string[] = [node.text()];

  const title = node.attr('title');
  if (title) {
    candidates.push(title);
  }

  const parent = node.parent();
  if (parent.length > 0) {
    candidates.push(parent.text());
    const next = parent.next();
    if (next.length > 0) {
      candidates.push(next.text());
    }
  }

  const sibling = node.next();
  if (sibling.length > 0) {
    candidates.push(sibling.text());
  }

  for (const text of candidates) {
    const password = matchPassword(text);
    if (password) {
      return password;
    }
  }

  return '';
}

function matchPassword(text: string): string {
  text = text.trim();
  if (text === '') {
    return '';
  }
  
  for (const pattern of passwordPatterns) {
    const matches = text.match(pattern);
    if (matches && matches.length >= 2) {
      return matches[1].trim();
    }
  }
  
  return '';
}

function substring(text: string, start: number, end: number): string {
  if (start < 0) start = 0;
  if (end > text.length) end = text.length;
  return text.substring(start, end);
}

// 信号量类
class Semaphore {
  private maxConcurrent: number;
  private currentConcurrent: number;
  private waiting: Array<() => void>;

  constructor(maxConcurrent: number) {
    this.maxConcurrent = maxConcurrent;
    this.currentConcurrent = 0;
    this.waiting = [];
  }

  async acquire(): Promise<void> {
    if (this.currentConcurrent < this.maxConcurrent) {
      this.currentConcurrent++;
      return;
    }

    return new Promise<void>((resolve) => {
      this.waiting.push(resolve);
    });
  }

  release(): void {
    if (this.waiting.length > 0) {
      const resolve = this.waiting.shift();
      if (resolve) {
        resolve();
      }
    } else {
      this.currentConcurrent--;
    }
  }
}

// 注册插件
const plugin = new DaishuPlugin();
plugin.register();
