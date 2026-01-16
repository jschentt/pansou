import { SearchResult, Link, PluginSearchResult } from '../../models/plugin-result';
import { BaseAsyncPlugin } from '../plugin.manager';
import axios, { AxiosInstance, AxiosResponse } from 'axios';
import * as cheerio from 'cheerio';

// 常量定义
const pluginName = 'yiove';
const defaultPriority = 3;
const baseURL = 'https://bbs.yiove.com';
const searchPathFormat = baseURL + '/search-%s-1.htm';
const requestTimeout = 12000; // 12秒
const detailTimeout = 12000; // 12秒
const retryBaseDelay = 200; // 200毫秒
const maxRequestRetries = 3;
const searchResultLimit = 12;
const detailLinkLimit = 6;
const detailWorkerCount = 6;

// 链接模式
const linkPatterns = [
  { reg: /https?:\/\/pan\.quark\.cn\/(?:s|g)\/[0-9A-Za-z]+/, typ: 'quark' },
  { reg: /https?:\/\/pan\.baidu\.com\/s\/[0-9A-Za-z\-_?=&]+/, typ: 'baidu' },
  { reg: /https?:\/\/pan\.xunlei\.com\/s\/[0-9A-Za-z\-_?=&]+/, typ: 'xunlei' },
  { reg: /https?:\/\/(?:www\.)?(aliyundrive\.com|alipan\.com)\/s\/[0-9A-Za-z]+/, typ: 'aliyun' },
  { reg: /https?:\/\/drive\.uc\.cn\/s\/[0-9A-Za-z]+/, typ: 'uc' },
  { reg: /https?:\/\/(?:www\.)?(123pan\.com|123pan\.cn|123684\.com|123685\.com|123912\.com|123592\.com)\/s\/[0-9A-Za-z]+/, typ: '123' },
  { reg: /https?:\/\/(?:www\.)?mypikpak\.com\/s\/[0-9A-Za-z]+/, typ: 'pikpak' },
  { reg: /https?:\/\/caiyun\.139\.com\/[^\s<>'"]+/, typ: 'mobile' },
  { reg: /https?:\/\/tianyi\.cloud\/[^\s<>'"]+/, typ: 'tianyi' },
  { reg: /magnet:\?xt=urn:btih:[0-9A-Za-z]+/, typ: 'magnet' },
  { reg: /ed2k:\/\/[^\s<>'"]+/, typ: 'ed2k' },
];

// 密码模式
const passwordPatterns = [
  /提取码[:：]?\s*([0-9A-Za-z]+)/,
  /密码[:：]?\s*([0-9A-Za-z]+)/,
  /pwd\s*[=:：]\s*([0-9A-Za-z]+)/,
  /code\s*[=:：]\s*([0-9A-Za-z]+)/,
];

// 正则表达式
const textURLRegex = /https?:\/\/[^\s<>'"]+/;
const threadIDRegex = /thread-(\d+)/;

class YiovePlugin extends BaseAsyncPlugin {
  private client: AxiosInstance;

  constructor() {
    super(pluginName, defaultPriority);
    this.client = this.createHttpClient();
  }

  public async Search(keyword: string, ext: Record<string, any>): Promise<SearchResult[]> {
    const result = await this.SearchWithResult(keyword, ext);
    return result.Results;
  }

  public async SearchWithResult(keyword: string, ext: Record<string, any>): Promise<PluginSearchResult> {
    return this.AsyncSearchWithResult(keyword, this.searchImpl.bind(this), this.MainCacheKey, ext);
  }

  private createHttpClient(): AxiosInstance {
    return axios.create({
      timeout: requestTimeout,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Connection': 'keep-alive',
      },
    });
  }

  private async searchImpl(client: AxiosInstance, keyword: string, ext: Record<string, any>): Promise<SearchResult[]> {
    if (this.client) {
      client = this.client;
    }

    const debug = this.getDebugMode(ext);
    const searchKeyword = keyword.trim();

    if (searchKeyword === '') {
      throw new Error(`[${this.Name()}] 关键词不能为空`);
    }

    this.logDebug(debug, `[${this.Name()}] 开始搜索，关键词=${searchKeyword}`);

    const threads = await this.fetchSearchResults(client, searchKeyword, debug);
    this.logDebug(debug, `[${this.Name()}] 搜索结果数量=${threads.length}`);

    if (threads.length === 0) {
      this.logDebug(debug, `[${this.Name()}] 搜索结果为空`);
      throw new Error(`[${this.Name()}] 未找到相关结果`);
    }

    const results: SearchResult[] = [];
    const semaphore = new Semaphore(detailWorkerCount);
    const promises: Promise<void>[] = [];

    for (const thread of threads) {
      promises.push((async () => {
        await semaphore.acquire();
        try {
          this.logDebug(debug, `[${this.Name()}] 准备抓取详情 title=${thread.Title} url=${thread.URL}`);

          const detail = await this.fetchDetail(client, thread.URL, debug);
          if (detail.links.length === 0) {
            this.logDebug(debug, `[${this.Name()}] 详情页无链接 URL=${thread.URL}`);
            return;
          }

          const linksWithTitle = this.applyWorkTitle(detail.links, thread.Title);

          const result: SearchResult = {
            UniqueID: this.buildUniqueID(thread.URL),
            Title: thread.Title,
            Content: detail.description,
            Links: this.limitLinks(linksWithTitle, detailLinkLimit),
            Tags: this.mergeTags(thread.Tags, detail.tags),
            Channel: '',
            Datetime: detail.datetime,
          };

          results.push(result);
          this.logDebug(debug, `[${this.Name()}] 详情抓取成功 URL=${thread.URL} 链接数=${result.Links.length}`);
        } catch (error) {
          this.logDebug(debug, `[${this.Name()}] 详情页抓取失败 URL=${thread.URL} err=${error}`);
        } finally {
          semaphore.release();
        }
      })());
    }

    await Promise.all(promises);

    if (results.length === 0) {
      this.logDebug(debug, `[${this.Name()}] 所有线程抓取完成但无有效链接`);
      throw new Error(`[${this.Name()}] 未能抓取到有效网盘链接`);
    }

    const filtered = this.FilterResultsByKeyword(results, searchKeyword);
    this.logDebug(debug, `[${this.Name()}] 过滤后结果数=${filtered.length}`);

    if (debug) {
      for (let idx = 0; idx < filtered.length; idx++) {
        const res = filtered[idx];
        const linkSummaries = res.Links.map(link => `${link.Type}(${link.URL})`);
        this.logDebug(
          debug,
          `[${this.Name()}] Result#${idx} | UID=${res.UniqueID} | Title=${res.Title} | Links=${res.Links.length} | LinkDetail=${linkSummaries}`
        );
      }
    }

    return filtered;
  }

  private getDebugMode(ext: Record<string, any>): boolean {
    if (!ext) return false;
    
    const debugValue = ext['debug'];
    if (typeof debugValue === 'boolean') {
      return debugValue;
    } else if (typeof debugValue === 'string') {
      return debugValue.toLowerCase() === 'true';
    }
    return false;
  }

  private async fetchSearchResults(client: AxiosInstance, keyword: string, debug: boolean): Promise<{ Title: string; URL: string; Tags: string[] }[]> {
    const searchURL = searchPathFormat.replace('%s', this.encodeKeyword(keyword));
    this.logDebug(debug, `[${this.Name()}] 搜索URL=${searchURL}`);

    const resp = await this.doRequestWithRetry(client, searchURL, maxRequestRetries);

    if (resp.status !== 200) {
      this.logDebug(debug, `[${this.Name()}] 搜索返回非200: ${resp.status}`);
      throw new Error(`[${this.Name()}] 搜索返回状态码: ${resp.status}`);
    }

    this.logDebug(debug, `[${this.Name()}] 搜索响应状态: ${resp.status}`);

    const $ = cheerio.load(resp.data);
    const threads: { Title: string; URL: string; Tags: string[] }[] = [];

    $('ul.threadlist li.thread').each((_i, li) => {
      if (threads.length >= searchResultLimit) {
        return;
      }

      const subject = $(li).find('.subject a').first();
      const href = subject.attr('href');
      if (!href || href.trim() === '') {
        return;
      }

      const title = subject.text().trim();
      if (title === '') {
        return;
      }

      const tags: string[] = [];
      $(li).find('.subject a.badge').each((_j, node) => {
        const tag = $(node).text().trim();
        if (tag !== '') {
          tags.push(tag);
        }
      });

      const threadURL = this.toAbsoluteURL(href);
      if (threadURL === '') {
        return;
      }

      threads.push({ Title: title, URL: threadURL, Tags: tags });
      this.logDebug(debug, `[${this.Name()}] 解析到线程：title=${title} url=${threadURL}`);
    });

    this.logDebug(debug, `[${this.Name()}] 解析到线程数量=${threads.length}`);
    return threads;
  }

  private async fetchDetail(client: AxiosInstance, detailURL: string, debug: boolean): Promise<{ links: Link[]; tags: string[]; description: string; datetime: Date }> {
    this.logDebug(debug, `[${this.Name()}] 抓取详情 URL=${detailURL}`);

    const resp = await this.doRequestWithRetry(client, detailURL, maxRequestRetries);

    if (resp.status !== 200) {
      this.logDebug(debug, `[${this.Name()}] 详情返回非200: ${resp.status}`);
      throw new Error(`[${this.Name()}] 详情页返回状态码: ${resp.status}`);
    }

    const $ = cheerio.load(resp.data);
    let content = $('div.message[isfirst="1"]');
    if (content.length === 0) {
      content = $('.message').first();
    }
    if (content.length === 0) {
      content = $.root();
    }

    content.find('script, style').remove();

    const links = this.extractLinks(content);
    let description = $('meta[name="description"]').attr('content')?.trim() || '';
    if (description === '') {
      description = this.truncateText(content.text(), 200);
    }

    this.logDebug(debug, `[${this.Name()}] 详情解析完成 URL=${detailURL} 链接数=${links.length}`);

    return {
      links,
      tags: this.collectTags($),
      description,
      datetime: this.extractDatetime($),
    };
  }

  private logDebug(enabled: boolean, message: string): void {
    if (enabled) {
      console.log(message);
    }
  }

  private collectTags($: cheerio.Root): string[] {
    const tagSet = new Set<string>();

    $('.breadcrumb a, ol.breadcrumb a').each((_i, node) => {
      const text = $(node).text().trim();
      if (text === '' || text.includes('首页')) {
        return;
      }
      tagSet.add(text);
    });

    $('h4 a.badge').each((_i, node) => {
      const text = $(node).text().trim();
      if (text !== '') {
        tagSet.add(text);
      }
    });

    return Array.from(tagSet);
  }

  private extractDatetime($: cheerio.Root): Date {
    const dateText = $('.card-thread .date').first().text().trim();
    if (dateText === '') {
      return new Date();
    }

    const formats = [
      'YYYY-MM-DD HH:mm',
      'YYYY/MM/DD HH:mm',
      'YYYY-MM-DD',
      'YYYY/MM/DD',
    ];

    for (const format of formats) {
      const date = this.parseDate(dateText, format);
      if (date.getTime() > 0) {
        return date;
      }
    }

    return new Date();
  }

  private parseDate(dateString: string, format: string): Date {
    if (format === 'YYYY-MM-DD HH:mm') {
      const parts = dateString.split(' ');
      if (parts.length === 2) {
        const dateParts = parts[0].split('-');
        const timeParts = parts[1].split(':');
        if (dateParts.length === 3 && timeParts.length === 2) {
          const year = parseInt(dateParts[0]);
          const month = parseInt(dateParts[1]) - 1;
          const day = parseInt(dateParts[2]);
          const hour = parseInt(timeParts[0]);
          const minute = parseInt(timeParts[1]);
          return new Date(year, month, day, hour, minute);
        }
      }
    } else if (format === 'YYYY/MM/DD HH:mm') {
      const parts = dateString.split(' ');
      if (parts.length === 2) {
        const dateParts = parts[0].split('/');
        const timeParts = parts[1].split(':');
        if (dateParts.length === 3 && timeParts.length === 2) {
          const year = parseInt(dateParts[0]);
          const month = parseInt(dateParts[1]) - 1;
          const day = parseInt(dateParts[2]);
          const hour = parseInt(timeParts[0]);
          const minute = parseInt(timeParts[1]);
          return new Date(year, month, day, hour, minute);
        }
      }
    } else if (format === 'YYYY-MM-DD') {
      const parts = dateString.split('-');
      if (parts.length === 3) {
        const year = parseInt(parts[0]);
        const month = parseInt(parts[1]) - 1;
        const day = parseInt(parts[2]);
        return new Date(year, month, day);
      }
    } else if (format === 'YYYY/MM/DD') {
      const parts = dateString.split('/');
      if (parts.length === 3) {
        const year = parseInt(parts[0]);
        const month = parseInt(parts[1]) - 1;
        const day = parseInt(parts[2]);
        return new Date(year, month, day);
      }
    }
    return new Date(0);
  }

  private extractLinks(selection: cheerio.Cheerio): Link[] {
    const results: Link[] = [];
    const seen = new Set<string>();

    selection.find('a[href]').each((_i, node) => {
      const href = $(node).attr('href');
      if (!href) {
        return;
      }

      const [linkType, normalized] = this.classifyLink(href);
      if (linkType === '' || normalized === '') {
        return;
      }
      if (seen.has(normalized)) {
        return;
      }

      const password = this.extractPassword($(node));
      results.push({
        Type: linkType,
        URL: normalized,
        Password: password,
      });
      seen.add(normalized);
    });

    const text = selection.text();
    let match;
    const regex = new RegExp(textURLRegex.source, 'g');

    while ((match = regex.exec(text)) !== null) {
      const raw = match[0];
      const [linkType, normalized] = this.classifyLink(raw);
      if (linkType === '') {
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
        Type: linkType,
        URL: normalized,
        Password: password,
      });
      seen.add(normalized);
    }

    return results;
  }

  private classifyLink(raw: string): [string, string] {
    const trimmed = raw.trim();
    if (trimmed === '') {
      return ['', ''];
    }

    for (const pattern of linkPatterns) {
      const match = pattern.reg.exec(trimmed);
      if (match) {
        return [pattern.typ, match[0]];
      }
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
      const sibling = parent.next();
      if (sibling.length > 0) {
        candidates.push(sibling.text());
      }
    }

    const next = node.next();
    if (next.length > 0) {
      candidates.push(next.text());
    }

    for (const text of candidates) {
      const pwd = this.matchPassword(text);
      if (pwd !== '') {
        return pwd;
      }
    }

    return '';
  }

  private matchPassword(text: string): string {
    const trimmed = text.trim();
    if (trimmed === '') {
      return '';
    }

    for (const pattern of passwordPatterns) {
      const matches = pattern.exec(trimmed);
      if (matches && matches.length > 1) {
        return matches[1].trim();
      }
    }

    return '';
  }

  private limitLinks(links: Link[], limit: number): Link[] {
    if (limit <= 0 || links.length <= limit) {
      return links;
    }
    return links.slice(0, limit);
  }

  private applyWorkTitle(links: Link[], title: string): Link[] {
    if (title === '' || links.length === 0) {
      return links;
    }
    return links.map(link => ({
      ...link,
      WorkTitle: title,
    }));
  }

  private mergeTags(a: string[], b: string[]): string[] {
    const tagSet = new Set<string>();

    for (const tag of a) {
      const trimmed = tag.trim();
      if (trimmed !== '') {
        tagSet.add(trimmed);
      }
    }

    for (const tag of b) {
      const trimmed = tag.trim();
      if (trimmed !== '') {
        tagSet.add(trimmed);
      }
    }

    return Array.from(tagSet);
  }

  private encodeKeyword(keyword: string): string {
    const trimmed = keyword.trim();
    if (trimmed === '') {
      return '';
    }

    let result = '';
    for (const char of trimmed) {
      result += '_' + char.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0');
    }

    return result;
  }

  private toAbsoluteURL(href: string): string {
    const trimmed = href.trim();
    if (trimmed === '') {
      return '';
    }

    if (trimmed.startsWith('http')) {
      return trimmed;
    }

    if (trimmed.startsWith('//')) {
      return 'https:' + trimmed;
    }

    return `${baseURL}/${trimmed.replace(/^[\/\.]/, '')}`;
  }

  private truncateText(text: string, limit: number): string {
    const trimmed = text.trim();
    const runes = [...trimmed];
    if (runes.length <= limit) {
      return trimmed;
    }
    return runes.slice(0, limit).join('');
  }

  private buildUniqueID(detailURL: string): string {
    const matches = threadIDRegex.exec(detailURL);
    if (matches && matches.length > 1) {
      return `${pluginName}-${matches[1]}`;
    }

    const sum = this.crc32(detailURL);
    return `${pluginName}-${sum}`;
  }

  private crc32(str: string): number {
    const crcTable = this.createCRCTable();
    let crc = 0 ^ (-1);

    for (let i = 0; i < str.length; i++) {
      const byte = str.charCodeAt(i);
      crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xFF];
    }

    return (crc ^ (-1)) >>> 0;
  }

  private createCRCTable(): number[] {
    const table: number[] = [];
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let j = 0; j < 8; j++) {
        c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      }
      table[i] = c;
    }
    return table;
  }

  private async doRequestWithRetry(client: AxiosInstance, url: string, maxRetries: number): Promise<AxiosResponse> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const resp = await client.get(url, {
          headers: {
            'Referer': baseURL,
          },
        });

        if (resp.status === 200) {
          return resp;
        }
      } catch (error) {
        lastError = error as Error;
      }

      if (attempt < maxRetries - 1) {
        const backoff = retryBaseDelay * Math.pow(2, attempt);
        await new Promise(resolve => setTimeout(resolve, backoff));
      }
    }

    throw new Error(`重试 ${maxRetries} 次后失败: ${lastError?.message}`);
  }
}

// 信号量实现，用于限制并发数
class Semaphore {
  private maxConcurrency: number;
  private current: number;
  private queue: (() => void)[];

  constructor(maxConcurrency: number) {
    this.maxConcurrency = maxConcurrency;
    this.current = 0;
    this.queue = [];
  }

  async acquire(): Promise<void> {
    if (this.current < this.maxConcurrency) {
      this.current++;
      return;
    }

    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
  }

  release(): void {
    if (this.queue.length > 0) {
      const resolve = this.queue.shift()!;
      resolve();
    } else {
      this.current--;
    }
  }
}

// 注册插件
BaseAsyncPlugin.RegisterGlobalPlugin(new YiovePlugin());
