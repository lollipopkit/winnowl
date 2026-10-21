# 安全态势 / 审计就绪

供第三方安全审计参考:数据流、信任边界、控制点与对应实现。**外部审计签字**为独立运维交付物;
本文覆盖“代码侧可审计性”。

## 信任边界

1. **Provider → webhook-ingress**:不可信入站。HMAC 验签(常量时间)后方处理;验签对**原始 body**完成
   (JSON 与表单模式同,raw/decoded 分离,`webhook-verify.ts` / `normalize.jsonBodyOf`)。
2. **LLM agent → 源码**:agent 只读工具集(`buildSourceTools`),不执行仓库代码;探索在只读 worktree。
3. **Fix / sandbox**:PR 代码在 sandbox 执行(§11);默认 `network: none` 内核隔离,tmpfs 工作区,
   pids/内存/磁盘上限,只读 rootfs,docker.sock 不暴露(`sandbox` 安全套件测试)。
4. **Runner(远程自托管)**:Registration Token → Runner Token → Job Token(仅当前 Job),
   HMAC 短期签名(`runner-http`);Job Token 越权访问他 Job 被拒。

## Secret 处理(§42/§43)

- Provider 凭据 / webhook secret **信封加密**(AES-256-GCM DEK,KEK 包裹)落 `provider_credentials`,
  明文不落库(`kms.encryptEnvelope`);KEK 来源:本地(测试/自托管)或 **Vault Transit**(密钥不离 Vault,
  版本化轮换,`createVaultMasterKey`)。
- 令牌轮换:`createRefreshingToken`(过期自动刷新,并发去重)。
- Provider Token **绝不回前端**(`rbac.redactForFrontend`,深度剔除敏感键);日志不记 token/secret/完整源码/
  完整 prompt(§41.3)。
- Artifact:`S3ArtifactStore`(bucket 加密 + 生命周期);retention 擦除(§43)。

## 身份与授权(§39.3)

- **OIDC**:`createOidcAuthResolver`——Bearer JWT 经 JWKS 验签 + iss/aud/exp,claim → 角色/scopes/tenant/actor;
  未知角色降级 viewer(不提权),无效令牌 → 匿名。
- **RBAC**:角色/权限矩阵 + API scope + 固定窗口限流(`rbac`);路由经 `requirePermission`/`requireScope`。
- **ActionPlan**:高风险动作(branch-write/merge)需显式确认(`canExecutePlan`:Actor/Conversation/Head/
  过期/权限/repo 策略),批准即入队,幂等键防重放。

## 租户隔离(§38.7)

- 应用层:所有业务查询显式带 `tenant_id`(§38.7);跨租户在端点层 404(归属校验)。
- 纵深防御:**RLS**(migration 0018,20 表 force RLS + tenant_isolation 策略,permissive-when-unset)+
  `withTenantScope`(事务内 `set_config app.tenant_id`);受限角色 + GUC 下强制隔离。

## 出站控制(§11.6)

- 默认 `none`(内核隔离);`allowlist`/`package-registry-only` 经 Egress Proxy(`buildEgressProxyConfig`
  → squid:默认拒绝、仅放行显式主机/生态 registry、永久阻断内网/metadata、access.log 审计)。
- 破坏性 exploit **绝不自动运行**(`AUTO_RUNS_DESTRUCTIVE_EXPLOIT=false`);安全 finding 私密渠道投递
  (audit_events + 可选 SMTP,exploit 细节不进公开 PR)。

## 审计与可观测(§41)

- `audit_events`:凭据管理、ActionPlan 确认、security scan、cross-repo impact 等留痕。
- 结构化日志(pino)+ OTel Tracing(`initTelemetry`,OTLP 导出,env 门控)。
- webhook 无效投递留存(不静默丢失)。

## 供应链

- bot **不改 CI workflow**(`stripWorkflowChanges` 剔除 `.github/workflows/` 改动 + agent 约束);
  App 权限清单不含 `Workflows: Write`。
- 依赖固定(pnpm lockfile);镜像多阶段构建(`deploy/Dockerfile`)。

## 审计切入点(建议)

| 关注 | 代码 |
|---|---|
| 验签 | `provider-*/src/webhook-verify.ts`、`normalize.jsonBodyOf` |
| 加密 | `packages/kms`(envelope/vault)、`packages/artifacts/s3-store` |
| 认证授权 | `apps/control-api/src/{oidc,rbac}.ts`、`packages/rbac` |
| 租户隔离 | `migrations/0018_*`、`packages/db/tenant-scope` |
| sandbox | `packages/sandbox`(network/egress/docker-backend)+ 安全套件测试 |
| 令牌 | `packages/runner-http/tokens`、`provider-http/refreshing-token` |

## 待第三方

- 独立安全审计机构评审 + 签字(合规上线前);
- 渗透测试(sandbox 逃逸、webhook 重放/伪造、RLS 绕过、令牌伪造)。
