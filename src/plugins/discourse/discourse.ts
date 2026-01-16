import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios';
import { BaseAsyncPlugin } from '../plugin.manager';
import { SearchResult, Link } from '../../models/plugin-result';

// 正则表达式
const quarkRegex = /https:\/\/pan\.quark\.cn\/s\/[0-9a-zA-Z]+/g;
const baiduRegex = /https:\/\/pan\.baidu\.com\/s\/[0-9a-zA-Z_\-]+(?:\?pwd=([0-9a-zA-Z]+))?/g;
const aliyunRegex = /https:\/\/(?:www\.)?aliyundrive\.com\/s\/[0-9a-zA-Z]+/g;
const xunleiRegex = /https:\/\/pan\.xunlei\.com\/s\/[0-9a-zA-Z_\-]+(?:\?pwd=([0-9a-zA-Z]+))?/g;
const tianyiRegex = /https:\/\/cloud\.189\.cn\/t\/[0-9a-zA-Z]+/g;
const ucRegex = /https:\/\/drive\.uc\.cn\/s\/[0-9a-zA-Z]+/g;
const pan115Regex = /https:\/\/115\.com\/s\/[0-9a-zA-Z]+/g;
const baiduPwdRegex = /(?:提取码|密码|pwd)[：:]\s*([0-9a-zA-Z]{4})/g;
const htmlTagRegex = /<[^>]+>/g;
const whitespaceRegex = /\s+/g;

// 常量定义
const pluginName = "discourse";
const searchURLTemplate = "https://linux.do/search.json?q=%s%%20in%%3Atitle%%20%%23resource&page=%d";
const detailURLTemplate = "https://linux.do/t/%d.json?track_visit=true&forceLoad=true";
const defaultPriority = 2;
const defaultTimeout = 30000;
const defaultMaxPages = 1;
const maxAllowedPages = 10;
const pageRequestDelay = 500;

// 类型定义
interface SearchResponse {
  posts: Post[];
  topics: Topic[];
  grouped_search_result: GroupedSearchResult;
}

interface Post {
  id: number;
  name: string;
  username: string;
  created_at: string;
  like_count: number;
  blurb: string;
  topic_id: number;
}

interface Topic {
  id: number;
  title: string;
  fancy_title: string;
  tags: string[];
  posts_count: number;
  created_at: string;
  category_id: number;
}

interface GroupedSearchResult {
  term: string;
  post_ids: number[];
  more_full_page_results: boolean;
}

interface DetailResponse {
  post_stream: PostStream;
  id: number;
  title: string;
  tags: string[];
}

interface PostStream {
  posts: DetailPost[];
}

interface DetailPost {
  id: number;
  username: string;
  created_at: string;
  cooked: string;
  topic_id: number;
  link_counts: LinkCount[];
}

interface LinkCount {
  url: string;
  internal: boolean;
  reflection: boolean;
  clicks: number;
}

export class DiscoursePlugin extends BaseAsyncPlugin {
  constructor() {
    super(pluginName, defaultPriority);
  }

  Name(): string {
    return pluginName;
  }

  DisplayName(): string {
    return 'Discourse 论坛';
  }

  Description(): string {
    return 'Linux.do 论坛资源搜索插件';
  }

