import * as os from 'os';
import * as path from 'path';

// Config 应用配置结构
export interface Config {
  defaultChannels: string[];
  defaultConcurrency: number;
  port: string;
  proxyURL: string;
  useProxy: boolean;
  httpProxyURL: string;
  httpsProxyURL: string;
  // 缓存相关配置
  cacheEnabled: boolean;
  cachePath: string;
  cacheMaxSizeMB: number;
  cacheTTLMinutes: number;
  // 压缩相关配置
  enableCompression: boolean;
  minSizeToCompress: number; // 最小压缩大小（字节）
  // GC相关配置
  gcPercent: number; // GC触发阈值百分比
  optimizeMemory: boolean; // 是否启用内存优化
  // 插件相关配置
  pluginTimeoutSeconds: number; // 插件超时时间（秒）
  pluginTimeout: number; // 插件超时时间（毫秒）
  // 异步插件相关配置
  asyncPluginEnabled: boolean; // 是否启用异步插件
  enabledPlugins: string[]; // 启用的具体插件列表（空表示启用所有）
  asyncResponseTimeout: number; // 响应超时时间（秒）
  asyncResponseTimeoutDur: number; // 响应超时时间（毫秒）
  asyncMaxBackgroundWorkers: number; // 最大后台工作者数量
  asyncMaxBackgroundTasks: number; // 最大后台任务数量
  asyncCacheTTLHours: number; // 异步缓存有效期（小时）
  asyncLogEnabled: boolean; // 是否启用异步插件详细日志
  // HTTP服务器配置
  httpReadTimeout: number; // 读取超时（毫秒）
  httpWriteTimeout: number; // 写入超时（毫秒）
  httpIdleTimeout: number; // 空闲超时（毫秒）
  httpMaxConns: number; // 最大连接数
  // 认证相关配置
  authEnabled: boolean; // 是否启用认证
  authUsers: Record<string, string>; // 用户名:密码映射
  authTokenExpiry: number; // Token有效期（毫秒）
  authJWTSecret: string; // JWT签名密钥
}

// 全局配置实例
export let AppConfig: Config | null = null;

// 从环境变量获取字符串值，如果未设置则使用默认值
function getEnvString(key: string, defaultValue: string): string {
  return process.env[key] || defaultValue;
}

// 从环境变量获取布尔值，如果未设置则使用默认值
function getEnvBoolean(key: string, defaultValue: boolean): boolean {
  const value = process.env[key];
  if (value === undefined) {
    return defaultValue;
  }
  return value !== 'false' && value !== '0';
}

// 从环境变量获取整数值，如果未设置或无效则使用默认值
function getEnvInt(key: string, defaultValue: number): number {
  const value = process.env[key];
  if (value === undefined) {
    return defaultValue;
  }
  const parsed = parseInt(value, 10);
  return isNaN(parsed) || parsed <= 0 ? defaultValue : parsed;
}

// 从环境变量获取默认频道列表，如果未设置则使用默认值
function getDefaultChannels(): string[] {
  const channelsEnv = process.env['CHANNELS'];
  if (!channelsEnv) {
    return ['tgsearchers4'];
  }
  return channelsEnv.split(',').map(channel => channel.trim());
}

// 从环境变量获取默认并发数，如果未设置则使用基于环境变量的简单计算
function getDefaultConcurrency(): number {
  const concurrencyEnv = process.env['CONCURRENCY'];
  if (concurrencyEnv) {
    const concurrency = parseInt(concurrencyEnv, 10);
    if (!isNaN(concurrency) && concurrency > 0) {
      return concurrency;
    }
  }
  
  // 环境变量未设置或无效，使用基于环境变量的简单计算
  // 计算频道数
  const channelCount = getDefaultChannels().length;
  
  // 估计插件数（从环境变量或默认值，实际在应用启动后会根据真实插件数调整）
  const pluginCountEnv = process.env['PLUGIN_COUNT'];
  let pluginCount = 0;
  if (pluginCountEnv) {
    const count = parseInt(pluginCountEnv, 10);
    if (!isNaN(count) && count > 0) {
      pluginCount = count;
    }
  }
  
  // 如果没有指定插件数，默认使用7个（当前已知的插件数）
  if (pluginCount === 0) {
    pluginCount = 7;
  }
  
  // 计算并发数 = 频道数 + 插件数 + 10
  let concurrency = channelCount + pluginCount + 10;
  if (concurrency < 1) {
    concurrency = 1; // 确保至少为1
  }
  
  return concurrency;
}

// 从环境变量获取服务端口，如果未设置则使用默认值
function getPort(): string {
  return getEnvString('PORT', '8888');
}

// 从环境变量获取代理URL
function getProxyURL(): string {
  return getEnvString('PROXY', '');
}

