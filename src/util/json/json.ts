/**
 * JSON工具类，提供JSON序列化和反序列化功能
 */

/**
 * 序列化对象到JSON字节数组
 * @param v 要序列化的对象
 * @returns JSON字节数组
 */
export function Marshal(v: any): Uint8Array {
  const jsonString = JSON.stringify(v);
  return new TextEncoder().encode(jsonString);
}

/**
 * 反序列化JSON字节数组到对象
 * @param data JSON字节数组
 * @param v 目标对象（TypeScript中不需要，直接返回解析结果）
 * @returns 解析后的对象
 */
export function Unmarshal<T>(data: Uint8Array | string): T {
  let jsonString: string;
  if (data instanceof Uint8Array) {
    jsonString = new TextDecoder().decode(data);
  } else {
    jsonString = data;
  }
  return JSON.parse(jsonString) as T;
}

/**
 * 序列化对象到JSON字符串
 * @param v 要序列化的对象
 * @returns JSON字符串
 */
export function MarshalString(v: any): string {
  return JSON.stringify(v);
}

/**
 * 反序列化JSON字符串到对象
 * @param str JSON字符串
 * @param v 目标对象（TypeScript中不需要，直接返回解析结果）
 * @returns 解析后的对象
 */
export function UnmarshalString<T>(str: string): T {
  return JSON.parse(str) as T;
}

/**
 * 序列化对象到格式化的JSON
 * @param v 要序列化的对象
 * @param prefix 前缀字符串
 * @param indent 缩进字符串
 * @returns 格式化的JSON字符串
 */
export function MarshalIndent(v: any, prefix: string = '', indent: string = '  '): string {
  return JSON.stringify(v, null, indent);
}
