import { SearchResult, Link, PluginSearchResult } from '../../models/plugin-result';
import { BaseAsyncPlugin } from '../plugin.manager';
import axios, { AxiosInstance, AxiosResponse } from 'axios';
import * as cheerio from 'cheerio';

// 常量定义
const SearchURL = 'https://xuexizhinan.com/?post_type=book&s=%s';
const DetailURLPattern = /https:\/\/xuexizhinan\.com\/book\/(\d+)\.html/;
const DefaultTimeout = 10000; // 默认超时时间（毫秒）
const MaxConcurrency = 8; // 并发数限制
const CacheTTL = 24 * 60 * 60 * 1000; // 缓存有效期（毫秒）

// 预编译正则表达式
const detailURLRegex = DetailURLPattern;
const magnetLinkRegex = /magnet:\?xt=urn:btih:[0-9a-zA-Z]+/;
const dateRegex = /上映日期: (\d{4}-\d{2}-\d{2})/;

// 缓存的详情页响应
interface DetailPageResponse {
  Title: string;
  ImageURL: string;
  MagnetLinks: string[];
  QuarkLinks: Link[];
  Tags: string[];
  Content: string;
  Timestamp: Date;
}

// 缓存管理类
class DetailPageCache {
  private cache: Map<string, DetailPageResponse>;
  private lastCleanTime: Date;

  constructor() {
    this.cache = new Map<string, DetailPageResponse>();
    this.lastCleanTime = new Date();
    this.startCacheCleaner();
  }

  public get(key: string): DetailPageResponse | undefined {
    const cached = this.cache.get(key);
    if (cached) {
      // 检查缓存是否过期
      if (Date.now() - cached.Timestamp.getTime() < CacheTTL) {
        return cached;
      }
      // 缓存过期，删除
      this.cache.delete(key);
    }
    return undefined;
  }

  public set(key: string, value: DetailPageResponse): void {
    this.cache.set(key, value);
  }

  public clear(): void {
    this.cache.clear();
    this.lastCleanTime = new Date();
  }

  private startCacheCleaner(): void {
    setInterval(() => {
      this.clear();
    }, 6 * 60 * 60 * 1000); // 每6小时清理一次缓存
  }
}

// 全局缓存实例
const detailPageCache = new DetailPageCache();

class XuexizhinanPlugin extends BaseAsyncPlugin {
  constructor() {
    super('xuexizhinan', 1); // 高优先级
  }

  public async Search(keyword: string, ext: Record<string, any>): Promise<SearchResult[]> {
    const result = await this.SearchWithResult(keyword, ext);
    return result.Results;
  }

  public async SearchWithResult(keyword: string, ext: Record<string, any>): Promise<PluginSearchResult> {
    return this.AsyncSearchWithResult(keyword, this.doSearch.bind(this), this.MainCacheKey, ext);
  }

  private async doSearch(client: AxiosInstance, keyword: string, ext: Record<string, any>): Promise<SearchResult[]> {
    // 构建搜索URL
    const searchURL = SearchURL.replace('%s', encodeURIComponent(keyword));

    // 发送请求
    try {
      const resp = await client.get(searchURL, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/100.0.4896.127 Safari/537.36',
        },
        timeout: DefaultTimeout,
      });

      if (resp.status !== 200) {
        throw new Error(`请求返回状态码: ${resp.status}`);
      }

      // 解析HTML
      const $ = cheerio.load(resp.data);

      // 存储符合条件的搜索项
      interface SearchItem {
        url: string;
        title: string;
      }

      // 将关键词转为小写，用于不区分大小写的比较
      const lowerKeywords = keyword.toLowerCase();
      // 将关键词按空格分割，用于支持多关键词搜索
      const keywords = lowerKeywords.split(/\s+/).filter(kw => kw !== '');

      // 存储符合条件的搜索项
      const validItems: SearchItem[] = [];

      // 使用更高效的选择器直接获取所有链接和标题
      $('.url-card').each((i, s) => {
        // 提取标题和链接
        const titleElem = $(s).find('.list-title');
        const title = titleElem.text().trim();
        const link = titleElem.attr('href');

        if (!link || link === '' || title === '') {
          return;
        }

        // 标题转小写，用于不区分大小写的比较
        const lowerTitle = title.toLowerCase();

        // 检查标题是否包含所有关键词
        let matched = true;
        for (const kw of keywords) {
          if (!lowerTitle.includes(kw)) {
            matched = false;
            break;
          }
        }

        // 如果标题包含所有关键词，则添加到有效项中
        if (matched) {
          validItems.push({ url: link, title });
        }
      });

      // 如果没有搜索结果，返回空结果
      if (validItems.length === 0) {
        return [];
      }

      // 创建信号量控制并发
      const semaphore = new Semaphore(MaxConcurrency);
      const promises: Promise<SearchResult | null>[] = [];

      // 获取详情页信息
      for (const item of validItems) {
        promises.push((async () => {
          await semaphore.acquire();
          try {
            return await this.processDetailPage(client, item.url);
          } finally {
            semaphore.release();
          }
        })());
      }

