# Winnowl

多 Provider 的 AI Code Review 平台。名字取自 winnow —— 扬谷去糠:候选问题先经复核,
站不住的丢掉,只有活下来的才发到 PR 上。

- 架构决策记录:[`docs/adr/`](./docs/adr/)
- 部署:[`deploy/README.md`](./deploy/README.md)(单机 compose;live 为 API 主机 + sandbox 主机的拆分部署)

## 能做什么

- **PR 评审**:行内评论 + 一份摘要;候选问题经复核后才发布,可给出一键提交的建议。
- **自动修复**:在 PR 上评论 `@winnowl fix`,修复开成独立 PR,不写你的分支。
- **增量**:每轮只看真正改动的地方;报过的不重复,修好的关掉,上一轮未修的明确列出。
- **门禁**:新引入的依赖漏洞、上一轮未修复的 blocking finding 可阻断合并。
- **多 forge**:GitHub / GitLab / Forgejo 同一套流程;整套可自托管。
- **在你的 GitHub Actions 里跑**:`sandbox.runner: actions` + 仓库根的 [`action.yml`](./action.yml),用你自己的模型 key(`llm-model` 填你的端点提供的模型;开跑前会逐个检查模型可用);review 默认可在 runner 上以独立的无权限用户执行构建 / 测试命令(`sandbox.run_commands`,每条命令先经审查);fork 的 PR 拿不到 OIDC token,会直接报错而不是改回平台。
- **配置随仓库**:仓库内 `.winnowl.yaml`(JSON Schema 见 [`config-schema/`](./config-schema/))优先于面板设置。

## 技术栈

TypeScript(strict 全开)· pnpm monorepo · Fastify(ADR-011)· PostgreSQL + Kysely ·
Zod + OpenAPI 3.1 · SvelteKit + shadcn-svelte(Web Console)· Vitest + Testcontainers ·
OpenTelemetry + Pino。

> 内部 workspace 包仍叫 `@reviewbot/*`(私有、不发布)。**对外的一切** —— 产品名、bot 名、
> 配置文件、JSON Schema、API 标题、HTTP User-Agent —— 一律 Winnowl。

## 环境要求

- Node.js:见 [`.node-version`](./.node-version)
- pnpm ≥ 10
- Docker(集成测试与本地部署)

## 常用命令

```bash
pnpm install            # 安装依赖
pnpm build              # tsc -b 构建全部包(项目引用)
pnpm typecheck          # 类型检查
pnpm lint               # ESLint
pnpm depcruise          # 包依赖规则静态检查
pnpm config:schema      # 生成 .winnowl.yaml 的 JSON Schema
pnpm test               # 单元测试
pnpm test:integration   # 集成测试(需要 Docker)
pnpm check              # typecheck + lint + depcruise + schema 校验 + 单元测试
```

## 目录结构

```text
apps/          可独立部署的进程(control-api / webhook-ingress / runner-supervisor / review-executor / web-console)
packages/      领域与能力包(review 管线、provider 适配、配置、鉴权、知识库等)
migrations/    显式 SQL 迁移
config-schema/ 由 config 包生成的 JSON Schema(.winnowl.yaml)
prompts/       agent prompt 资产
deploy/        compose / Dockerfile / nginx
docs/          规格、阶段计划、ADR、安全与条款
```

包依赖方向与隔离约束由 `pnpm depcruise` 在 CI 强制。

## License

[Apache-2.0](LICENSE)
