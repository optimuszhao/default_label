import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowDown,
  ArrowUp,
  BookOpenText,
  Film,
  Image as ImageIcon,
  ListOrdered,
  Pause,
  Play,
  PlayCircle,
  RefreshCw,
  RotateCcw,
  Square,
  Trash2,
} from 'lucide-react';
import { TASK_TYPE_LABEL, type Task, type TaskStatus } from '../../../../shared/types.ts';
import { Button, Empty, HealthPills, IconButton, Media, ProgressBar, Segmented, StatusBadge, Toggle } from '../../components/ui.tsx';
import { api } from '../../lib/api.ts';
import { reportError, useStore } from '../../lib/store.ts';
import { cx, timeAgo, useNow } from '../../lib/util.ts';

type Filter = 'active' | 'queued' | 'running' | 'failed' | 'done' | 'all';

const FILTERS: Record<Filter, (task: Task) => boolean> = {
  active: (task) => ['queued', 'running', 'paused'].includes(task.status),
  queued: (task) => task.status === 'queued' || task.status === 'paused',
  running: (task) => task.status === 'running',
  failed: (task) => task.status === 'failed',
  done: (task) => task.status === 'succeeded' || task.status === 'canceled',
  all: () => true,
};

const INTERVALS = [10, 30, 60, 300];

const STATUS_ORDER: Record<TaskStatus, number> = { running: 0, queued: 1, paused: 2, failed: 3, succeeded: 4, canceled: 5 };

function TaskRow({ task, now }: { task: Task; now: number }) {
  const assets = useStore((s) => s.assets);
  const upsertTasks = useStore((s) => s.upsertTasks);
  const removeTask = useStore((s) => s.removeTask);
  const isVideo = task.type === 't2v' || task.type === 'i2v';
  const preview = task.outputAssetIds.map((id) => assets[id]).find(Boolean);
  const waitSec = Math.ceil((task.nextAttemptAt - now) / 1000);

  async function act(action: 'run' | 'pause' | 'resume' | 'cancel' | 'retry') {
    try {
      upsertTasks([await api.taskAction(task.id, action)]);
    } catch (error) {
      reportError(error);
    }
  }
  async function priority(delta: number) {
    try {
      upsertTasks([await api.setPriority(task.id, Math.max(-10, Math.min(10, task.priority + delta)))]);
    } catch (error) {
      reportError(error);
    }
  }
  async function remove() {
    try {
      await api.deleteTask(task.id);
      removeTask(task.id);
    } catch (error) {
      reportError(error);
    }
  }

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-line bg-ink-1 p-3 transition-colors hover:border-line-strong sm:flex-row sm:items-center sm:p-4">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <div className="relative flex size-14 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-ink-3">
          {preview ? <Media asset={preview} /> : isVideo ? <Film className="size-5 text-fg-3" /> : <ImageIcon className="size-5 text-fg-3" />}
          {task.status === 'running' && <div className="skeleton absolute inset-0" />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="truncate text-sm font-medium">{task.title}</p>
            {task.priority !== 0 && (
              <span className={cx('shrink-0 rounded px-1 text-[10px] font-mono', task.priority > 0 ? 'bg-pink/15 text-pink' : 'bg-white/5 text-fg-3')}>
                P{task.priority > 0 ? `+${task.priority}` : task.priority}
              </span>
            )}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-fg-3">
            <StatusBadge status={task.status} waiting={Boolean(task.waitReason)} />
            <span>{TASK_TYPE_LABEL[task.type]}</span>
            {task.link.storyId && (
              <Link to={`/studio/stories/${task.link.storyId}`} className="inline-flex items-center gap-1 hover:text-fg">
                <BookOpenText className="size-3" /> 故事{task.link.purpose === 'video' ? '视频' : '关键帧'}
              </Link>
            )}
            <span>{timeAgo(task.createdAt)}</span>
            {task.attempts > 0 && <span>尝试 {task.attempts}/{task.maxAttempts}</span>}
          </div>
          {task.status === 'running' && (
            <div className="mt-2 flex max-w-sm items-center gap-2">
              <ProgressBar value={task.progress} className="min-w-0 flex-1" />
              <span className="shrink-0 text-xs text-fg-3">{task.stage ?? '生成中'}</span>
            </div>
          )}
          {task.status === 'running' && task.waitReason && <p className="mt-1.5 text-xs text-warn">{task.waitReason}</p>}
          {task.status === 'queued' && task.waitReason && (
            <p className="mt-1.5 text-xs text-warn">
              {task.waitReason}
              {waitSec > 0 ? ` · ${waitSec} 秒后重试` : ''}
            </p>
          )}
          {task.status === 'queued' && !task.waitReason && task.lastError && (
            <p className="mt-1.5 line-clamp-2 text-xs text-warn">{task.lastError}</p>
          )}
          {task.status === 'failed' && <p className="mt-1.5 line-clamp-2 text-xs text-danger">{task.lastError}</p>}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-0.5 self-end sm:self-center">
        {(task.status === 'queued' || task.status === 'paused') && (
          <>
            <IconButton label="提高优先级" onClick={() => void priority(1)}><ArrowUp className="size-4" /></IconButton>
            <IconButton label="降低优先级" onClick={() => void priority(-1)}><ArrowDown className="size-4" /></IconButton>
          </>
        )}
        {task.status === 'queued' && (
          <>
            <IconButton label="暂停" onClick={() => void act('pause')}><Pause className="size-4" /></IconButton>
            <Button size="sm" variant="secondary" icon={<Play className="size-3.5" />} onClick={() => void act('run')}>立即运行</Button>
          </>
        )}
        {task.status === 'paused' && (
          <Button size="sm" variant="secondary" icon={<Play className="size-3.5" />} onClick={() => void act('resume')}>继续</Button>
        )}
        {(task.status === 'queued' || task.status === 'running' || task.status === 'paused') && (
          <IconButton label="取消" onClick={() => void act('cancel')}><Square className="size-4" /></IconButton>
        )}
        {(task.status === 'failed' || task.status === 'canceled') && (
          <Button size="sm" variant="secondary" icon={<RotateCcw className="size-3.5" />} onClick={() => void act('retry')}>重试</Button>
        )}
        {task.status !== 'running' && (
          <IconButton label="删除" onClick={() => void remove()} className="hover:text-danger"><Trash2 className="size-4" /></IconButton>
        )}
      </div>
    </div>
  );
}