// 从环境变量获取HTTP代理URL
function getHTTPProxyURL(): string {
  return getEnvString('HTTP_PROXY', process.env['http_proxy'] || '');
}

// 从环境变量获取HTTPS代理URL
function getHTTPSProxyURL(): string {
  return getEnvString('HTTPS_PROXY', process.env['https_proxy'] || '');
}

// 从环境变量获取是否启用缓存，如果未设置则默认启用
function getCacheEnabled(): boolean {
  return getEnvBoolean('CACHE_ENABLED', true);
}

// 从环境变量获取缓存路径，如果未设置则使用默认路径
function getCachePath(): string {
  const pathEnv = getEnvString('CACHE_PATH', '');
  if (pathEnv) {
    return pathEnv;
  }
  // 默认在当前目录下创建cache文件夹
  try {
    return path.resolve('./cache');
  } catch (err) {
    return './cache';
  }
}

// 从环境变量获取缓存最大大小(MB)，如果未设置则使用默认值
function getCacheMaxSize(): number {
  return getEnvInt('CACHE_MAX_SIZE', 100);
}

// 从环境变量获取缓存TTL(分钟)，如果未设置则使用默认值
function getCacheTTL(): number {
  return getEnvInt('CACHE_TTL', 60);
}

// 从环境变量获取是否启用压缩，如果未设置则默认禁用
function getEnableCompression(): boolean {
  return getEnvBoolean('ENABLE_COMPRESSION', false);
}

// 从环境变量获取最小压缩大小，如果未设置则使用默认值
function getMinSizeToCompress(): number {
  return getEnvInt('MIN_SIZE_TO_COMPRESS', 1024);
}

// 从环境变量获取GC百分比，如果未设置则使用默认值
function getGCPercent(): number {
  return getEnvInt('GC_PERCENT', 50);
}

// 从环境变量获取是否优化内存，如果未设置则默认启用
function getOptimizeMemory(): boolean {
  return getEnvBoolean('OPTIMIZE_MEMORY', true);
}

// 从环境变量获取插件超时时间（秒），如果未设置则使用默认值
function getPluginTimeout(): number {
  return getEnvInt('PLUGIN_TIMEOUT', 30);
}

// 从环境变量获取是否启用异步插件，如果未设置则默认启用
function getAsyncPluginEnabled(): boolean {
  return getEnvBoolean('ASYNC_PLUGIN_ENABLED', true);
}

// 从环境变量获取启用的插件列表
// 返回空数组表示未设置环境变量（不启用任何插件）或设置为空（不启用任何插件）
// 返回具体列表表示启用指定插件
function getEnabledPlugins(): string[] {
  const plugins = process.env['ENABLED_PLUGINS'];
  if (!plugins) {
    // 未设置环境变量时返回空数组，表示不启用任何插件
    return [];
  }
  
  if (plugins.trim() === '') {
    // 设置为空字符串，也表示不启用任何插件
    return [];
  }
  
  // 按逗号分割插件名
  return plugins.split(',').map(plugin => plugin.trim()).filter(plugin => plugin !== '');
}

// 从环境变量获取异步响应超时时间（秒），如果未设置则使用默认值
function getAsyncResponseTimeout(): number {
  return getEnvInt('ASYNC_RESPONSE_TIMEOUT', 4);
}

// 从环境变量获取最大后台工作者数量，如果未设置则自动计算
function getAsyncMaxBackgroundWorkers(): number {
  const sizeEnv = process.env['ASYNC_MAX_BACKGROUND_WORKERS'];
  if (sizeEnv) {
    const size = parseInt(sizeEnv, 10);
    if (!isNaN(size) && size > 0) {
      return size;
    }
  }
  
  // 自动计算：根据CPU核心数计算
  // 每个CPU核心分配5个工作者，最小20个
  const cpuCount = os.cpus().length;
  let workers = cpuCount * 5;
  
  // 确保至少有20个工作者
  if (workers < 20) {
    workers = 20;
  }
  
  return workers;
}

// 从环境变量获取最大后台任务数量，如果未设置则自动计算
function getAsyncMaxBackgroundTasks(): number {
  const sizeEnv = process.env['ASYNC_MAX_BACKGROUND_TASKS'];
  if (sizeEnv) {
    const size = parseInt(sizeEnv, 10);
    if (!isNaN(size) && size > 0) {
      return size;
    }
  }
  
  // 自动计算：工作者数量的5倍，最小100个
  const workers = getAsyncMaxBackgroundWorkers();
  let tasks = workers * 5;
  
  // 确保至少有100个任务
  if (tasks < 100) {
    tasks = 100;
  }
  
  return tasks;
}

