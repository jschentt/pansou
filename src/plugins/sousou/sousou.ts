import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import { SearchResult, Link, PluginSearchResult } from '../../../model';
import { FilterResultsByKeyword } from '../../../util/plugin.util';

// 常量定义
const SousouAPI = 'https://sousou.pro/api.php';
const DefaultPerSize = 30;
const DefaultMaxPages = 3;
const RequestTimeout = 30000; // 请求超时时间：30秒

// 调试开关
const debugEnabled = false;

// 调试日志函数
function debugLog(format: string, ...args: any[]): void {
  if (debugEnabled) {
    console.log(`[sousou DEBUG] ${format}`, ...args);
  }
}

// 支持的网盘类型列表
const supportedDiskTypes: string[] = [
  'QUARK',   // 夸克网盘
  'BDY',     // 百度网盘
  'ALY',     // 阿里云盘
  'XUNLEI',  // 迅雷网盘
  'UC',      // UC网盘
  '115',     // 115网盘
];

// SousouItem API响应中的单个结果项
interface SousouItem {
  disk_id: string;
  disk_name: string;
  disk_pass: string;
  disk_type: string;
  files: string;
  doc_id: string;
  share_user: string;
  share_user_id: string;
  shared_time: string;
  rel_movie: string;
  is_mine: boolean;
  tags: string[] | null;
  link: string;
  enabled: boolean;
  weight: number;
  status: number;
}

// SousouResponse API响应结构
interface SousouResponse {
  code: number;
  msg: string;
  data: {
    total: number;
    per_size: number;
    took: number;
    list: SousouItem[];
  };
}

// SousouPlugin Sousou搜索插件
class SousouPlugin {
  private client: AxiosInstance;
  private MainCacheKey: string;
  private name: string;

  constructor() {
    this.client = axios.create({
      timeout: RequestTimeout,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Connection': 'keep-alive',
        'Referer': 'https://sousou.pro/',
      },
      httpsAgent: new (require('https').Agent)({
        rejectUnauthorized: false
      })
    });

    this.MainCacheKey = 'sousou';
    this.name = 'sousou';
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
    const results = await searchImpl(this.client, keyword, ext);
    
