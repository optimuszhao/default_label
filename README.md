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

没有 GPU 也能完整联调：`npm run fake:operator` 会起一个按朋友接口文档实现的假算子（`http://127.0.0.1:9911`，appid / secret 都是 `dev`），`.env` 里设 `PROVIDER=comfyweb`、`GEN_API_BASE=http://127.0.0.1:9911`、`COMFY_APPID=dev`、`COMFY_SECRET=dev` 即可。

测试：

```bash
npm test             # 接口集成测试（自动起假算子和临时数据库）
npm run test:e2e     # 浏览器冒烟测试（Playwright，桌面 1440 和手机 375 两个视口）
```

生产部署（单端口，后端同时托管前端）：

```bash
npm install
npm run build
npm start            # http://<IP>:8787
```

## 对接朋友的 ComfyUI Web API

在 `.env` 里：

```bash
PROVIDER=comfyweb
GEN_API_BASE=http://114.132.237.136:1025
COMFY_APPID=对方分配的 API ID
COMFY_SECRET=对应的密钥
MAX_RUNNING=2
```

织影用 API ID 和密钥换 token（有效 72 小时），到期前和遇到 401 时会自动重新登录；设置页的服务状态每 5 分钟用 `/api/auth/verify` 校验一次凭证，密钥配错会直接显示原因。织影自己的用户注册登录与对方无关，所有用户共用这一组凭证。

对方的接口没有语言模型，AI 写大纲 / 台词 / 分镜需要另外配置 `LLM_API_BASE` 和 `LLM_MODEL`（任何 OpenAI 兼容接口）。不配置也能用，只是这些按钮会提示“语言模型不可用”，内容需要手动写。

几点差异，织影已自动处理：

- 创作台按算子声明的能力显示控件（`GET /api/capabilities`）：图生图只有一张参考图、没有重绘强度和 CFG；视频没有尾帧和反向提示词。服务端也会按同样的规则规整参数。
- 视频时长限制 4–15 秒，尺寸用算子原生尺寸（16:9 为 1344×768，其他比例待朋友确认）；运镜会拼到提示词末尾。
- 用户没指定种子时，织影自己生成随机种子并记录在每个资产上，方便复现。
- 一次只出一张图，要多张时织影会拆成多个任务。
- 没有取消接口：在织影里取消后，对方那边仍会跑完，结果被忽略。
- 视频完成后对方会同时给出原片和 2x 超分版（2688×1536），织影只下载超分版；没有超分版时下载原片。
- 对方不返回进度百分比：织影显示对方报告的阶段（排队、视频生成中、转码 / 超分中），进度条按经验耗时估算。
- 查询频率按对方建议：图片每 4 秒、视频每 12 秒（`COMFY_IMAGE_POLL_MS` / `COMFY_VIDEO_POLL_MS`）。
- 视频单条通常 15–30 分钟，超时上限单独设为 90 分钟（`VIDEO_JOB_TIMEOUT_MS`）。
- 对方能同时接收多个任务并在 ComfyUI 里排队，`MAX_RUNNING` 设成 2~3 可以让图片不必等长视频跑完才提交。

第一次联调可以先跑 `npm run probe:comfy`（视频用 `npm run probe:comfy -- t2v`），它会打印对方每个接口的原始返回，方便排查。

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
- 镜像默认内置 ffmpeg（缩略图、视频封面、截帧、拼接成片都要用）。Debian 源访问慢时在 `.env` 里设 `APT_MIRROR=mirrors.aliyun.com`；不需要这些功能时设 `WITH_FFMPEG=0`，相关功能会自动降级。

## 管理后台

`ADMIN_EMAILS` 里的账号登录后，侧栏和设置页会出现「管理后台」（`/admin`），手机也能用：

