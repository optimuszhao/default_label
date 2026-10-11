// 选择文件夹的对话框：批量"移动到…"、移动文件夹都用它
//   const target = await pickFolder({ title: '移动到', folders }); // 取消时 undefined，选"顶层 / 未归档"时 null
import { useState } from 'react';
import { create } from 'zustand';
import { Folder, Inbox } from 'lucide-react';
import type { AssetFolder } from '../../../../shared/types.ts';
import { cx } from '../../lib/util.ts';
import { Button, Modal } from '../ui.tsx';

interface Request {
  title: string;
  folders: AssetFolder[];
  /** 不能选的文件夹（移动文件夹时：自己和自己的子孙） */
  exclude?: Set<string>;
  rootLabel?: string;
  resolve: (id: string | null | undefined) => void;
}

const usePicker = create<{ current: Request | null }>(() => ({ current: null }));

export function pickFolder(options: Omit<Request, 'resolve'>): Promise<string | null | undefined> {
  return new Promise((resolve) => {
    usePicker.getState().current?.resolve(undefined);
    usePicker.setState({ current: { ...options, resolve } });
  });
}

/** 一个文件夹和它全部子孙的 id */
export function descendants(folders: AssetFolder[], id: string): Set<string> {
  const out = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const folder of folders) {
      if (folder.parentId && out.has(folder.parentId) && !out.has(folder.id)) {
        out.add(folder.id);
        grew = true;
      }
    }
  }
  return out;
}

export function FolderPickerHost() {
  const current = usePicker((s) => s.current);
  const [choice, setChoice] = useState<string | null>(null);
  const close = (value: string | null | undefined) => {
    current?.resolve(value);
    usePicker.setState({ current: null });
    setChoice(null);
  };
  if (!current) return null;
  const depthOf = (folder: AssetFolder): number => {
    let depth = 0;
    let parent = folder.parentId;
    while (parent && depth < 10) {
      depth++;
      parent = current.folders.find((item) => item.id === parent)?.parentId ?? null;
    }
    return depth;
  };
  // 按树的顺序排：父在前、子紧跟
  const ordered: AssetFolder[] = [];
  const walk = (parentId: string | null) => {
    for (const folder of current.folders.filter((item) => item.parentId === parentId)) {
      ordered.push(folder);
      walk(folder.id);
    }
  };
  walk(null);
  return (
    <Modal open onClose={() => close(undefined)} title={current.title}>
      <div className="max-h-[50dvh] space-y-0.5 overflow-y-auto">
        <button
          onClick={() => setChoice('__root')}
          className={cx('flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm', choice === '__root' ? 'bg-accent/15 text-fg' : 'text-fg-2 hover:bg-white/[0.05]')}
        >
          <Inbox className="size-4 text-fg-3" />
          {current.rootLabel ?? '未归档（不放进文件夹）'}
        </button>
        {ordered.map((folder) => {
          const disabled = current.exclude?.has(folder.id);
          return (
            <button
              key={folder.id}
              disabled={disabled}
              onClick={() => setChoice(folder.id)}
              style={{ paddingLeft: 8 + depthOf(folder) * 16 }}
              className={cx(
                'flex w-full items-center gap-2 rounded-lg py-2 pr-2 text-left text-sm disabled:opacity-40',
                choice === folder.id ? 'bg-accent/15 text-fg' : 'text-fg-2 hover:bg-white/[0.05]',
              )}
            >
              <Folder className="size-4 text-fg-3" />
              <span className="truncate">{folder.name}</span>
              <span className="ml-auto text-xs text-fg-3">{folder.count}</span>
            </button>
          );
        })}
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" onClick={() => close(undefined)}>
          取消
        </Button>
        <Button variant="brand" disabled={choice === null} onClick={() => close(choice === '__root' ? null : choice)}>
          确定
        </Button>
      </div>
    </Modal>
  );
}
