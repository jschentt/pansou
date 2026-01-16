// 缓冲区对象池
class BufferPool {
  private pool: Buffer[] = [];
  private maxSize: number = 100; // 最大池大小

  // 获取缓冲区
  get(): Buffer {
    if (this.pool.length > 0) {
      return this.pool.pop()!;
    }
    // 创建新缓冲区
    return Buffer.alloc(1024); // 初始大小1KB
  }

  // 归还缓冲区
  put(buffer: Buffer): void {
    if (this.pool.length < this.maxSize) {
      // 重置缓冲区
      buffer.reset();
      this.pool.push(buffer);
    }
  }
}

// 扩展Buffer类，添加reset方法
interface Buffer {
  reset(): void;
}

Buffer.prototype.reset = function(): void {
  this.fill(0);
  this.truncate(0);
};

// 创建全局缓冲区池
const bufferPool = new BufferPool();

// SerializeWithPool 使用对象池序列化数据
export function SerializeWithPool(v: any): Buffer {
  // 直接使用JSON.stringify序列化
  const jsonString = JSON.stringify(v);
  return Buffer.from(jsonString);
}

// DeserializeWithPool 使用对象池反序列化数据
export function DeserializeWithPool(data: Buffer, v: any): void {
  // 直接使用JSON.parse反序列化
  const jsonString = data.toString();
  const parsedData = JSON.parse(jsonString);
  
  // 将解析后的数据复制到目标对象
  if (typeof v === 'object' && v !== null) {
    Object.assign(v, parsedData);
  }
}
