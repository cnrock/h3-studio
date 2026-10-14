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
- **突破 15 秒**：时长可填 **4–1800 秒**（上限由 `MAX_DURATION_SEC` 控制），超过 15 秒时后端自动分段续写并拼接（见下文）
- **排队提示**：多用户时任务串行排队，界面显示「第 N 位（共 M 个排队）」与分段进度
- **耗时与用量统计（v1.8）**：每个作品显示提交/完成时间、排队等待、生成耗时、总计；作品列表顶部汇总「今日 / 累计」的条数、成片秒数、卡时（生成机时）、总耗时；计费开关（v1.8.1）支持**按秒 / 按条**计费并累计消耗
- **作品列表**：排队 / 生成中 / 完成 / 失败 状态实时刷新，可在线播放、下载、删除
- **提示词助手（v1.9）**：
  - **提示词自检**：提交前静态体检，按 MiniMax-H3 官方写作规范给出 `!` 警告 / `-` 提示（镜头结构、切点时间、`<d>` 对白标记、参考素材双向核对、六段式字段账目、特效 token、时间戳帧网格吸附等）。**只提示不拦截**。
  - **AI 重写**：一句大白话 → 合规的 H3 提示词（三/六段式）。需服务端配置 LLM（见 `LLM_*`）。
  - **描述素材**：上传参考图后，用识图模型自动生成文字描述，追加进提示词。需服务端配置 `LLM_VISION_MODEL`。
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

## 耗时与用量统计（v1.8）

每个作品都会记录一条「时间线」，在卡片上直接展示：

| 字段 | 含义 |
|---|---|
| 提交时间 | 任务入队的时刻（`created_at`） |
| 排队等待 | 提交 → 真正开始生成（单 worker 串行，前面有任务就得等） |
| 生成耗时 | 开始 → 完成（**即卡时**：真正占用 GPU 的时长） |
| 完成时间 | 出片/失败的时刻 |
| 总计 | 提交 → 完成（= 排队 + 生成） |

作品列表顶部还有一块**汇总面板**，**左右两栏**分「今日 / 累计」，每栏各含：

- **生成条数**（完成 / 失败分开计数）
- **成片秒数**（所有成片时长之和，秒）
- **卡时**（Σ 生成耗时，分钟）—— 真正占用的 GPU 机时，不含排队
- **总耗时**（Σ 提交→完成，分钟）—— 用户视角的实际等待
- **点数**（开启计费后，按所选模式累计消耗：按秒=成片秒数×费率，按条=完成条数×费率）

排队中的任务还会显示**预计等待时间**：单 worker 串行，预计 ≈ 队列位次 × 近期平均生成耗时（仅供参考，随任务长短浮动）。

**计费开关**：`CREDITS_MODE` 三选一：

- `off`（默认）：只统计不扣点，不影响现有账户余额。
- `second`：**按秒计费**，`CREDITS_PER_SECOND` 为每秒费率（可小数，如 `0.1`）。扣点 = 成片秒数 × 费率，**向上取整**。
- `job`：**按条计费**，`CREDITS_PER_JOB` 为每条费率（可小数）。扣点 = 条数 × 费率，向上取整。

扣点在任务**完成时**写入该任务与账户余额。未设 `CREDITS_MODE` 时按费率自动推断（`CREDITS_PER_JOB`>0 用 `job`，`CREDITS_PER_SECOND`>0 用 `second`），便于从 v1.8 平滑升级。

**口径说明**：「卡时」只统计**已完成**任务（失败任务不占用成片时长，也不计入卡时/总耗时）；正在生成的任务会在卡片上实时显示已用时间，但完成前不计入汇总。数据来自 `jobs` 表的 `created_at / started_at / finished_at / seconds`，接口为 `GET /api/stats`（需登录，仅返回本人数据）。

> ⚠️ **统计自 v1.8 起启用**：更早创建的任务没有 `started_at / finished_at / seconds` 记录，成片秒数/卡时/总耗时为 0（条数照常统计）。旧数据无法可靠回填（生成机时从未记录）。

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
│  └─ k8s/          # K8s 全套清单（ConfigMap/Secret/PVC/Deployment/Service/Ingress）
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
#   H3_BASE_URL=http://10.1.10.34:32206
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
# 若 H3 跑在宿主机：H3_BASE_URL=http://host.docker.internal:32206
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

## 版本四：Kubernetes 部署

一套完整清单，`kubectl apply -k deploy/k8s/` 部署。含 Namespace / ConfigMap / Secret /
PVC / Deployment / Service / Ingress，镜像用官方发布的 `cnrock/h3-studio`。

```bash
# 先改三处：01-configmap.yaml（域名/H3 地址/SMTP）、02-secret.yaml（密钥）、06-ingress.yaml（域名）
kubectl apply -k deploy/k8s/
kubectl -n h3-studio get pods,svc,ingress
```

