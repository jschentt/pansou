import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import * as cheerio from 'cheerio';
import { SearchResult, Link } from '../../types';
import { Plugin } from '../../types/plugin';

// 缓存相关变量
let detailPageCache = new Map<string, { data: any; timestamp: number }>();
let searchResultCache = new Map<string, { data: any; timestamp: number }>();
let linkTypeCache = new Map<string, string>();
let lastCacheCleanTime = Date.now();

// 常用UA列表
const userAgents = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:120.0) Gecko/20100101 Firefox/120.0',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
];

// 缓存TTL
const cacheTTL = 1 * 60 * 60 * 1000; // 1小时

// 启动缓存清理
function startCacheCleaner() {
  // 每小时清理一次缓存
  setInterval(() => {
    // 清空所有缓存
    detailPageCache = new Map();
    searchResultCache = new Map();
    linkTypeCache = new Map();
    lastCacheCleanTime = Date.now();
  }, 1 * 60 * 60 * 1000);
}

// 获取随机UA
function getRandomUA(): string {
  return userAgents[Math.floor(Math.random() * userAgents.length)];
}

// 常量定义
const SearchURL = 'https://www.4khdr.cn/search.php?mod=forum';
const ThreadURLPattern = 'https://www.4khdr.cn/thread-%s-1-1.html';
const DefaultTimeout = 10000;
const MaxRetries = 2;
const MaxConcurrency = 20;

class Semaphore {
  private available: number;
  private queue: Array<() => void> = [];

  constructor(initial: number) {
    this.available = initial;
  }

  async acquire(): Promise<void> {
    return new Promise((resolve) => {
      if (this.available > 0) {
        this.available--;
        resolve();
      } else {
        this.queue.push(resolve);
      }
    });
  }

  release(): void {
    this.available++;
    if (this.queue.length > 0) {
      const resolve = this.queue.shift();
      if (resolve) {
        resolve();
      }
    }
  }
}

class Hdr4kPlugin implements Plugin {
  constructor() {
    // 启动缓存清理
    startCacheCleaner();
  }

  name(): string {
    return 'hdr4k';
  }

  displayName(): string {
    return '4KHDR';
  }

  description(): string {
    return '4KHDR - 4K影视资源网盘下载链接搜索';
  }

  async search(keyword: string, ext: Record<string, any>): Promise<SearchResult[]> {
    return this.doSearch(axios.create({ timeout: DefaultTimeout }), keyword, ext);
  }

