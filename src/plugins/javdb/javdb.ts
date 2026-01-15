import { BaseAsyncPlugin, registerGlobalPlugin } from '../plugin.manager';
import { SearchResult, Link } from '../../models/response';
import axios, { AxiosInstance, AxiosResponse } from 'axios';
import * as cheerio from 'cheerio';
import crypto from 'crypto';
import { promisify } from 'util';

// 常量定义
const PluginName = "javdb";
const DisplayName = "JavDB";
const Description = "JavDB - 影片数据库，专门提供磁力链接搜索";
const BaseURL = "https://javdb.com";
const SearchPath = "/search?q=%s&f=all";
const UserAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36";
const MaxResults = 50;
const MaxConcurrency = 10;

// 429限流重试配置
const MaxRetryOnRateLimit = 0;    // 遇到429时的最大重试次数，设为0则不重试
const MinRetryDelay = 4;          // 最小延迟秒数
const MaxRetryDelay = 8;          // 最大延迟秒数

// 预编译的正则表达式
const whitespaceRegex = /\s+/g;
const detailURLRegex = /详情页URL: (.+)/;
const magnetRegex = /magnet:/g;

// 缓存项接口
interface CacheItem {
  links: Link[];
  timestamp: number;
}

// JavdbPlugin JavDB插件
class JavdbPlugin extends BaseAsyncPlugin {
  private debugMode: boolean;
  private detailCache: Map<string, CacheItem>;
  private cacheTTL: number;
  private rateLimited: boolean;
  private rateLimitCount: number;
  private optimizedClient: AxiosInstance;

  constructor() {
    super(PluginName, 5, true); // 高质量插件，优先级5，启用过滤
    this.debugMode = false;
    this.detailCache = new Map();
    this.cacheTTL = 30 * 60 * 1000; // 详情页缓存30分钟
    this.rateLimited = false;
    this.rateLimitCount = 0;
    this.optimizedClient = this.createOptimizedHTTPClient();
  }

  // 创建优化的HTTP客户端
  private createOptimizedHTTPClient(): AxiosInstance {
    return axios.create({
      timeout: 30000, // 30秒超时
      headers: {
        'User-Agent': UserAgent,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
        'Cache-Control': 'max-age=0',
        'Referer': `${BaseURL}/`,
      },
    });
  }

  // 插件名称
  name(): string {
    return PluginName;
  }

  // 插件显示名称
  displayName(): string {
    return DisplayName;
  }

  // 插件描述
  description(): string {
    return Description;
  }

  // 搜索实现
  private async searchImpl(client: AxiosInstance, keyword: string, ext: Record<string, any>): Promise<SearchResult[]> {
    if (this.debugMode) {
      console.log(`[JAVDB] 开始搜索: ${keyword}`);
    }

    // 第一步：执行搜索获取结果列表
    const { searchResults, isRateLimited } = await this.executeSearchWithRateLimit(keyword);
    if (searchResults.length === 0) {
      if (this.debugMode) {
        console.log(`[JAVDB] 无搜索结果，直接返回`);
      }
      return [];
    }

    if (this.debugMode) {
      if (isRateLimited) {
        console.log(`[JAVDB] ⚡ 遇到429限流，但继续处理已获取的 ${searchResults.length} 个结果`);
      } else {
        console.log(`[JAVDB] 搜索获取到 ${searchResults.length} 个结果`);
      }
    }

    // 第二步：并发获取详情页磁力链接
    const finalResults = await this.fetchDetailMagnetLinks(searchResults, keyword);

    if (this.debugMode) {
      console.log(`[JAVDB] 最终获取到 ${finalResults.length} 个有效结果`);
      if (isRateLimited) {
        console.log(`[JAVDB] ⚡ 由于429限流，结果可能不完整，系统将在后台继续获取`);
      }
    }

    return finalResults;
  }

