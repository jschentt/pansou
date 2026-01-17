import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import { SearchResult, Link, PluginSearchResult } from '../../../model';
import { FilterResultsByKeyword } from '../../../util/plugin.util';

// 常量定义
const BaseURL = "https://quark4k.com/api/discussions";
const PageSize = 50; // 符合API实际返回数量
const MaxRetries = 2;

// 常用UA列表
const userAgents = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/92.0.4515.107 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.1.2 Safari/605.1.15",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:90.0) Gecko/20100101 Firefox/90.0",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.114 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/92.0.4515.107 Safari/537.36",
];

// API响应结构
interface Quark4KResponse {
    links: Quark4KLinks;
    data: Quark4KDiscussion[];
    included: Quark4KIncludedItem[];
}

interface Quark4KLinks {
    first: string;
    next?: string;
}

interface Quark4KDiscussion {
    type: string;
    id: string;
    attributes: Quark4KDiscussionAttributes;
    relationships: Quark4KRelationships;
}

interface Quark4KDiscussionAttributes {
    title: string;
    slug: string;
    commentCount: number;
    participantCount: number;
    createdAt: string;
    lastPostedAt: string;
    lastPostNumber: number;
    isApproved: boolean;
    isLocked: boolean;
}

interface Quark4KRelationships {
    mostRelevantPost: Quark4KPostRef;
}

interface Quark4KPostRef {
    data: Quark4KPostData;
}

interface Quark4KPostData {
    type: string;
    id: string;
}

interface Quark4KIncludedItem {
    type: string;
    id: string;
    attributes: any;
}

interface Quark4KPost {
    type: string;
    id: string;
    attributes: Quark4KPostAttributes;
}

interface Quark4KPostAttributes {
    number: number;
    createdAt: string;
    contentType: string;
    contentHtml: string;
    renderFailed: boolean;
    editedAt?: string;
    isApproved: boolean;
    likesCount: number;
}

// Quark4KPlugin Quark4K搜索插件
class Quark4KPlugin {
    private client: AxiosInstance;
    private MainCacheKey: string;
    private name: string;
    private retries: number;

    constructor() {
        this.client = axios.create({
            timeout: 30000,
            headers: {
                'Accept': 'application/json, text/plain, */*',
                'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
                'Connection': 'keep-alive',
                'Sec-Fetch-Dest': 'empty',
                'Sec-Fetch-Mode': 'cors',
                'Sec-Fetch-Site': 'same-origin',
                'Referer': 'https://quark4k.com/',
            },
            httpsAgent: new (require('https').Agent)({
                rejectUnauthorized: false
            })
        });

        this.MainCacheKey = 'quark4k';
        this.name = 'quark4k';
        this.retries = MaxRetries;
    }

    // Name 返回插件名称
    Name(): string {
        return this.name;
    }

    // Search 执行搜索并返回结果（兼容性方法）
    async Search(keyword: string, ext: Record<string, any>): Promise<SearchResult[]> {
        const result = await this.SearchWithResult(keyword, ext);
        return result.Results;
    }

    // SearchWithResult 执行搜索并返回包含IsFinal标记的结果
    async SearchWithResult(keyword: string, ext: Record<string, any>): Promise<PluginSearchResult> {
        const results = await this.doSearch(keyword, ext);
        return {
            Results: results,
            IsFinal: true
        };
    }

    // doSearch 实际的搜索实现
    private async doSearch(keyword: string, ext: Record<string, any>): Promise<SearchResult[]> {
        // 只并发请求2个页面（0-1页）
        const allResults = await this.fetchBatch(keyword, 0, 2);
        
        // 去重
        const uniqueResults = this.deduplicateResults(allResults);
        
        // 使用过滤功能过滤结果
        const filteredResults = FilterResultsByKeyword(uniqueResults, keyword);
        
        return filteredResults;
    }

    // fetchBatch 获取一批页面的数据
    private async fetchBatch(keyword: string, startOffset: number, pageCount: number): Promise<SearchResult[]> {
        const promises: Promise<{ results: SearchResult[], hasMore: boolean }>[] = [];

        for (let i = 0; i < pageCount; i++) {
            const offset = (startOffset + i) * PageSize;
            
            // 第一个请求立即执行，后续请求添加随机延迟
            const promise = i === 0 
                ? this.fetchPage(keyword, offset)
                : new Promise<{ results: SearchResult[], hasMore: boolean }>(async (resolve) => {
                    // 随机等待0-1秒
                    const randomDelay = 100 + Math.floor(Math.random() * 900);
                    await this.sleep(randomDelay);
                    resolve(await this.fetchPage(keyword, offset));
                });
            
            promises.push(promise);
        }

        // 等待所有请求完成
        const results = await Promise.all(promises);
        
        // 收集结果
        let allResults: SearchResult[] = [];
        
        for (const result of results) {
            allResults = allResults.concat(result.results);
        }
        
        return allResults;
    }

