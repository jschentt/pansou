import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import { SearchResult, Link } from '../../types';
import { Plugin } from '../../types/plugin';


// 常量定义
const BaseURL = "https://www.bixbiy.com/api/discussions";
const PageSize = 50;
const MaxRetries = 2;

// 常用UA列表
const userAgents = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/92.0.4515.107 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.1.2 Safari/605.1.15",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:90.0) Gecko/20100101 Firefox/90.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.114 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/92.0.4515.107 Safari/537.36"
];

// BixinResponse API响应结构
interface BixinResponse {
  links: {
    first: string;
    next?: string;
  };
  data: BixinDiscussion[];
  included: BixinPost[];
}

// BixinDiscussion 讨论信息
interface BixinDiscussion {
  type: string;
  id: string;
  attributes: {
    title: string;
    slug: string;
    commentCount: number;
    createdAt: string;
    lastPostedAt: string;
    lastPostNumber: number;
    isApproved: boolean;
  };
  relationships: {
    mostRelevantPost: {
      data: {
        type: string;
        id: string;
      };
    };
  };
}

// BixinPost 帖子内容
interface BixinPost {
  type: string;
  id: string;
  attributes: {
    number: number;
    createdAt: string;
    contentType: string;
    contentHtml: string;
  };
}

const pluginName = 'bixin';
const defaultPriority = 3;

class BixinPlugin implements Plugin {
  private client: AxiosInstance;
  private retries: number;

  constructor() {
    this.client = axios.create({
      timeout: 15000,
      headers: {
        'User-Agent': this.getRandomUA()
      }
    });
    this.retries = MaxRetries;
  }

  name(): string {
    return pluginName;
  }

  displayName(): string {
    return 'bixin';
  }

  description(): string {
    return 'bixin - 网盘资源搜索';
  }

  async search(keyword: string, ext: Record<string, any>): Promise<SearchResult[]> {
    return this.searchImpl(keyword, ext);
  }

  private async searchImpl(keyword: string, ext: Record<string, any>): Promise<SearchResult[]> {
    const startTime = Date.now();

    try {
      // 只并发请求2个页面（0-1页）
      const { allResults } = await this.fetchBatch(keyword, 0, 2);

      // 去重
      const uniqueResults = this.deduplicateResults(allResults);

      // 过滤结果
      const filteredResults = this.filterResultsByKeyword(uniqueResults, keyword);

      console.log(`[${this.name()}] 搜索结果: ${filteredResults.length} 条`);
      console.log(`[${this.name()}] 搜索耗时: ${Date.now() - startTime}ms`);

      return filteredResults;
    } catch (error) {
      console.error(`[${this.name()}] 搜索失败:`, error);
      return [];
    }
  }

  private async fetchBatch(keyword: string, startOffset: number, pageCount: number): Promise<{ allResults: SearchResult[]; hasMore: boolean }> {
    const resultChan: { offset: number; results: SearchResult[]; hasMore: boolean; err: Error | null }[] = [];

    // 并发请求多个页面，但每个请求之间添加随机延迟
    const promises = [];

    for (let i = 0; i < pageCount; i++) {
      const offset = (startOffset + i) * PageSize;

      const promise = async () => {
        // 第一个请求立即执行，后续请求添加随机延迟
        if (i > 0) {
          // 随机等待0-1秒
          const randomDelay = 100 + Math.floor(Math.random() * 900);
          await this.sleep(randomDelay);
        }

        // 请求特定页面
        const { results, hasMore, err } = await this.fetchPage(keyword, offset);

        resultChan.push({
          offset: offset,
          results: results,
          hasMore: hasMore,
          err: err
        });
      };

      promises.push(promise());
    }

    // 等待所有请求完成
    await Promise.all(promises);

    // 收集结果
    let allResults: SearchResult[] = [];
    let hasMore = false;

    for (const result of resultChan) {
      if (result.err) {
        throw result.err;
      }

      allResults = allResults.concat(result.results);
      hasMore = hasMore || result.hasMore;
    }

    return { allResults, hasMore };
  }

