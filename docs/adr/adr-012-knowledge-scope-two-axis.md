# ADR-012 知识库 Scope 两轴扩展(broadness × locality)

- 状态:accepted(设计 2026-07-17,P1–P5 + 清理落地 2026-07-18;分期见文末 §12,全 [x])
- 关联:ADR-010

>
> **2026-07-18 后演进(本文与代码的已知偏离,以代码为准)**:
> 1. §4.2/§9「global 不接受自动提案」已松动:migration 0026 + `global-learning-propose.ts` 引入多模型自动提议(origin=auto,triage→draft→panel→**operator 审批**)。信任锚移到「聚合工具只返 claim+计数不返原文」+ 人工审批;隔离从纯结构保证降为结构+流程保证。
> 2. §7 规则 2「auto-propose 禁 org」已松动:`learning-propose.ts`(review-outcome 租户级链路)可起草 **repository 或 organization** 广度(agent 据跨仓聚合判定),org 由租户 admin 批、永不 auto-approve。
> 3. §8「subject_ref 存 provider_user_id」未落实:实现用了 `provider:login`(改名失效/回收错配风险)。**TODO 待修**,见 todos「subject_ref 换稳定 id」。
> 4. §7 的触发已裂化为三条独立链路(P5 反馈 / review-outcome 租户级 / global 系统),各自 triage/draft/去重/配额实现,收敛见 todos「三条自动提案链路公共骨架」(2026-07-18 已收敛至 propose-common)。
> 5. §5「global 对全租户自动生效」将改为**租户采纳制**(default 广度 opt-in,mandatory 豁免;来源溯源 operator-only),存量 grandfather 为 accepted。
> 6. §6 审批授权已简化(2026-10-05):租户内任何广度(repository / organization / user)及全局规则的租户采纳/策略,都由**本租户 admin+**(`learning:approve`)决定;`learning:approve:org` 已删除。只有 global 广度仍归 platform-operator。

## 1. 背景与现状

现有 Learning 只有**仓库级**(`packages/knowledge`,migration 0011):

- `learning_proposals(tenant_id, repository_id NOT NULL, scope ∈ {repository|path|symbol}, selector, instruction, …, status, approved_by, version)`。
- 检索 `loadApprovedKnowledge(db, tenantId, repositoryId)` → 只取 `repositoryId` 匹配且 `isLearningActive` 的项 → `orderKnowledgeForPaths`(selector 命中任一变更文件即纳入)→ review-runtime `env.ts` 注入 `knowledgeContext`。
- 状态机 `transitionLearning`:proposed→approved/rejected,approved→revoked/expired;**仅 Repo Admin**(`learning:approve`,role admin+)可审批。
- 租户模型:`tenants`(=组织单元,无独立 org 表)/`users`(仅 email,**无 provider 身份**)/`memberships(tenant_id,user_id,role)`;RBAC role owner/admin/member/viewer。
- RLS(0018):`tenant_isolation` permissive-when-unset(`app.tenant_id` GUC 未设→放行;设了→`tenant_id = GUC`)。

**问题**:`scope` 把两个正交概念混为一谈——

1. **广度/归属**(适用于谁、谁审批):仓库。
2. **代码局部性**(适用于代码哪里):`path`/`symbol` 选择器。

扩展 user/org/global 必须先**拆开这两轴**,否则会继续叠加畸形枚举。

## 2. 目标 / 非目标

**目标**:①广度轴扩到 `global | organization | repository | user`;②与代码局部性轴(`none|path|symbol`)正交;③按广度的差异化审批授权;④agent 自动提案(默认待审、置信度+采样、抗注入);⑤跨租户 global 结构性隔离(不泄露租户私有惯例)。

**非目标**:语义去重/冲突自动裁决(需 LLM judge,另议);符号级 AST 精定位(现 path glob,§31.5 既有推迟项);实时 web 检索(与「联网证据检索」分离)。

## 3. 核心决策:两轴分离

| 轴 | 取值 | 含义 |
|---|---|---|
| **broadness(广度)** | `global` / `organization` / `repository` / `user` | 适用范围 + 审批授权 + 存储位置 |
| **locality(局部性)** | `none` / `path` / `symbol` | 代码内适用位置(selector 承载 glob/符号)|

