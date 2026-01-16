import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import { BaseAsyncPlugin } from '../plugin.manager';
import { SearchResult, Link } from '../../models/plugin-result';

// 插件配置参数
const DebugLog = false;
const DefaultPagesPerType = 2;
const MaxAllowedPagesPerType = 3;

// 支持的网盘类型列表
const SupportedCloudTypes = ['ali', 'baidu', 'quark', 'xunlei', 'tianyi'];

// 搜索API响应结构
interface SearchAPIResponse {
    code: number;
    msg: string;
    data: {
        query: string;
        count: number;
        time: number;
        pages: number;
        page: number;
        list: ShareItem[];
    };
}

// 搜索结果项
interface ShareItem {
    hsid: string;
    platform: string;
    share_name: string;
    stat_file: number;
    stat_size: number;
}

// 链接获取API响应结构
interface FetchAPIResponse {
    code: number;
    msg: string;
    data: {
        share_code: string;
        share_pwd: string | null;
    };
}

// 页面搜索结果
interface PageResult {
    pageNo: number;
    cloudType: string;
    shareItems: ShareItem[];
    err: Error | null;
}

// 链接获取结果
interface LinkResult {
    hsid: string;
    shareURL: string;
    password: string;
    err: Error | null;
}

export class HaisouPlugin extends BaseAsyncPlugin {
    constructor() {
        super('haisou', 3); // 优先级3
    }

    Name(): string {
        return 'haisou';
    }

    DisplayName(): string {
        return '海搜';
    }

    Description(): string {
        return '海搜 - 多平台网盘搜索';
    }

    protected async searchImpl(client: AxiosInstance, keyword: string): Promise<SearchResult[]> {
        this.debugPrint(`开始搜索，关键词: ${keyword}`);

        // 1. 确定每种网盘类型的搜索页数
        const pagesPerType = DefaultPagesPerType;

        const totalTasks = SupportedCloudTypes.length * pagesPerType;
        this.debugPrint(`将分别搜索 ${SupportedCloudTypes.length} 种网盘类型，每种 ${pagesPerType} 页，总计 ${totalTasks} 个并发任务`);

        // 2. 第一阶段：并发搜索获取所有hsid
        const shareItemsChan: PageResult[] = [];
        const searchTasks = SupportedCloudTypes.flatMap(cloudType => {
            return Array.from({ length: pagesPerType }, (_, i) => {
                const pageNo = i + 1;
                return this.fetchSearchPage(client, keyword, pageNo, cloudType)
                    .then(shareItems => {
                        shareItemsChan.push({
                            pageNo,
                            cloudType,
                            shareItems,
                            err: null
                        });
                    })
                    .catch(err => {
                        shareItemsChan.push({
                            pageNo,
                            cloudType,
                            shareItems: [],
                            err
                        });
                    });
            });
        });

        // 等待所有搜索任务完成
        await Promise.all(searchTasks);

        // 3. 收集所有hsid
        let allShareItems: ShareItem[] = [];
        let successTasks = 0;
        let errorTasks = 0;
        const resultsByType: Record<string, number> = {};

        for (const pageResult of shareItemsChan) {
            if (pageResult.err) {
                errorTasks++;
                this.debugPrint(`${pageResult.cloudType}网盘第${pageResult.pageNo}页搜索失败: ${pageResult.err}`);
                continue;
            }

            successTasks++;
            allShareItems = allShareItems.concat(pageResult.shareItems);
            resultsByType[pageResult.cloudType] = (resultsByType[pageResult.cloudType] || 0) + pageResult.shareItems.length;
            this.debugPrint(`${pageResult.cloudType}网盘第${pageResult.pageNo}页成功获取 ${pageResult.shareItems.length} 个结果`);
        }

        this.debugPrint(`搜索阶段完成: 成功${successTasks}任务, 失败${errorTasks}任务, 总hsid${allShareItems.length}个`);
        for (const [cloudType, count] of Object.entries(resultsByType)) {
            this.debugPrint(`  - ${cloudType}网盘: ${count}个结果`);
        }

        // 4. 如果所有搜索任务都失败，返回错误
        if (successTasks === 0) {
            throw new Error('所有搜索任务都失败');
        }

        // 5. 第二阶段：并发获取所有链接
        this.debugPrint(`开始第二阶段：并发获取 ${allShareItems.length} 个链接`);

        const linkResults: LinkResult[] = [];
        const linkTasks = allShareItems.map(shareItem => {
            return this.fetchShareLink(client, shareItem.hsid, shareItem.platform)
                .then(({ shareURL, password }) => {
                    linkResults.push({
                        hsid: shareItem.hsid,
                        shareURL,
                        password,
                        err: null
                    });
                })
                .catch(err => {
                    linkResults.push({
                        hsid: shareItem.hsid,
                        shareURL: '',
                        password: '',
                        err
                    });
                });
        });

        // 等待所有链接获取任务完成
        await Promise.all(linkTasks);

        // 6. 建立hsid到链接的映射
        const hsidToLink: Record<string, LinkResult> = {};
        let linkSuccessCount = 0;
        let linkErrorCount = 0;

        for (const linkResult of linkResults) {
            if (linkResult.err) {
                linkErrorCount++;
                this.debugPrint(`获取链接失败 hsid=${linkResult.hsid}: ${linkResult.err}`);
                continue;
            }

            linkSuccessCount++;
            hsidToLink[linkResult.hsid] = linkResult;
        }

        this.debugPrint(`链接获取阶段完成: 成功${linkSuccessCount}个, 失败${linkErrorCount}个`);

        // 7. 组合搜索结果和链接信息
        const results: SearchResult[] = [];
        let processedCount = 0;
        let skippedCount = 0;

        for (const shareItem of allShareItems) {
            const linkResult = hsidToLink[shareItem.hsid];
            if (!linkResult) {
                skippedCount++;
                continue;
            }

            // 清理HTML标签获取纯文本标题
            const title = this.cleanHTMLTags(shareItem.share_name);
            const cleanTitle = title || '未知资源';

            // 创建链接对象
            const link: Link = {
                Type: this.mapPlatformType(shareItem.platform),
                URL: linkResult.shareURL,
                Password: linkResult.password
            };

            // 构建搜索结果
            const result: SearchResult = {
                UniqueID: `haisou-${shareItem.hsid}`,
                Title: cleanTitle,
                Content: `文件数量: ${shareItem.stat_file} | 网盘类型: ${shareItem.platform} | 大小: ${this.formatSize(shareItem.stat_size)}`,
                Links: [link],
                Tags: [shareItem.platform],
                Channel: '',
                Datetime: new Date()
            };

            results.push(result);
            processedCount++;
        }

        this.debugPrint(`结果组合完成: 处理${allShareItems.length}项 -> 有效${processedCount}项 -> 跳过${skippedCount}项`);

        // 8. 关键词过滤
        const beforeFilterCount = results.length;
        const filteredResults = this.filterResultsByKeyword(results, keyword);

        this.debugPrint(`关键词过滤: 过滤前${beforeFilterCount}项 -> 过滤后${filteredResults.length}项`);

        return filteredResults;
    }

