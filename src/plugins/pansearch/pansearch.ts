import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import { BaseAsyncPlugin } from '../plugin.manager';
import { SearchResult, Link } from '../../models/plugin-result';
import * as url from 'url';
import * as cheerio from 'cheerio';

// 预编译正则表达式
const buildIdRegex = /"buildId":"([^"]+)"/;
const nextDataRegex = /<script id="__NEXT_DATA__" type="application/json">(.*?)<\/script>/;

// 缓存相关变量
const searchResultCache = new Map<string, CachedResponse>();
let lastCacheCleanTime = new Date();
const cacheTTL = 1 * 60 * 60 * 1000; // 1小时

// 缓存清理定时器
let cacheCleanerTimer: NodeJS.Timeout;

// 在模块加载时注册插件
registerGlobalPlugin(new PanSearchPlugin());

// 启动缓存清理定时器
startCacheCleaner();

// 启动一个定期清理缓存的定时器
function startCacheCleaner(): void {
    // 每小时清理一次缓存
    cacheCleanerTimer = setInterval(() => {
        // 清空所有缓存
        searchResultCache.clear();
        lastCacheCleanTime = new Date();
    }, 1 * 60 * 60 * 1000);
}

// 缓存响应结构
interface CachedResponse {
    results: SearchResult[];
    timestamp: Date;
}

// 常量定义
const WebsiteURL = "https://www.pansearch.me/search";
const BaseURLTemplate = "https://www.pansearch.me/_next/data/%s/search.json";

// 默认参数
const DefaultTimeout = 6000; // 减少默认超时时间（毫秒）
const PageSize = 10;
const MaxResults = 1000;
const MaxConcurrent = 200; // 增加最大并发数
const MaxRetries = 2;
const MaxAPIPages = 100; // API最大页数限制

// buildId缓存有效期（分钟）- 减少缓存时间以确保更及时更新
const BuildIdCacheDuration = 30;

// 缓存buildId和过期时间
let buildIdCache = "";
let buildIdCacheTime = new Date();
let buildIdMutex = false;

// 工作池任务
interface Task {
    keyword: string;
    offset: number;
    baseURL: string;
}

// 任务结果
interface TaskResult {
    offset: number;
    results: PanSearchItem[];
}

// 工作池结构
class WorkerPool {
    private tasks: Task[] = [];
    private results: TaskResult[] = [];
    private errors: Error[] = [];
    private workers: Promise<void>[] = [];
    private closed = false;
    private mutex = false;

    constructor(private size: number) {
    }

    // 启动工作池
    public start(ctx: any, handler: (ctx: any, task: Task) => Promise<TaskResult>): void {
        for (let i = 0; i < this.size; i++) {
            this.workers.push(this.workerLoop(ctx, handler));
        }
    }

    // 工作循环
    private async workerLoop(ctx: any, handler: (ctx: any, task: Task) => Promise<TaskResult>): Promise<void> {
        while (!this.closed) {
            let task: Task | undefined;
            
            // 获取任务
            this.mutex = true;
            if (this.tasks.length > 0) {
                task = this.tasks.shift();
            }
            this.mutex = false;

            if (!task) {
                // 没有任务，等待一段时间
                await new Promise(resolve => setTimeout(resolve, 100));
                continue;
            }

            try {
                const result = await handler(ctx, task);
                this.results.push(result);
            } catch (error) {
                this.errors.push(error as Error);
            }
        }
    }

    // 提交任务到工作池
    public submit(task: Task): boolean {
        if (this.closed) {
            return false;
        }

        this.mutex = true;
        this.tasks.push(task);
        this.mutex = false;

        return true;
    }

    // 关闭工作池
    public close(): void {
        this.closed = true;
    }

    // 获取结果
    public getResults(): TaskResult[] {
        return this.results;
    }

    // 获取错误
    public getErrors(): Error[] {
        return this.errors;
    }

    // 等待所有任务完成
    public async waitForCompletion(): Promise<void> {
        await Promise.all(this.workers);
    }
}

// API响应结构
interface PanSearchResponse {
    pageProps: {
        data: {
            total: number;
            data: PanSearchItem[];
            time: number;
        };
        limit: number;
        isMobile: boolean;
    };
    __N_SSP: boolean;
}

