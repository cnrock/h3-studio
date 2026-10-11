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
- **突破 15 秒**：时长可填 4–120 秒，超过 15 秒时后端自动分段续写并拼接（见下文）
- **排队提示**：多用户时任务串行排队，界面显示「第 N 位（共 M 个排队）」与分段进度
- **作品列表**：排队 / 生成中 / 完成 / 失败 状态实时刷新，可在线播放、下载、删除
- 时长、画幅、768p/2K、采样步数、flow_shift、seed 等参数可调
- 上传体积/数量限制可配；失败自动重试 1 次

---

## 突破 15 秒限制

H3 单次生成硬上限为 **15 秒（24fps，整秒）**，这是模型本身的限制。本站采用社区公认最稳的**分段续写 + 拼接**方案（对应官方手册「方法一：音画续写」），并针对「后段重复前段」做了专门处理：

**两种分段模式（自动识别）**

1. **分镜脚本模式**（推荐）：提示词含「镜头 1｜0:00–0:04｜4 秒｜标题」这类时间轴时，自动拆出总设定与各镜头，按 ≤15 秒把相邻镜头聚成生成段；**每段只喂自己那部分剧本**，从而避免后段重演开场。
2. **普通提示词模式**：均匀分段，并给每段自动追加「承接上段、不要重复开头」的续写指令。

两种模式共同点：
- 第 1 段按用户所选模式生成；
- 第 2 段起用**上一段最后一帧**作为本段首帧（`input_reference` + `fl2va`），保证画面与动作延续；
- 全部段生成后用 ffmpeg 拼接为一条完整视频。

**示例**：29 秒、7 个镜头的分镜脚本 → 自动分 3 段（12s / 13s / 4s），每段只演自己的镜头。

> 为什么这样做：手册指出「续写跑偏会累积」，且角色一致性最好靠**每段都从参考图重新开始**。因此本方案建议对身份敏感的内容控制总段数（约 2–3 段内一致性最好）。

**依赖**：宿主机/容器需有 `ffmpeg`（本仓库 Docker 镜像已内置，静态二进制，不依赖 apt）。

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
│  ├─ longvideo.js  # 超过 15 秒的分段续写 + 拼接（ffmpeg）
│  └─ jobs.js       # 任务队列（含排队位次、进度）与产物落盘
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
| `H3_TIMEOUT_MS` | `1800000` | 同步生成超时（30 分钟；长视频分段会累加） |
| `JWT_SECRET` | 开发串 | **生产必改** |
| `SKIP_EMAIL_VERIFICATION` | `false` | `true` 则注册即可用 |
| `SMTP_*` | — | 见模板；含 `SMTP_TLS_REJECT_UNAUTHORIZED` |
| `MAX_IMAGE_MB` / `MAX_VIDEO_MB` / `MAX_FILES` / `PROMPT_CHARS` | 30/50/9/7000 | 上传与提示词限制 |

---

## 常见问题

**构建时容器内 Node 崩溃 `Assertion failed: uv_thread_create` / `core dumped`（exit 134）**
旧版 Docker（< 20.10.10，如 20.10.7）的 seccomp 策略会拦 `clone3`，新 glibc 的 Node 一创线程就崩。二选一：
1. 本仓库已默认用 `node:22-bullseye-slim`（glibc 2.31，不走 `clone3`）——**推荐，无需动宿主机**；
2. 或在 `docker-compose.yml` 打开 `security_opt: [seccomp:unconfined]`；
3. 或升级宿主机 Docker 到 ≥ 20.10.10。

**邮箱收不到激活邮件**
1. 先看 `curl -s localhost:8787/api/health` 里 `smtp.ok`；
2. 25 端口常被云/内网挡，改 `SMTP_PORT=465` + `SMTP_SECURE=true`；
3. 密码要用邮箱服务商生成的**授权码**，不是登录密码；
4. 也可临时设 `SKIP_EMAIL_VERIFICATION=true` 重启容器。

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

---

## 安全说明

### 已内置的防护
- `/api/health` 仅回 `{ok:true}`；后端地址等详情移入需登录的 `/api/health/detail`
- 安全响应头：`X-Content-Type-Options`、`X-Frame-Options`、`Referrer-Policy`、`Permissions-Policy`、CSP，并关闭 `X-Powered-By`
- 限速：同 IP 登录 10 次/10 分钟、注册 5 次/小时、找回密码 5 次/小时（超出 429）
- 生成/任务/视频接口均需登录鉴权（401）

