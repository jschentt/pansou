import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import * as cheerio from 'cheerio';
import { SearchResult, Link } from '../../models/plugin-result';
import { PluginManager } from '../plugin.manager';

const detailIDRegex = /\/vod\/detail\/id\/(\d+)\.html/;

const quarkLinkRegex = /https?:\/\/pan\.quark\.cn\/s\/[0-9a-zA-Z]+/;
const ucLinkRegex = /https?:\/\/drive\.uc\.cn\/s\/[0-9a-zA-Z]+(\?[^"'\s]*)?/;
const baiduLinkRegex = /https?:\/\/pan\.baidu\.com\/s\/[0-9a-zA-Z_\-]+(\?pwd=[0-9a-zA-Z]+)?/;
const aliyunLinkRegex = /https?:\/\/(www\.)?(aliyundrive\.com|alipan\.com)\/s\/[0-9a-zA-Z]+/;
const xunleiLinkRegex = /https?:\/\/pan\.xunlei\.com\/s\/[0-9a-zA-Z_\-]+(\?pwd=[0-9a-zA-Z]+)?/;
const tianyiLinkRegex = /https?:\/\/cloud\.189\.cn\/t\/[0-9a-zA-Z]+/;
const link115Regex = /https?:\/\/115\.com\/s\/[0-9a-zA-Z]+/;
const mobileLinkRegex = /https?:\/\/caiyun\.feixin\.10086\.cn\/[0-9a-zA-Z]+/;
const weiyunLinkRegex = /https?:\/\/share\.weiyun\.com\/[0-9a-zA-Z]+/;
const lanzouLinkRegex = /https?:\/\/(www\.)?(lanzou[uixys]*|lan[zs]o[ux])\.(com|net|org)\/[0-9a-zA-Z]+/;
const jianguoyunLinkRegex = /https?:\/\/(www\.)?jianguoyun\.com\/p\/[0-9a-zA-Z]+/;
const link123Regex = /https?:\/\/123pan\.com\/s\/[0-9a-zA-Z]+/;
const pikpakLinkRegex = /https?:\/\/mypikpak\.com\/s\/[0-9a-zA-Z]+/;
const magnetLinkRegex = /magnet:\?xt=urn:btih:[0-9a-fA-F]{40}/;
const ed2kLinkRegex = /ed2k:\/\/\|file\|.+\|\d+\|[0-9a-fA-F]{32}\|\//;

const DefaultTimeout = 8000;
const DetailTimeout = 6000;
const MaxConcurrency = 20;
const cacheTTL = 1 * 60 * 60 * 1000; // 1小时

interface CacheEntry {
  result: SearchResult;
  timestamp: number;
}

export class MuouAsyncPlugin {
  private client: AxiosInstance;
  private detailCache: Map<string, CacheEntry>;
  private performanceStats = {
    searchRequests: 0,
    detailPageRequests: 0,
    cacheHits: 0,
    cacheMisses: 0,
    totalSearchTime: 0,
    totalDetailTime: 0
  };

  constructor() {
    this.client = axios.create({
      timeout: DefaultTimeout,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
        'Cache-Control': 'max-age=0',
        'Referer': 'https://666.666291.xyz/'
      }
    });
    this.detailCache = new Map<string, CacheEntry>();
    this.startCacheCleanup();
  }

  public async search(keyword: string, ext: Record<string, any>): Promise<SearchResult[]> {
    const start = Date.now();
    this.performanceStats.searchRequests++;

    try {
      const searchURL = `https://666.666291.xyz/index.php/vod/search/wd/${encodeURIComponent(keyword)}.html`;

      const resp = await this.doRequestWithRetry({
        url: searchURL,
        method: 'GET',
        timeout: DefaultTimeout
      });

      const $ = cheerio.load(resp.data);
      const results: SearchResult[] = [];

      $('.module-search-item').each((i, s) => {
        const result = this.parseSearchItem($(s), keyword);
        if (result.uniqueId) {
          results.push(result);
        }
      });

      const enhancedResults = await this.enhanceWithDetails(results);
      const filteredResults = this.filterResultsByKeyword(enhancedResults, keyword);

      return filteredResults;
    } finally {
      this.performanceStats.totalSearchTime += Date.now() - start;
    }
  }

  private parseSearchItem(s: cheerio.Cheerio, keyword: string): SearchResult {
    const result: SearchResult = {
      uniqueId: '',
      title: '',
      content: '',
      links: [],
      tags: [],
      channel: '',
      datetime: new Date(),
      images: []
    };

    const detailLink = s.find('.video-info-header h3 a').first().attr('href');
    if (!detailLink) {
      return result;
    }

    const matches = detailIDRegex.exec(detailLink);
    if (!matches || matches.length < 2) {
      return result;
    }

    const itemID = matches[1];
    result.uniqueId = `muou-${itemID}`;

    const titleElement = s.find('.video-info-header h3 a');
    result.title = titleElement.text().trim();

    const qualityElement = s.find('.video-serial');
    const quality = qualityElement.text().trim();

    const tags: string[] = [];
    s.find('.video-info-aux .tag-link a').each((i, tag) => {
      const tagText = $(tag).text().trim();
      if (tagText) {
        tags.push(tagText);
      }
    });
    result.tags = tags;

    let director = '';
    s.find('.video-info-items').each((i, item) => {
      const title = $(item).find('.video-info-itemtitle').text().trim();
      if (title.includes('导演')) {
        director = $(item).find('.video-info-actor a').text().trim();
      }
    });

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

    let plot = '';
    s.find('.video-info-items').each((i, item) => {
      const title = $(item).find('.video-info-itemtitle').text().trim();
      if (title.includes('剧情')) {
        plot = $(item).find('.video-info-item').text().trim();
      }
    });

    const images: string[] = [];
    const picURL = s.find('.module-item-pic > img').attr('data-src');
    if (picURL) {
      images.push(picURL);
    }
    result.images = images;

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

    return result;
  }

  private async enhanceWithDetails(results: SearchResult[]): Promise<SearchResult[]> {
    const enhancedResults: SearchResult[] = [];
    const semaphore = this.createSemaphore(MaxConcurrency);

    await Promise.all(results.map(async (result) => {
      await semaphore.acquire();
      try {
        const parts = result.uniqueId.split('-');
        if (parts.length < 2) {
          enhancedResults.push(result);
          return;
        }

        const itemID = parts[1];

        const cached = this.detailCache.get(itemID);
        if (cached && Date.now() < cached.timestamp + cacheTTL) {
          this.performanceStats.cacheHits++;
          enhancedResults.push(cached.result);
          return;
        }

        this.performanceStats.cacheMisses++;

        const { links, images } = await this.fetchDetailLinksAndImages(itemID);
        result.links = links;

        if (images.length > 0) {
          result.images = images;
        }

        this.detailCache.set(itemID, {
          result,
          timestamp: Date.now()
        });

        enhancedResults.push(result);
      } finally {
        semaphore.release();
      }
    }));

    return enhancedResults;
  }

  private async fetchDetailLinksAndImages(itemID: string): Promise<{ links: Link[]; images: string[] }> {
    const start = Date.now();
    this.performanceStats.detailPageRequests++;

    try {
      const detailURL = `https://666.666291.xyz/index.php/vod/detail/id/${itemID}.html`;

      const resp = await this.doRequestWithRetry({
        url: detailURL,
        method: 'GET',
        timeout: DetailTimeout
      });

      const $ = cheerio.load(resp.data);
      const links: Link[] = [];
      const images: string[] = [];

      const posterURL = $('.mobile-play .lazyload').attr('data-src');
      if (posterURL) {
        images.push(posterURL);
      }

      $('#download-list .module-row-one').each((i, s) => {
        const linkURL = $(s).find('[data-clipboard-text]').attr('data-clipboard-text');
        if (linkURL && this.isValidNetworkDriveURL(linkURL)) {
          const linkType = this.determineLinkType(linkURL);
          if (linkType) {
            const link: Link = {
              type: linkType,
              url: linkURL,
              password: ''
            };
            links.push(link);
          }
        }

        $(s).find('a[href]').each((j, a) => {
          const linkURL = $(a).attr('href');
          if (linkURL && this.isValidNetworkDriveURL(linkURL)) {
            const linkType = this.determineLinkType(linkURL);
            if (linkType) {
              const isDuplicate = links.some(existingLink => existingLink.url === linkURL);
              if (!isDuplicate) {
                const link: Link = {
                  type: linkType,
                  url: linkURL,
                  password: ''
                };
                links.push(link);
              }
            }
          }
        });
      });

      return { links, images };
    } catch (error) {
      console.error(`[muou] 获取详情失败: ${error instanceof Error ? error.message : String(error)}`);
      return { links: [], images: [] };
    } finally {
      this.performanceStats.totalDetailTime += Date.now() - start;
    }
  }

  private isValidNetworkDriveURL(url: string): boolean {
    if (
      url.includes('javascript:') ||
      url.includes('#') ||
      url === '' ||
      (!url.startsWith('http') && !url.startsWith('magnet:') && !url.startsWith('ed2k:'))
    ) {
      return false;
    }

    return (
      quarkLinkRegex.test(url) ||
      ucLinkRegex.test(url) ||
      baiduLinkRegex.test(url) ||
      aliyunLinkRegex.test(url) ||
      xunleiLinkRegex.test(url) ||
      tianyiLinkRegex.test(url) ||
      link115Regex.test(url) ||
      mobileLinkRegex.test(url) ||
      weiyunLinkRegex.test(url) ||
      lanzouLinkRegex.test(url) ||
      jianguoyunLinkRegex.test(url) ||
      link123Regex.test(url) ||
      pikpakLinkRegex.test(url) ||
      magnetLinkRegex.test(url) ||
      ed2kLinkRegex.test(url)
    );
  }

  private determineLinkType(url: string): string {
    if (quarkLinkRegex.test(url)) return 'quark';
    if (ucLinkRegex.test(url)) return 'uc';
    if (baiduLinkRegex.test(url)) return 'baidu';
    if (aliyunLinkRegex.test(url)) return 'aliyun';
    if (xunleiLinkRegex.test(url)) return 'xunlei';
    if (tianyiLinkRegex.test(url)) return 'tianyi';
    if (link115Regex.test(url)) return '115';
    if (mobileLinkRegex.test(url)) return 'mobile';
    if (weiyunLinkRegex.test(url)) return 'weiyun';
    if (lanzouLinkRegex.test(url)) return 'lanzou';
    if (jianguoyunLinkRegex.test(url)) return 'jianguoyun';
    if (link123Regex.test(url)) return '123';
    if (pikpakLinkRegex.test(url)) return 'pikpak';
    if (magnetLinkRegex.test(url)) return 'magnet';
    if (ed2kLinkRegex.test(url)) return 'ed2k';
    return '';
  }

  private async doRequestWithRetry(config: AxiosRequestConfig): Promise<any> {
    const maxRetries = 3;
    let lastError: any;

    for (let i = 0; i < maxRetries; i++) {
      if (i > 0) {
        const backoff = Math.pow(2, i - 1) * 200;
        await new Promise(resolve => setTimeout(resolve, backoff));
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

    throw new Error(`重试 ${maxRetries} 次后仍然失败: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
  }

  private createSemaphore(maxConcurrency: number): { acquire: () => Promise<void>; release: () => void } {
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
          resolve?.();
        }
      }
    };
  }

  private filterResultsByKeyword(results: SearchResult[], keyword: string): SearchResult[] {
    const lowerKeyword = keyword.toLowerCase();
    return results.filter(result => {
      return (
        result.title.toLowerCase().includes(lowerKeyword) ||
        result.content.toLowerCase().includes(lowerKeyword)
      );
    });
  }

  private startCacheCleanup(): void {
    setInterval(() => {
      const now = Date.now();
      for (const [key, entry] of this.detailCache.entries()) {
        if (now > entry.timestamp + cacheTTL) {
          this.detailCache.delete(key);
        }
      }
    }, 5 * 60 * 1000); // 每5分钟清理一次过期缓存
  }

  public getPerformanceStats(): Record<string, any> {
    const { searchRequests, detailPageRequests, cacheHits, cacheMisses, totalSearchTime, totalDetailTime } = this.performanceStats;
    
    let avgSearchTime = 0;
    let avgDetailTime = 0;
    let cacheHitRate = 0;
    
    if (searchRequests > 0) {
      avgSearchTime = totalSearchTime / searchRequests;
    }
    if (detailPageRequests > 0) {
      avgDetailTime = totalDetailTime / detailPageRequests;
    }
    if (cacheHits + cacheMisses > 0) {
      cacheHitRate = (cacheHits / (cacheHits + cacheMisses)) * 100;
    }
    
    return {
      search_requests: searchRequests,
      detail_page_requests: detailPageRequests,
      cache_hits: cacheHits,
      cache_misses: cacheMisses,
      cache_hit_rate: cacheHitRate,
      avg_search_time_ms: avgSearchTime,
      avg_detail_time_ms: avgDetailTime,
      total_search_time_ms: totalSearchTime,
      total_detail_time_ms: totalDetailTime
    };
  }
}

const plugin = new MuouAsyncPlugin();
PluginManager.registerPlugin('muou', plugin, 2);
export default plugin;