  private async doSearch(client: AxiosInstance, keyword: string, ext: Record<string, any>): Promise<SearchResult[]> {
    // 处理ext参数
    let searchKeyword = keyword;
    if (ext) {
      if (ext.title_en && typeof ext.title_en === 'string') {
        // 使用英文标题替换关键词
        searchKeyword = ext.title_en;
      }
    }

    // 构建POST请求数据
    const formData = new URLSearchParams();
    formData.append('srchtxt', searchKeyword);
    formData.append('searchsubmit', 'yes');

    const config: AxiosRequestConfig = {
      method: 'POST',
      url: SearchURL,
      headers: {
        'User-Agent': getRandomUA(),
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': 'https://www.4khdr.cn/'
      },
      data: formData.toString()
    };

    // 发送POST请求（带重试）
    const resp = await this.doRequestWithRetry(client, config, MaxRetries);

    // 解析HTML
    const $ = cheerio.load(resp.data);

    // 预先收集所有需要处理的项
    const items: cheerio.Cheerio[] = [];

    // 将关键词转为小写，用于不区分大小写的比较
    const lowerKeyword = keyword.toLowerCase();

    // 将关键词按空格分割，用于支持多关键词搜索
    const keywords = lowerKeyword.split(/\s+/).filter(kw => kw);

    // 预先过滤不包含关键词的帖子
    $('.slst.mtw ul li.pbw').each((i, element) => {
      // 提取帖子ID
      const postID = $(element).attr('id');
      if (!postID) {
        return;
      }

      // 提取标题
      const titleElement = $(element).find('h3.xs3 a');
      const title = this.cleanHTML(titleElement.text()).trim();
      const lowerTitle = title.toLowerCase();

      if (!title) {
        return;
      }

      // 提取内容描述
      const contentElement = $(element).find('p').first();
      const content = this.cleanHTML(contentElement.text()).trim();
      const lowerContent = content.toLowerCase();

      // 检查每个关键词是否在标题或内容中
      let matched = true;
      for (const kw of keywords) {
        // 对于所有关键词，检查是否在标题或内容中
        if (!lowerTitle.includes(kw) && !lowerContent.includes(kw)) {
          matched = false;
          break;
        }
      }

      // 只添加匹配的帖子
      if (matched) {
        items.push($(element));
      }
    });

    // 并发处理每个搜索结果项
    const semaphore = new Semaphore(MaxConcurrency);
    const tasks: Promise<SearchResult | null>[] = [];

    for (let i = 0; i < items.length; i++) {
      const s = items[i];
      tasks.push((async () => {
        await semaphore.acquire();
        try {
          // 提取帖子ID
          const postID = s.attr('id');
          if (!postID) {
            return null;
          }

          // 提取标题
          const titleElement = s.find('h3.xs3 a');
          const title = this.cleanHTML(titleElement.text()).trim();

          // 提取内容描述
          const contentElement = s.find('p').first();
          let content = this.cleanHTML(contentElement.text()).trim();

          // 提取日期时间
          let datetime = new Date();
          const dateElements = s.find('p span');
          if (dateElements.length > 0) {
            const dateStr = dateElements.first().text().trim();
            if (dateStr) {
              const parsedTime = this.parseDateTime(dateStr);
              if (parsedTime) {
                datetime = parsedTime;
              }
            }
          }

          // 提取分类标签
          const tags: string[] = [];
          const categoryElement = s.find('p span a.xi1');
          if (categoryElement.length > 0) {
            const category = categoryElement.text().trim();
            if (category) {
              tags.push(category);
            }
          }

          // 获取详情页链接，并尝试获取下载链接
          let links: Link[] = [];
          let detailContent = '';
          try {
            [links, detailContent] = await this.getLinksFromDetail(client, postID);
          } catch (err) {
            // 如果获取链接失败，仍然返回结果，但没有链接
            links = [];
          }

          // 如果从详情页获取到了更详细的内容，使用详情页的内容
          if (detailContent) {
            content = detailContent;
          }

          // 检查是否是无意义的求片帖（没有实际资源的求片帖）
          if (this.isEmptyRequestPost(title, links)) {
            return null;
          }

          // 创建搜索结果
          const result: SearchResult = {
            uniqueId: `hdr4k-${postID}`,
            title: title,
            content: content,
            datetime: datetime,
            links: links,
            tags: tags,
            pluginName: this.name(),
            displayName: this.displayName(),
            channel: ''
          };

          return result;
        } finally {
          semaphore.release();
        }
      })());
    }

    // 收集结果
    const results = await Promise.all(tasks);
    return results.filter((r): r is SearchResult => r !== null);
  }

  private isEmptyRequestPost(title: string, links: Link[]): boolean {
    const lowerTitle = title.toLowerCase();

    // 如果有实际的下载链接，不过滤
    if (links.length > 0) {
      return false;
    }

    // 只过滤明确的无资源求片关键词
    const emptyRequestKeywords = [
      '求片',
      '有资源吗',
      '有没有资源',
      '跪求',
      '求资源'
    ];

    for (const keyword of emptyRequestKeywords) {
      if (lowerTitle.includes(keyword)) {
        return true;
      }
    }

    // 对于求网盘的帖子，如果没有链接才过滤
    const cloudRequestKeywords = [
      '求阿里云盘',
      '求百度网盘',
      '求夸克网盘',
      '求迅雷网盘',
      '求天翼云盘'
    ];

    for (const keyword of cloudRequestKeywords) {
      if (lowerTitle.includes(keyword)) {
        // 只有当没有实际链接时才过滤
        return links.length === 0;
      }
    }

    // 检查是否以"求"开头，但要排除正常的电影名称
    if (lowerTitle.startsWith('求')) {
      // 如果标题很短且以"求"开头，且没有链接，很可能是求片帖
      if (title.length < 10 && !lowerTitle.includes('年') && !lowerTitle.includes('季') && links.length === 0) {
        return true;
      }
    }

    return false;
  }