关键约束：**必须单副本**（队列进程内串行 + SQLite 单写）；视视频生成最长 30 分钟，
Ingress 已用注解放宽读超时到 1800s；`/app/data` 挂 RWO PVC。详见 [`deploy/k8s/README.md`](deploy/k8s/README.md)。

---

## H3 接口对接说明（重要）

本站按 **vLLM-Omni 的 `/v1/videos/sync`** 规范调用，`multipart/form-data`，**同步返回 MP4 字节流**。字段：

| 字段 | 说明 |
|---|---|
| `prompt` | 提示词（≤20000 字符，可用 PROMPT_CHARS 调整） |
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
curl -sS -X POST http://10.1.10.34:32206/v1/videos/sync \
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
| `H3_BASE_URL` | `http://10.1.10.34:32206` | H3 后端地址 |
| `H3_API_KEY` | 空 | 后端鉴权（可选） |
| `H3_TIMEOUT_MS` | `1800000` | 同步生成超时（30 分钟；长视频分段会累加） |
| `JWT_SECRET` | 开发串 | **生产必改** |
| `TZ` | `Asia/Shanghai` | 容器时区；决定日志时间戳（镜像已默认东八区） |
| `SKIP_EMAIL_VERIFICATION` | `false` | `true` 则注册即可用 |
| `SMTP_*` | — | 见模板；含 `SMTP_TLS_REJECT_UNAUTHORIZED` |
| `MAX_IMAGE_MB` / `MAX_VIDEO_MB` / `MAX_FILES` / `PROMPT_CHARS` | 30/50/9/20000 | 上传与提示词限制 |
| `MAX_DURATION_SEC` | `1800` | 单次任务允许的总时长（秒）；超 15 秒自动分段 |
| `MAX_REF_VIDEO_SEC` | `15` | ref2va 参考视频单个时长上限（秒） |
| `H3_DEBUG` | `false` | `1` 打开逐段时长/音视频对齐详细日志（等价于 `LOG_LEVEL=debug`） |
| `LOG_LEVEL` | `info` | 日志级别：`debug` / `info`（默认，含每个请求与每个生成任务）/ `warn` / `error` / `silent` |
| `CREDITS_MODE` | `off` | 计费模式：`off` / `second`（按秒）/ `job`（按条） |
| `CREDITS_PER_SECOND` | `0` | 按秒费率（点/秒，可小数）；仅 `second` 生效 |
| `CREDITS_PER_JOB` | `0` | 按条费率（点/条，可小数）；仅 `job` 生效 |
| `LLM_BASE_URL` | 空 | 提示词助手（v1.9）OpenAI 兼容端点；空则隐藏「AI 重写」 |
| `LLM_API_KEY` | 空 | 提示词助手密钥（可空） |
| `LLM_TEXT_MODEL` | 空 | 重写用的文本模型 |
| `LLM_VISION_MODEL` | 空 | 识图模型；空则隐藏「描述素材」 |
| `LLM_TIMEOUT_MS` | `180000` | 提示词助手单次调用超时 |
| `LLM_MAX_IMAGE_BYTES` | `8388608` | 描述素材时单张参考图上限 |

---

## 常见问题

**`docker logs -f h3-studio` 只看到启动那几行，没有请求/任务日志？**
默认级别就是 `info`，所以正常会有日志；若确实没有，先确认容器是新版（`H3 Studio v1.8.3+`），并在 `.env` 里设 `LOG_LEVEL=info`（或 `debug` 看逐段细节）后 `docker compose up -d` 重建。各级别能看到的内容：

| 级别 | 看得到 |
|---|---|
| `info`（默认） | 启动横幅、每个 HTTP 请求（方法/路径/状态/耗时）、注册/登录、任务提交/入队/开始/完成/失败、每段生成进度、拼接进度 |
| `debug` | 以上 + H3 每次请求的字节数与耗时、每段音视频对齐前后时长、最终成片音视频时长 |
| `warn` | 仅告警（登录失败、参考视频超长截取、音视频时间戳漂移、分段返回时长不符、某段重试） |
| `error` | 仅错误（任务失败、请求处理异常） |

日志每行前缀 `[本地时间] [h3:级别]`（如 `[2026-10-13T14:50:25.679+08:00]`），便于 `docker logs | grep h3:error` 之类过滤。**时间带时区偏移，容器默认东八区**（`TZ=Asia/Shanghai`，见 Dockerfile/compose 与 K8s ConfigMap），想要 UTC 就把 `TZ` 设成 `UTC`。日志**不含 URL query**，避免 token/凭据进日志文件。

