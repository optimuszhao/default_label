// 路由注册：公开接口、管理接口、需要登录的接口
import type { FastifyInstance } from 'fastify';
import { requireUser } from '../auth.ts';
import { adminRoutes } from './admin.ts';
import { assetRoutes } from './assets.ts';
import { assistRoutes } from './assist.ts';
import { authRoutes } from './auth.ts';
import { catalogRoutes } from './catalog.ts';
import { storyRoutes } from './stories.ts';
import { publicSystemRoutes, systemRoutes } from './system.ts';
import { taskRoutes } from './tasks.ts';

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  await app.register(authRoutes);
  await app.register(publicSystemRoutes);
  await app.register(adminRoutes);
  await app.register(async (api) => {
    api.addHook('preHandler', requireUser);
    await api.register(systemRoutes);
    await api.register(taskRoutes);
    await api.register(assetRoutes);
    await api.register(storyRoutes);
    await api.register(assistRoutes);
    await api.register(catalogRoutes);
  });
}
