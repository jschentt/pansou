// 通用网盘链接匹配正则表达式 - 修改为更精确的匹配模式
export const AllPanLinksPattern = new RegExp('(?i)(?:(?:magnet:\?xt=urn:btih:[a-zA-Z0-9]+)|(?:ed2k://\|file\|[^|]+\|\d+\|[A-Fa-f0-9]+\|/?)|(?:https?://(?:(?:[\w.-]+\.)?(?:pan\.(?:baidu|quark)\.cn|(?:www\.)?(?:alipan|aliyundrive)\.com|drive\.uc\.cn|cloud\.189\.cn|caiyun\.139\.com|(?:www\.)?123(?:684|685|912|pan|592)\.(?:com|cn)|115\.com|115cdn\.com|anxia\.com|pan\.xunlei\.com|mypikpak\.com))(?:/[^\s'"<>()]*)?))', 'g');

// 单独定义各种网盘的链接匹配模式，以便更精确地提取
// 修改百度网盘链接正则表达式，确保只匹配到链接本身，不包含后面的文本
export const BaiduPanPattern = new RegExp('https?://pan\.baidu\.com/s/[a-zA-Z0-9_-]+(?:\?pwd=[a-zA-Z0-9]{4})?', 'g');
export const QuarkPanPattern = new RegExp('https?://pan\.quark\.cn/s/[a-zA-Z0-9]+', 'g');
export const XunleiPanPattern = new RegExp('https?://pan\.xunlei\.com/s/[a-zA-Z0-9]+(?:\?pwd=[a-zA-Z0-9]{4})?(?:#)?', 'g');
// 添加天翼云盘链接正则表达式 - 精确匹配，支持URL编码的访问码
export const TianyiPanPattern = new RegExp('https?://cloud\.189\.cn/t/[a-zA-Z0-9]+(?:%[0-9A-Fa-f]{2})*(?:（[^）]*）)?', 'g');
// 添加UC网盘链接正则表达式
export const UCPanPattern = new RegExp('https?://drive\.uc\.cn/s/[a-zA-Z0-9]+(?:\?public=\d)?', 'g');
// 添加123网盘链接正则表达式
export const Pan123Pattern = new RegExp('https?://(?:www\.)?123(?:684|865|685|912|pan|592)\.(?:com|cn)/s/[a-zA-Z0-9_-]+(?:\?(?:%E6%8F%90%E5%8F%96%E7%A0%81|提取码)[:：][a-zA-Z0-9]+)?', 'g');
// 添加115网盘链接正则表达式
export const Pan115Pattern = new RegExp('https?://(?:115\.com|115cdn\.com|anxia\.com)/s/[a-zA-Z0-9]+(?:\?password=[a-zA-Z0-9]{4})?(?:#)?', 'g');
// 添加阿里云盘链接正则表达式
export const AliyunPanPattern = new RegExp('https?://(?:www\.)?(?:alipan|aliyundrive)\.com/s/[a-zA-Z0-9]+', 'g');

// 提取码匹配正则表达式 - 增强提取密码的能力
export const PasswordPattern = new RegExp('(?i)(?:(?:提取|访问|提取密|密)码|pwd)[：:]\s*([a-zA-Z0-9]{4})(?:[^a-zA-Z0-9]|$)', 'g');
export const UrlPasswordPattern = new RegExp('(?i)[?&]pwd=([a-zA-Z0-9]{4})(?:[^a-zA-Z0-9]|$)', 'g');

// 百度网盘密码专用正则表达式 - 确保只提取4位密码
export const BaiduPasswordPattern = new RegExp('(?i)(?:链接：.*?提取码：|密码：|提取码：|pwd=|pwd:|pwd：)([a-zA-Z0-9]{4})(?:[^a-zA-Z0-9]|$)', 'g');

// GetLinkType 获取链接类型
export function GetLinkType(url: string): string {
  url = url.toLowerCase();
  
  // 处理可能带有"链接："前缀的情况
  if (url.includes('链接：') || url.includes('链接:')) {
    url = url.split('链接')[1];
    if (url.startsWith('：') || url.startsWith(':')) {
      url = url.substring(1);
    }
    url = url.trim();
  }
  
  // 根据关键词判断ed2k链接
  if (url.includes('ed2k:')) {
    return 'ed2k';
  }
  
  if (url.startsWith('magnet:')) {
    return 'magnet';
  }
  
  if (url.includes('pan.baidu.com')) {
    return 'baidu';
  }
  if (url.includes('pan.quark.cn')) {
    return 'quark';
  }
  if (url.includes('alipan.com') || url.includes('aliyundrive.com')) {
    return 'aliyun';
  }
  if (url.includes('cloud.189.cn')) {
    return 'tianyi';
  }
  if (url.includes('drive.uc.cn')) {
    return 'uc';
  }
  if (url.includes('caiyun.139.com')) {
    return 'mobile';
  }
  if (url.includes('115.com') || url.includes('115cdn.com') || url.includes('anxia.com')) {
    return '115';
  }
  if (url.includes('mypikpak.com')) {
    return 'pikpak';
  }
  if (url.includes('pan.xunlei.com')) {
    return 'xunlei';
  }
  
  // 123网盘有多个域名
  if (url.includes('123684.com') || url.includes('123685.com') || url.includes('123865.com') || 
     url.includes('123912.com') || url.includes('123pan.com') || 
     url.includes('123pan.cn') || url.includes('123592.com')) {
    return '123';
  }
  
  return 'others';
}

// CleanBaiduPanURL 清理百度网盘URL，确保链接格式正确
export function CleanBaiduPanURL(url: string): string {
  // 如果URL包含"https://pan.baidu.com/s/"，提取出正确的链接部分
  if (url.includes('https://pan.baidu.com/s/')) {
    // 找到链接的起始位置
    const startIdx = url.indexOf('https://pan.baidu.com/s/');
    if (startIdx >= 0) {
      // 从起始位置开始提取
      url = url.substring(startIdx);
      
      // 查找可能的结束标记
      const endMarkers = [' ', '\n', '\t', '，', '。', '；', ';', '，', ',', '?pwd='];
      let minEndIdx = url.length;
      
      for (const marker of endMarkers) {
        const idx = url.indexOf(marker);
        if (idx > 0 && idx < minEndIdx) {
          minEndIdx = idx;
        }
      }
      
      // 如果找到了结束标记，截取到结束标记位置
      if (minEndIdx < url.length) {
        url = url.substring(0, minEndIdx);
      }
      
      // 特殊处理pwd参数，确保只保留4位密码
      if (url.includes('?pwd=')) {
        const pwdIdx = url.indexOf('?pwd=');
        if (pwdIdx >= 0 && url.length > pwdIdx + 5) { // ?pwd= 有5个字符
          // 只保留?pwd=后面的4位密码
          const pwdEndIdx = pwdIdx + 9; // ?pwd=xxxx 总共9个字符
          if (pwdEndIdx <= url.length) {
            return url.substring(0, pwdEndIdx);
          }
          // 如果剩余字符不足4位，返回所有可用字符
          return url;
        }
      }
    }
  }
  return url;
}

// CleanTianyiPanURL 清理天翼云盘URL，确保链接格式正确
export function CleanTianyiPanURL(url: string): string {
  // 如果URL包含"https://cloud.189.cn/t/"，提取出正确的链接部分
  if (url.includes('https://cloud.189.cn/t/')) {
    // 找到链接的起始位置
    const startIdx = url.indexOf('https://cloud.189.cn/t/');
    if (startIdx >= 0) {
      // 从起始位置开始提取
      url = url.substring(startIdx);
      
      // 查找可能的结束标记
      const endMarkers = [' ', '\n', '\t', '，', '。', '；', ';', '，', ',', '实时', '天翼', '更多'];
      let minEndIdx = url.length;
      
      for (const marker of endMarkers) {
        const idx = url.indexOf(marker);
        if (idx > 0 && idx < minEndIdx) {
          minEndIdx = idx;
        }
      }
      
      // 如果找到了结束标记，截取到结束标记位置
      if (minEndIdx < url.length) {
        url = url.substring(0, minEndIdx);
      }
      
      // 标准化URL：将URL编码转换为中文，用于去重
      try {
        url = decodeURIComponent(url);
      } catch (e) {
        // 忽略解码错误
      }
    }
  }
  return url;
}

// CleanUCPanURL 清理UC网盘URL，确保链接格式正确
export function CleanUCPanURL(url: string): string {
  // 如果URL包含"https://drive.uc.cn/s/"，提取出正确的链接部分
  if (url.includes('https://drive.uc.cn/s/')) {
    // 找到链接的起始位置
    const startIdx = url.indexOf('https://drive.uc.cn/s/');
    if (startIdx >= 0) {
      // 从起始位置开始提取
      url = url.substring(startIdx);
      
      // 查找可能的结束标记（包括常见的网盘名称，可能出现在链接后面）
      const endMarkers = [' ', '\n', '\t', '，', '。', '；', ';', '，', ',', '网盘', '123', '夸克', '阿里', '百度'];
      let minEndIdx = url.length;
      
      for (const marker of endMarkers) {
        const idx = url.indexOf(marker);
        if (idx > 0 && idx < minEndIdx) {
          minEndIdx = idx;
        }
      }
      
      // 如果找到了结束标记，截取到结束标记位置
      if (minEndIdx < url.length) {
        return url.substring(0, minEndIdx);
      }
      
      // 处理public参数
      if (url.includes('?public=')) {
        const publicIdx = url.indexOf('?public=');
        if (publicIdx > 0) {
          // 确保只保留?public=1这样的参数，不包含后面的文本
          if (publicIdx + 9 <= url.length) { // ?public=1 总共9个字符
            return url.substring(0, publicIdx + 9);
          }
          return url.substring(0, publicIdx + 8); // 如果参数不完整，至少保留?public=
        }
      }
    }
  }
  return url;
}

// Clean123PanURL 清理123网盘URL，确保链接格式正确
export function Clean123PanURL(url: string): string {
  // 检查是否为123网盘链接
  const domains = ['123684.com', '123685.com','123865.com', '123912.com', '123pan.com', '123pan.cn', '123592.com'];
  let isDomain123 = false;
  
  for (const domain of domains) {
    if (url.includes(domain + '/s/')) {
      isDomain123 = true;
      break;
    }
  }
  
  if (isDomain123) {
    // 确保链接有协议头
    const hasProtocol = url.startsWith('http://') || url.startsWith('https://');
    
    // 找到链接的起始位置
    let startIdx = -1;
    for (const domain of domains) {
      const idx = url.indexOf(domain + '/s/');
      if (idx >= 0) {
        startIdx = idx;
        break;
      }
    }
    
    if (startIdx >= 0) {
      // 如果链接没有协议头，添加协议头
      if (!hasProtocol) {
        // 提取链接部分
        const linkPart = url.substring(startIdx);
        // 添加协议头
        url = 'https://' + linkPart;
      } else if (startIdx > 0) {
        // 如果链接有协议头，但可能包含前缀文本，提取完整URL
        const protocolIdx = url.indexOf('://');
        if (protocolIdx >= 0) {
          const protocol = url.substring(0, protocolIdx + 3);
          url = protocol + url.substring(startIdx);
        }
      }
      
      // 保留提取码参数，但需要处理可能的表情符号和其他无关文本
      // 查找可能的结束标记（表情符号、标签标识等）
      // 注意：我们不再将"提取码"作为结束标记，因为它是URL的一部分
      const endMarkers = [' ', '\n', '\t', '，', '。', '；', ';', '，', ',', '📁', '🔍', '标签', '🏷', '📎', '🔗', '📌', '📋', '📂', '🗂️', '🔖', '📚', '📒', '📔', '📕', '📓', '📗', '📘', '📙', '📄', '📃', '📑', '🧾', '📊', '📈', '📉', '🗒️', '🗓️', '📆', '📅', '🗑️', '🔒', '🔓', '🔏', '🔐', '🔑', '🗝️'];
      let minEndIdx = url.length;
      
      for (const marker of endMarkers) {
        const idx = url.indexOf(marker);
        if (idx > 0 && idx < minEndIdx) {
          minEndIdx = idx;
        }
      }
      
      // 如果找到了结束标记，截取到结束标记位置
      if (minEndIdx < url.length) {
        return url.substring(0, minEndIdx);
      }
      
      // 标准化URL编码的提取码，统一使用非编码形式
      if (url.includes('%E6%8F%90%E5%8F%96%E7%A0%81')) {
        url = url.replace('%E6%8F%90%E5%8F%96%E7%A0%81', '提取码');
      }
    }
  }
  return url;
}

// Clean115PanURL 清理115网盘URL，确保链接格式正确
export function Clean115PanURL(url: string): string {
  // 检查是否为115网盘链接
  if (url.includes('115.com/s/') || url.includes('115cdn.com/s/') || url.includes('anxia.com/s/')) {
    // 找到链接的起始位置
    let startIdx = -1;
    if (url.includes('115.com/s/')) {
      startIdx = url.indexOf('115.com/s/');
    } else if (url.includes('115cdn.com/s/')) {
      startIdx = url.indexOf('115cdn.com/s/');
    } else if (url.includes('anxia.com/s/')) {
      startIdx = url.indexOf('anxia.com/s/');
    }
    
    if (startIdx >= 0) {
      // 确保链接有协议头
      const hasProtocol = url.startsWith('http://') || url.startsWith('https://');
      
      // 如果链接没有协议头，添加协议头
      if (!hasProtocol) {
        // 提取链接部分
        const linkPart = url.substring(startIdx);
        // 添加协议头
        url = 'https://' + linkPart;
      } else if (startIdx > 0) {
        // 如果链接有协议头，但可能包含前缀文本，提取完整URL
        const protocolIdx = url.indexOf('://');
        if (protocolIdx >= 0) {
          const protocol = url.substring(0, protocolIdx + 3);
          url = protocol + url.substring(startIdx);
        }
      }
      
      // 如果链接包含password参数，确保只保留到password=xxxx部分（4位密码）
      if (url.includes('?password=')) {
        const pwdIdx = url.indexOf('?password=');
        if (pwdIdx > 0 && pwdIdx + 14 <= url.length) { // ?password=xxxx 总共14个字符
          // 截取到密码后面4位
          url = url.substring(0, pwdIdx + 14);
          return url;
        }
      }
      
      // 如果链接包含#，截取到#位置
      const hashIdx = url.indexOf('#');
      if (hashIdx > 0) {
        url = url.substring(0, hashIdx);
        return url;
      }
    }
  }
  return url;
}

// CleanAliyunPanURL 清理阿里云盘URL，确保链接格式正确
export function CleanAliyunPanURL(url: string): string {
  // 如果URL包含阿里云盘域名，提取出正确的链接部分
  if (url.includes('alipan.com/s/') || url.includes('aliyundrive.com/s/')) {
    // 找到链接的起始位置和域名部分
    let startIdx = -1;
    
    if (url.includes('www.alipan.com/s/')) {
      startIdx = url.indexOf('www.alipan.com/s/');
    } else if (url.includes('alipan.com/s/')) {
      startIdx = url.indexOf('alipan.com/s/');
    } else if (url.includes('www.aliyundrive.com/s/')) {
      startIdx = url.indexOf('www.aliyundrive.com/s/');
    } else if (url.includes('aliyundrive.com/s/')) {
      startIdx = url.indexOf('aliyundrive.com/s/');
    }
    
    if (startIdx >= 0) {
      // 确保链接有协议头
      const hasProtocol = url.startsWith('http://') || url.startsWith('https://');
      
      // 如果链接没有协议头，添加协议头
      if (!hasProtocol) {
        // 提取链接部分
        const linkPart = url.substring(startIdx);
        // 添加协议头
        url = 'https://' + linkPart;
      } else if (startIdx > 0) {
        // 如果链接有协议头，但可能包含前缀文本，提取完整URL
        const protocolIdx = url.indexOf('://');
        if (protocolIdx >= 0) {
          const protocol = url.substring(0, protocolIdx + 3);
          url = protocol + url.substring(startIdx);
        }
      }
      
      // 查找可能的结束标记（表情符号、标签标识等）
      const endMarkers = [' ', '\n', '\t', '，', '。', '；', ';', '，', ',', '📁', '🔍', '标签', '🏷', '📎', '🔗', '📌', '📋', '📂', '🗂️', '🔖', '📚', '📒', '📔', '📕', '📓', '📗', '📘', '📙', '📄', '📃', '📑', '🧾', '📊', '📈', '📉', '🗒️', '🗓️', '📆', '📅', '🗑️', '🔒', '🔓', '🔏', '🔐', '🔑', '🗝️'];
      let minEndIdx = url.length;
      
      for (const marker of endMarkers) {
        const idx = url.indexOf(marker);
        if (idx > 0 && idx < minEndIdx) {
          minEndIdx = idx;
        }
      }
      
      // 如果找到了结束标记，截取到结束标记位置
      if (minEndIdx < url.length) {
        return url.substring(0, minEndIdx);
      }
    }
  }
  return url;
}

// normalizeAliyunPanURL 标准化阿里云盘URL，确保链接格式正确
export function normalizeAliyunPanURL(url: string, password: string): string {
  // 清理URL，确保获取正确的链接部分
  url = CleanAliyunPanURL(url);
  
  // 阿里云盘链接通常不在URL中包含密码参数
  // 但是我们确保返回的是干净的链接
  return url;
}

// isValidPassword 检查提取码是否有效（只包含字母和数字）
export function isValidPassword(password: string): boolean {
  for (const c of password) {
    if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z'))) {
      return false;
    }
  }
  return true;
}

