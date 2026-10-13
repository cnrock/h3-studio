# H3 Studio — Kubernetes 部署

一套完整清单，一条命令部署：**Namespace / ConfigMap / Secret / PVC / Deployment / Service / Ingress**。

> 目录：`deploy/k8s/`

## 1. 先改三处

| 文件 | 改什么 |
|---|---|
| `01-configmap.yaml` | `PUBLIC_BASE_URL`（邮件链接）、`H3_BASE_URL`（你的 H3 后端地址）、SMTP 账号 |
| `02-secret.yaml` | `JWT_SECRET`（`openssl rand -hex 32`）、`SMTP_PASS`、`H3_API_KEY` |
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
cnrock/h3-studio:<版本>          # 当前清单默认 1.8.3
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

## 5. 与内网/公网的关系

- H3 后端在集群外内网：`H3_BASE_URL` 直接写内网 IP，Pod 网络需可达。
- 对外访问：用 Ingress + 域名（推荐配 TLS）；或临时用 NodePort `http://<节点IP>:30787`。
- 若前置 Nginx：`proxy_read_timeout 1800s; client_max_body_size 64m;`（同 `deploy/nginx.conf`）。

## 6. 卸载

```bash
kubectl delete -k deploy/k8s/
# PVC 默认保留；确认不再需要再删：
kubectl -n h3-studio delete pvc h3-studio-data
```