  // 执行搜索请求，支持限流检测
  private async executeSearchWithRateLimit(keyword: string): Promise<{ searchResults: SearchResult[]; isRateLimited: boolean }> {
    // 重置限流状态，每次新搜索都重新尝试
    this.rateLimited = false;
    
    // 构建搜索URL
    const searchURL = `${BaseURL}${SearchPath.replace('%s', encodeURIComponent(keyword))}`;
    
    if (this.debugMode) {
      console.log(`[JAVDB] 搜索URL: ${searchURL}`);
      // 显示重试配置信息
      if (MaxRetryOnRateLimit > 0) {
        console.log(`[JAVDB] 429重试配置: 最大${MaxRetryOnRateLimit}次，延迟${MinRetryDelay}-${MaxRetryDelay}秒`);
      } else {
        console.log(`[JAVDB] 429重试配置: 禁用重试`);
      }
      // 如果之前有限流，显示统计信息
      if (this.rateLimitCount > 0) {
        console.log(`[JAVDB] 历史429限流次数: ${this.rateLimitCount}`);
      }
    }

    try {
      // 发送搜索请求
      const response = await this.optimizedClient.get(searchURL, {
        timeout: 30000, // 30秒超时
      });

      if (this.debugMode) {
        console.log(`[JAVDB] 搜索请求响应状态: ${response.status}`);
      }

      // 检测429限流
      if (response.status === 429) {
        this.rateLimited = true;
        this.rateLimitCount++;
        if (this.debugMode) {
          console.log(`[JAVDB] ⚡ 检测到429限流，立即返回空结果`);
        }
        return { searchResults: [], isRateLimited: true };
      }

      if (response.status !== 200) {
        throw new Error(`搜索请求HTTP状态错误: ${response.status}`);
      }

      // 解析搜索结果
      return { 
        searchResults: this.parseSearchResults(response.data), 
        isRateLimited: false 
      };
    } catch (error) {
      if (error instanceof Error && (error as any).response?.status === 429) {
        this.rateLimited = true;
        this.rateLimitCount++;
        if (this.debugMode) {
          console.log(`[JAVDB] ⚡ 检测到429限流，立即返回空结果`);
        }
        return { searchResults: [], isRateLimited: true };
      }
      throw new Error(`[${this.name()}] 执行搜索失败: ${error}`);
    }
  }

  // 带重试机制的HTTP请求
  private async doRequestWithRetry(url: string, method: string = 'GET', config: any = {}): Promise<AxiosResponse> {
    const maxRetries = 3;
    let lastErr: Error | null = null;

    for (let i = 0; i < maxRetries; i++) {
      if (i > 0) {
        // 指数退避重试
        const backoff = 200 * Math.pow(2, i - 1);
        await new Promise(resolve => setTimeout(resolve, backoff));
      }

      try {
        const response = await this.optimizedClient.request({
          url,
          method,
          ...config,
        });
        
        if (response.status === 200) {
          return response;
        }
        lastErr = new Error(`HTTP status: ${response.status}`);
      } catch (error) {
        lastErr = error as Error;
      }
    }

    throw new Error(`[${this.name()}] 重试 ${maxRetries} 次后仍然失败: ${lastErr?.message || '未知错误'}`);
  }

  // 带429重试机制的HTTP请求
  private async doRequestWithRateLimitRetry(url: string, method: string = 'GET', config: any = {}): Promise<AxiosResponse> {
    let lastErr: Error | null = null;

    for (let attempt = 0; attempt <= MaxRetryOnRateLimit; attempt++) {
      if (attempt > 0) {
        // 随机延迟，避免同时重试造成更大压力
        const delaySeconds = Math.floor(Math.random() * (MaxRetryDelay - MinRetryDelay + 1)) + MinRetryDelay;
        if (this.debugMode) {
          console.log(`[JAVDB] 429重试 ${attempt}/${MaxRetryOnRateLimit}，随机延迟 ${delaySeconds} 秒`);
        }
        await new Promise(resolve => setTimeout(resolve, delaySeconds * 1000));
      }

      try {
        const response = await this.optimizedClient.request({
          url,
          method,
          ...config,
        });

        // 如果不是429，直接返回（无论成功还是其他错误）
        if (response.status !== 429) {
          return response;
        }

        // 遇到429
        this.rateLimitCount++;
        if (this.debugMode) {
          console.log(`[JAVDB] 遇到429限流，尝试 ${attempt + 1}/${MaxRetryOnRateLimit + 1}`);
        }

        // 如果不允许重试或已达到最大重试次数
        if (MaxRetryOnRateLimit === 0 || attempt >= MaxRetryOnRateLimit) {
          this.rateLimited = true;
          throw new Error(`[${this.name()}] 429限流，${MaxRetryOnRateLimit === 0 ? '不重试' : `重试${MaxRetryOnRateLimit}次后仍然限流`}`);
        }

      } catch (error) {
        lastErr = error as Error;
      }
    }

    throw lastErr || new Error('未知错误');
  }

