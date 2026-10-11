# 注意：使用 bullseye（glibc 2.31），避免旧版 Docker seccomp 拦截 clone3
# 导致容器内 Node 启动即 core dump（Assertion failed: uv_thread_create）。
# node:sqlite 需要 Node 22，故不能降到 Node 20。
FROM node:22-bullseye-slim

WORKDIR /app

# ffmpeg：长视频（>15 秒）分段后的拼接依赖
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/*

# Install dependencies first (better layer caching)
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

# App source
COPY server ./server
COPY public ./public

ENV NODE_ENV=production
ENV PORT=8787
EXPOSE 8787

# Persist SQLite DB, uploads and generated videos under /app/data
VOLUME ["/app/data"]

CMD ["node", "server/index.js"]
