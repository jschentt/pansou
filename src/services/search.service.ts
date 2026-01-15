import { Injectable } from '@nestjs/common';
import { SearchRequest } from '../models/search-request';
import { SearchResponse, SearchResult, MergedLinks, MergedLink, Link } from '../models/response';
import { CacheService } from './cache.service';
import * as ParserUtil from '../util/parser-util';
import * as HttpUtil from '../util/http-util';
import { AppConfig } from '../config/config';
import * as crypto from 'crypto';

// 优先关键词列表
const priorityKeywords = ['合集', '系列', '全', '完', '最新', '附', 'complete'];

// 结果评分结构
interface ResultScore {
  result: SearchResult;
  timeScore: number;    // 时间得分
  keywordScore: number; // 关键词得分
  pluginScore: number;  // 插件等级得分
  totalScore: number;   // 综合得分
}

@Injectable()
export class SearchService {
  constructor(private readonly cacheService: CacheService) {}

  async search(request: SearchRequest): Promise<SearchResponse> {
    // 确保ext不为nil
    if (!request.ext) {
      request.ext = {};
    }

    // 参数预处理
    // 源类型标准化
    const sourceType = request.sourceType || 'all';

    // 插件参数规范化处理
    let plugins: string[] | undefined = request.plugins;
    if (sourceType === 'tg') {
      // 对于只搜索Telegram的请求，忽略插件参数
      plugins = undefined;
    } else if (sourceType === 'all' || sourceType === 'plugin') {
      // 检查是否为空列表或只包含空字符串
      if (plugins && plugins.length > 0) {
        const hasNonEmpty = plugins.some(p => p !== '');
        if (!hasNonEmpty) {
          plugins = undefined;
        } else {
          // TODO: 根据插件管理器实现插件过滤逻辑
        }
      }
    }

    // 如果未指定并发数，使用配置中的默认值
    const concurrency = request.concurrency || AppConfig?.defaultConcurrency || 10;

    // 并行获取TG搜索和插件搜索结果
    let tgResults: SearchResult[] = [];
    let pluginResults: SearchResult[] = [];

    // 如果需要搜索TG
    if (sourceType === 'all' || sourceType === 'tg') {
      tgResults = await this.searchTG(request.keyword, request.channels || [], request.forceRefresh);
    }
    // 如果需要搜索插件（且插件功能已启用）
    if ((sourceType === 'all' || sourceType === 'plugin') && AppConfig?.asyncPluginEnabled) {
      // TODO: 实现插件搜索功能
      pluginResults = [];
    }

    // 合并结果
    const allResults = this.mergeSearchResults(tgResults, pluginResults);

    // 按照优化后的规则排序结果
    this.sortResultsByTimeAndKeywords(allResults);

    // 过滤结果，只保留有时间的结果或包含优先关键词的结果或高等级插件结果到Results中
    const filteredForResults = allResults.filter(result => {
      const source = this.getResultSource(result);
      const pluginLevel = this.getPluginLevelBySource(source);
      
      // 有时间的结果或包含优先关键词的结果或高等级插件(1-2级)结果保留在Results中
      return result.datetime !== '' || this.getKeywordPriority(result.title) > 0 || pluginLevel <= 2;
    });

    // 合并链接按网盘类型分组（使用所有过滤后的结果）
    const mergedLinks = this.mergeResultsByType(allResults, request.keyword, request.cloudTypes || []);

    // 构建响应
    let total = 0;
    if (request.resultType === 'merged_by_type') {
      // 计算所有类型链接的总数
      total = Object.values(mergedLinks).reduce((sum, links) => sum + links.length, 0);
    } else {
      // 只计算filteredForResults的数量
      total = filteredForResults.length;
    }

    const response: SearchResponse = {
      total,
      results: filteredForResults, // 使用进一步过滤的结果
      mergedByType: mergedLinks,
    };

    // 根据resultType过滤返回结果
    return this.filterResponseByType(response, request.resultType || 'merged_by_type');
  }

