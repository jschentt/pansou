import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios';
import { BaseAsyncPlugin } from '../plugin.manager';
import { SearchResult, Link } from '../../models/plugin-result';
import * as cheerio from 'cheerio';

// 常量定义
const pluginName = "dyyj";
const displayName = "电影云集";
const description = "电影云集 - 影视资源网盘链接搜索";
const baseURL = "https://bbs.dyyjmax.org";
const searchPath = "/?q=%s";
const userAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36";
const maxResults = 100;
const maxConcurrency = 100;
const requestTimeout = 30000;
const cacheTTL = 30 * 60 * 1000; // 30分钟

// 正则表达式
const postIDRegex = /\/d\/(\d+)/;
const noscriptRegex = /<noscript[^>]*id=["']flarum-content["'][^>]*>([\s\S]*?)<\/noscript>/;
const liLinkRegex = /<li[^>]*>\s*<a[^>]*href=["']([^"']*\/d\/[^"']*)["'][^>]*>([\s\S]*?)<\/a>\s*<\/li>/g;
const htmlTagRegex = /<[^>]+>/g;
const linkHrefRegex = /href=["']([^"']*\/d\/[^"']*)["']/g;

// 发布时间正则表达式
const publishTimeRegexes = [
  /<meta\s+name=["']article:published_time["']\s+content=["']([^"']+)["']/,
  /<meta\s+property=["']article:published_time["']\s+content=["']([^"']+)["']/,
  /<meta\s+name=["']article:updated_time["']\s+content=["']([^"']+)["']/,
  /<time[^>]*datetime=["']([^"']+)["']/,
];

// 网盘链接匹配模式
const networkDiskPatterns = [
  { name: "夸克网盘", regex: /<p><strong>夸克[^<]*<\/strong><\/p>\s*<p><a[^>]*href\s*=\s*["']([^"']+)["'][^>]*>/g, urlType: "quark" },
  { name: "百度网盘", regex: /<p><strong>百度[^<]*<\/strong><\/p>\s*<p><a[^>]*href\s*=\s*["']([^"']+)["'][^>]*>/g, urlType: "baidu" },
  { name: "阿里云盘", regex: /<p><strong>阿里[^<]*<\/strong><\/p>\s*<p><a[^>]*href\s*=\s*["']([^"']+)["'][^>]*>/g, urlType: "aliyun" },
  { name: "天翼云盘", regex: /<p><strong>天翼[^<]*<\/strong><\/p>\s*<p><a[^>]*href\s*=\s*["']([^"']+)["'][^>]*>/g, urlType: "tianyi" },
  { name: "迅雷网盘", regex: /<p><strong>迅雷[^<]*<\/strong><\/p>\s*<p><a[^>]*href\s*=\s*["']([^"']+)["'][^>]*>/g, urlType: "xunlei" },
  { name: "通用网盘", regex: /<a[^>]*href\s*=\s*["'](https?:\/\/[^"']*(?:pan|drive|cloud)[^"']*)["'][^>]*>/g, urlType: "others" },
];

// 缓存相关
interface CacheItem {
  links: Link[];
  publishTime: Date;
  timestamp: number;
}

const detailCache = new Map<string, CacheItem>();

// 启动缓存清理定时器
setInterval(() => {
  const now = Date.now();
  detailCache.forEach((value, key) => {
    if (now - value.timestamp > cacheTTL) {
      detailCache.delete(key);
    }
  });
}, 5 * 60 * 1000); // 每5分钟清理一次

export class DyyjPlugin extends BaseAsyncPlugin {
  private debugMode: boolean;

  constructor() {
    super(pluginName, 2); // 质量良好，优先级2
    this.debugMode = false; // 生产环境关闭调试
  }

  Name(): string {
    return pluginName;
  }

  DisplayName(): string {
    return displayName;
  }

  Description(): string {
    return description;
  }

  protected async searchImpl(client: AxiosInstance, keyword: string): Promise<SearchResult[]> {
    try {
      if (this.debugMode) {
        console.log(`[DYYJ] 开始搜索: ${keyword}`);
      }

      // 第一步：执行搜索获取结果列表
      const searchResults = await this.executeSearch(client, keyword);

      if (this.debugMode) {
        console.log(`[DYYJ] 搜索获取到 ${searchResults.length} 个结果`);
      }

      // 第二步：先对标题进行关键词过滤，只处理包含关键词的结果（避免不必要的详情页请求）
      const titleFilteredResults = this.filterByTitleKeyword(searchResults, keyword);
      if (this.debugMode) {
        console.log(`[DYYJ] 标题关键词过滤后剩余 ${titleFilteredResults.length} 个结果（将只对这些结果获取详情页）`);
      }

      // 第三步：并发获取详情页链接（只对标题包含关键词的结果）
      const finalResults = await this.fetchDetailLinks(client, titleFilteredResults, keyword);

      if (this.debugMode) {
        console.log(`[DYYJ] 最终获取到 ${finalResults.length} 个有效结果`);
      }

      // 第四步：最终关键词过滤（对标题和内容都进行过滤，标准网盘插件需要过滤）
      const filteredResults = this.filterResultsByKeyword(finalResults, keyword);

      if (this.debugMode) {
        console.log(`[DYYJ] 最终关键词过滤后剩余 ${filteredResults.length} 个结果`);
      }

      return filteredResults;
    } catch (error) {
      console.error(`[DYYJ] 搜索失败:`, error);
      return [];
    }
  }

  private async executeSearch(client: AxiosInstance, keyword: string): Promise<SearchResult[]> {
    // 构建搜索URL
    const searchURL = `${baseURL}${searchPath.replace('%s', encodeURIComponent(keyword))}`;

    if (this.debugMode) {
      console.log(`[DYYJ] 搜索URL: ${searchURL}`);
    }

    // 发送请求（带重试机制）
    const resp = await this.doRequestWithRetry(client, searchURL);

    if (resp.status !== 200) {
      throw new Error(`[${this.Name()}] 搜索请求HTTP状态错误: ${resp.status}`);
    }

    const htmlContent = resp.data;

    if (this.debugMode) {
      console.log(`[DYYJ] 响应体大小: ${htmlContent.length} 字节`);
    }

    // 解析搜索结果
    const results = await this.parseSearchResults(htmlContent);

    if (this.debugMode) {
      console.log(`[DYYJ] 解析搜索结果完成，获取到 ${results.length} 个结果`);
    }

    return results;
  }

  private async doRequestWithRetry(client: AxiosInstance, url: string): Promise<AxiosResponse> {
    const maxRetries = 3;
    let lastError: any = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        if (attempt > 0) {
          // 指数退避重试
          const backoff = Math.pow(2, attempt - 1) * 200;
          if (this.debugMode) {
            console.log(`[DYYJ] 重试请求 (第 ${attempt} 次)，等待 ${backoff}ms: ${url}`);
          }
          await new Promise(resolve => setTimeout(resolve, backoff));
        } else if (this.debugMode) {
          console.log(`[DYYJ] 发送请求: ${url}`);
        }

        const resp = await client.get(url, {
          headers: this.setCommonHeaders(),
          timeout: requestTimeout
        });

        if (resp.status === 200) {
          if (this.debugMode && attempt > 0) {
            console.log(`[DYYJ] 重试成功 (第 ${attempt + 1} 次): ${url}`);
          }
          return resp;
        }
      } catch (error) {
        lastError = error;
        if (attempt < maxRetries - 1) {
          if (this.debugMode) {
            console.log(`[DYYJ] 请求失败，将重试: ${error}`);
          }
        } else {
          console.error(`[DYYJ] 请求失败，已达到最大重试次数: ${error}`);
        }
      }
    }

    throw new Error(`[${this.Name()}] 重试 ${maxRetries} 次后仍然失败: ${lastError?.message}`);
  }

  private setCommonHeaders(): Record<string, string> {
    return {
      'User-Agent': userAgent,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'Connection': 'keep-alive',
      'Upgrade-Insecure-Requests': '1',
      'Cache-Control': 'max-age=0',
      'Referer': baseURL + '/'
    };
  }

  private async parseSearchResults(htmlContent: string): Promise<SearchResult[]> {
    let results: SearchResult[] = [];

    // 尝试使用 cheerio 解析
    try {
      const $ = cheerio.load(htmlContent);
      
      // 尝试多个选择器
      const selectors = [
        "noscript#flarum-content .container ul li",
        "noscript#flarum-content ul li",
        "noscript[id='flarum-content'] .container ul li",
        "noscript[id=\"flarum-content\"] .container ul li",
        "noscript .container ul li",
        "noscript ul li",
        "#flarum-content .container ul li",
        ".container ul li",
        "ul li",
        "li",
      ];

      for (const selector of selectors) {
        const elements = $(selector);
        if (elements.length > 0) {
          if (this.debugMode) {
            console.log(`[DYYJ] 使用选择器: ${selector}，找到 ${elements.length} 个元素`);
          }

          elements.each((i, element) => {
            if (results.length >= maxResults) {
              return false;
            }

            const result = this.parseResultItem($(element), i + 1);
            if (result) {
              results.push(result);
              if (this.debugMode) {
                console.log(`[DYYJ] 解析结果项 ${i + 1}: ${result.Title}`);
              }
            } else if (this.debugMode) {
              console.log(`[DYYJ] 跳过无效结果项 ${i + 1}`);
            }
          });

          break;
        }
      }
    } catch (error) {
      if (this.debugMode) {
        console.log(`[DYYJ] cheerio 解析失败，使用正则表达式备选: ${error}`);
      }
    }

    // 如果 cheerio 没有找到结果，使用正则表达式
    if (results.length === 0) {
      if (this.debugMode) {
        console.log(`[DYYJ] cheerio 未找到结果，使用正则表达式`);
      }
      results = this.parseSearchResultsWithRegex(htmlContent);
    }

    return results;
  }

  private parseSearchResultsWithRegex(htmlContent: string): SearchResult[] {
    const results: SearchResult[] = [];

    // 首先尝试找到 noscript#flarum-content 标签内的内容
    const noscriptMatch = htmlContent.match(noscriptRegex);
    let searchArea = htmlContent;
    if (noscriptMatch && noscriptMatch.length >= 2) {
      searchArea = noscriptMatch[1];
      if (this.debugMode) {
        console.log(`[DYYJ] 找到 noscript#flarum-content 标签，内容长度: ${searchArea.length} 字节`);
      }
    } else {
      if (this.debugMode) {
        console.log(`[DYYJ] 未找到 noscript#flarum-content 标签，使用整个HTML`);
      }
    }

    // 匹配 <li> 标签内的链接
    let match;
    while ((match = liLinkRegex.exec(searchArea)) !== null) {
      if (results.length >= maxResults) {
        break;
      }

      if (match.length >= 3) {
        let href = match[1];
        let title = match[2].trim();
        // 清理 HTML 标签
        title = title.replace(htmlTagRegex, '').trim();

        if (title === '' || !href.includes('/d/')) {
          continue;
        }

        // 确保是完整 URL
        if (!href.startsWith('http')) {
          if (href.startsWith('/')) {
            href = baseURL + href;
          } else {
            href = baseURL + '/' + href;
          }
        }

        // 从 href 中提取 ID
        const postID = this.extractPostID(href);
        const uniqueID = postID ? `${this.Name()}-${postID}` : `${this.Name()}-regex-${results.length + 1}`;

        const result: SearchResult = {
          UniqueID: uniqueID,
          Title: title,
          Content: `详情页: ${href}`,
          Channel: '',
          Datetime: new Date(),
          Links: [],
          Tags: [],
          MessageID: uniqueID
        };

        results.push(result);

        if (this.debugMode) {
          console.log(`[DYYJ] 正则解析结果 ${results.length}: ${title} -> ${href}`);
        }
      }
    }

    // 重置正则表达式状态
    liLinkRegex.lastIndex = 0;

    return results;
  }

  private parseResultItem(s: cheerio.Cheerio, index: number): SearchResult | null {
    // 提取链接
    const linkEl = s.find('a');
    if (linkEl.length === 0) {
      if (this.debugMode) {
        console.log(`[DYYJ] 结果项 ${index}: 未找到链接元素`);
      }
      return null;
    }

    // 提取标题
    const title = linkEl.text().trim();
    if (title === '') {
      if (this.debugMode) {
        console.log(`[DYYJ] 结果项 ${index}: 标题为空`);
      }
      return null;
    }

    // 提取详情页链接
    const detailURL = linkEl.attr('href');
    if (!detailURL) {
      if (this.debugMode) {
        console.log(`[DYYJ] 结果项 ${index}: 未找到详情页链接，标题: ${title}`);
      }
      return null;
    }

    // 确保是完整 URL
    let fullDetailURL = detailURL;
    if (!detailURL.startsWith('http')) {
      if (detailURL.startsWith('/')) {
        fullDetailURL = baseURL + detailURL;
      } else {
        fullDetailURL = baseURL + '/' + detailURL;
      }
    }

    // 从 URL 中提取 ID
    const postID = this.extractPostID(fullDetailURL);
    const uniqueID = postID ? `${this.Name()}-${postID}` : `${this.Name()}-unknown-${index}`;

    // 构建初始结果对象
    const result: SearchResult = {
      UniqueID: uniqueID,
      Title: title,
      Content: `详情页: ${fullDetailURL}`,
      Channel: '', // 插件搜索结果必须为空字符串
      Datetime: new Date(), // 初始化为当前时间，稍后从详情页获取
      Links: [], // 先为空，详情页处理后添加
      Tags: [],
      MessageID: uniqueID
    };

    return result;
  }

  private extractPostID(url: string): string {
    const matches = url.match(postIDRegex);
    if (matches && matches.length >= 2) {
      return matches[1];
    }
    return '';
  }

  private filterByTitleKeyword(results: SearchResult[], keyword: string): SearchResult[] {
    if (!keyword) {
      return results;
    }

    const lowerKeyword = keyword.toLowerCase();
    const keywords = lowerKeyword.split(/\s+/).filter(k => k.length > 0);

    const filtered: SearchResult[] = [];
    for (const result of results) {
      const lowerTitle = result.Title.toLowerCase();
      
      // 检查每个关键词是否都在标题中
      const matched = keywords.every(kw => lowerTitle.includes(kw));

      if (matched) {
        filtered.push(result);
      } else if (this.debugMode) {
        console.log(`[DYYJ] 标题不包含关键词，跳过: ${result.Title}`);
      }
    }

    return filtered;
  }

  private async fetchDetailLinks(client: AxiosInstance, searchResults: SearchResult[], keyword: string): Promise<SearchResult[]> {
    if (searchResults.length === 0) {
      if (this.debugMode) {
        console.log(`[DYYJ] 没有搜索结果需要获取详情页`);
      }
      return [];
    }

    if (this.debugMode) {
      console.log(`[DYYJ] 开始并发获取 ${searchResults.length} 个详情页链接，最大并发数: ${maxConcurrency}`);
    }

    const semaphore = new Semaphore(maxConcurrency);
    const tasks: Promise<SearchResult | null>[] = [];

    for (const result of searchResults) {
      tasks.push((async () => {
        await semaphore.acquire();
        try {
          // 从 Content 中提取详情页 URL
          const detailURL = this.extractDetailURLFromContent(result.Content);
          if (!detailURL) {
            if (this.debugMode) {
              console.log(`[DYYJ] 跳过无详情页 URL 的结果: ${result.Title}`);
            }
            return null;
          }

          if (this.debugMode) {
            console.log(`[DYYJ] 获取详情页链接: ${detailURL} (标题: ${result.Title})`);
          }

          // 获取详情页链接和时间信息
          const { links, publishTime } = await this.fetchDetailPageLinks(client, detailURL);
          if (links.length > 0) {
            const newResult = { ...result };
            newResult.Links = links;
            // 如果获取到了发布时间，更新 Datetime
            if (publishTime && publishTime.getTime() > 0) {
              newResult.Datetime = publishTime;
              if (this.debugMode) {
                console.log(`[DYYJ] 更新发布时间: ${result.Title} -> ${publishTime.toISOString()}`);
              }
            } else {
              // 如果没有获取到时间，使用当前时间作为默认值
              newResult.Datetime = new Date();
              if (this.debugMode) {
                console.log(`[DYYJ] 未获取到发布时间，使用当前时间: ${result.Title}`);
              }
            }
            // 清理 Content 中的详情页 URL
            newResult.Content = this.cleanContent(result.Content);
            if (this.debugMode) {
              console.log(`[DYYJ] 成功获取详情页链接: ${result.Title}，找到 ${links.length} 个网盘链接`);
            }
            return newResult;
          } else if (this.debugMode) {
            console.log(`[DYYJ] 详情页无有效链接: ${result.Title} (URL: ${detailURL})`);
          }
          return null;
        } catch (error) {
          console.error(`[DYYJ] 获取详情页失败:`, error);
          return null;
        } finally {
          semaphore.release();
        }
      })());
    }

    const results = await Promise.all(tasks);
    return results.filter((r): r is SearchResult => r !== null);
  }

  private extractDetailURLFromContent(content: string): string {
    const lines = content.split('\n');
    for (const line of lines) {
      if (line.startsWith('详情页: ')) {
        return line.substring('详情页: '.length);
      }
    }
    return '';
  }

  private cleanContent(content: string): string {
    return content.split('\n').filter(line => !line.startsWith('详情页: ')).join('\n');
  }

  private async fetchDetailPageLinks(client: AxiosInstance, detailURL: string): Promise<{ links: Link[]; publishTime: Date }> {
    // 检查缓存
    if (detailCache.has(detailURL)) {
      const cached = detailCache.get(detailURL);
      if (cached) {
        if (Date.now() - cached.timestamp < cacheTTL) {
          if (this.debugMode) {
            console.log(`[DYYJ] 使用缓存的详情页链接: ${detailURL} (缓存了 ${cached.links.length} 个链接)`);
          }
          return { links: cached.links, publishTime: cached.publishTime };
        }
        detailCache.delete(detailURL);
      }
    }

    if (this.debugMode) {
      console.log(`[DYYJ] 开始获取详情页: ${detailURL}`);
    }

    try {
      const resp = await client.get(detailURL, {
        headers: {
          'User-Agent': userAgent,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
          'Referer': baseURL + '/',
          'Connection': 'keep-alive'
        },
        timeout: requestTimeout
      });

      if (resp.status !== 200) {
        if (this.debugMode) {
          console.log(`[DYYJ] 详情页 HTTP 状态错误: ${resp.status} (URL: ${detailURL})`);
        }
        return { links: [], publishTime: new Date(0) };
      }

      const htmlContent = resp.data;

      if (this.debugMode) {
        console.log(`[DYYJ] 详情页响应体大小: ${htmlContent.length} 字节 (URL: ${detailURL})`);
      }

      // 解析网盘链接
      const links = this.parseNetworkDiskLinks(htmlContent);

      // 提取发布时间
      const publishTime = this.extractPublishTime(htmlContent);

      if (this.debugMode) {
        console.log(`[DYYJ] 从详情页提取到 ${links.length} 个链接: ${detailURL}`);
        for (let i = 0; i < links.length; i++) {
          console.log(`[DYYJ]   链接 ${i + 1}: ${links[i].URL} (${links[i].Type}, 密码: ${links[i].Password})`);
        }
        if (publishTime && publishTime.getTime() > 0) {
          console.log(`[DYYJ] 提取到发布时间: ${publishTime.toISOString()}`);
        } else {
          console.log(`[DYYJ] 未提取到发布时间`);
        }
      }

      // 缓存结果
      detailCache.set(detailURL, {
        links,
        publishTime,
        timestamp: Date.now()
      });

      return { links, publishTime };
    } catch (error) {
      if (this.debugMode) {
        console.log(`[DYYJ] 详情页请求失败: ${error} (URL: ${detailURL})`);
      }
      return { links: [], publishTime: new Date(0) };
    }
  }

  private extractPublishTime(htmlContent: string): Date {
    for (const re of publishTimeRegexes) {
      const matches = htmlContent.match(re);
      if (matches && matches.length >= 2) {
        const timeStr = matches[1].trim();
        // 尝试多种时间格式
        const timeFormats = [
          'YYYY-MM-DDTHH:mm:ssZ', // 2006-01-02T15:04:05Z
          'YYYY-MM-DDTHH:mm:ss+HH:mm', // 2024-05-05T17:04:11+00:00
          'YYYY-MM-DDTHH:mm:ss', // 2006-01-02T15:04:05
          'YYYY-MM-DD HH:mm:ss', // 2006-01-02 15:04:05
          'YYYY-MM-DD', // 2006-01-02
        ];

        for (const format of timeFormats) {
          const date = this.parseDate(timeStr, format);
          if (date && date.getTime() > 0) {
            if (this.debugMode) {
              console.log(`[DYYJ] 成功解析时间: ${timeStr} (格式: ${format})`);
            }
            return date;
          }
        }

        if (this.debugMode) {
          console.log(`[DYYJ] 无法解析时间格式: ${timeStr}`);
        }
      }
    }

    return new Date(0);
  }

  private parseDate(dateStr: string, format: string): Date | null {
    try {
      // 尝试直接解析
      const date = new Date(dateStr);
      if (date.getTime() > 0) {
        return date;
      }
    } catch (error) {
      // 解析失败，返回 null
    }
    return null;
  }

  private parseNetworkDiskLinks(htmlContent: string): Link[] {
    let links: Link[] = [];

    try {
      // 使用 cheerio 解析 HTML
      const $ = cheerio.load(htmlContent);

      // 查找 noscript 标签中的内容
      const selector = "noscript#flarum-content .container article .Post-body";
      if (this.debugMode) {
        console.log(`[DYYJ] 使用 cheerio 选择器: ${selector}`);
      }

      let foundPostBody = false;
      $(selector).each((i, element) => {
        foundPostBody = true;
        if (this.debugMode) {
          console.log(`[DYYJ] 找到 Post-body 元素 ${i + 1}`);
        }

        // 查找所有 p 标签，检查是否包含 strong 标签（网盘名称）和链接
        const pElements = $(element).find('p');
        if (this.debugMode) {
          console.log(`[DYYJ] Post-body ${i + 1} 中共有 ${pElements.length} 个 p 标签`);
        }

        pElements.each((j, pEl) => {
          const strongEl = $(pEl).find('strong');
          if (strongEl.length === 0) {
            return;
          }

          const strongText = strongEl.text().trim();
          
          if (this.debugMode) {
            console.log(`[DYYJ]   检查 p 标签 ${j + 1}，strong 文本: ${strongText}`);
          }

          // 检查是否是网盘名称
          if (!this.isNetworkDiskName(strongText)) {
            return;
          }

          if (this.debugMode) {
            console.log(`[DYYJ]   找到网盘名称: ${strongText}`);
          }

          // 在当前 p 标签或下一个 p 标签中查找链接
          let linkEl = $(pEl).find('a');
          if (linkEl.length === 0) {
            // 如果当前 p 没有链接，查找下一个 p 标签
            const nextP = $(pEl).next();
            if (nextP.length > 0) {
              linkEl = nextP.find('a');
            }
          }

          if (linkEl.length > 0) {
            const linkURL = linkEl.attr('href');
            if (linkURL) {
              // 确定网盘类型
              const linkType = this.determineCloudType(linkURL);
              if (linkType !== 'others') {
                // 提取密码
                const password = this.extractPasswordFromURL(linkURL);
                
                const link: Link = {
                  Type: linkType,
                  URL: linkURL,
                  Password: password,
                };
                
                if (this.debugMode) {
                  console.log(`[DYYJ]   找到网盘链接: ${linkURL} (${linkType}, 密码: ${password})`);
                }
                
                links.push(link);
              } else if (this.debugMode) {
                console.log(`[DYYJ]   链接类型为 others，跳过: ${linkURL}`);
              }
            } else if (this.debugMode) {
              console.log(`[DYYJ]   p 标签 ${j + 1} 中未找到链接`);
            }
          }
        });
      });

      if (!foundPostBody && this.debugMode) {
        console.log(`[DYYJ] 未找到 Post-body 元素，尝试使用正则表达式`);
      }
    } catch (error) {
      if (this.debugMode) {
        console.log(`[DYYJ] cheerio 解析失败，使用正则表达式备选: ${error}`);
      }
    }

    // 如果 cheerio 没有找到链接，使用正则表达式作为备选
    if (links.length === 0) {
      if (this.debugMode) {
        console.log(`[DYYJ] cheerio 未找到链接，使用正则表达式备选方案`);
      }
      links = this.parseNetworkDiskLinksWithRegex(htmlContent);
    }

    // 去重
    const uniqueLinks = this.removeDuplicateLinks(links);

    if (this.debugMode) {
      console.log(`[DYYJ] 解析完成，共找到 ${uniqueLinks.length} 个网盘链接`);
    }

    return uniqueLinks;
  }

  private parseNetworkDiskLinksWithRegex(htmlContent: string): Link[] {
    const links: Link[] = [];
    const seen = new Set<string>();

    if (this.debugMode) {
      console.log(`[DYYJ] 使用正则表达式解析网盘链接`);
    }

    // 使用预编译的正则表达式
    for (const pattern of networkDiskPatterns) {
      let match;
      while ((match = pattern.regex.exec(htmlContent)) !== null) {
        if (match.length >= 2) {
          const linkURL = match[1];

          // 去重
          if (seen.has(linkURL)) {
            if (this.debugMode) {
              console.log(`[DYYJ] 跳过重复链接: ${linkURL}`);
            }
            continue;
          }
          seen.add(linkURL);

          // 确定网盘类型
          let urlType = this.determineCloudType(linkURL);
          if (urlType === 'others') {
            urlType = pattern.urlType;
          }

          // 只添加有效的网盘链接
          if (urlType !== 'others') {
            // 提取密码
            const password = this.extractPasswordFromURL(linkURL);

            const link: Link = {
              Type: urlType,
              URL: linkURL,
              Password: password,
            };

            if (this.debugMode) {
              console.log(`[DYYJ] 正则找到网盘链接: ${linkURL} (${urlType}, 密码: ${password})`);
            }

            links.push(link);
          } else if (this.debugMode) {
            console.log(`[DYYJ] 链接类型为 others，跳过: ${linkURL}`);
          }
        }
      }
      // 重置正则表达式状态
      pattern.regex.lastIndex = 0;
    }

    if (this.debugMode) {
      console.log(`[DYYJ] 正则表达式解析完成，共找到 ${links.length} 个网盘链接`);
    }

    return links;
  }

  private removeDuplicateLinks(links: Link[]): Link[] {
    const seen = new Set<string>();
    const uniqueLinks: Link[] = [];

    for (const link of links) {
      if (!seen.has(link.URL)) {
        seen.add(link.URL);
        uniqueLinks.push(link);
      }
    }

    return uniqueLinks;
  }

  private isNetworkDiskName(text: string): boolean {
    const networkDiskNames = [
      "夸克", "百度", "阿里", "天翼", "迅雷", "115", "123", "蓝奏",
      "夸克网盘", "百度网盘", "阿里云盘", "天翼云盘", "迅雷网盘", "115网盘", "123网盘",
    ];

    const lowerText = text.toLowerCase();
    for (const name of networkDiskNames) {
      if (lowerText.includes(name.toLowerCase())) {
        return true;
      }
    }
    return false;
  }

  private extractPasswordFromURL(linkURL: string): string {
    // 从 URL 参数中提取密码
    const patterns = [
      /[?&]pwd=([A-Za-z0-9]{4,8})/,
      /[?&]password=([A-Za-z0-9]{4,8})/,
      /[?&]code=([A-Za-z0-9]{4,8})/,
    ];

    for (const pattern of patterns) {
      const match = linkURL.match(pattern);
      if (match && match.length >= 2) {
        return match[1];
      }
    }

    return "";
  }

  private determineCloudType(url: string): string {
    if (url.includes("pan.quark.cn")) {
      return "quark";
    } else if (url.includes("drive.uc.cn")) {
      return "uc";
    } else if (url.includes("pan.baidu.com")) {
      return "baidu";
    } else if (url.includes("aliyundrive.com") || url.includes("alipan.com")) {
      return "aliyun";
    } else if (url.includes("pan.xunlei.com")) {
      return "xunlei";
    } else if (url.includes("cloud.189.cn")) {
      return "tianyi";
    } else if (url.includes("caiyun.139.com")) {
      return "mobile";
    } else if (url.includes("115.com") || url.includes("115cdn.com") || url.includes("anxia.com")) {
      return "115";
    } else if (url.includes("123684.com") || url.includes("123685.com") ||
      url.includes("123912.com") || url.includes("123pan.com") ||
      url.includes("123pan.cn") || url.includes("123592.com")) {
      return "123";
    } else if (url.includes("mypikpak.com")) {
      return "pikpak";
    } else if (url.includes("magnet:")) {
      return "magnet";
    } else if (url.includes("ed2k://")) {
      return "ed2k";
    } else {
      return "others";
    }
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

// 信号量类
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
    if (this.waiting.length > 0) {
      const resolve = this.waiting.shift();
      if (resolve) {
        resolve();
      }
    } else {
      this.currentConcurrent--;
    }
  }
}

// 注册插件
const plugin = new DyyjPlugin();
plugin.register();
