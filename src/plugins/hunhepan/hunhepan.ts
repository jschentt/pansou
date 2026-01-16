import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import { SearchResult, Link } from '../../types';
import { Plugin } from '../../types/plugin';

const debugEnabled = false;

function debugLog(format: string, ...args: any[]) {
  if (debugEnabled) {
    console.log(`[hunhepan DEBUG] ${format}`, ...args);
  }
}

// API端点
const HunhepanAPI = 'https://hunhepan.com/open/search/disk';
const QkpansoAPI = 'https://qkpanso.com/v1/search/disk';
const KuakeAPI = 'https://kuake8.com/v1/search/disk';
const MisosoAPI = 'https://www.misoso.cc/v1/search/disk';

// 默认页大小
const DefaultPageSize = 30;

interface HunhepanItem {
  disk_id: string;
  disk_name: string;
  disk_pass: string;
  disk_type: string;
  files: string;
  doc_id: string;
  share_user: string;
  shared_time: string;
  link: string;
  enabled: boolean;
  weight: number;
  status: number;
}

interface HunhepanResponse {
  code: number;
  msg: string;
  data: {
    total: number;
    per_size: number;
    list: HunhepanItem[];
  };
}

class HunhepanPlugin implements Plugin {
  name(): string {
    return 'hunhepan';
  }

  displayName(): string {
    return '混合盘';
  }

  description(): string {
    return '混合盘 - 多平台网盘资源搜索';
  }

  async search(keyword: string, ext: Record<string, any>): Promise<SearchResult[]> {
    return this.doSearch(axios.create({ timeout: 30000 }), keyword, ext);
  }

  private async doSearch(client: AxiosInstance, keyword: string, ext: Record<string, any>): Promise<SearchResult[]> {
    debugLog('开始搜索，关键词: %s', keyword);

    // 并行请求四个API
    const apiPromises = [
      this.searchAPI(client, HunhepanAPI, keyword),
      this.searchAPI(client, QkpansoAPI, keyword),
      this.searchAPI(client, KuakeAPI, keyword),
      this.searchAPI(client, MisosoAPI, keyword)
    ];

    const apiResults = await Promise.allSettled(apiPromises);

    // 收集结果
    let allItems: HunhepanItem[] = [];
    let errors: Error[] = [];

    for (const result of apiResults) {
      if (result.status === 'fulfilled') {
        allItems = allItems.concat(result.value);
      } else {
        errors.push(result.reason);
      }
    }

    debugLog('收集到 %d 条原始结果，%d 个错误', allItems.length, errors.length);

    // 如果没有获取到任何结果且有错误，则返回第一个错误
    if (allItems.length === 0 && errors.length > 0) {
      throw errors[0];
    }

    // 去重处理
    const uniqueItems = this.deduplicateItems(allItems);
    debugLog('去重后剩余 %d 条结果', uniqueItems.length);

    // 转换为标准格式
    const results = this.convertResults(uniqueItems);
    debugLog('转换后得到 %d 条最终结果', results.length);

    return results;
  }

  private async searchAPI(client: AxiosInstance, apiURL: string, keyword: string): Promise<HunhepanItem[]> {
    const maxPages = 3; // 最多获取3页数据
    const pagePromises: Promise<HunhepanItem[]>[] = [];

    // 并发请求每一页
    for (let page = 1; page <= maxPages; page++) {
      pagePromises.push(this.fetchPage(client, apiURL, keyword, page));
    }

    const pageResults = await Promise.allSettled(pagePromises);
    let allItems: HunhepanItem[] = [];

    for (const result of pageResults) {
      if (result.status === 'fulfilled') {
        allItems = allItems.concat(result.value);
      }
    }

    return allItems;
  }

  private async fetchPage(client: AxiosInstance, apiURL: string, keyword: string, page: number): Promise<HunhepanItem[]> {
    // 构建请求体
    const reqBody = {
      page: page,
      q: keyword,
      user: '',
      exact: false,
      format: [] as string[],
      share_time: '',
      size: DefaultPageSize,
      type: '',
      exclude_user: [] as string[],
      adv_params: {
        wechat_pwd: '',
        platform: 'pc'
      }
    };

    debugLog('发送请求到 %s (page %d): %s', apiURL, page, JSON.stringify(reqBody));

    const config: AxiosRequestConfig = {
      method: 'POST',
      url: apiURL,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
      },
      data: reqBody
    };

    // 根据不同的API设置不同的Referer
    if (apiURL.includes('qkpanso.com')) {
      config.headers['Referer'] = 'https://qkpanso.com/search';
    } else if (apiURL.includes('kuake8.com')) {
      config.headers['Referer'] = 'https://kuake8.com/search';
    } else if (apiURL.includes('hunhepan.com')) {
      config.headers['Referer'] = 'https://hunhepan.com/search';
    } else if (apiURL.includes('misoso.cc')) {
      config.headers['Referer'] = 'https://www.misoso.cc/search';
      config.headers['Origin'] = 'https://www.misoso.cc';
    }

