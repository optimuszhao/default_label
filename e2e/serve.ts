// E2E 用：起假算子 + 织影服务（读 dist 里的前端构建），数据放在临时目录。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startFakeOperator } from '../scripts/fake-operator.ts';

const operatorPort = Number(process.env.E2E_OPERATOR_PORT) || 9922;
await startFakeOperator(operatorPort);

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'weave-e2e-'));
Object.assign(process.env, {
  PORT: process.env.E2E_PORT || '8799',
  HOST: '127.0.0.1',
  DATA_DIR: dataDir,
  MEDIA_DIR: '',
  PROVIDER: 'comfyweb',
  GEN_API_BASE: `http://127.0.0.1:${operatorPort}`,
  COMFY_APPID: 'dev',
  COMFY_SECRET: 'dev',
  COMFY_IMAGE_POLL_MS: '200',
  COMFY_VIDEO_POLL_MS: '200',
  SCHEDULER_TICK_MS: '200',
  HEALTH_TTL_MS: '500',
  MAX_RUNNING: '4',
  ADMIN_EMAILS: 'admin@e2e.local',
  LLM_API_BASE: '',
});
process.on('exit', () => fs.rmSync(dataDir, { recursive: true, force: true }));
await import('../server/index.ts');