export default function Queue() {
  const tasks = useStore((s) => s.tasks);
  const settings = useStore((s) => s.settings);
  const setSettings = useStore((s) => s.setSettings);
  const setHealth = useStore((s) => s.setHealth);
  const upsertTasks = useStore((s) => s.upsertTasks);
  const removeTask = useStore((s) => s.removeTask);
  const toast = useStore((s) => s.toast);
  const [filter, setFilter] = useState<Filter>('active');
  const [busy, setBusy] = useState<string | null>(null);
  const now = useNow();

  const all = Object.values(tasks);
  const counts = {
    queued: all.filter((t) => t.status === 'queued').length,
    running: all.filter((t) => t.status === 'running').length,
    failed: all.filter((t) => t.status === 'failed').length,
    done: all.filter((t) => t.status === 'succeeded').length,
  };

  const list = useMemo(
    () =>
      Object.values(tasks)
        .filter(FILTERS[filter])
        .sort(
          (a, b) =>
            STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
            (a.status === 'queued' || a.status === 'paused'
              ? b.priority - a.priority || a.createdAt - b.createdAt
              : b.updatedAt - a.updatedAt),
        ),
    [tasks, filter],
  );

  async function updateSettings(patch: Parameters<typeof api.updateSettings>[0]) {
    try {
      setSettings(await api.updateSettings(patch));
    } catch (error) {
      reportError(error);
    }
  }

  async function queueAction(action: 'run-all' | 'pause-all' | 'resume-all' | 'clear-finished') {
    setBusy(action);
    try {
      const { count } = await api.queueAction(action);
      if (action === 'clear-finished') {
        for (const task of all) if (task.status === 'succeeded' || task.status === 'canceled') removeTask(task.id);
      } else {
        upsertTasks(await api.tasks({ limit: 300 }));
      }
      toast(
        { 'run-all': `已触发 ${count} 个任务`, 'pause-all': `已暂停 ${count} 个任务`, 'resume-all': `已恢复 ${count} 个任务`, 'clear-finished': `已清理 ${count} 条记录` }[action],
        'success',
      );
    } catch (error) {
      reportError(error);
    } finally {
      setBusy(null);
    }
  }

  async function refreshHealth() {
    setBusy('health');
    try {
      setHealth(await api.refreshHealth());
    } catch (error) {
      reportError(error);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6 md:py-10">
      <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">任务队列</h1>
      <p className="mt-1 text-sm text-fg-3">编辑好的生成任务在这里排队，服务可用时自动或手动提交。</p>

      <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          { label: '排队中', value: counts.queued, tone: 'text-cyan' },
          { label: '生成中', value: counts.running, tone: 'text-violet' },
          { label: '失败', value: counts.failed, tone: 'text-danger' },
          { label: '已完成', value: counts.done, tone: 'text-ok' },
        ].map((item) => (
          <div key={item.label} className="panel p-4">
            <p className="text-xs text-fg-3">{item.label}</p>
            <p className={cx('mt-1 font-mono text-2xl font-semibold', item.tone)}>{item.value}</p>
          </div>
        ))}
      </div>

      <div className="panel mt-3 grid gap-4 p-4 sm:p-5 lg:grid-cols-[1fr_auto]">
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-sm text-fg-2">生成服务</span>
            <HealthPills />
            <IconButton label="立即检查" onClick={() => void refreshHealth()} className={cx('size-7', busy === 'health' && 'animate-spin')}>
              <RefreshCw className="size-3.5" />
            </IconButton>
          </div>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
            <label className="flex items-center gap-3 text-sm">
              <Toggle checked={Boolean(settings?.autoDispatch)} onChange={(value) => void updateSettings({ autoDispatch: value })} label="自动调度" />
              <span>
                自动调度
                <span className="ml-1.5 text-xs text-fg-3">{settings?.autoDispatch ? '服务可用时自动提交' : '仅手动运行'}</span>
              </span>
            </label>
            <div className="flex items-center gap-2 text-sm">
              <span className="text-fg-2">不可用时每隔</span>
              <Segmented
                size="sm"
                value={String(settings?.pollIntervalSec ?? 30)}
                onChange={(value) => void updateSettings({ pollIntervalSec: Number(value) })}
                options={INTERVALS.map((sec) => ({ value: String(sec), label: sec >= 60 ? `${sec / 60}分` : `${sec}秒` }))}
              />
              <span className="text-fg-2">重试</span>
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-start gap-2 lg:justify-end">
          <Button variant="brand" size="sm" icon={<PlayCircle className="size-4" />} loading={busy === 'run-all'} onClick={() => void queueAction('run-all')}>
            立即运行全部
          </Button>
          <Button size="sm" icon={<Pause className="size-3.5" />} loading={busy === 'pause-all'} onClick={() => void queueAction('pause-all')}>
            全部暂停
          </Button>
          <Button size="sm" icon={<Play className="size-3.5" />} loading={busy === 'resume-all'} onClick={() => void queueAction('resume-all')}>
            全部继续
          </Button>
          <Button size="sm" variant="ghost" icon={<Trash2 className="size-3.5" />} loading={busy === 'clear-finished'} onClick={() => void queueAction('clear-finished')}>
            清理已完成
          </Button>
        </div>
      </div>

      <div className="no-scrollbar -mx-4 mt-6 overflow-x-auto px-4 sm:mx-0 sm:px-0">
        <Segmented
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'active', label: '进行中' },
            { value: 'queued', label: '排队' },
            { value: 'running', label: '生成中' },
            { value: 'failed', label: '失败' },
            { value: 'done', label: '已结束' },
            { value: 'all', label: '全部' },
          ]}
        />
      </div>

      <div className="mt-4 space-y-2">
        {list.length === 0 ? (
          <Empty
            icon={<ListOrdered className="size-6" />}
            title="队列里没有任务"
            hint="在创作页或故事工坊里把任务加入队列，它们会出现在这里。"
            action={<Link to="/studio/create"><Button variant="primary">去创作</Button></Link>}
          />
        ) : (
          list.map((task) => <TaskRow key={task.id} task={task} now={now} />)
        )}
      </div>
    </div>
  );
}
