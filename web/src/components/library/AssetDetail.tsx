// 资产详情抽屉：信息、生成参数、血缘、使用情况、组织（评分 / 挑选淘汰 / 标签 / 备注 / 文件夹）
import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  Copy,
  Download,
  Expand,
  Folder,
  Heart,
  Scissors,
  Star,
  ThumbsDown,
  ThumbsUp,
  Trash2,
  Undo2,
  X,
} from 'lucide-react';
import { TASK_TYPE_LABEL, type Asset, type AssetFolder, type AssetUsage, type TaskType } from '../../../../shared/types.ts';
import { api, type AssetDetail as Detail } from '../../lib/api.ts';
import { reportError, useStore } from '../../lib/store.ts';
import { cx, formatDuration, timeAgo } from '../../lib/util.ts';
import { confirmDialog } from '../ConfirmDialog.tsx';
import { IconButton, Media, Segmented } from '../ui.tsx';
import { pickFolder } from './FolderPicker.tsx';
import { formatBytes } from './LibrarySidebar.tsx';

type Tab = 'info' | 'params' | 'lineage' | 'usage' | 'organize';

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex justify-between gap-3 py-1.5">
      <dt className="shrink-0 text-fg-3">{label}</dt>
      <dd className="min-w-0 truncate text-right">{children}</dd>
    </div>
  );
}

function Thumb({ asset, onClick, label }: { asset: Asset; onClick: () => void; label?: string }) {
  return (
    <button onClick={onClick} className="group relative aspect-square overflow-hidden rounded-lg border border-line hover:border-accent" title={asset.prompt ?? ''}>
      <Media asset={asset} variant="thumb" />
      {label && <span className="absolute inset-x-0 bottom-0 bg-black/60 px-1 py-0.5 text-[10px] text-white">{label}</span>}
    </button>
  );
}

