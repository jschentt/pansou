import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import cheerio from 'cheerio';
import { SearchResult, Link } from '../../types';
import { Plugin } from '../../types/plugin';


const BaseURL = 'https://leijing.xyz';
const SearchPath = '/search';
const UserAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36';
const MaxConcurrency = 20; // 详情页最大并发数
const MaxPages = 1; // 最大搜索页数（暂时只搜索第一页）

interface DetailCacheEntry {
  links: Link[];
  timestamp: number;
}

class LeijingPlugin implements Plugin {
  private debugMode: boolean;
  private detailCache: Map<string, DetailCacheEntry>;
  private cacheTTL: number;

  constructor() {
    this.debugMode = false; // 默认关闭调试
    this.detailCache = new Map();
    this.cacheTTL = 30 * 60 * 1000; // 30分钟，单位毫秒
  }

  name(): string {
    return 'leijing';
  }

  displayName(): string {
    return '雷鲸小站';
  }

  description(): string {
    return '雷鲸小站 - 天翼云盘资源分享站';
  }

  async search(keyword: string, ext: Record<string, any>): Promise<SearchResult[]> {
    return this.searchImpl(keyword, ext);
  }

  private async searchImpl(keyword: string, ext: Record<string, any>): Promise<SearchResult[]> {
    const searchURL = `${BaseURL}${SearchPath}?keyword=${encodeURIComponent(keyword)}`;

    if (this.debugMode) {
      console.log(`[Leijing] 开始搜索: ${keyword}`);
      console.log(`[Leijing] 搜索URL: ${searchURL}`);
    }

    try {
      // 发送搜索请求
      const config: AxiosRequestConfig = {
        method: 'GET',
        url: searchURL,
        headers: this.setRequestHeaders(BaseURL),
        responseType: 'arraybuffer' // 用于处理gzip压缩
      };

      const resp = await this.doRequest(config);

      // 解析HTML
      const $ = cheerio.load(resp.data);

      // 提取搜索结果
      const results = this.extractSearchResults($, keyword);

      if (this.debugMode) {
        console.log(`[Leijing] 找到 ${results.length} 个搜索结果`);
      }

      // 对于没有直接提取到链接的结果，访问详情页获取链接
      const enrichedResults = await this.enrichWithDetailLinks(results, keyword);

      // 过滤结果（去掉没有链接的）
      const filteredResults = this.filterValidResults(enrichedResults);

      if (this.debugMode) {
        console.log(`[Leijing] 过滤后剩余 ${filteredResults.length} 个有效结果`);
      }

      return filteredResults;
    } catch (error) {
      console.error(`[Leijing] 搜索失败:`, error);
      return [];
    }
  }

  private setRequestHeaders(referer: string): Record<string, string> {
    return {
      'User-Agent': UserAgent,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'Accept-Encoding': 'gzip, deflate',
      'Cache-Control': 'no-cache',
      'Pragma': 'no-cache',
      'Referer': referer
    };
  }

  private async doRequest(config: AxiosRequestConfig): Promise<any> {
    const client = axios.create({
      timeout: 10000,
      headers: config.headers
    });

    try {
      if (this.debugMode) {
        console.log(`[Leijing] 发送请求: ${config.url}`);
      }

      const resp = await client(config);

      if (this.debugMode) {
        console.log(`[Leijing] 响应状态: ${resp.status}`);
      }

      return resp;
    } catch (error) {
      if (this.debugMode) {
        console.log(`[Leijing] 请求失败:`, error);
      }
      throw error;
    }
  }