  private async getLinksFromDetail(client: AxiosInstance, postID: string): Promise<[Link[], string]> {
    // 生成缓存键
    const cacheKey = `detail:${postID}`;

    // 检查缓存中是否已有结果
    const cachedData = detailPageCache.get(cacheKey);
    if (cachedData) {
      // 检查缓存是否过期
      if (Date.now() - cachedData.timestamp < cacheTTL) {
        return [cachedData.data.links, cachedData.data.content];
      }
    }

    // 构建详情页URL
    const detailURL = ThreadURLPattern.replace('%s', postID);

    const config: AxiosRequestConfig = {
      method: 'GET',
      url: detailURL,
      headers: {
        'User-Agent': getRandomUA(),
        'Referer': 'https://www.4khdr.cn/'
      }
    };

    // 发送GET请求（带重试）
    const resp = await this.doRequestWithRetry(client, config, MaxRetries);

    // 解析HTML
    const $ = cheerio.load(resp.data);

    // 提取详情页内容
    let links: Link[] = [];
    let detailContent = '';

    // 查找帖子内容区域和回复区域
    const contentSelectors = [
      '.t_f',           // 主帖内容
      '[id^=postmessage_]' // 回复内容（以postmessage_开头的id）
    ];

    for (const selector of contentSelectors) {
      $(selector).each((i, contentArea) => {
        // 如果还没有提取到详细内容，提取剧情简介等
        if (!detailContent) {
          const content = this.cleanHTML($(contentArea).text()).trim();
          // 提取前500个字符作为详细描述
          if (content.length > 500) {
            detailContent = content.substring(0, 500) + '...';
          } else if (content.length > 50) {
            detailContent = content;
          }
        }

        // 提取下载链接
        $(contentArea).find('a').each((j, linkElement) => {
          const href = $(linkElement).attr('href');
          if (!href) {
            return;
          }

          // 检查是否是网盘链接
          const linkType = this.determineLinkType(href, '');
          if (linkType !== 'others') {
            // 检查是否已经存在相同的链接
            const exists = links.some(existingLink => existingLink.url === href);
            if (!exists) {
              const link: Link = {
                url: href,
                type: linkType,
                password: '' // 4KHDR通常不提供密码
              };
              links.push(link);
            }
          }
        });
      });
    }

    // 缓存结果
    detailPageCache.set(cacheKey, {
      data: { links, content: detailContent },
      timestamp: Date.now()
    });

    return [links, detailContent];
  }

  private determineLinkType(url: string, name: string): string {
    // 生成缓存键
    const cacheKey = `${url}:${name}`;

    // 检查缓存
    const cachedType = linkTypeCache.get(cacheKey);
    if (cachedType) {
      return cachedType;
    }

    const lowerURL = url.toLowerCase();
    const lowerName = name.toLowerCase();

    let linkType: string;

    // 根据URL判断
    switch (true) {
      case lowerURL.includes('pan.quark.cn'):
        linkType = 'quark';
        break;
      case lowerURL.includes('pan.baidu.com'):
        linkType = 'baidu';
        break;
      case lowerURL.includes('alipan.com') || lowerURL.includes('aliyundrive.com'):
        linkType = 'aliyun';
        break;
      case lowerURL.includes('pan.xunlei.com'):
        linkType = 'xunlei';
        break;
      case lowerURL.includes('cloud.189.cn'):
        linkType = 'tianyi';
        break;
      case lowerURL.includes('115.com'):
        linkType = '115';
        break;
      case lowerURL.includes('drive.uc.cn'):
        linkType = 'uc';
        break;
      case lowerURL.includes('caiyun.139.com'):
        linkType = 'mobile';
        break;
      case lowerURL.includes('share.weiyun.com'):
        linkType = 'weiyun';
        break;
      case lowerURL.includes('lanzou'):
        linkType = 'lanzou';
        break;
      case lowerURL.includes('jianguoyun.com'):
        linkType = 'jianguoyun';
        break;
      case lowerURL.includes('123pan.com'):
        linkType = '123';
        break;
      case lowerURL.includes('mypikpak.com'):
        linkType = 'pikpak';
        break;
      case lowerURL.startsWith('magnet:'):
        linkType = 'magnet';
        break;
      case lowerURL.startsWith('ed2k:'):
        linkType = 'ed2k';
        break;
      default:
        // 根据名称判断
        switch (true) {
          case lowerName.includes('百度'):
            linkType = 'baidu';
            break;
          case lowerName.includes('阿里'):
            linkType = 'aliyun';
            break;
          case lowerName.includes('迅雷'):
            linkType = 'xunlei';
            break;
          case lowerName.includes('夸克'):
            linkType = 'quark';
            break;
          case lowerName.includes('天翼'):
            linkType = 'tianyi';
            break;
          case lowerName.includes('115'):
            linkType = '115';
            break;
          case lowerName.includes('uc'):
            linkType = 'uc';
            break;
          case lowerName.includes('移动') || lowerName.includes('彩云'):
            linkType = 'mobile';
            break;
          case lowerName.includes('微云'):
            linkType = 'weiyun';
            break;
          case lowerName.includes('蓝奏'):
            linkType = 'lanzou';
            break;
          case lowerName.includes('坚果'):
            linkType = 'jianguoyun';
            break;
          case lowerName.includes('123'):
            linkType = '123';
            break;
          case lowerName.includes('pikpak'):
            linkType = 'pikpak';
            break;
          default:
            linkType = 'others';
        }
    }

    // 缓存结果
    linkTypeCache.set(cacheKey, linkType);

    return linkType;
  }

