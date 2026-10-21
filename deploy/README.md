# winnowl 部署 / Runbook

沉淀 live 手工 `docker run` 编排为可复现的 Dockerfile + compose。目标环境:单机 Docker(exe.dev VM 或等价)。

## 拓扑

| 服务 | 作用 | 端口 |
|---|---|---|
| `postgres` | 状态存储(jobs/findings/conversations/…) | 5432(内部) |
| `migrate` | 一次性应用 `migrations/`,完成即退出;首建 `winnowl:latest`(backend 阶段) | — |
| `control-api` | Web Console 数据端点 + 审批/配置端点 | 8080(默认 `127.0.0.1`) |
| `webhook-ingress` | Provider webhook 入口(验签→入队) | 8081(默认 `127.0.0.1`) |
| `runner-supervisor` | 消费 job,跑 review/fix/pipeline/issue/security;起 sandbox 容器 | — |
| `web` | nginx:服务 Web Console SPA + 同源反代 `/v1`→control-api、`/webhooks`→webhook-ingress(**`edge` profile**) | 8000(单公网入口,`WEB_PORT` 可覆盖) |

## 部署模式(一套 compose 通吃三种)

后端(control-api/webhook)**默认仅绑 `127.0.0.1`**(本机可调试、绝不公网暴露);`web`(nginx 单公网入口)在 **`edge` profile**,默认不起。nginx 经 docker 网络到达后端,不依赖 host 端口发布。

| 模式 | 命令 | 对外 | 说明 |
|---|---|---|---|
| **开发测试** | `docker compose up -d` | 无(仅 `127.0.0.1:8080`/`8081`) | 本机 `curl localhost:8080/8081` 调试;不建前端/不跑 nginx |
| **普通服务器** | `docker compose --profile edge up -d` | `0.0.0.0:${WEB_PORT:-8000}`(nginx) | console + `/v1` + `/webhooks` 单口对外;后端内网。要直连后端设 `CONTROL_API_BIND=0.0.0.0` / `WEBHOOK_BIND=0.0.0.0` |
| **exedev**(单公网口) | `docker compose --profile edge up -d` + VM `proxy_port`→`WEB_PORT` | 同上,VM 唯一公网口指向 `web` | GitHub webhook URL:`https://<vm>.exe.xyz/webhooks/github` |

GitHub webhook URL(edge):`http://<host>:${WEB_PORT}/webhooks/github`。`env_file: .env` 为**可选**(缺失不硬崩;`POSTGRES_PASSWORD` 仍必填,`:?` 守卫报错)。

### 完整部署(叠加辅助服务)

`docker-compose.full.yml` 在 base 上叠加 **Vault(Transit KMS)/ MinIO(S3 ArtifactStore)/ Jaeger(OTel)** + init(自动建 transit key / bucket)+ 把三应用接线指向它们(登录不在栈内,见下):

```bash
docker compose -f docker-compose.yml -f docker-compose.full.yml --profile edge up -d --build
```

辅助服务凭据见 `.env.example` 顶部「完整部署」段。登录见下方「认证」。**辅助服务均 dev/单实例**(Vault dev、MinIO/Jaeger 单节点),完整功能验证用;live 的多主机部署见下文「拆分部署」。

### Langfuse(LLM 可观测性,**独立主机**)

`deploy/langfuse/` 是一套自带 postgres/clickhouse/redis/minio 的完整栈,跑在**另一台机器**上。

**为什么不同机**:实测过,装不下。winnowl 那台 2C/8G,现有容器 ~775M,而 review sandbox 峰值是
`RUNNER_CONCURRENCY`(3)× 2G = 6G,已占 87%;Langfuse 一套还要 ~3G,叠上去必触 OOM。
降 review 并发换观测不划算,故单开一台(live:`lklangfuse`,与 winnowl 同区 lax)。

