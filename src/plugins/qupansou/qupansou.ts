import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import { SearchResult, Link, PluginSearchResult } from '../../../model';

// 常量定义
const ApiURL = 'https://v.funletu.com/search';
const DefaultTimeout = 6000; // 默认超时时间：6秒
const DefaultPageSize = 1000;

// 缓存有效期（1小时）
const cacheTTL = 1 * 60 * 60 * 1000;

// 缓存项结构
interface CachedResponse {
  results: SearchResult[];
  timestamp: number;
}

// 缓存管理
class CacheManager {
  private cache = new Map<string, CachedResponse>();
  private lastCleanTime = Date.now();
  private cleanerInterval: NodeJS.Timeout | null = null;

  constructor() {
    // 启动缓存清理定时器
    this.startCacheCleaner();
  }

  // 启动缓存清理定时器
  private startCacheCleaner() {
    if (this.cleanerInterval) {
      clearInterval(this.cleanerInterval);
    }
    // 每小时清理一次过期缓存
    this.cleanerInterval = setInterval(() => {
      this.cleanExpiredCache();
    }, cacheTTL);
  }

  // 清理过期缓存
  private cleanExpiredCache() {
    const now = Date.now();
    for (const [key, value] of this.cache.entries()) {
      if (now - value.timestamp > cacheTTL) {
        this.cache.delete(key);
      }
    }
    this.lastCleanTime = now;
  }

  // 获取缓存
  get(key: string): SearchResult[] | null {
    const cached = this.cache.get(key);
    if (!cached) {
      return null;
    }
    // 检查缓存是否过期
    if (Date.now() - cached.timestamp > cacheTTL) {
      this.cache.delete(key);
      return null;
    }
    return cached.results;
  }

  // 设置缓存
  set(key: string, results: SearchResult[]) {
    this.cache.set(key, {
      results,
      timestamp: Date.now()
    });
  }

  // 清空所有缓存
  clear() {
    this.cache.clear();
  }
}

// 创建全局缓存实例
const cacheManager = new CacheManager();

// QuPanSouItem API响应中的单个结果项
interface QuPanSouItem {
  id: number;
  title: string;
  filename: string;
  url: string;
  link: string;
  searchtext: string;
  extcode: string;
  unzipcode: string;
  size: string;
  categoryid: number;
  category: string;
  courseid: number;
  course: string;
  filetypeid: number;
  filetype: string;
  updatetime: string;
  createtime: string;
  views: number;
  viewshistory: number;
  diff: number;
  violate: number;
  state: number;
  sort: number;
  top: number;
  valid: number;
}

// QuPanSouResponse API响应结构
interface QuPanSouResponse {
  text: string;
  data: QuPanSouItem[];
  total: number;
  status: number;
  message: string;
}

// QuPanSouPlugin 趣盘搜插件
class QuPanSouPlugin {
  private client: AxiosInstance;
  private MainCacheKey: string;
  private name: string;

  constructor() {
    this.client = axios.create({
      timeout: DefaultTimeout,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Referer': 'https://pan.funletu.com/',
      },
      httpsAgent: new (require('https').Agent)({
        rejectUnauthorized: false
      })
    });

    this.MainCacheKey = 'qupansou';
    this.name = 'qupansou';
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
    // 先检查缓存
    const cachedResults = cacheManager.get(keyword);
    if (cachedResults) {
      return {
        Results: cachedResults,
        IsFinal: true,
        CacheKey: cacheKey
      };
    }

    const results = await searchImpl(this.client, keyword, ext);
    
    // 缓存结果
    cacheManager.set(keyword, results);

