import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import { SearchResult, Link } from '../../types';
import { Plugin } from '../../types/plugin';

// 预编译的正则表达式（性能优化）
const quarkLinkRegex = /https?:\/\/pan\.quark\.cn\/s\/[0-9a-zA-Z]+/;
const ucLinkRegex = /https?:\/\/drive\.uc\.cn\/s\/[0-9a-zA-Z]+/;
const baiduLinkRegex = /https?:\/\/pan\.baidu\.com\/s\/[0-9a-zA-Z_\-]+/;
const aliyunLinkRegex = /https?:\/\/(www\.)?(aliyundrive\.com|alipan\.com)\/s\/[0-9a-zA-Z]+/;
const xunleiLinkRegex = /https?:\/\/pan\.xunlei\.com\/s\/[0-9a-zA-Z_\-]+/;
const tianyiLinkRegex = /https?:\/\/cloud\.189\.cn\/t\/[0-9a-zA-Z]+/;
const link115Regex = /https?:\/\/115\.com\/s\/[0-9a-zA-Z]+/;
const mobileLinkRegex = /https?:\/\/(caiyun\.feixin\.10086\.cn|caiyun\.139\.com|yun\.139\.com|cloud\.139\.com|pan\.139\.com)\/.*;/;
const link123Regex = /https?:\/\/123pan\.com\/s\/[0-9a-zA-Z]+/;
const pikpakLinkRegex = /https?:\/\/mypikpak\.com\/s\/[0-9a-zA-Z]+/;
const magnetLinkRegex = /magnet:\?xt=urn:btih:[0-9a-fA-F]{40}/;
const ed2kLinkRegex = /ed2k:\/\/\|file\|.+\|\d+\|[0-9a-fA-F]{32}\|\//;

// HTML标签清理
const htmlTagRegex = /<[^>]*>/g;
const whitespaceRegex = /\s+/g;

// CygPost 搜索结果结构体
interface CygPost {
  id: number;
  date: string;
  title: {
    rendered: string;
  };
  excerpt: {
    rendered: string;
  };
  link: string;
  category_name: string;
  author_name: string;
  pageviews: number;
  like_count: number;
}

// CygDownload 下载链接结构体
interface CygDownload {
  name: string;        // 网盘类型名称
  url: string;         // 网盘链接
  downloadPwd: string; // 提取密码
  extractPwd: string;  // 解压密码
  id: string;          // 链接ID
}

// CygSearchOptions 搜索选项
interface CygSearchOptions {
  perPage: number; // 每页结果数 (默认: 20)
  page: number;    // 页码 (默认: 1)
  orderBy: string; // 排序字段 (默认: date)
  order: string;   // 排序方向 (默认: desc)
}

const pluginName = 'cyg';
const defaultPriority = 3;

class CygPlugin implements Plugin {
  private client: AxiosInstance;

  constructor() {
    this.client = axios.create({
      timeout: 30000,
      headers: {
        'Referer': 'https://h5.acgn.my/',
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Connection': 'keep-alive'
      }
    });
  }

  name(): string {
    return pluginName;
  }

  displayName(): string {
    return 'cyg';
  }

  description(): string {
    return 'cyg - 网盘资源搜索';
  }

  async search(keyword: string, ext: Record<string, any>): Promise<SearchResult[]> {
    return this.searchImpl(keyword, ext);
  }

  private async searchImpl(keyword: string, ext: Record<string, any>): Promise<SearchResult[]> {
    // 解析扩展参数
    const opts = this.parseExtOptions(ext);

    // 1. 构建搜索URL
    const searchURL = `https://cyg.app/wp-json/wp/v2/posts?per_page=${opts.perPage}&orderby=${opts.orderBy}&order=${opts.order}&page=${opts.page}&search=${encodeURIComponent(keyword)}`;

    // 2. 发送搜索请求
    const posts = await this.fetchSearchResults(searchURL);

    if (posts.length === 0) {
      return [];
    }

    // 3. 并发获取每个帖子的下载链接
    const results = await this.fetchDownloadLinksAsync(posts, keyword);

    // 4. 关键词过滤
    const filteredResults = this.filterResultsByKeyword(results, keyword);

    return filteredResults;
  }

  private async fetchSearchResults(searchURL: string): Promise<CygPost[]> {
    const config: AxiosRequestConfig = {
      method: 'GET',
      url: searchURL,
      headers: this.setRequestHeaders()
    };

    try {
      const resp = await this.doRequestWithRetry(config);
      if (resp.status === 200) {
        return resp.data;
      }
      throw new Error(`HTTP错误状态码: ${resp.status}`);
    } catch (error) {
      console.error('[cyg] 搜索请求失败:', error);
      return [];
    }
  }

