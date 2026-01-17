import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import * as cheerio from 'cheerio';
import { SearchResult, Link, PluginSearchResult } from '../../../model';
import { FilterResultsByKeyword } from '../../../util/plugin.util';

// 常量定义
const SearchURL = 'https://susuifa.com/?type=post&s=%s';
const ButtonListURL = 'https://susuifa.com/wp-json/b2/v1/getDownloadData?post_id=%s&guest=';
const ButtonDetailURL = 'https://susuifa.com/wp-json/b2/v1/getDownloadPageData?post_id=%s&index=0&i=%d&guest=';
const MaxRetries = 0;
const MaxConcurrency = 100;
const CacheTTL = 1 * 60 * 60 * 1000; // 缓存有效期：1小时

// 常用UA列表
const userAgents: string[] = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:120.0) Gecko/20100101 Firefox/120.0',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
];

// 缓存项结构
interface CacheItem<T> {
  value: T;
  timestamp: number;
}

// 缓存管理
class CacheManager {
  private caches: Map<string, Map<string, CacheItem<any>>> = new Map();

  constructor() {
    // 初始化各种缓存
    this.caches.set('postID', new Map());
    this.caches.set('buttonList', new Map());
    this.caches.set('buttonDetail', new Map());
    this.caches.set('jwtDecode', new Map());
    this.caches.set('linkType', new Map());

    // 启动缓存清理定时器
    this.startCacheCleaner();
  }

  // 启动缓存清理定时器
  private startCacheCleaner() {
    setInterval(() => {
      const now = Date.now();
      this.caches.forEach((cache, cacheName) => {
        cache.forEach((item, key) => {
          if (now - item.timestamp > CacheTTL) {
            cache.delete(key);
          }
        });
      });
    }, CacheTTL);
  }

  // 获取缓存
  get<T>(cacheName: string, key: string): T | null {
    const cache = this.caches.get(cacheName);
    if (!cache) return null;

    const item = cache.get(key);
    if (!item) return null;

    // 检查缓存是否过期
    if (Date.now() - item.timestamp > CacheTTL) {
      cache.delete(key);
      return null;
    }

    return item.value;
  }

  // 设置缓存
  set<T>(cacheName: string, key: string, value: T): void {
    let cache = this.caches.get(cacheName);
    if (!cache) {
      cache = new Map();
      this.caches.set(cacheName, cache);
    }

    cache.set(key, {
      value,
      timestamp: Date.now()
    });
  }

  // 清空所有缓存
  clearAll(): void {
    this.caches.forEach(cache => {
      cache.clear();
    });
  }
}

// 创建全局缓存实例
const cacheManager = new CacheManager();

// 获取随机UA
function getRandomUA(): string {
  return userAgents[Math.floor(Math.random() * userAgents.length)];
}

// 简化的MD5哈希函数（用于缓存键生成）
function md5sum(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = h * 31 + s.charCodeAt(i);
  }
  return h;
}

// 按钮详情响应结构
interface ButtonDetailResponse {
  button: {
    name: string;
    url: string;
  };
}

// JWT Payload结构
interface JWTPayload {
  data: {
    url: string;
  };
}

// 信号量类
class Semaphore {
  private count: number;
  private queue: ((value: void) => void)[] = [];

  constructor(initialCount: number) {
    this.count = initialCount;
  }

  async acquire(): Promise<void> {
    if (this.count > 0) {
      this.count--;
      return;
    }

    return new Promise<void>(resolve => {
      this.queue.push(resolve);
    });
  }

  release(): void {
    this.count++;
    if (this.queue.length > 0) {
      const resolve = this.queue.shift()!;
      resolve();
    }
  }
}

// SusuPlugin Susu网站搜索插件
class SusuPlugin {
  private client: AxiosInstance;
  private MainCacheKey: string;
  private name: string;

  constructor() {
    this.client = axios.create({
      timeout: 10000,
      headers: {
        'User-Agent': getRandomUA(),
        'Referer': 'https://susuifa.com/',
        'Content-Type': 'application/json',
      },
      httpsAgent: new (require('https').Agent)({
        rejectUnauthorized: false
      })
    });

    this.MainCacheKey = 'susu';
    this.name = 'susu';
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
    const results = await searchImpl(this.client, keyword, ext);
    
    return {
      Results: results,
      IsFinal: true,
      CacheKey: cacheKey
    };
  }

