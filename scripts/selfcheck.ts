// NAS 自检：一条命令检查运行环境、数据目录、备份和算子连通性，输出一份 Markdown 报告，
// 直接把输出贴回给开发者即可。
//
//   docker compose exec weave node scripts/selfcheck.ts              # 基础检查
//   docker compose exec weave node scripts/selfcheck.ts --generate   # 另外用真实算子出 1 张小图
//
// 本地：npm run selfcheck [-- --generate]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const env = process.env;
const lines: string[] = [];
const out = (line = '') => lines.push(line);
const ok = (good: boolean) => (good ? '✅' : '❌');
const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const gb = (bytes: number) => `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;

const dataDir = path.resolve(env.DATA_DIR?.trim() || 'data');
const mediaDir = path.resolve(env.MEDIA_DIR?.trim() || path.join(dataDir, 'files'));
const base = (env.GEN_API_BASE ?? '').trim().replace(/\/+$/, '');
const generate = process.argv.includes('--generate');

function version(): string {
  try {
    return (JSON.parse(fs.readFileSync('package.json', 'utf8')) as { version: string }).version;
  } catch {
    return '?';
  }
}

function disk(dir: string): string {
  try {
    const stat = fs.statfsSync(dir);
    const free = stat.bavail * stat.bsize;
    const total = stat.blocks * stat.bsize;
    return `${gb(free)} 可用 / ${gb(total)}${free < 5 * 1024 ** 3 ? ' ⚠ 不足 5 GB' : ''}`;
  } catch (error) {
    return `读取失败：${(error as Error).message}`;
  }
}

function writable(dir: string): boolean {
  try {
    const probe = path.join(dir, `.selfcheck-${process.pid}`);
    fs.writeFileSync(probe, 'ok');
    fs.rmSync(probe);
    return true;
  } catch {
    return false;
  }
}

async function timed<T>(fn: () => Promise<T>): Promise<{ ms: number; value?: T; error?: string }> {
  const start = performance.now();
  try {
    const value = await fn();
    return { ms: Math.round(performance.now() - start), value };
  } catch (error) {
    return { ms: Math.round(performance.now() - start), error: (error as Error).message };
  }
}

out(`# 织影自检报告`);
out();
out(`- 时间：${new Date().toLocaleString('zh-CN')}`);
out(`- 版本：v${version()}${env.GIT_SHA ? `（${env.GIT_SHA.slice(0, 7)}）` : ''}，Node ${process.version}`);
out();

// ---- 运行环境 ----
const cpus = os.cpus();
out('## 运行环境');
out();
out(`- CPU：${os.arch()}，${cpus.length} 核，${cpus[0]?.model ?? '未知型号'}`);
out(`- 内存：${gb(os.totalmem())}，当前可用 ${gb(os.freemem())}`);
out(`- 系统负载（1/5/15 分钟）：${os.loadavg().map((n) => n.toFixed(2)).join(' / ')}`);
out(`- 时区：${Intl.DateTimeFormat().resolvedOptions().timeZone}`);
out();

// ---- 数据目录 ----
out('## 数据目录');
out();
out(`- 数据库目录 \`${dataDir}\`：${ok(writable(dataDir))} 可写，${disk(dataDir)}`);
out(`- 媒体目录 \`${mediaDir}\`：${ok(fs.existsSync(mediaDir) && writable(mediaDir))} 可写，${disk(mediaDir)}`);
const dbFile = path.join(dataDir, 'weave.db');
if (fs.existsSync(dbFile)) {
  const db = new DatabaseSync(dbFile, { readOnly: true });
  const quick = (db.prepare('PRAGMA quick_check').get() as { quick_check: string }).quick_check;
  const count = (table: string) => {
    try {
      return Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
    } catch {
      return 0;
    }
  };
  out(`- 数据库：${mb(fs.statSync(dbFile).size)}，完整性 ${ok(quick === 'ok')} ${quick}`);
  out(`- 数据量：用户 ${count('users')}，故事 ${count('stories')}，任务 ${count('tasks')}，资产 ${count('assets')}`);
  try {
    const rows = db.prepare('SELECT id FROM schema_migrations ORDER BY id').all() as { id: string }[];
    out(`- 迁移：${rows.map((row) => row.id).join('、') || '无'}`);
  } catch {
    out('- 迁移：尚未执行（启动一次服务会自动执行）');
  }
  db.close();
} else {
  out('- 数据库：还不存在（第一次启动服务时创建）');
}
const backupDir = path.join(dataDir, 'backups');
const backups = fs.existsSync(backupDir) ? fs.readdirSync(backupDir).filter((name) => /^weave-.*\.db\.gz$/.test(name)).sort() : [];
out(`- 每日备份：${backups.length} 份${backups.length ? `，最新 ${backups.at(-1)}` : ''}（每天 ${env.BACKUP_AT ?? '03:30'}）`);
out();