**构建时容器内 Node 崩溃 `Assertion failed: uv_thread_create` / `core dumped`（exit 134）**
旧版 Docker（< 20.10.10，如 20.10.7）的 seccomp 策略会拦 `clone3`，新 glibc 的 Node 一创线程就崩。二选一：
1. 本仓库已默认用 `node:22-bullseye-slim`（glibc 2.31，不走 `clone3`）——**推荐，无需动宿主机**；
2. 或在 `docker-compose.yml` 打开 `security_opt: [seccomp:unconfined]`；
3. 或升级宿主机 Docker 到 ≥ 20.10.10。

**激活邮件发送失败（`535 Error: authentication failed`），注册后账号卡住无法登录？**
`535` 是**邮件服务器拒绝了账号密码**，不是 H3 Studio 的问题。按序排查：
1. 密码要用邮箱服务商生成的**客户端授权码**，不是网页登录密码；
2. 确认 `SMTP_PASS` 已填真实值（K8s 里看 `02-secret.yaml`，别留 `REPLACE_WITH_SMTP_PASSWORD`）；
3. 看 `SMTP_USER`/`SMTP_FROM` 是否与授权码对应同一个邮箱；
4. 验证：`curl -s localhost:8787/api/health/detail`（需登录）看 `smtp.ok` 与 `error`；
5. 账号已建但未激活时，前端注册失败后会显示**「重发激活邮件」**按钮（`POST /api/auth/resend`），修好 SMTP 后自助补发即可，**无需手动改库**。

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

> 生成结果的真实成功链路需在能连通 H3 的机器上验证（本机跨网段访问不到 `10.1.10.34`）。
> 请先跑 `node scripts/probe-h3.mjs --gen` 做一次最小生成。

---

## 界面（v1.5 · Apple 风格）

参考 Apple 设计语言重构：浅色为主 / 深色为精致对偶、毛玻璃顶栏、胶囊按钮、大留白、
精确字距与柔和多层阴影；登录页与应用页（生成表单、作品网格）统一。配色自动跟随系统深浅色。

![应用界面](docs/screenshots/v1.6-app.png)

## 免责声明

本项目仅用于内部/学习用途。生成的视频由你自建的 H3 模型产出，请遵守相关许可与合规要求。

---

## 安全说明

> 用后即弃会话：令牌存 `HttpOnly` cookie（非 `localStorage`），退出登录即时清 Cookie；
> 密码用 bcrypt 哈希存储，重置令牌 1 小时过期且一次性。

### 已内置的防护
- `/api/health` 仅回 `{ok:true}`；后端地址等详情移入需登录的 `/api/health/detail`
- 安全响应头：`X-Content-Type-Options`、`X-Frame-Options`、`Referrer-Policy`、`Permissions-Policy`、CSP，并关闭 `X-Powered-By`
- 限速：同 IP 登录 10 次/10 分钟、注册 5 次/小时、找回密码 5 次/小时（超出 429）
- 生成/任务/视频接口均需登录鉴权（401）

### 凭据不进 URL（v1.6.3）

登录/注册/找回密码表单均显式声明 `method="post"` 并由 JS 以 `fetch` POST 提交，
凭据只走请求体。服务端另加一道兜底：任何带 `password`/`email` 等字段的 **GET** 请求
一律 `303` 重定向到干净路径，把凭据从浏览器历史 / Referer / 反代与服务器访问日志中剔除
（`/api/` 下的 JSON 接口与 `reset`/`verify` 的合法 token query 不受影响）。
HTML 页面向应 `Cache-Control: no-store`，避免旧版页面（旧版表单会原生 GET 提交）被复用。

> 若你在反代（Nginx）开启了访问日志，且历史上有过这类带凭据的 GET 请求，
> 建议清理对应日志段；并确认 `Referrer-Policy: no-referrer` 生效（已内置）。

### 部署必做
1. **改 `JWT_SECRET`** 为随机长串（默认值可被伪造 token）
2. **H3 后端不要暴露公网**：`<你的H3内网地址:端口>` 应只允许本机/内网访问
   （建议安全组/防火墙只放行 H3 Studio 所在主机，或仅监听内网）
3. **上 HTTPS**：公网部署务必用 Nginx + Let's Encrypt，并设 `ENABLE_HSTS=true`
   （同时会自动给 Cookie 加 `Secure`）
4. 生产环境设置 `SKIP_EMAIL_VERIFICATION=false`，并保证 SMTP 可用

---

---

## 长视频失败的排查（重要·v0.6）

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

---

## 错误排查：ref2va 报错 / prompt 丢失（v0.6~v0.7）

### 1) `checkpoint partition 'fl2va' supports ['fl2va','t2va'], got task='ref2va'`
这是 **H3 服务端（K8s）配置问题**，与本网站无关。