  // searchImpl 实际的搜索实现
  private async searchImpl(client: AxiosInstance, keyword: string, ext: Record<string, any>): Promise<SearchResult[]> {
    // 构建搜索URL
    const searchURL = SearchURL.replace('%s', encodeURIComponent(keyword));
    
    // 创建请求配置
    const requestConfig: AxiosRequestConfig = {
      method: 'GET',
      url: searchURL,
      headers: {
        'User-Agent': getRandomUA(),
        'Referer': 'https://susuifa.com/'
      }
    };
    
    // 发送请求（带重试）
    let response;
    try {
      response = await this.doRequestWithRetry(client, requestConfig, MaxRetries);
    } catch (err) {
      throw new Error(`[${this.Name()}] 请求失败: ${err instanceof Error ? err.message : String(err)}`);
    }
    
    // 解析HTML
    const $ = cheerio.load(response.data);
    
    // 预先收集所有需要处理的项
    const items: cheerio.Cheerio[] = [];
    
    // 将关键词转为小写，用于不区分大小写的比较
    const lowerKeyword = keyword.toLowerCase();
    
    // 将关键词按空格分割，用于支持多关键词搜索
    const keywords = lowerKeyword.split(/\s+/);
    
    // 预先过滤不包含关键词的帖子
    $('.post-list-item').each((i, element) => {
      const s = $(element);
      
      // 提取标题
      const title = s.find('.post-info h2 a').text().trim();
      const lowerTitle = title.toLowerCase();
      
      // 检查每个关键词是否在标题中
      let matched = true;
      for (const kw of keywords) {
        if (!lowerTitle.includes(kw)) {
          matched = false;
          break;
        }
      }
      
      // 只添加匹配的帖子
      if (matched) {
        items.push(s);
      }
    });
    
    // 并发处理每个搜索结果项
    const semaphore = new Semaphore(MaxConcurrency);
    const resultPromises = items.map(async (s, index) => {
      await semaphore.acquire();
      
      try {
        // 提取帖子ID
        const postID = this.extractPostID(s);
        if (postID === '') {
          return null;
        }
        
        // 提取标题
        const title = s.find('.post-info h2 a').text().trim();
        
        // 提取内容描述
        const content = s.find('.post-excerpt').text().trim();
        
        // 提取日期时间
        const datetimeStr = s.find('.list-footer time.b2timeago').attr('datetime') || '';
        let datetime = new Date(0);
        if (datetimeStr) {
          const parsedTime = new Date(datetimeStr);
          if (!isNaN(parsedTime.getTime())) {
            datetime = parsedTime;
          }
        }
        
        // 提取分类标签
        const tags: string[] = [];
        s.find('.post-list-cat-item').each((i, t) => {
          const tag = $(t).text().trim();
          if (tag !== '') {
            tags.push(tag);
          }
        });
        
        // 获取网盘链接
        let links: Link[] = [];
        try {
          links = await this.getLinks(client, postID);
        } catch (err) {
          // 如果获取链接失败，仍然返回结果，但没有链接
          links = [];
        }
        
        // 创建搜索结果
        const result: SearchResult = {
          MessageID: `susu-${postID}`,
          UniqueID: `susu-${postID}`,
          Title: title,
          Content: content,
          Datetime: datetime,
          Links: links,
          Tags: tags,
          Channel: '',
        };
        
        return result;
      } finally {
        semaphore.release();
      }
    });
    
    // 等待所有处理完成
    const results = await Promise.all(resultPromises);
    
    // 过滤掉null结果
    return results.filter(result => result !== null) as SearchResult[];
  }

