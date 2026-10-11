// 读取 PNG 里的文本块：ComfyUI 会把 prompt（节点图输入）和 workflow 写进 tEXt，
// A1111 / Forge 写 parameters。上传这类图片时把生成参数带进资产详情。
import fs from 'node:fs/promises';
import { inflateSync } from 'node:zlib';

export interface PngMeta {
  /** 从节点图里找出来的正向提示词（找得到时） */
  prompt?: string;
  negative?: string;
  seed?: number;
  /** 原始文本块（截断到 20 KB，避免把巨大的 workflow 全塞进数据库） */
  text: Record<string, string>;
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export async function readPngText(file: string): Promise<Record<string, string>> {
  const handle = await fs.open(file, 'r');
  const out: Record<string, string> = {};
  try {
    const head = Buffer.alloc(8);
    await handle.read(head, 0, 8, 0);
    if (!head.equals(SIGNATURE)) return out;
    let position = 8;
    // 文本块都在图像数据之前；最多读 8 MB
    while (position < 8 * 1024 * 1024) {
      const header = Buffer.alloc(8);
      const { bytesRead } = await handle.read(header, 0, 8, position);
      if (bytesRead < 8) break;
      const length = header.readUInt32BE(0);
      const type = header.toString('latin1', 4, 8);
      if (type === 'IDAT' || type === 'IEND') break;
      if ((type === 'tEXt' || type === 'zTXt' || type === 'iTXt') && length < 4 * 1024 * 1024) {
        const body = Buffer.alloc(length);
        await handle.read(body, 0, length, position + 8);
        const zero = body.indexOf(0);
        if (zero > 0) {
          const key = body.toString('latin1', 0, zero);
          let value = '';
          if (type === 'tEXt') value = body.toString('latin1', zero + 1);
          else if (type === 'zTXt') value = inflateSync(body.subarray(zero + 2)).toString('utf8');
          else {
            // iTXt：keyword\0 压缩标志 压缩方法 语言\0 译名\0 文本
            const compressed = body[zero + 1] === 1;
            let rest = body.subarray(zero + 3);
            rest = rest.subarray(rest.indexOf(0) + 1);
            rest = rest.subarray(rest.indexOf(0) + 1);
            value = (compressed ? inflateSync(rest) : rest).toString('utf8');
          }
          out[key] = value.slice(0, 20_000);
        }
      }
      position += 12 + length;
    }
  } catch {
    // 文件损坏就当没有文本块
  } finally {
    await handle.close();
  }
  return out;
}

type Node = { class_type?: string; inputs?: Record<string, unknown> };

/** 从 ComfyUI 的 prompt JSON 里找 CLIPTextEncode 的文本和采样器的种子 */
function fromComfy(json: string): Pick<PngMeta, 'prompt' | 'negative' | 'seed'> {
  try {
    const graph = JSON.parse(json) as Record<string, Node>;
    const nodes = Object.values(graph);
    const texts = nodes
      .filter((node) => /CLIPTextEncode|TextEncode/i.test(node.class_type ?? '') && typeof node.inputs?.text === 'string')
      .map((node) => String(node.inputs!.text));
    const sampler = nodes.find((node) => /KSampler|Sampler/i.test(node.class_type ?? ''));
    const seed = Number(sampler?.inputs?.seed ?? sampler?.inputs?.noise_seed);
    return { prompt: texts[0], negative: texts[1], seed: Number.isFinite(seed) ? seed : undefined };
  } catch {
    return {};
  }
}

/** A1111 的 parameters：第一段是正向，"Negative prompt:" 之后是反向，最后一行有 Seed */
function fromA1111(text: string): Pick<PngMeta, 'prompt' | 'negative' | 'seed'> {
  const [main, ...rest] = text.split('\nNegative prompt:');
  const tail = rest.join('\nNegative prompt:');
  const lines = tail.split('\n');
  const settings = lines.at(-1) ?? '';
  const seed = Number(/Seed:\s*(\d+)/.exec(settings)?.[1] ?? /Seed:\s*(\d+)/.exec(main)?.[1]);
  return {
    prompt: main.split('\nSteps:')[0].trim() || undefined,
    negative: tail ? lines.slice(0, -1).join('\n').trim() || undefined : undefined,
    seed: Number.isFinite(seed) ? seed : undefined,
  };
}

export async function readPngMeta(file: string): Promise<PngMeta | null> {
  const text = await readPngText(file);
  if (!Object.keys(text).length) return null;
  const parsed = text.prompt ? fromComfy(text.prompt) : text.parameters ? fromA1111(text.parameters) : {};
  return { ...parsed, text };
}