  // filterResponseByType 根据结果类型过滤响应
  private filterResponseByType(response: SearchResponse, resultType: string): SearchResponse {
    switch (resultType) {
      case 'merged_by_type':
        // 只返回MergedByType，Results设为nil
        return {
          total: response.total,
          mergedByType: response.mergedByType,
          results: undefined,
        };
      case 'all':
        return response;
      case 'results':
        // 只返回Results
        return {
          total: response.total,
          results: response.results,
        };
      default:
        return {
          total: response.total,
          mergedByType: response.mergedByType,
          results: undefined,
        };
    }
  }

  // 合并搜索结果，去重并保留最完整的信息
  private mergeSearchResults(existing: SearchResult[], newResults: SearchResult[]): SearchResult[] {
    // 使用map进行去重和合并，以UniqueID作为唯一标识
    const resultMap = new Map<string, SearchResult>();
    
    // 先添加现有结果
    for (const result of existing) {
      const key = this.generateResultKey(result);
      resultMap.set(key, result);
    }
    
    // 合并新结果，如果UniqueID相同则选择信息更完整的
    for (const newResult of newResults) {
      const key = this.generateResultKey(newResult);
      if (resultMap.has(key)) {
        // 选择信息更完整的结果
        const existingResult = resultMap.get(key)!;
        resultMap.set(key, this.selectBetterResult(existingResult, newResult));
      } else {
        // 新结果，直接添加
        resultMap.set(key, newResult);
      }
    }
    
    // 转换回切片
    return Array.from(resultMap.values());
  }

  // 生成结果的唯一标识键
  private generateResultKey(result: SearchResult): string {
    // 使用UniqueID作为主要标识，如果没有则使用MessageID，最后使用标题
    if (result.uniqueId) {
      return result.uniqueId;
    }
    if (result.messageId) {
      return result.messageId;
    }
    return `title_${result.title}_${result.channel}`;
  }

  // 选择信息更完整的结果
  private selectBetterResult(existing: SearchResult, newResult: SearchResult): SearchResult {
    // 计算信息完整度得分
    const existingScore = this.calculateCompletenessScore(existing);
    const newScore = this.calculateCompletenessScore(newResult);
    
    if (newScore > existingScore) {
      return newResult;
    }
    return existing;
  }

  // 计算结果信息的完整度得分
  private calculateCompletenessScore(result: SearchResult): number {
    let score = 0;
    
    // 有UniqueID加分
    if (result.uniqueId) {
      score += 10;
    }
    
    // 有链接信息加分
    if (result.links && result.links.length > 0) {
      score += 5;
      // 每个链接额外加分
      score += result.links.length;
    }
    
    // 有内容加分
    if (result.content) {
      score += 3;
    }
    
    // 标题长度加分（更详细的标题）
    score += Math.floor(result.title.length / 10);
    
    // 有频道信息加分
    if (result.channel) {
      score += 2;
    }
    
    // 有标签加分
    if (result.tags) {
      score += result.tags.length;
    }
    
    return score;
  }

  // 根据时间和关键词排序结果
  private sortResultsByTimeAndKeywords(results: SearchResult[]): void {
    // 1. 计算每个结果的综合得分
    const scores: ResultScore[] = results.map(result => {
      const source = this.getResultSource(result);
      const timeScore = this.calculateTimeScore(result.datetime);
      const keywordScore = this.getKeywordPriority(result.title);
      const pluginScore = this.getPluginLevelScore(source);
      
      return {
        result,
        timeScore,
        keywordScore,
        pluginScore,
        totalScore: timeScore + keywordScore + pluginScore,
      };
    });
    
    // 2. 按综合得分排序
    scores.sort((a, b) => b.totalScore - a.totalScore);
    
    // 3. 更新原数组
    scores.forEach((score, index) => {
      results[index] = score.result;
    });
  }

  // 获取标题中包含优先关键词的优先级
  private getKeywordPriority(title: string): number {
    const lowerTitle = title.toLowerCase();
    for (let i = 0; i < priorityKeywords.length; i++) {
      if (lowerTitle.includes(priorityKeywords[i])) {
        // 返回优先级得分（数组索引越小，优先级越高，最高400分）
        return (priorityKeywords.length - i) * 70;
      }
    }
    return 0;
  }

