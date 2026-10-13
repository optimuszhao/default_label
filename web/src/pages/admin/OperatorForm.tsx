// 算子表单：新建和编辑共用。填好后可以先“测试连接”，看每一步的结果再保存。
import { useState } from 'react';
import { CheckCircle2, CircleSlash, PlugZap, XCircle } from 'lucide-react';
import type { OperatorSummary, OperatorTestStep } from '../../../../shared/types.ts';
import { Button, Segmented, Toggle } from '../../components/ui.tsx';
import { adminApi, type OperatorInput } from '../../lib/adminApi.ts';
import { reportError } from '../../lib/store.ts';

const KINDS: { value: OperatorSummary['kind']; label: string; hint: string }[] = [
  { value: 'comfyweb', label: 'ComfyUI Web API', hint: '朋友的接口：API ID + 密钥换取令牌' },
  { value: 'http', label: '通用 HTTP', hint: '按 docs/API_CONTRACT.md 实现的服务' },
  { value: 'mock', label: '模拟算子', hint: '不需要 GPU，开发和演示用' },
];

export function TestSteps({ steps }: { steps: OperatorTestStep[] }) {
  const preview = steps.find((step) => step.key === 'preview');
  return (
    <div className="space-y-1.5">
      {steps
        .filter((step) => step.key !== 'preview')
        .map((step) => (
          <div key={step.key} className="flex items-start gap-2 text-sm">
            {step.ok === true ? (
              <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-ok" />
            ) : step.ok === false ? (
              <XCircle className="mt-0.5 size-4 shrink-0 text-danger" />
            ) : (
              <CircleSlash className="mt-0.5 size-4 shrink-0 text-fg-3" />
            )}
            <span className="w-20 shrink-0 text-fg-2">{step.label}</span>
            <span className={step.ok === false ? 'text-danger' : 'text-fg-3'}>{step.message}</span>
          </div>
        ))}
      {preview?.message && <img src={preview.message} alt="试跑结果" className="mt-2 size-32 rounded-lg border border-line object-cover" />}
    </div>
  );
}