export function AssetDetail({
  assetId,
  folders,
  onClose,
  onOpenViewer,
  onNavigate,
  onChanged,
}: {
  assetId: string;
  folders: AssetFolder[];
  onClose: () => void;
  onOpenViewer: (id: string) => void;
  onNavigate: (id: string) => void;
  onChanged: () => void;
}) {
  const asset = useStore((s) => s.assets[assetId]);
  const upsertAssets = useStore((s) => s.upsertAssets);
  const toast = useStore((s) => s.toast);
  const [tab, setTab] = useState<Tab>('info');
  const [detail, setDetail] = useState<Detail | null>(null);
  const [lineage, setLineage] = useState<{ parents: Asset[]; children: Asset[] } | null>(null);
  const [usage, setUsage] = useState<AssetUsage | null>(null);
  const [note, setNote] = useState('');
  const [tagInput, setTagInput] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setDetail(null);
    setLineage(null);
    setUsage(null);
    void api.assetDetail(assetId).then((d) => {
      setDetail(d);
      upsertAssets([d.asset]);
    }).catch(() => undefined);
  }, [assetId, upsertAssets]);

  useEffect(() => setNote(asset?.note ?? ''), [asset?.id, asset?.note]);

  useEffect(() => {
    if (tab === 'lineage' && !lineage) void api.assetLineage(assetId).then((l) => { setLineage(l); upsertAssets([...l.parents, ...l.children]); }).catch(reportError);
    if (tab === 'usage' && !usage) void api.assetUsage(assetId).then(setUsage).catch(reportError);
  }, [tab, assetId, lineage, usage, upsertAssets]);

  if (!asset) return null;

  async function patch(change: Parameters<typeof api.patchAsset>[1]) {
    try {
      upsertAssets([await api.patchAsset(asset!.id, change)]);
      if (change.folderId !== undefined || change.tags) onChanged();
    } catch (error) {
      reportError(error);
    }
  }

  async function copy(text: string, label: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast(`已复制${label}`, 'success');
    } catch {
      toast('浏览器不允许复制', 'error');
    }
  }

  async function trash() {
    try {
      const refs = await api.assetUsage(asset!.id);
      if (refs.activeTasks.length) {
        toast(`正在被任务「${refs.activeTasks[0].title}」使用，不能删除`, 'error');
        return;
      }
      const message = refs.stories.length
        ? `这个素材正在被使用：${refs.stories.slice(0, 3).map((s) => `「${s.title}」${s.where}`).join('；')}。移入回收站后这些地方会显示为缺失，30 天内可以恢复。`
        : '移入回收站，30 天内可以恢复。';
      if (!(await confirmDialog({ title: '移入回收站？', message, confirmText: '移入回收站', danger: refs.stories.length > 0 }))) return;
      await api.deleteAsset(asset!.id);
      toast('已移入回收站', 'success');
      onChanged();
      onClose();
    } catch (error) {
      reportError(error);
    }
  }

  async function restore() {
    try {
      await api.batchAssets({ ids: [asset!.id] }, 'restore');
      toast('已恢复', 'success');
      onChanged();
    } catch (error) {
      reportError(error);
    }
  }

  async function purge() {
    if (!(await confirmDialog({ title: '彻底删除？', message: '文件会从硬盘上删除，无法恢复。', confirmText: '彻底删除', danger: true }))) return;
    try {
      await api.deleteAsset(asset!.id);
      onChanged();
      onClose();
    } catch (error) {
      reportError(error);
    }
  }

  async function grabFrame() {
    const video = document.querySelector<HTMLVideoElement>(`[data-detail-video="${asset!.id}"] video`);
    const at = video ? Math.max(0, video.currentTime) : 0;
    setBusy(true);
    try {
      const frame = await api.frame(asset!.id, at);
      upsertAssets([frame]);
      toast(`已截取 ${at.toFixed(1)} 秒处的画面`, 'success');
      setLineage(null);
    } catch (error) {
      reportError(error);
    } finally {
      setBusy(false);
    }
  }

  function addTag() {
    const name = tagInput.trim().replace(/^#/, '');
    if (!name) return;
    setTagInput('');
    if (!asset!.tags.includes(name)) void patch({ tags: [...asset!.tags, name] });
  }

  const gen = asset.gen;
  const png = detail?.meta?.png;
  const trashed = Boolean(asset.deletedAt);

  return (
    <aside className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-1 border-b border-line px-3 py-2">
        <p className="min-w-0 flex-1 truncate text-sm font-medium">{asset.filename ?? (asset.kind === 'video' ? '视频' : asset.kind === 'audio' ? '音频' : '图片')}</p>
        <IconButton label="关闭详情" onClick={onClose}>
          <X className="size-4" />
        </IconButton>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div data-detail-video={asset.id} className="relative flex aspect-video items-center justify-center bg-black">
          <Media asset={asset} fit="contain" controls={asset.kind !== 'image'} className="max-h-full" />
        </div>
        <div className="flex flex-wrap items-center gap-0.5 border-b border-line px-2 py-1.5">
          <IconButton label="全屏查看" onClick={() => onOpenViewer(asset.id)}>
            <Expand className="size-4" />
          </IconButton>
          <IconButton label={asset.favorite ? '取消收藏' : '收藏'} onClick={() => void patch({ favorite: !asset.favorite })}>
            <Heart className={cx('size-4', asset.favorite && 'fill-pink text-pink')} />
          </IconButton>
          <a href={`${asset.url}?download=1`} aria-label="下载原文件" title="下载原文件" className="rounded-lg p-2 text-fg-2 hover:bg-white/[0.06] hover:text-fg">
            <Download className="size-4" />
          </a>
          {asset.kind === 'video' && !trashed && (
            <IconButton label="截取当前画面为图片" onClick={() => void grabFrame()} disabled={busy}>
              <Scissors className="size-4" />
            </IconButton>
          )}
          <span className="flex-1" />
          {trashed ? (
            <>
              <IconButton label="恢复" onClick={() => void restore()}>
                <Undo2 className="size-4" />
              </IconButton>
              <IconButton label="彻底删除" onClick={() => void purge()} className="text-danger">
                <Trash2 className="size-4" />
              </IconButton>
            </>
          ) : (
            <IconButton label="移入回收站" onClick={() => void trash()}>
              <Trash2 className="size-4" />
            </IconButton>
          )}
        </div>

        <div className="no-scrollbar overflow-x-auto px-3 pt-3">
          <Segmented
            value={tab}
            onChange={setTab}
            size="sm"
            options={[
              { value: 'info', label: '信息' },
              { value: 'params', label: '参数' },
              { value: 'organize', label: '整理' },
              { value: 'lineage', label: '血缘' },
              { value: 'usage', label: '使用' },
            ]}
          />
        </div>

        <div className="p-3 text-[13px]">
          {tab === 'info' && (
            <dl className="divide-y divide-line">
              <Row label="类型">{asset.source === 'upload' ? '上传' : gen ? TASK_TYPE_LABEL[gen.type as TaskType] : '生成'} · {asset.mime}</Row>
              {asset.width && asset.height ? <Row label="尺寸">{asset.width}×{asset.height}</Row> : null}
              {asset.duration ? <Row label="时长">{formatDuration(asset.duration)}</Row> : null}
              {asset.size ? <Row label="大小">{formatBytes(asset.size)}</Row> : null}
              {detail?.codec && <Row label="编码">{detail.codec}</Row>}
              <Row label="时间">{new Date(asset.createdAt).toLocaleString()}（{timeAgo(asset.createdAt)}）</Row>
              {detail?.folderPath.length ? <Row label="文件夹">{detail.folderPath.join(' / ')}</Row> : null}
              {detail?.story && (
                <Row label="故事">
                  <Link to={`/studio/stories/${detail.story.id}`} className="text-accent hover:underline">
                    {detail.story.title}
                  </Link>
                </Row>
              )}
              {detail?.task && <Row label="来源任务">{detail.task.title}</Row>}
              {trashed && <Row label="删除于">{timeAgo(asset.deletedAt!)}</Row>}
              {detail?.sha256 && (
                <Row label="SHA-256">
                  <button className="font-mono text-xs text-fg-3 hover:text-fg" onClick={() => void copy(detail.sha256!, '哈希')}>
                    {detail.sha256.slice(0, 12)}…
                  </button>
                </Row>
              )}
            </dl>
          )}

          {tab === 'params' && (
            <div className="space-y-3">
              <div>
                <div className="mb-1 flex items-center justify-between">
                  <p className="label !mb-0">提示词</p>
                  {asset.prompt && (
                    <button className="flex items-center gap-1 text-xs text-fg-3 hover:text-fg" onClick={() => void copy(asset.prompt!, '提示词')}>
                      <Copy className="size-3" /> 复制
                    </button>
                  )}
                </div>
                <p className="leading-relaxed whitespace-pre-wrap text-fg-2">{asset.prompt || '（没有提示词）'}</p>
              </div>
              {(gen?.negativePrompt || png?.negative) && (
                <div>
                  <p className="label">反向提示词</p>
                  <p className="text-fg-3">{gen?.negativePrompt || png?.negative}</p>
                </div>
              )}
              <dl className="divide-y divide-line">
                {(gen?.seed ?? png?.seed) != null && (
                  <Row label="种子">
                    <button className="font-mono hover:text-accent" onClick={() => void copy(String(gen?.seed ?? png?.seed), '种子')}>
                      {gen?.seed ?? png?.seed}
                    </button>
                  </Row>
                )}
                {gen?.width ? <Row label="提交尺寸">{gen.width}×{gen.height}</Row> : null}
                {gen?.steps ? <Row label="步数">{gen.steps}</Row> : null}
                {gen?.duration ? <Row label="视频时长">{gen.duration} 秒</Row> : null}
                {gen?.operator && <Row label="算子">{gen.operator}</Row>}
                {gen?.presets?.length ? <Row label="预设">{gen.presets.join('、')}</Row> : null}
                {png && <Row label="来源">PNG 内嵌参数（{png.keys?.join('、')}）</Row>}
              </dl>
              {!gen && !png && <p className="text-fg-3">这是上传的素材，没有生成参数。</p>}
            </div>
          )}

          {tab === 'organize' && (
            <div className="space-y-4">
              <div>
                <p className="label">评分</p>
                <div className="flex items-center gap-0.5">
                  {[1, 2, 3, 4, 5].map((n) => (
                    <button key={n} aria-label={`${n} 星`} onClick={() => void patch({ rating: asset.rating === n ? 0 : n })} className="p-1">
                      <Star className={cx('size-5', n <= asset.rating ? 'fill-warn text-warn' : 'text-fg-3')} />
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <p className="label">挑选</p>
                <div className="flex gap-1.5">
                  <button
                    onClick={() => void patch({ flag: asset.flag === 'pick' ? null : 'pick' })}
                    className={cx('chip', asset.flag === 'pick' && '!border-ok !text-ok')}
                  >
                    <ThumbsUp className="size-3.5" /> 挑选
                  </button>
                  <button
                    onClick={() => void patch({ flag: asset.flag === 'reject' ? null : 'reject' })}
                    className={cx('chip', asset.flag === 'reject' && '!border-danger !text-danger')}
                  >
                    <ThumbsDown className="size-3.5" /> 淘汰
                  </button>
                </div>
              </div>
              <div>
                <p className="label">文件夹</p>
                <button
                  className="chip"
                  onClick={async () => {
                    const target = await pickFolder({ title: '放进文件夹', folders });
                    if (target !== undefined) void patch({ folderId: target });
                  }}
                >
                  <Folder className="size-3.5" />
                  {asset.folderId ? folders.find((f) => f.id === asset.folderId)?.name ?? '文件夹' : '未归档'}
                </button>
              </div>
              <div>
                <p className="label">标签</p>
                <div className="flex flex-wrap gap-1.5">
                  {asset.tags.map((tag) => (
                    <span key={tag} className="chip">
                      #{tag}
                      <button aria-label={`移除标签 ${tag}`} onClick={() => void patch({ tags: asset.tags.filter((t) => t !== tag) })} className="text-fg-3 hover:text-fg">
                        <X className="size-3" />
                      </button>
                    </span>
                  ))}
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      addTag();
                    }}
                  >
                    <input className="field !h-7 !w-28 !py-0 text-xs" value={tagInput} onChange={(e) => setTagInput(e.target.value)} onBlur={addTag} placeholder="加标签，回车" maxLength={30} />
                  </form>
                </div>
              </div>
              <div>
                <p className="label">备注</p>
                <textarea
                  className="field min-h-20 text-[13px]"
                  value={note}
                  maxLength={2000}
                  placeholder="例如：第三集封面候选"
                  onChange={(e) => setNote(e.target.value)}
                  onBlur={() => note !== asset.note && void patch({ note })}
                />
              </div>
            </div>
          )}

          {tab === 'lineage' && (
            <div className="space-y-4">
              {!lineage ? (
                <p className="text-fg-3">加载中…</p>
              ) : (
                <>
                  <div>
                    <p className="label">来源</p>
                    {lineage.parents.length ? (
                      <div className="grid grid-cols-4 gap-1.5">
                        {lineage.parents.map((parent, index) => (
                          <Thumb key={parent.id} asset={parent} onClick={() => onNavigate(parent.id)} label={index === 0 ? (asset.lineage === 'frame' ? '截自' : '上一代') : `第 ${index + 1} 代`} />
                        ))}
                      </div>
                    ) : (
                      <p className="text-fg-3">原始素材，没有来源。</p>
                    )}
                  </div>
                  <div>
                    <p className="label">派生出的素材（{lineage.children.length}）</p>
                    {lineage.children.length ? (
                      <div className="grid grid-cols-4 gap-1.5">
                        {lineage.children.map((child) => (
                          <Thumb key={child.id} asset={child} onClick={() => onNavigate(child.id)} label={child.lineage === 'frame' ? '截帧' : undefined} />
                        ))}
                      </div>
                    ) : (
                      <p className="text-fg-3">还没有从它派生的素材。</p>
                    )}
                  </div>
                </>
              )}
            </div>
          )}

          {tab === 'usage' && (
            <div className="space-y-2">
              {!usage ? (
                <p className="text-fg-3">加载中…</p>
              ) : usage.activeTasks.length + usage.stories.length === 0 ? (
                <p className="text-fg-3">没有被故事或进行中的任务使用。</p>
              ) : (
                <ul className="space-y-1.5">
                  {usage.activeTasks.map((task) => (
                    <li key={task.id} className="rounded-lg border border-warn/40 bg-warn/5 px-2.5 py-2 text-fg-2">
                      进行中的任务：{task.title}
                    </li>
                  ))}
                  {usage.stories.map((ref, index) => (
                    <li key={`${ref.storyId}-${index}`} className="rounded-lg border border-line px-2.5 py-2">
                      <Link to={`/studio/stories/${ref.storyId}`} className="text-accent hover:underline">
                        {ref.title}
                      </Link>
                      <span className="text-fg-3"> · {ref.where}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}
