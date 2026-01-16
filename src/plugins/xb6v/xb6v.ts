import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios';
import cheerio from 'cheerio';
import { BaseAsyncPlugin } from '../plugin.manager';
import { SearchResult, Link } from '../../models/plugin-result';

const BaseURL = 'https://www.66ss.org'; // 主域名
const BackupURL = 'https://www.xb6v.com'; // 备用域名
const SearchPath = '/e/search/1index.php'; // 搜索端点
const UserAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36';
const MaxConcurrency = 50; // 详情页最大并发数
const MaxResults = 50; // 最大搜索结果数

interface DetailPageInfo {
  URL: string;
  DateTime: Date;
}

interface MagnetLinkInfo {
  URL: string;
  SubTitle: string;
}

interface CacheItem {
  results: SearchResult[];
  timestamp: number;
}

class Semaphore {
  private maxConcurrent: number;
  private currentConcurrent: number;
  private waiting: Array<() => void>;

  constructor(maxConcurrent: number) {
    this.maxConcurrent = maxConcurrent;
    this.currentConcurrent = 0;
    this.waiting = [];
  }

  async acquire(): Promise<void> {
    if (this.currentConcurrent < this.maxConcurrent) {
      this.currentConcurrent++;
      return;
    }

    return new Promise<void>((resolve) => {
      this.waiting.push(resolve);
    });
  }

  release(): void {
    this.currentConcurrent--;
    if (this.waiting.length > 0) {
      const next = this.waiting.shift();
      if (next) {
        this.currentConcurrent++;
        next();
      }
    }
  }
}

export class Xb6vPlugin extends BaseAsyncPlugin {
  private detailCache: Map<string, CacheItem>;
  private cacheTTL: number;
  private debugMode: boolean;
  private currentBase: string;

  constructor() {
    super('xb6v', 3, true); // 优先级3，跳过Service层过滤
    this.detailCache = new Map();
    this.cacheTTL = 30 * 60 * 1000; // 30分钟
    this.debugMode = false;
    this.currentBase = BaseURL;
  }

  Name(): string {
    return 'xb6v';
  }

  DisplayName(): string {
    return '6v电影';
  }

  Description(): string {
    return '6v电影 - 磁力链接资源站';
  }

  private async doRequestWithRetry(client: AxiosInstance, config: AxiosRequestConfig): Promise<AxiosResponse> {
    const maxRetries = 3;
    let lastError: Error | null = null;

    for (let i = 0; i < maxRetries; i++) {
      if (i > 0) {
        // 指数退避重试
        const backoff = Math.pow(2, i - 1) * 500;
        if (this.debugMode) {
          console.log(`[xb6v] 重试第${i}次，等待${backoff}ms`);
        }
        await new Promise(resolve => setTimeout(resolve, backoff));
      }

      try {
        const response = await client(config);
        if (response.status === 200) {
          return response;
        }
      } catch (error) {
        lastError = error as Error;
      }
    }

    throw new Error(`重试 ${maxRetries} 次后仍然失败: ${lastError?.message}`);
  }

