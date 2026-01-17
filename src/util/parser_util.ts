import * as cheerio from 'cheerio';
import { Link, SearchResult } from '../models/response';
import {
  AllPanLinksPattern,
  BaiduPanPattern,
  TianyiPanPattern,
  UCPanPattern,
  Pan123Pattern,
  QuarkPanPattern,
  XunleiPanPattern,
  Pan115Pattern,
  ExtractNetDiskLinks,
  ExtractPassword,
  GetLinkType,
  CleanBaiduPanURL,
  CleanTianyiPanURL,
  CleanUCPanURL,
  Clean123PanURL,
  Clean115PanURL,
  CleanAliyunPanURL
} from './regex_util';

// 标准化URL，将URL编码的中文部分解码为中文，用于去重
export function normalizeUrl(rawUrl: string): string {
  try {
    // 解码URL中的编码字符
    const decoded = decodeURIComponent(rawUrl);
    return decoded;
  } catch (error) {
    // 如果解码失败，返回原始URL
    return rawUrl;
  }
}

// 检查链接是否为支持的网盘链接
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

// 标准化百度网盘URL，确保链接格式正确并且包含密码参数
export function normalizeBaiduPanURL(url: string, password: string): string {
  // 清理URL，确保获取正确的链接部分
  url = CleanBaiduPanURL(url);
  
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
    return url + '?pwd=' + password;
  }
  
  return url;
}

// 标准化天翼云盘URL，确保链接格式正确
export function normalizeTianyiPanURL(url: string, password: string): string {
  // 清理URL，确保获取正确的链接部分
  url = CleanTianyiPanURL(url);
  
  // 天翼云盘链接通常不在URL中包含密码参数，所以这里不做处理
  // 但是我们确保返回的是干净的链接
  return url;
}

// 标准化UC网盘URL，确保链接格式正确
export function normalizeUCPanURL(url: string, password: string): string {
  // 清理URL，确保获取正确的链接部分
  url = CleanUCPanURL(url);
  
  // UC网盘链接通常使用?public=1参数表示公开分享
  // 确保链接格式正确，但不添加密码参数
  return url;
}

// 标准化123网盘URL，确保链接格式正确
export function normalize123PanURL(url: string, password: string): string {
  // 清理URL，确保获取正确的链接部分
  url = Clean123PanURL(url);
  
  // 123网盘链接通常不在URL中包含密码参数
  // 但是我们确保返回的是干净的链接
  return url;
}

// 标准化115网盘URL，确保链接格式正确
export function normalize115PanURL(url: string, password: string): string {
  // 清理URL，确保获取正确的链接部分，只保留到password=后面4位密码
  url = Clean115PanURL(url);
  
  // 115网盘链接已经在Clean115PanURL中处理了密码部分
  // 这里不需要额外添加密码参数
  return url;
}

