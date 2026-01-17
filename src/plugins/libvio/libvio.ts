import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios';
import { BaseAsyncPlugin, registerGlobalPlugin } from '../plugin.manager';
import { SearchResult, Link } from '../../models/plugin-result';
import * as cheerio from 'cheerio';
import * as url from 'url';

// 信号量类，用于控制并发
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

// 常量定义
const BaseURL = "https://www.libvio.mov";
const SearchPath = "/search/-------------.html";
const UserAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36";
const MaxConcurrency = 20; // 详情页最大并发数
const MaxPages = 1; // 最大搜索页数

// 播放链接信息
interface PlayLinkInfo {
    URL: string;
    PanType: string; // 网盘类型（从标题提取）
}

export class LibvioPlugin extends BaseAsyncPlugin {
    private debugMode: boolean;
    private detailCache: Map<string, Link[]>;
    private playCache: Map<string, Link>;
    private cacheTTL: number;

    constructor() {
        super("libvio", 1, true); // 优先级1，跳过服务过滤
        this.debugMode = false;
        this.detailCache = new Map();
        this.playCache = new Map();
        this.cacheTTL = 30 * 60 * 1000; // 30分钟
    }

    Name(): string {
        return "libvio";
    }

    DisplayName(): string {
        return "LIBVIO";
    }

    Description(): string {
        return "LIBVIO - 影视资源网盘下载";
    }

    // 设置请求头
    private setRequestHeaders(config: AxiosRequestConfig, referer: string): void {
        config.headers = {
            "User-Agent": UserAgent,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
            "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
            "Accept-Encoding": "gzip, deflate",
            "Cache-Control": "no-cache",
            "Pragma": "no-cache",
            ...(referer ? { "Referer": referer } : {})
        };
    }

    // 发送HTTP请求
    private async doRequest(client: AxiosInstance, url: string, referer: string): Promise<AxiosResponse> {
        if (this.debugMode) {
            console.log(`[Libvio] 发送请求: ${url}`);
        }

        const config: AxiosRequestConfig = {
            method: 'GET',
            url: url
        };

        this.setRequestHeaders(config, referer);

        try {
            const resp = await client(config);
            
            if (this.debugMode) {
                console.log(`[Libvio] 响应状态: ${resp.status}`);
            }

            return resp;
        } catch (error) {
            if (this.debugMode) {
                console.log(`[Libvio] 请求失败: ${error}`);
            }
            throw error;
        }
    }

    // 实际的搜索实现
    protected async searchImpl(client: AxiosInstance, keyword: string, ext: Record<string, any>): Promise<SearchResult[]> {
        const searchURL = `${BaseURL}${SearchPath}?wd=${encodeURIComponent(keyword)}&submit=`;
        
        if (this.debugMode) {
            console.log(`[Libvio] 开始搜索: ${keyword}`);
            console.log(`[Libvio] 搜索URL: ${searchURL}`);
        }
        
        // 发送搜索请求
        const resp = await this.doRequest(client, searchURL, BaseURL);
        
        if (resp.status !== 200) {
            throw new Error(`搜索响应状态码异常: ${resp.status}`);
        }
        
        // 解析HTML
        const $ = cheerio.load(resp.data);
        
        // 提取搜索结果
        const results = this.extractSearchResults($, keyword);
        
        if (this.debugMode) {
            console.log(`[Libvio] 找到 ${results.length} 个搜索结果`);
        }
        
        // 并发获取详情页的下载链接
        const enrichedResults = await this.enrichWithDetailLinks(client, results, keyword);
        
        if (this.debugMode) {
            // 统计链接数量
            let totalLinks = 0;
            for (let i = 0; i < enrichedResults.length; i++) {
                const r = enrichedResults[i];
                console.log(`[Libvio] 结果 ${i + 1}: ${r.Title}, 链接数: ${r.Links.length}`);
                totalLinks += r.Links.length;
            }
            console.log(`[Libvio] 总计: ${enrichedResults.length} 个结果，${totalLinks} 个链接`);
        }
        
        return enrichedResults;
    }

