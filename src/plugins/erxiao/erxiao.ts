import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios';
import { BaseAsyncPlugin } from '../plugin.manager';
import { SearchResult, Link } from '../../models/plugin-result';
import * as cheerio from 'cheerio';

// 常量定义
const pluginName = "erxiao";
const displayName = "二小";
const description = "二小 - 影视资源网盘链接搜索";
const baseURL = "https://erxiaofn.click";
const searchPath = "/index.php/vod/search/wd/%s.html";
const detailPath = "/index.php/vod/detail/id/%s.html";
const userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36";
const maxResults = 100;
const maxConcurrency = 20;
const requestTimeout = 8000;
const detailTimeout = 6000;
const cacheTTL = 1 * 60 * 60 * 1000; // 1小时

// 性能统计
let searchRequests = 0;
let totalSearchTime = 0; // 毫秒
let detailPageRequests = 0;
let totalDetailTime = 0; // 毫秒
let cacheHits = 0;
let cacheMisses = 0;

// 详情页缓存
const detailCache = new Map<string, { result: SearchResult; timestamp: number }>();

// 启动缓存清理定时器
setInterval(() => {
  const now = Date.now();
  detailCache.forEach((value, key) => {
    if (now - value.timestamp > cacheTTL) {
      detailCache.delete(key);
    }
  });
}, 5 * 60 * 1000); // 每5分钟清理一次

// 正则表达式
const passwordRegex = /\?pwd=([0-9a-zA-Z]+)/;
const detailIDRegex = /\/id\/(\d+)/;

