// 对比视图：2–4 宫格；两张图时可以用 A/B 滑杆叠在一起看；视频同步播放；下面是参数差异表
import { useEffect, useRef, useState } from 'react';
import { Pause, Play, X } from 'lucide-react';
import type { Asset } from '../../../shared/types.ts';
import { useCatalog } from '../pages/studio/create/catalog.ts';
import { useCompare } from '../pages/studio/create/derive.ts';
import { api } from '../lib/api.ts';
import { useStore } from '../lib/store.ts';
import { cx } from '../lib/util.ts';
import { Button, IconButton, Modal, Segmented, isVideoAsset } from './ui.tsx';

function Slider({ a, b }: { a: Asset; b: Asset }) {
  const [split, setSplit] = useState(50);
  return (
    <div className="relative mx-auto aspect-square w-full max-w-3xl overflow-hidden rounded-lg bg-black select-none" style={a.width && a.height ? { aspectRatio: `${a.width} / ${a.height}` } : undefined}>
      <img src={b.url} alt="" className="absolute inset-0 size-full object-contain" draggable={false} />
      <img src={a.url} alt="" className="absolute inset-0 size-full object-contain" style={{ clipPath: `inset(0 ${100 - split}% 0 0)` }} draggable={false} />
      <div className="pointer-events-none absolute inset-y-0 w-px bg-white/80" style={{ left: `${split}%` }} />
      <span className="absolute top-2 left-2 rounded bg-black/60 px-1.5 text-xs">A</span>
      <span className="absolute top-2 right-2 rounded bg-black/60 px-1.5 text-xs">B</span>
      <input
        type="range"
        min={0}
        max={100}
        value={split}
        onChange={(e) => setSplit(Number(e.target.value))}
        aria-label="A/B 分界"
        className="absolute inset-x-0 bottom-3 mx-auto w-2/3 accent-accent"
      />
    </div>
  );
}

export function CompareView() {
  const { ids, open, setOpen, toggle, clear } = useCompare();
  const assets = useStore((s) => s.assets);
  const upsertAssets = useStore((s) => s.upsertAssets);
  const presetMap = useCatalog((s) => s.presetMap);
  const templates = useCatalog((s) => s.templates);
  const [layout, setLayout] = useState<'grid' | 'slider'>('grid');
  const [playing, setPlaying] = useState(false);
  const videoRefs = useRef<(HTMLVideoElement | null)[]>([]);

  useEffect(() => {
    const missing = ids.filter((id) => !useStore.getState().assets[id]);
    if (open && missing.length) void Promise.all(missing.map((id) => api.asset(id).catch(() => null))).then((list) => upsertAssets(list.filter((a): a is Asset => Boolean(a))));
  }, [open, ids, upsertAssets]);

  const items = ids.map((id) => assets[id]).filter((a): a is Asset => Boolean(a));
  const canSlide = items.length === 2 && items.every((a) => !isVideoAsset(a));
  const anyVideo = items.some(isVideoAsset);

  function playAll(play: boolean) {
    setPlaying(play);
    for (const video of videoRefs.current) {
      if (!video) continue;
      if (play) {
        video.currentTime = 0;
        void video.play().catch(() => undefined);
      } else video.pause();
    }
  }

  const rows: { label: string; values: string[] }[] = [
    { label: '提示词', values: items.map((a) => a.prompt ?? '') },
    { label: '种子', values: items.map((a) => (a.gen?.seed != null ? String(a.gen.seed) : '—')) },
    { label: '尺寸', values: items.map((a) => (a.width ? `${a.width}×${a.height}` : '—')) },
    { label: '时长', values: items.map((a) => (a.duration ? `${a.duration} 秒` : '—')) },
    { label: '模板', values: items.map((a) => templates.find((t) => t.id === a.gen?.templateId)?.name ?? '—') },
    { label: '预设', values: items.map((a) => (a.gen?.presets ?? []).map((slug) => presetMap.get(slug)?.name ?? slug).join('、') || '—') },
    { label: '算子', values: items.map((a) => a.gen?.operator ?? '—') },
  ];

  return (
    <>
      {ids.length > 0 && !open && (
        <div className="fixed right-4 bottom-[calc(150px+env(safe-area-inset-bottom))] z-30 flex items-center gap-2 rounded-full border border-line-strong bg-ink-1/95 py-1.5 pr-1.5 pl-4 text-sm shadow-xl backdrop-blur md:bottom-28">
          已选 {ids.length} 个
          <Button size="sm" variant="brand" disabled={ids.length < 2} onClick={() => setOpen(true)}>
            对比
          </Button>
          <IconButton label="清空对比" className="size-7" onClick={clear}>
            <X className="size-3.5" />
          </IconButton>
        </div>
      )}
      <Modal open={open} onClose={() => setOpen(false)} title={`对比 ${items.length} 个结果`} wide>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          {canSlide && (
            <Segmented
              size="sm"
              value={layout}
              onChange={setLayout}
              options={[
                { value: 'grid', label: '并排' },
                { value: 'slider', label: 'A/B 滑杆' },
              ]}
            />
          )}
          {anyVideo && (
            <Button size="sm" variant="secondary" icon={playing ? <Pause className="size-3.5" /> : <Play className="size-3.5" />} onClick={() => playAll(!playing)}>
              {playing ? '全部暂停' : '同步播放'}
            </Button>
          )}
        </div>
        {canSlide && layout === 'slider' ? (
          <Slider a={items[0]} b={items[1]} />
        ) : (
          <div className={cx('grid gap-2', items.length <= 2 ? 'grid-cols-2' : items.length === 3 ? 'grid-cols-3' : 'grid-cols-2 md:grid-cols-4')}>
            {items.map((asset, index) => (
              <div key={asset.id} className="relative overflow-hidden rounded-lg bg-black">
                {isVideoAsset(asset) ? (
                  <video
                    ref={(el) => {
                      videoRefs.current[index] = el;
                    }}
                    src={asset.url}
                    className="aspect-video w-full object-contain"
                    muted
                    loop
                    playsInline
                  />
                ) : (
                  <img src={asset.url} alt="" className="w-full object-contain" />
                )}
                <span className="absolute top-2 left-2 rounded bg-black/60 px-1.5 text-xs">{String.fromCharCode(65 + index)}</span>
                <IconButton label="移出对比" className="glass absolute top-2 right-2 size-7" onClick={() => toggle(asset.id)}>
                  <X className="size-3.5" />
                </IconButton>
              </div>
            ))}
          </div>
        )}
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[480px] text-left text-xs">
            <tbody className="divide-y divide-line">
              {rows.map((row) => {
                const differs = new Set(row.values).size > 1;
                return (
                  <tr key={row.label}>
                    <th className="w-14 py-2 pr-2 align-top font-normal text-fg-3">{row.label}</th>
                    {row.values.map((value, index) => (
                      <td key={index} className={cx('py-2 pr-3 align-top', differs ? 'text-fg' : 'text-fg-3')}>
                        <span className="line-clamp-3">{value}</span>
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Modal>
    </>
  );
}
