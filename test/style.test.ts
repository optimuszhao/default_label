// 设计约束：界面不使用渐变色（点阵纹理除外）。见 docs/ROADMAP.md CRT-09。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const WEB = path.resolve(import.meta.dirname, '../web/src');
/** 唯一允许的写法：.dots-bg 用 radial-gradient 语法画 1px 的点 */
const ALLOWED = ['radial-gradient(rgb(255 255 255 / 0.13) 1px, transparent 1.2px)'];

function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return files(full);
    return /\.(tsx?|css)$/.test(entry.name) ? [full] : [];
  });
}

test('web/src 里没有渐变色', () => {
  const hits: string[] = [];
  for (const file of files(WEB)) {
    fs.readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, index) => {
        if (/gradient/i.test(line) && !ALLOWED.some((allowed) => line.includes(allowed))) {
          hits.push(`${path.relative(WEB, file)}:${index + 1}: ${line.trim()}`);
        }
      });
  }
  assert.deepEqual(hits, [], `发现渐变：\n${hits.join('\n')}`);
});