    // sleep 延迟指定时间
    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    // deduplicateResults 去除重复结果
    private deduplicateResults(results: SearchResult[]): SearchResult[] {
        const seen = new Map<string, boolean>();
        const unique: SearchResult[] = [];
        
        for (const result of results) {
            if (!seen.has(result.UniqueID)) {
                seen.set(result.UniqueID, true);
                unique.push(result);
            }
        }
        
        // 按时间降序排序
        unique.sort((a, b) => {
            return new Date(b.Datetime).getTime() - new Date(a.Datetime).getTime();
        });
        
        return unique;
    }

    // fetchPage 获取指定页的搜索结果
    private async fetchPage(keyword: string, offset: number): Promise<{ results: SearchResult[], hasMore: boolean }> {
        // 构建API URL
        const apiURL = `${BaseURL}?include=user%2ClastPostedUser%2CmostRelevantPost%2CmostRelevantPost.user%2Ctags%2Ctags.parent%2CfirstPost&filter[q]=${encodeURIComponent(keyword)}&sort&page[offset]=${offset}&page[limit]=${PageSize}`;
        
        let responseBody: any;
        
        // 重试逻辑
        for (let i = 0; i <= this.retries; i++) {
            try {
                // 创建请求
                const config: AxiosRequestConfig = {
                    method: 'GET',
                    url: apiURL,
                    headers: {
                        'User-Agent': this.getRandomUA(),
                        'X-Forwarded-For': this.generateRandomIP(),
                    }
                };
                
                // 发送请求
                const resp = await this.client.request(config);
                
                // 状态码检查
                if (resp.status !== 200) {
                    if (i === this.retries) {
                        throw new Error(`API返回非200状态码: ${resp.status}`);
                    }
                    await this.sleep(500);
                    continue;
                }
                
                responseBody = resp.data;
                break;
            } catch (error) {
                if (i === this.retries) {
                    throw new Error(`请求失败: ${error}`);
                }
                await this.sleep(500);
            }
        }
        
        // 解析响应
        const apiResp: Quark4KResponse = responseBody;
        
        // 处理结果
        const results: SearchResult[] = [];
        
        // 从included数组中提取posts，创建帖子ID到帖子内容的映射
        const postMap = new Map<string, Quark4KPost>();
        for (const item of apiResp.included) {
            // 只处理posts类型
            if (item.type === "posts") {
                // 将整个item转换为帖子
                const post: Quark4KPost = {
                    type: item.type,
                    id: item.id,
                    attributes: {
                        number: item.attributes.number,
                        createdAt: item.attributes.createdAt,
                        contentType: item.attributes.contentType,
                        contentHtml: item.attributes.contentHtml,
                        renderFailed: item.attributes.renderFailed,
                        editedAt: item.attributes.editedAt,
                        isApproved: item.attributes.isApproved,
                        likesCount: item.attributes.likesCount
                    }
                };
                postMap.set(post.id, post);
            }
        }
        
        // 将关键词转为小写，用于不区分大小写的比较
        const lowerKeyword = keyword.toLowerCase();
        const keywords = lowerKeyword.split(/\s+/);
        
        // 遍历搜索结果
        for (const discussion of apiResp.data) {
            // 提前检查标题是否包含关键词，避免不必要的处理
            const lowerTitle = discussion.attributes.title.toLowerCase();
            let titleMatched = true;
            for (const kw of keywords) {
                if (!lowerTitle.includes(kw)) {
                    titleMatched = false;
                    break;
                }
            }
            if (!titleMatched) {
                continue; // 标题中不包含关键词，跳过
            }
            
            // 获取相关帖子
            const postID = discussion.relationships.mostRelevantPost.data.id;
            const post = postMap.get(postID);
            if (!post) {
                continue;
            }
            
            // 清理HTML内容
            const cleanedHTML = this.cleanHTML(post.attributes.contentHtml);
            
            // 提取链接（主要处理夸克网盘）
            const links = this.extractQuarkLinksFromText(cleanedHTML);
            
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
            const uniqueID = `quark4k-${discussion.id}`;
            
            // 创建搜索结果
            const result: SearchResult = {
                UniqueID: uniqueID,
                Title: discussion.attributes.title,
                Content: cleanedHTML, // 使用清理后的HTML作为内容
                Datetime: createdTime,
                Links: links,
                Channel: "", // 插件搜索结果Channel为空
            };
            
            results.push(result);
        }
        
        // 判断是否有更多结果
        const hasMore = !!apiResp.links.next;
        
        return { results, hasMore };
    }

    // 生成随机IP
    private generateRandomIP(): string {
        return `${Math.floor(Math.random() * 223) + 1}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 254) + 1}`;
    }

