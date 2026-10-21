# ADR-002 Provider 能力协商

- 状态:accepted

## 背景

GitHub / GitLab / Forgejo 等平台在 inline 评论、多行评论、review batch、resolvable thread、checks API 等能力上存在差异,且自托管实例版本各异。

## 决策

核心领域只使用抽象的 `Repository / ChangeRequest / Revision / Discussion / …`,Provider 作为 Adapter。每个 Change Request 携带 `ChangeRequestCapabilities`,核心逻辑基于**能力协商**:既不把所有 Provider 降为最低公共能力,也不假设 GitHub 特性普遍存在。不支持的能力显式返回 `UnsupportedCapability`,禁止静默降级。

## 结果

- 新增 Provider 只需实现 Adapter 与通过统一 contract test;
- 发布逻辑按能力选择 inline / file / summary 表达;
- 自托管版本差异通过能力矩阵与兼容测试管理。
