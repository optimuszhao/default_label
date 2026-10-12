// 分镜表格视图（STY-11）：全片镜头一张表，虚拟滚动；单元格内直接编辑；拖动行在场次内排序；
// 从 Excel / 表格软件复制几行粘贴进来就变成镜头；镜头表 CSV 导入见 shotCsv.ts。
import { useVirtualizer } from '@tanstack/react-virtual';
import { useMemo, useRef, useState } from 'react';
import { ClipboardPaste, Download, GripVertical, Lock, Upload } from 'lucide-react';
import type { Shot } from '../../../../../shared/types.ts';
import { Button, Media } from '../../../components/ui.tsx';
import { useStore } from '../../../lib/store.ts';
import { CAMERA_MOVES, SHOT_SIZES } from '../../../lib/presets.ts';
import { cx } from '../../../lib/util.ts';
import { useStory } from './context.tsx';
import { EMPTY_MEDIA, flattenShots, newShot, updateScene, updateShot } from './model.ts';
import { applyCsv, shotsFromTable } from './shotCsv.ts';

const COLUMNS = '2.25rem 3rem 7.5rem 5.25rem 5.25rem 3.75rem minmax(16rem,1fr) 9rem 4.5rem 4.5rem';

export function ShotsTable() {
  const { storyId, data, update, media, sceneId } = useStory();
  const toast = useStore((s) => s.toast);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const rows = useMemo(() => flattenShots(data), [data]);
  const virtualizer = useVirtualizer({ count: rows.length, getScrollElement: () => scrollRef.current, estimateSize: () => 64, overscan: 10 });
  const targetScene = sceneId ?? rows.at(-1)?.scene.id ?? data.chapters[0]?.scenes[0]?.id ?? null;

  function paste(text: string) {
    if (!targetScene) {
      toast('先建一个场次', 'info');
      return;
    }
    const shots = shotsFromTable(text);
    if (!shots.length) return;
    update(updateScene(targetScene, (s) => ({ ...s, shots: [...s.shots, ...shots.map((patch) => newShot(patch))] })));
    toast(`已粘贴 ${shots.length} 个镜头`, 'success');
  }

  async function importCsv(file: File) {
    const result = applyCsv(data, await file.text(), targetScene);
    update(() => result.data);
    toast(`导入完成：更新 ${result.updated} 个，新增 ${result.added} 个镜头${result.created ? `，新建 ${result.created} 个场次` : ''}`, 'success');
  }

  function drop(targetId: string) {
    const from = rows.find((r) => r.shot.id === dragging);
    const to = rows.find((r) => r.shot.id === targetId);
    setDragging(null);
    if (!from || !to || from.shot.id === to.shot.id) return;
    if (from.scene.id !== to.scene.id) {
      toast('只能在同一场次里拖动排序', 'info');
      return;
    }
    update(
      updateScene(from.scene.id, (s) => {
        const list = s.shots.filter((x) => x.id !== from.shot.id);
        const index = list.findIndex((x) => x.id === to.shot.id);
        list.splice(from.indexInScene < to.indexInScene ? index + 1 : index, 0, from.shot);
        return { ...s, shots: list };
      }),
    );
  }

  return (
    <div
      className="panel overflow-hidden"
      onPaste={(event) => {
        const target = event.target as HTMLElement;
        if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') return;
        const text = event.clipboardData.getData('text/plain');
        if (text.includes('\t') || text.includes('\n')) {
          event.preventDefault();
          paste(text);
        }
      }}
      tabIndex={0}
      aria-label="分镜表格"
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2 text-xs text-fg-3">
        <span>共 {rows.length} 个镜头 · 在表格空白处粘贴从 Excel 复制的几行，会追加到当前场次末尾</span>
        <span className="flex-1" />
        <Button size="sm" variant="ghost" icon={<ClipboardPaste className="size-3.5" />} onClick={async () => paste(await navigator.clipboard.readText().catch(() => ''))}>
          从剪贴板粘贴
        </Button>
        <a href={`/api/stories/${storyId}/export/shots.csv`} className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs text-fg-2 hover:bg-white/[0.06]">
          <Download className="size-3.5" /> 导出 CSV
        </a>
        <input ref={fileRef} type="file" accept=".csv,text/csv" hidden aria-label="选择镜头表 CSV" onChange={(e) => e.target.files?.[0] && void importCsv(e.target.files[0]).finally(() => (e.target.value = ''))} />
        <Button size="sm" variant="ghost" icon={<Upload className="size-3.5" />} onClick={() => fileRef.current?.click()}>
          导入 CSV
        </Button>
      </div>
      <div ref={scrollRef} className="max-h-[70dvh] overflow-auto">
        <div className="min-w-[60rem]">
          <div className="sticky top-0 z-10 grid border-b border-line bg-ink-1 px-2 py-1.5 text-[11px] text-fg-3" style={{ gridTemplateColumns: COLUMNS }}>
            <span />
            <span>#</span>
            <span>场次</span>
            <span>景别</span>
            <span>运镜</span>
            <span>时长</span>
            <span>画面描述</span>
            <span>出镜</span>
            <span>关键帧</span>
            <span>视频</span>
          </div>
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {virtualizer.getVirtualItems().map((item) => {
              const { shot, scene, number } = rows[item.index];
              const m = media.get(shot.id) ?? EMPTY_MEDIA;
              const set = (patch: Partial<Shot>) => update(updateShot(scene.id, shot.id, patch));
              const names = [...shot.characterIds.map((id) => data.characters.find((c) => c.id === id)?.name), ...(shot.elementIds ?? []).map((id) => data.elements?.find((e) => e.id === id)?.name)].filter(Boolean);
              return (
                <div
                  key={shot.id}
                  data-index={item.index}
                  ref={virtualizer.measureElement}
                  role="row"
                  className={cx('absolute left-0 grid w-full items-start border-b border-line px-2 py-1.5 text-xs', dragging === shot.id && 'opacity-40', shot.locked && 'bg-ok/[0.04]')}
                  style={{ top: item.start, gridTemplateColumns: COLUMNS }}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={() => drop(shot.id)}
                >
                  <span draggable onDragStart={() => setDragging(shot.id)} onDragEnd={() => setDragging(null)} className="cursor-grab pt-1.5 text-fg-3" title="拖动排序">
                    <GripVertical className="size-3.5" />
                  </span>
                  <span className="pt-1.5 font-mono text-accent">
                    {shot.code || number}
                    {shot.locked && <Lock className="ml-0.5 inline size-3 text-ok" />}
                  </span>
                  <span className="truncate pt-1.5 pr-2 text-fg-2" title={scene.title}>
                    {scene.title}
                  </span>
                  <select className="field !h-7 !w-[4.75rem] !py-0 !text-xs" value={shot.shotSize} onChange={(e) => set({ shotSize: e.target.value })} disabled={shot.locked} aria-label="景别">
                    {SHOT_SIZES.map((size) => (
                      <option key={size}>{size}</option>
                    ))}
                  </select>
                  <select className="field !h-7 !w-[4.75rem] !py-0 !text-xs" value={shot.cameraMove} onChange={(e) => set({ cameraMove: e.target.value })} disabled={shot.locked} aria-label="运镜">
                    {CAMERA_MOVES.map((move) => (
                      <option key={move}>{move}</option>
                    ))}
                  </select>
                  <input
                    type="number"
                    min={1}
                    max={30}
                    className="field !h-7 !w-12 !px-1.5 !py-0 !text-xs"
                    value={shot.duration}
                    disabled={shot.locked}
                    onChange={(e) => set({ duration: Math.max(1, Math.min(30, Number(e.target.value) || 1)) })}
                    aria-label="时长"
                  />
                  <textarea className="field !min-h-7 resize-y !py-1 !text-xs leading-snug" rows={2} value={shot.description} onChange={(e) => set({ description: e.target.value })} aria-label="画面描述" />
                  <span className="truncate pt-1.5 pl-2 text-fg-3" title={names.join('、')}>
                    {names.join('、') || '—'}
                  </span>
                  <span className="pl-2">{m.keyframe ? <span className="block h-10 w-14 overflow-hidden rounded"><Media asset={m.keyframe} variant="thumb" /></span> : <span className="text-fg-3">—</span>}</span>
                  <span className="pl-2">{m.video ? <span className="block h-10 w-14 overflow-hidden rounded"><Media asset={m.video} variant="thumb" /></span> : <span className="text-fg-3">—</span>}</span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
