import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import * as cheerio from 'cheerio';
import { SearchResult, Link, PluginSearchResult } from '../../../model';
import { FilterResultsByKeyword } from '../../../util/plugin.util';

// 常量定义
const pluginName = 'xiaoji';
const baseURL = 'https://www.xiaojitv.com';

// 超时时间配置
const DefaultTimeout = 10000; // 10秒
const DetailTimeout = 8000;   // 8秒

// 并发数配置
const MaxConcurrency = 15;

// HTTP连接池配置
const MaxIdleConns = 100;
const MaxConnsPerHost = 50;
const IdleConnTimeout = 90000; // 90秒

// 缓存相关
const cacheTTL = 3600000; // 1小时

// 预编译的正则表达式
const detailIDRegex = /\/(\d+)\.html/;
const goLinkRegex = /\/go\.html\?url=([A-Za-z0-9+/]+=*)/;
const yearRegex = /(\d{4})/;

// 缓存管理
class CacheManager {
  private detailCache = new Map<string, Link[]>();
  private lastCleanupTime = Date.now();

  constructor() {
    // 启动缓存清理定时器
    this.startCacheCleaner();
  }

  // 启动缓存清理定时器
  private startCacheCleaner() {
    setInterval(() => {
      const now = Date.now();
      for (const [key, value] of this.detailCache.entries()) {
        // 由于没有存储时间戳，我们通过最后清理时间和缓存TTL来判断是否过期
        // 简单的实现：每30分钟清理所有缓存
        this.detailCache.clear();
        break;
      }
      this.lastCleanupTime = now;
    }, 30 * 60 * 1000); // 30分钟清理一次
  }

  // 获取缓存
  get(key: string): Link[] | undefined {
    return this.detailCache.get(key);
  }

  // 设置缓存
  set(key: string, value: Link[]): void {
    this.detailCache.set(key, value);
  }

  // 清空缓存
  clear(): void {
    this.detailCache.clear();
  }
}

// XiaojiAsyncPlugin 小鸡影视异步插件
class XiaojiAsyncPlugin {
  private name: string;
  private cacheManager: CacheManager;
  private optimizedClient: AxiosInstance;
  private MainCacheKey: string;

  constructor() {
    this.name = pluginName;
    this.cacheManager = new CacheManager();
    this.optimizedClient = this.createOptimizedHTTPClient();
    this.MainCacheKey = pluginName;
  }

