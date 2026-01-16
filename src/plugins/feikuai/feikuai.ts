import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios';
import { BaseAsyncPlugin } from '../plugin.manager';
import { SearchResult, Link } from '../../models/plugin-result';

// 常量定义
const pluginName = "feikuai";
const displayName = "飞快磁力";
const description = "飞快磁力 - 磁力链接搜索";
const searchAPIURL = "https://feikuai.tv/t_search/bm_search.php?kw=%s";
const userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36";
const maxResults = 100;
const requestTimeout = 15000;

// 正则表达式
const fileExtRegex = /\.(mkv|mp4|avi|rmvb|wmv|flv|mov|ts|m2ts|iso)$/;
const fileSizeRegex = /\s*·\s*[\d.]+\s*[KMGT]B\s*$/;
const dateTimeRegex = /@[^-]+-(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/;

// API响应结构
interface FeikuaiAPIResponse {
  code: number;
  msg: string;
  keyword: string;
  count: number;
  items: FeikuaiAPIItem[];
}

interface FeikuaiAPIItem {
  content_id?: string;
  title: string;
  type: string;
  year?: number;
  torrents: FeikuaiTorrent[];
}

interface FeikuaiTorrent {
  info_hash: string;
  magnet: string;
  name: string;
  size_bytes: number;
  size_gb: number;
  seeders: number;
  leechers: number;
  published_at: string;
  published_ago: string;
  file_path: string;
  file_ext: string;
}

export class FeikuaiPlugin extends BaseAsyncPlugin {
  constructor() {
    super(pluginName, 3); // 优先级3
  }

  Name(): string {
    return pluginName;
  }

  DisplayName(): string {
    return displayName;
  }

  Description(): string {
    return description;
  }

  protected async searchImpl(client: AxiosInstance, keyword: string): Promise<SearchResult[]> {
    try {
      // 构建API搜索URL
      const searchURL = searchAPIURL.replace('%s', encodeURIComponent(keyword));

      // 发送请求（带重试机制）
      const resp = await this.doRequestWithRetry(client, searchURL);

      if (resp.status !== 200) {
        throw new Error(`[${this.Name()}] 请求返回状态码: ${resp.status}`);
      }

      // 解析JSON响应
      const apiResp: FeikuaiAPIResponse = resp.data;

      // 检查API响应状态
      if (apiResp.code !== 0) {
        throw new Error(`[${this.Name()}] API返回错误: ${apiResp.msg} (code: ${apiResp.code})`);
      }

      // 解析搜索结果
      const results: SearchResult[] = [];

      for (const item of apiResp.items) {
        // 每个item可能包含多个种子
        for (const torrent of item.torrents) {
          if (results.length >= maxResults) {
            break;
          }
          const result = this.parseTorrent(keyword, item, torrent);
          if (result.Title && result.Links.length > 0) {
            results.push(result);
          }
        }
        if (results.length >= maxResults) {
          break;
        }
      }

      // 使用关键词过滤结果
      return this.filterResultsByKeyword(results, keyword);
    } catch (error) {
      console.error(`[FEIKUAI] 搜索失败:`, error);
      return [];
    }
  }

  private parseTorrent(keyword: string, item: FeikuaiAPIItem, torrent: FeikuaiTorrent): SearchResult {
    // 构建唯一ID
    const uniqueID = `${this.Name()}-${torrent.info_hash}`;

    // 构建work_title
    const workTitle = this.buildWorkTitle(keyword, torrent.name);

    // 构建描述信息
    const content = this.buildContent(item, torrent);

    // 解析发布时间
    const datetime = this.parsePublishedTime(torrent.published_at);

    // 构建标签
    const tags = this.extractTags(item.title, torrent.name);

    // 构建磁力链接
    const links: Link[] = [
      {
        Type: "magnet",
        URL: torrent.magnet,
        Password: "", // 磁力链接无密码
      },
    ];

    return {
      UniqueID: uniqueID,
      Title: workTitle, // 使用处理后的work_title作为标题
      Content: content,
      Links: links,
      Tags: tags,
      Channel: "", // 插件搜索结果Channel为空
      Datetime: datetime,
      MessageID: uniqueID
    };
  }

  private buildWorkTitle(keyword: string, fileName: string): string {
    // 1. 清洗文件名
    const cleanedName = this.cleanFileName(fileName);

    // 2. 检查是否包含关键词
    if (this.containsKeywords(keyword, cleanedName)) {
      return cleanedName;
    }

    // 3. 不包含关键词，拼接中文关键词
    return `${keyword}-${cleanedName}`;
  }

  private cleanFileName(fileName: string): string {
    // 去除文件扩展名
    let cleanedName = fileName.replace(fileExtRegex, "");

    // 去除文件大小信息
    cleanedName = cleanedName.replace(fileSizeRegex, "");

    // 去除日期时间部分（@来源-日期 时间）
    const atIndex = cleanedName.indexOf("@");
    if (atIndex !== -1) {
      cleanedName = cleanedName.substring(0, atIndex);
    }

    return cleanedName.trim();
  }

  private containsKeywords(keyword: string, text: string): boolean {
    // 简化处理：分词并检查
    const keywords = this.splitKeywords(keyword);
    const lowerText = text.toLowerCase();

    for (const kw of keywords) {
      if (lowerText.includes(kw.toLowerCase())) {
        return true;
      }
    }

    return false;
  }

  private splitKeywords(keyword: string): string[] {
    // 移除标点符号和空格
    const trimmedKeyword = keyword.trim();

    // 简单按空格、中文标点分割
    const separators = [" ", "　", "，", "。", "、", "；", "：", "！", "？", "-", "_"];

    let parts: string[] = [trimmedKeyword];
    for (const sep of separators) {
      const newParts: string[] = [];
      for (const part of parts) {
        if (part.includes(sep)) {
          newParts.push(...part.split(sep));
        } else {
          newParts.push(part);
        }
      }
      parts = newParts;
    }

    // 过滤空字符串和过短的词
    const result: string[] = [];
    for (const part of parts) {
      const trimmedPart = part.trim();
      if (trimmedPart.length >= 2) { // 至少2个字符
        result.push(trimmedPart);
      }
    }

    return result;
  }

  private buildContent(item: FeikuaiAPIItem, torrent: FeikuaiTorrent): string {
    const contentParts: string[] = [];

    // 文件名
    contentParts.push(`文件名: ${torrent.name}`);

    // 文件大小
    contentParts.push(`大小: ${torrent.size_gb.toFixed(2)} GB`);

    // 做种数和下载数
    contentParts.push(`做种: ${torrent.seeders}`);
    contentParts.push(`下载: ${torrent.leechers}`);

    // 发布时间（人类可读格式）
    if (torrent.published_ago) {
      contentParts.push(`发布: ${torrent.published_ago}`);
    }

    return contentParts.join(" | ");
  }

  private extractTags(title: string, fileName: string): string[] {
    const tags: string[] = [];
    const combinedText = (title + " " + fileName).toUpperCase();

    // 分辨率标签
    if (combinedText.includes("2160P") || combinedText.includes("4K")) {
      tags.push("4K");
    } else if (combinedText.includes("1080P")) {
      tags.push("1080P");
    } else if (combinedText.includes("720P")) {
      tags.push("720P");
    }

    // 编码格式
    if (combinedText.includes("H265") || combinedText.includes("HEVC")) {
      tags.push("H265");
    } else if (combinedText.includes("H264") || combinedText.includes("AVC")) {
      tags.push("H264");
    }

    // HDR标签
    if (combinedText.includes("HDR")) {
      tags.push("HDR");
    }

    // 60帧
    if (combinedText.includes("60FPS") || combinedText.includes("60HZ")) {
      tags.push("60fps");
    }

    return tags;
  }

  private parsePublishedTime(timeStr: string): Date {
    if (!timeStr) {
      return new Date();
    }

    // 解析ISO 8601格式: "2025-11-18 00:54:20.659664+00"
    const layouts = [
      "2006-01-02 15:04:05.999999-07",
      "2006-01-02 15:04:05.999999+07",
      "2006-01-02 15:04:05-07",
      "2006-01-02 15:04:05+07",
      "2006-01-02 15:04:05",
    ];

    for (const layout of layouts) {
      try {
        // 尝试直接解析
        const date = new Date(timeStr);
        if (!isNaN(date.getTime())) {
          return date;
        }
      } catch (error) {
        // 解析失败，继续尝试下一个格式
      }
    }

    // 解析失败，返回当前时间
    return new Date();
  }

  private async doRequestWithRetry(client: AxiosInstance, url: string, timeout: number = requestTimeout): Promise<AxiosResponse> {
    const maxRetries = 3;
    let lastError: any = null;

    for (let i = 0; i < maxRetries; i++) {
      try {
        if (i > 0) {
          // 指数退避
          const backoff = Math.pow(2, i - 1) * 200;
          await new Promise(resolve => setTimeout(resolve, backoff));
        }

        const resp = await client.get(url, {
          headers: this.setCommonHeaders(),
          timeout: timeout
        });

        if (resp.status === 200) {
          return resp;
        }
        lastError = new Error(`HTTP状态码: ${resp.status}`);
      } catch (error) {
        lastError = error;
      }
    }

    throw new Error(`[${this.Name()}] 重试 ${maxRetries} 次后仍然失败: ${lastError?.message}`);
  }

  private setCommonHeaders(): Record<string, string> {
    return {
      'User-Agent': userAgent,
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'Connection': 'keep-alive',
      'Referer': 'https://feikuai.tv/'
    };
  }

  private filterResultsByKeyword(results: SearchResult[], keyword: string): SearchResult[] {
    const keywords = keyword.split(/\s+/).filter(k => k.length > 0);
    if (keywords.length === 0) {
      return results;
    }

    return results.filter(result => {
      const titleLower = result.Title.toLowerCase();
      const contentLower = result.Content.toLowerCase();
      return keywords.every(k => {
        const keywordLower = k.toLowerCase();
        return titleLower.includes(keywordLower) || contentLower.includes(keywordLower);
      });
    });
  }
}

// 注册插件
const plugin = new FeikuaiPlugin();
plugin.register();