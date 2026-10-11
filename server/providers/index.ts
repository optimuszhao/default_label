// 算子注册表：每个算子实例一行（operators 表），各自一个适配器对象。
// - 首次启动时把 .env 里的 PROVIDER / GEN_API_BASE / COMFY_APPID … 导入为「默认算子」，之后以后台为准
// - 每个实例独立做健康检查：在线时按 HEALTH_TTL_MS 刷新，掉线后按指数退避（最长 5 分钟）
// - 派发时按「可见性 → 能力 → 维护 / 健康 → 并发余量 → 优先级」挑一个算子
import { createHash } from 'node:crypto';
import { DEFAULT_CAPABILITIES, type Capabilities } from '../../shared/operator.ts';
import type { OperatorSummary, ProviderHealth, TaskType } from '../../shared/types.ts';
import { capabilityOf } from '../../shared/types.ts';
import { config } from '../config.ts';
import { db, newId, now, parseJson, type Row } from '../db.ts';
import { getMeta, setMetaValue } from '../migrate.ts';
import { logger } from '../log.ts';
import { deleteScope, getSecret, secretInfo, setSecret } from '../secrets.ts';
import { ComfyWebProvider } from './comfyweb.ts';
import { HttpProvider } from './http.ts';
import { llmConfigured, llmHealthy } from './llm.ts';
import { MockProvider } from './mock.ts';
import type { OperatorContext, OperatorSettings, Provider } from './types.ts';

export type OperatorKind = 'comfyweb' | 'http' | 'mock';

export interface OperatorRecord {
  id: string;
  name: string;
  kind: OperatorKind;
  baseUrl: string;
  appid: string;
  settings: OperatorSettings;
  enabled: boolean;
  maintenance: boolean;
  maintenanceNote: string | null;
  visibility: 'all' | 'admin_only';
  priority: number;
  maxInflight: number;
  createdAt: number;
  updatedAt: number;
}

interface HealthState {
  status: 'unknown' | 'online' | 'offline';
  image: boolean;
  video: boolean;
  message?: string;
  checkedAt: number;
  failures: number;
  nextCheckAt: number;
}

interface Entry {
  record: OperatorRecord;
  adapter: Provider;
  health: HealthState;
  inflight: Promise<void> | null;
}

const DEFAULT_SETTINGS: OperatorSettings = { imagePollMs: 4000, videoPollMs: 12000 };

