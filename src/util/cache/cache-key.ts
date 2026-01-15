import { createHash } from 'crypto';
import { getRegisteredPlugins } from '../../plugins/plugin.manager';

// 预计算的哈希值映射
const channelHashCache = new Map<string, string>(); // 存储频道列表哈希
const pluginHashCache = new Map<string, string>(); // 存储插件列表哈希

// 预先计算的常用列表哈希值
const precomputedHashes = new Map<string, string>();

// 所有插件名称的哈希值
let allPluginsHash: string;
// 所有频道名称的哈希值
let allChannelsHash: string;

// 初始化预计算的哈希值
function init() {
  // 预计算空列表的哈希值
  precomputedHashes.set('empty_channels', 'all');
  
  // 预计算所有插件的哈希值
  try {
    const allPlugins = getRegisteredPlugins ? getRegisteredPlugins() : [];
    const allPluginNames = allPlugins.map(p => p.name ? p.name() : '').filter(name => name !== '');
    allPluginNames.sort();
    allPluginsHash = calculateListHash(allPluginNames);
  } catch (error) {
    // 如果插件系统尚未初始化，使用默认值
    allPluginsHash = 'default_plugins';
  }
  precomputedHashes.set('all_plugins', allPluginsHash);
  
  // 预计算所有频道的哈希值
  allChannelsHash = 'all';
  precomputedHashes.set('all_channels', allChannelsHash);
}

// 执行初始化
init();

// GenerateTGCacheKey 为TG搜索生成缓存键
export function GenerateTGCacheKey(keyword: string, channels: string[]): string {
  // 关键词标准化
  const normalizedKeyword = keyword.toLowerCase().trim();
  
  // 获取频道列表哈希
  const channelsHash = getChannelsHash(channels);
  
  // 生成TG搜索特定的缓存键
  const keyStr = `tg:${normalizedKeyword}:${channelsHash}`;
  return calculateMD5(keyStr);
}

// GeneratePluginCacheKey 为插件搜索生成缓存键
export function GeneratePluginCacheKey(keyword: string, plugins: string[]): string {
  // 关键词标准化
  const normalizedKeyword = keyword.toLowerCase().trim();
  
  // 获取插件列表哈希
  const pluginsHash = getPluginsHash(plugins);
  
  // 生成插件搜索特定的缓存键
  const keyStr = `plugin:${normalizedKeyword}:${pluginsHash}`;
  return calculateMD5(keyStr);
}

// GenerateCacheKey 根据所有影响搜索结果的参数生成缓存键
export function GenerateCacheKey(keyword: string, channels: string[], sourceType: string, plugins: string[]): string {
  // 关键词标准化
  const normalizedKeyword = keyword.toLowerCase().trim();
  
  // 获取频道列表哈希
  const channelsHash = getChannelsHash(channels);
  
  // 源类型处理
  const processedSourceType = sourceType || 'all';
  
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
  const keyStr = `${normalizedKeyword}:${channelsHash}:${processedSourceType}:${pluginsHash}`;
  return calculateMD5(keyStr);
}

// 获取或计算频道哈希
function getChannelsHash(channels: string[]): string {
  if (!channels || channels.length === 0) {
    // 使用预计算的所有频道哈希
    return precomputedHashes.get('all_channels') || allChannelsHash;
  }
  
  // 对于小型列表，直接使用字符串连接
  if (channels.length < 5) {
    const channelsCopy = [...channels];
    channelsCopy.sort();
    
    // 直接返回排序后的字符串连接
    return channelsCopy.join(',');
  }
  
  // 生成排序后的字符串用作键
  const channelsCopy = [...channels];
  channelsCopy.sort();
  const key = channelsCopy.join(',');
  
  // 尝试从缓存获取
  if (channelHashCache.has(key)) {
    return channelHashCache.get(key)!;
  }
  
  // 计算哈希
  const hash = calculateListHash(channelsCopy);
  
  // 存入缓存
  channelHashCache.set(key, hash);
  return hash;
}

