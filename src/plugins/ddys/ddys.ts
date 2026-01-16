import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios';
import { BaseAsyncPlugin } from '../plugin.manager';
import { SearchResult, Link } from '../../models/plugin-result';
import * as cheerio from 'cheerio';

// 常量定义
const pluginName = "ddys";
const displayName = "低端影视";
const description = "低端影视 - 影视资源网盘链接搜索";
const baseURL = "https://ddys.pro";
const searchPath = "/?s=%s&post_type=post";
const userAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36";
const maxResults = 50;
const maxConcurrency = 20;
const cacheTTL = 30 * 60 * 1000; // 30分钟
const maxRetries = 3;
const retryBaseDelay = 200; // 200毫秒

// 正则表达式
const postIDRegex = /post-(\d+)/;
const detailURLRegex = /详情页: (https?:\/\/[^\s]+)/;

// 缓存相关
interface CacheEntry {
  links: Link[];
  expiresAt: number;
}

const detailCache = new Map<string, CacheEntry>();

export class DdysPlugin extends BaseAsyncPlugin {
  private debugMode: boolean;

  constructor() {
    super(pluginName, 1);
    this.debugMode = false; // 生产环境关闭调试
    this.startCacheCleaner();
  }

  Name(): string {
    return pluginName;
  }

  DisplayName(): string {
    return displayName;
  }

  Description(): string {
    return description;
  }

  protected async searchImpl(client: AxiosInstance, keyword: string): Promise<SearchResult[]> {
    try {
      if (this.debugMode) {
        console.log(`[DDYS] 开始搜索: ${keyword}`);
      }

      // 第一步：执行搜索获取结果列表
      const searchResults = await this.executeSearch(client, keyword);

      if (this.debugMode) {
        console.log(`[DDYS] 搜索获取到 ${searchResults.length} 个结果`);
      }

      // 第二步：并发获取详情页链接
      const finalResults = await this.fetchDetailLinks(client, searchResults, keyword);

      if (this.debugMode) {
        console.log(`[DDYS] 最终获取到 ${finalResults.length} 个有效结果`);
      }

      // 第三步：关键词过滤（标准网盘插件需要过滤）
      const filteredResults = this.filterResultsByKeyword(finalResults, keyword);
      
      if (this.debugMode) {
        console.log(`[DDYS] 关键词过滤后剩余 ${filteredResults.length} 个结果`);
      }

      return filteredResults;
    } catch (error) {
      console.error(`[DDYS] 搜索失败:`, error);
      return [];
    }
  }

  private async executeSearch(client: AxiosInstance, keyword: string): Promise<SearchResult[]> {
    // 构建搜索URL
    const searchURL = `${baseURL}${searchPath.replace('%s', encodeURIComponent(keyword))}`;

    // 执行搜索请求
    const resp = await this.doRequestWithRetry(client, searchURL, baseURL);

    if (resp.status !== 200) {
      throw new Error(`搜索返回状态码: ${resp.status}`);
    }

    // 解析HTML提取搜索结果
    const $ = cheerio.load(resp.data);
    return this.parseSearchResults($);
  }

