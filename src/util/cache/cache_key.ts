// 导入必要的模块
import * as crypto from 'crypto';

// 预计算的哈希值映射
// 存储频道列表哈希
const channelHashCache: Map<string, string> = new Map<string, string>();
// 存储插件列表哈希
const pluginHashCache: Map<string, string> = new Map<string, string>();

// 预先计算的常用列表哈希值
const precomputedHashes: Map<string, string> = new Map<string, string>();

// 所有插件名称的哈希值
let allPluginsHash: string = '';
// 所有频道名称的哈希值
let allChannelsHash: string = '';

// 初始化预计算的哈希值
function initPrecomputedHashes(): void {
  // 预计算空列表的哈希值
  precomputedHashes.set('empty_channels', 'all');
  
  // 预计算所有插件的哈希值
  // 注意：这里需要根据实际的插件系统进行调整
  // 暂时使用一个默认值
  const allPluginNames: string[] = [];
  allPluginsHash = calculateListHash(allPluginNames);
  precomputedHashes.set('all_plugins', allPluginsHash);
  
  // 预计算所有频道的哈希值（这里假设有一个全局频道列表）
  // 注意：如果没有全局频道列表，可以使用一个默认值
  allChannelsHash = 'all';
  precomputedHashes.set('all_channels', allChannelsHash);
}

// 初始化
initPrecomputedHashes();

// GenerateTGCacheKey 为TG搜索生成缓存键
export function GenerateTGCacheKey(keyword: string, channels: string[]): string {
  // 关键词标准化
  const normalizedKeyword: string = keyword.toLowerCase().trim();
  
  // 获取频道列表哈希
  const channelsHash: string = getChannelsHash(channels);
  
  // 生成TG搜索特定的缓存键
  const keyStr: string = `tg:${normalizedKeyword}:${channelsHash}`;
  const hash: string = calculateMD5(keyStr);
  return hash;
}

// GeneratePluginCacheKey 为插件搜索生成缓存键
export function GeneratePluginCacheKey(keyword: string, plugins: string[]): string {
  // 关键词标准化
  const normalizedKeyword: string = keyword.toLowerCase().trim();
  
  // 获取插件列表哈希
  const pluginsHash: string = getPluginsHash(plugins);
  
  // 生成插件搜索特定的缓存键
  const keyStr: string = `plugin:${normalizedKeyword}:${pluginsHash}`;
  const hash: string = calculateMD5(keyStr);
  return hash;
}

// GenerateCacheKey 根据所有影响搜索结果的参数生成缓存键
export function GenerateCacheKey(keyword: string, channels: string[], sourceType: string, plugins: string[]): string {
  // 关键词标准化
  const normalizedKeyword: string = keyword.toLowerCase().trim();
  
  // 获取频道列表哈希
  const channelsHash: string = getChannelsHash(channels);
  
  // 源类型处理
  const processedSourceType: string = sourceType || 'all';
  
  // 插件参数规范化处理
  let pluginsHash: string;
  if (processedSourceType === 'tg') {
    // 对于只搜索Telegram的请求，忽略插件参数
    pluginsHash = 'none';
  } else {
    // 获取插件列表哈希
    pluginsHash = getPluginsHash(plugins);
  }
  
  // 生成最终缓存键
  const keyStr: string = `${normalizedKeyword}:${channelsHash}:${processedSourceType}:${pluginsHash}`;
  const hash: string = calculateMD5(keyStr);
  return hash;
}

// 获取或计算频道哈希
function getChannelsHash(channels: string[]): string {
  if (!channels || channels.length === 0) {
    // 使用预计算的所有频道哈希
    if (precomputedHashes.has('all_channels')) {
      return precomputedHashes.get('all_channels')!;
    }
    return allChannelsHash;
  }
  
  // 对于小型列表，直接使用字符串连接
  if (channels.length < 5) {
    const channelsCopy: string[] = [...channels];
    channelsCopy.sort();
    
    // 直接返回排序后的字符串连接
    return channelsCopy.join(',');
  }
  
  // 生成排序后的字符串用作键
  const channelsCopy: string[] = [...channels];
  channelsCopy.sort();
  const key: string = channelsCopy.join(',');
  
  // 尝试从缓存获取
  if (channelHashCache.has(key)) {
    return channelHashCache.get(key)!;
  }
  
  // 计算哈希
  const hash: string = calculateListHash(channelsCopy);
  
  // 存入缓存
  channelHashCache.set(key, hash);
  return hash;
}

