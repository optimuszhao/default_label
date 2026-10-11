import type {
  Asset,
  AssetFolder,
  AssetQuery,
  AssetTag,
  AssetUsage,
  AssistKind,
  Job,
  WorkflowRun,
  SavedSearch,
  StorageUsage,
  ProviderHealth,
  Story,
  StoryData,
  StorySnapshot,
  StorySummary,
  Task,
  TaskInputs,
  TaskLink,
  TaskType,
  GenParams,
  SiteInfo,
  TokenStatus,
  User,
  UserSettings,
} from '../../../shared/types.ts';

import type { Capabilities } from '../../../shared/operator.ts';
import type { StoryOp } from '../../../shared/story-ops.ts';
import type { Preset, PromptTemplate, Recipe, UserPrompt } from '../../../shared/presets.ts';

export class ApiError extends Error {
  status: number;
  /** 服务端的请求编号，用户反馈问题时提供，方便按编号查日志 */
  requestId: string | null;
  constructor(status: number, message: string, requestId: string | null = null) {
    super(message);
    this.status = status;
    this.requestId = requestId;
  }
}

export async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const isForm = body instanceof FormData;
  const response = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: body === undefined || isForm ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // 反向代理返回的 502 / 504 页面不是 JSON
  }
  if (!response.ok) {
    throw new ApiError(
      response.status,
      (data && data.error) || `请求失败（${response.status}）`,
      (data && data.requestId) || response.headers.get('x-request-id'),
    );
  }
  return data as T;
}

export interface Session {
  user: User | null;
  settings: UserSettings | null;
  site?: SiteInfo;
}

export interface NewTask {
  type: TaskType;
  title?: string;
  /** 带配方时由服务端编译，可以留空 */
  prompt: string;
  recipe?: Recipe;
  negativePrompt?: string;
  params: GenParams;
  inputs?: TaskInputs;
  link?: TaskLink;
  priority?: number;
  runNow?: boolean;
}

export interface WorkflowInputInfo {
  key: string;
  label: string;
  type: 'text' | 'select' | 'image' | 'lines' | 'preset' | 'character';
  required?: boolean;
  default?: unknown;
  options?: (string | number)[];
  multiline?: boolean;
  min?: number;
  max?: number;
  placeholder?: string;
  hint?: string;
}

export interface WorkflowInfo {
  id: string;
  title: string;
  description: string;
  estimate: string;
  inputs: WorkflowInputInfo[];
  steps: { id: string; kind: string; label: string }[];
}

export interface SeriesSettings {
  visualStyle?: string;
  aspectRatio?: string;
  defaultSeed?: number | null;
  negativePrompt?: string;
  genre?: string;
  tone?: string;
}

export interface SeriesSummary {
  id: string;
  title: string;
  settings: SeriesSettings;
  coverAssetId: string | null;
  totals: { episodes: number; shots: number; duration: number };
  createdAt: number;
  updatedAt: number;
}

export interface SeriesBoard extends SeriesSummary {
  episodes: {
    id: string;
    title: string;
    episodeNo: number | null;
    status: string;
    stats: { shots?: number; duration?: number; chapters?: number };
    progress: { shots: number; keyframes: number; videos: number; locked: number } | null;
    updatedAt: number;
  }[];
  shared: { id: string; kind: string; name: string; storyId: string | null }[];
}

export type BatchAction = 'favorite' | 'rating' | 'flag' | 'move' | 'addTags' | 'removeTags' | 'trash' | 'restore' | 'purge';

export interface AssetFacets {
  total: number;
  kinds: Record<string, number>;
  sources: Record<string, number>;
  flags: Record<string, number>;
  favorite: number;
  ratings: Record<string, number>;
  tags: { id: string; name: string; count: number }[];
  stories: { id: string; title: string; count: number }[];
}

export interface AssetDetail {
  asset: Asset;
  codec: string | null;
  sha256: string | null;
  meta: { png?: { prompt?: string; negative?: string; seed?: number; keys?: string[] } } | null;
  folderPath: string[];
  story: { id: string; title: string } | null;
  task: { id: string; title: string; type: string; status: string; createdAt: number; finishedAt: number | null } | null;
}

/** AssetQuery → URL 参数（布尔值写成 1，空值省略） */
export function assetParams(query: AssetQuery): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '' || value === false) continue;
    params.set(key, value === true ? '1' : String(value));
  }
  return params;
}

