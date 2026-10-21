# ADR-003 PostgreSQL 队列

- 状态:accepted

## 背景

需要任务队列与 Worker 协调。可选 Redis / Kafka / Temporal 等专用中间件,但会增加 P0 运维依赖。

## 决策

使用 **PostgreSQL** 作为队列与 Worker 协调存储:`FOR UPDATE SKIP LOCKED` 领取任务,lease + heartbeat + sweeper 管理租约,规范化标签表做 selector 匹配。P0 阶段**不得**引入 Redis / Kafka / Temporal 作为必需依赖。

## 结果

- 单一数据存储,事务性强,运维面小;
- 任务、幂等记录、发布对账共享同一事务边界;
- 若未来吞吐超出单库能力,再评估分片或专用队列,不作为初期成本。
