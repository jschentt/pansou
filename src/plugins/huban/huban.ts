import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios';
import * as cheerio from 'cheerio';
import { SearchResult, Link } from '../../types';
import { Plugin } from '../../types/plugin';

// 默认超时时间
const DefaultTimeout = 8000;
const DetailTimeout = 6000;

// 并发控制
const MaxConcurrency = 20;

// 缓存TTL
const cacheTTL = 1 * 60 * 60 * 1000; // 1小时

// 请求来源控制 - 默认开启，提高安全性
const EnableRefererCheck = false;

// 调试日志开关
const DebugLog = false;

// 性能统计
let searchRequests = 0;
let totalSearchTime = 0; // 毫秒
let detailPageRequests = 0;
let totalDetailTime = 0; // 毫秒
let cacheHits = 0;
let cacheMisses = 0;

// Detail page缓存
let detailCache = new Map<string, { result: SearchResult; timestamp: number }>();

// 请求来源控制配置
let AllowedReferers = [
  'https://dm.xueximeng.com',
  'http://localhost:8888'
];

class Semaphore {
  private available: number;
  private queue: Array<() => void> = [];

  constructor(initial: number) {
    this.available = initial;
  }

  async acquire(): Promise<void> {
    return new Promise((resolve) => {
      if (this.available > 0) {
        this.available--;
        resolve();
      } else {
        this.queue.push(resolve);
      }
    });
  }

  release(): void {
    this.available++;
    if (this.queue.length > 0) {
      const resolve = this.queue.shift();
      if (resolve) {
        resolve();
      }
    }
  }
}

class HubanPlugin implements Plugin {
  private optimizedClient: AxiosInstance;