原因：`vllm serve` 命令里带了 `--task-type fl2va`，只加载了 FL2VA 一个 DiT；
参考素材（ref2va）需要 Ref2VA 那个 DiT，因此被拒绝。

修复（改 deployment 的 args）：
- **去掉 `--task-type fl2va`**，让服务同时加载两个 DiT（180GB 卡足够）；
- serve 路径指向**仓库根目录**，而不是 `FL2VA/` 子目录。

> ⚠️ 注意：这么改之后，若根目录残留 FastH3 标记文件，服务会起不来——请一并阅读
> 下文「serve 根目录残留 FastH3 标记文件，服务无法启动」。

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
这是 **v0.6 的代码缺陷**（v0.7 已修）：v0.6 为实现长超时引入了 `undici` npm 包，
它与 Node 内置的 `FormData` 不兼容——请求体被当成普通对象字符串化成
`[object FormData]`（仅 17 字节），H3 收不到任何字段。

v0.7 已**移除 undici 依赖**，改用 Node 内置 `http/https` 自行构造 multipart，
超时仍完全可控，且无额外依赖。

---

---

## 错误排查：ref2va 报 "accepts at most 3 video references"（v0.8）

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
图片 ≤9、视频 ≤3、独立音频 ≤3、总数 ≤12；**每个参考视频时长 2–15 秒、参考视频合计 ≤15 秒**
（超长会自动截取，见下文）。

---

---

## 三种模式全支持：多后端路由（v0.9）

H3 每个服务进程只加载一个分区，分区决定可用任务：

| serve 路径 | 支持任务 | 端口示例 |
|---|---|---|
| `.../FL2VA` + `--task-type fl2va` | `t2va`、`fl2va` | 8003 |
| `.../Ref2VA` + `--task-type ref2va` | `ref2va` | 8004 |

错误 `checkpoint partition 'ref2va' supports ['ref2va'], got task='t2va'` 就是
「把 t2va 发给了只服务 ref2va 的后端」。

**要三种模式全支持，跑两个 H3 服务，并在网站配置：**

```ini
# 默认后端（serve FL2VA 分区）：承载 t2va / fl2va
H3_BASE_URL=http://<host>:8003
# ref2va 专用后端（serve Ref2VA 分区）
H3_BASE_URL_REF2VA=http://<host>:8004
H3_REF2VA_API_KEY=          # 若该后端需要鉴权
```

网站会按 `mode` 自动路由：`ref2va` → `H3_BASE_URL_REF2VA`，其余 → `H3_BASE_URL`。
若 `H3_BASE_URL_REF2VA` 留空，则所有任务都发往默认后端（旧行为，兼容单后端部署）。

---

---

## 重新生成（失败重试·v1.0）

失败的任务卡片上会出现 **「重新生成」** 按钮（在「删除」左边），点击即把该任务
重新入队，**无需重新上传参考文件或重填提示词**。

- 失败时服务端**保留**参考文件，供重生成复用（文件在该任务被删除时才清理）。
- 若参考文件已丢失，重生成会提示「参考文件已不在，请重新上传后再提交」。
- 生成中/排队中的任务不能重复触发（返回 409）。

---

## 错误排查：密码没错却提示「邮箱或密码错误」（v1.9.5）

**症状**：密码确定没错，登录却一直返回「邮箱或密码错误」；浏览器里直接显示一坨
`{"error":"邮箱或密码错误"}` 这样的裸 JSON；服务端日志显示 `登录失败 (空)`（邮箱是空的）。

**根因**：前端本意是用 JS 以 `application/json` POST 登录，但服务端只挂了 `express.json()`。
只要浏览器**原生提交表单**——旧页面被缓存、JS 被拦截、旧内核解析 `?.` 报错、脚本异常——
body 就变成 `application/x-www-form-urlencoded`，`express.json()` 不解析 → `req.body` 为空 →
永远拿不到邮箱/密码，于是恒报「邮箱或密码错误」，日志记成 `登录失败 (空)`。

**修复（v1.9.5）**：

- 服务端追加 `express.urlencoded()`，原生表单提交也能正确取到 `email`/`password`。
- 登录接口按 `Accept`/`Content-Type` 区分：JSON 请求返回 JSON；原生表单提交则 `303` 跳回
  `/?auth_error=...`，不再让浏览器直接显示裸 JSON。
- 前端读取 `?auth_error=` 并用横幅提示。
- 静态 `js/css` 改为 `Cache-Control: no-cache`（`app.js` 无版本号，旧脚本被长期缓存会放大该问题）。

---

## 错误排查：重启后任务永远卡在「生成中」（v1.9.4）

**症状**：提交任务后重启 h3-studio（或容器/Pod 重建），重启前那几条任务一直显示「生成中」，
反反复复等很久，实际上 GPU 根本没在跑。

