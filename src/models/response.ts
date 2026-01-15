// Link 网盘链接
export interface Link {
  type: string;
  url: string;
  password: string;
  datetime?: string; // 链接更新时间（可选）
  workTitle?: string; // 作品标题（用于区分同一消息中多个作品的链接）
}

// SearchResult 搜索结果
export interface SearchResult {
  messageId: string;
  uniqueId: string; // 全局唯一ID
  channel: string;
  datetime: string;
  title: string;
  content: string;
  links: Link[];
  tags?: string[];
  images?: string[]; // TG消息中的图片链接
}

// MergedLink 合并后的网盘链接
export interface MergedLink {
  url: string;
  password: string;
  note: string;
  datetime: string;
  source?: string; // 数据来源：tg:频道名 或 plugin:插件名
  images?: string[]; // TG消息中的图片链接
}

// MergedLinks 按网盘类型分组的合并链接
export type MergedLinks = Record<string, MergedLink[]>;

// SearchResponse 搜索响应
export interface SearchResponse {
  total: number;
  results?: SearchResult[];
  mergedByType?: MergedLinks;
}

// Response API通用响应
export interface Response {
  code: number;
  message: string;
  data?: any;
}

// NewSuccessResponse 创建成功响应
export function NewSuccessResponse(data: any): Response {
  return {
    code: 0,
    message: "success",
    data,
  };
}

// NewErrorResponse 创建错误响应
export function NewErrorResponse(code: number, message: string): Response {
  return {
    code,
    message,
  };
}