  // 解析搜索结果
  private parseSearchResults(htmlContent: string): SearchResult[] {
    const results: SearchResult[] = [];

    try {
      const $ = cheerio.load(htmlContent);
      
      // 提取搜索结果
      $('.movie-list .item').each((i, s) => {
        if (results.length >= MaxResults) {
          return false; // 跳出循环
        }

        if (this.debugMode) {
          console.log(`[JAVDB] 开始解析第 ${i + 1} 个结果项`);
        }

        const result = this.parseResultItem($(s), i + 1);
        if (result) {
          results.push(result);
          if (this.debugMode) {
            console.log(`[JAVDB] 成功解析第 ${i + 1} 个结果项: ${result.title}`);
          }
        } else if (this.debugMode) {
          console.log(`[JAVDB] 第 ${i + 1} 个结果项解析失败`);
        }
      });

    } catch (error) {
      console.error(`[${this.name()}] HTML解析失败: ${error}`);
      return [];
    }

    if (this.debugMode) {
      console.log(`[JAVDB] 解析到 ${results.length} 个原始结果`);
    }

    return results;
  }

  // 解析单个搜索结果项
  private parseResultItem(s: cheerio.Cheerio, index: number): SearchResult | null {
    if (this.debugMode) {
      // 输出当前结果项的HTML结构用于调试
      const itemHTML = s.html() || '';
      if (itemHTML.length > 300) {
        console.log(`[JAVDB] 结果项 ${index} HTML前300字符: ${itemHTML.substring(0, 300)}`);
      } else {
        console.log(`[JAVDB] 结果项 ${index} 完整HTML: ${itemHTML}`);
      }
    }

    // 提取详情页链接
    const linkEl = s.find('a.box');
    if (this.debugMode) {
      console.log(`[JAVDB] 结果项 ${index} 找到a.box元素数量: ${linkEl.length}`);
    }

    if (linkEl.length === 0) {
      if (this.debugMode) {
        console.log(`[JAVDB] 跳过无链接的结果`);
      }
      return null;
    }

    const detailPath = linkEl.attr('href');
    const title = linkEl.attr('title') || '';

    if (this.debugMode) {
      console.log(`[JAVDB] 结果项 ${index} 详情页URL: ${detailPath}`);
      console.log(`[JAVDB] 结果项 ${index} 标题: ${title}`);
    }

    if (!detailPath || title === '') {
      if (this.debugMode) {
        console.log(`[JAVDB] 跳过无效链接或标题的结果`);
      }
      return null;
    }

    // 处理相对路径
    const detailURL = detailPath.startsWith('/') ? `${BaseURL}${detailPath}` : detailPath;

    // 提取番号和标题
    const [videoNumber] = this.extractVideoInfo(s);

    // 提取评分
    const rating = this.extractRating(s);

    // 提取发布日期
    const releaseDate = this.extractReleaseDate(s);

    // 提取标签
    const tags = this.extractTags(s);

    // 构建内容
    const contentParts: string[] = [];
    if (videoNumber) {
      contentParts.push(`番號：${videoNumber}`);
    }
    if (rating) {
      contentParts.push(`評分：${rating}`);
    }
    if (releaseDate) {
      contentParts.push(`發布日期：${releaseDate}`);
    }
    if (tags.length > 0) {
      contentParts.push(`標籤：${tags.join(' ')}`);
    }

    const content = contentParts.join('\n');

    // 解析时间
    const datetime = this.parseTime(releaseDate).toISOString();

    // 构建唯一ID
    const uniqueID = `${this.name()}-${index}`;

    // 构建初始结果对象（磁力链接稍后获取）
    const result: SearchResult = {
      uniqueId: uniqueID,
      messageId: `${this.name()}-${index}-${Date.now()}`,
      title: this.cleanTitle(title),
      content: `${content}\n详情页URL: ${detailURL}`,
      links: [],
      tags,
      channel: "",
      datetime,
    };

    if (this.debugMode) {
      console.log(`[JAVDB] 解析结果: ${title} (${videoNumber})`);
    }

    return result;
  }

