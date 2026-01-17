import { BaseAsyncPlugin, registerGlobalPlugin } from '../plugin.manager';
import { SearchResult, Link } from '../../models/response';
import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import * as cheerio from 'cheerio';
import * as crypto from 'crypto';
import * as url from 'url';

const baseURL = "https://www.zxzjhd.com";
const searchPath = "/vodsearch/-------------.html";
const maxResults = 10;
const maxConcurrent = 5;

// 搜索结果项接口
interface SearchItem {
  ID: string;
  Title: string;
  DetailURL: string;
}

// 播放链接项接口
interface PlayLink {
  URL: string;
  Label: string;
  LineType: string;
}

// 播放器数据接口
interface PlayerData {
  url: string;
  from: string;
}

// ZXZJPlugin 插件结构
class ZXZJPlugin extends BaseAsyncPlugin {
  private optimizedClient: AxiosInstance;

  constructor() {
    super("zxzj", 3); // 普通质量插件，优先级3
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
    const searchURL = `${baseURL}${searchPath}?wd=${encodeURIComponent(keyword)}&submit=`;
    
    const items = await this.fetchSearchResults(client, searchURL);
    
    if (items.length === 0) {
      return [];
    }
    
    if (items.length > maxResults) {
      items = items.slice(0, maxResults);
    }
    
    const results = await this.processDetailPages(client, items);
    
    // 关键词过滤
    return results.filter(result => 
      result.title.toLowerCase().includes(keyword.toLowerCase()) ||
      result.content.toLowerCase().includes(keyword.toLowerCase())
    );
  }

