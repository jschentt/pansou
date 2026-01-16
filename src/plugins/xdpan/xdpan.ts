import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios';
import cheerio from 'cheerio';
import { BaseAsyncPlugin } from '../plugin.manager';
import { SearchResult, Link } from '../../models/plugin-result';

const BaseURL = 'https://xiongdipan.com';
const UserAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36';
const MaxConcurrency = 10; // 详情页最大并发数
const MaxRetries = 3;

interface CacheItem {
  links: Link[];
  timestamp: number;
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

export class XdpanPlugin extends BaseAsyncPlugin {
  private detailCache: Map<string, CacheItem>;
  private cacheTTL: number;
  private debugLog: boolean;

  constructor() {
    super('xdpan', 3); // 优先级3 = 普通质量数据源
    this.detailCache = new Map();
    this.cacheTTL = 60 * 60 * 1000; // 60分钟
    this.debugLog = false;
  }

  Name(): string {
    return 'xdpan';
  }

  DisplayName(): string {
    return '兄弟盘';
  }

  Description(): string {
    return '兄弟盘 - 百度网盘资源搜索';
  }

  private async doRequestWithRetry(client: AxiosInstance, config: AxiosRequestConfig): Promise<AxiosResponse> {
    let lastError: Error | null = null;

    for (let i = 0; i < MaxRetries; i++) {
      if (i > 0) {
        // 指数退避重试
        const backoff = Math.pow(2, i - 1) * 500;
        if (this.debugLog) {
          console.log(`[xdpan] 重试第${i}次，等待${backoff}ms`);
        }
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

    throw new Error(`重试 ${MaxRetries} 次后仍然失败: ${lastError?.message}`);
  }

  protected async searchImpl(client: AxiosInstance, keyword: string): Promise<SearchResult[]> {
    if (this.debugLog) {
      console.log(`[xdpan] 开始搜索: keyword=${keyword}`);
    }

    try {
      // Step 1: 获取搜索结果页面
      const searchResults = await this.fetchSearchResults(client, keyword);
      if (this.debugLog) {
        console.log(`[xdpan] 获取搜索结果成功: 结果数=${searchResults.length}`);
      }

      // Step 2: 并发获取详情页信息（获取真实的百度网盘链接）
      await this.enrichWithDetailInfo(client, searchResults);

      // Step 3: 关键词过滤
      const filteredResults = this.filterResultsByKeyword(searchResults, keyword);
      if (this.debugLog) {
        console.log(`[xdpan] 关键词过滤后: 过滤前=${searchResults.length}, 过滤后=${filteredResults.length}`);
      }

      return filteredResults;
    } catch (error) {
      if (this.debugLog) {
        console.log(`[xdpan] 获取搜索结果失败: ${error}`);
      }
      throw new Error(`[${this.Name()}] 获取搜索结果失败: ${error}`);
    }
  }

  private async fetchSearchResults(client: AxiosInstance, keyword: string): Promise<SearchResult[]> {
    // 构建搜索URL（只获取第一页）
    const searchURL = `${BaseURL}/search?page=1&k=${encodeURIComponent(keyword)}`;

    // 创建请求配置
    const config: AxiosRequestConfig = {
      url: searchURL,
      method: 'GET',
      headers: this.getRequestHeaders(),
      timeout: 30000
    };

    if (this.debugLog) {
      console.log(`[xdpan] 搜索URL: ${searchURL}`);
    }

    try {
      // 发送请求（带重试机制）
      const resp = await this.doRequestWithRetry(client, config);

      // 解析HTML
      const $ = cheerio.load(resp.data);

      return this.extractSearchResults($);
    } catch (error) {
      throw new Error(`获取搜索结果失败: ${error}`);
    }
  }

  private extractSearchResults($: cheerio.CheerioAPI): SearchResult[] {
    const results: SearchResult[] = [];

    // 查找所有包含详情页链接的van-row元素
    $('van-row').each((i, s) => {
      // 检查是否包含详情页链接
      const detailLink = $(s).find("a[href^='/s/']");
      if (detailLink.length === 0) {
        return;
      }

      const result = this.parseSearchResult($(s));
      if (result.Title) {
        results.push(result);
        if (this.debugLog) {
          console.log(`[xdpan] 解析结果[${i}]: title=${result.Title}, detailUrl=${result.Content}`);
        }
      }
    });

    if (this.debugLog) {
      console.log(`[xdpan] 提取到有效结果数: ${results.length}`);
    }

    return results;
  }

  private parseSearchResult(s: cheerio.Cheerio): SearchResult {
    // 提取详情页链接
    const detailLink = s.find("a[href^='/s/']");
    const detailPath = detailLink.attr('href');
    let detailURL = '';
    if (detailPath) {
      detailURL = BaseURL + detailPath;
    }

    // 提取资源ID
    let resourceID = '';
    if (detailPath) {
      const parts = detailPath.split('/');
      if (parts.length >= 3) {
        resourceID = parts[2];
      }
    }

    // 提取标题（从content-title div中的所有span标签）
    const titleParts: string[] = [];
    s.find("div[name='content-title'] span").each((i, span) => {
      const text = $(span).text().trim();
      if (text) {
        titleParts.push(text);
      }
    });
    let title = titleParts.join('');

    // 如果没有找到span标签，尝试直接获取content-title的文本
    if (!title) {
      title = s.find("div[name='content-title']").text().trim();
    }

    // 提取时间和格式信息
    let shareTime = '';
    let fileType = '';
    let bottomText = s.find('template').text();
    if (!bottomText) {
      // 如果template不能直接获取文本，尝试其他方式
      s.find('div').each((i, sel) => {
        const text = $(sel).text();
        if (text.includes('时间:')) {
          bottomText = text;
        }
      });
    }

    // 使用正则表达式提取时间和格式
    const timeMatch = /时间:\s*(\d{4}-\d{1,2}-\d{1,2})/.exec(bottomText);
    if (timeMatch && timeMatch[1]) {
      shareTime = timeMatch[1];
    }

    const formatMatch = /格式:\s*<b>([^<]+)<\/b>/.exec(bottomText);
    if (formatMatch && formatMatch[1]) {
      fileType = formatMatch[1];
    }

    // 解析时间
    const parsedTime = this.parseTime(shareTime);

    // 构建内容描述
    const content = `类型: ${fileType} | 分享时间: ${shareTime} | 详情: ${detailURL}`;

    // 如果没有找到资源ID，使用时间戳
    if (!resourceID) {
      resourceID = Date.now().toString();
    }

    return {
      Title: title,
      Content: content,
      Channel: '',
      MessageID: `${this.Name()}-${resourceID}`,
      UniqueID: `${this.Name()}-${resourceID}`,
      Datetime: parsedTime,
      Links: [], // 初始为空，后续从详情页获取
      Tags: []
    };
  }

  private async enrichWithDetailInfo(client: AxiosInstance, results: SearchResult[]): Promise<void> {
    if (results.length === 0) {
      return;
    }

    const semaphore = new Semaphore(MaxConcurrency);
    const promises = results.map(async (result, index) => {
      await semaphore.acquire();
      try {
        // 添加延时避免请求过快
        await new Promise(resolve => setTimeout(resolve, (index % 3) * 200));

        // 从Content中提取详情页URL
        const detailURL = this.extractDetailURLFromContent(result.Content);
        if (detailURL) {
          const links = await this.fetchDetailPageLinks(client, detailURL);
          if (links.length > 0) {
            result.Links = links;
            if (this.debugLog) {
              console.log(`[xdpan] 获取详情页链接成功: ${detailURL}, 链接数: ${links.length}`);
            }
          }
        }
      } finally {
        semaphore.release();
      }
    });

    await Promise.all(promises);
  }

  private async fetchDetailPageLinks(client: AxiosInstance, detailURL: string): Promise<Link[]> {
    if (!detailURL) {
      return [];
    }

    // 检查缓存
    const cached = this.detailCache.get(detailURL);
    if (cached) {
      if (Date.now() - cached.timestamp < this.cacheTTL) {
        return cached.links;
      }
      // 缓存过期，删除
      this.detailCache.delete(detailURL);
    }

    // 创建请求配置
    const config: AxiosRequestConfig = {
      url: detailURL,
      method: 'GET',
      headers: this.getRequestHeaders(),
      timeout: 30000
    };

    try {
      // 发送请求
      const resp = await client(config);

      if (resp.status !== 200) {
        return [];
      }

      // 解析HTML
      const $ = cheerio.load(resp.data);

      const links = this.extractDetailPageLinks($);

      // 缓存结果
      this.detailCache.set(detailURL, {
        links,
        timestamp: Date.now()
      });

      return links;
    } catch (error) {
      return [];
    }
  }

  private extractDetailPageLinks($: cheerio.CheerioAPI): Link[] {
    const links: Link[] = [];

    // 提取密码
    let password = '';
    $('van-cell').each((i, s) => {
      const title = $(s).attr('title');
      if (title === '密码') {
        password = $(s).find('b').text().trim();
      }
    });

    // 从JavaScript代码中提取百度网盘链接
    $('script').each((i, s) => {
      const scriptContent = $(s).text();
      
      // 查找onDownload函数中的window.open链接
      const re = /window\.open\("([^"]*pan\.baidu\.com[^"]*)"/;
      const matches = re.exec(scriptContent);
      
      if (matches && matches[1]) {
        let baiduURL = matches[1];
        
        // 如果链接中没有密码参数，但我们从页面中提取到了密码，则添加密码参数
        if (!baiduURL.includes('pwd=') && password) {
          const separator = baiduURL.includes('?') ? '&' : '?';
          baiduURL = `${baiduURL}${separator}pwd=${password}`;
        }
        
        links.push({
          URL: baiduURL,
          Type: 'baidu',
          Password: password
        });
        
        if (this.debugLog) {
          console.log(`[xdpan] 提取到百度网盘链接: ${baiduURL}, 密码: ${password}`);
        }
      }
    });

    return links;
  }

  private extractDetailURLFromContent(content: string): string {
    // 查找详情URL模式
    const re = /详情:\s*(https?:\/\/[^\s]+)/;
    const matches = re.exec(content);
    if (matches && matches[1]) {
      return matches[1];
    }
    return '';
  }

  private parseTime(timeStr: string): Date {
    timeStr = timeStr.trim();
    if (!timeStr) {
      return new Date();
    }

    const formats = [
      'YYYY-M-D',
      'YYYY-MM-DD',
      'YYYY-M-D HH:mm',
      'YYYY-MM-DD HH:mm',
      'YYYY-M-D HH:mm:ss',
      'YYYY-MM-DD HH:mm:ss'
    ];

    for (const format of formats) {
      try {
        if (format === 'YYYY-M-D') {
          const parts = timeStr.split('-');
          if (parts.length === 3) {
            const year = parseInt(parts[0]);
            const month = parseInt(parts[1]) - 1;
            const day = parseInt(parts[2]);
            if (!isNaN(year) && !isNaN(month) && !isNaN(day)) {
              return new Date(year, month, day);
            }
          }
        } else if (format === 'YYYY-MM-DD') {
          const parts = timeStr.split('-');
          if (parts.length === 3) {
            const year = parseInt(parts[0]);
            const month = parseInt(parts[1]) - 1;
            const day = parseInt(parts[2]);
            if (!isNaN(year) && !isNaN(month) && !isNaN(day)) {
              return new Date(year, month, day);
            }
          }
        } else if (format === 'YYYY-M-D HH:mm') {
          const [datePart, timePart] = timeStr.split(' ');
          const dateParts = datePart.split('-');
          const timeParts = timePart.split(':');
          if (dateParts.length === 3 && timeParts.length === 2) {
            const year = parseInt(dateParts[0]);
            const month = parseInt(dateParts[1]) - 1;
            const day = parseInt(dateParts[2]);
            const hour = parseInt(timeParts[0]);
            const minute = parseInt(timeParts[1]);
            if (!isNaN(year) && !isNaN(month) && !isNaN(day) && !isNaN(hour) && !isNaN(minute)) {
              return new Date(year, month, day, hour, minute);
            }
          }
        } else if (format === 'YYYY-MM-DD HH:mm') {
          const [datePart, timePart] = timeStr.split(' ');
          const dateParts = datePart.split('-');
          const timeParts = timePart.split(':');
          if (dateParts.length === 3 && timeParts.length === 2) {
            const year = parseInt(dateParts[0]);
            const month = parseInt(dateParts[1]) - 1;
            const day = parseInt(dateParts[2]);
            const hour = parseInt(timeParts[0]);
            const minute = parseInt(timeParts[1]);
            if (!isNaN(year) && !isNaN(month) && !isNaN(day) && !isNaN(hour) && !isNaN(minute)) {
              return new Date(year, month, day, hour, minute);
            }
          }
        } else if (format === 'YYYY-M-D HH:mm:ss') {
          const [datePart, timePart] = timeStr.split(' ');
          const dateParts = datePart.split('-');
          const timeParts = timePart.split(':');
          if (dateParts.length === 3 && timeParts.length === 3) {
            const year = parseInt(dateParts[0]);
            const month = parseInt(dateParts[1]) - 1;
            const day = parseInt(dateParts[2]);
            const hour = parseInt(timeParts[0]);
            const minute = parseInt(timeParts[1]);
            const second = parseInt(timeParts[2]);
            if (!isNaN(year) && !isNaN(month) && !isNaN(day) && !isNaN(hour) && !isNaN(minute) && !isNaN(second)) {
              return new Date(year, month, day, hour, minute, second);
            }
          }
        } else if (format === 'YYYY-MM-DD HH:mm:ss') {
          const [datePart, timePart] = timeStr.split(' ');
          const dateParts = datePart.split('-');
          const timeParts = timePart.split(':');
          if (dateParts.length === 3 && timeParts.length === 3) {
            const year = parseInt(dateParts[0]);
            const month = parseInt(dateParts[1]) - 1;
            const day = parseInt(dateParts[2]);
            const hour = parseInt(timeParts[0]);
            const minute = parseInt(timeParts[1]);
            const second = parseInt(timeParts[2]);
            if (!isNaN(year) && !isNaN(month) && !isNaN(day) && !isNaN(hour) && !isNaN(minute) && !isNaN(second)) {
              return new Date(year, month, day, hour, minute, second);
            }
          }
        }
      } catch (error) {
        // 解析失败，尝试下一种格式
      }
    }

    // 如果解析失败，返回当前时间
    return new Date();
  }

  private getRequestHeaders(): Record<string, string> {
    return {
      'User-Agent': UserAgent,
      'Referer': `${BaseURL}/`,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'Connection': 'keep-alive',
      'Cache-Control': 'max-age=0'
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
}

// 注册插件
const plugin = new XdpanPlugin();
plugin.register();
