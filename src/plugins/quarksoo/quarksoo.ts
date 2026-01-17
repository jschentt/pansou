import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import { SearchResult, Link, PluginSearchResult } from '../../../model';
import { FilterResultsByKeyword } from '../../../util/plugin.util';
import * as crypto from 'crypto';

// 常量定义
const BaseURL = "https://quarksoo.cc/search.php";
const MaxRetries = 2;
const RequestTimeout = 30000; // 请求超时时间：30秒

// 常用UA列表
const userAgents = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/92.0.4515.107 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.1.2 Safari/605.1.15",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:90.0) Gecko/20100101 Firefox/90.0",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.114 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/92.0.4515.107 Safari/537.36",
];

// QuarksooPlugin Quarksoo搜索插件
class QuarksooPlugin {
    private client: AxiosInstance;
    private MainCacheKey: string;
    private name: string;
    private retries: number;

    constructor() {
        this.client = axios.create({
            timeout: RequestTimeout,
            headers: {
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
                'Connection': 'keep-alive',
                'Referer': 'https://quarksoo.cc/',
            },
            httpsAgent: new (require('https').Agent)({
                rejectUnauthorized: false
            })
        });

        this.MainCacheKey = 'quarksoo';
        this.name = 'quarksoo';
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
        // 构建搜索URL
        const searchURL = `${BaseURL}?q=${encodeURIComponent(keyword)}`;
        
        let responseBody: string;
        
        // 重试逻辑
        for (let i = 0; i <= this.retries; i++) {
            try {
                // 创建请求
                const config: AxiosRequestConfig = {
                    method: 'GET',
                    url: searchURL,
                    headers: {
                        'User-Agent': this.getRandomUA(),
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
        
        // 解析HTML内容
        const results = this.parseSearchResults(responseBody, keyword);
        
        // 去重
        const uniqueResults = this.deduplicateResults(results);
        
        // 使用过滤功能过滤结果（二次过滤）
        const filteredResults = FilterResultsByKeyword(uniqueResults, keyword);
        
        return filteredResults;
    }

    // sleep 延迟指定时间
    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    // parseSearchResults 从HTML中解析搜索结果
    private parseSearchResults(htmlContent: string, keyword: string): SearchResult[] {
        const results: SearchResult[] = [];
        
        // 提前过滤：检查标题是否包含关键词
        const lowerKeyword = keyword.toLowerCase();
        const keywords = lowerKeyword.split(/\s+/);
        
        // 使用正则表达式提取表格行
        // 匹配格式: <tr><td>剧名</td><td><a href="链接">...</a></td></tr>
        // 注意处理可能的空白字符
        const pattern = `<tr>\s*<td>([^<]+)</td>\s*<td>\s*<a[^>]*href\s*=\s*["']([^"']+)["'][^>]*>`;
        const re = new RegExp(pattern, 'g');
        let match;
        
        while ((match = re.exec(htmlContent)) !== null) {
            if (match.length < 3) {
                continue;
            }
            
            const title = match[1].trim();
            const linkURL = match[2].trim();
            
            // 跳过表头（如果匹配到）
            if (title.includes("剧名") || title.includes("网盘链接")) {
                continue;
            }
            
            // 验证链接是否为夸克网盘
            if (!linkURL.includes("pan.qoark.cn") && !linkURL.includes("pan.quark.cn")) {
                continue;
            }
            
            // 检查标题是否包含关键词（提前过滤）
            const lowerTitle = title.toLowerCase();
            let titleMatched = true;
            for (const kw of keywords) {
                if (!lowerTitle.includes(kw)) {
                    titleMatched = false;
                    break;
                }
            }
            if (!titleMatched) {
                continue;
            }
            
            // 识别网盘类型
            const linkType = "quark";
            
            // 生成唯一ID：使用标题和链接的MD5哈希
            const uniqueIDKey = `${title}|${linkURL}`;
            const hash = crypto.createHash('md5').update(uniqueIDKey).digest('hex');
            const uniqueID = `quarksoo-${hash.substring(0, 8)}`; // 使用前8字节作为ID
            
            const result: SearchResult = {
                UniqueID: uniqueID,
                Title: title,
                Links: [
                    {
                        Type: linkType,
                        URL: linkURL,
                        Password: "", // 无密码
                    }
                ],
                Channel: "", // 插件搜索结果Channel为空
                Datetime: new Date(), // 页面无时间信息，使用当前时间
            };
            
            results.push(result);
        }
        
        return results;
    }

    // deduplicateResults 去除重复结果
    private deduplicateResults(results: SearchResult[]): SearchResult[] {
        const seen = new Map<string, boolean>();
        const unique: SearchResult[] = [];
        
        for (const result of results) {
            // 使用UniqueID进行去重
            if (!seen.has(result.UniqueID)) {
                seen.set(result.UniqueID, true);
                unique.push(result);
            }
        }
        
        // 按标题排序（保持一致性）
        unique.sort((a, b) => {
            return a.Title.localeCompare(b.Title);
        });
        
        return unique;
    }

    // 获取随机UA
    private getRandomUA(): string {
        return userAgents[Math.floor(Math.random() * userAgents.length)];
    }
}

// 创建并导出插件实例
const plugin = new QuarksooPlugin();
export default plugin;
