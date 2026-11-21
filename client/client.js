/**
 * godot-bridge — browser half (DSH web client).
 *
 * Three surfaces:
 *   - the task center panel (`main` slot `task-center` + a sidebar glyph): the
 *     board/queue/roles/status/detail views, the T-205 settings page and the
 *     decision modal that fronts the Host's pending questions;
 *   - the conversation-page decision entry (`shell.overlay`, T-208): the same
 *     answer form as a compact docked card, so a pending decision can be
 *     answered without opening the panel;
 *   - the plugin bundle configuration card (`plugins.bundle.config`, keyed by
 *     the package name): T-205 mounts the SAME settings page there, so the two
 *     entry points cannot drift. The card only supplies the shared task store,
 *     the engine path's config scope and the browser theme.
 *
 * The host half declares `godotPath` as a `.volatile()` config field of its
 * `tool-godot-bridge` row, so DSH 0.2 projects it into the settings document;
 * the page's engine-path section writes that scope through
 * `ctx.configForms.get(<row id>)`.
 *
 * The card slot hands the page a `view` only — unlike `plugins.row.config`
 * it passes no `form` — so this bundle resolves the config scope itself. A
 * save ends in `ctx.configEditor.edit(...)`, i.e. the profile
 * `cordis.patch.yml` layer the `godot_set_engine_path` tool writes, so the
 * tool and the GUI agree and the new path applies without a restart.
 *
 * T-205: that config card no longer ships a lone engine-path field. Both it and
 * the task center's settings entry mount the SAME settings page (view module
 * settings-page.cjs): title + left theme rail + scrolling right column + a
 * save/cancel footer, with the engine-path section writing the config scope
 * above and the project themes writing the current task-center project.
 *
 * Version boundary: DSH 0.1.6–0.1.x declares these slots but has no
 * settings-form service, so the registration sits behind
 * `ctx.inject(['configForms'], ...)`: those runtimes keep their current
 * behaviour (no configuration card) instead of rendering a page whose engine
 * path could not save.
 *
 * Conventions this file must keep (dsh-client-modules):
 *   - loaded as a classic script through window.__ModuleLoader__.load();
 *   - `id` equals the package name, and the module table seeds React;
 *   - only platform-seed specifiers are required (react, react-dom, ...);
 *     anything else would have to be declared in `dsh.client.external`, and
 *     DSH's own authoring rules ask plugins not to load Harness client
 *     packages at all — the controls below are ours, styled with the host's
 *     `--dsw-alias-*` tokens.
 */
window.__ModuleLoader__.load({
	id: 'godot-bridge',
	factory(require) {
		const React = require('react')
		const h = React.createElement

		/** Settings namespace of the row this bundle inserts: the row id itself. */
		const ENTRY_NS = 'tool-godot-bridge'

		/* ==================================================================
		 * TASK CENTER
		 *
		 * The panel is a view over the Host's action API. It owns no rules: the
		 * board, the dependency graph, dispatch and locks all live on the Host
		 * (plugin/task-center). The store below only fetches state, sends one
		 * action and renders the snapshot the Host returns.
		 * ================================================================== */

		const TC_NS = 'godotBridgeTaskCenter'
		const TC_STATE_URL = '/godot-bridge/task-center/state'
const TC_WORKTREES_URL = '/godot-bridge/task-center/worktrees'
		const TC_TASK_URL = '/godot-bridge/task-center/task'
		const TC_LIST_URL = '/godot-bridge/task-center/list'
		const TC_ACTION_URL = '/godot-bridge/task-center/action'
		const TC_PROJECT_KEY = 'godotBridge.taskCenter.project'
		// T-96: the panel must tell the Host WHICH session it belongs to, otherwise
		// every window shares one process-global project slot.
		const TC_SESSION_KEY = 'godotBridge.taskCenter.session'
		// T-95: values written before T-90 were the panel auto-recording whatever
		// the Host answered, not a user choice. Explicit pins carry this prefix, so
		// an unmarked legacy value is migrated (cleared) instead of being honoured.
		const TC_PROJECT_PREFIX = 'v2:'
		const TC_PROJECT_MIGRATED_KEY = 'godotBridge.taskCenter.projectMigrated'

		const TC_DICT = {
			zh: {
				nav: 'GodotBridge 任务中心',
				title: '任务中心',
				boardTab: '看板',
				taskTitle: '标题',
				subtitle: '依赖驱动的派发 · 文件锁保护 · 跨会话共享',
				project: '项目',
				projectUnknown: '尚未选择项目',
				projectResolving: '正在解析当前会话的项目…',
				projectSourceSession: '会话',
				projectSourceManual: '手动',
				projectSourceRegistry: '注册表',
				projectSourceHint: '这个项目路径是从哪里来的',
				projectMismatch: '面板：{panel} · 当前会话：{session}',
				projectNotReady: '当前会话项目无法作为任务中心打开：需要 Git 工作树 · {project}',
			ownerMismatch: '卡片的所属会话 {owner} 与派发目标会话 {target} 不一致',
				projectSwitch: '切换到会话项目',
				useCurrentProject: '使用当前项目',
				useCurrentProjectHint: '填入服务端当前解析的项目路径',
				start: '开始派发',
				pause: '暂停派发',
				running: '派发中',
				paused: '已暂停',
				refresh: '刷新',
				newTask: '新建任务',
				settings: '设置',
				close: '关闭',
				save: '保存',
				cancel: '取消',
				create: '创建',
				update: '保存修改',
				edit: '编辑',
				delete: '删除',
				forceDelete: '强制删除',
				block: '阻塞',
				unblock: '解除阻塞',
				retry: '重试',
				reopen: '重新打开',
				submit: '提交完成',
				submitEvidence: '提交证据',
				note: '备注',
				spec: '说明',
				acceptance: '验收标准',
				evidence: '证据',
				dependencies: '依赖',
				none: '无',
				files: '文件',
				noFiles: '未声明文件',
				noDeps: '无依赖',
				release: '释放',
				status: '状态',
				priority: '优先级',
				assignee: '执行者',
				attempts: '尝试',
				created: '创建',
				history: '历史',
				dispatch: '派发记录',
				dispatchError: '派发错误',
				queue: '队列',
				queueHint: '派发从这个顺序取任务；完成后自动补位。',
				waiting: '等待',
				ready: '就绪',
				runningCol: '实现中',
				reviewingCol: '评审中',
				testingCol: '测试中',
				doneCol: '完成',
				archiveLine: '已归档 {n} 张·{range}',
				archiveTitle: '已归档任务',
				archiveOpen: '查看归档',
				// T-132: investigation cards (kind: investigate) on the board/detail.
				kindLabel: '类型',
				kindDev: '开发',
				kindInvestigate: '调查',
				kindFilterAll: '全部',
				kindFilterHint: '按类型过滤看板',
				kindInvestigateHint: '调查卡：交付报告，不评审/测试/合并',
				investigatingCount: '调查中 {n}',
				investigatePending: '待调查',
				statusInvestigating: '调查中',
				stageRun: '执行',
				stageDeliver: '交付',
				reportTitle: '调查报告',
				reportDelivered: '已交付',
				reportMissing: '报告未交付',
				reportSummary: '摘要',
				reportBody: '正文',
				reportEvidence: '证据',
				reportArtifacts: '产物',
				reportCommand: '命令',
				reportExit: '退出码',
				reportTail: '输出尾部',
				reportProbeCommits: '警告：scratch 里有提交（已丢弃）',
				reportFullHint: '完整报告：.agents/reports/{id}.md',
				casebookTitle: '案卷',
				casebookIndex: '案件索引',
				casebookStatus: '状态',
				casebookKind: '类型',
				casebookProject: '项目',
				casebookExecutor: '执行者',
				casebookBase: '基线',
				casebookTarget: '目标',
				casebookElapsed: '用时',
				casebookDelivered: '交付时间',
				casebookTimeline: '时间线',
				casebookReportFile: '报告文件',
				reportInvestigateHint: '调查卡由执行者用 report 交付；不会进入评审/测试/合并。',
			statusBoardSize: '板子 {mb} MB / {limit} MB 上限（{percent}%）· 按当前体积约还能建 {n} 张卡',
				archiveEmpty: '没有匹配的已归档任务',
				viewAllDone: '查看全部',
				doneAllTitle: '已完成任务',
				doneAllSearch: '按标题或编号搜索',
				doneAllToday: '今天',
				doneAllYesterday: '昨天',
				doneAllEarlier: '更早',
				doneAllLoadMore: '加载更多',
				doneAllEmpty: '没有匹配的已完成任务',
				doneAllLoading: '正在加载…',
				doneAllError: '加载失败',
				doneAllRetry: '重试',
				doneAllCount: '共 {n} 张',
				doneAllLoaded: '已加载 {n} 张',
				collapseColumn: '收起',
				expandColumn: '展开',
				blockedCol: '阻塞',
				cancelledCol: '已取消',
				emptyBoard: '还没有任务。点“新建任务”开始。',
				emptyQueue: '没有可派发的任务。',
				emptyHistory: '没有历史记录。',
				agentsTab: '代理',
				agentsTitle: '代理',
				agentsHint: '当前会话的根代理与它启动的活动子代理；每个任务由对应阶段的代理执行，阶段结束后释放。',
				agentsProject: '面板项目',
				agentsRoot: '根代理',
				agentsLive: '活动子代理',
				agentsUnavailable: '宿主没有提供代理树信息。',
				agentsNoRoot: '宿主没有报告根代理，无法显示执行树。',
				agentsNoChildren: '根代理还没有活动的子代理。',
				agentsPillRoot: '代理 · {n}',
				agentsPillNone: '代理 · 未报告',
				agentsPopoverTitle: '执行树',
				agentsRootLine: '根代理：{name}',
				agentsLiveLine: '活动子代理：{n}',
				agentRootRole: '根代理',
				agentRole: '角色',
				agentName: '代理',
				agentStatus: '状态',
				agentTask: '任务',
				agentStatusRunning: '运行中',
				agentStatusIdle: '空闲',
				agentStatusFailed: '失败',
				agentStatusUnknown: '状态未知',
				unknownProjectHint: '这个会话还没有绑定项目。请在会话里调用一次 task_center，或在下方手动打开一个项目。',
				notActivatedTitle: '未激活任何项目',
				notActivatedStepCall: '在会话里使用 /godot-bridge-task-center-init 技能（任务中心入口）接入项目——宿主会把当前项目记为「上次项目」并激活它。',
				notActivatedStepOpen: '或者点击「打开项目」手动选择一个项目目录；此后启动会直接回到它。',
				err_unknown_project: '这个会话还没有绑定项目。请在会话里调用一次 task_center，或在面板里手动打开一个项目。',
				err_no_project_bound: '尚未选择项目：先在面板里打开一个项目，或在会话里调用一次 task_center。',
				err_content_type: '请求格式不正确：请发送 application/json。',
				err_origin: '跨源请求已被拒绝。',
				err_bad_request: '请求体无法解析。',
				err_no_action: '缺少 action 参数。',
				err_failed: '宿主处理该操作时出错。',
				offline: '宿主没有响应',
				error: '操作失败',
				startRequestTitle: '请求开始派发',
				startRequestHint: 'Agent 请求开始派发；批准后调度器才会运行。',
				approveStart: '批准并开始',
				approving: '批准中…',
				rejecting: '拒绝中…',
				working: '处理中…',
				starting: '启动中…',
				pausing: '暂停中…',
				rejectStart: '拒绝',
				maxConcurrent: '最大并发',
				concurrencyHint: '1–8。只决定同时运行的卡数，不直接决定 worker 数量。',
				settingsConcurrencyGroup: '任务并发',
				settingsThemeGroup: '界面主题',
				settingsTheme: '主题',
				settingsThemeDsh: '跟随 DSH',
				settingsThemeConsole: '控制台暗色',
				settingsThemeHint: '只保存在本浏览器，立即生效，不修改派发设置。',
				// T-205: the settings entry is a page. Existing copy above is unchanged;
				// these are the page title, its theme rail, the unbound state and the
				// engine-path section that used to live alone in the plugin card.
				settingsPageTitle: '设置',
				settingsNavLabel: '设置分区',
				settingsNavGeneral: '常规',
				settingsNavDispatch: '派发',
				settingsNavRetry: '重试',
				settingsNavDecisions: '关键决策',
				settingsNavEngine: 'Godot 引擎',
				settingsProjectScope: '当前项目',
				settingsUnbound: '未绑定项目',
				settingsUnboundHint: '当前任务中心没有绑定项目：派发、重试与关键决策暂时不可编辑；先在任务中心打开项目。引擎路径仍可在此保存。',
				settingsSaved: '已保存派发与决策设置',
				settingsEngineLabel: 'Godot 可执行文件路径',
				settingsEngineHint: '指向真实 Godot exe 的完整路径（不要用版本管理器 shim）。保存会写入本 profile 的 cordis.patch.yml 中 tool-godot-bridge 那一行并立即生效；该值按原样使用，请确认文件存在。',
				settingsEngineSaving: '保存中…',
				settingsEngineSaved: '已保存。新的 godot_* 调用将使用该路径。',
				settingsEngineFailed: '本部署没有接受该值；已保存的路径未改变。',
				settingsEngineReset: '恢复默认',
				settingsEngineOverridden: '本 profile 已设置',
				settingsEngineReadOnly: '本部署的设置为只读。',
				settingsEngineUnavailable: '该插件当前未加载，暂时无法编辑它的配置。',
				settingsRetryGroup: '重试',
				settingsMaxAttempts: '最大尝试次数',
				settingsRetryHint: '一张卡连续失败多少次后进入阻塞。',
				invalidMaxAttempts: '最大尝试次数必须是 1–10 的整数',
				invalidConcurrency: '并发必须是 1–8 的整数',
				// T-198: decision policy editor (settings → 关键决策设置).
				decisionSettingsTitle: '关键决策设置',
				decisionSettingsHint: '每个事件选择由谁决定：ask 弹窗询问你；notify 自动处置并通知；silent 自动处置，只写审计。',
				decisionScope: '作用域',
				decisionScopeGlobal: '全局默认',
				decisionScopeProject: '项目覆盖',
				decisionScopeHint: '项目覆盖逐字段回退到全局默认；「恢复默认」只清除当前作用域里该事件的覆盖。',
				decisionEventColumn: '事件',
				decisionModeLabel: '提问模式',
				decisionDefaultLabel: '默认选项',
				decisionTimeoutLabel: '回答超时（秒）',
				decisionLimitLabel: '连续上限',
				decisionAutoRecoverLabel: '连续自动恢复上限',
				decisionResetEvent: '恢复默认',
				decisionResetAll: '全部恢复默认',
				decisionGuardsTitle: '固定高危保护',
				decisionGuardDeleteWord: '删除依赖树：始终要求输入 DELETE',
				decisionGuardTimeoutDelete: '超时不允许自动删除',
				decisionGuardHint: '固定保护不可关闭，也不会被事件策略绕过。',
				decisionPolicyWorkspaceNote: '全局默认保存在项目内（用户目录不可写）。',
				err_invalid_policy_scope: '作用域必须是 global 或 project。',
				err_invalid_policy_event: '未知的事件。',
				err_invalid_policy_events: '事件策略格式不正确。',
				err_invalid_policy_mode: '提问模式必须是 ask / notify / silent。',
				err_invalid_policy_option: '默认选项不能是删除等高危动作。',
				err_invalid_policy_timeout: '回答超时必须是 0–86400 的整数秒。',
				err_invalid_policy_limit: '连续上限必须是 0–10 的整数。',
				err_invalid_policy_auto_recover: '连续自动恢复上限必须是 0–10 的整数。',
				err_policy_unwritable: '决策策略无法保存：文件不可写。',
				err_policy_unreadable: '决策策略无法读取。',
				err_user_only: '该设置只属于用户，Agent 不能修改。',
				decisionEvent_create: '创建卡片',
				decisionEvent_dispatch: '派发批准',
				decisionEvent_dev_timeout: '开发超时',
				decisionEvent_review_timeout: 'Review 超时',
				decisionEvent_test_timeout: 'Test 超时',
				decisionEvent_reopen: 'Reopen',
				decisionEvent_delete: 'Delete',
				decisionEvent_cancel: 'Cancel',
				decisionEvent_host_verify_fail: 'Host 验证失败',
				decisionEvent_merge_conflict: '合并冲突',
				decisionEvent_worker_lost: '执行者丢失',
				decisionEvent_target_drift: 'Target drift',
				decisionEvent_review_rounds_exhausted: '评审轮次用尽',
				decisionOpt_create_create: '创建任务',
				decisionOpt_create_cancel: '取消创建',
				decisionOpt_dispatch_approve: '批准派发',
				decisionOpt_dispatch_hold: '暂不派发',
				decisionOpt_dispatch_withdraw: '取消申请',
				decisionOpt_dev_timeout_continue: '继续等待 20 分钟',
				decisionOpt_dev_timeout_retry_dev: '重试开发',
				decisionOpt_dev_timeout_cancel: '取消任务',
				decisionOpt_dev_timeout_cancel_tree: '取消并删除依赖树',
				decisionOpt_review_timeout_continue: '继续评审 20 分钟',
				decisionOpt_review_timeout_replace: '更换 reviewer',
				decisionOpt_review_timeout_block: '阻塞任务',
				decisionOpt_review_timeout_cancel: '取消任务',
				decisionOpt_test_timeout_continue: '继续测试 20 分钟',
				decisionOpt_test_timeout_replace: '更换 tester',
				decisionOpt_test_timeout_block: '阻塞任务',
				decisionOpt_test_timeout_cancel: '取消任务',
				decisionOpt_reopen_reopen: '重新打开',
				decisionOpt_reopen_keep: '保持关闭',
				decisionOpt_delete_keep: '保留',
				decisionOpt_delete_delete: '删除',
				decisionOpt_cancel_return: '返回',
				decisionOpt_cancel_confirm: '确认取消',
				decisionOpt_host_verify_fail_return_dev: '退回开发',
				decisionOpt_host_verify_fail_block: '阻塞任务',
				decisionOpt_host_verify_fail_cancel: '取消任务',
				decisionOpt_merge_conflict_return_dev: '退回开发',
				decisionOpt_merge_conflict_block: '阻塞任务',
				decisionOpt_merge_conflict_cancel: '取消任务',
				decisionOpt_worker_lost_redispatch: '重新派发',
				decisionOpt_worker_lost_block: '阻塞任务',
				decisionOpt_worker_lost_cancel: '取消任务',
				decisionOpt_target_drift_rebuild_retest: '重建并重测',
				decisionOpt_target_drift_block: '阻塞任务',
				decisionOpt_target_drift_cancel: '取消任务',
				decisionOpt_review_rounds_exhausted_block: '阻塞',
				decisionOpt_review_rounds_exhausted_cancel: '取消任务',
				apply: '应用',
				leaseLeft: '剩余',
				leaseExpired: '已过期',
				leaseReminder: '即将到期',
				noProject: '未选择项目',
				openProject: '打开项目',
				projectPlaceholder: '项目目录的绝对路径',
				projectRequired: '请填写项目目录',
				titleRequired: '标题不能为空',
				loading: '加载中…',
				statusPending: '等待',
				statusRunning: '实现中',
				statusReviewing: '评审中',
				statusTesting: '测试中',
				statusDone: '完成',
				statusBlocked: '阻塞',
				statusCancelled: '取消',
				depReady: '就绪',
				depWaiting: '等待',
				depBroken: '依赖已破',
				taskCount: '任务',
				noSpec: '（未填写）',
				noEvidence: '（无）',
				forceHint: '任务被其他任务依赖时，普通删除会被拒绝；强制删除会同时断开这些依赖。',
				filesBusy: '等待文件锁',
				waitingOn: '等待',
				brokenOn: '已破',
				detailSpecTitle: '任务说明',
				detailActionNote: '备注（可选，随阻塞/取消记录）',
				notePlaceholder: '补充原因（可选）',
				deleteConfirm: '删除这个任务？',
				openSession: '查看会话',
				dependsPlaceholder: '依赖任务 id，逗号分隔，例如 T-2, T-5',
				filesPlaceholder: '每行一个项目相对路径，例如 scripts/player.gd',
				noTasks: '没有任务',
				submittedOn: '提交于',
				spawned: '自动创建',
				viaMessage: '复用空闲成员',
				noScheduler: '调度器不可用',
				serverTime: '服务端时间',
				waitingLocks: '文件锁冲突',
				waitDispatchPaused: '派发已暂停',
				waitDependency: '等待依赖',
				waitDependencyBroken: '依赖已破',
				waitFileLock: '等待文件锁',
				waitEnvironmentDirty: '等待主树干净（自动重试）',
				environmentTransient: '主树当前有未提交改动（合并进行中常见）· 受影响的卡本轮跳过，下一轮自动重试 · 最近检查 {ago}',
				environmentSustained: '主树持续有未提交改动：{ids} 暂时无法派发 · 提交或暂存后会自动恢复 · 最近检查 {ago}',
				// T-155: per-session aggregation, one workspace scope bar, no primary session.
				sessionsLabel: '会话',
				sessionsHint: '每个参与会话有自己的卡；当前对话会话只高亮，不是主会话。',
				sessionColSession: '会话',
				sessionColCards: '卡数 · 总 / 活跃',
				sessionColStatus: '状态',
				sessionDetailTitle: '当前会话详情',
				sessionDetailProject: '项目',
				sessionDetailCards: '卡（总数 / 进行中）',
				sessionDetailPreview: '预览',
				sessionDetailSelected: '已选中',
				sessionDetailSelectedTitle: '选中会话详情',
				sessionDetailNoTasks: '该会话暂无任务',
				sessionsEmpty: '还没有记录到参与该项目的会话',
				sessionsCurrent: '当前',
				sessionsStatusLive: '在线',
				sessionsStatusStale: '已静默',
				sessionsStatusUnknown: '状态未知',
				sessionsCards: '卡 {n}',
				sessionsActive: '进行 {n}',
				sessionsReadiness: '可派发',
				sessionsStageReview: '评审',
				sessionsStageTest: '测试',
				sessionsReady: '已就绪',
				sessionsNotReady: '未就绪',
				sessionFilter: '会话筛选',
				sessionFilterAll: '全部会话',
				sessionCardTitle: '会话',
				workspaceBoard: '看板工作区',
				workspaceChat: '当前对话工作区',
				workspaceSame: '同一工作区',
				workspaceFollowing: '正在切换工作区…',
				workspaceFollowed: '已跟随当前对话工作区',
				workspaceUnknown: '当前对话工作区未知',
				workspaceNotReady: '当前对话工作区还没接入',
				workspaceMissing: '缺少：{items}',
				workspaceSwitchFailed: '切换失败：{error}',
				workspaceRetry: '重试',
				workspaceRecheck: '重新检查',
				workspaceOpenOther: '打开其他项目',
				workspaceFollowAction: '跟随',
				copySessionId: '复制会话 ID',
				sessionIdCopiedToast: '已复制会话 ID',
				ownerSession: '所属会话',
				ownerSessionHint: '这张卡属于该会话',
				// T-158 夜航作战板：两行 header、六个泳道、紧凑卡片。
				sharedBoard: '共享看板',
				sessionsPill: '{n} 个会话',
				sessionsPopoverTitle: '参与会话',
				moreActions: '更多',
				diagnostics: '诊断',
				dispatchCol: '待派发',
				readyCount: '就绪 {n}',
				waitingCount: '等待 {n}',
				doneAllSummary: '{total} 个已完成 · 最近 {recent} 个',
				viewArchive: '查看归档 →',
				stateReady: '已就绪',
				stateWaiting: '等待派发',
				stateRunning: '执行中',
				stateReviewing: '评审中',
				stateTesting: '测试中',
				stateDone: '已完成',
				stateBlocked: '阻塞',
				stateCancelled: '已取消',
				depCount: '依赖 {n}',
				dependencyNone: '无依赖',
				lastScan: '上次扫描 {ago}',
				local: '本地',
				writeFiles: '写卡文件',
				noBlockedTitle: '没有阻塞任务',
				noBlockedHint: '依赖、锁和权限都正常',
				projectMissingTitle: '项目尚未就绪',
				projectCheck: '检查项目',
				projectChecking: '检查中…',
				stageRoles: '阶段角色',
				waitConcurrency: '并发已满',
				waitCandidateStale: '候选过期，自动重建中',
				waitNeedsRebase: '等待人工 rebase',
				loadFailed: '读取失败',
				checkoutTitle: '执行工作树',
				mergeTitle: '合并请求',
				mergeStatus: '合并状态',
				mergeTarget: '目标分支',
				worktree: '工作树',
				branch: '分支',
				commit: '提交',
				mergeOpen: '待合并',
				mergeMerged: '已合并',
				mergeConflict: '冲突',
				mergeFailed: '验证失败',
				mergeRejected: '已拒绝',
				phaseTitle: '阶段',
				phaseCurrent: '当前阶段',
				phaseAt: '时间',
				phaseAttempts: '阶段轮次',
				requiredRole: '需要角色',
				review: '评审',
				reviewStatus: '评审状态',
				reviewer: '评审者',
				submitter: '提交者',
				reviewAttempt: '评审轮次',
				reviewReasons: '打回原因',
				reviewPending: '待评审',
				reviewApproved: '评审通过',
				reviewChanges: '已打回',
				noReview: '尚未提交评审。',
				reviewHint: '评审通过后进入测试阶段；打回会退回实现中。',
				test: '测试',
				testStatus: '测试状态',
				tester: '测试者',
				testAttempt: '测试轮次',
				testEvidence: '测试证据',
				testCandidate: '候选工作树',
				testPending: '待测试',
				testPassed: '测试通过',
				testFailed: '测试未通过',
				noTest: '尚未进入测试。',
				testHint: '测试通过后由宿主自动合并；未通过会退回实现中。',
				verificationOutput: '合并验证输出',
				noOutput: '（无输出）',
				outputTailHint: '仅显示输出尾部',
				conflictDetail: '冲突详情',
				statusTab: '状态',
				rolesTab: '角色',
				statusAgents: '执行代理',
				statusWorktrees: '工作树',
				statusActivity: '活动',
				statusKind: '类型',
				statusDescription: '描述',
				statusSession: '会话',
				statusCurrentTask: '当前任务',
				statusSessionHint: '当前 DSH 没有可用的会话跳转 API：可以复制 session id。',
				panelSession: '面板会话',
				sessionSourceHost: '宿主提供的当前会话',
				sessionSourceUrl: 'URL 指定',
				sessionSourceWindow: '本窗口自造（宿主未提供会话）',
				copySession: '复制会话',
				sessionCopied: '已复制',
				copyFailed: '复制失败',
				statusKinds: '类型计数',
				statusRoleInstances: '角色实例',
				statusMissing: '缺',
				statusAgentsUnavailable: '宿主没有提供代理树信息。',
				statusAgentsNoRoot: '宿主没有报告根代理。',
				statusAgentsNoChildren: '根代理还没有活动的子代理。',
				statusWorktreesUnavailable: '宿主没有提供工作树信息。',
				statusNoGit: '没有 git 服务（no-git-service）。',
				statusActivityUnavailable: '宿主没有提供活动记录。',
				statusActor: '主体',
				statusWorktreesEmpty: '没有工作树。',
				statusActivityEmpty: '没有活动记录。',
				statusSummaryPaused: '已暂停',
				statusSummaryRunning: '派发中',
				statusNoRunning: '没有进行中的任务',
				statusRunningCount: '有 {n} 个任务在跑',
				statusLastActivity: '最近活动',
				statusCardDispatch: '派发',
				statusCardWorktrees: '工作树',
				statusCardAgents: '代理',
				statusCardActivity: '活动',
				statusConcurrent: '并发',
				statusReady: '就绪',
				statusWhyPaused: '派发已暂停。恢复后，就绪任务按优先级派发',
				statusWhyNoReady: '没有就绪任务（全部完成或被依赖挡住）',
				statusWhyFull: '并发已满',
				statusWhyBlocked: '有 {n} 个任务被阻塞',
				statusWhyRunning: '派发中，仍有就绪任务等待派发',
				statusLastScan: '上次扫描',
				statusMergeQueue: '合并队列',
				statusTasks: '任务',
				statusWtTotal: '个工作树',
				statusWtActive: '活跃',
				statusWtMain: '主',
				statusWtTask: '任务',
				statusWtActiveState: '活跃',
				statusWtIdle: '空闲',
				statusWtSafe: '可清理',
				statusWtConfirm: '需确认',
				statusWtClean: '干净',
				statusWtDirty: '有改动',
				statusWtMerged: '已合并',
				statusWtUnmerged: '未合并',
				statusWtVerify: '验证',
				statusWtMerge: '合并',
				statusWtTest: '测试',
				statusWtOther: '其他',
				statusWtPreflight: '预检',
				statusWtPreflighting: '预检中…',
				statusWtCleanup: '清理',
				statusWtForceCleanup: '强制清理',
				statusWtConfirmForce: '确认强制清理',
				statusWtCancel: '取消',
				statusWtCleanupSafe: '清理 {n} 个可安全清理',
				statusWtPreviewTitle: '预检结果',
				statusWtPreviewNone: '没有可安全清理的工作树',
				statusWtPreviewKept: '保留 {n} 项',
				statusWtResult: '清理结果',
				statusWtRemoved: '已移除',
				statusWtKept: '保留',
				statusWtFailed: '失败',
				statusWtCleanupFailed: '清理失败',
				statusWtNoStale: '没有陈旧工作树',
				statusWtLoading: '正在读取工作树…',
				statusWtPreflightFirst: '请先预检',
				statusWtUnprobed: '未探测',
				statusWtProbing: '探测中…',
				statusWtProbeFailed: '探测失败',
				statusWtReasonUnverified: '未确认',
				statusWtReasonOutsideRoot: '越界',
				statusWtReasonUnknown: '需人工处理',
				statusStaleWorktrees: '陈旧工作树',
				statusIdle: '空闲',
				statusAgentUnit: '人',
				statusSession: '会话',
				statusLatestActivity: '最近',
				statusEventUnit: '条',
				statusSweepFolded: '心跳已折叠',
				statusSweepsShown: '心跳已显示',
				statusMinutes: '分钟',
				statusPausedBy: '由 {by} 暂停',
				statusPauseSourceLabel: '暂停来源',
				statusPauseReasonLabel: '暂停原因',
				pauseSourceUser: '用户',
				pauseSourcePreflight: '启动前检查',
				pauseSourceScheduler: '调度器',
				pauseSourceWorktree: '工作树',
				pauseSourceLegacy: '未知/旧数据',
				statusYou: '你',
				stageDispatch: '派发',
				stageImplement: '实现',
				stageReview: '评审',
				stageTest: '测试',
				stageMerge: '合并',
				roundUnit: '轮',
				interruptedAt: '中断于',
				detailSubmitted: '提交',
				detailSubmitCount: '第 {n} 次提交',
				detailFilesDeclared: '声明 {n} 文件',
				detailFilesActual: '实际 {n} 文件',
				detailRound: '第 {n} 轮',
				detailResubmitted: '重新提交',
				detailFixSubmit: '修复后重新提交',
				detailWhereNow: '做到哪了',
				detailAllFields: '全部字段',
				detailNoEvents: '还没有阶段结论。',
				detailInterrupted: '任务被中断',
				detailElapsed: '用时',
				detailDeclaredFiles: '声明文件',
				detailActualFiles: '实际文件',
				detailHostCheck: '宿主检查',
				detailHostCheckUndeclared: '未声明',
				detailHostCheckIncomplete: '未完成',
				detailHostCheckFailed: '失败',
				detailSpecExpand: '展开说明与验收',
				detailSpecHint: '说明与验收可收起。',
				detailNow: '现在',
				detailMinutes: '分钟',
				detailHours: '小时',
				detailSeconds: '秒',
				detailTestDuration: '用时',
				detailQueueWait: '排队',
				targetBranch: '目标分支',
				targetFollowDefault: '跟随默认（留空）',
				targetDefaultLabel: '默认',
				defaultTargetLabel: '默认目标分支',
				defaultTargetHint: '留空则跟随主检出的当前分支',
				queuedChip: '排队中 · 前面 {n} 条',
				queueLengthChip: '队列 {n}',
				actorUnknown: '成员 {id}',
				actorRoleReviewer: '评审者',
				actorRoleTester: '测试者',
				actorRoleWorker: '执行者',
				statusOnlyHeartbeats: '仅心跳',
				evtCreate: '创建',
				evtOutcomePass: '通过',
				evtOutcomeReject: '打回',
				evtOutcomeFail: '失败',
				evtRetry: '重试',
				evtDispatch: '派发',
				evtSubmit: '提交',
				evtReviewPass: '评审通过',
				evtReviewReject: '评审打回',
				evtTestPass: '测试通过',
				evtTestFail: '测试失败',
				evtMerge: '合并',
				evtBlocked: '阻塞',
				evtCancel: '取消',
				evtEvent: '事件',
				verdictReviewTitle: '评审裁决（以 @user 身份记录）',
				verdictTestTitle: '测试裁决（以 @user 身份记录）',
				verdictReviewPass: '通过评审',
				verdictReviewReject: '打回评审',
				verdictTestPass: '通过测试',
				verdictTestFail: '测试失败',
				verdictReasonLabel: '理由（打回/失败必填）',
				verdictReasonRequired: '打回或测试失败必须填写理由',
				verdictSubmit: '提交裁决',
				verdictCancel: '取消',
				evtHostCheck: '宿主检查',
				evtError: '异常',
				'evtLabel-create': '创建',
				'evtLabel-retry': '重试',
				'evtLabel-dispatch': '派发',
				'evtLabel-submit': '提交',
				'evtLabel-review-pass': '评审',
				'evtLabel-review-reject': '打回',
				'evtLabel-test-pass': '测试',
				'evtLabel-test-fail': '测试',
				'evtLabel-merge': '合并',
				'evtLabel-merge-rejected': '合并失败',
				'evtLabel-blocked': '阻塞',
				'evtLabel-cancel': '取消',
				'evtLabel-host-check': '宿主检查',
				'evtLabel-sweep': '心跳',
				viewFull: '查看全文',
				collapse: '收起',
				statusSweepInterval: '每 5 秒扫描',
				statusShowAll: '显示全部',
				statusShowReal: '仅真实事件',
				statusResultCompleted: '已完成',
				statusResultPassed: '通过',
				statusResultSubmitted: '已提交',
				statusEvtDispatch: '派发',
				statusEvtSubmit: '提交',
				statusEvtReview: '评审',
				statusEvtTest: '测试',
				statusEvtMerge: '合并',
				statusEvtError: '阻塞/失败',
				statusEvtHostCheck: '宿主检查',
				statusEvtSweep: '心跳',
				roleErrMissingName: '缺少角色名',
				roleErrActionTimeout: '宿主操作超时',
				roleErrQueueTimeout: '合并队列超时',
				roleErrAbandoned: '合并队列已放弃该操作',
				roleErrWriteFailed: '角色配置写入失败',
				roleErrEnsureFailed: '角色实例准备失败',
				statusActorAgent: '代理',
				statusActorHost: '宿主',
				statusActorSystem: '系统',
				statusLimit: '上限',
				statusCount: '条数',
				wtTypeMain: '主',
				wtTypeTask: '任务',
				wtTypeVerify: '验证',
				wtTypeTest: '测试',
				wtTypeMerge: '合并',
				wtTypeOther: '其他',
				wtActive: '活跃',
				wtIdle: '空闲',
				wtHead: '提交',
				wtTask: '任务',
				rolesUnavailable: '宿主没有提供角色配置。',
				rolesHint: '角色配置属于用户：可新增/修改/删除 profile、绑定阶段、排空或替换实例，或恢复默认。',
				roleStatus: '状态',
				roleInstances: '实例',
				roleKindWorker: '实现',
				roleKindReviewer: '评审',
				roleKindTester: '测试',
				roleSave: '保存',
				roleCreate: '创建',
				rolePrompt: '指令',
				roleSkills: '技能',
				roleRules: '规则',
				roleContext: '上下文',
				rolePermissions: '权限',
				roleProfilePrompt: 'Profile prompt（可修改）',
				rolePromptEmpty: '（空 —— 内置角色的上下文由宿主 brief 补齐）',
				roleSource: '来源',
				roleName: '名称',
				roleKind: '种类',
				roleActionFailed: '操作失败',
				roleDrained: '已排空',
				roleCreated: '已创建',
				roleWaited: '等待',
				roleTimedOut: '等待超时',
				roleWaiting: '等待中',
				roleBuiltin: '内置',
				roleCustom: '自定义',
				roleErrName: '角色名不合法',
				roleErrProfile: '角色配置不合法',
				roleErrKind: '角色种类不合法',
				roleErrStage: '阶段不合法',
				roleErrSkills: '技能必须是列表',
				roleErrContext: '上下文必须是 fresh 或 fork',
				roleErrPermissions: '权限不合法',
				roleErrPrompt: '指令过长或不合法',
				roleErrUnknownProfile: '未知角色 profile',
				roleErrStageMismatch: '该 profile 不属于这个阶段',
				roleErrExists: '角色已存在',
				roleErrDefaultProfile: '内置角色不能删除',
				roleErrUnknownInstance: '未知角色实例',
				roleErrNotLive: '实例不可用（failed）',
				roleErrUnavailable: '角色管理器不可用',
				roleErrUserOnly: '仅限用户操作',
				roleErrVariable: '模板变量不合法',
				roleErrBuiltinReadonly: '内置角色是宿主默认，不能修改；请复制一份来改。',
				roleErrSkillsUnavailable: '技能服务不可用',
				roleErrUnsaved: '还有未保存的修改，请先保存或丢弃，再切换当前使用。',
				roleEditor: '角色上下文编辑器',
				roleEditorDraft: '草稿（未保存）',
				roleEditorCreateBlank: '新建空白 profile',
				roleEditorNoProfile: '该阶段没有可用的角色',
				roleCurrentUse: '当前使用',
				roleApplyHint: '选择后立即绑定该阶段；有运行实例时会一起替换。',
				roleSectionRole: '角色与阶段',
				rolePreviewGroupBuiltin: '内置默认提示词',
				roleDraftName: '副本名称',
				roleDiscard: '丢弃',
				roleDraftHint: '草稿未保存 · 切换会提示',
				roleRunningNow: '运行中',
				roleNoneRunning: '无',
				roleFromDefault: '来自默认',
				roleFromCopy: '来自副本',
				roleAnchorPrompt: '你的提示词',
				roleAnchorBoundary: '权限边界与结论',
				roleSourceHostFixed: '宿主固定',
				roleSourceAuto: '自动填充',
				roleSourceUnoverridable: '不可覆盖',
				roleSourceHostInjected: '宿主注入',
				roleUseDefault: '默认',
				roleUsePendingNextDispatch: '没有在跑实例，下次派发生效。',
				roleDeleteThis: '删除这份',
				rolePreviewInjectedTitle: '注入后的提示词',
				rolePreviewEmptyValue: '（空）',
				rolePreviewTaskPick: '任务',
				rolePreviewTaskAuto: '自动（最近活跃任务）',
				rolePreviewSampleTask: '示例任务（非真实，仅用于验证注入形态）',
				rolePreviewLoading: '正在读取宿主真正注入的文本…',
				rolePreviewMissing: '宿主还没有返回注入预览。',
				rolePreviewFailed: '注入预览读取失败',
				rolePreviewGroupTask: '任务数据',
				rolePreviewBuiltinReadonly: '默认角色是宿主内置的，不能在原处修改。',
				roleEmptyBuiltinTitle: '默认角色不可修改',
				roleEmptyCopy: '复制一份并启用',
				roleEditorSkillsManage: '管理',
				roleEditorSkillsTitle: '系统技能',
				roleEditorSkillsEmpty: '宿主没有可用的系统技能。',
				roleEditorSkillsUnavailable: '技能服务不可用（skills-unavailable）。',
				roleEditorSkillsSave: '写入技能',
				roleEditorSkillUserOnly: '仅限用户调用',
				roleReplaced: '已替换',
				roleReused: '复用',
				// A direction: the stage rail is the only stage navigation.
				roleProfileEyebrow: 'PROFILE / 档案',
				roleStagesTitle: '阶段与角色',
				roleStageCurrent: '当前',
				roleStageEnabled: '已启用',
				roleStageUnbound: '未启用',
				roleStageField: '阶段',
				roleReadonly: '只读',
				roleStagesHint: '每个阶段只有一个角色，修改会在下一次派发时生效。',
				roleStageImplementDesc: '在任务 worktree 内实现、测试并提交。',
				roleStageReviewDesc: '独立审阅 diff，给出通过或打回理由。',
				roleStageTestDesc: '在独立候选树验证行为与验收项。',
				// T-195 — host decision requests (common modal copy, packet §2).
				decisionTitle: '关键决策',
				decisionSubtitleFallback: '关键事件',
				decisionCountdown: '{seconds}s 后自动选择「{defaultLabel}」',
				decisionNoCountdown: '不会自动选择',
				// T-196: the server never auto-runs a danger default, so the countdown
				// says so instead of promising an automatic choice it would refuse.
				decisionCountdownProtected: '{seconds}s 后超时，不会自动执行「{defaultLabel}」（该选项需人工确认）',
				decisionCountdownProtectedNoDefault: '{seconds}s 后超时，不会自动选择',
				decisionCreateTextPlaceholder: '修改建议（可选）',
				decisionAppliedFailed: '你的答复已记录，但宿主执行该动作失败；请查看卡片状态并重试。',
				decisionQueue: '还有 {n} 个待决策',
				decisionDefaultBadge: '默认',
				decisionTextLabel: '自定义文本',
				decisionTextPlaceholder: '可补充说明（可选）',
				decisionConfirm: '确认',
				decisionAnswering: '正在提交…',
				decisionHighRiskLabel: '输入 DELETE 确认',
				decisionHighRiskHint: '此操作不可恢复；输入 DELETE 后才能确认。',
				decisionOpenTask: '查看卡片详情',
				// T-208 — the conversation-page shell overlay entry.
				decisionOverlayChip: '待决策 {n}',
				decisionOverlayAria: '待处理的决策',
				decisionOverlayCollapse: '收起待决策卡片',
				err_already_answered: '该决策已经回答过，不能再次回答。',
				err_decision_expired: '该决策已超时失效，回答不再生效。',
				err_decision_cancelled: '该决策已取消。',
				err_unknown_decision: '找不到该决策。',
				err_already_resolved: '该决策已经处理过。',
				err_invalid_option: '该选项不属于这个决策。',
				err_invalid_answer: '请选择一个选项或输入文本。',
				err_invalid_decision_id: '缺少决策编号。',
				err_confirmation_required: '这是高危操作，请输入 DELETE 确认。',
				err_decision_conflict: '同一编号已存在内容不同的决策。',
				err_decision_capacity: '待决策数量已达上限，请先处理已有决策。',
				err_invalid_request: '决策参数不完整。',
				err_invalid_timeout: '超时时间无效。',
			},
			en: {
				nav: 'GodotBridge Task Center',
				title: 'Task Center',
				boardTab: 'Board',
				taskTitle: 'Title',
				subtitle: 'Dependency-driven dispatch · file locks · shared across sessions',
				project: 'Project',
				projectUnknown: 'No project selected',
				projectResolving: 'Resolving this session’s project…',
				projectSourceSession: 'Session',
				projectSourceManual: 'Manual',
				projectSourceRegistry: 'Registry',
				projectSourceHint: 'Where this project path came from',
				projectMismatch: 'Panel: {panel} · Session: {session}',
				projectNotReady: 'The session project cannot be opened: a Git working tree is required · {project}',
			ownerMismatch: 'The card\'s owner session {owner} differs from the dispatch target session {target}',
				projectSwitch: 'Switch to the session project',
				useCurrentProject: 'Use current project',
				useCurrentProjectHint: 'Fill in the project path the host resolves right now',
				start: 'Start dispatch',
				pause: 'Pause dispatch',
				running: 'Dispatching',
				paused: 'Paused',
				refresh: 'Refresh',
				newTask: 'New task',
				settings: 'Settings',
				close: 'Close',
				save: 'Save',
				cancel: 'Cancel',
				create: 'Create',
				update: 'Save changes',
				edit: 'Edit',
				delete: 'Delete',
				forceDelete: 'Force delete',
				block: 'Block',
				unblock: 'Unblock',
				retry: 'Retry',
				reopen: 'Reopen',
				submit: 'Submit done',
				submitEvidence: 'Submit evidence',
				note: 'Note',
				spec: 'Spec',
				acceptance: 'Acceptance',
				evidence: 'Evidence',
				dependencies: 'Dependencies',
				none: 'None',
				files: 'Files',
				noFiles: 'No declared files',
				noDeps: 'No dependencies',
				release: 'Release',
				status: 'Status',
				priority: 'Priority',
				assignee: 'Assignee',
				attempts: 'Attempts',
				created: 'Created',
				history: 'History',
				dispatch: 'Dispatch',
				dispatchError: 'Dispatch error',
				queue: 'Queue',
				queueHint: 'Dispatch takes tasks in this order; completion refills the slot.',
				waiting: 'Waiting',
				ready: 'Ready',
				runningCol: 'Implementing',
				reviewingCol: 'Reviewing',
				testingCol: 'Testing',
				doneCol: 'Done',
				archiveLine: '{n} archived · {range}',
				archiveTitle: 'Archived tasks',
				archiveOpen: 'View archived',
				// T-132: investigation cards (kind: investigate) on the board/detail.
				kindLabel: 'Kind',
				kindDev: 'Dev',
				kindInvestigate: 'Investigate',
				kindFilterAll: 'All',
				kindFilterHint: 'Filter the board by card kind',
				kindInvestigateHint: 'Investigation card: delivers a report; no review/test/merge',
				investigatingCount: 'Investigating {n}',
				investigatePending: 'Pending investigation',
				statusInvestigating: 'Investigating',
				stageRun: 'Run',
				stageDeliver: 'Deliver',
				reportTitle: 'Investigation report',
				reportDelivered: 'Delivered',
				reportMissing: 'Report not delivered',
				reportSummary: 'Summary',
				reportBody: 'Body',
				reportEvidence: 'Evidence',
				reportArtifacts: 'Artifacts',
				reportCommand: 'Command',
				reportExit: 'Exit',
				reportTail: 'Output tail',
				reportProbeCommits: 'Warning: commits in the scratch checkout (discarded)',
				reportFullHint: 'Full report: .agents/reports/{id}.md',
				casebookTitle: 'Casebook',
				casebookIndex: 'Case index',
				casebookStatus: 'Status',
				casebookKind: 'Kind',
				casebookProject: 'Project',
				casebookExecutor: 'Executor',
				casebookBase: 'Base',
				casebookTarget: 'Target',
				casebookElapsed: 'Elapsed',
				casebookDelivered: 'Delivered',
				casebookTimeline: 'Timeline',
				casebookReportFile: 'Report file',
				reportInvestigateHint: 'An investigation is delivered with report by its executor; it never enters review/test/merge.',
			statusBoardSize: 'board {mb} MB of its {limit} MB limit ({percent}%) · about {n} more cards at this size',
				archiveEmpty: 'No archived task matches',
				viewAllDone: 'View all',
				doneAllTitle: 'Completed tasks',
				doneAllSearch: 'Search by title or id',
				doneAllToday: 'Today',
				doneAllYesterday: 'Yesterday',
				doneAllEarlier: 'Earlier',
				doneAllLoadMore: 'Load more',
				doneAllEmpty: 'No completed task matches',
				doneAllLoading: 'Loading…',
				doneAllError: 'Could not load the list',
				doneAllRetry: 'Retry',
				doneAllCount: '{n} tasks',
				doneAllLoaded: '{n} loaded',
				collapseColumn: 'Collapse',
				expandColumn: 'Expand',
				blockedCol: 'Blocked',
				cancelledCol: 'Cancelled',
				emptyBoard: 'No tasks yet. Use “New task” to start.',
				emptyQueue: 'Nothing is ready to dispatch.',
				emptyHistory: 'No history yet.',
				agentsTab: 'Agents',
				agentsTitle: 'Agents',
				agentsHint: 'The root Agent of this session and the live children it started; each task is run by the agent for its stage and released when the stage ends.',
				agentsProject: 'Panel project',
				agentsRoot: 'Root agent',
				agentsLive: 'Live children',
				agentsUnavailable: 'The host did not report an agent tree.',
				agentsNoRoot: 'The host reported no root Agent, so there is no execution tree to show.',
				agentsNoChildren: 'The root Agent has no live children yet.',
				agentsPillRoot: 'Agents · {n}',
				agentsPillNone: 'Agents · not reported',
				agentsPopoverTitle: 'Execution tree',
				agentsRootLine: 'Root Agent: {name}',
				agentsLiveLine: 'Live children: {n}',
				agentRootRole: 'Root Agent',
				agentRole: 'Role',
				agentName: 'Agent',
				agentStatus: 'Status',
				agentTask: 'Task',
				agentStatusRunning: 'running',
				agentStatusIdle: 'idle',
				agentStatusFailed: 'failed',
				agentStatusUnknown: 'unknown',
				unknownProjectHint: 'This session is not bound to a project yet. Call task_center once in the session, or open a project manually below.',
				notActivatedTitle: 'No project is active',
				notActivatedStepCall: 'Use the /godot-bridge-task-center-init skill (the task center entry point) in the session: the host records the current project as its last active project and activates it.',
				notActivatedStepOpen: 'Or click “Open project” to pick a project directory manually; every later start returns to it.',
				err_unknown_project: 'This session is not bound to a project yet. Call task_center once in the session, or open a project from the panel.',
				err_no_project_bound: 'No project is selected yet: open one from the panel, or call task_center once in this session.',
				err_content_type: 'Wrong request format: send application/json.',
				err_origin: 'A cross-origin request was refused.',
				err_bad_request: 'The request body could not be parsed.',
				err_no_action: 'The action field is required.',
				err_failed: 'The host failed that action.',
				offline: 'The host did not answer',
				error: 'Action failed',
				startRequestTitle: 'Start requested',
				startRequestHint: 'An agent asked to start dispatch; it runs only after you approve.',
				approveStart: 'Approve and start',
				approving: 'Approving…',
				rejecting: 'Rejecting…',
				working: 'Working…',
				starting: 'Starting…',
				pausing: 'Pausing…',
				rejectStart: 'Reject',
				maxConcurrent: 'Maximum concurrency',
				concurrencyHint: '1–8. Limits how many cards run at once; it does not decide the worker count by itself.',
				settingsConcurrencyGroup: 'Task concurrency',
				settingsThemeGroup: 'Appearance',
				settingsTheme: 'Theme',
				settingsThemeDsh: 'Follow DSH',
				settingsThemeConsole: 'Console dark',
				settingsThemeHint: 'Stored in this browser only; applies immediately and never changes dispatch settings.',
				// T-205: the settings entry is a page (see the zh block).
				settingsPageTitle: 'Settings',
				settingsNavLabel: 'Settings sections',
				settingsNavGeneral: 'General',
				settingsNavDispatch: 'Dispatch',
				settingsNavRetry: 'Retry',
				settingsNavDecisions: 'Key decisions',
				settingsNavEngine: 'Godot engine',
				settingsProjectScope: 'Current project',
				settingsUnbound: 'No project bound',
				settingsUnboundHint: 'The task center has no project bound: dispatch, retry and key decisions cannot be edited until you open one there. The engine path can still be saved here.',
				settingsSaved: 'Saved dispatch and decision settings',
				settingsEngineLabel: 'Godot engine path',
				settingsEngineHint: 'Full path to the real Godot executable (never a version-manager shim). Saving writes it to the tool-godot-bridge row of this profile’s cordis.patch.yml and it applies immediately; the path is used as typed, so make sure it exists.',
				settingsEngineSaving: 'Saving…',
				settingsEngineSaved: 'Saved. New godot_* calls use this path.',
				settingsEngineFailed: 'The deployment did not accept this value; the stored path is unchanged.',
				settingsEngineReset: 'Reset to default',
				settingsEngineOverridden: 'Set in this profile',
				settingsEngineReadOnly: 'This deployment stores settings read-only.',
				settingsEngineUnavailable: 'This plugin is not loaded, so its configuration cannot be edited right now.',
				settingsRetryGroup: 'Retries',
				settingsMaxAttempts: 'Maximum attempts',
				settingsRetryHint: 'How many consecutive failures block a card.',
				invalidMaxAttempts: 'Maximum attempts must be an integer from 1 to 10',
				invalidConcurrency: 'Concurrency must be an integer from 1 to 8',
				// T-198: decision policy editor (settings → key decisions).
				decisionSettingsTitle: 'Key decision settings',
				decisionSettingsHint: 'Choose who decides each event: ask opens the modal, notify acts and tells you, silent acts and only audits.',
				decisionScope: 'Scope',
				decisionScopeGlobal: 'Global default',
				decisionScopeProject: 'Project override',
				decisionScopeHint: 'A project override falls back to the global default per field; reset only clears the override in this scope.',
				decisionEventColumn: 'Event',
				decisionModeLabel: 'Mode',
				decisionDefaultLabel: 'Default option',
				decisionTimeoutLabel: 'Answer timeout (s)',
				decisionLimitLabel: 'Consecutive limit',
				decisionAutoRecoverLabel: 'Auto-recovery limit',
				decisionResetEvent: 'Reset',
				decisionResetAll: 'Reset all',
				decisionGuardsTitle: 'Fixed high-risk guards',
				decisionGuardDeleteWord: 'Delete dependency tree: DELETE must always be typed',
				decisionGuardTimeoutDelete: 'A timeout never deletes',
				decisionGuardHint: 'The guards cannot be turned off and no event policy can bypass them.',
				decisionPolicyWorkspaceNote: 'The global default is stored inside the project (the user directory is not writable).',
				err_invalid_policy_scope: 'The scope must be global or project.',
				err_invalid_policy_event: 'Unknown event.',
				err_invalid_policy_events: 'The event policy is malformed.',
				err_invalid_policy_mode: 'The mode must be ask, notify or silent.',
				err_invalid_policy_option: 'A destructive action cannot be the default option.',
				err_invalid_policy_timeout: 'The answer timeout must be 0–86400 whole seconds.',
				err_invalid_policy_limit: 'The consecutive limit must be 0–10.',
				err_invalid_policy_auto_recover: 'The auto-recovery limit must be 0–10.',
				err_policy_unwritable: 'The decision policy could not be saved: the file is not writable.',
				err_policy_unreadable: 'The decision policy could not be read.',
				err_user_only: 'This setting belongs to the user; an Agent cannot change it.',
				decisionEvent_create: 'Create card',
				decisionEvent_dispatch: 'Dispatch approval',
				decisionEvent_dev_timeout: 'Dev timeout',
				decisionEvent_review_timeout: 'Review timeout',
				decisionEvent_test_timeout: 'Test timeout',
				decisionEvent_reopen: 'Reopen',
				decisionEvent_delete: 'Delete',
				decisionEvent_cancel: 'Cancel',
				decisionEvent_host_verify_fail: 'Host verify failed',
				decisionEvent_merge_conflict: 'Merge conflict',
				decisionEvent_worker_lost: 'Worker lost',
				decisionEvent_target_drift: 'Target drift',
				decisionEvent_review_rounds_exhausted: 'Review rounds exhausted',
				decisionOpt_create_create: 'Create task',
				decisionOpt_create_cancel: 'Cancel creation',
				decisionOpt_dispatch_approve: 'Approve dispatch',
				decisionOpt_dispatch_hold: 'Hold dispatch',
				decisionOpt_dispatch_withdraw: 'Withdraw request',
				decisionOpt_dev_timeout_continue: 'Wait another 20 minutes',
				decisionOpt_dev_timeout_retry_dev: 'Retry development',
				decisionOpt_dev_timeout_cancel: 'Cancel task',
				decisionOpt_dev_timeout_cancel_tree: 'Cancel and delete dependency tree',
				decisionOpt_review_timeout_continue: 'Continue review 20 minutes',
				decisionOpt_review_timeout_replace: 'Replace reviewer',
				decisionOpt_review_timeout_block: 'Block task',
				decisionOpt_review_timeout_cancel: 'Cancel task',
				decisionOpt_test_timeout_continue: 'Continue testing 20 minutes',
				decisionOpt_test_timeout_replace: 'Replace tester',
				decisionOpt_test_timeout_block: 'Block task',
				decisionOpt_test_timeout_cancel: 'Cancel task',
				decisionOpt_reopen_reopen: 'Reopen',
				decisionOpt_reopen_keep: 'Keep closed',
				decisionOpt_delete_keep: 'Keep',
				decisionOpt_delete_delete: 'Delete',
				decisionOpt_cancel_return: 'Return',
				decisionOpt_cancel_confirm: 'Confirm cancel',
				decisionOpt_host_verify_fail_return_dev: 'Return to development',
				decisionOpt_host_verify_fail_block: 'Block task',
				decisionOpt_host_verify_fail_cancel: 'Cancel task',
				decisionOpt_merge_conflict_return_dev: 'Return to development',
				decisionOpt_merge_conflict_block: 'Block task',
				decisionOpt_merge_conflict_cancel: 'Cancel task',
				decisionOpt_worker_lost_redispatch: 'Redispatch',
				decisionOpt_worker_lost_block: 'Block task',
				decisionOpt_worker_lost_cancel: 'Cancel task',
				decisionOpt_target_drift_rebuild_retest: 'Rebuild and retest',
				decisionOpt_target_drift_block: 'Block task',
				decisionOpt_target_drift_cancel: 'Cancel task',
				decisionOpt_review_rounds_exhausted_block: 'Block',
				decisionOpt_review_rounds_exhausted_cancel: 'Cancel task',
				apply: 'Apply',
				leaseLeft: 'left',
				leaseExpired: 'expired',
				leaseReminder: 'expiring',
				noProject: 'No project',
				openProject: 'Open project',
				projectPlaceholder: 'Absolute path to the project directory',
				projectRequired: 'A project directory is required',
				titleRequired: 'A title is required',
				loading: 'Loading…',
				statusPending: 'Pending',
				statusRunning: 'Implementing',
				statusReviewing: 'Reviewing',
				statusTesting: 'Testing',
				statusDone: 'Done',
				statusBlocked: 'Blocked',
				statusCancelled: 'Cancelled',
				depReady: 'ready',
				depWaiting: 'waiting',
				depBroken: 'broken',
				taskCount: 'tasks',
				noSpec: '(empty)',
				noEvidence: '(none)',
				forceHint: 'A task another task depends on cannot be deleted normally; force delete detaches those dependencies.',
				filesBusy: 'waiting for files',
				waitingOn: 'waiting on',
				brokenOn: 'broken',
				detailSpecTitle: 'Spec & acceptance',
				detailActionNote: 'Note (optional, recorded with block/cancel)',
				notePlaceholder: 'Optional reason',
				deleteConfirm: 'Delete this task?',
				openSession: 'Open session',
				dependsPlaceholder: 'Dependency ids, comma separated, e.g. T-2, T-5',
				filesPlaceholder: 'One project-relative path per line, e.g. scripts/player.gd',
				noTasks: 'No tasks',
				submittedOn: 'submitted',
				spawned: 'spawned',
				viaMessage: 'idle member',
				noScheduler: 'scheduler unavailable',
				serverTime: 'server time',
				waitingLocks: 'file lock conflict',
				waitDispatchPaused: 'dispatch paused',
				waitDependency: 'waiting on dependencies',
				waitDependencyBroken: 'dependency broken',
				waitFileLock: 'waiting for file lock',
				waitEnvironmentDirty: 'waiting for a clean main tree (auto-retry)',
				environmentTransient: 'The main tree has uncommitted changes (common while a merge runs) · affected cards were skipped this pass and will retry automatically · last checked {ago}',
				environmentSustained: 'The main tree stays dirty: {ids} cannot be dispatched · it recovers once the tree is committed or stashed · last checked {ago}',
				// T-155: per-session aggregation, one workspace scope bar, no primary session.
				sessionsLabel: 'Sessions',
				sessionsHint: 'Every participating session keeps its own cards; the current chat session is highlighted, never primary.',
				sessionColSession: 'SESSION',
				sessionColCards: 'TOTAL / ACTIVE',
				sessionColStatus: 'STATUS',
				sessionDetailTitle: 'Session detail',
				sessionDetailProject: 'Project',
				sessionDetailCards: 'Cards (total / active)',
				sessionDetailPreview: 'preview',
				sessionDetailSelected: 'selected',
				sessionDetailSelectedTitle: 'Selected session detail',
				sessionDetailNoTasks: 'No cards for this session yet',
				sessionsEmpty: 'No participating session recorded for this project yet',
				sessionsCurrent: 'current',
				sessionsStatusLive: 'live',
				sessionsStatusStale: 'stale',
				sessionsStatusUnknown: 'unknown',
				sessionsCards: '{n} cards',
				sessionsActive: '{n} active',
				sessionsReadiness: 'dispatch-ready',
				sessionsStageReview: 'review',
				sessionsStageTest: 'test',
				sessionsReady: 'ready',
				sessionsNotReady: 'not ready',
				sessionFilter: 'Session filter',
				sessionFilterAll: 'All sessions',
				sessionCardTitle: 'Sessions',
				workspaceBoard: 'Board workspace',
				workspaceChat: 'Chat workspace',
				workspaceSame: 'Same workspace',
				workspaceFollowing: 'Switching workspace…',
				workspaceFollowed: 'Following the chat workspace',
				workspaceUnknown: 'Chat workspace unknown',
				workspaceNotReady: 'The chat workspace is not onboarded yet',
				workspaceMissing: 'missing: {items}',
				workspaceSwitchFailed: 'Switch failed: {error}',
				workspaceRetry: 'Retry',
				workspaceRecheck: 'Check again',
				workspaceOpenOther: 'Open another project',
				workspaceFollowAction: 'Follow',
				sessionIdCopiedToast: 'Session ID copied',
				copySessionId: 'Copy session ID',
				ownerSession: 'Owning session',
				ownerSessionHint: 'This card belongs to that session',
				// T-158 night-watch board: two-row header, compact cards. T-194 makes it
				// seven lanes by adding the 已取消 terminal rail after 阻塞.
				sharedBoard: 'shared board',
				sessionsPill: '{n} sessions',
				sessionsPopoverTitle: 'Participating sessions',
				moreActions: 'More',
				diagnostics: 'Diagnostics',
				dispatchCol: 'Dispatch',
				readyCount: 'Ready {n}',
				waitingCount: 'Wait {n}',
				doneAllSummary: '{total} done · latest {recent}',
				viewArchive: 'View archive →',
				stateReady: 'Ready',
				stateWaiting: 'Waiting for dispatch',
				stateRunning: 'Running',
				stateReviewing: 'In review',
				stateTesting: 'In test',
				stateDone: 'Done',
				stateBlocked: 'Blocked',
				stateCancelled: 'Cancelled',
				depCount: '{n} deps',
				dependencyNone: 'no dependencies',
				lastScan: 'Last scan {ago}',
				local: 'Local',
				writeFiles: 'Write files',
				noBlockedTitle: 'No blocked tasks',
				noBlockedHint: 'Dependencies, locks and permissions look fine',
				projectMissingTitle: 'The project is not ready yet',
				projectCheck: 'Check project',
				projectChecking: 'Checking…',
				stageRoles: 'Stage roles',
				waitConcurrency: 'concurrency full',
				waitCandidateStale: 'candidate stale, rebuilding',
				waitNeedsRebase: 'waiting for a manual rebase',
				loadFailed: 'load failed',
				checkoutTitle: 'Working checkout',
				mergeTitle: 'Merge request',
				mergeStatus: 'Merge status',
				mergeTarget: 'Target branch',
				worktree: 'Worktree',
				branch: 'Branch',
				commit: 'Commit',
				mergeOpen: 'Open',
				mergeMerged: 'Merged',
				mergeConflict: 'Conflict',
				mergeFailed: 'Verification failed',
				mergeRejected: 'Rejected',
				phaseTitle: 'Phase',
				phaseCurrent: 'Current phase',
				phaseAt: 'At',
				phaseAttempts: 'Phase rounds',
				requiredRole: 'Required role',
				review: 'Review',
				reviewStatus: 'Review status',
				reviewer: 'Reviewer',
				submitter: 'Submitted by',
				reviewAttempt: 'Review round',
				reviewReasons: 'Review reasons',
				reviewPending: 'Awaiting review',
				reviewApproved: 'Review approved',
				reviewChanges: 'Changes requested',
				noReview: 'Not submitted for review yet.',
				reviewHint: 'An approval moves the task to testing; changes requested send it back to implementing.',
				test: 'Test',
				testStatus: 'Test status',
				tester: 'Tester',
				testAttempt: 'Test round',
				testEvidence: 'Test evidence',
				testCandidate: 'Candidate worktree',
				testPending: 'Awaiting test',
				testPassed: 'Test passed',
				testFailed: 'Test failed',
				noTest: 'Not entered testing yet.',
				testHint: 'A passing test lets the host merge automatically; a failed test sends the task back to implementing.',
				verificationOutput: 'Merge verification output',
				noOutput: '(no output)',
				outputTailHint: 'tail of the output shown',
				conflictDetail: 'Conflict details',
				statusTab: 'Status',
				rolesTab: 'Roles',
				statusAgents: 'Agents',
				statusWorktrees: 'Worktrees',
				statusActivity: 'Activity',
				statusKind: 'Kind',
				statusDescription: 'Description',
				statusSession: 'Session',
				statusCurrentTask: 'Current task',
				statusSessionHint: 'This DSH build has no jump-to-session API: copy the session id instead.',
				panelSession: 'Panel session',
				sessionSourceHost: 'the session the host shows',
				sessionSourceUrl: 'from the URL',
				sessionSourceWindow: 'per-window fallback (the host reported no session)',
				copySession: 'Copy session',
				sessionCopied: 'Copied',
				copyFailed: 'Copy failed',
				statusKinds: 'Kind counts',
				statusRoleInstances: 'Role instances',
				statusMissing: 'missing',
				statusAgentsUnavailable: 'The host did not report agents.',
				statusWorktreesUnavailable: 'The host did not report worktrees.',
				statusNoGit: 'No git service (no-git-service).',
				statusActivityUnavailable: 'The host did not report activity.',
				statusActor: 'Actor',
				statusWorktreesEmpty: 'No worktrees.',
				statusActivityEmpty: 'No activity entries.',
				statusSummaryPaused: 'Paused',
				statusSummaryRunning: 'Dispatching',
				statusNoRunning: 'no task is running',
				statusRunningCount: '{n} task(s) running',
				statusLastActivity: 'last activity',
				statusCardDispatch: 'Dispatch',
				statusCardWorktrees: 'Worktrees',
				statusCardAgents: 'Agents',
				statusAgentsNoRoot: 'The host reported no root Agent.',
				statusAgentsNoChildren: 'The root Agent has no live children.',
				statusCardActivity: 'Activity',
				statusConcurrent: 'concurrent',
				statusReady: 'ready',
				statusWhyPaused: 'Dispatch is paused. Once resumed, ready tasks are dispatched by priority',
				statusWhyNoReady: 'no ready task (all done or blocked by dependencies)',
				statusWhyFull: 'concurrency is full',
				statusWhyBlocked: '{n} task(s) are blocked',
				statusWhyRunning: 'dispatching; ready tasks are still waiting',
				statusLastScan: 'last scan',
				statusMergeQueue: 'merge queue',
				statusTasks: 'tasks',
				statusWtTotal: 'worktrees',
				statusWtActive: 'active',
				statusWtMain: 'main',
				statusWtTask: 'task',
				statusWtActiveState: 'active',
				statusWtIdle: 'idle',
				statusWtSafe: 'cleanable',
				statusWtConfirm: 'needs review',
				statusWtClean: 'clean',
				statusWtDirty: 'dirty',
				statusWtMerged: 'merged',
				statusWtUnmerged: 'unmerged',
				statusWtVerify: 'verify',
				statusWtMerge: 'merge',
				statusWtTest: 'test',
				statusWtOther: 'other',
				statusWtPreflight: 'Preflight',
				statusWtPreflighting: 'Checking…',
				statusWtCleanup: 'Clean up',
				statusWtForceCleanup: 'Force clean',
				statusWtConfirmForce: 'Confirm force clean',
				statusWtCancel: 'Cancel',
				statusWtCleanupSafe: 'Clean {n} safe worktrees',
				statusWtPreviewTitle: 'Preflight',
				statusWtPreviewNone: 'Nothing can be removed safely',
				statusWtPreviewKept: '{n} kept',
				statusWtResult: 'Result',
				statusWtRemoved: 'removed',
				statusWtKept: 'kept',
				statusWtFailed: 'failed',
				statusWtCleanupFailed: 'Cleanup failed',
				statusWtNoStale: 'No stale worktrees',
				statusWtLoading: 'Reading worktrees…',
				statusWtPreflightFirst: 'Run a preflight first',
				statusWtUnprobed: 'not probed',
				statusWtProbing: 'probing…',
				statusWtProbeFailed: 'probe failed',
				statusWtReasonUnverified: 'unconfirmed',
				statusWtReasonOutsideRoot: 'outside root',
				statusWtReasonUnknown: 'needs manual review',
				statusStaleWorktrees: 'Stale worktrees',
				statusIdle: 'idle',
				statusAgentUnit: 'agents',
				statusSession: 'session',
				statusLatestActivity: 'latest',
				statusEventUnit: 'entries',
				statusSweepFolded: 'heartbeats folded',
				statusSweepsShown: 'heartbeats shown',
				statusMinutes: 'min',
				statusPausedBy: 'paused by {by}',
				statusPauseSourceLabel: 'Pause source',
				statusPauseReasonLabel: 'Pause reason',
				pauseSourceUser: 'User',
				pauseSourcePreflight: 'Preflight check',
				pauseSourceScheduler: 'Scheduler',
				pauseSourceWorktree: 'Worktree',
				pauseSourceLegacy: 'Unknown/legacy',
				statusYou: 'you',
				stageDispatch: 'Dispatch',
				stageImplement: 'Implement',
				stageReview: 'Review',
				stageTest: 'Test',
				stageMerge: 'Merge',
				roundUnit: 'round(s)',
				interruptedAt: 'interrupted at',
				detailSubmitted: 'submitted',
				detailSubmitCount: 'submission {n}',
				detailFilesDeclared: '{n} declared',
				detailFilesActual: '{n} actual',
				detailRound: 'round {n}',
				detailResubmitted: 'resubmitted',
				detailFixSubmit: 'resubmitted after fix',
				detailWhereNow: 'Where it is now',
				detailAllFields: 'All fields',
				detailNoEvents: 'No phase conclusion yet.',
				detailInterrupted: 'Task was interrupted',
				detailElapsed: 'elapsed',
				detailDeclaredFiles: 'declared files',
				detailActualFiles: 'actual files',
				detailHostCheck: 'host check',
				detailHostCheckUndeclared: 'undeclared',
				detailHostCheckIncomplete: 'incomplete',
				detailHostCheckFailed: 'failed',
				detailSpecExpand: 'Expand spec and acceptance',
				detailSpecHint: 'Spec and acceptance can be collapsed.',
				detailNow: 'now',
				detailMinutes: 'min',
				detailHours: 'h',
				detailSeconds: 's',
				detailTestDuration: 'took',
				detailQueueWait: 'queue',
				targetBranch: 'Target branch',
				targetFollowDefault: 'Follow default (leave empty)',
				targetDefaultLabel: 'default',
				defaultTargetLabel: 'Default target branch',
				defaultTargetHint: 'Empty follows the main checkout branch',
				queuedChip: 'queued · {n} ahead',
				queueLengthChip: 'queue {n}',
				actorUnknown: 'member {id}',
				actorRoleReviewer: 'reviewer',
				actorRoleTester: 'tester',
				actorRoleWorker: 'worker',
				statusOnlyHeartbeats: 'heartbeats only',
				evtCreate: 'Created',
				evtOutcomePass: 'passed',
				evtOutcomeReject: 'rejected',
				evtOutcomeFail: 'failed',
				evtRetry: 'Retried',
				evtDispatch: 'Dispatched',
				evtSubmit: 'Submitted',
				evtReviewPass: 'Review passed',
				evtReviewReject: 'Review rejected',
				evtTestPass: 'Test passed',
				evtTestFail: 'Test failed',
				evtMerge: 'Merged',
				evtBlocked: 'Blocked',
				evtCancel: 'Cancelled',
				evtEvent: 'Event',
				verdictReviewTitle: 'Review verdict (recorded as @user)',
				verdictTestTitle: 'Test verdict (recorded as @user)',
				verdictReviewPass: 'Approve review',
				verdictReviewReject: 'Request changes',
				verdictTestPass: 'Pass test',
				verdictTestFail: 'Fail test',
				verdictReasonLabel: 'Reason (required to reject / fail)',
				verdictReasonRequired: 'A reason is required to reject or fail',
				verdictSubmit: 'Record verdict',
				verdictCancel: 'Cancel',
				evtHostCheck: 'Host check',
				evtError: 'Error',
				'evtLabel-create': 'create',
				'evtLabel-retry': 'retry',
				'evtLabel-dispatch': 'dispatch',
				'evtLabel-submit': 'submit',
				'evtLabel-review-pass': 'review',
				'evtLabel-review-reject': 'rejected',
				'evtLabel-test-pass': 'test',
				'evtLabel-test-fail': 'test',
				'evtLabel-merge': 'merge',
				'evtLabel-merge-rejected': 'merge failed',
				'evtLabel-blocked': 'blocked',
				'evtLabel-cancel': 'cancelled',
				'evtLabel-host-check': 'host check',
				'evtLabel-sweep': 'heartbeat',
				viewFull: 'View full',
				collapse: 'Collapse',
				statusSweepInterval: 'scans every 5s',
				statusShowAll: 'Show all',
				statusShowReal: 'Real events only',
				statusResultCompleted: 'completed',
				statusResultPassed: 'passed',
				statusResultSubmitted: 'submitted',
				statusEvtDispatch: 'dispatch',
				statusEvtSubmit: 'submit',
				statusEvtReview: 'review',
				statusEvtTest: 'test',
				statusEvtMerge: 'merge',
				statusEvtError: 'blocked/failed',
				statusEvtHostCheck: 'host check',
				statusEvtSweep: 'heartbeat',
				roleErrMissingName: 'missing role name',
				roleErrActionTimeout: 'host action timed out',
				roleErrQueueTimeout: 'merge queue timed out',
				roleErrAbandoned: 'the merge queue abandoned that action',
				roleErrWriteFailed: 'could not write the role config',
				roleErrEnsureFailed: 'role provisioning failed',
				statusActorAgent: 'agent',
				statusActorHost: 'host',
				statusActorSystem: 'system',
				statusLimit: 'limit',
				statusCount: 'count',
				wtTypeMain: 'main',
				wtTypeTask: 'task',
				wtTypeVerify: 'verify',
				wtTypeTest: 'test',
				wtTypeMerge: 'merge',
				wtTypeOther: 'other',
				wtActive: 'active',
				wtIdle: 'idle',
				wtHead: 'Head',
				wtTask: 'Task',
				rolesUnavailable: 'The host did not report role profiles.',
				rolesHint: 'Role profiles belong to the user: create/update/delete a profile, bind a stage, or reset the built-in defaults. A profile is prompt/skills configuration; it never starts or replaces a child.',
				roleStatus: 'Status',
				roleInstances: 'Instances',
				roleKindWorker: 'worker',
				roleKindReviewer: 'reviewer',
				roleKindTester: 'tester',
				roleSave: 'Save',
				roleCreate: 'Create',
				rolePrompt: 'Prompt',
				roleSkills: 'Skills',
				roleRules: 'Rules',
				roleContext: 'Context',
				rolePermissions: 'Permissions',
				roleProfilePrompt: 'Profile prompt (editable)',
				rolePromptEmpty: '(empty — the host brief fills the context for built-in roles)',
				roleSource: 'Source',
				roleName: 'Name',
				roleKind: 'Kind',
				roleActionFailed: 'Action failed',
				roleDrained: 'Drained',
				roleCreated: 'Created',
				roleWaited: 'Waited',
				roleTimedOut: 'Timed out',
				roleWaiting: 'Waiting',
				roleBuiltin: 'built-in',
				roleCustom: 'custom',
				roleErrName: 'invalid role name',
				roleErrProfile: 'invalid role profile',
				roleErrKind: 'invalid role kind',
				roleErrStage: 'invalid stage',
				roleErrSkills: 'skills must be a list',
				roleErrContext: 'context must be fresh or fork',
				roleErrPermissions: 'invalid permissions',
				roleErrPrompt: 'invalid prompt',
				roleErrUnknownProfile: 'unknown role profile',
				roleErrStageMismatch: 'that profile does not own this stage',
				roleErrExists: 'role already exists',
				roleErrDefaultProfile: 'a built-in profile cannot be deleted',
				roleErrUnknownInstance: 'unknown role instance',
				roleErrNotLive: 'instance is not live (failed)',
				roleErrUnavailable: 'role manager unavailable',
				roleErrUserOnly: 'user only',
				roleErrVariable: 'invalid template variable',
				roleErrBuiltinReadonly: 'a built-in role is a host default and cannot be edited; make a copy instead',
				roleErrSkillsUnavailable: 'skill service unavailable',
				roleErrUnsaved: 'there are unsaved changes; save or discard them before switching the current use',
				roleEditor: 'Role context editor',
				roleEditorDraft: 'draft (unsaved)',
				roleEditorCreateBlank: 'Create blank profile',
				roleEditorNoProfile: 'no role is available for this stage',
				roleCurrentUse: 'Currently using',
				roleApplyHint: 'Picking a profile binds this stage; running children keep the prompt they started with.',
				roleSectionRole: 'Role and stage',
				rolePreviewGroupBuiltin: 'Built-in default prompt',
				roleDraftName: 'Copy name',
				roleDiscard: 'Discard',
				roleDraftHint: 'Unsaved draft · switching will ask first',
				roleRunningNow: 'Running',
				roleNoneRunning: 'none',
				roleFromDefault: 'from the default',
				roleFromCopy: 'from a copy',
				roleAnchorPrompt: 'Your prompt',
				roleAnchorBoundary: 'Boundaries and verdict',
				roleSourceHostFixed: 'host-fixed',
				roleSourceAuto: 'auto-filled',
				roleSourceUnoverridable: 'cannot be overridden',
				roleSourceHostInjected: 'host-injected',
				roleUseDefault: 'Default',
				roleUsePendingNextDispatch: 'No live instance; takes effect on the next dispatch.',
				roleDeleteThis: 'Delete this copy',
				rolePreviewInjectedTitle: 'Injected prompt',
				rolePreviewEmptyValue: '(empty)',
				rolePreviewTaskPick: 'Task',
				rolePreviewTaskAuto: 'Auto (most recent active task)',
				rolePreviewSampleTask: 'Example task (not real, only to show the injected shape)',
				rolePreviewLoading: 'Reading the exact text the host injects…',
				rolePreviewMissing: 'The host has not returned an injected preview yet.',
				rolePreviewFailed: 'Could not read the injected preview',
				rolePreviewGroupTask: 'Task data',
				rolePreviewBuiltinReadonly: 'A default role is built into the host and cannot be changed in place.',
				roleEmptyBuiltinTitle: 'Default roles cannot be edited',
				roleEmptyCopy: 'Make a copy and use it',
				roleEditorSkillsManage: 'Manage',
				roleEditorSkillsTitle: 'System skills',
				roleEditorSkillsEmpty: 'The host reported no system skills.',
				roleEditorSkillsUnavailable: 'The skill service is unavailable (skills-unavailable).',
				roleEditorSkillsSave: 'Use these skills',
				roleEditorSkillUserOnly: 'user-invocable only',
				roleReplaced: 'Replaced',
				roleReused: 'Reused',
				roleProfileEyebrow: 'PROFILE / Profile',
				roleStagesTitle: 'Stages and roles',
				roleStageCurrent: 'Current',
				roleStageEnabled: 'Enabled',
				roleStageUnbound: 'Not enabled',
				roleStageField: 'Stage',
				roleReadonly: 'Read-only',
				roleStagesHint: 'Each stage has exactly one role; changes apply on the next dispatch.',
				roleStageImplementDesc: 'Implements, tests and commits inside the task worktree.',
				roleStageReviewDesc: 'Reviews the diff independently, then approves or sends it back.',
				roleStageTestDesc: 'Verifies behaviour and acceptance items in a separate candidate tree.',
				// T-195 — host decision requests (common modal copy, packet §2).
				decisionTitle: 'Decision required',
				decisionSubtitleFallback: 'Key event',
				decisionCountdown: '{seconds}s until the default “{defaultLabel}” is chosen',
				decisionNoCountdown: 'No automatic choice',
				decisionCountdownProtected: '{seconds}s until it expires; “{defaultLabel}” is protected and will not run automatically',
				decisionCountdownProtectedNoDefault: '{seconds}s until it expires; nothing is auto-selected',
				decisionCreateTextPlaceholder: 'Revision note (optional)',
				decisionAppliedFailed: 'Your answer was recorded, but the host could not perform the action; check the card and try again.',
				decisionQueue: '{n} more decisions queued',
				decisionDefaultBadge: 'Default',
				decisionTextLabel: 'Custom answer',
				decisionTextPlaceholder: 'Optional note',
				decisionConfirm: 'Confirm',
				decisionAnswering: 'Submitting…',
				decisionHighRiskLabel: 'Type DELETE to confirm',
				decisionHighRiskHint: 'This cannot be undone; confirm only after typing DELETE.',
				decisionOpenTask: 'View card',
				// T-208 — the conversation-page shell overlay entry.
				decisionOverlayChip: '{n} pending',
				decisionOverlayAria: 'Pending decisions',
				decisionOverlayCollapse: 'Collapse the pending decision',
				err_already_answered: 'This decision was already answered and cannot be answered again.',
				err_decision_expired: 'This decision timed out; the answer no longer applies.',
				err_decision_cancelled: 'This decision was cancelled.',
				err_unknown_decision: 'No such decision.',
				err_already_resolved: 'This decision was already resolved.',
				err_invalid_option: 'That option does not belong to this decision.',
				err_invalid_answer: 'Choose an option or enter some text.',
				err_invalid_decision_id: 'A decision id is required.',
				err_confirmation_required: 'This is a high-risk action: type DELETE to confirm.',
				err_decision_conflict: 'That id already exists with different content.',
				err_decision_capacity: 'Too many pending decisions; resolve some first.',
				err_invalid_request: 'The decision request is incomplete.',
				err_invalid_timeout: 'Invalid timeout.',
			},
		}

		const TC_CSS = [
			'.gbt-root{display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5}',
'.gbt-root[data-tc-theme="dsh"]{--tc-bg:var(--dsw-alias-bg-layer-2);--tc-panel:var(--dsw-alias-bg-layer-3);--tc-panel2:var(--dsw-alias-bg-layer-1);--tc-line:var(--dsw-alias-border-l4);--tc-line-soft:var(--dsw-alias-border-l3);--tc-text:var(--dsw-alias-label-primary);--tc-muted:var(--dsw-alias-label-secondary);--tc-dim:var(--dsw-alias-label-tertiary);--tc-accent:var(--dsw-alias-state-business-primary);--tc-accent-ink:#fff;--tc-amber:var(--dsw-alias-state-warn-label);--tc-cyan:var(--dsw-alias-state-business-primary);--tc-red:var(--dsw-alias-state-error-primary);--tc-hover:var(--dsw-alias-interactive-bg-hover);--tc-selected:var(--dsw-alias-bg-module-platform);--tc-input-bg:var(--dsw-alias-bg-layer-1);--tc-track:var(--dsw-alias-border-l4);--tc-accent-ring:transparent;--tc-accent-line:var(--dsw-alias-state-business-primary)}',
'.gbt-root[data-tc-theme="console"]{--tc-bg:#080b0c;--tc-panel:#0e1415;--tc-panel2:#111819;--tc-line:#243033;--tc-line-soft:#1a2425;--tc-text:#e3ece7;--tc-muted:#849396;--tc-dim:#5f6e71;--tc-accent:#b9f36b;--tc-accent-ink:#11170c;--tc-amber:#ffbd68;--tc-cyan:#74d8d2;--tc-red:#ff7d6b;--tc-hover:#16201f;--tc-selected:#101b16;--tc-input-bg:#0b1110;--tc-track:#2b3a3d;--tc-accent-ring:#b9f36b1c;--tc-accent-line:#3d5830;--dsw-alias-bg-layer-1:var(--tc-bg);--dsw-alias-bg-layer-2:var(--tc-panel);--dsw-alias-bg-layer-3:var(--tc-panel2);--dsw-alias-bg-module-platform:var(--tc-panel2);--dsw-alias-label-primary:var(--tc-text);--dsw-alias-label-secondary:var(--tc-muted);--dsw-alias-label-tertiary:var(--tc-dim);--dsw-alias-border-l3:var(--tc-line-soft);--dsw-alias-border-l4:var(--tc-line);--dsw-alias-interactive-bg-hover:var(--tc-hover);--dsw-alias-state-business-primary:var(--tc-accent);--dsw-alias-state-error-primary:var(--tc-red);--dsw-alias-state-success-primary:var(--tc-accent);--dsw-alias-state-warn-label:var(--tc-amber)}',
'.gbt-root[data-tc-theme="console"] .gbt-mark{color:var(--tc-accent-ink)}',
'.gbt-root[data-tc-theme="console"] .gbt-btn[data-variant="primary"]{color:var(--tc-accent-ink)}',
'.gbt-root[data-tc-theme="console"] .gbt-btn[data-variant="primary"]:disabled{background:var(--tc-panel2);color:var(--tc-dim);border-color:var(--tc-line);opacity:1}',
'.gbt-root[data-tc-theme="console"]{color-scheme:dark}',
'.gbt-root{--deck-bg:var(--tc-bg);--deck-panel:var(--tc-panel);--deck-panel2:var(--tc-panel2);--deck-line:var(--tc-line);--deck-text:var(--tc-text);--deck-muted:var(--tc-muted);--deck-dim:var(--tc-dim);--deck-lime:var(--tc-accent);--deck-amber:var(--tc-amber);--deck-cyan:var(--tc-cyan);--deck-red:var(--tc-red);background:var(--tc-bg);color:var(--tc-text)}',
			'.gbt-header{display:flex;align-items:center;gap:16px;padding:14px 18px;border-bottom:0.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-3);flex-wrap:wrap}',
			'.gbt-brand{display:flex;align-items:center;gap:10px;min-width:0}',
			'.gbt-mark{width:30px;height:30px;border-radius:9px;display:grid;place-items:center;background:var(--dsw-alias-state-business-primary);color:#fff;font-weight:600;font-size:15px;flex:none}',
			'.gbt-title{margin:0;font-size:15px;font-weight:600;letter-spacing:.01em}',
			'.gbt-titleline{display:flex;align-items:center;gap:7px;min-width:0}' +
				'.gbt-projectsource{flex:none;font-size:10px;line-height:1.6;padding:0 6px;border-radius:999px;text-transform:none;letter-spacing:0;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);border:0.5px solid var(--dsw-alias-border-l4);cursor:default}' +
				'.gbt-projectsource[data-project-source="session"]{color:var(--dsw-alias-state-business-primary);border-color:var(--dsw-alias-state-business-primary)}',
			'.gbt-project{margin:0;font-size:11px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:340px;font-family:ui-monospace,SFMono-Regular,Consolas,monospace}',
			// T-150: an actionable project/workspace-consistency line under the header.
			'.gbt-projectsync{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin:3px 0 0;max-width:520px;font-size:10.5px;line-height:1.5;color:var(--dsw-alias-state-warn-label)}',
			'.gbt-projectsync[data-tone="warn"] .gbt-projectsynccopy{color:var(--dsw-alias-state-warn-label)}',
			'.gbt-projectsync .gbt-actions{gap:6px;flex-wrap:wrap}',
			'.gbt-projectsync .gbt-btn{padding:1px 8px;font-size:10.5px;line-height:1.5}',
			'.gbt-counts{display:flex;gap:6px;flex-wrap:wrap}',
			'.gbt-count{display:flex;align-items:center;gap:5px;padding:2px 9px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);font-size:11px;color:var(--dsw-alias-label-secondary)}',
			'.gbt-count b{font-weight:600;color:var(--dsw-alias-label-primary)}',
			'.gbt-workermeta{display:flex;gap:6px;flex-wrap:wrap;margin:0 0 12px}',
			// T-137: the agents page is the live tree — root Agent and member table.
			// Tokens only (T-133); the table scrolls inside its wrapper so a narrow
			// panel never gets a horizontal page overflow.
			'.gbt-workersview{display:flex;flex-direction:column;gap:12px}',
			'.gbt-workerhead{display:flex;flex-direction:column;gap:9px;padding:12px 13px;border:0.5px solid var(--dsw-alias-border-l4);border-radius:10px;background:var(--dsw-alias-bg-layer-2)}',
			'.gbt-workerheadtop{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
			'.gbt-workertitle{margin:0;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}',
			'.gbt-workerchips{display:flex;gap:6px;flex-wrap:wrap}',
			'.gbt-workeridentity{display:flex;align-items:center;gap:7px 14px;flex-wrap:wrap;font-size:11px;color:var(--dsw-alias-label-tertiary)}',
			'.gbt-workerid{display:inline-flex;align-items:center;gap:5px;min-width:0}',
			'.gbt-workerid b{font-weight:500;color:var(--dsw-alias-label-secondary);min-width:0;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
			'.gbt-workeridentity .gbt-btn{height:22px;padding:2px 8px;font-size:10px}',
			'.gbt-rolecards{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:8px}',
			'.gbt-workercard{display:flex;flex-direction:column;gap:6px;padding:10px 11px;border:0.5px solid var(--dsw-alias-border-l4);border-radius:10px;background:var(--dsw-alias-bg-layer-2);min-width:0}',
			'.gbt-workercardhead{display:flex;align-items:center;justify-content:space-between;gap:6px;min-width:0}',
			'.gbt-workercardname{font-size:12px;font-weight:500;color:var(--dsw-alias-label-primary);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
			'.gbt-workercard .gbt-pill{max-width:60%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
			'.gbt-workercardline{display:flex;gap:4px 10px;flex-wrap:wrap;font-size:11px;color:var(--dsw-alias-label-secondary)}',
			'.gbt-workercardline b{font-weight:600;color:var(--dsw-alias-label-primary)}',
			'.gbt-workertable{min-width:560px}',
			'.gbt-workername{display:block;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
			'.gbt-workertask{display:block;max-width:360px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
			'.gbt-workertable th:first-child,.gbt-workertable td:first-child{width:1%;white-space:nowrap}',
			'.gbt-controls{display:flex;gap:8px;margin-left:auto;align-items:center;flex-wrap:wrap}',
			'.gbt-btn{appearance:none;border:0.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);height:30px;padding:0 12px;border-radius:8px;font:inherit;font-size:12px;cursor:pointer;white-space:nowrap;display:inline-flex;align-items:center;justify-content:center;gap:5px}',
			'.gbt-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
			'.gbt-btn:disabled{opacity:.45;cursor:default}',
			'.gbt-btn[data-variant="primary"]{background:var(--dsw-alias-state-business-primary);border-color:transparent;color:#fff}',
			'.gbt-btn[data-variant="primary"]:hover:not(:disabled){background:var(--dsw-alias-state-business-primary);filter:brightness(1.05)}',
			'.gbt-btn[data-variant="danger"]{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}',
			'.gbt-btn[data-size="sm"]{height:26px;padding:0 9px;font-size:11px}',
			'.gbt-statusline{display:flex;align-items:center;gap:10px;padding:7px 18px;border-bottom:0.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-2);font-size:11px;color:var(--dsw-alias-label-tertiary);flex-wrap:wrap}',
			'.gbt-dot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-label-tertiary);display:inline-block;flex:none}',
			'.gbt-dot[data-running="true"]{background:var(--dsw-alias-state-success-primary);box-shadow:0 0 0 3px var(--dsw-alias-bg-layer-2)}',
			'.gbt-main{display:flex;min-height:0;flex:1}',
			'.gbt-content{display:flex;flex-direction:column;min-width:0;flex:1;min-height:0}',
			'.gbt-tabs{display:flex;gap:4px;padding:10px 18px 0;flex-wrap:wrap}',
			'.gbt-tab{appearance:none;border:none;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;padding:6px 11px;border-radius:8px;cursor:pointer}',
			'.gbt-tab:hover{background:var(--dsw-alias-interactive-bg-hover)}',
			'.gbt-tab[data-active="true"]{background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary);font-weight:600}',
			'.gbt-view{flex:1;min-height:0;overflow:auto;padding:12px 18px 18px}',
			// T-135: the board is its own bounded horizontal scrollport, so a narrow
			// panel keeps a visible scrollbar at the bottom of the board instead of a
			// native bar parked under the tallest column. The kind filter stays above
			// the scrollport and is never scrolled away.
			'.gbt-boardwrap{display:flex;flex-direction:column;height:100%;min-height:0}',
			'.gbt-board{display:flex;gap:12px;align-items:stretch;flex:1 1 auto;min-height:0;overflow:auto;scrollbar-width:thin;scrollbar-color:var(--dsw-alias-border-l3,var(--dsw-alias-border-l4)) transparent}',
			'.gbt-board::-webkit-scrollbar{height:8px;width:8px}',
			'.gbt-board::-webkit-scrollbar-thumb{background:var(--dsw-alias-border-l3,var(--dsw-alias-border-l4));border-radius:4px}',
			'.gbt-col{box-sizing:border-box;flex:1 1 0;min-width:172px;max-width:330px;background:var(--dsw-alias-bg-layer-3);border:0.5px solid var(--dsw-alias-border-l4);border-radius:12px;display:flex;flex-direction:column;max-height:100%;min-height:120px}',
			'.gbt-colhead{display:flex;align-items:center;gap:7px;padding:9px 11px;border-bottom:0.5px solid var(--dsw-alias-border-l4);font-size:11px;font-weight:600;color:var(--dsw-alias-label-secondary);letter-spacing:.04em;text-transform:uppercase}',
			'.gbt-colhead[data-collapsible="true"]{cursor:pointer;user-select:none}' +
				'.gbt-colhead[data-collapsible="true"]:hover{color:var(--dsw-alias-label-primary)}' +
				'.gbt-colchev{font-size:10px;opacity:.75;width:9px}' +
				'.gbt-colfoot{padding:8px 11px;border-top:0.5px solid var(--dsw-alias-border-l4)}' +
				'.gbt-colfoot .gbt-linkbtn{font-size:12px}' +
				'.gbt-muted{color:var(--dsw-alias-label-tertiary);font-size:11px}' +
				'.gbt-donelist{display:flex;flex-direction:column;gap:6px;padding:10px 12px}' +
				'.gbt-donetitle{margin:12px 12px 4px;font-size:11.5px;color:var(--dsw-alias-label-tertiary)}' +
				'.gbt-donerow{display:flex;align-items:center;gap:9px;width:100%;padding:7px 9px;border:0.5px solid var(--dsw-alias-border-l4);border-radius:7px;background:var(--dsw-alias-bg-layer-3);color:inherit;font:inherit;text-align:left;cursor:pointer}' +
				'.gbt-donerow:hover{border-color:var(--dsw-alias-state-business-primary)}' +
				'.gbt-donerow .gbt-id{flex:none}' +
				'.gbt-donetitletext{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
				'.gbt-donewhen{flex:none;font-size:11px;color:var(--dsw-alias-label-tertiary);font-family:var(--mono,monospace)}' +
				'.gbt-skel{height:34px;border-radius:7px;background:linear-gradient(90deg,var(--dsw-alias-bg-layer-3),var(--dsw-alias-bg-module-platform),var(--dsw-alias-bg-layer-3));background-size:200% 100%;animation:gbt-skel 1.2s linear infinite}' +
				'@keyframes gbt-skel{0%{background-position:200% 0}100%{background-position:-200% 0}}' +
				'.gbt-loading{display:flex;flex-direction:column;gap:16px;padding:18px 18px 24px;min-height:0}' +
				'.gbt-loadingline{display:flex;align-items:center;gap:8px}' +
				'.gbt-loadingline .gbt-footnote{margin:0}' +
				'.gbt-skellanes{display:flex;gap:12px;min-height:0}' +
				'.gbt-skellane{flex:1 1 0;min-width:120px;max-width:330px;border:0.5px solid var(--dsw-alias-border-l4);border-radius:12px;background:var(--dsw-alias-bg-layer-3);padding:10px;display:flex;flex-direction:column;gap:8px}' +
				'.gbt-skelhead{height:16px;width:58%;margin-bottom:2px}' +
				'.gbt-skelcard{height:58px}' +
				'.gbt-colcount{margin-left:auto;font-weight:500;color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-bg-layer-2);border-radius:999px;padding:0 7px;font-size:10px}',
			'.gbt-cards{display:flex;flex-direction:column;gap:8px;padding:9px;overflow:auto;flex:1 1 auto;min-height:0}',
			'.gbt-card{box-sizing:border-box;min-width:0;border:0.5px solid var(--dsw-alias-border-l4);border-radius:10px;padding:10px 11px;background:var(--dsw-alias-bg-layer-2);cursor:pointer;display:flex;flex-direction:column;gap:7px;transition:border-color .12s ease,box-shadow .12s ease}',
			'.gbt-card:hover{border-color:var(--dsw-alias-state-business-primary)}',
			'.gbt-card[data-selected="true"]{border-color:var(--dsw-alias-state-business-primary);box-shadow:0 0 0 1px var(--dsw-alias-state-business-primary)}',
			'.gbt-cardtop{display:flex;align-items:center;gap:6px;flex-wrap:wrap}',
			'.gbt-id{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px;color:var(--dsw-alias-label-tertiary)}',
			'.gbt-cardtitle{font-size:12px;font-weight:500;line-height:1.45;color:var(--dsw-alias-label-primary);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word}',
			'.gbt-cardmeta{display:flex;gap:5px;flex-wrap:wrap;font-size:11px;color:var(--dsw-alias-label-tertiary)}',
			// T-140: the verdict area belongs to the card. A separator and real spacing
			// keep it from looking like two bare buttons glued under the meta row.
			'.gbt-cardverdict{display:flex;flex-direction:column;gap:8px;margin-top:2px;padding-top:10px;border-top:0.5px solid var(--dsw-alias-border-l4)}',
			'.gbt-cardverdicthead{font-size:11px;line-height:1.4;font-weight:500;color:var(--dsw-alias-label-tertiary);letter-spacing:.02em}',
			'.gbt-cardverdictactions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:2px}',
			// Equal halves: two verdicts read as one control row, never overflow a narrow card.
			'.gbt-cardverdict .gbt-btn{flex:1 1 0;min-width:0;height:30px;padding:0 10px;text-align:center}',
			'.gbt-cardverdictform{display:flex;flex-direction:column;gap:6px;margin-top:2px}',
			'.gbt-cardverdictform label{font-size:11px;color:var(--dsw-alias-label-secondary);margin:0}',
			'.gbt-cardverdictform textarea{width:100%;min-height:64px;padding:7px 9px;border:0.5px solid var(--dsw-alias-border-l4);border-radius:8px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;resize:vertical;box-sizing:border-box}',
			'.gbt-chip{display:inline-flex;align-items:center;gap:3px;padding:1px 6px;border-radius:5px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:10px;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
			'.gbt-chip[data-tone="ready"]{background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-state-success-primary)}',
			'.gbt-chip[data-tone="waiting"]{background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-state-warn-label)}',
			'.gbt-chip[data-tone="broken"]{background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-state-error-primary)}',
			'.gbt-chip[data-tone="running"]{background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-state-success-primary)}',
			'.gbt-chip[data-tone="reviewing"]{background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-state-warn-label)}',
			'.gbt-chip[data-tone="testing"]{background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-state-warn-label)}',
			'.gbt-chip[data-tone="done"]{background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-state-success-primary)}',
			'.gbt-chip[data-tone="blocked"]{background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-state-error-primary)}',
			'.gbt-chip[data-tone="cancelled"]{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-tertiary)}',
			// T-132: investigation cards (kind: investigate) — filter bar, badge, report.
			'.gbt-kindfilter{display:inline-flex;gap:6px;align-items:center;margin:0 0 10px;padding:3px;border-radius:999px;background:transparent}',
			'.gbt-kindfilterbtn{font-size:12px;line-height:1.6;padding:2px 10px;border-radius:999px;border:none;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}' +
				'.gbt-kindfilterbtn:hover{background:var(--dsw-alias-interactive-bg-hover)}',
			'.gbt-kindfilterbtn[data-active="true"]{background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary)}',
			'.gbt-chip[data-kind="investigate"],.gbt-pill[data-kind="investigate"]{background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-state-business-primary)}',
			'.gbt-colnote{margin-left:6px;font-size:11px;color:var(--dsw-alias-state-business-primary);opacity:.9}',
			'.gbt-reportcard{border:1px solid var(--dsw-alias-state-business-primary)}',
			// T-144: the report body is a paper that expands with the page; the <pre>
			// window (max-height 320px / EXCERPT) is gone. Only the fallback keeps pre.
			'.gbt-reportbody{white-space:pre-wrap}',
			'.gbt-reporttable{width:100%;border-collapse:collapse;font-size:12px;margin-top:6px}',
			'.gbt-reporttable th,.gbt-reporttable td{border-bottom:1px solid var(--dsw-alias-border-l3,var(--dsw-alias-border-l4));padding:4px 6px;text-align:left;vertical-align:top}',
			'.gbt-reporttable th{font-weight:600;color:var(--dsw-alias-label-secondary)}',
			'.gbt-reporttail{margin:0;max-height:120px;overflow:auto;white-space:pre-wrap;font-size:11px}',
			'.gbt-reportartifacts{margin:4px 0 0;padding-left:18px;font-size:12px}',
			// T-144: casebook (investigation detail) — index aside + report paper.
			'.gbt-casebook{display:grid;grid-template-columns:minmax(240px,280px) minmax(0,1fr);gap:14px;align-items:start;min-width:0}',
			'.gbt-caseindex{display:flex;flex-direction:column;gap:10px;min-width:0;padding:10px 12px;border:1px solid var(--dsw-alias-border-l4);border-radius:8px;background:var(--dsw-alias-bg-layer-1)}',
			'.gbt-caseindexhead{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:12px;color:var(--dsw-alias-label-primary)}',
			'.gbt-casefacts{display:grid;grid-template-columns:auto minmax(0,1fr);gap:3px 8px;margin:0;font-size:11px}',
			'.gbt-casefacts dt{color:var(--dsw-alias-label-tertiary)}',
			'.gbt-casefacts dd{margin:0;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}',
			'.gbt-caseindex .gbt-detailevents{padding:0}',
			'.gbt-casefile{font-size:11px;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}',
			'.gbt-casepaper{display:flex;flex-direction:column;gap:8px;min-width:0;padding:12px 14px;border:1px solid var(--dsw-alias-border-l4);border-radius:8px;background:var(--dsw-alias-bg-layer-1)}',
			'.gbt-reportheading{margin:10px 0 4px;font-family:Georgia,"Times New Roman",serif;font-weight:600;color:var(--dsw-alias-label-primary)}',
			'h3.gbt-reportheading{font-size:16px}',
			'h4.gbt-reportheading{font-size:14px}',
			'.gbt-reportpara{margin:0 0 8px;white-space:pre-wrap;line-height:1.65;font-size:12.5px;color:var(--dsw-alias-label-primary)}',
			'.gbt-reportlist{margin:0 0 8px;padding-left:20px;font-size:12.5px;line-height:1.6;color:var(--dsw-alias-label-primary)}',
			'.gbt-reportcode{max-width:100%;margin:0 0 8px;padding:8px 10px;border:0.5px solid var(--dsw-alias-border-l4);border-radius:8px;background:var(--dsw-alias-bg-layer-3);overflow-x:auto;white-space:pre;font-size:11.5px;color:var(--dsw-alias-label-primary)}',
			'.gbt-reportcode code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace}',
			// T-147: pipe tables, inline code, quotes and ordered lists in a report.
			'.gbt-reporttablescroll{max-width:100%;overflow-x:auto;margin:0 0 8px}',
			'.gbt-reportmdtable{width:100%;margin:0;border-collapse:collapse;font-size:12px}',
			'.gbt-reportmdtable th,.gbt-reportmdtable td{border-bottom:0.5px solid var(--dsw-alias-border-l4);padding:4px 8px;vertical-align:top}',
			'.gbt-reportmdtable th{font-weight:600;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2)}',
			'.gbt-reportinline{padding:0 3px;border-radius:4px;background:var(--dsw-alias-bg-layer-2);font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:0.95em}',
			'.gbt-reportquote{margin:0 0 8px;padding:2px 10px;border-left:2px solid var(--dsw-alias-border-l4);color:var(--dsw-alias-label-secondary);font-size:12.5px;line-height:1.6}',
			'@media (max-width:900px){.gbt-casebook{grid-template-columns:1fr}.gbt-caseindex{flex-direction:row;flex-wrap:wrap;align-items:flex-start}.gbt-caseindex .gbt-casefacts{flex:1 1 220px}.gbt-caseindex .gbt-detailevents{flex:1 1 260px}}',

			'.gbt-empty{padding:26px 12px;text-align:center;color:var(--dsw-alias-label-tertiary);font-size:12px;border:0.5px dashed var(--dsw-alias-border-l4);border-radius:10px;margin:6px}',
			'.gbt-rowlist{display:flex;flex-direction:column;gap:6px}',
			'.gbt-row{display:grid;grid-template-columns:34px 64px minmax(0,1fr) auto;gap:10px;align-items:center;padding:8px 10px;border:0.5px solid var(--dsw-alias-border-l4);border-radius:9px;background:var(--dsw-alias-bg-layer-3);cursor:pointer}',
			'.gbt-row:hover{border-color:var(--dsw-alias-state-business-primary)}',
			'.gbt-order{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px;color:var(--dsw-alias-label-tertiary);text-align:right}',
			'.gbt-rowtitle{font-size:12px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
			'.gbt-rowmeta{display:flex;gap:5px;flex-wrap:wrap;justify-content:flex-end;align-items:center}',
			'.gbt-section{margin:0 0 14px}',
			'.gbt-section h3{margin:0 0 6px;font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:var(--dsw-alias-label-tertiary);font-weight:600}',
			'.gbt-prose{margin:0;white-space:pre-wrap;word-break:break-word;font-size:12px;color:var(--dsw-alias-label-secondary);line-height:1.55}',
			'.gbt-outputblock{margin-top:8px}',
			'.gbt-subhead{margin:8px 0 4px;font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:var(--dsw-alias-label-tertiary);font-weight:600}',
			'.gbt-output{margin:0;padding:8px 9px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);border:0.5px solid var(--dsw-alias-border-l4);font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:10px;line-height:1.5;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;word-break:break-word;max-height:220px;overflow:auto}',
									'.gbt-drawerhead{display:flex;align-items:flex-start;gap:8px;padding:14px 14px 10px;border-bottom:0.5px solid var(--dsw-alias-border-l4)}',
			'.gbt-drawertitle{margin:0;font-size:14px;font-weight:600;line-height:1.4;flex:1;word-break:break-word}',
			'.gbt-drawerbody{overflow:auto;padding:14px;display:flex;flex-direction:column;gap:14px}',
			'.gbt-actions{display:flex;gap:6px;flex-wrap:wrap}',
			'.gbt-meta{display:grid;grid-template-columns:auto 1fr;gap:4px 12px;font-size:11px;margin:0}',
			'.gbt-meta dt{color:var(--dsw-alias-label-tertiary)}',
			'.gbt-meta dd{margin:0;color:var(--dsw-alias-label-secondary);font-family:ui-monospace,SFMono-Regular,Consolas,monospace;word-break:break-all}',
			'.gbt-timeline{display:flex;flex-direction:column;gap:6px;border-left:1px solid var(--dsw-alias-border-l4);padding-left:11px;margin-left:3px}',
			'.gbt-event{position:relative;font-size:11px;color:var(--dsw-alias-label-tertiary);line-height:1.5}',
			'.gbt-event:before{content:"";position:absolute;left:-15px;top:5px;width:5px;height:5px;border-radius:50%;background:var(--dsw-alias-border-l3,var(--dsw-alias-border-l4))}',
			'.gbt-event b{color:var(--dsw-alias-label-secondary);font-weight:500}',
			'.gbt-locktable{width:100%;border-collapse:collapse;font-size:11px}',
			'.gbt-locktable th{text-align:left;font-weight:500;color:var(--dsw-alias-label-tertiary);padding:6px 8px;border-bottom:0.5px solid var(--dsw-alias-border-l4);position:sticky;top:0;background:var(--dsw-alias-bg-layer-2);z-index:1}',
			'.gbt-locktable td{padding:6px 8px;border-bottom:0.5px solid var(--dsw-alias-border-l4);vertical-align:middle;color:var(--dsw-alias-label-secondary)}',
			'.gbt-mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px}',
			'.gbt-overlay{position:fixed;inset:0;background:rgba(15,18,24,.42);display:grid;place-items:center;z-index:100;padding:20px}',
			'.gbt-modal{width:min(580px,100%);max-height:86vh;overflow:auto;background:var(--dsw-alias-bg-layer-2);border:0.5px solid var(--dsw-alias-border-l4);border-radius:14px;box-shadow:0 24px 80px rgba(0,0,0,.22),0 2px 8px rgba(0,0,0,.08);padding:18px}',
			'.gbt-modalhead{display:flex;align-items:flex-start;gap:10px;margin-bottom:2px}',
			'.gbt-modalhead h2{margin:0;font-size:15px;font-weight:600;flex:1}',
			// T-195: the host-decision modal. One foregrounded question; the queue
			// count, the server countdown and the default badge are the only
			// additions over the shared modal shell.
			'.gbt-decisionoverlay{position:fixed;inset:0;background:rgba(15,18,24,.48);display:grid;place-items:center;z-index:120;padding:20px}',
			'.gbt-decision{width:min(560px,100%);max-height:86vh;overflow:auto;background:var(--dsw-alias-bg-layer-2);border:0.5px solid var(--dsw-alias-border-l4);border-radius:14px;box-shadow:0 24px 80px rgba(0,0,0,.24),0 2px 8px rgba(0,0,0,.08);padding:18px}',
			'.gbt-decisionhead{display:flex;align-items:flex-start;gap:10px}',
			'.gbt-decisionhead h2{margin:0;font-size:15px;font-weight:600;flex:1}',
			'.gbt-decisionsub{margin:2px 0 0;font-size:11.5px;color:var(--dsw-alias-label-secondary);word-break:break-word}',
			'.gbt-decisioncountdown{margin:8px 0 0;font-size:11.5px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}',
			'.gbt-decisionqueue{margin:2px 0 0;font-size:11px;color:var(--dsw-alias-label-tertiary)}',
			// T-215: a writeFiles path is one unbroken token. The body keeps pre-wrap
			// (host line breaks survive) and may break anywhere, so the 368px dock can
			// never push text past its inline edge.
			'.gbt-decisionbody{margin:10px 0 0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word;max-width:100%;min-width:0}',
			'.gbt-decisionoptions{display:flex;flex-direction:column;gap:6px;margin:12px 0 0}',
			'.gbt-decisionoption{display:flex;align-items:flex-start;gap:8px;text-align:left;padding:9px 10px;border:0.5px solid var(--dsw-alias-border-l4);border-radius:9px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:1.45;cursor:pointer;min-width:0}',
			'.gbt-decisionoption:hover{border-color:var(--dsw-alias-state-business-primary)}',
			'.gbt-decisionoption[data-selected="true"]{border-color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-bg-module-platform)}',
			'.gbt-decisionoption[data-danger="true"]{border-color:var(--dsw-alias-state-error,#d9534f)}',
			'.gbt-decisionoption:disabled{opacity:.55;cursor:not-allowed}',
			'.gbt-decisionoptionbody{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1;max-width:100%;overflow-wrap:anywhere;word-break:break-word}',
			'.gbt-decisionoptionlabel{font-weight:600;min-width:0;max-width:100%;overflow-wrap:anywhere;word-break:break-word}',
			'.gbt-decisionoptiondesc{font-size:11px;color:var(--dsw-alias-label-tertiary);line-height:1.5;min-width:0;max-width:100%;overflow-wrap:anywhere;word-break:break-word}',
			'.gbt-decisionbadge{font-size:9.5px;line-height:1;padding:3px 5px;border-radius:999px;border:0.5px solid var(--dsw-alias-border-l4);color:var(--dsw-alias-label-tertiary);flex:0 0 auto;align-self:center}',
			'.gbt-decisiontext{display:flex;flex-direction:column;gap:4px;margin:12px 0 0;font-size:11px;color:var(--dsw-alias-label-tertiary)}',
			'.gbt-decisionhighrisk{margin:10px 0 0;display:flex;flex-direction:column;gap:4px;font-size:11px;color:var(--dsw-alias-label-secondary)}',
			'.gbt-decisionhighriskin{margin:0;width:160px;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;letter-spacing:.08em}',
			'.gbt-decisionfoot{display:flex;gap:8px;justify-content:flex-end;align-items:center;margin:14px 0 0;flex-wrap:wrap}',
			'.gbt-decisionfoot .gbt-muted{flex:1 1 auto;min-width:0}',
			// T-208: the conversation-page shell overlay. The chip anchors at the
			// centre column's inline end; the docked card grows upwards and is
			// capped by the measured max-height so it never leaves the viewport.
			'.gbt-decisiondock{position:absolute;right:12px;bottom:16px;z-index:21;pointer-events:auto;display:flex;flex-direction:column;align-items:flex-end;gap:8px;max-width:calc(100vw - 24px)}',
			// Two classes on purpose: .gbt-chipbtn is declared later in this sheet, so
			// the chip must out-rank it rather than rely on source order.
			'.gbt-chipbtn.gbt-decisionchip{border-color:var(--dsw-alias-state-warn-primary);background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-state-warn-label);font-weight:600;height:30px}',
			'.gbt-chipbtn.gbt-decisionchip:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
			'.gbt-decisionchipdot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-warn-primary);flex:0 0 auto}',
			// T-211: the card is capped TWICE — the measured inline max-height from
			// computePlacement (visible layer area) and this CSS fallback for a shell
			// whose geometry cannot be measured. Either way the body scrolls inside
			// the card; nothing is clipped by the shell at 637px height.
			// T-215: the panel's containing block is the shrink-to-fit dock (chip-sized),
			// so a percentage max-width would collapse the card to the chip width. The
			// viewport-bound cap keeps the 368px width while never exceeding the screen.
			// No overflow-x:hidden: the wrap rules must do the work, not a silent clip.
			'.gbt-decisiondockpanel{position:absolute;right:0;bottom:calc(100% + 8px);width:min(368px,calc(100vw - 24px));max-width:calc(100vw - 24px);min-width:0;box-sizing:border-box;max-height:min(520px,72vh,calc(100vh - 96px));overflow-y:auto;overflow-x:auto;overflow-wrap:anywhere;word-break:break-word;border-radius:14px;pointer-events:auto;overscroll-behavior:contain}',
			// T-215: border-box is the actual horizontal fix — content-box made the card
			// 2*14px wider than the panel, so the right border and the last characters
			// of every line were clipped by the panel edge.
			'.gbt-decision.gbt-decisioncompact{box-sizing:border-box;width:100%;max-width:100%;min-width:0;max-height:none;overflow:visible;padding:14px;overflow-wrap:anywhere;word-break:break-word;box-shadow:var(--dsw-shadow-lv2)}',
			// T-211: the one-shot attention pulse for a NEW pending decision. One
			// iteration only (never infinite), no shake; the data marker is also the
			// test hook. 'static' is the reduced-motion / card-open highlight.
			'.gbt-decisionheaderchip{flex:0 0 auto}',
			'.gbt-decisiondock[data-decision-attention="play"] .gbt-decisionchip{animation:gbt-decisionattn 600ms cubic-bezier(.2,.7,.3,1) 1}',
			'.gbt-decisiondock[data-decision-attention="static"] .gbt-decisionchip{box-shadow:0 0 0 2px var(--dsw-alias-state-warn-primary)}',
			// The tiny enlarge uses the standalone 'scale' property rather than a layout
			// transform: the roles layout guard forbids scale/zoom hacks on the panel CSS,
			// and this keeps that guard meaningful while the chip still goes 1 -> 1.04 -> 1.
			'@keyframes gbt-decisionattn{0%{scale:1;box-shadow:0 0 0 0 var(--dsw-alias-state-warn-primary)}40%{scale:1.04;box-shadow:0 0 0 3px var(--dsw-alias-state-warn-primary)}100%{scale:1;box-shadow:0 0 0 5px transparent}}',
			'@media (prefers-reduced-motion: reduce){.gbt-decisiondock[data-decision-attention="play"] .gbt-decisionchip{animation:none;box-shadow:0 0 0 2px var(--dsw-alias-state-warn-primary)}}',
			'.gbt-decisionclose{appearance:none;border:0;background:none;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:16px;line-height:1;cursor:pointer;padding:2px 5px;border-radius:6px;flex:0 0 auto;margin-left:-2px}',
			'.gbt-decisionclose:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
			'.gbt-decisionerror{margin:10px 0 0;font-size:11.5px;line-height:1.5;color:var(--dsw-alias-state-error-primary);word-break:break-word}',
			'.gbt-form{display:flex;flex-direction:column;gap:10px;margin-top:12px}',
'.gbt-rhead{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:0 0 10px}',
'.gbt-rtitle{margin:0;font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary)}',
'.gbt-rbody{display:flex;flex-direction:column;gap:10px;min-width:0}',
'.gbt-tablewrap{overflow-x:auto;width:100%;min-width:0}',
'.gbt-roleprofiles{table-layout:auto;min-width:920px}',
'.gbt-roleprofiles .gbt-input{width:100%;min-width:0;box-sizing:border-box}',
'.gbt-rowactions{display:flex;gap:6px;justify-content:flex-end;flex-wrap:wrap;align-items:center}',
'.gbt-formgrid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;align-items:start}',
'.gbt-formgrid > label{display:flex;flex-direction:column;gap:4px;font-size:11px;color:var(--dsw-alias-label-tertiary);min-width:0}',
'.gbt-formgrid > label > input,.gbt-formgrid > label > select,.gbt-formgrid > label > textarea{width:100%;box-sizing:border-box}',
'.gbt-formwide{grid-column:1 / -1}',
'.gbt-formactions{grid-column:1 / -1;display:flex;justify-content:flex-end;gap:6px}',
'.gbt-actionbar{display:flex;gap:6px;justify-content:flex-end;flex-wrap:wrap;margin:0 0 12px}',
'.gbt-preview{border:0.5px solid var(--dsw-alias-border-l4);border-radius:6px;padding:8px 10px;margin:0 0 8px;background:var(--dsw-alias-bg-layer-1)}',
'.gbt-preview summary{cursor:pointer;font-size:11px;font-weight:500;color:var(--dsw-alias-label-primary)}',
'.gbt-preview .gbt-rbody{padding-top:8px}',
'.gbt-previewprompt{font-size:11px;color:var(--dsw-alias-label-secondary);margin:0 0 8px}',
'.gbt-previewentry{margin:0 0 8px}',
'.gbt-previewtext{max-height:240px;overflow:auto;white-space:pre-wrap;word-break:break-word;font-family:var(--dsw-font-mono,monospace);font-size:10px;line-height:1.55;background:var(--dsw-alias-bg-layer-2);border-radius:6px;padding:8px;margin:4px 0 0;color:var(--dsw-alias-label-secondary)}',
'.gbt-forknote{font-size:11px;color:var(--dsw-alias-label-tertiary);margin:0 0 8px}',
'@media (max-width: 720px){.gbt-formgrid{grid-template-columns:repeat(2,minmax(0,1fr))}.gbt-roleprofiles{min-width:760px}}',
'.gbt-roleeditor{display:flex;flex-direction:column;gap:10px;min-width:0}',
'.gbt-editor-identity{display:flex;gap:6px;flex-wrap:wrap;align-items:center}',
												'.gbt-prompthead{display:flex;gap:6px;flex-wrap:wrap;align-items:center;justify-content:space-between;min-width:0}',
			'.gbt-promptempty{display:flex;flex-direction:column;gap:8px;align-items:flex-start;font-size:11px;line-height:1.6;color:var(--dsw-alias-label-tertiary);border:0.5px dashed var(--dsw-alias-border-l4);border-radius:6px;padding:12px}',
			'.gbt-prompttext{display:flex;flex-direction:column;gap:2px;max-height:420px;overflow:auto;padding-right:2px}',
			'.gbt-promptsection{display:flex;flex-direction:column;gap:2px;min-width:0}',
			'.gbt-sectlabel{align-self:flex-start;font-size:11px;letter-spacing:.04em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-bg-layer-2);border-radius:999px;padding:0 6px;margin:4px 0 0}',
			'.gbt-promptpre{margin:0 0 4px;white-space:pre-wrap;word-break:break-word;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;line-height:1.7;color:var(--dsw-alias-label-secondary)}',
			'.gbt-builtinprompt{max-height:320px;overflow:auto;border:0.5px solid var(--dsw-alias-border-l4);border-radius:6px;padding:8px;background:var(--dsw-alias-bg-layer-2);margin:0}',
			'.gbt-promptactions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}',
			'.gbt-editorarea{min-height:160px;font-family:var(--dsw-font-mono,monospace);font-size:11px;line-height:1.55;height:auto}',
'.gbt-editorskills{display:flex;gap:8px;align-items:flex-end}',
'.gbt-editorskills-field{display:flex;flex-direction:column;gap:4px;font-size:11px;color:var(--dsw-alias-label-tertiary);flex:1;min-width:0}',
'.gbt-skillrow{display:flex;align-items:center;gap:6px;padding:3px 0}',
'.gbt-skillrow span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
'.gbt-segmented{display:inline-flex;gap:2px;padding:3px;border:0.5px solid var(--dsw-alias-border-l4);border-radius:10px;background:var(--dsw-alias-bg-layer-3);flex-wrap:wrap}',
'.gbt-seg{appearance:none;border:none;border-bottom:2px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;padding:5px 14px;border-radius:8px;cursor:pointer;min-width:64px}',
'.gbt-seg:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
'.gbt-seg:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}',
'.gbt-seg[aria-selected="false"]{opacity:.7}',
'.gbt-seg[aria-selected="true"]{background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary);font-weight:600;border-bottom-color:var(--dsw-alias-state-business-primary)}',
'.gbt-editor-select{display:inline-flex;align-items:center;gap:6px;font-size:11px;color:var(--dsw-alias-label-tertiary)}',
'.gbt-editor-select .gbt-input{width:auto;min-width:170px;height:30px}',
'.gbt-rolesview .gbt-subhead,.gbt-rolesview .gbt-footnote,.gbt-rolesview .gbt-pill{font-size:11px}',
'.gbt-detailoverlay{position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;padding:24px}',
'.gbt-detailmask{position:absolute;inset:0;background:rgba(0,0,0,.45)}',
'.gbt-detailpanel{position:relative;display:flex;flex-direction:column;width:calc(100% - 48px);max-width:1080px;height:auto;max-height:90vh;overflow:hidden;border:1px solid var(--line,var(--dsw-alias-border-l4));border-radius:8px;background:var(--panel,var(--dsw-alias-bg-layer-1));box-shadow:0 24px 64px rgba(0,0,0,.35)}',
'.gbt-detailpanel .gbt-drawerhead{flex:0 0 auto;border-bottom:1px solid var(--line,var(--dsw-alias-border-l4))}',
'.gbt-detailpanel .gbt-drawerbody{flex:1 1 auto;min-height:0;overflow:auto;padding-bottom:4px}',
'.gbt-detailpanel .gbt-detailbody{display:grid;grid-template-columns:minmax(0,1fr) 360px;gap:14px;align-items:start;min-width:0}',
'.gbt-detailpanel .gbt-detailmain{display:flex;flex-direction:column;gap:12px;min-width:0}',
'.gbt-detailpanel .gbt-detailaside{display:flex;flex-direction:column;gap:12px;width:360px;max-width:100%;min-width:0}',
'.gbt-detailpanel .gbt-detailaside .gbt-detailsummary{margin:0}',
'.gbt-detailpanel .gbt-detailbody[data-detail-layout="single"]{grid-template-columns:minmax(0,1fr)}',
'.gbt-detailpanel .gbt-detailbody[data-detail-layout="single"] .gbt-detailaside{width:100%;max-width:none}',
'.gbt-detailspec .gbt-detailspecbody{padding:10px 12px;min-width:0}',
'.gbt-detailspec .gbt-detailspecbody .gbt-prose{font-size:13px;line-height:1.7;max-width:none;white-space:pre-wrap}',
'.gbt-detailspec .gbt-detailspecbody .gbt-subhead{margin-top:10px}',
'.gbt-detailhistory .gbt-detailcardbody{padding:10px 12px;min-width:0}',
'.gbt-detailfooter{flex:0 0 auto;display:flex;flex-direction:column;gap:8px;padding:10px 14px calc(10px + env(safe-area-inset-bottom,0px));border-top:1px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-3);z-index:2}',
'.gbt-detailnote{display:flex;flex-direction:column;gap:4px;font-size:11px;color:var(--dsw-alias-label-secondary);min-width:0}',
'.gbt-detailnote .gbt-input{width:100%;box-sizing:border-box}',
'.gbt-detailfooter .gbt-actions{flex-wrap:wrap;margin:0}',
'.gbt-detailpanel .gbt-detailbody[data-detail-layout="compact"]{grid-template-columns:minmax(0,1fr) 360px}',
'.gbt-detailpanel .gbt-detailbody[data-detail-layout="compact"] .gbt-detailaside{width:360px}',
'@media (max-width:900px){.gbt-detailpanel .gbt-detailbody{grid-template-columns:minmax(0,1fr)}.gbt-detailpanel .gbt-detailaside{width:auto}.gbt-detailfooter{padding:8px 12px calc(8px + env(safe-area-inset-bottom,0px))}.gbt-detailfooter .gbt-actions{justify-content:flex-start}}',
'.gbt-detailbody[data-detail-layout="two-column"]{display:grid;grid-template-columns:minmax(0,1fr) 280px;gap:12px;align-items:start}',
'.gbt-detailbody[data-detail-layout="compact"]{display:grid;grid-template-columns:minmax(0,1fr) 260px;gap:12px;align-items:start}',
'.gbt-detailbody[data-detail-layout="single"]{display:flex;flex-direction:column;gap:10px}',
'.gbt-detailbody[data-detail-layout="compact"] .gbt-detailevent{flex-wrap:nowrap;overflow-x:auto}',
// T-177: these must beat the legacy 280px two-column rule above. The old
// selector has the same specificity as the base rule but appears later.
'.gbt-detailpanel .gbt-detailbody[data-detail-layout="two-column"]{grid-template-columns:minmax(0,1fr) 360px}',
'.gbt-detailpanel .gbt-detailbody[data-detail-layout="two-column"] .gbt-detailaside{width:360px}',
'.gbt-detailstages{display:grid;grid-template-columns:repeat(5,minmax(64px,1fr));gap:8px;margin:4px 0 2px;overflow-x:auto}',
'.gbt-detailstages[data-detail-stages="wrap"]{grid-template-columns:repeat(3,minmax(64px,1fr));overflow:visible}',
'.gbt-detailsummary-one{flex-direction:row;align-items:baseline;gap:12px;flex-wrap:wrap}',
'.gbt-detailpanel .gbt-btn,.gbt-detailpanel .gbt-linkbtn{white-space:nowrap}',
'.gbt-detailstat b{font-size:13px;font-weight:600}',
'.gbt-detailstat span{font-size:11.5px;color:var(--t3,var(--dsw-alias-label-tertiary))}',
'@media (max-width:899px){.gbt-detailoverlay{padding:0}.gbt-detailpanel{width:100%;max-width:none;height:100%;max-height:100%;border-radius:0;border:0}}',
'.gbt-detailbody{display:grid;grid-template-columns:minmax(0,1fr) 280px;gap:12px;align-items:start}',
'.gbt-detailcard{border:1px solid var(--line,var(--dsw-alias-border-l4));border-radius:8px;background:var(--panel,var(--dsw-alias-bg-layer-1));min-width:0}',
'.gbt-detailcardhead{padding:9px 12px;border-bottom:1px solid var(--line,var(--dsw-alias-border-l4));font-size:12px}',
'.gbt-detailevents{padding:8px 12px;display:flex;flex-direction:column;gap:10px}',
'.gbt-detailevent{display:flex;flex-wrap:wrap;align-items:baseline;gap:8px;font-size:12px}',
'.gbt-detailpill{font-size:11px;padding:1px 7px;border-radius:9px;border:1px solid var(--line2,var(--dsw-alias-border-l4));color:var(--t2,var(--dsw-alias-label-secondary))}',
'.gbt-detailpill[data-tone="ok"]{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}',
'.gbt-detailpill[data-tone="bad"]{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}',
'.gbt-detailwho{color:var(--t2,var(--dsw-alias-label-secondary));font-size:11.5px}',
'.gbt-detailwhen{margin-left:auto;color:var(--t3,var(--dsw-alias-label-tertiary));font-size:11.5px;font-family:var(--mono,monospace)}',
'.gbt-detailex{flex-basis:100%;color:var(--t3,var(--dsw-alias-label-tertiary));font-size:11.5px}',
'.gbt-detailreason{flex-basis:100%;margin-top:2px;padding:7px 9px;border-left:2px solid var(--dsw-alias-state-error-primary);background:var(--dsw-alias-bg-layer-2);border-radius:0 5px 5px 0;font-size:12px;color:var(--t2,var(--dsw-alias-label-secondary));white-space:pre-wrap}',
'.gbt-detailreason.good{border-left-color:var(--dsw-alias-state-success-primary)}',
'.gbt-detailpreview{margin:4px 0 0;padding:8px;background:var(--elev,var(--dsw-alias-bg-layer-2));border-radius:6px;font-size:11.5px;max-height:200px;overflow:auto;white-space:pre-wrap}',
'.gbt-detailstages{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:8px;margin:4px 0 2px}',
'.gbt-detailstage{display:flex;flex-direction:column;gap:5px;font-size:11.5px;color:var(--t2,var(--dsw-alias-label-tertiary))}',
'.gbt-detailstagebar{height:4px;border-radius:2px;background:var(--line2,var(--dsw-alias-border-l4))}',
'.gbt-detailstage[data-state="done"] .gbt-detailstagebar{background:var(--dsw-alias-state-success-primary)}',
'.gbt-detailstage[data-state="active"] .gbt-detailstagebar{background:var(--dsw-alias-state-business-primary)}',
'.gbt-detailstage[data-state="interrupted"] .gbt-detailstagebar{background:var(--dsw-alias-state-error-primary)}',
'.gbt-detailstagelabel{display:flex;gap:6px;align-items:baseline}',
'.gbt-detailstagetime{margin-left:auto;font-family:var(--mono,monospace);font-size:11px}',
'.gbt-detailinterrupt{margin:2px 0 6px;font-size:11.5px;color:var(--dsw-alias-state-error-primary)}',
'.gbt-detailsummary{border:1px solid var(--line,var(--dsw-alias-border-l4));border-radius:8px;background:var(--panel,var(--dsw-alias-bg-layer-1));padding:10px 12px;display:flex;flex-direction:column;gap:8px;font-size:12px}',
'.gbt-detailstat{display:flex;align-items:baseline;gap:6px}',
'.gbt-detailstat b{font-size:13px;font-weight:600}',
'.gbt-detailstat span{font-size:11.5px;color:var(--t3,var(--dsw-alias-label-tertiary))}',
'.gbt-detailstatline{color:var(--t2,var(--dsw-alias-label-secondary));font-size:11.5px}',
'.gbt-detailkv{display:flex;gap:6px;align-items:baseline;font-size:11.5px;color:var(--t2,var(--dsw-alias-label-secondary))}',
'.gbt-detailkv b{color:var(--t1,var(--dsw-alias-label-primary))}',
'.gbt-detailhead{display:flex;flex-direction:column;gap:4px;min-width:0}',
'.gbt-detailmeta{display:flex;gap:12px;flex-wrap:wrap;font-size:11.5px;color:var(--t2,var(--dsw-alias-label-tertiary))}',
'.gbt-detailspan{font-family:var(--mono,monospace)}',
'@media (max-width:900px){.gbt-detailbody{grid-template-columns:1fr}.gbt-detailstages{grid-template-columns:repeat(2,minmax(0,1fr))}}',
'.gbt-statusview{display:flex;flex-direction:column;gap:12px;width:100%;min-width:0;max-width:100%;height:100%;min-height:0;overflow:hidden;box-sizing:border-box}',
'.gbt-statustop{display:flex;align-items:flex-start;gap:12px;min-width:0;max-width:100%;flex-wrap:wrap}',
'.gbt-statussummary{font-size:15px;line-height:1.4;color:var(--t1,var(--dsw-alias-label-primary));min-width:0;overflow-wrap:anywhere}',
'.gbt-statusactions{margin-left:auto;display:flex;gap:8px}',
'.gbt-statusgrid{display:grid;gap:12px;grid-template-columns:minmax(0,1fr) minmax(0,1fr);grid-template-areas:"dispatch dispatch" "sessions worktrees" "agents agents" "activity activity";grid-template-rows:auto minmax(180px,1.15fr) auto minmax(140px,0.72fr);flex:1 1 auto;min-height:0;width:100%;min-width:0;max-width:100%;overflow:hidden;box-sizing:border-box}',
'.gbt-statuscard[data-status-card="dispatch"]{grid-area:dispatch}',
'.gbt-statuscard[data-status-card="sessions"]{grid-area:sessions}',
'.gbt-statuscard[data-status-card="worktrees"]{grid-area:worktrees}',
'.gbt-statuscard[data-status-card="agents"]{grid-area:agents}',
'.gbt-statuscard[data-status-card="activity"]{grid-area:activity}',
'.gbt-statuscard{border:1px solid var(--line,var(--dsw-alias-border-l4));border-radius:8px;background:var(--panel,var(--dsw-alias-bg-layer-1));display:flex;flex-direction:column;min-height:0;min-width:0;width:100%;max-width:100%;overflow:hidden;box-sizing:border-box}',
'.gbt-statuscardhead{display:flex;align-items:center;gap:8px;padding:9px 12px;border-bottom:1px solid var(--line,var(--dsw-alias-border-l4));font-size:12px}',
'.gbt-statusmeta{margin-left:auto;font-size:11.5px;color:var(--t2,var(--dsw-alias-label-tertiary))}',
'.gbt-statuscardbody{padding:10px 12px;min-height:0;flex:1 1 auto;display:flex;flex-direction:column;gap:6px;width:100%;min-width:0;max-width:100%;overflow-x:hidden;overflow-y:auto;overscroll-behavior:contain;box-sizing:border-box}',
'.gbt-statuskvs{display:flex;gap:20px}',
'.gbt-statuskv{display:flex;align-items:baseline;gap:5px}',
'.gbt-statuskv b{font-size:18px;font-weight:600}',
'.gbt-statuskv span{font-size:11.5px;color:var(--t2,var(--dsw-alias-label-tertiary))}',
'.gbt-statuswhy{margin-top:6px;padding:8px 10px;border-radius:6px;background:var(--elev,var(--dsw-alias-bg-layer-2));font-size:12px;color:var(--t2,var(--dsw-alias-label-secondary));line-height:1.55}',
'.gbt-pauseaudit{display:flex;flex-wrap:wrap;align-items:baseline;gap:2px 12px}',
'.gbt-statusscan{margin-top:2px;font-size:11.5px;color:var(--t2,var(--dsw-alias-label-tertiary))}',
'.gbt-statusrow{display:flex;align-items:center;gap:8px;min-height:30px;border-bottom:1px solid var(--line,var(--dsw-alias-border-l4));font-size:12px;min-width:0;max-width:100%}',
'.gbt-statusrow:last-child{border-bottom:0}',
'.gbt-statuswho{flex:none;color:var(--t1,var(--dsw-alias-label-primary))}',
'.gbt-statusrole{width:46px;flex:none;color:var(--t2,var(--dsw-alias-label-tertiary));font-size:11.5px}',
'.gbt-statustask{color:var(--t2,var(--dsw-alias-label-secondary));overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:1 1 auto;max-width:100%}',
'.gbt-statustime{margin-left:auto;flex:none;color:var(--t2,var(--dsw-alias-label-tertiary));font-size:11.5px;white-space:nowrap}',
'.gbt-statusmore{width:18px;flex:none;border:0;background:none;color:var(--t2,var(--dsw-alias-label-tertiary));cursor:pointer;padding:0}',
'.gbt-sessionrow{display:flex;align-items:center;gap:8px;padding:2px 0 4px 0;font-size:11.5px}',
'.gbt-statusfold{display:flex;align-items:center;gap:6px;margin-top:6px;font-size:11.5px;color:var(--t2,var(--dsw-alias-label-tertiary));border-top:1px dashed var(--line,var(--dsw-alias-border-l4));padding-top:7px}',
'.gbt-statusnote{color:var(--t2,var(--dsw-alias-label-tertiary));font-size:11.5px}',
'.gbt-statusev{display:flex;gap:10px;font-size:12px;line-height:1.5;padding:5px 0;min-width:0;max-width:100%}',
'.gbt-statusevtime{width:44px;flex:none;color:var(--t2,var(--dsw-alias-label-tertiary));font-size:11.5px}',
'.gbt-statusevkind{width:52px;flex:none;font-size:11px;color:var(--t2,var(--dsw-alias-label-secondary))}',
'.gbt-statusevtext{color:var(--t1,var(--dsw-alias-label-primary));overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1 1 auto;min-width:0;max-width:100%}',
'.gbt-linkbtn{border:0;background:none;color:var(--dsw-alias-state-business-primary);cursor:pointer;font:inherit;padding:0}',
			// T-143: worktree list + cleanup panel. Tokens only; the list scrolls, the page does not.
			'.gbt-wtview{display:flex;flex-direction:column;gap:6px;min-width:0;width:100%;max-width:100%;box-sizing:border-box}',
			'.gbt-wtbatch{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:2px}',
			'.gbt-wtsectionhead{margin-top:4px;padding-top:6px;border-top:0.5px solid var(--dsw-alias-border-l4);font-size:11px;font-weight:500;color:var(--dsw-alias-label-tertiary)}',
			'.gbt-wtlines{display:flex;flex-direction:column;min-width:0;width:100%;max-width:100%;max-height:260px;overflow-x:hidden;overflow-y:auto;box-sizing:border-box}',
			'.gbt-wtrow{display:flex;align-items:center;gap:6px 10px;flex-wrap:wrap;min-width:0;max-width:100%;padding:5px 2px;border-bottom:0.5px solid var(--dsw-alias-border-l4);font-size:11.5px;box-sizing:border-box}',
			'.gbt-wtlabel{display:inline-flex;align-items:center;gap:5px;min-width:0;color:var(--dsw-alias-label-primary)}',
			'.gbt-wtlabel b{font-weight:600;font-family:ui-monospace,SFMono-Regular,Consolas,monospace}',
			'.gbt-wtpath,.gbt-wtbranch{min-width:0;flex:1 1 90px;max-width:210px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary)}',
			'.gbt-wtsha{flex:none;color:var(--dsw-alias-label-tertiary)}',
			'.gbt-wtbadges{display:inline-flex;align-items:center;gap:4px;flex:1 1 100%;justify-content:flex-start;flex-wrap:wrap;min-width:0;max-width:100%}',
			'.gbt-wtactions{display:inline-flex;align-items:center;gap:5px;flex:1 1 100%;justify-content:flex-end;min-width:0;flex-wrap:wrap;white-space:normal;max-width:100%}',
			'.gbt-wtactions .gbt-btn{white-space:nowrap;flex:none}',
			'.gbt-wtactions .gbt-statusnote{flex:1 1 100%;min-width:0;white-space:normal;overflow-wrap:anywhere;text-align:left}',
			'.gbt-wtactions .gbt-btn{height:24px;padding:0 8px;font-size:11px}',
			'.gbt-wtpreview,.gbt-wtresult{margin-top:6px;padding:6px 8px;border:0.5px solid var(--dsw-alias-border-l4);border-radius:8px;background:var(--dsw-alias-bg-layer-2);font-size:11.5px;color:var(--dsw-alias-label-secondary)}',
			'.gbt-wtpreviewrow{max-width:100%;min-width:0;padding:1px 0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
			'.gbt-wtresult[data-wt-result="error"]{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}',
'@media (max-width:900px){.gbt-statusview{height:auto;min-height:0;overflow:visible}.gbt-statusgrid{grid-template-columns:minmax(0,1fr);grid-template-areas:"dispatch" "sessions" "worktrees" "agents" "activity";grid-template-rows:auto;flex:0 0 auto;height:auto;min-height:0;overflow:visible}.gbt-statuscard{overflow:visible}.gbt-statuscardbody{flex:0 0 auto;overflow-x:visible;overflow-y:visible}}',
'.gbt-shiftdeck{--deck-bg:var(--tc-bg);--deck-panel:var(--tc-panel);--deck-panel2:var(--tc-panel2);--deck-line:var(--tc-line);--deck-text:var(--tc-text);--deck-muted:var(--tc-muted);--deck-dim:var(--tc-dim);--deck-lime:var(--tc-accent);--deck-amber:var(--tc-amber);--deck-cyan:var(--tc-cyan);--deck-red:var(--tc-red)}',
'.gbt-statusview.gbt-shiftdeck{display:flex;flex-direction:column;gap:0;width:100%;min-width:0;max-width:100%;height:100%;min-height:0;overflow:hidden;box-sizing:border-box;background:var(--deck-bg);color:var(--deck-text)}',
'.gbt-deckhead{display:flex;align-items:center;gap:14px;height:44px;min-height:44px;padding:0 14px;border-bottom:1px solid var(--deck-line);background:var(--deck-panel);min-width:0;flex-wrap:nowrap}',
'.gbt-deckeyebrow{font-size:10px;letter-spacing:.13em;color:var(--deck-dim);text-transform:uppercase;white-space:nowrap;font-family:ui-monospace,SFMono-Regular,Consolas,monospace}',
'.gbt-deckhead h1{font-size:15px;margin:0;font-weight:600;letter-spacing:.04em;white-space:nowrap}',
'.gbt-deckheadcrumb{font-size:11px;color:var(--deck-dim);border-left:1px solid var(--deck-line);padding-left:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}',
'.gbt-deckhead .gbt-statusactions{margin-left:auto;display:flex;align-items:center;gap:12px;font-size:11px;color:var(--deck-muted);flex:none}',
'.gbt-decklastscan{white-space:nowrap;color:var(--deck-dim)}',
'.gbt-deckhead .gbt-btn{background:none;color:var(--deck-muted);border:1px solid var(--deck-line);padding:4px 9px;border-radius:3px;font:inherit;font-size:11px}',
'.gbt-deckgrid{display:grid;grid-template-columns:260px minmax(0,1fr) 420px;grid-template-areas:"rail sessions worktrees" "rail activity activity";grid-template-rows:minmax(0,1fr) 172px;gap:1px;background:var(--deck-line);flex:1 1 auto;min-height:0;width:100%;min-width:0;max-width:100%;overflow:auto;box-sizing:border-box}',
'.gbt-shiftdeck .gbt-statuscard{border:0;border-radius:0;background:var(--deck-panel);color:var(--deck-text);min-height:0;min-width:0;overflow:hidden;box-shadow:none}',
'.gbt-deckrail{grid-area:rail;display:flex;flex-direction:column;gap:1px;min-height:0;min-width:0;overflow:auto;background:var(--deck-line)}',
'.gbt-deckdispatch{flex:0 0 auto;padding:13px 14px 11px;display:flex;flex-direction:column;gap:0;min-width:0;overflow:hidden}',
'.gbt-decklabel{display:flex;align-items:center;gap:7px;font-size:10px;letter-spacing:.12em;color:var(--deck-dim);text-transform:uppercase;min-width:0;font-family:ui-monospace,SFMono-Regular,Consolas,monospace}',
'.gbt-decklabelzh{font-size:11px;letter-spacing:0;color:var(--deck-muted);text-transform:none;font-family:inherit}',
'.gbt-decklabel em{margin-left:auto;font-style:normal;color:var(--deck-lime);font-size:10px;letter-spacing:.08em;white-space:nowrap}',
'.gbt-decklabel em[data-running="false"]{color:var(--deck-amber)}',
'.gbt-deckbig{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:44px;line-height:1;letter-spacing:-.06em;margin:12px 0 2px;font-variant-numeric:tabular-nums}',
'.gbt-deckbig small{font-size:17px;color:var(--deck-dim);letter-spacing:0}',
'.gbt-deckbar{height:4px;display:flex;gap:2px;background:var(--tc-track);margin:9px 0 7px}',
'.gbt-deckbar i{flex:1;display:block;background:var(--tc-track)}',
'.gbt-deckbar i[data-on="true"]{background:var(--deck-lime)}',
'.gbt-decknote{margin:6px 0 0;color:var(--deck-muted);font-size:11px;line-height:1.5;min-width:0;overflow-wrap:anywhere}',
'.gbt-pauseaudit{display:flex;flex-wrap:wrap;align-items:baseline;gap:2px 12px;margin-top:7px;padding:6px 0 0;border-top:1px solid var(--deck-line);font-size:10.5px;color:var(--deck-muted)}',
'.gbt-deckmetrics{display:grid;grid-template-columns:1fr 1fr;gap:7px 10px;margin:9px 0 0;padding-top:8px;border-top:1px solid var(--deck-line)}',
'.gbt-deckmetric{min-width:0;border-top:1px solid var(--deck-line);padding-top:6px}',
'.gbt-deckmetric b{display:block;font:17px/1 ui-monospace,SFMono-Regular,Consolas,monospace;font-weight:500;letter-spacing:-.04em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
'.gbt-deckmetric span{display:block;color:var(--deck-dim);font-size:10px;margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
'.gbt-deckscanline{font-size:10.5px;color:var(--deck-dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
'.gbt-deckdispatch .gbt-statusscan{font-size:10.5px;color:var(--deck-dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
'.gbt-deckexecutors{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;overflow:hidden;border-top:1px solid var(--deck-line)}',
'.gbt-deckexecutors .gbt-decklabel{flex:none;padding:11px 14px 4px}',
'.gbt-deckpeople{flex:1 1 auto;min-height:0;overflow-y:auto;padding:0 14px 10px}',
'.gbt-deckperson{display:grid;grid-template-columns:7px minmax(0,1fr) auto;gap:8px;align-items:center;padding:7px 0;border-bottom:1px solid var(--deck-line);min-width:0}',
'.gbt-deckdot{width:6px;height:6px;border-radius:50%;display:inline-block;flex:none;background:var(--deck-muted)}',
'.gbt-deckdot[data-on="true"]{background:var(--deck-lime);box-shadow:0 0 0 3px var(--tc-accent-ring)}',
'.gbt-deckpersonmain{min-width:0}',
'.gbt-deckpersonmain b{display:block;font:11.5px ui-monospace,SFMono-Regular,Consolas,monospace;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
'.gbt-deckpersonmain span{display:block;color:var(--deck-dim);font-size:10.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:1px}',
'.gbt-deckrole{color:var(--deck-muted)}',
'.gbt-deckpersonmeta{display:flex;align-items:center;gap:5px;min-width:0}',
'.gbt-deckpersonmeta em{font-style:normal;color:var(--deck-dim);font-size:10px;max-width:92px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:right}',
'.gbt-deckperson .gbt-statusmore{color:var(--deck-dim);background:none;border:0;padding:0;cursor:pointer}',
'.gbt-decksession{grid-column:1 / -1;display:flex;align-items:center;gap:6px;padding-top:4px;font-size:10.5px;color:var(--deck-dim);min-width:0;overflow:hidden}',
'.gbt-decksession code{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}',
'.gbt-deckpeople .gbt-statusrow{display:grid;grid-template-columns:minmax(0,1fr) 46px minmax(0,1fr) auto;gap:6px;align-items:center;border-bottom:1px solid var(--deck-line);min-width:0}',
'.gbt-decksessions{grid-area:sessions;display:flex;flex-direction:column;min-height:0;overflow:hidden}',
'.gbt-deckworktrees{grid-area:worktrees;display:flex;flex-direction:column;min-height:0;overflow:hidden}',
'.gbt-deckpanelhead{display:flex;align-items:center;gap:10px;height:49px;min-height:49px;padding:0 13px;border-bottom:1px solid var(--deck-line);min-width:0}',
'.gbt-deckpanelhead h2{font-size:13px;font-weight:600;margin:0;letter-spacing:.04em;white-space:nowrap}',
'.gbt-deckpanelmeta{margin-left:auto;color:var(--deck-dim);font-size:10.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:52%}',
'.gbt-deckfilter{display:flex;align-items:center;gap:6px;margin-left:8px;color:var(--deck-dim);font-size:10.5px;flex:none}',
'.gbt-deckfilter select{background:var(--deck-panel2);color:var(--deck-text);border:1px solid var(--deck-line);border-radius:2px;font-size:10.5px;padding:2px 4px;max-width:110px}',
'.gbt-deckthead{height:27px;min-height:27px;display:grid;grid-template-columns:minmax(0,1.45fr) 76px 70px 74px 58px 58px;gap:8px;align-items:center;padding:0 13px;border-bottom:1px solid var(--deck-line);color:var(--deck-dim);font-size:10px;letter-spacing:.07em;text-transform:uppercase;font-family:ui-monospace,SFMono-Regular,Consolas,monospace}',
'.gbt-deckthead span:nth-child(n+2){text-align:right}',
'.gbt-deckrows{flex:1 1 auto;min-height:0;overflow-y:auto}',
'.gbt-decksessionrow{min-height:54px;display:grid;grid-template-columns:minmax(0,1.45fr) 76px 70px 74px 58px 58px;gap:8px;align-items:center;padding:0 13px;border-bottom:1px solid var(--deck-line);position:relative;min-width:0}',
'.gbt-decksessionrow.is-current{background:var(--tc-selected)}',
'.gbt-decksessionrow.is-current:before{content:"";position:absolute;left:0;top:0;bottom:0;width:2px;background:var(--deck-lime)}',
'.gbt-decksessionname{min-width:0;display:flex;flex-direction:column;gap:2px;align-items:flex-start}',
'.gbt-decksessionname b{font:12px ui-monospace,SFMono-Regular,Consolas,monospace;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}',
'.gbt-decksessionname span:last-child{max-width:100%;color:var(--deck-dim);font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
'.gbt-decksession-current{width:max-content;color:var(--deck-lime);font:9px ui-monospace,SFMono-Regular,Consolas,monospace;border:1px solid var(--tc-accent-line);padding:1px 4px;letter-spacing:.04em}',
'.gbt-decknum{text-align:right;font:10.5px ui-monospace,SFMono-Regular,Consolas,monospace;color:var(--deck-muted);white-space:nowrap}',
'.gbt-decknum b{color:var(--deck-text);font-weight:500}',
'.gbt-deckstatus,.gbt-deckstate{display:inline-flex;align-items:center;justify-content:flex-end;gap:5px;color:var(--deck-muted);font-size:10.5px;white-space:nowrap;min-width:0;overflow:hidden;text-overflow:ellipsis}',
'.gbt-deckstatus[data-status="live"]{color:var(--deck-lime)}',
'.gbt-deckstatus[data-status="stale"]{color:var(--deck-red)}',
'.gbt-deckstate[data-stage-ready="false"],.gbt-deckstate[data-dispatch-badge="false"]{color:var(--deck-dim)}',
'.gbt-deckempty{color:var(--deck-dim);font-size:11px;padding:10px 13px}',
'.gbt-deckwtview{display:flex;flex-direction:column;min-height:0;flex:1 1 auto}',
'.gbt-deckwtool{display:flex;align-items:center;gap:6px;padding:7px 13px;border-bottom:1px solid var(--deck-line);min-height:36px;flex:none;min-width:0}',
'.gbt-deckwtool .gbt-btn{height:24px;padding:0 8px;font-size:10.5px;white-space:nowrap}',
'.gbt-deckwtoolmeta{margin-left:auto;color:var(--deck-dim);font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
'.gbt-deckwtrows{flex:1 1 auto;min-height:0;overflow-y:auto}',
'.gbt-deckwtgroup{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:7px 13px;border-bottom:1px solid var(--deck-line);color:var(--deck-dim);font-size:10px;letter-spacing:.08em;text-transform:uppercase;font-family:ui-monospace,SFMono-Regular,Consolas,monospace}',
'.gbt-deckwtgroup b{font-weight:400;color:var(--deck-muted)}',
'.gbt-shiftdeck .gbt-deckwtrow{display:grid;grid-template-columns:minmax(0,1fr) 52px 58px auto;gap:6px;align-items:center;padding:8px 13px;border-bottom:1px solid var(--deck-line);min-height:56px;min-width:0}',
'.gbt-shiftdeck .gbt-wtlabel{grid-column:1;grid-row:1;display:flex;align-items:center;gap:5px;min-width:0;overflow:hidden}',
'.gbt-shiftdeck .gbt-wtlabel b{min-width:0;font-size:11.5px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
'.gbt-shiftdeck .gbt-wtpath{grid-column:1;grid-row:2;font:10px ui-monospace,SFMono-Regular,Consolas,monospace;color:var(--deck-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%}',
'.gbt-shiftdeck .gbt-wtbranch{grid-column:1;grid-row:3;font:10px ui-monospace,SFMono-Regular,Consolas,monospace;color:var(--deck-dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%}',
'.gbt-shiftdeck .gbt-wtsha{grid-column:2;grid-row:1 / 4;text-align:right;font:10px ui-monospace,SFMono-Regular,Consolas,monospace;color:var(--deck-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
'.gbt-shiftdeck .gbt-wtbadges{grid-column:3;grid-row:1 / 4;display:flex;flex-direction:column;align-items:flex-end;gap:3px;min-width:0}',
'.gbt-shiftdeck .gbt-wtactions{grid-column:4;grid-row:1 / 4;display:flex;flex-direction:column;align-items:flex-end;gap:3px;min-width:0;white-space:normal}',
'.gbt-shiftdeck .gbt-wtactions .gbt-btn{height:22px;padding:0 6px;font-size:10px}',
'.gbt-shiftdeck .gbt-chip{display:inline-flex;align-items:center;gap:4px;background:none;border:0;padding:0;border-radius:0;color:var(--deck-dim);font-size:10px;white-space:nowrap}',
'.gbt-shiftdeck .gbt-chip:before{content:"";width:5px;height:5px;border-radius:50%;background:currentColor;display:inline-block;flex:none}',
'.gbt-shiftdeck .gbt-chip[data-tone="ready"]{color:var(--deck-lime)}',
'.gbt-shiftdeck .gbt-chip[data-tone="waiting"]{color:var(--deck-amber)}',
'.gbt-shiftdeck .gbt-chip[data-tone="blocked"]{color:var(--deck-red)}',
'.gbt-deckwtview .gbt-wtpreview,.gbt-deckwtview .gbt-wtresult{margin:6px 13px;padding:6px 8px;border:1px solid var(--deck-line);border-radius:2px;background:var(--deck-panel2);font-size:10.5px;color:var(--deck-muted);max-height:110px;overflow:auto}',
'.gbt-deckactivity{grid-area:activity;display:flex;flex-direction:column;min-height:0;overflow:hidden}',
'.gbt-deckactivitybody{flex:1 1 auto;min-height:0;overflow-y:auto;padding:0 13px}',
'.gbt-shiftdeck .gbt-deckarow{display:grid;grid-template-columns:52px 84px minmax(0,1fr);gap:10px;align-items:center;min-height:25px;padding:4px 0;border-bottom:1px solid var(--tc-line-soft);font-size:10.5px;color:var(--deck-muted);min-width:0}',
'.gbt-shiftdeck .gbt-statusevtime{width:auto;font:10px ui-monospace,SFMono-Regular,Consolas,monospace;color:var(--deck-dim);white-space:nowrap}',
'.gbt-shiftdeck .gbt-statusevkind{width:auto;color:var(--deck-lime);font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
'.gbt-shiftdeck .gbt-statusevtext{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;max-width:100%;color:var(--deck-text)}',
'.gbt-shiftdeck .gbt-statusfold{margin:4px 0;border-top:1px dashed var(--deck-line);font-size:10px;color:var(--deck-dim)}',
'.gbt-shiftdeck .gbt-statusnote{color:var(--deck-dim);font-size:10.5px}',
'.gbt-shiftdeck .gbt-btn[data-variant="primary"]{background:var(--deck-lime);border-color:var(--deck-lime);color:var(--tc-accent-ink)}',
'@media (max-width:900px){.gbt-statusview.gbt-shiftdeck{height:auto;min-height:100%;overflow:visible}.gbt-deckgrid{grid-template-columns:minmax(0,1fr);grid-template-areas:"rail" "sessions" "worktrees" "activity";grid-template-rows:auto;flex:0 0 auto;height:auto;min-height:0;overflow:visible}.gbt-deckrail{overflow:visible}.gbt-deckdispatch,.gbt-deckexecutors,.gbt-decksessions,.gbt-deckworktrees{overflow:visible}.gbt-deckpeople,.gbt-deckrows,.gbt-deckwtrows,.gbt-deckactivitybody{overflow:visible}.gbt-deckhead{height:auto;min-height:44px;flex-wrap:wrap;padding:8px 12px}.gbt-deckheadcrumb{display:none}.gbt-deckthead,.gbt-decksessionrow{grid-template-columns:minmax(0,1.4fr) 58px 64px 60px 52px 52px;padding:0 10px}.gbt-deckactivity{min-height:0}.gbt-deckpanelhead,.gbt-deckwtool{padding:0 10px}.gbt-deckwtoolmeta{display:none}}',
'.gbt-decksessiondetail{display:none}',
'@media (min-width:1800px){.gbt-deckgrid{grid-template-areas:"rail sessions worktrees" "rail detail worktrees" "rail activity worktrees";grid-template-rows:auto auto minmax(172px,1fr);height:100%}.gbt-decksessions{grid-area:sessions;overflow:hidden;height:454px;max-height:454px}.gbt-decksessions .gbt-deckrows{flex:1 1 auto;min-height:0;overflow-y:auto;max-height:none}.gbt-decksessiondetail{grid-area:detail;display:flex;flex-direction:column;min-height:290px;max-height:290px;height:290px;min-width:0;overflow:hidden;background:var(--deck-panel)}.gbt-deckworktrees{grid-area:worktrees;grid-row:1 / 4}.gbt-deckactivity{grid-area:activity;min-height:172px;height:100%;align-self:stretch}}',
'.gbt-detailbody{flex:1 1 auto;min-height:0;display:grid;grid-template-columns:minmax(0,1.2fr) minmax(0,.85fr) minmax(0,1fr);grid-template-rows:auto;align-content:start;gap:10px 12px;padding:12px;min-width:0}',
'.gbt-detailidentity{display:flex;flex-direction:column;gap:6px;min-width:0;padding-right:12px;border-right:1px solid var(--deck-line)}',
'.gbt-detailidentityline{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;min-width:0}',
'.gbt-detailidentityline b{font-size:22px;line-height:1;letter-spacing:-.04em;font-weight:500}',
'.gbt-detailcurrent{font:9.5px ui-monospace,SFMono-Regular,Consolas,monospace;color:var(--deck-lime);border:1px solid var(--tc-accent-line);padding:1px 5px;white-space:nowrap}',
'.gbt-detailstatus{display:inline-flex;align-items:center;gap:5px;color:var(--deck-muted);font-size:10.5px;white-space:nowrap}',
'.gbt-detailid{color:var(--deck-dim);font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%}',
'.gbt-detailteamcount{color:var(--deck-muted);font-size:10.5px;margin-top:2px}',
'.gbt-detailfacts{display:grid;grid-template-columns:1fr 1fr;gap:8px 12px;min-width:0;padding:8px 12px 0 0;border-top:1px solid var(--deck-line);border-right:1px solid var(--deck-line)}',
'.gbt-detailfact{min-width:0;border-top:0;padding-top:0}',
'.gbt-detailpreview{font-size:9px;color:var(--deck-dim);letter-spacing:.06em;text-transform:uppercase;white-space:nowrap}',
'.gbt-detailfact b{display:block;font:11px ui-monospace,SFMono-Regular,Consolas,monospace;font-weight:400;color:var(--deck-text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
'.gbt-detailfact span{display:block;color:var(--deck-dim);font-size:9.5px;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
'.gbt-detailteam{display:flex;flex-direction:column;gap:4px;min-width:0;min-height:0;overflow:hidden}',
'.gbt-detailpanelhead{display:flex;align-items:center;justify-content:space-between;gap:8px;color:var(--deck-dim);font-size:9.5px;letter-spacing:.08em;text-transform:uppercase;padding-bottom:4px;border-bottom:1px solid var(--deck-line)}',
'.gbt-detailpanelhead b{font:10px ui-monospace,SFMono-Regular,Consolas,monospace;font-weight:400;color:var(--deck-muted)}',
'.gbt-detailmember{display:grid;grid-template-columns:7px minmax(0,1fr) 64px 54px;gap:6px;align-items:center;min-height:22px;border-bottom:1px solid var(--tc-line-soft);min-width:0}',
'.gbt-detailmembername{font-size:10.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
'.gbt-detailmemberstate{color:var(--deck-dim);font-size:9.5px;text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
'.gbt-detailmembertask{color:var(--deck-muted);font-size:9.5px;text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
'.gbt-detailright{display:flex;flex-direction:column;gap:8px;min-width:0;min-height:0;overflow:hidden}',
'.gbt-detailtasks{display:flex;flex-direction:column;gap:3px;min-width:0;min-height:0;overflow:hidden;border-top:1px solid var(--deck-line);padding-top:7px}',
'.gbt-detailtask{display:grid;grid-template-columns:54px minmax(0,1fr) 72px;gap:8px;align-items:center;min-height:22px;border-bottom:1px solid var(--tc-line-soft);min-width:0}',
'.gbt-detailtask b{font-size:10px;font-weight:400;color:var(--deck-lime)}',
'.gbt-detailtasktitle{font-size:10.5px;color:var(--deck-text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}',
'.gbt-detailtask em{font-style:normal;color:var(--deck-dim);font-size:9.5px;text-align:right;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
'.gbt-roleseg{display:inline-flex;align-items:center;gap:2px;padding:2px;border:1px solid var(--line,var(--dsw-alias-border-l4));border-radius:7px;background:var(--dsw-alias-bg-layer-2)}',
'.gbt-rolesegitem{appearance:none;height:26px;padding:0 14px;border:none;border-radius:5px;background:transparent;color:var(--t2,var(--dsw-alias-label-secondary));font:inherit;font-size:12px;font-weight:400;line-height:26px;cursor:pointer;text-decoration:none}',
'.gbt-rolesegitem:hover{background:var(--dsw-alias-bg-layer-3);color:var(--t1,var(--dsw-alias-label-primary))}',
'.gbt-rolesegitem:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}',
'.gbt-rolesegitem[aria-selected="true"]{background:var(--elev,var(--dsw-alias-bg-module-platform));color:var(--t1,var(--dsw-alias-label-primary))}',
'.gbt-rolecard{display:flex;flex-direction:column;gap:8px;min-width:0;border:1px solid var(--line,var(--dsw-alias-border-l4));border-radius:8px;background:var(--panel,var(--dsw-alias-bg-layer-1));padding:10px 12px}',
'.gbt-rolecardbody{display:flex;flex-direction:column;gap:6px;min-width:0}',
'.gbt-rolespane .gbt-sectlabel{font-size:11px;font-weight:400;letter-spacing:0;text-transform:none;background:none;border-left:2px solid var(--dsw-alias-state-business-primary);border-radius:0;padding:0 0 0 6px;margin:2px 0}',
'.gbt-rolespane .gbt-sectsource{font-size:11px;color:var(--t2,var(--dsw-alias-label-tertiary))}',
'.gbt-rolespane .gbt-promptpre{font-size:12px;line-height:1.7}',
'.gbt-rolesactions{border-top:1px solid var(--line,var(--dsw-alias-border-l4))}',
'.gbt-rolesheader{display:flex;gap:10px;align-items:center;justify-content:space-between;flex-wrap:wrap}',
'.gbt-rolesheader-right{display:flex;gap:8px;align-items:center;flex-wrap:wrap}',
'.gbt-rolespanes{display:grid;grid-template-columns:45fr 55fr;gap:10px;align-items:start}',
'@media (max-width:720px){.gbt-rolespanes{grid-template-columns:1fr}}',
'.gbt-rolespane{display:flex;flex-direction:column;gap:8px;min-width:0}',
'.gbt-rolescroll{max-height:56vh;overflow:auto;padding:2px 2px 18px;mask-image:linear-gradient(to bottom,#000 88%,transparent);-webkit-mask-image:linear-gradient(to bottom,#000 88%,transparent)}',
'.gbt-rolesactions{position:sticky;bottom:0;display:flex;gap:8px;align-items:flex-end;justify-content:space-between;flex-wrap:wrap;padding:8px 0 2px;border-top:1px solid var(--line,var(--dsw-alias-border-l4));background:var(--panel,var(--dsw-alias-bg-layer-1))}',
'.gbt-rolesactions-left,.gbt-rolesactions-right{display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap}',
'.gbt-prompttaskrow{display:flex;gap:6px;align-items:center;min-width:0;flex-wrap:wrap}',
'.gbt-rolefields{display:grid;grid-template-columns:1fr 1fr;gap:8px;align-items:end}',
'.gbt-rolefields .gbt-editorskills{grid-column:1/-1}',
'.gbt-secthead{display:flex;gap:6px;align-items:center;justify-content:space-between;min-width:0}',
'.gbt-sectsource{font-size:11px;color:var(--dsw-alias-label-tertiary)}',
'.gbt-editorfield{display:flex;flex-direction:column;gap:4px;font-size:11px;color:var(--dsw-alias-label-tertiary)}',
'.gbt-editorfield .gbt-input{height:30px}',
'.gbt-editorinstances{display:flex;flex-direction:column;gap:4px}',
'.gbt-createblank{margin-top:2px;border:0.5px dashed var(--dsw-alias-border-l4);border-radius:8px;padding:6px 10px}',
'.gbt-createblank summary{cursor:pointer;font-size:11px;color:var(--dsw-alias-label-tertiary)}',
'.gbt-rolesview[data-roles-deck]{--deck-bg:var(--tc-bg);--deck-panel:var(--tc-panel);--deck-panel2:var(--tc-panel2);--deck-line:var(--tc-line);--deck-text:var(--tc-text);--deck-muted:var(--tc-muted);--deck-dim:var(--tc-dim);--deck-lime:var(--tc-accent);--deck-amber:var(--tc-amber);--deck-cyan:var(--tc-cyan);--deck-red:var(--tc-red);height:100%;min-height:0;display:flex;flex-direction:column;gap:0;overflow:hidden;background:var(--deck-bg);color:var(--deck-text);box-sizing:border-box}',
'.gbt-rolesview[data-roles-deck] .gbt-rolesview-empty{display:flex;flex-direction:column;gap:10px;padding:18px 16px}',
'.gbt-roleeditor[data-role-deck]{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;width:100%;background:var(--deck-bg);overflow:hidden}',
'.gbt-rolesworkspace{flex:1 1 auto;min-height:0;display:grid;grid-template-columns:252px minmax(0,1fr);min-width:0;overflow:hidden}',
'.gbt-rolestagerail{display:flex;flex-direction:column;min-height:0;min-width:0;padding:16px 12px 12px;border-right:1px solid var(--deck-line);background:var(--deck-panel);overflow:auto}',
'.gbt-stageprofile{display:flex;flex-direction:column;gap:6px;margin-bottom:18px;min-width:0}',
'.gbt-stageselect{width:100%;box-sizing:border-box;height:30px;padding:0 8px;border:1px solid var(--deck-line);border-radius:4px;background:var(--tc-input-bg);color:var(--deck-text);font:inherit;font-size:11px}',
'.gbt-stageselect:focus-visible{outline:none;border-color:var(--tc-accent-line)}',
'.gbt-rolesview[data-roles-deck] .gbt-deckeyebrow{font-size:11px}',
'.gbt-rail-title{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:0 0 10px;color:var(--deck-muted);font-size:11px;white-space:nowrap}',
'.gbt-rail-title em{font-style:normal;color:var(--deck-dim);font-size:11px}',
'.gbt-stagelist{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:4px;position:relative;min-width:0}',
'.gbt-stagelist:before{content:"";position:absolute;left:19px;top:22px;bottom:22px;width:1px;background:var(--deck-line)}',
'.gbt-stageli{position:relative;min-width:0;display:flex}',
'.gbt-stagerow{display:grid;grid-template-columns:40px minmax(0,1fr) auto;gap:10px;align-items:start;width:100%;min-width:0;padding:10px 8px 10px 0;border:0;border-radius:8px;background:none;color:var(--deck-text);text-align:left;font:inherit;cursor:pointer}',
'.gbt-stagerow:hover{background:var(--tc-hover)}',
'.gbt-stagerow[data-active="true"]{background:var(--tc-selected);box-shadow:inset 0 0 0 1px var(--deck-line)}',
'.gbt-stagenum{position:relative;z-index:1;width:40px;height:40px;border-radius:50%;display:grid;place-items:center;border:1px solid var(--deck-line);background:var(--deck-panel2);color:var(--deck-muted);font-size:11px}',
'.gbt-stagerow[data-active="true"] .gbt-stagenum{background:var(--deck-lime);border-color:var(--deck-lime);color:var(--tc-accent-ink);font-weight:700}',
'.gbt-stagebody{display:flex;flex-direction:column;gap:3px;min-width:0;padding-top:1px}',
'.gbt-stagetitle{display:flex;align-items:baseline;gap:7px;min-width:0}',
'.gbt-stagetitle b{font-size:13px;font-weight:600;white-space:nowrap}',
'.gbt-stagetitle code{font-size:11px;font-weight:400;color:var(--deck-dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
'.gbt-stagedesc{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;margin:0;color:var(--deck-muted);font-size:11px;line-height:1.5}',
'.gbt-stagemeta{display:flex;align-items:baseline;gap:6px;flex-wrap:nowrap;min-width:0;margin-top:2px;overflow:hidden}',
'.gbt-stagetag{flex:none;font-size:11px;color:var(--deck-dim);white-space:nowrap}',
'.gbt-stagerow[data-active="true"] .gbt-stagetag{color:var(--deck-lime)}',
'.gbt-stagesub{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;color:var(--deck-dim)}',
'.gbt-stageside{display:flex;flex-direction:column;align-items:flex-end;gap:5px;padding-top:4px}',
'.gbt-stagelive{font-style:normal;font-size:11px;color:var(--deck-dim)}',
'.gbt-rolesview[data-roles-deck] .gbt-deckdot[data-on="true"]{background:var(--deck-lime)}',
'.gbt-stagenote{margin:16px 0 0;padding-top:12px;border-top:1px solid var(--deck-line);color:var(--deck-dim);font-size:11px;line-height:1.55}',
'.gbt-stagecreatewrap{margin-top:12px}',
'.gbt-stagecreate{min-width:0;border:1px dashed var(--deck-line);border-radius:6px}',
'.gbt-stagecreate summary{display:flex;align-items:center;gap:6px;min-height:30px;padding:0 9px;color:var(--deck-muted);font-size:11px;white-space:nowrap;cursor:pointer;list-style:none}',
'.gbt-stagecreate summary::-webkit-details-marker{display:none}',
'.gbt-stagecreate[open] summary{color:var(--deck-text);border-bottom:1px solid var(--deck-line)}',
'.gbt-stagecreatebody{max-height:280px;overflow:auto;padding:8px 9px 10px;background:var(--deck-panel2);min-width:0}',
'.gbt-stagecreatebody .gbt-formgrid{display:flex;flex-direction:column;gap:6px;min-width:0}',
'.gbt-stagecreatebody label{display:flex;flex-direction:column;gap:3px;font-size:11px;color:var(--deck-dim);min-width:0}',
'.gbt-stagecreatebody .gbt-input{width:100%;box-sizing:border-box;min-height:28px;padding:4px 6px;border:1px solid var(--deck-line);border-radius:4px;background:var(--tc-input-bg);color:var(--deck-text);font-size:11px}',
'.gbt-stagecreatebody textarea.gbt-input{min-height:56px;resize:vertical}',
'.gbt-stagecreatebody .gbt-formactions{display:flex;justify-content:flex-end;margin-top:2px}',
'.gbt-stagecreatebody .gbt-formactions .gbt-btn{height:26px;padding:0 9px;font-size:11px}',
'.gbt-rolesmain{display:flex;flex-direction:column;min-height:0;min-width:0;background:var(--deck-panel);overflow:hidden}',
'.gbt-rolehead{flex:0 0 auto;display:flex;align-items:flex-end;justify-content:space-between;gap:12px;padding:16px 20px 12px;border-bottom:1px solid var(--deck-line);min-width:0}',
'.gbt-roleheadmain{display:flex;flex-direction:column;gap:6px;min-width:0}',
'.gbt-roleheadtitle{display:flex;align-items:baseline;gap:6px;min-width:0;margin:0;font-size:22px;font-weight:650;line-height:1.1;letter-spacing:-.03em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
'.gbt-roleheadstage{font-size:13px;font-weight:400;letter-spacing:0;color:var(--deck-muted);white-space:nowrap}',
'.gbt-roleheadmeta{display:flex;align-items:center;justify-content:flex-end;flex-wrap:wrap;gap:10px;min-width:0;padding-bottom:2px}',
'.gbt-roleheadmeta .gbt-pill{font-size:11px}',
'.gbt-roleheadmeta .gbt-footnote{font-size:11px;color:var(--deck-dim);white-space:nowrap}',
'.gbt-roleseditscroll{flex:1 1 auto;min-height:0;overflow:auto;display:flex;align-items:stretch}',
'.gbt-rolespanes{display:grid;grid-template-columns:minmax(0,1fr) 360px;gap:1px;background:var(--deck-line);width:100%;min-height:0;align-items:stretch}',
'.gbt-roleseditorpane{display:flex;flex-direction:column;gap:0;min-width:0;background:var(--deck-panel);padding:0 12px 10px;overflow:auto}',
'.gbt-rolespreviewpane{display:flex;flex-direction:column;gap:8px;min-width:0;min-height:0;background:var(--deck-panel2);padding:12px;overflow:auto}',
'.gbt-rolespreviewhead{display:flex;align-items:baseline;gap:8px;min-width:0}',
'.gbt-rolespreviewhead h3{font-size:12px;font-weight:600;margin:0;white-space:nowrap}',
'.gbt-rolesection{display:flex;flex-direction:column;gap:8px;padding:10px 0 11px;border-bottom:1px solid var(--deck-line);min-width:0}',
'.gbt-rolesection:last-of-type{border-bottom:0}',
'.gbt-rolesectionhead{display:flex;align-items:baseline;gap:8px;min-width:0}',
'.gbt-rolesectionhead h3{font-size:12px;font-weight:500;margin:0;white-space:nowrap}',
'.gbt-rolesectionhead .gbt-sectionnote{margin-left:auto;font-size:11px;color:var(--deck-dim);white-space:nowrap}',
'.gbt-rolesection .gbt-rolecard{border:1px solid var(--deck-line);border-radius:4px;background:var(--deck-panel2);padding:9px;min-width:0;min-height:0}',
'.gbt-roleidentity{display:flex;flex-direction:column;gap:8px;min-width:0;padding:0}',
'.gbt-identitygrid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;min-width:0}',
'.gbt-identityfield{display:flex;flex-direction:column;gap:4px;min-width:0;font-size:11px;color:var(--deck-dim)}',
'.gbt-identityfield > span{display:flex;align-items:baseline;justify-content:space-between;gap:6px;white-space:nowrap}',
'.gbt-identityhint{font-style:normal;font-size:11px;color:var(--deck-dim)}',
'.gbt-readonlyfield{width:100%;box-sizing:border-box;height:30px;padding:0 8px;border:1px solid var(--deck-line);border-radius:4px;background:var(--tc-input-bg);color:var(--deck-muted);font-size:11px}',
'.gbt-roleseditorpane .gbt-rolecard textarea{width:100%;min-height:132px;max-height:210px;resize:vertical;font:11.5px/1.55 ui-monospace,SFMono-Regular,Consolas,monospace;background:var(--tc-input-bg);color:var(--deck-text);border:1px solid var(--deck-line);border-radius:4px;padding:8px}',
'.gbt-roleseditorpane .gbt-rolecard input.gbt-input{background:var(--tc-input-bg);color:var(--deck-text);border:1px solid var(--deck-line);border-radius:4px}',
'.gbt-editorskills{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:6px;align-items:end;margin-top:8px}',
'.gbt-editorskills-field{display:flex;flex-direction:column;gap:3px;font-size:11px;color:var(--deck-dim)}',
'.gbt-editorskills .gbt-btn{height:28px;white-space:nowrap}',
'.gbt-roleseditorpane .gbt-editorfield{font-size:11px;color:var(--deck-dim);gap:3px}',
'.gbt-roleseditorpane .gbt-editorfield .gbt-input{background:var(--tc-input-bg);color:var(--deck-text);border:1px solid var(--deck-line);border-radius:4px;height:28px}',
'.gbt-roleseditorpane .gbt-rolescurrent{display:flex;align-items:center;gap:8px;font-size:11px;color:var(--deck-dim);margin:2px 0 4px}',
'.gbt-roleseditorpane .gbt-rolescurrent select{background:var(--tc-input-bg);color:var(--deck-text);border:1px solid var(--deck-line);border-radius:4px;height:28px;font-size:11px;min-width:150px}',
'.gbt-roleseditorpane .gbt-rolefields{display:block}',
'.gbt-rolespreviewpane .gbt-rolecard{flex:1 1 auto;min-height:0;border:1px solid var(--deck-line);border-radius:4px;background:var(--tc-input-bg);padding:9px;overflow:auto}',
'.gbt-rolespreviewpane .gbt-rolecard .gbt-promptpre{font-size:11px;line-height:1.6;color:var(--deck-text)}',
'.gbt-rolespreviewpane .gbt-prompthead{flex-direction:column;align-items:stretch;gap:8px}',
'.gbt-rolespreviewpane .gbt-prompttaskrow{flex-direction:column;align-items:stretch;gap:4px}',
'.gbt-rolespreviewpane .gbt-editor-select{display:flex;flex-direction:column;align-items:stretch;gap:4px;min-width:0}',
'.gbt-rolespreviewpane .gbt-editor-select .gbt-input{width:100%;min-width:0;height:28px;background:var(--tc-input-bg);color:var(--deck-text);border:1px solid var(--deck-line);border-radius:4px;font-size:11px}',
'.gbt-rolespreviewpane .gbt-prompthead .gbt-subhead{margin:0}',
'.gbt-rolespreviewpane .gbt-footnote{font-size:11px;color:var(--deck-dim);line-height:1.5}',
'.gbt-rolesactions{flex:0 0 auto;display:flex;gap:8px;align-items:flex-end;justify-content:space-between;flex-wrap:wrap;padding:8px 12px;border-top:1px solid var(--deck-line);background:var(--deck-panel);z-index:2}',
'.gbt-rolesactions-left,.gbt-rolesactions-right{display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap;min-width:0}',
'.gbt-rolesactions .gbt-btn{height:28px;white-space:nowrap}',
'.gbt-rolesview[data-roles-deck] .gbt-role-result,.gbt-rolesview[data-roles-deck] .gbt-banner{margin:0 10px 8px}',
'@media (max-width:1180px){.gbt-rolesworkspace{grid-template-columns:220px minmax(0,1fr)}.gbt-rolespanes{grid-template-columns:minmax(0,1fr) 320px}.gbt-stageside{display:none}.gbt-stagerow{gap:8px}.gbt-stagenum{width:36px;height:36px}.gbt-stagelist:before{left:17px}}',
'@media (max-width:900px){.gbt-rolesview[data-roles-deck]{height:auto;min-height:0;overflow:visible}.gbt-roleeditor[data-role-deck]{overflow:visible}.gbt-rolesworkspace{grid-template-columns:minmax(0,1fr);overflow:visible}.gbt-rolestagerail{border-right:0;border-bottom:1px solid var(--deck-line);overflow:visible}.gbt-stagelist{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px}.gbt-stagelist:before{display:none}.gbt-stagedesc{display:none}.gbt-rolesmain{overflow:visible}.gbt-roleseditscroll{overflow:visible;display:block}.gbt-rolespanes{grid-template-columns:minmax(0,1fr)}.gbt-roleseditorpane{overflow:visible;padding:0 10px 8px}.gbt-rolespreviewpane{overflow:visible;border-top:1px solid var(--deck-line);min-height:220px}.gbt-rolehead{padding:12px}.gbt-roleheadtitle{font-size:18px}.gbt-identitygrid{grid-template-columns:minmax(0,1fr)}.gbt-rolesactions{position:static;padding:8px 10px}}',
'.gbt-rheadactions{display:flex;gap:6px;align-items:center}',
			'.gbt-field{display:flex;flex-direction:column;gap:4px}',
			'.gbt-field label{font-size:11px;color:var(--dsw-alias-label-tertiary)}',
			'.gbt-input,.gbt-area{box-sizing:border-box;width:100%;border:0.5px solid var(--dsw-alias-border-l4);border-radius:8px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;padding:6px 9px;height:32px}',
			'.gbt-input:focus-visible,.gbt-area:focus-visible{outline:none;border-color:var(--dsw-alias-state-business-primary)}',
			'.gbt-area{min-height:64px;resize:vertical;height:auto;line-height:1.5}',
			'.gbt-row2{display:grid;grid-template-columns:1fr 1fr;gap:10px}',
			'.gbt-check{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary)}',
			'.gbt-check input{accent-color:var(--dsw-alias-state-business-primary)}',
			'.gbt-banner{margin:10px 18px 0;padding:8px 11px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);border:0.5px solid var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary);font-size:12px;display:flex;gap:8px;align-items:center}',
			'.gbt-banner[data-tone="info"]{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-state-business-primary)}' +
				'.gbt-banner[data-tone="warn"]{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-state-warn-label);color:var(--dsw-alias-state-warn-label)}' +
				'.gbt-banner[data-project-mismatch="true"]{cursor:pointer}',
			'.gbt-footnote{font-size:10px;color:var(--dsw-alias-label-tertiary);margin:0}',
'.gbt-settingsform{gap:12px}',
'.gbt-settingsgroup{display:flex;flex-direction:column;gap:7px;padding:10px 12px;border:0.5px solid var(--dsw-alias-border-l4);border-radius:8px;background:var(--dsw-alias-bg-layer-2)}',
'.gbt-settingsgrouphead{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary)}',
'.gbt-settingsnote{margin:0;font-size:10.5px;line-height:1.55;color:var(--dsw-alias-label-tertiary)}',
'.gbt-settingsinline{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:11px;color:var(--dsw-alias-label-secondary)}',
'.gbt-settingsinline input[type="checkbox"]{margin:0}',
'.gbt-settingscapacity{display:flex;flex-direction:column;gap:5px;padding:10px 12px;border-radius:8px;border:0.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-2)}',
'.gbt-settingscapacity b{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary)}',
'.gbt-settingswarning{margin:0;font-size:10.5px;line-height:1.55;color:var(--dsw-alias-state-warn-label)}',
'.gbt-settingswarning[data-settings-warning="spawn-failed"],.gbt-settingswarning[data-settings-warning="workers-unavailable"]{color:var(--dsw-alias-state-error-primary)}',
// T-198: the decision policy editor (compact table). T-205 moved it from the
// settings modal into the settings page's 关键决策 section.
'.gbt-policyscopes{display:flex;gap:6px;flex-wrap:wrap;align-items:center}',
'.gbt-policyscope{appearance:none;border:0.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-secondary);height:26px;padding:0 10px;border-radius:7px;font:inherit;font-size:11px;cursor:pointer}',
'.gbt-policyscope[data-active="true"]{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l3,var(--dsw-alias-border-l4));font-weight:600}',
'.gbt-policytable{width:100%;border-collapse:collapse;font-size:11px}',
'.gbt-policytable th,.gbt-policytable td{padding:3px 4px;text-align:left;vertical-align:middle;border-top:0.5px solid var(--dsw-alias-border-l4)}',
'.gbt-policytable thead th{font-size:10.5px;font-weight:600;color:var(--dsw-alias-label-tertiary);white-space:nowrap;border-top:0}',
'.gbt-policytable th[scope="row"]{font-weight:500;color:var(--dsw-alias-label-primary);white-space:nowrap}',
'.gbt-policytable .gbt-input{height:24px;min-width:56px;font-size:11px;padding:0 4px;box-sizing:border-box}',
'.gbt-policytable select.gbt-input{min-width:74px}',
'.gbt-policytable .gbt-btn{height:22px;padding:0 7px;font-size:10px;white-space:nowrap}',
'.gbt-policyguard{display:flex;align-items:center;gap:7px;font-size:11px;color:var(--dsw-alias-label-secondary)}',
'.gbt-policyguard input[type="checkbox"]{margin:0}',
'@media (max-width:720px){.gbt-settingsgroup,.gbt-settingscapacity{padding:8px 10px}.gbt-settingsinline .gbt-btn{width:100%}}',
			// T-205: the settings PAGE — title, fixed left theme rail, an
			// independently scrolling right column and a footer that holds save/cancel.
			// Same DSH tokens and controls as the rest of the panel; nothing new.
			'.gbt-settingspage{display:flex;flex-direction:column;flex:1 1 auto;min-height:0;min-width:0;height:100%;box-sizing:border-box;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}',
			'.gbt-settingspage[data-settings-mode="card"]{flex:0 0 auto;height:auto;min-height:420px;max-height:min(720px,78vh);border:0.5px solid var(--dsw-alias-border-l4);border-radius:10px;overflow:hidden;background:var(--dsw-alias-bg-layer-1)}',
			'.gbt-settingshead{display:flex;align-items:flex-start;gap:12px;flex:0 0 auto;padding:14px 20px 10px;border-bottom:0.5px solid var(--dsw-alias-border-l4)}',
			'.gbt-settingsheadtext{flex:1;min-width:0}',
			'.gbt-settingspagetitle{margin:0;font-size:16px;line-height:1.4;font-weight:600;color:var(--dsw-alias-label-primary)}',
			'.gbt-settingssub{margin:3px 0 0;font-size:11.5px;line-height:1.5;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}',
			'.gbt-settingssub .gbt-mono{font-size:11px;color:var(--dsw-alias-label-secondary)}',
			'.gbt-settingsunbound{flex:0 0 auto;margin:10px 20px 0;padding:8px 11px;border:0.5px solid var(--dsw-alias-state-warn-label,var(--dsw-alias-border-l4));border-radius:8px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-secondary);font-size:11.5px;line-height:1.5}',
			'.gbt-settingsunbound b{margin-right:2px;color:var(--dsw-alias-state-warn-label,var(--dsw-alias-label-primary));font-weight:600}',
			'.gbt-settingsbody{display:flex;align-items:stretch;flex:1;min-height:0;min-width:0}',
			'.gbt-settingsnav{display:flex;flex-direction:column;gap:2px;flex:0 0 200px;width:200px;padding:12px;box-sizing:border-box;border-right:0.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-1);overflow-y:auto}',
			'.gbt-settingsnavitem{appearance:none;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12.5px;line-height:1.4;text-align:left;padding:7px 10px;border-radius:7px;cursor:pointer;white-space:nowrap}',
			'.gbt-settingsnavitem:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
			'.gbt-settingsnavitem[data-active="true"]{background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary);font-weight:600}',
			'.gbt-settingsnavitem:disabled{opacity:.45;cursor:not-allowed}',
			// Disabled page actions (engine path unchanged, save while unbound) must
			// read as disabled; the shared button has no dim rule in the dsh theme.
			'.gbt-settingspage .gbt-btn:disabled{opacity:.5;cursor:not-allowed}',
			'.gbt-settingspane{display:flex;flex-direction:column;flex:1;min-width:0;min-height:0}',
			'.gbt-settingsscroll{flex:1;min-height:0;overflow:auto;padding:16px 20px 20px}',
			'.gbt-settingssections{display:flex;flex-direction:column;gap:14px;width:100%;max-width:880px;margin:0 auto}',
			'.gbt-settingssection{display:flex;flex-direction:column;gap:12px;min-width:0}',
			// A class-level display beats the UA [hidden] rule, so the hidden
			// section needs its own rule or every theme would render at once.
			'.gbt-settingssection[hidden]{display:none}',
			'.gbt-settingsfooter{display:flex;align-items:center;gap:8px;flex-wrap:wrap;flex:0 0 auto;padding:10px 20px;border-top:0.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-2)}',
			'.gbt-settingsstatus{flex:1 1 auto;min-width:0;margin:0;font-size:11.5px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}',
			'.gbt-settingsstatus[data-settings-status="saved"]{color:var(--dsw-alias-state-success-primary)}',
			'.gbt-settingsstatus[data-settings-status="error"]{color:var(--dsw-alias-state-error-primary)}',
			'@media (max-width:900px){.gbt-settingsbody{flex-direction:column}.gbt-settingsnav{flex-direction:row;width:auto;flex:0 0 auto;overflow-x:auto;overflow-y:hidden;border-right:0;border-bottom:0.5px solid var(--dsw-alias-border-l4);padding:8px 10px;gap:4px}.gbt-settingsnavitem{padding:5px 10px}.gbt-settingsscroll{padding:12px 10px}.gbt-settingshead{padding:12px 10px 8px}.gbt-settingsunbound{margin:8px 10px 0}.gbt-settingsfooter{padding:8px 10px}}',
			'.gbt-pill{display:inline-flex;align-items:center;gap:4px;padding:1px 7px;border-radius:999px;font-size:10px;font-weight:500;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}',
			'.gbt-pill[data-status="running"]{background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-state-success-primary)}',
			'.gbt-pill[data-status="reviewing"]{background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-state-warn-label)}',
			'.gbt-pill[data-status="testing"]{background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-state-warn-label)}',
			'.gbt-pill[data-status="approved"]{background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-state-success-primary)}',
			'.gbt-pill[data-status="changes-requested"]{background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-state-error-primary)}',
			'.gbt-pill[data-status="done"]{background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-state-success-primary)}',
			'.gbt-pill[data-status="blocked"]{background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-state-error-primary)}',
			'.gbt-pill[data-status="cancelled"]{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-tertiary)}',
			'.gbt-pill[data-status="inactive"]{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-tertiary)}',
			'.gbt-pill[data-status="provisioning"]{background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-state-warn-label)}',
			'.gbt-pill[data-status="failed"]{background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-state-error-primary)}',
			'.gbt-pill[data-status="pending"]{background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-state-warn-label)}',
			'.gbt-pill[data-status="passed"]{background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-state-success-primary)}',
			'.gbt-iconbtn{appearance:none;border:none;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;font-size:16px;line-height:1;padding:2px 5px;border-radius:6px}',
			'.gbt-iconbtn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
			// T-155: sessions are grouped per participant; the panel session is highlighted,
			// never "primary". One workspace scope bar replaces the two switch notices.
			'.gbt-sessions{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:2px 0 0}' +
				'.gbt-sessionslabel{font-size:11px;color:var(--dsw-alias-label-tertiary)}' +
				'.gbt-session{display:inline-flex;align-items:center;gap:6px;padding:2px 8px;border:0.5px solid var(--dsw-alias-border-l4);border-radius:999px;background:var(--dsw-alias-bg-layer-2);font-size:11px;color:var(--dsw-alias-label-secondary)}' +
				'.gbt-session[data-current="true"]{border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-primary)}' +
				'.gbt-session[data-status="stale"]{opacity:.72}' +
				'.gbt-session[data-status="unknown"]{opacity:.72;border-style:dashed}' +
				'.gbt-session b{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-weight:600;font-size:11px}' +
				'.gbt-session .gbt-sessionnow{font-size:10px;color:var(--dsw-alias-state-business-primary)}' +
				'.gbt-workspacebar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:8px 18px 0;padding:7px 11px;border:0.5px solid var(--dsw-alias-border-l4);border-radius:9px;background:var(--dsw-alias-bg-layer-2);font-size:11px;color:var(--dsw-alias-label-secondary)}' +
				'.gbt-workspacebar[data-project-mismatch="true"]{border-color:var(--dsw-alias-state-warn-label)}' +
				'.gbt-workspace{display:inline-flex;align-items:center;gap:5px;min-width:0}' +
				'.gbt-workspace .gbt-workspacelabel{color:var(--dsw-alias-label-tertiary)}' +
				'.gbt-workspace b{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-weight:600;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:220px}' +
				'.gbt-workspacearrow{color:var(--dsw-alias-label-tertiary)}' +
				'.gbt-workspacestate{display:inline-flex;align-items:center;gap:6px;min-width:0;flex:1 1 260px;color:var(--dsw-alias-label-secondary)}' +
				'.gbt-workspacestate[data-workspace-tone="error"]{color:var(--dsw-alias-state-error-primary)}' +
				'.gbt-workspacestate[data-workspace-tone="warn"]{color:var(--dsw-alias-state-warn-label)}' +
				'.gbt-workspacemissing{display:flex;flex-wrap:wrap;gap:4px}' +
				'.gbt-workspacemissing span{padding:1px 6px;border-radius:999px;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary)}' +
				'.gbt-workspaceactions{display:flex;gap:6px;margin-left:auto}' +
				'.gbt-workspacefade{animation:gbt-workspacefade .18s ease-out}' +
				'.gbt-main{animation:gbt-contentin .18s ease-out}' +
				'@keyframes gbt-workspacefade{from{opacity:0}to{opacity:1}}' +
				'@keyframes gbt-contentin{from{opacity:0;transform:translateY(2px)}to{opacity:1;transform:none}}' +
				'@media (prefers-reduced-motion: reduce){.gbt-spinner{animation:none;border-right-color:currentColor;opacity:.7}.gbt-workspacefade{animation-duration:.12s}.gbt-main{animation:none}.gbt-skel{animation:none}}' +
				'.gbt-sessionscards{display:flex;flex-direction:column;gap:6px}' +
				'.gbt-sessionsrow{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:6px 9px;border:0.5px solid var(--dsw-alias-border-l4);border-radius:8px;background:var(--dsw-alias-bg-layer-3)}' +
				'.gbt-sessionsrow[data-current="true"]{border-color:var(--dsw-alias-state-business-primary)}' +
				'.gbt-sessionsmeta{color:var(--dsw-alias-label-tertiary);font-size:11px}' +
				'.gbt-sessionfilter{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--dsw-alias-label-tertiary)}' +
				'.gbt-sessionfilter select{font:inherit;font-size:11px;padding:2px 6px;border-radius:6px;border:0.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-2);color:inherit}' +
			'.gbt-projectform{display:flex;gap:6px;align-items:center;margin-top:10px;flex-wrap:wrap}',
			'.gbt-projectform .gbt-input{flex:1;min-width:220px}',
			'.gbt-busy{opacity:.6;pointer-events:none}',
			'.gbt-btn[data-busy="true"]{opacity:.65;cursor:progress}',
			'.gbt-progress{display:flex;align-items:center;gap:8px;margin:8px 18px 0;padding:6px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-3);border:0.5px solid var(--dsw-alias-border-l4);font-size:11px;color:var(--dsw-alias-label-secondary)}',
			'.gbt-progress .gbt-progressbar{position:relative;flex:1;height:2px;border-radius:2px;background:var(--dsw-alias-border-l4);overflow:hidden}',
			'.gbt-progress .gbt-progressbar::after{content:"";position:absolute;left:-40%;top:0;bottom:0;width:40%;background:var(--dsw-alias-state-business-primary);animation:gbt-slide 1.1s ease-in-out infinite}',
			'.gbt-spinner{display:inline-block;width:10px;height:10px;border:1.5px solid currentColor;border-right-color:transparent;border-radius:50%;animation:gbt-spin .7s linear infinite;vertical-align:-1px;margin-right:6px}',
			'@keyframes gbt-spin{to{transform:rotate(360deg)}}',
			'@keyframes gbt-slide{0%{left:-40%}100%{left:100%}}',
			// T-158 夜航作战板：两行顶部、紧凑上下文胶囊、会话/团队 popover、六列看板。
			`.gbt-header.gbt-headertwo{display:flex;flex-direction:column;align-items:stretch;gap:0;padding:0;background:var(--dsw-alias-bg-layer-3);flex-wrap:nowrap}
.gbt-toprow{display:flex;align-items:center;gap:14px;padding:10px 16px;border-bottom:0.5px solid var(--dsw-alias-border-l4);min-width:0;flex-wrap:wrap}
.gbt-brand{display:flex;align-items:center;gap:10px;min-width:0;flex:0 1 auto}
.gbt-brandcopy{display:flex;flex-direction:column;gap:2px;min-width:0}
.gbt-eyebrow{font-size:10px;letter-spacing:.16em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary)}
.gbt-projectline{display:flex;align-items:baseline;gap:8px;min-width:0}
.gbt-projectname{font-size:14px;font-weight:650;color:var(--dsw-alias-label-primary);white-space:nowrap}
.gbt-projectpath{font-size:11px;color:var(--dsw-alias-label-tertiary);max-width:340px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,SFMono-Regular,Consolas,monospace}
.gbt-projectsep,.gbt-projecthint{font-size:10px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}
.gbt-context{display:flex;align-items:center;gap:7px;flex:1 1 auto;min-width:0;flex-wrap:wrap;justify-content:center}
.gbt-topactions{display:flex;align-items:center;gap:7px;margin-left:auto;flex:none}
.gbt-chipbtn{appearance:none;cursor:pointer;border:0.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-2);height:28px;padding:0 9px;border-radius:8px;font:inherit;font-size:11.5px;color:var(--dsw-alias-label-secondary);display:inline-flex;align-items:center;gap:6px}
.gbt-chipbtn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.gbt-chipbtn b{font-weight:600;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}
.gbt-sessionsdots{display:inline-flex;align-items:center}
.gbt-sessionsdots i{width:13px;height:13px;border-radius:50%;border:2px solid var(--dsw-alias-bg-layer-2);margin-left:-4px;background:var(--dsw-alias-state-business-primary)}
.gbt-sessionsdots i:first-child{margin-left:0}
.gbt-sessionsdots i:nth-child(2){background:var(--dsw-alias-state-success-primary)}
.gbt-sessionsdots i:nth-child(3){background:var(--dsw-alias-state-warn-label)}
.gbt-sessionsdots i:nth-child(4){background:var(--dsw-alias-state-error-primary)}
.gbt-sessionsdots i:nth-child(5){background:var(--dsw-alias-label-tertiary)}
.gbt-caret{font-size:9px;opacity:.7}
.gbt-currentsession{border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-primary)}
.gbt-currentsession b{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px}
.gbt-tag{font-size:9px;padding:1px 5px;border-radius:4px;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-state-business-primary)}
.gbt-agentpill[data-agent-pill="ready"]{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}
.gbt-agentpill[data-agent-pill="none"]{color:var(--dsw-alias-label-tertiary)}
.gbt-dispatchpill[data-dispatch-state="running"]{color:var(--dsw-alias-state-success-primary)}
.gbt-toolbar{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:0 16px;border-bottom:0.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-2)}
.gbt-toolbar .gbt-tabs{padding:0;gap:2px;flex-wrap:nowrap;min-width:0;overflow-x:auto;scrollbar-width:none}
.gbt-toolbar .gbt-tab{position:relative;display:inline-flex;align-items:center;gap:6px;height:40px;border-radius:0;padding:0 11px;background:transparent;white-space:nowrap}
.gbt-toolbar .gbt-tab[data-active="true"]{background:transparent;font-weight:600;box-shadow:inset 0 -2px 0 var(--dsw-alias-state-business-primary)}
.gbt-tabcount{font-size:10px;padding:0 5px;border-radius:4px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-tertiary);border:0.5px solid var(--dsw-alias-border-l4)}
.gbt-tab[data-active="true"] .gbt-tabcount{background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-state-business-primary)}
.gbt-toolbarright{display:flex;align-items:center;gap:8px;flex:none}
.gbt-toolbarright .gbt-kindfilter{margin:0}
.gbt-iconbtn{width:28px;height:28px;display:inline-flex;align-items:center;justify-content:center;border-radius:7px}
.gbt-morewrap{position:relative}
.gbt-anchor{position:relative;display:inline-flex;min-width:0;align-items:center}
.gbt-anchor .gbt-popover{left:0;right:auto;top:calc(100% + 8px)}
.gbt-popover{position:absolute;top:calc(100% + 6px);right:0;z-index:40;min-width:260px;max-width:min(360px,92vw);max-height:min(420px,70vh);overflow:auto;padding:10px;border:0.5px solid var(--dsw-alias-border-l4);border-radius:10px;background:var(--dsw-alias-bg-layer-3);box-shadow:0 14px 36px rgba(0,0,0,.28);text-align:left;font-size:11.5px;color:var(--dsw-alias-label-secondary)}
.gbt-popover[hidden]{display:none}
.gbt-sessionpopover{right:auto;left:0;min-width:320px}
.gbt-agentpopover{right:auto;left:0;min-width:280px}
.gbt-popoverhead{font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary);padding-bottom:6px;border-bottom:0.5px solid var(--dsw-alias-border-l4);margin-bottom:8px}
.gbt-sessionrow{display:flex;flex-direction:column;align-items:stretch;gap:4px;padding:7px 8px;border-radius:7px;border:0.5px solid transparent}
.gbt-sessionrow[data-current="true"]{border-color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-bg-module-platform)}
.gbt-sessionrow + .gbt-sessionrow{margin-top:6px}
.gbt-sessionrowhead{display:flex;align-items:center;gap:7px}
.gbt-sessionrowhead b{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px;color:var(--dsw-alias-label-primary)}
.gbt-sessionstatus{font-size:10px;color:var(--dsw-alias-label-tertiary);margin-left:auto}
.gbt-sessionrowmeta{display:flex;flex-wrap:wrap;gap:4px 8px;font-size:10.5px;color:var(--dsw-alias-label-tertiary)}
.gbt-sessionready[data-ready="true"]{color:var(--dsw-alias-state-success-primary)}
.gbt-sessionrow .gbt-linkbtn{align-self:flex-start;padding:0;margin-top:2px}
.gbt-popoverrow{margin:3px 0;line-height:1.55}
.gbt-popoverwarn{color:var(--dsw-alias-state-warn-label)}
.gbt-popovernote{margin:8px 0 0;font-size:10.5px;line-height:1.5;color:var(--dsw-alias-state-warn-label)}
.gbt-popoverempty{margin:2px 0;font-size:10.5px;color:var(--dsw-alias-label-tertiary)}
.gbt-popoveractions{display:flex;align-items:center;gap:8px;margin-top:8px;flex-wrap:wrap}
.gbt-menu{right:0;min-width:190px;padding:5px}
.gbt-menuitem{display:flex;width:100%;align-items:center;gap:8px;padding:6px 8px;border-radius:6px;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11.5px;cursor:pointer;text-align:left}
.gbt-menuitem:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.gbt-statusbar{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:6px 16px;border-top:0.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-2);font-size:10.5px;color:var(--dsw-alias-label-tertiary);flex-wrap:wrap}
.gbt-statusleft,.gbt-statusright{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.gbt-statusleft b{font-weight:600;color:var(--dsw-alias-label-secondary)}
/* T-159 wide-screen fill: the board owns the full content width; only the
   dispatch and blocked rails narrow when they are empty. */
.gbt-main,.gbt-content,.gbt-view,.gbt-boardwrap,.gbt-board{width:100%;box-sizing:border-box}
.gbt-board{gap:10px;overflow:hidden auto}
.gbt-col{flex:1 1 0;min-width:168px;max-width:420px;min-height:120px}
.gbt-col[data-group="dispatch"]{min-width:190px}
.gbt-col[data-group="dispatch"] .gbt-colhead,
.gbt-col[data-group="dispatch"] .gbt-colname,
.gbt-col[data-group="dispatch"] .gbt-colcount,
.gbt-col[data-group="dispatch"] .gbt-colsubcounts,
.gbt-col[data-group="dispatch"] .gbt-colsubcount{white-space:nowrap}
.gbt-col[data-group="done"]{max-width:420px;flex-grow:1;min-width:0}
.gbt-col[data-group="done"] .gbt-card{max-width:none;width:100%}
.gbt-col[data-empty="true"]{flex:0 0 170px;min-width:160px;max-width:190px}
.gbt-col[data-group="dispatch"][data-empty="true"]{flex:0 0 200px;min-width:190px;max-width:230px}
.gbt-col[data-group="dispatch"][data-collapsed="true"]{flex:0 0 190px;min-width:190px;max-width:220px}
.gbt-col[data-empty="true"] .gbt-colhead{opacity:.8}
.gbt-emptyslim{min-height:64px;padding:10px;gap:4px;border-style:dashed;align-items:flex-start}
.gbt-emptytitle{color:var(--dsw-alias-label-secondary)}
.gbt-emptyslim span{display:block;line-height:1.45;font-size:10.5px}
.gbt-emptyslim .gbt-emptytitle{font-size:11px;margin-bottom:2px}
.gbt-colsubcounts{display:inline-flex;gap:4px;margin-left:auto;white-space:nowrap;min-width:0}
.gbt-colsubcount{font-size:9.5px;padding:0 5px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-tertiary);white-space:nowrap;display:inline-flex;align-items:center}
.gbt-colsubcount .gbt-subnum{font-weight:600}
.gbt-colsubcount[data-subcount="ready"]{color:var(--dsw-alias-state-success-primary)}
.gbt-colhead .gbt-colcount{margin-left:6px}
.gbt-done-summary{display:flex;align-items:center;justify-content:space-between;gap:6px;padding:6px 8px;border-radius:7px;border:0.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-2);font-size:10.5px;color:var(--dsw-alias-label-tertiary)}
.gbt-card{padding:9px 10px;gap:6px;min-height:96px}
.gbt-cardtop{justify-content:space-between;flex-wrap:nowrap}
.gbt-cardtopid{display:flex;align-items:center;gap:5px;min-width:0}
.gbt-priority{font-size:9px;padding:1px 5px;border-radius:4px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-tertiary);border:0.5px solid var(--dsw-alias-border-l4);flex:none}
.gbt-cardtitle{font-size:12.5px;line-height:1.42;font-weight:560}
.gbt-cardmeta{font-size:10px;gap:4px}
.gbt-ownerchip{background:transparent;padding-left:0}
.gbt-ownerdot{width:5px;height:5px;border-radius:50%;background:var(--dsw-alias-state-business-primary);display:inline-block;flex:none}
.gbt-cardfoot{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:auto;padding-top:2px}
.gbt-cardstate{display:inline-flex;align-items:center;gap:5px;font-size:10px;color:var(--dsw-alias-label-tertiary);min-width:0}
.gbt-cardstate::before{content:"";width:5px;height:5px;border-radius:50%;background:currentColor;display:inline-block;flex:none;opacity:.9}
.gbt-cardstate .gbt-dot{width:5px;height:5px}
.gbt-cardstate[data-running="true"]{color:var(--dsw-alias-state-business-primary)}
.gbt-cardstate[data-state="done"]{color:var(--dsw-alias-state-success-primary)}
.gbt-cardstate[data-state="reviewing"]{color:var(--dsw-alias-state-business-primary)}
.gbt-cardstate[data-state="testing"]{color:var(--dsw-alias-state-warn-label)}
.gbt-cardstate[data-state="blocked"]{color:var(--dsw-alias-state-error-primary)}
/* T-194: cancelled is terminal, not an error — neutral tertiary like the cancelled pill. */
.gbt-cardstate[data-state="cancelled"]{color:var(--dsw-alias-label-tertiary)}
.gbt-cardtime{font-size:9.5px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;flex:none}
.gbt-context .gbt-workspacebar{flex:0 1 auto;margin:0;padding:0 8px;height:28px;gap:6px;border-radius:8px;font-size:10.5px;max-width:min(430px,42vw);overflow:hidden}
.gbt-context .gbt-workspacebar .gbt-workspacestate{flex:0 1 auto;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.gbt-context .gbt-workspacebar .gbt-workspace .gbt-workspacelabel{display:none}
.gbt-context .gbt-workspacebar .gbt-workspace b{max-width:110px}
.gbt-cardmeta{gap:3px}
.gbt-cardmeta .gbt-chip{padding:0 5px;font-size:9.5px}
@media (max-width:1500px){.gbt-projectpath{max-width:200px}.gbt-context{justify-content:flex-start}}
@media (max-width:1360px){.gbt-colsubcount .gbt-sublabel{display:none}.gbt-colsubcount .gbt-subnum{margin-left:0}
.gbt-colsubcount::before{content:"";width:5px;height:5px;border-radius:50%;background:currentColor;display:inline-block;margin-right:3px}}
@media (max-width:1200px){.gbt-sessionschip{padding:0 7px;gap:5px}.gbt-context{gap:5px}.gbt-toprow{gap:8px}.gbt-board{overflow-x:auto}.gbt-col{min-width:150px}.gbt-col[data-empty="true"]{min-width:132px}}
/* T-160 narrow panels stack the lanes vertically instead of scrolling sideways.
   T-194 that is seven lanes. Only the desktop grid rules above change here. */
@media (max-width:860px){
  .gbt-root{max-width:100%;overflow-x:hidden}
  .gbt-main,.gbt-content,.gbt-view{max-width:100%;min-width:0}
  .gbt-view{overflow-x:hidden;padding:10px 10px 14px}
  .gbt-boardwrap{display:flex;flex-direction:column;width:100%;max-width:100%;height:100%;min-height:0;overflow-x:hidden}
  .gbt-board{display:flex;flex-direction:column;width:100%;max-width:100%;flex:1 1 auto;min-height:0;overflow-x:hidden;overflow-y:auto;gap:10px}
  .gbt-col,.gbt-col[data-group="dispatch"],.gbt-col[data-group="done"],
  .gbt-col[data-empty="true"],.gbt-col[data-group="dispatch"][data-empty="true"],
  .gbt-col[data-group="dispatch"][data-collapsed="true"]{width:100%;max-width:none;min-width:0;flex:0 0 auto;max-height:none;min-height:0}
  .gbt-col[data-group="dispatch"] .gbt-colhead,.gbt-col[data-group="dispatch"] .gbt-colname,
  .gbt-col[data-group="dispatch"] .gbt-colcount,.gbt-col[data-group="dispatch"] .gbt-colsubcounts,
  .gbt-col[data-group="dispatch"] .gbt-colsubcount{white-space:nowrap}
  .gbt-col[data-group="dispatch"] .gbt-colsubcounts{margin-left:auto;flex:0 1 auto;overflow:hidden}
  .gbt-cards{overflow:visible;flex:0 0 auto;min-height:0;max-height:none}
  .gbt-card,.gbt-col[data-group="done"] .gbt-card{max-width:none;width:100%}
  .gbt-cardtitle{display:block;-webkit-line-clamp:unset}
  .gbt-emptyslim{min-height:56px}
  .gbt-toprow{flex-wrap:wrap;gap:6px;padding:8px 10px}
  .gbt-brand{flex:1 1 auto;min-width:0}
  .gbt-projectpath{display:none}
  .gbt-projectname{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .gbt-context{flex:1 1 100%;justify-content:flex-start;gap:5px;min-width:0;flex-wrap:wrap}
  .gbt-context .gbt-workspacebar{max-width:100%}
  .gbt-topactions{margin-left:auto;gap:5px}
  .gbt-toolbar{flex-direction:column;align-items:stretch;padding:0 8px;gap:2px}
  .gbt-toolbar .gbt-tabs{width:100%;max-width:100%;overflow-x:auto}
  .gbt-toolbarright{justify-content:flex-end;flex-wrap:wrap;padding:0 0 5px}
  .gbt-statusbar{padding:6px 10px;gap:6px}
  /* T-162: in a narrow panel the agent-tree popover anchors to the RIGHT edge
     of its pill so it cannot cross the panel edge; the session popover keeps
     its left anchor but both are capped to the viewport. Desktop unchanged. */
  .gbt-anchor .gbt-agentpopover{left:auto;right:0;min-width:0;width:min(280px,calc(100vw - 24px));max-width:calc(100vw - 24px)}
  .gbt-anchor .gbt-sessionpopover{left:0;right:auto;max-width:min(320px,calc(100vw - 24px))}
  .gbt-popover{max-width:calc(100vw - 24px);max-height:min(420px,calc(100vh - 140px))}
}`,
		].join('')

		/** ISO-8601 to epoch milliseconds, or null. */

const { tcTime, tcAgo, tcLease, tcStatusKey, tcMergeOf, tcReviewOf, tcTestOf, tcStageQueued, tcPhaseOf, tcKindOf, tcIsInvestigation, tcFirstNonEmptyColumn, tcReportInline, tcReportInlineChild, tcReportTableCells, tcReportTableSeparator, tcReportFence, tcReportBlocks, tcInvestigationPhaseLabel, tcPhaseLabel, tcPhaseTone, tcMergeLabel, tcMergeTone, tcReviewLabel, tcReviewTone, tcTestLabel, tcTestTone, tcRound, tcTail, tcBaseName, tcSessionShort, tcAgentTreeOf, tcAgentStatusKey, outputBlock, tcParseList, tcParseFiles } = (function () {
	const module = { exports: {} }
	;(function (module, exports) {
		function tcTime(value) {
			if (typeof value !== 'string') return null
			const at = Date.parse(value)
			return Number.isFinite(at) ? at : null
		}

		function tcAgo(value, now) {
			const at = typeof value === 'number' ? value : tcTime(value)
			if (at === null) return '—'
			const seconds = Math.max(0, Math.round((now - at) / 1000))
			if (seconds < 60) return String(seconds) + 's'
			const minutes = Math.round(seconds / 60)
			if (minutes < 60) return String(minutes) + 'm'
			const hours = Math.round(minutes / 60)
			if (hours < 24) return String(hours) + 'h'
			return String(Math.round(hours / 24)) + 'd'
		}

		/**
		 * The lease chip. It prefers the host's own leaseRemaining/leaseExpired/
		 * leaseReminder (the host is the authority on liveness) and falls back to
		 * the raw leaseUntil for callers that only have the timestamp.
		 */
		function tcLease(value, now, t, task) {
			const record = task === undefined || task === null ? null : task
			const at = tcTime(value)
			const remaining = record !== null && Number.isFinite(record.leaseRemaining) ? record.leaseRemaining : at === null ? null : at - now
			if (remaining === null) return null
			if (remaining <= 0 || (record !== null && record.leaseExpired === true)) return { text: t('leaseExpired'), warn: true, expired: true }
			const minutes = Math.max(0, Math.ceil(remaining / 60000))
			const text = minutes < 60 ? String(minutes) + 'm' : String(Math.round(minutes / 60)) + 'h'
			const remind = record !== null && record.leaseReminder === true
			return { text: t('leaseLeft') + ' ' + text, warn: remind === true || minutes <= 3, remind: remind }
		}

		function tcStatusKey(status) {
			return 'status' + status.charAt(0).toUpperCase() + status.slice(1)
		}

		/** Merge/review/test vocabulary shared by the card and the detail drawer. */
		const MERGE_LABELS = { open: 'mergeOpen', merged: 'mergeMerged', conflict: 'mergeConflict', failed: 'mergeFailed', rejected: 'mergeRejected' }
		const MERGE_TONES = { open: 'running', merged: 'done', conflict: 'broken', failed: 'blocked', rejected: 'cancelled' }
		const REVIEW_LABELS = { pending: 'reviewPending', approved: 'reviewApproved', 'changes-requested': 'reviewChanges' }
		const REVIEW_TONES = { pending: 'waiting', approved: 'done', 'changes-requested': 'broken' }
		const TEST_LABELS = { pending: 'testPending', passed: 'testPassed', failed: 'testFailed' }
		const TEST_TONES = { pending: 'waiting', passed: 'done', failed: 'broken' }
		const PHASE_LABELS = {
			running: 'runningCol',
			reviewing: 'reviewingCol',
			testing: 'testingCol',
			done: 'doneCol',
			blocked: 'statusBlocked',
			cancelled: 'statusCancelled',
		}
		const PHASE_TONES = { running: 'running', reviewing: 'reviewing', testing: 'testing', done: 'done', blocked: 'blocked', cancelled: 'cancelled' }

		function tcMergeOf(task) {
			const merge = task === null || task === undefined ? null : task.merge
			return merge !== null && merge !== undefined && typeof merge === 'object' && !Array.isArray(merge) ? merge : null
		}

		function tcReviewOf(task) {
			const review = task === null || task === undefined ? null : task.review
			return review !== null && review !== undefined && typeof review === 'object' && !Array.isArray(review) ? review : null
		}

		function tcTestOf(task) {
			const test = task === null || task === undefined ? null : task.test
			return test !== null && test !== undefined && typeof test === 'object' && !Array.isArray(test) ? test : null
		}

		/**
		 * True only while the card is still WAITING for its current stage's slot. A
		 * delivered round (review.deliveredAt / test.deliveredAt set) is already being
		 * worked on, so the queued chip must be gone even if a stale queuePosition
		 * survives from the server.
		 */
		function tcStageQueued(task) {
			if (task === null || task === undefined) return false
			if (!Number.isFinite(task.queuePosition) || task.queuePosition <= 0) return false
			const review = tcReviewOf(task)
			const test = tcTestOf(task)
			if (task.status === 'reviewing') return !(review !== null && typeof review.deliveredAt === 'string' && review.deliveredAt !== '')
			if (task.status === 'testing') return !(test !== null && typeof test.deliveredAt === 'string' && test.deliveredAt !== '')
			return false
		}

		/**
		 * The current phase as the board shows it. A pending task is either READY
		 * or WAITING; that split is derived from the Host's dependency report, not
		 * guessed from the dependency list.
		 */
		function tcPhaseOf(task) {
			const status = task === null || task === undefined ? 'pending' : task.status
			if (status === 'pending') {
				const dependency = task.dependency
				return dependency !== undefined && dependency !== null && dependency.state === 'ready' ? 'ready' : 'waiting'
			}
			return typeof status === 'string' && PHASE_LABELS[status] !== undefined ? status : 'waiting'
		}

		/**
		 * T-132: a card is either mergeable work ('dev', the historical default) or an
		 * investigation that delivers a report. A stored/legacy card without the field
		 * reads as dev, exactly like the server-side normalisation.
		 */
		function tcKindOf(task) {
			return task !== null && task !== undefined && task.kind === 'investigate' ? 'investigate' : 'dev'
		}

		function tcIsInvestigation(task) {
			return tcKindOf(task) === 'investigate'
		}

		/**
		 * T-135: the first column that actually has cards, or null when every column
		 * is empty. The board scrolls there on data/filter changes so a done-only
		 * board does not open on a screenful of empty columns.
		 */
		function tcFirstNonEmptyColumn(groups) {
			if (!Array.isArray(groups)) return null
			for (let index = 0; index < groups.length; index += 1) {
				const group = groups[index]
				if (group !== null && group !== undefined && Array.isArray(group.tasks) && group.tasks.length > 0) return group.key
			}
			return null
		}

		/**
		 * T-144/T-147: render a report body as light, SAFE Markdown. No dependency and
		 * no innerHTML: every node carries plain text. Headings (#/## -> h3, ### -> h4),
		 * `- ` and `1. ` lists, `>` quotes, pipe tables (with :---/---: alignment),
		 * ``` / ~~~ fences and inline **bold** / *italic* / `code` are understood.
		 * Unrecognised lines stay paragraph text (nothing is dropped). Only an
		 * unterminated fence falls the whole body back to a <pre>.
		 */
		function tcReportInline(value) {
			const text = String(value === undefined || value === null ? '' : value)
			const nodes = []
			let buffer = ''
			let index = 0
			const flush = function () {
				if (buffer === '') return
				nodes.push(buffer)
				buffer = ''
			}
			while (index < text.length) {
				const char = text.charAt(index)
				if (char === '`') {
					const end = text.indexOf('`', index + 1)
					if (end > index + 1) {
						flush()
						nodes.push(h('code', { key: 'inline-code-' + String(nodes.length), className: 'gbt-reportinline' }, text.slice(index + 1, end)))
						index = end + 1
						continue
					}
				}
				if (char === '*' && text.charAt(index + 1) === '*') {
					const end = text.indexOf('**', index + 2)
					if (end > index + 2) {
						flush()
						nodes.push(h('strong', { key: 'bold-' + String(nodes.length) }, tcReportInlineChild(text.slice(index + 2, end))))
						index = end + 2
						continue
					}
				}
				if (char === '*') {
					const end = text.indexOf('*', index + 1)
					if (end > index + 1 && text.charAt(end + 1) !== '*') {
						flush()
						nodes.push(h('em', { key: 'em-' + String(nodes.length) }, tcReportInlineChild(text.slice(index + 1, end))))
						index = end + 1
						continue
					}
				}
				if (char === '_') {
					const end = text.indexOf('_', index + 1)
					if (end > index + 1 && /[A-Za-z0-9]/.test(index === 0 ? '' : text.charAt(index - 1)) === false && /[A-Za-z0-9]/.test(text.charAt(end + 1)) === false) {
						flush()
						nodes.push(h('em', { key: 'em-' + String(nodes.length) }, tcReportInlineChild(text.slice(index + 1, end))))
						index = end + 1
						continue
					}
				}
				buffer += char
				index += 1
			}
			flush()
			return nodes
		}
		function tcReportInlineChild(value) {
			const nodes = tcReportInline(value)
			if (nodes.length === 0) return ''
			return nodes.length === 1 && typeof nodes[0] === 'string' ? nodes[0] : nodes
		}
		function tcReportTableCells(line) {
			let value = String(line).trim()
			if (value.charAt(0) === '|') value = value.slice(1)
			if (value.charAt(value.length - 1) === '|') value = value.slice(0, -1)
			return value.split('|').map(function (cell) { return cell.trim() })
		}
		function tcReportTableSeparator(line) {
			const cells = tcReportTableCells(line)
			if (cells.length === 0) return null
			const alignments = []
			for (const cell of cells) {
				if (/^:?-{3,}:?$/.test(cell) === false) return null
				const left = cell.charAt(0) === ':'
				const right = cell.charAt(cell.length - 1) === ':'
				alignments.push(left && right ? 'center' : left ? 'left' : right ? 'right' : null)
			}
			return alignments
		}
		function tcReportFence(line) {
			const match = /^(`{3,}|~{3,})(.*)$/.exec(String(line))
			if (match === null) return null
			return { marker: match[1], char: match[1].charAt(0), length: match[1].length }
		}
		function tcReportBlocks(text) {
			try {
				const lines = String(text === undefined || text === null ? '' : text).replace(/\r\n/g, '\n').split('\n')
				const nodes = []
				let index = 0
				let paragraph = []
				const flushParagraph = function () {
					if (paragraph.length === 0) return
					nodes.push(h('p', { key: 'p-' + String(nodes.length), className: 'gbt-reportpara', 'data-report-block': 'paragraph' }, tcReportInlineChild(paragraph.join('\n'))))
					paragraph = []
				}
				while (index < lines.length) {
					const line = lines[index]
					const fence = tcReportFence(line)
					if (fence !== null) {
						flushParagraph()
						const code = []
						index += 1
						let terminated = false
						while (index < lines.length) {
							const close = String(lines[index]).trim()
							let sameChar = close.length >= fence.length
							if (sameChar) {
								for (let at = 0; at < close.length; at += 1) {
									if (close.charAt(at) !== fence.char) { sameChar = false; break }
								}
							}
							if (sameChar) { terminated = true; break }
							code.push(lines[index])
							index += 1
						}
						// Only an unterminated fence is a parse failure: the outer catch keeps the
						// whole body in a <pre> instead of guessing where the code ends.
						if (terminated !== true) throw new Error('unterminated code fence')
						index += 1
						nodes.push(h('pre', { key: 'code-' + String(nodes.length), className: 'gbt-reportcode', 'data-report-block': 'code' }, h('code', null, code.join('\n'))))
						continue
					}
					const heading = /^(#{1,3})\s+(.*)$/.exec(line)
					if (heading !== null) {
						flushParagraph()
						nodes.push(h(heading[1].length <= 2 ? 'h3' : 'h4', { key: 'h-' + String(nodes.length), className: 'gbt-reportheading', 'data-report-block': 'heading', 'data-report-level': String(heading[1].length) }, tcReportInlineChild(heading[2])))
						index += 1
						continue
					}
					if (line.indexOf('|') >= 0 && index + 1 < lines.length) {
						const alignments = tcReportTableSeparator(lines[index + 1])
						const header = tcReportTableCells(line)
						if (alignments !== null && header.length > 0 && alignments.length === header.length) {
							flushParagraph()
							const rows = []
							index += 2
							while (index < lines.length && String(lines[index]).indexOf('|') >= 0 && String(lines[index]).trim() !== '') {
								rows.push(tcReportTableCells(lines[index]))
								index += 1
							}
							const columnStyle = function (at) { return alignments[at] === null ? undefined : { textAlign: alignments[at] } }
							nodes.push(h('div', { key: 'table-' + String(nodes.length), className: 'gbt-reporttablescroll', 'data-report-block': 'table' },
								h('table', { className: 'gbt-reporttable gbt-reportmdtable' },
									h('thead', null, h('tr', null, header.map(function (cell, at) { return h('th', { key: 'h' + String(at), style: columnStyle(at) }, tcReportInlineChild(cell)) }))),
									h('tbody', null, rows.map(function (row, rowIndex) { return h('tr', { key: 'r' + String(rowIndex) }, header.map(function (cell, at) { return h('td', { key: 'c' + String(at), style: columnStyle(at) }, tcReportInlineChild(row[at] === undefined ? '' : row[at])) })) })),
								)));
							continue
						}
					}
					if (/^\s*[-*]\s+/.test(line)) {
						flushParagraph()
						const items = []
						while (index < lines.length && /^\s*[-*]\s+/.test(lines[index])) {
							items.push(lines[index].replace(/^\s*[-*]\s+/, ''))
							index += 1
						}
						nodes.push(h('ul', { key: 'ul-' + String(nodes.length), className: 'gbt-reportlist', 'data-report-block': 'list' }, items.map(function (item, at) { return h('li', { key: String(at), className: 'gbt-reportlistitem' }, tcReportInlineChild(item)) })))
						continue
					}
					if (/^\s*\d+[.)]\s+/.test(line)) {
						flushParagraph()
						const items = []
						while (index < lines.length && /^\s*\d+[.)]\s+/.test(lines[index])) {
							items.push(lines[index].replace(/^\s*\d+[.)]\s+/, ''))
							index += 1
						}
						nodes.push(h('ol', { key: 'ol-' + String(nodes.length), className: 'gbt-reportlist', 'data-report-block': 'ordered-list' }, items.map(function (item, at) { return h('li', { key: String(at), className: 'gbt-reportlistitem' }, tcReportInlineChild(item)) })))
						continue
					}
					if (/^\s*>\s?/.test(line)) {
						flushParagraph()
						const quoted = []
						while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
							quoted.push(lines[index].replace(/^\s*>\s?/, ''))
							index += 1
						}
						nodes.push(h('blockquote', { key: 'quote-' + String(nodes.length), className: 'gbt-reportquote', 'data-report-block': 'quote' }, tcReportInlineChild(quoted.join('\n'))))
						continue
					}
					if (line.trim() === '') {
						flushParagraph()
						index += 1
						continue
					}
					paragraph.push(line)
					index += 1
				}
				flushParagraph()
				return nodes.length === 0 ? [h('p', { key: 'empty', className: 'gbt-footnote', 'data-report-block': 'empty' }, '—')] : nodes
			} catch (error) {
				return [h('pre', { key: 'fallback', className: 'gbt-reportbody', 'data-report-block': 'fallback' }, String(text === undefined || text === null ? '' : text))]
			}
		}
				/** The phase word an investigation shows: 待调查 / 调查中 / 报告已交付. */
		function tcInvestigationPhaseLabel(task, t) {
			if (task.status === 'pending') return t('investigatePending')
			if (task.status === 'running') return t('statusInvestigating')
			if (task.status === 'done') return t('reportDelivered')
			return t(tcStatusKey(task.status))
		}

		function tcPhaseLabel(task, t) {
			if (tcIsInvestigation(task)) return tcInvestigationPhaseLabel(task, t)
			const phase = tcPhaseOf(task)
			if (phase === 'ready') return t('ready')
			if (phase === 'waiting') return t('waiting')
			return t(PHASE_LABELS[phase])
		}

		function tcPhaseTone(task) {
			const phase = tcPhaseOf(task)
			if (phase === 'ready') return 'ready'
			if (phase === 'waiting') return 'waiting'
			return PHASE_TONES[phase] || 'waiting'
		}

		function tcMergeLabel(status, t) {
			const key = MERGE_LABELS[status]
			return key === undefined ? String(status === undefined || status === null ? '—' : status) : t(key)
		}

		function tcMergeTone(status) {
			return MERGE_TONES[status] || 'waiting'
		}

		function tcReviewLabel(status, t) {
			const key = REVIEW_LABELS[status]
			return key === undefined ? String(status === undefined || status === null ? '—' : status) : t(key)
		}

		function tcReviewTone(status) {
			return REVIEW_TONES[status] || 'waiting'
		}

		function tcTestLabel(status, t) {
			const key = TEST_LABELS[status]
			return key === undefined ? String(status === undefined || status === null ? '—' : status) : t(key)
		}

		function tcTestTone(status) {
			return TEST_TONES[status] || 'waiting'
		}

		/** The round counter on a phase record; a missing count reads as round 0. */
		function tcRound(record) {
			const value = record === null || record === undefined ? 0 : record.attempt
			return Number.isFinite(value) ? Math.floor(value) : 0
		}

		/** The last max CHARACTERS (not UTF-16 units), so a surrogate pair survives. */
		function tcTail(text, max) {
			const value = String(text === undefined || text === null ? '' : text)
			const characters = Array.from(value)
			if (characters.length <= max) return { text: value, truncated: false }
			return { text: characters.slice(characters.length - max).join(''), truncated: true }
		}

		function tcBaseName(path) {
			const parts = String(path === undefined || path === null ? '' : path).split(/[\\/]/).filter(function (part) { return part !== '' })
			return parts.length === 0 ? String(path) : parts[parts.length - 1]
		}

		/** A session id's useful part: after the "session-" prefix, else the first 8 chars. */
		function tcSessionShort(value) {
			if (typeof value !== 'string' || value === '') return null
			return value.indexOf('session-') === 0 ? value.slice(8, 16) : value.slice(0, 8)
		}

		/**
		 * The live execution tree the Host reports: the root Agent plus every live
		 * child. There is no roster file and no per-session team; an answer without
		 * an agentTree block is UNAVAILABLE, never a fabricated membership.
		 */
		function tcAgentTreeOf(snapshot) {
			const source =
				snapshot !== null && snapshot !== undefined && snapshot.agentTree !== null && snapshot.agentTree !== undefined && typeof snapshot.agentTree === 'object'
					? snapshot.agentTree
					: null
			if (source === null) return { available: false, root: null, members: [], count: 0, error: null }
			const root = source.root !== null && source.root !== undefined && typeof source.root === 'object' ? source.root : null
			const members = (Array.isArray(source.members) ? source.members : []).filter(function (member) {
				return member !== null && member !== undefined && typeof member === 'object'
			})
			return {
				available: source.available === true,
				root: root,
				members: members,
				count: Number.isFinite(source.count) ? source.count : members.length,
				error: typeof source.error === 'string' && source.error !== '' ? source.error : null,
			}
		}

		/** A live tree member's display status key; an unknown status stays unknown. */
		function tcAgentStatusKey(status) {
			if (status === 'running') return 'agentStatusRunning'
			if (status === 'idle' || status === 'inactive') return 'agentStatusIdle'
			if (status === 'failed') return 'agentStatusFailed'
			return 'agentStatusUnknown'
		}

		/** One labelled tail-only output block inside the drawer. */
		function outputBlock(key, label, text, t) {
			const tail = tcTail(text, 1200)
			return h(
				'div',
				{ key: key, className: 'gbt-outputblock' },
				h('div', { className: 'gbt-subhead' }, label),
				text === ''
					? h('p', { className: 'gbt-footnote' }, t('noOutput'))
					: h('pre', { className: 'gbt-output' }, (tail.truncated ? '… ' + t('outputTailHint') + '\n' : '') + tail.text),
			)
		}

		function tcParseList(text) {
			return String(text === undefined || text === null ? '' : text)
				.split(/[\s,]+/)
				.map(function (part) { return part.trim() })
				.filter(function (part) { return part.length > 0 })
		}

		function tcParseFiles(text) {
			return String(text === undefined || text === null ? '' : text)
				.split(/[\n,]+/)
				.map(function (part) { return part.trim() })
				.filter(function (part) { return part.length > 0 })
		}

		/**
		 * The client Context captured in apply(), so the session resolver can ask the
		 * DSH shell which session it is showing (T-99). Null in a build that never
		 * called apply (tests that only exercise a helper).
		 */
		let tcHostContext = null

		/**
		 * The REAL session id the Host UI is showing, or null when it does not say.
		 *
		 * DSH's browser shell keeps the shown session in two places, both owned by the
		 * Host: `uiWorkspace.selection` (a persisted snapshot store, localStorage key
		 * `dsh.sessions.current`, written whenever the main session is swapped) and
		 * `uiSession.current` (the main-view binding). They carry the SAME id the tool
		 * path receives as `agent.id`, which is what makes the panel share the session
		 * binding without any URL parameter.
		 *
		 * This is deliberately a read, never a guess: a missing service, an empty
		 * selection or a closed session returns null, and the caller falls back to the
		 * per-window id — never to "the most recently active session" or a global slot.
		 */
		

module.exports = {
  tcTime,
  tcAgo,
  tcLease,
  tcStatusKey,
  tcMergeOf,
  tcReviewOf,
  tcTestOf,
  tcStageQueued,
  tcPhaseOf,
  tcKindOf,
  tcIsInvestigation,
  tcFirstNonEmptyColumn,
  tcReportInline,
  tcReportInlineChild,
  tcReportTableCells,
  tcReportTableSeparator,
  tcReportFence,
  tcReportBlocks,
  tcInvestigationPhaseLabel,
  tcPhaseLabel,
  tcPhaseTone,
  tcMergeLabel,
  tcMergeTone,
  tcReviewLabel,
  tcReviewTone,
  tcTestLabel,
  tcTestTone,
  tcRound,
  tcTail,
  tcBaseName,
  tcSessionShort,
  tcAgentTreeOf,
  tcAgentStatusKey,
  outputBlock,
  tcParseList,
  tcParseFiles,
}

	})(module, module.exports)
	return module.exports
})()
function tcHostSessionId() {
			const read = function (value) {
				return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
			}
			const service = function (name) {
				try {
					return tcHostContext !== null && tcHostContext !== undefined && typeof tcHostContext.get === 'function' ? tcHostContext.get(name) : null
				} catch (error) {
					return null
				}
			}
			try {
				const workspace = service('uiWorkspace')
				if (workspace !== null && workspace !== undefined) {
					const selection = workspace.selection
					if (selection !== null && selection !== undefined && typeof selection.getSnapshot === 'function') {
						const saved = selection.getSnapshot()
						const chosen = read(saved === null || saved === undefined ? null : saved.sessionId)
						if (chosen !== null) return chosen
					}
					// The live retained reference covers the moment before the persisted
					// selection is written (and a shell that keeps the store empty).
					const retained = read(workspace.mainReference === null || workspace.mainReference === undefined ? null : workspace.mainReference.sessionId)
					if (retained !== null) return retained
				}
			} catch (error) {
				/* a shell that throws on inspection tells us nothing: fall through */
			}
			try {
				const session = service('uiSession')
				// Two shapes of the same binding: the underlying source and the
				// renderer-facing adapter (what a session-scoped slot would receive).
				const sources = []
				if (session !== null && session !== undefined) {
					sources.push(session.current)
					if (session.adapter !== null && session.adapter !== undefined) sources.push(session.adapter.current)
				}
				for (const current of sources) {
					if (current === null || current === undefined) continue
					const value = typeof current.getSnapshot === 'function' ? current.getSnapshot() : current.value
					if (value === null || value === undefined) continue
					const key = read(value.key)
					if (key !== null) return key
					const id = read(value.sessionId)
					if (id !== null) return id
				}
			} catch (error) {
				/* same: no identity from this source */
			}
			return null
		}

		/**
		 * The session id this panel acts as, plus where it came from (T-99):
		 *
		 *   'url'    an explicit ?session= on the page URL (Host or tool override);
		 *   'host'   the DSH shell's own current session — the id the tool path gets
		 *            as agent.id, so the panel follows the session with no parameter;
		 *   'window' a per-window id minted here, kept in sessionStorage so two windows
		 *            are two sessions (the T-96 fallback when the Host says nothing).
		 */
		let tcFallbackSessionId = null

		function tcSessionIdInfo() {
			let fromUrl = null
			try {
				fromUrl =
					typeof window.location === 'object' && window.location !== null && typeof window.location.search === 'string'
						? new URLSearchParams(window.location.search).get('session')
						: null
			} catch (error) {
				fromUrl = null
			}
			if (typeof fromUrl === 'string' && fromUrl.length > 0) return { id: fromUrl, source: 'url' }
			const hosted = tcHostSessionId()
			if (hosted !== null) return { id: hosted, source: 'host' }
			return { id: tcWindowSessionId(), source: 'window' }
		}

		function tcSessionId() {
			return tcSessionIdInfo().id
		}

		/** The per-window fallback identity (T-96): minted once, kept in sessionStorage. */
		function tcWindowSessionId() {
			try {
				const store =
					typeof window.sessionStorage === 'object' && window.sessionStorage !== null && typeof window.sessionStorage.getItem === 'function'
						? window.sessionStorage
						: window.localStorage
				// The self-minted id must not collide with a Host id either.

				let id = store.getItem(TC_SESSION_KEY)
				if (typeof id !== 'string' || id.length === 0) {
					id = 'web-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36)
					store.setItem(TC_SESSION_KEY, id)
				}
				return id
			} catch (error) {
				// Storage is unavailable: mint a page-level id instead of one shared
				// constant, which would make every window the same session again.
				if (tcFallbackSessionId === null) {
					tcFallbackSessionId = 'web-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36)
				}
				return tcFallbackSessionId
			}
		}

		function tcWithSession(url) {
			return url + (url.indexOf('?') >= 0 ? '&' : '?') + 'session=' + encodeURIComponent(tcSessionId())
		}

		/**
		 * The project the human PINNED in this browser (T-90). Empty means "follow
		 * the host": the panel sends no project at all and the server resolves the
		 * session workspace, so a fresh browser never asks for a path. Only an
		 * explicit switch writes this key — the panel no longer records whatever the
		 * Host happened to answer, which is what turned the session's project into a
		 * stale manual pin.
		 */
		function tcPinnedProject() {
			try {
				const value = window.localStorage.getItem(TC_PROJECT_KEY)
				if (typeof value !== 'string' || value.length === 0) return null
				if (value.indexOf(TC_PROJECT_PREFIX) === 0) {
					const pinned = value.slice(TC_PROJECT_PREFIX.length)
					return pinned.length > 0 ? pinned : null
				}
				// Legacy auto-recorded value (pre-T-90): not a user choice. Migrate it
				// away once so it can never be misread as a manual pin again.
				try {
					if (typeof window.localStorage.removeItem === 'function') window.localStorage.removeItem(TC_PROJECT_KEY)
					else window.localStorage.setItem(TC_PROJECT_KEY, '')
					window.localStorage.setItem(TC_PROJECT_MIGRATED_KEY, '1')
				} catch (error) {
					/* storage can be disabled; the value is simply ignored */
				}
				return null
			} catch (error) {
				return null
			}
		}

		/** Pin a project for this browser (write = bind: the caller also sends openProject). */
		function tcPinProject(project) {
			try {
				if (typeof project === 'string' && project.length > 0) window.localStorage.setItem(TC_PROJECT_KEY, TC_PROJECT_PREFIX + project)
			} catch (error) {
				/* storage can be disabled; pinning is a convenience */
			}
		}

		/** Same project, however the two sides spell the path (mirrors projectIdOf). */
		function tcSameProject(left, right) {
			if (typeof left !== 'string' || typeof right !== 'string' || left === '' || right === '') return false
			const normalise = function (value) {
				const text = String(value).replace(/\\/g, '/').replace(/\/+$/, '')
				return /^[A-Za-z]:\//.test(text) ? text.toLowerCase() : text
			}
			return normalise(left) === normalise(right)
		}

		const TC_COLUMNS_KEY = 'godotBridge.taskCenter.columns'
		const DONE_COLUMN_PREVIEW = 5
		/** T-132: the board's kind filter ('all' | 'dev' | 'investigate'). Module state
		 * so switching tabs keeps it; the panel rerenders through onKindFilterChange. */
		const boardUiState = { kind: 'all' }

		/** Column collapse state, remembered across reloads (done starts collapsed). */
		function tcReadColumnState() {
			try {
				const raw = window.localStorage.getItem(TC_COLUMNS_KEY)
				const parsed = raw === null ? null : JSON.parse(raw)
				return parsed !== null && typeof parsed === 'object' ? parsed : {}
			} catch (error) {
				return {}
			}
		}

		function tcColumnCollapsed(key) {
			const state = tcReadColumnState()
			if (typeof state[key] === 'boolean') return state[key]
			return key === 'done'
		}

		function tcWriteColumnCollapsed(key, collapsed) {
			try {
				const state = tcReadColumnState()
				state[key] = collapsed === true
				window.localStorage.setItem(TC_COLUMNS_KEY, JSON.stringify(state))
			} catch (error) {
				/* storage can be disabled; collapsing is a convenience */
			}
		}

		/** One shape for the view, whatever the Host answered. */
		function tcSnapshot(payload, source, message, actionResult) {
			const tasks = Array.isArray(payload.tasks) ? payload.tasks : []
			return {
				ok: payload.ok !== false,
				source: source,
				message: message === undefined ? '' : message,
				project: typeof payload.project === 'string' ? payload.project : null,
				projectRoot: typeof payload.projectRoot === 'string' ? payload.projectRoot : typeof payload.project === 'string' ? payload.project : null,
				// Where the Host got this project: 'session' (walked up from the session
				// workspace), 'panel' (this browser pinned it) or 'registry'. The panel
				// shows it beside the title so "which project is this" is answerable.
				resolvedFrom: typeof payload.resolvedFrom === 'string' ? payload.resolvedFrom : null,
				// What the SESSION resolves to, independent of the panel's pin. The
				// mismatch bar compares it with `project`.
				sessionProject: typeof payload.sessionProject === 'string' ? payload.sessionProject : null,
				// The Host's own note when its registry last drove another project; the
				// source badge shows it as a tooltip instead of a second banner.
				projectWarning: typeof payload.projectWarning === 'string' ? payload.projectWarning : null,
				// T-108: main-checkout cleanliness, when it was read and which cards
				// are waiting on it — the panel separates a merge-window blip from a
				// really dirty checkout with this.
				environment: payload.environment === undefined || payload.environment === null ? null : payload.environment,
				// T-155: the explicit project/session scope (projectSessions, sessionSummaries,
				// panelSession, currentSessionProject). The panel groups cards BY SESSION
				// from this; no session is primary.
				scope: payload.scope === undefined || payload.scope === null || typeof payload.scope !== 'object' ? null : payload.scope,
				// v3: the live execution tree — the root Agent plus every live child.
				// It is the only membership view the panel renders; the legacy
				// team/teams/workers/agents blocks are not carried into the UI state.
				agentTree: payload.agentTree === undefined || payload.agentTree === null || typeof payload.agentTree !== 'object' ? null : payload.agentTree,
				// How full the board file is: { bytes, limit, percent, level, cards,
				// bytesPerCard, headroomCards, warning }. The status page warns at 50%
				// and 75% of the cap, before the file stops loading at all.
				boardSize: payload.boardSize !== undefined && payload.boardSize !== null && typeof payload.boardSize === 'object' ? payload.boardSize : null,
				dispatch: payload.dispatch !== undefined && payload.dispatch !== null ? payload.dispatch : { state: 'paused' },
				counts: payload.counts !== undefined && payload.counts !== null ? payload.counts : {},
				queue: Array.isArray(payload.queue) ? payload.queue : [],
				// T-154: the real merge queue ({ active, queued, chains, last }) from the
				// merger, or null when the host has none. Never derived from queue.
				mergeQueue: payload.mergeQueue === undefined || payload.mergeQueue === null ? null : payload.mergeQueue,
				tasks: tasks,
				locks: Array.isArray(payload.locks) ? payload.locks : [],
				worktrees: payload.worktrees === undefined || payload.worktrees === null ? null : payload.worktrees,
				activity: payload.activity === undefined || payload.activity === null ? null : payload.activity,
				// T-111: the status timeline the Host derives from the board (task
				// history + merge records); no memory ring, survives restarts.
				activityEvents: payload.activityEvents === undefined || payload.activityEvents === null ? null : payload.activityEvents,
				// The merge sweep is telemetry now, never an activity event.
				lastSweep: payload.lastSweep === undefined || payload.lastSweep === null ? null : payload.lastSweep,
				roles: payload.roles === undefined || payload.roles === null ? null : payload.roles,
				scheduler: payload.scheduler === undefined ? null : payload.scheduler,
				actionResult: actionResult === undefined || actionResult === null ? null : actionResult,
				actionError: payload.actionError === undefined || payload.actionError === null ? null : payload.actionError,
				version: payload.version,
				seq: Number.isFinite(payload.seq) ? payload.seq : null,
				archivedCount: Number.isFinite(payload.archivedCount) ? payload.archivedCount : 0,
				archiveRange: payload.archiveRange === undefined ? null : payload.archiveRange,
				full: payload.full !== false,
				details: {},
				updatedAt: typeof payload.updatedAt === 'string' ? payload.updatedAt : null,
				serverTime: payload.serverTime,
			}
		}

		/**
		 * Apply a state answer to the previous snapshot. `full:false` is a delta
		 * (changed summaries + removed ids) and is merged; `full:true` replaces
		 * the board (the client clears and rebuilds, as the protocol requires).
		 */
		function tcMergeSnapshot(previous, payload) {
			if (payload.full === false && previous !== null && previous !== undefined && previous.seq !== null && Array.isArray(previous.tasks)) {
				const byId = new Map(previous.tasks.map(function (task) { return [task.id, task] }))
				const details = Object.assign({}, previous.details)
				for (const task of (Array.isArray(payload.tasks) ? payload.tasks : [])) {
					const before = byId.get(task.id)
					if (before !== undefined && before.updatedAt !== task.updatedAt) delete details[task.id]
					byId.set(task.id, Object.assign({}, before === undefined ? {} : before, task))
				}
				for (const id of (Array.isArray(payload.removed) ? payload.removed : [])) {
					byId.delete(id)
					delete details[id]
				}
				return Object.assign({}, previous, payload, {
					tasks: Array.from(byId.values()),
					details: details,
					seq: Number.isFinite(payload.seq) ? payload.seq : previous.seq,
					full: false,
				})
			}
			const next = tcSnapshot(payload, 'host', '')
			next.details = {}
			return next
		}

		/**
		 * Localized text for a Host failure. The Host sends a stable code (+ optional
		 * params); the panel renders the code from TC_DICT. An unknown code falls back
		 * to the Host's own message so an older/newer Host still says something real.
		 */
		function tcErrorMessage(payload, t) {
			if (payload === null || payload === undefined || typeof payload !== 'object') return t('error')
			const code = typeof payload.code === 'string' ? payload.code.trim() : ''
			const params = payload.params !== null && typeof payload.params === 'object' ? payload.params : {}
			if (code !== '') {
				const key = 'err_' + code.replace(/[^A-Za-z0-9]+/g, '_').toLowerCase()
				const localized = t(key)
				if (typeof localized === 'string' && localized !== key) {
					return localized.replace(/\{([A-Za-z0-9_]+)\}/g, function (match, name) {
						return params[name] === undefined || params[name] === null ? match : String(params[name])
					})
				}
			}
			if (typeof payload.message === 'string' && payload.message !== '') return payload.message
			return t('error')
		}

		/**
		 * The Host binding. It owns two things only: fetch the snapshot, send an
		 * action. It keeps no board state of its own, so a failed request cannot
		 * fabricate work.
		 */

const createTaskStore = (function () {
	const module = { exports: {} }
	;(function (module, exports) {
		function createTaskStore(t, deps) {
			const {
				TC_STATE_URL,
				TC_WORKTREES_URL,
				TC_TASK_URL,
				TC_LIST_URL,
				TC_ACTION_URL,
				tcSnapshot,
				tcPinnedProject,
				tcMergeSnapshot,
				tcErrorMessage,
				tcWithSession,
				tcSessionId,
				tcPinProject,
			} = deps
			// The first paint shows the pinned project when there is one; with an empty
			// pin it shows nothing yet and the first /state answers with the project the
			// session resolves to (no path to type, T-90).
			let snapshot = tcSnapshot({
				ok: false,
				project: tcPinnedProject(),
				dispatch: { state: 'paused' },
				tasks: [],
				counts: {},
			}, 'loading', '')
			// T-195: the host's pending decisions and the local arrival time of the
			// snapshot they came with. The modal counts down from the SERVER's
			// remainingMs, corrected by this receipt time.
			snapshot.decisions = []
			// T-198: the resolved decision policy (settings page). Carried exactly
			// like the decision queue: server-owned, never derived in the browser.
			snapshot.decisionPolicy = null
			snapshot.receivedAt = Date.now()
			// T-111: the Host answers the activity timeline incrementally. Keep what we
			// already have and ask only for events after the last one we saw.
			let activityCursor = null
			let activityLog = []
			// T-210: the deferred metadata (agent tree, worktrees, environment, the
			// activity timeline, roles, decision policy, archive) is its own request.
			// `light=1` /state answers with the board AND the light session scope, so
			// the cards and the header are ready immediately; the metadata is merged
			// in when it arrives and NEVER blocks the board or the ready state.
			//
			// /meta is derived from /state so the two halves can never point at
			// different routes (the bundle has no second constant to keep in sync).
			const TC_META_URL = TC_STATE_URL.replace(/\/state\/?$/, '/meta')
			// The host advertises the split on every answer (`metadata.split`). An
			// older host that omits it is never asked for /meta: the full /state it
			// answered already carries everything.
			let metaSupported = false
			let metaCache = null
			let metaErrors = {}
			// idle | loading | ready | degraded — the view reports it as
			// data-metadata-state so 'header ready' never means 'inventory done'.
			let metaStatus = 'idle'
			let metaAt = 0
			// The project the cached answer DESCRIBES. A metadata answer is only ever
			// merged onto a snapshot of the same project (a project switch must never
			// paint project A's agent tree onto project B's board).
			let metaProject = null
			// { key, refresh, promise } — one metadata request per project.
			let metaFlight = null
			// The newest metadata request owns the snapshot; an older answer is
			// discarded instead of overwriting it.
			let metaSeq = 0
			const listeners = new Set()
			let loading = null
			let timer = null
			let busy = null
			// T-208: a decision answer is one-shot and two surfaces can submit it
			// (the panel's modal and the conversation-page overlay). One store backs
			// both, so these two guards are what stop a double submit: an answer in
			// flight refuses a second one, and an id whose answer already landed is
			// refused even after the response. A FAILED send clears both, so a
			// transport error can still be retried.
			const answeringDecisions = new Set()
			const answeredDecisions = new Set()
			let decisionsLoading = null
			// T-211: did the conversation-page overlay actually mount? The Host may
			// not offer the optional 'shell.overlay' slot (or the registration may
			// throw). The task-center header reads this to offer its own clickable
			// fallback only when the floating entry can never be there.
			let decisionOverlayMounted = false
			// T-211: a hung decision-list request must not wedge the queue forever.
			// After this long the poll gives up, releases the single-flight guard and
			// the next tick starts a fresh request.
			const DECISION_LOAD_TIMEOUT_MS = 15000
			const DECISION_LOAD_TIMEOUT = { timedOut: true }
			// T-182: "no project is bound to this session" is the EXPECTED answer
			// before the first project is opened. It is a SETUP state, not a failure:
			// routing it into the error banner put "操作失败" over a panel that was
			// correctly asking the user to pick a project. Its text is carried by the
			// empty state (open-project entry) instead.
			const UNBOUND_CODE = 'no-project-bound'
			// Where the current banner text came from, so the next poll knows whether
			// it may drop it: 'action' is the user's last action outcome (a routine
			// poll keeps it), 'state' is this endpoint's own failure (the next good
			// /state clears it), null means there is nothing to keep.
			let messageKind = null

			/** The host's expected "nothing is bound" refusal ({ ok:false, code }). */
			function isUnbound(payload) {
				return payload !== null && typeof payload === 'object' && payload.ok !== true && payload.code === UNBOUND_CODE
			}

			function emit(next) {
				snapshot = applyMetadata(Object.assign({}, next, { busy: busy }))
				listeners.forEach(function (listener) {
					listener()
				})
			}

			/** Does this Host advertise the split (/state light + /meta deferred)? */
			function isMetaSplit(payload) {
				return (
					payload !== null &&
					typeof payload === 'object' &&
					payload.metadata !== null &&
					typeof payload.metadata === 'object' &&
					payload.metadata.split === true
				)
			}

			function setBusy(next) {
				if (busy === next) return
				busy = next
				emit(snapshot)
			}

			/**
			 * T-210: merge the last GOOD metadata answer onto a snapshot.
			 *
			 * A light /state answer carries the board and the light scope; the heavy
			 * blocks come from /meta (or from an older Host's full answer). A full
			 * rebuild drops the heavy fields, so this re-applies the cached ones
			 * instead of flashing them to null. A FAILED metadata request changes
			 * nothing here: the board keeps rendering and `metadata.status` says
			 * 'degraded', so the view can word the affected pill instead of spinning.
			 */
			function applyMetadata(next) {
				// T-210 review: NEVER merge an answer that describes another project.
				// The status is scoped the same way, so a switch shows "loading" for the
				// new board instead of the old board's ready/degraded state.
				const project = projectKeyOf(next.project)
				const projectMatches = project !== null && metaProject !== null && project === metaProject
				next.metadata = projectMatches
					? { status: metaStatus, errors: metaErrors, receivedAt: metaAt === 0 ? null : metaAt }
					: { status: 'idle', errors: {}, receivedAt: null }
				if (metaCache === null || !projectMatches) return next
				if (metaCache.scope !== undefined && metaCache.scope !== null) next.scope = metaCache.scope
				if (metaCache.agentTree !== undefined && metaCache.agentTree !== null) next.agentTree = metaCache.agentTree
				if (metaCache.worktrees !== undefined && metaCache.worktrees !== null) next.worktrees = metaCache.worktrees
				if (metaCache.environment !== undefined) next.environment = metaCache.environment
				if (metaCache.roles !== undefined) next.roles = metaCache.roles
				if (metaCache.rolePreviews !== undefined) next.rolePreviews = metaCache.rolePreviews
				if (metaCache.decisionPolicy !== undefined && metaCache.decisionPolicy !== null) next.decisionPolicy = metaCache.decisionPolicy
				if (metaCache.archivedCount !== undefined && metaCache.archivedCount !== null) next.archivedCount = metaCache.archivedCount
				if (metaCache.archiveRange !== undefined && metaCache.archiveRange !== null) next.archiveRange = metaCache.archiveRange
				if (metaCache.nextStep !== undefined) next.nextStep = metaCache.nextStep
				if (activityLog.length > 0) {
					next.activityEvents = {
						available: true,
						source: 'board',
						entries: activityLog.slice(0, 50),
						count: Math.min(activityLog.length, 50),
						total: activityLog.length,
						truncated: false,
						cursor: activityCursor,
					}
				}
				return next
			}

			/**
			 * T-195: carry the pending decision queue onto a snapshot. The server
			 * sends each request's remainingMs, so the countdown is measured from
			 * the server deadline; receivedAt turns it into a local elapsed time.
			 */
			function withDecisions(next, payload) {
				const host =
					payload !== null && payload !== undefined && payload.snapshot !== undefined && payload.snapshot !== null
						? payload.snapshot
						: payload
				if (host !== null && host !== undefined && Array.isArray(host.decisions)) next.decisions = host.decisions
				else if (!Array.isArray(next.decisions)) next.decisions = []
				// T-198: the policy rides the same snapshot; a payload without one (a
				// delta, or an older Host) keeps the last known policy instead of
				// blanking the settings page.
				if (host !== null && host !== undefined && host.decisionPolicy !== undefined && host.decisionPolicy !== null) next.decisionPolicy = host.decisionPolicy
				else if (next.decisionPolicy === undefined) next.decisionPolicy = null
				next.receivedAt = Date.now()
				return next
			}

			async function fetchJson(url, options) {
				const response = await fetch(url, options)
				return await response.json()
			}

			/** Accumulate the Host's incremental activity page (cursor + dedupe by key). */
			function absorbActivity(events) {
				if (events === null || events === undefined || !Array.isArray(events.entries)) return
				const known = new Set(activityLog.map(function (entry) { return entry.key }))
				events.entries.forEach(function (entry) {
					if (entry !== null && typeof entry === 'object' && typeof entry.key === 'string' && !known.has(entry.key)) activityLog.push(entry)
				})
				activityLog.sort(function (left, right) { return new Date(right.at).getTime() - new Date(left.at).getTime() })
				activityLog = activityLog.slice(0, 100)
				if (typeof events.cursor === 'string' && events.cursor !== '') activityCursor = events.cursor
			}

			/** One project identity, however the two sides spell the path. */
			function projectKeyOf(value) {
				if (typeof value !== 'string' || value === '') return null
				const text = String(value).replace(/\\/g, '/').replace(/\/+$/, '')
				return /^[A-Za-z]:\//.test(text) ? text.toLowerCase() : text
			}

			/**
			 * The /meta URL for the project the panel is SHOWING (not the pin alone:
			 * during an openProject the pin still names the OLD project while the board
			 * already shows the new one). `refresh` forces the host to rebuild.
			 */
			function metaUrlFor(project, refresh) {
				let url = TC_META_URL + '?project=' + encodeURIComponent(project)
				if (refresh === true) url += '&refresh=1'
				if (activityCursor !== null) url += '&activitySince=' + encodeURIComponent(activityCursor)
				return tcWithSession(url)
			}

			/**
			 * Drop the cached metadata when the panel starts describing another project.
			 * The NEW project becomes the expected owner of the next answer.
			 */
			function resetMeta(project) {
				metaCache = null
				metaErrors = {}
				metaStatus = 'idle'
				metaAt = 0
				metaProject = projectKeyOf(project)
			}

			/**
			 * T-210: load the DEFERRED metadata. Single flight PER PROJECT, never
			 * awaited by the board's render path. A failure degrades only the deferred
			 * blocks: the snapshot keeps its board, its light scope and its 'ready'
			 * state. `options.refresh` asks the host to rebuild (used after an action);
			 * a forced refresh is never satisfied by a routine in-flight request.
			 */
			async function loadMeta(options) {
				const o = options === undefined || options === null ? {} : options
				if (metaSupported !== true) return null
				const project = typeof snapshot.project === 'string' && snapshot.project !== '' ? snapshot.project : null
				if (project === null) return null
				const key = projectKeyOf(project)
				const refresh = o.refresh === true
				// A request for ANOTHER project invalidates the cached answer and the
				// reported status BEFORE it lands: nothing of the old board may be shown
				// as the new board's metadata.
				if (metaProject !== key) {
					metaCache = null
					metaErrors = {}
					metaAt = 0
					metaProject = key
					metaStatus = 'idle'
				}
				if (metaFlight !== null && metaFlight.key === key && (refresh !== true || metaFlight.refresh === true)) return metaFlight.promise
				if (metaStatus === 'idle' || (refresh === true && metaStatus !== 'loading')) {
					metaStatus = 'loading'
					emit(snapshot)
				}
				const seq = ++metaSeq
				const request = (async function () {
					try {
						const payload = await fetchJson(metaUrlFor(project, refresh), { headers: { accept: 'application/json' } })
						// A NEWER request (or a project switch) owns the snapshot now: this
						// answer describes a board that is no longer on screen, so discard it.
						if (seq !== metaSeq || projectKeyOf(snapshot.project) !== key) return { ok: false, stale: true }
						if (payload === null || payload === undefined || payload.ok !== true) {
							metaStatus = 'degraded'
							metaErrors =
								payload !== null && payload !== undefined && payload.errors !== null && typeof payload.errors === 'object'
									? payload.errors
									: payload !== null && payload !== undefined && typeof payload.message === 'string' && payload.message !== ''
										? { message: payload.message }
										: {}
							metaProject = key
							emit(snapshot)
							return { ok: false, payload: payload === undefined ? null : payload }
						}
						if (isMetaSplit(payload)) metaSupported = true
						const meta = payload.meta !== undefined && payload.meta !== null && typeof payload.meta === 'object' ? payload.meta : null
						absorbActivity(meta === null ? null : meta.activityEvents)
						metaCache = meta
						metaErrors = payload.errors !== undefined && payload.errors !== null && typeof payload.errors === 'object' ? payload.errors : {}
						metaAt = Date.now()
						metaProject = key
						metaStatus = Object.keys(metaErrors).length > 0 ? 'degraded' : 'ready'
						emit(snapshot)
						return { ok: true, payload: payload }
					} catch (error) {
						// A transport failure is a DEGRADED metadata state, never a board error.
						if (seq !== metaSeq || projectKeyOf(snapshot.project) !== key) return { ok: false, stale: true }
						metaStatus = 'degraded'
						metaErrors = { message: String((error && error.message) || error) }
						metaProject = key
						emit(snapshot)
						return { ok: false, error: error }
					} finally {
						if (metaFlight !== null && metaFlight.promise === request) metaFlight = null
					}
				})()
				metaFlight = { key: key, refresh: refresh, promise: request }
				return request
			}

			/**
			 * One poll. `options.refresh` forces the deferred metadata to be rebuilt
			 * (the panel's refresh action); the routine 2.5 s poll keeps the host's
			 * short-TTL answer.
			 */
			async function load(options) {
				const o = options === undefined || options === null ? {} : options
				if (loading !== null) return loading
				// No pin means NO ?project=: the Host resolves the session workspace and
				// answers with the project, which is the whole point of T-90.
				const pinned = tcPinnedProject()
				// The v3 panel consumes agentTree/scope; the snapshot no longer carries
				// any Team inventory, so there is no opt-out to ask for.
				let url = pinned === null ? TC_STATE_URL : TC_STATE_URL + '?project=' + encodeURIComponent(pinned)
				// T-210: the light first paint. The heavy metadata (agent tree, worktrees,
				// environment, activity timeline, roles, decision policy, archive) is a
				// SEPARATE request, so this answer is never held up by a host inventory.
				url += (url.indexOf('?') >= 0 ? '&' : '?') + 'light=1'
				if (snapshot.seq !== null && snapshot.seq !== undefined) url += '&since=' + String(snapshot.seq)
				url = tcWithSession(url)
				// T-210: NO second first-paint request. `light=1` IS the first paint.
				loading = (async function () {
					try {
						const payload = await fetchJson(url, { headers: { accept: 'application/json' } })
						if (isUnbound(payload) === true) {
							// No project yet — the expected pre-setup answer. Keep project null so
							// the view renders its open-project entry points, say nothing, and
							// leave no message behind for the binding to inherit.
							// T-203: the setup snapshot NAMES its source. 'unbound' is not a
							// project: it is "this session resolves to nothing", so the panel
							// never shows a last-active project as if the session owned it. An
							// older Host that omits the field is read the same way.
							const unbound = tcSnapshot(Object.assign({}, payload, { ok: true, project: null, projectRoot: null, tasks: [], resolvedFrom: 'unbound', sessionProject: null }), 'setup', '')
							withDecisions(unbound, payload)
							unbound.actionResult = snapshot.actionResult
							unbound.actionError = snapshot.actionError
							messageKind = null
							// T-210: no project means no metadata to show (and none from the
							// project the panel was on before).
							resetMeta(null)
							activityLog = []
							activityCursor = null
							emit(unbound)
						} else if (payload && payload.ok === true && (Array.isArray(payload.tasks) || payload.full === false)) {
							// The Host's answer is NOT written to localStorage: only an explicit
							// switch pins a project, so "follow the session" stays the default.
							// Only an ACTION's outcome survives a routine poll (see below); what
							// refreshes here is the board data.
							const next = withDecisions(tcMergeSnapshot(snapshot, payload), payload)
							// T-111: accumulate the incremental activity page. A project switch
							// starts a new log (the old project's events no longer apply).
							if (next.project !== snapshot.project) {
								activityLog = []
								activityCursor = null
								// T-210: the deferred blocks describe the OLD project; drop them.
								resetMeta(next.project)
								// T-208: decision ids are project-scoped; an id answered in project A
								// must not block the same id in project B.
								answeredDecisions.clear()
							}
							// An OLDER Host answers /state with the activity timeline itself; a
							// split Host sends it from /meta (absorbed in loadMeta).
							if (payload.activityEvents !== undefined && payload.activityEvents !== null) absorbActivity(payload.activityEvents)
							if (isMetaSplit(payload)) metaSupported = true
							if (next.activityEvents !== null && next.activityEvents !== undefined) {
								next.activityEvents = Object.assign({}, next.activityEvents, { entries: activityLog.slice(0, 50) })
							}
							next.actionResult = snapshot.actionResult
							next.actionError = snapshot.actionError
							// A routine poll keeps the user's last ACTION outcome (only the board
							// data refreshes), but the transport's own text stops being true the
							// moment /state answers again: clear it, so neither the unbound notice
							// nor a real failure outlives the binding that fixes it.
							next.message = messageKind === 'action' ? snapshot.message : ''
							if (messageKind !== 'action') messageKind = null
							emit(next)
							// T-210: the board (and the header's base facts) are painted; the
							// deferred metadata is refreshed in the BACKGROUND and can fail
							// without touching the board or the ready state.
							void loadMeta(o.refresh === true ? { refresh: true } : undefined)
						} else {
							const failed = tcSnapshot(Object.assign({}, payload, { tasks: [] }), 'error', tcErrorMessage(payload, t))
							failed.decisions = snapshot.decisions
							failed.decisionPolicy = snapshot.decisionPolicy
							failed.receivedAt = snapshot.receivedAt
							failed.actionResult = snapshot.actionResult
							failed.actionError = snapshot.actionError
							messageKind = 'state'
							emit(failed)
						}
					} catch (error) {
						const offline = tcSnapshot(Object.assign({}, snapshot, { tasks: [] }), 'error', String((error && error.message) || error))
						offline.decisions = snapshot.decisions
						offline.decisionPolicy = snapshot.decisionPolicy
						offline.receivedAt = snapshot.receivedAt
						offline.actionResult = snapshot.actionResult
						offline.actionError = snapshot.actionError
						messageKind = 'state'
						emit(offline)
					} finally {
						loading = null
					}
				})()
				return loading
			}

			/**
			 * Send one action. options.quiet marks an AUTOMATIC call (the prompt
			 * preview): it may refresh board data, but it never enters the
			 * action-result channel, so an automatic request can neither fake nor
			 * clear the banner of the user's last real action.
			 */
			async function send(action, body, options) {
				const opts = options === undefined || options === null ? {} : options
				const quiet = opts.quiet === true
				// T-208: serialize decision answers per request id. The panel modal and
				// the shell overlay both call this store; whichever submits second gets
				// a duplicate result instead of a second POST.
				const decisionId =
					action === 'decisionAnswer' && body !== undefined && body !== null && typeof body.decisionId === 'string' && body.decisionId !== ''
						? body.decisionId
						: null
				if (decisionId !== null) {
					if (answeredDecisions.has(decisionId)) return { ok: false, duplicate: true, payload: { ok: false, code: 'already-answered' } }
					if (answeringDecisions.has(decisionId)) return { ok: false, duplicate: true, payload: { ok: false, code: 'answer-in-flight' } }
					answeringDecisions.add(decisionId)
				}
				const payloadBody = Object.assign({ action: action }, body === undefined ? {} : body)
				payloadBody.session = tcSessionId()
				const project = tcPinnedProject()
				if (project !== null) payloadBody.project = project
				const token = { action: action, id: body !== undefined && body !== null && (body.id !== undefined ? body.id : body.requestId !== undefined ? body.requestId : body.taskId !== undefined ? body.taskId : body.path !== undefined ? body.path : null) }
				setBusy(token)
				try {
					const payload = await fetchJson(tcWithSession(TC_ACTION_URL), {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify(payloadBody),
					})
					if (payload && payload.ok === true) {
						const host = payload.snapshot !== undefined && payload.snapshot !== null ? payload.snapshot : payload
						if (host && Array.isArray(host.tasks)) {
							const next = withDecisions(tcSnapshot(host, 'host', '', payload), host)
							// T-196 review: the ANSWER landed but the host action it stood for
							// failed (the board moved on, the card is not deletable, ...). The
							// modal disappears with the decision, so the SAME banner a failed
							// action uses must explain that nothing happened. An intentional
							// 取消创建 is not a failure.
							const applied = payload.applied !== undefined && payload.applied !== null && typeof payload.applied === 'object' ? payload.applied : null
							const appliedFailed = applied !== null && applied.ok === false && applied.code !== 'decision-rejected'
							if (quiet) {
								next.actionResult = snapshot.actionResult
								next.actionError = snapshot.actionError
								next.message = snapshot.message
							} else if (appliedFailed) {
								messageKind = 'action'
								next.message = typeof applied.message === 'string' && applied.message !== '' ? applied.message : t('decisionAppliedFailed')
								next.actionResult = null
								next.actionError = applied
							} else {
								// A real action answered: whatever the banner said is no longer current.
								messageKind = null
							}
							if (decisionId !== null) answeredDecisions.add(decisionId)
							// An action's answer (or openProject's full snapshot) also advertises
							// the split; learn it here so a panel that bound a project before its
							// first poll still asks for the deferred half.
							if (isMetaSplit(host) || isMetaSplit(payload)) metaSupported = true
							// T-210 review: the answer may describe ANOTHER project (openProject).
							// The metadata of the old board must not survive onto the new one, and
							// the next /meta must describe the project the board now shows.
							if (projectKeyOf(next.project) !== projectKeyOf(snapshot.project)) resetMeta(next.project)
							emit(next)
							// T-210: an action changes host state (worktrees, environment, roles).
							// Refresh the deferred blocks in the background; the action answer
							// itself only carried the light board. A real action forces a rebuild
							// so the panel never shows pre-action worktrees/environment/roles for
							// up to the cache TTL; a QUIET automatic call may reuse the cache.
							void loadMeta(quiet ? undefined : { refresh: true })
						} else if (decisionId !== null) {
							// T-208: the answer response carries no snapshot. Drop the answered
							// request from the queue right away so BOTH surfaces advance to the
							// next decision without waiting for the next poll (which the caller
							// still asks for to confirm the canonical list).
							answeredDecisions.add(decisionId)
							emit(Object.assign({}, snapshot, {
								decisions: (Array.isArray(snapshot.decisions) ? snapshot.decisions : []).filter(function (entry) { return entry === null || entry === undefined || entry.id !== decisionId }),
								receivedAt: Date.now(),
							}))
						}
						return { ok: true, payload: payload }
					}
					if (!quiet) {
						if (isUnbound(payload) === true) {
							// The action was refused because no project is bound yet: the same
							// setup state /state reports, not a failed operation.
							messageKind = null
							emit(Object.assign({}, snapshot, { source: 'setup', message: '', actionResult: null, actionError: null }))
						} else {
							messageKind = 'action'
							emit(Object.assign({}, snapshot, { message: tcErrorMessage(payload, t), actionResult: null, actionError: payload === undefined || payload === null ? null : payload }))
						}
					}
					return { ok: false, payload: payload }
				} catch (error) {
					if (!quiet) {
						// A failed action is still an ACTION outcome: it survives polls like any
						// other, instead of being cleared by the next good /state.
						messageKind = 'action'
						emit(Object.assign({}, snapshot, { message: String((error && error.message) || error) }))
					}
					return { ok: false, error: error }
				} finally {
					if (decisionId !== null) answeringDecisions.delete(decisionId)
					if (busy === token) setBusy(null)
				}
			}

			/**
			 * T-208: refresh ONLY the pending decision queue. The conversation-page
			 * overlay polls this instead of /state, so a shell overlay never pulls the
			 * whole board every few seconds. It reads and writes no other snapshot
			 * field and never enters the action-result channel (a background poll must
			 * not raise the task-center banner).
			 */
			async function loadDecisions(options) {
				// T-211: SINGLE FLIGHT per queue refresh. Every surface (the panel and
				// the conversation overlay) shares this promise instead of racing N
				// decisionList requests, and a hung one cannot block the next tick:
				// the optional timeout releases the guard in `finally`.
				if (decisionsLoading !== null) return decisionsLoading
				const opts = options === undefined || options === null ? {} : options
				const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : DECISION_LOAD_TIMEOUT_MS
				decisionsLoading = (async function () {
					let timer = null
					try {
						const body = { action: 'decisionList', decisionStatus: 'pending', session: tcSessionId() }
						const project = tcPinnedProject()
						if (project !== null) body.project = project
						const request = fetchJson(tcWithSession(TC_ACTION_URL), {
							method: 'POST',
							headers: { 'content-type': 'application/json' },
							body: JSON.stringify(body),
						})
						let timeout = null
						if (typeof setTimeout === 'function') {
							timeout = new Promise(function (resolve) {
								timer = setTimeout(function () { resolve(DECISION_LOAD_TIMEOUT) }, timeoutMs)
							})
							// The race may settle on the timeout first; the late request must
							// not surface as an unhandled rejection.
							request.catch(function () {})
						}
						const payload = timeout === null ? await request : await Promise.race([request, timeout])
						if (payload === DECISION_LOAD_TIMEOUT) return { ok: false, timedOut: true, payload: null }
						if (payload !== null && payload !== undefined && payload.ok === true && Array.isArray(payload.decisions)) {
							// withDecisions carries the queue and the receipt time the countdown
							// needs; every other field (tasks, project, banner) stays as it is.
							emit(withDecisions(Object.assign({}, snapshot), payload))
							return { ok: true, decisions: payload.decisions }
						}
						return { ok: false, payload: payload === undefined ? null : payload }
					} catch (error) {
						return { ok: false, error: error }
					} finally {
						if (timer !== null && typeof clearTimeout === 'function') clearTimeout(timer)
						decisionsLoading = null
					}
				})()
				return decisionsLoading
			}

			/**
			 * T-211: the conversation-page overlay marks itself when it renders, so
			 * the panel header knows whether 'shell.overlay' really produced an
			 * entry. A missing slot never calls this, which is exactly the fallback
			 * condition.
			 */
			function markDecisionOverlayMounted() {
				decisionOverlayMounted = true
			}

			/** Is the shell overlay entry available in this Host shell? */
			function decisionOverlayAvailable() {
				return decisionOverlayMounted === true
			}

			/** One page of the server-side completed list (T-82 /list route). */
			async function listTasks(query) {
				const opts = query === undefined || query === null ? {} : query
				const params = []
				const project = tcPinnedProject()
				if (project !== null) params.push('project=' + encodeURIComponent(project))
				params.push('status=' + encodeURIComponent(opts.status === undefined ? 'done' : String(opts.status)))
				if (opts.archived === true) params.push('archived=1')
				if (typeof opts.q === 'string' && opts.q !== '') params.push('q=' + encodeURIComponent(opts.q))
				if (typeof opts.cursor === 'string' && opts.cursor !== '') params.push('cursor=' + encodeURIComponent(opts.cursor))
				params.push('limit=' + String(Number.isFinite(opts.limit) ? opts.limit : 50))
				try {
					// /list and /task need the same session identity as /state: the Host
					// only reads the requesting session's binding, so without it "follow
					// the session" would show an empty done/archive list forever.
					const listUrl = tcWithSession(TC_LIST_URL + '?' + params.join('&'))
					const payload = await fetchJson(listUrl, { headers: { accept: 'application/json' } })
					return payload === null || payload === undefined ? { ok: false, tasks: [], nextCursor: null } : payload
				} catch (error) {
					return { ok: false, tasks: [], nextCursor: null }
				}
			}

			/**
			 * Fetch one task's full detail on demand (drawer/view open). Cached per
			 * task updatedAt, so a poll that did not change the card never refetches;
			 * a changed card drops its cache entry in tcMergeSnapshot.
			 */
			const detailInFlight = new Set()
			async function loadDetail(id) {
				const summary = snapshot.tasks.filter(function (task) { return task.id === id })[0]
				if (summary === undefined) return
				const cached = snapshot.details[id]
				if (cached !== undefined && cached.updatedAt === summary.updatedAt) return
				if (detailInFlight.has(id)) return
				detailInFlight.add(id)
				try {
					const project = tcPinnedProject()
					const url = tcWithSession(TC_TASK_URL + '?id=' + encodeURIComponent(id) + (project === null ? '' : '&project=' + encodeURIComponent(project)))
					const payload = await fetchJson(url, { headers: { accept: 'application/json' } })
					if (payload && payload.ok === true && payload.task !== undefined && payload.task !== null) {
						emit(Object.assign({}, snapshot, {
							details: Object.assign({}, snapshot.details, { [id]: { task: payload.task, updatedAt: summary.updatedAt } }),
						}))
					}
				} catch (error) {
					// A failed detail fetch must not blank the card: the summary stays.
				} finally {
					detailInFlight.delete(id)
				}
			}

			/**
			 * Switch the panel's project (T-90). "Write is bind": the browser pin and
			 * the HOST binding move together — the pin alone would leave the panel on
			 * A while the scheduler keeps driving B. openProject proves the directory
			 * (and, since T-86, writes the project registry), so a failed switch pins
			 * nothing.
			 */
			async function switchProject(path, options) {
				const next = typeof path === 'string' ? path.trim() : ''
				if (next === '') return { ok: false, payload: { ok: false, code: 'missing-path' } }
				const opts = options === undefined || options === null ? {} : options
				// T-155: an AUTOMATIC workspace follow is quiet — it must not raise the
				// global action banner; the workspace scope bar carries its own error.
				const result = await send('openProject', { path: next }, opts.quiet === true ? { quiet: true } : undefined)
				if (result.ok !== true) return result
				tcPinProject(next)
				// T-208: decision ids are project-scoped (see load()).
				answeredDecisions.clear()
				// Binding ANSWERS the setup state, so the banner goes away with the project
				// it asked for. An AUTOMATIC follow (quiet) must not clear the user's last
				// real action outcome — that is the quiet contract.
				const explicit = opts.quiet !== true
				if (explicit) messageKind = null
				const bound = Object.assign({}, snapshot, {
					project: next,
					projectRoot: next,
					resolvedFrom: 'panel',
					source: snapshot.source === 'setup' || snapshot.source === 'error' ? 'host' : snapshot.source,
				})
				if (explicit) bound.message = ''
				// T-210: the metadata cache belongs to the OLD project. The pin is already
				// set, so the request below names the NEW project explicitly.
				if (metaProject !== projectKeyOf(next)) resetMeta(next)
				emit(bound)
				void loadMeta()
				return result
			}

			/**
			 * T-146: lazy dirty/merged probe. /state only carries the worktree
			 * inventory; the status card asks this endpoint for the checkouts it
			 * actually shows (one request, no snapshot attached).
			 */
			async function loadWorktrees(paths) {
				const params = []
				const pinned = tcPinnedProject()
				if (pinned !== null) params.push('project=' + encodeURIComponent(pinned))
				if (Array.isArray(paths)) {
					paths.forEach(function (path) {
						if (typeof path === 'string' && path !== '') params.push('path=' + encodeURIComponent(path))
					})
				}
				const url = tcWithSession(TC_WORKTREES_URL + (params.length === 0 ? '' : '?' + params.join('&')))
				try {
					const payload = await fetchJson(url, { headers: { accept: 'application/json' } })
					return payload === null || payload === undefined ? { ok: false } : payload
				} catch (error) {
					return { ok: false, error: String((error && error.message) || error) }
				}
			}

			function startPolling(ms) {
				if (timer !== null) return
				timer = setInterval(function () {
					void load()
				}, ms)
			}

			function stopPolling() {
				if (timer !== null) clearInterval(timer)
				timer = null
			}

			return {
				subscribe(listener) {
					listeners.add(listener)
					return function () {
						listeners.delete(listener)
					}
				},
				getSnapshot() {
					return snapshot
				},
				load: load,
				// T-210: the deferred metadata can also be refreshed on its own (the
				// panel's refresh action calls load(), which polls both halves).
				loadMeta: loadMeta,
				loadDecisions: loadDecisions,
				// T-211: overlay presence, so the panel header can fall back when the
				// Host shell has no 'shell.overlay' slot.
				markDecisionOverlayMounted: markDecisionOverlayMounted,
				decisionOverlayAvailable: decisionOverlayAvailable,
				DECISION_LOAD_TIMEOUT_MS: DECISION_LOAD_TIMEOUT_MS,
				send: send,
				loadWorktrees: loadWorktrees,
				switchProject: switchProject,
				listTasks: listTasks,
				loadDetail: loadDetail,
				startPolling: startPolling,
				stopPolling: stopPolling,
			}
		}

		module.exports = { createTaskStore }

	})(module, module.exports)
	const factory = module.exports.createTaskStore
	return function (t) {
		return factory(t, {
			TC_STATE_URL: TC_STATE_URL,
			TC_WORKTREES_URL: TC_WORKTREES_URL,
			TC_TASK_URL: TC_TASK_URL,
			TC_LIST_URL: TC_LIST_URL,
			TC_ACTION_URL: TC_ACTION_URL,
			tcSnapshot: tcSnapshot,
			tcPinnedProject: tcPinnedProject,
			tcMergeSnapshot: tcMergeSnapshot,
			tcErrorMessage: tcErrorMessage,
			tcWithSession: tcWithSession,
			tcSessionId: tcSessionId,
			tcPinProject: tcPinProject,
		})
	}
})()

		const agentSidebarModule = (function () {
			const module = { exports: {} }
			;(function (module, exports) {
/**
 * Agent sidebar tab (T-209, extended by T-212, corrected by T-216).
 *
 * The task center can open the AGENT behind a card in DSH's native right
 * sidebar. This module owns everything that needs the host's optional sidebar
 * services:
 *
 *   - one custom tab type/kind/id ('godot-bridge-agent' / 'godot-bridge/agent'),
 *     registered through `sidebarRightTabs` as `multiple`, so every open mints
 *     its own tab instance; the body and title are OUR React components
 *     registered into 'sidebar.right.pane.tab' and ...'.title';
 *   - `openIn(agentSession, taskId?)`, the one call the card/detail entry uses.
 *     It opens the tab in the CURRENT HOST SESSION — the only session whose
 *     right sidebar has an adopted surface — and carries the agent session and
 *     the exact card in the tab's navigation params, so the body resolves THAT
 *     agent and THAT card instead of the panel's current one (T-216: passing
 *     the agent session itself to `sidebarRight.openTabIn` was a silent host
 *     no-op, because a subagent session owns no sidebar surface);
 *   - the tab body/title: agent name, role, status, task id, stage and the
 *     latest activity, read from the SHARED task store;
 *   - the body's "open subagent conversation" action, which asks the host's
 *     `uiWorkspace.openSession(sessionId)` to switch the main view to the
 *     agent's own conversation. Without `uiWorkspace` the action is hidden.
 *
 * The host services are OPTIONAL. A shell without the sidebar services never
 * mounts, `available()` stays false, `openIn()` returns false without throwing,
 * and the card/detail hide their entry instead of rendering a dead button. A
 * mounted tab without `uiWorkspace` still renders its overview; only the
 * conversation switch is omitted.
 *
 * The session id is never minted here: it is the card's own agent session,
 * resolved in the card's own order (assignee, then lastAssignee, then the
 * review deliverer, then the test deliverer, then the owning session). The
 * panel's window fallback session is deliberately NOT used.
 *
 * T-216 — which session opens the tab, and which session it shows, are two
 * different questions:
 *
 *   - the OPENING session is the host's current session
 *     (`uiWorkspace.selection.getSnapshot().sessionId`). Only a session with an
 *     adopted sidebar surface has a tab strip; `sidebarRight.openTabIn` silently
 *     no-ops for any other id and returns nothing, so a call is not proof. The
 *     open therefore requires a host session (no fallback to the agent's own
 *     session) and then asks `sidebarRight.tabsIn(hostSession)` before and after
 *     the call: our kind must really be in the strip, otherwise the entry
 *     reports false instead of pretending it worked;
 *   - the SHOWN agent travels in the navigation params (`agentSession`), next to
 *     the exact card (`taskId`). The body/title resolve the card from `taskId`
 *     first, then fall back to the agent session, and only then to the tab's own
 *     navigation session (the host session, or whatever a directly mounted body
 *     was handed).
 *
 * T-218 — one card, one tab (the user-visible regressions):
 *
 *   - the tab type declares `multiple: true`. Without it the host keys the page
 *     by kind alone (`sidebar://godot-bridge-agent`), so the second "open in
 *     sidebar" NAVIGATED the already open tab and its body switched from the
 *     first card to the second. With `multiple` the host mints
 *     `sidebar://<kind>/<uuid>` per open and each tab keeps its own navigation;
 *   - `openIn` proves the tab by the strip DELTA (one more tab, a new identity
 *     and a content address no earlier tab used) instead of "our kind is in the
 *     strip". An older host that still reuses one page reports false, never a
 *     fake success;
 *   - after the tab is placed, `openIn` switches the main view to the HOST
 *     session's conversation (`uiWorkspace.openSession(hostSession)`). From the
 *     plugin page the tab is invisible without that switch, which is what made
 *     the entry look like it did nothing. A host without that service keeps the
 *     tab but reports false instead of claiming the page moved;
 *   - the overview's "open subagent conversation" action switches the main
 *     session to the SUBAGENT, and the right sidebar then belongs to that new
 *     session. Tabs opened in the host session are not carried across sessions;
 *     the copy says so instead of promising a tab that stays visible.
 */
const AGENT_TAB_KIND = 'godot-bridge-agent'
const AGENT_TAB_ID = 'godot-bridge/agent'
const AGENT_TAB_BODY_SLOT = 'sidebar.right.pane.tab'
const AGENT_TAB_TITLE_SLOT = 'sidebar.right.pane.tab.title'
const AGENT_TAB_OPEN_ACTION = 'open-agent-sidebar'
const AGENT_TAB_GUIDE_ORDER = 60
// T-212: the tab's navigation params carry the exact card it was opened from.
const AGENT_TAB_TASK_PARAM = 'taskId'
// T-216: the tab opens in the host session, so the agent it must SHOW travels in
// the params too; the tab's own navigation session is the host, not the agent.
const AGENT_TAB_SESSION_PARAM = 'agentSession'
// The tab has its own small locale namespace so it ships next to the component
// instead of growing the panel's shared dictionary. Labels that already exist in
// the task center namespace (role/status/event/stage words) fall back to it.
const AGENT_TAB_NS = 'godotBridgeAgentTab'

const AGENT_TAB_COPY = {
	zh: {
		openInSidebar: '在侧边栏打开',
		openInSidebarHint: '在右侧栏打开这个任务的 Agent',
		agentTabTitle: '代理',
		agentTabHint: '在右侧栏跟随任务卡上的执行 Agent',
		agentTabStage: '阶段',
		agentTabActivity: '最近活动',
		agentTabNoSession: '没有可显示的会话',
		agentTabNoTask: '没有关联任务',
		agentTabNoActivity: '没有活动记录',
		agentTabOpenSession: '打开子代理对话',
		agentTabOpenSessionHint: '在主页打开这个子代理的对话；主会话会切到子代理，右侧栏属于新会话',
		agentTabSwitchNote: '切到子代理后，右侧栏属于子代理会话，本会话的标签不会跟随',
	},
	en: {
		openInSidebar: 'Open in sidebar',
		openInSidebarHint: 'Open this task\'s agent in the right sidebar',
		agentTabTitle: 'Agent',
		agentTabHint: 'Follow the executor behind a task card in the right sidebar',
		agentTabStage: 'Stage',
		agentTabActivity: 'Recent activity',
		agentTabNoSession: 'No session to show',
		agentTabNoTask: 'No task for this session',
		agentTabNoActivity: 'No activity yet',
		agentTabOpenSession: 'Open subagent conversation',
		agentTabOpenSessionHint: 'Open this subagent\'s conversation in the main view; the main session switches to the subagent, so the sidebar belongs to the new session',
		agentTabSwitchNote: 'After the switch the sidebar belongs to the subagent session; this session\'s tabs do not follow',
	},
}

// The tab's own rules. They use the panel's existing tokens (and the detail
// drawer's classes for the rows), so the tab reads as the same surface.
const AGENT_TAB_CSS =
	'\n/* T-209: the right-sidebar agent tab. */\n' +
	'.gbt-agenttab{display:flex;flex-direction:column;gap:10px;padding:12px;min-width:0;font-size:12px;color:var(--dsw-alias-label-primary)}\n' +
	'.gbt-agenttabhead{display:flex;align-items:center;gap:6px;min-width:0;font-size:13px;font-weight:600}\n' +
	'.gbt-agenttabhead b{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}\n' +
	'.gbt-agenttabhead .gbt-detailwhen{margin-left:auto;font-weight:400}\n' +
	'.gbt-agenttabrows{display:flex;flex-direction:column;gap:5px}\n' +
	'.gbt-agenttabactivity{padding-top:8px;border-top:1px solid var(--dsw-alias-border-l4)}\n' +
	'.gbt-agenttabtitle{display:inline-flex;align-items:center;gap:5px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}\n' +
	// T-212: the conversation switch, a full-width secondary action under the facts.
	'.gbt-agenttabopen{display:inline-flex;align-items:center;justify-content:center;gap:6px;width:100%;height:28px;padding:0 10px;border:0.5px solid var(--dsw-alias-border-l4);border-radius:8px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}\n' +
	'.gbt-agenttabopen:hover{background:var(--dsw-alias-bg-module-platform)}\n' +
	'.gbt-agenttabopen:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}\n' +
	// T-218: the switch changes the main session, so the sidebar that follows belongs
	// to the subagent; the note spells that out instead of letting the user expect
	// this session's tab strip to travel along.
	'.gbt-agenttabnote{margin:0}\n'

const ROLE_LABEL_KEYS = { worker: 'roleKindWorker', reviewer: 'roleKindReviewer', tester: 'roleKindTester' }
const ACTIVITY_LABEL_KEYS = {
	create: 'evtLabel-create',
	retry: 'evtLabel-retry',
	dispatch: 'evtLabel-dispatch',
	submit: 'evtLabel-submit',
	'review-pass': 'evtLabel-review-pass',
	'review-reject': 'evtLabel-review-reject',
	'test-pass': 'evtLabel-test-pass',
	'test-fail': 'evtLabel-test-fail',
	merge: 'evtLabel-merge',
	'merge-rejected': 'evtLabel-merge-rejected',
	blocked: 'evtLabel-blocked',
	cancel: 'evtLabel-cancel',
	'host-check': 'evtLabel-host-check',
	error: 'evtLabel-blocked',
}

/** The mounted runtime, shared by the card/detail entry helpers below. */
let bound = null

function noop() {}

function readService(scope, name) {
	if (scope === null || scope === undefined) return null
	try {
		if (typeof scope.get === 'function') {
			const service = scope.get(name)
			if (service !== null && service !== undefined) return service
		}
	} catch (error) {
		/* an unavailable service is normal; fall through to the property form */
	}
	try {
		return scope[name] === undefined ? null : scope[name]
	} catch (error) {
		return null
	}
}

function releaseOf(value) {
	return typeof value === 'function' ? value : noop
}

function isRecord(value) {
	return value !== null && typeof value === 'object' && Array.isArray(value) !== true
}

function textOf(value) {
	return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

function sessionShort(value) {
	const text = typeof value === 'string' ? value : ''
	if (text === '') return '—'
	return text.indexOf('session-') === 0 ? text.slice(8, 16) : text.slice(0, 8)
}

function shortText(value, max) {
	const text = typeof value === 'string' ? value.trim() : ''
	if (text === '') return ''
	return text.length <= max ? text : text.slice(0, max - 1) + '…'
}

function timeOf(value) {
	if (typeof value !== 'string' || value === '') return 0
	const at = Date.parse(value)
	return Number.isFinite(at) ? at : 0
}

/** One record-shaped field of a card (`{ name, session }` or `{ name, id }`), or null. */
function memberOf(value) {
	return isRecord(value) ? value : null
}

/** The executor session recorded on the card, or null. */
function assignedSessionOf(task) {
	const assignee = isRecord(task) ? memberOf(task.assignee) : null
	return assignee !== null ? textOf(assignee.session) : null
}

/** The previous executor session the host kept when a card was paused/retried. */
function lastAssignedSessionOf(task) {
	const previous = isRecord(task) ? memberOf(task.lastAssignee) : null
	return previous !== null ? textOf(previous.session) : null
}

/** The session a stage record was delivered to (`deliveredTo.id`), or null. */
function deliveredSessionOf(record) {
	if (!isRecord(record)) return null
	const delivered = memberOf(record.deliveredTo)
	return delivered !== null ? textOf(delivered.id) : null
}

function reviewSessionOf(task) {
	return isRecord(task) ? deliveredSessionOf(task.review) : null
}

function testSessionOf(task) {
	return isRecord(task) ? deliveredSessionOf(task.test) : null
}

/**
 * The REAL host session a card belongs to, in the card's own order: the current
 * executor, the previous executor, the review deliverer, the test deliverer,
 * and finally the owning session. Nothing is minted and no panel fallback
 * session is used, so a card without a recorded session has no entry.
 */
function agentSessionOf(task) {
	if (isRecord(task) !== true) return null
	const ordered = [
		assignedSessionOf(task),
		lastAssignedSessionOf(task),
		reviewSessionOf(task),
		testSessionOf(task),
		textOf(task.ownerSession),
	]
	for (const value of ordered) {
		if (value !== null) return value
	}
	return null
}

/** Where a session sits in one card's own record (0 = closest), or null. */
function sessionRankOf(task, sessionId) {
	if (isRecord(task) !== true) return null
	if (assignedSessionOf(task) === sessionId) return 0
	if (lastAssignedSessionOf(task) === sessionId) return 1
	if (reviewSessionOf(task) === sessionId) return 2
	if (testSessionOf(task) === sessionId) return 3
	if (textOf(task.ownerSession) === sessionId) return 4
	return null
}

function activeRankOf(task) {
	return isRecord(task) && (task.status === 'running' || task.status === 'reviewing' || task.status === 'testing') ? 0 : 1
}

/**
 * The most relevant card for a session. A card whose executor IS this session
 * outranks one where it is only the deliverer or owner, then the live stage,
 * then the newest card. This is the fallback used when the tab carries no
 * taskId (the guide overview); a card opened from a card always carries one.
 */
function taskForSession(snapshot, sessionId) {
	const id = textOf(sessionId)
	if (snapshot === null || snapshot === undefined || Array.isArray(snapshot.tasks) !== true || id === null) return null
	const related = []
	for (const task of snapshot.tasks) {
		if (!isRecord(task) || String(task.id === undefined || task.id === null ? '' : task.id) === '') continue
		const rank = sessionRankOf(task, id)
		if (rank !== null) related.push({ task: task, rank: rank })
	}
	if (related.length === 0) return null
	related.sort(function (left, right) {
		return left.rank - right.rank || activeRankOf(left.task) - activeRankOf(right.task) || timeOf(right.task.updatedAt) - timeOf(left.task.updatedAt)
	})
	return related[0].task
}

/** The exact card a tab was opened from, or null when it is no longer on the board. */
function taskOfId(snapshot, taskId) {
	const id = textOf(taskId)
	if (id === null || snapshot === null || snapshot === undefined || Array.isArray(snapshot.tasks) !== true) return null
	for (const task of snapshot.tasks) {
		if (isRecord(task) && String(task.id === undefined || task.id === null ? '' : task.id) === id) return task
	}
	return null
}

/**
 * The live tree entry for a session, when the host reports the tree. The root
 * and the members are reported apart: only the root may be shown as the root
 * Agent, and only a member may name a worker/reviewer/tester session.
 * @returns `{ agent, isRoot }` or null.
 */
function treeAgentOf(snapshot, sessionId, tcAgentTreeOf) {
	if (typeof tcAgentTreeOf !== 'function' || snapshot === null || snapshot === undefined) return null
	let tree = null
	try {
		tree = tcAgentTreeOf(snapshot)
	} catch (error) {
		tree = null
	}
	if (!isRecord(tree)) return null
	if (isRecord(tree.root) && tree.root.id === sessionId) return { agent: tree.root, isRoot: true }
	const members = Array.isArray(tree.members) ? tree.members : []
	for (const member of members) {
		if (isRecord(member) && member.id === sessionId) return { agent: member, isRoot: false }
	}
	return null
}

function roleLabelOf(role, t) {
	if (role === 'lead' || role === 'root') return t('agentRootRole')
	const key = ROLE_LABEL_KEYS[role]
	if (key === undefined) return typeof role === 'string' && role !== '' ? role : '—'
	return t(key)
}

/**
 * What a card's own records make this session responsible for:
 * `{ role, name }` with role worker/reviewer/tester/root, or null. The worker
 * fields are checked first, so a session that is both the executor and the
 * card's owner stays a worker instead of borrowing the root Agent's role.
 */
function sessionRoleOf(task, sessionId) {
	if (isRecord(task) !== true) return null
	const current = memberOf(task.assignee)
	if (current !== null && textOf(current.session) === sessionId) return { role: 'worker', name: textOf(current.name) }
	const previous = memberOf(task.lastAssignee)
	if (previous !== null && textOf(previous.session) === sessionId) return { role: 'worker', name: textOf(previous.name) }
	const review = memberOf(task.review)
	const reviewer = review !== null ? memberOf(review.deliveredTo) : null
	if (reviewer !== null && textOf(reviewer.id) === sessionId) return { role: 'reviewer', name: textOf(reviewer.name) }
	const test = memberOf(task.test)
	const tester = test !== null ? memberOf(test.deliveredTo) : null
	if (tester !== null && textOf(tester.id) === sessionId) return { role: 'tester', name: textOf(tester.name) }
	if (textOf(task.ownerSession) === sessionId) return { role: 'root', name: null }
	return null
}

/** A status only when the card's own stage records prove the session is live. */
function stageStatusOf(task, sessionId) {
	if (isRecord(task) !== true) return 'unknown'
	if (task.status === 'running' && assignedSessionOf(task) === sessionId) return 'running'
	if (task.status === 'reviewing' && reviewSessionOf(task) === sessionId) return 'running'
	if (task.status === 'testing' && testSessionOf(task) === sessionId) return 'running'
	return 'unknown'
}

function statusPillOf(status) {
	if (status === 'running') return 'running'
	if (status === 'failed') return 'failed'
	return 'inactive'
}

function activityCategoryOf(kind) {
	if (kind === 'create') return 'create'
	if (kind === 'retry' || kind === 'dispatch') return 'dispatch'
	if (kind === 'submit') return 'submit'
	if (kind === 'review-pass' || kind === 'review-reject' || kind === 'review-start' || kind === 'review-end') return 'review-pass'
	if (kind === 'test-pass' || kind === 'test-fail' || kind === 'test-start' || kind === 'test-end') return 'test-pass'
	if (kind === 'merge' || kind === 'merge-rejected') return 'merge'
	if (kind === 'blocked' || kind === 'error' || kind === 'host-action-timeout') return 'blocked'
	if (kind === 'cancel') return 'cancel'
	if (kind === 'host-check') return 'host-check'
	return 'dispatch'
}

function historyCategoryOf(entry) {
	const to = isRecord(entry) ? entry.to : null
	if (to === 'running') return 'dispatch'
	if (to === 'reviewing') return 'submit'
	if (to === 'testing') return 'review-pass'
	if (to === 'done') return 'merge'
	if (to === 'blocked') return 'blocked'
	if (to === 'cancelled') return 'cancel'
	return 'dispatch'
}

function activityLabelKeyOf(category) {
	return ACTIVITY_LABEL_KEYS[category] === undefined ? 'evtLabel-dispatch' : ACTIVITY_LABEL_KEYS[category]
}

/** The latest activity the host already derived for this card, else history. */
function activityOf(snapshot, task, now, tcAgo) {
	if (isRecord(task) !== true) return null
	const entries = snapshot !== null && snapshot !== undefined && isRecord(snapshot.activityEvents) && Array.isArray(snapshot.activityEvents.entries) ? snapshot.activityEvents.entries : []
	const mine = entries.filter(function (entry) {
		return isRecord(entry) && String(entry.taskId === undefined || entry.taskId === null ? '' : entry.taskId) === String(task.id) && typeof entry.at === 'string'
	})
	if (mine.length > 0) {
		const latest = mine.slice().sort(function (left, right) { return timeOf(right.at) - timeOf(left.at) })[0]
		const category = activityCategoryOf(latest.kind)
		return {
			category: category,
			labelKey: activityLabelKeyOf(category),
			detail: shortText(latest.detail, 120),
			at: latest.at,
			ago: tcAgo(latest.at, now),
		}
	}
	const history = Array.isArray(task.history) ? task.history.filter(function (entry) { return isRecord(entry) && typeof entry.at === 'string' }) : []
	if (history.length > 0) {
		const latest = history.slice().sort(function (left, right) { return timeOf(right.at) - timeOf(left.at) })[0]
		const category = historyCategoryOf(latest)
		return {
			category: category,
			labelKey: activityLabelKeyOf(category),
			detail: shortText(latest.note, 120),
			at: latest.at,
			ago: tcAgo(latest.at, now),
		}
	}
	const at = typeof task.updatedAt === 'string' && task.updatedAt !== '' ? task.updatedAt : typeof task.createdAt === 'string' ? task.createdAt : null
	if (at === null) return null
	return { category: 'dispatch', labelKey: activityLabelKeyOf('dispatch'), detail: '', at: at, ago: tcAgo(at, now) }
}

/**
 * Everything the tab renders for one session. Pure: the selectors are injected
 * so the unit test can drive the same resolution without the bundle.
 *
 * T-212: the tab may carry the exact taskId it was opened from. That card is
 * used as-is instead of guessing from the live tree or the panel's session —
 * a card deleted since then keeps its id with no stage rather than showing
 * another card's data. Without a taskId (the guide overview) the card is
 * resolved from the session by the card's own field order.
 */
function agentInfoOf(snapshot, sessionId, t, now, helpers, taskId) {
	const tool = isRecord(helpers) ? helpers : {}
	const tcAgentTreeOf = tool.tcAgentTreeOf
	const tcPhaseLabel = typeof tool.tcPhaseLabel === 'function' ? tool.tcPhaseLabel : function (task) { return task !== null && task !== undefined && typeof task.status === 'string' ? task.status : '—' }
	const tcAgo = typeof tool.tcAgo === 'function' ? tool.tcAgo : function () { return '—' }
	const tcAgentStatusKey = typeof tool.tcAgentStatusKey === 'function' ? tool.tcAgentStatusKey : function () { return 'agentStatusUnknown' }
	const exactId = textOf(taskId)
	const tree = treeAgentOf(snapshot, sessionId, tcAgentTreeOf)
	const treeAgent = tree !== null ? tree.agent : null
	const task = exactId !== null ? taskOfId(snapshot, exactId) : taskForSession(snapshot, sessionId)
	const matched = task !== null ? sessionRoleOf(task, sessionId) : null
	let role = matched !== null ? matched.role : null
	let name = matched !== null ? matched.name : null
	if (tree !== null) {
		const liveRole = tree.isRoot === true ? 'root' : textOf(treeAgent.role)
		if (role === null) {
			if (tree.isRoot === true) role = 'root'
			else if (liveRole === 'worker' || liveRole === 'reviewer' || liveRole === 'tester') role = liveRole
		}
		// Name and role must agree: the tree root may only name the root role, a
		// member may only name a worker/reviewer/tester. That is what keeps a
		// worker's name from ever being paired with the root Agent's role.
		const liveName = textOf(treeAgent.name)
		if (name === null && liveName !== null && (role === null || (role === 'root') === (tree.isRoot === true))) name = liveName
	}
	if (name === null) name = sessionShort(sessionId)
	const reported = treeAgent !== null ? textOf(treeAgent.status) : null
	const status = reported !== null ? reported : stageStatusOf(task, sessionId)
	const resolvedId = task !== null && task.id !== undefined && task.id !== null ? String(task.id) : exactId
	return {
		sessionId: sessionId,
		sessionShort: sessionShort(sessionId),
		name: name,
		role: role,
		roleLabel: roleLabelOf(role, t),
		status: status,
		statusPill: statusPillOf(status),
		statusLabelKey: tcAgentStatusKey(status),
		taskId: resolvedId,
		taskTitle: task !== null && typeof task.title === 'string' ? task.title : '',
		stage: task !== null ? tcPhaseLabel(task, t) : t('agentTabNoTask'),
		activity: activityOf(snapshot, task, now, tcAgo),
	}
}

/**
 * The tab's navigation params (`useTabInfo().tab.navigation.params`), or null.
 * Never throws: a missing service or params object simply means "no params".
 */
function tabParamsOf(props) {
	if (props === null || props === undefined) return null
	const useTabInfo = props.useTabInfo
	if (typeof useTabInfo !== 'function') return null
	let info = null
	try {
		info = useTabInfo()
	} catch (error) {
		return null
	}
	const tab = info !== null && info !== undefined && isRecord(info.tab) ? info.tab : null
	const navigation = tab !== null && isRecord(tab.navigation) ? tab.navigation : null
	return navigation !== null && isRecord(navigation.params) ? navigation.params : null
}

/**
 * Which agent, and which card, this tab has to show (T-216). The host opens the
 * tab in the HOST session, so the navigation session is not the subagent: the
 * agent session comes from the `agentSession` navigation param (or an explicit
 * prop when a component is mounted directly), and only then falls back to the
 * navigation session. The card id comes from the `taskId` param/prop; without it
 * the body resolves the card from the agent session, exactly as before.
 * @returns `{ sessionId, taskId }`; `sessionId` is '' when there is nothing to show.
 */
function tabSelectionOf(props) {
	const target = props === null || props === undefined ? null : props
	const navigationSession = target !== null && typeof target.sessionId === 'string' ? target.sessionId.trim() : ''
	const params = tabParamsOf(target)
	const directAgent = target !== null ? textOf(target.agentSession) : null
	const directTask = target !== null ? textOf(target.taskId) : null
	const agentSession = directAgent !== null ? directAgent : params !== null ? textOf(params[AGENT_TAB_SESSION_PARAM]) : null
	const taskId = directTask !== null ? directTask : params !== null ? textOf(params[AGENT_TAB_TASK_PARAM]) : null
	return { sessionId: agentSession !== null ? agentSession : navigationSession, taskId: taskId }
}

function createAgentSidebar(deps) {
	const React = deps.React
	const h = deps.h
	const selectors = {
		tcAgentTreeOf: deps.tcAgentTreeOf,
		tcPhaseLabel: deps.tcPhaseLabel,
		tcAgo: deps.tcAgo,
		tcAgentStatusKey: deps.tcAgentStatusKey,
	}
	let context = null
	let runtime = null
	let mounted = false
	let disposed = false
	let releaseSlots = noop
	let releaseRegistrations = noop

	const EMPTY_SNAPSHOT = { tasks: [], activityEvents: null, agentTree: null }
	function readEmptySnapshot() { return EMPTY_SNAPSHOT }
	function subscribeNothing() { return noop }

	/** Agent-namespace keys first, then the task center's own dictionary. */
	function translate() {
		const locale = context !== null ? context.locale : null
		const read = function (name) {
			if (locale === null || locale === undefined || typeof locale.bind !== 'function' || typeof name !== 'string' || name === '') return null
			try {
				return locale.bind(name)
			} catch (error) {
				return null
			}
		}
		const own = read(context !== null ? context.ns : null)
		const panel = read(context !== null ? context.taskNs : null)
		return function (key) {
			try {
				if (own !== null) {
					const text = own(key)
					if (typeof text === 'string' && text !== '' && text !== key) return text
				}
				if (panel !== null) {
					const text = panel(key)
					if (typeof text === 'string' && text !== '') return text
				}
			} catch (error) {
				/* a locale that throws still leaves the key form below */
			}
			return AGENT_TAB_COPY.zh[key] === undefined ? key : AGENT_TAB_COPY.zh[key]
		}
	}

	function useTranslate() {
		const force = React.useReducer(function (count) { return count + 1 }, 0)[1]
		const locale = context !== null ? context.locale : null
		React.useEffect(function () {
			if (locale !== null && locale !== undefined && typeof locale.subscribe === 'function') return locale.subscribe(force)
			return undefined
		}, [])
		return translate()
	}

	function useSnapshot() {
		const store = context !== null ? context.store : null
		const subscribe = store !== null && store !== undefined && typeof store.subscribe === 'function' ? store.subscribe : subscribeNothing
		const read = store !== null && store !== undefined && typeof store.getSnapshot === 'function' ? store.getSnapshot : readEmptySnapshot
		if (typeof React.useSyncExternalStore === 'function') return React.useSyncExternalStore(subscribe, read, read)
		const pair = React.useState(read)
		return pair[0]
	}

	function useNow() {
		const pair = React.useState(function () { return Date.now() })
		const setNow = pair[1]
		React.useEffect(function () {
			const handle = setInterval(function () { setNow(Date.now()) }, 5000)
			return function () { clearInterval(handle) }
		}, [])
		return pair[0]
	}

	/**
	 * The host's optional workspace service, when it can switch the main view.
	 * T-218: `openIn` also uses it to leave the plugin page for the host session's
	 * conversation after placing the tab.
	 */
	function workspaceOf() {
		const workspace = runtime !== null ? runtime.workspace : null
		return isRecord(workspace) && typeof workspace.openSession === 'function' ? workspace : null
	}

	/** Switch the main view to this agent's own conversation; a quiet false without the service. */
	function openConversation(sessionId) {
		const value = textOf(sessionId)
		if (value === null || mounted !== true || disposed === true) return false
		const workspace = workspaceOf()
		if (workspace === null) return false
		try {
			workspace.openSession(value)
			return true
		} catch (error) {
			return false
		}
	}

	function AgentTabIcon(props) {
		const size = props !== null && props !== undefined && typeof props.size === 'number' ? props.size : 14
		return h(
			'svg',
			{ className: 'gbt-glyph', width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
			h('rect', { x: 1.5, y: 2, width: 13, height: 12, rx: 2.4, stroke: 'currentColor', strokeWidth: 1.3 }),
			h('path', { d: 'M5.6 4.6v6.8M10.4 4.6v6.8', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round' }),
		)
	}

	function AgentTabTitle(props) {
		const t = useTranslate()
		const snapshot = useSnapshot()
		// T-216: the navigation session is the HOST session; the agent to show is
		// resolved from the params (or handed over directly by a mounted test).
		const selection = tabSelectionOf(props)
		const sessionId = selection.sessionId
		const taskId = selection.taskId
		const label = sessionId === '' ? t('agentTabTitle') : agentInfoOf(snapshot, sessionId, t, Date.now(), selectors, taskId).name
		return h('span', { className: 'gbt-agenttabtitle', 'data-agent-tab': 'title', 'data-agent-session': sessionId, 'data-agent-task': taskId === null ? '' : taskId }, h(AgentTabIcon, { size: 13 }), h('span', null, label))
	}

	function AgentTabBody(props) {
		const t = useTranslate()
		const snapshot = useSnapshot()
		const now = useNow()
		// Read the navigation params before any early return so the injected
		// tab-info hook is always called in the same order on every render.
		// T-216: the tab lives in the HOST session, so the agent it names comes
		// from the `agentSession` param; the navigation session is only the
		// fallback (a guide-opened tab, or a directly mounted body).
		const selection = tabSelectionOf(props)
		const sessionId = selection.sessionId
		const taskId = selection.taskId
		if (sessionId === '') {
			return h(
				'div',
				{ className: 'gbt-agenttab', 'data-agent-tab': 'body', 'data-agent-session': '' },
				h('div', { className: 'gbt-agenttabhead' }, h(AgentTabIcon, { size: 14 }), h('b', null, t('agentTabTitle'))),
				h('p', { className: 'gbt-footnote' }, t('agentTabNoSession')),
			)
		}
		const info = agentInfoOf(snapshot, sessionId, t, now, selectors, taskId)
		const children = [
			h(
				'div',
				{ key: 'head', className: 'gbt-agenttabhead' },
				h(AgentTabIcon, { size: 14 }),
				h('b', { title: info.name }, info.name),
				h('span', { className: 'gbt-pill', 'data-status': info.statusPill, 'data-agent-status': info.status }, t(info.statusLabelKey)),
				h('span', { className: 'gbt-detailwhen gbt-mono', title: sessionId }, info.sessionShort),
			),
			h(
				'div',
				{ key: 'facts', className: 'gbt-agenttabrows' },
				h('div', { className: 'gbt-detailkv' }, h('span', null, t('agentRole')), h('b', null, info.roleLabel)),
				h(
					'div',
					{ className: 'gbt-detailkv' },
					h('span', null, t('agentTask')),
					h('b', { className: 'gbt-mono', 'data-agent-task': info.taskId === null ? '' : info.taskId, title: info.taskTitle }, info.taskId === null ? '—' : info.taskId),
				),
				h('div', { className: 'gbt-detailkv' }, h('span', null, t('agentTabStage')), h('b', null, info.stage)),
			),
			// T-212: the overview's one action — switch the main view to this
			// subagent's own conversation. A root session (or a shell without
			// uiWorkspace) has nothing to switch to, so the action is omitted.
			info.role === 'root' || workspaceOf() === null
				? null
				: h(
					'button',
					{
						key: 'open',
						type: 'button',
						className: 'gbt-agenttabopen',
						'data-agent-action': 'open-session',
						'data-agent-session': sessionId,
						title: t('agentTabOpenSessionHint'),
						onClick: function () { openConversation(sessionId) },
					},
					t('agentTabOpenSession'),
				),
			// T-218: the switch moves the MAIN session to the subagent, and the right
			// sidebar then belongs to that new session: tabs opened in the host session
			// are not carried over. Say it instead of letting them vanish unexplained.
			info.role === 'root' || workspaceOf() === null
				? null
				: h('p', { key: 'switchNote', className: 'gbt-footnote gbt-agenttabnote', 'data-agent-note': 'sidebar-scope' }, t('agentTabSwitchNote')),
			h(
				'div',
				{ key: 'activity', className: 'gbt-agenttabactivity' },
				h('div', { className: 'gbt-subhead' }, t('agentTabActivity')),
				info.activity === null
					? h('p', { className: 'gbt-footnote', 'data-agent-activity': 'none' }, t('agentTabNoActivity'))
					: h(
						'div',
						{ className: 'gbt-detailevent', 'data-agent-activity': info.activity.category },
						h('span', { className: 'gbt-detailpill' }, t(info.activity.labelKey)),
						info.activity.detail === '' ? null : h('span', { className: 'gbt-detailwho', title: info.activity.detail }, info.activity.detail),
						h('span', { className: 'gbt-detailwhen gbt-mono', title: info.activity.at }, info.activity.ago),
					),
			),
		]
		return h(
			'div',
			{
				className: 'gbt-agenttab',
				'data-agent-tab': 'body',
				'data-agent-session': sessionId,
				'data-agent-role': info.role === null ? '' : info.role,
				'data-agent-status': info.status,
				'data-agent-task': info.taskId === null ? '' : info.taskId,
			},
			children,
		)
	}

	function dispose() {
		if (disposed) return
		disposed = true
		mounted = false
		if (bound === api) bound = null
		try {
			releaseRegistrations()
		} catch (error) {}
		try {
			releaseSlots()
		} catch (error) {}
		releaseRegistrations = noop
		releaseSlots = noop
		context = null
		runtime = null
	}

	function mount(host, options) {
		dispose()
		// A second activation of the same bundle must not leave the first tab
		// registered under the same id/kind: replace it before registering again.
		if (bound !== null && bound !== api && typeof bound.dispose === 'function') {
			try {
				bound.dispose()
			} catch (error) {}
		}
		disposed = false
		const opts = isRecord(options) ? options : {}
		const scope = isRecord(host) ? host : null
		const sidebar = readService(scope, 'sidebarRight')
		const tabs = readService(scope, 'sidebarRightTabs')
		// T-212: optional. The tab mounts and renders its overview without it;
		// only the "open subagent conversation" action is withheld.
		const workspace = isRecord(opts.uiWorkspace) ? opts.uiWorkspace : readService(scope, 'uiWorkspace')
		const slots = isRecord(scope) && isRecord(scope.slots) ? scope.slots : isRecord(opts.slots) ? opts.slots : null
		if (!isRecord(sidebar) || typeof sidebar.openTabIn !== 'function') return noop
		// T-216: openIn has to verify the placement through the tab strip; a host
		// that cannot report it would leave a dead entry, so it does not mount.
		if (typeof sidebar.tabsIn !== 'function') return noop
		if (!isRecord(tabs) || typeof tabs.register !== 'function') return noop
		if (!isRecord(slots) || typeof slots.inject !== 'function' || typeof slots.register !== 'function') return noop
		context = {
			store: opts.store === undefined ? null : opts.store,
			locale: opts.locale === undefined ? null : opts.locale,
			ns: typeof opts.ns === 'string' ? opts.ns : '',
			taskNs: typeof opts.taskNs === 'string' ? opts.taskNs : '',
		}
		runtime = { sidebar: sidebar, workspace: isRecord(workspace) ? workspace : null }
		let released = false
		function release() {
			if (released === true) return
			released = true
			mounted = false
			if (bound === api) bound = null
			try {
				releaseRegistrations()
			} catch (error) {}
			releaseRegistrations = noop
		}
		function register() {
			if (disposed === true) return noop
			const releases = []
			let dropped = false
			const collect = function (value) {
				if (typeof value === 'function') releases.push(value)
			}
			const drop = function () {
				if (dropped === true) return
				dropped = true
				releases.reverse().forEach(function (fn) {
					try {
						fn()
					} catch (error) {}
				})
			}
			try {
				collect(slots.register({ name: AGENT_TAB_BODY_SLOT, key: AGENT_TAB_ID }, AgentTabBody))
				collect(slots.register({ name: AGENT_TAB_TITLE_SLOT, key: AGENT_TAB_ID }, AgentTabTitle))
				collect(
					tabs.register({
						id: AGENT_TAB_ID,
						kind: AGENT_TAB_KIND,
						// T-218: each open must be its own tab. Without `multiple` the host
						// keys the page by kind alone (one sidebar://<kind>) and the next
						// "open in sidebar" navigates the open tab into another card.
						multiple: true,
						title: function () { return translate()('agentTabTitle') },
						guide: [
							{
								order: AGENT_TAB_GUIDE_ORDER,
								title: function () { return translate()('agentTabTitle') },
								description: function () { return translate()('agentTabHint') },
								icon: AgentTabIcon,
							},
						],
					}),
				)
			} catch (error) {
				drop()
				return noop
			}
			releaseRegistrations = drop
			mounted = true
			bound = api
			return release
		}
		try {
			releaseSlots = releaseOf(
				slots.inject(AGENT_TAB_BODY_SLOT, function () {
					return releaseOf(slots.inject(AGENT_TAB_TITLE_SLOT, register))
				}),
			)
		} catch (error) {
			dispose()
			return noop
		}
		return dispose
	}

	/**
	 * The session whose right sidebar actually has a surface: the host's current
	 * session, read from `uiWorkspace.selection` (the same store the panel
	 * follows). T-216: the agent's own subagent session has NO adopted surface,
	 * so it is never a fallback — an unavailable host session fails the open.
	 */
	function hostSessionOf() {
		const workspace = runtime !== null ? runtime.workspace : null
		if (!isRecord(workspace)) return null
		const selection = workspace.selection
		if (!isRecord(selection) || typeof selection.getSnapshot !== 'function') return null
		let snapshot = null
		try {
			snapshot = selection.getSnapshot()
		} catch (error) {
			return null
		}
		return isRecord(snapshot) ? textOf(snapshot.sessionId) : null
	}

	/**
	 * The tabs in one session's right-sidebar strip, or null when the host cannot
	 * report them. Used only to VERIFY an open: `openTabIn` answers with void and
	 * silently no-ops without a surface, so the strip delta is the proof.
	 */
	function agentTabRecords(sessionId) {
		const sidebar = runtime !== null ? runtime.sidebar : null
		if (!isRecord(sidebar) || typeof sidebar.tabsIn !== 'function') return null
		let list = null
		try {
			list = sidebar.tabsIn(sessionId)
		} catch (error) {
			return null
		}
		if (Array.isArray(list) !== true) return null
		return list.filter(function (tab) { return isRecord(tab) })
	}

	/** One tab's identity: its layout id, else its content address, else its index. */
	function tabKeyOf(tab, index) {
		const id = isRecord(tab) ? textOf(tab.id) : null
		if (id !== null) return 'id:' + id
		const contentId = isRecord(tab) ? textOf(tab.contentId) : null
		if (contentId !== null) return 'content:' + contentId
		return 'index:' + String(index)
	}

	function tabKeysOf(list) {
		const keys = new Set()
		for (let index = 0; index < list.length; index += 1) keys.add(tabKeyOf(list[index], index))
		return keys
	}

	/**
	 * The tab THIS call added, or null. T-218: a tab type registered as `multiple`
	 * makes the host mint a fresh `sidebar://<kind>/<uuid>` per open, so the strip
	 * really grows by one record with a brand-new address. A host that ignores
	 * `multiple` keeps ONE page per kind and NAVIGATES it into the new card: the
	 * count does not grow, and that is the regression this must report as false.
	 */
	function createdTabOf(before, after) {
		if (Array.isArray(after) !== true || after.length <= before.length) return null
		const known = tabKeysOf(before)
		const addresses = new Set()
		for (const tab of before) {
			const contentId = isRecord(tab) ? textOf(tab.contentId) : null
			if (contentId !== null) addresses.add(contentId)
		}
		let created = null
		for (let index = 0; index < after.length; index += 1) {
			const tab = after[index]
			if (!isRecord(tab) || tab.kind !== AGENT_TAB_KIND) continue
			if (known.has(tabKeyOf(tab, index))) continue
			if (created !== null) return null
			const contentId = textOf(tab.contentId)
			if (contentId !== null && addresses.has(contentId)) return null
			created = tab
		}
		return created
	}

	/**
	 * The card a session currently stands for, resolved from the shared store
	 * with the card's own field order (executor first). Used only because the
	 * card entry hands over the session, not the card: the id is then carried in
	 * the tab's navigation params so the body resolves that exact card.
	 */
	function cardIdOf(sessionId) {
		const store = context !== null ? context.store : null
		if (!isRecord(store) || typeof store.getSnapshot !== 'function') return null
		let snapshot = null
		try {
			snapshot = store.getSnapshot()
		} catch (error) {
			return null
		}
		const task = taskForSession(snapshot, sessionId)
		return task !== null && task.id !== undefined && task.id !== null ? String(task.id) : null
	}

	/**
	 * T-218: leave the plugin page for the host session's conversation — the only
	 * view that shows the right sidebar the tab was just placed in. A host without
	 * `openSession`, or one that throws, keeps the tab (the caller never undoes it)
	 * but reports false: the entry did not finish, and claiming otherwise is the
	 * fake success this replaces.
	 */
	function switchToHost(sessionId) {
		const workspace = workspaceOf()
		if (workspace === null) return false
		try {
			workspace.openSession(sessionId)
			return true
		} catch (error) {
			return false
		}
	}

	/**
	 * Open the agent tab for `agentSession` (and optionally its exact card) in
	 * the CURRENT HOST SESSION (T-216), then switch the main view to that session
	 * (T-218). The agent session only travels in the navigation params: passing it
	 * as the opening session was a silent no-op because a subagent session owns no
	 * sidebar surface.
	 *
	 * The tab type is registered as `multiple`, so every call creates an
	 * independent tab whose navigation carries THIS card and THIS agent. The call
	 * is verified by the strip DELTA (one new tab, a new identity, a content
	 * address no earlier tab used) — not by "our kind exists", which was true
	 * even when the host merely navigated the previously open tab into another
	 * card. Returns true only when a NEW tab was really placed AND the main view
	 * was switched; false (never a throw) for an unavailable host or host session,
	 * a silent no-op, a host that still reuses one page, or a failed switch.
	 */
	function openIn(sessionId, taskId) {
		const agentSession = textOf(sessionId)
		if (agentSession === null || mounted !== true || disposed === true) return false
		const sidebar = runtime !== null ? runtime.sidebar : null
		if (!isRecord(sidebar) || typeof sidebar.openTabIn !== 'function') return false
		const hostSession = hostSessionOf()
		if (hostSession === null) return false
		// No strip inventory means we could not prove the tab exists: never claim
		// success on an unchecked call.
		const before = agentTabRecords(hostSession)
		if (before === null) return false
		const exact = textOf(taskId)
		const cardId = exact !== null ? exact : cardIdOf(agentSession)
		// T-218: every open builds its own params object; two tabs never share the
		// card/agent pair, so the second open cannot rewrite the first tab's body.
		const params = {}
		if (cardId !== null) params[AGENT_TAB_TASK_PARAM] = cardId
		params[AGENT_TAB_SESSION_PARAM] = agentSession
		try {
			sidebar.openTabIn(hostSession, AGENT_TAB_KIND, { params: params })
		} catch (error) {
			return false
		}
		const after = agentTabRecords(hostSession)
		if (after === null) return false
		if (createdTabOf(before, after) === null) return false
		return switchToHost(hostSession)
	}

	const api = {
		kind: AGENT_TAB_KIND,
		id: AGENT_TAB_ID,
		action: AGENT_TAB_OPEN_ACTION,
		sessionOf: agentSessionOf,
		infoOf: function (snapshot, sessionId, t, now, taskId) {
			return agentInfoOf(snapshot, sessionId, t, now, selectors, taskId)
		},
		Title: AgentTabTitle,
		Body: AgentTabBody,
		mount: mount,
		dispose: dispose,
		isMounted: function () {
			return mounted === true && disposed !== true && bound === api
		},
		openIn: openIn,
		/** Switch the main view to the agent's conversation; false without uiWorkspace. */
		openConversation: openConversation,
		/** Whether the mounted host gave us a usable uiWorkspace. */
		hasWorkspace: function () {
			return workspaceOf() !== null
		},
		label: function (key) {
			return translate()(key)
		},
	}
	return api
}

/** True once a tab has really been registered with the host. */
function available() {
	return bound !== null && typeof bound.isMounted === 'function' && bound.isMounted() === true
}

/** Open the agent tab for a REAL session (and optionally its exact card); false (never a throw) when unavailable. */
function openIn(sessionId, taskId) {
	return bound === null ? false : bound.openIn(sessionId, taskId)
}

/** A localized entry label for the card/detail; the zh copy before mount. */
function label(key) {
	if (bound !== null && typeof bound.label === 'function') return bound.label(key)
	return AGENT_TAB_COPY.zh[key] === undefined ? key : AGENT_TAB_COPY.zh[key]
}

module.exports = {
	AGENT_TAB_KIND,
	AGENT_TAB_ID,
	AGENT_TAB_OPEN_ACTION,
	AGENT_TAB_TASK_PARAM,
	AGENT_TAB_SESSION_PARAM,
	AGENT_TAB_NS,
	AGENT_TAB_COPY,
	AGENT_TAB_CSS,
	agentSessionOf,
	agentInfoOf,
	createAgentSidebar,
	available,
	openIn,
	label,
}

			})(module, module.exports)
			return module.exports
		})()
		const createAgentSidebarView = agentSidebarModule.createAgentSidebar
		const AGENT_TAB_NS = agentSidebarModule.AGENT_TAB_NS
		const AGENT_TAB_COPY = agentSidebarModule.AGENT_TAB_COPY
		const AGENT_TAB_CSS = agentSidebarModule.AGENT_TAB_CSS
		const agentSidebar = {
			sessionOf: agentSidebarModule.agentSessionOf,
			available: agentSidebarModule.available,
			open: agentSidebarModule.openIn,
			label: agentSidebarModule.label,
		}

		function createTaskCenterViews(ctx, store) {
			/** Locale subscription; the panel re-renders when the language flips. */
			function useTranslate() {
				const force = React.useReducer(function (count) { return count + 1 }, 0)[1]
				React.useEffect(function () {
					return ctx.locale.subscribe(force)
				}, [])
				return ctx.locale.bind(TC_NS)
			}

			/** A slow clock for lease countdowns and relative ages. */
			function useNow(intervalMs) {
				const [now, setNow] = React.useState(function () { return Date.now() })
				React.useEffect(function () {
					const handle = setInterval(function () { setNow(Date.now()) }, intervalMs)
					return function () { clearInterval(handle) }
				}, [])
				return now
			}

			function useSnapshot() {
				return React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
			}

			function toneForDependency(allTasks, id) {
				const dependency = allTasks.filter(function (task) { return task.id === id })[0]
				if (dependency === undefined) return 'broken'
				if (dependency.status === 'done') return 'done'
				if (dependency.status === 'cancelled') return 'broken'
				return 'waiting'
			}

			/**
			 * The Host's report on why a pending task has not been dispatched. It
			 * is informational only: the panel never decides readiness itself, it
			 * renders the reason the Host computed.
			 */
			const WAITING_REASON = {
				'dispatch-paused': { key: 'waitDispatchPaused', tone: 'waiting' },
				dependency: { key: 'waitDependency', tone: 'waiting' },
				'dependency-broken': { key: 'waitDependencyBroken', tone: 'broken' },
				'file-lock': { key: 'waitFileLock', tone: 'waiting' },
				// T-108: a transient dirty window is a wait, not a fault.
				'dirty-worktree': { key: 'waitEnvironmentDirty', tone: 'waiting' },
				concurrency: { key: 'waitConcurrency', tone: 'waiting' },
				// Merge-side waits: a stale candidate is rebuilt automatically; a
				// needs-rebase card is NOT retried and needs a human rebase.
				'candidate-stale': { key: 'waitCandidateStale', tone: 'waiting' },
				'needs-rebase': { key: 'waitNeedsRebase', tone: 'broken' },
			}

			/** The waiting-reason chip, or null when the Host reported none. */
			function waitingChip(task, t, key) {
				const reason = task.waitingReason
				if (typeof reason !== 'string') return null
				const entry = WAITING_REASON[reason]
				if (entry === undefined) return null
				// The host's detail is the WHY (conflicted files, which branch/target to
				// rebase onto); the visible label stays short.
				const detail = typeof task.waitingDetail === 'string' && task.waitingDetail !== '' ? task.waitingDetail : t(entry.key)
				return h('span', { key: key, className: 'gbt-chip', 'data-tone': entry.tone, 'data-waiting': reason, title: detail }, '⏳ ' + t(entry.key))
			}

			const TaskCard = (function () {
				const module = { exports: {} }
				;(function (module, exports) {
/**
 * Task card view module.
 *
 * T-158 (夜航作战板): the face of a card is compact — short id + priority, a
 * two-line title, one meta row (owning session, dependency count, role) and one
 * state row (state dot + label on the left, elapsed time on the right). The
 * chips for review/test/merge/lease/waiting stay: they are the evidence a reader
 * opens the card for, only typeset smaller.
 */
/**
 * T-191: the panel verdict is the USER's explicit override, so the card sends a
 * structured record attributed to that override instead of free text.
 *
 * The contract's execution rules (the tester must run the candidate probes)
 * apply to the tester role; a human decision is recorded as a human decision,
 * not disguised as executed probe output. The action layer mirrors this
 * payload for older clients, so a stale bundle cannot brick the override.
 */
function userVerdictPayload(action, reason) {
	const text = typeof reason === 'string' ? reason.trim() : ''
	if (action === 'approveReview') {
		return {
			checked: [{ criterion: 'human override from the task center panel', method: 'user review', result: 'approved' }],
			findings: [],
			residualRisks: [],
		}
	}
	if (action === 'requestChanges') {
		return {
			checked: [],
			findings: [
				{
					severity: 'blocking',
					file: null,
					line: null,
					text: text === '' ? 'changes requested by the user in the task center panel' : text,
				},
			],
			residualRisks: [],
		}
	}
	const tail = text === '' ? (action === 'passTest' ? 'the user accepted the candidate in the task center panel' : 'the user rejected the candidate in the task center panel') : text
	return {
		probes: [
			{
				id: 'human-override',
				command: 'human verdict from the task center panel',
				exitCode: action === 'passTest' ? 0 : 1,
				tail: tail,
			},
		],
		adversarial: [],
		notes: tail,
	}
}

function createTaskCard(deps) {
	/** A compact owning-session label; the full id stays in the title. */
	function ownerSessionShort(value) {
		const text = typeof value === 'string' ? value : ''
		return text.indexOf('session-') === 0 ? text.slice(8, 16) : text.slice(0, 8)
	}

	/** "12m" / "3h" / "2d" from the card's last change, or em dash. */
	function elapsedText(task, now) {
		const raw = typeof task.updatedAt === 'string' && task.updatedAt !== '' ? task.updatedAt : task.createdAt
		const at = typeof raw === 'string' ? Date.parse(raw) : NaN
		const current = typeof now === 'number' ? now : Date.now()
		if (!Number.isFinite(at)) return '—'
		const minutes = Math.max(0, Math.floor((current - at) / 60000))
		if (minutes < 1) return '—'
		if (minutes < 60) return String(minutes) + 'm'
		const hours = Math.floor(minutes / 60)
		if (hours < 24) return String(hours) + 'h'
		return String(Math.floor(hours / 24)) + 'd'
	}

	const React = deps.React
	const h = deps.h
	const tcBaseName = deps.tcBaseName
	const tcIsInvestigation = deps.tcIsInvestigation
	const tcKindOf = deps.tcKindOf
	const tcLease = deps.tcLease
	const tcMergeLabel = deps.tcMergeLabel
	const tcMergeOf = deps.tcMergeOf
	const tcPhaseLabel = deps.tcPhaseLabel
	const tcPhaseTone = deps.tcPhaseTone
	const tcMergeTone = deps.tcMergeTone
	const tcReviewLabel = deps.tcReviewLabel
	const tcReviewOf = deps.tcReviewOf
	const tcReviewTone = deps.tcReviewTone
	const tcRound = deps.tcRound
	const tcStageQueued = deps.tcStageQueued
	const tcTestLabel = deps.tcTestLabel
	const tcTestOf = deps.tcTestOf
	const tcTestTone = deps.tcTestTone
	const toneForDependency = deps.toneForDependency
	const waitingChip = deps.waitingChip
	// T-209: the host's right-sidebar tab for the card's agent. The object is
	// optional: a shell without the sidebar services passes null (or nothing),
	// and the card simply renders no entry instead of a dead button.
	const agentSidebar = deps.agentSidebar === null || deps.agentSidebar === undefined ? null : deps.agentSidebar

	/** The REAL session recorded on the card, or null. Never minted here. */
	function sidebarSessionOf(task) {
		if (agentSidebar === null || typeof agentSidebar.sessionOf !== 'function') return null
		try {
			const session = agentSidebar.sessionOf(task)
			return typeof session === 'string' && session !== '' ? session : null
		} catch (error) {
			return null
		}
	}

	/** True only once the host really registered the tab (missing service = false). */
	function sidebarAvailable() {
		if (agentSidebar === null || typeof agentSidebar.available !== 'function') return false
		try {
			return agentSidebar.available() === true
		} catch (error) {
			return false
		}
	}

	/**
	 * T-216: the clicked card's id travels WITH the session. The tab opens in the
	 * host session and shows the exact card; deriving it from the session alone
	 * picks another card whenever a session (the owner session, typically) is
	 * shared by several cards.
	 */
	function openSidebar(sessionId, taskId) {
		if (agentSidebar === null || typeof agentSidebar.open !== 'function') return false
		try {
			return agentSidebar.open(sessionId, taskId) === true
		} catch (error) {
			return false
		}
	}

	function sidebarLabel(key) {
		if (agentSidebar !== null && typeof agentSidebar.label === 'function') {
			try {
				const text = agentSidebar.label(key)
				if (typeof text === 'string' && text !== '') return text
			} catch (error) {}
		}
		return key
	}

	function TaskCard(props) {
		const task = props.task
		const t = props.t
		const now = props.now
		const investigate = tcIsInvestigation(task)
		const lease = task.status === 'running' ? tcLease(task.leaseUntil, now, t, task) : null
		const deps = Array.isArray(task.dependsOn) ? task.dependsOn : []
		const files = Array.isArray(task.writeFiles) ? task.writeFiles : null
		const fileCount = files !== null ? files.length : Number.isFinite(task.writeFileCount) ? task.writeFileCount : 0
		const dispatchError = task.dispatch !== null && task.dispatch !== undefined ? task.dispatch.error : null
		const merge = tcMergeOf(task)
		const review = tcReviewOf(task)
		const test = tcTestOf(task)
		const branch = typeof task.branch === 'string' ? task.branch : ''
		const commit = typeof task.commit === 'string' ? task.commit : ''
		const worktree = typeof task.worktree === 'string' ? task.worktree : ''
		const [verdictOpen, setVerdictOpen] = React.useState(null)
		const [verdictReason, setVerdictReason] = React.useState('')
		// T-209: an entry opens the same agent in the native right sidebar. It is
		// rendered only when the host registered our tab AND the card names a real
		// session (the worker's, else the owning session).
		const sidebarSession = sidebarAvailable() ? sidebarSessionOf(task) : null
		const verdictKind = task.status === 'reviewing' ? 'review' : task.status === 'testing' ? 'test' : null
		function recordVerdict(action, extra) {
			if (typeof props.onVerdict !== 'function') return
			props.onVerdict(action, task.id, extra === undefined ? {} : extra)
			setVerdictOpen(null)
			setVerdictReason('')
		}
		// The state row is what a reader scans first; it follows the phase, not the
		// verdict chips (those keep the round detail).
		let stateKey = 'waiting'
		let stateLabel = t('stateWaiting')
		if (task.status === 'running') {
			stateKey = 'running'
			stateLabel = t('stateRunning')
		} else if (task.status === 'reviewing') {
			stateKey = 'reviewing'
			stateLabel = t('stateReviewing')
		} else if (task.status === 'testing') {
			stateKey = 'testing'
			stateLabel = t('stateTesting')
		} else if (task.status === 'done') {
			stateKey = 'done'
			stateLabel = t('stateDone')
		} else if (task.status === 'blocked') {
			stateKey = 'blocked'
			stateLabel = t('stateBlocked')
		} else if (task.status === 'cancelled') {
			// T-194: cancelled is its own terminal state, never a red "blocked" — the
			// card in the 已取消 lane names the state it is actually in.
			stateKey = 'cancelled'
			stateLabel = t('stateCancelled')
		} else if (task.dependency !== undefined && task.dependency !== null && task.dependency.state === 'ready') {
			stateKey = 'ready'
			stateLabel = t('stateReady')
		}
		const children = []
		const topLeft = [h('span', { key: 'id', className: 'gbt-id' }, task.id)]
		if (investigate) {
			topLeft.push(h('span', { key: 'kind', className: 'gbt-chip', 'data-tone': 'investigating', 'data-kind': 'investigate', title: t('kindInvestigateHint') }, '🔍 ' + t('kindInvestigate')))
		}
		children.push(
			h(
				'div',
				{ key: 'top', className: 'gbt-cardtop' },
				h('div', { className: 'gbt-cardtopid' }, topLeft),
				task.priority !== 0 ? h('span', { key: 'prio', className: 'gbt-priority', title: t('priority') }, 'P' + String(task.priority)) : null,
			),
		)
		children.push(h('div', { key: 'title', className: 'gbt-cardtitle' }, task.title))
		const meta = []
		if (typeof task.ownerSession === 'string' && task.ownerSession !== '') {
			const ownerShort = ownerSessionShort(task.ownerSession)
			meta.push(h('span', { key: 'owner', className: 'gbt-chip gbt-ownerchip', 'data-owner-session': task.ownerSession, title: t('ownerSessionHint') + ' · ' + task.ownerSession }, h('i', { className: 'gbt-ownerdot', 'aria-hidden': 'true' }), ownerShort === '' ? task.ownerSession : ownerShort))
		}
		const depCount = deps.length
		if (depCount > 0 || task.status === 'pending') {
			meta.push(h('span', { key: 'deps', className: 'gbt-chip', title: depCount === 0 ? t('dependencyNone') : deps.join(', ') }, t('depCount').replace('{n}', String(depCount))))
		}
		// A recorded verdict stays visible wherever the card sits (a failed test on a
		// running card is a fact); a pending phase is only shown in that phase.
		if (!investigate && review !== null && (task.status === 'reviewing' || task.status === 'testing' || task.status === 'done' || review.status !== 'pending')) {
			meta.push(h('span', { key: 'review', className: 'gbt-chip', 'data-tone': tcReviewTone(review.status), title: t('reviewStatus') + ' · ' + t('reviewAttempt') + ' ' + String(tcRound(review)) }, '👁 ' + tcReviewLabel(review.status, t) + ' · #' + String(tcRound(review))))
			if (task.status !== 'done' && review.status !== 'pending' && typeof review.by === 'string' && review.by !== '') meta.push(h('span', { key: 'reviewer', className: 'gbt-chip', title: t('reviewer') }, review.by))
		}
		if (!investigate && test !== null && (task.status === 'testing' || task.status === 'done' || test.status !== 'pending')) {
			meta.push(h('span', { key: 'test', className: 'gbt-chip', 'data-tone': tcTestTone(test.status), title: t('testStatus') + ' · ' + t('testAttempt') + ' ' + String(tcRound(test)) }, '🧪 ' + tcTestLabel(test.status, t) + ' · #' + String(tcRound(test))))
			if (task.status !== 'done' && typeof test.by === 'string' && test.by !== '') meta.push(h('span', { key: 'tester', className: 'gbt-chip', title: t('tester') }, test.by))
		}
		if (!investigate && merge !== null && task.status === 'done') meta.push(h('span', { key: 'merge', className: 'gbt-chip', 'data-tone': tcMergeTone(merge.status), title: t('mergeTitle') }, '⇄ ' + tcMergeLabel(merge.status, t)))
		if (lease !== null) {
			meta.push(h('span', { key: 'lease', className: 'gbt-chip', 'data-tone': lease.warn ? 'blocked' : 'waiting', 'data-lease': lease.expired === true ? 'expired' : lease.remind === true ? 'reminder' : 'ok', title: lease.remind === true ? t('leaseReminder') : t('leaseLeft') }, lease.text))
		}
		if (fileCount > 0) meta.push(h('span', { key: 'files', className: 'gbt-chip', title: t('writeFiles') }, '🔒 ' + String(fileCount)))
		if (task.attempts > 0) meta.push(h('span', { key: 'attempts', className: 'gbt-chip', title: t('attempts') }, '↻ ' + String(task.attempts) + '/' + String(task.maxAttempts)))
		if (dispatchError !== null && task.status !== 'running') meta.push(h('span', { key: 'error', className: 'gbt-chip', 'data-tone': 'blocked', title: dispatchError }, t('dispatchError')))
		if (tcStageQueued(task)) meta.push(h('span', { key: 'queued', className: 'gbt-chip', 'data-tone': 'waiting', 'data-queue': String(task.queuePosition) }, t('queuedChip').replace('{n}', String(task.queuePosition))))
		const waiting = waitingChip(task, t, 'waiting')
		if (waiting !== null) meta.push(waiting)
		if (meta.length > 0) children.push(h('div', { key: 'meta', className: 'gbt-cardmeta' }, meta))
		children.push(
			h(
				'div',
				{ key: 'foot', className: 'gbt-cardfoot' },
				// The state label is a DIRECT text child: the card face is read by the
				// same text walker the panel tests use, and a nested dot element would
				// hide it. The dot is CSS ::before.
				h('span', { className: 'gbt-cardstate', 'data-state': stateKey, 'data-running': stateKey === 'running' || stateKey === 'ready' ? 'true' : 'false' }, stateLabel),
				// T-209: a link-button, not a second card action: it must not open the
				// detail drawer, so both the click and Enter/Space stop at the card.
				sidebarSession === null
					? null
					: h(
						'button',
						{
							key: 'sidebar',
							type: 'button',
							className: 'gbt-linkbtn',
							'data-action': 'open-agent-sidebar',
							'data-sidebar-session': sidebarSession,
							title: sidebarLabel('openInSidebarHint'),
							onClick: function (event) {
								if (event !== null && event !== undefined && typeof event.stopPropagation === 'function') event.stopPropagation()
								openSidebar(sidebarSession, task.id)
							},
							onKeyDown: function (event) {
								if (event !== null && event !== undefined && (event.key === 'Enter' || event.key === ' ')) event.stopPropagation()
							},
						},
						'▤ ' + sidebarLabel('openInSidebar'),
					),
				h('span', { className: 'gbt-cardtime', title: typeof task.updatedAt === 'string' ? task.updatedAt : '' }, elapsedText(task, now)),
			),
		)
		// T-113: the user records the review/test verdict from the card.
		if (verdictKind !== null) {
			const title = verdictKind === 'review' ? t('verdictReviewTitle') : t('verdictTestTitle')
			const passing = verdictKind === 'review' ? 'approveReview' : 'passTest'
			const blocking = verdictKind === 'review' ? 'requestChanges' : 'failTest'
			const needsReason = verdictOpen === blocking
			children.push(
				h(
					'div',
					{ key: 'verdict', className: 'gbt-cardverdict', 'data-verdict-phase': verdictKind },
					h('div', { className: 'gbt-cardverdicthead' }, title),
					h(
						'div',
						{ className: 'gbt-cardverdictactions' },
						h(
							'button',
							{ type: 'button', className: 'gbt-btn', 'data-variant': 'primary', 'data-verdict-action': passing, onClick: function (clickEvent) { if (clickEvent !== undefined && clickEvent !== null && typeof clickEvent.stopPropagation === 'function') clickEvent.stopPropagation(); recordVerdict(passing, userVerdictPayload(passing, '')) } },
							verdictKind === 'review' ? t('verdictReviewPass') : t('verdictTestPass'),
						),
						h(
							'button',
							{ type: 'button', className: 'gbt-btn', 'data-variant': 'danger', 'data-verdict-action': blocking, 'data-verdict-needs-reason': 'true', onClick: function (clickEvent) { if (clickEvent !== undefined && clickEvent !== null && typeof clickEvent.stopPropagation === 'function') clickEvent.stopPropagation(); setVerdictOpen(blocking) } },
							verdictKind === 'review' ? t('verdictReviewReject') : t('verdictTestFail'),
						),
					),
					needsReason
						? h(
							'div',
							{ className: 'gbt-cardverdictform', 'data-verdict-form': 'true' },
							h('label', { className: 'gbt-footnote' }, t('verdictReasonLabel')),
							h('textarea', { rows: 3, value: verdictReason, 'data-verdict-reason': 'true', onInput: function (inputEvent) { setVerdictReason(String(inputEvent.target.value)) }, onClick: function (clickEvent) { if (clickEvent !== undefined && clickEvent !== null && typeof clickEvent.stopPropagation === 'function') clickEvent.stopPropagation() } }),
							h(
								'div',
								{ className: 'gbt-cardverdictactions' },
								h('button', { type: 'button', className: 'gbt-btn', 'data-variant': 'primary', 'data-verdict-submit': 'true', disabled: verdictReason.trim() === '', title: verdictReason.trim() === '' ? t('verdictReasonRequired') : undefined, onClick: function (clickEvent) { if (clickEvent !== undefined && clickEvent !== null && typeof clickEvent.stopPropagation === 'function') clickEvent.stopPropagation(); if (verdictReason.trim() !== '') recordVerdict(blocking, userVerdictPayload(blocking, verdictReason.trim())) } }, t('verdictSubmit')),
								h('button', { type: 'button', className: 'gbt-btn', 'data-verdict-cancel': 'true', onClick: function () { setVerdictOpen(null); setVerdictReason('') } }, t('verdictCancel')),
							),
						)
						: null,
				),
			)
		}
		if (deps.length > 0) {
			children.push(
				h(
					'div',
					{ key: 'deps', className: 'gbt-cardmeta gbt-carddeps' },
					deps.map(function (id) {
						return h('span', { key: id, className: 'gbt-chip', 'data-tone': toneForDependency(props.allTasks, id) }, '↳ ' + id)
					}),
				),
			)
		}
		return h(
			'article',
			{
				className: 'gbt-card',
				'data-kind': tcKindOf(task),
				'data-selected': props.selected === true ? 'true' : 'false',
				role: 'button',
				tabIndex: 0,
				onClick: function () { props.onOpen(task.id) },
				onKeyDown: function (event) {
					if (event.key === 'Enter' || event.key === ' ') {
						event.preventDefault()
						props.onOpen(task.id)
					}
				},
			},
			children,
		)
	}

	return TaskCard
}

module.exports = { createTaskCard }

				})(module, module.exports)
				const factory = module.exports.createTaskCard
				return factory({
					React: React,
					h: h,
					tcBaseName: tcBaseName,
					tcIsInvestigation: tcIsInvestigation,
					tcKindOf: tcKindOf,
					tcLease: tcLease,
					tcMergeLabel: tcMergeLabel,
					tcMergeOf: tcMergeOf,
					tcMergeTone: tcMergeTone,
					tcPhaseLabel: tcPhaseLabel,
					tcPhaseTone: tcPhaseTone,
					tcReviewLabel: tcReviewLabel,
					tcReviewOf: tcReviewOf,
					tcReviewTone: tcReviewTone,
					tcRound: tcRound,
					tcStageQueued: tcStageQueued,
					tcTestLabel: tcTestLabel,
					tcTestOf: tcTestOf,
					tcTestTone: tcTestTone,
					toneForDependency: toneForDependency,
					waitingChip: waitingChip,
					agentSidebar: agentSidebar,
				})
			})()

			const Column = (function () {
				const module = { exports: {} }
				;(function (module, exports) {
/**
 * Column view module.
 *
 * T-158: a lane head now carries the lane's count AND (for 待派发) the two
 * ready/waiting sub-counts, a done lane can carry an archive summary, and an
 * empty lane marks itself so the board can narrow it instead of stretching it.
 */
function createColumn(deps) {
	const h = deps.h
	const TaskCard = deps.TaskCard

	function Column(props) {
		const t = props.t
		const group = props.group
		const collapsed = props.collapsed === true
		const count = typeof props.count === 'number' ? props.count : group.tasks.length
		const visible = props.visibleTasks !== undefined ? props.visibleTasks : group.tasks
		const showBody = collapsed !== true || props.previewWhenCollapsed === true
		const skeleton = props.skeleton === true
		// T-159: an empty lane only becomes a narrow rail for 待派发 / 阻塞. The three
		// active lanes and 完成 keep their full share so a wide window is filled.
		// T-194: 已取消 is a terminal rail like 阻塞, so an empty cancelled lane narrows
		// too instead of stretching a lane that has nothing to show.
		const narrowable = group.key === 'dispatch' || group.key === 'blocked' || group.key === 'cancelled'
		const empty = skeleton !== true && narrowable && visible.length === 0 && (props.summary === undefined || props.summary === null)
		const subcounts = props.subcounts === undefined || props.subcounts === null ? null : props.subcounts
		const head = h(
			'div',
			{
				className: 'gbt-colhead',
				role: 'button',
				tabIndex: 0,
				'data-collapsible': 'true',
				title: collapsed ? t('expandColumn') : t('collapseColumn'),
				onClick: props.onToggle,
			},
			h('span', { className: 'gbt-colchev', 'aria-hidden': 'true' }, collapsed ? '▸' : '▾'),
			h('span', { className: 'gbt-colname' }, group.label),
			subcounts === null ? null : h('span', { className: 'gbt-colsubcounts', 'data-col-subcounts': 'true' }, [
				h(
					'span',
					{ key: 'ready', className: 'gbt-colsubcount', 'data-subcount': 'ready', title: t('readyCount').replace('{n}', String(subcounts.ready)) },
					h('span', { className: 'gbt-sublabel' }, t('ready')),
					h('b', { className: 'gbt-subnum' }, ' ' + String(subcounts.ready)),
				),
				h(
					'span',
					{ key: 'waiting', className: 'gbt-colsubcount', 'data-subcount': 'waiting', title: t('waitingCount').replace('{n}', String(subcounts.waiting)) },
					h('span', { className: 'gbt-sublabel' }, t('waiting')),
					h('b', { className: 'gbt-subnum' }, ' ' + String(subcounts.waiting)),
				),
			]),
			h('span', { className: 'gbt-colcount' }, String(count)),
			props.note === undefined || props.note === null ? null : h('span', { className: 'gbt-colnote', 'data-col-note': 'investigating' }, props.note),
		)

		return h(
			'section',
			{ className: 'gbt-col', 'data-group': group.key, 'data-collapsed': collapsed ? 'true' : 'false', 'data-empty': empty ? 'true' : 'false', 'data-loading': skeleton ? 'true' : undefined },
			head,
			showBody === false
				? null
				: h(
					'div',
					{ className: 'gbt-cards' },
					props.summary === undefined || props.summary === null ? null : props.summary,
					visible.length === 0
						? skeleton === true
							? [0, 1, 2].map(function (index) {
								return h('div', { key: 'skeleton-' + String(index), className: 'gbt-skel gbt-skelcard', 'data-card-skeleton': 'true' })
							})
							: h(
								'div',
								{ className: 'gbt-empty gbt-emptyslim', 'data-col-empty': group.key },
								props.emptyTitle === undefined || props.emptyTitle === null ? null : h('span', { className: 'gbt-emptytitle' }, props.emptyTitle),
								h('span', null, props.emptyHint === undefined || props.emptyHint === null ? t('noTasks') : props.emptyHint),
							)
						: visible.map(function (task) {
							return h(TaskCard, {
								key: task.id,
								task: task,
								allTasks: props.allTasks,
								t: t,
								now: props.now,
								selected: props.selectedId === task.id,
								onOpen: props.onOpen,
								onVerdict: props.onVerdict,
							})
						}),
				),
			props.footer === undefined || props.footer === null ? null : h('div', { className: 'gbt-colfoot' }, props.footer),
		)
	}

	return Column
}

module.exports = { createColumn }

				})(module, module.exports)
				const factory = module.exports.createColumn
				return factory({ h: h, TaskCard: TaskCard })
			})()

			const Board = (function () {
				const module = { exports: {} }
				;(function (module, exports) {
/**
 * Board view module.
 *
 * T-158 (夜航作战板): six active lanes. ready + waiting collapse into one 待派发
 * lane whose head carries BOTH counts; the done lane always shows the newest
 * cards plus the archive entry point, and an empty lane narrows instead of
 * stretching. The kind filter lives in the panel toolbar now, so the board only
 * reads props.kind.
 *
 * T-194: cancelled is a terminal state, not a variety of "blocked". It gets its
 * own 已取消 lane AFTER 阻塞, so terminal cards stay visible instead of
 * masquerading as blocked, while 阻塞 holds only really blocked cards. The lane
 * order is dispatch / running / reviewing / testing / done / blocked / cancelled.
 */
function createBoard(deps) {
	const React = deps.React
	const h = deps.h
	const Column = deps.Column
	const tcTime = deps.tcTime
	const tcKindOf = deps.tcKindOf
	const tcFirstNonEmptyColumn = deps.tcFirstNonEmptyColumn
	const tcColumnCollapsed = deps.tcColumnCollapsed
	const tcWriteColumnCollapsed = deps.tcWriteColumnCollapsed
	const DONE_COLUMN_PREVIEW = deps.DONE_COLUMN_PREVIEW
	const boardUiState = deps.boardUiState

	function Board(props) {
		// T-135: the board is its own scrollport and parks on the first lane with
		// cards; T-158 keeps that behaviour and T-194 extends it to the seven-lane
		// layout.
		const boardRef = React.useRef(null)
		const t = props.t
		const tasks = props.snapshot.tasks
		const loading = props.loading === true
		const counts = props.snapshot.counts === undefined || props.snapshot.counts === null ? {} : props.snapshot.counts
		function recentFirst(left, right) {
			const leftAt = tcTime(left.updatedAt) === null ? tcTime(left.createdAt) : tcTime(left.updatedAt)
			const rightAt = tcTime(right.updatedAt) === null ? tcTime(right.createdAt) : tcTime(right.updatedAt)
			const delta = (rightAt === null ? 0 : rightAt) - (leftAt === null ? 0 : leftAt)
			return delta !== 0 ? delta : String(right.id).localeCompare(String(left.id))
		}
		const kindFilter = props.kind === 'dev' || props.kind === 'investigate' ? props.kind : 'all'
		const filtered = kindFilter === 'all' ? tasks : tasks.filter(function (task) { return tcKindOf(task) === kindFilter })
		const investigatingRunning = filtered.filter(function (task) { return tcKindOf(task) === 'investigate' && task.status === 'running' }).length
		const visibleDone = filtered.filter(function (task) { return task.status === 'done' }).slice().sort(recentFirst)
		const doneCount = kindFilter === 'all' && Number.isFinite(counts.done) ? counts.done : visibleDone.length
		const pending = filtered.filter(function (task) { return task.status === 'pending' })
		const readyTasks = pending.filter(function (task) { return task.dependency !== undefined && task.dependency !== null && task.dependency.state === 'ready' })
		const waitingTasks = pending.filter(function (task) { return !(task.dependency !== undefined && task.dependency !== null && task.dependency.state === 'ready') })
		// T-158: six active lanes. 待派发 covers BOTH ready and waiting cards; its
		// head shows the two numbers so the split stays readable without a second
		// dispatch lane. T-194 appends 已取消 as the seventh, TERMINAL lane.
		// T-159: every lane is always emitted (even when empty); the width policy is
		// decided in the column/ CSS, not by dropping lanes from the board.
		const groups = [
			{ key: 'dispatch', label: t('dispatchCol'), tasks: readyTasks.concat(waitingTasks), subcounts: { ready: readyTasks.length, waiting: waitingTasks.length } },
			{ key: 'running', label: t('runningCol'), tasks: filtered.filter(function (task) { return task.status === 'running' }) },
			{ key: 'reviewing', label: t('reviewingCol'), tasks: filtered.filter(function (task) { return task.status === 'reviewing' }) },
			{ key: 'testing', label: t('testingCol'), tasks: filtered.filter(function (task) { return task.status === 'testing' }) },
			{ key: 'done', label: t('doneCol'), tasks: visibleDone },
			// T-194: cancelled is TERMINAL and never "blocked": the 阻塞 lane holds only
			// cards that are really blocked, and the 已取消 lane below keeps the terminal
			// cards visible (still queryable through board/list as well).
			{ key: 'blocked', label: t('blockedCol'), tasks: filtered.filter(function (task) { return task.status === 'blocked' }).slice().sort(recentFirst) },
			{ key: 'cancelled', label: t('cancelledCol'), tasks: filtered.filter(function (task) { return task.status === 'cancelled' }).slice().sort(recentFirst) },
		]
		const scrollTarget = tcFirstNonEmptyColumn(groups)
		React.useEffect(function () {
			const board = boardRef.current
			if (board === null || board === undefined) return
			if (typeof board.scrollLeft !== 'number') return
			if (scrollTarget === null) {
				board.scrollLeft = 0
				return
			}
			if (typeof board.querySelector !== 'function') return
			const target = board.querySelector('[data-group="' + scrollTarget + '"]')
			if (target === null) return
			const scrollLeft = board.scrollLeft
			const clientWidth = typeof board.clientWidth === 'number' ? board.clientWidth : 0
			const left = typeof target.offsetLeft === 'number' ? target.offsetLeft : 0
			const width = typeof target.offsetWidth === 'number' ? target.offsetWidth : 0
			if (left >= scrollLeft && left + width <= scrollLeft + clientWidth) return
			board.scrollLeft = Math.max(0, left - 12)
		}, [tasks.length, kindFilter, scrollTarget])
		if (tasks.length === 0 && loading !== true) return h('div', { className: 'gbt-empty' }, t('emptyBoard'))
		function toggle(key) {
			tcWriteColumnCollapsed(key, !tcColumnCollapsed(key))
			if (props.onColumnToggle !== undefined) props.onColumnToggle()
		}
		const donePreview = visibleDone.slice(0, DONE_COLUMN_PREVIEW)
		// T-158 review: an EMPTY done lane must stay empty (and narrow). The archive
		// summary only exists when there is something to archive.
		const doneSummary = loading === true || doneCount === 0 ? null : h(
			'div',
			{ className: 'gbt-done-summary', 'data-done-summary': 'true' },
			h('span', null, t('doneAllSummary').replace('{total}', String(doneCount)).replace('{recent}', String(donePreview.length))),
			h('button', { type: 'button', className: 'gbt-linkbtn', 'data-action': 'done-all', onClick: function () { if (props.onOpenDoneAll !== undefined) props.onOpenDoneAll() } }, t('viewArchive')),
		)
		const board = h(
			'div',
			{ className: 'gbt-board', ref: boardRef, 'data-scroll-target': scrollTarget === null ? '' : scrollTarget },
			groups.map(function (group) {
				const collapsed = tcColumnCollapsed(group.key)
				if (group.key === 'done') {
					return h(Column, {
						key: group.key,
						group: group,
						count: doneCount,
						visibleTasks: collapsed ? donePreview : visibleDone,
						summary: doneSummary,
						collapsed: collapsed,
						allTasks: tasks,
						previewWhenCollapsed: true,
						skeleton: loading,
						t: t,
						now: props.now,
						selectedId: props.selectedId,
						onOpen: props.onOpen,
						onVerdict: props.onVerdict,
						onToggle: function () { toggle(group.key) },
					})
				}
				if (group.key === 'blocked') {
					return h(Column, {
						key: group.key,
						group: group,
						collapsed: collapsed,
						allTasks: tasks,
						t: t,
						now: props.now,
						selectedId: props.selectedId,
						emptyTitle: t('noBlockedTitle'),
						emptyHint: t('noBlockedHint'),
						skeleton: loading,
						onOpen: props.onOpen,
						onVerdict: props.onVerdict,
						onToggle: function () { toggle(group.key) },
					})
				}
				return h(Column, {
					key: group.key,
					group: group,
					collapsed: collapsed,
					allTasks: tasks,
					t: t,
					now: props.now,
					selectedId: props.selectedId,
					subcounts: group.subcounts === undefined ? null : group.subcounts,
					skeleton: loading,
					note: group.key === 'running' && investigatingRunning > 0 ? t('investigatingCount').replace('{n}', String(investigatingRunning)) : null,
					onOpen: props.onOpen,
					onVerdict: props.onVerdict,
					onToggle: function () { toggle(group.key) },
				})
			}),
		)

		return h('div', { className: 'gbt-boardwrap', 'data-board-kind': kindFilter }, board)
	}

	return Board
}

module.exports = { createBoard }

				})(module, module.exports)
				const factory = module.exports.createBoard
				return factory({
					React: React,
					h: h,
					TaskCard: TaskCard,
					Column: Column,
					tcTime: tcTime,
					tcKindOf: tcKindOf,
					tcFirstNonEmptyColumn: tcFirstNonEmptyColumn,
					tcColumnCollapsed: tcColumnCollapsed,
					tcWriteColumnCollapsed: tcWriteColumnCollapsed,
					DONE_COLUMN_PREVIEW: DONE_COLUMN_PREVIEW,
					boardUiState: boardUiState,
				})
			})()

			/** Local day bucket for the completed-tasks drawer. */
			function tcDayKey(iso, nowMs) {
				const at = tcTime(iso)
				if (at === null) return 'earlier'
				const day = new Date(at)
				const today = new Date(nowMs)
				const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()
				const startOfYesterday = startOfToday - 24 * 60 * 60 * 1000
				if (at >= startOfToday) return 'today'
				if (at >= startOfYesterday) return 'yesterday'
				return 'earlier'
			}

			/**
			 * The "all completed tasks" drawer: paged (50/page) through the T-82
			 * /list route, searched server-side with a debounce, grouped by local day,
			 * and summary-only - a click opens the detail drawer, which fetches one
			 * card, instead of pulling 50 details up front.
			 */
			const { QueueRow, QueueView } = (function () {
				const module = { exports: {} }
				;(function (module, exports) {
/**
 * Queue view module.
 *
 * Extracted from the views fragment; h is injected by the build.
 */
function createQueueViews(deps) {
	const h = deps.h

	function QueueRow(props) {
		const task = props.task
		const deps = Array.isArray(task.dependsOn) ? task.dependsOn : []
		const files = Array.isArray(task.writeFiles) ? task.writeFiles : null
		const fileCount = files !== null ? files.length : Number.isFinite(task.writeFileCount) ? task.writeFileCount : 0
		return h(
			'div',
			{ className: 'gbt-row', role: 'button', tabIndex: 0, onClick: function () { props.onOpen(task.id) } },
			h('span', { className: 'gbt-order' }, props.index === undefined ? '·' : String(props.index + 1)),
			h('span', { className: 'gbt-id' }, task.id),
			h(
		'div',
		null,
		h('div', { className: 'gbt-rowtitle' }, task.title),
		h(
			'div',
			{ className: 'gbt-cardmeta' },
			task.priority !== 0 ? h('span', { className: 'gbt-chip' }, 'P' + String(task.priority)) : null,
			deps.length > 0
				? h('span', { className: 'gbt-chip', 'data-tone': 'waiting' }, '↳ ' + deps.join(', '))
				: h('span', { className: 'gbt-chip', 'data-tone': 'ready' }, props.t('noDeps')),
			fileCount > 0 ? h('span', { className: 'gbt-chip' }, '🔒 ' + (files === null ? String(fileCount) : files.join(', '))) : null,
		),
			),
			h(
		'div',
		{ className: 'gbt-rowmeta' },
		props.stateLabel === undefined ? null : h('span', { className: 'gbt-chip', 'data-tone': props.tone }, props.stateLabel),
			),
		)
	}

	function QueueView(props) {
		const queue = props.snapshot.queue.slice()
		const waiting = props.snapshot.tasks.filter(function (task) {
			return task.status === 'pending' && (task.dependency === undefined || task.dependency.state !== 'ready')
		})
		const blocks = []
		blocks.push(h('p', { key: 'hint', className: 'gbt-footnote' }, props.t('queueHint')))
		blocks.push(h('div', { key: 'title', className: 'gbt-section' }, h('h3', null, props.t('queue') + ' · ' + String(queue.length))))
		blocks.push(
			queue.length === 0
		? h('div', { key: 'empty', className: 'gbt-empty' }, props.t('emptyQueue'))
		: h(
				'div',
				{ key: 'rows', className: 'gbt-rowlist' },
				queue.map(function (task, index) {
			return h(QueueRow, { key: task.id, task: task, index: index, t: props.t, onOpen: props.onOpen })
				}),
			),
		)
		if (waiting.length > 0) {
			blocks.push(h('div', { key: 'waiting-title', className: 'gbt-section', style: { marginTop: '18px' } }, h('h3', null, props.t('waiting') + ' · ' + String(waiting.length))))
			blocks.push(
		h(
			'div',
			{ key: 'waiting', className: 'gbt-rowlist' },
			waiting.map(function (task) {
				const broken = task.dependency !== undefined && task.dependency.state === 'broken'
				return h(QueueRow, {
			key: task.id,
			task: task,
			t: props.t,
			tone: broken ? 'broken' : 'waiting',
			stateLabel: broken
				? props.t('brokenOn') + ' ' + (task.dependency !== undefined && Array.isArray(task.dependency.brokenOn) ? task.dependency.brokenOn.join(', ') : '')
				: props.t('waitingOn') + ' ' + (task.dependency !== undefined && Array.isArray(task.dependency.waitingOn) ? task.dependency.waitingOn.join(', ') : ''),
			onOpen: props.onOpen,
				})
			}),
		),
			)
		}
		return h('div', null, blocks)
	}


	return { QueueRow: QueueRow, QueueView: QueueView }
}

module.exports = { createQueueViews }

				})(module, module.exports)
				const factory = module.exports.createQueueViews
				return factory({ h: h })
			})()

			const AgentRow = (function () {
				const module = { exports: {} }
				;(function (module, exports) {
/**
 * Agent row module.
 *
 * One member of the live execution tree: role, agent, status and the task it is
 * running. The root Agent is the same shape with isRoot set; there is no team
 * roster and no worker-pool slot behind this row.
 */
function createAgentRow(deps) {
	const h = deps.h
	const roleKindLabel = deps.roleKindLabel
	const tcAgentStatusKey = deps.tcAgentStatusKey

	function AgentRow(props) {
		const t = props.t
		const member = props.member === null || props.member === undefined ? {} : props.member
		const isRoot = props.isRoot === true
		const name = typeof member.name === 'string' && member.name !== '' ? member.name : typeof member.id === 'string' && member.id !== '' ? member.id : '—'
		const role = typeof member.role === 'string' && member.role !== '' ? member.role : null
		const status = typeof member.status === 'string' && member.status !== '' ? member.status : null
		const taskId = typeof member.taskId === 'string' && member.taskId !== '' ? member.taskId : null
		const roleText = isRoot ? t('agentRootRole') : role === null ? '—' : roleKindLabel(role, t)
		return h(
			'tr',
			{
				'data-agent': name,
				'data-agent-id': typeof member.id === 'string' ? member.id : '',
				'data-agent-role': isRoot ? 'root' : role === null ? '' : role,
				'data-agent-status': status === null ? '' : status,
				'data-agent-task': taskId === null ? '' : taskId,
				'data-agent-root': isRoot ? 'true' : undefined,
			},
			h('td', { 'data-col': 'agent-role' }, h('span', { className: 'gbt-pill', 'data-role-badge': isRoot ? 'root' : role === null ? '' : role }, roleText)),
			h('td', { className: 'gbt-mono', 'data-col': 'agent-name' }, h('span', { className: 'gbt-workername', title: name }, name)),
			h('td', { 'data-col': 'agent-status' }, status === null ? '—' : h('span', { className: 'gbt-pill', 'data-status': status }, t(tcAgentStatusKey(status)))),
			h('td', { className: 'gbt-mono', 'data-col': 'agent-task', title: taskId === null ? '' : taskId }, taskId === null ? '—' : taskId),
		)
	}

	return AgentRow
}

module.exports = { createAgentRow }

				})(module, module.exports)
				const factory = module.exports.createAgentRow
				return factory({ h: h, roleKindLabel: roleKindLabel, tcAgentStatusKey: tcAgentStatusKey })
			})()

			const WorkersView = (function () {
				const module = { exports: {} }
				;(function (module, exports) {
/**
 * Agents view module.
 *
 * The live execution tree: the root Agent of this session plus every live child
 * the Host reports in snapshot.agentTree. There is no team roster, no worker
 * pool and no "Lead + members" framing; a Host that reports no tree renders a
 * neutral unavailable state instead of an invented membership.
 */
function createWorkersView(deps) {
	const React = deps.React
	const h = deps.h
	const tcBaseName = deps.tcBaseName
	const tcAgentTreeOf = deps.tcAgentTreeOf
	const AgentRow = deps.AgentRow
	const copyToClipboard = deps.copyToClipboard

	function WorkersView(props) {
		const t = props.t
		const snapshot = props.snapshot
		const [copied, setCopied] = React.useState(null)
		const tree = tcAgentTreeOf(snapshot)
		const shell = function (child) { return h('div', { className: 'gbt-workersview', 'data-agent-tree-view': 'true' }, child) }
		const hint = h('p', { key: 'hint', className: 'gbt-footnote', 'data-agent-hint': 'true' }, t('agentsHint'))
		if (snapshot.source === 'error' || snapshot.agentTree === null || snapshot.agentTree === undefined || tree.available !== true) {
			return shell([
				hint,
				h('div', { key: 'unavailable', className: 'gbt-empty', 'data-agent-unavailable': 'true' }, t('agentsUnavailable')),
				tree.error === null ? null : h('p', { key: 'error', className: 'gbt-footnote', 'data-agent-error': tree.error }, tree.error),
			])
		}
		const root = tree.root
		const rootName = root !== null && typeof root.name === 'string' && root.name !== '' ? root.name : root !== null && typeof root.id === 'string' && root.id !== '' ? root.id : null
		const rootSession = root !== null && typeof root.id === 'string' && root.id !== '' ? root.id : null
		const project = typeof snapshot.project === 'string' && snapshot.project !== '' ? snapshot.project : null
		const identity = h(
			'div',
			{ key: 'identity', className: 'gbt-workeridentity', 'data-agent-identity': 'true' },
			h('span', { key: 'project', className: 'gbt-workerid', 'data-agent-project': project === null ? '' : project },
				h('span', { className: 'gbt-workeridlabel' }, t('agentsProject')),
				h('b', { title: project === null ? '' : project }, project === null ? '—' : tcBaseName(project))),
			h('span', { key: 'root', className: 'gbt-workerid', 'data-agent-root': rootSession === null ? '' : rootSession },
				h('span', { className: 'gbt-workeridlabel' }, t('agentsRoot')), ' ',
				h('b', { className: 'gbt-mono', title: rootSession === null ? '' : rootSession }, rootName === null ? '—' : rootName)),
			h('span', { key: 'live', className: 'gbt-workerid', 'data-agent-live': String(tree.members.length) },
				h('span', { className: 'gbt-workeridlabel' }, t('agentsLive')), ' ',
				h('b', null, String(tree.members.length))),
			rootSession === null
				? null
				: h('button', { key: 'copy', type: 'button', className: 'gbt-btn', 'data-action': 'copy-session', 'data-session': rootSession, onClick: function () { void copyToClipboard(rootSession).then(function (ok) { setCopied(ok === true ? rootSession : 'failed') }) } }, copied === rootSession ? t('sessionCopied') : t('copySession')),
			copied === 'failed' ? h('span', { key: 'copy-failed', className: 'gbt-footnote' }, ' ' + t('copyFailed')) : null,
		)
		const head = h(
			'div',
			{ key: 'head', className: 'gbt-workerhead', 'data-agent-head': 'true' },
			h('div', { key: 'title', className: 'gbt-workerheadtop' }, h('h3', { className: 'gbt-workertitle' }, t('agentsTitle'))),
			identity,
		)
		const blocks = [hint, head]
		if (root === null) {
			blocks.push(h('div', { key: 'noroot', className: 'gbt-empty', 'data-agent-empty': 'noroot' }, t('agentsNoRoot')))
			return shell(blocks)
		}
		const rows = [h(AgentRow, { key: 'agent-root', member: root, isRoot: true, t: t })].concat(
			tree.members.map(function (member, index) {
				return h(AgentRow, { key: 'agent-' + (typeof member.id === 'string' && member.id !== '' ? member.id : String(index)), member: member, isRoot: false, t: t })
			}),
		)
		blocks.push(
			h('div', { key: 'tablewrap', className: 'gbt-tablewrap' },
				h('table', { className: 'gbt-locktable gbt-workertable', 'data-agent-table': 'true' },
					h('thead', null, h('tr', null, h('th', null, t('agentRole')), h('th', null, t('agentName')), h('th', null, t('agentStatus')), h('th', null, t('agentTask')))),
					h('tbody', null, rows))),
		)
		if (tree.members.length === 0) blocks.push(h('div', { key: 'empty', className: 'gbt-empty', 'data-agent-empty': 'no-children' }, t('agentsNoChildren')))
		return shell(blocks)
	}

	return WorkersView
}

module.exports = { createWorkersView }

				})(module, module.exports)
				const factory = module.exports.createWorkersView
				return factory({ React: React, h: h, tcBaseName: tcBaseName, tcAgentTreeOf: tcAgentTreeOf, AgentRow: AgentRow, copyToClipboard: copyToClipboard })
			})()


			// ── Roles / Status views: stage profiles, worktrees, activity and role admin ──
			const ROLE_KIND_KEYS = { worker: 'roleKindWorker', reviewer: 'roleKindReviewer', tester: 'roleKindTester' }
			const WORKTREE_TYPE_KEYS = { main: 'wtTypeMain', task: 'wtTypeTask', verify: 'wtTypeVerify', test: 'wtTypeTest', merge: 'wtTypeMerge', other: 'wtTypeOther' }
			const ROLE_ERROR_KEYS = {
				'missing-name': 'roleErrMissingName',
				'invalid-role-name': 'roleErrName',
				'invalid-role-profile': 'roleErrProfile',
				'invalid-role-kind': 'roleErrKind',
				'invalid-role-stage': 'roleErrStage',
				'invalid-role-skills': 'roleErrSkills',
				'invalid-role-context': 'roleErrContext',
				'invalid-role-permissions': 'roleErrPermissions',
				'invalid-role-prompt': 'roleErrPrompt',
				'unknown-role-profile': 'roleErrUnknownProfile',
				'stage-mismatch': 'roleErrStageMismatch',
				'invalid-stage': 'roleErrStage',
				'role-exists': 'roleErrExists',
				'default-profile': 'roleErrDefaultProfile',
				'unknown-role-instance': 'roleErrUnknownInstance',
				'not-live': 'roleErrNotLive',
				'roles-unavailable': 'roleErrUnavailable',
				'user-only': 'roleErrUserOnly',
				'invalid-role-variable': 'roleErrVariable',
				'builtin-profile-readonly': 'roleErrBuiltinReadonly',
				'builtin-profile-immutable': 'roleErrBuiltinReadonly',
				'skills-unavailable': 'roleErrSkillsUnavailable',
				'role-unsaved': 'roleErrUnsaved',
				'action-timeout': 'roleErrActionTimeout',
				'queue-timeout': 'roleErrQueueTimeout',
				'action-abandoned': 'roleErrAbandoned',
				'role-config-write-failed': 'roleErrWriteFailed',
				'role-ensure-failed': 'roleErrEnsureFailed',
			}

			function roleKindLabel(kind, t) {
				const key = ROLE_KIND_KEYS[kind]
				return key === undefined ? String(kind === undefined || kind === null ? '—' : kind) : t(key)
			}

			function worktreeTypeLabel(type, t) {
				const key = WORKTREE_TYPE_KEYS[type]
				return key === undefined ? String(type === undefined || type === null ? 'other' : type) : t(key)
			}

			/** Agent events carry the agent's name; host/system events never do. */
			function actorLabel(entry, t) {
				if (entry.actor === 'agent') {
					return typeof entry.actorName === 'string' && entry.actorName !== '' ? entry.actorName : t('statusActorAgent')
				}
				if (entry.actor === 'host') return t('statusActorHost')
				return t('statusActorSystem')
			}

			function roleErrorText(payload, t) {
				if (payload === null || payload === undefined) return ''
				const code = typeof payload.code === 'string' ? payload.code : ''
				const key = ROLE_ERROR_KEYS[code]
				const label = key === undefined ? (code === '' ? t('error') : code) : t(key)
				const message = typeof payload.message === 'string' && payload.message !== '' ? ' — ' + payload.message : ''
				return label + message
			}

			async function copyToClipboard(value) {
				try {
					if (typeof navigator !== 'undefined' && navigator !== null && navigator.clipboard !== undefined && navigator.clipboard !== null && typeof navigator.clipboard.writeText === 'function') {
						await navigator.clipboard.writeText(value)
						return true
					}
				} catch (_error) {}
				return false
			}

			function tcSplitList(value) {
				return String(value === undefined || value === null ? '' : value)
					.split(',')
					.map(function (part) { return part.trim() })
					.filter(function (part) { return part !== '' })
			}

			const RoleCreateForm = (function () {
				const module = { exports: {} }
				;(function (module, exports) {
/**
 * Role create form view module.
 *
 * Extracted from the roles fragment; React, h, tcSplitList and roleKindLabel
 * are injected by the build.
 *
 * The form is rendered inside the stage rail, so the kind it creates defaults to
 * the stage the user is editing (`defaultRole`); a fixed reviewer default would
 * create a profile for another stage and the immediate bind would be refused
 * with stage-mismatch.
 */
function createRoleCreateForm(deps) {
	const React = deps.React
	const h = deps.h
	const tcSplitList = deps.tcSplitList
	const roleKindLabel = deps.roleKindLabel

	function RoleCreateForm(props) {
		const t = props.t
		// Stage-scoped default: worker/implement, reviewer/review or tester/test.
		const roleDefault = typeof props.defaultRole === 'string' && ['worker', 'reviewer', 'tester'].indexOf(props.defaultRole) >= 0 ? props.defaultRole : 'reviewer'
		const nameRef = React.useRef(null)
		const roleRef = React.useRef(null)
		const skillsRef = React.useRef(null)
		const contextRef = React.useRef(null)
		const permissionsRef = React.useRef(null)
		const promptRef = React.useRef(null)
		function valueOf(ref, fallback) {
			if (ref.current === null || ref.current === undefined) return fallback
			return typeof ref.current.value === 'string' ? ref.current.value : fallback
		}
		function submit() {
			const name = valueOf(nameRef, '').trim()
			if (name === '') {
		props.onInvalid('invalid-role-name')
		return
			}
			props.onCreate(name, {
		role: valueOf(roleRef, roleDefault),
		skills: tcSplitList(valueOf(skillsRef, '')),
		context: valueOf(contextRef, 'fresh'),
		permissions: tcSplitList(valueOf(permissionsRef, 'read-only')),
		prompt: valueOf(promptRef, ''),
			})
		}
		return h(
			'div',
			{ className: 'gbt-formgrid', 'data-form': 'role-create' },
			h('label', null, t('roleName'), h('input', { ref: nameRef, className: 'gbt-input', 'data-field': 'name', defaultValue: '', spellCheck: false })),
			h('label', null, t('roleKind'), h('select', { ref: roleRef, defaultValue: roleDefault, 'data-field': 'role' }, ['worker', 'reviewer', 'tester'].map(function (kind) { return h('option', { key: kind, value: kind }, roleKindLabel(kind, t)) }))),
			h('label', null, t('roleSkills'), h('input', { ref: skillsRef, className: 'gbt-input', 'data-field': 'skills', defaultValue: '', spellCheck: false })),
			h('label', null, t('roleContext'), h('select', { ref: contextRef, defaultValue: 'fresh', 'data-field': 'context' }, [h('option', { key: 'fresh', value: 'fresh' }, 'fresh'), h('option', { key: 'fork', value: 'fork' }, 'fork')])),
			h('label', null, t('rolePermissions'), h('input', { ref: permissionsRef, className: 'gbt-input', 'data-field': 'permissions', defaultValue: 'read-only', spellCheck: false })),
			h('label', { className: 'gbt-formwide' }, t('rolePrompt'), h('textarea', { ref: promptRef, className: 'gbt-input', 'data-field': 'prompt', defaultValue: '', rows: 3 })),
			h('div', { className: 'gbt-formactions' }, h('button', { type: 'button', className: 'gbt-btn', 'data-variant': 'primary', 'data-action': 'rolesCreate', onClick: submit }, t('roleCreate'))),
		)
	}

	/**
	 * The banner of the user's LAST action. A successful payload this panel
	 * cannot describe (an action it does not own, or an empty answer) renders
	 * NOTHING: claiming "saved" for an unrecognised success would be a lie.
	 */

	return RoleCreateForm
}

module.exports = { createRoleCreateForm }

				})(module, module.exports)
				const factory = module.exports.createRoleCreateForm
				return factory({ React: React, h: h, tcSplitList: tcSplitList, roleKindLabel: roleKindLabel })
			})()

			function roleResultBanner(result, t) {
				if (result === null || result === undefined) return null
				const payload = result.payload
				if (result.ok !== true) {
					return h('div', { className: 'gbt-banner', 'data-tone': 'error', 'data-role-result': 'error' }, t('roleActionFailed') + ': ' + roleErrorText(payload, t))
				}
				const parts = []
				if (payload !== null && payload !== undefined) {
					if (Array.isArray(payload.drained) && payload.drained.length > 0) parts.push(t('roleDrained') + ': ' + payload.drained.join(', '))
					if (Array.isArray(payload.created) && payload.created.length > 0) parts.push(t('roleCreated') + ': ' + payload.created.map(function (entry) { return entry.name }).join(', '))
					if (Array.isArray(payload.replaced) && payload.replaced.length > 0) parts.push(t('roleReplaced') + ': ' + payload.replaced.map(function (entry) { return typeof entry === 'string' ? entry : String(entry.name) }).join(', '))
					if (Array.isArray(payload.reused) && payload.reused.length > 0) parts.push(t('roleReused') + ': ' + payload.reused.join(', '))
					if (typeof payload.source === 'string') parts.push(t('roleSource') + ': ' + payload.source)
					const waited = payload.waited === undefined || payload.waited === null ? null : payload.waited
					if (waited !== null) {
						parts.push(t('roleWaited') + ': ' + String(waited.waitedMs) + 'ms')
						if (waited.timedOut === true) parts.push(t('roleTimedOut'))
						const waiting = Array.isArray(waited.waiting) ? waited.waiting : []
						if (waiting.length > 0) parts.push(t('roleWaiting') + ': ' + waiting.map(function (entry) { return typeof entry === 'string' ? entry : entry.name }).join(', '))
					}
					if (Array.isArray(payload.ensured)) {
						parts.push(t('roleCreated') + ': ' + String(payload.ensured.length))
						const failed = payload.ensured.filter(function (entry) {
							return entry !== null && entry !== undefined && entry.result !== null && entry.result !== undefined && entry.result.ok !== true
						})
						if (failed.length > 0) {
							parts.push(t('roleActionFailed') + ': ' + failed.map(function (entry) { return String(entry.kind) + ': ' + roleErrorText(entry.result, t) }).join('; '))
						}
					}
				}
				if (parts.length === 0) return null
				return h('div', { className: 'gbt-banner', 'data-tone': 'info', 'data-role-result': 'ok' }, parts.join(' · '))
			}

			/** One grouped card section with a title row. */
			/** Horizontal scrolling wrapper so narrow screens scroll, not squash. */
			function tableWrap(key, table) {
				return h('div', { key: key, className: 'gbt-tablewrap' }, table)
			}

			/**
			 * The context editor's state, module-level for the same reason the panel
			 * keeps its view: the main slot unmounts on a view switch, and a
			 * half-finished fork draft or a skills selection must survive. It is
			 * deliberately not React state, so a button click mutates it and forces a
			 * re-render.
			 */
			const roleEditorState = {
				kind: 'worker',
				draft: null,
				selected: null,
				saved: null,
				used: new Set(),
				skillsOpen: false,
				skills: null,
				skillsError: null,
				skillsSelected: new Set(),
				applySkipped: false,
				notice: null,
				// The injected-text preview the host returned for the current identity,
				// the identity it belongs to and the in-flight/failed state around it.
				preview: null,
				previewKey: null,
				previewPending: false,
				previewError: null,
				previewTaskId: '',
			}

			const ROLE_EDITOR_KINDS = ['worker', 'tester', 'reviewer']
			const ROLE_EDITOR_STAGES = { worker: 'implement', reviewer: 'review', tester: 'test' }

			/** The profile bound to a kind's stage, mirroring schema.profileForKind. */
			function roleBoundProfile(config, kind) {
				if (config === null || config === undefined) return null
				const profiles = config.profiles !== null && config.profiles !== undefined && typeof config.profiles === 'object' ? config.profiles : {}
				const stages = config.stages !== null && config.stages !== undefined && typeof config.stages === 'object' ? config.stages : {}
				const stage = ROLE_EDITOR_STAGES[kind]
				const bound = stages[stage]
				if (typeof bound === 'string' && profiles[bound] !== undefined && profiles[bound].stage === stage) return profiles[bound]
				return profiles[kind] === undefined ? null : profiles[kind]
			}

			/** The profiles a kind's identity selector offers: the stage's owners. */
			function roleSelectableProfiles(config, kind) {
				if (config === null || config === undefined) return []
				const profiles = config.profiles !== null && config.profiles !== undefined && typeof config.profiles === 'object' ? config.profiles : {}
				const stage = ROLE_EDITOR_STAGES[kind]
				return Object.keys(profiles).filter(function (name) {
					const profile = profiles[name]
					return profile !== null && profile !== undefined && profile.stage === stage
				})
			}

			/** Only the profile fields a fork copies; the source is never written. */
			function roleProfileCopy(profile) {
				return {
					role: profile.role,
					stage: profile.stage,
					skills: (Array.isArray(profile.skills) ? profile.skills : []).slice(),
					context: profile.context || 'fresh',
					permissions: (Array.isArray(profile.permissions) ? profile.permissions : []).slice(),
					prompt: typeof profile.prompt === 'string' ? profile.prompt : '',
				}
			}

			/**
			 * The role context editor — the whole Roles tab. The host owns the
			 * prompt area is TWO columns: the raw prompt (editable for a custom
			 * profile, read-only for a built-in one) on the left and the exact text
			 * the host injects on the right, fetched from the host's rolesPreview so
			 * it is the real brief builder output, never panel copy. The identity row
			 * owns the profile selection and the stage binding; the kind's instances
			 * live in a compact block inside the same card.
			 */
			const RolesEditor = (function () {
				const module = { exports: {} }
				;(function (module, exports) {
/**
 * Roles editor view module.
 *
 * Extracted from the roles fragment; React, h, the shared role cards/forms,
 * label helpers and the editor state are injected by the build.
 */
function createRolesEditor(deps) {
	const React = deps.React
	const h = deps.h
	const roleResultBanner = deps.roleResultBanner
	const tableWrap = deps.tableWrap
	const roleBoundProfile = deps.roleBoundProfile
	const roleSelectableProfiles = deps.roleSelectableProfiles
	const roleProfileCopy = deps.roleProfileCopy
	const RoleCreateForm = deps.RoleCreateForm
	const roleErrorText = deps.roleErrorText
	const tcSplitList = deps.tcSplitList
	const roleEditorState = deps.roleEditorState
	const ROLE_EDITOR_STAGES = deps.ROLE_EDITOR_STAGES
	const copyToClipboard = deps.copyToClipboard

	function RolesEditor(props) {
		const t = props.t
		const snapshot = props.snapshot
		const store = props.store
		const bump = props.bump
		const config = snapshot.roles
		const kind = roleEditorState.kind
		const stage = ROLE_EDITOR_STAGES[kind] || 'implement'
		const profiles = config !== null && config !== undefined && config.profiles !== null && config.profiles !== undefined && typeof config.profiles === 'object' ? config.profiles : {}
		const bound = roleBoundProfile(config, kind)
		const boundName = bound !== null && typeof bound.name === 'string' ? bound.name : null
		const draft = roleEditorState.draft
		const draftProfile = draft === null ? null : draft.profile
		const saved = roleEditorState.saved
		const options = roleSelectableProfiles(config, kind)
		// The selected name is honoured even before the host snapshot carries the
		// profile: a just-saved Fork must be targetable by Apply immediately,
		// without waiting for the next poll.
		const selectedName = draft !== null ? draft.name : roleEditorState.selected !== null ? roleEditorState.selected : boundName
		const target =
			draftProfile !== null
		? draftProfile
		: selectedName !== null && profiles[selectedName] !== undefined
			? profiles[selectedName]
			: saved !== null && saved.name === selectedName
				? saved.profile
				: null
		const builtin = selectedName === 'worker' || selectedName === 'reviewer' || selectedName === 'tester'
		// The "current use" selector: the stage's built-in default plus every
		// custom copy owning this stage. No bind/apply vocabulary is exposed.
		const useOptions = [kind].concat(options.filter(function (name) { return name !== kind }))
		if (selectedName !== null && useOptions.indexOf(String(selectedName)) < 0) useOptions.push(String(selectedName))
		// Only a profile the user owns (a saved copy or a fork draft) has a prompt
		// that can be edited here. Everything else is a clear empty state, never a
		// blank half-panel.
		const editablePrompt = !builtin && selectedName !== null && target !== null
		// The preview targets the SAVED profile: a fork draft does not exist on the
		// host yet, so its SOURCE profile is what the host would really inject.
		const previewProfileName = draft !== null ? draft.source : selectedName
		const preview = roleEditorState.preview !== null && roleEditorState.preview.kind === kind ? roleEditorState.preview : null
		const previewTasks = Array.isArray(snapshot.tasks) ? snapshot.tasks : []
		const templateText = target !== null && typeof target.prompt === 'string' ? target.prompt : ''
		const skillsText = target !== null && Array.isArray(target.skills) ? target.skills.join(', ') : ''
		const catalog = Array.isArray(roleEditorState.skills) ? roleEditorState.skills : []
		const allInstances = (Array.isArray(props.instances) ? props.instances : []).filter(function (entry) { return entry !== null && entry !== undefined && typeof entry.kind === 'string' })
		const instances = allInstances.filter(function (entry) { return entry.kind === kind })
		// The three stages, in dispatch order. The rail lists them as 01/02/03 and
		// they are the ONLY stage navigation on the page.
		const STAGE_SLOTS = [
			{ key: 'implement', kind: 'worker', num: '01', label: 'roleKindWorker', desc: 'roleStageImplementDesc' },
			{ key: 'review', kind: 'reviewer', num: '02', label: 'roleKindReviewer', desc: 'roleStageReviewDesc' },
			{ key: 'test', kind: 'tester', num: '03', label: 'roleKindTester', desc: 'roleStageTestDesc' },
		]
		const stageBoundProfile = function (stageKey) {
			const stages = config !== null && config !== undefined && config.stages !== null && config.stages !== undefined ? config.stages : {}
			return typeof stages[stageKey] === 'string' && stages[stageKey] !== '' ? stages[stageKey] : null
		}
		const templateRef = React.useRef(null)
		const skillsRef = React.useRef(null)
		// Real React reuses a host node across renders, so an uncontrolled control
		// only takes a new defaultValue when it REMOUNTS. The key carries the editor
		// identity AND whether the identity is still a draft: switching kind,
		// forking and a successful save all remount the controls on the right
		// profile instead of silently keeping the previous profile's text (which
		// would then be saved onto the wrong profile).
		const controlKey = kind + ':' + (draft !== null ? String(draft.name) : String(selectedName)) + ':' + (draft !== null ? 'draft' : 'saved')
		// What the selector shows as "in use": the draft's source while a draft is
		// open, otherwise the edited profile (falling back to the bound one).
		const useValue = draft !== null ? String(draft.source) : selectedName !== null ? String(selectedName) : String(kind)

		/**
		 * The identity a preview belongs to: kind + the saved profile + the chosen
		 * task. Changing any of them re-asks the host, so the right column can
		 * never show the injected text of a different identity.
		 */
		function previewKeyOf() {
			return kind + '|' + String(previewProfileName === null ? '' : previewProfileName) + '|' + String(roleEditorState.previewTaskId === undefined ? '' : roleEditorState.previewTaskId)
		}
		/** Ask the host for the injected text once per identity; a stale answer is dropped. */
		function ensurePreview() {
			if (roleEditorState.previewPending === true) return
			const key = previewKeyOf()
			if (roleEditorState.previewKey === key) return
			roleEditorState.previewKey = key
			roleEditorState.previewPending = true
			roleEditorState.previewError = null
			const body = { kind: kind }
			if (previewProfileName !== null) body.profile = String(previewProfileName)
			if (typeof roleEditorState.previewTaskId === 'string' && roleEditorState.previewTaskId !== '') body.taskId = roleEditorState.previewTaskId
			// Quiet: the preview is automatic, so its answer must never become the
			// panel's "your last action" result banner.
			Promise.resolve(store.send('rolesPreview', body, { quiet: true })).then(function (outcome) {
		const ok = outcome !== null && outcome !== undefined && outcome.ok === true
		const payload = outcome !== null && outcome !== undefined && outcome.payload !== undefined ? outcome.payload : null
		roleEditorState.previewPending = false
		if (roleEditorState.previewKey !== key) {
			bump()
			return
		}
		if (ok === true && payload !== null && typeof payload.text === 'string') {
			roleEditorState.preview = payload
			roleEditorState.previewError = null
		} else {
			roleEditorState.preview = null
			roleEditorState.previewError = payload !== null && typeof payload === 'object' ? payload : { code: 'preview-unavailable' }
		}
		bump()
			})
		}
		React.useEffect(function () {
			ensurePreview()
		})

		function currentTemplate() {
			const node = templateRef.current
			return node !== null && node !== undefined && typeof node.value === 'string' ? node.value : templateText
		}
		function currentSkills() {
			const node = skillsRef.current
			if (node !== null && node !== undefined && typeof node.value === 'string') return tcSplitList(node.value)
			return target !== null && Array.isArray(target.skills) ? target.skills.slice() : []
		}
		/** Discard a drop draft; nothing was ever written to the host. */
		function discardDraft() {
			roleEditorState.draft = null
			roleEditorState.saved = null
			roleEditorState.applySkipped = false
			roleEditorState.notice = null
			bump()
		}
		/** Fork is a DRAFT now: the user names it, then Save creates + applies it. */
		function fork() {
			if (target === null || selectedName === null) return
			let candidate = String(selectedName) + '-fork'
			let index = 2
			while (profiles[candidate] !== undefined || roleEditorState.used.has(candidate)) {
		candidate = String(selectedName) + '-fork-' + String(index)
		index += 1
			}
			roleEditorState.used.add(candidate)
			roleEditorState.draft = { source: String(selectedName), name: candidate, profile: roleProfileCopy(target) }
			roleEditorState.saved = null
			roleEditorState.applySkipped = false
			roleEditorState.notice = null
			bump()
		}
		// The editor reports its own outcome: a client-side refusal has no store
		// event, and the banner must survive the panel's re-render.
		function report(action, ok, payload) {
			roleEditorState.notice = { action: action, ok: ok, payload: payload }
			bump()
		}
		async function send(action, body) {
			const outcome = await store.send(action, body)
			const ok = outcome !== null && outcome !== undefined && outcome.ok === true
			const payload = outcome !== null && outcome !== undefined && outcome.payload !== undefined && outcome.payload !== null ? outcome.payload : null
			report(action, ok, payload)
			return { ok: ok, payload: payload }
		}
		/** Switch kind: an open draft blocks the switch (never a silent discard). */
		function switchKind(next) {
			if (draft !== null) {
		report('role-editor-kind', false, { code: 'role-unsaved' })
		return
			}
			roleEditorState.kind = next
			roleEditorState.draft = null
			roleEditorState.selected = null
			roleEditorState.saved = null
			roleEditorState.applySkipped = false
			roleEditorState.notice = null
			roleEditorState.preview = null
			roleEditorState.previewKey = null
			roleEditorState.previewPending = false
			roleEditorState.previewError = null
			bump()
		}
		/** Select a profile from the roster; an open draft blocks a silent switch. */
		function selectProfile(name, roleKind) {
			if (typeof name !== 'string' || name === '') return
			if (draft !== null && String(name) !== String(selectedName)) {
				report('role-editor-kind', false, { code: 'role-unsaved' })
				// The picker is controlled: the refused value never reaches it, and nothing
				// remounts, so a typed draft prompt/skills edit survives the refusal.
				return
			}
			roleEditorState.kind = typeof roleKind === 'string' && roleKind !== '' ? roleKind : kind
			roleEditorState.selected = name
			roleEditorState.saved = null
			roleEditorState.applySkipped = false
			roleEditorState.notice = null
			roleEditorState.preview = null
			roleEditorState.previewKey = null
			roleEditorState.previewPending = false
			roleEditorState.previewError = null
			bump()
		}
		/**
		 * ONE switch of "current use": bind the stage to the profile, then replace
		 * the running instances of this kind. With nothing live, only the binding
		 * changes and the panel says it takes effect on the next dispatch.
		 */
		async function applyProfile(name, roleKind) {
			// roleKind defaults to the stage being edited; a blank create can target a
			// different stage, so the caller passes the created profile's own kind.
			const profileKind = typeof roleKind === 'string' && ROLE_EDITOR_STAGES[roleKind] !== undefined ? roleKind : kind
			const profileStage = ROLE_EDITOR_STAGES[profileKind]
			roleEditorState.applySkipped = false
			const boundResult = await send('rolesBind', { stage: profileStage, profile: name })
			if (boundResult.ok !== true) {
		return false
			}
			roleEditorState.selected = name
			// Keep the optimistic copy of a just-created profile so the editor can
			// target it before the next host poll carries it.
			if (roleEditorState.saved !== null && roleEditorState.saved.name !== name) roleEditorState.saved = null
			// A profile change is configuration only: live children keep the prompt
			// they were started with, so there is nothing to drain or replace. Only
			// show the "next dispatch" hint when there is no live instance to reset.
			roleEditorState.applySkipped = runningNames.length === 0
			bump()
			return true
		}
		/**
		 * The "current use" picker: one pick is one action. An open draft blocks the
		 * switch with a readable notice (never a silent discard); the controlled
		 * selector already shows the real value.
		 */
		async function chooseUse(name) {
			if (typeof name !== 'string' || name === '') return
			roleEditorState.notice = null
			if (draft !== null) {
		report('rolesBind', false, { code: 'role-unsaved' })
		return
			}
			if (name === boundName) {
		roleEditorState.selected = name
		roleEditorState.saved = null
		bump()
		return
			}
			await applyProfile(name)
		}
		/**
		 * Create the draft profile, then bind + replace it: Fork must take effect
		 * without a second click. A refused create keeps the draft for a retry.
		 */
		async function commitDraft(name, fromEditor) {
			const submitted = roleEditorState.draft
			if (submitted === null || submitted.name !== name) return
			// Fork copies the source profile as-is; a retry after a refused create
			// must keep whatever the user typed into the editor.
			const body = fromEditor === true
		? Object.assign({}, submitted.profile, { prompt: currentTemplate(), skills: currentSkills() })
		: Object.assign({}, submitted.profile)
			const outcome = await send('rolesCreate', { name: name, profile: body })
			if (outcome.ok !== true || roleEditorState.draft !== submitted) return
			roleEditorState.draft = null
			roleEditorState.selected = name
			roleEditorState.saved = { name: name, profile: Object.assign({}, body, { name: name }) }
			bump()
			await applyProfile(name)
		}
		async function save() {
			// A stale banner must never be read as this attempt's outcome; report() replaces it.
			roleEditorState.notice = null
			const template = currentTemplate()
			const skills = currentSkills()
			if (draft !== null) {
		// The draft name is validated here (kebab-case + uniqueness) exactly
		// like the host would: the same refusal codes are shown.
		const proposed = String(draft.name)
		if (!/^[a-z][a-z0-9-]{0,40}$/.test(proposed)) {
			report('rolesCreate', false, { code: 'invalid-role-name' })
			return
		}
		if (profiles[proposed] !== undefined) {
			report('rolesCreate', false, { code: 'role-exists' })
			return
		}
		await commitDraft(proposed, true)
		return
			}
			if (selectedName === null) return
			if (builtin) {
		// The built-in profiles are host defaults; fork a copy to change them.
		report('rolesUpdate', false, { code: 'builtin-profile-readonly' })
		return
			}
			const outcome = await send('rolesUpdate', { name: selectedName, profile: { prompt: template, skills: skills } })
			if (outcome.ok !== true) return
			// Keep the saved values visible until the host snapshot catches up.
			roleEditorState.saved = { name: selectedName, profile: Object.assign({}, target === null ? {} : target, { prompt: template, skills: skills }) }
			bump()
		}
		/** Delete this copy; if it was in use, the built-in default takes over at once. */
		async function remove() {
			roleEditorState.notice = null
			if (selectedName === null || builtin) return
			const name = selectedName
			const wasBound = name === boundName
			const outcome = await send('rolesDelete', { name: name })
			if (outcome.ok !== true) return
			roleEditorState.selected = null
			roleEditorState.saved = null
			roleEditorState.applySkipped = false
			bump()
			if (wasBound) await applyProfile(kind)
		}
		async function openSkills() {
			roleEditorState.skillsOpen = true
			roleEditorState.skillsError = null
			roleEditorState.skillsSelected = new Set(currentSkills())
			bump()
			const outcome = await store.send('skillsCatalog', {})
			const ok = outcome !== null && outcome !== undefined && outcome.ok === true
			const payload = outcome !== null && outcome !== undefined && outcome.payload !== undefined ? outcome.payload : null
			if (ok === true) {
		roleEditorState.skills = payload !== null && payload !== undefined && Array.isArray(payload.skills) ? payload.skills : []
		roleEditorState.skillsError = null
			} else {
		roleEditorState.skills = null
		roleEditorState.skillsError = payload === null || payload === undefined ? { code: 'skills-unavailable' } : payload
			}
			bump()
		}
		function toggleSkill(name) {
			if (roleEditorState.skillsSelected.has(name)) roleEditorState.skillsSelected.delete(name)
			else roleEditorState.skillsSelected.add(name)
			bump()
		}
		function saveSkills() {
			const names = Array.from(roleEditorState.skillsSelected)
			const node = skillsRef.current
			if (node !== null && node !== undefined) node.value = names.join(', ')
			if (draft !== null) draft.profile.skills = names.slice()
			roleEditorState.skillsOpen = false
			bump()
		}
		/** One line: every variable the template may use, with its value for this task. */
		function tokenLine() {
			const tokens = preview !== null && Array.isArray(preview.tokens) ? preview.tokens : []
			if (tokens.length === 0) return t('rolePreviewMissing')
			return tokens.map(function (token) {
		const raw = token.value === undefined || token.value === null ? '' : String(token.value)
		return '{{' + String(token.name) + '}} → ' + (raw === '' ? t('rolePreviewEmptyValue') : raw)
			}).join(' · ')
		}
		/** Choose the task the injected preview is generated for ('' means auto). */
		function choosePreviewTask(id) {
			const next = typeof id === 'string' ? id : ''
			if (roleEditorState.previewTaskId === next) return
			roleEditorState.previewTaskId = next
			roleEditorState.preview = null
			roleEditorState.previewKey = null
			roleEditorState.previewPending = false
			roleEditorState.previewError = null
			bump()
		}
		/** A section's user-language label: own text, task data or host copy. */
		function sectionGroupLabel(group) {
			if (group === 'role') return t('roleSectionRole')
			if (group === 'template') return builtin ? t('rolePreviewGroupBuiltin') : t('roleAnchorPrompt')
			if (group === 'task') return t('rolePreviewGroupTask')
			if (group === 'skills') return t('roleSkills')
			if (group === 'rules') return t('roleRules')
			if (group === 'fixed') return t('roleAnchorBoundary')
			return t('roleSectionRole')
		}
		/** The right-hand source note of a section (host-fixed / auto-filled / …). */
		function sectionSourceLabel(group) {
			if (group === 'role') return t('roleSourceHostFixed')
			if (group === 'task') return t('roleSourceAuto')
			if (group === 'skills') return t('roleSourceHostInjected')
			if (group === 'rules') return t('roleSourceHostFixed')
			if (group === 'fixed') return t('roleSourceUnoverridable')
			return builtin ? t('roleSourceHostFixed') : t('roleSourceAuto')
		}
		/** Left column: the profile prompt as written, with its literal {{TOKEN}}s. */
		function rawColumn() {
			return h('div', { className: 'gbt-rolecardbody', 'data-role-prompt': 'raw', 'data-role-raw-readonly': 'false', 'data-role-raw-reason': '' },
		h('textarea', { key: 'template-field:' + controlKey, ref: templateRef, className: 'gbt-input gbt-editorarea', 'data-field': 'template', rows: 10, defaultValue: templateText, placeholder: t('rolePromptEmpty'), spellCheck: false }),
		h('p', { className: 'gbt-footnote', 'data-role-tokens': 'true' }, tokenLine()))
		}
		/**
		 * Left column for a built-in role: its READABLE default prompt, shown
		 * read-only and with literal {{TOKEN}}s (no substitution), plus the note
		 * that it cannot be edited in place and the existing Fork action that
		 * copies it into an editable draft.
		 */
		function builtinDefaultColumn() {
			const defaultPrompt = target !== null && typeof target.prompt === 'string' ? target.prompt : ''
			return h('div', { className: 'gbt-rolecardbody', 'data-role-prompt': 'raw', 'data-role-raw-readonly': 'true', 'data-role-raw-reason': 'builtin', 'data-role-empty-state': 'builtin', 'data-role-default-prompt': defaultPrompt === '' ? 'false' : 'true' },
		defaultPrompt === ''
			? h('div', { className: 'gbt-promptempty', 'data-role-raw-empty': 'builtin' }, h('p', { className: 'gbt-footnote' }, t('rolePreviewBuiltinReadonly')))
			: h('pre', { className: 'gbt-promptpre gbt-builtinprompt', 'data-role-default-prompt-text': 'true' }, defaultPrompt),
		h('div', { className: 'gbt-promptactions' },
			h('span', { className: 'gbt-footnote', 'data-role-builtin-note': 'true' }, t('roleEmptyBuiltinTitle'))))
		}
		/** Right column: the exact text the host injects, section by section. */
		function injectedColumn() {
			const previewTask = preview !== null && preview.task !== undefined && preview.task !== null ? preview.task : null
			const sample = previewTask !== null && previewTask.sample === true
			const taskValue = typeof roleEditorState.previewTaskId === 'string' ? roleEditorState.previewTaskId : ''
			const sections = preview !== null && Array.isArray(preview.sections) ? preview.sections : []
			return h('div', { className: 'gbt-rolecardbody', 'data-role-prompt': 'injected' },
		h('div', { className: 'gbt-prompthead' },
			h('div', { className: 'gbt-subhead' }, t('rolePreviewInjectedTitle')),
			h('div', { className: 'gbt-prompttaskrow', 'data-role-taskrow': 'true' },
				h('label', { className: 'gbt-editor-select' }, t('rolePreviewTaskPick'),
			h('select', { key: 'preview-task:' + controlKey, className: 'gbt-input', 'data-field': 'preview-task', 'data-task-id': taskValue, defaultValue: taskValue, onChange: function (event) { choosePreviewTask(event !== null && event !== undefined && event.target !== undefined ? event.target.value : '') } },
				h('option', { key: 'auto', value: '' }, t('rolePreviewTaskAuto')),
				previewTasks.map(function (task) {
					return h('option', { key: String(task.id), value: String(task.id) }, String(task.id) + ' · ' + String(task.title))
				}))),
				previewTask === null
			? null
			: h('span', { className: 'gbt-pill', 'data-role-task-source': sample ? 'sample' : 'real', 'data-task-id': String(previewTask.id) }, sample ? t('rolePreviewSampleTask') : String(previewTask.id) + ' · ' + String(previewTask.title)))),
		preview === null
			? h('div', { className: 'gbt-footnote', 'data-role-preview-state': roleEditorState.previewPending === true ? 'loading' : 'unavailable' },
			roleEditorState.previewError !== null && roleEditorState.previewError !== undefined && typeof roleEditorState.previewError.code === 'string'
				? t('rolePreviewFailed') + ' (' + roleEditorState.previewError.code + ')'
				: roleEditorState.previewPending === true
					? t('rolePreviewLoading')
					: t('rolePreviewMissing'))
			: h('div', { className: 'gbt-prompttext', 'data-role-preview-text': 'true' }, (function () {
			let lastGroup = null
			return sections.map(function (section, index) {
				const key = String(section.key === undefined || section.key === null ? index : section.key)
				const group = String(section.group === undefined || section.group === null ? 'fixed' : section.group)
				const firstOfGroup = group !== lastGroup
				lastGroup = group
				return h('div', { key: key + ':' + String(index), className: 'gbt-promptsection', 'data-role-section': key, 'data-role-section-group': group },
					firstOfGroup
				? h('div', { className: 'gbt-secthead', 'data-role-section-head': 'true' },
						h('span', { className: 'gbt-sectlabel', 'data-role-section-label': group }, sectionGroupLabel(group)),
						h('span', { className: 'gbt-sectsource', 'data-role-section-source': group }, sectionSourceLabel(group)))
				: null,
					h('pre', { className: 'gbt-promptpre' }, typeof section.text === 'string' ? section.text : ''))
			})
				})()))
		}
		// APPLICATION / 当前使用: picking a profile binds the stage and replaces its
		// running instances (the binding control, not the editor's profile picker).
		const currentUseSelect = h('label', { className: 'gbt-editor-select gbt-rolescurrent' }, t('roleCurrentUse'),
			h('select', {
				key: 'current-use:' + controlKey,
				className: 'gbt-input',
				'data-role-use-select': 'true',
				'data-field': 'current-use',
				'data-stage': stage,
				'data-bound': boundName === null ? '' : String(boundName),
				value: useValue,
				onChange: function (event) { void chooseUse(event !== null && event !== undefined && event.target !== undefined ? String(event.target.value) : '') },
			},
			useOptions.length === 0
				? h('option', { key: 'none', value: '' }, t('roleEditorNoProfile'))
				: useOptions.map(function (name) { return h('option', { key: name, value: name }, name === kind ? t('roleUseDefault') : name) })))
		// ── Stage rail (A direction): the ONLY stage navigation. The old top
		// stage strip and the roster column are gone; a custom copy is picked from the
		// rail's profile selector and blank creation lives in its footer.
		const currentSlot = STAGE_SLOTS.filter(function (slot) { return slot.kind === kind })[0] || STAGE_SLOTS[0]
		function liveCountOfKind(roleKind) {
			return allInstances.filter(function (entry) { return entry.kind === roleKind && entry.status !== 'failed' }).length
		}
		/** The stage default is shown by its own name, a custom copy by its name. */
		function profileLabelOf(slot, name) {
			if (name === null || name === undefined) return t('roleUseDefault')
			return String(name) === slot.kind ? t('roleUseDefault') : String(name)
		}
		function stageStateOf(slot) {
			if (slot.kind === kind) return draft !== null ? t('roleEditorDraft') : t('roleStageCurrent')
			return stageBoundProfile(slot.key) === null ? t('roleStageUnbound') : t('roleStageEnabled')
		}
		// The page header reports whether THIS profile is applied: a draft, the one
		// in use, or a copy that is not bound to its stage right now.
		const headApplied = draft !== null ? 'draft' : selectedName !== null && boundName !== null && String(selectedName) === String(boundName) ? 'enabled' : 'idle'
		const headAppliedLabel = headApplied === 'draft' ? t('roleEditorDraft') : headApplied === 'enabled' ? t('roleStageEnabled') : t('roleStageUnbound')
		// The profile picker: the stage default plus every custom copy that owns this
		// stage. Picking one edits it; binding stays in APPLICATION, exactly as before.
		const pickerValue = draft !== null ? String(draft.source) : selectedName === null ? String(kind) : String(selectedName)
		const profilePicker = h('select', {
			key: 'profile-picker:' + controlKey,
			className: 'gbt-stageselect',
			'data-role-profile-select': 'true',
			'data-field': 'profile',
			'data-stage': stage,
			'data-kind': kind,
			value: pickerValue,
			onChange: function (event) {
				const next = event !== null && event !== undefined && event.target !== undefined ? String(event.target.value) : ''
				selectProfile(next === '' ? kind : next, kind)
			},
		}, useOptions.map(function (name) {
			return h('option', { key: name, value: name }, name === kind ? t('roleUseDefault') : name)
		}))
		const stageRail = h('aside', { className: 'gbt-rolestagerail', 'data-role-stage-rail': 'true', 'data-role-nav': 'stages', 'aria-label': t('roleStagesTitle') },
			h('div', { className: 'gbt-stageprofile', 'data-role-profile-picker': 'true' },
				h('span', { className: 'gbt-deckeyebrow' }, t('roleProfileEyebrow')),
				profilePicker),
			h('div', { className: 'gbt-rail-title' },
				h('span', null, t('roleStagesTitle')),
				h('em', { className: 'gbt-mono' }, '0' + String(STAGE_SLOTS.length))),
			h('ol', { className: 'gbt-stagelist', 'data-role-stage-list': 'true' }, STAGE_SLOTS.map(function (slot) {
				const boundProfile = stageBoundProfile(slot.key)
				const bound = boundProfile !== null && profiles[boundProfile] !== undefined ? boundProfile : null
				const live = liveCountOfKind(slot.kind)
				const active = slot.kind === kind
				return h('li', { key: 'stage-' + slot.key, className: 'gbt-stageli' },
					h('button', {
						type: 'button',
						className: 'gbt-stagerow',
						'data-action': 'role-editor-kind',
						'data-kind': slot.kind,
						'data-stage-slot': slot.key,
						'data-roles-stage': slot.kind,
						// Kept so the existing screenshot steps can still click a stage by
						// the attribute they always used; the rail is the only stage nav.
						'data-roles-tab': slot.kind,
						'data-active': active ? 'true' : 'false',
						'data-bound-profile': bound === null ? '' : String(bound),
						'data-live': String(live),
						'data-ready': bound === null ? 'false' : 'true',
						'aria-current': active ? 'step' : undefined,
						onClick: function () { switchKind(slot.kind) },
					},
						h('span', { className: 'gbt-stagenum gbt-mono', 'aria-hidden': 'true' }, slot.num),
						h('span', { className: 'gbt-stagebody' },
							h('span', { className: 'gbt-stagetitle' }, h('b', null, t(slot.label)), h('code', { className: 'gbt-mono' }, slot.kind)),
							h('span', { className: 'gbt-stagedesc' }, t(slot.desc)),
							h('span', { className: 'gbt-stagemeta' },
								h('span', { className: 'gbt-stagetag', 'data-role-stage-state': slot.key }, stageStateOf(slot)),
								h('span', { className: 'gbt-stagesub gbt-mono', 'data-role-stage-bound': slot.key, title: bound === null ? '' : String(bound) }, '\u00B7 ' + profileLabelOf(slot, bound)))),
						h('span', { className: 'gbt-stageside' },
							h('i', { className: 'gbt-deckdot', 'data-on': bound === null ? 'false' : 'true' }),
							h('em', { className: 'gbt-stagelive gbt-mono', 'data-role-stage-live': slot.key }, String(live))))
				)
			})),
			h('p', { className: 'gbt-stagenote', 'data-role-stages-hint': 'true' }, t('roleStagesHint')),
			h('div', { className: 'gbt-stagecreatewrap' },
				h('details', { key: 'roster-create', className: 'gbt-stagecreate', 'data-section': 'role-create-blank', 'data-role-create-entry': 'true' },
					h('summary', { 'data-role-create-summary': 'true' }, '＋ ' + t('roleEditorCreateBlank')),
					h('div', { className: 'gbt-stagecreatebody', 'data-role-create-body': 'true' }, h(RoleCreateForm, { t: t, defaultRole: kind, onCreate: createBlank, onInvalid: createBlankInvalid })))))
		const head = h('div', { className: 'gbt-rolehead', 'data-role-head': 'true' },
			h('div', { className: 'gbt-roleheadmain' },
				h('span', { className: 'gbt-deckeyebrow', 'data-role-head-stage': currentSlot.key }, 'STAGE ' + currentSlot.num + ' · ' + String(stage).toUpperCase()),
				h('h2', { className: 'gbt-roleheadtitle', 'data-role-head-title': 'true' },
					selectedName === null ? '—' : String(selectedName),
					h('span', { className: 'gbt-roleheadstage' }, '/ ' + t(currentSlot.label)))),
			h('div', { className: 'gbt-roleheadmeta' },
				h('span', { className: 'gbt-pill', 'data-role-head-state': headApplied }, headAppliedLabel),
				h('span', { className: 'gbt-footnote', 'data-role-head-bound': 'true' }, t('roleCurrentUse') + ' · ' + (boundName === null ? '—' : profileLabelOf(currentSlot, boundName)))))
		// IDENTITY is read-only: the role name, its stage and the context the host
		// resolves. Editing happens in BEHAVIOR/APPLICATION below, and in the rail
		// for stage and profile selection.
		const identityRow = h('div', { className: 'gbt-roleidentity', 'data-editor-identity': 'true', 'data-kind': kind, 'data-profile': selectedName === null ? '' : String(selectedName), 'data-bound': boundName === null ? '' : String(boundName), 'data-draft': draft === null ? 'false' : 'true' },
			h('div', { className: 'gbt-identitygrid' },
				h('label', { className: 'gbt-identityfield' }, h('span', null, t('roleName'), h('em', { className: 'gbt-identityhint' }, t('roleReadonly'))),
					h('input', { className: 'gbt-input gbt-readonlyfield', readOnly: true, tabIndex: -1, 'data-field': 'identity-name', value: selectedName === null ? '—' : String(selectedName) })),
				h('label', { className: 'gbt-identityfield' }, h('span', null, t('roleStageField')),
					h('input', { className: 'gbt-input gbt-readonlyfield', readOnly: true, tabIndex: -1, 'data-field': 'identity-stage', value: t(currentSlot.label) + ' / ' + String(stage) })),
				h('label', { className: 'gbt-identityfield' }, h('span', null, t('roleContext')),
					h('input', { className: 'gbt-input gbt-readonlyfield', readOnly: true, tabIndex: -1, 'data-field': 'identity-context', value: target !== null && typeof target.context === 'string' ? target.context : 'fresh' }))))
		const skillsRow = h('div', { className: 'gbt-editorskills', 'data-section': 'role-editor-skills' },
			h('label', { className: 'gbt-editorskills-field' }, t('roleSkills'), h('input', { key: 'skills-field:' + controlKey, ref: skillsRef, className: 'gbt-input', 'data-field': 'skills', defaultValue: skillsText, spellCheck: false })),
			h('button', { type: 'button', className: 'gbt-btn', 'data-action': 'role-editor-skills-manage', onClick: function () { void openSkills() } }, t('roleEditorSkillsManage')))
		/** The blank-create form reports in the same banner as every other action. */
		async function createBlank(name, fields) {
			const outcome = await send('rolesCreate', { name: name, profile: fields })
			if (outcome.ok !== true) return
			// The entry is stage-scoped, but the form may have picked another kind:
			// land the editor on the created kind and bind that stage, never the old one.
			const createdKind = fields !== null && fields !== undefined && ['worker', 'reviewer', 'tester'].indexOf(fields.role) >= 0 ? fields.role : kind
			roleEditorState.kind = createdKind
			roleEditorState.selected = name
			roleEditorState.saved = { name: name, profile: Object.assign({ name: name }, fields) }
			bump()
			await applyProfile(name, createdKind)
		}
		function createBlankInvalid(code) {
			report('rolesCreate', false, { code: code, message: '' })
		}
		const runningNames = instances.filter(function (entry) { return entry.kind === kind }).map(function (entry) { return entry.name })
		const runningRow = h('div', { className: 'gbt-footnote', 'data-role-running': 'true' },
			t('roleRunningNow') + ': ' + (runningNames.length === 0 ? t('roleNoneRunning') : runningNames.join(', ')) + ' · ' + (boundName === kind ? t('roleFromDefault') : t('roleFromCopy')))
		const stateHint = draft !== null
			? h('div', { className: 'gbt-footnote', 'data-role-draft-hint': 'true' }, t('roleDraftHint'))
			: roleEditorState.applySkipped === true
				? h('div', { className: 'gbt-footnote', 'data-editor-apply-skipped': 'true' }, t('roleUsePendingNextDispatch'))
				: null
		const sectionHead = function (eyebrow, title, note) {
			return h('div', { className: 'gbt-rolesectionhead' }, h('span', { className: 'gbt-deckeyebrow' }, eyebrow), h('h3', null, title), note === undefined ? null : h('span', { className: 'gbt-footnote gbt-sectionnote' }, note))
		}
		const leftPane = h('section', { className: 'gbt-rolespane gbt-roleseditorpane', 'data-roles-pane': 'raw' },
			h('section', { className: 'gbt-rolesection', 'data-role-section': 'identity' }, sectionHead('IDENTITY / 身份', t('roleSectionRole'), draft !== null ? t('roleEditorDraft') : builtin ? t('roleBuiltin') : t('roleCustom')), identityRow),
			h('section', { className: 'gbt-rolesection', 'data-role-section': 'behavior' }, sectionHead('BEHAVIOR / 行为', t('roleAnchorPrompt')),
				h('div', { className: 'gbt-rolecard', 'data-role-card': 'raw' },
					editablePrompt ? rawColumn() : builtinDefaultColumn(),
					h('div', { className: 'gbt-rolefields', 'data-section': 'role-editor-fields' }, skillsRow))),
			h('section', { className: 'gbt-rolesection', 'data-role-section': 'application' }, sectionHead('APPLICATION / 应用', t('roleCurrentUse')), currentUseSelect, h('div', { className: 'gbt-footnote', 'data-role-apply-hint': 'true' }, t('roleApplyHint')), runningRow),
			)
		const rightPane = h('section', { className: 'gbt-rolespane gbt-rolespreviewpane', 'data-roles-pane': 'injected' },
			h('div', { className: 'gbt-rolespreviewhead' }, h('span', { className: 'gbt-deckeyebrow' }, 'PREVIEW / 注入预览')),
			h('div', { className: 'gbt-rolecard', 'data-role-card': 'injected' }, injectedColumn()),
			stateHint)
		const draftNameRow = draft === null ? null : h('label', { className: 'gbt-editorfield', 'data-section': 'role-draft-name' }, t('roleDraftName'),
			h('input', { key: 'draft-name:' + controlKey, className: 'gbt-input', 'data-field': 'draft-name', defaultValue: draft.name, spellCheck: false, onChange: function (event) {
				const next = event !== null && event !== undefined && event.target !== undefined ? String(event.target.value) : ''
				if (roleEditorState.draft !== null) roleEditorState.draft.name = next
			} }))
		const modal = roleEditorState.skillsOpen === true
			? h('div', { className: 'gbt-overlay', 'data-modal': 'role-skills' },
				h('div', { className: 'gbt-modal' },
					h('div', { className: 'gbt-modalhead' },
						h('h2', null, t('roleEditorSkillsTitle') + (selectedName === null ? '' : ' · ' + String(selectedName))),
						h('button', { type: 'button', className: 'gbt-iconbtn', 'data-action': 'role-skills-close', onClick: function () { roleEditorState.skillsOpen = false; bump() } }, '×')),
					roleEditorState.skillsError !== null
						? h('div', { className: 'gbt-banner', 'data-tone': 'error', 'data-skills-unavailable': String(roleEditorState.skillsError.code === undefined || roleEditorState.skillsError.code === null ? 'skills-unavailable' : roleEditorState.skillsError.code) }, t('roleErrSkillsUnavailable') + '（' + String(roleEditorState.skillsError.code === undefined || roleEditorState.skillsError.code === null ? 'skills-unavailable' : roleEditorState.skillsError.code) + '）' + (typeof roleEditorState.skillsError.message === 'string' && roleEditorState.skillsError.message !== '' ? ' · ' + roleEditorState.skillsError.message : ''))
						: null,
					roleEditorState.skillsError === null && catalog.length === 0 ? h('div', { className: 'gbt-empty' }, t('roleEditorSkillsEmpty')) : null,
					catalog.map(function (skill) {
						const name = String(skill.name)
						return h('label', { key: name, className: 'gbt-check gbt-skillrow', 'data-skill-row': name },
							h('input', { type: 'checkbox', 'data-skill': name, checked: roleEditorState.skillsSelected.has(name), onChange: function () { toggleSkill(name) } }),
							h('span', { className: 'gbt-mono' }, name),
							h('span', { className: 'gbt-footnote' }, ' ' + String(skill.description === undefined || skill.description === null ? '' : skill.description)),
							skill.invocation !== null && skill.invocation !== undefined && skill.invocation.modelInvocable === false
								? h('span', { className: 'gbt-pill', 'data-skill-user-only': name }, t('roleEditorSkillUserOnly'))
								: null)
					}),
					h('div', { className: 'gbt-formactions' }, h('button', { type: 'button', className: 'gbt-btn', 'data-variant': 'primary', 'data-action': 'role-skills-save', onClick: saveSkills }, t('roleEditorSkillsSave')))))
			: null
		const saveButton = h('button', { type: 'button', className: 'gbt-btn', 'data-variant': 'primary', 'data-action': 'role-editor-save', onClick: function () { void save() } }, t('roleSave'))
		const discardButton = h('button', { type: 'button', className: 'gbt-btn', 'data-action': 'role-editor-discard', onClick: discardDraft }, t('roleDiscard'))
		const forkButton = builtin
			? h('button', { type: 'button', className: 'gbt-btn', 'data-action': 'role-editor-fork', 'data-role-empty-fork': 'true', onClick: fork }, t('roleEmptyCopy'))
			: null
		const deleteButton = draft === null && editablePrompt && selectedName !== null && profiles[selectedName] !== undefined
			? h('button', { type: 'button', className: 'gbt-btn', 'data-action': 'rolesDelete', 'data-role-delete-copy': 'true', onClick: function () { void remove() } }, t('roleDeleteThis'))
			: null
		const actionBar = h('div', { className: 'gbt-rolesactions', 'data-roles-actions': 'true' },
			h('div', { className: 'gbt-rolesactions-left' },
				draft !== null ? discardButton : null,
				draft !== null || (editablePrompt && selectedName !== null) ? saveButton : null,
				draftNameRow),
			h('div', { className: 'gbt-rolesactions-right' }, forkButton, deleteButton))
		return h('div', { className: 'gbt-roleeditor', 'data-editor': 'true', 'data-role-deck': 'true', 'data-kind': kind, 'data-draft': draft === null ? 'false' : 'true' },
			h('div', { className: 'gbt-rolesworkspace', 'data-role-workspace': 'true' },
				stageRail,
				h('div', { className: 'gbt-rolesmain', 'data-role-editor-main': 'true' },
					head,
					h('div', { className: 'gbt-roleseditscroll', 'data-roles-scroll': 'true' },
						h('div', { className: 'gbt-rolespanes', 'data-roles-panes': 'true', 'data-role-layout': 'split' }, leftPane, rightPane)),
					actionBar)),
			roleEditorState.notice === null ? null : roleResultBanner(roleEditorState.notice, t),
			modal)
	}

	/**
	 * The Roles tab: ONE card, the context editor. Reloading the profiles is an
	 * explicit action in the card header, and the batch actions (replace kind /
	 * reset defaults) live next to the primary editor actions. The old
	 * stand-alone stages/profiles/previews/create cards are gone — this editor
	 * replaced them.
	 */

	return RolesEditor
}

module.exports = { createRolesEditor }

				})(module, module.exports)
				const factory = module.exports.createRolesEditor
				return factory({
					React: React,
					h: h,
					roleResultBanner: roleResultBanner,
					tableWrap: tableWrap,
					roleBoundProfile: roleBoundProfile,
					roleSelectableProfiles: roleSelectableProfiles,
					roleProfileCopy: roleProfileCopy,
					RoleCreateForm: RoleCreateForm,
					roleErrorText: roleErrorText,
					roleKindLabel: roleKindLabel,
					tcSplitList: tcSplitList,
					roleEditorState: roleEditorState,
					ROLE_EDITOR_KINDS: ROLE_EDITOR_KINDS,
					ROLE_EDITOR_STAGES: ROLE_EDITOR_STAGES,
					copyToClipboard: copyToClipboard,
				})
			})()

			const RolesView = (function () {
				const module = { exports: {} }
				;(function (module, exports) {
/**
 * Roles view module.
 *
 * Extracted from the roles fragment; React, h, the agent-tree selector and
 * RolesEditor are injected by the build. Stage profiles are project-level: there
 * is no per-session team readiness to aggregate here.
 *
 * A direction: this view owns no header of its own. The editor renders the one
 * page header (stage + profile) and the stage rail; adding a second title card
 * here would put a second navigation/heading layer above it.
 */
function createRolesView(deps) {
	const React = deps.React
	const h = deps.h
	const RolesEditor = deps.RolesEditor
	const tcAgentTreeOf = deps.tcAgentTreeOf

	function RolesView(props) {
		const t = props.t
		const snapshot = props.snapshot
		const store = props.store
		const [, bumpEditor] = React.useReducer(function (count) { return count + 1 }, 0)
		const config = snapshot.roles === undefined || snapshot.roles === null ? null : snapshot.roles
		// Live instances are the tree members whose role is one of the three stage
		// profiles. A member with no stage role (the root, a custom kind) is not a
		// role instance and is not counted here.
		const tree = tcAgentTreeOf(snapshot)
		const instances = tree.members
			.filter(function (member) {
				return member !== null && typeof member === 'object' && ['worker', 'reviewer', 'tester'].indexOf(member.role) >= 0
			})
			.map(function (member) {
				return {
					name: typeof member.name === 'string' && member.name !== '' ? member.name : typeof member.id === 'string' ? member.id : '—',
					kind: member.role,
					status: typeof member.status === 'string' ? member.status : 'unknown',
				}
			})
		if (config === null) {
			return h('div', { className: 'gbt-rolesview', 'data-roles-deck': 'true' },
				h('div', { className: 'gbt-rolesview-empty', 'data-roles-unavailable': 'true' },
					h('p', { className: 'gbt-footnote' }, t('rolesHint')),
					h('div', { className: 'gbt-empty' }, t('rolesUnavailable'))))
		}
		return h('div', { className: 'gbt-rolesview', 'data-roles-deck': 'true' },
			h(RolesEditor, {
				t: t,
				snapshot: snapshot,
				store: store,
				instances: instances,
				bump: bumpEditor,
			}))
	}

	return RolesView
}

module.exports = { createRolesView }

				})(module, module.exports)
				const factory = module.exports.createRolesView
				return factory({ React: React, h: h, RolesEditor: RolesEditor, tcAgentTreeOf: tcAgentTreeOf })
			})()

			/** Status page UI state that must survive a re-mount (view switch, polling). */
			const statusUiState = { showAll: false, session: null, copied: null }

			/** T-143: worktree cleanup survives a view switch / poll (module store). */
			const worktreeCleanupUi = { probe: null, probeState: 'idle', probedSignature: null, preflight: null, pending: false, executing: false, result: null, forceConfirm: null, selected: {} }
			const StatusView = (function () {
				const module = { exports: {} }
				;(function (module, exports) {
/**
 * Status view module.
 *
 * Extracted from the status fragment; React, h, the status/worktree UI state,
 * shared labels and the merge/activity helpers are injected by the build.
 */
function createStatusView(deps) {
	// T-155: the session filter survives a remount (view switch) like the other
	// panel UI state.
	const statusUi = { sessionFilter: 'all' }

	const React = deps.React
	const h = deps.h
	const statusUiState = deps.statusUiState
	const worktreeCleanupUi = deps.worktreeCleanupUi
	const actorDisplay = deps.actorDisplay
	const mergeActorOf = deps.mergeActorOf
	const roleKindLabel = deps.roleKindLabel
	const testSummaryText = deps.testSummaryText
	const tcAgentTreeOf = deps.tcAgentTreeOf
	const tcAgentStatusKey = deps.tcAgentStatusKey
	const tcAgo = deps.tcAgo
	const tcMergeOf = deps.tcMergeOf
	const tcSessionIdInfo = deps.tcSessionIdInfo
	const tcStageQueued = deps.tcStageQueued
	const copyToClipboard = deps.copyToClipboard

	function StatusView(props) {
		const t = props.t
		const snapshot = props.snapshot
		const now = props.now
		const store = props.store
		// Mirrored into a module store so a re-mount (view switch, polling) keeps
		// the toggle/menu state; the React state still drives the live render.
		const [showAllActivity, setShowAllActivity] = React.useState(statusUiState.showAll === true)
		const [openSession, setOpenSession] = React.useState(statusUiState.session)
		const [copied, setCopied] = React.useState(statusUiState.copied)
		// T-143: bump to re-render the worktree cleanup panel (state lives in the module store).
		const [, setCleanupTick] = React.useState(0)
		const dispatch = snapshot.dispatch === undefined || snapshot.dispatch === null ? { state: 'paused' } : snapshot.dispatch
		const active = dispatch.state === 'running'
		const counts = snapshot.counts === undefined || snapshot.counts === null ? {} : snapshot.counts
		const archivedCount = Number.isFinite(snapshot.archivedCount) ? snapshot.archivedCount : 0
		const archiveRange = snapshot.archiveRange === undefined ? null : snapshot.archiveRange
		// How full the board FILE is: the status page warns at 50%/75% of the cap
		// long before the board would refuse to load at all.
		const boardSize = snapshot.boardSize === undefined || snapshot.boardSize === null ? null : snapshot.boardSize
		const boardSizeWarn = boardSize !== null && (boardSize.level === 'half' || boardSize.level === 'three-quarters')
		const tasks = Array.isArray(snapshot.tasks) ? snapshot.tasks : []
		// T-154: the merge queue is the MERGER's real reading (active/queued/last).
		// snapshot.queue is the DISPATCH queue (ready cards) and must never be shown
		// as merges; a host without a merger answers null, and that is not zero.
		const mergeQueue = snapshot.mergeQueue !== null && snapshot.mergeQueue !== undefined && typeof snapshot.mergeQueue === 'object' ? snapshot.mergeQueue : null
		const mergeQueued = mergeQueue !== null && Number.isFinite(mergeQueue.queued) ? mergeQueue.queued : null
		const mergeActive = mergeQueue !== null && Number.isFinite(mergeQueue.active) ? mergeQueue.active : null
		const scheduler = snapshot.scheduler === undefined || snapshot.scheduler === null ? null : snapshot.scheduler
		const running = tasks.filter(function (task) { return task.status === 'running' })
		const maxConcurrent = dispatch.maxConcurrent === undefined || dispatch.maxConcurrent === null ? 3 : dispatch.maxConcurrent
		const ready = counts.ready === undefined || counts.ready === null ? 0 : counts.ready
		const blocked = counts.blocked || 0
		const worktrees = snapshot.worktrees
		const activity = snapshot.activity
		// T-111: the sweep is telemetry, not an event.
		const lastSweep = snapshot.lastSweep !== null && snapshot.lastSweep !== undefined && typeof snapshot.lastSweep.at === 'string' ? snapshot.lastSweep : null
		const entries = activity !== null && activity !== undefined && Array.isArray(activity.entries) ? activity.entries : []
		// v3: the live execution tree is the only membership source. One resolver is
		// shared with the detail page: the tool writes @labels, the panel resolves
		// them against the root Agent plus its live children (unresolved ids stay
		// verbatim).
		const agentTree = tcAgentTreeOf(snapshot)
		const roster = []
		if (agentTree.root !== null) roster.push({ id: agentTree.root.id, name: agentTree.root.name, kind: agentTree.root.role })
		agentTree.members.forEach(function (member) { roster.push({ id: member.id, name: member.name, kind: member.role }) })
		function memberName(value, byName, fallbackKey) {
			return actorDisplay(value, byName, roster, t, fallbackKey)
		}
		// T-169: pauseSource is the audit vocabulary (user/preflight/scheduler/worktree);
		// legacy/null pause records must still render as a safe "unknown/legacy" label.
		function pauseSourceLabelOf(value) {
			if (value === 'user') return t('pauseSourceUser')
			if (value === 'preflight') return t('pauseSourcePreflight')
			if (value === 'scheduler') return t('pauseSourceScheduler')
			if (value === 'worktree') return t('pauseSourceWorktree')
			return t('pauseSourceLegacy')
		}
		function whyNotRunning() {
			if (active !== true) {
		const since = typeof dispatch.since === 'string' ? dispatch.since : null
		const by = typeof dispatch.by === 'string' && dispatch.by !== '' ? memberName(dispatch.by) : null
		// T-169: when the audit source is known, the dedicated source line names it
		// readably; do not echo the raw internal token (preflight/scheduler) here.
		const knownPauseSource = typeof dispatch.pauseSource === 'string' && ['user', 'preflight', 'scheduler', 'worktree', 'legacy'].indexOf(dispatch.pauseSource) >= 0
		const who = knownPauseSource ? null : by === null ? null : by
		if (since === null) return t('statusWhyPaused') + (who === null ? '' : '（' + t('statusPausedBy').replace('{by}', who) + '）')
		const clock = new Date(since).toTimeString().slice(0, 5)
		return t('statusWhyPaused') + '（' + clock + (who === null ? '' : ' ' + t('statusPausedBy').replace('{by}', who)) + '）'
			}
			if (ready === 0) return t('statusWhyNoReady')
			if (running.length >= maxConcurrent) return t('statusWhyFull')
			if (blocked > 0) return t('statusWhyBlocked').replace('{n}', String(blocked))
			return t('statusWhyRunning')
		}


		// ── the activity stream: the Host's board-derived timeline (T-111) ──
		// The Host derives these from each card's history + merge record, so they
		// survive a restart and a 5-second heartbeat cannot flush them. The panel
		// only formats them (time · event · object).
		function shortSha(value) {
			return typeof value === 'string' && value !== '' ? value.slice(0, 7) : ''
		}
		/**
		 * T-111: what one board transition MEANS — the same note-aware rule the
		 * Host applies. from/to alone fabricated a review-pass for every
		 * candidate build and a test-pass for every merge.
		 */
		function historyMeaning(from, to, note) {
			if (/^(?:merge request )?merged\b/.test(note)) return { kind: 'merge' }
			if (to === 'pending') {
		if (from === null) return { kind: 'create' }
		if (from === 'running' || from === 'blocked' || from === 'cancelled' || from === 'done') return { kind: 'retry' }
		return null
			}
			if (to === 'running') {
		if (from === 'reviewing') return { kind: 'review-reject' }
		if (from === 'testing') return { kind: 'test-fail' }
		if (from === 'pending' || from === null) return { kind: 'dispatch' }
		return null
			}
			if (to === 'reviewing') return from === 'reviewing' ? null : { kind: 'submit' }
			if (to === 'testing') {
		if (from === 'reviewing') return { kind: 'review-pass' }
		if (from === 'testing') return /^tests passed/.test(note) ? { kind: 'test-pass' } : null
		return null
			}
			if (to === 'blocked') return { kind: 'blocked' }
			if (to === 'cancelled') return { kind: 'cancel' }
			return null
		}
		const stream = []
		const derivedEvents =
			snapshot.activityEvents !== null && snapshot.activityEvents !== undefined && Array.isArray(snapshot.activityEvents.entries)
		? snapshot.activityEvents.entries
		: []
		if (snapshot.activityEvents !== null && snapshot.activityEvents !== undefined) {
		derivedEvents.forEach(function (event) {
			if (event === null || typeof event !== 'object' || typeof event.at !== 'string') return
			const task = tasks.filter(function (entry) { return String(entry.id) === String(event.taskId) })[0]
			if (task === undefined) return
			const assignee =
		typeof event.byName === 'string' && event.byName !== ''
			? memberName(event.by, event.byName)
			: task.assignee !== null && task.assignee !== undefined && typeof task.assignee.name === 'string'
				? memberName(task.assignee.name)
				: null
			const note = typeof event.detail === 'string' && event.detail !== '' ? event.detail : null
			const isMerge = event.kind === 'merge' || event.kind === 'merge-rejected'
			const mergeTarget = isMerge && typeof event.target === 'string' && event.target !== '' ? event.target : '—'
			const mergeSha = isMerge && typeof event.sha === 'string' && event.sha !== '' ? shortSha(event.sha) : ''
			const html = isMerge
		? task.id + ' · ' + task.title + ' → ' + mergeTarget + (mergeSha === '' ? '' : ' · ' + mergeSha)
		: eventText(
				event.kind,
				task,
				assignee,
				task.review === undefined ? null : task.review,
				task.test === undefined ? null : task.test,
				{ at: event.at, by: event.by, byName: event.byName },
				note,
				Number.isFinite(event.eventRound) ? event.eventRound : 0,
				typeof event.sha === 'string' ? event.sha : '',
			)
			stream.push({ key: 'evt-' + event.key, at: event.at, type: event.kind, taskId: task.id, html: html, raw: note })
		})
		} else {
			// Legacy Host (no derived timeline yet): fall back to the card's own history.
			tasks.forEach(function (task) {
		const hist = Array.isArray(task.history) ? task.history.slice().sort(function (left, right) { return new Date(left.at).getTime() - new Date(right.at).getTime() }) : []
		const merge = tcMergeOf(task)
		const mergeAt = merge !== null && typeof merge.at === 'string' ? merge.at : null
		let reviewRound = 0
		hist.forEach(function (entry) {
			const to = typeof entry.to === 'string' ? entry.to : ''
			const from = typeof entry.from === 'string' ? entry.from : null
			const assignee = task.assignee !== null && task.assignee !== undefined && typeof task.assignee.name === 'string' ? memberName(task.assignee.name) : null
			const note = typeof entry.note === 'string' && entry.note !== '' ? entry.note : null
			const meaning = historyMeaning(from, to, note === null ? '' : note)
			if (meaning === null) return
			const type = meaning.kind
			// A return to review opens a round: the first approval is round 1.
			if (type === 'submit') reviewRound += 1
			// The merge record is the richer row for this same merge.
			if (type === 'merge' && mergeAt !== null && entry.at === mergeAt) return
			const noteSha = (function () {
				const match = /@([0-9a-fA-F]{7,40})/.exec(note === null ? '' : note)
				return match === null ? '' : match[1].slice(0, 7)
			})()
			stream.push({
				key: 'hist-' + task.id + '-' + String(entry.at) + '-' + type,
				at: entry.at,
				type: type,
				taskId: task.id,
				html: eventText(type, task, assignee, task.review === undefined ? null : task.review, task.test === undefined ? null : task.test, entry, note, reviewRound, noteSha),
				raw: note,
			})
		})
		if (merge !== null && mergeAt !== null) {
			const commit = typeof merge.mergeCommit === 'string' && merge.mergeCommit !== '' ? shortSha(merge.mergeCommit) : ''
			const mergeActor = mergeActorOf(task)
			stream.push({
				key: 'merge-' + task.id,
				at: merge.at,
				type: 'merge',
				taskId: task.id,
				html: task.id + ' · ' + task.title + ' → ' + (typeof merge.target === 'string' ? merge.target : '—') + (commit === '' ? '' : ' · ' + commit) + (mergeActor === null ? '' : ' · ' + memberName(mergeActor.by, mergeActor.byName, 'statusActorHost')),
				raw: typeof merge.output === 'string' ? merge.output.split('\n')[0] : null,
			})
		}
			})
		}
		// Host-only events that never appear as a status transition.
		entries.forEach(function (entry, index) {
			const kind = String(entry.kind === undefined || entry.kind === null ? '' : entry.kind)
			if (kind === 'sweep' || kind === 'worktree-create' || kind === 'worktree-remove') return
			if (kind === 'review-end' || kind === 'test-end' || kind === 'review-start' || kind === 'test-start' || kind === 'merge' || kind === 'role-config' || kind === 'role-provision' || kind === 'role-replace') return
			if (kind !== 'host-check' && kind !== 'error' && kind !== 'host-action-timeout') return
			if (typeof entry.taskId === 'string' && stream.some(function (event) { return event.taskId === entry.taskId && event.type === 'test-fail' })) return
			stream.push({
		key: 'sys-' + String(index),
		at: entry.at,
		type: kind === 'host-check' ? 'host-check' : 'blocked',
		taskId: typeof entry.taskId === 'string' ? entry.taskId : '',
		html: (typeof entry.taskId === 'string' && entry.taskId !== '' ? entry.taskId + ' · ' : '') + t(kind === 'host-check' ? 'evtHostCheck' : 'evtError'),
		raw: typeof entry.detail === 'string' ? entry.detail : null,
			})
		})
		stream.sort(function (left, right) { return new Date(right.at).getTime() - new Date(left.at).getTime() })
		const recentStream = stream.slice(0, 30)
		// The header reads the SAME event stream as the activity card (never the
		// raw host ring alone); a heartbeat-only board says so instead of going blank.
		const newestEventAt = recentStream.length === 0 ? null : recentStream[0].at
		const newestEntryAt = entries.length === 0 ? null : entries[0].at
		let newestAt = newestEventAt
		if (newestEntryAt !== null && (newestAt === null || new Date(newestEntryAt).getTime() > new Date(newestAt).getTime())) newestAt = newestEntryAt
		const lastActivityText = newestAt !== null
			? t('statusLastActivity') + ' ' + tcAgo(newestAt, now)
			: lastSweep !== null ? t('statusLastActivity') + ' ' + tcAgo(lastSweep.at, now) + ' · ' + t('statusOnlyHeartbeats') : null
		function reviewWho(entry, review) {
			const fromEvent = entry !== null && entry !== undefined && typeof entry.by === 'string' && entry.by !== ''
			const value = fromEvent ? entry.by : review === null ? null : review.by
			const name = fromEvent ? entry.byName : review === null ? null : review.byName
			return value === null || value === undefined ? '' : ' · ' + memberName(value, name, 'actorRoleReviewer')
		}
		function eventText(type, task, assignee, review, test, entry, note, eventRound, noteSha) {
			// The row already renders the kind as a chip, so the description starts
			// with the subject and never repeats the verb.
			const subject = task.id + ' · ' + task.title
			if (type === 'create') return subject
			if (type === 'retry') return task.id
			if (type === 'dispatch') return task.id + (assignee === null ? '' : ' → ' + assignee)
			if (type === 'submit') return task.id + (noteSha === '' && shortSha(task.commit) === '' ? '' : ' · ' + (noteSha === '' ? shortSha(task.commit) : noteSha)) + ' · ' + t('detailFilesDeclared').replace('{n}', String(Array.isArray(task.writeFiles) ? task.writeFiles.length : 0))
			if (type === 'review-pass') return subject + ' · ' + t('evtOutcomePass') + reviewWho(entry, review) + ' · ' + t('detailRound').replace('{n}', String(eventRound))
			if (type === 'review-reject') return subject + ' · ' + t('evtOutcomeReject') + reviewWho(entry, review) + ' · ' + t('detailRound').replace('{n}', String(eventRound))
			if (type === 'test-pass') return task.id + ' · ' + (test === null ? '' : memberName(test.by, test.byName, 'actorRoleTester') + ' · ') + testSummaryText(test, review, t, 'passed')
			if (type === 'test-fail') return task.id + ' · ' + (test === null ? '' : memberName(test.by, test.byName, 'actorRoleTester') + ' · ') + testSummaryText(test, review, t, 'failed')
			if (type === 'blocked') return task.id
			if (type === 'cancel') return task.id
			return task.id
		}
		/**
		 * One row of the live tree. The Host reports a member's role, status and the
		 * task it is running; nothing is inferred from a roster slot. The root Agent
		 * has no status/task fields, so those cells read '—' instead of a guess.
		 */
		function agentRow(member, isRoot, index) {
			const name = typeof member.name === 'string' && member.name !== '' ? member.name : typeof member.id === 'string' ? member.id : String(index)
			const session = typeof member.id === 'string' && member.id !== '' ? member.id : ''
			const status = typeof member.status === 'string' && member.status !== '' ? member.status : null
			const taskId = typeof member.taskId === 'string' && member.taskId !== '' ? member.taskId : null
			const role = isRoot === true ? null : typeof member.role === 'string' && member.role !== '' ? member.role : null
			const roleText = isRoot === true ? t('agentRootRole') : role === null ? '—' : roleKindLabel(role, t)
			const statusText = status === null ? '—' : t(tcAgentStatusKey(status))
			const expanded = openSession === name
			const runningNow = isRoot === true || status === 'running'
			return h(
		'div',
		{ key: 'agent-' + name, className: 'gbt-deckperson', 'data-status-agent': name, 'data-status-agent-id': session, 'data-status-agent-role': isRoot === true ? 'root' : role === null ? '' : role, 'data-status-agent-status': status === null ? '' : status, 'data-status-agent-task': taskId === null ? '' : taskId, 'data-tone': runningNow ? 'live' : 'idle' },
		h('span', { className: 'gbt-deckdot', 'data-running': runningNow ? 'true' : 'false' }),
		h('div', { className: 'gbt-deckpersonmain' },
			h('b', { className: 'gbt-mono', title: name }, name),
			h('span', null, roleText + ' · ' + statusText),
		),
		h('div', { className: 'gbt-deckpersonmeta' },
			h('em', { className: 'gbt-mono', title: taskId === null ? '' : taskId }, taskId === null ? '—' : taskId),
			h('button', { type: 'button', className: 'gbt-statusmore', 'data-action': 'status-session', 'data-agent': name, 'aria-expanded': expanded ? 'true' : 'false', onClick: function () { const next = expanded ? null : name; statusUiState.session = next; setOpenSession(next) } }, '⋯'),
		),
		expanded
			? h(
			'div',
			{ className: 'gbt-decksession', 'data-status-session': name },
			h('span', { className: 'gbt-footnote' }, t('statusSession')),
			h('code', { className: 'gbt-mono' }, session === '' ? '—' : session),
			session === ''
				? null
				: h('button', { type: 'button', className: 'gbt-btn', 'data-action': 'copy-session', 'data-session': session, onClick: function () { void copyToClipboard(session).then(function (okopy) { const next = okopy === true ? session : 'failed'; statusUiState.copied = next; setCopied(next) }) } }, copied === session ? t('sessionCopied') : t('copySession')),
			)
			: null,
			)
		}
		// T-99: which session this panel speaks as, and where that identity came
		// from. The row is the visible half of the session story: "host" means the
		// panel follows the session with no parameter, "window" is the fallback.
		const panelSession = tcSessionIdInfo()
		const panelSessionLine = h(
			'div',
			{ className: 'gbt-statusscan', 'data-panel-session': panelSession.id, 'data-session-source': panelSession.source },
			t('panelSession') + ' ',
			h('code', { className: 'gbt-mono' }, panelSession.id),
			' · ',
			h('span', null, panelSession.source === 'host' ? t('sessionSourceHost') : panelSession.source === 'url' ? t('sessionSourceUrl') : t('sessionSourceWindow')),
		)
		const pauseSourceValue = typeof dispatch.pauseSource === 'string' && dispatch.pauseSource !== '' ? dispatch.pauseSource : 'unknown'
		const pauseReason = typeof dispatch.pauseReason === 'string' && dispatch.pauseReason.trim() !== '' ? dispatch.pauseReason : null
		const pauseAuditLine = active === true
			? null
			: h(
				'div',
				{ className: 'gbt-statuswhy gbt-pauseaudit', 'data-status-pause': 'true', 'data-pause-source': pauseSourceValue },
				h('span', null, t('statusPauseSourceLabel') + '：' + pauseSourceLabelOf(pauseSourceValue)),
				pauseReason === null ? null : h('span', { 'data-pause-reason': 'true' }, ' · ' + t('statusPauseReasonLabel') + '：' + pauseReason),
			)
		function deckMetric(key, value, label) {
			return h('div', { className: 'gbt-deckmetric', 'data-kv': key }, h('b', null, String(value)), h('span', null, label))
		}
		function deckPanelHead(eyebrow, title, meta) {
			return h('div', { className: 'gbt-deckpanelhead' }, h('span', { className: 'gbt-deckeyebrow' }, eyebrow), h('h2', null, title), meta === null || meta === undefined ? null : h('span', { className: 'gbt-deckpanelmeta' }, meta))
		}
		const scanAgo = scheduler !== null && scheduler.lastTickAt !== null && scheduler.lastTickAt !== undefined ? tcAgo(scheduler.lastTickAt, now) : '—'
		const dispatchCard = h(
			'section',
			{ className: 'gbt-statuscard gbt-deckdispatch', 'data-status-card': 'dispatch' },
			h('div', { className: 'gbt-decklabel' }, h('span', null, 'DISPATCH'), h('span', { className: 'gbt-decklabelzh' }, t('statusCardDispatch')), h('em', { 'data-running': active ? 'true' : 'false' }, active ? t('running') : t('paused'))),
			h('div', { className: 'gbt-deckbig' }, String(running.length), h('small', null, ' / ' + String(maxConcurrent))),
			h('div', { className: 'gbt-deckbar' }, Array.from({ length: Math.max(1, Number(maxConcurrent) || 1) }, function (_, index) { return h('i', { key: 'bar-' + String(index), 'data-on': index < running.length ? 'true' : 'false' }) })),
			h('p', { className: 'gbt-decknote', 'data-status-why': 'true' }, whyNotRunning()),
			pauseAuditLine,
			h('div', { className: 'gbt-deckmetrics' },
				h('div', { className: 'gbt-deckmetric', 'data-kv': 'concurrent' }, h('b', null, String(running.length) + ' / ' + String(maxConcurrent)), h('span', null, t('statusConcurrent'))),
				h('div', { className: 'gbt-deckmetric', 'data-kv': 'ready' }, h('b', null, String(ready)), h('span', null, t('statusReady'))),
				h('div', { className: 'gbt-deckmetric', 'data-kv': 'merge-queue', 'data-merge-queue': mergeQueued === null ? 'unavailable' : 'ready', title: mergeActive === null ? '' : String(mergeActive) }, h('b', null, mergeQueued === null ? '—' : String(mergeQueued)), h('span', null, t('statusMergeQueue'))),
				h('div', { className: 'gbt-deckmetric', 'data-kv': 'tasks' }, h('b', null, String(tasks.length)), h('span', null, t('statusTasks'))),
				h('div', { className: 'gbt-deckmetric', 'data-kv': 'last-scan', 'data-status-scan': 'true' }, h('b', null, scanAgo), h('span', null, t('statusLastScan'))),
				Number.isFinite(counts.investigating) && counts.investigating > 0 ? h('div', { className: 'gbt-deckmetric', 'data-kv': 'investigating', 'data-kind': 'investigate' }, h('b', null, String(counts.investigating)), h('span', null, t('statusInvestigating'))) : null,
			),
			panelSessionLine,
			archivedCount > 0
				? h('div', { className: 'gbt-deckscanline', 'data-status-archive': 'true' }, t('archiveLine').replace('{n}', String(archivedCount)).replace('{range}', archiveRange === null ? '—' : String(archiveRange.from).slice(0, 10) + ' → ' + String(archiveRange.to).slice(0, 10)), ' ', h('button', { type: 'button', className: 'gbt-linkbtn', 'data-action': 'archive-open', onClick: function () { if (props.onOpenArchive !== undefined) props.onOpenArchive() } }, t('archiveOpen')))
				: null,
			boardSizeWarn
				? h('div', { className: 'gbt-deckscanline', 'data-status-board-size': boardSize.level, 'data-board-bytes': String(boardSize.bytes), title: boardSize.warning === null ? '' : String(boardSize.warning) }, t('statusBoardSize').replace('{mb}', String(Math.round((boardSize.bytes / (1024 * 1024)) * 10) / 10)).replace('{limit}', String(Math.round(boardSize.limit / (1024 * 1024)))).replace('{percent}', String(boardSize.percent)).replace('{n}', boardSize.headroomCards === null ? '—' : String(boardSize.headroomCards)))
				: null,
		)
				const wtList = worktrees !== null && worktrees !== undefined && worktrees.available === true && Array.isArray(worktrees.worktrees) ? worktrees.worktrees : []
		const mainWt = wtList.filter(function (entry) { return entry.type === 'main' })[0]
		const activeWts = wtList.filter(function (entry) { return entry !== mainWt && entry.active === true })
		const staleWts = wtList.filter(function (entry) { return entry !== mainWt && entry.active !== true })
		const wtBaseOf = function (path) {
			const parts = String(path === undefined || path === null ? '' : path).split(/[\\/]/).filter(function (part) { return part !== '' })
			return parts.length === 0 ? String(path) : parts[parts.length - 1]
		}
		const wtTypeLabel = function (type) {
			const key = type === 'main' ? 'statusWtMain' : type === 'verify' ? 'statusWtVerify' : type === 'merge' ? 'statusWtMerge' : type === 'test' ? 'statusWtTest' : type === 'task' ? 'statusWtTask' : 'statusWtOther'
			return t(key)
		}
		const wtLabelOf = function (entry) { return typeof entry.taskId === 'string' && entry.taskId !== '' ? entry.taskId : wtBaseOf(entry.path) }
		const cleanupUi = worktreeCleanupUi
		const wtBump = function () { setCleanupTick(function (count) { return count + 1 }) }
		const worktreeSignature = wtList.map(function (entry) {
			return String(entry.path) + ':' + (entry.active === true ? 'a' : '-')
		}).join('|')
		const wtApplyPreflight = function (outcome) {
			const payload = outcome !== null && outcome !== undefined && outcome.ok === true && outcome.payload !== null && outcome.payload !== undefined ? outcome.payload : null
			cleanupUi.pending = false
			if (payload !== null && payload.ok === true) {
		cleanupUi.preflight = payload
		const selected = {}
		const candidates = Array.isArray(payload.candidates) ? payload.candidates : []
		candidates.forEach(function (candidate) { if (candidate.wouldRemove === true) selected[candidate.path] = true })
		cleanupUi.selected = selected
			} else {
		cleanupUi.preflight = null
		cleanupUi.result = { ok: false, code: payload !== null && typeof payload.code === 'string' ? payload.code : 'worktrees-cleanup-failed' }
			}
			wtBump()
		}
		const wtRunPreflight = function () {
			if (cleanupUi.pending === true) return
			cleanupUi.pending = true
			cleanupUi.result = null
			wtBump()
			void store.send('worktreesCleanup', { dryRun: true }, { quiet: true }).then(wtApplyPreflight)
		}
		// T-146: /state only carries the inventory. Probe the stale checkouts
		// lazily (never an automatic cleanup dry run) when the card is shown.
		React.useEffect(function () {
			if (worktreeSignature === '') return
			if (worktreeCleanupUi.probeState === 'loading') return
			if (worktreeCleanupUi.probedSignature === worktreeSignature) return
			worktreeCleanupUi.probedSignature = worktreeSignature
			worktreeCleanupUi.probeState = 'loading'
			wtBump()
			const paths = staleWts.map(function (entry) { return entry.path })
			void store.loadWorktrees(paths).then(function (payload) {
		if (payload !== null && payload !== undefined && payload.ok === true) {
			worktreeCleanupUi.probe = payload
			worktreeCleanupUi.probeState = 'ready'
		} else {
			worktreeCleanupUi.probe = null
			worktreeCleanupUi.probeState = 'error'
		}
		wtBump()
			})
		}, [worktreeSignature])
		const wtExecute = function (paths, force) {
			if (cleanupUi.executing === true || Array.isArray(paths) === false || paths.length === 0) return
			const body = { dryRun: false, paths: paths }
			if (force === true) body.force = true
			cleanupUi.executing = true
			cleanupUi.result = null
			cleanupUi.forceConfirm = null
			wtBump()
			void store.send('worktreesCleanup', body, { quiet: true }).then(function (outcome) {
		cleanupUi.executing = false
		const payload = outcome !== null && outcome !== undefined && outcome.ok === true && outcome.payload !== null && outcome.payload !== undefined ? outcome.payload : null
		if (payload !== null && payload.ok === true) {
			cleanupUi.result = payload
			cleanupUi.preflight = null
			cleanupUi.selected = {}
			cleanupUi.probe = null
			cleanupUi.probeState = 'idle'
			cleanupUi.probedSignature = null
			void store.load()
		} else {
			cleanupUi.result = { ok: false, code: payload !== null && typeof payload.code === 'string' ? payload.code : 'worktrees-cleanup-failed' }
		}
		wtBump()
			})
		}
		const preflightCandidates = cleanupUi.preflight !== null && Array.isArray(cleanupUi.preflight.candidates) ? cleanupUi.preflight.candidates : []
		const candidateByPath = {}
		preflightCandidates.forEach(function (candidate) { if (typeof candidate.path === 'string') candidateByPath[candidate.path] = candidate })
		const probeEntries = cleanupUi.probe !== null && Array.isArray(cleanupUi.probe.worktrees) ? cleanupUi.probe.worktrees : []
		const probeByPath = {}
		probeEntries.forEach(function (entry) { if (entry !== null && typeof entry === 'object' && typeof entry.path === 'string') probeByPath[entry.path] = entry })
		const wtEffective = function (entry) { const probed = probeByPath[entry.path]; return probed === undefined ? entry : Object.assign({}, entry, probed) }
		const effectiveStale = staleWts.map(wtEffective)
		const safeCount = effectiveStale.filter(function (entry) { return entry.probed === true && entry.safe === true }).length
		const confirmCount = effectiveStale.filter(function (entry) { return entry.probed === true && entry.safe !== true }).length
		const activeCount = worktrees !== null && worktrees !== undefined && Number.isFinite(worktrees.active) ? worktrees.active : activeWts.length + (mainWt === undefined ? 0 : 1)
		const totalCount = worktrees !== null && worktrees !== undefined && Number.isFinite(worktrees.total) ? worktrees.total : wtList.length
		const selectedSafePaths = staleWts.filter(function (entry) {
			if (cleanupUi.selected[entry.path] !== true) return false
			const candidate = candidateByPath[entry.path]
			return candidate !== undefined ? candidate.why === 'safe' : entry.safe === true
		}).map(function (entry) { return entry.path })
		const cleanupBusy = cleanupUi.pending === true || cleanupUi.executing === true
		const previewRemovable = preflightCandidates.filter(function (candidate) { return candidate.wouldRemove === true })
		const cleanupResult = cleanupUi.result
		const wtReasonLabel = function (code) {
			const map = { unverified: 'statusWtReasonUnverified', 'outside-root': 'statusWtReasonOutsideRoot' }
			return map[code] === undefined ? t('statusWtReasonUnknown') : t(map[code])
		}
		const wtBadges = function (entry) {
			// T-146: dirty/merged arrive from the lazy probe, not /state.
			if (entry.probed !== true) {
		return h('span', { className: 'gbt-wtbadges', 'data-wt-probed': 'false' },
			h('span', { className: 'gbt-chip', 'data-tone': 'waiting' }, t(cleanupUi.probeState === 'loading' ? 'statusWtProbing' : cleanupUi.probeState === 'error' ? 'statusWtProbeFailed' : 'statusWtUnprobed')))
			}
			const dirty = entry.dirty === true
			const merged = entry.merged === true
			// T-143: gbt-chip carries the token-mapped data-tone colours
			// (ready -> success, waiting -> warn, blocked -> error); gbt-pill
			// only maps data-status, so state badges must not use it.
			return h('span', { className: 'gbt-wtbadges' },
		h('span', { className: 'gbt-chip', 'data-wt-state': entry.dirty === true ? 'dirty' : entry.dirty === false ? 'clean' : 'unknown', 'data-tone': dirty ? 'blocked' : 'ready' }, entry.dirty === false || entry.dirty === true ? t(dirty ? 'statusWtDirty' : 'statusWtClean') : '—'),
		h('span', { className: 'gbt-chip', 'data-wt-merge': entry.merged === true ? 'merged' : entry.merged === false ? 'unmerged' : 'unknown', 'data-tone': merged ? 'ready' : 'waiting' }, entry.merged === false || entry.merged === true ? t(merged ? 'statusWtMerged' : 'statusWtUnmerged') : '—'))
		}
		const wtRowBase = function (key, entry, rowMarker, stateText) {
			return h('div', { key: key, className: 'gbt-wtrow gbt-deckwtrow', 'data-worktree-row': rowMarker, 'data-wt-task': String(entry.taskId === undefined || entry.taskId === null ? '' : entry.taskId) },
		h('span', { className: 'gbt-wtlabel' }, h('b', null, wtLabelOf(entry)), h('span', { className: 'gbt-pill', 'data-wt-type': String(entry.type) }, wtTypeLabel(entry.type))),
		h('span', { className: 'gbt-wtpath gbt-mono', title: String(entry.path) }, wtBaseOf(entry.path)),
		h('span', { className: 'gbt-wtbranch gbt-mono', title: typeof entry.branch === 'string' ? entry.branch : '' }, typeof entry.branch === 'string' && entry.branch !== '' ? entry.branch : '—'),
		h('span', { className: 'gbt-wtsha gbt-mono' }, typeof entry.head === 'string' && entry.head !== '' ? entry.head.slice(0, 7) : '—'),
		stateText === undefined ? wtBadges(entry) : h('span', { className: 'gbt-chip', 'data-wt-active': 'true', 'data-tone': 'running' }, stateText))
		}
		const mainRow = mainWt === undefined ? null : wtRowBase('wt-main', mainWt, 'main', t('statusWtActiveState'))
		const activeRows = activeWts.map(function (entry) { return wtRowBase('wt-active-' + String(entry.path), entry, 'active', t('statusWtActiveState')) })
		const staleRows = staleWts.map(function (entry) {
			const effective = wtEffective(entry)
			const candidate = candidateByPath[entry.path]
			const safeEligible = candidate !== undefined && candidate.why === 'safe'
			const forceEligible = candidate !== undefined && (candidate.why === 'dirty' || candidate.why === 'unmerged')
			const actionId = wtLabelOf(entry) + '@' + String(entry.path)
			let actions = null
			if (safeEligible) {
		actions = h('span', { className: 'gbt-wtactions' },
			h('input', { key: 'select', type: 'checkbox', 'data-worktree-select': entry.path, checked: cleanupUi.selected[entry.path] === true, disabled: cleanupBusy, onChange: function () { cleanupUi.selected[entry.path] = cleanupUi.selected[entry.path] !== true; wtBump() } }),
			h('button', { key: 'clean', type: 'button', className: 'gbt-btn', 'data-action': 'worktree-cleanup', 'data-path': entry.path, disabled: cleanupBusy, onClick: function () { wtExecute([entry.path], false) } }, t('statusWtCleanup')))
			} else if (forceEligible) {
		actions = cleanupUi.forceConfirm === entry.path
			? h('span', { className: 'gbt-wtactions' },
				h('button', { key: 'confirm', type: 'button', className: 'gbt-btn', 'data-variant': 'danger', 'data-action': 'worktree-force-cleanup-confirm', 'data-path': entry.path, disabled: cleanupBusy, onClick: function () { wtExecute([entry.path], true) } }, t('statusWtConfirmForce')),
				h('button', { key: 'cancel', type: 'button', className: 'gbt-btn', 'data-action': 'worktree-force-cleanup-cancel', 'data-path': entry.path, onClick: function () { cleanupUi.forceConfirm = null; wtBump() } }, t('statusWtCancel')))
			: h('span', { className: 'gbt-wtactions' },
				h('button', { key: 'force', type: 'button', className: 'gbt-btn', 'data-variant': 'danger', 'data-action': 'worktree-force-cleanup', 'data-path': entry.path, disabled: cleanupBusy, onClick: function () { cleanupUi.forceConfirm = entry.path; wtBump() } }, t('statusWtForceCleanup')))
			} else {
		actions = h('span', { className: 'gbt-wtactions' }, h('span', { className: 'gbt-statusnote' }, candidate !== undefined ? wtReasonLabel(String(candidate.why)) : effective.probed !== true ? t(cleanupUi.probeState === 'loading' ? 'statusWtProbing' : cleanupUi.probeState === 'error' ? 'statusWtProbeFailed' : 'statusWtUnprobed') : t('statusWtPreflightFirst')))
			}
			return h('div', { key: 'wt-stale-' + actionId, className: 'gbt-wtrow gbt-deckwtrow', 'data-worktree-stale': wtLabelOf(entry), 'data-path': entry.path, 'data-reason': String(effective.reason === undefined || effective.reason === null ? '' : effective.reason), 'data-wt-probed': effective.probed === true ? 'true' : 'false' },
		h('span', { className: 'gbt-wtlabel' }, h('b', null, wtLabelOf(entry)), h('span', { className: 'gbt-pill', 'data-wt-type': String(entry.type) }, wtTypeLabel(entry.type))),
		h('span', { className: 'gbt-wtpath gbt-mono', title: String(entry.path) }, wtBaseOf(entry.path)),
		h('span', { className: 'gbt-wtbranch gbt-mono', title: typeof entry.branch === 'string' ? entry.branch : '' }, typeof entry.branch === 'string' && entry.branch !== '' ? entry.branch : '—'),
		h('span', { className: 'gbt-wtsha gbt-mono' }, typeof effective.head === 'string' && effective.head !== '' ? effective.head.slice(0, 7) : '—'),
		wtBadges(effective),
		actions)
		})
		const preflightBlock = cleanupUi.preflight === null ? null : h('div', { className: 'gbt-wtpreview', 'data-wt-preflight': 'true' },
			h('div', { className: 'gbt-statusnote' }, t('statusWtPreviewTitle') + ' · ' + t('statusWtPreviewKept').replace('{n}', String(Array.isArray(cleanupUi.preflight.kept) ? cleanupUi.preflight.kept.length : 0))),
			previewRemovable.length === 0 ? h('div', { className: 'gbt-statusnote' }, t('statusWtPreviewNone')) : null,
			previewRemovable.map(function (candidate) { return h('div', { key: 'preview-' + String(candidate.path), className: 'gbt-wtpreviewrow gbt-mono', 'data-wt-preview-path': candidate.path }, wtBaseOf(candidate.path) + ' · ' + String(candidate.why)) }))
		const resultBlock = cleanupResult === null ? null : h('div', { className: 'gbt-wtresult', 'data-wt-result': cleanupResult.ok === true ? 'ok' : 'error' },
			cleanupResult.ok === true
		? h('div', null, t('statusWtResult') + '：' + t('statusWtRemoved') + ' ' + String(Array.isArray(cleanupResult.removed) ? cleanupResult.removed.length : 0) + ' · ' + t('statusWtKept') + ' ' + String(Array.isArray(cleanupResult.kept) ? cleanupResult.kept.length : 0) + ' · ' + t('statusWtFailed') + ' ' + String(Array.isArray(cleanupResult.failed) ? cleanupResult.failed.length : 0))
		: h('div', null, t('statusWtCleanupFailed') + '：' + String(cleanupResult.code === undefined || cleanupResult.code === null ? '' : cleanupResult.code)),
			cleanupResult.ok === true && Array.isArray(cleanupResult.failed)
		? cleanupResult.failed.map(function (entry) { return h('div', { key: 'failed-' + String(entry.path), className: 'gbt-wtpreviewrow gbt-mono' }, wtBaseOf(entry.path) + ' · ' + String(entry.code === undefined ? '' : entry.code)) })
		: null)
		const worktreesCard = h('section', { className: 'gbt-statuscard gbt-deckworktrees', 'data-status-card': 'worktrees' },
			h('div', { className: 'gbt-deckpanelhead' },
				h('span', { className: 'gbt-deckeyebrow' }, 'WORKTREES / ' + String(totalCount).padStart(2, '0')),
				h('h2', null, t('statusCardWorktrees')),
				h('span', { className: 'gbt-deckpanelmeta', 'data-wt-summary': 'true' }, String(totalCount) + ' ' + t('statusWtTotal') + ' · ' + String(activeCount) + ' ' + t('statusWtActive') + ' · ' + String(safeCount) + ' ' + t('statusWtSafe') + ' · ' + String(confirmCount) + ' ' + t('statusWtConfirm')),
			),
			worktrees === null || worktrees === undefined || worktrees.available !== true
				? h('div', { className: 'gbt-deckempty' }, worktrees !== null && worktrees !== undefined && worktrees.error === 'no-git-service' ? t('statusNoGit') : snapshot.source === 'loading' ? t('statusWtLoading') : t('statusWorktreesUnavailable'))
				: h('div', { className: 'gbt-deckwtview' },
					h('div', { className: 'gbt-deckwtool' },
						h('button', { type: 'button', className: 'gbt-btn', 'data-action': 'worktree-preflight', disabled: cleanupUi.pending === true, onClick: wtRunPreflight }, cleanupUi.pending === true ? t('statusWtPreflighting') : t('statusWtPreflight')),
						h('button', { type: 'button', className: 'gbt-btn', 'data-variant': 'primary', 'data-action': 'worktree-cleanup-safe', disabled: cleanupBusy || selectedSafePaths.length === 0, onClick: function () { wtExecute(selectedSafePaths, false) } }, t('statusWtCleanupSafe').replace('{n}', String(selectedSafePaths.length))),
						h('span', { className: 'gbt-deckwtoolmeta' }, String(staleWts.length) + ' ' + t('statusStaleWorktrees')),
					),
					h('div', { className: 'gbt-deckwtrows' },
						h('div', { className: 'gbt-deckwtgroup', 'data-wt-section': 'main' }, h('span', null, 'MAIN / ' + t('statusWtMain')), h('b', null, '1')),
						mainRow,
						activeWts.length === 0 ? null : h('div', { className: 'gbt-deckwtgroup', 'data-wt-section': 'active' }, h('span', null, 'ACTIVE / ' + t('statusWtActive')), h('b', null, String(activeWts.length))),
						activeRows,
						h('div', { className: 'gbt-deckwtgroup', 'data-wt-section': 'stale' }, h('span', null, 'STALE / ' + t('statusStaleWorktrees')), h('b', null, String(staleWts.length))),
						staleWts.length === 0 ? h('div', { className: 'gbt-deckempty' }, t('statusWtNoStale')) : h('div', { className: 'gbt-wtlines', 'data-wt-lines': 'true' }, staleRows),
					),
					preflightBlock,
					resultBlock,
				),
		)
		// v3: the executors rail is the live execution tree — the root Agent plus
		// every live child the Host reports. No roster, no team readiness, no
		// leftover slot inventory.
		const agentRows = []
		if (agentTree.root !== null) agentRows.push(agentRow(agentTree.root, true, -1))
		agentTree.members.forEach(function (member, index) { agentRows.push(agentRow(member, false, index)) })
		const liveCount = agentTree.root === null ? 0 : agentTree.members.length + 1
		const anyRunning = agentTree.root !== null || agentTree.members.some(function (member) { return member.status === 'running' })
		const agentsCard = h(
			'section',
			{ className: 'gbt-statuscard gbt-deckexecutors', 'data-status-card': 'agents' },
			h('div', { className: 'gbt-decklabel' }, h('span', null, 'AGENTS'), h('span', { className: 'gbt-decklabelzh' }, t('statusCardAgents')), h('em', { 'data-running': anyRunning ? 'true' : 'false' }, String(liveCount))),
			h('div', { className: 'gbt-deckpeople', 'data-status-agents': 'true' },
				snapshot.agentTree === null || snapshot.agentTree === undefined || agentTree.available !== true
					? h('div', { className: 'gbt-statusnote', 'data-status-agents-empty': 'unavailable' }, t('statusAgentsUnavailable'))
					: agentTree.root === null
						? h('div', { className: 'gbt-statusnote', 'data-status-agents-empty': 'no-root' }, t('statusAgentsNoRoot'))
						: h('div', null, agentRows, agentTree.members.length === 0 ? h('div', { className: 'gbt-statusnote', 'data-status-agents-empty': 'no-children' }, t('statusAgentsNoChildren')) : null),
			),
		)
		const timeline = snapshot.activityEvents
		// Available when the Host sends the derived timeline OR (legacy Host) the ring.
		const activityAvailable =
			(timeline !== null && timeline !== undefined && timeline.available === true) ||
			(activity !== null && activity !== undefined && activity.available === true) ||
			recentStream.length > 0
		// The sweep is telemetry: one folded row with the last counts, never a stream entry.
		const sweepRows = showAllActivity && lastSweep !== null ? [lastSweep] : []
		const activityCard = h(
			'section',
			{ className: 'gbt-statuscard gbt-deckactivity', 'data-status-card': 'activity' },
			h('div', { className: 'gbt-deckpanelhead' }, h('span', { className: 'gbt-deckeyebrow' }, 'ACTIVITY / ' + String(recentStream.length).padStart(2, '0')), h('h2', null, t('statusCardActivity')), h('span', { className: 'gbt-deckpanelmeta' }, t('statusLatestActivity') + ' ' + String(recentStream.length) + ' ' + t('statusEventUnit'))),
			h(
		'div',
		{ className: 'gbt-deckactivitybody' },
		!activityAvailable
			? h('div', { className: 'gbt-statusnote' }, t('statusActivityUnavailable'))
			: recentStream.length === 0 && sweepRows.length === 0 && lastSweep === null
				? h('div', { className: 'gbt-statusnote' }, t('statusActivityEmpty'))
				: h('div', null,
			recentStream.map(function (event) {
				return h(
					'div',
					{ key: event.key, className: 'gbt-statusev gbt-deckarow', 'data-activity': event.type, 'data-activity-kind': event.type, 'data-activity-task': event.taskId, title: event.raw === null ? undefined : event.raw },
					h('span', { className: 'gbt-statusevtime gbt-mono' }, typeof event.at === 'string' ? new Date(event.at).toTimeString().slice(0, 5) : '—'),
					h('span', { className: 'gbt-statusevkind' }, activityLabel(event.type)),
					h('span', { className: 'gbt-statusevtext' }, event.html),
				)
			}),
			sweepRows.map(function (entry, index) {
				return h(
					'div',
					{ key: 'sweep-' + String(index), className: 'gbt-statusev', 'data-activity': 'sweep', 'data-activity-kind': 'sweep', title: t('statusSweepInterval') },
					h('span', { className: 'gbt-statusevtime gbt-mono' }, typeof entry.at === 'string' ? new Date(entry.at).toTimeString().slice(0, 5) : '—'),
					h('span', { className: 'gbt-statusevkind' }, t('statusEvtSweep')),
					h('span', { className: 'gbt-statusevtext' }, 'merged ' + String(entry.merged === undefined ? 0 : entry.merged) + ' · skipped ' + String(entry.skipped === undefined ? 0 : entry.skipped)),
				)
			}),
				),
		lastSweep === null
			? null
			: h(
			'div',
			{ className: 'gbt-statusfold' },
			h('span', null, (showAllActivity ? t('statusSweepsShown') : t('statusSweepFolded')) + ' · ' + t('statusSweepInterval') + '（merged ' + String(lastSweep !== null && lastSweep.merged !== undefined ? lastSweep.merged : 0) + ' · skipped ' + String(lastSweep !== null && lastSweep.skipped !== undefined ? lastSweep.skipped : 0) + '）'),
			h('button', { type: 'button', className: 'gbt-linkbtn', 'data-action': 'status-show-all', 'data-show-all': showAllActivity ? 'true' : 'false', onClick: function () { const next = !showAllActivity; statusUiState.showAll = next; setShowAllActivity(next) } }, showAllActivity ? t('statusShowReal') : t('statusShowAll')),
				),
			),
		)
		function activityLabel(type) {
			return t('evtLabel-' + type)
		}
		// T-155 §1/§8: every participating session, aggregated PER SESSION. There is
		// no "project team" and no primary session — the current chat session is only
		// highlighted. Stage-role readiness lives here (not in a global warning).
		const scope = snapshot.scope !== null && snapshot.scope !== undefined && typeof snapshot.scope === 'object' ? snapshot.scope : null
		const sessionRows = scope !== null && Array.isArray(scope.sessionSummaries) ? scope.sessionSummaries.filter(function (row) { return row !== null && typeof row === 'object' }) : []
		const currentSession = scope !== null && typeof scope.panelSession === 'string' && scope.panelSession !== '' ? scope.panelSession : null
		const [sessionFilter, setSessionFilterState] = React.useState(statusUi.sessionFilter)
		const setSessionFilter = function (next) {
			statusUi.sessionFilter = next
			setSessionFilterState(next)
		}
		const visibleSessions = sessionFilter === 'all' ? sessionRows : sessionRows.filter(function (row) { return row.sessionId === sessionFilter })
		// T-173: on wide screens the detail follows the filter, then the current
		// chat session, then the first visible row; no synthetic session is made.
		const currentSessionRow = currentSession === null ? null : sessionRows.filter(function (row) { return row.sessionId === currentSession })[0]
		const detailSession = sessionFilter !== 'all'
			? sessionRows.filter(function (row) { return row.sessionId === sessionFilter })[0] || null
			: currentSessionRow !== undefined
				? currentSessionRow
				: visibleSessions[0] !== undefined
					? visibleSessions[0]
					: sessionRows[0] !== undefined
						? sessionRows[0]
						: null
		const projectRootOf = function (row) {
			const boardProject = scope !== null && scope.boardProject !== null && scope.boardProject !== undefined && typeof scope.boardProject === 'object' ? scope.boardProject : null
			if (boardProject !== null && typeof boardProject.root === 'string' && boardProject.root !== '') return boardProject.root
			if (snapshot.project !== null && snapshot.project !== undefined && typeof snapshot.project === 'object' && typeof snapshot.project.root === 'string') return snapshot.project.root
			if (typeof snapshot.projectRoot === 'string' && snapshot.projectRoot !== '') return snapshot.projectRoot
			if (typeof snapshot.project === 'string' && snapshot.project !== '') return snapshot.project
			return row !== null && typeof row.projectRoot === 'string' ? row.projectRoot : '—'
		}
		const detailTaskMatches = detailSession === null ? [] : tasks.filter(function (task) {
			if (task === null || task === undefined) return false
			const assigneeSession = task.assignee !== null && task.assignee !== undefined && typeof task.assignee.session === 'string' ? task.assignee.session : null
			return task.ownerSession === detailSession.sessionId || assigneeSession === detailSession.sessionId
		})
		// The card header shows this preview count against the session's real
		// owned count; never let the preview limit read as the total.
		const detailTasks = detailTaskMatches.slice(0, 2)
		const sessionShortText = function (value) {
			const text = typeof value === 'string' ? value : ''
			return text.indexOf('session-') === 0 ? text.slice(8, 16) : text.slice(0, 8)
		}
		const sessionStatusText = function (status) {
			return status === 'live' ? t('sessionsStatusLive') : status === 'stale' ? t('sessionsStatusStale') : t('sessionsStatusUnknown')
		}
		const sessionsCard = h(
			'section',
			{ className: 'gbt-statuscard gbt-decksessions', 'data-status-card': 'sessions' },
			h('div', { className: 'gbt-deckpanelhead' },
				h('span', { className: 'gbt-deckeyebrow' }, 'SESSIONS / ' + String(sessionRows.length).padStart(2, '0')),
				h('h2', null, t('sessionCardTitle')),
				h('span', { className: 'gbt-deckpanelmeta' }, String(visibleSessions.length) + ' / ' + String(sessionRows.length) + ' ' + t('sessionsLabel')),
				h('label', { className: 'gbt-deckfilter' }, t('sessionFilter'),
					h('select', { 'data-session-filter': 'true', value: sessionFilter, onChange: function (event) { setSessionFilter(event !== null && event !== undefined && event.target !== undefined ? String(event.target.value) : 'all') } },
						h('option', { value: 'all' }, t('sessionFilterAll')),
						sessionRows.map(function (row) { return h('option', { key: 'opt-' + String(row.sessionId), value: String(row.sessionId) }, sessionShortText(row.sessionId)) }),
					),
				),
			),
			h('div', { className: 'gbt-deckthead', 'data-session-columns': 'true' },
				h('span', null, t('sessionColSession')),
				h('span', { 'data-session-cards-label': 'true', title: t('sessionDetailCards') }, t('sessionColCards')),
				h('span', null, t('sessionColStatus')),
			),
			sessionRows.length === 0
				? h('div', { className: 'gbt-deckempty', 'data-sessions-empty': 'true' }, t('sessionsEmpty'))
				: h('div', { className: 'gbt-deckrows', 'data-sessions-list': 'true', title: t('sessionsHint') },
					visibleSessions.map(function (row, index) {
						const current = currentSession !== null && row.sessionId === currentSession
						const cards = row.cards !== null && row.cards !== undefined && typeof row.cards === 'object' ? row.cards : {}
						const owned = Number.isFinite(cards.owned) ? cards.owned : 0
						const activeCards = Number.isFinite(cards.active) ? cards.active : 0
						return h('div', {
							key: 'session-' + String(index),
							className: 'gbt-decksessionrow' + (current ? ' is-current' : ''),
							'data-session': String(row.sessionId),
							'data-current': current ? 'true' : 'false',
							'data-session-status': typeof row.status === 'string' ? row.status : 'unknown',
						},
							h('div', { className: 'gbt-decksessionname' },
								h('b', { className: 'gbt-mono' }, sessionShortText(row.sessionId)),
								current ? h('span', { className: 'gbt-decksession-current' }, t('sessionsCurrent')) : null,
							),
							h('span', { className: 'gbt-decknum', 'data-session-cards': 'true', title: t('sessionDetailCards') }, h('b', null, String(owned)), ' / ' + String(activeCards)),
							h('span', { className: 'gbt-deckstatus', 'data-session-status-pill': typeof row.status === 'string' ? row.status : 'unknown', 'data-status': typeof row.status === 'string' ? row.status : 'unknown' }, h('i', { className: 'gbt-deckdot', 'data-on': row.status === 'live' ? 'true' : 'false' }), sessionStatusText(row.status)),
						)
					}),
				),
		)

		// T-173: wide-screen detail lives outside the table so the table keeps its
		// natural row height instead of stretching to fill the center column. It
		// describes the SESSION (identity, project, cards) and never a team roster.
		const detailFacts = []
		const detailCards = detailSession !== null && detailSession.cards !== null && detailSession.cards !== undefined && typeof detailSession.cards === 'object' ? detailSession.cards : {}
		const detailOwned = Number.isFinite(detailCards.owned) ? detailCards.owned : detailTaskMatches.length
		const detailActive = Number.isFinite(detailCards.active) ? detailCards.active : 0
		if (detailSession !== null) {
			detailFacts.push({ key: 'project', label: t('sessionDetailProject'), value: projectRootOf(detailSession) })
			detailFacts.push({ key: 'cards', label: t('sessionDetailCards'), value: String(detailOwned) + ' / ' + String(detailActive) })
		}
		const detailSessionCard = h('section', {
			className: 'gbt-statuscard gbt-decksessiondetail',
			'data-session-detail': detailSession === null ? '' : String(detailSession.sessionId),
			'data-detail-current': detailSession !== null && currentSession !== null && detailSession.sessionId === currentSession ? 'true' : 'false',
			'data-detail-title': detailSession !== null && currentSession !== null && detailSession.sessionId === currentSession ? 'current' : 'selected',
		},
			h('div', { className: 'gbt-deckpanelhead' },
				h('span', { className: 'gbt-deckeyebrow' }, 'SESSION / DETAIL'),
				h('h2', null, detailSession !== null && currentSession !== null && detailSession.sessionId === currentSession ? t('sessionDetailTitle') : t('sessionDetailSelectedTitle')),
				h('span', { className: 'gbt-deckpanelmeta' }, detailSession === null ? t('sessionsEmpty') : String(detailSession.sessionId)),
			),
			detailSession === null
				? h('div', { className: 'gbt-deckempty', 'data-session-detail-empty': 'true' }, t('sessionsEmpty'))
				: h('div', { className: 'gbt-detailbody' },
					h('div', { className: 'gbt-detailidentity' },
						h('div', { className: 'gbt-detailidentityline' },
							h('b', { className: 'gbt-mono' }, sessionShortText(detailSession.sessionId)),
							h('span', { className: 'gbt-detailcurrent' }, detailSession.sessionId === currentSession ? t('sessionsCurrent') : t('sessionDetailSelected')),
							h('span', { className: 'gbt-detailstatus' }, h('i', { className: 'gbt-deckdot', 'data-on': detailSession.status === 'live' ? 'true' : 'false' }), sessionStatusText(detailSession.status)),
						),
						h('div', { className: 'gbt-detailid gbt-mono', title: String(detailSession.sessionId) }, String(detailSession.sessionId)),
					),
					h('div', { className: 'gbt-detailfacts' }, detailFacts.map(function (fact) {
						return h('div', { key: fact.key, className: 'gbt-detailfact', 'data-session-detail-fact': fact.key },
							h('b', { className: 'gbt-mono', title: String(fact.value) }, String(fact.value)),
							h('span', null, fact.label))
					})),
					h('div', { className: 'gbt-detailright' },
						h('div', { className: 'gbt-detailtasks', 'data-session-detail-tasks': 'true' },
							h('div', { className: 'gbt-detailpanelhead' }, h('span', { className: 'gbt-deckeyebrow' }, 'CARDS'), h('span', { className: 'gbt-detailpreview', 'data-detail-preview-label': 'true' }, t('sessionDetailPreview')), h('b', { 'data-detail-preview-count': String(detailTasks.length), 'data-detail-total-count': String(detailOwned) }, String(detailTasks.length) + ' / ' + String(detailOwned))),
							detailTasks.length === 0
								? h('div', { className: 'gbt-deckempty' }, t('sessionDetailNoTasks'))
								: detailTasks.map(function (task) {
									return h('div', { key: 'detail-task-' + String(task.id), className: 'gbt-detailtask', 'data-session-task': String(task.id) },
										h('b', { className: 'gbt-mono' }, String(task.id)),
										h('span', { className: 'gbt-detailtasktitle', title: typeof task.title === 'string' ? task.title : '' }, typeof task.title === 'string' ? task.title : '—'),
										h('em', { className: 'gbt-mono' }, typeof task.status === 'string' ? task.status : '—'))
								}),
						),
					),
					),
				)

		return h(
			'div',
			{ className: 'gbt-statusview gbt-shiftdeck', 'data-status': 'cards' },
			h(
				'div',
				{ className: 'gbt-statustop gbt-deckhead', 'data-status-top': 'true' },
				h('span', { className: 'gbt-deckeyebrow' }, 'STATUS / 03'),
				h('h1', null, t('status')),
				h('span', { className: 'gbt-deckheadcrumb', title: lastActivityText === null ? '' : lastActivityText }, lastActivityText === null ? '' : lastActivityText),
				h('div', { className: 'gbt-statusactions' },
					h('span', { className: 'gbt-decklastscan' }, t('statusLastScan') + ' · ' + scanAgo),
					h('button', { type: 'button', className: 'gbt-btn', 'data-action': 'status-refresh', onClick: function () { void store.load() } }, '↻ ' + t('refresh')),
				),
			),
			h('div', { className: 'gbt-statusgrid gbt-deckgrid', 'data-status-grid': 'true' },
				h('aside', { className: 'gbt-deckrail' }, dispatchCard, agentsCard),
				sessionsCard,
				detailSessionCard,
				worktreesCard,
				activityCard,
			),
		)
	}
	return StatusView
}

module.exports = { createStatusView }

				})(module, module.exports)
				const factory = module.exports.createStatusView
				return factory({
					React: React,
					h: h,
					statusUiState: statusUiState,
					worktreeCleanupUi: worktreeCleanupUi,
					actorDisplay: actorDisplay,
					mergeActorOf: mergeActorOf,
					roleKindLabel: roleKindLabel,
					tcAgentTreeOf: tcAgentTreeOf,
					tcAgentStatusKey: tcAgentStatusKey,
					testSummaryText: testSummaryText,
					tcAgo: tcAgo,
					tcMergeOf: tcMergeOf,
					tcSessionIdInfo: tcSessionIdInfo,
					tcStageQueued: tcStageQueued,
					copyToClipboard: copyToClipboard,
				})
			})()


			/** Status page, direction A: one summary line, three narrow cards, a full-width activity card. */


			function Modal(props) {
				return h(
					'div',
					{ className: 'gbt-overlay', onClick: function (event) { if (event.target === event.currentTarget) props.onClose() } },
					h(
						'div',
						{ className: 'gbt-modal', role: 'dialog', 'aria-modal': 'true' },
						h(
							'div',
							{ className: 'gbt-modalhead' },
							h('h2', null, props.title),
							h('button', { type: 'button', className: 'gbt-iconbtn', onClick: props.onClose, 'aria-label': props.t('close') }, '×'),
						),
						props.children,
					),
				)
			}

			/** The label the host tool writes for an agent: session- stripped, non-alphanumerics removed, 8 chars. */
			function agentToolLabel(member) {
				const raw = typeof member.session === 'string' && member.session !== '' ? member.session : typeof member.id === 'string' ? member.id : ''
				return String(raw).replace(/^session-/, '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 8)
			}

			/** Prefer the name the host wrote (byName); otherwise resolve the label against
			 * the roster; an unresolved id shows as 成员 <label>, never a bare @. */
			function actorDisplay(by, byName, roster, t, fallbackKey) {
				// An old host wrote the tool label (@xxxxxxxx) into byName: it is NOT a
				// name, so it goes through the role-word fallback instead of rendering.
				if (typeof byName === 'string' && byName !== '') {
					if (byName.charAt(0) !== '@') return byName
					const label = byName.slice(1).replace(/[^a-zA-Z0-9]/g, '').slice(0, 8)
					const role = typeof fallbackKey === 'string' && fallbackKey !== '' ? t(fallbackKey) : ''
					if (role !== '') return label === '' ? role : role + ' ' + label
					// A degenerate '@' byName carries no id at all: show the bare word, never '@'.
					return label === '' ? t('actorUnknown').replace(' {id}', '') : t('actorUnknown').replace('{id}', label)
				}
				const resolved = resolveAgentName(by, roster, t)
				if (typeof resolved === 'string' && resolved.charAt(0) === '@') {
					const label = resolved.slice(1).replace(/[^a-zA-Z0-9]/g, '').slice(0, 8)
					const role = typeof fallbackKey === 'string' && fallbackKey !== '' ? t(fallbackKey) : ''
					if (role !== '') return label === '' ? role : role + ' ' + label
					return t('actorUnknown').replace('{id}', label === '' ? resolved : label)
				}
				return resolved
			}

			/** The actor that merged this task, from its merge/done history entry. */
			function mergeActorOf(task) {
				const hist = Array.isArray(task === null || task === undefined ? null : task.history) ? task.history : []
				const hit = hist.filter(function (entry) {
					const note = typeof entry.note === 'string' ? entry.note : ''
					return (entry.to === 'done' && note.indexOf('merged') >= 0) || note.indexOf('merged as') === 0
				})[0]
				return hit === undefined ? null : { by: hit.by, byName: hit.byName }
			}

			/** Structured test summary: 通过 · exit 0 · 21s (no evidence text). */
			function testSummaryText(test, review, t, verdict) {
				if (test === null || test === undefined) return ''
				const effective = verdict === 'passed' || verdict === 'failed' ? verdict : test.status
				const passed = effective === 'passed'
				const label = passed ? t('statusResultPassed') : t('detailHostCheckFailed')
				const hostCheck = typeof test.hostCheck === 'object' && test.hostCheck !== null ? test.hostCheck : null
				const parts = [label]
				if (hostCheck !== null) parts.push('exit ' + String(hostCheck.exitCode === null || hostCheck.exitCode === undefined ? '—' : hostCheck.exitCode))
				const duration = hostCheck !== null && Number.isFinite(hostCheck.durationMs) ? hostCheck.durationMs : null
				if (duration !== null) parts.push(String(Math.max(1, Math.round(duration / 1000))) + 's')
				else if (review !== null && review !== undefined && typeof review.at === 'string' && typeof test.at === 'string') {
					const ms = new Date(test.at).getTime() - new Date(review.at).getTime()
					if (Number.isFinite(ms) && ms > 0) parts.push(t('detailTestDuration') + ' ' + String(Math.max(1, Math.round(ms / 1000))) + 's')
				}
				return parts.join(' · ')
			}

			/** Map an @label / @session id to the roster member name; unresolved values stay verbatim. */
			function resolveAgentName(value, roster, t) {
				if (typeof value !== 'string' || value === '') return '—'
				if (value === '@user' || value === 'user') return t('statusYou')
				if (value.charAt(0) !== '@') {
					const bare = roster.filter(function (member) {
						return member.name === value || member.kind === value || member.id === value || agentToolLabel(member) === value.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8)
					})[0]
					return bare === undefined ? value : typeof bare.name === 'string' && bare.name !== '' ? bare.name : value
				}
				const id = value.slice(1)
				const idKey = id.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8)
				const hit = roster.filter(function (member) {
					return agentToolLabel(member) === idKey || member.name === id || member.kind === id || member.id === id || member.id === value
				})[0]
				return hit === undefined ? value : typeof hit.name === 'string' && hit.name !== '' ? hit.name : value
			}

			/** Detail-page disclosure state that must survive a re-mount. */
			const detailUiState = { evidence: false, spec: false }

			const DetailView = (function () {
				const module = { exports: {} }
				;(function (module, exports) {
/**
 * Task detail view module.
 *
 * Extracted from the detail fragment; React, h, the detail UI state, shared
 * actor/merge helpers and the task selectors are injected by the build.
 */
function createDetailView(deps) {
	const React = deps.React
	const h = deps.h
	const detailUiState = deps.detailUiState
	const actorDisplay = deps.actorDisplay
	const mergeActorOf = deps.mergeActorOf
	const tcAgentTreeOf = deps.tcAgentTreeOf
	const testSummaryText = deps.testSummaryText
	const toneForDependency = deps.toneForDependency
	const waitingChip = deps.waitingChip
	const tcAgo = deps.tcAgo
	const tcIsInvestigation = deps.tcIsInvestigation
	const tcMergeLabel = deps.tcMergeLabel
	const tcMergeOf = deps.tcMergeOf
	const tcPhaseLabel = deps.tcPhaseLabel
	const tcReportBlocks = deps.tcReportBlocks
	const tcReviewLabel = deps.tcReviewLabel
	const tcReviewOf = deps.tcReviewOf
	const tcRound = deps.tcRound
	const tcStatusKey = deps.tcStatusKey
	const tcTestLabel = deps.tcTestLabel
	const tcTestOf = deps.tcTestOf
	// T-209: the same optional sidebar handle the task card receives. Missing
	// services mean null, which hides the entry instead of rendering a dead one.
	const agentSidebar = deps.agentSidebar === null || deps.agentSidebar === undefined ? null : deps.agentSidebar

	/** The REAL session recorded on the card, or null. Never minted here. */
	function sidebarSessionOf(task) {
		if (agentSidebar === null || typeof agentSidebar.sessionOf !== 'function') return null
		try {
			const session = agentSidebar.sessionOf(task)
			return typeof session === 'string' && session !== '' ? session : null
		} catch (error) {
			return null
		}
	}

	/** True only once the host really registered the tab (missing service = false). */
	function sidebarAvailable() {
		if (agentSidebar === null || typeof agentSidebar.available !== 'function') return false
		try {
			return agentSidebar.available() === true
		} catch (error) {
			return false
		}
	}

	/**
	 * T-216: the clicked card's id travels WITH the session. The tab opens in the
	 * host session and shows the exact card; deriving it from the session alone
	 * picks another card whenever a session (the owner session, typically) is
	 * shared by several cards.
	 */
	function openSidebar(sessionId, taskId) {
		if (agentSidebar === null || typeof agentSidebar.open !== 'function') return false
		try {
			return agentSidebar.open(sessionId, taskId) === true
		} catch (error) {
			return false
		}
	}

	function sidebarLabel(key) {
		if (agentSidebar !== null && typeof agentSidebar.label === 'function') {
			try {
				const text = agentSidebar.label(key)
				if (typeof text === 'string' && text !== '') return text
			} catch (error) {}
		}
		return key
	}

	function DetailView(props) {
		const task = props.task
		const t = props.t
		const now = props.now
		const snapshot = props.snapshot
		const [deleteError, setDeleteError] = React.useState(null)
		const [evidenceOpen, setEvidenceOpen] = React.useState(detailUiState.evidence === true)
		// T-177: the task spec/acceptance is main content, not a hidden aside.
		const [specOpen, setSpecOpen] = React.useState(true)
		const evidence = React.useRef(null)
		const note = React.useRef(null)
		const allTasks = snapshot.tasks
		const deps = Array.isArray(task.dependsOn) ? task.dependsOn : []
		const files = Array.isArray(task.writeFiles) ? task.writeFiles : []
		const actualFiles = Array.isArray(task.actualFiles) ? task.actualFiles : []
		const held = snapshot.locks.filter(function (lock) { return lock.taskId === task.id }).map(function (lock) { return lock.path })
		// T-132: an investigation is delivered as a REPORT. It has no review,
		// test or merge phase, and its scratch checkout is discarded on report.
		const investigate = tcIsInvestigation(task)
		const report =
			investigate && task.report !== null && task.report !== undefined && typeof task.report === 'object' && !Array.isArray(task.report) ? task.report : null
		// The detail is wide content: lay it out by the CONTAINER width, which the
		// panel approximates from the window when no explicit probe is passed.
		const viewport = typeof props.detailWidth === 'number' ? props.detailWidth : typeof window !== 'undefined' && Number.isFinite(window.innerWidth) && window.innerWidth > 0 ? window.innerWidth : 1440
		// Above 900 the overlay pads 24px per side and the panel is capped at 1080,
		// so the content width is viewport-96; below 900 the media rule makes the
		// overlay full screen, so the container IS the viewport.
		const probe = viewport < 900 ? viewport : Math.min(viewport - 96, 1080)
		const wide = probe >= 900
		const layout = wide ? 'two-column' : probe >= 700 ? 'compact' : 'single'
		const widthClass = wide ? 'wide' : 'narrow'
		React.useEffect(function () {
			if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return undefined
			function onKey(event) { if (event !== null && event !== undefined && event.key === 'Escape') props.onClose() }
			window.addEventListener('keydown', onKey)
			return function () { window.removeEventListener('keydown', onKey) }
		}, [])
		const dispatch = task.dispatch === null || task.dispatch === undefined ? null : task.dispatch
		const merge = tcMergeOf(task)
		const review = tcReviewOf(task)
		const test = tcTestOf(task)
		const history = Array.isArray(task.history) ? task.history.slice() : []

		function noteValue() {
			return note.current === null ? '' : String(note.current.value || '').trim()
		}
		function run(action, body) {
			void store.send(action, body)
		}
		function submitWork() {
			const value = evidence.current === null ? '' : String(evidence.current.value || '').trim()
			if (value === '') return
			run('submit', { id: task.id, evidence: value })
		}
		function remove(force) {
			void store.send('delete', { id: task.id, force: force === true }).then(function (result) {
		if (result.ok === true) {
			props.onClose()
			return
		}
		setDeleteError(result.payload !== undefined && result.payload !== null && result.payload.code === 'referenced' ? 'referenced' : 'failed')
			})
		}

		// ── member names: session-id prefixes from @ids resolve to the live tree ──
		// The root Agent plus its live children are the only names the panel can
		// honestly resolve; there is no team roster behind this drawer.
		const roster = []
		const agentTree = tcAgentTreeOf(snapshot)
		if (agentTree.root !== null) roster.push({ id: agentTree.root.id, name: agentTree.root.name, kind: agentTree.root.role })
		agentTree.members.forEach(function (member) { roster.push({ id: member.id, name: member.name, kind: member.role }) })
		function actorName(value, byName, fallbackKey) {
			return actorDisplay(value, byName, roster, t, fallbackKey)
		}

		const actions = []
		// T-209: the agent entry is the FIRST action whenever the card names a real
		// session and the host registered our right-sidebar tab.
		const sidebarSession = sidebarAvailable() ? sidebarSessionOf(task) : null
		if (sidebarSession !== null) {
			actions.push(
				h(
					'button',
					{ key: 'sidebar', type: 'button', className: 'gbt-btn', 'data-action': 'open-agent-sidebar', 'data-sidebar-session': sidebarSession, title: sidebarLabel('openInSidebarHint'), onClick: function () { openSidebar(sidebarSession, task.id) } },
					'▤ ' + sidebarLabel('openInSidebar'),
				),
			)
		}
		if (task.status === 'pending') {
			actions.push(h('button', { key: 'edit', type: 'button', className: 'gbt-btn', onClick: function () { props.onEdit(task) } }, t('edit')))
			actions.push(h('button', { key: 'block', type: 'button', className: 'gbt-btn', onClick: function () { run('block', { id: task.id, note: noteValue() }) } }, t('block')))
			actions.push(h('button', { key: 'cancel', type: 'button', className: 'gbt-btn', 'data-variant': 'danger', onClick: function () { run('cancel', { id: task.id, note: noteValue() }) } }, t('cancel')))
		} else if (task.status === 'running') {
			actions.push(h('button', { key: 'edit', type: 'button', className: 'gbt-btn', onClick: function () { props.onEdit(task) } }, t('edit')))
			actions.push(h('button', { key: 'block', type: 'button', className: 'gbt-btn', onClick: function () { run('block', { id: task.id, note: noteValue() }) } }, t('block')))
			actions.push(h('button', { key: 'cancel', type: 'button', className: 'gbt-btn', 'data-variant': 'danger', onClick: function () { run('cancel', { id: task.id, note: noteValue() }) } }, t('cancel')))
		} else if (task.status === 'blocked') {
			actions.push(h('button', { key: 'retry', type: 'button', className: 'gbt-btn', 'data-variant': 'primary', onClick: function () { run('retry', { id: task.id }) } }, t('retry')))
			actions.push(h('button', { key: 'cancel', type: 'button', className: 'gbt-btn', onClick: function () { run('cancel', { id: task.id, note: noteValue() }) } }, t('cancel')))
		} else if (task.status === 'done') {
			actions.push(h('button', { key: 'reopen', type: 'button', className: 'gbt-btn', onClick: function () { run('reopen', { id: task.id }) } }, t('reopen')))
		} else if (task.status === 'cancelled') {
			actions.push(h('button', { key: 'reopen', type: 'button', className: 'gbt-btn', onClick: function () { run('reopen', { id: task.id }) } }, t('reopen')))
		}
		if (task.status !== 'running') {
			actions.push(h('button', { key: 'delete', type: 'button', className: 'gbt-btn', 'data-variant': 'danger', onClick: function () { remove(false) } }, t('delete')))
		}

		// ── stage spine: dispatch -> implement -> review -> test -> merge ──
		const stageOrder = ['pending', 'running', 'reviewing', 'testing', 'done']
		const stageKeys = ['stageDispatch', 'stageImplement', 'stageReview', 'stageTest', 'stageMerge']
		let reached = stageOrder.indexOf(task.status === 'blocked' || task.status === 'cancelled' ? 'pending' : task.status)
		if (task.status === 'blocked' || task.status === 'cancelled') {
			// blocked/cancelled interrupts the last stage the task really reached.
			history.forEach(function (entry) {
		if (typeof entry.from === 'string') reached = Math.max(reached, stageOrder.indexOf(entry.from))
		if (typeof entry.to === 'string') reached = Math.max(reached, stageOrder.indexOf(entry.to))
			})
			reached = Math.max(0, reached)
		}
		const interrupted = task.status === 'blocked' || task.status === 'cancelled'
		function historyAt(to) {
			const hit = history.filter(function (entry) { return entry.to === to && typeof entry.at === 'string' })[0]
			return hit === undefined ? null : hit.at
		}
		const reviewRounds = review === null ? history.filter(function (entry) { return entry.to === 'reviewing' }).length : Math.max(1, tcRound(review))
		const testRounds = test === null ? history.filter(function (entry) { return entry.to === 'testing' }).length : Math.max(1, tcRound(test))
		// Completion times: dispatch ends when the run starts, implement ends at the
		// review start, review ends at the test start, test/merge end at done/merge.at.
		const stageTimes = [
			historyAt('running'),
			historyAt('reviewing') === null && review !== null && typeof review.at === 'string' ? review.at : historyAt('reviewing'),
			historyAt('testing') === null && test !== null && typeof test.at === 'string' ? test.at : historyAt('testing'),
			historyAt('done') === null && merge !== null && typeof merge.at === 'string' ? merge.at : historyAt('done'),
			merge !== null && typeof merge.at === 'string' ? merge.at : historyAt('done'),
		]
		const stageRounds = [null, null, review === null ? null : reviewRounds, test === null ? null : testRounds, null]
		const interruptedReason = (function () {
			const hit = history.filter(function (entry) { return entry.to === 'blocked' || entry.to === 'cancelled' })[0]
			if (hit === undefined) return null
			return typeof hit.note === 'string' && hit.note !== '' ? hit.note : t(tcStatusKey(hit.to))
		})()
		const devStages = h(
			'div',
			{ className: 'gbt-detailstages', 'data-detail': 'stages', 'data-detail-stages': layout === 'single' ? 'wrap' : 'row' },
			stageOrder.map(function (statusKey, index) {
		const state = index < reached ? 'done' : index === reached ? (interrupted ? 'interrupted' : task.status === 'done' ? 'done' : 'active') : 'todo'
		const time = stageTimes[index]
		const rounds = stageRounds[index]
		return h(
			'div',
			{ key: statusKey, className: 'gbt-detailstage', 'data-stage': statusKey, 'data-state': state, 'data-rounds': rounds === null ? '' : String(rounds), 'data-at': time === null ? '' : String(time) },
			h('span', { className: 'gbt-detailstagebar' }),
			h('span', { className: 'gbt-detailstagelabel' }, h('b', null, t(stageKeys[index])), rounds === null ? null : ' · ' + String(rounds) + ' ' + t('roundUnit'), time === null ? null : h('span', { className: 'gbt-detailstagetime' }, new Date(time).toTimeString().slice(0, 5))),
		)
			}),
			interrupted ? h('div', { className: 'gbt-detailinterrupt', 'data-detail-interrupt': task.status }, t('interruptedAt') + ' ' + t(task.status === 'blocked' ? 'statusBlocked' : 'statusCancelled') + (interruptedReason === null ? '' : ' · ' + interruptedReason)) : null,
		)
		// T-132: the investigation spine is exactly 执行 → 交付. Review, test and
		// merge do not exist for it, so they are not rendered as empty stages.
		const runState = interrupted ? 'interrupted' : task.status === 'pending' ? 'todo' : task.status === 'running' ? 'active' : 'done'
		const deliverAt = report !== null && typeof report.createdAt === 'string' ? report.createdAt : historyAt('done')
		const investigationStages = h(
			'div',
			{ className: 'gbt-detailstages', 'data-detail': 'stages', 'data-detail-kind': 'investigate', 'data-detail-stages': layout === 'single' ? 'wrap' : 'row' },
			[
		{ key: 'run', label: t('stageRun'), state: runState, at: historyAt('running') },
		{ key: 'deliver', label: t('stageDeliver'), state: task.status === 'done' ? 'done' : 'todo', at: deliverAt },
			].map(function (stage) {
		return h(
			'div',
			{ key: stage.key, className: 'gbt-detailstage', 'data-stage': stage.key, 'data-state': stage.state, 'data-at': stage.at === null ? '' : String(stage.at) },
			h('span', { className: 'gbt-detailstagebar' }),
			h('span', { className: 'gbt-detailstagelabel' }, h('b', null, stage.label), stage.at === null ? null : h('span', { className: 'gbt-detailstagetime' }, new Date(stage.at).toTimeString().slice(0, 5))),
		)
			}),
			interrupted ? h('div', { className: 'gbt-detailinterrupt', 'data-detail-interrupt': task.status }, t('interruptedAt') + ' ' + t(task.status === 'blocked' ? 'statusBlocked' : 'statusCancelled') + (interruptedReason === null ? '' : ' · ' + interruptedReason)) : null,
		)
		const stages = investigate ? investigationStages : devStages

		// ── "where is it now": one row per phase conclusion ──
		const events = []
		const submissions = history.filter(function (entry) { return entry.to === 'reviewing' })
		const sha = typeof task.commit === 'string' && task.commit !== '' ? task.commit.slice(0, 7) : null
		if (investigate !== true) submissions.forEach(function (entry, index) {
			events.push(
		h(
			'div',
			{ key: 'sub-' + String(index), className: 'gbt-detailevent', 'data-detail-event': 'submit' },
			h('span', { className: 'gbt-detailpill', 'data-tone': 'ok' }, t('detailSubmitted')),
			h('b', null, t('stageImplement')),
			h('span', { className: 'gbt-detailwho' }, (entry.by === null || entry.by === undefined ? '—' : actorName(entry.by, entry.byName, entry.to === 'reviewing' ? 'actorRoleWorker' : entry.to === 'testing' ? 'actorRoleReviewer' : entry.from === 'testing' ? 'actorRoleTester' : 'actorRoleWorker')) + (submissions.length > 1 ? ' · ' + t('detailSubmitCount').replace('{n}', String(index + 1)) : '')),
			h('span', { className: 'gbt-detailwhen' }, new Date(entry.at).toTimeString().slice(0, 5)),
			sha === null ? null : h('div', { className: 'gbt-detailex gbt-mono' }, sha + ' · ' + t('detailFilesDeclared').replace('{n}', String(files.length)) + (actualFiles.length === 0 ? '' : ' = ' + t('detailFilesActual').replace('{n}', String(actualFiles.length)))),
		),
			)
		})
		if (investigate !== true && review !== null) {
			const reasons = typeof review.reasons === 'string' ? review.reasons : ''
			events.push(
		h(
			'div',
			{ key: 'review', className: 'gbt-detailevent', 'data-detail-event': 'review', 'data-review-status': String(review.status) },
			h('span', { className: 'gbt-detailpill', 'data-tone': review.status === 'approved' ? 'ok' : review.status === 'changes-requested' ? 'bad' : 'wait' }, tcReviewLabel(review.status, t)),
			h('b', null, t('stageReview')),
			h('span', { className: 'gbt-detailwho' }, actorName(review.by, review.byName, 'actorRoleReviewer') + ' · ' + t('detailRound').replace('{n}', String(tcRound(review)))),
			h('span', { className: 'gbt-detailwhen' }, new Date(review.at).toTimeString().slice(0, 5)),
			reasons === '' ? null : h('div', { className: review.status === 'changes-requested' ? 'gbt-detailreason' : 'gbt-detailreason good', 'data-detail-reason': String(review.status) }, reasons),
		),
			)
			if (review.status === 'changes-requested' && submissions.length > 0) {
		const later = submissions.filter(function (entry) { return new Date(entry.at).getTime() > new Date(review.at).getTime() }).slice(-1)[0]
		if (later !== undefined) {
			events.push(
				h(
			'div',
			{ key: 'resubmit', className: 'gbt-detailevent', 'data-detail-event': 'resubmit' },
			h('span', { className: 'gbt-detailpill', 'data-tone': 'ok' }, t('detailResubmitted')),
			h('b', null, t('detailFixSubmit')),
			h('span', { className: 'gbt-detailwho' }, (actorName(later.by) === '—' ? '' : actorName(later.by) + ' · ') + new Date(later.at).toTimeString().slice(0, 5)),
			sha === null ? null : h('span', { className: 'gbt-detailwhen gbt-mono' }, sha),
				),
			)
		}
			}
		}
		if (investigate !== true && test !== null) {
			const full = typeof test.evidence === 'string' ? test.evidence : ''
			const firstRaw = full === '' ? '' : full.split('\n')[0]
			const summaryLine = testSummaryText(test, review, t)
			events.push(
		h(
			'div',
			{ key: 'test', className: 'gbt-detailevent', 'data-detail-event': 'test', 'data-test-status': String(test.status) },
			h('span', { className: 'gbt-detailpill', 'data-tone': test.status === 'passed' ? 'ok' : 'bad' }, tcTestLabel(test.status, t)),
			h('b', null, t('stageTest')),
			h('span', { className: 'gbt-detailwho' }, actorName(test.by, test.byName, 'actorRoleTester') + ' · ' + t('detailRound').replace('{n}', String(tcRound(test)))),
			h('span', { className: 'gbt-detailwhen' }, new Date(test.at).toTimeString().slice(0, 5)),
			h('div', { className: 'gbt-detailex gbt-mono' }, summaryLine),
			evidenceOpen
				? h('pre', { className: 'gbt-detailpreview', 'data-detail-evidence': 'full' }, (function () {
				const lines = full.split('\n')
				return lines.slice(0, 40).join('\n') + (lines.length > 40 ? '\n… (' + String(lines.length - 40) + ')' : '')
			})())
				: null,
			full === '' ? null : h('button', { type: 'button', className: 'gbt-linkbtn', 'data-action': 'detail-evidence', onClick: function () { detailUiState.evidence = !evidenceOpen; setEvidenceOpen(!evidenceOpen) } }, evidenceOpen ? t('collapse') : t('viewFull')),
		),
			)
		}
		if (investigate !== true && merge !== null) {
			const mergeSha = typeof merge.mergeCommit === 'string' && merge.mergeCommit !== '' ? merge.mergeCommit : typeof merge.commit === 'string' && merge.commit !== '' ? merge.commit : null
			const commit = mergeSha === null ? sha : mergeSha.slice(0, 7)
			events.push(
		h(
			'div',
			{ key: 'merge', className: 'gbt-detailevent', 'data-detail-event': 'merge' },
			h('span', { className: 'gbt-detailpill', 'data-tone': merge.status === 'merged' ? 'ok' : 'wait' }, tcMergeLabel(merge.status, t)),
			h('b', null, t('stageMerge')),
			h('span', { className: 'gbt-detailwho' }, typeof merge.target === 'string' && merge.target !== '' ? '→ ' + merge.target : '—'),
			h('span', { className: 'gbt-detailwho' }, (function () { const actor = mergeActorOf(task); return actor === null ? '' : ' · ' + actorName(actor.by, actor.byName, 'statusActorHost') })()),
			h('span', { className: 'gbt-detailwhen' }, merge.at === null || merge.at === undefined ? '' : new Date(merge.at).toTimeString().slice(0, 5)),
			commit === null ? null : h('div', { className: 'gbt-detailex gbt-mono' }, commit + ' · ' + t('detailFilesDeclared').replace('{n}', String(files.length)) + (actualFiles.length === 0 ? '' : ' = ' + t('detailFilesActual').replace('{n}', String(actualFiles.length)))),
		),
			)
		}
		if (interrupted) {
			events.push(
		h(
			'div',
			{ key: 'interrupt', className: 'gbt-detailevent', 'data-detail-event': 'interrupt' },
			h('span', { className: 'gbt-detailpill', 'data-tone': 'bad' }, t(task.status === 'blocked' ? 'statusBlocked' : 'statusCancelled')),
			h('b', null, t('detailInterrupted')),
			h('span', { className: 'gbt-detailwho' }, interruptedReason === null ? '—' : interruptedReason),
		),
			)
		}
		// T-132: an investigation's only phase conclusion is the report itself.
		if (investigate === true) {
			events.unshift(
		h(
			'div',
			{ key: 'report', className: 'gbt-detailevent', 'data-detail-event': 'report', 'data-report-status': report === null ? 'missing' : 'delivered' },
			h('span', { className: 'gbt-detailpill', 'data-tone': report === null ? 'wait' : 'ok' }, report === null ? t('reportMissing') : t('reportDelivered')),
			h('b', null, t('stageDeliver')),
			h('span', { className: 'gbt-detailwho' }, report === null ? '—' : actorName(report.by, report.byName, 'actorRoleWorker') + (typeof report.createdAt === 'string' ? ' · ' + new Date(report.createdAt).toTimeString().slice(0, 5) : '')),
		),
			)
		}
		if (events.length === 0) events.push(h('p', { key: 'empty', className: 'gbt-footnote' }, t('detailNoEvents')))
		const eventsBody = h('div', { className: 'gbt-detailevents', 'data-detail': 'events' }, events)

		// ── summary column ──
		const finishedAt = merge !== null && typeof merge.at === 'string' ? merge.at : task.status === 'done' ? task.updatedAt : null
		const spanMs = Math.max(0, (finishedAt === null ? now : new Date(finishedAt).getTime()) - new Date(task.createdAt).getTime())
		const elapsedText = (function () {
			const minutes = Math.round(spanMs / 60000)
			if (minutes < 1) return String(Math.max(1, Math.round(spanMs / 1000))) + ' ' + t('detailSeconds')
			if (minutes < 60) return String(minutes) + ' ' + t('detailMinutes')
			return String(Math.floor(minutes / 60)) + ' ' + t('detailHours') + ' ' + String(minutes % 60) + ' ' + t('detailMinutes')
		})()
		// T-132: an investigation shows delivery status, never review/test rounds.
		const roundsLine = investigate
			? report === null
		? t('reportMissing')
		: t('reportDelivered') + (typeof report.createdAt === 'string' ? ' · ' + new Date(report.createdAt).toTimeString().slice(0, 5) : '')
			: t('stageReview') + ' ' + String(reviewRounds) + ' ' + t('roundUnit') + ' · ' + t('stageTest') + ' ' + String(testRounds) + ' ' + t('roundUnit')
		const compactSummary = h(
			'div',
			{ className: 'gbt-detailsummary gbt-detailsummary-one', 'data-detail': 'summary', 'data-detail-summary': 'one-line' },
			h('span', { className: 'gbt-detailstat' }, h('b', null, elapsedText), h('span', null, t('detailElapsed'))),
			h('span', { className: 'gbt-detailstatline' }, roundsLine),
		)
		const specToggle = h('button', { type: 'button', className: 'gbt-linkbtn', 'data-action': 'detail-spec', onClick: function () { detailUiState.spec = !specOpen; setSpecOpen(!specOpen) } }, specOpen ? t('collapse') : t('detailSpecExpand'))
		const specBody = specOpen
			? h(
			'div',
			{ 'data-detail-spec': 'full' },
			h('div', { className: 'gbt-subhead' }, t('spec')),
			h('p', { className: 'gbt-prose' }, task.spec === '' ? t('noSpec') : task.spec),
			h('div', { className: 'gbt-subhead' }, t('acceptance')),
			h('p', { className: 'gbt-prose' }, task.acceptance === '' ? t('noSpec') : task.acceptance),
		)
			: h('p', { className: 'gbt-footnote', 'data-detail-spec': 'collapsed' }, t('detailSpecHint'))
		const summaryFacts = investigate
			? h(
			'div',
			{ 'data-detail-facts': 'investigate' },
			h('div', { className: 'gbt-detailkv' }, h('span', null, t('kindLabel')), h('b', { 'data-detail-kind': 'investigate' }, t('kindInvestigate'))),
			h('div', { className: 'gbt-detailkv' }, h('span', null, t('reportTitle')), h('b', { 'data-detail-report-fact': report === null ? 'missing' : 'delivered' }, report === null ? t('reportMissing') : t('reportDelivered'))),
			report === null ? null : h('div', { className: 'gbt-detailkv' }, h('span', null, t('reportEvidence')), h('b', null, String(Array.isArray(report.evidence) ? report.evidence.length : 0))),
			h('div', { className: 'gbt-detailstatline' }, t('attempts') + ' ' + String(task.attempts) + '/' + String(task.maxAttempts)),
		)
			: h(
			'div',
			null,
			h('div', { className: 'gbt-detailkv' }, h('span', null, t('detailDeclaredFiles')), h('b', null, String(files.length)), h('span', null, t('detailActualFiles')), h('b', null, actualFiles.length === 0 ? '—' : String(actualFiles.length))),
			h('div', { className: 'gbt-detailkv' }, h('span', null, t('detailHostCheck')), h('b', { 'data-detail-hostcheck': 'true' }, task.verify === null || task.verify === undefined ? t('detailHostCheckUndeclared') : test !== null && typeof test.hostCheck === 'object' && test.hostCheck !== null ? (test.hostCheck.exitCode === 0 && test.hostCheck.timedOut !== true ? t('statusResultPassed') : t('detailHostCheckFailed')) : t('detailHostCheckIncomplete'))),
			h('div', { className: 'gbt-detailstatline' }, t('attempts') + ' ' + String(task.attempts) + '/' + String(task.maxAttempts)),
		)
		const fmtSpan = function (ms) {
			if (!Number.isFinite(ms) || ms < 0) return '—'
			const minutes = Math.round(ms / 60000)
			if (minutes < 1) return String(Math.max(1, Math.round(ms / 1000))) + 's'
			if (minutes < 60) return String(minutes) + ' ' + t('detailMinutes')
			return String(Math.floor(minutes / 60)) + ' ' + t('detailHours') + ' ' + String(minutes % 60) + ' ' + t('detailMinutes')
		}
		// review.at is the VERDICT time once decided (submit sets it as the phase start
		// before that), so the phase start for the queue wait comes from history.
		const reviewPhaseStart = (function () {
			const hist = Array.isArray(task.history) ? task.history : []
			const hit = hist.filter(function (entry) { return entry.to === 'reviewing' && typeof entry.at === 'string' }).slice(-1)[0]
			if (hit !== undefined) return new Date(hit.at).getTime()
			return review !== null && review.status === 'pending' && typeof review.at === 'string' ? new Date(review.at).getTime() : null
		})()
		const reviewMs = review !== null && review.status !== 'pending' && typeof review.at === 'string' && typeof review.deliveredAt === 'string' ? new Date(review.at).getTime() - new Date(review.deliveredAt).getTime() : null
		const testMs = test !== null && test.status !== 'pending' && typeof test.at === 'string' && typeof test.deliveredAt === 'string' ? new Date(test.at).getTime() - new Date(test.deliveredAt).getTime() : null
		const queueStart = reviewPhaseStart
		const queueEnd = review !== null && typeof review.deliveredAt === 'string' ? new Date(review.deliveredAt).getTime() : Number.isFinite(task.queuePosition) && task.queuePosition > 0 ? now : null
		const queueMs = queueStart === null || queueEnd === null ? null : queueEnd - queueStart
		const metricParts = []
		if (reviewMs !== null) metricParts.push(t('stageReview') + ' ' + fmtSpan(reviewMs))
		if (testMs !== null) metricParts.push(t('stageTest') + ' ' + fmtSpan(testMs))
		if (queueMs !== null) metricParts.push(t('detailQueueWait') + ' ' + fmtSpan(queueMs))
		const metricsNode = metricParts.length === 0 ? null : h('div', { className: 'gbt-detailstatline', 'data-detail-metrics': 'true' }, metricParts.join(' · '))
		const summary = h(
			'div',
			{ className: 'gbt-detailsummary', 'data-detail': 'summary', 'data-detail-summary': 'full' },
			h('div', { className: 'gbt-detailstat' }, h('b', null, elapsedText), h('span', null, t('detailElapsed'))),
			h('div', { className: 'gbt-detailstatline' }, roundsLine, ' · ', t('attempts') + ' ' + String(task.attempts) + '/' + String(task.maxAttempts)),
			investigate ? null : metricsNode,
			// T-132: a done investigation has no target/merge progress to show.
			investigate
		? null
		: h('div', { className: 'gbt-detailstatline', 'data-detail-target': 'true' }, t('targetBranch') + ': ' + (typeof task.target === 'string' && task.target !== '' ? task.target : t('targetDefaultLabel')) + (typeof task.base === 'string' && task.base !== '' ? ' · ' + String(task.base).slice(0, 10) + ' → ' + (typeof task.target === 'string' && task.target !== '' ? task.target : t('targetDefaultLabel')) : '')),
			summaryFacts,
		)
		// In the single-column layout the elapsed/rounds move into the one-line
		// card, so the details card keeps only files/host-check/attempts/spec.
		const summaryDetails = h(
			'div',
			{ className: 'gbt-detailsummary', 'data-detail': 'summary', 'data-detail-summary': 'details' },
			summaryFacts,
		)

		// T-144: the delivered report is the investigation's product; the casebook renders
		// it in full (safe Markdown) with the evidence appendix after the body.
		const reportFileLine = t('reportFullHint').replace('{id}', task.id)
		const reportInner =
			report === null
		? h('p', { className: 'gbt-footnote', 'data-detail-report': 'missing' }, t('reportInvestigateHint'))
		: h(
			'div',
			{ className: 'gbt-reportcontent' },
			h('div', { className: 'gbt-subhead' }, t('reportSummary')),
			h('p', { className: 'gbt-prose', 'data-detail-report': 'summary' }, String(report.summary)),
			typeof report.body !== 'string' || report.body === ''
				? null
				: h(
			'div',
			null,
			h('div', { className: 'gbt-subhead' }, t('reportBody')),
			h('div', { className: 'gbt-reportbody', 'data-detail-report': 'body', 'data-report-format': 'markdown' }, tcReportBlocks(String(report.body))),
				),
			Array.isArray(report.evidence) && report.evidence.length > 0
				? h(
			'div',
			null,
			h('div', { className: 'gbt-subhead' }, t('reportEvidence')),
			h(
				'table',
				{ className: 'gbt-reporttable', 'data-detail-report': 'evidence' },
				h('thead', null, h('tr', null, h('th', null, t('reportCommand')), h('th', null, t('reportExit')), h('th', null, t('reportTail')))),
				h(
					'tbody',
					null,
					report.evidence.map(function (row, index) {
				return h(
					'tr',
					{ key: String(index), 'data-evidence-row': String(index) },
					h('td', { className: 'gbt-mono', 'data-evidence-command': 'true' }, String(row.command === undefined || row.command === null ? '' : row.command)),
					h('td', { 'data-evidence-exit': 'true' }, row.exitCode === undefined || row.exitCode === null ? '—' : String(row.exitCode)),
					h('td', null, h('pre', { className: 'gbt-reporttail' }, String(row.outputTail === undefined || row.outputTail === null ? '' : row.outputTail))),
				)
					}),
				),
			),
				)
			: null,
			Array.isArray(report.artifacts) && report.artifacts.length > 0
				? h(
			'div',
			null,
			h('div', { className: 'gbt-subhead' }, t('reportArtifacts')),
			h('ul', { className: 'gbt-reportartifacts', 'data-detail-report': 'artifacts' }, report.artifacts.map(function (path) { return h('li', { key: path, className: 'gbt-mono' }, String(path)) })),
				)
			: null,
			Array.isArray(report.probeCommits) && report.probeCommits.length > 0
				? h('p', { className: 'gbt-footnote', 'data-detail-report': 'probe-commits' }, t('reportProbeCommits') + ' ' + report.probeCommits.join(', '))
				: null,
			h('div', { className: 'gbt-casefile', 'data-report-file': 'paper' }, reportFileLine),
		)
		const reportPaper = h(
			'article',
			{ className: 'gbt-casepaper gbt-reportcard', 'data-detail-card': 'report', 'data-detail-report-card': report === null ? 'missing' : 'delivered', 'data-report-id': task.id },
			h(
		'div',
		{ className: 'gbt-detailcardhead' },
		t('reportTitle'),
		h('span', { className: 'gbt-pill', 'data-report-status': report === null ? 'missing' : 'delivered', 'data-kind': 'investigate' }, report === null ? t('reportMissing') : t('reportDelivered')),
			),
			reportInner,
		)
		const caseFacts = h(
			'dl',
			{ className: 'gbt-casefacts', 'data-detail-index': 'facts' },
			h('dt', null, t('casebookStatus')),
			h('dd', null, h('span', { className: 'gbt-pill', 'data-status': task.status }, tcPhaseLabel(task, t))),
			h('dt', null, t('casebookKind')),
			h('dd', null, t('kindInvestigate')),
			h('dt', null, t('casebookProject')),
			h('dd', { className: 'gbt-mono' }, typeof snapshot.project === 'string' && snapshot.project !== '' ? snapshot.project : '—'),
			h('dt', null, t('casebookExecutor')),
			h('dd', null, task.assignee !== null && task.assignee !== undefined ? actorName(task.assignee.name) : '—'),
			h('dt', null, t('casebookBase')),
			h('dd', { className: 'gbt-mono' }, typeof task.base === 'string' && task.base !== '' ? String(task.base).slice(0, 10) : '—'),
			h('dt', null, t('casebookTarget')),
			h('dd', { className: 'gbt-mono' }, typeof task.target === 'string' && task.target !== '' ? task.target : t('targetDefaultLabel')),
			h('dt', null, t('casebookElapsed')),
			h('dd', null, elapsedText),
			h('dt', null, t('casebookDelivered')),
			h('dd', null, deliverAt === null ? '—' : String(deliverAt).replace('T', ' ').slice(0, 16)),
			h('dt', null, t('casebookReportFile')),
			h('dd', { className: 'gbt-casefile', 'data-report-file': 'index' }, reportFileLine),
		)
		const caseIndex = h(
			'aside',
			{ className: 'gbt-caseindex', 'data-detail-index': 'casebook' },
			h(
		'div',
		{ className: 'gbt-caseindexhead' },
		h('span', { className: 'gbt-id gbt-mono' }, task.id),
		h('span', { className: 'gbt-pill', 'data-status': task.status }, tcPhaseLabel(task, t)),
		h('span', { className: 'gbt-pill', 'data-kind': 'investigate' }, t('kindInvestigate')),
			),
			h('div', { className: 'gbt-subhead' }, t('casebookIndex')),
			caseFacts,
			h('div', { className: 'gbt-subhead' }, t('casebookTimeline')),
			eventsBody,
		)
		const casebook = h('div', { key: 'casebook', className: 'gbt-casebook', 'data-detail': 'casebook', 'data-detail-layout': 'casebook' }, caseIndex, reportPaper)

		const allFields = h(
			'details',
			{ key: 'fields', className: 'gbt-section gbt-detailallfields', 'data-detail-allfields': 'true' },
			h('summary', null, t('detailAllFields')),
			h(
				'dl',
				{ className: 'gbt-meta' },
				h('dt', null, t('priority')),
				h('dd', null, String(task.priority)),
				h('dt', null, t('assignee')),
				h('dd', null, task.assignee !== null && task.assignee !== undefined ? actorName(task.assignee.name) : '—'),
				h('dt', null, t('attempts')),
				h('dd', null, String(task.attempts) + ' / ' + String(task.maxAttempts)),
				h('dt', null, t('created')),
				h('dd', null, tcAgo(task.createdAt, now)),
				h('dt', null, t('updated')),
				h('dd', null, tcAgo(finishedAt === null ? task.updatedAt : finishedAt, now)),
				h('dt', null, t('phaseCurrent')),
				h('dd', null, h('span', { className: 'gbt-pill', 'data-status': task.status }, tcPhaseLabel(task, t))),
				h('dt', null, t('requiredRole')),
				h('dd', null, typeof task.requiredRole === 'string' && task.requiredRole !== '' ? task.requiredRole : '—'),
				h('dt', null, t('worktree')),
				h('dd', null, typeof task.worktree === 'string' && task.worktree !== '' ? task.worktree : '—'),
				h('dt', null, t('branch')),
				h('dd', null, typeof task.branch === 'string' && task.branch !== '' ? task.branch : '—'),
				h('dt', null, t('commit')),
				h('dd', null, typeof task.commit === 'string' && task.commit !== '' ? task.commit : '—'),
			),
			h('div', { className: 'gbt-subhead' }, t('dependencies')),
			deps.length === 0 ? h('p', { className: 'gbt-footnote' }, t('noDeps')) : h('div', { className: 'gbt-cardmeta' }, deps.map(function (id) {
				const dependency = allTasks.filter(function (entry) { return entry.id === id })[0]
				return h('span', { key: id, className: 'gbt-chip', 'data-tone': toneForDependency(allTasks, id) }, dependency === undefined ? id + ' · ' + t('depBroken') : id + ' · ' + t(tcStatusKey(dependency.status)))
			})),
			h('div', { className: 'gbt-subhead' }, t('files')),
			files.length === 0 ? h('p', { className: 'gbt-footnote' }, t('noFiles')) : h('div', { className: 'gbt-cardmeta' }, files.map(function (path) {
				return h('span', { key: path, className: 'gbt-chip', 'data-tone': held.indexOf(path) >= 0 ? 'running' : 'waiting' }, (held.indexOf(path) >= 0 ? '🔒 ' : '') + path)
			})),
			dispatch === null
				? null
				: h(
				'div',
				null,
				h('div', { className: 'gbt-subhead' }, t('dispatch')),
				h('dl', { className: 'gbt-meta' }, h('dt', null, t('status')), h('dd', null, String(dispatch.status === null || dispatch.status === undefined ? '—' : dispatch.status)), h('dt', null, t('assignee')), h('dd', null, String(dispatch.target === null || dispatch.target === undefined ? '—' : dispatch.target)), dispatch.error === null || dispatch.error === undefined || dispatch.error === '' ? null : h('dt', null, t('dispatchError')), dispatch.error === null || dispatch.error === undefined || dispatch.error === '' ? null : h('dd', { 'data-dispatch-error': 'true' }, String(dispatch.error))),
				(function () {
					const targetSession = dispatch.targetId !== null && dispatch.targetId !== undefined ? dispatch.targetId : dispatch.leadSession
					return task.ownerSession !== null && task.ownerSession !== undefined && targetSession !== null && targetSession !== undefined && task.ownerSession !== targetSession
						? h('p', { className: 'gbt-footnote', 'data-owner-mismatch': 'true' }, t('ownerMismatch').replace('{owner}', String(task.ownerSession)).replace('{target}', String(targetSession)))
						: null
				})(),
			),
		)
		const specCard = h('section', { className: 'gbt-detailcard gbt-detailspec', 'data-detail-card': 'spec', 'data-detail-spec-card': 'true' },
			h('div', { className: 'gbt-detailcardhead' }, h('span', null, t('detailSpecTitle')), specToggle),
			h('div', { className: 'gbt-detailspecbody' }, specBody))
		const historyCard = h('section', { className: 'gbt-detailcard gbt-detailhistory', 'data-detail-card': 'history' },
			h('div', { className: 'gbt-detailcardhead' }, t('history')),
			h('div', { className: 'gbt-detailcardbody' }, history.length === 0 ? h('p', { className: 'gbt-footnote' }, t('emptyHistory')) : h('div', { className: 'gbt-timeline' }, history.slice().reverse().map(function (entry, index) {
				return h('div', { key: String(index), className: 'gbt-event' }, h('span', { className: 'gbt-mono' }, tcAgo(entry.at, now)), ' ', h('b', null, actorName(entry.by)), ' ', h('span', null, (entry.from === null ? '·' : entry.from) + ' → ' + (entry.to === null ? '·' : entry.to) + (typeof entry.note === 'string' && entry.note !== '' ? ' · ' + entry.note : '')))
			}))))
		const eventsCard = h('section', { className: 'gbt-detailcard', 'data-detail-card': 'events' }, h('div', { className: 'gbt-detailcardhead' }, t('detailWhereNow')), eventsBody)
		const mainChildren = [stages]
		if (investigate) mainChildren.push(casebook, specCard, historyCard)
		else mainChildren.push(eventsCard, specCard, historyCard)
		if (task.status === 'running' && investigate !== true) {
			mainChildren.push(h('section', { key: 'work', className: 'gbt-section gbt-detailwork' }, h('h3', null, t('evidence')), h('textarea', { className: 'gbt-area', ref: evidence, placeholder: t('evidence') }), h('div', { className: 'gbt-actions', style: { marginTop: '6px' } }, h('button', { type: 'button', className: 'gbt-btn', 'data-variant': 'primary', onClick: submitWork }, t('submit')))))
		}
		const mainCol = h('div', { className: 'gbt-detailmain', 'data-detail-main': 'true' }, mainChildren)
		const asideCol = h('aside', { className: 'gbt-detailaside', 'data-detail-aside': 'true' }, layout === 'single' ? null : summary, allFields)
		const detailBody = h('div', { className: 'gbt-detailbody', 'data-detail-body': layout, 'data-detail-layout': layout },
			layout === 'single' ? compactSummary : null,
			mainCol,
			layout === 'single' ? summaryDetails : null,
			asideCol)
		const needsNote = task.status === 'pending' || task.status === 'running' || task.status === 'blocked'
		const noteField = needsNote
			? h('label', { className: 'gbt-detailnote', 'data-detail-note': 'true' }, h('span', null, t('detailActionNote')), h('input', { className: 'gbt-input', 'data-field': 'note', ref: note, placeholder: t('notePlaceholder') }))
			: null
		const actionFooter = h('div', { className: 'gbt-detailfooter', 'data-detail-footer': 'true' },
			noteField,
			h('div', { className: 'gbt-actions' }, actions, deleteError === 'referenced' ? h('button', { key: 'force', type: 'button', className: 'gbt-btn', 'data-variant': 'danger', onClick: function () { remove(true) } }, t('forceDelete')) : null),
			deleteError === 'referenced' ? h('p', { className: 'gbt-footnote' }, t('forceHint')) : null,
			deleteError === 'failed' ? h('p', { className: 'gbt-footnote' }, t('error')) : null)
		const blocks = [detailBody]
		return h(
			'div',
			{ className: 'gbt-detailoverlay', 'data-detail-overlay': 'true', 'data-detail-width': widthClass, 'data-detail-layout': layout,
		onKeyDown: function (event) { if (event !== null && event !== undefined && event.key === 'Escape') props.onClose() } },
			h('div', { className: 'gbt-detailmask', 'data-detail-mask': 'true', onClick: function () { props.onClose() } }),
			h(
		'section',
		{ className: 'gbt-detailpanel', 'role': 'dialog', 'aria-modal': 'true', tabIndex: -1 },
			h(
		'div',
		{ className: 'gbt-drawerhead' },
		h(
			'div',
			{ className: 'gbt-detailhead' },
			h('div', { className: 'gbt-cardmeta' }, h('span', { className: 'gbt-id' }, task.id), h('span', { className: 'gbt-pill', 'data-status': task.status }, t(tcStatusKey(task.status))), investigate ? h('span', { className: 'gbt-pill', 'data-kind': 'investigate', title: t('kindInvestigateHint') }, t('kindInvestigate')) : null, Number.isFinite(task.queuePosition) && task.queuePosition > 0 ? h('span', { className: 'gbt-pill', 'data-queue': String(task.queuePosition) }, t('queuedChip').replace('{n}', String(task.queuePosition))) : null, waitingChip(task, t, 'waiting')),
			h('h2', { className: 'gbt-drawertitle' }, task.title),
			h('div', { className: 'gbt-detailmeta' }, h('span', null, t('assignee') + ' ' + (task.assignee === null || task.assignee === undefined ? '—' : task.assignee.name)), h('span', { className: 'gbt-detailspan' }, new Date(task.createdAt).toTimeString().slice(0, 5) + ' → ' + (finishedAt === null ? t('detailNow') : new Date(finishedAt).toTimeString().slice(0, 5)) + ' · ' + elapsedText)),
		),
		h('button', { type: 'button', className: 'gbt-iconbtn', onClick: props.onClose, 'aria-label': t('close') }, '×'),
			),
			h('div', { className: 'gbt-drawerbody' }, blocks),
			actionFooter,
			),
		)
	}


	return DetailView
}

module.exports = { createDetailView }

				})(module, module.exports)
				const factory = module.exports.createDetailView
				return factory({
					React: React,
					h: h,
					detailUiState: detailUiState,
					actorDisplay: actorDisplay,
					mergeActorOf: mergeActorOf,
					tcAgentTreeOf: tcAgentTreeOf,
					testSummaryText: testSummaryText,
					toneForDependency: toneForDependency,
					waitingChip: waitingChip,
					tcAgo: tcAgo,
					tcIsInvestigation: tcIsInvestigation,
					tcMergeLabel: tcMergeLabel,
					tcMergeOf: tcMergeOf,
					tcPhaseLabel: tcPhaseLabel,
					tcReportBlocks: tcReportBlocks,
					tcReviewLabel: tcReviewLabel,
					tcReviewOf: tcReviewOf,
					tcRound: tcRound,
					tcStatusKey: tcStatusKey,
					tcTestLabel: tcTestLabel,
					tcTestOf: tcTestOf,
					agentSidebar: agentSidebar,
				})
			})()

			const TaskForm = (function () {
				const module = { exports: {} }
				;(function (module, exports) {
/**
 * Task create/edit form view module.
 *
 * Extracted from the forms fragment; React, h, Modal, list/error helpers and
 * the panel store are injected by the build.
 */
function createTaskForm(deps) {
	const React = deps.React
	const h = deps.h
	const Modal = deps.Modal
	const tcParseList = deps.tcParseList
	const tcParseFiles = deps.tcParseFiles
	const tcErrorMessage = deps.tcErrorMessage
	const store = deps.store

	function TaskForm(props) {
		const t = props.t
		const task = props.task
		const title = React.useRef(null)
		const spec = React.useRef(null)
		const acceptance = React.useRef(null)
		const priority = React.useRef(null)
		const deps = React.useRef(null)
		const files = React.useRef(null)
		const note = React.useRef(null)
		const targetBranch = React.useRef(null)
		const [busy, setBusy] = React.useState(false)
		const [error, setError] = React.useState('')
		const running = task !== null && task.status === 'running'
		const suggestions = props.snapshot.tasks.filter(function (entry) {
			return task === null || entry.id !== task.id
		})

		function appendDependency(id) {
			if (deps.current === null) return
			const current = String(deps.current.value || '')
			const present = tcParseList(current)
			if (present.indexOf(id) >= 0) return
			deps.current.value = present.concat([id]).join(', ')
		}

		function save() {
			const value = title.current === null ? '' : String(title.current.value || '').trim()
			if (value === '') {
		setError(t('titleRequired'))
		return
			}
			const body = {
		title: value,
		spec: spec.current === null ? '' : String(spec.current.value || ''),
		acceptance: acceptance.current === null ? '' : String(acceptance.current.value || ''),
		priority: priority.current === null ? 0 : Number(priority.current.value || 0),
		// Empty clears back to the project default; a name pins this task's target.
		target: targetBranch.current === null ? '' : String(targetBranch.current.value || '').trim(),
			}
			if (!running) {
		body.dependsOn = tcParseList(deps.current === null ? '' : deps.current.value)
		body.writeFiles = tcParseFiles(files.current === null ? '' : files.current.value)
			}
			if (note.current !== null && String(note.current.value || '').trim() !== '') body.note = String(note.current.value).trim()
			setBusy(true)
			setError('')
			const action = task === null ? 'create' : 'update'
			if (task !== null) body.id = task.id
			void store.send(action, body).then(function (result) {
		setBusy(false)
		if (result.ok === true) {
			props.onSaved()
			return
		}
		const payload = result.payload === undefined || result.payload === null ? {} : result.payload
		setError(result.payload !== undefined && result.payload !== null ? tcErrorMessage(result.payload, t) : String((result.error && result.error.message) || t('error')))
			})
		}

		return h(
			Modal,
			{ title: task === null ? t('newTask') : t('edit'), onClose: props.onClose, t: t },
			h(
		'div',
		{ className: 'gbt-form' },
		h('div', { className: 'gbt-field' }, h('label', null, t('taskTitle')), h('input', { className: 'gbt-input', ref: title, defaultValue: task === null ? '' : task.title, placeholder: t('titleRequired') })),
		h('div', { className: 'gbt-row2' },
			h('div', { className: 'gbt-field' }, h('label', null, t('priority')), h('input', { className: 'gbt-input', ref: priority, type: 'number', defaultValue: task === null ? 0 : task.priority }))),
		h('div', { className: 'gbt-field' }, h('label', null, t('spec')), h('textarea', { className: 'gbt-area', ref: spec, defaultValue: task === null ? '' : task.spec })),
		h('div', { className: 'gbt-field' }, h('label', null, t('acceptance')), h('textarea', { className: 'gbt-area', ref: acceptance, defaultValue: task === null ? '' : task.acceptance })),
		h('div', { className: 'gbt-field' },
			h('label', null, t('dependencies')),
			h('input', { className: 'gbt-input', ref: deps, defaultValue: task === null ? '' : (task.dependsOn || []).join(', '), placeholder: t('dependsPlaceholder'), disabled: running }),
			running ? null : h('div', { className: 'gbt-cardmeta' }, suggestions.slice(0, 12).map(function (entry) { return h('button', { key: entry.id, type: 'button', className: 'gbt-chip', onClick: function () { appendDependency(entry.id) } }, entry.id + ' · ' + entry.title) }))),
		h('div', { className: 'gbt-field' }, h('label', null, t('files')), h('textarea', { className: 'gbt-area', ref: files, defaultValue: task === null ? '' : (task.writeFiles || []).join('\n'), placeholder: t('filesPlaceholder'), disabled: running })),
		h('div', { className: 'gbt-field' }, h('label', null, t('targetBranch')), h('input', { className: 'gbt-input', ref: targetBranch, 'data-field': 'target-branch', defaultValue: task === null || typeof task.target !== 'string' ? '' : task.target, placeholder: t('targetFollowDefault') })),
		h('div', { className: 'gbt-field' }, h('label', null, t('note')), h('input', { className: 'gbt-input', ref: note, placeholder: t('notePlaceholder') })),
		error === '' ? null : h('p', { className: 'gbt-footnote', style: { color: 'var(--dsw-alias-state-error-primary)' } }, error),
		h('div', { className: 'gbt-actions' },
			h('button', { type: 'button', className: 'gbt-btn', 'data-variant': 'primary', disabled: busy, onClick: save }, task === null ? t('create') : t('update')),
			h('button', { type: 'button', className: 'gbt-btn', onClick: props.onClose }, t('cancel'))),
			),
		)
	}


	return TaskForm
}

module.exports = { createTaskForm }

				})(module, module.exports)
				const factory = module.exports.createTaskForm
				return factory({
					React: React,
					h: h,
					Modal: Modal,
					tcParseList: tcParseList,
					tcParseFiles: tcParseFiles,
					tcErrorMessage: tcErrorMessage,
					store: store,
				})
			})()

			const SettingsForm = (function () {
				const module = { exports: {} }
				;(function (module, exports) {
/**
 * Settings form view module.
 *
 * Extracted from the forms fragment; React, h and the panel store are injected
 * by the build.
 *
 * Dispatch has ONE capacity knob: maxConcurrent. A card's executor is started
 * for the card and released afterwards; there is no persistent worker ceiling.
 *
 * T-198 adds the DECISION POLICY editor (关键决策设置): one row per host event with
 * its mode (ask / notify / silent), default option, answer timeout, consecutive
 * limit and auto-recovery limit. The scope tabs switch between the user-wide
 * global default and this project's override; "恢复默认" clears the override in
 * the current scope. The fixed high-risk guards are rendered as disabled
 * checkboxes: the server enforces them, the panel only states them.
 *
 * T-205: this module no longer draws the modal shell. It renders the body of the
 * settings PAGE as one hidden/shown section per theme (常规 / 派发 / 重试 /
 * 关键决策 / Godot 引擎); the page owns the title, the left navigation, the
 * scrolling right column and the save/cancel footer. Keeping every section
 * MOUNTED (hidden, not unmounted) is deliberate: a half-typed field survives a
 * trip to another theme.
 *
 * The save/cancel footer lives in the page, so the component publishes its
 * save action on SettingsForm.actions. The action returns a promise resolving
 * { ok, error? } instead of closing anything: a page stays where it is.
 *
 * The event list below mirrors plugin/task-center/schema.mjs DECISION_EVENT_CATALOG;
 * client-settings-form.test.mjs compares the two so they cannot drift.
 */
function createSettingsForm(deps) {
	const React = deps.React
	const h = deps.h
	const store = deps.store

	/** The config field the engine-path section edits, as the host Config declares it. */
	const ENGINE_FIELD = 'godotPath'

	const DECISION_MODES = ['ask', 'notify', 'silent']

	// One entry per host event, in the aligned copy order (packet §5).
	const DECISION_EVENT_VIEWS = [
		{ key: 'create', labelKey: 'decisionEvent_create', options: [{ id: 'create', labelKey: 'decisionOpt_create_create' }, { id: 'cancel', labelKey: 'decisionOpt_create_cancel' }] },
		{
			key: 'dispatch',
			labelKey: 'decisionEvent_dispatch',
			options: [
				{ id: 'approve', labelKey: 'decisionOpt_dispatch_approve' },
				{ id: 'hold', labelKey: 'decisionOpt_dispatch_hold' },
				{ id: 'withdraw', labelKey: 'decisionOpt_dispatch_withdraw' },
			],
		},
		{
			key: 'dev-timeout',
			labelKey: 'decisionEvent_dev_timeout',
			options: [
				{ id: 'continue', labelKey: 'decisionOpt_dev_timeout_continue' },
				// Destructive options are NEVER a policy default (the server refuses
				// them); the row still shows them so the option list mirrors the modal.
				{ id: 'retry-dev', labelKey: 'decisionOpt_dev_timeout_retry_dev', noDefault: true },
				{ id: 'cancel', labelKey: 'decisionOpt_dev_timeout_cancel' },
				{ id: 'cancel-tree', labelKey: 'decisionOpt_dev_timeout_cancel_tree', noDefault: true },
			],
		},
		{
			key: 'review-timeout',
			labelKey: 'decisionEvent_review_timeout',
			options: [
				{ id: 'continue', labelKey: 'decisionOpt_review_timeout_continue' },
				{ id: 'replace', labelKey: 'decisionOpt_review_timeout_replace' },
				{ id: 'block', labelKey: 'decisionOpt_review_timeout_block' },
				{ id: 'cancel', labelKey: 'decisionOpt_review_timeout_cancel' },
			],
		},
		{
			key: 'test-timeout',
			labelKey: 'decisionEvent_test_timeout',
			options: [
				{ id: 'continue', labelKey: 'decisionOpt_test_timeout_continue' },
				{ id: 'replace', labelKey: 'decisionOpt_test_timeout_replace' },
				{ id: 'block', labelKey: 'decisionOpt_test_timeout_block' },
				{ id: 'cancel', labelKey: 'decisionOpt_test_timeout_cancel' },
			],
		},
		{
			key: 'reopen',
			labelKey: 'decisionEvent_reopen',
			options: [
				{ id: 'reopen', labelKey: 'decisionOpt_reopen_reopen' },
				{ id: 'keep', labelKey: 'decisionOpt_reopen_keep' },
			],
		},
		{
			key: 'delete',
			labelKey: 'decisionEvent_delete',
			// The delete guard: the mode is fixed to ask (the server refuses to store
			// anything else), so the select is disabled but still shows the truth.
			fixedMode: 'ask',
			options: [
				{ id: 'keep', labelKey: 'decisionOpt_delete_keep' },
				{ id: 'delete', labelKey: 'decisionOpt_delete_delete', noDefault: true },
			],
		},
		{
			key: 'cancel',
			labelKey: 'decisionEvent_cancel',
			options: [
				{ id: 'return', labelKey: 'decisionOpt_cancel_return' },
				{ id: 'confirm', labelKey: 'decisionOpt_cancel_confirm' },
			],
		},
		{
			key: 'host-verify-fail',
			labelKey: 'decisionEvent_host_verify_fail',
			options: [
				{ id: 'return-dev', labelKey: 'decisionOpt_host_verify_fail_return_dev' },
				{ id: 'block', labelKey: 'decisionOpt_host_verify_fail_block' },
				{ id: 'cancel', labelKey: 'decisionOpt_host_verify_fail_cancel' },
			],
		},
		{
			key: 'merge-conflict',
			labelKey: 'decisionEvent_merge_conflict',
			options: [
				{ id: 'return-dev', labelKey: 'decisionOpt_merge_conflict_return_dev' },
				{ id: 'block', labelKey: 'decisionOpt_merge_conflict_block' },
				{ id: 'cancel', labelKey: 'decisionOpt_merge_conflict_cancel' },
			],
		},
		{
			key: 'worker-lost',
			labelKey: 'decisionEvent_worker_lost',
			options: [
				{ id: 'redispatch', labelKey: 'decisionOpt_worker_lost_redispatch' },
				{ id: 'block', labelKey: 'decisionOpt_worker_lost_block' },
				{ id: 'cancel', labelKey: 'decisionOpt_worker_lost_cancel' },
			],
		},
		{
			key: 'target-drift',
			labelKey: 'decisionEvent_target_drift',
			options: [
				{ id: 'rebuild-retest', labelKey: 'decisionOpt_target_drift_rebuild_retest' },
				{ id: 'block', labelKey: 'decisionOpt_target_drift_block' },
				{ id: 'cancel', labelKey: 'decisionOpt_target_drift_cancel' },
			],
		},
		{
			key: 'review-rounds-exhausted',
			labelKey: 'decisionEvent_review_rounds_exhausted',
			options: [
				{ id: 'block', labelKey: 'decisionOpt_review_rounds_exhausted_block' },
				{ id: 'cancel', labelKey: 'decisionOpt_review_rounds_exhausted_cancel' },
			],
		},
	]

	const SECTION_KEYS = ['general', 'dispatch', 'retry', 'decisions', 'engine']

	// One drafts/baseline/resets bundle PER MOUNTED FORM, keyed by React.useId().
	// The page explicitly allows the panel page and the plugin card to be mounted
	// in the same document, so a module-scoped bundle would let the unsaved drafts
	// of one page leak into the other. The entry is dropped when the form unmounts.
	const policyStates = new Map()

	function policyStateOf(instanceId) {
		let state = policyStates.get(instanceId)
		if (state === undefined) {
			state = { signature: null, scope: 'project', drafts: { global: null, project: null }, baseline: { global: null, project: null }, resets: { global: {}, project: {} } }
			policyStates.set(instanceId, state)
		}
		return state
	}

	// The page's footer drives this: each render publishes the current save
	// closure (it owns the input refs and this instance's drafts). The page also
	// passes its own actions object; this registry is the direct-test seam.
	const formActions = { save: null }

	function rowOf(policy, scope, key) {
		const bucket = policy === null || policy === undefined ? null : scope === 'global' ? policy.global : policy.project
		const row = bucket !== null && bucket !== undefined ? bucket[key] : undefined
		if (row === undefined || row === null) return { mode: 'ask', defaultOption: '', timeoutSeconds: 120, limit: null, autoRecover: null }
		return row
	}

	function rowCopy(row) {
		return {
			mode: row.mode,
			defaultOption: row.defaultOption,
			// null = "the built-in fallback" (a notify event shows an empty field, as
			// the packet's "—"); 0 keeps its meaning: no deadline.
			timeoutSeconds: Number.isFinite(row.timeoutSeconds) ? row.timeoutSeconds : null,
			limit: row.limit === undefined ? null : row.limit,
			autoRecover: row.autoRecover === undefined ? null : row.autoRecover,
		}
	}

	function policySignature(policy) {
		if (policy === null || policy === undefined || typeof policy !== 'object') return 'none'
		return JSON.stringify({ global: policy.overrides === undefined ? null : policy.overrides.global, project: policy.overrides === undefined ? null : policy.overrides.project })
	}

	function ensureState(state, policy) {
		const signature = policySignature(policy)
		if (state.signature === signature && state.drafts.project !== null) return
		state.signature = signature
		state.drafts = { global: {}, project: {} }
		state.baseline = { global: {}, project: {} }
		state.resets = { global: {}, project: {} }
		for (const scope of ['global', 'project']) {
			for (const view of DECISION_EVENT_VIEWS) {
				const copy = rowCopy(rowOf(policy, scope, view.key))
				state.drafts[scope][view.key] = copy
				state.baseline[scope][view.key] = Object.assign({}, copy)
			}
		}
	}

	/** What this scope inherits once its own override is cleared. */
	function inheritedRow(policy, scope, key) {
		if (scope === 'project') return rowCopy(rowOf(policy, 'global', key))
		const defaults = policy !== null && policy !== undefined && policy.defaults !== undefined && policy.defaults !== null ? policy.defaults[key] : null
		return defaults === undefined || defaults === null ? rowCopy(rowOf(policy, 'global', key)) : rowCopy(defaults)
	}

	/** The host's plain text for the value a config scope projects. */
	function textOf(value) {
		return typeof value === 'string' ? value : ''
	}

	/**
	 * The engine-path section: the same config scope the plugin settings card
	 * has always edited, rendered in the page instead of in the card's own form.
	 */
	function EngineSection(props) {
		const t = props.t
		const scope = props.scope === undefined ? null : props.scope
		const inputId = typeof props.inputId === 'string' && props.inputId !== '' ? props.inputId : 'godot-bridge-engine-path'
		const input = React.useRef(null)
		const [busy, setBusy] = React.useState(false)
		const [dirty, setDirty] = React.useState(false)
		const [outcome, setOutcome] = React.useState(null)
		const [seenRevision, setSeenRevision] = React.useState(undefined)
		// A save's own answer must survive the revision bump it causes: the host
		// folds the new value in (moving revision) before this component reads
		// the accepted flag back.
		const keepOutcome = React.useRef(false)
		const subscribe = React.useMemo(
			function () {
				return function (listener) {
					if (scope === null || typeof scope.subscribe !== 'function') return function () {}
					return scope.subscribe(listener)
				}
			},
			[scope],
		)
		const read = React.useMemo(
			function () {
				return function () {
					return scope === null || typeof scope.getSnapshot !== 'function' ? null : scope.getSnapshot()
				}
			},
			[scope],
		)
		const state = React.useSyncExternalStore(subscribe, read, read)

		if (scope === null || scope === undefined) {
			return h('p', { className: 'gbt-settingsnote', 'data-settings-engine': 'unavailable', role: 'status' }, t('settingsEngineUnavailable'))
		}
		if (state === undefined || state === null || state.status === 'unavailable') {
			return h('p', { className: 'gbt-settingsnote', 'data-settings-engine': 'unavailable', role: 'status' }, t('settingsEngineUnavailable'))
		}
		// The settings document has not arrived yet; showing "unavailable" here
		// would be a lie, and the section fills in on its own.
		if (state.status !== 'ready') return null

		const revision = state.revision
		// A host revision means the document moved under us: the staged draft is
		// stale, so the next render starts from the stored value again.
		if (seenRevision !== revision) {
			setSeenRevision(revision)
			setDirty(false)
			if (keepOutcome.current) keepOutcome.current = false
			else setOutcome(null)
		}

		const projected = state.value === undefined || state.value === null ? undefined : state.value[ENGINE_FIELD]
		const value = textOf(projected)
		const overridden = state.user !== undefined && state.user !== null && Object.hasOwn(state.user, ENGINE_FIELD)
		const writable = state.writable === true

		/** Queue one field write and report whether the host accepted it. */
		function commit(write) {
			setBusy(true)
			setOutcome(null)
			return Promise.resolve()
				.then(function () {
					return write()
				})
				.then(
					function (accepted) {
						const ok = accepted === true
						if (ok) keepOutcome.current = true
						setBusy(false)
						setOutcome(ok ? 'saved' : 'failed')
						return ok
					},
					function () {
						setBusy(false)
						setOutcome('failed')
						return false
					},
				)
		}

		/** Store what the input holds; an empty draft clears the profile override. */
		function save() {
			const node = input.current
			const next = node === null || node === undefined ? '' : String(node.value === undefined || node.value === null ? '' : node.value)
			if (next === '') return commit(function () { return scope.unset(ENGINE_FIELD) })
			return commit(function () { return scope.set(ENGINE_FIELD, next) })
		}

		return h(
			'div',
			{ 'data-settings-engine': 'ready', 'data-settings-engine-overridden': overridden ? 'true' : 'false' },
			writable ? null : h('p', { className: 'gbt-settingsnote', role: 'status' }, t('settingsEngineReadOnly')),
			h(
				'div',
				{ className: 'gbt-field' },
				h(
					'div',
					{ className: 'gbt-settingsinline', style: { justifyContent: 'space-between' } },
					h('label', { htmlFor: inputId }, t('settingsEngineLabel')),
					overridden ? h('span', { className: 'gbt-chip' }, t('settingsEngineOverridden')) : null,
				),
				h('input', {
					id: inputId,
					className: 'gbt-input',
					key: 'revision-' + String(revision),
					ref: input,
					type: 'text',
					defaultValue: value,
					disabled: !writable || busy,
					spellCheck: false,
					autoComplete: 'off',
					'data-settings-engine-input': 'true',
					onInput: function () {
						setDirty(true)
						setOutcome(null)
					},
				}),
				h('p', { className: 'gbt-settingsnote' }, t('settingsEngineHint')),
			),
			h(
				'div',
				{ className: 'gbt-settingsinline' },
				h(
					'button',
					{
						type: 'button',
						className: 'gbt-btn',
						'data-variant': 'primary',
						'data-settings-engine-save': 'true',
						disabled: !writable || busy || !dirty,
						onClick: save,
					},
					busy ? t('settingsEngineSaving') : t('save'),
				),
				overridden
					? h(
							'button',
							{
								type: 'button',
								className: 'gbt-btn',
								'data-settings-engine-reset': 'true',
								disabled: !writable || busy,
								onClick: function () {
									return commit(function () { return scope.unset(ENGINE_FIELD) })
								},
							},
							t('settingsEngineReset'),
						)
					: null,
				outcome === null
					? null
					: h(
							'p',
							{ className: 'gbt-settingsnote', 'data-settings-engine-status': outcome, role: 'status' },
							outcome === 'saved' ? t('settingsEngineSaved') : t('settingsEngineFailed'),
						),
			),
		)
	}

	function SettingsForm(props) {
		// Hooks first: the id keys this instance's drafts AND the engine input id,
		// so two mounted pages can neither share drafts nor duplicate a DOM id.
		const instanceId = React.useId()
		const t = props.t
		const dispatch = props.dispatch !== null && props.dispatch !== undefined ? props.dispatch : {}
		const policy = props.policy !== null && props.policy !== undefined ? props.policy : null
		const theme = props.theme === 'console' ? 'console' : 'dsh'
		const concurrent = React.useRef(null)
		const attempts = React.useRef(null)
		const defaultTarget = React.useRef(null)
		const [tick, setTick] = React.useState(0)
		const unbound = props.unbound === true
		const active = typeof props.section === 'string' && SECTION_KEYS.indexOf(props.section) >= 0 ? props.section : 'general'
		const currentConcurrent = Number.isFinite(dispatch.maxConcurrent) ? Math.max(1, Math.floor(dispatch.maxConcurrent)) : 3
		const currentAttempts = Number.isFinite(dispatch.maxAttempts) ? Math.max(1, Math.floor(dispatch.maxAttempts)) : 3
		const state = policyStateOf(instanceId)
		React.useEffect(function () {
			return function () {
				policyStates.delete(instanceId)
			}
		}, [instanceId])
		ensureState(state, policy)
		const scope = state.scope

		function rerender() {
			setTick(tick + 1)
		}

		function numberFrom(ref, fallback) {
			if (ref !== null && ref !== undefined && ref.current !== null && ref.current !== undefined && ref.current.value !== undefined) {
				const value = Number(ref.current.value)
				if (Number.isFinite(value)) return Math.floor(value)
			}
			return fallback
		}

		function overridesOf(targetScope, key) {
			const overrides = policy === null || policy === undefined || policy.overrides === undefined ? null : policy.overrides[targetScope]
			return overrides !== null && overrides !== undefined && overrides[key] !== undefined
		}

		function resetEvent(targetScope, key) {
			// Remember what the scope inherits: a PURE reset sends no patch (the
			// override disappears); an edit after the reset is sent against this
			// inherited row, so the new value is explicit.
			const inherited = inheritedRow(policy, targetScope, key)
			state.resets[targetScope][key] = Object.assign({}, inherited)
			state.drafts[targetScope][key] = Object.assign({}, inherited)
			rerender()
		}

		function resetAll() {
			for (const view of DECISION_EVENT_VIEWS) resetEvent(state.scope, view.key)
		}

		function setScope(next) {
			state.scope = next === 'global' ? 'global' : 'project'
			rerender()
		}

		/** The sparse patch the server should store for the current scope. */
		function policyChanges() {
			const current = state.scope
			const events = {}
			for (const view of DECISION_EVENT_VIEWS) {
				const draft = state.drafts[current][view.key]
				const resetSnapshot = state.resets[current][view.key]
				const base = resetSnapshot === undefined ? state.baseline[current][view.key] : resetSnapshot
				const patch = {}
				if (draft.mode !== base.mode) patch.mode = draft.mode
				if (draft.defaultOption !== base.defaultOption) patch.defaultOption = draft.defaultOption
				if (draft.timeoutSeconds !== base.timeoutSeconds) patch.timeoutSeconds = draft.timeoutSeconds
				if (draft.limit !== base.limit) patch.limit = draft.limit
				if (draft.autoRecover !== base.autoRecover) patch.autoRecover = draft.autoRecover
				if (Object.keys(patch).length > 0) events[view.key] = patch
			}
			const reset = Object.keys(state.resets[current])
			return { scope: current, events: events, reset: reset }
		}

		function policyErrorText(result) {
			const code = result !== null && result !== undefined && typeof result.code === 'string' ? result.code : ''
			if (code !== '') {
				const key = 'err_' + code.replace(/[^A-Za-z0-9]+/g, '_').toLowerCase()
				const localized = t(key)
				if (typeof localized === 'string' && localized !== '' && localized !== key) return localized
			}
			return t('error')
		}

		/**
		 * Save the project-scoped settings and, only when the policy was edited,
		 * the decision policy. Resolves { ok, error? }: the page shows the outcome
		 * in its footer and stays where it is (a page is not a modal).
		 */
		function save() {
			if (unbound === true) return Promise.resolve({ ok: false, error: t('settingsUnboundHint') })
			const concurrency = numberFrom(concurrent, currentConcurrent)
			const maxAttempts = numberFrom(attempts, currentAttempts)
			if (concurrency < 1 || concurrency > 8) return Promise.resolve({ ok: false, error: t('invalidConcurrency') })
			if (maxAttempts < 1 || maxAttempts > 10) return Promise.resolve({ ok: false, error: t('invalidMaxAttempts') })
			const changes = policyChanges()
			for (const key of Object.keys(changes.events)) {
				const patch = changes.events[key]
				if (
					patch.timeoutSeconds !== undefined &&
					patch.timeoutSeconds !== null &&
					(!Number.isFinite(patch.timeoutSeconds) || patch.timeoutSeconds < 0 || patch.timeoutSeconds > 86400)
				) {
					return Promise.resolve({ ok: false, error: t('err_invalid_policy_timeout') })
				}
				for (const field of ['limit', 'autoRecover']) {
					const value = patch[field]
					if (value === undefined || value === null) continue
					if (!Number.isFinite(value) || value < 0 || value > 10) {
						return Promise.resolve({ ok: false, error: field === 'limit' ? t('err_invalid_policy_limit') : t('err_invalid_policy_auto_recover') })
					}
				}
			}
			const targetValue = defaultTarget.current === null || defaultTarget.current === undefined ? '' : String(defaultTarget.current.value === undefined || defaultTarget.current.value === null ? '' : defaultTarget.current.value).trim()
			return store
				.send('settings', {
					maxConcurrent: concurrency,
					maxAttempts: maxAttempts,
					defaultTarget: targetValue,
				})
				.then(function (result) {
					if (result.ok !== true) return { ok: false, error: t('error') }
					const changed = Object.keys(changes.events).length > 0 || changes.reset.length > 0
					if (changed !== true) return { ok: true }
					return store.send('decisionPolicy', changes).then(function (policyResult) {
						if (policyResult.ok === true) return { ok: true }
						return { ok: false, error: policyErrorText(policyResult.payload) }
					})
				})
		}

		// Publish the save action twice: the module registry is what the form tests
		// drive directly, while the page passes its OWN actions object so two
		// mounted settings pages (panel + plugin card) can never call each other's
		// save closure — and therefore never read each other's input refs.
		formActions.save = save
		if (props.actions !== null && props.actions !== undefined && typeof props.actions === 'object') props.actions.save = save

		function fieldInput(view, field, options) {
			const draft = state.drafts[scope][view.key]
			const value = draft[field]
			if (options.kind === 'select') {
				return h(
					'select',
					{
						className: 'gbt-input',
						'data-policy-field': options.name,
						'data-policy-event': view.key,
						value: value === undefined || value === null ? '' : String(value),
						disabled: options.disabled === true,
						title: options.title,
						onChange: function (event) {
							draft[field] = String(event.target.value)
							rerender()
						},
					},
					options.choices.map(function (choice) {
						return h('option', { key: choice.value, value: choice.value }, choice.label)
					}),
				)
			}
			const nullable = options.nullable === true
			return h('input', {
				className: 'gbt-input',
				type: 'number',
				min: options.min,
				max: options.max,
				step: 1,
				'data-policy-field': options.name,
				'data-policy-event': view.key,
				value: value === null || value === undefined ? '' : String(value),
				disabled: options.disabled === true,
				onChange: function (event) {
					const raw = String(event.target.value === undefined || event.target.value === null ? '' : event.target.value).trim()
					if (raw === '') {
						if (nullable === true) draft[field] = null
						else draft[field] = 0
						rerender()
						return
					}
					const parsed = Number(raw)
					if (Number.isFinite(parsed)) {
						draft[field] = Math.floor(parsed)
						rerender()
					}
				},
			})
		}

		function eventRow(view) {
			const draft = state.drafts[scope][view.key]
			const fixed = view.fixedMode !== undefined
			const resetDisabled = unbound === true || (overridesOf(scope, view.key) !== true && state.resets[scope][view.key] === undefined)
			return h(
				'tr',
				{ key: view.key, 'data-policy-event': view.key },
				h('th', { scope: 'row' }, t(view.labelKey)),
				h('td', null, fieldInput(view, 'mode', {
					kind: 'select',
					name: 'mode',
					disabled: fixed === true || unbound === true,
					title: fixed ? t('decisionGuardDeleteWord') : undefined,
					choices: DECISION_MODES.map(function (mode) { return { value: mode, label: mode } }),
				})),
				h('td', null, fieldInput(view, 'defaultOption', {
					kind: 'select',
					name: 'default',
					disabled: unbound === true,
					choices: (function () {
						// Only a safe option can be a default. If the current value is not
						// in that list (an older file) it is still shown, never blank.
						const selectable = view.options.filter(function (option) { return option.noDefault !== true })
						const shown = selectable.some(function (option) { return option.id === draft.defaultOption }) ? selectable : view.options
						return shown.map(function (option) { return { value: option.id, label: t(option.labelKey) } })
					})(),
				})),
				h('td', null, fieldInput(view, 'timeoutSeconds', { name: 'timeout', min: 0, max: 86400, nullable: true, disabled: unbound === true })),
				h('td', null, fieldInput(view, 'limit', { name: 'limit', min: 0, max: 10, nullable: true, disabled: unbound === true })),
				h('td', null, fieldInput(view, 'autoRecover', { name: 'auto-recover', min: 0, max: 10, nullable: true, disabled: unbound === true })),
				h(
					'td',
					null,
					h(
						'button',
						{
							type: 'button',
							className: 'gbt-btn',
							'data-policy-reset': view.key,
							disabled: resetDisabled,
							onClick: function () {
								resetEvent(scope, view.key)
							},
						},
						t('decisionResetEvent'),
					),
				),
			)
		}

		/** One page section: mounted so drafts survive, hidden when not selected. */
		function sectionPanel(key, children) {
			const hidden = active !== 'all' && active !== key
			return h(
				'section',
				{
					key: key,
					className: 'gbt-settingssection',
					'data-settings-section': key,
					hidden: hidden ? true : undefined,
					'aria-hidden': hidden ? 'true' : undefined,
				},
				children,
			)
		}

		const storage = policy !== null && policy !== undefined && policy.storage !== undefined && policy.storage !== null ? policy.storage : null
		const policyErrors = policy !== null && policy !== undefined && Array.isArray(policy.errors) ? policy.errors : []

		const themePanel = sectionPanel('general', [
			h(
				'div',
				{ className: 'gbt-settingsgroup', 'data-settings-group': 'theme' },
				h('div', { className: 'gbt-settingsgrouphead' }, t('settingsThemeGroup')),
				h(
					'div',
					{ className: 'gbt-field' },
					h('label', null, t('settingsTheme')),
					h(
						'select',
						{
							className: 'gbt-input',
							'data-field': 'ui-theme',
							'data-tc-theme-select': 'true',
							value: theme,
							onChange: function (event) {
								const next = event !== null && event !== undefined && event.target !== undefined ? String(event.target.value) : 'dsh'
								if (typeof props.onThemeChange === 'function') props.onThemeChange(next)
							},
						},
						h('option', { value: 'dsh' }, t('settingsThemeDsh')),
						h('option', { value: 'console' }, t('settingsThemeConsole')),
					),
				),
				h('p', { className: 'gbt-settingsnote' }, t('settingsThemeHint')),
			),
		])

		const dispatchPanel = sectionPanel('dispatch', [
			h(
				'div',
				{ className: 'gbt-settingsgroup', 'data-settings-group': 'concurrency' },
				h('div', { className: 'gbt-settingsgrouphead' }, t('settingsConcurrencyGroup')),
				h(
					'div',
					{ className: 'gbt-field' },
					h('label', null, t('maxConcurrent')),
					h('input', {
						className: 'gbt-input',
						type: 'number',
						min: 1,
						max: 8,
						step: 1,
						ref: concurrent,
						defaultValue: String(currentConcurrent),
						'data-field': 'max-concurrent',
						disabled: unbound === true,
					}),
				),
				h('p', { className: 'gbt-settingsnote' }, t('concurrencyHint')),
			),
			h(
				'div',
				{ className: 'gbt-settingsgroup', 'data-settings-group': 'default-target' },
				h(
					'div',
					{ className: 'gbt-field' },
					h('label', null, t('defaultTargetLabel')),
					h('input', {
						className: 'gbt-input',
						'data-field': 'default-target',
						ref: defaultTarget,
						defaultValue: typeof dispatch.defaultTarget === 'string' ? dispatch.defaultTarget : '',
						placeholder: t('defaultTargetHint'),
						disabled: unbound === true,
					}),
				),
			),
		])

		const retryPanel = sectionPanel('retry', [
			h(
				'div',
				{ className: 'gbt-settingsgroup', 'data-settings-group': 'retry' },
				h('div', { className: 'gbt-settingsgrouphead' }, t('settingsRetryGroup')),
				h(
					'div',
					{ className: 'gbt-field' },
					h('label', null, t('settingsMaxAttempts')),
					h('input', { className: 'gbt-input', type: 'number', min: 1, max: 10, step: 1, ref: attempts, defaultValue: String(currentAttempts), 'data-field': 'max-attempts', disabled: unbound === true }),
				),
				h('p', { className: 'gbt-settingsnote' }, t('settingsRetryHint')),
			),
		])

		const decisionsPanel = sectionPanel('decisions', [
			h(
				'div',
				{ className: 'gbt-settingsgroup', 'data-settings-group': 'decisions' },
				h('div', { className: 'gbt-settingsgrouphead' }, t('decisionSettingsTitle')),
				h('p', { className: 'gbt-settingsnote' }, t('decisionSettingsHint')),
				h(
					'div',
					{ className: 'gbt-settingsinline' },
					h('span', null, t('decisionScope')),
					h(
						'div',
						{ className: 'gbt-policyscopes' },
						h(
							'button',
							{
								type: 'button',
								className: 'gbt-policyscope',
								'data-policy-scope': 'global',
								'data-active': scope === 'global' ? 'true' : 'false',
								disabled: unbound === true,
								onClick: function () {
									if (unbound === true) return
									setScope('global')
								},
							},
							t('decisionScopeGlobal'),
						),
						h(
							'button',
							{
								type: 'button',
								className: 'gbt-policyscope',
								'data-policy-scope': 'project',
								'data-active': scope === 'project' ? 'true' : 'false',
								disabled: unbound === true,
								onClick: function () {
									if (unbound === true) return
									setScope('project')
								},
							},
							t('decisionScopeProject'),
						),
					),
					h(
						'button',
						{ type: 'button', className: 'gbt-btn', 'data-policy-reset-all': scope, disabled: unbound === true, onClick: resetAll },
						t('decisionResetAll'),
					),
				),
				h('p', { className: 'gbt-settingsnote' }, t('decisionScopeHint')),
				storage !== null && storage.global === 'workspace' ? h('p', { className: 'gbt-settingsnote', 'data-policy-storage': 'workspace' }, t('decisionPolicyWorkspaceNote')) : null,
				policyErrors.length > 0
					? h(
							'p',
							{ className: 'gbt-settingsnote', 'data-policy-errors': 'true' },
							policyErrors.map(function (entry) { return String(entry.scope) + ': ' + String(entry.code) }).join(', '),
						)
					: null,
				h('div', { className: 'gbt-tablewrap' }, h(
					'table',
					{ className: 'gbt-policytable', 'data-decision-policy-table': 'true' },
					h(
						'thead',
						null,
						h(
							'tr',
							null,
							h('th', null, t('decisionEventColumn')),
							h('th', null, t('decisionModeLabel')),
							h('th', null, t('decisionDefaultLabel')),
							h('th', null, t('decisionTimeoutLabel')),
							h('th', null, t('decisionLimitLabel')),
							h('th', null, t('decisionAutoRecoverLabel')),
							h('th', null, ''),
						),
					),
					h('tbody', null, DECISION_EVENT_VIEWS.map(eventRow)),
				)),
				h(
					'div',
					{ 'data-policy-guards': 'true' },
					h('div', { className: 'gbt-settingsgrouphead' }, t('decisionGuardsTitle')),
					h(
						'label',
						{ className: 'gbt-policyguard' },
						h('input', { type: 'checkbox', checked: true, disabled: true, readOnly: true, 'data-policy-guard': 'delete-word' }),
						t('decisionGuardDeleteWord'),
					),
					h(
						'label',
						{ className: 'gbt-policyguard' },
						h('input', { type: 'checkbox', checked: true, disabled: true, readOnly: true, 'data-policy-guard': 'timeout-no-delete' }),
						t('decisionGuardTimeoutDelete'),
					),
					h('p', { className: 'gbt-settingsnote' }, t('decisionGuardHint')),
				),
			),
		])

		const enginePanel = sectionPanel('engine', [
			h('div', { className: 'gbt-settingsgroup', 'data-settings-group': 'engine' }, h(EngineSection, { t: t, scope: props.engineScope === undefined ? null : props.engineScope, inputId: 'godot-bridge-engine-path-' + instanceId })),
		])

		return h(
			'div',
			{ className: 'gbt-settingssections', 'data-settings-sections': 'true', 'data-settings-active': active, 'data-settings-bound': unbound === true ? 'false' : 'true' },
			themePanel,
			dispatchPanel,
			retryPanel,
			decisionsPanel,
			enginePanel,
		)
	}

	// The catalog is part of the component's contract: the drift test compares it
	// with the server's DECISION_EVENT_CATALOG (keys, option ids and defaults).
	SettingsForm.decisionEvents = DECISION_EVENT_VIEWS
	// The page's footer drives this; the form keeps the input refs and drafts.
	SettingsForm.actions = formActions
	SettingsForm.sections = SECTION_KEYS
	return SettingsForm
}

module.exports = { createSettingsForm }

				})(module, module.exports)
				const factory = module.exports.createSettingsForm
				return factory({
					React: React,
					h: h,
					store: store,
				})
			})()

			const settingsViews = (function () {
				const module = { exports: {} }
				;(function (module, exports) {
/**
 * Settings page view module.
 *
 * T-205 turns the old "dispatch settings" modal into a real settings page: a
 * page title (设置), a fixed left navigation (常规 / 派发 / 重试 / 关键决策 /
 * Godot 引擎), an independently scrolling right column and a footer that holds
 * the save/cancel actions. The task center's settings entry and the plugin
 * bundle card (plugins.bundle.config) BOTH render this page - the card only
 * supplies the data the page needs (the shared task store, the config scope for
 * the engine path, the theme preference), so the two entry points cannot drift.
 *
 * Data scope: the page always reflects the CURRENT task-center project from the
 * snapshot (never a last-active one): an unbound session renders the
 * "未绑定项目" banner and disables the project-scoped themes (派发 / 重试 /
 * 关键决策), while the engine path (a config-scope value) stays editable.
 *
 * Every section stays MOUNTED inside the form; the page only changes which one
 * is visible, so a half-typed field survives a trip to another theme. The save
 * action is owned by SettingsForm (it holds the input refs and the drafts); it
 * publishes itself into a page-owned actions object on every render, so the
 * footer always calls THIS page's save closure (a second mounted page cannot
 * hijack it).
 *
 * Narrow layouts: CSS folds the left rail into a horizontal tab row above the
 * content (see TC_CSS, max-width 900px); the DOM order already reads nav-first.
 */
function createSettingsViews(deps) {
	const React = deps.React
	const h = deps.h
	const SettingsForm = deps.SettingsForm

	// The theme rail, in reading order. projectScoped themes write into the task
	// center project, so they are disabled while nothing is bound.
	const SECTIONS = [
		{ key: 'general', labelKey: 'settingsNavGeneral', projectScoped: false },
		{ key: 'dispatch', labelKey: 'settingsNavDispatch', projectScoped: true },
		{ key: 'retry', labelKey: 'settingsNavRetry', projectScoped: true },
		{ key: 'decisions', labelKey: 'settingsNavDecisions', projectScoped: true },
		{ key: 'engine', labelKey: 'settingsNavEngine', projectScoped: false },
	]

	const THEME_KEY = 'gbt-theme'

	/** The browser theme preference; a storage denial still lets the page render. */
	function readThemePreference() {
		try {
			const raw =
				typeof window !== 'undefined' && window !== null && window.localStorage !== undefined && typeof window.localStorage.getItem === 'function'
					? window.localStorage.getItem(THEME_KEY)
					: null
			return raw === 'console' ? 'console' : 'dsh'
		} catch (error) {
			return 'dsh'
		}
	}

	function writeThemePreference(value) {
		try {
			if (typeof window !== 'undefined' && window !== null && window.localStorage !== undefined && typeof window.localStorage.setItem === 'function') {
				window.localStorage.setItem(THEME_KEY, value)
			}
		} catch (error) {
			/* the in-memory theme still applies */
		}
	}

	function resolveSection(value) {
		if (typeof value !== 'string') return 'general'
		return SECTIONS.some(function (entry) { return entry.key === value }) ? value : 'general'
	}

	/**
	 * The page. Every data input is a prop so the same component can be mounted
	 * by the task center panel and by the plugin bundle card.
	 */
	function SettingsPage(props) {
		const t = props.t
		const snapshot = props.snapshot !== null && props.snapshot !== undefined && typeof props.snapshot === 'object' ? props.snapshot : {}
		const mode = props.mode === 'card' ? 'card' : 'panel'
		const theme = props.theme === 'console' ? 'console' : 'dsh'
		const store = props.store === undefined ? null : props.store
		// The page never looks for a last-active project: the snapshot's project is
		// the one the task center acts on, and null is the honest "unbound" state.
		const project = typeof snapshot.project === 'string' && snapshot.project !== '' ? snapshot.project : null
		const unbound = project === null
		// A per-page actions slot: the mounted form publishes its save into THIS
		// object, so a second mounted page (the plugin card) cannot hijack the
		// footer of the first one.
		const actionsRef = React.useRef(null)
		if (actionsRef.current === null || actionsRef.current === undefined) actionsRef.current = { save: null }
		const [section, setSection] = React.useState(resolveSection(props.initialSection))
		const [status, setStatus] = React.useState(null)
		const active = resolveSection(section)
		const dispatch = snapshot.dispatch === null || snapshot.dispatch === undefined ? {} : snapshot.dispatch
		const policy = snapshot.decisionPolicy === undefined ? null : snapshot.decisionPolicy

		function choose(next) {
			const key = resolveSection(next)
			const entry = SECTIONS.filter(function (candidate) { return candidate.key === key })[0]
			if (unbound === true && entry !== undefined && entry.projectScoped === true) return
			setSection(key)
		}

		function save() {
			if (unbound === true) {
				setStatus({ kind: 'error', text: t('settingsUnboundHint') })
				return
			}
			const actions = actionsRef.current
			if (actions === null || actions === undefined || typeof actions.save !== 'function') return
			const pending = actions.save()
			if (pending === null || pending === undefined || typeof pending.then !== 'function') return
			pending.then(function (outcome) {
				const ok = outcome !== null && outcome !== undefined && outcome.ok === true
				if (ok) {
					setStatus({ kind: 'saved' })
					return
				}
				const text = outcome !== null && outcome !== undefined && typeof outcome.error === 'string' && outcome.error !== '' ? outcome.error : t('error')
				setStatus({ kind: 'error', text: text })
			})
		}

		const nav = h(
			'nav',
			{ className: 'gbt-settingsnav', 'data-settings-nav': 'true', role: 'navigation', 'aria-label': t('settingsNavLabel') },
			SECTIONS.map(function (entry) {
				const disabled = unbound === true && entry.projectScoped === true
				return h(
					'button',
					{
						key: entry.key,
						type: 'button',
						className: 'gbt-settingsnavitem',
						'data-settings-nav': entry.key,
						'data-active': active === entry.key ? 'true' : 'false',
						'aria-current': active === entry.key ? 'page' : undefined,
						disabled: disabled,
						onClick: function () {
							choose(entry.key)
						},
					},
					t(entry.labelKey),
				)
			}),
		)

		const head = h(
			'header',
			{ className: 'gbt-settingshead', 'data-settings-head': 'true' },
			h(
				'div',
				{ className: 'gbt-settingsheadtext' },
				h('h1', { className: 'gbt-settingspagetitle', 'data-settings-title': 'true' }, t('settingsPageTitle')),
				h(
					'p',
					{ className: 'gbt-settingssub' },
					unbound === true
						? t('settingsUnbound')
						: h('span', null, t('settingsProjectScope'), ' · ', h('b', { className: 'gbt-mono', title: project }, project)),
				),
			),
			mode === 'panel' && typeof props.onClose === 'function'
				? h(
						'button',
						{ type: 'button', className: 'gbt-iconbtn', 'data-action': 'settings-back', title: t('close'), 'aria-label': t('close'), onClick: props.onClose },
						'×',
					)
				: null,
		)

		const unboundBanner =
			unbound === true
				? h(
						'div',
						{ className: 'gbt-settingsunbound', 'data-settings-unbound': 'true', role: 'status' },
						h('b', null, t('settingsUnbound')),
						h('span', null, ' · ' + t('settingsUnboundHint')),
					)
				: null

		const statusText = status === null ? '' : status.kind === 'saved' ? t('settingsSaved') : String(status.text)

		const footer = h(
			'footer',
			{ className: 'gbt-settingsfooter', 'data-settings-footer': 'true' },
			h('p', { className: 'gbt-settingsstatus', 'data-settings-status': status === null ? '' : status.kind, role: 'status', 'aria-live': 'polite' }, statusText),
			h('button', { type: 'button', className: 'gbt-btn', 'data-variant': 'primary', 'data-settings-save': 'true', disabled: unbound === true, onClick: save }, t('apply')),
			typeof props.onClose === 'function'
				? h('button', { type: 'button', className: 'gbt-btn', 'data-settings-cancel': 'true', onClick: props.onClose }, t('cancel'))
				: null,
		)

		const form = h(SettingsForm, {
			t: t,
			actions: actionsRef.current,
			dispatch: dispatch,
			policy: policy,
			theme: theme,
			onThemeChange: props.onThemeChange,
			section: active,
			unbound: unbound,
			engineScope: props.engineScope === undefined ? null : props.engineScope,
			store: store,
		})

		return h(
			'div',
			{
				className: 'gbt-settingspage' + (mode === 'card' ? ' gbt-root' : ''),
				'data-settings-page': 'true',
				'data-settings-mode': mode,
				'data-settings-active': active,
				'data-settings-bound': unbound === true ? 'false' : 'true',
				'data-tc-theme': theme,
			},
			head,
			unboundBanner,
			h(
				'div',
				{ className: 'gbt-settingsbody' },
				nav,
				h(
					'div',
					{ className: 'gbt-settingspane' },
					h('div', { className: 'gbt-settingsscroll', 'data-settings-scroll': 'true' }, form),
					footer,
				),
			),
		)
	}

	/**
	 * The plugin bundle card: the SAME page, mounted from plugins.bundle.config.
	 * It resolves the shared task store (the current project, no last-active
	 * fallback) and the engine path's config scope, and keeps the browser theme
	 * preference; nothing else is card-specific.
	 */
	function createSettingsCard(cardDeps) {
		const opts = cardDeps === undefined || cardDeps === null ? {} : cardDeps
		const store = opts.store
		const engineScope = opts.engineScope === undefined ? null : opts.engineScope
		const locale = opts.locale
		const ns = typeof opts.ns === 'string' && opts.ns !== '' ? opts.ns : 'godotBridgeTaskCenter'

		function useTranslate() {
			const force = React.useReducer(function (count) { return count + 1 }, 0)[1]
			React.useEffect(function () {
				return locale.subscribe(force)
			}, [])
			return locale.bind(ns)
		}

		function SettingsCard() {
			const t = useTranslate()
			const snapshot = React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
			const [theme, setTheme] = React.useState(readThemePreference)
			// The host asks for one page load when the card opens; the panel keeps
			// polling, the card does not subscribe to a timer of its own.
			React.useEffect(function () {
				void store.load()
			}, [])
			function onThemeChange(next) {
				const value = next === 'console' ? 'console' : 'dsh'
				writeThemePreference(value)
				setTheme(value)
			}
			return h(SettingsPage, {
				t: t,
				mode: 'card',
				// The bundle card has always configured the engine path, so it opens
				// on that theme; the rest of the page stays one click away.
				initialSection: 'engine',
				snapshot: snapshot,
				store: store,
				engineScope: engineScope,
				theme: theme,
				onThemeChange: onThemeChange,
			})
		}

		return SettingsCard
	}

	return { SettingsPage: SettingsPage, createSettingsCard: createSettingsCard }
}

module.exports = { createSettingsViews }

				})(module, module.exports)
				return module.exports.createSettingsViews({ React: React, h: h, SettingsForm: SettingsForm })
			})()
			const SettingsPage = settingsViews.SettingsPage
			const createSettingsCard = settingsViews.createSettingsCard

			function projectSourceKey(snapshot) {
				if (snapshot === null || snapshot === undefined) return null
				const from = snapshot.resolvedFrom
				if (from === 'session') return 'session'
				if (from === 'registry') return 'registry'
				if (from === 'panel' || from === 'explicit' || from === 'manual') return 'manual'
				return null
			}

			function projectSourceLabel(key, t) {
				if (key === 'session') return t('projectSourceSession')
				if (key === 'registry') return t('projectSourceRegistry')
				if (key === 'manual') return t('projectSourceManual')
				return null
			}

			/**
			 * The session project when it is NOT the one the panel shows. A hand-pinned
			 * path would otherwise silently split the GUI from the project the session
			 * (and the scheduler) drives — the exact split T-90 exists to surface.
			 */
			function projectMismatchOf(snapshot) {
				if (snapshot === null || snapshot === undefined) return null
				const shown = typeof snapshot.projectRoot === 'string' && snapshot.projectRoot !== '' ? snapshot.projectRoot : snapshot.project
				const session = typeof snapshot.sessionProject === 'string' && snapshot.sessionProject !== '' ? snapshot.sessionProject : null
				if (typeof shown !== 'string' || shown === '' || session === null) return null
				return tcSameProject(shown, session) ? null : session
			}

			// The main slot unmounts when the user switches to the chat panel. React
			// state alone therefore resets to the board on return; this object lives in
			// the views closure (one per plugin activation) and carries the view and
			// selected task across that remount. Modals are deliberately not here.
			const panelState = { view: 'board', selectedId: null, doneAllOpen: false, doneAllArchived: false }
			// The project dialog's draft: "use current project" fills this so a re-render
			// (or a reopened dialog) keeps the value the Host resolved.
			const projectFormState = { value: null }
			const ProjectForm = (function () {
				const module = { exports: {} }
				;(function (module, exports) {
/**
 * Project form view module.
 *
 * Extracted from the forms fragment; React, h, Modal, the project draft state,
 * the panel store and tcErrorMessage are injected by the build.
 */
function createProjectForm(deps) {
	const React = deps.React
	const h = deps.h
	const Modal = deps.Modal
	const projectFormState = deps.projectFormState
	const store = deps.store
	const tcErrorMessage = deps.tcErrorMessage

	function ProjectForm(props) {
		const t = props.t
		const input = React.useRef(null)
		// Module-backed so a remount keeps the failure visible (the dialog must never
		// look like the click did nothing).
		const [error, setErrorState] = React.useState(projectFormState.error === undefined ? '' : projectFormState.error)
		function setError(next) {
			projectFormState.error = next
			setErrorState(next)
		}
		// T-155 §6: checking a project is a visible state (busy button), and a
		// not-ready answer keeps the dialog open with the missing checks listed and
		// the primary action turned into a re-check.
		const [busy, setBusy] = React.useState(false)
		const [missing, setMissingState] = React.useState(projectFormState.missing === undefined ? [] : projectFormState.missing)
		function setMissing(next) {
			projectFormState.missing = next
			setMissingState(next)
		}
		// The project the Host resolves right now (the session project when this
		// browser has not pinned one). It is what "use current project" fills in,
		// so returning to this project never needs a hand-typed path (T-90).
		const hostProject = typeof props.hostProject === 'string' && props.hostProject !== '' ? props.hostProject : null
		const draft = projectFormState.value !== null ? projectFormState.value : typeof props.project === 'string' ? props.project : hostProject === null ? '' : hostProject
		function useCurrent() {
			if (hostProject === null) return
			projectFormState.value = hostProject
			setError('')
			setMissing([])
			if (input.current !== null && input.current !== undefined) input.current.value = hostProject
		}
		function open() {
			const typed = input.current === null || input.current === undefined ? null : String(input.current.value || '').trim()
			// Nothing typed: the prefilled draft (Host project or the pinned one) is
			// the value — "open project" on the dialog's own suggestion is valid.
			const value = typed !== null && typed !== '' ? typed : typeof draft === 'string' ? draft.trim() : ''
			if (value === '') {
		setError(t('projectRequired'))
		return
			}
			// Write = bind: the pin and the Host's openProject move together.
			setBusy(true)
			setMissing([])
			void store.switchProject(value).then(function (result) {
		setBusy(false)
		if (result.ok === true) {
			projectFormState.value = null
			setError('')
			setMissing([])
			props.onClose()
			return
		}
		const payload = result.payload === undefined || result.payload === null ? {} : result.payload
		// T-182: a THROWN transport failure (fetch rejected: ECONNREFUSED, DNS,
		// offline) arrives as result.error, not as a payload. Reading only the
		// payload turned the real reason into the generic "操作失败" and made the
		// dialog look like the click failed for no reason.
		const thrown = result.error === undefined || result.error === null ? '' : String((result.error && result.error.message) || result.error)
		setError(thrown === '' ? tcErrorMessage(payload, t) : thrown)
		// A not-ready project explains WHY: the preflight's failed checks are the
		// missing items (git repository / board / team...). Keep the dialog open.
		const preflight = payload.preflight !== null && payload.preflight !== undefined && typeof payload.preflight === 'object' ? payload.preflight : null
		const failed = preflight !== null && Array.isArray(preflight.failed) ? preflight.failed : []
		const labels = []
		for (const check of failed) {
			if (check !== null && typeof check === 'object' && typeof check.label === 'string' && check.label !== '') labels.push(check.label)
		}
		setMissing(labels)
			})
		}
		const primaryLabel = busy ? t('projectChecking') : missing.length > 0 ? t('projectCheck') : t('openProject')
		return h(
			Modal,
			{ title: t('project'), onClose: props.onClose, t: t },
			h(
		'div',
		{ className: 'gbt-form' },
		h('div', { className: 'gbt-field' }, h('label', null, t('project')), h('input', { className: 'gbt-input', ref: input, placeholder: t('projectPlaceholder'), defaultValue: draft, 'data-project-input': 'true' })),
		hostProject === null ? null : h('p', { className: 'gbt-footnote', 'data-host-project': hostProject }, t('useCurrentProjectHint') + ' · ' + hostProject),
		missing.length === 0
			? null
			: h('div', { className: 'gbt-banner', 'data-project-missing': 'true', style: { margin: '0 0 8px' } },
				h('strong', null, t('projectMissingTitle')),
				h('ul', { className: 'gbt-footnote', 'data-project-missing-list': 'true' }, missing.map(function (label, index) { return h('li', { key: 'missing-' + String(index) }, String(label)) }))),
		error === '' ? null : h('p', { className: 'gbt-footnote', 'data-project-error': 'true' }, error),
		h('div', { className: 'gbt-actions' },
			h('button', { type: 'button', className: 'gbt-btn', 'data-action': 'use-current-project', title: t('useCurrentProjectHint'), disabled: hostProject === null || busy, onClick: useCurrent }, '⌖ ' + t('useCurrentProject')),
			h('button', { type: 'button', className: 'gbt-btn', 'data-variant': 'primary', 'data-busy': busy ? 'true' : 'false', 'data-project-primary': missing.length > 0 ? 'check' : 'open', disabled: busy, onClick: open }, busy ? h('span', null, h('span', { className: 'gbt-spinner' }), primaryLabel) : primaryLabel),
			h('button', { type: 'button', className: 'gbt-btn', disabled: busy, onClick: props.onClose }, t('cancel'))),
			),
		)
	}

	/**
	 * Where the Host got the project on screen (T-90): 'session' means it came
	 * from the session workspace walk-up, 'manual' from a path this browser or
	 * a caller pinned, 'registry' from the project registry.
	 */

	return ProjectForm
}

module.exports = { createProjectForm }

				})(module, module.exports)
				const factory = module.exports.createProjectForm
				return factory({
					React: React,
					h: h,
					Modal: Modal,
					projectFormState: projectFormState,
					store: store,
					tcErrorMessage: tcErrorMessage,
				})
			})()

			// The drawer's list state lives here (not only in React state) so the
			// fetches that resolve between renders are visible to the next one; a
			// state counter still drives the real React re-render.
			const doneAllState = { items: [], next: null, loading: true, error: false, failedMore: false, query: '', loadedQuery: null, token: 0, busy: false }
			const DoneAllDrawer = (function () {
				const module = { exports: {} }
				;(function (module, exports) {
/**
 * Completed-tasks drawer view module.
 *
 * Extracted from the views fragments; React, h, the mutable done-all state and
 * the local day bucket are injected by the build.
 */
function createDoneAllDrawer(deps) {
	const React = deps.React
	const h = deps.h
	const doneAllState = deps.doneAllState
	const tcDayKey = deps.tcDayKey

	function DoneAllDrawer(props) {
		const t = props.t
		const list = props.store
		const archived = props.archived === true
		const [, setVersion] = React.useState(0)
		const bump = function () { setVersion(function (value) { return value + 1 }) }
		const items = doneAllState.items
		const next = doneAllState.next
		const query = doneAllState.query
		const loading = doneAllState.loading
		const error = doneAllState.error
		const failedMore = doneAllState.failedMore
		const now = Date.now()

		function applyPage(payload, reset) {
			if (payload === null || payload === undefined || payload.ok !== true) {
		doneAllState.error = true
		doneAllState.loading = false
		bump()
		return false
			}
			const page = Array.isArray(payload.tasks) ? payload.tasks : []
			if (reset === true) {
		doneAllState.items = page
			} else {
		const seen = new Set(doneAllState.items.map(function (task) { return task.id }))
		doneAllState.items = doneAllState.items.concat(page.filter(function (task) { return !seen.has(task.id) }))
			}
			doneAllState.next = typeof payload.nextCursor === 'string' && payload.nextCursor !== '' ? payload.nextCursor : null
			doneAllState.error = false
			doneAllState.failedMore = false
			doneAllState.loading = false
			bump()
			return true
		}

		React.useEffect(function () {
			if (doneAllState.loadedQuery === query) return
			doneAllState.loadedQuery = query
			const token = doneAllState.token + 1
			doneAllState.token = token
			doneAllState.loading = true
			doneAllState.error = false
			doneAllState.failedMore = false
			const handle = setTimeout(function () {
		void list.listTasks({ status: 'done', q: query, limit: 50, archived: archived }).then(function (payload) {
			if (token !== doneAllState.token) return
			applyPage(payload, true)
		})
			}, query === '' ? 0 : 250)
			return function () { clearTimeout(handle) }
		}, [query])

		function loadMore() {
			if (next === null || doneAllState.busy === true) return
			doneAllState.busy = true
			doneAllState.loading = true
			bump()
			const token = doneAllState.token
			void list.listTasks({ status: 'done', q: query, cursor: next, limit: 50, archived: archived }).then(function (payload) {
		doneAllState.busy = false
		if (token !== doneAllState.token) return
		if (!applyPage(payload, false)) {
			doneAllState.failedMore = true
			bump()
		}
			})
		}

		function retry() {
			doneAllState.loadedQuery = null
			doneAllState.token += 1
			doneAllState.loading = true
			doneAllState.error = false
			bump()
			void list.listTasks({ status: 'done', q: query, limit: 50, archived: archived }).then(function (payload) {
		applyPage(payload, true)
			})
		}

		const buckets = { today: [], yesterday: [], earlier: [] }
		for (const task of items) buckets[tcDayKey(task.updatedAt, now)].push(task)
		const sections = [
			{ key: 'today', label: t('doneAllToday') },
			{ key: 'yesterday', label: t('doneAllYesterday') },
			{ key: 'earlier', label: t('doneAllEarlier') },
		].filter(function (section) { return buckets[section.key].length > 0 })

		return h(
			'div',
			{ className: 'gbt-detailoverlay', 'data-done-all-overlay': 'true' },
			h('div', { className: 'gbt-detailmask', onClick: props.onClose }),
			h(
		'div',
		{ className: 'gbt-detailpanel', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('doneAllTitle') },
		h(
			'div',
			{ className: 'gbt-drawerhead' },
			h('strong', null, t(archived ? 'archiveTitle' : 'doneAllTitle')),
			h('span', { className: 'gbt-muted' }, ' · ' + t('doneAllCount').replace('{n}', String(Number.isFinite(props.total) ? props.total : items.length))),
			h('span', { className: 'gbt-muted' }, ' · ' + t('doneAllLoaded').replace('{n}', String(items.length))),
			h('button', { type: 'button', className: 'gbt-iconbtn', onClick: props.onClose, 'aria-label': t('doneAllTitle') }, '×'),
		),
		h(
			'div',
			{ className: 'gbt-drawerbody', style: { display: 'flex', flexDirection: 'column' } },
			h('div', { className: 'gbt-donelist', style: { paddingBottom: 0 } }, h('input', {
				type: 'search',
				className: 'gbt-input',
				value: query,
				placeholder: t('doneAllSearch'),
				'aria-label': t('doneAllSearch'),
				onChange: function (event) {
			doneAllState.query = String(event.target.value)
			doneAllState.loadedQuery = null
			doneAllState.loading = true
			bump()
				},
			})),
			error === true && items.length === 0
				? h(
				'div',
				{ className: 'gbt-donelist' },
				h('div', { className: 'gbt-banner' }, t('doneAllError')),
				h('div', null, h('button', { type: 'button', className: 'gbt-btn', onClick: retry }, t('doneAllRetry'))),
			)
				: loading === true && items.length === 0
			? h(
					'div',
					{ className: 'gbt-donelist', 'data-done-all-loading': 'true' },
					Array.from({ length: 6 }).map(function (value, index) {
				return h('div', { key: 'skeleton-' + String(index), className: 'gbt-skel' })
					}),
				)
			: items.length === 0
				? h('div', { className: 'gbt-donelist' }, h('div', { className: 'gbt-empty' }, t(archived ? 'archiveEmpty' : 'doneAllEmpty')))
				: h(
				'div',
				{
					className: 'gbt-donelist',
					style: { overflow: 'auto', flex: '1', minHeight: 0 },
					onScroll: function (event) {
						const node = event.target
						if (node.scrollTop + node.clientHeight >= node.scrollHeight - 48) loadMore()
					},
				},
				sections.map(function (section) {
					return h(
						'div',
						{ key: section.key, 'data-done-group': section.key },
						h('div', { className: 'gbt-donetitle' }, section.label),
						buckets[section.key].map(function (task) {
					return h(
						'button',
						{
							key: task.id,
							type: 'button',
							className: 'gbt-donerow',
							'data-done-row': task.id,
							onClick: function () { props.onOpen(task.id) },
						},
						h('span', { className: 'gbt-id' }, task.id),
						h('span', { className: 'gbt-donetitletext' }, String(task.title === undefined ? '' : task.title)),
						h('span', { className: 'gbt-donewhen' }, task.updatedAt === null || task.updatedAt === undefined ? '' : String(task.updatedAt).slice(0, 10)),
					)
						}),
					)
				}),
				failedMore === true ? h('div', { className: 'gbt-banner' }, t('doneAllError')) : null,
				next === null
					? null
					: h(
					'div',
					{ style: { padding: '10px 0 4px' } },
					h('button', { type: 'button', className: 'gbt-btn', 'data-action': 'done-more', disabled: loading, onClick: loadMore }, loading ? t('doneAllLoading') : t('doneAllLoadMore')),
						),
					),
		),
			),
		)
	}

	/** One ready/waiting queue row: id, title, and summary-only chips. */

	return DoneAllDrawer
}

module.exports = { createDoneAllDrawer }

				})(module, module.exports)
				const factory = module.exports.createDoneAllDrawer
				return factory({ React: React, h: h, doneAllState: doneAllState, tcDayKey: tcDayKey })
			})()

			function doneAllReset() {
				doneAllState.items = []
				doneAllState.next = null
				doneAllState.loading = true
				doneAllState.error = false
				doneAllState.failedMore = false
				doneAllState.query = ''
				doneAllState.loadedQuery = null
				doneAllState.busy = false
				doneAllState.token += 1
			}

			const Glyph = (function () {
				const module = { exports: {} }
				;(function (module, exports) {
/**
 * Sidebar glyph view module.
 *
 * Extracted from the shell fragment; h is injected by the build.
 */
function createGlyph(deps) {
	const h = deps.h

	function Glyph(props) {
		const size = typeof props.size === 'number' ? props.size : 18
		const active = props.active === true
		// The sidebar row itself carries no stable attribute and its aria-label
		// is localized; this glyph is inside that row's <button>, so clicking it
		// bubbles to selectPanel and gives shot tools a locale-independent target.
		return h(
			'span',
			{ className: 'gbt-glyphwrap', 'data-panel': 'task-center' },
			h(
		'svg',
		{ className: 'gbt-glyph', width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
		h('rect', { x: 1.5, y: 2, width: 13, height: 12, rx: 2.4, stroke: 'currentColor', strokeWidth: active ? 1.6 : 1.3 }),
		h('path', { d: 'M5.6 4.6v6.8M10.4 4.6v6.8', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round' }),
			),
		)
	}


	return Glyph
}

module.exports = { createGlyph }

				})(module, module.exports)
				const factory = module.exports.createGlyph
				return factory({ h: h })
			})()

			const DecisionModal = (function () {
				const module = { exports: {} }
				;(function (module, exports) {
/**
 * DecisionRequest modal + compact card view modules (T-195, T-208).
 *
 * The host may ask ONE critical question at a time and queue the rest. This
 * module renders that queue front-to-back: the common modal copy from the
 * requirement packet (title, task/event subtitle, server countdown, queue
 * count, default badge), the options, an optional free-text answer, and the
 * DELETE confirmation for a destructive option. Event-specific copy is
 * supplied by the caller's eventLabel/body/title — this module knows nothing
 * about create/review/test.
 *
 * T-208: the answer form is ONE hook (useDecisionForm) rendered by two
 * surfaces — the panel's full modal (DecisionModal) and the shell overlay's
 * compact, docked card (DecisionCard). Both therefore show the same fields and
 * submit the same body (decisionAnswerPayload); the surfaces cannot drift.
 *
 * Countdown: the host sends remainingMs from ITS clock. The panel stores the
 * snapshot receipt time, so the rendered seconds are the server deadline minus
 * the local elapsed time; a browser clock offset cannot shorten or extend it.
 * Once a decision's deadline passes the PANEL still lets the user see it until
 * the next poll removes it, but the host refuses the late answer (decision-expired).
 *
 * Injected by the build: React (useState/useEffect/useRef) and h.
 */
function createDecisionModal(deps) {
	const React = deps.React
	const h = deps.h
	const CONFIRM_WORD = 'DELETE'

	/** Seconds left from the SERVER deadline (remainingMs at receipt time). */
	function decisionRemainingSeconds(decision, receivedAt, now) {
		if (decision === null || decision === undefined) return null
		const remaining = decision.remainingMs
		if (remaining === null || remaining === undefined || !Number.isFinite(remaining)) return null
		const received = Number.isFinite(receivedAt) ? receivedAt : now
		const elapsed = Number.isFinite(now) ? Math.max(0, now - received) : 0
		return Math.max(0, Math.ceil((remaining - elapsed) / 1000))
	}

	/** "{taskId} · {eventLabel}" — the packet's common subtitle. */
	function decisionSubtitle(decision, t) {
		if (decision === null || decision === undefined) return ''
		const label = typeof decision.eventLabel === 'string' && decision.eventLabel !== '' ? decision.eventLabel : t('decisionSubtitleFallback')
		const taskId = typeof decision.taskId === 'string' && decision.taskId !== '' ? decision.taskId : null
		return taskId === null ? label : taskId + ' · ' + label
	}

	/** The option object flagged as the default (the timeout choice). */
	function decisionDefaultOption(decision) {
		if (decision === null || decision === undefined || !Array.isArray(decision.options)) return null
		const wanted = typeof decision.defaultOption === 'string' ? decision.defaultOption : null
		const chosen = decision.options.filter((option) => option.default === true || (wanted !== null && option.id === wanted))[0]
		return chosen === undefined ? null : chosen
	}

	/** The label of the option flagged as the default (the timeout choice). */
	function decisionDefaultLabel(decision) {
		const chosen = decisionDefaultOption(decision)
		return chosen === null ? null : chosen.label
	}

	/**
	 * Would the SERVER auto-select the default at the deadline?
	 *
	 * The host refuses to auto-run a dangerous option (it expires the request
	 * "requires-manual"), so the countdown must not promise it. The server sends
	 * the policy as autoRunAllowed; a decision without that field is judged from
	 * its own default option (an older host or a test fixture).
	 */
	function decisionAutoRunAllowed(decision) {
		if (decision === null || decision === undefined) return false
		if (decision.autoRunAllowed === true) return true
		if (decision.autoRunAllowed === false) return false
		const chosen = decisionDefaultOption(decision)
		const hasDeadline = typeof decision.timeoutAt === 'string' && decision.timeoutAt !== ''
		return hasDeadline && chosen !== null && chosen.danger !== true
	}

	/** The countdown sentence, or the protected/no-deadline sentence. */
	function decisionCountdownText(decision, receivedAt, now, t) {
		const seconds = decisionRemainingSeconds(decision, receivedAt, now)
		if (seconds === null) return t('decisionNoCountdown')
		if (decisionAutoRunAllowed(decision) !== true) {
			const protectedLabel = decisionDefaultLabel(decision)
			if (protectedLabel === null) return t('decisionCountdownProtectedNoDefault').replace('{seconds}', String(seconds))
			return t('decisionCountdownProtected').replace('{seconds}', String(seconds)).replace('{defaultLabel}', protectedLabel)
		}
		const defaultLabel = decisionDefaultLabel(decision)
		if (defaultLabel === null) return t('decisionNoCountdown')
		return t('decisionCountdown').replace('{seconds}', String(seconds)).replace('{defaultLabel}', defaultLabel)
	}

	/** The option the form starts on: the marked default, when there is one. */
	function decisionInitialOption(decision) {
		if (decision === null || decision === undefined) return null
		const wanted = typeof decision.defaultOption === 'string' ? decision.defaultOption : null
		if (wanted === null) return null
		const known = (Array.isArray(decision.options) ? decision.options : []).filter((option) => option.id === wanted)[0]
		return known === undefined ? null : known.id
	}

	/**
	 * Whether the confirm button may submit. A destructive option requires the
	 * exact DELETE word; with no options the free text must be non-empty.
	 */
	function decisionCanConfirm(decision, optionId, text, confirmText) {
		if (decision === null || decision === undefined) return false
		const option = (Array.isArray(decision.options) ? decision.options : []).filter((candidate) => candidate.id === optionId)[0]
		if (option === undefined) return typeof text === 'string' && text.trim() !== ''
		if (option.danger === true && confirmText !== CONFIRM_WORD) return false
		return true
	}

	/**
	 * The body the Host expects for one answer. Shared by the panel's modal and
	 * the shell overlay, so both post exactly the same fields (T-208 §8).
	 */
	function decisionAnswerPayload(decision, answer) {
		const source = answer === undefined || answer === null ? {} : answer
		const body = { decisionId: decision === null || decision === undefined ? '' : decision.id }
		if (source.option !== undefined) body.option = source.option
		if (typeof source.text === 'string' && source.text !== '') body.text = source.text
		if (typeof source.confirm === 'string' && source.confirm !== '') body.confirm = source.confirm
		return body
	}

	/**
	 * The ONE answer form (T-208). A hook rather than a nested element: the
	 * panel's modal root ('.gbt-decision') must stay the direct child of
	 * '.gbt-decisionoverlay' — the shipped CSS and the T-195 selectors key on
	 * that exact shape — while the overlay's compact card renders the same
	 * fields inside its own docked root.
	 *
	 * Returns null when there is no decision; the hooks above it still run so
	 * the count is stable between renders of the same mount.
	 */
	function useDecisionForm(current, t, props) {
		const safe = props === undefined || props === null ? {} : props
		const [tick, setTick] = React.useState(0)
		React.useEffect(function () {
			if (typeof setInterval !== 'function') return undefined
			const handle = setInterval(function () {
				setTick(function (value) { return value + 1 })
			}, 1000)
			return function () { clearInterval(handle) }
		}, [])
		const [selected, setSelected] = React.useState(current === null ? null : decisionInitialOption(current))
		const [text, setText] = React.useState('')
		const [confirmText, setConfirmText] = React.useState('')
		if (current === null || current === undefined) return null
		// The one-second tick re-renders this form; read the clock then, so the
		// countdown keeps moving even while the parent's polling snapshot is idle.
		const now = Date.now()
		const chosenId = selected === null || selected === undefined ? decisionInitialOption(current) : selected
		const chosen = (Array.isArray(current.options) ? current.options : []).filter((option) => option.id === chosenId)[0] || null
		const danger = chosen !== null && chosen.danger === true
		const canConfirm = decisionCanConfirm(current, chosenId, text, confirmText)
		const submitting = safe.busy === true

		const optionNodes = (Array.isArray(current.options) ? current.options : []).map(function (option) {
			const isSelected = option.id === chosenId
			return h(
				'button',
				{
					key: option.id,
					type: 'button',
					className: 'gbt-decisionoption',
					'data-decision-option': option.id,
					'data-selected': isSelected ? 'true' : 'false',
					'data-danger': option.danger === true ? 'true' : 'false',
					disabled: submitting,
					onClick: function () {
						setSelected(option.id)
						setConfirmText('')
					},
				},
				h(
					'span',
					{ className: 'gbt-decisionoptionbody' },
					h('span', { className: 'gbt-decisionoptionlabel' }, option.label),
					typeof option.description === 'string' && option.description !== '' ? h('span', { className: 'gbt-decisionoptiondesc' }, option.description) : null,
				),
				option.default === true || option.id === current.defaultOption
					? h('span', { className: 'gbt-decisionbadge', 'data-decision-default': 'true' }, t('decisionDefaultBadge'))
					: null,
			)
		})

		const openTask =
			typeof current.taskId === 'string' && current.taskId !== '' && typeof safe.onOpenTask === 'function'
				? h(
						'button',
						{
							type: 'button',
							className: 'gbt-btn',
							'data-decision-open-task': 'true',
							onClick: function () { safe.onOpenTask(current.taskId) },
						},
						t('decisionOpenTask'),
					)
				: null

		const error = typeof safe.error === 'string' && safe.error !== ''
			? h('p', { className: 'gbt-decisionerror', 'data-decision-error': 'true', role: 'alert' }, safe.error)
			: null

		return {
			canConfirm: canConfirm,
			danger: danger,
			nodes: [
				h('p', { key: 'subtitle', className: 'gbt-decisionsub', 'data-decision-subtitle': 'true' }, decisionSubtitle(current, t)),
				h('p', { key: 'countdown', className: 'gbt-decisioncountdown', 'data-decision-countdown': 'true' }, decisionCountdownText(current, safe.receivedAt, now, t)),
				current.title === '' ? null : h('p', { key: 'headline', className: 'gbt-decisionbody', 'data-decision-headline': 'true' }, current.title),
				current.body === '' ? null : h('p', { key: 'body', className: 'gbt-decisionbody', 'data-decision-body': 'true' }, current.body),
				optionNodes.length === 0 ? null : h('div', { key: 'options', className: 'gbt-decisionoptions', 'data-decision-options': 'true' }, optionNodes),
				h(
					'label',
					{ key: 'text', className: 'gbt-decisiontext' },
					h('span', null, t('decisionTextLabel')),
					h('textarea', {
						className: 'gbt-input gbt-editorarea',
						style: { minHeight: '56px' },
						value: text,
						placeholder: current.eventKey === 'create' ? t('decisionCreateTextPlaceholder') : t('decisionTextPlaceholder'),
						'data-decision-text': 'true',
						disabled: submitting,
						onChange: function (event) { setText(String(event.target.value)) },
					}),
				),
				danger
					? h(
							'label',
							{ key: 'highrisk', className: 'gbt-decisionhighrisk', 'data-decision-highrisk': 'true' },
							h('span', null, t('decisionHighRiskLabel')),
							h('input', {
								className: 'gbt-input gbt-decisionhighriskin',
								value: confirmText,
								placeholder: CONFIRM_WORD,
								'data-decision-confirm': 'true',
								disabled: submitting,
								onChange: function (event) { setConfirmText(String(event.target.value)) },
							}),
							h('span', { className: 'gbt-footnote' }, t('decisionHighRiskHint')),
						)
					: null,
				error,
				h(
					'div',
					{ key: 'foot', className: 'gbt-decisionfoot' },
					openTask,
					h(
						'button',
						{
							type: 'button',
							className: 'gbt-btn',
							'data-variant': 'primary',
							'data-decision-confirm-submit': 'true',
							disabled: !canConfirm || submitting,
							'data-decision-can-confirm': canConfirm ? 'true' : 'false',
							onClick: function () {
								if (!canConfirm || typeof safe.onAnswer !== 'function') return
								safe.onAnswer(current, { option: chosenId, text: text, confirm: confirmText })
							},
						},
						submitting ? t('decisionAnswering') : t('decisionConfirm'),
					),
				),
			],
		}
	}

	/**
	 * The panel's full modal: the generic plugin view with one foregrounded
	 * decision, the queued count and the answer form. It never renders a close
	 * button — a question is resolved by answering one of its options (a
	 * "return"/"keep" option is one of them).
	 */
	function DecisionModal(props) {
		const safe = props === undefined || props === null ? {} : props
		const t = typeof safe.t === 'function' ? safe.t : function (key) { return key }
		const queue = Array.isArray(safe.queue) ? safe.queue : []
		const current = queue.length === 0 ? null : queue[0]
		// The form's hooks run even for an empty queue (it returns null), keeping
		// the hook order stable when the last decision is answered.
		const form = useDecisionForm(current, t, safe)
		if (current === null || form === null) return null
		const queueLeft = queue.length - 1
		return h(
			'div',
			{ className: 'gbt-decisionoverlay', 'data-decision-overlay': 'true' },
			h(
				'div',
				{ className: 'gbt-decision', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'gbt-decision-title', 'data-decision-id': current.id },
				h(
					'div',
					{ className: 'gbt-decisionhead' },
					h('h2', { id: 'gbt-decision-title', 'data-decision-title': 'true' }, t('decisionTitle')),
					h('span', { className: 'gbt-muted', 'data-decision-queue': 'true' }, queueLeft > 0 ? t('decisionQueue').replace('{n}', String(queueLeft)) : ''),
				),
				form.nodes,
			),
		)
	}

	/**
	 * The shell overlay's compact card (T-208). Same form, same one-shot answer;
	 * the collapse control is the only thing the modal does not have, because a
	 * docked card may be put away without answering (the chip stays visible).
	 */
	function DecisionCard(props) {
		const safe = props === undefined || props === null ? {} : props
		const t = typeof safe.t === 'function' ? safe.t : function (key) { return key }
		const decision = safe.decision === undefined ? null : safe.decision
		const form = useDecisionForm(decision === undefined ? null : decision, t, safe)
		if (decision === null || decision === undefined || form === null) return null
		const queueLeft = Number.isFinite(safe.queueLeft) && safe.queueLeft > 0 ? Math.round(safe.queueLeft) : 0
		const dismiss = typeof safe.onDismiss === 'function' ? safe.onDismiss : null
		return h(
			'div',
			{ className: 'gbt-decision gbt-decisioncompact', role: 'dialog', 'aria-label': t('decisionTitle'), 'data-decision-card': 'true', 'data-decision-id': decision.id },
			h(
				'div',
				{ className: 'gbt-decisionhead' },
				h('h2', { 'data-decision-title': 'true' }, t('decisionTitle')),
				queueLeft > 0 ? h('span', { className: 'gbt-muted', 'data-decision-queue': 'true' }, t('decisionQueue').replace('{n}', String(queueLeft))) : null,
				dismiss === null
					? null
					: h(
							'button',
							{
								type: 'button',
								className: 'gbt-decisionclose',
								'data-decision-collapse': 'true',
								'aria-label': t('decisionOverlayCollapse'),
								title: t('decisionOverlayCollapse'),
								onClick: function () { dismiss() },
							},
							'×',
						),
			),
			form.nodes,
		)
	}

	DecisionModal.decisionRemainingSeconds = decisionRemainingSeconds
	DecisionModal.decisionSubtitle = decisionSubtitle
	DecisionModal.decisionInitialOption = decisionInitialOption
	DecisionModal.decisionCanConfirm = decisionCanConfirm
	DecisionModal.decisionCountdownText = decisionCountdownText
	DecisionModal.decisionDefaultOption = decisionDefaultOption
	DecisionModal.decisionAutoRunAllowed = decisionAutoRunAllowed
	DecisionModal.decisionAnswerPayload = decisionAnswerPayload
	DecisionModal.DecisionCard = DecisionCard
	DecisionModal.CONFIRM_WORD = CONFIRM_WORD
	return DecisionModal
}

module.exports = { createDecisionModal }

				})(module, module.exports)
				const factory = module.exports.createDecisionModal
				return factory({ React: React, h: h })
			})()
			const TaskCenter = (function () {
				const module = { exports: {} }
				;(function (module, exports) {
/**
 * Task center shell view module.
 *
 * Extracted from the forms/shell fragments; React, h, the five views, the
 * forms, the panel hooks/state and the project/header helpers are injected by
 * the build.
 */
function createTaskCenter(deps) {
	const React = deps.React
	const h = deps.h
	const Board = deps.Board
	const QueueView = deps.QueueView
	const WorkersView = deps.WorkersView
	const StatusView = deps.StatusView
	const RolesView = deps.RolesView
	const DetailView = deps.DetailView
	const DoneAllDrawer = deps.DoneAllDrawer
	const TaskForm = deps.TaskForm
	// T-205: the settings entry opens a PAGE, not a modal. SettingsPage is the same
	// component the plugin bundle card mounts; engineScopeOf reads the config scope
	// the engine-path section writes (null when this runtime has no config form).
	const SettingsPage = deps.SettingsPage
	const engineScopeOf = deps.engineScopeOf
	const ProjectForm = deps.ProjectForm
	const DecisionModal = deps.DecisionModal
	const useTranslate = deps.useTranslate
	const useSnapshot = deps.useSnapshot
	const useNow = deps.useNow
	const panelState = deps.panelState
	const projectFormState = deps.projectFormState
	const doneAllReset = deps.doneAllReset
	const projectMismatchOf = deps.projectMismatchOf
	const tcAgo = deps.tcAgo
	const tcAgentTreeOf = deps.tcAgentTreeOf
	const tcAgentStatusKey = deps.tcAgentStatusKey
	const roleKindLabel = deps.roleKindLabel
	const copyToClipboard = deps.copyToClipboard
	const store = deps.store
	// T-155: one workspace-follow driver per panel. key memoises the attempt per
	// (board, chat) pair, so a setup/failed workspace is not retried on every poll.
	const workspaceSwitch = { key: null, status: 'idle', board: null, target: null, error: '', missing: [], fade: false, fadeFrames: false }
	// T-158: the board kind filter now lives in the toolbar row (not inside the
	// board scrollport), so its state belongs to the panel shell.
	const panelBoardUi = { kind: 'all' }

	/**
	 * T-203: WHERE the board's project came from, exactly as the Host named it.
	 *
	 *   'session'  this chat's own workspace (a recorded binding or the DSH session
	 *              directory lookup — the same source to the human);
	 *   'panel'    an explicit pin made from this panel;
	 *   'explicit' a path the caller passed;
	 *   'registry' a project the registry already knew;
	 *   'unbound'  nothing is bound — a SETUP state, never a last-active project.
	 *
	 * Keeping the raw value on the DOM (data-project-source / data-workspace-source)
	 * is what stops the panel from re-deriving "whose project is this" from a path
	 * comparison that cannot tell a pin from the chat's workspace.
	 */
	function boardSourceOf(snapshot) {
		if (snapshot === null || snapshot === undefined) return null
		const value = typeof snapshot.resolvedFrom === 'string' ? snapshot.resolvedFrom : null
		if (value === 'session' || value === 'session-lookup') return 'session'
		if (value === 'panel' || value === 'explicit' || value === 'registry' || value === 'unbound') return value
		// A setup snapshot on an older Host has no source field: "no project" is
		// still unbound, never an inherited last-active project.
		if (snapshot.source === 'setup' || snapshot.project === null || snapshot.project === undefined) return 'unbound'
		return null
	}

	/** The dictionary label for a source, or null when there is nothing to say. */
	function boardSourceLabelOf(source, t) {
		if (source === 'session') return t('projectSourceSession')
		if (source === 'panel' || source === 'explicit') return t('projectSourceManual')
		if (source === 'registry') return t('projectSourceRegistry')
		// 'unbound' has no project to describe; the empty state's own wording says it.
		return null
	}

	function TaskCenter(props) {
		const t = useTranslate()
		const snapshot = useSnapshot()
		const now = useNow(5000)
		// Rendering tests may pick the first view; the production slot passes no props.
		const initialView = props !== undefined && props !== null && ['board', 'queue', 'workers', 'status', 'roles'].indexOf(props.initialView) >= 0 ? props.initialView : panelState.view
		const [view, setViewState] = React.useState(initialView)
		const [selectedId, setSelectedIdState] = React.useState(panelState.selectedId)
		const [editing, setEditing] = React.useState(null)
		const [doneAllOpen, setDoneAllOpenState] = React.useState(panelState.doneAllOpen)
		const [doneAllArchived, setDoneAllArchivedState] = React.useState(panelState.doneAllArchived)
		function setDoneAllArchived(next) {
			panelState.doneAllArchived = next
			setDoneAllArchivedState(next)
		}
		function setDoneAllOpen(next) {
			panelState.doneAllOpen = next
			setDoneAllOpenState(next)
		}
		const [, setColumnTick] = React.useState(0)
		function setView(next) {
			panelState.view = next
			setViewState(next)
		}
		function setSelectedId(next) {
			panelState.selectedId = next
			setSelectedIdState(next)
		}
		// Rendering tests may land directly on the settings page; the production slot
		// passes no props.
		const initialSettingsOpen = props !== undefined && props !== null && props.initialSettingsOpen === true
		const [settingsOpen, setSettingsOpen] = React.useState(initialSettingsOpen)
		// T-174: theme is a browser preference, never a dispatch/server field.
		function readTheme() {
			try {
				const raw = typeof window !== 'undefined' && window !== null && window.localStorage !== undefined && typeof window.localStorage.getItem === 'function' ? window.localStorage.getItem('gbt-theme') : null
				return raw === 'console' ? 'console' : 'dsh'
			} catch (error) {
				return 'dsh'
			}
		}
		const [theme, setThemeState] = React.useState(readTheme)
		function setTheme(next) {
			const value = next === 'console' ? 'console' : 'dsh'
			try {
				if (typeof window !== 'undefined' && window !== null && window.localStorage !== undefined && typeof window.localStorage.setItem === 'function') window.localStorage.setItem('gbt-theme', value)
			} catch (error) {
				// A storage denial must not break the panel; the in-memory theme still applies.
			}
			setThemeState(value)
		}
		// Rendering tests may open the project dialog; the production slot passes no props.
		const initialProjectOpen = props !== undefined && props !== null && props.initialProjectOpen === true
		const [projectOpen, setProjectOpen] = React.useState(initialProjectOpen)
		// T-195: the host decision queue. One question is foregrounded; "view card"
		// hides the modal so the drawer behind it is readable, and closing the
		// drawer brings the same question back (it is still pending).
		const [decisionPeek, setDecisionPeek] = React.useState(false)
		// T-155: drives the auto-follow render pass and the retry action.
		const [workspaceTick, setWorkspaceTick] = React.useState(0)
		// T-150/T-155: copy confirmation for the owning session id in the header.
		// Module-backed so a remount (view switch, polling render) still shows the
		// toast that the copy really happened.
		const [sessionCopied, setSessionCopiedState] = React.useState(panelState.sessionCopied === undefined ? null : panelState.sessionCopied)
		function setSessionCopied(next) {
			panelState.sessionCopied = next
			setSessionCopiedState(next)
		}
		// T-158: the two-row header keeps sessions, the live agent tree and the
		// overflow actions in popovers; all three are ALWAYS rendered and merely
		// hidden, so a closed popover still has its rows/actions in the DOM for
		// tests and for the next open without a remount.
		const [sessionsOpen, setSessionsOpen] = React.useState(false)
		const [agentsOpen, setAgentsOpen] = React.useState(false)
		const [menuOpen, setMenuOpen] = React.useState(false)
		function openProjectDialog() {
			projectFormState.value = null
			// T-155 §6: a fresh dialog starts without the previous failure's items.
			projectFormState.error = ''
			projectFormState.missing = []
			setProjectOpen(true)
		}
		function copySessionId(value) {
			if (typeof value !== 'string' || value === '') return
			void copyToClipboard(value).then(function (ok) {
			setSessionCopied(ok === true ? value : 'failed')
			})
		}
		React.useEffect(function () {
			void store.load()
			store.startPolling(2500)
			return function () {
		store.stopPolling()
			}
		}, [])

		const dispatch = snapshot.dispatch === undefined || snapshot.dispatch === null ? { state: 'paused' } : snapshot.dispatch
		const active = dispatch.state === 'running'
		const counts = snapshot.counts === undefined || snapshot.counts === null ? {} : snapshot.counts
		const tasks = snapshot.tasks
		// One stable content tree. A known project always renders the board shell;
		// loading only swaps lane contents (skeleton -> cards), never the shell.
		const loading = snapshot.source === 'loading' || (Array.isArray(tasks) && tasks.length === 0 && Number(counts.total) > 0)
		const selected = selectedId === null ? null : tasks.filter(function (task) { return task.id === selectedId })[0] || null
		const editingTask = editing === null || editing === 'new' ? null : (function () {
			const base = tasks.filter(function (task) { return task.id === editing })[0]
			if (base === undefined) return null
			return Object.assign({}, base, snapshot.details[editing] === undefined ? {} : snapshot.details[editing].task)
		})()
		const queue = snapshot.queue === undefined || snapshot.queue === null ? [] : snapshot.queue
		const scheduler = snapshot.scheduler
		const busy = snapshot.busy === undefined || snapshot.busy === null ? null : snapshot.busy
		// T-195: pending host decisions, oldest first (the host's queue order).
		const decisionQueue = Array.isArray(snapshot.decisions) ? snapshot.decisions : []
		// T-211: 'shell.overlay' is an OPTIONAL Host slot. When it is absent (or its
		// registration failed) the conversation-page chip never mounts; this header
		// entry keeps the pending queue reachable from the panel instead. It is
		// rendered only while no overlay mounted, so the two entries never stack.
		const decisionOverlayAvailable = typeof store.decisionOverlayAvailable === 'function' ? store.decisionOverlayAvailable() === true : false
		const decisionFallback =
			decisionQueue.length === 0 || decisionOverlayAvailable === true
				? null
				: h(
						'button',
						{
							key: 'decision-fallback',
							type: 'button',
							className: 'gbt-chip gbt-chipbtn gbt-decisionchip gbt-decisionheaderchip',
							'data-decision-header-fallback': 'true',
							'data-decision-fallback-count': String(decisionQueue.length),
							'aria-label': t('decisionOverlayAria'),
							title: t('decisionTitle'),
							onClick: function () { setDecisionPeek(false) },
						},
						h('span', { className: 'gbt-decisionchipdot', 'aria-hidden': 'true' }),
						h('span', { 'data-decision-chip-label': 'true' }, t('decisionOverlayChip').replace('{n}', String(decisionQueue.length))),
					)

		function isBusy(action, id) {
			return busy !== null && busy.action === action && (id === undefined || busy.id === id)
		}

		function openTask(id) {
			setSelectedId(id)
			void store.loadDetail(id)
		}
		function closeDetail() {
			setSelectedId(null)
			setDecisionPeek(false)
		}
		function openTaskFromDecision(id) {
			setDecisionPeek(true)
			setSelectedId(id)
			void store.loadDetail(id)
		}
		function answerDecision(decision, answer) {
			const body = { decisionId: decision.id, option: answer.option }
			if (typeof answer.text === 'string' && answer.text !== '') body.text = answer.text
			if (typeof answer.confirm === 'string' && answer.confirm !== '') body.confirm = answer.confirm
			void store.send('decisionAnswer', body)
		}
		function startEdit(task) {
			const id = task === null || task === undefined ? 'new' : task.id
			setEditing(id)
			if (id !== 'new') void store.loadDetail(id)
		}
		function toggleDispatch() {
			void store.send(active ? 'pause' : 'start')
		}

		// The panel never presents a team. Sessions are grouped from the Host's
		// explicit scope (the current chat session is highlighted, never primary),
		// and the execution view is the live agent tree.
		const scope = snapshot.scope !== null && snapshot.scope !== undefined && typeof snapshot.scope === 'object' ? snapshot.scope : null
		const scopeSessions = scope !== null && Array.isArray(scope.sessionSummaries)
			? scope.sessionSummaries.filter(function (row) { return row !== null && typeof row === 'object' })
			: []
		const scopePanelSession = scope !== null && typeof scope.panelSession === 'string' && scope.panelSession !== '' ? scope.panelSession : null
		const agentTree = tcAgentTreeOf(snapshot)
		const mismatchProject = projectMismatchOf(snapshot)
		const baseNameOf = function (value) {
			if (typeof value !== 'string' || value === '') return null
			const parts = value.split(/[\\/]/).filter(function (part) { return part !== '' })
			return parts.length === 0 ? value : parts[parts.length - 1]
		}
		const sessionShortOf = function (value) {
			if (typeof value !== 'string' || value === '') return '—'
			return value.indexOf('session-') === 0 ? value.slice(8, 16) : value.slice(0, 8)
		}
		const sessionStatusLabel = function (status) {
			if (status === 'live') return t('sessionsStatusLive')
			if (status === 'stale') return t('sessionsStatusStale')
			return t('sessionsStatusUnknown')
		}
		const tabs = [
			{ key: 'board', label: t('boardTab') },
			{ key: 'queue', label: t('queue') },
			{ key: 'workers', label: t('agentsTab') },
			{ key: 'status', label: t('statusTab') },
			{ key: 'roles', label: t('rolesTab') },
		]

		// T-155 §2/§3: the ONE workspace scope bar. It shows the board workspace and the
		// current chat workspace, auto-follows the chat workspace when it is a valid
		// project, keeps the old board on failure, and shows a setup card (not a
		// switch) when the chat workspace is not onboarded yet.
		const boardWorkspace = typeof snapshot.projectRoot === 'string' && snapshot.projectRoot !== '' ? snapshot.projectRoot : typeof snapshot.project === 'string' && snapshot.project !== '' ? snapshot.project : null
		// T-203: the source of the board workspace, shown next to it. It is what
		// makes "board ≠ chat" readable instead of a mystery.
		const boardSource = boardSourceOf(snapshot)
		const boardSourceLabel = boardSourceLabelOf(boardSource, t)
		const chatWorkspace = scope !== null && typeof scope.currentSessionProject === 'string' && scope.currentSessionProject !== '' ? scope.currentSessionProject : typeof snapshot.sessionProject === 'string' && snapshot.sessionProject !== '' ? snapshot.sessionProject : null
		const samePath = function (left, right) {
			if (typeof left !== 'string' || typeof right !== 'string') return false
			const norm = function (value) { return value.replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase() }
			return norm(left) === norm(right)
		}
		const workspaceMismatch =
			mismatchProject !== null || (boardWorkspace !== null && chatWorkspace !== null && samePath(boardWorkspace, chatWorkspace) !== true)
		const wsKey = boardWorkspace === null || chatWorkspace === null ? null : boardWorkspace + '|' + chatWorkspace
		const reduceMotion = (function () {
			try {
				return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches === true
			} catch (error) {
				return false
			}
		})()
		let workspaceState = 'same'
		if (boardWorkspace === null) workspaceState = 'hidden'
		// No chat workspace at all is a setup state: there is nothing to follow yet,
		// and the bar offers recheck / open-another-project instead of switching.
		else if (chatWorkspace === null) workspaceState = 'setup'
		else if (workspaceMismatch !== true) workspaceState = workspaceSwitch.fade === true ? 'followed' : 'same'
		else if (workspaceSwitch.key !== wsKey) workspaceState = 'switching'
		else workspaceState = workspaceSwitch.status
		// T-155 review: the fade is ONE render, not a permanent state. The first
		// settled render after a follow shows 'followed' + the fade class; the next
		// one drops both, so the steady state reads 同一工作区 and a SECOND follow
		// re-adds the class (which is what replays the CSS animation).
		if (workspaceState === 'followed') {
			if (workspaceSwitch.fadeFrames === true) {
				workspaceSwitch.fade = false
				workspaceSwitch.fadeFrames = false
				workspaceState = 'same'
			} else {
				workspaceSwitch.fadeFrames = true
			}
		}
		function retryWorkspace() {
			workspaceSwitch.key = null
			workspaceSwitch.status = 'idle'
			workspaceSwitch.error = ''
			workspaceSwitch.missing = []
			setWorkspaceTick(function (count) { return count + 1 })
			void store.load()
		}
		// One auto-follow per (board, chat) pair: a failed/setup workspace is not
		// retried on every poll; the bar's action is the explicit retry.
		React.useEffect(function () {
			if (workspaceMismatch !== true || wsKey === null || chatWorkspace === null) return
			if (workspaceSwitch.key === wsKey) return
			workspaceSwitch.key = wsKey
			workspaceSwitch.status = 'switching'
			workspaceSwitch.board = boardWorkspace
			workspaceSwitch.target = chatWorkspace
			workspaceSwitch.error = ''
			workspaceSwitch.missing = []
			setWorkspaceTick(function (count) { return count + 1 })
			void store.switchProject(chatWorkspace, { quiet: true }).then(function (result) {
				const payload = result === null || result === undefined || result.payload === undefined || result.payload === null ? {} : result.payload
				if (result !== null && result !== undefined && result.ok === true) {
					workspaceSwitch.status = 'followed'
					workspaceSwitch.fade = true
				} else {
					const code = typeof payload.code === 'string' ? payload.code : ''
					const preflight = payload.preflight !== null && payload.preflight !== undefined && typeof payload.preflight === 'object' ? payload.preflight : null
					const failedChecks = preflight !== null && Array.isArray(preflight.failed) ? preflight.failed : []
					const missing = []
					for (const check of failedChecks) {
						if (check !== null && typeof check === 'object' && typeof check.label === 'string' && check.label !== '') missing.push(check.label)
					}
					// "Not onboarded" (no git/board/team) is a SETUP state: the old board stays
					// and nothing is pinned. Any other failure is a readable switch error.
					// "Not onboarded" = the workspace exists but lacks git/board/team. A bad
					// path or an unreadable directory is a real switch FAILURE, not setup.
					const setup = ['not-a-repository', 'cannot-exclude', 'not-ready', 'no-project-bound'].indexOf(code) >= 0
					workspaceSwitch.status = setup ? 'setup' : 'failed'
					workspaceSwitch.missing = missing
					workspaceSwitch.error = typeof payload.message === 'string' && payload.message !== '' ? payload.message : code
				}
				setWorkspaceTick(function (count) { return count + 1 })
			})
		}, [wsKey, workspaceMismatch, workspaceTick])
		const workspaceActions = []
		// T-158: the chip's ONE explicit action. While the automatic follow is in
		// flight the button re-runs it (a stuck poll can always be retried); a
		// failure keeps the retry below.
		if (workspaceMismatch === true && (workspaceState === 'switching' || workspaceState === 'same' || workspaceState === 'followed')) {
			workspaceActions.push(h('button', { key: 'follow', type: 'button', className: 'gbt-btn', 'data-size': 'sm', 'data-action': 'workspace-follow', onClick: retryWorkspace }, t('workspaceFollowAction')))
		}
		if (workspaceState === 'failed') {
			workspaceActions.push(h('button', { key: 'retry', type: 'button', className: 'gbt-btn', 'data-variant': 'primary', 'data-action': 'workspace-retry', onClick: retryWorkspace }, t('workspaceRetry')))
		} else if (workspaceState === 'setup' || workspaceState === 'unknown') {
			workspaceActions.push(h('button', { key: 'recheck', type: 'button', className: 'gbt-btn', 'data-variant': 'primary', 'data-action': 'workspace-recheck', onClick: retryWorkspace }, t('workspaceRecheck')))
			workspaceActions.push(h('button', { key: 'open', type: 'button', className: 'gbt-btn', 'data-action': 'workspace-open-project', onClick: function () { openProjectDialog() } }, t('workspaceOpenOther')))
		}
		function workspaceStateText() {
			if (workspaceState === 'switching') {
				return [h('span', { key: 'spin', className: 'gbt-spinner', 'aria-hidden': 'true' }), h('span', { key: 'text' }, t('workspaceFollowing'))]
			}
			if (workspaceState === 'failed') {
				return t('workspaceSwitchFailed').replace('{error}', workspaceSwitch.error === '' ? '—' : workspaceSwitch.error)
			}
			if (workspaceState === 'setup') {
				if (chatWorkspace === null) return t('workspaceUnknown')
				const items = workspaceSwitch.missing.length === 0 ? t('workspaceNotReady') : t('workspaceNotReady') + ' · ' + t('workspaceMissing').replace('{items}', workspaceSwitch.missing.join('、'))
				return items
			}
			if (workspaceState === 'unknown') return t('workspaceUnknown')
			return '✓ ' + (workspaceState === 'followed' ? t('workspaceFollowed') : t('workspaceSame'))
		}
		// T-158: only a workspace that is NOT settled needs a chip (the steady state
		// "same workspace" was a full-width box in the header). Mismatch, switching,
		// setup and failure keep it — that is the ONE switch entry point.
		const workspaceBar =
			boardWorkspace === null && chatWorkspace === null
				? null
				: workspaceState === 'same' || workspaceState === 'followed'
					? null
					: h(
					'div',
					{
						className: 'gbt-workspacebar',
						'data-workspace-scope': 'true',
						'data-workspace-state': workspaceState,
						'data-workspace-tone': workspaceState === 'failed' ? 'error' : workspaceState === 'setup' || workspaceState === 'unknown' ? 'warn' : undefined,
						'data-project-mismatch': workspaceMismatch === true ? 'true' : undefined,
						'data-reduce-motion': reduceMotion ? 'true' : 'false',
						'data-board-workspace': boardWorkspace === null ? '' : boardWorkspace,
						'data-chat-workspace': chatWorkspace === null ? '' : chatWorkspace,
						'data-workspace-source': boardSource === null ? 'unknown' : boardSource,
					},
					h('span', { key: 'board', className: 'gbt-workspace', 'data-workspace': 'board' }, h('span', { className: 'gbt-workspacelabel' }, t('workspaceBoard')), h('b', { title: boardWorkspace === null ? '' : boardWorkspace }, baseNameOf(boardWorkspace) === null ? '—' : baseNameOf(boardWorkspace))),
					// T-203: the bar repeats the Host's source, so a board that came from a
					// panel pin reads as a pin and never as the chat's own workspace.
					h(
						'span',
						{
							key: 'source',
							// Reuse the header's source pill styling (no new CSS): same wording,
							// same colour language, so "会话" reads the same in both places.
							className: 'gbt-projectsource gbt-workspacesource',
							'data-project-source': boardSource === null ? 'unknown' : boardSource,
							'data-workspace-source': boardSource === null ? 'unknown' : boardSource,
							title: t('projectSourceHint'),
						},
						boardSourceLabel === null ? '—' : boardSourceLabel,
					),
					h('span', { key: 'arrow', className: 'gbt-workspacearrow', 'aria-hidden': 'true' }, '→'),
					h('span', { key: 'chat', className: 'gbt-workspace', 'data-workspace': 'chat' }, h('span', { className: 'gbt-workspacelabel' }, t('workspaceChat')), h('b', { title: chatWorkspace === null ? '' : chatWorkspace }, baseNameOf(chatWorkspace) === null ? '—' : baseNameOf(chatWorkspace))),
					h('span', { key: 'state', className: 'gbt-workspacestate', 'data-workspace-tone': workspaceState === 'failed' ? 'error' : workspaceState === 'setup' || workspaceState === 'unknown' ? 'warn' : undefined }, workspaceStateText()),
					workspaceActions.length === 0 ? null : h('span', { key: 'actions', className: 'gbt-workspaceactions' }, workspaceActions),
				)
		// ── T-158 two-row header ────────────────────────────────────────────────
		// Row 1: identity + context pills + workspace scope chip, then the ONE
		// primary action and the "more" popover. Row 2: tabs + kind filter +
		// refresh. The seven-count strip, the standalone status line and the flat
		// session chip row are gone; their facts live in the pills, the column
		// heads and the footer.
		function closePopovers() {
			setSessionsOpen(false)
			setAgentsOpen(false)
			setMenuOpen(false)
		}
		const projectName = baseNameOf(snapshot.project)
		const projectLabel = projectName === null ? t('projectUnknown') : projectName
		const panelSessionId = scopePanelSession
		const copySessionValue = panelSessionId === null ? '' : panelSessionId
		// T-210: the header no longer waits for the full /state. The light answer
		// carries the session scope, so the sessions pill is ready with the cards;
		// the agent tree arrives separately from /meta. While that deferred block
		// is loading only ITS OWN pill spins — and if it fails it says so instead
		// of spinning forever or reporting a fake zero.
		const metadata = snapshot.metadata !== null && snapshot.metadata !== undefined && typeof snapshot.metadata === 'object' ? snapshot.metadata : null
		const metadataStatus = metadata === null || typeof metadata.status !== 'string' ? 'unknown' : metadata.status
		// 'deferred' is what a light /state answers for the heavy blocks.
		const agentTreeDeferred = agentTree.error === 'deferred'
		const sessionsLoading = scope === null
		const agentsPending = agentTreeDeferred && (metadataStatus === 'idle' || metadataStatus === 'loading' || metadataStatus === 'unknown')
		const agentsDegraded = agentTreeDeferred && (metadataStatus === 'degraded' || metadataStatus === 'failed')
		const agentsState = agentsPending ? 'loading' : agentTree.root !== null ? 'ready' : 'none'
		const agentsPillLabel = agentsPending
			? t('loading')
			: agentsDegraded
				? t('agentsPillNone')
				: agentsState === 'ready'
					? t('agentsPillRoot').replace('{n}', String(agentTree.members.length))
					: t('agentsPillNone')
		const dispatchCap = dispatch.maxConcurrent === undefined || dispatch.maxConcurrent === null ? 3 : dispatch.maxConcurrent
		const sourceBadge =
			boardSourceLabel === null
				? null
				: h('span', { className: 'gbt-projectsource', 'data-project-source': boardSource, title: snapshot.projectWarning === null ? t('projectSourceHint') : snapshot.projectWarning }, boardSourceLabel)
		const brand = h(
			'div',
			{ className: 'gbt-brand', 'data-brand': 'true' },
			h('div', { className: 'gbt-mark' }, '▦'),
			h(
				'div',
				{ className: 'gbt-brandcopy' },
				h('div', { className: 'gbt-titleline' }, h('span', { className: 'gbt-eyebrow' }, t('title')), sourceBadge),
				h(
					'div',
					{ className: 'gbt-projectline' },
					h('b', { className: 'gbt-projectname', title: snapshot.project === null ? '' : snapshot.project }, projectLabel),
					h('span', { className: 'gbt-projectpath', title: snapshot.project === null ? '' : snapshot.project }, snapshot.project === null ? '' : snapshot.project),
					h('span', { className: 'gbt-projectsep', 'aria-hidden': 'true' }, '·'),
					h('span', { className: 'gbt-projecthint' }, t('sharedBoard')),
				),
			),
		)
		const sessionsButton = h(
			'button',
			{
				type: 'button',
				className: 'gbt-chip gbt-chipbtn gbt-sessionschip',
				'data-sessions-pill': 'true',
				'data-sessions-count': sessionsLoading ? 'loading' : String(scopeSessions.length),
				'data-loading': sessionsLoading ? 'true' : undefined,
				'aria-busy': sessionsLoading ? 'true' : undefined,
				'aria-haspopup': 'dialog',
				'aria-expanded': sessionsOpen ? 'true' : 'false',
				disabled: sessionsLoading,
				title: sessionsLoading ? t('loading') : t('sessionsHint'),
				onClick: function () { setSessionsOpen(!sessionsOpen) },
			},
			sessionsLoading
				? [h('span', { key: 'spin', className: 'gbt-spinner', 'aria-hidden': 'true' }), h('span', { key: 'text' }, t('loading'))]
				: [
					scopeSessions.length === 0
						? null
						: h('span', { key: 'dots', className: 'gbt-sessionsdots', 'aria-hidden': 'true' }, scopeSessions.slice(0, 5).map(function (row, index) { return h('i', { key: 'dot-' + String(index) }) })),
					h('span', { key: 'count' }, t('sessionsPill').replace('{n}', String(scopeSessions.length))),
					h('span', { key: 'caret', className: 'gbt-caret', 'aria-hidden': 'true' }, '▾'),
				],
		)
		const currentPill =
			panelSessionId === null
				? sessionsLoading
					? h('span', { className: 'gbt-chip gbt-currentsession', 'data-current-session-loading': 'true', 'aria-busy': 'true' }, h('span', { className: 'gbt-spinner', 'aria-hidden': 'true' }), h('span', null, t('loading')))
					: null
				: h('span', { className: 'gbt-chip gbt-currentsession', 'data-current-session': panelSessionId, title: panelSessionId }, h('span', { className: 'gbt-dot', 'data-running': 'true' }), h('b', { className: 'gbt-mono' }, sessionShortOf(panelSessionId)), h('span', { className: 'gbt-tag' }, t('sessionsCurrent')))
		const dispatchPill = h(
			'button',
			{
				type: 'button',
				className: 'gbt-chip gbt-chipbtn gbt-dispatchpill',
				'data-dispatch-pill': 'true',
				'data-dispatch-state': active ? 'running' : 'paused',
				'data-busy': isBusy('start') || isBusy('pause') ? 'true' : 'false',
				title: active ? t('pause') : t('start'),
				disabled: snapshot.source === 'error' || snapshot.project === null || busy !== null,
				onClick: toggleDispatch,
			},
			isBusy('start') || isBusy('pause') ? h('span', { className: 'gbt-spinner', 'aria-hidden': 'true' }) : h('span', { className: 'gbt-dot', 'data-running': active ? 'true' : 'false' }),
			h('span', null, active ? t('running') : t('paused')),
			h('b', null, String(counts.running || 0) + '/' + String(dispatchCap)),
		)
		const agentsPill = h(
			'button',
			{
				type: 'button',
				className: 'gbt-chip gbt-chipbtn gbt-agentpill',
				'data-agent-pill': agentsState,
				// T-210: the deferred agent tree has its OWN progress/degraded markers;
				// it never gates the sessions pill, the tabs or the board.
				'data-agent-deferred': agentTreeDeferred ? 'true' : undefined,
				'data-agent-degraded': agentsDegraded ? 'true' : undefined,
				'data-agent-root': agentTree.root !== null && typeof agentTree.root.name === 'string' ? agentTree.root.name : '',
				'data-agent-live': agentsPending ? 'loading' : String(agentTree.members.length),
				'data-loading': agentsPending ? 'true' : undefined,
				'aria-busy': agentsPending ? 'true' : undefined,
				'aria-haspopup': 'dialog',
				'aria-expanded': agentsOpen ? 'true' : 'false',
				disabled: agentsPending,
				title: agentsPending ? t('loading') : agentsDegraded ? t('agentsUnavailable') : t('agentsPopoverTitle'),
				onClick: function () { setAgentsOpen(!agentsOpen) },
			},
			agentsPending
				? h('span', { className: 'gbt-spinner', 'aria-hidden': 'true' })
				: h('span', { className: 'gbt-dot', 'data-running': agentsState === 'ready' ? 'true' : 'false' }),
			h('span', null, agentsPillLabel),
		)
		const sessionRows =
			scopeSessions.length === 0
				? [h('p', { key: 'empty', className: 'gbt-popoverempty' }, t('sessionsEmpty'))]
				: scopeSessions.map(function (row, index) {
					const current = panelSessionId !== null && row.sessionId === panelSessionId
					const cards = row.cards !== null && row.cards !== undefined && Number.isFinite(row.cards.owned) ? row.cards.owned : 0
					const activeCards = row.cards !== null && row.cards !== undefined && Number.isFinite(row.cards.active) ? row.cards.active : null
					return h(
						'div',
						{
							key: 'session-' + String(index),
							className: 'gbt-sessionrow',
							'data-session': String(row.sessionId),
							'data-current': current ? 'true' : 'false',
							'data-status': typeof row.status === 'string' ? row.status : 'unknown',
						},
						h(
							'div',
							{ className: 'gbt-sessionrowhead' },
							h('b', { className: 'gbt-mono' }, sessionShortOf(row.sessionId)),
							current ? h('span', { className: 'gbt-tag' }, t('sessionsCurrent')) : null,
							h('span', { className: 'gbt-sessionstatus', 'data-status': typeof row.status === 'string' ? row.status : 'unknown' }, sessionStatusLabel(row.status)),
						),
						h(
							'div',
							{ className: 'gbt-sessionrowmeta' },
							h('span', null, t('sessionsCards').replace('{n}', String(cards))),
							activeCards === null ? null : h('span', null, t('sessionsActive').replace('{n}', String(activeCards))),
						),
						h('button', { type: 'button', className: 'gbt-linkbtn', 'data-action': 'copy-session-id', 'data-session': String(row.sessionId), onClick: function () { copySessionId(String(row.sessionId)) } }, t('copySessionId')),
					)
				})
		const sessionsPopover = h(
			'div',
			{
				className: 'gbt-popover gbt-sessionpopover',
				'data-session-popover': 'true',
				'data-open': sessionsOpen ? 'true' : 'false',
				hidden: sessionsOpen ? undefined : true,
				role: 'dialog',
				'aria-label': t('sessionsPopoverTitle'),
			},
			h('div', { className: 'gbt-popoverhead' }, t('sessionsPopoverTitle')),
			sessionRows,
		)
		const agentRootName = agentTree.root !== null && typeof agentTree.root.name === 'string' && agentTree.root.name !== '' ? agentTree.root.name : agentTree.root !== null && typeof agentTree.root.id === 'string' ? agentTree.root.id : null
		const agentPopover = h(
			'div',
			{
				className: 'gbt-popover gbt-agentpopover',
				'data-agent-popover': 'true',
				'data-agent-state': agentsState,
				'data-open': agentsOpen ? 'true' : 'false',
				hidden: agentsOpen ? undefined : true,
				role: 'dialog',
				'aria-label': t('agentsPopoverTitle'),
			},
			h('div', { className: 'gbt-popoverhead' }, t('agentsPopoverTitle')),
			snapshot.agentTree === null || snapshot.agentTree === undefined || agentTree.available !== true
				? h('p', { className: 'gbt-popoverrow gbt-popoverwarn', 'data-agent-unavailable': 'true' }, t('agentsUnavailable'))
				: null,
			agentTree.root === null
				? h('p', { className: 'gbt-popoverrow', 'data-agent-no-root': 'true' }, t('agentsNoRoot'))
				: h('p', { className: 'gbt-popoverrow', 'data-agent-root-line': 'true' }, t('agentsRootLine').replace('{name}', agentRootName === null ? '—' : agentRootName)),
			h('p', { className: 'gbt-popoverrow', 'data-agent-live-line': String(agentTree.members.length) }, t('agentsLiveLine').replace('{n}', String(agentTree.members.length))),
			agentTree.members.length === 0
				? h('p', { className: 'gbt-popoverrow', 'data-agent-no-children': 'true' }, t('agentsNoChildren'))
				: h('div', { className: 'gbt-agentmembers', 'data-agent-members': 'true' }, agentTree.members.map(function (member, index) {
					const name = typeof member.name === 'string' && member.name !== '' ? member.name : typeof member.id === 'string' ? member.id : String(index)
					const status = typeof member.status === 'string' && member.status !== '' ? t(tcAgentStatusKey(member.status)) : t('agentStatusUnknown')
					const role = typeof member.role === 'string' && member.role !== '' ? roleKindLabel(member.role, t) : '—'
					const task = typeof member.taskId === 'string' && member.taskId !== '' ? member.taskId : '—'
					return h('p', { key: 'agent-member-' + name, className: 'gbt-popoverrow gbt-agentmember', 'data-agent-member': name, 'data-agent-status': typeof member.status === 'string' ? member.status : '' }, h('b', { className: 'gbt-mono' }, name), ' · ' + role + ' · ' + status + ' · ' + task)
				})),
			h(
				'div',
				{ className: 'gbt-popoveractions' },
				h('button', { type: 'button', className: 'gbt-btn', 'data-action': 'copy-session-id', 'data-session': copySessionValue, onClick: function () { copySessionId(copySessionValue) } }, t('copySessionId')),
				sessionCopied === null
					? null
					: h('span', { className: 'gbt-footnote', role: 'status', 'aria-live': 'polite', 'data-copy-toast': sessionCopied === 'failed' ? 'failed' : 'copied' }, sessionCopied === 'failed' ? t('copyFailed') : t('sessionIdCopiedToast')),
			),
		)
		const newTaskButton = h('button', { type: 'button', className: 'gbt-btn', 'data-variant': 'primary', 'data-action': 'new-task', disabled: snapshot.project === null, onClick: function () { startEdit(null) } }, '+ ' + t('newTask'))
		const menuItems = [
			['refresh', t('refresh'), function () { closePopovers(); void store.load({ refresh: true }) }],
			['project', t('project'), function () { closePopovers(); openProjectDialog() }],
			['settings', t('settings'), function () { closePopovers(); setSettingsOpen(true) }],
			['copy-session-id', t('copySessionId'), function () { copySessionId(copySessionValue) }],
			['diagnostics', t('diagnostics'), function () { closePopovers(); setView('status') }],
		]
		const moreMenu = h(
			'div',
			{ className: 'gbt-morewrap' },
			h('button', { type: 'button', className: 'gbt-iconbtn gbt-morebtn', 'data-more-menu': 'true', 'aria-haspopup': 'menu', 'aria-expanded': menuOpen ? 'true' : 'false', title: t('moreActions'), onClick: function () { setMenuOpen(!menuOpen) } }, '⋯'),
			h(
				'div',
				{ className: 'gbt-popover gbt-menu', 'data-more-popover': 'true', role: 'menu', 'data-open': menuOpen ? 'true' : 'false', hidden: menuOpen ? undefined : true },
				menuItems.map(function (entry) {
					return h('button', { key: entry[0], type: 'button', className: 'gbt-menuitem', role: 'menuitem', 'data-action': entry[0], 'data-session': entry[0] === 'copy-session-id' ? copySessionValue : undefined, onClick: entry[2] }, entry[1])
				}),
			),
		)
		// T-210 review: the refresh action also forces the deferred metadata to be rebuilt
		// (the host serves a short-TTL cached inventory to the routine poll).
		const refreshButton = h('button', { type: 'button', className: 'gbt-iconbtn', 'data-action': 'refresh', title: t('refresh'), onClick: function () { void store.load({ refresh: true }) } }, '↻')
		const kindFilterBar = h(
			'div',
			{ className: 'gbt-kindfilter', 'data-kind-filter': panelBoardUi.kind, title: t('kindFilterHint') },
			[
				['all', t('kindFilterAll')],
				['dev', t('kindDev')],
				['investigate', t('kindInvestigate')],
			].map(function (entry) {
				return h(
					'button',
					{
						key: entry[0],
						type: 'button',
						className: 'gbt-kindfilterbtn',
						'data-kind-filter': entry[0],
						'data-active': panelBoardUi.kind === entry[0] ? 'true' : 'false',
						'aria-pressed': panelBoardUi.kind === entry[0] ? 'true' : 'false',
						onClick: function () {
							panelBoardUi.kind = entry[0]
							setColumnTick(function (count) { return count + 1 })
						},
					},
					entry[1],
				)
			}),
		)
		const tabCountOf = function (key) {
			if (key === 'board') return Number.isFinite(counts.total) ? counts.total : tasks.length
			if (key === 'queue') return queue.length
			return null
		}
		const tabsView = h(
			'nav',
			{ className: 'gbt-tabs', 'aria-label': t('title') },
			tabs.map(function (tab) {
				const tabCount = tabCountOf(tab.key)
				if (tabCount === null) {
					return h('button', { key: tab.key, type: 'button', className: 'gbt-tab', 'data-view': tab.key, 'data-active': view === tab.key ? 'true' : 'false', onClick: function () { setView(tab.key) } }, tab.label)
				}
				return h(
					'button',
					{ key: tab.key, type: 'button', className: 'gbt-tab', 'data-view': tab.key, 'data-active': view === tab.key ? 'true' : 'false', onClick: function () { setView(tab.key) } },
					tab.label,
					h('span', { className: 'gbt-tabcount' }, String(tabCount)),
				)
			}),
			snapshot.project === null || snapshot.project === undefined
				? h('button', { type: 'button', className: 'gbt-tab', 'data-action': 'open-project', onClick: function () { openProjectDialog() } }, '+ ' + t('openProject'))
				: null,
		)
		// T-158 review: the popovers are anchored to their pill through a
		// positioned wrapper. Without one, `position:absolute` resolved against the
		// initial containing block and the popover opened off-screen.
		const sessionsAnchor = h('div', { className: 'gbt-anchor', 'data-popover-anchor': 'sessions' }, sessionsButton, sessionsPopover)
		const agentsAnchor = h('div', { className: 'gbt-anchor', 'data-popover-anchor': 'agents' }, agentsPill, agentPopover)
		const topRow = h(
			'div',
			{ className: 'gbt-toprow' },
			brand,
			h('div', { className: 'gbt-context' }, sessionsAnchor, currentPill, dispatchPill, agentsAnchor, workspaceBar),
			h('div', { className: 'gbt-topactions' }, decisionFallback, newTaskButton, moreMenu),
		)
		const toolbarRow = h('div', { className: 'gbt-toolbar' }, tabsView, h('div', { className: 'gbt-toolbarright' }, refreshButton, kindFilterBar))
		// T-210: `data-metadata-state` is the evidence that 'header ready' does not
		// mean 'host inventory done': the header renders from the light /state, and
		// the deferred blocks report idle/loading/ready/degraded independently.
		const header = h(
			'header',
			{ className: 'gbt-header gbt-headertwo', 'data-header-rows': '2', 'data-metadata-state': metadataStatus, 'data-header-ready': sessionsLoading ? 'false' : 'true' },
			topRow,
			toolbarRow,
		)
		const footer = h(
			'footer',
			{ className: 'gbt-statusbar', 'data-panel-footer': 'true' },
			h(
				'div',
				{ className: 'gbt-statusleft' },
				h('span', { className: 'gbt-dot', 'data-running': active ? 'true' : 'false' }),
				h('span', null, active ? t('running') : t('paused')),
				h('span', null, '· ' + String(Number.isFinite(counts.total) ? counts.total : tasks.length) + ' ' + t('taskCount')),
				h('span', null, '· ' + t('sessionsPill').replace('{n}', String(scopeSessions.length))),
				h('span', null, t('subtitle')),
			),
			h('div', { className: 'gbt-statusright' }, scheduler !== null && scheduler !== undefined && scheduler.lastTickAt !== null && scheduler.lastTickAt !== undefined ? h('span', null, t('lastScan').replace('{ago}', tcAgo(scheduler.lastTickAt, now))) : null, h('span', null, t('local'))),
		)

		// T-108: the main checkout's cleanliness, worded for what it is. While a
		// merge runs the tree is briefly dirty — that is a passing notice ("will
		// retry"), not an alarm. Only a sustained streak (the cards escalated by
		// the scheduler) turns it into a warning that still says how it heals.
		const environment = snapshot.environment === null || snapshot.environment === undefined ? null : snapshot.environment
		const escalatedCards = environment !== null && Array.isArray(environment.escalated) ? environment.escalated.map(String) : []
		const environmentBar =
			environment === null || environment.clean !== false
		? null
		: h(
				'div',
				{
			className: 'gbt-banner',
			'data-tone': escalatedCards.length === 0 ? 'info' : 'warn',
			'data-environment': escalatedCards.length === 0 ? 'dirty-transient' : 'dirty-sustained',
			'data-environment-code': environment.code === null || environment.code === undefined ? '' : String(environment.code),
				},
				h(
			'span',
			{ style: { flex: '1', minWidth: '220px' } },
			(escalatedCards.length === 0 ? t('environmentTransient') : t('environmentSustained'))
				.split('{ids}')
				.join(escalatedCards.join(', '))
				.split('{ago}')
				.join(environment.checkedAt === null || environment.checkedAt === undefined ? '—' : tcAgo(environment.checkedAt, now)),
				),
			)

		const busyBar = busy === null
			? null
			: h(
			'div',
			{ className: 'gbt-progress', role: 'status', 'aria-live': 'polite' },
			h('span', { className: 'gbt-spinner' }),
			h('span', null, busy.action === 'start' ? t('starting') : busy.action === 'pause' ? t('pausing') : busy.action === 'approveStart' ? t('approving') : busy.action === 'rejectStart' ? t('rejecting') : t('working')),
			h('div', { className: 'gbt-progressbar' }),
		)

		const bannerMessage = snapshot.message
		const bannerProject = mismatchProject === null ? (typeof snapshot.sessionProject === 'string' ? snapshot.sessionProject : '') : mismatchProject
		const bannerText = bannerMessage.indexOf('project is not ready:') === 0
			? t('projectNotReady').replace('{project}', bannerProject)
			: bannerMessage
		// T-182: an unbound session is a SETUP state, not an alarm — but only while it
		// has nothing to report. The store reports the expected "nothing is bound"
		// answer as source 'setup' with no text; the empty state below already asks
		// for the project. A NON-empty setup text is a real action/transport failure
		// (a bind that could not reach the host, a refused openProject): suppressing
		// it hid ECONNREFUSED behind a silent dialog.
		const banner =
			snapshot.source === 'setup' && bannerMessage === ''
		? null
		: snapshot.source === 'error'
			? h('div', { className: 'gbt-banner', title: bannerMessage }, h('span', null, bannerMessage === '' ? t('offline') : bannerText))
			: bannerMessage === ''
				? null
				: h('div', { className: 'gbt-banner', 'data-tone': 'info', title: bannerMessage }, bannerText)

		const startRequest = dispatch.request === null || dispatch.request === undefined ? null : dispatch.request
		const requestBanner =
			startRequest === null
		? null
		: h(
				'div',
				{ className: 'gbt-banner', 'data-tone': 'info' },
				h(
			'div',
			{ style: { flex: '1', minWidth: '220px' } },
			h('strong', null, t('startRequestTitle')),
			' ',
			h('span', { className: 'gbt-mono' }, String(startRequest.by)),
			' · ',
			h('span', null, tcAgo(startRequest.at, now)),
			h('div', { className: 'gbt-footnote' }, startRequest.note === '' ? t('startRequestHint') : startRequest.note),
				),
				h(
			'div',
			{ className: 'gbt-actions' },
			h(
				'button',
				{
					type: 'button',
					className: 'gbt-btn',
					'data-variant': 'primary',
					onClick: function () { void store.send('approveStart', { requestId: startRequest.id }) },
					'data-busy': isBusy('approveStart', startRequest.id) ? 'true' : 'false',
					disabled: busy !== null,
				},
				isBusy('approveStart', startRequest.id) ? h('span', null, h('span', { className: 'gbt-spinner' }), t('approving')) : t('approveStart'),
			),
			h(
				'button',
				{
					type: 'button',
					className: 'gbt-btn',
					onClick: function () { void store.send('rejectStart', { requestId: startRequest.id }) },
					'data-busy': isBusy('rejectStart', startRequest.id) ? 'true' : 'false',
					disabled: busy !== null,
				},
				isBusy('rejectStart', startRequest.id) ? h('span', null, h('span', { className: 'gbt-spinner' }), t('rejecting')) : t('rejectStart'),
			),
				),
			)

		const content =
			view === 'board'
		? h(Board, {
					snapshot: snapshot,
					loading: loading,
					t: t,
					now: now,
					selectedId: selectedId,
					onOpen: openTask,
					// T-113: the user records review/test verdicts through the same /action
					// route, so the host records role=user (agents cannot impersonate it).
					onVerdict: function (action, id, payload) {
				void store.send(action, Object.assign({ id: id }, payload === undefined ? {} : payload))
					},
					onOpenDoneAll: function () { doneAllReset(); setDoneAllArchived(false); setDoneAllOpen(true) },
					kind: panelBoardUi.kind,
					onColumnToggle: function () { setColumnTick(function (count) { return count + 1 }) },
					onKindFilterChange: function () { setColumnTick(function (count) { return count + 1 }) },
				})
		: view === 'queue'
			? h(QueueView, { snapshot: snapshot, t: t, onOpen: openTask })
			: view === 'workers'
				? h(WorkersView, { snapshot: snapshot, t: t })
				: view === 'status'
			? h(StatusView, {
				snapshot: snapshot,
				t: t,
				now: now,
				store: store,
				onOpenArchive: function () {
					doneAllReset()
					setDoneAllArchived(true)
					setDoneAllOpen(true)
				},
			})
			: view === 'roles'
				? h(RolesView, { snapshot: snapshot, t: t, store: store })
				: h(Board, {
		snapshot: snapshot,
		loading: loading,
		t: t,
		now: now,
		selectedId: selectedId,
		onOpen: openTask,
		// T-113: the user records verdicts through the same /action route, so
		// the host sees role=user (the tool path cannot impersonate it).
		onVerdict: function (action, id, payload) {
			void store.send(action, Object.assign({ id: id }, payload === undefined ? {} : payload))
		},
		kind: panelBoardUi.kind,
		// T-132: the kind filter is module state; this forces a rerender.
		onKindFilterChange: function () { setColumnTick(function (count) { return count + 1 }) },
			})

		// T-205: the settings entry is a PAGE takeover, not a modal over the board.
		// It keeps the panel root (and therefore the theme tokens) but renders the
		// shared page; 取消/× return to the board through onClose.
		if (settingsOpen === true) {
			return h(
				'div',
				{ className: 'gbt-root', 'data-panel': 'task-center', 'data-panel-root': 'task-center', 'data-tc-theme': theme, 'data-settings-open': 'true' },
				h(SettingsPage, {
					t: t,
					mode: 'panel',
					snapshot: snapshot,
					store: store,
					theme: theme,
					onThemeChange: setTheme,
					// The engine path writes the bundle's config scope; a runtime without
					// the config-form service passes null and the section says so.
					engineScope: typeof engineScopeOf === 'function' ? engineScopeOf() : null,
					onClose: function () { setSettingsOpen(false) },
					initialSection: props !== undefined && props !== null && typeof props.initialSettingsSection === 'string' ? props.initialSettingsSection : undefined,
				}),
			)
		}

		return h(
			'div',
			{ className: 'gbt-root', 'data-panel': 'task-center', 'data-panel-root': 'task-center', 'data-tc-theme': theme, 'data-metadata-state': metadataStatus },
			header,
			environmentBar,
			busyBar,
			banner,
			requestBanner,
			snapshot.project === null || snapshot.project === undefined
		? h(
				'div',
				{ className: 'gbt-view' },
				// While the first /state is in flight the Host is resolving the session
				// project: show that instead of flashing an "open project" form.
				snapshot.source === 'loading'
			? h(
					'div',
					{ className: 'gbt-loading', 'data-project-resolving': 'true', role: 'status', 'aria-busy': 'true' },
					h(
						'div',
						{ className: 'gbt-loadingline' },
						h('span', { className: 'gbt-spinner', 'aria-hidden': 'true' }),
						h('p', { className: 'gbt-footnote' }, t('projectResolving')),
					),
					h(
						'div',
						{ className: 'gbt-skellanes', 'aria-hidden': 'true' },
						[0, 1, 2, 3].map(function (index) {
							return h(
								'div',
								{ key: index, className: 'gbt-skellane' },
								h('div', { className: 'gbt-skel gbt-skelhead' }),
								h('div', { className: 'gbt-skel gbt-skelcard' }),
								h('div', { className: 'gbt-skel gbt-skelcard' }),
								h('div', { className: 'gbt-skel gbt-skelcard' }),
							)
						}),
					),
				)
			: h(
					'div',
					{ 'data-not-activated': 'true', 'data-unbound': snapshot.source === 'setup' ? 'true' : undefined, 'data-project-source': snapshot.source === 'setup' ? 'unbound' : undefined },
					// T-182: the host's "nothing bound" answer is worded as what the user has
					// to do ("尚未选择项目"), not as a host state ("未激活任何项目").
					h('p', { className: 'gbt-footnote', 'data-not-activated-title': 'true' }, snapshot.source === 'setup' ? t('projectUnknown') : t('notActivatedTitle')),
					h('ol', { className: 'gbt-footnote', 'data-not-activated-steps': 'true' }, h('li', { key: 'call' }, t('notActivatedStepCall')), h('li', { key: 'open' }, t('notActivatedStepOpen'))),
					// T-181: keep the manual entry one click away, but mount the dialog
					// ONLY on request. An auto-mounted modal could not be dismissed: its
					// close re-rendered the same empty state straight back into the form.
					h(
						'div',
						{ className: 'gbt-actions', 'data-not-activated-actions': 'true' },
						h('button', { type: 'button', className: 'gbt-btn', 'data-variant': 'primary', 'data-action': 'open-project-empty', onClick: function () { openProjectDialog() } }, t('openProject')),
					),
				),
			)
		: null,
			snapshot.project === null || snapshot.project === undefined
		? null
		: h(
				'div',
				{ className: 'gbt-main' + (workspaceSwitch.fade === true ? ' gbt-workspacefade' : '') },
				h('div', { className: 'gbt-content' }, h('div', { className: 'gbt-view' }, content)),
				selected === null ? null : h(DetailView, {
			task: Object.assign({}, selected, snapshot.details[selected.id] === undefined ? {} : snapshot.details[selected.id].task),
			snapshot: snapshot,
			t: t,
			now: now,
			onClose: closeDetail,
			onEdit: startEdit,
				}),
			doneAllOpen
				? h(DoneAllDrawer, {
				t: t,
				store: store,
				archived: doneAllArchived === true,
				total: Number.isFinite(counts.done) ? counts.done : null,
				onClose: function () { setDoneAllOpen(false) },
				onOpen: function (id) {
					setDoneAllOpen(false)
					openTask(id)
				},
			})
				: null,
			),
			footer,
			editing === null ? null : h(TaskForm, {
		task: editingTask,
		snapshot: snapshot,
		t: t,
		onClose: function () { setEditing(null) },
		onSaved: function () { setEditing(null) },
			}),
			// T-205: the dispatch-settings modal is gone; the page branch above owns
			// the settings entry, so nothing is mounted over the board.
			// T-181: the ONE project dialog. It is mounted only after the user asks for
			// it — an empty project state never auto-opens it, and closing it unmounts.
			projectOpen && snapshot.source !== 'loading' ? h(ProjectForm, { t: t, project: snapshot.project, hostProject: snapshot.sessionProject, onClose: function () { setProjectOpen(false) } }) : null,
			// T-195: the host decision queue. The modal is keyed by the foregrounded
		// decision id, so the answer form resets when the queue advances.
			decisionQueue.length > 0 && decisionPeek !== true
		? h(DecisionModal, {
			key: decisionQueue[0].id,
			t: t,
			queue: decisionQueue,
			receivedAt: snapshot.receivedAt,
			busy: busy !== null && busy.action === 'decisionAnswer',
			onAnswer: answerDecision,
			onOpenTask: openTaskFromDecision,
		})
		: null,
		)
	}


	return TaskCenter
}

module.exports = { createTaskCenter }

				})(module, module.exports)
				const factory = module.exports.createTaskCenter
				return factory({
					React: React,
					h: h,
					Board: Board,
					QueueView: QueueView,
					WorkersView: WorkersView,
					StatusView: StatusView,
					RolesView: RolesView,
					DetailView: DetailView,
					DoneAllDrawer: DoneAllDrawer,
					TaskForm: TaskForm,
					SettingsPage: SettingsPage,
					engineScopeOf: function () {
						try {
							const context = tcHostContext
							const service = context !== null && context !== undefined && typeof context.get === 'function' ? context.get('configForms') : null
							const forms = service !== null && service !== undefined && service.configForms !== undefined && service.configForms !== null ? service.configForms : service
							return forms !== null && forms !== undefined && typeof forms.get === 'function' ? forms.get(ENTRY_NS) : null
						} catch (error) {
							return null
						}
					},
					ProjectForm: ProjectForm,
					DecisionModal: DecisionModal,
					useTranslate: useTranslate,
					useSnapshot: useSnapshot,
					useNow: useNow,
					panelState: panelState,
					projectFormState: projectFormState,
					doneAllReset: doneAllReset,
					projectMismatchOf: projectMismatchOf,
					projectSourceKey: projectSourceKey,
					projectSourceLabel: projectSourceLabel,
					tcAgo: tcAgo,
					tcAgentTreeOf: tcAgentTreeOf,
					tcAgentStatusKey: tcAgentStatusKey,
					roleKindLabel: roleKindLabel,
					copyToClipboard: copyToClipboard,
					store: store,
				})
			})()

			// T-208: the conversation-page decision entry is its own view module so
			// it can be Node-tested without the panel; it is mounted from the
			// 'shell.overlay' list slot by 40-tail.part.
			const DecisionOverlay = (function () {
				const module = { exports: {} }
				;(function (module, exports) {
/**
 * DecisionOverlay (T-208, T-211): the conversation-page entry for the Host's
 * pending decisions.
 *
 * Other plugins (dsh-plugin-opencode-usage) use the 'shell.overlay' list slot
 * for a floating entry beside the session content. The task center only
 * registered 'main' / 'sidebar.panellist' / 'plugins.bundle.config', so a
 * pending decision was invisible until the user opened the panel. This view is
 * registered into 'shell.overlay' by client/src/40-tail.part and renders:
 *
 *   - a "待决策 N" chip in the free corner of the session centre column,
 *     visible ONLY while the queue is non-empty;
 *   - on click, a compact docked card that reuses the decision modal's own
 *     answer form (DecisionModal.DecisionCard): headline/body/options/server
 *     countdown/free text/high-risk DELETE confirmation. ONE decision is shown
 *     at a time; answering advances the queue automatically.
 *
 * The queue comes from the SHARED task store: the full snapshot already carries
 * `decisions`, and store.loadDecisions() polls only the decision list, so the
 * conversation page never pulls the whole board every few seconds. An answer
 * goes through the same store.send('decisionAnswer') as the panel modal, and
 * the store's one-shot guard is what stops the two surfaces from
 * double-submitting the same request.
 *
 * Placement (T-208, hardened in T-211): the entry is anchored inside the
 * AppFrame's overlay layer at the session centre column's inline end. The
 * layer can start under the shell header or end below the visual viewport, so
 * computePlacement() anchors to layer ∩ viewport and returns the card height
 * that still fits. The card carries that max-height plus overflow-y:auto, so
 * long content scrolls INSIDE the card instead of being clipped by the shell
 * (the 637px-high window case). It is lifted ABOVE the composer card
 * ([data-composer-card]) whenever the conversation is docked, so a narrow
 * viewport can never cover the input box; the centred hero composer keeps the
 * corner, and the safe-area cap still keeps the card on screen for both.
 *
 * T-211 diagnostics / reliability:
 *   - data-decision-overlay / data-decision-pending make the entry visible to
 *     the regression tests instead of inferring it from classes;
 *   - a NEW pending decision (count 0→>0 or any increase) plays ONE 600ms
 *     chip scale + ring pulse, at most twice ever. It is skipped on the first
 *     paint, while the card is open, with prefers-reduced-motion (the static
 *     highlight stays), and while the tab is hidden. data-decision-attention
 *     exposes 'play' / 'static' to the tests. There is no loop and no shake;
 *   - the store is told the overlay mounted, so the task-center header can
 *     offer a clickable fallback when the Host has no 'shell.overlay' slot.
 *
 * Injected by the build: React, h, DecisionModal, store, useTranslate,
 * useSnapshot and tcErrorMessage.
 */
function createDecisionOverlay(deps) {
	const React = deps.React
	const h = deps.h
	const DecisionModal = deps.DecisionModal
	const DecisionCard = DecisionModal.DecisionCard
	const store = deps.store
	const useTranslate = deps.useTranslate
	const useSnapshot = deps.useSnapshot
	const tcErrorMessage = deps.tcErrorMessage
	// React.lazy/older runtimes may not expose useLayoutEffect in a test shim;
	// measuring after a normal effect is still correct, just one paint late.
	const useLayoutEffect = typeof React.useLayoutEffect === 'function' ? React.useLayoutEffect : React.useEffect

	/** How often the conversation page asks for the decision list. */
	const POLL_MS = 5000
	const EDGE = 12
	const CHIP_GAP = 8
	const CHIP_HEIGHT = 30
	const PANEL_MAX = 520
	/** One attention pulse: chip scale 1→1.04→1 plus an outer ring, 600ms. */
	const ATTENTION_MS = 600
	/** Attention is a NOTIFICATION, not a heartbeat: at most this many ever. */
	const ATTENTION_LIMIT = 2

	// Like the panel's module-backed state, the expanded flag survives a slot
	// remount (the shell re-registers overlays when the layout changes).
	const state = {
		open: false,
		// T-211: the last pending count this view OBSERVED. The first render
		// records it without animating, so opening a page that already has a
		// queue is not an "arrival".
		seenCount: null,
		attention: null,
		attentionPlays: 0,
		attentionTimer: null,
	}

	/** The pending queue, oldest first, exactly as the Host ordered it. */
	function decisionQueueOf(snapshot) {
		if (snapshot === null || snapshot === undefined || !Array.isArray(snapshot.decisions)) return []
		return snapshot.decisions.filter(function (entry) {
			if (entry === null || entry === undefined || typeof entry !== 'object') return false
			if (typeof entry.id !== 'string' || entry.id === '') return false
			if (typeof entry.status === 'string' && entry.status !== 'pending') return false
			return true
		})
	}

	/** The AppFrame overlay layer that owns this entry (data-shell-overlay). */
	function overlayLayerOf(node) {
		let current = node === null || node === undefined ? null : node.parentElement
		while (current !== null && current !== undefined) {
			if (typeof current.getAttribute === 'function' && current.getAttribute('data-shell-overlay') !== null) return current
			current = current.parentElement
		}
		return null
	}

	/**
	 * The session centre column inside the AppFrame. Walking up from the
	 * composer (or the conversation's data-phase root) is robust in drawer mode,
	 * where a mask element shifts the frame's children by one; the grid index
	 * (sidebar | centre | rightbar) is only the fallback.
	 */
	function centerColumnOf(frame) {
		if (frame === null || frame === undefined) return null
		const globalDocument = typeof document === 'undefined' ? null : document
		if (globalDocument !== null && typeof globalDocument.querySelector === 'function') {
			const anchors = ['[data-composer-card]', '[data-phase]']
			for (let index = 0; index < anchors.length; index += 1) {
				let node = globalDocument.querySelector(anchors[index])
				while (node !== null && node !== undefined && node.parentElement !== frame) node = node.parentElement
				if (node !== null && node !== undefined && node.parentElement === frame) return node
			}
		}
		if (frame.children === undefined || frame.children === null) return null
		// Drawer mode inserts a mask before the sidebar, shifting the grid index.
		let offset = 1
		if (globalDocument !== null && typeof globalDocument.querySelector === 'function') {
			const mask = globalDocument.querySelector('[data-sidebar-mask]')
			if (mask !== null && frame.children[0] === mask) offset = 2
		}
		return frame.children[offset] === undefined ? null : frame.children[offset]
	}

	/** The conversation's composer card, when this page has one. */
	function composerOf(center) {
		if (center === null || center === undefined || typeof center.querySelector !== 'function') return null
		try {
			return center.querySelector('[data-composer-card]')
		} catch (error) {
			return null
		}
	}

	/**
	 * Is the composer DOCKED at the bottom of the conversation (rather than the
	 * centred hero card)? The host marks the conversation phase; the geometric
	 * fallback covers hosts that predate it.
	 */
	function composerIsDocked(composer, composerRect, centerRect) {
		if (composer !== null && typeof composer.closest === 'function') {
			const phaseNode = composer.closest('[data-phase]')
			if (phaseNode !== null && typeof phaseNode.getAttribute === 'function') {
				const phase = phaseNode.getAttribute('data-phase')
				if (phase === 'hero') return false
				if (phase === 'active') return true
			}
		}
		if (centerRect === null || !(centerRect.height > 0) || composerRect === null) return true
		return composerRect.top > centerRect.top + centerRect.height * 0.5
	}

	/**
	 * T-211: the VIEWPORT the user can actually see. visualViewport wins (it
	 * shrinks when the on-screen keyboard opens); innerWidth/innerHeight is the
	 * fallback, and a runtime without a window (Node tests, SSR) keeps the layer
	 * rect so the placement stays deterministic.
	 */
	function viewportRectOf(layerRect) {
		const globalWindow = typeof window === 'undefined' ? null : window
		if (globalWindow === null || globalWindow === undefined) return layerRect
		const visual = globalWindow.visualViewport !== null && globalWindow.visualViewport !== undefined ? globalWindow.visualViewport : null
		const width = visual !== null && Number.isFinite(visual.width) && visual.width > 0 ? visual.width : Number.isFinite(globalWindow.innerWidth) && globalWindow.innerWidth > 0 ? globalWindow.innerWidth : layerRect.width
		const height = visual !== null && Number.isFinite(visual.height) && visual.height > 0 ? visual.height : Number.isFinite(globalWindow.innerHeight) && globalWindow.innerHeight > 0 ? globalWindow.innerHeight : layerRect.height
		const left = visual !== null && Number.isFinite(visual.offsetLeft) ? visual.offsetLeft : 0
		const top = visual !== null && Number.isFinite(visual.offsetTop) ? visual.offsetTop : 0
		return { left: left, top: top, right: left + width, bottom: top + height, width: width, height: height }
	}

	/** The visible part of the overlay layer. */
	function intersectRects(left, right) {
		const visibleLeft = Math.max(left.left, right.left)
		const visibleTop = Math.max(left.top, right.top)
		const visibleRight = Math.min(left.right, right.right)
		const visibleBottom = Math.min(left.bottom, right.bottom)
		return {
			left: visibleLeft,
			top: visibleTop,
			right: visibleRight,
			bottom: visibleBottom,
			width: Math.max(0, visibleRight - visibleLeft),
			height: Math.max(0, visibleBottom - visibleTop),
		}
	}

	/**
	 * Pixel placement of the chip inside the overlay layer, plus the card height
	 * that still fits between the chip and the visible top of the layer.
	 *
	 * The offsets are CSS right/bottom values relative to the LAYER (the chip's
	 * containing block), so anything the layer extends below the visual viewport
	 * is added to 'bottom'; the remaining height is measured from the chip's
	 * top up to the visible top of the layer. Returns null when nothing is
	 * measurable (tests, detached mounts).
	 */
	function computePlacement(root) {
		if (root === null || root === undefined || typeof root.getBoundingClientRect !== 'function') return null
		const layer = overlayLayerOf(root)
		if (layer === null) return null
		const layerRect = layer.getBoundingClientRect()
		if (!(layerRect.height > 0) || !(layerRect.width > 0)) return null
		const safe = intersectRects(layerRect, viewportRectOf(layerRect))
		if (!(safe.height > 0) || !(safe.width > 0)) return null
		const frame = layer.parentElement
		const center = centerColumnOf(frame)
		const centerRect = center !== null && center !== undefined && typeof center.getBoundingClientRect === 'function' ? center.getBoundingClientRect() : null
		const composer = composerOf(center)
		const composerRect = composer !== null && typeof composer.getBoundingClientRect === 'function' ? composer.getBoundingClientRect() : null
		// Part of the layer that is off-screen (below the visual viewport, to the
		// right of it): the anchor must be pushed that far back inside the layer.
		const clipRight = Math.max(0, Math.round(layerRect.right - safe.right))
		const clipBottom = Math.max(0, Math.round(layerRect.bottom - safe.bottom))
		// Inline end of the session centre column, mirroring the existing shell
		// overlays' bottom-left corner habit (this plugin takes the bottom-right
		// so the two chips never sit on top of each other).
		const anchorRight = centerRect === null || !(centerRect.width > 0) ? safe.right : Math.min(layerRect.right, centerRect.right, safe.right)
		const right = Math.max(EDGE + clipRight, Math.round(layerRect.right - anchorRight + EDGE))
		let bottom = EDGE + 4 + clipBottom
		if (composerRect !== null && composerRect.height > 0 && composerIsDocked(composer, composerRect, centerRect)) {
			// 12px above the composer: the chip (and the card that opens upwards)
			// never covers the input box, however narrow the viewport is.
			bottom = Math.max(bottom, Math.round(layerRect.bottom - composerRect.top + EDGE))
		}
		// A very tall composer must not push the chip into the middle of the
		// page; the ceiling is relative to the VISIBLE part of the layer.
		const ceiling = Math.max(bottom, Math.round(EDGE + clipBottom + safe.height * 0.6))
		if (bottom > ceiling) bottom = ceiling
		const chipBottomY = layerRect.bottom - bottom
		// The card opens upward from just above the chip. Its top must stay below
		// the visible top of the layer (plus the same breathing room as the edge),
		// and it always gets a scrollable minimum.
		const spaceAbove = chipBottomY - CHIP_HEIGHT - CHIP_GAP - safe.top - EDGE
		const panelMax = Math.max(160, Math.min(PANEL_MAX, Math.round(spaceAbove)))
		return { right: right, bottom: bottom, maxHeight: panelMax }
	}

	/** Does this runtime ask for reduced motion? */
	function prefersReducedMotion() {
		try {
			return typeof window !== 'undefined' && window !== null && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches === true
		} catch (error) {
			return false
		}
	}

	/** A background tab must not pulse: nobody is looking at it. */
	function tabIsHidden() {
		return typeof document !== 'undefined' && document !== null && document.visibilityState === 'hidden'
	}

	/**
	 * T-211: the ONE-SHOT attention decision for a pending-count change. Pure:
	 * the caller owns the play budget and the marker state. 'play' for a real
	 * pulse, 'static' when the card is open or motion is reduced (a highlight
	 * without movement), null for no attention. A first observation
	 * (previous === null) never animates, and neither does a shrinking queue.
	 */
	function attentionModeFor(previous, next, context) {
		const options = context === null || context === undefined ? {} : context
		if (previous === null || previous === undefined) return null
		if (typeof previous !== 'number' || typeof next !== 'number') return null
		if (!(next > previous) || !(next > 0)) return null
		if (Number.isFinite(options.plays) && options.plays >= ATTENTION_LIMIT) return null
		if (options.hidden === true) return null
		return options.open === true || options.reducedMotion === true ? 'static' : 'play'
	}

	/**
	 * Record the pending count this render observed and return the attention
	 * marker the dock should carry. Mutating module state during render is safe
	 * here because the transition is idempotent for one count: a repeat render
	 * (poll, resize, StrictMode) cannot consume a second play.
	 */
	function observePendingCount(next, open) {
		if (next === state.seenCount) return state.attention
		const previous = state.seenCount
		state.seenCount = next
		const mode = attentionModeFor(previous, next, {
			open: open === true,
			plays: state.attentionPlays,
			hidden: tabIsHidden(),
			reducedMotion: prefersReducedMotion(),
		})
		if (mode === null) return state.attention
		state.attentionPlays += 1
		state.attention = mode
		return state.attention
	}

	/** Drop the attention marker and its pending timer. */
	function clearAttention() {
		if (state.attentionTimer !== null && typeof clearTimeout === 'function') clearTimeout(state.attentionTimer)
		state.attentionTimer = null
		state.attention = null
	}

	/**
	 * The shell overlay entry: the chip, and (when expanded) the docked card for
	 * the oldest pending decision.
	 */
	function DecisionOverlay(props) {
		const t = useTranslate()
		const snapshot = useSnapshot()
		const queue = decisionQueueOf(snapshot)
		const count = queue.length
		const currentId = count === 0 ? null : queue[0].id
		const [open, setOpenState] = React.useState(function () {
			if (state.open) return true
			return props !== undefined && props !== null && props.initialOpen === true
		})
		const [error, setError] = React.useState('')
		const [submitting, setSubmitting] = React.useState(false)
		const [placement, setPlacement] = React.useState(null)
		// The attention timer lives outside React, but a re-render is what removes
		// the marker from the DOM once the pulse has finished (the epoch value
		// itself is never read; only its setter matters).
		const [, setAttentionEpoch] = React.useState(0)
		const rootRef = React.useRef(null)
		const wasOpen = React.useRef(false)

		function setOpen(next) {
			state.open = next === true
			setOpenState(next === true)
		}

		function measure() {
			const next = computePlacement(rootRef.current)
			if (next === null) return
			setPlacement(function (previous) {
				if (previous !== null && previous.right === next.right && previous.bottom === next.bottom && previous.maxHeight === next.maxHeight) return previous
				return next
			})
		}

		// T-211: tell the shared store this surface really mounted. The task
		// center header only offers its fallback entry when this never happened.
		if (typeof store.markDecisionOverlayMounted === 'function') {
			try {
				store.markDecisionOverlayMounted()
			} catch (error) {
				// A diagnostic flag must never break the overlay.
			}
		}

		// Poll ONLY the decision list (never the board) while the conversation
		// page is open: this is the lightweight queue refresh the task asks for.
		React.useEffect(function () {
			if (typeof store.loadDecisions === 'function') void store.loadDecisions()
			if (typeof setInterval !== 'function') return undefined
			const handle = setInterval(function () {
				if (typeof store.loadDecisions === 'function') void store.loadDecisions()
			}, POLL_MS)
			return function () { clearInterval(handle) }
		}, [])

		// A different foregrounded decision starts without the previous answer's
		// error; an empty queue collapses the card so a LATER decision does not
		// pop it open by itself.
		React.useEffect(function () {
			if (error !== '') setError('')
		}, [currentId])
		React.useEffect(function () {
			if (count > 0) return
			if (state.open) setOpen(false)
		}, [count])

		// Measure after every render: opening the card, the queue advancing and a
		// layout change all re-anchor the entry.
		useLayoutEffect(function () {
			measure()
		})

		React.useEffect(function () {
			const globalWindow = typeof window === 'undefined' ? null : window
			if (globalWindow === null) return undefined
			function onResize() { measure() }
			globalWindow.addEventListener('resize', onResize)
			let observer = null
			if (typeof ResizeObserver === 'function') {
				observer = new ResizeObserver(function () { measure() })
				const layer = overlayLayerOf(rootRef.current)
				const frame = layer !== null ? layer.parentElement : null
				const center = centerColumnOf(frame)
				if (center !== null) observer.observe(center)
				const composer = composerOf(center)
				if (composer !== null) observer.observe(composer)
			}
			return function () {
				globalWindow.removeEventListener('resize', onResize)
				if (observer !== null) observer.disconnect()
			}
		}, [open])

		// Move focus into the card on open and back to the chip on close, so a
		// keyboard user does not have to shift-Tab behind the trigger (the card is
		// rendered before the chip in DOM order).
		React.useEffect(function () {
			const root = rootRef.current
			if (root !== null && root !== undefined && typeof root.querySelector === 'function') {
				const target = open === true ? root.querySelector('[data-decision-collapse]') : wasOpen.current === true ? root.querySelector('[data-decision-chip]') : null
				if (target !== null && target !== undefined && typeof target.focus === 'function') target.focus()
			}
			wasOpen.current = open === true
		}, [open])

		// Escape and an outside click collapse the docked card (the host's own
		// popovers behave the same way).
		React.useEffect(function () {
			if (open !== true) return undefined
			if (typeof document === 'undefined') return undefined
			function onKey(event) {
				if (event !== null && event.key === 'Escape') setOpen(false)
			}
			function onPointer(event) {
				const root = rootRef.current
				if (root === null || typeof root.contains !== 'function') return
				if (event !== null && event.target !== null && root.contains(event.target) !== true) setOpen(false)
			}
			document.addEventListener('keydown', onKey)
			document.addEventListener('pointerdown', onPointer)
			return function () {
				document.removeEventListener('keydown', onKey)
				document.removeEventListener('pointerdown', onPointer)
			}
		}, [open])

		// T-211: one attention pulse per arrival, then nothing. The timer exists
		// only so the marker (and the static highlight) goes away again; the CSS
		// animation itself is a single 600ms iteration.
		const attention = observePendingCount(count, open === true)
		const attentionPlays = state.attentionPlays
		React.useEffect(function () {
			if (attention === null) return undefined
			if (typeof setTimeout !== 'function') return undefined
			const handle = setTimeout(function () {
				state.attention = null
				state.attentionTimer = null
				setAttentionEpoch(function (epoch) { return epoch + 1 })
			}, ATTENTION_MS)
			state.attentionTimer = handle
			return function () {
				if (typeof clearTimeout === 'function') clearTimeout(handle)
				if (state.attentionTimer === handle) state.attentionTimer = null
			}
			// A second arrival inside the first pulse restarts the window instead of
			// inheriting the first one's remaining time.
		}, [attention, attentionPlays])

		/**
		 * Answer the foregrounded decision through the SHARED store, then refresh
		 * the queue immediately: the next decision is shown without waiting for
		 * the poll. A duplicate (the panel modal answered first) is not an error —
		 * the refresh is the only thing left to do.
		 */
		function answer(decision, formAnswer) {
			if (decision === null || decision === undefined || submitting) return
			setSubmitting(true)
			setError('')
			const payload = DecisionModal.decisionAnswerPayload(decision, formAnswer)
			void store.send('decisionAnswer', payload).then(function (result) {
				setSubmitting(false)
				const ok = result !== null && result !== undefined && result.ok === true
				const duplicate = result !== null && result !== undefined && result.duplicate === true
				if (ok || duplicate) {
					if (typeof store.loadDecisions === 'function') void store.loadDecisions()
					return
				}
				const failed = result === null || result === undefined ? null : (result.payload === undefined ? null : result.payload)
				setError(typeof tcErrorMessage === 'function' ? tcErrorMessage(failed, t) : t('error'))
			})
		}

		if (count === 0) return null
		const current = queue[0]
		const storeBusy = snapshot.busy !== null && snapshot.busy !== undefined && snapshot.busy.action === 'decisionAnswer'
		const chipStyle = placement === null ? undefined : { right: placement.right + 'px', bottom: placement.bottom + 'px' }
		const panelStyle = placement === null ? undefined : { maxHeight: placement.maxHeight + 'px' }
		const chipLabel = t('decisionOverlayChip').replace('{n}', String(count))
		return h(
			'div',
			{
				ref: rootRef,
				className: 'gbt-decisiondock',
				'data-decision-dock': 'true',
				'data-decision-overlay': 'dock',
				'data-decision-pending': String(count),
				'data-decision-attention': attention === null ? undefined : attention,
				'data-attention-play': attention === null ? undefined : String(state.attentionPlays),
				style: chipStyle,
			},
			open
				? h(
						'section',
						{
							className: 'gbt-decisiondockpanel',
							'data-decision-dock-panel': 'true',
							role: 'dialog',
							'aria-label': t('decisionTitle'),
							style: panelStyle,
						},
						h(DecisionCard, {
							key: current.id,
							decision: current,
							queueLeft: count - 1,
							receivedAt: snapshot.receivedAt,
							t: t,
							busy: submitting || storeBusy,
							error: error,
							onAnswer: answer,
							onDismiss: function () { setOpen(false) },
						}),
					)
				: null,
			h(
				'button',
				{
					type: 'button',
					className: 'gbt-chipbtn gbt-decisionchip',
					'data-decision-chip': 'true',
					'data-decision-attention': attention === null ? undefined : attention,
					'aria-expanded': open ? 'true' : 'false',
					'aria-haspopup': 'dialog',
					'aria-label': chipLabel,
					title: t('decisionOverlayAria'),
					onClick: function () { setOpen(!open) },
				},
				h('span', { className: 'gbt-decisionchipdot', 'aria-hidden': 'true' }),
				h('span', { 'data-decision-chip-label': 'true' }, chipLabel),
			),
		)
	}

	DecisionOverlay.state = state
	DecisionOverlay.POLL_MS = POLL_MS
	DecisionOverlay.CHIP_HEIGHT = CHIP_HEIGHT
	DecisionOverlay.PANEL_MAX = PANEL_MAX
	DecisionOverlay.ATTENTION_MS = ATTENTION_MS
	DecisionOverlay.ATTENTION_LIMIT = ATTENTION_LIMIT
	DecisionOverlay.decisionQueueOf = decisionQueueOf
	DecisionOverlay.computePlacement = computePlacement
	DecisionOverlay.attentionModeFor = attentionModeFor
	DecisionOverlay.observePendingCount = observePendingCount
	DecisionOverlay.clearAttention = clearAttention
	return DecisionOverlay
}

module.exports = { createDecisionOverlay }

				})(module, module.exports)
				const factory = module.exports.createDecisionOverlay
				return factory({
					React: React,
					h: h,
					DecisionModal: DecisionModal,
					store: store,
					useTranslate: useTranslate,
					useSnapshot: useSnapshot,
					tcErrorMessage: tcErrorMessage,
				})
			})()

			// T-205: the settings page is shared by the task center panel and the plugin
			// bundle card; the card factory exposes both so apply() can register it.
			return { TaskCenter: TaskCenter, Glyph: Glyph, SettingsPage: SettingsPage, createSettingsCard: createSettingsCard, DecisionOverlay: DecisionOverlay }
		}

		// T-205: the plugin settings card and the task center's settings entry both
		// mount the SAME page (the SettingsPage view). The card only supplies what
		// the page needs: the shared task store (the CURRENT project, never a
		// last-active fallback), the engine path's config scope and the browser
		// theme preference. The page, its theme rail and its footer live in
		// client/src/views/settings-page.cjs.

		return {
			/** Cordis services this browser half needs; slots is mandatory here. */
			inject: ['slots', 'locale'],
			apply(ctx) {
				// T-99: the session resolver asks this context for the Host's own
				// services (uiWorkspace / uiSession) at request time.
				tcHostContext = ctx
				// T-205: ONE store and ONE views instance per activation. The panel
				// and the plugin card therefore read and write the same project and
				// the same settings; neither resolves a project of its own.
				const store = createTaskStore(ctx.locale.bind(TC_NS))
				const views = createTaskCenterViews(ctx, store)
				// The panel and the shared settings page (including the bundle card)
				// speak the task center namespace. Register it before the card slot is
				// offered so the slot's declared locale always resolves. The agent tab
				// below ships its own small namespace next to its component.
				ctx.effect(
					() => ctx.locale.register(TC_NS, TC_DICT),
					'godot-bridge: task center dictionaries',
				)
				// The card opens on the engine path its bundle has always configured;
				// the other themes are one click away in the same page.
				ctx.inject(['configForms'], (forms) => {
					const scope = forms.configForms.get(ENTRY_NS)
					// T-205: one component for both entry points — the bundle card is
					// the settings page in card mode, over the same store and scope.
					const SettingsCard = views.createSettingsCard({ store: store, engineScope: scope, locale: ctx.locale, ns: TC_NS })
					ctx.slots.inject('plugins.bundle.config', () =>
						ctx.slots.register(
							{ name: 'plugins.bundle.config', key: 'godot-bridge', locale: TC_NS },
							SettingsCard,
						),
					)
				})
				// T-209: the native right-sidebar agent tab. The sidebar services are
				// OPTIONAL: a shell without them never runs this callback, the
				// card/detail entry stays hidden (the module handle reports
				// unavailable), and a host that rejects the registration must not take
				// the panel down with it.
				// T-212: the same sidebar injection also waits for uiWorkspace, the
				// service the tab body asks to switch the main view to the subagent's
				// conversation. The tab module treats it as optional too: a mount
				// without it still renders the overview and simply omits the action.
				ctx.effect(() => ctx.locale.register(AGENT_TAB_NS, AGENT_TAB_COPY), 'godot-bridge: agent tab copy')
				ctx.inject(['sidebarRight', 'sidebarRightTabs', 'uiWorkspace'], (scoped) => {
					const tab = createAgentSidebarView({
						React: React,
						h: h,
						tcAgentTreeOf: tcAgentTreeOf,
						tcPhaseLabel: tcPhaseLabel,
						tcAgo: tcAgo,
						tcAgentStatusKey: tcAgentStatusKey,
					})
					return tab.mount(scoped, {
						slots: ctx.slots,
						store: store,
						locale: ctx.locale,
						ns: AGENT_TAB_NS,
						taskNs: TC_NS,
						// Explicit even though the module can read the scope: this is the
						// service the overview's "open subagent conversation" action uses.
						uiWorkspace: scoped === null || scoped === undefined ? null : scoped.uiWorkspace,
					})
				})
				ctx.effect(() => {
					const style = document.createElement('style')
					style.setAttribute('data-plugin', 'godot-bridge')
					style.setAttribute('data-plugin-css', 'godot-bridge/task-center.css')
					style.textContent = TC_CSS + AGENT_TAB_CSS
					document.head.appendChild(style)
					return () => {
						style.remove()
					}
				}, 'godot-bridge: task center styles')
				ctx.effect(() => {
					// T-99: when the Host switches the session it shows, follow it at once
					// instead of waiting for the next poll. A shell without the service
					// simply never fires this; the poll still picks the session up.
					ctx.inject(['uiWorkspace'], (scoped) => {
						const workspace = scoped === null || scoped === undefined ? null : scoped.uiWorkspace
						const selection = workspace === null || workspace === undefined ? null : workspace.selection
						if (selection === null || selection === undefined || typeof selection.subscribe !== 'function') return
						let seen = tcSessionIdInfo().id
						ctx.effect(
							() =>
								selection.subscribe(() => {
									const next = tcSessionIdInfo().id
									if (next === seen) return
									seen = next
									void store.load()
								}),
							'godot-bridge: follow the host session',
						)
					})
					const dropGlyph = ctx.slots.inject('sidebar.panellist', () =>
						ctx.slots.register(
							{
								name: 'sidebar.panellist',
								id: 'task-center',
								order: 30,
								label: () => ctx.locale.bind(TC_NS)('nav'),
								locale: TC_NS,
							},
							views.Glyph,
						),
					)
					const dropPanel = ctx.slots.inject('main', () =>
						ctx.slots.register({ name: 'main', key: 'task-center', locale: TC_NS }, views.TaskCenter),
					)
					// T-208: the conversation-page entry. 'shell.overlay' is a LIST slot
					// (the usage overlay already occupies it), so this is a separate
					// registration with its own id; order 120 sits after that plugin's
					// 100 instead of colliding with it. The chip renders nothing while
					// no decision is pending.
					const dropOverlay = ctx.slots.inject('shell.overlay', () =>
						ctx.slots.register(
							{
								name: 'shell.overlay',
								id: 'godot-bridge-decisions',
								order: 120,
								locale: TC_NS,
							},
							views.DecisionOverlay,
						),
					)
					return () => {
						dropGlyph()
						dropPanel()
						dropOverlay()
					}
				}, 'godot-bridge: task center panel')
			},
		}
	},
})
