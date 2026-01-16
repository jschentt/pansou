import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios';
import cheerio from 'cheerio';
import { BaseAsyncPlugin } from '../plugin.manager';
import { SearchResult, Link } from '../../models/plugin-result';

const BaseURL = 'https://xzys.fun';
const SearchPath = '/search.html';
const UserAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36';
const MaxConcurrency = 20; // 详情页最大并发数
const MaxPages = 1; // 最大搜索页数（暂时只搜索第一页）
const CacheTTL = 30 * 60 * 1000; // 缓存过期时间（30分钟）

interface DetailCacheItem {
  links: Link[];
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

export class XiaozhangPlugin extends BaseAsyncPlugin {
  private debugMode: boolean;
  private detailCache: Map<string, DetailCacheItem>;

  constructor() {
    super('xiaozhang', 3);
    this.debugMode = false;
    this.detailCache = new Map();
    // 定期清理缓存
    setInterval(() => this.cleanCache(), 10 * 60 * 1000);
  }

  Name(): string {
    return 'xiaozhang';
  }

  DisplayName(): string {
    return '校长影视';
  }

  Description(): string {
    return '校长影视 - 影视资源搜索';
  }

  private cleanCache(): void {
    const now = Date.now();
    for (const [key, item] of this.detailCache.entries()) {
      if (now - item.timestamp > CacheTTL) {
        this.detailCache.delete(key);
      }
    }
  }

  private async doRequestWithRetry(client: AxiosInstance, url: string, referer: string, followRedirect: boolean): Promise<AxiosResponse> {
    const config: AxiosRequestConfig = {
      url,
      method: 'GET',
      headers: {
        'User-Agent': UserAgent,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Accept-Encoding': 'gzip, deflate',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
        'Referer': referer
      },
      maxRedirects: followRedirect ? 5 : 0,
      timeout: 30000
    };

    if (this.debugMode) {
      console.log(`[Xiaozhang] 发送请求: ${url}`);
    }

    try {
      const response = await client(config);
      if (this.debugMode) {
        console.log(`[Xiaozhang] 响应状态: ${response.status}`);
      }
      return response;
    } catch (error) {
      if (this.debugMode) {
        console.log(`[Xiaozhang] 请求失败: ${error}`);
      }
      throw error;
    }
  }

  protected async searchImpl(client: AxiosInstance, keyword: string): Promise<SearchResult[]> {
    const searchURL = `${BaseURL}${SearchPath}?keyword=${encodeURIComponent(keyword)}`;

    if (this.debugMode) {
      console.log(`[Xiaozhang] 开始搜索: ${keyword}`);
      console.log(`[Xiaozhang] 搜索URL: ${searchURL}`);
    }

    try {
      // 发送搜索请求
      const resp = await this.doRequestWithRetry(client, searchURL, BaseURL, true);

      if (resp.status !== 200) {
        throw new Error(`搜索响应状态码异常: ${resp.status}`);
      }

      // 解析HTML
      const $ = cheerio.load(resp.data);

      // 提取搜索结果
      const results = this.extractSearchResults($, keyword);

      if (this.debugMode) {
        console.log(`[Xiaozhang] 找到 ${results.length} 个搜索结果`);
      }

      // 并发获取详情页链接
      const enrichedResults = await this.enrichWithDetailLinks(client, results, keyword);

      // 过滤结果
      const filteredResults = this.filterResultsByKeyword(enrichedResults, keyword);

      if (this.debugMode) {
        console.log(`[Xiaozhang] 过滤后剩余 ${filteredResults.length} 个结果`);
      }

      return filteredResults;
    } catch (error) {
      console.error(`[Xiaozhang] 搜索失败: ${error}`);
      return [];
    }
  }

