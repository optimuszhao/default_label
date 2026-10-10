// 算子令牌卡片：令牌是否在手、签发和到期（及依据）、剩余时间、上次校验；
// 可以立即校验、重新获取、查看明文（30 秒后自动隐藏）、复制 curl 示例、清除、手动填入。
import { useEffect, useState } from 'react';
import { Copy, Eye, EyeOff, KeyRound, PencilLine, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react';
import type { TokenStatus } from '../../../shared/types.ts';
import { adminApi, formatTime } from '../lib/adminApi.ts';
import { reportError, useStore } from '../lib/store.ts';
import { cx, timeAgo, useNow } from '../lib/util.ts';
import { Button, Modal, Spinner } from './ui.tsx';

const BASIS: Record<string, string> = {
  jwt: '从令牌内容（JWT exp）读出',
  assumed: '按接口文档的 72 小时推算',
  manual: '手动填入，到期时间未知',
  env: '手动配置，到期时间未知',
};

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-2 text-sm">
      <span className="shrink-0 text-fg-3">{label}</span>
      <span className="min-w-0 truncate text-right">{children}</span>
    </div>
  );
}

export function TokenCard({ operatorId }: { operatorId: string }) {
  const toast = useStore((s) => s.toast);
  const now = useNow(15_000);
  const [status, setStatus] = useState<TokenStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<string | null>(null);
  const [manualOpen, setManualOpen] = useState(false);
  const [manual, setManual] = useState('');

  useEffect(() => {
    adminApi.token(operatorId).then(setStatus, reportError);
  }, [operatorId]);

  // 明文令牌 30 秒后自动隐藏
  useEffect(() => {
    if (!revealed) return;
    const timer = setTimeout(() => setRevealed(null), 30_000);
    return () => clearTimeout(timer);
  }, [revealed]);

  async function act(action: 'verify' | 'renew' | 'clear') {
    if (action === 'clear' && !window.confirm('清除织影本地保存的令牌？下次调用时会自动重新获取。')) return;
    setBusy(action);
    try {
      const next = await adminApi.tokenAction(operatorId, action);
      setStatus(next);
      if (action === 'clear') toast('已清除本地令牌', 'success');
      else if (next.lastVerifyOk) toast(action === 'verify' ? '令牌有效' : '已重新获取令牌', 'success');
      else toast(next.lastVerifyMessage ?? next.lastLoginError ?? '操作失败', 'error');
    } catch (error) {
      reportError(error);
    } finally {
      setBusy(null);
    }
  }

  async function reveal() {
    if (revealed) return setRevealed(null);
    try {
      const { token } = await adminApi.revealToken(operatorId);
      if (!token) toast('当前没有令牌', 'info');
      setRevealed(token);
    } catch (error) {
      reportError(error);
    }
  }

  async function copy(text: string, label: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast(`已复制${label}`, 'success');
    } catch {
      toast('浏览器不允许复制，请手动选择文本', 'error');
    }
  }

  async function saveManual() {
    setBusy('manual');
    try {
      setStatus(await adminApi.manualToken(operatorId, manual.trim()));
      setManualOpen(false);
      setManual('');
      toast('已填入令牌', 'success');
    } catch (error) {
      reportError(error);
    } finally {
      setBusy(null);
    }
  }

  if (!status) {
    return (
      <div className="flex justify-center py-8">
        <Spinner />
      </div>
    );
  }
  if (!status.supported) return <p className="py-4 text-sm text-fg-3">这个算子不需要令牌。</p>;

  const remaining = status.expiresAt ? status.expiresAt - now : null;
  const total = status.expiresAt && status.issuedAt ? status.expiresAt - status.issuedAt : null;
  const state = !status.configured
    ? { label: '未配置凭证', tone: 'text-danger' }
    : status.lastVerifyOk === false
      ? { label: '校验失败', tone: 'text-danger' }
      : status.hasToken
        ? remaining !== null && remaining <= 0
          ? { label: '已过期', tone: 'text-danger' }
          : { label: status.lastVerifyOk ? '有效' : '已获取', tone: 'text-ok' }
        : { label: '未获取', tone: 'text-warn' };
  const curl = status.base
    ? `TOKEN='<令牌>'\ncurl -s ${status.base}/api/auth/verify -H "Authorization: Bearer $TOKEN"\ncurl -s ${status.base}/api/tasks -H "Authorization: Bearer $TOKEN"`
    : '';

  return (
    <div>
      <div className="flex items-center gap-2">
        <KeyRound className="size-4 text-accent" />
        <span className="font-medium">令牌</span>
        <span className={cx('text-sm font-medium', state.tone)}>● {state.label}</span>
      </div>
      <div className="mt-2 divide-y divide-line">
        <Row label="令牌">
          <span className="font-mono text-xs">{status.tokenPreview ?? '尚未获取（第一次调用时自动获取）'}</span>
        </Row>
        <Row label="签发">{formatTime(status.issuedAt)}</Row>
        <Row label="到期">
          {status.expiresAt ? (
            <>
              {formatTime(status.expiresAt)}
              <span className="ml-2 text-xs text-fg-3">{status.expiresBasis ? BASIS[status.expiresBasis] : ''}</span>
            </>
          ) : status.expiresBasis ? (
            <span className="text-xs text-fg-3">{BASIS[status.expiresBasis]}</span>
          ) : (
            '—'
          )}
        </Row>
        {remaining !== null && total && (
          <div className="py-2">
            <div className="flex items-center justify-between text-sm">
              <span className="text-fg-3">剩余</span>
              <span>{remaining > 0 ? `${Math.floor(remaining / 3600_000)} 小时 ${Math.floor((remaining % 3600_000) / 60_000)} 分` : '已过期'}</span>
            </div>
            <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-white/[0.06]">
              <div className="h-full rounded-full bg-accent" style={{ width: `${Math.max(0, Math.min(100, (remaining / total) * 100))}%` }} />
            </div>
            <p className="mt-1 text-xs text-fg-3">到期前 1 小时自动续期；调用遇到 401 时自动重新获取。</p>
          </div>
        )}
        <Row label="校验">
          {status.lastVerifyAt ? (
            <span className={status.lastVerifyOk ? 'text-ok' : 'text-danger'}>
              {timeAgo(status.lastVerifyAt)} · {status.lastVerifyMessage}
            </span>
          ) : (
            '—'
          )}
        </Row>
        <Row label="凭证">
          <span className="font-mono text-xs">{status.appid ? `AppID ${status.appid}` : '—'}</span>
        </Row>
        {status.lastLoginError && (
          <Row label="登录错误">
            <span className="text-danger">{status.lastLoginError}</span>
          </Row>
        )}
      </div>

      {revealed && (
        <div className="mt-3 rounded-lg border border-warn/30 bg-warn/10 p-3">
          <p className="mb-1 text-xs text-warn">明文令牌（30 秒后自动隐藏，已记入审计日志）</p>
          <p className="break-all font-mono text-xs select-all">{revealed}</p>
        </div>
      )}

      <div className="mt-4 flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" loading={busy === 'verify'} disabled={busy !== null} icon={<ShieldCheck className="size-3.5" />} onClick={() => void act('verify')}>
          立即校验
        </Button>
        <Button size="sm" variant="secondary" loading={busy === 'renew'} disabled={busy !== null} icon={<RefreshCw className="size-3.5" />} onClick={() => void act('renew')}>
          重新获取
        </Button>
        <Button size="sm" variant="ghost" icon={revealed ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />} onClick={() => void reveal()}>
          {revealed ? '隐藏令牌' : '查看令牌'}
        </Button>
        {revealed && (
          <Button size="sm" variant="ghost" icon={<Copy className="size-3.5" />} onClick={() => void copy(revealed, '令牌')}>
            复制令牌
          </Button>
        )}
        {curl && (
          <Button size="sm" variant="ghost" icon={<Copy className="size-3.5" />} onClick={() => void copy(curl, ' curl 示例')}>
            复制 curl 示例
          </Button>
        )}
        <Button size="sm" variant="ghost" icon={<PencilLine className="size-3.5" />} onClick={() => setManualOpen(true)}>
          手动填入
        </Button>
        <Button size="sm" variant="ghost" icon={<Trash2 className="size-3.5" />} disabled={!status.hasToken || busy !== null} onClick={() => void act('clear')}>
          清除令牌
        </Button>
      </div>

      <Modal open={manualOpen} onClose={() => setManualOpen(false)} title="手动填入令牌">
        <p className="mb-3 text-sm text-fg-3">调试用。填入后直接使用这个令牌，到期时间能从 JWT 读出时会自动识别。</p>
        <textarea className="field resize-none font-mono text-xs" rows={4} value={manual} onChange={(e) => setManual(e.target.value)} placeholder="粘贴令牌" />
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setManualOpen(false)}>
            取消
          </Button>
          <Button variant="brand" disabled={manual.trim().length < 8} loading={busy === 'manual'} onClick={() => void saveManual()}>
            保存
          </Button>
        </div>
      </Modal>
    </div>
  );
}
