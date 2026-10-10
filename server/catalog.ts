// 预设与模板目录：启动时导入种子数据，内存缓存，后台修改后刷新。
import type { Preset, PromptTemplate } from '../shared/presets.ts';
import { SEED_PRESETS, SEED_TEMPLATES, SEED_VERSION } from '../shared/seed.ts';
import { db, now, parseJson, type Row } from './db.ts';

let presetCache: Preset[] | null = null;
let templateCache: PromptTemplate[] | null = null;
/** 目录版本：后台每次修改 +1，前端据此（ETag）判断是否需要重新拉取 */
let version = Date.now();

function toPreset(row: Row): Preset {
  return {
    slug: String(row.slug),
    kind: row.kind as Preset['kind'],
    name: String(row.name),
    group: String(row.grp),
    position: row.position === 'prefix' ? 'prefix' : 'suffix',
    applies: row.applies as Preset['applies'],
    prompt: String(row.prompt),
    negative: (row.negative as string | null) ?? undefined,
    fallbackPrompt: (row.fallback_prompt as string | null) ?? undefined,
    params: parseJson(row.params, {}),
    cover: (row.cover as string | null) ?? null,
    hint: (row.hint as string | null) ?? undefined,
    sort: Number(row.sort),
    enabled: Number(row.enabled) === 1,
  };
}

function toTemplate(row: Row): PromptTemplate {
  return {
    id: String(row.id),
    name: String(row.name),
    category: String(row.category),
    description: String(row.description),
    mode: row.mode === 'video' ? 'video' : 'image',
    body: String(row.body),
    variables: parseJson(row.variables, []),
    negative: String(row.negative),
    presets: parseJson(row.presets, []),
    params: parseJson(row.params, {}),
    requiresReference: Number(row.requires_reference) === 1,
    featured: Number(row.featured) === 1,
    cover: (row.cover as string | null) ?? null,
    sort: Number(row.sort),
    enabled: Number(row.enabled) === 1,
  };
}

/** 导入种子：新增的条目插入；没被管理员改过（customized=0）且种子版本更新的条目覆盖 */
export function seedCatalog(): void {
  const ts = now();
  const upsertPreset = db.prepare(
    `INSERT INTO presets (slug, kind, name, grp, position, applies, prompt, negative, fallback_prompt, params, hint, sort, enabled, seed_version, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
     ON CONFLICT(slug) DO UPDATE SET kind = excluded.kind, name = excluded.name, grp = excluded.grp, position = excluded.position,
       applies = excluded.applies, prompt = excluded.prompt, negative = excluded.negative, fallback_prompt = excluded.fallback_prompt,
       params = excluded.params, hint = excluded.hint, sort = excluded.sort, seed_version = excluded.seed_version, updated_at = excluded.updated_at
     WHERE presets.customized = 0 AND presets.seed_version < excluded.seed_version`,
  );
  for (const p of SEED_PRESETS) {
    upsertPreset.run(p.slug, p.kind, p.name, p.group, p.position, p.applies, p.prompt, p.negative ?? null, p.fallbackPrompt ?? null, JSON.stringify(p.params ?? {}), p.hint ?? null, p.sort, SEED_VERSION, ts);
  }
  const upsertTemplate = db.prepare(
    `INSERT INTO prompt_templates (id, name, category, description, mode, body, variables, negative, presets, params, requires_reference, featured, sort, enabled, seed_version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, category = excluded.category, description = excluded.description, mode = excluded.mode,
       body = excluded.body, variables = excluded.variables, negative = excluded.negative, presets = excluded.presets, params = excluded.params,
       requires_reference = excluded.requires_reference, featured = excluded.featured, sort = excluded.sort, seed_version = excluded.seed_version,
       updated_at = excluded.updated_at
     WHERE prompt_templates.customized = 0 AND prompt_templates.seed_version < excluded.seed_version`,
  );
  for (const t of SEED_TEMPLATES) {
    upsertTemplate.run(
      t.id,
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
      t.sort,
      SEED_VERSION,
      ts,
      ts,
    );
  }
  invalidateCatalog();
}

export function invalidateCatalog(): void {
  presetCache = null;
  templateCache = null;
  version = Date.now();
}

export function catalogVersion(): number {
  return version;
}

/** 全部预设（含停用的，管理后台用） */
export function allPresets(): Preset[] {
  presetCache ??= (db.prepare('SELECT * FROM presets ORDER BY sort, slug').all() as Row[]).map(toPreset);
  return presetCache;
}

export function presetMap(): Map<string, Preset> {
  return new Map(allPresets().map((preset) => [preset.slug, preset]));
}

export function allTemplates(): PromptTemplate[] {
  templateCache ??= (db.prepare('SELECT * FROM prompt_templates ORDER BY sort, id').all() as Row[]).map(toTemplate);
  return templateCache;
}

export function getTemplate(id: string | null | undefined): PromptTemplate | null {
  if (!id) return null;
  return allTemplates().find((template) => template.id === id) ?? null;
}

/** 记录模板使用（同人同天只计一次） */
export function recordTemplateUse(templateId: string, userId: string): void {
  const day = new Date().toISOString().slice(0, 10);
  db.prepare('INSERT OR IGNORE INTO template_usage (template_id, user_id, day) VALUES (?, ?, ?)').run(templateId, userId, day);
}

/**
 * 热门分：近 30 天的使用和收藏按 7 天半衰期衰减，收藏权重 2，精选加 3。
 * 小规模（自用、邀请制）时精选会排在前面。
 */
export function templateScores(): Map<string, { hot: number; uses: number }> {
  const today = Date.now();
  const scores = new Map<string, { hot: number; uses: number }>();
  const decay = (ms: number) => 0.5 ** ((today - ms) / (7 * 86400_000));
  const since = new Date(today - 30 * 86400_000).toISOString().slice(0, 10);
  for (const row of db.prepare('SELECT template_id, day FROM template_usage WHERE day >= ?').all(since) as Row[]) {
    const entry = scores.get(String(row.template_id)) ?? { hot: 0, uses: 0 };
    entry.hot += decay(Date.parse(String(row.day)));
    entry.uses += 1;
    scores.set(String(row.template_id), entry);
  }
  for (const row of db.prepare("SELECT ref, created_at FROM favorites WHERE kind = 'template' AND created_at >= ?").all(today - 30 * 86400_000) as Row[]) {
    const entry = scores.get(String(row.ref)) ?? { hot: 0, uses: 0 };
    entry.hot += 2 * decay(Number(row.created_at));
    scores.set(String(row.ref), entry);
  }
  for (const template of allTemplates()) {
    if (!template.featured) continue;
    const entry = scores.get(template.id) ?? { hot: 0, uses: 0 };
    entry.hot += 3;
    scores.set(template.id, entry);
  }
  return scores;
}
