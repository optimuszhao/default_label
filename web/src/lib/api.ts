import type {
  Asset,
  AssistKind,
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

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const isForm = body instanceof FormData;
  const response = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: body === undefined || isForm ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new ApiError(response.status, (data && data.error) || `请求失败（${response.status}）`);
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
  prompt: string;
  negativePrompt?: string;
  params: GenParams;
  inputs?: TaskInputs;
  link?: TaskLink;
  priority?: number;
  runNow?: boolean;
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
  deleteAsset: (id: string) => request('DELETE', `/api/assets/${id}`),

  stories: () => request<StorySummary[]>('GET', '/api/stories'),
  createStory: (title: string, logline: string) => request<Story>('POST', '/api/stories', { title, logline }),
  story: (id: string) => request<Story>('GET', `/api/stories/${id}`),
  saveStory: (id: string, title: string, data: StoryData, baseRev?: number) =>
    request<{ ok: true; rev: number; updatedAt: number }>('PUT', `/api/stories/${id}`, { title, data, baseRev }),
  storySnapshots: (id: string) => request<StorySnapshot[]>('GET', `/api/stories/${id}/snapshots`),
  restoreSnapshot: (id: string, snapshotId: string) => request<Story>('POST', `/api/stories/${id}/snapshots/${snapshotId}/restore`),
  deleteStory: (id: string) => request('DELETE', `/api/stories/${id}`),

  assist: <T>(kind: AssistKind, input: Record<string, unknown>) => request<T>('POST', `/api/assist/${kind}`, input),
};
