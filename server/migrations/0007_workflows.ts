// 0007：工作流（M8a）。运行记录（每一步的状态、产物都存在 state 里，重启后接着跑）和后台的工作流设置。只加表。
import type { Migration } from '../migrate.ts';

export const m0007: Migration = {
  id: '0007_workflows',
  description: '工作流运行记录和工作流设置',
  compat: true,
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS workflow_runs (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        workflow_id TEXT NOT NULL,
        title TEXT NOT NULL,
        /** running 进行中 / waiting 等你选择 / paused 已暂停 / succeeded / failed / canceled */
        status TEXT NOT NULL,
        inputs TEXT NOT NULL DEFAULT '{}',
        /** 每一步的状态：{ [stepId]: { status, assets, taskIds, items, output, error } } */
        state TEXT NOT NULL DEFAULT '{}',
        unattended INTEGER NOT NULL DEFAULT 0,
        task_count INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        story_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        finished_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_workflow_runs_user ON workflow_runs(user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_workflow_runs_status ON workflow_runs(status);

      CREATE TABLE IF NOT EXISTS workflow_settings (
        workflow_id TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL DEFAULT 1,
        sort INTEGER NOT NULL DEFAULT 0,
        defaults TEXT NOT NULL DEFAULT '{}',
        updated_at INTEGER NOT NULL
      );
    `);
  },
};
