// 打印视图：用浏览器"打印 → 存储为 PDF"出成品。
//   mode=storyboard：A4 横向分镜表，每页 6 个镜头（关键帧 + 景别运镜时长 + 画面描述 + 台词）
//   mode=layout&kind=…：已保存的图文排版（绘本 / 四格 / 条漫）
// 每页页脚都有 AI 标识。
import { useEffect, useMemo, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import type { Asset, Story } from '../../../shared/types.ts';
import { api, request } from '../lib/api.ts';
import { cssRatio } from '../lib/presets.ts';
import { AI_LABEL, LAYOUT_LABEL, type LayoutKind, type LayoutPage } from './studio/story/layout.ts';
import { buildShotMedia, dialogueFor, flattenShots } from './studio/story/model.ts';

const PER_PAGE = 6;

export default function Print() {
  const { id = '' } = useParams();
  const [params] = useSearchParams();
  const mode = params.get('mode') === 'layout' ? 'layout' : 'storyboard';
  const kind = (params.get('kind') as LayoutKind) || 'picture_book';
  const [story, setStory] = useState<Story | null>(null);
  const [assets, setAssets] = useState<Record<string, Asset>>({});
  const [pages, setPages] = useState<LayoutPage[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const [s, media] = await Promise.all([api.story(id), api.storyMedia(id)]);
        setStory(s);
        setAssets(Object.fromEntries(media.map((a) => [a.id, a])));
        if (mode === 'layout') {
          const list = await request<{ kind: LayoutKind; pages: LayoutPage[] }[]>('GET', `/api/stories/${id}/layouts`);
          setPages(list.find((item) => item.kind === kind)?.pages ?? []);
        }
      } catch (e) {
        setError((e as Error).message);
      }
    })();
  }, [id, mode, kind]);

  const media = useMemo(() => (story ? buildShotMedia(id, assets, {}, story.data) : new Map()), [id, assets, story]);

  if (error) return <p className="p-8 text-sm text-red-600">{error}</p>;
  if (!story) return <p className="p-8 text-sm text-neutral-500">加载中…</p>;

  const shots = flattenShots(story.data);
  const sheets: (typeof shots)[] = [];
  for (let i = 0; i < shots.length; i += PER_PAGE) sheets.push(shots.slice(i, i + PER_PAGE));

  return (
    <div className="min-h-dvh bg-neutral-100 text-[#111] print:bg-white">
      <style>{`@page { size: A4 ${mode === 'storyboard' ? 'landscape' : 'portrait'}; margin: 10mm; } @media print { .no-print { display: none !important; } .sheet { box-shadow: none !important; margin: 0 !important; break-after: page; } }`}</style>
      <div className="no-print sticky top-0 z-10 flex items-center gap-3 border-b bg-white px-4 py-2 text-sm">
        <span className="font-medium">{story.title}</span>
        <span className="text-neutral-500">{mode === 'storyboard' ? `分镜表 · ${shots.length} 个镜头` : `${LAYOUT_LABEL[kind]} · ${pages?.length ?? 0} 页`}</span>
        <span className="flex-1" />
        <button onClick={() => window.print()} className="rounded-md bg-black px-3 py-1.5 text-white">
          打印 / 存为 PDF
        </button>
      </div>

      {mode === 'storyboard'
        ? sheets.map((sheet, index) => (
            <section key={index} className="sheet mx-auto my-6 flex aspect-[297/210] w-[277mm] max-w-full flex-col bg-white p-[6mm] shadow-lg">
              <header className="mb-2 flex items-baseline justify-between border-b border-neutral-300 pb-1 text-[11px]">
                <span className="font-semibold">{story.title} · 分镜表</span>
                <span className="text-neutral-500">
                  {index + 1} / {sheets.length}
                </span>
              </header>
              <div className="grid flex-1 grid-cols-3 grid-rows-2 gap-2">
                {sheet.map(({ shot, scene, number }) => {
                  const keyframe = media.get(shot.id)?.keyframe ?? null;
                  const lines = dialogueFor(scene, shot);
                  return (
                    <div key={shot.id} className="flex min-h-0 flex-col border border-neutral-300 text-[10px] leading-snug">
                      <div className="relative bg-neutral-200" style={{ aspectRatio: cssRatio(story.data.aspectRatio) }}>
                        {keyframe && <img src={keyframe.url} alt="" className="absolute inset-0 size-full object-cover" />}
                        <span className="absolute top-0.5 left-0.5 bg-black/70 px-1 font-mono text-white">#{shot.code || number}</span>
                      </div>
                      <div className="min-h-0 flex-1 overflow-hidden p-1">
                        <p className="text-neutral-500">
                          {scene.title} · {shot.shotSize} · {shot.cameraMove} · {shot.duration}s
                        </p>
                        <p className="mt-0.5">{shot.description}</p>
                        {lines.map((line) => (
                          <p key={line.id} className="mt-0.5 text-neutral-600">
                            {story.data.characters.find((c) => c.id === line.characterId)?.name ?? '旁白'}：{line.text}
                          </p>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
              <footer className="mt-1 text-right text-[9px] text-neutral-400">{AI_LABEL}</footer>
            </section>
          ))
        : (pages ?? []).map((page, index) => (
            <section key={index} className="sheet mx-auto my-6 w-[190mm] max-w-full bg-white p-[8mm] shadow-lg">
              <div className={kind === 'four_panel' ? 'grid grid-cols-1 gap-2' : 'space-y-3'}>
                {page.panels.map((panel, i) => {
                  const keyframe = media.get(panel.shotId)?.keyframe ?? null;
                  return (
                    <div key={i}>
                      <div className={`relative bg-neutral-200 ${kind === 'four_panel' ? 'border-4 border-black' : ''}`} style={{ aspectRatio: cssRatio(story.data.aspectRatio) }}>
                        {keyframe && <img src={keyframe.url} alt="" className="absolute inset-0 size-full object-cover" />}
                        {kind !== 'picture_book' && (
                          <div className="absolute top-2 left-2 flex max-w-[65%] flex-col gap-1">
                            {panel.bubbles.map((bubble, b) => (
                              <p key={b} className="rounded-2xl border-2 border-black bg-white px-2 py-1 text-xs">
                                {bubble.speaker && <b>{bubble.speaker}：</b>}
                                {bubble.text}
                              </p>
                            ))}
                          </div>
                        )}
                        {kind !== 'picture_book' && panel.text && <p className="absolute inset-x-2 bottom-2 border-2 border-black bg-amber-50 px-2 py-1 text-xs">{panel.text}</p>}
                      </div>
                      {kind === 'picture_book' && <p className="mt-3 text-base leading-relaxed whitespace-pre-wrap">{panel.text}</p>}
                    </div>
                  );
                })}
              </div>
              <footer className="mt-3 flex justify-between text-[9px] text-neutral-400">
                <span>{AI_LABEL}</span>
                <span>{index + 1}</span>
              </footer>
            </section>
          ))}
    </div>
  );
}
