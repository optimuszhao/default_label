// 兼容旧调用：资产页、故事页仍然用 Lightbox，内部就是新的 AssetViewer
import type { Asset } from '../../../shared/types.ts';
import { useStore } from '../lib/store.ts';
import { useNavigate } from 'react-router-dom';
import { AssetViewer } from './AssetViewer.tsx';

export { fileName } from './AssetViewer.tsx';

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

export function Lightbox({ asset, onClose, onDeleted, list }: { asset: Asset | null; onClose: () => void; onDeleted?: (id: string) => void; list?: Asset[] }) {
  if (!asset) return null;
  return <AssetViewer asset={asset} onClose={onClose} onDeleted={onDeleted} list={list} />;
}
