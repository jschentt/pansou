import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios';
import { BaseAsyncPlugin } from '../plugin.manager';
import { SearchResult, Link } from '../../models/plugin-result';
import * as cheerio from 'cheerio';

// 常量定义
const pluginName = "fox4k";
const displayName = "极狐4K";
const description = "极狐4K - 影视资源搜索";
const baseURL = "https://4kfox.com";
const searchURL = baseURL + "/search/%s-------------.html";
const searchPageURL = baseURL + "/search/%s----------%d---.html";
const detailURL = baseURL + "/video/%s.html";
const userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36";
const requestTimeout = 15000;
const maxConcurrency = 50;
const maxPages = 10;
const cacheTTL = 1 * 60 * 60 * 1000; // 1小时

// 调试开关
const debugMode = false;

// 性能统计
let searchRequests = 0;
let detailPageRequests = 0;
let cacheHits = 0;
let cacheMisses = 0;
let totalSearchTime = 0;
let totalDetailTime = 0;

// 正则表达式
const detailIDRegex = /\/video\/(\d+)\.html/;
const magnetLinkRegex = /magnet:\?xt=urn:btih:[0-9a-fA-F]{40}[^"'\s]*/g;
const ed2kLinkRegex = /ed2k:\/\/\|file\|[^|]+\|[^|]+\|[^|]+\|\/?/g;
const yearRegex = /(\d{4})/;

// 网盘链接正则表达式
const panLinkRegexes: Record<string, RegExp> = {
  "baidu": /https?:\/\/pan\.baidu\.com\/s\/[0-9a-zA-Z_-]+(?:\?pwd=[0-9a-zA-Z]+)?(?:&v=\d+)?/g,
  "aliyun": /https?:\/\/(?:www\.)?alipan\.com\/s\/[0-9a-zA-Z_-]+/g,
  "tianyi": /https?:\/\/cloud\.189\.cn\/t\/[0-9a-zA-Z_-]+(?:\([^)]*\))?/g,
  "uc": /https?:\/\/drive\.uc\.cn\/s\/[0-9a-fA-F]+(?:\?[^"]\s*)?/g,
  "mobile": /https?:\/\/caiyun\.139\.com\/[^"\s]+/g,
  "115": /https?:\/\/115\.com\/s\/[0-9a-zA-Z_-]+/g,
  "pikpak": /https?:\/\/mypikpak\.com\/s\/[0-9a-zA-Z_-]+/g,
  "xunlei": /https?:\/\/pan\.xunlei\.com\/s\/[0-9a-zA-Z_-]+(?:\?pwd=[0-9a-zA-Z]+)?/g,
  "123": /https?:\/\/(?:www\.)?123pan\.com\/s\/[0-9a-zA-Z_-]+/g,
};

// 夸克网盘链接正则表达式（用于排除）
const quarkLinkRegex = /https?:\/\/pan\.quark\.cn\/s\/[0-9a-fA-F]+(?:\?pwd=[0-9a-zA-Z]+)?/g;

// 密码提取正则表达式
const passwordRegexes: RegExp[] = [
  /\?pwd=([0-9a-zA-Z]+)/g,                           // URL中的pwd参数
  /提取码[：:]\s*([0-9a-zA-Z]+)/g,                    // 提取码：xxxx
  /访问码[：:]\s*([0-9a-zA-Z]+)/g,                    // 访问码：xxxx
  /密码[：:]\s*([0-9a-zA-Z]+)/g,                     // 密码：xxxx
  /（访问码[：:]\s*([0-9a-zA-Z]+)）/g,                  // （访问码：xxxx）
];

// 详情页缓存
const detailCache = new Map<string, DetailPageResponse>();

// 缓存清理定时器
setInterval(() => {
  const now = Date.now();
  detailCache.forEach((value, key) => {
    if (now - value.timestamp > cacheTTL) {
      detailCache.delete(key);
    }
  });
}, 30 * 60 * 1000); // 每30分钟清理一次

// 详情页响应结构
interface DetailPageResponse {
  title: string;
  imageURL: string;
  downloads: Link[];
  tags: string[];
  content: string;
  timestamp: number;
}

export class Fox4kPlugin extends BaseAsyncPlugin {
  constructor() {
    super(pluginName, 3); // 优先级3
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
    this.debugPrint(`searchImpl 开始执行 - keyword: ${keyword}`);
    const startTime = Date.now();
    searchRequests++;

    try {
      const encodedKeyword = encodeURIComponent(keyword);
      const allResults: SearchResult[] = [];

      // 1. 搜索第一页，获取总页数
      const { results: firstPageResults, totalPages } = await this.searchPage(client, encodedKeyword, 1);
      allResults.push(...firstPageResults);

      // 2. 如果有多页，继续搜索其他页面（限制最大页数）
      const maxPagesToSearch = Math.min(totalPages, maxPages);

      if (totalPages > 1 && maxPagesToSearch > 1) {
        // 并发搜索其他页面
        const tasks: Promise<SearchResult[]>[] = [];
        for (let page = 2; page <= maxPagesToSearch; page++) {
          tasks.push(this.searchPage(client, encodedKeyword, page).then(result => result.results));
        }

        const pageResults = await Promise.all(tasks);
        for (const results of pageResults) {
          allResults.push(...results);
        }
      }

      // 3. 并发获取详情页信息
      const enrichedResults = await this.enrichWithDetailInfo(allResults, client);

      // 4. 过滤关键词匹配的结果
      const filteredResults = this.filterResultsByKeyword(enrichedResults, keyword);

      // 记录性能统计
      const searchDuration = Date.now() - startTime;
      totalSearchTime += searchDuration;

      this.debugPrint(`searchImpl 完成 - 原始结果: ${allResults.length}, 过滤后结果: ${filteredResults.length}, 耗时: ${searchDuration}ms`);

      return filteredResults;
    } catch (error) {
      console.error(`[FOX4K] 搜索失败:`, error);
      return [];
    }
  }

  private async searchPage(client: AxiosInstance, encodedKeyword: string, page: number): Promise<{ results: SearchResult[]; totalPages: number }> {
    this.debugPrint(`searchPage 开始 - 第${page}页, keyword: ${encodedKeyword}`);

    // 构建搜索URL
    const searchURL = page === 1 
      ? searchURL.replace('%s', encodedKeyword)
      : searchPageURL.replace('%s', encodedKeyword).replace('%d', page.toString());

    this.debugPrint(`构建的URL: ${searchURL}`);

    // 发送请求（带重试机制）
    const resp = await this.doRequestWithRetry(client, searchURL);

    if (resp.status !== 200) {
      throw new Error(`[${this.Name()}] 第${page}页请求返回状态码: ${resp.status}`);
    }

    // 解析HTML响应
    const htmlContent = resp.data;
    this.debugPrint(`第${page}页 HTML长度: ${htmlContent.length} bytes`);

    const $ = cheerio.load(htmlContent);

    // 解析总页数
    const totalPages = this.parseTotalPages($);

    // 提取搜索结果
    const results: SearchResult[] = [];
    $('.hl-list-item').each((i, element) => {
      const result = this.parseSearchResultItem($(element));
      if (result) {
        results.push(result);
      }
    });

    return { results, totalPages };
  }

  private parseTotalPages($: cheerio.CheerioAPI): number {
    // 查找分页信息，格式为 "1 / 2"
    const pageInfo = $('.hl-page-tips a').text().trim();
    if (!pageInfo) {
      return 1;
    }

    // 解析 "1 / 2" 格式
    const parts = pageInfo.split('/');
    if (parts.length !== 2) {
      return 1;
    }

    const totalPagesStr = parts[1].trim();
    const totalPages = parseInt(totalPagesStr, 10);
    if (isNaN(totalPages) || totalPages < 1) {
      return 1;
    }

    return totalPages;
  }

  private parseSearchResultItem(s: cheerio.Cheerio): SearchResult | null {
    // 获取详情页链接
    const linkElement = s.find('.hl-item-pic a').first();
    const href = linkElement.attr('href');
    if (!href) {
      return null;
    }

    // 补全URL
    let fullHref = href;
    if (href.startsWith('/')) {
      fullHref = baseURL + href;
    }

    // 提取ID
    const matches = fullHref.match(detailIDRegex);
    if (!matches || matches.length < 2) {
      return null;
    }
    const id = matches[1];

    // 获取标题
    const titleElement = s.find('.hl-item-title a').first();
    const title = titleElement.text().trim();
    if (!title) {
      return null;
    }

    // 获取封面图片
    const imgElement = s.find('.hl-item-thumb');
    let imageURL = imgElement.attr('data-original') || '';
    if (imageURL && imageURL.startsWith('/')) {
      imageURL = baseURL + imageURL;
    }

    // 获取资源状态
    const status = s.find('.hl-pic-text .remarks').text().trim();

    // 获取评分
    const score = s.find('.hl-text-conch.score').text().trim();

    // 获取基本信息（年份、地区、类型）
    const basicInfo = s.find('.hl-item-sub').first().text().trim();

    // 获取简介
    const description = s.find('.hl-item-sub').last().text().trim();

    // 解析年份、地区、类型
    let year = '', region = '', category = '';
    if (basicInfo) {
      const parts = basicInfo.split('·');
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i].trim();
        if (!part) {
          continue;
        }
        
        // 跳过评分
        if (part.includes(score)) {
          continue;
        }
        
        // 第一个通常是年份
        if (i === 0 || (i === 1 && parts[0].includes(score))) {
          if (yearRegex.test(part)) {
            year = part;
          }
        } else if (!region) {
          region = part;
        } else if (!category) {
          category = part;
        } else {
          category += ' ' + part;
        }
      }
    }

    // 构建标签
    const tags: string[] = [];
    if (status) {
      tags.push(status);
    }
    if (year) {
      tags.push(year);
    }
    if (region) {
      tags.push(region);
    }
    if (category) {
      tags.push(category);
    }

    // 构建内容描述
    let content = description;
    if (basicInfo) {
      content = basicInfo + '\n' + description;
    }
    if (score) {
      content = '评分: ' + score + '\n' + content;
    }

    return {
      UniqueID: `${this.Name()}-${id}`,
      Title: title,
      Content: content,
      Datetime: new Date(),
      Tags: tags,
      Links: [], // 初始为空，后续在详情页中填充
      Channel: "", // 插件搜索结果，Channel必须为空
      MessageID: `${this.Name()}-${id}`
    };
  }

  private async enrichWithDetailInfo(results: SearchResult[], client: AxiosInstance): Promise<SearchResult[]> {
    if (results.length === 0) {
      return [];
    }

    const semaphore = new Semaphore(maxConcurrency);
    const tasks: Promise<SearchResult | null>[] = [];

    for (const result of results) {
      tasks.push((async () => {
        await semaphore.acquire();
        try {
          // 从UniqueID中提取ID
          const parts = result.UniqueID.split('-');
          if (parts.length < 2) {
            return result;
          }
          const id = parts[parts.length - 1];

          // 获取详情页信息
          const detailInfo = await this.getDetailInfo(id, client);
          if (detailInfo) {
            const newResult = { ...result };
            newResult.Links = detailInfo.downloads;
            if (detailInfo.content) {
              newResult.Content = detailInfo.content;
            }
            // 补充标签
            for (const tag of detailInfo.tags) {
              if (!newResult.Tags.includes(tag)) {
                newResult.Tags.push(tag);
              }
            }
            return newResult;
          }
          return result;
        } catch (error) {
          console.error(`[FOX4K] 获取详情页信息失败:`, error);
          return result;
        } finally {
          semaphore.release();
        }
      })());
    }

    const enrichedResults = await Promise.all(tasks);
    // 过滤掉没有有效下载链接的结果
    return enrichedResults.filter((result): result is SearchResult => {
      return result !== null && result.Links.length > 0;
    });
  }

  private async getDetailInfo(id: string, client: AxiosInstance): Promise<DetailPageResponse | null> {
    const startTime = Date.now();
    detailPageRequests++;

    // 检查缓存
    if (detailCache.has(id)) {
      const cached = detailCache.get(id);
      if (cached && Date.now() - cached.timestamp < cacheTTL) {
        cacheHits++;
        return cached;
      }
      detailCache.delete(id);
    }

    cacheMisses++;

    // 构建详情页URL
    const url = detailURL.replace('%s', id);

    try {
      const resp = await client.get(url, {
        headers: this.setCommonHeaders(),
        timeout: requestTimeout
      });

      if (resp.status !== 200) {
        return null;
      }

      // 解析HTML
      const htmlContent = resp.data;
      const $ = cheerio.load(htmlContent);

      // 解析详情页信息
      const detail: DetailPageResponse = {
        title: '',
        imageURL: '',
        downloads: [],
        tags: [],
        content: '',
        timestamp: Date.now()
      };

      // 获取标题
      detail.title = $('h2.hl-dc-title').text().trim();

      // 获取封面图片
      const imgElement = $('.hl-dc-pic .hl-item-thumb');
      const imageURL = imgElement.attr('data-original');
      if (imageURL) {
        detail.imageURL = imageURL.startsWith('/') ? baseURL + imageURL : imageURL;
      }

      // 获取剧情简介
      detail.content = $('.hl-content-wrap .hl-content-text').text().trim();

      // 提取详细信息作为标签
      $('.hl-vod-data ul li').each((i, element) => {
        const text = $(element).text().trim();
        if (text) {
          // 清理标签文本
          const cleanedText = text.replace(/：/g, ': ');
          if (cleanedText.includes('类型:') || cleanedText.includes('地区:') || cleanedText.includes('语言:')) {
            detail.tags.push(cleanedText);
          }
        }
      });

      // 提取下载链接
      this.extractDownloadLinks($, detail);

      // 缓存结果
      detailCache.set(id, detail);

      // 记录性能统计
      const detailDuration = Date.now() - startTime;
      totalDetailTime += detailDuration;

      return detail;
    } catch (error) {
      console.error(`[FOX4K] 获取详情页失败:`, error);
      return null;
    }
  }

  private extractDownloadLinks($: cheerio.CheerioAPI, detail: DetailPageResponse): void {
    // 提取页面中所有文本内容，寻找链接
    const pageText = $.text();

    // 1. 提取磁力链接
    let match;
    while ((match = magnetLinkRegex.exec(pageText)) !== null) {
      this.addDownloadLink(detail, "magnet", match[0], "");
    }
    magnetLinkRegex.lastIndex = 0;

    // 2. 提取电驴链接
    while ((match = ed2kLinkRegex.exec(pageText)) !== null) {
      this.addDownloadLink(detail, "ed2k", match[0], "");
    }
    ed2kLinkRegex.lastIndex = 0;

    // 3. 提取网盘链接（排除夸克）
    for (const panType in panLinkRegexes) {
      const regex = panLinkRegexes[panType];
      while ((match = regex.exec(pageText)) !== null) {
        // 提取密码（如果有）
        const password = this.extractPasswordFromText(pageText, match[0]);
        this.addDownloadLink(detail, panType, match[0], password);
      }
      regex.lastIndex = 0;
    }

    // 4. 在特定的下载区域查找链接
    $('.hl-rb-downlist').each((i, downlistSection) => {
      // 获取质量版本信息
      let currentQuality = '';
      $(downlistSection).find('.hl-tabs-btn').each((j, tabBtn) => {
        if ($(tabBtn).hasClass('active')) {
          currentQuality = $(tabBtn).text().trim();
        }
      });
      
      // 提取各种下载链接
      $(downlistSection).find('.hl-downs-list li').each((k, linkItem) => {
        const itemText = $(linkItem).text();
        
        // 从 data-clipboard-text 属性提取链接
        const clipboardText = $(linkItem).find('.down-copy').attr('data-clipboard-text');
        if (clipboardText) {
          this.processFoundLink(detail, clipboardText, currentQuality);
        }
        
        // 从 href 属性提取链接
        $(linkItem).find('a').each((l, link) => {
          const href = $(link).attr('href');
          if (href) {
            this.processFoundLink(detail, href, currentQuality);
          }
        });
        
        // 从文本内容中提取链接
        this.extractLinksFromText(detail, itemText, currentQuality);
      });
    });

    // 5. 在播放源区域也查找链接
    $('.hl-rb-playlist').each((i, playlistSection) => {
      const sectionText = $(playlistSection).text();
      this.extractLinksFromText(detail, sectionText, "播放源");
    });
  }

  private processFoundLink(detail: DetailPageResponse, link: string, quality: string): void {
    if (!link) {
      return;
    }

    // 排除夸克网盘链接
    if (quarkLinkRegex.test(link)) {
      return;
    }

    // 检查磁力链接
    if (magnetLinkRegex.test(link)) {
      this.addDownloadLink(detail, "magnet", link, "");
      magnetLinkRegex.lastIndex = 0;
      return;
    }
    magnetLinkRegex.lastIndex = 0;

    // 检查电驴链接
    if (ed2kLinkRegex.test(link)) {
      this.addDownloadLink(detail, "ed2k", link, "");
      ed2kLinkRegex.lastIndex = 0;
      return;
    }
    ed2kLinkRegex.lastIndex = 0;

    // 检查网盘链接
    for (const panType in panLinkRegexes) {
      const regex = panLinkRegexes[panType];
      if (regex.test(link)) {
        const password = this.extractPasswordFromLink(link);
        this.addDownloadLink(detail, panType, link, password);
        regex.lastIndex = 0;
        return;
      }
      regex.lastIndex = 0;
    }
  }

  private extractLinksFromText(detail: DetailPageResponse, text: string, quality: string): void {
    // 排除包含夸克链接的文本
    if (quarkLinkRegex.test(text)) {
      return;
    }
    quarkLinkRegex.lastIndex = 0;

    // 磁力链接
    let match;
    while ((match = magnetLinkRegex.exec(text)) !== null) {
      this.addDownloadLink(detail, "magnet", match[0], "");
    }
    magnetLinkRegex.lastIndex = 0;

    // 电驴链接
    while ((match = ed2kLinkRegex.exec(text)) !== null) {
      this.addDownloadLink(detail, "ed2k", match[0], "");
    }
    ed2kLinkRegex.lastIndex = 0;

    // 网盘链接
    for (const panType in panLinkRegexes) {
      const regex = panLinkRegexes[panType];
      while ((match = regex.exec(text)) !== null) {
        const password = this.extractPasswordFromText(text, match[0]);
        this.addDownloadLink(detail, panType, match[0], password);
      }
      regex.lastIndex = 0;
    }
  }

  private extractPasswordFromLink(link: string): string {
    // 首先检查URL参数中的密码
    for (const regex of passwordRegexes) {
      const match = regex.exec(link);
      if (match && match.length > 1) {
        regex.lastIndex = 0;
        return match[1];
      }
      regex.lastIndex = 0;
    }
    return "";
  }

  private extractPasswordFromText(text: string, link: string): string {
    // 首先从链接本身提取密码
    const passwordFromLink = this.extractPasswordFromLink(link);
    if (passwordFromLink) {
      return passwordFromLink;
    }

    // 然后从周围文本中查找密码
    for (const regex of passwordRegexes) {
      const match = regex.exec(text);
      if (match && match.length > 1) {
        regex.lastIndex = 0;
        return match[1];
      }
      regex.lastIndex = 0;
    }

    return "";
  }

  private addDownloadLink(detail: DetailPageResponse, linkType: string, linkURL: string, password: string): void {
    if (!linkURL) {
      return;
    }

    // 跳过夸克网盘链接
    if (quarkLinkRegex.test(linkURL)) {
      return;
    }
    quarkLinkRegex.lastIndex = 0;

    // 检查是否已存在
    for (const existingLink of detail.downloads) {
      if (existingLink.URL === linkURL) {
        return;
      }
    }

    // 创建链接对象
    const link: Link = {
      Type: linkType,
      URL: linkURL,
      Password: password,
    };

    detail.downloads.push(link);
  }

  private async doRequestWithRetry(client: AxiosInstance, url: string, timeout: number = requestTimeout): Promise<AxiosResponse> {
    const maxRetries = 3;
    let lastError: any = null;

    for (let i = 0; i < maxRetries; i++) {
      try {
        if (i > 0) {
          // 指数退避重试
          const backoff = Math.pow(2, i - 1) * 200;
          await new Promise(resolve => setTimeout(resolve, backoff));
        }

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
    }

    throw new Error(`[${this.Name()}] 重试 ${maxRetries} 次后仍然失败: ${lastError?.message}`);
  }

  private setCommonHeaders(): Record<string, string> {
    return {
      'User-Agent': userAgent,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'Connection': 'keep-alive',
      'Upgrade-Insecure-Requests': '1',
      'Cache-Control': 'max-age=0',
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

  private debugPrint(message: string): void {
    if (debugMode) {
      console.log(`[FOX4K DEBUG] ${message}`);
    }
  }

  // 获取性能统计信息
  public getPerformanceStats(): Record<string, any> {
    const totalSearches = searchRequests;
    const totalDetails = detailPageRequests;
    const hits = cacheHits;
    const misses = cacheMisses;
    const searchTime = totalSearchTime;
    const detailTime = totalDetailTime;

    const stats: Record<string, any> = {
      search_requests: totalSearches,
      detail_page_requests: totalDetails,
      cache_hits: hits,
      cache_misses: misses,
      cache_hit_rate: hits > 0 ? (hits / (hits + misses)) * 100 : 0,
    };

    if (totalSearches > 0) {
      stats.avg_search_time_ms = searchTime / totalSearches;
    }
    if (totalDetails > 0) {
      stats.avg_detail_time_ms = detailTime / totalDetails;
    }

    return stats;
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
const plugin = new Fox4kPlugin();
plugin.register();