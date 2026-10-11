// 审片备注列表（STY-15）：点击跳到对应时间点，勾选标记已解决
import { useState } from 'react';
import { MessageSquare, Trash2 } from 'lucide-react';
import { IconButton } from '../../../components/ui.tsx';
import { api, type StoryNote } from '../../../lib/api.ts';
import { reportError } from '../../../lib/store.ts';
import { cx, formatDuration } from '../../../lib/util.ts';

export function NotesPanel({
  notes,
  setNotes,
  storyId,
  shotLabel,
  onJump,
}: {
  notes: StoryNote[];
  setNotes: (update: (list: StoryNote[]) => StoryNote[]) => void;
  storyId: string;
  shotLabel: (shotId: string | null) => string;
  onJump: (note: StoryNote) => void;
}) {
  const [showResolved, setShowResolved] = useState(false);
  const open = notes.filter((n) => !n.resolved).length;
  const visible = notes.filter((n) => showResolved || !n.resolved).sort((a, b) => (a.atSec ?? 0) - (b.atSec ?? 0));
  if (!notes.length) return null;

  async function patch(note: StoryNote, resolved: boolean) {
    try {
      const next = await api.patchStoryNote(storyId, note.id, { resolved });
      setNotes((list) => list.map((n) => (n.id === note.id ? next : n)));
    } catch (error) {
      reportError(error);
    }
  }

  return (
    <section className="panel p-4" aria-label="审片备注">
      <div className="mb-2 flex items-center gap-2">
        <MessageSquare className="size-4 text-warn" />
        <h3 className="text-sm font-semibold">审片备注</h3>
        <span className="text-xs text-fg-3">{open} 条待处理</span>
        <button className="ml-auto text-xs text-fg-3 hover:text-fg" onClick={() => setShowResolved(!showResolved)}>
          {showResolved ? '隐藏已解决' : '显示已解决'}
        </button>
      </div>
      <ul className="divide-y divide-line">
        {visible.map((note) => (
          <li key={note.id} className="flex items-start gap-3 py-2 text-sm">
            <input type="checkbox" className="mt-1" checked={note.resolved} onChange={(e) => void patch(note, e.target.checked)} aria-label="已解决" />
            <button className="min-w-0 flex-1 text-left" onClick={() => onJump(note)}>
              <span className="mr-2 font-mono text-xs text-accent">{note.atSec != null ? formatDuration(note.atSec) : '--:--'}</span>
              <span className="mr-2 text-xs text-fg-3">{shotLabel(note.shotId)}</span>
              <span className={cx('break-words', note.resolved && 'text-fg-3 line-through')}>{note.text}</span>
            </button>
            <IconButton
              label="删除备注"
              onClick={async () => {
                try {
                  await api.deleteStoryNote(storyId, note.id);
                  setNotes((list) => list.filter((n) => n.id !== note.id));
                } catch (error) {
                  reportError(error);
                }
              }}
            >
              <Trash2 className="size-3.5" />
            </IconButton>
          </li>
        ))}
      </ul>
    </section>
  );
}
