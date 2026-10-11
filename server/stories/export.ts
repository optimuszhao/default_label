// 故事导出（EXP-01）：剧本 Markdown / TXT、字幕 SRT / ASS、镜头表 CSV、关键帧 ZIP。
// 每一种导出物都带 AI 标识：文本里加一行声明；PNG 写入 tEXt 元数据（AIGC 字段）。
import fs from 'node:fs/promises';
import { crc32 } from 'node:zlib';
import type { Scene, Shot, StoryData } from '../../shared/types.ts';
import { db, type Row } from '../db.ts';
import { absoluteFile } from '../files.ts';
import type { ZipEntry } from '../media/zip.ts';
import { effectiveMedia } from './batch.ts';

export const AI_NOTICE = '本内容由 AI 辅助生成（织影 Weave）。';

interface FlatShot {
  shot: Shot;
  scene: Scene;
  chapterIndex: number;
  sceneIndex: number;
  number: number;
  chapterTitle: string;
}

function flatten(data: StoryData): FlatShot[] {
  const out: FlatShot[] = [];
  data.chapters.forEach((chapter, chapterIndex) =>
    chapter.scenes.forEach((scene, sceneIndex) =>
      scene.shots.forEach((shot) => out.push({ shot, scene, chapterIndex, sceneIndex, number: out.length + 1, chapterTitle: chapter.title })),
    ),
  );
  return out;
}

function speaker(data: StoryData, characterId: string | null): string {
  return data.characters.find((c) => c.id === characterId)?.name ?? '旁白';
}

/** 地点里带"室、屋、房、厅、馆、内"等字样算内景，否则外景 */
function interior(location: string): '内景' | '外景' {
  return /[室屋房厅馆内舱车店宫殿]/.test(location) ? '内景' : '外景';
}

export function scriptMarkdown(title: string, data: StoryData): string {
  const lines = [`# ${title}`, '', `> ${AI_NOTICE}`, ''];
  if (data.logline) lines.push(`**一句话故事**：${data.logline}`, '');
  data.chapters.forEach((chapter, ci) => {
    lines.push(`## 第 ${ci + 1} 章 ${chapter.title}`, '');
    if (chapter.summary) lines.push(chapter.summary, '');
    chapter.scenes.forEach((scene, si) => {
      const head = [`${ci + 1}-${si + 1}`, scene.location || '未定地点', interior(scene.location), scene.time].filter(Boolean).join(' · ');
      lines.push(`### ${head}　${scene.title}`, '');
      if (scene.summary) lines.push(scene.summary, '');
      for (const line of scene.dialogue) {
        if (!line.text.trim()) continue;
        if (!line.characterId || line.kind === 'narration') lines.push(`*（旁白）${line.text}*`, '');
        else lines.push(`**${speaker(data, line.characterId)}**${line.emotion ? `（${line.emotion}）` : ''}：${line.text}`, '');
      }
    });
  });
  return lines.join('\n');
}

