import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import * as cheerio from 'cheerio';
import { SearchResult, Link } from '../../models/plugin-result';
import { PluginManager } from '../plugin.manager';

const categoryIDs = ['9305', '942'];

const pluginName = 'mikuclub';
const defaultPriority = 2;
const searchTimeout = 12000;
const detailTimeout = 10000;
const maxConcurrency = 12;
const searchMaxRetries = 3;
const detailMaxRetries = 2;
const retryBaseDelay = 200;
const cacheTTL = 1 * 60 * 60 * 1000; // 1小时
const cacheCleanupInterval = 30 * 60 * 1000; // 30分钟

const quarkLinkRegex = /https?:\/\/pan\.quark\.cn\/(s|g)\/[0-9A-Za-z]+/g;
const aliyunLinkRegex = /https?:\/\/(?:www\.)?(aliyundrive\.com|alipan\.com)\/s\/[0-9A-Za-z]+/g;
const baiduLinkRegex = /https?:\/\/pan\.baidu\.com\/s\/[0-9A-Za-z\-_]+/g;
const xunleiLinkRegex = /https?:\/\/pan\.xunlei\.com\/s\/[0-9A-Za-z\-_]+/g;
const ucLinkRegex = /https?:\/\/drive\.uc\.cn\/s\/[0-9A-Za-z]+/g;
const pikpakLinkRegex = /https?:\/\/(?:www\.)?mypikpak\.com\/s\/[0-9A-Za-z]+/g;
const mobileLinkRegex = /https?:\/\/caiyun\.139\.com\/[^\s]+/g;
const magnetLinkRegex = /magnet:\?xt=urn:btih:[0-9A-Fa-f]{40}/g;
const pan123LinkRegex = /https?:\/\/(?:www\.)?(123pan\.com|123pan\.cn|123684\.com|123685\.com|123912\.com|123592\.com)\/s\/[0-9A-Za-z]+/g;