  protected async searchImpl(client: AxiosInstance, keyword: string): Promise<SearchResult[]> {
    // 先进行URL解码，处理%20等编码
    let decodedKeyword = keyword;
    try {
      decodedKeyword = decodeURIComponent(keyword);
    } catch (error) {
      // 解码失败，使用原始关键词
      decodedKeyword = keyword;
    }

    // 优化关键词：如果包含空格，只使用空格前的部分
    const originalKeyword = decodedKeyword;
    const spaceIndex = decodedKeyword.indexOf(' ');
    if (spaceIndex > 0) {
      decodedKeyword = decodedKeyword.substring(0, spaceIndex);
      if (this.debugMode) {
        console.log(`[xb6v] 关键词优化: '${originalKeyword}' -> '${decodedKeyword}'`);
      }
    }

    // 使用处理后的关键词
    keyword = decodedKeyword;

    if (this.debugMode) {
      console.log(`[xb6v] 开始搜索: ${keyword} (原始: ${originalKeyword})`);
    }

    // 第一步：POST搜索请求
    const searchURL = this.currentBase + SearchPath;
    const postData = `show=title&tempid=1&tbname=article&mid=1&dopost=search&submit=&keyboard=${encodeURIComponent(keyword)}`;

    // 创建不自动重定向的客户端
    const noRedirectClient = axios.create({
      baseURL: this.currentBase,
      timeout: 30000,
      maxRedirects: 0, // 禁用自动重定向
      validateStatus: (status) => status >= 200 && status < 400
    });

    try {
      const resp = await this.doRequestWithRetry(noRedirectClient, {
        url: searchURL,
        method: 'POST',
        headers: {
          ...this.getRequestHeaders(),
          'Content-Type': 'application/x-www-form-urlencoded',
          'Referer': this.currentBase
        },
        data: postData
      });

      if (this.debugMode) {
        console.log(`[xb6v] POST响应状态码: ${resp.status}`);
      }

      // 获取重定向的location
      let location = resp.headers['location'] as string;
      if (this.debugMode) {
        console.log(`[xb6v] Location头: '${location}'`);
      }

      // 如果没有Location头，可能需要从响应体中解析
      if (!location) {
        if (this.debugMode) {
          console.log(`[xb6v] 未找到Location头，尝试解析响应体`);
        }

        const bodyStr = resp.data;
        if (this.debugMode) {
          console.log(`[xb6v] 响应体长度: ${bodyStr.length}`);
          // 只打印前500个字符避免日志过长
          if (bodyStr.length > 500) {
            console.log(`[xb6v] 响应体前500字符: ${bodyStr.substring(0, 500)}`);
          } else {
            console.log(`[xb6v] 响应体内容: ${bodyStr}`);
          }
        }

        // 尝试从响应体中提取重定向URL
        // 可能是JavaScript重定向或meta refresh
        if (bodyStr.includes('location.href') || bodyStr.includes('window.location')) {
          // JavaScript重定向
          const re = /location\.href\s*=\s*["']([^"']+)["']/;
          const matches = re.exec(bodyStr);
          if (matches && matches[1]) {
            location = matches[1];
            if (this.debugMode) {
              console.log(`[xb6v] 从JavaScript中提取到Location: ${location}`);
            }
          }
        }

        // 尝试查找其他形式的重定向
        if (!location) {
          // 查找可能的URL模式，比如包含searchid的链接
          const re = /(?:href|url)\s*[=:]\s*["']?([^"'\s]*searchid=[^"'\s&]+)/g;
          let match;
          while ((match = re.exec(bodyStr)) !== null) {
            if (match[1]) {
              location = match[1];
              if (this.debugMode) {
                console.log(`[xb6v] 从URL模式中提取到Location: ${location}`);
              }
              break;
            }
          }
        }

        // 如果还是没找到，尝试查找简单的result/?searchid=格式
        if (!location) {
          const re = /result\/\?searchid=\d+/;
          const match = re.exec(bodyStr);
          if (match) {
            location = match[0];
            if (this.debugMode) {
              console.log(`[xb6v] 从正则匹配中提取到Location: ${location}`);
            }
          }
        }

        if (!location) {
          throw new Error('未找到搜索结果页面重定向信息');
        }
      }

      // 构建完整的搜索结果URL
      // Location通常是类似 "result/?searchid=39616" 的格式，需要加上 /e/search/ 前缀
      let resultURL: string;
      if (location.startsWith('result/')) {
        resultURL = this.currentBase + '/e/search/' + location;
      } else {
        resultURL = this.currentBase + '/' + location.replace(/^\//, '');
      }

      if (this.debugMode) {
        console.log(`[xb6v] 搜索结果页面: ${resultURL}`);
      }

      // 第二步：获取搜索结果页面
      const resp2 = await this.doRequestWithRetry(client, {
        url: resultURL,
        method: 'GET',
        headers: {
          ...this.getRequestHeaders(),
          'Referer': this.currentBase
        }
      });

      if (resp2.status !== 200) {
        throw new Error(`搜索结果响应状态码异常: ${resp2.status}`);
      }

      // 解析搜索结果页面
      const $ = cheerio.load(resp2.data);

      // 提取搜索结果（详情页链接和日期）
      const detailPages = this.extractDetailURLs($);

      if (this.debugMode) {
        console.log(`[xb6v] 找到 ${detailPages.length} 个详情页链接`);
      }

      if (detailPages.length === 0) {
        throw new Error('未找到搜索结果');
      }

      // 限制结果数量
      if (detailPages.length > MaxResults) {
        detailPages.splice(MaxResults);
      }

      // 并发获取详情页的磁力链接
      const results = await this.fetchMagnetLinksFromDetails(client, detailPages, keyword);

      // 过滤空结果
      const validResults = this.filterValidResults(results);

      if (this.debugMode) {
        console.log(`[xb6v] 去除无链接结果后剩余 ${validResults.length} 个结果`);
      }

      // 插件层关键词过滤（必须执行，因为跳过了Service层过滤）
      const keywordFilteredResults = this.filterResultsByKeyword(validResults, keyword);

      if (this.debugMode) {
        console.log(`[xb6v] 关键词过滤后最终返回 ${keywordFilteredResults.length} 个结果`);
      }

      return keywordFilteredResults;
    } catch (error) {
      if (this.debugMode) {
        console.log(`[xb6v] 搜索失败: ${error}`);
      }
      throw new Error(`[${this.Name()}] 搜索失败: ${error}`);
    }
  }

