// 确认对话框：替代浏览器自带的 confirm() / prompt()，在手机上是底部弹出的面板。
//   if (!(await confirmDialog({ title: '删除故事？', message: '…', danger: true }))) return;
//   const name = await promptDialog({ title: '新建文件夹', placeholder: '文件夹名' }); // 取消时为 null
import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { Button, Modal } from './ui.tsx';

interface Request {
  title: string;
  message?: string;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
  /** 有 input 时显示输入框，resolve 的是输入的文字 */
  input?: { value?: string; placeholder?: string; maxLength?: number; multiline?: boolean };
  resolve: (result: boolean | string) => void;
}

const useConfirm = create<{ current: Request | null }>(() => ({ current: null }));

export function confirmDialog(options: Omit<Request, 'resolve' | 'input'>): Promise<boolean> {
  return new Promise((resolve) => {
    // 已有一个在等待时，先按“取消”结束它
    useConfirm.getState().current?.resolve(false);
    useConfirm.setState({ current: { ...options, resolve: (result) => resolve(result !== false) } });
  });
}

export function promptDialog(options: Omit<Request, 'resolve' | 'input' | 'danger'> & { value?: string; placeholder?: string; maxLength?: number; multiline?: boolean }): Promise<string | null> {
  const { value, placeholder, maxLength, multiline, ...rest } = options;
  return new Promise((resolve) => {
    useConfirm.getState().current?.resolve(false);
    useConfirm.setState({
      current: {
        ...rest,
        input: { value, placeholder, maxLength, multiline },
        resolve: (result) => resolve(typeof result === 'string' ? result : null),
      },
    });
  });
}

export function ConfirmHost() {
  const current = useConfirm((s) => s.current);
  const [text, setText] = useState('');
  useEffect(() => setText(current?.input?.value ?? ''), [current]);
  const close = (ok: boolean) => {
    if (current?.input) current.resolve(ok ? text.trim() || false : false);
    else current?.resolve(ok);
    useConfirm.setState({ current: null });
  };
  return (
    <Modal open={Boolean(current)} onClose={() => close(false)} title={current?.title}>
      {current?.message && <p className="text-sm leading-relaxed text-fg-2">{current.message}</p>}
      {current?.input && (
        <form
          className="mt-3"
          onSubmit={(event) => {
            event.preventDefault();
            close(true);
          }}
        >
          {current.input.multiline ? (
            <textarea
              autoFocus
              className="field min-h-24"
              value={text}
              maxLength={current.input.maxLength}
              placeholder={current.input.placeholder}
              onChange={(event) => setText(event.target.value)}
            />
          ) : (
            <input
              autoFocus
              className="field"
              value={text}
              maxLength={current.input.maxLength ?? 60}
              placeholder={current.input.placeholder}
              onChange={(event) => setText(event.target.value)}
            />
          )}
        </form>
      )}
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" onClick={() => close(false)}>
          {current?.cancelText ?? '取消'}
        </Button>
        <Button variant={current?.danger ? 'danger' : 'brand'} onClick={() => close(true)} autoFocus={!current?.input} disabled={Boolean(current?.input) && !text.trim()}>
          {current?.confirmText ?? '确定'}
        </Button>
      </div>
    </Modal>
  );
}
