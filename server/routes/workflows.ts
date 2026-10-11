// 工作流：列表、启动、运行列表与详情、人工挑选、单步重试 / 跳过、暂停 / 继续 / 取消；后台设置（启停、默认参数、排序）
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.ts';
import { requireAdmin } from '../auth.ts';
import { db, now, type Row } from '../db.ts';
import { loadStory } from '../stories/store.ts';
import { WORKFLOWS } from '../workflows/defs.ts';
import { cancelRun, findWorkflow, pauseRun, resumeRun, retryStep, selectAssets, skipStep, startRun, toRun, workflowSettings } from '../workflows/engine.ts';
import type { WorkflowDef } from '../workflows/types.ts';
import { bad, parse, uid } from './common.ts';

function publicDef(def: WorkflowDef, defaults: Record<string, unknown> = {}) {
  return {
    id: def.id,
    title: def.title,
    description: def.description,
    estimate: def.estimate,
    inputs: def.inputs.map((input) => ({ ...input, default: defaults[input.key] ?? input.default ?? null })),
    steps: def.steps.map((step) => ({ id: step.id, kind: step.kind, label: step.label })),
  };
}

function ownedRun(request: FastifyRequest, reply: FastifyReply): Row | null {
  const { id } = request.params as { id: string };
  const row = db.prepare('SELECT * FROM workflow_runs WHERE id = ? AND user_id = ?').get(id, uid(request)) as Row | undefined;
  if (!row) {
    void bad(reply, '运行不存在', 404);
    return null;
  }
  return row;
}

function fresh(id: string) {
  return toRun(db.prepare('SELECT * FROM workflow_runs WHERE id = ?').get(id) as Row);
}

export async function workflowRoutes(api: FastifyInstance): Promise<void> {
  api.get('/api/workflows', async () => {
    const settings = workflowSettings();
    return WORKFLOWS.filter((def) => settings.get(def.id)?.enabled !== false)
      .sort((a, b) => (settings.get(a.id)?.sort ?? 0) - (settings.get(b.id)?.sort ?? 0))
      .map((def) => publicDef(def, settings.get(def.id)?.defaults));
  });

  /** "故事里的角色"输入的候选：我的故事里所有角色 */
  api.get('/api/workflows/characters', async (request) => {
    const stories = db.prepare("SELECT id, title FROM stories WHERE user_id = ? AND schema = 2 AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 50").all(uid(request)) as Row[];
    return stories.flatMap((story) =>
      loadStory(String(story.id)).data.characters.map((c) => ({ value: `${story.id}:${c.id}`, label: `${story.title} · ${c.name}`, name: c.name, appearance: c.appearance })),
    );
  });

  api.post('/api/workflows/:id/runs', async (request, reply) => {
    const { id } = request.params as { id: string };
    const def = findWorkflow(id);
    if (!def) return bad(reply, '工作流不存在', 404);
    const body = parse(z.object({ inputs: z.record(z.string(), z.unknown()).default({}), unattended: z.boolean().default(false), title: z.string().max(80).optional() }), request.body, reply);
    if (!body) return;
    const result = await startRun(uid(request), def, body.inputs, { unattended: body.unattended, title: body.title });
    if (typeof result === 'string') return bad(reply, result, result.includes('最多') ? 429 : 400);
    return result;
  });

  api.get('/api/workflow-runs', async (request) => {
    const query = request.query as { status?: string; limit?: string };
    const where = query.status === 'active' ? " AND status IN ('running', 'waiting', 'paused')" : '';
    const limit = Math.min(Number(query.limit) || 50, 200);
    const rows = db.prepare(`SELECT * FROM workflow_runs WHERE user_id = ?${where} ORDER BY created_at DESC LIMIT ${limit}`).all(uid(request)) as Row[];
    return rows.map(toRun);
  });

  api.get('/api/workflow-runs/:id', async (request, reply) => {
    const row = ownedRun(request, reply);
    if (!row) return;
    return toRun(row);
  });

  api.post('/api/workflow-runs/:id/:action', async (request, reply) => {
    const { action } = request.params as { action: string };
    const row = ownedRun(request, reply);
    if (!row) return;
    if (action === 'cancel') {
      if (!['running', 'waiting', 'paused'].includes(String(row.status))) return bad(reply, '这个运行已经结束');
      await cancelRun(row);
    } else if (action === 'pause') pauseRun(row);
    else if (action === 'resume') await resumeRun(row);
    else return bad(reply, '未知的操作', 404);
    return fresh(String(row.id));
  });

  api.post('/api/workflow-runs/:id/steps/:sid/:action', async (request, reply) => {
    const { sid, action } = request.params as { sid: string; action: string };
    const row = ownedRun(request, reply);
    if (!row) return;
    let error: string | null;
    if (action === 'select') {
      const body = parse(z.object({ assetIds: z.array(z.string().max(40)).min(1).max(24) }), request.body, reply);
      if (!body) return;
      error = await selectAssets(row, sid, body.assetIds);
    } else if (action === 'retry') error = await retryStep(row, sid);
    else if (action === 'skip') error = await skipStep(row, sid);
    else return bad(reply, '未知的操作', 404);
    if (error) return bad(reply, error);
    return fresh(String(row.id));
  });

  api.delete('/api/workflow-runs/:id', async (request, reply) => {
    const row = ownedRun(request, reply);
    if (!row) return;
    if (['running', 'waiting', 'paused'].includes(String(row.status))) return bad(reply, '进行中的运行请先取消');
    db.prepare('DELETE FROM workflow_runs WHERE id = ?').run(String(row.id));
    return { ok: true };
  });
}

