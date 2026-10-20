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
		const TC_ACTION_URL = '/godot-bridge/task-center/action'
		const TC_PROJECT_KEY = 'godotBridge.taskCenter.project'

		const TC_DICT = {
			zh: {
				nav: '任务',
				title: '任务中心',
				boardTab: '看板',
				taskTitle: '标题',
				subtitle: '依赖驱动的派发 · 文件锁保护 · 跨会话共享',
				project: '项目',
				projectUnknown: '尚未选择项目',
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
				locks: '文件锁',
				lockPath: '路径',
				lockHolder: '持有者',
				lockSince: '开始',
				lockLease: '租约',
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
				blockedCol: '阻塞',
				emptyBoard: '还没有任务。点“新建任务”开始。',
				emptyQueue: '没有可派发的任务。',
				emptyLocks: '当前没有文件锁。',
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
				waiters: '等待者',
				locksWaitersHint: '等待者 = 当前会等这个文件的任务；这不是 FIFO 队列——调度器没有锁队列，只在每轮派发时重试。',
				unknownProjectHint: '还没有项目。在会话里调用一次 task_center，或在下方填写项目目录。',
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
				waitConcurrency: '并发已满',
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
				roleInstancesEmpty: '没有角色实例。',
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
				roleBind: '绑定',
				roleSave: '保存',
				roleDelete: '删除',
				roleCreate: '创建',
				rolePrompt: '指令',
				roleSkills: '技能',
				roleContext: '上下文',
				rolePermissions: '权限',
				roleInstancesCount: '实例数',
				roleReset: '恢复默认',
				roleProfilePrompt: 'Profile prompt（可修改）',
				rolePromptEmpty: '（空 —— 内置角色的上下文由宿主 brief 补齐）',
				roleFork: 'Fork',
				roleRefresh: '读取角色配置',
				roleSource: '来源',
				roleDrain: '排空',
				roleReplace: '替换',
				roleReplaceKind: '替换整类',
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
				roleErrBuiltinReadonly: '内置 profile 不能直接修改，请先 Fork 再保存',
				roleErrSkillsUnavailable: '技能服务不可用',
				roleErrUnsaved: '请先保存这个 Fork 草稿，再应用',
				roleEditor: '角色上下文编辑器',
				roleEditorHint: '选择角色 → 左栏编辑原始提示词、右栏对照宿主真正注入的完整文本 → Fork → 保存 → 应用（绑定并替换在跑实例）。',
				roleEditorDraft: '草稿（Fork，未保存）',
				roleEditorTabsLabel: '角色种类',
				roleEditorBoundProfile: '当前绑定',
				roleEditorSelectProfile: 'Profile',
				roleEditorCreateBlank: '空白新建 profile（次要入口）',
				roleEditorInstances: '实例',
				roleEditorBindHint: '选择后点“绑定”只改阶段绑定，点“应用”会同时替换在跑实例。',
				roleEditorNoProfile: '该阶段没有绑定的 profile',
				roleEditorApply: '应用（绑定并替换实例）',
				roleEditorApplySkipped: '没有在跑实例，只更新了阶段绑定。',
				rolePreviewRawTitle: '原始提示词',
				rolePreviewInjectedTitle: '注入后的提示词',
				rolePreviewVariables: '可引用变量',
				rolePreviewEmptyValue: '（空）',
				rolePreviewTaskPick: '任务',
				rolePreviewTaskAuto: '自动（最近活跃任务）',
				rolePreviewSampleTask: '示例任务（非真实，仅用于验证注入形态）',
				rolePreviewLoading: '正在读取宿主真正注入的文本…',
				rolePreviewMissing: '宿主还没有返回注入预览。',
				rolePreviewFailed: '注入预览读取失败',
				rolePreviewUnknown: '预览不可用',
				rolePreviewGroupTemplate: '你的原文',
				rolePreviewGroupTask: '任务数据',
				rolePreviewGroupFixed: '宿主固定',
				rolePreviewBuiltinReadonly: '默认角色不可直接修改；Fork 一个新副本后即可编辑原文。',
				rolePreviewWorkerReadonly: '实现阶段由每任务执行者承担，角色定制在下一步接入。',
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
				nav: 'Tasks',
				title: 'Task Center',
				boardTab: 'Board',
				taskTitle: 'Title',
				subtitle: 'Dependency-driven dispatch · file locks · shared across sessions',
				project: 'Project',
				projectUnknown: 'No project selected',
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
				locks: 'File locks',
				lockPath: 'Path',
				lockHolder: 'Holder',
				lockSince: 'Since',
				lockLease: 'Lease',
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
				blockedCol: 'Blocked',
				emptyBoard: 'No tasks yet. Use “New task” to start.',
				emptyQueue: 'Nothing is ready to dispatch.',
				emptyLocks: 'No file locks right now.',
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
				waiters: 'Waiters',
				locksWaitersHint: 'Waiters are the tasks that would wait on this file right now. This is not a FIFO queue — the scheduler keeps no lock queue and simply retries on each dispatch pass.',
				unknownProjectHint: 'No project yet. Call task_center once in a session, or enter a project directory below.',
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
				waitConcurrency: 'concurrency full',
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
				roleInstancesEmpty: 'No role instances.',
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
				roleBind: 'Bind',
				roleSave: 'Save',
				roleDelete: 'Delete',
				roleCreate: 'Create',
				rolePrompt: 'Prompt',
				roleSkills: 'Skills',
				roleContext: 'Context',
				rolePermissions: 'Permissions',
				roleInstancesCount: 'Instances',
				roleReset: 'Reset defaults',
				roleProfilePrompt: 'Profile prompt (editable)',
				rolePromptEmpty: '(empty — the host brief fills the context for built-in roles)',
				roleFork: 'Fork',
				roleRefresh: 'Reload role profiles',
				roleSource: 'Source',
				roleDrain: 'Drain',
				roleReplace: 'Replace',
				roleReplaceKind: 'Replace kind',
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
				roleErrBuiltinReadonly: 'a built-in profile cannot be edited in place; fork it first',
				roleErrSkillsUnavailable: 'skill service unavailable',
				roleErrUnsaved: 'save this fork draft before applying it',
				roleEditor: 'Role context editor',
				roleEditorHint: 'Pick a role → edit the raw prompt on the left and compare the exact injected text on the right → Fork → Save → Apply (bind and replace the running instance).',
				roleEditorDraft: 'draft (forked, unsaved)',
				roleEditorTabsLabel: 'Role kind',
				roleEditorBoundProfile: 'Bound',
				roleEditorSelectProfile: 'Profile',
				roleEditorCreateBlank: 'New blank profile (secondary)',
				roleEditorInstances: 'Instances',
				roleEditorBindHint: 'Bind changes the stage binding only; Apply also replaces the running instances.',
				roleEditorNoProfile: 'no profile is bound to this stage',
				roleEditorApply: 'Apply (bind + replace instances)',
				roleEditorApplySkipped: 'No live instance; only the stage binding was updated.',
				rolePreviewRawTitle: 'Raw prompt',
				rolePreviewInjectedTitle: 'Injected prompt',
				rolePreviewVariables: 'Usable variables',
				rolePreviewEmptyValue: '(empty)',
				rolePreviewTaskPick: 'Task',
				rolePreviewTaskAuto: 'Auto (most recent active task)',
				rolePreviewSampleTask: 'Example task (not real, only to show the injected shape)',
				rolePreviewLoading: 'Reading the exact text the host injects…',
				rolePreviewMissing: 'The host has not returned an injected preview yet.',
				rolePreviewFailed: 'Could not read the injected preview',
				rolePreviewUnknown: 'Preview unavailable',
				rolePreviewGroupTemplate: 'Your own text',
				rolePreviewGroupTask: 'Task data',
				rolePreviewGroupFixed: 'Host-fixed',
				rolePreviewBuiltinReadonly: 'A default role cannot be edited in place; fork a copy to edit the raw prompt.',
				rolePreviewWorkerReadonly: 'The implement stage is carried per task by each WorkAgent; role customization arrives in the next step.',
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
			'.gbt-drawer{width:368px;border-left:0.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-3);display:flex;flex-direction:column;min-height:0;flex:none}',
			'.gbt-drawer[data-open="false"]{display:none}',
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
			'.gbt-waiters{display:flex;gap:4px;flex-wrap:wrap}',
			'.gbt-mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px}',
			'.gbt-overlay{position:fixed;inset:0;background:rgba(15,18,24,.42);display:grid;place-items:center;z-index:100;padding:20px}',
			'.gbt-modal{width:min(580px,100%);max-height:86vh;overflow:auto;background:var(--dsw-alias-bg-layer-2);border:0.5px solid var(--dsw-alias-border-l4);border-radius:14px;box-shadow:0 24px 80px rgba(0,0,0,.22),0 2px 8px rgba(0,0,0,.08);padding:18px}',
			'.gbt-modalhead{display:flex;align-items:flex-start;gap:10px;margin-bottom:2px}',
			'.gbt-modalhead h2{margin:0;font-size:15px;font-weight:600;flex:1}',
			'.gbt-form{display:flex;flex-direction:column;gap:10px;margin-top:12px}',
'.gbt-rcard{border:0.5px solid var(--dsw-alias-border-l4);border-radius:8px;padding:12px;margin:0 0 12px;background:var(--dsw-alias-bg-layer-2);min-width:0}',
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
'.gbt-promptcols{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:10px;align-items:start}',
			'.gbt-promptcol{display:flex;flex-direction:column;gap:6px;min-width:0;border:0.5px solid var(--dsw-alias-border-l4);border-radius:8px;padding:8px 10px;background:var(--dsw-alias-bg-layer-1)}',
			'.gbt-promptcol[data-role-prompt="raw"]{border-color:rgba(79,124,255,.45)}',
			'.gbt-prompthead{display:flex;gap:6px;flex-wrap:wrap;align-items:center;justify-content:space-between;min-width:0}',
			'.gbt-promptempty{font-size:11px;line-height:1.6;color:var(--dsw-alias-label-tertiary);border:0.5px dashed var(--dsw-alias-border-l4);border-radius:6px;padding:10px}',
			'.gbt-prompttext{display:flex;flex-direction:column;gap:2px;max-height:420px;overflow:auto;padding-right:2px}',
			'.gbt-promptsection{display:flex;flex-direction:column;gap:2px;min-width:0}',
			'.gbt-sectlabel{align-self:flex-start;font-size:9px;letter-spacing:.04em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-bg-layer-4);border-radius:999px;padding:0 6px;margin:4px 0 0}',
			'.gbt-promptpre{margin:0 0 4px;white-space:pre-wrap;word-break:break-word;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:10px;line-height:1.55;color:var(--dsw-alias-label-secondary)}',
			'@media (max-width:720px){.gbt-promptcols{grid-template-columns:1fr}}',
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
			'.gbt-banner[data-tone="info"]{background:rgba(79,124,255,.10);border-color:rgba(79,124,255,.28);color:#3b5bdb}',
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
			'@media (max-width:900px){.gbt-drawer{position:fixed;right:0;top:0;bottom:0;z-index:40;box-shadow:-12px 0 40px rgba(0,0,0,.18)}.gbt-board{overflow-x:auto}.gbt-col{min-width:210px}}',
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

		function tcRememberedProject() {
			try {
				const value = window.localStorage.getItem(TC_PROJECT_KEY)
				return typeof value === 'string' && value.length > 0 ? value : null
			} catch (error) {
				return null
			}
		}

		function tcRememberProject(project) {
			try {
				if (typeof project === 'string' && project.length > 0) window.localStorage.setItem(TC_PROJECT_KEY, project)
			} catch (error) {
				/* storage can be disabled; remembering is a convenience */
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
				rolePreviews: Array.isArray(payload.rolePreviews) ? payload.rolePreviews : [],
				scheduler: payload.scheduler === undefined ? null : payload.scheduler,
				actionResult: actionResult === undefined || actionResult === null ? null : actionResult,
				actionError: payload.actionError === undefined || payload.actionError === null ? null : payload.actionError,
				version: payload.version,
				updatedAt: typeof payload.updatedAt === 'string' ? payload.updatedAt : null,
				serverTime: payload.serverTime,
			}
		}

		/**
		 * The Host binding. It owns two things only: fetch the snapshot, send an
		 * action. It keeps no board state of its own, so a failed request cannot
		 * fabricate work.
		 */
		function createTaskStore() {
			let snapshot = tcSnapshot({
				ok: false,
				project: tcRememberedProject(),
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
				const remembered = tcRememberedProject()
				const url = remembered === null ? TC_STATE_URL : TC_STATE_URL + '?project=' + encodeURIComponent(remembered)
				loading = (async function () {
					try {
						const payload = await fetchJson(url, { headers: { accept: 'application/json' } })
						if (payload && payload.ok === true && Array.isArray(payload.tasks)) {
							if (typeof payload.project === 'string') tcRememberProject(payload.project)
							// A routine poll keeps the outcome of the user's last action until
							// the next action replaces it; only the board data is refreshed.
							const next = tcSnapshot(payload, 'host', '')
							next.actionResult = snapshot.actionResult
							next.actionError = snapshot.actionError
							emit(next)
						} else {
							const failed = tcSnapshot(Object.assign({}, payload, { tasks: [] }), 'error', String((payload && payload.message) || 'the host did not answer'))
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

			async function send(action, body) {
				const payloadBody = Object.assign({ action: action }, body === undefined ? {} : body)
				const project = tcRememberedProject()
				if (project !== null) payloadBody.project = project
				const token = { action: action, id: body !== undefined && body !== null && (body.id !== undefined ? body.id : body.requestId !== undefined ? body.requestId : body.taskId !== undefined ? body.taskId : body.path !== undefined ? body.path : null) }
				setBusy(token)
				try {
					const payload = await fetchJson(TC_ACTION_URL, {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify(payloadBody),
					})
					if (payload && payload.ok === true) {
						const host = payload.snapshot !== undefined && payload.snapshot !== null ? payload.snapshot : payload
						if (host && Array.isArray(host.tasks)) emit(tcSnapshot(host, 'host', '', payload))
						if (host && typeof host.project === 'string') tcRememberProject(host.project)
						return { ok: true, payload: payload }
					}
					emit(Object.assign({}, snapshot, { message: String((payload && payload.message) || 'the host refused that action'), actionResult: null, actionError: payload === undefined || payload === null ? null : payload }))
					return { ok: false, payload: payload }
				} catch (error) {
					emit(Object.assign({}, snapshot, { message: String((error && error.message) || error) }))
					return { ok: false, error: error }
				} finally {
					if (busy === token) setBusy(null)
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
				send: send,
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
				concurrency: { key: 'waitConcurrency', tone: 'waiting' },
			}

			/** The waiting-reason chip, or null when the Host reported none. */
			function waitingChip(task, t, key) {
				const reason = task.waitingReason
				if (typeof reason !== 'string') return null
				const entry = WAITING_REASON[reason]
				if (entry === undefined) return null
				return h('span', { key: key, className: 'gbt-chip', 'data-tone': entry.tone, title: t(entry.key) }, '⏳ ' + t(entry.key))
			}

			function TaskCard(props) {
				const task = props.task
				const t = props.t
				const now = props.now
				const lease = task.status === 'running' ? tcLease(task.leaseUntil, now, t, task) : null
				const deps = Array.isArray(task.dependsOn) ? task.dependsOn : []
				const files = Array.isArray(task.writeFiles) ? task.writeFiles : []
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
				if (files.length > 0) meta.push(h('span', { key: 'files', className: 'gbt-chip' }, '🔒 ' + String(files.length)))
				if (merge !== null) {
					meta.push(h('span', { key: 'merge', className: 'gbt-chip', 'data-tone': tcMergeTone(merge.status), title: t('mergeTitle') }, '⇄ ' + tcMergeLabel(merge.status, t)))
				}
				if (branch !== '') meta.push(h('span', { key: 'branch', className: 'gbt-chip', title: branch }, '⎇ ' + branch))
				if (commit !== '') meta.push(h('span', { key: 'commit', className: 'gbt-chip', title: commit }, '● ' + commit.slice(0, 10)))
				if (worktree !== '') meta.push(h('span', { key: 'worktree', className: 'gbt-chip', title: worktree }, '🌿 ' + tcBaseName(worktree)))
				if (dispatchError !== null && task.status !== 'running') meta.push(h('span', { key: 'error', className: 'gbt-chip', 'data-tone': 'blocked', title: dispatchError }, '⚠ ' + t('dispatchError')))
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
				return h(
					'section',
					{ className: 'gbt-col', 'data-group': props.group.key },
					h(
						'div',
						{ className: 'gbt-colhead' },
						h('span', null, props.group.label),
						h('span', { className: 'gbt-colcount' }, String(props.group.tasks.length)),
					),
					h(
						'div',
						{ className: 'gbt-cards' },
						props.group.tasks.length === 0
							? h('div', { className: 'gbt-empty' }, props.t('noTasks'))
							: props.group.tasks.map(function (task) {
									return h(TaskCard, {
										key: task.id,
										task: task,
										allTasks: props.allTasks,
										t: props.t,
										now: props.now,
										selected: props.selectedId === task.id,
										onOpen: props.onOpen,
									})
								}),
					),
				)
			}

			function Board(props) {
				const tasks = props.snapshot.tasks
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
				const groups = [
					{ key: 'ready', label: props.t('ready'), tasks: ready },
					{ key: 'waiting', label: props.t('waiting'), tasks: waiting },
					{ key: 'running', label: props.t('runningCol'), tasks: tasks.filter(function (task) { return task.status === 'running' }) },
					{ key: 'reviewing', label: props.t('reviewingCol'), tasks: tasks.filter(function (task) { return task.status === 'reviewing' }) },
					{ key: 'testing', label: props.t('testingCol'), tasks: tasks.filter(function (task) { return task.status === 'testing' }) },
					{ key: 'done', label: props.t('doneCol'), tasks: tasks.filter(function (task) { return task.status === 'done' }).slice().sort(recentFirst) },
					{
						key: 'blocked',
						label: props.t('blockedCol'),
						tasks: tasks.filter(function (task) { return task.status === 'blocked' || task.status === 'cancelled' }).slice().sort(recentFirst),
					},
				]
				if (tasks.length === 0) return h('div', { className: 'gbt-empty' }, props.t('emptyBoard'))
				return h(
					'div',
					{ className: 'gbt-board' },
					groups.map(function (group) {
						return h(Column, {
							key: group.key,
							group: group,
							allTasks: tasks,
							t: props.t,
							now: props.now,
							selectedId: props.selectedId,
							onOpen: props.onOpen,
						})
					}),
				)
			}

			function QueueRow(props) {
				const task = props.task
				const deps = Array.isArray(task.dependsOn) ? task.dependsOn : []
				const files = Array.isArray(task.writeFiles) ? task.writeFiles : []
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
							files.length > 0 ? h('span', { className: 'gbt-chip' }, '🔒 ' + files.join(', ')) : null,
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

			/** Waiter chips read "T-3 · title"; a missing title must not invent one. */
			function waiterLabel(waiter) {
				if (waiter === null || waiter === undefined) return ''
				const id = typeof waiter.id === 'string' ? waiter.id : ''
				const title = typeof waiter.title === 'string' ? waiter.title : ''
				if (id === '') return title
				return title === '' ? id : id + ' · ' + title
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

			/** One provisioned role instance: drain and replace in place. */
			function RoleInstanceRow(props) {
				const t = props.t
				return h(
					'tr',
					{ 'data-role-instance': props.name, 'data-kind': props.kind, 'data-status': props.status },
					h('td', { className: 'gbt-mono', 'data-col': 'instance-name' }, props.name),
					h('td', { 'data-col': 'instance-kind' }, roleKindLabel(props.kind, t)),
					h('td', { 'data-col': 'instance-status' }, h('span', { className: 'gbt-pill' }, props.status)),
					h(
						'td',
						null,
						h(
							'div',
							{ className: 'gbt-rowactions' },
							h('button', { type: 'button', className: 'gbt-btn', 'data-action': 'rolesDrain', onClick: function () { props.onDrain(props.name) } }, t('roleDrain')),
							h('button', { type: 'button', className: 'gbt-btn', 'data-action': 'rolesReplace', onClick: function () { props.onReplace(props.name) } }, t('roleReplace')),
						),
					),
				)
			}

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
				return h('div', { className: 'gbt-banner', 'data-tone': 'info', 'data-role-result': 'ok' }, parts.length === 0 ? t('roleSave') + ' ✓' : parts.join(' · '))
			}

			/** One grouped card section with a title row. */
			function roleCard(props) {
				return h(
					'section',
					{ className: 'gbt-rcard', 'data-card': props.id },
					h('div', { className: 'gbt-rhead' }, h('h3', { className: 'gbt-rtitle' }, props.title), props.aside === undefined ? null : props.aside),
					h('div', { className: 'gbt-rbody' }, props.children),
				)
			}

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
				const selectRef = React.useRef(null)
				// Real React reuses a host node across renders, so an uncontrolled control
				// only takes a new defaultValue when it REMOUNTS. The key carries the editor
				// identity AND whether the identity is still a draft: switching kind,
				// forking and a successful save all remount the controls on the right
				// profile instead of silently keeping the previous profile's text (which
				// would then be saved onto the wrong profile).
				const controlKey = kind + ':' + (draft !== null ? String(draft.name) : String(selectedName)) + ':' + (draft !== null ? 'draft' : 'saved')

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
					Promise.resolve(store.send('rolesPreview', body)).then(function (outcome) {
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
				function chosenName() {
					const node = selectRef.current
					if (node !== null && node !== undefined && typeof node.value === 'string' && node.value !== '') return node.value
					return selectedName
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
				/** Switch kind: no draft, no selection, no banner and no preview may leak across. */
				function switchKind(next) {
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
				/** Pick another profile of this kind in the identity selector. */
				function selectProfile(name) {
					if (typeof name !== 'string' || name === '') return
					roleEditorState.selected = name
					roleEditorState.draft = null
					roleEditorState.saved = null
					roleEditorState.applySkipped = false
					roleEditorState.notice = null
					roleEditorState.preview = null
					roleEditorState.previewKey = null
					roleEditorState.previewPending = false
					roleEditorState.previewError = null
					bump()
				}
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
				async function save() {
					// A stale banner must never be read as this attempt's outcome; report() replaces it.
					roleEditorState.notice = null
					const template = currentTemplate()
					const skills = currentSkills()
					if (draft !== null) {
						// T-35 rule: a successful create clears the draft, a refused one keeps
						// it (and the user's edits) for a retry.
						const submitted = draft
						const body = Object.assign({}, submitted.profile, { prompt: template, skills: skills })
						const outcome = await send('rolesCreate', { name: submitted.name, profile: body })
						if (outcome.ok === true && roleEditorState.draft === submitted) {
							// Target the created profile IMMEDIATELY: the panel must not need the
							// next 2.5s poll before Apply can bind it.
							roleEditorState.draft = null
							roleEditorState.selected = submitted.name
							roleEditorState.saved = { name: submitted.name, profile: Object.assign({}, body, { name: submitted.name }) }
							bump()
						}
						return
					}
					if (selectedName === null) return
					if (builtin) {
						// The built-in profiles are the defaults; editing one in place would
						// be lost by the next reset. Fork it instead.
						report('rolesUpdate', false, { code: 'builtin-profile-readonly' })
						return
					}
					const outcome = await send('rolesUpdate', { name: selectedName, profile: { prompt: template, skills: skills } })
					if (outcome.ok === true) {
						// Keep the saved values visible until the host snapshot catches up.
						roleEditorState.saved = { name: selectedName, profile: Object.assign({}, target === null ? {} : target, { prompt: template, skills: skills }) }
						bump()
					}
				}
				async function remove() {
					roleEditorState.notice = null
					if (selectedName === null || builtin) return
					const outcome = await send('rolesDelete', { name: selectedName })
					if (outcome.ok === true) {
						roleEditorState.selected = null
						roleEditorState.saved = null
						bump()
					}
				}
				async function bind() {
					roleEditorState.notice = null
					const chosen = chosenName()
					if (chosen === null) {
						report('rolesBind', false, { code: 'unknown-role-profile' })
						return
					}
					await send('rolesBind', { stage: stage, profile: chosen })
				}
				async function apply() {
					roleEditorState.notice = null
					if (draft !== null) {
						report('rolesBind', false, { code: 'role-unsaved' })
						return
					}
					const chosen = chosenName()
					if (chosen === null) {
						report('rolesBind', false, { code: 'unknown-role-profile' })
						return
					}
					roleEditorState.applySkipped = false
					const boundResult = await send('rolesBind', { stage: stage, profile: chosen })
					if (boundResult.ok !== true) return
					const live = (Array.isArray(props.instances) ? props.instances : []).filter(function (entry) { return entry.kind === kind })
					if (live.length === 0) {
						roleEditorState.applySkipped = true
						bump()
						return
					}
					await send('rolesReplace', { name: kind })
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
					if (group === 'template') return t('rolePreviewGroupTemplate')
					if (group === 'task') return t('rolePreviewGroupTask')
					return t('rolePreviewGroupFixed')
				}
				/** Left column: the profile prompt as written, with its literal {{TOKEN}}s. */
				function rawColumn() {
					// The implement stage is carried per task by each WorkAgent, and a
					// built-in profile is the host default: neither is editable in place.
					const readOnlyReason = kind === 'worker' ? 'worker' : builtin || selectedName === null ? 'builtin' : null
					return h('div', { className: 'gbt-promptcol', 'data-role-prompt': 'raw', 'data-role-raw-readonly': readOnlyReason === null ? 'false' : 'true', 'data-role-raw-reason': readOnlyReason === null ? '' : readOnlyReason },
						h('div', { className: 'gbt-subhead' }, t('rolePreviewRawTitle')),
						readOnlyReason === null
							? h('textarea', { key: 'template-field:' + controlKey, ref: templateRef, className: 'gbt-input gbt-editorarea', 'data-field': 'template', rows: 10, defaultValue: templateText, placeholder: t('rolePromptEmpty'), spellCheck: false })
							: h('div', { className: 'gbt-promptempty', 'data-role-raw-empty': readOnlyReason }, readOnlyReason === 'worker' ? t('rolePreviewWorkerReadonly') : t('rolePreviewBuiltinReadonly')),
						kind === 'worker' ? null : h('p', { className: 'gbt-footnote', 'data-role-tokens': 'true' }, tokenLine()))
				}
				/** Right column: the exact text the host injects, section by section. */
				function injectedColumn() {
					const previewTask = preview !== null && preview.task !== undefined && preview.task !== null ? preview.task : null
					const sample = previewTask !== null && previewTask.sample === true
					const taskValue = typeof roleEditorState.previewTaskId === 'string' ? roleEditorState.previewTaskId : ''
					const sections = preview !== null && Array.isArray(preview.sections) ? preview.sections : []
					return h('div', { className: 'gbt-promptcol', 'data-role-prompt': 'injected' },
						h('div', { className: 'gbt-prompthead' },
							h('div', { className: 'gbt-subhead' }, t('rolePreviewInjectedTitle')),
							previewTask === null
								? null
								: h('span', { className: 'gbt-pill', 'data-role-task-source': sample ? 'sample' : 'real', 'data-task-id': String(previewTask.id) }, sample ? t('rolePreviewSampleTask') : String(previewTask.id) + ' · ' + String(previewTask.title))),
						h('label', { className: 'gbt-editor-select' }, t('rolePreviewTaskPick'),
							h('select', { key: 'preview-task:' + controlKey, className: 'gbt-input', 'data-field': 'preview-task', 'data-task-id': taskValue, defaultValue: taskValue, onChange: function (event) { choosePreviewTask(event !== null && event !== undefined && event.target !== undefined ? event.target.value : '') } },
								h('option', { key: 'auto', value: '' }, t('rolePreviewTaskAuto')),
								previewTasks.map(function (task) {
									return h('option', { key: String(task.id), value: String(task.id) }, String(task.id) + ' · ' + String(task.title))
								}))),
						preview === null
							? h('div', { className: 'gbt-footnote', 'data-role-preview-state': roleEditorState.previewPending === true ? 'loading' : 'unavailable' },
									roleEditorState.previewError !== null && roleEditorState.previewError !== undefined && typeof roleEditorState.previewError.code === 'string'
										? t('rolePreviewFailed') + ' (' + roleEditorState.previewError.code + ')'
										: roleEditorState.previewPending === true
											? t('rolePreviewLoading')
											: t('rolePreviewMissing'))
							: h('div', { className: 'gbt-prompttext', 'data-role-preview-text': 'true' }, sections.map(function (section, index) {
									const key = String(section.key === undefined || section.key === null ? index : section.key)
									const group = String(section.group === undefined || section.group === null ? 'fixed' : section.group)
									return h('div', { key: key + ':' + String(index), className: 'gbt-promptsection', 'data-role-section': key, 'data-role-section-group': group },
										h('span', { className: 'gbt-sectlabel', 'data-role-section-label': group }, sectionGroupLabel(group)),
										h('pre', { className: 'gbt-promptpre' }, typeof section.text === 'string' ? section.text : ''))
								})))
				}
				const prompts = h('div', { className: 'gbt-promptcols', 'data-section': 'role-editor-prompts' }, rawColumn(), injectedColumn())
				const skillsRow = h('div', { className: 'gbt-editorskills', 'data-section': 'role-editor-skills' },
					h('label', { className: 'gbt-editorskills-field' }, t('roleSkills'), h('input', { key: 'skills-field:' + controlKey, ref: skillsRef, className: 'gbt-input', 'data-field': 'skills', defaultValue: skillsText, spellCheck: false })),
					h('button', { type: 'button', className: 'gbt-btn', 'data-action': 'role-editor-skills-manage', onClick: function () { void openSkills() } }, t('roleEditorSkillsManage')))
				const instanceRows = instances.map(function (instance) {
					return h(RoleInstanceRow, {
						key: instance.name,
						name: instance.name,
						kind: instance.kind,
						status: instance.status,
						t: t,
						onDrain: function (name) {
							void send('rolesDrain', { name: name })
						},
						onReplace: function (name) {
							void send('rolesReplace', { name: name })
						},
					})
				})
				const instancesBlock = h(
					'div',
					{ key: 'instances', className: 'gbt-editorinstances', 'data-section': 'role-editor-instances' },
					h('div', { className: 'gbt-subhead' }, t('roleEditorInstances') + ' · ' + roleKindLabel(kind, t)),
					h(
						'div',
						{ className: 'gbt-tablewrap' },
						h(
							'table',
							{ className: 'gbt-locktable', 'data-section': 'role-instances' },
							h('thead', null, h('tr', null, h('th', null, t('roleName')), h('th', null, t('roleKind')), h('th', null, t('roleStatus')), h('th', null, ''))),
							h('tbody', null, instanceRows.length === 0 ? h('tr', null, h('td', { colSpan: 4 }, t('roleInstancesEmpty'))) : instanceRows),
						),
					),
				)
				const blankCreate = h(
					'details',
					{ key: 'blank-create', className: 'gbt-createblank', 'data-section': 'role-create-blank' },
					h('summary', null, t('roleEditorCreateBlank')),
					h(RoleCreateForm, { t: t, onCreate: props.onCreateProfile, onInvalid: props.onCreateInvalid }),
				)
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
				const selectOptions = options.slice()
				if (selectedName !== null && selectOptions.indexOf(String(selectedName)) < 0) selectOptions.push(String(selectedName))
				const selectValue = draft !== null ? draft.name : selectedName === null ? '' : String(selectedName)
				const identityRow = h(
					'div',
					{ className: 'gbt-editor-identity', 'data-editor-identity': 'true', 'data-kind': kind, 'data-profile': selectedName === null ? '' : String(selectedName), 'data-bound': boundName === null ? '' : String(boundName), 'data-draft': draft === null ? 'false' : 'true' },
					h('span', { className: 'gbt-pill' }, t('roleKind') + ' · ' + roleKindLabel(kind, t)),
					h('span', { className: 'gbt-pill gbt-mono', 'data-editor-bound': 'true' }, t('roleEditorBoundProfile') + ' · ' + (boundName === null ? t('roleEditorNoProfile') : String(boundName))),
					h('span', { className: 'gbt-pill' }, draft !== null ? t('roleEditorDraft') : builtin ? t('roleBuiltin') : t('roleCustom')),
					h(
						'label',
						{ className: 'gbt-editor-select' },
						t('roleEditorSelectProfile'),
						h(
							'select',
							{
								key: 'identity-select:' + controlKey,
								ref: selectRef,
								className: 'gbt-input',
								'data-stage-select': stage,
								'data-field': 'profile-select',
								defaultValue: selectValue,
								onChange: function () {
									const node = selectRef.current
									selectProfile(node === null || node === undefined ? '' : node.value)
								},
							},
							selectOptions.length === 0
								? h('option', { key: 'none', value: '' }, t('roleEditorNoProfile'))
								: selectOptions.map(function (name) { return h('option', { key: name, value: name }, name) }),
						),
					),
					h('button', { type: 'button', className: 'gbt-btn', 'data-action': 'rolesBind', onClick: function () { void bind() } }, t('roleBind')),
					builtin || draft !== null || selectedName === null || profiles[selectedName] === undefined
						? null
						: h('button', { type: 'button', className: 'gbt-btn', 'data-action': 'rolesDelete', onClick: function () { void remove() } }, t('roleDelete')),
					h('span', { className: 'gbt-footnote' }, t('roleEditorBindHint')),
				)
				const actions = h(
					'div',
					{ className: 'gbt-rowactions', 'data-section': 'role-editor-actions' },
					h('button', { type: 'button', className: 'gbt-btn', 'data-action': 'role-editor-fork', onClick: fork }, t('roleFork')),
					h('button', { type: 'button', className: 'gbt-btn', 'data-variant': 'primary', 'data-action': 'role-editor-save', onClick: function () { void save() } }, t('roleSave')),
					h('button', { type: 'button', className: 'gbt-btn', 'data-action': 'role-editor-apply', onClick: function () { void apply() } }, t('roleEditorApply')),
					h('button', { type: 'button', className: 'gbt-btn', 'data-action': 'rolesReplace-kind', 'data-kind': kind, onClick: function () { void send('rolesReplace', { name: kind }) } }, t('roleReplaceKind') + ' · ' + roleKindLabel(kind, t)),
					h('button', { type: 'button', className: 'gbt-btn', 'data-action': 'rolesReset', onClick: function () { void send('rolesReset', {}) } }, t('roleReset')),
				)
				return h('div', { className: 'gbt-roleeditor', 'data-editor': 'true', 'data-kind': kind },
					h('p', { className: 'gbt-footnote' }, t('roleEditorHint')),
					roleEditorState.notice === null ? null : roleResultBanner(roleEditorState.notice, t),
					h('div', { className: 'gbt-segmented', role: 'tablist', 'aria-label': t('roleEditorTabsLabel'), 'data-section': 'role-editor-kinds' }, ROLE_EDITOR_KINDS.map(function (entry) {
						return h('button', { key: entry, type: 'button', className: 'gbt-seg', role: 'tab', 'aria-selected': entry === kind ? 'true' : 'false', 'data-action': 'role-editor-kind', 'data-kind': entry, 'data-active': entry === kind ? 'true' : 'false', onClick: function () { switchKind(entry) } }, roleKindLabel(entry, t))
					})),
					identityRow,
					actions,
					roleEditorState.applySkipped === true ? h('div', { className: 'gbt-footnote', 'data-editor-apply-skipped': 'true' }, t('roleEditorApplySkipped')) : null,
					prompts,
					skillsRow,
					instancesBlock,
					blankCreate,
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
				const [result, setResult] = React.useState(null)
				const [, bumpEditor] = React.useReducer(function (count) { return count + 1 }, 0)
				const hostResult = snapshot.actionResult === undefined || snapshot.actionResult === null ? null : { action: snapshot.actionResult.action, ok: snapshot.actionResult.ok !== false, payload: snapshot.actionResult }
				const hostError = snapshot.actionError === undefined || snapshot.actionError === null ? null : { action: 'host', ok: false, payload: snapshot.actionError }
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
				async function run(action, body) {
					const outcome = await store.send(action, body)
					const payload = outcome !== null && outcome !== undefined && outcome.payload !== undefined && outcome.payload !== null ? outcome.payload : null
					setResult({ action: action, ok: outcome !== null && outcome !== undefined && outcome.ok === true, payload: payload })
				}
				async function createProfile(name, fields) {
					const outcome = await store.send('rolesCreate', { name: name, profile: fields })
					const ok = outcome !== null && outcome !== undefined && outcome.ok === true
					const payload = outcome !== null && outcome !== undefined && outcome.payload !== undefined && outcome.payload !== null ? outcome.payload : null
					setResult({ action: 'rolesCreate', ok: ok, payload: payload })
				}
				if (config === null) {
					return h('div', null, h('p', { className: 'gbt-footnote' }, t('rolesHint')), h('div', { className: 'gbt-empty' }, t('rolesUnavailable')))
				}
				const refreshButton = h(
					'button',
					{
						type: 'button',
						className: 'gbt-btn',
						'data-action': 'rolesList',
						onClick: function () {
							void run('rolesList', {})
						},
					},
					t('roleRefresh'),
				)
				return h(
					'div',
					{ className: 'gbt-rolesview' },
					h('p', { key: 'hint', className: 'gbt-footnote' }, t('rolesHint')),
					roleResultBanner(result, t) || roleResultBanner(hostError, t) || roleResultBanner(hostResult, t),
					roleCard({
						id: 'editor',
						title: t('roleEditor'),
						aside: h('div', { className: 'gbt-rheadactions' }, refreshButton),
						children: h(RolesEditor, {
							t: t,
							snapshot: snapshot,
							store: store,
							instances: instances,
							bump: bumpEditor,
							onCreateProfile: function (name, fields) {
								void createProfile(name, fields)
							},
							onCreateInvalid: function (code) {
								setResult({ action: 'rolesCreate', ok: false, payload: { code: code, message: '' } })
							},
						}),
					}),
				)
			}

			function StatusView(props) {
				const t = props.t
				const snapshot = props.snapshot
				const now = props.now
				const blocks = []
				const agents = snapshot.agents
				const worktrees = snapshot.worktrees
				const activity = snapshot.activity
				blocks.push(h('p', { key: 'sessions', className: 'gbt-footnote' }, t('statusSessionHint')))

				blocks.push(h('h3', { key: 'agents-title', className: 'gbt-subtitle' }, t('statusAgents')))
				if (agents === null || agents === undefined) {
					blocks.push(h('div', { key: 'agents-unavailable', className: 'gbt-empty' }, t('statusAgentsUnavailable')))
				} else {
					if (typeof agents.error === 'string' && agents.error !== '') {
						const errorKey = AGENT_ERROR_KEYS[agents.error]
						const explanation = errorKey === undefined ? agents.error : t(errorKey) + ' (' + agents.error + ')'
						blocks.push(h('div', { key: 'agents-error', className: 'gbt-banner', 'data-tone': 'error' }, explanation))
					}
					const lead = agents.lead === null || agents.lead === undefined ? null : agents.lead
					const members = Array.isArray(agents.members) ? agents.members : []
					const rows = []
					if (lead !== null) rows.push(h(AgentRow, { key: 'lead', member: lead, t: t, isLead: true }))
					members.forEach(function (member, index) {
						const name = typeof member.name === 'string' ? member.name : typeof member.id === 'string' ? member.id : String(index)
						rows.push(h(AgentRow, { key: 'm-' + name, member: member, t: t }))
					})
					if (rows.length === 0) {
						blocks.push(h('div', { key: 'agents-empty', className: 'gbt-empty' }, t('workersEmpty')))
					} else {
						blocks.push(
							tableWrap('agents-table', h(
								'table',
								{ key: 'agents-table', className: 'gbt-locktable', 'data-section': 'agents' },
								h('thead', null, h('tr', null, h('th', null, t('roleName')), h('th', null, t('statusKind')), h('th', null, t('statusDescription')), h('th', null, t('statusSession')), h('th', null, t('statusCurrentTask')))),
								h('tbody', null, rows),
							)),
						)
					}
					const kinds = agents.kinds === undefined || agents.kinds === null ? {} : agents.kinds
					const kindKeys = ['lead', 'worker', 'reviewer', 'tester', 'merger']
					blocks.push(
						h(
							'div',
							{ key: 'agent-kinds', className: 'gbt-workermeta', 'data-section': 'agent-kinds' },
							kindKeys.map(function (kind) {
								return h('span', { key: kind, className: 'gbt-count', 'data-kind': kind }, roleKindLabel(kind, t), h('b', null, String(kinds[kind] || 0)))
							}),
						),
					)
					const roleInfo = agents.roles === undefined || agents.roles === null ? null : agents.roles
					if (roleInfo !== null && roleInfo.desired !== undefined && roleInfo.desired !== null) {
						blocks.push(
							h(
								'div',
								{ key: 'role-instances', className: 'gbt-workermeta', 'data-section': 'role-instances' },
								h('span', { className: 'gbt-footnote' }, t('statusRoleInstances')),
								['worker', 'reviewer', 'tester'].map(function (kind) {
									const bound = roleInfo.bound === undefined || roleInfo.bound === null || typeof roleInfo.bound[kind] !== 'string' ? '' : ' (' + roleInfo.bound[kind] + ')'
									return h(
										'span',
										{ key: kind, className: 'gbt-count', 'data-role-kind': kind },
										roleKindLabel(kind, t) +
											' ' +
											String(roleInfo.live === undefined || roleInfo.live === null ? 0 : roleInfo.live[kind] || 0) +
											'/' +
											String(roleInfo.desired[kind] || 0) +
											' ' +
											t('statusMissing') +
											' ' +
											String(roleInfo.missing === undefined || roleInfo.missing === null ? 0 : roleInfo.missing[kind] || 0) +
											bound,
									)
								}),
							),
						)
					}
				}

				blocks.push(h('h3', { key: 'wt-title', className: 'gbt-subtitle' }, t('statusWorktrees')))
				if (worktrees === null || worktrees === undefined || worktrees.available !== true) {
					const error = worktrees === null || worktrees === undefined ? null : worktrees.error
					const message = error === 'no-git-service' ? t('statusNoGit') : error === null || error === undefined || error === '' ? t('statusWorktreesUnavailable') : t('statusWorktreesUnavailable') + ' (' + String(error) + ')'
					blocks.push(h('div', { key: 'wt-unavailable', className: 'gbt-empty' }, message))
				} else {
					const counts = worktrees.counts === undefined || worktrees.counts === null ? {} : worktrees.counts
					const typeKeys = ['main', 'task', 'verify', 'test', 'merge', 'other']
					blocks.push(
						h(
							'div',
							{ key: 'wt-summary', className: 'gbt-workermeta', 'data-section': 'worktrees' },
							h('span', { className: 'gbt-count' }, t('statusCount'), h('b', null, String(worktrees.total || 0))),
							h('span', { className: 'gbt-count' }, t('wtActive'), h('b', null, String(worktrees.active || 0))),
							typeKeys.map(function (type) {
								return h('span', { key: type, className: 'gbt-count', 'data-wt-type': type }, worktreeTypeLabel(type, t), h('b', null, String(counts[type] || 0)))
							}),
						),
					)
					const list = Array.isArray(worktrees.worktrees) ? worktrees.worktrees : []
					if (list.length === 0) {
						blocks.push(h('div', { key: 'wt-empty', className: 'gbt-empty' }, t('statusWorktreesEmpty')))
					} else {
						blocks.push(
							tableWrap('wt-table', h(
								'table',
								{ key: 'wt-table', className: 'gbt-locktable', 'data-section': 'worktrees' },
								h('thead', null, h('tr', null, h('th', null, t('worktree')), h('th', null, t('statusKind')), h('th', null, t('branch')), h('th', null, t('wtHead')), h('th', null, t('wtTask')), h('th', null, t('wtActive')))),
								h(
									'tbody',
									null,
									list.map(function (entry, index) {
										const path = typeof entry.path === 'string' ? entry.path : String(index)
										return h(
											'tr',
											{ key: path, 'data-worktree': path, 'data-type': entry.type, 'data-active': entry.active === true ? 'true' : 'false' },
											h('td', { className: 'gbt-mono', 'data-col': 'worktree-path' }, path),
											h('td', { 'data-col': 'worktree-type' }, worktreeTypeLabel(entry.type, t)),
											h('td', { className: 'gbt-mono', 'data-col': 'worktree-branch' }, typeof entry.branch === 'string' && entry.branch !== '' ? entry.branch : '—'),
											h('td', { className: 'gbt-mono', 'data-col': 'worktree-head' }, typeof entry.head === 'string' && entry.head !== '' ? entry.head.slice(0, 10) : '—'),
											h('td', { 'data-col': 'worktree-task' }, typeof entry.taskId === 'string' ? entry.taskId : '—'),
											h('td', { 'data-col': 'worktree-active' }, entry.active === true ? t('wtActive') : t('wtIdle')),
										)
									}),
								),
							)),
						)
					}
				}

				blocks.push(h('h3', { key: 'activity-title', className: 'gbt-subtitle' }, t('statusActivity')))
				if (activity === null || activity === undefined || activity.available !== true) {
					blocks.push(h('div', { key: 'activity-unavailable', className: 'gbt-empty' }, t('statusActivityUnavailable')))
				} else {
					blocks.push(
						h(
							'div',
							{ key: 'activity-meta', className: 'gbt-workermeta', 'data-section': 'activity' },
							h('span', { className: 'gbt-count' }, t('statusLimit') + ' ' + String(activity.limit === undefined ? 0 : activity.limit)),
							h('span', { className: 'gbt-count' }, t('statusCount') + ' ' + String(activity.count === undefined ? 0 : activity.count)),
						),
					)
					const entries = Array.isArray(activity.entries) ? activity.entries : []
					if (entries.length === 0) {
						blocks.push(h('div', { key: 'activity-empty', className: 'gbt-empty' }, t('statusActivityEmpty')))
					} else {
						blocks.push(
							tableWrap('activity-table', h(
								'table',
								{ key: 'activity-table', className: 'gbt-locktable', 'data-section': 'activity' },
								h('thead', null, h('tr', null, h('th', null, t('submittedOn')), h('th', null, t('statusKind')), h('th', null, t('statusActor')), h('th', null, t('wtTask')), h('th', null, t('statusDescription')))),
								h(
									'tbody',
									null,
									entries.map(function (entry, index) {
										return h(
											'tr',
											{ key: String(index), 'data-activity': String(index), 'data-actor': String(entry.actor) },
											h('td', { 'data-col': 'activity-at' }, typeof entry.at === 'string' ? tcAgo(entry.at, now) : '—'),
											h('td', { className: 'gbt-mono', 'data-col': 'activity-kind' }, String(entry.kind === undefined ? '' : entry.kind)),
											h('td', { 'data-col': 'activity-actor' }, actorLabel(entry, t)),
											h('td', { className: 'gbt-mono', 'data-col': 'activity-task' }, typeof entry.taskId === 'string' ? entry.taskId : '—'),
											h('td', { 'data-col': 'activity-detail' }, typeof entry.detail === 'string' ? entry.detail : ''),
										)
									}),
								),
							)),
						)
					}
				}
				return h('div', { className: 'gbt-statusview' }, blocks)
			}

			function LocksView(props) {
				const locks = props.snapshot.locks
				const hint = h('p', { key: 'hint', className: 'gbt-footnote' }, props.t('locksWaitersHint'))
				if (locks.length === 0) return h('div', null, hint, h('div', { key: 'empty', className: 'gbt-empty' }, props.t('emptyLocks')))
				return h(
					'div',
					null,
					hint,
					h(
						'table',
						{ className: 'gbt-locktable' },
						h(
							'thead',
							null,
							h(
								'tr',
								null,
								h('th', null, props.t('lockPath')),
								h('th', null, props.t('taskCount')),
								h('th', null, props.t('lockHolder')),
								h('th', null, props.t('waiters')),
								h('th', null, props.t('lockLease')),
								h('th', null, ''),
							),
						),
						h(
							'tbody',
							null,
							locks.map(function (lock) {
								const lease = tcLease(lock.leaseUntil, props.now, props.t)
								const waiters = Array.isArray(lock.waiters) ? lock.waiters : []
								return h(
									'tr',
									{ key: lock.path },
									h('td', { className: 'gbt-mono' }, lock.path),
									h('td', null, lock.taskId === null || lock.taskId === undefined ? '—' : lock.taskId + (lock.taskTitle === null || lock.taskTitle === undefined ? '' : ' · ' + lock.taskTitle)),
									h('td', null, lock.agent === null || lock.agent === undefined ? '—' : lock.agent),
									h(
										'td',
										{ 'data-col': 'waiters' },
										waiters.length === 0
											? '—'
											: h(
												'div',
												{ className: 'gbt-waiters' },
												waiters.map(function (waiter, index) {
													return h('span', { key: waiter !== null && waiter !== undefined && waiter.id !== undefined ? String(waiter.id) : String(index), className: 'gbt-chip', 'data-tone': 'waiting' }, waiterLabel(waiter))
												}),
											),
									),
									h('td', { 'data-warn': lease !== null && lease.warn ? 'true' : 'false' }, lease === null ? '—' : lease.text),
									h(
										'td',
										null,
										h(
											'button',
											{
												type: 'button',
												className: 'gbt-btn',
												'data-size': 'sm',
												onClick: function () {
													void store.send('forceUnlock', { paths: [lock.path] })
												},
											},
											props.t('release'),
										),
									),
								)
							}),
						),
					),
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

			function DetailView(props) {
				const task = props.task
				const t = props.t
				const now = props.now
				const snapshot = props.snapshot
				const [deleteError, setDeleteError] = React.useState(null)
				const evidence = React.useRef(null)
				const note = React.useRef(null)
				const allTasks = snapshot.tasks
				const deps = Array.isArray(task.dependsOn) ? task.dependsOn : []
				const files = Array.isArray(task.writeFiles) ? task.writeFiles : []
				const held = snapshot.locks.filter(function (lock) { return lock.taskId === task.id }).map(function (lock) { return lock.path })
				const dispatch = task.dispatch === null || task.dispatch === undefined ? null : task.dispatch
				const merge = tcMergeOf(task)
				const review = tcReviewOf(task)
				const test = tcTestOf(task)

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

				blocks.push(
					h(
						'section',
						{ key: 'meta', className: 'gbt-section' },
						h('h3', null, t('status')),
						h(
							'dl',
							{ className: 'gbt-meta' },
							h('dt', null, t('priority')),
							h('dd', null, String(task.priority)),
							h('dt', null, t('assignee')),
							h('dd', null, task.assignee !== null && task.assignee !== undefined ? task.assignee.name : '—'),
							h('dt', null, t('attempts')),
							h('dd', null, String(task.attempts) + ' / ' + String(task.maxAttempts)),
							h('dt', null, t('created')),
							h('dd', null, tcAgo(task.createdAt, now)),
							h('dt', null, t('updated')),
							h('dd', null, tcAgo(task.updatedAt, now)),
						),
					),
				)

				// The phase machine is the spine of a task: its review and test
				// rounds decide whether the host may merge. The panel only renders
				// the records the Host returned; it never derives a verdict.
				blocks.push(
					h(
						'section',
						{ key: 'phase', className: 'gbt-section' },
						h('h3', null, t('phaseTitle')),
						h(
							'dl',
							{ className: 'gbt-meta' },
							h('dt', null, t('phaseCurrent')),
							h('dd', null, h('span', { className: 'gbt-pill', 'data-status': task.status }, tcPhaseLabel(task, t))),
							h('dt', null, t('requiredRole')),
							h('dd', null, typeof task.requiredRole === 'string' && task.requiredRole !== '' ? task.requiredRole : '—'),
							h('dt', null, t('phaseAttempts')),
							h('dd', null, String(task.attempts) + ' / ' + String(task.maxAttempts)),
						),
						h(
							'div',
							{ className: 'gbt-outputblock' },
							h('div', { className: 'gbt-subhead' }, t('review')),
							review === null
								? h('p', { className: 'gbt-footnote' }, t('noReview'))
								: h(
										'div',
										null,
										h(
											'dl',
											{ className: 'gbt-meta' },
											h('dt', null, t('reviewStatus')),
											h('dd', null, h('span', { className: 'gbt-pill', 'data-status': review.status }, tcReviewLabel(review.status, t))),
											h('dt', null, review.status === 'pending' ? t('submitter') : t('reviewer')),
											h('dd', null, typeof review.by === 'string' && review.by !== '' ? review.by : '—'),
											h('dt', null, t('reviewAttempt')),
											h('dd', null, String(tcRound(review))),
											h('dt', null, t('phaseAt')),
											h('dd', null, tcAgo(review.at, now)),
										),
										h('p', { className: 'gbt-footnote' }, t('reviewHint')),
										review.reasons === null || review.reasons === undefined || review.reasons === ''
											? null
											: outputBlock('review-reasons', t('reviewReasons'), review.reasons, t),
									),
						),
						h(
							'div',
							{ className: 'gbt-outputblock' },
							h('div', { className: 'gbt-subhead' }, t('test')),
							test === null
								? h('p', { className: 'gbt-footnote' }, t('noTest'))
								: h(
										'div',
										null,
										h(
											'dl',
											{ className: 'gbt-meta' },
											h('dt', null, t('testStatus')),
											h('dd', null, h('span', { className: 'gbt-pill', 'data-status': test.status }, tcTestLabel(test.status, t))),
											h('dt', null, t('tester')),
											h('dd', null, typeof test.by === 'string' && test.by !== '' ? test.by : '—'),
											h('dt', null, t('testAttempt')),
											h('dd', null, String(tcRound(test))),
											h('dt', null, t('phaseAt')),
											h('dd', null, tcAgo(test.at, now)),
											h('dt', null, t('testCandidate')),
											h('dd', null, typeof task.worktree === 'string' && task.worktree !== '' ? task.worktree : '—'),
										),
										h('p', { className: 'gbt-footnote' }, t('testHint')),
										outputBlock('test-evidence', t('testEvidence'), typeof test.evidence === 'string' ? test.evidence : '', t),
									),
						),
					),
				)

				if (task.status === 'running') {
					blocks.push(
						h(
							'section',
							{ key: 'work', className: 'gbt-section' },
							h('h3', null, t('evidence')),
							h('textarea', { className: 'gbt-area', ref: evidence, placeholder: t('evidence') }),
							h(
								'div',
								{ className: 'gbt-actions', style: { marginTop: '6px' } },
								h('button', { type: 'button', className: 'gbt-btn', 'data-variant': 'primary', onClick: submitWork }, t('submit')),
							),
						),
					)
				}

				blocks.push(
					h(
						'section',
						{ key: 'spec', className: 'gbt-section' },
						h('h3', null, t('spec')),
						h('p', { className: 'gbt-prose' }, task.spec === '' ? t('noSpec') : task.spec),
					),
				)
				blocks.push(
					h(
						'section',
						{ key: 'acceptance', className: 'gbt-section' },
						h('h3', null, t('acceptance')),
						h('p', { className: 'gbt-prose' }, task.acceptance === '' ? t('noSpec') : task.acceptance),
					),
				)
				blocks.push(
					h(
						'section',
						{ key: 'evidence-view', className: 'gbt-section' },
						h('h3', null, t('evidence')),
						h('p', { className: 'gbt-prose' }, task.evidence === '' ? t('noEvidence') : task.evidence),
					),
				)

				blocks.push(
					h(
						'section',
						{ key: 'deps', className: 'gbt-section' },
						h('h3', null, t('dependencies')),
						deps.length === 0
							? h('p', { className: 'gbt-prose' }, t('noDeps'))
							: h(
									'div',
									{ className: 'gbt-cardmeta' },
									deps.map(function (id) {
										const dependency = allTasks.filter(function (entry) { return entry.id === id })[0]
										const tone = toneForDependency(allTasks, id)
										const label = dependency === undefined ? id + ' · ' + t('depBroken') : id + ' · ' + t(tcStatusKey(dependency.status))
										return h('span', { key: id, className: 'gbt-chip', 'data-tone': tone }, label)
									}),
								),
					),
				)

				blocks.push(
					h(
						'section',
						{ key: 'files', className: 'gbt-section' },
						h('h3', null, t('files')),
						files.length === 0
							? h('p', { className: 'gbt-prose' }, t('noFiles'))
							: h(
									'div',
									{ className: 'gbt-cardmeta' },
									files.map(function (path) {
										const locked = held.indexOf(path) >= 0
										return h('span', { key: path, className: 'gbt-chip', 'data-tone': locked ? 'running' : 'waiting' }, (locked ? '🔒 ' : '') + path)
									}),
								),
					),
				)

				const checkoutParts = [
					typeof task.worktree === 'string' ? task.worktree : '',
					typeof task.branch === 'string' ? task.branch : '',
					typeof task.commit === 'string' ? task.commit : '',
				]
				if (checkoutParts.some(function (value) { return value !== '' })) {
					blocks.push(
						h(
							'section',
							{ key: 'checkout', className: 'gbt-section' },
							h('h3', null, t('checkoutTitle')),
							h(
								'dl',
								{ className: 'gbt-meta' },
								h('dt', null, t('worktree')),
								h('dd', null, checkoutParts[0] === '' ? '—' : checkoutParts[0]),
								h('dt', null, t('branch')),
								h('dd', null, checkoutParts[1] === '' ? '—' : checkoutParts[1]),
								h('dt', null, t('commit')),
								h('dd', null, checkoutParts[2] === '' ? '—' : checkoutParts[2]),
							),
						),
					)
				}

				if (merge !== null) {
					const rows = [
						h('dt', { key: 'ms-l' }, t('mergeStatus')),
						h('dd', { key: 'ms-v' }, h('span', { className: 'gbt-pill', 'data-status': tcMergeTone(merge.status) }, tcMergeLabel(merge.status, t))),
					]
					if (typeof merge.target === 'string' && merge.target !== '') {
						rows.push(h('dt', { key: 'tg-l' }, t('mergeTarget')), h('dd', { key: 'tg-v' }, merge.target))
					}
					if (merge.conflict !== null && merge.conflict !== undefined) {
						rows.push(h('dt', { key: 'cf-l' }, t('conflictDetail')), h('dd', { key: 'cf-v' }, String(merge.conflict)))
					}
					blocks.push(
						h(
							'section',
							{ key: 'merge', className: 'gbt-section' },
							h('h3', null, t('mergeTitle')),
							h('dl', { className: 'gbt-meta' }, rows),
							typeof merge.output === 'string' && merge.output !== ''
								? outputBlock('merge-out', t('verificationOutput'), merge.output, t)
								: null,
						),
					)
				}

				if (dispatch !== null) {
					blocks.push(
						h(
							'section',
							{ key: 'dispatch', className: 'gbt-section' },
							h('h3', null, t('dispatch')),
							h(
								'dl',
								{ className: 'gbt-meta' },
								h('dt', null, t('status')),
								h('dd', null, String(dispatch.status === null || dispatch.status === undefined ? '—' : dispatch.status)),
								h('dt', null, t('assignee')),
								h('dd', null, String(dispatch.target === null || dispatch.target === undefined ? '—' : dispatch.target)),
								h('dt', null, t('attempts')),
								h('dd', null, String(task.attempts)),
								dispatch.error === null || dispatch.error === undefined
									? null
									: h('dt', { key: 'error-label' }, t('dispatchError')),
								dispatch.error === null || dispatch.error === undefined ? null : h('dd', { key: 'error-value' }, String(dispatch.error)),
							),
						),
					)
				}

				const history = Array.isArray(task.history) ? task.history.slice().reverse() : []
				blocks.push(
					h(
						'section',
						{ key: 'history', className: 'gbt-section' },
						h('h3', null, t('history')),
						history.length === 0
							? h('p', { className: 'gbt-prose' }, t('emptyHistory'))
							: h(
									'div',
									{ className: 'gbt-timeline' },
									history.map(function (entry, index) {
										const move = (entry.from === null ? '·' : entry.from) + ' → ' + (entry.to === null ? '·' : entry.to)
										return h(
											'div',
											{ key: String(index), className: 'gbt-event' },
											h('span', { className: 'gbt-mono' }, tcAgo(entry.at, now)),
											' ',
											h('b', null, entry.by),
											' ',
											h('span', null, move),
											entry.note === '' ? null : h('div', null, entry.note),
										)
									}),
								),
					),
				)

				blocks.push(h('input', { key: 'note', className: 'gbt-input', ref: note, placeholder: t('notePlaceholder') }))
				return h(
					'aside',
					{ className: 'gbt-drawer', 'data-open': 'true' },
					h(
						'div',
						{ className: 'gbt-drawerhead' },
						h(
							'div',
							null,
							h('div', { className: 'gbt-cardmeta' }, h('span', { className: 'gbt-id' }, task.id), h('span', { className: 'gbt-pill', 'data-status': task.status }, t(tcStatusKey(task.status))), waitingChip(task, t, 'waiting')),
							h('h2', { className: 'gbt-drawertitle' }, task.title),
						),
						h('button', { type: 'button', className: 'gbt-iconbtn', onClick: props.onClose, 'aria-label': t('close') }, '×'),
					),
					h('div', { className: 'gbt-drawerbody' }, blocks),
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
						setError(String(payload.message === undefined ? (result.error && result.error.message) || t('error') : payload.message))
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
				const [error, setError] = React.useState('')
				function save() {
					const raw = concurrent.current === null ? dispatch.maxConcurrent : concurrent.current.value
					const value = Number(raw)
					if (!Number.isFinite(value) || value < 1 || value > 8 || Math.floor(value) !== value) {
						setError(t('invalidConcurrency'))
						return
					}
					void store.send('settings', { maxConcurrent: value }).then(function (result) {
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
				function open() {
					const value = input.current === null ? '' : String(input.current.value || '').trim()
					if (value === '') {
						setError(t('projectRequired'))
						return
					}
					void store.send('openProject', { path: value }).then(function (result) {
						if (result.ok === true) {
							props.onClose()
							return
						}
						const payload = result.payload === undefined || result.payload === null ? {} : result.payload
						setError(String(payload.message || t('error')))
					})
				}
				return h(
					Modal,
					{ title: t('project'), onClose: props.onClose, t: t },
					h(
						'div',
						{ className: 'gbt-form' },
						h('div', { className: 'gbt-field' }, h('label', null, t('project')), h('input', { className: 'gbt-input', ref: input, placeholder: t('projectPlaceholder'), defaultValue: props.project || '' })),
						error === '' ? null : h('p', { className: 'gbt-footnote' }, error),
						h('div', { className: 'gbt-actions' },
							h('button', { type: 'button', className: 'gbt-btn', 'data-variant': 'primary', onClick: open }, t('openProject')),
							h('button', { type: 'button', className: 'gbt-btn', onClick: props.onClose }, t('cancel'))),
					),
				)
			}

			// The main slot unmounts when the user switches to the chat panel. React
			// state alone therefore resets to the board on return; this object lives in
			// the views closure (one per plugin activation) and carries the view and
			// selected task across that remount. Modals are deliberately not here.
			const panelState = { view: 'board', selectedId: null }

			function TaskCenter(props) {
				const t = useTranslate()
				const snapshot = useSnapshot()
				const now = useNow(5000)
				// Rendering tests may pick the first view; the production slot passes no props.
				const initialView = props !== undefined && props !== null && ['board', 'queue', 'workers', 'locks', 'status', 'roles'].indexOf(props.initialView) >= 0 ? props.initialView : panelState.view
				const [view, setViewState] = React.useState(initialView)
				const [selectedId, setSelectedIdState] = React.useState(panelState.selectedId)
				const [editing, setEditing] = React.useState(null)
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
				const [projectOpen, setProjectOpen] = React.useState(false)

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
				const editingTask = editing === null ? null : editing === 'new' ? null : tasks.filter(function (task) { return task.id === editing })[0] || null
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
				}
				function closeDetail() {
					setSelectedId(null)
				}
				function startEdit(task) {
					setEditing(task === null || task === undefined ? 'new' : task.id)
				}
				function toggleDispatch() {
					void store.send(active ? 'pause' : 'start')
				}

				const tabs = [
					{ key: 'board', label: t('boardTab'), count: tasks.length },
					{ key: 'queue', label: t('queue'), count: queue.length },
					{ key: 'workers', label: t('workersTab'), count: workerMembers === null ? undefined : workerMembers.length },
					{ key: 'locks', label: t('locks'), count: snapshot.locks.length },
					{ key: 'status', label: t('statusTab'), count: snapshot.agents !== null && snapshot.agents !== undefined && Array.isArray(snapshot.agents.members) ? snapshot.agents.members.length + (snapshot.agents.lead === null || snapshot.agents.lead === undefined ? 0 : 1) : undefined },
					{ key: 'roles', label: t('rolesTab'), count: snapshot.roles !== null && snapshot.roles !== undefined && snapshot.roles.profiles !== null && snapshot.roles.profiles !== undefined ? Object.keys(snapshot.roles.profiles).length : undefined },
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
							h('h1', { className: 'gbt-title' }, t('title')),
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
							: h('button', { type: 'button', className: 'gbt-btn', onClick: function () { setProjectOpen(true) } }, '⌂ ' + t('project')),
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
						? h(Board, { snapshot: snapshot, t: t, now: now, selectedId: selectedId, onOpen: openTask })
						: view === 'queue'
							? h(QueueView, { snapshot: snapshot, t: t, onOpen: openTask })
							: view === 'workers'
								? h(WorkersView, { snapshot: snapshot, t: t })
								: view === 'status'
									? h(StatusView, { snapshot: snapshot, t: t, now: now })
									: view === 'roles'
										? h(RolesView, { snapshot: snapshot, t: t, store: store })
										: h(LocksView, { snapshot: snapshot, t: t, now: now })

				const tabsView = h(
					'div',
					{ className: 'gbt-tabs' },
					tabs.map(function (tab) {
						return h(
							'button',
							{ key: tab.key, type: 'button', className: 'gbt-tab', 'data-active': view === tab.key ? 'true' : 'false', onClick: function () { setView(tab.key) } },
							tab.label + (tab.count === undefined ? '' : ' · ' + String(tab.count)),
						)
					}),
					snapshot.project === null || snapshot.project === undefined
						? h('button', { type: 'button', className: 'gbt-tab', onClick: function () { setProjectOpen(true) } }, '+ ' + t('openProject'))
						: null,
				)

				return h(
					'div',
					{ className: 'gbt-root' },
					header,
					statusline,
					busyBar,
					banner,
					requestBanner,
					snapshot.project === null || snapshot.project === undefined
						? h(
								'div',
								{ className: 'gbt-view' },
								h('p', { className: 'gbt-footnote' }, t('unknownProjectHint')),
								h(ProjectForm, { t: t, project: snapshot.project, onClose: function () { setProjectOpen(false) } }),
							)
						: null,
					snapshot.project === null || snapshot.project === undefined
						? null
						: h(
								'div',
								{ className: 'gbt-main' },
								h('div', { className: 'gbt-content' }, tabsView, h('div', { className: 'gbt-view' }, content)),
								selected === null ? null : h(DetailView, {
									task: selected,
									snapshot: snapshot,
									t: t,
									now: now,
									onClose: closeDetail,
									onEdit: startEdit,
								}),
							),
					editing === null ? null : h(TaskForm, {
						task: editingTask,
						snapshot: snapshot,
						t: t,
						onClose: function () { setEditing(null) },
						onSaved: function () { setEditing(null) },
					}),
					settingsOpen ? h(SettingsForm, { t: t, dispatch: dispatch, onClose: function () { setSettingsOpen(false) } }) : null,
					projectOpen ? h(ProjectForm, { t: t, project: snapshot.project, onClose: function () { setProjectOpen(false) } }) : null,
				)
			}

			function Glyph(props) {
				const size = typeof props.size === 'number' ? props.size : 18
				const active = props.active === true
				return h(
					'svg',
					{ className: 'gbt-glyph', width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
					h('rect', { x: 1.5, y: 2, width: 13, height: 12, rx: 2.4, stroke: 'currentColor', strokeWidth: active ? 1.6 : 1.3 }),
					h('path', { d: 'M5.6 4.6v6.8M10.4 4.6v6.8', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round' }),
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
					const store = createTaskStore()
					const views = createTaskCenterViews(ctx, store)
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
