// 图文排版（EXP-07）的数据结构、自动排版和长图导出。
// 三种版式：绘本（每页一张图配一段文字）、四格漫画（每页 4 格，带对话气泡）、条漫（竖向长条，一格接一格）。
import type { Asset, StoryData } from '../../../../../shared/types.ts';
import { flattenShots, type ShotMedia } from './model.ts';

export type LayoutKind = 'picture_book' | 'four_panel' | 'webtoon';

export interface Bubble {
  speaker: string;
  text: string;
}

export interface Panel {
  shotId: string;
  /** 旁白框 / 绘本的正文 */
  text: string;
  bubbles: Bubble[];
}

export interface LayoutPage {
  panels: Panel[];
}

export const LAYOUT_LABEL: Record<LayoutKind, string> = { picture_book: '绘本', four_panel: '四格漫画', webtoon: '条漫' };
export const AI_LABEL = 'AI 生成内容 · 织影 Weave';

/** 按分镜自动排版：台词变成气泡，旁白和场次剧情变成文字 */
export function autoLayout(kind: LayoutKind, data: StoryData): LayoutPage[] {
  const panels: Panel[] = flattenShots(data).map(({ shot, scene, indexInScene }) => {
    const lines = shot.dialogueIds.map((id) => scene.dialogue.find((d) => d.id === id)).filter((d) => d?.text.trim());
    const bubbles = lines.filter((l) => l!.characterId && l!.kind !== 'narration').map((l) => ({ speaker: data.characters.find((c) => c.id === l!.characterId)?.name ?? '', text: l!.text }));
    const narration = lines.filter((l) => !l!.characterId || l!.kind === 'narration').map((l) => l!.text);
    const text = kind === 'picture_book' ? [indexInScene === 0 ? scene.summary : '', ...narration, ...bubbles.map((b) => `${b.speaker}说：“${b.text}”`)].filter(Boolean).join('\n') : narration.join(' ');
    return { shotId: shot.id, text, bubbles: kind === 'picture_book' ? [] : bubbles };
  });
  if (kind === 'four_panel') {
    const pages: LayoutPage[] = [];
    for (let i = 0; i < panels.length; i += 4) pages.push({ panels: panels.slice(i, i + 4) });
    return pages;
  }
  if (kind === 'webtoon') return panels.length ? [{ panels }] : [];
  return panels.map((panel) => ({ panels: [panel] }));
}

function loadImage(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = url;
  });
}

/** 按宽度折行（逐字，中文没有空格） */
function wrap(ctx: CanvasRenderingContext2D, text: string, width: number): string[] {
  const out: string[] = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const ch of paragraph) {
      if (ctx.measureText(line + ch).width > width && line) {
        out.push(line);
        line = ch;
      } else line += ch;
    }
    out.push(line);
  }
  return out;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

const FONT = '"PingFang SC","Microsoft YaHei","Noto Sans CJK SC",sans-serif';

function drawBubbles(ctx: CanvasRenderingContext2D, bubbles: Bubble[], x: number, y: number, width: number) {
  ctx.font = `26px ${FONT}`;
  let top = y + 16;
  for (const bubble of bubbles) {
    const lines = wrap(ctx, `${bubble.speaker ? `${bubble.speaker}：` : ''}${bubble.text}`, width * 0.6 - 32);
    const h = lines.length * 34 + 22;
    const w = Math.min(width * 0.6, Math.max(...lines.map((l) => ctx.measureText(l).width)) + 32);
    const left = x + 16;
    ctx.fillStyle = 'rgba(255,255,255,0.95)';
    ctx.strokeStyle = '#111';
    ctx.lineWidth = 2;
    roundRect(ctx, left, top, w, h, 18);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#111';
    lines.forEach((line, i) => ctx.fillText(line, left + 16, top + 34 + i * 34 - 6));
    top += h + 10;
  }
}

