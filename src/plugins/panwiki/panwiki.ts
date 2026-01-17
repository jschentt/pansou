import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios';
import * as cheerio from 'cheerio';
import { SearchResult, Link } from '../../models/plugin-result';
import { PluginManager } from '../../plugins/plugin.manager';
import { sleep } from '../../util/convert';

// 常量定义
const PRIMARY_BASE_URL = 'https://www.panwiki.com';
const BACKUP_BASE_URL = 'https://pan666.net';
const SEARCH_PATH = '/search.php?mod=forum&srchtxt=%s&searchsubmit=yes&orderby=lastpost';
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36';
const MAX_CONCURRENCY = 40;
const MAX_PAGES = 2;

// 缓存项接口
interface CacheItem {
  links: Link[];
  timestamp: number;
}

// Panwiki插件类
export class PanwikiPlugin {
  private name: string;
  private priority: number;
  private detailCache: Map<string, CacheItem>;
  private cacheTTL: number;
  private debugMode: boolean;
  private currentBaseURL: string;
  private client: AxiosInstance;

  constructor() {
    this.name = 'panwiki';
    this.priority = 3;
    this.detailCache = new Map();
    this.cacheTTL = 30 * 60 * 1000; // 30分钟
    this.debugMode = false;
    this.currentBaseURL = PRIMARY_BASE_URL;
    this.client = this.createHttpClient();

    if (this.debugMode) {
      console.log('[Panwiki] Debug模式已启用');
    }
  }

