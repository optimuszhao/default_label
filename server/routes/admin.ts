// 超级管理后台接口：只有管理员能访问，其他人一律 404。所有写操作都记审计日志。
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { OperatorTestStep, TokenStatus } from '../../shared/types.ts';
import { audit } from '../audit.ts';
import { requireAdmin } from '../auth.ts';
import { backupNow, listBackups } from '../backup.ts';
import { allPresets, allTemplates, invalidateCatalog, templateScores } from '../catalog.ts';
import { publish } from '../bus.ts';
import { config } from '../config.ts';
import { db, migration, now, type Row } from '../db.ts';
import {
  createAdapter,
  deleteOperatorSecrets,
  envDrift,
  getEntry,
  getHealth,
  listEntries,
  loadOperators,
  newOperatorId,
  resetOperator,
  summarize,
  type OperatorRecord,
  type Provider,
} from '../providers/index.ts';
import { getTask, toTask, toUser } from '../repo.ts';
import { kickScheduler } from '../scheduler.ts';
import { toJob } from '../jobs/runner.ts';
import { purgeTrash, startLibraryBackfill } from '../library/derive.ts';
import { getSecret, masterKeySource, setSecret } from '../secrets.ts';
import { bad, parse } from './common.ts';

const startedAt = Date.now();

function runningCounts(): Map<string, number> {
  const map = new Map<string, number>();
  for (const row of db.prepare("SELECT operator_id, COUNT(*) AS n FROM tasks WHERE status = 'running' GROUP BY operator_id").all() as Row[]) {
    map.set(String(row.operator_id), Number(row.n));
  }
  return map;
}

function diskInfo(dir: string): { free: number; total: number } | null {
  try {
    const stat = fs.statfsSync(dir);
    return { free: stat.bavail * stat.bsize, total: stat.blocks * stat.bsize };
  } catch {
    return null;
  }
}

function broadcastHealth(): void {
  void getHealth(true, false, false).then((health) => publish('*', { type: 'health', health }));
}

// 字段定义不带默认值：PATCH 时没传的字段保持原样；新建时再补默认值
const operatorFields = {
  name: z.string().trim().min(1, '请填写名称').max(40),
  kind: z.enum(['comfyweb', 'http', 'mock']),
  baseUrl: z
    .string()
    .trim()
    .max(300)
    .refine((value) => value === '' || /^https?:\/\/[^\s/]+/i.test(value), '地址必须是 http:// 或 https:// 开头')
    .transform((value) => value.replace(/\/+$/, '')),
  appid: z.string().trim().max(200),
  /** 不传表示不修改；传空字符串表示清除 */
  secret: z.string().max(500),
  apiKey: z.string().max(500),
  enabled: z.boolean(),
  maintenance: z.boolean(),
  maintenanceNote: z.string().max(200).nullable(),
  visibility: z.enum(['all', 'admin_only']),
  priority: z.number().int().min(-100).max(100),
  maxInflight: z.number().int().min(1).max(32),
  settings: z.object({
    imagePollMs: z.number().int().min(500).max(600_000).default(4000),
    videoPollMs: z.number().int().min(500).max(600_000).default(12000),
    /** 算子自带语言模型：用哪个模型（空 = 对方默认）、是否允许先"思考"（更慢） */
    llmModel: z.string().trim().max(120).optional(),
    llmThink: z.boolean().optional(),
  }),
};

const operatorSchema = z.object({
  ...operatorFields,
  appid: operatorFields.appid.default(''),
  secret: operatorFields.secret.optional(),
  apiKey: operatorFields.apiKey.optional(),
  enabled: operatorFields.enabled.default(true),
  maintenance: operatorFields.maintenance.default(false),
  maintenanceNote: operatorFields.maintenanceNote.default(null),
  visibility: operatorFields.visibility.default('all'),
  priority: operatorFields.priority.default(0),
  maxInflight: operatorFields.maxInflight.default(2),
  settings: operatorFields.settings.default({ imagePollMs: 4000, videoPollMs: 12000 }),
});

