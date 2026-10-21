# ADR-010 Learning 审批模型

- 状态:accepted

## 背景

用户反馈与 Agent 观察可沉淀为长期 Review 规则,但自动写入长期记忆会放大误判并引入被投毒风险。

## 决策

长期 Learning 固定流程:**Agent proposes → Repository admin reviews → approves/rejects → approved learning becomes active**。只有 Repo Admin 可 approve/revoke。所有 Learning 保留来源、作用域、审批人、版本、有效期与撤销记录。一次用户 dismiss 不自动成为长期规则;Agent 仅可根据重复模式提出提案。

## 结果

- 长期知识可审计、可撤销、有明确责任人;
- 不可信仓库文本无法直接改变 Review 行为;
- 反馈仍被记录用于提案,但生效需人工批准。
