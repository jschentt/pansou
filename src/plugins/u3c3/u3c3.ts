import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import * as cheerio from 'cheerio';
import { SearchResult, Link, PluginSearchResult } from '../../../model';
import { FilterResultsByKeyword } from '../../../util/plugin.util';

// 常量定义
const BaseURL = 'https://u3c3u3c3.u3c3u3c3u3c3.com';
const UserAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36';
const MaxRetries = 3;
const RetryDelay = 2000; // 重试延迟：2秒
const CacheDuration = 3600000; // search2参数缓存时长：1小时

// U3c3Plugin U3C3插件
class U3c3Plugin {
  private debugMode: boolean;
  private search2: string; // 缓存的search2参数
  private lastSync: Date;
  private name: string;

  constructor() {
    this.debugMode = false;
    this.search2 = '';
    this.lastSync = new Date(0); // 初始化为0时间
    this.name = 'u3c3';
  }

  // Name 返回插件名称
  Name(): string {
    return this.name;
  }

  // Search 执行搜索并返回结果（兼容性方法）
  async Search(keyword: string, ext: Record<string, any>): Promise<SearchResult[]> {
    const result = await this.SearchWithResult(keyword, ext);
    return result.Results;
  }

  // SearchWithResult 执行搜索并返回包含IsFinal标记的结果
  async SearchWithResult(keyword: string, ext: Record<string, any>): Promise<PluginSearchResult> {
    if (this.debugMode) {
      console.log(`[U3C3] 开始搜索: ${keyword}`);
    }

    // 第一步：获取search2参数
    const search2 = await this.getSearch2Parameter();
    if (this.debugMode) {
      console.log(`[U3C3] 使用search2参数: ${search2}`);
    }

    // 第二步：执行搜索
    const results = await this.doSearch(keyword, search2);

    if (this.debugMode) {
      console.log(`[U3C3] 搜索完成，获得 ${results.length} 个结果`);
    }

    // 应用关键词过滤
    const filteredResults = FilterResultsByKeyword(results, keyword);

    return {
      Results: filteredResults,
      IsFinal: true,
      CacheKey: this.name,
      Timestamp: Date.now(),
      Source: this.name,
      Message: `找到 ${filteredResults.length} 个结果`
    };
  }