- 旧 `scope='repository'` → `broadness=repository, locality=none`;`'path'`→`repository,path`;`'symbol'`→`repository,symbol`(迁移回填)。
- `user` 广度:知识挂在**提交者/评审者的 provider 身份**上,跨其 PR 生效,与 path 局部性正交(可「当作者=X 且改 `api/**` 时…」)。
- `enforcement ∈ {default, mandatory}`:`mandatory`(平台/组织策略,不被更具体项覆盖)vs `default`(更具体项可覆盖)。

## 4. 数据模型

### 4.1 租户内(org/repo/user)—— 改造 `learning_proposals`

新 migration `00XX_knowledge_scope.sql`:

```sql
alter table learning_proposals
  add column broadness   text not null default 'repository',  -- organization|repository|user(global 见 4.2)
  add column locality     text not null default 'none',        -- none|path|symbol
  add column subject_ref  text,                                 -- user 广度:provider 身份(见 §8),否则 null
  add column enforcement  text not null default 'default';      -- default|mandatory

-- 回填旧 scope → 两轴
update learning_proposals set broadness='repository',
  locality = case scope when 'path' then 'path' when 'symbol' then 'symbol' else 'none' end;

-- org/user 广度无单仓:放宽 repository_id 可空 + CHECK 保证一致性
alter table learning_proposals alter column repository_id drop not null;
alter table learning_proposals
  add constraint learning_scope_consistency check (
    (broadness = 'repository' and repository_id is not null) or
    (broadness = 'organization' and repository_id is null) or
    (broadness = 'user' and repository_id is null and subject_ref is not null)
  );

-- TODO(迁移残留):代码全切两轴后删除旧 `scope` 列。暂保留供回滚/双读。
create index learning_broadness_idx on learning_proposals (tenant_id, broadness, status);
```

`tenant_id` 保持 NOT NULL(org/user 仍属某租户)。RLS 不变(tenant_isolation 照旧覆盖 org/user 行)。

### 4.2 跨租户 global —— **独立表**(结构性隔离)

**不**在 `learning_proposals` 放 global(避免 nullable tenant_id + RLS 例外 + 自动提案误入)。新表:

```sql
create table global_learnings (           -- 平台策展,无 tenant_id,无 RLS
  id uuid primary key,
  instruction text not null,
  rationale text not null,
  locality text not null default 'none',   -- none|path|symbol
  selector text,
  enforcement text not null default 'default',
  status text not null default 'active',    -- active|revoked
  curated_by text not null,                 -- 平台运营者 ref(非租户 actor)
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

隔离由**结构**保证:global 只经**平台运营面**(独立 API/CLI,非 `/v1/learnings`)人工策展,**不接受租户数据/自动提案**,内容必须通用(无 repo/租户标识)→ 租户 A 惯例无从进入 global。读:所有租户可读(见 §5)。

## 5. 检索与优先级

`loadApprovedKnowledge` 扩展为按 review 上下文取**四广度并集**:

```
loadApplicableKnowledge(db, { tenantId, repositoryId, participants }) →
  union(
    global_learnings   where status='active',
    learning_proposals where tenant_id=T and broadness='organization' and active,
    learning_proposals where tenant_id=T and broadness='repository' and repository_id=R and active,
    learning_proposals where tenant_id=T and broadness='user' and subject_ref in participants and active,
  ) → RetrievalItem[]（category='approved-learning'，带 specificity + enforcement）