const operatorPatchSchema = z.object(operatorFields).partial();

function saveOperatorSecrets(id: string, body: { secret?: string; apiKey?: string }): void {
  const scope = `operator:${id}`;
  if (body.secret !== undefined) setSecret(scope, 'secret', body.secret || null);
  if (body.apiKey !== undefined) setSecret(scope, 'apiKey', body.apiKey || null);
}

/** 测试连接：依次检查网络、令牌、能力、远端队列，可选试跑一张图 */
async function testOperator(
  record: Pick<OperatorRecord, 'id' | 'name' | 'kind' | 'baseUrl' | 'appid' | 'settings'>,
  secrets: Record<string, string | null>,
  generate: boolean,
): Promise<OperatorTestStep[]> {
  const steps: OperatorTestStep[] = [];
  const run = async (key: string, label: string, fn: () => Promise<string | null>) => {
    const started = Date.now();
    try {
      const message = await fn();
      steps.push({ key, label, ok: message === null ? null : true, message: message ?? '跳过', ms: Date.now() - started });
      return true;
    } catch (error) {
      steps.push({ key, label, ok: false, message: (error as Error).message, ms: Date.now() - started });
      return false;
    }
  };
  // 测试用临时实例：使用表单里的密钥，不写库、不影响正在运行的实例
  const adapter: Provider = createAdapter(record, { ...secrets, token: null });

  const online = await run('network', '网络连通', async () => {
    if (record.kind === 'mock') return '模拟算子，无需网络';
    if (!record.baseUrl) throw new Error('没有填写服务地址');
    const started = Date.now();
    const response = await fetch(`${record.baseUrl}/health`, { signal: AbortSignal.timeout(8000) }).catch((error: Error) => {
      throw new Error(`连不上：${error.message}`);
    });
    const ms = Date.now() - started;
    if (response.status === 404) return `在线 · ${ms} ms（没有 /health 接口，改用令牌校验判断）`;
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return `在线 · ${ms} ms`;
  });
  if (!online) return steps;

  let tokenOk = true;
  if (adapter.renewToken) {
    tokenOk = await run('login', '换取令牌', async () => {
      const status = await adapter.renewToken!();
      if (!status.hasToken) throw new Error(status.lastLoginError ?? status.lastVerifyMessage ?? '登录失败');
      const basis = { jwt: 'JWT exp', assumed: '按文档 72 小时推算', manual: '手动', env: '手动' }[status.expiresBasis ?? 'assumed'];
      return status.expiresAt ? `有效期至 ${new Date(status.expiresAt).toLocaleString('zh-CN')}（依据：${basis}）` : '已获取';
    });
    if (tokenOk) {
      tokenOk = await run('verify', '校验令牌', async () => {
        const status = await adapter.verifyToken!();
        if (!status.lastVerifyOk) throw new Error(status.lastVerifyMessage ?? '校验失败');
        return status.lastVerifyMessage ?? '有效';
      });
    }
  } else {
    await run('login', '换取令牌', async () => null);
  }
  if (!tokenOk) return steps;

  await run('capabilities', '读取能力', async () => {
    const health = await adapter.health();
    const caps = adapter.capabilities?.();
    const kinds = [health.image && '图片', health.video && '视频'].filter(Boolean).join(' / ') || '无';
    return `可用：${kinds}${caps ? `；参考图最多 ${caps.image.maxReferences} 张，视频 ${caps.video.durations.join('/')} 秒` : ''}`;
  });

  await run('remote', '远端队列', async () => {
    if (!adapter.listRemote) return null;
    const list = (await adapter.listRemote()) as { status?: string }[];
    const active = list.filter((item) => ['pending', 'running', 'postprocessing'].includes(String(item.status))).length;
    return `最近 ${list.length} 条中有 ${active} 条正在进行`;
  });

  if (generate) {
    await run('generate', '试跑一张图', async () => {
      const started = Date.now();
      const { jobId } = await adapter.submit({
        taskId: `admin-test-${Date.now()}`,
        type: 't2i',
        prompt: '一只橘猫坐在窗台上，晨光，测试图',
        negativePrompt: '',
        params: { aspectRatio: '1:1', resolution: '1k', width: 512, height: 512, count: 1, seed: 1, steps: 10 },
        images: [],
      });
      for (;;) {
        const status = await adapter.poll(jobId);
        if (status.state === 'failed') throw new Error(status.error ?? '生成失败');
        if (status.state === 'succeeded') {
          const output = status.outputs?.[0];
          let preview = '';
          if (output?.filePath) {
            const data = fs.readFileSync(output.filePath);
            fs.rmSync(output.filePath, { force: true });
            if (data.length < 4 * 1024 * 1024) preview = `data:${output.mime};base64,${data.toString('base64')}`;
          } else if (output?.base64) {
            preview = `data:${output.mime};base64,${output.base64}`;
          }
          steps.push({ key: 'preview', label: '预览', ok: true, message: preview, ms: 0 });
          return `完成，用时 ${((Date.now() - started) / 1000).toFixed(1)} 秒`;
        }
        if (Date.now() - started > 180_000) throw new Error('3 分钟内没有完成');
        await new Promise((resolve) => setTimeout(resolve, adapter.pollIntervalMs?.(jobId) ?? 1500));
      }
    });
  }
  return steps;
}

