// 资产库的查询条件 → SQL。列表、分面计数、"按条件全选"的批量操作、智能文件夹都用同一套。
import { z } from 'zod';
import type { AssetQuery } from '../../shared/types.ts';
import { db, now, type Row } from '../db.ts';

export const assetQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  kind: z.enum(['image', 'video', 'audio', '']).optional(),
  source: z.enum(['upload', 'generated', '']).optional(),
  folder: z.string().max(40).optional(),
  tag: z.string().max(40).optional(),
  storyId: z.string().max(40).optional(),
  favorite: z.boolean().optional(),
  minRating: z.number().int().min(0).max(5).optional(),
  flag: z.enum(['pick', 'reject', 'none', '']).optional(),
  days: z.number().int().min(1).max(3650).optional(),
  unfiled: z.boolean().optional(),
  trash: z.boolean().optional(),
  sort: z.enum(['new', 'old', 'rating', 'size']).optional(),
});

/** 查询字符串（GET 参数都是字符串）转成 AssetQuery */
export function queryFromParams(params: Record<string, string | undefined>): AssetQuery {
  const bool = (value: string | undefined) => (value === '1' || value === 'true' ? true : undefined);
  const int = (value: string | undefined) => (value && Number.isFinite(Number(value)) ? Math.trunc(Number(value)) : undefined);
  const parsed = assetQuerySchema.safeParse({
    q: params.q || undefined,
    kind: params.kind || undefined,
    source: params.source || undefined,
    folder: params.folder || undefined,
    tag: params.tag || undefined,
    storyId: params.storyId || undefined,
    favorite: bool(params.favorite),
    minRating: int(params.minRating),
    flag: params.flag || undefined,
    days: int(params.days),
    unfiled: bool(params.unfiled),
    trash: bool(params.trash),
    sort: params.sort || undefined,
  });
  return parsed.success ? parsed.data : {};
}

/** 文件夹及其全部子文件夹的 id */
export function folderTree(userId: string, folderId: string): string[] {
  const rows = db
    .prepare(
      `WITH RECURSIVE tree(id) AS (SELECT id FROM folders WHERE id = ? AND user_id = ?
         UNION ALL SELECT f.id FROM folders f JOIN tree t ON f.parent_id = t.id)
       SELECT id FROM tree`,
    )
    .all(folderId, userId) as Row[];
  return rows.map((row) => String(row.id));
}

/** FTS5 trigram 至少要 3 个字符；更短的关键词退回 LIKE（"拉面"这种两个字的词也能搜到） */
function ftsPhrase(text: string): string {
  return `"${text.replace(/"/g, '""')}"`;
}

export interface Where {
  sql: string;
  args: (string | number)[];
}

export function buildWhere(userId: string, query: AssetQuery, alias = 'a'): Where {
  const p = alias ? `${alias}.` : '';
  const where: string[] = [`${p}user_id = ?`];
  const args: (string | number)[] = [userId];
  where.push(query.trash ? `${p}deleted_at IS NOT NULL` : `${p}deleted_at IS NULL`);
  if (query.kind) {
    where.push(`${p}kind = ?`);
    args.push(query.kind);
  }
  if (query.source) {
    where.push(`${p}source = ?`);
    args.push(query.source);
  }
  if (query.folder) {
    const ids = folderTree(userId, query.folder);
    where.push(ids.length ? `${p}folder_id IN (${ids.map(() => '?').join(',')})` : '0');
    args.push(...ids);
  } else if (query.unfiled) {
    where.push(`${p}folder_id IS NULL`);
  }
  if (query.tag) {
    where.push(`${p}id IN (SELECT asset_id FROM asset_tags WHERE tag_id = ?)`);
    args.push(query.tag);
  }
  if (query.storyId) {
    where.push(`${p}story_id = ?`);
    args.push(query.storyId);
  }
  if (query.favorite) where.push(`${p}favorite = 1`);
  if (query.minRating) {
    where.push(`${p}rating >= ?`);
    args.push(query.minRating);
  }
  if (query.flag === 'none') where.push(`${p}flag IS NULL`);
  else if (query.flag) {
    where.push(`${p}flag = ?`);
    args.push(query.flag);
  }
  if (query.days) {
    where.push(`${p}created_at >= ?`);
    args.push(now() - query.days * 86_400_000);
  }
  const q = query.q?.trim();
  if (q) {
    // 每个空格分隔的词都要命中
    for (const word of q.split(/\s+/).slice(0, 6)) {
      if ([...word].length >= 3) {
        where.push(`${p}seq IN (SELECT rowid FROM assets_fts WHERE assets_fts MATCH ?)`);
        args.push(ftsPhrase(word));
      } else {
        where.push(`(${p}prompt LIKE ? OR ${p}note LIKE ? OR ${p}filename LIKE ? OR ${p}id IN (SELECT at.asset_id FROM asset_tags at JOIN tags t ON t.id = at.tag_id WHERE t.name LIKE ?))`);
        const like = `%${word.replace(/[%_]/g, '')}%`;
        args.push(like, like, like, like);
      }
    }
  }
  return { sql: where.join(' AND '), args };
}

export function orderBy(query: AssetQuery, alias = 'a'): string {
  const p = alias ? `${alias}.` : '';
  switch (query.sort) {
    case 'old':
      return `${p}seq ASC`;
    case 'rating':
      return `${p}rating DESC, ${p}seq DESC`;
    case 'size':
      return `COALESCE(${p}size, 0) DESC, ${p}seq DESC`;
    default:
      return `${p}seq DESC`;
  }
}

/**
 * 游标：默认按序号倒序时用 "s<seq>"（新增素材不会让翻页错位）；其他排序用偏移 "o<n>"。
 */
export function applyCursor(query: AssetQuery, cursor: string | undefined, where: Where, alias = 'a'): { offset: number } {
  const p = alias ? `${alias}.` : '';
  if (!cursor) return { offset: 0 };
  if (cursor.startsWith('s') && (!query.sort || query.sort === 'new' || query.sort === 'old')) {
    const seq = Number(cursor.slice(1));
    if (Number.isFinite(seq)) {
      where.sql += query.sort === 'old' ? ` AND ${p}seq > ?` : ` AND ${p}seq < ?`;
      where.args.push(seq);
    }
    return { offset: 0 };
  }
  if (cursor.startsWith('o')) return { offset: Math.max(0, Number(cursor.slice(1)) || 0) };
  return { offset: 0 };
}

export function nextCursor(query: AssetQuery, rows: Row[], limit: number, offset: number): string | null {
  if (rows.length < limit) return null;
  if (!query.sort || query.sort === 'new' || query.sort === 'old') return `s${rows.at(-1)!.seq}`;
  return `o${offset + rows.length}`;
}