// 常见网盘链接的正则表达式
const quarkLinkRegex = /https?:\/\/pan\.quark\.cn\/s\/[0-9a-zA-Z]+/;
const ucLinkRegex = /https?:\/\/drive\.uc\.cn\/s\/[0-9a-zA-Z]+(\?[^"'\s]*)?/;
const baiduLinkRegex = /https?:\/\/pan\.baidu\.com\/s\/[0-9a-zA-Z_\-]+(\?pwd=[0-9a-zA-Z]+)?/;
const aliyunLinkRegex = /https?:\/\/(www\.)?(aliyundrive\.com|alipan\.com)\/s\/[0-9a-zA-Z]+/;
const xunleiLinkRegex = /https?:\/\/pan\.xunlei\.com\/s\/[0-9a-zA-Z_\-]+(\?pwd=[0-9a-zA-Z]+)?/;
const tianyiLinkRegex = /https?:\/\/cloud\.189\.cn\/t\/[0-9a-zA-Z]+/;
const link115Regex = /https?:\/\/115\.com\/s\/[0-9a-zA-Z]+/;
const mobileLinkRegex = /https?:\/\/caiyun\.feixin\.10086\.cn\/[0-9a-zA-Z]+/;
const link123Regex = /https?:\/\/123pan\.com\/s\/[0-9a-zA-Z]+/;
const pikpakLinkRegex = /https?:\/\/mypikpak\.com\/s\/[0-9a-zA-Z]+/;
const magnetLinkRegex = /magnet:\?xt=urn:btih:[0-9a-fA-F]{40}/;
const ed2kLinkRegex = /ed2k:\/\/\|file\|.+\|\d+\|[0-9a-fA-F]{32}\|\//;

export class ErxiaoPlugin extends BaseAsyncPlugin {
  constructor() {
    super(pluginName, 1); // 优先级1
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
    // 性能统计
    const start = Date.now();
    searchRequests++;
    try {
      // 1. 构建搜索URL
      const searchURL = `${baseURL}${searchPath.replace('%s', encodeURIComponent(keyword))}`;

      // 2. 发送请求（带重试机制）
      const resp = await this.doRequestWithRetry(client, searchURL);

      if (resp.status !== 200) {
        throw new Error(`[${this.Name()}] 搜索请求返回状态码: ${resp.status}`);
      }

      // 3. 解析搜索结果页面
      const htmlContent = resp.data;
      const $ = cheerio.load(htmlContent);

      // 4. 提取搜索结果
      const results: SearchResult[] = [];

      $('.module-search-item').each((i, element) => {
        if (results.length >= maxResults) {
          return false;
        }
        const result = this.parseSearchItem($(element), keyword);
        if (result.UniqueID) {
          results.push(result);
        }
      });

      // 5. 并发获取详情页信息
      const enhancedResults = await this.enhanceWithDetails(client, results);

      // 6. 关键词过滤
      return this.filterResultsByKeyword(enhancedResults, keyword);
    } catch (error) {
      console.error(`[ERXIAO] 搜索失败:`, error);
      return [];
    } finally {
      totalSearchTime += Date.now() - start;
    }
  }

  private parseSearchItem(s: cheerio.Cheerio, keyword: string): SearchResult {
    const result: SearchResult = {
      UniqueID: '',
      Title: '',
      Content: '',
      Channel: '',
      Datetime: new Date(),
      Links: [],
      Tags: [],
      MessageID: ''
    };

    // 提取详情页链接和ID
    const detailLinkEl = s.find('.video-info-header h3 a').first();
    if (detailLinkEl.length === 0) {
      return result;
    }

    const detailLink = detailLinkEl.attr('href');
    if (!detailLink) {
      return result;
    }

    // 提取ID
    const matches = detailLink.match(detailIDRegex);
    if (!matches || matches.length < 2) {
      return result;
    }
    const itemID = matches[1];

    // 构建唯一ID
    const uniqueID = `${this.Name()}-${itemID}`;

    // 提取标题
    const title = detailLinkEl.text().trim();
    if (!title) {
      return result;
    }

    // 提取分类
    const category = s.find('.video-info-items').first().find('.video-info-item').first().text().trim();

    // 提取导演
    let director = '';
    s.find('.video-info-items').each((i, item) => {
      const itemTitle = $(item).find('.video-info-itemtitle').text().trim();
      if (itemTitle.includes('导演')) {
        director = $(item).find('.video-info-item').text().trim();
      }
    });

    // 提取主演
    let actor = '';
    s.find('.video-info-items').each((i, item) => {
      const itemTitle = $(item).find('.video-info-itemtitle').text().trim();
      if (itemTitle.includes('主演')) {
        actor = $(item).find('.video-info-item').text().trim();
      }
    });

    // 提取年份
    const year = s.find('.video-info-items').last().find('.video-info-item').first().text().trim();

    // 提取质量/状态
    const quality = s.find('.video-info-header .video-info-remarks').text().trim();

    // 提取剧情简介
    let plot = '';
    s.find('.video-info-items').each((i, item) => {
      const itemTitle = $(item).find('.video-info-itemtitle').text().trim();
      if (itemTitle.includes('剧情')) {
        plot = $(item).find('.video-info-item').text().trim();
      }
    });

    // 提取封面图片
    const images: string[] = [];
    const picURL = s.find('.module-item-pic > img').attr('data-src');
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
    if (actor) {
      contentParts.push(`主演：${actor}`);
    }
    if (year) {
      contentParts.push(`年份：${year}`);
    }
    if (plot) {
      contentParts.push(`剧情：${plot}`);
    }
    const content = contentParts.join('\n');

    // 构建标签
    const tags: string[] = [];
    if (year) {
      tags.push(year);
    }
    if (category) {
      tags.push(category);
    }

    result.UniqueID = uniqueID;
    result.Title = title;
    result.Content = content;
    result.Tags = tags;
    result.Channel = ''; // 插件搜索结果Channel为空
    result.Datetime = new Date(); // 使用当前时间
    result.Images = images;
    result.MessageID = uniqueID;

    return result;
  }

  private async enhanceWithDetails(client: AxiosInstance, results: SearchResult[]): Promise<SearchResult[]> {
    if (results.length === 0) {
      return [];
    }

    const semaphore = new Semaphore(maxConcurrency);
    const tasks: Promise<SearchResult>[] = [];

    for (const result of results) {
      tasks.push((async () => {
        await semaphore.acquire();
        try {
          // 从UniqueID中提取itemID
          const parts = result.UniqueID.split('-');
          if (parts.length < 2) {
            return result;
          }
          const itemID = parts[1];

          // 检查缓存
          if (detailCache.has(itemID)) {
            cacheHits++;
            const cached = detailCache.get(itemID);
            if (cached && Date.now() - cached.timestamp < cacheTTL) {
              return cached.result;
            }
            detailCache.delete(itemID);
          }

          cacheMisses++;

          // 获取详情页链接和图片
          const { links, images } = await this.fetchDetailLinksAndImages(client, itemID);
          const newResult = { ...result };
          newResult.Links = links;

          // 合并图片：优先使用详情页的海报，如果没有则使用搜索结果的图片
          if (images.length > 0) {
            newResult.Images = images;
          }

          // 缓存结果
          detailCache.set(itemID, {
            result: newResult,
            timestamp: Date.now()
          });

          return newResult;
        } catch (error) {
          console.error(`[ERXIAO] 获取详情页失败:`, error);
          return result;
        } finally {
          semaphore.release();
        }
      })());
    }

    return await Promise.all(tasks);
  }

  private async fetchDetailLinksAndImages(client: AxiosInstance, itemID: string): Promise<{ links: Link[]; images: string[] }> {
    // 性能统计
    const start = Date.now();
    detailPageRequests++;
    try {
      const detailURL = `${baseURL}${detailPath.replace('%s', itemID)}`;

      // 发送请求（带重试）
      const resp = await this.doRequestWithRetry(client, detailURL, detailTimeout);

      if (resp.status !== 200) {
        return { links: [], images: [] };
      }

      const htmlContent = resp.data;
      const $ = cheerio.load(htmlContent);

      const links: Link[] = [];
      const images: string[] = [];

      // 提取详情页的海报图片
      const posterURL = $('.mobile-play .lazyload').attr('data-src');
      if (posterURL) {
        images.push(posterURL);
      }

      // 查找下载链接区域
      $('#download-list .module-row-one').each((i, element) => {
        // 从data-clipboard-text属性提取链接
        const linkURL = $(element).find('[data-clipboard-text]').attr('data-clipboard-text');
        if (linkURL) {
          // 过滤掉无效链接
          if (this.isValidNetworkDriveURL(linkURL)) {
            const linkType = this.determineLinkType(linkURL);
            if (linkType) {
              const link: Link = {
                Type: linkType,
                URL: linkURL,
                Password: this.extractPassword(linkURL),
              };
              links.push(link);
            }
          }
        }
      });

      return { links, images };
    } catch (error) {
      console.error(`[ERXIAO] 获取详情页链接失败:`, error);
      return { links: [], images: [] };
    } finally {
      totalDetailTime += Date.now() - start;
    }
  }

  private isValidNetworkDriveURL(url: string): boolean {
    return !url.includes('javascript:') &&
           !url.includes('#') &&
           url !== '' &&
           (url.startsWith('http') || url.startsWith('magnet:') || url.startsWith('ed2k:'));
  }

  private determineLinkType(url: string): string {
    if (quarkLinkRegex.test(url)) {
      return 'quark';
    } else if (ucLinkRegex.test(url)) {
      return 'uc';
    } else if (baiduLinkRegex.test(url)) {
      return 'baidu';
    } else if (aliyunLinkRegex.test(url)) {
      return 'aliyun';
    } else if (xunleiLinkRegex.test(url)) {
      return 'xunlei';
    } else if (tianyiLinkRegex.test(url)) {
      return 'tianyi';
    } else if (link115Regex.test(url)) {
      return '115';
    } else if (mobileLinkRegex.test(url)) {
      return 'mobile';
    } else if (link123Regex.test(url)) {
      return '123';
    } else if (pikpakLinkRegex.test(url)) {
      return 'pikpak';
    } else if (magnetLinkRegex.test(url)) {
      return 'magnet';
    } else if (ed2kLinkRegex.test(url)) {
      return 'ed2k';
    } else {
      return ''; // 不支持的类型返回空字符串
    }
  }

  private extractPassword(url: string): string {
    const matches = url.match(passwordRegex);
    if (matches && matches.length > 1) {
      return matches[1];
    }
    return '';
  }

  private async doRequestWithRetry(client: AxiosInstance, url: string, timeout: number = requestTimeout): Promise<AxiosResponse> {
    const maxRetries = 2;
    let lastError: any = null;

    for (let i = 0; i < maxRetries; i++) {
      try {
        const resp = await client.get(url, {
          headers: this.setCommonHeaders(),
          timeout: timeout
        });

        if (resp.status === 200) {
          return resp;
        }
        lastError = new Error(`HTTP状态码: ${resp.status}`);
      } catch (error) {
        lastError = error;
      }

      // 快速重试：只等待很短时间
      if (i < maxRetries - 1) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }

    throw new Error(`[${this.Name()}] 请求失败，重试${maxRetries}次后仍失败: ${lastError?.message}`);
  }

  private setCommonHeaders(): Record<string, string> {
    return {
      'User-Agent': userAgent,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'Connection': 'keep-alive',
      'Referer': baseURL + '/'
    };
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

  // 获取性能统计信息
  public getPerformanceStats(): Record<string, any> {
    const totalRequests = searchRequests;
    const totalTime = totalSearchTime;
    const detailRequests = detailPageRequests;
    const detailTime = totalDetailTime;
    const hits = cacheHits;
    const misses = cacheMisses;

    let avgTime = 0;
    if (totalRequests > 0) {
      avgTime = totalTime / totalRequests;
    }

    let avgDetailTime = 0;
    if (detailRequests > 0) {
      avgDetailTime = detailTime / detailRequests;
    }

    return {
      search_requests: totalRequests,
      avg_search_time_ms: avgTime,
      total_search_time_ms: totalTime,
      detail_page_requests: detailRequests,
      avg_detail_time_ms: avgDetailTime,
      total_detail_time_ms: detailTime,
      cache_hits: hits,
      cache_misses: misses,
    };
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
const plugin = new ErxiaoPlugin();
plugin.register();