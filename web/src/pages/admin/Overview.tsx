import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, ArrowRight } from 'lucide-react';
import { Spinner } from '../../components/ui.tsx';
import { adminApi, formatBytes, formatTime, type Overview as OverviewData } from '../../lib/adminApi.ts';
import { reportError } from '../../lib/store.ts';
import { timeAgo } from '../../lib/util.ts';
import { PageHeader } from './AdminLayout.tsx';
import { OperatorRow } from './Operators.tsx';

function Stat({ label, value, hint, tone }: { label: string; value: React.ReactNode; hint?: string; tone?: string }) {
  return (
    <div className="panel p-4">
      <p className="text-xs text-fg-3">{label}</p>
      <p className={`mt-1 font-mono text-2xl font-semibold ${tone ?? ''}`}>{value}</p>
      {hint && <p className="mt-1 truncate text-xs text-fg-3">{hint}</p>}
    </div>
  );
}

function uptime(sec: number): string {
  if (sec < 3600) return `${Math.floor(sec / 60)} 分钟`;
  if (sec < 86400) return `${Math.floor(sec / 3600)} 小时`;
  return `${Math.floor(sec / 86400)} 天`;
}

export default function Overview() {
  const [data, setData] = useState<OverviewData | null>(null);

  useEffect(() => {
    const load = () => adminApi.overview().then(setData, reportError);
    void load();
    const timer = setInterval(load, 15_000);
    return () => clearInterval(timer);
  }, []);

  if (!data) {
    return (
      <div className="flex justify-center py-16">
        <Spinner />
      </div>
    );
  }

  const tasks = data.counts.tasks;
  const backupAge = data.lastBackup ? Date.now() - data.lastBackup.createdAt : null;
  const warnings = [
    data.masterKeySource === 'file' && '主密钥保存在数据目录的 master.key 文件里：备份数据库时请一并备份它，或在环境变量里设置 MASTER_KEY。',
    data.envDrift && '环境变量里的算子配置和后台不一致：算子以后台为准，修改 .env 不会生效。',
    !data.backupAt && '自动备份已关闭（BACKUP_AT 为空）。',
    backupAge !== null && backupAge > 36 * 3600_000 && `最近一次备份是 ${timeAgo(data.lastBackup!.createdAt)}，超过 36 小时。`,
    data.disk.media && data.disk.media.free < 10 * 1024 ** 3 && `媒体目录剩余空间不足 10 GB（${formatBytes(data.disk.media.free)}）。`,
    data.operators.every((op) => op.status !== 'online') && '当前没有在线的算子，任务会一直排队。',
  ].filter(Boolean) as string[];

  return (
    <div className="space-y-6">
      <PageHeader title="概览" hint={`织影 v${data.version}${data.gitSha ? ` (${data.gitSha})` : ''} · 已运行 ${uptime(data.uptimeSec)} · 内存 ${data.memoryMb} MB`} />

      {warnings.length > 0 && (
        <div className="space-y-2">
          {warnings.map((text) => (
            <div key={text} className="flex items-start gap-2 rounded-lg border border-warn/30 bg-warn/10 px-3 py-2 text-sm">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warn" />
              {text}
            </div>
          ))}
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="排队中" value={(tasks.queued ?? 0) + (tasks.paused ?? 0)} hint={`其中暂停 ${tasks.paused ?? 0}`} />
        <Stat label="生成中" value={tasks.running ?? 0} />
        <Stat label="24 小时完成" value={data.counts.succeeded24h} tone="text-ok" />
        <Stat label="24 小时失败" value={data.counts.failed24h} tone={data.counts.failed24h ? 'text-danger' : ''} />
        <Stat label="用户" value={data.counts.users} />
        <Stat label="故事" value={data.counts.stories} />
        <Stat label="资产" value={data.counts.assets} hint={`数据库 ${formatBytes(data.dbBytes)}`} />
        <Stat
          label="媒体磁盘剩余"
          value={data.disk.media ? formatBytes(data.disk.media.free) : '—'}
          hint={data.disk.media ? `共 ${formatBytes(data.disk.media.total)}` : undefined}
        />
      </div>

      <section>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="font-medium">算子</h2>
          <Link to="/admin/operators" className="flex items-center gap-1 text-sm text-fg-3 hover:text-fg">
            管理 <ArrowRight className="size-3.5" />
          </Link>
        </div>
        <div className="space-y-2">
          {data.operators.map((op) => (
            <OperatorRow key={op.id} op={op} />
          ))}
        </div>
      </section>

      <div className="grid gap-3 md:grid-cols-2">
        <section className="panel p-4">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="font-medium">最近失败</h2>
            <Link to="/admin/tasks?status=failed" className="text-sm text-fg-3 hover:text-fg">
              全部
            </Link>
          </div>
          {data.failures.length === 0 ? (
            <p className="py-4 text-sm text-fg-3">没有失败的任务</p>
          ) : (
            <ul className="divide-y divide-line">
              {data.failures.map((item) => (
                <li key={item.id} className="py-2 text-sm">
                  <div className="flex justify-between gap-2">
                    <span className="truncate">{item.title}</span>
                    <span className="shrink-0 text-xs text-fg-3">{formatTime(item.at)}</span>
                  </div>
                  <p className="truncate text-xs text-danger">{item.error}</p>
                  <p className="text-xs text-fg-3">{item.email}</p>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="panel p-4">
          <h2 className="mb-2 font-medium">数据与备份</h2>
          <dl className="divide-y divide-line text-sm">
            <div className="flex justify-between py-2">
              <dt className="text-fg-3">最近备份</dt>
              <dd>{data.lastBackup ? `${timeAgo(data.lastBackup.createdAt)} · ${formatBytes(data.lastBackup.bytes)}` : '还没有'}</dd>
            </div>
            <div className="flex justify-between py-2">
              <dt className="text-fg-3">自动备份</dt>
              <dd>{data.backupAt ? `每天 ${data.backupAt}` : '已关闭'}</dd>
            </div>
            <div className="flex justify-between py-2">
              <dt className="text-fg-3">数据目录剩余</dt>
              <dd>{data.disk.data ? formatBytes(data.disk.data.free) : '—'}</dd>
            </div>
            <div className="flex justify-between py-2">
              <dt className="text-fg-3">主密钥</dt>
              <dd>{data.masterKeySource === 'env' ? '环境变量 MASTER_KEY' : '数据目录 master.key'}</dd>
            </div>
          </dl>
          <Link to="/admin/backups" className="mt-2 inline-flex items-center gap-1 text-sm text-fg-3 hover:text-fg">
            备份管理 <ArrowRight className="size-3.5" />
          </Link>
        </section>
      </div>
    </div>
  );
}