  // 提取番号和标题信息
  private extractVideoInfo(s: cheerio.Cheerio): [string, string] {
    const videoTitleEl = s.find('.video-title');
    if (videoTitleEl.length === 0) {
      return ['', ''];
    }

    const fullTitle = videoTitleEl.text().trim();
    const strongEl = videoTitleEl.find('strong');
    
    if (strongEl.length > 0) {
      const videoNumber = strongEl.text().trim();
      const videoTitle = fullTitle.replace(videoNumber, '').trim();
      return [videoNumber, videoTitle];
    }

    return ['', fullTitle];
  }

  // 提取评分
  private extractRating(s: cheerio.Cheerio): string {
    const ratingEl = s.find('.score .value');
    if (ratingEl.length > 0) {
      let rating = ratingEl.text().trim();
      // 清理评分文本，只保留主要信息
      rating = rating.replace(/\n/g, ' ');
      rating = rating.replace(whitespaceRegex, ' ');
      return rating;
    }
    return '';
  }

  // 提取发布日期
  private extractReleaseDate(s: cheerio.Cheerio): string {
    const metaEl = s.find('.meta');
    if (metaEl.length > 0) {
      return metaEl.text().trim();
    }
    return '';
  }

  // 提取标签
  private extractTags(s: cheerio.Cheerio): string[] {
    const tags: string[] = [];
    s.find('.tags .tag').each((i, tagEl) => {
      const tag = $(tagEl).text().trim();
      if (tag) {
        tags.push(tag);
      }
    });
    return tags;
  }

  // 清理标题
  private cleanTitle(title: string): string {
    title = title.trim();
    // 移除多余的空格
    title = title.replace(whitespaceRegex, ' ');
    return title;
  }

  // 解析时间字符串
  private parseTime(dateStr: string): Date {
    if (!dateStr) {
      return new Date();
    }

    // 常见的日期格式
    const layouts = [
      '2006-01-02',
      '2006/01/02',
      '01-02-2006',
      '01/02/2006',
    ];

    for (const layout of layouts) {
      try {
        // 尝试解析日期
        const date = new Date(dateStr);
        if (!isNaN(date.getTime())) {
          return date;
        }
      } catch (error) {
        continue;
      }
    }

    return new Date();
  }