    try {
      const resp = await client(config);
      debugLog('收到响应 (page %d), 状态码: %d', page, resp.status);

      if (resp.data) {
        debugLog('响应内容 (page %d, 前500字符): %s', page, JSON.stringify(resp.data).substring(0, 500));
      }

      // 检查响应状态
      if (resp.data.code !== 200) {
        debugLog('API返回错误 (page %d): code=%d, msg=%s', page, resp.data.code, resp.data.msg);
        throw new Error(`API returned error (page ${page}): ${resp.data.msg}`);
      }

      debugLog('成功获取第 %d 页数据，共 %d 条结果', page, resp.data.data.list.length);
      return resp.data.data.list;
    } catch (err: any) {
      debugLog('请求失败 (page %d): %v', page, err);
      throw new Error(`request failed (page ${page}): ${err.message}`);
    }
  }

  private deduplicateItems(items: HunhepanItem[]): HunhepanItem[] {
    // 使用map进行去重
    const uniqueMap = new Map<string, HunhepanItem>();

    for (const item of items) {
      // 清理disk_name中的HTML标签
      const cleanedName = this.cleanTitle(item.disk_name);
      const cleanedItem = {
        ...item,
        disk_name: cleanedName
      };

      // 创建复合键：优先使用disk_id，如果为空则使用link+disk_name组合
      let key: string;
      if (item.disk_id) {
        key = item.disk_id;
      } else if (item.link) {
        // 使用link和清理后的disk_name组合作为键
        key = item.link + '|' + cleanedName;
      } else {
        // 如果disk_id和link都为空，则使用disk_name+disk_type作为键
        key = cleanedName + '|' + item.disk_type;
      }

      // 如果已存在，保留信息更丰富的那个
      if (uniqueMap.has(key)) {
        const existing = uniqueMap.get(key)!;
        // 比较文件列表长度和其他信息
        const existingScore = existing.files.length;
        let newScore = item.files.length;

        // 如果新项有密码而现有项没有，增加新项分数
        if (!existing.disk_pass && item.disk_pass) {
          newScore += 5;
        }

        // 如果新项有时间而现有项没有，增加新项分数
        if (!existing.shared_time && item.shared_time) {
          newScore += 3;
        }

        if (newScore > existingScore) {
          uniqueMap.set(key, cleanedItem);
        }
      } else {
        uniqueMap.set(key, cleanedItem);
      }
    }

    // 将map转回数组
    return Array.from(uniqueMap.values());
  }

  private convertResults(items: HunhepanItem[]): SearchResult[] {
    const results: SearchResult[] = [];

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      // 跳过无效链接的结果
      if (!item.link) {
        debugLog('跳过无链接的结果: %s', item.disk_name);
        continue;
      }

      // 创建链接
      const link: Link = {
        url: item.link,
        type: this.convertDiskType(item.disk_type),
        password: item.disk_pass
      };

      // 创建唯一ID
      let uniqueID = `hunhepan-${item.disk_id}`;
      if (!item.disk_id) {
        // 使用索引作为后备
        uniqueID = `hunhepan-${Date.now()}-${i}`;
      }

      // 解析时间
      let datetime = new Date();
      if (item.shared_time) {
        // 尝试解析时间，格式：2025-07-07 13:19:48
        const parsedTime = new Date(item.shared_time);
        if (!isNaN(parsedTime.getTime())) {
          datetime = parsedTime;
        } else {
          debugLog('时间解析失败: %s', item.shared_time);
        }
      }

      // 创建搜索结果
      const result: SearchResult = {
        uniqueId: uniqueID,
        title: this.cleanTitle(item.disk_name),
        content: item.files,
        datetime: datetime,
        links: [link],
        channel: '', // 插件搜索结果必须为空字符串
        tags: [],
        images: [],
        pluginName: this.name(),
        displayName: this.displayName()
      };

      debugLog('转换结果: ID=%s, Title=%s, Type=%s, Link=%s', uniqueID, result.title, link.type, link.url);
      results.push(result);
    }

    return results;
  }

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

  private cleanTitle(title: string): string {
    // 一次性替换所有常见HTML标签
    const replacements: Record<string, string> = {
      '<em>': '',
      '</em>': '',
      '<b>': '',
      '</b>': '',
      '<strong>': '',
      '</strong>': '',
      '<i>': '',
      '</i>': ''
    };

    let result = title;
    for (const [tag, replacement] of Object.entries(replacements)) {
      result = result.replace(new RegExp(tag, 'g'), replacement);
    }

    // 移除多余的空格
    return result.trim();
  }
}

// 导出插件实例
const plugin = new HunhepanPlugin();
export default plugin;