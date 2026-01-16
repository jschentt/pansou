import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import * as cheerio from 'cheerio';
import { SearchResult, Link } from '../../models/plugin-result';
import { PluginManager } from '../plugin.manager';

const pluginName = 'mizixing';
const defaultPriority = 3;

const baseURL = 'https://mizixing.com';
const searchEndpoint = baseURL + '/';
const searchLimit = 12;
const detailWorkers = 6;
const requestTimeout = 12000;
const detailTimeout = 10000;
const retryBaseDelay = 200;
const maxRequestRetries = 3;

const quarkLinkRegex = /https?:\/\/pan\.quark\.cn\/(?:s|g)\/[0-9A-Za-z]+/g;
const baiduLinkRegex = /https?:\/\/pan\.baidu\.com\/s\/[0-9A-Za-z\-_?=&]+/g;
const xunleiLinkRegex = /https?:\/\/pan\.xunlei\.com\/s\/[0-9A-Za-z\-_?=&]+/g;
const aliyunLinkRegex = /https?:\/\/(?:www\.)?(aliyundrive\.com|alipan\.com)\/s\/[0-9A-Za-z]+/g;
const ucLinkRegex = /https?:\/\/drive\.uc\.cn\/s\/[0-9A-Za-z]+/g;
const pan123LinkRegex = /https?:\/\/(?:www\.)?(123pan\.com|123pan\.cn|123684\.com|123685\.com|123912\.com|123592\.com)\/s\/[0-9A-Za-z]+/g;
const pikpakLinkRegex = /https?:\/\/(?:www\.)?mypikpak\.com\/s\/[0-9A-Za-z]+/g;
const mobileLinkRegex = /https?:\/\/caiyun\.139\.com\/[^\s<>'"]+/g;
const magnetLinkRegex = /magnet:\?xt=urn:btih:[0-9A-Fa-f]{40}/g;
const ed2kLinkRegex = /ed2k:\/\/[^\s<>'"]+/g;

const passwordRegex = /提取码[:：]?\s*([0-9A-Za-z]+)|密码[:：]?\s*([0-9A-Za-z]+)|pwd\s*[=:：]\s*([0-9A-Za-z]+)|code\s*[=:：]\s*([0-9A-Za-z]+)/g;
const textURLRegex = /https?:\/\/[^\s<>'"]+/g;

interface SearchItem {
  title: string;
  url: string;
  category: string;
  summary: string;
}

interface DetailData {
  links: Link[];
  datetime: Date;
  tags: string[];
  description: string;
}

export class MizixingPlugin {
  private client: AxiosInstance;

  constructor() {
    this.client = axios.create({
      timeout: requestTimeout,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Connection': 'keep-alive'
      }
    });
  }

  public async search(keyword: string, ext: Record<string, any>): Promise<SearchResult[]> {
    const searchKeyword = keyword.trim();
    if (!searchKeyword) {
      throw new Error(`[${pluginName}] 关键词不能为空`);
    }

    const items = await this.fetchSearchResults(searchKeyword);
    if (items.length === 0) {
      throw new Error(`[${pluginName}] 未找到相关资源`);
    }

    const results = await this.fetchDetails(items);
    if (results.length === 0) {
      throw new Error(`[${pluginName}] 未能抓取到有效网盘链接`);
    }

    return this.filterResultsByKeyword(results, searchKeyword);
  }

  private async fetchSearchResults(keyword: string): Promise<SearchItem[]> {
    const searchURL = `${searchEndpoint}?s=${encodeURIComponent(keyword)}`;

    try {
      const resp = await this.doRequestWithRetry({
        url: searchURL,
        method: 'GET',
        headers: {
          'Referer': baseURL
        },
        timeout: requestTimeout
      });

      const $ = cheerio.load(resp.data);
      const items: SearchItem[] = [];

      $('article.excerpt').each((_, s) => {
        if (items.length >= searchLimit) {
          return false;
        }

        const titleNode = $(s).find('h2 a');
        const urlStr = titleNode.attr('href');
        if (!urlStr || urlStr.trim() === '') {
          return;
        }

        const category = $(s).find('header .label').text().trim();
        const summary = $(s).find('p.note').text().trim();
        let title = titleNode.text().trim();

        if (!title) {
          title = $(s).find('h2').text().trim();
        }

        items.push({
          title,
          url: this.normalizeURL(urlStr),
          category,
          summary
        });
      });

      return items;
    } catch (error) {
      throw new Error(`[${pluginName}] 搜索请求失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async fetchDetails(items: SearchItem[]): Promise<SearchResult[]> {
    const semaphore = this.createSemaphore(detailWorkers);
    const results: SearchResult[] = [];

    const tasks = items.map(async (item) => {
      await semaphore.acquire();
      try {
        const detail = await this.fetchDetailData(item.url);
        if (detail.links.length === 0) {
          return;
        }

        let content = item.summary;
        if (!content) {
          content = detail.description;
        }

        const result: SearchResult = {
          uniqueId: this.buildUniqueID(item.url),
          title: item.title,
          content: content.trim(),
          links: detail.links,
          tags: this.mergeTags(item.category, detail.tags),
          channel: '',
          datetime: detail.datetime
        };

        results.push(result);
      } catch (error) {
        console.error(`[${pluginName}] 获取详情失败: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        semaphore.release();
      }
    });

    await Promise.all(tasks);
    return results;
  }

  private async fetchDetailData(detailURL: string): Promise<DetailData> {
    try {
      const resp = await this.doRequestWithRetry({
        url: detailURL,
        method: 'GET',
        headers: {
          'Referer': detailURL
        },
        timeout: detailTimeout
      });

      const $ = cheerio.load(resp.data);
      let content = $('article.article-content');
      if (content.length === 0) {
        content = $('.article-content');
      }
      if (content.length === 0) {
        content = $('.entry-content');
      }
      if (content.length === 0) {
        content = $('body');
      }

      content.find('script, style, .bdsharebuttonbox, #respond, .post-views, .share, .relates').remove();

      const links = this.extractLinksFromSelection(content);
      const description = $('meta[name="description"]').attr('content')?.trim() || '';
      const tags = this.collectTags($);
      const datetime = this.extractDateTime($);

      return {
        links,
        datetime,
        tags,
        description
      };
    } catch (error) {
      throw new Error(`[${pluginName}] 获取详情页失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private collectTags($: cheerio.CheerioAPI): string[] {
    const tagSet = new Set<string>();

    $('.breadcrumbs a').each((_, s) => {
      const text = $(s).text().trim();
      if (text && !text.includes('首页')) {
        tagSet.add(text);
      }
    });

    return Array.from(tagSet);
  }

  private extractDateTime($: cheerio.CheerioAPI): Date {
    const selectors = [
      'meta[property="article:modified_time"]',
      'meta[property="article:published_time"]',
      'meta[name="article:modified_time"]',
      'meta[name="article:published_time"]'
    ];

    for (const sel of selectors) {
      const node = $(sel);
      if (node.length > 0) {
        const value = node.attr('content')?.trim();
        if (value) {
          const date = this.parseDateTime(value);
          if (date) {
            return date;
          }
        }
      }
    }

    return new Date();
  }

  private parseDateTime(timeStr: string): Date | null {
    try {
      return new Date(timeStr);
    } catch {
      return null;
    }
  }

  private extractLinksFromSelection(sel: cheerio.Cheerio): Link[] {
    const results: Link[] = [];
    const seen = new Set<string>();

    sel.find('a[href]').each((_, node) => {
      const href = $(node).attr('href');
      if (!href) {
        return;
      }

      const [linkType, normalized] = this.classifyLink(href);
      if (!linkType || !normalized) {
        return;
      }
      if (seen.has(normalized)) {
        return;
      }

      const password = this.extractPassword($(node));
      results.push({
        type: linkType,
        url: normalized,
        password
      });
      seen.add(normalized);
    });

    const text = sel.text();
    let match;
    while ((match = textURLRegex.exec(text)) !== null) {
      const raw = match[0];
      const [linkType, normalized] = this.classifyLink(raw);
      if (!linkType) {
        continue;
      }
      if (seen.has(normalized)) {
        continue;
      }

      const start = Math.max(0, match.index - 80);
      const end = Math.min(text.length, match.index + match[0].length + 80);
      const context = text.substring(start, end);
      const password = this.matchPassword(context);

      results.push({
        type: linkType,
        url: normalized,
        password
      });
      seen.add(normalized);
    }

    return results;
  }

  private classifyLink(raw: string): [string, string] {
    raw = raw.trim();
    if (!raw) {
      return ['', ''];
    }

    if (quarkLinkRegex.test(raw)) {
      quarkLinkRegex.lastIndex = 0;
      const match = quarkLinkRegex.exec(raw);
      return match ? ['quark', match[0]] : ['', ''];
    }
    if (baiduLinkRegex.test(raw)) {
      baiduLinkRegex.lastIndex = 0;
      const match = baiduLinkRegex.exec(raw);
      return match ? ['baidu', match[0]] : ['', ''];
    }
    if (xunleiLinkRegex.test(raw)) {
      xunleiLinkRegex.lastIndex = 0;
      const match = xunleiLinkRegex.exec(raw);
      return match ? ['xunlei', match[0]] : ['', ''];
    }
    if (aliyunLinkRegex.test(raw)) {
      aliyunLinkRegex.lastIndex = 0;
      const match = aliyunLinkRegex.exec(raw);
      return match ? ['aliyun', match[0]] : ['', ''];
    }
    if (ucLinkRegex.test(raw)) {
      ucLinkRegex.lastIndex = 0;
      const match = ucLinkRegex.exec(raw);
      return match ? ['uc', match[0]] : ['', ''];
    }
    if (pan123LinkRegex.test(raw)) {
      pan123LinkRegex.lastIndex = 0;
      const match = pan123LinkRegex.exec(raw);
      return match ? ['123', match[0]] : ['', ''];
    }
    if (pikpakLinkRegex.test(raw)) {
      pikpakLinkRegex.lastIndex = 0;
      const match = pikpakLinkRegex.exec(raw);
      return match ? ['pikpak', match[0]] : ['', ''];
    }
    if (mobileLinkRegex.test(raw)) {
      mobileLinkRegex.lastIndex = 0;
      const match = mobileLinkRegex.exec(raw);
      return match ? ['mobile', match[0]] : ['', ''];
    }
    if (magnetLinkRegex.test(raw)) {
      magnetLinkRegex.lastIndex = 0;
      const match = magnetLinkRegex.exec(raw);
      return match ? ['magnet', match[0]] : ['', ''];
    }
    if (ed2kLinkRegex.test(raw)) {
      ed2kLinkRegex.lastIndex = 0;
      const match = ed2kLinkRegex.exec(raw);
      return match ? ['ed2k', match[0]] : ['', ''];
    }

    return ['', ''];
  }

  private extractPassword(node: cheerio.Cheerio): string {
    const candidates: string[] = [node.text()];

    const title = node.attr('title');
    if (title) {
      candidates.push(title);
    }
    const parent = node.parent();
    if (parent.length > 0) {
      candidates.push(parent.text());
      const next = parent.next();
      if (next.length > 0) {
        candidates.push(next.text());
      }
    }
    const sibling = node.next();
    if (sibling.length > 0) {
      candidates.push(sibling.text());
    }

    for (const text of candidates) {
      const pwd = this.matchPassword(text);
      if (pwd) {
        return pwd;
      }
    }

    return '';
  }

  private matchPassword(text: string): string {
    text = text.trim();
    if (!text) {
      return '';
    }

    passwordRegex.lastIndex = 0;
    const match = passwordRegex.exec(text);
    if (match) {
      for (let i = 1; i < match.length; i++) {
        if (match[i]) {
          return match[i].trim();
        }
      }
    }

    return '';
  }

  private async doRequestWithRetry(config: AxiosRequestConfig): Promise<any> {
    let lastError: any;

    for (let attempt = 0; attempt < maxRequestRetries; attempt++) {
      try {
        const resp = await this.client(config);
        if (resp.status === 200) {
          return resp;
        }
      } catch (error) {
        lastError = error;
      }

      if (attempt < maxRequestRetries - 1) {
        await new Promise(resolve => setTimeout(resolve, retryBaseDelay * Math.pow(2, attempt)));
      }
    }

    throw new Error(`重试 ${maxRequestRetries} 次后失败: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
  }

  private createSemaphore(maxConcurrency: number): { acquire: () => Promise<void>; release: () => void } {
    let count = 0;
    const queue: (() => void)[] = [];

    return {
      acquire: async () => {
        if (count < maxConcurrency) {
          count++;
        } else {
          await new Promise<void>(resolve => queue.push(resolve));
        }
      },
      release: () => {
        count--;
        if (queue.length > 0) {
          const resolve = queue.shift();
          resolve?.();
        }
      }
    };
  }

  private mergeTags(primary: string, extra: string[]): string[] {
    const tagSet = new Set<string>();
    if (primary) {
      tagSet.add(primary.trim());
    }
    for (const tag of extra) {
      if (tag) {
        tagSet.add(tag.trim());
      }
    }
    return Array.from(tagSet).filter(tag => tag);
  }

  private buildUniqueID(detailURL: string): string {
    const sum = this.crc32(detailURL);
    return `${pluginName}-${sum}`;
  }

  private crc32(str: string): number {
    const crcTable = [
      0x00000000, 0x77073096, 0xee0e612c, 0x990951ba, 0x076dc419, 0x706af48f, 0xe963a535, 0x9e6495a3,
      0x0edb8832, 0x79dcb8a4, 0xe0d5e91e, 0x97d2d988, 0x09b64c2b, 0x7eb17cbd, 0xe7b82d07, 0x90bf1d91,
      0x1db71064, 0x6ab020f2, 0xf3b97148, 0x84be41de, 0x1adad47d, 0x6ddde4eb, 0xf4d4b551, 0x83d385c7,
      0x136c9856, 0x646ba8c0, 0xfd62f97a, 0x8a65c9ec, 0x14015c4f, 0x63066cd9, 0xfa0f3d63, 0x8d080df5,
      0x3b6e20c8, 0x4c69105e, 0xd56041e4, 0xa2677172, 0x3c03e4d1, 0x4b04d447, 0xd20d85fd, 0xa50ab56b,
      0x35b5a8fa, 0x42b2986c, 0xdbbbc9d6, 0xacbcf940, 0x32d86ce3, 0x45df5c75, 0xdcd60dcf, 0xabd13d59,
      0x26d930ac, 0x51de003a, 0xc8d75180, 0xbfd06116, 0x21b4f4b5, 0x56b3c423, 0xcfba9599, 0xb8bda50f,
      0x2802b89e, 0x5f058808, 0xc60cd9b2, 0xb10be924, 0x2f6f7c87, 0x58684c11, 0xc1611dab, 0xb6662d3d,
      0x76dc4190, 0x01db7106, 0x98d220bc, 0xefd5102a, 0x71b18589, 0x06b6b51f, 0x9fbfe4a5, 0xe8b8d433,
      0x7807c9a2, 0x0f00f934, 0x9609a88e, 0xe10e9818, 0x7f6a0dbb, 0x086d3d2d, 0x91646c97, 0xe6635c01,
      0x6b6b51f4, 0x1c6c6162, 0x856530d8, 0xf262004e, 0x6c0695ed, 0x1b01a57b, 0x8208f4c1, 0xf50fc457,
      0x65b0d9c6, 0x12b7e950, 0x8bbeb8ea, 0xfcb9887c, 0x62dd1ddf, 0x15da2d49, 0x8cd37cf3, 0xfbd44c65,
      0x4db26158, 0x3ab551ce, 0xa3bc0074, 0xd4bb30e2, 0x4adfa541, 0x3dd895d7, 0xa4d1c46d, 0xd3d6f4fb,
      0x4369e96a, 0x346ed9fc, 0xad678846, 0xda60b8d0, 0x44042d73, 0x33031de5, 0xaa0a4c5f, 0xdd0d7cc9,
      0x5005713c, 0x270241aa, 0xbe0b1010, 0xc90c2086, 0x5768b525, 0x206f85b3, 0xb966d409, 0xce61e49f,
      0x5edef90e, 0x29d9c998, 0xb0d09822, 0xc7d7a8b4, 0x59b33d17, 0x2eb40d81, 0xb7bd5c3b, 0xc0ba6cad,
      0xedb88320, 0x9abfb3b6, 0x03b6e20c, 0x74b1d29a, 0xead54739, 0x9dd277af, 0x04db2615, 0x73dc1683,
      0xe3630b12, 0x94643b84, 0x0d6d6a3e, 0x7a6a5aa8, 0xe40ecf0b, 0x9309ff9d, 0x0a00ae27, 0x7d079eb1,
      0xf00f9344, 0x8708a3d2, 0x1e01f268, 0x6906c2fe, 0xf762575d, 0x806567cb, 0x196c3671, 0x6e6b06e7,
      0xfed41b76, 0x89d32be0, 0x10da7a5a, 0x67dd4acc, 0xf9b9df6f, 0x8ebeeff9, 0x17b7be43, 0x6669be79,
      0xcb61b38c, 0xbc66831a, 0x256fd2a0, 0x5268e236, 0xcc0c7795, 0xbb0b4703, 0x220216b9, 0x5505262f,
      0xc5ba3bbe, 0xb2bd0b28, 0x2bb45a92, 0x5cb36a04, 0xc2d7ffa7, 0xb5d0cf31, 0x2cd99e8b, 0x5bdeae1d,
      0x9b64c2b0, 0xec63f226, 0x756aa39c, 0x026d930a, 0x9c0906a9, 0xeb0e363f, 0x72076785, 0x05005713,
      0x95bf4a82, 0xe2b87a14, 0x7bb12bae, 0x0cb61b38, 0x92d28e9b, 0xe5d5be0d, 0x7cdcefb7, 0x0bdbdf21,
      0x86d3d2d4, 0xf1d4e242, 0x68ddb3f8, 0x1fda836e, 0x81be16cd, 0xf6b9265b, 0x6fb077e1, 0x18b74777,
      0x88085ae6, 0xff0f6a70, 0x66063bca, 0x11010b5c, 0x8f659eff, 0xf862ae69, 0x616bffd3, 0x166ccf45,
      0xa00ae278, 0xd70dd2ee, 0x4e048354, 0x3903b3c2, 0xa7672661, 0xd06016f7, 0x4969474d, 0x3e6e77db,
      0xaed16a4a, 0xd9d65adc, 0x40df0b66, 0x37d83bf0, 0xaf60efc3, 0xda67df55, 0x47b2cf7f, 0x30b5ffe9,
      0xbdbdf21c, 0xbc66831a, 0x256fd2a0, 0x5268e236, 0xbad03605, 0xcdd70693, 0x54de5729, 0x23d967bf,
      0xb3667a2e, 0xc4614ab8, 0x5d681b02, 0x2a6f2b94, 0xb40bbe37, 0xc30c8ea1, 0x5a05df1b, 0x2cd2ae8d
    ];

    let crc = 0 ^ (-1);
    for (let i = 0; i < str.length; i++) {
      crc = (crc >>> 8) ^ crcTable[(crc ^ str.charCodeAt(i)) & 0xff];
    }

    return (crc ^ (-1)) >>> 0;
  }

  private normalizeURL(raw: string): string {
    if (raw.startsWith('http')) {
      return raw;
    }
    return baseURL + raw.trim();
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

const plugin = new MizixingPlugin();
PluginManager.registerPlugin(pluginName, plugin, defaultPriority);
export default plugin;