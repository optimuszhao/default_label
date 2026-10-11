// 后台 · 工作流（WF-06）：启停、排序、默认参数。"算子侧模板"要等算子提供通用执行接口，暂不显示
import { useCallback, useEffect, useState } from 'react';
import { Workflow as WorkflowIcon } from 'lucide-react';
import { Button, Modal, Spinner, Toggle } from '../../components/ui.tsx';
import { api, type WorkflowInfo } from '../../lib/api.ts';
import { reportError, useStore } from '../../lib/store.ts';
import { PageHeader } from './AdminLayout.tsx';

type AdminWorkflow = WorkflowInfo & { enabled: boolean; sort: number; defaults: Record<string, unknown>; runs: number };

function DefaultsDialog({ workflow, onClose, onSaved }: { workflow: AdminWorkflow | null; onClose: () => void; onSaved: () => void }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (workflow) setValues(Object.fromEntries(workflow.inputs.filter((i) => i.type !== 'image' && i.type !== 'character').map((i) => [i.key, i.default == null ? '' : Array.isArray(i.default) ? i.default.join('\n') : String(i.default)])));
  }, [workflow]);
  if (!workflow) return null;
  const inputs = workflow.inputs.filter((i) => i.type !== 'image' && i.type !== 'character');
  async function save() {
    setBusy(true);
    try {
      const defaults: Record<string, unknown> = {};
      for (const input of inputs) {
        const raw = values[input.key] ?? '';
        if (!raw.trim()) continue;
        defaults[input.key] = input.type === 'lines' ? raw.split('\n').filter((l) => l.trim()) : typeof input.options?.[0] === 'number' ? Number(raw) : raw;
      }
      await api.patchAdminWorkflow(workflow!.id, { defaults });
      useStore.getState().toast('默认参数已保存', 'success');
      onSaved();
    } catch (error) {
      reportError(error);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal open onClose={onClose} title={`默认参数 · ${workflow.title}`}>
      <div className="space-y-3">
        {inputs.map((input) => (
          <label key={input.key} className="block">
            <span className="label">{input.label}</span>
            {input.options ? (
              <select className="field" value={values[input.key] ?? ''} onChange={(e) => setValues({ ...values, [input.key]: e.target.value })}>
                {input.options.map((o) => (
                  <option key={String(o)} value={String(o)}>
                    {String(o)}
                  </option>
                ))}
              </select>
            ) : input.type === 'lines' || input.multiline ? (
              <textarea className="field min-h-20 text-sm" value={values[input.key] ?? ''} onChange={(e) => setValues({ ...values, [input.key]: e.target.value })} />
            ) : (
              <input className="field" value={values[input.key] ?? ''} onChange={(e) => setValues({ ...values, [input.key]: e.target.value })} placeholder={input.type === 'preset' ? '预设 slug，如 style-cinematic' : ''} />
            )}
          </label>
        ))}
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button variant="brand" loading={busy} onClick={() => void save()}>
            保存
          </Button>
        </div>
      </div>
    </Modal>
  );
}

export default function AdminWorkflows() {
  const [list, setList] = useState<AdminWorkflow[] | null>(null);
  const [editing, setEditing] = useState<AdminWorkflow | null>(null);
  const load = useCallback(() => void api.adminWorkflows().then(setList).catch(reportError), []);
  useEffect(load, [load]);

  async function patch(id: string, body: { enabled?: boolean; sort?: number }) {
    try {
      await api.patchAdminWorkflow(id, body);
      load();
    } catch (error) {
      reportError(error);
    }
  }

  return (
    <div>
      <PageHeader title="工作流" hint="停用后用户端不再显示，进行中的运行不受影响。排序数字小的在前。" />
      {list === null ? (
        <Spinner />
      ) : (
        <div className="panel divide-y divide-line">
          {list.map((w) => (
            <div key={w.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <WorkflowIcon className="size-4 shrink-0 text-accent" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{w.title}</p>
                <p className="truncate text-xs text-fg-3">
                  {w.id} · 运行过 {w.runs} 次
                </p>
              </div>
              <label className="flex items-center gap-1.5 text-xs text-fg-3">
                排序
                <input
                  type="number"
                  className="field !h-8 w-16 !px-2 text-sm"
                  defaultValue={w.sort}
                  onBlur={(e) => Number(e.target.value) !== w.sort && void patch(w.id, { sort: Math.trunc(Number(e.target.value) || 0) })}
                  aria-label={`${w.title} 排序`}
                />
              </label>
              <Button size="sm" variant="ghost" onClick={() => setEditing(w)}>
                默认参数
              </Button>
              <Toggle checked={w.enabled} onChange={(enabled) => void patch(w.id, { enabled })} label={`启用 ${w.title}`} />
            </div>
          ))}
        </div>
      )}
      <DefaultsDialog
        workflow={editing}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          load();
        }}
      />
    </div>
  );
}
