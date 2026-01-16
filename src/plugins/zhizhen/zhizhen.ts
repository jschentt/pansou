import {
  SearchResult,
  Link,
  PluginSearchResult,
} from "../../models/plugin-result";
import { BaseAsyncPlugin } from "../plugin.manager";
import axios, { AxiosInstance, AxiosResponse } from "axios";
import * as cheerio from "cheerio";

// 常量定义
const DefaultTimeout = 8000; // 默认超时时间 - 优化为更短时间
const DetailTimeout = 6000; // 详情页超时时间
const MaxConcurrency = 20; // 并发数限制 - 大幅提高并发数
const cacheTTL = 3600000; // 缓存TTL - 更短的缓存时间 (1小时)

// 性能统计
let searchRequests: number = 0;
let detailPageRequests: number = 0;
let cacheHits: number = 0;
let cacheMisses: number = 0;
let totalSearchTime: number = 0; // 纳秒
let totalDetailTime: number = 0; // 纳秒

// 预编译的正则表达式
const detailIDRegex = /\/vod\/detail\/id\/(\d+)\.html/;
const passwordRegex = /\?pwd=([0-9a-zA-Z]+)/;

// 常见网盘链接的正则表达式（支持16种类型）
const quarkLinkRegex = /https?:\/\/pan\.quark\.cn\/s\/[0-9a-zA-Z]+/;
const ucLinkRegex = /https?:\/\/drive\.uc\.cn\/s\/[0-9a-zA-Z]+(\?[^"'\s]*)?/;
const baiduLinkRegex =
  /https?:\/\/pan\.baidu\.com\/s\/[0-9a-zA-Z_\-]+(\?pwd=[0-9a-zA-Z]+)?/;
const aliyunLinkRegex =
  /https?:\/\/(www\.)?(aliyundrive\.com|alipan\.com)\/s\/[0-9a-zA-Z]+/;
const xunleiLinkRegex =
  /https?:\/\/pan\.xunlei\.com\/s\/[0-9a-zA-Z_\-]+(\?pwd=[0-9a-zA-Z]+)?/;
const tianyiLinkRegex = /https?:\/\/cloud\.189\.cn\/t\/[0-9a-zA-Z]+/;
const link115Regex = /https?:\/\/115\.com\/s\/[0-9a-zA-Z]+/;
const mobileLinkRegex = /https?:\/\/caiyun\.feixin\.10086\.cn\/[0-9a-zA-Z]+/;
const weiyunLinkRegex = /https?:\/\/share\.weiyun\.com\/[0-9a-zA-Z]+/;
const lanzouLinkRegex =
  /https?:\/\/(www\.)?(lanzou[uixys]*|lan[zs]o[ux])\.(com|net|org)\/[0-9a-zA-Z]+/;
const jianguoyunLinkRegex =
  /https?:\/\/(www\.)?jianguoyun\.com\/p\/[0-9a-zA-Z]+/;
const link123Regex = /https?:\/\/123pan\.com\/s\/[0-9a-zA-Z]+/;
const pikpakLinkRegex = /https?:\/\/mypikpak\.com\/s\/[0-9a-zA-Z]+/;
const magnetLinkRegex = /magnet:\?xt=urn:btih:[0-9a-fA-F]{40}/;
const ed2kLinkRegex = /ed2k:\/\/\|file\|.+\|\d+\|[0-9a-fA-F]{32}\|\//;

// 缓存
const detailCache = new Map<string, SearchResult>();

// ZhizhenAsyncPlugin Zhizhen异步插件
export class ZhizhenAsyncPlugin extends BaseAsyncPlugin {
  private optimizedClient: AxiosInstance;

  // 构造函数
  constructor() {
    super("zhizhen", 1);
    this.optimizedClient = this.createOptimizedHTTPClient();
  }

  // createOptimizedHTTPClient 创建优化的HTTP客户端
  private createOptimizedHTTPClient(): AxiosInstance {
    return axios.create({
      timeout: DefaultTimeout,
      maxRedirects: 5,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        Connection: "keep-alive",
      },
    });
  }

  // Search 同步搜索接口
  public async Search(
    keyword: string,
    ext: Record<string, any>
  ): Promise<SearchResult[]> {
    const result = await this.SearchWithResult(keyword, ext);
    return result.Results;
  }

  // SearchWithResult 带结果统计的搜索接口
  public async SearchWithResult(
    keyword: string,
    ext: Record<string, any>
  ): Promise<PluginSearchResult> {
    return this.AsyncSearchWithResult(
      keyword,
      this.searchImpl.bind(this),
      this.MainCacheKey,
      ext
    );
  }

  // searchImpl 实现具体的搜索逻辑
  private async searchImpl(
    client: AxiosInstance,
    keyword: string,
    ext: Record<string, any>
  ): Promise<SearchResult[]> {
    // 性能统计
    const start = Date.now();
    searchRequests++;

    try {
      // 使用优化的客户端
      const axiosClient = this.optimizedClient || client;

      // 1. 构建搜索URL
      const searchURL = `https://xiaomi666.fun/index.php/vod/search/wd/${encodeURIComponent(
        keyword
      )}.html`;

      // 2. 发送请求（带重试机制）
      const resp = await this.doRequestWithRetry(axiosClient, searchURL);

      // 3. 解析搜索结果页面
      const $ = cheerio.load(resp.data);

      // 4. 提取搜索结果
      const results: SearchResult[] = [];

      $(".module-search-item").each((i, s) => {
        const result = this.parseSearchItem($, $(s), keyword);
        if (result.UniqueID) {
          results.push(result);
        }
      });

      // 5. 异步获取详情页信息
      const enhancedResults = await this.enhanceWithDetails(
        axiosClient,
        results
      );

      // 6. 关键词过滤
      return this.FilterResultsByKeyword(enhancedResults, keyword);
    } catch (error) {
      throw new Error(`[${this.Name()}] 搜索失败: ${(error as Error).message}`);
    } finally {
      const duration = (Date.now() - start) * 1000000; // 转换为纳秒
      totalSearchTime += duration;
    }
  }

  // parseSearchItem 解析单个搜索结果项
  private parseSearchItem(
    $: cheerio.Root,
    s: cheerio.Cheerio,
    keyword: string
  ): SearchResult {
    const result: SearchResult = {} as SearchResult;

    // 提取详情页链接和ID
    const titleElement = s.find(".video-info-header h3 a").first();
    const detailLink = titleElement.attr("href");
    if (!detailLink) {
      return result;
    }

    // 提取ID
    const matches = detailIDRegex.exec(detailLink);
    if (!matches || matches.length < 2) {
      return result;
    }

    const itemID = matches[1];
    result.UniqueID = `${this.Name()}-${itemID}`;

    // 提取标题
    result.Title = titleElement.text().trim();

    // 提取资源类型/质量
    const qualityElement = s.find(".video-serial");
    const quality = qualityElement.text().trim();

    // 提取分类信息
    const tags: string[] = [];
    s.find(".video-info-aux .tag-link a").each((i, tag) => {
      const tagText = $(tag).text().trim();
      if (tagText) {
        tags.push(tagText);
      }
    });
    result.Tags = tags;

    // 提取导演信息
    let director = "";
    s.find(".video-info-items").each((i, item) => {
      const title = $(item).find(".video-info-itemtitle").text().trim();
      if (title.includes("导演")) {
        director = $(item).find(".video-info-actor a").text().trim();
      }
    });

    // 提取主演信息
    const actors: string[] = [];
    s.find(".video-info-items").each((i, item) => {
      const title = $(item).find(".video-info-itemtitle").text().trim();
      if (title.includes("主演")) {
        $(item)
          .find(".video-info-actor a")
          .each((j, actor) => {
            const actorName = $(actor).text().trim();
            if (actorName) {
              actors.push(actorName);
            }
          });
      }
    });

    // 提取剧情简介
    let plot = "";
    s.find(".video-info-items").each((i, item) => {
      const title = $(item).find(".video-info-itemtitle").text().trim();
      if (title.includes("剧情")) {
        plot = $(item).find(".video-info-item").text().trim();
      }
    });

    // 提取封面图片
    const images: string[] = [];
    const picURL = s.find(".module-item-pic > img").attr("data-src");
    if (picURL) {
      images.push(picURL);
    }
    result.Images = images;

    // 构建内容描述
    const contentParts: string[] = [];
    if (quality) {
      contentParts.push(`【${quality}】`);
    }
    if (director) {
      contentParts.push(`导演：${director}`);
    }
    if (actors.length > 0) {
      const actorStr = actors.slice(0, Math.min(3, actors.length)).join("、");
      if (actors.length > 3) {
        contentParts.push(`主演：${actorStr}等`);
      } else {
        contentParts.push(`主演：${actorStr}`);
      }
    }
    if (plot) {
      contentParts.push(plot);
    }

    result.Content = contentParts.join("\n");
    result.Channel = ""; // 插件搜索结果不设置频道名，只有Telegram频道结果才设置
    result.Datetime = new Date(0); // 使用零值

    return result;
  }

  // isValidNetworkDriveURL 检查URL是否为有效的网盘链接
  private isValidNetworkDriveURL(url: string): boolean {
    // 过滤掉明显无效的链接
    if (
      url.includes("javascript:") ||
      url.includes("#") ||
      !url ||
      (!url.startsWith("http") &&
        !url.startsWith("magnet:") &&
        !url.startsWith("ed2k:"))
    ) {
      return false;
    }

    // 检查是否匹配任何支持的网盘格式（16种）
    return (
      quarkLinkRegex.test(url) ||
      ucLinkRegex.test(url) ||
      baiduLinkRegex.test(url) ||
      aliyunLinkRegex.test(url) ||
      xunleiLinkRegex.test(url) ||
      tianyiLinkRegex.test(url) ||
      link115Regex.test(url) ||
      mobileLinkRegex.test(url) ||
      weiyunLinkRegex.test(url) ||
      lanzouLinkRegex.test(url) ||
      jianguoyunLinkRegex.test(url) ||
      link123Regex.test(url) ||
      pikpakLinkRegex.test(url) ||
      magnetLinkRegex.test(url) ||
      ed2kLinkRegex.test(url)
    );
  }

  // determineLinkType 根据URL确定链接类型（支持16种类型）
  private determineLinkType(url: string): string {
    if (quarkLinkRegex.test(url)) return "quark";
    if (ucLinkRegex.test(url)) return "uc";
    if (baiduLinkRegex.test(url)) return "baidu";
    if (aliyunLinkRegex.test(url)) return "aliyun";
    if (xunleiLinkRegex.test(url)) return "xunlei";
    if (tianyiLinkRegex.test(url)) return "tianyi";
    if (link115Regex.test(url)) return "115";
    if (mobileLinkRegex.test(url)) return "mobile";
    if (weiyunLinkRegex.test(url)) return "weiyun";
    if (lanzouLinkRegex.test(url)) return "lanzou";
    if (jianguoyunLinkRegex.test(url)) return "jianguoyun";
    if (link123Regex.test(url)) return "123";
    if (pikpakLinkRegex.test(url)) return "pikpak";
    if (magnetLinkRegex.test(url)) return "magnet";
    if (ed2kLinkRegex.test(url)) return "ed2k";
    return ""; // 不支持的类型返回空字符串
  }

  // enhanceWithDetails 异步获取详情页信息以获取下载链接
  private async enhanceWithDetails(
    client: AxiosInstance,
    results: SearchResult[]
  ): Promise<SearchResult[]> {
    // 限制并发数
    const semaphore = new Semaphore(MaxConcurrency);
    const enhancedResults: SearchResult[] = [];

    // 并行处理每个结果
    const promises = results.map(async (result) => {
      await semaphore.acquire();
      try {
        // 从UniqueID提取ID
        const parts = result.UniqueID.split("-");
        if (parts.length < 2) {
          return result;
        }

        const itemID = parts[1];

        // 检查缓存
        if (detailCache.has(itemID)) {
          cacheHits++;
          return detailCache.get(itemID)!;
        }
        cacheMisses++;

        // 获取详情页链接和图片
        const [detailLinks, detailImages] =
          await this.fetchDetailLinksAndImages(client, itemID);
        result.Links = detailLinks;

        // 合并图片：优先使用详情页的海报，如果没有则使用搜索结果的图片
        if (detailImages.length > 0) {
          result.Images = detailImages;
        }

        // 缓存结果
        detailCache.set(itemID, result);

        return result;
      } finally {
        semaphore.release();
      }
    });

    // 等待所有处理完成
    const resolvedResults = await Promise.all(promises);
    return resolvedResults;
  }

  // doRequestWithRetry 带重试机制的HTTP请求
  private async doRequestWithRetry(
    client: AxiosInstance,
    url: string
  ): Promise<AxiosResponse> {
    const maxRetries = 3;
    let lastError: Error | null = null;

    for (let i = 0; i < maxRetries; i++) {
      if (i > 0) {
        // 指数退避
        const backoff = Math.pow(2, i - 1) * 200;
        await new Promise((resolve) => setTimeout(resolve, backoff));
      }

      try {
        const resp = await client.get(url, {
          headers: {
            Referer: "https://xiaomi666.fun/",
            "Upgrade-Insecure-Requests": "1",
            "Cache-Control": "max-age=0",
          },
        });

        if (resp.status === 200) {
          return resp;
        }
        throw new Error(`返回状态码: ${resp.status}`);
      } catch (error) {
        lastError = error as Error;
      }
    }

    throw new Error(`重试 ${maxRetries} 次后仍然失败: ${lastError?.message}`);
  }

  // fetchDetailLinksAndImages 获取详情页的下载链接和图片
  private async fetchDetailLinksAndImages(
    client: AxiosInstance,
    itemID: string
  ): Promise<[Link[], string[]]> {
    // 性能统计
    const start = Date.now();
    detailPageRequests++;

    try {
      const detailURL = `https://xiaomi666.fun/index.php/vod/detail/id/${itemID}.html`;

      // 发送请求（带重试）
      const resp = await this.doRequestWithRetry(client, detailURL);

      // 解析详情页
      const $ = cheerio.load(resp.data);

      const links: Link[] = [];
      const images: string[] = [];

      // 提取详情页的海报图片
      const posterURL = $(".mobile-play .lazyload").attr("data-src");
      if (posterURL) {
        images.push(posterURL);
      }

      // 查找下载链接区域
      $("#download-list .module-row-one").each((i, s) => {
        // 从data-clipboard-text属性提取链接
        const linkURL = $(s)
          .find("[data-clipboard-text]")
          .attr("data-clipboard-text");
        if (linkURL) {
          // 过滤掉无效链接
          if (this.isValidNetworkDriveURL(linkURL)) {
            const linkType = this.determineLinkType(linkURL);
            if (linkType) {
              const link: Link = {
                Type: linkType,
                URL: linkURL,
                Password: "", // 大部分网盘不需要密码
              };
              links.push(link);
            }
          }
        }

        // 也检查直接的href属性
        $(s)
          .find("a[href]")
          .each((j, a) => {
            const linkURL = $(a).attr("href");
            if (linkURL) {
              // 过滤掉无效链接
              if (this.isValidNetworkDriveURL(linkURL)) {
                const linkType = this.determineLinkType(linkURL);
                if (linkType) {
                  // 避免重复添加
                  const isDuplicate = links.some(
                    (existingLink) => existingLink.URL === linkURL
                  );
                  if (!isDuplicate) {
                    const link: Link = {
                      Type: linkType,
                      URL: linkURL,
                      Password: "",
                    };
                    links.push(link);
                  }
                }
              }
            }
          });
      });

      return [links, images];
    } catch (error) {
      return [[], []];
    } finally {
      const duration = (Date.now() - start) * 1000000; // 转换为纳秒
      totalDetailTime += duration;
    }
  }

  // GetPerformanceStats 获取性能统计信息
  public GetPerformanceStats(): Record<string, any> {
    const totalSearchRequests = searchRequests;
    const totalDetailRequests = detailPageRequests;
    const totalCacheHits = cacheHits;
    const totalCacheMisses = cacheMisses;
    const totalSearchTimeNs = totalSearchTime;
    const totalDetailTimeNs = totalDetailTime;

    let avgSearchTime = 0;
    let avgDetailTime = 0;
    let cacheHitRate = 0;

    if (totalSearchRequests > 0) {
      avgSearchTime = totalSearchTimeNs / totalSearchRequests / 1e6; // 转换为毫秒
    }
    if (totalDetailRequests > 0) {
      avgDetailTime = totalDetailTimeNs / totalDetailRequests / 1e6; // 转换为毫秒
    }
    if (totalCacheHits + totalCacheMisses > 0) {
      cacheHitRate =
        (totalCacheHits / (totalCacheHits + totalCacheMisses)) * 100;
    }

    return {
      search_requests: totalSearchRequests,
      detail_page_requests: totalDetailRequests,
      cache_hits: totalCacheHits,
      cache_misses: totalCacheMisses,
      cache_hit_rate: cacheHitRate,
      avg_search_time_ms: avgSearchTime,
      avg_detail_time_ms: avgDetailTime,
      total_search_time_ns: totalSearchTimeNs,
      total_detail_time_ns: totalDetailTimeNs,
    };
  }
}

// 信号量实现，用于限制并发数
class Semaphore {
  private maxConcurrency: number;
  private current: number;
  private queue: (() => void)[];

  constructor(maxConcurrency: number) {
    this.maxConcurrency = maxConcurrency;
    this.current = 0;
    this.queue = [];
  }

  async acquire(): Promise<void> {
    if (this.current < this.maxConcurrency) {
      this.current++;
      return;
    }

    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
  }

  release(): void {
    if (this.queue.length > 0) {
      const resolve = this.queue.shift()!;
      resolve();
    } else {
      this.current--;
    }
  }
}

// 注册插件
BaseAsyncPlugin.RegisterGlobalPlugin(new ZhizhenAsyncPlugin());
