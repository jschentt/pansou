import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios';
import { BaseAsyncPlugin } from '../plugin.manager';
import { SearchResult, Link } from '../../models/plugin-result';

const MaxConcurrentUsers = 10;
const MaxConcurrentWeibo = 30;
const MaxComments = 1;
const DebugLog = false;

// 预编译的正则表达式
const passwordRegex = /\?pwd=([0-9a-zA-Z]+)/;
const quarkLinkRegex = /https?:\/\/pan\.quark\.cn\/s\/[0-9a-zA-Z]+/;
const ucLinkRegex = /https?:\/\/drive\.uc\.cn\/s\/[0-9a-zA-Z]+(\?[^"'\s]*)?/;
const baiduLinkRegex = /https?:\/\/pan\.baidu\.com\/s\/[0-9a-zA-Z_\-]+(\?pwd=[0-9a-zA-Z]+)?/;
const aliyunLinkRegex = /https?:\/\/(www\.)?(aliyundrive\.com|alipan\.com)\/s\/[0-9a-zA-Z]+/;
const xunleiLinkRegex = /https?:\/\/pan\.xunlei\.com\/s\/[0-9a-zA-Z_\-]+(\?pwd=[0-9a-zA-Z]+)?/;
const tianyiLinkRegex = /https?:\/\/cloud\.189\.cn\/t\/[0-9a-zA-Z]+/;
const link115Regex = /https?:\/\/115\.com\/s\/[0-9a-zA-Z]+/;
const mobileLinkRegex = /https?:\/\/caiyun\.feixin\.10086\.cn\/[0-9a-zA-Z]+/;
const link123Regex = /https?:\/\/123pan\.com\/s\/[0-9a-zA-Z]+/;
const pikpakLinkRegex = /https?:\/\/mypikpak\.com\/s\/[0-9a-zA-Z]+/;
const magnetLinkRegex = /magnet:\?xt=urn:btih:[0-9a-fA-F]{40}/;
const ed2kLinkRegex = /ed2k:\/\/\|file\|[^\|]+\|\d+\|[0-9a-fA-F]{32}\|\//;

interface User {
  Hash: string;
  Cookie: string;
  Status: string;
  UserIDs: string[];
  CreatedAt: Date;
  LoginAt: Date;
  ExpireAt: Date;
  LastAccessAt: Date;
  LastRefresh: Date;
}

interface UserTask {
  UserID: string;
  Cookie: string;
}

interface Comment {
  Text: string;
  URLs: string[];
}

class Semaphore {
  private maxConcurrent: number;
  private currentConcurrent: number;
  private waiting: Array<() => void>;

  constructor(maxConcurrent: number) {
    this.maxConcurrent = maxConcurrent;
    this.currentConcurrent = 0;
    this.waiting = [];
  }

  async acquire(): Promise<void> {
    if (this.currentConcurrent < this.maxConcurrent) {
      this.currentConcurrent++;
      return;
    }

    return new Promise<void>((resolve) => {
      this.waiting.push(resolve);
    });
  }

  release(): void {
    this.currentConcurrent--;
    if (this.waiting.length > 0) {
      const next = this.waiting.shift();
      if (next) {
        this.currentConcurrent++;
        next();
      }
    }
  }
}

export class WeiboPlugin extends BaseAsyncPlugin {
  private users: Map<string, User>;
  private initialized: boolean;

  constructor() {
    super('weibo', 3);
    this.users = new Map();
    this.initialized = false;
  }

  Name(): string {
    return 'weibo';
  }

  DisplayName(): string {
    return '微博';
  }

  Description(): string {
    return '微博 - 从微博搜索网盘资源';
  }

  private async doRequestWithRetry(client: AxiosInstance, config: AxiosRequestConfig): Promise<AxiosResponse> {
    const maxRetries = 2;
    let lastError: Error | null = null;

    for (let i = 0; i < maxRetries; i++) {
      try {
        const response = await client(config);
        if (response.status === 200) {
          return response;
        }
      } catch (error) {
        lastError = error as Error;
      }

      if (i < maxRetries - 1) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }

    throw new Error(`请求失败，已重试${maxRetries}次: ${lastError?.message}`);
  }

  protected async searchImpl(client: AxiosInstance, keyword: string): Promise<SearchResult[]> {
    if (!this.initialized) {
      await this.initialize();
    }

    const users = this.getActiveUsers();
    if (DebugLog) {
      console.log(`[Weibo] 找到 ${users.length} 个有效用户`);
    }

    if (users.length === 0) {
      if (DebugLog) {
        console.log(`[Weibo] 没有有效用户，返回空结果`);
      }
      return [];
    }

    if (users.length > MaxConcurrentUsers) {
      // 按最后访问时间排序
      users.sort((a, b) => b.LastAccessAt.getTime() - a.LastAccessAt.getTime());
      users.splice(MaxConcurrentUsers);
    }

    const tasks = this.buildUserTasks(users);
    const results = await this.executeTasks(tasks, keyword, client);

    if (DebugLog) {
      console.log(`[Weibo] 搜索完成，返回 ${results.length} 条结果`);
    }

    return results;
  }

  private async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    // 初始化存储目录（在实际应用中可以使用localStorage或其他存储）
    this.initialized = true;
  }

  private getActiveUsers(): User[] {
    const users: User[] = [];
    const now = new Date();

    this.users.forEach(user => {
      if (user.Status !== 'active') {
        return;
      }

      if (user.ExpireAt && now > user.ExpireAt) {
        user.Status = 'expired';
        user.Cookie = '';
        this.saveUser(user);
        return;
      }

      if (user.UserIDs.length === 0) {
        return;
      }

      users.push(user);
    });

    return users;
  }

  private saveUser(user: User): void {
    this.users.set(user.Hash, user);
    // 在实际应用中，这里会保存到文件或数据库
  }

  private buildUserTasks(users: User[]): UserTask[] {
    const userOwners = new Map<string, User[]>();

    users.forEach(user => {
      user.UserIDs.forEach(uid => {
        if (!userOwners.has(uid)) {
          userOwners.set(uid, []);
        }
        userOwners.get(uid)?.push(user);
      });
    });

    const tasks: UserTask[] = [];
    const userTaskCount = new Map<string, number>();

    userOwners.forEach((owners, uid) => {
      let selectedUser = owners[0];
      let minTasks = userTaskCount.get(selectedUser.Hash) || 0;

      owners.forEach(owner => {
        const count = userTaskCount.get(owner.Hash) || 0;
        if (count < minTasks) {
          selectedUser = owner;
          minTasks = count;
        }
      });

      // 检查是否需要刷新Cookie（每小时刷新一次）
      let cookie = selectedUser.Cookie;
      if (new Date().getTime() - selectedUser.LastRefresh.getTime() > 60 * 60 * 1000) {
        if (DebugLog) {
          console.log(`[Weibo] Cookie已使用超过1小时，刷新短期令牌...`);
        }
        // 在实际应用中，这里会实现Cookie刷新逻辑
        selectedUser.LastRefresh = new Date();
        this.saveUser(selectedUser);
      }

      tasks.push({
        UserID: uid,
        Cookie: cookie
      });

      userTaskCount.set(selectedUser.Hash, (userTaskCount.get(selectedUser.Hash) || 0) + 1);
    });

    return tasks;
  }

  private async executeTasks(tasks: UserTask[], keyword: string, client: AxiosInstance): Promise<SearchResult[]> {
    const allResults: SearchResult[] = [];
    const semaphore = new Semaphore(MaxConcurrentWeibo);

    const promises = tasks.map(async (task) => {
      await semaphore.acquire();
      try {
        const results = await this.searchUserWeibo(task.UserID, task.Cookie, keyword, client);
        allResults.push(...results);
      } finally {
        semaphore.release();
      }
    });

    await Promise.all(promises);
    return allResults;
  }

  private async searchUserWeibo(uid: string, cookie: string, keyword: string, client: AxiosInstance): Promise<SearchResult[]> {
    const results: SearchResult[] = [];
    const maxPages = 3;

    for (let page = 1; page <= maxPages; page++) {
      try {
        const apiURL = `https://weibo.com/ajax/profile/searchblog`;
        const params = {
          uid: uid,
          feature: 0,
          q: keyword,
          page: page
        };

        const resp = await this.doRequestWithRetry(client, {
          url: apiURL,
          method: 'GET',
          params: params,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Referer': 'https://weibo.com/',
            'Accept': 'application/json, text/plain, */*',
            'Accept-Language': 'zh-CN,zh;q=0.9',
            'Cookie': cookie
          },
          timeout: 30000
        });

        const apiResp = resp.data;
        const okValue = apiResp.ok;
        const isOK = okValue === 1 || okValue === true;

        if (!isOK) {
          if (DebugLog) {
            console.log(`[Weibo] API返回失败, msg=${apiResp.msg}, 停止搜索`);
          }
          break;
        }

        const data = apiResp.data;
        if (!data) {
          if (DebugLog) {
            console.log(`[Weibo] data字段为nil`);
          }
          break;
        }

        const list = data.list || [];

        if (DebugLog) {
          console.log(`[Weibo] 第${page}页返回${list.length}条微博`);
        }

        if (list.length === 0) {
          break;
        }

        // 处理每条微博
        for (let i = 0; i < list.length; i++) {
          const weiboData = list[i];
          const result = this.parseWeibo(weiboData, uid);

          // 获取微博ID用于获取评论
          let weiboID = '';
          if (weiboData.idstr) {
            weiboID = weiboData.idstr;
          } else if (weiboData.id) {
            weiboID = weiboData.id.toString();
          }

          if (DebugLog) {
            console.log(`[Weibo] 微博${i+1}: 标题=${result.Title.substring(0, 30)}, 正文链接数=${result.Links.length}`);
          }

          // 如果正文没有网盘链接，才获取评论
          if (result.Links.length === 0 && weiboID) {
            if (DebugLog) {
              console.log(`[Weibo] 正文无链接，获取评论...`);
            }
            const comments = await this.getComments(weiboID, cookie, MaxComments, client);

            let commentLinkCount = 0;
            for (const comment of comments) {
              // 1. 从评论文本直接提取网盘链接
              const commentLinks = this.extractNetworkDriveLinks(comment.Text, result.Datetime);

              // 2. 从评论中的URLs提取网盘链接
              for (const decodedURL of comment.URLs) {
                // 先尝试直接匹配网盘链接
                const directLinks = this.extractNetworkDriveLinks(decodedURL, result.Datetime);
                if (directLinks.length > 0) {
                  commentLinks.push(...directLinks);
                } else {
                  // 不是网盘链接，尝试抓取页面内容
                  if (DebugLog) {
                    console.log(`[Weibo] 评论链接不是网盘，抓取页面: ${decodedURL}`);
                  }
                  try {
                    const pageLinks = await this.fetchPageAndExtractLinks(decodedURL, result.Datetime, client);
                    commentLinks.push(...pageLinks);
                  } catch (error) {
                    if (DebugLog) {
                      console.log(`[Weibo] 抓取页面失败: ${error}`);
                    }
                  }
                }
              }

              // 添加到结果
              result.Links.push(...commentLinks);
              commentLinkCount += commentLinks.length;
            }

            if (DebugLog) {
              console.log(`[Weibo] 获取${comments.length}条评论, 评论链接数=${commentLinkCount}, 总链接数=${result.Links.length}`);
            }
          }

          if (result.Links.length > 0) {
            results.push(result);

            if (DebugLog) {
              console.log(`[Weibo] ✓ 找到网盘链接: ${result.Title}, 链接数: ${result.Links.length}`);
            }
          }
        }

        await new Promise(resolve => setTimeout(resolve, 1000));
      } catch (error) {
        if (DebugLog) {
          console.log(`[Weibo] 搜索失败: ${error}`);
        }
        break;
      }
    }

    if (DebugLog) {
      console.log(`[Weibo] 用户${uid}搜索完成, 共${results.length}条结果`);
    }
    return results;
  }

  private async getComments(weiboID: string, cookie: string, maxComments: number, client: AxiosInstance): Promise<Comment[]> {
    const comments: Comment[] = [];
    let maxID = 0;
    let maxIDType = 0;

    while (comments.length < maxComments) {
      try {
        const apiURL = `https://m.weibo.cn/comments/hotflow`;
        const params = {
          id: weiboID,
          mid: weiboID,
          max_id: maxID,
          max_id_type: maxIDType
        };

        const resp = await this.doRequestWithRetry(client, {
          url: apiURL,
          method: 'GET',
          params: params,
          headers: {
            'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 14_0 like Mac OS X) AppleWebKit/605.1.15',
            'Referer': 'https://m.weibo.cn/',
            'Accept': 'application/json, text/plain, */*',
            'Cookie': cookie
          },
          timeout: 30000
        });

        const apiResp = resp.data;
        const data = apiResp.data;
        if (!data) {
          break;
        }

        const commentList = data.data || [];
        if (commentList.length === 0) {
          break;
        }

        for (const item of commentList) {
          const rawText = item.text || '';
          const cleanText = this.cleanHTML(rawText);
          const urls = this.extractURLsFromComment(rawText);

          comments.push({
            Text: cleanText,
            URLs: urls
          });

          if (comments.length >= maxComments) {
            break;
          }
        }

        const newMaxID = data.max_id || 0;
        if (newMaxID === 0 || newMaxID === maxID) {
          break;
        }

        maxID = newMaxID;
        maxIDType = data.max_id_type || 0;

        await new Promise(resolve => setTimeout(resolve, 500));
      } catch (error) {
        if (DebugLog) {
          console.log(`[Weibo] 获取评论失败: ${error}`);
        }
        break;
      }
    }

    if (DebugLog && comments.length > 0) {
      console.log(`[Weibo] 获取到${comments.length}条评论`);
    }

    return comments;
  }

  private parseWeibo(weibo: any, uid: string): SearchResult {
    // 优先使用text_raw，其次使用text
    let textRaw = weibo.text_raw || weibo.text || '';

    // 先获取发布时间
    const createdAt = weibo.created_at || '';
    let publishTime = new Date();
    if (createdAt) {
      try {
        // 尝试解析微博时间格式
        publishTime = new Date(createdAt);
      } catch (error) {
        // 解析失败，使用当前时间
      }
    }

    const text = this.cleanHTML(textRaw);

    if (DebugLog && text) {
      const isLongText = weibo.isLongText;
      const truncated = isLongText ? ' [长文本-可能被截断]' : '';
      console.log(`[Weibo DEBUG] 微博原始文本${truncated}: ${text.substring(0, 200)}`);
    }

    // 1. 直接从文本中提取网盘链接
    const links = this.extractNetworkDriveLinks(text, publishTime);

    // 构建搜索结果
    const result: SearchResult = {
      UniqueID: `${this.Name()}-${weibo.id || Date.now()}`,
      Title: text.substring(0, 100),
      Content: text,
      Channel: '',
      MessageID: `${this.Name()}-${weibo.id || Date.now()}`,
      Datetime: publishTime,
      Links: links,
      Tags: []
    };

    return result;
  }

  private extractNetworkDriveLinks(text: string, datetime: Date): Link[] {
    const links: Link[] = [];
    const linkMap = new Set<string>();

    // 提取百度网盘链接
    const baiduMatches = text.matchAll(baiduLinkRegex);
    for (const match of baiduMatches) {
      const url = match[0];
      if (!linkMap.has(url)) {
        linkMap.add(url);
        const password = this.extractPassword(url);
        links.push({
          Type: 'baidu',
          URL: url,
          Password: password
        });
      }
    }

    // 提取夸克网盘链接
    const quarkMatches = text.matchAll(quarkLinkRegex);
    for (const match of quarkMatches) {
      const url = match[0];
      if (!linkMap.has(url)) {
        linkMap.add(url);
        links.push({
          Type: 'quark',
          URL: url,
          Password: ''
        });
      }
    }

    // 提取UC网盘链接
    const ucMatches = text.matchAll(ucLinkRegex);
    for (const match of ucMatches) {
      const url = match[0];
      if (!linkMap.has(url)) {
        linkMap.add(url);
        links.push({
          Type: 'uc',
          URL: url,
          Password: ''
        });
      }
    }

    // 提取阿里云盘链接
    const aliyunMatches = text.matchAll(aliyunLinkRegex);
    for (const match of aliyunMatches) {
      const url = match[0];
      if (!linkMap.has(url)) {
        linkMap.add(url);
        links.push({
          Type: 'aliyun',
          URL: url,
          Password: ''
        });
      }
    }

    // 提取迅雷网盘链接
    const xunleiMatches = text.matchAll(xunleiLinkRegex);
    for (const match of xunleiMatches) {
      const url = match[0];
      if (!linkMap.has(url)) {
        linkMap.add(url);
        const password = this.extractPassword(url);
        links.push({
          Type: 'xunlei',
          URL: url,
          Password: password
        });
      }
    }

    // 提取天翼云盘链接
    const tianyiMatches = text.matchAll(tianyiLinkRegex);
    for (const match of tianyiMatches) {
      const url = match[0];
      if (!linkMap.has(url)) {
        linkMap.add(url);
        links.push({
          Type: 'tianyi',
          URL: url,
          Password: ''
        });
      }
    }

    // 提取115网盘链接
    const link115Matches = text.matchAll(link115Regex);
    for (const match of link115Matches) {
      const url = match[0];
      if (!linkMap.has(url)) {
        linkMap.add(url);
        links.push({
          Type: '115',
          URL: url,
          Password: ''
        });
      }
    }

    // 提取移动云盘链接
    const mobileMatches = text.matchAll(mobileLinkRegex);
    for (const match of mobileMatches) {
      const url = match[0];
      if (!linkMap.has(url)) {
        linkMap.add(url);
        links.push({
          Type: 'mobile',
          URL: url,
          Password: ''
        });
      }
    }

    // 提取123网盘链接
    const link123Matches = text.matchAll(link123Regex);
    for (const match of link123Matches) {
      const url = match[0];
      if (!linkMap.has(url)) {
        linkMap.add(url);
        links.push({
          Type: '123',
          URL: url,
          Password: ''
        });
      }
    }

    // 提取pikpak链接
    const pikpakMatches = text.matchAll(pikpakLinkRegex);
    for (const match of pikpakMatches) {
      const url = match[0];
      if (!linkMap.has(url)) {
        linkMap.add(url);
        links.push({
          Type: 'pikpak',
          URL: url,
          Password: ''
        });
      }
    }

    // 提取磁力链接
    const magnetMatches = text.matchAll(magnetLinkRegex);
    for (const match of magnetMatches) {
      const url = match[0];
      if (!linkMap.has(url)) {
        linkMap.add(url);
        links.push({
          Type: 'magnet',
          URL: url,
          Password: ''
        });
      }
    }

    // 提取ed2k链接
    const ed2kMatches = text.matchAll(ed2kLinkRegex);
    for (const match of ed2kMatches) {
      const url = match[0];
      if (!linkMap.has(url)) {
        linkMap.add(url);
        links.push({
          Type: 'ed2k',
          URL: url,
          Password: ''
        });
      }
    }

    return links;
  }

  private extractPassword(url: string): string {
    const matches = passwordRegex.exec(url);
    if (matches && matches[1]) {
      return matches[1];
    }
    return '';
  }

  private cleanHTML(html: string): string {
    // 移除HTML标签
    return html.replace(/<[^>]*>/g, '');
  }

  private extractURLsFromComment(html: string): string[] {
    const urls: string[] = [];
    const urlRegex = /https:\/\/weibo\.cn\/sinaurl\?u=([^"&\s]+)/g;
    let match;

    while ((match = urlRegex.exec(html)) !== null) {
      if (match[1]) {
        try {
          const decoded = decodeURIComponent(match[1]);
          urls.push(decoded);
        } catch (error) {
          // 解码失败，跳过
        }
      }
    }

    return urls;
  }

  private async fetchPageAndExtractLinks(pageURL: string, datetime: Date, client: AxiosInstance): Promise<Link[]> {
    try {
      const resp = await client.get(pageURL, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
        },
        timeout: 15000
      });

      if (resp.status !== 200) {
        return [];
      }

      // 从HTML中提取网盘链接
      const htmlContent = resp.data;
      return this.extractNetworkDriveLinks(htmlContent, datetime);
    } catch (error) {
      if (DebugLog) {
        console.log(`[Weibo] 抓取页面失败: ${error}`);
      }
      return [];
    }
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
const plugin = new WeiboPlugin();
plugin.register();
