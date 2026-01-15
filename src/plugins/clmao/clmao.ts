import { BaseAsyncPlugin, registerGlobalPlugin } from '../plugin.manager';
import { SearchResult, Link } from '../../models/response';
import axios, { AxiosInstance, AxiosResponse } from 'axios';
import * as cheerio from 'cheerio';
import * as crypto from 'crypto';

// 常量定义
const BaseURL = "https://www.8800492.xyz";
const SearchURL = BaseURL + "/search-%s-0-2-%d.html";

// 默认参数
const MaxRetries = 3;
const TimeoutSeconds = 30;

// 并发控制参数
const MaxConcurrency = 10; // 最大并发数
const MaxPages = 5;        // 最大搜索页数

// 预编译的正则表达式
const magnetLinkRegex = /magnet:\?xt=urn:btih:[0-9a-fA-F]{40}[^"'\s]*/g;
const fileSizeRegex = /(\d+\.?\d*)\s*(B|KB|MB|GB|TB)/;
const numberRegex = /\d+/g;
const bracketsRegex = /【[^】]*】/g;
const squareBracketsRegex = /\[[^\]]*\]/g;
const whitespaceRegex = /\s+/g;

// 常用UA列表
const userAgents = [
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:89.0) Gecko/20100101 Firefox/89.0",
];

// ClmaoPlugin 磁力猫搜索插件
class ClmaoPlugin extends BaseAsyncPlugin {
  private optimizedClient: AxiosInstance;

  constructor() {
    super("clmao", 3, true); // 普通质量插件，优先级3，启用过滤
    this.optimizedClient = this.createOptimizedHTTPClient();
  }

  // 创建优化的HTTP客户端
  private createOptimizedHTTPClient(): AxiosInstance {
    return axios.create({
      timeout: TimeoutSeconds * 1000, // 设置超时
      headers: {
        'User-Agent': userAgents[0], // 使用第一个稳定的UA
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
      },
    });
  }

  // 插件名称
  name(): string {
    return "clmao";
  }

  // 插件显示名称
  displayName(): string {
    return "磁力猫";
  }

  // 插件描述
  description(): string {
    return "磁力猫 - 磁力链接搜索引擎";
  }