**根因**：worker 队列（`queue` / `running` 两个内存变量）不会持久化。重启后队列清空，
但数据库里 `status='running'`/`'queued'` 还在——前端只看数据库，于是永远显示「生成中」。

**修复（v1.9.4）**：

- **启动自愈**：进程启动时把残留的 `running`/`queued` 自动改为 `error`，备注
  「服务重启，任务已中断（可点「重新生成」重跑）」，并**保留参考文件**。
- **卡死提示**：`running` 超过「`H3_TIMEOUT_MS` + 5 分钟」仍未落库，卡片显示黄色提示。
- **手动接管重跑**：对已 `stale` 的 `running` 任务，点「重新生成」会强制从旧进程手里接管重跑。

> 重启前正在生成的任务**无法自动续跑**（H3 同步接口不支持断点续传），只能重跑。
> `H3_TIMEOUT_MS` 默认 30 分钟，单段打满 15 秒视频也远低于该值，正常任务不会被误判 `stale`。

---

---

## 错误排查：长视频（>15 秒）第 1 段报 "t2va does not accept image/video/audio conditions"（v1.1）

**根因（已修复）**：长视频分段时，第 1 段的模式被硬编码为 `t2va`，但仍带上了用户
上传的参考文件 → `t2va` 不允许任何图/视频/音频条件 → 报错。

正确行为（现版本）：

| 段 | 模式 | 参考文件 |
|---|---|---|
| 第 1 段 | 用户所选（t2va/fl2va/ref2va） | 用户上传的原始参考 |
| 后续段 · 抽帧成功 | `fl2va` | 上一段末帧 |
| 后续段 · 抽帧失败 | `t2va` | 无 |

这也解释了「15 秒能成功、超过 15 秒失败」——单段走另一条保留原模式的路径。

### 附带修复：ffmpeg 版本兼容
分段归一化原先用了 `-fps_mode cfr`，该选项仅 ffmpeg 5+ 支持；宿主机为 4.4 时会报
`Unrecognized option 'fps_mode'`。已改为 `-vsync cfr`（4.x 与 5+/7.x 均兼容）。

---

---

## 修复：长视频在段边界播放中断（v1.2）

**症状**：拼接后的长视频播放到某处（如 29 秒视频的 ~15 秒）卡住，往后拖又能看到画面。

**根因**：段边界时间戳不连续。v1.1 虽已"逐段归一化"，但拼接仍用 `-c copy`
流拷贝——即使各段时间戳已归零、帧率固定，AAC 编码器延时与容器时长误差仍会在
段边界留下 0.02~0.07s 的间隙。

**实测对比**（12s+13s+4s 三段）：

| 拼接方式 | 段边界间隙 |
|---|---|
| 归一化 + `-c copy`（v1.1） | ❌ 有 |
| 归一化 + **重新编码**（v1.2） | ✅ 无 |

**修复**：拼接阶段改为重新编码（`-c:v libx264 -c:a aac -vsync cfr`），
保证一条连续时间轴；输出加 `-movflags +faststart` 便于边下边播。

---

---

## 长视频上限与资源（v1.3）

**时长上限**：由 `MAX_DURATION_SEC` 控制（默认 1800 = 30 分钟）。H3 单段硬上限 15 秒，
超出部分自动分段续写 + 拼接。旧版本硬编码 120 秒，v1.3 起可配置。

**内存**：v1.3 起，成片**直接落盘**（`fs.renameSync`），不再用 `readFileSync` 把整片读进内存。
实测各环节内存：

| 环节 | 峰值内存 | 与时长关系 |
|---|---|---|
| ffmpeg 归一化（单段） | 约 60~100 MB | 仅与**单段**有关，恒定 |
| ffmpeg concat 拼接 | 约 100 MB（3 分钟实测） | 流式解复用，**几乎与总时长无关** |
| 网站进程 | 旧版会整片进内存 → 已修 | v1.3 后恒定 |

因此 **1~2 GB 内存的机器也能拼接很长时间的视频**——瓶颈不在 ffmpeg 内存，
而在生成耗时与磁盘。

**磁盘**：1344×768 / crf18 下，成片约 26 MB/分钟 → 30 分钟约 0.8 GB，
另有等量的分段中间文件（任务结束即清理）。

**生成耗时（真正的瓶颈）**：H3 单段 15 秒约 4~6 分钟 →
- 5 分钟视频 ≈ 20 段 ≈ 1.5~2 小时
- 30 分钟视频 ≈ 120 段 ≈ 10~12 小时

---

---

## 修复：拼接报 "Unrecognized option 'vsync'"（v1.4）

固定帧率选项名随 ffmpeg 版本而异，写死任一个都会在某些版本上崩：

| ffmpeg | `-fps_mode` | `-vsync` |
|---|---|---|
| 4.x | ❌ | ✅ |
| 5~7 | ✅ | ✅（弃用别名） |
| **8+/9.x** | ✅ | ❌ **已移除** |

