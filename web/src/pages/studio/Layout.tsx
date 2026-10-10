import { useEffect, useMemo } from 'react';
import { Link, NavLink, Outlet } from 'react-router-dom';
import { BookOpenText, Images, ListOrdered, Settings, Sparkles } from 'lucide-react';
import { HealthPills, Logo } from '../../components/ui.tsx';
import { api } from '../../lib/api.ts';
import { useStore } from '../../lib/store.ts';
import { cx } from '../../lib/util.ts';

const NAV = [
  { to: '/studio/create', label: '创作', icon: Sparkles },
  { to: '/studio/stories', label: '故事', icon: BookOpenText },
  { to: '/studio/queue', label: '队列', icon: ListOrdered },
  { to: '/studio/assets', label: '资产', icon: Images },
  { to: '/studio/settings', label: '设置', icon: Settings },
];

function useQueueBadge(): number {
  const tasks = useStore((s) => s.tasks);
  return useMemo(
    () => Object.values(tasks).filter((task) => task.status === 'queued' || task.status === 'running').length,
    [tasks],
  );
}

export default function StudioLayout() {
  const user = useStore((s) => s.user);
  const upsertTasks = useStore((s) => s.upsertTasks);
  const setHealth = useStore((s) => s.setHealth);
  const active = useQueueBadge();

  // 进入工作台时拉取最近任务和服务状态，之后靠 SSE 增量更新
  useEffect(() => {
    void api.tasks({ limit: 300 }).then(upsertTasks).catch(() => undefined);
    void api.health().then(setHealth).catch(() => undefined);
  }, [upsertTasks, setHealth]);

  return (
    <div className="min-h-dvh md:pl-[76px] lg:pl-60">
      {/* 桌面侧边栏 */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-[76px] flex-col border-r border-line bg-ink/80 backdrop-blur-xl md:flex lg:w-60">
        <Link to="/" className="flex h-16 items-center px-5">
          <Logo className="lg:hidden" compact />
          <Logo className="hidden lg:inline-flex" />
        </Link>
        <nav className="mt-2 flex flex-1 flex-col gap-1 px-3">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                cx(
                  'group relative flex h-11 items-center gap-3 rounded-xl px-3 text-sm transition-colors max-lg:justify-center',
                  isActive ? 'bg-white/[0.08] text-fg' : 'text-fg-3 hover:bg-white/[0.04] hover:text-fg',
                )
              }
            >
              <item.icon className="size-[18px] shrink-0" />
              <span className="hidden lg:inline">{item.label}</span>
              {item.to.endsWith('queue') && active > 0 && (
                <span className="bg-brand ml-auto rounded-full px-1.5 text-[10px] leading-4 font-semibold text-white max-lg:absolute max-lg:top-1.5 max-lg:right-2">
                  {active}
                </span>
              )}
            </NavLink>
          ))}
        </nav>
        <div className="space-y-3 border-t border-line p-4 max-lg:hidden">
          <HealthPills />
          <div className="flex items-center gap-2.5">
            <span className="bg-brand flex size-8 items-center justify-center rounded-full text-sm font-semibold text-white">
              {user?.name.slice(0, 1).toUpperCase()}
            </span>
            <div className="min-w-0">
              <p className="truncate text-sm">{user?.name}</p>
              <p className="truncate text-xs text-fg-3">{user?.email}</p>
            </div>
          </div>
        </div>
      </aside>

      {/* 移动端顶部栏 */}
      <header className="glass sticky top-0 z-30 flex h-14 items-center justify-between border-x-0 border-t-0 px-4 md:hidden">
        <Link to="/">
          <Logo />
        </Link>
        <HealthPills compact />
      </header>

      <main className="pb-[calc(76px+env(safe-area-inset-bottom))] md:pb-0">
        <Outlet />
      </main>

      {/* 移动端底部导航 */}
      <nav className="glass pb-safe fixed inset-x-0 bottom-0 z-30 border-x-0 border-b-0 md:hidden">
        <div className="grid h-16 grid-cols-5">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                cx(
                  'relative flex flex-col items-center justify-center gap-1 text-[11px] transition-colors',
                  isActive ? 'text-fg' : 'text-fg-3',
                )
              }
            >
              {({ isActive }) => (
                <>
                  <item.icon className={cx('size-5 transition-transform duration-300', isActive && 'scale-110')} />
                  {item.label}
                  {item.to.endsWith('queue') && active > 0 && (
                    <span className="bg-brand absolute top-1.5 left-1/2 ml-2 rounded-full px-1.5 text-[10px] leading-4 font-semibold text-white">
                      {active}
                    </span>
                  )}
                </>
              )}
            </NavLink>
          ))}
        </div>
      </nav>
    </div>
  );
}
