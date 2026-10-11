// 图文排版步骤：选版式 → 按分镜自动排版 → 逐格改文字和气泡 → 导出长图 PNG 或打印成 PDF
import { useEffect, useRef, useState } from 'react';
import { Download, LayoutTemplate, MessageSquarePlus, Printer, Wand2, X } from 'lucide-react';
import { Button, Empty, Media, Segmented } from '../../../components/ui.tsx';
import { request } from '../../../lib/api.ts';
import { reportError, useStore } from '../../../lib/store.ts';
import { cssRatio } from '../../../lib/presets.ts';
import { cx, useDebouncedCallback } from '../../../lib/util.ts';
import { useStory } from './context.tsx';
import { AI_LABEL, autoLayout, LAYOUT_LABEL, renderLongImage, type LayoutKind, type LayoutPage, type Panel } from './layout.ts';
import { EMPTY_MEDIA } from './model.ts';

export function LayoutTab({ defaultKind = 'picture_book', title }: { defaultKind?: LayoutKind; title: string }) {
  const { storyId, data, media } = useStory();
  const assets = useStore((s) => s.assets);
  const toast = useStore((s) => s.toast);
  const [kind, setKind] = useState<LayoutKind>(defaultKind);
  const [saved, setSaved] = useState<Partial<Record<LayoutKind, LayoutPage[]>>>({});
  const [loaded, setLoaded] = useState(false);
  const [exporting, setExporting] = useState(false);
  const pending = useRef<{ kind: LayoutKind; pages: LayoutPage[] } | null>(null);

  useEffect(() => {
    void request<{ kind: LayoutKind; pages: LayoutPage[] }[]>('GET', `/api/stories/${storyId}/layouts`)
      .then((list) => setSaved(Object.fromEntries(list.map((item) => [item.kind, item.pages]))))
      .catch(reportError)
      .finally(() => setLoaded(true));
  }, [storyId]);

  const save = useDebouncedCallback(() => {
    const item = pending.current;
    if (!item) return;
    void request('PUT', `/api/stories/${storyId}/layouts/${item.kind}`, { title, pages: item.pages }).catch(reportError);
  }, 800);

  const pages = saved[kind] ?? null;
  const setPages = (next: LayoutPage[]) => {
    setSaved((prev) => ({ ...prev, [kind]: next }));
    pending.current = { kind, pages: next };
    save();
  };
  const patchPanel = (pageIndex: number, panelIndex: number, patch: Partial<Panel>) =>
    setPages(pages!.map((page, i) => (i === pageIndex ? { panels: page.panels.map((panel, j) => (j === panelIndex ? { ...panel, ...patch } : panel)) } : page)));

  async function exportPng() {
    if (!pages) return;
    setExporting(true);
    try {
      const blob = await renderLongImage(kind, pages, title, media, assets);
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = `${title}-${LAYOUT_LABEL[kind]}.png`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
    } catch (error) {
      reportError(error);
    } finally {
      setExporting(false);
    }
  }

  const shotCount = data.chapters.reduce((n, c) => n + c.scenes.reduce((m, s) => m + s.shots.length, 0), 0);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Segmented
          value={kind}
          onChange={setKind}
          label="版式"
          options={(Object.keys(LAYOUT_LABEL) as LayoutKind[]).map((value) => ({ value, label: LAYOUT_LABEL[value] }))}
        />
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            icon={<Wand2 className="size-3.5" />}
            disabled={!shotCount}
            onClick={() => {
              setPages(autoLayout(kind, data));
              toast('已按分镜重新排版', 'success');
            }}
          >
            {pages ? '按分镜重新排版' : '按分镜自动排版'}
          </Button>
          <Button size="sm" variant="ghost" icon={<Printer className="size-3.5" />} disabled={!pages} onClick={() => window.open(`/print/stories/${storyId}?mode=layout&kind=${kind}`, '_blank')}>
            打印 / PDF
          </Button>
          <Button size="sm" variant="brand" icon={<Download className="size-3.5" />} loading={exporting} disabled={!pages} onClick={() => void exportPng()}>
            导出长图
          </Button>
        </div>
      </div>
      <p className="text-xs text-fg-3">画面用每个镜头选定的关键帧。改好文字后导出长图或打印成 PDF，成品底部会带"{AI_LABEL}"标识。</p>

      {!loaded ? null : !pages ? (
        <Empty
          icon={<LayoutTemplate className="size-6" />}
          title={`还没有${LAYOUT_LABEL[kind]}排版`}
          hint={shotCount ? '点"按分镜自动排版"，台词会变成对话气泡，旁白变成文字框，再逐格修改。' : '先在「分镜」里设计镜头并生成关键帧。'}
        />
      ) : (
        <div className={cx('mx-auto space-y-6', kind === 'webtoon' ? 'max-w-md' : 'max-w-3xl')}>
          {pages.map((page, pageIndex) => (
            <section key={pageIndex} className={cx('rounded-xl bg-white p-4 text-[#111] shadow-xl', kind === 'four_panel' && 'grid grid-cols-1 gap-3', kind === 'webtoon' && '!p-0')}>
              {page.panels.map((panel, panelIndex) => {
                const m = media.get(panel.shotId) ?? EMPTY_MEDIA;
                return (
                  <div key={`${panel.shotId}-${panelIndex}`} className="space-y-2">
                    <div className={cx('relative overflow-hidden bg-neutral-200', kind === 'four_panel' && 'border-4 border-black', kind === 'picture_book' && 'rounded-lg')} style={{ aspectRatio: cssRatio(data.aspectRatio) }}>
                      {m.keyframe && <Media asset={m.keyframe} />}
                      {kind !== 'picture_book' && (
                        <div className="absolute top-2 left-2 flex max-w-[65%] flex-col gap-1.5">
                          {panel.bubbles.map((bubble, b) => (
                            <div key={b} className="group relative rounded-2xl border-2 border-black bg-white/95 px-3 py-1.5 text-sm">
                              <input className="w-16 bg-transparent font-medium focus:outline-none" value={bubble.speaker} onChange={(e) => patchPanel(pageIndex, panelIndex, { bubbles: panel.bubbles.map((x, i) => (i === b ? { ...x, speaker: e.target.value } : x)) })} aria-label="说话人" />
                              <textarea
                                className="block w-full resize-none bg-transparent focus:outline-none"
                                rows={Math.max(1, Math.ceil(bubble.text.length / 14))}
                                value={bubble.text}
                                onChange={(e) => patchPanel(pageIndex, panelIndex, { bubbles: panel.bubbles.map((x, i) => (i === b ? { ...x, text: e.target.value } : x)) })}
                                aria-label="气泡文字"
                              />
                              <button aria-label="删除气泡" className="absolute -top-2 -right-2 hidden rounded-full bg-black p-0.5 text-white group-hover:block" onClick={() => patchPanel(pageIndex, panelIndex, { bubbles: panel.bubbles.filter((_, i) => i !== b) })}>
                                <X className="size-3" />
                              </button>
                            </div>
                          ))}
                          <button className="flex w-fit items-center gap-1 rounded-full bg-black/60 px-2 py-0.5 text-xs text-white" onClick={() => patchPanel(pageIndex, panelIndex, { bubbles: [...panel.bubbles, { speaker: '', text: '' }] })}>
                            <MessageSquarePlus className="size-3" /> 气泡
                          </button>
                        </div>
                      )}
                    </div>
                    <textarea
                      className={cx('w-full resize-y rounded-md border px-2 py-1.5 text-sm focus:outline-none', kind === 'picture_book' ? 'border-transparent bg-transparent text-base leading-relaxed' : 'border-black/30 bg-amber-50')}
                      rows={kind === 'picture_book' ? 3 : 1}
                      value={panel.text}
                      placeholder={kind === 'picture_book' ? '这一页的文字' : '旁白框（留空不显示）'}
                      onChange={(e) => patchPanel(pageIndex, panelIndex, { text: e.target.value })}
                      aria-label={kind === 'picture_book' ? '绘本文字' : '旁白'}
                    />
                  </div>
                );
              })}
              {kind !== 'webtoon' && <p className="pt-1 text-right text-[10px] text-neutral-500">第 {pageIndex + 1} 页</p>}
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
