import { BaseAsyncPlugin, registerGlobalPlugin } from '../plugin.manager';
import { SearchResult, Link } from '../../models/response';
import axios, { AxiosInstance, AxiosResponse } from 'axios';
import * as cheerio from 'cheerio';

// 常量定义
const PluginName = "jutoushe";
const DisplayName = "剧透社";
const Description = "剧透社 - 影视资源搜索插件";
const BaseURL = "https://1.star2.cn";
const SearchPath = "/search/?keyword=%s";
const UserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36";
const MaxResults = 50;
const SearchTimeout = 30000; // 30秒
const DetailTimeout = 15000; // 15秒
const MaxRetries = 3;

// 预编译的正则表达式
const idRegex = /\/([^\/]+)\/(\d+)\.html/;
const categoryRegex = /【([^】]+)】/g;
const dateRegex = /(\d{4})年(\d{1,2})月(\d{1,2})日/;
const pwdRegex = /pwd=([^&]+)/;

// JutoushePlugin 剧透社插件
class JutoushePlugin extends BaseAsyncPlugin {
  private optimizedClient: AxiosInstance;

  constructor() {
    super(PluginName, 1); // 优先级1，较低
    this.optimizedClient = this.createOptimizedHTTPClient();
  }

  // 创建优化的HTTP客户端
  private createOptimizedHTTPClient(): AxiosInstance {
    return axios.create({
      timeout: SearchTimeout,
      headers: {
        'User-Agent': UserAgent,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Connection': 'keep-alive',
        'Referer': `${BaseURL}/`,
      },
    });
  }

  // 插件名称
  name(): string {
    return PluginName;
  }

  // 插件显示名称
  displayName(): string {
    return DisplayName;
  }

  // 插件描述
  description(): string {
    return Description;
  }

  // 搜索实现
  private async searchImpl(client: AxiosInstance, keyword: string, ext: Record<string, any>): Promise<SearchResult[]> {
    // 1. 构建搜索URL
    const searchURL = `${BaseURL}${SearchPath.replace('%s', encodeURIComponent(keyword))}`;

    // 2. 发送HTTP请求（带重试机制）
    const response = await this.doRequestWithRetry(searchURL);

    // 3. 解析搜索结果页面
    return this.parseSearchResults(response.data, keyword);
  }

  // 带重试机制的HTTP请求
  private async doRequestWithRetry(url: string): Promise<AxiosResponse> {
    let lastErr: Error | null = null;

    for (let i = 0; i < MaxRetries; i++) {
      if (i > 0) {
        // 指数退避重试
        const backoff = 200 * Math.pow(2, i - 1);
        await new Promise(resolve => setTimeout(resolve, backoff));
      }

      try {
        const response = await this.optimizedClient.get(url);
        if (response.status === 200) {
          return response;
        }
        lastErr = new Error(`HTTP status: ${response.status}`);
      } catch (error) {
        lastErr = error as Error;
      }
    }

    throw new Error(`重试 ${MaxRetries} 次后仍然失败: ${lastErr?.message || '未知错误'}`);
  }

  // 解析搜索结果
  private parseSearchResults(htmlContent: string, keyword: string): SearchResult[] {
    const results: SearchResult[] = [];

    try {
      const $ = cheerio.load(htmlContent);
      
      // 提取搜索结果
      $('ul.erx-list li.item').each((i, s) => {
        if (results.length >= MaxResults) {
          return false; // 跳出循环
        }

        // 提取标题和链接
        const linkElem = $(s).find('.a a.main');
        const title = linkElem.text().trim();
        const detailPath = linkElem.attr('href');
        
        if (!detailPath || title === '') {
          return; // 跳过无效项
        }

        // 构建完整的详情页URL
        const detailURL = `${BaseURL}${detailPath}`;

        // 提取发布时间
        const timeStr = $(s).find('.i span.time').text().trim();
        const publishTime = this.parseDate(timeStr);

        // 构建唯一ID
        const uniqueID = `${this.name()}-${this.extractIDFromURL(detailPath)}`;

        // 创建搜索结果
        const result: SearchResult = {
          uniqueId: uniqueID,
          messageId: uniqueID,
          title,
          content: `剧透社影视资源：${title}`,
          links: [],
          tags: this.extractTags(title),
          channel: "",
          datetime: publishTime.toISOString(),
        };

        results.push(result);
      });

    } catch (error) {
      console.error(`[${this.name()}] HTML解析失败: ${error}`);
      return [];
    }

    return results;
  }