  // 计算时间得分
  private calculateTimeScore(datetimeStr: string): number {
    if (!datetimeStr) {
      return 0; // 无时间信息得0分
    }
    
    const datetime = new Date(datetimeStr);
    if (isNaN(datetime.getTime())) {
      return 0;
    }
    
    const now = new Date();
    const daysDiff = (now.getTime() - datetime.getTime()) / (1000 * 60 * 60 * 24);
    
    // 时间得分：越新得分越高，最大500分
    if (daysDiff <= 1) {
      return 500;  // 1天内
    } else if (daysDiff <= 3) {
      return 400;  // 3天内
    } else if (daysDiff <= 7) {
      return 300;  // 1周内
    } else if (daysDiff <= 30) {
      return 200;  // 1月内
    } else if (daysDiff <= 90) {
      return 100;  // 3月内
    } else if (daysDiff <= 365) {
      return 50;   // 1年内
    } else {
      return 20;   // 1年以上
    }
  }

  // 将搜索结果按网盘类型分组
  private mergeResultsByType(results: SearchResult[], keyword: string, cloudTypes: string[]): MergedLinks {
    // 创建合并结果的映射
    const mergedLinks: MergedLinks = {};

    // 用于去重的映射，键为URL
    const uniqueLinks = new Map<string, MergedLink>();

    // 将关键词转为小写，用于不区分大小写的匹配
    const lowerKeyword = keyword.toLowerCase();

    // 遍历所有搜索结果
    for (const result of results) {
      // 提取消息中的链接-标题对应关系
      const linkTitleMap = this.extractLinkTitlePairs(result.content);
      
      for (const link of result.links) {
        // 优先使用链接的WorkTitle字段，如果为空则回退到传统方式
        let title = result.title; // 默认使用消息标题
        
        if (link.workTitle) {
          // 如果链接有WorkTitle字段，优先使用
          title = link.workTitle;
        } else {
          // 如果没有WorkTitle，使用传统方式从映射中获取该链接对应的标题
          // 查找完全匹配的链接
          if (linkTitleMap[link.url]) {
            title = linkTitleMap[link.url]; // 如果找到特定标题，则使用它
          } else {
            // 如果没有找到完全匹配的链接，尝试查找前缀匹配的链接
            for (const [mappedLink, mappedTitle] of Object.entries(linkTitleMap)) {
              if (mappedLink.startsWith(link.url)) {
                title = mappedTitle;
                break;
              }
            }
          }
        }
        
        // 关键词过滤：现在我们有了准确的链接-标题对应关系，只需检查每个链接的具体标题
        if (keyword && !title.toLowerCase().includes(lowerKeyword)) {
          continue;
        }
        
        // 确定数据来源
        const source = this.getResultSource(result);
        
        // 优先使用链接自己的时间，如果没有则使用搜索结果的时间
        let linkDatetime = result.datetime;
        if (link.datetime) {
          linkDatetime = link.datetime;
        }
        
        const mergedLink: MergedLink = {
          url: link.url,
          password: link.password,
          note: title, // 使用找到的特定标题
          datetime: linkDatetime,
          source, // 添加数据来源字段
          images: result.images, // 添加TG消息中的图片链接
        };

        // 检查是否已存在相同URL的链接
        if (uniqueLinks.has(link.url)) {
          const existingLink = uniqueLinks.get(link.url)!;
          // 如果已存在，只有当当前链接的时间更新时才替换
          if (linkDatetime && existingLink.datetime) {
            const currentTime = new Date(linkDatetime);
            const existingTime = new Date(existingLink.datetime);
            if (currentTime > existingTime) {
              uniqueLinks.set(link.url, mergedLink);
            }
          } else if (linkDatetime) {
            // 当前链接有时间而现有链接没有，替换
            uniqueLinks.set(link.url, mergedLink);
          }
        } else {
          // 如果不存在，直接添加
          uniqueLinks.set(link.url, mergedLink);
        }
      }
    }

    // 为保持排序顺序，按原始results顺序处理链接
    // 创建一个有序的链接列表，按原始results中的顺序
    const orderedLinks: MergedLink[] = [];
    const linkTypeMap = new Map<string, string>(); // URL -> Type的映射
    
    // 按原始results的顺序收集唯一链接
    for (const result of results) {
      for (const link of result.links) {
        if (uniqueLinks.has(link.url)) {
          const mergedLink = uniqueLinks.get(link.url)!;
          // 检查是否已经添加过这个链接
          if (!orderedLinks.some(existing => existing.url === link.url)) {
            orderedLinks.push(mergedLink);
            linkTypeMap.set(link.url, link.type);
          }
        }
      }
    }
    
    // 将有序链接按类型分组
    for (const mergedLink of orderedLinks) {
      // 从预建的映射中获取链接类型
      const linkType = linkTypeMap.get(mergedLink.url) || 'unknown';

      // 添加到对应类型的列表中
      if (!mergedLinks[linkType]) {
        mergedLinks[linkType] = [];
      }
      mergedLinks[linkType].push(mergedLink);
    }

    // 如果指定了cloudTypes，则过滤结果
    if (cloudTypes.length > 0) {
      // 创建过滤后的结果映射
      const filteredLinks: MergedLinks = {};
      
      // 将cloudTypes转换为Set以提高查找性能
      const allowedTypes = new Set(cloudTypes.map(type => type.toLowerCase()));
      
      // 只保留指定类型的链接
      for (const [linkType, links] of Object.entries(mergedLinks)) {
        if (allowedTypes.has(linkType.toLowerCase())) {
          filteredLinks[linkType] = links;
        }
      }
      
      return filteredLinks;
    }

    return mergedLinks;
  }

