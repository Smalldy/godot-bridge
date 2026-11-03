/**
 * godot-bridge — browser half (DSH web client).
 *
 * The host half declares `godotPath` as a `.volatile()` config field of its
 * `tool-godot-bridge` row, so DSH 0.2 projects it into the settings document.
 * A form for it exists only if a browser half registers one of the Plugins
 * page's configuration slots; this file registers the **bundle's** one,
 * `plugins.bundle.config` keyed by the package name, so the engine-path field
 * sits directly on the `godot-bridge` card's page, between its description and
 * its row list — one click from the plugin list, the same shape the shipped
 * configuration pages use. (The other slot, `plugins.row.config` keyed
 * `<package name>#<row id>`, would put the same form one level deeper, behind a
 * Configure control on the row; it is the right slot once a bundle has several
 * independently configurable rows, which this one does not.)
 *
 * The page hands `plugins.bundle.config` a `view` only — unlike
 * `plugins.row.config` it passes no `form` — so the form comes from the
 * settings service this file injects: `ctx.configForms.get(<row id>)`, whose
 * snapshot and writes are the same ones the host's own pages bind. A save ends
 * in `ctx.configEditor.edit(...)`, i.e. the profile `cordis.patch.yml` layer
 * the `godot_set_engine_path` tool writes, so both entry points agree and the
 * new path applies without a restart.
 *
 * Version boundary: DSH 0.1.6–0.1.x declares these slots but has no
 * settings-form service, so the whole registration sits behind
 * `ctx.inject(['configForms'], ...)`: on those runtimes the card keeps exactly
 * the behaviour it has today (no engine-path field) instead of rendering a
 * form that could not save.
 *
 * Conventions this file must keep (dsh-client-modules):
 *   - loaded as a classic script through window.__ModuleLoader__.load();
 *   - `id` equals the package name, and the module table seeds React;
 *   - only platform-seed specifiers are required (react, react-dom, ...);
 *     anything else would have to be declared in `dsh.client.external`, and
 *     DSH's own authoring rules ask plugins not to load Harness client
 *     packages at all — the controls below are ours, styled with the host's
 *     `--dsw-alias-*` tokens copied from the host's own settings form.
 */