export const api = {
  me: () => request<Session>('GET', '/api/auth/me'),
  login: (email: string, password: string) => request<Session>('POST', '/api/auth/login', { email, password }),
  register: (email: string, name: string, password: string) =>
    request<Session>('POST', '/api/auth/register', { email, name, password }),
  logout: () => request('POST', '/api/auth/logout'),
  updateSettings: (patch: Partial<UserSettings>) => request<UserSettings>('PATCH', '/api/settings', patch),

  health: () => request<ProviderHealth>('GET', '/api/health'),
  refreshHealth: () => request<ProviderHealth>('POST', '/api/health/refresh'),
  capabilities: () => request<Capabilities>('GET', '/api/capabilities'),

  // 创作台 2.0：预设、模板、收藏、我的提示词、流水
  presets: () => request<Preset[]>('GET', '/api/presets'),
  templates: () => request<PromptTemplate[]>('GET', '/api/templates'),
  setFavorite: (kind: 'template' | 'preset', ref: string, on: boolean) => request('PUT', '/api/favorites', { kind, ref, on }),
  prompts: () => request<UserPrompt[]>('GET', '/api/prompts'),
  savePrompt: (name: string, body: string, mode: 'image' | 'video') => request<UserPrompt>('POST', '/api/prompts', { name, body, mode }),
  deletePrompt: (id: string) => request('DELETE', `/api/prompts/${id}`),
  recentRecipes: () => request<{ recipe: Recipe; prompt: string; createdAt: number }[]>('GET', '/api/recipes/recent'),
  feed: (query: { before?: string | null; limit?: number; kind?: string; favorite?: boolean; q?: string } = {}) => {
    const params = new URLSearchParams();
    if (query.before) params.set('before', query.before);
    if (query.limit) params.set('limit', String(query.limit));
    if (query.kind) params.set('kind', query.kind);
    if (query.favorite) params.set('favorite', '1');
    if (query.q) params.set('q', query.q);
    return request<{ tasks: Task[]; assets: Asset[]; next: string | null }>('GET', `/api/feed?${params}`);
  },
  asset: (id: string) => request<Asset>('GET', `/api/assets/${id}`),

  // 管理员：算子令牌
  tokenStatus: () => request<TokenStatus>('GET', '/api/admin/token'),
  verifyToken: () => request<TokenStatus>('POST', '/api/admin/token/verify'),
  renewToken: () => request<TokenStatus>('POST', '/api/admin/token/renew'),

  tasks: (query: { status?: string; storyId?: string; limit?: number } = {}) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) if (value !== undefined) params.set(key, String(value));
    return request<Task[]>('GET', `/api/tasks?${params}`);
  },
  createTask: (task: NewTask) => request<Task>('POST', '/api/tasks', task),
  /** 批量创建：服务端单次最多 200 个，超过时分批提交 */
  createTasks: async (tasks: NewTask[]) => {
    const created: Task[] = [];
    for (let i = 0; i < tasks.length; i += 200) {
      created.push(...(await request<Task[]>('POST', '/api/tasks/batch', { tasks: tasks.slice(i, i + 200) })));
    }
    return created;
  },
  taskAction: (id: string, action: 'run' | 'pause' | 'resume' | 'cancel' | 'retry') =>
    request<Task>('POST', `/api/tasks/${id}/${action}`),
  setPriority: (id: string, priority: number) => request<Task>('PATCH', `/api/tasks/${id}`, { priority }),
  deleteTask: (id: string) => request('DELETE', `/api/tasks/${id}`),
  queueAction: (action: 'run-all' | 'pause-all' | 'resume-all' | 'clear-finished') =>
    request<{ count: number }>('POST', `/api/queue/${action}`),

  assets: (query: { kind?: string; storyId?: string; favorite?: boolean; source?: string; before?: string; limit?: number } = {}) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === false) continue;
      params.set(key, value === true ? '1' : String(value));
    }
    return request<Asset[]>('GET', `/api/assets?${params}`);
  },
  upload: (file: File, size?: { width: number; height: number }) => {
    const form = new FormData();
    // multipart 字段需在文件之前，服务端才能在 file() 时拿到
    if (size) {
      form.append('width', String(size.width));
      form.append('height', String(size.height));
    }
    form.append('file', file);
    return request<Asset>('POST', '/api/assets/upload', form);
  },
  favorite: (id: string, favorite: boolean) => request<Asset>('PATCH', `/api/assets/${id}`, { favorite }),
  deleteAsset: (id: string) => request<{ ok: true; trashed?: boolean; purged?: boolean }>('DELETE', `/api/assets/${id}`),

  // 资产库 2.0
  library: (query: AssetQuery, cursor?: string | null, limit = 120) => {
    const params = assetParams(query);
    params.set('page', '1');
    params.set('limit', String(limit));
    if (cursor) params.set('cursor', cursor);
    return request<{ items: Asset[]; next: string | null }>('GET', `/api/assets?${params}`);
  },
  facets: (query: AssetQuery) => request<AssetFacets>('GET', `/api/assets/facets?${assetParams(query)}`),
  patchAsset: (id: string, patch: { favorite?: boolean; rating?: number; flag?: 'pick' | 'reject' | null; note?: string; folderId?: string | null; tags?: string[] }) =>
    request<Asset>('PATCH', `/api/assets/${id}`, patch),
  batchAssets: (target: { ids?: string[]; query?: AssetQuery }, action: BatchAction, value?: unknown) =>
    request<{ count: number; blocked: { id: string; reason: string }[] }>('POST', '/api/assets/batch', { ...target, action, value }),
  emptyTrash: () => request<{ count: number }>('POST', '/api/assets/trash/empty'),
  assetUsage: (id: string) => request<AssetUsage>('GET', `/api/assets/${id}/usage`),
  assetsUsage: (ids: string[]) => request<AssetUsage[]>('POST', '/api/assets/usage', { ids }),
  assetLineage: (id: string) => request<{ parents: Asset[]; children: Asset[] }>('GET', `/api/assets/${id}/lineage`),
  assetDetail: (id: string) => request<AssetDetail>('GET', `/api/assets/${id}/detail`),
  frame: (id: string, at: number | 'last') => request<Asset>('POST', `/api/assets/${id}/frame`, { at }),
  exportAssets: (target: { ids?: string[]; query?: AssetQuery }, name?: string) =>
    request<{ url: string; count: number; bytes: number }>('POST', '/api/assets/export', { ...target, name }),
  folders: () => request<AssetFolder[]>('GET', '/api/folders'),
  createFolder: (name: string, parentId: string | null) => request<AssetFolder>('POST', '/api/folders', { name, parentId }),
  updateFolder: (id: string, patch: { name?: string; parentId?: string | null }) => request<AssetFolder>('PATCH', `/api/folders/${id}`, patch),
  deleteFolder: (id: string) => request('DELETE', `/api/folders/${id}`),
  tags: () => request<AssetTag[]>('GET', '/api/tags'),
  renameTag: (id: string, name: string) => request<AssetTag[]>('PATCH', `/api/tags/${id}`, { name }),
  deleteTag: (id: string) => request('DELETE', `/api/tags/${id}`),
  savedSearches: () => request<SavedSearch[]>('GET', '/api/saved-searches'),
  saveSearch: (name: string, query: AssetQuery) => request<SavedSearch>('POST', '/api/saved-searches', { name, query }),
  deleteSavedSearch: (id: string) => request('DELETE', `/api/saved-searches/${id}`),
  storageUsage: () => request<StorageUsage>('GET', '/api/storage/usage'),
  duplicates: () => request<{ sha256: string; keepId: string; assets: Asset[] }[]>('GET', '/api/assets/duplicates'),
  mergeDuplicates: (sha256?: string[]) => request<{ groups: number; removed: number }>('POST', '/api/assets/duplicates/merge', { sha256 }),
  workflows: () => request<WorkflowInfo[]>('GET', '/api/workflows'),
  workflowCharacters: () => request<{ value: string; label: string; name: string; appearance: string }[]>('GET', '/api/workflows/characters'),
  startWorkflow: (id: string, inputs: Record<string, unknown>, unattended: boolean) => request<WorkflowRun>('POST', `/api/workflows/${id}/runs`, { inputs, unattended }),
  workflowRuns: (active = false) => request<WorkflowRun[]>('GET', `/api/workflow-runs${active ? '?status=active' : ''}`),
  workflowRun: (id: string) => request<WorkflowRun>('GET', `/api/workflow-runs/${id}`),
  workflowAction: (id: string, action: 'cancel' | 'pause' | 'resume') => request<WorkflowRun>('POST', `/api/workflow-runs/${id}/${action}`),
  workflowStep: (id: string, stepId: string, action: 'select' | 'retry' | 'skip', assetIds?: string[]) =>
    request<WorkflowRun>('POST', `/api/workflow-runs/${id}/steps/${stepId}/${action}`, assetIds ? { assetIds } : {}),
  deleteWorkflowRun: (id: string) => request('DELETE', `/api/workflow-runs/${id}`),
  adminWorkflows: () => request<(WorkflowInfo & { enabled: boolean; sort: number; defaults: Record<string, unknown>; runs: number })[]>('GET', '/api/admin/workflows'),
  patchAdminWorkflow: (id: string, patch: { enabled?: boolean; sort?: number; defaults?: Record<string, unknown> }) => request('PATCH', `/api/admin/workflows/${id}`, patch),
  job: (id: string) => request<Job>('GET', `/api/jobs/${id}`),
  cancelJob: (id: string) => request<Job>('POST', `/api/jobs/${id}/cancel`),

  stories: (status?: 'active' | 'done' | 'archived' | 'trash') => request<StorySummary[]>('GET', `/api/stories${status ? `?status=${status}` : ''}`),
  createStory: (title: string, logline: string, templateId?: string | null) => request<Story>('POST', '/api/stories', { title, logline, templateId }),
  duplicateStory: (id: string) => request<Story>('POST', `/api/stories/${id}/duplicate`),
  story: (id: string) => request<Story>('GET', `/api/stories/${id}`),
  storyOps: (id: string, body: { baseRev: number; clientId: string; batchId: string; ops: StoryOp[] }) =>
    request<{ rev: number; ignored: { index: number; reason: string }[]; duplicate?: boolean }>('POST', `/api/stories/${id}/ops`, body),
  storyChanges: (id: string, since: number) =>
    request<{ rev: number; reset?: boolean; changes: { rev: number; clientId: string | null; ops: StoryOp[] }[] }>('GET', `/api/stories/${id}/changes?since=${since}`),
  storyMedia: (id: string) => request<Asset[]>('GET', `/api/stories/${id}/media`),
  patchStory: (id: string, patch: { status?: 'active' | 'done' | 'archived'; lastPosition?: { tab: string; sceneId?: string | null }; coverAssetId?: string | null }) =>
    request<StorySummary>('PATCH', `/api/stories/${id}`, patch),
  storySnapshots: (id: string) => request<StorySnapshot[]>('GET', `/api/stories/${id}/snapshots`),
  storySnapshot: (id: string, snapshotId: string) => request<StorySnapshot & { data: StoryData }>('GET', `/api/stories/${id}/snapshots/${snapshotId}`),
  saveSnapshot: (id: string, label: string) => request<StorySnapshot>('POST', `/api/stories/${id}/snapshots`, { label }),
  restoreSnapshot: (id: string, snapshotId: string) => request<Story>('POST', `/api/stories/${id}/snapshots/${snapshotId}/restore`),
  deleteStory: (id: string, purge = false) => request('DELETE', `/api/stories/${id}${purge ? '?purge=1' : ''}`),
  restoreStory: (id: string) => request('POST', `/api/stories/${id}/restore`),
  storyContext: (id: string) => request<{ previous: { episodeNo: number; title: string; recaps: string[] }[] }>('GET', `/api/stories/${id}/context`),
  shotFromAsset: (id: string, assetId: string, sceneId: string) => request<{ shotId: string; rev: number }>('POST', `/api/stories/${id}/shots/from-asset`, { assetId, sceneId }),
  setStorySeries: (id: string, seriesId: string | null) => request<{ ok: true; episodeNo: number | null }>('POST', `/api/stories/${id}/series`, { seriesId }),
  seriesList: () => request<SeriesSummary[]>('GET', '/api/series'),
  series: (id: string) => request<SeriesBoard>('GET', `/api/series/${id}`),
  createSeries: (title: string, settings: SeriesSettings = {}) => request<SeriesSummary>('POST', '/api/series', { title, settings }),
  updateSeries: (id: string, patch: { title?: string; settings?: SeriesSettings }) => request<SeriesSummary>('PATCH', `/api/series/${id}`, patch),
  deleteSeries: (id: string) => request('DELETE', `/api/series/${id}`),
  createEpisode: (id: string, title: string, copyStructureFrom?: string | null) => request<Story>('POST', `/api/series/${id}/episodes`, { title, copyStructureFrom }),

  assist: <T>(kind: AssistKind, input: Record<string, unknown>) => request<T>('POST', `/api/assist/${kind}`, input),
};
