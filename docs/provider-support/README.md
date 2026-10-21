# Provider 支持矩阵

记录各 Provider 的支持范围、能力与版本兼容。
版本矩阵在接入真实实例时逐步核实与收窄。

## 认证

| Provider | 方式 | 状态 |
|---|---|---|
| GitHub | GitHub App(RS256 JWT → 安装级短期 token) | ✅ M1 |
| GitHub Enterprise Server | 自定义 Provider Host(同 App 机制) | 接口就绪,版本矩阵待核 |
| GitLab | OAuth Application / Bot Access Token(Bearer) | ✅ M1 |
| GitLab self-managed | 同上,自定义 Host | 接口就绪,版本矩阵待核 |
| Forgejo / Gitea | OAuth2 / PAT(`token`/Bearer) | ✅ M1 |

## 能力矩阵(当前 Adapter 声明)

| 能力 | GitHub | GitLab | Forgejo |
|---|:--:|:--:|:--:|
| inlineComments | ✅ | ✅ | ✅ |
| multilineComments | ✅ | ✅ | ❌ |
| reviewBatches | ✅ | ❌ | ❌ |
| resolvableThreads | ✅¹ | ✅ | ❌ |
| commitStatuses | ✅ | ✅ | ✅ |
| checksApi | ✅ | ❌² | ❌² |
| approvals | ✅ | ✅ | ✅ |
| createChangeRequest | ✅ | ✅ | ✅ |
| description get/update(§25.1) | ✅ | ✅³ | ✅³ |
| pipelines listRuns/getJobs/getLogs(§29) | ✅ | ✅⁴ | ❌⁵ |
| reactions 接手回执 👀(§ack) | ✅ | ✅⁶ | ✅⁷ |
| repositories.getFileContent(§37) | ✅ | ✅⁸ | ✅ |

¹ GitHub 线程 resolve 走 GraphQL `resolveReviewThread`(comment databaseId → 线程 node id)。
² GitLab/Forgejo 无 GitHub 式 Checks API,统一用 commit status(`checks.createOrUpdate` 映射到 status)。
³ GitLab MR `description`(PUT merge_requests/:iid)/ Forgejo PR `body`(PATCH pulls/:index)。
⁴ GitLab CI:`pipelines/:id/jobs` + `jobs/:id/trace`;listRuns 回填 repositoryId,终态 status 即 conclusion。
⁵ Forgejo Actions API 版本不定,`getJobs`/`getLogs` 抛 `not_implemented`,待对真实实例核实。
⁶ GitLab `award_emoji`(MR / issue)。
⁷ Forgejo/Gitea `issues/:index/reactions`(PR 亦为 issue)。
⁸ GitLab files API 必须带 `ref`(缺省用 `RepositoryRef.defaultBranch`),文件路径整体 URL 编码。

不支持的能力在调用对应操作时抛 `UnsupportedCapabilityError`,不静默降级。

## Webhook

| Provider | 验签 | 事件(M1 归一化) |
|---|---|---|
| GitHub | `X-Hub-Signature-256`(HMAC-SHA256,常量时间) | pull_request / issue_comment / push / installation |
| GitLab | `X-Gitlab-Token`(常量时间相等) | Merge Request / Note / Push Hook |
| Forgejo | `X-Forgejo-Signature` / `X-Gitea-Signature`(HMAC-SHA256) | pull_request / issue_comment / push |

## Live 契约测试

统一契约测试(`providerContractSuite`)默认针对 `FakeProviderServer` 运行。
针对真实实例的 live 冒烟测试通过环境变量启用(缺失即跳过),见
`packages/provider-github/test/live.test.ts`。运行示例:

```bash
REVIEWBOT_LIVE_GITHUB_TOKEN=ghp_xxx \
REVIEWBOT_LIVE_GITHUB_REPO=owner/name \
REVIEWBOT_LIVE_GITHUB_PR=1 \
pnpm vitest run packages/provider-github/test/live.test.ts
```

## 版本兼容矩阵(TBD-007/008)

按 Adapter 实际调用的 API 端点推断的**最低支持版本**;标 “待核” 者需接入真实实例后收窄。

| Provider | 最低版本 | 依据(所用 API) | 字段/行为差异 |
|---|---|---|---|
| GitHub.com | 持续 | REST v3、Actions runs/jobs/logs、Checks | 基准实现 |
| GitHub Enterprise Server | **≥ 3.4**(待核) | Actions API(GHES 3.0+)、Checks(GHES 2.x+);3.4 起 Actions 稳定 | `html_url` 主机名不同;App 安装流程一致 |
| GitLab SaaS | 持续 | REST v4:MR/pipelines/jobs trace、discussions | 基准实现 |
| GitLab self-managed | **≥ 13.0**(待核) | MR pipelines(11.0+)、job `trace`(稳定)、MR `description` PUT | discussions position 结构随版本微调 |
| Forgejo | **≥ 1.20**(待核) | Gitea 兼容 REST:pulls/issues/comments、PR `body` PATCH | Actions API(1.20+)形态不定 → pipelines 未实现;multiline/threads 缺失 |
| Gitea | **≥ 1.19**(待核) | 同上(Forgejo 派生自 Gitea) | 同上 |

- 版本号在接入真实 GHES/self-managed/Forgejo 实例后逐步核实与收窄;
- 遇低于最低版本的端点缺失,Adapter 抛 `UnsupportedCapabilityError` / `not_implemented`,不静默降级。

## 待建立

- 对真实 GHES / GitLab self-managed / Forgejo 实例核实上表版本号并补 recorded fixtures;
- Forgejo Actions pipeline getJobs/getLogs(对 `lkforgejo` 核实 API 后实现)。
