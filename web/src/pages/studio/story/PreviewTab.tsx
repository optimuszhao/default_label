import { useEffect, useMemo, useRef, useState } from 'react';
import { Clapperboard, Film, Image as ImageIcon, Pause, Play, SkipBack, SkipForward } from 'lucide-react';
import { Button, Empty, IconButton, isVideoAsset } from '../../../components/ui.tsx';
import { cssRatio } from '../../../lib/presets.ts';
import { cx, formatDuration } from '../../../lib/util.ts';
import { useShotGenerator, useStory } from './context.tsx';
import { dialogueFor, EMPTY_MEDIA, flattenShots } from './model.ts';

/**
 * 成片预览：按章节顺序串联所有镜头。
 * 有视频的镜头播放视频；只有关键帧的镜头以缓慢推镜效果展示关键帧；都没有则显示画面描述。
 */
export function PreviewTab() {
  const { data, media } = useStory();
  const generator = useShotGenerator();
  const shots = useMemo(() => flattenShots(data), [data]);
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const videoRef = useRef<HTMLVideoElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);

  const current = shots[Math.min(index, shots.length - 1)];
  const m = current ? media.get(current.shot.id) ?? EMPTY_MEDIA : EMPTY_MEDIA;
  const playableVideo = m.video && isVideoAsset(m.video) ? m.video : null;
  const still = playableVideo ? null : m.video ?? m.keyframe;
  const totalDuration = shots.reduce((sum, item) => sum + item.shot.duration, 0);
  const before = shots.slice(0, index).reduce((sum, item) => sum + item.shot.duration, 0);
  const stats = {
    keyframes: shots.filter((item) => media.get(item.shot.id)?.keyframe).length,
    videos: shots.filter((item) => media.get(item.shot.id)?.video).length,
  };

  // 非视频镜头按镜头时长计时推进
  useEffect(() => {
    setElapsed(0);
    if (!playing || !current || playableVideo) return;
    const start = performance.now();
    let frame = 0;
    const loop = (t: number) => {
      const seconds = (t - start) / 1000;
      setElapsed(seconds);
      if (seconds >= current.shot.duration) {
        setIndex((i) => (i + 1 < shots.length ? i + 1 : i));
        if (index + 1 >= shots.length) setPlaying(false);
        return;
      }
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [playing, index, current, playableVideo, shots.length]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (playing) void video.play().catch(() => undefined);
    else video.pause();
  }, [playing, playableVideo]);

  // 时间线自动滚动到当前镜头
  useEffect(() => {
    stripRef.current?.querySelector(`[data-index="${index}"]`)?.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
  }, [index]);

  if (!shots.length) {
    return <Empty icon={<Film className="size-6" />} title="还没有镜头" hint="在「分镜」里为场次设计镜头后，这里会按顺序串联成完整影片。" />;
  }

  const lines = current ? dialogueFor(current.scene, current.shot) : [];
  const progress = (before + (playableVideo ? elapsed : Math.min(elapsed, current.shot.duration))) / Math.max(1, totalDuration);
  const all = shots.map(({ scene, shot }) => ({ scene, shot }));

  return (
    <div className="space-y-4">
      <div className="mx-auto max-w-4xl">
        <div className="relative overflow-hidden rounded-2xl border border-line bg-black" style={{ aspectRatio: cssRatio(data.aspectRatio) }}>
          {playableVideo ? (
            <video
              key={playableVideo.id}
              ref={videoRef}
              src={playableVideo.url}
              className="size-full object-contain"
              playsInline
              autoPlay={playing}
              onTimeUpdate={(e) => setElapsed(e.currentTarget.currentTime)}
              onEnded={() => (index + 1 < shots.length ? setIndex(index + 1) : setPlaying(false))}
            />
          ) : still ? (
            <img
              key={`${still.id}-${index}`}
              src={still.url}
              alt=""
              className="size-full object-cover"
              style={{
                transform: playing ? 'scale(1.12)' : 'scale(1)',
                transition: playing ? `transform ${current.shot.duration}s linear` : 'transform 0.3s ease',
              }}
            />
          ) : (
            <div className="flex size-full flex-col items-center justify-center gap-3 bg-ink-2 p-8 text-center">
              <Clapperboard className="size-8 text-fg-3" />
              <p className="max-w-lg text-sm leading-relaxed text-fg-2">{current.shot.description || '（未填写画面描述）'}</p>
              <p className="text-xs text-fg-3">此镜头尚未生成</p>
            </div>
          )}
          <div className="pointer-events-none absolute top-3 left-3 rounded-full bg-black/55 px-2.5 py-1 text-[11px] backdrop-blur">
            {current.chapter.title} · {current.scene.title} · #{current.indexInScene + 1} {current.shot.shotSize}
          </div>
          {lines.length > 0 && (
            <div className="pointer-events-none absolute inset-x-0 bottom-6 flex flex-col items-center gap-1 px-6 text-center">
              {lines.map((line) => (
                <p key={line.id} className="rounded bg-black/55 px-2 py-0.5 text-sm text-white sm:text-base">
                  {data.characters.find((c) => c.id === line.characterId)?.name ?? ''}
                  {line.characterId ? '：' : ''}
                  {line.text}
                </p>
              ))}
            </div>
          )}
        </div>

        <div className="mt-3 h-1 overflow-hidden rounded-full bg-white/[0.06]">
          <div className="bg-brand h-full" style={{ width: `${Math.min(100, progress * 100)}%` }} />
        </div>
        <div className="mt-2 flex items-center gap-2">
          <IconButton label="上一个镜头" onClick={() => setIndex(Math.max(0, index - 1))}><SkipBack className="size-4" /></IconButton>
          <button
            onClick={() => setPlaying(!playing)}
            aria-label={playing ? '暂停' : '播放'}
            className="flex size-10 items-center justify-center rounded-full bg-fg text-ink transition active:scale-95"
          >
            {playing ? <Pause className="size-4 fill-current" /> : <Play className="size-4 fill-current" />}
          </button>
          <IconButton label="下一个镜头" onClick={() => setIndex(Math.min(shots.length - 1, index + 1))}><SkipForward className="size-4" /></IconButton>
          <span className="ml-2 font-mono text-xs text-fg-3">
            {formatDuration(before + elapsed)} / {formatDuration(totalDuration)}
          </span>
          <span className="ml-auto text-xs text-fg-3">
            镜头 {index + 1}/{shots.length}
          </span>
        </div>
      </div>

      <div ref={stripRef} className="no-scrollbar flex gap-2 overflow-x-auto pb-2">
        {shots.map((item, i) => {
          const sm = media.get(item.shot.id) ?? EMPTY_MEDIA;
          const thumb = sm.keyframe ?? (sm.video && !isVideoAsset(sm.video) ? sm.video : null);
          return (
            <button
              key={item.shot.id}
              data-index={i}
              onClick={() => setIndex(i)}
              className={cx('relative shrink-0 overflow-hidden rounded-lg border-2 bg-ink-3 transition', i === index ? 'border-violet' : 'border-transparent opacity-70 hover:opacity-100')}
              style={{ width: `${Math.max(64, item.shot.duration * 22)}px`, aspectRatio: undefined, height: 56 }}
            >
              {thumb ? <img src={thumb.url} alt="" loading="lazy" className="size-full object-cover" /> : <span className="flex size-full items-center justify-center text-[10px] text-fg-3">#{item.number}</span>}
              {sm.video && <Film className="absolute right-1 bottom-1 size-3 drop-shadow" />}
            </button>
          );
        })}
      </div>

      <div className="panel flex flex-wrap items-center justify-between gap-3 p-4">
        <div className="flex flex-wrap gap-x-5 gap-y-1 text-sm text-fg-2">
          <span>共 {shots.length} 个镜头 · {formatDuration(totalDuration)}</span>
          <span className="inline-flex items-center gap-1"><ImageIcon className="size-3.5" /> 关键帧 {stats.keyframes}/{shots.length}</span>
          <span className="inline-flex items-center gap-1"><Film className="size-3.5" /> 视频 {stats.videos}/{shots.length}</span>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" icon={<ImageIcon className="size-3.5" />} onClick={() => void generator.batchKeyframes(all)}>补齐全部关键帧</Button>
          <Button size="sm" variant="brand" icon={<Film className="size-3.5" />} onClick={() => void generator.batchVideos(all)}>补齐全部视频</Button>
        </div>
      </div>
    </div>
  );
}
