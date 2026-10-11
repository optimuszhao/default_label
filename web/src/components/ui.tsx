import { useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AlertCircle, CheckCircle2, Info, Loader2, Music, X } from 'lucide-react';
import { TASK_STATUS_LABEL, type Asset, type TaskStatus } from '../../../shared/types.ts';
import { useStore } from '../lib/store.ts';
import { cx } from '../lib/util.ts';

// ---------------- Logo ----------------

export function Logo({ className, compact }: { className?: string; compact?: boolean }) {
  return (
    <span className={cx('inline-flex items-center gap-2 font-semibold tracking-tight', className)}>
      <svg viewBox="0 0 64 64" className="size-7 shrink-0" aria-hidden>
        <rect width="64" height="64" rx="14" fill="#4d8dff" />
        <path d="M14 22c6 0 8 22 12 22s6-22 10-22 6 22 10 22 4-10 6-10" fill="none" stroke="#fff" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      {!compact && (
        <span className="text-[15px]">
          织影 <span className="text-fg-3 font-normal">Weave</span>
        </span>
      )}
    </span>
  );
}

// ---------------- Button ----------------

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'brand';

export function Button({
  variant = 'secondary',
  size = 'md',
  loading,
  icon,
  className,
  children,
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: 'sm' | 'md' | 'lg';
  loading?: boolean;
  icon?: ReactNode;
}) {
  const styles: Record<Variant, string> = {
    primary: 'bg-fg text-ink hover:bg-white',
    brand: 'bg-accent text-white hover:bg-accent-hover',
    secondary: 'bg-white/[0.06] text-fg border border-line hover:bg-white/[0.1]',
    ghost: 'text-fg-2 hover:text-fg hover:bg-white/[0.06]',
    danger: 'bg-danger/15 text-danger border border-danger/30 hover:bg-danger/25',
  };
  const sizes = {
    sm: 'h-8 px-3 text-[13px] gap-1.5 rounded-md',
    md: 'h-9 px-3.5 text-[13px] gap-2 rounded-lg',
    lg: 'h-11 px-5 text-sm gap-2 rounded-lg',
  };
  return (
    <button
      className={cx(
        'inline-flex items-center justify-center font-medium select-none transition-[background,filter,transform,color] duration-200 active:scale-[0.97] disabled:opacity-45 disabled:active:scale-100',
        styles[variant],
        sizes[size],
        className,
      )}
      disabled={disabled || loading}
      {...rest}
    >
      {loading ? <Loader2 className="size-4 animate-spin" /> : icon}
      {children}
    </button>
  );
}

