# 生成服务接口协议（给 ComfyUI 侧同事）

织影的后端只通过下面这 5 个 HTTP 接口调用生成服务。ComfyUI 那边（MiniMax 视频模型、千问 Image 图像模型、语言大模型）只要按这份协议包一层，织影这边**不用改任何业务代码**，把环境变量切到 `PROVIDER=http` 即可。

如果最终接口和这里不一样也没关系，只需要改 `server/providers/http.ts` 这一个文件。

## 通用约定

- 基础地址：由织影的环境变量 `GEN_API_BASE` 配置，例如 `http://192.168.1.50:9000`
- 鉴权（可选）：如果配置了 `GEN_API_KEY`，每个请求都会带上 `Authorization: Bearer <GEN_API_KEY>`
- 请求和响应都是 JSON（`content-type: application/json`）
- 错误码含义：
  - `5xx`、`429`、网络不通：织影认为**服务暂时不可用**，任务继续排队，过一段时间自动重试，**不计入失败次数**
  - `4xx`（429 除外）：织影认为**这个任务本身有问题**，计一次失败，按指数退避重试，最多 3 次

## 1. 健康检查

```
GET /health
```

响应：

```json
{ "image": true, "video": true, "llm": false, "message": "LLM 正在加载" }
```

三个字段分别表示图像生成、视频生成、语言模型当前是否可用。织影每 10 秒左右检查一次，某个能力为 `false` 时，对应类型的任务会留在队列里等待。`message` 可选，会显示在界面上。

## 2. 提交生成任务

```
POST /v1/jobs
```

请求：

```json
{
  "client_task_id": "t_xxxx",
  "type": "i2v",
  "prompt": "镜头缓慢推进，少女转身微笑……",
  "negative_prompt": "模糊，低质量",
  "params": {
    "aspect_ratio": "16:9",
    "resolution": "720p",
    "width": 1280,
    "height": 720,
    "count": 1,
    "seed": null,
    "steps": 30,
    "cfg": 7,
    "strength": 0.65,
    "duration": 5,
    "fps": 24,
    "camera_motion": "推镜",
    "model": null
  },
  "images": [
    { "role": "first_frame", "mime": "image/png", "data_base64": "iVBORw0..." }
  ]
}
```

| 字段 | 说明 |
| --- | --- |
| `type` | `t2i` 文生图、`i2i` 图生图、`t2v` 文生视频、`i2v` 图生视频 |
| `params.width/height` | 已按比例算好，并对齐到 16 的倍数 |
| `params.count` | 图片张数（1~4），视频固定为 1 |
| `params.seed` | `null` 表示随机 |
| `params.steps / cfg / strength / camera_motion / model` | 可能不存在，不存在时用你那边的默认值 |
| `params.duration / fps` | 仅视频任务有 |
| `images[].role` | `reference`：图生图参考图（可能多张，也用于角色一致性）；`first_frame` / `last_frame`：图生视频首帧 / 尾帧 |

响应：

```json
{ "job_id": "comfy-prompt-id-123" }
```

建议这里只把任务放进 ComfyUI 队列就立刻返回，不要等生成完。

## 3. 查询任务状态

```
GET /v1/jobs/{job_id}
```

响应：

```json
{
  "state": "running",
  "progress": 0.42,
  "error": null,
  "outputs": []
}
```

- `state`：`pending` | `running` | `succeeded` | `failed`
- `progress`：0~1，可选，用来在界面上显示进度条
- `succeeded` 时 `outputs` 必须有内容：

```json
{
  "state": "succeeded",
  "outputs": [
    { "kind": "video", "mime": "video/mp4", "url": "/view?filename=xxx.mp4", "width": 1280, "height": 720 }
  ]
}
```

每个输出给 `url` 或 `base64` 二选一。`url` 可以是绝对地址，也可以是以 `/` 开头的相对地址（织影会拼上 `GEN_API_BASE`）。织影会下载并保存结果，之后不再依赖这个地址。

织影大约每 2 秒查一次正在生成的任务；超过 30 分钟（`JOB_TIMEOUT_MS`）还没完成，会被视为超时失败。

## 4. 取消任务

```
POST /v1/jobs/{job_id}/cancel
```

响应随意（例如 `{}`）。用户在队列里点“取消”时调用，尽力而为即可。

## 5. 语言模型对话（AI 写作助手）

```
POST /v1/chat
```

请求：

```json
{
  "messages": [
    { "role": "system", "content": "你是一名资深影视编剧……只输出 JSON" },
    { "role": "user", "content": "根据一句话故事写大纲……输出格式：{\"title\": \"\", \"outline\": \"\"}" }
  ],
  "temperature": 0.85,
  "response_format": "json"
}
```

响应：

```json
{ "content": "{\"title\": \"回声之城\", \"outline\": \"……\"}" }
```

`content` 是模型的原始文本输出。织影会自己解析 JSON（能容忍外面包了 ```json 代码块），提示词也由织影负责组装，你那边只要把 `messages` 原样喂给模型就行。这个接口是同步的，最长等待 3 分钟。

## 在织影这边启用

```bash
PROVIDER=http \
GEN_API_BASE=http://<5090 机器 IP>:<端口> \
GEN_API_KEY=<可选> \
npm start
```

启动后，在「设置」或「任务队列」页能看到图像 / 视频 / 文案三个服务的状态灯。
