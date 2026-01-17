import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import * as cheerio from 'cheerio';
import { SearchResult, Link, PluginSearchResult } from '../../../model';
import { FilterResultsByKeyword } from '../../../util/plugin.util';

// 常量定义
const BaseURL = 'https://btnull.pro';
const SearchPath = '/search/-------------.html';

// 默认参数
const MaxRetries = 3;
const TimeoutSeconds = 30;

// 用户代理列表
const userAgents = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/92.0.4515.107 Safari/537.36',
];

// PiankuPlugin 片库网搜索插件
export class PiankuPlugin {
  private client: AxiosInstance;
  private MainCacheKey: string;
  private name: string;

  constructor() {
    this.client = axios.create({
      timeout: TimeoutSeconds * 1000,
      headers: {
        'User-Agent': userAgents[0],
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Connection': 'keep-alive',
        'Referer': BaseURL + '/',
      },
      httpsAgent: new (require('https').Agent)({
        rejectUnauthorized: false
      })
    });

    this.MainCacheKey = 'pianku';
    this.name = 'pianku';
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
    return this.AsyncSearchWithResult(keyword, this.searchImpl.bind(this), this.MainCacheKey, ext);
  }

  // AsyncSearchWithResult 异步搜索实现
  private async AsyncSearchWithResult(keyword: string, searchImpl: (client: AxiosInstance, keyword: string, ext: Record<string, any>) => Promise<SearchResult[]>, cacheKey: string, ext: Record<string, any>): Promise<PluginSearchResult> {
    // 这里实现异步搜索逻辑，暂时直接调用searchImpl
    const results = await searchImpl(this.client, keyword, ext);
    return {
      Results: results,
      IsFinal: true,
      CacheKey: cacheKey
    };
  }

  // searchImpl 实际的搜索实现
  private async searchImpl(client: AxiosInstance, keyword: string, ext: Record<string, any>): Promise<SearchResult[]> {
    // 处理扩展参数
    let searchKeyword = keyword;
    if (ext && ext['title_en'] && typeof ext['title_en'] === 'string' && ext['title_en'] !== '') {
      searchKeyword = ext['title_en'];
    }

    // 构建请求URL
    const searchURL = `${BaseURL}${SearchPath}?wd=${encodeURIComponent(searchKeyword)}`;

    // 创建请求配置
    const config: AxiosRequestConfig = {
      url: searchURL,
      method: 'GET',
      timeout: TimeoutSeconds * 1000
    };

    // 设置请求头
    this.setRequestHeaders(config);

    // 发送HTTP请求（带重试机制）
    let response;
    try {
      response = await this.doRequestWithRetry(config, client);
    } catch (err) {
      throw new Error(`[${this.Name()}] 搜索请求失败: ${err}`);
    }

    // 解析HTML
    const $ = cheerio.load(response.data);

    // 提取搜索结果基本信息
    const searchResults = this.extractSearchResults($);

    // 为每个搜索结果获取详情页的下载链接
    const finalResults: SearchResult[] = [];
    for (const result of searchResults) {
      // 获取详情页链接
      if (result.Links.length === 0) {
        continue;
      }
      const detailURL = result.Links[0].URL;

      // 请求详情页并解析下载链接
      try {
        const downloadLinks = await this.fetchDetailPageLinks(client, detailURL);
        // 更新结果的链接为真正的下载链接
        if (downloadLinks.length > 0) {
          result.Links = downloadLinks;
          finalResults.push(result);
        }
      } catch (err) {
        // 如果获取详情页失败，仍然保留原始结果
        finalResults.push(result);
      }
    }

    // 关键词过滤
    return FilterResultsByKeyword(finalResults, searchKeyword);
  }

  // setRequestHeaders 设置请求头
  private setRequestHeaders(config: AxiosRequestConfig): void {
    if (!config.headers) {
      config.headers = {};
    }
    config.headers['User-Agent'] = userAgents[0];
    config.headers['Accept'] = 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8';
    config.headers['Accept-Language'] = 'zh-CN,zh;q=0.9,en;q=0.8';
    config.headers['Connection'] = 'keep-alive';
    config.headers['Referer'] = BaseURL + '/';
  }