export function OperatorForm({
  initial,
  onSaved,
  onCancel,
}: {
  initial?: OperatorSummary;
  onSaved: (operator: OperatorSummary) => void;
  onCancel?: () => void;
}) {
  const [form, setForm] = useState<OperatorInput>(() => ({
    name: initial?.name ?? '',
    kind: initial?.kind ?? 'comfyweb',
    baseUrl: initial?.baseUrl ?? '',
    appid: initial?.appid ?? '',
    enabled: initial?.enabled ?? true,
    visibility: initial?.visibility ?? 'all',
    priority: initial?.priority ?? 0,
    maxInflight: initial?.maxInflight ?? 2,
    settings: initial?.settings ?? { imagePollMs: 4000, videoPollMs: 12000 },
  }));
  const [secret, setSecret] = useState('');
  const [steps, setSteps] = useState<OperatorTestStep[] | null>(null);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const set = (patch: Partial<OperatorInput>) => setForm((prev) => ({ ...prev, ...patch }));
  const secretKey = form.kind === 'http' ? 'apiKey' : 'secret';

  const payload = (): OperatorInput => ({
    ...form,
    ...(secret ? { [secretKey]: secret } : {}),
  });

  async function test(generate: boolean) {
    setTesting(true);
    setSteps(null);
    try {
      setSteps(await adminApi.testOperator({ ...payload(), operatorId: initial?.id, generate }));
    } catch (error) {
      reportError(error);
    } finally {
      setTesting(false);
    }
  }

  async function save() {
    setSaving(true);
    try {
      const saved = initial ? await adminApi.updateOperator(initial.id, payload()) : await adminApi.createOperator(payload());
      setSecret('');
      onSaved(saved);
    } catch (error) {
      reportError(error);
    } finally {
      setSaving(false);
    }
  }

  const failed = steps?.some((step) => step.ok === false);

  return (
    <div className="space-y-4">
      <div>
        <label className="label">类型</label>
        <Segmented value={form.kind} onChange={(kind) => set({ kind })} options={KINDS.map((k) => ({ value: k.value, label: k.label }))} />
        <p className="mt-1.5 text-xs text-fg-3">{KINDS.find((k) => k.value === form.kind)?.hint}</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="label">名称</label>
          <input className="field" value={form.name} onChange={(e) => set({ name: e.target.value })} placeholder="例如：朋友的 5090" maxLength={40} />
        </div>
        {form.kind !== 'mock' && (
          <div>
            <label className="label">服务地址</label>
            <input className="field font-mono text-sm" value={form.baseUrl} onChange={(e) => set({ baseUrl: e.target.value })} placeholder="http://114.132.237.136:1025" />
          </div>
        )}
        {form.kind === 'comfyweb' && (
          <div>
            <label className="label">API ID（appid）</label>
            <input className="field font-mono text-sm" value={form.appid} onChange={(e) => set({ appid: e.target.value })} autoComplete="off" />
          </div>
        )}
        {form.kind !== 'mock' && (
          <div>
            <label className="label">
              {form.kind === 'http' ? 'API Key（可选）' : '密钥（secret）'}
              {initial?.secret.set && <span className="ml-1 text-fg-3">· 已设置，留空不修改</span>}
            </label>
            <input
              className="field font-mono text-sm"
              type="password"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              autoComplete="new-password"
              placeholder={initial?.secret.set ? '••••••••' : ''}
            />
          </div>
        )}
      </div>

      <details className="rounded-lg border border-line px-3 py-2">
        <summary className="cursor-pointer text-sm text-fg-2">调度设置</summary>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <div>
            <label className="label">同时运行的任务数</label>
            <input className="field" type="number" min={1} max={32} value={form.maxInflight} onChange={(e) => set({ maxInflight: Number(e.target.value) || 1 })} />
          </div>
          <div>
            <label className="label">优先级（越大越先用）</label>
            <input className="field" type="number" min={-100} max={100} value={form.priority} onChange={(e) => set({ priority: Number(e.target.value) || 0 })} />
          </div>
          <div>
            <label className="label">图片查询间隔（毫秒）</label>
            <input
              className="field"
              type="number"
              value={form.settings?.imagePollMs}
              onChange={(e) => set({ settings: { ...form.settings!, imagePollMs: Number(e.target.value) || 4000 } })}
            />
          </div>
          <div>
            <label className="label">视频查询间隔（毫秒）</label>
            <input
              className="field"
              type="number"
              value={form.settings?.videoPollMs}
              onChange={(e) => set({ settings: { ...form.settings!, videoPollMs: Number(e.target.value) || 12000 } })}
            />
          </div>
          <div>
            <label className="label">语言模型（留空用对方默认）</label>
            <input
              className="field"
              value={form.settings?.llmModel ?? ''}
              onChange={(e) => set({ settings: { ...form.settings!, llmModel: e.target.value.trim() || undefined } })}
              placeholder="例如 huihui_ai/Qwen3.8-abliterated"
            />
          </div>
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm">让模型先思考再回答</p>
              <p className="text-xs text-fg-3">默认关闭：写文案快好几倍；打开后更慢，复杂任务可能更好</p>
            </div>
            <Toggle checked={form.settings?.llmThink === true} onChange={(value) => set({ settings: { ...form.settings!, llmThink: value || undefined } })} label="让模型先思考再回答" />
          </div>
          <div className="flex items-center justify-between gap-3 sm:col-span-2">
            <div>
              <p className="text-sm">仅管理员可用</p>
              <p className="text-xs text-fg-3">开启后普通用户的任务不会派到这个算子（适合测试机）</p>
            </div>
            <Toggle checked={form.visibility === 'admin_only'} onChange={(value) => set({ visibility: value ? 'admin_only' : 'all' })} label="仅管理员可用" />
          </div>
        </div>
      </details>

      {steps && (
        <div className="rounded-lg border border-line bg-white/[0.02] p-3">
          <TestSteps steps={steps} />
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="secondary" loading={testing} icon={<PlugZap className="size-4" />} onClick={() => void test(false)}>
          测试连接
        </Button>
        <Button variant="ghost" disabled={testing} onClick={() => void test(true)}>
          测试并试跑一张图
        </Button>
        <span className="flex-1" />
        {onCancel && (
          <Button variant="ghost" onClick={onCancel}>
            取消
          </Button>
        )}
        <Button variant="brand" loading={saving} disabled={!form.name.trim()} onClick={() => void save()}>
          {failed ? '仍然保存' : '保存'}
        </Button>
      </div>
    </div>
  );
}
