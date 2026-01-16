import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import { SearchResult, Link } from '../../types';
import { Plugin } from '../../types/plugin';
import * as cheerio from 'cheerio';

// 常量定义
const BaseURL = "https://www.cilixiong.org";
const SearchURL = "https://www.cilixiong.org/e/search/index.php";
const UserAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36";
const MaxRetries = 3;
const RetryDelay = 2000; // 2秒
const MaxResults = 30;

// DetailPageInfo 详情页信息结构体
interface DetailPageInfo {
  magnetLinks: Link[];
  updateTime: Date;
  title: string;
  fileNames: string[]; // 所有文件的名称，与磁力链接对应
}

const pluginName = 'clxiong';
const defaultPriority = 2;

class ClxiongPlugin implements Plugin {
  private client: AxiosInstance;
  private debugMode: boolean;

  constructor() {
    this.client = axios.create({
      timeout: 30000,
      headers: {
        'User-Agent': UserAgent
      }
    });
    this.debugMode = false; // 开启调试模式检查磁力链接提取问题
  }

  name(): string {
    return pluginName;
  }

  displayName(): string {
    return '磁力熊';
  }

  description(): string {
    return '磁力熊 - 影视资源搜索';
  }

  async search(keyword: string, ext: Record<string, any>): Promise<SearchResult[]> {
    if (this.debugMode) {
      console.log(`[CLXIONG] 开始搜索: ${keyword}`);
    }

    try {
      // 第一步：POST搜索获取searchid
      const searchID = await this.getSearchID(keyword);

      // 第二步：GET搜索结果
      const results = await this.getSearchResults(searchID, keyword);

      // 第三步：同步获取详情页磁力链接
      const finalResults = this.fetchDetailLinksSync(results);

      // 应用关键词过滤
      const filteredResults = this.filterResultsByKeyword(finalResults, keyword);

      if (this.debugMode) {
        console.log(`[CLXIONG] 搜索完成，获得 ${filteredResults.length} 个结果`);
      }

      return filteredResults;
    } catch (error) {
      console.error(`[CLXIONG] 搜索失败:`, error);
      return [];
    }
  }

  // getSearchID 第一步：POST搜索获取searchid
  private async getSearchID(keyword: string): Promise<string> {
    if (this.debugMode) {
      console.log(`[CLXIONG] 正在获取searchid...`);
    }

    // 准备POST数据
    const formData = new URLSearchParams();
    formData.append('classid', '1,2');      // 1=电影，2=剧集
    formData.append('show', 'title');       // 搜索字段
    formData.append('tempid', '1');         // 模板ID
    formData.append('keyboard', keyword);   // 搜索关键词

    const config: AxiosRequestConfig = {
      method: 'POST',
      url: SearchURL,
      data: formData.toString(),
      headers: {
        'User-Agent': UserAgent,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': BaseURL + '/',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8'
      },
      maxRedirects: 0, // 不自动跟随重定向
      validateStatus: (status) => status >= 200 && status < 400
    };

    let lastErr: any;

    // 重试机制
    for (let i = 0; i < MaxRetries; i++) {
      try {
        const resp = await this.client(config);
        if (resp.status === 302 || resp.status === 301) {
          // 从Location头部提取searchid
          const location = resp.headers['location'];
          if (location) {
            const searchID = this.extractSearchIDFromLocation(location);
            if (searchID) {
              if (this.debugMode) {
                console.log(`[CLXIONG] 获取到searchid: ${searchID}`);
              }
              return searchID;
            }
          }
        }
      } catch (error) {
        lastErr = error;
      }

      if (i < MaxRetries - 1) {
        await this.sleep(RetryDelay);
      }
    }

    if (lastErr) {
      throw lastErr;
    }

    throw new Error('无法获取searchid');
  }