    // 获取随机UA
    private getRandomUA(): string {
        return userAgents[Math.floor(Math.random() * userAgents.length)];
    }

    // 清理HTML内容
    private cleanHTML(html: string): string {
        // 移除<br>标签
        html = html.replace(/<br\s*\/?>/g, "\n");
        
        // 移除其他HTML标签
        let result = "";
        let inTag = false;
        
        for (const r of html) {
            if (r === '<') {
                inTag = true;
                continue;
            }
            if (r === '>') {
                inTag = false;
                continue;
            }
            if (!inTag) {
                result += r;
            }
        }
        
        // 处理HTML实体
        let output = result;
        output = output.replace(/&amp;/g, "&");
        output = output.replace(/&lt;/g, "<");
        output = output.replace(/&gt;/g, ">");
        output = output.replace(/&quot;/g, '"');
        output = output.replace(/&apos;/g, "'");
        output = output.replace(/&#39;/g, "'");
        output = output.replace(/&nbsp;/g, " ");
        
        // 处理多行空白
        const lines = output.split("\n");
        const cleanedLines: string[] = [];
        
        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed !== "") {
                cleanedLines.push(trimmed);
            }
        }
        
        return cleanedLines.join("\n");
    }

    // 从文本提取夸克网盘链接
    private extractQuarkLinksFromText(content: string): Link[] {
        const allLinks: Link[] = [];
        
        const lines = content.split("\n");
        
        // 收集所有可能的链接信息
        const linkInfos: { link: Link; position: number; category: string }[] = [];
        
        // 收集所有可能的密码信息
        const passwordInfos: { keyword: string; position: number; password: string }[] = [];
        
        // 第一遍：查找所有的链接和密码
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            
            // 主要检查夸克网盘
            if (line.includes("pan.quark.cn")) {
                const url = this.extractURLFromText(line);
                if (url !== "") {
                    linkInfos.push({
                        link: { URL: url, Type: "quark" },
                        position: i,
                        category: "quark"
                    });
                }
            }
            
            // 检查提取码/密码
            const passwordKeywords = ["提取码", "密码"];
            for (const keyword of passwordKeywords) {
                if (line.includes(keyword)) {
                    // 寻找冒号后面的内容
                    let colonPos = line.indexOf(":");
                    if (colonPos === -1) {
                        colonPos = line.indexOf("：");
                    }
                    
                    if (colonPos !== -1 && colonPos + 1 < line.length) {
                        let password = line.substring(colonPos + 1).trim();
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
        for (let i = 0; i < linkInfos.length; i++) {
            // 检查链接自身是否包含密码
            const password = this.extractPasswordFromURL(linkInfos[i].link.URL);
            if (password !== "") {
                linkInfos[i].link.Password = password;
                continue;
            }
            
            // 查找最近的密码
            let minDistance = 1000000;
            let closestPassword = "";
            
            for (const pwInfo of passwordInfos) {
                // 夸克网盘匹配提取码或密码
                let match = false;
                
                if (linkInfos[i].category === "quark" && (pwInfo.keyword === "提取码" || pwInfo.keyword === "密码")) {
                    match = true;
                }
                
                if (match) {
                    const distance = Math.abs(pwInfo.position - linkInfos[i].position);
                    if (distance < minDistance) {
                        minDistance = distance;
                        closestPassword = pwInfo.password;
                    }
                }
            }
            
            // 只有当距离较近时才认为是匹配的密码
            if (minDistance <= 3) {
                linkInfos[i].link.Password = closestPassword;
            }
        }
        
        // 收集所有有效链接
        for (const info of linkInfos) {
            allLinks.push(info.link);
        }
        
        return allLinks;
    }

    // 从文本中提取URL
    private extractURLFromText(text: string): string {
        // 查找URL的起始位置
        const urlPrefixes = ["http://", "https://"];
        let start = -1;
        
        for (const prefix of urlPrefixes) {
            const pos = text.indexOf(prefix);
            if (pos !== -1) {
                start = pos;
                break;
            }
        }
        
        if (start === -1) {
            return "";
        }
        
        // 查找URL的结束位置
        let end = text.length;
        const endChars = [" ", "\t", "\n", '"', "'", "<", ">", ")", "]", "}", ",", ";"];
        
        for (const char of endChars) {
            const pos = text.substring(start).indexOf(char);
            if (pos !== -1 && start + pos < end) {
                end = start + pos;
            }
        }
        
        return text.substring(start, end);
    }

    // 从URL中提取密码
    private extractPasswordFromURL(url: string): string {
        // 查找密码参数
        const pwdParams = ["pwd=", "password=", "passcode=", "code="];
        
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
        
        return "";
    }
}

// 创建并导出插件实例
const plugin = new Quark4KPlugin();
export default plugin;
