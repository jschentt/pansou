import { SearchResult, Link, PluginSearchResult } from '../../models/plugin-result';
import { BaseAsyncPlugin } from '../plugin.manager';
import axios, { AxiosInstance, AxiosResponse } from 'axios';
import * as cheerio from 'cheerio';
import * as crypto from 'crypto';

// 常量定义
const PluginName = 'xys';
const DisplayName = '小云搜索';
const Description = '小云搜索 - 阿里云盘、夸克网盘、百度网盘等多网盘搜索引擎';
const BaseURL = 'https://www.yunso.net';
const TokenPath = '/index/user/s';
const SearchPath = '/api/validate/searchX2';
const UserAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36';
const MaxResults = 50;
const CacheTTL = 30 * 60 * 1000; // token缓存30分钟

// Token缓存结构
interface TokenCache {
  Token: string;
  Timestamp: Date;
}

// API响应结构
interface SearchResponse {
  code: number;
  msg: string;
  time: string;
  data: string;
}

class XysPlugin extends BaseAsyncPlugin {
  private debugMode: boolean;
  private tokenCache: Map<string, TokenCache>;
  private cacheTTL: number;

  constructor() {
    super(PluginName, 3); // 标准网盘插件，启用Service层过滤
    this.debugMode = false; // 生产环境关闭调试
    this.tokenCache = new Map<string, TokenCache>();
    this.cacheTTL = CacheTTL;
  }

  public Name(): string {
    return PluginName;
  }

  public DisplayName(): string {
    return DisplayName;
  }

  public Description(): string {
    return Description;
  }

  public async Search(keyword: string, ext: Record<string, any>): Promise<SearchResult[]> {
    const client = axios.create({
      timeout: 30000,
      headers: {
        'User-Agent': UserAgent,
      },
    });
    return this.searchImpl(client, keyword, ext);
  }

  public async SearchWithResult(keyword: string, ext: Record<string, any>): Promise<PluginSearchResult> {
    return this.AsyncSearchWithResult(keyword, this.searchImpl.bind(this), this.MainCacheKey, ext);
  }

  private async searchImpl(client: AxiosInstance, keyword: string, ext: Record<string, any>): Promise<SearchResult[]> {
    if (this.debugMode) {
      console.log(`[XYS] 开始搜索: ${keyword}`);
    }

    // 第一步：获取token
    const token = await this.getToken(client, keyword);
    
    if (this.debugMode) {
      console.log(`[XYS] 获取到token: ${token.substring(0, 10)}...`);
    }

    // 第二步：执行搜索
    const results = await this.executeSearch(client, token, keyword);
    
    if (this.debugMode) {
      console.log(`[XYS] 搜索完成，获取到 ${results.length} 个结果`);
    }

    return results;
  }

  private async getToken(client: AxiosInstance, keyword: string): Promise<string> {
    // 检查缓存
    const cacheKey = 'token';
    const cached = this.tokenCache.get(cacheKey);
    if (cached) {
      // 检查是否过期
      if (Date.now() - cached.Timestamp.getTime() < this.cacheTTL) {
        if (this.debugMode) {
          console.log('[XYS] 使用缓存的token');
        }
        return cached.Token;
      }
    }

    // 构建请求URL
    const tokenURL = `${BaseURL}${TokenPath}?wd=${encodeURIComponent(keyword)}&mode=undefined&stype=undefined`;

    try {
      const resp = await this.doRequestWithRetry(client, {
        method: 'GET',
        url: tokenURL,
        headers: {
          'User-Agent': UserAgent,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
          'Connection': 'keep-alive',
          'Upgrade-Insecure-Requests': '1',
          'Cache-Control': 'max-age=0',
          'Referer': `${BaseURL}/`,
        },
      });

      if (resp.status !== 200) {
        throw new Error(`[${this.Name()}] token请求HTTP状态错误: ${resp.status}`);
      }

      // 解析HTML提取token
      const $ = cheerio.load(resp.data);
      let token = '';

      $('script').each((i, s) => {
        const scriptContent = $(s).text();
        if (scriptContent.includes('DToken')) {
          // 使用正则表达式提取token
          const re = /const\s+DToken\s*=\s*"([^"]+)"/;
          const matches = re.exec(scriptContent);
          if (matches && matches.length > 1) {
            token = matches[1];
            if (this.debugMode) {
              console.log(`[XYS] 从script中提取到token: ${token.substring(0, 10)}...`);
            }
          }
        }
      });

