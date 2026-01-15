import { SearchResult } from './response';

// PluginSearchResult 插件搜索结果
export class PluginSearchResult {
  results: SearchResult[];
  isFinal: boolean;
  timestamp: Date;
  source: string;
  message?: string;

  constructor(partial: Partial<PluginSearchResult>) {
    this.results = partial.results || [];
    this.isFinal = partial.isFinal || false;
    this.timestamp = partial.timestamp || new Date();
    this.source = partial.source || '';
    this.message = partial.message;
  }

  // IsEmpty 检查结果是否为空
  IsEmpty(): boolean {
    return this.results.length === 0;
  }

  // Count 返回结果数量
  Count(): number {
    return this.results.length;
  }

  // GetResults 获取搜索结果列表
  GetResults(): SearchResult[] {
    if (!this.results) {
      return [];
    }
    return this.results;
  }
}