  // getSearch2Parameter 获取search2参数
  private async getSearch2Parameter(): Promise<string> {
    // 如果缓存有效（1小时内），直接返回
    if (this.search2 !== '' && Date.now() - this.lastSync.getTime() < CacheDuration) {
      return this.search2;
    }

    if (this.debugMode) {
      console.log('[U3C3] 正在获取search2参数...');
    }

    const client = axios.create({
      timeout: 30000, // 30秒超时
      headers: {
        'User-Agent': UserAgent,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
      },
      httpsAgent: new (require('https').Agent)({
        rejectUnauthorized: false
      })
    });

    const requestConfig: AxiosRequestConfig = {
      method: 'GET',
      url: BaseURL
    };

    let response;
    try {
      response = await this.doRequestWithRetry(client, requestConfig);
    } catch (err) {
      throw new Error(`[${this.Name()}] 获取首页失败: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (response.status !== 200) {
      throw new Error(`[${this.Name()}] 获取首页返回状态码: ${response.status}`);
    }

    // 从JavaScript中提取search2参数
    const search2 = this.extractSearch2FromHTML(response.data);
    if (search2 === '') {
      throw new Error('[U3C3] 无法从首页提取search2参数');
    }

    // 缓存参数
    this.search2 = search2;
    this.lastSync = new Date();

    if (this.debugMode) {
      console.log(`[U3C3] 获取到search2参数: ${search2}`);
    }

    return search2;
  }

  // extractSearch2FromHTML 从HTML中提取search2参数
  private extractSearch2FromHTML(html: string): string {
    // 按行处理，排除注释行
    const lines = html.split('\n');
    for (const line of lines) {
      let trimmedLine = line.trim();
      
      // 跳过注释行
      if (trimmedLine.startsWith('//')) {
        continue;
      }
      
      // 查找包含nmefafej的行
      if (trimmedLine.includes('nmefafej') && trimmedLine.includes('"')) {
        // 使用正则提取引号内的值
        const re = /var\s+nmefafej\s*=\s*"([^"]+)"/;
        const matches = trimmedLine.match(re);
        if (matches && matches.length > 1 && matches[1].length > 5) {
          if (this.debugMode) {
            console.log(`[U3C3] 提取到search2参数: ${matches[1]} (来自行: ${trimmedLine})`);
          }
          return matches[1];
        }
        
        // 备用方案：直接提取引号内容
        const start = trimmedLine.indexOf('"');
        if (start !== -1) {
          const end = trimmedLine.indexOf('"', start + 1);
          if (end !== -1 && end > 5) {
            const candidate = trimmedLine.substring(start + 1, end);
            if (candidate.length > 5) {
              if (this.debugMode) {
                console.log(`[U3C3] 备用方案提取search2: ${candidate} (来自行: ${trimmedLine})`);
              }
              return candidate;
            }
          }
        }
      }
    }

    if (this.debugMode) {
      console.log('[U3C3] 未能找到search2参数');
    }
    return '';
  }

  // doSearch 执行搜索
  private async doSearch(keyword: string, search2: string): Promise<SearchResult[]> {
    // 构建搜索URL
    const encodedKeyword = encodeURIComponent(keyword);
    const searchURL = `${BaseURL}/?search2=${search2}&search=${encodedKeyword}`;

    if (this.debugMode) {
      console.log(`[U3C3] 搜索URL: ${searchURL}`);
    }

    const client = axios.create({
      timeout: 30000, // 30秒超时
      headers: {
        'User-Agent': UserAgent,
        'Referer': BaseURL + '/',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8'
      },
      httpsAgent: new (require('https').Agent)({
        rejectUnauthorized: false
      })
    });

    const requestConfig: AxiosRequestConfig = {
      method: 'GET',
      url: searchURL
    };

    let response;
    try {
      response = await this.doRequestWithRetry(client, requestConfig);
    } catch (err) {
      throw new Error(`[${this.Name()}] 搜索请求失败: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (response.status !== 200) {
      throw new Error(`[${this.Name()}] 搜索请求返回状态码: ${response.status}`);
    }

    return this.parseSearchResults(response.data);
  }

  // parseSearchResults 解析搜索结果
  private parseSearchResults(html: string): SearchResult[] {
    const $ = cheerio.load(html);
    const results: SearchResult[] = [];

    // 查找搜索结果表格行
    $('tbody tr.default').each((i, element) => {
      const s = $(element);

      // 跳过广告行（通常包含置顶标识）
      const titleCell = s.find('td:nth-child(2)');
      const titleText = titleCell.text();
      if (titleText.includes('[置顶]')) {
        return; // 跳过置顶广告
      }

      // 提取标题和详情链接
      const titleLink = titleCell.find('a');
      let title = titleLink.text().trim();
      if (title === '') {
        return; // 跳过空标题
      }

      // 清理标题中的HTML标签和特殊字符
      title = this.cleanTitle(title);

      // 提取详情页链接（可选，用于后续扩展）
      let detailURL = titleLink.attr('href') || '';
      if (detailURL !== '' && !detailURL.startsWith('http')) {
        detailURL = BaseURL + detailURL;
      }

      // 提取链接信息
      const linkCell = s.find('td:nth-child(3)');
      const links: Link[] = [];

      // 磁力链接
      linkCell.find('a[href^="magnet:"]').each((j, link) => {
        const href = $(link).attr('href');
        if (href && href !== '') {
          links.push({
            URL: href,
            Type: 'magnet',
            Password: '' // 磁力链接不需要密码
          });
        }
      });

      // 提取文件大小
      const sizeText = s.find('td:nth-child(4)').text().trim();

      // 提取上传时间
      const dateText = s.find('td:nth-child(5)').text().trim();

      // 提取分类
      const categoryText = s.find('td:nth-child(1) a').attr('title') || '';

      // 构建内容信息
      const contentParts: string[] = [];
      if (categoryText !== '') {
        contentParts.push(`分类: ${categoryText}`);
      }
      if (sizeText !== '') {
        contentParts.push(`大小: ${sizeText}`);
      }
      if (dateText !== '') {
        contentParts.push(`时间: ${dateText}`);
      }

      const content = contentParts.join(' | ');

      // 生成唯一ID
      const uniqueID = this.generateUniqueID(title, sizeText);

      const result: SearchResult = {
        Title: title,
        Content: content,
        Channel: '', // 插件搜索结果必须为空
        Tags: ['种子', '磁力链接'],
        Datetime: this.parseDateTime(dateText),
        Links: links,
        UniqueID: uniqueID,
        MessageID: uniqueID
      };

      results.push(result);
    });

    if (this.debugMode) {
      console.log(`[U3C3] 解析到 ${results.length} 个搜索结果`);
    }

    return results;
  }

  // cleanTitle 清理标题文本
  private cleanTitle(title: string): string {
    // 移除HTML标签
    title = title.replace(/<[^>]*>/g, '');
    // 移除多余的空白字符
    title = title.replace(/\s+/g, ' ');
    // 移除前后空白
    return title.trim();
  }

  // parseDateTime 解析日期时间
  private parseDateTime(dateStr: string): Date {
    if (dateStr === '') {
      return new Date(0); // 返回0时间
    }

    // 尝试解析常见的日期格式
    const formats: string[] = [
      'YYYY-MM-DD HH:mm:ss',
      'YYYY-MM-DD',
      'MM-DD HH:mm'
    ];

    // 使用正则表达式匹配和解析
    // 2006-01-02 15:04:05 格式
    const format1 = /^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})$/;
    const match1 = dateStr.match(format1);
    if (match1) {
      return new Date(
        parseInt(match1[1], 10),
        parseInt(match1[2], 10) - 1, // 月份是0-11
        parseInt(match1[3], 10),
        parseInt(match1[4], 10),
        parseInt(match1[5], 10),
        parseInt(match1[6], 10)
      );
    }

    // 2006-01-02 格式
    const format2 = /^(\d{4})-(\d{2})-(\d{2})$/;
    const match2 = dateStr.match(format2);
    if (match2) {
      return new Date(
        parseInt(match2[1], 10),
        parseInt(match2[2], 10) - 1,
        parseInt(match2[3], 10)
      );
    }

    // MM-DD HH:mm 格式
    const format3 = /^(\d{2})-(\d{2})\s+(\d{2}):(\d{2})$/;
    const match3 = dateStr.match(format3);
    if (match3) {
      const currentYear = new Date().getFullYear();
      return new Date(
        currentYear,
        parseInt(match3[1], 10) - 1,
        parseInt(match3[2], 10),
        parseInt(match3[3], 10),
        parseInt(match3[4], 10)
      );
    }

    // 如果解析失败，返回零值
    return new Date(0);
  }

