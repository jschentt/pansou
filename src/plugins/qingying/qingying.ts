import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import * as cheerio from 'cheerio';
import { SearchResult, Link, PluginSearchResult } from '../../../model';

// 常量定义
const baseURL = 'http://revohd.com';
const searchPath = '/vodsearch/-------------.html';
const maxResults = 10;
const maxConcurrent = 3;

let debugMode = false;

function debugPrintf(format: string, ...args: any[]): void {
  if (debugMode) {
    console.log(`[QingYing DEBUG] ${format}`, ...args);
  }
}

// 搜索结果项接口
interface searchItem {
  ID: string;
  Title: string;
  DetailURL: string;
}

// QingYingPlugin 清樱网搜索插件
export class QingYingPlugin {
  private client: AxiosInstance;
  private MainCacheKey: string;
  private name: string;

  constructor() {
    this.client = axios.create({
      timeout: 30000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Connection': 'keep-alive',
        'Referer': baseURL + '/',
      },
      httpsAgent: new (require('https').Agent)({
        rejectUnauthorized: false
      })
    });

    this.MainCacheKey = 'qingying';
    this.name = 'qingying';
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
    // 这里实现异步搜索逻辑，暂时直接调用searchImpl
    const results = await searchImpl(this.client, keyword, ext);
    return {
      Results: results,
      IsFinal: true,
      CacheKey: cacheKey
    };
  }

  // searchImpl 实际的搜索实现
  private async searchImpl(client: AxiosInstance, keyword: string, ext: Record<string, any>): Promise<SearchResult[]> {
    debugPrintf('🔍 开始搜索 - keyword: %s', keyword);
    const searchURL = `${baseURL}${searchPath}?wd=${encodeURIComponent(keyword)}`;
    debugPrintf('📝 搜索URL: %s', searchURL);

    let items: searchItem[];
    try {
      items = await this.fetchSearchResults(searchURL, client);
    } catch (err) {
      debugPrintf('❌ 获取搜索结果失败: %v', err);
      throw err;
    }

    debugPrintf('✅ 获取到 %d 个搜索结果', items.length);

    if (items.length === 0) {
      debugPrintf('⚠️ 没有搜索结果');
      return [];
    }

    const filteredItems = this.filterItemsByKeyword(items, keyword);
    debugPrintf('🔎 标题过滤后剩余 %d 个结果（从 %d 个）', filteredItems.length, items.length);

    if (filteredItems.length === 0) {
      debugPrintf('⚠️ 标题过滤后没有匹配的结果');
      return [];
    }

    if (filteredItems.length > maxResults) {
      debugPrintf('✂️ 限制结果数量从 %d 到 %d', filteredItems.length, maxResults);
      filteredItems.splice(maxResults);
    }

    const results = await this.processDetailPages(filteredItems, client);
    debugPrintf('📊 处理完成，获得 %d 个有效结果', results.length);

    return results;
  }

  // filterItemsByKeyword 根据关键词过滤搜索结果
  private filterItemsByKeyword(items: searchItem[], keyword: string): searchItem[] {
    const lowerKeyword = keyword.toLowerCase();
    const filtered: searchItem[] = [];

    for (const item of items) {
      const lowerTitle = item.Title.toLowerCase();
      if (lowerTitle.includes(lowerKeyword)) {
        debugPrintf('✅ 标题匹配: %s', item.Title);
        filtered.push(item);
      } else {
        debugPrintf('❌ 标题不匹配，跳过: %s', item.Title);
      }
    }

    return filtered;
  }

  // fetchSearchResults 获取搜索结果
  private async fetchSearchResults(searchURL: string, client: AxiosInstance): Promise<searchItem[]> {
    debugPrintf('🌐 请求搜索页面: %s', searchURL);

    // 创建请求配置
    const config: AxiosRequestConfig = {
      url: searchURL,
      method: 'GET',
      timeout: 30000
    };

    this.setHeaders(config, baseURL);

    let response;
    try {
      response = await this.doRequestWithRetry(config, client);
    } catch (err) {
      throw new Error(`[${this.Name()}] 搜索请求失败: ${err}`);
    }

    debugPrintf('📡 HTTP状态码: %d', response.status);

    if (response.status !== 200) {
      throw new Error(`[${this.Name()}] 请求返回状态码: ${response.status}`);
    }

    const $ = cheerio.load(response.data);
    const items: searchItem[] = [];

    $('.module-search-item').each((i, element) => {
      const s = $(element);
      const link = s.find('.video-info .video-info-header h3 a');
      const href = link.attr('href');
      if (!href) {
        debugPrintf('⚠️ 第%d个结果没有href属性', i + 1);
        return;
      }

      let title = link.text().trim();
      if (!title) {
        title = link.attr('title') || '';
        title = title.trim();
      }

      if (!title) {
        debugPrintf('⚠️ 第%d个结果标题为空', i + 1);
        return;
      }

      const re = /\/voddetail\/(\d+)\.html/;
      const matches = href.match(re);
      if (!matches || matches.length < 2) {
        debugPrintf('⚠️ 无法从href提取ID: %s', href);
        return;
      }

      const item: searchItem = {
        ID: matches[1],
        Title: title,
        DetailURL: this.buildAbsURL(href),
      };
      debugPrintf('📌 找到影片: ID=%s, Title=%s', item.ID, item.Title);
      items.push(item);
    });

    debugPrintf('✅ 解析到 %d 个搜索项', items.length);
    return items;
  }

  // processDetailPages 并发处理详情页
  private async processDetailPages(items: searchItem[], client: AxiosInstance): Promise<SearchResult[]> {
    const results: SearchResult[] = [];
    const semaphore = new Semaphore(maxConcurrent);

    const promises = items.map(async (item) => {
      await semaphore.acquire();
      try {
        return await this.processDetailPage(item, client);
      } finally {
        semaphore.release();
      }
    });

    const processedResults = await Promise.all(promises);
    return processedResults.filter((result): result is SearchResult => result !== null);
  }

  // processDetailPage 处理单个详情页
  private async processDetailPage(item: searchItem, client: AxiosInstance): Promise<SearchResult | null> {
    debugPrintf('🎬 处理详情页: %s (ID: %s)', item.Title, item.ID);

    // 创建请求配置
    const config: AxiosRequestConfig = {
      url: item.DetailURL,
      method: 'GET',
      timeout: 30000
    };

    this.setHeaders(config, baseURL);

    let response;
    try {
      response = await this.doRequestWithRetry(config, client);
    } catch (err) {
      debugPrintf('❌ 详情页请求失败: %v', err);
      return null;
    }

    if (response.status !== 200) {
      debugPrintf('❌ 详情页状态码: %d', response.status);
      return null;
    }

    const $ = cheerio.load(response.data);

    let title = $('.video-info .video-info-header h1.page-title a').text().trim();
    if (!title) {
      title = item.Title;
    }
    debugPrintf('📝 影片标题: %s', title);

    let description = '';
    let updateTime = new Date();

    $('.video-info-items').each((i, element) => {
      const s = $(element);
      const itemTitle = s.find('.video-info-itemtitle').text().trim();

      if (itemTitle.includes('更新')) {
        const timeText = s.find('.video-info-item').text().trim();
        debugPrintf('🕐 找到更新时间文本: %s', timeText);
        const parsedTime = this.parseUpdateTimeFromHTML(timeText);
        if (parsedTime) {
          updateTime = parsedTime;
          debugPrintf('✅ 解析更新时间成功: %v', updateTime);
        }
      }

      if (itemTitle.includes('剧情')) {
        const content = s.find('.video-info-item.video-info-content span');
        if (content.length > 0) {
          description = content.text().trim();
        } else {
          description = s.find('.video-info-item').text().trim();
        }
        if (description.length > 50) {
          debugPrintf('📖 剧情简介: %s...', description.substring(0, 50));
        } else {
          debugPrintf('📖 剧情简介: %s', description);
        }
      }
    });

    if (updateTime.getTime() === new Date().getTime()) {
      debugPrintf('⚠️ 未找到更新时间，使用当前时间');
    }

    const panLink = this.extract123PanLink($);
    if (!panLink) {
      debugPrintf('❌ 未找到123网盘链接');
      return null;
    }

    debugPrintf('✅ 找到123网盘链接: %s (密码: %s)', panLink.URL, panLink.Password);

    return {
      UniqueID: `${this.Name()}-${item.ID}`,
      Title: title,
      Content: description,
      Links: [panLink],
      Channel: '',
      Datetime: updateTime,
    };
  }

  // extract123PanLink 提取123网盘链接
  private extract123PanLink($: cheerio.CheerioAPI): Link | null {
    debugPrintf('🔎 开始提取123网盘链接');
    let panURL = '';

    let found = false;
    $('.module-heading h2.module-title').each((i, element) => {
      const text = $(element).text().trim();
      debugPrintf('📋 找到标题: %s', text);
      if (text.includes('123') && text.includes('云盘')) {
        found = true;
        debugPrintf('✅ 匹配到123云盘标题');
      }
    });

    if (!found) {
      debugPrintf('❌ 未找到123云盘标题区域');
      return null;
    }

    $('.module-downlist .module-row-text').each((i, element) => {
      if (panURL) {
        return;
      }

      const s = $(element);
      const clipboardText = s.attr('data-clipboard-text');
      debugPrintf('🔗 检查链接 #%d: exists=%s, text=%s', i + 1, clipboardText ? 'true' : 'false', clipboardText || '');
      if (clipboardText) {
        const url = clipboardText.trim();
        if (url.includes('123684.com') || url.includes('123685.com') ||
            url.includes('123912.com') || url.includes('123pan.com') ||
            url.includes('123pan.cn') || url.includes('123592.com')) {
          panURL = url;
          debugPrintf('✅ 找到123网盘链接: %s', panURL);
        }
      }
    });

    if (!panURL) {
      debugPrintf('❌ 未找到123网盘链接');
      return null;
    }

    const password = this.extractPassword(panURL);
    debugPrintf('🔑 提取密码: %s', password);

    return {
      Type: '123',
      URL: panURL,
      Password: password,
    };
  }

  // parseUpdateTimeFromHTML 从HTML文本中解析更新时间
  private parseUpdateTimeFromHTML(timeText: string): Date | null {
    const re = /(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})/;
    const matches = timeText.match(re);
    if (!matches || matches.length < 2) {
      debugPrintf('❌ 无法从文本提取时间: %s', timeText);
      return null;
    }

    const timeStr = matches[1].trim();
    debugPrintf('🔍 提取到时间字符串: %s', timeStr);

    const t = new Date(timeStr);
    if (isNaN(t.getTime())) {
      debugPrintf('❌ 时间解析失败: %s', timeStr);
      return null;
    }

    return t;
  }

  // extractPassword 提取密码
  private extractPassword(panURL: string): string {
    try {
      const parsed = new URL(panURL);
      const pwd = parsed.searchParams.get('pwd');
      if (pwd && pwd.length === 4) {
        return pwd;
      }
    } catch (err) {
      // URL解析失败，继续使用正则提取
    }

    const pwdRegex = /pwd=([a-zA-Z0-9]{4})/;
    const matches = panURL.match(pwdRegex);
    if (matches && matches.length > 1) {
      return matches[1];
    }

    return '';
  }

  // buildAbsURL 构建完整URL
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

  // setHeaders 设置请求头
  private setHeaders(config: AxiosRequestConfig, referer: string): void {
    if (!config.headers) {
      config.headers = {};
    }
    config.headers['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36';
    config.headers['Accept'] = 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8';
    config.headers['Accept-Language'] = 'zh-CN,zh;q=0.9,en;q=0.8';
    config.headers['Connection'] = 'keep-alive';
    config.headers['Referer'] = referer;
  }

  // doRequestWithRetry 带重试机制的HTTP请求
  private async doRequestWithRetry(config: AxiosRequestConfig, client: AxiosInstance): Promise<any> {
    const maxRetries = 3;
    let lastErr: Error | null = null;

    for (let i = 0; i < maxRetries; i++) {
      if (i > 0) {
        const backoff = Math.min(200 * Math.pow(2, i - 1), 10000); // 最大10秒
        await new Promise(resolve => setTimeout(resolve, backoff));
      }

      try {
        const response = await client.request(config);
        if (response.status === 200) {
          return response;
        }
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error(String(err));
      }
    }

    throw new Error(`重试 ${maxRetries} 次后仍然失败: ${lastErr?.message}`);
  }
}

// 信号量实现
class Semaphore {
  private available: number;
  private queue: Array<() => void> = [];

  constructor(initial: number) {
    this.available = initial;
  }

  async acquire(): Promise<void> {
    if (this.available > 0) {
      this.available--;
      return;
    }

    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
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

// 创建并导出插件实例
export default new QingYingPlugin();