  private deduplicateResults(results: SearchResult[]): SearchResult[] {
    const seen = new Set<string>();
    const unique: SearchResult[] = [];

    for (const result of results) {
      if (!seen.has(result.uniqueId)) {
        seen.add(result.uniqueId);
        unique.push(result);
      }
    }

    // 按时间降序排序
    unique.sort((a, b) => {
      return b.datetime.getTime() - a.datetime.getTime();
    });

    return unique;
  }

  private async fetchPage(keyword: string, offset: number): Promise<{ results: SearchResult[]; hasMore: boolean; err: Error | null }> {
    try {
      // 构建API URL
      const apiURL = `${BaseURL}?filter[q]=${encodeURIComponent(keyword)}&include=mostRelevantPost&page[offset]=${offset}&page[limit]=${PageSize}`;

      // 发送请求（带重试机制）
      const config: AxiosRequestConfig = {
        method: 'GET',
        url: apiURL,
        headers: this.setRequestHeaders()
      };

      const resp = await this.doRequestWithRetry(config);

      // 解析响应
      const apiResp: BixinResponse = resp.data;

      // 处理结果
      const results: SearchResult[] = [];
      const postMap = new Map<string, BixinPost>();

      // 创建帖子ID到帖子内容的映射
      for (const post of apiResp.included) {
        postMap.set(post.id, post);
      }

      // 遍历搜索结果
      for (const discussion of apiResp.data) {
        // 获取相关帖子
        const postID = discussion.relationships.mostRelevantPost.data.id;
        const post = postMap.get(postID);
        if (!post) {
          continue;
        }

        // 清理HTML内容
        const cleanedHTML = this.cleanHTML(post.attributes.contentHtml);

        // 提取链接（只处理移动云盘）
        const links = this.extractMobileLinksFromText(cleanedHTML);

        // 如果没有找到链接，跳过该结果
        if (links.length === 0) {
          continue;
        }

        // 解析时间
        let createdTime: Date;
        try {
          createdTime = new Date(discussion.attributes.createdAt);
        } catch (error) {
          createdTime = new Date(); // 如果解析失败，使用当前时间
        }

        // 创建唯一ID：插件名-帖子ID
        const uniqueID = `bixin-${discussion.id}`;

        // 创建搜索结果
        results.push({
          uniqueId: uniqueID,
          title: discussion.attributes.title,
          content: cleanedHTML,
          datetime: createdTime,
          channel: '',
          links: links,
          tags: [],
          images: [],
          pluginName: this.name(),
          displayName: this.displayName()
        });
      }

      // 判断是否有更多结果
      const hasMore = !!apiResp.links.next;

      return { results, hasMore, err: null };
    } catch (error) {
      return { results: [], hasMore: false, err: error as Error };
    }
  }

  private setRequestHeaders(): Record<string, string> {
    return {
      'User-Agent': this.getRandomUA(),
      'X-Forwarded-For': this.generateRandomIP(),
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'Connection': 'keep-alive',
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-origin'
    };
  }

