// 本地模拟生成服务：不需要 GPU，用来开发和演示整套流程。
// - 图片：根据提示词生成一张抽象渐变 SVG
// - 视频：本机有 ffmpeg 时生成一段渐变流动的 mp4，否则退化为动态 SVG
// - LLM：返回占位文本（故事助手的模拟输出在 assist.ts 里）
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { config } from '../config.ts';
import {
  ProviderUnavailableError,
  type ChatMessage,
  type JobStatus,
  type Provider,
  type ProviderOutput,
  type SubmitInput,
} from './types.ts';

interface MockJob {
  input: SubmitInput;
  startedAt: number;
  durationMs: number;
  outputs: Promise<ProviderOutput[]> | null;
  canceled: boolean;
}

const jobs = new Map<string, MockJob>();

function hashNumbers(text: string, count: number): number[] {
  const digest = createHash('sha256').update(text).digest();
  return Array.from({ length: count }, (_, index) => digest[index % digest.length]);
}

const PALETTES = [
  ['#7c3aed', '#06b6d4', '#f43f5e'],
  ['#0ea5e9', '#22d3ee', '#a3e635'],
  ['#f97316', '#ec4899', '#8b5cf6'],
  ['#14b8a6', '#6366f1', '#f59e0b'],
  ['#e11d48', '#7c3aed', '#0891b2'],
  ['#84cc16', '#06b6d4', '#3b82f6'],
];

function palette(seedText: string): string[] {
  const [a] = hashNumbers(seedText, 1);
  return PALETTES[a % PALETTES.length];
}

function escapeXml(text: string): string {
  return text.replace(/[<>&'"]/g, (char) => `&#${char.charCodeAt(0)};`);
}

function mockSvg(input: SubmitInput, index: number, animated: boolean): string {
  const width = input.params.width || 1024;
  const height = input.params.height || 1024;
  const seedText = `${input.prompt}#${input.params.seed ?? input.taskId}#${index}`;
  const [c0, c1, c2] = palette(seedText);
  const n = hashNumbers(seedText, 12);
  const blobs = [0, 1, 2, 3].map((i) => {
    const cx = (n[i] / 255) * width;
    const cy = (n[i + 4] / 255) * height;
    const r = (0.25 + (n[i + 8] / 255) * 0.35) * Math.max(width, height);
    const color = [c0, c1, c2, c1][i];
    const animation = animated
      ? `<animate attributeName="cx" values="${cx};${width - cx};${cx}" dur="${6 + i * 2}s" repeatCount="indefinite"/>`
      : '';
    return `<circle cx="${cx.toFixed(0)}" cy="${cy.toFixed(0)}" r="${r.toFixed(0)}" fill="${color}" opacity="0.75">${animation}</circle>`;
  });
  const caption = escapeXml(input.prompt.slice(0, 60) || 'Weave mock');
  const fontSize = Math.round(Math.min(width, height) / 28);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
<defs>
  <filter id="b" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="${Math.round(Math.min(width, height) / 9)}"/></filter>
  <linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#05060a"/><stop offset="1" stop-color="#111325"/></linearGradient>
</defs>
<rect width="100%" height="100%" fill="url(#g)"/>
<g filter="url(#b)">${blobs.join('')}</g>
<text x="${fontSize * 1.5}" y="${height - fontSize * 1.6}" fill="rgba(255,255,255,0.78)" font-family="sans-serif" font-size="${fontSize}">${caption}</text>
<text x="${fontSize * 1.5}" y="${fontSize * 2.2}" fill="rgba(255,255,255,0.45)" font-family="monospace" font-size="${Math.round(fontSize * 0.7)}">MOCK · ${input.type.toUpperCase()} · ${width}×${height}</text>
</svg>`;
}

let ffmpegAvailable: Promise<boolean> | null = null;
function hasFfmpeg(): Promise<boolean> {
  ffmpegAvailable ??= new Promise((resolve) => {
    const child = spawn('ffmpeg', ['-version'], { stdio: 'ignore' });
    child.on('error', () => resolve(false));
    child.on('exit', (code) => resolve(code === 0));
  });
  return ffmpegAvailable;
}

async function mockVideo(input: SubmitInput, index: number): Promise<ProviderOutput> {
  // 预览用，分辨率减半，避免 mock 太占 CPU
  const width = Math.max(2, Math.round((input.params.width || 1280) / 4) * 2);
  const height = Math.max(2, Math.round((input.params.height || 720) / 4) * 2);
  if (await hasFfmpeg()) {
    const colors = palette(`${input.prompt}#${input.params.seed ?? input.taskId}#${index}`).map((c) =>
      c.replace('#', '0x'),
    );
    const duration = Math.min(Math.max(input.params.duration ?? 4, 1), 10);
    const file = path.join(os.tmpdir(), `weave-mock-${input.taskId}-${index}.mp4`);
    const ok = await new Promise<boolean>((resolve) => {
      const child = spawn(
        'ffmpeg',
        [
          '-v', 'error', '-y', '-f', 'lavfi',
          '-i', `gradients=s=${width}x${height}:c0=${colors[0]}:c1=${colors[1]}:c2=${colors[2]}:n=3:speed=0.02:d=${duration}:r=24`,
          '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', file,
        ],
        { stdio: 'ignore' },
      );
      child.on('error', () => resolve(false));
      child.on('exit', (code) => resolve(code === 0));
    });
    if (ok) {
      const data = await fs.readFile(file);
      await fs.rm(file, { force: true });
      return { kind: 'video', mime: 'video/mp4', base64: data.toString('base64'), width, height };
    }
  }
  return {
    kind: 'video',
    mime: 'image/svg+xml',
    base64: Buffer.from(mockSvg(input, index, true)).toString('base64'),
    width: input.params.width,
    height: input.params.height,
  };
}