```bash
# Langfuse 主机上
scp -r deploy/langfuse <host>:~/langfuse
cd ~/langfuse
LANGFUSE_ADMIN_EMAIL=you@example.com LANGFUSE_BASE_URL=https://<host>.exe.xyz bash gen-secrets.sh
docker compose up -d
# winnowl 侧 .env(见 .env.example 的 Langfuse 段),然后 docker compose up -d 重注入 env
```

首启自举好 org/project/管理员与一对 API key(`LANGFUSE_INIT_*`),不用先去 UI 点一遍;注册已关
(`AUTH_DISABLE_SIGNUP`),公网上只剩一个登录页。除 web 外全部只绑 127.0.0.1;ClickHouse 内存硬限 3G。

两个曾经的缺口都已消除(2026-08-03/08-04):
1. ~~看不到 review 主路径~~ —— squid allowlist 加了 Langfuse 主机 + executor 内 `initTelemetry`,
   map/dig/verify 与工具调用的 span 都到得了。
2. ~~没有成本~~ —— pi 早算好的 `gen_ai.usage.cost` 会被收下(2026-08-04 实测:v2 metrics API
   `sum totalCost` 有值)。**别看 observations API 的 `totalPrice`** —— 那是 Langfuse 按自己价目表
   算的另一路,`gpt-5.6-*` 不在表里所以恒为 null,与我们送的成本无关。查成本用:
   `GET /api/public/v2/metrics?query={"view":"observations","metrics":[{"measure":"totalCost","aggregation":"sum"}],...}`。

**认证**(§39.3):**没有 IdP**——control-api 自己跑 forge OAuth 并签发 httpOnly session cookie,授权真源是 DB `memberships`。未配登录源时所有请求是匿名 `viewer`(**无 tenant**):SPA 外壳与 `/health` 可用,但 `/v1` 数据端点按 tenant 作用域(§38.7),匿名请求返回 `400 no_tenant_in_context`。

开登录三步:
1. `.env` 配 `GITHUB_OAUTH_CLIENT_ID` / `GITHUB_OAUTH_CLIENT_SECRET`(直接用 **GitHub App 自己的** OAuth 凭据)+ `CONSOLE_BASE_URL`(console 公网地址;redirect_uri 与 CSRF 白名单的基址,刻意不从 Host 头推断);
2. GitHub App 设置页把 Callback URL 填成 `<CONSOLE_BASE_URL>/v1/auth/github/callback`;
3. 会话密钥:`SESSION_SIGNING_KEY`(base64 ≥32B)或复用已有的 `KMS_KEK_BASE64`(自动 HKDF 派生);两者都没有则 control-api **启动即失败**(不会用弱默认值)。

**console 在 Cloudflare Pages(live)**:console 与 API 不同源 —— console `https://winnowl.lollipopkit.com`(Pages,`scripts/deploy-pages.sh <commit>` 部署,构建时 `VITE_API_BASE` 指向 API),API 与 webhook `https://winnowl-api.lollipopkit.com`(hskb 上共享的 nginx-proxy 经 tailscale 地址 → control-api / 两个 webhook-ingress 实例,站点配置见 `deploy/nginx/edge/winnowl-api.conf`)。Pages 不反代任何路径,前端带 `credentials: 'include'` 直连 API;control-api 只给 `CONSOLE_BASE_URL`/`CSRF_ALLOWED_ORIGINS` 里的来源回 CORS 头,授权仍由 session 决定。两个主机同站(`lollipopkit.com`),`SameSite=Lax` 的 httpOnly session cookie 照常随请求发出。API 主机用一级子域是因为 Cloudflare 免费证书只覆盖 `*.lollipopkit.com`。没有「靠不转发来保护」的路径:`/metrics` 要 `METRICS_TOKEN`,`/docs` 只给平台运维。前端 CSP 禁内联脚本。

登录后首次进来的用户没有任何 membership(仍是 viewer),需要 owner 邀请或直接 seed 一条 `memberships`。webhook 入站与 runner 处理不依赖登录,配好 GitHub App 即可端到端跑 review。

## 首次部署

