import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios';
import { BaseAsyncPlugin } from '../plugin.manager';
import { SearchResult, Link } from '../../models/plugin-result';

const DefaultTimeout = 8000; // 8秒

// 性能统计
let searchRequests: number = 0;
let totalSearchTime: number = 0; // 毫秒

// 预编译的正则表达式
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
const ed2kLinkRegex = /ed2k:\/\/\|file\|[^\|]+\|\d+\|[0-9a-fA-F]{32}\|\//;

// API响应结构
interface WanouAPIResponse {
  code: number;
  msg: string;
  page: number;
  pagecount: number;
  limit: number;
  total: number;
  list: WanouAPIItem[];
}

interface WanouAPIItem {
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

export class WanouPlugin extends BaseAsyncPlugin {
  constructor() {
    super('wanou', 1); // 优先级1
  }

  Name(): string {
    return 'wanou';
  }

  DisplayName(): string {
    return '万欧';
  }

  Description(): string {
    return '万欧 - 网盘资源搜索';
  }

  private async doRequestWithRetry(client: AxiosInstance, config: AxiosRequestConfig): Promise<AxiosResponse> {
    const maxRetries = 2; // 对于JSON API减少重试次数
    let lastError: Error | null = null;

    for (let i = 0; i < maxRetries; i++) {
      try {
        const response = await client(config);
        if (response.status === 200) {
          return response;
        }
        lastError = new Error(`HTTP状态码: ${response.status}`);
      } catch (error) {
        lastError = error as Error;
      }

      // JSON API快速重试：只等待很短时间
      if (i < maxRetries - 1) {
        await new Promise(resolve => setTimeout(resolve, 100)); // 100毫秒
      }
    }

    throw new Error(`请求失败，重试${maxRetries}次后仍失败: ${lastError?.message}`);
  }

  protected async searchImpl(client: AxiosInstance, keyword: string): Promise<SearchResult[]> {
    // 性能统计
    const start = Date.now();
    searchRequests++;
    
    try {
      // 构建API搜索URL
      const searchURL = `https://woog.nxog.eu.org/api.php/provide/vod?ac=detail&wd=${encodeURIComponent(keyword)}`;
      
      // 发送请求
      const resp = await this.doRequestWithRetry(client, {
        url: searchURL,
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
          'Accept': 'application/json, text/plain, */*',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
          'Connection': 'keep-alive',
          'Referer': 'https://woog.nxog.eu.org/',
          'Cache-Control': 'no-cache'
        },
        timeout: DefaultTimeout
      });
      
      // 解析JSON响应
      const apiResp: WanouAPIResponse = resp.data;
      
      // 检查API响应状态
      if (apiResp.code !== 1) {
        throw new Error(`API返回错误: ${apiResp.msg}`);
      }
      
      // 解析搜索结果
      const results: SearchResult[] = [];
      for (const item of apiResp.list) {
        const result = this.parseAPIItem(item);
        if (result.Title) {
          results.push(result);
        }
      }
      
      return results;
    } finally {
      // 更新性能统计
      const duration = Date.now() - start;
      totalSearchTime += duration;
    }
  }

  private parseAPIItem(item: WanouAPIItem): SearchResult {
    // 构建唯一ID
    const uniqueID = `${this.Name()}-${item.vod_id}`;
    
    // 构建标题
    const title = item.vod_name.trim();
    if (!title) {
      return {} as SearchResult;
    }
    
    // 构建描述
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
    
    // 解析下载链接
    const links = this.parseDownloadLinks(item.vod_down_from, item.vod_down_url);

    // 提取封面图片
    const images: string[] = [];
    if (item.vod_pic) {
      images.push(item.vod_pic);
    }

    // 构建标签
    const tags: string[] = [];
    if (item.vod_year) {
      tags.push(item.vod_year);
    }
    if (item.vod_area) {
      tags.push(item.vod_area);
    }

    return {
      UniqueID: uniqueID,
      Title: title,
      Content: content,
      Links: links,
      Tags: tags,
      Channel: '', // 插件搜索结果Channel为空
      Datetime: new Date(),
      MessageID: uniqueID,
      Images: images
    };
  }