// API响应中的单个结果项
interface PanSearchItem {
    id: number;
    content: string;
    pan: string;
    image: string;
    time: string;
}

export class PanSearchPlugin extends BaseAsyncPlugin {
    private timeout: number;
    private maxResults: number;
    private maxConcurrent: number;
    private retries: number;
    private workerPool: WorkerPool | null = null;

    constructor() {
        super("pansearch", 3); // 优先级3
        this.timeout = DefaultTimeout;
        this.maxResults = MaxResults;
        this.maxConcurrent = MaxConcurrent;
        this.retries = MaxRetries;

        // 初始化时预热获取 buildId
        setTimeout(() => {
            this.getBuildId();
        }, 1000);

        // 启动后台 buildId 更新器
        this.startBuildIdUpdater();
    }

    Name(): string {
        return "pansearch";
    }

    DisplayName(): string {
        return "PanSearch";
    }

    Description(): string {
        return "PanSearch - 网盘资源搜索";
    }

    // 启动一个定期更新 buildId 的后台定时器
    private startBuildIdUpdater(): void {
        // 每10分钟更新一次 buildId
        setInterval(() => {
            this.updateBuildId();
        }, 10 * 60 * 1000);
    }

    // 更新 buildId 缓存
    private async updateBuildId(): Promise<void> {
        try {
            // 创建请求配置
            const config: AxiosRequestConfig = {
                method: 'GET',
                url: WebsiteURL,
                timeout: this.timeout,
                headers: {
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
                    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
                    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
                    "Connection": "keep-alive",
                    "Upgrade-Insecure-Requests": "1",
                    "Cache-Control": "max-age=0"
                }
            };

            const resp = await axios(config);

            if (resp.status !== 200) {
                console.log(`获取buildId时服务器返回非200状态码: ${resp.status}`);
                return;
            }

            // 尝试提取 buildId
            const newBuildId = extractBuildId(resp.data);
            if (newBuildId === "") {
                console.log("未能从响应中提取 buildId");
                return;
            }

            // 更新缓存
            while (buildIdMutex) {
                // 等待互斥锁释放
                await new Promise(resolve => setTimeout(resolve, 10));
            }

            buildIdMutex = true;

            // 只有当新的 buildId 不为空且与当前缓存不同时才更新
            if (newBuildId !== "" && newBuildId !== buildIdCache) {
                buildIdCache = newBuildId;
                buildIdCacheTime = new Date();
                console.log(`成功更新 buildId: ${newBuildId}`);
            }

            buildIdMutex = false;
        } catch (error) {
            // 忽略错误
        }
    }

