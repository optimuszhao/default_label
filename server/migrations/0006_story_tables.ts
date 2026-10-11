// 0006：故事拆表（附录 E）。整篇 JSON 拆成章、场、台词、镜头、设定，各自一行，支持增量保存；
// 同时建好系列、审片备注、图文版式的表，后面的里程碑不用再迁移。只加表和列，旧数据在打开时按需迁移。
import type { DatabaseSync } from 'node:sqlite';
import type { Migration } from '../migrate.ts';

function addColumn(db: DatabaseSync, table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!columns.some((item) => item.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export const m0006: Migration = {
  id: '0006_story_tables',
  description: '故事拆表：章、场、台词、镜头、设定、修订记录；系列、审片备注、图文版式',
  compat: true,
  up(db) {
    /** 1 = 整篇 JSON（旧）；2 = 拆表 */
    addColumn(db, 'stories', 'schema', 'INTEGER NOT NULL DEFAULT 1');
    addColumn(db, 'stories', 'settings', "TEXT NOT NULL DEFAULT '{}'");
    addColumn(db, 'stories', 'stats', "TEXT NOT NULL DEFAULT '{}'");
    /** active 进行中 / done 已完成 / archived 已归档 */
    addColumn(db, 'stories', 'status', "TEXT NOT NULL DEFAULT 'active'");
    addColumn(db, 'stories', 'template_id', 'TEXT');
    addColumn(db, 'stories', 'cover_asset_id', 'TEXT');
    addColumn(db, 'stories', 'last_opened_at', 'INTEGER');
    /** 上次编辑的位置：{tab, sceneId} */
    addColumn(db, 'stories', 'last_position', 'TEXT');
    addColumn(db, 'stories', 'deleted_at', 'INTEGER');
    addColumn(db, 'stories', 'series_id', 'TEXT');
    addColumn(db, 'stories', 'episode_no', 'INTEGER');
    /** 迁移失败的原因（失败的故事只读打开） */
    addColumn(db, 'stories', 'migrate_error', 'TEXT');

    addColumn(db, 'story_snapshots', 'label', 'TEXT');
    addColumn(db, 'story_snapshots', 'pinned', 'INTEGER NOT NULL DEFAULT 0');
    addColumn(db, 'story_snapshots', 'stats', 'TEXT');

    db.exec(`
      CREATE TABLE IF NOT EXISTS story_series (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        settings TEXT NOT NULL DEFAULT '{}',
        cover_asset_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        deleted_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_series_user ON story_series(user_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_stories_series ON stories(series_id, episode_no);

      -- 大纲、世界观、笔记、原著、前情提要等长文本
      CREATE TABLE IF NOT EXISTS story_docs (
        id TEXT PRIMARY KEY,
        story_id TEXT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        content TEXT NOT NULL DEFAULT '',
        sort_key TEXT NOT NULL DEFAULT 'i',
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_story_docs ON story_docs(story_id, kind);

      CREATE TABLE IF NOT EXISTS story_chapters (
        id TEXT PRIMARY KEY,
        story_id TEXT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
        sort_key TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        summary TEXT NOT NULL DEFAULT '',
        recap TEXT NOT NULL DEFAULT '',
        data TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_story_chapters ON story_chapters(story_id, sort_key);

      CREATE TABLE IF NOT EXISTS story_scenes (
        id TEXT PRIMARY KEY,
        story_id TEXT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
        chapter_id TEXT NOT NULL REFERENCES story_chapters(id) ON DELETE CASCADE,
        sort_key TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        location_id TEXT,
        location_text TEXT NOT NULL DEFAULT '',
        time_text TEXT NOT NULL DEFAULT '',
        script TEXT NOT NULL DEFAULT '',
        data TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_story_scenes ON story_scenes(chapter_id, sort_key);
      CREATE INDEX IF NOT EXISTS idx_story_scenes_story ON story_scenes(story_id);

      CREATE TABLE IF NOT EXISTS story_lines (
        id TEXT PRIMARY KEY,
        story_id TEXT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
        scene_id TEXT NOT NULL REFERENCES story_scenes(id) ON DELETE CASCADE,
        sort_key TEXT NOT NULL,
        character_id TEXT,
        kind TEXT NOT NULL DEFAULT 'dialogue',
        text TEXT NOT NULL DEFAULT '',
        emotion TEXT NOT NULL DEFAULT '',
        voice_asset_id TEXT,
        data TEXT NOT NULL DEFAULT '{}',
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_story_lines ON story_lines(scene_id, sort_key);
      CREATE INDEX IF NOT EXISTS idx_story_lines_story ON story_lines(story_id);

      CREATE TABLE IF NOT EXISTS story_shots (
        id TEXT PRIMARY KEY,
        story_id TEXT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
        scene_id TEXT NOT NULL REFERENCES story_scenes(id) ON DELETE CASCADE,
        sort_key TEXT NOT NULL,
        code TEXT NOT NULL DEFAULT '',
        shot_size TEXT NOT NULL DEFAULT '',
        camera_move TEXT NOT NULL DEFAULT '',
        duration REAL NOT NULL DEFAULT 5,
        description TEXT NOT NULL DEFAULT '',
        keyframe_asset_id TEXT,
        video_asset_id TEXT,
        locked INTEGER NOT NULL DEFAULT 0,
        review TEXT,
        data TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_story_shots ON story_shots(scene_id, sort_key);
      CREATE INDEX IF NOT EXISTS idx_story_shots_story ON story_shots(story_id);
      CREATE INDEX IF NOT EXISTS idx_story_shots_kf ON story_shots(keyframe_asset_id);
      CREATE INDEX IF NOT EXISTS idx_story_shots_video ON story_shots(video_asset_id);

      -- 设定：角色、地点、道具、画风。story_id 为空 = 个人设定库；series_id 不为空 = 系列共享
      CREATE TABLE IF NOT EXISTS story_elements (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        story_id TEXT REFERENCES stories(id) ON DELETE CASCADE,
        series_id TEXT,
        kind TEXT NOT NULL,
        name TEXT NOT NULL DEFAULT '',
        sort_key TEXT NOT NULL,
        snippet TEXT NOT NULL DEFAULT '',
        negative TEXT NOT NULL DEFAULT '',
        data TEXT NOT NULL DEFAULT '{}',
        source_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        deleted_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_story_elements ON story_elements(story_id, kind, sort_key);
      CREATE INDEX IF NOT EXISTS idx_story_elements_series ON story_elements(series_id);
      CREATE INDEX IF NOT EXISTS idx_story_elements_user ON story_elements(user_id, kind);

      CREATE TABLE IF NOT EXISTS shot_elements (
        shot_id TEXT NOT NULL,
        element_id TEXT NOT NULL,
        story_id TEXT NOT NULL,
        sort INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (shot_id, element_id)
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS idx_shot_elements_el ON shot_elements(element_id);
      CREATE INDEX IF NOT EXISTS idx_shot_elements_story ON shot_elements(story_id);

      CREATE TABLE IF NOT EXISTS entity_assets (
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        asset_id TEXT NOT NULL,
        role TEXT NOT NULL,
        sort_key TEXT NOT NULL DEFAULT 'i',
        created_at INTEGER NOT NULL,
        PRIMARY KEY (entity_type, entity_id, asset_id, role)
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS idx_entity_assets_asset ON entity_assets(asset_id);

      CREATE TABLE IF NOT EXISTS story_revisions (
        story_id TEXT NOT NULL,
        rev INTEGER NOT NULL,
        client_id TEXT,
        ops TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (story_id, rev)
      ) WITHOUT ROWID;

      CREATE TABLE IF NOT EXISTS story_notes (
        id TEXT PRIMARY KEY,
        story_id TEXT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
        shot_id TEXT,
        user_id TEXT NOT NULL,
        at_sec REAL,
        text TEXT NOT NULL DEFAULT '',
        resolved INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_story_notes ON story_notes(story_id, shot_id);

      CREATE TABLE IF NOT EXISTS story_layouts (
        id TEXT PRIMARY KEY,
        story_id TEXT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        pages TEXT NOT NULL DEFAULT '[]',
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_story_layouts ON story_layouts(story_id);
    `);
  },
};
