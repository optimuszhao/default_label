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
# ffmpeg 只在模拟服务（PROVIDER=mock）生成演示视频时用到，接真实服务后不需要。
# 需要时构建加 --build-arg WITH_FFMPEG=1；时区由 Node 自带的 ICU 数据处理，不依赖系统 tzdata。
ARG WITH_FFMPEG=0
RUN if [ "$WITH_FFMPEG" = "1" ]; then \
      apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*; \
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