    // 从HTML中提取搜索结果
    private extractSearchResults($: cheerio.Root, keyword: string): SearchResult[] {
        const results: SearchResult[] = [];
        
        // 选择所有搜索结果项
        $('ul.stui-vodlist li').each((i, elem) => {
            const s = $(elem);
            
            // 提取标题和详情页链接
            const titleElem = s.find('.stui-vodlist__detail h4 a');
            let title = titleElem.text().trim();
            if (title === '') {
                title = titleElem.attr('title') || '';
            }
            
            let detailPath = titleElem.attr('href') || '';
            if (detailPath === '') {
                // 尝试从缩略图链接获取
                const thumbLink = s.find('a.stui-vodlist__thumb');
                detailPath = thumbLink.attr('href') || '';
            }
            
            if (title === '' || detailPath === '') {
                return;
            }
            
            // 构建完整的详情页URL
            const detailURL = `${BaseURL}${detailPath}`;
            
            // 提取其他信息
            const episodeInfo = s.find('.pic-text').text().trim();
            const rating = s.find('.pic-tag').text().trim();
            
            // 从详情页路径提取ID（如：/detail/4095.html -> 4095）
            const idMatch = /\/detail\/(\d+)\.html/.exec(detailPath);
            let resourceID = '';
            if (idMatch && idMatch.length > 1) {
                resourceID = idMatch[1];
            } else {
                resourceID = Date.now().toString();
            }
            
            if (this.debugMode) {
                console.log(`[Libvio] 提取结果 ${i + 1}: ${title}, URL: ${detailURL}`);
            }
            
            // 构建内容描述
            let content = '';
            if (episodeInfo !== '') {
                content = episodeInfo;
            }
            if (rating !== '') {
                if (content !== '') {
                    content += ' | ';
                }
                content += '评分: ' + rating;
            }
            
            const result: SearchResult = {
                Title: title,
                Content: content,
                Channel: '',
                MessageID: `${this.Name()}-${resourceID}`,
                UniqueID: `${this.Name()}-${resourceID}`,
                Datetime: new Date(),
                Links: [] // 稍后填充
            };
            
            // 将详情页URL存储在Tags中供后续使用
            result.Tags = [detailURL];
            
            results.push(result);
        });
        
        return results;
    }

    // 并发获取详情页的下载链接
    private async enrichWithDetailLinks(client: AxiosInstance, results: SearchResult[], keyword: string): Promise<SearchResult[]> {
        if (results.length === 0) {
            return results;
        }
        
        if (this.debugMode) {
            console.log(`[Libvio] 开始获取 ${results.length} 个详情页的下载链接`);
        }
        
        const semaphore = new Semaphore(MaxConcurrency);
        const promises: Promise<void>[] = [];
        
        for (let i = 0; i < results.length; i++) {
            promises.push((async (idx) => {
                await semaphore.acquire();
                try {
                    // 添加小延迟避免请求过快
                    await new Promise(resolve => setTimeout(resolve, idx * 50));
                    
                    // 从Tags中获取详情页URL
                    if (results[idx].Tags && results[idx].Tags.length > 0) {
                        const detailURL = results[idx].Tags[0];
                        const links = await this.fetchDetailPageLinks(client, detailURL, keyword);
                        
                        results[idx].Links = links;
                        // 清空Tags，避免返回给用户
                        results[idx].Tags = [];
                        
                        if (this.debugMode) {
                            console.log(`[Libvio] 详情页 ${idx + 1}/${results.length} 获取到 ${links.length} 个链接`);
                        }
                    }
                } catch (error) {
                    if (this.debugMode) {
                        console.log(`[Libvio] 获取详情页链接失败: ${error}`);
                    }
                } finally {
                    semaphore.release();
                }
            })(i));
        }
        
        await Promise.all(promises);
        
        return results;
    }