v1.4 起**运行时探测一次**（`ffmpeg -h full` 里找 `fps_mode`，退而 `vsync`，
都没有则仅用 `-r 24`）并缓存，兼容全部版本。抽帧处也去掉了该选项。

---

## 错误排查：ref2va 报 "reference video 0 duration must be in [2, 15] seconds"（v1.6.2）

**症状**：ref2va 模式（带参考图/参考视频）生成失败，第 1 段就报
`H3 返回 500：{"error":{"message":"Video generation failed: reference video 0 duration must be in [2, 15] seconds, got 157.500"...}}`；
而**纯文本（t2va）同样时长却正常**。

**根因**：H3 对 ref2va 的每个参考视频有硬校验——时长必须 ∈ [2,15] 秒，且所有参考视频
合计 ≤15 秒。用户上传的整段长视频（如 157.5 秒）被原样转发给 H3，直接被拒。
t2va 不带任何参考文件，不触发此校验，所以「纯文本能成、带参考就挂」。

**已修（v1.6.2）**：提交前统一规整参考视频（`server/longvideo.js` 的 `normalizeReferenceVideos`）：

1. 用 `ffprobe` 探测每个参考视频时长；
2. 超过上限的，**重编码截取**到允许长度（`-c copy` 会按关键帧切到 15.2s，仍超限，
   故必须重编码；并留 0.1s 余量避开浮点边界）；
3. 多视频按**剩余总时长预算**动态收敛，保证合计 ≤15 秒；
4. 短于 2 秒的片段直接给出明确报错，提示换用更长的片段。

前端同样在提交前预检并提示（超长会提示「已自动截取前 15 秒」）。

> 上传限制（`MAX_REF_VIDEO_SEC`，默认 15）可在 `.env` 调整；**不要**设成 >15，
> 因为 H3 后端硬上限就是 15 秒。

---

---

## 权重文件布局与「两分区两权重」（v1.7 补充）

H3 的 **T2V/I2V（fl2va）分区与 R2V（ref2va）分区权重不通用**，必须各自单独下载、单独起服务进程。
邮箱里最常见的「t2va 能用、ref2va 报错」多半是把任务发给了只加载 fl2va 权重的后端。

| 用途 | 权重文件 | 目录 |
|---|---|---|
| T2V / I2V（fl2va） | `minimax_h3_fl2va_pruned_int8_convrot` | `diffusion_models/` |
| R2V（ref2va） | `minimax_h3_ref2va_pruned_int8_convrot.safetensors`（**另下，约 19.5 GB**） | `diffusion_models/` |
| 文本编码器 | `qwen3vl_32b_minimax_h3_nvfp4_awq` | 文本编码器目录 |
| 视频 VAE + 音频 VAE | 各一个（Load VAE） | vae 目录 |

**两分区两进程的推荐布局**（对应上面的 `H3_BASE_URL` / `H3_BASE_URL_REF2VA`）：

```bash
# 进程 1：serve FL2VA 分区 -> 承载 t2va / fl2va
vllm serve <serving-model-path>/FL2VA  --task-type fl2va  --port 8003 ...
# 进程 2：serve Ref2VA 分区 -> 承载 ref2va
vllm serve <serving-model-path>/Ref2VA  --task-type ref2va --port 8004 ...
```

> 注意：单进程「serve 根目录 + 不加 `--task-type`」也可同时支持三任务，但前提是子目录
> 不含 FastH3 标记文件（见下一节）。无论如何，ref2va 都需要 ref2va 权重在位。

**上线前自检**：登录后访问 `/api/health/detail`，会分别探两个后端并列出各自地址；
两个后端都 `ok:true` 才说明三模式全通。

---

---

## 分辨率、画幅与帧数（v1.7）

H3 的硬规则（来自官方部署文档）：

- **原生画布**：短边 768、面积上限 `768×1344`、**每轴对齐 32 的倍数**；Megapixels≈1.0 时
  16:9 得 `1344×768`，质量最好。低于 384p（短边 < 384）几乎必然失败。
- **帧数必须落在 `17k+5` 网格**；不合法会被**静默向上吸附**（填 61 帧实际得 73 帧，不报错）。
  训练区间 `124–362` 帧，24fps 即 **5.17–15.08 秒**；常用合法帧数：124/158/192/245/293/362。

v1.7 的处理：

- **分辨率跟随画幅比例**，每个比例给「预览 / 标准 / 2K（实验性）」三档，全部为 32 的倍数；
  不再出现「9:16 + 1344×768」这类自相矛盾的组合。2K 远超原生画布，会明显变慢且可能失真，
  界面已标注为实验性。