// 获取或计算插件哈希
function getPluginsHash(plugins: string[]): string {
  // 检查是否为空列表
  if (!plugins || plugins.length === 0) {
    // 使用预计算的所有插件哈希
    return precomputedHashes.get('all_plugins') || allPluginsHash;
  }
  
  // 检查是否有空字符串元素
  const hasNonEmptyPlugin = plugins.some(p => p !== '');
  
  // 如果全是空字符串，也视为空列表
  if (!hasNonEmptyPlugin) {
    return precomputedHashes.get('all_plugins') || allPluginsHash;
  }
  
  // 对于小型列表，直接使用字符串连接
  if (plugins.length < 5) {
    const pluginsCopy = plugins.filter(p => p !== '');
    pluginsCopy.sort();
    
    // 直接返回排序后的字符串连接
    return pluginsCopy.join(',');
  }
  
  // 生成排序后的字符串用作键，忽略空字符串
  const pluginsCopy = plugins.filter(p => p !== '');
  pluginsCopy.sort();
  const key = pluginsCopy.join(',');
  
  // 尝试从缓存获取
  if (pluginHashCache.has(key)) {
    return pluginHashCache.get(key)!;
  }
  
  // 计算哈希
  const hash = calculateListHash(pluginsCopy);
  
  // 存入缓存
  pluginHashCache.set(key, hash);
  return hash;
}

// 计算列表的哈希值
function calculateListHash(items: string[]): string {
  const h = createHash('md5');
  for (const item of items) {
    h.update(item);
  }
  return h.digest('hex');
}

// 计算MD5哈希
function calculateMD5(input: string): string {
  const hash = createHash('md5');
  hash.update(input);
  return hash.digest('hex');
}

// GenerateCacheKeyV2 根据所有影响搜索结果的参数生成缓存键
// 为保持向后兼容，保留原函数，但标记为已弃用
export function GenerateCacheKeyV2(keyword: string, channels: string[], sourceType: string, plugins: string[]): string {
  // 关键词标准化：去除首尾空格，转为小写
  const normalizedKeyword = keyword.toLowerCase().trim();
  
  // 频道处理
  let channelsStr: string;
  if (channels && channels.length > 0) {
    const channelsCopy = [...channels];
    channelsCopy.sort();
    channelsStr = channelsCopy.join(',');
  } else {
    channelsStr = 'all';
  }
  
  // 插件处理
  let pluginsStr: string;
  if (plugins && plugins.length > 0) {
    const pluginsCopy = [...plugins];
    pluginsCopy.sort();
    pluginsStr = pluginsCopy.join(',');
  } else {
    pluginsStr = 'all';
  }
  
  // 源类型处理
  const processedSourceType = sourceType || 'all';
  
  // 生成缓存键字符串
  const keyStr = `v2:${normalizedKeyword}:${channelsStr}:${processedSourceType}:${pluginsStr}`;
  
  // 计算MD5哈希
  return calculateMD5(keyStr);
}

// GenerateCacheKeyLegacy 根据查询和过滤器生成缓存键
// 为保持向后兼容，保留原函数，但重命名为更清晰的名称
export function GenerateCacheKeyLegacy(query: string, filters: Record<string, string>): string {
  // 如果只需要基于关键词的缓存，不考虑过滤器，调用新函数
  if (!filters || Object.keys(filters).length === 0) {
    return GenerateCacheKey(query, undefined, '', undefined);
  }
  
  // 创建包含查询和所有过滤器的字符串
  let keyStr = query;

  // 按字母顺序排序过滤器键，确保相同的过滤器集合总是产生相同的键
  const keys = Object.keys(filters).sort();

  // 添加过滤器到键字符串
  for (const k of keys) {
    keyStr += `|${k}=${filters[k]}`;
  }

  // 计算MD5哈希
  return calculateMD5(keyStr);
}