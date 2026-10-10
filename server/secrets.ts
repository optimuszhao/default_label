// 敏感信息加密存储（AES-256-GCM）。
// 主密钥优先读环境变量 MASTER_KEY；没配置时自动生成到 DATA_DIR/master.key（权限 600），
// 这种情况下备份数据库时要连同 master.key 一起保管，否则恢复后无法解密，需要重新填写密钥。
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.ts';
import { db, now } from './db.ts';
import { logger } from './log.ts';

function loadKey(): { key: Buffer; source: 'env' | 'file' } {
  const fromEnv = process.env.MASTER_KEY?.trim();
  if (fromEnv) return { key: scryptSync(fromEnv, 'weave-master-key', 32), source: 'env' };
  const file = path.join(config.dataDir, 'master.key');
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, randomBytes(32).toString('base64'), { mode: 0o600 });
    logger.warn({ file }, '没有配置 MASTER_KEY，已自动生成主密钥文件；请和数据库一起备份');
  }
  return { key: Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'base64'), source: 'file' };
}

const master = loadKey();
export const masterKeySource = master.source;

export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', master.key, iv);
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), body.toString('base64')].join('.');
}

export function decrypt(sealed: string): string {
  const [version, iv, tag, body] = sealed.split('.');
  if (version !== 'v1') throw new Error('未知的密文格式');
  const decipher = createDecipheriv('aes-256-gcm', master.key, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(body, 'base64')), decipher.final()]).toString('utf8');
}

export function setSecret(scope: string, key: string, value: string | null): void {
  if (value === null || value === '') {
    db.prepare('DELETE FROM secrets WHERE scope = ? AND key = ?').run(scope, key);
    return;
  }
  db.prepare(
    `INSERT INTO secrets (scope, key, ciphertext, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(scope, key) DO UPDATE SET ciphertext = excluded.ciphertext, updated_at = excluded.updated_at`,
  ).run(scope, key, encrypt(value), now());
}

/** 读不出来（主密钥换了）时返回 null，而不是让服务崩掉 */
export function getSecret(scope: string, key: string): string | null {
  const row = db.prepare('SELECT ciphertext FROM secrets WHERE scope = ? AND key = ?').get(scope, key) as { ciphertext: string } | undefined;
  if (!row) return null;
  try {
    return decrypt(row.ciphertext);
  } catch {
    logger.error({ scope, key }, '密钥解密失败：主密钥可能变了，请在后台重新填写');
    return null;
  }
}

export function secretInfo(scope: string, key: string): { set: boolean; updatedAt: number | null } {
  const row = db.prepare('SELECT updated_at FROM secrets WHERE scope = ? AND key = ?').get(scope, key) as { updated_at: number } | undefined;
  return { set: Boolean(row), updatedAt: row ? Number(row.updated_at) : null };
}

export function deleteScope(scope: string): void {
  db.prepare('DELETE FROM secrets WHERE scope = ?').run(scope);
}
