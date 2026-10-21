# ADR-014 Web Console 面向租户开放(tenant-facing console)

- 状态:accepted(调研+设计 2026-07-19,P0–P4 代码侧同日实现;剩 live 切换 `AUTHZ_SOURCE=db`(部署侧)+ P5 独立轨,见 §5)
- 实现注记:§5 分期 P0–P4 已落码(`routes/me.ts`(/v1/me+/v1/subscription+/v1/dashboard)、rbac `usage:read`、`getRunners` includeShared、web-console `lib/me.ts`+`visibleNav`+`/team`+Dashboard 首屏+租户切换器);与设计的偏离:①learnings KPI 用分页 total 复用(未做 last-30d-used 统计);②`/config`/`/installations` 未加 minRole(页面只读部分 viewer 可用,写操作端点侧已门控);③~~邀请仍 token 手动分发~~(已补:control-api `mailer.ts` nodemailer + 邀请路由投递(失败不撤销/emailSent 回执/token 兜底)+ console `/invites/[token]` accept 页;env `SMTP_HOST`+`MAIL_FROM`+`CONSOLE_BASE_URL`;邮件正文暂英文,本地化待用户偏好)。
- 关联:ADR-012(采纳制);竞品参照 CodeRabbit web 面板(docs.coderabbit.ai)

## 1. 背景与现状

web-console(SvelteKit SPA,`apps/web-console`)现为**单一受众**形态:14 个导航项(`src/lib/nav.ts`)对所有登录用户全量展示,无角色/运维身份裁剪;live 实际只有 `admin-user` 一个账号在用。要把控制台开放给**租户(客户)**,现状盘点:

**已具备(地基)**:
- **数据隔离**:全部 read-model 查询显式 `where tenant_id`(`apps/control-api/src/read-model.ts`),tenantId 从 `req.auth.tenantId` 解析,无租户上下文 → 400(`routes/data.ts:29`);RLS 0018 作纵深防御。
- **端点权限**:control-api 各路由已按 `requirePermission` 门控(rbac 角色 owner/admin/member/viewer,`packages/rbac/src/roles.ts`);platform-operator 与租户角色**正交**(env `PLATFORM_OPERATOR_SUBS` 白名单,`platform-operator.ts`)。
- **租户自助 API 大部分已存在**:members/invites、byok、service-credentials(org/user)、tenant-settings、global-learning 采纳/policy。
- **UI 已覆盖**:reviews/findings/suppressed/coverage/usage/repositories(config)/audit/conversations/plugins(BYOK+凭据+插件开关)/learnings(采纳收件箱)。

**缺口(本 ADR 要解决的)**:
1. **导航无受众裁剪**:`/global-learnings`(端点全 `requirePlatformOperator`,普通租户点开即 403)与 `/runners`(worker 池运维语义)对租户可见;侧栏也不按角色隐藏写操作入口。
2. **单租户假设**:前端从不发送租户标识、无租户切换;后端 DB authz 已支持 `X-Tenant-Id` 选活动租户(`auth-db.ts:69-80`),UI 未接——多租户成员(如乙方顾问)降级为无租户 viewer。
3. **members/invites 有 API 无 UI**:租户自助开号(邀请成员/改角色/移除)完全没有前端,是租户自治的最大缺口。
4. **无租户概览页**:登录直接落列表页,缺 CodeRabbit 式 Dashboard(KPI/趋势)作为客户的第一屏。
5. **无计划/配额页**:P4 计划/配额(plans/subscriptions/`periodUsage`)已实现并在 review 链路强制,但租户看不到自己的计划、余量、degrade 状态;Stripe 计费(独立轨)未接。
6. **live 授权真源仍是 claims 模式**:`AUTHZ_SOURCE` 缺省 claims——role/tenant 读 JWT、**无 userId**,user 级自助(`/v1/my/service-credentials`)返回 400;租户自助开号(邀请→接受)必须 DB memberships 真源才闭环。
7. **小暴露面**:runners read-model 的共享 worker 池元数据 `tenant_id IS NULL` 跨租户可见(`read-model.ts:533`,job 计数已隔离);`/v1/usage` 仅 `review:read`(成本数据 viewer 可见,需决策是否收紧)。

## 2. 参照:CodeRabbit web 面板功能面(2026-07 调研)

CodeRabbit 面板的功能与受众(取自官方 docs/changelog):

