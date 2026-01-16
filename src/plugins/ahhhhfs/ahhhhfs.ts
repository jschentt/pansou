import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import cheerio from 'cheerio';
import { SearchResult, Link } from '../../types';
import { Plugin } from '../../types/plugin';


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
  /提取码[：:]:?\s*([0-9a-zA-Z]+)/,
  /密码[：:]:?\s*([0-9a-zA-Z]+)/,
  /pwd[=:：]:?\s*([0-9a-zA-Z]+)/,
  /code[=:：]:?\s*([0-9a-zA-Z]+)/,
];

// 缓存相关
interface DetailCacheEntry {
  links: Link[];
  timestamp: number;
}

const pluginName = 'ahhhhfs';
const defaultPriority = 2;
const DefaultTimeout = 10000; // 10 seconds
const DetailTimeout = 8000; // 8 seconds
const MaxConcurrency = 15;
const cacheTTL = 3600000; // 1 hour

// 性能统计
let searchRequests = 0;
let detailPageRequests = 0;
let cacheHits = 0;
let cacheMisses = 0;

class AhhhhfsPlugin implements Plugin {
  private detailCache: Map<string, DetailCacheEntry>;
  private client: AxiosInstance;

  constructor() {
    this.detailCache = new Map();
    this.client = axios.create({
      timeout: DefaultTimeout,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });

    // 启动缓存清理定时器
    this.startCacheCleaner();
  }

  name(): string {
    return pluginName;
  }

  displayName(): string {
    return 'ahhhhfs';
  }

  description(): string {
    return 'ahhhhfs - 网盘资源搜索';
  }

  async search(keyword: string, ext: Record<string, any>): Promise<SearchResult[]> {
    return this.searchImpl(keyword, ext);
  }

  private async searchImpl(keyword: string, ext: Record<string, any>): Promise<SearchResult[]> {
    const startTime = Date.now();
    searchRequests++;

    try {
      // 1. 构建搜索URL
      const searchURL = `https://www.ahhhhfs.com/?cat=&s=${encodeURIComponent(keyword)}`;

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
      const semaphore = this.createSemaphore(MaxConcurrency);

      const promises = [];

      $('article.post-item.item-list').each((i, s) => {
        const promise = async () => {
          await semaphore.acquire();
          try {
            // 解析基本信息
            const titleElem = $(s).find('.entry-title a');
            let title = titleElem.text().trim();
            if (title === '') {
              title = titleElem.attr('title')?.trim() || '';
            }

            const detailURL = titleElem.attr('href');
            if (!detailURL || title === '') {
              return;
            }

            // 提取文章ID
            const articleID = this.extractArticleID(detailURL);
            if (articleID === '') {
              return;
            }

            // 提取分类标签
            const tags: string[] = [];
            $(s).find('.entry-cat-dot a').each((j, tag) => {
              const tagText = $(tag).text().trim();
              if (tagText) {
                tags.push(tagText);
              }
            });

            // 提取描述
            const content = $(s).find('.entry-desc').text().trim();

            // 提取时间
            let datetime = '';
            const timeElem = $(s).find('.entry-meta .meta-date time');
            if (timeElem.attr('datetime')) {
              datetime = timeElem.attr('datetime') || '';
            } else {
              datetime = timeElem.text().trim();
            }

            // 解析时间
            const publishTime = this.parseDateTime(datetime);

            // 获取网盘链接
            const links = await this.fetchDetailLinks(detailURL, articleID);

            if (links.length > 0) {
              const result: SearchResult = {
                uniqueId: `${this.name()}-${articleID}`,
                title: title,
                content: content,
                datetime: publishTime,
                links: links,
                channel: '',
                tags: tags,
                images: [],
                pluginName: this.name(),
                displayName: this.displayName()
              };

              results.push(result);
            }
          } catch (error) {
            console.error(`[${this.name()}] 处理搜索结果失败:`, error);
          } finally {
            semaphore.release();
          }
        };

        promises.push(promise());
      });

      // 等待所有详情页请求完成
      await Promise.all(promises);

      console.log(`[${this.name()}] 搜索结果: ${results.length} 条`);
      console.log(`[${this.name()}] 搜索耗时: ${Date.now() - startTime}ms`);

      // 关键词过滤
      return this.filterResultsByKeyword(results, keyword);
    } catch (error) {
      console.error(`[${this.name()}] 搜索失败:`, error);
      return [];
    }
  }