  private async fetchDownloadLinksAsync(posts: CygPost[], keyword: string): Promise<SearchResult[]> {
    // 限制并发数量
    const semaphore = this.createSemaphore(10); // 最多10个并发
    const promises = posts.map(async (post) => {
      await semaphore.acquire();
      try {
        // 获取下载链接
        const links = await this.getDownloadLinks(post.id);
        
        // 只返回有效链接的结果
        if (links.length > 0) {
          return this.convertToSearchResult(post, links);
        }
        return null;
      } catch (error) {
        // 记录错误但不影响其他结果
        console.error(`[cyg] 获取下载链接失败 (${post.id}):`, error);
        return null;
      } finally {
        semaphore.release();
      }
    });

    // 等待所有请求完成
    const results = await Promise.all(promises);

    // 过滤掉null结果
    return results.filter((result): result is SearchResult => result !== null);
  }

  private async getDownloadLinks(postID: number): Promise<Link[]> {
    // 构建下载链接获取URL
    const downloadURL = `https://cyg.app/wp-json/acg-studio/v1/download?id=${postID}`;

    const config: AxiosRequestConfig = {
      method: 'GET',
      url: downloadURL,
      headers: this.setRequestHeaders()
    };

    try {
      const resp = await this.doRequestWithRetry(config);
      if (resp.status === 200) {
        const downloadData: CygDownload[] = resp.data;
        return this.convertToLinks(downloadData);
      }
      throw new Error(`下载链接请求状态码: ${resp.status}`);
    } catch (error) {
      console.error(`[cyg] 下载链接请求失败 (${postID}):`, error);
      return [];
    }
  }

  private convertToSearchResult(post: CygPost, links: Link[]): SearchResult {
    return {
      uniqueId: `cyg-${post.id}`,
      title: this.cleanHTML(post.title.rendered),
      content: this.cleanHTML(post.excerpt.rendered),
      datetime: this.parseDateTime(post.date),
      tags: [post.category_name],
      links: links,
      channel: '', // 插件搜索结果必须为空字符串
      images: [],
      pluginName: this.name(),
      displayName: this.displayName()
    };
  }

  private convertToLinks(downloadData: CygDownload[]): Link[] {
    const links: Link[] = [];
    for (const item of downloadData) {
      // 优先使用URL模式匹配，fallback到名称映射
      let linkType = this.determineCloudTypeByURL(item.url);
      if (linkType === 'others') {
        linkType = this.determineCloudType(item.name);
      }

      const link: Link = {
        type: linkType,
        url: item.url,
        password: item.downloadPwd // 提取密码
      };
      links.push(link);
    }
    return links;
  }

  private determineCloudTypeByURL(url: string): string {
    if (quarkLinkRegex.test(url)) return 'quark';
    if (ucLinkRegex.test(url)) return 'uc';
    if (baiduLinkRegex.test(url)) return 'baidu';
    if (aliyunLinkRegex.test(url)) return 'aliyun';
    if (xunleiLinkRegex.test(url)) return 'xunlei';
    if (tianyiLinkRegex.test(url)) return 'tianyi';
    if (link115Regex.test(url)) return '115';
    if (mobileLinkRegex.test(url)) return 'mobile';
    if (link123Regex.test(url)) return '123';
    if (pikpakLinkRegex.test(url)) return 'pikpak';
    if (magnetLinkRegex.test(url)) return 'magnet';
    if (ed2kLinkRegex.test(url)) return 'ed2k';
    return 'others';
  }

  private determineCloudType(name: string): string {
    const lowerName = name.toLowerCase().trim();
    switch (lowerName) {
      case '夸克':
      case '夸克网盘':
        return 'quark';
      case 'uc':
      case 'uc网盘':
        return 'uc';
      case '百度网盘':
      case '百度':
      case 'baidu':
        return 'baidu';
      case '阿里云盘':
      case '阿里':
      case 'aliyun':
      case '阿里网盘':
        return 'aliyun';
      case '迅雷':
      case '迅雷网盘':
      case 'xunlei':
        return 'xunlei';
      case '天翼':
      case '天翼云盘':
      case '189':
      case '189云盘':
        return 'tianyi';
      case '115':
      case '115网盘':
        return '115';
      case '移动云盘':
      case '移动':
      case 'mobile':
      case '和彩云':
      case '139云盘':
      case '139':
      case '中国移动云盘':
        return 'mobile';
      case '123网盘':
      case '123pan':
      case '123':
        return '123';
      case 'pikpak':
      case 'pikpak网盘':
        return 'pikpak';
      case '磁力链接':
      case 'magnet':
        return 'magnet';
      case 'ed2k':
        return 'ed2k';
      default:
        return 'others';
    }
  }

