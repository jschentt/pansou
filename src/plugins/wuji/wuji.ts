import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios';
import cheerio from 'cheerio';
import { BaseAsyncPlugin } from '../plugin.manager';
import { SearchResult, Link } from '../../models/plugin-result';

const BaseURL = 'https://xcili.net';
const SearchURL = BaseURL + '/search?q=%s&page=%d';
const MaxRetries = 3;
const TimeoutSeconds = 30;
const MaxConcurrency = 10;
const MaxPages = 5;

interface MagnetCacheEntry {
  MagnetLink: string;
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

export class WujiPlugin extends BaseAsyncPlugin {
  private magnetCache: Map<string, MagnetCacheEntry>;
  private cacheTTL: number;

  constructor() {
    super('wuji', 3, true); // 优先级3，跳过Service层过滤
    this.magnetCache = new Map();
    this.cacheTTL = 60 * 60 * 1000; // 缓存1小时
  }

  Name(): string {
    return 'wuji';
  }

  DisplayName(): string {
    return '无极磁链';
  }

  Description(): string {
    return 'ØMagnet 无极磁链 - 磁力链接搜索引擎';
  }

  private async doRequestWithRetry(client: AxiosInstance, config: AxiosRequestConfig): Promise<AxiosResponse> {
    let lastError: Error | null = null;

    for (let i = 0; i < MaxRetries; i++) {
      if (i > 0) {
        // 指数退避重试
        const backoff = (i + 1) * 1000;
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

    throw new Error(`请求失败，已重试${MaxRetries}次: ${lastError?.message}`);
  }

  protected async searchImpl(client: AxiosInstance, keyword: string): Promise<SearchResult[]> {
    // 1. 首先搜索第一页
    const firstPageResults = await this.searchPage(client, keyword, 1);
    
    // 存储所有结果
    let allResults = [...firstPageResults];
    
    // 2. 并发搜索其他页面（第2页到第5页）
    if (MaxPages > 1) {
      const semaphore = new Semaphore(MaxConcurrency);
      const pageResults: Map<number, SearchResult[]> = new Map();

      const promises = [];
      for (let page = 2; page <= MaxPages; page++) {
        promises.push(async () => {
          await semaphore.acquire();
          try {
            // 添加小延迟避免过于频繁的请求
            await new Promise(resolve => setTimeout(resolve, (page % 3) * 100));
            const results = await this.searchPage(client, keyword, page);
            if (results.length > 0) {
              pageResults.set(page, results);
            }
          } finally {
            semaphore.release();
          }
        });
      }

      await Promise.all(promises.map(p => p()));
      
      // 按页码顺序合并所有页面的结果
      for (let page = 2; page <= MaxPages; page++) {
        if (pageResults.has(page)) {
          allResults = [...allResults, ...pageResults.get(page)!];
        }
      }
    }
    
    // 3. 并发获取每个结果的详情页磁力链接
    const finalResults = await this.enrichWithMagnetLinks(allResults, client);
    
    // 4. 关键词过滤
    return this.filterResultsByKeyword(finalResults, keyword);
  }

  private async searchPage(client: AxiosInstance, keyword: string, page: number): Promise<SearchResult[]> {
    // URL编码关键词
    const encodedKeyword = encodeURIComponent(keyword);
    const searchURL = SearchURL.replace('%s', encodedKeyword).replace('%d', page.toString());
    
    try {
      // 发送HTTP请求
      const resp = await this.doRequestWithRetry(client, {
        url: searchURL,
        method: 'GET',
        headers: this.getRequestHeaders(),
        timeout: TimeoutSeconds * 1000
      });
      
      // 检查状态码
      if (resp.status !== 200) {
        throw new Error(`请求返回状态码: ${resp.status}`);
      }
      
      // 解析HTML
      const $ = cheerio.load(resp.data);
      
      // 提取搜索结果
      return this.extractSearchResults($);
    } catch (error) {
      throw new Error(`搜索页面失败: ${error}`);
    }
  }

  private extractSearchResults($: cheerio.CheerioAPI): SearchResult[] {
    const results: SearchResult[] = [];
    
    // 查找所有搜索结果
    $('table.file-list tbody tr').each((i, s) => {
      const result = this.parseSearchResult($(s));
      if (result.Title) {
        results.push(result);
      }
    });
    
    return results;
  }

  private parseSearchResult(s: cheerio.Cheerio): SearchResult {
    const result: SearchResult = {
      Channel: '', // 插件搜索结果必须为空字符串
      Datetime: new Date(),
      Links: [],
      Tags: []
    };
    
    // 提取标题和详情页链接
    const titleCell = s.find('td').first();
    const titleLink = titleCell.find('a');
    
    // 详情页链接
    const detailPath = titleLink.attr('href');
    if (!detailPath || detailPath === '') {
      return result;
    }
    
    // 构造完整的详情页URL
    const detailURL = BaseURL + detailPath;
    
    // 提取标题（排除 p.sample 的内容）
    const titleText = titleLink.clone();
    titleText.find('p.sample').remove();
    const title = titleText.text().trim();
    result.Title = this.cleanTitle(title);
    
    // 提取文件名预览
    const sampleText = titleLink.find('p.sample').text().trim();
    
    // 提取文件大小
    const sizeText = s.find('td.td-size').text().trim();
    
    // 构造内容
    const contentParts: string[] = [];
    if (sampleText) {
      contentParts.push('文件: ' + sampleText);
    }
    if (sizeText) {
      contentParts.push('大小: ' + sizeText);
    }
    result.Content = contentParts.join('\n');
    
    // 暂时将详情页链接作为占位符（后续会被磁力链接替换）
    result.Links = [{
      Type: 'detail',
      URL: detailURL,
      Password: ''
    }];
    
    // 生成唯一ID
    result.UniqueID = `${this.Name()}-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    result.MessageID = result.UniqueID;
    
    // 添加标签
    result.Tags = ['magnet'];
    
    return result;
  }

  private async fetchMagnetLink(client: AxiosInstance, detailURL: string): Promise<string> {
    // 检查缓存
    const cached = this.magnetCache.get(detailURL);
    if (cached) {
      if (Date.now() - cached.Timestamp < this.cacheTTL) {
        // 缓存命中
        return cached.MagnetLink;
      }
      // 缓存过期，删除
      this.magnetCache.delete(detailURL);
    }
    
    try {
      // 发送HTTP请求
      const resp = await this.doRequestWithRetry(client, {
        url: detailURL,
        method: 'GET',
        headers: this.getRequestHeaders(),
        timeout: TimeoutSeconds * 1000
      });
      
      // 检查状态码
      if (resp.status !== 200) {
        throw new Error(`详情页返回状态码: ${resp.status}`);
      }
      
      // 解析HTML
      const $ = cheerio.load(resp.data);
      
      // 提取磁力链接
      const magnetInput = $('#input-magnet');
      if (magnetInput.length === 0) {
        throw new Error('未找到磁力链接输入框');
      }
      
      const magnetLink = magnetInput.attr('value');
      if (!magnetLink || magnetLink === '') {
        throw new Error('磁力链接为空');
      }
      
      // 存入缓存
      this.magnetCache.set(detailURL, {
        MagnetLink: magnetLink,
        Timestamp: Date.now()
      });
      
      return magnetLink;
    } catch (error) {
      throw new Error(`获取磁力链接失败: ${error}`);
    }
  }

  private cleanTitle(title: string): string {
    // 移除【】之间的广告内容
    title = title.replace(/【[^】]*】/g, '');
    // 移除数字+【】格式的广告
    title = title.replace(/^\d+【[^】]*】/g, '');
    // 移除[]之间的内容（如有需要）
    title = title.replace(/\[[^\]]*\]/g, '');
    // 移除多余的空格
    title = title.replace(/\s+/g, ' ');
    return title.trim();
  }

  private getRequestHeaders(): Record<string, string> {
    const userAgents = [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:89.0) Gecko/20100101 Firefox/89.0'
    ];
    
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

  private async enrichWithMagnetLinks(results: SearchResult[], client: AxiosInstance): Promise<SearchResult[]> {
    if (results.length === 0) {
      return results;
    }
    
    // 使用信号量控制并发数
    const semaphore = new Semaphore(MaxConcurrency);
    const enrichedResults = [...results];

    const promises = enrichedResults.map(async (result, index) => {
      // 检查是否有详情页链接
      if (result.Links.length === 0) {
        return;
      }
      
      await semaphore.acquire();
      try {
        // 获取详情页URL
        const detailURL = result.Links[0].URL;
        
        // 添加适当的间隔避免请求过于频繁
        await new Promise(resolve => setTimeout(resolve, (index % 5) * 100));
        
        // 请求详情页并解析磁力链接
        try {
          const magnetLink = await this.fetchMagnetLink(client, detailURL);
          if (magnetLink) {
            enrichedResults[index].Links = [{
              Type: 'magnet',
              URL: magnetLink,
              Password: ''
            }];
          }
        } catch (error) {
          console.error(`[wuji] 获取磁力链接失败 [${index}]: ${error}`);
        }
      } finally {
        semaphore.release();
      }
    });

    await Promise.all(promises);
    
    // 过滤掉没有有效磁力链接的结果
    return enrichedResults.filter(result => {
      return result.Links.length > 0 && result.Links[0].Type === 'magnet';
    });
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
const plugin = new WujiPlugin();
plugin.register();
