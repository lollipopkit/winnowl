# ADR-007 Canonical Diff 与语义锚点

- 状态:accepted

## 背景

Provider diff 存在截断、渲染差异且行号易随 Revision 漂移。评论定位若直接依赖模型给出的行号,极易错位。

## 决策

事实来源以 Git object 与**自有 Canonical Diff** 为准,Provider diff 仅用于 UI 校验、Anchor 适配与截断检测。模型永不直接给出最终 Provider 行号;发布定位经**语义锚点解析器**(exact window → symbol → AST → token → fuzzy → unresolved),满足唯一性与分数门槛且当前 SHA 复验通过后才生成 Provider anchor。Anchor 失败降级 file/summary,不丢弃 Finding。

## 结果

- inline 定位可达 ≥99% 正确率;
- Finding 主键与语义指纹稳定,支持增量 Review;
- Provider anchor 仅发布前生成,不作为稳定主键。