  // extractSearchIDFromLocation 从Location头部提取searchid
  private extractSearchIDFromLocation(location: string): string {
    // location格式: "result/?searchid=7549"
    const re = /searchid=(\d+)/;
    const matches = location.match(re);
    if (matches && matches.length > 1) {
      return matches[1];
    }
    return '';
  }

  // getSearchResults 第二步：GET搜索结果
  private async getSearchResults(searchID: string, keyword: string): Promise<SearchResult[]> {
    if (this.debugMode) {
      console.log(`[CLXIONG] 正在获取搜索结果，searchid: ${searchID}`);
    }

    // 构建结果页URL
    const resultURL = `${BaseURL}/e/search/result/?searchid=${searchID}`;

    const config: AxiosRequestConfig = {
      method: 'GET',
      url: resultURL,
      headers: {
        'User-Agent': UserAgent,
        'Referer': BaseURL + '/',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8'
      }
    };

    let lastErr: any;

    // 重试机制
    for (let i = 0; i < MaxRetries; i++) {
      try {
        const resp = await this.client(config);
        if (resp.status === 200) {
          return this.parseSearchResults(resp.data);
        }
      } catch (error) {
        lastErr = error;
      }

      if (i < MaxRetries - 1) {
        await this.sleep(RetryDelay);
      }
    }

    if (lastErr) {
      throw lastErr;
    }

    throw new Error('搜索结果请求失败');
  }

  // parseSearchResults 解析搜索结果页面
  private parseSearchResults(html: string): SearchResult[] {
    const $ = cheerio.load(html);

    const results: SearchResult[] = [];

    // 查找搜索结果项
    $('.row.row-cols-2.row-cols-lg-4 .col').each((i, element) => {
      if (i >= MaxResults) {
        return; // 限制结果数量
      }

      const s = $(element);

      // 提取详情页链接
      const linkEl = s.find("a[href*='/drama/'], a[href*='/movie/']");
      if (linkEl.length === 0) {
        return; // 跳过无链接的项
      }

      const detailPath = linkEl.attr('href');
      if (!detailPath) {
        return;
      }

      // 构建完整的详情页URL
      const detailURL = BaseURL + detailPath;

      // 提取标题
      const title = linkEl.find('h2.h4').text().trim();
      if (!title) {
        return; // 跳过无标题的项
      }

      // 提取评分
      const rating = s.find('.rank').text().trim();

      // 提取年份
      const year = s.find('.small').last().text().trim();

      // 提取海报图片
      let poster = '';
      const cardImg = s.find('.card-img');
      if (cardImg.length > 0) {
        const style = cardImg.attr('style');
        if (style) {
          poster = this.extractImageFromStyle(style);
        }
      }

      // 构建内容信息
      const contentParts: string[] = [];
      if (rating) {
        contentParts.push(`评分: ${rating}`);
      }
      if (year) {
        contentParts.push(`年份: ${year}`);
      }
      if (poster) {
        contentParts.push(`海报: ${poster}`);
      }
      // 添加详情页链接到content中，供后续提取磁力链接使用
      contentParts.push(`详情页: ${detailURL}`);

      const content = contentParts.join(' | ');

      // 生成唯一ID
      const uniqueID = this.generateUniqueID(detailPath);

      const result: SearchResult = {
        uniqueId: uniqueID,
        title: title,
        content: content,
        datetime: new Date(), // 搜索时间
        channel: '', // 插件搜索结果必须为空
        links: [], // 初始为空，后续异步获取
        tags: ['磁力链接', '影视'],
        images: [],
        pluginName: this.name(),
        displayName: this.displayName()
      };

      results.push(result);
    });

    if (this.debugMode) {
      console.log(`[CLXIONG] 解析到 ${results.length} 个搜索结果`);
    }

    return results;
  }

  // extractImageFromStyle 从style属性中提取背景图片URL
  private extractImageFromStyle(style: string): string {
    // style格式: "background-image: url('https://i.nacloud.cc/2024/12154.webp');"
    const re = /url\(['"]?([^'"]+)['"]?\)/;
    const matches = style.match(re);
    if (matches && matches.length > 1) {
      return matches[1];
    }
    return '';
  }

