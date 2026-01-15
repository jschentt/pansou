import * as cheerio from 'cheerio';
import { SearchResult, Link } from '../models/response';

// 定义正则表达式模式
export const BaiduPanPattern = /pan\.baidu\.com|pan\.baidu\.cn/;
export const TianyiPanPattern = /cloud\.189\.cn|share\.189\.cn/;
export const UCPanPattern = /www\.uc123\.cc|share\.uc123\.cc|pan\.uc\.cn|share\.uc\.cn/;
export const Pan123Pattern = /www\.123pan\.com|pan\.123pan\.com|123pan\.com/;
export const QuarkPanPattern = /pan\.quark\.cn|share\.quark\.cn|pan\.myquark\.cn/;
export const XunleiPanPattern = /pan\.xunlei\.com|share\.xunlei\.com|pan\.xunlei\.cn/;
export const Pan115Pattern = /115\.com|pan\.115\.com|v\.115\.com/;
export const AllPanLinksPattern = /(pan|yun|cloud)\.(baidu|189|123|quark|xunlei|115|uc|aliyun|myquark|189share|uc123|my|sohu|sina|163|netease|qiyi|youku|tudou|iqiyi)\.(com|cn|org|cc)/;

// normalizeUrl 标准化URL，将URL编码的中文部分解码为中文，用于去重
export function normalizeUrl(rawUrl: string): string {
  // 解码URL中的编码字符
  try {
    return decodeURIComponent(rawUrl);
  } catch (err) {
    // 如果解码失败，返回原始URL
    return rawUrl;
  }
}

// isSupportedLink 检查链接是否为支持的网盘链接
export function isSupportedLink(url: string): boolean {
  const lowerURL = url.toLowerCase();
  
  // 检查是否为百度网盘链接
  if (BaiduPanPattern.test(lowerURL)) {
    return true;
  }
  
  // 检查是否为天翼云盘链接
  if (TianyiPanPattern.test(lowerURL)) {
    return true;
  }
  
  // 检查是否为UC网盘链接
  if (UCPanPattern.test(lowerURL)) {
    return true;
  }
  
  // 检查是否为123网盘链接
  if (Pan123Pattern.test(lowerURL)) {
    return true;
  }
  
  // 检查是否为夸克网盘链接
  if (QuarkPanPattern.test(lowerURL)) {
    return true;
  }
  
  // 检查是否为迅雷网盘链接
  if (XunleiPanPattern.test(lowerURL)) {
    return true;
  }
  
  // 检查是否为115网盘链接
  if (Pan115Pattern.test(lowerURL)) {
    return true;
  }
  
  // 使用通用模式检查其他网盘链接
  return AllPanLinksPattern.test(lowerURL);
}

// getLinkType 获取链接类型
export function getLinkType(url: string): string {
  const lowerURL = url.toLowerCase();
  
  if (BaiduPanPattern.test(lowerURL)) {
    return 'baidu';
  }
  if (TianyiPanPattern.test(lowerURL)) {
    return 'tianyi';
  }
  if (UCPanPattern.test(lowerURL)) {
    return 'uc';
  }
  if (Pan123Pattern.test(lowerURL)) {
    return '123';
  }
  if (QuarkPanPattern.test(lowerURL)) {
    return 'quark';
  }
  if (XunleiPanPattern.test(lowerURL)) {
    return 'xunlei';
  }
  if (Pan115Pattern.test(lowerURL)) {
    return '115';
  }
  
  return 'other';
}

// extractPassword 从消息文本中提取链接对应的密码
export function extractPassword(messageText: string, url: string): string {
  // 简单实现：从文本中提取可能的密码
  const passwordPattern = /密码[:：]?\s*([\w\d]{4})/i;
  const match = messageText.match(passwordPattern);
  return match ? match[1] : '';
}