/** 后台：工作流启停、默认参数、排序（WF-06）。"算子侧模板"要等朋友提供通用执行接口，暂不显示 */
export async function adminWorkflowRoutes(admin: FastifyInstance): Promise<void> {
  admin.addHook('preHandler', requireAdmin);

  admin.get('/api/admin/workflows', async () => {
    const settings = workflowSettings();
    const usage = new Map(
      (db.prepare('SELECT workflow_id, COUNT(*) AS n FROM workflow_runs GROUP BY workflow_id').all() as Row[]).map((row) => [String(row.workflow_id), Number(row.n)]),
    );
    return WORKFLOWS.map((def) => ({
      ...publicDef(def, settings.get(def.id)?.defaults),
      enabled: settings.get(def.id)?.enabled ?? true,
      sort: settings.get(def.id)?.sort ?? 0,
      defaults: settings.get(def.id)?.defaults ?? {},
      runs: usage.get(def.id) ?? 0,
    }));
  });

  admin.patch('/api/admin/workflows/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const def = findWorkflow(id);
    if (!def) return bad(reply, '工作流不存在', 404);
    const body = parse(z.object({ enabled: z.boolean().optional(), sort: z.number().int().min(-100).max(100).optional(), defaults: z.record(z.string(), z.unknown()).optional() }), request.body, reply);
    if (!body) return;
    const current = workflowSettings().get(id) ?? { enabled: true, sort: 0, defaults: {} };
    const keys = new Set(def.inputs.map((input) => input.key));
    const defaults = body.defaults ? Object.fromEntries(Object.entries(body.defaults).filter(([key]) => keys.has(key))) : current.defaults;
    db.prepare(
      `INSERT INTO workflow_settings (workflow_id, enabled, sort, defaults, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(workflow_id) DO UPDATE SET enabled = excluded.enabled, sort = excluded.sort, defaults = excluded.defaults, updated_at = excluded.updated_at`,
    ).run(id, (body.enabled ?? current.enabled) ? 1 : 0, body.sort ?? current.sort, JSON.stringify(defaults), now());
    audit(request, 'workflow.update', id, `${def.title}：${Object.keys(body).join('、')}`);
    return { ok: true };
  });

}