  protected async searchImpl(client: AxiosInstance, keyword: string): Promise<SearchResult[]> {
    try {
      // 提取 max_pages 参数（最多获取多少页）
      let maxPages = defaultMaxPages;
      
      // 限制最大页数
      if (maxPages > maxAllowedPages) {
        maxPages = maxAllowedPages;
      }
      if (maxPages < 1) {
        maxPages = 1;
      }

      // 提取起始page参数（默认为1）
      const startPage = 1;

      // URL编码关键词
      const encodedKeyword = encodeURIComponent(keyword);
      
      // 存储所有结果
      const allResults: SearchResult[] = [];
      const seenPostIDs = new Set<number>(); // 用于去重
      let fetchedPages = 0; // 实际获取的页数
      
      // 循环获取多页
      for (let currentPage = startPage; currentPage < startPage + maxPages; currentPage++) {
        fetchedPages++;
        // 如果不是第一页，添加延迟避免请求过快
        if (currentPage > startPage) {
          await new Promise(resolve => setTimeout(resolve, pageRequestDelay));
        }
        
        const searchURL = searchURLTemplate.replace('%s', encodedKeyword).replace('%d', currentPage.toString());
        
        // 发送搜索请求
        const resp = await this.doRequestWithRetry(client, searchURL);

        // 检查HTTP状态码
        if (resp.status !== 200) {
          // 如果已经获取到一些结果，返回已有结果
          if (allResults.length > 0) {
            console.warn(`[${this.Name()}] Warning: unexpected status code ${resp.status} on page ${currentPage}`);
            break;
          }
          throw new Error(`[${this.Name()}] unexpected status code: ${resp.status} on page ${currentPage}`);
        }

        // 解析JSON响应
        const searchResp: SearchResponse = resp.data;

        // 如果没有帖子了，停止获取
        if (searchResp.posts.length === 0) {
          break;
        }
        
        // 转换为SearchResult并去重
        const pageResults = this.convertToSearchResults(searchResp);
        
        // 添加结果（去重）
        for (const result of pageResults) {
          // 从 UniqueID 中提取帖子ID
          const postIDMatch = result.UniqueID.match(/discourse-(\d+)/);
          if (postIDMatch && postIDMatch.length >= 2) {
            const postID = parseInt(postIDMatch[1]);
            if (!seenPostIDs.has(postID)) {
              seenPostIDs.add(postID);
              allResults.push(result);
            }
          }
        }
        
        // 如果 API 返回没有更多结果了，停止获取
        if (!searchResp.grouped_search_result.more_full_page_results) {
          break;
        }
        
        // 如果这一页没有新的结果，也停止
        if (pageResults.length === 0) {
          break;
        }
      }
      
      // 如果启用了多页获取，在日志中显示获取的总结果数
      if (maxPages > 1 && allResults.length > 0) {
        console.log(`[${this.Name()}] Fetched ${allResults.length} unique results from ${fetchedPages} pages for keyword: ${keyword}`);
      }

      return allResults;
    } catch (error) {
      console.error(`[${this.Name()}] 搜索失败:`, error);
      return [];
    }
  }

