import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import { SearchResult, Link } from '../../models/plugin-result';
import { PluginManager } from '../plugin.manager';

const BaseURL = 'https://pan666.net/api/discussions';
const PageSize = 50;
const MaxRetries = 2;

const userAgents = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/92.0.4515.107 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.1.2 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:90.0) Gecko/20100101 Firefox/90.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.114 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/92.0.4515.107 Safari/537.36'
];

interface Pan666Post {
  id: string;
  attributes: {
    contentHtml: string;
  };
}

interface Pan666Discussion {
  id: string;
  attributes: {
    title: string;
    createdAt: string;
  };
  relationships: {
    mostRelevantPost: {
      data: {
        id: string;
      };
    };
  };
}

interface Pan666Response {
  data: Pan666Discussion[];
  included: Pan666Post[];
  links: {
    next: string;
  };
}

export class Pan666AsyncPlugin {
  private client: AxiosInstance;
  private retries: number;

  constructor() {
    this.client = axios.create({
      timeout: 10000
    });
    this.retries = MaxRetries;
  }

  public async search(keyword: string, ext: Record<string, any>): Promise<SearchResult[]> {
    try {
      const allResults = await this.fetchBatch(keyword, 0, 2);
      const uniqueResults = this.deduplicateResults(allResults);
      const filteredResults = this.filterResultsByKeyword(uniqueResults, keyword);

      return filteredResults;
    } catch (error) {
      console.error(`[pan666] 搜索失败: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }

  private async fetchBatch(keyword: string, startOffset: number, pageCount: number): Promise<SearchResult[]> {
    const promises: Promise<SearchResult[]>[] = [];

    for (let i = 0; i < pageCount; i++) {
      const offset = (startOffset + i) * PageSize;
      const delay = i > 0 ? Math.random() * 900 + 100 : 0;

      const promise = new Promise<SearchResult[]>((resolve) => {
        setTimeout(async () => {
          try {
            const results = await this.fetchPage(keyword, offset);
            resolve(results);
          } catch (error) {
            console.error(`[pan666] 页面请求失败: ${error instanceof Error ? error.message : String(error)}`);
            resolve([]);
          }
        }, delay);
      });

      promises.push(promise);
    }

    const resultsArray = await Promise.all(promises);
    return resultsArray.flat();
  }

  private deduplicateResults(results: SearchResult[]): SearchResult[] {
    const seen = new Set<string>();
    const unique: SearchResult[] = [];

    for (const result of results) {
      if (!seen.has(result.uniqueId)) {
        seen.add(result.uniqueId);
        unique.push(result);
      }
    }

    unique.sort((a, b) => {
      return b.datetime.getTime() - a.datetime.getTime();
    });

    return unique;
  }

  private async fetchPage(keyword: string, offset: number): Promise<SearchResult[]> {
    const apiURL = `${BaseURL}?filter[q]=${encodeURIComponent(keyword)}&include=mostRelevantPost&page[offset]=${offset}&page[limit]=${PageSize}`;

    let lastError: any;

    for (let i = 0; i <= this.retries; i++) {
      try {
        const resp = await this.client({
          url: apiURL,
          method: 'GET',
          headers: {
            'User-Agent': this.getRandomUA(),
            'X-Forwarded-For': this.generateRandomIP(),
            'Accept': 'application/json, text/plain, */*',
            'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
            'Connection': 'keep-alive',
            'Sec-Fetch-Dest': 'empty',
            'Sec-Fetch-Mode': 'cors',
            'Sec-Fetch-Site': 'same-origin'
          },
          timeout: 10000
        });

        if (resp.status !== 200) {
          throw new Error(`API返回非200状态码: ${resp.status}`);
        }

        const apiResp: Pan666Response = resp.data;
        const results: SearchResult[] = [];
        const postMap = new Map<string, Pan666Post>();

        for (const post of apiResp.included) {
          postMap.set(post.id, post);
        }

        for (const discussion of apiResp.data) {
          const postID = discussion.relationships.mostRelevantPost.data.id;
          const post = postMap.get(postID);
          if (!post) {
            continue;
          }

          const cleanedHTML = this.cleanHTML(post.attributes.contentHtml);
          const links = this.extractLinksFromText(cleanedHTML);

          if (links.length === 0) {
            continue;
          }

          let createdTime: Date;
          try {
            createdTime = new Date(discussion.attributes.createdAt);
          } catch {
            createdTime = new Date();
          }

          const uniqueID = `pan666-${discussion.id}`;
          const result: SearchResult = {
            uniqueId: uniqueID,
            title: discussion.attributes.title,
            content: cleanedHTML.substring(0, 200) + (cleanedHTML.length > 200 ? '...' : ''),
            links: links,
            tags: [],
            channel: '',
            datetime: createdTime,
            images: []
          };

          results.push(result);
        }

        return results;
      } catch (error) {
        lastError = error;
        if (i < this.retries) {
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }
    }

    throw lastError;
  }

  private extractLinksFromText(content: string): Link[] {
    const allLinks: Link[] = [];

    const baiduLinks = this.extractLinksByPattern(content, '链接: https://pan.baidu.com', '提取码:', 'baidu');
    allLinks.push(...baiduLinks);

    const aliyunLinks = this.extractLinksByPattern(content, 'https://www.aliyundrive.com/s/', '提取码:', 'aliyun');
    allLinks.push(...aliyunLinks);

    const tianyiLinks = this.extractLinksByPattern(content, 'https://cloud.189.cn', '访问码:', 'tianyi');
    allLinks.push(...tianyiLinks);

    if (allLinks.length === 0) {
      return this.extractLinksFromContent(content);
    }

    return allLinks;
  }

  private extractLinksFromContent(content: string): Link[] {
    const allLinks: Link[] = [];
    const lines = content.split('\n');

    const linkInfos: Array<{
      link: Link;
      position: number;
      category: string;
    }> = [];

    const passwordInfos: Array<{
      keyword: string;
      position: number;
      password: string;
    }> = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      if (line.includes('pan.baidu.com')) {
        const url = this.extractURLFromText(line);
        if (url) {
          linkInfos.push({
            link: { url, type: 'baidu', password: '' },
            position: i,
            category: 'baidu'
          });
        }
      }

      if (line.includes('aliyundrive.com')) {
        const url = this.extractURLFromText(line);
        if (url) {
          linkInfos.push({
            link: { url, type: 'aliyun', password: '' },
            position: i,
            category: 'aliyun'
          });
        }
      }

      if (line.includes('cloud.189.cn')) {
        const url = this.extractURLFromText(line);
        if (url) {
          linkInfos.push({
            link: { url, type: 'tianyi', password: '' },
            position: i,
            category: 'tianyi'
          });
        }
      }

      const passwordKeywords = ['提取码', '密码', '访问码'];
      for (const keyword of passwordKeywords) {
        if (line.includes(keyword)) {
          let colonPos = line.indexOf(':');
          if (colonPos === -1) {
            colonPos = line.indexOf('：');
          }

          if (colonPos !== -1 && colonPos + 1 < line.length) {
            const password = line.substring(colonPos + 1).trim();
            if (password.length <= 10) {
              passwordInfos.push({
                keyword,
                position: i,
                password
              });
            }
          }
        }
      }
    }

    for (const info of linkInfos) {
      let password = this.extractPasswordFromURL(info.link.url);
      if (password) {
        info.link.password = password;
        continue;
      }

      let minDistance = Infinity;
      let closestPassword = '';

      for (const pwInfo of passwordInfos) {
        let match = false;

        if (info.category === 'baidu' && (pwInfo.keyword === '提取码' || pwInfo.keyword === '密码')) {
          match = true;
        } else if (info.category === 'aliyun' && (pwInfo.keyword === '提取码' || pwInfo.keyword === '密码')) {
          match = true;
        } else if (info.category === 'tianyi' && (pwInfo.keyword === '访问码' || pwInfo.keyword === '密码')) {
          match = true;
        }

        if (match) {
          const distance = Math.abs(pwInfo.position - info.position);
          if (distance < minDistance) {
            minDistance = distance;
            closestPassword = pwInfo.password;
          }
        }
      }

      if (minDistance <= 3) {
        info.link.password = closestPassword;
      }
    }

    for (const info of linkInfos) {
      allLinks.push(info.link);
    }

    return allLinks;
  }

  private extractLinksByPattern(content: string, pattern: string, altPattern: string, linkType: string): Link[] {
    const links: Link[] = [];
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.includes(pattern)) {
        const link = this.extractLinkFromLine(line, pattern);

        if (link.password === '' && i + 1 < lines.length && lines[i + 1].includes(altPattern)) {
          const passwordLine = lines[i + 1];
          const start = passwordLine.indexOf(altPattern) + altPattern.length;
          if (start < passwordLine.length) {
            const password = passwordLine.substring(start).trim();
            link.password = password;
          }
        }

        link.type = linkType;
        links.push(link);
      }
    }

    return links;
  }

  private extractLinkFromLine(line: string, prefix: string): Link {
    const link: Link = { url: '', type: '', password: '' };

    const start = line.indexOf(prefix);
    if (start < 0) {
      return link;
    }

    let end = line.length;
    const possibleEnds = [' ', '提取码', '密码', '访问码'];
    for (const endStr of possibleEnds) {
      const pos = line.indexOf(endStr, start);
      if (pos > 0 && pos < end) {
        end = pos;
      }
    }

    const url = line.substring(start, end).trim();
    link.url = url;

    const passwordKeywords = ['提取码:', '密码:', '访问码:'];
    for (const keyword of passwordKeywords) {
      const passwordStart = line.indexOf(keyword);
      if (passwordStart >= 0) {
        const password = line.substring(passwordStart + keyword.length).trim();
        link.password = password;
        break;
      }
    }

    if (!link.password) {
      link.password = this.extractPasswordFromURL(url);
    }

    return link;
  }

  private extractURLFromText(text: string): string {
    const urlPrefixes = ['http://', 'https://'];
    let start = -1;

    for (const prefix of urlPrefixes) {
      const pos = text.indexOf(prefix);
      if (pos !== -1) {
        start = pos;
        break;
      }
    }

    if (start === -1) {
      return '';
    }

    let end = text.length;
    const endChars = [' ', '\t', '\n', '"', "'", '<', '>', ')', ']', '}', ',', ';'];

    for (const char of endChars) {
      const pos = text.indexOf(char, start);
      if (pos !== -1 && pos < end) {
        end = pos;
      }
    }

    return text.substring(start, end);
  }

  private extractPasswordFromURL(url: string): string {
    const pwdParams = ['pwd=', 'password=', 'passcode=', 'code='];

    for (const param of pwdParams) {
      const pos = url.indexOf(param);
      if (pos !== -1) {
        const start = pos + param.length;
        let end = url.length;

        for (let i = start; i < url.length; i++) {
          if (url[i] === '&' || url[i] === '#') {
            end = i;
            break;
          }
        }

        if (start < end) {
          return url.substring(start, end);
        }
      }
    }

    return '';
  }

  private cleanHTML(html: string): string {
    html = html.replace(/<br\s*\/?>/gi, '\n');

    let result = '';
    let inTag = false;

    for (const char of html) {
      if (char === '<') {
        inTag = true;
        continue;
      }
      if (char === '>') {
        inTag = false;
        continue;
      }
      if (!inTag) {
        result += char;
      }
    }

    result = result
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, ' ');

    const lines = result.split('\n');
    const cleanedLines = lines
      .map(line => line.trim())
      .filter(line => line !== '');

    return cleanedLines.join('\n');
  }

  private generateRandomIP(): string {
    return `${Math.floor(Math.random() * 223) + 1}.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 254) + 1}`;
  }

  private getRandomUA(): string {
    return userAgents[Math.floor(Math.random() * userAgents.length)];
  }

  private filterResultsByKeyword(results: SearchResult[], keyword: string): SearchResult[] {
    const lowerKeyword = keyword.toLowerCase();
    return results.filter(result => {
      return (
        result.title.toLowerCase().includes(lowerKeyword) ||
        result.content.toLowerCase().includes(lowerKeyword)
      );
    });
  }
}

const plugin = new Pan666AsyncPlugin();
PluginManager.registerPlugin('pan666', plugin, 3);
export default plugin;