```bash
cd deploy
cp .env.example .env          # 填 POSTGRES_PASSWORD / LLM_* / GitHub App / webhook secret
# secrets 目录:放 github-app.pem(GITHUB_APP_PRIVATE_KEY_PATH 指向)。
# 生产**必须**放部署树之外并在 .env 设 SECRETS_DIR(绝对路径),防重部署 rsync 覆盖:
mkdir -p ~/winnowl-secrets && echo 'SECRETS_DIR=/home/<user>/winnowl-secrets' >> .env
# dev 可省略 SECRETS_DIR,缺省 ./.secrets:
mkdir -p .secrets
# 开发测试:仅后端(127.0.0.1 直连调试)
docker compose up -d
# 普通服务器 / exedev:加 --profile edge 起 nginx 单公网入口(自动 build 前端)
docker compose --profile edge up -d --build
docker compose logs -f runner-supervisor
```

`migrate` 依赖 pg healthy;三应用与 `web` 依赖 `migrate` 成功完成(`service_completed_successfully`)。edge 模式下 Web Console 浏览器打开 `http://<host>:${WEB_PORT:-8000}`(配好 `GITHUB_OAUTH_*` 后可登录看数据/写)。

## 更新

```bash
git pull
docker compose build
docker compose up -d          # 滚动重建改动的服务
```

**注意**:改动 `.env`(如 `BOT_NAME`)后需 `docker compose up -d`(重建容器注入新 env),`restart` 不重载 env。

**nginx 配置**:base 配置烤进 `winnowl-web:latest`;若需变体,以**目录**挂载(`deploy/nginx/<variant>` → `/etc/nginx/conf.d`),
改完 `docker compose exec web nginx -s reload` 即生效。
过去挂单文件时,rsync/scp 覆盖走 temp+rename 换 inode,容器内 mount 仍指旧 inode → reload 读到旧内容
(2026-07-21 曾造成 resolver 修复的「假阳性验证」+ 一段 502 断投递窗口);目录挂载按名字解析,不再有此坑。

## Secret 管理

- App 私钥、KEK 等 **勿入镜像**;经 `.env` + `SECRETS_DIR`(缺省 `./.secrets`)只读挂载。
- **`SECRETS_DIR` 生产必须指部署树外绝对路径**(如 `/home/<user>/winnowl-secrets`):部署 rsync 只同步部署树,树外目录永不被覆盖。若源目录不存在,docker 会静默建**空目录**挂入 → runner 报 `no github app credentials`(2026-07-17 live 踩过:挂载源 `deploy/.secrets` 被建成空目录)。部署后验证:
  ```bash
  docker compose exec runner-supervisor test -s /app/.secrets/github-app.pem && echo OK
  ```
- 生产应经 KMS / secret manager 注入:
  - webhook secret:设 `WEBHOOK_KEK_ID`+`WEBHOOK_KEK_BASE64`(本地 KEK)或接 Vault(`createVaultMasterKey`),secret 落 `provider_credentials`(§42);
  - Vault/MinIO/Jaeger/Mailpit 等自托管服务见对应 §42/§43/§41/§35 接线;登录见 §39.3(forge OAuth)。

## Sandbox(§11)

`runner-supervisor` 挂载宿主 `docker.sock` 起 sandbox 容器。**生产应换 rootless Docker / gVisor(runsc)/ Kata**,并按 §11.6 经 Egress Proxy(`buildEgressProxyConfig`)约束出站;当前默认 `network: none` 内核隔离。

### 生态知识来源(0004)

运维在 console「生态知识」页的「来源」里登记官方 release notes / breaking changes 页面。runner 每小时检查一次,同一来源 7 天读一次:经 Exa `/contents` 抓取(只用 `EXA_API_KEY`,不新增出网主机),内容 hash 没变就跳过;变了就用 cheap 档模型抽出 breaking change / 弃用 / 移除类事实,和 review 提交的事实走同一套注入检测与去重,落为 `proposed`(来源 `feed`),运维审批后才注入。没配 `EXA_API_KEY` 时整个功能不启动。

## 健康 / draining