  private extractSearchResults($: cheerio.CheerioAPI, keyword: string): SearchResult[] {
    const results: SearchResult[] = [];

    if (this.debugMode) {
      // 调试：检查页面标题
      const pageTitle = $('title').text();
      console.log(`[Xiaozhang] 页面标题: ${pageTitle}`);
      
      // 调试：检查是否找到list-boxes
      const listBoxes = $('.list-boxes');
      console.log(`[Xiaozhang] 找到 .list-boxes 元素数量: ${listBoxes.length}`);
    }

    // 选择所有搜索结果项
    $('.list-boxes').each((i, s) => {
      const selection = $(s);
      // 提取标题和详情页链接
      const titleElem = selection.find('a.text_title_p');
      const title = titleElem.text().trim();
      const detailPath = titleElem.attr('href') || '';
      
      if (this.debugMode) {
        console.log(`[Xiaozhang] 处理第 ${i + 1} 个结果: title=${title}, path=${detailPath}`);
      }
      
      if (!title || !detailPath) {
        if (this.debugMode) {
          console.log(`[Xiaozhang] 跳过第 ${i + 1} 个结果：标题或链接为空`);
        }
        return;
      }
      
      // 构建完整的详情页URL
      const detailURL = BaseURL + detailPath;
      
      // 提取描述
      const content = selection.find('p.text_p').text().trim();
      
      // 提取发布时间
      let timeText = selection.find('.list-actions span').first().text().trim();
      timeText = timeText.replace(/&nbsp;/g, ' ').trim();
      
      // 解析时间（格式：2025-08-16）
      let publishTime = new Date();
      if (timeText) {
        try {
          // 尝试解析日期
          const parsedTime = new Date(timeText);
          if (!isNaN(parsedTime.getTime())) {
            publishTime = parsedTime;
          }
        } catch (error) {
          if (this.debugMode) {
            console.log(`[Xiaozhang] 解析时间失败: ${timeText}, 错误: ${error}`);
          }
        }
      }
      
      // 从详情页路径提取ID（如：/subject/9861.html -> 9861）
      let resourceID = '';
      const idMatch = /\/subject\/(\d+)\.html/.exec(detailPath);
      if (idMatch && idMatch[1]) {
        resourceID = idMatch[1];
      } else {
        resourceID = Date.now().toString();
      }
      
      if (this.debugMode) {
        console.log(`[Xiaozhang] 提取结果 ${i + 1}: ${title}, URL: ${detailURL}, 时间: ${timeText}`);
      }
      
      const result: SearchResult = {
        Title: title,
        Content: content,
        Channel: '',
        MessageID: `${this.Name()}-${resourceID}`,
        UniqueID: `${this.Name()}-${resourceID}`,
        Datetime: publishTime,
        Links: [], // 稍后填充
        Tags: [detailURL] // 存储详情页URL供后续使用
      };
      
      results.push(result);
    });
    
    return results;
  }

  private async enrichWithDetailLinks(client: AxiosInstance, results: SearchResult[], keyword: string): Promise<SearchResult[]> {
    if (results.length === 0) {
      return results;
    }

    if (this.debugMode) {
      console.log(`[Xiaozhang] 开始获取 ${results.length} 个详情页的下载链接`);
    }

    const semaphore = new Semaphore(MaxConcurrency);
    const promises = results.map(async (result, idx) => {
      await semaphore.acquire();
      try {
        // 添加小延迟避免请求过快
        await new Promise(resolve => setTimeout(resolve, idx * 50));
        
        // 从Tags中获取详情页URL
        if (result.Tags && result.Tags.length > 0) {
          const detailURL = result.Tags[0];
          const links = await this.fetchDetailPageLinks(client, detailURL, keyword);
          result.Links = links;
          // 清空Tags，避免返回给用户
          result.Tags = [];
          
          if (this.debugMode) {
            console.log(`[Xiaozhang] 详情页 ${idx + 1}/${results.length} 获取到 ${links.length} 个链接`);
          }
        }
        return result;
      } finally {
        semaphore.release();
      }
    });

    return Promise.all(promises);
  }