function drawCaption(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, width: number) {
  if (!text.trim()) return;
  ctx.font = `24px ${FONT}`;
  const lines = wrap(ctx, text, width - 40);
  const h = lines.length * 32 + 20;
  ctx.fillStyle = 'rgba(255,248,220,0.95)';
  ctx.strokeStyle = '#111';
  ctx.lineWidth = 2;
  ctx.fillRect(x + 10, y - h - 10, width - 20, h);
  ctx.strokeRect(x + 10, y - h - 10, width - 20, h);
  ctx.fillStyle = '#111';
  lines.forEach((line, i) => ctx.fillText(line, x + 20, y - h - 10 + 30 + i * 32 - 6));
}

/** 把版式画成一张长图（PNG），底部带 AI 标识 */
export async function renderLongImage(kind: LayoutKind, pages: LayoutPage[], title: string, media: Map<string, ShotMedia>, assets: Record<string, Asset>): Promise<Blob> {
  const width = 1080;
  const urlOf = (shotId: string) => {
    const asset = media.get(shotId)?.keyframe;
    return asset ? (assets[asset.id]?.url ?? asset.url) : null;
  };
  const images = new Map<string, HTMLImageElement | null>();
  for (const page of pages) for (const panel of page.panels) if (!images.has(panel.shotId)) images.set(panel.shotId, await (urlOf(panel.shotId) ? loadImage(urlOf(panel.shotId)!) : Promise.resolve(null)));

  // 先算总高度
  const measure = document.createElement('canvas').getContext('2d')!;
  measure.font = `30px ${FONT}`;
  const panelHeight = (img: HTMLImageElement | null, w: number) => (img ? Math.round((img.height / img.width) * w) : Math.round(w * 0.6));
  let height = 140;
  for (const page of pages) {
    if (kind === 'picture_book') {
      const panel = page.panels[0];
      height += panelHeight(images.get(panel.shotId) ?? null, width - 80) + wrap(measure, panel.text, width - 80).length * 44 + 100;
    } else if (kind === 'four_panel') {
      height += page.panels.reduce((sum, panel) => sum + panelHeight(images.get(panel.shotId) ?? null, width - 80) + 24, 0) + 60;
    } else {
      height += page.panels.reduce((sum, panel) => sum + panelHeight(images.get(panel.shotId) ?? null, width) + 40, 0);
    }
  }
  height += 90;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = Math.min(height, 60_000);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, width, canvas.height);
  ctx.fillStyle = '#111';
  ctx.font = `bold 44px ${FONT}`;
  ctx.fillText(title, 40, 90);
  let y = 140;
  for (const page of pages) {
    if (kind === 'picture_book') {
      const panel = page.panels[0];
      const img = images.get(panel.shotId) ?? null;
      const h = panelHeight(img, width - 80);
      if (img) ctx.drawImage(img, 40, y, width - 80, h);
      else {
        ctx.fillStyle = '#eee';
        ctx.fillRect(40, y, width - 80, h);
      }
      y += h + 40;
      ctx.fillStyle = '#222';
      ctx.font = `30px ${FONT}`;
      for (const line of wrap(ctx, panel.text, width - 80)) {
        ctx.fillText(line, 40, y);
        y += 44;
      }
      y += 60;
    } else {
      const inset = kind === 'four_panel' ? 40 : 0;
      for (const panel of page.panels) {
        const img = images.get(panel.shotId) ?? null;
        const w = width - inset * 2;
        const h = panelHeight(img, w);
        if (img) ctx.drawImage(img, inset, y, w, h);
        else {
          ctx.fillStyle = '#eee';
          ctx.fillRect(inset, y, w, h);
        }
        if (kind === 'four_panel') {
          ctx.strokeStyle = '#111';
          ctx.lineWidth = 4;
          ctx.strokeRect(inset, y, w, h);
        }
        drawBubbles(ctx, panel.bubbles, inset, y, w);
        drawCaption(ctx, panel.text, inset, y + h, w);
        y += h + (kind === 'four_panel' ? 24 : 40);
      }
      if (kind === 'four_panel') y += 36;
    }
  }
  ctx.fillStyle = '#888';
  ctx.font = `22px ${FONT}`;
  ctx.fillText(AI_LABEL, 40, canvas.height - 36);
  return new Promise((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('导出失败'))), 'image/png'));
}
