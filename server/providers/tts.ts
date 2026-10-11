// 配音（TTS）：对接任何 OpenAI 兼容的 /v1/audio/speech 接口（TTS_API_BASE / TTS_API_KEY / TTS_MODEL / TTS_VOICE）。
// 没配置时用模拟配音：按字数估算时长，生成一段很轻的提示音 WAV（纯 JS 生成，不依赖 ffmpeg），先把流程走通。
import { estimateSpeech } from '../../shared/film.ts';
import { config } from '../config.ts';

export interface SpeechResult {
  data: Buffer;
  mime: string;
  /** 模拟配音时已知时长；真实接口返回的音频由后台作业探测时长 */
  duration: number | null;
  mock: boolean;
}

export function ttsMode(): 'api' | 'mock' {
  return config.ttsApiBase ? 'api' : 'mock';
}

export async function synthesize(text: string, options: { voice?: string | null; emotion?: string | null; signal?: AbortSignal } = {}): Promise<SpeechResult> {
  if (ttsMode() === 'mock') return mockSpeech(text);
  const base = config.ttsApiBase.replace(/\/+$/, '').replace(/\/v1$/, '');
  const response = await fetch(`${base}/v1/audio/speech`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(config.ttsApiKey ? { authorization: `Bearer ${config.ttsApiKey}` } : {}) },
    body: JSON.stringify({
      model: config.ttsModel || 'tts-1',
      input: text,
      voice: options.voice || config.ttsVoice || 'alloy',
      response_format: 'mp3',
      ...(options.emotion ? { instructions: `语气：${options.emotion}` } : {}),
    }),
    signal: options.signal ?? AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error(`配音接口返回 ${response.status}：${(await response.text()).slice(0, 200)}`);
  const mime = response.headers.get('content-type')?.split(';')[0] || 'audio/mpeg';
  return { data: Buffer.from(await response.arrayBuffer()), mime: mime.startsWith('audio/') ? mime : 'audio/mpeg', duration: null, mock: false };
}

/** 模拟配音：16 kHz 单声道 WAV，每个字一声很轻的"嘀"，时长按字数估算 */
export function mockSpeech(text: string): SpeechResult {
  const duration = estimateSpeech(text);
  const rate = 16_000;
  const samples = Math.round(duration * rate);
  const data = Buffer.alloc(44 + samples * 2);
  data.write('RIFF', 0);
  data.writeUInt32LE(36 + samples * 2, 4);
  data.write('WAVE', 8);
  data.write('fmt ', 12);
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20);
  data.writeUInt16LE(1, 22);
  data.writeUInt32LE(rate, 24);
  data.writeUInt32LE(rate * 2, 28);
  data.writeUInt16LE(2, 32);
  data.writeUInt16LE(16, 34);
  data.write('data', 36);
  data.writeUInt32LE(samples * 2, 40);
  const beat = rate / 4; // 每秒 4 个字
  for (let i = 0; i < samples; i++) {
    const inBeat = i % beat;
    const envelope = inBeat < rate * 0.06 ? Math.sin((Math.PI * inBeat) / (rate * 0.06)) : 0;
    data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 660 * i) / rate) * envelope * 2500), 44 + i * 2);
  }
  return { data, mime: 'audio/wav', duration, mock: true };
}