  private async doRequestWithRetry(config: AxiosRequestConfig): Promise<any> {
    let lastErr: any;

    for (let i = 0; i <= this.retries; i++) {
      try {
        const resp = await this.client(config);
        if (resp.status === 200) {
          return resp;
        }
      } catch (error) {
        lastErr = error;
      }

      if (i < this.retries) {
        await this.sleep(500);
      }
    }

    if (lastErr) {
      throw new Error(`重试 ${this.retries} 次后仍然失败: ${lastErr}`);
    }

    throw new Error(`重试 ${this.retries} 次后仍然失败`);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private getRandomUA(): string {
    const randomIndex = Math.floor(Math.random() * userAgents.length);
    return userAgents[randomIndex];
  }

  private generateRandomIP(): string {
    return `${Math.floor(Math.random() * 223) + 1}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 254) + 1}`;
  }

  private cleanHTML(html: string): string {
    // 移除<br>标签
    html = html.replace(/<br>/g, '\n');
    html = html.replace(/<br\/>/g, '\n');
    html = html.replace(/<br \/>/g, '\n');

    // 移除其他HTML标签
    let result = '';
    let inTag = false;

    for (const char of html) {
      if (char === '<') {
        inTag = true;
        continue;
      }
      if (char === '>') {
        inTag = false;
        continue;
      }
      if (!inTag) {
        result += char;
      }
    }

    // 处理HTML实体
    let output = result;
    output = output.replace(/&amp;/g, '&');
    output = output.replace(/&lt;/g, '<');
    output = output.replace(/&gt;/g, '>');
    output = output.replace(/&quot;/g, '"');
    output = output.replace(/&apos;/g, "'");
    output = output.replace(/&#39;/g, "'");
    output = output.replace(/&nbsp;/g, ' ');

    // 处理多行空白
    const lines = output.split('\n');
    const cleanedLines: string[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed) {
        cleanedLines.push(trimmed);
      }
    }

    return cleanedLines.join('\n');
  }

  private extractMobileLinksFromText(content: string): Link[] {
    const allLinks: Link[] = [];

    const lines = content.split('\n');

    // 收集所有可能的链接信息
    const linkInfos = [];

    // 收集所有可能的密码信息
    const passwordInfos = [];

    // 第一遍：查找所有的链接和密码
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      // 只检查移动云盘（bixin只支持移动云盘）
      if (line.includes('caiyun.139.com')) {
        const url = this.extractURLFromText(line);
        if (url) {
          linkInfos.push({
            link: { url: url, type: 'mobile', password: '' },
            position: i,
            category: 'mobile'
          });
        }
      }

      // 检查密码/访问码（移动云盘主要使用访问码）
      const passwordKeywords = ['访问码', '密码'];
      for (const keyword of passwordKeywords) {
        if (line.includes(keyword)) {
          // 寻找冒号后面的内容
          let colonPos = line.indexOf(':');
          if (colonPos === -1) {
            colonPos = line.indexOf('：');
          }

          if (colonPos !== -1 && colonPos + 1 < line.length) {
            const password = line.substring(colonPos + 1).trim();
            // 如果密码长度超过10个字符，可能不是密码
            if (password.length <= 10) {
              passwordInfos.push({
                keyword: keyword,
                position: i,
                password: password
              });
            }
          }
        }
      }
    }

    // 第二遍：将密码与链接匹配
    for (const info of linkInfos) {
      // 检查链接自身是否包含密码
      const password = this.extractPasswordFromURL(info.link.url);
      if (password) {
        info.link.password = password;
        continue;
      }

      // 查找最近的密码
      let minDistance = 1000000;
      let closestPassword = '';

      for (const pwInfo of passwordInfos) {
        // 移动云盘匹配访问码或密码
        let match = false;

        if (info.category === 'mobile' && (pwInfo.keyword === '访问码' || pwInfo.keyword === '密码')) {
          match = true;
        }

        if (match) {
          const distance = Math.abs(pwInfo.position - info.position);
          if (distance < minDistance) {
            minDistance = distance;
            closestPassword = pwInfo.password;
          }
        }
      }

      // 只有当距离较近时才认为是匹配的密码
      if (minDistance <= 3) {
        info.link.password = closestPassword;
      }
    }

    // 收集所有有效链接
    for (const info of linkInfos) {
      allLinks.push(info.link);
    }

    return allLinks;
  }

  private extractURLFromText(text: string): string {
    // 查找URL的起始位置
    const urlPrefixes = ['http://', 'https://'];
    let start = -1;

    for (const prefix of urlPrefixes) {
      const pos = text.indexOf(prefix);
      if (pos !== -1) {
        start = pos;
        break;
      }
    }

    if (start === -1) {
      return '';
    }

    // 查找URL的结束位置
    let end = text.length;
    const endChars = [' ', '\t', '\n', '"', "'", '<', '>', ')', ']', '}', ',', ';'];

    for (const char of endChars) {
      const pos = text.indexOf(char, start);
      if (pos !== -1 && start + pos < end) {
        end = pos;
      }
    }

    return text.substring(start, end);
  }

  private extractPasswordFromURL(url: string): string {
    // 查找密码参数
    const pwdParams = ['pwd=', 'password=', 'passcode=', 'code='];

    for (const param of pwdParams) {
      const pos = url.indexOf(param);
      if (pos !== -1) {
        const start = pos + param.length;
        let end = url.length;

        // 查找参数结束位置
        for (let i = start; i < url.length; i++) {
          if (url[i] === '&' || url[i] === '#') {
            end = i;
            break;
          }
        }

        if (start < end) {
          return url.substring(start, end);
        }
      }
    }

    return '';
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
const plugin = new BixinPlugin();
export default plugin;