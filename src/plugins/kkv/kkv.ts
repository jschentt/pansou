import { BaseAsyncPlugin, registerGlobalPlugin } from '../plugin.manager';
import { SearchResult, Link } from '../../models/response';
import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import * as cheerio from 'cheerio';
import * as url from 'url';
import * as crypto from 'crypto';

const baseURL = "http://kkv.q-23.cn";
const searchPath = "/";
const maxResults = 10;
const maxConcurrent = 3;

let debugMode = false;

function debugPrintf(format: string, ...args: any[]): void {
  if (debugMode) {
    console.log(`[KKV DEBUG] ${format}`, ...args);
  }
}

// 搜索结果项接口
interface SearchItem {
  ID: string;
  Title: string;
  DetailURL: string;
}

// KKVPlugin 插件结构
class KKVPlugin extends BaseAsyncPlugin {
  private optimizedClient: AxiosInstance;

  constructor() {
    super("kkv", 3); // 普通质量插件，优先级3
    this.optimizedClient = this.createOptimizedHTTPClient();
  }

  // 创建优化的HTTP客户端
  private createOptimizedHTTPClient(): AxiosInstance {
    return axios.create({
      timeout: 30000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Connection': 'keep-alive',
      },
    });
  }

  // 搜索实现
  private async searchImpl(client: AxiosInstance, keyword: string, ext: Record<string, any>): Promise<SearchResult[]> {
    debugPrintf("🔍 开始搜索 - keyword: %s\n", keyword);
    const searchURL = `${baseURL}${searchPath}?s=${encodeURIComponent(keyword)}`;
    debugPrintf("📝 搜索URL: %s\n", searchURL);
    
    const items = await this.fetchSearchResults(client, searchURL);
    
    debugPrintf("✅ 获取到 %d 个搜索结果\n", items.length);
    
    if (items.length === 0) {
      debugPrintf("⚠️ 没有搜索结果\n");
      return [];
    }
    
    const filteredItems = this.filterItemsByKeyword(items, keyword);
    debugPrintf("🔎 标题过滤后剩余 %d 个结果（从 %d 个）\n", filteredItems.length, items.length);
    
    if (filteredItems.length === 0) {
      debugPrintf("⚠️ 标题过滤后没有匹配的结果\n");
      return [];
    }
    
    if (filteredItems.length > maxResults) {
      debugPrintf("✂️ 限制结果数量从 %d 到 %d\n", filteredItems.length, maxResults);
      filteredItems = filteredItems.slice(0, maxResults);
    }
    
    const results = await this.processDetailPages(client, filteredItems);
    debugPrintf("📊 处理完成，获得 %d 个有效结果\n", results.length);
    
    return results;
  }

  // 按关键词过滤搜索结果
  private filterItemsByKeyword(items: SearchItem[], keyword: string): SearchItem[] {
    const lowerKeyword = keyword.toLowerCase();
    const filtered: SearchItem[] = [];
    
    for (const item of items) {
      const lowerTitle = item.Title.toLowerCase();
      if (lowerTitle.includes(lowerKeyword)) {
        debugPrintf("✅ 标题匹配: %s\n", item.Title);
        filtered.push(item);
      } else {
        debugPrintf("❌ 标题不匹配，跳过: %s\n", item.Title);
      }
    }
    
    return filtered;
  }

  // 获取搜索结果
  private async fetchSearchResults(client: AxiosInstance, searchURL: string): Promise<SearchItem[]> {
    debugPrintf("🌐 请求搜索页面: %s\n", searchURL);
    
    try {
      const resp = await client.get(searchURL);
      debugPrintf("📡 HTTP状态码: %d\n", resp.status);
      
      if (resp.status !== 200) {
        throw new Error(`请求返回状态码: ${resp.status}`);
      }
      
      const $ = cheerio.load(resp.data);
      const items: SearchItem[] = [];
      
      $('article.post').each((i, s) => {
        const link = $(s).find('.entry-header h2.entry-title a');
        const href = link.attr('href') || '';
        if (!href) {
          debugPrintf("⚠️ 第%d个结果没有href属性\n", i + 1);
          return;
        }
        
        const title = link.text().trim();
        if (!title) {
          debugPrintf("⚠️ 第%d个结果标题为空\n", i + 1);
          return;
        }
        
        const re = /\?p=(\d+)/;
        const matches = re.exec(href);
        if (!matches || matches.length < 2) {
          debugPrintf("⚠️ 无法从href提取ID: %s\n", href);
          return;
        }
        
        const item: SearchItem = {
          ID: matches[1],
          Title: title,
          DetailURL: href,
        };
        debugPrintf("📌 找到影片: ID=%s, Title=%s\n", item.ID, item.Title);
        items.push(item);
      });
      
      debugPrintf("✅ 解析到 %d 个搜索项\n", items.length);
      return items;
    } catch (error) {
      debugPrintf("❌ 获取搜索结果失败: %v\n", error);
      throw error;
    }
  }

  // 处理详情页
  private async processDetailPages(client: AxiosInstance, items: SearchItem[]): Promise<SearchResult[]> {
    const results: SearchResult[] = [];
    const semaphore = new Semaphore(maxConcurrent);
    
    const promises = items.map(async (item) => {
      await semaphore.acquire();
      try {
        return await this.processDetailPage(client, item);
      } finally {
        semaphore.release();
      }
    });
    
    const processedResults = await Promise.all(promises);
    
    // 过滤掉null结果
    return processedResults.filter(result => result !== null) as SearchResult[];
  }

  // 处理单个详情页
  private async processDetailPage(client: AxiosInstance, item: SearchItem): Promise<SearchResult | null> {
    debugPrintf("🎬 处理详情页: %s (ID: %s)\n", item.Title, item.ID);
    
    try {
      const resp = await client.get(item.DetailURL);
      
      if (resp.status !== 200) {
        debugPrintf("❌ 详情页状态码: %d\n", resp.status);
        return null;
      }
      
      const $ = cheerio.load(resp.data);
      
      let title = $('.entry-header h1.entry-title').text().trim();
      if (!title) {
        title = item.Title;
      }
      debugPrintf("📝 影片标题: %s\n", title);
      
      let description = '';
      $('.entry-content p').first().each((i, s) => {
        description = $(s).text().trim();
        if (description.length > 200) {
          description = description.substring(0, 200) + '...';
        }
      });
      
      const updateTime = this.extractUpdateTime($);
      debugPrintf("🕐 更新时间: %v\n", updateTime);
      
      const panLinks = this.extractPanLinks($);
      if (panLinks.length === 0) {
        debugPrintf("❌ 未找到网盘链接\n");
        return null;
      }
      
      debugPrintf("✅ 找到 %d 个网盘链接\n", panLinks.length);
      
      const result = new SearchResult();
      result.uniqueID = `${this.pluginName}-${item.ID}`;
      result.title = title;
      result.content = description;
      result.links = panLinks;
      result.channel = '';
      result.datetime = updateTime;
      result.images = [];
      result.tags = [];
      
      return result;
    } catch (error) {
      debugPrintf("❌ 处理详情页失败: %v\n", error);
      return null;
    }
  }

  // 提取更新时间
  private extractUpdateTime($: cheerio.Root): Date {
    const timeStr = $('time.updated').attr('datetime') || '';
    if (!timeStr) {
      debugPrintf("⚠️ 未找到更新时间\n");
      return new Date();
    }
    
    debugPrintf("🔍 提取到时间字符串: %s\n", timeStr);
    
    const t = new Date(timeStr);
    if (isNaN(t.getTime())) {
      debugPrintf("❌ 时间解析失败: %s\n", timeStr);
      return new Date();
    }
    
    return t;
  }

  // 提取网盘链接
  private extractPanLinks($: cheerio.Root): Link[] {
    debugPrintf("🔎 开始提取网盘链接\n");
    const links: Link[] = [];
    
    $('.entry-content p').each((i, s) => {
      $(s).find('a').each((j, a) => {
        const href = $(a).attr('href') || '';
        if (!href) {
          return;
        }
        
        const trimmedHref = href.trim();
        const cloudType = this.determinePanType(trimmedHref);
        if (!cloudType) {
          return;
        }
        
        debugPrintf("🔗 找到%s链接: %s\n", cloudType, trimmedHref);
        
        const password = this.extractPassword(trimmedHref, $(s).text());
        debugPrintf("🔑 密码: %s\n", password);
        
        const link = new Link();
        link.type = cloudType;
        link.url = trimmedHref;
        link.password = password;
        
        links.push(link);
      });
    });
    
    debugPrintf("✅ 共提取到 %d 个网盘链接\n", links.length);
    return links;
  }

  // 确定网盘类型
  private determinePanType(panURL: string): string {
    const lower = panURL.toLowerCase();
    
    switch (true) {
      case lower.includes("pan.baidu.com"):
        return "baidu";
      case lower.includes("pan.quark.cn"):
        return "quark";
      case lower.includes("drive.uc.cn"):
        return "uc";
      case lower.includes("pan.xunlei.com"):
        return "xunlei";
      case lower.includes("aliyundrive.com") || lower.includes("alipan.com"):
        return "aliyun";
      case lower.includes("cloud.189.cn"):
        return "tianyi";
      case lower.includes("115.com") || lower.includes("115cdn.com") || lower.includes("anxia.com"):
        return "115";
      case lower.includes("123684.com") || lower.includes("123685.com") ||
           lower.includes("123912.com") || lower.includes("123pan.com") ||
           lower.includes("123pan.cn") || lower.includes("123592.com"):
        return "123";
      case lower.includes("caiyun.139.com"):
        return "mobile";
      case lower.includes("mypikpak.com"):
        return "pikpak";
      default:
        return "";
    }
  }

  // 提取密码
  private extractPassword(panURL: string, contextText: string): string {
    try {
      const parsed = new url.URL(panURL);
      const pwd = parsed.searchParams.get('pwd');
      if (pwd && pwd.length === 4) {
        return pwd;
      }
    } catch (error) {
      // URL解析失败，继续使用其他方法
    }
    
    const pwdPatterns = [
      /提取码[：:]\s*([a-zA-Z0-9]{4})/,
      /密码[：:]\s*([a-zA-Z0-9]{4})/,
      /pwd[：:]\s*([a-zA-Z0-9]{4})/,
    ];
    
    for (const pattern of pwdPatterns) {
      const matches = pattern.exec(contextText);
      if (matches && matches.length > 1) {
        return matches[1];
      }
    }
    
    return "";
  }

  // 设置请求头
  private setHeaders(config: AxiosRequestConfig, referer: string): void {
    config.headers = {
      ...config.headers,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'Connection': 'keep-alive',
      'Referer': referer,
    };
  }
}

// 信号量实现，用于限制并发
class Semaphore {
  private count: number;
  private queue: (() => void)[] = [];

  constructor(count: number) {
    this.count = count;
  }

  async acquire(): Promise<void> {
    if (this.count > 0) {
      this.count--;
    } else {
      await new Promise<void>((resolve) => {
        this.queue.push(resolve);
      });
    }
  }

  release(): void {
    if (this.queue.length > 0) {
      const resolve = this.queue.shift();
      if (resolve) {
        resolve();
      }
    } else {
      this.count++;
    }
  }
}

// 创建并注册插件
const kkvPlugin = new KKVPlugin();
registerGlobalPlugin(kkvPlugin);

export type { KKVPlugin };
export const KKVPluginInstance = kkvPlugin;