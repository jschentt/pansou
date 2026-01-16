import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import cheerio from 'cheerio';
import { SearchResult, Link } from '../../types';
import { Plugin } from '../../types/plugin';


// 预编译的正则表达式
const quarkLinkRegex = /https?:\/\/pan\.quark\.cn\/s\/[0-9a-zA-Z]+/;
const ucLinkRegex = /https?:\/\/drive\.uc\.cn\/s\/[0-9a-zA-Z]+(\?[^"'\s]*)?/;
const baiduLinkRegex = /https?:\/\/pan\.baidu\.com\/s\/[0-9a-zA-Z_\-]+/;
const xunleiLinkRegex = /https?:\/\/pan\.xunlei\.com\/s\/[0-9a-zA-Z_\-]+/;
const articleIDRegex = /\/([a-z]+)\/(\d+)\.html/;
const viewCountRegex = /(\d+)\s*阅读/;

// 常量定义
const pluginName = 'aikanzy';
const searchURLTemplate = 'https://www.aikanzy.com/search?word=%s&molds=article';
const defaultPriority = 3;
const defaultTimeout = 15000; // 15 seconds
const detailTimeout = 8000; // 8 seconds
const maxRetries = 3;
const detailConcurrency = 15;
const backoffBase = 200; // milliseconds

// 性能统计
let searchRequests = 0;
let detailPageRequests = 0;
let cacheHits = 0;
let cacheMisses = 0;

// 文章基本信息
interface ArticleItem {
  id: string;
  title: string;
  detailURL: string;
  category: string;
  publishDate: string;
  viewCount: number;
  summary: string;
  imageURL: string;
}

class AikanzyPlugin implements Plugin {
  private client: AxiosInstance;

  constructor() {
    this.client = axios.create({
      timeout: defaultTimeout,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      }
    });
  }

  name(): string {
    return pluginName;
  }

  displayName(): string {
    return 'aikanzy';
  }

  description(): string {
    return 'aikanzy - 网盘资源搜索';
  }

  async search(keyword: string, ext: Record<string, any>): Promise<SearchResult[]> {
    return this.searchImpl(keyword, ext);
  }

  private async searchImpl(keyword: string, ext: Record<string, any>): Promise<SearchResult[]> {
    const startTime = Date.now();
    searchRequests++;

    try {
      // 对关键词进行URL编码
      const encodedKeyword = encodeURIComponent(keyword);

      // 构建搜索URL
      const searchURL = searchURLTemplate.replace('%s', encodedKeyword);

      // 发送请求（带重试机制）
      const config: AxiosRequestConfig = {
        method: 'GET',
        url: searchURL,
        headers: this.getSearchHeaders()
      };

      const resp = await this.doRequestWithRetry(config);

      // 解析搜索结果页面
      const $ = cheerio.load(resp.data);

      // 解析文章列表
      const articleItems = this.parseArticleList($);
      if (articleItems.length === 0) {
        return [];
      }

      // 并发抓取详情页获取网盘链接
      const results = await this.fetchDetailsWithLinks(articleItems, keyword);

      // 过滤结果
      const filteredResults = this.filterResultsByKeyword(results, keyword);

      console.log(`[${this.name()}] 搜索结果: ${filteredResults.length} 条`);
      console.log(`[${this.name()}] 搜索耗时: ${Date.now() - startTime}ms`);

      return filteredResults;
    } catch (error) {
      console.error(`[${this.name()}] 搜索失败:`, error);
      return [];
    }
  }

  private parseArticleList($: cheerio.Root): ArticleItem[] {
    const items: ArticleItem[] = [];

    // 查找所有文章项
    $('article.post-list.contt.blockimg').each((i, s) => {
      // 提取详情页链接
      const detailLink = $(s).find('a[href]').first();
      const detailURL = detailLink.attr('href');
      if (!detailURL) {
        return;
      }

      // 提取文章ID
      const articleID = this.extractArticleID(detailURL);
      if (articleID === '') {
        return;
      }

      // 提取标题
      let title = $(s).find('header.entry-header span.entry-title a').text().trim();
      // 移除标题中的HTML标签（如<b>）
      title = this.cleanHTMLTags(title);
      if (title === '') {
        return;
      }

      // 提取分类
      const category = $(s).find('div.entry-meta > a').first().text().trim();

      // 提取发布日期
      const publishDate = $(s).find('time').first().text().trim();

      // 提取阅读数
      const metaText = $(s).find('div.entry-meta').text();
      const viewCount = this.extractViewCount(metaText);

      // 提取摘要
      let summary = $(s).find('div.entry-summary.ss p').text().trim();
      summary = this.cleanHTMLTags(summary);

      // 提取缩略图
      const imageURL = $(s).find('img.block-fea').attr('data-src') || '';

      items.push({
        id: articleID,
        title: title,
        detailURL: detailURL,
        category: category,
        publishDate: publishDate,
        viewCount: viewCount,
        summary: summary,
        imageURL: imageURL
      });
    });

    return items;
  }

  private async fetchDetailsWithLinks(items: ArticleItem[], keyword: string): Promise<SearchResult[]> {
    const results: SearchResult[] = [];
    const semaphore = this.createSemaphore(detailConcurrency);

    const promises = items.map(async (item) => {
      await semaphore.acquire();
      try {
        // 抓取详情页
        const links = await this.fetchDetailPageLinks(item.detailURL);

        // 只有包含链接的结果才添加
        if (links.length > 0) {
          // 解析发布时间
          const publishTime = this.parsePublishTime(item.publishDate);

          // 组装内容
          const contentParts: string[] = [];
          if (item.summary) {
            contentParts.push(item.summary);
          }
          if (item.category) {
            contentParts.push(item.category);
          }
          if (item.publishDate) {
            contentParts.push(item.publishDate);
          }
          if (item.viewCount > 0) {
            contentParts.push(`${item.viewCount}阅读`);
          }
          const content = contentParts.join(' | ');

          // 组装标签
          const tags: string[] = [];
          if (item.category) {
            tags.push(item.category);
          }

          const result: SearchResult = {
            uniqueId: `${this.name()}-${item.id}`,
            title: item.title,
            content: content,
            links: links,
            tags: tags,
            channel: '',
            datetime: publishTime,
            images: item.imageURL ? [item.imageURL] : [],
            pluginName: this.name(),
            displayName: this.displayName()
          };

          results.push(result);
        }
      } catch (error) {
        console.error(`[${this.name()}] 详情页处理失败:`, error);
      } finally {
        semaphore.release();
      }
    });

    // 等待所有请求完成
    await Promise.all(promises);

    return results;
  }

  private async fetchDetailPageLinks(detailURL: string): Promise<Link[]> {
    detailPageRequests++;

    try {
      // 发送请求（带重试机制）
      const config: AxiosRequestConfig = {
        method: 'GET',
        url: detailURL,
        headers: this.getDetailHeaders(),
        timeout: detailTimeout
      };

      const resp = await this.doRequestWithRetry(config);

      // 解析HTML
      const $ = cheerio.load(resp.data);

      // 提取网盘链接
      return this.extractNetDiskLinks($);
    } catch (error) {
      console.error(`[${this.name()}] 详情页请求失败:`, error);
      return [];
    }
  }

  private extractNetDiskLinks($: cheerio.Root): Link[] {
    const links: Link[] = [];
    const foundURLs = new Set<string>(); // 用于去重

    // 方法1: 从<a>标签的href属性提取
    $('a[href*="pan.quark.cn"], a[href*="drive.uc.cn"], a[href*="pan.baidu.com"], a[href*="pan.xunlei.com"]').each((i, s) => {
      const href = $(s).attr('href');
      if (!href) {
        return;
      }

      // 去重
      if (foundURLs.has(href)) {
        return;
      }
      foundURLs.add(href);

      // 确定链接类型
      const linkType = this.determineLinkType(href);
      if (linkType === '') {
        return;
      }

      links.push({
        url: href,
        type: linkType,
        password: this.extractPassword(href)
      });
    });

    // 方法2: 从页面HTML文本中提取（正则表达式）
    if (links.length === 0) {
      const html = $.html();

      // 提取夸克网盘链接
      const quarkLinks = html.match(quarkLinkRegex) || [];
      for (const link of quarkLinks) {
        if (!foundURLs.has(link)) {
          foundURLs.add(link);
          links.push({
            url: link,
            type: 'quark',
            password: this.extractPassword(link)
          });
        }
      }

      // 提取UC网盘链接
      const ucLinks = html.match(ucLinkRegex) || [];
      for (const link of ucLinks) {
        if (!foundURLs.has(link)) {
          foundURLs.add(link);
          links.push({
            url: link,
            type: 'uc',
            password: this.extractPassword(link)
          });
        }
      }

      // 提取百度网盘链接
      const baiduLinks = html.match(baiduLinkRegex) || [];
      for (const link of baiduLinks) {
        if (!foundURLs.has(link)) {
          foundURLs.add(link);
          links.push({
            url: link,
            type: 'baidu',
            password: this.extractPassword(link)
          });
        }
      }

      // 提取迅雷网盘链接
      const xunleiLinks = html.match(xunleiLinkRegex) || [];
      for (const link of xunleiLinks) {
        if (!foundURLs.has(link)) {
          foundURLs.add(link);
          links.push({
            url: link,
            type: 'xunlei',
            password: this.extractPassword(link)
          });
        }
      }
    }

    return links;
  }

  private determineLinkType(urlStr: string): string {
    const lowerURL = urlStr.toLowerCase();

    switch (true) {
      case lowerURL.includes('pan.quark.cn'):
        return 'quark';
      case lowerURL.includes('drive.uc.cn'):
        return 'uc';
      case lowerURL.includes('pan.baidu.com'):
        return 'baidu';
      case lowerURL.includes('pan.xunlei.com'):
        return 'xunlei';
      default:
        return '';
    }
  }

  private extractArticleID(urlStr: string): string {
    const matches = articleIDRegex.exec(urlStr);
    if (matches && matches.length >= 3) {
      return matches[2]; // 返回数字ID
    }
    return '';
  }

  private extractViewCount(text: string): number {
    const matches = viewCountRegex.exec(text);
    if (matches && matches.length >= 2) {
      return parseInt(matches[1], 10) || 0;
    }
    return 0;
  }

  private cleanHTMLTags(text: string): string {
    // 移除<b>标签
    text = text.replace(/<b[^>]*>/g, '');
    text = text.replace(/<\/b>/g, '');

    // 移除其他常见HTML标签
    text = text.replace(/<[^>]+>/g, '');

    return text.trim();
  }

  private parsePublishTime(dateStr: string): Date {
    dateStr = dateStr.trim();
    if (!dateStr) {
      return new Date();
    }

    // 尝试多种日期格式
    const formats = [
      'YYYY-MM-DD',
      'YYYY-MM-DD HH:mm:ss',
      'YYYY-MM-DDTHH:mm:ssZ',
      'YYYY-MM-DDTHH:mm:ss+08:00',
      'YYYY-MM-DDTHH:mm:ss-07:00'
    ];

    // 简单处理，直接尝试转换
    const date = new Date(dateStr);
    if (!isNaN(date.getTime())) {
      return date;
    }

    // 默认返回当前时间
    return new Date();
  }

  private extractPassword(urlStr: string): string {
    // 从URL中提取pwd=后面的四位密码(不包含#)
    const pwdRegex = /pwd=([^#&]{4})/;
    const matches = pwdRegex.exec(urlStr);
    if (matches && matches.length >= 2) {
      return matches[1];
    }
    return '';
  }

  private getSearchHeaders(): Record<string, string> {
    return {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'Connection': 'keep-alive',
      'Referer': 'https://www.aikanzy.com/',
      'Upgrade-Insecure-Requests': '1',
      'Cache-Control': 'max-age=0'
    };
  }

  private getDetailHeaders(): Record<string, string> {
    return {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'Connection': 'keep-alive',
      'Referer': 'https://www.aikanzy.com/',
      'Upgrade-Insecure-Requests': '1'
    };
  }

  private async doRequestWithRetry(config: AxiosRequestConfig): Promise<any> {
    let lastError: any;

    for (let retry = 0; retry <= maxRetries; retry++) {
      if (retry > 0) {
        // 指数退避
        const backoffTime = Math.pow(2, retry-1) * backoffBase;
        await this.sleep(backoffTime);
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

    throw new Error(`重试 ${maxRetries} 次后仍然失败: ${lastError}`);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private createSemaphore(maxConcurrency: number): {
    acquire: () => Promise<void>;
    release: () => void;
  } {
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
          if (resolve) resolve();
        }
      }
    };
  }

  private filterResultsByKeyword(results: SearchResult[], keyword: string): SearchResult[] {
    if (!keyword) {
      return results;
    }

    const lowerKeyword = keyword.toLowerCase();
    const parts = lowerKeyword.split(/\s+/);

    return results.filter(result => {
      const target = `${result.title} ${result.content}`.toLowerCase();
      return parts.every(part => target.includes(part));
    });
  }
}

// 导出插件实例
const plugin = new AikanzyPlugin();
export default plugin;