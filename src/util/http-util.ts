import axios, { AxiosInstance, CreateAxiosDefaults } from 'axios';
import * as https from 'https';
import * as http from 'http';
import { URL } from 'url';
import { AppConfig } from '../config/config';

// HTTP客户端实例
let httpClient: AxiosInstance | null = null;

// InitHTTPClient 初始化HTTP客户端
export function InitHTTPClient(): void {
  // 创建axios配置
  const config: CreateAxiosDefaults = {
    // 超时设置
    timeout: 60000, // 60秒
    
    // HTTP和HTTPS代理配置
    httpAgent: new http.Agent({
      keepAlive: true,
      keepAliveMsecs: 30000,
      maxSockets: 100,
      maxFreeSockets: 20,
      timeout: 30000,
    }),
    httpsAgent: new https.Agent({
      keepAlive: true,
      keepAliveMsecs: 30000,
      maxSockets: 100,
      maxFreeSockets: 20,
      timeout: 30000,
      rejectUnauthorized: false, // 生产环境应设为true
    }),
    
    // 重试配置已移除，如需重试功能请使用axios-retry等插件
    
    // 请求头
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
      'Connection': 'keep-alive',
      'Upgrade-Insecure-Requests': '1',
    },
  };

  // 如果配置了代理，设置代理
  if (AppConfig?.useProxy && AppConfig.proxyURL) {
    const proxyUrl = new URL(AppConfig.proxyURL);
    config.proxy = {
      host: proxyUrl.hostname,
      port: parseInt(proxyUrl.port) || (proxyUrl.protocol === 'https:' ? 443 : 80),
      protocol: proxyUrl.protocol,
    };
    // 注：axios 本身支持HTTP/HTTPS代理，但对SOCKS5代理支持有限
    // 如果需要SOCKS5代理，可能需要使用 socks-proxy-agent 包
  }

  // 创建客户端实例
  httpClient = axios.create(config);
}

// GetHTTPClient 获取HTTP客户端
export function GetHTTPClient(): AxiosInstance {
  if (httpClient === null) {
    InitHTTPClient();
  }
  return httpClient!;
}

// FetchHTML 获取HTML内容
export async function FetchHTML(targetURL: string): Promise<string> {
  // 使用优化后的HTTP客户端
  const client = GetHTTPClient();
  
  // 发送请求
  const response = await client.get(targetURL);
  
  return response.data;
}

// BuildSearchURL 构建搜索URL
export function BuildSearchURL(channel: string, keyword: string, nextPageParam: string): string {
  let baseURL = `https://t.me/s/${channel}`;
  if (keyword) {
    baseURL += `?q=${encodeURIComponent(keyword)}`;
    if (nextPageParam) {
      baseURL += `&${nextPageParam}`;
    }
  }
  return baseURL;
}