// ExtractPassword 提取链接密码
export function ExtractPassword(content: string, url: string): string {
  // 特殊处理天翼云盘URL中的访问码
  if (url.includes('cloud.189.cn')) {
    // 天翼云盘访问码格式：（访问码：xxxx）或者URL编码形式
    const tianyiPasswordPattern = new RegExp('(?:（访问码：|%EF%BC%88%E8%AE%BF%E9%97%AE%E7%A0%81%EF%BC%9A)([a-zA-Z0-9]+)(?:）|%EF%BC%89)', 'g');
    const tianyiMatches = tianyiPasswordPattern.exec(url);
    if (tianyiMatches && tianyiMatches.length > 1) {
      return tianyiMatches[1];
    }
  }
  
  // 特殊处理迅雷网盘URL中的pwd参数
  if (url.includes('pan.xunlei.com') && url.includes('?pwd=')) {
    const pwdPattern = new RegExp('\?pwd=([a-zA-Z0-9]{4})', 'g');
    const pwdMatches = pwdPattern.exec(url);
    if (pwdMatches && pwdMatches.length > 1) {
      return pwdMatches[1];
    }
  }
  
  // 先从URL中提取密码
  const urlPasswordPattern = new RegExp('(?i)[?&]pwd=([a-zA-Z0-9]{4})(?:[^a-zA-Z0-9]|$)', 'g');
  let matches = urlPasswordPattern.exec(url);
  if (matches && matches.length > 1) {
    return matches[1];
  }
  
  // 特殊处理115网盘URL中的密码
  if ((url.includes('115.com') || 
      url.includes('115cdn.com') || 
      url.includes('anxia.com')) && 
      url.includes('password=')) {
    
    // 尝试从URL中提取密码
    const passwordPattern = new RegExp('password=([a-zA-Z0-9]{4})', 'g');
    const passwordMatches = passwordPattern.exec(url);
    if (passwordMatches && passwordMatches.length > 1) {
      return passwordMatches[1];
    }
  }
  
  // 特殊处理123网盘URL中的提取码
  if ((url.includes('123684.com') || 
      url.includes('123685.com') || 
      url.includes('123865.com') || 
      url.includes('123912.com') || 
      url.includes('123pan.com') || 
      url.includes('123pan.cn') || 
      url.includes('123592.com')) && 
      (url.includes('提取码') || url.includes('%E6%8F%90%E5%8F%96%E7%A0%81'))) {
    
    // 尝试从URL中提取提取码（处理普通文本和URL编码两种情况）
    const extractCodePattern = new RegExp('(?:提取码|%E6%8F%90%E5%8F%96%E7%A0%81)[:：]([a-zA-Z0-9]+)', 'g');
    const codeMatches = extractCodePattern.exec(url);
    if (codeMatches && codeMatches.length > 1) {
      return codeMatches[1];
    }
  }
  
  // 检查123网盘URL中的提取码参数
  if ((url.includes('123684.com') || 
      url.includes('123685.com') || 
      url.includes('123865.com') || 
      url.includes('123912.com') || 
      url.includes('123pan.com') || 
      url.includes('123pan.cn') || 
      url.includes('123592.com')) && 
      url.includes('提取码')) {
    
    // 尝试从URL中提取提取码
    const parts = url.split('提取码');
    if (parts.length > 1) {
      // 提取码通常跟在冒号后面
      const part = parts[1];
      const codeStart = part.search(/[:：]/);
      if (codeStart >= 0 && codeStart + 1 < part.length) {
        // 提取冒号后面的内容，去除空格
        let code = part.substring(codeStart + 1).trim();
        
        // 如果提取码后面有其他字符（如表情符号、标签等），只取提取码部分
        // 增加更多可能的结束标记
        const endIdx = code.search(/[ \t\n\r，。；;,🏷📁🔍📎🔗📌📋📂🗂️🔖📚📒📔📕📓📗📘📙📄📃📑🧾📊📈📉🗒️🗓️📆📅🗑️🔒🔓🔏🔐🔑🗝️]/);
        if (endIdx > 0) {
          code = code.substring(0, endIdx);
        }
        
        // 去除可能的空格和其他无关字符
        code = code.trim();
        
        // 确保提取码是有效的（通常是4位字母数字）
        if (code.length > 0 && code.length <= 6 && isValidPassword(code)) {
          return code;
        }
      }
    }
  }
  
  // 检查内容中是否包含"提取码"字样
  if (content.includes('提取码')) {
    // 尝试从内容中提取提取码
    const parts = content.split('提取码');
    for (const part of parts) {
      if (part.length > 0) {
        // 提取码通常跟在冒号后面
        const codeStart = part.search(/[:：]/);
        if (codeStart >= 0 && codeStart + 1 < part.length) {
          // 提取冒号后面的内容，去除空格
          let code = part.substring(codeStart + 1).trim();
          
          // 如果提取码后面有其他字符，只取提取码部分
          const endIdx = code.search(/[ \t\n\r，。；;,🏷📁🔍📎🔗📌📋📂🗂️🔖📚📒📔📕📓📗📘📙📄📃📑🧾📊📈📉🗒️🗓️📆📅🗑️🔒🔓🔏🔐🔑🗝️]/);
          if (endIdx > 0) {
            code = code.substring(0, endIdx);
          } else {
            // 如果没有明显的结束标记，假设提取码是4-6位字符
            if (code.length > 6) {
              // 检查前4-6位是否是有效的提取码
              let foundValid = false;
              for (let i = 4; i <= 6 && i <= code.length; i++) {
                if (isValidPassword(code.substring(0, i))) {
                  code = code.substring(0, i);
                  foundValid = true;
                  break;
                }
              }
              // 如果没有找到有效的提取码，取前4位
              if (!foundValid && code.length > 6) {
                code = code.substring(0, 4);
              }
            }
          }
          
          // 去除可能的空格和其他无关字符
          code = code.trim();
          
          // 如果提取码不为空且是有效的，返回
          if (code !== '' && isValidPassword(code)) {
            return code;
          }
        }
      }
    }
  }
  
  // 再从内容中提取密码
  // 对于百度网盘链接，尝试查找特定格式的密码
  if (url.toLowerCase().includes('pan.baidu.com')) {
    // 尝试匹配百度网盘特定格式的密码
    const baiduPasswordPattern = new RegExp('(?i)(?:链接：.*?提取码：|密码：|提取码：|pwd=|pwd:|pwd：)([a-zA-Z0-9]{4})(?:[^a-zA-Z0-9]|$)', 'g');
    const baiduMatches = baiduPasswordPattern.exec(content);
    if (baiduMatches && baiduMatches.length > 1) {
      return baiduMatches[1];
    }
  }
  
  // 通用密码提取
  const passwordPattern = new RegExp('(?i)(?:(?:提取|访问|提取密|密)码|pwd)[：:]\s*([a-zA-Z0-9]{4})(?:[^a-zA-Z0-9]|$)', 'g');
  matches = passwordPattern.exec(content);
  if (matches && matches.length > 1) {
    return matches[1];
  }
  
  return '';
}

