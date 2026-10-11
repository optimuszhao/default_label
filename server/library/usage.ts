// 素材被哪里用到：删除前提示、合并重复文件时改指向。
// 故事的引用有两种存法：旧版整篇 JSON（stories.data，schema=1）和拆表后的 story_shots / entity_assets（schema=2）。
import type { AssetUsage } from '../../shared/types.ts';
import { db, type Row } from '../db.ts';

const ACTIVE = "('queued', 'paused', 'running')";

/** 引用某个素材的排队中、暂停、生成中的任务（这些素材不能删除） */
function activeTasks(userId: string, assetId: string): { id: string; title: string }[] {
  const rows = db
    .prepare(`SELECT id, title FROM tasks WHERE user_id = ? AND status IN ${ACTIVE} AND inputs LIKE ? LIMIT 20`)
    .all(userId, `%"${assetId}"%`) as Row[];
  return rows.map((row) => ({ id: String(row.id), title: String(row.title) }));
}

interface LegacyShot {
  id: string;
  keyframeAssetId?: string | null;
  videoAssetId?: string | null;
}
interface LegacyData {
  characters?: { name: string; referenceAssetId?: string | null }[];
  chapters?: { scenes?: { title?: string; shots?: LegacyShot[] }[] }[];
}

function legacyStoryRefs(userId: string, assetId: string): AssetUsage['stories'] {
  const out: AssetUsage['stories'] = [];
  // 拆表（M7a）之后，schema=2 的故事 data 里只剩迁移前的原文，不再算作引用
  const legacyOnly = hasColumn('stories', 'schema') ? ' AND COALESCE(schema, 1) = 1' : '';
  const rows = db
    .prepare(`SELECT id, title, data FROM stories WHERE user_id = ?${legacyOnly} AND data LIKE ?`)
    .all(userId, `%${assetId}%`) as Row[];
  for (const row of rows) {
    let data: LegacyData;
    try {
      data = JSON.parse(String(row.data)) as LegacyData;
    } catch {
      continue;
    }
    const storyId = String(row.id);
    const title = String(row.title);
    for (const character of data.characters ?? []) {
      if (character.referenceAssetId === assetId) out.push({ storyId, title, where: `角色「${character.name}」的参考图` });
    }
    let number = 0;
    for (const chapter of data.chapters ?? []) {
      for (const scene of chapter.scenes ?? []) {
        for (const shot of scene.shots ?? []) {
          number++;
          if (shot.keyframeAssetId === assetId) out.push({ storyId, title, where: `镜头 #${number} 的选定关键帧` });
          if (shot.videoAssetId === assetId) out.push({ storyId, title, where: `镜头 #${number} 的选定视频` });
        }
      }
    }
  }
  return out;
}

function hasColumn(table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Row[]).some((row) => row.name === column);
}

function hasTable(name: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

/** 拆表后的故事：镜头选定、设定 / 场次 / 镜头上挂的素材 */
function tableStoryRefs(userId: string, assetId: string): AssetUsage['stories'] {
  if (!hasTable('story_shots')) return [];
  const out: AssetUsage['stories'] = [];
  const shots = db
    .prepare(
      `SELECT sh.code, sh.keyframe_asset_id, sh.video_asset_id, s.id AS story_id, s.title FROM story_shots sh
       JOIN stories s ON s.id = sh.story_id WHERE s.user_id = ? AND (sh.keyframe_asset_id = ? OR sh.video_asset_id = ?)`,
    )
    .all(userId, assetId, assetId) as Row[];
  for (const row of shots) {
    const what = row.keyframe_asset_id === assetId ? '选定关键帧' : '选定视频';
    out.push({ storyId: String(row.story_id), title: String(row.title), where: `镜头 ${row.code || ''} 的${what}`.replace('  ', ' ') });
  }
  const refs = db
    .prepare(
      `SELECT ea.entity_type, ea.role, e.name AS element_name, e.story_id AS element_story, s.id AS story_id, s.title
       FROM entity_assets ea
       LEFT JOIN story_elements e ON ea.entity_type = 'element' AND e.id = ea.entity_id
       LEFT JOIN stories s ON s.id = COALESCE(e.story_id, CASE WHEN ea.entity_type = 'story' THEN ea.entity_id END)
       WHERE ea.asset_id = ? AND (s.user_id = ? OR e.user_id = ?)`,
    )
    .all(assetId, userId, userId) as Row[];
  for (const row of refs) {
    if (row.entity_type === 'element') {
      out.push({ storyId: String(row.story_id ?? ''), title: String(row.title ?? '设定库'), where: `设定「${row.element_name}」的参考图` });
    } else {
      out.push({ storyId: String(row.story_id ?? ''), title: String(row.title ?? ''), where: '故事素材' });
    }
  }
  return out;
}

export function assetUsage(userId: string, assetId: string): AssetUsage {
  return {
    assetId,
    activeTasks: activeTasks(userId, assetId),
    stories: [...legacyStoryRefs(userId, assetId), ...tableStoryRefs(userId, assetId)],
  };
}

/**
 * 把对 fromIds 的引用全部改指向 toId（合并重复文件时用）。
 * 素材 id 是随机串，直接在 JSON 文本里替换不会误伤。
 */
export function replaceAssetRefs(userId: string, fromIds: string[], toId: string): void {
  for (const fromId of fromIds) {
    const like = `%${fromId}%`;
    const stories = db.prepare('SELECT id, data FROM stories WHERE user_id = ? AND data LIKE ?').all(userId, like) as Row[];
    for (const row of stories) {
      db.prepare('UPDATE stories SET data = ? WHERE id = ?').run(String(row.data).split(fromId).join(toId), String(row.id));
    }
    const tasks = db.prepare('SELECT id, inputs FROM tasks WHERE user_id = ? AND inputs LIKE ?').all(userId, like) as Row[];
    for (const row of tasks) {
      db.prepare('UPDATE tasks SET inputs = ? WHERE id = ?').run(String(row.inputs).split(fromId).join(toId), String(row.id));
    }
    db.prepare('UPDATE assets SET parent_asset_id = ? WHERE parent_asset_id = ? AND user_id = ?').run(toId, fromId, userId);
    if (hasTable('story_shots')) {
      db.prepare('UPDATE story_shots SET keyframe_asset_id = ? WHERE keyframe_asset_id = ?').run(toId, fromId);
      db.prepare('UPDATE story_shots SET video_asset_id = ? WHERE video_asset_id = ?').run(toId, fromId);
      db.prepare('UPDATE OR IGNORE entity_assets SET asset_id = ? WHERE asset_id = ?').run(toId, fromId);
      db.prepare('DELETE FROM entity_assets WHERE asset_id = ?').run(fromId);
      db.prepare('UPDATE story_lines SET voice_asset_id = ? WHERE voice_asset_id = ?').run(toId, fromId);
    }
  }
}