  private async fetchDetailPageLinks(client: AxiosInstance, detailURL: string, keyword: string): Promise<Link[]> {
    // 检查缓存
    const cached = this.detailCache.get(detailURL);
    if (cached) {
      if (this.debugMode) {
        console.log(`[Xiaozhang] 使用缓存的详情页结果: ${detailURL}`);
      }
      return cached.links;
    }

    try {
      // 第一步：获取重定向位置
      let resp: AxiosResponse;
      try {
        resp = await this.doRequestWithRetry(client, detailURL, BaseURL, false);
      } catch (error) {
        if (this.debugMode) {
          console.log(`[Xiaozhang] 获取详情页失败: ${error}`);
        }
        return [];
      }

      // 获取Location头
      const location = resp.headers['location'] as string;
      let realDetailURL = detailURL;
      let finalResp: AxiosResponse;

      if (location) {
        // 构建真实的详情页URL
        realDetailURL = BaseURL + location;
        if (this.debugMode) {
          console.log(`[Xiaozhang] 重定向到: ${realDetailURL}`);
        }

        // 第二步：访问真实的详情页
        try {
          finalResp = await this.doRequestWithRetry(client, realDetailURL, detailURL, true);
        } catch (error) {
          if (this.debugMode) {
            console.log(`[Xiaozhang] 获取真实详情页失败: ${error}`);
          }
          return [];
        }

        if (finalResp.status !== 200) {
          if (this.debugMode) {
            console.log(`[Xiaozhang] 真实详情页响应状态码异常: ${finalResp.status}`);
          }
          return [];
        }
      } else {
        // 如果没有重定向，可能直接就是详情页
        if (resp.status === 200) {
          finalResp = resp;
        } else {
          if (this.debugMode) {
            console.log(`[Xiaozhang] 未找到重定向位置，状态码: ${resp.status}`);
          }
          return [];
        }
      }

      const links = this.extractDetailPageLinks(finalResp, realDetailURL);

      // 缓存结果
      this.detailCache.set(detailURL, {
        links,
        timestamp: Date.now()
      });

      return links;
    } catch (error) {
      if (this.debugMode) {
        console.log(`[Xiaozhang] 处理详情页失败: ${error}`);
      }
      return [];
    }
  }

  private extractDetailPageLinks(resp: AxiosResponse, pageURL: string): Link[] {
    const $ = cheerio.load(resp.data);
    const links: Link[] = [];
    const linkMap = new Set<string>();

    // 查找所有包含下载链接的p标签
    $('p').each((i, s) => {
      const selection = $(s);
      // 查找p标签内的链接
      selection.find('a[href]').each((j, a) => {
        const href = $(a).attr('href');
        if (!href) {
          return;
        }

        // 过滤非网盘链接
        if (!this.isValidPanLink(href)) {
          return;
        }

        // 去重
        if (linkMap.has(href)) {
          return;
        }
        linkMap.add(href);

        // 提取密码（可能在p标签的文本中）
        let password = '';
        const pText = selection.text().trim();

        // 尝试从文本中提取密码
        if (pText.includes('提取码') || pText.includes('密码')) {
          const passwordMatch = /(?:提取码|密码)[：:]?\s*([a-zA-Z0-9]+)/.exec(pText);
          if (passwordMatch && passwordMatch[1]) {
            password = passwordMatch[1];
          }
        }

        // 尝试从URL中提取密码
        if (!password && href.includes('pwd=')) {
          const urlParams = new URLSearchParams(href.split('?')[1] || '');
          password = urlParams.get('pwd') || '';
        }

        // 判断链接类型
        const linkType = this.determineLinkType(href);

        const link: Link = {
          URL: href,
          Type: linkType,
          Password: password
        };

        if (this.debugMode) {
          console.log(`[Xiaozhang] 提取链接: ${href}, 类型: ${linkType}, 密码: ${password}`);
        }

        links.push(link);
      });
    });

    return links;
  }

  private isValidPanLink(url: string): boolean {
    const panPatterns = [
      'pan.baidu.com',
      'pan.quark.cn',
      'www.aliyundrive.com',
      'www.alipan.com',
      '115.com',
      'cloud.189.cn',
      'pan.xunlei.com',
      'www.123pan.com',
      'www.jianguoyun.com',
      'cowtransfer.com',
      'weidian.com'
    ];

    for (const pattern of panPatterns) {
      if (url.includes(pattern)) {
        return true;
      }
    }

    return false;
  }

  private determineLinkType(url: string): string {
    const linkTypeMap: Record<string, string> = {
      'pan.baidu.com': 'baidu',
      'pan.quark.cn': 'quark',
      'www.aliyundrive.com': 'aliyun',
      'www.alipan.com': 'aliyun',
      '115.com': '115',
      'cloud.189.cn': 'tianyi',
      'pan.xunlei.com': 'xunlei',
      'www.123pan.com': '123',
      'www.jianguoyun.com': 'jianguo',
      'cowtransfer.com': 'cowtransfer',
      'weidian.com': 'weidian'
    };

    for (const pattern in linkTypeMap) {
      if (url.includes(pattern)) {
        return linkTypeMap[pattern];
      }
    }

    return 'other';
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
const plugin = new XiaozhangPlugin();
plugin.register();