    // 获取buildId，优先使用缓存
    private async getBuildId(): Promise<string> {
        // 检查缓存是否有效
        while (buildIdMutex) {
            // 等待互斥锁释放
            await new Promise(resolve => setTimeout(resolve, 10));
        }

        if (buildIdCache !== "" && (Date.now() - buildIdCacheTime.getTime()) < BuildIdCacheDuration * 60 * 1000) {
            return buildIdCache;
        }

        // 缓存无效，需要重新获取
        buildIdMutex = true;

        // 双重检查
        if (buildIdCache !== "" && (Date.now() - buildIdCacheTime.getTime()) < BuildIdCacheDuration * 60 * 1000) {
            buildIdMutex = false;
            return buildIdCache;
        }

        try {
            // 创建请求配置
            const config: AxiosRequestConfig = {
                method: 'GET',
                url: WebsiteURL,
                timeout: this.timeout,
                headers: {
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
                    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
                    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
                    "Connection": "keep-alive",
                    "Upgrade-Insecure-Requests": "1",
                    "Cache-Control": "max-age=0"
                }
            };

            let resp;
            let respErr;

            // 使用重试机制发送请求
            for (let retry = 0; retry <= this.retries; retry++) {
                if (retry > 0) {
                    // 指数退避重试
                    const backoffTime = Math.pow(2, retry - 1) * 100;
                    await new Promise(resolve => setTimeout(resolve, backoffTime));
                }

                try {
                    resp = await axios(config);
                    respErr = null;
                    break;
                } catch (error) {
                    respErr = error;
                }
            }

            // 如果所有重试都失败，但有旧的缓存，使用旧的缓存（优雅降级）
            if (respErr !== null) {
                if (buildIdCache !== "") {
                    console.log("请求失败，使用旧的buildId");
                    buildIdMutex = false;
                    return buildIdCache;
                }
                throw new Error(`请求失败: ${respErr}`);
            }

            if (resp!.status !== 200) {
                // 如果状态码不是200，但有旧的缓存，使用旧的缓存（优雅降级）
                if (buildIdCache !== "") {
                    console.log(`获取buildId时服务器返回非200状态码: ${resp!.status}，使用旧的buildId`);
                    buildIdMutex = false;
                    return buildIdCache;
                }
                throw new Error(`获取buildId时服务器返回非200状态码: ${resp!.status}`);
            }

            // 使用提取函数获取 buildId
            const buildId = extractBuildId(resp!.data);

            // 如果提取失败，但有旧的缓存，使用旧的缓存（优雅降级）
            if (buildId === "") {
                if (buildIdCache !== "") {
                    console.log("未找到buildId，使用旧的buildId");
                    buildIdMutex = false;
                    return buildIdCache;
                }
                throw new Error("未找到buildId");
            }

            // 更新缓存
            buildIdCache = buildId;
            buildIdCacheTime = new Date();

            buildIdMutex = false;

            return buildId;
        } catch (error) {
            // 如果有旧的缓存，使用旧的缓存（优雅降级）
            if (buildIdCache !== "") {
                console.log(`获取buildId失败，使用旧的buildId: ${error}`);
                buildIdMutex = false;
                return buildIdCache;
            }

            buildIdMutex = false;
            throw error;
        }
    }

    // 获取完整的API基础URL
    private async getBaseURL(client: AxiosInstance): Promise<string> {
        const buildId = await this.getBuildId();
        return BaseURLTemplate.replace("%s", buildId);
    }