  // 从URL路径中提取ID
  private extractIDFromURL(urlPath: string): string {
    // 从 /dm/8100.html 提取 8100
    const match = urlPath.match(idRegex);
    if (match && match.length > 2) {
      return match[2];
    }
    
    // 如果无法提取，使用完整路径作为ID
    return urlPath.replace(/\//g, "_");
  }

  // 从标题中提取标签
  private extractTags(title: string): string[] {
    const tags: string[] = [];
    
    // 提取分类标签
    let match;
    categoryRegex.lastIndex = 0; // 重置正则表达式
    while ((match = categoryRegex.exec(title)) !== null) {
      if (match.length > 1) {
        tags.push(match[1]);
      }
    }
    
    // 如果没有提取到分类，添加默认标签
    if (tags.length === 0) {
      tags.push("影视资源");
    }
    
    return tags;
  }

  // 解析日期字符串
  private parseDate(dateStr: string): Date {
    if (dateStr === "") {
      return new Date();
    }

    // 尝试解析 YYYY-MM-DD 格式
    const parsedDate = new Date(dateStr);
    if (!isNaN(parsedDate.getTime())) {
      return parsedDate;
    }

    // 尝试解析 YYYY年MM月DD日 格式
    const match = dateStr.match(dateRegex);
    if (match && match.length === 4) {
      const year = parseInt(match[1]);
      const month = parseInt(match[2]);
      const day = parseInt(match[3]);
      return new Date(year, month - 1, day, 0, 0, 0, 0);
    }

    // 解析失败，返回当前时间
    return new Date();
  }

  // 获取详情页的下载链接
  private async getDetailLinks(detailURL: string): Promise<Link[]> {
    try {
      const response = await this.optimizedClient.get(detailURL, {
        timeout: DetailTimeout,
        headers: {
          'Referer': `${BaseURL}/`,
        },
      });

      if (response.status !== 200) {
        return [];
      }

      const $ = cheerio.load(response.data);
      const links: Link[] = [];

      // 提取下载链接
      $('.dlipp-cont-bd a.dlipp-dl-btn').each((i, s) => {
        const href = $(s).attr('href');
        if (!href || href === '') {
          return;
        }

        // 过滤掉无效链接
        if (!this.isValidNetworkDriveURL(href)) {
          return;
        }

        // 确定网盘类型和提取密码
        const cloudType = this.determineCloudType(href);
        const password = this.extractPassword(href);

        const link: Link = {
          type: cloudType,
          url: href,
          password,
          text: "",
          workTitle: "",
        };

        links.push(link);
      });

      return links;
    } catch (error) {
      console.error(`[${this.name()}] 获取详情页失败: ${error}`);
      return [];
    }
  }

  // 验证是否为有效的网盘链接
  private isValidNetworkDriveURL(url: string): boolean {
    if (url === "") {
      return false;
    }

    // 检查是否为HTTP/HTTPS链接
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      return false;
    }

    // 检查是否包含已知网盘域名
    const knownDomains = [
      "pan.quark.cn", "drive.uc.cn", "pan.baidu.com", 
      "aliyundrive.com", "alipan.com", "pan.xunlei.com",
      "cloud.189.cn", "115.com", "123pan.com", 
      "caiyun.139.com", "mypikpak.com",
    ];

    for (const domain of knownDomains) {
      if (url.includes(domain)) {
        return true;
      }
    }

    return false;
  }

  // 根据URL确定网盘类型
  private determineCloudType(url: string): string {
    if (url.includes("pan.quark.cn")) {
      return "quark";
    } else if (url.includes("drive.uc.cn")) {
      return "uc";
    } else if (url.includes("pan.baidu.com")) {
      return "baidu";
    } else if (url.includes("aliyundrive.com") || url.includes("alipan.com")) {
      return "aliyun";
    } else if (url.includes("pan.xunlei.com")) {
      return "xunlei";
    } else if (url.includes("cloud.189.cn")) {
      return "tianyi";
    } else if (url.includes("115.com")) {
      return "115";
    } else if (url.includes("123pan.com")) {
      return "123";
    } else if (url.includes("caiyun.139.com")) {
      return "mobile";
    } else if (url.includes("mypikpak.com")) {
      return "pikpak";
    } else {
      return "others";
    }
  }

  // 从URL中提取提取码
  private extractPassword(url: string): string {
    // 处理百度网盘的pwd参数
    if (url.includes("pan.baidu.com") && url.includes("pwd=")) {
      const match = url.match(pwdRegex);
      if (match && match.length > 1) {
        return match[1];
      }
    }
    
    // 其他网盘暂不处理提取码
    return "";
  }
}

// 创建并注册插件
const jutoushePlugin = new JutoushePlugin();
registerGlobalPlugin(jutoushePlugin);

export type { JutoushePlugin };
export const JutoushePluginInstance = jutoushePlugin;