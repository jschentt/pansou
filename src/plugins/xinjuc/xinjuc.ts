import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios';
import cheerio from 'cheerio';
import { BaseAsyncPlugin } from '../plugin.manager';
import { SearchResult, Link } from '../../models/plugin-result';

// 网站URL
const SiteURL = 'https://www.xinjuc.com';

// 超时时间
const DefaultTimeout = 10000;
const DetailTimeout = 8000;

// 并发数
const MaxConcurrency = 15;

// 缓存相关
const CacheTTL = 1 * 60 * 60 * 1000; // 1小时

interface DetailCacheData {
  Links: Link[];
  Content: string;
  Timestamp: number;
}

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
    this.currentConcurrent--;
    if (this.waiting.length > 0) {
      const next = this.waiting.shift();
      if (next) {
        this.currentConcurrent++;
        next();
      }
    }
  }
}

export class XinjucPlugin extends BaseAsyncPlugin {
  private detailCache: Map<string, DetailCacheData>;
  private lastCleanupTime: number;

  constructor() {
    super('xinjuc', 2); // 优先级2：质量良好的数据源
    this.detailCache = new Map();
    this.lastCleanupTime = Date.now();
    // 启动缓存清理
    this.startCacheCleaner();
  }

  Name(): string {
    return 'xinjuc';
  }

  DisplayName(): string {
    return '新剧坊';
  }

  Description(): string {
    return '新剧坊 - 影视资源搜索';
  }

  private startCacheCleaner(): void {
    setInterval(() => {
      this.cleanCache();
    }, 30 * 60 * 1000); // 每30分钟清理一次
  }

  private cleanCache(): void {
    const now = Date.now();
    for (const [key, item] of this.detailCache.entries()) {
      if (now - item.Timestamp > CacheTTL) {
        this.detailCache.delete(key);
      }
    }
    this.lastCleanupTime = now;
  }

  private async doRequestWithRetry(client: AxiosInstance, config: AxiosRequestConfig): Promise<AxiosResponse> {
    const maxRetries = 3;
    let lastError: Error | null = null;

    for (let i = 0; i < maxRetries; i++) {
      if (i > 0) {
        // 指数退避重试
        const backoff = Math.pow(2, i - 1) * 200;
        await new Promise(resolve => setTimeout(resolve, backoff));
      }

      try {
        const response = await client(config);
        if (response.status === 200) {
          return response;
        }
      } catch (error) {
        lastError = error as Error;
      }
    }

    throw new Error(`重试 ${maxRetries} 次后仍然失败: ${lastError?.message}`);
  }

  protected async searchImpl(client: AxiosInstance, keyword: string): Promise<SearchResult[]> {
    // 1. 构建搜索URL
    const searchURL = `${SiteURL}/?s=${encodeURIComponent(keyword)}`;

    // 2. 创建请求配置
    const config: AxiosRequestConfig = {
      url: searchURL,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Connection': 'keep-alive',
        'Referer': SiteURL
      },
      timeout: DefaultTimeout
    };