      // 等待所有请求完成
      const results = await Promise.all(promises);

      // 过滤掉null结果
      const validResults = results.filter((result): result is SearchResult => result !== null);

      // 使用过滤功能过滤结果
      return this.FilterResultsByKeyword(validResults, keyword);
    } catch (error) {
      throw new Error(`搜索失败: ${error}`);
    }
  }

  private async processDetailPage(client: AxiosInstance, detailURL: string): Promise<SearchResult | null> {
    // 检查缓存
    const cachedResult = detailPageCache.get(detailURL);
    if (cachedResult) {
      return this.detailResponseToResult(detailURL, cachedResult);
    }

    // 正则匹配提取ID
    const matches = detailURLRegex.exec(detailURL);
    if (!matches || matches.length < 2) {
      throw new Error(`无效的详情页URL格式: ${detailURL}`);
    }

    // 发送请求
    try {
      const resp = await client.get(detailURL, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/100.0.4896.127 Safari/537.36',
        },
        timeout: DefaultTimeout,
      });

      if (resp.status !== 200) {
        throw new Error(`请求返回状态码: ${resp.status}`);
      }

      // 解析HTML
      const $ = cheerio.load(resp.data);

      // 提取详情信息
      const response: DetailPageResponse = {
        Title: '',
        ImageURL: '',
        MagnetLinks: [],
        QuarkLinks: [],
        Tags: [],
        Content: '',
        Timestamp: new Date(),
      };

      // 1. 提取标题
      response.Title = $('.book-header h1').text().trim();
      if (response.Title === '') {
        // 尝试从页面标题获取
        const title = $('title').text();
        response.Title = title.replace(' | 4K指南', '').trim();
      }

      // 2. 提取封面图片
      response.ImageURL = $('.book-cover img').attr('src') || '';

      // 3. 提取标签
      $('.book-header .my-2 a').each((i, s) => {
        const tag = $(s).text().trim();
        if (tag !== '') {
          response.Tags.push(tag);
        }
      });

      // 4. 提取资源详情
      response.Content = $('.panel-body.single').text().trim();

      // 5. 提取磁力链接和6. 提取夸克网盘链接
      // 一次性查找所有可能包含链接的元素，减少DOM遍历
      $('li, .site-go a').each((i, s) => {
        const elem = $(s);
        if (elem.is('li')) {
          // 提取磁力链接
          const text = elem.text();
          if (text.includes('magnet:?xt=urn:btih:')) {
            // 使用预编译的正则表达式
            const magnetMatch = magnetLinkRegex.exec(text);
            if (magnetMatch) {
              response.MagnetLinks.push(magnetMatch[0]);
            }
          }
        } else if (elem.is('a')) {
          // 提取夸克网盘链接
          const href = elem.attr('href') || '';
          const title = elem.attr('title') || '';
          const name = elem.find('.b-name').text();

          if (href.includes('pan.quark.cn') || name.includes('夸克') || title.includes('夸克')) {
            const link: Link = {
              URL: href,
              Type: 'quark',
              Password: '', // 夸克网盘通常不需要单独的提取码
            };
            response.QuarkLinks.push(link);
          }
        }
      });

      // 缓存结果
      detailPageCache.set(detailURL, response);

      // 转换为搜索结果
      return this.detailResponseToResult(detailURL, response);
    } catch (error) {
      throw new Error(`处理详情页失败: ${error}`);
    }
  }

  private detailResponseToResult(detailURL: string, response: DetailPageResponse): SearchResult | null {
    if (response.Title === '' && response.MagnetLinks.length === 0 && response.QuarkLinks.length === 0) {
      return null;
    }

    // 提取ID
    const matches = detailURLRegex.exec(detailURL);
    let id = 'unknown';
    if (matches && matches.length >= 2) {
      id = matches[1];
    }

    // 创建唯一ID
    const uniqueID = `xuexizhinan-${id}`;

    // 提取日期
    let datetime = new Date();
    // 尝试从内容中提取上映日期
    const dateMatches = dateRegex.exec(response.Content);
    if (dateMatches && dateMatches.length >= 2) {
      // 尝试解析日期
      const dateParts = dateMatches[1].split('-');
      if (dateParts.length === 3) {
        const year = parseInt(dateParts[0]);
        const month = parseInt(dateParts[1]) - 1;
        const day = parseInt(dateParts[2]);
        datetime = new Date(year, month, day);
      }
    }

    // 预分配链接数组的容量
    const totalLinks = response.MagnetLinks.length + response.QuarkLinks.length;
    const links: Link[] = [];

    // 添加磁力链接
    for (const magnetLink of response.MagnetLinks) {
      links.push({
        Type: 'magnet',
        URL: magnetLink,
        Password: '',
      });
    }

    // 添加夸克网盘链接
    links.push(...response.QuarkLinks);

    // 创建搜索结果
    return {
      UniqueID: uniqueID,
      Title: response.Title,
      Content: response.Content,
      Datetime: datetime,
      Links: links,
      Tags: response.Tags,
      Channel: '',
    };
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
BaseAsyncPlugin.RegisterGlobalPlugin(new XuexizhinanPlugin());