window.__ModuleLoader__.load({
	id: 'godot-bridge',
	factory(require) {
		const React = require('react')
		const h = React.createElement

		/** Locale namespace this browser half owns. */
		const LOCALE_NS = 'godotBridge'
		/** Settings namespace of the row this bundle inserts: the row id itself. */
		const ENTRY_NS = 'tool-godot-bridge'
		/** The config field the form edits, as the host Config declares it. */
		const FIELD = 'godotPath'

		/** English copy. */
		const en = {
			label: 'Godot engine path',
			hint:
				'Full path to the real Godot executable (never a version-manager shim). Saving writes it to the tool-godot-bridge row of this profile’s cordis.patch.yml and it applies immediately; the path is used as typed, so make sure it exists.',
			save: 'Save',
			saving: 'Saving…',
			saved: 'Saved. New godot_* calls use this path.',
			failed: 'The deployment did not accept this value; the stored path is unchanged.',
			reset: 'Reset to default',
			overridden: 'Set in this profile',
			readOnly: 'This deployment stores settings read-only.',
			unavailable:
				'This plugin is not loaded, so its configuration cannot be edited right now.',
		}

		/** Simplified Chinese copy. */
		const zh = {
			label: 'Godot 可执行文件路径',
			hint:
				'指向真实 Godot exe 的完整路径（不要用版本管理器 shim）。保存会写入本 profile 的 cordis.patch.yml 中 tool-godot-bridge 那一行并立即生效；该值按原样使用，请确认文件存在。',
			save: '保存',
			saving: '保存中…',
			saved: '已保存。新的 godot_* 调用将使用该路径。',
			failed: '本部署没有接受该值；已保存的路径未改变。',
			reset: '恢复默认',
			overridden: '本 profile 已设置',
			readOnly: '本部署的设置为只读。',
			unavailable: '该插件当前未加载，暂时无法编辑它的配置。',
		}

		/**
		 * Controls copied from the host settings form (dsh-client-ui-primitives
		 * `settings-form/*.module.css`, `Input.module.css`, `Button.module.css`)
		 * under this plugin's own prefix, keeping only `--dsw-alias-*` token
		 * references so a theme change degrades appearance, never rendering.
		 */
		const CSS = [
			'.godot-bridge-field{display:flex;flex-direction:column;gap:6px;padding:12px 0}',
			'.godot-bridge-head{display:flex;align-items:center;gap:8px}',
			'.godot-bridge-label{font-size:13px;font-weight:500;line-height:1.5;color:var(--dsw-alias-label-primary)}',
			'.godot-bridge-badge{font-size:11px;line-height:1.5;padding:1px 6px;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}',
			'.godot-bridge-input{height:34px;padding:0 12px;border:0.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-3);font:inherit;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-primary)}',
			'.godot-bridge-input:focus-visible{outline:none;border-color:var(--dsw-alias-state-business-primary)}',
			'.godot-bridge-input:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}',
			'.godot-bridge-hint{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}',
			'.godot-bridge-footer{display:flex;align-items:center;gap:8px;padding-top:16px}',
			'.godot-bridge-save{appearance:none;border:1px solid transparent;border-radius:var(--dsw-radius-md);padding:5px 14px;font:inherit;font-size:13px;line-height:1.5;cursor:pointer;background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3)}',
			'.godot-bridge-save:disabled{opacity:.4;cursor:default}',
			'.godot-bridge-save:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}',
			'.godot-bridge-reset{border:none;background:none;padding:0;font:inherit;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary);cursor:pointer}',
			'.godot-bridge-reset:hover:not(:disabled){color:var(--dsw-alias-label-primary)}',
			'.godot-bridge-reset:disabled{cursor:default;opacity:.4}',
			'.godot-bridge-message{flex:1;min-width:0;margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}',
			'.godot-bridge-message[data-failed="true"]{color:var(--dsw-alias-state-error-primary)}',
			'.godot-bridge-notice{margin:0 0 12px;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}',
		].join('')

		/** The one field's current text, tolerating any shape the host may project. */
		function textOf(value) {
			return typeof value === 'string' ? value : ''
		}

		/**
		 * Build the engine-path form over one settings scope.
		 *
		 * The draft lives in the DOM (an uncontrolled input remounted whenever the
		 * host revision moves), because only a save writes and leaving the card
		 * drops staged edits — the contract the host's own settings form follows.
		 *
		 * @param scope - the settings scope of the `tool-godot-bridge` row, whose
		 *   snapshot this component subscribes to and whose `set`/`unset` it writes
		 *   through.
		 * @returns the component the Plugins page renders for this bundle.
		 */

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
			ownerMismatch: '卡片的所属会话 {owner} 与派发 Lead 的会话 {lead} 不一致',
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
				emptyBoard: '还没有任务。点“新建任务”开始。',
				emptyQueue: '没有可派发的任务。',
				emptyHistory: '没有历史记录。',
				workersTab: '执行者',
				workersLead: 'Team Lead',
				workersCap: '上限',
				workersBusy: '执行中',
				workersIdle: '空闲',
				workersProvisioning: '启动中',
				workersFailed: '失败',
				workerName: '名称',
				workerMember: '成员',
				workerStatus: '状态',
				workerCurrent: '当前任务',
				workersHint: '执行者是当前 Team 的 WorkAgent：优先复用空闲成员，没有空闲时才新建；池上限由派发设置决定（并发与上限取较小值）。',
				workersProjectLabel: '面板项目',
				workersTeamLabel: '会话 Team',
				workersSessionLabel: '会话',
				workersLeadSelf: '本会话 Lead',
				workersCapConcurrent: '并发',
				workersRoleRunning: '执行中',
				workersRoleBusy: '有卡',
				workersRoleQueue: '队列',
				workersMismatch: '这些执行者属于会话 Team（项目 {team}），不是面板项目 {panel}；执行者仍取自请求会话的 Team，这里不会按项目切换。',
				roleScaleNote: '团队规模由派发设置（并发 / 上限）决定；角色只定义行为。',
				workersNoTeam: '本会话没有团队：调用 task_center { action: "bootstrapTeam" } 建队后再派发。',
			workerQueued: '排队 {n}',
			workersIdleNote: '待命（进程在运行，没有分配任务）',
			workerRole: '角色',
			workerRoleConfigured: '已配置',
			workerRoleRunning: '在跑',
			workerRoleIdle: '待命',
			workerRoleWithCard: '手上有卡',
				workersEmpty: '本会话的 Team 里还没有成员 → 调用 bootstrapTeam 建最小团队。',
				workersUnavailable: '宿主没有提供执行者池信息。',
				workersError: '执行者池不可读',
				workersErrNoService: '当前 profile 没有 Agent Teams 服务',
				workersErrNoLead: '没有活着的 Team Lead',
				workersErrRoster: '花名册不可读',
				unknownProjectHint: '这个会话还没有绑定项目。请在会话里调用一次 task_center，或在下方手动打开一个项目。',
				notActivatedTitle: '未激活任何项目',
				notActivatedStepCall: '在会话里调用一次 task_center——宿主会把当前项目记为「上次项目」并激活它。',
				notActivatedStepOpen: '或者手动选择一个项目目录打开；此后启动会直接回到它。',
				err_unknown_project: '这个会话还没有绑定项目。请在会话里调用一次 task_center，或在面板里手动打开一个项目。',
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
				settingsTitle: '派发设置',
				maxConcurrent: '最大并发',
				concurrencyHint: '1–8。执行者上限自动设为并发 + 1；没有空闲执行者时会自动新建；连续失败 3 次后任务阻塞。',
				invalidConcurrency: '并发必须是 1–8 的整数',
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
				notePlaceholder: '可选：说明这次操作',
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
				projectTeam: '该项目团队',
				projectTeamOk: '{lead} · {n} 名成员',
				projectTeamMissing: '无 → 请在该会话中初始化',
			projectTeamNoMembers: '只有 Lead，缺 {roles} → 请在该会话中建队',
			projectTeamStale: '团队会话已过期（最后活动 {at}）→ 请在该项目的当前会话里打开任务中心',
			projectTeamMissingRoles: '缺 {roles}（角色管理器会在需要时自动创建）',
				projectTeamUnavailable: '本 profile 没有团队服务（看板仍可用）',
				projectTeamNext: '下一步（先建团队再建卡）：',
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
				statusLead: 'Team Lead',
				statusKind: '类型',
				statusDescription: '描述',
				statusSession: '会话',
				statusCurrentTask: '当前任务',
				statusSessionHint: '当前 DSH 没有可用的会话跳转 API：可以复制 session id，或从 Team 列表打开该会话。',
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
				statusAgentsUnavailable: '宿主没有提供执行代理信息。',
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
				statusCardAgents: '执行者',
				statusCardActivity: '活动',
				statusConcurrent: '并发',
				statusReady: '就绪',
				statusWhyPaused: '派发已暂停。恢复后，就绪任务按优先级派发',
				statusWhyNoReady: '没有就绪任务（全部完成或被依赖挡住）',
				statusWhyFull: '并发已满',
				statusWhyBlocked: '有 {n} 个任务被阻塞',
				statusWhyRunning: '派发中，队列已清空',
				statusLastScan: '上次扫描',
				statusMergeQueue: '合并队列',
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
				detailAllFields: '全部字段（含历史）',
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
				detailSpecHint: '说明与验收默认折叠。',
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
				actorRoleMerger: '合并者',
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
				leftoverRoleFrom: '遗留实例（来自 {project}）',
				leftoverRole: '遗留实例',
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
				roleKindMerger: '合并',
				roleKindLead: 'Lead',
				roleKindTeammate: '成员',
				roleSave: '保存',
				roleCreate: '创建',
				rolePrompt: '指令',
				roleSkills: '技能',
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
				roleEditorTabsLabel: '角色种类',
				roleEditorCreateBlank: '空白新建 profile（次要入口）',
				roleEditorNoProfile: '该阶段没有可用的角色',
				roleCurrentUse: '当前使用',
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
				rolePreviewRawTitle: '原始提示词',
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
			ownerMismatch: 'The card\'s owner session {owner} differs from the dispatching Lead session {lead}',
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
				emptyBoard: 'No tasks yet. Use “New task” to start.',
				emptyQueue: 'Nothing is ready to dispatch.',
				emptyHistory: 'No history yet.',
				workersTab: 'Workers',
				workersLead: 'Team lead',
				workersCap: 'Cap',
				workersBusy: 'Busy',
				workersIdle: 'Idle',
				workersProvisioning: 'Starting',
				workersFailed: 'Failed',
				workerName: 'Name',
				workerMember: 'Member',
				workerStatus: 'Status',
				workerCurrent: 'Current task',
				workersHint: 'Workers are the WorkAgents of the current Team: idle members are reused first and a new one is spawned only when none is idle; the pool cap comes from the dispatch settings (the smaller of concurrency and cap).',
				workersProjectLabel: 'Panel project',
				workersTeamLabel: 'Session team',
				workersSessionLabel: 'Session',
				workersLeadSelf: 'This session’s lead',
				workersCapConcurrent: 'Concurrency',
				workersRoleRunning: 'Running',
				workersRoleBusy: 'Has card',
				workersRoleQueue: 'Queue',
				workersMismatch: 'These workers belong to the request session’s team (project {team}), not the panel project {panel}; the session team is shown as-is, not switched by project.',
				roleScaleNote: 'Team size comes from the dispatch settings (concurrency / cap); a role only defines behaviour.',
				workersNoTeam: 'This session has no team: call task_center { action: "bootstrapTeam" } before dispatching.',
			workerQueued: 'queued {n}',
			workersIdleNote: 'idle (process is running, no task assigned)',
			workerRole: 'Role',
			workerRoleConfigured: 'Configured',
			workerRoleRunning: 'Running',
			workerRoleIdle: 'Idle',
			workerRoleWithCard: 'Has card',
				workersEmpty: 'This session’s team has no members yet → call bootstrapTeam to create the minimum roster.',
				workersUnavailable: 'The host did not report a worker pool.',
				workersError: 'Worker pool unreadable',
				workersErrNoService: 'this profile has no Agent Teams services',
				workersErrNoLead: 'no live Team Lead',
				workersErrRoster: 'the roster could not be read',
				unknownProjectHint: 'This session is not bound to a project yet. Call task_center once in the session, or open a project manually below.',
				notActivatedTitle: 'No project is active',
				notActivatedStepCall: 'Call task_center once in this session: the host records the current project as its last active project and activates it.',
				notActivatedStepOpen: 'Or open a project directory manually; every later start returns to it.',
				err_unknown_project: 'This session is not bound to a project yet. Call task_center once in the session, or open a project from the panel.',
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
				settingsTitle: 'Dispatch settings',
				maxConcurrent: 'Maximum concurrency',
				concurrencyHint: '1–8. The worker cap becomes concurrency + 1; a worker is spawned when none is idle; a task blocks after 3 consecutive failures.',
				invalidConcurrency: 'Concurrency must be an integer from 1 to 8',
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
				notePlaceholder: 'Optional note for this action',
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
				projectTeam: 'Project team',
				projectTeamOk: '{lead} · {n} members',
				projectTeamMissing: 'none → initialize it in this session',
			projectTeamNoMembers: 'Lead only, missing {roles} → bootstrap the team in this session',
			projectTeamStale: 'The team session is stale (last active {at}) → open the task center from the project\'s current session',
			projectTeamMissingRoles: 'missing {roles} (the role manager creates them on demand)',
				projectTeamUnavailable: 'no team services in this profile (the board still works)',
				projectTeamNext: 'Next step (create the team before cards):',
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
				statusLead: 'Team Lead',
				statusKind: 'Kind',
				statusDescription: 'Description',
				statusSession: 'Session',
				statusCurrentTask: 'Current task',
				statusSessionHint: 'This DSH build has no jump-to-session API: copy the session id, or open the session from the Team list.',
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
				statusCardActivity: 'Activity',
				statusConcurrent: 'concurrent',
				statusReady: 'ready',
				statusWhyPaused: 'Dispatch is paused. Once resumed, ready tasks are dispatched by priority',
				statusWhyNoReady: 'no ready task (all done or blocked by dependencies)',
				statusWhyFull: 'concurrency is full',
				statusWhyBlocked: '{n} task(s) are blocked',
				statusWhyRunning: 'dispatching; queue is empty',
				statusLastScan: 'last scan',
				statusMergeQueue: 'merge queue',
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
				detailAllFields: 'All fields (with history)',
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
				detailSpecHint: 'Spec and acceptance are collapsed by default.',
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
				actorRoleMerger: 'merger',
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
				leftoverRoleFrom: 'leftover instance (from {project})',
				leftoverRole: 'leftover instance',
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
				rolesHint: 'Role profiles belong to the user: create/update/delete a profile, bind a stage, drain or replace instances, or reset the defaults.',
				roleStatus: 'Status',
				roleInstances: 'Instances',
				roleKindWorker: 'worker',
				roleKindReviewer: 'reviewer',
				roleKindTester: 'tester',
				roleKindMerger: 'merger',
				roleKindLead: 'lead',
				roleKindTeammate: 'teammate',
				roleSave: 'Save',
				roleCreate: 'Create',
				rolePrompt: 'Prompt',
				roleSkills: 'Skills',
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
				roleEditorTabsLabel: 'Role kind',
				roleEditorCreateBlank: 'New blank profile (secondary)',
				roleEditorNoProfile: 'no role is available for this stage',
				roleCurrentUse: 'Currently using',
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
				rolePreviewRawTitle: 'Raw prompt',
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
			},
		}

		const TC_CSS = [
			'.gbt-root{display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5}',
			'.gbt-header{display:flex;align-items:center;gap:16px;padding:14px 18px;border-bottom:0.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-3);flex-wrap:wrap}',
			'.gbt-brand{display:flex;align-items:center;gap:10px;min-width:0}',
			'.gbt-mark{width:30px;height:30px;border-radius:9px;display:grid;place-items:center;background:var(--dsw-alias-state-business-primary);color:#fff;font-weight:600;font-size:15px;flex:none}',
			'.gbt-title{margin:0;font-size:15px;font-weight:600;letter-spacing:.01em}',
			'.gbt-titleline{display:flex;align-items:center;gap:7px;min-width:0}' +
				'.gbt-projectsource{flex:none;font-size:10px;line-height:1.6;padding:0 6px;border-radius:999px;text-transform:none;letter-spacing:0;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);border:0.5px solid var(--dsw-alias-border-l4);cursor:default}' +
				'.gbt-projectsource[data-project-source="session"]{color:var(--dsw-alias-state-business-primary);border-color:var(--dsw-alias-state-business-primary)}',
			'.gbt-project{margin:0;font-size:11px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:340px;font-family:ui-monospace,SFMono-Regular,Consolas,monospace}',
			// T-110: the Team the board dispatches to. A missing team is a WAIT, not an
			// error: amber-ish text that tells the session to create it.
			'.gbt-projectteam{margin:1px 0 0;font-size:10px;line-height:1.5;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:340px;color:var(--dsw-alias-label-tertiary)}',
			'.gbt-projectteam[data-project-team="ok"]{color:var(--dsw-alias-label-secondary)}',
			'.gbt-projectteam[data-project-team="missing"]{color:var(--dsw-alias-state-warn-label)}',
			'.gbt-projectteam[data-project-team="unavailable"]{color:var(--dsw-alias-label-tertiary);opacity:.75}',
			'.gbt-counts{display:flex;gap:6px;flex-wrap:wrap}',
			'.gbt-count{display:flex;align-items:center;gap:5px;padding:2px 9px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);font-size:11px;color:var(--dsw-alias-label-secondary)}',
			'.gbt-count b{font-weight:600;color:var(--dsw-alias-label-primary)}',
			'.gbt-workermeta{display:flex;gap:6px;flex-wrap:wrap;margin:0 0 12px}',
			// T-137: the executors page is three explicit layers — team head, role cards,
			// member table. Tokens only (T-133); the table scrolls inside its wrapper so
			// a narrow panel never gets a horizontal page overflow.
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
			'.gbt-col{flex:1 1 0;min-width:172px;max-width:330px;background:var(--dsw-alias-bg-layer-3);border:0.5px solid var(--dsw-alias-border-l4);border-radius:12px;display:flex;flex-direction:column;max-height:100%;min-height:120px}',
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
				'.gbt-colcount{margin-left:auto;font-weight:500;color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-bg-layer-2);border-radius:999px;padding:0 7px;font-size:10px}',
			'.gbt-cards{display:flex;flex-direction:column;gap:8px;padding:9px;overflow:auto;flex:1 1 auto;min-height:0}',
			'.gbt-card{border:0.5px solid var(--dsw-alias-border-l4);border-radius:10px;padding:10px 11px;background:var(--dsw-alias-bg-layer-2);cursor:pointer;display:flex;flex-direction:column;gap:7px;transition:border-color .12s ease,box-shadow .12s ease}',
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
'.gbt-detailpanel{position:relative;display:flex;flex-direction:column;width:calc(100% - 48px);max-width:1080px;height:90vh;overflow:hidden;border:1px solid var(--line,var(--dsw-alias-border-l4));border-radius:8px;background:var(--panel,var(--dsw-alias-bg-layer-1));box-shadow:0 24px 64px rgba(0,0,0,.35)}',
'.gbt-detailpanel .gbt-drawerhead{border-bottom:1px solid var(--line,var(--dsw-alias-border-l4))}',
'.gbt-detailpanel .gbt-drawerbody{flex:1;overflow:auto}',
'.gbt-detailbody[data-detail-layout="two-column"]{display:grid;grid-template-columns:minmax(0,1fr) 280px;gap:12px;align-items:start}',
'.gbt-detailbody[data-detail-layout="compact"]{display:grid;grid-template-columns:minmax(0,1fr) 260px;gap:12px;align-items:start}',
'.gbt-detailbody[data-detail-layout="single"]{display:flex;flex-direction:column;gap:10px}',
'.gbt-detailbody[data-detail-layout="compact"] .gbt-detailevent{flex-wrap:nowrap;overflow-x:auto}',
'.gbt-detailstages{display:grid;grid-template-columns:repeat(5,minmax(64px,1fr));gap:8px;margin:4px 0 2px;overflow-x:auto}',
'.gbt-detailstages[data-detail-stages="wrap"]{grid-template-columns:repeat(3,minmax(64px,1fr));overflow:visible}',
'.gbt-detailsummary-one{flex-direction:row;align-items:baseline;gap:12px;flex-wrap:wrap}',
'.gbt-detailpanel .gbt-btn,.gbt-detailpanel .gbt-linkbtn{white-space:nowrap}',
'.gbt-detailstat b{font-size:13px;font-weight:600}',
'.gbt-detailstat span{font-size:11.5px;color:var(--t3,var(--dsw-alias-label-tertiary))}',
'@media (max-width:899px){.gbt-detailoverlay{padding:0}.gbt-detailpanel{width:100%;max-width:none;height:100%;border-radius:0;border:0}}',
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
'.gbt-statusview{display:flex;flex-direction:column;gap:12px}',
'.gbt-statustop{display:flex;align-items:flex-start;gap:12px}',
'.gbt-statussummary{font-size:15px;line-height:1.4;color:var(--t1,var(--dsw-alias-label-primary))}',
'.gbt-statusactions{margin-left:auto;display:flex;gap:8px}',
'.gbt-statusgrid{display:grid;gap:12px;grid-template-columns:300px 1fr 1.15fr;grid-template-rows:max-content max-content;align-content:start}',
'.gbt-statuscard{border:1px solid var(--line,var(--dsw-alias-border-l4));border-radius:8px;background:var(--panel,var(--dsw-alias-bg-layer-1));display:flex;flex-direction:column;min-height:0;min-width:0}',
'.gbt-statuscard[data-status-card="activity"]{grid-column:1 / -1}',
'.gbt-statuscardhead{display:flex;align-items:center;gap:8px;padding:9px 12px;border-bottom:1px solid var(--line,var(--dsw-alias-border-l4));font-size:12px}',
'.gbt-statusmeta{margin-left:auto;font-size:11.5px;color:var(--t2,var(--dsw-alias-label-tertiary))}',
'.gbt-statuscardbody{padding:10px 12px;min-height:0;display:flex;flex-direction:column;gap:6px}',
'.gbt-statuskvs{display:flex;gap:20px}',
'.gbt-statuskv{display:flex;align-items:baseline;gap:5px}',
'.gbt-statuskv b{font-size:18px;font-weight:600}',
'.gbt-statuskv span{font-size:11.5px;color:var(--t2,var(--dsw-alias-label-tertiary))}',
'.gbt-statuswhy{margin-top:6px;padding:8px 10px;border-radius:6px;background:var(--elev,var(--dsw-alias-bg-layer-2));font-size:12px;color:var(--t2,var(--dsw-alias-label-secondary));line-height:1.55}',
'.gbt-statusscan{margin-top:2px;font-size:11.5px;color:var(--t2,var(--dsw-alias-label-tertiary))}',
'.gbt-statusrow{display:flex;align-items:center;gap:8px;min-height:30px;border-bottom:1px solid var(--line,var(--dsw-alias-border-l4));font-size:12px}',
'.gbt-statusrow:last-child{border-bottom:0}',
'.gbt-statuswho{flex:none;color:var(--t1,var(--dsw-alias-label-primary))}',
'.gbt-statusrole{width:46px;flex:none;color:var(--t2,var(--dsw-alias-label-tertiary));font-size:11.5px}',
'.gbt-statustask{color:var(--t2,var(--dsw-alias-label-secondary));overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}',
'.gbt-statustime{margin-left:auto;flex:none;color:var(--t2,var(--dsw-alias-label-tertiary));font-size:11.5px;white-space:nowrap}',
'.gbt-statusmore{width:18px;flex:none;border:0;background:none;color:var(--t2,var(--dsw-alias-label-tertiary));cursor:pointer;padding:0}',
'.gbt-sessionrow{display:flex;align-items:center;gap:8px;padding:2px 0 4px 0;font-size:11.5px}',
'.gbt-statusfold{display:flex;align-items:center;gap:6px;margin-top:6px;font-size:11.5px;color:var(--t2,var(--dsw-alias-label-tertiary));border-top:1px dashed var(--line,var(--dsw-alias-border-l4));padding-top:7px}',
'.gbt-statusnote{color:var(--t2,var(--dsw-alias-label-tertiary));font-size:11.5px}',
'.gbt-statusev{display:flex;gap:10px;font-size:12px;line-height:1.5;padding:5px 0}',
'.gbt-statusevtime{width:44px;flex:none;color:var(--t2,var(--dsw-alias-label-tertiary));font-size:11.5px}',
'.gbt-statusevkind{width:52px;flex:none;font-size:11px;color:var(--t2,var(--dsw-alias-label-secondary))}',
'.gbt-statusevtext{color:var(--t1,var(--dsw-alias-label-primary));overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
'.gbt-linkbtn{border:0;background:none;color:var(--dsw-alias-state-business-primary);cursor:pointer;font:inherit;padding:0}',
			// T-143: worktree list + cleanup panel. Tokens only; the list scrolls, the page does not.
			'.gbt-wtview{display:flex;flex-direction:column;gap:6px;min-width:0}',
			'.gbt-wtbatch{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:2px}',
			'.gbt-wtsectionhead{margin-top:4px;padding-top:6px;border-top:0.5px solid var(--dsw-alias-border-l4);font-size:11px;font-weight:500;color:var(--dsw-alias-label-tertiary)}',
			'.gbt-wtlines{display:flex;flex-direction:column;min-width:0;max-height:260px;overflow:auto}',
			'.gbt-wtrow{display:flex;align-items:center;gap:6px 10px;flex-wrap:wrap;min-width:0;padding:5px 2px;border-bottom:0.5px solid var(--dsw-alias-border-l4);font-size:11.5px}',
			'.gbt-wtlabel{display:inline-flex;align-items:center;gap:5px;min-width:0;color:var(--dsw-alias-label-primary)}',
			'.gbt-wtlabel b{font-weight:600;font-family:ui-monospace,SFMono-Regular,Consolas,monospace}',
			'.gbt-wtpath,.gbt-wtbranch{max-width:210px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary)}',
			'.gbt-wtsha{flex:none;color:var(--dsw-alias-label-tertiary)}',
			'.gbt-wtbadges{display:inline-flex;align-items:center;gap:4px;flex-wrap:wrap}',
			'.gbt-wtactions{display:inline-flex;align-items:center;gap:5px;flex:none;margin-left:auto}',
			'.gbt-wtactions .gbt-btn{height:24px;padding:0 8px;font-size:11px}',
			'.gbt-wtpreview,.gbt-wtresult{margin-top:6px;padding:6px 8px;border:0.5px solid var(--dsw-alias-border-l4);border-radius:8px;background:var(--dsw-alias-bg-layer-2);font-size:11.5px;color:var(--dsw-alias-label-secondary)}',
			'.gbt-wtpreviewrow{padding:1px 0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
			'.gbt-wtresult[data-wt-result="error"]{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}',
'@media (max-width:900px){.gbt-statusgrid{grid-template-columns:1fr}}',
'.gbt-roleseg{display:inline-flex;align-items:center;gap:2px;padding:2px;border:1px solid var(--line,var(--dsw-alias-border-l4));border-radius:7px;background:var(--dsw-alias-bg-layer-2)}',
'.gbt-rolesegitem{appearance:none;height:26px;padding:0 14px;border:none;border-radius:5px;background:transparent;color:var(--t2,var(--dsw-alias-label-secondary));font:inherit;font-size:12px;font-weight:400;line-height:26px;cursor:pointer;text-decoration:none}',
'.gbt-rolesegitem:hover{background:var(--dsw-alias-bg-layer-3);color:var(--t1,var(--dsw-alias-label-primary))}',
'.gbt-rolesegitem:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}',
'.gbt-rolesegitem[aria-selected="true"]{background:var(--elev,var(--dsw-alias-bg-module-platform));color:var(--t1,var(--dsw-alias-label-primary))}',
'.gbt-rolecard{display:flex;flex-direction:column;gap:8px;min-width:0;border:1px solid var(--line,var(--dsw-alias-border-l4));border-radius:8px;background:var(--panel,var(--dsw-alias-bg-layer-1));padding:10px 12px}',
'.gbt-rolecardhead{font-size:13px;line-height:1.4;color:var(--t1,var(--dsw-alias-label-primary));font-weight:600}',
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
		].join('')

		/** ISO-8601 to epoch milliseconds, or null. */
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
		 * T-144: render a report body as light, SAFE Markdown. No dependency and no
		 * innerHTML: every node carries plain text. Headings (#/## -> h3, ### -> h4),
		 * `- ` lists, fenced code blocks and blank-line paragraphs are understood;
		 * unrecognised lines stay paragraph text (nothing is dropped). A parser error
		 * falls back to a <pre> that keeps the whole body.
		 */
		function tcReportBlocks(text) {
			try {
				const lines = String(text === undefined || text === null ? '' : text).replace(/\r\n/g, '\n').split('\n')
				const nodes = []
				let index = 0
				let paragraph = []
				const flushParagraph = function () {
					if (paragraph.length === 0) return
					nodes.push(h('p', { key: 'p-' + String(nodes.length), className: 'gbt-reportpara', 'data-report-block': 'paragraph' }, paragraph.join('\n')))
					paragraph = []
				}
				while (index < lines.length) {
					const line = lines[index]
					if (/^```/.test(line)) {
						flushParagraph()
						const code = []
						index += 1
						let terminated = false
						while (index < lines.length) {
							if (/^```/.test(lines[index])) {
								terminated = true
								break
							}
							code.push(lines[index])
							index += 1
						}
						// An unterminated fence is a parse failure: the outer catch keeps the
						// whole body in a <pre> instead of guessing where the code ends.
						if (terminated !== true) throw new Error('unterminated code fence')
						index += 1
						nodes.push(h('pre', { key: 'code-' + String(nodes.length), className: 'gbt-reportcode', 'data-report-block': 'code' }, h('code', null, code.join('\n'))))
						continue
					}
					const heading = /^(#{1,3})\s+(.*)$/.exec(line)
					if (heading !== null) {
						flushParagraph()
						nodes.push(h(heading[1].length <= 2 ? 'h3' : 'h4', { key: 'h-' + String(nodes.length), className: 'gbt-reportheading', 'data-report-block': 'heading', 'data-report-level': String(heading[1].length) }, heading[2]))
						index += 1
						continue
					}
					if (/^\s*[-*]\s+/.test(line)) {
						flushParagraph()
						const items = []
						while (index < lines.length && /^\s*[-*]\s+/.test(lines[index])) {
							items.push(lines[index].replace(/^\s*[-*]\s+/, ''))
							index += 1
						}
						nodes.push(h('ul', { key: 'ul-' + String(nodes.length), className: 'gbt-reportlist', 'data-report-block': 'list' }, items.map(function (item, at) { return h('li', { key: String(at), className: 'gbt-reportlistitem' }, item) })))
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

		/** A Team Lead name as DISPLAY text: a raw session id never appears verbatim. */
		function tcLeadText(lead, t) {
			const value = lead === null || lead === undefined ? '' : String(lead)
			if (value === '') return '—'
			if (value.indexOf('session-') !== 0) return value
			const short = tcSessionShort(value)
			return t('workersLeadSelf') + (short === null || short === '' ? '' : ' · ' + short)
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
				// T-110: the project's Team and, when it does not exist, the one
				// instruction the session must act on.
				team: payload.team === undefined || payload.team === null ? null : payload.team,
				// T-122: host-wide team inventory (diagnostics); the member table uses team.members.
				teams: payload.teams === undefined || payload.teams === null ? null : payload.teams,
				nextStep: payload.nextStep === undefined || payload.nextStep === null ? null : payload.nextStep,
				// How full the board file is: { bytes, limit, percent, level, cards,
				// bytesPerCard, headroomCards, warning }. The status page warns at 50%
				// and 75% of the cap, before the file stops loading at all.
				boardSize: payload.boardSize !== undefined && payload.boardSize !== null && typeof payload.boardSize === 'object' ? payload.boardSize : null,
				dispatch: payload.dispatch !== undefined && payload.dispatch !== null ? payload.dispatch : { state: 'paused' },
				counts: payload.counts !== undefined && payload.counts !== null ? payload.counts : {},
				queue: Array.isArray(payload.queue) ? payload.queue : [],
				tasks: tasks,
				locks: Array.isArray(payload.locks) ? payload.locks : [],
				workers: payload.workers === undefined || payload.workers === null ? null : payload.workers,
				agents: payload.agents === undefined || payload.agents === null ? null : payload.agents,
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
		function createTaskStore(t) {
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
			// T-111: the Host answers the activity timeline incrementally. Keep what we
			// already have and ask only for events after the last one we saw.
			let activityCursor = null
			let activityLog = []
			const listeners = new Set()
			let loading = null
			let timer = null
			let busy = null

			function emit(next) {
				snapshot = Object.assign({}, next, { busy: busy })
				listeners.forEach(function (listener) {
					listener()
				})
			}

			function setBusy(next) {
				if (busy === next) return
				busy = next
				emit(snapshot)
			}

			async function fetchJson(url, options) {
				const response = await fetch(url, options)
				return await response.json()
			}

			async function load() {
				if (loading !== null) return loading
				// No pin means NO ?project=: the Host resolves the session workspace and
				// answers with the project, which is the whole point of T-90.
				const pinned = tcPinnedProject()
				let url = pinned === null ? TC_STATE_URL : TC_STATE_URL + '?project=' + encodeURIComponent(pinned)
				if (snapshot.seq !== null && snapshot.seq !== undefined) url += (url.indexOf('?') >= 0 ? '&' : '?') + 'since=' + String(snapshot.seq)
				if (activityCursor !== null) url += (url.indexOf('?') >= 0 ? '&' : '?') + 'activitySince=' + encodeURIComponent(activityCursor)
				url = tcWithSession(url)
				loading = (async function () {
					try {
						const payload = await fetchJson(url, { headers: { accept: 'application/json' } })
						if (payload && payload.ok === true && (Array.isArray(payload.tasks) || payload.full === false)) {
							// The Host's answer is NOT written to localStorage: only an explicit
							// switch pins a project, so "follow the session" stays the default.
							// A routine poll keeps the outcome of the user's last action until
							// the next action replaces it; only the board data is refreshed.
							const next = tcMergeSnapshot(snapshot, payload)
							// T-111: accumulate the incremental activity page. A project switch
							// starts a new log (the old project's events no longer apply).
							if (next.project !== snapshot.project) {
								activityLog = []
								activityCursor = null
							}
							if (payload.activityEvents !== undefined && payload.activityEvents !== null && Array.isArray(payload.activityEvents.entries)) {
								const known = new Set(activityLog.map(function (entry) { return entry.key }))
								payload.activityEvents.entries.forEach(function (entry) {
									if (entry !== null && typeof entry === 'object' && typeof entry.key === 'string' && !known.has(entry.key)) activityLog.push(entry)
								})
								activityLog.sort(function (left, right) { return new Date(right.at).getTime() - new Date(left.at).getTime() })
								activityLog = activityLog.slice(0, 100)
								if (typeof payload.activityEvents.cursor === 'string' && payload.activityEvents.cursor !== '') activityCursor = payload.activityEvents.cursor
							}
							if (next.activityEvents !== null && next.activityEvents !== undefined) {
								next.activityEvents = Object.assign({}, next.activityEvents, { entries: activityLog.slice(0, 50) })
							}
							next.actionResult = snapshot.actionResult
							next.actionError = snapshot.actionError
							next.message = snapshot.message
							emit(next)
						} else {
							const failed = tcSnapshot(Object.assign({}, payload, { tasks: [] }), 'error', tcErrorMessage(payload, t))
							failed.actionResult = snapshot.actionResult
							failed.actionError = snapshot.actionError
							emit(failed)
						}
					} catch (error) {
						const offline = tcSnapshot(Object.assign({}, snapshot, { tasks: [] }), 'error', String((error && error.message) || error))
						offline.actionResult = snapshot.actionResult
						offline.actionError = snapshot.actionError
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
							const next = tcSnapshot(host, 'host', '', payload)
							if (quiet) {
								next.actionResult = snapshot.actionResult
								next.actionError = snapshot.actionError
								next.message = snapshot.message
							}
							emit(next)
						}
						return { ok: true, payload: payload }
					}
					if (!quiet) {
						emit(Object.assign({}, snapshot, { message: tcErrorMessage(payload, t), actionResult: null, actionError: payload === undefined || payload === null ? null : payload }))
					}
					return { ok: false, payload: payload }
				} catch (error) {
					if (!quiet) emit(Object.assign({}, snapshot, { message: String((error && error.message) || error) }))
					return { ok: false, error: error }
				} finally {
					if (busy === token) setBusy(null)
				}
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
			async function switchProject(path) {
				const next = typeof path === 'string' ? path.trim() : ''
				if (next === '') return { ok: false, payload: { ok: false, code: 'missing-path' } }
				const result = await send('openProject', { path: next })
				if (result.ok !== true) return result
				tcPinProject(next)
				emit(Object.assign({}, snapshot, { project: next, projectRoot: next, resolvedFrom: 'panel' }))
				return result
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
				send: send,
				switchProject: switchProject,
				listTasks: listTasks,
				loadDetail: loadDetail,
				startPolling: startPolling,
				stopPolling: stopPolling,
			}
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

			function TaskCard(props) {
				const task = props.task
				const t = props.t
				const now = props.now
				// T-132: investigations are a distinct card kind on the board.
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
				// T-113: the user can record the review/test verdict from the card. The
				// server still decides permissions; this is only the missing entry point.
				const [verdictOpen, setVerdictOpen] = React.useState(null)
				const [verdictReason, setVerdictReason] = React.useState('')
				const verdictKind = task.status === 'reviewing' ? 'review' : task.status === 'testing' ? 'test' : null
				function recordVerdict(action, extra) {
					if (typeof props.onVerdict !== 'function') return
					props.onVerdict(action, task.id, extra === undefined ? {} : extra)
					setVerdictOpen(null)
					setVerdictReason('')
				}
				function verdictEvent(event, work) {
					return function (clickEvent) {
						if (clickEvent !== undefined && clickEvent !== null && typeof clickEvent.stopPropagation === 'function') clickEvent.stopPropagation()
						work(clickEvent)
					}
				}
				const children = []
				const top = [h('span', { key: 'id', className: 'gbt-id' }, task.id)]
				if (investigate) {
					top.push(h('span', { key: 'kind', className: 'gbt-chip', 'data-tone': 'investigating', 'data-kind': 'investigate', title: t('kindInvestigateHint') }, '🔍 ' + t('kindInvestigate')))
				}
				if (task.priority !== 0) top.push(h('span', { key: 'prio', className: 'gbt-chip', 'data-tone': 'running' }, 'P' + String(task.priority)))
				if (task.status === 'blocked') top.push(h('span', { key: 'blocked', className: 'gbt-chip', 'data-tone': 'blocked' }, t('statusBlocked')))
				children.push(h('div', { key: 'top', className: 'gbt-cardtop' }, top))
				children.push(h('div', { key: 'title', className: 'gbt-cardtitle' }, task.title))
				const meta = []
				meta.push(h('span', { key: 'phase', className: 'gbt-chip', 'data-tone': tcPhaseTone(task), title: t('phaseCurrent') }, '▸ ' + tcPhaseLabel(task, t)))
				if (task.assignee !== null && task.assignee !== undefined) meta.push(h('span', { key: 'who', className: 'gbt-chip', 'data-tone': 'running' }, task.assignee.name))
				if (typeof task.requiredRole === 'string' && task.requiredRole !== '') {
					meta.push(h('span', { key: 'role', className: 'gbt-chip', title: t('requiredRole') }, '🧩 ' + task.requiredRole))
				}
				if (task.attempts > 0) meta.push(h('span', { key: 'attempts', className: 'gbt-chip', title: t('attempts') }, '↻ ' + String(task.attempts) + '/' + String(task.maxAttempts)))
				// T-132: an investigation has no review/test/merge phase, so those chips
				// are never rendered for it — not even from a stale hand-written record.
				if (!investigate && review !== null) {
					meta.push(
						h('span', { key: 'review', className: 'gbt-chip', 'data-tone': tcReviewTone(review.status), title: t('reviewStatus') + ' · ' + t('reviewAttempt') + ' ' + String(tcRound(review)) }, '👁 ' + tcReviewLabel(review.status, t) + ' · #' + String(tcRound(review))),
					)
					if (review.status !== 'pending' && typeof review.by === 'string' && review.by !== '') {
						meta.push(h('span', { key: 'reviewer', className: 'gbt-chip', title: t('reviewer') }, '👤 ' + review.by))
					}
				}
				if (!investigate && test !== null) {
					meta.push(
						h('span', { key: 'test', className: 'gbt-chip', 'data-tone': tcTestTone(test.status), title: t('testStatus') + ' · ' + t('testAttempt') + ' ' + String(tcRound(test)) }, '🧪 ' + tcTestLabel(test.status, t) + ' · #' + String(tcRound(test))),
					)
					if (typeof test.by === 'string' && test.by !== '') {
						meta.push(h('span', { key: 'tester', className: 'gbt-chip', title: t('tester') }, '👤 ' + test.by))
					}
				}
				if (lease !== null) {
					meta.push(
						h(
							'span',
							{
								key: 'lease',
								className: 'gbt-chip',
								'data-tone': lease.warn ? 'blocked' : 'waiting',
								'data-lease': lease.expired === true ? 'expired' : lease.remind === true ? 'reminder' : 'ok',
								title: lease.remind === true ? t('leaseReminder') : t('leaseLeft'),
							},
							lease.text,
						),
					)
				}
				if (fileCount > 0) meta.push(h('span', { key: 'files', className: 'gbt-chip' }, '🔒 ' + String(fileCount)))
				if (!investigate && merge !== null) {
					meta.push(h('span', { key: 'merge', className: 'gbt-chip', 'data-tone': tcMergeTone(merge.status), title: t('mergeTitle') }, '⇄ ' + tcMergeLabel(merge.status, t)))
				}
				if (!investigate && typeof task.target === 'string' && task.target !== '') meta.push(h('span', { key: 'target', className: 'gbt-chip', 'data-target-branch': task.target, title: t('targetBranch') }, '🎯 ' + task.target))
				if (branch !== '') meta.push(h('span', { key: 'branch', className: 'gbt-chip', title: branch }, '⎇ ' + branch))
				if (commit !== '') meta.push(h('span', { key: 'commit', className: 'gbt-chip', title: commit }, '● ' + commit.slice(0, 10)))
				if (worktree !== '') meta.push(h('span', { key: 'worktree', className: 'gbt-chip', title: worktree }, '🌿 ' + tcBaseName(worktree)))
				if (dispatchError !== null && task.status !== 'running') meta.push(h('span', { key: 'error', className: 'gbt-chip', 'data-tone': 'blocked', title: dispatchError }, '⚠ ' + t('dispatchError')))
				if (tcStageQueued(task)) {
					meta.push(h('span', { key: 'queued', className: 'gbt-chip', 'data-tone': 'waiting', 'data-queue': String(task.queuePosition) }, '⏳ ' + t('queuedChip').replace('{n}', String(task.queuePosition))))
				}
				const waiting = waitingChip(task, t, 'waiting')
				if (waiting !== null) meta.push(waiting)
				if (meta.length > 0) children.push(h('div', { key: 'meta', className: 'gbt-cardmeta' }, meta))
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
									{
										type: 'button',
										className: 'gbt-btn',
										// T-140: the positive verdict is the card's primary action;
										// the blocking one stays a danger outline.
										'data-variant': 'primary',
										'data-verdict-action': passing,
										onClick: function (clickEvent) {
											if (clickEvent !== undefined && clickEvent !== null && typeof clickEvent.stopPropagation === 'function') clickEvent.stopPropagation()
											recordVerdict(passing, verdictKind === 'test' ? { evidence: '' } : {})
										},
									},
									verdictKind === 'review' ? t('verdictReviewPass') : t('verdictTestPass'),
								),
								h(
									'button',
									{
										type: 'button',
										className: 'gbt-btn',
										'data-variant': 'danger',
										'data-verdict-action': blocking,
										// The blocking verdict needs a reason before it can be recorded.
										'data-verdict-needs-reason': 'true',
										onClick: function (clickEvent) {
											if (clickEvent !== undefined && clickEvent !== null && typeof clickEvent.stopPropagation === 'function') clickEvent.stopPropagation()
											setVerdictOpen(blocking)
										},
									},
									verdictKind === 'review' ? t('verdictReviewReject') : t('verdictTestFail'),
								),
							),
							needsReason
								? h(
									'div',
									{ className: 'gbt-cardverdictform', 'data-verdict-form': 'true' },
									h('label', { className: 'gbt-footnote' }, t('verdictReasonLabel')),
									h('textarea', {
										rows: 3,
										value: verdictReason,
										'data-verdict-reason': 'true',
										onInput: function (inputEvent) { setVerdictReason(String(inputEvent.target.value)) },
										onClick: function (clickEvent) { if (clickEvent !== undefined && clickEvent !== null && typeof clickEvent.stopPropagation === 'function') clickEvent.stopPropagation() },
									}),
									h(
										'div',
										{ className: 'gbt-cardverdictactions' },
										h(
											'button',
											{
												type: 'button',
												className: 'gbt-btn',
												'data-variant': 'primary',
												'data-verdict-submit': 'true',
												disabled: verdictReason.trim() === '',
												title: verdictReason.trim() === '' ? t('verdictReasonRequired') : undefined,
												onClick: function (clickEvent) {
													if (clickEvent !== undefined && clickEvent !== null && typeof clickEvent.stopPropagation === 'function') clickEvent.stopPropagation()
													if (verdictReason.trim() !== '') recordVerdict(blocking, verdictKind === 'test' ? { evidence: verdictReason.trim() } : { reasons: verdictReason.trim() })
												},
											},
											t('verdictSubmit'),
										),
										h('button', { type: 'button', className: 'gbt-btn', 'data-verdict-cancel': 'true', onClick: function () { setVerdictOpen(null); setVerdictReason('') } }, t('verdictCancel')),
									),
									)
								: null,
							)
						)
				}
				if (deps.length > 0) {
					children.push(
						h(
							'div',
							{ key: 'deps', className: 'gbt-cardmeta' },
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

			function Column(props) {
				const t = props.t
				const group = props.group
				const collapsed = props.collapsed === true
				const count = typeof props.count === 'number' ? props.count : group.tasks.length
				const visible = props.visibleTasks !== undefined ? props.visibleTasks : group.tasks
				const showBody = collapsed !== true || props.previewWhenCollapsed === true
				return h(
					'section',
					{ className: 'gbt-col', 'data-group': group.key, 'data-collapsed': collapsed ? 'true' : 'false' },
					h(
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
						h('span', null, group.key === 'done' ? group.label + ' · ' : group.label),
						h('span', { className: 'gbt-colcount' }, String(count)),
						props.note === undefined || props.note === null ? null : h('span', { className: 'gbt-colnote', 'data-col-note': 'investigating' }, props.note),
					),
					showBody === false
						? null
						: h(
								'div',
								{ className: 'gbt-cards' },
								visible.length === 0
									? h('div', { className: 'gbt-empty' }, t('noTasks'))
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

			function Board(props) {
				// T-135: the board is its own horizontal scrollport; this ref lets the
				// effect below park it on the first column that actually has cards.
				const boardRef = React.useRef(null)
				const t = props.t
				const tasks = props.snapshot.tasks
				const counts = props.snapshot.counts === undefined || props.snapshot.counts === null ? {} : props.snapshot.counts
				// Recently finished work is the first thing a reader looks for; the done
				// and blocked columns are therefore newest-first. The other columns keep
				// the host's scheduling order (priority, then age).
				function recentFirst(left, right) {
					const leftAt = tcTime(left.updatedAt) === null ? tcTime(left.createdAt) : tcTime(left.updatedAt)
					const rightAt = tcTime(right.updatedAt) === null ? tcTime(right.createdAt) : tcTime(right.updatedAt)
					const delta = (rightAt === null ? 0 : rightAt) - (leftAt === null ? 0 : leftAt)
					return delta !== 0 ? delta : String(right.id).localeCompare(String(left.id))
				}
				// T-132: the kind filter narrows the whole board. The running note counts
				// the investigations the FILTERED board contains (under the Dev filter it
				// must not advertise investigations the filter hides), and the done column
				// count/footer follow the filter instead of the global host total.
				const kindFilter = boardUiState.kind === 'dev' || boardUiState.kind === 'investigate' ? boardUiState.kind : 'all'
				const filtered = kindFilter === 'all' ? tasks : tasks.filter(function (task) { return tcKindOf(task) === kindFilter })
				const investigatingRunning = filtered.filter(function (task) { return tcKindOf(task) === 'investigate' && task.status === 'running' }).length
				const visibleDone = filtered.filter(function (task) { return task.status === 'done' }).slice().sort(recentFirst)
				const doneCount = kindFilter === 'all' && Number.isFinite(counts.done) ? counts.done : visibleDone.length
				const groups = [
					{ key: 'ready', label: t('ready'), tasks: filtered.filter(function (task) { return task.status === 'pending' && task.dependency !== undefined && task.dependency.state === 'ready' }) },
					{ key: 'waiting', label: t('waiting'), tasks: filtered.filter(function (task) { return task.status === 'pending' && (task.dependency === undefined || task.dependency.state !== 'ready') }) },
					{ key: 'running', label: t('runningCol'), tasks: filtered.filter(function (task) { return task.status === 'running' }) },
					{ key: 'reviewing', label: t('reviewingCol'), tasks: filtered.filter(function (task) { return task.status === 'reviewing' }) },
					{ key: 'testing', label: t('testingCol'), tasks: filtered.filter(function (task) { return task.status === 'testing' }) },
					{ key: 'done', label: t('doneCol'), tasks: visibleDone },
					{
						key: 'blocked',
						label: t('blockedCol'),
						tasks: filtered.filter(function (task) { return task.status === 'blocked' || task.status === 'cancelled' }).slice().sort(recentFirst),
					},
				]
				// T-135: where the scrollport should sit. Computing it during render keeps
				// the attribute testable; the effect applies it only when the target is
				// not already fully visible, so manual panning is never fought.
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
				}, [tasks.length, boardUiState.kind, scrollTarget])
				const kindFilterBar = h(
					'div',
					{ className: 'gbt-kindfilter', 'data-kind-filter': kindFilter, title: t('kindFilterHint') },
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
								'data-active': kindFilter === entry[0] ? 'true' : 'false',
								'aria-pressed': kindFilter === entry[0] ? 'true' : 'false',
								onClick: function () {
									boardUiState.kind = entry[0]
									if (typeof props.onKindFilterChange === 'function') props.onKindFilterChange()
								},
							},
							entry[1],
						)
					}),
				)
				if (tasks.length === 0) return h('div', { className: 'gbt-empty' }, t('emptyBoard'))
				function toggle(key) {
					tcWriteColumnCollapsed(key, !tcColumnCollapsed(key))
					if (props.onColumnToggle !== undefined) props.onColumnToggle()
				}
				const board = h(
					'div',
					{ className: 'gbt-board', ref: boardRef, 'data-scroll-target': scrollTarget === null ? '' : scrollTarget },
					groups.map(function (group) {
						const collapsed = tcColumnCollapsed(group.key)
						// The done column folds to the newest five cards, not to nothing:
						// the preview must stay readable while the archive stays out of the way.
						if (group.key === 'done') {
							const visible = collapsed ? group.tasks.slice(0, DONE_COLUMN_PREVIEW) : group.tasks
							return h(Column, {
								key: group.key,
								group: group,
								count: doneCount,
								visibleTasks: visible,
								collapsed: collapsed,
								allTasks: tasks,
								previewWhenCollapsed: true,
								t: t,
								now: props.now,
								selectedId: props.selectedId,
								onOpen: props.onOpen,
								onVerdict: props.onVerdict,
								onToggle: function () { toggle(group.key) },
								footer:
									doneCount === 0
										? null
										: h(
												'button',
												{
													type: 'button',
													className: 'gbt-linkbtn',
													'data-action': 'done-all',
													onClick: function () { if (props.onOpenDoneAll !== undefined) props.onOpenDoneAll() },
												},
												t('viewAllDone') + ' · ' + String(doneCount),
											),
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
							note: group.key === 'running' && investigatingRunning > 0 ? t('investigatingCount').replace('{n}', String(investigatingRunning)) : null,
						onOpen: props.onOpen,
						onVerdict: props.onVerdict,
						onToggle: function () { toggle(group.key) },
						})
					}),
				)
				return h('div', { className: 'gbt-boardwrap', 'data-board-kind': kindFilter }, kindFilterBar, board)
			}

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

			function WorkersView(props) {
				const t = props.t
				const snapshot = props.snapshot
				const workers = snapshot.workers
				const [copied, setCopied] = React.useState(null)
				const shell = function (child) { return h('div', { className: 'gbt-workersview' }, child) }
				const blocks = []
				const hint = h('p', { key: 'hint', className: 'gbt-footnote', 'data-worker-hint': 'true' }, t('workersHint'))
				if (snapshot.source === 'error') {
					return shell([hint, h('div', { key: 'offline', className: 'gbt-empty' }, t('workersUnavailable'))])
				}
				if (workers === null || workers === undefined) {
					return shell([hint, h('div', { key: 'unavailable', className: 'gbt-empty' }, t('workersUnavailable'))])
				}
				if (typeof workers.error === 'string' && workers.error !== '') {
					const errorKey = WORKER_ERROR[workers.error]
					const explanation = errorKey === undefined ? workers.error : t(errorKey) + ' (' + workers.error + ')'
					blocks.push(h('div', { key: 'error', className: 'gbt-banner', style: { margin: '0 0 12px' } }, h('span', null, t('workersError') + ': ' + explanation)))
				}
				const countText = function (value) { return Number.isFinite(value) ? String(value) : '—' }
				const members = Array.isArray(workers.members) ? workers.members : []
				const lead = typeof workers.lead === 'string' && workers.lead.length > 0 ? workers.lead : null
				const leadSession = lead !== null && /^session-/.test(lead) ? lead : workers.leadInfo !== null && workers.leadInfo !== undefined && typeof workers.leadInfo.session === 'string' ? workers.leadInfo.session : null
				const session = typeof workers.session === 'string' && workers.session !== '' ? workers.session : leadSession
				const teamProject = typeof workers.project === 'string' && workers.project !== '' ? workers.project : null
				const panelProject = typeof snapshot.project === 'string' && snapshot.project !== '' ? snapshot.project : null
				const dispatch = snapshot.dispatch !== null && snapshot.dispatch !== undefined ? snapshot.dispatch : {}
				const concurrent = Number.isFinite(dispatch.maxConcurrent) ? dispatch.maxConcurrent : null
				// 上限 is the hard pool ceiling (maxWorkAgents). workerCap is just a
				// fallback for hosts that predate it, so the head can read
				// "并发 3 · 上限 4" instead of collapsing both chips into the minimum.
				const cap = Number.isFinite(workers.cap) ? workers.cap : Number.isFinite(workers.workerCap) ? workers.workerCap : null
				const shortPath = function (value) { return typeof value === 'string' && value !== '' ? tcBaseName(value) : null }
				const sessionShort = tcSessionShort(session)
				const leadDisplay = tcLeadText(lead, t)
				const leadIsSession = lead !== null && /^session-/.test(lead)
				const copyValue = session === null ? leadSession : session
				const identity = h('div', { key: 'identity', className: 'gbt-workeridentity', 'data-worker-identity': 'true' },
					h('span', { key: 'project', className: 'gbt-workerid' }, h('span', { className: 'gbt-workeridlabel' }, t('workersProjectLabel')), h('b', { title: panelProject === null ? '' : panelProject }, panelProject === null ? '—' : shortPath(panelProject))),
					h('span', { key: 'team', className: 'gbt-workerid', 'data-worker-team-project': teamProject === null ? '' : teamProject }, h('span', { className: 'gbt-workeridlabel' }, t('workersTeamLabel')), h('span', { title: teamProject === null ? '' : teamProject }, teamProject === null ? '—' : '项目 ' + shortPath(teamProject))),
					h('span', { key: 'lead', className: 'gbt-workerid', 'data-worker-lead': lead === null ? '' : lead }, h('span', { className: 'gbt-workeridlabel' }, t('workersLead')), ' ', h('b', { title: leadIsSession ? lead : undefined }, leadDisplay)),
					h('span', { key: 'session', className: 'gbt-workerid', 'data-worker-session': session === null ? '' : session }, h('span', { className: 'gbt-workeridlabel' }, t('workersSessionLabel')), ' ', h('span', { className: 'gbt-mono', title: session === null ? '' : session }, sessionShort === null ? '—' : sessionShort)),
					copyValue === null
						? null
						: h('button', { type: 'button', className: 'gbt-btn', 'data-action': 'copy-session', 'data-session': copyValue, onClick: function () { void copyToClipboard(copyValue).then(function (ok) { setCopied(ok === true ? copyValue : 'failed') }) } }, copied === copyValue ? t('sessionCopied') : t('copySession')),
					copied === 'failed' ? h('span', { key: 'copy-failed', className: 'gbt-footnote' }, ' ' + t('copyFailed')) : null,
				)
				const chips = h('div', { key: 'chips', className: 'gbt-workerchips', 'data-worker-chips': 'true' },
					[	['concurrent', t('workersCapConcurrent'), countText(concurrent)],
						['cap', t('workersCap'), countText(cap)],
						['busy', t('workersBusy'), countText(workers.busy)],
						['idle', t('workersIdle'), countText(workers.idle)],
						['provisioning', t('workersProvisioning'), countText(workers.provisioning)],
						['failed', t('workersFailed'), countText(workers.failed)],
					].map(function (entry) {
						return h('span', { key: entry[0], className: 'gbt-count', 'data-worker-chip': entry[0] }, h('span', { className: 'gbt-workerchip-label' }, entry[1]), h('b', null, entry[2]))
					}))
				const headParts = [
					h('div', { key: 'title', className: 'gbt-workerheadtop' }, h('h3', { className: 'gbt-workertitle' }, t('workersTab'))),
					chips,
					identity,
				]
				if (workers.projectMatch === false && teamProject !== null && panelProject !== null) {
					headParts.push(h('div', { key: 'mismatch', className: 'gbt-banner', 'data-tone': 'warn', 'data-worker-mismatch': 'true', 'data-team-project': teamProject, 'data-panel-project': panelProject }, t('workersMismatch').replace('{team}', shortPath(teamProject)).replace('{panel}', shortPath(panelProject))))
				}
				blocks.push(h('div', { key: 'head', className: 'gbt-workerhead', 'data-worker-head': 'true' }, headParts))
				// Role overview: three (or four on a merge team) compact cards with LIVE numbers only.
				const roleCounts = workers.roleCounts !== null && workers.roleCounts !== undefined && typeof workers.roleCounts === 'object' ? workers.roleCounts : null
				const kindOrder = ['worker', 'reviewer', 'tester', 'merger']
				const kindOfMember = function (member) { return typeof member.kind === 'string' && member.kind !== '' ? member.kind : 'worker' }
				const membersOf = function (kind) { return members.filter(function (member) { return kindOfMember(member) === kind }) }
				const queueOf = function (kind) { return membersOf(kind).reduce(function (sum, member) { return sum + (Number.isFinite(member.queue) ? member.queue : 0) }, 0) }
				const fallbackCounts = function (kind) {
					const own = membersOf(kind)
					const busy = own.filter(function (member) { return member.currentTask !== null && member.currentTask !== undefined }).length
					const failed = own.filter(function (member) { return member.status === 'failed' }).length
					const provisioning = own.filter(function (member) { return member.status === 'provisioning' }).length
					const running = own.filter(function (member) { return member.status === 'running' }).length
					return { running: running, idle: Math.max(0, own.length - busy - failed - provisioning), busy: busy }
				}
				const cardKinds = kindOrder.filter(function (kind) {
					return kind === 'worker' || kind === 'reviewer' || kind === 'tester' || membersOf(kind).length > 0 || (roleCounts !== null && roleCounts[kind] !== undefined)
				})
				if (cardKinds.length > 0) {
					blocks.push(h('div', { key: 'roles', className: 'gbt-rolecards', 'data-worker-roles': 'true' },
						cardKinds.map(function (kind) {
							const counts = roleCounts !== null && roleCounts[kind] !== undefined ? roleCounts[kind] : fallbackCounts(kind)
							const bound = workers.roles !== null && workers.roles !== undefined && workers.roles.bound !== null && workers.roles.bound !== undefined && typeof workers.roles.bound[kind] === 'string' ? workers.roles.bound[kind] : null
							return h('div', { key: 'role-card-' + kind, className: 'gbt-workercard', 'data-role-card': kind },
								h('div', { className: 'gbt-workercardhead' },
									h('span', { className: 'gbt-workercardname' }, roleKindLabel(kind, t)),
									h('span', { className: 'gbt-pill', 'data-role-badge': kind, title: bound === null ? t('roleUseDefault') : bound }, bound === null ? t('roleUseDefault') : bound)),
								h('div', { className: 'gbt-workercardline' },
									h('span', { 'data-role-metric': 'running' }, t('workersRoleRunning') + ' ' + String(counts.running || 0)),
									h('span', { 'data-role-metric': 'idle' }, t('workersRoleIdle') + ' ' + String(counts.idle || 0)),
									h('span', { 'data-role-metric': 'busy' }, t('workersRoleWithCard') + ' ' + String(counts.busy || 0)),
									h('span', { 'data-role-metric': 'queue' }, t('workersRoleQueue') + ' ' + String(queueOf(kind)))))
						})))
				}
				if (lead === null) blocks.push(h('div', { key: 'noteam', className: 'gbt-empty' }, t('workersNoTeam')))
				if (members.length === 0) {
					blocks.push(h('div', { key: 'empty', className: 'gbt-empty' }, t('workersEmpty')))
					return shell(blocks)
				}
				const rankOf = function (kind) { const rank = kindOrder.indexOf(kind); return rank === -1 ? kindOrder.length : rank }
				const sorted = members.slice().sort(function (left, right) {
					const leftKind = kindOfMember(left)
					const rightKind = kindOfMember(right)
					if (rankOf(leftKind) !== rankOf(rightKind)) return rankOf(leftKind) - rankOf(rightKind)
					const leftName = typeof left.name === 'string' ? left.name : ''
					const rightName = typeof right.name === 'string' ? right.name : ''
					return leftName < rightName ? -1 : leftName > rightName ? 1 : 0
				})
				const rows = sorted.map(function (member, index) {
					const kind = kindOfMember(member)
					const name = typeof member.name === 'string' && member.name !== '' ? member.name : typeof member.id === 'string' && member.id !== '' ? member.id : '—'
					const status = typeof member.status === 'string' ? member.status : null
					const current = member.currentTask !== null && member.currentTask !== undefined ? member.currentTask : null
					let task = '—'
					if (current !== null && typeof current.id === 'string' && current.id !== '') {
						task = typeof current.title === 'string' && current.title !== '' ? current.id + ' · ' + current.title : current.id
					} else if (status === 'idle' || status === 'inactive') {
						task = t('workerRoleIdle')
					}
					const queue = Number.isFinite(member.queue) ? member.queue : 0
					return h('tr', { key: member.id === undefined || member.id === null ? String(index) : String(member.id), 'data-worker': name, 'data-status': status === null ? '' : status, 'data-kind': kind, 'data-col-row': 'member' },
						h('td', { 'data-col': 'worker-kind' }, h('span', { className: 'gbt-pill', 'data-role-badge': kind }, roleKindLabel(kind, t))),
						h('td', { className: 'gbt-mono', 'data-col': 'worker-name' }, h('span', { className: 'gbt-workername', title: name }, name)),
						h('td', { 'data-col': 'worker-status' }, h('span', { className: 'gbt-pill', 'data-status': status === null ? '' : status }, status === null ? '—' : workerStatusLabel(status, t))),
						h('td', { 'data-col': 'worker-task', title: current === null ? undefined : typeof current.title === 'string' && current.title !== '' ? current.id + ' · ' + current.title : String(current.id) }, h('span', { className: 'gbt-workertask' }, task)),
						h('td', { className: 'gbt-mono', 'data-col': 'worker-queue' }, queue > 0 ? String(queue) : '—'))
				})
				blocks.push(h('div', { key: 'tablewrap', className: 'gbt-tablewrap' },
					h('table', { className: 'gbt-locktable gbt-workertable', 'data-worker-table': 'true' },
						h('thead', null, h('tr', null, h('th', null, t('workerRole')), h('th', null, t('workerMember')), h('th', null, t('workerStatus')), h('th', null, t('workerCurrent')), h('th', null, t('workersRoleQueue')))),
						h('tbody', null, rows))))
				return shell(blocks)
			}


			const WORKER_STATUS = { running: 'workersBusy', idle: 'workersIdle', inactive: 'workersIdle', provisioning: 'workersProvisioning', failed: 'workersFailed' }
			const WORKER_ERROR = { 'no-team-service': 'workersErrNoService', 'no-lead': 'workersErrNoLead', 'roster-unreadable': 'workersErrRoster' }

			/** A worker status label; an unknown status is shown raw rather than guessed. */
			function workerStatusLabel(status, t) {
				const key = WORKER_STATUS[status]
				return key === undefined ? status : t(key)
			}


			// ── Roles / Status views: agents, worktrees, activity and role admin ──
			const ROLE_KIND_KEYS = { worker: 'roleKindWorker', reviewer: 'roleKindReviewer', tester: 'roleKindTester', merger: 'roleKindMerger', lead: 'roleKindLead', teammate: 'roleKindTeammate' }
			const WORKTREE_TYPE_KEYS = { main: 'wtTypeMain', task: 'wtTypeTask', verify: 'wtTypeVerify', test: 'wtTypeTest', merge: 'wtTypeMerge', other: 'wtTypeOther' }
			const AGENT_ERROR_KEYS = { 'no-team-service': 'workersErrNoService', 'no-lead': 'workersErrNoLead', 'roster-unreadable': 'workersErrRoster' }
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

			/** One agent row: kind, description, session (copy only — no fake jump), current task. */
			function AgentRow(props) {
				const t = props.t
				const member = props.member
				const isLead = props.isLead === true
				const [copied, setCopied] = React.useState(null)
				const name = typeof member.name === 'string' && member.name !== '' ? member.name : typeof member.id === 'string' ? member.id : '—'
				const kind = isLead === true ? 'lead' : typeof member.kind === 'string' ? member.kind : 'teammate'
				const session = typeof member.session === 'string' && member.session !== '' ? member.session : typeof member.id === 'string' && member.id !== '' ? member.id : ''
				const status = typeof member.status === 'string' ? member.status : 'unknown'
				const current = member.currentTask !== null && member.currentTask !== undefined ? member.currentTask : null
				let task = '—'
				if (current !== null && typeof current.id === 'string' && current.id !== '') {
					task = typeof current.title === 'string' && current.title !== '' ? current.id + ' · ' + current.title : current.id
				} else if (status === 'inactive') {
					task = t('workersIdle')
				}
				return h(
					'tr',
					{ 'data-agent': name, 'data-kind': kind, 'data-status': status },
					h('td', { className: 'gbt-mono', 'data-col': 'agent-name' }, isLead ? name + ' · ' + t('statusLead') : name),
					h('td', { 'data-col': 'agent-kind' }, roleKindLabel(kind, t)),
					h('td', { 'data-col': 'agent-description' }, typeof member.description === 'string' && member.description !== '' ? member.description : '—'),
					h(
						'td',
						{ 'data-col': 'agent-session' },
						session === '' ? '—' : h('code', { className: 'gbt-mono' }, session),
						session === ''
							? null
							: h(
									'button',
									{
										type: 'button',
										className: 'gbt-btn',
										style: { marginLeft: '6px' },
										'data-action': 'copy-session',
										'data-session': session,
										onClick: function () {
											void copyToClipboard(session).then(function (ok) {
												setCopied(ok === true ? session : 'failed')
											})
										},
									},
									copied === session ? t('sessionCopied') : t('copySession'),
								),
						copied === 'failed' ? h('span', { className: 'gbt-footnote' }, ' ' + t('copyFailed')) : null,
					),
					h('td', { 'data-col': 'agent-task' }, task),
				)
			}

			/** One stage binding row: current profile plus a bind control. */
			/**
			 * The blank-create form. Fork is the primary path to a new profile; this
			 * stays as the secondary entry for one that is not a copy of anything.
			 * It lives inside the editor card, collapsed.
			 */
			function RoleCreateForm(props) {
				const t = props.t
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
						role: valueOf(roleRef, 'reviewer'),
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
					h('label', null, t('roleKind'), h('select', { ref: roleRef, defaultValue: 'reviewer', 'data-field': 'role' }, ['worker', 'reviewer', 'tester'].map(function (kind) { return h('option', { key: kind, value: kind }, roleKindLabel(kind, t)) }))),
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
					if (Array.isArray(payload.instances)) parts.push(t('roleInstances') + ': ' + String(payload.instances.length))
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
				// Bumped when a "current use" switch is refused so the uncontrolled
				// selector remounts back on the real value (no silent draft loss).
				pickVersion: 0,
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
			function RolesEditor(props) {
				const t = props.t
				const snapshot = props.snapshot
				const store = props.store
				const bump = props.bump
				const config = snapshot.roles
				const kind = roleEditorState.kind
				const stage = ROLE_EDITOR_STAGES[kind]
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
				const instances = (Array.isArray(props.instances) ? props.instances : []).filter(function (entry) { return entry.kind === kind })
				const templateRef = React.useRef(null)
				const skillsRef = React.useRef(null)
				// Real React reuses a host node across renders, so an uncontrolled control
				// only takes a new defaultValue when it REMOUNTS. The key carries the editor
				// identity AND whether the identity is still a draft: switching kind,
				// forking and a successful save all remount the controls on the right
				// profile instead of silently keeping the previous profile's text (which
				// would then be saved onto the wrong profile).
				const controlKey = kind + ':' + (draft !== null ? String(draft.name) : String(selectedName)) + ':' + (draft !== null ? 'draft' : 'saved') + ':' + String(roleEditorState.pickVersion || 0)
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
					roleEditorState.pickVersion += 1
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
				/**
				 * ONE switch of "current use": bind the stage to the profile, then replace
				 * the running instances of this kind. With nothing live, only the binding
				 * changes and the panel says it takes effect on the next dispatch.
				 */
				async function applyProfile(name) {
					roleEditorState.applySkipped = false
					const boundResult = await send('rolesBind', { stage: stage, profile: name })
					if (boundResult.ok !== true) {
						roleEditorState.pickVersion += 1
						bump()
						return false
					}
					roleEditorState.selected = name
					// Keep the optimistic copy of a just-created profile so the editor can
					// target it before the next host poll carries it.
					if (roleEditorState.saved !== null && roleEditorState.saved.name !== name) roleEditorState.saved = null
					const live = (Array.isArray(props.instances) ? props.instances : []).filter(function (entry) { return entry.kind === kind })
					if (live.length === 0) {
						roleEditorState.applySkipped = true
						bump()
						return true
					}
					await send('rolesReplace', { name: kind })
					bump()
					return true
				}
				/**
				 * The "current use" picker: one pick is one action. An open draft blocks the
				 * switch with a readable notice (never a silent discard) and the selector
				 * remounts on the real value.
				 */
				async function chooseUse(name) {
					if (typeof name !== 'string' || name === '') return
					roleEditorState.notice = null
					if (draft !== null) {
						report('rolesBind', false, { code: 'role-unsaved' })
						roleEditorState.pickVersion += 1
						bump()
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
					// Saving the profile that is currently in use applies it in the SAME click.
					const isCurrent = selectedName === boundName
					const outcome = await send('rolesUpdate', { name: selectedName, profile: { prompt: template, skills: skills } })
					if (outcome.ok !== true) return
					// Keep the saved values visible until the host snapshot catches up.
					roleEditorState.saved = { name: selectedName, profile: Object.assign({}, target === null ? {} : target, { prompt: template, skills: skills }) }
					bump()
					if (isCurrent) await send('rolesReplace', { name: kind })
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
					roleEditorState.pickVersion += 1
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
					if (group === 'fixed') return t('roleAnchorBoundary')
					return t('roleSectionRole')
				}
				/** The right-hand source note of a section (host-fixed / auto-filled / …). */
				function sectionSourceLabel(group) {
					if (group === 'role') return t('roleSourceHostFixed')
					if (group === 'task') return t('roleSourceAuto')
					if (group === 'skills') return t('roleSourceHostInjected')
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
				// 02 对照式: one toolbar (tabs + current use), a 45/55 pair of panes sharing
				// four section anchors, then a fixed bottom action bar. No instance table,
				// no refresh button, no repeated guidance sentence.
				const toolbar = h('div', { className: 'gbt-rolesheader', 'data-roles-header': 'true' },
					h('div', { className: 'gbt-roleseg', role: 'tablist', 'aria-label': t('roleEditorTabsLabel'), 'data-role-tabs': 'true', 'data-section': 'role-editor-kinds' }, ROLE_EDITOR_KINDS.map(function (entry) {
						return h('button', { key: entry, type: 'button', className: 'gbt-rolesegitem', role: 'tab', 'aria-selected': entry === kind ? 'true' : 'false', 'data-action': 'role-editor-kind', 'data-kind': entry, 'data-roles-tab': entry, 'data-active': entry === kind ? 'true' : 'false', onClick: function () { switchKind(entry) } }, roleKindLabel(entry, t))
					})),
					h('div', { className: 'gbt-rolesheader-right' },
						h('span', { className: 'gbt-pill' }, draft !== null ? t('roleEditorDraft') : builtin ? t('roleBuiltin') : t('roleCustom')),
						h('label', { className: 'gbt-editor-select' }, t('roleCurrentUse'),
							h('select', {
								key: 'current-use:' + controlKey,
								className: 'gbt-input',
								'data-role-use-select': 'true',
								'data-field': 'current-use',
								'data-stage': stage,
								'data-bound': boundName === null ? '' : String(boundName),
								defaultValue: useValue,
								onChange: function (event) {
									void chooseUse(event !== null && event !== undefined && event.target !== undefined ? String(event.target.value) : '')
								},
							},
								useOptions.length === 0
									? h('option', { key: 'none', value: '' }, t('roleEditorNoProfile'))
									: useOptions.map(function (name) { return h('option', { key: name, value: name }, name === kind ? t('roleUseDefault') : name) })))))
				const identityRow = h('div', { className: 'gbt-editor-identity', 'data-editor-identity': 'true', 'data-kind': kind, 'data-profile': selectedName === null ? '' : String(selectedName), 'data-bound': boundName === null ? '' : String(boundName), 'data-draft': draft === null ? 'false' : 'true' })
				const skillsRow = h('div', { className: 'gbt-editorskills', 'data-section': 'role-editor-skills' },
					h('label', { className: 'gbt-editorskills-field' }, t('roleSkills'), h('input', { key: 'skills-field:' + controlKey, ref: skillsRef, className: 'gbt-input', 'data-field': 'skills', defaultValue: skillsText, spellCheck: false })),
					h('button', { type: 'button', className: 'gbt-btn', 'data-action': 'role-editor-skills-manage', onClick: function () { void openSkills() } }, t('roleEditorSkillsManage')))
				/** The blank-create form reports in the same banner as every other action. */
				async function createBlank(name, fields) {
					const outcome = await send('rolesCreate', { name: name, profile: fields })
					if (outcome.ok !== true) return
					roleEditorState.selected = name
					roleEditorState.saved = { name: name, profile: Object.assign({ name: name }, fields) }
					bump()
					await applyProfile(name)
				}
				function createBlankInvalid(code) {
					report('rolesCreate', false, { code: code, message: '' })
				}
				const blankCreate = h(
					'details',
					{ key: 'blank-create', className: 'gbt-createblank', 'data-section': 'role-create-blank' },
					h('summary', null, t('roleEditorCreateBlank')),
					h(RoleCreateForm, { t: t, onCreate: createBlank, onInvalid: createBlankInvalid }),
				)
				const leftPane = h('section', { className: 'gbt-rolespane', 'data-roles-pane': 'raw' },
					h('div', { className: 'gbt-rolecard', 'data-role-card': 'raw' },
						h('div', { className: 'gbt-rolecardhead', 'data-role-card-title': 'true' }, t('rolePreviewRawTitle')),
						editablePrompt ? rawColumn() : builtinDefaultColumn(),
						h('div', { className: 'gbt-rolefields', 'data-section': 'role-editor-fields' }, skillsRow)),
					blankCreate)
				const rightPane = h('section', { className: 'gbt-rolespane', 'data-roles-pane': 'injected' }, h('div', { className: 'gbt-rolecard', 'data-role-card': 'injected' }, injectedColumn()))
				const runningNames = instances.filter(function (entry) { return entry.kind === kind }).map(function (entry) { return entry.name })
				const runningRow = h('div', { className: 'gbt-footnote', 'data-role-running': 'true' },
					t('roleRunningNow') + ': ' + (runningNames.length === 0 ? t('roleNoneRunning') : runningNames.join(', ')) + ' · ' + (boundName === kind ? t('roleFromDefault') : t('roleFromCopy')))
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
									? h('div', { className: 'gbt-banner', 'data-tone': 'error', 'data-skills-unavailable': String(roleEditorState.skillsError.code === undefined || roleEditorState.skillsError.code === null ? 'skills-unavailable' : roleEditorState.skillsError.code) }, t('roleEditorSkillsUnavailable') + (typeof roleEditorState.skillsError.message === 'string' && roleEditorState.skillsError.message !== '' ? ' — ' + roleEditorState.skillsError.message : ''))
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
				const stateHint = draft !== null
					? h('div', { className: 'gbt-footnote', 'data-role-draft-hint': 'true' }, t('roleDraftHint'))
					: roleEditorState.applySkipped === true
						? h('div', { className: 'gbt-footnote', 'data-editor-apply-skipped': 'true' }, t('roleUsePendingNextDispatch'))
						: null
				return h('div', { className: 'gbt-roleeditor', 'data-editor': 'true', 'data-kind': kind, 'data-draft': draft === null ? 'false' : 'true' },
					toolbar,
					identityRow,
					h('div', { className: 'gbt-rolescroll', 'data-roles-scroll': 'true' },
						h('div', { className: 'gbt-rolespanes', 'data-roles-panes': 'true', 'data-role-layout': 'split' }, leftPane, rightPane),
						runningRow),
					roleEditorState.notice === null ? null : roleResultBanner(roleEditorState.notice, t),
					stateHint,
					actionBar,
					modal)
			}

			/**
			 * The Roles tab: ONE card, the context editor. Reloading the profiles is an
			 * explicit action in the card header, and the batch actions (replace kind /
			 * reset defaults) live next to the primary editor actions. The old
			 * stand-alone stages/profiles/previews/create cards are gone — this editor
			 * replaced them.
			 */
			function RolesView(props) {
				const t = props.t
				const snapshot = props.snapshot
				const store = props.store
				const [, bumpEditor] = React.useReducer(function (count) { return count + 1 }, 0)
				const config = snapshot.roles === undefined || snapshot.roles === null ? null : snapshot.roles
				const agents = snapshot.agents
				// T-122: the session's own team is the member source; the host inventory is separate.
				const teamView = snapshot.team !== null && snapshot.team !== undefined && Array.isArray(snapshot.team.members) ? snapshot.team.members : null
				const members = teamView !== null ? teamView : agents !== null && agents !== undefined && Array.isArray(agents.members) ? agents.members : []
				const instances = members
					.filter(function (member) {
						return member !== null && typeof member === 'object' && typeof member.name === 'string' && /^(worker|reviewer|tester)-\d+$/.test(member.name)
					})
					.map(function (member) {
						const match = /^(worker|reviewer|tester)-\d+$/.exec(member.name)
						return { name: member.name, kind: match === null ? 'worker' : match[1], status: typeof member.status === 'string' ? member.status : 'unknown' }
					})
				if (config === null) {
					return h('div', null, h('p', { className: 'gbt-footnote' }, t('rolesHint')), h('div', { className: 'gbt-empty' }, t('rolesUnavailable')))
				}
				return h(
					'div',
					{ className: 'gbt-rolesview' },
					h(
						'section',
						{ className: 'gbt-rolesview-card', 'data-card': 'editor' },
						h('div', { className: 'gbt-rhead' },
							h('h3', { className: 'gbt-rtitle' }, t('roleEditor')),
							h('div', { className: 'gbt-footnote', 'data-role-scale-note': 'true' }, t('roleScaleNote'))),
						h('div', { className: 'gbt-rbody' }, h(RolesEditor, {
							t: t,
							snapshot: snapshot,
							store: store,
							instances: instances,
							bump: bumpEditor,
						})),
					),
				)
			}

			/** Status page UI state that must survive a re-mount (view switch, polling). */
			const statusUiState = { showAll: false, session: null, copied: null }

			/** T-143: worktree cleanup survives a view switch / poll (module store). */
			const worktreeCleanupUi = { signature: null, preflight: null, pending: false, executing: false, result: null, forceConfirm: null, selected: {} }

			/** Status page, direction A: one summary line, three narrow cards, a full-width activity card. */
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
				const queue = Array.isArray(snapshot.queue) ? snapshot.queue : []
				const scheduler = snapshot.scheduler === undefined || snapshot.scheduler === null ? null : snapshot.scheduler
				const running = tasks.filter(function (task) { return task.status === 'running' })
				const maxConcurrent = dispatch.maxConcurrent === undefined || dispatch.maxConcurrent === null ? 3 : dispatch.maxConcurrent
				const ready = counts.ready === undefined || counts.ready === null ? 0 : counts.ready
				const blocked = counts.blocked || 0
				const worktrees = snapshot.worktrees
				const activity = snapshot.activity
				// T-111: the sweep is telemetry, not an event.
				const lastSweep = snapshot.lastSweep !== null && snapshot.lastSweep !== undefined && typeof snapshot.lastSweep.at === 'string' ? snapshot.lastSweep : null
				const agents = snapshot.agents
				const entries = activity !== null && activity !== undefined && Array.isArray(activity.entries) ? activity.entries : []
				// One resolver shared with the detail page: the tool writes @labels, the
				// panel shows member names (unresolved ids stay verbatim).
				const roster = []
				if (agents !== null && agents !== undefined) {
					if (agents.lead !== null && agents.lead !== undefined) roster.push(agents.lead)
					if (Array.isArray(agents.members)) agents.members.forEach(function (member) { roster.push(member) })
				}
				function memberName(value, byName, fallbackKey) {
					return actorDisplay(value, byName, roster, t, fallbackKey)
				}
				function whyNotRunning() {
					if (active !== true) {
						const since = typeof dispatch.since === 'string' ? dispatch.since : null
						const by = typeof dispatch.by === 'string' && dispatch.by !== '' ? memberName(dispatch.by) : null
						const who = by === null ? null : by
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
								html: task.id + ' · ' + task.title + ' → ' + (typeof merge.target === 'string' ? merge.target : '—') + (commit === '' ? '' : ' · ' + commit) + (mergeActor === null ? '' : ' · ' + memberName(mergeActor.by, mergeActor.byName, 'actorRoleMerger')),
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
				/** Minutes since this member's newest activity entry (entries are newest-first). */
				function idleMinutesFor(name) {
					const hit = entries.filter(function (entry) { return (entry.actor === name || entry.actorName === name) && typeof entry.at === 'string' })[0]
					if (hit === undefined) return null
					const age = now - new Date(hit.at).getTime()
					return Number.isFinite(age) ? Math.max(0, Math.round(age / 60000)) : null
				}
				function lastResultFor(name) {
					const hit = entries.filter(function (entry) { return (entry.actor === name || entry.actorName === name) && typeof entry.taskId === 'string' })[0]
					if (hit === undefined) return '—'
					if (hit.kind === 'test-end' && String(hit.detail).indexOf('passed') >= 0) return hit.taskId + ' ' + t('statusResultPassed')
					if (hit.kind === 'merge') return hit.taskId + ' ' + t('statusResultCompleted')
					if (hit.kind === 'submit') return hit.taskId + ' ' + t('statusResultSubmitted')
					return hit.taskId
				}
				function agentRow(member, isLead, index) {
					const name = typeof member.name === 'string' ? member.name : typeof member.id === 'string' ? member.id : String(index)
					const session = typeof member.session === 'string' && member.session !== '' ? member.session : typeof member.id === 'string' ? member.id : ''
					const current = member.currentTask === null || member.currentTask === undefined ? null : member.currentTask
					const idleMinutes = idleMinutesFor(name)
					const roleKind = isLead === true ? 'lead' : typeof member.kind === 'string' ? member.kind : 'teammate'
					const queueLength = roleKind === 'reviewer' ? reviewerQueue : roleKind === 'tester' ? testerQueue : 0
					const statusText = (isLead
						? '—'
						: current !== null
							? current.id
							: idleMinutes === null
								? t('statusIdle')
								: t('statusIdle') + ' ' + String(idleMinutes) + ' ' + t('statusMinutes')) + (queueLength > 0 ? ' · ' + t('queueLengthChip').replace('{n}', String(queueLength)) : '')
					const resultText = isLead ? typeof member.description === 'string' && member.description !== '' ? member.description : '—' : lastResultFor(name)
					const expanded = openSession === name
					return h(
						'div',
						{ key: 'agent-' + name, className: 'gbt-statusrow', 'data-status-agent': name },
						h('span', { className: 'gbt-statuswho gbt-mono' }, name),
						h('span', { className: 'gbt-statusrole' }, roleKindLabel(isLead === true ? 'lead' : typeof member.kind === 'string' ? member.kind : 'teammate', t)),
						h('span', { className: 'gbt-statustask' }, statusText),
						h('span', { className: 'gbt-statustime' }, resultText),
						h(
							'button',
							{ type: 'button', className: 'gbt-statusmore', 'data-action': 'status-session', 'data-agent': name, 'aria-expanded': expanded ? 'true' : 'false', onClick: function () { const next = expanded ? null : name; statusUiState.session = next; setOpenSession(next) } },
							'⋯',
						),
						expanded
							? h(
									'div',
									{ className: 'gbt-sessionrow', 'data-status-session': name },
									h('span', { className: 'gbt-footnote' }, t('statusSession')),
									h('code', { className: 'gbt-mono' }, session === '' ? '—' : session),
									session === ''
										? null
										: h(
												'button',
												{ type: 'button', className: 'gbt-btn', 'data-action': 'copy-session', 'data-session': session, onClick: function () { void copyToClipboard(session).then(function (okopy) { const next = okopy === true ? session : 'failed'; statusUiState.copied = next; setCopied(next) }) } },
												copied === session ? t('sessionCopied') : t('copySession'),
											),
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
				const dispatchCard = h(
					'section',
					{ className: 'gbt-statuscard', 'data-status-card': 'dispatch' },
					h('div', { className: 'gbt-statuscardhead' }, h('span', { className: 'gbt-dot', 'data-running': active ? 'true' : 'false' }), t('statusCardDispatch'), h('span', { className: 'gbt-statusmeta' }, active ? t('running') : t('paused'))),
					h(
						'div',
						{ className: 'gbt-statuscardbody' },
						h('div', { className: 'gbt-statuskvs' }, h('span', { className: 'gbt-statuskv', 'data-kv': 'concurrent' }, h('b', null, String(running.length)), h('span', null, '/ ' + String(maxConcurrent) + ' ' + t('statusConcurrent'))), h('span', { className: 'gbt-statuskv', 'data-kv': 'ready' }, h('b', null, String(ready)), h('span', null, t('statusReady'))), Number.isFinite(counts.investigating) && counts.investigating > 0 ? h('span', { className: 'gbt-statuskv', 'data-kv': 'investigating', 'data-kind': 'investigate' }, h('b', null, String(counts.investigating)), h('span', null, t('statusInvestigating'))) : null, h('span', { className: 'gbt-statuskv', 'data-kv': 'merge-queue' }, h('b', null, String(queue.length)), h('span', null, t('statusMergeQueue')))),
						h('div', { className: 'gbt-statuswhy', 'data-status-why': 'true' }, whyNotRunning()),
						h('div', { className: 'gbt-statusscan', 'data-status-scan': 'true' }, t('statusLastScan') + ' ' + (scheduler !== null && scheduler.lastTickAt !== null && scheduler.lastTickAt !== undefined ? tcAgo(scheduler.lastTickAt, now) : '—')),
						panelSessionLine,
						snapshot.nextStep === null || snapshot.nextStep === undefined
							? null
							: h(
									'div',
									{ className: 'gbt-statuswhy', 'data-status-team': 'missing', 'data-status-next-step': String(snapshot.nextStep.code) },
									t('projectTeamNext') + ' ' + String(snapshot.nextStep.instruction),
								),
						archivedCount > 0
							? h('div', { className: 'gbt-statusscan', 'data-status-archive': 'true' }, t('archiveLine').replace('{n}', String(archivedCount)).replace('{range}', archiveRange === null ? '—' : String(archiveRange.from).slice(0, 10) + ' → ' + String(archiveRange.to).slice(0, 10)), ' ', h('button', { type: 'button', className: 'gbt-linkbtn', 'data-action': 'archive-open', onClick: function () { if (props.onOpenArchive !== undefined) props.onOpenArchive() } }, t('archiveOpen')))
							: null,
						boardSizeWarn
							? h(
									'div',
									{ className: 'gbt-statusscan', 'data-status-board-size': boardSize.level, 'data-board-bytes': String(boardSize.bytes), title: boardSize.warning === null ? '' : String(boardSize.warning) },
									t('statusBoardSize')
										.replace('{mb}', String(Math.round((boardSize.bytes / (1024 * 1024)) * 10) / 10))
										.replace('{limit}', String(Math.round(boardSize.limit / (1024 * 1024))))
										.replace('{percent}', String(boardSize.percent))
										.replace('{n}', boardSize.headroomCards === null ? '—' : String(boardSize.headroomCards)),
								)
							: null,
					),
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
					return String(entry.path) + ':' + (entry.active === true ? 'a' : '-') + ':' + String(entry.reason === undefined || entry.reason === null ? '' : entry.reason) + ':' + String(entry.dirty) + ':' + String(entry.merged)
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
				React.useEffect(function () {
					if (worktreeSignature === '') return
					if (worktreeCleanupUi.pending === true) return
					if (worktreeCleanupUi.signature === worktreeSignature) return
					worktreeCleanupUi.signature = worktreeSignature
					worktreeCleanupUi.pending = true
					wtBump()
					void store.send('worktreesCleanup', { dryRun: true }, { quiet: true }).then(wtApplyPreflight)
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
							cleanupUi.signature = null
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
				const eligibleSafe = staleWts.filter(function (entry) { const candidate = candidateByPath[entry.path]; return candidate !== undefined ? candidate.why === 'safe' : entry.safe === true })
				const safeCount = cleanupUi.preflight !== null ? eligibleSafe.length : staleWts.filter(function (entry) { return entry.safe === true }).length
				const confirmCount = Math.max(0, staleWts.length - safeCount)
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
					return h('div', { key: key, className: 'gbt-wtrow', 'data-worktree-row': rowMarker, 'data-wt-task': String(entry.taskId === undefined || entry.taskId === null ? '' : entry.taskId) },
						h('span', { className: 'gbt-wtlabel' }, h('b', null, wtLabelOf(entry)), h('span', { className: 'gbt-pill', 'data-wt-type': String(entry.type) }, wtTypeLabel(entry.type))),
						h('span', { className: 'gbt-wtpath gbt-mono', title: String(entry.path) }, wtBaseOf(entry.path)),
						h('span', { className: 'gbt-wtbranch gbt-mono', title: typeof entry.branch === 'string' ? entry.branch : '' }, typeof entry.branch === 'string' && entry.branch !== '' ? entry.branch : '—'),
						h('span', { className: 'gbt-wtsha gbt-mono' }, typeof entry.head === 'string' && entry.head !== '' ? entry.head.slice(0, 7) : '—'),
						stateText === undefined ? wtBadges(entry) : h('span', { className: 'gbt-chip', 'data-wt-active': 'true', 'data-tone': 'running' }, stateText))
				}
				const mainRow = mainWt === undefined ? null : wtRowBase('wt-main', mainWt, 'main', t('statusWtActiveState'))
				const activeRows = activeWts.map(function (entry) { return wtRowBase('wt-active-' + String(entry.path), entry, 'active', t('statusWtActiveState')) })
				const staleRows = staleWts.map(function (entry) {
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
						actions = h('span', { className: 'gbt-wtactions' }, h('span', { className: 'gbt-statusnote' }, candidate === undefined ? t('statusWtPreflightFirst') : wtReasonLabel(String(entry.reason === undefined || entry.reason === null ? '' : entry.reason))))
					}
					const dirty = entry.dirty === true
					const merged = entry.merged === true
					return h('div', { key: 'wt-stale-' + actionId, className: 'gbt-wtrow', 'data-worktree-stale': wtLabelOf(entry), 'data-path': entry.path, 'data-reason': String(entry.reason === undefined || entry.reason === null ? '' : entry.reason) },
						h('span', { className: 'gbt-wtlabel' }, h('b', null, wtLabelOf(entry)), h('span', { className: 'gbt-pill', 'data-wt-type': String(entry.type) }, wtTypeLabel(entry.type))),
						h('span', { className: 'gbt-wtpath gbt-mono', title: String(entry.path) }, wtBaseOf(entry.path)),
						h('span', { className: 'gbt-wtbranch gbt-mono', title: typeof entry.branch === 'string' ? entry.branch : '' }, typeof entry.branch === 'string' && entry.branch !== '' ? entry.branch : '—'),
						h('span', { className: 'gbt-wtsha gbt-mono' }, typeof entry.head === 'string' && entry.head !== '' ? entry.head.slice(0, 7) : '—'),
						wtBadges(entry),
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
				const worktreesCard = h('section', { className: 'gbt-statuscard', 'data-status-card': 'worktrees' },
					h('div', { className: 'gbt-statuscardhead' }, h('span', { className: 'gbt-dot' }), t('statusCardWorktrees'), h('span', { className: 'gbt-statusmeta', 'data-wt-summary': 'true' }, String(totalCount) + ' ' + t('statusWtTotal') + ' · ' + String(activeCount) + ' ' + t('statusWtActive') + ' · ' + String(safeCount) + ' ' + t('statusWtSafe') + ' · ' + String(confirmCount) + ' ' + t('statusWtConfirm'))),
					h('div', { className: 'gbt-statuscardbody' },
						worktrees === null || worktrees === undefined || worktrees.available !== true
							? h('div', { className: 'gbt-statusnote' }, worktrees !== null && worktrees !== undefined && worktrees.error === 'no-git-service' ? t('statusNoGit') : snapshot.source === 'loading' ? t('statusWtLoading') : t('statusWorktreesUnavailable'))
							: h('div', { className: 'gbt-wtview' },
								h('div', { className: 'gbt-wtbatch' },
									h('button', { type: 'button', className: 'gbt-btn', 'data-action': 'worktree-preflight', disabled: cleanupUi.pending === true, onClick: wtRunPreflight }, cleanupUi.pending === true ? t('statusWtPreflighting') : t('statusWtPreflight')),
									h('button', { type: 'button', className: 'gbt-btn', 'data-variant': 'primary', 'data-action': 'worktree-cleanup-safe', disabled: cleanupBusy || selectedSafePaths.length === 0, onClick: function () { wtExecute(selectedSafePaths, false) } }, t('statusWtCleanupSafe').replace('{n}', String(selectedSafePaths.length)))),
								mainRow,
								activeRows,
								h('div', { className: 'gbt-wtsectionhead' }, t('statusStaleWorktrees') + ' · ' + String(staleWts.length)),
								staleWts.length === 0 ? h('div', { className: 'gbt-statusnote' }, t('statusWtNoStale')) : h('div', { className: 'gbt-wtlines', 'data-wt-lines': 'true' }, staleRows),
								preflightBlock,
								resultBlock)))
				const reviewerQueue = tasks.filter(function (task) { return task.status === 'reviewing' && tcStageQueued(task) }).length
				const testerQueue = tasks.filter(function (task) { return task.status === 'testing' && tcStageQueued(task) }).length
				const lead = agents !== null && agents !== undefined ? agents.lead : null
				// T-122: member table = the requesting session's team (team.members).
				const teamMembersView = snapshot.team !== null && snapshot.team !== undefined && Array.isArray(snapshot.team.members) ? snapshot.team.members : null
				const members = teamMembersView !== null ? teamMembersView : agents !== null && agents !== undefined && Array.isArray(agents.members) ? agents.members : []
				// T-118: role instances whose slot project is NOT this session's project
				// can only be leftovers from an older build; mark them instead of hiding.
				const teams = snapshot.teams
				const teamMembers = teams !== null && teams !== undefined && Array.isArray(teams.members) ? teams.members : []
				const leftoverRoles = teamMembers.filter(function (member) { return member !== null && typeof member === 'object' && member.matchesSession === false })
				function projectLabelOf(member) {
					const root = typeof member.projectRoot === 'string' && member.projectRoot !== '' ? member.projectRoot : null
					if (root !== null) return String(root).split(/[\\/]/).filter(Boolean).slice(-1)[0] || root
					return typeof member.project === 'string' ? 'p' + member.project.slice(0, 6) : '—'
				}
				const leftoverRows = leftoverRoles.map(function (member, index) {
					const leftoverName = typeof member.name === 'string' ? member.name : String(index)
					return h(
						'div',
						{ key: 'leftover-' + leftoverName, className: 'gbt-statusrow', 'data-leftover-role': leftoverName, 'data-tone': 'blocked' },
						h('span', { className: 'gbt-statuswho gbt-mono' }, leftoverName),
						h('span', { className: 'gbt-statusrole' }, t('leftoverRole')),
						h('span', { className: 'gbt-statustask' }, t('leftoverRoleFrom').replace('{project}', projectLabelOf(member))),
						h('span', { className: 'gbt-statustime' }, ''),
					)
				})
				const agentRows = []
				if (lead !== null && lead !== undefined) agentRows.push(agentRow(lead, true, -1))
				members.forEach(function (member, index) { agentRows.push(agentRow(member, false, index)) })
				const agentsCard = h(
					'section',
					{ className: 'gbt-statuscard', 'data-status-card': 'agents' },
					h('div', { className: 'gbt-statuscardhead' }, h('span', { className: 'gbt-dot', 'data-running': members.some(function (member) { return member.status === 'running' }) ? 'true' : 'false' }), t('statusCardAgents'), h('span', { className: 'gbt-statusmeta' }, String(agentRows.length) + ' ' + t('statusAgentUnit'))),
					h(
						'div',
						{ className: 'gbt-statuscardbody' },
						agents === null || agents === undefined
							? h('div', { className: 'gbt-statusnote' }, t('statusAgentsUnavailable'))
							: agentRows.length === 0 && leftoverRows.length === 0
								? h('div', { className: 'gbt-statusnote' }, t('workersEmpty'))
								: h('div', null, agentRows, leftoverRows),
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
					{ className: 'gbt-statuscard', 'data-status-card': 'activity' },
					h('div', { className: 'gbt-statuscardhead' }, h('span', { className: 'gbt-dot' }), t('statusCardActivity'), h('span', { className: 'gbt-statusmeta' }, t('statusLatestActivity') + ' ' + String(recentStream.length) + ' ' + t('statusEventUnit'))),
					h(
						'div',
						{ className: 'gbt-statuscardbody' },
						!activityAvailable
							? h('div', { className: 'gbt-statusnote' }, t('statusActivityUnavailable'))
							: recentStream.length === 0 && sweepRows.length === 0 && lastSweep === null
								? h('div', { className: 'gbt-statusnote' }, t('statusActivityEmpty'))
								: h('div', null,
									recentStream.map(function (event) {
										return h(
											'div',
											{ key: event.key, className: 'gbt-statusev', 'data-activity': event.type, 'data-activity-kind': event.type, 'data-activity-task': event.taskId, title: event.raw === null ? undefined : event.raw },
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
				return h(
					'div',
					{ className: 'gbt-statusview', 'data-status': 'cards' },
					h(
						'div',
						{ className: 'gbt-statustop', 'data-status-top': 'true' },
						h('div', { className: 'gbt-statussummary' }, lastActivityText === null ? '' : lastActivityText),
						h(
							'div',
							{ className: 'gbt-statusactions' },
							h('button', { type: 'button', className: 'gbt-btn', 'data-action': 'status-refresh', onClick: function () { void store.load() } }, '↻ ' + t('refresh')),
						),
					),
					h('div', { className: 'gbt-statusgrid', 'data-status-grid': 'true' }, dispatchCard, worktreesCard, agentsCard, activityCard),
				)
			}

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

			function DetailView(props) {
				const task = props.task
				const t = props.t
				const now = props.now
				const snapshot = props.snapshot
				const [deleteError, setDeleteError] = React.useState(null)
				const [evidenceOpen, setEvidenceOpen] = React.useState(detailUiState.evidence === true)
				const [specOpen, setSpecOpen] = React.useState(detailUiState.spec === true)
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

				// ── member names: session-id prefixes from @ids resolve to the roster ──
				const roster = []
				if (snapshot.agents !== null && snapshot.agents !== undefined) {
					if (snapshot.agents.lead !== null && snapshot.agents.lead !== undefined) roster.push(snapshot.agents.lead)
				}
				// T-122: names resolve against the session's team, not the host inventory.
				if (snapshot.team !== null && snapshot.team !== undefined && Array.isArray(snapshot.team.members)) {
					snapshot.team.members.forEach(function (member) { roster.push(member) })
				} else if (snapshot.agents !== null && snapshot.agents !== undefined && Array.isArray(snapshot.agents.members)) {
					snapshot.agents.members.forEach(function (member) { roster.push(member) })
				}
				function actorName(value, byName, fallbackKey) {
					return actorDisplay(value, byName, roster, t, fallbackKey)
				}

				const actions = []
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
							h('span', { className: 'gbt-detailwho' }, (function () { const actor = mergeActorOf(task); return actor === null ? '' : ' · ' + actorName(actor.by, actor.byName, 'actorRoleMerger') })()),
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
					specToggle,
					specBody,
				)
				// In the single-column layout the elapsed/rounds move into the one-line
				// card, so the details card keeps only files/host-check/attempts/spec.
				const summaryDetails = h(
					'div',
					{ className: 'gbt-detailsummary', 'data-detail': 'summary', 'data-detail-summary': 'details' },
					summaryFacts,
					specToggle,
					specBody,
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

				const blocks = []
				blocks.push(
					h(
						'div',
						{ key: 'actions', className: 'gbt-actions' },
						actions,
						deleteError === 'referenced' ? h('button', { key: 'force', type: 'button', className: 'gbt-btn', 'data-variant': 'danger', onClick: function () { remove(true) } }, t('forceDelete')) : null,
					),
				)
				if (deleteError === 'referenced') blocks.push(h('p', { key: 'forcehint', className: 'gbt-footnote' }, t('forceHint')))
				if (deleteError === 'failed') blocks.push(h('p', { key: 'deletefail', className: 'gbt-footnote' }, t('error')))
				blocks.push(stages)
				if (investigate) {
					// T-144: investigations render as a casebook: index aside + full report paper.
					blocks.push(casebook)
				} else {
					const eventsCard = h('section', { className: 'gbt-detailcard', 'data-detail-card': 'events' }, h('div', { className: 'gbt-detailcardhead' }, t('detailWhereNow')), eventsBody)
					blocks.push(h('div', { className: 'gbt-detailbody', 'data-detail-body': layout, 'data-detail-layout': layout }, layout === 'single' ? compactSummary : null, eventsCard, layout === 'single' ? summaryDetails : summary))
				}

				// An investigation never submits code: its completion action is report, so
				// the submit box must not invite a refused action.
				if (task.status === 'running' && investigate !== true) {
					blocks.push(
						h(
							'section',
							{ key: 'work', className: 'gbt-section' },
							h('h3', null, t('evidence')),
							h('textarea', { className: 'gbt-area', ref: evidence, placeholder: t('evidence') }),
							h('div', { className: 'gbt-actions', style: { marginTop: '6px' } }, h('button', { type: 'button', className: 'gbt-btn', 'data-variant': 'primary', onClick: submitWork }, t('submit'))),
						),
					)
				}

				blocks.push(
					h(
						'details',
						{ key: 'fields', className: 'gbt-section' },
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
									h('dl', { className: 'gbt-meta' }, h('dt', null, t('status')), h('dd', null, String(dispatch.status === null || dispatch.status === undefined ? '—' : dispatch.status)), h('dt', null, t('assignee')), h('dd', null, String(dispatch.target === null || dispatch.target === undefined ? '—' : dispatch.target)), dispatch.error === null || dispatch.error === undefined ? null : h('dt', null, t('dispatchError')), dispatch.error === null || dispatch.error === undefined ? null : h('dd', null, String(dispatch.error))),
									// T-107: an owner session that differs from the dispatching Lead's session is a red flag, not noise.
									task.ownerSession !== null && task.ownerSession !== undefined && dispatch.leadSession !== null && dispatch.leadSession !== undefined && task.ownerSession !== dispatch.leadSession
										? h('p', { className: 'gbt-footnote', 'data-owner-mismatch': 'true' }, t('ownerMismatch').replace('{owner}', String(task.ownerSession)).replace('{lead}', String(dispatch.leadSession)))
										: null,
								),
						h('div', { className: 'gbt-subhead' }, t('history')),
						history.length === 0 ? h('p', { className: 'gbt-footnote' }, t('emptyHistory')) : h('div', { className: 'gbt-timeline' }, history.slice().reverse().map(function (entry, index) {
							return h('div', { key: String(index), className: 'gbt-event' }, h('span', { className: 'gbt-mono' }, tcAgo(entry.at, now)), ' ', h('b', null, actorName(entry.by)), ' ', h('span', null, (entry.from === null ? '·' : entry.from) + ' → ' + (entry.to === null ? '·' : entry.to)), entry.note === '' ? null : h('div', null, entry.note))
						})),
					),
				)
				blocks.push(h('input', { key: 'note', className: 'gbt-input', ref: note, placeholder: t('notePlaceholder') }))
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
					),
				)
			}

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

			function SettingsForm(props) {
				const t = props.t
				const dispatch = props.dispatch
				const concurrent = React.useRef(null)
				const defaultTarget = React.useRef(null)
				const [error, setError] = React.useState('')
				function save() {
					const raw = concurrent.current === null ? dispatch.maxConcurrent : concurrent.current.value
					const value = Number(raw)
					if (!Number.isFinite(value) || value < 1 || value > 8 || Math.floor(value) !== value) {
						setError(t('invalidConcurrency'))
						return
					}
					const targetValue = defaultTarget.current === null ? '' : String(defaultTarget.current.value || '').trim()
					void store.send('settings', { maxConcurrent: value, defaultTarget: targetValue }).then(function (result) {
						if (result.ok === true) props.onClose()
						else setError(t('error'))
					})
				}
				return h(
					Modal,
					{ title: t('settingsTitle'), onClose: props.onClose, t: t },
					h(
						'div',
						{ className: 'gbt-form' },
						h(
							'div',
							{ className: 'gbt-field' },
							h('label', null, t('maxConcurrent')),
							h('input', { className: 'gbt-input', type: 'number', min: 1, max: 8, step: 1, ref: concurrent, defaultValue: String(dispatch.maxConcurrent) }),
						),
						h(
							'div',
							{ className: 'gbt-field' },
							h('label', null, t('defaultTargetLabel')),
							h('input', { className: 'gbt-input', 'data-field': 'default-target', ref: defaultTarget, defaultValue: typeof dispatch.defaultTarget === 'string' ? dispatch.defaultTarget : '', placeholder: t('defaultTargetHint') }),
						),
						h('p', { className: 'gbt-footnote' }, t('concurrencyHint')),
						error === '' ? null : h('p', { className: 'gbt-footnote', style: { color: 'var(--dsw-alias-state-error-primary)' } }, error),
						h(
							'div',
							{ className: 'gbt-actions' },
							h('button', { type: 'button', className: 'gbt-btn', 'data-variant': 'primary', onClick: save }, t('apply')),
							h('button', { type: 'button', className: 'gbt-btn', onClick: props.onClose }, t('cancel')),
						),
					),
				)
			}

			function ProjectForm(props) {
				const t = props.t
				const input = React.useRef(null)
				const [error, setError] = React.useState('')
				// The project the Host resolves right now (the session project when this
				// browser has not pinned one). It is what "use current project" fills in,
				// so returning to this project never needs a hand-typed path (T-90).
				const hostProject = typeof props.hostProject === 'string' && props.hostProject !== '' ? props.hostProject : null
				const draft = projectFormState.value !== null ? projectFormState.value : typeof props.project === 'string' ? props.project : hostProject === null ? '' : hostProject
				function useCurrent() {
					if (hostProject === null) return
					projectFormState.value = hostProject
					setError('')
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
					void store.switchProject(value).then(function (result) {
						if (result.ok === true) {
							projectFormState.value = null
							props.onClose()
							return
						}
						const payload = result.payload === undefined || result.payload === null ? {} : result.payload
						setError(tcErrorMessage(payload, t))
					})
				}
				return h(
					Modal,
					{ title: t('project'), onClose: props.onClose, t: t },
					h(
						'div',
						{ className: 'gbt-form' },
						h('div', { className: 'gbt-field' }, h('label', null, t('project')), h('input', { className: 'gbt-input', ref: input, placeholder: t('projectPlaceholder'), defaultValue: draft, 'data-project-input': 'true' })),
						hostProject === null ? null : h('p', { className: 'gbt-footnote', 'data-host-project': hostProject }, t('useCurrentProjectHint') + ' · ' + hostProject),
						error === '' ? null : h('p', { className: 'gbt-footnote' }, error),
						h('div', { className: 'gbt-actions' },
							h('button', { type: 'button', className: 'gbt-btn', 'data-action': 'use-current-project', title: t('useCurrentProjectHint'), disabled: hostProject === null, onClick: useCurrent }, '⌖ ' + t('useCurrentProject')),
							h('button', { type: 'button', className: 'gbt-btn', 'data-variant': 'primary', onClick: open }, t('openProject')),
							h('button', { type: 'button', className: 'gbt-btn', onClick: props.onClose }, t('cancel'))),
					),
				)
			}

			/**
			 * Where the Host got the project on screen (T-90): 'session' means it came
			 * from the session workspace walk-up, 'manual' from a path this browser or
			 * a caller pinned, 'registry' from the project registry.
			 */
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
			// The drawer's list state lives here (not only in React state) so the
			// fetches that resolve between renders are visible to the next one; a
			// state counter still drives the real React re-render.
			const doneAllState = { items: [], next: null, loading: true, error: false, failedMore: false, query: '', loadedQuery: null, token: 0, busy: false }
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
				// Rendering tests may open the settings modal; the production slot passes no props.
				const initialSettingsOpen = props !== undefined && props !== null && props.initialSettingsOpen === true
				const [settingsOpen, setSettingsOpen] = React.useState(initialSettingsOpen)
				// Rendering tests may open the project dialog; the production slot passes no props.
				const initialProjectOpen = props !== undefined && props !== null && props.initialProjectOpen === true
				const [projectOpen, setProjectOpen] = React.useState(initialProjectOpen)
				function openProjectDialog() {
					projectFormState.value = null
					setProjectOpen(true)
				}
				/** Switch to the session project: pin + openProject on the Host (T-90). */
				function switchToProject(path) {
					void store.switchProject(path)
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
				const selected = selectedId === null ? null : tasks.filter(function (task) { return task.id === selectedId })[0] || null
				const editingTask = editing === null || editing === 'new' ? null : (function () {
					const base = tasks.filter(function (task) { return task.id === editing })[0]
					if (base === undefined) return null
					return Object.assign({}, base, snapshot.details[editing] === undefined ? {} : snapshot.details[editing].task)
				})()
				const queue = snapshot.queue === undefined || snapshot.queue === null ? [] : snapshot.queue
				const scheduler = snapshot.scheduler
				const workersPool = snapshot.workers
				const workerMembers = workersPool !== null && workersPool !== undefined && Array.isArray(workersPool.members) ? workersPool.members : null
				const busy = snapshot.busy === undefined || snapshot.busy === null ? null : snapshot.busy

				function isBusy(action, id) {
					return busy !== null && busy.action === action && (id === undefined || busy.id === id)
				}

				function openTask(id) {
					setSelectedId(id)
					void store.loadDetail(id)
				}
				function closeDetail() {
					setSelectedId(null)
				}
				function startEdit(task) {
					const id = task === null || task === undefined ? 'new' : task.id
					setEditing(id)
					if (id !== 'new') void store.loadDetail(id)
				}
				function toggleDispatch() {
					void store.send(active ? 'pause' : 'start')
				}

				// T-110: the project's Team (and the session's next step while it is
				// missing) is read by the header line and the status card.
				const projectTeam = snapshot.team === null || snapshot.team === undefined ? null : snapshot.team

				const tabs = [
					{ key: 'board', label: t('boardTab') },
					{ key: 'queue', label: t('queue') },
					{ key: 'workers', label: t('workersTab') },
					{ key: 'status', label: t('statusTab') },
					{ key: 'roles', label: t('rolesTab') },
				]

				const header = h(
					'header',
					{ className: 'gbt-header' },
					h(
						'div',
						{ className: 'gbt-brand' },
						h('div', { className: 'gbt-mark' }, '▦'),
						h(
							'div',
							null,
							h(
								'div',
								{ className: 'gbt-titleline' },
								h('h1', { className: 'gbt-title' }, t('title')),
								projectSourceLabel(projectSourceKey(snapshot), t) === null
									? null
									: h(
											'span',
											{ className: 'gbt-projectsource', 'data-project-source': projectSourceKey(snapshot), title: snapshot.projectWarning === null ? t('projectSourceHint') : snapshot.projectWarning },
											projectSourceLabel(projectSourceKey(snapshot), t),
										),
							),
							h('p', { className: 'gbt-project', title: snapshot.project || '' }, snapshot.project === null ? t('projectUnknown') : snapshot.project),
							// T-110: whose Team the board dispatches to, and what to do
							// while it does not exist (the session creates it, never the panel).
							projectTeam === null
								? null
								: h(
										'p',
										{
											className: 'gbt-projectteam',
											'data-project-team': projectTeam.ok === true ? 'ok' : projectTeam.available === false ? 'unavailable' : 'missing',
											'data-team-lead': projectTeam.lead === null || projectTeam.lead === undefined ? '' : String(projectTeam.lead),
											title: (function () {
												const parts = []
												if (projectTeam.lead !== null && projectTeam.lead !== undefined && /^session-/.test(String(projectTeam.lead))) parts.push(String(projectTeam.lead))
												if (snapshot.nextStep !== null && snapshot.nextStep !== undefined) parts.push(String(snapshot.nextStep.instruction))
												return parts.join(' · ')
											})(),
										},
										t('projectTeam') + '：' +
											(projectTeam.ok === true
												? t('projectTeamOk').replace('{lead}', tcLeadText(projectTeam.lead, t)).replace('{n}', String(Array.isArray(projectTeam.members) ? projectTeam.members.length : 0)) +
													(Array.isArray(projectTeam.missingRoles) && projectTeam.missingRoles.length > 0
														? ' · ' + t('projectTeamMissingRoles').replace('{roles}', projectTeam.missingRoles.join(', '))
														: '')
												: projectTeam.available === false
													? t('projectTeamUnavailable')
													: projectTeam.error === 'no-members'
														? t('projectTeamNoMembers').replace('{roles}', Array.isArray(projectTeam.missingRoles) ? projectTeam.missingRoles.join(', ') : '')
														: t('projectTeamMissing')),
									),
						),
					),
					h(
						'div',
						{ className: 'gbt-counts' },
						h('span', { className: 'gbt-count' }, t('ready'), h('b', null, String(counts.ready || 0))),
						h('span', { className: 'gbt-count' }, t('waiting'), h('b', null, String(Math.max(0, (counts.pending || 0) - (counts.ready || 0))))),
						h('span', { className: 'gbt-count' }, t('runningCol'), h('b', null, String(counts.running || 0))),
						h('span', { className: 'gbt-count' }, t('reviewingCol'), h('b', null, String(counts.reviewing || 0))),
						h('span', { className: 'gbt-count' }, t('testingCol'), h('b', null, String(counts.testing || 0))),
						h('span', { className: 'gbt-count' }, t('doneCol'), h('b', null, String(counts.done || 0))),
						h('span', { className: 'gbt-count' }, t('blockedCol'), h('b', null, String((counts.blocked || 0) + (counts.cancelled || 0)))),
					),
					h(
						'div',
						{ className: 'gbt-controls' },
						h('button', {
							type: 'button',
							className: 'gbt-btn',
							'data-variant': active ? undefined : 'primary',
							'data-busy': isBusy('start') || isBusy('pause') ? 'true' : 'false',
							onClick: toggleDispatch,
							disabled: snapshot.source === 'error' || snapshot.project === null || busy !== null,
						}, isBusy('start') || isBusy('pause') ? h('span', null, h('span', { className: 'gbt-spinner' }), active ? t('pausing') : t('starting')) : active ? '⏸ ' + t('pause') : '▶ ' + t('start')),
						h('button', { type: 'button', className: 'gbt-btn', onClick: function () { startEdit(null) }, disabled: snapshot.project === null }, '+ ' + t('newTask')),
						h('button', { type: 'button', className: 'gbt-btn', onClick: function () { void store.load() } }, '↻ ' + t('refresh')),
						snapshot.project === null || snapshot.project === undefined
							? null
							: h('button', { type: 'button', className: 'gbt-btn', onClick: function () { openProjectDialog() } }, '⌂ ' + t('project')),
						h('button', { type: 'button', className: 'gbt-btn', onClick: function () { setSettingsOpen(true) } }, '⚙ ' + t('settings')),
					),
				)

				const statusline = h(
					'div',
					{ className: 'gbt-statusline' },
					h('span', { className: 'gbt-dot', 'data-running': active ? 'true' : 'false' }),
					h('span', null, active ? t('running') : t('paused')),
					h('span', null, '· ' + String(counts.total || tasks.length) + ' ' + t('taskCount')),
					h('span', null, '· ' + t('maxConcurrent') + ' ' + String(dispatch.maxConcurrent === undefined ? 3 : dispatch.maxConcurrent)),
					h('span', null, '· ' + t('queue') + ' ' + String(queue.length)),
					scheduler !== null && scheduler !== undefined && scheduler.lastTickAt !== null
						? h('span', null, '· tick ' + tcAgo(scheduler.lastTickAt, now))
						: null,
					scheduler !== null && scheduler !== undefined && scheduler.lastError !== null
						? h('span', { style: { color: 'var(--dsw-alias-state-error-primary)' } }, '· ' + String(scheduler.lastError))
						: null,
					h('span', { style: { marginLeft: 'auto' } }, t('subtitle')),
				)

				// The actionable split: the panel is pinned to A while the session resolves
				// B. One click pins B AND opens it on the Host, so the GUI and the
				// scheduler agree again (T-90).
				const mismatchProject = projectMismatchOf(snapshot)
				const projectMismatchBar =
					mismatchProject === null
						? null
						: h(
								'div',
								{
									className: 'gbt-banner',
									'data-tone': 'warn',
									'data-project-mismatch': 'true',
									role: 'button',
									tabIndex: 0,
									onClick: function () { switchToProject(mismatchProject) },
									onKeyDown: function (event) {
										if (event.key === 'Enter' || event.key === ' ') {
											event.preventDefault()
											switchToProject(mismatchProject)
										}
									},
								},
								h(
									'span',
									{ style: { flex: '1', minWidth: '220px' } },
									t('projectMismatch').split('{panel}').join(String(snapshot.project)).split('{session}').join(mismatchProject),
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
											'data-action': 'switch-to-session-project',
											disabled: busy !== null,
											onClick: function (event) {
												if (event !== undefined && event !== null && typeof event.stopPropagation === 'function') event.stopPropagation()
												switchToProject(mismatchProject)
											},
										},
										t('projectSwitch'),
									),
								),
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

				const banner =
					snapshot.source === 'error'
						? h('div', { className: 'gbt-banner' }, h('span', null, snapshot.message === '' ? t('offline') : snapshot.message))
						: snapshot.message === ''
							? null
							: h('div', { className: 'gbt-banner', 'data-tone': 'info' }, snapshot.message)

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
						t: t,
						now: now,
						selectedId: selectedId,
						onOpen: openTask,
						// T-113: the user records verdicts through the same /action route, so
						// the host sees role=user (the tool path cannot impersonate it).
						onVerdict: function (action, id, payload) {
							void store.send(action, Object.assign({ id: id }, payload === undefined ? {} : payload))
						},
						// T-132: the kind filter is module state; this forces a rerender.
						onKindFilterChange: function () { setColumnTick(function (count) { return count + 1 }) },
					})

				const tabsView = h(
					'div',
					{ className: 'gbt-tabs' },
					tabs.map(function (tab) {
						return h(
							'button',
							{ key: tab.key, type: 'button', className: 'gbt-tab', 'data-view': tab.key, 'data-active': view === tab.key ? 'true' : 'false', onClick: function () { setView(tab.key) } },
							tab.label,
						)
					}),
					snapshot.project === null || snapshot.project === undefined
						? h('button', { type: 'button', className: 'gbt-tab', onClick: function () { openProjectDialog() } }, '+ ' + t('openProject'))
						: null,
				)

				return h(
					'div',
					{ className: 'gbt-root', 'data-panel': 'task-center', 'data-panel-root': 'task-center' },
					header,
					statusline,
					environmentBar,
					projectMismatchBar,
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
									? h('p', { className: 'gbt-footnote', 'data-project-resolving': 'true' }, t('projectResolving'))
									: h(
											'div',
											{ 'data-not-activated': 'true' },
											h('p', { className: 'gbt-footnote', 'data-not-activated-title': 'true' }, t('notActivatedTitle')),
											h('ol', { className: 'gbt-footnote', 'data-not-activated-steps': 'true' }, h('li', { key: 'call' }, t('notActivatedStepCall')), h('li', { key: 'open' }, t('notActivatedStepOpen'))),
										),
								snapshot.source === 'loading'
									? null
									: h(ProjectForm, { t: t, project: snapshot.project, hostProject: snapshot.sessionProject, onClose: function () { setProjectOpen(false) } }),
							)
						: null,
					snapshot.project === null || snapshot.project === undefined
						? null
						: h(
								'div',
								{ className: 'gbt-main' },
								h('div', { className: 'gbt-content' }, tabsView, h('div', { className: 'gbt-view' }, content)),
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
					editing === null ? null : h(TaskForm, {
						task: editingTask,
						snapshot: snapshot,
						t: t,
						onClose: function () { setEditing(null) },
						onSaved: function () { setEditing(null) },
					}),
					settingsOpen ? h(SettingsForm, { t: t, dispatch: dispatch, onClose: function () { setSettingsOpen(false) } }) : null,
					projectOpen ? h(ProjectForm, { t: t, project: snapshot.project, hostProject: snapshot.sessionProject, onClose: function () { setProjectOpen(false) } }) : null,
				)
			}

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

			return { TaskCenter: TaskCenter, Glyph: Glyph }
		}


		function formFor(scope) {
			return function GodotEnginePathForm(props) {
				const { t } = props
				const [busy, setBusy] = React.useState(false)
				const [dirty, setDirty] = React.useState(false)
				const [outcome, setOutcome] = React.useState(null)
				const [seenRevision, setSeenRevision] = React.useState(undefined)
				const input = React.useRef(null)
				// A save's own answer must survive the revision bump it causes: the host
				// folds the new value in (moving `revision`) before this component reads
				// the accepted flag back.
				const keepOutcome = React.useRef(false)
				// The scope is a plain observable: bind it once per scope so the
				// subscription survives re-renders instead of resubscribing each time.
				const subscribe = React.useMemo(() => (listener) => scope.subscribe(listener), [scope])
				const read = React.useMemo(() => () => scope.getSnapshot(), [scope])
				const state = React.useSyncExternalStore(subscribe, read, read)
				const revision = state === undefined || state === null ? undefined : state.revision
				// A host revision means the document moved under us: the staged draft is
				// stale, so the next render starts from the stored value again.
				if (seenRevision !== revision) {
					setSeenRevision(revision)
					setDirty(false)
					if (keepOutcome.current) keepOutcome.current = false
					else setOutcome(null)
				}

				if (state === undefined || state === null || state.status === 'unavailable') {
					return h('p', { className: 'godot-bridge-notice', role: 'status' }, t('unavailable'))
				}
				// The settings document has not arrived yet; showing "unavailable" here
				// would be a lie, and the card fills in on its own.
				if (state.status !== 'ready') return null

				const projected =
					state.value === undefined || state.value === null ? undefined : state.value[FIELD]
				const value = textOf(projected)
				const overridden =
					state.user !== undefined && state.user !== null && Object.hasOwn(state.user, FIELD)
				const writable = state.writable === true
				const fieldId = 'godot-bridge-engine-path'

				/**
				 * Queue one field write and report whether the host accepted it.
				 * @param write - the scope call that performs the write.
				 */
				async function commit(write) {
					setBusy(true)
					setOutcome(null)
					let accepted = false
					try {
						accepted = (await write()) === true
					} catch (_rejected) {
						accepted = false
					}
					if (accepted) keepOutcome.current = true
					setBusy(false)
					setOutcome(accepted ? 'saved' : 'failed')
				}

				/** Store what the input holds; an empty draft clears the profile override. */
				function save() {
					const node = input.current
					const next = node === null || node === undefined ? '' : node.value
					if (next === '') return commit(() => scope.unset(FIELD))
					return commit(() => scope.set(FIELD, next))
				}

				return h(
					'div',
					null,
					writable
						? null
						: h('p', { className: 'godot-bridge-notice', role: 'status' }, t('readOnly')),
					h(
						'div',
						{ className: 'godot-bridge-field' },
						h(
							'div',
							{ className: 'godot-bridge-head' },
							h('label', { className: 'godot-bridge-label', htmlFor: fieldId }, t('label')),
							overridden
								? h('span', { className: 'godot-bridge-badge' }, t('overridden'))
								: null,
						),
						h('input', {
							id: fieldId,
							className: 'godot-bridge-input',
							key: 'revision-' + String(state.revision),
							ref: input,
							type: 'text',
							defaultValue: value,
							disabled: !writable || busy,
							spellCheck: false,
							autoComplete: 'off',
							onInput: () => {
								setDirty(true)
								setOutcome(null)
							},
						}),
						h('p', { className: 'godot-bridge-hint' }, t('hint')),
					),
					h(
						'div',
						{ className: 'godot-bridge-footer' },
						h(
							'button',
							{
								type: 'button',
								className: 'godot-bridge-save',
								disabled: !writable || busy || !dirty,
								onClick: save,
							},
							busy ? t('saving') : t('save'),
						),
						overridden
							? h(
									'button',
									{
										type: 'button',
										className: 'godot-bridge-reset',
										disabled: !writable || busy,
										onClick: () => commit(() => scope.unset(FIELD)),
									},
									t('reset'),
								)
							: null,
						outcome === null
							? null
							: h(
									'p',
									{
										className: 'godot-bridge-message',
										'data-failed': outcome === 'failed' ? 'true' : 'false',
										role: 'status',
									},
									outcome === 'saved' ? t('saved') : t('failed'),
								),
					),
				)
			}
		}

		return {
			/** Cordis services this browser half needs; slots is mandatory here. */
			inject: ['slots', 'locale'],
			apply(ctx) {
				// T-99: the session resolver asks this context for the Host's own
				// services (uiWorkspace / uiSession) at request time.
				tcHostContext = ctx
				ctx.effect(
					() => ctx.locale.register(LOCALE_NS, { zh, en }),
					'godot-bridge: dictionaries',
				)
				ctx.effect(() => {
					const style = document.createElement('style')
					style.setAttribute('data-plugin', 'godot-bridge')
					style.textContent = CSS
					document.head.appendChild(style)
					return () => {
						style.remove()
					}
				}, 'godot-bridge: form styles')
				ctx.inject(['configForms'], (forms) => {
					const scope = forms.configForms.get(ENTRY_NS)
					ctx.slots.inject('plugins.bundle.config', () =>
						ctx.slots.register(
							{ name: 'plugins.bundle.config', key: 'godot-bridge', locale: LOCALE_NS },
							formFor(scope),
						),
					)
				})

				ctx.effect(
					() => ctx.locale.register(TC_NS, TC_DICT),
					'godot-bridge: task center dictionaries',
				)
				ctx.effect(() => {
					const style = document.createElement('style')
					style.setAttribute('data-plugin', 'godot-bridge')
					style.setAttribute('data-plugin-css', 'godot-bridge/task-center.css')
					style.textContent = TC_CSS
					document.head.appendChild(style)
					return () => {
						style.remove()
					}
				}, 'godot-bridge: task center styles')
				ctx.effect(() => {
					const store = createTaskStore(ctx.locale.bind(TC_NS))
					const views = createTaskCenterViews(ctx, store)
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
					return () => {
						dropGlyph()
						dropPanel()
					}
				}, 'godot-bridge: task center panel')
			},
		}
	},
})
