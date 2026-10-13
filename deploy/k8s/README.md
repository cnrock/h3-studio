# H3 Studio — Kubernetes 部署

一套完整清单，一条命令部署：**Namespace / ConfigMap / Secret / PVC / Deployment / Service / Ingress**。

> 目录：`deploy/k8s/`

## 1. 先改三处

| 文件 | 改什么 |
|---|---|
| `01-configmap.yaml` | `PUBLIC_BASE_URL`（邮件链接）、`H3_BASE_URL`（你的 H3 后端地址）、SMTP 账号；要用提示词助手（v1.9）再填 `LLM_BASE_URL` / `LLM_TEXT_MODEL` / `LLM_VISION_MODEL` |
| `02-secret.yaml` | `JWT_SECRET`（`openssl rand -hex 32`）、`SMTP_PASS`、`H3_API_KEY`；LLM 端点需要鉴权时再填 `LLM_API_KEY` |
| `06-ingress.yaml` | `host`（你的域名）；不用 Ingress 可删该文件 |

## 2. 部署

```bash
# 方式一：kustomize（推荐，改一处镜像 tag 全量生效）
kubectl apply -k deploy/k8s/

# 方式二：逐个 apply
kubectl apply -f deploy/k8s/01-configmap.yaml
kubectl apply -f deploy/k8s/02-secret.yaml
kubectl apply -f deploy/k8s/03-pvc.yaml
kubectl apply -f deploy/k8s/04-deployment.yaml
kubectl apply -f deploy/k8s/05-service.yaml
kubectl apply -f deploy/k8s/06-ingress.yaml

# 验证
kubectl -n h3-studio get pods,svc,ingress
kubectl -n h3-studio logs -l app=h3-studio --tail=20
kubectl -n h3-studio port-forward svc/h3-studio 8787:8787
# 浏览器打开 http://127.0.0.1:8787
```

## 3. 镜像

```
cnrock/h3-studio:<版本>          # 当前清单默认 1.9.1
```
- 官方发布；**多架构**（linux/amd64 + linux/arm64），x86 / ARM 集群均可直接拉取。
- `latest` 指向最新版本。
- 升级：改 `kustomization.yaml` 的 `newTag`（或 Deployment 的 image tag）后 `kubectl apply -k deploy/k8s/`。

## 4. 重要约束

- **必须单副本**：任务队列在进程内串行、SQLite 单写；多副本会争用数据库、重复排队。`replicas: 1` + `Recreate` 已配好。
- **长超时**：视频生成最长 30 分钟（`H3_TIMEOUT_MS`）。Deployment 探针用轻量 `/api/health`；Ingress 已用注解放宽读超时到 1800s。换其他 Ingress 控制器需对应放宽。
- **持久化**：`/app/data` 挂 RWO PVC（SQLite + 上传 + 生成视频）。视频会累积，按需调大容量。
- **H3 后端连通性**：容器要能访问 `H3_BASE_URL`。同集群内用 Service 名；集群外用内网 IP（本清单默认内网 IP 直连）。
- **资源**：ffmpeg 分段拼接吃 CPU，`limits.cpu` 按机器规模调。

## 5. 提示词助手（v1.9）——可选

v1.9 新增「提示词自检 / AI 重写 / 描述素材」。其中：

- **提示词自检**：纯服务端静态检查，**不调任何模型**，开箱即用。
- **AI 重写 / 描述素材**：需要一个 OpenAI 兼容的 LLM 端点。不配则这两个按钮自动隐藏，其余功能正常。

三件事：**端点在 ConfigMap，Key 在 Secret，按钮按配置自动显隐。**

### 5.1 用集群内自建 vLLM（推荐，不依赖公网）

在 ConfigMap 填端点（Service 名 + `/v1`）：

```yaml
LLM_BASE_URL: "http://vllm-llm.h3-studio.svc.cluster.local:8000/v1"
LLM_TEXT_MODEL: "Qwen3-32B"        # 与 vllm serve 的 --served-model-name 一致
LLM_VISION_MODEL: "Qwen2.5-VL-7B"  # 需要「描述素材」才填
```

- vLLM 启动时若**没加 `--api-key`**，`LLM_API_KEY` 留空即可（此时不发 `Authorization` 头）。
- 若加了 `--api-key`，把同一个值填进 Secret 的 `LLM_API_KEY`。
- 连通性：Pod 要能访问该 Service（同命名空间直接写 Service 名；跨命名空间用上面的全限定名）。

### 5.2 用云端网关

```yaml
LLM_BASE_URL: "https://onrouter.cn/v1"
LLM_TEXT_MODEL: "customonrouter/gpt-6-sol"
LLM_VISION_MODEL: "customonrouter/grok-4.7"
```

并把 Key 填进 **Secret** 的 `LLM_API_KEY`（不要写进 ConfigMap）。
用现成 Secret 补 key 而不重建整个 Secret：

```bash
kubectl -n h3-studio patch secret h3-studio-secret \
  --type merge -p '{"stringData":{"LLM_API_KEY":"sk-你的key"}}'
kubectl -n h3-studio rollout restart deploy/h3-studio
```

> LLM Key 只从环境变量读入，不落盘、不回显。改完 ConfigMap/Secret 记得 `rollout restart` 让 Pod 重新载入。
> 建议给识图模型配 `LLM_MAX_IMAGE_BYTES`（默认 8MB）避免参考图过大拖慢调用。

## 6. 与内网/公网的关系

- H3 后端在集群外内网：`H3_BASE_URL` 直接写内网 IP，Pod 网络需可达。
- 对外访问：用 Ingress + 域名（推荐配 TLS）；或临时用 NodePort `http://<节点IP>:30787`。
- 若前置 Nginx：`proxy_read_timeout 1800s; client_max_body_size 64m;`（同 `deploy/nginx.conf`）。

## 7. 卸载

```bash
kubectl delete -k deploy/k8s/
# PVC 默认保留；确认不再需要再删：
kubectl -n h3-studio delete pvc h3-studio-data
```
