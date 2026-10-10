import { useCallback, useEffect, useState } from 'react';
import { Search } from 'lucide-react';
import { Button, Spinner } from '../../components/ui.tsx';
import { adminApi, formatTime, type AdminUser } from '../../lib/adminApi.ts';
import { reportError, useStore } from '../../lib/store.ts';
import { useDebouncedCallback } from '../../lib/util.ts';
import { PageHeader } from './AdminLayout.tsx';
import { confirmDialog } from '../../components/ConfirmDialog.tsx';

export default function AdminUsers() {
  const me = useStore((s) => s.user);
  const toast = useStore((s) => s.toast);
  const [q, setQ] = useState('');
  const [list, setList] = useState<AdminUser[] | null>(null);
  const load = useCallback((query = '') => adminApi.users(query).then(setList, reportError), []);
  const search = useDebouncedCallback((value: string) => void load(value), 300);

  useEffect(() => {
    void load();
  }, [load]);

  async function update(user: AdminUser, patch: { role?: 'user' | 'admin'; disabled?: boolean }, message: string) {
    if (patch.disabled && !(await confirmDialog({ title: `停用 ${user.email}？`, message: '对方会立即下线，无法再登录。', confirmText: '停用', danger: true }))) return;
    try {
      await adminApi.updateUser(user.id, patch);
      toast(message, 'success');
      void load(q);
    } catch (error) {
      reportError(error);
    }
  }

  return (
    <div>
      <PageHeader title="用户" hint="设置管理员、停用账号。ADMIN_EMAILS 里的邮箱每次启动都会被设为管理员。" />
      <label className="relative mb-3 block sm:w-72">
        <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-fg-3" />
        <input
          className="field !pl-9 text-sm"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            search(e.target.value);
          }}
          placeholder="邮箱或昵称"
        />
      </label>
      {!list ? (
        <div className="flex justify-center py-16">
          <Spinner />
        </div>
      ) : (
        <div className="panel divide-y divide-line">
          {list.map((user) => (
            <div key={user.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <span className="bg-brand flex size-9 shrink-0 items-center justify-center rounded-full text-sm font-semibold text-white">
                {user.name.slice(0, 1).toUpperCase()}
              </span>
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-2 text-sm">
                  <span className="truncate">{user.name}</span>
                  {user.role === 'admin' && <span className="rounded bg-accent/15 px-1.5 text-[11px] text-accent">管理员</span>}
                  {user.disabled && <span className="rounded bg-danger/15 px-1.5 text-[11px] text-danger">已停用</span>}
                </p>
                <p className="truncate text-xs text-fg-3">
                  {user.email} · 任务 {user.taskCount} · 资产 {user.assetCount} · 故事 {user.storyCount} · 最近登录 {formatTime(user.lastLoginAt)}
                </p>
              </div>
              {user.id !== me?.id && (
                <div className="flex gap-1.5">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void update(user, { role: user.role === 'admin' ? 'user' : 'admin' }, user.role === 'admin' ? '已取消管理员' : '已设为管理员')}
                  >
                    {user.role === 'admin' ? '取消管理员' : '设为管理员'}
                  </Button>
                  <Button
                    size="sm"
                    variant={user.disabled ? 'secondary' : 'danger'}
                    onClick={() => void update(user, { disabled: !user.disabled }, user.disabled ? '已恢复' : '已停用')}
                  >
                    {user.disabled ? '恢复' : '停用'}
                  </Button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