// normalizeURLForComparison 标准化URL以便于比较
// 移除协议头，标准化提取码，保留完整域名用于比较
export function normalizeURLForComparison(url: string): string {
  // 移除协议头
  const protocolIdx = url.indexOf('://');
  if (protocolIdx >= 0) {
    url = url.substring(protocolIdx + 3);
  }
  
  // 标准化URL编码的提取码，统一使用非编码形式
  if (url.includes('%E6%8F%90%E5%8F%96%E7%A0%81')) {
    url = url.replace('%E6%8F%90%E5%8F%96%E7%A0%81', '提取码');
  }
  
  return url;
}

// ExtractNetDiskLinks 从文本中提取所有网盘链接
export function ExtractNetDiskLinks(text: string): string[] {
  const links: string[] = [];
  
  // 提取百度网盘链接
  const baiduMatches = text.match(BaiduPanPattern);
  if (baiduMatches) {
    for (const match of baiduMatches) {
      // 清理并添加百度网盘链接
      const cleanURL = CleanBaiduPanURL(match);
      // 确保链接末尾不包含https
      let finalURL = cleanURL;
      if (finalURL.endsWith('https')) {
        finalURL = finalURL.substring(0, finalURL.length - 5);
      }
      if (finalURL !== '') {
        links.push(finalURL);
      }
    }
  }
  
  // 提取天翼云盘链接
  const tianyiMatches = text.match(TianyiPanPattern);
  if (tianyiMatches) {
    for (const match of tianyiMatches) {
      // 清理并添加天翼云盘链接
      const cleanURL = CleanTianyiPanURL(match);
      // 确保链接末尾不包含https
      let finalURL = cleanURL;
      if (finalURL.endsWith('https')) {
        finalURL = finalURL.substring(0, finalURL.length - 5);
      }
      if (finalURL !== '') {
        links.push(finalURL);
      }
    }
  }
  
  // 提取UC网盘链接
  const ucMatches = text.match(UCPanPattern);
  if (ucMatches) {
    for (const match of ucMatches) {
      // 清理并添加UC网盘链接
      const cleanURL = CleanUCPanURL(match);
      // 确保链接末尾不包含https
      let finalURL = cleanURL;
      if (finalURL.endsWith('https')) {
        finalURL = finalURL.substring(0, finalURL.length - 5);
      }
      if (finalURL !== '') {
        links.push(finalURL);
      }
    }
  }
  
  // 提取123网盘链接
  const pan123Matches = text.match(Pan123Pattern);
  if (pan123Matches) {
    for (const match of pan123Matches) {
      // 清理并添加123网盘链接
      const cleanURL = Clean123PanURL(match);
      // 确保链接末尾不包含https
      let finalURL = cleanURL;
      if (finalURL.endsWith('https')) {
        finalURL = finalURL.substring(0, finalURL.length - 5);
      }
      if (finalURL !== '') {
        // 检查是否已经存在相同的链接（比较完整URL）
        let isDuplicate = false;
        for (const existingLink of links) {
          // 标准化链接以进行比较（仅移除协议）
          const normalizedExisting = normalizeURLForComparison(existingLink);
          const normalizedNew = normalizeURLForComparison(finalURL);
          
          if (normalizedExisting === normalizedNew) {
            isDuplicate = true;
            break;
          }
        }
        
        if (!isDuplicate) {
          links.push(finalURL);
        }
      }
    }
  }
  
  // 提取115网盘链接
  const pan115Matches = text.match(Pan115Pattern);
  if (pan115Matches) {
    for (const match of pan115Matches) {
      // 清理并添加115网盘链接
      const cleanURL = Clean115PanURL(match); // 115网盘链接的清理逻辑与123网盘类似
      // 确保链接末尾不包含https
      let finalURL = cleanURL;
      if (finalURL.endsWith('https')) {
        finalURL = finalURL.substring(0, finalURL.length - 5);
      }
      if (finalURL !== '') {
        // 检查是否已经存在相同的链接（比较完整URL）
        let isDuplicate = false;
        for (const existingLink of links) {
          const normalizedExisting = normalizeURLForComparison(existingLink);
          const normalizedNew = normalizeURLForComparison(finalURL);
          
          if (normalizedExisting === normalizedNew) {
            isDuplicate = true;
            break;
          }
        }
        
        if (!isDuplicate) {
          links.push(finalURL);
        }
      }
    }
  }
  
  // 提取阿里云盘链接
  const aliyunMatches = text.match(AliyunPanPattern);
  if (aliyunMatches) {
    for (const match of aliyunMatches) {
      // 清理并添加阿里云盘链接
      const cleanURL = CleanAliyunPanURL(match);
      // 确保链接末尾不包含https
      let finalURL = cleanURL;
      if (finalURL.endsWith('https')) {
        finalURL = finalURL.substring(0, finalURL.length - 5);
      }
      if (finalURL !== '') {
        // 检查是否已经存在相同的链接
        let isDuplicate = false;
        for (const existingLink of links) {
          const normalizedExisting = normalizeURLForComparison(existingLink);
          const normalizedNew = normalizeURLForComparison(finalURL);
          
          if (normalizedExisting === normalizedNew) {
            isDuplicate = true;
            break;
          }
        }
        
        if (!isDuplicate) {
          links.push(finalURL);
        }
      }
    }
  }
  
  // 提取夸克网盘链接
  const quarkLinks = text.match(QuarkPanPattern);
  if (quarkLinks) {
    for (const match of quarkLinks) {
      // 确保链接末尾不包含https
      let cleanURL = match;
      if (cleanURL.endsWith('https')) {
        cleanURL = cleanURL.substring(0, cleanURL.length - 5);
      }
      // 检查是否已经存在相同的链接
      let isDuplicate = false;
      for (const existingLink of links) {
        if (existingLink.includes(cleanURL) || cleanURL.includes(existingLink)) {
          isDuplicate = true;
          break;
        }
      }
      
      if (!isDuplicate) {
        links.push(cleanURL);
      }
    }
  }
  
  // 提取迅雷网盘链接
  const xunleiLinks = text.match(XunleiPanPattern);
  if (xunleiLinks) {
    for (const match of xunleiLinks) {
      // 确保链接末尾不包含https
      let cleanURL = match;
      if (cleanURL.endsWith('https')) {
        cleanURL = cleanURL.substring(0, cleanURL.length - 5);
      }
      // 检查是否已经存在相同的链接
      let isDuplicate = false;
      for (const existingLink of links) {
        if (existingLink.includes(cleanURL) || cleanURL.includes(existingLink)) {
          isDuplicate = true;
          break;
        }
      }
      
      if (!isDuplicate) {
        links.push(cleanURL);
      }
    }
  }
  
  // 使用通用模式提取其他可能的链接
  const otherLinks = text.match(AllPanLinksPattern);
  if (otherLinks) {
    // 过滤掉已经添加过的链接
    for (const link of otherLinks) {
      // 确保链接末尾不包含https
      let cleanURL = link;
      if (cleanURL.endsWith('https')) {
        cleanURL = cleanURL.substring(0, cleanURL.length - 5);
      }
      // 跳过百度、夸克、迅雷、天翼、UC和123网盘链接，因为已经单独处理过
      if (cleanURL.includes('pan.baidu.com') || 
         cleanURL.includes('pan.quark.cn') || 
         cleanURL.includes('pan.xunlei.com') ||
         cleanURL.includes('cloud.189.cn') ||
         cleanURL.includes('drive.uc.cn') ||
         cleanURL.includes('123684.com') ||
         cleanURL.includes('123685.com') ||
         cleanURL.includes('123865.com') ||
         cleanURL.includes('123912.com') ||
         cleanURL.includes('123pan.com') ||
         cleanURL.includes('123pan.cn') ||
         cleanURL.includes('123592.com')) {
        continue;
      }
      
      let isDuplicate = false;
      for (const existingLink of links) {
        const normalizedExisting = normalizeURLForComparison(existingLink);
        const normalizedNew = normalizeURLForComparison(cleanURL);
        
        // 使用完整URL比较，包括www.前缀
        if (normalizedExisting === normalizedNew || 
           normalizedExisting.includes(normalizedNew) || 
           normalizedNew.includes(normalizedExisting)) {
          isDuplicate = true;
          break;
        }
      }
      
      if (!isDuplicate) {
        links.push(cleanURL);
      }
    }
  }
  
  return links;
}
