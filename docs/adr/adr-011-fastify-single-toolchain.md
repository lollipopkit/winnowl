# ADR-011 Fastify + 单一 TypeScript 工具链

- 状态:accepted

## 背景

HTTP 层框架有更快选项(uWebSockets.js、Bun 系、Rust axum/actix)。评估是否为吞吐更换框架或引入 Rust。

## 决策

HTTP 层采用 **Fastify**,并保持**单一 TypeScript 工具链**,不引入多语言服务。

理由:
- **瓶颈不在 HTTP**。请求成本由 PostgreSQL、Provider API、模型调用与 Sandbox 执行(秒~分钟级)主导,框架路由开销为微秒级,对整体延迟无可测量影响;
- **支持/生态/安全性最优**。Fastify 属 OpenJS 基金会,LTS 政策与安全披露成熟,官方插件覆盖本项目所需(raw body 验签、rate-limit、helmet、OpenTelemetry),`fastify-type-provider-zod` 满足 OpenAPI 3.1 + Zod;默认 schema 校验与原型污染防护契合安全底线;
- **多语言成本高于收益**。`control-api` 与 `review-worker` 共享 `domain/config/db/policy` 等包(§6.3),换语言意味着领域模型双语维护或额外 RPC 层。

若未来 profiling 证明存在 CPU 热点(canonical diff、anchor fuzzy、BLAKE3、tree-sitter),以 `napi-rs` 原生模块嵌入对应 TS 包优化,不改变服务边界与语言统一性。

## 结果

- 全仓单一构建/测试/部署工具链,贡献门槛低;
- HTTP 框架不成为伸缩瓶颈;
- Rust 的合理落点是自托管 `runner-supervisor` 或热点原生模块,而非 HTTP 层——留待后续按需评估。
