# ADR-004 整 Job 重试 + 副作用幂等

- 状态:accepted

## 背景

Review 是多阶段流程。可选实现复杂的阶段级 durable workflow(可从中间阶段恢复),但代价高。

## 决策

采用**整 Job 重跑**:内部分析可从头重跑,不实现阶段级恢复。所有外部副作用必须**幂等**——使用幂等键、发布记录(`publication_records`)与 Provider 侧对账,确保崩溃重试不产生重复。新 Head 出现后旧 Revision Job 标记 `superseded`,发布 Gate 拒绝旧结果。

## 结果

- 大幅简化 Worker 恢复逻辑;
- 幂等与 Head recheck 成为强制不变量,不因重跑省略;
- 失败 Attempt 的日志/Artifact 可保留供诊断,但不用于恢复。
