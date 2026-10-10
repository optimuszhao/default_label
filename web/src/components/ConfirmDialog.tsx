// 确认对话框：替代浏览器自带的 confirm()，在手机上是底部弹出的面板。
//   if (!(await confirmDialog({ title: '删除故事？', message: '…', danger: true }))) return;
import { create } from 'zustand';
import { Button, Modal } from './ui.tsx';

interface Request {
  title: string;
  message?: string;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
  resolve: (ok: boolean) => void;
}

const useConfirm = create<{ current: Request | null }>(() => ({ current: null }));

export function confirmDialog(options: Omit<Request, 'resolve'>): Promise<boolean> {
  return new Promise((resolve) => {
    // 已有一个在等待时，先按“取消”结束它
    useConfirm.getState().current?.resolve(false);
    useConfirm.setState({ current: { ...options, resolve } });
  });
}

export function ConfirmHost() {
  const current = useConfirm((s) => s.current);
  const close = (ok: boolean) => {
    current?.resolve(ok);
    useConfirm.setState({ current: null });
  };
  return (
    <Modal open={Boolean(current)} onClose={() => close(false)} title={current?.title}>
      {current?.message && <p className="text-sm leading-relaxed text-fg-2">{current.message}</p>}
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" onClick={() => close(false)}>
          {current?.cancelText ?? '取消'}
        </Button>
        <Button variant={current?.danger ? 'danger' : 'brand'} onClick={() => close(true)} autoFocus>
          {current?.confirmText ?? '确定'}
        </Button>
      </div>
    </Modal>
  );
}