  // 创建优化的HTTP客户端
  private createOptimizedHTTPClient(): AxiosInstance {
    return axios.create({
      timeout: DefaultTimeout,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Connection': 'keep-alive',
        'Referer': baseURL + '/',
        'Cache-Control': 'max-age=0',
        'Upgrade-Insecure-Requests': '1'
      },
      // Axios使用httpAgent和httpsAgent来配置连接池
      httpAgent: new (require('http').Agent)({
        keepAlive: true,
        maxSockets: MaxIdleConns,
        maxFreeSockets: MaxConnsPerHost,
        timeout: IdleConnTimeout
      }),
      httpsAgent: new (require('https').Agent)({
        keepAlive: true,
        maxSockets: MaxIdleConns,
        maxFreeSockets: MaxConnsPerHost,
        timeout: IdleConnTimeout
      })
    });
  }

  // Name 返回插件名称
  Name(): string {
    return this.name;
  }

  // Search 执行搜索并返回结果（兼容性方法）
  async Search(keyword: string, ext: Record<string, any>): Promise<SearchResult[]> {
    const result = await this.SearchWithResult(keyword, ext);
    return result.Results;
  }

  // SearchWithResult 执行搜索并返回包含IsFinal标记的结果
  async SearchWithResult(keyword: string, ext: Record<string, any>): Promise<PluginSearchResult> {
    return this.AsyncSearchWithResult(keyword, this.searchImpl.bind(this), this.MainCacheKey, ext);
  }

  // AsyncSearchWithResult 异步搜索实现
  private async AsyncSearchWithResult(keyword: string, searchImpl: (client: AxiosInstance, keyword: string, ext: Record<string, any>) => Promise<SearchResult[]>, cacheKey: string, ext: Record<string, any>): Promise<PluginSearchResult> {
    const results = await searchImpl(this.optimizedClient, keyword, ext);
    
    return {
      Results: results,
      IsFinal: true,
      CacheKey: cacheKey,
      Source: this.name
    };
  }

  // searchImpl 具体的搜索实现
  private async searchImpl(client: AxiosInstance, keyword: string, ext: Record<string, any>): Promise<SearchResult[]> {
    // 1. 构建搜索URL
    const encodedKeyword = encodeURIComponent(keyword);
    const searchURL = `${baseURL}/?s=${encodedKeyword}`;
    
    // 2. 创建请求配置
    const requestConfig: AxiosRequestConfig = {
      method: 'GET',
      url: searchURL,
      timeout: DefaultTimeout
    };
    
    // 3. 发送请求（带重试机制）
    let response;
    try {
      response = await this.doRequestWithRetry(client, requestConfig);
    } catch (err) {
      throw new Error(`[${this.Name()}] 搜索请求失败: ${err instanceof Error ? err.message : String(err)}`);
    }
    
    // 4. 检查状态码
    if (response.status !== 200) {
      throw new Error(`[${this.Name()}] 请求返回状态码: ${response.status}`);
    }
    
    // 5. 解析HTML
    const $ = cheerio.load(response.data);
    
    // 6. 解析搜索结果
    const results = this.parseSearchResults($, keyword);
    
    // 7. 关键词过滤
    return FilterResultsByKeyword(results, keyword);
  }

  // doRequestWithRetry 带重试机制的HTTP请求
  private async doRequestWithRetry(client: AxiosInstance, config: AxiosRequestConfig, maxRetries: number = 3): Promise<any> {
    let lastErr: Error | null = null;
    
    for (let i = 0; i < maxRetries; i++) {
      if (i > 0) {
        // 指数退避重试
        const backoff = Math.min(2 ** (i - 1) * 200, 1000); // 最大1秒
        await new Promise(resolve => setTimeout(resolve, backoff));
      }
      
      try {
        // 发送请求
        const response = await client.request(config);
        if (response.status === 200) {
          return response;
        }
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error(String(err));
      }
    }
    
    throw lastErr || new Error(`重试 ${maxRetries} 次后仍然失败`);
  }

  // parseSearchResults 解析搜索结果
  private parseSearchResults($: cheerio.CheerioAPI, keyword: string): SearchResult[] {
    const results: SearchResult[] = [];
    
    // 查找所有搜索结果项
    $('article.poster-item').each((i, element) => {
      const s = $(element);
      const result = this.parseSearchResultItem($, s, keyword);
      if (result) {
        results.push(result);
      }
    });
    
    return results;
  }

  // parseSearchResultItem 解析单个搜索结果项
  private parseSearchResultItem($: cheerio.CheerioAPI, s: cheerio.Cheerio, keyword: string): SearchResult | null {
    // 1. 提取详情页链接
    const detailLink = s.find('.poster-link').attr('href');
    if (!detailLink || detailLink === '') {
      return null;
    }
    
    // 2. 确保链接是绝对路径
    let fullDetailLink = detailLink;
    if (detailLink.startsWith('/')) {
      fullDetailLink = baseURL + detailLink;
    }
    
    // 3. 提取资源ID
    const matches = fullDetailLink.match(detailIDRegex);
    if (!matches || matches.length < 2) {
      return null;
    }
    const resourceID = matches[1];
    
    // 4. 提取标题
    let title = s.find('.poster-title a').text().trim();
    if (title === '') {
      return null;
    }
    
    // 5. 提取评分
    const rating = s.find('.rating-score').text().trim();
    
    // 6. 提取分类
    const category = s.find('.poster-category a').text().trim();
    
    // 7. 提取标签
    const tags: string[] = [];
    s.find('.poster-tags a').each((i, tagElement) => {
      const tag = $(tagElement).text().trim();
      if (tag !== '') {
        tags.push(tag);
      }
    });
    
    // 8. 提取封面图片
    const coverImg = s.find('.poster-image img').attr('src') || '';
    
    // 9. 构建基础信息
    let content = `分类: ${category}`;
    if (rating !== '') {
      content += ` | 评分: ${rating}`;
    }
    if (tags.length > 0) {
      content += ` | 标签: ${tags.join(', ')}`;
    }
    
    // 10. 获取详情页的下载链接（同步调用，不阻塞主流程）
    const links = this.fetchDetailPageLinks(fullDetailLink);
    
    // 11. 创建搜索结果
    return {
      UniqueID: `${this.name}-${resourceID}`,
      MessageID: `${this.name}-${resourceID}`,
      Title: title,
      Content: content,
      Datetime: new Date(),
      Tags: tags,
      Links: links,
      Channel: '', // 插件搜索结果必须为空字符串
      // 如果有封面图片，可以添加到额外信息中
      // Extra: { Image: coverImg }
    };
  }

  // fetchDetailPageLinks 获取详情页的下载链接
  private fetchDetailPageLinks(detailURL: string): Link[] {
    // 1. 检查缓存
    const cachedLinks = this.cacheManager.get(detailURL);
    if (cachedLinks) {
      return cachedLinks;
    }
    
    // 2. 创建客户端
    const client = axios.create({
      timeout: DetailTimeout,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Connection': 'keep-alive',
        'Referer': baseURL + '/',
        'Cache-Control': 'max-age=0',
        'Upgrade-Insecure-Requests': '1'
      }
    });
    
    // 3. 创建请求配置
    const requestConfig: AxiosRequestConfig = {
      method: 'GET',
      url: detailURL,
      timeout: DetailTimeout
    };
    
    // 4. 发送请求（带重试机制）
    let response;
    try {
      // 使用同步方式发送请求，避免阻塞主流程
      response = client.request(requestConfig).then(res => res).catch(() => null);
    } catch (err) {
      return [];
    }
    
    // 5. 解析响应
    if (response) {
      const $ = cheerio.load(response.data);
      const links = this.parseDetailPageLinks($);
      
      // 6. 缓存结果
      if (links.length > 0) {
        this.cacheManager.set(detailURL, links);
      }
      
      return links;
    }
    
    return [];
  }

  // parseDetailPageLinks 解析详情页的下载链接
  private parseDetailPageLinks($: cheerio.CheerioAPI): Link[] {
    const links: Link[] = [];
    const seenLinks = new Set<string>(); // 用于去重
    
    // 查找相关资源区域的链接
    $('.resource-compact-link a').each((i, element) => {
      const s = $(element);
      const href = s.attr('href');
      if (!href) {
        return;
      }
      
      let realURL: string;
      
      // 检查是否为go.html格式的链接（需要base64解码）
      if (href.includes('/go.html?url=')) {
        // 提取并解码真实链接
        realURL = this.decodeGoLink(href);
      } else if (href.startsWith('http://') || href.startsWith('https://') || href.startsWith('magnet:') || href.startsWith('ed2k://')) {
        // 直接链接（包括磁力链接、网盘链接等）
        realURL = href;
      } else {
        return;
      }
      
      // 处理有效链接
      if (this.isValidURL(realURL) && !seenLinks.has(realURL)) {
        // 确定网盘类型
        const linkType = this.determineCloudType(realURL);
        
        // 创建链接对象
        const link: Link = {
          Type: linkType,
          URL: realURL,
          Password: '', // xiaoji网站通常无密码
        };
        
        links.push(link);
        seenLinks.add(realURL);
      }
    });
    
    return links;
  }

  // decodeGoLink 解码go.html链接，提取真实的网盘链接
  private decodeGoLink(goLink: string): string {
    // 1. 提取base64编码部分
    const matches = goLink.match(goLinkRegex);
    if (!matches || matches.length < 2) {
      return '';
    }
    
    let encoded = matches[1];
    
    // 2. 清理编码字符串
    encoded = encoded.trim();
    if (encoded === '') {
      return '';
    }
    
    // 3. Base64解码
    try {
      // 尝试处理可能的URL编码问题
      encoded = encoded.replace(/ /g, '+');
      // 尝试修复padding问题
      switch (encoded.length % 4) {
        case 2:
          encoded += '==';
          break;
        case 3:
          encoded += '=';
          break;
      }
      
      const decoded = Buffer.from(encoded, 'base64').toString('utf-8');
      const realURL = decoded.trim();
      
      // 4. 验证解码结果是否为有效URL
      if (this.isValidURL(realURL)) {
        return realURL;
      }
    } catch (err) {
      // 解码失败，返回空字符串
    }
    
    return '';
  }

  // isValidURL 验证URL是否有效
  private isValidURL(urlStr: string): boolean {
    if (urlStr === '') {
      return false;
    }
    
    // 检查基本的URL格式
    if (urlStr.startsWith('http://') || urlStr.startsWith('https://')) {
      // HTTP/HTTPS链接需要有域名
      if (urlStr.length <= 8 || urlStr === 'http://' || urlStr === 'https://') {
        return false;
      }
      // 简单检查是否包含域名
      return urlStr.slice(8).includes('.');
    }
    
    // 磁力链接
    if (urlStr.startsWith('magnet:')) {
      return urlStr.length > 7 && urlStr.includes('xt=');
    }
    
    // ED2K链接
    if (urlStr.startsWith('ed2k://')) {
      return urlStr.length > 7;
    }
    
    return false;
  }

  // determineCloudType 确定网盘类型
  private determineCloudType(url: string): string {
    switch (true) {
      case url.includes('pan.quark.cn'):
        return 'quark';
      case url.includes('drive.uc.cn'):
        return 'uc';
      case url.includes('pan.baidu.com'):
        return 'baidu';
      case url.includes('aliyundrive.com') || url.includes('alipan.com'):
        return 'aliyun';
      case url.includes('pan.xunlei.com'):
        return 'xunlei';
      case url.includes('cloud.189.cn'):
        return 'tianyi';
      case url.includes('115.com') || url.includes('115cdn.com'):
        return '115';
      case url.includes('123pan.com'):
        return '123';
      case url.includes('caiyun.139.com'):
        return 'mobile';
      case url.includes('mypikpak.com'):
        return 'pikpak';
      case url.includes('magnet:'):
        return 'magnet';
      case url.includes('ed2k://'):
        return 'ed2k';
      default:
        // ctfile.com 和其他未知网盘都归类到 others
        return 'others';
    }
  }
}

// 创建并导出插件实例
export default new XiaojiAsyncPlugin();