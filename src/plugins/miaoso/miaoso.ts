import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import * as crypto from 'crypto';
import { SearchResult, Link } from '../../models/plugin-result';
import { PluginManager } from '../plugin.manager';

const BaseURL = 'https://miaosou.fun/api/secendsearch';
const MaxRetries = 3;
const TimeoutSeconds = 30;
const AESKey = '4OToScUFOaeVTrHE';
const AESIV = '9CLGao1vHKqm17Oz';

const userAgents = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/92.0.4515.107 Safari/537.36',
];

interface MiaosouResponse {
  code: number;
  msg: string;
  data: MiaosouData;
}

interface MiaosouData {
  total: number;
  list: MiaosouItem[];
}

interface MiaosouItem {
  id: string;
  name: string;
  url: string;
  type: string | null;
  from: string;
  content: string | null;
  gmtCreate: string;
  gmtShare: string;
  fileCount: number;
  creatorId: string | null;
  creatorName: string;
  fileInfos: MiaosouFileInfo[];
}

interface MiaosouFileInfo {
  category: string | null;
  fileExtension: string | null;
  fileId: string;
  fileName: string;
  type: string | null;
}

export class MiaosouPlugin {
  private client: AxiosInstance;

  constructor() {
    this.client = axios.create({
      timeout: TimeoutSeconds * 1000,
      headers: {
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Connection': 'keep-alive',
        'satoken': '503eb9c9-a07f-485c-a659-6c99facbb67f'
      }
    });
  }

  public async search(keyword: string, ext: Record<string, any>): Promise<SearchResult[]> {
    let searchKeyword = keyword;
    if (ext) {
      if (ext.title_en && typeof ext.title_en === 'string' && ext.title_en !== '') {
        searchKeyword = ext.title_en;
      }
    }

    const searchURL = `${BaseURL}?name=${encodeURIComponent(searchKeyword)}&pageNo=1`;

    try {
      const resp = await this.doRequestWithRetry({
        url: searchURL,
        method: 'GET',
        headers: {
          'User-Agent': userAgents[0],
          'Referer': `https://miaosou.fun/info?searchKey=${encodeURIComponent(searchKeyword)}`
        },
        timeout: TimeoutSeconds * 1000
      });

      const apiResp: MiaosouResponse = resp.data;
      if (apiResp.code !== 200) {
        throw new Error(`[miaoso] API错误: ${apiResp.msg}`);
      }

      const results = await Promise.all(
        apiResp.data.list.map(async (item) => {
          try {
            return await this.convertToSearchResult(item);
          } catch (error) {
            console.error(`[miaoso] 转换结果失败: ${error instanceof Error ? error.message : String(error)}`);
            return null;
          }
        })
      );

      return results.filter((result): result is SearchResult => {
        return result !== null && result.links.length > 0;
      });
    } catch (error) {
      throw new Error(`[miaoso] 搜索失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async doRequestWithRetry(config: AxiosRequestConfig): Promise<any> {
    let lastError: any;

    for (let i = 0; i < MaxRetries; i++) {
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

    throw new Error(`重试 ${MaxRetries} 次后仍然失败: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
  }

  private async convertToSearchResult(item: MiaosouItem): Promise<SearchResult> {
    const title = this.cleanHTMLTags(item.name);
    const content = item.content || '';

    let datetime = this.parseTime(item.gmtShare);
    if (!datetime) {
      datetime = new Date();
    }

    const links: Link[] = [];
    if (item.url) {
      const decryptedURL = this.decryptURL(item.url);
      if (decryptedURL) {
        const link: Link = {
          type: this.determineCloudType(item.from),
          url: decryptedURL,
          password: ''
        };
        links.push(link);
      }
    }

    const tags: string[] = [];
    if (item.from) {
      tags.push(item.from);
    }
    if (item.type) {
      tags.push(item.type);
    }

    return {
      uniqueId: `miaoso-${item.id}`,
      title,
      content,
      datetime,
      tags,
      links,
      channel: ''
    };
  }

  private cleanHTMLTags(text: string): string {
    return text.replace(/<[^>]*>/g, '').trim();
  }

  private decryptURL(encryptedURL: string): string {
    if (!encryptedURL) {
      return '';
    }

    try {
      const ciphertext = Buffer.from(encryptedURL, 'base64');
      const key = Buffer.from(AESKey, 'utf8');
      const iv = Buffer.from(AESIV, 'utf8');

      const cipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
      let decrypted = cipher.update(ciphertext);
      decrypted = Buffer.concat([decrypted, cipher.final()]);

      return this.removePKCS7Padding(decrypted).toString('utf8');
    } catch (error) {
      console.error(`[miaoso] 解密URL失败: ${error instanceof Error ? error.message : String(error)}`);
      return '';
    }
  }

  private removePKCS7Padding(data: Buffer): Buffer {
    if (data.length === 0) {
      return Buffer.alloc(0);
    }

    const padding = data[data.length - 1];
    if (padding > data.length || padding > 16) {
      return data;
    }

    for (let i = data.length - padding; i < data.length; i++) {
      if (data[i] !== padding) {
        return data;
      }
    }

    return data.slice(0, data.length - padding);
  }

  private determineCloudType(from: string): string {
    switch (from.toLowerCase()) {
      case 'quark':
        return 'quark';
      case 'baidu':
        return 'baidu';
      case 'uc':
        return 'uc';
      case 'ali':
        return 'aliyun';
      case 'xunlei':
        return 'xunlei';
      case 'tianyi':
        return 'tianyi';
      case '115':
        return '115';
      case '123':
        return '123';
      default:
        return 'others';
    }
  }

  private parseTime(timeStr: string): Date | null {
    try {
      return new Date(timeStr);
    } catch {
      return null;
    }
  }
}

const plugin = new MiaosouPlugin();
PluginManager.registerPlugin('miaoso', plugin, 3);
export default plugin;