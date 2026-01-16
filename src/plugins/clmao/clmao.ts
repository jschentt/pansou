import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import { SearchResult, Link } from '../../types';
import { Plugin } from '../../types/plugin';
import * as cheerio from 'cheerio';

// 常量定义
const BaseURL = "https://www.8800492.xyz";
const SearchURL = BaseURL + "/search-%s-0-2-%d.html";
const MaxRetries = 3;
const TimeoutSeconds = 30;
const MaxConcurrency = 10;
const MaxPages = 5;

// 常用UA列表
const userAgents = [
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:89.0) Gecko/20100101 Firefox/89.0",
];

// 正则表达式
const magnetLinkRegex = /magnet:\?xt=urn:btih:[0-9a-fA-F]{40}[^"'\s]*/g;
const fileSizeRegex = /(\d+\.?\d*)\s*(B|KB|MB|GB|TB)/g;
const numberRegex = /\d+/g;
const adRegex = /【[^】]*】/g;
const bracketRegex = /\[[^\]]*\]/g;
const whitespaceRegex = /\s+/g;

const pluginName = 'clmao';
const defaultPriority = 3;

class ClmaoPlugin implements Plugin {
  private client: AxiosInstance;
  private retries: number;

  constructor() {
    this.client = axios.create({
      timeout: TimeoutSeconds * 1000,
      headers: {
        'User-Agent': userAgents[0]
      }
    });
    this.retries = MaxRetries;
  }

  name(): string {
    return pluginName;
  }

  displayName(): string {
    return '磁力猫';
  }

  description(): string {
    return '磁力猫 - 磁力链接搜索引擎';
  }

  async search(keyword: string, ext: Record<string, any>): Promise<SearchResult[]> {
    return this.searchImpl(keyword, ext);
  }

  private async searchImpl(keyword: string, ext: Record<string, any>): Promise<SearchResult[]> {
    const startTime = Date.now();

    try {
      // 1. 首先搜索第一页
      const firstPageResults = await this.searchPage(keyword, 1);

      // 存储所有结果
      let allResults: SearchResult[] = [...firstPageResults];

      // 2. 并发搜索其他页面（第2页到第5页）
      if (MaxPages > 1) {
        const pagePromises: Promise<SearchResult[]>[] = [];

        for (let page = 2; page <= MaxPages; page++) {
          const promise = async () => {
            // 添加小延迟避免过于频繁的请求
            const delay = (page % 3) * 100;
            if (delay > 0) {
              await this.sleep(delay);
            }

            try {
              return await this.searchPage(keyword, page);
            } catch (error) {
              console.error(`[clmao] 搜索页面 ${page} 失败:`, error);
              return [];
            }
          };

          pagePromises.push(promise());
        }

        // 限制并发数
        const semaphore = this.createSemaphore(MaxConcurrency);
        const limitedPromises = pagePromises.map(async (promise) => {
          await semaphore.acquire();
          try {
            return await promise;
          } finally {
            semaphore.release();
          }
        });

        // 等待所有请求完成
        const pageResults = await Promise.all(limitedPromises);

        // 按页码顺序合并所有页面的结果
        for (let page = 2; page <= MaxPages; page++) {
          const index = page - 2; // 因为 pagePromises 从第2页开始
          if (index < pageResults.length) {
            allResults = allResults.concat(pageResults[index]);
          }
        }
      }

      // 3. 关键词过滤
      let searchKeyword = keyword;
      if (ext && ext.search && typeof ext.search === 'string' && ext.search) {
        searchKeyword = ext.search;
      }
      const filteredResults = this.filterResultsByKeyword(allResults, searchKeyword);

      console.log(`[${this.name()}] 搜索结果: ${filteredResults.length} 条`);
      console.log(`[${this.name()}] 搜索耗时: ${Date.now() - startTime}ms`);

      return filteredResults;
    } catch (error) {
      console.error(`[${this.name()}] 搜索失败:`, error);
      return [];
    }
  }

  private async searchPage(keyword: string, page: number): Promise<SearchResult[]> {
    try {
      // URL编码关键词
      const encodedKeyword = encodeURIComponent(keyword);
      const searchURL = SearchURL.replace('%s', encodedKeyword).replace('%d', page.toString());

      // 发送请求（带重试机制）
      const config: AxiosRequestConfig = {
        method: 'GET',
        url: searchURL,
        headers: this.setRequestHeaders()
      };

      const resp = await this.doRequestWithRetry(config);

      // 解析HTML
      const $ = cheerio.load(resp.data);

      // 提取搜索结果
      return this.extractSearchResults($);
    } catch (error) {
      console.error(`[clmao] 搜索页面 ${page} 失败:`, error);
      return [];
    }
  }