  // 并发获取详情页磁力链接
  private async fetchDetailMagnetLinks(searchResults: SearchResult[], keyword: string): Promise<SearchResult[]> {
    if (searchResults.length === 0) {
      if (this.debugMode) {
        console.log(`[JAVDB] 无搜索结果需要获取详情页`);
      }
      return [];
    }

    if (this.debugMode) {
      console.log(`[JAVDB] 开始获取 ${searchResults.length} 个搜索结果的详情页磁力链接`);
    }

    // 使用信号量控制并发数
    const semaphore = this.createSemaphore(MaxConcurrency);
    const results: SearchResult[] = [];

    // 根据客户端超时调整策略
    const useTimeout = false; // TypeScript中没有直接获取客户端超时的方法

    // 创建并发任务
    const tasks = searchResults.map(async (result, index) => {
      // 检查是否已经被限流
      if (this.rateLimited) {
        if (this.debugMode) {
          console.log(`[JAVDB] 检测到限流状态，停止处理新的详情页请求`);
        }
        return;
      }

      await semaphore.acquire();
      try {
        // 再次检查限流状态
        if (this.rateLimited) {
          if (this.debugMode) {
            console.log(`[JAVDB] 检测到限流状态，跳过详情页请求: ${result.title}`);
          }
          return;
        }

        if (this.debugMode) {
          console.log(`[JAVDB] 开始处理第 ${index + 1} 个搜索结果: ${result.title}`);
        }

        // 从Content中提取详情页URL
        const detailURL = this.extractDetailURLFromContent(result.content);
        if (!detailURL) {
          if (this.debugMode) {
            console.log(`[JAVDB] 跳过无详情页URL的结果: ${result.title}`);
            console.log(`[JAVDB] Content内容: ${result.content}`);
          }
          return;
        }

        if (this.debugMode) {
          console.log(`[JAVDB] 第 ${index + 1} 个结果详情页URL: ${detailURL}`);
        }

        // 获取详情页磁力链接
        const magnetLinks = await this.fetchDetailPageMagnetLinks(detailURL);
        if (this.debugMode) {
          console.log(`[JAVDB] 第 ${index + 1} 个结果获取到 ${magnetLinks.length} 个磁力链接`);
        }

        if (magnetLinks.length > 0) {
          // 为每个磁力链接创建一个SearchResult
          for (const link of magnetLinks) {
            // 复制基础结果
            const newResult: SearchResult = {
              ...result,
              // 清理Content中的详情页URL
              content: this.cleanContent(result.content),
              // 设置磁力链接
              links: [link],
              // 更新唯一ID - 基于磁力链接URL哈希确保一致性
              uniqueId: `${result.uniqueId}-magnet-${this.generateHash(link.url)}`,
              messageId: `${result.uniqueId}-magnet-${this.generateHash(link.url)}`,
            };
            results.push(newResult);
          }

          if (this.debugMode) {
            console.log(`[JAVDB] 第 ${index + 1} 个结果成功创建 ${magnetLinks.length} 个最终结果`);
          }
        } else if (this.debugMode) {
          console.log(`[JAVDB] 详情页无磁力链接: ${result.title}`);
        }
      } finally {
        semaphore.release();
      }
    });

    // 执行所有任务
    await Promise.all(tasks);

    if (this.debugMode) {
      console.log(`[JAVDB] 最终收集到 ${results.length} 个结果`);
      // 如果遇到了限流，提示用户
      if (this.rateLimited) {
        console.log(`[JAVDB] 本次搜索遇到429限流，结果可能不完整`);
      }
    }

    return results;
  }

  // 创建信号量
  private createSemaphore(maxConcurrency: number) {
    let available = maxConcurrency;
    const waiting: (() => void)[] = [];

    return {
      acquire: async (): Promise<void> => {
        return new Promise((resolve) => {
          if (available > 0) {
            available--;
            resolve();
          } else {
            waiting.push(resolve);
          }
        });
      },
      release: (): void => {
        available++;
        if (waiting.length > 0) {
          const resolve = waiting.shift()!;
          available--;
          resolve();
        }
      },
    };
  }

  // 生成MD5哈希值
  private generateHash(input: string): string {
    const hash = crypto.createHash('md5');
    hash.update(input);
    return hash.digest('hex').substring(0, 8);
  }

  // 从Content中提取详情页URL
  private extractDetailURLFromContent(content: string): string {
    const match = content.match(detailURLRegex);
    if (match && match.length > 1) {
      return match[1].trim();
    }
    return '';
  }

  // 清理Content，移除详情页URL行
  private cleanContent(content: string): string {
    return content.split('\n')
      .filter(line => !line.startsWith('详情页URL: '))
      .join('\n');
  }

