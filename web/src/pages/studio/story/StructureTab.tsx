import { useState } from 'react';
import { ChevronDown, ChevronUp, Layers, Plus, Sparkles, Trash2 } from 'lucide-react';
import { Button, Empty, IconButton } from '../../../components/ui.tsx';
import { useStore } from '../../../lib/store.ts';
import { useStory } from './context.tsx';
import { moveItem, newChapter, newScene, updateChapter, updateScene } from './model.ts';
import { SplitDialog } from './ScriptTab.tsx';

/** 章节场次：只关心故事骨架，每场的剧情和台词在下一步「剧本台词」里写 */
export function StructureTab({ onOpenScene }: { onOpenScene: (sceneId: string) => void }) {
  const { data, update } = useStory();
  const [splitting, setSplitting] = useState(false);

  function addChapter() {
    update((d) => ({
      ...d,
      chapters: [...d.chapters, newChapter({ title: `第${d.chapters.length + 1}章`, scenes: [newScene({ title: '场次 1' })] })],
    }));
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button size="sm" icon={<Plus className="size-3.5" />} onClick={addChapter}>
          新增章节
        </Button>
        <Button
          size="sm"
          variant="brand"
          icon={<Sparkles className="size-3.5" />}
          onClick={() => {
            if (!data.outline.trim()) useStore.getState().toast('建议先在第 1 步写好故事大纲', 'info');
            setSplitting(true);
          }}
        >
          AI 拆分章节
        </Button>
      </div>

      {data.chapters.length === 0 && (
        <Empty icon={<Layers className="size-6" />} title="还没有章节" hint="让 AI 根据大纲拆分，或手动新增章节。长篇故事可以分多次追加。" />
      )}

      {data.chapters.map((chapter, chapterIndex) => (
        <section key={chapter.id} className="panel cv-auto overflow-hidden">
          <header className="flex items-center gap-2 border-b border-line px-3 py-2 sm:px-4">
            <span className="font-mono text-[11px] text-accent">CH.{String(chapterIndex + 1).padStart(2, '0')}</span>
            <input
              className="min-w-0 flex-1 bg-transparent text-sm font-medium focus:outline-none"
              value={chapter.title}
              onChange={(e) => update(updateChapter(chapter.id, (c) => ({ ...c, title: e.target.value })))}
              aria-label="章节标题"
            />
            <IconButton label="上移章节" className="size-7" onClick={() => update((d) => ({ ...d, chapters: moveItem(d.chapters, chapterIndex, -1) }))}>
              <ChevronUp className="size-3.5" />
            </IconButton>
            <IconButton label="下移章节" className="size-7" onClick={() => update((d) => ({ ...d, chapters: moveItem(d.chapters, chapterIndex, 1) }))}>
              <ChevronDown className="size-3.5" />
            </IconButton>
            <IconButton
              label="删除章节"
              className="size-7 hover:text-danger"
              onClick={() => confirm(`删除「${chapter.title}」及其全部场次和分镜？`) && update((d) => ({ ...d, chapters: d.chapters.filter((c) => c.id !== chapter.id) }))}
            >
              <Trash2 className="size-3.5" />
            </IconButton>
          </header>
          <div className="border-b border-line px-3 py-2 sm:px-4">
            <textarea
              className="w-full resize-none bg-transparent text-xs leading-relaxed text-fg-2 placeholder:text-fg-3 focus:outline-none"
              rows={2}
              value={chapter.summary}
              onChange={(e) => update(updateChapter(chapter.id, (c) => ({ ...c, summary: e.target.value })))}
              placeholder="本章概要：这一章讲了什么、推进了哪条线索"
              aria-label="章节概要"
            />
          </div>
          <div className="divide-y divide-line">
            {chapter.scenes.map((scene, sceneIndex) => (
              <div key={scene.id} className="group flex flex-wrap items-center gap-2 px-3 py-2 sm:flex-nowrap sm:px-4">
                <span className="w-8 shrink-0 font-mono text-[11px] text-fg-3">{chapterIndex + 1}-{sceneIndex + 1}</span>
                <input
                  className="field !w-auto min-w-0 flex-1 !py-1 text-[13px]"
                  value={scene.title}
                  onChange={(e) => update(updateScene(scene.id, (s) => ({ ...s, title: e.target.value })))}
                  aria-label="场次标题"
                />
                <input
                  className="field !w-28 !py-1 text-[13px]"
                  value={scene.location}
                  onChange={(e) => update(updateScene(scene.id, (s) => ({ ...s, location: e.target.value })))}
                  placeholder="地点"
                  aria-label="地点"
                />
                <input
                  className="field !w-20 !py-1 text-[13px]"
                  value={scene.time}
                  onChange={(e) => update(updateScene(scene.id, (s) => ({ ...s, time: e.target.value })))}
                  placeholder="时间"
                  aria-label="时间"
                />
                <span className="hidden w-20 shrink-0 text-right font-mono text-[11px] text-fg-3 md:inline">
                  {scene.summary ? '已写剧本' : '待写剧本'}
                </span>
                <span className="flex shrink-0">
                  <Button size="sm" variant="ghost" onClick={() => onOpenScene(scene.id)}>编辑</Button>
                  <IconButton
                    label="上移场次"
                    className="size-8"
                    onClick={() => update(updateChapter(chapter.id, (c) => ({ ...c, scenes: moveItem(c.scenes, sceneIndex, -1) })))}
                  >
                    <ChevronUp className="size-3.5" />
                  </IconButton>
                  <IconButton
                    label="删除场次"
                    className="size-8 hover:text-danger"
                    onClick={() =>
                      confirm(`删除场次「${scene.title}」及其分镜？`) &&
                      update(updateChapter(chapter.id, (c) => ({ ...c, scenes: c.scenes.filter((s) => s.id !== scene.id) })))
                    }
                  >
                    <Trash2 className="size-3.5" />
                  </IconButton>
                </span>
              </div>
            ))}
            <button
              onClick={() => update(updateChapter(chapter.id, (c) => ({ ...c, scenes: [...c.scenes, newScene({ title: `场次 ${c.scenes.length + 1}` })] })))}
              className="flex w-full items-center gap-1.5 px-4 py-2 text-xs text-fg-3 hover:bg-white/[0.02] hover:text-fg"
            >
              <Plus className="size-3.5" /> 添加场次
            </button>
          </div>
        </section>
      ))}
      <SplitDialog open={splitting} onClose={() => setSplitting(false)} />
    </div>
  );
}