      if (token === '') {
        throw new Error('未找到DToken');
      }

      // 缓存token
      this.tokenCache.set(cacheKey, {
        Token: token,
        Timestamp: new Date(),
      });

      return token;
    } catch (error) {
      throw new Error(`[${this.Name()}] 获取token失败: ${error}`);
    }
  }

  private async doRequestWithRetry(client: AxiosInstance, config: any): Promise<AxiosResponse> {
    const maxRetries = 3;
    let lastError: any = null;

    for (let i = 0; i < maxRetries; i++) {
      if (i > 0) {
        // 指数退避重试
        const backoff = Math.pow(2, i - 1) * 200;
        await new Promise(resolve => setTimeout(resolve, backoff));
      }

      try {
        const resp = await client(config);
        if (resp.status === 200) {
          return resp;
        }
      } catch (error) {
        lastError = error;
      }
    }

    throw new Error(`[${this.Name()}] 重试 ${maxRetries} 次后仍然失败: ${lastError}`);
  }

  private async executeSearch(client: AxiosInstance, token: string, keyword: string): Promise<SearchResult[]> {
    // 构建搜索URL
    const searchURL = `${BaseURL}${SearchPath}?DToken2=${token}&requestID=undefined&mode=90002&stype=undefined&scope_content=0&wd=${encodeURIComponent(keyword)}&uk=&page=1&limit=20&screen_filetype=`;

    try {
      const resp = await this.doRequestWithRetry(client, {
        method: 'POST',
        url: searchURL,
        headers: {
          'User-Agent': UserAgent,
          'Accept': 'application/json, text/plain, */*',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
          'Connection': 'keep-alive',
          'Content-Type': 'application/x-www-form-urlencoded',
          'Referer': `${BaseURL}/`,
          'Origin': BaseURL,
          'X-Requested-With': 'XMLHttpRequest',
        },
      });

      if (resp.status !== 200) {
        throw new Error(`[${this.Name()}] 搜索请求HTTP状态错误: ${resp.status}`);
      }

      const searchResp = resp.data as SearchResponse;

      if (searchResp.code !== 0) {
        throw new Error(`[${this.Name()}] 搜索API返回错误: ${searchResp.msg}`);
      }

      if (this.debugMode) {
        console.log(`[XYS] 搜索API响应成功，data长度: ${searchResp.data.length}`);
      }

      // 解析HTML内容
      return this.parseSearchResults(searchResp.data, keyword);
    } catch (error) {
      throw new Error(`[${this.Name()}] 执行搜索失败: ${error}`);
    }
  }

  private async parseSearchResults(htmlData: string, keyword: string): Promise<SearchResult[]> {
    const $ = cheerio.load(htmlData);
    const results: SearchResult[] = [];

    // 查找搜索结果项
    $('.layui-card[data-qid]').each((i, s) => {
      if (results.length >= MaxResults) {
        return false;
      }

      const result = this.parseResultItem($(s), i + 1);
      if (result) {
        results.push(result);
      }

      return true;
    });

    if (this.debugMode) {
      console.log(`[XYS] 解析到 ${results.length} 个原始结果`);
    }

    // 关键词过滤（标准网盘插件需要过滤）
    const filteredResults = this.FilterResultsByKeyword(results, keyword);
    
    if (this.debugMode) {
      console.log(`[XYS] 关键词过滤后剩余 ${filteredResults.length} 个结果`);
    }

    return filteredResults;
  }

  private parseResultItem(s: cheerio.Cheerio, index: number): SearchResult | null {
    // 提取QID
    const qid = s.attr('data-qid');
    if (!qid) {
      return null;
    }

    // 提取标题和链接
    const linkEl = s.find(`a[onclick="open_sid(this)"]`);
    if (linkEl.length === 0) {
      return null;
    }

    // 提取标题
    const title = this.cleanTitle(linkEl.text());
    if (title === '') {
      return null;
    }

    // 提取链接URL
    let href = linkEl.attr('href') || '';
    if (href === '') {
      // 尝试从url属性解码
      const urlAttr = linkEl.attr('url');
      if (urlAttr) {
        try {
          href = Buffer.from(urlAttr, 'base64').toString('utf8');
        } catch {
          // 解码失败，保持空字符串
        }
      }
    }

    if (href === '') {
      if (this.debugMode) {
        console.log(`[XYS] 跳过无链接的结果: ${title}`);
      }
      return null;
    }

    // 提取密码
    const password = linkEl.attr('pa') || '';

    // 提取时间
    const timeStr = s.find('.layui-icon-time').parent().text().trim();
    const publishTime = this.parseTime(timeStr);

    // 提取网盘类型
    const platform = this.extractPlatform(s, href);

    // 构建链接对象
    const link: Link = {
      Type: platform,
      URL: href,
      Password: password,
    };

    // 构建结果对象
    const result: SearchResult = {
      Title: title,
      Content: `来源：${platform}`,
      Channel: '', // 插件搜索结果必须为空字符串（按开发指南要求）
      MessageID: `${this.Name()}-${qid}-${index}`,
      UniqueID: `${this.Name()}-${qid}-${index}`,
      Datetime: publishTime,
      Links: [link],
      Tags: [platform],
    };

    if (this.debugMode) {
      console.log(`[XYS] 解析结果: ${title} (${platform})`);
    }

    return result;
  }

  private cleanTitle(title: string): string {
    if (title === '') {
      return '';
    }

    // 移除HTML标签
    const re = /<[^>]*>/g;
    let cleaned = title.replace(re, '');

    // 移除@符号
    cleaned = cleaned.replace(/@/g, '');

    // 清理多余的空格
    cleaned = cleaned.trim();
    cleaned = cleaned.replace(/\s+/g, ' ');

    return cleaned;
  }

  private parseTime(timeStr: string): Date {
    // 清理时间字符串，移除图标等
    const trimmed = timeStr.trim();
    
    // 查找时间格式 YYYY-MM-DD HH:MM:SS
    const re = /(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})/;
    const matches = re.exec(trimmed);
    
    if (matches && matches.length > 1) {
      const date = new Date(matches[1]);
      if (!isNaN(date.getTime())) {
        return date;
      }
    }
    
    // 如果解析失败，返回当前时间
    return new Date();
  }

  private extractPlatform(s: cheerio.Cheerio, href: string): string {
    return this.determineCloudType(href);
  }

  private determineCloudType(url: string): string {
    switch (true) {
      case url.includes('pan.quark.cn'):
        return 'quark';
      case url.includes('drive.uc.cn'):
        return 'uc';
      case url.includes('pan.baidu.com'):
        return 'baidu';
      case url.includes('aliyundrive.com') || url.includes('alipan.com'):
        return 'aliyun';
      case url.includes('pan.xunlei.com'):
        return 'xunlei';
      case url.includes('cloud.189.cn'):
        return 'tianyi';
      case url.includes('caiyun.139.com'):
        return 'mobile';
      case url.includes('magnet:'):
        return 'magnet';
      case url.includes('ed2k://'):
        return 'ed2k';
      default:
        return 'others';
    }
  }
}

// 注册插件
BaseAsyncPlugin.RegisterGlobalPlugin(new XysPlugin());
