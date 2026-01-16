import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios';
import { BaseAsyncPlugin } from '../plugin.manager';
import { SearchResult, Link } from '../../models/plugin-result';
import * as cheerio from 'cheerio';

// 正则表达式
const quarkLinkRegex = /https?:\/\/pan\.quark\.cn\/s\/[0-9a-zA-Z_\-]+/g;
const pwdRegex = /提取码[:：]\s*([a-zA-Z0-9]{4})/g;
const whitespaceRegex = /\s+/g;

// 常量定义
const pluginName = "djgou";
const siteURL = "https://duanjugou.top";
const defaultTimeout = 8000;
const detailTimeout = 6000;
const maxConcurrency = 15;
const cacheTTL = 1 * 60 * 60 * 1000; // 1小时
const cacheCleanupInterval = 30 * 60 * 1000; // 30分钟

// 缓存相关
interface DetailCacheData {
  links: Link[];
  content: string;
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

export class DjgouPlugin extends BaseAsyncPlugin {
  constructor() {
    super(pluginName, 2); // 优先级2：质量良好的数据源
  }

  Name(): string {
    return pluginName;
  }

  DisplayName(): string {
    return '短剧狗';
  }

  Description(): string {
    return '短剧狗 - 夸克网盘资源搜索';
  }

  protected async searchImpl(client: AxiosInstance, keyword: string): Promise<SearchResult[]> {
    try {
      // 1. 构建搜索URL
      const searchURL = `${siteURL}/search.php?q=${encodeURIComponent(keyword)}&page=1`;

      // 2. 发送请求（带重试机制）
      const resp = await this.doRequestWithRetry(client, searchURL);

      if (resp.status !== 200) {
        throw new Error(`[${this.Name()}] 搜索请求返回状态码: ${resp.status}`);
      }

      // 3. 解析搜索结果页面
      const $ = cheerio.load(resp.data);

      // 4. 提取搜索结果
      const results: SearchResult[] = [];

      // 查找主列表容器
      const mainListSection = $('div.erx-list-box');
      if (mainListSection.length === 0) {
        throw new Error(`[${this.Name()}] 未找到erx-list-box容器`);
      }

      // 查找列表项
      const items = mainListSection.find('ul.erx-list li.item');
      if (items.length === 0) {
        return []; // 没有搜索结果
      }

      // 5. 解析每个搜索结果项
      items.each((i, element) => {
        const result = this.parseSearchItem($(element), keyword);
        if (result.UniqueID !== '') {
          results.push(result);
        }
      });

      // 6. 异步获取详情页信息
      const enhancedResults = await this.enhanceWithDetails(client, results);

      // 7. 关键词过滤
      return this.filterResultsByKeyword(enhancedResults, keyword);
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
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'Connection': 'keep-alive',
      'Upgrade-Insecure-Requests': '1',
      'Cache-Control': 'max-age=0',
      'Referer': siteURL
    };
  }

