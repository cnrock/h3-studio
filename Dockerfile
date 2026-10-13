# 从官方静态 ffmpeg 镜像拷贝二进制，避免依赖 Debian apt 源
# （bullseye 的 security 源常出现 404，导致 apt 安装 ffmpeg 失败）
FROM mwader/static-ffmpeg:9.0.2-1 AS ffmpeg

# 注意：使用 bullseye（glibc 2.31），避免旧版 Docker seccomp 拦截 clone3
# 导致容器内 Node 启动即 core dump（Assertion failed: uv_thread_create）。
# node:sqlite 需要 Node 22，故不能降到 Node 20。
FROM node:22-bullseye-slim

WORKDIR /app

# ffmpeg / ffprobe：长视频（>15 秒）分段后的拼接依赖
COPY --from=ffmpeg /ffmpeg /usr/bin/ffmpeg
COPY --from=ffmpeg /ffprobe /usr/bin/ffprobe

# Install dependencies first (better layer caching)
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

# App source
COPY server ./server
COPY public ./public

ENV NODE_ENV=production
ENV PORT=8787
# 时区：Node 自带 ICU 时区库，设 TZ 即可让日志/时间戳按东八区显示，无需装 tzdata。
ENV TZ=Asia/Shanghai
EXPOSE 8787

# Persist SQLite DB, uploads and generated videos under /app/data
VOLUME ["/app/data"]

CMD ["node", "server/index.js"]