  private createHttpClient(): AxiosInstance {
    return axios.create({
      timeout: 10000,
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache'
      },
      maxRedirects: 0,
      validateStatus: status => status < 400
    });
  }

  private getSearchURL(keyword: string, page: number): string {
    if (page <= 1) {
      return `${this.currentBaseURL}${SEARCH_PATH}`.replace('%s', encodeURIComponent(keyword));
    } else {
      return `${this.currentBaseURL}${SEARCH_PATH}&page=${page}`.replace('%s', encodeURIComponent(keyword));
    }
  }

  private switchToBackupDomain(): void {
    if (this.currentBaseURL === PRIMARY_BASE_URL) {
      this.currentBaseURL = BACKUP_BASE_URL;
      if (this.debugMode) {
        console.log('[Panwiki] 切换到备用域名:', this.currentBaseURL);
      }
    }
  }

  // 信号量实现
  private createSemaphore(limit: number) {
    let count = 0;
    const queue: (() => void)[] = [];

    return {
      acquire: async () => {
        return new Promise<void>((resolve) => {
          if (count < limit) {
            count++;
            resolve();
          } else {
            queue.push(() => {
              count++;
              resolve();
            });
          }
        });
      },
      release: () => {
        count--;
        if (queue.length > 0) {
          const next = queue.shift();
          if (next) next();
        }
      }
    };
  }

  public getName(): string {
    return this.name;
  }

  public getPriority(): number {
    return this.priority;
  }

  public async search(keyword: string, ext?: Record<string, any>): Promise<SearchResult[]> {
    try {
      return await this.searchImpl(keyword);
    } catch (error) {
      console.error(`[Panwiki] 搜索失败: ${error}`);
      return [];
    }
  }

  private async searchImpl(keyword: string): Promise<SearchResult[]> {
    // 第一页搜索
    let firstPageResults: SearchResult[];
    try {
      firstPageResults = await this.searchPage(keyword, 1);
    } catch (error) {
      throw new Error(`搜索第一页失败: ${error}`);
    }

    let allResults: SearchResult[] = [...firstPageResults];

    // 多页并发搜索
    if (MAX_PAGES > 1) {
      const pageResults = new Map<number, SearchResult[]>();
      const semaphore = this.createSemaphore(MAX_CONCURRENCY);
      const promises: Promise<void>[] = [];

      for (let page = 2; page <= MAX_PAGES; page++) {
        const promise = (async () => {
          await semaphore.acquire();
          try {
            // 添加延时避免请求过快
            await sleep((page % 3) * 100);
            const results = await this.searchPage(keyword, page);
            if (results.length > 0) {
              pageResults.set(page, results);
            }
          } catch (error) {
            console.error(`[Panwiki] 第${page}页搜索失败: ${error}`);
          } finally {
            semaphore.release();
          }
        })();
        promises.push(promise);
      }

      await Promise.all(promises);

      // 按页码顺序添加结果
      for (let page = 2; page <= MAX_PAGES; page++) {
        if (pageResults.has(page)) {
          allResults = [...allResults, ...pageResults.get(page)!];
        }
      }
    }

    // 获取详情页链接
    this.enrichWithDetailLinks(allResults, keyword);

    // 进行关键词过滤
    const filteredResults = this.filterResultsByKeyword(allResults, keyword);

    return filteredResults;
  }

  private async searchPage(keyword: string, page: number): Promise<SearchResult[]> {
    // 发起初始搜索请求获取重定向URL
    let initialURL = this.getSearchURL(keyword, page);
    let req: AxiosRequestConfig = {
      method: 'GET',
      url: initialURL,
      headers: this.setRequestHeaders()
    };

    let resp: AxiosResponse;
    try {
      resp = await this.client(req);
    } catch (error) {
      // 如果主域名失败，尝试切换到备用域名
      if (this.currentBaseURL === PRIMARY_BASE_URL) {
        if (this.debugMode) {
          console.log('[Panwiki] 主域名请求失败，尝试备用域名:', error);
        }
        this.switchToBackupDomain();
        
        // 重新构建URL并重试
        initialURL = this.getSearchURL(keyword, page);
        req = {
          method: 'GET',
          url: initialURL,
          headers: this.setRequestHeaders()
        };
        
        resp = await this.client(req);
      } else {
        throw new Error(`初始请求失败: ${error}`);
      }
    }

    // 获取重定向URL
    let searchURL: string;
    const location = resp.headers['location'];
    if (!location) {
      throw new Error('未获取到重定向URL');
    }

    if (location.startsWith('http')) {
      searchURL = location;
    } else {
      searchURL = `${this.currentBaseURL}/${location.replace(/^\//, '')}`;
    }

    // 如果不是第一页，修改URL中的page参数
    if (page > 1) {
      const searchidMatch = searchURL.match(/searchid=(\d+)/);
      if (searchidMatch && searchidMatch.length > 1) {
        const searchid = searchidMatch[1];
        searchURL = `${this.currentBaseURL}/search.php?mod=forum&searchid=${searchid}&orderby=lastpost&ascdesc=desc&searchsubmit=yes&page=${page}`;
      }
    }

    // 请求实际的搜索结果页面
    const searchReq: AxiosRequestConfig = {
      method: 'GET',
      url: searchURL,
      headers: this.setRequestHeaders(),
      maxRedirects: 5
    };

    const searchResp = await this.client(searchReq);
    if (searchResp.status !== 200) {
      throw new Error(`搜索请求返回状态码: ${searchResp.status}`);
    }

    // 解析搜索结果
    const $ = cheerio.load(searchResp.data);
    return this.extractSearchResults($);
  }

  private setRequestHeaders(): Record<string, string> {
    return {
      'User-Agent': USER_AGENT,
      'Referer': `${this.currentBaseURL}/`,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'Cache-Control': 'no-cache',
      'Pragma': 'no-cache'
    };
  }

  private extractSearchResults(doc: cheerio.Root): SearchResult[] {
    const results: SearchResult[] = [];

    doc.find('.slst ul li.pbw').each((i, s) => {
      const result = this.parseSearchResult(doc, $(s));
      if (result.title) {
        results.push(result);
        if (this.debugMode) {
          console.log(`[Panwiki] 解析到结果 #${i + 1}: 标题=${result.title}`);
        }
      } else {
        if (this.debugMode) {
          console.log(`[Panwiki] 第${i + 1}项解析失败，标题为空`);
        }
      }
    });

    if (this.debugMode) {
      console.log(`[Panwiki] 共解析出 ${results.length} 个有效搜索结果`);
    }

    return results;
  }

  private parseSearchResult(doc: cheerio.Root, s: cheerio.Cheerio): SearchResult {
    // 提取标题和详情页链接
    const titleLink = s.find('h3.xs3 a').first();
    const title = this.cleanTitle(titleLink.text());
    const detailPath = titleLink.attr('href') || '';

    let detailURL = '';
    if (detailPath) {
      if (detailPath.startsWith('http')) {
        detailURL = detailPath;
      } else {
        detailURL = `${this.currentBaseURL}/${detailPath.replace(/^\//, '')}`;
      }
    }

    // 提取内容摘要
    let content = '';
    s.find('p').each((i, p) => {
      if (i === 1) { // 第二个p标签通常包含内容摘要
        content = $(p).text().trim();
      }
    });

    // 提取统计信息（回复数和查看数）
    const statsText = s.find('p.xg1').first().text();
    const [replyCount, viewCount] = this.parseStats(statsText);

    // 提取时间、作者、分类信息
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

    // 将详情页URL、作者、分类等信息包含在Content中
    let enrichedContent = content;
    if (author || category) {
      enrichedContent = `${content} | 作者: ${author} | 分类: ${category} | 详情: ${detailURL}`;
    } else if (detailURL) {
      enrichedContent = `${content} | 详情: ${detailURL}`;
    }

    // 从详情页URL中提取帖子ID
    let postID = '';
    if (detailURL) {
      const postIDMatch = detailURL.match(/tid=(\d+)/);
      if (postIDMatch && postIDMatch.length > 1) {
        postID = postIDMatch[1];
      }
    }

    // 如果没有找到帖子ID，使用时间戳
    if (!postID) {
      postID = Date.now().toString();
    }

    return {
      uniqueID: `${this.name}-${postID}`,
      datetime: parsedTime,
      title,
      content: enrichedContent,
      links: [], // 初始为空，后续从详情页获取
      tags: ['panwiki'],
      plugin: this.name
    };
  }

  private cleanTitle(title: string): string {
    title = title.trim();

    // 移除【】和[]中的广告内容（保留有用的分类信息）
    const adPatterns = [
      /【[^】]*(?:论坛|网站|\.com|\.net|\.cn)[^】]*】/g,
      /\[[^\]]*(?:论坛|网站|\.com|\.net|\.cn)[^\]]*\]/g
    ];

    for (const pattern of adPatterns) {
      title = title.replace(pattern, '');
    }

    return title.trim();
  }

  private parseStats(statsText: string): [number, number] {
    const regex = /(\d+)\s*个回复\s*-\s*(\d+)\s*次查看/;
    const match = statsText.match(regex);
    if (match && match.length >= 3) {
      const replyCount = parseInt(match[1], 10) || 0;
      const viewCount = parseInt(match[2], 10) || 0;
      return [replyCount, viewCount];
    }
    return [0, 0];
  }

  private parseTime(timeStr: string): Date {
    timeStr = timeStr.trim();

    const formats = [
      '2006-1-2 15:04',
      '2006-1-2 15:04:05'
    ];

    for (const format of formats) {
      const date = this.parseDateWithFormat(timeStr, format);
      if (date) {
        return date;
      }
    }

    // 如果解析失败，返回当前时间
    return new Date();
  }

  private parseDateWithFormat(timeStr: string, format: string): Date | null {
    // 简化的日期解析实现
    const formatParts = format.split(/[-: ]/);
    const timeParts = timeStr.split(/[-: ]/);

    if (formatParts.length !== timeParts.length) {
      return null;
    }

    const year = parseInt(timeParts[0], 10);
    const month = parseInt(timeParts[1], 10) - 1; // JavaScript月份从0开始
    const day = parseInt(timeParts[2], 10);
    const hour = parseInt(timeParts[3], 10) || 0;
    const minute = parseInt(timeParts[4], 10) || 0;
    const second = parseInt(timeParts[5], 10) || 0;

    if (isNaN(year) || isNaN(month) || isNaN(day)) {
      return null;
    }

    return new Date(year, month, day, hour, minute, second);
  }

  private async enrichWithDetailLinks(results: SearchResult[], keyword: string): Promise<void> {
    if (results.length === 0) {
      if (this.debugMode) {
        console.log('[Panwiki] 没有结果需要获取详情页链接');
      }
      return;
    }

    if (this.debugMode) {
      console.log(`[Panwiki] 开始为 ${results.length} 个结果获取详情页链接`);
    }

    const semaphore = this.createSemaphore(MAX_CONCURRENCY);
    const promises: Promise<void>[] = [];

    for (let i = 0; i < results.length; i++) {
      const promise = (async () => {
        await semaphore.acquire();
        try {
          // 添加延时避免请求过快
          await sleep((i % 3) * 50);

          // 从Content中提取详情页URL
          const detailURL = this.extractDetailURLFromContent(results[i].content);
          if (detailURL) {
            if (this.debugMode) {
              console.log(`[Panwiki] 结果#${i + 1} 提取到详情页URL: ${detailURL}`);
            }
            const links = await this.fetchDetailPageLinksWithKeyword(detailURL, keyword);
            if (links.length > 0) {
              results[i].links = [...results[i].links, ...links];
              if (this.debugMode) {
                console.log(`[Panwiki] 结果#${i + 1} 从详情页获取到 ${links.length} 个链接`);
              }
            } else {
              if (this.debugMode) {
                console.log(`[Panwiki] 结果#${i + 1} 详情页未获取到有效链接`);
              }
            }
          } else {
            if (this.debugMode) {
              console.log(`[Panwiki] 结果#${i + 1} 未找到详情页URL`);
            }
          }
        } catch (error) {
          console.error(`[Panwiki] 获取结果#${i + 1}的详情页链接失败: ${error}`);
        } finally {
          semaphore.release();
        }
      })();
      promises.push(promise);
    }

    await Promise.all(promises);

    if (this.debugMode) {
      let totalLinks = 0;
      for (let i = 0; i < results.length; i++) {
        totalLinks += results[i].links.length;
        console.log(`[Panwiki] 结果#${i + 1} 最终链接数: ${results[i].links.length}`);
      }
      console.log(`[Panwiki] 详情页链接获取完成，总计获得 ${totalLinks} 个链接`);
    }
  }

  private async fetchDetailPageLinksWithKeyword(detailURL: string, keyword: string): Promise<Link[]> {
    if (!detailURL) {
      if (this.debugMode) {
        console.log('[Panwiki] 详情页URL为空，跳过获取链接');
      }
      return [];
    }

    if (this.debugMode) {
      console.log(`[Panwiki] 开始获取详情页链接: ${detailURL}`);
    }

    // 检查缓存
    const cached = this.detailCache.get(detailURL);
    if (cached) {
      if (Date.now() - cached.timestamp < this.cacheTTL) {
        return cached.links;
      }
    }

    try {
      const req: AxiosRequestConfig = {
        method: 'GET',
        url: detailURL,
        headers: this.setRequestHeaders(),
        maxRedirects: 5
      };

      const resp = await this.client(req);
      if (resp.status !== 200) {
        return [];
      }

      const doc = cheerio.load(resp.data);
      const links = this.extractDetailPageLinksWithFilter(doc, keyword);

      // 缓存结果
      this.detailCache.set(detailURL, {
        links,
        timestamp: Date.now()
      });

      return links;
    } catch (error) {
      console.error(`[Panwiki] 获取详情页链接失败: ${error}`);
      return [];
    }
  }

  private extractDetailPageLinksWithFilter(doc: cheerio.Root, keyword: string): Link[] {
    let allLinks: Link[] = [];

    if (this.debugMode) {
      console.log('[Panwiki] ==================== 开始智能过滤详情页链接 ====================');
      console.log(`[Panwiki] 关键词: ${keyword}`);
    }

    // 查找主要内容区域
    let contentArea = doc.find(".t_f[id^=\"postmessage_\"]").first();
    if (contentArea.length === 0) {
      contentArea = doc.find(".t_msgfont, .plhin, .message, [id^='postmessage_']");
    }

    if (contentArea.length === 0) {
      return allLinks;
    }

    // 先直接提取所有链接，看有多少个
    const allFoundLinks = this.extractAllLinksDirectly(contentArea);

    if (this.debugMode) {
      console.log(`[Panwiki] 提取到链接总数: ${allFoundLinks.length}`);
    }

    // 核心策略：4个或以下链接直接返回，超过4个才进行内容匹配
    if (allFoundLinks.length <= 4) {
      if (this.debugMode) {
        console.log('[Panwiki] 链接数≤4，直接返回（帖子标题就是资源标题）');
      }
      return allFoundLinks;
    }

    // 超过4个链接，需要精确匹配
    if (this.debugMode) {
      console.log('[Panwiki] 链接数>4，需要精确匹配');
    }

    // 获取HTML内容进行分析
    const htmlContent = contentArea.html() || '';
    const lines = htmlContent.split('\n');

    // 检查是否是单行格式
    if (this.isSingleLineFormat(lines, keyword)) {
      if (this.debugMode) {
        console.log('[Panwiki] 检测到单行格式，使用精确匹配');
      }
      return this.extractLinksFromSingleLineFormat(lines, keyword);
    }

    // 非单行格式，使用分组逻辑
    if (this.debugMode) {
      console.log('[Panwiki] 非单行格式，使用分组逻辑');
    }
    return this.extractLinksWithGrouping(htmlContent, keyword);
  }

  private extractAllLinksDirectly(contentArea: cheerio.Cheerio): Link[] {
    const links: Link[] = [];
    const foundURLs: Set<string> = new Set();

    if (this.debugMode) {
      console.log('[Panwiki] 开始直接提取链接（简单情况）');
    }

    // 提取直接的链接
    contentArea.find('a').each((i, a) => {
      const href = $(a).attr('href');
      if (!href) return;

      if (this.debugMode) {
        console.log(`[Panwiki] 找到a标签链接: ${href}`);
      }

      const linkType = this.determineLinkType(href);
      if (linkType) {
        // 从内容文本中查找对应的密码
        const password = this.extractPasswordFromContent(contentArea.text(), href);
        const link = { type: linkType, url: href, password };
        const urlKey = this.extractPasswordFromURL(href)[0]; // 使用标准化URL作为key
        if (!foundURLs.has(urlKey)) {
          foundURLs.add(urlKey);
          links.push(link);
          if (this.debugMode) {
            console.log(`[Panwiki] 识别为网盘链接: ${href} (类型: ${linkType})`);
          }
        }
      } else if (this.debugMode) {
        console.log(`[Panwiki] 不是支持的网盘链接: ${href}`);
      }
    });

    // 提取文本中的链接
    const contentText = contentArea.text();
    if (this.debugMode) {
      console.log(`[Panwiki] 内容文本长度: ${contentText.length}`);
      if (contentText.length < 500) {
        console.log(`[Panwiki] 内容文本: ${contentText}`);
      }
    }

    const textLinks = this.extractLinksFromText(contentText);
    if (this.debugMode) {
      console.log(`[Panwiki] 从文本提取到 ${textLinks.length} 个链接`);
    }

    // 合并并去重
    for (const link of textLinks) {
      const urlKey = this.extractPasswordFromURL(link.url)[0];
      if (!foundURLs.has(urlKey)) {
        foundURLs.add(urlKey);
        links.push(link);
      }
    }

    if (this.debugMode) {
      console.log(`[Panwiki] 直接提取完成: 共 ${links.length} 个链接`);
    }

    return links;
  }

  private extractLinksWithGrouping(htmlContent: string, keyword: string): Link[] {
    let allLinks: Link[] = [];

    // 按行分割并分组处理
    const lines = htmlContent.split('\n');

    // 使用传统的分组逻辑
    let currentGroup: string[] = [];
    let isRelevantGroup = false;

    for (const line of lines) {
      const cleanLine = this.cleanHtmlText(line);

      // 跳过空行和无意义内容
      if (cleanLine.trim().length < 5) {
        continue;
      }

      // 检查是否是新的作品标题行
      const isTitle = this.isNewWorkTitle(cleanLine);
      if (this.debugMode) {
        console.log(`[Panwiki] 检查标题: '${cleanLine}' -> 是否为标题: ${isTitle}`);
      }
      if (isTitle) {
        // 处理之前的组
        if (currentGroup.length > 0 && isRelevantGroup) {
          const groupLinks = this.extractLinksFromGroup(currentGroup);
          allLinks = [...allLinks, ...groupLinks];
          if (this.debugMode) {
            console.log(`[Panwiki] 从相关组提取到 ${groupLinks.length} 个链接`);
          }
        }

        // 开始新组
        currentGroup = [line];
        isRelevantGroup = this.isWorkTitleRelevant(cleanLine, keyword);

        if (this.debugMode) {
          console.log(`[Panwiki] 新作品组: ${cleanLine}, 相关性: ${isRelevantGroup}, 关键词: ${keyword}`);
        }
      } else {
        // 添加到当前组
        if (currentGroup.length > 0) {
          currentGroup.push(line);
          if (this.debugMode && line.includes('http')) {
            console.log(`[Panwiki] 添加链接行到当前组: ${cleanLine}`);
          }
        }
      }
    }

    // 处理最后一组
    if (currentGroup.length > 0 && isRelevantGroup) {
      const groupLinks = this.extractLinksFromGroup(currentGroup);
      allLinks = [...allLinks, ...groupLinks];
      if (this.debugMode) {
        console.log(`[Panwiki] 从最后相关组提取到 ${groupLinks.length} 个链接`);
      }
    }

    if (this.debugMode) {
      console.log(`[Panwiki] 分组过滤完成，共提取 ${allLinks.length} 个相关链接`);
    }

    return this.deduplicateLinks(allLinks);
  }

  private isSingleLineFormat(lines: string[], keyword: string): boolean {
    let validLineCount = 0;
    let matchingLineCount = 0;

    // 检查有多少行符合"作品名丨网盘：链接"或"作品名：子标题丨网盘：链接"格式
    const singleLinePattern = /[^丨]*丨[^：]*：https?:\/\/[^\s]+/;

    for (const line of lines) {
      const cleanLine = this.cleanHtmlText(line);
      if (cleanLine.trim().length < 10) {
        continue;
      }

      // 检查是否符合单行格式
      if (singleLinePattern.test(cleanLine)) {
        validLineCount++;

        // 检查是否与关键词相关
        if (this.isLineTitleRelevant(cleanLine, keyword)) {
          matchingLineCount++;
        }

        if (this.debugMode) {
          console.log(`[Panwiki] 单行格式检查: '${cleanLine}', 相关性: ${this.isLineTitleRelevant(cleanLine, keyword)}`);
        }
      }
    }

    // 如果有至少2行符合单行格式，且有匹配的行，就认为是单行格式
    const isMatch = validLineCount >= 2 && matchingLineCount > 0;

    if (this.debugMode) {
      console.log(`[Panwiki] 单行格式判断: 有效行=${validLineCount}, 匹配行=${matchingLineCount}, 结果=${isMatch}`);
    }

    return isMatch;
  }

  private extractLinksFromSingleLineFormat(lines: string[], keyword: string): Link[] {
    let allLinks: Link[] = [];

    for (const line of lines) {
      const cleanLine = this.cleanHtmlText(line);
      if (cleanLine.trim().length < 10) {
        continue;
      }

      // 检查是否包含"丨"和"："的单行格式
      if (cleanLine.includes('丨') && cleanLine.includes('：')) {
        if (this.debugMode) {
          console.log(`[Panwiki] 处理单行格式: ${cleanLine}`);
        }

        // 精确提取相关作品的链接
        const relevantLinks = this.extractLinksFromSingleLine(cleanLine, keyword);
        allLinks = [...allLinks, ...relevantLinks];
      }
    }

    if (this.debugMode) {
      console.log(`[Panwiki] 单行格式处理完成，共提取 ${allLinks.length} 个链接`);
    }

    return this.deduplicateLinks(allLinks);
  }

  private extractLinksFromSingleLine(line: string, keyword: string): Link[] {
    const results: Link[] = [];

    // 使用正则表达式匹配 "作品名丨网盘：链接" 的完整模式
    const pattern = /([^丨]+)丨([^：]+)：(https?:\/\/[a-zA-Z0-9\.\-\_\?\=\&\/]+)/g;
    let match;

    if (this.debugMode) {
      console.log(`[Panwiki] 单行匹配模式`);
    }

    while ((match = pattern.exec(line)) !== null) {
      if (match.length >= 4) {
        const workName = match[1].trim();
        const netdisk = match[2].trim();
        const url = match[3].trim();

        if (this.debugMode) {
          console.log(`[Panwiki] 作品: '${workName}', 网盘: '${netdisk}', 链接: '${url}'`);
        }

        if (this.isWorkTitleRelevant(workName, keyword)) {
          const linkType = this.determineLinkType(url);
          if (linkType) {
            const password = this.extractPasswordFromURL(url)[1];

            results.push({ type: linkType, url, password });

            if (this.debugMode) {
              console.log(`[Panwiki] ✅ 相关作品链接: ${workName} -> ${url}`);
            }
          }
        } else if (this.debugMode) {
          console.log(`[Panwiki] ❌ 不相关作品: ${workName}`);
        }
      }
    }

    return results;
  }

  private isLineTitleRelevant(line: string, keyword: string): boolean {
    // 改进版：处理一行多个作品的情况
    // 使用正则表达式找到所有的"作品名丨网盘："模式
    const workPattern = /([^丨]+)丨[^：]+：/g;
    let match;

    if (this.debugMode) {
      console.log(`[Panwiki] 单行标题相关性检查: 原行='${line}', 关键词='${keyword}'`);
    }

    while ((match = workPattern.exec(line)) !== null) {
      if (match.length > 1) {
        const workTitle = match[1].trim();
        if (this.debugMode) {
          console.log(`[Panwiki] 检查作品标题: '${workTitle}'`);
        }
        if (this.isWorkTitleRelevant(workTitle, keyword)) {
          if (this.debugMode) {
            console.log(`[Panwiki] ✅ 找到相关作品: '${workTitle}'`);
          }
          return true;
        }
      }
    }

    if (this.debugMode) {
      console.log(`[Panwiki] 单行标题相关性结果: false`);
    }

    return false;
  }

  private containsNetworkLink(text: string): boolean {
    const networkDomains = [
      'pan.quark.cn', 'pan.baidu.com', 'www.alipan.com', 'caiyun.139.com',
      'pan.xunlei.com', 'drive.uc.cn', 'www.123684.com', '115cdn.com',
      'cloud.189.cn', 'pan.uc.cn', 'www.123pan.com', 'pan.pikpak.com'
    ];

    for (const domain of networkDomains) {
      if (text.includes(domain)) {
        return true;
      }
    }
    return false;
  }

  private cleanHtmlText(html: string): string {
    // 移除HTML标签
    const text = html.replace(/<[^>]*>/g, '');
    // 清理HTML实体
    return text
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .trim();
  }

  private isNewWorkTitle(text: string): boolean {
    text = text.trim();

    // 如果文本太短，不太可能是标题
    if (text.length < 3) {
      if (this.debugMode) {
        console.log(`[Panwiki] 标题检查 '${text}': 太短，不是标题`);
      }
      return false;
    }

    // 1. 包含年份 (2025)
    if (/\(\d{4}\)/.test(text)) {
      if (this.debugMode) {
        console.log(`[Panwiki] 标题检查 '${text}': 匹配年份格式`);
      }
      return true;
    }

    // 2. 包含分类标签 [剧情]、[古装]等 或 【作品名】格式
    if (/\[[^\]]*\]|【[^\]]*】/.test(text)) {
      if (this.debugMode) {
        console.log(`[Panwiki] 标题检查 '${text}': 匹配标签格式`);
      }
      return true;
    }

    // 3. 包含明显的作品信息  
    const indicators = [
      '4K持续更新', '集完结', '完结', '4K高码', '持续更新',
      '全集', '集】', '更新', '剧版', '真人版', '动画版'
    ];
    for (const indicator of indicators) {
      if (text.includes(indicator)) {
        if (this.debugMode) {
          console.log(`[Panwiki] 标题检查 '${text}': 匹配指示词 '${indicator}'`);
        }
        return true;
      }
    }

    // 4. 检查集数格式：【全30集】、【40全】、[全36集]等
    if (/【[全\d]+[集\d]*】|【\d+[全集]】|\[\d+[全集]\]|【完结】/.test(text)) {
      if (this.debugMode) {
        console.log(`[Panwiki] 标题检查 '${text}': 匹配集数格式`);
      }
      return true;
    }

    // 排除明显不是标题的内容
    const nonTitlePrefixes = [
      '导演:', '编剧:', '主演:', '类型:', '制片国家', '语言:', '首播:', 
      '集数:', '单集片长:', '评分:', '简介:', '链接：', '链接:',
      '夸克网盘：', '百度网盘：', '阿里云盘：', '迅雷网盘：'
    ];
    for (const prefix of nonTitlePrefixes) {
      if (text.startsWith(prefix)) {
        if (this.debugMode) {
          console.log(`[Panwiki] 标题检查 '${text}': 排除非标题内容`);
        }
        return false;
      }
    }

    // 5. 检查是否是常见作品名称格式（仅包含中文、英文、数字、少量符号）
    // 且不包含HTML标记或URL
    if (!text.includes('http') && !text.includes('<') && !text.includes('>')) {
      // 优先检查短标题（3-6个字符，如"定风波"、"锦月如歌"）
      const textLength = text.length;

      if (textLength >= 3 && textLength <= 6) {
        // 短标题：主要是中文字符
        const chineseCount = (text.match(/[\u4e00-\u9fff]/g) || []).length;
        const chineseRatio = chineseCount / textLength;

        if (this.debugMode) {
          console.log(`[Panwiki] 标题检查 '${text}': 短标题检查 - 长度=${textLength}, 中文字符数=${chineseCount}, 中文比例=${(chineseRatio * 100).toFixed(1)}%`);
        }

        // 如果主要是中文字符，认为是短标题
        if (chineseRatio >= 0.8) { // 至少80%是中文
          if (this.debugMode) {
            console.log(`[Panwiki] 标题检查 '${text}': 匹配短中文标题`);
          }
          return true;
        }
      }

      // 检查是否是常见作品名称格式
      if (/^[\u4e00-\u9fff\w\s\-\(\)（）]+$/.test(text)) {
        if (this.debugMode) {
          console.log(`[Panwiki] 标题检查 '${text}': 匹配作品名称格式`);
        }
        return true;
      }
    }

    if (this.debugMode) {
      console.log(`[Panwiki] 标题检查 '${text}': 不符合任何标题规则`);
    }
    return false;
  }

  private isWorkTitleRelevant(title: string, keyword: string): boolean {
    // 标准化 - 移除空格和点号
    const normalizedTitle = title.toLowerCase().replace(/[ .]/g, '');
    const normalizedKeyword = keyword.toLowerCase().replace(/[ .]/g, '');

    if (this.debugMode) {
      console.log(`[Panwiki] 相关性检查 - 原标题: ${title}, 原关键词: ${keyword}`);
      console.log(`[Panwiki] 相关性检查 - 标准化标题: ${normalizedTitle}, 标准化关键词: ${normalizedKeyword}`);
    }

    // 针对"凡人修仙传"的严格检查
    if (normalizedKeyword === '凡人修仙传') {
      // 只有真正包含"凡人修仙传"相关内容的标题才算相关
      const relevantPatterns = [
        '凡人修仙传', '凡.人.修.仙.传', '凡人修仙', '修仙传',
        'fanrenxiuxianchuan', 'fanren', 'xiuxian'
      ];

      for (const pattern of relevantPatterns) {
        const normalizedPattern = pattern.toLowerCase().replace(/[ .]/g, '');
        if (normalizedTitle.includes(normalizedPattern)) {
          if (this.debugMode) {
            console.log(`[Panwiki] 匹配到相关模式: ${pattern}`);
          }
          return true;
        }
      }

      if (this.debugMode) {
        console.log('[Panwiki] 凡人修仙传检查：不相关');
      }
      return false;
    }

    // 对于其他关键词，进行精确匹配
    if (normalizedTitle.includes(normalizedKeyword)) {
      if (this.debugMode) {
        console.log('[Panwiki] 其他关键词精确匹配成功');
      }
      return true;
    }

    if (this.debugMode) {
      console.log('[Panwiki] 不相关');
    }

    return false;
  }

  private extractLinksFromGroup(group: string[]): Link[] {
    const links: Link[] = [];
    const foundURLs: Set<string> = new Set();

    // 将组合并成HTML文档进行解析
    const groupHTML = group.join('\n');
    const doc = cheerio.load(`<div>${groupHTML}</div>`);

    // 提取链接
    doc.find('a').each((i, a) => {
      const href = $(a).attr('href');
      if (!href) return;

      const linkType = this.determineLinkType(href);
      if (linkType) {
        const urlKey = this.extractPasswordFromURL(href)[0];
        if (!foundURLs.has(urlKey)) {
          foundURLs.add(urlKey);
          links.push({ type: linkType, url: href, password: '' });
        }
      }
    });

    // 从文本中提取链接
    const text = doc.text();
    const textLinks = this.extractLinksFromText(text);
    for (const link of textLinks) {
      const urlKey = this.extractPasswordFromURL(link.url)[0];
      if (!foundURLs.has(urlKey)) {
        foundURLs.add(urlKey);
        links.push(link);
      }
    }

    return links;
  }

  private determineLinkType(url: string): string {
    const linkPatterns: Record<string, string> = {
      'pan\.quark\.cn': 'quark',
      'pan\.baidu\.com': 'baidu',
      'www\.alipan\.com': 'aliyun',
      'pan\.xunlei\.com': 'xunlei',
      'cloud\.189\.cn': 'tianyi',
      'pan\.uc\.cn': 'uc',
      'www\.123pan\.com': '123',
      'www\.123684\.com': '123',
      '115cdn\.com': '115',
      'pan\.pikpak\.com': 'pikpak',
      'caiyun\.139\.cn': 'mobile'
    };

    for (const pattern in linkPatterns) {
      if (new RegExp(pattern).test(url)) {
        return linkPatterns[pattern];
      }
    }

    return '';
  }

  private extractLinksFromText(text: string): Link[] {
    const links: Link[] = [];
    const foundURLs: Set<string> = new Set();

    // 网盘链接正则模式
    const patterns = [
      'https://pan\.quark\.cn/s/[a-zA-Z0-9_-]+',
      'https://pan\.baidu\.com/s/[a-zA-Z0-9_-]+',
      'https://www\.alipan\.com/s/[a-zA-Z0-9_-]+',
      'https://pan\.xunlei\.com/s/[a-zA-Z0-9_-]+',
      'https://cloud\.189\.cn/[a-zA-Z0-9_-]+',
      'https://pan\.uc\.cn/s/[a-zA-Z0-9_-]+',
      'https://www\.123pan\.com/s/[a-zA-Z0-9_-]+',
      'https://www\.123684\.com/s/[a-zA-Z0-9_-]+',
      'https://115cdn\.com/s/[a-zA-Z0-9_-]+',
      'https://pan\.pikpak\.com/s/[a-zA-Z0-9_-]+',
      'https://caiyun\.139\.cn/s/[a-zA-Z0-9_-]+'
    ];

    for (const pattern of patterns) {
      const regex = new RegExp(pattern, 'g');
      let match;
      while ((match = regex.exec(text)) !== null) {
        const linkType = this.determineLinkType(match[0]);
        if (linkType) {
          const urlKey = this.extractPasswordFromURL(match[0])[0];
          if (!foundURLs.has(urlKey)) {
            foundURLs.add(urlKey);
            const password = this.extractPasswordFromURL(match[0])[1];
            links.push({ type: linkType, url: match[0], password });
          }
        }
      }
    }

    return links;
  }

  private deduplicateLinks(links: Link[]): Link[] {
    const linkMap = new Map<string, Link>();

    for (const link of links) {
      // 提取和设置密码
      const [normalizedURL, password] = this.extractPasswordFromURL(link.url);

      // 创建带密码信息的新链接
      const newLink = { ...link, password };

      // 使用标准化URL作为key进行去重
      const existingLink = linkMap.get(normalizedURL);
      if (existingLink) {
        // 如果已存在，保留更完整的版本（优先带密码的）
        if (password && !existingLink.password) {
          linkMap.set(normalizedURL, newLink);
        } else if (!password && existingLink.password) {
          // 保持原有的（已有密码的版本）
          continue;
        } else if (link.url.length > existingLink.url.length) {
          // 保留URL更长的版本（通常更完整）
          linkMap.set(normalizedURL, newLink);
        }
      } else {
        linkMap.set(normalizedURL, newLink);
      }
    }

    // 转换为切片
    const result: Link[] = [];
    linkMap.forEach(link => result.push(link));

    if (this.debugMode) {
      console.log(`[Panwiki] 去重前: ${links.length} 个链接, 去重后: ${result.length} 个链接`);
    }

    return result;
  }

  private extractPasswordFromURL(rawURL: string): [string, string] {
    try {
      const url = new URL(rawURL);
      const passwordKeys = ['pwd', 'password', 'pass', 'code'];
      let password = '';

      // 检查常见的密码参数
      for (const key of passwordKeys) {
        if (url.searchParams.has(key)) {
          password = url.searchParams.get(key) || '';
          break;
        }
      }

      // 构建标准化URL（去除密码参数）
      for (const key of passwordKeys) {
        url.searchParams.delete(key);
      }

      let normalizedURL = url.toString();

      // 如果查询参数为空，去掉问号
      if (url.searchParams.toString() === '') {
        normalizedURL = normalizedURL.replace(/\?$/, '');
      }

      return [normalizedURL, password];
    } catch (error) {
      return [rawURL, ''];
    }
  }

  private extractDetailURLFromContent(content: string): string {
    // 查找详情URL模式
    const re = /详情:\s*(https?:\/\/[^\s]+)/;
    const match = content.match(re);
    if (match && match.length > 1) {
      return match[1];
    }
    return '';
  }

  private extractPasswordFromContent(content: string, linkURL: string): string {
    // 查找链接在内容中的位置
    const linkIndex = content.indexOf(linkURL);
    if (linkIndex === -1) {
      return '';
    }

    // 提取链接周围的文本（前20字符，后100字符）- 缩小范围避免错误匹配
    const start = Math.max(0, linkIndex - 20);
    const end = Math.min(content.length, linkIndex + linkURL.length + 100);
    const surroundingText = content.substring(start, end);

    // 查找密码模式
    const passwordPatterns = [
      /提取码[：:]\s*([A-Za-z0-9]+)/,
      /密码[：:]\s*([A-Za-z0-9]+)/,
      /pwd[：:=]\s*([A-Za-z0-9]+)/,
      /password[：:=]\s*([A-Za-z0-9]+)/
    ];

    for (const pattern of passwordPatterns) {
      const match = surroundingText.match(pattern);
      if (match && match.length > 1) {
        if (this.debugMode) {
          console.log(`[Panwiki] 为链接 ${linkURL} 找到密码: ${match[1]}`);
        }
        return match[1];
      }
    }

    // 也尝试从URL查询参数中提取
    return this.extractPasswordFromURL(linkURL)[1];
  }

  private filterResultsByKeyword(results: SearchResult[], keyword: string): SearchResult[] {
    const lowerKeyword = keyword.toLowerCase();
    return results.filter(result => {
      return (
        result.title.toLowerCase().includes(lowerKeyword) ||
        result.content.toLowerCase().includes(lowerKeyword)
      );
    });
  }
}

// 注册插件
PluginManager.register(new PanwikiPlugin());
