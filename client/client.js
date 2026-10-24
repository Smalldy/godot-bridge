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
			'.godot-bridge-badge{font-size:11px;line-height:1.5;padding:1px 6px;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-4);color:var(--dsw-alias-label-secondary)}',
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
			'.godot-bridge-message[data-failed="true"]{color:var(--dsw-alias-label-error)}',
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
				workerStatus: '状态',
				workerCurrent: '当前任务',
				workersHint: '执行者是当前 Team 的 WorkAgent：优先复用空闲成员，没有空闲时才新建；上限由派发设置决定（GUI 下默认是并发 + 1）。',
				workersNoTeam: '没有可用的 Team Lead：任务会保持等待，直到有 Team 会话存在。',
				workersEmpty: 'Team 里还没有 WorkAgent。',
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
				statusStaleWorktrees: '个陈旧工作树',
				statusCleanupUnavailable: '清理能力尚未提供',
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
				roleInstancesCount: '实例数',
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
				roleErrInstances: '实例数必须是 1–8 的整数',
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
				workerStatus: 'Status',
				workerCurrent: 'Current task',
				workersHint: 'Workers are the WorkAgents of the current Team: idle members are reused first and a new one is spawned only when none is idle; the cap comes from the dispatch settings (concurrency + 1 by default in the GUI).',
				workersNoTeam: 'No live Team Lead: tasks stay pending until a Team session exists.',
				workersEmpty: 'The team has no WorkAgent yet.',
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
				statusStaleWorktrees: 'stale worktrees',
				statusCleanupUnavailable: 'cleanup is not available yet',
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
				roleInstancesCount: 'Instances',
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
				roleErrInstances: 'instances must be an integer from 1 to 8',
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
			'.gbt-mark{width:30px;height:30px;border-radius:9px;display:grid;place-items:center;background:linear-gradient(135deg,#4f7cff,#7a5cff);color:#fff;font-weight:600;font-size:15px;flex:none}',
			'.gbt-title{margin:0;font-size:15px;font-weight:600;letter-spacing:.01em}',
			'.gbt-titleline{display:flex;align-items:center;gap:7px;min-width:0}' +
				'.gbt-projectsource{flex:none;font-size:10px;line-height:1.6;padding:0 6px;border-radius:999px;text-transform:none;letter-spacing:0;background:var(--dsw-alias-bg-layer-4);color:var(--dsw-alias-label-secondary);border:0.5px solid var(--dsw-alias-border-l4);cursor:default}' +
				'.gbt-projectsource[data-project-source="session"]{color:var(--dsw-alias-state-business-primary,#4f7cff);border-color:rgba(79,124,255,.35)}',
			'.gbt-project{margin:0;font-size:11px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:340px;font-family:ui-monospace,SFMono-Regular,Consolas,monospace}',
			'.gbt-counts{display:flex;gap:6px;flex-wrap:wrap}',
			'.gbt-count{display:flex;align-items:center;gap:5px;padding:2px 9px;border-radius:999px;background:var(--dsw-alias-bg-layer-4);font-size:11px;color:var(--dsw-alias-label-secondary)}',
			'.gbt-count b{font-weight:600;color:var(--dsw-alias-label-primary)}',
			'.gbt-workermeta{display:flex;gap:6px;flex-wrap:wrap;margin:0 0 12px}',
			'.gbt-controls{display:flex;gap:8px;margin-left:auto;align-items:center;flex-wrap:wrap}',
			'.gbt-btn{appearance:none;border:0.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);height:30px;padding:0 12px;border-radius:8px;font:inherit;font-size:12px;cursor:pointer;white-space:nowrap;display:inline-flex;align-items:center;gap:5px}',
			'.gbt-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-4)}',
			'.gbt-btn:disabled{opacity:.45;cursor:default}',
			'.gbt-btn[data-variant="primary"]{background:var(--dsw-alias-state-business-primary,#4f7cff);border-color:transparent;color:#fff}',
			'.gbt-btn[data-variant="primary"]:hover:not(:disabled){background:var(--dsw-alias-state-business-primary,#4f7cff);filter:brightness(1.05)}',
			'.gbt-btn[data-variant="danger"]{color:var(--dsw-alias-label-error,#e5484d);border-color:rgba(229,72,77,.35)}',
			'.gbt-btn[data-size="sm"]{height:26px;padding:0 9px;font-size:11px}',
			'.gbt-statusline{display:flex;align-items:center;gap:10px;padding:7px 18px;border-bottom:0.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-2);font-size:11px;color:var(--dsw-alias-label-tertiary);flex-wrap:wrap}',
			'.gbt-dot{width:7px;height:7px;border-radius:50%;background:#8a8f98;display:inline-block;flex:none}',
			'.gbt-dot[data-running="true"]{background:#2fb344;box-shadow:0 0 0 3px rgba(47,179,68,.14)}',
			'.gbt-main{display:flex;min-height:0;flex:1}',
			'.gbt-content{display:flex;flex-direction:column;min-width:0;flex:1;min-height:0}',
			'.gbt-tabs{display:flex;gap:4px;padding:10px 18px 0;flex-wrap:wrap}',
			'.gbt-tab{appearance:none;border:none;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;padding:6px 11px;border-radius:8px;cursor:pointer}',
			'.gbt-tab:hover{background:var(--dsw-alias-bg-layer-4)}',
			'.gbt-tab[data-active="true"]{background:var(--dsw-alias-bg-layer-4);color:var(--dsw-alias-label-primary);font-weight:600}',
			'.gbt-view{flex:1;min-height:0;overflow:auto;padding:12px 18px 18px}',
			'.gbt-board{display:flex;gap:12px;align-items:stretch;min-height:100%}',
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
				'.gbt-donerow:hover{border-color:var(--dsw-alias-state-business-primary,#4f7cff)}' +
				'.gbt-donerow .gbt-id{flex:none}' +
				'.gbt-donetitletext{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
				'.gbt-donewhen{flex:none;font-size:11px;color:var(--dsw-alias-label-tertiary);font-family:var(--mono,monospace)}' +
				'.gbt-skel{height:34px;border-radius:7px;background:linear-gradient(90deg,var(--dsw-alias-bg-layer-3),var(--dsw-alias-bg-layer-4),var(--dsw-alias-bg-layer-3));background-size:200% 100%;animation:gbt-skel 1.2s linear infinite}' +
				'@keyframes gbt-skel{0%{background-position:200% 0}100%{background-position:-200% 0}}' +
				'.gbt-colcount{margin-left:auto;font-weight:500;color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-bg-layer-4);border-radius:999px;padding:0 7px;font-size:10px}',
			'.gbt-cards{display:flex;flex-direction:column;gap:8px;padding:9px;overflow:auto;min-height:40px}',
			'.gbt-card{border:0.5px solid var(--dsw-alias-border-l4);border-radius:10px;padding:9px 10px;background:var(--dsw-alias-bg-layer-2);cursor:pointer;display:flex;flex-direction:column;gap:6px;transition:border-color .12s ease,box-shadow .12s ease}',
			'.gbt-card:hover{border-color:rgba(79,124,255,.6)}',
			'.gbt-card[data-selected="true"]{border-color:var(--dsw-alias-state-business-primary,#4f7cff);box-shadow:0 0 0 1px rgba(79,124,255,.35)}',
			'.gbt-cardtop{display:flex;align-items:center;gap:6px;flex-wrap:wrap}',
			'.gbt-id{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px;color:var(--dsw-alias-label-tertiary)}',
			'.gbt-cardtitle{font-size:12px;font-weight:500;line-height:1.45;color:var(--dsw-alias-label-primary);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word}',
			'.gbt-cardmeta{display:flex;gap:5px;flex-wrap:wrap;font-size:11px;color:var(--dsw-alias-label-tertiary)}',
			'.gbt-chip{display:inline-flex;align-items:center;gap:3px;padding:1px 6px;border-radius:5px;background:var(--dsw-alias-bg-layer-4);color:var(--dsw-alias-label-secondary);font-size:10px;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
			'.gbt-chip[data-tone="ready"]{background:rgba(47,179,68,.13);color:#2f9e44}',
			'.gbt-chip[data-tone="waiting"]{background:rgba(245,159,0,.13);color:#b7791f}',
			'.gbt-chip[data-tone="broken"]{background:rgba(229,72,77,.13);color:#d33}',
			'.gbt-chip[data-tone="running"]{background:rgba(79,124,255,.13);color:#3b5bdb}',
			'.gbt-chip[data-tone="reviewing"]{background:rgba(121,80,242,.13);color:#7048e8}',
			'.gbt-chip[data-tone="testing"]{background:rgba(245,159,0,.13);color:#b7791f}',
			'.gbt-chip[data-tone="done"]{background:rgba(47,179,68,.13);color:#2f9e44}',
			'.gbt-chip[data-tone="blocked"]{background:rgba(229,72,77,.13);color:#d33}',
			'.gbt-chip[data-tone="cancelled"]{background:var(--dsw-alias-bg-layer-4);color:var(--dsw-alias-label-tertiary)}',
			'.gbt-empty{padding:26px 12px;text-align:center;color:var(--dsw-alias-label-tertiary);font-size:12px;border:0.5px dashed var(--dsw-alias-border-l4);border-radius:10px;margin:6px}',
			'.gbt-rowlist{display:flex;flex-direction:column;gap:6px}',
			'.gbt-row{display:grid;grid-template-columns:34px 64px minmax(0,1fr) auto;gap:10px;align-items:center;padding:8px 10px;border:0.5px solid var(--dsw-alias-border-l4);border-radius:9px;background:var(--dsw-alias-bg-layer-3);cursor:pointer}',
			'.gbt-row:hover{border-color:rgba(79,124,255,.55)}',
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
			'.gbt-sectlabel{align-self:flex-start;font-size:11px;letter-spacing:.04em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-bg-layer-4);border-radius:999px;padding:0 6px;margin:4px 0 0}',
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
'.gbt-seg:hover{background:var(--dsw-alias-bg-layer-4);color:var(--dsw-alias-label-primary)}',
'.gbt-seg:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4f7cff);outline-offset:1px}',
'.gbt-seg[aria-selected="false"]{opacity:.7}',
'.gbt-seg[aria-selected="true"]{background:var(--dsw-alias-bg-layer-4);color:var(--dsw-alias-label-primary);font-weight:600;border-bottom-color:var(--dsw-alias-state-business-primary,#4f7cff)}',
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
'.gbt-detailpill[data-tone="ok"]{color:var(--ok,#3ecf8e);border-color:rgba(62,207,142,.4)}',
'.gbt-detailpill[data-tone="bad"]{color:var(--bad,#e5645c);border-color:rgba(229,100,92,.4)}',
'.gbt-detailwho{color:var(--t2,var(--dsw-alias-label-secondary));font-size:11.5px}',
'.gbt-detailwhen{margin-left:auto;color:var(--t3,var(--dsw-alias-label-tertiary));font-size:11.5px;font-family:var(--mono,monospace)}',
'.gbt-detailex{flex-basis:100%;color:var(--t3,var(--dsw-alias-label-tertiary));font-size:11.5px}',
'.gbt-detailreason{flex-basis:100%;margin-top:2px;padding:7px 9px;border-left:2px solid var(--bad,#e5645c);background:rgba(229,100,92,.07);border-radius:0 5px 5px 0;font-size:12px;color:var(--t2,var(--dsw-alias-label-secondary));white-space:pre-wrap}',
'.gbt-detailreason.good{border-left-color:var(--ok,#3ecf8e);background:rgba(62,207,142,.07)}',
'.gbt-detailpreview{margin:4px 0 0;padding:8px;background:var(--elev,var(--dsw-alias-bg-layer-4));border-radius:6px;font-size:11.5px;max-height:200px;overflow:auto;white-space:pre-wrap}',
'.gbt-detailstages{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:8px;margin:4px 0 2px}',
'.gbt-detailstage{display:flex;flex-direction:column;gap:5px;font-size:11.5px;color:var(--t2,var(--dsw-alias-label-tertiary))}',
'.gbt-detailstagebar{height:4px;border-radius:2px;background:var(--line2,var(--dsw-alias-border-l4))}',
'.gbt-detailstage[data-state="done"] .gbt-detailstagebar{background:var(--ok,#3ecf8e)}',
'.gbt-detailstage[data-state="active"] .gbt-detailstagebar{background:var(--dsw-alias-state-business-primary,#4f7cff)}',
'.gbt-detailstage[data-state="interrupted"] .gbt-detailstagebar{background:var(--bad,#e5645c)}',
'.gbt-detailstagelabel{display:flex;gap:6px;align-items:baseline}',
'.gbt-detailstagetime{margin-left:auto;font-family:var(--mono,monospace);font-size:11px}',
'.gbt-detailinterrupt{margin:2px 0 6px;font-size:11.5px;color:var(--bad,#e5645c)}',
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
'.gbt-statuswhy{margin-top:6px;padding:8px 10px;border-radius:6px;background:var(--elev,var(--dsw-alias-bg-layer-4));font-size:12px;color:var(--t2,var(--dsw-alias-label-secondary));line-height:1.55}',
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
'.gbt-linkbtn{border:0;background:none;color:var(--dsw-alias-state-business-primary,#4f7cff);cursor:pointer;font:inherit;padding:0}',
'@media (max-width:900px){.gbt-statusgrid{grid-template-columns:1fr}}',
'.gbt-roleseg{display:inline-flex;align-items:center;gap:2px;padding:2px;border:1px solid var(--line,var(--dsw-alias-border-l4));border-radius:7px;background:var(--dsw-alias-bg-layer-2)}',
'.gbt-rolesegitem{appearance:none;height:26px;padding:0 14px;border:none;border-radius:5px;background:transparent;color:var(--t2,var(--dsw-alias-label-secondary));font:inherit;font-size:12px;font-weight:400;line-height:26px;cursor:pointer;text-decoration:none}',
'.gbt-rolesegitem:hover{background:var(--dsw-alias-bg-layer-3);color:var(--t1,var(--dsw-alias-label-primary))}',
'.gbt-rolesegitem:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4f7cff);outline-offset:1px}',
'.gbt-rolesegitem[aria-selected="true"]{background:var(--elev,var(--dsw-alias-bg-layer-4));color:var(--t1,var(--dsw-alias-label-primary))}',
'.gbt-rolecard{display:flex;flex-direction:column;gap:8px;min-width:0;border:1px solid var(--line,var(--dsw-alias-border-l4));border-radius:8px;background:var(--panel,var(--dsw-alias-bg-layer-1));padding:10px 12px}',
'.gbt-rolecardhead{font-size:13px;line-height:1.4;color:var(--t1,var(--dsw-alias-label-primary));font-weight:600}',
'.gbt-rolecardbody{display:flex;flex-direction:column;gap:6px;min-width:0}',
'.gbt-rolespane .gbt-sectlabel{font-size:11px;font-weight:400;letter-spacing:0;text-transform:none;background:none;border-left:2px solid var(--dsw-alias-state-business-primary,#4f7cff);border-radius:0;padding:0 0 0 6px;margin:2px 0}',
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
			'.gbt-input:focus-visible,.gbt-area:focus-visible{outline:none;border-color:var(--dsw-alias-state-business-primary,#4f7cff)}',
			'.gbt-area{min-height:64px;resize:vertical;height:auto;line-height:1.5}',
			'.gbt-row2{display:grid;grid-template-columns:1fr 1fr;gap:10px}',
			'.gbt-check{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary)}',
			'.gbt-check input{accent-color:var(--dsw-alias-state-business-primary,#4f7cff)}',
			'.gbt-banner{margin:10px 18px 0;padding:8px 11px;border-radius:8px;background:rgba(229,72,77,.10);border:0.5px solid rgba(229,72,77,.3);color:#c92a2a;font-size:12px;display:flex;gap:8px;align-items:center}',
			'.gbt-banner[data-tone="info"]{background:rgba(79,124,255,.10);border-color:rgba(79,124,255,.28);color:#3b5bdb}' +
				'.gbt-banner[data-tone="warn"]{background:rgba(245,159,0,.10);border-color:rgba(245,159,0,.32);color:#b26a00}' +
				'.gbt-banner[data-project-mismatch="true"]{cursor:pointer}',
			'.gbt-footnote{font-size:10px;color:var(--dsw-alias-label-tertiary);margin:0}',
			'.gbt-pill{display:inline-flex;align-items:center;gap:4px;padding:1px 7px;border-radius:999px;font-size:10px;font-weight:500;background:var(--dsw-alias-bg-layer-4);color:var(--dsw-alias-label-secondary)}',
			'.gbt-pill[data-status="running"]{background:rgba(79,124,255,.14);color:#3b5bdb}',
			'.gbt-pill[data-status="reviewing"]{background:rgba(121,80,242,.14);color:#7048e8}',
			'.gbt-pill[data-status="testing"]{background:rgba(245,159,0,.14);color:#b7791f}',
			'.gbt-pill[data-status="approved"]{background:rgba(47,179,68,.14);color:#2f9e44}',
			'.gbt-pill[data-status="changes-requested"]{background:rgba(229,72,77,.14);color:#d33}',
			'.gbt-pill[data-status="done"]{background:rgba(47,179,68,.14);color:#2f9e44}',
			'.gbt-pill[data-status="blocked"]{background:rgba(229,72,77,.14);color:#d33}',
			'.gbt-pill[data-status="cancelled"]{background:var(--dsw-alias-bg-layer-4);color:var(--dsw-alias-label-tertiary)}',
			'.gbt-pill[data-status="inactive"]{background:var(--dsw-alias-bg-layer-4);color:var(--dsw-alias-label-tertiary)}',
			'.gbt-pill[data-status="provisioning"]{background:rgba(245,159,0,.14);color:#b7791f}',
			'.gbt-pill[data-status="failed"]{background:rgba(229,72,77,.14);color:#d33}',
			'.gbt-pill[data-status="pending"]{background:rgba(245,159,0,.14);color:#b7791f}',
			'.gbt-pill[data-status="passed"]{background:rgba(47,179,68,.14);color:#2f9e44}',
			'.gbt-iconbtn{appearance:none;border:none;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;font-size:16px;line-height:1;padding:2px 5px;border-radius:6px}',
			'.gbt-iconbtn:hover{background:var(--dsw-alias-bg-layer-4);color:var(--dsw-alias-label-primary)}',
			'.gbt-projectform{display:flex;gap:6px;align-items:center;margin-top:10px;flex-wrap:wrap}',
			'.gbt-projectform .gbt-input{flex:1;min-width:220px}',
			'.gbt-busy{opacity:.6;pointer-events:none}',
			'.gbt-btn[data-busy="true"]{opacity:.65;cursor:progress}',
			'.gbt-progress{display:flex;align-items:center;gap:8px;margin:8px 18px 0;padding:6px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-3);border:0.5px solid var(--dsw-alias-border-l4);font-size:11px;color:var(--dsw-alias-label-secondary)}',
			'.gbt-progress .gbt-progressbar{position:relative;flex:1;height:2px;border-radius:2px;background:var(--dsw-alias-border-l4);overflow:hidden}',
			'.gbt-progress .gbt-progressbar::after{content:"";position:absolute;left:-40%;top:0;bottom:0;width:40%;background:var(--dsw-alias-state-business-primary,#4f7cff);animation:gbt-slide 1.1s ease-in-out infinite}',
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

		function tcPhaseLabel(task, t) {
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
				const children = []
				const top = [h('span', { key: 'id', className: 'gbt-id' }, task.id)]
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
				if (review !== null) {
					meta.push(
						h('span', { key: 'review', className: 'gbt-chip', 'data-tone': tcReviewTone(review.status), title: t('reviewStatus') + ' · ' + t('reviewAttempt') + ' ' + String(tcRound(review)) }, '👁 ' + tcReviewLabel(review.status, t) + ' · #' + String(tcRound(review))),
					)
					if (review.status !== 'pending' && typeof review.by === 'string' && review.by !== '') {
						meta.push(h('span', { key: 'reviewer', className: 'gbt-chip', title: t('reviewer') }, '👤 ' + review.by))
					}
				}
				if (test !== null) {
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
				if (merge !== null) {
					meta.push(h('span', { key: 'merge', className: 'gbt-chip', 'data-tone': tcMergeTone(merge.status), title: t('mergeTitle') }, '⇄ ' + tcMergeLabel(merge.status, t)))
				}
				if (typeof task.target === 'string' && task.target !== '') meta.push(h('span', { key: 'target', className: 'gbt-chip', 'data-target-branch': task.target, title: t('targetBranch') }, '🎯 ' + task.target))
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
											})
										}),
							),
					props.footer === undefined || props.footer === null ? null : h('div', { className: 'gbt-colfoot' }, props.footer),
				)
			}

			function Board(props) {
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
				const ready = tasks.filter(function (task) { return task.status === 'pending' && task.dependency !== undefined && task.dependency.state === 'ready' })
				const waiting = tasks.filter(function (task) { return task.status === 'pending' && (task.dependency === undefined || task.dependency.state !== 'ready') })
				const doneTasks = tasks.filter(function (task) { return task.status === 'done' }).slice().sort(recentFirst)
				const doneCount = Number.isFinite(counts.done) ? counts.done : doneTasks.length
				const groups = [
					{ key: 'ready', label: t('ready'), tasks: ready },
					{ key: 'waiting', label: t('waiting'), tasks: waiting },
					{ key: 'running', label: t('runningCol'), tasks: tasks.filter(function (task) { return task.status === 'running' }) },
					{ key: 'reviewing', label: t('reviewingCol'), tasks: tasks.filter(function (task) { return task.status === 'reviewing' }) },
					{ key: 'testing', label: t('testingCol'), tasks: tasks.filter(function (task) { return task.status === 'testing' }) },
					{ key: 'done', label: t('doneCol'), tasks: doneTasks },
					{
						key: 'blocked',
						label: t('blockedCol'),
						tasks: tasks.filter(function (task) { return task.status === 'blocked' || task.status === 'cancelled' }).slice().sort(recentFirst),
					},
				]
				if (tasks.length === 0) return h('div', { className: 'gbt-empty' }, t('emptyBoard'))
				function toggle(key) {
					tcWriteColumnCollapsed(key, !tcColumnCollapsed(key))
					if (props.onColumnToggle !== undefined) props.onColumnToggle()
				}
				return h(
					'div',
					{ className: 'gbt-board' },
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
							onOpen: props.onOpen,
							onToggle: function () { toggle(group.key) },
						})
					}),
				)
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
				const blocks = []
				blocks.push(h('p', { key: 'hint', className: 'gbt-footnote' }, t('workersHint')))
				if (snapshot.source === 'error') {
					blocks.push(h('div', { key: 'offline', className: 'gbt-empty' }, t('workersUnavailable')))
					return h('div', null, blocks)
				}
				if (workers === null || workers === undefined) {
					blocks.push(h('div', { key: 'unavailable', className: 'gbt-empty' }, t('workersUnavailable')))
					return h('div', null, blocks)
				}
				if (typeof workers.error === 'string' && workers.error !== '') {
					const errorKey = WORKER_ERROR[workers.error]
					const explanation = errorKey === undefined ? workers.error : t(errorKey) + ' (' + workers.error + ')'
					blocks.push(h('div', { key: 'error', className: 'gbt-banner', style: { margin: '0 0 12px' } }, h('span', null, t('workersError') + ': ' + explanation)))
				}
				const lead = typeof workers.lead === 'string' && workers.lead.length > 0 ? workers.lead : null
				const countText = function (value) {
					return Number.isFinite(value) ? String(value) : '—'
				}
				blocks.push(
					h(
						'div',
						{ key: 'meta', className: 'gbt-workermeta' },
						h('span', { key: 'lead', className: 'gbt-count' }, t('workersLead'), h('b', null, lead === null ? '—' : lead)),
						h('span', { key: 'cap', className: 'gbt-count' }, t('workersCap'), h('b', null, countText(workers.cap))),
						h('span', { key: 'busy', className: 'gbt-count' }, t('workersBusy'), h('b', null, countText(workers.busy))),
						h('span', { key: 'idle', className: 'gbt-count' }, t('workersIdle'), h('b', null, countText(workers.idle))),
						h('span', { key: 'provisioning', className: 'gbt-count' }, t('workersProvisioning'), h('b', null, countText(workers.provisioning))),
						h('span', { key: 'failed', className: 'gbt-count' }, t('workersFailed'), h('b', null, countText(workers.failed))),
					),
				)
				const members = Array.isArray(workers.members) ? workers.members : []
				if (lead === null) blocks.push(h('div', { key: 'noteam', className: 'gbt-empty' }, t('workersNoTeam')))
				if (members.length === 0) {
					blocks.push(h('div', { key: 'empty', className: 'gbt-empty' }, t('workersEmpty')))
					return h('div', null, blocks)
				}
				blocks.push(
					h(
						'table',
						{ key: 'table', className: 'gbt-locktable' },
						h('thead', null, h('tr', null, h('th', null, t('workerName')), h('th', null, t('workerStatus')), h('th', null, t('workerCurrent')))),
						h(
							'tbody',
							null,
							members.map(function (member, index) {
								const name = typeof member.name === 'string' && member.name !== '' ? member.name : typeof member.id === 'string' && member.id !== '' ? member.id : '—'
								const status = typeof member.status === 'string' ? member.status : null
								const current = member.currentTask !== null && member.currentTask !== undefined ? member.currentTask : null
								let task = '—'
								if (current !== null && typeof current.id === 'string' && current.id !== '') {
									task = typeof current.title === 'string' && current.title !== '' ? current.id + ' · ' + current.title : current.id
								} else if (status === 'inactive') {
									task = t('workersIdle')
								}
								return h(
									'tr',
									{ key: member.id === undefined || member.id === null ? String(index) : String(member.id), 'data-worker': name, 'data-status': status === null ? '' : status },
									h('td', { className: 'gbt-mono', 'data-col': 'worker-name' }, name),
									h('td', { 'data-col': 'worker-status' }, h('span', { className: 'gbt-pill', 'data-status': status === null ? '' : status }, status === null ? '—' : workerStatusLabel(status, t))),
									h('td', { 'data-col': 'worker-task' }, task),
								)
							}),
						),
					),
				)
				return h('div', null, blocks)
			}

			const WORKER_STATUS = { running: 'workersBusy', inactive: 'workersIdle', provisioning: 'workersProvisioning', failed: 'workersFailed' }
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
				'invalid-role-instances': 'roleErrInstances',
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
				const instancesRef = React.useRef(null)
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
						instances: Number(valueOf(instancesRef, '1')),
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
					h('label', null, t('roleInstancesCount'), h('input', { ref: instancesRef, className: 'gbt-input', 'data-field': 'instances', type: 'number', min: 1, max: 8, defaultValue: '1' })),
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
					instances: profile.instances,
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
				const instancesRef = React.useRef(null)
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
				function currentInstances() {
					const node = instancesRef.current
					const raw = node !== null && node !== undefined && node.value !== '' ? Number(node.value) : NaN
					if (Number.isInteger(raw) && raw >= 1 && raw <= 8) return raw
					return target !== null && Number.isInteger(target.instances) ? target.instances : 1
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
						? Object.assign({}, submitted.profile, { prompt: currentTemplate(), skills: currentSkills(), instances: currentInstances() })
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
					const instancesField = currentInstances()
					const outcome = await send('rolesUpdate', { name: selectedName, profile: { prompt: template, skills: skills, instances: instancesField } })
					if (outcome.ok !== true) return
					// Keep the saved values visible until the host snapshot catches up.
					roleEditorState.saved = { name: selectedName, profile: Object.assign({}, target === null ? {} : target, { prompt: template, skills: skills, instances: instancesField }) }
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
				const instancesRow = h('label', { className: 'gbt-editorfield', 'data-section': 'role-editor-instances-field' }, t('roleInstancesCount'),
					h('input', { key: 'instances:' + controlKey, ref: instancesRef, type: 'number', min: 1, max: 8, step: 1, className: 'gbt-input', 'data-field': 'instances', defaultValue: String(target !== null && Number.isInteger(target.instances) ? target.instances : 1), disabled: builtin || !editablePrompt }))
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
						h('div', { className: 'gbt-rolefields', 'data-section': 'role-editor-fields' }, skillsRow, instancesRow)),
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
				const members = agents !== null && agents !== undefined && Array.isArray(agents.members) ? agents.members : []
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
						h('div', { className: 'gbt-rhead' }, h('h3', { className: 'gbt-rtitle' }, t('roleEditor'))),
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
				const agents = snapshot.agents
				const entries = activity !== null && activity !== undefined && Array.isArray(activity.entries) ? activity.entries : []
				const sweepCount = entries.filter(function (entry) { return entry.kind === 'sweep' }).length
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


				// ── the activity stream: localized events for the phases ──
				function shortSha(value) {
					return typeof value === 'string' && value !== '' ? value.slice(0, 7) : ''
				}
				const stream = []
				tasks.forEach(function (task) {
					const hist = Array.isArray(task.history) ? task.history.slice().sort(function (left, right) { return new Date(left.at).getTime() - new Date(right.at).getTime() }) : []
					let reviewRound = 0
					hist.forEach(function (entry) {
						const to = typeof entry.to === 'string' ? entry.to : ''
						const from = typeof entry.from === 'string' ? entry.from : null
						const assignee = task.assignee !== null && task.assignee !== undefined && typeof task.assignee.name === 'string' ? memberName(task.assignee.name) : null
						let type = null
						if (to === 'pending' && from === null) type = 'create'
						else if (to === 'pending') type = 'retry'
						else if (to === 'running' && (from === 'pending' || from === null)) type = 'dispatch'
						else if (to === 'reviewing') type = 'submit'
						else if (to === 'running' && from === 'reviewing') type = 'review-reject'
						else if (to === 'testing') type = 'review-pass'
						else if (to === 'running' && from === 'testing') type = 'test-fail'
						else if (to === 'done') type = 'test-pass'
						else if (to === 'blocked') type = 'blocked'
						else if (to === 'cancelled') type = 'cancel'
						if (type === null) return
						if (type === 'review-pass' || type === 'review-reject') reviewRound += 1
						const eventRound = reviewRound
						const review = task.review !== null && task.review !== undefined ? task.review : null
						const test = task.test !== null && task.test !== undefined ? task.test : null
						const note = typeof entry.note === 'string' && entry.note !== '' ? entry.note : null
						const noteSha = (function () {
							const match = /@([0-9a-fA-F]{7,40})/.exec(note === null ? '' : note)
							return match === null ? '' : match[1].slice(0, 7)
						})()
						stream.push({
							key: 'hist-' + task.id + '-' + String(entry.at) + '-' + type,
							at: entry.at,
							type: type,
							taskId: task.id,
							html: eventText(type, task, assignee, review, test, entry, note, eventRound, noteSha),
							raw: note,
						})
					})
					const merge = tcMergeOf(task)
					if (merge !== null && typeof merge.at === 'string') {
						const commit = typeof merge.mergeCommit === 'string' && merge.mergeCommit !== '' ? shortSha(merge.mergeCommit) : ''
						const mergeActor = mergeActorOf(task)
						stream.push({
							key: 'merge-' + task.id,
							at: merge.at,
							type: 'merge',
							taskId: task.id,
							html: task.id + ' · ' + task.title + ' → ' + (typeof merge.target === 'string' ? merge.target : '—') + (commit === '' ? '' : ' · ' + commit) +
								(mergeActor === null ? '' : ' · ' + memberName(mergeActor.by, mergeActor.byName, 'actorRoleMerger')),
							raw: typeof merge.output === 'string' ? merge.output.split('\n')[0] : null,
						})
					}
				})
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
					: sweepCount > 0 ? t('statusLastActivity') + ' ' + t('statusOnlyHeartbeats') : null
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
						h('div', { className: 'gbt-statuskvs' }, h('span', { className: 'gbt-statuskv', 'data-kv': 'concurrent' }, h('b', null, String(running.length)), h('span', null, '/ ' + String(maxConcurrent) + ' ' + t('statusConcurrent'))), h('span', { className: 'gbt-statuskv', 'data-kv': 'ready' }, h('b', null, String(ready)), h('span', null, t('statusReady'))), h('span', { className: 'gbt-statuskv', 'data-kv': 'merge-queue' }, h('b', null, String(queue.length)), h('span', null, t('statusMergeQueue')))),
						h('div', { className: 'gbt-statuswhy', 'data-status-why': 'true' }, whyNotRunning()),
						h('div', { className: 'gbt-statusscan', 'data-status-scan': 'true' }, t('statusLastScan') + ' ' + (scheduler !== null && scheduler.lastTickAt !== null && scheduler.lastTickAt !== undefined ? tcAgo(scheduler.lastTickAt, now) : '—')),
						panelSessionLine,
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
				const dispatchCardRow = h(
					'div',
					{ className: 'gbt-statusrow', 'data-worktree-row': 'main' },
					h('span', { className: 'gbt-statuswho gbt-mono' }, mainWt === undefined ? '—' : String(mainWt.path).split(/[\\/]/).filter(Boolean).slice(-1)[0] || String(mainWt.path)),
					h('span', { className: 'gbt-statusrole' }, t('statusWtMain')),
					h('span', { className: 'gbt-statustask gbt-mono' }, mainWt === undefined ? '—' : String(mainWt.branch || '—') + ' · ' + String(mainWt.head || '—').slice(0, 7)),
					h('span', { className: 'gbt-statustime' }, t('statusWtActiveState')),
				)
				const worktreesCard = h(
					'section',
					{ className: 'gbt-statuscard', 'data-status-card': 'worktrees' },
					h('div', { className: 'gbt-statuscardhead' }, h('span', { className: 'gbt-dot' }), t('statusCardWorktrees'), h('span', { className: 'gbt-statusmeta' }, String(wtList.length) + ' ' + t('statusWtTotal') + ' · ' + String(activeWts.length + (mainWt === undefined ? 0 : 1)) + ' ' + t('statusWtActive'))),
					h(
						'div',
						{ className: 'gbt-statuscardbody' },
						worktrees === null || worktrees === undefined || worktrees.available !== true
							? h('div', { className: 'gbt-statusnote' }, worktrees !== null && worktrees !== undefined && worktrees.error === 'no-git-service' ? t('statusNoGit') : t('statusWorktreesUnavailable'))
							: h('div', null, dispatchCardRow, activeWts.map(function (entry) {
									const path = String(entry.path)
									return h(
										'div',
										{ key: 'wt-' + path, className: 'gbt-statusrow', 'data-worktree-row': String(entry.taskId === undefined || entry.taskId === null ? path : entry.taskId) },
										h('span', { className: 'gbt-statuswho gbt-mono' }, typeof entry.taskId === 'string' && entry.taskId !== '' ? entry.taskId : path.split(/[\\/]/).filter(Boolean).slice(-1)[0]),
										h('span', { className: 'gbt-statusrole' }, t('statusWtTask')),
										h('span', { className: 'gbt-statustask gbt-mono' }, String(entry.branch || '—') + ' · ' + String(entry.head || '—').slice(0, 7)),
										h('span', { className: 'gbt-statustime' }, t('statusWtActiveState')),
									)
								})),
						staleWts.length === 0
							? null
							: h(
									'div',
									{ className: 'gbt-statusfold', 'data-status-stale': String(staleWts.length) },
									h('span', null, String(staleWts.length) + ' ' + t('statusStaleWorktrees') + '（' + staleWts.slice(0, 6).map(function (entry) { return typeof entry.taskId === 'string' && entry.taskId !== '' ? entry.taskId : '—' }).join(' · ') + '）'),
									h('span', { className: 'gbt-statusnote' }, t('statusCleanupUnavailable')),
								),
					),
				)
				const reviewerQueue = tasks.filter(function (task) { return task.status === 'reviewing' && tcStageQueued(task) }).length
				const testerQueue = tasks.filter(function (task) { return task.status === 'testing' && tcStageQueued(task) }).length
				const lead = agents !== null && agents !== undefined ? agents.lead : null
				const members = agents !== null && agents !== undefined && Array.isArray(agents.members) ? agents.members : []
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
							: agentRows.length === 0
								? h('div', { className: 'gbt-statusnote' }, t('workersEmpty'))
								: h('div', null, agentRows),
					),
				)
				const sweepRows = showAllActivity ? entries.filter(function (entry) { return entry.kind === 'sweep' }) : []
				const activityCard = h(
					'section',
					{ className: 'gbt-statuscard', 'data-status-card': 'activity' },
					h('div', { className: 'gbt-statuscardhead' }, h('span', { className: 'gbt-dot' }), t('statusCardActivity'), h('span', { className: 'gbt-statusmeta' }, t('statusLatestActivity') + ' ' + String(recentStream.length) + ' ' + t('statusEventUnit'))),
					h(
						'div',
						{ className: 'gbt-statuscardbody' },
						activity === null || activity === undefined || activity.available !== true
							? h('div', { className: 'gbt-statusnote' }, t('statusActivityUnavailable'))
							: recentStream.length === 0 && sweepRows.length === 0 && sweepCount === 0
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
											{ key: 'sweep-' + String(index), className: 'gbt-statusev', 'data-activity': 'sweep', 'data-activity-kind': 'sweep', title: entry.detail === null ? undefined : String(entry.detail) },
											h('span', { className: 'gbt-statusevtime gbt-mono' }, typeof entry.at === 'string' ? new Date(entry.at).toTimeString().slice(0, 5) : '—'),
											h('span', { className: 'gbt-statusevkind' }, t('statusEvtSweep')),
											h('span', { className: 'gbt-statusevtext' }, t('statusSweepsShown') + ' · ' + t('statusSweepInterval')),
										)
									}),
								),
						sweepCount === 0
							? null
							: h(
									'div',
									{ className: 'gbt-statusfold' },
									h('span', null, (showAllActivity ? t('statusSweepsShown') : t('statusSweepFolded')) + ' · ' + t('statusSweepInterval') + '（' + t('statusMergeQueue') + ' ' + String(queue.length) + ' ' + t('statusMergeQueueUnit') + '）'),
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
					if (Array.isArray(snapshot.agents.members)) snapshot.agents.members.forEach(function (member) { roster.push(member) })
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
				const stages = h(
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

				// ── "where is it now": one row per phase conclusion ──
				const events = []
				const submissions = history.filter(function (entry) { return entry.to === 'reviewing' })
				const sha = typeof task.commit === 'string' && task.commit !== '' ? task.commit.slice(0, 7) : null
				submissions.forEach(function (entry, index) {
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
				if (review !== null) {
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
				if (test !== null) {
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
				if (merge !== null) {
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
				const compactSummary = h(
					'div',
					{ className: 'gbt-detailsummary gbt-detailsummary-one', 'data-detail': 'summary', 'data-detail-summary': 'one-line' },
					h('span', { className: 'gbt-detailstat' }, h('b', null, elapsedText), h('span', null, t('detailElapsed'))),
					h('span', { className: 'gbt-detailstatline' }, t('stageReview') + ' ' + String(reviewRounds) + ' ' + t('roundUnit') + ' · ' + t('stageTest') + ' ' + String(testRounds) + ' ' + t('roundUnit')),
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
				const summaryFacts = h(
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
					h('div', { className: 'gbt-detailstatline' }, t('stageReview') + ' ' + String(reviewRounds) + ' ' + t('roundUnit'), ' · ', t('stageTest') + ' ' + String(testRounds) + ' ' + t('roundUnit'), ' · ', t('attempts') + ' ' + String(task.attempts) + '/' + String(task.maxAttempts)),
					metricsNode,
					h('div', { className: 'gbt-detailstatline', 'data-detail-target': 'true' }, t('targetBranch') + ': ' + (typeof task.target === 'string' && task.target !== '' ? task.target : t('targetDefaultLabel')) + (typeof task.base === 'string' && task.base !== '' ? ' · ' + String(task.base).slice(0, 10) + ' → ' + (typeof task.target === 'string' && task.target !== '' ? task.target : t('targetDefaultLabel')) : '')),
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
				const eventsCard = h('section', { className: 'gbt-detailcard', 'data-detail-card': 'events' }, h('div', { className: 'gbt-detailcardhead' }, t('detailWhereNow')), eventsBody)
				blocks.push(h('div', { className: 'gbt-detailbody', 'data-detail-body': layout, 'data-detail-layout': layout }, layout === 'single' ? compactSummary : null, eventsCard, layout === 'single' ? summaryDetails : summary))

				if (task.status === 'running') {
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
							h('div', { className: 'gbt-cardmeta' }, h('span', { className: 'gbt-id' }, task.id), h('span', { className: 'gbt-pill', 'data-status': task.status }, t(tcStatusKey(task.status))), Number.isFinite(task.queuePosition) && task.queuePosition > 0 ? h('span', { className: 'gbt-pill', 'data-queue': String(task.queuePosition) }, t('queuedChip').replace('{n}', String(task.queuePosition))) : null, waitingChip(task, t, 'waiting')),
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
						error === '' ? null : h('p', { className: 'gbt-footnote', style: { color: 'var(--dsw-alias-label-error,#e5484d)' } }, error),
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
						error === '' ? null : h('p', { className: 'gbt-footnote', style: { color: 'var(--dsw-alias-label-error,#e5484d)' } }, error),
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
						? h('span', { style: { color: 'var(--dsw-alias-label-error,#e5484d)' } }, '· ' + String(scheduler.lastError))
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
											onOpenDoneAll: function () { doneAllReset(); setDoneAllArchived(false); setDoneAllOpen(true) },
											onColumnToggle: function () { setColumnTick(function (count) { return count + 1 }) },
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
										: h(Board, { snapshot: snapshot, t: t, now: now, selectedId: selectedId, onOpen: openTask })

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
