# 织影 Weave

AI 影像创作平台：文生图、图生图、文生视频、图生视频，加一个面向长篇视频故事的「故事工坊」（大纲 → 角色 → 章节剧本 → 台词 → 分镜 → 成片预览）。界面风格参考 Seedance 2.0，深色、简约，桌面端和手机端都适配。

图像、视频和语言模型由 5090 上的 ComfyUI 提供，通过 HTTP 接口接入，协议见 [docs/API_CONTRACT.md](docs/API_CONTRACT.md)。接口没好之前，默认用内置的**模拟服务**（`PROVIDER=mock`），整套流程不需要 GPU 也能跑通。

## 快速开始

需要 Node.js 22.13 及以上（用到内置的 `node:sqlite`，不需要另装数据库）。

```bash
npm install
npm run dev          # 前端 http://localhost:5173，后端 http://localhost:8787
```

打开 http://localhost:5173 注册账号即可使用。手机在同一局域网下访问 `http://<电脑 IP>:5173`。

生产部署（单端口，后端同时托管前端）：

```bash
npm install
npm run build
npm start            # http://<IP>:8787
```

## Docker 部署（NAS）

镜像包含前后端，单容器、单端口运行。只需要映射两个目录：

| 容器内路径 | 存什么 | 建议 |
| --- | --- | --- |
| `/data` | SQLite 数据库（账号、故事、任务） | 体积很小，放 SSD 更快 |
| `/media` | 生成的图片、视频和上传素材 | 体积大，放 NAS 机械盘 |

素材按「用户 / 日期」分目录，文件名带时间和类型，在 NAS 文件管理器里可以直接按日期浏览：

```text
/media/<用户 id>/2026-10-10/145308-video-a_xxxx.mp4
```

### 步骤

1. 把仓库拷到 NAS 上（或 `git clone`），进入目录。
2. **先建好两个目录并赋予权限**。目录不存在时 Docker 会以 root 创建，容器内的非 root 用户就写不进去：

   ```bash
   mkdir -p /volume1/docker/weave/data /volume1/weave-media
   chown -R 1026:100 /volume1/docker/weave/data /volume1/weave-media   # 换成你的 PUID:PGID
   ```

3. 在同目录建一个 `.env`（docker compose 会自动读取）：

   ```bash
   WEAVE_DATA_DIR=/volume1/docker/weave/data
   WEAVE_MEDIA_DIR=/volume1/weave-media
   PUID=1026            # 群晖用 id 命令查看自己的 uid / gid
   PGID=100
   WEAVE_PORT=8787
   PROVIDER=mock        # 生成服务接好后改为 http
   GEN_API_BASE=        # 例如 http://192.168.1.50:9000
   # Docker Hub 拉取慢时换国内镜像源：
   # NODE_IMAGE=docker.m.daocloud.io/library/node:22-bookworm-slim
   ```

4. 启动：

   ```bash
   docker compose up -d --build
   ```

   浏览器打开 `http://<NAS IP>:8787`。

### 常用操作

- **更新版本**：`git pull && docker compose up -d --build`，数据和素材都在映射的目录里，不受影响。
- **备份**：备份 `/data` 和 `/media` 两个目录即可。备份数据库时最好先 `docker compose stop`，或者用 NAS 快照。
- **查看日志**：`docker compose logs -f weave`
- **外网访问**：前面加反向代理（群晖自带的反向代理、Nginx Proxy Manager 等），走 HTTPS 时在 `.env` 里设 `COOKIE_SECURE=1`。
- **注意**：数据库目录要放在 NAS 本机磁盘上，不要指向 SMB/NFS 网络共享（SQLite 在网络文件系统上可能损坏）。`/media` 不受此限制。
- 模拟服务的演示视频需要 ffmpeg，构建时加 `--build-arg WITH_FFMPEG=1`；接真实生成服务后不需要。

## 功能