  private async doRequestWithRetry(client: AxiosInstance, url: string): Promise<AxiosResponse> {
    const maxRetries = 3;
    let lastError: any = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const resp = await client.get(url, {
          headers: this.setCommonHeaders(),
          timeout: defaultTimeout
        });

        if (resp.status === 200) {
          return resp;
        }
      } catch (error) {
        lastError = error;
        if (attempt < maxRetries - 1) {
          const backoff = Math.pow(2, attempt) * 1000;
          await new Promise(resolve => setTimeout(resolve, backoff));
        }
      }
    }

    throw new Error(`[${this.Name()}] 重试 ${maxRetries} 次后仍然失败: ${lastError?.message}`);
  }

  private setCommonHeaders(): Record<string, string> {
    return {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'Connection': 'keep-alive',
      'Referer': 'https://linux.do/'
    };
  }

  private convertToSearchResults(resp: SearchResponse): SearchResult[] {
    const results: SearchResult[] = [];

    // 创建 topic 映射，方便快速查找
    const topicMap = new Map<number, Topic>();
    for (const topic of resp.topics) {
      topicMap.set(topic.id, topic);
    }

    // 遍历所有帖子
    for (const post of resp.posts) {
      // 获取对应的主题
      let topic = topicMap.get(post.topic_id);
      if (!topic) {
        // 如果找不到主题，使用默认值
        topic = {
          id: post.topic_id,
          title: '未知标题',
          fancy_title: '未知标题',
          tags: [],
          posts_count: 0,
          created_at: post.created_at,
          category_id: 0
        };
      }

      // 从blurb中提取网盘链接
      const links = this.extractNetDiskLinksFromBlurb(post.blurb);

      // 如果没有提取到链接，跳过这个结果
      if (links.length === 0) {
        continue;
      }

      // 解析时间
      const createdAt = new Date(post.created_at);

      // 构建 SearchResult
      const result: SearchResult = {
        UniqueID: `${pluginName}-${post.id}`,
        Title: topic.title,
        Content: this.cleanContent(post.blurb),
        Links: links,
        Tags: topic.tags,
        Channel: '', // 插件搜索结果必须为空
        Datetime: createdAt,
        MessageID: `${pluginName}-${post.id}`
      };

      results.push(result);
    }

    return results;
  }

  private extractNetDiskLinksFromBlurb(blurb: string): Link[] {
    const links: Link[] = [];

    // 提取夸克网盘
    let match;
    while ((match = quarkRegex.exec(blurb)) !== null) {
      links.push({
        Type: "quark",
        URL: match[0],
        Password: ""
      });
    }

    // 重置正则表达式状态
    quarkRegex.lastIndex = 0;

    // 提取百度网盘（带提取码）
    while ((match = baiduRegex.exec(blurb)) !== null) {
      const link: Link = {
        Type: "baidu",
        URL: match[0],
        Password: ""
      };
      // 如果URL中包含pwd参数
      if (match.length > 1 && match[1]) {
        link.Password = match[1];
      } else {
        // 尝试从文本中查找提取码
        const pwdMatch = baiduPwdRegex.exec(blurb);
        if (pwdMatch && pwdMatch.length > 1) {
          link.Password = pwdMatch[1];
        }
      }
      links.push(link);
    }

    // 重置正则表达式状态
    baiduRegex.lastIndex = 0;
    baiduPwdRegex.lastIndex = 0;

    // 提取阿里云盘
    while ((match = aliyunRegex.exec(blurb)) !== null) {
      links.push({
        Type: "aliyun",
        URL: match[0],
        Password: ""
      });
    }

    // 重置正则表达式状态
    aliyunRegex.lastIndex = 0;

    // 提取迅雷网盘（带提取码）
    while ((match = xunleiRegex.exec(blurb)) !== null) {
      const link: Link = {
        Type: "xunlei",
        URL: match[0],
        Password: ""
      };
      if (match.length > 1 && match[1]) {
        link.Password = match[1];
      }
      links.push(link);
    }

    // 重置正则表达式状态
    xunleiRegex.lastIndex = 0;

    // 提取天翼云盘
    while ((match = tianyiRegex.exec(blurb)) !== null) {
      links.push({
        Type: "tianyi",
        URL: match[0],
        Password: ""
      });
    }

    // 重置正则表达式状态
    tianyiRegex.lastIndex = 0;

    // 提取UC网盘
    while ((match = ucRegex.exec(blurb)) !== null) {
      links.push({
        Type: "uc",
        URL: match[0],
        Password: ""
      });
    }

    // 重置正则表达式状态
    ucRegex.lastIndex = 0;

    // 提取115网盘
    while ((match = pan115Regex.exec(blurb)) !== null) {
      links.push({
        Type: "115",
        URL: match[0],
        Password: ""
      });
    }

    // 重置正则表达式状态
    pan115Regex.lastIndex = 0;

    return links;
  }

  private cleanContent(content: string): string {
    // 移除HTML标签
    content = content.replace(htmlTagRegex, '');
    
    // 解码HTML实体
    content = content
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");
    
    // 移除多余空白
    content = content.replace(whitespaceRegex, ' ').trim();
    
    // 限制长度
    if (content.length > 200) {
      content = content.substring(0, 200) + "...";
    }
    
    return content;
  }

  // GetTopicDetail 获取主题详情（可选实现，用于获取完整链接）
  private async getTopicDetail(client: AxiosInstance, topicID: number): Promise<Link[]> {
    try {
      // 构建详情URL
      const detailURL = detailURLTemplate.replace('%d', topicID.toString());

      // 发送详情请求
      const resp = await client.get(detailURL, {
        headers: this.setCommonHeaders(),
        timeout: defaultTimeout
      });

      // 检查HTTP状态码
      if (resp.status !== 200) {
        throw new Error(`unexpected status code: ${resp.status}`);
      }

      // 解析JSON响应
      const detailResp: DetailResponse = resp.data;

      // 提取第一个帖子的链接
      if (detailResp.post_stream.posts.length === 0) {
        throw new Error('no posts found');
      }

      const mainPost = detailResp.post_stream.posts[0];
      
      // 从 link_counts 中提取网盘链接
      const links: Link[] = [];
      for (const linkCount of mainPost.link_counts) {
        // 跳过内部链接
        if (linkCount.internal) {
          continue;
        }
        
        // 判断是否为网盘链接并解析
        const link = this.parseNetDiskLink(linkCount.url);
        if (link) {
          links.push(link);
        }
      }

      return links;
    } catch (error) {
      console.error(`[${this.Name()}] 获取主题详情失败:`, error);
      return [];
    }
  }

  private parseNetDiskLink(linkURL: string): Link | null {
    // 夸克网盘
    if (quarkRegex.test(linkURL)) {
      quarkRegex.lastIndex = 0;
      return {
        Type: "quark",
        URL: linkURL,
        Password: ""
      };
    }
    quarkRegex.lastIndex = 0;

    // 百度网盘
    if (baiduRegex.test(linkURL)) {
      baiduRegex.lastIndex = 0;
      const match = baiduRegex.exec(linkURL);
      if (match) {
        const link: Link = {
          Type: "baidu",
          URL: linkURL,
          Password: ""
        };
        // 提取pwd参数
        if (match.length > 1 && match[1]) {
          link.Password = match[1];
        }
        baiduRegex.lastIndex = 0;
        return link;
      }
      baiduRegex.lastIndex = 0;
    }

    // 阿里云盘
    if (aliyunRegex.test(linkURL)) {
      aliyunRegex.lastIndex = 0;
      return {
        Type: "aliyun",
        URL: linkURL,
        Password: ""
      };
    }
    aliyunRegex.lastIndex = 0;

    // 迅雷网盘
    if (xunleiRegex.test(linkURL)) {
      xunleiRegex.lastIndex = 0;
      const match = xunleiRegex.exec(linkURL);
      if (match) {
        const link: Link = {
          Type: "xunlei",
          URL: linkURL,
          Password: ""
        };
        // 提取pwd参数
        if (match.length > 1 && match[1]) {
          link.Password = match[1];
        }
        xunleiRegex.lastIndex = 0;
        return link;
      }
      xunleiRegex.lastIndex = 0;
    }

    // 天翼云盘
    if (tianyiRegex.test(linkURL)) {
      tianyiRegex.lastIndex = 0;
      return {
        Type: "tianyi",
        URL: linkURL,
        Password: ""
      };
    }
    tianyiRegex.lastIndex = 0;

    // UC网盘
    if (ucRegex.test(linkURL)) {
      ucRegex.lastIndex = 0;
      return {
        Type: "uc",
        URL: linkURL,
        Password: ""
      };
    }
    ucRegex.lastIndex = 0;

    // 115网盘
    if (pan115Regex.test(linkURL)) {
      pan115Regex.lastIndex = 0;
      return {
        Type: "115",
        URL: linkURL,
        Password: ""
      };
    }
    pan115Regex.lastIndex = 0;

    // 不是网盘链接
    return null;
  }
}

// 注册插件
const plugin = new DiscoursePlugin();
plugin.register();
