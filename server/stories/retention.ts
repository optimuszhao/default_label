// 历史版本的保留规则（纯函数，单测直接调用）
/**
 * 历史版本保留策略：7 天内全部保留；90 天内每天保留最新 1 份；更早的每周保留 1 份；
 * 手动保存和迁移前的原始内容（pinned）永久保留。rows 按时间倒序，返回要删除的 id。
 */
export function snapshotsToPrune(rows: { id: string; createdAt: number; pinned: boolean }[], at: number): string[] {
  const day = 86_400_000;
  const seen = new Set<string>();
  const remove: string[] = [];
  for (const row of [...rows].sort((a, b) => b.createdAt - a.createdAt)) {
    const age = at - row.createdAt;
    if (row.pinned || age < 7 * day) continue;
    const bucket = age < 90 * day ? `d${Math.floor(row.createdAt / day)}` : `w${Math.floor(row.createdAt / (7 * day))}`;
    if (seen.has(bucket)) remove.push(row.id);
    else seen.add(bucket);
  }
  return remove;
}

