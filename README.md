# H3 Studio

一个可自托管的 **MiniMax H3 视频生成站**：用户用**邮箱注册 / 激活 / 登录**，然后用
**一段文字**，或**图片 / 视频参考素材**，调用你自建的 H3 接口生成视频。

- 参考站点交互：<https://pixo.video/zh/blog/minimax-h3-prompts>（提示词写法与场景）
- 模型接口：vLLM-Omni 的 OpenAI 兼容视频 API（`/v1/videos/sync`）
- 纯 Node.js + 内置 SQLite，**无需任何原生依赖**，三种部署形态开箱即用

---

## 功能

- **邮箱注册 / 激活 / 登录 / 找回密码**（SMTP 发信，含激活链接与重置链接）
- **三种生成模式**（对应 H3 的三个 task）：
  | 模式 | 说明 | 参考文件 |
  |---|---|---|
  | `t2va` 文生视频 | 纯文字生成（含原生音频） | 无 |
  | `fl2va` 首尾帧 | 1 张（首帧）或 2 张（首帧+末帧） | `input_reference` 图片 |
  | `ref2va` 参考素材 | 参考图片 / 视频片段（可混合） | `input_reference` 图片/视频 |
- **作品列表**：排队 / 生成中 / 完成 / 失败 状态实时刷新，可在线播放、下载、删除
- **串行队列**：H3 服务端 `max_num_seqs=1`，任务在本地严格串行排队，避免互相抢占
- 时长 4–15s、画幅、768p/2K、采样步数、flow_shift、seed 等参数可调
- 上传体积/数量限制可配；失败自动重试 1 次

---

## 目录结构

```
h3-studio/
├─ server/
│  ├─ index.js      # Express 入口 + 路由
│  ├─ config.js     # 配置（读取 .env）
│  ├─ db.js         # 内置 SQLite（node:sqlite）
│  ├─ auth.js       # 注册/登录/JWT/密码
│  ├─ mail.js       # nodemailer 发信
│  ├─ h3.js         # H3（vLLM-Omni）调用封装
│  └─ jobs.js       # 任务队列与产物落盘
├─ public/          # 前端（原生 HTML/CSS/JS，无构建步骤）
├─ scripts/probe-h3.mjs   # 探测 H3 后端连通性
├─ deploy/          # systemd 单元 + Nginx 反代示例
├─ Dockerfile / docker-compose.yml
├─ env.internal.example / env.docker.example / env.vps.example
```

---

## 通用准备

```bash
cp env.internal.example .env   # 按部署形态选对应的模板
# 编辑 .env：H3_BASE_URL、SMTP_*、JWT_SECRET 必填
npm install
node scripts/probe-h3.mjs      # 确认能连上 H3（/health、/v1/models）
```

> 想要**不依赖邮件**、注册即可用：把 `.env` 里 `SKIP_EMAIL_VERIFICATION=true`。

---

## 版本一：内网运行（不需要域名）

```bash
cp env.internal.example .env
# 关键项：
#   PUBLIC_BASE_URL=http://<本机内网IP>:8787   # 邮件里的激活链接用它
#   H3_BASE_URL=http://192.0.2.10:8003
npm install
npm start
# 浏览器打开 http://<本机内网IP>:8787
```

后台常驻可用 `deploy/h3-studio.service`（systemd）：

```bash
sudo cp deploy/h3-studio.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now h3-studio
```

---

## 版本二：Docker 运行

```bash
cp env.docker.example .env
# 若 H3 跑在宿主机：H3_BASE_URL=http://host.docker.internal:8003
docker compose up -d --build
docker compose logs -f
# 浏览器打开 http://<宿主机IP>:8787
```

数据（SQLite、上传、生成的视频）持久化在 `./data`。

---

## 版本三：公网 VPS 运行

