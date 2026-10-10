import { create } from 'zustand';
import { DEFAULT_CAPABILITIES, type Capabilities } from '../../../shared/operator.ts';
import type { Asset, ProviderHealth, ServerEvent, SiteInfo, Task, TaskType, User, UserSettings } from '../../../shared/types.ts';
import { api, ApiError } from './api.ts';

export interface ComposerDraft {
  mode: 'image' | 'video';
  /** 完整配方（改参数重跑、从灵感页套用模板） */
  recipe?: import('../../../shared/presets.ts').Recipe;
  /** 套用后直接生成 */
  autoSubmit?: boolean;
  prompt?: string;
  referenceAssetIds?: string[];
  firstFrameAssetId?: string | null;
  type?: TaskType;
}

interface Toast {
  id: number;
  kind: 'info' | 'success' | 'error';
  text: string;
}

interface State {
  ready: boolean;
  user: User | null;
  settings: UserSettings | null;
  /** 站点公开配置（注册是否开放等） */
  site: SiteInfo;
  health: ProviderHealth | null;
  /** 当前算子的能力声明，决定创作台显示哪些控件 */
  capabilities: Capabilities;
  tasks: Record<string, Task>;
  assets: Record<string, Asset>;
  composerDraft: ComposerDraft | null;
  toasts: Toast[];

  setSession: (user: User | null, settings: UserSettings | null) => void;
  setSettings: (settings: UserSettings) => void;
  setHealth: (health: ProviderHealth) => void;
  setCapabilities: (capabilities: Capabilities) => void;
  upsertTasks: (tasks: Task[]) => void;
  removeTask: (id: string) => void;
  upsertAssets: (assets: Asset[]) => void;
  removeAsset: (id: string) => void;
  applyEvent: (event: ServerEvent) => void;
  setComposerDraft: (draft: ComposerDraft | null) => void;
  toast: (text: string, kind?: Toast['kind']) => void;
  dismissToast: (id: number) => void;
}

let toastSeq = 0;

export const useStore = create<State>((set, get) => ({
  ready: false,
  user: null,
  settings: null,
  site: { registration: 'open' },
  health: null,
  capabilities: DEFAULT_CAPABILITIES,
  tasks: {},
  assets: {},
  composerDraft: null,
  toasts: [],

  setSession: (user, settings) =>
    set(user ? { user, settings, ready: true } : { user: null, settings: null, ready: true, tasks: {}, assets: {} }),
  setSettings: (settings) => set({ settings }),
  setHealth: (health) => set({ health }),
  setCapabilities: (capabilities) => set({ capabilities }),
  upsertTasks: (tasks) =>
    set((state) => {
      const next = { ...state.tasks };
      for (const task of tasks) {
        const prev = next[task.id];
        if (!prev || prev.updatedAt <= task.updatedAt) next[task.id] = task;
      }
      return { tasks: next };
    }),
  removeTask: (id) =>
    set((state) => {
      const next = { ...state.tasks };
      delete next[id];
      return { tasks: next };
    }),
  upsertAssets: (assets) =>
    set((state) => {
      const next = { ...state.assets };
      for (const asset of assets) next[asset.id] = asset;
      return { assets: next };
    }),
  removeAsset: (id) =>
    set((state) => {
      const next = { ...state.assets };
      delete next[id];
      return { assets: next };
    }),
  applyEvent: (event) => {
    const state = get();
    switch (event.type) {
      case 'task': {
        const prev = state.tasks[event.task.id];
        state.upsertTasks([event.task]);
        if (prev && prev.status !== event.task.status) {
          if (event.task.status === 'succeeded') state.toast(`「${event.task.title}」生成完成`, 'success');
          if (event.task.status === 'failed') state.toast(`「${event.task.title}」生成失败`, 'error');
        }
        break;
      }
      case 'task-removed':
        state.removeTask(event.id);
        break;
      case 'asset':
        state.upsertAssets([event.asset]);
        break;
      case 'health':
        state.setHealth(event.health);
        break;
    }
  },
  setComposerDraft: (composerDraft) => set({ composerDraft }),
  toast: (text, kind = 'info') => {
    const id = ++toastSeq;
    set((state) => ({ toasts: [...state.toasts.slice(-3), { id, kind, text }] }));
    setTimeout(() => get().dismissToast(id), 3600);
  },
  dismissToast: (id) => set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) })),
}));

export async function bootstrapSession(): Promise<void> {
  try {
    const session = await api.me();
    if (session.site) useStore.setState({ site: session.site });
    useStore.getState().setSession(session.user, session.settings);
  } catch {
    useStore.getState().setSession(null, null);
  }
}

/** 统一的错误提示 */
export function reportError(error: unknown): void {
  let text = error instanceof Error ? error.message : String(error);
  // 服务端出错时附上错误编号，反馈问题时报这个编号即可定位日志
  if (error instanceof ApiError && error.status >= 500 && error.requestId) text += `（错误编号 ${error.requestId}）`;
  useStore.getState().toast(text, 'error');
}