- pg 有 healthcheck;应用 `restart: unless-stopped`。
- `runner-supervisor` 收到 SIGTERM/SIGINT 进入 draining(停领新 job,§10.6),在 `RUNNER_DRAIN_TIMEOUT_MS` 内等在途 job 完成;
  超时或收到第二个信号 → abort 在途 job、拆沙盒、8s 后放回队列(不计尝试次数)。默认 0 = 立即 abort。
  `stop_grace_period`(`RUNNER_STOP_GRACE_PERIOD`)必须大于 drain 时长,否则 docker 中途 SIGKILL。live 叠加层默认 40m / 41m。
- live 更新用 `scripts/deploy-live.sh <commit> [--now] [--dry-run]`(git archive → 换目录 → build/migrate → 重建;
  runner 默认在宿主后台重建,旧 runner drain 完再起新的;`--now` 立即 abort 在途 job 并前台重建)。
- live 是拆分部署:API 主机(`DEPLOY_API_HOST`,`docker-compose.split-api.yml`:
  postgres / MinIO / 可观测性 / API / runner-supervisor,数据与密钥只在这里)+ 任意台 sandbox 主机(`DEPLOY_SANDBOX_HOSTS`,
  独立的 `docker-compose.sandbox-host.yml`:sandbox-agent + egress-proxy + registry-proxy,无 DB / KEK / App 私钥)。主机间走私网(tailscale)。
  sandbox 主机的 `~/winnowl-secrets/deploy.env` 设 `PRIVATE_BIND`、`AGENT_SLOTS`(+ `DOCKER_SOCK`,
  + `AGENT_MEMORY_MB`:沙盒内存上限之和的预算,按主机内存定,超出的创建排队;vie 7.8G 设 7168 = 一个 4G 验证 + 六个 review);
  API 主机另设 `SANDBOX_AGENT_SECRET`。agent token 哈希、`SANDBOX_AGENTS`、prometheus 目标、`APP_VERSION` 与出网白名单
  (`squid.conf`,API 主机上用新镜像生成后分发)由部署脚本生成。
  磁盘配额 slot:sandbox 主机上 `sudo deploy/scratch-slots.sh <个数> <池 GiB> <工作区 GiB> <用户> [单 slot 上限 GiB]` 一次
  (xfs 稀疏镜像 + direct-I/O loop + 项目配额,systemd 单元开机挂载;另装配额服务 `winnowl-scratch-quota.socket`,
  agent 经它按沙盒设限额),deploy.env 设脚本最后打印的 `AGENT_SCRATCH_SLOTS` / `AGENT_SCRATCH_POOL_MB` /
  `AGENT_SCRATCH_MAX_SLOT_MB`。`workspace: 'disk'` 的沙盒各占一个 slot,限额按沙盒定、可在线扩(`resize`),之和不超过池,
  用前用后清空。vie:8 个 slot 共享 80 GiB,单个最多 40 GiB。
  swap:沙盒可带 `swapMb`(内存的一半,只扛短时峰值);sandbox 主机 `sudo deploy/zswap.sh` 一次开 zswap(压缩缓存挡在磁盘 swap 前)。
  模型中转:API 主机的 `llm-relay`(`PRIVATE_BIND:8793`,需要 `PRIVATE_BIND`)——沙盒里的 review 经它调用模型与 Exa /
  Context7,sandbox 主机上没有任何 key;部署写入 `LLM_RELAY_PUBLIC_URL` 与管理令牌的 sha256,squid 白名单随之只放行中转。
  验证沙盒(§28.1)= API 主机 deploy.env 设 `VALIDATION_SANDBOX_IMAGE`:部署把它传给 sandbox 主机(放行;首次使用时拉取,
  之后每日 refresh 更新),验证沙盒走 `registry-proxy`(只放行包 registry,`squid-registry.conf` 在 sandbox 主机上生成)。
  加 sandbox 主机 = 装 tailscale + 上面三项 + 加进 `DEPLOY_SANDBOX_HOSTS` 再部署;公网入口见 `nginx/edge/winnowl-api.conf`。
  webhook 入口在 API 主机上跑两个实例(`webhook-ingress` 绑 `WEBHOOK_BIND:8081`、`webhook-ingress-b` 绑 `WEBHOOK_BIND:8082`),
  公网反代对两者负载并把失败的投递转给另一个(按 delivery id 去重，重投安全);部署与每日 refresh 用
  `deploy/recreate-rolling.sh` 逐个重建，等新实例健康检查通过再换下一个，重建期间投递不再 502。
  每台主机每天由 `winnowl-refresh.timer` 按最新 alpine 重建镜像并清理旧镜像。

