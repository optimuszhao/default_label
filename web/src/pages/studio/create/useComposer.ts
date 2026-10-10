// 创作台状态：配方 + 参考图 / 首尾帧；图片和视频各自保存草稿（刷新不丢）
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { compose, emptyRecipe, type ComposeResult } from '../../../../../shared/compose.ts';
import { lint, type LintHint } from '../../../../../shared/lint.ts';
import type { MediaMode, Recipe } from '../../../../../shared/presets.ts';
import type { Asset, TaskType } from '../../../../../shared/types.ts';
import { api } from '../../../lib/api.ts';
import { useStore } from '../../../lib/store.ts';
import { useCatalog } from './catalog.ts';

export interface ComposerState {
  recipe: Recipe;
  refs: Asset[];
  firstFrame: Asset | null;
  lastFrame: Asset | null;
}

interface StoredDraft {
  recipe: Recipe;
  refIds: string[];
  firstFrameId: string | null;
}

const draftKey = (mode: MediaMode) => `weave:composer:${mode}`;

function readDraft(mode: MediaMode): StoredDraft | null {
  try {
    const raw = localStorage.getItem(draftKey(mode));
    return raw ? (JSON.parse(raw) as StoredDraft) : null;
  } catch {
    return null;
  }
}

function writeDraft(mode: MediaMode, state: ComposerState): void {
  try {
    const draft: StoredDraft = { recipe: state.recipe, refIds: state.refs.map((a) => a.id), firstFrameId: state.firstFrame?.id ?? null };
    localStorage.setItem(draftKey(mode), JSON.stringify(draft));
  } catch {
    // 隐私模式：不保存草稿
  }
}

function initial(mode: MediaMode): ComposerState {
  const draft = readDraft(mode);
  const assets = useStore.getState().assets;
  return {
    recipe: draft?.recipe && draft.recipe.mode === mode ? { ...emptyRecipe(mode), ...draft.recipe } : emptyRecipe(mode),
    refs: (draft?.refIds ?? []).map((id) => assets[id]).filter((a): a is Asset => Boolean(a)),
    firstFrame: draft?.firstFrameId ? (assets[draft.firstFrameId] ?? null) : null,
    lastFrame: null,
  };
}

export interface Composer {
  mode: MediaMode;
  state: ComposerState;
  type: TaskType;
  compiled: ComposeResult;
  hints: LintHint[];
  setMode: (mode: MediaMode) => void;
  set: (patch: Partial<ComposerState>) => void;
  setRecipe: (patch: Partial<Recipe>) => void;
  setOverrides: (patch: Partial<Recipe['overrides']>) => void;
  reset: () => void;
  load: (next: { mode: MediaMode; recipe?: Recipe; refs?: Asset[]; firstFrame?: Asset | null }) => void;
}

export function useComposer(): Composer {
  const caps = useStore((s) => s.capabilities);
  const presetMap = useCatalog((s) => s.presetMap);
  const templates = useCatalog((s) => s.templates);
  const [mode, setModeState] = useState<MediaMode>(() => (localStorage.getItem('weave:composer:mode') === 'video' ? 'video' : 'image'));
  const [state, setState] = useState<ComposerState>(() => initial(mode));
  const modeRef = useRef(mode);
  modeRef.current = mode;

  // 草稿里的参考图可能还没加载到缓存：补拉一次
  useEffect(() => {
    const draft = readDraft(mode);
    const missing = [...(draft?.refIds ?? []), ...(draft?.firstFrameId ? [draft.firstFrameId] : [])].filter((id) => !useStore.getState().assets[id]);
    if (!missing.length) return;
    void Promise.all(missing.map((id) => api.asset(id).catch(() => null))).then((found) => {
      const assets = found.filter((a): a is Asset => Boolean(a));
      useStore.getState().upsertAssets(assets);
      if (modeRef.current === mode) setState(initial(mode));
    });
  }, [mode]);

  useEffect(() => {
    const timer = setTimeout(() => writeDraft(mode, state), 300);
    return () => clearTimeout(timer);
  }, [mode, state]);

  const setMode = useCallback((next: MediaMode) => {
    if (next === modeRef.current) return;
    try {
      localStorage.setItem('weave:composer:mode', next);
    } catch {
      // 忽略
    }
    setModeState(next);
    setState(initial(next));
  }, []);

  const set = useCallback((patch: Partial<ComposerState>) => setState((prev) => ({ ...prev, ...patch })), []);
  const setRecipe = useCallback((patch: Partial<Recipe>) => setState((prev) => ({ ...prev, recipe: { ...prev.recipe, ...patch } })), []);
  const setOverrides = useCallback(
    (patch: Partial<Recipe['overrides']>) => setState((prev) => ({ ...prev, recipe: { ...prev.recipe, overrides: { ...prev.recipe.overrides, ...patch } } })),
    [],
  );
  const reset = useCallback(() => setState({ recipe: emptyRecipe(modeRef.current), refs: [], firstFrame: null, lastFrame: null }), []);
  const load = useCallback((next: { mode: MediaMode; recipe?: Recipe; refs?: Asset[]; firstFrame?: Asset | null }) => {
    try {
      localStorage.setItem('weave:composer:mode', next.mode);
    } catch {
      // 忽略
    }
    setModeState(next.mode);
    setState({
      recipe: next.recipe ? { ...emptyRecipe(next.mode), ...next.recipe, mode: next.mode } : emptyRecipe(next.mode),
      refs: next.refs ?? [],
      firstFrame: next.firstFrame ?? null,
      lastFrame: null,
    });
  }, []);

  const refs = state.refs.slice(0, caps.image.maxReferences);
  const firstFrame = caps.video.firstFrame ? state.firstFrame : null;
  const type: TaskType = mode === 'image' ? (refs.length ? 'i2i' : 't2i') : firstFrame ? 'i2v' : 't2v';
  const template = templates.find((t) => t.id === state.recipe.templateId) ?? null;

  const compiled = useMemo(
    () => compose({ recipe: { ...state.recipe, mode }, template, catalog: presetMap, caps }),
    [state.recipe, mode, template, presetMap, caps],
  );
  const hints = useMemo(
    () =>
      lint(
        { ...state.recipe, mode },
        {
          finalPrompt: compiled.prompt,
          presets: compiled.presets.map((slug) => presetMap.get(slug)!).filter(Boolean),
          hasFirstFrame: Boolean(firstFrame),
          supportsNegative: (mode === 'video' ? caps.video : caps.image).negativePrompt,
        },
      ),
    [state.recipe, mode, compiled, presetMap, firstFrame, caps],
  );

  return { mode, state: { ...state, refs, firstFrame }, type, compiled, hints, setMode, set, setRecipe, setOverrides, reset, load };
}