  // 获取搜索结果
  private async fetchSearchResults(client: AxiosInstance, searchURL: string): Promise<SearchItem[]> {
    try {
      const resp = await client.get(searchURL);
      if (resp.status !== 200) {
        throw new Error(`请求返回状态码: ${resp.status}`);
      }
      
      const $ = cheerio.load(resp.data);
      const items: SearchItem[] = [];
      
      $('ul.stui-vodlist li').each((i, s) => {
        const link = $(s).find('.stui-vodlist__detail h4.title a');
        const href = link.attr('href') || '';
        if (!href) {
          return;
        }
        
        const title = link.text().trim();
        if (!title) {
          return;
        }
        
        const re = /\/detail\/(\d+)\.html/;
        const matches = re.exec(href);
        if (!matches || matches.length < 2) {
          return;
        }
        
        items.push({
          ID: matches[1],
          Title: title,
          DetailURL: this.buildAbsURL(href),
        });
      });
      
      return items;
    } catch (error) {
      console.error(`[ZXZJ] 搜索请求失败: ${error}`);
      return [];
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
    try {
      const resp = await client.get(item.DetailURL);
      if (resp.status !== 200) {
        return null;
      }
      
      const $ = cheerio.load(resp.data);
      
      let title = $('.stui-content__detail h1.title').text().trim();
      if (!title) {
        title = item.Title;
      }
      
      let description = '';
      let updateTime = new Date(0);
      
      $('.stui-content__detail p.data').each((i, s) => {
        const text = $(s).text().trim();
        if (text) {
          if (description) {
            description += '\n';
          }
          description += text;
          
          if (updateTime.getTime() === 0 && text.includes('更新')) {
            updateTime = this.parseUpdateTime(text);
          }
        }
      });
      
      if (updateTime.getTime() === 0) {
        updateTime = new Date();
      }
      
      const playLinks = this.extractPlayLinks($);
      if (playLinks.length === 0) {
        return null;
      }
      
      const links = await this.fetchPanLinks(client, playLinks);
      if (links.length === 0) {
        return null;
      }
      
      const result = new SearchResult();
      result.uniqueID = `${this.pluginName}-${item.ID}`;
      result.title = title;
      result.content = description;
      result.links = links;
      result.channel = '';
      result.datetime = updateTime;
      result.images = [];
      result.tags = [];
      
      return result;
    } catch (error) {
      console.error(`[ZXZJ] 处理详情页失败: ${error}`);
      return null;
    }
  }

  // 提取播放链接
  private extractPlayLinks($: cheerio.Root): PlayLink[] {
    const links: PlayLink[] = [];
    
    $('.stui-vodlist__head').each((i, head) => {
      const lineTitle = $(head).find('h3').text().trim();
      if (!lineTitle) {
        return;
      }
      
      const panType = this.detectPanType(lineTitle);
      if (!panType) {
        return;
      }
      
      let playlist = $(head).next();
      while (playlist.length > 0 && !playlist.is('ul.stui-content__playlist')) {
        playlist = playlist.next();
      }
      
      if (playlist.length === 0) {
        return;
      }
      
      playlist.find('li a').each((j, a) => {
        const href = $(a).attr('href') || '';
        if (!href) {
          return;
        }
        
        const label = $(a).text().trim();
        links.push({
          URL: this.buildAbsURL(href),
          Label: label,
          LineType: panType,
        });
      });
    });
    
    return links;
  }

  // 检测网盘类型
  private detectPanType(title: string): string {
    const lower = title.toLowerCase();
    
    if (lower.includes('百度')) {
      return 'baidu';
    }
    if (lower.includes('夸克')) {
      return 'quark';
    }
    if (lower.includes('迅雷')) {
      return 'xunlei';
    }
    
    return '';
  }

  // 获取网盘链接
  private async fetchPanLinks(client: AxiosInstance, playLinks: PlayLink[]): Promise<Link[]> {
    const links: Link[] = [];
    const semaphore = new Semaphore(maxConcurrent);
    
    const promises = playLinks.map(async (pl) => {
      await semaphore.acquire();
      try {
        return await this.fetchSinglePanLink(client, pl);
      } finally {
        semaphore.release();
      }
    });
    
    const processedLinks = await Promise.all(promises);
    
    // 过滤掉null结果并合并
    return processedLinks.filter(link => link !== null) as Link[];
  }

  // 获取单个网盘链接
  private async fetchSinglePanLink(client: AxiosInstance, pl: PlayLink): Promise<Link | null> {
    try {
      const resp = await client.get(pl.URL);
      if (resp.status !== 200) {
        return null;
      }
      
      const panURL = await this.parsePlayerData(resp.data);
      if (!panURL) {
        return null;
      }
      
      const password = this.extractPassword(panURL.url);
      const cloudType = this.determinePanType(panURL.url, pl.LineType);
      
      if (!cloudType) {
        return null;
      }
      
      const link = new Link();
      link.type = cloudType;
      link.url = panURL.url;
      link.password = password;
      
      return link;
    } catch (error) {
      console.error(`[ZXZJ] 获取网盘链接失败: ${error}`);
      return null;
    }
  }

  // 解析播放器数据
  private parsePlayerData(body: string): { url: string; from: string } | null {
    const re = /var\s+player_aaaa\s*=\s*(\{[^;]+\})/;
    const matches = re.exec(body);
    if (!matches || matches.length < 2) {
      return null;
    }
    
    try {
      // 解析JSON数据
      const playerData: PlayerData = JSON.parse(matches[1]);
      
      let panURL = playerData.url.trim();
      if (!panURL) {
        return null;
      }
      
      // 处理转义字符
      panURL = panURL.replace(/\\\//g, '/');
      
      return {
        url: panURL,
        from: playerData.from,
      };
    } catch (error) {
      console.error(`[ZXZJ] 解析播放器数据失败: ${error}`);
      return null;
    }
  }

  // 提取密码
  private extractPassword(panURL: string): string {
    try {
      const parsed = new url.URL(panURL);
      const pwd = parsed.searchParams.get('pwd');
      if (pwd && pwd.length === 4) {
        return pwd;
      }
    } catch (error) {
      // URL解析失败，继续使用其他方法
    }
    
    if (panURL.includes('|')) {
      const parts = panURL.split('|');
      if (parts.length >= 2) {
        const pwd = parts[1].trim();
        if (pwd.length === 4) {
          return pwd;
        }
      }
    }
    
    const pwdRegex = /pwd=([a-zA-Z0-9]{4})/;
    const matches = pwdRegex.exec(panURL);
    if (matches && matches.length > 1) {
      return matches[1];
    }
    
    return '';
  }

  // 确定网盘类型
  private determinePanType(panURL: string, lineType: string): string {
    const lower = panURL.toLowerCase();
    
    if (lower.includes('pan.baidu.com')) {
      return 'baidu';
    }
    if (lower.includes('pan.quark.cn')) {
      return 'quark';
    }
    if (lower.includes('pan.xunlei.com')) {
      return 'xunlei';
    }
    if (lower.includes('aliyundrive.com') || lower.includes('alipan.com')) {
      return 'aliyun';
    }
    
    if (lineType) {
      return lineType;
    }
    
    return '';
  }

  // 构建绝对URL
  private buildAbsURL(path: string): string {
    if (path.startsWith('http://') || path.startsWith('https://')) {
      return path;
    }
    if (path.startsWith('//')) {
      return 'https:' + path;
    }
    if (!path.startsWith('/')) {
      path = '/' + path;
    }
    return baseURL + path;
  }

  // 解析更新时间
  private parseUpdateTime(text: string): Date {
    const updateRegex = /更新[：:]\s*(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}|\d{4}-\d{2}-\d{2})/;
    const matches = updateRegex.exec(text);
    if (!matches || matches.length < 2) {
      return new Date(0);
    }
    
    const timeStr = matches[1].trim();
    
    const layouts = [
      '2006-01-02 15:04:05',
      '2006-01-02',
    ];
    
    for (const layout of layouts) {
      const t = new Date(timeStr);
      if (!isNaN(t.getTime())) {
        return t;
      }
    }
    
    return new Date(0);
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
const zxzjPlugin = new ZXZJPlugin();
registerGlobalPlugin(zxzjPlugin);

export type { ZXZJPlugin };
export const ZXZJPluginInstance = zxzjPlugin;