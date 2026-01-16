import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import * as cheerio from 'cheerio';
import { SearchResult, Link } from '../../models/plugin-result';
import { PluginManager } from '../plugin.manager';

const viewIDRegex = /\/view\/(\d+)/;
const magnetRegex = /magnet:\?xt=urn:btih:[a-zA-Z0-9]+[^\s'"<>]*/;

const DefaultTimeout = 10000;
const SiteURL = 'https://nyaa.si';

export class NyaaPlugin {
  private client: AxiosInstance;

  constructor() {
    this.client = axios.create({
      timeout: DefaultTimeout,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7',
        'Connection': 'keep-alive',
        'Referer': SiteURL
      }
    });
  }

  public async search(keyword: string, ext: Record<string, any>): Promise<SearchResult[]> {
    let searchKeyword = keyword;
    if (ext) {
      if (ext.title_en && typeof ext.title_en === 'string' && ext.title_en) {
        searchKeyword = ext.title_en;
      }
    }

    try {
      const searchURL = `${SiteURL}/?f=0&c=0_0&q=${encodeURIComponent(searchKeyword)}`;

      const resp = await this.doRequestWithRetry({
        url: searchURL,
        method: 'GET',
        timeout: DefaultTimeout
      });

      const $ = cheerio.load(resp.data);
      const results: SearchResult[] = [];

      const table = $('table.torrent-list tbody');
      if (table.length === 0) {
        return [];
      }

      table.find('tr').each((i, s) => {
        const result = this.parseSearchRow($(s));
        if (result.uniqueId) {
          results.push(result);
        }
      });

      return this.filterResultsByKeyword(results, searchKeyword);
    } catch (error) {
      console.error(`[nyaa] 搜索失败: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }

  private parseSearchRow(s: cheerio.Cheerio): SearchResult {
    const result: SearchResult = {
      uniqueId: '',
      title: '',
      content: '',
      links: [],
      tags: [],
      channel: '',
      datetime: new Date(),
      images: []
    };

    const categoryLink = s.find('td:nth-child(1) a');
    let category = '';
    if (categoryLink.length > 0) {
      category = categoryLink.attr('title') || '';
    }

    const titleLink = s.find('td[colspan="2"] a');
    if (titleLink.length === 0) {
      return result;
    }

    let title = titleLink.text().trim();
    if (!title) {
      title = titleLink.attr('title') || '';
    }

    const detailHref = titleLink.attr('href');
    if (!detailHref) {
      return result;
    }

    const matches = viewIDRegex.exec(detailHref);
    if (!matches || matches.length < 2) {
      return result;
    }

    const itemID = matches[1];
    result.uniqueId = `nyaa-${itemID}`;
    result.title = title;

    const magnetLink = s.find('td.text-center a[href^="magnet:"]');
    if (magnetLink.length > 0) {
      const magnetURL = magnetLink.attr('href');
      if (magnetURL) {
        result.links = [{
          type: 'magnet',
          url: magnetURL,
          password: ''
        }];
      }
    }

    if (result.links.length === 0) {
      return result;
    }

    const sizeTd = s.find('td.text-center').eq(1);
    const size = sizeTd.text().trim();

    const dateTd = s.find('td.text-center[data-timestamp]');
    let timestamp = 0;
    if (dateTd.length > 0) {
      const timestampStr = dateTd.attr('data-timestamp');
      if (timestampStr) {
        timestamp = parseInt(timestampStr, 10);
      }
    }

    if (timestamp > 0) {
      result.datetime = new Date(timestamp * 1000);
    }

    const tds = s.find('td.text-center');
    let seeders = '0';
    let leechers = '0';
    let downloads = '0';

    if (tds.length >= 6) {
      seeders = tds.eq(tds.length - 3).text().trim();
      leechers = tds.eq(tds.length - 2).text().trim();
      downloads = tds.eq(tds.length - 1).text().trim();
    }

    const contentParts: string[] = [];
    if (category) {
      contentParts.push(`分类: ${category}`);
    }
    if (size) {
      contentParts.push(`大小: ${size}`);
    }
    contentParts.push(`做种: ${seeders}`);
    contentParts.push(`下载: ${leechers}`);
    contentParts.push(`完成: ${downloads}`);

    result.content = contentParts.join(' | ');

    const tags: string[] = [];
    if (category) {
      tags.push(category);
    }
    tags.push(`做种:${seeders}`);
    tags.push(`下载:${leechers}`);
    tags.push(`完成:${downloads}`);
    result.tags = tags;

    return result;
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

const plugin = new NyaaPlugin();
PluginManager.registerPlugin('nyaa', plugin, 3);
export default plugin;