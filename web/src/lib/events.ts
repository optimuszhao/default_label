import { useEffect } from 'react';
import type { ServerEvent } from '../../../shared/types.ts';
import { api } from './api.ts';
import { useStore } from './store.ts';

/**
 * 登录后建立 SSE 长连接，实时接收任务进度、生成结果和服务状态。
 * 浏览器会自动重连；重连后补拉一次任务列表，避免断线期间漏掉状态变化。
 */
export function useServerEvents(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    let opened = false;
    const source = new EventSource('/api/events');
    source.onopen = () => {
      if (opened) {
        void api.tasks({ limit: 300 }).then((tasks) => useStore.getState().upsertTasks(tasks)).catch(() => undefined);
      }
      opened = true;
    };
    source.onmessage = (message) => {
      try {
        useStore.getState().applyEvent(JSON.parse(message.data) as ServerEvent);
      } catch {
        // 忽略无法解析的消息
      }
    };
    return () => source.close();
  }, [enabled]);
}