// cleanBaiduPanURL 清理百度网盘URL
export function cleanBaiduPanURL(url: string): string {
  // 移除URL中的额外参数，保留基本链接和密码
  const urlObj = new URL(url);
  const password = urlObj.searchParams.get('pwd');
  
  // 保留基本链接
  urlObj.search = '';
  let cleanUrl = urlObj.toString();
  
  // 如果有密码，添加回URL
  if (password) {
    cleanUrl += `?pwd=${password}`;
  }
  
  return cleanUrl;
}

// cleanTianyiPanURL 清理天翼云盘URL
export function cleanTianyiPanURL(url: string): string {
  // 移除URL中的额外参数
  const urlObj = new URL(url);
  urlObj.search = '';
  return urlObj.toString();
}

// cleanUCPanURL 清理UC网盘URL
export function cleanUCPanURL(url: string): string {
  // 移除URL中的额外参数
  const urlObj = new URL(url);
  urlObj.search = '';
  return urlObj.toString();
}

// clean123PanURL 清理123网盘URL
export function clean123PanURL(url: string): string {
  // 移除URL中的额外参数
  const urlObj = new URL(url);
  urlObj.search = '';
  return urlObj.toString();
}

// clean115PanURL 清理115网盘URL
export function clean115PanURL(url: string): string {
  // 移除URL中的额外参数，保留基本链接和密码
  const urlObj = new URL(url);
  const password = urlObj.searchParams.get('password');
  
  // 保留基本链接
  urlObj.search = '';
  let cleanUrl = urlObj.toString();
  
  // 如果有密码，添加回URL
  if (password) {
    cleanUrl += `?password=${password}`;
  }
  
  return cleanUrl;
}

// cleanAliyunPanURL 清理阿里云盘URL
export function cleanAliyunPanURL(url: string): string {
  // 移除URL中的额外参数
  const urlObj = new URL(url);
  urlObj.search = '';
  return urlObj.toString();
}

// normalizeBaiduPanURL 标准化百度网盘URL
export function normalizeBaiduPanURL(url: string, password: string): string {
  // 清理URL
  url = cleanBaiduPanURL(url);
  
  // 如果URL已经包含pwd参数，不需要再添加
  if (url.includes('?pwd=')) {
    return url;
  }
  
  // 如果有提取到密码，且URL不包含pwd参数，则添加
  if (password) {
    // 确保密码是4位
    if (password.length > 4) {
      password = password.substring(0, 4);
    }
    return `${url}?pwd=${password}`;
  }
  
  return url;
}

// normalizeTianyiPanURL 标准化天翼云盘URL
export function normalizeTianyiPanURL(url: string, password: string): string {
  // 清理URL
  return cleanTianyiPanURL(url);
}

// normalizeUCPanURL 标准化UC网盘URL
export function normalizeUCPanURL(url: string, password: string): string {
  // 清理URL
  return cleanUCPanURL(url);
}

// normalize123PanURL 标准化123网盘URL
export function normalize123PanURL(url: string, password: string): string {
  // 清理URL
  return clean123PanURL(url);
}

// normalize115PanURL 标准化115网盘URL
export function normalize115PanURL(url: string, password: string): string {
  // 清理URL
  return clean115PanURL(url);
}

