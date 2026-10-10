import { memo } from 'react';
import { Play } from 'lucide-react';
import { cx } from '../lib/util.ts';

// 纯 CSS 绘制的“示意画面”，用于首页展示，避免首屏加载大体积视频。
// 每个场景由天空渐变 + 光源 + 山体剪影 + 流动光雾组成，动画只使用 transform/opacity，GPU 合成更流畅。

export const SCENES = [
  { sky: ['#0b1026', '#3b1d5e', '#ff7a59'], sun: '#ffd27a', land: ['#1b1033', '#2a1645'], caption: '黄昏下的赛博城市，霓虹倒映在雨后街道', tag: '文生视频' },
  { sky: ['#02131f', '#0b4f6c', '#5ee7ff'], sun: '#d6fbff', land: ['#04202e', '#06364a'], caption: '深海中缓缓游过的发光鲸群，体积光穿透水面', tag: '图生视频' },
  { sky: ['#140b1f', '#5a1e57', '#ff5ea8'], sun: '#ffd1e8', land: ['#200a24', '#3a0f3a'], caption: '樱花雨中的少女回眸，电影感浅景深', tag: '文生图' },
  { sky: ['#06110c', '#134e3a', '#c6ff5e'], sun: '#f2ffd1', land: ['#06180f', '#0b2a1a'], caption: '雾气森林里的古老石门，晨光从缝隙洒下', tag: '多镜头' },
  { sky: ['#0d0a1a', '#2c1f6b', '#8b5cf6'], sun: '#e3d7ff', land: ['#120d26', '#1d1440'], caption: '漂浮在星云中的宇宙列车，镜头环绕推进', tag: '文生视频' },
  { sky: ['#1a0d05', '#6b2f0b', '#ffb547'], sun: '#fff0c2', land: ['#24110a', '#3b1a0c'], caption: '沙漠商队穿越金色沙丘，长焦航拍', tag: '图生图' },
  { sky: ['#050b16', '#1b2b5e', '#7aa2ff'], sun: '#e6eeff', land: ['#0a1226', '#111d3d'], caption: '雪山之巅的孤独登山者，风雪呼啸', tag: '故事分镜' },
  { sky: ['#12060a', '#4a0f1f', '#ff5d6c'], sun: '#ffd6d6', land: ['#1c080e', '#2e0c16'], caption: '红色灯笼照亮的古镇雨夜，油纸伞缓缓走过', tag: '图生视频' },
] as const;

export const Scene = memo(function Scene({
  index,
  className,
  showCaption = true,
  showPlay = false,
  animated = true,
}: {
  index: number;
  className?: string;
  showCaption?: boolean;
  showPlay?: boolean;
  animated?: boolean;
}) {
  const scene = SCENES[index % SCENES.length];
  const [s0, s1, s2] = scene.sky;
  return (
    <div className={cx('group relative isolate overflow-hidden bg-ink-2', className)}>
      <div className="absolute inset-0" style={{ background: `linear-gradient(180deg, ${s0} 0%, ${s1} 55%, ${s2} 100%)` }} />
      <div
        className={cx('absolute left-[58%] top-[38%] size-[34%] rounded-full blur-[2px]', animated && 'animate-float')}
        style={{ background: `radial-gradient(circle, ${scene.sun} 0%, ${scene.sun}aa 35%, transparent 70%)` }}
      />
      <div
        className={cx('absolute -left-1/4 top-1/4 h-1/2 w-[150%] opacity-50 blur-2xl', animated && 'animate-float')}
        style={{ background: `radial-gradient(ellipse at center, ${s2}66, transparent 60%)`, animationDelay: '-5s' }}
      />
      <div
        className="absolute inset-x-0 bottom-0 h-[46%]"
        style={{
          background: scene.land[1],
          clipPath: 'polygon(0 55%, 14% 30%, 26% 48%, 40% 18%, 55% 44%, 68% 26%, 82% 50%, 100% 32%, 100% 100%, 0 100%)',
        }}
      />
      <div
        className="absolute inset-x-0 bottom-0 h-[30%]"
        style={{
          background: scene.land[0],
          clipPath: 'polygon(0 40%, 18% 62%, 33% 30%, 50% 58%, 64% 36%, 80% 64%, 100% 44%, 100% 100%, 0 100%)',
        }}
      />
      <div className="noise absolute inset-0 opacity-[0.12] mix-blend-overlay" />
      <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-black/10" />
      {showPlay && (
        <div className="absolute inset-0 flex items-center justify-center opacity-0 transition-opacity duration-300 group-hover:opacity-100">
          <span className="glass flex size-12 items-center justify-center rounded-full">
            <Play className="size-5 fill-current" />
          </span>
        </div>
      )}
      {showCaption && (
        <div className="absolute inset-x-0 bottom-0 p-3 sm:p-4">
          <span className="mb-1.5 inline-block rounded-full bg-white/15 px-2 py-0.5 text-[10px] font-medium tracking-wide backdrop-blur">
            {scene.tag}
          </span>
          <p className="line-clamp-2 text-[12px] leading-snug text-white/85 sm:text-[13px]">{scene.caption}</p>
        </div>
      )}
    </div>
  );
});