```

- `participants` = 本次 PR 的作者 + 评审者的 provider 身份(review 上下文注入,见 §8)。
- **specificity(越大越具体、优先级越高)**:`global(0) < organization(1) < repository(2) < user(3)`,同广度再 `none(0)<path(1)<symbol(2)`。
- `orderKnowledgeForPaths` 增 specificity 次序:先按 category(authoritative-rule > approved-learning > …,不变),category 内按 specificity **降序**(最具体在前 = 高优先);selector 仍按变更文件过滤,user 广度按 participants 过滤。
- **enforcement**:`mandatory` 项恒置于其 category 顶部且**不被更具体项覆盖**(注入文案标「MUST」);`default` 项可被更具体的 default 覆盖(交给 agent「后者更具体、优先」的自然语言约定,不做语义裁决)。
- 过期/撤销/不适用(selector 不命中、participant 不命中)一律剔除(复用 `orderKnowledge` 过滤)。

RLS 补充:`global_learnings` 无 tenant 列、无 RLS(平台读写);租户读走应用层 union(control-api 以租户上下文查 learning_proposals + 无条件查 global_learnings active)。

## 6. 审批授权(按广度差异化)

| 广度 | 提议 | 审批 | 说明 |
|---|---|---|---|
| repository / path / symbol | `learning:propose`(member+)| `learning:approve`(admin+)| 现状不变 |
| organization | admin+(`learning:propose:org`)| admin+(`learning:approve`)| 本租户 admin 审批 |
| user | admin+ | admin+(`learning:approve`)| 敏感(关于个人),注明**隐私**(建议当事人可见/可撤;仅存"评审惯例"非画像)|
| global | —(不经租户 API)| **platform-operator**(租户 RBAC 之外的超级管理员)| 独立运营面,人工策展 |

新增 Permission:`learning:propose:org`。`platform-operator` 是**新的平台级角色**(不在 tenant `memberships`,由平台运营账户/单独 authz 承载),仅作用于 `global_learnings` 与 org 级跨租户运维。状态机 `transitionLearning` 增广度感知:租户内广度校验租户 admin;global 走独立表的独立函数。

## 7. 自动提案门控(agent auto-propose)

触发:review outcome / 会话反馈(§31.4)→ `maybeAutoProposeLearning(candidate)`。硬规则:

1. **只落 `proposed`,永不 auto-approved**(人是安全边界)。
2. **广度只允许 repository/path/symbol**;**禁 org/user/global**(广度越大越需人工 + 更高授权 + 隔离)。
3. **置信度门控**:agent 输出 `confidence`,`< knowledge.auto_propose.min_confidence`(config,默认 0.8)丢弃。
4. **采样/去噪**:每仓每日提案上限(config,默认 5);**去重**——归一化 instruction 与现有 `proposed`+`approved` 近重复则跳过(避免刷屏)。
5. **抗注入(与「防盗」合流)**:instruction/rationale 源自 PR/评论 = **不可信输入**:
   - 入库前过 `detectInjectionAttempt`,超长截断;
   - 标 `proposed_by='agent'` + **`untrusted_origin=true`**(审批 UI 显来源,提示人工核**内容本身也是待注入的 prompt**);
   - 批准后注入 review 上下文时,knowledge 作**数据/指令**明确包裹,**绝不授予工具/外发能力**。

配置(`.winnowl.yaml` `knowledge.auto_propose`):`enabled`(默认 false)、`min_confidence`、`daily_cap`、`levels`(白名单,默认 `[repository,path,symbol]`)。

## 8. user scope 身份(**不依赖用户/计费系统**)

**核心澄清**:user 广度的 **review 侧行为不需要平台 `users` 表或用户/计费系统**——只需 PR 参与者的 **provider 身份**,而 webhook 的 change-request 事件**已带** author/reviewer 的 provider id + login。

- `subject_ref` 直接存 `provider:provider_user_id`(稳定 id,不用 login——会改名)。
- review 上下文:payload 注入 PR 作者 + 评审者的 `provider:provider_user_id` 列表 = §5 的 `participants`;检索按此匹配。
- **提议/审批**:owner 手工提+批(§6),内容里指明目标 provider 身份即可,不需要该人是平台注册用户。

**可选增强(与「用户/计费」合流,非前置)**——仅当要"控制台侧按平台用户管理 user-scope / 当事人 consent 可撤 / 按人计费"时才引入映射表:

```sql
create table user_identities (             -- 平台 user ↔ provider 身份;user-scope 检索**不依赖**它
  id uuid primary key,
  user_id uuid references users(id) on delete cascade,   -- 可空:未认领的 provider 身份
  tenant_id uuid not null references tenants(id) on delete cascade,
  provider text not null,            -- github|gitlab|forgejo
  provider_user_id text not null,    -- 稳定数字 id
  login text,
  unique (tenant_id, provider, provider_user_id)
);
```

即:**用户/计费系统是独立轨,不 block 本设计**;第 4 期先 key 在 webhook 的 provider 身份上即可跑通,映射表/consent/计费推后。

## 9. 跨租户 global 隔离与合规(结论)

- global 只经**平台运营面人工策展**(独立表 + 独立 authz),**拒绝自动提案与任何租户数据来源**(§4.2 结构保证)。
- 内容审查:平台运营者对通用规则负责;禁止把任何租户的 repo/路径/标识写入 global。
- 可选 `mandatory` 平台策略(安全/合规基线)对所有租户强制、不可被租户覆盖。

## 10. 接线点

- `packages/knowledge`:`types.ts`(两轴 + enforcement + subject_ref)、`store.ts`(`loadApplicableKnowledge` union + `global_learnings` CRUD)、`learning.ts`(广度感知状态机)、`retrieval.ts`(specificity 次序 + mandatory 置顶)、新 `auto-propose.ts`(门控 + 抗注入)。
- `migrations`:`00XX_knowledge_scope.sql`(两轴回填 + 放宽约束)、`00YY_global_learnings.sql`、`00ZZ_user_identities.sql`。
- `apps/control-api`:`/v1/learnings` 增广度参数 + 提审授权分级;新 `/v1/platform/global-learnings`(platform-operator 门控);`rbac` 加新 Permission/role。
- `packages/review-runtime` `env.ts`:`loadApprovedKnowledge` → `loadApplicableKnowledge`(传 participants);payload 增 participants。
- `apps/runner-supervisor`:review outcome/会话反馈 handler 接 `maybeAutoProposeLearning`。
- `apps/web-console`:Learning proposals 页显广度/来源/`untrusted_origin`;org/global 审批入口按角色。

## 11. 迁移与向后兼容

- 两轴回填后旧 `scope` 列**保留双读**,代码全切后删除——**标 TODO(迁移残留待删)**。
- `loadApprovedKnowledge` 保留为 `loadApplicableKnowledge` 的仓库级特例(过渡),调用点迁移后收敛。
- 现有 repo 级 proposals 语义不变(broadness=repository)。

## 12. 分期实施

1. **[x] 两轴拆分**:migration 0022(broadness/locality/subject_ref/enforcement + 回填 + 放宽约束);types/store(双写 legacy scope)/retrieval(specificity)双轴;零行为变化(回归全过)。
2. **[x] organization 广度**:`loadApplicableKnowledge`(union org+repo,specificity)+ `transitionLearning` owner 门控 + rbac `learning:{propose,approve}:org` + learnings route broadness + env.ts 注入切换 + web 展示。集成测试覆盖。
3. **[x] global 广度**:migration 0023(`global_learnings` 独立表)+ `global-store.ts`(CRUD + 复用 `transitionLearning` 状态机)+ control-api `platform-operator.ts`(env `PLATFORM_OPERATOR_SUBS` 白名单)+ `routes/global-learnings.ts` + `loadApplicableKnowledge` union global(specificity 最低)+ mandatory 置顶。集成测试覆盖。
4. **[x] user 广度**:`subject_ref=provider:login`(复用 P1 已建列)+ `loadApplicableKnowledge` participants 并集 + env.ts 装配 PR author(`provider:author`)+ learnings route `broadness=user`(subjectRef 必填,admin 提/批)。集成测试覆盖。**本期仅 author**;reviewers 待 webhook 捕获(见 todos)。
5. **[x] auto-propose**:migration 0024(`feedbacks` 表)+ `feedback.ts`(`insertFeedback`/`loadFeedbackFor`/`maybeAutoProposeLearning`)+ 结构化反馈命令(conversation `feedback` intent)+ handlers 捕获/触发 + config `learnings.auto_propose*`(默认 off)。抗注入三重:结构化命令、instruction 源自 bot finding、`detectInjectionAttempt` 兜底 + **永不自动批准**。集成测试覆盖。
6. **[x] 清理**:migration 0025 drop 旧 `learning_proposals.scope` 列;store/types 去双写;API 保留 legacy scope 入参翻译(`localityFromScope`);读模型/前端切 broadness/locality。

## 13. 测试

- retrieval:四广度 union、specificity 次序、mandatory 置顶、selector/participant 过滤、过期剔除。
- 状态机:org/user 广度的 owner 门控;global 独立面 authz。
- auto-propose:置信度阈值、日上限、去重、**注入内容被 sanitize/detect 拦截**(与防盗单测合流)。
- 隔离:租户 A 无法读/写租户 B 的 org/user learnings;global 只读;平台面外无法写 global。
- 迁移:旧三值 scope 正确回填两轴;repo 级语义不变。

## 14. 风险 / 权衡

- **越广越危**:org/global 一条坏 learning 影响面大 → 更高授权 + mandatory 谨慎 + auto-propose 禁入。
- **注入污染共享知识**:auto-propose 内容不可信 → sanitize + 人工审批 + 来源标注;根本上人是边界。
- **user 广度隐私**:仅存"评审惯例"非个人画像;owner 审批 + 当事人可撤;避免跨租户。
- **specificity ≠ 语义冲突裁决**:仍靠 agent 理解"更具体优先";真冲突检测留给可选 LLM judge。
- **global 中心化信任**:平台运营者成为跨租户信任锚 → 独立表 + 人工策展 + 审计,不接受自动来源。