    // 执行具体的搜索逻辑
    protected async searchImpl(client: AxiosInstance, keyword: string, ext: Record<string, any>): Promise<SearchResult[]> {
        // 检查缓存
        const cached = searchResultCache.get(keyword);
        if (cached && (Date.now() - cached.timestamp.getTime()) < cacheTTL) {
            return cached.results;
        }

        // 获取API基础URL
        let baseURL;
        try {
            baseURL = await this.getBaseURL(client);
        } catch (error) {
            throw new Error(`获取API基础URL失败: ${error}`);
        }

        // 1. 发起首次请求获取total和第一页数据
        let firstPageResults: PanSearchItem[];
        let total: number;
        try {
            [firstPageResults, total] = await this.fetchFirstPage(keyword, baseURL, client);
        } catch (error) {
            // 如果返回404错误，可能是buildId过期，尝试强制刷新buildId
            if (error instanceof Error && (error.message.includes("404") || error.message.includes("Not Found"))) {
                console.log("检测到404错误，buildId可能已过期，尝试强制刷新");

                // 强制刷新buildId
                buildIdMutex = true;
                buildIdCache = "";              // 清空缓存
                buildIdCacheTime = new Date(0); // 重置缓存时间
                buildIdMutex = false;

                // 重新获取buildId
                try {
                    baseURL = await this.getBaseURL(client);
                    // 重试请求
                    [firstPageResults, total] = await this.fetchFirstPage(keyword, baseURL, client);
                } catch (err) {
                    throw new Error(`刷新buildId后获取首页仍然失败: ${err}`);
                }
            } else {
                throw new Error(`获取首页失败: ${error}`);
            }
        }

        let allResults = firstPageResults;

        // 2. 计算需要的页数，但限制在最大结果数内和API最大页数内
        const remainingResults = Math.min(total - PageSize, this.maxResults - PageSize);
        if (remainingResults <= 0) {
            const results = this.convertResults(allResults, keyword);
            
            // 缓存结果
            searchResultCache.set(keyword, {
                results: results,
                timestamp: new Date()
            });
            
            return results;
        }

        // 计算需要的页数，考虑API的100页限制
        const neededPages = Math.min(Math.ceil(remainingResults / PageSize), MaxAPIPages - 1); // 向上取整，减1是因为第一页已经获取

        // 如果只需要获取少量页面，直接返回
        if (neededPages <= 0) {
            const results = this.convertResults(allResults, keyword);
            
            // 缓存结果
            searchResultCache.set(keyword, {
                results: results,
                timestamp: new Date()
            });
            
            return results;
        }

        // 根据实际页数确定并发数，但不超过最大并发数
        const actualConcurrent = Math.min(neededPages, this.maxConcurrent);

        // 创建适合实际并发数的工作池
        this.workerPool = new WorkerPool(actualConcurrent);

        // 创建上下文用于管理所有请求
        const ctx = {
            timeout: this.timeout * 2,
            startTime: Date.now()
        };

        // 创建一个标志，用于标记是否需要刷新buildId
        let needRefreshBuildId = false;
        let buildIdRefreshPromise: Promise<string> | null = null;

        // 启动工作池
        this.workerPool.start(ctx, async (ctx: any, task: Task): Promise<TaskResult> => {
            for (let retry = 0; retry <= this.retries; retry++) {
                // 如果有其他协程发现buildId过期，等待刷新完成
                if (needRefreshBuildId) {
                    if (buildIdRefreshPromise) {
                        await buildIdRefreshPromise;
                        // 更新baseURL
                        task.baseURL = await this.getBaseURL(client);
                    }
                    needRefreshBuildId = false;
                }

                try {
                    const pageResults = await this.fetchPage(task.keyword, task.offset, task.baseURL, client);
                    return { offset: task.offset, results: pageResults };
                } catch (error) {
                    // 如果返回404错误，可能是buildId过期
                    if (error instanceof Error && (error.message.includes("404") || error.message.includes("Not Found"))) {
                        // 标记需要刷新buildId
                        if (!needRefreshBuildId) {
                            needRefreshBuildId = true;
                            // 在一个新的Promise中刷新buildId
                            buildIdRefreshPromise = (async () => {
                                buildIdMutex = true;
                                buildIdCache = "";              // 清空缓存
                                buildIdCacheTime = new Date(0); // 重置缓存时间
                                buildIdMutex = false;
                                
                                // 重新获取buildId
                                return await this.getBuildId();
                            })();
                        }
                        
                        // 等待刷新完成
                        if (buildIdRefreshPromise) {
                            await buildIdRefreshPromise;
                            // 更新baseURL
                            task.baseURL = await this.getBaseURL(client);
                        }
                        
                        needRefreshBuildId = false;
                        continue;
                    }

                    if (retry < this.retries) {
                        // 指数退避重试
                        const backoffTime = Math.pow(2, retry) * 100;
                        await new Promise(resolve => setTimeout(resolve, backoffTime));
                    } else {
                        throw error;
                    }
                }
            }

            throw new Error("所有重试都失败");
        });

        // 提交任务计数器
        let submittedTasks = 0;

        // 简化批次处理逻辑，考虑到最多只有99页需要获取（第一页已经获取）
        // 使用两个批次：每批次最多50页，避免一次性提交过多任务
        const batchSize = Math.max(1, Math.ceil(neededPages / 2)); // 将总页数分成两批

        // 提交所有任务
        for (let i = 0; i < neededPages; i += batchSize) {
            const end = Math.min(i + batchSize, neededPages);

            // 提交一批任务
            for (let j = i; j < end; j++) {
                const offset = PageSize + j * PageSize;
                if (offset < this.maxResults) {
                    const task: Task = {
                        keyword: keyword,
                        offset: offset,
                        baseURL: baseURL
                    };

                    // 尝试提交任务
                    if (!this.workerPool.submit(task)) {
                        console.log("无法提交任务，工作池可能已关闭");
                        break;
                    }

                    submittedTasks++;
                }
            }

            // 只有在有多个批次且不是最后一批时才等待
            if (batchSize < neededPages && end < neededPages) {
                await new Promise(resolve => setTimeout(resolve, 50));
            }
        }

        // 等待所有任务完成
        await this.workerPool.waitForCompletion();

        // 收集结果
        const results = this.workerPool.getResults();
        const errors = this.workerPool.getErrors();

        // 将所有结果合并
        for (const result of results) {
            allResults = [...allResults, ...result.results];
        }

        // 关闭工作池
        this.workerPool.close();

        // 如果所有请求都失败且没有获得首页以外的结果，则返回错误
        if (submittedTasks > 0 && errors.length === submittedTasks && allResults.length === firstPageResults.length) {
            const convertedResults = this.convertResults(allResults, keyword);
            
            // 缓存结果（即使有错误也缓存已获取的结果）
            searchResultCache.set(keyword, {
                results: convertedResults,
                timestamp: new Date()
            });
            
            throw new Error(`所有后续页面请求失败: ${errors[0]}`);
        }

        // 4. 去重和格式化结果
        const uniqueResults = this.deduplicateItems(allResults);
        const convertedResults = this.convertResults(uniqueResults, keyword);
        
        // 缓存结果
        searchResultCache.set(keyword, {
            results: convertedResults,
            timestamp: new Date()
        });

        return convertedResults;
    }

