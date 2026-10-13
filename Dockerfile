# syntax=docker/dockerfile:1

# 基础镜像可替换为国内镜像源，例如：
#   docker compose build --build-arg NODE_IMAGE=docker.m.daocloud.io/library/node:22-bookworm-slim
ARG NODE_IMAGE=node:22-bookworm-slim

# ---------- 构建前端 ----------
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json vite.config.ts ./
COPY shared ./shared
COPY web ./web
RUN npm run build

# ---------- 只装运行时依赖 ----------
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# ---------- 运行镜像 ----------
FROM ${NODE_IMAGE}
# ffmpeg / ffprobe：缩略图、视频封面、截帧、尾帧接力、拼接成片都要用（默认内置）。
# 不需要时构建加 --build-arg WITH_FFMPEG=0，相关功能会自动降级。
# Debian 源访问慢时可指定镜像，例如 --build-arg APT_MIRROR=mirrors.aliyun.com
ARG WITH_FFMPEG=1
ARG APT_MIRROR=
# 下载缓存：apt 的包缓存挂成构建缓存（不进镜像），网络不稳中途断掉时，已经下好的包留着，
# 下次构建只补下缺的；同一次构建里也会重试 5 轮，每轮只下还没下到的包。
# 官方镜像自带的 docker-clean 会在安装后删掉下载的包，要先去掉，缓存才留得住。
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    if [ "$WITH_FFMPEG" = "1" ]; then \
      if [ -n "$APT_MIRROR" ]; then sed -i "s|deb.debian.org|$APT_MIRROR|g" /etc/apt/sources.list.d/debian.sources; fi && \
      rm -f /etc/apt/apt.conf.d/docker-clean && \
      printf 'Acquire::Retries "8";\nAcquire::http::Pipeline-Depth "0";\nBinary::apt::APT::Keep-Downloaded-Packages "true";\n' > /etc/apt/apt.conf.d/80-retries && \
      { apt-get update || exit 1; } && \
      ok=0; for i in 1 2 3 4 5; do \
        apt-get install -y --no-install-recommends --download-only ffmpeg && ok=1 && break; \
        echo "第 $i 轮下载没有完成，10 秒后只补下缺的包"; sleep 10; \
      done; \
      [ "$ok" = 1 ] && apt-get install -y --no-install-recommends ffmpeg && ffmpeg -version | head -1; \
    fi

# 构建时注入版本信息：docker compose build --build-arg GIT_SHA=$(git rev-parse --short HEAD)
ARG APP_VERSION=
ARG GIT_SHA=
ENV NODE_ENV=production \
    APP_VERSION=${APP_VERSION} \
    GIT_SHA=${GIT_SHA} \
    PORT=8787 \
    DATA_DIR=/data \
    MEDIA_DIR=/media \
    TZ=Asia/Shanghai

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY shared ./shared
COPY server ./server
# 运维脚本：自检、数据库迁移、备份恢复
COPY scripts/selfcheck.ts scripts/db.ts scripts/restore.ts ./scripts/

RUN mkdir -p /data /media && chown -R node:node /data /media
USER node

EXPOSE 8787
VOLUME ["/data", "/media"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.ts"]
