import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import { SearchResult, Link } from '../../models/plugin-result';
import { PluginManager } from '../plugin.manager';

const passwordRegex = /\?pwd=([0-9a-zA-Z]+)/;

const quarkLinkRegex = /https?:\/\/pan\.quark\.cn\/s\/[0-9a-zA-Z]+/;
const ucLinkRegex = /https?:\/\/drive\.uc\.cn\/s\/[0-9a-zA-Z]+(\?[^"'\s]*)?/;
const baiduLinkRegex = /https?:\/\/pan\.baidu\.com\/s\/[0-9a-zA-Z_\-]+(\?pwd=[0-9a-zA-Z]+)?/;
const aliyunLinkRegex = /https?:\/\/(www\.)?(aliyundrive\.com|alipan\.com)\/s\/[0-9a-zA-Z]+/;
const xunleiLinkRegex = /https?:\/\/pan\.xunlei\.com\/s\/[0-9a-zA-Z_\-]+(\?pwd=[0-9a-zA-Z]+)?/;
const tianyiLinkRegex = /https?:\/\/cloud\.189\.cn\/t\/[0-9a-zA-Z]+/;
const link115Regex = /https?:\/\/115\.com\/s\/[0-9a-zA-Z]+/;
const mobileLinkRegex = /https?:\/\/caiyun\.feixin\.10086\.cn\/[0-9a-zA-Z]+/;
const link123Regex = /https?:\/\/123pan\.com\/s\/[0-9a-zA-Z]+/;
const pikpakLinkRegex = /https?:\/\/mypikpak\.com\/s\/[0-9a-zA-Z]+/;
const magnetLinkRegex = /magnet:\?xt=urn:btih:[0-9a-fA-F]{40}/;
const ed2kLinkRegex = /ed2k:\/\/\|file\|.+\|\d+\|[0-9a-fA-F]{32}\|\//;

const DefaultTimeout = 8000;

interface OugeAPIItem {
  vod_id: number;
  vod_name: string;
  vod_actor: string;
  vod_director: string;
  vod_down_from: string;
  vod_down_url: string;
  vod_remarks: string;
  vod_pubdate: string;
  vod_area: string;
  vod_year: string;
  vod_content: string;
  vod_pic: string;
}

interface OugeAPIResponse {
  code: number;
  msg: string;
  page: number;
  pagecount: number;
  limit: number;
  total: number;
  list: OugeAPIItem[];
}

export class OugeAsyncPlugin {
  private client: AxiosInstance;
  private performanceStats = {
    searchRequests: 0,
    totalSearchTime: 0
  };

  constructor() {
    this.client = axios.create({
      timeout: DefaultTimeout,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Connection': 'keep-alive',
        'Referer': 'https://woog.nxog.eu.org/',
        'Cache-Control': 'no-cache'
      }
    });
  }

  public async search(keyword: string, ext: Record<string, any>): Promise<SearchResult[]> {
    const start = Date.now();
    this.performanceStats.searchRequests++;

    try {
      const searchURL = `https://woog.nxog.eu.org/api.php/provide/vod?ac=detail&wd=${encodeURIComponent(keyword)}`;

      const resp = await this.doRequestWithRetry({
        url: searchURL,
        method: 'GET',
        timeout: DefaultTimeout
      });

      const apiResponse: OugeAPIResponse = resp.data;

      if (apiResponse.code !== 1) {
        throw new Error(`API返回错误: ${apiResponse.msg}`);
      }

      const results: SearchResult[] = [];
      for (const item of apiResponse.list) {
        const result = this.parseAPIItem(item);
        if (result.title) {
          results.push(result);
        }
      }

      return results;
    } catch (error) {
      console.error(`[ouge] 搜索失败: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    } finally {
      this.performanceStats.totalSearchTime += Date.now() - start;
    }
  }

  private parseAPIItem(item: OugeAPIItem): SearchResult {
    const uniqueID = `ouge-${item.vod_id}`;
    const title = item.vod_name.trim();

    if (!title) {
      return {
        uniqueId: '',
        title: '',
        content: '',
        links: [],
        tags: [],
        channel: '',
        datetime: new Date(),
        images: []
      };
    }

    const contentParts: string[] = [];
    if (item.vod_actor) {
      contentParts.push(`主演: ${item.vod_actor}`);
    }
    if (item.vod_director) {
      contentParts.push(`导演: ${item.vod_director}`);
    }
    if (item.vod_area) {
      contentParts.push(`地区: ${item.vod_area}`);
    }
    if (item.vod_year) {
      contentParts.push(`年份: ${item.vod_year}`);
    }
    if (item.vod_remarks) {
      contentParts.push(`状态: ${item.vod_remarks}`);
    }
    const content = contentParts.join(' | ');

    const links = this.parseDownloadLinks(item.vod_down_from, item.vod_down_url);

    const images: string[] = [];
    if (item.vod_pic) {
      images.push(item.vod_pic);
    }

    const tags: string[] = [];
    if (item.vod_year) {
      tags.push(item.vod_year);
    }
    if (item.vod_area) {
      tags.push(item.vod_area);
    }

    return {
      uniqueId: uniqueID,
      title: title,
      content: content,
      links: links,
      tags: tags,
      images: images,
      channel: '',
      datetime: new Date()
    };
  }

  private parseDownloadLinks(vodDownFrom: string, vodDownURL: string): Link[] {
    if (!vodDownFrom || !vodDownURL) {
      return [];
    }

    const fromParts = vodDownFrom.split('$$$');
    const urlParts = vodDownURL.split('$$$');

    const minLen = Math.min(fromParts.length, urlParts.length);
    const links: Link[] = [];

    for (let i = 0; i < minLen; i++) {
      const fromType = fromParts[i].trim();
      const urlStr = urlParts[i].trim();

      if (!urlStr || !this.isValidNetworkDriveURL(urlStr)) {
        continue;
      }

      const linkType = this.mapCloudType(fromType, urlStr);
      if (!linkType) {
        continue;
      }

      const password = this.extractPassword(urlStr);

      links.push({
        type: linkType,
        url: urlStr,
        password: password
      });
    }

    return links;
  }

  private mapCloudType(apiType: string, url: string): string {
    switch (apiType.toUpperCase()) {
      case 'BD':
        return 'baidu';
      case 'KG':
        return 'quark';
      case 'UC':
        return 'uc';
      case 'ALY':
        return 'aliyun';
      case 'XL':
        return 'xunlei';
      case 'TY':
        return 'tianyi';
      case '115':
        return '115';
      case 'MB':
        return 'mobile';
      case '123':
        return '123';
      case 'PK':
        return 'pikpak';
      default:
        return this.determineLinkType(url);
    }
  }

  private isValidNetworkDriveURL(url: string): boolean {
    if (
      url.includes('javascript:') ||
      url.includes('#') ||
      url === '' ||
      (!url.startsWith('http') && !url.startsWith('magnet:') && !url.startsWith('ed2k:'))
    ) {
      return false;
    }

    return (
      quarkLinkRegex.test(url) ||
      ucLinkRegex.test(url) ||
      baiduLinkRegex.test(url) ||
      aliyunLinkRegex.test(url) ||
      xunleiLinkRegex.test(url) ||
      tianyiLinkRegex.test(url) ||
      link115Regex.test(url) ||
      mobileLinkRegex.test(url) ||
      link123Regex.test(url) ||
      pikpakLinkRegex.test(url) ||
      magnetLinkRegex.test(url) ||
      ed2kLinkRegex.test(url)
    );
  }

  private determineLinkType(url: string): string {
    if (quarkLinkRegex.test(url)) return 'quark';
    if (ucLinkRegex.test(url)) return 'uc';
    if (baiduLinkRegex.test(url)) return 'baidu';
    if (aliyunLinkRegex.test(url)) return 'aliyun';
    if (xunleiLinkRegex.test(url)) return 'xunlei';
    if (tianyiLinkRegex.test(url)) return 'tianyi';
    if (link115Regex.test(url)) return '115';
    if (mobileLinkRegex.test(url)) return 'mobile';
    if (link123Regex.test(url)) return '123';
    if (pikpakLinkRegex.test(url)) return 'pikpak';
    if (magnetLinkRegex.test(url)) return 'magnet';
    if (ed2kLinkRegex.test(url)) return 'ed2k';
    return '';
  }

  private extractPassword(url: string): string {
    const matches = url.match(passwordRegex);
    return matches && matches.length > 1 ? matches[1] : '';
  }

  private async doRequestWithRetry(config: AxiosRequestConfig): Promise<any> {
    const maxRetries = 2;
    let lastError: any;

    for (let i = 0; i < maxRetries; i++) {
      try {
        const resp = await this.client(config);
        if (resp.status === 200) {
          return resp;
        }
        lastError = new Error(`HTTP状态码: ${resp.status}`);
      } catch (error) {
        lastError = error;
      }

      if (i < maxRetries - 1) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }

    throw new Error(`请求失败，重试${maxRetries}次后仍失败: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
  }

  public getPerformanceStats(): Record<string, any> {
    const { searchRequests, totalSearchTime } = this.performanceStats;
    let avgTime = 0;
    if (searchRequests > 0) {
      avgTime = totalSearchTime / searchRequests;
    }

    return {
      search_requests: searchRequests,
      avg_search_time_ms: avgTime,
      total_search_time_ms: totalSearchTime
    };
  }
}

const plugin = new OugeAsyncPlugin();
PluginManager.registerPlugin('ouge', plugin, 2);
export default plugin;