function operatorById(request: FastifyRequest) {
  const { id } = request.params as { id: string };
  return getEntry(id);
}

export async function adminRoutes(admin: FastifyInstance): Promise<void> {
  admin.addHook('preHandler', requireAdmin);

  // ---- 概览 ----
  admin.get('/api/admin/overview', async () => {
    const count = (sql: string, ...args: (string | number)[]) => Number((db.prepare(sql).get(...args) as Row).n);
    const since = now() - 24 * 3600_000;
    const running = runningCounts();
    const byStatus: Record<string, number> = {};
    for (const row of db.prepare('SELECT status, COUNT(*) AS n FROM tasks GROUP BY status').all() as Row[]) byStatus[String(row.status)] = Number(row.n);
    const dbFile = path.join(config.dataDir, 'weave.db');
    const failures = (
      db
        .prepare(
          `SELECT t.id, t.title, t.type, t.last_error, t.finished_at, u.email FROM tasks t JOIN users u ON u.id = t.user_id
           WHERE t.status = 'failed' ORDER BY t.finished_at DESC LIMIT 8`,
        )
        .all() as Row[]
    ).map((row) => ({ id: String(row.id), title: String(row.title), type: String(row.type), error: row.last_error, at: row.finished_at, email: row.email }));
    const backups = listBackups();
    return {
      version: config.appVersion,
      gitSha: config.gitSha || null,
      node: process.version,
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      masterKeySource,
      envDrift,
      migrations: migration.applied,
      counts: {
        users: count('SELECT COUNT(*) AS n FROM users'),
        stories: count('SELECT COUNT(*) AS n FROM stories'),
        assets: count('SELECT COUNT(*) AS n FROM assets'),
        tasks: byStatus,
        succeeded24h: count("SELECT COUNT(*) AS n FROM tasks WHERE status = 'succeeded' AND finished_at > ?", since),
        failed24h: count("SELECT COUNT(*) AS n FROM tasks WHERE status = 'failed' AND finished_at > ?", since),
      },
      operators: listEntries().map((entry) => summarize(entry, running.get(entry.record.id) ?? 0)),
      disk: { data: diskInfo(config.dataDir), media: diskInfo(config.mediaDir) },
      dbBytes: fs.existsSync(dbFile) ? fs.statSync(dbFile).size : 0,
      lastBackup: backups[0] ? { name: backups[0].name, bytes: backups[0].bytes, createdAt: backups[0].createdAt } : null,
      backupAt: config.backupAt,
      failures,
    };
  });

  // ---- 算子 ----
  admin.get('/api/admin/operators', async () => {
    const running = runningCounts();
    await getHealth(false, true, true);
    return listEntries().map((entry) => summarize(entry, running.get(entry.record.id) ?? 0));
  });

  admin.post('/api/admin/operators', async (request, reply) => {
    const body = parse(operatorSchema, request.body, reply);
    if (!body) return;
    const id = newOperatorId();
    const ts = now();
    db.prepare(
      `INSERT INTO operators (id, name, kind, base_url, appid, settings, enabled, maintenance, maintenance_note, visibility, priority, max_inflight, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      body.name,
      body.kind,
      body.baseUrl,
      body.appid,
      JSON.stringify(body.settings),
      body.enabled ? 1 : 0,
      body.maintenance ? 1 : 0,
      body.maintenanceNote,
      body.visibility,
      body.priority,
      body.maxInflight,
      ts,
      ts,
    );
    saveOperatorSecrets(id, body);
    loadOperators();
    audit(request, 'operator.create', id, `${body.name}（${body.kind}）${body.baseUrl}`);
    broadcastHealth();
    kickScheduler();
    return summarize(getEntry(id)!, 0);
  });

  admin.patch('/api/admin/operators/:id', async (request, reply) => {
    const entry = operatorById(request);
    if (!entry) return bad(reply, '算子不存在', 404);
    const body = parse(operatorPatchSchema, request.body, reply);
    if (!body) return;
    const r = entry.record;
    const next = {
      name: body.name ?? r.name,
      kind: body.kind ?? r.kind,
      baseUrl: body.baseUrl ?? r.baseUrl,
      appid: body.appid ?? r.appid,
      settings: body.settings ?? r.settings,
      enabled: body.enabled ?? r.enabled,
      maintenance: body.maintenance ?? r.maintenance,
      maintenanceNote: body.maintenanceNote !== undefined ? body.maintenanceNote : r.maintenanceNote,
      visibility: body.visibility ?? r.visibility,
      priority: body.priority ?? r.priority,
      maxInflight: body.maxInflight ?? r.maxInflight,
    };
    db.prepare(
      `UPDATE operators SET name = ?, kind = ?, base_url = ?, appid = ?, settings = ?, enabled = ?, maintenance = ?, maintenance_note = ?,
         visibility = ?, priority = ?, max_inflight = ?, updated_at = ? WHERE id = ?`,
    ).run(
      next.name,
      next.kind,
      next.baseUrl,
      next.appid,
      JSON.stringify(next.settings),
      next.enabled ? 1 : 0,
      next.maintenance ? 1 : 0,
      next.maintenanceNote,
      next.visibility,
      next.priority,
      next.maxInflight,
      now(),
      r.id,
    );
    const credentialsChanged = body.secret !== undefined || body.apiKey !== undefined || next.appid !== r.appid || next.baseUrl !== r.baseUrl;
    saveOperatorSecrets(r.id, body);
    if (credentialsChanged) {
      // 凭证变了：旧令牌作废，重建实例
      setSecret(`operator:${r.id}`, 'token', null);
      resetOperator(r.id);
    } else {
      loadOperators();
    }
    const changes = Object.keys(body)
      .map((key) => (key === 'secret' || key === 'apiKey' ? `${key}=已更换` : key))
      .join('、');
    audit(request, 'operator.update', r.id, `${next.name}：${changes}`);
    broadcastHealth();
    kickScheduler();
    return summarize(getEntry(r.id)!, runningCounts().get(r.id) ?? 0);
  });

  admin.delete('/api/admin/operators/:id', async (request, reply) => {
    const entry = operatorById(request);
    if (!entry) return bad(reply, '算子不存在', 404);
    if (runningCounts().get(entry.record.id)) return bad(reply, '还有正在这个算子上运行的任务，请先等它们完成或取消', 409);
    db.prepare('DELETE FROM operators WHERE id = ?').run(entry.record.id);
    deleteOperatorSecrets(entry.record.id);
    loadOperators();
    audit(request, 'operator.delete', entry.record.id, entry.record.name);
    broadcastHealth();
    return { ok: true };
  });

  // 测试连接：新建时用表单里的值；已有算子不填密钥时用已保存的
  admin.post('/api/admin/operators/test', async (request, reply) => {
    const body = parse(
      operatorSchema.pick({ name: true, kind: true, baseUrl: true, appid: true, secret: true, apiKey: true, settings: true }).extend({
        operatorId: z.string().optional(),
        generate: z.boolean().default(false),
      }),
      request.body,
      reply,
    );
    if (!body) return;
    const scope = body.operatorId ? `operator:${body.operatorId}` : null;
    const secrets = {
      secret: body.secret ?? (scope ? getSecret(scope, 'secret') : null),
      apiKey: body.apiKey ?? (scope ? getSecret(scope, 'apiKey') : null),
    };
    const steps = await testOperator(
      { id: body.operatorId ?? 'draft', name: body.name, kind: body.kind, baseUrl: body.baseUrl, appid: body.appid, settings: body.settings },
      secrets,
      body.generate,
    );
    audit(request, 'operator.test', body.operatorId ?? null, `${body.name}：${steps.map((s) => `${s.label}${s.ok === false ? '✗' : '✓'}`).join(' ')}`);
    return steps;
  });

  // ---- 令牌 ----
  const unsupported = (name: string): TokenStatus => ({ supported: false, operator: name });

  admin.get('/api/admin/operators/:id/token', async (request, reply) => {
    const entry = operatorById(request);
    if (!entry) return bad(reply, '算子不存在', 404);
    return entry.adapter.tokenStatus?.() ?? unsupported(entry.record.name);
  });

  admin.post('/api/admin/operators/:id/token/:action', async (request, reply) => {
    const entry = operatorById(request);
    if (!entry) return bad(reply, '算子不存在', 404);
    const { action } = request.params as { action: string };
    const { adapter, record } = entry;
    if (!adapter.tokenStatus) return unsupported(record.name);
    let result: TokenStatus | { token: string | null };
    switch (action) {
      case 'verify':
        result = await adapter.verifyToken!();
        break;
      case 'renew':
        result = await adapter.renewToken!();
        break;
      case 'clear':
        result = adapter.clearToken!();
        break;
      case 'manual': {
        const body = parse(z.object({ token: z.string().trim().min(8).max(4000) }), request.body, reply);
        if (!body) return;
        result = adapter.setManualToken!(body.token);
        break;
      }
      case 'reveal':
        // 查看明文令牌：只返回给管理员，前端 30 秒后自动隐藏
        result = { token: adapter.revealToken?.() ?? null };
        break;
      default:
        return bad(reply, '未知操作', 404);
    }
    audit(request, `token.${action}`, record.id, record.name);
    if (action !== 'reveal') broadcastHealth();
    return result;
  });

  admin.get('/api/admin/operators/:id/remote', async (request, reply) => {
    const entry = operatorById(request);
    if (!entry) return bad(reply, '算子不存在', 404);
    if (!entry.adapter.listRemote) return [];
    try {
      return await entry.adapter.listRemote();
    } catch (error) {
      return bad(reply, `读取远端任务失败：${(error as Error).message}`, 502);
    }
  });

  // ---- 全局任务 ----
  admin.get('/api/admin/tasks', async (request) => {
    const query = request.query as { status?: string; q?: string; operator?: string; limit?: string };
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (query.status) {
      const list = query.status.split(',').filter(Boolean);
      where.push(`t.status IN (${list.map(() => '?').join(',')})`);
      args.push(...list);
    }
    if (query.operator) {
      where.push('t.operator_id = ?');
      args.push(query.operator);
    }
    if (query.q) {
      where.push('(t.id = ? OR u.email LIKE ? OR t.prompt LIKE ?)');
      args.push(query.q, `%${query.q}%`, `%${query.q}%`);
    }
    const limit = Math.min(Number(query.limit) || 200, 1000);
    const rows = db
      .prepare(
        `SELECT t.*, u.email AS user_email FROM tasks t JOIN users u ON u.id = t.user_id
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY t.created_at DESC LIMIT ${limit}`,
      )
      .all(...args) as Row[];
    return rows.map((row) => ({
      ...toTask(row),
      userEmail: String(row.user_email),
      operatorId: (row.operator_id as string | null) ?? null,
      operatorName: row.operator_id ? (getEntry(String(row.operator_id))?.record.name ?? '已删除的算子') : null,
    }));
  });

  admin.post('/api/admin/tasks/:id/:action', async (request, reply) => {
    const { id, action } = request.params as { id: string; action: string };
    const task = getTask(id);
    if (!task) return bad(reply, '任务不存在', 404);
    if (action === 'cancel') {
      if (!['queued', 'paused', 'running'].includes(task.status)) return task;
      db.prepare("UPDATE tasks SET status = 'canceled', manual_kick = 0, provider_job_id = NULL, finished_at = ?, updated_at = ? WHERE id = ?").run(now(), now(), id);
    } else if (action === 'retry') {
      if (!['failed', 'canceled'].includes(task.status)) return bad(reply, '只有失败或已取消的任务可以重试');
      db.prepare(
        "UPDATE tasks SET status = 'queued', attempts = 0, last_error = NULL, wait_reason = NULL, finished_at = NULL, next_attempt_at = 0, manual_kick = 1, updated_at = ? WHERE id = ?",
      ).run(now(), id);
      kickScheduler();
    } else if (action === 'top') {
      db.prepare('UPDATE tasks SET priority = 10, manual_kick = 1, next_attempt_at = 0, updated_at = ? WHERE id = ?').run(now(), id);
      kickScheduler();
    } else {
      return bad(reply, '未知操作', 404);
    }
    audit(request, `task.${action}`, id, task.title);
    const fresh = getTask(id)!;
    const owner = db.prepare('SELECT user_id FROM tasks WHERE id = ?').get(id) as Row;
    publish(String(owner.user_id), { type: 'task', task: fresh });
    return fresh;
  });

  // ---- 用户 ----
  admin.get('/api/admin/users', async (request) => {
    const { q } = request.query as { q?: string };
    const rows = db
      .prepare(
        `SELECT u.*,
           (SELECT COUNT(*) FROM tasks t WHERE t.user_id = u.id) AS task_count,
           (SELECT COUNT(*) FROM assets a WHERE a.user_id = u.id) AS asset_count,
           (SELECT COUNT(*) FROM stories s WHERE s.user_id = u.id) AS story_count
         FROM users u ${q ? 'WHERE u.email LIKE ? OR u.name LIKE ?' : ''} ORDER BY u.created_at DESC LIMIT 500`,
      )
      .all(...(q ? [`%${q}%`, `%${q}%`] : [])) as Row[];
    return rows.map((row) => ({
      ...toUser(row),
      role: String(row.role),
      disabled: Boolean(row.disabled_at),
      lastLoginAt: row.last_login_at == null ? null : Number(row.last_login_at),
      taskCount: Number(row.task_count),
      assetCount: Number(row.asset_count),
      storyCount: Number(row.story_count),
    }));
  });

  admin.patch('/api/admin/users/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = parse(z.object({ role: z.enum(['user', 'admin']).optional(), disabled: z.boolean().optional() }), request.body, reply);
    if (!body) return;
    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as Row | undefined;
    if (!row) return bad(reply, '用户不存在', 404);
    const admins = Number((db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled_at IS NULL").get() as Row).n);
    const losingAdmin = row.role === 'admin' && !row.disabled_at && (body.role === 'user' || body.disabled === true);
    if (losingAdmin && admins <= 1) return bad(reply, '至少要保留一位可用的超级管理员', 409);
    if (body.role) db.prepare('UPDATE users SET role = ? WHERE id = ?').run(body.role, id);
    if (body.disabled !== undefined) {
      db.prepare('UPDATE users SET disabled_at = ? WHERE id = ?').run(body.disabled ? now() : null, id);
      if (body.disabled) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    }
    audit(request, 'user.update', id, `${String(row.email)}：${JSON.stringify(body)}`);
    return { ok: true };
  });

  // ---- 审计日志 ----
  admin.get('/api/admin/audit', async (request) => {
    const { limit } = request.query as { limit?: string };
    const rows = db
      .prepare(`SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT ${Math.min(Number(limit) || 200, 1000)}`)
      .all() as Row[];
    return rows.map((row) => ({
      id: String(row.id),
      actorEmail: (row.actor_email as string | null) ?? null,
      action: String(row.action),
      target: (row.target as string | null) ?? null,
      summary: String(row.summary),
      createdAt: Number(row.created_at),
    }));
  });

  // ---- 预设与模板（内容管理） ----
  admin.get('/api/admin/presets', async () => allPresets());

  admin.patch('/api/admin/presets/:slug', async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const body = parse(
      z.object({
        name: z.string().trim().min(1).max(30).optional(),
        prompt: z.string().max(500).optional(),
        negative: z.string().max(500).nullable().optional(),
        fallbackPrompt: z.string().max(300).nullable().optional(),
        hint: z.string().max(60).nullable().optional(),
        enabled: z.boolean().optional(),
        sort: z.number().int().optional(),
      }),
      request.body,
      reply,
    );
    if (!body) return;
    const current = allPresets().find((preset) => preset.slug === slug);
    if (!current) return bad(reply, '预设不存在', 404);
    db.prepare(
      `UPDATE presets SET name = ?, prompt = ?, negative = ?, fallback_prompt = ?, hint = ?, enabled = ?, sort = ?, customized = 1, updated_at = ? WHERE slug = ?`,
    ).run(
      body.name ?? current.name,
      body.prompt ?? current.prompt,
      body.negative !== undefined ? body.negative : (current.negative ?? null),
      body.fallbackPrompt !== undefined ? body.fallbackPrompt : (current.fallbackPrompt ?? null),
      body.hint !== undefined ? body.hint : (current.hint ?? null),
      (body.enabled ?? current.enabled) ? 1 : 0,
      body.sort ?? current.sort,
      now(),
      slug,
    );
    invalidateCatalog();
    audit(request, 'preset.update', slug, `${current.name}：${Object.keys(body).join('、')}`);
    return allPresets().find((preset) => preset.slug === slug);
  });

  admin.get('/api/admin/templates', async () => {
    const scores = templateScores();
    return allTemplates().map((template) => ({ ...template, hot: scores.get(template.id)?.hot ?? 0, uses: scores.get(template.id)?.uses ?? 0 }));
  });

  const templateFields = {
    name: z.string().trim().min(1).max(30),
    category: z.string().trim().max(12),
    description: z.string().max(80),
    mode: z.enum(['image', 'video']),
    body: z.string().trim().min(1).max(1000),
    variables: z
      .array(
        z.object({
          key: z.string().min(1).max(16),
          label: z.string().min(1).max(16),
          default: z.string().max(100).optional(),
          placeholder: z.string().max(100).optional(),
          options: z.array(z.string().max(30)).max(12).optional(),
        }),
      )
      .max(10),
    negative: z.string().max(500),
    presets: z.array(z.string().max(80)).max(20),
    params: z.object({ aspectRatio: z.string().max(10).optional(), duration: z.number().optional(), count: z.number().int().min(1).max(4).optional() }),
    requiresReference: z.boolean(),
    featured: z.boolean(),
    enabled: z.boolean(),
    sort: z.number().int(),
    cover: z.string().max(40).nullable(),
  };

  function writeTemplate(id: string, t: z.infer<z.ZodObject<typeof templateFields>>, created: boolean): void {
    const ts = now();
    db.prepare(
      `INSERT INTO prompt_templates (id, name, category, description, mode, body, variables, negative, presets, params, requires_reference, featured, cover, sort, enabled, customized, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, category = excluded.category, description = excluded.description, mode = excluded.mode,
         body = excluded.body, variables = excluded.variables, negative = excluded.negative, presets = excluded.presets, params = excluded.params,
         requires_reference = excluded.requires_reference, featured = excluded.featured, cover = excluded.cover, sort = excluded.sort,
         enabled = excluded.enabled, customized = 1, updated_at = excluded.updated_at`,
    ).run(
      id,
      t.name,
      t.category,
      t.description,
      t.mode,
      t.body,
      JSON.stringify(t.variables),
      t.negative,
      JSON.stringify(t.presets),
      JSON.stringify(t.params),
      t.requiresReference ? 1 : 0,
      t.featured ? 1 : 0,
      t.cover,
      t.sort,
      t.enabled ? 1 : 0,
      created ? ts : ts,
      ts,
    );
    invalidateCatalog();
  }

  admin.post('/api/admin/templates', async (request, reply) => {
    const body = parse(
      z.object({
        ...templateFields,
        id: z.string().regex(/^[a-z0-9-]{2,40}$/, 'id 只能是小写字母、数字和横线'),
        variables: templateFields.variables.default([]),
        negative: templateFields.negative.default(''),
        presets: templateFields.presets.default([]),
        params: templateFields.params.default({}),
        requiresReference: templateFields.requiresReference.default(false),
        featured: templateFields.featured.default(false),
        enabled: templateFields.enabled.default(true),
        sort: templateFields.sort.default(999),
        cover: templateFields.cover.default(null),
        category: templateFields.category.default('我的'),
        description: templateFields.description.default(''),
      }),
      request.body,
      reply,
    );
    if (!body) return;
    if (allTemplates().some((template) => template.id === body.id)) return bad(reply, '模板 id 已存在', 409);
    const { id, ...fields } = body;
    writeTemplate(id, fields, true);
    audit(request, 'template.create', id, body.name);
    return allTemplates().find((template) => template.id === id);
  });

  admin.patch('/api/admin/templates/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const current = allTemplates().find((template) => template.id === id);
    if (!current) return bad(reply, '模板不存在', 404);
    const body = parse(z.object(templateFields).partial(), request.body, reply);
    if (!body) return;
    writeTemplate(id, { ...current, cover: current.cover ?? null, ...body }, false);
    audit(request, 'template.update', id, `${current.name}：${Object.keys(body).join('、')}`);
    return allTemplates().find((template) => template.id === id);
  });

  // ---- 备份 ----
  admin.get('/api/admin/backups', async () => listBackups().map(({ name, bytes, createdAt }) => ({ name, bytes, createdAt })));
  admin.post('/api/admin/backups', async (request) => {
    const { name, bytes, createdAt } = await backupNow();
    audit(request, 'backup.create', name, '');
    return { name, bytes, createdAt };
  });

  // ---- 资产库维护 ----
  /** 立即清理：回收站里过期的素材、24 小时没传完的分片 */
  admin.post('/api/admin/library/cleanup', async (request) => {
    const purged = await purgeTrash();
    audit(request, 'library.cleanup', null, `彻底删除 ${purged} 个过期素材`);
    return { purged };
  });

  /** 重新生成全部缩略图和封面（换了带 ffmpeg 的镜像之后用） */
  admin.post('/api/admin/library/rederive', async (request) => {
    const result = db.prepare("UPDATE assets SET derive_state = 'pending' WHERE deleted_at IS NULL AND derive_state <> 'pending'").run();
    startLibraryBackfill();
    audit(request, 'library.rederive', null, `${result.changes} 个素材`);
    return { queued: Number(result.changes) };
  });

  admin.get('/api/admin/jobs', async () => {
    const rows = db.prepare('SELECT * FROM jobs ORDER BY created_at DESC LIMIT 200').all() as Row[];
    return rows.map(toJob);
  });
}