// ---- 算子 ----
out('## 生成服务（算子）');
out();
out(`- 适配器：\`${env.PROVIDER ?? 'mock'}\`，地址：\`${base || '未配置'}\``);
if (base && (env.PROVIDER ?? 'mock') !== 'mock') {
  const probes = [];
  for (let i = 0; i < 3; i++) probes.push(await timed(async () => (await fetch(`${base}/health`, { signal: AbortSignal.timeout(8000) })).status));
  out(`- 连通性（GET /health ×3）：${probes.map((p) => (p.error ? `失败(${p.error})` : `HTTP ${p.value} ${p.ms}ms`)).join('，')}`);

  if (env.COMFY_APPID && env.COMFY_SECRET) {
    const login = await timed(async () => {
      const response = await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ appid: env.COMFY_APPID, secret: env.COMFY_SECRET }),
        signal: AbortSignal.timeout(15000),
      });
      const body = (await response.json().catch(() => ({}))) as { token?: string; detail?: unknown };
      if (!response.ok || !body.token) throw new Error(`HTTP ${response.status} ${JSON.stringify(body.detail ?? body).slice(0, 120)}`);
      return body.token;
    });
    out(`- 换取令牌：${login.error ? `❌ ${login.error}` : `✅ ${login.ms}ms，令牌 ${login.value!.slice(0, 6)}…（${login.value!.split('.').length === 3 ? 'JWT' : '非 JWT'}）`}`);
    const token = login.value;
    if (token) {
      const auth = { authorization: `Bearer ${token}` };
      const verify = await timed(async () => {
        const response = await fetch(`${base}/api/auth/verify`, { headers: auth, signal: AbortSignal.timeout(8000) });
        return `HTTP ${response.status} ${(await response.text()).slice(0, 120)}`;
      });
      out(`- 校验令牌：${verify.error ? `❌ ${verify.error}` : `${verify.value}（${verify.ms}ms）`}`);

      if (generate) {
        const run = await timed(async () => {
          const submit = await fetch(`${base}/api/generate/text2img`, {
            method: 'POST',
            headers: { ...auth, 'content-type': 'application/json' },
            body: JSON.stringify({ prompt: '一只橘猫坐在窗台上，晨光，自检用', width: 512, height: 512, steps: 12, seed: 0 }),
          });
          const { task_id: id } = (await submit.json()) as { task_id?: string };
          if (!id) throw new Error(`提交失败 HTTP ${submit.status}`);
          const deadline = Date.now() + 5 * 60_000;
          for (;;) {
            const task = (await (await fetch(`${base}/api/tasks/${id}`, { headers: auth })).json()) as {
              status: string;
              error?: string;
              result?: { category?: string; files?: string[] };
            };
            if (task.status === 'completed') {
              const file = task.result?.files?.[0];
              if (!file) return `完成，但结果里没有文件：${JSON.stringify(task.result)}`;
              const download = await timed(async () => {
                const response = await fetch(`${base}/api/products/download/${task.result?.category ?? 'image'}/${file}`, { headers: auth });
                return `HTTP ${response.status}，${mb((await response.arrayBuffer()).byteLength)}`;
              });
              return `任务 ${id} 完成；下载 ${file}：${download.value ?? download.error}（${download.ms}ms）`;
            }
            if (task.status === 'failed') throw new Error(`任务失败：${task.error}`);
            if (Date.now() > deadline) throw new Error(`5 分钟内没有完成，最后状态 ${task.status}`);
            await new Promise((resolve) => setTimeout(resolve, 3000));
          }
        });
        out(`- 实际出图（512×512）：${run.error ? `❌ ${run.error}` : `✅ ${run.value}，总耗时 ${(run.ms / 1000).toFixed(1)} 秒`}`);
      } else {
        out('- 实际出图：未执行（加 `--generate` 参数会用真实算子出 1 张小图）');
      }
    }
  } else {
    out('- 换取令牌：❌ 没有配置 COMFY_APPID / COMFY_SECRET');
  }
} else {
  out('- 使用模拟服务，跳过算子检查');
}
out();

// ---- 织影服务 ----
const port = env.PORT ?? '8787';
const ready = await timed(async () => {
  const response = await fetch(`http://127.0.0.1:${port}/readyz`, { signal: AbortSignal.timeout(5000) });
  return `HTTP ${response.status} ${await response.text()}`;
});
out('## 织影服务');
out();
out(`- 就绪探针（/readyz）：${ready.error ? `未运行或连不上（${ready.error}）` : ready.value}`);

console.log(lines.join('\n'));
