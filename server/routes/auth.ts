// 注册、登录、登出、当前用户
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { SiteInfo } from '../../shared/types.ts';
import { createUser, endSession, findUserByEmail, hashPassword, startSession, verifyPassword } from '../auth.ts';
import { config } from '../config.ts';
import { getUserSettings, toUser } from '../repo.ts';
import { bad, parse } from './common.ts';

const credentials = z.object({
  email: z.string().trim().toLowerCase().email('邮箱格式不正确'),
  password: z.string().min(6, '密码至少 6 位').max(128),
});
const registerSchema = credentials.extend({ name: z.string().trim().min(1, '请填写昵称').max(40) });

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/auth/register', async (request, reply) => {
    const body = parse(registerSchema, request.body, reply);
    if (!body) return;
    if (config.registration === 'closed' && !config.adminEmails.includes(body.email)) {
      return bad(reply, '暂未开放注册，请联系管理员', 403);
    }
    if (findUserByEmail(body.email)) return bad(reply, '该邮箱已注册', 409);
    const user = createUser(body.email, body.name, await hashPassword(body.password));
    startSession(reply, user.id);
    return { user, settings: getUserSettings(user.id) };
  });

  app.post('/api/auth/login', async (request, reply) => {
    const body = parse(credentials, request.body, reply);
    if (!body) return;
    const row = findUserByEmail(body.email);
    if (!row || !(await verifyPassword(body.password, row.password_hash))) {
      return bad(reply, '邮箱或密码错误', 401);
    }
    startSession(reply, String(row.id));
    return { user: toUser(row), settings: getUserSettings(String(row.id)) };
  });

  app.post('/api/auth/logout', async (request, reply) => {
    endSession(request, reply);
    return { ok: true };
  });

  app.get('/api/auth/me', async (request) => {
    const site: SiteInfo = { registration: config.registration };
    if (!request.user) return { user: null, settings: null, site };
    return { user: request.user, settings: getUserSettings(request.user.id), site };
  });
}
