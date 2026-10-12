// 镜头表 CSV / 粘贴表格的解析（纯函数，单测直接引用）
import type { Scene, Shot, StoryData } from '../../../../../shared/types.ts';
import { CAMERA_MOVES, SHOT_SIZES } from '../../../lib/presets.ts';
import { newChapter, newScene, newShot } from './model.ts';

/** 解析 CSV（支持引号、转义引号、引号里的换行） */
export function parseCsv(text: string, delimiter = ','): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === delimiter) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

const SIZE_SET = new Set<string>(SHOT_SIZES);
const MOVE_SET = new Set<string>(CAMERA_MOVES);

/**
 * 一行表格 → 镜头字段。有表头时按列名（景别 / 运镜 / 时长 / 描述…）取；
 * 没有表头时按内容猜：景别词、运镜词、数字是时长，其余拼成描述。
 */
export function rowToShot(cells: string[], header: string[] | null): Partial<Shot> {
  const get = (names: string[]) => {
    if (!header) return undefined;
    const index = header.findIndex((h) => names.some((n) => h.includes(n)));
    return index >= 0 ? cells[index]?.trim() : undefined;
  };
  if (header) {
    const duration = Number(get(['时长', '秒', 'duration']));
    return {
      shotSize: get(['景别', 'size']) || '中景',
      cameraMove: get(['运镜', '镜头运动', 'camera']) || '固定',
      duration: Number.isFinite(duration) && duration > 0 ? Math.min(30, duration) : 5,
      description: get(['画面描述', '描述', '画面', '内容', 'description']) ?? '',
      code: get(['镜头编号', '编号', 'code']) || undefined,
    };
  }
  const patch: Partial<Shot> = { shotSize: '中景', cameraMove: '固定', duration: 5, description: '' };
  const rest: string[] = [];
  for (const raw of cells) {
    const cell = raw.trim();
    if (!cell) continue;
    if (SIZE_SET.has(cell)) patch.shotSize = cell;
    else if (MOVE_SET.has(cell)) patch.cameraMove = cell;
    else if (/^\d+(\.\d+)?\s*(s|秒)$/.test(cell)) patch.duration = Math.min(30, Number.parseFloat(cell));
    else if (/^\d+$/.test(cell)) continue; // 序号
    else rest.push(cell);
  }
  patch.description = rest.join('，');
  return patch;
}

function looksLikeHeader(cells: string[]): boolean {
  return cells.some((cell) => /景别|运镜|时长|描述|画面|编号/.test(cell));
}

/** 表格文本（制表符或逗号分隔）→ 一组镜头字段 */
export function shotsFromTable(text: string): Partial<Shot>[] {
  const delimiter = text.includes('\t') ? '\t' : ',';
  const rows = parseCsv(text, delimiter);
  if (!rows.length) return [];
  const header = looksLikeHeader(rows[0]) ? rows[0] : null;
  return (header ? rows.slice(1) : rows).filter((row) => !row[0]?.startsWith('#')).map((row) => rowToShot(row, header));
}

/**
 * 导入镜头表 CSV：
 * - id 认识的镜头：更新景别、运镜、时长、描述、编号；"场"那一列改成了别的场次就挪过去
 * - 其余的行是新镜头：按"章""场"两列放进对应场次（按名字匹配，没有就新建章 / 场次），
 *   这两列都没有时才放进当前场次（fallback）
 */
export function applyCsv(data: StoryData, text: string, fallbackSceneId: string | null): { data: StoryData; updated: number; added: number; created: number } {
  const rows = parseCsv(text);
  if (!rows.length) return { data, updated: 0, added: 0, created: 0 };
  const header = rows[0].map((h) => h.trim());
  const column = (names: string[]) => header.findIndex((h) => names.includes(h));
  const idIndex = column(['id']);
  const chapterIndex = column(['章', '章节', 'chapter']);
  const sceneIndex = column(['场', '场次', 'scene']);
  const next: StoryData = structuredClone(data);
  let updated = 0;
  let added = 0;
  let created = 0;

  const fallback = () => {
    for (const chapter of next.chapters) for (const scene of chapter.scenes) if (scene.id === fallbackSceneId) return scene;
    return null;
  };
  /** 按章名、场名找场次；找不到就新建（章名为空时在全片里按场名找，再找不到就建在最后一章） */
  const resolve = (chapterTitle: string, sceneTitle: string): Scene | null => {
    if (!sceneTitle && !chapterTitle) return fallback();
    let chapter = chapterTitle ? next.chapters.find((c) => c.title.trim() === chapterTitle) : undefined;
    if (!chapter && !chapterTitle) {
      const owner = next.chapters.find((c) => c.scenes.some((s) => s.title.trim() === sceneTitle));
      if (owner) return owner.scenes.find((s) => s.title.trim() === sceneTitle)!;
    }
    if (!chapter) {
      if (chapterTitle) {
        chapter = newChapter({ title: chapterTitle, scenes: [] });
        next.chapters.push(chapter);
      } else {
        chapter = next.chapters.at(-1);
        if (!chapter) {
          chapter = newChapter({ title: '第一章', scenes: [] });
          next.chapters.push(chapter);
        }
      }
    }
    const title = sceneTitle || '新场次';
    let scene = chapter.scenes.find((s) => s.title.trim() === title);
    if (!scene) {
      scene = newScene({ title });
      chapter.scenes.push(scene);
      created++;
    }
    return scene;
  };
  const locate = (id: string) => {
    for (const chapter of next.chapters)
      for (const scene of chapter.scenes) {
        const index = scene.shots.findIndex((s) => s.id === id);
        if (index >= 0) return { scene, index };
      }
    return null;
  };

  for (const row of rows.slice(1)) {
    if (row[0]?.trim().startsWith('#')) continue;
    const patch = rowToShot(row, header);
    const id = idIndex >= 0 ? (row[idIndex]?.trim() ?? '') : '';
    const chapterTitle = chapterIndex >= 0 ? (row[chapterIndex]?.trim() ?? '') : '';
    const sceneTitle = sceneIndex >= 0 ? (row[sceneIndex]?.trim() ?? '') : '';
    const found = id ? locate(id) : null;
    if (found) {
      const shot = found.scene.shots[found.index];
      if (shot.locked) continue;
      Object.assign(shot, patch);
      // "场"那一列改了：挪到那个场次末尾
      if (sceneTitle && sceneTitle !== found.scene.title.trim()) {
        const target = resolve(chapterTitle, sceneTitle);
        if (target && target !== found.scene) {
          found.scene.shots.splice(found.index, 1);
          target.shots.push(shot);
        }
      }
      updated++;
      continue;
    }
    const target = resolve(chapterTitle, sceneTitle);
    if (!target) continue;
    target.shots.push(newShot(patch));
    added++;
  }
  return { data: next, updated, added, created };
}