  private parseSearchItem(s: cheerio.Cheerio, keyword: string): SearchResult {
    const result: SearchResult = {
      UniqueID: '',
      Title: '',
      Content: '',
      Links: [],
      Tags: ['短剧'],
      Channel: '',
      Datetime: new Date(),
      MessageID: ''
    };

    // 提取标题区域
    const aDiv = s.find('div.a');
    if (aDiv.length === 0) {
      return result;
    }

    // 提取链接和标题
    const linkElem = aDiv.find('a.main');
    if (linkElem.length === 0) {
      return result;
    }

    const title = linkElem.text().trim();
    const link = linkElem.attr('href');
    if (!link) {
      return result;
    }

    // 处理相对路径
    let fullLink = link;
    if (!link.startsWith('http')) {
      if (link.startsWith('/')) {
        fullLink = siteURL + link;
      } else {
        fullLink = siteURL + '/' + link;
      }
    }

    // 提取时间
    let timeText = '';
    const iDiv = s.find('div.i');
    if (iDiv.length > 0) {
      const timeSpan = iDiv.find('span.time');
      if (timeSpan.length > 0) {
        timeText = timeSpan.text().trim();
      }
    }

    // 生成唯一ID（使用链接的路径部分）
    const itemID = fullLink.replace(siteURL, '').replace(/^\//, '').replace(/\/$/, '');
    result.UniqueID = `${this.Name()}-${encodeURIComponent(itemID)}`;
    result.MessageID = result.UniqueID;

    result.Title = title;
    result.Datetime = this.parseTime(timeText);
    result.Content = fullLink; // 将详情页链接存储在Content中，后续获取详情

    return result;
  }

  private parseTime(timeStr: string): Date {
    if (!timeStr) {
      return new Date();
    }

    // 尝试多种时间格式
    const formats = [
      'YYYY-MM-DD HH:mm:ss',
      'YYYY-MM-DD HH:mm',
      'YYYY-MM-DD',
      'YYYY/MM/DD HH:mm:ss',
      'YYYY/MM/DD HH:mm',
      'YYYY/MM/DD'
    ];

    for (const format of formats) {
      const date = this.parseDate(timeStr, format);
      if (!isNaN(date.getTime())) {
        return date;
      }
    }

    return new Date();
  }

  private parseDate(dateStr: string, format: string): Date {
    if (format === 'YYYY-MM-DD') {
      const parts = dateStr.split('-');
      if (parts.length === 3) {
        return new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
      }
    } else if (format === 'YYYY-MM-DD HH:mm:ss') {
      const parts = dateStr.split(' ');
      if (parts.length === 2) {
        const dateParts = parts[0].split('-');
        const timeParts = parts[1].split(':');
        if (dateParts.length === 3 && timeParts.length === 3) {
          return new Date(
            parseInt(dateParts[0]),
            parseInt(dateParts[1]) - 1,
            parseInt(dateParts[2]),
            parseInt(timeParts[0]),
            parseInt(timeParts[1]),
            parseInt(timeParts[2])
          );
        }
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
    } else if (format === 'YYYY/MM/DD') {
      const parts = dateStr.split('/');
      if (parts.length === 3) {
        return new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
      }
    } else if (format === 'YYYY/MM/DD HH:mm:ss') {
      const parts = dateStr.split(' ');
      if (parts.length === 2) {
        const dateParts = parts[0].split('/');
        const timeParts = parts[1].split(':');
        if (dateParts.length === 3 && timeParts.length === 3) {
          return new Date(
            parseInt(dateParts[0]),
            parseInt(dateParts[1]) - 1,
            parseInt(dateParts[2]),
            parseInt(timeParts[0]),
            parseInt(timeParts[1]),
            parseInt(timeParts[2])
          );
        }
      }
    } else if (format === 'YYYY/MM/DD HH:mm') {
      const parts = dateStr.split(' ');
      if (parts.length === 2) {
        const dateParts = parts[0].split('/');
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

  private async enhanceWithDetails(client: AxiosInstance, results: SearchResult[]): Promise<SearchResult[]> {
    if (results.length === 0) {
      return [];
    }

    const semaphore = new Semaphore(maxConcurrency);
    const tasks: Promise<SearchResult | null>[] = [];

    for (const result of results) {
      tasks.push((async () => {
        await semaphore.acquire();
        try {
          // 从缓存或详情页获取链接
          const { links, content } = await this.getDetailInfo(client, result.Content);
          
          // 更新结果
          const newResult = { ...result };
          newResult.Links = links;
          newResult.Content = content;
          
          // 只添加有链接的结果
          if (links.length > 0) {
            return newResult;
          }
          return null;
        } catch (error) {
          console.error(`[${this.Name()}] 获取详情页失败:`, error);
          return null;
        } finally {
          semaphore.release();
        }
      })());
    }

    const enhancedResults = await Promise.all(tasks);
    return enhancedResults.filter((r): r is SearchResult => r !== null);
  }

  private async getDetailInfo(client: AxiosInstance, detailURL: string): Promise<{ links: Link[]; content: string }> {
    // 检查缓存
    if (detailCache.has(detailURL)) {
      const cached = detailCache.get(detailURL);
      if (cached && Date.now() - cached.timestamp < cacheTTL) {
        return { links: cached.links, content: cached.content };
      }
      detailCache.delete(detailURL);
    }

    // 获取详情页
    const { links, content } = await this.fetchDetailPage(client, detailURL);

    // 存入缓存
    if (links.length > 0) {
      detailCache.set(detailURL, {
        links,
        content,
        timestamp: Date.now()
      });
    }

    return { links, content };
  }

  private async fetchDetailPage(client: AxiosInstance, detailURL: string): Promise<{ links: Link[]; content: string }> {
    try {
      const resp = await client.get(detailURL, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
          'Referer': siteURL
        },
        timeout: detailTimeout
      });

      if (resp.status !== 200) {
        return { links: [], content: '' };
      }

      // 解析页面
      const $ = cheerio.load(resp.data);

      // 查找主内容区域（用于提取简介）
      const mainContent = $('div.erx-wrap');
      if (mainContent.length === 0) {
        return { links: [], content: '' };
      }

      // 提取网盘链接（从整个页面HTML中提取，不仅仅是mainContent）
      const links = this.extractLinksFromDoc($);

      // 提取简介（从mainContent提取）
      const content = this.extractContent(mainContent);

      return { links, content };
    } catch (error) {
      console.error(`[${this.Name()}] 获取详情页失败:`, error);
      return { links: [], content: '' };
    }
  }

  private extractLinksFromDoc($: cheerio.CheerioAPI): Link[] {
    const links: Link[] = [];
    const linkMap = new Set<string>();

    // 获取整个页面的HTML内容
    const htmlContent = $.html();

    // 提取提取码
    let password = '';
    const pwdMatch = htmlContent.match(pwdRegex);
    if (pwdMatch && pwdMatch.length >= 2) {
      password = pwdMatch[1];
    }
    pwdRegex.lastIndex = 0;

    // 方法1：使用专用正则表达式提取夸克网盘链接
    let match;
    while ((match = quarkLinkRegex.exec(htmlContent)) !== null) {
      const quarkURL = match[0];
      if (!linkMap.has(quarkURL)) {
        linkMap.add(quarkURL);
        links.push({
          Type: "quark",
          URL: quarkURL,
          Password: password
        });
      }
    }
    quarkLinkRegex.lastIndex = 0;

    // 方法2：从所有<a>标签中查找夸克链接（作为补充）
    $('a').each((_, element) => {
      const href = $(element).attr('href');
      if (href && href.includes('pan.quark.cn')) {
        if (!linkMap.has(href)) {
          linkMap.add(href);
          links.push({
            Type: "quark",
            URL: href,
            Password: password
          });
        }
      }
    });

    return links;
  }

  private extractContent(mainContent: cheerio.Cheerio): string {
    let content = mainContent.text().trim();
    
    // 清理空白字符
    content = content.replace(whitespaceRegex, ' ');
    
    // 限制长度
    if (content.length > 300) {
      content = content.substring(0, 300) + '...';
    }
    
    return content;
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
const plugin = new DjgouPlugin();
plugin.register();
