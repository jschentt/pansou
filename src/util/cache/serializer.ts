// 导入必要的类型
import { SearchResult, SearchResponse, MergedLinks } from '../../models/plugin-result';

// Serializer 序列化接口
export interface Serializer {
  Serialize(v: any): Buffer;
  Deserialize(data: Buffer, v: any): any;
}

// 缓冲区池
class BufferPool {
  private pool: Buffer[] = [];
  private maxSize: number = 100;
  
  get(): Buffer {
    return this.pool.length > 0 ? this.pool.pop()! : Buffer.alloc(1024);
  }
  
  put(buffer: Buffer): void {
    if (this.pool.length < this.maxSize) {
      this.pool.push(buffer);
    }
  }
}

// 全局缓冲区池
const bufferPool = new BufferPool();

// GobSerializer 使用gob进行序列化/反序列化（在TypeScript中用JSON替代）
export class GobSerializer {
  private bufferPool: BufferPool;

  // NewGobSerializer 创建新的gob序列化器
  static NewGobSerializer(): GobSerializer {
    return new GobSerializer();
  }

  constructor() {
    this.bufferPool = bufferPool;
  }

  // Serialize 序列化数据
  Serialize(v: any): Buffer {
    const buf = this.bufferPool.get();
    try {
      // 使用JSON序列化替代gob
      const jsonStr = JSON.stringify(v);
      const result = Buffer.from(jsonStr);
      return result;
    } finally {
      this.bufferPool.put(buf);
    }
  }

  // Deserialize 反序列化数据
  Deserialize(data: Buffer, v: any): any {
    const buf = this.bufferPool.get();
    try {
      // 使用JSON反序列化替代gob
      const jsonStr = data.toString();
      return JSON.parse(jsonStr);
    } finally {
      this.bufferPool.put(buf);
    }
  }
}

// JSONSerializer 使用JSON进行序列化/反序列化
// 为了保持向后兼容性
export class JSONSerializer {
  private bufferPool: BufferPool;

  // NewJSONSerializer 创建新的JSON序列化器
  static NewJSONSerializer(): JSONSerializer {
    return new JSONSerializer();
  }

  constructor() {
    this.bufferPool = bufferPool;
  }

  // Serialize 序列化数据
  Serialize(v: any): Buffer {
    return SerializeWithPool(v);
  }

  // Deserialize 反序列化数据
  Deserialize(data: Buffer, v: any): any {
    return DeserializeWithPool(data, v);
  }
}

// SerializeWithPool 使用缓冲区池序列化数据
export function SerializeWithPool(v: any): Buffer {
  const buf = bufferPool.get();
  try {
    const jsonStr = JSON.stringify(v);
    const result = Buffer.from(jsonStr);
    return result;
  } finally {
    bufferPool.put(buf);
  }
}

// DeserializeWithPool 使用缓冲区池反序列化数据
export function DeserializeWithPool(data: Buffer, v: any): any {
  const buf = bufferPool.get();
  try {
    const jsonStr = data.toString();
    return JSON.parse(jsonStr);
  } finally {
    bufferPool.put(buf);
  }
}

// 初始化函数，注册需要序列化的类型
// 在TypeScript中，JSON序列化会自动处理类型，所以不需要显式注册
function init() {
  // 注册操作在TypeScript中不是必需的
  // JSON序列化会自动处理所有可序列化的类型
}

// 执行初始化
init();


