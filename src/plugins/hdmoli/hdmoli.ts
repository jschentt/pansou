import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import * as cheerio from 'cheerio';
import { SearchResult, Link } from '../../types';
import { Plugin } from '../../types/plugin';

const PluginName = 'hdmoli';
const DisplayName = 'HDmoli';
const Description = 'HDmoli - 影视资源网盘下载链接搜索';
const BaseURL = 'https://www.hdmoli.pro';
const SearchPath = '/search.php?searchkey=%s&submit=';
const UserAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36';
const MaxResults = 50;
const MaxConcurrency = 20;

class Semaphore {
  private available: number;
  private queue: Array<() => void> = [];

  constructor(initial: number) {
    this.available = initial;
  }

  async acquire(): Promise<void> {
    return new Promise((resolve) => {
      if (this.available > 0) {
        this.available--;
        resolve();
      } else {
        this.queue.push(resolve);
      }
    });
  }

  release(): void {
    this.available++;
    if (this.queue.length > 0) {
      const resolve = this.queue.shift();
      if (resolve) {
        resolve();
      }
    }
  }
}

class HdmoliPlugin implements Plugin {
  private debugMode: boolean;
  private detailCache: Map<string, { links: Link[]; timestamp: number }>;
  private cacheTTL: number;

  constructor() {
    this.debugMode = false; // 生产环境关闭调试
    this.detailCache = new Map();
    this.cacheTTL = 30 * 60 * 1000; // 详情页缓存30分钟
    this.startCacheCleaner();
  }

  private startCacheCleaner(): void {
    setInterval(() => {
      const now = Date.now();
      this.detailCache.forEach((value, key) => {
        if (now - value.timestamp > this.cacheTTL) {
          this.detailCache.delete(key);
        }
      });
    }, 30 * 60 * 1000); // 每30分钟清理一次
  }

  name(): string {
    return PluginName;
  }

  displayName(): string {
    return DisplayName;
  }

  description(): string {
    return Description;
  }

  async search(keyword: string, ext: Record<string, any>): Promise<SearchResult[]> {
    return this.searchImpl(axios.create({ timeout: 30000 }), keyword, ext);
  }

  private async searchImpl(client: AxiosInstance, keyword: string, ext: Record<string, any>): Promise<SearchResult[]> {
    if (this.debugMode) {
      console.log(`[HDMOLI] 开始搜索: ${keyword}`);
    }

    // 第一步：执行搜索获取结果列表
    const searchResults = await this.executeSearch(client, keyword);

    if (this.debugMode) {
      console.log(`[HDMOLI] 搜索获取到 ${searchResults.length} 个结果`);
    }

    // 第二步：并发获取详情页链接
    const finalResults = await this.fetchDetailLinks(client, searchResults, keyword);

    if (this.debugMode) {
      console.log(`[HDMOLI] 最终获取到 ${finalResults.length} 个有效结果`);
    }

    // 第三步：关键词过滤
    const filteredResults = this.filterResultsByKeyword(finalResults, keyword);
    
    if (this.debugMode) {
      console.log(`[HDMOLI] 关键词过滤后剩余 ${filteredResults.length} 个结果`);
    }

    return filteredResults;
  }

  private async executeSearch(client: AxiosInstance, keyword: string): Promise<SearchResult[]> {
    // 构建搜索URL
    const searchURL = `${BaseURL}${SearchPath.replace('%s', encodeURIComponent(keyword))}`;

    const config: AxiosRequestConfig = {
      method: 'GET',
      url: searchURL,
      headers: {
        'User-Agent': UserAgent,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
        'Cache-Control': 'max-age=0',
        'Referer': BaseURL + '/'
      }
    };

    const resp = await this.doRequestWithRetry(client, config);
    
    // 解析HTML提取搜索结果
    const $ = cheerio.load(resp.data);
    return this.parseSearchResults($);
  }

  private async doRequestWithRetry(client: AxiosInstance, config: AxiosRequestConfig): Promise<any> {
    const maxRetries = 3;
    let lastErr: any;
    
    for (let i = 0; i < maxRetries; i++) {
      if (i > 0) {
        // 指数退避重试
        const backoff = Math.pow(2, i - 1) * 200;
        await new Promise(resolve => setTimeout(resolve, backoff));
      }
      
      try {
        const resp = await client(config);
        if (resp.status === 200) {
          return resp;
        }
      } catch (err) {
        lastErr = err;
      }
    }
    
    throw new Error(`[${this.name()}] 重试 ${maxRetries} 次后仍然失败: ${lastErr}`);
  }

