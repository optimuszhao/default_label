// 应用工厂：组装 Fastify 实例（插件、路由、静态资源、错误处理），不监听端口、不启动调度器，
// 测试和入口文件都从这里拿 app。
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyBaseLogger, type FastifyError } from 'fastify';
import { promoteConfiguredAdmins, userFromRequest } from './auth.ts';
import { config } from './config.ts';
import { db, migration } from './db.ts';
import { logger } from './log.ts';
import { seedCatalog } from './catalog.ts';
import { registerAllJobs } from './jobs/index.ts';
import { importOperatorFromEnv, loadOperators } from './providers/index.ts';
import { registerRoutes } from './routes/index.ts';

export async function buildApp() {
  importOperatorFromEnv();
  loadOperators();
  promoteConfiguredAdmins();
  seedCatalog();
  registerAllJobs();
  const app = Fastify({
    loggerInstance: logger as FastifyBaseLogger,
    bodyLimit: 8 * 1024 * 1024,
    // 每个请求一个短编号，出错时返回给前端，排查时按编号搜日志
    genReqId: () => randomBytes(6).toString('base64url'),
    requestIdHeader: 'x-request-id',
    // 默认每个请求两行日志太吵（SSE、轮询很多），改为只记录出错和慢请求
    disableRequestLogging: true,
  });

  app.addHook('onSend', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });
  app.addHook('onResponse', async (request, reply) => {
    const ms = reply.elapsedTime;
    const fields = { reqId: request.id, method: request.method, url: request.url.split('?')[0], status: reply.statusCode, ms: Math.round(ms) };
    if (reply.statusCode >= 500) request.log.error(fields, '请求失败');
    else if (ms > 2000 && !request.url.startsWith('/api/events')) request.log.warn(fields, '慢请求');
    else request.log.debug(fields, '请求');
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    const status = error.statusCode && error.statusCode >= 400 ? error.statusCode : 500;
    if (status >= 500) request.log.error({ err: error, reqId: request.id }, '未处理的错误');
    void reply.code(status).send({
      error: status >= 500 ? '服务器内部错误，请稍后再试' : error.message,
      requestId: request.id,
    });
  });

  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: 1 } });

  app.decorateRequest('user', null);
  app.addHook('onRequest', async (request) => {
    request.user = userFromRequest(request);
  });

  // 存活与就绪探针（Docker 健康检查用 /readyz）
  app.get('/healthz', async () => ({ ok: true }));
  app.get('/readyz', async (_request, reply) => {
    try {
      db.prepare('SELECT 1').get();
    } catch (error) {
      return reply.code(503).send({ ready: false, error: (error as Error).message });
    }
    return { ready: true, migrations: migration.applied.length ? migration.applied : 'up-to-date' };
  });
  app.get('/api/version', async () => ({ version: config.appVersion, gitSha: config.gitSha || null, node: process.version }));

  // /api/files 用 sendFile 发送，root 在路由里传入
  await app.register(fastifyStatic, { root: config.mediaDir, serve: false });

  await registerRoutes(app);

  // 生产模式下由同一个进程托管前端构建产物，单端口部署
  if (fs.existsSync(config.webDist)) {
    await app.register(fastifyStatic, {
      root: config.webDist,
      prefix: '/',
      decorateReply: false,
      wildcard: false,
      setHeaders(res, filePath) {
        if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          res.header('cache-control', 'public, max-age=31536000, immutable');
        } else if (filePath.endsWith('sw.js') || filePath.endsWith('.webmanifest')) {
          res.header('cache-control', 'no-cache');
        }
      },
    });
    const indexHtml = fs.readFileSync(path.join(config.webDist, 'index.html'));
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/')) return reply.code(404).send({ error: 'Not Found', requestId: request.id });
      return reply.type('text/html').header('cache-control', 'no-cache').send(indexHtml);
    });
  }

  return app;
}