    // 获取第一页结果和总数
    private async fetchFirstPage(keyword: string, baseURL: string, client: AxiosInstance): Promise<[PanSearchItem[], number]> {
        // 构建请求URL
        const reqURL = `${baseURL}?keyword=${encodeURIComponent(keyword)}&offset=0`;

        // 创建请求配置
        const config: AxiosRequestConfig = {
            method: 'GET',
            url: reqURL,
            timeout: this.timeout,
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
                "Referer": "https://www.pansearch.me/",
                "Accept": "application/json, text/plain, */*",
                "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
                "Connection": "keep-alive",
                "Cache-Control": "no-cache",
                "Pragma": "no-cache"
            }
        };

        // 发送请求
        let resp;
        try {
            resp = await client(config);
        } catch (error) {
            throw new Error(`请求失败: ${error}`);
        }

        // 检查状态码
        if (resp.status === 404) {
            throw new Error("404 Not Found，buildId可能已过期");
        }

        if (resp.status !== 200) {
            throw new Error(`服务器返回非200状态码: ${resp.status}`);
        }

        // 解析响应
        const apiResp: PanSearchResponse = resp.data;

        // 获取total和结果
        const total = apiResp.pageProps.data.total;
        const items = apiResp.pageProps.data.data;

        return [items, total];
    }

    // 获取指定偏移量的页面
    private async fetchPage(keyword: string, offset: number, baseURL: string, client: AxiosInstance): Promise<PanSearchItem[]> {
        // 构建请求URL
        const reqURL = `${baseURL}?keyword=${encodeURIComponent(keyword)}&offset=${offset}`;

        // 创建请求配置
        const config: AxiosRequestConfig = {
            method: 'GET',
            url: reqURL,
            timeout: this.timeout,
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
                "Referer": "https://www.pansearch.me/",
                "Accept": "application/json, text/plain, */*",
                "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
                "Connection": "keep-alive",
                "Cache-Control": "no-cache",
                "Pragma": "no-cache"
            }
        };

        // 发送请求
        let resp;
        try {
            resp = await client(config);
        } catch (error) {
            throw new Error(`请求失败: ${error}`);
        }

        // 检查状态码
        if (resp.status === 404) {
            throw new Error("404 Not Found，buildId可能已过期");
        }

        if (resp.status !== 200) {
            throw new Error(`服务器返回非200状态码: ${resp.status}`);
        }

        // 解析响应
        const apiResp: PanSearchResponse = resp.data;

        return apiResp.pageProps.data.data;
    }

    // 去重处理
    private deduplicateItems(items: PanSearchItem[]): PanSearchItem[] {
        // 使用Map进行去重，键为资源ID
        const uniqueMap = new Map<number, PanSearchItem>();

        for (const item of items) {
            uniqueMap.set(item.id, item);
        }

        // 将Map转回数组
        return Array.from(uniqueMap.values());
    }

    // 将API响应转换为标准SearchResult格式
    private convertResults(items: PanSearchItem[], keyword: string): SearchResult[] {
        const results: SearchResult[] = [];

        for (const item of items) {
            // 提取链接和密码
            const linkInfo = extractLinkAndPassword(item.content);

            // 获取链接类型，确保映射到系统支持的类型
            let linkType = item.pan;
            // 将aliyundrive映射到aliyun
            if (linkType === "aliyundrive") {
                linkType = "aliyun";
            }

            // 创建链接
            const link: Link = {
                URL: linkInfo.URL,
                Type: linkType,
                Password: linkInfo.Password
            };

            // 创建唯一ID
            const uniqueID = `pansearch-${item.id}`;

            // 解析时间
            let datetime = new Date();
            if (item.time) {
                datetime = new Date(item.time);
            }

            // 创建搜索结果
            const result: SearchResult = {
                UniqueID: uniqueID,
                Title: extractTitle(item.content, keyword),
                Content: item.content,
                Datetime: datetime,
                Links: [link]
            };

            results.push(result);
        }

        return results;
    }
}