  // 获取详情页的磁力链接
  private async fetchDetailPageMagnetLinks(detailURL: string): Promise<Link[]> {
    if (this.debugMode) {
      console.log(`[JAVDB] 开始获取详情页磁力链接: ${detailURL}`);
    }

    // 检查缓存
    const cached = this.detailCache.get(detailURL);
    const now = Date.now();
    if (cached && (now - cached.timestamp < this.cacheTTL)) {
      if (this.debugMode) {
        console.log(`[JAVDB] 使用缓存的详情页链接: ${detailURL}`);
      }
      return cached.links;
    }

    try {
      const response = await this.doRequestWithRateLimitRetry(detailURL, 'GET', {
        timeout: 30000, // 30秒超时
      });

      if (response.status !== 200) {
        if (this.debugMode) {
          console.log(`[JAVDB] 详情页HTTP状态错误: ${response.status}`);
        }
        return [];
      }

      // 解析磁力链接
      const links = this.parseMagnetLinks(response.data);

      // 缓存结果
      if (links.length > 0) {
        this.detailCache.set(detailURL, { links, timestamp: now });
      }

      if (this.debugMode) {
        console.log(`[JAVDB] 从详情页提取到 ${links.length} 个磁力链接: ${detailURL}`);
      }

      return links;
    } catch (error) {
      if (this.debugMode) {
        console.log(`[JAVDB] 详情页请求失败: ${error}`);
      }
      return [];
    }
  }

  // 解析磁力链接
  private parseMagnetLinks(htmlContent: string): Link[] {
    const links: Link[] = [];

    if (this.debugMode) {
      console.log(`[JAVDB] 开始解析磁力链接`);
      // 检查页面是否包含磁力链接相关内容
      if (htmlContent.includes('magnet:')) {
        const magnetCount = (htmlContent.match(magnetRegex) || []).length;
        console.log(`[JAVDB] 详情页包含 ${magnetCount} 个magnet字符串`);
      } else {
        console.log(`[JAVDB] 详情页不包含magnet字符串`);
      }
    }

    try {
      const $ = cheerio.load(htmlContent);
      
      // 查找磁力链接区域
      $('.magnet-links .item').each((i, s) => {
        if (this.debugMode) {
          console.log(`[JAVDB] 开始解析第 ${i + 1} 个磁力链接项`);
        }

        // 提取磁力链接URL
        const magnetEl = $(s).find('.magnet-name a');
        if (this.debugMode) {
          console.log(`[JAVDB] 第 ${i + 1} 个项找到.magnet-name a元素数量: ${magnetEl.length}`);
        }

        if (magnetEl.length === 0) {
          if (this.debugMode) {
            console.log(`[JAVDB] 第 ${i + 1} 个项无.magnet-name a元素，跳过`);
          }
          return;
        }

        const magnetURL = magnetEl.attr('href');
        if (!magnetURL) {
          if (this.debugMode) {
            console.log(`[JAVDB] 第 ${i + 1} 个项磁力链接URL为空，跳过`);
          }
          return;
        }

        // 验证是否为磁力链接
        if (!magnetURL.startsWith('magnet:')) {
          if (this.debugMode) {
            console.log(`[JAVDB] 第 ${i + 1} 个项不是磁力链接: ${magnetURL}，跳过`);
          }
          return;
        }

        if (this.debugMode) {
          console.log(`[JAVDB] 第 ${i + 1} 个项原始磁力URL: ${magnetURL}`);
        }

        // 解码HTML实体
        const decodedURL = magnetURL.replace(/&amp;/g, '&');

        if (this.debugMode) {
          console.log(`[JAVDB] 第 ${i + 1} 个项解码后磁力URL: ${decodedURL}`);
        }

        const link: Link = {
          type: 'magnet',
          url: decodedURL,
          password: '',
          text: '',
          workTitle: '',
        };

        links.push(link);

        if (this.debugMode) {
          // 提取资源名称用于调试日志
          const nameEl = $(s).find('.magnet-name .name');
          const resourceName = nameEl.text().trim();
          // 提取文件信息用于调试日志
          const metaEl = $(s).find('.magnet-name .meta');
          const fileInfo = metaEl.text().trim();
          console.log(`[JAVDB] 成功提取第 ${i + 1} 个磁力链接: ${resourceName} (${fileInfo})`);
        }
      });

    } catch (error) {
      console.error(`[${this.name()}] 解析磁力链接失败: ${error}`);
    }

    if (this.debugMode) {
      console.log(`[JAVDB] 磁力链接解析完成，共找到 ${links.length} 个链接`);
    }

    return links;
  }
}

// 创建并注册插件
const javdbPlugin = new JavdbPlugin();
registerGlobalPlugin(javdbPlugin);

export type { JavdbPlugin };
export const JavdbPluginInstance = javdbPlugin;