// 从环境变量获取异步缓存有效期（小时），如果未设置则使用默认值
function getAsyncCacheTTLHours(): number {
  return getEnvInt('ASYNC_CACHE_TTL_HOURS', 1);
}

// 从环境变量获取HTTP读取超时，如果未设置则自动计算
function getHTTPReadTimeout(): number {
  const timeoutEnv = process.env['HTTP_READ_TIMEOUT'];
  if (timeoutEnv) {
    const timeout = parseInt(timeoutEnv, 10);
    if (!isNaN(timeout) && timeout > 0) {
      return timeout * 1000; // 转换为毫秒
    }
  }
  
  // 自动计算：默认30秒，异步模式下根据异步响应超时调整
  let timeout = 30 * 1000;
  
  // 如果启用了异步插件，确保读取超时足够长
  if (getAsyncPluginEnabled()) {
    // 读取超时应该至少是异步响应超时的3倍，确保有足够时间完成异步操作
    const asyncTimeoutSecs = getAsyncResponseTimeout();
    const asyncTimeoutExtended = asyncTimeoutSecs * 3 * 1000;
    if (asyncTimeoutExtended > timeout) {
      timeout = asyncTimeoutExtended;
    }
  }
  
  return timeout;
}

// 从环境变量获取HTTP写入超时，如果未设置则自动计算
function getHTTPWriteTimeout(): number {
  const timeoutEnv = process.env['HTTP_WRITE_TIMEOUT'];
  if (timeoutEnv) {
    const timeout = parseInt(timeoutEnv, 10);
    if (!isNaN(timeout) && timeout > 0) {
      return timeout * 1000; // 转换为毫秒
    }
  }
  
  // 自动计算：默认60秒，但根据插件超时和异步处理时间调整
  let timeout = 60 * 1000;
  
  // 如果启用了异步插件，确保写入超时足够长
  const pluginTimeoutSecs = getPluginTimeout();
  
  // 计算1.5倍的插件超时时间（使用整数运算：乘以3再除以2）
  const pluginTimeoutExtended = pluginTimeoutSecs * 3 / 2 * 1000;
  
  if (pluginTimeoutExtended > timeout) {
    timeout = pluginTimeoutExtended;
  }
  
  return timeout;
}

// 从环境变量获取HTTP空闲超时，如果未设置则自动计算
function getHTTPIdleTimeout(): number {
  const timeoutEnv = process.env['HTTP_IDLE_TIMEOUT'];
  if (timeoutEnv) {
    const timeout = parseInt(timeoutEnv, 10);
    if (!isNaN(timeout) && timeout > 0) {
      return timeout * 1000; // 转换为毫秒
    }
  }
  
  // 自动计算：默认120秒，考虑到保持连接的效益
  return 120 * 1000;
}

// 从环境变量获取HTTP最大连接数，如果未设置则自动计算
function getHTTPMaxConns(): number {
  const maxConnsEnv = process.env['HTTP_MAX_CONNS'];
  if (maxConnsEnv) {
    const maxConns = parseInt(maxConnsEnv, 10);
    if (!isNaN(maxConns) && maxConns > 0) {
      return maxConns;
    }
  }
  
  // 自动计算：根据CPU核心数计算
  // 每个CPU核心分配200个连接，最小1000个
  const cpuCount = os.cpus().length;
  let maxConns = cpuCount * 200;
  
  // 确保至少有1000个连接
  if (maxConns < 1000) {
    maxConns = 1000;
  }
  
  return maxConns;
}

// 从环境变量获取异步插件日志开关，如果未设置则使用默认值
function getAsyncLogEnabled(): boolean {
  const logEnv = process.env['ASYNC_LOG_ENABLED'];
  if (!logEnv) {
    return true; // 默认启用日志
  }
  const enabled = parseBoolean(logEnv);
  if (enabled === null) {
    return true; // 解析失败时默认启用
  }
  return enabled;
}

// 辅助函数：解析布尔值
function parseBoolean(value: string): boolean | null {
  const lower = value.toLowerCase();
  if (lower === 'true' || lower === '1') {
    return true;
  }
  if (lower === 'false' || lower === '0') {
    return false;
  }
  return null;
}

// 从环境变量获取认证开关，如果未设置则默认关闭
function getAuthEnabled(): boolean {
  return getEnvBoolean('AUTH_ENABLED', false);
}

// 从环境变量获取用户配置，格式：user1:pass1,user2:pass2
function getAuthUsers(): Record<string, string> {
  const usersEnv = getEnvString('AUTH_USERS', '');
  if (!usersEnv) {
    return {};
  }
  
  const users: Record<string, string> = {};
  const pairs = usersEnv.split(',');
  for (const pair of pairs) {
    const parts = pair.split(':');
    if (parts.length === 2) {
      const username = parts[0].trim();
      const password = parts[1].trim();
      if (username && password) {
        users[username] = password;
      }
    }
  }
  return users;
}