  private extractDetailURLs($: cheerio.CheerioAPI): DetailPageInfo[] {
    const detailPages: DetailPageInfo[] = [];
    const urlMap = new Set<string>(); // 去重

    // 只从搜索结果区域提取链接，搜索结果在 ul#post_container 中
    $('ul#post_container li.post').each((i, li) => {
      // 提取详情页链接
      const linkEl = $(li).find("a[href*='.html']");
      if (linkEl.length === 0) {
        return;
      }

      const href = linkEl.attr('href');
      if (!href || href === '') {
        return;
      }

      if (this.debugMode) {
        console.log(`[xb6v] 找到搜索结果链接: ${href}`);
      }

      // 检查链接是否符合内容页面格式（分类/子分类/数字.html）
      if (!this.isValidContentURL(href)) {
        if (this.debugMode) {
          console.log(`[xb6v] 链接格式无效，跳过: ${href}`);
        }
        return;
      }

      // 构建完整URL
      let fullURL: string;
      if (href.startsWith('http://') || href.startsWith('https://')) {
        fullURL = href;
      } else {
        fullURL = this.currentBase + '/' + href.replace(/^\//, '');
      }

      // 去重检查
      if (urlMap.has(fullURL)) {
        return;
      }

      // 提取发布日期
      const dateText = $(li).find('.info .info_date').text().trim();
      let publishDate = new Date();

      if (dateText !== '') {
        // 解析日期，格式通常是 "2025-08-17"
        const parsedDate = new Date(dateText);
        if (!isNaN(parsedDate.getTime())) {
          publishDate = parsedDate;
        } else {
          if (this.debugMode) {
            console.log(`[xb6v] 日期解析失败: ${dateText}, 使用当前时间`);
          }
          publishDate = new Date();
        }
      } else {
        if (this.debugMode) {
          console.log(`[xb6v] 未找到日期信息，使用当前时间`);
        }
        publishDate = new Date();
      }

      urlMap.add(fullURL);
      detailPages.push({
        URL: fullURL,
        DateTime: publishDate
      });

      if (this.debugMode) {
        console.log(`[xb6v] 添加有效链接: ${fullURL}, 日期: ${publishDate.toISOString().split('T')[0]}`);
      }
    });

    if (this.debugMode) {
      console.log(`[xb6v] 提取到 ${detailPages.length} 个有效详情页链接`);
    }

    return detailPages;
  }

  private isValidContentURL(href: string): boolean {
    // 内容页面URL格式通常是：/分类/子分类/数字.html
    // 例如：/donghuapian/26525.html 或 /dianshiju/guoju/26608.html
    const parts = href.trim().replace(/^\//, '').split('/');
    if (parts.length < 2) {
      return false;
    }

    // 最后一部分应该是数字.html格式
    const lastPart = parts[parts.length - 1];
    if (!lastPart.endsWith('.html')) {
      return false;
    }

    // 提取数字部分
    const nameWithoutExt = lastPart.replace('.html', '');
    if (nameWithoutExt.length === 0) {
      return false;
    }

    // 检查是否包含数字（内容ID）
    const hasNumber = /\d+/.test(nameWithoutExt);
    return hasNumber;
  }

  private cleanTitle(title: string): string {
    // 移除常见的网站名称前缀/后缀
    const cleaners = [
      '6v电影-新版',
      '6v电影',
      '新版6v',
      '新版6V',
      '6V电影'
    ];

    let cleaned = title;
    for (const cleaner of cleaners) {
      // 移除前缀（包括可能的空格）
      if (cleaned.startsWith(cleaner)) {
        cleaned = cleaned.substring(cleaner.length).trim();
      }

      // 移除后缀（包括可能的空格）
      if (cleaned.endsWith(cleaner)) {
        cleaned = cleaned.substring(0, cleaned.length - cleaner.length).trim();
      }

      // 移除中间的网站名称（用分隔符分隔）
      const parts = cleaned.split(cleaner);
      if (parts.length > 1) {
        const validParts = parts.filter(part => part.trim() !== '');
        if (validParts.length > 0) {
          cleaned = validParts.join(' ');
        }
      }
    }

    // 清理多余的空格和特殊字符
    cleaned = cleaned.trim();
    // 移除多个连续空格
    cleaned = cleaned.replace(/\s+/g, ' ');

    if (cleaned === '') {
      return '未知标题';
    }

    return cleaned;
  }

  private async fetchMagnetLinksFromDetails(client: AxiosInstance, detailPages: DetailPageInfo[], keyword: string): Promise<SearchResult[]> {
    const results: SearchResult[] = [];
    const semaphore = new Semaphore(MaxConcurrency);

    const promises = detailPages.map(async (detailPage, idx) => {
      await semaphore.acquire();
      try {
        // 添加延迟避免请求过频
        await new Promise(resolve => setTimeout(resolve, idx * 100));

        const pageResults = await this.fetchDetailPageMagnetLinks(client, detailPage.URL, detailPage.DateTime);
        if (pageResults.length > 0) {
          results.push(...pageResults);
        }

        if (this.debugMode) {
          console.log(`[xb6v] 详情页 ${idx + 1}/${detailPages.length} 处理完成，获取到 ${pageResults.length} 个结果 (日期: ${detailPage.DateTime.toISOString().split('T')[0]})`);
        }
      } finally {
        semaphore.release();
      }
    });

    await Promise.all(promises);
    return results;
  }

  private async fetchDetailPageMagnetLinks(client: AxiosInstance, detailURL: string, publishDate: Date): Promise<SearchResult[]> {
    // 检查缓存
    const cached = this.detailCache.get(detailURL);
    if (cached) {
      if (Date.now() - cached.timestamp < this.cacheTTL) {
        if (this.debugMode) {
          console.log(`[xb6v] 使用缓存的详情页结果: ${detailURL}`);
        }
        return cached.results;
      }
      // 缓存过期，删除
      this.detailCache.delete(detailURL);
    }

    try {
      // 请求详情页
      const resp = await this.doRequestWithRetry(client, {
        url: detailURL,
        method: 'GET',
        headers: {
          ...this.getRequestHeaders(),
          'Referer': this.currentBase
        }
      });

      if (resp.status !== 200) {
        if (this.debugMode) {
          console.log(`[xb6v] 详情页响应状态码异常: ${resp.status}`);
        }
        return [];
      }

      // 解析HTML
      const $ = cheerio.load(resp.data);

      // 提取页面信息
      let title = $('h1').text().trim();
      if (title === '') {
        title = '未知标题';
      }

      // 清理title，移除网站名称
      title = this.cleanTitle(title);

      // 提取分类信息
      const category = $('.info_category a').text().trim();

      // 提取磁力链接
      const { magnetLinks, linkInfos } = this.extractMagnetLinks($, title);

      if (magnetLinks.length === 0) {
        if (this.debugMode) {
          console.log(`[xb6v] 详情页无磁力链接: ${detailURL}`);
        }
        return [];
      }

      // 生成多个SearchResult，每个磁力链接一个
      const results: SearchResult[] = [];
      for (let i = 0; i < linkInfos.length; i++) {
        const linkInfo = linkInfos[i];
        // 生成唯一的资源ID
        const resourceID = `${this.extractResourceID(detailURL)}-${i}`;

        // 构建"主标题-子标题"格式的标题
        const resultTitle = `${title}-${linkInfo.SubTitle}`;

        results.push({
          Title: resultTitle,
          Content: `分类：${category}\n磁力链接：${linkInfo.SubTitle}`,
          Channel: '', // 插件搜索结果必须为空字符串
          MessageID: `${this.Name()}-${resourceID}`,
          UniqueID: `${this.Name()}-${resourceID}`,
          Datetime: publishDate, // 使用从搜索结果页面提取的真实发布日期
          Links: [magnetLinks[i]], // 每个结果只包含一个链接
          Tags: [category]
        });
      }

      // 缓存结果
      this.detailCache.set(detailURL, {
        results,
        timestamp: Date.now()
      });

      if (this.debugMode) {
        console.log(`[xb6v] 提取到磁力链接: ${title}, 链接数: ${magnetLinks.length}`);
      }

      return results;
    } catch (error) {
      if (this.debugMode) {
        console.log(`[xb6v] 获取详情页失败: ${error}`);
      }
      return [];
    }
  }

  private extractMagnetLinks($: cheerio.CheerioAPI, mainTitle: string): { magnetLinks: Link[]; linkInfos: MagnetLinkInfo[] } {
    const magnetLinks: Link[] = [];
    const linkInfos: MagnetLinkInfo[] = [];
    const linkMap = new Set<string>(); // 去重

    // 查找包含"磁力："的表格单元格
    $('td').each((i, s) => {
      const text = $(s).text();
      if (text.includes('磁力：')) {
        // 查找该单元格中的磁力链接
        $(s).find("a[href^='magnet:']").each((j, a) => {
          const href = $(a).attr('href');
          if (!href || href === '') {
            return;
          }

          // 去重
          if (linkMap.has(href)) {
            return;
          }
          linkMap.add(href);

          // 获取链接子标题
          let subTitle = $(a).text().trim();
          if (subTitle === '') {
            subTitle = '磁力链接';
          }

          magnetLinks.push({
            URL: href,
            Type: 'magnet',
            Password: ''
          });

          linkInfos.push({
            URL: href,
            SubTitle: subTitle
          });

          if (this.debugMode) {
            console.log(`[xb6v] 提取磁力链接: ${mainTitle} - ${subTitle}`);
          }
        });
      }
    });

    // 如果没有在表格中找到，尝试在整个页面查找
    if (magnetLinks.length === 0) {
      $("a[href^='magnet:']").each((i, s) => {
        const href = $(s).attr('href');
        if (!href || href === '') {
          return;
        }

        // 去重
        if (linkMap.has(href)) {
          return;
        }
        linkMap.add(href);

        let subTitle = $(s).text().trim();
        if (subTitle === '') {
          subTitle = '磁力链接';
        }

        magnetLinks.push({
          URL: href,
          Type: 'magnet',
          Password: ''
        });

        linkInfos.push({
          URL: href,
          SubTitle: subTitle
        });

        if (this.debugMode) {
          console.log(`[xb6v] 提取磁力链接: ${mainTitle} - ${subTitle}`);
        }
      });
    }

    return { magnetLinks, linkInfos };
  }

  private extractResourceID(detailURL: string): string {
    // 从URL中提取ID，如：/dianshiju/guoju/26608.html -> 26608
    const re = /\/(\d+)\.html/;
    const matches = re.exec(detailURL);
    if (matches && matches[1]) {
      return matches[1];
    }

    // 如果提取失败，使用时间戳
    return Date.now().toString();
  }

  private filterValidResults(results: SearchResult[]): SearchResult[] {
    return results.filter(result => {
      if (result.Links.length > 0) {
        return true;
      } else if (this.debugMode) {
        console.log(`[xb6v] 忽略无磁力链接结果: ${result.Title}`);
      }
      return false;
    });
  }

  private getRequestHeaders(): Record<string, string> {
    return {
      'User-Agent': UserAgent,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'Accept-Encoding': 'gzip, deflate',
      'Cache-Control': 'no-cache',
      'Pragma': 'no-cache',
      'Connection': 'keep-alive'
    };
  }

  private filterResultsByKeyword(results: SearchResult[], keyword: string): SearchResult[] {
    const keywords = keyword.split(/\s+/).filter(k => k.length > 0);
    if (keywords.length === 0) {
      return results;
    }

    return results.filter(result => {
      const titleLower = result.Title.toLowerCase();
      const contentLower = result.Content.toLowerCase();
      return keywords.every(k => {
        const keywordLower = k.toLowerCase();
        return titleLower.includes(keywordLower) || contentLower.includes(keywordLower);
      });
    });
  }
}

// 注册插件
const plugin = new Xb6vPlugin();
plugin.register();
