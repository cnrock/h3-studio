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

# curl / vim：容器内排障用（curl 探 vLLM 端点、vim 临时改文件）。
# bullseye 已进 LTS 尾声，官方 security 源常见 404（vim-tiny/curl 的 .deb 都拉不到），
# 故改用 archive.debian.org 归档源；Check-Valid-Until=false 因归档源 Release 已过期。
# 中文字体：Noto Sans CJK SC + WQY Zenhei，用于后期 drawtext 烧字（可选步骤）。
RUN set -eux; \
    rm -f /etc/apt/sources.list.d/*; \
    printf 'deb http://archive.debian.org/debian bullseye main\ndeb http://archive.debian.org/debian-security bullseye-security main\n' \
      > /etc/apt/sources.list; \
    apt-get -o Acquire::Check-Valid-Until=false -o Acquire::Retries=3 update -qq; \
    apt-get install -y --no-install-recommends ca-certificates curl vim-tiny fontconfig; \
    update-ca-certificates; \
    # Noto Sans CJK SC (OTF)
    mkdir -p /usr/share/fonts/opentype/noto && \
    curl -fsSL -o /usr/share/fonts/opentype/noto/NotoSansCJKsc-Regular.otf \
      'https://github.com/notofonts/noto-cjk/raw/main/Sans/OTF/SimplifiedChinese/NotoSansCJKsc-Regular.otf'; \
    # WQY Zenhei (TTF) - from deepin-community
    mkdir -p /usr/share/fonts/truetype/wqy && \
    curl -fsSL -o /usr/share/fonts/truetype/wqy/wqy-zenhei.ttc \
      'https://github.com/deepin-community/fonts-wqy-zenhei/raw/master/wqy-zenhei.ttc'; \
    fc-cache -fv; \
    rm -rf /var/lib/apt/lists/*

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
