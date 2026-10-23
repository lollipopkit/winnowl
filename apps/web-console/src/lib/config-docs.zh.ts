/**
 * Chinese translations of `.winnowl.yaml` option docs. The English `.describe()` in the Zod schema is the source;
 * missing keys fall back to English. A test keeps the keys in sync with generated/config-reference.json.
 */
export const CONFIG_DOCS_ZH: Record<string, string> = {
  version: '配置文件格式版本,固定为 1。',
  language: '评审输出使用的语言(`en`、`zh`)。填了不认识的值就回到英文。',

  'reviews.auto.enabled': '自动评审 PR。关掉它,手动的 `@winnowl review` 也一并停用。',
  'reviews.auto.drafts': '草稿 PR 也评审。',
  'reviews.auto.base_branches': '只评审目标分支在这几个分支里的 PR。条目是 glob(`release/*`;`**` 匹配任意分支)。留空 = 仓库在 forge 上设置的默认分支。',
  'reviews.auto.ignore_authors': '跳过这些账号开的 PR(通常用来排除其它机器人)。',
  'reviews.auto.ignore_bot_authors':
    '跳过机器人开的 PR,默认开。评审机器人产出的改动通常是在评审没人会去改的生成物,而花的钱和评审手写代码一样。关掉它可以评审依赖更新这类 PR。显式的 `@winnowl review` 不受影响;winnowl 自己开的 PR 无论如何都不会被自动评审 —— 那会循环。',
  'reviews.auto.required_labels': '填了之后,只评审带其中至少一个标签的 PR。',
  'reviews.auto.pause_after_reviewed_commits': '同一个 PR 上评审过这么多次提交后就不再重评。0 表示不限。',
  'reviews.auto.max_changed_files': '需要评审的文件数超过这个值就整个不自动评审;`ignored_paths` 排除的、生成或 vendored 的(`skip_generated`)以及删除的文件不计入。手动 `@winnowl review` 不受限。0 表示不限(大 PR 分轮评审,见 `reviews.files_per_round`)。',
  'reviews.reviewers': '从最近改过本 PR 所改文件的人里建议 reviewer。PR 作者、机器人、没有 write 权限的账号不会被建议。',
  'reviews.reviewers.mode': '`suggest` 只在状态评论里列出建议的 reviewer;`request` 另外在 PR 上请求他们,只请求一次,且仅当 PR 还没有任何 reviewer;`off` 两者都不做。',
  'reviews.reviewers.max': '建议或请求的 reviewer 人数上限。',
  'reviews.files_per_round':
    '一轮最多评审这么多个文件。更大的 PR 分轮评审:下一次 push、或状态评论里的复选框,会接着评还没评过的文件;全部评完之前不 approve。按 `ignored_paths` 与 `skip_generated` 过滤之后计数。0 表示一轮评完。',
  'reviews.profile': '每次评审投入多少,以及对低价值问题压制得多狠。',
  'reviews.scope.analyze_related_code': '连带阅读这次改动依赖的未改动代码,而不是只看 diff。',
  'reviews.scope.analyze_preexisting_relevant': '报告那些**因为这次改动**才变得可达或更严重的老问题。',
  'reviews.scope.report_preexisting_unrelated': '与这次改动无关的老问题怎么处理:收进摘要、开成 issue,或者不报。',
  'reviews.skip_generated':
    '不评审生成代码、vendored 依赖和二进制文件:base 分支 `.gitattributes` 标了 `linguist-generated` / `linguist-vendored` 的、lockfile、常见生成器产物(`*.g.dart`、`*.pb.go`、`generated/`、`vendor/`)以及文件头声明自己是生成的。跳过的文件会在 summary 里逐个列出。',
  'reviews.block_preexisting': '老问题也算阻断项。默认关:只有这次改动引入的问题会挡合并,老问题照常报告。在遗留代码上打开它,每个 PR 都会被历史欠账挡住。',
  'reviews.scope.auto_issue_preexisting': '无关老问题直接开 issue,不再问你。',
  'reviews.scope.max_dependency_depth': '顺着调用关系往外读几层。',

  'reviews.publication.max_inline_comments': '一次评审最多发多少条行内评论,超出的收进摘要。0 表示不发行内评论。留空则跟随评审档位。',
  'reviews.publication.max_inline_per_file': '单个文件上最多发多少条行内评论。留空为 3。',
  'reviews.publication.max_inline_nitpicks': '一次评审最多发多少条行内打磨建议。它和上面的名额各算各的,互不挤占;留空则跟随评审档位。',
  'reviews.publication.summary_overflow': '超出行内配额的问题列进摘要,而不是直接丢掉。',
  'reviews.publication.min_confirmation': '一条问题至少要有多硬的证据,才允许发成行内评论。',
  'reviews.publication.show_unverified_risks': '把没能确认、但影响很大的风险放进折叠区一并呈现。',
  'reviews.publication.show_suppressed_details': '列出被压制或去重掉的内容,用来核对是不是漏报。',
  'reviews.publication.committable_suggestions': '行内评论附带可一键提交的修改建议(仅当替换内容与当前代码逐字对得上时才附)。',
  'reviews.publication.committable_suggestion_max_lines': '单条建议最多替换多少行。更大的改动走 `@winnowl fix`。',
  'reviews.auto_approve': '没有阻断性问题时,直接 approve 这个 PR。',
  'reviews.dependency_gate': '这次**新引入**的依赖漏洞达到哪个严重度就阻断合并。老漏洞只报告、从不阻断。',
  'reviews.ignored_paths': '完全不参与评审的路径(glob)。写了这一项就是**整体替换**默认列表,而不是追加。',

  'instructions.paths': '按路径追加的评审要求。',
  'instructions.ast': '按代码结构匹配追加的评审要求。',

  'tools.auto_detect': '自动识别仓库的构建、检查与测试命令。',
  'tools.commands': '显式指定的命令,优先于自动识别的结果。',
  'tools.commands.setup': '装依赖的命令,在其它命令之前执行。',
  'tools.commands.build': '构建命令。',
  'tools.commands.lint': '静态检查命令。',
  'tools.commands.test': '测试命令。',
  'tools.enabled': '强制启用的分析器。',
  'tools.disabled': '强制关闭的分析器。',

  'sandbox.runner': 'review 在哪里运行:平台,或本仓库的 GitHub Actions(需要添加 winnowl workflow;运行不了时直接报错,不会改回平台)。',
  'sandbox.labels': '要求承接本仓库的执行机带哪些标签。',
  'sandbox.network.mode': '跑你代码的那个环境能不能上网。默认完全禁止。',
  'sandbox.network.ecosystems': 'mode 为 `package-registry-only` 时,允许访问哪些包管理源。',
  'sandbox.network.hosts': 'mode 为 `allowlist` 时允许访问的主机。',
  'sandbox.network.ports': 'mode 为 `allowlist` 时允许访问的端口。',
  'sandbox.resources': '跑命令的隔离环境的资源上限。',
  'sandbox.resources.cpu': 'CPU 核数。',
  'sandbox.resources.memory_mb': '内存(MB)。',
  'sandbox.resources.disk_mb': '磁盘(MB)。',
  'sandbox.resources.timeout_seconds': '单次运行的时间上限。',
  'sandbox.secrets': '允许命令读取的密钥**名字**。值存在控制台里,永远不写进这个文件。',

  'chat.enabled': '回应 PR 与 issue 下的评论。',
  'chat.require_mention': '只在评论 @ 了它的时候才回应。',
  'chat.allow_run_command': '`run <命令>` 在 sandbox 里对 PR head 执行一条 shell 命令(构建、检查、测试等)并回复输出。有 write 及以上权限的人可以使用;命令执行前会经过审查。',

  'actions.autofix.enabled': '允许 `@winnowl fix` 产出修复。',
  'actions.autofix.require_confirmation': '修复执行前需要人确认。设为 false 等于给这个仓库一次性授权。',
  'actions.autofix.delivery': '修复怎么交付:可下载的补丁,或另开一个 PR。两种都不会写你的分支。',
  'actions.create_issue.enabled': '允许它开 issue。',
  'actions.create_issue.require_confirmation': '开 issue 前需要人确认。',
  'actions.post_merge.enabled': 'PR 合并后继续做收尾工作。',

  'knowledge.repository_docs': '把仓库的 AGENTS.md / CLAUDE.md(根目录,以及改动涉及的目录里的)作为评审背景。从目标分支读取,PR 里对它们的修改要合并后才生效。',
  'knowledge.historical_prs': '把过往 PR 作为评审时的背景。',
  'knowledge.learnings.enabled': '把评审中做过的判断带进以后的评审。',
  'knowledge.learnings.require_repo_admin_approval': '没有 admin 或 maintain 权限的人在评论里提出的规则要批准后才生效。关闭后,评论里提出的仓库规则都直接生效(公开仓库上任何能评论的人都能影响之后的评审)。组织级规则和 bot 起草的规则始终要批准。',
  'knowledge.learnings.auto_propose': '同一类反馈重复出现后,自动起草规则提案。提案仍然需要人批。',
  'knowledge.learnings.auto_propose_threshold': '同类反馈重复多少次才起草提案。',
  'knowledge.learnings.auto_propose_from_review': '也从评审结果起草规则提案。会消耗额度。',
  'knowledge.memory.enabled': '记住关于这个仓库的工作笔记,来自评审和发给 bot 的评论。笔记是参考,不是规则。会消耗额度。',
  'knowledge.memory.require_approval': '没有 admin 或 maintain 权限的人的评论里起草的笔记要在 inbox 批准后才生效。关闭后直接生效。',
  'knowledge.related_repositories': '本仓库依赖其契约的那些仓库。',

  'plugins.exa.enabled': '允许用网页检索作为评审证据。',
  'plugins.context7.enabled': '允许查阅官方库文档作为评审证据。',
  'plugins.registry.enabled': '允许查询包管理源的版本与元信息作为评审证据。',

  'merge_gate.enabled': '有阻断性问题时让 review 的 check run 也判失败,便于用分支保护拦住合并。review 本身无论开关与否,有阻断性问题都会 request changes。',
  'merge_gate.block_on_severity': '合并前必须修改的严重度(显示为 Critical、Major、Minor)。本次改动造成的、已确认的问题达到其中之一,review 就 request changes。Low(Trivial)属于 nitpick,从不阻断。',
  'merge_gate.minimum_confirmation': '一条问题至少要有多硬的证据,才允许它阻断合并。',
  'merge_gate.require_review_complete': '评审还在跑、或没跑完时也阻断。',

  'privacy.artifact_retention_days': '产物(补丁、日志)保留多少天。0 表示立即删除。',
  'privacy.transcript_retention_days': '评审过程记录保留多少天。0 表示立即删除。',
  'privacy.allow_external_model_provider': '允许评审使用外部模型服务。关掉则只用自托管的。',

  'cross_repo.analyze.enabled': '本仓库的契约变更时,分析对下游仓库的影响并在那边开 issue。会消耗额度。',
};