    try {
      // 3. 发送请求（带重试机制）
      const resp = await this.doRequestWithRetry(client, config);

      // 4. 解析搜索结果页面
      const $ = cheerio.load(resp.data);

      // 5. 提取搜索结果
      const results: SearchResult[] = [];

      // 查找搜索结果列表
      const postList = $('div.row-xs.post-list article.post-item');
      if (postList.length === 0) {
        return []; // 没有搜索结果
      }

      // 6. 解析每个搜索结果项
      postList.each((i, s) => {
        const result = this.parseSearchItem($(s), keyword);
        if (result.UniqueID) {
          results.push(result);
        }
      });

      // 7. 异步获取详情页信息
      const enhancedResults = await this.enhanceWithDetails(client, results);

      // 8. 关键词过滤
      return this.filterResultsByKeyword(enhancedResults, keyword);
    } catch (error) {
      console.error(`[Xinjuc] 搜索失败: ${error}`);
      return [];
    }
  }

  private parseSearchItem(s: cheerio.Cheerio, keyword: string): SearchResult {
    const result: SearchResult = {
      Title: '',
      Content: '',
      Channel: '',
      MessageID: '',
      UniqueID: '',
      Datetime: new Date(),
      Links: [],
      Tags: []
    };

    // 提取详情页链接
    const linkElem = s.find('div.post-image a');
    if (linkElem.length === 0) {
      return result;
    }

    const detailLink = linkElem.attr('href');
    if (!detailLink) {
      return result;
    }

    // 处理相对路径
    let fullDetailLink = detailLink;
    if (!detailLink.startsWith('http')) {
      if (detailLink.startsWith('/')) {
        fullDetailLink = SiteURL + detailLink;
      } else {
        fullDetailLink = SiteURL + '/' + detailLink;
      }
    }

    // 提取ID
    const idMatch = /\/(\d+)\.html/.exec(fullDetailLink);
    if (!idMatch || !idMatch[1]) {
      return result;
    }
    const itemID = idMatch[1];
    result.UniqueID = `${this.Name()}-${itemID}`;
    result.MessageID = `${this.Name()}-${itemID}`;

    // 提取标题
    const titleElem = s.find('h5.post-title a');
    if (titleElem.length > 0) {
      result.Title = titleElem.text().trim();
    }

    // 提取标记（如"更至163"、"1080P"）
    const markElem = s.find('div.mark span');
    if (markElem.length > 0) {
      const mark = markElem.text().trim();
      if (mark) {
        result.Tags = [mark];
      }
    }

    // 提取更新时间
    const timeElem = s.find('div.post-footer span.time');
    if (timeElem.length > 0) {
      const timeStr = timeElem.text().trim();
      result.Datetime = this.parseTime(timeStr);
    }

    // 将详情页链接存储在Content中，后续获取详情
    result.Content = fullDetailLink;

    return result;
  }

  private parseTime(timeStr: string): Date {
    // 时间格式示例: "2025-04-21 更新", "04-21"
    timeStr = timeStr.replace(' 更新', '').trim();

    // 尝试多种时间格式
    const formats = [
      'YYYY-MM-DD',
      'MM-DD',
      'YYYY-MM-DD HH:mm:ss',
      'YYYY-MM-DD HH:mm'
    ];

    for (const format of formats) {
      try {
        if (format === 'MM-DD') {
          // 处理月-日格式
          const parts = timeStr.split('-');
          if (parts.length === 2) {
            const month = parseInt(parts[0]);
            const day = parseInt(parts[1]);
            if (!isNaN(month) && !isNaN(day)) {
              const now = new Date();
              return new Date(now.getFullYear(), month - 1, day);
            }
          }
        } else if (format === 'YYYY-MM-DD') {
          // 处理年-月-日格式
          const parts = timeStr.split('-');
          if (parts.length === 3) {
            const year = parseInt(parts[0]);
            const month = parseInt(parts[1]);
            const day = parseInt(parts[2]);
            if (!isNaN(year) && !isNaN(month) && !isNaN(day)) {
              return new Date(year, month - 1, day);
            }
          }
        } else if (format === 'YYYY-MM-DD HH:mm:ss') {
          // 处理完整时间格式
          const [datePart, timePart] = timeStr.split(' ');
          const dateParts = datePart.split('-');
          const timeParts = timePart.split(':');
          if (dateParts.length === 3 && timeParts.length === 3) {
            const year = parseInt(dateParts[0]);
            const month = parseInt(dateParts[1]);
            const day = parseInt(dateParts[2]);
            const hour = parseInt(timeParts[0]);
            const minute = parseInt(timeParts[1]);
            const second = parseInt(timeParts[2]);
            if (!isNaN(year) && !isNaN(month) && !isNaN(day) && !isNaN(hour) && !isNaN(minute) && !isNaN(second)) {
              return new Date(year, month - 1, day, hour, minute, second);
            }
          }
        } else if (format === 'YYYY-MM-DD HH:mm') {
          // 处理年-月-日 时:分格式
          const [datePart, timePart] = timeStr.split(' ');
          const dateParts = datePart.split('-');
          const timeParts = timePart.split(':');
          if (dateParts.length === 3 && timeParts.length === 2) {
            const year = parseInt(dateParts[0]);
            const month = parseInt(dateParts[1]);
            const day = parseInt(dateParts[2]);
            const hour = parseInt(timeParts[0]);
            const minute = parseInt(timeParts[1]);
            if (!isNaN(year) && !isNaN(month) && !isNaN(day) && !isNaN(hour) && !isNaN(minute)) {
              return new Date(year, month - 1, day, hour, minute);
            }
          }
        }
      } catch (error) {
        // 解析失败，尝试下一种格式
      }
    }

    return new Date();
  }

  private async enhanceWithDetails(client: AxiosInstance, results: SearchResult[]): Promise<SearchResult[]> {
    if (results.length === 0) {
      return [];
    }

    const semaphore = new Semaphore(MaxConcurrency);
    const promises = results.map(async (result) => {
      await semaphore.acquire();
      try {
        // 从缓存或详情页获取链接
        const { links, content } = await this.getDetailInfo(client, result.Content);
        
        // 更新结果
        result.Links = links;
        result.Content = content;
        
        // 只返回有链接的结果
        return links.length > 0 ? result : null;
      } finally {
        semaphore.release();
      }
    });

    const enhancedResults = await Promise.all(promises);
    return enhancedResults.filter((result): result is SearchResult => result !== null);
  }

  private async getDetailInfo(client: AxiosInstance, detailURL: string): Promise<{ links: Link[]; content: string }> {
    // 检查缓存
    const cached = this.detailCache.get(detailURL);
    if (cached) {
      if (Date.now() - cached.Timestamp < CacheTTL) {
        return { links: cached.Links, content: cached.Content };
      }
      // 缓存过期，删除
      this.detailCache.delete(detailURL);
    }

    // 获取详情页
    const { links, content } = await this.fetchDetailPage(client, detailURL);

    // 存入缓存
    if (links.length > 0) {
      this.detailCache.set(detailURL, {
        Links: links,
        Content: content,
        Timestamp: Date.now()
      });
    }

    return { links, content };
  }

  private async fetchDetailPage(client: AxiosInstance, detailURL: string): Promise<{ links: Link[]; content: string }> {
    const config: AxiosRequestConfig = {
      url: detailURL,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Referer': SiteURL
      },
      timeout: DetailTimeout
    };

    try {
      const resp = await client(config);
      if (resp.status !== 200) {
        return { links: [], content: '' };
      }

      // 解析页面
      const $ = cheerio.load(resp.data);

      // 查找文章内容区域
      const articleContent = $('div.article-content');
      if (articleContent.length === 0) {
        return { links: [], content: '' };
      }

      // 提取百度盘链接（从整个文档中提取）
      const links = this.extractLinksFromDoc($);

      // 提取简介（从文章内容中提取）
      const content = this.extractContent(articleContent);

      return { links, content };
    } catch (error) {
      console.error(`[Xinjuc] 获取详情页失败: ${error}`);
      return { links: [], content: '' };
    }
  }

  private extractLinksFromDoc($: cheerio.CheerioAPI): Link[] {
    const links: Link[] = [];
    const linkMap = new Set<string>();

    // 获取整个页面的HTML内容
    const htmlContent = $.html();

    // 提取提取码（多种方式）
    let password = '';
    const pwdMatch = /提取码[:：]\s*([a-zA-Z0-9]{4})/.exec(htmlContent);
    if (pwdMatch && pwdMatch[1]) {
      password = pwdMatch[1];
    }

    // 方式1: 使用正则表达式提取所有百度盘链接
    const baiduLinkRegex = /https?:\/\/pan\.baidu\.com\/s\/[0-9a-zA-Z_\-]{10,}(?:\?pwd=[0-9a-zA-Z]+)?/g;
    let match;
    while ((match = baiduLinkRegex.exec(htmlContent)) !== null) {
      const baiduURL = match[0].trim();
      if (this.isValidBaiduLink(baiduURL) && !linkMap.has(baiduURL)) {
        linkMap.add(baiduURL);
        
        // 从URL中提取密码（如果有）
        let urlPassword = password;
        const pwdURLMatch = /\?pwd=([0-9a-zA-Z]+)/.exec(baiduURL);
        if (pwdURLMatch && pwdURLMatch[1]) {
          urlPassword = pwdURLMatch[1];
        }
        
        links.push({
          Type: 'baidu',
          URL: baiduURL,
          Password: urlPassword
        });
      }
    }

    // 方式2: 从<a>标签中查找百度盘链接（作为补充）
    $('a').each((i, s) => {
      const href = $(s).attr('href');
      if (!href) {
        return;
      }

      // 清理链接
      const cleanedHref = href.trim();

      // 必须是纯百度盘域名开头
      if (!cleanedHref.startsWith('http://pan.baidu.com') && !cleanedHref.startsWith('https://pan.baidu.com')) {
        return;
      }

      // 验证链接有效性
      if (this.isValidBaiduLink(cleanedHref) && !linkMap.has(cleanedHref)) {
        linkMap.add(cleanedHref);

        // 从URL中提取密码（如果有）
        let urlPassword = password;
        const pwdURLMatch = /\?pwd=([0-9a-zA-Z]+)/.exec(cleanedHref);
        if (pwdURLMatch && pwdURLMatch[1]) {
          urlPassword = pwdURLMatch[1];
        }

        links.push({
          Type: 'baidu',
          URL: cleanedHref,
          Password: urlPassword
        });
      }
    });

    return links;
  }

  private isValidBaiduLink(link: string): boolean {
    // 必须是百度盘域名
    if (!link.startsWith('http://pan.baidu.com') && !link.startsWith('https://pan.baidu.com')) {
      return false;
    }

    // 必须包含 /s/ 路径
    if (!link.includes('/s/')) {
      return false;
    }

    // 使用正则验证格式
    const baiduLinkRegex = /https?:\/\/pan\.baidu\.com\/s\/[0-9a-zA-Z_\-]{10,}(?:\?pwd=[0-9a-zA-Z]+)?/;
    return baiduLinkRegex.test(link);
  }

  private extractContent(articleContent: cheerio.Cheerio): string {
    // 提取文本内容
    let content = articleContent.text().trim();

    // 清理空白字符
    content = content.replace(/\s+/g, ' ');

    // 移除百度盘相关的文本
    content = content.replace(/百度云网盘资源下载地址[:：]?\s*/g, '');
    content = content.replace(/链接[:：]?\s*https?:\/\/pan\.baidu\.com\/[^\s]+/g, '');
    content = content.replace(/提取码[:：]?\s*[a-zA-Z0-9]{4}/g, '');
    content = content.trim();

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

// 注册插件
const plugin = new XinjucPlugin();
plugin.register();
