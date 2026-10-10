import { useNavigate } from 'react-router-dom';
import { LogOut, Server } from 'lucide-react';
import { TokenCard } from '../../components/TokenCard.tsx';
import { Button, HealthPills, Toggle } from '../../components/ui.tsx';
import { api } from '../../lib/api.ts';
import { reportError, useStore } from '../../lib/store.ts';
import { timeAgo } from '../../lib/util.ts';

export default function Settings() {
  const user = useStore((s) => s.user);
  const settings = useStore((s) => s.settings);
  const health = useStore((s) => s.health);
  const setSettings = useStore((s) => s.setSettings);
  const setSession = useStore((s) => s.setSession);
  const navigate = useNavigate();

  async function logout() {
    try {
      await api.logout();
    } finally {
      setSession(null, null);
      navigate('/');
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4 px-4 py-6 sm:px-6 md:py-10">
      <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">设置</h1>

      <section className="panel flex items-center gap-4 p-5">
        <span className="bg-brand flex size-14 items-center justify-center rounded-xl text-xl font-semibold text-white">
          {user?.name.slice(0, 1).toUpperCase()}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-lg font-medium">{user?.name}</p>
          <p className="truncate text-sm text-fg-3">{user?.email}</p>
        </div>
        <Button variant="ghost" icon={<LogOut className="size-4" />} onClick={() => void logout()}>
          退出
        </Button>
      </section>

      <section className="panel space-y-4 p-5">
        <div className="flex items-center gap-2">
          <Server className="size-4 text-cyan" />
          <h2 className="font-medium">生成服务</h2>
        </div>
        <HealthPills />
        <p className="text-sm text-fg-3">
          当前适配器：<span className="font-mono text-fg-2">{health?.provider ?? '-'}</span>
          {health?.message ? ` · ${health.message}` : ''}
          {health ? ` · ${timeAgo(health.checkedAt)}检查` : ''}
        </p>
        <p className="text-sm leading-relaxed text-fg-3">
          生成服务和语言模型在服务端通过环境变量配置（<code className="rounded bg-white/5 px-1 font-mono text-fg-2">PROVIDER</code>、
          <code className="rounded bg-white/5 px-1 font-mono text-fg-2">GEN_API_BASE</code>、
          <code className="rounded bg-white/5 px-1 font-mono text-fg-2">LLM_API_BASE</code> 等），说明见仓库 README。
        </p>
      </section>

      {user?.isAdmin && <TokenCard />}

      <section className="panel flex items-center justify-between gap-4 p-5">
        <div>
          <h2 className="font-medium">自动调度</h2>
          <p className="mt-1 text-sm text-fg-3">开启后，排队任务会在服务可用时自动提交；关闭后需要在队列页手动运行。</p>
        </div>
        <Toggle
          checked={Boolean(settings?.autoDispatch)}
          label="自动调度"
          onChange={async (value) => {
            try {
              setSettings(await api.updateSettings({ autoDispatch: value }));
            } catch (error) {
              reportError(error);
            }
          }}
        />
      </section>
    </div>
  );
}