  // extractPostID 从搜索结果项中提取帖子ID
  private extractPostID(s: cheerio.Cheerio): string {
    // 生成缓存键
    const html = s.html() || '';
    const cacheKey = `postid:${md5sum(html).toString(16)}`;
    
    // 检查缓存
    const cachedID = cacheManager.get<string>('postID', cacheKey);
    if (cachedID) {
      return cachedID;
    }
    
    // 方法1：从列表项ID属性提取
    const itemID = s.attr('id');
    if (itemID && itemID.startsWith('item-')) {
      const postID = itemID.replace(/^item-/, '');
      cacheManager.set('postID', cacheKey, postID);
      return postID;
    }
    
    // 方法2：从详情页链接提取
    const href = s.find('.post-info h2 a').attr('href');
    if (href) {
      const match = href.match(/\/(\d+)\.html/);
      if (match && match.length > 1) {
        const postID = match[1];
        cacheManager.set('postID', cacheKey, postID);
        return postID;
      }
    }
    
    return '';
  }

  // getLinks 获取网盘链接
  private async getLinks(client: AxiosInstance, postID: string): Promise<Link[]> {
    // 检查缓存
    const cachedLinks = cacheManager.get<Link[]>('buttonList', postID);
    if (cachedLinks) {
      return cachedLinks;
    }
    
    // 直接并发发送6个请求，而不是先获取按钮列表
    const buttonCount = 6;
    
    // 创建信号量控制并发数
    const semaphore = new Semaphore(MaxConcurrency);
    
    // 创建获取按钮详情的Promise数组
    const buttonDetailPromises = Array.from({ length: buttonCount }, async (_, index) => {
      await semaphore.acquire();
      
      try {
        return await this.getButtonDetail(client, postID, index);
      } catch (err) {
        return null;
      } finally {
        semaphore.release();
      }
    });
    
    // 等待所有请求完成
    const buttonDetails = await Promise.all(buttonDetailPromises);
    
    // 过滤掉null结果
    const links = buttonDetails.filter(link => link !== null && link.URL !== '') as Link[];
    
    // 缓存结果
    cacheManager.set('buttonList', postID, links);
    
    return links;
  }

  // getButtonDetail 获取按钮详情
  private async getButtonDetail(client: AxiosInstance, postID: string, index: number): Promise<Link | null> {
    // 生成缓存键
    const cacheKey = `${postID}:${index}`;
    
    // 检查缓存
    const cachedLink = cacheManager.get<Link>('buttonDetail', cacheKey);
    if (cachedLink) {
      return cachedLink;
    }
    
    // 构建获取按钮详情的URL
    const buttonDetailURL = ButtonDetailURL.replace('%s', postID).replace('%d', index.toString());
    
    // 创建请求配置
    const requestConfig: AxiosRequestConfig = {
      method: 'POST',
      url: buttonDetailURL,
      headers: {
        'User-Agent': getRandomUA(),
        'Referer': `https://susuifa.com/download?post_id=${postID}&index=0&i=${index}`,
        'Content-Type': 'application/json',
      }
    };
    
    // 发送请求（带重试）
    let response;
    try {
      response = await this.doRequestWithRetry(client, requestConfig, MaxRetries);
    } catch (err) {
      return null;
    }
    
    // 解析响应
    const buttonDetail: ButtonDetailResponse = response.data;
    
    // 如果URL为空
    if (!buttonDetail.button.url) {
      return null;
    }
    
    // 解析JWT token获取真实链接
    let realURL;
    try {
      realURL = await this.decodeJWTURL(buttonDetail.button.url);
    } catch (err) {
      return null;
    }
    
    // 创建链接
    const link: Link = {
      URL: realURL,
      Type: this.determineLinkType(realURL, buttonDetail.button.name),
      Password: '',
    };
    
    // 缓存结果
    cacheManager.set('buttonDetail', cacheKey, link);
    
    return link;
  }

  // decodeJWTURL 解析JWT token获取真实链接
  private async decodeJWTURL(jwtToken: string): Promise<string> {
    // 检查缓存
    const cachedURL = cacheManager.get<string>('jwtDecode', jwtToken);
    if (cachedURL) {
      return cachedURL;
    }
    
    // 分割JWT
    const parts = jwtToken.split('.');
    if (parts.length !== 3) {
      throw new Error('无效的JWT格式');
    }
    
    // 解码Payload
    let payload;
    try {
      // 添加适当的填充
      const payloadPart = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      const padding = '='.repeat((4 - (payloadPart.length % 4)) % 4);
      payload = Buffer.from(payloadPart + padding, 'base64').toString('utf8');
    } catch (err) {
      throw new Error('解码Payload失败');
    }
    
    // 解析JSON
    let payloadData;
    try {
      payloadData = JSON.parse(payload) as JWTPayload;
    } catch (err) {
      throw new Error('解析Payload JSON失败');
    }
    
    // 缓存结果
    cacheManager.set('jwtDecode', jwtToken, payloadData.data.url);
    
    return payloadData.data.url;
  }