  // fetchDetailLinksSync 同步获取详情页磁力链接
  private fetchDetailLinksSync(results: SearchResult[]): SearchResult[] {
    if (results.length === 0) {
      return results;
    }

    if (this.debugMode) {
      console.log(`[CLXIONG] 开始同步获取 ${results.length} 个详情页的磁力链接`);
    }

    // 使用Promise.all限制并发数
    const semaphore = this.createSemaphore(5); // 最多5个并发请求
    const promises = results.map(async (result, index) => {
      await semaphore.acquire();
      try {
        return this.processDetailPage(result, index);
      } finally {
        semaphore.release();
      }
    });

    // 等待所有请求完成
    const allResults = Promise.all(promises).then((processedResults) => {
      // 合并所有结果
      let finalResults: SearchResult[] = [];
      processedResults.forEach((resultGroup) => {
        finalResults = finalResults.concat(resultGroup);
      });
      return finalResults;
    }).catch((error) => {
      console.error(`[CLXIONG] 处理详情页失败:`, error);
      return results;
    });

    // 同步等待
    return allResults.then((finalResults) => {
      if (this.debugMode) {
        const totalLinks = finalResults.reduce((sum, result) => sum + result.links.length, 0);
        console.log(`[CLXIONG] 所有磁力链接获取完成，共获得 ${totalLinks} 个磁力链接，总搜索结果 ${finalResults.length} 个`);
      }
      return finalResults;
    });
  }

  // processDetailPage 处理单个详情页
  private async processDetailPage(result: SearchResult, index: number): Promise<SearchResult[]> {
    const detailURL = this.extractDetailURLFromContent(result.content);
    if (!detailURL) {
      return [result];
    }

    const detailInfo = await this.fetchDetailPageInfo(detailURL, result.title);
    if (!detailInfo || detailInfo.magnetLinks.length === 0) {
      return [result];
    }

    const processedResults: SearchResult[] = [];

    // 为每个磁力链接创建独立的搜索结果
    const baseResult = result;

    // 第一个链接更新原结果
    if (detailInfo.fileNames.length > 0) {
      result.title = `${baseResult.title}-${detailInfo.fileNames[0]}`;
    }
    result.links = [detailInfo.magnetLinks[0]];
    if (detailInfo.updateTime.getTime() > 0) {
      result.datetime = detailInfo.updateTime;
    }
    processedResults.push(result);

    // 其他链接创建新的搜索结果
    for (let i = 1; i < detailInfo.magnetLinks.length; i++) {
      const newResult: SearchResult = {
        uniqueId: `${baseResult.uniqueId}-${i+1}`,
        title: baseResult.title,
        content: baseResult.content,
        datetime: baseResult.datetime,
        channel: baseResult.channel,
        links: [detailInfo.magnetLinks[i]],
        tags: [...baseResult.tags],
        images: [...baseResult.images],
        pluginName: baseResult.pluginName,
        displayName: baseResult.displayName
      };

      // 设置独特的标题和时间
      if (i < detailInfo.fileNames.length) {
        newResult.title = `${baseResult.title}-${detailInfo.fileNames[i]}`;
      }

      if (detailInfo.updateTime.getTime() > 0) {
        newResult.datetime = detailInfo.updateTime;
      }

      processedResults.push(newResult);
    }

    if (this.debugMode) {
      console.log(`[CLXIONG] 为结果 ${index+1} 获取到 ${detailInfo.magnetLinks.length} 个磁力链接，创建了 ${processedResults.length} 个搜索结果`);
    }

    return processedResults;
  }

  // extractDetailURLFromContent 从content中提取详情页URL
  private extractDetailURLFromContent(content: string): string {
    // 查找"详情页: URL"模式
    const re = /详情页: (https?:\/\/[^\s|]+)/;
    const matches = content.match(re);
    if (matches && matches.length > 1) {
      return matches[1];
    }
    return '';
  }

