export interface FilterConfig {
  include?: string[]; // 包含关键词列表（OR关系）
  exclude?: string[]; // 排除关键词列表（AND关系）
}

export interface SearchRequest {
  keyword: string; // 搜索关键词
  channels?: string[]; // 搜索的频道列表
  concurrency?: number; // 并发搜索数量
  forceRefresh?: boolean; // 强制刷新，不使用缓存
  resultType?: string; // 结果类型：all(返回所有结果)、results(仅返回results)、merge(仅返回merged_by_type)
  sourceType?: string; // 数据来源类型：all(默认，全部来源)、tg(仅Telegram)、plugin(仅插件)
  plugins?: string[]; // 指定搜索的插件列表，不指定则搜索全部插件
  ext?: Record<string, any>; // 扩展参数，用于传递给插件的自定义参数
  cloudTypes?: string[]; // 指定返回的网盘类型列表，不指定则返回所有类型
  filter?: FilterConfig; // 过滤配置，用于过滤返回结果
}