  // doRequestWithRetry 带重试机制的HTTP请求
  private async doRequestWithRetry(config: AxiosRequestConfig, client: AxiosInstance): Promise<any> {
    let lastErr: Error | null = null;

    for (let i = 0; i < MaxRetries; i++) {
      if (i > 0) {
        // 指数退避重试
        const backoff = Math.min(200 * Math.pow(2, i - 1), 10000); // 最大10秒
        await new Promise(resolve => setTimeout(resolve, backoff));
      }

      try {
        const response = await client.request(config);
        if (response.status === 200) {
          return response;
        }
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error(String(err));
      }
    }

    throw new Error(`重试 ${MaxRetries} 次后仍然失败: ${lastErr?.message}`);
  }

  // extractSearchResults 提取搜索结果
  private extractSearchResults($: cheerio.CheerioAPI): SearchResult[] {
    const results: SearchResult[] = [];

    // 查找搜索结果容器
    $('.sr_lists dl').each((i, element) => {
      const result = this.extractSingleResult($, $(element));
      if (result.UniqueID !== '' && result.Links.length > 0) {
        results.push(result);
      }
    });

    return results;
  }

  // extractSingleResult 提取单个搜索结果
  private extractSingleResult($: cheerio.CheerioAPI, s: cheerio.Cheerio): SearchResult {
    // 提取链接和ID
    const link = s.find('dt a').attr('href');
    if (!link) {
      return this.emptySearchResult();
    }

    // 提取电影ID
    const movieID = this.extractMovieID(link);
    if (!movieID) {
      return this.emptySearchResult();
    }

    // 提取封面图片（暂时不使用，但保留用于未来扩展）
    const _ = s.find('dt a img').attr('src');

    // 提取标题
    let title = s.find('dd p:first-child strong a').text().trim();
    if (!title) {
      return this.emptySearchResult();
    }

    // 提取状态标签
    const status = s.find('dd p:first-child span.ss1').text().trim();

    // 解析详细信息
    let actors = '';
    let description = '';
    let region = '';
    let types = '';
    let altName = '';

    s.find('dd p').each((j, pElement) => {
      const text = $(pElement).text().trim();

      if (text.startsWith('又名：')) {
        altName = text.substring(3);
      } else if (text.includes('地区：') && text.includes('类型：')) {
        // 解析地区和类型
        const [r, t] = this.parseRegionAndTypes(text);
        region = r;
        types = t;
      } else if (text.startsWith('主演：')) {
        actors = text.substring(3);
      } else if (text.startsWith('简介：')) {
        description = text.substring(3);
      } else if (!text.includes('名称：') && !text.includes('又名：') &&
        !text.includes('地区：') && !text.includes('主演：') && text !== '') {
        // 可能是简介（没有"简介："前缀的情况）
        if (!description && text.length > 10) {
          description = text;
        }
      }
    });

    // 构建完整的详情页URL
    const fullLink = this.buildFullURL(link);

    // 构建标签
    const tags: string[] = [];
    if (region) {
      tags.push(region);
    }
    if (types) {
      // 分割类型标签
      const typeList = types.split(',').map(t => t.trim()).filter(t => t !== '');
      tags.push(...typeList);
    }
    if (status) {
      tags.push(status);
    }

    // 构建内容描述
    let content = description;
    if (actors && content) {
      content = `主演：${actors}\n${content}`;
    } else if (actors) {
      content = `主演：${actors}`;
    }

    if (altName) {
      if (content) {
        content = `又名：${altName}\n${content}`;
      } else {
        content = `又名：${altName}`;
      }
    }

    // 创建链接（使用详情页作为主要链接）
    const links: Link[] = [
      {
        Type: 'others', // 详情页链接
        URL: fullLink,
      },
    ];

    const result: SearchResult = {
      UniqueID: `${this.Name()}-${movieID}`,
      Title: title,
      Content: content,
      Datetime: new Date(), // 无法从搜索结果获取准确时间，使用当前时间
      Tags: tags,
      Links: links,
      Channel: '', // 插件搜索结果必须为空字符串
    };

    return result;
  }

