// 故事列表 v2（STY-13）：进行中 / 已完成 / 已归档 / 回收站；系列；复制故事；从上次编辑的位置继续；新建时可选模板
import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Archive, BookOpenText, CheckCircle2, Clapperboard, Copy, Library, MoreHorizontal, Plus, RotateCcw, Trash2, Undo2 } from 'lucide-react';
import { STORY_TEMPLATES } from '../../../../shared/story-templates.ts';
import type { StorySummary } from '../../../../shared/types.ts';
import { Button, Empty, IconButton, Modal, Segmented } from '../../components/ui.tsx';
import { api, type SeriesSummary } from '../../lib/api.ts';
import { reportError, useStore } from '../../lib/store.ts';
import { cx, timeAgo } from '../../lib/util.ts';
import { confirmDialog, promptDialog } from '../../components/ConfirmDialog.tsx';

type Tab = 'active' | 'done' | 'archived' | 'trash';
type Summary = StorySummary & { status?: string; lastPosition?: { tab?: string; sceneId?: string | null } | null; seriesId?: string | null; episodeNo?: number | null; deletedAt?: number | null; templateId?: string | null };

const STEP_LABEL: Record<string, string> = { overview: '总览', setup: '设定与大纲', characters: '设定库', structure: '章节场次', script: '剧本台词', shots: '分镜', preview: '成片', layout: '图文排版' };