  // 搜索实现
  private async searchImpl(client: AxiosInstance, keyword: string, ext: Record<string, any>): Promise<SearchResult[]> {
    // 1. 首先搜索第一页
    const firstPageResults = await this.searchPage(keyword, 1);
    if (firstPageResults.length === 0) {
      return [];
    }
    
    // 存储所有结果
    let allResults: SearchResult[] = [...firstPageResults];
    
    // 2. 并发搜索其他页面（第2页到第5页）
    if (MaxPages > 1) {
      // 使用信号量控制并发数
      const semaphore = this.createSemaphore(MaxConcurrency);
      const tasks: Promise<SearchResult[]>[] = [];
      
      for (let page = 2; page <= MaxPages; page++) {
        tasks.push((async () => {
          await semaphore.acquire();
          try {
            // 添加小延迟避免过于频繁的请求
            await new Promise(resolve => setTimeout(resolve, (page % 3) * 100));
            return await this.searchPage(keyword, page);
          } catch (error) {
            return [];
          } finally {
            semaphore.release();
          }
        })());
      }
      
      // 执行所有任务
      const results = await Promise.all(tasks);
      
      // 合并所有结果
      results.forEach(pageResults => {
        allResults = [...allResults, ...pageResults];
      });
    }
    
    // 3. 关键词过滤
    const searchKeyword = ext?.["search"] && typeof ext["search"] === "string" ? ext["search"] : keyword;
    return this.filterResultsByKeyword(allResults, searchKeyword);
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

  // 搜索指定页面
  private async searchPage(keyword: string, page: number): Promise<SearchResult[]> {
    // URL编码关键词
    const encodedKeyword = encodeURIComponent(keyword);
    const searchURL = SearchURL.replace("%s", encodedKeyword).replace("%d", page.toString());
    
    try {
      const response = await this.doRequestWithRetry(searchURL);
      
      if (response.status !== 200) {
        throw new Error(`HTTP status: ${response.status}`);
      }
      
      // 解析HTML
      return this.extractSearchResults(response.data);
    } catch (error) {
      console.error(`[${this.name()}] 搜索页面失败: ${error}`);
      return [];
    }
  }

  // 带重试机制的HTTP请求
  private async doRequestWithRetry(url: string): Promise<AxiosResponse> {
    let lastErr: Error | null = null;
    
    for (let i = 0; i < MaxRetries; i++) {
      try {
        const response = await this.optimizedClient.get(url);
        return response;
      } catch (error) {
        lastErr = error as Error;
        if (i < MaxRetries - 1) {
          await new Promise(resolve => setTimeout(resolve, (i + 1) * 1000));
        }
      }
    }
    
    throw new Error(`请求失败，已重试${MaxRetries}次: ${lastErr?.message || '未知错误'}`);
  }

  // 提取搜索结果
  private extractSearchResults(htmlContent: string): SearchResult[] {
    const results: SearchResult[] = [];
    
    try {
      const $ = cheerio.load(htmlContent);
      
      // 查找所有搜索结果
      $('.tbox .ssbox').each((i, s) => {
        const result = this.parseSearchResult($(s));
        if (result.title && result.links.length > 0) {
          results.push(result);
        }
      });
      
    } catch (error) {
      console.error(`[${this.name()}] HTML解析失败: ${error}`);
    }
    
    return results;
  }

  // 解析单个搜索结果
  private parseSearchResult(s: cheerio.Cheerio): SearchResult {
    const result: SearchResult = {
      uniqueId: "",
      messageId: "",
      title: "",
      content: "",
      links: [],
      tags: [],
      channel: "",
      datetime: new Date().toISOString(),
    };
    
    // 提取标题
    const titleSection = s.find('.title h3');
    const titleLink = titleSection.find('a');
    const title = titleLink.text().trim();
    result.title = this.cleanTitle(title);
    
    // 提取分类作为标签
    const category = titleSection.find('span').text().trim();
    if (category) {
      result.tags = [this.mapCategory(category)];
    }
    
    // 提取磁力链接和元数据
    this.extractMagnetInfo(s, result);
    
    // 提取文件列表作为内容
    this.extractFileList(s, result);
    
    // 生成唯一ID
    const uniqueStr = `${result.title}-${result.links.map(l => l.url).join('-')}`;
    result.uniqueId = `${this.name()}-${this.generateHash(uniqueStr)}`;
    result.messageId = result.uniqueId;
    
    return result;
  }

  // 生成MD5哈希值
  private generateHash(input: string): string {
    const hash = crypto.createHash('md5');
    hash.update(input);
    return hash.digest('hex');
  }

  // 提取磁力链接和元数据
  private extractMagnetInfo(s: cheerio.Cheerio, result: SearchResult): void {
    const sbar = s.find('.sbar');
    
    // 提取磁力链接
    const magnetLink = sbar.find('a[href^="magnet:"]').attr('href');
    if (magnetLink) {
      const link: Link = {
        type: "magnet",
        url: magnetLink,
        password: "",
        text: "",
        workTitle: "",
      };
      result.links.push(link);
    }
    
    // 提取元数据并添加到内容中
    const metadata: string[] = [];
    sbar.find('span').each((i, span) => {
      const text = $(span).text().trim();
      if (text.includes('添加时间:') || text.includes('大小:') || text.includes('热度:')) {
        metadata.push(text);
      }
    });
    
    if (metadata.length > 0) {
      if (result.content) {
        result.content += '\n\n';
      }
      result.content += metadata.join(' | ');
    }
  }

  // 提取文件列表
  private extractFileList(s: cheerio.Cheerio, result: SearchResult): void {
    const files: string[] = [];
    
    s.find('.slist ul li').each((i, li) => {
      const text = $(li).text().trim();
      if (text) {
        files.push(text);
      }
    });
    
    if (files.length > 0) {
      if (result.content) {
        result.content += '\n\n文件列表:\n';
      } else {
        result.content = '文件列表:\n';
      }
      result.content += files.join('\n');
    }
  }

  // 映射分类
  private mapCategory(category: string): string {
    switch (category) {
      case "[影视]":
        return "video";
      case "[音乐]":
        return "music";
      case "[图像]":
        return "image";
      case "[文档书籍]":
        return "document";
      case "[压缩文件]":
        return "archive";
      case "[安装包]":
        return "software";
      case "[其他]":
        return "others";
      default:
        return "others";
    }
  }

  // 清理标题
  private cleanTitle(title: string): string {
    // 移除【】之间的广告内容
    title = title.replace(bracketsRegex, "");
    // 移除[]之间的内容（如有需要）
    title = title.replace(squareBracketsRegex, "");
    // 移除多余的空格
    title = title.replace(whitespaceRegex, " ");
    return title.trim();
  }

  // 根据关键词过滤结果
  private filterResultsByKeyword(results: SearchResult[], keyword: string): SearchResult[] {
    if (!keyword) {
      return results;
    }

    const lowerKeyword = keyword.toLowerCase();
    return results.filter(result => {
      return result.title.toLowerCase().includes(lowerKeyword) || 
             result.content.toLowerCase().includes(lowerKeyword) ||
             result.tags.some(tag => tag.toLowerCase().includes(lowerKeyword));
    });
  }
}

// 创建并注册插件
const clmaoPlugin = new ClmaoPlugin();
registerGlobalPlugin(clmaoPlugin);

export type { ClmaoPlugin };
export const ClmaoPluginInstance = clmaoPlugin;