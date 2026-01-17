// 导入相关模型类型
import { Link, SearchResult, MergedLink } from '../../models/plugin-result';

// 对象池实现
class ObjectPool<T> {
  private pool: T[] = [];
  private factory: () => T;

  constructor(factory: () => T) {
    this.factory = factory;
  }

  get(): T {
    if (this.pool.length > 0) {
      return this.pool.pop()!;
    }
    return this.factory();
  }

  put(obj: T): void {
    this.pool.push(obj);
  }
}

// 初始化对象池
const linkPool = new ObjectPool<Link>(() => ({
  type: '',
  url: '',
  password: '',
  datetime: '',
  workTitle: '',
}));

const searchResultPool = new ObjectPool<SearchResult>(() => ({
  messageId: '',
  uniqueId: '',
  channel: '',
  datetime: '',
  title: '',
  content: '',
  links: [],
  tags: [],
  images: [],
}));

const mergedLinkPool = new ObjectPool<MergedLink>(() => ({
  url: '',
  password: '',
  note: '',
  datetime: '',
  source: '',
  images: [],
}));

// 从对象池获取Link对象
export function getLink(): Link {
  return linkPool.get();
}

// 释放Link对象回对象池
export function releaseLink(l: Link): void {
  l.type = '';
  l.url = '';
  l.password = '';
  l.workTitle = '';
  l.datetime = '';
  linkPool.put(l);
}

// 从对象池获取SearchResult对象
export function getSearchResult(): SearchResult {
  return searchResultPool.get();
}

// 释放SearchResult对象回对象池
export function releaseSearchResult(sr: SearchResult): void {
  sr.messageId = '';
  sr.uniqueId = '';
  sr.channel = '';
  sr.title = '';
  sr.content = '';
  sr.links = [];
  sr.tags = [];
  sr.images = [];
  sr.datetime = '';
  searchResultPool.put(sr);
}

// 从对象池获取MergedLink对象
export function getMergedLink(): MergedLink {
  return mergedLinkPool.get();
}

// 释放MergedLink对象回对象池
export function releaseMergedLink(ml: MergedLink): void {
  ml.url = '';
  ml.password = '';
  ml.note = '';
  ml.source = '';
  ml.images = [];
  // 不重置时间，因为会被重新赋值
  mergedLinkPool.put(ml);
}