import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ArrowUpToLine, RotateCcw, Search, Square } from 'lucide-react';
import { TASK_TYPE_LABEL } from '../../../../shared/types.ts';
import { IconButton, Segmented, Spinner, StatusBadge } from '../../components/ui.tsx';
import { adminApi, formatTime, type AdminTask } from '../../lib/adminApi.ts';
import { reportError, useStore } from '../../lib/store.ts';
import { useDebouncedCallback } from '../../lib/util.ts';
import { PageHeader } from './AdminLayout.tsx';

const FILTERS = [
  { value: '', label: '全部' },
  { value: 'queued,paused', label: '排队' },
  { value: 'running', label: '生成中' },
  { value: 'failed', label: '失败' },
  { value: 'succeeded', label: '完成' },
];

export default function AdminTasks() {
  const [params, setParams] = useSearchParams();
  const status = params.get('status') ?? '';
  const [q, setQ] = useState('');
  const [list, setList] = useState<AdminTask[] | null>(null);
  const toast = useStore((s) => s.toast);

  const load = useCallback((query: string) => adminApi.tasks({ status, q: query }).then(setList, reportError), [status]);
  const search = useDebouncedCallback((value: string) => void load(value), 300);

  useEffect(() => {
    setList(null);
    void load(q);
    // 只在筛选状态变化时重新加载，搜索框走防抖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  async function act(task: AdminTask, action: 'cancel' | 'retry' | 'top') {
    try {
      await adminApi.taskAction(task.id, action);
      toast({ cancel: '已取消', retry: '已重新排队', top: '已插队到最前' }[action], 'success');
      void load(q);
    } catch (error) {
      reportError(error);
    }
  }

  return (
    <div>
      <PageHeader title="全局任务" hint="所有用户的任务。可以取消、重新排队、插队。" />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Segmented value={status} onChange={(value) => setParams(value ? { status: value } : {})} options={FILTERS} />
        <label className="relative ml-auto w-full sm:w-72">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-fg-3" />
          <input
            className="field !pl-9 text-sm"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              search(e.target.value);
            }}
            placeholder="任务号、用户邮箱、提示词"
          />
        </label>
      </div>
      {!list ? (
        <div className="flex justify-center py-16">
          <Spinner />
        </div>
      ) : list.length === 0 ? (
        <p className="py-16 text-center text-sm text-fg-3">没有任务</p>
      ) : (
        <div className="panel divide-y divide-line">
          {list.map((task) => (
            <div key={task.id} className="flex items-start gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm">{task.prompt}</p>
                <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-fg-3">
                  <StatusBadge status={task.status} waiting={Boolean(task.waitReason)} />
                  <span>{TASK_TYPE_LABEL[task.type]}</span>
                  <span>{task.userEmail}</span>
                  {task.operatorName && <span>· {task.operatorName}</span>}
                  <span>· {formatTime(task.createdAt)}</span>
                  {task.priority !== 0 && <span className="font-mono">P{task.priority}</span>}
                  <span className="font-mono text-[10px]">{task.id}</span>
                </div>
                {(task.lastError || task.waitReason) && <p className="mt-1 truncate text-xs text-warn">{task.waitReason ?? task.lastError}</p>}
              </div>
              <div className="flex shrink-0">
                {(task.status === 'queued' || task.status === 'paused') && (
                  <IconButton label="插队到最前" onClick={() => void act(task, 'top')}>
                    <ArrowUpToLine className="size-4" />
                  </IconButton>
                )}
                {(task.status === 'failed' || task.status === 'canceled') && (
                  <IconButton label="重新排队" onClick={() => void act(task, 'retry')}>
                    <RotateCcw className="size-4" />
                  </IconButton>
                )}
                {['queued', 'paused', 'running'].includes(task.status) && (
                  <IconButton label="取消" onClick={() => void act(task, 'cancel')}>
                    <Square className="size-4" />
                  </IconButton>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