- **概览**：排队和生成数量、24 小时成功失败、磁盘、备份、最近失败的任务，以及需要注意的事项。
- **算子**：可以接多台算力。每个算子单独配置地址、API ID 和密钥（加密保存）、并发数、优先级、是否仅管理员可用；新建前可以“测试连接”（网络 → 换取令牌 → 校验 → 能力 → 远端队列 → 可选试跑一张图）。详情页有令牌卡片（到期时间及依据、立即校验、重新获取、查看并复制、复制 curl、清除、手动填入）、维护模式开关和对方最近的任务。任务会派给在线、没在维护、还有空位、优先级最高的算子。
- **任务**：所有用户的任务，可以取消、重新排队、插队。
- **用户**：设为管理员、停用账号（至少保留一位管理员）。
- **工作流**：启用 / 停用官方工作流、排序、修改默认参数。
- **内容**：管理预设（改提示词片段、上下架、排序）和提示词模板（新建、编辑变量、设为精选、上下架）。改过的条目不会被内置数据覆盖。
- **备份**、**审计日志**：后台所有写操作都有记录。
- **资产库维护**：`POST /api/admin/library/cleanup` 立即清理回收站里过期的素材；`POST /api/admin/library/rederive` 重新生成全部缩略图和封面（换成带 ffmpeg 的镜像之后用）；`GET /api/admin/jobs` 查看后台作业。

第一次启动 v0.4 时，`.env` 里的 `PROVIDER`、`GEN_API_BASE`、`COMFY_APPID`、`COMFY_SECRET` 会自动导入为「默认算子」，之后以后台为准，再改 `.env` 不会生效。

## 运维：备份、恢复、迁移、自检

- **每日备份**：每天 `BACKUP_AT`（默认 03:30）把数据库备份到 `/data/backups/weave-日期-时间.db.gz`，校验完整性后只保留最近 7 份。超级管理员也可以调用 `POST /api/admin/backups` 立即备份。生成的图片视频在 `/media`，体积大，建议用群晖的 Btrfs 快照或 Hyper Backup 备份这个目录。
- **恢复**：
  ```bash
  docker compose stop weave
  docker compose run --rm weave node scripts/restore.ts            # 列出备份
  docker compose run --rm weave node scripts/restore.ts weave-20261009-033000.db.gz
  docker compose start weave
  ```
  当前数据库不会被删除，会改名为 `weave.db.before-restore-时间`。
- **升级与迁移**：新版本启动时自动执行数据库迁移，执行前会在 `/data/backups/pre-migrate-*.db` 留一份备份。`docker compose run --rm weave node scripts/db.ts status` 可以查看迁移状态。如果新版本做了不兼容旧版本的改动，旧镜像会拒绝启动并说明原因，回退前需要先恢复升级前的备份。
- **自检**：`docker compose exec weave node scripts/selfcheck.ts --generate` 输出一份 Markdown 报告（CPU、内存、磁盘、备份、到算子的延迟、令牌换取、实际出一张小图），遇到问题时把报告发给开发者。
- **探针**：`/healthz`（进程存活）、`/readyz`（数据库可用，Docker 健康检查用这个）、`/api/version`（版本号）。
- **日志**：`docker logs weave` 输出 JSON，每个请求有编号。页面上的服务器错误提示会带“错误编号”，按编号搜日志即可定位。

## 开发检查

- `npm run verify`：类型检查、接口测试、构建、浏览器冒烟（桌面和手机两个视口，逐页截图并检查控制台报错）、生产依赖漏洞检查。GitHub Actions 每次推送都会跑。
- 推送前会自动跑 `npm run verify -- --quick`（`npm install` 时自动启用 `.githooks/pre-push`）。

## 功能

