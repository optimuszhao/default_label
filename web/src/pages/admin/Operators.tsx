import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, ChevronRight, Cpu, Plus, Power, RefreshCw, Trash2, Wrench } from 'lucide-react';
import type { OperatorSummary } from '../../../../shared/types.ts';
import { TokenCard } from '../../components/TokenCard.tsx';
import { Button, Empty, Modal, Segmented, Spinner, Toggle } from '../../components/ui.tsx';
import { adminApi, formatTime } from '../../lib/adminApi.ts';
import { reportError, useStore } from '../../lib/store.ts';
import { timeAgo } from '../../lib/util.ts';
import { Dot, PageHeader } from './AdminLayout.tsx';
import { OperatorForm } from './OperatorForm.tsx';

export const STATUS: Record<OperatorSummary['status'], { label: string; tone: 'ok' | 'warn' | 'danger' | 'muted' }> = {
  online: { label: '在线', tone: 'ok' },
  offline: { label: '离线', tone: 'danger' },
  maintenance: { label: '维护中', tone: 'warn' },
  disabled: { label: '已停用', tone: 'muted' },
  unknown: { label: '检测中', tone: 'muted' },
};

const KIND_LABEL: Record<OperatorSummary['kind'], string> = { comfyweb: 'ComfyUI Web API', http: '通用 HTTP', mock: '模拟算子' };

function tokenText(op: OperatorSummary, now: number): string {
  if (op.kind !== 'comfyweb') return '';
  if (op.tokenOk === false) return '令牌校验失败';
  if (!op.tokenExpiresAt) return '令牌未获取';
  const hours = Math.floor((op.tokenExpiresAt - now) / 3600_000);
  return hours > 0 ? `令牌剩余 ${hours} 小时` : '令牌即将到期';
}

export function OperatorRow({ op }: { op: OperatorSummary }) {
  const status = STATUS[op.status];
  return (
    <Link to={`/admin/operators/${op.id}`} className="panel flex items-center gap-3 p-4 transition-colors hover:border-line-strong">
      <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-white/[0.05]">
        <Cpu className="size-5 text-fg-2" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="font-medium">{op.name}</span>
          <span className="inline-flex items-center gap-1.5 text-xs text-fg-2">
            <Dot tone={status.tone} />
            {status.label}
          </span>
          {op.visibility === 'admin_only' && <span className="rounded bg-white/[0.06] px-1.5 text-[11px] text-fg-3">仅管理员</span>}
        </div>
        <p className="mt-1 truncate text-xs text-fg-3">
          {KIND_LABEL[op.kind]}
          {op.baseUrl && ` · ${op.baseUrl}`}
          {op.status === 'offline' && op.health.message && ` · ${op.health.message}`}
          {op.status === 'maintenance' && op.maintenanceNote && ` · ${op.maintenanceNote}`}
        </p>
      </div>
      <div className="hidden shrink-0 text-right text-xs text-fg-3 sm:block">
        <p>
          运行 <span className="font-mono text-fg">{op.running}</span> / {op.maxInflight}
        </p>
        <p className="mt-0.5">{tokenText(op, Date.now())}</p>
      </div>
      <ChevronRight className="size-4 shrink-0 text-fg-3" />
    </Link>
  );
}

export function OperatorList() {
  const [list, setList] = useState<OperatorSummary[] | null>(null);
  const [creating, setCreating] = useState(false);
  const navigate = useNavigate();
  const load = useCallback(() => adminApi.operators().then(setList, reportError), []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 15_000);
    return () => clearInterval(timer);
  }, [load]);

  return (
    <div>
      <PageHeader
        title="算子"
        hint="算子是提供算力的机器或服务。任务会派给在线、未维护、还有空位且优先级最高的算子。"
        actions={
          <>
            <Button variant="ghost" icon={<RefreshCw className="size-4" />} onClick={() => void load()}>
              刷新
            </Button>
            <Button variant="brand" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>
              新建算子
            </Button>
          </>
        }
      />
      {!list ? (
        <div className="flex justify-center py-16">
          <Spinner />
        </div>
      ) : list.length === 0 ? (
        <Empty icon={<Cpu className="size-5" />} title="还没有算子" hint="新建一个算子，填好地址和凭证，测试通过后保存" />
      ) : (
        <div className="space-y-2">
          {list.map((op) => (
            <OperatorRow key={op.id} op={op} />
          ))}
        </div>
      )}
      <Modal open={creating} onClose={() => setCreating(false)} title="新建算子" wide>
        <OperatorForm
          onCancel={() => setCreating(false)}
          onSaved={(op) => {
            setCreating(false);
            navigate(`/admin/operators/${op.id}`);
          }}
        />
      </Modal>
    </div>
  );
}

