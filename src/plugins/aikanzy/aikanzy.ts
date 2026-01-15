import { BaseAsyncPlugin, registerGlobalPlugin } from '../plugin.manager';
import { AxiosInstance } from 'axios';
import { SearchResult, Link } from '../../models/response';
import axios from 'axios';
import * as cheerio from 'cheerio';

// 预编译的正则表达式
const quarkLinkRegex = /https?:\/\/pan\.quark\.cn\/s\/[0-9a-zA-Z]+/;
const ucLinkRegex = /https?:\/\/drive\.uc\.cn\/s\/[0-9a-zA-Z]+(\?[^"'\s]*)?/;
const baiduLinkRegex = /https?:\/\/pan\.baidu\.com\/s\/[0-9a-zA-Z_-]+/;
const xunleiLinkRegex = /https?:\/\/pan\.xunlei\.com\/s\/[0-9a-zA-Z_-]+/;
const articleIDRegex = /\/([a-z]+)\/(\d+)\.html/;
const viewCountRegex = /(\d+)\s*阅读/;

// 常量定义
const pluginName = "aikanzy";
const searchURLTemplate = "https://www.aikanzy.com/search?word=%s&molds=article";
const defaultPriority = 3;
const defaultTimeout = 15000; // 15秒
const detailTimeout = 8000; // 8秒
const maxRetries = 3;
const detailConcurrency = 15;
const backoffBase = 200; // 指数退避基数（毫秒）

// ArticleItem 文章基本信息
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

// AikanzyAsyncPlugin 是AikanZY网站的异步搜索插件实现
class AikanzyAsyncPlugin extends BaseAsyncPlugin {
  private optimizedClient: AxiosInstance;

  constructor() {
    super(pluginName, defaultPriority);
    this.optimizedClient = this.createOptimizedHTTPClient();
  }

  // 创建优化的HTTP客户端
  private createOptimizedHTTPClient(): AxiosInstance {
    return axios.create({
      timeout: defaultTimeout,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Connection': 'keep-alive',
        'Referer': 'https://www.aikanzy.com/',
        'Upgrade-Insecure-Requests': '1',
        'Cache-Control': 'max-age=0',
      },
    });
  }

  // Search 执行搜索
  async search(keyword: string, ext: Record<string, any>): Promise<SearchResult[]> {
    return this.asyncSearch(keyword, this.doSearch, this.mainCacheKey, ext);
  }

  // doSearch 执行具体的搜索逻辑
  private async doSearch(client: AxiosInstance, keyword: string, ext: Record<string, any>): Promise<SearchResult[]> {
    // 使用优化的客户端
    if (this.optimizedClient) {
      client = this.optimizedClient;
    }
    
    // 对关键词进行URL编码
    const encodedKeyword = encodeURIComponent(keyword);
    
    // 构建搜索URL
    const searchURL = searchURLTemplate.replace("%s", encodedKeyword);
    
    // 发送请求（带重试机制）
    const resp = await this.doRequestWithRetry(client, searchURL);

    // 检查状态码
    if (resp.status !== 200) {
      throw new Error(`[${this.name()}] 请求搜索页面失败，状态码: ${resp.status}`);
    }
    
    // 使用cheerio解析HTML
    const $ = cheerio.load(resp.data);
    
    // 解析搜索结果列表
    const articleItems = this.parseArticleList($);
    if (articleItems.length === 0) {
      return [];
    }
    
    // 并发抓取详情页获取网盘链接
    const results = await this.fetchDetailsWithLinks(articleItems, client, keyword);
    
    return results;
  }

  // parseArticleList 解析文章列表
  private parseArticleList($: cheerio.CheerioAPI): ArticleItem[] {
    const items: ArticleItem[] = [];
    
    // 查找所有文章项
    $('article.post-list.contt.blockimg').each((i, s) => {
      const article = $(s);
      
      // 提取详情页链接
      const detailLink = article.find("a[href]").first();
      const detailURL = detailLink.attr("href");
      if (!detailURL) {
        return;
      }
      
      // 提取文章ID
      const articleID = this.extractArticleID(detailURL);
      if (!articleID) {
        return;
      }
      
      // 提取标题
      let title = article.find("header.entry-header span.entry-title a").text().trim();
      // 移除标题中的HTML标签
      title = this.cleanHTMLTags(title);
      if (!title) {
        return;
      }
      
      // 提取分类
      const category = article.find("div.entry-meta > a").first().text().trim();
      
      // 提取发布日期
      const publishDate = article.find("time").first().text().trim();
      
      // 提取阅读数
      const metaText = article.find("div.entry-meta").text();
      const viewCount = this.extractViewCount(metaText);
      
      // 提取摘要
      let summary = article.find("div.entry-summary.ss p").text().trim();
      summary = this.cleanHTMLTags(summary);
      
      // 提取缩略图
      const imageURL = article.find("img.block-fea").attr("data-src") || "";
      
      items.push({
        id: articleID,
        title,
        detailURL,
        category,
        publishDate,
        viewCount,
        summary,
        imageURL,
      });
    });
    
    return items;
  }

  // fetchDetailsWithLinks 并发抓取详情页获取网盘链接
  private async fetchDetailsWithLinks(
    articleItems: ArticleItem[], 
    client: AxiosInstance, 
    keyword: string
  ): Promise<SearchResult[]> {
    const results: SearchResult[] = [];
    const semaphore = new Semaphore(detailConcurrency);
    const promises: Promise<void>[] = [];

    // 并发处理每个文章项
    for (const item of articleItems) {
      promises.push(semaphore.acquire().then(async () => {
        try {
          // 抓取详情页
          const links = await this.fetchDetailPageLinks(item.detailURL, client);
          
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
            const content = contentParts.join(" | ");
            
            // 组装标签
            const tags: string[] = [];
            if (item.category) {
              tags.push(item.category);
            }
            
            const result: SearchResult = {
              uniqueId: `aikanzy-${item.id}`,
              messageId: `aikanzy-${item.id}`,
              title: item.title,
              content,
              links,
              tags,
              channel: "", // 插件搜索结果Channel为空
              datetime: publishTime.toISOString(),
            };
            
            results.push(result);
          }
        } finally {
          semaphore.release();
        }
      }));
    }
    
    // 等待所有请求完成
    await Promise.all(promises);
    
    return results;
  }

  // fetchDetailPageLinks 抓取详情页的网盘链接
  private async fetchDetailPageLinks(detailURL: string, client: AxiosInstance): Promise<Link[]> {
    try {
      // 创建带超时的请求
      const resp = await client.get(detailURL, { timeout: detailTimeout });

      // 检查状态码
      if (resp.status !== 200) {
        return [];
      }
      
      // 解析HTML
      const $ = cheerio.load(resp.data);
      
      // 提取网盘链接
      return this.extractNetDiskLinks($);
    } catch (error) {
      console.error(`[${this.name()}] 抓取详情页失败: ${error}`);
      return [];
    }
  }

  // extractNetDiskLinks 从详情页提取网盘链接
  private extractNetDiskLinks($: cheerio.CheerioAPI): Link[] {
    const links: Link[] = [];
    const foundURLs = new Set<string>(); // 用于去重
    
    // 方法1: 从<a>标签的href属性提取
    $('a[href*="pan.quark.cn"], a[href*="drive.uc.cn"], a[href*="pan.baidu.com"], a[href*="pan.xunlei.com"]').each((i, s) => {
      const linkElem = $(s);
      const href = linkElem.attr("href");
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
      if (!linkType) {
        return;
      }
      
      links.push({
        type: linkType,
        url: href,
        password: this.extractPassword(href),
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
            type: "quark",
            url: link,
            password: this.extractPassword(link),
          });
        }
      }
      
      // 提取UC网盘链接
      const ucLinks = html.match(ucLinkRegex) || [];
      for (const link of ucLinks) {
        if (!foundURLs.has(link)) {
          foundURLs.add(link);
          links.push({
            type: "uc",
            url: link,
            password: this.extractPassword(link),
          });
        }
      }
      
      // 提取百度网盘链接
      const baiduLinks = html.match(baiduLinkRegex) || [];
      for (const link of baiduLinks) {
        if (!foundURLs.has(link)) {
          foundURLs.add(link);
          links.push({
            type: "baidu",
            url: link,
            password: this.extractPassword(link),
          });
        }
      }
      
      // 提取迅雷网盘链接
      const xunleiLinks = html.match(xunleiLinkRegex) || [];
      for (const link of xunleiLinks) {
        if (!foundURLs.has(link)) {
          foundURLs.add(link);
          links.push({
            type: "xunlei",
            url: link,
            password: this.extractPassword(link),
          });
        }
      }
    }
    
    return links;
  }

  // determineLinkType 根据URL确定链接类型
  private determineLinkType(urlStr: string): string {
    const lowerURL = urlStr.toLowerCase();
    
    if (lowerURL.includes("pan.quark.cn")) {
      return "quark";
    } else if (lowerURL.includes("drive.uc.cn")) {
      return "uc";
    } else if (lowerURL.includes("pan.baidu.com")) {
      return "baidu";
    } else if (lowerURL.includes("pan.xunlei.com")) {
      return "xunlei";
    } else {
      return "";
    }
  }

  // extractArticleID 从URL中提取文章ID
  private extractArticleID(urlStr: string): string {
    const matches = urlStr.match(articleIDRegex);
    if (matches && matches.length >= 3) {
      return matches[2]; // 返回数字ID
    }
    return "";
  }

  // extractViewCount 提取阅读数
  private extractViewCount(text: string): number {
    const matches = text.match(viewCountRegex);
    if (matches && matches.length >= 2) {
      return parseInt(matches[1], 10) || 0;
    }
    return 0;
  }

  // cleanHTMLTags 清除HTML标签
  private cleanHTMLTags(text: string): string {
    // 移除<b>标签
    text = text.replace(/<b[^>]*>/g, "");
    text = text.replace(/<\/b>/g, "");
    
    // 移除其他常见HTML标签
    text = text.replace(/<[^>]+>/g, "");
    
    return text.trim();
  }

  // parsePublishTime 解析发布时间
  private parsePublishTime(dateStr: string): Date {
    dateStr = dateStr.trim();
    if (!dateStr) {
      return new Date(0);
    }
    
    // 尝试多种日期格式
    const formats = [
      "2006-01-02",
      "2006-01-02 15:04:05",
      "2006-01-02T15:04:05Z",
      "2006-01-02T15:04:05+08:00",
      "2006-01-02T15:04:05-07:00",
    ];
    
    for (const format of formats) {
      const date = new Date(dateStr);
      if (!isNaN(date.getTime())) {
        return date;
      }
    }
    
    // 如果以上格式都不匹配，尝试使用RFC3339格式
    const rfc3339Date = new Date(dateStr);
    if (!isNaN(rfc3339Date.getTime())) {
      return rfc3339Date;
    }
    
    return new Date(0);
  }

  // extractPassword 从网盘链接中提取密码
  private extractPassword(urlStr: string): string {
    // 从URL中提取pwd=后面的四位密码(不包含#)
    const pwdRegex = /pwd=([^#&]{4})/;
    const matches = urlStr.match(pwdRegex);
    if (matches && matches.length >= 2) {
      return matches[1];
    }
    return "";
  }

  // doRequestWithRetry 发送HTTP请求，带重试机制
  private async doRequestWithRetry(client: AxiosInstance, url: string): Promise<any> {
    for (let retry = 0; retry <= maxRetries; retry++) {
      if (retry > 0) {
        // 指数退避
        const backoffTime = Math.pow(2, retry - 1) * backoffBase;
        await this.sleep(backoffTime);
      }
      
      try {
        const resp = await client.get(url);
        if (resp.status === 200) {
          return resp;
        }
      } catch (error) {
        // 忽略错误，继续重试
      }
    }
    
    throw new Error(`重试 ${maxRetries} 次后仍然失败`);
  }

  // 休眠函数
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// 信号量实现
class Semaphore {
  private permits: number;
  private queue: (() => void)[] = [];

  constructor(permits: number) {
    this.permits = permits;
  }

  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--;
      return Promise.resolve();
    }

    return new Promise(resolve => {
      this.queue.push(resolve);
    });
  }

  release(): void {
    this.permits++;
    if (this.queue.length > 0) {
      const resolve = this.queue.shift()!;
      resolve();
    }
  }
}

// 创建并注册插件
const aikanzyPlugin = new AikanzyAsyncPlugin();
registerGlobalPlugin(aikanzyPlugin);

export type { AikanzyAsyncPlugin };

export const AikanzyAsyncPluginInstance = aikanzyPlugin;
