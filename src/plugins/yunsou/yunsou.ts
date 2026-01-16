import { SearchResult, Link, PluginSearchResult } from '../../models/plugin-result';
import { BaseAsyncPlugin } from '../plugin.manager';
import axios, { AxiosInstance, AxiosResponse } from 'axios';

// 常量定义
const pluginName = 'yunsou';
const searchURLTemplate = 'https://yunsou.xyz/s/%s.html';
const defaultPriority = 2;
const defaultTimeout = 30000;
const maxRetries = 3;
const timeLayout = '2006-01-02';

// 预编译的正则表达式
const jsonDataRegex = /var jsonData = '(.+?)';/;
const pwdParamRegex = /[?&]pwd=([0-9a-zA-Z]+)/;
const controlCharsRegex = /[\x00-\x1F\x7F]/;

// YunsouCategory 分类信息
interface YunsouCategory {
  source_category_id: number;
  name: string;
}

// YunsouItem 单个搜索结果项
interface YunsouItem {
  id: number;
  source_category_id: number;
  title: string;
  is_type: number; // 0=夸克, 1=阿里, 2=百度, 3=UC, 4=迅雷
  code: string | null;
  url: string;
  is_time: number;
  name: string;
  times: string; // 发布时间 "2025-07-27"
  category: YunsouCategory;
}

class YunsouPlugin extends BaseAsyncPlugin {
  private client: AxiosInstance;

  constructor() {
    super(pluginName, defaultPriority);
    this.client = axios.create({
      timeout: defaultTimeout,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
        'Cache-Control': 'max-age=0',
        'Referer': 'https://yunsou.xyz/',
      },
    });
  }

  public async Search(keyword: string, ext: Record<string, any>): Promise<SearchResult[]> {
    const result = await this.SearchWithResult(keyword, ext);
    return result.Results;
  }

  public async SearchWithResult(keyword: string, ext: Record<string, any>): Promise<PluginSearchResult> {
    return this.AsyncSearchWithResult(keyword, this.searchImpl.bind(this), this.MainCacheKey, ext);
  }

  private async searchImpl(client: AxiosInstance, keyword: string, ext: Record<string, any>): Promise<SearchResult[]> {
    // 1. 构建搜索URL
    const searchURL = searchURLTemplate.replace('%s', encodeURIComponent(keyword));
    
    // 2. 发送请求（带重试机制）
    const resp = await this.doRequestWithRetry(this.client, searchURL);
    
    if (resp.status !== 200) {
      throw new Error(`[${this.Name()}] 搜索请求返回状态码: ${resp.status}`);
    }
    
    const htmlContent = resp.data;
    
    // 3. 提取JSON数据
    const jsonStr = await this.extractJSONData(htmlContent);
    
    // 4. 解析JSON数据
    const items: YunsouItem[] = JSON.parse(jsonStr);
    
    // 5. 转换为标准格式
    const results: SearchResult[] = [];
    for (const item of items) {
      const result = this.convertToSearchResult(item);
      if (result.UniqueID && result.Links.length > 0) {
        results.push(result);
      }
    }
    
    // 6. 关键词过滤
    return this.FilterResultsByKeyword(results, keyword);
  }

  private async extractJSONData(htmlContent: string): Promise<string> {
    // 查找 var jsonData = '...'
    const matches = jsonDataRegex.exec(htmlContent);
    if (!matches || matches.length < 2) {
      throw new Error('未找到JSON数据');
    }
    
    let jsonStr = matches[1];
    
    // 清理控制字符
    jsonStr = controlCharsRegex.replaceAll(jsonStr, '');
    
    // 处理转义字符
    jsonStr = jsonStr.replace(/\\\//g, '/');
    
    return jsonStr;
  }

  private convertToSearchResult(item: YunsouItem): SearchResult {
    const result: SearchResult = {
      UniqueID: `${this.Name()}-${item.id}`,
      Title: item.title,
      Content: '',
      Links: [],
      Channel: '',
      Datetime: new Date(),
    };
    
    // 解析时间
    if (item.times) {
      const parsedTime = this.parseTime(item.times);
      if (parsedTime.getTime() > 0) {
        result.Datetime = parsedTime;
      }
    }
    
    // 构建内容描述
    const contentParts: string[] = [];
    if (item.category.name) {
      contentParts.push(`【${item.category.name}】`);
    }
    result.Content = contentParts.join(' ');
    
    // 添加分类标签
    if (item.category.name) {
      result.Tags = [item.category.name];
    }
    
    // 构建网盘链接
    if (item.url) {
      const link: Link = {
        Type: this.convertNetDiskType(item.is_type),
        URL: item.url,
        Password: '',
      };
      
      // 处理提取码
      if (item.code) {
        link.Password = item.code;
      } else if (item.url.includes('?pwd=')) {
        link.Password = this.extractPwdFromURL(item.url);
      }
      
      result.Links = [link];
    }
    
    return result;
  }

  private convertNetDiskType(isType: number): string {
    switch (isType) {
      case 0:
        return 'quark'; // 夸克网盘
      case 1:
        return 'aliyun'; // 阿里云盘
      case 2:
        return 'baidu'; // 百度网盘
      case 3:
        return 'uc'; // UC网盘
      case 4:
        return 'xunlei'; // 迅雷网盘
      default:
        return 'others';
    }
  }

  private extractPwdFromURL(urlStr: string): string {
    const matches = pwdParamRegex.exec(urlStr);
    if (matches && matches.length >= 2) {
      return matches[1];
    }
    return '';
  }

  private async doRequestWithRetry(client: AxiosInstance, url: string): Promise<AxiosResponse> {
    let lastError: Error | null = null;
    
    for (let i = 0; i < maxRetries; i++) {
      if (i > 0) {
        // 指数退避重试
        const backoff = Math.pow(2, i - 1) * 200;
        await new Promise(resolve => setTimeout(resolve, backoff));
      }
      
      try {
        const resp = await client.get(url);
        if (resp.status === 200) {
          return resp;
        }
      } catch (error) {
        lastError = error as Error;
      }
    }
    
    throw new Error(`重试 ${maxRetries} 次后仍然失败: ${lastError?.message}`);
  }

  private parseTime(timeStr: string): Date {
    const parts = timeStr.split('-');
    if (parts.length === 3) {
      const year = parseInt(parts[0]);
      const month = parseInt(parts[1]) - 1;
      const day = parseInt(parts[2]);
      return new Date(year, month, day);
    }
    return new Date(0);
  }
}

// 注册插件
BaseAsyncPlugin.RegisterGlobalPlugin(new YunsouPlugin());