  private extractSearchResults($: cheerio.Root, keyword: string): SearchResult[] {
    const results: SearchResult[] = [];

    // 选择所有搜索结果项
    $('.topicItem').each((i, s) => {
      // 提取标题和详情页链接
      const titleElem = $(s).find('.title a');
      const title = titleElem.text().trim();
      const detailPath = titleElem.attr('href');

      if (title === '' || !detailPath) {
        return;
      }

      // 构建完整的详情页URL
      let detailURL = BaseURL + '/' + detailPath.replace(/^\//, '');

      // 提取摘要（可能包含链接）
      const summary = $(s).find('.summary').text().trim();

      // 提取其他信息
      let postTime = $(s).find('.postTime').text().trim();
      postTime = postTime.replace(/^发表时间：/, '');

      // 从详情页路径提取ID（如：thread?topicId=42230 -> 42230）
      const idMatch = /topicId=(\d+)/.exec(detailPath);
      let resourceID = '';
      if (idMatch && idMatch[1]) {
        resourceID = idMatch[1];
      } else {
        resourceID = Date.now().toString();
      }

      if (this.debugMode) {
        console.log(`[Leijing] 提取结果 ${i+1}: ${title}, URL: ${detailURL}`);
      }

      // 尝试从摘要中提取天翼云盘链接
      const links = this.extractTianyiLinks(summary);

      if (this.debugMode) {
        console.log(`[Leijing] 从摘要中提取到 ${links.length} 个链接`);
      }

      // 解析时间
      let publishTime = new Date();
      if (postTime) {
        const parsedTime = new Date(postTime);
        if (!isNaN(parsedTime.getTime())) {
          publishTime = parsedTime;
        }
      }

      const result: SearchResult = {
        uniqueId: `${this.name()}-${resourceID}`,
        title: title,
        content: summary,
        datetime: publishTime,
        links: links,
        channel: '',
        tags: [],
        images: [],
        pluginName: this.name(),
        displayName: this.displayName()
      };

      // 如果没有从摘要中提取到链接，将详情页URL存储在Tags中供后续使用
      if (links.length === 0) {
        result.tags = [detailURL];
      }

      results.push(result);
    });

    return results;
  }

  private extractTianyiLinks(text: string): Link[] {
    const links: Link[] = [];

    // 天翼云盘链接正则
    const tianyiRegex = /https:\/\/cloud\.189\.cn\/t\/[a-zA-Z0-9]+/g;
    const matches = text.match(tianyiRegex) || [];

    // 去重
    const linkMap = new Set<string>();
    for (const match of matches) {
      if (!linkMap.has(match)) {
        linkMap.add(match);
        links.push({
          url: match,
          type: 'tianyi',
          password: ''
        });
      }
    }

    return links;
  }

  private async enrichWithDetailLinks(results: SearchResult[], keyword: string): Promise<SearchResult[]> {
    if (this.debugMode) {
      console.log(`[Leijing] 开始获取详情页链接`);
    }

    const semaphore = this.createSemaphore(MaxConcurrency);

    const promises = results.map(async (result, idx) => {
      // 如果已经有链接了，跳过
      if (result.links.length > 0) {
        return result;
      }

      // 如果没有详情页URL，跳过
      if (result.tags.length === 0) {
        return result;
      }

      await semaphore.acquire();
      try {
        // 添加小延迟避免请求过快
        await this.sleep(idx * 50);

        const detailURL = result.tags[0];
        const links = await this.fetchDetailPageLinks(detailURL);

        if (links.length > 0) {
          result.links = links;
        }

        // 清空Tags
        result.tags = [];

        if (this.debugMode) {
          console.log(`[Leijing] 详情页 ${idx+1}/${results.length} 获取到 ${links.length} 个链接`);
        }

        return result;
      } catch (error) {
        console.error(`[Leijing] 处理详情页失败:`, error);
        return result;
      } finally {
        semaphore.release();
      }
    });

    return Promise.all(promises);
  }

  private async fetchDetailPageLinks(detailURL: string): Promise<Link[]> {
    // 检查缓存
    const cached = this.detailCache.get(detailURL);
    if (cached && Date.now() < cached.timestamp + this.cacheTTL) {
      if (this.debugMode) {
        console.log(`[Leijing] 使用缓存的详情页结果: ${detailURL}`);
      }
      return cached.links;
    }

    try {
      // 访问详情页
      const config: AxiosRequestConfig = {
        method: 'GET',
        url: detailURL,
        headers: this.setRequestHeaders(BaseURL),
        responseType: 'arraybuffer' // 用于处理gzip压缩
      };

      const resp = await this.doRequest(config);

      // 解析HTML
      const $ = cheerio.load(resp.data);

      // 提取详情页中的天翼云盘链接
      const links = this.extractDetailPageLinks($);

      // 缓存结果
      if (links.length > 0) {
        this.detailCache.set(detailURL, {
          links: links,
          timestamp: Date.now()
        });

        // 设置缓存过期
        setTimeout(() => {
          this.detailCache.delete(detailURL);
        }, this.cacheTTL);
      }

      return links;
    } catch (error) {
      if (this.debugMode) {
        console.log(`[Leijing] 获取详情页失败:`, error);
      }
      return [];
    }
  }

  private extractDetailPageLinks($: cheerio.Root): Link[] {
    const links: Link[] = [];
    const linkMap = new Set<string>(); // 用于去重

    // 从详情页内容中查找所有链接
    $('.topicContent a[href*="cloud.189.cn"]').each((i, s) => {
      const href = $(s).attr('href');
      if (!href) return;

      // 去重
      if (linkMap.has(href)) return;
      linkMap.add(href);

      links.push({
        url: href,
        type: 'tianyi',
        password: ''
      });

      if (this.debugMode) {
        console.log(`[Leijing] 提取到天翼云盘链接: ${href}`);
      }
    });

    // 如果没有找到链接，尝试从文本中提取
    if (links.length === 0) {
      const content = $('.topicContent').text();
      const textLinks = this.extractTianyiLinks(content);
      links.push(...textLinks);
    }

    return links;
  }

  private filterValidResults(results: SearchResult[]): SearchResult[] {
    const validResults: SearchResult[] = [];

    for (const result of results) {
      if (result.links.length > 0) {
        validResults.push(result);
      } else if (this.debugMode) {
        console.log(`[Leijing] 忽略无链接结果: ${result.title}`);
      }
    }

    return validResults;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private createSemaphore(maxConcurrency: number): {
    acquire: () => Promise<void>;
    release: () => void;
  } {
    let count = 0;
    const queue: (() => void)[] = [];

    return {
      acquire: async () => {
        if (count < maxConcurrency) {
          count++;
        } else {
          await new Promise<void>(resolve => queue.push(resolve));
        }
      },
      release: () => {
        count--;
        if (queue.length > 0) {
          const resolve = queue.shift();
          if (resolve) resolve();
        }
      }
    };
  }
}

// 导出插件实例
const plugin = new LeijingPlugin();
export default plugin;