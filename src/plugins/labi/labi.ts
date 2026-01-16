import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import cheerio from 'cheerio';
import { SearchResult, Link } from '../../types';
import { Plugin } from '../../types/plugin';

// 预编译的正则表达式
const detailIDRegex = /\/vod\/detail\/id\/(\d+)\.html/;
const quarkLinkRegex = /https?:\/\/pan\.quark\.cn\/s\/[0-9a-zA-Z]+/;
const yearRegex = /(\d{4})/;

// 缓存相关
interface DetailCacheEntry {
  result: SearchResult;
  timestamp: number;
}

const detailCache = new Map<string, DetailCacheEntry>();
let lastCleanupTime = Date.now();
const cacheTTL = 3600000; // 1小时，单位毫秒

// 常量定义
const DefaultTimeout = 8000; // 8秒
const DetailTimeout = 6000; // 6秒
const MaxConcurrency = 20;

// 性能统计
let searchRequests: number = 0;
let detailPageRequests: number = 0;
let cacheHits: number = 0;
let cacheMisses: number = 0;
let totalSearchTime: number = 0;
let totalDetailTime: number = 0;

class LabiPlugin implements Plugin {
  private client: AxiosInstance;

  constructor() {
    this.client = axios.create({
      timeout: DefaultTimeout,
      maxRedirects: 5,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      }
    });