// 获取或计算插件哈希
function getPluginsHash(plugins: string[]): string {
  // 检查是否为空列表
  if (!plugins || plugins.length === 0) {
    // 使用预计算的所有插件哈希
    if (precomputedHashes.has('all_plugins')) {
      return precomputedHashes.get('all_plugins')!;
    }
    return allPluginsHash;
  }
  
  // 检查是否有空字符串元素
  let hasNonEmptyPlugin: boolean = false;
  for (const p of plugins) {
    if (p !== '') {
      hasNonEmptyPlugin = true;
      break;
    }
  }
  
  // 如果全是空字符串，也视为空列表
  if (!hasNonEmptyPlugin) {
    if (precomputedHashes.has('all_plugins')) {
      return precomputedHashes.get('all_plugins')!;
    }
    return allPluginsHash;
  }
  
  // 对于小型列表，直接使用字符串连接
  if (plugins.length < 5) {
    const pluginsCopy: string[] = [];
    for (const p of plugins) {
      if (p !== '') { // 忽略空字符串
        pluginsCopy.push(p);
      }
    }
    pluginsCopy.sort();
    
    // 直接返回排序后的字符串连接
    return pluginsCopy.join(',');
  }
  
  // 生成排序后的字符串用作键，忽略空字符串
  const pluginsCopy: string[] = [];
  for (const p of plugins) {
    if (p !== '') { // 忽略空字符串
      pluginsCopy.push(p);
    }
  }
  pluginsCopy.sort();
  const key: string = pluginsCopy.join(',');
  
  // 尝试从缓存获取
  if (pluginHashCache.has(key)) {
    return pluginHashCache.get(key)!;
  }
  
  // 计算哈希
  const hash: string = calculateListHash(pluginsCopy);
  
  // 存入缓存
  pluginHashCache.set(key, hash);
  return hash;
}

// 计算列表的哈希值
function calculateListHash(items: string[]): string {
  const h = crypto.createHash('md5');
  for (const item of items) {
    h.update(item);
  }
  return h.digest('hex');
}

// 计算MD5哈希
function calculateMD5(input: string): string {
  const hash = crypto.createHash('md5').update(input).digest('hex');
  return hash;
}

// GenerateCacheKeyV2 根据所有影响搜索结果的参数生成缓存键
// 为保持向后兼容，保留原函数，但标记为已弃用
export function GenerateCacheKeyV2(keyword: string, channels: string[], sourceType: string, plugins: string[]): string {
  // 关键词标准化：去除首尾空格，转为小写
  const normalizedKeyword: string = keyword.toLowerCase().trim();
  
  // 频道处理
  let channelsStr: string;
  if (channels && channels.length > 0) {
    const channelsCopy: string[] = [...channels];
    channelsCopy.sort();
    channelsStr = channelsCopy.join(',');
  } else {
    channelsStr = 'all';
  }
  
  // 插件处理
  let pluginsStr: string;
  if (plugins && plugins.length > 0) {
    const pluginsCopy: string[] = [...plugins];
    pluginsCopy.sort();
    pluginsStr = pluginsCopy.join(',');
  } else {
    pluginsStr = 'all';
  }
  
  // 源类型处理
  const processedSourceType: string = sourceType || 'all';
  
  // 生成缓存键字符串
  const keyStr: string = `v2:${normalizedKeyword}:${channelsStr}:${processedSourceType}:${pluginsStr}`;
  
  // 计算MD5哈希
  const hash: string = calculateMD5(keyStr);
  return hash;
}

// GenerateCacheKeyLegacy 根据查询和过滤器生成缓存键
// 为保持向后兼容，保留原函数，但重命名为更清晰的名称
export function GenerateCacheKeyLegacy(query: string, filters: Record<string, string>): string {
  // 如果只需要基于关键词的缓存，不考虑过滤器，调用新函数
  if (!filters || Object.keys(filters).length === 0) {
    return GenerateCacheKey(query, null, '', null);
  }
  
  // 创建包含查询和所有过滤器的字符串
  let keyStr: string = query;

  // 按字母顺序排序过滤器键，确保相同的过滤器集合总是产生相同的键
  const keys: string[] = Object.keys(filters);
  keys.sort();

  // 添加过滤器到键字符串
  for (const k of keys) {
    keyStr += `|${k}=${filters[k]}`;
  }

  // 计算MD5哈希
  const hash: string = calculateMD5(keyStr);
  return hash;
}

// 导出所有函数
export {
  GenerateTGCacheKey,
  GeneratePluginCacheKey,
  GenerateCacheKey,
  GenerateCacheKeyV2,
  GenerateCacheKeyLegacy,
  getChannelsHash,
  getPluginsHash,
  calculateListHash,
  calculateMD5
};
