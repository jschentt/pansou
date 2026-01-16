import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios';
import { BaseAsyncPlugin } from '../plugin.manager';
import { SearchResult, Link } from '../../models/plugin-result';

// 预编译的常量
const pluginName = 'xdyh';
const apiURL = 'https://ys.66ds.de/search';
const refererURL = 'https://ys.66ds.de/';

// 超时时间配置
const DefaultTimeout = 15000; // API聚合搜索需要更长时间

// 并发数配置
const MaxConcurrency = 10;

// 缓存相关
const CacheTTL = 30 * 60 * 1000; // API搜索结果缓存时间相对较短

interface SearchCacheItem {
  results: SearchResult[];
  timestamp: number;
}

interface SearchRequest {
  Keyword: string;
  Sites: string[] | null; // null表示搜索所有站点
  MaxWorkers: number; // API默认并发数
  SaveToFile: boolean;
  SplitLinks: boolean;
}

interface APIResponse {
  Status: string;
  Keyword: string;
  SearchTimestamp: string;
  Summary: Summary;
  SuccessfulSites: string[];
  FailedSites: string[];
  Data: SearchResultItem[];
  Performance: Performance;
}

interface Summary {
  TotalSitesSearched: number;
  SuccessfulSites: number;
  FailedSites: number;
  TotalSearchResults: number;
  TotalSuccessfulParses: number;
  TotalDriveLinks: number;
  UniqueLinks: number;
}

interface SearchResultItem {
  Title: string;
  PostDate: string;
  DriveLinks: string[];
  HasLinks: boolean;
  LinkCount: number;
  Password?: string;
  HasPassword?: boolean;
  SourceSite: string;
  SourceAPI?: string;
  FilePreview?: string;
}

interface Performance {
  TotalSearchTime: number;
  SitesSearched: number;
  AvgTimePerSite: number;
  Optimization: string;
  Timestamp: string;
}

export class XdyhPlugin extends BaseAsyncPlugin {
  private searchCache: Map<string, SearchCacheItem>;
  private lastCleanupTime: number;

  constructor() {
    super(pluginName, 3);
    this.searchCache = new Map();
    this.lastCleanupTime = Date.now();
    // 启动缓存清理
    this.startCacheCleaner();
  }

  Name(): string {
    return pluginName;
  }

  DisplayName(): string {
    return 'XDYH聚合搜索';
  }

  Description(): string {
    return 'XDYH聚合搜索 - 多站点资源聚合';
  }

  private startCacheCleaner(): void {
    setInterval(() => {
      this.cleanCache();
    }, 20 * 60 * 1000); // 每20分钟清理一次
  }

  private cleanCache(): void {
    const now = Date.now();
    for (const [key, item] of this.searchCache.entries()) {
      if (now - item.timestamp > CacheTTL) {
        this.searchCache.delete(key);
      }
    }
    this.lastCleanupTime = now;
  }