async function buildOutputs(input: SubmitInput): Promise<ProviderOutput[]> {
  const count = Math.min(Math.max(input.params.count || 1, 1), 4);
  const outputs: ProviderOutput[] = [];
  for (let index = 0; index < count; index++) {
    if (input.type === 't2v' || input.type === 'i2v') {
      outputs.push(await mockVideo(input, index));
    } else {
      outputs.push({
        kind: 'image',
        mime: 'image/svg+xml',
        base64: Buffer.from(mockSvg(input, index, false)).toString('base64'),
        width: input.params.width,
        height: input.params.height,
      });
    }
  }
  return outputs;
}

/** MOCK_FLAKY=1 时，每分钟随机决定各能力是否可用，用来演示任务队列的等待与重试 */
function flakyAvailable(capability: string): boolean {
  if (!config.mockFlaky) return true;
  const minute = Math.floor(Date.now() / 60_000);
  const [value] = hashNumbers(`${capability}-${minute}`, 1);
  return value % 3 !== 0;
}

export class MockProvider implements Provider {
  readonly name = 'mock';

  async health() {
    return {
      image: flakyAvailable('image'),
      video: flakyAvailable('video'),
      llm: flakyAvailable('llm'),
      message: config.mockFlaky ? '模拟服务（不稳定模式）' : '模拟服务',
    };
  }

  async submit(input: SubmitInput) {
    const capability = input.type.endsWith('v') ? 'video' : 'image';
    if (!flakyAvailable(capability)) throw new ProviderUnavailableError('模拟服务暂时不可用');
    const jobId = `mock_${input.taskId}_${Date.now()}`;
    const isVideo = capability === 'video';
    jobs.set(jobId, {
      input,
      startedAt: Date.now(),
      durationMs: (isVideo ? 9000 : 3500) + Math.random() * 2000,
      outputs: null,
      canceled: false,
    });
    return { jobId };
  }

  async poll(jobId: string): Promise<JobStatus> {
    const job = jobs.get(jobId);
    if (!job) return { state: 'failed', error: '任务不存在（服务可能已重启）' };
    if (job.canceled) return { state: 'failed', error: '已取消' };
    const elapsed = Date.now() - job.startedAt;
    if (elapsed < job.durationMs) {
      const progress = Math.min(0.95, elapsed / job.durationMs);
      const video = job.input.type.endsWith('v');
      const stage = progress < 0.1 ? '在生成服务排队中' : video && progress > 0.8 ? '转码 / 超分中' : video ? '视频生成中' : '图片生成中';
      return { state: 'running', progress, stage };
    }
    job.outputs ??= buildOutputs(job.input);
    const outputs = await job.outputs;
    jobs.delete(jobId);
    return { state: 'succeeded', progress: 1, outputs };
  }

  async cancel(jobId: string) {
    const job = jobs.get(jobId);
    if (job) job.canceled = true;
  }

  async chat(messages: ChatMessage[]) {
    const last = messages.at(-1)?.content ?? '';
    return `（模拟 LLM 输出）${last.slice(0, 200)}`;
  }
}
