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
				runningCol: '进行中',
				doneCol: '完成',
				closedCol: '阻塞 / 取消',
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
				rejectStart: '拒绝',
				settingsTitle: '派发设置',
				maxConcurrent: '最大并发',
				concurrencyHint: '1–8。执行者上限自动设为并发 + 1；没有空闲执行者时会自动新建；连续失败 3 次后任务阻塞。',
				invalidConcurrency: '并发必须是 1–8 的整数',
				apply: '应用',
				leaseLeft: '剩余',
				leaseExpired: '已过期',
				noProject: '未选择项目',
				openProject: '打开项目',
				projectPlaceholder: '项目目录的绝对路径',
				projectRequired: '请填写项目目录',
				titleRequired: '标题不能为空',
				loading: '加载中…',
				statusPending: '等待',
				statusRunning: '进行中',
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
				runningCol: 'Running',
				doneCol: 'Done',
				closedCol: 'Blocked / cancelled',
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
				rejectStart: 'Reject',
				settingsTitle: 'Dispatch settings',
				maxConcurrent: 'Maximum concurrency',
				concurrencyHint: '1–8. The worker cap becomes concurrency + 1; a worker is spawned when none is idle; a task blocks after 3 consecutive failures.',
				invalidConcurrency: 'Concurrency must be an integer from 1 to 8',
				apply: 'Apply',
				leaseLeft: 'left',
				leaseExpired: 'expired',
				noProject: 'No project',
				openProject: 'Open project',
				projectPlaceholder: 'Absolute path to the project directory',
				projectRequired: 'A project directory is required',
				titleRequired: 'A title is required',
				loading: 'Loading…',
				statusPending: 'Pending',
				statusRunning: 'Running',
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
			'.gbt-col{flex:1 1 0;min-width:196px;max-width:330px;background:var(--dsw-alias-bg-layer-3);border:0.5px solid var(--dsw-alias-border-l4);border-radius:12px;display:flex;flex-direction:column;max-height:100%;min-height:120px}',
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
			'.gbt-pill[data-status="done"]{background:rgba(47,179,68,.14);color:#2f9e44}',
			'.gbt-pill[data-status="blocked"]{background:rgba(229,72,77,.14);color:#d33}',
			'.gbt-pill[data-status="cancelled"]{background:var(--dsw-alias-bg-layer-4);color:var(--dsw-alias-label-tertiary)}',
			'.gbt-pill[data-status="inactive"]{background:var(--dsw-alias-bg-layer-4);color:var(--dsw-alias-label-tertiary)}',
			'.gbt-pill[data-status="provisioning"]{background:rgba(245,159,0,.14);color:#b7791f}',
			'.gbt-pill[data-status="failed"]{background:rgba(229,72,77,.14);color:#d33}',
			'.gbt-iconbtn{appearance:none;border:none;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;font-size:16px;line-height:1;padding:2px 5px;border-radius:6px}',
			'.gbt-iconbtn:hover{background:var(--dsw-alias-bg-layer-4);color:var(--dsw-alias-label-primary)}',
			'.gbt-projectform{display:flex;gap:6px;align-items:center;margin-top:10px;flex-wrap:wrap}',
			'.gbt-projectform .gbt-input{flex:1;min-width:220px}',
			'.gbt-busy{opacity:.6;pointer-events:none}',
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

		function tcLease(value, now, t) {
			const at = tcTime(value)
			if (at === null) return null
			const remaining = at - now
			if (remaining <= 0) return { text: t('leaseExpired'), warn: true }
			const minutes = Math.max(0, Math.ceil(remaining / 60000))
			const text = minutes < 60 ? String(minutes) + 'm' : String(Math.round(minutes / 60)) + 'h'
			return { text: t('leaseLeft') + ' ' + text, warn: minutes <= 3 }
		}

		function tcStatusKey(status) {
			return 'status' + status.charAt(0).toUpperCase() + status.slice(1)
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
		function tcSnapshot(payload, source, message) {
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
				scheduler: payload.scheduler === undefined ? null : payload.scheduler,
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

			function emit(next) {
				snapshot = next
				listeners.forEach(function (listener) {
					listener()
				})
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
							emit(tcSnapshot(payload, 'host', ''))
						} else {
							emit(tcSnapshot(Object.assign({}, payload, { tasks: [] }), 'error', String((payload && payload.message) || 'the host did not answer')))
						}
					} catch (error) {
						emit(tcSnapshot(Object.assign({}, snapshot, { tasks: [] }), 'error', String((error && error.message) || error)))
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
				try {
					const payload = await fetchJson(TC_ACTION_URL, {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify(payloadBody),
					})
					if (payload && payload.ok === true) {
						const host = payload.snapshot !== undefined && payload.snapshot !== null ? payload.snapshot : payload
						if (host && Array.isArray(host.tasks)) emit(tcSnapshot(host, 'host', ''))
						if (host && typeof host.project === 'string') tcRememberProject(host.project)
						return { ok: true, payload: payload }
					}
					emit(Object.assign({}, snapshot, { message: String((payload && payload.message) || 'the host refused that action') }))
					return { ok: false, payload: payload }
				} catch (error) {
					emit(Object.assign({}, snapshot, { message: String((error && error.message) || error) }))
					return { ok: false, error: error }
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
				const lease = task.status === 'running' ? tcLease(task.leaseUntil, now, t) : null
				const deps = Array.isArray(task.dependsOn) ? task.dependsOn : []
				const files = Array.isArray(task.writeFiles) ? task.writeFiles : []
				const dispatchError = task.dispatch !== null && task.dispatch !== undefined ? task.dispatch.error : null
				const children = []
				const top = [h('span', { key: 'id', className: 'gbt-id' }, task.id)]
				if (task.priority !== 0) top.push(h('span', { key: 'prio', className: 'gbt-chip', 'data-tone': 'running' }, 'P' + String(task.priority)))
				if (task.status === 'blocked') top.push(h('span', { key: 'blocked', className: 'gbt-chip', 'data-tone': 'blocked' }, t('statusBlocked')))
				children.push(h('div', { key: 'top', className: 'gbt-cardtop' }, top))
				children.push(h('div', { key: 'title', className: 'gbt-cardtitle' }, task.title))
				const meta = []
				if (task.assignee !== null && task.assignee !== undefined) meta.push(h('span', { key: 'who', className: 'gbt-chip', 'data-tone': 'running' }, task.assignee.name))
				if (task.attempts > 0) meta.push(h('span', { key: 'attempts', className: 'gbt-chip' }, '↻ ' + String(task.attempts) + '/' + String(task.maxAttempts)))
				if (lease !== null) meta.push(h('span', { key: 'lease', className: 'gbt-chip', 'data-tone': lease.warn ? 'blocked' : 'waiting' }, lease.text))
				if (files.length > 0) meta.push(h('span', { key: 'files', className: 'gbt-chip' }, '🔒 ' + String(files.length)))
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
				const ready = tasks.filter(function (task) { return task.status === 'pending' && task.dependency !== undefined && task.dependency.state === 'ready' })
				const waiting = tasks.filter(function (task) { return task.status === 'pending' && (task.dependency === undefined || task.dependency.state !== 'ready') })
				const groups = [
					{ key: 'ready', label: props.t('ready'), tasks: ready },
					{ key: 'waiting', label: props.t('waiting'), tasks: waiting },
					{ key: 'running', label: props.t('runningCol'), tasks: tasks.filter(function (task) { return task.status === 'running' }) },
					{ key: 'done', label: props.t('doneCol'), tasks: tasks.filter(function (task) { return task.status === 'done' }) },
					{
						key: 'closed',
						label: props.t('closedCol'),
						tasks: tasks.filter(function (task) { return task.status === 'blocked' || task.status === 'cancelled' }),
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
				const initialView = props !== undefined && props !== null && ['board', 'queue', 'workers', 'locks'].indexOf(props.initialView) >= 0 ? props.initialView : panelState.view
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
				const [settingsOpen, setSettingsOpen] = React.useState(false)
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
						h('span', { className: 'gbt-count' }, t('runningCol'), h('b', null, String(counts.running || 0))),
						h('span', { className: 'gbt-count' }, t('waiting'), h('b', null, String(Math.max(0, (counts.pending || 0) - (counts.ready || 0))))),
						h('span', { className: 'gbt-count' }, t('statusBlocked'), h('b', null, String(counts.blocked || 0))),
						h('span', { className: 'gbt-count' }, t('doneCol'), h('b', null, String(counts.done || 0))),
					),
					h(
						'div',
						{ className: 'gbt-controls' },
						h('button', { type: 'button', className: 'gbt-btn', 'data-variant': active ? undefined : 'primary', onClick: toggleDispatch, disabled: snapshot.source === 'error' || snapshot.project === null }, active ? '⏸ ' + t('pause') : '▶ ' + t('start')),
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
										},
										t('approveStart'),
									),
									h(
										'button',
										{
											type: 'button',
											className: 'gbt-btn',
											onClick: function () { void store.send('rejectStart', { requestId: startRequest.id }) },
										},
										t('rejectStart'),
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