  private async doRequestWithRetry(client: AxiosInstance, config: AxiosRequestConfig): Promise<AxiosResponse> {
    const maxRetries = 3;
    let lastError: Error | null = null;

    for (let i = 0; i < maxRetries; i++) {
      if (i > 0) {
        // 指数退避重试
        const backoff = Math.pow(2, i - 1) * 500;
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
    // 1. 检查缓存
    const cacheKey = `${pluginName}_${keyword}`;
    const cached = this.searchCache.get(cacheKey);
    if (cached) {
      if (Date.now() - cached.timestamp < CacheTTL) {
        return cached.results;
      }
      // 缓存过期，删除
      this.searchCache.delete(cacheKey);
    }

    // 2. 构建请求体
    const requestBody: SearchRequest = {
      Keyword: keyword,
      Sites: null, // null表示搜索所有站点
      MaxWorkers: 10, // API默认并发数
      SaveToFile: false,
      SplitLinks: true
    };

    // 3. 创建请求配置
    const config: AxiosRequestConfig = {
      url: apiURL,
      method: 'POST',
      headers: this.getRequestHeaders(),
      data: requestBody,
      timeout: DefaultTimeout
    };

    try {
      // 4. 发送请求（带重试机制）
      const resp = await this.doRequestWithRetry(client, config);

      // 5. 解析JSON响应
      const apiResp: APIResponse = resp.data;

      // 6. 检查API响应状态
      if (apiResp.Status !== 'success') {
        throw new Error(`API返回错误状态: ${apiResp.Status}`);
      }

      // 7. 转换为标准格式
      const results = this.convertToSearchResults(apiResp, keyword);

      // 8. 缓存结果
      if (results.length > 0) {
        this.searchCache.set(cacheKey, {
          results,
          timestamp: Date.now()
        });
      }

      // 9. 关键词过滤
      return this.filterResultsByKeyword(results, keyword);
    } catch (error) {
      console.error(`[Xdyh] 搜索失败: ${error}`);
      return [];
    }
  }

  private getRequestHeaders(): Record<string, string> {
    return {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'Connection': 'keep-alive',
      'Content-Type': 'application/json',
      'Referer': refererURL,
      'Origin': 'https://ys.66ds.de',
      'Cache-Control': 'max-age=0'
    };
  }

  private convertToSearchResults(apiResp: APIResponse, keyword: string): SearchResult[] {
    const results: SearchResult[] = [];
    const seenTitles = new Set<string>(); // 去重用

    for (let i = 0; i < apiResp.Data.length; i++) {
      const item = apiResp.Data[i];
      
      // 简单去重处理
      const titleKey = `${item.Title}_${item.SourceSite}`;
      if (seenTitles.has(titleKey)) {
        continue;
      }
      seenTitles.add(titleKey);

      // 转换链接
      const links = this.convertDriveLinks(item);
      if (links.length === 0) {
        continue; // 跳过没有有效链接的结果
      }

      // 解析时间
      const datetime = this.parseDateTime(item.PostDate);

      // 构建内容描述
      const content = this.buildContentDescription(item);

      // 提取标签
      const tags = this.extractTags(item.Title, item.SourceSite);

      // 创建搜索结果
      const result: SearchResult = {
        Title: item.Title,
        Content: content,
        Channel: '',
        MessageID: `${pluginName}-${i}`,
        UniqueID: `${pluginName}-${i}`,
        Datetime: datetime,
        Links: links,
        Tags: tags
      };

      results.push(result);
    }

    return results;
  }

  private convertDriveLinks(item: SearchResultItem): Link[] {
    const links: Link[] = [];

    for (const driveURL of item.DriveLinks) {
      if (!driveURL) {
        continue;
      }

      // 验证链接有效性
      if (!this.isValidURL(driveURL)) {
        continue;
      }

      // 确定网盘类型
      const linkType = this.determineCloudType(driveURL);

      // 创建链接对象
      const link: Link = {
        Type: linkType,
        URL: driveURL,
        Password: item.Password || '' // API已提供密码字段
      };

      links.push(link);
    }

    return links;
  }

  private parseDateTime(dateStr: string): Date {
    // 尝试不同的时间格式
    const formats = [
      'YYYY-MM-DD HH:mm:ss',
      'YYYY-MM-DD',
      'YYYY/MM/DD',
      'MM/DD/YYYY'
    ];

    for (const format of formats) {
      try {
        if (format === 'YYYY-MM-DD HH:mm:ss') {
          const parts = dateStr.split(' ');
          if (parts.length === 2) {
            const dateParts = parts[0].split('-');
            const timeParts = parts[1].split(':');
            if (dateParts.length === 3 && timeParts.length === 3) {
              const year = parseInt(dateParts[0]);
              const month = parseInt(dateParts[1]) - 1;
              const day = parseInt(dateParts[2]);
              const hour = parseInt(timeParts[0]);
              const minute = parseInt(timeParts[1]);
              const second = parseInt(timeParts[2]);
              if (!isNaN(year) && !isNaN(month) && !isNaN(day) && !isNaN(hour) && !isNaN(minute) && !isNaN(second)) {
                return new Date(year, month, day, hour, minute, second);
              }
            }
          }
        } else if (format === 'YYYY-MM-DD') {
          const parts = dateStr.split('-');
          if (parts.length === 3) {
            const year = parseInt(parts[0]);
            const month = parseInt(parts[1]) - 1;
            const day = parseInt(parts[2]);
            if (!isNaN(year) && !isNaN(month) && !isNaN(day)) {
              return new Date(year, month, day);
            }
          }
        } else if (format === 'YYYY/MM/DD') {
          const parts = dateStr.split('/');
          if (parts.length === 3) {
            const year = parseInt(parts[0]);
            const month = parseInt(parts[1]) - 1;
            const day = parseInt(parts[2]);
            if (!isNaN(year) && !isNaN(month) && !isNaN(day)) {
              return new Date(year, month, day);
            }
          }
        } else if (format === 'MM/DD/YYYY') {
          const parts = dateStr.split('/');
          if (parts.length === 3) {
            const month = parseInt(parts[0]) - 1;
            const day = parseInt(parts[1]);
            const year = parseInt(parts[2]);
            if (!isNaN(year) && !isNaN(month) && !isNaN(day)) {
              return new Date(year, month, day);
            }
          }
        }
      } catch (error) {
        // 解析失败，尝试下一种格式
      }
    }

    // 解析失败时返回当前时间
    return new Date();
  }

  private buildContentDescription(item: SearchResultItem): string {
    const parts: string[] = [];

    // 来源站点
    if (item.SourceSite) {
      parts.push(`来源: ${item.SourceSite}`);
    }

    // 链接数量
    if (item.LinkCount > 0) {
      parts.push(`链接数: ${item.LinkCount}`);
    }

    // 密码信息
    if (item.HasPassword && item.Password) {
      parts.push(`密码: ${item.Password}`);
    }

    // 文件预览
    if (item.FilePreview) {
      let preview = item.FilePreview.replace(/<em>/g, '').replace(/<\/em>/g, '');
      if (preview.length > 100) {
        preview = preview.substring(0, 100) + '...';
      }
      parts.push(`预览: ${preview}`);
    }

    return parts.join(' | ');
  }

  private extractTags(title: string, sourceSite: string): string[] {
    const tags: string[] = [];

    // 添加来源站点作为标签
    if (sourceSite) {
      tags.push(sourceSite);
    }

    // 从标题中提取常见标签
    const titleLower = title.toLowerCase();
    const tagKeywords: Record<string, string> = {
      '4k': '4K',
      '1080p': '1080P',
      '720p': '720P',
      '蓝光': '蓝光',
      '高清': '高清',
      '更新': '更新中',
      '完结': '完结',
      '电影': '电影',
      '剧集': '剧集',
      '动漫': '动漫',
      '综艺': '综艺'
    };

    for (const keyword in tagKeywords) {
      if (titleLower.includes(keyword)) {
        tags.push(tagKeywords[keyword]);
      }
    }

    return tags;
  }

  private isValidURL(urlStr: string): boolean {
    if (!urlStr) {
      return false;
    }

    // 检查基本的URL格式
    if (urlStr.startsWith('http://') || urlStr.startsWith('https://')) {
      // HTTP/HTTPS链接需要有域名
      if (urlStr.length <= 8 || urlStr === 'http://' || urlStr === 'https://') {
        return false;
      }
      // 简单检查是否包含域名
      return urlStr.substring(8).includes('.');
    }

    return false;
  }

  private determineCloudType(url: string): string {
    if (url.includes('pan.quark.cn')) {
      return 'quark';
    } else if (url.includes('drive.uc.cn')) {
      return 'uc';
    } else if (url.includes('pan.baidu.com')) {
      return 'baidu';
    } else if (url.includes('aliyundrive.com') || url.includes('alipan.com')) {
      return 'aliyun';
    } else if (url.includes('pan.xunlei.com')) {
      return 'xunlei';
    } else if (url.includes('cloud.189.cn')) {
      return 'tianyi';
    } else if (url.includes('115.com') || url.includes('115cdn.com')) {
      return '115';
    } else if (url.includes('123pan.com')) {
      return '123';
    } else if (url.includes('caiyun.139.com')) {
      return 'mobile';
    } else if (url.includes('mypikpak.com')) {
      return 'pikpak';
    } else {
      return 'others';
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

// 注册插件
const plugin = new XdyhPlugin();
plugin.register();
