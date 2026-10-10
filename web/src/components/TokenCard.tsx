// 算子令牌状态卡（OPR-00 v0）：只有管理员能看到。
// 显示 token 是否在手、何时签发和到期、上次校验结果，可以立即校验或重新获取。
import { useEffect, useState } from 'react';
import { KeyRound, RefreshCw, ShieldCheck } from 'lucide-react';
import type { TokenStatus } from '../../../shared/types.ts';
import { api } from '../lib/api.ts';
import { reportError, useStore } from '../lib/store.ts';
import { cx, timeAgo, useNow } from '../lib/util.ts';
import { Button, Spinner } from './ui.tsx';

function formatTime(ts: number | null | undefined): string {
  if (!ts) return '—';
  const date = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function remaining(expiresAt: number, now: number): string {
  const ms = expiresAt - now;
  if (ms <= 0) return '已过期';
  const hours = Math.floor(ms / 3600_000);
  const minutes = Math.floor((ms % 3600_000) / 60_000);
  return hours >= 1 ? `剩余 ${hours} 小时 ${minutes} 分` : `剩余 ${minutes} 分钟`;
}

const BASIS: Record<string, string> = {
  jwt: '从令牌内容读出',
  assumed: '按接口文档的 72 小时推算',
  env: '手动配置的令牌，到期时间未知',
};

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5 text-sm">
      <span className="shrink-0 text-fg-3">{label}</span>
      <span className="min-w-0 truncate text-right">{children}</span>
    </div>
  );
}

export function TokenCard() {
  const toast = useStore((s) => s.toast);
  const now = useNow(30_000);
  const [status, setStatus] = useState<TokenStatus | null>(null);
  const [busy, setBusy] = useState<null | 'verify' | 'renew'>(null);

  useEffect(() => {
    api.tokenStatus().then(setStatus, reportError);
  }, []);

  async function run(action: 'verify' | 'renew') {
    setBusy(action);
    try {
      const next = action === 'verify' ? await api.verifyToken() : await api.renewToken();
      setStatus(next);
      if (next.lastVerifyOk) toast(action === 'verify' ? '令牌有效' : '已重新获取令牌', 'success');
      else toast(next.lastVerifyMessage ?? next.lastLoginError ?? '操作失败', 'error');
    } catch (error) {
      reportError(error);
    } finally {
      setBusy(null);
    }
  }

  if (!status) {
    return (
      <section className="panel flex justify-center p-6">
        <Spinner />
      </section>
    );
  }

  const state = !status.supported
    ? { label: '无需令牌', tone: 'text-fg-3' }
    : !status.configured
      ? { label: '未配置', tone: 'text-danger' }
      : status.lastVerifyOk === false
        ? { label: '校验失败', tone: 'text-danger' }
        : status.hasToken
          ? { label: status.lastVerifyOk ? '有效' : '已获取', tone: 'text-ok' }
          : { label: '未获取', tone: 'text-warn' };

  return (
    <section className="panel p-5">
      <div className="flex items-center gap-2">
        <KeyRound className="size-4 text-accent" />
        <h2 className="font-medium">算子令牌</h2>
        <span className="rounded bg-white/[0.06] px-1.5 py-0.5 font-mono text-[10px] text-fg-3">仅管理员可见</span>
        <span className={cx('ml-auto text-sm font-medium', state.tone)}>{state.label}</span>
      </div>

      {!status.supported ? (
        <p className="mt-3 text-sm text-fg-3">当前算子（{status.operator}）不需要令牌。</p>
      ) : (
        <>
          <div className="mt-3 divide-y divide-line">
            <Row label="服务地址">
              <span className="font-mono text-xs">{status.base || '未配置 GEN_API_BASE'}</span>
            </Row>
            <Row label="API ID">
              <span className="font-mono text-xs">{status.appid || (status.configured ? '—' : '未配置 COMFY_APPID / COMFY_SECRET')}</span>
            </Row>
            <Row label="令牌">
              <span className="font-mono text-xs">{status.tokenPreview ?? '尚未获取（首次调用时自动获取）'}</span>
            </Row>
            <Row label="签发时间">{formatTime(status.issuedAt)}</Row>
            <Row label="到期时间">
              {status.expiresAt ? (
                <>
                  {formatTime(status.expiresAt)}
                  <span className="ml-2 text-xs text-fg-3">{remaining(status.expiresAt, now)}</span>
                </>
              ) : (
                '—'
              )}
            </Row>
            {status.expiresBasis && (
              <Row label="到期依据">
                <span className="text-xs text-fg-2">{BASIS[status.expiresBasis]}</span>
              </Row>
            )}
            <Row label="上次校验">
              {status.lastVerifyAt ? (
                <span className={status.lastVerifyOk ? 'text-ok' : 'text-danger'}>
                  {timeAgo(status.lastVerifyAt)} · {status.lastVerifyMessage}
                </span>
              ) : (
                '—'
              )}
            </Row>
            {status.lastLoginError && (
              <Row label="登录错误">
                <span className="text-danger">{status.lastLoginError}</span>
              </Row>
            )}
          </div>
          <p className="mt-3 text-xs leading-relaxed text-fg-3">
            织影用 API ID 和密钥向算子换取令牌，到期前 1 小时和遇到 401 时会自动重新获取。API ID 和密钥目前在服务端环境变量里配置，下一版本会改为在后台页面里管理。
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" loading={busy === 'verify'} disabled={busy !== null} icon={<ShieldCheck className="size-3.5" />} onClick={() => void run('verify')}>
              立即校验
            </Button>
            <Button size="sm" variant="ghost" loading={busy === 'renew'} disabled={busy !== null} icon={<RefreshCw className="size-3.5" />} onClick={() => void run('renew')}>
              重新获取
            </Button>
          </div>
        </>
      )}
    </section>
  );
}
