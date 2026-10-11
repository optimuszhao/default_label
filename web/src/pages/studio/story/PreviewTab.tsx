// 成片预览 v2（EXP-02）：两个 <video> 交替双缓冲（下一段提前加载，切换无黑屏），按裁剪点播放；
// 字幕轨、配音轨（按时间线顺序朗读）、配乐轨；I / O 设入点出点；M 加审片备注、R 标记待返工（STY-15）；
// 下方是配音和成片渲染面板（EXP-03 / EXP-08）。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Captions, Clapperboard, Film, Flag, Image as ImageIcon, MessageSquarePlus, Music, Pause, Play, Scissors, SkipBack, SkipForward, Volume2, VolumeX } from 'lucide-react';
import { buildTimeline, VOICE_GAP, VOICE_LEAD } from '../../../../../shared/film.ts';
import type { Asset } from '../../../../../shared/types.ts';
import { promptDialog } from '../../../components/ConfirmDialog.tsx';
import { Button, Empty, IconButton, isVideoAsset } from '../../../components/ui.tsx';
import { api, type StoryNote } from '../../../lib/api.ts';
import { cssRatio } from '../../../lib/presets.ts';
import { reportError, useStore } from '../../../lib/store.ts';
import { cx, formatDuration } from '../../../lib/util.ts';
import { useShotGenerator, useStory } from './context.tsx';
import { FilmPanel } from './FilmPanel.tsx';
import { EMPTY_MEDIA, flattenShots, updateShot } from './model.ts';
import { NotesPanel } from './NotesPanel.tsx';

/** 按 id 取素材，缺的从服务端补（配音、配乐不一定在故事素材列表里） */
export function useAssetsById(ids: (string | null | undefined)[]): Map<string, Asset> {
  const assets = useStore((s) => s.assets);
  const upsertAssets = useStore((s) => s.upsertAssets);
  const key = ids.filter(Boolean).join(',');
  useEffect(() => {
    const missing = key ? key.split(',').filter((id) => !useStore.getState().assets[id]) : [];
    if (missing.length)
      void Promise.all(missing.map((id) => api.asset(id).catch(() => null))).then((list) => upsertAssets(list.filter((a): a is Asset => Boolean(a))));
  }, [key, upsertAssets]);
  return useMemo(() => new Map(key ? key.split(',').flatMap((id) => (assets[id] ? [[id, assets[id]] as const] : [])) : []), [key, assets]);
}

function useLocal<T>(key: string, initial: T): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw ? (JSON.parse(raw) as T) : initial;
    } catch {
      return initial;
    }
  });
  const set = useCallback(
    (next: T) => {
      setValue(next);
      try {
        localStorage.setItem(key, JSON.stringify(next));
      } catch {
        // 隐私模式下存不了，只在本次会话生效
      }
    },
    [key],
  );
  return [value, set];
}

