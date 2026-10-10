import { useEffect, useRef, useState } from 'react';
import { Check, ImageOff, Upload } from 'lucide-react';
import type { Asset } from '../../../shared/types.ts';
import { api } from '../lib/api.ts';
import { reportError, useStore } from '../lib/store.ts';
import { cx, readImageSize } from '../lib/util.ts';
import { Button, Empty, Media, Modal, Spinner } from './ui.tsx';

/** 上传本地图片并写入全局资产缓存 */
export function useUpload() {
  const upsertAssets = useStore((s) => s.upsertAssets);
  const [uploading, setUploading] = useState(false);
  async function upload(files: FileList | File[]): Promise<Asset[]> {
    setUploading(true);
    try {
      const results: Asset[] = [];
      for (const file of Array.from(files)) {
        results.push(await api.upload(file, await readImageSize(file)));
      }
      upsertAssets(results);
      return results;
    } catch (error) {
      reportError(error);
      return [];
    } finally {
      setUploading(false);
    }
  }
  return { upload, uploading };
}

export function AssetPicker({
  open,
  onClose,
  onPick,
  max = 1,
  title = '选择图片',
}: {
  open: boolean;
  onClose: () => void;
  onPick: (assets: Asset[]) => void;
  max?: number;
  title?: string;
}) {
  const [items, setItems] = useState<Asset[] | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const { upload, uploading } = useUpload();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setSelected([]);
    setItems(null);
    void api
      .assets({ kind: 'image', limit: 200 })
      .then(setItems)
      .catch((error) => {
        reportError(error);
        setItems([]);
      });
  }, [open]);

  function toggle(id: string) {
    setSelected((prev) => {
      if (prev.includes(id)) return prev.filter((item) => item !== id);
      if (max === 1) return [id];
      return prev.length >= max ? prev : [...prev, id];
    });
  }

  async function onFiles(files: FileList | null) {
    if (!files?.length) return;
    const uploaded = await upload(Array.from(files).slice(0, max));
    if (uploaded.length) {
      onPick(uploaded);
      onClose();
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={title} wide>
      <input ref={inputRef} type="file" accept="image/png,image/jpeg,image/webp" multiple={max > 1} hidden onChange={(e) => void onFiles(e.target.files)} />
      <button
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          void onFiles(e.dataTransfer.files);
        }}
        className="flex w-full flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-line-strong bg-white/[0.02] py-8 text-sm text-fg-2 transition hover:border-accent/60 hover:bg-accent/5"
      >
        {uploading ? <Spinner /> : <Upload className="size-6" />}
        <span>点击或拖拽上传本地图片</span>
        <span className="text-xs text-fg-3">PNG / JPG / WEBP，单张不超过 20MB</span>
      </button>

      <p className="mt-6 mb-3 text-sm text-fg-2">或从我的资产中选择{max > 1 ? `（最多 ${max} 张）` : ''}</p>
      {items === null ? (
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
          {Array.from({ length: 10 }, (_, i) => (
            <div key={i} className="skeleton aspect-square rounded-xl" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <Empty icon={<ImageOff className="size-6" />} title="还没有图片资产" hint="先上传一张，或去创作页生成图片" />
      ) : (
        <div className="grid max-h-[46dvh] grid-cols-3 gap-2 overflow-auto pr-1 sm:grid-cols-5">
          {items.map((asset) => {
            const index = selected.indexOf(asset.id);
            return (
              <button
                key={asset.id}
                onClick={() => toggle(asset.id)}
                className={cx(
                  'relative aspect-square overflow-hidden rounded-xl border-2 transition',
                  index >= 0 ? 'border-violet' : 'border-transparent hover:border-line-strong',
                )}
              >
                <Media asset={asset} />
                {index >= 0 && (
                  <span className="bg-brand absolute top-1.5 right-1.5 flex size-5 items-center justify-center rounded-full text-[11px] font-semibold text-white">
                    {max > 1 ? index + 1 : <Check className="size-3" />}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>取消</Button>
        <Button
          variant="primary"
          disabled={!selected.length}
          onClick={() => {
            onPick(selected.map((id) => items!.find((item) => item.id === id)!));
            onClose();
          }}
        >
          使用所选{selected.length ? `（${selected.length}）` : ''}
        </Button>
      </div>
    </Modal>
  );
}
