import { useEffect, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { Button } from '../../../components/ui.tsx';
import { api, type SeriesSummary } from '../../../lib/api.ts';
import { ASPECT_RATIOS, cssRatio } from '../../../lib/presets.ts';
import { reportError } from '../../../lib/store.ts';
import { DEFAULT_KEYFRAME_NEGATIVE, useStory } from './context.tsx';
import { confirmDialog } from '../../../components/ConfirmDialog.tsx';

const GENRES = ['科幻', '奇幻', '悬疑', '爱情', '武侠', '喜剧', '恐怖', '历史', '治愈', '动作'];
const STYLES = ['电影质感，写实光影，35mm 胶片颗粒', '日系动画，清新明亮，赛璐璐上色', '国风水墨，留白意境', '赛博朋克，霓虹高对比', '皮克斯 3D 动画风格', '黑白默片质感'];

/** 所属系列：选一个系列加入，或移出 */
function SeriesPicker({ seriesId, onChange }: { seriesId: string | null; onChange: (seriesId: string | null) => void }) {
  const { storyId } = useStory();
  const [list, setList] = useState<SeriesSummary[]>([]);
  useEffect(() => {
    void api.seriesList().then(setList).catch(() => undefined);
  }, []);
  return (
    <div>
      <label className="label">所属系列（多集共享画风和角色设定）</label>
      <select
        className="field"
        value={seriesId ?? ''}
        onChange={async (e) => {
          const next = e.target.value || null;
          try {
            await api.setStorySeries(storyId, next);
            onChange(next);
          } catch (error) {
            reportError(error);
          }
        }}
        aria-label="所属系列"
      >
        <option value="">不属于任何系列</option>
        {list.map((item) => (
          <option key={item.id} value={item.id}>
            {item.title}
          </option>
        ))}
      </select>
    </div>
  );
}

export function SetupTab({ title, onTitle, seriesId = null, onSeries }: { title: string; onTitle: (title: string) => void; seriesId?: string | null; onSeries?: (seriesId: string | null) => void }) {
  const { storyId, data, update, flushNow } = useStory();
  const [loading, setLoading] = useState(false);

  async function generateOutline() {
    if (data.outline.trim() && !(await confirmDialog({ title: '用 AI 生成的大纲替换当前内容？', message: '当前内容会先存进历史版本，可以恢复。' }))) return;
    setLoading(true);
    try {
      await flushNow?.();
      const result = await api.assist<{ title?: string; outline: string }>('outline', {
        storyId,
        title,
        logline: data.logline,
        genre: data.genre,
        tone: data.tone,
      });
      update((d) => ({ ...d, outline: result.outline }));
      if (result.title && (!title || title === '未命名故事')) onTitle(result.title);
    } catch (error) {
      reportError(error);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
      <section className="panel space-y-4 p-4 sm:p-5">
        <h2 className="font-medium">基础设定</h2>
        <div>
          <label className="label">一句话故事</label>
          <textarea
            className="field resize-none"
            rows={3}
            value={data.logline}
            onChange={(e) => update((d) => ({ ...d, logline: e.target.value }))}
            placeholder="用一句话说清：谁，在什么处境下，想要什么，遇到什么阻碍"
          />
        </div>
        <div>
          <label className="label">类型</label>
          <div className="flex flex-wrap gap-1.5">
            {GENRES.map((genre) => (
              <button key={genre} className="chip !h-7 !text-xs" data-active={data.genre === genre} onClick={() => update((d) => ({ ...d, genre: d.genre === genre ? '' : genre }))}>
                {genre}
              </button>
            ))}
          </div>
        </div>
        <div>
          <label className="label">基调</label>
          <input className="field" value={data.tone} onChange={(e) => update((d) => ({ ...d, tone: e.target.value }))} placeholder="例如：温暖而带着忧伤 / 紧张压抑 / 轻松幽默" />
        </div>
        <div>
          <label className="label">统一画风（会拼入所有分镜提示词，保持全片风格一致）</label>
          <textarea className="field resize-none" rows={2} value={data.visualStyle} onChange={(e) => update((d) => ({ ...d, visualStyle: e.target.value }))} />
          <div className="mt-2 flex flex-wrap gap-1.5">
            {STYLES.map((style) => (
              <button key={style} className="chip !h-7 !text-xs" data-active={data.visualStyle === style} onClick={() => update((d) => ({ ...d, visualStyle: style }))}>
                {style.split('，')[0]}
              </button>
            ))}
          </div>
        </div>
        <div>
          <label className="label">画面中要避免的内容（负向提示词，用于关键帧）</label>
          <input
            className="field"
            value={data.negativePrompt ?? ''}
            onChange={(e) => update((d) => ({ ...d, negativePrompt: e.target.value }))}
            placeholder={DEFAULT_KEYFRAME_NEGATIVE}
          />
        </div>
        <div>
          <label className="label">画面比例</label>
          <div className="flex flex-wrap gap-1.5">
            {ASPECT_RATIOS.map((ratio) => (
              <button key={ratio} className="chip" data-active={data.aspectRatio === ratio} onClick={() => update((d) => ({ ...d, aspectRatio: ratio }))}>
                <span className="inline-block rounded-[2px] border border-current" style={{ aspectRatio: cssRatio(ratio), height: 10 }} />
                {ratio}
              </button>
            ))}
          </div>
        </div>
        {onSeries && <SeriesPicker seriesId={seriesId} onChange={onSeries} />}
      </section>

      <section className="panel flex flex-col p-4 sm:p-5">
        <div className="mb-3 flex items-center justify-between gap-2">
          <div>
            <h2 className="font-medium">故事大纲</h2>
            <p className="text-xs text-fg-3">世界观、主要冲突、起承转合与结局</p>
          </div>
          <Button size="sm" variant="brand" icon={<Sparkles className="size-3.5" />} loading={loading} onClick={() => void generateOutline()}>
            AI 生成大纲
          </Button>
        </div>
        <textarea
          className="field min-h-[22rem] flex-1 resize-y leading-relaxed"
          value={data.outline}
          onChange={(e) => update((d) => ({ ...d, outline: e.target.value }))}
          placeholder="在这里写下故事大纲，或者先填好一句话故事，点击「AI 生成大纲」。"
        />
        <p className="mt-2 text-right text-xs text-fg-3">{data.outline.length} 字</p>
      </section>
    </div>
  );
}