  private async doRequestWithRetry(client: AxiosInstance, config: AxiosRequestConfig, maxRetries: number): Promise<any> {
    for (let i = 0; i <= maxRetries; i++) {
      // 如果不是第一次尝试，等待一段时间
      if (i > 0) {
        // 指数退避算法
        const backoff = Math.min(Math.pow(2, i - 1) * 500, 5000);
        await new Promise(resolve => setTimeout(resolve, backoff));
      }

      try {
        const resp = await client(config);
        return resp;
      } catch (err: any) {
        // 如果错误不可重试，直接抛出
        if (!this.isRetriableError(err)) {
          throw err;
        }
        // 如果是最后一次尝试，抛出错误
        if (i === maxRetries) {
          throw err;
        }
      }
    }

    // 理论上不会到达这里
    throw new Error('请求失败');
  }

  private isRetriableError(err: any): boolean {
    if (!err) {
      return false;
    }

    // 判断是否是网络错误或超时错误
    if (err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT') {
      return true;
    }

    // 其他可能需要重试的错误类型
    const errStr = err.message || '';
    return errStr.includes('connection refused') ||
           errStr.includes('connection reset') ||
           errStr.includes('EOF');
  }

  private parseDateTime(dateStr: string): Date | null {
    // 4KHDR的时间格式：2025-4-9 19:55
    const layouts = [
      'YYYY-M-D HH:mm',
      'YYYY-MM-DD HH:mm:ss',
      'YYYY-M-D HH:mm:ss',
      'YYYY-MM-DD HH:mm'
    ];

    for (const layout of layouts) {
      const date = this.parseDateWithLayout(dateStr, layout);
      if (date) {
        return date;
      }
    }

    return null;
  }

  private parseDateWithLayout(dateStr: string, layout: string): Date | null {
    try {
      // 简单的日期解析
      if (layout === 'YYYY-M-D HH:mm') {
        const match = dateStr.match(/^(\d{4})-(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})$/);
        if (match) {
          const [, year, month, day, hour, minute] = match.map(Number);
          return new Date(year, month - 1, day, hour, minute);
        }
      } else if (layout === 'YYYY-MM-DD HH:mm:ss') {
        const match = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})$/);
        if (match) {
          const [, year, month, day, hour, minute, second] = match.map(Number);
          return new Date(year, month - 1, day, hour, minute, second);
        }
      } else if (layout === 'YYYY-M-D HH:mm:ss') {
        const match = dateStr.match(/^(\d{4})-(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2}):(\d{2})$/);
        if (match) {
          const [, year, month, day, hour, minute, second] = match.map(Number);
          return new Date(year, month - 1, day, hour, minute, second);
        }
      } else if (layout === 'YYYY-MM-DD HH:mm') {
        const match = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})$/);
        if (match) {
          const [, year, month, day, hour, minute] = match.map(Number);
          return new Date(year, month - 1, day, hour, minute);
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  private cleanHTML(html: string): string {
    // 替换常见HTML标签和实体
    const replacements: Record<string, string> = {
      '<strong>': '',
      '</strong>': '',
      '<font color="#ff0000">': '',
      '</font>': '',
      '<em>': '',
      '</em>': '',
      '<b>': '',
      '</b>': '',
      '<br>': '\n',
      '<br/>': '\n',
      '<br />': '\n',
      '&nbsp;': ' ',
      '&hellip;': '...',
      '&amp;': '&',
      '&lt;': '<',
      '&gt;': '>',
      '&quot;': '"',
      '&#039;': "'"
    };

    let result = html;
    for (const [oldStr, newStr] of Object.entries(replacements)) {
      result = result.replace(new RegExp(oldStr, 'g'), newStr);
    }

    // 移除其他HTML标签（简单的正则表达式）
    result = result.replace(/<[^>]*>/g, '');

    // 清理多余的空白字符
    result = result.replace(/\s+/g, ' ');

    return result.trim();
  }
}

// 导出插件实例
const plugin = new Hdr4kPlugin();
export default plugin;