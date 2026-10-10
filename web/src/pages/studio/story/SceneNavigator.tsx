import { ChevronDown, ChevronUp, Plus, Trash2 } from 'lucide-react';
import { IconButton } from '../../../components/ui.tsx';
import { cx } from '../../../lib/util.ts';
import { useStory } from './context.tsx';
import { moveItem, newChapter, newScene, updateChapter } from './model.ts';

/** 章节 / 场次导航：桌面端为树形侧栏，移动端为原生下拉框（滚动与选择更顺滑） */
export function SceneNavigator({ editable }: { editable?: boolean }) {
  const { data, update, sceneId, setSceneId, media } = useStory();
  const progress = (shots: { id: string }[]) => shots.filter((shot) => media.get(shot.id)?.keyframe).length;

  function addChapter() {
    const chapter = newChapter({ title: `第${data.chapters.length + 1}章` });
    const scene = newScene({ title: '场次 1' });
    update((d) => ({ ...d, chapters: [...d.chapters, { ...chapter, scenes: [scene] }] }));
    setSceneId(scene.id);
  }

  function addScene(chapterId: string, count: number) {
    const scene = newScene({ title: `场次 ${count + 1}` });
    update(updateChapter(chapterId, (c) => ({ ...c, scenes: [...c.scenes, scene] })));
    setSceneId(scene.id);
  }

  function removeChapter(chapterId: string, title: string) {
    if (!confirm(`删除「${title}」及其全部场次和分镜？`)) return;
    update((d) => ({ ...d, chapters: d.chapters.filter((c) => c.id !== chapterId) }));
  }

  function removeScene(chapterId: string, id: string, title: string) {
    if (!confirm(`删除场次「${title}」及其分镜？`)) return;
    update(updateChapter(chapterId, (c) => ({ ...c, scenes: c.scenes.filter((s) => s.id !== id) })));
    if (sceneId === id) setSceneId(null);
  }

  return (
    <>
      {/* 移动端 */}
      <div className="flex gap-2 lg:hidden">
        <select className="field flex-1" value={sceneId ?? ''} onChange={(e) => setSceneId(e.target.value || null)}>
          <option value="">选择场次…</option>
          {data.chapters.map((chapter) => (
            <optgroup key={chapter.id} label={chapter.title}>
              {chapter.scenes.map((scene) => (
                <option key={scene.id} value={scene.id}>
                  {scene.title}
                  {scene.shots.length ? `（${scene.shots.length} 镜）` : ''}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        {editable && (
          <IconButton label="新增章节" onClick={addChapter} className="size-[46px] border border-line">
            <Plus className="size-4" />
          </IconButton>
        )}
      </div>

      {/* 桌面端 */}
      <nav className="panel hidden max-h-[calc(100dvh-9rem)] overflow-auto p-2 lg:block">
        {data.chapters.map((chapter, chapterIndex) => (
          <div key={chapter.id} className="mb-1">
            <div className="group flex items-center gap-1 rounded-lg px-2 py-1.5">
              <span className="min-w-0 flex-1 truncate text-xs font-medium text-fg-2">{chapter.title}</span>
              {editable && (
                <span className="flex opacity-0 transition group-hover:opacity-100">
                  <IconButton label="上移" className="size-6" onClick={() => update((d) => ({ ...d, chapters: moveItem(d.chapters, chapterIndex, -1) }))}>
                    <ChevronUp className="size-3" />
                  </IconButton>
                  <IconButton label="下移" className="size-6" onClick={() => update((d) => ({ ...d, chapters: moveItem(d.chapters, chapterIndex, 1) }))}>
                    <ChevronDown className="size-3" />
                  </IconButton>
                  <IconButton label="删除章节" className="size-6 hover:text-danger" onClick={() => removeChapter(chapter.id, chapter.title)}>
                    <Trash2 className="size-3" />
                  </IconButton>
                </span>
              )}
            </div>
            {chapter.scenes.map((scene, sceneIndex) => (
              <div
                key={scene.id}
                className={cx(
                  'group flex items-center gap-1 rounded-lg pr-1 transition-colors',
                  sceneId === scene.id ? 'bg-violet/15 text-fg' : 'text-fg-3 hover:bg-white/[0.04] hover:text-fg-2',
                )}
              >
                <button className="flex min-w-0 flex-1 items-center gap-2 py-1.5 pl-4 text-left text-[13px]" onClick={() => setSceneId(scene.id)}>
                  <span className="truncate">{scene.title}</span>
                  {scene.shots.length > 0 && (
                    <span className={cx('ml-auto shrink-0 font-mono text-[10px]', progress(scene.shots) === scene.shots.length ? 'text-accent' : 'text-fg-3')}>
                      {progress(scene.shots)}/{scene.shots.length}
                    </span>
                  )}
                </button>
                {editable && (
                  <span className="flex opacity-0 transition group-hover:opacity-100">
                    <IconButton
                      label="上移"
                      className="size-6"
                      onClick={() => update(updateChapter(chapter.id, (c) => ({ ...c, scenes: moveItem(c.scenes, sceneIndex, -1) })))}
                    >
                      <ChevronUp className="size-3" />
                    </IconButton>
                    <IconButton label="删除场次" className="size-6 hover:text-danger" onClick={() => removeScene(chapter.id, scene.id, scene.title)}>
                      <Trash2 className="size-3" />
                    </IconButton>
                  </span>
                )}
              </div>
            ))}
            {editable && (
              <button
                onClick={() => addScene(chapter.id, chapter.scenes.length)}
                className="flex w-full items-center gap-1.5 rounded-lg py-1.5 pl-4 text-xs text-fg-3 hover:text-fg"
              >
                <Plus className="size-3" /> 添加场次
              </button>
            )}
          </div>
        ))}
        {editable && (
          <button
            onClick={addChapter}
            className="mt-1 flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-line py-2 text-xs text-fg-3 hover:border-line-strong hover:text-fg"
          >
            <Plus className="size-3.5" /> 新增章节
          </button>
        )}
        {data.chapters.length === 0 && !editable && <p className="p-3 text-xs text-fg-3">还没有场次</p>}
      </nav>
    </>
  );
}