  // searchTG 搜索TG频道
  private async searchTG(keyword: string, channels: string[], forceRefresh: boolean): Promise<SearchResult[]> {
    // 生成缓存键
    const cacheKey = this.generateTGCacheKey(keyword, channels);
    
    // 如果未启用强制刷新，尝试从缓存获取结果
    if (!forceRefresh) {
      const cachedResult = await this.cacheService.get(cacheKey);
      if (cachedResult) {
        return cachedResult;
      }
    }
    
    // 缓存未命中或强制刷新，执行实际搜索
    let results: SearchResult[] = [];
    
    // TODO: 实现TG频道搜索逻辑
    // 目前先返回空结果
    
    // 异步缓存结果
    if (AppConfig?.cacheEnabled) {
      const ttl = AppConfig.cacheTTLMinutes * 60 * 1000;
      this.cacheService.set(cacheKey, results, ttl).catch(() => {});
    }
    
    return results;
  }

  // 搜索单个频道
  private async searchChannel(keyword: string, channel: string): Promise<SearchResult[]> {
    // 构建搜索URL
    const url = HttpUtil.BuildSearchURL(channel, keyword, '');

    // 使用全局HTTP客户端
    const client = HttpUtil.GetHTTPClient();

    try {
      // 创建请求
      const response = await client.get(url, {
        timeout: 4000, // 4秒超时
      });

      // 解析响应
      const parseResult = ParserUtil.ParseSearchResults(response.data, channel);
      return parseResult.results;
    } catch (error) {
      return [];
    }
  }

  // 用于从消息内容中提取链接-标题对应关系的函数
  private extractLinkTitlePairs(content: string): Record<string, string> {
    // 首先尝试使用换行符分割的方法
    if (content.includes('\n')) {
      return this.extractLinkTitlePairsWithNewlines(content);
    }
    
    // 如果没有换行符，使用正则表达式直接提取
    return this.extractLinkTitlePairsWithoutNewlines(content);
  }