- **时长吸附到帧网格**：服务端把秒数换算成合法帧数再回算秒数（如 5s → 124 帧 → 5.17s），
  因此 H3 不会再发生静默吸附，你填的和生成的对得上；提交后若发生吸附，界面会明确提示。
- 服务端另做**尺寸纠偏**：每轴向上取到 32 的倍数，短边 < 384 直接拒绝并说明原因。

---

---

## 提示词格式指南（v1.7 内置）

H3 官方提示词的三种形态，本站已按模式自动处理或提供模板：

**1) T2V / T2VA：三字段结构**

```
integrated_multimodal_description: <画面/动作/镜头/光线的完整描述>
overall_soundscape: <环境音，如雨声、脚步、门铃>
non_diegetic_music: <配乐，如一段中速木吉他，结尾渐弱>
```

**2) I2V 家族（fl2va）：正文前多一行「对齐指令」** —— 本站已**自动注入**（首帧→0.00s，
末帧→该段实际时长，精确两位小数），无需手写。三种官方变体：

```
# 只给首帧（I2VA）：
For the target video, at 0.00 seconds into the target video, (from [Shot 1]) is fully referenced.
# 首尾都给（FL2VA）：
How the reference pictures align with the target video — Picture 1 (from Shot 1) aligns with the 0.00-second mark of the target video; Picture 2 (from Shot 1) aligns with the 8.00-second mark of the target video.
```

**3) R2V（ref2va）：六段式结构**（本站界面提供可填空模板，按上传顺序自动列出 `<Picture N>` 等标签）：

```
subject_definitions  给每个参考定义标签与特征
summary              [任务类型] 一句话概括
retention_analysis   逐标签声明保留程度
detailed_description 主体，350–500 英文词
overall_soundscape   环境音
non_diegetic_music   配乐
```

四类标签各管各的：`<Subject N>`（要复用的内容）、`<Picture N>`（一张图当某帧/构图锚点）、
`<Video N>`（整片级关系）、`<Audio N>`（复制/参考的音频）。另外 `ref_image_size` 可选
`match`（默认，快）/ `max`（角色更保真但慢数倍）。

> 小贴士：本地没有官方的 Context-IR 改写模块，可让任意 LLM 按
> `https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/docs/VIDEO_PROMPT_WRITING_GUIDE_base_en.md`
> 把你的大白话改写成三字段格式。

---

## 提示词助手（v1.9）

> 背景：H3 内置的文本编码器是**裁剪版 Qwen3-VL-32B**（仅保留前 50 层，砍掉 `lm_head` 与 final norm），
> **没有生成能力**，只把文字压成特征隐向量喂给 DiT。所以手写「一段连贯的散文」会让镜头/环境音/配乐
> 三类特征在隐空间互相干涉，直接导致镜头乱切、音画打架。前端必须有一个独立 LLM 充当「执行导演」。
> 本节的三项功能正是补齐这一环（参考社区项目 `pytraveler/MiniMax-H3-Prompt-Rewriter-ComfyUI` 的做法，
> 但本站是服务端实现，不需要本地显存）。

### 1）提示词自检（`POST /api/prompt/check`）

纯静态、不调模型、毫秒级。检查项（`!` = H3 很可能读错；`-` = 规范只是建议）：

| 类别 | 检查内容 |
|---|---|
| 镜头结构 | `[Shot 1]` 是否起头、编号是否从 1 连续、`At MM:SS.mmm` 切点是否严格递增且在时长内 |
| 时间戳网格 | 分镜里的时间轴（`0:00–0:04`）是否落在 **17n+5** 物理帧网格上，否则提示会静默舍入 |
| 对白标记 | `<d></d>` 是否成对，每段是否以 `[语言]` 标签开头 |
| 参考素材双向核对 | 当前任务扛不住的标签（T2VA 里的任何标签、FL2VA 里的 Video/Audio）；**接了却从未被引用的素材** |
| 六段式账目（ref2va） | 六个字段是否齐全；每个 `<Subject N>` 是否在 `retention_analysis` 有交代；`detailed_description` 是否 350–500 词 |
| 对齐行 | FL2VA 是否缺对齐指令（服务端会自动注入，此处仅提醒） |
| 特效 token | 大写 `Embedding:` / token 粘词 / 末尾句号会被静默丢弃；非官方 10 个的名字只记提示 |

前端「✓ 提示词自检」按钮；重写后会**自动跑一遍**并把结果附在响应里（`check` 字段）。
**发现只被说出来，从不拦截提交**——模型有时把规则掰弯是对的，是否接受由你决定。

### 2）AI 重写（`POST /api/prompt/rewrite`）

把一句想法按当前模式（t2va / fl2va / ref2va）重写成对应结构，并在 system prompt 里注入官方写作规范、
目标时长与可用参考标签。返回 `prompt` + `model` + `usage` + `check`，另带 `note`（附加说明）与 `storyboard`（是否分镜脚本）两个字段。

