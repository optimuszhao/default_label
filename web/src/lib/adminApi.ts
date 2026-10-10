// 超级管理后台接口
import type { OperatorSummary, OperatorTestStep, Task, TokenStatus, User } from '../../../shared/types.ts';
import type { Preset, PromptTemplate } from '../../../shared/presets.ts';
import { request } from './api.ts';

export interface OperatorInput {
  name: string;
  kind: OperatorSummary['kind'];
  baseUrl: string;
  appid: string;
  /** 不传表示不修改 */
  secret?: string;
  apiKey?: string;
  enabled?: boolean;
  maintenance?: boolean;
  maintenanceNote?: string | null;
  visibility?: OperatorSummary['visibility'];
  priority?: number;
  maxInflight?: number;
  settings?: OperatorSummary['settings'];
}

export interface Overview {
  version: string;
  gitSha: string | null;
  node: string;
  uptimeSec: number;
  memoryMb: number;
  masterKeySource: 'env' | 'file';
  envDrift: boolean;
  counts: { users: number; stories: number; assets: number; tasks: Record<string, number>; succeeded24h: number; failed24h: number };
  operators: OperatorSummary[];
  disk: { data: { free: number; total: number } | null; media: { free: number; total: number } | null };
  dbBytes: number;
  lastBackup: { name: string; bytes: number; createdAt: number } | null;
  backupAt: string;
  failures: { id: string; title: string; type: string; error: string | null; at: number | null; email: string }[];
}

export interface AdminTask extends Task {
  userEmail: string;
  operatorId: string | null;
  operatorName: string | null;
}

export interface AdminUser extends User {
  role: 'user' | 'admin';
  disabled: boolean;
  lastLoginAt: number | null;
  taskCount: number;
  assetCount: number;
  storyCount: number;
}

export interface AuditEntry {
  id: string;
  actorEmail: string | null;
  action: string;
  target: string | null;
  summary: string;
  createdAt: number;
}

export interface BackupEntry {
  name: string;
  bytes: number;
  createdAt: number;
}

export type TemplateInput = Omit<PromptTemplate, 'id' | 'hot' | 'favorite' | 'uses' | 'cover'> & { cover?: string | null };

export const adminApi = {
  overview: () => request<Overview>('GET', '/api/admin/overview'),

  operators: () => request<OperatorSummary[]>('GET', '/api/admin/operators'),
  createOperator: (input: OperatorInput) => request<OperatorSummary>('POST', '/api/admin/operators', input),
  updateOperator: (id: string, input: Partial<OperatorInput>) => request<OperatorSummary>('PATCH', `/api/admin/operators/${id}`, input),
  deleteOperator: (id: string) => request('DELETE', `/api/admin/operators/${id}`),
  testOperator: (input: OperatorInput & { operatorId?: string; generate?: boolean }) =>
    request<OperatorTestStep[]>('POST', '/api/admin/operators/test', input),
  token: (id: string) => request<TokenStatus>('GET', `/api/admin/operators/${id}/token`),
  tokenAction: (id: string, action: 'verify' | 'renew' | 'clear') => request<TokenStatus>('POST', `/api/admin/operators/${id}/token/${action}`),
  manualToken: (id: string, token: string) => request<TokenStatus>('POST', `/api/admin/operators/${id}/token/manual`, { token }),
  revealToken: (id: string) => request<{ token: string | null }>('POST', `/api/admin/operators/${id}/token/reveal`),
  remoteTasks: (id: string) => request<Record<string, unknown>[]>('GET', `/api/admin/operators/${id}/remote`),

  tasks: (query: { status?: string; q?: string; operator?: string } = {}) => {
    const params = new URLSearchParams(Object.entries(query).filter(([, v]) => v) as [string, string][]);
    return request<AdminTask[]>('GET', `/api/admin/tasks?${params}`);
  },
  taskAction: (id: string, action: 'cancel' | 'retry' | 'top') => request<Task>('POST', `/api/admin/tasks/${id}/${action}`),

  users: (q = '') => request<AdminUser[]>('GET', `/api/admin/users${q ? `?q=${encodeURIComponent(q)}` : ''}`),
  updateUser: (id: string, patch: { role?: 'user' | 'admin'; disabled?: boolean }) => request('PATCH', `/api/admin/users/${id}`, patch),

  audit: () => request<AuditEntry[]>('GET', '/api/admin/audit'),
  backups: () => request<BackupEntry[]>('GET', '/api/admin/backups'),

  presets: () => request<Preset[]>('GET', '/api/admin/presets'),
  updatePreset: (slug: string, patch: Partial<Pick<Preset, 'name' | 'prompt' | 'enabled' | 'sort'>> & { negative?: string | null; fallbackPrompt?: string | null; hint?: string | null }) =>
    request<Preset>('PATCH', `/api/admin/presets/${slug}`, patch),
  templates: () => request<PromptTemplate[]>('GET', '/api/admin/templates'),
  createTemplate: (input: TemplateInput & { id: string }) => request<PromptTemplate>('POST', '/api/admin/templates', input),
  updateTemplate: (id: string, patch: Partial<TemplateInput>) => request<PromptTemplate>('PATCH', `/api/admin/templates/${id}`, patch),
  backupNow: () => request<BackupEntry>('POST', '/api/admin/backups'),
};

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function formatTime(ts: number | null | undefined): string {
  if (!ts) return '—';
  const date = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
