import { BaseAsyncPlugin, registerGlobalPlugin } from '../plugin.manager';
import { SearchResult, Link } from '../../models/response';
import axios, { AxiosInstance, AxiosResponse } from 'axios';
import * as crypto from 'crypto';

// 调试日志开关
const DebugLog = false;
// 默认每种网盘类型获取页数
const DefaultPagesPerType = 2;
// 最大允许每种网盘类型页数（防止过度请求）
const MaxAllowedPagesPerType = 5;
// AES解密配置
const AESKey = "4OToScUFOaeVTrHE";
const AESIV = "9CLGao1vHKqm17Oz";

// 支持的网盘类型列表
const SupportedCloudTypes = ["baidu", "quark", "xunlei", "ali"];

// APIResponse SDSO API响应结构
interface APIResponse {
  code: number;
  msg: string;
  data: {
    total: number;
    list: DataItem[];
  };
}

// DataItem 搜索结果项
interface DataItem {
  id: string;
  name: string;
  url: string;          // 加密的网盘链接
  type: string;
  from: string;         // 网盘类型: quark/xunlei/aliyun/baidu
  content: string | null;
  gmtCreate: string;
  gmtShare: string;
  fileCount: number;
  creatorId: string | null;
  creatorName: string;
  fileInfos: FileInfo[];
}

// FileInfo 文件信息
interface FileInfo {
  category: string | null;
  fileExtension: string | null;
  fileId: string;
  fileName: string;
  type: string | null;
}

// PageResult 页面搜索结果
interface PageResult {
  pageNo: number;
  fromType: string;
  results: SearchResult[];
  err: Error | null;
}

// SDSOPlugin SDSO搜索插件
class SDSOPlugin extends BaseAsyncPlugin {
  private optimizedClient: AxiosInstance;

  constructor() {
    super("sdso", 3); // 普通质量插件，优先级3
    this.optimizedClient = this.createOptimizedHTTPClient();
  }

