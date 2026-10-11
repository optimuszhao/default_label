// 配音与成片（EXP-03 / EXP-08）：一键配音（没配 TTS 时是模拟配音）、选配乐、试算后渲染成片、成片版本列表
import { useCallback, useEffect, useState } from 'react';
import { Download, Film, Mic, Music, X } from 'lucide-react';
import type { Asset, Job } from '../../../../../shared/types.ts';
import { AssetPicker } from '../../../components/AssetPicker.tsx';
import { Button, IconButton, Media, Modal, ProgressBar, Toggle } from '../../../components/ui.tsx';
import { api, type FilmPlan } from '../../../lib/api.ts';
import { reportError, useStore } from '../../../lib/store.ts';
import { downloadUrl, formatDuration, timeAgo } from '../../../lib/util.ts';
import { useStory } from './context.tsx';

function useJob(id: string | null): Job | null {
  const job = useStore((s) => (id ? s.jobs[id] : undefined));
  const [fetched, setFetched] = useState<Job | null>(null);
  useEffect(() => {
    if (!id) return setFetched(null);
    void api.job(id).then(setFetched).catch(() => undefined);
  }, [id]);
  return job ?? fetched;
}

const running = (job: Job | null) => Boolean(job && (job.status === 'queued' || job.status === 'running'));

