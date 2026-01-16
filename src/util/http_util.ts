import * as https from 'https';
import * as http from 'http';
import * as url from 'url';
import * as net from 'net';
import { SocksProxyAgent } from 'socks-proxy-agent';

// 导入配置
import { AppConfig } from '../config/config';

// HTTP客户端配置接口
interface HTTPClientConfig {
  timeout: number;
  headers: Record<string, string>;
}

// 全局HTTP客户端配置
let httpClientConfig: HTTPClientConfig;
let httpsAgent: https.Agent;
let httpAgent: http.Agent;

// InitHTTPClient 初始化HTTP客户端
export function InitHTTPClient(): void {
  // 连接池配置
  const agentOptions = {
    keepAlive: true,
    keepAliveMsecs: 30000, // 30秒
    maxSockets: 100,
    maxFreeSockets: 20,
    timeout: 90000, // 90秒
  };

  // 创建代理配置
  let proxyAgent: https.Agent | http.Agent | undefined;

  if (AppConfig.UseProxy) {
    const proxyURL = AppConfig.ProxyURL;
    if (proxyURL) {
      try {
        const parsedURL = new URL(proxyURL);
        if (parsedURL.protocol === 'socks5:') {
          // 使用SOCKS5代理
          proxyAgent = new SocksProxyAgent(proxyURL);
        } else {
          // HTTP/HTTPS代理配置
          // 注意：Node.js的http/https模块不直接支持HTTP代理
          // 在实际使用中，可能需要使用如tunnel之类的库
          console.warn('HTTP代理配置需要额外的库支持');
        }
      } catch (error) {
        console.error('代理URL解析错误:', error);
      }
    }
  }

  // 创建HTTPS和HTTP代理
  httpsAgent = proxyAgent || new https.Agent(agentOptions);
  httpAgent = proxyAgent || new http.Agent(agentOptions);

  // 初始化客户端配置
  httpClientConfig = {
    timeout: 60000, // 60秒
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
      'Connection': 'keep-alive',
      'Upgrade-Insecure-Requests': '1',
    },
  };
}

// FetchHTML 获取HTML内容
export async function FetchHTML(targetURL: string): Promise<string> {
  if (!httpClientConfig) {
    InitHTTPClient();
  }

  return new Promise((resolve, reject) => {
    const parsedURL = new URL(targetURL);
    const isHTTPS = parsedURL.protocol === 'https:';
    const agent = isHTTPS ? httpsAgent : httpAgent;

    const options: https.RequestOptions | http.RequestOptions = {
      hostname: parsedURL.hostname,
      port: parsedURL.port || (isHTTPS ? '443' : '80'),
      path: parsedURL.pathname + parsedURL.search,
      method: 'GET',
      headers: httpClientConfig.headers,
      agent: agent,
      timeout: httpClientConfig.timeout,
    };

    const client = isHTTPS ? https : http;

    const req = client.request(options, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        resolve(data);
      });
    });

    req.on('error', (error) => {
      reject(error);
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });

    req.end();
  });
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