// 解析搜索结果页面
export function parseSearchResults(html: string, channel: string): { results: SearchResult[]; nextPageParam: string } {
  const $ = cheerio.load(html);

  const results: SearchResult[] = [];
  let nextPageParam: string = '';

  // 查找消息块
  $('.tgme_widget_message_wrap').each((i, s) => {
    const messageDiv = $(s).find('.tgme_widget_message');
    
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
    const uniqueID = channel + '_' + messageID;
    
    // 提取时间
    const timeStr = messageDiv.find('.tgme_widget_message_date time').attr('datetime');
    if (!timeStr) {
      return;
    }
    
    const datetime = new Date(timeStr);
    
    // 获取消息文本元素
    const messageTextElem = messageDiv.find('.tgme_widget_message_text');
    
    // 获取消息文本的HTML内容
    const messageHTML = messageTextElem.html() || '';
    
    // 获取消息的纯文本内容
    const messageText = messageTextElem.text();
    
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
    const extractedLinks = ExtractNetDiskLinks(messageText);
    
    // 2. 从a标签中提取链接
    messageTextElem.find('a').each((i, a) => {
      const href = $(a).attr('href');
      if (!href) {
        return;
      }
      
      // 使用更精确的方式匹配网盘链接
      if (isSupportedLink(href)) {
        const linkType = GetLinkType(href);
        const password = ExtractPassword(messageText, href);
        
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
          const baseURL = CleanTianyiPanURL(href);
          
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
          const baseURL = CleanUCPanURL(href);
          
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
          const baseURL = Clean123PanURL(href);
          
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
          const baseURL = Clean115PanURL(href);
          
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
          const baseURL = CleanAliyunPanURL(href);
          
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
              password: password,
              datetime: new Date().toISOString(),
              workTitle: ''
            });
          }
        }
      }
    });
    
    // 3. 处理从文本中提取的链接
    for (const linkURL of extractedLinks) {
      const linkType = GetLinkType(linkURL);
      const password = ExtractPassword(messageText, linkURL);
      
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
        const baseURL = CleanTianyiPanURL(linkURL);
        
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
        const baseURL = CleanUCPanURL(linkURL);
        
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
        const baseURL = Clean123PanURL(linkURL);
        
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
        const baseURL = Clean115PanURL(linkURL);
        
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
        const baseURL = CleanAliyunPanURL(linkURL);
        
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
            password: password,
            datetime: new Date().toISOString(),
            workTitle: ''
          });
        }
      }
    }
    
    // 4. 处理百度网盘链接，确保每个链接只有一个版本（带密码的完整版本）
    for (const baseURL in baiduLinkPasswords) {
      if (Object.prototype.hasOwnProperty.call(baiduLinkPasswords, baseURL)) {
        const password = baiduLinkPasswords[baseURL];
        const normalizedURL = normalizeBaiduPanURL(baseURL, password);
        
        // 确保链接不重复
        if (!foundLinks[normalizedURL]) {
          foundLinks[normalizedURL] = true;
          links.push({
            type: 'baidu',
            url: normalizedURL,
            password: password,
            datetime: new Date().toISOString(),
            workTitle: ''
          });
        }
      }
    }
    
    // 5. 处理天翼云盘链接，确保每个链接只有一个版本
    for (const baseURL in tianyiLinkPasswords) {
      if (Object.prototype.hasOwnProperty.call(tianyiLinkPasswords, baseURL)) {
        const password = tianyiLinkPasswords[baseURL];
        const normalizedURL = normalizeTianyiPanURL(baseURL, password);
        
        // 确保链接不重复
        if (!foundLinks[normalizedURL]) {
          foundLinks[normalizedURL] = true;
          links.push({
            type: 'tianyi',
            url: normalizedURL,
            password: password,
            datetime: new Date().toISOString(),
            workTitle: ''
          });
        }
      }
    }
    
    // 6. 处理UC网盘链接，确保每个链接只有一个版本
    for (const baseURL in ucLinkPasswords) {
      if (Object.prototype.hasOwnProperty.call(ucLinkPasswords, baseURL)) {
        const password = ucLinkPasswords[baseURL];
        const normalizedURL = normalizeUCPanURL(baseURL, password);
        
        // 确保链接不重复
        if (!foundLinks[normalizedURL]) {
          foundLinks[normalizedURL] = true;
          links.push({
            type: 'uc',
            url: normalizedURL,
            password: password,
            datetime: new Date().toISOString(),
            workTitle: ''
          });
        }
      }
    }
    
    // 7. 处理123网盘链接，确保每个链接只有一个版本
    for (const baseURL in pan123LinkPasswords) {
      if (Object.prototype.hasOwnProperty.call(pan123LinkPasswords, baseURL)) {
        const password = pan123LinkPasswords[baseURL];
        const normalizedURL = normalize123PanURL(baseURL, password);
        
        // 确保链接不重复
        if (!foundLinks[normalizedURL]) {
          foundLinks[normalizedURL] = true;
          links.push({
            type: '123',
            url: normalizedURL,
            password: password,
            datetime: new Date().toISOString(),
            workTitle: ''
          });
        }
      }
    }
    
    // 8. 处理115网盘链接，确保每个链接只有一个版本
    for (const baseURL in pan115LinkPasswords) {
      if (Object.prototype.hasOwnProperty.call(pan115LinkPasswords, baseURL)) {
        const password = pan115LinkPasswords[baseURL];
        const normalizedURL = normalize115PanURL(baseURL, password);
        
        // 确保链接不重复
        if (!foundLinks[normalizedURL]) {
          foundLinks[normalizedURL] = true;
          links.push({
            type: '115',
            url: normalizedURL,
            password: password,
            datetime: new Date().toISOString(),
            workTitle: ''
          });
        }
      }
    }
    
    // 9. 处理阿里云盘链接，确保每个链接只有一个版本
    for (const baseURL in aliyunLinkPasswords) {
      if (Object.prototype.hasOwnProperty.call(aliyunLinkPasswords, baseURL)) {
        const password = aliyunLinkPasswords[baseURL];
        const normalizedURL = CleanAliyunPanURL(baseURL); // 阿里云盘URL通常不包含密码参数
        
        // 确保链接不重复
        if (!foundLinks[normalizedURL]) {
          foundLinks[normalizedURL] = true;
          links.push({
            type: 'aliyun',
            url: normalizedURL,
            password: password,
            datetime: new Date().toISOString(),
            workTitle: ''
          });
        }
      }
    }
    
    // 提取标签
    const tags: string[] = [];
    messageTextElem.find('a[href^="?q=%23"]').each((i, a) => {
      const tag = $(a).text();
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
    messageBubble.find('img').each((i, img) => {
      const src = $(img).attr('src');
      if (src && !foundImages[src]) {
        foundImages[src] = true;
        images.push(src);
      }
    });
    
    // 只有包含链接的消息才添加到结果中
    if (links.length > 0) {
      // 为每个链接提取作品标题
      const linksWithWorkTitles = extractWorkTitlesForLinks(links, messageText, title);
      
      results.push({
        messageId: messageID,
        uniqueId: uniqueID,
        channel: channel,
        datetime: datetime.toISOString(),
        title: title,
        content: messageText,
        links: linksWithWorkTitles,
        tags: tags,
        images: images
      });
    }
  });

  return { results, nextPageParam };
}