  // emptySearchResult 返回空搜索结果
  private emptySearchResult(): SearchResult {
    return {
      UniqueID: '',
      Title: '',
      Content: '',
      Datetime: new Date(),
      Tags: [],
      Links: [],
      Channel: '',
    };
  }

  // extractMovieID 从URL中提取电影ID
  private extractMovieID(url: string): string {
    const movieIDRegex = /\/movie\/(\d+)\.html/;
    const matches = url.match(movieIDRegex);
    if (matches && matches.length > 1) {
      return matches[1];
    }
    return '';
  }

  // parseRegionAndTypes 解析地区和类型信息
  private parseRegionAndTypes(text: string): [string, string] {
    const regionTypeRegex = /地区：([^　]*?)　+类型：(.*)/;
    const matches = text.match(regionTypeRegex);
    if (matches && matches.length > 2) {
      return [matches[1].trim(), matches[2].trim()];
    }
    return ['', ''];
  }

  // buildFullURL 构建完整的URL
  private buildFullURL(path: string): string {
    if (path.startsWith('http')) {
      return path;
    }
    return BaseURL + path;
  }

  // fetchDetailPageLinks 获取详情页的下载链接
  private async fetchDetailPageLinks(client: AxiosInstance, detailURL: string): Promise<Link[]> {
    // 创建请求配置
    const config: AxiosRequestConfig = {
      url: detailURL,
      method: 'GET',
      timeout: TimeoutSeconds * 1000
    };

    // 设置请求头
    this.setRequestHeaders(config);

    // 发送HTTP请求
    let response;
    try {
      response = await this.doRequestWithRetry(config, client);
    } catch (err) {
      throw new Error(`详情页请求失败: ${err}`);
    }

    // 解析HTML
    const $ = cheerio.load(response.data);

    // 提取下载链接
    return this.extractDownloadLinks($);
  }

  // extractDownloadLinks 提取详情页中的下载链接
  private extractDownloadLinks($: cheerio.CheerioAPI): Link[] {
    const links: Link[] = [];
    const seenURLs = new Set<string>(); // 用于去重

    // 查找下载链接区域
    $('#donLink .down-list2').each((i, element) => {
      const s = $(element);
      const linkURL = s.find('.down-list3 a').attr('href');
      if (!linkURL) {
        return;
      }

      // 获取链接标题
      let title = s.find('.down-list3 a').text().trim();
      if (!title) {
        return;
      }

      // 验证链接有效性
      if (!this.isValidLink(linkURL)) {
        return;
      }

      // 去重检查
      if (seenURLs.has(linkURL)) {
        return;
      }
      seenURLs.add(linkURL);

      // 判断链接类型
      const linkType = this.determineLinkType(linkURL);

      // 提取密码
      const password = this.extractPassword(linkURL, title);

      // 创建链接对象
      const link: Link = {
        Type: linkType,
        URL: linkURL,
        Password: password,
      };

      links.push(link);
    });

    return links;
  }

