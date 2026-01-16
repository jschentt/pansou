import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios';
import { BaseAsyncPlugin } from '../plugin.manager';
import { SearchResult, Link } from '../../models/plugin-result';
import * as cheerio from 'cheerio';

// 正则表达式
const detailIDRegex = /\/vod\/detail\/id\/(\d+)\.html/;
const yearRegex = /(\d{4})/;

// 网盘链接正则表达式
const quarkLinkRegex = /https?:\/\/pan\.quark\.cn\/s\/[0-9a-zA-Z]+/;
const ucLinkRegex = /https?:\/\/drive\.uc\.cn\/s\/[0-9a-zA-Z]+(\?[^"'\s]*)?/;
const baiduLinkRegex = /https?:\/\/pan\.baidu\.com\/s\/[0-9a-zA-Z_\-]+(\?pwd=[0-9a-zA-Z]+)?/;
const aliyunLinkRegex = /https?:\/\/(www\.)?(aliyundrive\.com|alipan\.com)\/s\/[0-9a-zA-Z]+/;
const xunleiLinkRegex = /https?:\/\/pan\.xunlei\.com\/s\/[0-9a-zA-Z_\-]+(\?pwd=[0-9a-zA-Z]+)?/;
const tianyiLinkRegex = /https?:\/\/cloud\.189\.cn\/t\/[0-9a-zA-Z]+/;
const link115Regex = /https?:\/\/115\.com\/s\/[0-9a-zA-Z]+/;
const mobileLinkRegex = /https?:\/\/caiyun\.feixin\.10086\.cn\/[0-9a-zA-Z]+/;
const weiyunLinkRegex = /https?:\/\/share\.weiyun\.com\/[0-9a-zA-Z]+/;
const lanzouLinkRegex = /https?:\/\/(www\.)?(lanzou[uixys]*|lan[zs]o[ux])\.(com|net|org)\/[0-9a-zA-Z]+/;
const jianguoyunLinkRegex = /https?:\/\/(www\.)?jianguoyun\.com\/p\/[0-9a-zA-Z]+/;
const link123Regex = /https?:\/\/123pan\.com\/s\/[0-9a-zA-Z]+/;
const pikpakLinkRegex = /https?:\/\/mypikpak\.com\/s\/[0-9a-zA-Z]+/;
const magnetLinkRegex = /magnet:\?xt=urn:btih:[0-9a-fA-F]{40}/;
const ed2kLinkRegex = /ed2k:\/\/\|file\|.+\|\d+\|[0-9a-fA-F]{32}\|\//;

// 常量定义
const pluginName = "duoduo";
const defaultTimeout = 8000;
const detailTimeout = 6000;
const maxConcurrency = 20;
const cacheTTL = 1 * 60 * 60 * 1000; // 1小时
const cacheCleanupInterval = 30 * 60 * 1000; // 30分钟

// 性能统计
interface PerformanceStats {
  searchRequests: number;
  detailPageRequests: number;
  cacheHits: number;
  cacheMisses: number;
  totalSearchTime: number;
  totalDetailTime: number;
}

const performanceStats: PerformanceStats = {
  searchRequests: 0,
  detailPageRequests: 0,
  cacheHits: 0,
  cacheMisses: 0,
  totalSearchTime: 0,
  totalDetailTime: 0
};

// 缓存相关
interface DetailCacheData {
  result: SearchResult;
  timestamp: number;
}

const detailCache = new Map<string, DetailCacheData>();

// 启动缓存清理定时器
setInterval(() => {
  const now = Date.now();
  detailCache.forEach((value, key) => {
    if (now - value.timestamp > cacheTTL) {
      detailCache.delete(key);
    }
  });
}, cacheCleanupInterval);

export class DuoduoPlugin extends BaseAsyncPlugin {
  constructor() {
    super(pluginName, 2);
  }

  Name(): string {
    return pluginName;
  }

  DisplayName(): string {
    return '多多影视';
  }

  Description(): string {
    return '多多影视 - 综合网盘资源搜索';
  }

  protected async searchImpl(client: AxiosInstance, keyword: string): Promise<SearchResult[]> {
    try {
      // 性能统计
      const start = Date.now();
      performanceStats.searchRequests++;

      // 1. 构建搜索URL
      const searchURL = `https://tv.yydsys.top/index.php/vod/search/wd/${encodeURIComponent(keyword)}.html`;

      // 2. 发送请求（带重试机制）
      const resp = await this.doRequestWithRetry(client, searchURL);

      if (resp.status !== 200) {
        throw new Error(`[${this.Name()}] 搜索请求返回状态码: ${resp.status}`);
      }

      // 3. 解析搜索结果页面
      const $ = cheerio.load(resp.data);

      // 4. 提取搜索结果
      const results: SearchResult[] = [];

      $('.module-search-item').each((i, element) => {
        const result = this.parseSearchItem($(element), keyword);
        if (result.UniqueID !== '') {
          results.push(result);
        }
      });

      // 5. 异步获取详情页信息
      const enhancedResults = await this.enhanceWithDetails(client, results);

      // 6. 关键词过滤
      const filteredResults = this.filterResultsByKeyword(enhancedResults, keyword);

      // 更新性能统计
      performanceStats.totalSearchTime += Date.now() - start;

      return filteredResults;
    } catch (error) {
      console.error(`[${this.Name()}] 搜索失败:`, error);
      return [];
    }
  }

  private async doRequestWithRetry(client: AxiosInstance, url: string): Promise<AxiosResponse> {
    const maxRetries = 3;
    let lastError: any = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const resp = await client.get(url, {
          headers: this.setCommonHeaders(),
          timeout: defaultTimeout
        });

        if (resp.status === 200) {
          return resp;
        }
      } catch (error) {
        lastError = error;
        if (attempt < maxRetries - 1) {
          const backoff = Math.pow(2, attempt) * 200;
          await new Promise(resolve => setTimeout(resolve, backoff));
        }
      }
    }

    throw new Error(`[${this.Name()}] 重试 ${maxRetries} 次后仍然失败: ${lastError?.message}`);
  }

  private setCommonHeaders(): Record<string, string> {
    return {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'Connection': 'keep-alive',
      'Upgrade-Insecure-Requests': '1',
      'Cache-Control': 'max-age=0',
      'Referer': 'https://tv.yydsys.top/'
    };
  }

  private parseSearchItem(s: cheerio.Cheerio, keyword: string): SearchResult {
    const result: SearchResult = {
      UniqueID: '',
      Title: '',
      Content: '',
      Links: [],
      Tags: [],
      Channel: '',
      Datetime: new Date(),
      MessageID: '',
      Images: []
    };

    // 提取详情页链接和ID（从标题链接提取，不是播放链接）
    const detailLink = s.find('.video-info-header h3 a').first().attr('href');
    if (!detailLink) {
      return result;
    }

    // 提取ID
    const matches = detailLink.match(detailIDRegex);
    if (!matches || matches.length < 2) {
      return result;
    }

    const itemID = matches[1];
    result.UniqueID = `${this.Name()}-${itemID}`;
    result.MessageID = result.UniqueID;

    // 提取标题
    const titleElement = s.find('.video-info-header h3 a');
    result.Title = titleElement.text().trim();

    // 提取资源类型/质量
    const qualityElement = s.find('.video-serial');
    const quality = qualityElement.text().trim();

    // 提取分类信息
    const tags: string[] = [];
    s.find('.video-info-aux .tag-link a').each((i, tag) => {
      const tagText = $(tag).text().trim();
      if (tagText !== '') {
        tags.push(tagText);
      }
    });
    result.Tags = tags;

    // 提取导演信息
    let director = '';
    s.find('.video-info-items').each((i, item) => {
      const title = $(item).find('.video-info-itemtitle').text().trim();
      if (title.includes('导演')) {
        director = $(item).find('.video-info-actor a').text().trim();
      }
    });

    // 提取主演信息
    const actors: string[] = [];
    s.find('.video-info-items').each((i, item) => {
      const title = $(item).find('.video-info-itemtitle').text().trim();
      if (title.includes('主演')) {
        $(item).find('.video-info-actor a').each((j, actor) => {
          const actorName = $(actor).text().trim();
          if (actorName !== '') {
            actors.push(actorName);
          }
        });
      }
    });

    // 提取剧情简介
    let plot = '';
    s.find('.video-info-items').each((i, item) => {
      const title = $(item).find('.video-info-itemtitle').text().trim();
      if (title.includes('剧情')) {
        plot = $(item).find('.video-info-item').text().trim();
      }
    });

    // 提取封面图片
    const images: string[] = [];
    const picURL = s.find('.module-item-pic > img').attr('data-src');
    if (picURL) {
      images.push(picURL);
    }
    result.Images = images;

    // 构建内容描述
    const contentParts: string[] = [];
    if (quality !== '') {
      contentParts.push(`【${quality}】`);
    }
    if (director !== '') {
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
    if (plot !== '') {
      contentParts.push(plot);
    }

    result.Content = contentParts.join('\n');

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
          // 从UniqueID提取ID
          const parts = result.UniqueID.split('-');
          if (parts.length < 2) {
            return result;
          }

          const itemID = parts[1];

          // 检查缓存
          if (detailCache.has(itemID)) {
            const cached = detailCache.get(itemID);
            if (cached && Date.now() - cached.timestamp < cacheTTL) {
              performanceStats.cacheHits++;
              return cached.result;
            }
            detailCache.delete(itemID);
          }
          performanceStats.cacheMisses++;

          // 获取详情页链接和图片
          const { links, images } = await this.fetchDetailLinksAndImages(client, itemID);
          
          // 更新结果
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
          console.error(`[${this.Name()}] 获取详情页失败:`, error);
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
    performanceStats.detailPageRequests++;

    const detailURL = `https://tv.yydsys.top/index.php/vod/detail/id/${itemID}.html`;

    try {
      // 发送请求（带重试）
      const resp = await client.get(detailURL, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
          'Connection': 'keep-alive',
          'Referer': 'https://tv.yydsys.top/'
        },
        timeout: detailTimeout
      });

      if (resp.status !== 200) {
        return { links: [], images: [] };
      }

      const $ = cheerio.load(resp.data);

      const links: Link[] = [];
      const images: string[] = [];

      // 提取详情页的海报图片
      const posterURL = $('div.mobile-play .lazyload').attr('data-src');
      if (posterURL) {
        images.push(posterURL);
      }

      // 查找下载链接区域
      $('#download-list .module-row-one').each((i, element) => {
        const s = $(element);
        // 从data-clipboard-text属性提取链接
        const linkURL = s.find('[data-clipboard-text]').attr('data-clipboard-text');
        if (linkURL) {
          // 过滤掉无效链接
          if (this.isValidNetworkDriveURL(linkURL)) {
            const linkType = this.determineLinkType(linkURL);
            if (linkType !== '') {
              const link: Link = {
                Type: linkType,
                URL: linkURL,
                Password: '' // 大部分网盘不需要密码
              };
              links.push(link);
            }
          }
        }

        // 也检查直接的href属性
        s.find('a[href]').each((j, a) => {
          const href = $(a).attr('href');
          if (href) {
            // 过滤掉无效链接
            if (this.isValidNetworkDriveURL(href)) {
              const linkType = this.determineLinkType(href);
              if (linkType !== '') {
                // 避免重复添加
                const isDuplicate = links.some(existingLink => existingLink.URL === href);
                if (!isDuplicate) {
                  const link: Link = {
                    Type: linkType,
                    URL: href,
                    Password: ''
                  };
                  links.push(link);
                }
              }
            }
          }
        });
      });

      // 更新性能统计
      performanceStats.totalDetailTime += Date.now() - start;

      return { links, images };
    } catch (error) {
      console.error(`[${this.Name()}] 获取详情页失败:`, error);
      // 更新性能统计
      performanceStats.totalDetailTime += Date.now() - start;
      return { links: [], images: [] };
    }
  }

  private isValidNetworkDriveURL(url: string): boolean {
    // 过滤掉明显无效的链接
    if (url.includes('javascript:') ||
       url.includes('#') ||
       url === '' ||
       (!url.startsWith('http') && !url.startsWith('magnet:') && !url.startsWith('ed2k:'))) {
      return false;
    }

    // 检查是否匹配任何支持的网盘格式（16种）
    return quarkLinkRegex.test(url) ||
           ucLinkRegex.test(url) ||
           baiduLinkRegex.test(url) ||
           aliyunLinkRegex.test(url) ||
           xunleiLinkRegex.test(url) ||
           tianyiLinkRegex.test(url) ||
           link115Regex.test(url) ||
           mobileLinkRegex.test(url) ||
           weiyunLinkRegex.test(url) ||
           lanzouLinkRegex.test(url) ||
           jianguoyunLinkRegex.test(url) ||
           link123Regex.test(url) ||
           pikpakLinkRegex.test(url) ||
           magnetLinkRegex.test(url) ||
           ed2kLinkRegex.test(url);
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
    } else if (weiyunLinkRegex.test(url)) {
      return 'weiyun';
    } else if (lanzouLinkRegex.test(url)) {
      return 'lanzou';
    } else if (jianguoyunLinkRegex.test(url)) {
      return 'jianguoyun';
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

  // GetPerformanceStats 获取性能统计信息
  public getPerformanceStats(): any {
    const totalSearchRequests = performanceStats.searchRequests;
    const totalDetailRequests = performanceStats.detailPageRequests;
    const totalCacheHits = performanceStats.cacheHits;
    const totalCacheMisses = performanceStats.cacheMisses;
    const totalSearchTime = performanceStats.totalSearchTime;
    const totalDetailTime = performanceStats.totalDetailTime;

    let avgSearchTime = 0;
    let avgDetailTime = 0;
    let cacheHitRate = 0;

    if (totalSearchRequests > 0) {
      avgSearchTime = totalSearchTime / totalSearchRequests;
    }

    if (totalDetailRequests > 0) {
      avgDetailTime = totalDetailTime / totalDetailRequests;
    }

    if (totalCacheHits + totalCacheMisses > 0) {
      cacheHitRate = (totalCacheHits / (totalCacheHits + totalCacheMisses)) * 100;
    }

    return {
      search_requests: totalSearchRequests,
      detail_page_requests: totalDetailRequests,
      cache_hits: totalCacheHits,
      cache_misses: totalCacheMisses,
      cache_hit_rate: cacheHitRate,
      avg_search_time_ms: avgSearchTime,
      avg_detail_time_ms: avgDetailTime,
      total_search_time_ns: totalSearchTime * 1000000, // 转换为纳秒
      total_detail_time_ns: totalDetailTime * 1000000 // 转换为纳秒
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
const plugin = new DuoduoPlugin();
plugin.register();
