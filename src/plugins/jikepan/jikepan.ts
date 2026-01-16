import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import { SearchResult, Link } from '../../types';
import { Plugin } from '../../types/plugin';

const JikepanAPIURL = 'https://api.jikepan.xyz/search';

interface JikepanLink {
  service: string;
  link: string;
  pwd?: string;
}

interface JikepanItem {
  name: string;
  links: JikepanLink[];
}

interface JikepanResponse {
  msg: string;
  list: JikepanItem[];
}

class JikepanPlugin implements Plugin {
  name(): string {
    return 'jikepan';
  }

  displayName(): string {
    return '即刻盘';
  }

  description(): string {
    return '即刻盘 - 网盘资源搜索';
  }

  async search(keyword: string, ext: Record<string, any>): Promise<SearchResult[]> {
    return this.doSearch(axios.create({ timeout: 30000 }), keyword, ext);
  }

  private async doSearch(client: AxiosInstance, keyword: string, ext: Record<string, any>): Promise<SearchResult[]> {
    // 构建请求
    const reqBody = {
      name: keyword,
      is_all: false
    };

    // 检查ext中是否包含自定义参数，如果有则使用它
    if (ext) {
      if (ext.is_all === true) {
        // 使用全量搜索，时间大约10秒
        reqBody.is_all = true;
      }
    }

    const config: AxiosRequestConfig = {
      method: 'POST',
      url: JikepanAPIURL,
      headers: {
        'Content-Type': 'application/json',
        'referer': 'https://jikepan.xyz/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      },
      data: reqBody
    };

    try {
      const resp = await client(config);

      // 检查响应状态
      if (resp.data.msg !== 'success') {
        throw new Error(`API returned error: ${resp.data.msg}`);
      }

      // 转换结果格式
      const results = this.convertResults(resp.data.list);

      return results;
    } catch (err: any) {
      throw new Error(`search failed: ${err.message}`);
    }
  }

  private convertResults(items: JikepanItem[]): SearchResult[] {
    const results: SearchResult[] = [];

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      // 跳过没有链接的结果
      if (item.links.length === 0) {
        continue;
      }

      // 创建链接列表
      const links: Link[] = [];
      for (const link of item.links) {
        let linkType = this.convertLinkType(link.service);

        // 特殊处理other类型，检查链接URL
        if (linkType === 'others' && link.link.toLowerCase().includes('drive.uc.cn')) {
          linkType = 'uc';
        }

        // 跳过未知类型的链接（linkType为空）
        if (!linkType) {
          continue;
        }

        // 创建链接
        links.push({
          url: link.link,
          type: linkType,
          password: link.pwd || ''
        });
      }

      // 创建唯一ID：插件名-索引
      const uniqueID = `jikepan-${i}`;

      // 创建搜索结果
      const result: SearchResult = {
        uniqueId: uniqueID,
        title: item.name,
        content: '',
        datetime: new Date(),
        links: links,
        channel: '',
        tags: [],
        images: [],
        pluginName: this.name(),
        displayName: this.displayName()
      };

      results.push(result);
    }

    return results;
  }

  private convertLinkType(service: string): string {
    service = service.toLowerCase();

    switch (service) {
      case 'baidu':
        return 'baidu';
      case 'aliyun':
        return 'aliyun';
      case 'xunlei':
        return 'xunlei';
      case 'quark':
        return 'quark';
      case '189cloud':
        return 'tianyi';
      case '115':
        return '115';
      case '123':
        return '123';
      case 'pikpak':
        return 'pikpak';
      case 'caiyun':
        return 'mobile';
      case 'ed2k':
        return 'ed2k';
      case 'magnet':
        return 'magnet';
      case 'unknown':
        // 对于未知类型，返回空字符串，以便在后续处理中跳过
        return '';
      default:
        return 'others';
    }
  }
}

// 导出插件实例
const plugin = new JikepanPlugin();
export default plugin;