  // isValidLink 验证链接是否有效
  private isValidLink(url: string): boolean {
    // 检查是否为磁力链接
    const magnetLinkRegex = /magnet:\?xt=urn:btih:[0-9a-fA-F]{40}[^"'\s]*/;
    if (magnetLinkRegex.test(url)) {
      return true;
    }

    // 检查是否为ED2K链接
    const ed2kLinkRegex = /ed2k:\/\/\|file\|[^|]+\|[^|]+\|[^|]+\|\/?/;
    if (ed2kLinkRegex.test(url)) {
      return true;
    }

    // 检查是否为有效的网盘链接
    const panLinkRegexes = this.getPanLinkRegexes();
    for (const regex of Object.values(panLinkRegexes)) {
      if (regex.test(url)) {
        return true;
      }
    }

    // 如果都不匹配，则不是有效链接
    return false;
  }

  // determineLinkType 判断链接类型
  private determineLinkType(url: string): string {
    // 检查磁力链接
    const magnetLinkRegex = /magnet:\?xt=urn:btih:[0-9a-fA-F]{40}[^"'\s]*/;
    if (magnetLinkRegex.test(url)) {
      return 'magnet';
    }

    // 检查ED2K链接
    const ed2kLinkRegex = /ed2k:\/\/\|file\|[^|]+\|[^|]+\|[^|]+\|\/?/;
    if (ed2kLinkRegex.test(url)) {
      return 'ed2k';
    }

    // 检查网盘链接
    const panLinkRegexes = this.getPanLinkRegexes();
    for (const [panType, regex] of Object.entries(panLinkRegexes)) {
      if (regex.test(url)) {
        return panType;
      }
    }

    return 'others';
  }

  // extractPassword 提取密码
  private extractPassword(url: string, title: string): string {
    // 密码提取正则表达式
    const passwordRegexes = [
      /[?&]pwd=([0-9a-zA-Z]+)/,                        // URL中的pwd参数
      /[?&]password=([0-9a-zA-Z]+)/,                   // URL中的password参数
      /提取码[：:]\s*([0-9a-zA-Z]+)/,                    // 提取码：xxxx
      /访问码[：:]\s*([0-9a-zA-Z]+)/,                    // 访问码：xxxx
      /密码[：:]\s*([0-9a-zA-Z]+)/,                     // 密码：xxxx
      /验证码[：:]\s*([0-9a-zA-Z]+)/,                    // 验证码：xxxx
      /口令[：:]\s*([0-9a-zA-Z]+)/,                     // 口令：xxxx
      /（访问码[：:]\s*([0-9a-zA-Z]+)）/,                  // （访问码：xxxx）
    ];

    // 首先从链接URL中提取密码
    for (const regex of passwordRegexes) {
      const matches = url.match(regex);
      if (matches && matches.length > 1) {
        return matches[1];
      }
    }

    // 然后从标题文本中提取密码
    for (const regex of passwordRegexes) {
      const matches = title.match(regex);
      if (matches && matches.length > 1) {
        return matches[1];
      }
    }

    return '';
  }

  // getPanLinkRegexes 获取网盘链接正则表达式
  private getPanLinkRegexes(): Record<string, RegExp> {
    return {
      'baidu':   /https?:\/\/pan\.baidu\.com\/s\/[0-9a-zA-Z_-]+(?:\?pwd=[0-9a-zA-Z]+)?(?:&v=\d+)?/,
      'aliyun':  /https?:\/\/(?:www\.)?alipan\.com\/s\/[0-9a-zA-Z_-]+/,
      'tianyi':  /https?:\/\/cloud\.189\.cn\/t\/[0-9a-zA-Z_-]+(?:\([^)]*\))?/,
      'uc':      /https?:\/\/drive\.uc\.cn\/s\/[0-9a-fA-F]+(?:\?[^"]*)?/,
      'mobile':  /https?:\/\/caiyun\.139\.com\/[^"]*/,
      '115':     /https?:\/\/(?:115\.com|115cdn\.com)\/s\/[0-9a-zA-Z_-]+(?:\?[^"]*)?/,
      'pikpak':  /https?:\/\/mypikpak\.com\/s\/[0-9a-zA-Z_-]+/,
      'xunlei':  /https?:\/\/pan\.xunlei\.com\/s\/[0-9a-zA-Z_-]+(?:\?pwd=[0-9a-zA-Z]+)?/,
      '123':     /https?:\/\/(?:www\.)?(?:123pan\.com|123684\.com)\/s\/[0-9a-zA-Z_-]+(?:\?[^"]*)?/,
      'quark':   /https?:\/\/pan\.quark\.cn\/s\/[0-9a-fA-F]+(?:\?pwd=[0-9a-zA-Z]+)?/,
    };
  }
}

// 创建并导出插件实例
export default new PiankuPlugin();