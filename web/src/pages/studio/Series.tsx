// 系列看板：每一集的进度、系列共享的设定、系列统一设定（画风、比例、默认种子），新建下一集
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Film, Lock, Plus, Settings2, Share2, Trash2 } from 'lucide-react';
import { ASPECT_RATIOS } from '../../lib/presets.ts';
import { Button, Empty, Modal, Spinner } from '../../components/ui.tsx';
import { confirmDialog } from '../../components/ConfirmDialog.tsx';
import { api, type SeriesBoard, type SeriesSettings } from '../../lib/api.ts';
import { reportError, useStore } from '../../lib/store.ts';
import { formatDuration, timeAgo } from '../../lib/util.ts';

const KIND_LABEL: Record<string, string> = { character: '角色', location: '地点', prop: '道具', style: '画风' };

export default function Series() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const toast = useStore((s) => s.toast);
  const [board, setBoard] = useState<SeriesBoard | null>(null);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState('');
  const [copy, setCopy] = useState(true);
  const [settings, setSettings] = useState<SeriesSettings>({});

  const load = useCallback(async () => {
    try {
      const data = await api.series(id);
      setBoard(data);
      setSettings(data.settings);
    } catch (error) {
      reportError(error);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!board) {
    return (
      <div className="flex min-h-[60dvh] items-center justify-center">
        <Spinner />
      </div>
    );
  }

  const next = board.episodes.length + 1;

  async function createEpisode() {
    try {
      const story = await api.createEpisode(id, title.trim() || `第 ${next} 集`, copy ? undefined : null);
      navigate(`/studio/stories/${story.id}`);
    } catch (error) {
      reportError(error);
    }
  }

  async function saveSettings() {
    try {
      await api.updateSeries(id, { settings });
      toast('系列设定已保存，新建的集会使用这些设定', 'success');
      setEditing(false);
      void load();
    } catch (error) {
      reportError(error);
    }
  }

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6 md:py-10">
      <Link to="/studio/stories" className="inline-flex items-center gap-1 text-xs text-fg-3 hover:text-fg">
        <ArrowLeft className="size-3.5" /> 故事列表
      </Link>
      <div className="mt-2 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs text-accent">系列</p>
          <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">{board.title}</h1>
          <p className="mt-1 text-sm text-fg-3">
            {board.totals.episodes} 集 · {board.totals.shots} 个镜头 · {formatDuration(board.totals.duration)}
          </p>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="ghost" icon={<Settings2 className="size-4" />} onClick={() => setEditing(true)}>
            系列设定
          </Button>
          <Button
            size="sm"
            variant="brand"
            icon={<Plus className="size-4" />}
            onClick={() => {
              setTitle(`第 ${next} 集`);
              setCopy(board.episodes.length > 0);
              setCreating(true);
            }}
          >
            新建第 {next} 集
          </Button>
        </div>
      </div>

      <div className="mt-6 grid gap-4 lg:grid-cols-[minmax(0,1fr)_16rem]">
        <div className="space-y-2">
          {board.episodes.length === 0 ? (
            <Empty icon={<Film className="size-6" />} title="还没有剧集" hint="新建第一集，或在故事的「设定与大纲」里把已有故事加入这个系列。" />
          ) : (
            board.episodes.map((episode) => {
              const p = episode.progress;
              const n = Math.max(1, p?.shots ?? 0);
              return (
                <Link key={episode.id} to={`/studio/stories/${episode.id}`} className="panel block p-4 transition hover:border-line-strong">
                  <div className="flex items-baseline justify-between gap-3">
                    <p className="truncate font-medium">
                      <span className="mr-2 font-mono text-xs text-accent">EP{String(episode.episodeNo ?? 0).padStart(2, '0')}</span>
                      {episode.title}
                    </p>
                    <span className="shrink-0 text-xs text-fg-3">{timeAgo(episode.updatedAt)}</span>
                  </div>
                  {p && (
                    <>
                      <div className="relative mt-3 h-2 overflow-hidden rounded-full bg-white/[0.06]">
                        <div className="absolute inset-y-0 left-0 bg-accent/35" style={{ width: `${(p.keyframes / n) * 100}%` }} />
                        <div className="absolute inset-y-0 left-0 bg-accent" style={{ width: `${(p.videos / n) * 100}%` }} />
                      </div>
                      <p className="mt-1.5 flex gap-3 font-mono text-[11px] text-fg-3">
                        <span>{p.shots} 镜</span>
                        <span>关键帧 {p.keyframes}</span>
                        <span>视频 {p.videos}</span>
                        <span className="flex items-center gap-0.5">
                          <Lock className="size-3" />
                          {p.locked}
                        </span>
                        <span>{formatDuration(episode.stats.duration ?? 0)}</span>
                      </p>
                    </>
                  )}
                </Link>
              );
            })
          )}
        </div>
        <aside className="space-y-3">
          <div className="panel p-4">
            <p className="flex items-center gap-1.5 text-sm font-medium">
              <Share2 className="size-4 text-accent" /> 系列共享设定
            </p>
            {board.shared.length === 0 ? (
              <p className="mt-2 text-xs text-fg-3">在任意一集的设定库里勾选"系列共享"，角色和设定就会出现在每一集里，改一处处处生效。</p>
            ) : (
              <ul className="mt-2 space-y-1 text-[13px]">
                {board.shared.map((item) => (
                  <li key={item.id} className="flex justify-between gap-2">
                    <span className="truncate">{item.name}</span>
                    <span className="shrink-0 text-xs text-fg-3">{KIND_LABEL[item.kind] ?? item.kind}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <Button
            size="sm"
            variant="ghost"
            className="w-full text-danger"
            icon={<Trash2 className="size-3.5" />}
            onClick={async () => {
              if (!(await confirmDialog({ title: `删除系列「${board.title}」？`, message: '各集会保留，变成独立的故事；共享设定变回各自私有。', confirmText: '删除系列', danger: true }))) return;
              await api.deleteSeries(id).catch(reportError);
              navigate('/studio/stories');
            }}
          >
            删除系列
          </Button>
        </aside>
      </div>

      <Modal open={creating} onClose={() => setCreating(false)} title={`新建第 ${next} 集`}>
        <div className="space-y-3">
          <input className="field" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={80} aria-label="这一集的标题" />
          {board.episodes.length > 0 && (
            <label className="flex items-center gap-2 text-sm text-fg-2">
              <input type="checkbox" checked={copy} onChange={(e) => setCopy(e.target.checked)} />
              复制上一集的章节和场次结构（不含镜头）
            </label>
          )}
          <p className="text-xs text-fg-3">新的一集会使用系列设定（画风、比例、默认种子），并自动看到系列共享的角色和设定。</p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setCreating(false)}>
              取消
            </Button>
            <Button variant="brand" onClick={() => void createEpisode()}>
              创建并打开
            </Button>
          </div>
        </div>
      </Modal>

      <Modal open={editing} onClose={() => setEditing(false)} title="系列设定">
        <div className="space-y-3">
          <div>
            <label className="label">统一画风</label>
            <textarea className="field resize-none text-sm" rows={2} value={settings.visualStyle ?? ''} onChange={(e) => setSettings({ ...settings, visualStyle: e.target.value })} />
          </div>
          <div>
            <label className="label">画面比例</label>
            <div className="flex flex-wrap gap-1">
              {ASPECT_RATIOS.map((ratio) => (
                <button key={ratio} className="chip" data-active={settings.aspectRatio === ratio} onClick={() => setSettings({ ...settings, aspectRatio: ratio })}>
                  {ratio}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="label">默认种子</label>
            <input
              type="number"
              className="field !w-40"
              value={settings.defaultSeed ?? ''}
              placeholder="随机"
              onChange={(e) => setSettings({ ...settings, defaultSeed: e.target.value === '' ? null : Math.trunc(Number(e.target.value)) })}
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setEditing(false)}>
              取消
            </Button>
            <Button variant="brand" onClick={() => void saveSettings()}>
              保存
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