  private setRequestHeaders(): Record<string, string> {
    return {
      'Referer': 'https://h5.acgn.my/',
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'Connection': 'keep-alive'
    };
  }

  private async doRequestWithRetry(config: AxiosRequestConfig): Promise<any> {
    const maxRetries = 3;
    let lastErr: any;

    for (let i = 0; i < maxRetries; i++) {
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
      throw new Error(`重试 ${maxRetries} 次后仍然失败: ${lastErr}`);
    }

    throw new Error(`重试 ${maxRetries} 次后仍然失败`);
  }

  private parseExtOptions(ext: Record<string, any>): CygSearchOptions {
    const opts: CygSearchOptions = {
      perPage: 20,
      page: 1,
      orderBy: 'date',
      order: 'desc'
    };

    if (!ext) {
      return opts;
    }

    if (typeof ext.per_page === 'number' && ext.per_page > 0) {
      opts.perPage = ext.per_page;
    }

    if (typeof ext.page === 'number' && ext.page > 0) {
      opts.page = ext.page;
    }

    if (typeof ext.order_by === 'string' && ext.order_by) {
      opts.orderBy = ext.order_by;
    }

    if (typeof ext.order === 'string' && ext.order) {
      opts.order = ext.order;
    }

    return opts;
  }

  private cleanHTML(htmlContent: string): string {
    // 移除HTML标签
    let text = htmlContent.replace(htmlTagRegex, '');

    // 解码HTML实体
    text = this.decodeHTMLEntities(text);

    // 清理多余空白
    text = text.trim();

    // 替换多个空白字符为单个空格
    text = text.replace(whitespaceRegex, ' ');

    return text;
  }

  private decodeHTMLEntities(text: string): string {
    const entities: Record<string, string> = {
      '&amp;': '&',
      '&lt;': '<',
      '&gt;': '>',
      '&quot;': '"',
      '&apos;': "'",
      '&#39;': "'",
      '&nbsp;': ' '
    };

    return text.replace(/&[a-zA-Z#]+;/g, (match) => {
      return entities[match] || match;
    });
  }

  private parseDateTime(dateStr: string): Date {
    // 尝试解析ISO 8601格式
    const isoDate = new Date(dateStr);
    if (!isNaN(isoDate.getTime())) {
      return isoDate;
    }

    // 尝试解析其他常见格式
    const formats = [
      'YYYY-MM-DDTHH:mm:ss',
      'YYYY-MM-DD HH:mm:ss',
      'YYYY-MM-DD'
    ];

    for (const format of formats) {
      const parsedDate = this.parseDate(dateStr, format);
      if (!isNaN(parsedDate.getTime())) {
        return parsedDate;
      }
    }

    // 解析失败时返回当前时间
    return new Date();
  }

  private parseDate(dateStr: string, format: string): Date {
    // 简单的日期解析实现
    if (format === 'YYYY-MM-DDTHH:mm:ss') {
      const parts = dateStr.split('T');
      if (parts.length === 2) {
        const dateParts = parts[0].split('-');
        const timeParts = parts[1].split(':');
        if (dateParts.length === 3 && timeParts.length >= 2) {
          const year = parseInt(dateParts[0]);
          const month = parseInt(dateParts[1]) - 1;
          const day = parseInt(dateParts[2]);
          const hour = parseInt(timeParts[0]);
          const minute = parseInt(timeParts[1]);
          const second = timeParts.length >= 3 ? parseInt(timeParts[2]) : 0;
          return new Date(year, month, day, hour, minute, second);
        }
      }
    } else if (format === 'YYYY-MM-DD HH:mm:ss') {
      const parts = dateStr.split(' ');
      if (parts.length === 2) {
        const dateParts = parts[0].split('-');
        const timeParts = parts[1].split(':');
        if (dateParts.length === 3 && timeParts.length >= 2) {
          const year = parseInt(dateParts[0]);
          const month = parseInt(dateParts[1]) - 1;
          const day = parseInt(dateParts[2]);
          const hour = parseInt(timeParts[0]);
          const minute = parseInt(timeParts[1]);
          const second = timeParts.length >= 3 ? parseInt(timeParts[2]) : 0;
          return new Date(year, month, day, hour, minute, second);
        }
      }
    } else if (format === 'YYYY-MM-DD') {
      const parts = dateStr.split('-');
      if (parts.length === 3) {
        const year = parseInt(parts[0]);
        const month = parseInt(parts[1]) - 1;
        const day = parseInt(parts[2]);
        return new Date(year, month, day);
      }
    }

    return new Date(0);
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

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
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
const plugin = new CygPlugin();
export default plugin;