| 模块 | 说明 |
| --- | --- |
| 首页 | 动态极光背景、打字机提示词、作品滚动展示、能力介绍 |
| 登录注册 | 邮箱 + 密码，bcrypt 加密，HttpOnly Cookie 会话（30 天） |
| 创作台 | 图片 / 视频两种模式，加参考图自动变图生图，加首帧变图生视频。底部输入区（手机收起成一行）：模板 + 变量、76 个预设（风格、光线、镜头、运镜、色调、负向、尺寸）、写法提示（一键把否定词移到反向）、最终提示词预览、AI 扩写 / 润色 / 变体 / 翻译 / 灵感。结果按天分组无限滚动，每张可以再来一次、改参数重跑（锁定种子）、出变体、以此为参考、图转视频（AI 给动作建议）、加入对比（2–4 个并排或 A/B 滑杆）。配方随任务保存，随时完整还原 |
| 灵感 | 热门 / 精选 / 收藏模板和我的提示词，填几个词就能套用到创作台或直接生成 |
| 故事工坊 | 设定（类型、基调、统一画风、比例）→ AI 大纲 → AI 角色（外貌描述 + 定妆照，保证镜头间一致）→ AI 拆分章节与场次（可多次追加，支持很长的故事）→ AI 写台词 → AI 设计分镜（景别、运镜、时长、出镜角色、对应台词）→ 逐镜或批量生成关键帧和视频 → 成片预览（按顺序播放，带字幕）。故事按章、场、镜分表存储，增量自动保存，多个标签页和设备实时同步，断网修改留在本机、联网后自动补发；支持撤销 / 重做和历史版本（预览、手动存档、恢复）。设定库（角色 / 地点 / 道具 / 画风，分镜里 @ 提及）、镜头检查器（首帧来源、锁定种子、分段提示词预览）、候选定稿、服务端批量生成（先试算、先关键帧再视频、闲时生成）、进度看板、系列多集共享设定、章节前情提要和原著拆章。分镜表格视图（从 Excel 粘贴、CSV 导入导出）、6 个故事模板、故事列表（进行中 / 已完成 / 已归档 / 回收站、复制、继续上次位置）、导出剧本 / 字幕 / 镜头表 / 关键帧 ZIP / 打印分镜表、绘本 / 四格 / 条漫排版导出长图或 PDF，导出物都带 AI 标识 |
| 工作流 | 四选一出视频、角色定妆照（可写回故事角色）、长镜头接力（尾帧接首帧 + 拼接）、一句话短片（AI 拆镜头 → 出图 → 动起来 → 拼接）。启动前显示预计耗时，可无人值守；运行视图有步骤时间线和挑选卡片，可暂停、继续、取消、单步重试或跳过，服务重启后接着跑 |
| 任务队列 | 排队、暂停、继续、取消、重试、调整优先级、立即运行、全部运行。可开关自动调度，并设置服务不可用时的重试间隔（10 秒到 5 分钟） |
| 资产库 | 左侧视图（全部、最近 7 天、收藏、已挑选、未归档、回收站）、文件夹树（最多 4 层，素材可拖进去）、标签、智能文件夹（保存的筛选条件）、存储用量；中间全文搜索（提示词、备注、标签、文件名、故事名，两个字的词也能搜）、按类型 / 评分 / 排序筛选，虚拟网格只加载缩略图和视频封面；单击看详情（信息、生成参数、血缘、使用情况、评分 / 挑选淘汰 / 标签 / 备注 / 文件夹），⌘/Ctrl 多选、Shift 范围选、手机长按多选，批量收藏、评分、移动、加标签、打包下载（流式 zip，附 manifest.json）、移入回收站（30 天内可恢复；被进行中的任务使用的素材不能删；删除前提示被哪些故事镜头使用）。上传支持图片、视频、音频，5 MB 分片断点续传、单个最大 2 GB，相同文件自动去重，能读出 PNG 里 ComfyUI 写入的提示词和种子。视频可以截任意一帧存为新图片。存储统计按类型、月份、故事汇总，可一键合并重复文件 |

## 任务队列怎么工作

生成服务有时可用有时不可用，所以所有生成都先进队列：

1. 任务创建后状态为「排队中」。
2. 后台调度器每 2 秒运行一次：
   - 查询正在生成的任务进度，完成后下载结果存为资产，并通过 SSE 实时推送到页面；
   - 把排队任务提交给生成服务（同时运行数由 `MAX_RUNNING` 控制）。
3. **服务不可用**（健康检查失败、连不上、5xx）：任务保持排队，标记「等待服务」，按用户设置的间隔重试，不计入失败次数。
4. **生成失败**（服务返回错误）：按 15 秒、30 秒、60 秒…指数退避重试，超过 3 次标记失败，可以手动重试。
5. **自动调度**关闭时，只有点「立即运行」的任务才会提交；开启时服务可用就自动提交。

