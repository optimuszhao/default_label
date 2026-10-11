// 工作流页面（WF-04）：官方工作流卡片 → 启动表单（预计耗时、无人值守）→ 运行视图（步骤时间线、人工挑选卡片、产物）
import { useEffect, useMemo, useState } from 'react';
import { Check, ChevronRight, CircleDashed, Clock, ImagePlus, Loader2, Pause, Play, RotateCcw, SkipForward, Square, Trash2, Workflow as WorkflowIcon, X } from 'lucide-react';
import type { Asset, WorkflowRun } from '../../../../shared/types.ts';
import { AssetPicker } from '../../components/AssetPicker.tsx';
import { Lightbox } from '../../components/Lightbox.tsx';
import { Button, Empty, Media, Modal, Spinner, Toggle } from '../../components/ui.tsx';
import { confirmDialog } from '../../components/ConfirmDialog.tsx';
import { api, type WorkflowInfo, type WorkflowInputInfo } from '../../lib/api.ts';
import { reportError, useStore } from '../../lib/store.ts';
import { cx, timeAgo } from '../../lib/util.ts';
import { useCatalog } from './create/catalog.ts';

const RUN_STATUS: Record<WorkflowRun['status'], string> = { running: '进行中', waiting: '等你挑选', paused: '已暂停', succeeded: '已完成', failed: '失败', canceled: '已取消' };
const STEP_ICON = {
  pending: <CircleDashed className="size-4 text-fg-3" />,
  running: <Loader2 className="size-4 animate-spin text-accent" />,
  waiting: <ImagePlus className="size-4 text-warn" />,
  done: <Check className="size-4 text-ok" />,
  skipped: <SkipForward className="size-4 text-fg-3" />,
  failed: <X className="size-4 text-danger" />,
  canceled: <Square className="size-4 text-fg-3" />,
} as const;

function useAssets(ids: string[]) {
  const assets = useStore((s) => s.assets);
  const upsertAssets = useStore((s) => s.upsertAssets);
  const key = ids.join(',');
  useEffect(() => {
    const missing = ids.filter((id) => !useStore.getState().assets[id]);
    if (missing.length) void Promise.all(missing.map((id) => api.asset(id).catch(() => null))).then((list) => upsertAssets(list.filter((a): a is Asset => Boolean(a))));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, upsertAssets]);
  return ids.map((id) => assets[id]).filter(Boolean);
}

function InputField({ input, value, onChange, characters }: { input: WorkflowInputInfo; value: unknown; onChange: (value: unknown) => void; characters: { value: string; label: string; name: string; appearance: string }[] }) {
  const presets = useCatalog((s) => s.presets);
  const [picking, setPicking] = useState(false);
  const picked = useAssets(typeof value === 'string' && input.type === 'image' && value ? [value] : []);
  switch (input.type) {
    case 'select':
      return (
        <select className="field" value={String(value ?? '')} onChange={(e) => onChange(typeof input.options?.[0] === 'number' ? Number(e.target.value) : e.target.value)}>
          {input.options?.map((option) => (
            <option key={String(option)} value={String(option)}>
              {String(option)}
            </option>
          ))}
        </select>
      );
    case 'preset':
      return (
        <select className="field" value={String(value ?? '')} onChange={(e) => onChange(e.target.value)}>
          <option value="">不加风格</option>
          {presets
            .filter((p) => p.kind === 'style')
            .map((p) => (
              <option key={p.slug} value={p.slug}>
                {p.name}
              </option>
            ))}
        </select>
      );
    case 'lines':
      return (
        <textarea
          className="field min-h-24 text-sm"
          value={Array.isArray(value) ? value.join('\n') : String(value ?? '')}
          onChange={(e) => onChange(e.target.value.split('\n'))}
          placeholder="每行一段"
        />
      );
    case 'image':
      return (
        <div className="flex items-center gap-3">
          <button type="button" onClick={() => setPicking(true)} className="flex aspect-video w-32 items-center justify-center overflow-hidden rounded-lg border border-dashed border-line-strong text-fg-3 hover:border-accent">
            {picked[0] ? <Media asset={picked[0]} variant="thumb" /> : <ImagePlus className="size-5" />}
          </button>
          <span className="text-xs text-fg-3">{picked[0] ? '点击更换' : '选择或上传一张图'}</span>
          <AssetPicker open={picking} onClose={() => setPicking(false)} title={input.label} onPick={([asset]) => onChange(asset.id)} />
        </div>
      );
    case 'character':
      return (
        <select className="field" value={String(value ?? '')} onChange={(e) => onChange(e.target.value)}>
          <option value="">不关联故事角色</option>
          {characters.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
      );
    default:
      return input.multiline ? (
        <textarea className="field min-h-20 text-sm" value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} placeholder={input.placeholder} />
      ) : (
        <input className="field" value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} placeholder={input.placeholder} />
      );
  }
}