// extractNetDiskLinks 从文本内容中提取所有网盘链接
export function extractNetDiskLinks(text: string): string[] {
  const linkPattern = /https?:\/\/[\w\-._~:/?#[\]@!$&'()*+,;=]+/g;
  const links = text.match(linkPattern) || [];
  return links.filter(link => isSupportedLink(link));
}

// CutTitleByKeywords 根据关键词进行裁剪，保留最前关键词前的部分
export function cutTitleByKeywords(title: string, keywords: string[]): string {
  let minIdx = -1;
  for (const kw of keywords) {
    const idx = title.indexOf(kw);
    if (idx >= 0 && (minIdx === -1 || idx < minIdx)) {
      minIdx = idx;
    }
  }
  if (minIdx > 0) {
    return title.substring(0, minIdx).trim();
  }
  return title.trim();
}

// extractImageURLFromStyle 从CSS样式字符串中提取background-image的URL
export function extractImageURLFromStyle(style: string): string {
  // 查找background-image:url('...') 或 background-image:url("...")
  const patterns = [
    { start: "background-image:url('", end: "')" },
    { start: `background-image:url("`, end: `")` },
    { start: "background-image:url(", end: ")" }
  ];

  for (const { start, end } of patterns) {
    const startIndex = style.indexOf(start);
    if (startIndex !== -1) {
      const startPos = startIndex + start.length;
      const endIndex = style.indexOf(end, startPos);
      if (endIndex !== -1) {
        let url = style.substring(startPos, endIndex);
        // 移除可能的引号
        url = url.replace(/^["']/, '').replace(/["']$/, '');
        return url;
      }
    }
  }

  return '';
}

// extractTitle 从消息HTML和文本内容中提取标题
export function extractTitle(htmlContent: string, textContent: string): string {
  // 从HTML内容中提取标题
  if (htmlContent.includes('<br')) {
    const brIndex = htmlContent.indexOf('<br');
    const firstLineHTML = htmlContent.substring(0, brIndex);
    
    // 创建一个文档来解析这个HTML片段
    const $ = cheerio.load(`<div>${firstLineHTML}</div>`);
    const firstLine = $.text().trim();
    
    // 如果第一行以"名称："开头，则提取冒号后面的内容作为标题
    if (firstLine.startsWith('名称：')) {
      return firstLine.substring('名称：'.length).trim();
    }
    
    // 如果第一行只是标签(以#开头)，尝试从第二行提取
    if (firstLine.startsWith('#') && !firstLine.includes('名称')) {
      // 继续从文本内容提取
    } else {
      return firstLine;
    }
  }
  
  // 如果HTML解析失败，则使用纯文本内容
  const lines = textContent.split('\n');
  if (lines.length === 0) {
    return '';
  }
  
  // 第一行通常是标题
  let firstLine = lines[0].trim();
  
  // 如果第一行只是标签(以#开头且不包含实际内容)，尝试从第二行或"名称："字段提取
  if (firstLine.startsWith('#')) {
    // 检查是否有"名称："字段
    for (const line of lines) {
      const trimmedLine = line.trim();
      if (trimmedLine.startsWith('名称：')) {
        return trimmedLine.substring('名称：'.length).trim();
      }
    }
    
    // 如果没有"名称："字段，尝试使用第二行
    if (lines.length > 1) {
      const secondLine = lines[1].trim();
      if (secondLine.startsWith('名称：')) {
        return secondLine.substring('名称：'.length).trim();
      }
      // 如果第二行不是空的且不是标签，使用第二行
      if (secondLine && !secondLine.startsWith('#')) {
        return cutTitleByKeywords(secondLine, ['简介', '描述']);
      }
    }
  }
  
  // 如果第一行以"名称："开头，则提取冒号后面的内容作为标题
  if (firstLine.startsWith('名称：')) {
    return firstLine.substring('名称：'.length).trim();
  }
  
  // 否则直接使用第一行作为标题
  return cutTitleByKeywords(firstLine, ['简介', '描述']);
}

// isSingleLineFormat 检测是否是单行格式
export function isSingleLineFormat(lines: string[]): boolean {
  let singleLineCount = 0;
  for (const line of lines) {
    const trimmedLine = line.trim();
    if (!trimmedLine) {
      continue;
    }
    
    // 检测是否包含："作品名丨网盘：链接" 或类似格式
    if (trimmedLine.includes('丨') && trimmedLine.includes('：') && (trimmedLine.includes('http://') || trimmedLine.includes('https://'))) {
      singleLineCount++;
    }
  }
  
  // 如果超过一半的行都符合单行格式，则认为是单行格式
  return singleLineCount > lines.length / 3;
}

// extractFirstURL 从文本中提取第一个URL
export function extractFirstURL(text: string): string {
  // 提取到空格或换行符为止
  let endIdx = text.length;
  const spaceIdx = text.indexOf(' ');
  if (spaceIdx > 0 && spaceIdx < endIdx) {
    endIdx = spaceIdx;
  }
  const newlineIdx = text.indexOf('\n');
  if (newlineIdx > 0 && newlineIdx < endIdx) {
    endIdx = newlineIdx;
  }
  const returnIdx = text.indexOf('\r');
  if (returnIdx > 0 && returnIdx < endIdx) {
    endIdx = returnIdx;
  }
  
  return text.substring(0, endIdx).trim();
}

// extractWorkTitleBeforeColon 从冒号前的文本中提取作品名
export function extractWorkTitleBeforeColon(text: string): string {
  let trimmedText = text.trim();
  
  // 移除常见的网盘名称
  const netdiskNames = [
    '夸克网盘', '夸克云盘', '夸克',
    '百度网盘', '百度云盘', '百度云', '百度',
    '迅雷网盘', '迅雷云盘', '迅雷',
    '阿里云盘', '阿里网盘', '阿里云', '阿里',
    '天翼云盘', '天翼网盘', '天翼云', '天翼',
    'UC网盘', 'UC云盘', 'UC',
    '移动云盘', '移动云', '移动',
    '115网盘', '115云盘', '115',
    '123网盘', '123云盘', '123',
    'PikPak网盘', 'PikPak',
    '网盘', '云盘',
  ];
  
  // 从右向左移除网盘名称
  for (const name of netdiskNames) {
    if (trimmedText.endsWith(name)) {
      trimmedText = trimmedText.substring(0, trimmedText.length - name.length).trim();
      break;
    }
  }
  
  return trimmedText;
}

// extractWorkTitlesFromSingleLineFormat 从单行格式中提取作品标题
export function extractWorkTitlesFromSingleLineFormat(links: Link[], lines: string[], defaultTitle: string): Link[] {
  // 为每个链接构建URL到作品标题的映射
  const urlToWorkTitle: Record<string, string> = {};
  
  for (const line of lines) {
    const trimmedLine = line.trim();
    if (!trimmedLine) {
      continue;
    }
    
    // 匹配格式: "作品名丨网盘名：链接" 或 "作品名 网盘名：链接"
    // 提取作品名和链接
    let workTitle = '';
    let linkURL = '';
    
    // 优先匹配 "作品名丨网盘：链接" 格式
    if (trimmedLine.includes('丨')) {
      const parts = trimmedLine.split('丨');
      if (parts.length >= 2) {
        workTitle = parts[0].trim();
        // 从第二部分提取链接
        const restPart = parts[1];
        const httpIdx = restPart.indexOf('http');
        if (httpIdx >= 0) {
          linkURL = extractFirstURL(restPart.substring(httpIdx));
        }
      }
    } else if (trimmedLine.includes('：')) {
      // 匹配 "作品名 网盘：链接" 格式
      const colonIdx = trimmedLine.indexOf('：');
      if (colonIdx > 0) {
        const beforeColon = trimmedLine.substring(0, colonIdx);
        const afterColon = trimmedLine.substring(colonIdx + '：'.length);
        
        // 尝试从冒号前提取作品名（去除网盘名）
        workTitle = extractWorkTitleBeforeColon(beforeColon);
        
        // 从冒号后提取链接
        const httpIdx = afterColon.indexOf('http');
        if (httpIdx >= 0) {
          linkURL = extractFirstURL(afterColon.substring(httpIdx));
        }
      }
    }
    
    // 如果成功提取了作品名和链接，添加到映射
    if (workTitle && linkURL) {
      // 标准化URL用于匹配
      const normalizedURL = normalizeUrl(linkURL);
      urlToWorkTitle[normalizedURL] = workTitle;
    }
  }
  
  // 为每个链接设置作品标题
  return links.map(link => {
    const normalizedURL = normalizeUrl(link.url);
    const workTitle = urlToWorkTitle[normalizedURL] || defaultTitle;
    return { ...link, workTitle };
  });
}

// extractWorkTitlesFromContext 通过上下文为链接提取作品标题
export function extractWorkTitlesFromContext(links: Link[], messageText: string, defaultTitle: string): Link[] {
  // 简单实现：如果无法精确匹配，则都使用默认标题
  return links.map(link => ({ ...link, workTitle: defaultTitle }));
}

// extractWorkTitlesForLinks 为每个链接提取作品标题
export function extractWorkTitlesForLinks(links: Link[], messageText: string, defaultTitle: string): Link[] {
  if (links.length === 0) {
    return links;
  }
  
  // 如果链接数量 <= 4，认为是同一个作品的不同网盘链接
  if (links.length <= 4) {
    return links.map(link => ({ ...link, workTitle: defaultTitle }));
  }
  
  // 如果链接数量 > 4，尝试为每个链接匹配具体的作品标题
  const lines = messageText.split('\n');
  
  // 检测是否是单行格式："作品名丨网盘：链接" 或 "作品名 网盘：链接"
  if (isSingleLineFormat(lines)) {
    return extractWorkTitlesFromSingleLineFormat(links, lines, defaultTitle);
  }
  
  // 其他格式：尝试通过上下文匹配
  return extractWorkTitlesFromContext(links, messageText, defaultTitle);
}

// ParseSearchResults 解析搜索结果页面
export function ParseSearchResults(html: string, channel: string): { results: SearchResult[]; nextPageParam: string; error?: string } {
  try {
    const $ = cheerio.load(html);
    const results: SearchResult[] = [];
    let nextPageParam = '';

    // 查找消息块
    $('.tgme_widget_message_wrap').each((i, element) => {
      const messageDiv = $(element).find('.tgme_widget_message');
      
      // 提取消息ID
      const dataPost = messageDiv.attr('data-post');
      if (!dataPost) {
        return;
      }
      
      const parts = dataPost.split('/');
      if (parts.length !== 2) {
        return;
      }
      
      const messageID = parts[1];
      
      // 生成全局唯一ID
      const uniqueID = `${channel}_${messageID}`;
      
      // 提取时间
      const timeStr = messageDiv.find('.tgme_widget_message_date time').attr('datetime');
      if (!timeStr) {
        return;
      }
      
      const datetime = new Date(timeStr);
      if (isNaN(datetime.getTime())) {
        return;
      }
      
      // 获取消息文本元素
      const messageTextElem = messageDiv.find('.tgme_widget_message_text');
      
      // 获取消息文本的HTML内容
      const messageHTML = messageTextElem.html() || '';
      
      // 获取消息的纯文本内容
      const messageText = messageTextElem.text() || '';
      
      // 提取标题
      const title = extractTitle(messageHTML, messageText);
      
      // 提取网盘链接 - 使用更精确的方法
      const links: Link[] = [];
      const foundLinks: Record<string, boolean> = {}; // 用于去重
      const baiduLinkPasswords: Record<string, string> = {}; // 存储百度链接和对应的密码
      const tianyiLinkPasswords: Record<string, string> = {}; // 存储天翼链接和对应的密码
      const ucLinkPasswords: Record<string, string> = {}; // 存储UC链接和对应的密码
      const pan123LinkPasswords: Record<string, string> = {}; // 存储123网盘链接和对应的密码
      const pan115LinkPasswords: Record<string, string> = {}; // 存储115网盘链接和对应的密码
      const aliyunLinkPasswords: Record<string, string> = {}; // 存储阿里云盘链接和对应的密码
      
      // 1. 从文本内容中提取所有网盘链接和密码
      const extractedLinks = extractNetDiskLinks(messageText);
      
      // 2. 从a标签中提取链接
      messageTextElem.find('a').each((i, aElement) => {
        const href = $(aElement).attr('href');
        if (!href) {
          return;
        }
        
        // 使用更精确的方式匹配网盘链接
        if (isSupportedLink(href)) {
          const linkType = getLinkType(href);
          const password = extractPassword(messageText, href);
          
          // 如果是百度网盘链接，记录链接和密码的对应关系
          if (linkType === 'baidu') {
            // 提取链接的基本部分（不含密码参数）
            let baseURL = href;
            if (href.includes('?pwd=')) {
              baseURL = href.substring(0, href.indexOf('?pwd='));
            }
            
            // 记录密码
            if (password) {
              baiduLinkPasswords[baseURL] = password;
            }
          } else if (linkType === 'tianyi') {
            // 如果是天翼云盘链接，记录链接和密码的对应关系
            const baseURL = cleanTianyiPanURL(href);
            
            // 记录密码
            if (password) {
              tianyiLinkPasswords[baseURL] = password;
            } else {
              // 即使没有密码，也添加到映射中，以便后续处理
              if (!tianyiLinkPasswords[baseURL]) {
                tianyiLinkPasswords[baseURL] = '';
              }
            }
          } else if (linkType === 'uc') {
            // 如果是UC网盘链接，记录链接和密码的对应关系
            const baseURL = cleanUCPanURL(href);
            
            // 记录密码
            if (password) {
              ucLinkPasswords[baseURL] = password;
            } else {
              // 即使没有密码，也添加到映射中，以便后续处理
              if (!ucLinkPasswords[baseURL]) {
                ucLinkPasswords[baseURL] = '';
              }
            }
          } else if (linkType === '123') {
            // 如果是123网盘链接，记录链接和密码的对应关系
            const baseURL = clean123PanURL(href);
            
            // 记录密码
            if (password) {
              pan123LinkPasswords[baseURL] = password;
            } else {
              // 即使没有密码，也添加到映射中，以便后续处理
              if (!pan123LinkPasswords[baseURL]) {
                pan123LinkPasswords[baseURL] = '';
              }
            }
          } else if (linkType === '115') {
            // 如果是115网盘链接，记录链接和密码的对应关系
            const baseURL = clean115PanURL(href);
            
            // 记录密码
            if (password) {
              pan115LinkPasswords[baseURL] = password;
            } else {
              // 即使没有密码，也添加到映射中，以便后续处理
              if (!pan115LinkPasswords[baseURL]) {
                pan115LinkPasswords[baseURL] = '';
              }
            }
          } else if (linkType === 'aliyun') {
            // 如果是阿里云盘链接，记录链接和密码的对应关系
            const baseURL = cleanAliyunPanURL(href);
            
            // 记录密码
            if (password) {
              aliyunLinkPasswords[baseURL] = password;
            } else {
              // 即使没有密码，也添加到映射中，以便后续处理
              if (!aliyunLinkPasswords[baseURL]) {
                aliyunLinkPasswords[baseURL] = '';
              }
            }
          } else {
            // 非特殊处理的网盘链接直接添加
            // 使用标准化的URL进行去重
            const normalizedHref = normalizeUrl(href);
            if (!foundLinks[normalizedHref]) {
              foundLinks[normalizedHref] = true;
              links.push({
                type: linkType,
                url: normalizedHref,  // 使用标准化的URL
                password,
              });
            }
          }
        }
      });
      
      // 3. 处理从文本中提取的链接
      for (const linkURL of extractedLinks) {
        const linkType = getLinkType(linkURL);
        const password = extractPassword(messageText, linkURL);
        
        // 如果是百度网盘链接，记录链接和密码的对应关系
        if (linkType === 'baidu') {
          // 提取链接的基本部分（不含密码参数）
          let baseURL = linkURL;
          if (linkURL.includes('?pwd=')) {
            baseURL = linkURL.substring(0, linkURL.indexOf('?pwd='));
          }
          
          // 记录密码
          if (password) {
            baiduLinkPasswords[baseURL] = password;
          }
        } else if (linkType === 'tianyi') {
          // 如果是天翼云盘链接，记录链接和密码的对应关系
          const baseURL = cleanTianyiPanURL(linkURL);
          
          // 记录密码
          if (password) {
            tianyiLinkPasswords[baseURL] = password;
          } else {
            // 即使没有密码，也添加到映射中，以便后续处理
            if (!tianyiLinkPasswords[baseURL]) {
              tianyiLinkPasswords[baseURL] = '';
            }
          }
        } else if (linkType === 'uc') {
          // 如果是UC网盘链接，记录链接和密码的对应关系
          const baseURL = cleanUCPanURL(linkURL);
          
          // 记录密码
          if (password) {
            ucLinkPasswords[baseURL] = password;
          } else {
            // 即使没有密码，也添加到映射中，以便后续处理
            if (!ucLinkPasswords[baseURL]) {
              ucLinkPasswords[baseURL] = '';
            }
          }
        } else if (linkType === '123') {
          // 如果是123网盘链接，记录链接和密码的对应关系
          const baseURL = clean123PanURL(linkURL);
          
          // 记录密码
          if (password) {
            pan123LinkPasswords[baseURL] = password;
          } else {
            // 即使没有密码，也添加到映射中，以便后续处理
            if (!pan123LinkPasswords[baseURL]) {
              pan123LinkPasswords[baseURL] = '';
            }
          }
        } else if (linkType === '115') {
          // 如果是115网盘链接，记录链接和密码的对应关系
          const baseURL = clean115PanURL(linkURL);
          
          // 记录密码
          if (password) {
            pan115LinkPasswords[baseURL] = password;
          } else {
            // 即使没有密码，也添加到映射中，以便后续处理
            if (!pan115LinkPasswords[baseURL]) {
              pan115LinkPasswords[baseURL] = '';
            }
          }
        } else if (linkType === 'aliyun') {
          // 如果是阿里云盘链接，记录链接和密码的对应关系
          const baseURL = cleanAliyunPanURL(linkURL);
          
          // 记录密码
          if (password) {
            aliyunLinkPasswords[baseURL] = password;
          } else {
            // 即使没有密码，也添加到映射中，以便后续处理
            if (!aliyunLinkPasswords[baseURL]) {
              aliyunLinkPasswords[baseURL] = '';
            }
          }
        } else {
          // 非特殊处理的网盘链接直接添加
          // 使用标准化的URL进行去重
          const normalizedLinkURL = normalizeUrl(linkURL);
          if (!foundLinks[normalizedLinkURL]) {
            foundLinks[normalizedLinkURL] = true;
            links.push({
              type: linkType,
              url: normalizedLinkURL,  // 使用标准化的URL
              password,
            });
          }
        }
      }
      
      // 4. 处理百度网盘链接，确保每个链接只有一个版本（带密码的完整版本）
      for (const [baseURL, password] of Object.entries(baiduLinkPasswords)) {
        const normalizedURL = normalizeBaiduPanURL(baseURL, password);
        
        // 确保链接不重复
        if (!foundLinks[normalizedURL]) {
          foundLinks[normalizedURL] = true;
          links.push({
            type: 'baidu',
            url: normalizedURL,
            password,
          });
        }
      }
      
      // 5. 处理天翼云盘链接，确保每个链接只有一个版本
      for (const [baseURL, password] of Object.entries(tianyiLinkPasswords)) {
        const normalizedURL = normalizeTianyiPanURL(baseURL, password);
        
        // 确保链接不重复
        if (!foundLinks[normalizedURL]) {
          foundLinks[normalizedURL] = true;
          links.push({
            type: 'tianyi',
            url: normalizedURL,
            password,
          });
        }
      }
      
      // 6. 处理UC网盘链接，确保每个链接只有一个版本
      for (const [baseURL, password] of Object.entries(ucLinkPasswords)) {
        const normalizedURL = normalizeUCPanURL(baseURL, password);
        
        // 确保链接不重复
        if (!foundLinks[normalizedURL]) {
          foundLinks[normalizedURL] = true;
          links.push({
            type: 'uc',
            url: normalizedURL,
            password,
          });
        }
      }
      
      // 7. 处理123网盘链接，确保每个链接只有一个版本
      for (const [baseURL, password] of Object.entries(pan123LinkPasswords)) {
        const normalizedURL = normalize123PanURL(baseURL, password);
        
        // 确保链接不重复
        if (!foundLinks[normalizedURL]) {
          foundLinks[normalizedURL] = true;
          links.push({
            type: '123',
            url: normalizedURL,
            password,
          });
        }
      }
      
      // 8. 处理115网盘链接，确保每个链接只有一个版本
      for (const [baseURL, password] of Object.entries(pan115LinkPasswords)) {
        const normalizedURL = normalize115PanURL(baseURL, password);
        
        // 确保链接不重复
        if (!foundLinks[normalizedURL]) {
          foundLinks[normalizedURL] = true;
          links.push({
            type: '115',
            url: normalizedURL,
            password,
          });
        }
      }
      
      // 9. 处理阿里云盘链接，确保每个链接只有一个版本
      for (const [baseURL, password] of Object.entries(aliyunLinkPasswords)) {
        const normalizedURL = cleanAliyunPanURL(baseURL); // 阿里云盘URL通常不包含密码参数
        
        // 确保链接不重复
        if (!foundLinks[normalizedURL]) {
          foundLinks[normalizedURL] = true;
          links.push({
            type: 'aliyun',
            url: normalizedURL,
            password,
          });
        }
      }
      
      // 提取标签
      const tags: string[] = [];
      messageTextElem.find("a[href^='?q=%23']").each((i, aElement) => {
        const tag = $(aElement).text();
        if (tag.startsWith('#')) {
          tags.push(tag.substring(1));
        }
      });
      
      // 提取图片链接（只从消息内容区域提取，排除用户头像）
      const images: string[] = [];
      const foundImages: Record<string, boolean> = {}; // 用于去重
      
      // 获取消息气泡区域，排除用户头像区域
      const messageBubble = messageDiv.find('.tgme_widget_message_bubble');
      
      // 1. 从消息内容中的图片包装元素提取图片
      messageBubble.find('.tgme_widget_message_photo_wrap').each((i, photoWrap) => {
        // 检查style属性中的background-image
        const style = $(photoWrap).attr('style');
        if (style) {
          const imageURL = extractImageURLFromStyle(style);
          if (imageURL && !foundImages[imageURL]) {
            foundImages[imageURL] = true;
            images.push(imageURL);
          }
        }
      });
      
      // 2. 从消息内容中的其他可能包含图片的元素提取（排除用户头像）
      messageBubble.find('img').each((i, imgElement) => {
        const src = $(imgElement).attr('src');
        if (src && !foundImages[src]) {
          foundImages[src] = true;
          images.push(src);
        }
      });
      
      // 只有包含链接的消息才添加到结果中
      if (links.length > 0) {
        // 为每个链接提取作品标题
        const linksWithWorkTitle = extractWorkTitlesForLinks(links, messageText, title);
        
        results.push({
          messageId: messageID,
          uniqueId: uniqueID,
          channel,
          datetime: datetime.toISOString(),
          title,
          content: messageText,
          links: linksWithWorkTitle,
          tags,
          images,
        });
      }
    });

    return { results, nextPageParam };
  } catch (error) {
    return { results: [], nextPageParam: '', error: error instanceof Error ? error.message : '未知错误' };
  }
}