const textURLRegex = /https?:\/\/[^\s<>'"]+/g;
const passwordRegex = /提取码[:：]?\s*([0-9A-Za-z]+)|密码[:：]?\s*([0-9A-Za-z]+)|pwd\s*[=:：]\s*([0-9A-Za-z]+)|code\s*[=:：]\s*([0-9A-Za-z]+)/g;

interface CacheEntry {
  links: Link[];
  expiresAt: number;
}

interface PostItem {
  id: number;
  post_title: string;
  post_href: string;
  post_main_cat_name: string;
  post_cat_name: string;
  post_date: string;
  post_rank_description: string;
  post_views: number;
}

interface PostListResponse {
  posts: PostItem[];
}

export class MikuclubPlugin {
  private client: AxiosInstance;
  private detailCache: Map<number, CacheEntry>;

  constructor() {
    this.client = axios.create({
      timeout: searchTimeout,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/html;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Connection': 'keep-alive'
      }
    });

    this.detailCache = new Map<number, CacheEntry>();
    this.startCacheCleaner();
  }

  public async search(keyword: string, ext: Record<string, any>): Promise<SearchResult[]> {
    const categoryResults = await Promise.all(
      categoryIDs.map(catID => this.fetchCategoryPosts(keyword, catID))
    );

    const seenPosts = new Map<number, PostItem>();
    let firstErr: Error | null = null;

    for (const result of categoryResults) {
      if (result.error) {
        if (!firstErr) {
          firstErr = result.error;
        }
        continue;
      }

      for (const post of result.posts) {
        if (!seenPosts.has(post.id)) {
          seenPosts.set(post.id, post);
        }
      }
    }

    const allPosts = Array.from(seenPosts.values());
    if (allPosts.length === 0) {
      if (firstErr) {
        throw firstErr;
      }
      throw new Error(`[${pluginName}] 未找到相关结果`);
    }

    const semaphore = this.createSemaphore(maxConcurrency);
    const results: SearchResult[] = [];

    const detailTasks = allPosts.map(async (post) => {
      await semaphore.acquire();
      try {
        const links = await this.fetchDetailLinks(post.id, post.post_href);
        if (links.length > 0) {
          const result: SearchResult = {
            uniqueId: `${pluginName}-${post.id}`,
            title: post.post_title.trim(),
            content: this.postSummary(post),
            links,
            tags: this.postTags(post),
            channel: '',
            datetime: this.postPublishTime(post)
          };
          results.push(result);
        }
      } catch (error) {
        console.error(`[${pluginName}] 获取详情失败: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        semaphore.release();
      }
    });

    await Promise.all(detailTasks);

    if (results.length === 0 && firstErr) {
      throw firstErr;
    }

    return this.filterResultsByKeyword(results, keyword);
  }

  private async fetchCategoryPosts(keyword: string, catID: string): Promise<{ posts: PostItem[]; error: Error | null }> {
    const params = new URLSearchParams({
      search: keyword,
      s: keyword,
      page: '',
      pagename: 'search_page',
      page_type: 'search',
      paged: '1',
      custom_orderby: 'relevance',
      no_cache: '1',
      custom_cat: catID
    });

    const reqURL = `https://www.mikuclub.uk/wp-json/utils/v2/post_list?${params.toString()}`;

    try {
      const resp = await this.doRequestWithRetry({
        url: reqURL,
        method: 'GET',
        headers: {
          'Referer': 'https://www.mikuclub.uk/'
        },
        timeout: searchTimeout
      });

      const data: PostListResponse = resp.data;
      return { posts: data.posts, error: null };
    } catch (error) {
      return { posts: [], error: error instanceof Error ? error : new Error(String(error)) };
    }
  }

  private async fetchDetailLinks(postID: number, detailURL: string): Promise<Link[]> {
    const cached = this.detailCache.get(postID);
    if (cached && Date.now() < cached.expiresAt) {
      return cached.links;
    }

    try {
      const resp = await this.doRequestWithRetry({
        url: detailURL,
        method: 'GET',
        headers: {
          'Referer': detailURL
        },
        timeout: detailTimeout
      });

      const $ = cheerio.load(resp.data);
      let container = $('.article_content');
      if (container.length === 0) {
        container = $('article.post, .entry-content');
      }
      if (container.length === 0) {
        container = $('body');
      }

      const links = this.extractLinksFromSelection(container);
      if (links.length > 0) {
        this.detailCache.set(postID, {
          links,
          expiresAt: Date.now() + cacheTTL
        });
      }

      return links;
    } catch (error) {
      console.error(`[${pluginName}] 获取详情失败: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }

  private extractLinksFromSelection(sel: cheerio.Cheerio): Link[] {
    const results: Link[] = [];
    const seen = new Set<string>();

    sel.find('a[href]').each((_, node) => {
      const href = $(node).attr('href');
      if (!href) {
        return;
      }
      const trimmedHref = href.trim();
      if (!trimmedHref) {
        return;
      }

      const [linkType, normalized] = this.classifyLink(trimmedHref);
      if (!linkType) {
        return;
      }
      if (seen.has(normalized)) {
        return;
      }

      const password = this.extractPassword($(node));

      results.push({
        type: linkType,
        url: normalized,
        password
      });
      seen.add(normalized);
    });

    const text = sel.text();
    let match;
    while ((match = textURLRegex.exec(text)) !== null) {
      const raw = match[0];
      const [linkType, normalized] = this.classifyLink(raw);
      if (!linkType) {
        continue;
      }
      if (seen.has(normalized)) {
        continue;
      }

      const start = Math.max(0, match.index - 80);
      const end = Math.min(text.length, match.index + match[0].length + 80);
      const context = text.substring(start, end);
      const password = this.matchPassword(context);

      results.push({
        type: linkType,
        url: normalized,
        password
      });
      seen.add(normalized);
    }

    return results;
  }

  private classifyLink(raw: string): [string, string] {
    if (quarkLinkRegex.test(raw)) {
      quarkLinkRegex.lastIndex = 0;
      const match = quarkLinkRegex.exec(raw);
      return match ? ['quark', match[0]] : ['', ''];
    }
    if (aliyunLinkRegex.test(raw)) {
      aliyunLinkRegex.lastIndex = 0;
      const match = aliyunLinkRegex.exec(raw);
      return match ? ['aliyun', match[0]] : ['', ''];
    }
    if (baiduLinkRegex.test(raw)) {
      baiduLinkRegex.lastIndex = 0;
      const match = baiduLinkRegex.exec(raw);
      return match ? ['baidu', match[0]] : ['', ''];
    }
    if (xunleiLinkRegex.test(raw)) {
      xunleiLinkRegex.lastIndex = 0;
      const match = xunleiLinkRegex.exec(raw);
      return match ? ['xunlei', match[0]] : ['', ''];
    }
    if (ucLinkRegex.test(raw)) {
      ucLinkRegex.lastIndex = 0;
      const match = ucLinkRegex.exec(raw);
      return match ? ['uc', match[0]] : ['', ''];
    }
    if (pikpakLinkRegex.test(raw)) {
      pikpakLinkRegex.lastIndex = 0;
      const match = pikpakLinkRegex.exec(raw);
      return match ? ['pikpak', match[0]] : ['', ''];
    }
    if (mobileLinkRegex.test(raw)) {
      mobileLinkRegex.lastIndex = 0;
      const match = mobileLinkRegex.exec(raw);
      return match ? ['mobile', match[0]] : ['', ''];
    }
    if (magnetLinkRegex.test(raw)) {
      magnetLinkRegex.lastIndex = 0;
      const match = magnetLinkRegex.exec(raw);
      return match ? ['magnet', match[0]] : ['', ''];
    }
    if (pan123LinkRegex.test(raw)) {
      pan123LinkRegex.lastIndex = 0;
      const match = pan123LinkRegex.exec(raw);
      return match ? ['123', match[0]] : ['', ''];
    }

    return ['', ''];
  }

  private extractPassword(node: cheerio.Cheerio): string {
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
      const pwd = this.matchPassword(text);
      if (pwd) {
        return pwd;
      }
    }

    return '';
  }

  private matchPassword(text: string): string {
    text = text.trim();
    if (!text) {
      return '';
    }

    passwordRegex.lastIndex = 0;
    const match = passwordRegex.exec(text);
    if (match) {
      for (let i = 1; i < match.length; i++) {
        if (match[i]) {
          return match[i].trim();
        }
      }
    }

    return '';
  }

  private async doRequestWithRetry(config: AxiosRequestConfig, maxRetries: number = searchMaxRetries): Promise<any> {
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
        await new Promise(resolve => setTimeout(resolve, retryBaseDelay * Math.pow(2, attempt)));
      }
    }

    throw new Error(`重试 ${maxRetries} 次后失败: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
  }

  private startCacheCleaner(): void {
    setInterval(() => {
      const now = Date.now();
      for (const [key, entry] of this.detailCache.entries()) {
        if (now > entry.expiresAt) {
          this.detailCache.delete(key);
        }
      }
    }, cacheCleanupInterval);
  }

  private postSummary(post: PostItem): string {
    const parts: string[] = [];
    if (post.post_rank_description) {
      parts.push(`口碑：${post.post_rank_description.trim()}`);
    }
    if (post.post_views > 0) {
      parts.push(`浏览：${post.post_views}`);
    }
    return parts.join(' ').trim();
  }

  private postTags(post: PostItem): string[] {
    const tags: string[] = [];
    if (post.post_main_cat_name) {
      tags.push(post.post_main_cat_name);
    }
    if (post.post_cat_name) {
      tags.push(post.post_cat_name);
    }
    return tags;
  }

  private postPublishTime(post: PostItem): Date {
    const layouts = [
      'YYYY-MM-DD HH:mm:ss',
      'YYYY-MM-DD'
    ];

    for (const layout of layouts) {
      const date = this.parseDateTime(post.post_date, layout);
      if (date) {
        return date;
      }
    }

    return new Date();
  }

  private parseDateTime(timeStr: string, format: string): Date | null {
    try {
      if (format === 'YYYY-MM-DD HH:mm:ss') {
        const [datePart, timePart] = timeStr.split(' ');
        if (!datePart || !timePart) {
          return null;
        }
        const [year, month, day] = datePart.split('-').map(Number);
        const [hour, minute, second] = timePart.split(':').map(Number);
        return new Date(year, month - 1, day, hour, minute, second);
      } else if (format === 'YYYY-MM-DD') {
        const [year, month, day] = timeStr.split('-').map(Number);
        return new Date(year, month - 1, day);
      }
    } catch {
      // Ignore parsing errors
    }

    return null;
  }

  private filterResultsByKeyword(results: SearchResult[], keyword: string): SearchResult[] {
    const lowerKeyword = keyword.toLowerCase();
    return results.filter(result => {
      return (
        result.title.toLowerCase().includes(lowerKeyword) ||
        result.content.toLowerCase().includes(lowerKeyword)
      );
    });
  }

  private createSemaphore(maxConcurrency: number): { acquire: () => Promise<void>; release: () => void } {
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
          resolve?.();
        }
      }
    };
  }
}

const plugin = new MikuclubPlugin();
PluginManager.registerPlugin(pluginName, plugin, defaultPriority);
export default plugin;