    // 获取指定网盘类型的单页搜索结果
    private async fetchSearchPage(client: AxiosInstance, keyword: string, pageNo: number, panType: string): Promise<ShareItem[]> {
        const encodedKeyword = encodeURIComponent(keyword);
        const searchURL = `https://haisou.cc/api/pan/share/search?query=${encodedKeyword}&scope=title&pan=${panType}&page=${pageNo}&filter_valid=true&filter_has_files=false`;

        this.debugPrint(`请求${panType}网盘第${pageNo}页: ${searchURL}`);

        try {
            const response = await this.doRequestWithRetry(client, {
                url: searchURL,
                method: 'GET',
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                    'Accept': 'application/json, text/plain, */*',
                    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
                    'Connection': 'keep-alive',
                    'Referer': 'https://haisou.cc/'
                },
                timeout: 30000
            });

            if (response.status !== 200) {
                throw new Error(`${panType}网盘第${pageNo}页返回状态码: ${response.status}`);
            }

            const apiResp: SearchAPIResponse = response.data;

            if (apiResp.code !== 0) {
                throw new Error(`${panType}网盘第${pageNo}页API错误: ${apiResp.msg}`);
            }

            this.debugPrint(`${panType}网盘第${pageNo}页获取到 ${apiResp.data.list.length} 个搜索结果`);

            return apiResp.data.list;
        } catch (error) {
            throw new Error(`${panType}网盘第${pageNo}页搜索失败: ${error}`);
        }
    }

    // 通过hsid获取具体的分享链接
    private async fetchShareLink(client: AxiosInstance, hsid: string, platform: string): Promise<{ shareURL: string; password: string }> {
        const fetchURL = `https://haisou.cc/api/pan/share/${hsid}/fetch`;

        this.debugPrint(`获取链接 hsid=${hsid} platform=${platform}: ${fetchURL}`);

        try {
            const response = await this.doRequestWithRetry(client, {
                url: fetchURL,
                method: 'GET',
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                    'Accept': 'application/json, text/plain, */*',
                    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
                    'Connection': 'keep-alive',
                    'Referer': 'https://haisou.cc/'
                },
                timeout: 15000
            });

            if (response.status !== 200) {
                throw new Error(`hsid=${hsid}链接请求返回状态码: ${response.status}`);
            }

            const apiResp: FetchAPIResponse = response.data;

            if (apiResp.code !== 0) {
                throw new Error(`hsid=${hsid}链接API错误: ${apiResp.msg}`);
            }

            // 根据平台类型构建完整的分享链接
            const shareURL = this.buildShareURL(platform, apiResp.data.share_code);
            if (!shareURL) {
                throw new Error(`hsid=${hsid}不支持的网盘平台: ${platform}`);
            }

            // 获取密码
            const password = apiResp.data.share_pwd || '';

            this.debugPrint(`hsid=${hsid}成功获取链接: ${shareURL} password=${password}`);

            return { shareURL, password };
        } catch (error) {
            throw new Error(`hsid=${hsid}链接获取失败: ${error}`);
        }
    }

    // 带重试机制的HTTP请求
    private async doRequestWithRetry(client: AxiosInstance, config: AxiosRequestConfig, maxRetries: number = 3): Promise<any> {
        let lastErr: Error;

        for (let i = 0; i < maxRetries; i++) {
            if (i > 0) {
                // 指数退避重试
                const backoff = Math.pow(2, i - 1) * 200;
                await this.sleep(backoff);
            }

            try {
                const response = await client(config);
                if (response.status === 200) {
                    return response;
                }
            } catch (error) {
                lastErr = error as Error;
            }
        }

        throw new Error(`重试 ${maxRetries} 次后仍然失败: ${lastErr?.message}`);
    }

    // 构建分享链接
    private buildShareURL(platform: string, shareCode: string): string {
        switch (platform.toLowerCase()) {
            case 'ali':
                return `https://www.alipan.com/s/${shareCode}`;
            case 'baidu':
                return `https://pan.baidu.com/s/${shareCode}`;
            case 'quark':
                return `https://pan.quark.cn/s/${shareCode}`;
            case 'xunlei':
                return `https://pan.xunlei.com/s/${shareCode}`;
            case 'tianyi':
                return `https://cloud.189.cn/t/${shareCode}`;
            default:
                return '';
        }
    }

    // 映射网盘平台类型
    private mapPlatformType(platform: string): string {
        switch (platform.toLowerCase()) {
            case 'ali':
                return 'aliyun';
            case 'baidu':
                return 'baidu';
            case 'quark':
                return 'quark';
            case 'xunlei':
                return 'xunlei';
            case 'tianyi':
                return 'tianyi';
            default:
                return 'others';
        }
    }

    // 清理HTML标签
    private cleanHTMLTags(text: string): string {
        // 移除高亮标签
        let cleaned = text.replace(/<span[^>]*class="highlight"[^>]*>(.*?)<\/span>/g, '$1');
        // 移除其他HTML标签
        cleaned = cleaned.replace(/<[^>]*>/g, '');
        return cleaned.trim();
    }

    // 格式化文件大小
    private formatSize(size: number): string {
        const units = ['B', 'KB', 'MB', 'GB', 'TB'];
        let currentSize = size;
        let unitIndex = 0;

        while (currentSize >= 1024 && unitIndex < units.length - 1) {
            currentSize /= 1024;
            unitIndex++;
        }

        return `${currentSize.toFixed(2)} ${units[unitIndex]}`;
    }

    // 关键词过滤
    private filterResultsByKeyword(results: SearchResult[], keyword: string): SearchResult[] {
        if (!keyword) return results;

        const lowerKeyword = keyword.toLowerCase();
        return results.filter(result => {
            return result.Title.toLowerCase().includes(lowerKeyword) ||
                   result.Content.toLowerCase().includes(lowerKeyword);
        });
    }

    // 休眠函数
    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    // 调试日志
    private debugPrint(message: string): void {
        if (DebugLog) {
            console.log(`[Haisou] ${message}`);
        }
    }
}

// 注册插件
const plugin = new HaisouPlugin();
plugin.register();
