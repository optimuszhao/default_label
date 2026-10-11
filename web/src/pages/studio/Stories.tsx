import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { BookOpenText, Clapperboard, Library, Plus, Trash2 } from 'lucide-react';
import type { StorySummary } from '../../../../shared/types.ts';
import { Button, Empty, IconButton, Modal } from '../../components/ui.tsx';
import { api, type SeriesSummary } from '../../lib/api.ts';
import { promptDialog } from '../../components/ConfirmDialog.tsx';
import { reportError } from '../../lib/store.ts';
import { timeAgo } from '../../lib/util.ts';
import { confirmDialog } from '../../components/ConfirmDialog.tsx';

export default function Stories() {
  const [stories, setStories] = useState<StorySummary[] | null>(null);
  const [series, setSeries] = useState<SeriesSummary[]>([]);
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState('');
  const [logline, setLogline] = useState('');
  const [saving, setSaving] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    void api.stories().then(setStories).catch((error) => {
      reportError(error);
      setStories([]);
    });
    void api.seriesList().then(setSeries).catch(() => undefined);
  }, []);

  async function createSeries() {
    const name = await promptDialog({ title: '新建系列', message: '系列里的各集共享画风、比例和标记为"系列共享"的角色设定。', placeholder: '系列名', maxLength: 80, confirmText: '创建' });
    if (!name) return;
    try {
      const created = await api.createSeries(name);
      navigate(`/studio/series/${created.id}`);
    } catch (error) {
      reportError(error);
    }
  }

  async function create(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    try {
      const story = await api.createStory(title.trim() || '未命名故事', logline.trim());
      navigate(`/studio/stories/${story.id}`);
    } catch (error) {
      reportError(error);
    } finally {
      setSaving(false);
    }
  }

  async function remove(story: StorySummary) {
    if (!(await confirmDialog({ title: `删除「${story.title}」？`, message: '已生成的素材会保留在资产库。', confirmText: '删除', danger: true }))) return;
    try {
      await api.deleteStory(story.id);
      setStories((prev) => prev?.filter((item) => item.id !== story.id) ?? null);
    } catch (error) {
      reportError(error);
    }
  }

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 md:py-10">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">故事工坊</h1>
          <p className="mt-1 text-sm text-fg-3">大纲 → 角色 → 章节剧本 → 台词 → 分镜 → 成片，构建任意长度的视频故事。</p>
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" icon={<Library className="size-4" />} onClick={() => void createSeries()}>
            新建系列
          </Button>
          <Button variant="brand" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>
            新建故事
          </Button>
        </div>
      </div>

      {series.length > 0 && (
        <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {series.map((item) => (
            <Link key={item.id} to={`/studio/series/${item.id}`} className="panel p-4 transition hover:border-line-strong">
              <p className="flex items-center gap-1.5 text-xs text-accent">
                <Library className="size-3.5" /> 系列
              </p>
              <p className="mt-1 truncate font-medium">{item.title}</p>
              <p className="mt-1 text-xs text-fg-3">
                {item.totals.episodes} 集 · {item.totals.shots} 镜
              </p>
            </Link>
          ))}
        </div>
      )}

      <div className="mt-8">
        {stories === null ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 3 }, (_, i) => (
              <div key={i} className="skeleton aspect-[4/3] rounded-xl" />
            ))}
          </div>
        ) : stories.length === 0 ? (
          <Empty
            icon={<BookOpenText className="size-6" />}
            title="还没有故事"
            hint="写下一句话灵感，AI 会帮你扩展成完整的大纲、角色、剧本与分镜。"
            action={<Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>新建第一个故事</Button>}
          />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {stories.map((story) => (
              <Link key={story.id} to={`/studio/stories/${story.id}`} className="panel group overflow-hidden transition-colors hover:border-line-strong">
                <div className="relative aspect-video overflow-hidden">
                  {story.coverUrl ? (
                    <img src={story.coverUrl} alt="" loading="lazy" className="size-full object-cover transition-transform duration-700 group-hover:scale-[1.04]" />
                  ) : (
                    <div className="dots-bg flex size-full items-center justify-center bg-ink-2 text-fg-3">
                      <BookOpenText className="size-6" />
                    </div>
                  )}
                  <span className="absolute bottom-3 left-3 inline-flex items-center gap-1 rounded-full bg-black/50 px-2 py-0.5 text-[11px] backdrop-blur">
                    <Clapperboard className="size-3" /> {story.shotCount} 个镜头
                  </span>
                  <IconButton
                    label="删除故事"
                    className="glass absolute top-3 right-3 size-8 opacity-100 transition sm:opacity-0 sm:group-hover:opacity-100"
                    onClick={(e) => {
                      e.preventDefault();
                      void remove(story);
                    }}
                  >
                    <Trash2 className="size-3.5" />
                  </IconButton>
                </div>
                <div className="p-4">
                  <p className="truncate font-medium">{story.title}</p>
                  <p className="mt-1 line-clamp-2 min-h-[2.5rem] text-sm text-fg-3">{story.logline || '还没有一句话故事'}</p>
                  <p className="mt-3 text-xs text-fg-3">更新于 {timeAgo(story.updatedAt)}</p>
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>

      <Modal open={creating} onClose={() => setCreating(false)} title="新建故事">
        <form onSubmit={create} className="space-y-4">
          <div>
            <label className="label" htmlFor="story-title">故事名称</label>
            <input id="story-title" className="field" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={80} placeholder="例如：回声之城" autoFocus />
          </div>
          <div>
            <label className="label" htmlFor="story-logline">一句话故事（可选）</label>
            <textarea
              id="story-logline"
              className="field resize-none"
              rows={3}
              value={logline}
              onChange={(e) => setLogline(e.target.value)}
              maxLength={500}
              placeholder="例如：在一座失去所有声音的城市里，少女循着收音机里的求救信号，揭开了静默背后的秘密。"
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setCreating(false)}>取消</Button>
            <Button type="submit" variant="primary" loading={saving}>创建并开始</Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