  private parseSearchResults($: cheerio.CheerioAPI): SearchResult[] {
    const results: SearchResult[] = [];

    // 查找搜索结果项: #searchList > li.active.clearfix
    $('#searchList > li.active.clearfix').each((i, element) => {
      if (results.length >= MaxResults) {
        return false;
      }

      const result = this.parseResultItem($(element), i + 1);
      if (result) {
        results.push(result);
      }
    });

    if (this.debugMode) {
      console.log(`[HDMOLI] 解析到 ${results.length} 个原始结果`);
    }

    return results;
  }

  private parseResultItem(s: cheerio.Cheerio, index: number): SearchResult | null {
    // 提取标题和链接
    const titleEl = s.find('.detail h4.title a');
    if (titleEl.length === 0) {
      if (this.debugMode) {
        console.log('[HDMOLI] 跳过无标题链接的结果');
      }
      return null;
    }

    // 提取标题
    const title = titleEl.text().trim();
    if (title === '') {
      return null;
    }

    // 提取详情页链接
    let detailURL = titleEl.attr('href') || '';
    if (detailURL === '') {
      // 尝试从缩略图获取链接
      const thumbEl = s.find('.thumb a');
      if (thumbEl.length > 0) {
        detailURL = thumbEl.attr('href') || '';
      }
    }

    if (detailURL === '') {
      if (this.debugMode) {
        console.log(`[HDMOLI] 跳过无链接的结果: ${title}`);
      }
      return null;
    }

    // 处理相对路径
    if (detailURL.startsWith('/')) {
      detailURL = BaseURL + detailURL;
    }

    // 提取评分
    const rating = this.extractRating(s);

    // 提取更新状态
    const updateStatus = this.extractUpdateStatus(s);

    // 提取导演
    const director = this.extractDirector(s);

    // 提取主演
    const actors = this.extractActors(s);

    // 提取分类信息
    const { category, region, year } = this.extractCategoryInfo(s);

    // 提取简介
    const description = this.extractDescription(s);

    // 构建内容
    const contentParts: string[] = [];
    if (rating) {
      contentParts.push(`评分：${rating}`);
    }
    if (updateStatus) {
      contentParts.push(`状态：${updateStatus}`);
    }
    if (director) {
      contentParts.push(`导演：${director}`);
    }
    if (actors.length > 0) {
      let actorStr = actors.join(' ');
      if (actorStr.length > 100) {
        actorStr = actorStr.substring(0, 100) + '...';
      }
      contentParts.push(`主演：${actorStr}`);
    }
    if (category) {
      contentParts.push(`分类：${category}`);
    }
    if (region) {
      contentParts.push(`地区：${region}`);
    }
    if (year) {
      contentParts.push(`年份：${year}`);
    }
    if (description) {
      contentParts.push(`简介：${description}`);
    }

    const content = contentParts.join('\n');

    // 构建标签
    const tags: string[] = [];
    if (category) {
      tags.push(category);
    }
    if (region) {
      tags.push(region);
    }
    if (year) {
      tags.push(year);
    }

    // 构建初始结果对象（详情页链接稍后获取）
    const result: SearchResult = {
      title: title,
      content: content,
      channel: '', // 插件搜索结果必须为空字符串
      messageId: `${this.name()}-${index}-${Date.now()}`,
      uniqueId: `${this.name()}-${index}-${Date.now()}`,
      datetime: new Date(), // 搜索结果页没有明确时间，使用当前时间
      links: [], // 先为空，详情页处理后添加
      tags: tags,
      pluginName: this.name(),
      displayName: this.displayName()
    };

    // 添加详情页URL到临时字段（用于后续处理）
    result.content += `\n详情页URL: ${detailURL}`;

    if (this.debugMode) {
      console.log(`[HDMOLI] 解析结果: ${title} (${category})`);
    }

    return result;
  }

  private extractRating(s: cheerio.Cheerio): string {
    const ratingEl = s.find('.pic-tag');
    if (ratingEl.length > 0) {
      return ratingEl.text().trim();
    }
    return '';
  }

  private extractUpdateStatus(s: cheerio.Cheerio): string {
    const statusEl = s.find('.pic-text');
    if (statusEl.length > 0) {
      return statusEl.text().trim();
    }
    return '';
  }

  private extractDirector(s: cheerio.Cheerio): string {
    let director = '';
    s.find('p').each((i, element) => {
      if (director) {
        return false;
      }
      const text = $(element).text();
      if (text.includes('导演：')) {
        // 提取导演名称
        const parts = text.split('导演：');
        if (parts.length > 1) {
          director = parts[1].trim();
        }
      }
    });
    return director;
  }

