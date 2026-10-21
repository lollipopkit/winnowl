# ADR-006 可信控制面 / 不可信 Sandbox

- 状态:accepted

## 背景

Review 需在客户仓库中执行任意命令(构建、测试、依赖安装),这些代码与其产物均不可信,存在 Prompt injection、凭据窃取、网络 exfiltration、Sandbox escape 等威胁。

## 决策

严格分离信任边界:**控制面可信**,持有 Provider 与数据库凭据、Publisher、Runner supervisor;**执行面不可信**,默认无凭据、无网络。Provider Token 永不进入 Sandbox。安全边界由 Sandbox 隔离、无密钥、网络隔离、受控工具、权限策略与输出校验提供,**不依赖 Prompt**。SaaS 生产采用 microVM/Kata 级隔离,自托管可用 rootless container。

## 结果

- 恶意仓库代码无法获取凭据或访问控制面;
- Sandbox 后端抽象可替换(microVM / rootless container);
- 所有隔离项由安全测试套件强制。