  // 处理有换行符的情况
  private extractLinkTitlePairsWithNewlines(content: string): Record<string, string> {
    // 结果映射：链接URL -> 对应标题
    const linkTitleMap: Record<string, string> = {};
    
    // 按行分割内容
    const lines = content.split('\n');
    
    // 链接正则表达式
    const linkRegex = /https?:\/\/[^\s"']+/g;
    
    // 第一遍扫描：识别标题-链接对
    let lastTitle = '';
    let lastTitleIndex = -1;
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line === '') {
        continue;
      }
      
      // 检查当前行是否包含链接
      const links = line.match(linkRegex);
      
      if (links && links.length > 0) {
        // 当前行包含链接
        
        // 检查是否是标准链接行（以"链接："、"地址："等开头）
        const isStandardLinkLine = this.isLinkLine(line);
        
        if (isStandardLinkLine && lastTitle) {
          // 标准链接行，使用上一个标题
          for (const link of links) {
            linkTitleMap[link] = lastTitle;
          }
        } else if (!isStandardLinkLine) {
          // 非标准链接行，可能是"标题：链接"格式
          const titleFromLine = this.extractTitleFromLinkLine(line);
          if (titleFromLine) {
            // 是"标题：链接"格式
            for (const link of links) {
              linkTitleMap[link] = titleFromLine;
            }
          } else if (lastTitle) {
            // 其他情况，使用上一个标题
            for (const link of links) {
              linkTitleMap[link] = lastTitle;
            }
          }
        }
      } else {
        // 当前行不包含链接，可能是标题行
        // 检查下一行是否为链接行
        if (i + 1 < lines.length) {
          const nextLine = lines[i + 1].trim();
          if (this.isLinkLine(nextLine) || nextLine.match(linkRegex)) {
            // 下一行是链接行或包含链接，当前行很可能是标题
            lastTitle = this.cleanTitle(line);
            lastTitleIndex = i;
          }
        } else {
          // 最后一行，也可能是标题
          lastTitle = this.cleanTitle(line);
          lastTitleIndex = i;
        }
      }
    }
    
