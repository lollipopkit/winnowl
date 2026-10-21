# ADR-008 高召回发现 / 高精度发布

- 状态:accepted

## 背景

代码 Review 需同时兼顾"少漏"与"少误报",但二者在单一流程内相互冲突。

## 决策

区分两条流水线:**高召回发现**阶段宁可保留更多 Candidate;**高精度发布**阶段只将有充分证据、可操作、非重复且定位可信的问题表达为确定 bug。Candidate / Finding / Publication 三层分离。Verifier 默认 `REJECT unless proven`,高严重度还需独立 Refuter。未确认但高风险的 Candidate 进入 `Unverified risks`,不静默丢失也不冒充确定 bug。

## 结果

- 误报率与漏报率可分别度量与调优;
- 发布门槛(Publication Matrix)是硬约束,评分只用于排序;
- Coverage 作为一等数据,未完成 Scope 必须如实标注。