  // 创建优化的HTTP客户端
  private createOptimizedHTTPClient(): AxiosInstance {
    return axios.create({
      timeout: 30000, // 30秒超时
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Connection': 'keep-alive',
        'Referer': 'https://sdso.top/',
      },
    });
  }

  // 插件名称
  name(): string {
    return "sdso";
  }

  // 插件显示名称
  displayName(): string {
    return "SDSO搜索";
  }

  // 插件描述
  description(): string {
    return "SDSO - 多网盘资源搜索";
  }

  // 搜索实现
  private async searchImpl(client: AxiosInstance, keyword: string, ext: Record<string, any>): Promise<SearchResult[]> {
    if (DebugLog) {
      console.log(`[SDSO] 开始搜索，关键词: ${keyword}`);
    }

    // 从扩展参数中获取每种网盘类型的页数配置
    let pagesPerType = DefaultPagesPerType;
    if (ext) {
      if (typeof ext["pages_per_type"] === "number" && ext["pages_per_type"] > 0) {
        pagesPerType = Math.min(ext["pages_per_type"], MaxAllowedPagesPerType);
        if (DebugLog && ext["pages_per_type"] > MaxAllowedPagesPerType) {
          console.log(`[SDSO] 每种网盘类型页数限制在最大值: ${MaxAllowedPagesPerType}`);
        }
      } else if (typeof ext["pages_per_type"] === "string") {
        const parsed = parseInt(ext["pages_per_type"]);
        if (!isNaN(parsed) && parsed > 0) {
          pagesPerType = Math.min(parsed, MaxAllowedPagesPerType);
        }
      }
      // 保持向后兼容：如果设置了 pages 参数，则平均分配给各网盘类型
      if (typeof ext["pages"] === "number" && ext["pages"] > 0) {
        pagesPerType = Math.max(1, Math.min(ext["pages"] / SupportedCloudTypes.length, MaxAllowedPagesPerType));
      } else if (typeof ext["pages"] === "string") {
        const parsed = parseInt(ext["pages"]);
        if (!isNaN(parsed) && parsed > 0) {
          pagesPerType = Math.max(1, Math.min(parsed / SupportedCloudTypes.length, MaxAllowedPagesPerType));
        }
      }
    }

    const totalTasks = SupportedCloudTypes.length * pagesPerType;
    if (DebugLog) {
      console.log(`[SDSO] 将分别搜索 ${SupportedCloudTypes.length} 种网盘类型，每种 ${pagesPerType} 页，总计 ${totalTasks} 个并发任务`);
    }

    // 并发请求多个网盘类型的多页数据
    const resultsChan: PageResult[] = [];
    const tasks: Promise<void>[] = [];

    // 创建信号量控制并发
    const semaphore = this.createSemaphore(totalTasks);

    // 启动并发任务：遍历网盘类型和页数
    for (const cloudType of SupportedCloudTypes) {
      for (let pageNo = 1; pageNo <= pagesPerType; pageNo++) {
        tasks.push((async () => {
          await semaphore.acquire();
          try {
            const results = await this.fetchSinglePageWithType(keyword, pageNo, cloudType);
            resultsChan.push({
              pageNo,
              fromType: cloudType,
              results,
              err: null,
            });
          } catch (error) {
            resultsChan.push({
              pageNo,
              fromType: cloudType,
              results: [],
              err: error as Error,
            });
          } finally {
            semaphore.release();
          }
        })());
      }
    }

    // 等待所有任务完成
    await Promise.all(tasks);

    // 收集所有页面结果
    let allResults: SearchResult[] = [];
    let successTasks = 0;
    let errorTasks = 0;
    const resultsByType: Record<string, number> = {};

    for (const pageResult of resultsChan) {
      if (pageResult.err) {
        errorTasks++;
        if (DebugLog) {
          console.log(`[SDSO] ${pageResult.fromType}网盘第${pageResult.pageNo}页请求失败: ${pageResult.err}`);
        }
        continue;
      }

      successTasks++;
      allResults = [...allResults, ...pageResult.results];
      resultsByType[pageResult.fromType] = (resultsByType[pageResult.fromType] || 0) + pageResult.results.length;
      if (DebugLog) {
        console.log(`[SDSO] ${pageResult.fromType}网盘第${pageResult.pageNo}页成功获取 ${pageResult.results.length} 个结果`);
      }
    }

    if (DebugLog) {
      console.log(`[SDSO] 分类搜索完成: 成功${successTasks}任务, 失败${errorTasks}任务, 总结果${allResults.length}个`);
      for (const [cloudType, count] of Object.entries(resultsByType)) {
        console.log(`[SDSO]   - ${cloudType}网盘: ${count}个结果`);
      }
    }

    // 如果所有任务都失败，返回错误
    if (successTasks === 0) {
      throw new Error(`[${this.name()}] 所有搜索任务都失败`);
    }

    // 关键词过滤
    const beforeFilterCount = allResults.length;
    const filteredResults = this.filterResultsByKeyword(allResults, keyword);

    if (DebugLog) {
      console.log(`[SDSO] 关键词过滤: 过滤前${beforeFilterCount}项 -> 过滤后${filteredResults.length}项`);
    }

    return filteredResults;
  }

  // 创建信号量
  private createSemaphore(maxConcurrency: number) {
    let available = maxConcurrency;
    const waiting: (() => void)[] = [];

    return {
      acquire: async (): Promise<void> => {
        return new Promise((resolve) => {
          if (available > 0) {
            available--;
            resolve();
          } else {
            waiting.push(resolve);
          }
        });
      },
      release: (): void => {
        available++;
        if (waiting.length > 0) {
          const resolve = waiting.shift()!;
          available--;
          resolve();
        }
      },
    };
  }

  // 获取指定网盘类型的单页数据
  private async fetchSinglePageWithType(keyword: string, pageNo: number, fromType: string): Promise<SearchResult[]> {
    // 构建搜索URL，添加from参数指定网盘类型
    const searchURL = `https://sdso.top/api/sd/search?name=${encodeURIComponent(keyword)}&pageNo=${pageNo}&from=${fromType}`;
    if (DebugLog) {
      console.log(`[SDSO] 请求${fromType}网盘第${pageNo}页: ${searchURL}`);
    }

    try {
      const response = await this.doRequestWithRetry(searchURL);

      if (response.status !== 200) {
        throw new Error(`HTTP status: ${response.status}`);
      }

      // 解析响应
      const apiResp: APIResponse = response.data;

      // 检查API响应状态
      if (apiResp.code !== 200) {
        throw new Error(`API错误: ${apiResp.msg}`);
      }

      if (DebugLog) {
        console.log(`[SDSO] ${fromType}网盘第${pageNo}页获取到 ${apiResp.data.list.length} 个原始结果`);
      }

      // 转换为标准格式
      const results: SearchResult[] = [];
      let processedCount = 0;
      let skippedCount = 0;

      for (let i = 0; i < apiResp.data.list.length; i++) {
        const item = apiResp.data.list[i];
        
        try {
          // 解密网盘链接
          const decryptedURL = await this.decryptURL(item.url);

          // 验证是否为有效的网盘链接
          if (!this.isValidPanURL(decryptedURL)) {
            if (DebugLog) {
              console.log(`[SDSO] ${fromType}网盘第${pageNo}页第${i + 1}项无效链接: ${decryptedURL}`);
            }
            skippedCount++;
            continue;
          }

          // 映射网盘类型
          const panType = this.mapPanType(item.from);
          if (panType === "others") {
            skippedCount++;
            continue;
          }

          // 创建链接对象
          const link: Link = {
            type: panType,
            url: decryptedURL,
            password: "", // SDSO返回的链接通常不包含密码
            text: "",
            workTitle: "",
          };

          // 解析时间
          let datetime: Date;
          try {
            datetime = new Date(item.gmtShare.replace(' ', 'T'));
          } catch (error) {
            datetime = new Date(); // 如果解析失败，使用当前时间
          }

          // 清理标题中的HTML标签
          const title = this.cleanHTMLTags(item.name);

          // 构建搜索结果，UniqueID包含网盘类型和页码避免重复
          const result: SearchResult = {
            uniqueId: `${this.name()}-${item.id}-${fromType}-${pageNo}`,
            messageId: `${this.name()}-${item.id}-${fromType}-${pageNo}`,
            title,
            content: `分享者: ${item.creatorName} | 文件数量: ${item.fileCount} | 网盘类型: ${fromType}`,
            links: [link],
            tags: [item.from, item.type],
            channel: "",
            datetime: datetime.toISOString(),
          };

          results.push(result);
          processedCount++;
        } catch (error) {
          if (DebugLog) {
            console.log(`[SDSO] ${fromType}网盘第${pageNo}页第${i + 1}项处理失败: ${error}`);
          }
          skippedCount++;
        }
      }

      if (DebugLog) {
        console.log(`[SDSO] ${fromType}网盘第${pageNo}页处理完成: 原始${apiResp.data.list.length}项 -> 有效${processedCount}项 -> 跳过${skippedCount}项`);
      }

      return results;
    } catch (error) {
      if (DebugLog) {
        console.log(`[SDSO] ${fromType}网盘第${pageNo}页请求失败: ${error}`);
      }
      throw error;
    }
  }

  // 带重试机制的HTTP请求
  private async doRequestWithRetry(url: string): Promise<AxiosResponse> {
    const maxRetries = 3;
    let lastErr: Error | null = null;

    for (let i = 0; i < maxRetries; i++) {
      if (i > 0) {
        // 指数退避重试
        const backoff = 200 * Math.pow(2, i - 1);
        await new Promise(resolve => setTimeout(resolve, backoff));
      }

      try {
        const response = await this.optimizedClient.get(url);
        if (response.status === 200) {
          return response;
        }
        lastErr = new Error(`HTTP status: ${response.status}`);
      } catch (error) {
        lastErr = error as Error;
      }
    }

    throw new Error(`重试 ${maxRetries} 次后仍然失败: ${lastErr?.message || '未知错误'}`);
  }

  // 解密SDSO网站返回的加密URL
  private async decryptURL(encryptedURL: string): Promise<string> {
    if (!encryptedURL) {
      throw new Error("加密URL不能为空");
    }

    // Base64解码
    const ciphertext = Buffer.from(encryptedURL, 'base64');

    // 检查密文长度
    if (ciphertext.length === 0) {
      throw new Error("密文长度为0");
    }

    // 检查密文长度是否为16的倍数
    if (ciphertext.length % 16 !== 0) {
      throw new Error("密文长度不是AES块大小的倍数");
    }

    // 创建AES-CBC解密器
    const decipher = crypto.createDecipheriv('aes-128-cbc', AESKey, AESIV);
    decipher.setAutoPadding(false);

    // 解密
    let plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

    // 去除PKCS7填充
    plaintext = this.removePKCS7Padding(plaintext);

    return plaintext.toString('utf8');
  }

  // 去除PKCS7填充
  private removePKCS7Padding(data: Buffer): Buffer {
    if (data.length === 0) {
      throw new Error("数据为空");
    }

    // 获取填充长度
    const paddingLen = data[data.length - 1];

    // 验证填充长度
    if (paddingLen === 0 || paddingLen > data.length || paddingLen > 16) {
      throw new Error(`无效的填充长度: ${paddingLen}`);
    }

    // 验证填充字节
    for (let i = data.length - paddingLen; i < data.length; i++) {
      if (data[i] !== paddingLen) {
        throw new Error("无效的填充字节");
      }
    }

    // 返回去除填充后的数据
    return data.subarray(0, data.length - paddingLen);
  }

  // 清理HTML标签
  private cleanHTMLTags(text: string): string {
    // 移除高亮标签 <span style="color: red;">...</span>
    text = text.replace(/<span[^>]*>(.*?)<\/span>/g, "$1");
    
    // 移除其他可能的HTML标签
    text = text.replace(/<[^>]*>/g, "");
    
    return text.trim();
  }

  // 映射网盘类型
  private mapPanType(from: string): string {
    const lowerFrom = from.toLowerCase();
    switch (lowerFrom) {
      case "quark":
        return "quark";
      case "xunlei":
        return "xunlei";
      case "aliyun":
      case "ali":
        return "aliyun";  // PanSou内部仍使用aliyun标识
      case "baidu":
        return "baidu";
      default:
        return "others";
    }
  }

  // 验证是否为有效的网盘链接
  private isValidPanURL(url: string): boolean {
    if (!url) {
      return false;
    }
    
    // 检查是否包含网盘域名特征
    const validDomains = [
      "pan.quark.cn",
      "pan.xunlei.com",
      "aliyundrive.com",
      "alipan.com",
      "pan.baidu.com",
    ];
    
    const urlLower = url.toLowerCase();
    for (const domain of validDomains) {
      if (urlLower.includes(domain)) {
        return true;
      }
    }
    
    return false;
  }

  // 根据关键词过滤结果
  private filterResultsByKeyword(results: SearchResult[], keyword: string): SearchResult[] {
    if (!keyword) {
      return results;
    }

    const lowerKeyword = keyword.toLowerCase();
    return results.filter(result => {
      return result.title.toLowerCase().includes(lowerKeyword) || 
             result.content.toLowerCase().includes(lowerKeyword) ||
             result.tags.some(tag => tag.toLowerCase().includes(lowerKeyword));
    });
  }
}

// 创建并注册插件
const sdsoPlugin = new SDSOPlugin();
registerGlobalPlugin(sdsoPlugin);

export type { SDSOPlugin };
export const SDSOPluginInstance = sdsoPlugin;