  // fetchDetailPageInfo 获取详情页的完整信息
  private async fetchDetailPageInfo(detailURL: string, movieTitle: string): Promise<DetailPageInfo | null> {
    if (this.debugMode) {
      console.log(`[CLXIONG] 正在获取详情页信息: ${detailURL}`);
    }

    const config: AxiosRequestConfig = {
      method: 'GET',
      url: detailURL,
      headers: {
        'User-Agent': UserAgent,
        'Referer': BaseURL + '/',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8'
      },
      timeout: 20000
    };

    try {
      const resp = await this.client(config);
      if (resp.status === 200) {
        return this.parseDetailPageInfo(resp.data, movieTitle);
      }
    } catch (error) {
      if (this.debugMode) {
        console.log(`[CLXIONG] 详情页请求失败:`, error);
      }
    }

    return null;
  }

  // parseDetailPageInfo 从详情页HTML中解析完整信息
  private parseDetailPageInfo(html: string, movieTitle: string): DetailPageInfo | null {
    try {
      const $ = cheerio.load(html);

      const detailInfo: DetailPageInfo = {
        magnetLinks: [],
        updateTime: new Date(0),
        title: movieTitle,
        fileNames: []
      };

      // 解析更新时间
      detailInfo.updateTime = this.parseUpdateTimeFromDetail($);

      // 解析磁力链接
      const { magnetLinks, fileNames } = this.parseMagnetLinksFromDetailDoc($, movieTitle);
      detailInfo.magnetLinks = magnetLinks;
      detailInfo.fileNames = fileNames;

      if (this.debugMode) {
        console.log(`[CLXIONG] 详情页解析完成: 磁力链接 ${detailInfo.magnetLinks.length} 个，更新时间: ${detailInfo.updateTime}`);
      }

      return detailInfo;
    } catch (error) {
      if (this.debugMode) {
        console.log(`[CLXIONG] 解析详情页HTML失败:`, error);
      }
      return null;
    }
  }

  // parseUpdateTimeFromDetail 从详情页解析更新时间
  private parseUpdateTimeFromDetail($: cheerio.Root): Date {
    // 查找"最后更新于：2025-08-16"这样的文本
    let updateTime = new Date(0);

    $('.mv_detail p').each((i, element) => {
      const text = $(element).text().trim();
      if (text.includes('最后更新于：')) {
        // 提取日期部分
        let dateStr = text.replace('最后更新于：', '').trim();

        // 解析日期，支持多种格式
        const layouts = [
          'YYYY-MM-DD',
          'YYYY-M-D',
          'YYYY/MM/DD',
          'YYYY/M/D'
        ];

        // 尝试各种格式解析
        for (const layout of layouts) {
          const parsedDate = this.parseDate(dateStr, layout);
          if (parsedDate.getTime() > 0) {
            updateTime = parsedDate;
            if (this.debugMode) {
              console.log(`[CLXIONG] 解析到更新时间: ${dateStr} -> ${updateTime}`);
            }
            return false; // 停止遍历
          }
        }

        if (this.debugMode) {
          console.log(`[CLXIONG] 无法解析更新时间: ${dateStr}`);
        }
      }
    });

    return updateTime;
  }

