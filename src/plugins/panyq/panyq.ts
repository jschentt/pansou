import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import * as cheerio from 'cheerio';
import * as path from 'path';
import * as fs from 'fs';
import { SearchResult, Link, PluginSearchResult } from '../../../model';
import { FilterResultsByKeyword } from '../../../util/plugin.util';

// 常量定义
const DefaultTimeout = 15000; // 默认超时时间
const MaxConcurrency = 100; // 最大并发数
const MaxRetries = 0; // 重试次数
const DebugLog = false; // 是否开启调试日志
const ConfigFileName = 'panyq_config.json'; // 配置文件名
const BaseURL = 'https://panyq.com'; // 基础URL
const EnableRefererCheck = false; // 请求来源控制默认为开启状态

// 动态Action ID的键名
const ActionIDKeys = [
  'credential_action_id',     // 获取凭证用的ID
  'intermediate_action_id',   // 中间步骤用的ID
  'final_link_action_id',     // 获取最终链接用的ID
];

// 凭证结构
interface Credentials {
  sign: string;
  hash: string;
  sha: string;
}

// 搜索结果项目
interface SearchHit {
  eid: string;
  desc: string;
  size_str: string;
}

// 搜索响应
interface SearchResponse {
  data: {
    hits: SearchHit[];
    maxPageNum: number;
  };
}

// 配置缓存，用于在多个搜索过程中复用Action ID
let actionIDCache: Map<string, string> = new Map();
let actionIDCacheLock: mutex = new mutex();

// 允许的请求来源列表，可以直接修改这个变量来控制 ext={"referer":"xxx"}
const AllowedReferers: string[] = [
  'https://dm.xueximeng.com',
  'http://localhost:8888',
  // 可以添加更多允许的来源
];

// 新增缓存
// 最终链接缓存
let finalLinkCache: Map<string, string> = new Map();
let finalLinkCacheLock: mutex = new mutex();

// 搜索结果缓存
let searchResultCache: Map<string, SearchResult[]> = new Map();
let searchResultCacheLock: mutex = new mutex();

// 互斥锁实现
class mutex {
  private locked = false;
  private queue: Array<() => void> = [];

  async lock(): Promise<void> {
    if (!this.locked) {
      this.locked = true;
      return;
    }

    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
  }

  unlock(): void {
    if (!this.locked) {
      return;
    }

    if (this.queue.length > 0) {
      const resolve = this.queue.shift();
      if (resolve) {
        resolve();
      }
    } else {
      this.locked = false;
    }
  }

  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    await this.lock();
    try {
      return await fn();
    } finally {
      this.unlock();
    }
  }
}

// 信号量实现
class Semaphore {
  private available: number;
  private queue: Array<() => void> = [];

  constructor(initial: number) {
    this.available = initial;
  }

