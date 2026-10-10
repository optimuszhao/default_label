// 管理接口：只有 ADMIN_EMAILS 里的账号能访问，其他人一律 404
import type { FastifyInstance } from 'fastify';
import type { TokenStatus } from '../../shared/types.ts';
import { requireAdmin } from '../auth.ts';
import { backupNow, listBackups } from '../backup.ts';
import { publish } from '../bus.ts';
import { getHealth, provider } from '../providers/index.ts';

export async function adminRoutes(admin: FastifyInstance): Promise<void> {
  admin.addHook('preHandler', requireAdmin);
  const unsupported = (): TokenStatus => ({ supported: false, operator: provider.name });

  admin.get('/api/admin/token', async () => provider.tokenStatus?.() ?? unsupported());
  admin.post('/api/admin/token/verify', async () => {
    const result = provider.verifyToken ? await provider.verifyToken() : unsupported();
    void getHealth(true).then((health) => publish('*', { type: 'health', health }));
    return result;
  });
  // 数据库备份：列出、立即备份一次
  admin.get('/api/admin/backups', async () => listBackups().map(({ name, bytes, createdAt }) => ({ name, bytes, createdAt })));
  admin.post('/api/admin/backups', async () => {
    const { name, bytes, createdAt } = await backupNow();
    return { name, bytes, createdAt };
  });
  admin.post('/api/admin/token/renew', async () => {
    const result = provider.renewToken ? await provider.renewToken() : unsupported();
    void getHealth(true).then((health) => publish('*', { type: 'health', health }));
    return result;
  });
}