export function IconButton({
  label,
  className,
  children,
  active,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; active?: boolean }) {
  return (
    <button
      aria-label={label}
      title={label}
      className={cx(
        'inline-flex size-9 items-center justify-center rounded-lg text-fg-2 transition-colors hover:bg-white/[0.08] hover:text-fg disabled:opacity-40',
        active && 'bg-white/[0.1] text-fg',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

// ---------------- Segmented ----------------

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  className,
  size = 'md',
  label,
}: {
  value: T;
  options: { value: T; label: ReactNode }[];
  onChange: (value: T) => void;
  className?: string;
  size?: 'sm' | 'md';
  /** 整组的无障碍名称 */
  label?: string;
}) {
  return (
    <div className={cx('inline-flex rounded-lg bg-white/[0.04] p-0.5 border border-line', className)} role="tablist" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          role="tab"
          aria-selected={value === option.value}
          onClick={() => onChange(option.value)}
          className={cx(
            'inline-flex items-center gap-1.5 rounded-md font-medium transition-all duration-200 whitespace-nowrap',
            size === 'sm' ? 'h-7 px-2.5 text-xs' : 'h-8 px-3.5 text-[13px]',
            value === option.value ? 'bg-white/[0.12] text-fg shadow-sm' : 'text-fg-3 hover:text-fg-2',
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

// ---------------- Modal / Sheet ----------------

const modalStack: object[] = [];

export function Modal({
  open,
  onClose,
  title,
  children,
  wide,
  bare,
}: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
  wide?: boolean;
  bare?: boolean;
}) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    // 叠在一起的弹窗：Esc 只关最上面那个（只依赖 open，重渲染不会改变叠放顺序）
    const token = {};
    modalStack.push(token);
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && modalStack.at(-1) === token && closeRef.current();
    window.addEventListener('keydown', onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      modalStack.splice(modalStack.indexOf(token), 1);
      document.body.style.overflow = overflow;
    };
  }, [open]);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-6" role="dialog" aria-modal>
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm animate-fade-in" onClick={onClose} />
      <div
        className={cx(
          'relative w-full max-h-[92dvh] overflow-auto animate-fade-up',
          bare ? '' : 'panel rounded-b-none sm:rounded-xl bg-ink-1 p-5 sm:p-6 pb-safe',
          wide ? 'sm:max-w-5xl' : 'sm:max-w-lg',
        )}
      >
        {title && (
          <div className="mb-4 flex items-center justify-between gap-4">
            <h3 className="text-lg font-semibold">{title}</h3>
            <IconButton label="关闭" onClick={onClose}>
              <X className="size-4" />
            </IconButton>
          </div>
        )}
        {children}
      </div>
    </div>,
    document.body,
  );
}

// ---------------- Toasts ----------------

export function Toasts() {
  const toasts = useStore((state) => state.toasts);
  const dismiss = useStore((state) => state.dismissToast);
  return createPortal(
    <div className="pointer-events-none fixed inset-x-0 top-3 z-[60] flex flex-col items-center gap-2 px-4">
      {toasts.map((toast) => (
        <button
          key={toast.id}
          onClick={() => dismiss(toast.id)}
          className="glass pointer-events-auto flex max-w-md items-center gap-2.5 rounded-lg px-4 py-2.5 text-sm shadow-2xl animate-fade-up"
        >
          {toast.kind === 'success' && <CheckCircle2 className="size-4 shrink-0 text-ok" />}
          {toast.kind === 'error' && <AlertCircle className="size-4 shrink-0 text-danger" />}
          {toast.kind === 'info' && <Info className="size-4 shrink-0 text-cyan" />}
          <span className="text-left">{toast.text}</span>
        </button>
      ))}
    </div>,
    document.body,
  );
}

// ---------------- Status ----------------

const STATUS_STYLE: Record<TaskStatus, string> = {
  queued: 'text-cyan bg-cyan/10 border-cyan/25',
  paused: 'text-fg-2 bg-white/5 border-line',
  running: 'text-violet bg-violet/15 border-violet/30',
  succeeded: 'text-ok bg-ok/10 border-ok/25',
  failed: 'text-danger bg-danger/10 border-danger/25',
  canceled: 'text-fg-3 bg-white/5 border-line',
};

export function StatusBadge({ status, waiting }: { status: TaskStatus; waiting?: boolean }) {
  return (
    <span
      className={cx(
        'inline-flex h-6 items-center gap-1.5 rounded-full border px-2 text-[11px] font-medium whitespace-nowrap',
        waiting && status === 'queued' ? 'text-warn bg-warn/10 border-warn/25' : STATUS_STYLE[status],
      )}
    >
      {status === 'running' && <span className="size-1.5 rounded-full bg-current animate-pulse" />}
      {waiting && status === 'queued' ? '等待服务' : TASK_STATUS_LABEL[status]}
    </span>
  );
}

export function ProgressBar({ value, className }: { value: number; className?: string }) {
  return (
    <div className={cx('h-1 w-full overflow-hidden rounded-full bg-white/[0.06]', className)}>
      <div
        className="h-full rounded-full bg-accent transition-[width] duration-700 ease-out"
        style={{ width: `${Math.round(Math.min(1, Math.max(0, value)) * 100)}%` }}
      />
    </div>
  );
}

export function HealthPills({ compact }: { compact?: boolean }) {
  const health = useStore((state) => state.health);
  const items: { key: 'image' | 'video' | 'llm'; label: string }[] = [
    { key: 'image', label: '图像' },
    { key: 'video', label: '视频' },
    { key: 'llm', label: '文案' },
  ];
  return (
    <div className="flex flex-wrap items-center gap-1.5" title={health?.message}>
      {items.map((item) => {
        const ok = health?.[item.key];
        return (
          <span
            key={item.key}
            className={cx(
              'inline-flex h-6 items-center gap-1.5 rounded-full border border-line px-2 text-[11px] text-fg-2',
              compact && 'px-1.5',
            )}
          >
            <span
              className={cx(
                'size-1.5 rounded-full',
                health == null ? 'bg-fg-3' : ok ? 'bg-ok shadow-[0_0_8px] shadow-ok' : 'bg-danger',
              )}
            />
            {item.label}
          </span>
        );
      })}
    </div>
  );
}

// ---------------- Media ----------------

export function isVideoAsset(asset: Pick<Asset, 'mime'>): boolean {
  return asset.mime.startsWith('video/');
}

/**
 * 图片懒加载 + 解码完成后淡入；视频悬停播放，节省带宽和 GPU。
 * variant="thumb"：网格里用，只加载缩略图 / 视频封面，不挂 <video>（素材多时不卡）。
 */
export function Media({
  asset,
  className,
  controls,
  autoPlay,
  fit = 'cover',
  variant = 'full',
}: {
  asset: Pick<Asset, 'url' | 'mime' | 'prompt'> & Partial<Pick<Asset, 'thumbUrl' | 'posterUrl' | 'filename'>>;
  className?: string;
  controls?: boolean;
  autoPlay?: boolean;
  fit?: 'cover' | 'contain';
  variant?: 'full' | 'thumb';
}) {
  const [loaded, setLoaded] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const fitClass = fit === 'cover' ? 'object-cover' : 'object-contain';
  if (asset.mime.startsWith('audio/')) {
    if (controls) {
      return (
        <div className={cx('flex size-full flex-col items-center justify-center gap-4 bg-ink-2 p-6', className)}>
          <Music className="size-10 text-fg-3" />
          <audio src={asset.url} controls autoPlay={autoPlay} className="w-full max-w-md" />
        </div>
      );
    }
    return (
      <div className={cx('flex size-full flex-col items-center justify-center gap-2 bg-ink-2 p-3 text-fg-3', className)}>
        <Music className="size-6" />
        {asset.filename && <span className="line-clamp-2 text-center text-[11px] break-all">{asset.filename}</span>}
      </div>
    );
  }
  const thumb = variant === 'thumb' && asset.thumbUrl && asset.thumbUrl.includes('variant=thumb') ? asset.thumbUrl : null;
  if (isVideoAsset(asset) && !thumb) {
    return (
      <video
        ref={videoRef}
        src={asset.url}
        poster={asset.posterUrl ?? undefined}
        className={cx('size-full bg-ink-2 transition-opacity duration-500', fitClass, loaded || asset.posterUrl ? 'opacity-100' : 'opacity-0', className)}
        muted={!controls}
        loop
        playsInline
        controls={controls}
        autoPlay={autoPlay}
        preload="metadata"
        onLoadedData={() => setLoaded(true)}
        onMouseEnter={() => !controls && void videoRef.current?.play().catch(() => undefined)}
        onMouseLeave={() => {
          if (!controls && !autoPlay && videoRef.current) videoRef.current.pause();
        }}
      />
    );
  }
  return (
    <img
      src={thumb ?? asset.url}
      alt={asset.prompt ?? ''}
      loading="lazy"
      decoding="async"
      draggable={false}
      onLoad={() => setLoaded(true)}
      className={cx('size-full bg-ink-2 transition-opacity duration-500', fitClass, loaded ? 'opacity-100' : 'opacity-0', className)}
    />
  );
}

export function Empty({ icon, title, hint, action }: { icon: ReactNode; title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-line px-6 py-14 text-center">
      <div className="mb-4 flex size-12 items-center justify-center rounded-xl bg-white/[0.04] text-fg-2">{icon}</div>
      <p className="font-medium">{title}</p>
      {hint && <p className="mt-1.5 max-w-sm text-sm text-fg-3">{hint}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (value: boolean) => void; label?: string }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cx(
        'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors duration-300',
        checked ? 'bg-violet' : 'bg-white/[0.12]',
      )}
    >
      <span
        className={cx(
          'inline-block size-5 rounded-full bg-white shadow transition-transform duration-300 ease-[var(--ease-spring)]',
          checked ? 'translate-x-[22px]' : 'translate-x-0.5',
        )}
      />
    </button>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cx('size-5 animate-spin text-fg-3', className)} />;
}
