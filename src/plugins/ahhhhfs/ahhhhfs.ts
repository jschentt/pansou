import { BaseAsyncPlugin, registerGlobalPlugin } from '../plugin.manager';
import { AxiosInstance } from 'axios';
import { SearchResult, Link } from '../../models/response';
import axios from 'axios';
import * as cheerio from 'cheerio';

// 预编译的正则表达式
const articleIDRegex = /\/(\d+)\/?$/;

// 常见网盘链接的正则表达式
const quarkLinkRegex = /https?:\/\/pan\.quark\.cn\/s\/[0-9a-zA-Z]+/;
const baiduLinkRegex = /https?:\/\/pan\.baidu\.com\/s\/[0-9a-zA-Z_\-]+/;
const aliyunLinkRegex = /https?:\/\/(www\.)?(aliyundrive\.com|alipan\.com)\/s\/[0-9a-zA-Z]+/;
const ucLinkRegex = /https?:\/\/drive\.uc\.cn\/s\/[0-9a-zA-Z]+/;
const xunleiLinkRegex = /https?:\/\/pan\.xunlei\.com\/s\/[0-9a-zA-Z_\-]+/;
const tianyiLinkRegex = /https?:\/\/cloud\.189\.cn\/(t|web)\/[0-9a-zA-Z]+/;
const link115Regex = /https?:\/\/115\.com\/s\/[0-9a-zA-Z]+/;
const link123Regex = /https?:\/\/123pan\.com\/s\/[0-9a-zA-Z]+/;
const pikpakLinkRegex = /https?:\/\/mypikpak\.com\/s\/[0-9a-zA-Z]+/;

// 提取码匹配模式
const pwdPatterns = [
  /提取码[：:]\s*([0-9a-zA-Z]+)/,
  /密码[：:]\s*([0-9a-zA-Z]+)/,
  /pwd[=:：]\s*([0-9a-zA-Z]+)/,
  /code[=:：]\s*([0-9a-zA-Z]+)/,
];

const PLUGIN_NAME = 'ahhhhfs';
const DEFAULT_PRIORITY = 2;
const DEFAULT_TIMEOUT = 10000; // 10秒
const DETAIL_TIMEOUT = 8000; // 8秒
const MAX_CONCURRENCY = 15;

// HTTP连接池配置
const MAX_IDLE_CONNS = 100;
const MAX_IDLE_CONNS_PER_HOST = 30;
const MAX_CONNS_PER_HOST = 50;
const IDLE_CONN_TIMEOUT = 90000; // 90秒

// 缓存相关
const detailCache = new Map<string, Link[]>();
let lastCleanupTime = new Date();
const CACHE_TTL = 60 * 60 * 1000; // 1小时

// 性能统计
let searchRequests = 0;
let detailPageRequests = 0;
let cacheHits = 0;
let cacheMisses = 0;

// Ahhhhfs异步插件
class AhhhhfsAsyncPlugin extends BaseAsyncPlugin {
  private optimizedClient: AxiosInstance;

  constructor() {
    super(PLUGIN_NAME, DEFAULT_PRIORITY);
    this.optimizedClient = this.createOptimizedHTTPClient();
  }