    // 启动缓存清理定时器
    this.startCacheCleaner();
  }

  name(): string {
    return 'labi';
  }

  displayName(): string {
    return 'Labi';
  }

  description(): string {
    return 'Labi - 网盘资源搜索';
  }

  async search(keyword: string, ext: Record<string, any>): Promise<SearchResult[]> {
    return this.searchImpl(keyword, ext);
  }

  private async searchImpl(keyword: string, ext: Record<string, any>): Promise<SearchResult[]> {
    const startTime = Date.now();
    searchRequests++;

    // 1. 构建搜索URL
    const searchURL = `http://xiaocge.fun/index.php/vod/search/wd/${encodeURIComponent(keyword)}.html`;

    try {
      // 2. 发送请求（带重试机制）
      const config: AxiosRequestConfig = {
        method: 'GET',
        url: searchURL,
        headers: this.getSearchHeaders()
      };

      const resp = await this.doRequestWithRetry(config);

      // 3. 解析搜索结果页面
      const $ = cheerio.load(resp.data);

      // 4. 提取搜索结果
      const results: SearchResult[] = [];

      $('.module-search-item').each((i, s) => {
        const result = this.parseSearchItem($(s), keyword);
        if (result.uniqueId) {
          results.push(result);
        }
      });

      // 5. 异步获取详情页信息
      const enhancedResults = await this.enhanceWithDetails(results);

      // 6. 关键词过滤
      const filteredResults = this.filterResultsByKeyword(enhancedResults, keyword);

      totalSearchTime += Date.now() - startTime;
      return filteredResults;
    } catch (error) {
      console.error(`[${this.name()}] 搜索失败:`, error);
      return [];
    }
  }

  private parseSearchItem(s: cheerio.Cheerio, keyword: string): SearchResult {
    const result: SearchResult = {
      uniqueId: '',
      title: '',
      content: '',
      datetime: new Date(),
      links: [],
      channel: '',
      tags: [],
      images: [],
      pluginName: this.name(),
      displayName: this.displayName()
    };

    // 提取详情页链接和ID
    const detailLink = s.find('.module-item-pic a').first().attr('href');
    if (!detailLink) {
      return result;
    }

    // 提取ID
    const matches = detailIDRegex.exec(detailLink);
    if (!matches || matches.length < 2) {
      return result;
    }

    const itemID = matches[1];
    result.uniqueId = `${this.name()}-${itemID}`;

    // 提取标题
    const titleElement = s.find('.video-info-header h3 a');
    result.title = titleElement.text().trim();

    // 提取资源类型/质量
    const qualityElement = s.find('.video-serial');
    const quality = qualityElement.text().trim();

    // 提取分类信息
    const tags: string[] = [];
    s.find('.video-info-aux .tag-link a').each((i, tag) => {
      const tagText = $(tag).text().trim();
      if (tagText) {
        tags.push(tagText);
      }
    });
    result.tags = tags;

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
          if (actorName) {
            actors.push(actorName);
          }
        });
      }
    });

    // 提取剧情简介
    let plot = '';
    s.find('.video-info-items').filter((i, item) => {
      const title = $(item).find('.video-info-itemtitle').text().trim();
      return title.includes('剧情');
    }).each((i, item) => {
      plot = $(item).find('.video-info-item').text().trim();
    });

    // 提取封面图片
    const images: string[] = [];
    const picURL = s.find('.module-item-pic > img').attr('data-src');
    if (picURL) {
      images.push(picURL);
    }
    result.images = images;

    // 构建内容描述
    const contentParts: string[] = [];
    if (quality) {
      contentParts.push(`【${quality}】`);
    }
    if (director) {
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
    if (plot) {
      contentParts.push(plot);
    }

    result.content = contentParts.join('\n');
    result.channel = ''; // 插件搜索结果不设置频道名

    return result;
  }

  private async enhanceWithDetails(results: SearchResult[]): Promise<SearchResult[]> {
    const enhancedResults: SearchResult[] = [];
    const semaphore = this.createSemaphore(MaxConcurrency);

    const promises = results.map(async (result) => {
      await semaphore.acquire();
      try {
        // 从uniqueId提取ID
        const parts = result.uniqueId.split('-');
        if (parts.length < 2) {
          return result;
        }

        const itemID = parts[1];

        // 检查缓存
        const cached = this.getFromCache(itemID);
        if (cached) {
          return cached;
        }

        // 获取详情页链接和图片
        const { links, images } = await this.fetchDetailLinksAndImages(itemID);
        result.links = links;

        // 合并图片：优先使用详情页的海报，如果没有则使用搜索结果的图片
        if (images.length > 0) {
          result.images = images;
        }

        // 缓存结果
        this.cacheResult(itemID, result);

        return result;
      } catch (error) {
        console.error(`[${this.name()}] 增强结果失败:`, error);
        return result;
      } finally {
        semaphore.release();
      }
    });

    const resultsArray = await Promise.all(promises);
    return resultsArray;
  }

  private async fetchDetailLinksAndImages(itemID: string): Promise<{ links: Link[]; images: string[] }> {
    const startTime = Date.now();
    detailPageRequests++;

    const detailURL = `http://xiaocge.fun/index.php/vod/detail/id/${itemID}.html`;

    try {
      const config: AxiosRequestConfig = {
        method: 'GET',
        url: detailURL,
        headers: this.getDetailHeaders(),
        timeout: DetailTimeout
      };

      const resp = await this.doRequestWithRetry(config);

      const $ = cheerio.load(resp.data);

      const links: Link[] = [];
      const images: string[] = [];

      // 提取详情页的海报图片
      const posterURL = $('.module-item-pic > img').attr('data-src');
      if (posterURL) {
        images.push(posterURL);
      }

      // 查找下载链接区域
      $('#download-list .module-row-one').each((i, s) => {
        // 从data-clipboard-text属性提取链接
        const linkURL = $(s).find('[data-clipboard-text]').attr('data-clipboard-text');
        if (linkURL) {
          // 过滤掉无效链接
          if (this.isValidNetworkDriveURL(linkURL)) {
            const link: Link = {
              url: linkURL,
              type: 'quark',
              password: '' // 夸克网盘通常不需要密码
            };
            links.push(link);
          }
        }

        // 也检查直接的href属性
        $(s).find('a[href]').each((j, a) => {
          const href = $(a).attr('href');
          if (href) {
            // 过滤掉无效链接
            if (this.isValidNetworkDriveURL(href)) {
              // 避免重复添加
              const isDuplicate = links.some(link => link.url === href);
              if (!isDuplicate) {
                const link: Link = {
                  url: href,
                  type: 'quark',
                  password: ''
                };
                links.push(link);
              }
            }
          }
        });
      });

      totalDetailTime += Date.now() - startTime;
      return { links, images };
    } catch (error) {
      console.error(`[${this.name()}] 获取详情失败:`, error);
      return { links: [], images: [] };
    }
  }

  private async doRequestWithRetry(config: AxiosRequestConfig): Promise<any> {
    const maxRetries = 3;
    let lastError: any;

    for (let i = 0; i < maxRetries; i++) {
      if (i > 0) {
        // 指数退避
        const backoff = Math.pow(2, i-1) * 200;
        await this.sleep(backoff);
      }

      try {
        const resp = await this.client(config);
        if (resp.status === 200) {
          return resp;
        }
      } catch (error) {
        lastError = error;
      }
    }

    throw new Error(`重试 ${maxRetries} 次后仍然失败: ${lastError}`);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private getSearchHeaders(): Record<string, string> {
    return {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'Connection': 'keep-alive',
      'Upgrade-Insecure-Requests': '1',
      'Cache-Control': 'max-age=0',
      'Referer': 'http://xiaocge.fun/'
    };
  }

  private getDetailHeaders(): Record<string, string> {
    return {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'Connection': 'keep-alive',
      'Referer': 'http://xiaocge.fun/'
    };
  }

  private isValidNetworkDriveURL(url: string): boolean {
    // 过滤掉明显无效的链接
    if (url.includes('javascript:') ||
        url.includes('#') ||
        url === '' ||
        !url.startsWith('http')) {
      return false;
    }

    // 对于labi插件，只检查夸克网盘格式
    return quarkLinkRegex.test(url);
  }

  private createSemaphore(maxConcurrency: number): {
    acquire: () => Promise<void>;
    release: () => void;
  } {
    let count = 0;
    const queue: (() => void)[] = [];

    return {
      acquire: async () => {
        if (count < maxConcurrency) {
          count++;
        } else {
          await new Promise<void>(resolve => queue.push(resolve));
        }
      },
      release: () => {
        count--;
        if (queue.length > 0) {
          const resolve = queue.shift();
          if (resolve) resolve();
        }
      }
    };
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

  private getFromCache(itemID: string): SearchResult | null {
    const cached = detailCache.get(itemID);
    if (cached && Date.now() < cached.timestamp + cacheTTL) {
      cacheHits++;
      return cached.result;
    }
    cacheMisses++;
    return null;
  }

  private cacheResult(itemID: string, result: SearchResult): void {
    detailCache.set(itemID, {
      result: result,
      timestamp: Date.now()
    });
  }

  private startCacheCleaner(): void {
    setInterval(() => {
      const now = Date.now();
      detailCache.forEach((value, key) => {
        if (now > value.timestamp + cacheTTL) {
          detailCache.delete(key);
        }
      });
      lastCleanupTime = now;
    }, 30 * 60 * 1000); // 每30分钟清理一次
  }
}

// 导出插件实例
const plugin = new LabiPlugin();
export default plugin;