| 模块 | 说明 |
| --- | --- |
| 首页 | 动态极光背景、打字机提示词、作品滚动展示、能力介绍 |
| 登录注册 | 邮箱 + 密码，bcrypt 加密，HttpOnly Cookie 会话（30 天） |
| 创作 | 图片 / 视频两种模式。加参考图自动变为图生图，加首帧（可选尾帧）自动变为图生视频。支持比例、分辨率、张数、时长、运镜、反向提示词、种子、步数、CFG、重绘强度；AI 润色提示词；「立即生成」或「加入队列」 |
| 故事工坊 | 设定（类型、基调、统一画风、比例）→ AI 大纲 → AI 角色（外貌描述 + 定妆照，保证镜头间一致）→ AI 拆分章节与场次（可多次追加，支持很长的故事）→ AI 写台词 → AI 设计分镜（景别、运镜、时长、出镜角色、对应台词）→ 逐镜或批量生成关键帧和视频 → 成片预览（按顺序播放，带字幕） |
| 任务队列 | 排队、暂停、继续、取消、重试、调整优先级、立即运行、全部运行。可开关自动调度，并设置服务不可用时的重试间隔（10 秒到 5 分钟） |
| 资产库 | 所有生成和上传的素材，瀑布流 + 无限滚动，可收藏、下载、删除，一键用于图生图或图生视频 |

## 任务队列怎么工作

生成服务有时可用有时不可用，所以所有生成都先进队列：

1. 任务创建后状态为「排队中」。
2. 后台调度器每 2 秒运行一次：
   - 查询正在生成的任务进度，完成后下载结果存为资产，并通过 SSE 实时推送到页面；
   - 把排队任务提交给生成服务（同时运行数由 `MAX_RUNNING` 控制，单卡建议 1）。
3. **服务不可用**（健康检查失败、连不上、5xx）：任务保持排队，标记「等待服务」，按用户设置的间隔重试，不计入失败次数。
4. **生成失败**（服务返回错误）：按 15 秒、30 秒、60 秒…指数退避重试，超过 3 次标记失败，可以手动重试。
5. **自动调度**关闭时，只有点「立即运行」的任务才会提交；开启时服务可用就自动提交。

## 配置（环境变量）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `8787` | 后端端口 |
| `DATA_DIR` | `./data` | 数据库存放目录 |
| `MEDIA_DIR` | `DATA_DIR/files` | 生成的图片、视频和上传素材存放目录 |
| `PROVIDER` | `mock` | `mock` 用模拟服务，`http` 对接真实生成服务 |
| `GEN_API_BASE` | 空 | 生成服务地址，例如 `http://192.168.1.50:9000` |
| `GEN_API_KEY` | 空 | 生成服务鉴权密钥（可选） |
| `MOCK_FLAKY` | 空 | 设为 `1` 时模拟服务会随机不可用，用来演示队列的等待与重试 |
| `MAX_RUNNING` | `1` | 同时提交给生成服务的任务数 |
| `MAX_ATTEMPTS` | `3` | 单任务最多失败次数 |
| `JOB_TIMEOUT_MS` | `1800000` | 单任务超时（30 分钟） |
| `COOKIE_SECURE` | 空 | 通过 HTTPS 访问时设为 `1` |
| `LOG_LEVEL` | `warn` | 后端日志级别 |

## 技术选型

- **前端**：React 19 + Vite + Tailwind CSS 4 + Zustand。按路由拆包，首页和工作台分开加载；动画只用 transform / opacity，交给 GPU 合成；图片懒加载、视频悬停才播放；长列表用 `content-visibility` 跳过屏幕外渲染。
- **后端**：Fastify 5 + Node 内置 SQLite（`node:sqlite`），不需要额外安装数据库。SSE 推送任务进度。
- **生成服务适配层**：`server/providers/`，`mock.ts` 是模拟实现，`http.ts` 是真实接口适配器。

## 目录结构

```text
├── shared/types.ts            前后端共享的数据类型
├── server/
│   ├── index.ts               服务入口
│   ├── routes.ts              全部 REST / SSE 接口
│   ├── scheduler.ts           任务调度器（轮询、重试、落地结果）
│   ├── assist.ts              AI 写作助手（提示词与 JSON 解析）
│   ├── auth.ts / db.ts / files.ts / repo.ts
│   └── providers/             生成服务适配层（mock / http）
├── web/
│   ├── index.html
│   └── src/
│       ├── pages/Landing.tsx  首页
│       ├── pages/Auth.tsx     登录注册
│       └── pages/studio/      工作台：创作 / 故事工坊 / 队列 / 资产 / 设置
└── docs/API_CONTRACT.md       给 ComfyUI 侧的接口协议
```
