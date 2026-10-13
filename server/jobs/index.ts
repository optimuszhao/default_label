// 所有后台作业类型在这里注册（应用启动时调用一次）
import { db, type Row } from '../db.ts';
import { registerLibraryJobs } from '../library/derive.ts';
import { registerStoryboardJob } from '../stories/batch.ts';
import { registerFilmJob } from '../stories/film.ts';
import { registerStoryMigrationJob } from '../stories/migrate.ts';
import { registerVoiceJob } from '../stories/voice.ts';
import { pruneSnapshots } from '../stories/store.ts';
import { everyInterval, registerJobKind } from './runner.ts';

let registered = false;

export function registerAllJobs(): void {
  if (registered) return;
  registered = true;
  registerLibraryJobs();
  registerStoryMigrationJob();
  registerFilmJob();
  registerVoiceJob();
  registerStoryboardJob();
  // 历史版本按保留策略清理（7 天内全留、90 天内每天 1 份、更早每周 1 份、手动保存永久保留）
  registerJobKind('snapshot-prune', {
    maxAttempts: 1,
    handler: async () => {
      let removed = 0;
      for (const row of db.prepare('SELECT DISTINCT story_id FROM story_snapshots').all() as Row[]) removed += pruneSnapshots(String(row.story_id));
      return { removed };
    },
  });
  everyInterval('snapshot-prune', 24 * 3600_000);
}
