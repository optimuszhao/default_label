import { useCallback, useEffect, useState } from 'react';
import { Archive } from 'lucide-react';
import { Button, Spinner } from '../../components/ui.tsx';
import { adminApi, formatBytes, formatTime, type BackupEntry } from '../../lib/adminApi.ts';
import { reportError, useStore } from '../../lib/store.ts';
import { PageHeader } from './AdminLayout.tsx';

export default function AdminBackups() {
  const toast = useStore((s) => s.toast);
  const [list, setList] = useState<BackupEntry[] | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => adminApi.backups().then(setList, reportError), []);

  useEffect(() => {
    void load();
  }, [load]);

  async function backup() {
    setBusy(true);
    try {
      const entry = await adminApi.backupNow();
      toast(`已备份：${entry.name}`, 'success');
      void load();
    } catch (error) {
      reportError(error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <PageHeader
        title="备份"
        hint="数据库每天自动备份并保留最近 7 份。图片和视频文件请用群晖快照或 Hyper Backup 备份媒体目录。"
        actions={
          <Button variant="brand" loading={busy} icon={<Archive className="size-4" />} onClick={() => void backup()}>
            立即备份
          </Button>
        }
      />
      {!list ? (
        <div className="flex justify-center py-16">
          <Spinner />
        </div>
      ) : list.length === 0 ? (
        <p className="py-16 text-center text-sm text-fg-3">还没有备份</p>
      ) : (
        <div className="panel divide-y divide-line">
          {list.map((item) => (
            <div key={item.name} className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
              <span className="truncate font-mono text-xs">{item.name}</span>
              <span className="shrink-0 text-xs text-fg-3">
                {formatBytes(item.bytes)} · {formatTime(item.createdAt)}
              </span>
            </div>
          ))}
        </div>
      )}
      <section className="panel mt-4 p-4 text-sm leading-relaxed text-fg-2">
        <h2 className="mb-2 font-medium text-fg">如何恢复</h2>
        <pre className="overflow-x-auto rounded-lg bg-black/40 p-3 font-mono text-xs text-fg-2">{`docker compose stop weave
docker compose run --rm weave node scripts/restore.ts            # 列出备份
docker compose run --rm weave node scripts/restore.ts <备份文件名>
docker compose start weave`}</pre>
        <p className="mt-2 text-xs text-fg-3">当前数据库不会被删除，会改名为 weave.db.before-restore-时间，恢复错了可以换回来。</p>
      </section>
    </div>
  );
}