### 部署必做
1. **改 `JWT_SECRET`** 为随机长串（默认值可被伪造 token）
2. **H3 后端不要暴露公网**：`203.0.113.10:8003` 应只允许本机/内网访问
   （建议安全组/防火墙只放行 H3 Studio 所在主机，或仅监听内网）
3. **上 HTTPS**：公网部署务必用 Nginx + Let's Encrypt，并设 `ENABLE_HSTS=true`
   （同时会自动给 Cookie 加 `Secure`）
4. 生产环境设置 `SKIP_EMAIL_VERIFICATION=false`，并保证 SMTP 可用

---

## 长视频失败的排查（重要）

若长视频（>15 秒）在后段失败并**从头重跑**，看 H3 日志会发现：每段生成其实都成功了，
但客户端在第 2 段（约 300 秒处）就报错重试。

**根因**：Node 内置 `fetch`（undici）的 **`headersTimeout` 默认 300 秒**。
H3 单段 12~13 秒视频要 4~6 分钟，第 1 段（≈262s）能过，第 2 段（≈325s）就被 undici
掐断，报 `UND_ERR_HEADERS_TIMEOUT`，触发重试。

**修复**：`server/h3.js` 用独立 `undici.Agent`，把 `headersTimeout`/`bodyTimeout`
放宽到 `H3_TIMEOUT_MS`（默认 30 分钟）。仅设 `AbortController` 是无效的——两者是
独立超时。

其余加固：
- 长视频改为**逐段重试**（只重跑失败段，已成功段复用），不再整条从头重跑
- 抽取上段末帧失败时，自动退化为纯文本续写，不中断整条流程

> K8s 侧无需改动：`VLLM_OMNI_VIDEO_SYNC_TIMEOUT=14400` 已足够，问题在网站客户端超时。

---

## 错误排查：ref2va 报错 / prompt 丢失

### 1) `checkpoint partition 'fl2va' supports ['fl2va','t2va'], got task='ref2va'`
这是 **H3 服务端（K8s）配置问题**，与本网站无关。

原因：`vllm serve` 命令里带了 `--task-type fl2va`，只加载了 FL2VA 一个 DiT；
参考素材（ref2va）需要 Ref2VA 那个 DiT，因此被拒绝。

修复（改 deployment 的 args）：
- **去掉 `--task-type fl2va`**，让服务同时加载两个 DiT（180GB 卡足够）；
- serve 路径指向**仓库根目录**，而不是 `FL2VA/` 子目录。

```yaml
args:
  - |
    exec vllm serve /data/serving-model/MiniMax-H3 \
      --omni \
      --host 0.0.0.0 --port 8003 \
      --trust-remote-code --served-model-name minimax-h3 \
      # ...其余参数不变，注意【不要】再加 --task-type
```

服务重启后 `{"task":"ref2va"}` 即可正常调用。

### 2) `body.prompt Field required, input: 'None'`
这是 **v6 的代码缺陷**（v7 已修）：v6 为实现长超时引入了 `undici` npm 包，
它与 Node 内置的 `FormData` 不兼容——请求体被当成普通对象字符串化成
`[object FormData]`（仅 17 字节），H3 收不到任何字段。

v7 已**移除 undici 依赖**，改用 Node 内置 `http/https` 自行构造 multipart，
超时仍完全可控，且无额外依赖。

---

## 错误排查：ref2va 报 "accepts at most 3 video references"

**根因**：H3 的 multipart 参考字段名分单复数两种，用错会导致参考数量统计错乱。

| 场景 | 正确字段名 |
|---|---|
| ref2va（参考素材，图/视频混合，可多个） | **`input_references`**（复数） |
| fl2va 单帧 | `input_reference`（单数） |
| fl2va 首+末两帧 | `input_references`（复数） |

若把多文件都塞进单数 `input_reference`：FastAPI 只保留最后一个文件，且视频会被
解码成帧序列，被 H3 当成「多个视频参考」→ 报
`ref2va accepts at most 3 video references`。

网站已按上表自动选择字段名（`server/index.js`）。参考上限（H3 侧）：
图片 ≤9、视频 ≤3、独立音频 ≤3、总数 ≤12；参考视频总时长 ≤15 秒。
