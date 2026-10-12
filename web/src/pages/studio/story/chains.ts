// 接续等待（上一镜视频完成后自动截尾帧生成这一镜）：编辑器里显示"等上一镜"，可以取消
import { useEffect } from 'react';
import { create } from 'zustand';
import { api } from '../../../lib/api.ts';
import { useStore } from '../../../lib/store.ts';

interface ChainState {
  storyId: string | null;
  /** 等待中的镜头 → 它在等的上一镜 */
  waiting: Map<string, string>;
  refresh: (storyId: string) => Promise<void>;
}

export const useChains = create<ChainState>((set) => ({
  storyId: null,
  waiting: new Map(),
  refresh: async (storyId) => {
    try {
      const list = await api.storyChains(storyId);
      set({ storyId, waiting: new Map(list.map((c) => [c.shotId, c.afterShotId])) });
    } catch {
      // 拉不到就保持原样，下次再试
    }
  },
}));

/** 打开故事时加载；这个故事的视频任务状态有变化（可能刚触发了接续）时重新拉 */
export function useChainSync(storyId: string): void {
  const refresh = useChains((s) => s.refresh);
  const key = useStore((s) =>
    Object.values(s.tasks)
      .filter((t) => t.link.storyId === storyId && t.link.purpose === 'video')
      .map((t) => `${t.id}:${t.status}`)
      .sort()
      .join(','),
  );
  useEffect(() => {
    void refresh(storyId);
    // 接续是在服务端回调里建任务的，稍等一下再拉一次
    const timer = window.setTimeout(() => void refresh(storyId), 2500);
    return () => window.clearTimeout(timer);
  }, [storyId, key, refresh]);
}
