// 0008：镜头接续（STY-09 补充）。设了"接续上一镜尾帧"的镜头，上一镜视频还没出来时先记一条等待，
// 上一镜视频生成成功后由任务结束回调截尾帧、建这一镜的视频任务。存在库里，服务重启后照样接得上。只加表。
import type { Migration } from '../migrate.ts';

export const m0008: Migration = {
  id: '0008_story_chains',
  description: '镜头接续等待（上一镜视频完成后自动生成下一镜）',
  compat: true,
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS story_chains (
        id TEXT PRIMARY KEY,
        story_id TEXT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        /** 等待中的镜头 */
        shot_id TEXT NOT NULL,
        /** 等这个镜头的视频 */
        after_shot_id TEXT NOT NULL,
        batch_id TEXT,
        resolution TEXT,
        idle INTEGER NOT NULL DEFAULT 0,
        /** waiting 等上一镜 / created 已建任务 / canceled 已取消 */
        status TEXT NOT NULL DEFAULT 'waiting',
        task_id TEXT,
        note TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_story_chains_after ON story_chains(story_id, after_shot_id, status);
      CREATE INDEX IF NOT EXISTS idx_story_chains_shot ON story_chains(story_id, shot_id, status);
    `);
  },
};