    // 获取详情页的下载链接
    private async fetchDetailPageLinks(client: AxiosInstance, detailURL: string, keyword: string): Promise<Link[]> {
        if (this.debugMode) {
            console.log(`[Libvio] 开始获取详情页: ${detailURL}`);
        }
        
        // 检查缓存
        if (this.detailCache.has(detailURL)) {
            const links = this.detailCache.get(detailURL)!;
            if (this.debugMode) {
                console.log(`[Libvio] 使用缓存的详情页结果: ${detailURL}, 链接数: ${links.length}`);
            }
            return links;
        }
        
        try {
            // 访问详情页
            const resp = await this.doRequest(client, detailURL, BaseURL);
            
            if (resp.status !== 200) {
                if (this.debugMode) {
                    console.log(`[Libvio] 详情页响应状态码异常: ${detailURL}, 状态码: ${resp.status}`);
                }
                return [];
            }
            
            // 解析HTML
            const $ = cheerio.load(resp.data);
            
            // 提取下载播放页链接（只提取包含"下载"的）
            const playLinks = this.extractDownloadPlayLinks($);
            
            if (this.debugMode) {
                console.log(`[Libvio] 找到 ${playLinks.length} 个下载播放页链接`);
            }
            
            if (playLinks.length === 0) {
                if (this.debugMode) {
                    console.log(`[Libvio] 未找到下载链接`);
                }
                return [];
            }
            
            // 获取网盘链接
            const links: Link[] = [];
            for (const playLink of playLinks) {
                if (this.debugMode) {
                    console.log(`[Libvio] 获取网盘链接: ${playLink.URL}`);
                }
                const panLink = await this.fetchPanLink(client, playLink.URL, detailURL);
                if (panLink) {
                    links.push(panLink);
                } else if (this.debugMode) {
                    console.log(`[Libvio] 未能获取网盘链接: ${playLink.URL}`);
                }
            }
            
            if (this.debugMode) {
                console.log(`[Libvio] 详情页 ${detailURL} 最终获取到 ${links.length} 个网盘链接`);
            }
            
            // 缓存结果
            this.detailCache.set(detailURL, links);
            
            // 设置缓存过期
            setTimeout(() => {
                this.detailCache.delete(detailURL);
            }, this.cacheTTL);
            
            return links;
        } catch (error) {
            if (this.debugMode) {
                console.log(`[Libvio] 获取详情页失败: ${detailURL}, 错误: ${error}`);
            }
            return [];
        }
    }

    // 提取下载播放页链接
    private extractDownloadPlayLinks($: cheerio.Root): PlayLinkInfo[] {
        const playLinks: PlayLinkInfo[] = [];
        
        // 查找所有播放源
        const allHeads = $('.stui-vodlist__head');
        if (this.debugMode) {
            console.log(`[Libvio] 找到 ${allHeads.length} 个播放源头部`);
        }
        
        allHeads.each((i, elem) => {
            const s = $(elem);
            
            // 获取标题
            const title = s.find('h3').text().trim();
            
            if (this.debugMode) {
                console.log(`[Libvio] 播放源 ${i + 1} 标题: ${title}`);
            }
            
            // 只处理包含"下载"的源
            if (!title.includes('下载')) {
                if (this.debugMode) {
                    console.log(`[Libvio] 跳过非下载源: ${title}`);
                }
                return;
            }
            
            // 提取网盘类型
            let panType = '';
            if (title.includes('夸克') || title.includes('quark')) {
                panType = 'quark';
            } else if (title.includes('UC') || title.includes('uc')) {
                panType = 'uc';
            } else if (title.includes('百度') || title.includes('baidu')) {
                panType = 'baidu';
            }
            
            // 提取播放页链接
            const playlistLinks = s.find('.stui-content__playlist li a');
            if (this.debugMode) {
                console.log(`[Libvio] 播放列表中有 ${playlistLinks.length} 个链接`);
            }
            
            // 通常只取第一个链接（合集）
            const firstLink = playlistLinks.first();
            if (firstLink.length > 0) {
                const href = firstLink.attr('href');
                if (href && href !== '') {
                    // 构建完整URL
                    const playURL = `${BaseURL}${href}`;
                    
                    playLinks.push({
                        URL: playURL,
                        PanType: panType
                    });
                    
                    if (this.debugMode) {
                        const linkText = firstLink.text().trim();
                        console.log(`[Libvio] 找到下载链接: ${playURL} (${panType}) [${linkText}]`);
                    }
                }
            }
        });
        
        return playLinks;
    }