  private extractArticleID(detailURL: string): string {
    const matches = articleIDRegex.exec(detailURL);
    if (matches && matches[1]) {
      return matches[1];
    }
    return '';
  }

  private parseDateTime(datetime: string): Date {
    datetime = datetime.trim();

    // 尝试解析 ISO 格式
    const isoDate = new Date(datetime);
    if (!isNaN(isoDate.getTime())) {
      return isoDate;
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

  private async fetchDetailLinks(detailURL: string, articleID: string): Promise<Link[]> {
    detailPageRequests++;

    // 检查缓存
    const cached = this.getFromCache(articleID);
    if (cached) {
      return cached;
    }

    try {
      // 发送请求
      const config: AxiosRequestConfig = {
        method: 'GET',
        url: detailURL,
        headers: this.getDetailHeaders(),
        timeout: DetailTimeout
      };

      const resp = await this.doRequestWithRetry(config);

      // 解析详情页
      const $ = cheerio.load(resp.data);

      // 提取网盘链接
      const links = this.extractNetDiskLinks($);

      // 缓存结果
      if (links.length > 0) {
        this.cacheResult(articleID, links);
      }

      return links;
    } catch (error) {
      console.error(`[${this.name()}] 详情页请求失败:`, error);
      return [];
    }
  }

  private extractNetDiskLinks($: cheerio.Root): Link[] {
    const links: Link[] = [];
    const linkMap = new Map<string, Link>(); // 用于去重

    // 在文章内容中查找所有链接
    $('.post-content a').each((i, s) => {
      const href = $(s).attr('href');
      if (!href) {
        return;
      }

      // 判断是否为网盘链接
      const cloudType = this.determineCloudType(href);
      if (cloudType === 'others') {
        return;
      }

      // 提取提取码
      const password = this.extractPassword($(s), href);

      // 添加到结果（去重）
      if (!linkMap.has(href)) {
        const link: Link = {
          url: href,
          type: cloudType,
          password: password
        };
        linkMap.set(href, link);
        links.push(link);
      }
    });

    return links;
  }

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
      case url.includes('115.com'):
        return '115';
      case url.includes('123pan.com'):
        return '123';
      case url.includes('mypikpak.com'):
        return 'pikpak';
      default:
        return 'others';
    }
  }

  private extractPassword(linkElem: cheerio.Cheerio, url: string): string {
    // 1. 从链接的 title 属性中提取
    const title = linkElem.attr('title');
    if (title) {
      for (const pattern of pwdPatterns) {
        const matches = pattern.exec(title);
        if (matches && matches[1]) {
          return matches[1];
        }
      }
    }

    // 2. 从链接文本中提取
    const linkText = linkElem.text();
    for (const pattern of pwdPatterns) {
      const matches = pattern.exec(linkText);
      if (matches && matches[1]) {
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
        const matches = pattern.exec(afterText);
        if (matches && matches[1]) {
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

  private getSearchHeaders(): Record<string, string> {
    return {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'Connection': 'keep-alive',
      'Upgrade-Insecure-Requests': '1',
      'Cache-Control': 'max-age=0',
      'Referer': 'https://www.ahhhhfs.com/'
    };
  }

  private getDetailHeaders(): Record<string, string> {
    return {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'Referer': 'https://www.ahhhhfs.com/'
    };
  }

  private async doRequestWithRetry(config: AxiosRequestConfig): Promise<any> {
    const maxRetries = 3;
    let lastError: any;

    for (let i = 0; i < maxRetries; i++) {
      if (i > 0) {
        // 指数退避重试
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

  private getFromCache(articleID: string): Link[] | null {
    const cached = this.detailCache.get(articleID);
    if (cached && Date.now() < cached.timestamp + cacheTTL) {
      cacheHits++;
      return cached.links;
    }
    cacheMisses++;
    return null;
  }

  private cacheResult(articleID: string, links: Link[]): void {
    this.detailCache.set(articleID, {
      links: links,
      timestamp: Date.now()
    });
  }

  private startCacheCleaner(): void {
    setInterval(() => {
      const now = Date.now();
      this.detailCache.forEach((value, key) => {
        if (now > value.timestamp + cacheTTL) {
          this.detailCache.delete(key);
        }
      });
    }, 30 * 60 * 1000); // 每30分钟清理一次
  }
}

// 导出插件实例
const plugin = new AhhhhfsPlugin();
export default plugin;