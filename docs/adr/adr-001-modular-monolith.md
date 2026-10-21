# ADR-001 模块化单体

- 状态:accepted

## 背景

系统包含控制面、Webhook、Review Worker、Runner Supervisor、Web Console 等多个逻辑单元。需要在演进速度与部署灵活性之间取舍。

## 决策

采用**模块化单体**代码库(pnpm monorepo),部署为多个进程(`control-api`、`webhook-ingress`、`review-worker`、`runner-supervisor`、`web-console`)。包边界与依赖方向由 `dependency-cruiser` 静态强制。`review-worker` 与 Runner 必须可独立扩缩容。

## 结果

- 单一工具链、单一类型系统,跨包重构成本低;
- 通过进程边界与依赖规则获得可独立伸缩的关键单元;
- 不引入分布式服务网格的运维复杂度;
- 未来某单元确需独立演进时,清晰的包边界使拆分成本可控。