  private extractActors(s: cheerio.Cheerio): string[] {
    const actors: string[] = [];
    s.find('p').each((i, element) => {
      const text = $(element).text();
      if (text.includes('主演：')) {
        // 在这个p标签中查找所有链接
        $(element).find('a').each((j, aElement) => {
          const actor = $(aElement).text().trim();
          if (actor) {
            actors.push(actor);
          }
        });
      }
    });
    return actors;
  }

  private extractCategoryInfo(s: cheerio.Cheerio): { category: string; region: string; year: string } {
    let category = '';
    let region = '';
    let year = '';

    s.find('p').each((i, element) => {
      const text = $(element).text();
      if (text.includes('分类：')) {
        // 解析分类信息行
        const parts = text.split('：');
        for (let i = 0; i < parts.length; i++) {
          const part = parts[i].trim();
          if (part.endsWith('分类') && i + 1 < parts.length) {
            // 提取分类，可能包含地区和年份信息
            const info = parts[i + 1].trim();
            // 按分隔符分割
            const infoParts = info.split(/[，,\s]+/);
            if (infoParts.length > 0 && infoParts[0]) {
              category = infoParts[0];
            }
          } else if (part.endsWith('地区') && i + 1 < parts.length) {
            const regionPart = parts[i + 1].trim();
            const regionParts = regionPart.split(/[，,\s]+/);
            if (regionParts.length > 0 && regionParts[0]) {
              region = regionParts[0];
            }
          } else if (part.endsWith('年份') && i + 1 < parts.length) {
            const yearPart = parts[i + 1].trim();
            const yearParts = yearPart.split(/[，,\s]+/);
            if (yearParts.length > 0 && yearParts[0]) {
              year = yearParts[0];
            }
          }
        }
      }
    });

    return { category, region, year };
  }

  private extractDescription(s: cheerio.Cheerio): string {
    let description = '';
    s.find('p.hidden-xs').each((i, element) => {
      if (description) {
        return false;
      }
      const text = $(element).text();
      if (text.includes('简介：')) {
        const parts = text.split('简介：');
        if (parts.length > 1) {
          let desc = parts[1].trim();
          // 限制长度
          if (desc.length > 200) {
            desc = desc.substring(0, 200) + '...';
          }
          description = desc;
        }
      }
    });
    return description;
  }

  private async fetchDetailLinks(client: AxiosInstance, searchResults: SearchResult[], keyword: string): Promise<SearchResult[]> {
    if (searchResults.length === 0) {
      return [];
    }

    const semaphore = new Semaphore(MaxConcurrency);
    const tasks: Promise<SearchResult | null>[] = [];

    for (const result of searchResults) {
      tasks.push((async () => {
        await semaphore.acquire();
        try {
          // 从Content中提取详情页URL
          const detailURL = this.extractDetailURLFromContent(result.content);
          if (!detailURL) {
            if (this.debugMode) {
              console.log(`[HDMOLI] 跳过无详情页URL的结果: ${result.title}`);
            }
            return null;
          }

          // 获取详情页链接
          const links = await this.fetchDetailPageLinks(client, detailURL);
          if (links.length > 0) {
            result.links = links;
            // 清理Content中的详情页URL
            result.content = this.cleanContent(result.content);
            return result;
          } else if (this.debugMode) {
            console.log(`[HDMOLI] 详情页无有效链接: ${result.title}`);
          }
          return null;
        } finally {
          semaphore.release();
        }
      })());
    }

    const results = await Promise.all(tasks);
    return results.filter((r): r is SearchResult => r !== null);
  }

  private extractDetailURLFromContent(content: string): string {
    const lines = content.split('\n');
    for (const line of lines) {
      if (line.startsWith('详情页URL: ')) {
        return line.substring('详情页URL: '.length);
      }
    }
    return '';
  }

  private cleanContent(content: string): string {
    const lines = content.split('\n');
    const cleanedLines: string[] = [];
    for (const line of lines) {
      if (!line.startsWith('详情页URL: ')) {
        cleanedLines.push(line);
      }
    }
    return cleanedLines.join('\n');
  }

  private async fetchDetailPageLinks(client: AxiosInstance, detailURL: string): Promise<Link[]> {
    // 检查缓存
    const cached = this.detailCache.get(detailURL);
    if (cached) {
      if (this.debugMode) {
        console.log(`[HDMOLI] 使用缓存的详情页链接: ${detailURL}`);
      }
      return cached.links;
    }

    const config: AxiosRequestConfig = {
      method: 'GET',
      url: detailURL,
      headers: {
        'User-Agent': UserAgent,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Referer': BaseURL + '/'
      }
    };

    let resp;
    try {
      resp = await client(config);
    } catch (err) {
      if (this.debugMode) {
        console.log(`[HDMOLI] 详情页请求失败: ${err}`);
      }
      return [];
    }

    if (resp.status !== 200) {
      if (this.debugMode) {
        console.log(`[HDMOLI] 详情页HTTP状态错误: ${resp.status}`);
      }
      return [];
    }

    // 解析网盘链接
    const links = this.parseNetworkDiskLinks(resp.data);

    // 缓存结果
    if (links.length > 0) {
      this.detailCache.set(detailURL, { links, timestamp: Date.now() });
    }

    if (this.debugMode) {
      console.log(`[HDMOLI] 从详情页提取到 ${links.length} 个链接: ${detailURL}`);
    }

    return links;
  }

