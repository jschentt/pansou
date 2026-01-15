import { BaseAsyncPlugin, registerGlobalPlugin } from '../plugin.manager';
import { SearchResult, Link } from '../../models/response';
import axios, { AxiosInstance, AxiosResponse } from 'axios';
import * as cheerio from 'cheerio';
import * as fs from 'fs';
import * as path from 'path';

// 常量定义
const PluginName = "dyyj";
const DisplayName = "电影云集";
const Description = "电影云集 - 影视资源网盘链接搜索";
const BaseURL = "https://bbs.dyyjmax.org";
const SearchPath = "/?q=%s";
const UserAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36";
const MaxResults = 100;
const MaxConcurrency = 100;
const RequestTimeout = 30000; // 30秒

// HTTP连接池配置
const MaxIdleConns = 100;
const MaxIdleConnsPerHost = 100;
const MaxConnsPerHost = 100;
const IdleConnTimeout = 90000; // 90秒
const TLSHandshakeTimeout = 10000; // 10秒
const ExpectContinueTimeout = 1000; // 1秒

// 预编译的正则表达式
const postIDRegex = /\/d\/(\d+)/;
const noscriptRegex = /<noscript[^>]*id=["']flarum-content["'][^>]*>([\s\S]*?)<\/noscript>/;
const liLinkRegex = /<li[^>]*>\s*<a[^>]*href=["']([^"']*\/d\/[^"']*)["'][^>]*>([\s\S]*?)<\/a>\s*<\/li>/g;
const htmlTagRegex = /<[^>]+>/g;
const linkHrefRegex = /href=["']([^"']*\/d\/[^"']*)["']/g;

// 提取发布时间的正则表达式
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

// 缓存项接口
interface CacheItem {
  links: Link[];
  publishTime: Date;
  timestamp: Date;
}

// DyyjPlugin 电影云集插件
class DyyjPlugin extends BaseAsyncPlugin {
  private debugMode: boolean;
  private detailCache: Map<string, CacheItem>;
  private cacheTTL: number;
  private optimizedClient: AxiosInstance;

  constructor() {
    super(PluginName, 2); // 质量良好，优先级2
    this.debugMode = false; // 生产环境关闭调试
    this.detailCache = new Map();
    this.cacheTTL = 30 * 60 * 1000; // 详情页缓存30分钟
    this.optimizedClient = this.createOptimizedHTTPClient();
  }

  // 创建优化的HTTP客户端
  private createOptimizedHTTPClient(): AxiosInstance {
    return axios.create({
      timeout: RequestTimeout,
      headers: {
        'User-Agent': UserAgent,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
        'Cache-Control': 'max-age=0',
      },
      httpAgent: new (require('http').Agent)({
        keepAlive: true,
        keepAliveMsecs: IdleConnTimeout,
        maxSockets: MaxConnsPerHost,
        maxFreeSockets: MaxIdleConnsPerHost,
      }),
      httpsAgent: new (require('https').Agent)({
        keepAlive: true,
        keepAliveMsecs: IdleConnTimeout,
        maxSockets: MaxConnsPerHost,
        maxFreeSockets: MaxIdleConnsPerHost,
      }),
    });
  }

  // 插件名称
  name(): string {
    return PluginName;
  }

  // 插件显示名称
  displayName(): string {
    return DisplayName;
  }

  // 插件描述
  description(): string {
    return Description;
  }

  // 搜索实现
  private async searchImpl(client: AxiosInstance, keyword: string, ext: Record<string, any>): Promise<SearchResult[]> {
    if (this.debugMode) {
      console.log(`[DYYJ] 开始搜索: ${keyword}`);
    }

    // 第一步：执行搜索获取结果列表
    const searchResults = await this.executeSearch(keyword);
    if (searchResults.length === 0) {
      if (this.debugMode) {
        console.log(`[DYYJ] 搜索没有获取到结果`);
      }
      return [];
    }

    if (this.debugMode) {
      console.log(`[DYYJ] 搜索获取到 ${searchResults.length} 个结果`);
    }

    // 第二步：先对标题进行关键词过滤
    const titleFilteredResults = this.filterByTitleKeyword(searchResults, keyword);
    if (this.debugMode) {
      console.log(`[DYYJ] 标题关键词过滤后剩余 ${titleFilteredResults.length} 个结果`);
    }

    // 第三步：并发获取详情页链接
    const finalResults = await this.fetchDetailLinks(titleFilteredResults, keyword);

    if (this.debugMode) {
      console.log(`[DYYJ] 最终获取到 ${finalResults.length} 个有效结果`);
    }

    // 第四步：最终关键词过滤
    return finalResults;
  }

  // 执行搜索请求
  private async executeSearch(keyword: string): Promise<SearchResult[]> {
    // 构建搜索URL
    const searchURL = `${BaseURL}${SearchPath.replace('%s', encodeURIComponent(keyword))}`;

    if (this.debugMode) {
      console.log(`[DYYJ] 搜索URL: ${searchURL}`);
    }

    try {
      // 发送请求
      const response = await this.optimizedClient.get(searchURL, {
        timeout: RequestTimeout,
      });

      if (this.debugMode) {
        console.log(`[DYYJ] 搜索请求响应状态码: ${response.status}`);
      }

      if (response.status !== 200) {
        throw new Error(`搜索请求HTTP状态错误: ${response.status}`);
      }

      // 保存完整HTML到文件用于分析（调试模式）
      if (this.debugMode) {
        const filename = path.join(__dirname, `./dyyj_search_${encodeURIComponent(keyword)}_${Date.now()}.html`);
        fs.writeFileSync(filename, response.data);
        console.log(`[DYYJ] 完整HTML已保存到: ${filename}`);
      }

      // 解析HTML提取搜索结果
      return this.parseSearchResults(response.data);
    } catch (error) {
      if (this.debugMode) {
        console.error(`[DYYJ] 搜索请求失败: ${error}`);
      }
      throw new Error(`[${this.name()}] 执行搜索失败: ${error}`);
    }
  }

  // 解析搜索结果HTML
  private parseSearchResults(htmlContent: string): SearchResult[] {
    let results: SearchResult[] = [];

    // 尝试使用cheerio解析
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
        if (this.debugMode) {
          console.log(`[DYYJ] 尝试选择器: ${selector}`);
        }

        const elements = $(selector);
        if (elements.length > 0) {
          if (this.debugMode) {
            console.log(`[DYYJ] 使用选择器: ${selector}，找到 ${elements.length} 个元素`);
          }

          elements.each((i, element) => {
            if (results.length >= MaxResults) {
              return false; // 跳出each循环
            }

            const result = this.parseResultItem($(element), i + 1);
            if (result) {
              results.push(result);
            }
          });

          break; // 找到匹配的选择器，跳出循环
        }
      }
    } catch (error) {
      if (this.debugMode) {
        console.error(`[DYYJ] cheerio解析失败: ${error}`);
      }
    }

    // 如果cheerio没有找到结果，使用正则表达式
    if (results.length === 0) {
      results = this.parseSearchResultsWithRegex(htmlContent);
    }

    return results;
  }

  // 使用正则表达式从HTML中提取搜索结果
  private parseSearchResultsWithRegex(htmlContent: string): SearchResult[] {
    const results: SearchResult[] = [];
    let match;

    if (this.debugMode) {
      console.log(`[DYYJ] 使用正则表达式从HTML中提取链接`);
    }

    // 找到noscript#flarum-content标签内的内容
    const noscriptMatch = noscriptRegex.exec(htmlContent);
    const searchArea = noscriptMatch ? noscriptMatch[1] : htmlContent;

    // 匹配 <li> 标签内的链接
    liLinkRegex.lastIndex = 0; // 重置正则表达式
    while ((match = liLinkRegex.exec(searchArea)) !== null && results.length < MaxResults) {
      if (match.length >= 3) {
        let href = match[1];
        let title = match[2].trim();

        // 清理HTML标签
        title = title.replace(htmlTagRegex, "").trim();

        if (title === "" || !href.includes("/d/")) {
          continue;
        }

        // 确保是完整URL
        if (!href.startsWith("http")) {
          if (href.startsWith("/")) {
            href = `${BaseURL}${href}`;
          } else {
            href = `${BaseURL}/${href}`;
          }
        }

        // 从href中提取ID
        let postID = this.extractPostID(href);
        if (postID === "") {
          postID = `regex-${results.length + 1}`;
        }

        const result: SearchResult = {
          uniqueId: `${this.name()}-${postID}`,
          messageId: `${this.name()}-${postID}`,
          title,
          content: `详情页: ${href}`,
          links: [],
          tags: [],
          channel: "",
          datetime: new Date().toISOString(),
        };

        results.push(result);
      }
    }

    if (this.debugMode) {
      console.log(`[DYYJ] 正则表达式解析完成，获取到 ${results.length} 个结果`);
    }

    return results;
  }

  // 解析单个搜索结果项
  private parseResultItem(element: cheerio.Cheerio, index: number): SearchResult | null {
    // 提取链接
    const linkEl = element.find("a");
    if (linkEl.length === 0) {
      if (this.debugMode) {
        console.log(`[DYYJ] 结果项 ${index}: 未找到链接元素`);
      }
      return null;
    }

    // 提取标题
    const title = linkEl.text().trim();
    if (title === "") {
      if (this.debugMode) {
        console.log(`[DYYJ] 结果项 ${index}: 标题为空`);
      }
      return null;
    }

    // 提取详情页链接
    const detailURL = linkEl.attr("href");
    if (!detailURL) {
      if (this.debugMode) {
        console.log(`[DYYJ] 结果项 ${index}: 未找到详情页链接，标题: ${title}`);
      }
      return null;
    }

    // 确保是完整URL
    let fullDetailURL = detailURL;
    if (!fullDetailURL.startsWith("http")) {
      if (fullDetailURL.startsWith("/")) {
        fullDetailURL = `${BaseURL}${fullDetailURL}`;
      } else {
        fullDetailURL = `${BaseURL}/${fullDetailURL}`;
      }
    }

    // 从URL中提取ID
    let postID = this.extractPostID(fullDetailURL);
    if (postID === "") {
      postID = `unknown-${index}`;
    }

    // 构建初始结果对象
    return {
      uniqueId: `${this.name()}-${postID}`,
      messageId: `${this.name()}-${postID}`,
      title,
      content: `详情页: ${fullDetailURL}`,
      links: [],
      tags: [],
      channel: "",
      datetime: new Date().toISOString(),
    };
  }

  // 从URL中提取文章ID
  private extractPostID(url: string): string {
    const match = postIDRegex.exec(url);
    if (match && match.length > 1) {
      return match[1];
    }
    return "";
  }

  // 根据标题过滤结果
  private filterByTitleKeyword(results: SearchResult[], keyword: string): SearchResult[] {
    if (!keyword) {
      return results;
    }

    const lowerKeyword = keyword.toLowerCase();
    const keywords = lowerKeyword.split(/\s+/); // 支持多关键词

    return results.filter(result => {
      const lowerTitle = result.title.toLowerCase();
      
      // 检查每个关键词是否都在标题中
      for (const kw of keywords) {
        if (!lowerTitle.includes(kw)) {
          return false;
        }
      }
      return true;
    });
  }

  // 并发获取详情页链接
  private async fetchDetailLinks(searchResults: SearchResult[], keyword: string): Promise<SearchResult[]> {
    if (searchResults.length === 0) {
      if (this.debugMode) {
        console.log(`[DYYJ] 没有搜索结果需要获取详情页`);
      }
      return [];
    }

    if (this.debugMode) {
      console.log(`[DYYJ] 开始并发获取 ${searchResults.length} 个详情页链接，最大并发数: ${MaxConcurrency}`);
    }

    const results: SearchResult[] = [];
    const semaphore = this.createSemaphore(MaxConcurrency);

    // 创建并发任务
    const tasks = searchResults.map(async (result) => {
      await semaphore.acquire();
      try {
        // 从Content中提取详情页URL
        const detailURL = this.extractDetailURLFromContent(result.content);
        if (!detailURL) {
          if (this.debugMode) {
            console.log(`[DYYJ] 跳过无详情页URL的结果: ${result.title}`);
          }
          return null;
        }

        if (this.debugMode) {
          console.log(`[DYYJ] 获取详情页链接: ${detailURL} (标题: ${result.title})`);
        }

        // 获取详情页链接和时间信息
        const { links, publishTime } = await this.fetchDetailPageLinks(detailURL);
        if (links.length > 0) {
          result.links = links;
          // 如果获取到了发布时间，更新Datetime
          if (publishTime) {
            result.datetime = publishTime.toISOString();
          }
          // 清理Content中的详情页URL
          result.content = this.cleanContent(result.content);
          
          if (this.debugMode) {
            console.log(`[DYYJ] 成功获取详情页链接: ${result.title}，找到 ${links.length} 个网盘链接`);
          }
          return result;
        } else if (this.debugMode) {
          console.log(`[DYYJ] 详情页无有效链接: ${result.title} (URL: ${detailURL})`);
        }
        return null;
      } finally {
        semaphore.release();
      }
    });

    // 执行所有任务
    const taskResults = await Promise.all(tasks);
    
    // 过滤掉null结果
    return taskResults.filter((r): r is SearchResult => r !== null);
  }

  // 创建信号量
  private createSemaphore(maxConcurrency: number) {
    let available = maxConcurrency;
    const waiting: (() => void)[] = [];

    return {
      acquire: async (): Promise<void> => {
        return new Promise((resolve) => {
          if (available > 0) {
            available--;
            resolve();
          } else {
            waiting.push(resolve);
          }
        });
      },
      release: (): void => {
        available++;
        if (waiting.length > 0) {
          const resolve = waiting.shift()!;
          available--;
          resolve();
        }
      },
    };
  }

  // 从Content中提取详情页URL
  private extractDetailURLFromContent(content: string): string {
    const lines = content.split("\n");
    for (const line of lines) {
      if (line.startsWith("详情页: ")) {
        return line.substring(5).trim();
      }
    }
    return "";
  }

  // 清理Content，移除详情页URL行
  private cleanContent(content: string): string {
    const lines = content.split("\n");
    const cleanedLines = lines.filter(line => !line.startsWith("详情页: "));
    return cleanedLines.join("\n");
  }

  // 获取详情页的网盘链接和发布时间
  private async fetchDetailPageLinks(detailURL: string): Promise<{ links: Link[]; publishTime: Date | null }> {
    // 检查缓存
    const cached = this.detailCache.get(detailURL);
    if (cached && (Date.now() - cached.timestamp.getTime()) < this.cacheTTL) {
      if (this.debugMode) {
        console.log(`[DYYJ] 使用缓存的详情页链接: ${detailURL} (缓存了 ${cached.links.length} 个链接)`);
      }
      return { links: cached.links, publishTime: cached.publishTime };
    }

    if (this.debugMode) {
      console.log(`[DYYJ] 开始获取详情页: ${detailURL}`);
    }

    try {
      // 发送请求
      const response = await this.optimizedClient.get(detailURL, {
        timeout: RequestTimeout,
      });

      if (this.debugMode) {
        console.log(`[DYYJ] 详情页响应状态码: ${response.status}`);
      }

      if (response.status !== 200) {
        throw new Error(`详情页HTTP状态错误: ${response.status}`);
      }

      // 解析网盘链接
      const links = this.parseNetworkDiskLinks(response.data);

      // 提取发布时间
      const publishTime = this.extractPublishTime(response.data);

      if (this.debugMode) {
        console.log(`[DYYJ] 从详情页提取到 ${links.length} 个链接: ${detailURL}`);
        links.forEach((link, index) => {
          console.log(`[DYYJ]   链接 ${index + 1}: ${link.url} (${link.type}, 密码: ${link.password})`);
        });
        if (publishTime) {
          console.log(`[DYYJ] 提取到发布时间: ${publishTime}`);
        } else {
          console.log(`[DYYJ] 未提取到发布时间`);
        }
      }

      // 缓存结果
      const cacheItem: CacheItem = {
        links,
        publishTime: publishTime || new Date(),
        timestamp: new Date(),
      };
      this.detailCache.set(detailURL, cacheItem);

      return { links, publishTime };
    } catch (error) {
      if (this.debugMode) {
        console.error(`[DYYJ] 详情页请求失败: ${error} (URL: ${detailURL})`);
      }
      return { links: [], publishTime: null };
    }
  }

  // 从HTML中提取发布时间
  private extractPublishTime(htmlContent: string): Date | null {
    for (const regex of publishTimeRegexes) {
      const match = regex.exec(htmlContent);
      if (match && match.length >= 2) {
        const timeStr = match[1].trim();
        // 尝试多种时间格式
        const timeFormats = [
          "ISOString", // 2006-01-02T15:04:05Z07:00
          "2006-01-02T15:04:05+00:00",
          "2006-01-02T15:04:05Z",
          "2006-01-02 15:04:05",
          "2006-01-02",
        ];

        for (const format of timeFormats) {
          try {
            if (format === "ISOString") {
              const date = new Date(timeStr);
              if (!isNaN(date.getTime())) {
                return date;
              }
            } else {
              // 需要使用date-fns或其他库来解析自定义格式
              // 这里简化处理，使用Date构造函数
              const date = new Date(timeStr);
              if (!isNaN(date.getTime())) {
                return date;
              }
            }
          } catch (error) {
            continue;
          }
        }
      }
    }
    return null;
  }

  // 解析网盘链接
  private parseNetworkDiskLinks(htmlContent: string): Link[] {
    // 使用cheerio解析HTML
    try {
      const $ = cheerio.load(htmlContent);
      
      // 查找noscript标签中的内容
      const selector = "noscript#flarum-content .container article .Post-body";
      if (this.debugMode) {
        console.log(`[DYYJ] 使用goquery选择器: ${selector}`);
      }

      const links: Link[] = [];
      const seen = new Set<string>();

      $(selector).each((i, s) => {
        // 查找所有p标签
        $(s).find("p").each((j, pEl) => {
          const strongEl = $(pEl).find("strong");
          if (strongEl.length === 0) {
            return;
          }

          const strongText = strongEl.text().trim();
          
          if (this.debugMode) {
            console.log(`[DYYJ]   检查p标签 ${j + 1}，strong文本: ${strongText}`);
          }

          // 检查是否是网盘名称
          if (!this.isNetworkDiskName(strongText)) {
            return;
          }

          if (this.debugMode) {
            console.log(`[DYYJ]   找到网盘名称: ${strongText}`);
          }

          // 在当前p标签或下一个p标签中查找链接
          let linkEl = $(pEl).find("a");
          if (linkEl.length === 0) {
            // 如果当前p没有链接，查找下一个p标签
            const nextP = $(pEl).next();
            if (nextP.length > 0) {
              linkEl = nextP.find("a");
            }
          }

          if (linkEl.length > 0) {
            const linkURL = linkEl.attr("href");
            if (linkURL && !seen.has(linkURL)) {
              seen.add(linkURL);
              
              // 确定网盘类型
              const urlType = this.determineCloudType(linkURL);
              if (urlType !== "others") {
                // 提取密码
                const password = this.extractPasswordFromURL(linkURL);
                
                const link: Link = {
                  url: linkURL,
                  type: urlType,
                  password,
                  text: strongText,
                  workTitle: "",
                };
                
                if (this.debugMode) {
                  console.log(`[DYYJ]   找到网盘链接: ${linkURL} (${urlType}, 密码: ${password})`);
                }
                
                links.push(link);
              } else if (this.debugMode) {
                console.log(`[DYYJ]   链接类型为others，跳过: ${linkURL}`);
              }
            } else if (this.debugMode) {
              console.log(`[DYYJ]   p标签 ${j + 1} 中未找到链接`);
            }
          }
        });
      });

      // 如果goquery没有找到链接，使用正则表达式作为备选
      if (links.length === 0) {
        return this.parseNetworkDiskLinksWithRegex(htmlContent);
      }

      return links;
    } catch (error) {
      if (this.debugMode) {
        console.error(`[DYYJ] cheerio解析失败，使用正则表达式备选: ${error}`);
      }
      // 如果cheerio解析失败，使用正则表达式
      return this.parseNetworkDiskLinksWithRegex(htmlContent);
    }
  }

  // 使用正则表达式解析网盘链接
  private parseNetworkDiskLinksWithRegex(htmlContent: string): Link[] {
    const links: Link[] = [];
    const seen = new Set<string>();

    if (this.debugMode) {
      console.log(`[DYYJ] 使用正则表达式解析网盘链接`);
    }

    // 使用预编译的正则表达式
    for (const pattern of networkDiskPatterns) {
      let match;
      pattern.regex.lastIndex = 0; // 重置正则表达式
      
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
          if (urlType === "others") {
            urlType = pattern.urlType;
          }

          // 只添加有效的网盘链接
          if (urlType !== "others") {
            // 提取密码
            const password = this.extractPasswordFromURL(linkURL);

            const link: Link = {
              url: linkURL,
              type: urlType,
              password,
              text: pattern.name,
              workTitle: "",
            };

            if (this.debugMode) {
              console.log(`[DYYJ] 正则找到网盘链接: ${linkURL} (${urlType}, 密码: ${password})`);
            }

            links.push(link);
          } else if (this.debugMode) {
            console.log(`[DYYJ] 链接类型为others，跳过: ${linkURL}`);
          }
        }
      }
    }

    if (this.debugMode) {
      console.log(`[DYYJ] 正则表达式解析完成，共找到 ${links.length} 个网盘链接`);
    }

    return links;
  }

  // 检查是否是网盘名称
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

  // 从URL中提取密码
  private extractPasswordFromURL(linkURL: string): string {
    // 从URL参数中提取密码
    const patterns = [
      /[?&]pwd=([A-Za-z0-9]{4,8})/,
      /[?&]password=([A-Za-z0-9]{4,8})/,
      /[?&]code=([A-Za-z0-9]{4,8})/,
    ];

    for (const pattern of patterns) {
      const match = pattern.exec(linkURL);
      if (match && match.length > 1) {
        return match[1];
      }
    }

    return "";
  }

  // 根据URL自动识别网盘类型
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
    } else if (url.startsWith("magnet:")) {
      return "magnet";
    } else if (url.startsWith("ed2k://")) {
      return "ed2k";
    } else {
      return "others";
    }
  }
}

// 创建并注册插件
const dyyjPlugin = new DyyjPlugin();
registerGlobalPlugin(dyyjPlugin);

export type { DyyjPlugin };
export const DyyjPluginInstance = dyyjPlugin;