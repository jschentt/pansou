import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import * as cheerio from 'cheerio';
import { SearchResult, Link, PluginSearchResult } from '../../../model';
import { FilterResultsByKeyword } from '../../../util/plugin.util';

// 常量定义
const BaseURL = 'https://www.qupanshe.com';
const UserAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36';
const MaxRetries = 3;

let DebugLog = false; // Debug开关，默认关闭

// QupanshePlugin 趣盘社插件结构
export class QupanshePlugin {
  private client: AxiosInstance;
  private MainCacheKey: string;
  private name: string;

  constructor() {
    this.client = axios.create({
      timeout: 30000,
      headers: {
        'User-Agent': UserAgent,
        'Referer': BaseURL + '/',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
        'Cache-Control': 'max-age=0',
      },
      httpsAgent: new (require('https').Agent)({
        rejectUnauthorized: false
      }),
      maxRedirects: 0 // 禁用自动重定向，手动处理
    });

    this.MainCacheKey = 'qupanshe';
    this.name = 'qupanshe';
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

  // searchImpl 实现搜索逻辑
  private async searchImpl(client: AxiosInstance, keyword: string, ext: Record<string, any>): Promise<SearchResult[]> {
    if (DebugLog) {
      console.log(`[qupanshe] 开始搜索: keyword=${keyword}`);
    }

    // 创建带有Cookie管理的专用客户端，确保整个搜索过程使用同一个session
    const sessionClient = this.createSessionClient(client);

    if (DebugLog) {
      console.log(`[qupanshe] 创建session客户端成功，开始三步搜索流程`);
    }

    // Step 1: 获取首页formhash（使用session客户端）
    let formhash: string;
    try {
      formhash = await this.getFormhash(sessionClient);
    } catch (err) {
      if (DebugLog) {
        console.log(`[qupanshe] 获取formhash失败: ${err}`);
      }
      throw new Error(`[${this.Name()}] 获取formhash失败: ${err}`);
    }
    if (DebugLog) {
      console.log(`[qupanshe] 获取到formhash: ${formhash}`);
    }

    // Step 2: POST请求获取搜索结果URL（使用同一个session客户端）
    let searchURL: string;
    try {
      searchURL = await this.postSearchRequest(sessionClient, keyword, formhash);
    } catch (err) {
      if (DebugLog) {
        console.log(`[qupanshe] POST搜索请求失败: ${err}`);
      }
      throw new Error(`[${this.Name()}] POST搜索请求失败: ${err}`);
    }
    if (DebugLog) {
      console.log(`[qupanshe] 获取搜索URL成功: ${searchURL}`);
    }

    // Step 3: GET请求获取搜索结果（使用同一个session客户端）
    let results: SearchResult[];
    try {
      results = await this.getSearchResults(sessionClient, searchURL, keyword);
    } catch (err) {
      if (DebugLog) {
        console.log(`[qupanshe] 获取搜索结果失败: ${err}`);
      }
      throw new Error(`[${this.Name()}] 获取搜索结果失败: ${err}`);
    }
    if (DebugLog) {
      console.log(`[qupanshe] 获取搜索结果成功: 结果数=${results.length}`);
    }

    // Step 4: 关键词过滤
    const filteredResults = FilterResultsByKeyword(results, keyword);
    if (DebugLog) {
      console.log(`[qupanshe] 关键词过滤后: 过滤前=${results.length}, 过滤后=${filteredResults.length}`);
    }

    return filteredResults;
  }

  // createSessionClient 创建带有Cookie管理的HTTP客户端
  private createSessionClient(baseClient: AxiosInstance): AxiosInstance {
    // Axios自动管理cookies，这里只需要创建一个新的客户端实例
    const sessionClient = axios.create({
      timeout: baseClient.defaults.timeout,
      headers: { ...baseClient.defaults.headers },
      httpsAgent: baseClient.defaults.httpsAgent,
      maxRedirects: 0 // 禁用自动重定向，手动处理
    });

    if (DebugLog) {
      console.log(`[qupanshe] 创建带Cookie管理的session客户端，超时时间: ${sessionClient.defaults.timeout}`);
    }

    return sessionClient;
  }

  // getFormhash 从首页获取真实的formhash值
  private async getFormhash(client: AxiosInstance): Promise<string> {
    if (DebugLog) {
      console.log(`[qupanshe] 请求首页获取formhash: ${BaseURL}`);
    }

    let response;
    try {
      response = await this.doRequestWithRetry(client, {
        method: 'GET',
        url: BaseURL
      });
    } catch (err) {
      throw new Error(`GET请求失败: ${err}`);
    }

    // 解析HTML
    const $ = cheerio.load(response.data);

    // 查找formhash
    let formhash = '';
    const inputCount = $('input[name="formhash"]').length;
    if (DebugLog) {
      console.log(`[qupanshe] 找到input[name='formhash']元素数量: ${inputCount}`);
    }

    $('input[name="formhash"]').each((i, element) => {
      const s = $(element);
      const value = s.attr('value');
      if (value && value !== '') {
        formhash = value;
        if (DebugLog) {
          console.log(`[qupanshe] 找到formhash[${i}]: ${value}`);
        }
      }
    });

    if (formhash === '') {
      throw new Error('未找到formhash值');
    }

    return formhash;
  }

  // postSearchRequest 发送POST请求获取搜索结果URL
  private async postSearchRequest(client: AxiosInstance, keyword: string, formhash: string): Promise<string> {
    // 添加延时，避免请求过快
    await new Promise(resolve => setTimeout(resolve, 2000));

    // 构建POST请求
    const searchURL = `${BaseURL}/search.php?mod=forum`;
    const data = new URLSearchParams();
    data.append('formhash', formhash);
    data.append('srchtxt', keyword);
    data.append('searchsubmit', 'yes');

    if (DebugLog) {
      console.log(`[qupanshe] POST请求URL: ${searchURL}`);
      console.log(`[qupanshe] POST请求数据: ${data.toString()}`);
    }

    let response;
    try {
      response = await this.doRequestWithRetry(client, {
        method: 'POST',
        url: searchURL,
        data: data.toString(),
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        validateStatus: (status) => status >= 200 && status < 400
      });
    } catch (err) {
      throw new Error(`POST请求失败: ${err}`);
    }

    if (DebugLog) {
      console.log(`[qupanshe] POST请求响应: status=${response.status}`);
      console.log(`[qupanshe] 响应头: ${JSON.stringify(response.headers)}`);
    }

    // 从响应头获取Location
    const location = response.headers['location'] as string;
    if (DebugLog) {
      console.log(`[qupanshe] Location header: ${location}`);
    }

    // 读取响应体用于调试（非重定向状态码时）
    if (response.status !== 302 && response.status !== 301 && DebugLog) {
      let bodyStr = response.data;
      if (typeof bodyStr === 'string') {
        if (bodyStr.length > 1000) {
          console.log(`[qupanshe] 响应体(前1000字符): ${bodyStr.substring(0, 1000)}`);
        } else {
          console.log(`[qupanshe] 响应体: ${bodyStr}`);
        }
      }
    }

    if (!location) {
      throw new Error(`未获取到重定向URL，状态码: ${response.status}`);
    }

    // 将相对路径转换为完整URL
    let fullURL = location;
    if (!location.startsWith('http')) {
      fullURL = BaseURL + '/' + location.replace(/^\//, '');
    }

    return fullURL;
  }

  // getSearchResults 获取搜索结果
  private async getSearchResults(client: AxiosInstance, searchURL: string, keyword: string): Promise<SearchResult[]> {
    if (DebugLog) {
      console.log(`[qupanshe] GET搜索结果URL: ${searchURL}`);
    }

    let response;
    try {
      response = await this.doRequestWithRetry(client, {
        method: 'GET',
        url: searchURL
      });
    } catch (err) {
      throw new Error(`GET请求失败: ${err}`);
    }

    // 解析HTML
    const $ = cheerio.load(response.data);

    return this.extractSearchResults($);
  }

  // extractSearchResults 提取搜索结果
  private extractSearchResults($: cheerio.CheerioAPI): SearchResult[] {
    const results: SearchResult[] = [];

    const liCount = $('li.pbw').length;
    if (DebugLog) {
      console.log(`[qupanshe] 找到li.pbw元素数量: ${liCount}`);
    }

    $('li.pbw').each((i, element) => {
      const s = $(element);
      const result = this.parseSearchResult($, s);
      if (result.Title !== '') {
        results.push(result);
        if (DebugLog) {
          console.log(`[qupanshe] 解析结果[${i}]: title=${result.Title}, links=${result.Links.length}`);
        }
      } else {
        if (DebugLog) {
          console.log(`[qupanshe] 解析结果[${i}]: 标题为空，跳过`);
        }
      }
    });

    if (DebugLog) {
      console.log(`[qupanshe] 提取到有效结果数: ${results.length}`);
    }

    return results;
  }

  // parseSearchResult 解析单个搜索结果
  private parseSearchResult($: cheerio.CheerioAPI, s: cheerio.Cheerio): SearchResult {
    // 提取帖子ID
    const postID = s.attr('id') || '';

    // 提取标题和详情页链接
    const titleLink = s.find('h3.xs3 a').first();
    const titleHTML = titleLink.html() || '';
    const title = this.cleanTitle(titleHTML);
    const detailPath = titleLink.attr('href') || '';

    let detailURL = '';
    if (detailPath) {
      if (detailPath.startsWith('http')) {
        detailURL = detailPath;
      } else {
        detailURL = BaseURL + '/' + detailPath.replace(/^\//, '');
      }
    }

    // 提取统计信息（回复数和查看数）
    const statsText = s.find('p.xg1').first().text();
    const [replyCount, viewCount] = this.parseStats(statsText);

    // 提取内容摘要（第二个p标签）
    let content = '';
    s.find('p').each((i, pElement) => {
      if (i === 1) { // 第二个p标签是内容摘要
        content = $(pElement).text().trim();
      }
    });

    // ⭐ 重要：直接从搜索结果页的内容摘要中提取网盘链接
    let links: Link[] = [];

    // 1. 从HTML中提取<a>标签链接
    const aTagCount = s.find('p').eq(1).find('a').length;
    if (DebugLog && aTagCount > 0) {
      console.log(`[qupanshe] [${postID}] 找到<a>标签数量: ${aTagCount}`);
    }
    s.find('p').eq(1).find('a').each((i, aElement) => {
      const a = $(aElement);
      const href = a.attr('href');
      if (href) {
        if (DebugLog) {
          console.log(`[qupanshe] [${postID}] 检查链接[${i}]: ${href}`);
        }
        const linkType = this.determineLinkType(href);
        if (linkType) {
          const password = this.extractPasswordFromContent(content, href);
          links.push({
            URL: href,
            Type: linkType,
            Password: password,
          });
          if (DebugLog) {
            console.log(`[qupanshe] [${postID}] 识别到${linkType}链接: ${href}`);
          }
        }
      }
    });

    // 2. 从纯文本中提取链接（可能没有<a>标签）
    if (DebugLog) {
      console.log(`[qupanshe] [${postID}] 从文本提取链接: content长度=${content.length}`);
    }
    const textLinks = this.extractLinksFromText(content);
    if (DebugLog && textLinks.length > 0) {
      console.log(`[qupanshe] [${postID}] 从文本提取到链接数: ${textLinks.length}`);
    }
    links = links.concat(textLinks);

    // 去重
    const beforeDedupe = links.length;
    links = this.deduplicateLinks(links);
    if (DebugLog && beforeDedupe !== links.length) {
      console.log(`[qupanshe] [${postID}] 链接去重: 去重前=${beforeDedupe}, 去重后=${links.length}`);
    }

    // 提取时间、作者、分类信息（最后一个p标签）
    let publishTime = '';
    let author = '';
    let category = '';
    const lastP = s.find('p').last();
    const spans = lastP.find('span');
    if (spans.length >= 3) {
      publishTime = spans.eq(0).text().trim();
      author = spans.eq(1).find('a').text().trim();
      category = spans.eq(2).find('a').text().trim();
    }

    // 转换时间格式
    const parsedTime = this.parseTime(publishTime);

    // 构建包含详情页URL的Content
    let enrichedContent = content;
    if (detailURL) {
      enrichedContent = `${content} | 作者: ${author} | 分类: ${category} | 详情: ${detailURL}`;
    }

    // 如果没有找到帖子ID，使用时间戳
    const finalPostID = postID || Date.now().toString();

    return {
      MessageID: `${this.Name()}-${finalPostID}`,
      UniqueID: `${this.Name()}-${finalPostID}`,
      Title: title,
      Content: enrichedContent,
      Datetime: parsedTime,
      Links: links, // ⭐ 直接使用从搜索结果页提取的链接
      Channel: '', // ⭐ 重要：插件搜索结果Channel必须为空
    };
  }

  // cleanTitle 清理标题中的HTML标签
  private cleanTitle(titleHTML: string): string {
    // 移除所有HTML标签
    let title = titleHTML.replace(/<[^>]*>/g, '');

    // 清理HTML实体
    title = title.replace(/&nbsp;/g, ' ');
    title = title.replace(/&amp;/g, '&');
    title = title.replace(/&lt;/g, '<');
    title = title.replace(/&gt;/g, '>');
    title = title.replace(/&quot;/g, '"');

    return title.trim();
  }

  // determineLinkType 确定链接类型
  private determineLinkType(urlStr: string): string {
    const linkPatterns: Record<string, string> = {
      'pan\.quark\.cn': 'quark',
      'pan\.baidu\.com': 'baidu',
      'www\.alipan\.com': 'aliyun',
      'aliyundrive\.com': 'aliyun',
      'pan\.xunlei\.com': 'xunlei',
      'cloud\.189\.cn': 'tianyi',
      'pan\.uc\.cn': 'uc',
      'www\.123pan\.com': '123',
      'www\.123684\.com': '123',
      '115cdn\.com': '115',
      '115\.com': '115',
      'pan\.pikpak\.com': 'pikpak',
      'mypikpak\.com': 'pikpak',
      'caiyun\.139\.cn': 'mobile',
    };

    for (const [pattern, linkType] of Object.entries(linkPatterns)) {
      const regex = new RegExp(pattern);
      if (regex.test(urlStr)) {
        return linkType;
      }
    }

    return '';
  }

  // extractLinksFromText 从文本中提取链接
  private extractLinksFromText(text: string): Link[] {
    const links: Link[] = [];

    // 网盘链接正则模式（支持更宽泛的字符集）
    const patterns: string[] = [
      `https?://pan\.quark\.cn/s/[a-zA-Z0-9_-]+`,
      `https?://pan\.baidu\.com/s/[a-zA-Z0-9_-]+(?:\?pwd=[a-zA-Z0-9]+)?`, // 支持pwd参数
      `https?://www\.alipan\.com/s/[a-zA-Z0-9_-]+`,
      `https?://aliyundrive\.com/s/[a-zA-Z0-9_-]+`,
      `https?://pan\.xunlei\.com/s/[a-zA-Z0-9_-]+`,
      `https?://cloud\.189\.cn/[a-zA-Z0-9_/-]+`, // 天翼云支持多级路径
      `https?://pan\.uc\.cn/s/[a-zA-Z0-9_-]+`,
      `https?://www\.123pan\.com/s/[a-zA-Z0-9_-]+`,
      `https?://www\.123684\.com/s/[a-zA-Z0-9_-]+`,
      `https?://115cdn\.com/[a-zA-Z0-9_/-]+`,
      `https?://115\.com/[a-zA-Z0-9_/-]+`,
      `https?://pan\.pikpak\.com/s/[a-zA-Z0-9_-]+`,
      `https?://mypikpak\.com/s/[a-zA-Z0-9_-]+`,
      `https?://caiyun\.139\.cn/[a-zA-Z0-9_/-]+`,
    ];

    for (const pattern of patterns) {
      const regex = new RegExp(pattern, 'g');
      let match;
      while ((match = regex.exec(text)) !== null) {
        const linkType = this.determineLinkType(match[0]);
        if (linkType) {
          // 从URL参数或周围文本提取密码
          const password = this.extractPasswordFromContent(text, match[0]);
          links.push({
            URL: match[0],
            Type: linkType,
            Password: password,
          });
        }
      }
    }

    return links;
  }

  // extractPasswordFromContent 从内容文本中提取指定链接的密码
  private extractPasswordFromContent(content: string, linkURL: string): string {
    // 先尝试从URL中提取pwd参数
    try {
      const parsedURL = new URL(linkURL);
      const pwd = parsedURL.searchParams.get('pwd');
      if (pwd) {
        return pwd;
      }
    } catch (err) {
      // URL解析失败，继续使用正则提取
    }

    // 查找链接在内容中的位置
    const linkIndex = content.indexOf(linkURL);
    if (linkIndex === -1) {
      return '';
    }

    // 提取链接周围的文本（前20字符，后100字符）
    const start = Math.max(0, linkIndex - 20);
    const end = Math.min(content.length, linkIndex + linkURL.length + 100);
    const surroundingText = content.substring(start, end);

    // 查找密码模式
    const passwordPatterns: string[] = [
      `提取码[：:]\s*([A-Za-z0-9]+)`,
      `密码[：:]\s*([A-Za-z0-9]+)`,
      `pwd[：:=]\s*([A-Za-z0-9]+)`,
      `password[：:=]\s*([A-Za-z0-9]+)`,
    ];

    for (const pattern of passwordPatterns) {
      const regex = new RegExp(pattern);
      const matches = regex.exec(surroundingText);
      if (matches && matches.length > 1) {
        return matches[1];
      }
    }

    return '';
  }

  // deduplicateLinks 去重链接
  private deduplicateLinks(links: Link[]): Link[] {
    const linkMap = new Map<string, Link>();

    for (const link of links) {
      // 提取和设置密码
      const [normalizedURL, password] = this.extractPasswordFromURL(link.URL);

      // 创建带密码信息的新链接
      const newLink: Link = {
        URL: link.URL,
        Type: link.Type,
        Password: password,
      };

      // 如果链接本身没有密码但我们找到了密码，使用找到的密码
      if (!newLink.Password && link.Password) {
        newLink.Password = link.Password;
      }

      // 使用标准化URL作为key进行去重
      if (linkMap.has(normalizedURL)) {
        // 如果已存在，保留更完整的版本（优先带密码的）
        const existingLink = linkMap.get(normalizedURL)!;
        if (newLink.Password && !existingLink.Password) {
          linkMap.set(normalizedURL, newLink);
        }
      } else {
        linkMap.set(normalizedURL, newLink);
      }
    }

    // 转换为切片
    return Array.from(linkMap.values());
  }

  // extractPasswordFromURL 从URL中提取密码并返回标准化URL
  private extractPasswordFromURL(rawURL: string): [string, string] {
    // 解析URL
    let parsedURL;
    try {
      parsedURL = new URL(rawURL);
    } catch (err) {
      return [rawURL, ''];
    }

    // 获取查询参数
    const searchParams = parsedURL.searchParams;

    // 检查常见的密码参数
    const passwordKeys = ['pwd', 'password', 'pass', 'code'];
    let password = '';
    for (const key of passwordKeys) {
      const val = searchParams.get(key);
      if (val) {
        password = val;
        break;
      }
    }

    // 构建标准化URL（去除密码参数）
    for (const key of passwordKeys) {
      searchParams.delete(key);
    }

    parsedURL.search = searchParams.toString();
    let normalizedURL = parsedURL.toString();

    // 如果查询参数为空，去掉问号
    if (parsedURL.search === '') {
      normalizedURL = normalizedURL.replace(/\?$/, '');
    }

    return [normalizedURL, password];
  }

  // parseStats 解析统计信息
  private parseStats(statsText: string): [number, number] {
    // 解析如 "18 个回复 - 5926 次查看" 格式
    const regex = /(\d+)\s*个回复\s*-\s*(\d+)\s*次查看/;
    const matches = statsText.match(regex);
    if (matches && matches.length >= 3) {
      const replyCount = parseInt(matches[1], 10);
      const viewCount = parseInt(matches[2], 10);
      return [isNaN(replyCount) ? 0 : replyCount, isNaN(viewCount) ? 0 : viewCount];
    }
    return [0, 0];
  }

  // parseTime 解析时间字符串
  private parseTime(timeStr: string): Date {
    // 解析如 "2024-10-8 20:58" 格式（注意月和日可能是单数字）
    timeStr = timeStr.trim();

    const formats = [
      '2006-1-2 15:04',
      '2006-1-2 15:04:05',
      '2006-01-02 15:04',
      '2006-01-02 15:04:05',
    ];

    for (const format of formats) {
      const date = this.parseDateWithFormat(timeStr, format);
      if (!isNaN(date.getTime())) {
        return date;
      }
    }

    // 如果解析失败，返回当前时间
    return new Date();
  }

  // parseDateWithFormat 使用指定格式解析日期
  private parseDateWithFormat(dateString: string, format: string): Date {
    // 简单的日期解析实现
    const parts = dateString.split(/[-\s:]/).map(part => parseInt(part, 10));
    const formatParts = format.split(/[-\s:]/);

    const yearIndex = formatParts.indexOf('2006');
    const monthIndex = formatParts.indexOf('01') !== -1 ? formatParts.indexOf('01') : formatParts.indexOf('1');
    const dayIndex = formatParts.indexOf('02') !== -1 ? formatParts.indexOf('02') : formatParts.indexOf('2');
    const hourIndex = formatParts.indexOf('15');
    const minuteIndex = formatParts.indexOf('04');
    const secondIndex = formatParts.indexOf('05');

    const year = parts[yearIndex] || 0;
    const month = (parts[monthIndex] || 1) - 1; // 月份从0开始
    const day = parts[dayIndex] || 1;
    const hour = parts[hourIndex] || 0;
    const minute = parts[minuteIndex] || 0;
    const second = parts[secondIndex] || 0;

    return new Date(year, month, day, hour, minute, second);
  }

  // doRequestWithRetry 带重试机制的HTTP请求
  private async doRequestWithRetry(client: AxiosInstance, config: AxiosRequestConfig): Promise<any> {
    let lastErr: Error | null = null;

    for (let i = 0; i < MaxRetries; i++) {
      if (i > 0) {
        // 指数退避重试
        const backoff = Math.min(2000 * Math.pow(2, i - 1), 10000); // 最大10秒
        if (DebugLog) {
          console.log(`[qupanshe] 重试第${i}次，等待${backoff}ms`);
        }
        await new Promise(resolve => setTimeout(resolve, backoff));
      }

      try {
        const response = await client.request(config);
        // 检查状态码
        if (response.status === 503) {
          if (DebugLog) {
            console.log(`[qupanshe] 服务器返回503，继续重试`);
          }
          lastErr = new Error('服务器返回503');
          continue;
        }
        return response;
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error(String(err));
      }
    }

    throw new Error(`重试 ${MaxRetries} 次后仍然失败: ${lastErr?.message}`);
  }
}

// 创建并导出插件实例
export default new QupanshePlugin();