    return {
      Results: results,
      IsFinal: true,
      CacheKey: cacheKey
    };
  }

  // searchImpl 实际的搜索实现 - 并发搜索多种网盘类型
  private async searchImpl(client: AxiosInstance, keyword: string, ext: Record<string, any>): Promise<SearchResult[]> {
    debugLog('开始搜索，关键词: %s', keyword);

    // 并发搜索每种网盘类型
    const searchPromises = supportedDiskTypes.map(async (diskType) => {
      debugLog('开始搜索网盘类型: %s', diskType);
      
      try {
        const items = await this.searchByType(client, keyword, diskType);
        debugLog('%s 网盘返回 %d 条结果', diskType, items.length);
        return items;
      } catch (err) {
        debugLog('%s 网盘搜索错误: %v', diskType, err);
        return [];
      }
    });

    // 等待所有搜索完成
    const allResults = await Promise.all(searchPromises);
    
    // 合并所有结果
    let allItems: SousouItem[] = [];
    allResults.forEach(items => {
      allItems = allItems.concat(items);
    });

    debugLog('收集到 %d 条原始结果', allItems.length);

    // 去重处理
    const uniqueItems = this.deduplicateItems(allItems);
    debugLog('去重后剩余 %d 条结果', uniqueItems.length);

    // 转换为标准格式
    const results = this.convertResults(uniqueItems);
    debugLog('转换后得到 %d 条最终结果', results.length);

    // 关键词过滤
    const filteredResults = FilterResultsByKeyword(results, keyword);
    debugLog('过滤后剩余 %d 条结果', filteredResults.length);

    return filteredResults;
  }

  // searchByType 搜索指定网盘类型
  private async searchByType(client: AxiosInstance, keyword: string, diskType: string): Promise<SousouItem[]> {
    // 并发请求每一页
    const pagePromises = Array.from({ length: DefaultMaxPages }, async (_, index) => {
      const page = index + 1;
      
      // 构建请求URL
      const apiURL = `${SousouAPI}?action=search&q=${encodeURIComponent(keyword)}&page=${page}&per_size=${DefaultPerSize}&type=${diskType}`;
      
      debugLog('请求URL (page %d, type %s): %s', page, diskType, apiURL);
      
      try {
        // 发送请求
        const response = await client.request({
          method: 'GET',
          url: apiURL,
          timeout: RequestTimeout
        });
        
        debugLog('收到响应 (page %d, type %s), 状态码: %d', page, diskType, response.status);
        
        // 检查状态码
        if (response.status !== 200) {
          debugLog('HTTP错误 (page %d, type %s): %d', page, diskType, response.status);
          return [];
        }
        
        // 解析响应
        const apiResp: SousouResponse = response.data;
        
        debugLog('响应内容 (page %d, type %s): code=%d, msg=%s, total=%d', 
          page, diskType, apiResp.code, apiResp.msg, apiResp.data.total);
        
        // 检查响应状态
        if (apiResp.code !== 200) {
          debugLog('API返回错误 (page %d, type %s): code=%d, msg=%s', page, diskType, apiResp.code, apiResp.msg);
          return [];
        }
        
        debugLog('成功获取第 %d 页数据 (type %s)，共 %d 条结果', page, diskType, apiResp.data.list.length);
        
        return apiResp.data.list;
      } catch (err) {
        debugLog('请求失败 (page %d, type %s): %v', page, diskType, err);
        return [];
      }
    });

    // 等待所有页面请求完成
    const pageResults = await Promise.all(pagePromises);
    
    // 合并所有页面结果
    let allItems: SousouItem[] = [];
    pageResults.forEach(items => {
      allItems = allItems.concat(items);
    });

    return allItems;
  }

  // deduplicateItems 去重处理
  private deduplicateItems(items: SousouItem[]): SousouItem[] {
    // 使用map进行去重，以disk_id为键
    const uniqueMap = new Map<string, SousouItem>();

    for (const item of items) {
      // 创建唯一键：优先使用DiskID，如果为空则使用Link
      let key: string;
      if (item.disk_id !== '') {
        key = item.disk_id;
      } else if (item.link !== '') {
        key = item.link;
      } else {
        // 如果DiskID和Link都为空，则使用DiskName+DiskType作为键
        key = `${item.disk_name}|${item.disk_type}`;
      }

      // 如果已存在，保留信息更丰富的那个
      if (uniqueMap.has(key)) {
        const existing = uniqueMap.get(key)!;
        
        // 比较文件列表长度和其他信息
        let existingScore = existing.files.length;
        let newScore = item.files.length;

        // 如果新项有密码而现有项没有，增加新项分数
        if (existing.disk_pass === '' && item.disk_pass !== '') {
          newScore += 5;
        }

        // 如果新项有时间而现有项没有，增加新项分数
        if (existing.shared_time === '' && item.shared_time !== '') {
          newScore += 3;
        }

        // 如果新项有标签而现有项没有，增加新项分数
        if ((existing.tags === null || existing.tags.length === 0) && item.tags !== null && item.tags.length > 0) {
          newScore += 2;
        }

        if (newScore > existingScore) {
          uniqueMap.set(key, item);
        }
      } else {
        uniqueMap.set(key, item);
      }
    }

    // 将map转回数组
    return Array.from(uniqueMap.values());
  }

  // convertResults 将API响应转换为标准SearchResult格式
  private convertResults(items: SousouItem[]): SearchResult[] {
    const results: SearchResult[] = [];

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      
      // 跳过无效链接的结果
      if (item.link === '') {
        debugLog('跳过无链接的结果: %s', item.disk_name);
        continue;
      }

      // 创建链接
      const link: Link = {
        URL: item.link,
        Type: this.convertDiskType(item.disk_type),
        Password: item.disk_pass,
      };

      // 创建唯一ID
      let uniqueID = `sousou-${item.disk_id}`;
      if (item.disk_id === '') {
        // 使用索引作为后备
        uniqueID = `sousou-${Date.now()}-${i}`;
      }

      // 解析时间
      let datetime = new Date(0);
      if (item.shared_time !== '') {
        // 尝试解析时间，格式：2025-10-27 21:38:59
        const parsedTime = new Date(item.shared_time);
        if (!isNaN(parsedTime.getTime())) {
          datetime = parsedTime;
        } else {
          debugLog('时间解析失败: %s', item.shared_time);
        }
      }

      // 处理标签
      const tags = this.processTags(item.tags);

      // 创建搜索结果
      const result: SearchResult = {
        MessageID: uniqueID,
        UniqueID: uniqueID,
        Title: item.disk_name,
        Content: item.files,
        Datetime: datetime,
        Tags: tags,
        Links: [link],
        Channel: '', // 插件搜索结果必须为空字符串
      };

      debugLog('转换结果: ID=%s, Title=%s, Type=%s, Link=%s', uniqueID, result.Title, link.Type, link.URL);
      results.push(result);
    }

    return results;
  }

  // convertDiskType 将API的网盘类型转换为标准链接类型
  private convertDiskType(diskType: string): string {
    switch (diskType) {
      case 'BDY':
        return 'baidu';
      case 'ALY':
        return 'aliyun';
      case 'QUARK':
        return 'quark';
      case 'TIANYI':
        return 'tianyi';
      case 'UC':
        return 'uc';
      case 'CAIYUN':
        return 'mobile';
      case '115':
        return '115';
      case 'XUNLEI':
        return 'xunlei';
      case '123PAN':
        return '123';
      case 'PIKPAK':
        return 'pikpak';
      default:
        return 'others';
    }
  }

  // processTags 处理标签字段（可能为null或字符串数组）
  private processTags(tags: string[] | null): string[] {
    if (tags === null) {
      return [];
    }

    return tags.filter(tag => typeof tag === 'string' && tag !== '');
  }
}

// 创建并导出插件实例
export default new SousouPlugin();