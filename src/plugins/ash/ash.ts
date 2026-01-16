import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import { SearchResult, Link } from '../../types';
import { Plugin } from '../../types/plugin';


// 常量定义
const wrongQuarkDomain = "pan.qualk.cn";
const correctQuarkDomain = "pan.quark.cn";

// 预编译的正则表达式
const jsonDataRegex = /var jsonData = '(\[.*?\])';/;
const controlCharRegex = /[\x00-\x1F\x7F]/g;

// AshResult 表示ASH搜索结果的数据结构
interface AshResult {
  id: number;
  source_category_id: number;
  title: string;
  is_type: number;
  code: any; // 可能是null或string
  url: string;
  is_time: number;
  name: string;
  times: string;
  category: any; // 可能是null或string
}

const pluginName = 'ash';
const defaultPriority = 2;
const searchTimeout = 15000; // 15 seconds
const maxRetries = 2;

class AshPlugin implements Plugin {
  private client: AxiosInstance;

  constructor() {
    this.client = axios.create({
      timeout: searchTimeout,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      }
    });
  }

  name(): string {
    return pluginName;
  }

  displayName(): string {
    return 'ash';
  }

  description(): string {
    return 'ash - 网盘资源搜索';
  }

  async search(keyword: string, ext: Record<string, any>): Promise<SearchResult[]> {
    return this.searchImpl(keyword, ext);
  }

  private async searchImpl(keyword: string, ext: Record<string, any>): Promise<SearchResult[]> {
    const startTime = Date.now();

    try {
      // 构建搜索URL
      const searchURL = `https://so.allsharehub.com/s/${encodeURIComponent(keyword)}.html`;

      // 发送请求（带重试机制）
      const config: AxiosRequestConfig = {
        method: 'GET',
        url: searchURL,
        headers: this.setRequestHeaders()
      };

      const resp = await this.doRequestWithRetry(config);

      // 从HTML中提取搜索结果
      const results = await this.extractResultsFromBytes(resp.data);

      // 关键词过滤
      const filtered = this.filterResultsByKeyword(results, keyword);

      console.log(`[${this.name()}] 搜索结果: ${filtered.length} 条`);
      console.log(`[${this.name()}] 搜索耗时: ${Date.now() - startTime}ms`);

      return filtered;
    } catch (error) {
      console.error(`[${this.name()}] 搜索失败:`, error);
      return [];
    }
  }

  private async extractResultsFromBytes(data: string): Promise<SearchResult[]> {
    // 查找JSON数据
    const matches = jsonDataRegex.exec(data);
    if (!matches || matches.length < 2) {
      return []; // 没有找到数据，返回空结果
    }

    // 提取JSON字符串
    let jsonStr = matches[1];

    // 清理JSON字符串
    if (jsonStr.includes('\\/')) {
      jsonStr = jsonStr.replace(/\\\//g, '/');
    }
    jsonStr = jsonStr.replace(controlCharRegex, '');

    // 解析JSON
    let ashResults: AshResult[];
    try {
      ashResults = JSON.parse(jsonStr);
    } catch (error) {
      console.error(`[${this.name()}] JSON解析失败:`, error);
      return [];
    }

    // 如果没有结果，直接返回
    if (!ashResults || ashResults.length === 0) {
      return [];
    }

    // 处理所有结果
    const results: SearchResult[] = [];

    for (const item of ashResults) {
      // 检查URL是否有效
      if (!item.url) {
        continue;
      }

      // 处理网盘链接
      const panURL = this.fixPanURL(item.url);
      if (!panURL) {
        continue;
      }

      // 确定网盘类型
      const panType = this.determinePanType(item.is_type);

      // 处理提取码
      const password = this.extractPassword(item.code);

      // 解析时间
      const datetime = this.parsePublishTime(item.times);

      // 获取标签
      const tags = this.extractTags(item.source_category_id);

      // 构建搜索结果
      results.push({
        uniqueId: `${this.name()}-${item.id}`,
        title: item.title,
        content: item.name,
        datetime: datetime,
        channel: '',
        links: [{
          type: panType,
          url: panURL,
          password: password
        }],
        tags: tags,
        images: [],
        pluginName: this.name(),
        displayName: this.displayName()
      });
    }

    return results;
  }

  private fixPanURL(url: string): string {
    // 快速检查是否为有效的HTTP/HTTPS链接
    if (url.length < 8) { // 最短的URL: http://a
      return '';
    }

    // 验证链接协议
    if (url[0] !== 'h' || (url[4] !== ':' && url[5] !== ':')) {
      return '';
    }

    // 只在包含错误域名时才进行替换
    if (url.includes(wrongQuarkDomain)) {
      return url.replace(wrongQuarkDomain, correctQuarkDomain);
    }

    return url;
  }

  private determinePanType(isType: number): string {
    switch (isType) {
      case 0:
        return 'quark';
      case 2:
        return 'baidu';
      case 3:
        return 'uc';
      case 4:
        return 'xunlei';
      default:
        return 'quark';
    }
  }

  private extractPassword(code: any): string {
    if (code && typeof code === 'string') {
      return code.trim();
    }
    return '';
  }

  private parsePublishTime(times: string): Date {
    if (!times) {
      return new Date();
    }

    // 尝试解析日期
    const date = new Date(times);
    if (!isNaN(date.getTime())) {
      return date;
    }

    // 默认返回当前时间
    return new Date();
  }

  private extractTags(sourceCategoryId: number): string[] {
    const tags: string[] = [];
    const categoryNames = ["短剧", "电影", "电视剧", "动漫", "综艺", "充电视频"];

    if (sourceCategoryId > 0 && sourceCategoryId <= categoryNames.length) {
      tags.push(categoryNames[sourceCategoryId - 1]);
    }

    return tags;
  }

  private setRequestHeaders(): Record<string, string> {
    return {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'Connection': 'keep-alive',
      'Upgrade-Insecure-Requests': '1',
      'Cache-Control': 'max-age=0',
      'Referer': 'https://so.allsharehub.com/'
    };
  }

  private async doRequestWithRetry(config: AxiosRequestConfig): Promise<any> {
    let lastErr: any;

    for (let i = 0; i < maxRetries; i++) {
      if (i > 0) {
        // 更短的退避时间
        const backoff = 100 * Math.pow(2, i - 1);
        await this.sleep(backoff);
      }

      try {
        const resp = await this.client(config);
        if (resp.status === 200) {
          return resp;
        }
      } catch (error) {
        lastErr = error;
      }
    }

    if (lastErr) {
      throw new Error(`重试 ${maxRetries} 次后仍然失败: ${lastErr}`);
    }

    throw new Error(`重试 ${maxRetries} 次后仍然失败`);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
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
const plugin = new AshPlugin();
export default plugin;