// 从 HTML 内容中提取 buildId
function extractBuildId(body: string): string {
    // 使用预编译的正则表达式提取buildId
    const matches = buildIdRegex.exec(body);

    if (matches && matches.length >= 2) {
        return matches[1];
    }

    // 尝试从NEXT_DATA中提取
    const scriptMatches = nextDataRegex.exec(body);

    if (scriptMatches && scriptMatches.length >= 2) {
        try {
            const nextData = JSON.parse(scriptMatches[1]);
            if (nextData.buildId) {
                return nextData.buildId;
            }
        } catch (error) {
            // 忽略解析错误
        }
    }

    return "";
}

// 链接信息
interface LinkInfo {
    URL: string;
    Password: string;
}

// 从内容中提取链接和密码
function extractLinkAndPassword(content: string): LinkInfo {
    const linkInfo: LinkInfo = { URL: "", Password: "" };

    // 使用cheerio解析HTML
    const $ = cheerio.load(content);

    // 提取链接
    const aTag = $("a.resource-link");
    if (aTag.length > 0) {
        linkInfo.URL = aTag.attr("href") || "";
    }

    // 提取密码
    if (linkInfo.URL.includes("?pwd=")) {
        const pwdMatch = linkInfo.URL.match(/\?pwd=([^&"#]+)/);
        if (pwdMatch && pwdMatch.length > 1) {
            linkInfo.Password = pwdMatch[1];
        }
    } else {
        // 尝试从文本中提取密码
        const text = cleanHTML(content);
        const pwdMatch = text.match(/(?i)(?:提取|访问|提取密|密)码[：:]\s*([a-zA-Z0-9]{4})(?:[^a-zA-Z0-9]|$)/);
        if (pwdMatch && pwdMatch.length > 1) {
            linkInfo.Password = pwdMatch[1];
        }
    }

    return linkInfo;
}

// 从内容中提取标题
function extractTitle(content: string, keyword: string): string {
    // 标题通常在"名称："之后
    const titlePrefix = "名称：";
    const titleStartIndex = content.indexOf(titlePrefix);
    if (titleStartIndex === -1) {
        return keyword; // 使用搜索关键词作为默认标题
    }

    const titleStart = titleStartIndex + titlePrefix.length;
    const titleEndIndex = content.indexOf("\n", titleStart);
    if (titleEndIndex === -1) {
        return cleanHTML(content.substring(titleStart));
    }

    return cleanHTML(content.substring(titleStart, titleEndIndex));
}

// 清理HTML标签
function cleanHTML(html: string): string {
    // 替换常见HTML标签
    const replacements: Record<string, string> = {
        '<span class=\'highlight-keyword\'>': '',
        '</span>': '',
        '<a class="resource-link" target="_blank" href="': '',
        '</a>': '',
        '<br>': '\n',
        '<p>': '',
        '</p>': '\n'
    };

    let result = html;
    for (const tag in replacements) {
        result = result.replace(new RegExp(tag, 'g'), replacements[tag]);
    }

    // 清理其他HTML标签
    result = result.replace(/<[^>]*>/g, '');

    return result.trim();
}

// 导入registerGlobalPlugin函数
import { registerGlobalPlugin } from '../plugin.manager';
