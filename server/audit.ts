// 审计日志：后台的所有写操作都记一笔（谁、做了什么、对谁）
import type { FastifyRequest } from 'fastify';
import { db, newId, now } from './db.ts';

export function audit(request: FastifyRequest | null, action: string, target: string | null, summary = ''): void {
  db.prepare('INSERT INTO audit_logs (id, actor_id, actor_email, action, target, summary, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    newId('al_'),
    request?.user?.id ?? null,
    request?.user?.email ?? null,
    action,
    target,
    summary.slice(0, 500),
    now(),
  );
}