  private setRequestHeaders(): Record<string, string> {
    // 使用第一个稳定的UA
    const ua = userAgents[0];
    return {
      'User-Agent': ua,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'Connection': 'keep-alive',
      'Upgrade-Insecure-Requests': '1',
      'Cache-Control': 'no-cache',
      'Pragma': 'no-cache'
    };
  }

  private async doRequestWithRetry(config: AxiosRequestConfig): Promise<any> {
    let lastErr: any;

    for (let i = 0; i < this.retries; i++) {
      try {
        const resp = await this.client(config);
        if (resp.status === 200) {
          return resp;
        }
      } catch (error) {
        lastErr = error;
      }

      if (i < this.retries - 1) {
        await this.sleep((i + 1) * 1000);
      }
    }

    if (lastErr) {
      throw new Error(`请求失败，已重试${this.retries}次: ${lastErr}`);
    }

    throw new Error(`请求失败，已重试${this.retries}次`);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private createSemaphore(maxConcurrency: number): { acquire: () => Promise<void>; release: () => void } {
    let count = 0;
    const queue: (() => void)[] = [];

    return {
      acquire: async () => {
        if (count < maxConcurrency) {
          count++;
        } else {
          await new Promise(resolve => queue.push(resolve));
        }
      },
      release: () => {
        count--;
        if (queue.length > 0) {
          queue.shift()?.();
        }
      }
    };
  }

  private extractSearchResults($: cheerio.Root): SearchResult[] {
    const results: SearchResult[] = [];

    // 查找所有搜索结果
    $('.tbox .ssbox').each((i, element) => {
      const s = $(element);
      const result = this.parseSearchResult(s);
      if (result.title && result.links.length > 0) {
        results.push(result);
      }
    });

    return results;
  }

  private parseSearchResult(s: cheerio.Cheerio): SearchResult {
    const result: SearchResult = {
      uniqueId: '',
      title: '',
      content: '',
      datetime: new Date(),
      channel: '',
      links: [],
      tags: [],
      images: [],
      pluginName: this.name(),
      displayName: this.displayName()
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
    result.uniqueId = `${this.name()}-${Date.now()}-${Math.floor(Math.random() * 10000)}`;

    return result;
  }

  private extractMagnetInfo(s: cheerio.Cheerio, result: SearchResult): void {
    const sbar = s.find('.sbar');

    // 提取磁力链接
    const magnetLink = sbar.find('a[href^="magnet:"]').attr('href');
    if (magnetLink) {
      const link: Link = {
        url: magnetLink,
        type: 'magnet',
        password: ''
      };
      result.links = [link];
    }

    // 提取元数据并添加到内容中
    const metadata: string[] = [];
    sbar.find('span').each((i, span) => {
      const text = $(span).text().trim();
      
      if (text.includes('添加时间:') || 
          text.includes('大小:') || 
          text.includes('热度:')) {
        metadata.push(text);
      }
    });

    if (metadata.length > 0) {
      if (result.content) {
        result.content += '\n\n' + metadata.join(' | ');
      } else {
        result.content = metadata.join(' | ');
      }
    }
  }

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
        result.content += '\n\n文件列表:\n' + files.join('\n');
      } else {
        result.content = '文件列表:\n' + files.join('\n');
      }
    }
  }

  private mapCategory(category: string): string {
    switch (category) {
      case '[影视]':
        return 'video';
      case '[音乐]':
        return 'music';
      case '[图像]':
        return 'image';
      case '[文档书籍]':
        return 'document';
      case '[压缩文件]':
        return 'archive';
      case '[安装包]':
        return 'software';
      case '[其他]':
        return 'others';
      default:
        return 'others';
    }
  }

  private cleanTitle(title: string): string {
    // 移除【】之间的广告内容
    title = title.replace(adRegex, '');
    // 移除[]之间的内容（如有需要）
    title = title.replace(bracketRegex, '');
    // 移除多余的空格
    title = title.replace(whitespaceRegex, ' ');
    return title.trim();
  }

  private filterResultsByKeyword(results: SearchResult[], keyword: string): SearchResult[] {
    if (!keyword) {
      return results;
    }

    const lowerKeyword = keyword.toLowerCase();
    const parts = lowerKeyword.split(/\s+/);

    return results.filter(result => {
      const target = `${result.title} ${result.content}`.toLowerCase();
      return parts.every(part => target.includes(part));
    });
  }
}

// 导出插件实例
const plugin = new ClmaoPlugin();
export default plugin;