## 配置（环境变量）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `8787` | 后端端口 |
| `DATA_DIR` | `./data` | 数据库存放目录 |
| `MEDIA_DIR` | `DATA_DIR/files` | 生成的图片、视频和上传素材存放目录 |
| `PROVIDER` | `mock` | `mock` 模拟服务；`comfyweb` 朋友的 ComfyUI Web API；`http` 按 `docs/API_CONTRACT.md` 实现的服务 |
| `GEN_API_BASE` | 空 | 生成服务地址，例如 `http://192.168.1.50:9000` |
| `GEN_API_KEY` | 空 | 生成服务鉴权密钥（`http` 模式，可选） |
| `COMFY_APPID` / `COMFY_SECRET` | 空 | `comfyweb` 模式的 API ID 和密钥，织影会自动换 token 并在过期前续期 |
| `COMFY_IMAGE_POLL_MS` / `COMFY_VIDEO_POLL_MS` | `4000` / `12000` | `comfyweb` 模式查询图片 / 视频任务进度的间隔 |
| `LLM_API_BASE` / `LLM_API_KEY` / `LLM_MODEL` | 空 | AI 写作助手用的语言模型，任何 OpenAI 兼容接口；不配置时 AI 助手不可用 |
| `MOCK_FLAKY` | 空 | 设为 `1` 时模拟服务会随机不可用，用来演示队列的等待与重试 |
| `MAX_RUNNING` | `1` | 同时提交给生成服务的任务数 |
| `MAX_ATTEMPTS` | `3` | 单任务最多失败次数 |
| `JOB_TIMEOUT_MS` | `1800000` | 图片任务超时（30 分钟） |
| `VIDEO_JOB_TIMEOUT_MS` | `5400000` | 视频任务超时（90 分钟） |
| `COOKIE_SECURE` | 空 | 通过 HTTPS 访问时设为 `1` |
| `ADMIN_EMAILS` | 空 | 超级管理员邮箱，逗号分隔。管理员在设置页能看到算子令牌状态，可以立即校验或重新获取 |
| `REGISTRATION` | `open` | 设为 `closed` 关闭注册（`ADMIN_EMAILS` 里的邮箱仍可注册），给朋友小范围使用时建议关闭 |
| `LOG_LEVEL` | `info` | 日志级别（JSON 格式，凭证字段自动打码） |
| `BACKUP_AT` | `03:30` | 每天自动备份数据库的时间，留空关闭 |
| `BACKUP_KEEP` | `7` | 保留的每日备份份数 |
| `TRASH_DAYS` | `30` | 回收站保留天数，到期自动彻底删除 |
| `IDLE_WINDOW` | `01:00-07:00` | 闲时时段：故事批量生成勾选"闲时生成"后，任务在这个时段才开始派发 |
| `LLM_MOCK` | 空 | 设为 `1` 时，没有语言模型也能用模板化的模拟写作助手（大纲、分镜、提要等），先体验流程 |
| `UPLOAD_MAX_MB` | `2048` | 资产库分片上传的单文件上限（MB） |
| `MAX_UPLOAD_MB` | `20` | 旧的单次上传接口的上限（MB） |
| `WITH_FFMPEG` / `APT_MIRROR` | `1` / 空 | 构建参数：是否内置 ffmpeg；Debian 镜像源（例如 `mirrors.aliyun.com`） |

## 技术选型

- **前端**：React 19 + Vite + Tailwind CSS 4 + Zustand。按路由拆包，首页和工作台分开加载；动画只用 transform / opacity，交给 GPU 合成；图片懒加载、视频悬停才播放；长列表用 `content-visibility` 跳过屏幕外渲染。
- **后端**：Fastify 5 + Node 内置 SQLite（`node:sqlite`），不需要额外安装数据库。SSE 推送任务进度。
- **生成服务适配层**：`server/providers/`，`mock.ts` 是模拟实现，`http.ts` 是真实接口适配器。

## 目录结构

```text
├── shared/types.ts            前后端共享的数据类型
├── server/
│   ├── index.ts               服务入口
│   ├── routes/                REST / SSE 接口（按领域拆分）
│   ├── scheduler.ts           任务调度器（轮询、重试、落地结果）
│   ├── tasks/create.ts        创建任务的统一入口（创作台、故事批量、工作流共用）
│   ├── workflows/             工作流定义（defs.ts）与执行引擎（engine.ts）
│   ├── jobs/                  后台作业（缩略图、清理、迁移、成片渲染）
│   ├── library/               资产库：查询、标签、截帧、上传、使用情况、衍生文件
│   ├── media/                 ffmpeg 封装、流式 zip、PNG 元数据
│   ├── assist.ts              AI 写作助手（提示词与 JSON 解析）
│   ├── auth.ts / db.ts / files.ts / repo.ts
│   └── providers/             生成服务适配层（mock / http）
├── web/
│   ├── index.html
│   └── src/
│       ├── pages/Landing.tsx  首页
│       ├── pages/Auth.tsx     登录注册
│       └── pages/studio/      工作台：创作 / 故事工坊 / 工作流 / 队列 / 资产 / 设置
└── docs/API_CONTRACT.md       给 ComfyUI 侧的接口协议
```
