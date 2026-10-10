// 0002：补上按故事查任务、按任务查资产时缺的索引（只加索引，旧版本程序可以照常使用）
import type { Migration } from '../migrate.ts';

export const m0002: Migration = {
  id: '0002_indexes',
  description: '补充 tasks.story_id、assets.task_id 索引',
  compat: true,
  up(db) {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_tasks_story ON tasks(story_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_assets_task ON assets(task_id);
    `);
  },
};