  // parseDate 解析日期字符串
  private parseDate(dateStr: string, layout: string): Date {
    // 简单的日期解析实现
    let year = 0, month = 0, day = 0;

    if (layout === 'YYYY-MM-DD') {
      const parts = dateStr.split('-');
      if (parts.length === 3) {
        year = parseInt(parts[0]);
        month = parseInt(parts[1]) - 1;
        day = parseInt(parts[2]);
      }
    } else if (layout === 'YYYY-M-D') {
      const parts = dateStr.split('-');
      if (parts.length === 3) {
        year = parseInt(parts[0]);
        month = parseInt(parts[1]) - 1;
        day = parseInt(parts[2]);
      }
    } else if (layout === 'YYYY/MM/DD') {
      const parts = dateStr.split('/');
      if (parts.length === 3) {
        year = parseInt(parts[0]);
        month = parseInt(parts[1]) - 1;
        day = parseInt(parts[2]);
      }
    } else if (layout === 'YYYY/M/D') {
      const parts = dateStr.split('/');
      if (parts.length === 3) {
        year = parseInt(parts[0]);
        month = parseInt(parts[1]) - 1;
        day = parseInt(parts[2]);
      }
    }

    if (year > 0 && month >= 0 && month < 12 && day > 0 && day <= 31) {
      return new Date(year, month, day);
    }

    return new Date(0);
  }

  // parseMagnetLinksFromDetailDoc 从详情页DOM解析磁力链接
  private parseMagnetLinksFromDetailDoc($: cheerio.Root, movieTitle: string): { magnetLinks: Link[], fileNames: string[] } {
    const magnetLinks: Link[] = [];
    const fileNames: string[] = [];

    if (this.debugMode) {
      // 调试：检查是否找到磁力下载区域
      const mvDown = $('.mv_down');
      console.log(`[CLXIONG] 找到 .mv_down 区域数量: ${mvDown.length}`);

      // 调试：检查磁力链接数量
      const magnetLinksCount = $('.mv_down a[href^="magnet:"]').length;
      console.log(`[CLXIONG] 找到磁力链接数量: ${magnetLinksCount}`);

      // 如果没找到，尝试其他可能的选择器
      if (magnetLinksCount === 0) {
        const allMagnetLinks = $('a[href^="magnet:"]').length;
        console.log(`[CLXIONG] 页面总磁力链接数量: ${allMagnetLinks}`);
      }
    }

    // 查找磁力链接
    $('.mv_down a[href^="magnet:"]').each((i, element) => {
      const s = $(element);
      const href = s.attr('href');
      if (href) {
        // 获取文件名（链接文本）
        const fileName = s.text().trim();

        const link: Link = {
          url: href,
          type: 'magnet',
          password: '' // 磁力链接密码字段设置为空
        };

        magnetLinks.push(link);
        fileNames.push(fileName);

        if (this.debugMode) {
          console.log(`[CLXIONG] 找到磁力链接: ${fileName}`);
        }
      }
    });

    if (this.debugMode) {
      console.log(`[CLXIONG] 详情页共找到 ${magnetLinks.length} 个磁力链接`);
    }

    return { magnetLinks, fileNames };
  }

  // generateUniqueID 生成唯一ID
  private generateUniqueID(detailPath: string): string {
    // 从路径中提取ID，如 "/drama/4466.html" -> "4466"
    const re = /\/(?:drama|movie)\/(\d+)\.html/;
    const matches = detailPath.match(re);
    if (matches && matches.length > 1) {
      return `clxiong-${matches[1]}`;
    }

    // 备用方案：使用完整路径生成哈希
    let hash = 0;
    for (let i = 0; i < detailPath.length; i++) {
      const char = detailPath.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // 转换为32位整数
    }
    if (hash < 0) {
      hash = -hash;
    }
    return `clxiong-${hash}`;
  }

  // createSemaphore 创建信号量
  private createSemaphore(maxConcurrency: number): { acquire: () => Promise<void>; release: () => void } {
    let count = 0;
    const queue: (() => void)[] = [];

    return {
      acquire: async () => {
        if (count < maxConcurrency) {
          count++;
        } else {
          await new Promise(resolve => queue.push(resolve));
        }
      },
      release: () => {
        count--;
        if (queue.length > 0) {
          queue.shift()?.();
        }
      }
    };
  }

  // sleep 等待指定时间
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // filterResultsByKeyword 关键词过滤
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
const plugin = new ClxiongPlugin();
export default plugin;