    return {
      Results: results,
      IsFinal: true,
      CacheKey: cacheKey
    };
  }

  // searchImpl 实现搜索逻辑
  private async searchImpl(client: AxiosInstance, keyword: string, ext: Record<string, any>): Promise<SearchResult[]> {
    // 发送API请求
    const items = await this.searchAPI(client, keyword);
    
    // 转换为标准格式
    const results = this.convertResults(items);
    
    return results;
  }

  // searchAPI 向API发送请求
  private async searchAPI(client: AxiosInstance, keyword: string): Promise<QuPanSouItem[]> {
    // 构建请求体
    const reqBody = {
      style: "get",
      datasrc: "search",
      query: {
        id: "",
        datetime: "",
        courseid: 1,
        categoryid: "",
        filetypeid: "",
        filetype: "",
        reportid: "",
        validid: "",
        searchtext: keyword,
      },
      page: {
        pageSize: DefaultPageSize,
        pageIndex: 1,
      },
      order: {
        prop: "sort",
        order: "desc",
      },
      message: "请求资源列表数据",
    };

    let response;
    try {
      response = await client.request({
        method: 'POST',
        url: ApiURL,
        data: reqBody
      });
    } catch (err) {
      throw new Error(`API请求失败: ${err instanceof Error ? err.message : String(err)}`);
    }

    // 检查响应状态
    if (response.status !== 200) {
      throw new Error(`API返回错误状态码: ${response.status}`);
    }

    // 解析响应
    const apiResp: QuPanSouResponse = response.data;

    // 检查API内部状态
    if (apiResp.status !== 200) {
      throw new Error(`API返回错误: ${apiResp.message}`);
    }

    return apiResp.data;
  }

  // convertResults 将API响应转换为标准SearchResult格式
  private convertResults(items: QuPanSouItem[]): SearchResult[] {
    const results: SearchResult[] = [];

    for (const item of items) {
      // 跳过无效的URL
      if (item.url === "") {
        continue;
      }

      // 创建链接
      const link: Link = {
        URL: item.url,
        Type: this.determineLinkType(item.url),
        Password: "", // 趣盘搜API不返回密码
      };

      // 创建唯一ID
      const uniqueID = `qupansou-${item.id}`;

      // 解析时间
      let datetime = new Date();
      if (item.updatetime) {
        // 尝试解析时间，格式：2025-07-05 00:31:38
        const parsedTime = new Date(item.updatetime);
        if (!isNaN(parsedTime.getTime())) {
          datetime = parsedTime;
        }
      }

      // 清理标题中的HTML标签
      const title = this.cleanHTML(item.title);

      // 创建搜索结果
      const result: SearchResult = {
        MessageID: uniqueID,
        UniqueID: uniqueID,
        Title: title,
        Content: `类别: ${item.category}, 文件类型: ${item.filetype}, 大小: ${item.size}`,
        Datetime: datetime,
        Links: [link],
        Channel: "", // 插件搜索结果Channel必须为空
      };

      results.push(result);
    }

    return results;
  }

  // determineLinkType 根据URL确定链接类型
  private determineLinkType(url: string): string {
    const lowerURL = url.toLowerCase();

    if (lowerURL.includes("pan.baidu.com")) {
      return "baidu";
    } else if (lowerURL.includes("aliyundrive.com") || lowerURL.includes("alipan.com")) {
      return "aliyun";
    } else if (lowerURL.includes("pan.quark.cn")) {
      return "quark";
    } else if (lowerURL.includes("cloud.189.cn")) {
      return "tianyi";
    } else if (lowerURL.includes("pan.xunlei.com")) {
      return "xunlei";
    } else if (lowerURL.includes("caiyun.139.com") || lowerURL.includes("www.caiyun.139.com")) {
      return "mobile";
    } else if (lowerURL.includes("115.com")) {
      return "115";
    } else if (lowerURL.includes("drive.uc.cn")) {
      return "uc";
    } else if (lowerURL.includes("pan.123.com") || lowerURL.includes("123pan.com")) {
      return "123";
    } else if (lowerURL.includes("mypikpak.com")) {
      return "pikpak";
    } else if (lowerURL.includes("lanzou")) {
      return "lanzou";
    } else {
      return "others";
    }
  }

  // cleanHTML 清理HTML标签
  private cleanHTML(html: string): string {
    // 一次性替换所有常见HTML标签
    const replacements: Record<string, string> = {
      "<em>": "",
      "</em>": "",
      "<b>": "",
      "</b>": "",
      "<strong>": "",
      "</strong>": "",
      "<i>": "",
      "</i>": "",
    };

    let result = html;
    for (const [tag, replacement] of Object.entries(replacements)) {
      result = result.replace(new RegExp(tag, "g"), replacement);
    }

    // 移除多余的空格
    return result.trim();
  }
}

// 创建并导出插件实例
export default new QuPanSouPlugin();