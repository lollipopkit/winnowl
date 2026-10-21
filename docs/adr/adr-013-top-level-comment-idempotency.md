# ADR-013 顶层评论的幂等/滚动更新(修复 CI 根因分析重复发帖)

- 状态:accepted(2026-07-19 已实现)
- 关联:ADR-008;live 缺陷 flutter_server_box#1234(2026-07-19)

## 背景

flutter_server_box#1234 上,winnowl 对同一 PR **重复发帖**「CI failure root-cause analysis」:两条相隔 8 小时、根因完全相同(`target/debug/libsbm_ffi.so` 在 `setUpAll` 缺失),仅 check-run id 不同(88112927769 vs 88157066047)。PR 有 84 commits、持续推送,若不修会随每次推送/CI 重跑无限堆叠。

根因(代码级,已定位):

1. **`createTopLevelComment`(provider-github/src/provider.ts:306)收了 `IdempotencyContext` 参数但完全无视**(`_idempotency`,下划线未用),每次无条件 `POST issues/{n}/comments` 新建评论。
2. **顶层评论缺三样幂等基建**(对比其他发布路径):
   - inline 评论:埋 `publicationMarker` + 经 `listThreads` 对账(找到既有 marker 则不重发);
   - review summary:`upsertSummarySection` 用 `<!-- winnowl:summary:begin/end -->` 标记**原地替换** PR body 段;
   - **顶层评论:既不埋 marker、不对账、也不写 `publication_records`**——`pipeline-analyze.ts` 直接调 `createTopLevelComment` 就完事。
3. **触发放大**:job 级 dedupe 是 `pipeline:${CR}:${headSha}`,只挡「同 head 多 workflow 失败」,**不同 head(新 commit)各触发一次** → 各发一条。相同根因跨 head 重复,本应是一条滚动更新的评论。

`editComment` 能力已存在(provider.ts:388);缺的是「列出并按 marker 定位既有顶层评论」的能力——`listThreads` 只返回 **review 线程**(inline),不含 issue 顶层评论。

## 决策

顶层评论(CI 根因分析,及未来同类 bot 顶层评论)改为**按 (CR, kind) 单条滚动更新**,而非每次新建:

1. **通用顶层 marker**:引入 `<!-- winnowl:toplevel:kind=<kind>:cr=<crId> -->` 隐藏标记(kind 如 `ci-analysis`),嵌在评论体末尾。marker 只认 (CR, kind),**不含 headSha** —— 同一 PR 的 CI 分析始终是同一条,内容随 head 刷新(体内注明当前 head/失败的 check-run)。
2. **provider 能力补齐**:契约加 `listTopLevelComments(target)`(GitHub `GET issues/{n}/comments`;GitLab/Forgejo 对应端点)。`createTopLevelComment` 改为 **upsert 语义**:先 list→按 marker 找既有→有则 `editComment` 覆盖、无则 create;marker 由 `IdempotencyContext.key` 派生(不再忽略该参数)。
3. **落 `publication_records`**:顶层评论纳入统一发布记录(kind=`ci-analysis`,idempotency_key=`ci-analysis:${crId}`,**去掉 headSha**),与 inline/summary 一致,便于对账/审计/去重跨重启稳定。
4. **仅在根因变化时更新**:pipeline-analyze 落库上次根因指纹(诊断集/rootCause 摘要哈希);新 head 若根因与上次**等价**则**跳过 edit**(避免把「同样的 so 缺失」在每次推送刷成新时间戳噪音),仅当根因实质变化才更新那条评论。

不采:①每 head 一条(现状,堆叠);②纯 job dedupe 收紧到 (CR) 不含 head(会漏掉「新 head 引入的新 CI 问题」——根因确实变了就该更新)。滚动单条 + 根因指纹兼顾「不刷屏」与「新问题可见」。

## 结果

- 同一 PR 的 CI 根因分析**恒为一条**,随 head 刷新而非堆叠;根因未变的推送不产生噪音;
- `createTopLevelComment` 不再是「无幂等的裸 POST」——所有发布路径(inline/summary/top-level)统一 marker+对账+`publication_records`,§23.5 幂等语义补全;
- provider 契约多一个 `listTopLevelComments`,三家适配器实现(GitHub 先行,GitLab/Forgejo 随后);
- **已实现(2026-07-19)**:契约 `TopLevelComment` + `DiscussionApi.listTopLevelComments?`(GitHub 实现;GitLab/Forgejo 未实现→退化新建);publisher `topLevelMarker/hasTopLevelMarker` + `publishTopLevelComment`(记录优先 native_id 直 edit / 缺则 list 按 marker 找 / 再缺则新建;指纹未变跳过;4xx 落 response);pipeline-analyze 改用之 + `ciRootCauseFingerprint`(排除 check-run id 的稳定指纹)。测试:publisher upsert/skip/list-recovery 4 + pipeline-analyze 复现堆叠 bug 1。

## 影响面 / 迁移

- 已存在的重复评论(如 #1234 的 2 条)不自动清理——首次 upsert 会**新建一条带 marker 的**,旧的裸评论成陈留(可选:list 时把无 marker 的旧 bot CI 分析评论一并 edit 成指向新条或删除,低优先)。标 TODO(迁移残留)。
- `IdempotencyContext` 之前被顶层评论忽略,补用后需确保 key 稳定(现 `ci-analysis:${crId}:${headSha}` → 去 headSha 为 `ci-analysis:${crId}`)。