  // determineLinkType 根据URL和名称确定链接类型
  private determineLinkType(url: string, name: string): string {
    // 生成缓存键
    const cacheKey = `${url}:${name}`;
    
    // 检查缓存
    const cachedType = cacheManager.get<string>('linkType', cacheKey);
    if (cachedType) {
      return cachedType;
    }
    
    const lowerURL = url.toLowerCase();
    const lowerName = name.toLowerCase();
    
    let linkType: string;
    
    // 根据URL判断
    switch (true) {
      case lowerURL.includes('pan.baidu.com'):
        linkType = 'baidu';
        break;
      case lowerURL.includes('alipan.com') || lowerURL.includes('aliyundrive.com'):
        linkType = 'aliyun';
        break;
      case lowerURL.includes('pan.xunlei.com'):
        linkType = 'xunlei';
        break;
      case lowerURL.includes('pan.quark.cn'):
        linkType = 'quark';
        break;
      case lowerURL.includes('cloud.189.cn'):
        linkType = 'tianyi';
        break;
      case lowerURL.includes('115.com'):
        linkType = '115';
        break;
      case lowerURL.includes('drive.uc.cn'):
        linkType = 'uc';
        break;
      case lowerURL.includes('caiyun.139.com'):
        linkType = 'mobile';
        break;
      case lowerURL.includes('123pan.com'):
        linkType = '123';
        break;
      case lowerURL.includes('mypikpak.com'):
        linkType = 'pikpak';
        break;
      default:
        // 根据名称判断
        switch (true) {
          case lowerName.includes('百度'):
            linkType = 'baidu';
            break;
          case lowerName.includes('阿里'):
            linkType = 'aliyun';
            break;
          case lowerName.includes('迅雷'):
            linkType = 'xunlei';
            break;
          case lowerName.includes('夸克'):
            linkType = 'quark';
            break;
          case lowerName.includes('天翼'):
            linkType = 'tianyi';
            break;
          case lowerName.includes('115'):
            linkType = '115';
            break;
          case lowerName.includes('uc'):
            linkType = 'uc';
            break;
          case lowerName.includes('移动') || lowerName.includes('彩云'):
            linkType = 'mobile';
            break;
          case lowerName.includes('123'):
            linkType = '123';
            break;
          case lowerName.includes('pikpak'):
            linkType = 'pikpak';
            break;
          default:
            linkType = 'others';
            break;
        }
        break;
    }
    
    // 缓存结果
    cacheManager.set('linkType', cacheKey, linkType);
    
    return linkType;
  }

  // doRequestWithRetry 发送HTTP请求并支持重试
  private async doRequestWithRetry(client: AxiosInstance, config: AxiosRequestConfig, maxRetries: number): Promise<any> {
    let lastErr: Error | null = null;
    
    for (let i = 0; i <= maxRetries; i++) {
      // 如果不是第一次尝试，等待一段时间
      if (i > 0) {
        // 指数退避算法
        const backoff = Math.min(2 ** (i - 1) * 500, 5000);
        await new Promise(resolve => setTimeout(resolve, backoff));
      }
      
      try {
        // 发送请求
        const response = await client.request(config);
        return response;
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error(String(err));
        
        // 如果是不可重试的错误，则退出循环
        if (!this.isRetriableError(lastErr)) {
          break;
        }
      }
    }
    
    throw lastErr || new Error('请求失败');
  }

  // isRetriableError 判断错误是否可以重试
  private isRetriableError(err: Error): boolean {
    if (!err) return false;
    
    const errStr = err.message.toLowerCase();
    return errStr.includes('connection refused') ||
           errStr.includes('connection reset') ||
           errStr.includes('eof') ||
           errStr.includes('timeout') ||
           errStr.includes('temporary error');
  }
}

// 创建并导出插件实例
export default new SusuPlugin();