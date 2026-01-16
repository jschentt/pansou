// 任务类型定义
export type Task = () => any;

// 工作池类
export class WorkerPool {
  private maxWorkers: number;
  private taskQueue: Task[] = [];
  private results: any[] = [];
  private isRunning: boolean = true;
  private workers: number = 0;
  private activeWorkers: number = 0;
  private taskMutex: any = {};
  private resultMutex: any = {};
  private timeoutId: NodeJS.Timeout | null = null;

  // 创建一个新的工作池
  constructor(maxWorkers: number) {
    this.maxWorkers = maxWorkers;
    this.startWorkers();
  }

  // 启动工作者
  private startWorkers() {
    for (let i = 0; i < this.maxWorkers; i++) {
      this.workers++;
      this.processTasks();
    }
  }

  // 处理任务队列
  private async processTasks() {
    while (this.isRunning) {
      if (this.taskQueue.length > 0) {
        this.activeWorkers++;
        const task = this.taskQueue.shift();
        
        try {
          if (task) {
            const result = task();
            this.results.push(result);
          }
        } catch (error) {
          console.error('Task execution error:', error);
        } finally {
          this.activeWorkers--;
        }
      } else {
        // 队列为空，短暂休眠
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    }
  }

  // 提交一个任务到工作池
  submit(task: Task) {
    if (!this.isRunning) {
      throw new Error('WorkerPool is closed');
    }
    this.taskQueue.push(task);
  }

  // 获取所有任务的结果
  getResults(count: number): any[] {
    const collectedResults: any[] = [];
    
    // 收集指定数量的结果
    for (let i = 0; i < count; i++) {
      if (this.results.length > 0) {
        collectedResults.push(this.results.shift());
      } else {
        // 没有更多结果，退出循环
        break;
      }
    }
    
    return collectedResults;
  }

  // 关闭工作池
  close() {
    this.isRunning = false;
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
    }
  }
}

// 批量执行任务并返回结果
export function executeBatch(tasks: Task[], maxWorkers: number): any[] {
  if (tasks.length === 0) {
    return [];
  }
  
  // 如果任务数量少于工作者数量，调整工作者数量
  if (tasks.length < maxWorkers) {
    maxWorkers = tasks.length;
  }
  
  // 创建工作池
  const pool = new WorkerPool(maxWorkers);
  
  // 提交所有任务
  for (const task of tasks) {
    pool.submit(task);
  }
  
  // 等待所有任务完成（简单实现，实际应用中可能需要更复杂的同步机制）
  // 这里使用短暂延迟确保任务有时间执行
  setTimeout(() => {
    pool.close();
  }, 100);
  
  // 获取所有结果
  return pool.getResults(tasks.length);
}

// 批量执行任务，带有超时控制，并返回结果
export function executeBatchWithTimeout(tasks: Task[], maxWorkers: number, timeout: number): any[] {
  if (tasks.length === 0) {
    return [];
  }
  
  // 如果任务数量少于工作者数量，调整工作者数量
  if (tasks.length < maxWorkers) {
    maxWorkers = tasks.length;
  }
  
  // 创建工作池
  const pool = new WorkerPool(maxWorkers);
  
  // 提交所有任务
  for (const task of tasks) {
    pool.submit(task);
  }
  
  // 设置超时
  setTimeout(() => {
    pool.close();
  }, timeout);
  
  // 获取所有结果
  return pool.getResults(tasks.length);
}