**长时长处理（v1.9.2 修复）**：

- **T2VA 且总时长 >15 秒** → 改写为**分镜脚本**（`总设定` + `### 分镜时间轴` + 逐镜头 `镜头 N｜起始–结束｜N 秒｜标题`，
  时间轴严格连续、末镜头右端 = 目标总时长）。该格式与 `longvideo.js` 的 `parseStoryboard`/分段续写对齐，
  服务端按 ≤15 秒自动聚段并拼接，**总时长不再受单段上限限制**；system prompt 附上与后端逐段生成一致的**分段计划**。
- **FL2VA / Ref2VA 且总时长 >15 秒** → 这两种模式不支持自动分段续写，按 15 秒（362 帧 · 15.08s）重写，
  并在 `note` 里明确告知（前端黄色提示条）；自检的目标时长同步收敛到实际单段值，不再误报。

> 旧行为（v1.9.1 及以前）：重写器把「总时长」直接交给帧网格函数，超 15 秒被截到 362 帧；
> 若 GUI 里停留的默认时长是 5 秒，system prompt 便写死「目标时长 5.17 秒（124 帧）」，
> 于是不管原文多长都重写成 5.17 秒。

### 3）描述素材（`POST /api/prompt/caption`）

把上传的参考图片交给识图模型，逐张生成「`<Picture N>`：主体/场景/色调/构图」描述，追加进提示词，
可直接再喂给「AI 重写」。视频/音频素材不解码，只列出标签提示人工引用。

### 配置（环境变量）

| 变量 | 默认 | 说明 |
|---|---|---|
| `LLM_BASE_URL` | 空 | OpenAI 兼容端点（如 `https://onrouter.cn/v1`）。空则隐藏「AI 重写」 |
| `LLM_API_KEY` | 空 | 端点密钥（可空，如本地 vLLM） |
| `LLM_TEXT_MODEL` | 空 | 重写用的文本模型（如 `customonrouter/gpt-6-sol`） |
| `LLM_VISION_MODEL` | 空 | 识图模型（如 `customonrouter/grok-4.7`）。空则隐藏「描述素材」 |
| `LLM_TIMEOUT_MS` | `180000` | 单次调用超时 |
| `LLM_MAX_IMAGE_BYTES` | `8388608` | 单张参考图上限（超限跳过） |

> 未配置时对应按钮自动隐藏（`/api/config` 返回 `assistant:{rewrite,vision}`），不会点了报错。
> 密钥只从环境变量读入，出站请求带 `Authorization` 头，不落盘、不回显。

---

---

## 错误排查：serve 根目录残留 FastH3 标记文件，服务无法启动（v1.7）

**症状**：去掉 `--task-type`、并让 `vllm serve` 指向仓库根目录后，服务起不来，Orchestrator
初始化报 `ValueError: FastH3 V2 requires --diffusion-attention-backend FASTVIDEO_VSA`。

**根因**：根目录残留了 FastH3 的标记文件，导致 H3 把普通权重误判为 FastH3 模块化版本。

- `checkpoint.py::is_minimax_h3_modular()` 的判定是「目录下存在
  `modular_model_index.json` **或** `fastvideo_inference.json`」即视为 modular；
- 未显式指定 `--task-type` 时其默认值为 `auto`，而 `pipeline_minimax_h3.py` 中
  `if modular and task_type == "auto": self.partition = "fl2va"`，于是走进 FastH3 契约校验；
- `fasth3_checkpoint.py::check_serving_contract()` 是**硬校验**，无开关可跳过，
  只接受 `--diffusion-attention-backend FASTVIDEO_VSA`，否则抛错、进程退出。

**修复（推荐，保留单进程三任务）**：把标记文件移出 serve 根目录，走非 modular 分支即可
同时支持 `t2va` / `fl2va` / `ref2va`：

```bash
cd <serving-model-path>
mkdir -p _fasth3_markers_backup
mv fastvideo_inference.json modular_model_index.json provenance.json _fasth3_markers_backup/ 2>/dev/null
```

保持「serve 根目录 + 不加 `--task-type` + 原 `--diffusion-attention-backend`」，重启后
`curl http://<host>:8003/health` 应正常。

**若确实要用 FastH3 V2（8 步蒸馏版）**：保留标记文件，但必须同时加
`--task-type fl2va --diffusion-attention-backend FASTVIDEO_VSA`，且此后仅 `fl2va` / `t2va`
可用，`ref2va` 不可用。

**兜底方案**：起两个进程分别 serve 子目录（`FL2VA` + `--task-type fl2va` → 8003；
`Ref2VA` + `--task-type ref2va` → 8004），前提是子目录内不含上述标记文件。

---
