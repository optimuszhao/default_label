// 预设、模板、我的提示词：进入工作台后加载一次，全局共享
import { create } from 'zustand';
import type { Preset, PromptTemplate, UserPrompt } from '../../../../../shared/presets.ts';
import { api } from '../../../lib/api.ts';
import { reportError } from '../../../lib/store.ts';

interface CatalogState {
  loaded: boolean;
  presets: Preset[];
  presetMap: Map<string, Preset>;
  templates: PromptTemplate[];
  prompts: UserPrompt[];
  load: (force?: boolean) => Promise<void>;
  setTemplateFavorite: (id: string, on: boolean) => Promise<void>;
  addPrompt: (prompt: UserPrompt) => void;
  removePrompt: (id: string) => Promise<void>;
}

let inflight: Promise<void> | null = null;

export const useCatalog = create<CatalogState>((set, get) => ({
  loaded: false,
  presets: [],
  presetMap: new Map(),
  templates: [],
  prompts: [],
  load: async (force = false) => {
    if (get().loaded && !force) return;
    inflight ??= Promise.all([api.presets(), api.templates(), api.prompts()])
      .then(([presets, templates, prompts]) => {
        set({ loaded: true, presets, presetMap: new Map(presets.map((p) => [p.slug, p])), templates, prompts });
      })
      .catch(reportError)
      .finally(() => {
        inflight = null;
      });
    return inflight;
  },
  setTemplateFavorite: async (id, on) => {
    set({ templates: get().templates.map((t) => (t.id === id ? { ...t, favorite: on } : t)) });
    try {
      await api.setFavorite('template', id, on);
    } catch (error) {
      reportError(error);
      set({ templates: get().templates.map((t) => (t.id === id ? { ...t, favorite: !on } : t)) });
    }
  },
  addPrompt: (prompt) => set({ prompts: [prompt, ...get().prompts] }),
  removePrompt: async (id) => {
    await api.deletePrompt(id);
    set({ prompts: get().prompts.filter((p) => p.id !== id) });
  },
}));
