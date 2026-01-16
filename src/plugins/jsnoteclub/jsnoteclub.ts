import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import cheerio from 'cheerio';
import { SearchResult, Link } from '../../types';
import { Plugin } from '../../types/plugin';

const pluginName = 'jsnoteclub';
const defaultPriority = 2;

const postsCacheTTL = 3600000; // 1 hour in milliseconds
const detailCacheTTL = 3600000; // 1 hour in milliseconds
const maxMatchedPosts = 30;
const maxDetailWorkers = 8;
const requestTimeout = 12000; // 12 seconds in milliseconds
const detailTimeout = 10000; // 10 seconds in milliseconds
const maxRequestRetries = 3;
const retryBaseDelay = 200; // 200 milliseconds

const dataKeyRegex = /data-key="([0-9a-fA-F]+)"/;

const linkPatterns = [
  { reg: /https?:\/\/pan\.quark\.cn\/(?:s|g)\/[0-9A-Za-z]+/, typ: 'quark' },
  { reg: /https?:\/\/pan\.xunlei\.com\/s\/[0-9A-Za-z\-_]+/, typ: 'xunlei' },
  { reg: /https?:\/\/pan\.baidu\.com\/s\/[0-9A-Za-z\-_]+/, typ: 'baidu' },
  { reg: /https?:\/\/(?:www\.)?(aliyundrive\.com|alipan\.com)\/s\/[0-9A-Za-z]+/, typ: 'aliyun' },
  { reg: /https?:\/\/drive\.uc\.cn\/s\/[0-9A-Za-z]+/, typ: 'uc' },
  { reg: /https?:\/\/(?:www\.)?(123pan\.com|123pan\.cn|123684\.com|123685\.com|123912\.com|123592\.com)\/s\/[0-9A-Za-z]+/, typ: '123' },
  { reg: /https?:\/\/(?:www\.)?mypikpak\.com\/s\/[0-9A-Za-z]+/, typ: 'pikpak' },
  { reg: /https?:\/\/caiyun\.139\.com\/[^\s<>'"]+/, typ: 'mobile' },
  { reg: /magnet:\?xt=urn:btih:[0-9A-Za-z]+/, typ: 'magnet' },
  { reg: /ed2k:\/\/[^\s<>'"]+/, typ: 'ed2k' },
];

const passwordPatterns = [
  /提取码[:：]?\s*([0-9A-Za-z]+)/,
  /密码[:：]?\s*([0-9A-Za-z]+)/,
  /pwd\s*[=:：]\s*([0-9A-Za-z]+)/,
  /code\s*[=:：]\s*([0-9A-Za-z]+)/,
];

const textURLRegex = /https?:\/\/[^\s<>'"]+/;

interface DetailCacheEntry {
  links: Link[];
  expiresAt: number;
}

interface GhostPost {
  id: string;
  slug: string;
  title: string;
  excerpt: string;
  url: string;
  updated_at: string;
  visibility: string;
}

interface GhostPostsResponse {
  posts: GhostPost[];
}

class JsNoteClubPlugin implements Plugin {
  private client: AxiosInstance;
  private postsCache: {
    entries: GhostPost[];
    expire: number;
    key: string;
  } = {
    entries: [],
    expire: 0,
    key: ''
  };
  private detailCache: Map<string, DetailCacheEntry> = new Map();

  constructor() {
    this.client = axios.create({
      timeout: requestTimeout,
      maxRedirects: 5,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36'
      }
    });

    // 启动缓存清理器
    this.startDetailCacheCleaner();
  }

  name(): string {
    return pluginName;
  }

  displayName(): string {
    return '灵犀笔记';
  }

  description(): string {
    return '灵犀笔记 - 网盘资源搜索';
  }

  async search(keyword: string, ext: Record<string, any>): Promise<SearchResult[]> {
    return this.searchImpl(keyword, ext);
  }

  private async searchImpl(keyword: string, ext: Record<string, any>): Promise<SearchResult[]> {
    const searchKeyword = keyword.trim();
    if (searchKeyword === '') {
      throw new Error(`[${this.name()}] 关键词不能为空`);
    }

    if (ext && ext.title_en) {
      const titleEn = ext.title_en.trim();
      if (titleEn !== '') {
        searchKeyword = `${searchKeyword} ${titleEn}`;
      }
    }

    const allPosts = await this.getAllPosts();
    if (allPosts.length === 0) {
      throw new Error(`[${this.name()}] 未获取到帖子数据`);
    }

    const matched = this.filterPostsByKeyword(allPosts, searchKeyword);
    if (matched.length === 0) {
      throw new Error(`[${this.name()}] 未找到相关资源`);
    }

    if (matched.length > maxMatchedPosts) {
      matched = matched.slice(0, maxMatchedPosts);
    }

    const results: SearchResult[] = [];
    const semaphore = this.createSemaphore(maxDetailWorkers);

    const promises = matched.map(async (post) => {
      await semaphore.acquire();
      try {
        const links = await this.fetchDetailLinks(post.url);
        if (links.length > 0) {
          const uniqueID = `${this.name()}-${post.id}`;

          const result: SearchResult = {
            uniqueId: uniqueID,
            title: post.title.trim(),
            content: post.excerpt.trim(),
            datetime: this.updatedAtTime(post.updated_at),
            links: links,
            channel: '',
            tags: [post.slug.trim()],
            images: [],
            pluginName: this.name(),
            displayName: this.displayName()
          };

          results.push(result);
        }
      } catch (error) {
        console.error(`[${this.name()}] 处理帖子失败:`, error);
      } finally {
        semaphore.release();
      }
    });

    await Promise.all(promises);

    if (results.length === 0) {
      throw new Error(`[${this.name()}] 未能获取到有效网盘链接`);
    }

    return this.filterResultsByKeyword(results, searchKeyword);
  }

  private async getAllPosts(): Promise<GhostPost[]> {
    const now = Date.now();

    // 检查缓存
    if (this.postsCache.entries.length > 0 && now < this.postsCache.expire) {
      return this.postsCache.entries;
    }

    try {
      const dataKey = await this.fetchDataKey();
      const posts = await this.fetchPosts(dataKey);

      // 更新缓存
      this.postsCache.entries = posts;
      this.postsCache.expire = now + postsCacheTTL;
      this.postsCache.key = dataKey;

      return posts;
    } catch (error) {
      console.error(`[${this.name()}] 获取帖子失败:`, error);
      return [];
    }
  }

  private async fetchDataKey(): Promise<string> {
    try {
      const url = 'https://jsnoteclub.com/';
      const config: AxiosRequestConfig = {
        method: 'GET',
        url: url,
        headers: this.getHTMLHeaders(url)
      };

      const resp = await this.doRequestWithRetry(config, maxRequestRetries);

      const $ = cheerio.load(resp.data);
      let html = '';
      $('script').each((_, element) => {
        html += $(element).html() || '';
      });

      const match = dataKeyRegex.exec(html);
      if (match && match[1]) {
        return match[1];
      }

      throw new Error(`[${this.name()}] 未能在首页找到 data-key`);
    } catch (error) {
      throw new Error(`[${this.name()}] 获取 data-key 失败: ${error}`);
    }
  }

  private async fetchPosts(dataKey: string): Promise<GhostPost[]> {
    try {
      const params = new URLSearchParams({
        key: dataKey,
        limit: '10000',
        fields: 'id,slug,title,excerpt,url,updated_at,visibility',
        order: 'updated_at DESC'
      });

      const url = `https://jsnoteclub.com/ghost/api/content/posts/?${params.toString()}`;
      const config: AxiosRequestConfig = {
        method: 'GET',
        url: url,
        headers: this.getAPIHeaders('https://jsnoteclub.com/')
      };

      const resp = await this.doRequestWithRetry(config, maxRequestRetries);
      const payload: GhostPostsResponse = resp.data;

      return payload.posts;
    } catch (error) {
      throw new Error(`[${this.name()}] 获取帖子列表失败: ${error}`);
    }
  }

  private async fetchDetailLinks(detailURL: string): Promise<Link[]> {
    // 检查缓存
    const cached = this.detailCache.get(detailURL);
    if (cached && Date.now() < cached.expiresAt) {
      return cached.links;
    }

    try {
      const config: AxiosRequestConfig = {
        method: 'GET',
        url: detailURL,
        headers: this.getHTMLHeaders(detailURL),
        timeout: detailTimeout
      };

      const resp = await this.doRequestWithRetry(config, maxRequestRetries);
      const $ = cheerio.load(resp.data);

      let content = $('section.gh-content');
      if (content.length === 0) {
        content = $('.gh-content');
      }
      if (content.length === 0) {
        content = $('article');
      }
      if (content.length === 0) {
        content = $('body');
      }

      // 移除不需要的元素
      content.find('aside').remove();
      content.find('.gh-sidebar').remove();
      content.find('.sidebar-left').remove();
      content.find('.left-ads').remove();

      const links = this.extractLinksFromSelection(content);
      if (links.length > 0) {
        // 更新缓存
        this.detailCache.set(detailURL, {
          links: links,
          expiresAt: Date.now() + detailCacheTTL
        });
      }

      return links;
    } catch (error) {
      console.error(`[${this.name()}] 获取详情链接失败:`, error);
      return [];
    }
  }

  private extractLinksFromSelection(selection: cheerio.Cheerio): Link[] {
    const results: Link[] = [];
    const seen = new Set<string>();

    // 从 <a> 标签提取链接
    selection.find('a[href]').each((_, element) => {
      const $element = cheerio.load(element);
      const href = $element('a').attr('href');
      if (!href) return;

      const trimmedHref = href.trim();
      if (trimmedHref === '') return;

      const [linkType, normalized] = this.classifyLink(trimmedHref);
      if (!linkType) return;
      if (seen.has(normalized)) return;

      const password = this.extractPassword($element);
      results.push({
        url: normalized,
        type: linkType,
        password: password
      });
      seen.add(normalized);
    });

    // 从文本中提取链接
    const text = selection.text();
    let match;
    const regex = new RegExp(textURLRegex.source, 'g');
    while ((match = regex.exec(text)) !== null) {
      const raw = match[0];
      const [linkType, normalized] = this.classifyLink(raw);
      if (!linkType) continue;
      if (seen.has(normalized)) continue;

      const context = this.substring(text, match.index - 80, match.index + raw.length + 80);
      const password = this.matchPassword(context);

      results.push({
        url: normalized,
        type: linkType,
        password: password
      });
      seen.add(normalized);
    }

    return results;
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

  private extractPassword(element: cheerio.Root): string {
    const candidates = [element.text()];

    const title = element('a').attr('title');
    if (title) {
      candidates.push(title);
    }

    const parent = element('a').parent();
    if (parent.length > 0) {
      candidates.push(parent.text());
      const next = parent.next();
      if (next.length > 0) {
        candidates.push(next.text());
      }
    }

    const sibling = element('a').next();
    if (sibling.length > 0) {
      candidates.push(sibling.text());
    }

    for (const candidate of candidates) {
      const password = this.matchPassword(candidate);
      if (password) {
        return password;
      }
    }

    return '';
  }

  private matchPassword(text: string): string {
    const trimmedText = text.trim();
    if (trimmedText === '') {
      return '';
    }

    for (const pattern of passwordPatterns) {
      const match = pattern.exec(trimmedText);
      if (match && match[1]) {
        return match[1].trim();
      }
    }

    return '';
  }

  private substring(text: string, start: number, end: number): string {
    start = Math.max(0, start);
    end = Math.min(text.length, end);
    return text.substring(start, end);
  }

  private filterPostsByKeyword(posts: GhostPost[], keyword: string): GhostPost[] {
    if (!keyword) {
      return posts;
    }

    const lowerKeyword = keyword.toLowerCase();
    const parts = lowerKeyword.split(/\s+/);

    return posts.filter(post => {
      const target = `${post.title} ${post.excerpt} ${post.slug}`.toLowerCase();
      return parts.every(part => target.includes(part));
    });
  }

  private async doRequestWithRetry(config: AxiosRequestConfig, maxRetries: number): Promise<any> {
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
        await this.sleep(retryBaseDelay * (1 << attempt));
      }
    }

    throw new Error(`重试 ${maxRetries} 次后失败: ${lastError}`);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private getHTMLHeaders(referer: string): Record<string, string> {
    return {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'Connection': 'keep-alive',
      'Referer': referer
    };
  }

  private getAPIHeaders(referer: string): Record<string, string> {
    return {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'Connection': 'keep-alive',
      'Referer': referer
    };
  }

  private startDetailCacheCleaner(): void {
    setInterval(() => {
      const now = Date.now();
      this.detailCache.forEach((value, key) => {
        if (now > value.expiresAt) {
          this.detailCache.delete(key);
        }
      });
    }, 30 * 60 * 1000); // 每30分钟清理一次
  }

  private updatedAtTime(updatedAt: string): Date {
    const layouts = [
      'YYYY-MM-DDTHH:mm:ss.SSSZ',
      'YYYY-MM-DDTHH:mm:ssZ',
      'YYYY-MM-DD HH:mm:ss'
    ];

    for (const layout of layouts) {
      const date = new Date(updatedAt);
      if (!isNaN(date.getTime())) {
        return date;
      }
    }

    return new Date();
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
const plugin = new JsNoteClubPlugin();
export default plugin;