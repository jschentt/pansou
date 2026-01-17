import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios';
import * as cheerio from 'cheerio';
import { SearchResult, Link } from '../../models/plugin-result';
import { PluginManager } from '../../plugins/plugin.manager';
import { sleep } from '../../util/convert';

// 正则表达式定义
const topicIDRegex = /topicId=(\d+)/;
const yearRegex = /\(([0-9]{4})\)/;
const postTimeRegex = /发表时间：(.+)/;
const pwdParamRegex = /[?&]pwd=([0-9a-zA-Z]+)/;

const pwdPatterns = [
  /提取码[：:]\s*([0-9a-zA-Z]+)/,
  /密码[：:]\s*([0-9a-zA-Z]+)/,
  /pwd[=:：]\s*([0-9a-zA-Z]+)/
];

const netDiskPatterns = [
  // 百度网盘链接格式
  /https?:\/\/pan\.baidu\.com\/s\/[0-9a-zA-Z_\-]+(?:\?pwd=[0-9a-zA-Z]+)?/g,
  // 夸克网盘链接格式
  /https?:\/\/pan\.quark\.cn\/s\/[0-9a-zA-Z]+/g,
  // 阿里云盘链接格式
  /https?:\/\/www\.aliyundrive\.com\/s\/[0-9a-zA-Z]+/g,
  /https?:\/\/alipan\.com\/s\/[0-9a-zA-Z]+/g,
  // 迅雷网盘链接格式 - 修正以支持任意长度的提取码和特殊字符
  /https?:\/\/pan\.xunlei\.com\/s\/[0-9a-zA-Z_\-]+(?:\?pwd=[0-9a-zA-Z]+)?[#]?/g,
  // 天翼云盘链接格式
  /https?:\/\/cloud\.189\.cn\/t\/[0-9a-zA-Z]+/g,
  // 移动云盘链接格式
  /https?:\/\/caiyun\.139\.com\/m\/i\?[0-9a-zA-Z]+(?:\?pwd=[0-9a-zA-Z]+)?/g,
  /https?:\/\/www\.caiyun\.139\.com\/m\/i\?[0-9a-zA-Z]+(?:\?pwd=[0-9a-zA-Z]+)?/g,
  /https?:\/\/caiyun\.139\.com\/w\/i\?[0-9a-zA-Z]+(?:\?pwd=[0-9a-zA-Z]+)?/g,
  /https?:\/\/www\.caiyun\.139\.com\/w\/i\?[0-9a-zA-Z]+(?:\?pwd=[0-9a-zA-Z]+)?/g
];

const pwdKeywords = ['提取码', '密码', 'pwd', '验证码', '口令'];

const netDiskDomains = [
  'pan.baidu.com',
  'pan.quark.cn',
  'aliyundrive.com',
  'alipan.com',
  'pan.xunlei.com',
  'cloud.189.cn',
  'caiyun.139.com',
  'www.caiyun.139.com',
  'drive.uc.cn',
  '115.com',
  'mypikpak.com'
];

// 缓存类型定义
interface CacheMap<T> {
  [key: string]: { value: T; timestamp: number };
}

// 缓存实现
class Cache<T> {
  private map: CacheMap<T> = {};
  private ttl: number;

  constructor(ttl: number = 3600000) { // 默认1小时
    this.ttl = ttl;
  }

  get(key: string): T | undefined {
    const entry = this.map[key];
    if (!entry) return undefined;
    if (Date.now() - entry.timestamp > this.ttl) {
      delete this.map[key];
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: T): void {
    this.map[key] = { value, timestamp: Date.now() };
  }

  clear(): void {
    this.map = {};
  }
}

// 缓存实例
const isNetDiskLinkCache = new Cache<boolean>();
const determineLinkTypeCache = new Cache<string>();
const extractPasswordCache = new Cache<string>();
const topicIDCache = new Cache<string>();
const postTimeCache = new Cache<Date>();
const yearCache = new Cache<string>();
const linkExtractCache = new Cache<Link[]>();
const threadLinksCache = new Cache<Link[]>();

// 常量定义
const PLUGIN_NAME = 'panta';
const SEARCH_URL_TEMPLATE = 'https://www.91panta.cn/search?keyword=%s';
const THREAD_URL_TEMPLATE = 'https://www.91panta.cn/thread?topicId=%s';
const DEFAULT_PRIORITY = 1;
const DEFAULT_TIMEOUT = 6000;
const DEFAULT_CONCURRENCY = 30;
const MAX_RETRIES = 2;
const MIN_CONCURRENCY = 5;
const MAX_CONCURRENCY = 50;
const RESPONSE_TIME_THRESHOLD = 500;
const CONCURRENCY_STEP = 5;
const CONCURRENCY_ADJUST_INTERVAL = 30000;
const BACKOFF_BASE = 100;
const MAX_BACKOFF = 5000;

// 信号量实现
class Semaphore {
  private available: number;
  private queue: Array<() => void> = [];

  constructor(initial: number) {
    this.available = initial;
  }

  async acquire(): Promise<void> {
    if (this.available > 0) {
      this.available--;
      return;
    }

    return new Promise((resolve) => {
      this.queue.push(resolve);
    });
  }

  release(): void {
    this.available++;
    if (this.queue.length > 0) {
      const resolve = this.queue.shift();
      if (resolve) {
        resolve();
      }
    }
  }
}

// Panta插件类
export class PantaPlugin {
  private name: string;
  private priority: number;
  private maxConcurrency: number;
  private currentConcurrency: number;
  private responseTimes: number[];
  private responseTimesMutex: { lock: () => void; unlock: () => void };
  private lastAdjustTime: Date;
  private client: AxiosInstance;

  constructor() {
    this.name = PLUGIN_NAME;
    this.priority = DEFAULT_PRIORITY;
    this.maxConcurrency = DEFAULT_CONCURRENCY;
    this.currentConcurrency = DEFAULT_CONCURRENCY;
    this.responseTimes = [];
    this.responseTimesMutex = this.createMutex();
    this.lastAdjustTime = new Date();
    this.client = this.createHttpClient();

    // 启动缓存清理和并发调整
    this.startCacheCleaner();
    this.startConcurrencyAdjuster();
  }

  private createHttpClient(): AxiosInstance {
    return axios.create({
      timeout: DEFAULT_TIMEOUT,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
        'Cache-Control': 'max-age=0'
      }
    });
  }

  private createMutex() {
    let locked = false;
    const queue: Array<() => void> = [];

    return {
      lock: () => {
        return new Promise<void>((resolve) => {
          if (!locked) {
            locked = true;
            resolve();
          } else {
            queue.push(() => {
              locked = true;
              resolve();
            });
          }
        });
      },
      unlock: () => {
        locked = false;
        if (queue.length > 0) {
          const next = queue.shift();
          if (next) next();
        }
      }
    };
  }

  public getName(): string {
    return this.name;
  }

  public getPriority(): number {
    return this.priority;
  }

  // 启动定期清理缓存的定时器
  private startCacheCleaner(): void {
    setInterval(() => {
      isNetDiskLinkCache.clear();
      determineLinkTypeCache.clear();
      extractPasswordCache.clear();
      topicIDCache.clear();
      postTimeCache.clear();
      yearCache.clear();
      linkExtractCache.clear();
      threadLinksCache.clear();
    }, 3600000); // 每小时清理一次
  }

  // 启动定期调整并发数的定时器
  private startConcurrencyAdjuster(): void {
    setInterval(() => {
      this.adjustConcurrency();
    }, CONCURRENCY_ADJUST_INTERVAL);
  }

  // 根据响应时间调整并发数
  private adjustConcurrency(): void {
    if (this.responseTimes.length < 5) {
      return;
    }

    const totalTime = this.responseTimes.reduce((sum, time) => sum + time, 0);
    const avgTime = totalTime / this.responseTimes.length;

    if (avgTime > RESPONSE_TIME_THRESHOLD) {
      // 响应时间过长，减少并发数
      this.currentConcurrency = Math.max(this.currentConcurrency - CONCURRENCY_STEP, MIN_CONCURRENCY);
    } else {
      // 响应时间正常，尝试增加并发数
      this.currentConcurrency = Math.min(this.currentConcurrency + CONCURRENCY_STEP, MAX_CONCURRENCY);
    }

    // 清空响应时间样本
    this.responseTimes = [];
  }

  // 记录请求响应时间
  private recordResponseTime(duration: number): void {
    if (this.responseTimes.length >= 100) {
      this.responseTimes.shift();
    }
    this.responseTimes.push(duration);
  }

  // 发送HTTP请求，带重试机制
  private async doRequestWithRetry(config: AxiosRequestConfig): Promise<AxiosResponse> {
    let lastError: Error | undefined;

    for (let retry = 0; retry <= MAX_RETRIES; retry++) {
      if (retry > 0) {
        // 重试前等待一段时间，使用指数退避
        const backoffTime = Math.min(BACKOFF_BASE * Math.pow(2, retry - 1), MAX_BACKOFF);
        await sleep(backoffTime);
      }

      const startTime = Date.now();

      try {
        const resp = await this.client(config);
        const duration = Date.now() - startTime;
        this.recordResponseTime(duration);
        return resp;
      } catch (error) {
        lastError = error as Error;
        const duration = Date.now() - startTime;
        this.recordResponseTime(duration);
      }
    }

    throw lastError || new Error('请求失败，已达到最大重试次数');
  }

  // 执行搜索
  public async search(keyword: string, ext?: Record<string, any>): Promise<SearchResult[]> {
    // 对关键词进行URL编码
    const encodedKeyword = encodeURIComponent(keyword);
    const searchURL = SEARCH_URL_TEMPLATE.replace('%s', encodedKeyword);

    try {
      const resp = await this.doRequestWithRetry({
        method: 'GET',
        url: searchURL,
        headers: {
          Referer: 'https://www.91panta.cn/index'
        }
      });

      if (resp.status !== 200) {
        throw new Error(`请求PanTa搜索页面失败，状态码: ${resp.status}`);
      }

      const $ = cheerio.load(resp.data);
      const results = await this.parseSearchResults($);
      return this.filterResultsByKeyword(results, keyword);
    } catch (error) {
      console.error(`[Panta] 搜索失败: ${error}`);
      return [];
    }
  }

  // 解析搜索结果
  private async parseSearchResults($: cheerio.Root): Promise<SearchResult[]> {
    const results: SearchResult[] = [];
    const topicItems: cheerio.Cheerio = $('.topicItem');

    if (topicItems.length === 0) {
      return results;
    }

    const startTime = Date.now();
    const semaphore = new Semaphore(this.currentConcurrency);
    const promises: Promise<void>[] = [];

    topicItems.each((index, element) => {
      const promise = (async () => {
        await semaphore.acquire();
        try {
          const itemStartTime = Date.now();
          const result = await this.processTopicItem($, $(element));
          if (result) {
            results.push(result);
          }
          const itemProcessTime = Date.now() - itemStartTime;
          this.recordResponseTime(itemProcessTime);
        } finally {
          semaphore.release();
        }
      })();
      promises.push(promise);
    });

    await Promise.all(promises);

    const totalProcessTime = Date.now() - startTime;
    if (totalProcessTime > DEFAULT_TIMEOUT / 2) {
      // 如果处理时间过长，减少并发数
      this.currentConcurrency = Math.max(this.currentConcurrency - CONCURRENCY_STEP, MIN_CONCURRENCY);
    }

    return results;
  }

  // 处理单个话题项
  private async processTopicItem($: cheerio.Root, topicItem: cheerio.Cheerio): Promise<SearchResult | null> {
    const topicLink = topicItem.find('a[href^="thread?topicId="]');
    const href = topicLink.attr('href');
    if (!href) return null;

    // 提取topicId
    let topicID: string;
    const cachedID = topicIDCache.get(href);
    if (cachedID) {
      topicID = cachedID;
    } else {
      const match = href.match(topicIDRegex);
      if (!match || match.length < 2) return null;
      topicID = match[1];
      topicIDCache.set(href, topicID);
    }

    // 提取标题和摘要
    const title = topicLink.text().trim();
    const summary = topicItem.find('h2.summary').text().trim();

    // 提取发布时间
    let postTime: Date;
    const postTimeText = topicItem.find('span.postTime').text();
    const cachedTime = postTimeCache.get(postTimeText);
    if (cachedTime) {
      postTime = cachedTime;
    } else {
      const timeMatch = postTimeText.match(postTimeRegex);
      if (timeMatch && timeMatch.length >= 2) {
        const timeStr = timeMatch[1].trim();
        postTime = new Date(timeStr) || new Date();
      } else {
        postTime = new Date();
      }
      postTimeCache.set(postTimeText, postTime);
    }

    // 从标题中提取年份
    let yearFromTitle: string;
    const cachedYear = yearCache.get(title);
    if (cachedYear) {
      yearFromTitle = cachedYear;
    } else {
      const yearMatch = title.match(yearRegex);
      yearFromTitle = yearMatch ? yearMatch[1] : '';
      yearCache.set(title, yearFromTitle);
    }

    // 尝试从当前元素中提取链接
    let links = this.extractLinksFromElement(topicItem, yearFromTitle);

    // 如果没有找到链接，尝试获取帖子详情
    if (links.length === 0) {
      for (let retry = 0; retry <= MAX_RETRIES; retry++) {
        if (retry > 0) {
          const backoffTime = Math.min(BACKOFF_BASE * Math.pow(2, retry - 1), MAX_BACKOFF);
          await sleep(backoffTime);
        }

        try {
          const threadLinks = await this.fetchThreadLinks(topicID);
          if (threadLinks.length > 0) {
            links = threadLinks;
            break;
          }
        } catch (error) {
          console.error(`[Panta] 获取帖子详情失败 (${topicID}): ${error}`);
        }
      }
    }

    if (links.length === 0) {
      return null;
    }

    return {
      uniqueID: `panta-${topicID}`,
      datetime: postTime,
      title,
      content: summary,
      links,
      tags: ['panta'],
      plugin: this.name
    };
  }

  // 从元素中提取链接
  private extractLinksFromElement(element: cheerio.Cheerio, yearFromTitle: string): Link[] {
    const html = element.html() || '';
    const cacheKey = `${html}_${yearFromTitle}`;

    const cachedLinks = linkExtractCache.get(cacheKey);
    if (cachedLinks) {
      return cachedLinks;
    }

    const links: Link[] = [];
    const foundURLs: Set<string> = new Set();

    // 提取所有链接
    const allHrefs: string[] = [];
    const allTexts: string[] = [];

    element.find('a[href^="http"]').each((index, a) => {
      const href = $(a).attr('href');
      if (!href) return;

      // 快速过滤非网盘链接
      let isNetDisk = false;
      for (const domain of netDiskDomains) {
        if (href.toLowerCase().includes(domain)) {
          isNetDisk = true;
          break;
        }
      }

      if (isNetDisk) {
        allHrefs.push(href);
        let surroundingText = $(a).text().trim();
        if (!surroundingText) {
          surroundingText = $(a).parent().text().trim();
        }
        allTexts.push(surroundingText);
      }
    });

    // 处理所有链接
    for (let i = 0; i < allHrefs.length; i++) {
      const href = allHrefs[i];
      if (foundURLs.has(href)) continue;
      foundURLs.add(href);

      let surroundingText = allTexts[i];
      if (!surroundingText) {
        surroundingText = element.text().trim();
      }

      const linkType = this.determineLinkType(href);
      let password = this.extractPassword(surroundingText, href);

      // 根据链接类型进行特殊处理
      switch (linkType) {
        case 'quark':
          // 夸克网盘链接，只有在明确需要提取码的情况下才添加
          if (password) {
            let hasPasswordHint = false;
            for (const keyword of pwdKeywords) {
              if (surroundingText.includes(keyword)) {
                hasPasswordHint = true;
                break;
              }
            }
            if (!hasPasswordHint) {
              password = '';
            }
          }
          break;
        case 'mobile':
          // 移动云盘链接，只有在明确指定提取码的情况下才使用
          let hasExplicitPassword = false;
          for (const pattern of pwdPatterns) {
            const matches = pattern.exec(surroundingText);
            if (matches && matches.length >= 2) {
              password = matches[1];
              hasExplicitPassword = true;
              break;
            }
          }
          if (!hasExplicitPassword && !href.includes('pwd=')) {
            password = '';
          }
          break;
      }

      links.push({
        type: linkType,
        url: href,
        password
      });
    }

    linkExtractCache.set(cacheKey, links);
    return links;
  }

  // 获取帖子详情页中的链接
  private async fetchThreadLinks(topicID: string): Promise<Link[]> {
    const cachedLinks = threadLinksCache.get(topicID);
    if (cachedLinks) {
      return cachedLinks;
    }

    const threadURL = THREAD_URL_TEMPLATE.replace('%s', topicID);
    const links: Link[] = [];
    const foundURLs: Set<string> = new Set();

    try {
      const resp = await this.doRequestWithRetry({
        method: 'GET',
        url: threadURL,
        headers: {
          Referer: 'https://www.91panta.cn/index'
        }
      });

      if (resp.status !== 200) {
        throw new Error(`请求帖子详情页失败，状态码: ${resp.status}`);
      }

      const $ = cheerio.load(resp.data);
      const title = $('.title').text().trim();

      // 从标题中提取年份
      let yearFromTitle = '';
      const yearMatch = title.match(yearRegex);
      if (yearMatch && yearMatch.length >= 2) {
        yearFromTitle = yearMatch[1];
      }

      // 提取帖子内容区域
      $('.topicContent').each((index, content) => {
        // 提取所有链接
        $(content).find('a[href^="http"]').each((index, a) => {
          const href = $(a).attr('href');
          if (!href) return;

          if (this.isNetDiskLink(href)) {
            if (foundURLs.has(href)) return;
            foundURLs.add(href);

            let surroundingText = $(a).text().trim();
            if (!surroundingText) {
              surroundingText = $(a).parent().text().trim();
            }
            if (!surroundingText) {
              surroundingText = $(content).text().trim();
            }

            const linkType = this.determineLinkType(href);
            let password = this.extractPassword(surroundingText, href);

            // 根据链接类型进行特殊处理
            switch (linkType) {
              case 'quark':
                if (password) {
                  let hasPasswordHint = false;
                  for (const keyword of pwdKeywords) {
                    if (surroundingText.includes(keyword)) {
                      hasPasswordHint = true;
                      break;
                    }
                  }
                  if (!hasPasswordHint) {
                    password = '';
                  }
                }
                break;
              case 'mobile':
                let hasExplicitPassword = false;
                for (const pattern of pwdPatterns) {
                  const matches = pattern.exec(surroundingText);
                  if (matches && matches.length >= 2) {
                    password = matches[1];
                    hasExplicitPassword = true;
                    break;
                  }
                }
                if (!hasExplicitPassword && !href.includes('pwd=')) {
                  password = '';
                }
                break;
            }

            links.push({
              type: linkType,
              url: href,
              password
            });
          }
        });

        // 尝试从文本中提取可能的网盘链接
        const htmlContent = $(content).html() || '';
        const textLinks = this.extractTextLinks(htmlContent, yearFromTitle);
        for (const link of textLinks) {
          if (!foundURLs.has(link.url)) {
            foundURLs.add(link.url);
            links.push(link);
          }
        }
      });
    } catch (error) {
      console.error(`[Panta] 获取帖子详情失败 (${topicID}): ${error}`);
    }

    threadLinksCache.set(topicID, links);
    return links;
  }

  // 从文本中提取网盘链接
  private extractTextLinks(text: string, yearFromTitle: string): Link[] {
    const links: Link[] = [];

    // 预处理：检查文本是否包含网盘域名
    let hasNetDiskDomain = false;
    for (const domain of netDiskDomains) {
      if (text.includes(domain)) {
        hasNetDiskDomain = true;
        break;
      }
    }

    if (!hasNetDiskDomain) {
      return links;
    }

    // 检查是否包含提取码关键词
    let hasPasswordKeyword = false;
    for (const keyword of pwdKeywords) {
      if (text.includes(keyword)) {
        hasPasswordKeyword = true;
        break;
      }
    }

    // 提取所有网盘链接
    const foundLinks: { url: string; baseURL: string; position: number; endPos: number; linkType: string; password: string }[] = [];
    const foundPasswords: { password: string; position: number; endPos: number }[] = [];

    // 提取所有网盘链接
    for (const pattern of netDiskPatterns) {
      let match;
      while ((match = pattern.exec(text)) !== null) {
        const url = match[0];
        const position = match.index;
        const endPos = position + url.length;

        // 提取基本URL和提取码
        let baseURL = url;
        let password = '';

        const pwdMatch = pwdParamRegex.exec(url);
        if (pwdMatch && pwdMatch.length >= 2) {
          password = pwdMatch[1];
          // 移除URL中的密码参数
          if (url.includes('?pwd=')) {
            baseURL = url.substring(0, url.indexOf('?pwd='));
          } else if (url.includes('&pwd=')) {
            baseURL = url.substring(0, url.indexOf('&pwd='));
          }
        }

        // 移除URL末尾的特殊字符
        baseURL = baseURL.replace(/#$/, '');

        const linkType = this.determineLinkType(baseURL);

        foundLinks.push({
          url,
          baseURL,
          position,
          endPos,
          linkType,
          password
        });

        // 重置正则表达式的lastIndex
        pattern.lastIndex = endPos;
      }
    }

    // 提取所有提取码
    if (hasPasswordKeyword) {
      for (const pattern of pwdPatterns) {
        let match;
        while ((match = pattern.exec(text)) !== null) {
          const password = match[1];
          const position = match.index;
          const endPos = position + match[0].length;

          foundPasswords.push({
            password,
            position,
            endPos
          });

          // 重置正则表达式的lastIndex
          pattern.lastIndex = endPos;
        }
      }
    }

    if (foundLinks.length === 0) {
      return links;
    }

    // 按位置排序链接和提取码
    foundLinks.sort((a, b) => a.position - b.position);
    foundPasswords.sort((a, b) => a.position - b.position);

    // 处理链接与提取码的关联
    const processedLinks = new Set<string>();

    for (let i = 0; i < foundLinks.length; i++) {
      const link = foundLinks[i];
      if (processedLinks.has(link.baseURL)) continue;
      processedLinks.add(link.baseURL);

      // 如果链接已经有提取码，直接使用
      if (link.password) {
        links.push({
          type: link.linkType,
          url: link.url,
          password: link.password
        });
        continue;
      }

      let finalPassword = '';
      let finalURL = link.baseURL;

      // 查找合适的提取码
      for (const pwd of foundPasswords) {
        if (pwd.position > link.endPos) {
          // 检查这个提取码是否应该关联到当前链接
          let isRelevant = true;
          for (let j = i + 1; j < foundLinks.length; j++) {
            if (pwd.position > foundLinks[j].position) {
              isRelevant = false;
              break;
            }
          }

          if (isRelevant) {
            finalPassword = pwd.password;
            break;
          }
        }
      }

      // 特殊处理不同类型的网盘链接
      switch (link.linkType) {
        case 'mobile':
          // 移动云盘链接：不自动在URL中添加提取码
          if (link.url.includes('pwd=')) {
            finalURL = link.url;
          }
          break;
        case 'baidu':
        case 'xunlei':
          // 百度网盘和迅雷网盘：支持在URL中包含提取码
          if (finalPassword) {
            finalURL += finalURL.includes('?') ? `&pwd=${finalPassword}` : `?pwd=${finalPassword}`;
          }
          break;
      }

      links.push({
        type: link.linkType,
        url: finalURL,
        password: finalPassword
      });
    }

    return links;
  }

  // 从文本中提取密码
  private extractPassword(content: string, url: string): string {
    const key = `${content}_${url}`;
    const cachedPassword = extractPasswordCache.get(key);
    if (cachedPassword) {
      return cachedPassword;
    }

    // 如果URL已经包含密码参数，直接提取
    const pwdMatch = pwdParamRegex.exec(url);
    if (pwdMatch && pwdMatch.length >= 2) {
      extractPasswordCache.set(key, pwdMatch[1]);
      return pwdMatch[1];
    }

    // 检查是否包含提取码相关关键词
    let hasPasswordKeyword = false;
    for (const keyword of pwdKeywords) {
      if (content.includes(keyword)) {
        hasPasswordKeyword = true;
        break;
      }
    }

    if (!hasPasswordKeyword) {
      extractPasswordCache.set(key, '');
      return '';
    }

    // 尝试从文本中提取密码
    for (const pattern of pwdPatterns) {
      const matches = pattern.exec(content);
      if (matches && matches.length >= 2) {
        extractPasswordCache.set(key, matches[1]);
        return matches[1];
      }
    }

    extractPasswordCache.set(key, '');
    return '';
  }

  // 根据URL确定链接类型
  private determineLinkType(url: string): string {
    const cachedType = determineLinkTypeCache.get(url);
    if (cachedType) {
      return cachedType;
    }

    const lowerURL = url.toLowerCase();
    let linkType = 'others';

    switch (true) {
      case lowerURL.includes('pan.baidu.com'):
        linkType = 'baidu';
        break;
      case lowerURL.includes('pan.quark.cn'):
        linkType = 'quark';
        break;
      case lowerURL.includes('alipan.com') || lowerURL.includes('aliyundrive.com'):
        linkType = 'aliyun';
        break;
      case lowerURL.includes('cloud.189.cn'):
        linkType = 'tianyi';
        break;
      case lowerURL.includes('caiyun.139.com'):
        linkType = 'mobile';
        break;
      case lowerURL.includes('115.com'):
        linkType = '115';
        break;
      case lowerURL.includes('pan.xunlei.com'):
        linkType = 'xunlei';
        break;
      case lowerURL.includes('mypikpak.com'):
        linkType = 'pikpak';
        break;
      case lowerURL.includes('123'):
        linkType = '123';
        break;
    }

    determineLinkTypeCache.set(url, linkType);
    return linkType;
  }

  // 检查链接是否为网盘链接
  private isNetDiskLink(url: string): boolean {
    const cachedResult = isNetDiskLinkCache.get(url);
    if (cachedResult !== undefined) {
      return cachedResult;
    }

    const lowerURL = url.toLowerCase();
    let isNetDisk = false;

    for (const domain of netDiskDomains) {
      if (lowerURL.includes(domain)) {
        isNetDisk = true;
        break;
      }
    }

    isNetDiskLinkCache.set(url, isNetDisk);
    return isNetDisk;
  }

  // 过滤结果
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

// 注册插件
PluginManager.register(new PantaPlugin());
