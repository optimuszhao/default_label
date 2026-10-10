import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { purgeExpiredSessions, userFromRequest } from './auth.ts';
import { config } from './config.ts';
import { registerRoutes } from './routes.ts';
import { startScheduler } from './scheduler.ts';

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL ?? 'warn' },
  bodyLimit: 8 * 1024 * 1024,
});

await app.register(cookie);
await app.register(multipart, { limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: 1 } });

app.decorateRequest('user', null);
app.addHook('onRequest', async (request) => {
  request.user = userFromRequest(request);
});

// /api/files 用 sendFile 发送，root 在路由里传入
await app.register(fastifyStatic, {
  root: path.join(config.dataDir, 'files'),
  serve: false,
});

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
      }
    },
  });
  const indexHtml = fs.readFileSync(path.join(config.webDist, 'index.html'));
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/')) return reply.code(404).send({ error: 'Not Found' });
    return reply.type('text/html').header('cache-control', 'no-cache').send(indexHtml);
  });
}

const stopScheduler = startScheduler();
purgeExpiredSessions();
setInterval(purgeExpiredSessions, 6 * 3600 * 1000).unref();

await app.listen({ port: config.port, host: config.host });
console.log(`[weave] server ready on http://localhost:${config.port}  provider=${config.provider}`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    stopScheduler();
    await app.close();
    process.exit(0);
  });
}