// 从环境变量获取Token有效期（小时），如果未设置则使用默认值
function getAuthTokenExpiry(): number {
  const expiryEnv = process.env['AUTH_TOKEN_EXPIRY'];
  if (expiryEnv) {
    const expiry = parseInt(expiryEnv, 10);
    if (!isNaN(expiry) && expiry > 0) {
      return expiry * 60 * 60 * 1000; // 转换为毫秒
    }
  }
  return 24 * 60 * 60 * 1000; // 默认24小时
}

// 从环境变量获取JWT密钥，如果未设置则生成随机密钥
function getAuthJWTSecret(): string {
  const secret = getEnvString('AUTH_JWT_SECRET', '');
  if (secret) {
    return secret;
  }
  // 生成随机密钥（32字节）
  // 注意：实际使用时应该使用crypto.randomBytes生成随机密钥
  // 这里为了简化，使用时间戳作为临时密钥
  return 'pansou-default-secret-' + Date.now();
}

// 初始化配置
export function Init(): void {
  const proxyURL = getProxyURL();
  const pluginTimeoutSeconds = getPluginTimeout();
  const asyncResponseTimeoutSeconds = getAsyncResponseTimeout();
  
  AppConfig = {
    defaultChannels: getDefaultChannels(),
    defaultConcurrency: getDefaultConcurrency(),
    port: getPort(),
    proxyURL,
    useProxy: proxyURL !== '',
    httpProxyURL: getHTTPProxyURL(),
    httpsProxyURL: getHTTPSProxyURL(),
    // 缓存相关配置
    cacheEnabled: getCacheEnabled(),
    cachePath: getCachePath(),
    cacheMaxSizeMB: getCacheMaxSize(),
    cacheTTLMinutes: getCacheTTL(),
    // 压缩相关配置
    enableCompression: getEnableCompression(),
    minSizeToCompress: getMinSizeToCompress(),
    // GC相关配置
    gcPercent: getGCPercent(),
    optimizeMemory: getOptimizeMemory(),
    // 插件相关配置
    pluginTimeoutSeconds,
    pluginTimeout: pluginTimeoutSeconds * 1000, // 转换为毫秒
    // 异步插件相关配置
    asyncPluginEnabled: getAsyncPluginEnabled(),
    enabledPlugins: getEnabledPlugins(),
    asyncResponseTimeout: asyncResponseTimeoutSeconds,
    asyncResponseTimeoutDur: asyncResponseTimeoutSeconds * 1000, // 转换为毫秒
    asyncMaxBackgroundWorkers: getAsyncMaxBackgroundWorkers(),
    asyncMaxBackgroundTasks: getAsyncMaxBackgroundTasks(),
    asyncCacheTTLHours: getAsyncCacheTTLHours(),
    asyncLogEnabled: getAsyncLogEnabled(),
    // HTTP服务器配置
    httpReadTimeout: getHTTPReadTimeout(),
    httpWriteTimeout: getHTTPWriteTimeout(),
    httpIdleTimeout: getHTTPIdleTimeout(),
    httpMaxConns: getHTTPMaxConns(),
    // 认证相关配置
    authEnabled: getAuthEnabled(),
    authUsers: getAuthUsers(),
    authTokenExpiry: getAuthTokenExpiry(),
    authJWTSecret: getAuthJWTSecret(),
  };
  
  // 应用GC配置（在TypeScript中这部分逻辑可能需要调整）
  applyGCSettings();
}

// 应用GC设置
function applyGCSettings(): void {
  // TypeScript中没有直接对应的GC设置API
  // 如果需要，可以使用Node.js的 --gc-interval 等命令行参数
}

// 更新默认并发数（根据实际插件数或0调用）
// pluginCount: 如果插件被禁用则为0，否则为实际插件数
export function UpdateDefaultConcurrency(pluginCount: number): void {
  if (!AppConfig) {
    return;
  }
  
  // 只有当未通过环境变量指定并发数时才进行调整
  const concurrencyEnv = process.env['CONCURRENCY'];
  if (concurrencyEnv) {
    return;
  }
  
  // 计算频道数
  const channelCount = AppConfig.defaultChannels.length;
  
  // 计算并发数 = 频道数 + 插件数（插件禁用时为0）+ 10
  let concurrency = channelCount + pluginCount + 10;
  if (concurrency < 1) {
    concurrency = 1; // 确保至少为1
  }
  
  // 更新配置
  AppConfig.defaultConcurrency = concurrency;
}
