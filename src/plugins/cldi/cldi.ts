import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import { SearchResult, Link } from '../../types';
import { Plugin } from '../../types/plugin';
import * as cheerio from 'cheerio';

// 常量定义
const MaxConcurrency = 10;
const MaxPages = 5;
const BaseURL = 'https://wvmzbxki.1122132.xyz';

// 常用UA列表
const userAgents = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/92.0.4515.107 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.1.2 Safari/605.1.15",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:90.0) Gecko/20100101 Firefox/90.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.114 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/92.0.4515.107 Safari/537.36"
];

// 正则表达式
const adRegex = /【[^】]*】/g;
const fileSizeRegex = /^(.+?)&nbsp;<span class="lightColor">([^<]+)<\/span>$/;
const numberRegex = /\d+/g;

const pluginName = 'cldi';
const defaultPriority = 3;

class CldiPlugin implements Plugin {
  private client: AxiosInstance;
  private retries: number;

  constructor() {
    this.client = axios.create({
      timeout: 30000,
      headers: {
        'User-Agent': this.getRandomUA()
      }
    });
    this.retries = 3;
  }

  name(): string {
    return pluginName;
  }

  displayName(): string {
    return 'cldi';
  }

  description(): string {
    return 'cldi - 磁力资源搜索';
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
              console.error(`[cldi] 搜索页面 ${page} 失败:`, error);
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

        // 合并结果
        for (const results of pageResults) {
          allResults = allResults.concat(results);
        }
      }

      // 3. 关键词过滤
      const filteredResults = this.filterResultsByKeyword(allResults, keyword);

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
      // 构建搜索URL (分类=0全部, 排序=2按添加时间)
      const searchURL = `${BaseURL}/search-${encodeURIComponent(keyword)}-0-2-${page}.html`;

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
      console.error(`[cldi] 搜索页面 ${page} 失败:`, error);
      return [];
    }
  }

  private setRequestHeaders(): Record<string, string> {
    return {
      'User-Agent': this.getRandomUA(),
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'Connection': 'keep-alive',
      'Cache-Control': 'no-cache',
      'Pragma': 'no-cache',
      'Referer': BaseURL + '/'
    };
  }

  private async doRequestWithRetry(config: AxiosRequestConfig): Promise<any> {
    let lastErr: any;

    for (let i = 0; i <= this.retries; i++) {
      if (i > 0) {
        // 指数退避重试
        const backoff = Math.pow(2, i - 1) * 200;
        await this.sleep(backoff);
      }

      try {
        const resp = await this.client(config);
        if (resp.status === 200) {
          return resp;
        }
      } catch (error) {
        lastErr = error;
      }
    }

    if (lastErr) {
      throw new Error(`重试 ${this.retries} 次后仍然失败: ${lastErr}`);
    }

    throw new Error(`重试 ${this.retries} 次后仍然失败`);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private getRandomUA(): string {
    const randomIndex = Math.floor(Math.random() * userAgents.length);
    return userAgents[randomIndex];
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

    // 提取标题和分类
    const titleSection = s.find('.title h3');

    // 提取分类
    const category = titleSection.find('span').first().text().trim();
    if (category) {
      result.tags = [this.mapCategory(category)];
    }

    // 提取标题
    const titleLink = titleSection.find('a');
    const title = titleLink.text().trim();
    result.title = this.cleanTitle(title);

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
      result.links.push({
        url: magnetLink,
        type: 'magnet',
        password: ''
      });
    }

    // 提取添加时间
    sbar.find('span').each((i, span) => {
      const text = $(span).text();
      if (text.includes('添加时间:')) {
        const timeStr = $(span).find('b').text().trim();
        if (timeStr) {
          try {
            result.datetime = new Date(timeStr);
          } catch (error) {
            // 时间解析失败，使用当前时间
          }
        }
      }
    });
  }

  private extractFileList(s: cheerio.Cheerio, result: SearchResult): void {
    const fileList: string[] = [];

    s.find('.slist ul li').each((i, li) => {
      // 获取原始HTML以解析文件名和大小
      const html = $(li).html() || '';

      // 使用正则表达式分离文件名和大小
      const matches = fileSizeRegex.exec(html);
      if (matches && matches.length === 3) {
        const fileName = matches[1].trim();
        const fileSize = matches[2].trim();
        if (fileName && fileSize) {
          fileList.push(`${fileName} (${fileSize})`);
        }
      } else {
        // 回退方案：直接使用文本内容
        const text = $(li).text().trim();
        if (text) {
          fileList.push(text);
        }
      }
    });

    if (fileList.length > 0) {
      result.content = fileList.join('\n');
    }
  }

  private mapCategory(category: string): string {
    // 移除方括号
    category = category.replace(/[\[\]]/g, '');

    switch (category) {
      case '影视':
        return '影视';
      case '音乐':
        return '音乐';
      case '图像':
        return '图像';
      case '文档书籍':
        return '文档';
      case '压缩文件':
        return '压缩包';
      case '安装包':
        return '软件';
      case '其他':
        return '其他';
      default:
        return '其他';
    }
  }

  private cleanTitle(title: string): string {
    // 移除【】内的广告内容
    let cleaned = title.replace(adRegex, '');

    // 清理多余的空格
    cleaned = cleaned.trim().replace(/\s+/g, ' ');

    return cleaned;
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
const plugin = new CldiPlugin();
export default plugin;