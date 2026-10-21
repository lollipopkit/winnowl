# ADR-005 Pi Agent Core

- 状态:accepted

## 背景

需要 LLM 多轮 loop、tool calling、streaming 与多供应商模型抽象。可自研或复用现成 Agent 运行时。

## 决策

采用 `@earendil-works/pi-agent-core` 与 `@earendil-works/pi-ai` 作为**单次 Agent invocation** 的运行时。**不**以 `spawn("pi", ...)` 运行 CLI,**不**把完整 `pi-coding-agent` 默认工具集暴露给 Review Job。Job 编排、Stage orchestration、Sandbox、状态、Evidence、验证策略、Publication、Provider 集成全部由本项目承担。

## 结果

- 复用成熟的 loop / tool-calling / provider 抽象;
- 工具集、权限、Schema、预算由框架控制,不依赖 Agent 自律;
- 模型供应商可策略化配置,不绑定单一厂商。
