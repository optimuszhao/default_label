import { useNavigate } from 'react-router-dom';
import { Clapperboard, Download, Heart, ImagePlus, Trash2, X } from 'lucide-react';
import type { Asset } from '../../../shared/types.ts';
import { api } from '../lib/api.ts';
import { reportError, useStore } from '../lib/store.ts';
import { cx, downloadUrl, timeAgo } from '../lib/util.ts';
import { Button, IconButton, Media, Modal, isVideoAsset } from './ui.tsx';

export function useReuseAsset() {
  const navigate = useNavigate();
  const setDraft = useStore((s) => s.setComposerDraft);
  return {
    toImage: (asset: Asset) => {
      setDraft({ mode: 'image', referenceAssetIds: [asset.id], prompt: asset.prompt ?? '' });
      navigate('/studio/create');
    },
    toVideo: (asset: Asset) => {
      setDraft({ mode: 'video', firstFrameAssetId: asset.id, prompt: asset.prompt ?? '' });
      navigate('/studio/create');
    },
  };
}

export function fileName(asset: Asset): string {
  const ext = asset.mime.split('/')[1]?.replace('svg+xml', 'svg') ?? 'bin';
  return `weave-${asset.id}.${ext}`;
}

export function Lightbox({
  asset,
  onClose,
  onDeleted,
}: {
  asset: Asset | null;
  onClose: () => void;
  onDeleted?: (id: string) => void;
}) {
  const upsertAssets = useStore((s) => s.upsertAssets);
  const removeAsset = useStore((s) => s.removeAsset);
  const reuse = useReuseAsset();
  if (!asset) return null;
  const isVideo = isVideoAsset(asset);

  async function toggleFavorite() {
    try {
      upsertAssets([await api.favorite(asset!.id, !asset!.favorite)]);
    } catch (error) {
      reportError(error);
    }
  }

  async function remove() {
    if (!confirm('确定删除这个素材吗？删除后无法恢复。')) return;
    try {
      await api.deleteAsset(asset!.id);
      removeAsset(asset!.id);
      onDeleted?.(asset!.id);
      onClose();
    } catch (error) {
      reportError(error);
    }
  }

  return (
    <Modal open onClose={onClose} wide bare>
      <div className="panel overflow-hidden rounded-b-none bg-ink-1 sm:rounded-[1.25rem]">
        <div className="relative flex max-h-[68dvh] items-center justify-center bg-black">
          <Media asset={asset} fit="contain" controls={isVideo} autoPlay={isVideo} className="max-h-[68dvh]" />
          <IconButton label="关闭" onClick={onClose} className="glass absolute top-3 right-3">
            <X className="size-4" />
          </IconButton>
        </div>
        <div className="flex flex-col gap-4 p-4 sm:flex-row sm:items-center sm:p-5">
          <div className="min-w-0 flex-1">
            <p className="line-clamp-2 text-sm text-fg-2">{asset.prompt || (asset.source === 'upload' ? '上传的素材' : '无提示词')}</p>
            <p className="mt-1 text-xs text-fg-3">
              {asset.width && asset.height ? `${asset.width}×${asset.height} · ` : ''}
              {timeAgo(asset.createdAt)}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {!isVideo && (
              <>
                <Button size="sm" icon={<ImagePlus className="size-4" />} onClick={() => reuse.toImage(asset)}>
                  图生图
                </Button>
                <Button size="sm" icon={<Clapperboard className="size-4" />} onClick={() => reuse.toVideo(asset)}>
                  图生视频
                </Button>
              </>
            )}
            <IconButton label={asset.favorite ? '取消收藏' : '收藏'} onClick={() => void toggleFavorite()}>
              <Heart className={cx('size-4', asset.favorite && 'fill-pink text-pink')} />
            </IconButton>
            <IconButton label="下载" onClick={() => downloadUrl(asset.url, fileName(asset))}>
              <Download className="size-4" />
            </IconButton>
            <IconButton label="删除" onClick={() => void remove()} className="hover:text-danger">
              <Trash2 className="size-4" />
            </IconButton>
          </div>
        </div>
      </div>
    </Modal>
  );
}