## SLO / 告警

建议初始 SLO(接 OTel §41 指标后以真实数据校准):

| 指标 | 目标 | 告警阈值 |
|---|---|---|
| webhook-ingress 验签→入队 P99 | < 500ms | > 2s 持续 5m |
| review_revision 端到端 P95 | < 8min | > 20min |
| job 失败率(非 policy_denied) | < 2% | > 5% 持续 10m |
| worker 心跳 | ≤ 30s | 无心跳 > 90s |
| queue 积压(queued) | < 50 | > 200 持续 10m |

告警经 OTel/Prometheus(`OTEL_EXPORTER_OTLP_ENDPOINT` 指向 collector);无 collector 时以 pino 日志 + 外部日志告警兜底。

**Grafana**:数据源与 dashboard 都自动 provision——`grafana-datasource.yml`(Prometheus + Tempo)+ `grafana-dashboards.yml`
(provider,指向 `deploy/grafana/dashboards/`)。预置 `Winnowl — Overview`(队列深度 / Job 速率与失败率 / 时长 p50p95 /
review 事件 / finding 严重度 / LLM 成本 platform-vs-byok / webhook 投递 / 插件外呼 / 依赖扫描 / target up)。
改 dashboard JSON 后 30s 内自动重载,无需重启容器。

**链路追踪(live)**:各服务与 runner 转发的沙盒 span 都发 OTLP/HTTP 到 `otel-collector:4318`(`otel-collector.yaml`),
collector 批量转给 Tempo(`tempo.yaml`,单进程、本地卷、保留 7 天)。两者都不发布端口;在 Grafana 的 Explore 里选 Tempo 数据源,
按 trace id 或 TraceQL(如 `{resource.service.name="winnowl-review-executor"}`)查。full compose(dev)仍用 Jaeger all-in-one。

## 备份

- **Postgres**:每日 `pg_dump`(或连续归档 WAL)。示例(cron):
  ```bash
  docker compose exec -T postgres pg_dump -U winnowl winnowl | gzip > backup/winnowl-$(date +%F).sql.gz
  ```
  保留 ≥ 30 天;定期演练恢复(`gunzip -c | psql`)到临时库验证可读。
- **Artifact**(S3/MinIO):bucket 版本化 + 生命周期(过期擦除,§43 retention);跨区复制按合规。
- **Secret**:App 私钥 / KEK 由 KMS(Vault)/secret manager 托管并备份,勿仅存单机 `.secrets`。

## DR 演练(季度)

1. 新环境 `docker compose up`(空库)→ 迁移自动跑到最新。
2. 从最近备份 `psql` 恢复 → 校验 review runs / findings 计数。
3. 重新配置 Provider webhook 指向新 ingress;推测试 commit 验证端到端(见 [[reviewbot-vm-live-deploy]])。
4. 记录 RTO/RPO;目标 RTO < 1h、RPO < 24h(按备份频率)。

## Draining 全链路演练

`docker compose stop runner-supervisor` → 收 SIGTERM 进入 draining(停领新 job,完成在途,§10.6);
观察在途 job 完成后进程退出、无 job 丢失(lease 过期由 `sweepExpiredLeases` 兜底重排)。

## 待补(运维交付物)

- 外部安全审计(第三方机构,需真实签字);
- SLO 阈值以生产真实数据校准 + 告警规则落地(Prometheus/Grafana)。
