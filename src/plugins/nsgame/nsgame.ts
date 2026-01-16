import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import crypto from 'crypto';
import { SearchResult, Link } from '../../models/plugin-result';
import { PluginManager } from '../plugin.manager';

const pluginName = 'nsgame';
const apiURL = 'https://nsthwj.com/thwj/game/query';
const defaultPriority = 2;
const defaultTimeout = 10000;
const pageSize = 1000;

const urlRegex = /https?:\/\/[^\s]+/;
const baiduLinkRegex = /https:\/\/pan\.baidu\.com\/s\/[^?\s]+/;
const baiduPwdRegex = /\?pwd=([a-zA-Z0-9]+)/;

interface NSGameItem {
  name: string;
  url: string;
  password: string;
}

interface NSGameResponse {
  success: boolean;
  data: {
    pageData: {
      totalCount: number;
      pageNum: number;
      data: NSGameItem[];
    };
    pageView: any;
  };
  code: string;
  message: any;
}

export class NSGameAsyncPlugin {
  private client: AxiosInstance;

  constructor() {
    this.client = axios.create({
      timeout: defaultTimeout,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Referer': 'https://nsthwj.com/'
      }
    });
  }

  public async search(keyword: string, ext: Record<string, any>): Promise<SearchResult[]> {
    try {
      const searchURL = `${apiURL}?pageNum=1&pageSize=${pageSize}&type=&queryName=${encodeURIComponent(keyword)}`;

      const resp = await this.doRequestWithRetry({
        url: searchURL,
        method: 'GET',
        timeout: defaultTimeout
      });

      const apiResp: NSGameResponse = resp.data;

      if (!apiResp.success || apiResp.code !== '200') {
        throw new Error(`API返回错误: success=${apiResp.success}, code=${apiResp.code}`);
      }

      const results: SearchResult[] = [];

      for (const item of apiResp.data.pageData.data) {
        const links = this.parseLinks(item.url);
        if (links.length === 0) {
          continue;
        }

        const uniqueID = this.generateUniqueID(item.name);

        let title = item.name;
        if (item.password) {
          const versionInfo = item.password.replace(/\n/g, ' ');
          title = `${item.name}（${versionInfo}）`;
        }

        const result: SearchResult = {
          uniqueId: uniqueID,
          title: title,
          content: item.password,
          links: links,
          tags: ['NS游戏', 'Switch'],
          channel: '',
          datetime: new Date(),
          images: []
        };

        results.push(result);
      }

      return this.filterResultsByKeyword(results, keyword);
    } catch (error) {
      console.error(`[nsgame] 搜索失败: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }

  private parseLinks(urlText: string): Link[] {
    const links: Link[] = [];
    const lines = urlText.split('\n');

    for (const line of lines) {
      const trimmedLine = line.trim();
      if (trimmedLine === '') {
        continue;
      }

      if (trimmedLine.includes('[夸克网盘]')) {
        const url = this.extractURL(trimmedLine);
        if (url && url.includes('pan.quark.cn')) {
          links.push({
            type: 'quark',
            url: url,
            password: ''
          });
        }
      } else if (trimmedLine.includes('[UC网盘]')) {
        const url = this.extractURL(trimmedLine);
        if (url && url.includes('drive.uc.cn')) {
          links.push({
            type: 'uc',
            url: url,
            password: ''
          });
        }
      } else if (trimmedLine.includes('pan.baidu.com')) {
        const { url, password } = this.extractBaiduLink(trimmedLine);
        if (url) {
          links.push({
            type: 'baidu',
            url: url,
            password: password
          });
        }
      }
    }

    return links;
  }

  private extractURL(text: string): string {
    const matches = text.match(urlRegex);
    return matches ? matches[0].trim() : '';
  }

  private extractBaiduLink(line: string): { url: string; password: string } {
    const fullURL = this.extractURL(line);
    if (!fullURL) {
      return { url: '', password: '' };
    }

    const linkMatches = fullURL.match(baiduLinkRegex);
    if (!linkMatches) {
      return { url: '', password: '' };
    }

    const url = linkMatches[0];
    let password = '';

    const pwdMatches = fullURL.match(baiduPwdRegex);
    if (pwdMatches && pwdMatches.length >= 2) {
      password = pwdMatches[1];
    }

    return { url, password };
  }

  private generateUniqueID(gameName: string): string {
    const hash = crypto.createHash('md5').update(gameName).digest('hex');
    return `${pluginName}-${hash}`.substring(0, 28);
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
        const resp = await this.client(config);
        if (resp.status === 200) {
          return resp;
        }
      } catch (error) {
        lastError = error;
      }
    }

    throw new Error(`重试 ${maxRetries} 次后仍然失败: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
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

const plugin = new NSGameAsyncPlugin();
PluginManager.registerPlugin('nsgame', plugin, 2);
export default plugin;