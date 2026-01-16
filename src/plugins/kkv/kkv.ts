import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import cheerio from 'cheerio';
import { SearchResult, Link } from '../../types';
import { Plugin } from '../../types/plugin';


const baseURL = 'http://kkv.q-23.cn';
const searchPath = '/';
const maxResults = 10;
const maxConcurrent = 3;

const debugMode = false;

function debugPrintf(format: string, ...args: any[]) {
  if (debugMode) {
    console.log(`[KKV DEBUG] ${format}`, ...args);
  }
}

interface SearchItem {
  id: string;
  title: string;
  detailURL: string;
}

class KKVPlugin implements Plugin {
  private client: AxiosInstance;
  
  constructor() {
    this.client = axios.create({
      timeout: 30000,
      maxRedirects: 5,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      }
    });
  }

  name(): string {
    return 'kkv';
  }

  displayName(): string {
    return 'KKV';
  }

  description(): string {
    return 'KKV - 网盘资源搜索';
  }

  async search(keyword: string, ext: Record<string, any>): Promise<SearchResult[]> {
    return this.searchImpl(keyword, ext);
  }

  private async searchImpl(keyword: string, ext: Record<string, any>): Promise<SearchResult[]> {
    debugPrintf('🔍 开始搜索 - keyword: %s\n', keyword);
    const searchURL = `${baseURL}${searchPath}?s=${encodeURIComponent(keyword)}`;
    debugPrintf('📝 搜索URL: %s\n', searchURL);
    
    const items = await this.fetchSearchResults(searchURL);
    debugPrintf('✅ 获取到 %d 个搜索结果\n', items.length);
    
    if (items.length === 0) {
      debugPrintf('⚠️ 没有搜索结果\n');
      return [];
    }
    
    const filteredItems = this.filterItemsByKeyword(items, keyword);
    debugPrintf('🔎 标题过滤后剩余 %d 个结果（从 %d 个）\n', filteredItems.length, items.length);
    
    if (filteredItems.length === 0) {
      debugPrintf('⚠️ 标题过滤后没有匹配的结果\n');
      return [];
    }
    
    if (filteredItems.length > maxResults) {
      debugPrintf('✂️ 限制结果数量从 %d 到 %d\n', filteredItems.length, maxResults);
      filteredItems = filteredItems.slice(0, maxResults);
    }
    
    const results = await this.processDetailPages(filteredItems);
    debugPrintf('📊 处理完成，获得 %d 个有效结果\n', results.length);
    
    return results;
  }

  private filterItemsByKeyword(items: SearchItem[], keyword: string): SearchItem[] {
    const lowerKeyword = keyword.toLowerCase();
    const filtered: SearchItem[] = [];
    
    for (const item of items) {
      const lowerTitle = item.title.toLowerCase();
      if (lowerTitle.includes(lowerKeyword)) {
        debugPrintf('✅ 标题匹配: %s\n', item.title);
        filtered.push(item);
      } else {
        debugPrintf('❌ 标题不匹配，跳过: %s\n', item.title);
      }
    }
    
    return filtered;
  }

  private async fetchSearchResults(searchURL: string): Promise<SearchItem[]> {
    debugPrintf('🌐 请求搜索页面: %s\n', searchURL);
    
    try {
      const config: AxiosRequestConfig = {
        method: 'GET',
        url: searchURL,
        headers: this.setHeaders(baseURL)
      };

      const resp = await this.doRequestWithRetry(config);
      
      debugPrintf('📡 HTTP状态码: %d\n', resp.status);
      
      if (resp.status !== 200) {
        throw new Error(`请求返回状态码: ${resp.status}`);
      }
      
      const $ = cheerio.load(resp.data);
      const items: SearchItem[] = [];
      
      $('article.post').each((i, s) => {
        const link = $(s).find('.entry-header h2.entry-title a');
        const href = link.attr('href');
        if (!href) {
          debugPrintf('⚠️ 第%d个结果没有href属性\n', i+1);
          return;
        }
        
        const title = link.text().trim();
        if (title === '') {
          debugPrintf('⚠️ 第%d个结果标题为空\n', i+1);
          return;
        }
        
        const re = /\?p=(\d+)/;
        const matches = re.exec(href);
        if (!matches || matches.length < 2) {
          debugPrintf('⚠️ 无法从href提取ID: %s\n', href);
          return;
        }
        
        const item: SearchItem = {
          id: matches[1],
          title: title,
          detailURL: href
        };
        debugPrintf('📌 找到影片: ID=%s, Title=%s\n', item.id, item.title);
        items.push(item);
      });
      
      debugPrintf('✅ 解析到 %d 个搜索项\n', items.length);
      return items;
    } catch (error) {
      debugPrintf('❌ 获取搜索结果失败: %v\n', error);
      throw new Error(`[${this.name()}] 搜索请求失败: ${error}`);
    }
  }

  private async processDetailPages(items: SearchItem[]): Promise<SearchResult[]> {
    const results: SearchResult[] = [];
    const semaphore = this.createSemaphore(maxConcurrent);
    
    const promises = items.map(async (item) => {
      await semaphore.acquire();
      try {
        const result = await this.processDetailPage(item);
        if (result) {
          results.push(result);
        }
      } catch (error) {
        debugPrintf('❌ 处理详情页失败: %v\n', error);
      } finally {
        semaphore.release();
      }
    });
    
    await Promise.all(promises);
    return results;
  }

  private async processDetailPage(item: SearchItem): Promise<SearchResult | null> {
    debugPrintf('🎬 处理详情页: %s (ID: %s)\n', item.title, item.id);
    
    try {
      const config: AxiosRequestConfig = {
        method: 'GET',
        url: item.detailURL,
        headers: this.setHeaders(baseURL)
      };

      const resp = await this.doRequestWithRetry(config);
      
      if (resp.status !== 200) {
        debugPrintf('❌ 详情页状态码: %d\n', resp.status);
        return null;
      }
      
      const $ = cheerio.load(resp.data);
      
      let title = $('.entry-header h1.entry-title').text().trim();
      if (title === '') {
        title = item.title;
      }
      debugPrintf('📝 影片标题: %s\n', title);
      
      let description = '';
      $('.entry-content p').first().each((i, s) => {
        description = $(s).text().trim();
        if (description.length > 200) {
          description = description.substring(0, 200) + '...';
        }
      });
      
      const updateTime = this.extractUpdateTime($);
      debugPrintf('🕐 更新时间: %v\n', updateTime);
      
      const panLinks = this.extractPanLinks($);
      if (panLinks.length === 0) {
        debugPrintf('❌ 未找到网盘链接\n');
        return null;
      }
      
      debugPrintf('✅ 找到 %d 个网盘链接\n', panLinks.length);
      
      return {
        uniqueId: `${this.name()}-${item.id}`,
        title: title,
        content: description,
        links: panLinks,
        channel: '',
        datetime: updateTime,
        tags: [],
        images: [],
        pluginName: this.name(),
        displayName: this.displayName()
      };
    } catch (error) {
      debugPrintf('❌ 处理详情页失败: %v\n', error);
      return null;
    }
  }

  private extractUpdateTime($: cheerio.Root): Date {
    const timeStr = $('time.updated').attr('datetime');
    if (!timeStr) {
      debugPrintf('⚠️ 未找到更新时间\n');
      return new Date();
    }
    
    debugPrintf('🔍 提取到时间字符串: %s\n', timeStr);
    
    const date = new Date(timeStr);
    if (isNaN(date.getTime())) {
      debugPrintf('❌ 时间解析失败\n');
      return new Date();
    }
    
    return date;
  }

  private extractPanLinks($: cheerio.Root): Link[] {
    debugPrintf('🔎 开始提取网盘链接\n');
    const links: Link[] = [];
    
    $('.entry-content p').each((i, s) => {
      $(s).find('a').each((j, a) => {
        const href = $(a).attr('href');
        if (!href) {
          return;
        }
        
        const trimmedHref = href.trim();
        const cloudType = this.determinePanType(trimmedHref);
        if (cloudType === '') {
          return;
        }
        
        debugPrintf('🔗 找到%s链接: %s\n', cloudType, trimmedHref);
        
        const password = this.extractPassword(trimmedHref, $(s).text());
        debugPrintf('🔑 密码: %s\n', password);
        
        links.push({
          url: trimmedHref,
          type: cloudType,
          password: password
        });
      });
    });
    
    debugPrintf('✅ 共提取到 %d 个网盘链接\n', links.length);
    return links;
  }

  private determinePanType(panURL: string): string {
    const lower = panURL.toLowerCase();
    
    switch (true) {
      case lower.includes('pan.baidu.com'):
        return 'baidu';
      case lower.includes('pan.quark.cn'):
        return 'quark';
      case lower.includes('drive.uc.cn'):
        return 'uc';
      case lower.includes('pan.xunlei.com'):
        return 'xunlei';
      case lower.includes('aliyundrive.com') || lower.includes('alipan.com'):
        return 'aliyun';
      case lower.includes('cloud.189.cn'):
        return 'tianyi';
      case lower.includes('115.com') || lower.includes('115cdn.com') || lower.includes('anxia.com'):
        return '115';
      case lower.includes('123684.com') || lower.includes('123685.com') ||
           lower.includes('123912.com') || lower.includes('123pan.com') ||
           lower.includes('123pan.cn') || lower.includes('123592.com'):
        return '123';
      case lower.includes('caiyun.139.com'):
        return 'mobile';
      case lower.includes('mypikpak.com'):
        return 'pikpak';
      default:
        return '';
    }
  }

  private extractPassword(panURL: string, contextText: string): string {
    try {
      const parsed = new URL(panURL);
      const pwd = parsed.searchParams.get('pwd');
      if (pwd && pwd.length === 4) {
        return pwd;
      }
    } catch (error) {
      // URL解析失败，继续从文本中提取
    }
    
    const pwdPatterns = [
      /提取码[：:]:?\s*([a-zA-Z0-9]{4})/,
      /密码[：:]:?\s*([a-zA-Z0-9]{4})/,
      /pwd[：:]:?\s*([a-zA-Z0-9]{4})/
    ];
    
    
    for (const pattern of pwdPatterns) {
      const matches = pattern.exec(contextText);
      if (matches && matches.length > 1) {
        return matches[1];
      }
    }
    
    return '';
  }

  private setHeaders(referer: string): Record<string, string> {
    return {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'Connection': 'keep-alive',
      'Referer': referer
    };
  }

  private async doRequestWithRetry(config: AxiosRequestConfig): Promise<any> {
    const maxRetries = 3;
    let lastError: any;
    
    for (let i = 0; i < maxRetries; i++) {
      if (i > 0) {
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

  private createSemaphore(maxConcurrent: number): {
    acquire: () => Promise<void>;
    release: () => void;
  } {
    let count = 0;
    const queue: (() => void)[] = [];
    
    return {
      acquire: async () => {
        if (count < maxConcurrent) {
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
}

// 导出插件实例
const plugin = new KKVPlugin();
export default plugin;