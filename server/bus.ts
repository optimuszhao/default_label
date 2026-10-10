// 进程内事件总线：调度器把任务状态变化推给对应用户的 SSE 连接。
import { EventEmitter } from 'node:events';
import type { ServerEvent } from '../shared/types.ts';

const emitter = new EventEmitter();
emitter.setMaxListeners(0);

/** userId 为 '*' 时表示广播给所有在线用户（例如服务健康状态变化） */
export function publish(userId: string, event: ServerEvent): void {
  emitter.emit(userId, event);
}

export function subscribe(userId: string, listener: (event: ServerEvent) => void): () => void {
  emitter.on(userId, listener);
  emitter.on('*', listener);
  return () => {
    emitter.off(userId, listener);
    emitter.off('*', listener);
  };
}