export function PreviewTab() {
  const { storyId, data, media, update } = useStory();
  const generator = useShotGenerator();
  const flat = useMemo(() => flattenShots(data), [data]);
  const videoOf = useCallback((shotId: string) => {
    const video = media.get(shotId)?.video;
    return video && isVideoAsset(video) ? video : null;
  }, [media]);
  const timeline = useMemo(() => buildTimeline(data, (shotId) => videoOf(shotId)?.duration), [data, videoOf]);
  const total = timeline.length ? timeline[timeline.length - 1].start + timeline[timeline.length - 1].length : 0;

  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [clipTime, setClipTime] = useState(0);
  const [subtitles, setSubtitles] = useLocal('weave:preview:subtitles', true);
  const [voiceOn, setVoiceOn] = useLocal('weave:preview:voice', true);
  const [musicId, setMusicId] = useLocal<string | null>(`weave:preview:music:${storyId}`, null);
  const [notes, setNotes] = useState<StoryNote[]>([]);
  const stripRef = useRef<HTMLDivElement>(null);
  const videoRefs = [useRef<HTMLVideoElement>(null), useRef<HTMLVideoElement>(null)];
  const voiceRef = useRef<HTMLAudioElement>(null);
  const musicRef = useRef<HTMLAudioElement>(null);
  const pendingSeek = useRef<number | null>(null);

  const safeIndex = Math.min(index, Math.max(0, flat.length - 1));
  const current = flat[safeIndex];
  const clip = timeline[safeIndex];
  const currentVideo = current ? videoOf(current.shot.id) : null;
  const m = current ? (media.get(current.shot.id) ?? EMPTY_MEDIA) : EMPTY_MEDIA;
  const still = currentVideo ? null : (m.video ?? m.keyframe);
  const voiceAssets = useAssetsById([...timeline.flatMap((c) => c.lines.map((l) => l.voiceAssetId)), musicId]);
  const music = musicId ? voiceAssets.get(musicId) : undefined;

  useEffect(() => {
    void api.storyNotes(storyId).then(setNotes).catch(() => undefined);
  }, [storyId]);

  // ---- 双缓冲：当前段放在一个 <video> 里，下一段（有视频的话）提前加载到另一个 ----
  const [slots, setSlots] = useState<[number | null, number | null]>([null, null]);
  const front = slots[0] === safeIndex ? 0 : slots[1] === safeIndex ? 1 : -1;
  useEffect(() => {
    const hasVideo = (i: number) => Boolean(flat[i] && videoOf(flat[i].shot.id));
    const preload = hasVideo(safeIndex + 1) ? safeIndex + 1 : null;
    setSlots((prev) => {
      const out: [number | null, number | null] = [...prev];
      let f = prev[0] === safeIndex ? 0 : prev[1] === safeIndex ? 1 : -1;
      if (f === -1 && hasVideo(safeIndex)) {
        f = prev[0] === preload ? 1 : 0;
        out[f] = safeIndex;
      }
      const back = f === -1 ? 0 : 1 - f;
      if (preload != null && out[0] !== preload && out[1] !== preload) out[back] = preload;
      return out[0] === prev[0] && out[1] === prev[1] ? prev : out;
    });
  }, [safeIndex, flat, videoOf]);

  const advance = useCallback(() => {
    if (safeIndex + 1 < flat.length) setIndex(safeIndex + 1);
    else setPlaying(false);
  }, [safeIndex, flat.length]);

  // 切到新的一段：从入点开始；只有当前那个 <video> 播放
  useEffect(() => {
    setClipTime(pendingSeek.current ?? 0);
    videoRefs.forEach((ref, i) => {
      const el = ref.current;
      if (!el) return;
      if (i === front) {
        const target = (clip?.trimIn ?? 0) + (pendingSeek.current ?? 0);
        if (Math.abs(el.currentTime - target) > 0.05) el.currentTime = target;
        if (playing) void el.play().catch(() => undefined);
        else el.pause();
      } else el.pause();
    });
    pendingSeek.current = null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [safeIndex, front]);

  useEffect(() => {
    const el = front >= 0 ? videoRefs[front].current : null;
    if (!el) return;
    if (playing) void el.play().catch(() => undefined);
    else el.pause();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing]);

  // 没有视频的镜头：按镜头时长计时
  useEffect(() => {
    if (!playing || !clip || currentVideo) return;
    const begin = performance.now() - clipTime * 1000;
    let frame = 0;
    const loop = (t: number) => {
      const seconds = (t - begin) / 1000;
      setClipTime(seconds);
      if (seconds >= clip.length) return advance();
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, safeIndex, currentVideo, advance]);

  // ---- 配音轨：进入一段后按顺序读这段的台词 ----
  useEffect(() => {
    const audio = voiceRef.current;
    if (!audio || !playing || !voiceOn || !clip) return;
    const queue = clip.lines.map((l) => (l.voiceAssetId ? voiceAssets.get(l.voiceAssetId)?.url : undefined)).filter((url): url is string => Boolean(url));
    if (!queue.length) return;
    let cancelled = false;
    let timer = 0;
    let i = 0;
    const next = () => {
      if (cancelled || i >= queue.length) return;
      audio.src = queue[i++];
      void audio.play().catch(() => undefined);
    };
    const onEnded = () => (timer = window.setTimeout(next, VOICE_GAP * 1000));
    audio.addEventListener('ended', onEnded);
    timer = window.setTimeout(next, Math.max(0, VOICE_LEAD - clipTime) * 1000);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      audio.removeEventListener('ended', onEnded);
      audio.pause();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, voiceOn, safeIndex, voiceAssets]);

  // ---- 配乐轨 ----
  useEffect(() => {
    const audio = musicRef.current;
    if (!audio || !music) return;
    audio.volume = 0.25;
    if (playing) void audio.play().catch(() => undefined);
    else audio.pause();
  }, [playing, music]);

  useEffect(() => {
    stripRef.current?.querySelector(`[data-index="${safeIndex}"]`)?.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
  }, [safeIndex]);

  const elapsed = (clip?.start ?? 0) + Math.min(clipTime, clip?.length ?? 0);

  function seek(seconds: number) {
    const target = timeline.findIndex((c) => seconds < c.start + c.length);
    const i = target === -1 ? timeline.length - 1 : target;
    const offset = Math.max(0, seconds - timeline[i].start);
    if (i === safeIndex) {
      const el = front >= 0 ? videoRefs[front].current : null;
      if (el) el.currentTime = (clip?.trimIn ?? 0) + offset;
      setClipTime(offset);
    } else {
      pendingSeek.current = offset;
      setIndex(i);
    }
  }

  // ---- 裁剪点 ----
  function setTrim(which: 'in' | 'out' | 'clear') {
    if (!current || !currentVideo) return;
    const el = front >= 0 ? videoRefs[front].current : null;
    const at = Math.round((el?.currentTime ?? 0) * 10) / 10;
    const patch =
      which === 'clear'
        ? { trimIn: undefined, trimOut: undefined }
        : which === 'in'
          ? { trimIn: Math.min(at, (current.shot.trimOut ?? Infinity) - 0.2) }
          : { trimOut: Math.max(at, (current.shot.trimIn ?? 0) + 0.2) };
    update(updateShot(current.scene.id, current.shot.id, patch));
  }

  // ---- 审片：M 加备注，R 标记待返工 ----
  async function addNote() {
    if (!current) return;
    const wasPlaying = playing;
    setPlaying(false);
    const text = await promptDialog({ title: `审片备注 · ${formatDuration(elapsed)} · 镜头 ${safeIndex + 1}`, placeholder: '这里要改什么？', multiline: true, maxLength: 2000, confirmText: '添加' });
    if (text?.trim()) {
      try {
        const note = await api.addStoryNote(storyId, { shotId: current.shot.id, atSec: Math.round(elapsed * 10) / 10, text: text.trim() });
        setNotes((list) => [...list, note]);
      } catch (error) {
        reportError(error);
      }
    }
    if (wasPlaying) setPlaying(true);
  }

  function toggleRedo() {
    if (!current) return;
    const redo = current.shot.review === 'redo';
    update(updateShot(current.scene.id, current.shot.id, { review: redo ? null : 'redo' }));
    useStore.getState().toast(redo ? `镜头 ${safeIndex + 1} 取消待返工` : `镜头 ${safeIndex + 1} 标记为待返工`, 'info');
  }

  const keys = useRef({ addNote, toggleRedo, setTrim, advance });
  keys.current = { addNote, toggleRedo, setTrim, advance };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (event.metaKey || event.ctrlKey || event.altKey || target?.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]')) return;
      const key = event.key.toLowerCase();
      if (key === ' ') setPlaying((p) => !p);
      else if (key === 'arrowright') setIndex((i) => Math.min(flat.length - 1, i + 1));
      else if (key === 'arrowleft') setIndex((i) => Math.max(0, i - 1));
      else if (key === 'm') void keys.current.addNote();
      else if (key === 'r') keys.current.toggleRedo();
      else if (key === 'i') keys.current.setTrim('in');
      else if (key === 'o') keys.current.setTrim('out');
      else return;
      event.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [flat.length]);

  if (!flat.length || !current || !clip) {
    return <Empty icon={<Film className="size-6" />} title="还没有镜头" hint="在「分镜」里为场次设计镜头后，这里会按顺序串联成完整影片。" />;
  }

  const stats = {
    keyframes: flat.filter((item) => media.get(item.shot.id)?.keyframe).length,
    videos: flat.filter((item) => media.get(item.shot.id)?.video).length,
  };
  const openNotes = notes.filter((n) => !n.resolved);

  return (
    <div className="space-y-4">
      <div className="mx-auto max-w-4xl">
        <div className="relative overflow-hidden rounded-xl border border-line bg-black" style={{ aspectRatio: cssRatio(data.aspectRatio) }} data-testid="preview-stage">
          {/* 两个视频交替：当前段在上层，下一段在下层提前加载 */}
          {slots.map((slot, i) => {
            const item = slot != null ? flat[slot] : null;
            const asset = item ? videoOf(item.shot.id) : null;
            return asset ? (
              <video
                key={i}
                ref={videoRefs[i]}
                src={asset.url}
                preload="auto"
                playsInline
                muted={false}
                className={cx('absolute inset-0 size-full object-contain transition-opacity duration-75', front === i && currentVideo ? 'opacity-100' : 'opacity-0')}
                data-active={front === i ? 'true' : undefined}
                onLoadedMetadata={(e) => {
                  if (slot != null) e.currentTarget.currentTime = timeline[slot]?.trimIn ?? 0;
                }}
                onTimeUpdate={(e) => {
                  if (front !== i || slot == null) return;
                  const c = timeline[slot];
                  const t = e.currentTarget.currentTime;
                  setClipTime(Math.max(0, t - c.trimIn));
                  if (c.trimOut != null && t >= c.trimOut && playing) advance();
                }}
                onEnded={() => front === i && playing && advance()}
              />
            ) : null;
          })}
          {!currentVideo &&
            (still ? (
              <img
                key={`${still.id}-${safeIndex}`}
                src={still.url}
                alt=""
                className="absolute inset-0 size-full object-cover"
                style={{ transform: playing ? 'scale(1.12)' : 'scale(1)', transition: playing ? `transform ${clip.length}s linear` : 'transform 0.3s ease' }}
              />
            ) : (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-ink-2 p-8 text-center">
                <Clapperboard className="size-8 text-fg-3" />
                <p className="max-w-lg text-sm leading-relaxed text-fg-2">{current.shot.description || '（未填写画面描述）'}</p>
                <p className="text-xs text-fg-3">此镜头尚未生成</p>
              </div>
            ))}
          <div className="pointer-events-none absolute top-3 left-3 flex gap-1.5">
            <span className="rounded-full bg-black/55 px-2.5 py-1 text-[11px] backdrop-blur">
              {current.chapter.title} · {current.scene.title} · #{current.indexInScene + 1} {current.shot.shotSize}
            </span>
            {current.shot.review === 'redo' && <span className="rounded-full bg-warn/90 px-2 py-1 text-[11px] font-medium text-ink">待返工</span>}
          </div>
          {subtitles && clip.lines.length > 0 && (
            <div className="pointer-events-none absolute inset-x-0 bottom-6 flex flex-col items-center gap-1 px-6 text-center" data-testid="subtitles">
              {clip.lines.map((line) => (
                <p key={line.id} className="rounded bg-black/55 px-2 py-0.5 text-sm text-white sm:text-base">
                  {data.characters.find((c) => c.id === line.characterId)?.name ?? ''}
                  {line.characterId ? '：' : ''}
                  {line.text}
                </p>
              ))}
            </div>
          )}
          <audio ref={voiceRef} className="hidden" />
          {music && <audio ref={musicRef} src={music.url} loop className="hidden" />}
        </div>

        {/* 进度条：可点击跳转，黄点是未解决的审片备注 */}
        <div
          className="relative mt-3 h-2 cursor-pointer rounded-full bg-white/[0.06]"
          role="slider"
          aria-label="播放进度"
          aria-valuemin={0}
          aria-valuemax={Math.round(total)}
          aria-valuenow={Math.round(elapsed)}
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            seek(((e.clientX - rect.left) / rect.width) * total);
          }}
        >
          <div className="bg-brand h-full rounded-full" style={{ width: `${Math.min(100, (elapsed / Math.max(0.1, total)) * 100)}%` }} />
          {openNotes.map((note) =>
            note.atSec != null ? <span key={note.id} title={note.text} className="absolute top-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-warn" style={{ left: `${Math.min(100, (note.atSec / Math.max(0.1, total)) * 100)}%` }} /> : null,
          )}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <IconButton label="上一个镜头" onClick={() => setIndex(Math.max(0, safeIndex - 1))}>
            <SkipBack className="size-4" />
          </IconButton>
          <button onClick={() => setPlaying(!playing)} aria-label={playing ? '暂停' : '播放'} className="flex size-10 items-center justify-center rounded-full bg-fg text-ink transition active:scale-95">
            {playing ? <Pause className="size-4 fill-current" /> : <Play className="size-4 fill-current" />}
          </button>
          <IconButton label="下一个镜头" onClick={() => setIndex(Math.min(flat.length - 1, safeIndex + 1))}>
            <SkipForward className="size-4" />
          </IconButton>
          <span className="ml-1 font-mono text-xs text-fg-3">
            {formatDuration(elapsed)} / {formatDuration(total)}
          </span>
          <span className="flex-1" />
          <IconButton label={subtitles ? '隐藏字幕' : '显示字幕'} className={cx(subtitles && 'text-accent')} onClick={() => setSubtitles(!subtitles)}>
            <Captions className="size-4" />
          </IconButton>
          <IconButton label={voiceOn ? '关闭配音' : '播放配音'} className={cx(voiceOn && 'text-accent')} onClick={() => setVoiceOn(!voiceOn)}>
            {voiceOn ? <Volume2 className="size-4" /> : <VolumeX className="size-4" />}
          </IconButton>
          {music && <Music className="size-4 text-accent" aria-label={`配乐：${music.filename ?? ''}`} />}
          <IconButton label="审片备注（M）" onClick={() => void addNote()}>
            <MessageSquarePlus className="size-4" />
          </IconButton>
          <IconButton label={current.shot.review === 'redo' ? '取消待返工（R）' : '标记待返工（R）'} className={cx(current.shot.review === 'redo' && 'text-warn')} onClick={toggleRedo}>
            <Flag className="size-4" />
          </IconButton>
          <span className="text-xs text-fg-3">
            镜头 {safeIndex + 1}/{flat.length}
          </span>
        </div>
        {currentVideo && (
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-fg-3">
            <Scissors className="size-3.5" />
            <span>
              裁剪 {(current.shot.trimIn ?? 0).toFixed(1)}s – {current.shot.trimOut != null ? `${current.shot.trimOut.toFixed(1)}s` : `${(currentVideo.duration ?? 0).toFixed(1)}s`}
            </span>
            <Button size="sm" variant="ghost" onClick={() => setTrim('in')}>
              设入点 I
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setTrim('out')}>
              设出点 O
            </Button>
            {(current.shot.trimIn != null || current.shot.trimOut != null) && (
              <Button size="sm" variant="ghost" onClick={() => setTrim('clear')}>
                清除裁剪
              </Button>
            )}
            <span className="ml-auto hidden sm:inline">快捷键：空格 播放 · ←/→ 切镜头 · M 备注 · R 待返工</span>
          </div>
        )}
      </div>

      <div ref={stripRef} className="no-scrollbar flex gap-2 overflow-x-auto pb-2">
        {flat.map((item, i) => {
          const sm = media.get(item.shot.id) ?? EMPTY_MEDIA;
          const thumb = sm.keyframe ?? (sm.video && !isVideoAsset(sm.video) ? sm.video : null);
          const thumbUrl = thumb?.thumbUrl ?? thumb?.url ?? (sm.video && isVideoAsset(sm.video) ? sm.video.posterUrl : null);
          return (
            <button
              key={item.shot.id}
              data-index={i}
              onClick={() => setIndex(i)}
              aria-label={`镜头 ${i + 1}`}
              className={cx('relative shrink-0 overflow-hidden rounded-lg border-2 bg-ink-3 transition', i === safeIndex ? 'border-violet' : 'border-transparent opacity-70 hover:opacity-100')}
              style={{ width: `${Math.max(64, (timeline[i]?.length ?? item.shot.duration) * 22)}px`, height: 56 }}
            >
              {thumbUrl ? <img src={thumbUrl} alt="" loading="lazy" className="size-full object-cover" /> : <span className="flex size-full items-center justify-center text-[10px] text-fg-3">#{item.number}</span>}
              {sm.video && <Film className="absolute right-1 bottom-1 size-3 drop-shadow" />}
              {item.shot.review === 'redo' && <Flag className="absolute top-1 left-1 size-3 text-warn drop-shadow" />}
              {notes.some((n) => !n.resolved && n.shotId === item.shot.id) && <span className="absolute top-1 right-1 size-1.5 rounded-full bg-warn" />}
            </button>
          );
        })}
      </div>

      <NotesPanel
        notes={notes}
        setNotes={setNotes}
        storyId={storyId}
        shotLabel={(shotId) => {
          const i = flat.findIndex((item) => item.shot.id === shotId);
          return i >= 0 ? `镜头 ${i + 1}` : '已删除的镜头';
        }}
        onJump={(note) => (note.atSec != null ? seek(note.atSec) : setIndex(Math.max(0, flat.findIndex((item) => item.shot.id === note.shotId))))}
      />

      <FilmPanel musicId={musicId} setMusicId={setMusicId} music={music ?? null} />

      <div className="panel flex flex-wrap items-center justify-between gap-3 p-4">
        <div className="flex flex-wrap gap-x-5 gap-y-1 text-sm text-fg-2">
          <span>
            共 {flat.length} 个镜头 · {formatDuration(total)}
          </span>
          <span className="inline-flex items-center gap-1">
            <ImageIcon className="size-3.5" /> 关键帧 {stats.keyframes}/{flat.length}
          </span>
          <span className="inline-flex items-center gap-1">
            <Film className="size-3.5" /> 视频 {stats.videos}/{flat.length}
          </span>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" icon={<ImageIcon className="size-3.5" />} onClick={() => generator.batch({ type: 'all' }, 'keyframe')}>
            补齐全部关键帧
          </Button>
          <Button size="sm" variant="brand" icon={<Film className="size-3.5" />} onClick={() => generator.batch({ type: 'all' }, 'video')}>
            补齐全部视频
          </Button>
        </div>
      </div>
    </div>
  );
}
