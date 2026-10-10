import { useEffect, useRef } from 'react';
import { cx } from '../lib/util.ts';

/**
 * 点阵画布：鼠标 / 手指划过时，点阵像水面一样泛起波纹，划过的轨迹会短暂“点亮”，
 * 像在画布上作画。
 *
 * 性能要点：
 * - 纯 Canvas 2D，每帧只做加减乘除和 fillRect，没有 DOM 更新
 * - 没有波纹、没有余辉时停止动画循环，静止时零开销
 * - 离开视口或切到后台时暂停；系统开启“减少动态效果”时只绘制静态点阵
 */

interface Ripple {
  x: number;
  y: number;
  born: number;
  strength: number;
}

const WAVE_SPEED = 420; // px/s
const WAVE_WIDTH = 70; // 波峰宽度
const RIPPLE_LIFE = 2.4; // 秒
const MAX_RIPPLES = 28;
const BRUSH_RADIUS = 90;

function hexToRgb(hex: string): [number, number, number] {
  const value = hex.replace('#', '');
  const n = parseInt(value.length === 3 ? value.replace(/./g, (c) => c + c) : value, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function DotField({
  className,
  spacing = 22,
  accent = '#4d8dff',
  idle = true,
}: {
  className?: string;
  spacing?: number;
  accent?: string;
  /** 无交互时偶尔自动泛起一圈涟漪 */
  idle?: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) return;

    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const [ar, ag, ab] = hexToRgb(accent);
    let width = 0;
    let height = 0;
    let dpr = 1;
    let cols = 0;
    let rows = 0;
    let gap = spacing;
    let baseX = new Float32Array(0);
    let baseY = new Float32Array(0);
    let energy = new Float32Array(0);
    const ripples: Ripple[] = [];
    let frame = 0;
    let running = false;
    let visible = true;
    let last = performance.now();
    let lastSpawn = { x: -999, y: -999, t: 0 };
    let pointer: { x: number; y: number } | null = null;

    function layout() {
      const rect = canvas!.getBoundingClientRect();
      width = rect.width;
      height = rect.height;
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas!.width = Math.round(width * dpr);
      canvas!.height = Math.round(height * dpr);
      gap = width < 640 ? Math.max(16, spacing - 4) : spacing;
      cols = Math.ceil(width / gap) + 1;
      rows = Math.ceil(height / gap) + 1;
      const offsetX = (width - (cols - 1) * gap) / 2;
      const offsetY = (height - (rows - 1) * gap) / 2;
      const count = cols * rows;
      baseX = new Float32Array(count);
      baseY = new Float32Array(count);
      energy = new Float32Array(count);
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const i = r * cols + c;
          baseX[i] = offsetX + c * gap;
          baseY[i] = offsetY + r * gap;
        }
      }
      draw(performance.now());
    }

    function draw(now: number) {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const t = now / 1000;
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx!.clearRect(0, 0, width, height);

      // 清理过期波纹
      for (let k = ripples.length - 1; k >= 0; k--) {
        if (t - ripples[k].born > RIPPLE_LIFE) ripples.splice(k, 1);
      }

      const decay = Math.pow(0.08, dt); // 余辉每秒衰减到 8%
      let active = ripples.length > 0;
      const count = baseX.length;

      for (let i = 0; i < count; i++) {
        let x = baseX[i];
        let y = baseY[i];
        let lift = 0;

        // 笔刷：指针附近的点被“点亮”
        if (pointer) {
          const dx = x - pointer.x;
          const dy = y - pointer.y;
          const d2 = dx * dx + dy * dy;
          if (d2 < BRUSH_RADIUS * BRUSH_RADIUS) {
            const f = 1 - Math.sqrt(d2) / BRUSH_RADIUS;
            energy[i] = Math.min(1, energy[i] + f * f * dt * 9);
          }
        }

        // 水波：每圈波纹在其波峰处把点沿径向推开，并提亮
        for (let k = 0; k < ripples.length; k++) {
          const ripple = ripples[k];
          const age = t - ripple.born;
          const dx = x - ripple.x;
          const dy = y - ripple.y;
          const dist = Math.sqrt(dx * dx + dy * dy) || 1;
          const phase = dist - age * WAVE_SPEED;
          if (phase > -WAVE_WIDTH && phase < WAVE_WIDTH) {
            const fade = (1 - age / RIPPLE_LIFE) * ripple.strength;
            const wave = Math.sin((phase / WAVE_WIDTH) * Math.PI) * fade;
            const push = wave * 7;
            x += (dx / dist) * push;
            y += (dy / dist) * push;
            lift += Math.abs(wave) * 0.9;
          }
        }

        const e = energy[i];
        if (e > 0.002) {
          energy[i] = e * decay;
          active = true;
        } else {
          energy[i] = 0;
        }

        const glow = Math.min(1, e + lift);
        if (glow < 0.01) {
          ctx!.fillStyle = 'rgba(255,255,255,0.13)';
          ctx!.fillRect(x - 0.75, y - 0.75, 1.5, 1.5);
        } else {
          const size = 1.5 + glow * 2.2;
          const r = Math.round(255 + (ar - 255) * glow);
          const g = Math.round(255 + (ag - 255) * glow);
          const b = Math.round(255 + (ab - 255) * glow);
          ctx!.fillStyle = `rgba(${r},${g},${b},${0.13 + glow * 0.8})`;
          ctx!.fillRect(x - size / 2, y - size / 2, size, size);
        }
      }
      return active;
    }

    function loop(now: number) {
      const active = draw(now);
      if ((active || pointer) && visible) {
        frame = requestAnimationFrame(loop);
      } else {
        running = false;
      }
    }

    function start() {
      if (running || reduceMotion || !visible) return;
      running = true;
      last = performance.now();
      frame = requestAnimationFrame(loop);
    }

    function spawn(x: number, y: number, strength: number) {
      ripples.push({ x, y, born: performance.now() / 1000, strength });
      if (ripples.length > MAX_RIPPLES) ripples.shift();
      start();
    }

    function toLocal(event: PointerEvent) {
      const rect = canvas!.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      return x >= 0 && y >= 0 && x <= rect.width && y <= rect.height ? { x, y } : null;
    }

    function onMove(event: PointerEvent) {
      const point = toLocal(event);
      pointer = point;
      if (!point) return;
      const now = performance.now();
      const moved = Math.hypot(point.x - lastSpawn.x, point.y - lastSpawn.y);
      // 移动足够距离才产生新的波纹，划得越快波纹越密
      if (moved > 46 || now - lastSpawn.t > 400) {
        spawn(point.x, point.y, Math.min(1, 0.45 + moved / 160));
        lastSpawn = { x: point.x, y: point.y, t: now };
      }
      start();
    }

    function onDown(event: PointerEvent) {
      const point = toLocal(event);
      if (point) spawn(point.x, point.y, 1.4);
    }

    function onLeave() {
      pointer = null;
    }

    const resizeObserver = new ResizeObserver(layout);
    resizeObserver.observe(canvas);
    const intersection = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting && document.visibilityState === 'visible';
      if (visible) start();
    });
    intersection.observe(canvas);
    const onVisibility = () => {
      visible = document.visibilityState === 'visible';
      if (visible) start();
    };

    window.addEventListener('pointermove', onMove, { passive: true });
    window.addEventListener('pointerdown', onDown, { passive: true });
    document.addEventListener('pointerleave', onLeave);
    document.addEventListener('visibilitychange', onVisibility);

    // 无人操作时的环境涟漪，让画面保持“呼吸感”
    let idleTimer: ReturnType<typeof setInterval> | null = null;
    if (idle && !reduceMotion) {
      idleTimer = setInterval(() => {
        if (!visible || pointer) return;
        spawn(width * (0.2 + Math.random() * 0.6), height * (0.25 + Math.random() * 0.5), 0.55);
      }, 3200);
      setTimeout(() => spawn(width / 2, height * 0.42, 0.9), 400);
    }

    return () => {
      cancelAnimationFrame(frame);
      if (idleTimer) clearInterval(idleTimer);
      resizeObserver.disconnect();
      intersection.disconnect();
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerdown', onDown);
      document.removeEventListener('pointerleave', onLeave);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [spacing, accent, idle]);

  return <canvas ref={canvasRef} aria-hidden className={cx('pointer-events-none absolute inset-0 size-full', className)} />;
}
