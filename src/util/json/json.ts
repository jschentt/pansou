// JSON序列化和反序列化工具类

// 序列化对象到JSON
export function marshal(v: any): Buffer {
  try {
    const jsonString = JSON.stringify(v);
    return Buffer.from(jsonString, 'utf8');
  } catch (error) {
    throw new Error(`JSON marshal error: ${error}`);
  }
}

// 反序列化JSON到对象
export function unmarshal(data: Buffer, v: any): void {
  try {
    const jsonString = data.toString('utf8');
    const parsed = JSON.parse(jsonString);
    // 将解析后的数据复制到目标对象
    Object.assign(v, parsed);
  } catch (error) {
    throw new Error(`JSON unmarshal error: ${error}`);
  }
}

// 序列化对象到JSON字符串
export function marshalString(v: any): string {
  try {
    return JSON.stringify(v);
  } catch (error) {
    throw new Error(`JSON marshal string error: ${error}`);
  }
}

// 反序列化JSON字符串到对象
export function unmarshalString(str: string, v: any): void {
  try {
    const parsed = JSON.parse(str);
    // 将解析后的数据复制到目标对象
    Object.assign(v, parsed);
  } catch (error) {
    throw new Error(`JSON unmarshal string error: ${error}`);
  }
}

// 序列化对象到格式化的JSON
export function marshalIndent(v: any, prefix: string = '', indent: string = '  '): Buffer {
  try {
    const jsonString = JSON.stringify(v, null, indent);
    // 添加前缀
    const lines = jsonString.split('\n');
    const indentedLines = lines.map(line => prefix + line);
    const resultString = indentedLines.join('\n');
    return Buffer.from(resultString, 'utf8');
  } catch (error) {
    throw new Error(`JSON marshal indent error: ${error}`);
  }
}