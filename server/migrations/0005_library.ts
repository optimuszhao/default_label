// 0005：资产库 2.0。资产补列（序号、大小、哈希、衍生文件、回收站、组织字段），
// 文件夹、标签、智能文件夹、分片上传、后台作业、全文检索；任务加来源列（故事批量、工作流）。只加表和列。
import type { DatabaseSync } from 'node:sqlite';
import type { Migration } from '../migrate.ts';

function addColumn(db: DatabaseSync, table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!columns.some((item) => item.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export const m0005: Migration = {
  id: '0005_library',
  description: '资产库 2.0：序号、哈希、衍生文件、回收站、文件夹、标签、分片上传、后台作业、全文检索',
  compat: true,
  up(db) {
    // 单调递增的序号：分页游标和全文检索的 rowid 都用它
    addColumn(db, 'assets', 'seq', 'INTEGER');
    addColumn(db, 'assets', 'size', 'INTEGER');
    addColumn(db, 'assets', 'sha256', 'TEXT');
    addColumn(db, 'assets', 'codec', 'TEXT');
    // 衍生文件（相对 DATA_DIR/thumbs）：缩略图（长边 384 WebP）、视频封面（JPEG）
    addColumn(db, 'assets', 'thumb', 'TEXT');
    addColumn(db, 'assets', 'poster', 'TEXT');
    /** pending：待生成；ok；failed；skip：没有 ffmpeg 或不需要 */
    addColumn(db, 'assets', 'derive_state', "TEXT NOT NULL DEFAULT 'pending'");
    addColumn(db, 'assets', 'deleted_at', 'INTEGER');
    addColumn(db, 'assets', 'folder_id', 'TEXT');
    addColumn(db, 'assets', 'rating', 'INTEGER NOT NULL DEFAULT 0');
    /** pick：挑选；reject：淘汰 */
    addColumn(db, 'assets', 'flag', 'TEXT');
    addColumn(db, 'assets', 'note', "TEXT NOT NULL DEFAULT ''");
    /** 和 parent_asset_id 的关系：derive（变体、参考、图转视频）、frame（截帧） */
    addColumn(db, 'assets', 'lineage', 'TEXT');
    /** 上传原文件名、PNG 里 ComfyUI 写入的生成参数等 */
    addColumn(db, 'assets', 'filename', 'TEXT');
    addColumn(db, 'assets', 'meta', 'TEXT');
    addColumn(db, 'tasks', 'origin', 'TEXT');

    const base = Number((db.prepare('SELECT COALESCE(MAX(seq), 0) AS n FROM assets').get() as { n: number }).n);
    db.exec(`
      CREATE TEMP TABLE IF NOT EXISTS seq_map (id TEXT PRIMARY KEY, rn INTEGER NOT NULL);
      DELETE FROM seq_map;
      INSERT INTO seq_map SELECT id, ROW_NUMBER() OVER (ORDER BY created_at, id) FROM assets WHERE seq IS NULL;
      UPDATE assets SET seq = (SELECT rn FROM seq_map WHERE seq_map.id = assets.id) + ${base} WHERE seq IS NULL;
      DROP TABLE seq_map;
    `);
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_assets_seq ON assets(seq);
      CREATE INDEX IF NOT EXISTS idx_assets_user_seq ON assets(user_id, deleted_at, seq DESC);
      CREATE INDEX IF NOT EXISTS idx_assets_sha ON assets(user_id, sha256);
      CREATE INDEX IF NOT EXISTS idx_assets_folder ON assets(folder_id);
      CREATE INDEX IF NOT EXISTS idx_assets_derive ON assets(derive_state);

      CREATE TABLE IF NOT EXISTS folders (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        parent_id TEXT,
        name TEXT NOT NULL,
        sort INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_folders_user ON folders(user_id, parent_id);

      CREATE TABLE IF NOT EXISTS tags (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE (user_id, name)
      );

      CREATE TABLE IF NOT EXISTS asset_tags (
        asset_id TEXT NOT NULL,
        tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
        PRIMARY KEY (asset_id, tag_id)
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS idx_asset_tags_tag ON asset_tags(tag_id);

      CREATE TABLE IF NOT EXISTS saved_searches (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        query TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS uploads (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        filename TEXT NOT NULL,
        mime TEXT NOT NULL,
        size INTEGER NOT NULL,
        received INTEGER NOT NULL DEFAULT 0,
        temp_file TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        user_id TEXT,
        kind TEXT NOT NULL,
        lane TEXT NOT NULL DEFAULT 'fast',
        status TEXT NOT NULL DEFAULT 'queued',
        payload TEXT NOT NULL DEFAULT '{}',
        result TEXT,
        progress REAL NOT NULL DEFAULT 0,
        stage TEXT,
        error TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        dedupe_key TEXT,
        run_after INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        started_at INTEGER,
        finished_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_jobs_pick ON jobs(status, lane, run_after);
      CREATE INDEX IF NOT EXISTS idx_jobs_user ON jobs(user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_jobs_dedupe ON jobs(dedupe_key, status);

      CREATE VIRTUAL TABLE IF NOT EXISTS assets_fts USING fts5(body, tokenize = 'trigram');
    `);
    // 已有素材先用提示词建索引，备注、标签、故事名在之后的修改里补上
    db.exec(`INSERT INTO assets_fts (rowid, body)
      SELECT seq, COALESCE(prompt, '') FROM assets WHERE seq NOT IN (SELECT rowid FROM assets_fts)`);
  },
};
