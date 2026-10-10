import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from './config.ts';
import { db, newId, now, type Row } from './db.ts';
import { toUser } from './repo.ts';
import type { User } from '../shared/types.ts';

export const SESSION_COOKIE = 'wv_sid';

declare module 'fastify' {
  interface FastifyRequest {
    user: User | null;
  }
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 10);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export function createUser(email: string, name: string, passwordHash: string): User {
  const id = newId('u_');
  db.prepare(
    'INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(id, email, name, passwordHash, now());
  return toUser(db.prepare('SELECT * FROM users WHERE id = ?').get(id) as Row);
}

export function findUserByEmail(email: string): (Row & { password_hash: string }) | null {
  const row = db.prepare('SELECT * FROM users WHERE email = ?').get(email) as
    | (Row & { password_hash: string })
    | undefined;
  return row ?? null;
}

export function startSession(reply: FastifyReply, userId: string): void {
  const token = randomBytes(32).toString('base64url');
  const maxAgeSec = config.sessionDays * 24 * 3600;
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(
    token,
    userId,
    now() + maxAgeSec * 1000,
  );
  reply.setCookie(SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: config.cookieSecure,
    maxAge: maxAgeSec,
  });
}

export function endSession(request: FastifyRequest, reply: FastifyReply): void {
  const token = request.cookies[SESSION_COOKIE];
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
}

const sessionStmt = db.prepare(
  'SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires_at > ?',
);

export function userFromRequest(request: FastifyRequest): User | null {
  const token = request.cookies[SESSION_COOKIE];
  if (!token) return null;
  const row = sessionStmt.get(token, now()) as Row | undefined;
  return row ? toUser(row) : null;
}

/** 路由前置钩子：未登录返回 401 */
export async function requireUser(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!request.user) {
    await reply.code(401).send({ error: '请先登录' });
  }
}

export function purgeExpiredSessions(): void {
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now());
}