  private parseNetworkDiskLinks(htmlContent: string): Link[] {
    let links: Link[] = [];

    try {
      // 解析HTML文档以便更精确的提取
      const $ = cheerio.load(htmlContent);

      // 在"视频下载"区域查找网盘链接
      $('.downlist').each((i, element) => {
        $(element).find('p').each((j, pEl) => {
          const text = $(pEl).text();
          
          // 查找夸克网盘
          if (text.includes('夸 克：') || text.includes('夸克：')) {
            $(pEl).find('a').each((k, a) => {
              const href = $(a).attr('href');
              if (href && href.includes('pan.quark.cn')) {
                const link: Link = {
                  type: 'quark',
                  url: href,
                  password: this.extractPasswordFromQuarkURL(href)
                };
                links.push(link);
                if (this.debugMode) {
                  console.log(`[HDMOLI] 找到夸克链接: ${href}`);
                }
              }
            });
          }
          
          // 查找百度网盘
          if (text.includes('百 度：') || text.includes('百度：')) {
            $(pEl).find('a').each((k, a) => {
              const href = $(a).attr('href');
              if (href && href.includes('pan.baidu.com')) {
                const password = this.extractPasswordFromBaiduURL(href);
                const link: Link = {
                  type: 'baidu',
                  url: href,
                  password: password
                };
                links.push(link);
                if (this.debugMode) {
                  console.log(`[HDMOLI] 找到百度链接: ${href} (密码: ${password})`);
                }
              }
            });
          }
        });
      });
    } catch (err) {
      if (this.debugMode) {
        console.log(`[HDMOLI] 解析详情页HTML失败: ${err}`);
      }
      // 如果解析失败，使用正则表达式作为备选
      return this.parseNetworkDiskLinksWithRegex(htmlContent);
    }

    return links;
  }

  private parseNetworkDiskLinksWithRegex(htmlContent: string): Link[] {
    const links: Link[] = [];

    // 夸克网盘链接模式
    const quarkPattern = /<b>夸\s*克：<\/b><a[^>]*href\s*=\s*["']([^"']*pan\.quark\.cn[^"']*)["'][^>]*>/g;
    let match;
    while ((match = quarkPattern.exec(htmlContent)) !== null) {
      if (match[1]) {
        const link: Link = {
          type: 'quark',
          url: match[1],
          password: ''
        };
        links.push(link);
      }
    }

    // 百度网盘链接模式
    const baiduPattern = /<b>百\s*度：<\/b><a[^>]*href\s*=\s*["']([^"']*pan\.baidu\.com[^"']*)["'][^>]*>/g;
    while ((match = baiduPattern.exec(htmlContent)) !== null) {
      if (match[1]) {
        const password = this.extractPasswordFromBaiduURL(match[1]);
        const link: Link = {
          type: 'baidu',
          url: match[1],
          password: password
        };
        links.push(link);
      }
    }

    return links;
  }

  private extractPasswordFromQuarkURL(panURL: string): string {
    // 夸克网盘一般不需要提取码，直接返回空
    return '';
  }

  private extractPasswordFromBaiduURL(panURL: string): string {
    // 检查URL中是否包含pwd参数
    if (panURL.includes('?pwd=')) {
      const parts = panURL.split('?pwd=');
      if (parts.length > 1) {
        return parts[1];
      }
    }
    if (panURL.includes('&pwd=')) {
      const parts = panURL.split('&pwd=');
      if (parts.length > 1) {
        return parts[1];
      }
    }
    return '';
  }

  private filterResultsByKeyword(results: SearchResult[], keyword: string): SearchResult[] {
    if (!keyword) {
      return results;
    }

    const keywordLower = keyword.toLowerCase();
    return results.filter(result => {
      const titleLower = result.title.toLowerCase();
      const contentLower = result.content.toLowerCase();
      return titleLower.includes(keywordLower) || contentLower.includes(keywordLower);
    });
  }
}

// 导出插件实例
const plugin = new HdmoliPlugin();
export default plugin;