  constructor() {
    this.optimizedClient = axios.create({
      timeout: DefaultTimeout,
      maxRedirects: 5,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Connection': 'keep-alive'
      }
    });
  }

  name(): string {
    return 'huban';
  }

  displayName(): string {
    return 'Huban';
  }

  description(): string {
    return 'Huban - 影视资源网盘下载链接搜索';
  }

  async search(keyword: string, ext: Record<string, any>): Promise<SearchResult[]> {
    // 请求来源检查
    if (EnableRefererCheck && ext) {
      const referer = ext.referer as string || '';
      
      // 检查referer是否在允许列表中
      let allowed = false;
      for (const allowedReferer of AllowedReferers) {
        if (referer.startsWith(allowedReferer)) {
          if (DebugLog) {
            console.log(`[${this.name()}] 允许来自 ${referer} 的请求`);
          }
          allowed = true;
          break;
        }
      }
      
      if (!allowed) {
        if (DebugLog) {
          console.log(`[${this.name()}] 拒绝来自 ${referer} 的请求`);
        }
        throw new Error(`[${this.name()}] 请求来源不被允许`);
      }
    }

    return this.searchImpl(this.optimizedClient, keyword, ext);
  }

  private async searchImpl(client: AxiosInstance, keyword: string, ext: Record<string, any>): Promise<SearchResult[]> {
    // 性能统计
    const start = Date.now();
    searchRequests++;
    
    try {
      // 1. 构建搜索URL
      const searchURL = `http://103.45.162.207:20720/index.php/vod/search/wd/${encodeURIComponent(keyword)}.html`;

      const config: AxiosRequestConfig = {
        method: 'GET',
        url: searchURL,
        headers: {
          'Referer': 'http://103.45.162.207:20720/'
        }
      };

      // 2. 发送请求（带重试）
      const resp = await this.doRequestWithRetry(client, config);

      // 3. 解析搜索结果页面
      const $ = cheerio.load(resp.data);

      // 4. 提取搜索结果
      const results: SearchResult[] = [];

      $('.module-search-item').each((i, element) => {
        const result = this.parseSearchItem($(element), keyword);
        if (result.uniqueId) {
          results.push(result);
        }
      });

      // 5. 异步获取详情页信息
      const enhancedResults = await this.enhanceWithDetails(client, results);

      // 6. 关键词过滤
      return this.filterResultsByKeyword(enhancedResults, keyword);
    } finally {
      const duration = Date.now() - start;
      totalSearchTime += duration;
    }
  }

  private parseSearchItem(s: cheerio.Cheerio, keyword: string): SearchResult {
    const result: SearchResult = {
      uniqueId: '',
      title: '',
      content: '',
      links: [],
      tags: [],
      images: [],
      datetime: new Date(),
      channel: '',
      pluginName: this.name(),
      displayName: this.displayName()
    };

    // 提取详情页链接和ID
    const titleElement = s.find('.video-info-header h3 a').first();
    const detailLink = titleElement.attr('href');
    if (!detailLink) {
      return result;
    }

    // 提取ID
    const matches = detailLink.match(/\/id\/(\d+)/);
    if (!matches || matches.length < 2) {
      return result;
    }
    const itemID = matches[1];

    // 构建唯一ID
    result.uniqueId = `${this.name()}-${itemID}`;

    // 提取标题
    result.title = titleElement.text().trim();
    if (!result.title) {
      return result;
    }

    // 提取分类
    const category = s.find('.video-info-items').first().find('.video-info-item').first().text().trim();

    // 提取导演
    const directorElement = s.find('.video-info-items').filter((i, item) => {
      const title = $(item).find('.video-info-itemtitle').text().trim();
      return title.includes('导演');
    });
    const director = directorElement.find('.video-info-item').text().trim();

    // 提取主演
    const actorElement = s.find('.video-info-items').filter((i, item) => {
      const title = $(item).find('.video-info-itemtitle').text().trim();
      return title.includes('主演');
    });
    const actor = actorElement.find('.video-info-item').text().trim();

    // 提取年份
    const year = s.find('.video-info-items').last().find('.video-info-item').first().text().trim();

    // 提取质量/状态
    const quality = s.find('.video-info-header .video-info-remarks').text().trim();

    // 提取剧情简介
    const plotElement = s.find('.video-info-items').filter((i, item) => {
      const title = $(item).find('.video-info-itemtitle').text().trim();
      return title.includes('剧情');
    });
    const plot = plotElement.find('.video-info-item').text().trim();

    // 提取封面图片
    const coverImage = s.find('.module-item-pic > img').attr('data-src');

    // 构建内容描述
    const contentParts: string[] = [];
    if (category) {
      contentParts.push(`分类: ${category}`);
    }
    if (director) {
      contentParts.push(`导演: ${director}`);
    }
    if (actor) {
      contentParts.push(`主演: ${actor}`);
    }
    if (quality) {
      contentParts.push(`质量: ${quality}`);
    }
    if (plot) {
      contentParts.push(`剧情: ${plot}`);
    }

    result.content = contentParts.join(' | ');

    // 构建标签
    if (year) {
      result.tags.push(year);
    }

    // 构建图片数组
    if (coverImage) {
      result.images.push(coverImage);
    }

    return result;
  }

  private async enhanceWithDetails(client: AxiosInstance, results: SearchResult[]): Promise<SearchResult[]> {
    const enhancedResults: SearchResult[] = [];
    const semaphore = new Semaphore(MaxConcurrency);
    const tasks: Promise<SearchResult>[] = [];

    for (const result of results) {
      tasks.push((async () => {
        await semaphore.acquire();
        try {
          // 从uniqueId中提取itemID
          const parts = result.uniqueId.split('-');
          if (parts.length < 2) {
            return result;
          }
          const itemID = parts[1];

          // 检查缓存
          const cached = detailCache.get(itemID);
          if (cached && Date.now() - cached.timestamp < cacheTTL) {
            cacheHits++;
            return cached.result;
          }

          cacheMisses++;

          // 获取详情页链接和图片
          const [detailLinks, detailImages] = await this.fetchDetailLinksAndImages(client, itemID);
          result.links = detailLinks;

          // 合并图片：优先使用详情页的海报，如果没有则使用搜索结果的图片
          if (detailImages.length > 0) {
            result.images = detailImages;
          }

          // 缓存结果
          detailCache.set(itemID, {
            result: { ...result },
            timestamp: Date.now()
          });

          return result;
        } finally {
          semaphore.release();
        }
      })());
    }

    return await Promise.all(tasks);
  }

  private async fetchDetailLinksAndImages(client: AxiosInstance, itemID: string): Promise<[Link[], string[]]> {
    // 性能统计
    const start = Date.now();
    detailPageRequests++;
    
    try {
      const detailURL = `http://103.45.162.207:20720/index.php/vod/detail/id/${itemID}.html`;

      const config: AxiosRequestConfig = {
        method: 'GET',
        url: detailURL,
        headers: {
          'Referer': 'http://103.45.162.207:20720/'
        },
        timeout: DetailTimeout
      };

      // 发送请求（带重试）
      const resp = await this.doRequestWithRetry(client, config);

      // 解析HTML
      const $ = cheerio.load(resp.data);

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
                type: linkType,
                url: linkURL,
                password: '' // 大部分网盘不需要密码
              };
              links.push(link);
            }
          }
        }
      });

      return [links, images];
    } catch (err) {
      return [[], []];
    } finally {
      const duration = Date.now() - start;
      totalDetailTime += duration;
    }
  }

  private isValidNetworkDriveURL(url: string): boolean {
    // 过滤掉明显无效的链接
    if (url.includes('javascript:') ||
        url === '' ||
        (!url.startsWith('http') && !url.startsWith('magnet:') && !url.startsWith('ed2k:'))) {
      return false;
    }

    // 检查是否匹配任何支持的网盘格式（16种）
    return this.quarkLinkRegex.test(url) ||
           this.ucLinkRegex.test(url) ||
           this.baiduLinkRegex.test(url) ||
           this.aliyunLinkRegex.test(url) ||
           this.xunleiLinkRegex.test(url) ||
           this.tianyiLinkRegex.test(url) ||
           this.link115Regex.test(url) ||
           this.mobileLinkRegex.test(url) ||
           this.weiyunLinkRegex.test(url) ||
           this.lanzouLinkRegex.test(url) ||
           this.jianguoyunLinkRegex.test(url) ||
           this.link123Regex.test(url) ||
           this.pikpakLinkRegex.test(url) ||
           this.magnetLinkRegex.test(url) ||
           this.ed2kLinkRegex.test(url);
  }

  private determineLinkType(url: string): string {
    if (this.quarkLinkRegex.test(url)) return 'quark';
    if (this.ucLinkRegex.test(url)) return 'uc';
    if (this.baiduLinkRegex.test(url)) return 'baidu';
    if (this.aliyunLinkRegex.test(url)) return 'aliyun';
    if (this.xunleiLinkRegex.test(url)) return 'xunlei';
    if (this.tianyiLinkRegex.test(url)) return 'tianyi';
    if (this.link115Regex.test(url)) return '115';
    if (this.mobileLinkRegex.test(url)) return 'mobile';
    if (this.weiyunLinkRegex.test(url)) return 'weiyun';
    if (this.lanzouLinkRegex.test(url)) return 'lanzou';
    if (this.jianguoyunLinkRegex.test(url)) return 'jianguoyun';
    if (this.link123Regex.test(url)) return '123';
    if (this.pikpakLinkRegex.test(url)) return 'pikpak';
    if (this.magnetLinkRegex.test(url)) return 'magnet';
    if (this.ed2kLinkRegex.test(url)) return 'ed2k';
    return '';
  }

  private extractPassword(url: string): string {
    // 百度网盘密码
    const passwordMatch = url.match(/\?pwd=([0-9a-zA-Z]+)/);
    if (passwordMatch && passwordMatch.length > 1) {
      return passwordMatch[1];
    }

    // 115网盘密码
    const password115Match = url.match(/password=([0-9a-zA-Z]+)/);
    if (password115Match && password115Match.length > 1) {
      return password115Match[1];
    }

    return '';
  }

  private async doRequestWithRetry(client: AxiosInstance, config: AxiosRequestConfig): Promise<AxiosResponse> {
    const maxRetries = 2;
    let lastErr: any;

    for (let i = 0; i < maxRetries; i++) {
      try {
        const resp = await client(config);
        if (resp.status === 200) {
          return resp;
        }
        lastErr = new Error(`HTTP状态码: ${resp.status}`);
      } catch (err) {
        lastErr = err;
      }

      // 快速重试：只等待很短时间
      if (i < maxRetries - 1) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }

    throw new Error(`[${this.name()}] 请求失败，重试${maxRetries}次后仍失败: ${lastErr}`);
  }

  private filterResultsByKeyword(results: SearchResult[], keyword: string): SearchResult[] {
    if (!keyword) {
      return results;
    }

    const keywordLower = keyword.toLowerCase();
    return results.filter(result => {
      const titleLower = result.title.toLowerCase();
      const contentLower = result.content.toLowerCase();
      return titleLower.includes(keywordLower) || contentLower.includes(keywordLower);
    });
  }

  // 预编译的正则表达式
  private get quarkLinkRegex(): RegExp {
    return /https?:\/\/pan\.quark\.cn\/s\/[0-9a-zA-Z]+/;
  }

  private get ucLinkRegex(): RegExp {
    return /https?:\/\/drive\.uc\.cn\/s\/[0-9a-zA-Z]+(\?[^"'\s]*)?/;
  }

  private get baiduLinkRegex(): RegExp {
    return /https?:\/\/pan\.baidu\.com\/s\/[0-9a-zA-Z_\-]+(\?pwd=[0-9a-zA-Z]+)?/;
  }

  private get aliyunLinkRegex(): RegExp {
    return /https?:\/\/(www\.)?(aliyundrive\.com|alipan\.com)\/s\/[0-9a-zA-Z]+/;
  }

  private get xunleiLinkRegex(): RegExp {
    return /https?:\/\/pan\.xunlei\.com\/s\/[0-9a-zA-Z_\-]+(\?pwd=[0-9a-zA-Z]+)?/;
  }

  private get tianyiLinkRegex(): RegExp {
    return /https?:\/\/cloud\.189\.cn\/t\/[0-9a-zA-Z]+/;
  }

  private get link115Regex(): RegExp {
    return /https?:\/\/(115\.com|115cdn\.com)\/s\/[0-9a-zA-Z]+/;
  }

  private get mobileLinkRegex(): RegExp {
    return /https?:\/\/caiyun\.feixin\.10086\.cn\/[0-9a-zA-Z]+/;
  }

  private get weiyunLinkRegex(): RegExp {
    return /https?:\/\/share\.weiyun\.com\/[0-9a-zA-Z]+/;
  }

  private get lanzouLinkRegex(): RegExp {
    return /https?:\/\/(www\.)?(lanzou[uixys]*|lan[zs]o[ux])\.(com|net|org)\/[0-9a-zA-Z]+/;
  }

  private get jianguoyunLinkRegex(): RegExp {
    return /https?:\/\/(www\.)?jianguoyun\.com\/p\/[0-9a-zA-Z]+/;
  }

  private get link123Regex(): RegExp {
    return /https?:\/\/(123pan\.com|www\.123912\.com|www\.123865\.com|www\.123684\.com)\/s\/[0-9a-zA-Z]+/;
  }

  private get pikpakLinkRegex(): RegExp {
    return /https?:\/\/mypikpak\.com\/s\/[0-9a-zA-Z]+/;
  }

  private get magnetLinkRegex(): RegExp {
    return /magnet:\?xt=urn:btih:[0-9a-fA-F]{40}/;
  }

  private get ed2kLinkRegex(): RegExp {
    return /ed2k:\/\/\|file\|.+\|\d+\|[0-9a-fA-F]{32}\|\//;
  }

  // 获取性能统计信息
  getPerformanceStats(): Record<string, any> {
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
      cache_misses: misses
    };
  }
}

// 导出插件实例
const plugin = new HubanPlugin();
export default plugin;

// 导出辅助函数
export function addAllowedReferer(referer: string): void {
  for (const existing of AllowedReferers) {
    if (existing === referer) {
      return; // 已存在，不重复添加
    }
  }
  AllowedReferers.push(referer);
}

export function removeAllowedReferer(referer: string): void {
  for (let i = 0; i < AllowedReferers.length; i++) {
    if (AllowedReferers[i] === referer) {
      AllowedReferers.splice(i, 1);
      return;
    }
  }
}

export function getAllowedReferers(): string[] {
  return [...AllowedReferers];
}

export function isRefererAllowed(referer: string): boolean {
  for (const allowedReferer of AllowedReferers) {
    if (referer.startsWith(allowedReferer)) {
      return true;
    }
  }
  return false;
}