function StoryMenu({ story, tab, onChanged }: { story: Summary; tab: Tab; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const toast = useStore((s) => s.toast);
  const run = async (action: () => Promise<unknown>, done?: string) => {
    setOpen(false);
    try {
      await action();
      if (done) toast(done, 'success');
      onChanged();
    } catch (error) {
      reportError(error);
    }
  };
  const item = 'flex w-full items-center gap-2 rounded-lg px-3 py-1.5 text-left hover:bg-white/[0.08]';
  return (
    <div className="absolute top-3 right-3" onClick={(e) => e.preventDefault()}>
      <IconButton label="更多操作" className="glass size-8" onClick={() => setOpen((v) => !v)}>
        <MoreHorizontal className="size-4" />
      </IconButton>
      {open && (
        <div className="glass absolute right-0 z-20 mt-1 w-40 rounded-xl border border-line-strong p-1 text-[13px] shadow-2xl" role="menu">
          {tab === 'trash' ? (
            <>
              <button role="menuitem" className={item} onClick={() => void run(() => api.restoreStory(story.id), '已恢复')}>
                <Undo2 className="size-3.5" /> 恢复
              </button>
              <button
                role="menuitem"
                className={cx(item, 'text-danger')}
                onClick={async () => {
                  setOpen(false);
                  if (await confirmDialog({ title: `彻底删除「${story.title}」？`, message: '故事内容无法恢复；已生成的素材会保留在资产库。', confirmText: '彻底删除', danger: true })) void run(() => api.deleteStory(story.id, true));
                }}
              >
                <Trash2 className="size-3.5" /> 彻底删除
              </button>
            </>
          ) : (
            <>
              <button
                role="menuitem"
                className={item}
                onClick={() =>
                  void run(async () => {
                    const copy = await api.duplicateStory(story.id);
                    navigate(`/studio/stories/${copy.id}`);
                  })
                }
              >
                <Copy className="size-3.5" /> 复制故事
              </button>
              {tab !== 'done' && (
                <button role="menuitem" className={item} onClick={() => void run(() => api.patchStory(story.id, { status: 'done' }), '已标记为完成')}>
                  <CheckCircle2 className="size-3.5" /> 标记完成
                </button>
              )}
              {tab !== 'archived' && (
                <button role="menuitem" className={item} onClick={() => void run(() => api.patchStory(story.id, { status: 'archived' }), '已归档')}>
                  <Archive className="size-3.5" /> 归档
                </button>
              )}
              {tab !== 'active' && (
                <button role="menuitem" className={item} onClick={() => void run(() => api.patchStory(story.id, { status: 'active' }), '已移回进行中')}>
                  <RotateCcw className="size-3.5" /> 移回进行中
                </button>
              )}
              <button role="menuitem" className={cx(item, 'text-danger')} onClick={() => void run(() => api.deleteStory(story.id), '已移入回收站')}>
                <Trash2 className="size-3.5" /> 删除
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export default function Stories() {
  const [tab, setTab] = useState<Tab>('active');
  const [stories, setStories] = useState<Summary[] | null>(null);
  const [series, setSeries] = useState<SeriesSummary[]>([]);
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState('');
  const [logline, setLogline] = useState('');
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [version, setVersion] = useState(0);
  const navigate = useNavigate();

  useEffect(() => {
    setStories(null);
    void api
      .stories(tab)
      .then((list) => setStories(list as Summary[]))
      .catch((error) => {
        reportError(error);
        setStories([]);
      });
  }, [tab, version]);

  useEffect(() => {
    void api.seriesList().then(setSeries).catch(() => undefined);
  }, [version]);

  async function create(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    try {
      const story = await api.createStory(title.trim() || '未命名故事', logline.trim(), templateId);
      navigate(`/studio/stories/${story.id}`);
    } catch (error) {
      reportError(error);
    } finally {
      setSaving(false);
    }
  }

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

  // 系列里的故事在系列卡片里看，进行中列表只放独立的故事
  const visible = (stories ?? []).filter((story) => tab !== 'active' || !story.seriesId);

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 md:py-10">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">故事工坊</h1>
          <p className="mt-1 text-sm text-fg-3">大纲 → 设定库 → 章节剧本 → 分镜 → 成片，构建任意长度的视频故事、绘本和漫画。</p>
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" icon={<Library className="size-4" />} onClick={() => void createSeries()}>
            新建系列
          </Button>
          <Button
            variant="brand"
            icon={<Plus className="size-4" />}
            onClick={() => {
              setTemplateId(null);
              setCreating(true);
            }}
          >
            新建故事
          </Button>
        </div>
      </div>

      <div className="no-scrollbar mt-6 overflow-x-auto">
        <Segmented
          value={tab}
          onChange={setTab}
          label="故事状态"
          options={[
            { value: 'active', label: '进行中' },
            { value: 'done', label: '已完成' },
            { value: 'archived', label: '已归档' },
            { value: 'trash', label: '回收站' },
          ]}
        />
      </div>

      {tab === 'active' && series.length > 0 && (
        <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
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

      <div className="mt-6">
        {stories === null ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 3 }, (_, i) => (
              <div key={i} className="skeleton aspect-[4/3] rounded-xl" />
            ))}
          </div>
        ) : visible.length === 0 ? (
          <Empty
            icon={<BookOpenText className="size-6" />}
            title={tab === 'trash' ? '回收站是空的' : tab === 'active' ? '还没有故事' : '这里还没有故事'}
            hint={tab === 'active' ? '写下一句话灵感，或从模板开始：竖屏短剧、MV、绘本、广告、动态漫、预告片。' : undefined}
            action={
              tab === 'active' ? (
                <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>
                  新建第一个故事
                </Button>
              ) : undefined
            }
          />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {visible.map((story) => {
              const position = story.lastPosition?.tab;
              const href = `/studio/stories/${story.id}${position ? `?tab=${position}` : ''}`;
              return (
                <Link key={story.id} to={tab === 'trash' ? '#' : href} onClick={(e) => tab === 'trash' && e.preventDefault()} className="panel group relative overflow-hidden transition-colors hover:border-line-strong">
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
                  </div>
                  <StoryMenu story={story} tab={tab} onChanged={() => setVersion((v) => v + 1)} />
                  <div className="p-4">
                    <p className="truncate font-medium">{story.title}</p>
                    <p className="mt-1 line-clamp-2 min-h-[2.5rem] text-sm text-fg-3">{story.logline || '还没有一句话故事'}</p>
                    <p className="mt-3 flex items-center justify-between text-xs text-fg-3">
                      <span>{tab === 'trash' && story.deletedAt ? `删除于 ${timeAgo(story.deletedAt)}` : `更新于 ${timeAgo(story.updatedAt)}`}</span>
                      {position && tab !== 'trash' && <span className="text-accent">继续：{STEP_LABEL[position] ?? position}</span>}
                    </p>
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </div>

      <Modal open={creating} onClose={() => setCreating(false)} title="新建故事" wide>
        <form onSubmit={create} className="space-y-4">
          <div>
            <p className="label">从模板开始（可选）</p>
            <div className="grid gap-2 sm:grid-cols-3">
              <button type="button" onClick={() => setTemplateId(null)} className={cx('rounded-xl border p-3 text-left text-sm transition', templateId === null ? 'border-accent bg-accent/10' : 'border-line hover:border-line-strong')}>
                <p className="font-medium">空白故事</p>
                <p className="mt-1 text-xs text-fg-3">从一句话开始，自由搭建</p>
              </button>
              {STORY_TEMPLATES.map((template) => (
                <button
                  type="button"
                  key={template.id}
                  onClick={() => {
                    setTemplateId(template.id);
                    if (!title.trim()) setTitle(template.name);
                  }}
                  className={cx('rounded-xl border p-3 text-left text-sm transition', templateId === template.id ? 'border-accent bg-accent/10' : 'border-line hover:border-line-strong')}
                >
                  <p className="font-medium">
                    {template.name}
                    {template.settings.aspectRatio && <span className="ml-1.5 font-mono text-[11px] text-fg-3">{template.settings.aspectRatio}</span>}
                  </p>
                  <p className="mt-1 line-clamp-2 text-xs text-fg-3">{template.description}</p>
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="label" htmlFor="story-title">
              故事名称
            </label>
            <input id="story-title" className="field" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={80} placeholder="例如：回声之城" autoFocus />
          </div>
          <div>
            <label className="label" htmlFor="story-logline">
              一句话故事（可选）
            </label>
            <textarea
              id="story-logline"
              className="field resize-none"
              rows={2}
              value={logline}
              onChange={(e) => setLogline(e.target.value)}
              maxLength={500}
              placeholder="例如：在一座失去所有声音的城市里，少女循着收音机里的求救信号，揭开了静默背后的秘密。"
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setCreating(false)}>
              取消
            </Button>
            <Button type="submit" variant="primary" loading={saving}>
              创建并开始
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
