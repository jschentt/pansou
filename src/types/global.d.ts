// 全局类型声明文件

// 解决Cheerio类型错误
declare module 'cheerio' {
  // 定义cheerio命名空间
  namespace cheerio {
    interface Element {}
    type Root = CheerioAPI;
    type Cheerio<T = Element> = any;
  }
  
  interface Cheerio<T> {
    (selector: string | cheerio.Element | cheerio.Element[]): Cheerio<T>;
    html: () => string;
    text: () => string;
    attr: (name: string) => string;
    find: (selector: string) => Cheerio<cheerio.Element>;
    each: (callback: (index: number, element: cheerio.Element) => void) => Cheerio<T>;
    first: () => Cheerio<T>;
    last: () => Cheerio<T>;
    parent: () => Cheerio<T>;
  }
  
  interface CheerioAPI {
    (selector: string | cheerio.Element | cheerio.Element[]): Cheerio<cheerio.Element>;
    load: (html: string) => CheerioAPI;
  }
  
  const cheerio: {
    load: (html: string) => CheerioAPI;
  };
  
  export = cheerio;
}

// 解决缺少的模块类型
declare module '../types' {
  // 定义需要的类型
  export interface Plugin {
    Name: () => string;
    Search: (keyword: string, forceRefresh: boolean) => Promise<any>;
    // 其他需要的属性和方法
  }
}

declare module '../types/plugin' {
  // 定义插件类型
  export interface Plugin {
    Name: () => string;
    Search: (keyword: string, forceRefresh: boolean) => Promise<any>;
    // 其他需要的属性和方法
  }
}

// 为所有插件添加register方法的声明
declare interface Plugin {
  register?: () => void;
}
