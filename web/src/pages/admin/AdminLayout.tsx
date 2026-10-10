import { Link, NavLink, Outlet } from 'react-router-dom';
import { ArrowLeft, Archive, Cpu, Gauge, ListChecks, ScrollText, Users } from 'lucide-react';
import { Logo } from '../../components/ui.tsx';
import { cx } from '../../lib/util.ts';

const NAV = [
  { to: '/admin', label: '概览', icon: Gauge, end: true },
  { to: '/admin/operators', label: '算子', icon: Cpu },
  { to: '/admin/tasks', label: '任务', icon: ListChecks },
  { to: '/admin/users', label: '用户', icon: Users },
  { to: '/admin/backups', label: '备份', icon: Archive },
  { to: '/admin/audit', label: '审计', icon: ScrollText },
];

/** 管理后台外壳：桌面左侧栏，手机顶部横向标签 */
export default function AdminLayout() {
  return (
    <div className="min-h-dvh md:pl-52">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-52 flex-col border-r border-line bg-ink/80 backdrop-blur-xl md:flex">
        <div className="flex h-14 items-center gap-2 px-5">
          <Logo compact />
          <span className="rounded bg-accent/15 px-1.5 py-0.5 text-[11px] font-medium text-accent">管理后台</span>
        </div>
        <nav className="mt-2 flex flex-1 flex-col gap-1 px-3">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                cx(
                  'flex h-9 items-center gap-2.5 rounded-lg px-3 text-[13px] transition-colors',
                  isActive ? 'bg-white/[0.08] text-fg' : 'text-fg-3 hover:bg-white/[0.04] hover:text-fg',
                )
              }
            >
              <item.icon className="size-[18px] shrink-0" />
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="border-t border-line p-3">
          <Link to="/studio/create" className="flex h-9 items-center gap-2 rounded-lg px-3 text-[13px] text-fg-3 hover:bg-white/[0.04] hover:text-fg">
            <ArrowLeft className="size-4" /> 返回工作台
          </Link>
        </div>
      </aside>

      <header className="glass sticky top-0 z-30 border-x-0 border-t-0 md:hidden">
        <div className="flex h-12 items-center justify-between px-4">
          <div className="flex items-center gap-2">
            <Logo compact />
            <span className="rounded bg-accent/15 px-1.5 py-0.5 text-[11px] font-medium text-accent">管理后台</span>
          </div>
          <Link to="/studio/create" className="flex items-center gap-1 text-xs text-fg-3">
            <ArrowLeft className="size-3.5" /> 工作台
          </Link>
        </div>
        <nav className="no-scrollbar flex gap-1 overflow-x-auto px-3 pb-2">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                cx('flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-xs', isActive ? 'bg-white/[0.08] text-fg' : 'text-fg-3')
              }
            >
              <item.icon className="size-3.5" />
              {item.label}
            </NavLink>
          ))}
        </nav>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-5 sm:px-6 md:py-8">
        <Outlet />
      </main>
    </div>
  );
}

/** 后台页面标题 */
export function PageHeader({ title, hint, actions }: { title: string; hint?: string; actions?: React.ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {hint && <p className="mt-1 text-sm text-fg-3">{hint}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

/** 状态圆点 */
export function Dot({ tone }: { tone: 'ok' | 'warn' | 'danger' | 'muted' }) {
  const color = { ok: 'bg-ok', warn: 'bg-warn', danger: 'bg-danger', muted: 'bg-fg-3' }[tone];
  return <span className={cx('inline-block size-2 shrink-0 rounded-full', color)} />;
}