    // 获取网盘链接
    private async fetchPanLink(client: AxiosInstance, playURL: string, referer: string): Promise<Link | null> {
        // 检查缓存
        if (this.playCache.has(playURL)) {
            const link = this.playCache.get(playURL)!;
            if (this.debugMode) {
                console.log(`[Libvio] 使用缓存的播放页结果: ${playURL}`);
            }
            return link;
        }
        
        try {
            // 访问播放页
            const resp = await this.doRequest(client, playURL, referer);
            
            if (resp.status !== 200) {
                if (this.debugMode) {
                    console.log(`[Libvio] 播放页响应状态码异常: ${resp.status}`);
                }
                return null;
            }
            
            // 提取player_aaaa对象
            const playerDataRegex = /var\s+player_aaaa\s*=\s*({[^}]+})/;
            const matches = playerDataRegex.exec(resp.data);
            
            if (!matches || matches.length < 2) {
                if (this.debugMode) {
                    console.log(`[Libvio] 未找到player_aaaa对象`);
                    // 输出部分body内容用于调试
                    const bodyStr = resp.data;
                    if (bodyStr.length > 500) {
                        console.log(`[Libvio] 页面内容前500字符: ${bodyStr.substring(0, 500)}`);
                    } else {
                        console.log(`[Libvio] 页面内容: ${bodyStr}`);
                    }
                }
                return null;
            }
            
            // 解析JSON
            let playerJSON = matches[1];
            if (this.debugMode) {
                console.log(`[Libvio] 找到player_aaaa: ${playerJSON}`);
            }
            
            // 处理转义字符
            playerJSON = playerJSON.replace(/\\\//g, '/');
            
            const playerData = JSON.parse(playerJSON);
            
            // 提取URL
            const panURL = playerData.url as string;
            if (!panURL || panURL === '') {
                if (this.debugMode) {
                    console.log(`[Libvio] player_aaaa中没有url字段`);
                }
                return null;
            }
            
            // 提取网盘类型
            const from = playerData.from as string || '';
            const linkType = this.mapPanType(from, panURL);
            
            const link: Link = {
                URL: panURL,
                Type: linkType
            };
            
            if (this.debugMode) {
                console.log(`[Libvio] 提取到网盘链接: ${panURL} (from=${from}, type=${linkType})`);
            }
            
            // 缓存结果
            this.playCache.set(playURL, link);
            
            // 设置缓存过期
            setTimeout(() => {
                this.playCache.delete(playURL);
            }, this.cacheTTL);
            
            return link;
        } catch (error) {
            if (this.debugMode) {
                console.log(`[Libvio] 获取网盘链接失败: ${error}`);
            }
            return null;
        }
    }

    // 映射网盘类型
    private mapPanType(from: string, url: string): string {
        // 首先根据from字段判断
        const fromLower = from.toLowerCase();
        switch (fromLower) {
            case "uc":
                return "uc";
            case "quark":
                return "quark";
            case "baidu":
                return "baidu";
            case "aliyun":
            case "alipan":
                return "aliyun";
            case "xunlei":
            case "thunder":
                return "xunlei";
            case "115":
                return "115";
            case "123":
            case "123pan":
                return "123";
        }
        
        // 如果from字段不明确，根据URL判断
        const urlLower = url.toLowerCase();
        if (urlLower.includes("drive.uc.cn")) {
            return "uc";
        } else if (urlLower.includes("pan.quark.cn")) {
            return "quark";
        } else if (urlLower.includes("pan.baidu.com")) {
            return "baidu";
        } else if (urlLower.includes("alipan.com") || urlLower.includes("aliyundrive.com")) {
            return "aliyun";
        } else if (urlLower.includes("pan.xunlei.com")) {
            return "xunlei";
        } else if (urlLower.includes("115.com")) {
            return "115";
        } else if (urlLower.includes("123pan.com") || urlLower.includes("123684.com")) {
            return "123";
        } else if (urlLower.includes("cloud.189.cn")) {
            return "tianyi";
        }
        
        // 默认返回others
        return "others";
    }
}

// 注册插件
registerGlobalPlugin(new LibvioPlugin());