| 功能 | 内容 | 对应本项目 |
|---|---|---|
| **Dashboard(分析)** | Summary KPI(active repos/merged PRs/active users/median merge time/**reviewer time saved**)、Org Trends(周吞吐/活跃/CI 失败)、Quality Metrics(评论按严重度/类别的**接受率**钻取)、Knowledge Base 贡献度、Pre-merge Checks 通过率 | 无对应页;数据大半已有(review_costs/findings/coverage/checks) |
| **Repositories** | 仓库列表 + per-repo 设置(yaml 或 UI,central config) | 已有(`/repositories` + config 表单,§37/§40) |
| **Integrations** | Slack/Teams/Jira 等 | 无(非目标,见 §3) |
| **Reports** | 定时报表(自然语言 prompt 定制,邮件/Slack/Teams 投递,标准/晋级用) | 无(推迟,见 §6) |
| **Learnings** | KPI 卡(total/active/never-used/本周新增)+ 可排序表 + 元数据 | 已有列表+采纳,缺 KPI/用量统计 |
| **Organization Settings** | org 级配置、path instructions、自定义角色(企业:per-resource No/RO/RW) | tenant-settings 已有(插件片段);自定义角色非目标 |
| **Team Management** | 成员/角色/邀请 | **API 已有、UI 缺**(§1 缺口 3) |
| **Subscription/Billing** | 计划、席位、账单 | plans/subscriptions 已有、UI 缺;Stripe 独立轨 |
| **Account** | 个人设置、API key | `/plugins` 已有「我的 key」;API token 非目标 |

**取舍原则**:选**客户日常自助**必需的(看结果、管仓库配置、管成员、管 key、看用量/配额),不追分析深度(reviewer-time-saved 之类的 ROI 建模)与外呼集成(Slack/Jira)。

## 3. 目标 / 非目标

**目标**:①租户 owner/admin/member/viewer 四角色可安全使用控制台(导航/操作按角色裁剪,operator 专属面隐藏);②租户自助闭环:邀请成员→接受→按角色使用;③新增租户概览(Dashboard)与计划/用量(Plan & Usage)两个客户视角页;④多租户成员可切换活动租户;⑤live 切到 DB authz 真源。

**非目标**:Stripe 支付/账单 UI(计费独立轨,todos「计费/支付集成」;本 ADR 只做只读计划/配额展示);Slack/Teams/Jira 集成;定时 Reports(推迟,见 §6);自定义角色/per-resource 权限(现四角色够用);operator 控制台独立应用(见 D4);SAML(todos §39.3)。

## 4. 核心决策

### D1 受众三层,同一 SPA 按身份裁剪

| 受众 | 判定 | 可见面 |
|---|---|---|
| 平台运维(operator) | `PLATFORM_OPERATOR_SUBS` 白名单(与租户角色正交) | 全部 + `/global-learnings`、`/runners`(运维视图) |
| 租户 owner/admin | memberships role | 租户全部页 + 写操作(config/members/byok/凭据/采纳/policy) |
| 租户 member/viewer | memberships role | 只读页(reviews/findings/coverage/conversations/learnings 列表)+ member 可触发操作;**usage/audit 收紧到 admin+**(见 D5) |

**导航单一来源 `nav.ts` 增加 `requires` 声明**(role 门槛 / operator 标记),Sidebar 按当前身份过滤;页面内写按钮同样按角色隐藏。前端需要知道自己的身份:新增 `GET /v1/me`(返回 role/tenantId/isOperator/memberships 列表),避免前端解析 JWT 猜测。

### D2 前置依赖:live 切 DB authz + 租户切换

- **`AUTHZ_SOURCE=db` 是租户面的硬前提**(todos「live 切换(P1 收尾)」):userId(user 级凭据)、邀请接受落 memberships、多租户解析都依赖它。claims 模式保留为降级/单租户兼容,但租户面功能(members UI、我的 key)在 claims 模式显式禁用并提示。
- **租户切换**:`/v1/me` 返回 memberships;>1 个 active membership 时侧栏显示租户切换器,选中后所有 `authFetch` 附 `X-Tenant-Id`(后端 `auth-db.ts` 已支持,零改动);单租户用户不显示。选择持久化 localStorage。

### D3 功能选择(对照 §2,面向租户新增/调整)

**新增两页**:
1. **`/`(Dashboard,登录后首屏)**:租户 KPI 概览——本周期 review 数/inline 评论数、finding 按严重度分布、活跃仓库数、token/费用消耗 vs 配额余量、覆盖率均值;数据全部来自现有 read-model(reviews/usage/coverage/findings)聚合,新增一个 `GET /v1/dashboard` 聚合端点(`review:read`)。**不做** reviewer-time-saved 类 ROI 建模(无可信模型,先放趋势和计数)。
2. **`/team`(Team & Plan)**:上半 members/invites 管理(list/invite/change-role/remove,`member:manage`,复用现有端点);下半当前计划(plan 名/席位/周期)、`periodUsage` 配额消耗(token/review 次数,含 BYOK 豁免口径)、超额 degrade 策略展示(`resolvePlan`/`checkQuota` 已有,新增只读 `GET /v1/subscription` 端点)。Stripe 接入后此页挂升级/账单入口。

**调整现有页**:
- `/global-learnings` → operator-only(nav 隐藏 + 路由守卫);租户侧的采纳收件箱留在 `/learnings`。
- `/runners` → operator-only;租户如需可观测,后续在 Dashboard 放「排队中 job 数」单指标即可。
- `/learnings` 补 CodeRabbit 式 KPI 卡(total/active/近 30 天用过/未用过)——检索命中已有 audit/ledger 数据可算,缺则先 total/active 两卡。
- `/plugins` 保持(凭据/开关已齐);BYOK 已移到 `/ai`(组织/仓库/「只我自己」三级,`ByokCard`);user 级在 claims 模式隐藏(D2)。

### D4 不拆 operator 独立应用

operator 面(global-learnings/runners,未来 tenant 管理)与租户面**同一 SPA**:operator 是白名单少数人,拆应用=双份 auth/nav/构建/部署,不值;安全边界本就在端点(`requirePlatformOperator`),UI 只是裁剪。若未来 operator 功能膨胀(跨租户检索/计费对账),再拆不迟。

### D5 安全边界与收紧项

UI 裁剪**不是**安全边界,端点权限才是。随本 ADR 落地的收紧:
- `/v1/usage` 从 `review:read` 收紧到 admin+(成本属经营数据;或引入 `billing:read` 权限给 viewer 之外的更细分级)。
- runners read-model:租户上下文调用时不返回 `tenant_id IS NULL` 共享池行的宿主机维度元数据(只留租户自己的 job 计数);operator 调用返回全量。
- `/v1/admin/status` 等 admin 端点复核一遍受众(`installation:manage` vs operator)。
- 邀请接受端点(`/v1/invites/:token/accept`)已公开+email 匹配,保持;invite token 一次性/过期语义复核。

## 5. 分期(实现另开,todos 登记)

- [~] **P0 前置**:`GET /v1/me` 已落;剩 live seed membership + `AUTHZ_SOURCE=db`(部署侧,todos 既有项)。
- [x] **P1 裁剪与守卫**:nav `requires` + Sidebar/路由按身份过滤;global-learnings/runners 收为 operator-only;D5 收紧项。
- [x] **P2 Team & Plan**:members/invites UI + `GET /v1/subscription` 只读计划/配额;i18n en/zh。
- [x] **P3 Dashboard**:`GET /v1/dashboard` 聚合 + 首屏 KPI 页;`/learnings` KPI 卡。
- [x] **P4 多租户切换**:`/v1/me` memberships + 切换器 + `X-Tenant-Id` 透传。
- [ ] **P5(后续/独立轨)**:Stripe 账单入口挂 `/team`;Reports;Integrations。

## 6. 推迟与风险

- **Reports(定时报表)**:CodeRabbit 用自然语言 prompt 定制+多渠道投递,依赖外呼渠道(email/Slack)与 LLM 汇总成本;security-scan 已有 email 通知地基(§35),待生产 SMTP 后另议。
- **KPI 口径风险**:接受率/时间节省类指标需要评论互动回流(reaction/resolve 事件),当前 webhook 未采集,Dashboard 首版只放确定性计数,避免造假指标。
- **claims 模式长尾**:两种 authz 模式并存期间,前端按 `/v1/me` 能力开关功能;DB 模式稳定后 claims 降级路径标 TODO 清退。
- **多租户切换的缓存**:切换后需失效前端全部数据缓存(SPA 内存态),实现时注意。