  async acquire(): Promise<void> {
    if (this.available > 0) {
      this.available--;
      return;
    }

    return new Promise((resolve) => {
      this.queue.push(resolve);
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

// PanyqPlugin 盘友圈搜索插件
export class PanyqPlugin {
  private client: AxiosInstance;
  private MainCacheKey: string;

  constructor() {
    // 创建一个可以忽略HTTPS证书验证并支持Cookie的HTTP客户端
    this.client = axios.create({
      timeout: DefaultTimeout,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
      },
      httpsAgent: new (require('https').Agent)({
        rejectUnauthorized: false
      }),
      maxRedirects: 10,
    });

    this.MainCacheKey = 'panyq';
  }

  // Search 执行搜索并返回结果
  async Search(keyword: string, ext: Record<string, any>): Promise<SearchResult[]> {
    if (DebugLog) {
      console.log('panyq: ext 参数内容:', ext);
    }

    // 检查搜索结果缓存
    const cacheKey = `search:${keyword}`;
    let cachedResults = await searchResultCacheLock.runExclusive(() => {
      return searchResultCache.get(cacheKey);
    });

    if (cachedResults) {
      if (DebugLog) {
        console.log(`panyq: 缓存命中搜索结果: ${keyword}`);
      }
      return cachedResults;
    }

    // 请求来源检查
    if (EnableRefererCheck && ext) {
      let referer = '';
      if (ext['referer'] && typeof ext['referer'] === 'string') {
        referer = ext['referer'];
      }

      // 检查referer是否在允许列表中
      let allowed = false;
      for (const allowedReferer of AllowedReferers) {
        if (referer.startsWith(allowedReferer)) {
          if (DebugLog) {
            console.log(`panyq: 允许来自 ${referer} 的请求`);
          }
          allowed = true;
          break;
        }
      }

      if (!allowed) {
        if (DebugLog) {
          console.log(`panyq: 拒绝来自 ${referer} 的请求`);
        }
        throw new Error('请求来源不被允许');
      }
    }

    // 使用新的异步搜索方法
    const result = await this.AsyncSearchWithResult(keyword, this.doSearch.bind(this), this.MainCacheKey, ext);
    const results = result.Results;

    // 如果搜索成功，缓存结果
    if (results.length > 0) {
      await searchResultCacheLock.runExclusive(() => {
        searchResultCache.set(cacheKey, results);
      });
    }

    return results;
  }

  // SearchWithResult 执行搜索并返回包含IsFinal标记的结果
  async SearchWithResult(keyword: string, ext: Record<string, any>): Promise<PluginSearchResult> {
    return this.AsyncSearchWithResult(keyword, this.doSearch.bind(this), this.MainCacheKey, ext);
  }

  // AsyncSearchWithResult 异步搜索实现
  private async AsyncSearchWithResult(keyword: string, doSearch: (client: AxiosInstance, keyword: string, ext: Record<string, any>) => Promise<SearchResult[]>, cacheKey: string, ext: Record<string, any>): Promise<PluginSearchResult> {
    // 这里实现异步搜索逻辑，暂时直接调用doSearch
    const results = await doSearch(this.client, keyword, ext);
    return {
      Results: results,
      IsFinal: true,
      CacheKey: cacheKey
    };
  }

  // doSearch 实际的搜索实现
  private async doSearch(client: AxiosInstance, keyword: string, ext: Record<string, any>): Promise<SearchResult[]> {
    if (DebugLog) {
      console.log('panyq: searching for', keyword);
    }

    // 尝试获取或发现 Action ID
    let actionIDs: Map<string, string>;
    try {
      actionIDs = await this.getOrDiscoverActionIDs();
    } catch (err) {
      throw new Error(`获取Action ID失败: ${err}`);
    }

    // 步骤1: 获取搜索凭证
    let credentials: Credentials;
    try {
      credentials = await this.getCredentials(keyword, actionIDs.get(ActionIDKeys[0])!, client);
    } catch (err) {
      // 如果获取凭证失败，尝试刷新Action ID并重试
      try {
        actionIDs = await this.discoverActionIDs();
        credentials = await this.getCredentials(keyword, actionIDs.get(ActionIDKeys[0])!, client);
      } catch (refreshErr) {
        throw new Error(`获取搜索凭证失败: ${refreshErr}`);
      }
    }

    // 步骤2: 获取第一页搜索结果列表
    let hits: SearchHit[];
    let maxPageNum: number;
    try {
      [hits, maxPageNum] = await this.getSearchResults(credentials.sign, 1, client);
    } catch (err) {
      throw new Error(`获取搜索结果失败: ${err}`);
    }

    if (hits.length === 0) {
      if (DebugLog) {
        console.log('panyq: no results found for', keyword);
      }
      return [];
    }

    // 如果有多页结果，并发获取其他页的数据
    if (maxPageNum > 1) {
      if (DebugLog) {
        console.log(`panyq: found ${maxPageNum} pages, fetching additional pages...`);
      }
      if (maxPageNum >= 3) {
        maxPageNum = 3;
      }

      // 并发获取第2页到最后一页
      const pagePromises = [];
      for (let page = 2; page <= maxPageNum; page++) {
        pagePromises.push(this.getSearchResults(credentials.sign, page, client));
      }

      // 等待所有页面获取完成
      const pageResults = await Promise.all(pagePromises);

      // 合并所有页面的结果
      for (const [pageHits] of pageResults) {
        hits = hits.concat(pageHits);
      }

      if (DebugLog) {
        console.log(`panyq: total ${hits.length} results from all pages`);
      }
    }

    // 使用并发控制通道限制并发数
    const sem = new Semaphore(MaxConcurrency);
    const resultPromises: Promise<SearchResult | null>[] = [];

    // 并发处理每个搜索结果
    for (let i = 0; i < hits.length; i++) {
      const hit = hits[i];
      resultPromises.push(
        (async () => {
          await sem.acquire();
          try {
            // 步骤3: 执行中间状态确认
            await this.performIntermediateStep(
              actionIDs.get(ActionIDKeys[1])!,
              credentials.hash,
              credentials.sha,
              hit.eid,
              client
            );

            // 步骤4: 获取最终链接
            const finalLink = await this.getFinalLink(actionIDs.get(ActionIDKeys[2])!, hit.eid, client);

            if (!finalLink) {
              return null;
            }

            // 创建链接
            const linkType = this.determineLinkType(finalLink);
            const links: Link[] = [
              {
                URL: finalLink,
                Type: linkType,
                Password: this.extractPassword(finalLink, linkType),
              },
            ];

            // 清理标题和内容中的HTML标签
            let title = this.extractTitle(hit.desc);
            let cleanedDesc = this.cleanEscapedHTML(hit.desc);

            // 创建搜索结果
            let result: SearchResult = {
              UniqueID: `panyq-${i}`,
              Title: title,
              Content: cleanedDesc,
              Links: links,
              Datetime: new Date(),
            };

            // 确保result中的标题和内容已清理HTML标签
            result.Title = this.cleanEscapedHTML(result.Title);
            result.Content = this.cleanEscapedHTML(result.Content);

            return result;
          } catch (err) {
            if (DebugLog) {
              console.log(`panyq: error processing result ${hit.eid}:`, err);
            }
            return null;
          } finally {
            sem.release();
          }
        })()
      );
    }

    // 收集结果
    const results = await Promise.all(resultPromises);
    const filteredResults = results.filter((res): res is SearchResult => res !== null);

    // 使用关键词过滤结果
    const keywordFilteredResults = FilterResultsByKeyword(filteredResults, keyword);

    if (DebugLog) {
      console.log('panyq: returning', keywordFilteredResults.length, 'filtered results');
    }

    return keywordFilteredResults;
  }

  // getOrDiscoverActionIDs 获取或发现Action ID
  private async getOrDiscoverActionIDs(): Promise<Map<string, string>> {
    // 先检查缓存
    const cachedIDs = await actionIDCacheLock.runExclusive(() => {
      if (actionIDCache.size >= ActionIDKeys.length) {
        const ids = new Map<string, string>();
        for (const key of ActionIDKeys) {
          const id = actionIDCache.get(key);
          if (id) {
            ids.set(key, id);
          }
        }
        if (ids.size === ActionIDKeys.length) {
          return ids;
        }
      }
      return null;
    });

    if (cachedIDs) {
      return cachedIDs;
    }

    // 没有缓存或缓存不完整，发现新的Action ID
    return this.discoverActionIDs();
  }

  // discoverActionIDs 发现Action ID
  private async discoverActionIDs(): Promise<Map<string, string>> {
    if (DebugLog) {
      console.log('panyq: discovering Action IDs...');
    }

    // 尝试从缓存文件加载
    let finalIDs = await this.loadActionIDsFromFile();
    if (finalIDs && finalIDs.size === ActionIDKeys.length) {
      if (DebugLog) {
        console.log('panyq: loaded Action IDs from file cache');
      }

      // 保存到内存缓存
      await actionIDCacheLock.runExclusive(() => {
        finalIDs.forEach((value, key) => {
          actionIDCache.set(key, value);
        });
      });

      return finalIDs;
    }

    // 从网站获取潜在的Action ID
    const potentialIDs = await this.findPotentialActionIDs(this.client);

    if (potentialIDs.length === 0) {
      throw new Error('未找到潜在的Action ID');
    }

    if (DebugLog) {
      if (potentialIDs.length > 0) {
        console.log(`panyq: 样例ID: ${potentialIDs[0]}`);
      }
    }

    finalIDs = new Map();

    // 1. 验证credential_action_id - 并发验证
    if (DebugLog) {
      console.log('panyq: validating credential_action_id...');
    }

    // 并发验证所有ID
    const credIDPromises = potentialIDs.map(async (id, index) => {
      if (DebugLog) {
        console.log(`panyq: 并发尝试第 ${index + 1} 个ID作为credential_action_id: ${id.substring(0, 10)}...`);
      }
      if (await this.validateCredentialID(id)) {
        if (DebugLog) {
          console.log(`panyq: 找到有效的credential_action_id: ${id}`);
        }
        return id;
      }
      return null;
    });

    // 等待所有验证完成
    const credIDResults = await Promise.all(credIDPromises);

    // 从结果中获取第一个有效ID
    let credentialIDFound = false;
    for (const id of credIDResults) {
      if (id) {
        finalIDs.set(ActionIDKeys[0], id);
        credentialIDFound = true;
        break;
      }
    }

    if (!credentialIDFound) {
      throw new Error('未能验证credential_action_id');
    }

    // 获取测试凭证用于后续验证
    const testCreds = await this.getCredentials('test', finalIDs.get(ActionIDKeys[0])!, this.client);

    if (DebugLog) {
      console.log(`panyq: 获取到测试凭证: sign=${testCreds.sign.substring(0, 10)}..., hash=${testCreds.hash.substring(0, 10)}..., sha=${testCreds.sha.substring(0, 10)}...`);
    }

    // 从剩余ID中排除已使用的ID
    const remainingIDs = potentialIDs.filter(id => id !== finalIDs.get(ActionIDKeys[0]));

    // 2. 验证intermediate_action_id - 从后向前验证
    if (DebugLog) {
      console.log(`panyq: validating intermediate_action_id (${remainingIDs.length} candidates)...`);
    }

    let intermediateIDFound = false;
    for (let i = remainingIDs.length - 1; i >= 0; i--) {
      const id = remainingIDs[i];
      if (DebugLog) {
        console.log(`panyq: 尝试第 ${i + 1} 个剩余ID作为intermediate_action_id: ${id.substring(0, 10)}...`);
      }
      if (await this.validateIntermediateID(id, testCreds.hash, testCreds.sha)) {
        finalIDs.set(ActionIDKeys[1], id);
        intermediateIDFound = true;
        if (DebugLog) {
          console.log(`panyq: 找到有效的intermediate_action_id: ${id}`);
        }
        break;
      }
    }

    if (!intermediateIDFound) {
      throw new Error('未能验证intermediate_action_id');
    }

    // 获取测试EID
    let testHits: SearchHit[];
    try {
      [testHits] = await this.getSearchResults(testCreds.sign, 1, this.client); // 获取第一页测试结果
    } catch (err) {
      throw new Error(`获取测试结果失败: ${err}`);
    }

    if (testHits.length === 0) {
      throw new Error('获取测试EID失败: 无搜索结果');
    }

    const testEID = testHits[0].eid;

    if (DebugLog) {
      console.log(`panyq: 获取到测试EID: ${testEID}`);
    }

    // 从剩余ID中排除已使用的ID
    const newRemainingIDs = remainingIDs.filter(id => id !== finalIDs.get(ActionIDKeys[1]));

    // 3. 验证final_link_action_id
    if (DebugLog) {
      console.log(`panyq: validating final_link_action_id (${newRemainingIDs.length} candidates)...`);
    }

    let finalLinkIDFound = false;
    for (let i = 0; i < newRemainingIDs.length; i++) {
      const id = newRemainingIDs[i];
      // 针对每个候选ID都执行一次中间步骤
      if (DebugLog) {
        console.log(`panyq: 尝试第 ${i + 1} 个ID作为final_link_action_id: ${id.substring(0, 10)}...`);
        console.log('panyq: 执行中间步骤...');
      }

      try {
        await this.performIntermediateStep(
          finalIDs.get(ActionIDKeys[1])!,
          testCreds.hash,
          testCreds.sha,
          testEID,
          this.client
        );

        if (DebugLog) {
          console.log('panyq: 验证final_link_action_id...');
        }

        if (await this.validateFinalLinkID(id, testEID)) {
          finalIDs.set(ActionIDKeys[2], id);
          finalLinkIDFound = true;
          if (DebugLog) {
            console.log(`panyq: 找到有效的final_link_action_id: ${id}`);
          }
          break;
        }
      } catch (err) {
        console.log(`panyq: 中间步骤执行失败, 继续尝试下一个ID: ${err}`);
        continue;
      }
    }

    if (!finalLinkIDFound) {
      // 如果只剩下一个ID且验证失败，尝试交换intermediate_action_id和final_link_action_id
      if (newRemainingIDs.length === 1 && potentialIDs.length === 3) {
        if (DebugLog) {
          console.log('panyq: final_link_action_id验证失败，尝试交换intermediate_action_id和final_link_action_id...');
        }

        // 保存当前的intermediate_action_id
        const oldInterID = finalIDs.get(ActionIDKeys[1])!;

        // 使用剩余的ID作为intermediate_action_id
        finalIDs.set(ActionIDKeys[1], newRemainingIDs[0]);

        // 使用原来的intermediate_action_id作为final_link_action_id
        finalIDs.set(ActionIDKeys[2], oldInterID);

        try {
          // 执行中间步骤
          await this.performIntermediateStep(
            finalIDs.get(ActionIDKeys[1])!,
            testCreds.hash,
            testCreds.sha,
            testEID,
            this.client
          );

          // 验证final_link_action_id
          if (await this.validateFinalLinkID(finalIDs.get(ActionIDKeys[2])!, testEID)) {
            finalLinkIDFound = true;
            if (DebugLog) {
              console.log('panyq: 交换ID后验证成功!');
            }
          }
        } catch (err) {
          if (DebugLog) {
            console.log(`panyq: 交换后中间步骤执行失败: ${err}`);
          }
        }
      }

      if (!finalLinkIDFound) {
        throw new Error('未能验证final_link_action_id');
      }
    }

    // 保存到内存缓存
    await actionIDCacheLock.runExclusive(() => {
      finalIDs.forEach((value, key) => {
        actionIDCache.set(key, value);
      });
    });

    // 保存到文件缓存
    try {
      await this.saveActionIDsToFile(finalIDs);
    } catch (err) {
      console.log(`panyq: 保存Action IDs到文件失败: ${err}`);
      // 继续执行，不返回错误
    }

    if (DebugLog) {
      console.log('panyq: all Action IDs validated successfully:');
      for (const key of ActionIDKeys) {
        console.log(`panyq:   ${key} = ${finalIDs.get(key)}`);
      }
    }

    return finalIDs;
  }

  // findPotentialActionIDs 从网站获取潜在的Action ID
  private async findPotentialActionIDs(client: AxiosInstance): Promise<string[]> {
    // 请求网站首页
    let response;
    try {
      response = await client.get(BaseURL, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36'
        }
      });
    } catch (err) {
      throw new Error(`请求网站首页失败: ${err}`);
    }

    // 提取JS文件路径
    const jsRegex = /<script src="(\/_next\/static\/[^\"]+\.js)"/g;
    let matches;
    const jsUrls: string[] = [];
    while ((matches = jsRegex.exec(response.data)) !== null) {
      jsUrls.push(BaseURL + matches[1]);
    }

    if (jsUrls.length === 0) {
      throw new Error('未找到JS文件');
    }

    // 收集所有潜在的Action ID
    const idSet = new Set<string>();
    const idRegex = /["']([a-f0-9]{40})["']{1}/g;

    for (const jsUrl of jsUrls) {
      try {
        // 创建JS文件请求
        const jsResponse = await client.get(jsUrl, {
          headers: {
            'Referer': BaseURL,
            'Origin': BaseURL,
            'sec-ch-ua': `"Not)A;Brand";v="8", "Chromium";v="138", "Google Chrome";v="138"`,
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36'
          }
        });

        // 提取ID
        let idMatches;
        while ((idMatches = idRegex.exec(jsResponse.data)) !== null) {
          idSet.add(idMatches[1]);
        }
      } catch (err) {
        continue;
      }
    }

    // 转换为数组
    const ids = Array.from(idSet);

    if (DebugLog) {
      console.log('panyq: found', ids.length, 'potential Action IDs');
    }

    return ids;
  }

  // validateCredentialID 验证credential_action_id
  private async validateCredentialID(actionID: string): Promise<boolean> {
    try {
      await this.getCredentials('test', actionID, this.client);
      return true;
    } catch (err) {
      return false;
    }
  }

  // validateIntermediateID 验证intermediate_action_id
  private async validateIntermediateID(actionID: string, testHash: string, testSha: string): Promise<boolean> {
    try {
      await this.performIntermediateStep(actionID, testHash, testSha, 'fake_eid_for_validation', this.client);
      return true;
    } catch (err) {
      return false;
    }
  }

  // validateFinalLinkID 验证final_link_action_id
  private async validateFinalLinkID(actionID: string, testEID: string): Promise<boolean> {
    let responseText = '';
    try {
      responseText = await this.getRawFinalLinkResponse(actionID, testEID, this.client);
    } catch (err) {
      // 记录错误但继续尝试验证
      console.log('panyq: 获取响应失败，但仍尝试验证:', err);
      if (!responseText) {
        return false;
      }
    }

    // 检查原始响应中是否包含链接相关的关键词
    const keywords = ['http', 'magnet', 'aliyundrive', '"url"'];
    for (const kw of keywords) {
      if (responseText.includes(kw)) {
        if (DebugLog) {
          console.log('panyq: found keyword in response:', kw);
        }
        return true;
      }
    }

    return false;
  }

  // getRawFinalLinkResponse 获取最终链接的原始响应文本
  private async getRawFinalLinkResponse(actionID: string, eid: string, client: AxiosInstance): Promise<string> {
    // 检查缓存
    const cacheKey = `${actionID}:${eid}`;
    const cachedResponse = await finalLinkCacheLock.runExclusive(() => {
      return finalLinkCache.get(cacheKey);
    });

    if (cachedResponse) {
      if (DebugLog) {
        console.log(`panyq: 缓存命中 raw final link: ${eid}`);
      }
      return cachedResponse;
    }

    // 构建URL
    const finalURL = `${BaseURL}/go/${eid}`;

    // 构建路由状态树
    const routerStateTree = [
      '',
      {
        children: [
          'go',
          {
            children: [
              ['eid', eid, 'd'],
              {
                children: ['__PAGE__', {}, `/go/${eid}`, 'refresh'],
              },
            ],
          },
        ],
      },
      null,
      null,
      true,
    ];

    // 构建请求体
    const payload = JSON.stringify([{ eid }]);

    // 创建请求
    const config: AxiosRequestConfig = {
      url: finalURL,
      method: 'POST',
      data: payload,
      headers: {
        'Content-Type': 'text/plain;charset=UTF-8',
        'next-action': actionID,
        'Referer': finalURL,
        'Origin': BaseURL,
        'sec-ch-ua': `"Not)A;Brand";v="8", "Chromium";v="138", "Google Chrome";v="138"`,
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
        'next-router-state-tree': encodeURIComponent(JSON.stringify(routerStateTree))
      },
      timeout: DefaultTimeout
    };

    // 发送请求
    let response;
    try {
      response = await client.request(config);
    } catch (err) {
      if (DebugLog) {
        console.log('panyq: network error:', err);
      }
      throw err;
    }

    // 检查状态码
    if (response.status !== 200) {
      if (DebugLog) {
        console.log('panyq: bad status code:', response.status);
      }
      throw new Error(`HTTP status code: ${response.status}`);
    }

    // 读取原始响应
    const responseText = response.data;

    // 保存到缓存
    await finalLinkCacheLock.runExclusive(() => {
      finalLinkCache.set(cacheKey, responseText);
    });

    return responseText;
  }

  // getCredentials 获取搜索凭证
  private async getCredentials(query: string, actionID: string, client: AxiosInstance): Promise<Credentials> {
    // 构建请求体
    const payload = JSON.stringify([{ cat: 'all', query, pageNum: 1 }]);

    // 创建请求
    const config: AxiosRequestConfig = {
      url: BaseURL,
      method: 'POST',
      data: payload,
      headers: {
        'Content-Type': 'text/plain;charset=UTF-8',
        'next-action': actionID,
        'Referer': BaseURL,
        'Origin': BaseURL,
        'sec-ch-ua': `"Not)A;Brand";v="8", "Chromium";v="138", "Google Chrome";v="138"`,
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36'
      },
      timeout: DefaultTimeout
    };

    // 发送请求
    let response;
    try {
      response = await client.request(config);
    } catch (err) {
      throw err;
    }

    // 使用正则表达式提取凭证
    const signRegex = /"sign":"([^"]+)"/;
    const shaRegex = /"sha":"([a-f0-9]{64})"/;
    const hashRegex = /"hash","([^"]+)"/;

    const signMatch = signRegex.exec(response.data);
    const shaMatch = shaRegex.exec(response.data);
    const hashMatch = hashRegex.exec(response.data);

    if (!signMatch || !shaMatch || !hashMatch) {
      throw new Error('提取凭证失败');
    }

    return {
      sign: signMatch[1],
      sha: shaMatch[1],
      hash: hashMatch[1],
    };
  }

  // getSearchResults 获取搜索结果列表
  private async getSearchResults(sign: string, pageNum: number, client: AxiosInstance): Promise<[SearchHit[], number]> {
    // 构建URL
    const searchURL = `${BaseURL}/api/search?sign=${sign}&page=${pageNum}`;

    // 创建请求
    const config: AxiosRequestConfig = {
      url: searchURL,
      method: 'GET',
      headers: {
        'Referer': BaseURL,
        'Origin': BaseURL,
        'sec-ch-ua': `"Not)A;Brand";v="8", "Chromium";v="138", "Google Chrome";v="138"`,
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36'
      },
      timeout: DefaultTimeout
    };

    // 从缓存中获取credential_action_id并添加到请求头
    const actionID = await actionIDCacheLock.runExclusive(() => {
      return actionIDCache.get(ActionIDKeys[0]);
    });

    if (actionID) {
      config.headers!['next-action'] = actionID;
    }

    // 发送请求
    let response;
    try {
      response = await client.request(config);
    } catch (err) {
      throw err;
    }

    // 解析JSON
    const searchResp: SearchResponse = response.data;

    return [searchResp.data.hits, searchResp.data.maxPageNum];
  }

  // performIntermediateStep 执行中间状态确认
  private async performIntermediateStep(actionID: string, hashVal: string, shaVal: string, eid: string, client: AxiosInstance): Promise<void> {
    // 构建URL
    const intermediateURL = `${BaseURL}/search/${hashVal}`;

    // 构建路由状态树
    const routerStateTree = [
      '',
      {
        children: [
          'search',
          {
            children: [
              ['hash', hashVal, 'd'],
              {
                children: ['__PAGE__', {}, `/search/${hashVal}`, 'refresh'],
              },
            ],
          },
        ],
      },
      null,
      null,
      true,
    ];

    // 构建请求体
    const payload = JSON.stringify([{ eid, sha: shaVal, page_num: '1' }]);

    // 创建请求
    const config: AxiosRequestConfig = {
      url: intermediateURL,
      method: 'POST',
      data: payload,
      headers: {
        'Content-Type': 'text/plain;charset=UTF-8',
        'next-action': actionID,
        'Referer': intermediateURL,
        'Origin': BaseURL,
        'next-router-state-tree': encodeURIComponent(JSON.stringify(routerStateTree)),
        'sec-ch-ua': `"Not)A;Brand";v="8", "Chromium";v="138", "Google Chrome";v="138"`,
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36'
      },
      timeout: DefaultTimeout
    };

    // 发送请求
    let response;
    try {
      response = await client.request(config);
    } catch (err) {
      throw err;
    }

    // 确认请求成功
    if (response.status !== 200) {
      throw new Error(`中间步骤请求失败，状态码: ${response.status}`);
    }
  }

  // getFinalLink 获取最终链接
  private async getFinalLink(actionID: string, eid: string, client: AxiosInstance): Promise<string> {
    // 检查缓存
    const linkCacheKey = `link:${actionID}:${eid}`;
    const cachedLink = await finalLinkCacheLock.runExclusive(() => {
      return finalLinkCache.get(linkCacheKey);
    });

    if (cachedLink) {
      if (DebugLog) {
        console.log(`panyq: 缓存命中最终链接: ${eid}`);
      }
      return cachedLink;
    }

    // 获取原始响应
    const responseText = await this.getRawFinalLinkResponse(actionID, eid, client);

    // 尝试从JSON中提取URL
    const lines = responseText.split('\n');
    let finalLink = '';

    if (lines.length > 0) {
      const lastLine = lines[lines.length - 1];

      try {
        const linkData = JSON.parse(lastLine);
        if (Array.isArray(linkData) && linkData.length > 1) {
          const linkMap = linkData[1];
          if (linkMap && typeof linkMap === 'object' && 'url' in linkMap) {
            finalLink = linkMap.url;
          }
        }
      } catch (err) {
        // JSON解析失败，尝试使用正则表达式
      }
    }

    // 如果JSON解析失败，尝试使用正则表达式
    if (!finalLink) {
      const urlRegex = /(https?:\/\/[^\s"'<>]+|magnet:\?[^\s"'<>]+)/;
      const urlMatch = urlRegex.exec(responseText);

      if (urlMatch) {
        finalLink = urlMatch[0];
      }
    }

    if (!finalLink) {
      throw new Error('提取链接失败');
    }

    // 保存链接到缓存
    await finalLinkCacheLock.runExclusive(() => {
      finalLinkCache.set(linkCacheKey, finalLink);
    });

    return finalLink;
  }

  // determineLinkType 根据URL确定链接类型
  private determineLinkType(url: string): string {
    const lowerURL = url.toLowerCase();

    if (lowerURL.includes('pan.baidu.com')) {
      return 'baidu';
    } else if (lowerURL.includes('alipan.com') || lowerURL.includes('aliyundrive.com')) {
      return 'aliyun';
    } else if (lowerURL.includes('pan.xunlei.com')) {
      return 'xunlei';
    } else if (lowerURL.includes('cloud.189.cn')) {
      return 'tianyi';
    } else if (lowerURL.includes('caiyun.139.com') || lowerURL.includes('yun.139.com')) {
      return 'mobile';
    } else if (lowerURL.includes('pan.quark.cn')) {
      return 'quark';
    } else if (lowerURL.includes('115.com')) {
      return '115';
    } else if (lowerURL.includes('weiyun.com')) {
      return 'weiyun';
    } else if (lowerURL.includes('lanzou')) {
      return 'lanzou';
    } else if (lowerURL.includes('jianguoyun.com')) {
      return 'jianguoyun';
    } else if (lowerURL.includes('123pan.com')) {
      return '123';
    } else if (lowerURL.includes('drive.uc.cn')) {
      return 'uc';
    } else if (lowerURL.includes('mypikpak.com')) {
      return 'pikpak';
    } else if (lowerURL.startsWith('magnet:')) {
      return 'magnet';
    } else if (lowerURL.startsWith('ed2k:')) {
      return 'ed2k';
    } else {
      return 'others';
    }
  }

  // extractPassword 从URL或内容中提取密码
  private extractPassword(url: string, linkType: string): string {
    // 百度网盘密码通常在URL后面以?pwd=形式出现
    if (linkType === 'baidu') {
      const idx = url.indexOf('?pwd=');
      if (idx >= 0) {
        let pwd = url.substring(idx + 5);
        if (pwd.length >= 4) {
          return pwd.substring(0, 4); // 百度网盘密码通常为4位
        }
        return pwd;
      }
    }

    // 阿里云盘密码可能在URL参数中
    if (linkType === 'aliyun') {
      const idx = url.indexOf('password=');
      if (idx >= 0) {
        let pwd = url.substring(idx + 9);
        const endIdx = pwd.indexOf('&');
        if (endIdx >= 0) {
          return pwd.substring(0, endIdx);
        }
        return pwd;
      }
    }

    return '';
  }

  // cleanEscapedHTML 清理HTML转义字符
  private cleanEscapedHTML(text: string): string {
    // 处理Unicode转义序列
    const replacers: Record<string, string> = {
      '\\u003Cmark\\u003E': '',
      '\\u003C/mark\\u003E': '',
      '\\u003Cb\\u003E': '',
      '\\u003C/b\\u003E': '',
      '\\u003Cem\\u003E': '',
      '\\u003C/em\\u003E': '',
      '\\u003Cstrong\\u003E': '',
      '\\u003C/strong\\u003E': '',
      '\\u003Ci\\u003E': '',
      '\\u003C/i\\u003E': '',
      '\\u003Cu\\u003E': '',
      '\\u003C/u\\u003E': '',
      '\\u003Cbr\\u003E': ' ',
      '\\u003Cbr/\\u003E': ' ',
      '\\u003Cbr \\u003E': ' ',
    };

    let result = text;
    for (const [old, newStr] of Object.entries(replacers)) {
      result = result.replace(new RegExp(old, 'g'), newStr);
    }

    // 处理实际的HTML标签
    const htmlReplacers: Record<string, string> = {
      '<mark>': '',
      '</mark>': '',
      '<b>': '',
      '</b>': '',
      '<em>': '',
      '</em>': '',
      '<strong>': '',
      '</strong>': '',
      '<i>': '',
      '</i>': '',
      '<u>': '',
      '</u>': '',
      '<br>': ' ',
      '<br/>': ' ',
      '<br />': ' ',
    };

    for (const [old, newStr] of Object.entries(htmlReplacers)) {
      result = result.replace(new RegExp(old, 'g'), newStr);
    }

    return result;
  }

  // extractTitle 从描述中提取标题
  private extractTitle(desc: string): string {
    // 先清理HTML标签
    const cleanDesc = this.cleanEscapedHTML(desc);

    // 尝试匹配标题
    // 1. 尝试匹配《》内的内容
    const titleRegex1 = /《([^》]+)》/;
    const match1 = titleRegex1.exec(cleanDesc);
    if (match1 && match1[1]) {
      return match1[1];
    }

    // 2. 尝试匹配【】内的内容
    const titleRegex2 = /【([^】]+)】/;
    const match2 = titleRegex2.exec(cleanDesc);
    if (match2 && match2[1]) {
      return match2[1];
    }

    // 3. 尝试提取开头的一段（到第一个分隔符为止）
    const parts = cleanDesc.split('✔');
    if (parts.length > 0 && parts[0].trim()) {
      return parts[0].trim();
    }

    // 如果以上方法都无法提取标题，则取前30个字符作为标题
    if (cleanDesc.length > 30) {
      return cleanDesc.substring(0, 30).trim() + '...';
    }

    return cleanDesc.trim();
  }

  // loadActionIDsFromFile 从文件加载Action IDs
  private async loadActionIDsFromFile(): Promise<Map<string, string> | null> {
    const configPath = path.join('.', ConfigFileName);

    try {
      const data = await fs.promises.readFile(configPath, 'utf8');
      const ids: Record<string, string> = JSON.parse(data);

      // 验证所有必需的键是否存在
      for (const key of ActionIDKeys) {
        if (!(key in ids)) {
          return null;
        }
      }

      const result = new Map<string, string>();
      for (const [key, value] of Object.entries(ids)) {
        result.set(key, value);
      }

      return result;
    } catch (err) {
      return null;
    }
  }

  // saveActionIDsToFile 保存Action IDs到文件
  private async saveActionIDsToFile(ids: Map<string, string>): Promise<void> {
    const data = JSON.stringify(Object.fromEntries(ids), null, 2);
    const configPath = path.join('.', ConfigFileName);
    await fs.promises.writeFile(configPath, data, 'utf8');
  }
}

// 缓存清理函数
function startCacheCleaner() {
  setInterval(async () => {
    if (DebugLog) {
      console.log('panyq: 开始清理缓存');
    }

    // 清理finalLinkCache
    await finalLinkCacheLock.runExclusive(() => {
      finalLinkCache.clear();
    });

    // 清理searchResultCache
    await searchResultCacheLock.runExclusive(() => {
      searchResultCache.clear();
    });

    if (DebugLog) {
      console.log('panyq: 缓存清理完成');
    }
  }, 30 * 60 * 1000); // 每30分钟清理一次
}

// 启动缓存清理
startCacheCleaner();

// 导出插件实例
export default new PanyqPlugin();