```bash
cp env.vps.example .env
# 关键项：
#   PUBLIC_BASE_URL=https://your-domain.com
#   H3_BASE_URL=https://<你的公网H3接口>      # 你后续提供的公网视频接口
#   JWT_SECRET=<长随机串>
#   SMTP_PORT=465 / SMTP_SECURE=true
npm install && npm start          # 只监听 127.0.0.1:8787
```

用 Nginx 反代 + HTTPS：参考 `deploy/nginx.conf`（已放宽 30 分钟超时、`client_max_body_size 64m`）。

```bash
sudo cp deploy/nginx.conf /etc/nginx/conf.d/h3-studio.conf
sudo nginx -t && sudo systemctl reload nginx
```

---

## H3 接口对接说明（重要）

本站按 **vLLM-Omni 的 `/v1/videos/sync`** 规范调用，`multipart/form-data`，**同步返回 MP4 字节流**。字段：

| 字段 | 说明 |
|---|---|
| `prompt` | 提示词（≤7000 字符） |
| `width` / `height` | 输出尺寸 |
| `aspect_ratio` | `21:9/16:9/4:3/1:1/3:4/9:16` |
| `fps` | 帧率（H3 固定 24） |
| `num_inference_steps` / `flow_shift` / `seed` | 采样参数 |
| `extra_params` | JSON：`{"task":"t2va\|fl2va\|ref2va","duration":4~15,"audio_flow_shift":3.0}` |
| `input_reference` | 参考图片/视频文件（multipart 文件部分） |
| `image_reference` | JSON：`{"image_url":"..."}`（URL 方式，与文件上传互斥） |
| `video_reference` | JSON：`{"video_url":"..."}`（URL 方式） |

你的示例命令：

```bash
curl -sS -X POST http://192.0.2.10:8003/v1/videos/sync \
  -F 'prompt="..."' \
  -F 'width=1344' -F 'height=768' -F 'aspect_ratio=16:9' \
  -F 'fps=24' -F 'num_inference_steps=50' -F 'flow_shift=12' -F 'seed=1101' \
  -F 'extra_params={"task":"t2va","duration":14.38,"audio_flow_shift":3.0}' \
  -o film.mp4
```

与本站的调用完全一致（本站把 `duration` 收敛到 4–15 秒）。

> 若你的接口需要鉴权，填 `H3_API_KEY`，会以 `Authorization: Bearer <key>` 发送。

---

## 环境变量速查

| 变量 | 默认 | 说明 |
|---|---|---|
| `DEPLOYMENT` | `internal` | 形态标识（展示用） |
| `PORT` | `8787` | 监听端口 |
| `PUBLIC_BASE_URL` | 空 | 邮件链接用的公开地址；空则按请求 Host 推断 |
| `H3_BASE_URL` | `http://192.0.2.10:8003` | H3 后端地址 |
| `H3_API_KEY` | 空 | 后端鉴权（可选） |
| `H3_TIMEOUT_MS` | `1800000` | 同步生成超时（30 分钟） |
| `JWT_SECRET` | 开发串 | **生产必改** |
| `SKIP_EMAIL_VERIFICATION` | `false` | `true` 则注册即可用 |
| `SMTP_*` | — | 见模板；含 `SMTP_TLS_REJECT_UNAUTHORIZED` |
| `MAX_IMAGE_MB` / `MAX_VIDEO_MB` / `MAX_FILES` / `PROMPT_CHARS` | 30/50/9/7000 | 上传与提示词限制 |

---

## 已做的验证

- 服务器启动、`/api/health`、静态页面、注册（免激活模式）、登录、错误密码、令牌鉴权均通过
- 任务提交 → 入队 → 执行 → （后端不可达时）状态置 `error` 并记录原因，链路完整
- 前端为无构建的原生实现，直接由 Express 托管

> 生成结果的真实成功链路需在能连通 H3 的机器上验证（本机跨网段访问不到 `192.0.2.10`）。
> 请先跑 `node scripts/probe-h3.mjs --gen` 做一次最小生成。

---

## 免责声明

本项目仅用于内部/学习用途。生成的视频由你自建的 H3 模型产出，请遵守相关许可与合规要求。