// CutTitleByKeywords 根据关键词进行裁剪，保留最前关键词前的部分
export function CutTitleByKeywords(title: string, keywords: string[]): string {
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
  let startPattern = "background-image:url('";
  let endPattern = "')";
  
  let startIndex = style.indexOf(startPattern);
  if (startIndex !== -1) {
    startIndex += startPattern.length;
    const endIndex = style.substring(startIndex).indexOf(endPattern);
    if (endIndex !== -1) {
      return style.substring(startIndex, startIndex + endIndex);
    }
  }
  
  // 尝试双引号格式
  startPattern = 'background-image:url("';
  endPattern = '")';
  
  startIndex = style.indexOf(startPattern);
  if (startIndex !== -1) {
    startIndex += startPattern.length;
    const endIndex = style.substring(startIndex).indexOf(endPattern);
    if (endIndex !== -1) {
      return style.substring(startIndex, startIndex + endIndex);
    }
  }
  
  // 尝试无引号格式
  startPattern = 'background-image:url(';
  endPattern = ')';
  
  startIndex = style.indexOf(startPattern);
  if (startIndex !== -1) {
    startIndex += startPattern.length;
    const endIndex = style.substring(startIndex).indexOf(endPattern);
    if (endIndex !== -1) {
      let url = style.substring(startIndex, startIndex + endIndex);
      // 移除可能的引号
      url = url.trim().replace(/^['"]|['"]$/g, '');
      return url;
    }
  }
  
  return '';
}

// extractTitle 从消息HTML和文本内容中提取标题
export function extractTitle(htmlContent: string, textContent: string): string {
  // 从HTML内容中提取标题
  const brIndex = htmlContent.indexOf('<br');
  if (brIndex > 0) {
    // 提取<br>前的HTML内容
    const firstLineHTML = htmlContent.substring(0, brIndex);
    
    try {
      // 创建一个文档来解析这个HTML片段
      const $ = cheerio.load('<div>' + firstLineHTML + '</div>');
      // 获取解析后的文本
      const firstLine = $('div').text().trim();
      
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
    } catch (error) {
      // 解析失败，继续从文本内容提取
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
        let result = secondLine;
        // 统一裁剪：遇到简介/描述等关键字时，只保留前半部分
        result = CutTitleByKeywords(result, ['简介', '描述']);
        return result;
      }
    }
  }
  
  // 如果第一行以"名称："开头，则提取冒号后面的内容作为标题
  if (firstLine.startsWith('名称：')) {
    return firstLine.substring('名称：'.length).trim();
  }
  
  // 否则直接使用第一行作为标题
  let result = firstLine;
  // 统一裁剪：遇到简介/描述等关键字时，只保留前半部分
  result = CutTitleByKeywords(result, ['简介', '描述']);
  return result;
}

// extractWorkTitlesForLinks 为每个链接提取作品标题
export function extractWorkTitlesForLinks(links: Link[], messageText: string, defaultTitle: string): Link[] {
  if (links.length === 0) {
    return links;
  }
  
  // 如果链接数量 <= 4，认为是同一个作品的不同网盘链接
  if (links.length <= 4) {
    return links.map(link => ({
      ...link,
      workTitle: defaultTitle
    }));
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

// isSingleLineFormat 检测是否是单行格式
export function isSingleLineFormat(lines: string[]): boolean {
  let singleLineCount = 0;
  for (const line of lines) {
    const trimmedLine = line.trim();
    if (trimmedLine === '') {
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

// extractWorkTitlesFromSingleLineFormat 从单行格式中提取作品标题
export function extractWorkTitlesFromSingleLineFormat(links: Link[], lines: string[], defaultTitle: string): Link[] {
  // 为每个链接构建URL到作品标题的映射
  const urlToWorkTitle: Record<string, string> = {};
  
  for (const line of lines) {
    const trimmedLine = line.trim();
    if (trimmedLine === '') {
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
        const httpIndex = restPart.indexOf('http');
        if (httpIndex >= 0) {
          linkURL = extractFirstURL(restPart.substring(httpIndex));
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
        const httpIndex = afterColon.indexOf('http');
        if (httpIndex >= 0) {
          linkURL = extractFirstURL(afterColon.substring(httpIndex));
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
    if (urlToWorkTitle[normalizedURL]) {
      return {
        ...link,
        workTitle: urlToWorkTitle[normalizedURL]
      };
    } else {
      return {
        ...link,
        workTitle: defaultTitle
      };
    }
  });
}

// extractFirstURL 从文本中提取第一个URL
export function extractFirstURL(text: string): string {
  // 提取到空格或换行符为止
  let endIdx = text.length;
  const spaceIdx = text.indexOf(' ');
  if (spaceIdx > 0 && spaceIdx < endIdx) {
    endIdx = spaceIdx;
  }
  const newLineIdx = text.indexOf('\n');
  if (newLineIdx > 0 && newLineIdx < endIdx) {
    endIdx = newLineIdx;
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
    '网盘', '云盘'
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

// extractWorkTitlesFromContext 通过上下文为链接提取作品标题
export function extractWorkTitlesFromContext(links: Link[], messageText: string, defaultTitle: string): Link[] {
  // 简单实现：如果无法精确匹配，则都使用默认标题
  return links.map(link => ({
    ...link,
    workTitle: defaultTitle
  }));
}