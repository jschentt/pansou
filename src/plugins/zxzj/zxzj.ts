import { SearchResult, Link, PluginSearchResult } from '../../models/plugin-result';
import { BaseAsyncPlugin } from '../plugin.manager';
import axios, { AxiosInstance, AxiosResponse } from 'axios';
import * as cheerio from 'cheerio';

const baseURL = 'https://www.zxzjhd.com';
const searchPath = '/vodsearch/-------------.html';
const maxResults = 10;
const maxConcurrent = 5;

class ZXZJPlugin extends BaseAsyncPlugin {
  private client: AxiosInstance;

  constructor() {
    super('zxzj', 3);
    this.client = axios.create({
      timeout: 30000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Connection': 'keep-alive',
      },
    });
  }

  public async Search(keyword: string, ext: Record<string, any>): Promise<SearchResult[]> {
    const result = await this.SearchWithResult(keyword, ext);
    return result.Results;
  }

  public async SearchWithResult(keyword: string, ext: Record<string, any>): Promise<PluginSearchResult> {
    return this.AsyncSearchWithResult(keyword, this.searchImpl.bind(this), this.MainCacheKey, ext);
  }

  private async searchImpl(client: AxiosInstance, keyword: string, ext: Record<string, any>): Promise<SearchResult[]> {
    const searchURL = `${baseURL}${searchPath}?wd=${encodeURIComponent(keyword)}&submit=`;
    
    const items = await this.fetchSearchResults(searchURL);
    
    if (items.length === 0) {
      return [];
    }
    
    if (items.length > maxResults) {
      items.splice(maxResults);
    }
    
    const results = await this.processDetailPages(items);
    
    return this.FilterResultsByKeyword(results, keyword);
  }

  private async fetchSearchResults(searchURL: string): Promise<SearchItem[]> {
    try {
      const resp = await this.doRequestWithRetry(this.client, searchURL, baseURL);
      
      const $ = cheerio.load(resp.data);
      const items: SearchItem[] = [];
      
      $('ul.stui-vodlist li').each((i, s) => {
        const link = $(s).find('.stui-vodlist__detail h4.title a');
        const href = link.attr('href');
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
      console.error(`[zxzj] 获取搜索结果失败: ${(error as Error).message}`);
      return [];
    }
  }

  private async processDetailPages(items: SearchItem[]): Promise<SearchResult[]> {
    const results: SearchResult[] = [];
    const semaphore = new Semaphore(maxConcurrent);
    
    const promises = items.map(async (item) => {
      await semaphore.acquire();
      try {
        const result = await this.processDetailPage(item);
        if (result) {
          results.push(result);
        }
      } finally {
        semaphore.release();
      }
    });
    
    await Promise.all(promises);
    return results;
  }

  private async processDetailPage(item: SearchItem): Promise<SearchResult | null> {
    try {
      const resp = await this.doRequestWithRetry(this.client, item.DetailURL, baseURL);
      
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
      
      const links = await this.fetchPanLinks(playLinks);
      if (links.length === 0) {
        return null;
      }
      
      return {
        UniqueID: `${this.Name()}-${item.ID}`,
        Title: title,
        Content: description,
        Links: links,
        Channel: '',
        Datetime: updateTime,
      };
    } catch (error) {
      console.error(`[zxzj] 处理详情页失败: ${(error as Error).message}`);
      return null;
    }
  }

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
        const href = $(a).attr('href');
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

  private async fetchPanLinks(playLinks: PlayLink[]): Promise<Link[]> {
    const links: Link[] = [];
    const semaphore = new Semaphore(maxConcurrent);
    
    const promises = playLinks.map(async (pl) => {
      await semaphore.acquire();
      try {
        const link = await this.fetchSinglePanLink(pl);
        if (link) {
          links.push(link);
        }
      } finally {
        semaphore.release();
      }
    });
    
    await Promise.all(promises);
    return links;
  }

  private async fetchSinglePanLink(pl: PlayLink): Promise<Link | null> {
    try {
      const resp = await this.doRequestWithRetry(this.client, pl.URL, baseURL);
      
      const body = resp.data;
      const [panURL, password] = this.parsePlayerData(body);
      
      if (!panURL) {
        return null;
      }
      
      const cloudType = this.determinePanType(panURL, pl.LineType);
      if (!cloudType) {
        return null;
      }
      
      return {
        Type: cloudType,
        URL: panURL,
        Password: password,
      };
    } catch (error) {
      console.error(`[zxzj] 获取网盘链接失败: ${(error as Error).message}`);
      return null;
    }
  }

  private parsePlayerData(body: string): [string, string] {
    const re = /var\s+player_aaaa\s*=\s*(\{[^;]+\})/;
    const matches = re.exec(body);
    if (!matches || matches.length < 2) {
      return ['', ''];
    }
    
    try {
      const data = JSON.parse(matches[1]);
      const panURL = data.url ? data.url.trim() : '';
      
      if (!panURL) {
        return ['', ''];
      }
      
      const normalizedURL = panURL.replace(/\\\//g, '/');
      const password = this.extractPassword(normalizedURL);
      
      return [normalizedURL, password];
    } catch {
      return ['', ''];
    }
  }

  private extractPassword(panURL: string): string {
    try {
      const urlObj = new URL(panURL);
      const pwd = urlObj.searchParams.get('pwd');
      if (pwd && pwd.length === 4) {
        return pwd;
      }
    } catch {
      // 忽略 URL 解析错误
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

  private parseUpdateTime(text: string): Date {
    const updateRegex = /更新[：:]\s*(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}|\d{4}-\d{2}-\d{2})/;
    const matches = updateRegex.exec(text);
    if (!matches || matches.length < 2) {
      return new Date(0);
    }
    
    const timeStr = matches[1].trim();
    
    const layouts = [
      'YYYY-MM-DD HH:mm:ss',
      'YYYY-MM-DD',
    ];
    
    for (const layout of layouts) {
      const date = this.parseDate(timeStr, layout);
      if (date.getTime() > 0) {
        return date;
      }
    }
    
    return new Date(0);
  }

  private parseDate(dateString: string, format: string): Date {
    if (format === 'YYYY-MM-DD') {
      const [year, month, day] = dateString.split('-').map(Number);
      return new Date(year, month - 1, day);
    } else if (format === 'YYYY-MM-DD HH:mm:ss') {
      const [datePart, timePart] = dateString.split(' ');
      const [year, month, day] = datePart.split('-').map(Number);
      const [hour, minute, second] = timePart.split(':').map(Number);
      return new Date(year, month - 1, day, hour, minute, second);
    }
    return new Date(0);
  }

  private async doRequestWithRetry(client: AxiosInstance, url: string, referer: string): Promise<AxiosResponse> {
    const maxRetries = 3;
    let lastError: Error | null = null;
    
    for (let i = 0; i < maxRetries; i++) {
      if (i > 0) {
        const backoff = Math.pow(2, i - 1) * 200;
        await new Promise(resolve => setTimeout(resolve, backoff));
      }
      
      try {
        const resp = await client.get(url, {
          headers: {
            'Referer': referer,
          },
        });
        
        if (resp.status === 200) {
          return resp;
        }
      } catch (error) {
        lastError = error as Error;
      }
    }
    
    throw new Error(`重试 ${maxRetries} 次后仍然失败: ${lastError?.message}`);
  }
}

interface SearchItem {
  ID: string;
  Title: string;
  DetailURL: string;
}

interface PlayLink {
  URL: string;
  Label: string;
  LineType: string;
}

// 信号量实现，用于限制并发数
class Semaphore {
  private maxConcurrency: number;
  private current: number;
  private queue: (() => void)[];

  constructor(maxConcurrency: number) {
    this.maxConcurrency = maxConcurrency;
    this.current = 0;
    this.queue = [];
  }

  async acquire(): Promise<void> {
    if (this.current < this.maxConcurrency) {
      this.current++;
      return;
    }

    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
  }

  release(): void {
    if (this.queue.length > 0) {
      const resolve = this.queue.shift()!;
      resolve();
    } else {
      this.current--;
    }
  }
}

// 注册插件
BaseAsyncPlugin.RegisterGlobalPlugin(new ZXZJPlugin());