type Tab = 'overview' | 'token' | 'settings' | 'remote';

export function OperatorDetail() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const toast = useStore((s) => s.toast);
  const [op, setOp] = useState<OperatorSummary | null>(null);
  const [tab, setTab] = useState<Tab>('overview');
  const [remote, setRemote] = useState<Record<string, unknown>[] | null>(null);
  const [note, setNote] = useState('');

  const load = useCallback(
    () =>
      adminApi.operators().then((list) => {
        const found = list.find((item) => item.id === id) ?? null;
        setOp(found);
        if (found) setNote(found.maintenanceNote ?? '');
      }, reportError),
    [id],
  );

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (tab !== 'remote') return;
    setRemote(null);
    adminApi.remoteTasks(id).then(setRemote, (error) => {
      reportError(error);
      setRemote([]);
    });
  }, [tab, id]);

  async function patch(input: Parameters<typeof adminApi.updateOperator>[1], message: string) {
    try {
      setOp(await adminApi.updateOperator(id, input));
      toast(message, 'success');
    } catch (error) {
      reportError(error);
    }
  }

  async function remove() {
    if (!op || !window.confirm(`删除算子「${op.name}」？它的密钥和令牌会一并删除。`)) return;
    try {
      await adminApi.deleteOperator(id);
      toast('已删除', 'success');
      navigate('/admin/operators');
    } catch (error) {
      reportError(error);
    }
  }

  if (!op) {
    return (
      <div className="flex justify-center py-16">
        <Spinner />
      </div>
    );
  }
  const status = STATUS[op.status];

  return (
    <div>
      <Link to="/admin/operators" className="mb-3 inline-flex items-center gap-1 text-sm text-fg-3 hover:text-fg">
        <ArrowLeft className="size-4" /> 全部算子
      </Link>
      <PageHeader
        title={op.name}
        hint={`${KIND_LABEL[op.kind]}${op.baseUrl ? ` · ${op.baseUrl}` : ''}`}
        actions={
          <span className="inline-flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1 text-sm">
            <Dot tone={status.tone} />
            {status.label}
          </span>
        }
      />

      <Segmented
        value={tab}
        onChange={setTab}
        options={[
          { value: 'overview', label: '概览' },
          ...(op.kind === 'comfyweb' ? [{ value: 'token' as Tab, label: '凭证与令牌' }] : []),
          { value: 'settings', label: '设置' },
          ...(op.kind === 'comfyweb' ? [{ value: 'remote' as Tab, label: '远端任务' }] : []),
        ]}
      />

      <div className="mt-4">
        {tab === 'overview' && (
          <div className="grid gap-3 md:grid-cols-2">
            <section className="panel p-4">
              <h2 className="mb-2 font-medium">运行状态</h2>
              <dl className="divide-y divide-line text-sm">
                <div className="flex justify-between py-2">
                  <dt className="text-fg-3">能力</dt>
                  <dd>{[op.health.image && '图片', op.health.video && '视频'].filter(Boolean).join(' / ') || '暂不可用'}</dd>
                </div>
                <div className="flex justify-between py-2">
                  <dt className="text-fg-3">正在运行</dt>
                  <dd>
                    {op.running} / {op.maxInflight}
                  </dd>
                </div>
                <div className="flex justify-between py-2">
                  <dt className="text-fg-3">上次检查</dt>
                  <dd>{op.health.checkedAt ? timeAgo(op.health.checkedAt) : '—'}</dd>
                </div>
                {op.health.message && (
                  <div className="py-2">
                    <dt className="text-fg-3">信息</dt>
                    <dd className="mt-1 break-all text-xs text-danger">{op.health.message}</dd>
                  </div>
                )}
                <div className="flex justify-between py-2">
                  <dt className="text-fg-3">优先级</dt>
                  <dd>{op.priority}</dd>
                </div>
                <div className="flex justify-between py-2">
                  <dt className="text-fg-3">更新时间</dt>
                  <dd>{formatTime(op.updatedAt)}</dd>
                </div>
              </dl>
            </section>
            <section className="panel space-y-4 p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="flex items-center gap-1.5 font-medium">
                    <Power className="size-4" /> 启用
                  </p>
                  <p className="text-xs text-fg-3">停用后不再接收新任务，正在跑的任务继续完成</p>
                </div>
                <Toggle checked={op.enabled} label="启用" onChange={(value) => void patch({ enabled: value }, value ? '已启用' : '已停用')} />
              </div>
              <div>
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="flex items-center gap-1.5 font-medium">
                      <Wrench className="size-4" /> 维护模式
                    </p>
                    <p className="text-xs text-fg-3">朋友要重启机器、换显卡时打开；用户会看到维护说明</p>
                  </div>
                  <Toggle
                    checked={op.maintenance}
                    label="维护模式"
                    onChange={(value) => void patch({ maintenance: value, maintenanceNote: note || null }, value ? '已进入维护' : '已结束维护')}
                  />
                </div>
                <input
                  className="field mt-2 text-sm"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  onBlur={() => note !== (op.maintenanceNote ?? '') && void patch({ maintenanceNote: note || null }, '已更新维护说明')}
                  placeholder="维护说明，例如：今晚 22 点前恢复"
                  maxLength={200}
                />
              </div>
              <Button variant="danger" size="sm" icon={<Trash2 className="size-3.5" />} onClick={() => void remove()}>
                删除算子
              </Button>
            </section>
          </div>
        )}

        {tab === 'token' && (
          <section className="panel p-4">
            <TokenCard operatorId={op.id} />
          </section>
        )}

        {tab === 'settings' && (
          <section className="panel p-4">
            <OperatorForm
              initial={op}
              onSaved={(saved) => {
                setOp(saved);
                toast('已保存', 'success');
              }}
            />
          </section>
        )}

        {tab === 'remote' && (
          <section className="panel overflow-x-auto p-0">
            {!remote ? (
              <div className="flex justify-center py-10">
                <Spinner />
              </div>
            ) : remote.length === 0 ? (
              <p className="p-6 text-center text-sm text-fg-3">没有远端任务</p>
            ) : (
              <table className="w-full min-w-[560px] text-left text-sm">
                <thead className="border-b border-line text-xs text-fg-3">
                  <tr>
                    <th className="px-4 py-2 font-normal">任务号</th>
                    <th className="px-4 py-2 font-normal">类型</th>
                    <th className="px-4 py-2 font-normal">状态</th>
                    <th className="px-4 py-2 font-normal">提示词</th>
                    <th className="px-4 py-2 font-normal">创建</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {remote.map((item, index) => (
                    <tr key={String(item.task_id ?? item.id ?? index)}>
                      <td className="px-4 py-2 font-mono text-xs">{String(item.task_id ?? item.id ?? '—')}</td>
                      <td className="px-4 py-2">{String(item.type ?? '—')}</td>
                      <td className="px-4 py-2">
                        {String(item.status ?? '—')}
                        {item.stage ? <span className="ml-1 text-xs text-fg-3">{String(item.stage)}</span> : null}
                      </td>
                      <td className="max-w-[16rem] truncate px-4 py-2 text-fg-2">{String(item.prompt ?? '')}</td>
                      <td className="px-4 py-2 text-xs text-fg-3">{String(item.created_at ?? '')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
