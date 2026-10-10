// 联调用：直接调用朋友的 ComfyUI Web API，打印每一步的原始响应。
// 用法：npm run probe:comfy -- [t2i|t2v]
// 需要 .env 里配置 GEN_API_BASE、COMFY_APPID、COMFY_SECRET（或直接给 COMFY_TOKEN）。
const base = (process.env.GEN_API_BASE ?? '').replace(/\/+$/, '');
const type = process.argv[2] === 't2v' ? 't2v' : 't2i';
if (!base) {
  console.error('请先在 .env 里设置 GEN_API_BASE');
  process.exit(1);
}

async function show(label: string, response: Response) {
  const text = await response.text();
  console.log(`\n=== ${label} → HTTP ${response.status}\n${text.slice(0, 3000)}`);
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

await show('GET /health', await fetch(`${base}/health`));

let token = process.env.COMFY_TOKEN ?? '';
if (!token) {
  const login = await show(
    'POST /api/auth/login',
    await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ appid: process.env.COMFY_APPID, secret: process.env.COMFY_SECRET }),
    }),
  );
  token = login?.token ?? '';
  if (!token) process.exit(1);
}
const auth = { authorization: `Bearer ${token}` };

await show('GET /api/auth/verify', await fetch(`${base}/api/auth/verify`, { headers: auth }));

const submitted = await show(
  `POST /api/generate/${type === 't2i' ? 'text2img' : 'text2video'}`,
  await fetch(`${base}/api/generate/${type === 't2i' ? 'text2img' : 'text2video'}`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify(
      type === 't2i'
        ? { prompt: '一只橘猫坐在窗台上，晨光', width: 768, height: 512, steps: 20, seed: 0 }
        : { prompt: '海浪拍打礁石，慢镜头', duration: 4, width: 768, height: 448, seed: 0 },
    ),
  }),
);
const id = submitted?.task_id;
if (id === undefined) {
  console.error('\n没有在提交响应里找到任务号，请把上面的输出发给织影开发者。');
  process.exit(1);
}

// 对方建议：图片 3–5 秒查一次，视频 10–15 秒查一次
const every = type === 't2i' ? 4 : 12;
for (let i = 0; i < 600; i++) {
  const response = await fetch(`${base}/api/tasks/${id}`, { headers: auth });
  const text = await response.text();
  const data = JSON.parse(text);
  process.stdout.write(`\r[${i * every}s] status=${data.status} stage=${data.stage ?? '-'}          `);
  if (['completed', 'failed'].includes(data.status)) {
    console.log(`\n\n=== 最终 GET /api/tasks/${id}\n${text}`);
    const result = data.result ?? {};
    const file = (result.upscaled?.length ? result.upscaled : result.files ?? [])[0];
    if (file) {
      const download = await fetch(`${base}/api/products/download/${result.category ?? (type === 't2i' ? 'image' : 'video')}/${file}`, { headers: auth });
      const size = (await download.arrayBuffer()).byteLength;
      console.log(`\n=== 下载 ${file} → HTTP ${download.status}，${(size / 1024 / 1024).toFixed(2)} MB，${download.headers.get('content-type')}`);
    }
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, every * 1000));
}

await show('GET /api/products', await fetch(`${base}/api/products`, { headers: auth }));