  private async doRequestWithRetry(client: AxiosInstance, url: string, referer: string): Promise<AxiosResponse> {
    let lastError: any = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const resp = await client.get(url, {
          headers: this.setCommonHeaders(referer),
          timeout: 30000
        });

        if (resp.status === 200) {
          return resp;
        }
      } catch (error) {
        lastError = error;
        if (attempt < maxRetries - 1) {
          const backoff = Math.pow(2, attempt) * retryBaseDelay;
          await new Promise(resolve => setTimeout(resolve, backoff));
        }
      }
    }

    throw new Error(`重试 ${maxRetries} 次后仍然失败: ${lastError?.message}`);
  }

  private setCommonHeaders(referer: string): Record<string, string> {
    return {
      'User-Agent': userAgent,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'Connection': 'keep-alive',
      'Upgrade-Insecure-Requests': '1',
      'Cache-Control': 'max-age=0',
      'Referer': referer
    };
  }

  private parseSearchResults($: cheerio.CheerioAPI): SearchResult[] {
    const results: SearchResult[] = [];

    // 查找搜索结果项: article[class*='post-']
    $('article[class*="post-"]').each((i, element) => {
      if (results.length >= maxResults) {
        return false;
      }

      const result = this.parseResultItem($(element), i + 1);
      if (result) {
        results.push(result);
      }

      return true;
    });

    if (this.debugMode) {
      console.log(`[DDYS] 解析到 ${results.length} 个原始结果`);
    }

    return results;
  }

  private parseResultItem(s: cheerio.Cheerio, index: number): SearchResult | null {
    // 提取文章ID
    const articleClass = s.attr('class') || '';
    let postID = this.extractPostID(articleClass);
    if (!postID) {
      postID = `unknown-${index}`;
    }

    // 提取标题和链接
    const linkEl = s.find('.post-title a');
    if (linkEl.length === 0) {
      if (this.debugMode) {
        console.log('[DDYS] 跳过无标题链接的结果');
      }
      return null;
    }

    // 提取标题
    const title = linkEl.text().trim();
    if (title === '') {
      return null;
    }

    // 提取详情页链接
    const detailURL = linkEl.attr('href');
    if (!detailURL) {
      if (this.debugMode) {
        console.log(`[DDYS] 跳过无链接的结果: ${title}`);
      }
      return null;
    }

    // 提取发布时间
    const publishTime = this.extractPublishTime(s);

    // 提取分类
    const category = this.extractCategory(s);

    // 提取简介
    const content = this.extractContent(s);

    // 构建初始结果对象（详情页链接稍后获取）
    const result: SearchResult = {
      Title: title,
      Content: `分类：${category}\n${content}\n详情页: ${detailURL}`,
      Channel: '', // 插件搜索结果必须为空字符串（按开发指南要求）
      MessageID: `${this.Name()}-${postID}-${index}`,
      UniqueID: `${this.Name()}-${postID}-${index}`,
      Datetime: publishTime,
      Links: [], // 先为空，详情页处理后添加
      Tags: [category]
    };

    if (this.debugMode) {
      console.log(`[DDYS] 解析结果: ${title} (${category})`);
    }

    return result;
  }

  private extractPostID(articleClass: string): string {
    const matches = articleClass.match(postIDRegex);
    if (matches && matches.length >= 2) {
      return matches[1];
    }
    return '';
  }

  private extractPublishTime(s: cheerio.Cheerio): Date {
    const timeEl = s.find('.meta_date time.entry-date');
    if (timeEl.length > 0) {
      const datetime = timeEl.attr('datetime');
      if (datetime) {
        const date = new Date(datetime);
        if (!isNaN(date.getTime())) {
          return date;
        }
      }
    }
    return new Date();
  }

  private extractCategory(s: cheerio.Cheerio): string {
    const categoryEl = s.find('.meta_categories .cat-links a');
    if (categoryEl.length > 0) {
      return categoryEl.text().trim();
    }
    return '未分类';
  }

  private extractContent(s: cheerio.Cheerio): string {
    const contentEl = s.find('.entry-content');
    if (contentEl.length > 0) {
      let content = contentEl.text().trim();
      // 限制长度
      if (content.length > 200) {
        content = content.substring(0, 200) + '...';
      }
      return content;
    }
    return '';
  }

  private async fetchDetailLinks(client: AxiosInstance, searchResults: SearchResult[], keyword: string): Promise<SearchResult[]> {
    if (searchResults.length === 0) {
      return [];
    }

    const semaphore = new Semaphore(maxConcurrency);
    const tasks: Promise<SearchResult | null>[] = [];

    for (const result of searchResults) {
      tasks.push((async () => {
        await semaphore.acquire();
        try {
          // 从Content中提取详情页URL
          const detailURL = this.extractDetailURLFromContent(result.Content);
          if (!detailURL) {
            if (this.debugMode) {
              console.log(`[DDYS] 跳过无详情页URL的结果: ${result.Title}`);
            }
            return null;
          }

          // 获取详情页链接
          const links = await this.fetchDetailPageLinks(client, detailURL);
          if (links.length > 0) {
            const newResult = { ...result };
            newResult.Links = links;
            // 清理Content中的详情页URL
            newResult.Content = this.cleanContent(newResult.Content);
            return newResult;
          } else if (this.debugMode) {
            console.log(`[DDYS] 详情页无有效链接: ${result.Title}`);
          }
          return null;
        } catch (error) {
          console.error(`[DDYS] 处理详情页失败:`, error);
          return null;
        } finally {
          semaphore.release();
        }
      })());
    }

    const results = await Promise.all(tasks);
    return results.filter((r): r is SearchResult => r !== null);
  }

  private extractDetailURLFromContent(content: string): string {
    const match = content.match(detailURLRegex);
    if (match && match.length >= 2) {
      return match[1];
    }
    return '';
  }

  private cleanContent(content: string): string {
    return content.split('\n').filter(line => !line.startsWith('详情页: ')).join('\n');
  }

  private async fetchDetailPageLinks(client: AxiosInstance, detailURL: string): Promise<Link[]> {
    // 检查缓存
    if (detailCache.has(detailURL)) {
      const entry = detailCache.get(detailURL);
      if (entry && Date.now() < entry.expiresAt) {
        if (this.debugMode) {
          console.log(`[DDYS] 使用缓存的详情页链接: ${detailURL}`);
        }
        return entry.links;
      }
      detailCache.delete(detailURL);
    }

    try {
      const resp = await client.get(detailURL, {
        headers: this.setCommonHeaders(baseURL),
        timeout: 30000
      });

      if (resp.status !== 200) {
        if (this.debugMode) {
          console.log(`[DDYS] 详情页HTTP状态错误: ${resp.status}`);
        }
        return [];
      }

      // 解析网盘链接
      const links = this.parseNetworkDiskLinks(resp.data);

      // 缓存结果
      if (links.length > 0) {
        detailCache.set(detailURL, {
          links,
          expiresAt: Date.now() + cacheTTL
        });
      }

      if (this.debugMode) {
        console.log(`[DDYS] 从详情页提取到 ${links.length} 个链接: ${detailURL}`);
      }

      return links;
    } catch (error) {
      if (this.debugMode) {
        console.log(`[DDYS] 详情页请求失败:`, error);
      }
      return [];
    }
  }

  private parseNetworkDiskLinks(htmlContent: string): Link[] {
    const links: Link[] = [];

    // 定义网盘链接匹配模式
    const patterns = [
      { name: "夸克网盘", pattern: /\(夸克[^)]*\)[：:]\s*<a[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([^<]+)<\/a>/g, urlType: "quark" },
      { name: "百度网盘", pattern: /\(百度[^)]*\)[：:]\s*<a[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([^<]+)<\/a>/g, urlType: "baidu" },
      { name: "阿里云盘", pattern: /\(阿里[^)]*\)[：:]\s*<a[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([^<]+)<\/a>/g, urlType: "aliyun" },
      { name: "天翼云盘", pattern: /\(天翼[^)]*\)[：:]\s*<a[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([^<]+)<\/a>/g, urlType: "tianyi" },
      { name: "迅雷网盘", pattern: /\(迅雷[^)]*\)[：:]\s*<a[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([^<]+)<\/a>/g, urlType: "xunlei" },
      // 通用模式
      { name: "通用网盘", pattern: /<a[^>]*href\s*=\s*["'](https?:\/\/[^"']*(?:pan|drive|cloud)[^"']*)["'][^>]*>([^<]+)<\/a>/g, urlType: "others" },
    ];

    // 去重用的map
    const seen = new Set<string>();

    for (const pattern of patterns) {
      let match;
      while ((match = pattern.pattern.exec(htmlContent)) !== null) {
        if (match.length >= 2) {
          const url = match[1];
          
          // 去重
          if (seen.has(url)) {
            continue;
          }
          seen.add(url);

          // 确定网盘类型
          let urlType = this.determineCloudType(url);
          if (urlType === "others") {
            urlType = pattern.urlType;
          }

          // 提取可能的提取码
          const password = this.extractPassword(htmlContent, url);

          const link: Link = {
            Type: urlType,
            URL: url,
            Password: password,
          };

          links.push(link);

          if (this.debugMode) {
            console.log(`[DDYS] 找到链接: ${url} (${urlType})`);
          }
        }
      }
    }

    return links;
  }

  private extractPassword(content: string, panURL: string): string {
    // 常见提取码模式
    const patterns = [
      /提取[码密][：:]?\s*([A-Za-z0-9]{4,8})/,
      /密码[：:]?\s*([A-Za-z0-9]{4,8})/,
      /[码密][：:]?\s*([A-Za-z0-9]{4,8})/,
      /([A-Za-z0-9]{4,8})\s*[是为]?提取[码密]/,
    ];

    // 在网盘链接附近搜索提取码
    const urlIndex = content.indexOf(panURL);
    if (urlIndex === -1) {
      return "";
    }

    // 搜索范围：链接前后200个字符
    const start = Math.max(0, urlIndex - 200);
    const end = Math.min(content.length, urlIndex + panURL.length + 200);
    const searchArea = content.substring(start, end);

    for (const pattern of patterns) {
      const match = searchArea.match(pattern);
      if (match && match.length >= 2) {
        return match[1];
      }
    }

    return "";
  }

  private determineCloudType(url: string): string {
    if (url.includes("pan.quark.cn")) {
      return "quark";
    } else if (url.includes("drive.uc.cn")) {
      return "uc";
    } else if (url.includes("pan.baidu.com")) {
      return "baidu";
    } else if (url.includes("aliyundrive.com") || url.includes("alipan.com")) {
      return "aliyun";
    } else if (url.includes("pan.xunlei.com")) {
      return "xunlei";
    } else if (url.includes("cloud.189.cn")) {
      return "tianyi";
    } else if (url.includes("caiyun.139.com")) {
      return "mobile";
    } else if (url.includes("115.com")) {
      return "115";
    } else if (url.includes("123pan.com")) {
      return "123";
    } else if (url.includes("mypikpak.com")) {
      return "pikpak";
    } else if (url.includes("lanzou")) {
      return "lanzou";
    } else {
      return "others";
    }
  }

  private startCacheCleaner(): void {
    setInterval(() => {
      const now = Date.now();
      detailCache.forEach((value, key) => {
        if (now > value.expiresAt) {
          detailCache.delete(key);
        }
      });
    }, 5 * 60 * 1000); // 每5分钟清理一次
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
const plugin = new DdysPlugin();
plugin.register();
