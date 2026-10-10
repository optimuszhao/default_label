import { useEffect, useState } from 'react';
import { Spinner } from '../../components/ui.tsx';
import { adminApi, formatTime, type AuditEntry } from '../../lib/adminApi.ts';
import { reportError } from '../../lib/store.ts';
import { PageHeader } from './AdminLayout.tsx';

const ACTION_LABEL: Record<string, string> = {
  'operator.create': '新建算子',
  'operator.update': '修改算子',
  'operator.delete': '删除算子',
  'operator.test': '测试连接',
  'token.verify': '校验令牌',
  'token.renew': '重新获取令牌',
  'token.clear': '清除令牌',
  'token.manual': '手动填入令牌',
  'token.reveal': '查看明文令牌',
  'task.cancel': '取消任务',
  'task.retry': '重新排队',
  'task.top': '插队',
  'user.update': '修改用户',
  'backup.create': '立即备份',
};

export default function AdminAudit() {
  const [list, setList] = useState<AuditEntry[] | null>(null);
  useEffect(() => {
    adminApi.audit().then(setList, reportError);
  }, []);

  return (
    <div>
      <PageHeader title="审计日志" hint="后台的每一次写操作都会记录：谁、什么时候、做了什么。" />
      {!list ? (
        <div className="flex justify-center py-16">
          <Spinner />
        </div>
      ) : list.length === 0 ? (
        <p className="py-16 text-center text-sm text-fg-3">还没有记录</p>
      ) : (
        <div className="panel divide-y divide-line">
          {list.map((item) => (
            <div key={item.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-4 py-2.5 text-sm">
              <span className="w-24 shrink-0 font-mono text-xs text-fg-3">{formatTime(item.createdAt)}</span>
              <span className="shrink-0 font-medium">{ACTION_LABEL[item.action] ?? item.action}</span>
              <span className="min-w-0 flex-1 truncate text-fg-2">{item.summary}</span>
              <span className="shrink-0 text-xs text-fg-3">{item.actorEmail ?? '系统'}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
