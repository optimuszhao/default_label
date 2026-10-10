import { useState } from 'react';
import { ArrowRight, BookOpenText, ChevronDown, ChevronUp, MessageSquarePlus, Sparkles, Trash2 } from 'lucide-react';
import type { DialogueLine } from '../../../../../shared/types.ts';
import { Button, Empty, IconButton, Modal } from '../../../components/ui.tsx';
import { api } from '../../../lib/api.ts';
import { reportError } from '../../../lib/store.ts';
import { useStory } from './context.tsx';
import { findScene, moveItem, newChapter, newDialogue, newScene, updateChapter, updateScene } from './model.ts';
import { SceneNavigator } from './SceneNavigator.tsx';
import { confirmDialog } from '../../../components/ConfirmDialog.tsx';

interface AiChapter {
  title: string;
  summary: string;
  scenes: { title: string; location: string; time: string; summary: string }[];
}

export function SplitDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { storyId, data, update, setSceneId } = useStory();
  const [chapters, setChapters] = useState(3);
  const [scenes, setScenes] = useState(3);
  const [loading, setLoading] = useState(false);

  async function run() {
    setLoading(true);
    try {
      const result = await api.assist<{ chapters: AiChapter[] }>('chapters', {
        storyId,
        outline: data.outline,
        logline: data.logline,
        characters: data.characters.map((c) => ({ name: c.name, role: c.role })),
        existingChapters: data.chapters.map((c) => c.title),
        chapterCount: chapters,
        scenesPerChapter: scenes,
      });
      const added = result.chapters.map((chapter) =>
        newChapter({ title: chapter.title, summary: chapter.summary, scenes: chapter.scenes.map((scene) => newScene(scene)) }),
      );
      update((d) => ({ ...d, chapters: [...d.chapters, ...added] }));
      if (added[0]?.scenes[0]) setSceneId(added[0].scenes[0].id);
      onClose();
    } catch (error) {
      reportError(error);
    } finally {
      setLoading(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="AI 拆分章节与场次">
      <p className="text-sm text-fg-3">根据故事大纲生成新的章节和场次，追加到现有章节之后。长篇故事可以分多次生成。</p>
      <div className="mt-5 grid grid-cols-2 gap-4">
        <div>
          <label className="label">章节数</label>
          <input type="number" min={1} max={8} className="field" value={chapters} onChange={(e) => setChapters(Math.max(1, Math.min(8, Number(e.target.value) || 1)))} />
        </div>
        <div>
          <label className="label">每章场次数</label>
          <input type="number" min={1} max={8} className="field" value={scenes} onChange={(e) => setScenes(Math.max(1, Math.min(8, Number(e.target.value) || 1)))} />
        </div>
      </div>
      {!data.outline.trim() && <p className="mt-4 rounded-xl bg-warn/10 px-3 py-2 text-xs text-warn">还没有故事大纲，生成效果会比较随机。</p>}
      <div className="mt-6 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>取消</Button>
        <Button variant="brand" icon={<Sparkles className="size-4" />} loading={loading} onClick={() => void run()}>生成</Button>
      </div>
    </Modal>
  );
}

function SceneEditor({ onGoShots }: { onGoShots: () => void }) {
  const { storyId, data, update, sceneId } = useStory();
  const found = findScene(data, sceneId);
  const [writing, setWriting] = useState(false);
  if (!found) {
    return <Empty icon={<BookOpenText className="size-6" />} title="选择或新建一个场次" hint="在左侧选择场次，编辑剧本和台词。" />;
  }
  const { scene, chapter } = found;
  const setScene = (patch: Partial<typeof scene>) => update(updateScene(scene.id, (s) => ({ ...s, ...patch })));
  const setLine = (id: string, patch: Partial<DialogueLine>) =>
    update(updateScene(scene.id, (s) => ({ ...s, dialogue: s.dialogue.map((d) => (d.id === id ? { ...d, ...patch } : d)) })));

  async function writeDialogue() {
    if (scene.dialogue.length && !(await confirmDialog({ title: '用 AI 生成的台词替换本场现有台词？', message: '当前内容会先存进历史版本。' }))) return;
    setWriting(true);
    try {
      const result = await api.assist<{ dialogue: { character: string; text: string; emotion: string }[] }>('dialogue', {
        storyId,
        outline: data.outline.slice(0, 3000),
        chapter: chapter.title,
        sceneTitle: scene.title,
        location: scene.location,
        time: scene.time,
        sceneSummary: scene.summary,
        characterNames: data.characters.map((c) => c.name),
        characters: data.characters.map((c) => ({ name: c.name, personality: c.personality })),
      });
      const lines = result.dialogue.map((line) =>
        newDialogue({
          characterId: data.characters.find((c) => c.name === line.character)?.id ?? null,
          text: line.text,
          emotion: line.emotion,
        }),
      );
      setScene({ dialogue: lines });
    } catch (error) {
      reportError(error);
    } finally {
      setWriting(false);
    }
  }

  return (
    <div className="space-y-4">
      <section className="panel space-y-3 p-4 sm:p-5">
        <div className="flex flex-wrap items-center gap-2 text-xs text-fg-3">
          <input
            className="field !w-auto !py-1 !text-xs"
            value={chapter.title}
            onChange={(e) => update(updateChapter(chapter.id, (c) => ({ ...c, title: e.target.value })))}
            aria-label="章节标题"
          />
          <span>/</span>
          <input className="field !w-auto flex-1 !py-1 font-medium !text-sm" value={scene.title} onChange={(e) => setScene({ title: e.target.value })} aria-label="场次标题" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">地点</label>
            <input className="field" value={scene.location} onChange={(e) => setScene({ location: e.target.value })} placeholder="例如：废墟街道" />
          </div>
          <div>
            <label className="label">时间</label>
            <input className="field" value={scene.time} onChange={(e) => setScene({ time: e.target.value })} placeholder="例如：黄昏 / 雨夜" />
          </div>
        </div>
        <div>
          <label className="label">剧本（本场剧情）</label>
          <textarea className="field min-h-32 resize-y leading-relaxed" value={scene.summary} onChange={(e) => setScene({ summary: e.target.value })} placeholder="描述这一场发生了什么：人物、动作、冲突、情绪变化" />
        </div>
      </section>

      <section className="panel p-4 sm:p-5">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="font-medium">台词对白</h3>
            <p className="text-xs text-fg-3">{scene.dialogue.length} 句 · 不选角色即为旁白</p>
          </div>
          <div className="flex gap-2">
            <Button size="sm" icon={<MessageSquarePlus className="size-3.5" />} onClick={() => setScene({ dialogue: [...scene.dialogue, newDialogue()] })}>
              添加
            </Button>
            <Button size="sm" variant="brand" icon={<Sparkles className="size-3.5" />} loading={writing} onClick={() => void writeDialogue()}>
              AI 写台词
            </Button>
          </div>
        </div>
        <div className="space-y-2">
          {scene.dialogue.map((line, index) => (
            <div key={line.id} className="group flex flex-col gap-2 rounded-xl bg-white/[0.02] p-2 sm:flex-row sm:items-center">
              <div className="flex gap-2">
                <select
                  className="field !w-28 shrink-0 !py-1.5 text-sm"
                  value={line.characterId ?? ''}
                  onChange={(e) => setLine(line.id, { characterId: e.target.value || null })}
                  aria-label="说话角色"
                >
                  <option value="">旁白</option>
                  {data.characters.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
                <input className="field !w-20 shrink-0 !py-1.5 text-sm" value={line.emotion} onChange={(e) => setLine(line.id, { emotion: e.target.value })} placeholder="情绪" aria-label="情绪" />
              </div>
              <input className="field flex-1 !py-1.5 text-sm" value={line.text} onChange={(e) => setLine(line.id, { text: e.target.value })} placeholder="台词内容" aria-label="台词" />
              <div className="flex shrink-0 justify-end opacity-100 transition sm:opacity-0 sm:group-hover:opacity-100">
                <IconButton label="上移" className="size-7" onClick={() => setScene({ dialogue: moveItem(scene.dialogue, index, -1) })}><ChevronUp className="size-3.5" /></IconButton>
                <IconButton label="下移" className="size-7" onClick={() => setScene({ dialogue: moveItem(scene.dialogue, index, 1) })}><ChevronDown className="size-3.5" /></IconButton>
                <IconButton label="删除" className="size-7 hover:text-danger" onClick={() => setScene({ dialogue: scene.dialogue.filter((d) => d.id !== line.id) })}><Trash2 className="size-3.5" /></IconButton>
              </div>
            </div>
          ))}
          {scene.dialogue.length === 0 && <p className="py-6 text-center text-sm text-fg-3">还没有台词</p>}
        </div>
      </section>

      <div className="flex justify-end">
        <Button variant="primary" onClick={onGoShots}>
          为本场设计分镜 <ArrowRight className="size-4" />
        </Button>
      </div>
    </div>
  );
}

export function ScriptTab({ onGoShots }: { onGoShots: () => void }) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-[15rem_minmax(0,1fr)]">
      <div className="lg:sticky lg:top-28 lg:self-start">
        <SceneNavigator editable />
      </div>
      <SceneEditor onGoShots={onGoShots} />
    </div>
  );
}