  // 创建优化的HTTP客户端
  private createOptimizedHTTPClient(): AxiosInstance {
    return axios.create({
      timeout: DEFAULT_TIMEOUT,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
        'Cache-Control': 'max-age=0',
        'Referer': 'https://www.ahhhhfs.com/',
      },
    });
  }

  // Search 执行搜索
  async search(keyword: string, ext: Record<string, any>): Promise<SearchResult[]> {
    return this.asyncSearch(keyword, this.searchImpl, this.mainCacheKey, ext);
  }

  // 实现具体的搜索逻辑
  private async searchImpl(client: AxiosInstance, keyword: string, ext: Record<string, any>): Promise<SearchResult[]> {
    // 性能统计
    const start = Date.now();
    searchRequests++;
    
    try {
      // 使用优化的客户端
      if (this.optimizedClient) {
        client = this.optimizedClient;
      }

      // 1. 构建搜索URL
      const searchURL = `https://www.ahhhhfs.com/?cat=&s=${encodeURIComponent(keyword)}`;

      // 2. 发送请求（带重试机制）
      const resp = await this.doRequestWithRetry(client, searchURL);

      // 3. 解析搜索结果页面
      const $ = cheerio.load(resp.data);

      // 4. 提取搜索结果
      const results: SearchResult[] = [];
      const articleElements = $('article.post-item.item-list');
      
      // 使用并发控制
      const semaphore = new Semaphore(MAX_CONCURRENCY);
      const promises: Promise<void>[] = [];

      articleElements.each((i, s) => {
        const article = $(s);
        
        // 解析基本信息
        const titleElem = article.find('.entry-title a');
        let title = titleElem.text().trim();
        if (!title) {
          title = titleElem.attr('title')?.trim() || '';
        }
        
        const detailURL = titleElem.attr('href');
        if (!detailURL || !title) {
          return;
        }
        
        // 提取文章ID
        const articleID = this.extractArticleID(detailURL);
        if (!articleID) {
          return;
        }
        
        // 提取分类标签
        const tags: string[] = [];
        article.find('.entry-cat-dot a').each((j, tag) => {
          const tagText = $(tag).text().trim();
          if (tagText) {
            tags.push(tagText);
          }
        });
        
        // 提取描述
        const content = article.find('.entry-desc').text().trim();
        
        // 提取时间
        let datetime = '';
        const timeElem = article.find('.entry-meta .meta-date time');
        if (timeElem.attr('datetime')) {
          datetime = timeElem.attr('datetime') || '';
        } else {
          datetime = timeElem.text().trim();
        }
        
        // 解析时间
        const publishTime = this.parseDateTime(datetime);
        
        // 异步获取详情页的网盘链接
        promises.push(semaphore.acquire().then(async () => {
          try {
            // 获取网盘链接
            const links = await this.fetchDetailLinks(client, detailURL, articleID);
            
            if (links.length > 0) {
              const result: SearchResult = {
                uniqueId: `${this.name()}-${articleID}`,
                messageId: `${this.name()}-${articleID}`,
                title,
                content,
                links,
                tags,
                channel: '',
                datetime: publishTime.toISOString(),
              };
              results.push(result);
            }
          } finally {
            semaphore.release();
          }
        }));
      });

      // 等待所有详情页请求完成
      await Promise.all(promises);

      console.log(`[${this.name()}] 搜索结果: ${results.length} 条`);
      
      return results;
    } finally {
      console.log(`[${this.name()}] 搜索耗时: ${Date.now() - start}ms`);
    }
  }

  // 从URL中提取文章ID
  private extractArticleID(detailURL: string): string {
    const matches = detailURL.match(articleIDRegex);
    if (matches && matches.length >= 2) {
      return matches[1];
    }
    return '';
  }

  // 解析时间字符串
  private parseDateTime(datetime: string): Date {
    datetime = datetime.trim();
    
    // 尝试解析 ISO 格式
    const isoDate = new Date(datetime);
    if (!isNaN(isoDate.getTime())) {
      return isoDate;
    }
    
    // 尝试解析标准日期格式
    const layouts = [
      '2006-01-02',
      '2006-01-02 15:04:05',
      '2006-01-02T15:04:05',
      '2006-01-02T15:04:05Z07:00',
    ];
    
    for (const layout of layouts) {
      const date = new Date(datetime);
      if (!isNaN(date.getTime())) {
        return date;
      }
    }
    
    // 处理相对时间（如"1 周前"、"2 天前"）
    const now = new Date();
    
    if (datetime.includes('小时前') || datetime.includes('hours ago')) {
      // 简单处理，返回当天
      return now;
    }
    
    if (datetime.includes('天前') || datetime.includes('days ago')) {
      // 简单处理，返回近期
      return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    }
    
    if (datetime.includes('周前') || datetime.includes('weeks ago')) {
      // 简单处理，返回一个月前
      return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    }
    
    // 默认返回当前时间
    return now;
  }

  // 获取详情页的网盘链接
  private async fetchDetailLinks(client: AxiosInstance, detailURL: string, articleID: string): Promise<Link[]> {
    detailPageRequests++;
    
    // 检查缓存
    if (detailCache.has(articleID)) {
      cacheHits++;
      return detailCache.get(articleID)!;
    }
    
    cacheMisses++;
    
    try {
      // 创建带超时的请求
      const resp = await client.get(detailURL, { timeout: DETAIL_TIMEOUT });

      // 解析详情页
      const $ = cheerio.load(resp.data);

      // 提取网盘链接
      const links = this.extractNetDiskLinks($);

      // 缓存结果
      if (links.length > 0) {
        detailCache.set(articleID, links);
      }

      return links;
    } catch (error) {
      console.error(`[${this.name()}] 详情页请求失败: ${error}`);
      return [];
    }
  }

  // 从详情页提取网盘链接
  private extractNetDiskLinks($: cheerio.CheerioAPI): Link[] {
    const links: Link[] = [];
    const linkMap = new Map<string, Link>(); // 用于去重

    // 在文章内容中查找所有链接
    $('.post-content a').each((i, s) => {
      const linkElem = $(s);
      const href = linkElem.attr('href');
      if (!href) {
        return;
      }
      
      // 判断是否为网盘链接
      const cloudType = this.determineCloudType(href);
      if (cloudType === 'others') {
        return;
      }
      
      // 提取提取码
      const password = this.extractPassword(linkElem, href, $);
      
      // 添加到结果（去重）
      if (!linkMap.has(href)) {
        const link: Link = {
          type: cloudType,
          url: href,
          password,
        };
        linkMap.set(href, link);
        links.push(link);
      }
    });

    return links;
  }

  // 判断链接类型
  private determineCloudType(url: string): string {
    if (url.includes('pan.quark.cn')) {
      return 'quark';
    } else if (url.includes('drive.uc.cn')) {
      return 'uc';
    } else if (url.includes('pan.baidu.com')) {
      return 'baidu';
    } else if (url.includes('aliyundrive.com') || url.includes('alipan.com')) {
      return 'aliyun';
    } else if (url.includes('pan.xunlei.com')) {
      return 'xunlei';
    } else if (url.includes('cloud.189.cn')) {
      return 'tianyi';
    } else if (url.includes('115.com')) {
      return '115';
    } else if (url.includes('123pan.com')) {
      return '123';
    } else if (url.includes('mypikpak.com')) {
      return 'pikpak';
    } else {
      return 'others';
    }
  }

  // 提取提取码
  private extractPassword(linkElem: cheerio.Cheerio<any>, url: string, $: cheerio.CheerioAPI): string {
    // 1. 从链接的 title 属性中提取
    const title = linkElem.attr('title');
    if (title) {
      for (const pattern of pwdPatterns) {
        const matches = title.match(pattern);
        if (matches && matches.length >= 2) {
          return matches[1];
        }
      }
    }
    
    // 2. 从链接文本中提取
    const linkText = linkElem.text();
    for (const pattern of pwdPatterns) {
      const matches = linkText.match(pattern);
      if (matches && matches.length >= 2) {
        return matches[1];
      }
    }
    
    // 3. 从链接后面的兄弟节点或父节点的文本中提取
    const parent = linkElem.parent();
    const parentText = parent.text();
    
    // 获取链接在父元素文本中的位置
    const linkIndex = parentText.indexOf(linkText);
    if (linkIndex >= 0) {
      // 获取链接后面的文本
      const afterText = parentText.substring(linkIndex + linkText.length);
      for (const pattern of pwdPatterns) {
        const matches = afterText.match(pattern);
        if (matches && matches.length >= 2) {
          return matches[1];
        }
      }
    }
    
    // 4. 从 URL 参数中提取
    if (url.includes('pwd=')) {
      const parts = url.split('pwd=');
      if (parts.length >= 2) {
        let pwd = parts[1];
        // 只取密码部分（去除其他参数）
        const idx = pwd.search(/[&?#]/);
        if (idx >= 0) {
          pwd = pwd.substring(0, idx);
        }
        return pwd;
      }
    }
    
    return '';
  }

  // 带重试机制的HTTP请求
  private async doRequestWithRetry(client: AxiosInstance, url: string, maxRetries: number = 3): Promise<any> {
    let lastErr: any;

    for (let i = 0; i < maxRetries; i++) {
      if (i > 0) {
        // 指数退避重试
        const backoff = Math.pow(2, i - 1) * 200;
        await this.sleep(backoff);
      }
      
      try {
        const resp = await client.get(url);
        if (resp.status === 200) {
          return resp;
        }
      } catch (err) {
        lastErr = err;
      }
    }
    
    throw new Error(`重试 ${maxRetries} 次后仍然失败: ${lastErr}`);
  }

  // 休眠函数
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// 信号量实现
class Semaphore {
  private permits: number;
  private queue: (() => void)[] = [];

  constructor(permits: number) {
    this.permits = permits;
  }

  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--;
      return Promise.resolve();
    }

    return new Promise(resolve => {
      this.queue.push(resolve);
    });
  }

  release(): void {
    this.permits++;
    if (this.queue.length > 0) {
      const resolve = this.queue.shift()!;
      resolve();
    }
  }
}

// 启动缓存清理定时器
function startCacheCleaner() {
  setInterval(() => {
    // 清空所有缓存
    detailCache.clear();
    lastCleanupTime = new Date();
  }, 30 * 60 * 1000); // 每30分钟清理一次
}

// 创建并注册插件
const ahhhhfsPlugin = new AhhhhfsAsyncPlugin();
registerGlobalPlugin(ahhhhfsPlugin);

// 启动缓存清理
startCacheCleaner();

export type { AhhhhfsAsyncPlugin };

export const AhhhhfsAsyncPluginInstance = ahhhhfsPlugin;