export function FilmPanel({ musicId, setMusicId, music }: { musicId: string | null; setMusicId: (id: string | null) => void; music: Asset | null }) {
  const { storyId, data, flushNow } = useStory();
  const [tts, setTts] = useState<'api' | 'mock' | null>(null);
  const [voiceJobId, setVoiceJobId] = useState<string | null>(null);
  const [filmJobId, setFilmJobId] = useState<string | null>(null);
  const [films, setFilms] = useState<Asset[]>([]);
  const [dialog, setDialog] = useState(false);
  const [pickingMusic, setPickingMusic] = useState(false);
  const voiceJob = useJob(voiceJobId);
  const filmJob = useJob(filmJobId);

  const loadFilms = useCallback(() => void api.films(storyId).then(setFilms).catch(() => undefined), [storyId]);
  useEffect(() => {
    loadFilms();
    void api.ttsMode().then((r) => setTts(r.mode)).catch(() => undefined);
  }, [loadFilms]);
  useEffect(() => {
    if (filmJob?.status === 'succeeded') {
      loadFilms();
      useStore.getState().toast(`成片 v${String(filmJob.result?.version ?? '')} 渲染完成`, 'success');
    }
    if (filmJob?.status === 'failed') useStore.getState().toast(`成片渲染失败：${filmJob.error ?? ''}`, 'error');
  }, [filmJob?.status, filmJob?.result, filmJob?.error, loadFilms]);
  useEffect(() => {
    if (voiceJob?.status === 'succeeded') useStore.getState().toast(`已为 ${String(voiceJob.result?.count ?? 0)} 句台词配音`, 'success');
    if (voiceJob?.status === 'failed') useStore.getState().toast(`配音失败：${voiceJob.error ?? ''}`, 'error');
  }, [voiceJob?.status, voiceJob?.result, voiceJob?.error]);

  const lines = data.chapters.flatMap((c) => c.scenes.flatMap((s) => s.dialogue)).filter((l) => l.kind !== 'caption' && l.text.trim());
  const voiced = lines.filter((l) => l.voiceAssetId).length;

  async function voice(overwrite: boolean) {
    try {
      await flushNow?.();
      const started = await api.voiceLines(storyId, { overwrite });
      setVoiceJobId(started.job.id);
    } catch (error) {
      reportError(error);
    }
  }

  return (
    <section className="panel space-y-4 p-4" aria-label="配音与成片">
      <div className="flex flex-wrap items-center gap-2">
        <Mic className="size-4 text-accent" />
        <h3 className="text-sm font-semibold">配音</h3>
        <span className="text-xs text-fg-3">
          {voiced}/{lines.length} 句已配音
        </span>
        {tts === 'mock' && <span className="rounded-full bg-white/[0.06] px-2 py-0.5 text-[11px] text-fg-3" title="服务器没有配置 TTS_API_BASE，用提示音模拟配音，只用来走通流程">模拟配音</span>}
        <span className="flex-1" />
        {running(voiceJob) ? (
          <span className="flex items-center gap-2 text-xs text-fg-3">
            {voiceJob?.stage ?? '排队中'}
            <ProgressBar value={voiceJob?.progress ?? 0} className="w-24" />
          </span>
        ) : (
          <>
            {voiced > 0 && (
              <Button size="sm" variant="ghost" onClick={() => void voice(true)}>
                全部重配
              </Button>
            )}
            <Button size="sm" icon={<Mic className="size-3.5" />} disabled={!lines.length || voiced === lines.length} onClick={() => void voice(false)}>
              {voiced ? '补齐配音' : '一键配音'}
            </Button>
          </>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
        <Music className="size-4 text-accent" />
        <h3 className="text-sm font-semibold">配乐</h3>
        <span className="min-w-0 truncate text-xs text-fg-3">{music ? (music.filename ?? music.prompt ?? '已选择') : '未选择（预览和成片都不加配乐）'}</span>
        <span className="flex-1" />
        {music && (
          <IconButton label="去掉配乐" onClick={() => setMusicId(null)}>
            <X className="size-3.5" />
          </IconButton>
        )}
        <Button size="sm" variant="ghost" onClick={() => setPickingMusic(true)}>
          {music ? '更换' : '选择配乐'}
        </Button>
        <AssetPicker open={pickingMusic} onClose={() => setPickingMusic(false)} title="选择配乐" kinds={['audio']} storyId={storyId} onPick={([asset]) => setMusicId(asset.id)} />
      </div>

      <div className="border-t border-line pt-4">
        <div className="flex flex-wrap items-center gap-2">
          <Film className="size-4 text-accent" />
          <h3 className="text-sm font-semibold">成片</h3>
          <span className="text-xs text-fg-3">{films.length ? `${films.length} 个版本` : '还没有渲染过'}</span>
          <span className="flex-1" />
          {running(filmJob) ? (
            <span className="flex items-center gap-2 text-xs text-fg-3">
              {filmJob?.stage ?? '排队中'} {Math.round((filmJob?.progress ?? 0) * 100)}%
              <ProgressBar value={filmJob?.progress ?? 0} className="w-28" />
              <Button size="sm" variant="ghost" onClick={() => void api.cancelJob(filmJobId!).catch(reportError)}>
                取消
              </Button>
            </span>
          ) : (
            <Button size="sm" variant="brand" icon={<Film className="size-3.5" />} onClick={() => setDialog(true)}>
              渲染成片
            </Button>
          )}
        </div>
        {films.length > 0 && (
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            {films.slice(0, 4).map((film, i) => (
              <div key={film.id} className="overflow-hidden rounded-lg border border-line">
                <Media asset={film} controls fit="contain" className="aspect-video bg-black" />
                <div className="flex items-center gap-2 px-3 py-2 text-xs">
                  <span className="font-medium">v{films.length - i}</span>
                  <span className="text-fg-3">
                    {formatDuration(film.duration ?? 0)} · {timeAgo(film.createdAt)}
                  </span>
                  <span className="flex-1" />
                  <IconButton label="下载成片" onClick={() => downloadUrl(`${film.url}?download=1`, film.filename ?? 'film.mp4')}>
                    <Download className="size-3.5" />
                  </IconButton>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <RenderDialog open={dialog} onClose={() => setDialog(false)} musicId={musicId} onStarted={(job) => (setFilmJobId(job.id), setDialog(false))} />
    </section>
  );
}

function RenderDialog({ open, onClose, musicId, onStarted }: { open: boolean; onClose: () => void; musicId: string | null; onStarted: (job: Job) => void }) {
  const { storyId, flushNow } = useStory();
  const [stills, setStills] = useState(true);
  const [voice, setVoice] = useState(true);
  const [plan, setPlan] = useState<FilmPlan | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    setPlan(null);
    void (async () => {
      await flushNow?.();
      setPlan(await api.filmPlan(storyId, { stills, voice, musicAssetId: musicId }));
    })().catch(reportError);
  }, [open, stills, voice, musicId, storyId, flushNow]);

  async function start() {
    setBusy(true);
    try {
      const result = await api.renderFilm(storyId, { stills, voice, musicAssetId: musicId });
      onStarted(result.job);
    } catch (error) {
      reportError(error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="渲染成片">
      <div className="space-y-3 text-sm">
        <label className="flex items-center justify-between gap-3">
          <span>
            没有视频的镜头用关键帧补位
            <span className="block text-xs text-fg-3">关闭则跳过这些镜头</span>
          </span>
          <Toggle checked={stills} onChange={setStills} label="静帧补位" />
        </label>
        <label className="flex items-center justify-between gap-3">
          <span>混入台词配音</span>
          <Toggle checked={voice} onChange={setVoice} label="混入配音" />
        </label>
        <div className="rounded-lg border border-line bg-white/[0.02] p-3 text-xs leading-6 text-fg-2" aria-live="polite">
          {!plan ? (
            '正在试算…'
          ) : !plan.ffmpeg ? (
            <span className="text-danger">服务器没有安装 ffmpeg，不能渲染成片。Docker 部署时设置 WITH_FFMPEG=1 重新构建镜像。</span>
          ) : (
            <>
              <p>
                {plan.clips} 段{plan.stills ? `（其中 ${plan.stills} 段静帧）` : ''} · 约 {formatDuration(plan.duration)} · {plan.voices} 句配音{musicId ? ' · 配乐' : ''}
              </p>
              {plan.missing.length > 0 && <p className="text-warn">{plan.missing.length} 个镜头没有画面，会被跳过：#{plan.missing.slice(0, 8).map((m) => m.code || m.number).join('、#')}</p>}
              <p>
                {plan.mode === 'copy' ? '所有片段规格一致：无损拼接，几秒完成。' : `片段规格不一致或有裁剪、静帧：统一重编码为 720p H.264，预计约 ${formatDuration(plan.estimateSeconds)}。`}
              </p>
              <p className="text-fg-3">产物会存为「成片 v{plan.version}」，写入 AI 生成标识。</p>
            </>
          )}
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button variant="brand" loading={busy} disabled={!plan?.ffmpeg || !plan.clips} onClick={() => void start()}>
            开始渲染
          </Button>
        </div>
      </div>
    </Modal>
  );
}