function toRecord(row: Row): OperatorRecord {
  return {
    id: String(row.id),
    name: String(row.name),
    kind: row.kind as OperatorKind,
    baseUrl: String(row.base_url ?? ''),
    appid: String(row.appid ?? ''),
    settings: { ...DEFAULT_SETTINGS, ...parseJson<Partial<OperatorSettings>>(row.settings, {}) },
    enabled: Number(row.enabled) === 1,
    maintenance: Number(row.maintenance) === 1,
    maintenanceNote: (row.maintenance_note as string | null) ?? null,
    visibility: row.visibility === 'admin_only' ? 'admin_only' : 'all',
    priority: Number(row.priority),
    maxInflight: Number(row.max_inflight),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

export function createAdapter(record: Pick<OperatorRecord, 'id' | 'name' | 'kind' | 'baseUrl' | 'appid' | 'settings'>, secrets?: Record<string, string | null>): Provider {
  const scope = `operator:${record.id}`;
  const ctx: OperatorContext = {
    id: record.id,
    name: record.name,
    baseUrl: record.baseUrl.replace(/\/+$/, ''),
    appid: record.appid,
    settings: record.settings,
    // secrets 参数用于“测试连接”：配置还没保存时直接用表单里的值
    secret: (key) => (secrets && key in secrets ? secrets[key] : getSecret(scope, key)),
    saveSecret: (key, value) => {
      if (!secrets) setSecret(scope, key, value);
    },
  };
  switch (record.kind) {
    case 'comfyweb':
      return new ComfyWebProvider(ctx);
    case 'http':
      return new HttpProvider(ctx);
    default:
      return new MockProvider(ctx);
  }
}

const entries = new Map<string, Entry>();

/** 从数据库重新加载算子；配置没变的实例保留原对象（令牌、健康状态不丢） */
export function loadOperators(): void {
  const rows = db.prepare('SELECT * FROM operators ORDER BY priority DESC, created_at ASC').all() as Row[];
  const seen = new Set<string>();
  for (const row of rows) {
    const record = toRecord(row);
    seen.add(record.id);
    const existing = entries.get(record.id);
    const sameAdapter =
      existing &&
      existing.record.kind === record.kind &&
      existing.record.baseUrl === record.baseUrl &&
      existing.record.appid === record.appid &&
      existing.record.name === record.name &&
      JSON.stringify(existing.record.settings) === JSON.stringify(record.settings);
    if (existing && sameAdapter) {
      existing.record = record;
    } else {
      entries.set(record.id, {
        record,
        adapter: createAdapter(record),
        health: { status: 'unknown', image: false, video: false, checkedAt: 0, failures: 0, nextCheckAt: 0 },
        inflight: null,
      });
    }
  }
  for (const id of [...entries.keys()]) if (!seen.has(id)) entries.delete(id);
}

/** 密钥变化后（更换 Secret）需要重建适配器 */
export function resetOperator(id: string): void {
  entries.delete(id);
  loadOperators();
}

function envFingerprint(): string {
  return createHash('sha256')
    .update(JSON.stringify([config.provider, config.genApiBase, config.comfyAppId, config.comfySecret, config.genApiKey]))
    .digest('hex')
    .slice(0, 16);
}

/** 首次启动：把 .env 里的算子配置导入为默认算子；之后 env 变了只提示，不覆盖后台 */
export function importOperatorFromEnv(): void {
  const count = Number((db.prepare('SELECT COUNT(*) AS n FROM operators').get() as Row).n);
  if (count === 0 && !getMeta(db, 'operators_imported')) {
    const id = 'op_default';
    const kind = config.provider;
    const name = { comfyweb: '默认算子（ComfyUI）', http: '默认算子（HTTP）', mock: '模拟算子' }[kind];
    const ts = now();
    db.prepare(
      `INSERT INTO operators (id, name, kind, base_url, appid, settings, max_inflight, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      name,
      kind,
      config.genApiBase,
      config.comfyAppId,
      JSON.stringify({ imagePollMs: config.comfyImagePollMs, videoPollMs: config.comfyVideoPollMs }),
      config.maxRunning,
      ts,
      ts,
    );
    const scope = `operator:${id}`;
    if (config.comfySecret) setSecret(scope, 'secret', config.comfySecret);
    if (config.genApiKey) setSecret(scope, 'apiKey', config.genApiKey);
    if (config.comfyToken) setSecret(scope, 'token', JSON.stringify({ token: config.comfyToken, issuedAt: ts, expiresAt: null, basis: 'manual' }));
    setMetaValue(db, 'operators_imported', String(ts));
    setMetaValue(db, 'operators_env_fingerprint', envFingerprint());
    logger.info({ kind, base: config.genApiBase }, '已从环境变量导入默认算子，之后请在管理后台修改算子配置');
  } else if (getMeta(db, 'operators_env_fingerprint') && getMeta(db, 'operators_env_fingerprint') !== envFingerprint()) {
    envDrift = true;
    logger.warn('环境变量里的算子配置和后台不一致：算子以管理后台为准，环境变量的改动不会生效');
  }
}

/** env 里的算子配置是否和后台不一致（后台显示一次提示） */
export let envDrift = false;

// ---------------- 健康检查 ----------------

async function checkEntry(entry: Entry, force = false): Promise<void> {
  if (!force && Date.now() < entry.health.nextCheckAt) return;
  entry.inflight ??= (async () => {
    try {
      const result = await entry.adapter.health();
      const up = result.image || result.video;
      const failures = up ? 0 : entry.health.failures + 1;
      entry.health = {
        status: up ? 'online' : 'offline',
        image: result.image,
        video: result.video,
        message: result.message,
        checkedAt: Date.now(),
        failures,
        // 掉线后退避：TTL × 2^(n-1)，最长 5 分钟
        nextCheckAt: Date.now() + (up ? config.healthTtlMs : Math.min(config.healthTtlMs * 2 ** (failures - 1), 300_000)),
      };
    } catch (error) {
      const failures = entry.health.failures + 1;
      entry.health = {
        status: 'offline',
        image: false,
        video: false,
        message: (error as Error).message,
        checkedAt: Date.now(),
        failures,
        nextCheckAt: Date.now() + Math.min(config.healthTtlMs * 2 ** (failures - 1), 300_000),
      };
    }
  })().finally(() => {
    entry.inflight = null;
  });
  await entry.inflight;
}

let llmState = { ok: false, checkedAt: 0 };

async function llmAvailable(force: boolean): Promise<boolean> {
  if (!llmConfigured()) {
    // 没配语言模型时，模拟算子自带模拟写作助手（开发和演示用）；LLM_MOCK=1 时也用模拟助手
    return config.llmMock || [...entries.values()].some((entry) => entry.record.kind === 'mock' && entry.record.enabled);
  }
  if (force || Date.now() - llmState.checkedAt > config.healthTtlMs * 3) {
    llmState = { ok: await llmHealthy(), checkedAt: Date.now() };
  }
  return llmState.ok;
}

export function useMockAssist(): boolean {
  return !llmConfigured() && (config.llmMock || [...entries.values()].some((entry) => entry.record.kind === 'mock' && entry.record.enabled));
}

function usable(entry: Entry, isAdmin: boolean): boolean {
  return entry.record.enabled && !entry.record.maintenance && (isAdmin || entry.record.visibility === 'all');
}

/**
 * 汇总健康状态：任一可用算子能出图 / 出视频就算可用。
 * detailed=false 时（普通用户）不返回算子的报错细节和地址。
 */
export async function getHealth(force = false, detailed = true, isAdmin = false): Promise<ProviderHealth> {
  const list = [...entries.values()].filter((entry) => usable(entry, isAdmin));
  await Promise.all(list.map((entry) => checkEntry(entry, force)));
  const llm = await llmAvailable(force);
  const image = list.some((entry) => entry.health.image);
  const video = list.some((entry) => entry.health.video);
  const maintenance = [...entries.values()].find((entry) => entry.record.enabled && entry.record.maintenance);
  let message: string | undefined;
  if (!list.length) message = maintenance?.record.maintenanceNote ? `算力维护中：${maintenance.record.maintenanceNote}` : '暂无可用算力';
  else if (!image && !video) message = detailed ? list.map((entry) => `${entry.record.name}：${entry.health.message ?? '不可用'}`).join('；') : '算力暂时不可用';
  if (!llm && !message) message = '未配置语言模型，AI 写作助手不可用';
  return {
    provider: list.map((entry) => entry.record.name).join('、') || '无',
    image,
    video,
    llm,
    checkedAt: Date.now(),
    message,
  };
}

/** 提交失败时立刻把这个算子标记为不可用，等下一次健康检查再恢复 */
export function markUnavailable(operatorId: string, message: string): void {
  const entry = entries.get(operatorId);
  if (!entry) return;
  const failures = entry.health.failures + 1;
  entry.health = {
    ...entry.health,
    status: 'offline',
    image: false,
    video: false,
    message,
    failures,
    nextCheckAt: Date.now() + Math.min(config.healthTtlMs * 2 ** (failures - 1), 300_000),
  };
}

// ---------------- 能力与派发 ----------------

function adapterCaps(entry: Entry): Capabilities {
  return entry.adapter.capabilities?.() ?? { ...DEFAULT_CAPABILITIES, operator: entry.record.kind };
}

/** 创作台用的能力声明：图片、视频分别取优先级最高的可用算子 */
export function capabilities(isAdmin = false): Capabilities {
  const list = listEntries().filter((entry) => usable(entry, isAdmin));
  const primary = list[0];
  if (!primary) return DEFAULT_CAPABILITIES;
  const caps = adapterCaps(primary);
  return { ...caps, operator: primary.record.kind };
}

export interface PickResult {
  entry: Entry | null;
  /** 没挑到时的原因：busy = 都满了（继续排队，不提示），unavailable = 没有可用算子 */
  reason: 'ok' | 'busy' | 'unavailable';
  message?: string;
}

export async function pickOperator(type: TaskType, isAdmin: boolean, running: Map<string, number>): Promise<PickResult> {
  const capability = capabilityOf(type);
  const list = [...entries.values()].filter((entry) => usable(entry, isAdmin));
  if (!list.length) return { entry: null, reason: 'unavailable', message: '暂无可用算力' };
  await Promise.all(list.map((entry) => checkEntry(entry)));
  const healthy = list.filter((entry) => entry.health[capability as 'image' | 'video']);
  if (!healthy.length) {
    return {
      entry: null,
      reason: 'unavailable',
      message: list.map((entry) => entry.health.message).find(Boolean) ?? '算力暂时不可用',
    };
  }
  const free = healthy
    .filter((entry) => (running.get(entry.record.id) ?? 0) < entry.record.maxInflight)
    .sort((a, b) => b.record.priority - a.record.priority || (running.get(a.record.id) ?? 0) - (running.get(b.record.id) ?? 0));
  return free.length ? { entry: free[0], reason: 'ok' } : { entry: null, reason: 'busy' };
}

/** 运行中的任务用当初提交它的算子查询；老任务没有记录算子时用第一个 */
export function getAdapter(operatorId: string | null): Provider | null {
  if (operatorId) return entries.get(operatorId)?.adapter ?? null;
  return [...entries.values()][0]?.adapter ?? null;
}

export function getEntry(id: string): Entry | undefined {
  return entries.get(id);
}

/** 按优先级从高到低、同优先级按创建时间 */
export function listEntries(): Entry[] {
  return [...entries.values()].sort((a, b) => b.record.priority - a.record.priority || a.record.createdAt - b.record.createdAt);
}

/** 后台列表用的摘要 */
export function summarize(entry: Entry, running: number): OperatorSummary {
  const { record } = entry;
  const token = entry.adapter.tokenStatus?.();
  return {
    id: record.id,
    name: record.name,
    kind: record.kind,
    baseUrl: record.baseUrl,
    appid: record.appid,
    enabled: record.enabled,
    maintenance: record.maintenance,
    maintenanceNote: record.maintenanceNote,
    visibility: record.visibility,
    priority: record.priority,
    maxInflight: record.maxInflight,
    settings: record.settings,
    running,
    status: !record.enabled ? 'disabled' : record.maintenance ? 'maintenance' : entry.health.status,
    health: { image: entry.health.image, video: entry.health.video, message: entry.health.message ?? null, checkedAt: entry.health.checkedAt || null },
    secret: secretInfo(`operator:${record.id}`, record.kind === 'http' ? 'apiKey' : 'secret'),
    tokenExpiresAt: token?.expiresAt ?? null,
    tokenOk: token?.lastVerifyOk ?? null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export function deleteOperatorSecrets(id: string): void {
  deleteScope(`operator:${id}`);
}

export function newOperatorId(): string {
  return newId('op_');
}

export * from './types.ts';
