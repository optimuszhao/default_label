// 从创作台 / 资产库把一张图或一段视频加入故事：选故事 → 选场次，在场次末尾新建一个镜头，素材作为它的选定画面
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Asset, Story, StorySummary } from '../../../shared/types.ts';
import { api } from '../lib/api.ts';
import { reportError, useStore } from '../lib/store.ts';
import { Button, Modal, Spinner } from './ui.tsx';

export function AddToStoryDialog({ asset, onClose }: { asset: Asset | null; onClose: () => void }) {
  const [stories, setStories] = useState<StorySummary[] | null>(null);
  const [storyId, setStoryId] = useState('');
  const [story, setStory] = useState<Story | null>(null);
  const [sceneId, setSceneId] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ storyId: string; sceneId: string } | null>(null);
  const toast = useStore((s) => s.toast);

  useEffect(() => {
    if (!asset) return;
    setDone(null);
    setStory(null);
    setSceneId('');
    void api.stories().then((list) => {
      setStories(list);
      const first = asset.storyId && list.some((s) => s.id === asset.storyId) ? asset.storyId : list[0]?.id ?? '';
      setStoryId(first);
    }, reportError);
  }, [asset]);

  useEffect(() => {
    if (!storyId) return;
    setStory(null);
    void api.story(storyId).then((s) => {
      setStory(s);
      const scenes = s.data.chapters.flatMap((c) => c.scenes);
      setSceneId(scenes.at(-1)?.id ?? '');
    }, reportError);
  }, [storyId]);

  async function add() {
    if (!asset || !storyId || !sceneId) return;
    setBusy(true);
    try {
      await api.shotFromAsset(storyId, asset.id, sceneId);
      toast('已加入故事镜头', 'success');
      setDone({ storyId, sceneId });
    } catch (error) {
      reportError(error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={Boolean(asset)} onClose={onClose} title="加入故事镜头">
      {done ? (
        <div className="space-y-4 text-sm">
          <p>已在所选场次的末尾新建了一个镜头，这张{asset?.kind === 'video' ? '视频' : '图'}是它的选定画面。</p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              关闭
            </Button>
            <Link to={`/studio/stories/${done.storyId}?tab=shots`} onClick={onClose}>
              <Button variant="brand">去分镜</Button>
            </Link>
          </div>
        </div>
      ) : stories === null ? (
        <div className="flex justify-center py-6">
          <Spinner />
        </div>
      ) : stories.length === 0 ? (
        <p className="text-sm text-fg-3">还没有故事，先去故事工坊建一个。</p>
      ) : (
        <div className="space-y-3">
          <div>
            <label className="label">故事</label>
            <select className="field" value={storyId} onChange={(e) => setStoryId(e.target.value)} aria-label="故事">
              {stories.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.title}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">加到哪个场次</label>
            {!story ? (
              <Spinner />
            ) : story.data.chapters.flatMap((c) => c.scenes).length === 0 ? (
              <p className="text-xs text-fg-3">这个故事还没有场次，先在「章节场次」里建一个。</p>
            ) : (
              <select className="field" value={sceneId} onChange={(e) => setSceneId(e.target.value)} aria-label="场次">
                {story.data.chapters.map((chapter) => (
                  <optgroup key={chapter.id} label={chapter.title || '未命名章节'}>
                    {chapter.scenes.map((scene) => (
                      <option key={scene.id} value={scene.id}>
                        {scene.title || '未命名场次'}（{scene.shots.length} 镜）
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            )}
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              取消
            </Button>
            <Button variant="brand" loading={busy} disabled={!sceneId || story?.readOnly} onClick={() => void add()}>
              加入
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