export function scriptText(title: string, data: StoryData): string {
  return scriptMarkdown(title, data)
    .replace(/^#+ /gm, '')
    .replace(/^> /gm, '')
    .replace(/\*\*/g, '')
    .replace(/^\*(.*)\*$/gm, '$1');
}

function srtTime(seconds: number): string {
  const ms = Math.round(seconds * 1000);
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`;
}

function assTime(seconds: number): string {
  const cs = Math.round(seconds * 100);
  const h = Math.floor(cs / 360_000);
  const m = Math.floor((cs % 360_000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
}

/** 字幕时间轴：按镜头顺序累计时长（有裁剪点时用裁剪后的长度），镜头内多句台词平分时间 */
export function subtitleCues(data: StoryData): { start: number; end: number; text: string }[] {
  const cues: { start: number; end: number; text: string }[] = [];
  let at = 0;
  for (const { shot, scene } of flatten(data)) {
    const length = shot.trimOut != null || shot.trimIn != null ? Math.max(0.5, (shot.trimOut ?? shot.duration) - (shot.trimIn ?? 0)) : shot.duration;
    const lines = shot.dialogueIds.map((id) => scene.dialogue.find((d) => d.id === id)).filter((d) => d?.text.trim());
    lines.forEach((line, i) => {
      const slot = length / lines.length;
      const name = line!.characterId ? `${speaker(data, line!.characterId)}：` : '';
      cues.push({ start: at + i * slot, end: at + (i + 1) * slot - 0.05, text: `${name}${line!.text}` });
    });
    at += length;
  }
  return cues;
}

export function srt(data: StoryData): string {
  const cues = subtitleCues(data);
  const body = cues.map((cue, i) => `${i + 1}\n${srtTime(cue.start)} --> ${srtTime(cue.end)}\n${cue.text}\n`).join('\n');
  // 第 0 条：AI 标识（片头 2 秒）
  return `0\n00:00:00,000 --> 00:00:02,000\n${AI_NOTICE}\n\n${body}`;
}

export function ass(title: string, data: StoryData): string {
  const header = [
    '[Script Info]',
    `Title: ${title}`,
    `; ${AI_NOTICE}`,
    'ScriptType: v4.00+',
    'PlayResX: 1920',
    'PlayResY: 1080',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    'Style: Default,PingFang SC,56,&H00FFFFFF,&H000000FF,&H00000000,&H64000000,0,0,0,0,100,100,0,0,1,3,0,2,60,60,50,1',
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];
  const events = subtitleCues(data).map((cue) => `Dialogue: 0,${assTime(cue.start)},${assTime(cue.end)},Default,,0,0,0,,${cue.text.replace(/\n/g, '\\N')}`);
  return [...header, `Comment: 0,0:00:00.00,0:00:02.00,Default,,0,0,0,,${AI_NOTICE}`, ...events, ''].join('\n');
}

function csvCell(value: unknown): string {
  const text = value == null ? '' : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export const SHOT_CSV_HEADER = ['序号', '镜头编号', '章', '场', '景别', '运镜', '时长', '画面描述', '出镜', '台词', '定稿', 'id'];

/** 镜头表 CSV（带 BOM，Excel 直接打开不乱码）；导回时按 id 匹配 */
export function shotsCsv(data: StoryData): string {
  const rows = flatten(data).map(({ shot, scene, number, chapterTitle }) => [
    number,
    shot.code ?? '',
    chapterTitle,
    scene.title,
    shot.shotSize,
    shot.cameraMove,
    shot.duration,
    shot.description,
    [...shot.characterIds.map((id) => data.characters.find((c) => c.id === id)?.name), ...(shot.elementIds ?? []).map((id) => data.elements?.find((e) => e.id === id)?.name)].filter(Boolean).join('、'),
    shot.dialogueIds
      .map((id) => scene.dialogue.find((d) => d.id === id))
      .filter(Boolean)
      .map((d) => `${speaker(data, d!.characterId)}：${d!.text}`)
      .join(' / '),
    shot.locked ? '是' : '',
    shot.id,
  ]);
  return `﻿${[SHOT_CSV_HEADER, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n# ${AI_NOTICE}\r\n`;
}

/** 在 PNG 的 IHDR 之后插入 tEXt 块（不重新编码像素） */
export function pngWithText(png: Buffer, key: string, value: string): Buffer {
  if (png.readUInt32BE(12) !== 0x49484452) return png; // 不是标准 PNG
  const data = Buffer.concat([Buffer.from(key, 'latin1'), Buffer.from([0]), Buffer.from(value, 'utf8')]);
  const type = Buffer.from('tEXt', 'latin1');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([type, data])));
  const ihdrEnd = 8 + 8 + png.readUInt32BE(8) + 4;
  return Buffer.concat([png.subarray(0, ihdrEnd), length, type, data, crc, png.subarray(ihdrEnd)]);
}

/** 关键帧 ZIP：每个镜头选定的关键帧，按全片顺序命名；PNG 写入 AI 标识 */
export async function* keyframeEntries(storyId: string, title: string, data: StoryData): AsyncGenerator<ZipEntry> {
  const media = effectiveMedia(storyId);
  const manifest: Record<string, unknown>[] = [];
  for (const item of flatten(data)) {
    const assetId = media.get(item.shot.id)?.keyframe;
    if (!assetId) continue;
    const row = db.prepare('SELECT file, mime, prompt FROM assets WHERE id = ?').get(assetId) as Row | undefined;
    if (!row) continue;
    const ext = String(row.mime).split('/')[1]?.replace('jpeg', 'jpg') ?? 'png';
    const name = `${String(item.number).padStart(3, '0')}-${item.chapterIndex + 1}-${item.sceneIndex + 1}-${item.scene.title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 30)}.${ext}`;
    const file = absoluteFile(String(row.file));
    manifest.push({ file: name, shot: item.number, code: item.shot.code ?? null, scene: item.scene.title, description: item.shot.description, prompt: row.prompt, assetId, aigc: true });
    if (row.mime === 'image/png') {
      const buffer = await fs.readFile(file).catch(() => null);
      if (buffer) yield { name, data: pngWithText(buffer, 'AIGC', JSON.stringify({ label: 'AI 生成', generator: '织影 Weave', story: title })) };
    } else {
      yield { name, file };
    }
  }
  yield { name: 'AI标识说明.txt', data: `${AI_NOTICE}\n本压缩包中的图片均为 AI 生成内容。PNG 文件的元数据（AIGC 字段）中写有生成标识。\n` };
  yield { name: 'manifest.json', data: JSON.stringify({ title, generator: '织影 Weave', notice: AI_NOTICE, items: manifest }, null, 2) };
}