  private parseDownloadLinks(vodDownFrom: string, vodDownURL: string): Link[] {
    if (!vodDownFrom || !vodDownURL) {
      return [];
    }
    
    // 按$$$分隔
    const fromParts = vodDownFrom.split('$$$');
    const urlParts = vodDownURL.split('$$$');
    
    // 确保数组长度一致
    const minLen = Math.min(fromParts.length, urlParts.length);
    
    const links: Link[] = [];
    for (let i = 0; i < minLen; i++) {
      const fromType = fromParts[i].trim();
      const urlStr = urlParts[i].trim();
      
      if (!urlStr) {
        continue;
      }
      
      // 直接确定链接类型
      const linkType = this.determineLinkTypeOptimized(fromType, urlStr);
      if (!linkType) {
        continue;
      }
      
      // 提取密码
      const password = this.extractPassword(urlStr);
      
      links.push({
        Type: linkType,
        URL: urlStr,
        Password: password
      });
    }
    
    return links;
  }

  private determineLinkTypeOptimized(apiType: string, url: string): string {
    // 基本验证
    if (url.includes('javascript:') || 
        url.includes('#') ||
        !url ||
        (!url.startsWith('http') && !url.startsWith('magnet:') && !url.startsWith('ed2k:'))) {
      return '';
    }
    
    // 优先根据API标识快速映射
    switch (apiType.toUpperCase()) {
      case 'BD':
        if (baiduLinkRegex.test(url)) {
          return 'baidu';
        }
        break;
      case 'KG':
        if (quarkLinkRegex.test(url)) {
          return 'quark';
        }
        break;
      case 'UC':
        if (ucLinkRegex.test(url)) {
          return 'uc';
        }
        break;
      case 'ALY':
        if (aliyunLinkRegex.test(url)) {
          return 'aliyun';
        }
        break;
      case 'XL':
        if (xunleiLinkRegex.test(url)) {
          return 'xunlei';
        }
        break;
      case 'TY':
        if (tianyiLinkRegex.test(url)) {
          return 'tianyi';
        }
        break;
      case '115':
        if (link115Regex.test(url)) {
          return '115';
        }
        break;
      case 'MB':
        if (mobileLinkRegex.test(url)) {
          return 'mobile';
        }
        break;
      case '123':
        if (link123Regex.test(url)) {
          return '123';
        }
        break;
      case 'PIKPAK':
        if (pikpakLinkRegex.test(url)) {
          return 'pikpak';
        }
        break;
    }
    
    // 如果API标识匹配失败，回退到URL正则匹配
    return this.determineLinkType(url);
  }

  private determineLinkType(url: string): string {
    if (quarkLinkRegex.test(url)) {
      return 'quark';
    }
    if (ucLinkRegex.test(url)) {
      return 'uc';
    }
    if (baiduLinkRegex.test(url)) {
      return 'baidu';
    }
    if (aliyunLinkRegex.test(url)) {
      return 'aliyun';
    }
    if (xunleiLinkRegex.test(url)) {
      return 'xunlei';
    }
    if (tianyiLinkRegex.test(url)) {
      return 'tianyi';
    }
    if (link115Regex.test(url)) {
      return '115';
    }
    if (mobileLinkRegex.test(url)) {
      return 'mobile';
    }
    if (link123Regex.test(url)) {
      return '123';
    }
    if (pikpakLinkRegex.test(url)) {
      return 'pikpak';
    }
    if (magnetLinkRegex.test(url)) {
      return 'magnet';
    }
    if (ed2kLinkRegex.test(url)) {
      return 'ed2k';
    }
    return ''; // 不支持的类型返回空字符串
  }

  private extractPassword(url: string): string {
    const matches = passwordRegex.exec(url);
    if (matches && matches[1]) {
      return matches[1];
    }
    return '';
  }

  GetPerformanceStats(): Record<string, any> {
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

// 注册插件
const plugin = new WanouPlugin();
plugin.register();