    // 第二遍扫描：处理没有匹配到标题的链接
    // 为每个链接找到最近的上文标题
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line === '') {
        continue;
      }
      
      const links = line.match(linkRegex);
      if (links && links.length > 0) {
        for (const link of links) {
          if (!linkTitleMap[link]) {
            // 链接没有匹配到标题，尝试找最近的上文标题
            let nearestTitle = '';
            
            // 向上查找最近的标题行
            for (let j = i - 1; j >= 0; j--) {
              if (j === lastTitleIndex || (j + 1 < lines.length && 
                  lines[j + 1].match(linkRegex) && 
                  !lines[j].match(linkRegex))) {
                const candidateTitle = this.cleanTitle(lines[j]);
                if (candidateTitle) {
                  nearestTitle = candidateTitle;
                  break;
                }
              }
            }
            
            if (nearestTitle) {
              linkTitleMap[link] = nearestTitle;
            }
          }
        }
      }
    }
    
    return linkTitleMap;
  }

  // 处理没有换行符的情况
  private extractLinkTitlePairsWithoutNewlines(content: string): Record<string, string> {
    // 结果映射：链接URL -> 对应标题
    const linkTitleMap: Record<string, string> = {};
    
    // 使用精确的网盘链接正则表达式集合，避免贪婪匹配
    const linkPatterns = [
      ParserUtil.TianyiPanPattern,  // 天翼云盘
      ParserUtil.BaiduPanPattern,   // 百度网盘
      ParserUtil.QuarkPanPattern,   // 夸克网盘
      ParserUtil.UCPanPattern,      // UC网盘
      ParserUtil.Pan123Pattern,     // 123网盘
      ParserUtil.Pan115Pattern,     // 115网盘
      ParserUtil.XunleiPanPattern,  // 迅雷网盘
    ];
    
    // 收集所有链接及其位置
    interface LinkInfo {
      url: string;
      pos: number;
    }
    const allLinks: LinkInfo[] = [];
    
    // 使用各个精确正则表达式查找链接
    for (const pattern of linkPatterns) {
      const regex = new RegExp(pattern, 'g');
      let match;
      while ((match = regex.exec(content)) !== null) {
        allLinks.push({ url: match[0], pos: match.index });
      }
    }
    
    // 按位置排序
    allLinks.sort((a, b) => a.pos - b.pos);
    
    // URL标准化和去重
    const uniqueLinks = new Map<string, string>(); // 标准化URL -> 原始URL
    const links: string[] = [];
    
    for (const linkInfo of allLinks) {
      // 标准化URL（将URL编码转换为中文）
      const normalized = decodeURIComponent(linkInfo.url);
      
      // 如果这个标准化URL还没有见过，则保留
      if (!uniqueLinks.has(normalized)) {
        uniqueLinks.set(normalized, linkInfo.url);
        links.push(linkInfo.url);
      }
    }
    
    if (links.length === 0) {
      return linkTitleMap;
    }
    
    // 使用链接位置分割内容
    const segments: string[] = new Array(links.length + 1).fill('');
    let lastPos = 0;
    
    // 查找每个链接的位置，并提取链接前的文本作为段落
    for (let i = 0; i < links.length; i++) {
      const link = links[i];
      const idx = content.indexOf(link, lastPos);
      if (idx === -1) {
        // 链接在content中不存在，跳过
        continue;
      }
      const pos = idx + lastPos;
      if (pos > lastPos) {
        segments[i] = content.substring(lastPos, pos);
      }
      lastPos = pos + link.length;
    }
    
    // 最后一段
    if (lastPos < content.length) {
      segments[links.length] = content.substring(lastPos);
    }
    
    // 从每个段落中提取标题
    for (let i = 0; i < links.length; i++) {
      // 当前链接的标题应该在当前段落的末尾
      let title = '';
      
      // 如果是第一个链接
      if (i === 0) {
        // 提取第一个段落作为标题
        title = this.extractTitleBeforeLink(segments[i]);
      } else {
        // 从上一个链接后的文本中提取标题
        title = this.extractTitleBeforeLink(segments[i]);
      }
      
      // 如果提取到了标题，保存链接-标题对应关系
      if (title) {
        linkTitleMap[links[i]] = title;
      }
    }
    
    return linkTitleMap;
  }

  // 从文本中提取链接前的标题
  private extractTitleBeforeLink(text: string): string {
    // 移除可能的链接前缀词
    text = text.trim();
    
    // 查找"链接："前的文本作为标题
    const idx = text.indexOf('链接：');
    if (idx > 0) {
      return this.cleanTitle(text.substring(0, idx));
    }
    
    return this.cleanTitle(text);
  }

  // 判断一行是否为链接行（主要包含链接的行）
  private isLinkLine(line: string): boolean {
    const lowerLine = line.toLowerCase();
    return lowerLine.startsWith('链接：') || 
           lowerLine.startsWith('地址：') ||
           lowerLine.startsWith('资源地址：') ||
           lowerLine.startsWith('网盘：') ||
           lowerLine.startsWith('网盘地址：') ||
           lowerLine.startsWith('链接:');
  }

  // 从链接行中提取可能的标题
  private extractTitleFromLinkLine(line: string): string {
    // 处理"标题：链接"格式
    let parts = line.split('：');
    if (parts.length === 2 && !parts[0].includes('http') &&
        !this.isLinkPrefix(parts[0])) {
      return this.cleanTitle(parts[0]);
    }
    
    // 处理"标题:链接"格式（半角冒号）
    parts = line.split(':');
    if (parts.length === 2 && !parts[0].includes('http') &&
        !this.isLinkPrefix(parts[0])) {
      return this.cleanTitle(parts[0]);
    }
    
    return '';
  }

  // 判断是否为链接前缀词（包括网盘名称）
  private isLinkPrefix(text: string): boolean {
    text = text.toLowerCase().trim();
    
    // 标准链接前缀词
    if (text === '链接' || 
       text === '地址' || 
       text === '资源地址' || 
       text === '网盘' || 
       text === '网盘地址') {
      return true;
    }
    
    // 网盘名称（防止误将网盘名称当作标题）
    const cloudDiskNames = [
      // 夸克网盘
      '夸克', '夸克网盘', 'quark', '夸克云盘',
      
      // 百度网盘
      '百度', '百度网盘', 'baidu', '百度云', 'bdwp', 'bdpan',
      
      // 迅雷网盘
      '迅雷', '迅雷网盘', 'xunlei', '迅雷云盘',
      
      // 115网盘
      '115', '115网盘', '115云盘',
      
      // 123网盘
      '123', '123pan', '123网盘', '123云盘',
      
      // 阿里云盘
      '阿里', '阿里云', '阿里云盘', 'aliyun', 'alipan', '阿里网盘',
      
      // 天翼云盘
      '天翼', '天翼云', '天翼云盘', 'tianyi', '天翼网盘',
      
      // UC网盘
      'uc', 'uc网盘', 'uc云盘',
      
      // 移动云盘
      '移动', '移动云', '移动云盘', 'caiyun', '彩云',
      
      // PikPak
      'pikpak', 'pikpak网盘',
    ];
    
    return cloudDiskNames.includes(text);
  }

  // 清理标题文本
  private cleanTitle(title: string): string {
    // 移除常见的无关前缀
    title = title.trim();
    title = title.replace(/^名称：/, '');
    title = title.replace(/^标题：/, '');
    title = title.replace(/^片名：/, '');
    title = title.replace(/^名称:/, '');
    title = title.replace(/^标题:/, '');
    title = title.replace(/^片名:/, '');
    
    // 移除表情符号和特殊字符
    const emojiRegex = /[\p{So}\p{Sk}]/gu;
    title = title.replace(emojiRegex, '');
    
    return title.trim();
  }

  // 从SearchResult推断数据来源
  private getResultSource(result: SearchResult): string {
    if (result.channel) {
      // 来自TG频道
      return `tg:${result.channel}`;
    } else if (result.uniqueId && result.uniqueId.includes('-')) {
      // 来自插件：UniqueID格式通常为 "插件名-ID"
      const parts = result.uniqueId.split('-');
      if (parts.length >= 1) {
        return `plugin:${parts[0]}`;
      }
    }
    return 'unknown';
  }

  // 根据来源获取插件等级
  private getPluginLevelBySource(source: string): number {
    // TODO: 实现插件等级缓存和获取逻辑
    return 3; // 默认等级
  }

  // 获取插件等级得分
  private getPluginLevelScore(source: string): number {
    const level = this.getPluginLevelBySource(source);
    
    switch (level) {
      case 1:
        return 1000;  // 等级1插件：1000分
      case 2:
        return 500;   // 等级2插件：500分
      case 3:
        return 0;     // 等级3插件：0分
      case 4:
        return -200;  // 等级4插件：-200分
      default:
        return 0;     // 默认使用等级3得分
    }
  }

  // 生成TG搜索缓存键
  private generateTGCacheKey(keyword: string, channels: string[]): string {
    // 关键词标准化
    const normalizedKeyword = keyword.toLowerCase().trim();
    
    // 获取频道列表哈希
    const channelsHash = this.getChannelsHash(channels);
    
    // 生成TG搜索特定的缓存键
    const keyStr = `tg:${normalizedKeyword}:${channelsHash}`;
    return this.calculateMD5(keyStr);
  }

  // 获取频道列表哈希
  private getChannelsHash(channels: string[]): string {
    if (!channels || channels.length === 0) {
      return 'all';
    }
    
    // 对于小型列表，直接使用字符串连接
    if (channels.length < 5) {
      const channelsCopy = [...channels];
      channelsCopy.sort();
      return channelsCopy.join(',');
    }
    
    // 生成排序后的字符串用作键
    const channelsCopy = [...channels];
    channelsCopy.sort();
    const key = channelsCopy.join(',');
    
    return this.calculateMD5(key);
  }

  // 计算MD5哈希
  private calculateMD5(input: string): string {
    const hash = crypto.createHash('md5');
    hash.update(input);
    return hash.digest('hex');
  }
}