function StartDialog({ workflow, onClose, onStarted }: { workflow: WorkflowInfo | null; onClose: () => void; onStarted: (run: WorkflowRun) => void }) {
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [unattended, setUnattended] = useState(false);
  const [busy, setBusy] = useState(false);
  const [characters, setCharacters] = useState<{ value: string; label: string; name: string; appearance: string }[]>([]);
  useEffect(() => {
    if (!workflow) return;
    setValues(Object.fromEntries(workflow.inputs.map((input) => [input.key, input.default ?? (input.type === 'lines' ? [] : '')])));
    setUnattended(false);
    if (workflow.inputs.some((i) => i.type === 'character')) void api.workflowCharacters().then(setCharacters).catch(() => undefined);
  }, [workflow]);
  if (!workflow) return null;
  const hasSelect = workflow.steps.some((s) => s.kind === 'select');
  async function start() {
    setBusy(true);
    try {
      const run = await api.startWorkflow(workflow!.id, values, unattended);
      onStarted(run);
    } catch (error) {
      reportError(error);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal open onClose={onClose} title={workflow.title} wide>
      <div className="space-y-4">
        <p className="text-sm text-fg-2">{workflow.description}</p>
        {workflow.inputs.map((input) => (
          <div key={input.key}>
            <label className="label">
              {input.label}
              {input.required && <span className="text-danger"> *</span>}
            </label>
            <InputField
              input={input}
              value={values[input.key]}
              characters={characters}
              onChange={(value) => {
                const next = { ...values, [input.key]: value };
                // 选了故事角色：带上它的名字和外貌
                if (input.type === 'character') {
                  const found = characters.find((c) => c.value === value);
                  if (found) Object.assign(next, { name: found.name, appearance: found.appearance });
                }
                setValues(next);
              }}
            />
            {input.hint && <p className="mt-1 text-xs text-fg-3">{input.hint}</p>}
          </div>
        ))}
        {hasSelect && (
          <label className="flex items-center justify-between gap-3 rounded-lg border border-line px-3 py-2.5 text-sm">
            <span>
              无人值守
              <span className="ml-2 text-xs text-fg-3">需要挑选时自动选第一张，一路跑完</span>
            </span>
            <Toggle checked={unattended} onChange={setUnattended} label="无人值守" />
          </label>
        )}
        <p className="flex items-center gap-1.5 text-xs text-fg-3">
          <Clock className="size-3.5" /> 预计：{workflow.estimate}
        </p>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button variant="brand" loading={busy} onClick={() => void start()}>
            开始
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function SelectCard({ run, step }: { run: WorkflowRun; step: WorkflowRun['steps'][number] }) {
  const from = run.steps.find((s) => s.id === step.from);
  const candidates = useAssets(from?.assets ?? []);
  const [chosen, setChosen] = useState<string[]>([]);
  const [viewing, setViewing] = useState<Asset | null>(null);
  const upsertRuns = useStore((s) => s.upsertRuns);
  const max = step.max ?? 1;
  return (
    <div className="mt-2 rounded-lg border border-warn/40 bg-warn/5 p-3">
      {step.hint && <p className="mb-2 text-xs text-fg-2">{step.hint}</p>}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {candidates.map((asset) => {
          const on = chosen.includes(asset.id);
          return (
            <button
              key={asset.id}
              onClick={() => setChosen((prev) => (on ? prev.filter((id) => id !== asset.id) : max === 1 ? [asset.id] : prev.length < max ? [...prev, asset.id] : prev))}
              onDoubleClick={() => setViewing(asset)}
              className={cx('relative aspect-square overflow-hidden rounded-lg border-2', on ? 'border-accent' : 'border-transparent')}
              aria-pressed={on}
              aria-label="候选"
            >
              <Media asset={asset} variant="thumb" />
              {on && <Check className="absolute top-1.5 right-1.5 size-5 rounded-full bg-accent p-0.5 text-white" />}
            </button>
          );
        })}
      </div>
      <div className="mt-2 flex justify-end">
        <Button
          size="sm"
          variant="brand"
          disabled={chosen.length < (step.min ?? 1)}
          onClick={async () => {
            try {
              upsertRuns([await api.workflowStep(run.id, step.id, 'select', chosen)]);
            } catch (error) {
              reportError(error);
            }
          }}
        >
          用这{chosen.length > 1 ? `${chosen.length} 张` : '张'}继续
        </Button>
      </div>
      <Lightbox asset={viewing} onClose={() => setViewing(null)} />
    </div>
  );
}

function RunCard({ run, expanded, onToggle }: { run: WorkflowRun; expanded: boolean; onToggle: () => void }) {
  const upsertRuns = useStore((s) => s.upsertRuns);
  const tasks = useStore((s) => s.tasks);
  const outputs = useAssets(run.outputs.slice(0, 8));
  const [viewing, setViewing] = useState<Asset | null>(null);
  const act = async (fn: () => Promise<WorkflowRun>) => {
    try {
      upsertRuns([await fn()]);
    } catch (error) {
      reportError(error);
    }
  };
  const active = ['running', 'waiting', 'paused'].includes(run.status);
  return (
    <div className={cx('panel overflow-hidden', run.status === 'waiting' && 'ring-1 ring-warn/50')}>
      <button onClick={onToggle} className="flex w-full items-center gap-3 px-4 py-3 text-left">
        <ChevronRight className={cx('size-4 shrink-0 text-fg-3 transition-transform', expanded && 'rotate-90')} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{run.title}</p>
          <p className="text-xs text-fg-3">
            {timeAgo(run.createdAt)} · {run.taskCount} 个任务{run.unattended ? ' · 无人值守' : ''}
          </p>
        </div>
        <span className={cx('shrink-0 rounded-full px-2 py-0.5 text-[11px]', run.status === 'waiting' ? 'bg-warn/15 text-warn' : run.status === 'succeeded' ? 'bg-ok/15 text-ok' : run.status === 'failed' ? 'bg-danger/15 text-danger' : 'bg-white/[0.06] text-fg-2')}>
          {RUN_STATUS[run.status]}
        </span>
      </button>
      {expanded && (
        <div className="border-t border-line px-4 py-3">
          <ol className="space-y-2">
            {run.steps.map((step) => {
              const progress = step.taskIds.map((id) => tasks[id]).filter(Boolean);
              const running = progress.filter((t) => t.status === 'running');
              return (
                <li key={step.id}>
                  <div className="flex items-center gap-2 text-sm">
                    {STEP_ICON[step.status]}
                    <span className={cx(step.status === 'pending' && 'text-fg-3')}>{step.label}</span>
                    {step.status === 'running' && step.taskIds.length > 0 && (
                      <span className="text-xs text-fg-3">
                        {progress.filter((t) => t.status === 'succeeded').length}/{step.taskIds.length}
                        {running[0] ? ` · ${running[0].stage ?? '生成中'} ${Math.round(running[0].progress * 100)}%` : ''}
                      </span>
                    )}
                    {step.note && <span className="text-xs text-fg-3">{step.note}</span>}
                    {step.error && <span className="truncate text-xs text-danger">{step.error}</span>}
                    <span className="flex-1" />
                    {(step.status === 'failed' || (run.status === 'failed' && step.status !== 'done')) && (
                      <>
                        <Button size="sm" variant="ghost" icon={<RotateCcw className="size-3.5" />} onClick={() => void act(() => api.workflowStep(run.id, step.id, 'retry'))}>
                          重试这一步
                        </Button>
                        <Button size="sm" variant="ghost" icon={<SkipForward className="size-3.5" />} onClick={() => void act(() => api.workflowStep(run.id, step.id, 'skip'))}>
                          跳过
                        </Button>
                      </>
                    )}
                  </div>
                  {step.status === 'waiting' && step.kind === 'select' && run.status !== 'paused' && <SelectCard run={run} step={step} />}
                </li>
              );
            })}
          </ol>
          {outputs.length > 0 && (
            <div className="mt-3">
              <p className="label">产物</p>
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
                {outputs.map((asset) => (
                  <button key={asset.id} onClick={() => setViewing(asset)} className="aspect-square overflow-hidden rounded-lg border border-line">
                    <Media asset={asset} variant="thumb" />
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="mt-3 flex flex-wrap justify-end gap-2">
            {run.status === 'paused' ? (
              <Button size="sm" variant="ghost" icon={<Play className="size-3.5" />} onClick={() => void act(() => api.workflowAction(run.id, 'resume'))}>
                继续
              </Button>
            ) : (
              active && (
                <Button size="sm" variant="ghost" icon={<Pause className="size-3.5" />} onClick={() => void act(() => api.workflowAction(run.id, 'pause'))}>
                  暂停
                </Button>
              )
            )}
            {active && (
              <Button
                size="sm"
                variant="ghost"
                className="text-danger"
                icon={<Square className="size-3.5" />}
                onClick={async () => {
                  if (await confirmDialog({ title: '取消这个工作流？', message: '名下还在排队和生成的任务会一起取消，已生成的素材保留。', confirmText: '取消运行', danger: true }))
                    void act(() => api.workflowAction(run.id, 'cancel'));
                }}
              >
                取消运行
              </Button>
            )}
            {!active && (
              <Button
                size="sm"
                variant="ghost"
                icon={<Trash2 className="size-3.5" />}
                onClick={async () => {
                  try {
                    await api.deleteWorkflowRun(run.id);
                    useStore.setState((s) => {
                      const next = { ...s.workflowRuns };
                      delete next[run.id];
                      return { workflowRuns: next };
                    });
                  } catch (error) {
                    reportError(error);
                  }
                }}
              >
                删除记录
              </Button>
            )}
          </div>
        </div>
      )}
      <Lightbox asset={viewing} onClose={() => setViewing(null)} list={outputs} />
    </div>
  );
}

export default function Workflows() {
  const [list, setList] = useState<WorkflowInfo[] | null>(null);
  const [starting, setStarting] = useState<WorkflowInfo | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const runs = useStore((s) => s.workflowRuns);
  const upsertRuns = useStore((s) => s.upsertRuns);
  const upsertTasks = useStore((s) => s.upsertTasks);
  const loadCatalog = useCatalog((s) => s.load);

  useEffect(() => {
    void loadCatalog();
    void api.workflows().then(setList).catch(reportError);
    void api.workflowRuns().then(upsertRuns).catch(reportError);
    void api.tasks({ limit: 300 }).then(upsertTasks).catch(() => undefined);
  }, [loadCatalog, upsertRuns, upsertTasks]);

  const sorted = useMemo(() => {
    const order: Record<string, number> = { waiting: 0, running: 1, paused: 2 };
    return Object.values(runs).sort((a, b) => (order[a.status] ?? 3) - (order[b.status] ?? 3) || b.createdAt - a.createdAt);
  }, [runs]);

  useEffect(() => {
    if (!expanded && sorted[0] && ['waiting', 'running'].includes(sorted[0].status)) setExpanded(sorted[0].id);
  }, [sorted, expanded]);

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 md:py-10">
      <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">工作流</h1>
      <p className="mt-1 text-sm text-fg-3">把几步生成串起来自动跑：出候选 → 你挑 → 继续生成。需要挑选时会在侧栏提醒你。</p>

      <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {list === null
          ? Array.from({ length: 4 }, (_, i) => <div key={i} className="skeleton h-40 rounded-xl" />)
          : list.map((workflow) => (
              <button key={workflow.id} onClick={() => setStarting(workflow)} className="panel flex flex-col p-4 text-left transition hover:border-line-strong">
                <p className="flex items-center gap-2 font-medium">
                  <WorkflowIcon className="size-4 text-accent" />
                  {workflow.title}
                </p>
                <p className="mt-1.5 line-clamp-3 flex-1 text-xs text-fg-3">{workflow.description}</p>
                <p className="mt-3 flex flex-wrap items-center gap-1 text-[11px] text-fg-3">
                  {workflow.steps.map((step, i) => (
                    <span key={step.id} className="flex items-center gap-1">
                      {i > 0 && <ChevronRight className="size-3" />}
                      {step.label}
                    </span>
                  ))}
                </p>
              </button>
            ))}
      </div>

      <h2 className="mt-10 mb-3 text-sm font-semibold">运行记录</h2>
      {sorted.length === 0 ? (
        list === null ? (
          <Spinner />
        ) : (
          <Empty icon={<WorkflowIcon className="size-6" />} title="还没有运行过工作流" hint="选上面的一个工作流开始。" />
        )
      ) : (
        <div className="space-y-2">
          {sorted.map((run) => (
            <RunCard key={run.id} run={run} expanded={expanded === run.id} onToggle={() => setExpanded((prev) => (prev === run.id ? null : run.id))} />
          ))}
        </div>
      )}

      <StartDialog
        workflow={starting}
        onClose={() => setStarting(null)}
        onStarted={(run) => {
          upsertRuns([run]);
          setExpanded(run.id);
          setStarting(null);
        }}
      />
    </div>
  );
}