  // generateUniqueID 生成唯一ID
  private generateUniqueID(title: string, size: string): string {
    // 使用插件名、标题和大小生成唯一ID
    const source = `${this.name}-${title}-${size}`;
    // 简单的哈希处理
    let hash = 0;
    for (let i = 0; i < source.length; i++) {
      const char = source.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // 转换为32位整数
    }
    // 确保哈希值为正数
    const positiveHash = hash < 0 ? -hash : hash;
    return `${this.name}-${positiveHash}`;
  }

  // doRequestWithRetry 带重试机制的HTTP请求
  private async doRequestWithRetry(client: AxiosInstance, config: AxiosRequestConfig, maxRetries: number = MaxRetries): Promise<any> {
    let lastErr: Error | null = null;

    for (let i = 0; i < maxRetries; i++) {
      if (i > 0) {
        // 等待重试延迟
        await new Promise(resolve => setTimeout(resolve, RetryDelay));
      }

      try {
        // 发送请求
        const response = await client.request(config);
        return response;
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error(String(err));
        if (this.debugMode) {
          console.log(`[U3C3] 请求失败 (${i+1}/${maxRetries}): ${lastErr.message}`);
        }
      }
    }

    throw lastErr || new Error(`重试 ${maxRetries} 次后仍然失败`);
  }
}

// 创建并导出插件实例
export default new U3c3Plugin();