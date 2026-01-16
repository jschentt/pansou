import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import { SearchResult, Link } from '../../models/plugin-result';
import { PluginManager } from '../plugin.manager';

const PluginName = 'meitizy';
const DisplayName = '美体资源';
const Description = '美体资源 - 影视资源网盘链接搜索';
const BaseURL = 'https://video.451024.xyz';
const SearchPath = '/api/search';
const UserAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36';
const MaxResults = 100;
const RequestTimeout = 30000;
const MaxPageSize = 1000;

interface SearchRequest {
  title: string;
  page: number;
  size: number;
}

interface SearchResponse {
  data: ApiItem[];
  total: number;
}

interface ApiItem {
  id: number;
  title: string;
  content: string;
  link: string;
  link_type: string;
  tags: string;
  created_at: string;
  updated_at: string;
}

export class MeitizyPlugin {
  private optimizedClient: AxiosInstance;

  constructor() {
    this.optimizedClient = axios.create({
      baseURL: BaseURL,
      timeout: RequestTimeout,
      headers: {
        'User-Agent': UserAgent,
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Connection': 'keep-alive',
        'Referer': BaseURL + '/'
      },
      maxRedirects: 5,
      httpAgent: new (require('http').Agent)({
        maxSockets: 50,
        maxFreeSockets: 30,
        timeout: 90000
      }),
      httpsAgent: new (require('https').Agent)({
        maxSockets: 50,
        maxFreeSockets: 30,
        timeout: 90000
      })
    });
  }

  public name(): string {
    return PluginName;
  }

  public displayName(): string {
    return DisplayName;
  }

  public description(): string {
    return Description;
  }

  public async search(keyword: string, ext: Record<string, any>): Promise<SearchResult[]> {
    const reqBody: SearchRequest = {
      title: keyword,
      page: 1,
      size: MaxPageSize
    };

    try {
      const resp = await this.doRequestWithRetry({
        url: SearchPath,
        method: 'POST',
        data: reqBody,
        headers: {
          'Content-Type': 'application/json'
        },
        timeout: RequestTimeout
      });

      const apiResp: SearchResponse = resp.data;
      const results = this.convertToSearchResults(apiResp.data);
      const filteredResults = this.filterResultsByKeyword(results, keyword);

      return filteredResults;
    } catch (error) {
      throw new Error(`[${PluginName}] 搜索失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async doRequestWithRetry(config: AxiosRequestConfig): Promise<any> {
    const maxRetries = 3;
    let lastError: any;

    for (let i = 0; i < maxRetries; i++) {
      if (i > 0) {
        const backoff = Math.pow(2, i - 1) * 200;
        await new Promise(resolve => setTimeout(resolve, backoff));
      }

      try {
        const resp = await this.optimizedClient(config);
        if (resp.status === 200) {
          return resp;
        }
      } catch (error) {
        lastError = error;
      }
    }

    throw new Error(`[${PluginName}] 重试 ${maxRetries} 次后仍然失败: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
  }

  private convertToSearchResults(items: ApiItem[]): SearchResult[] {
    const results: SearchResult[] = [];

    for (const item of items) {
      if (!item.link) {
        continue;
      }

      let publishTime = this.parseTime(item.created_at);
      if (!publishTime) {
        publishTime = this.parseTime(item.updated_at);
      }
      if (!publishTime) {
        publishTime = new Date();
      }

      let linkType = this.mapLinkType(item.link_type);
      if (linkType === 'others') {
        linkType = this.determineCloudTypeFromURL(item.link);
      }

      const links: Link[] = [{
        type: linkType,
        url: item.link,
        password: ''
      }];

      const tags: string[] = [];
      if (item.tags) {
        tags.push(item.tags);
      }

      const result: SearchResult = {
        uniqueId: `${PluginName}-${item.id}`,
        title: item.title,
        content: item.content,
        channel: '',
        datetime: publishTime,
        links,
        tags
      };

      results.push(result);
    }

    return results;
  }

  private mapLinkType(apiLinkType: string): string {
    switch (apiLinkType.toLowerCase()) {
      case 'alipan':
        return 'aliyun';
      case 'xunlei':
        return 'xunlei';
      case 'baidu':
        return 'baidu';
      case 'quark':
        return 'quark';
      case 'uc':
        return 'uc';
      case '115':
        return '115';
      case '123':
        return '123';
      case 'tianyi':
        return 'tianyi';
      case 'mobile':
        return 'mobile';
      case 'pikpak':
        return 'pikpak';
      default:
        return 'others';
    }
  }

  private determineCloudTypeFromURL(url: string): string {
    if (url.includes('pan.quark.cn')) {
      return 'quark';
    }
    if (url.includes('drive.uc.cn')) {
      return 'uc';
    }
    if (url.includes('pan.baidu.com')) {
      return 'baidu';
    }
    if (url.includes('aliyundrive.com') || url.includes('alipan.com') || url.includes('www.alipan.com')) {
      return 'aliyun';
    }
    if (url.includes('pan.xunlei.com')) {
      return 'xunlei';
    }
    if (url.includes('cloud.189.cn')) {
      return 'tianyi';
    }
    if (url.includes('caiyun.139.com')) {
      return 'mobile';
    }
    if (url.includes('115.com') || url.includes('115cdn.com') || url.includes('anxia.com')) {
      return '115';
    }
    if (url.includes('123684.com') || url.includes('123685.com') ||
        url.includes('123912.com') || url.includes('123pan.com') ||
        url.includes('123pan.cn') || url.includes('123592.com')) {
      return '123';
    }
    if (url.includes('mypikpak.com')) {
      return 'pikpak';
    }
    if (url.includes('magnet:')) {
      return 'magnet';
    }
    if (url.includes('ed2k://')) {
      return 'ed2k';
    }
    return 'others';
  }

  private parseTime(timeStr: string): Date | null {
    if (!timeStr) {
      return null;
    }

    const timeFormats = [
      'YYYY-MM-DDTHH:mm:ssZ',
      'YYYY-MM-DDTHH:mm:ss.SSSZ',
      'YYYY-MM-DD HH:mm:ss',
      'YYYY-MM-DD'
    ];

    for (const format of timeFormats) {
      const date = this.parseDateTime(timeStr, format);
      if (date) {
        return date;
      }
    }

    return null;
  }

  private parseDateTime(timeStr: string, format: string): Date | null {
    try {
      if (format === 'YYYY-MM-DDTHH:mm:ssZ' || format === 'YYYY-MM-DDTHH:mm:ss.SSSZ') {
        return new Date(timeStr);
      } else if (format === 'YYYY-MM-DD HH:mm:ss') {
        const [datePart, timePart] = timeStr.split(' ');
        if (!datePart || !timePart) {
          return null;
        }
        const [year, month, day] = datePart.split('-').map(Number);
        const [hour, minute, second] = timePart.split(':').map(Number);
        return new Date(year, month - 1, day, hour, minute, second);
      } else if (format === 'YYYY-MM-DD') {
        const [year, month, day] = timeStr.split('-').map(Number);
        return new Date(year, month - 1, day);
      }
    } catch {
      // Ignore parsing errors
    }

    return null;
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

const plugin = new MeitizyPlugin();
PluginManager.registerPlugin(PluginName, plugin, 2);
export default plugin;