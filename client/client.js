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
		 * TASK CENTER - interactive UI prototype, backed by a MOCK store.
		 *
		 * Scope of this prototype: prove the rendering surface and settle the
		 * interaction design. Everything below reads and writes through one
		 * `createTaskStore()` seam whose interface is the one the real Host
		 * service will expose (list / get / create / publish / claim /
		 * complete / ...). Replacing the mock store's implementation with
		 * `fetch()` calls against a Host route is therefore the whole of the
		 * later migration; the views do not change.
		 *
		 * Nothing here is persisted and nothing reaches the Host: no board
		 * file, no tool, no prompt section. See the task-center design notes
		 * for the real data model (per-project board file + FsVersion CAS).
		 *
		 * Surface: `sidebar.panellist` supplies only the glyph inside the
		 * host's own button (props `{ size, active }`); `main` is a keyed slot
		 * dispatched by the active panel id, so this panel occupies the centre
		 * column like the shipped pages do. Removal is this region plus its
		 * three registrations in `apply`.
		 * ================================================================== */

		/** Locale namespace of the prototype's copy. */
		const TC_NS = 'godotBridgeTaskCenter'

		/** Simplified Chinese and English copy for the panel. */
		const TC_DICT = {
			en: {
				nav: 'Tasks',
				tabList: 'Board',
				tabQueue: 'Queue',
				tabArchive: 'Archive',
				newTask: 'New task',
				reset: 'Reset demo data',
				simulate: 'Simulate agent activity',
				statQueued: 'queued',
				statActive: 'in progress',
				statBlocked: 'blocked',
				statReview: 'to review',
				statDone: 'done',
				groupDraft: 'Drafts',
				groupQueued: 'Queue',
				groupActive: 'In progress',
				groupBlocked: 'Blocked',
				groupReview: 'To review',
				groupDone: 'Closed',
				statusDraft: 'draft',
				statusQueued: 'queued',
				statusClaimed: 'claimed',
				statusInProgress: 'in progress',
				statusReview: 'to review',
				statusBlocked: 'blocked',
				statusDone: 'done',
				statusCancelled: 'cancelled',
				dependsOn: 'waits for',
				lease: 'lease',
				leaseExpired: 'lease expired',
				unassigned: 'unassigned',
				queueDrafts: 'Drafts waiting for release',
				queueDraftsHint: 'An agent can only file a draft. Releasing it into the queue is yours to do.',
				queueQueued: 'Queue',
				queueEmpty: 'The queue is empty. Release a draft to put work in front of the agents.',
				selectAll: 'Select all',
				releaseSelected: 'Release to queue',
				moveUp: 'Move up',
				moveDown: 'Move down',
				pinTop: 'Move to top',
				back: 'Back to board',
				spec: 'Spec',
				acceptance: 'Acceptance',
				evidence: 'Evidence',
				depends: 'Depends on',
				owner: 'Owner',
				plan: 'Plan doc',
				history: 'History',
				createdAt: 'Created',
				updatedAt: 'Updated',
				openSession: 'Open session',
				openSessionHint: 'Becomes active once the Host half supplies the session target',
				reclaim: 'Reclaim',
				noSpec: 'No spec yet.',
				blockedByHint: 'Blocked until these finish:',
				publish: 'Release to queue',
				unpublish: 'Return to draft',
				claim: 'Claim',
				block: 'Mark blocked',
				unblock: 'Clear block',
				complete: 'Send to review',
				release: 'Release',
				reopen: 'Reopen',
				edit: 'Edit',
				remove: 'Delete',
				approve: 'Approve',
				sendBack: 'Send back',
				formNew: 'New task',
				formEdit: 'Edit task',
				formTitle: 'Title',
				formSpec: 'Spec',
				formAcceptance: 'Acceptance criteria',
				formPlan: 'Plan document',
				formDepends: 'Depends on',
				formDependsHint: 'Comma-separated task ids, e.g. T-06, T-09.',
				formSave: 'Save',
				formCancel: 'Cancel',
				formRequired: 'A title is required.',
				emptyTitle: 'No tasks in this workspace',
				emptyBody: 'The board is a file inside your project. This prototype keeps everything in memory instead.',
				tabFiles: 'Files',
				locks: 'File locks',
				locksHint:
					'A lock is a protocol between agents, not a kernel lock: an agent takes one before writing a file and releases it when it is done. Reading never needs one, but an agent can always see who is writing.',
				locksNone: 'This agent holds no file and is not queued for one.',
				locksPageHint:
					'Held files first, with whoever is queued behind them. On release the longest-waiting reservation takes the file (marked ①).',
				lockFree: 'free',
				lockWaited: 'waited',
				lockNext: '(next)',
				lockRelease: 'Release',
				lockForce: 'Reclaim',
				lockForceHint: 'Drop the holder without waiting for it, then let the queue resolve',
				lockSimTake: 'Simulate an agent taking it',
				lockTook: 'lock taken by',
				lockReserved: 'queued for the lock by',
				lockGranted: 'lock granted to',
				lockFreed: 'lock released on',
				simClaimed: 'Simulated agent claimed',
				simLease: 'Simulated lease running out on',
				simIdle: 'Nothing for a simulated agent to pick up.',
				lastEvent: 'Last simulated event',
				prototype: 'Interactive prototype - mock data, nothing is persisted.',
			},
			zh: {
				nav: '任务',
				tabList: '看板',
				tabQueue: '队列',
				tabArchive: '归档',
				newTask: '新建任务',
				reset: '重置演示数据',
				simulate: '模拟 agent 活动',
				statQueued: '队列',
				statActive: '进行中',
				statBlocked: '阻塞',
				statReview: '待验收',
				statDone: '已完成',
				groupDraft: '草稿',
				groupQueued: '队列',
				groupActive: '进行中',
				groupBlocked: '阻塞',
				groupReview: '待验收',
				groupDone: '已关闭',
				statusDraft: '草稿',
				statusQueued: '队列中',
				statusClaimed: '已领取',
				statusInProgress: '进行中',
				statusReview: '待验收',
				statusBlocked: '阻塞',
				statusDone: '已完成',
				statusCancelled: '已取消',
				dependsOn: '等待',
				lease: '租约',
				leaseExpired: '租约已过期',
				unassigned: '未指派',
				queueDrafts: '待发布的草稿',
				queueDraftsHint: 'agent 只能提交草稿；把它放进队列由你决定。',
				queueQueued: '队列',
				queueEmpty: '队列为空。发布一份草稿，把工作推到 agent 面前。',
				selectAll: '全选',
				releaseSelected: '发布到队列',
				moveUp: '上移',
				moveDown: '下移',
				pinTop: '置顶',
				back: '返回看板',
				spec: '说明',
				acceptance: '验收标准',
				evidence: '证据',
				depends: '依赖',
				owner: '归属',
				plan: '计划文档',
				history: '历史',
				createdAt: '创建于',
				updatedAt: '更新于',
				openSession: '查看会话',
				openSessionHint: '接入宿主半后生效',
				reclaim: '回收',
				noSpec: '暂无说明。',
				blockedByHint: '在这些任务完成前保持阻塞：',
				publish: '发布到队列',
				unpublish: '退回草稿',
				claim: '领取',
				block: '标记阻塞',
				unblock: '解除阻塞',
				complete: '提交验收',
				release: '释放',
				reopen: '重新打开',
				edit: '编辑',
				remove: '删除',
				approve: '验收通过',
				sendBack: '打回',
				formNew: '新建任务',
				formEdit: '编辑任务',
				formTitle: '标题',
				formSpec: '说明',
				formAcceptance: '验收标准',
				formPlan: '计划文档',
				formDepends: '依赖',
				formDependsHint: '逗号分隔的任务 id，例如 T-06, T-09。',
				formSave: '保存',
				formCancel: '取消',
				formRequired: '标题不能为空。',
				emptyTitle: '这个工作区还没有任务',
				emptyBody: '任务板是项目里的一个文件。这个原型把数据放在内存里。',
				tabFiles: '文件',
				locks: '文件锁',
				locksHint:
					'锁是 agent 之间的协议，不是内核锁：agent 在写入某个文件前取得，写完释放。读取不需要锁，但任何时候都能看到谁正在写。',
				locksNone: '该 agent 当前没有持有文件，也没有在排队。',
				locksPageHint:
					'先列被占用的文件及其排队者。释放时等待最久的一方获得该文件（标 ①）。',
				lockFree: '空闲',
				lockWaited: '已等待',
				lockNext: '（下一个）',
				lockRelease: '释放',
				lockForce: '回收',
				lockForceHint: '不等持有者，直接收回，再让队列自行解决',
				lockSimTake: '模拟 agent 取用',
				lockTook: '取得锁',
				lockReserved: '预约锁',
				lockGranted: '锁已授予',
				lockFreed: '锁已释放',
				simClaimed: '模拟 agent 领取了',
				simLease: '模拟租约即将耗尽：',
				simIdle: '没有可供模拟 agent 领取的任务。',
				lastEvent: '最近一次模拟事件',
				prototype: '交互原型——假数据，不做任何持久化。',
			},
		}

		/**
		 * Visual tone per task status, resolved against theme tokens by
		 * `[data-tone]` in TC_CSS. Only `--dsw-alias-*` tokens are referenced,
		 * so a theme change degrades appearance but never breaks rendering.
		 */
		const TC_TONE = {
			draft: 'idle',
			queued: 'idle',
			claimed: 'brand',
			in_progress: 'brand',
			review: 'warn',
			blocked: 'warn',
			done: 'success',
			cancelled: 'idle',
		}

		/** Board groups, in display order; `statuses` maps back to task status. */
		const TC_GROUPS = [
			{ id: 'active', statuses: ['claimed', 'in_progress'] },
			{ id: 'queued', statuses: ['queued'] },
			{ id: 'blocked', statuses: ['blocked'] },
			{ id: 'review', statuses: ['review'] },
			{ id: 'draft', statuses: ['draft'] },
			{ id: 'done', statuses: ['done', 'cancelled'] },
		]

		/** Groups open on first paint; `done` starts collapsed. */
		const TC_OPEN = { active: true, queued: true, blocked: true, review: true, draft: true, done: false }

		/** Styles for the panel, under this plugin's own prefix. */
		const TC_CSS = [
			'.gbt-root{display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}',
			'.gbt-head{display:flex;align-items:center;gap:10px;padding:14px 20px 10px}',
			'.gbt-title{font-size:15px;font-weight:600;line-height:1.4}',
			'.gbt-tabs{display:flex;gap:2px;margin-left:6px}',
			'.gbt-tab{appearance:none;border:none;background:none;font:inherit;font-size:13px;line-height:1.5;padding:4px 10px;border-radius:var(--dsw-radius-md,6px);color:var(--dsw-alias-label-secondary);cursor:pointer}',
			'.gbt-tab:hover{color:var(--dsw-alias-label-primary)}',
			'.gbt-tab[aria-current="page"]{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}',
			'.gbt-tab:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:1px}',
			'.gbt-spacer{flex:1;min-width:0}',
			'.gbt-btn{appearance:none;font:inherit;font-size:13px;line-height:1.5;padding:4px 12px;border-radius:var(--dsw-radius-md,6px);cursor:pointer;border:0.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}',
			'.gbt-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}',
			'.gbt-btn:disabled{opacity:.45;cursor:default}',
			'.gbt-btn:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:1px}',
			'.gbt-btn[data-variant="primary"]{border-color:transparent;background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-1)}',
			'.gbt-btn[data-variant="ghost"]{border-color:transparent;background:none;color:var(--dsw-alias-label-secondary)}',
			'.gbt-btn[data-variant="ghost"]:hover:not(:disabled){color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2)}',
			'.gbt-btn[data-size="sm"]{font-size:12px;padding:2px 8px}',
			'.gbt-stats{display:flex;align-items:center;gap:14px;padding:0 20px 10px;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary);border-bottom:0.5px solid var(--dsw-alias-border-l1)}',
			'.gbt-stat b{font-weight:600;color:var(--dsw-alias-label-primary)}',
			'.gbt-scope{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:38%}',
			'.gbt-note{padding:6px 20px;font-size:11px;line-height:1.5;color:var(--dsw-alias-label-secondary);border-bottom:0.5px solid var(--dsw-alias-border-l1)}',
			'.gbt-body{flex:1;min-height:0;overflow:auto;padding:10px 12px 48px}',
			'.gbt-board{display:flex;gap:10px;align-items:flex-start;min-height:100%}',
			'.gbt-col{flex:1 1 190px;min-width:172px;max-width:300px;display:flex;flex-direction:column;gap:8px;background:var(--dsw-alias-bg-layer-1);border:0.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md,6px);padding:8px}',
			'.gbt-col[data-collapsed="true"]{flex:0 0 auto;min-width:0;max-width:none}',
			'.gbt-colhead{display:flex;align-items:center;gap:6px;width:100%;appearance:none;border:none;background:none;font:inherit;font-size:12px;font-weight:600;line-height:1.5;color:var(--dsw-alias-label-secondary);padding:0;cursor:pointer;text-align:left;white-space:nowrap}',
			'.gbt-colhead:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:2px;border-radius:var(--dsw-radius-md,6px)}',
			'.gbt-colhead .gbt-count{font-weight:400;opacity:.75}',
			'.gbt-cards{display:flex;flex-direction:column;gap:8px}',
			'.gbt-card{background:var(--dsw-alias-bg-layer-2);border:0.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md,6px)}',
			'.gbt-card:hover{border-color:var(--dsw-alias-border-l2)}',
			'.gbt-cardmain{display:flex;flex-direction:column;gap:7px;width:100%;text-align:left;appearance:none;font:inherit;color:inherit;cursor:pointer;background:none;border:none;border-radius:inherit;padding:9px 10px}',
			'.gbt-cardmain:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:1px}',
			'.gbt-cardtop{display:flex;align-items:center;gap:6px;min-width:0}',
			'.gbt-cardtitle{font-size:13px;font-weight:500;line-height:1.5;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word}',
			'.gbt-cardfoot{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:11px;line-height:1.5;color:var(--dsw-alias-label-secondary)}',
			'.gbt-lock{display:inline-flex;align-items:center;gap:3px;font-size:11px;line-height:1.5;white-space:nowrap}',
			'.gbt-lock[data-state="held"]{color:var(--dsw-alias-brand-primary)}',
			'.gbt-lock[data-state="waiting"]{color:var(--dsw-alias-state-warn-primary)}',
			'.gbt-lockrow{display:flex;align-items:flex-start;gap:12px;padding:10px;border-bottom:0.5px solid var(--dsw-alias-border-l1)}',
			'.gbt-lockpath{flex:1;min-width:0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:1.6;word-break:break-all}',
			'.gbt-lockmeta{flex:none;display:flex;flex-direction:column;gap:3px;align-items:flex-end;font-size:11px;line-height:1.5;color:var(--dsw-alias-label-secondary);text-align:right}',
			'.gbt-waitlist{margin:4px 0 0;padding:0;list-style:none;font-size:11px;line-height:1.6;color:var(--dsw-alias-label-secondary)}',
			'.gbt-waitlist > li{font-variant-numeric:tabular-nums}',
			'.gbt-row{display:flex;align-items:center;gap:10px;width:100%;padding:8px 10px;border-radius:var(--dsw-radius-md,6px);border:0.5px solid transparent;background:none;font:inherit;text-align:left;color:inherit;cursor:pointer}',
			'.gbt-row:hover{background:var(--dsw-alias-bg-layer-2)}',
			'.gbt-row:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:-2px}',
			'.gbt-rowmain{display:flex;align-items:center;gap:10px;flex:1;min-width:0;appearance:none;border:none;background:none;font:inherit;color:inherit;text-align:left;padding:0;cursor:pointer}',
			'.gbt-rowmain:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:1px;border-radius:var(--dsw-radius-md,6px)}',
			'.gbt-id{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary);flex:none;min-width:42px}',
			'.gbt-rowtitle{flex:1;min-width:0;font-size:13px;line-height:1.5;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
			'.gbt-who{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;line-height:1.5;color:var(--dsw-alias-label-secondary);flex:none}',
			'.gbt-lease{font-size:11px;line-height:1.5;color:var(--dsw-alias-label-secondary);flex:none;font-variant-numeric:tabular-nums}',
			'.gbt-lease[data-warn="true"]{color:var(--dsw-alias-state-warn-primary)}',
			'.gbt-lease[data-warn="over"]{color:var(--dsw-alias-state-error-primary)}',
			'.gbt-pill{flex:none;font-size:11px;line-height:1.6;padding:0 7px;border-radius:999px;border:0.5px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);white-space:nowrap}',
			'.gbt-pill[data-tone="brand"]{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}',
			'.gbt-pill[data-tone="warn"]{border-color:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary)}',
			'.gbt-pill[data-tone="success"]{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary)}',
			'.gbt-pill[data-tone="error"]{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}',
			'.gbt-flag{flex:none;font-size:11px;line-height:1.5;color:var(--dsw-alias-state-warn-primary);white-space:nowrap}',
			'.gbt-rowactions{display:flex;gap:4px;flex:none;opacity:0}',
			'.gbt-row:hover .gbt-rowactions,.gbt-row:focus-within .gbt-rowactions{opacity:1}',
			'.gbt-detail{max-width:760px;margin:0 auto;padding:6px 8px 24px}',
			'.gbt-dhead{display:flex;align-items:flex-start;gap:10px;flex-wrap:wrap;padding:6px 0 14px;border-bottom:0.5px solid var(--dsw-alias-border-l1)}',
			'.gbt-dtitle{flex:1;min-width:240px;font-size:17px;font-weight:600;line-height:1.4;margin:0}',
			'.gbt-actions{display:flex;gap:6px;flex-wrap:wrap;padding:12px 0}',
			'.gbt-section{padding:14px 0;border-top:0.5px solid var(--dsw-alias-border-l1)}',
			'.gbt-section > h3{margin:0 0 8px;font-size:12px;font-weight:600;line-height:1.5;color:var(--dsw-alias-label-secondary);text-transform:uppercase;letter-spacing:.04em}',
			'.gbt-prose{margin:0;font-size:13px;line-height:1.7;white-space:pre-wrap;word-break:break-word}',
			'.gbt-kv{display:flex;gap:10px;font-size:12px;line-height:1.7}',
			'.gbt-kv > dt{flex:none;width:88px;color:var(--dsw-alias-label-secondary)}',
			'.gbt-kv > dd{margin:0;min-width:0;word-break:break-word}',
			'.gbt-code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}',
			'.gbt-chip{display:inline-block;margin:0 6px 4px 0;padding:1px 7px;border-radius:var(--dsw-radius-md,6px);border:0.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;line-height:1.6;color:var(--dsw-alias-label-primary);appearance:none;cursor:pointer}',
			'.gbt-chip:disabled{cursor:default;opacity:.85}',
			'.gbt-tl{margin:0;padding:0;list-style:none}',
			'.gbt-tl > li{display:flex;gap:10px;padding:4px 0;font-size:12px;line-height:1.6}',
			'.gbt-tl > li > time{flex:none;width:112px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}',
			'.gbt-form{max-width:680px;margin:0 auto;padding:6px 8px 24px}',
			'.gbt-field{display:flex;flex-direction:column;gap:5px;padding:9px 0}',
			'.gbt-label{font-size:12px;font-weight:500;line-height:1.5;color:var(--dsw-alias-label-primary)}',
			'.gbt-input,.gbt-area{width:100%;box-sizing:border-box;font:inherit;font-size:13px;line-height:1.6;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border:0.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md,6px);padding:6px 10px}',
			'.gbt-area{resize:vertical;min-height:72px}',
			'.gbt-input:focus-visible,.gbt-area:focus-visible{outline:none;border-color:var(--dsw-alias-brand-primary)}',
			'.gbt-help{margin:0;font-size:11px;line-height:1.5;color:var(--dsw-alias-label-secondary)}',
			'.gbt-problem{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-state-error-primary)}',
			'.gbt-empty{max-width:420px;margin:0 auto;padding:56px 20px;text-align:center}',
			'.gbt-empty h2{margin:0 0 8px;font-size:15px;font-weight:600}',
			'.gbt-empty p{margin:0 0 16px;font-size:13px;line-height:1.7;color:var(--dsw-alias-label-secondary)}',
			'.gbt-glyph{display:block}',
		].join('')

		/** Two paths overlap when either contains the other at a segment boundary. */
		function tcScopeTouches(a, b) {
			const x = String(a || '').replace(/\/+$/, '').toLowerCase()
			const y = String(b || '').replace(/\/+$/, '').toLowerCase()
			if (x === '' || y === '') return false
			return x === y || x.indexOf(y + '/') === 0 || y.indexOf(x + '/') === 0
		}

		/** Lock lease: long enough for a work session, short enough to self-heal. */
		const TC_LOCK_LEASE_MS = 30 * 60 * 1000

		/** A task occupies work while an agent holds it. */
		function tcActive(task) {
			return task.status === 'claimed' || task.status === 'in_progress'
		}

		/**
		 * The files one agent holds and the files it is queued for.
		 *
		 * Locks are keyed by file path and held by an AGENT (a session), not by
		 * a task: a task is only what that agent happens to be working on, and
		 * an agent can hold a file for work no task describes. A lock's
		 * `taskId` is optional labelling for the reader, never the key.
		 * Everything here is derived from the snapshot so the views stay dumb.
		 *
		 * @param locks - the snapshot's lock table, keyed by path.
		 * @param who - the agent name to look up.
		 * @returns `{ held, waiting }`, both sorted path lists.
		 */
		function tcLocksOf(locks, who) {
			const held = []
			const waiting = []
			Object.keys(locks).forEach((path) => {
				const entry = locks[path]
				if (entry.holder === who) held.push(path)
				if (entry.queue.some((waiter) => waiter.who === who)) waiting.push(path)
			})
			return { held: held.sort(), waiting: waiting.sort() }
		}

		/** Seed board: a plausible Godot slice. */
		function tcSeedTasks() {
			const now = Date.now()
			const minute = 60 * 1000
			const iso = (minutesAgo) => now - minutesAgo * minute
			function entry(at, by, from, to, note) {
				return { at: at, by: by, from: from, to: to, note: note || '' }
			}
			return [
				{
					id: 'T-06', title: '伤害系统重构：统一 DamageContext',
					spec: '把三处各自结算伤害的路径收敛到一个 DamageContext，元素抗性、暴击、护盾在同一个函数里结算。',
					status: 'in_progress', priority: 'high', order: 0,
					assignee: { name: '@combat-2', session: 'session-3aa42d46' },
					leaseUntil: now + 40 * minute, blockedBy: [],
					acceptance: 'headless 跑 tests/combat_test.gd 全绿；三处旧调用点全部改为 DamageContext。',
					evidence: '', planRef: 'docs/plans/combat-refactor.md',
					createdAt: iso(600), updatedAt: iso(24),
					history: [
						entry(iso(600), 'user', null, 'draft', ''),
						entry(iso(590), 'user', 'draft', 'queued', ''),
						entry(iso(24), '@combat-2', 'queued', 'in_progress', '领取'),
					],
				},
				{
					id: 'T-09', title: '存档系统读写回归',
					spec: '排查 2 号槽位读档后道具数量归零：疑似 core 序列化顺序与存档版本迁移互相影响。',
					status: 'in_progress', priority: 'high', order: 0,
					assignee: { name: '@fixer', session: 'session-57c27369' },
					leaseUntil: now + 4 * minute, blockedBy: [],
					acceptance: 'tests/save_test.gd 覆盖 1/2/3 号槽位往返；旧版本存档能迁移。',
					evidence: '', planRef: '',
					createdAt: iso(180), updatedAt: iso(8),
					history: [
						entry(iso(180), 'user', null, 'draft', ''),
						entry(iso(175), 'user', 'draft', 'queued', ''),
						entry(iso(8), '@fixer', 'queued', 'in_progress', '领取'),
					],
				},
				{
					id: 'T-12', title: '战斗相机手感调整',
					spec: '锁定目标时的相机构图偏右，命中反馈时抖动幅度过大；需要一组可调的相机参数而不是硬编码。',
					status: 'in_progress', priority: 'normal', order: 0,
					assignee: { name: '@explore-3', session: 'session-a5b11302' },
					leaseUntil: now + 22 * minute, blockedBy: [],
					acceptance: '相机参数进入 resources/camera/；截图对比锁定前后的构图。',
					evidence: '', planRef: '',
					createdAt: iso(96), updatedAt: iso(3),
					history: [
						entry(iso(96), 'user', null, 'draft', ''),
						entry(iso(90), 'user', 'draft', 'queued', ''),
						entry(iso(3), '@explore-3', 'queued', 'in_progress', '领取'),
					],
				},
				{
					id: 'T-11', title: '敌人受击反馈（硬直 + 闪白）',
					spec: '受击后的硬直时长与闪白需要走统一事件，而不是每个敌人脚本各写一遍。',
					status: 'blocked', priority: 'normal', order: 0,
					assignee: null, leaseUntil: null, blockedBy: ['T-06'],
					acceptance: '三种敌人都能在受击时进入硬直并闪白；事件由 DamageContext 发出。',
					evidence: '', planRef: '',
					createdAt: iso(80), updatedAt: iso(30),
					history: [
						entry(iso(80), 'user', null, 'draft', ''),
						entry(iso(78), 'user', 'draft', 'queued', ''),
						entry(iso(30), 'user', 'queued', 'blocked', '等 T-06 的 DamageContext 落地'),
					],
				},
				{
					id: 'T-10', title: '音频总线重排：Master/SFX/BGM/Voice',
					spec: '把扁平总线拆成四层，给 SFX 挂压缩器，Voice 走独立限幅。',
					status: 'review', priority: 'low', order: 0,
					assignee: { name: '@fixer', session: 'session-57c27369' },
					leaseUntil: null, blockedBy: [],
					acceptance: '四种总线在编辑器里可见；SFX 总线有压缩器；无爆音。',
					evidence: 'headless 通过：tests/audio_bus_test.gd 全绿（11 例）。',
					planRef: '',
					createdAt: iso(300), updatedAt: iso(45),
					history: [
						entry(iso(300), 'user', null, 'draft', ''),
						entry(iso(295), 'user', 'draft', 'queued', ''),
						entry(iso(70), '@fixer', 'queued', 'in_progress', '领取'),
						entry(iso(45), '@fixer', 'in_progress', 'review', '提交验收，附测试输出'),
					],
				},
				{
					id: 'T-15', title: '敌人 AI 巡逻状态机',
					spec: '巡逻 → 警戒 → 追击 → 返回，状态之间走显式转移表，避免 if 嵌套。',
					status: 'queued', priority: 'normal', order: 1,
					assignee: null, leaseUntil: null, blockedBy: [],
					acceptance: '状态转移在测试里可穷举；玩家离开视野后 3 秒返回巡逻。',
					evidence: '', planRef: 'docs/plans/enemy-ai.md',
					createdAt: iso(50), updatedAt: iso(50),
					history: [entry(iso(50), 'user', null, 'queued', '新建并直接入队')],
				},
				{
					id: 'T-14', title: 'UI：血条与伤害数字',
					spec: '血条改为延迟跟随，伤害数字走对象池；都挂在 CanvasLayer 上。',
					status: 'queued', priority: 'normal', order: 2,
					assignee: null, leaseUntil: null, blockedBy: [],
					acceptance: '连续受击不产生新节点；血条在 0.3 秒内追平。',
					evidence: '', planRef: '',
					createdAt: iso(44), updatedAt: iso(44),
					history: [entry(iso(44), 'user', null, 'queued', '新建并直接入队')],
				},
				{
					id: 'T-13', title: '战斗相机抖动幅度调参',
					spec: '把抖动拆成幅度/频率/衰减三个参数，暴露到 resources/camera/shake.tres。',
					status: 'draft', priority: 'low', order: 0,
					assignee: null, leaseUntil: null, blockedBy: [],
					acceptance: '改 tres 即可调参，无需重启场景。',
					evidence: '', planRef: '',
					createdAt: iso(12), updatedAt: iso(12),
					history: [entry(iso(12), '@explore-3', null, 'draft', 'agent 提交的草稿，等发布')],
				},
				{
					id: 'T-08', title: '地形高度图导入流程',
					spec: '把 PNG 高度图导入为 Terrain3D 资源，并校验尺寸与位深。',
					status: 'done', priority: 'normal', order: 0,
					assignee: { name: '@explore-3', session: 'session-a5b11302' },
					leaseUntil: null, blockedBy: [],
					acceptance: '两张测试高度图导入无警告。',
					evidence: '编辑器导入日志无警告；assets/terrain/height_01.res 已生成。',
					planRef: '',
					createdAt: iso(1400), updatedAt: iso(900),
					history: [
						entry(iso(1400), 'user', null, 'draft', ''),
						entry(iso(1390), 'user', 'draft', 'queued', ''),
						entry(iso(1200), '@explore-3', 'queued', 'in_progress', '领取'),
						entry(iso(960), '@explore-3', 'in_progress', 'review', ''),
						entry(iso(900), 'user', 'review', 'done', '验收通过'),
					],
				},
				{
					id: 'T-07', title: '输入映射对齐 Godot 4 physical_keycode',
					spec: '旧映射用了 Godot 3 的键码基线，特殊键绑定静默失效。',
					status: 'cancelled', priority: 'normal', order: 0,
					assignee: null, leaseUntil: null, blockedBy: [],
					acceptance: '被 godot_manage_input_map 取代，不再单独处理。',
					evidence: '', planRef: '',
					createdAt: iso(2000), updatedAt: iso(1700),
					history: [
						entry(iso(2000), 'user', null, 'draft', ''),
						entry(iso(1700), 'user', 'draft', 'cancelled', '并入 godot_manage_input_map'),
					],
				},
			]
		}

		/**
		 * Seed lock table, keyed by project-relative file path.
		 *
		 * A lock is held by an agent and carries an optional task label
		 * (`taskId`) plus a lease, so a crashed agent cannot block a file
		 * forever. `queue` holds reservations in request order; the store
		 * grants to the longest-waiting reservation on release, which is the
		 * rule the `scripts/core/damage.gd` seed exists to demonstrate:
		 * `@fixer` has waited longer than `@explore-3`, so `@fixer` wins.
		 *
		 * @returns the seeded lock table.
		 */
		function tcSeedLocks() {
			const now = Date.now()
			const minute = 60 * 1000
			return {
				'scripts/core/damage.gd': {
					holder: '@combat-2',
					taskId: 'T-06',
					since: now - 24 * minute,
					leaseUntil: now + 40 * minute,
					queue: [
						{ who: '@fixer', taskId: 'T-09', since: now - 6 * minute },
						{ who: '@explore-3', taskId: 'T-12', since: now - 2 * minute },
					],
				},
				'scripts/save/save_manager.gd': {
					holder: '@fixer',
					taskId: 'T-09',
					since: now - 8 * minute,
					leaseUntil: now + 3 * minute,
					queue: [],
				},
				'scenes/player/player.tscn': {
					holder: '@explore-3',
					taskId: 'T-12',
					since: now - 3 * minute,
					leaseUntil: now + 22 * minute,
					queue: [],
				},
				'scripts/combat/hitbox.gd': {
					holder: null,
					taskId: null,
					since: null,
					leaseUntil: null,
					queue: [],
				},
				'project.godot': {
					holder: null,
					taskId: null,
					since: null,
					leaseUntil: null,
					queue: [],
				},
			}
		}

		/**
		 * The prototype's data seam.
		 *
		 * The method set is deliberately the one the Host service will expose:
		 * swapping the bodies for `fetch()` calls is the entire migration, and
		 * the views below keep working unchanged. State updates are immutable
		 * (a new snapshot object per commit) because `useSyncExternalStore`
		 * compares snapshot identity.
		 *
		 * @returns the mock store: `subscribe`, `getSnapshot`, and the actions.
		 */
		function createTaskStore() {
			const listeners = new Set()
			let state = {
				tasks: tcSeedTasks(),
				locks: tcSeedLocks(),
				seq: 16,
				scopePath: 'J:\\mm13dremake_workspace\\mm13d',
				// Localisation stays in the views: the store reports an event
				// code, never text.
				lastEvent: null,
			}
			function emit() {
				listeners.forEach((listener) => listener())
			}
			function put(partial) {
				state = Object.assign({}, state, partial)
				emit()
			}
			function stamp() {
				return { at: Date.now(), by: 'user', from: null, to: null, note: '' }
			}
			/** Apply `change` to one task, appending one history entry. */
			function patch(id, change, note) {
				put({
					tasks: state.tasks.map((task) => {
						if (task.id !== id) return task
						const next = Object.assign({}, task, change, { updatedAt: Date.now() })
						next.history = task.history.concat([
							Object.assign(stamp(), { from: task.status, to: next.status, note: note || '' }),
						])
						return next
					}),
				})
			}
			function queueOrder() {
				const orders = state.tasks
					.filter((task) => task.status === 'queued')
					.map((task) => task.order)
				return (orders.length === 0 ? 0 : Math.max.apply(null, orders)) + 1
			}
			/**
			 * Hand a path to its longest-waiting reservation, or back to nobody.
			 *
			 * Highest `since` loses, so ordering the wait list by request time is
			 * the whole priority rule. The grant happens in the same commit as
			 * the release, so a file is never left unowned while someone waits.
			 *
			 * @param path - the locked path.
			 * @param entry - its current lock record.
			 * @param reason - `release` (holder gave it up) or `forced` (a human
			 *   reclaimed it), recorded for the reader.
			 */
			function grantNext(path, entry, reason) {
				const waitlist = entry.queue.slice().sort((a, b) => a.since - b.since)
				const next = waitlist.shift() || null
				const granted = next
					? {
							holder: next.who,
							taskId: next.taskId || null,
							since: Date.now(),
							leaseUntil: Date.now() + TC_LOCK_LEASE_MS,
							queue: waitlist,
						}
					: { holder: null, taskId: null, since: null, leaseUntil: null, queue: [] }
				put({
					locks: Object.assign({}, state.locks, { [path]: granted }),
					lastEvent: next
						? {
								kind: 'granted',
								path: path,
								who: next.who,
								reason: reason,
								waited: Date.now() - next.since,
							}
						: { kind: 'freed', path: path, who: entry.holder },
				})
			}
			/**
			 * Take a file lock, or fall in line behind whoever holds it.
			 *
			 * Idempotent per agent: asking again while already holding the file
			 * renews the lease, and asking again while already queued keeps the
			 * ORIGINAL request time — that time is what decides priority, so
			 * re-asking must never lose your place.
			 *
			 * @param path - project-relative file path.
			 * @param who - the agent taking it.
			 * @param taskId - optional task label, for the reader only.
			 */
			function takeLock(path, who, taskId) {
				const entry = state.locks[path] || {
					holder: null,
					taskId: null,
					since: null,
					leaseUntil: null,
					queue: [],
				}
				if (entry.holder === who) {
					put({
						locks: Object.assign({}, state.locks, {
							[path]: Object.assign({}, entry, {
								leaseUntil: Date.now() + TC_LOCK_LEASE_MS,
							}),
						}),
					})
					return
				}
				if (entry.holder === null && entry.queue.length === 0) {
					put({
						locks: Object.assign({}, state.locks, {
							[path]: Object.assign({}, entry, {
								holder: who,
								taskId: taskId || null,
								since: Date.now(),
								leaseUntil: Date.now() + TC_LOCK_LEASE_MS,
							}),
						}),
						lastEvent: { kind: 'took', path: path, who: who },
					})
					return
				}
				if (entry.queue.some((waiter) => waiter.who === who)) return
				put({
					locks: Object.assign({}, state.locks, {
						[path]: Object.assign({}, entry, {
							queue: entry.queue.concat([
								{ who: who, taskId: taskId || null, since: Date.now() },
							]),
						}),
					}),
					lastEvent: { kind: 'reserved', path: path, who: who },
				})
			}
			return {
				subscribe(listener) {
					listeners.add(listener)
					return function unsubscribe() {
						listeners.delete(listener)
					}
				},				getSnapshot() {
					return state
				},
				create(input) {
					const id = 'T-' + String(state.seq)
					put({
						seq: state.seq + 1,
						tasks: state.tasks.concat([
							{
								id: id,
								title: input.title,
								spec: input.spec || '',
								status: 'draft',
								priority: input.priority || 'normal',
								order: 0,
								assignee: null,
								leaseUntil: null,
								blockedBy: input.blockedBy || [],
								acceptance: input.acceptance || '',
								evidence: '',
								planRef: input.planRef || '',
								createdAt: Date.now(),
								updatedAt: Date.now(),
								history: [
									Object.assign(stamp(), { to: 'draft', note: '新建' }),
								],
							},
						]),
					})
					return id
				},
				update(id, input) {
					patch(
						id,
						{
							title: input.title,
							spec: input.spec || '',
							acceptance: input.acceptance || '',
							planRef: input.planRef || '',
							blockedBy: input.blockedBy || [],
							priority: input.priority || 'normal',
						},
						'编辑',
					)
				},
				remove(id) {
					put({ tasks: state.tasks.filter((task) => task.id !== id) })
				},
				/** Draft -> queued. This is the human-only authorisation point. */
				publish(ids) {
					let order = queueOrder()
					const set = new Set(ids)
					put({
						tasks: state.tasks.map((task) => {
							if (!set.has(task.id) || task.status !== 'draft') return task
							const next = Object.assign({}, task, {
								status: 'queued',
								order: order,
								updatedAt: Date.now(),
							})
							order += 1
							next.history = task.history.concat([
								Object.assign(stamp(), { from: 'draft', to: 'queued', note: '发布到队列' }),
							])
							return next
						}),
						lastEvent: { kind: 'released', ids: ids },
					})
				},
				unpublish(id) {
					patch(id, { status: 'draft', order: 0 }, '退回草稿')
				},
				/** Simulated agent claim: CAS semantics are the Host's job later. */
				claim(id, who) {
					patch(
						id,
						{
							status: 'in_progress',
							assignee: { name: who, session: 'session-' + Math.random().toString(16).slice(2, 10) },
							leaseUntil: Date.now() + 30 * 60 * 1000,
						},
						'领取（租约 30m）',
					)
				},
				release(id) {
					patch(id, { status: 'queued', assignee: null, leaseUntil: null }, '释放回队列')
				},
				setStatus(id, status, note) {
					const change = { status: status }
					if (status === 'done' || status === 'cancelled' || status === 'review') {
						change.leaseUntil = null
					}
					if (status === 'queued' || status === 'draft') {
						change.assignee = null
						change.leaseUntil = null
					}
					patch(id, change, note)
				},
				complete(id, evidence) {
					patch(id, { status: 'review', evidence: evidence, leaseUntil: null }, '提交验收')
				},
				blocked(id, on, note) {
					patch(
						id,
						on
							? { status: 'blocked', leaseUntil: null }
							: { status: 'in_progress', leaseUntil: Date.now() + 30 * 60 * 1000 },
						note,
					)
				},
				move(id, direction) {
					const queued = state.tasks
						.filter((task) => task.status === 'queued')
						.sort((a, b) => a.order - b.order)
					const index = queued.findIndex((task) => task.id === id)
					if (index < 0) return
					if (direction === 'top') {
						queued.forEach((task, i) => {
							if (i !== index) task.order = i + 1
						})
						queued[index].order = 0
					} else {
						const target = direction === 'up' ? index - 1 : index + 1
						if (target < 0 || target >= queued.length) return
						const swap = queued[target].order
						queued[target].order = queued[index].order
						queued[index].order = swap
					}
					put({ tasks: state.tasks.slice() })
				},
				/** One scripted agent step, so the live-update story is tangible. */
				simulate() {
					const sims = ['@sim-1', '@sim-2', '@sim-3']
					// Priority is state-driven, not a fixed script: whatever the
					// board cannot currently show, this click makes visible.
					// 1. A held file with waiters: release it and watch the
					//    longest-waiting reservation win.
					const contended = Object.keys(state.locks).filter((path) => {
						const entry = state.locks[path]
						return entry.holder !== null && entry.queue.length > 0
					})
					if (contended.length > 0) {
						grantNext(contended[0], state.locks[contended[0]], 'release')
						return
					}
					// 2. A held file with no waiters: have another agent reserve it.
					const held = Object.keys(state.locks).filter(
						(path) => state.locks[path].holder !== null,
					)
					if (held.length > 0) {
						const path = held[0]
						const holder = state.locks[path].holder
						const who = sims.filter((name) => name !== holder)[0]
						const holding = state.tasks.filter(
							(task) => task.assignee && task.assignee.name === who,
						)[0]
						takeLock(path, who, holding ? holding.id : null)
						put({ lastEvent: { kind: 'reserved', path: path, who: who } })
						return					}
					// 3. Otherwise put an agent on the next queued task.
					const queued = state.tasks
						.filter((task) => task.status === 'queued')
						.sort((a, b) => a.order - b.order)
					if (queued.length > 0) {
						const who = sims.filter(
							(name) =>
								!state.tasks.some((task) => task.assignee && task.assignee.name === name),
						)[0] || sims[0]
						const target = queued[0]
						patch(
							target.id,
							{
								status: 'in_progress',
								assignee: { name: who, session: 'session-sim' },
								leaseUntil: Date.now() + 30 * 60 * 1000,
							},
							'领取（模拟）',
						)
						put({ lastEvent: { kind: 'claimed', id: target.id, who: who } })
						return
					}
					// 4. Last resort: let a task's lease run out.
					const running = state.tasks.filter(tcActive)
					if (running.length > 0) {
						const target = running[0]
						patch(target.id, { leaseUntil: Date.now() + 2 * 60 * 1000 }, '租约被压缩（模拟）')
						put({ lastEvent: { kind: 'lease', id: target.id } })
						return
					}
					put({ lastEvent: { kind: 'idle' } })
				},
				/**
				 * Take a file lock, or fall in line behind whoever holds it.
				 *
				 * Idempotent per agent: asking again while already holding the
				 * file renews the lease, and asking again while already queued
				 * keeps the ORIGINAL request time — that time is what decides
				 * priority, so re-asking must never lose your place.
				 *
				 * @param path - project-relative file path.
				 * @param who - the agent taking it.
				 * @param taskId - optional task label, for the reader only.
				 */
				acquireLock(path, who, taskId) {
					takeLock(path, who, taskId)
				},
				/** Give the file up; the next commit hands it to the longest waiter. */
				releaseLock(path, who) {
					const entry = state.locks[path]
					if (!entry) return
					if (who && entry.holder !== who) return
					grantNext(path, entry, 'release')
				},
				/** Human override: drop the holder and let the wait list resolve. */
				forceRelease(path) {
					const entry = state.locks[path]
					if (!entry) return
					grantNext(path, entry, 'forced')
				},
				/** Leave the wait list without taking the file. */
				cancelReservation(path, who) {
					const entry = state.locks[path]
					if (!entry) return
					put({
						locks: Object.assign({}, state.locks, {
							[path]: Object.assign({}, entry, {
								queue: entry.queue.filter((waiter) => waiter.who !== who),
							}),
						}),
					})
				},
				reset() {
					put({ tasks: tcSeedTasks(), locks: tcSeedLocks(), seq: 16, lastEvent: null })
				},
			}
		}

		/** Clock for lease countdowns; one interval per mounted panel. */
		function useNow(intervalMs) {
			const [now, setNow] = React.useState(function () {
				return Date.now()
			})
			React.useEffect(function () {
				const handle = setInterval(function () {
					setNow(Date.now())
				}, intervalMs)
				return function () {
					clearInterval(handle)
				}
			}, [intervalMs])
			return now
		}

		/** Subscribe the panel to the store snapshot. */
		function useTasks(store) {
			return React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
		}

		/**
		 * Build the prototype's views, bound to one store instance.
		 *
		 * Declared as a factory (like `formFor`) so the components can close
		 * over the store created inside `apply`, and over `ctx` for the locale
		 * service.
		 *
		 * @param ctx - the browser plugin's context.
		 * @param store - the task store (mock today, Host-backed later).
		 * @returns the panel root and the rail glyph.
		 */
		function createTaskCenterViews(ctx, store) {
			/** Status -> copy key, and group -> copy key. */
			const STATUS_KEY = {
				draft: 'statusDraft',
				queued: 'statusQueued',
				claimed: 'statusClaimed',
				in_progress: 'statusInProgress',
				review: 'statusReview',
				blocked: 'statusBlocked',
				done: 'statusDone',
				cancelled: 'statusCancelled',
			}
			const GROUP_KEY = {
				active: 'groupActive',
				queued: 'groupQueued',
				blocked: 'groupBlocked',
				review: 'groupReview',
				draft: 'groupDraft',
				done: 'groupDone',
			}

			/**
			 * Translate through the host's locale service and re-render on a
			 * language switch (the panel is a long-lived occupant of `main`).
			 *
			 * Deliberately NOT `useSyncExternalStore`: that hook requires a
			 * snapshot with a stable identity, while the locale service only
			 * commits to `subscribe`/`getSnapshot` returning *a* snapshot. A
			 * plain subscription has no such contract to violate.
			 */
			function useTranslate() {
				const force = React.useReducer((count) => count + 1, 0)[1]
				React.useEffect(() => ctx.locale.subscribe(force), [])
				return ctx.locale.bind(TC_NS)
			}

			/** Compact relative age, e.g. `3m` / `2h` / `1d`. */
			function shortAgo(timestamp) {
				const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000))
				if (seconds < 60) return seconds + 's'
				const minutes = Math.round(seconds / 60)
				if (minutes < 60) return minutes + 'm'
				const hours = Math.round(minutes / 60)
				if (hours < 24) return hours + 'h'
				return Math.round(hours / 24) + 'd'
			}

			/** Lease countdown text and its warning level. */
			function leaseState(task, now, t) {
				if (!task.leaseUntil) return null
				const remaining = task.leaseUntil - now
				if (remaining <= 0) return { text: t('leaseExpired'), warn: 'over' }
				const minutes = Math.max(1, Math.round(remaining / 60000))
				const text =
					minutes >= 60
						? Math.floor(minutes / 60) + 'h' + (minutes % 60 === 0 ? '' : String(minutes % 60) + 'm')
						: String(minutes) + 'm'
				return { text: t('lease') + ' ' + text, warn: minutes <= 5 ? 'true' : null }
			}

			/** Comma/space separated list, for the dependency field. */
			function fromCommas(text) {
				return String(text || '')
					.split(/[,\s]+/)
					.map((piece) => piece.trim())
					.filter((piece) => piece.length > 0)
			}

			/** Status chip. */
			function Pill(props) {
				return h(
					'span',
					{ className: 'gbt-pill', 'data-tone': TC_TONE[props.status] || 'idle' },
					props.label,
				)
			}

			/**
			 * File-lock badges for one agent: how many files it holds and how
			 * many it is queued for.
			 *
			 * Rendered from the lock table, never from a declaration of intent,
			 * so a badge only ever states what is true right now. Both counts
			 * carry the full path list in their tooltip.
			 */
			function LockBadges(props) {
				const locks = props.locks
				if (!locks || (locks.held.length === 0 && locks.waiting.length === 0)) return null
				return h(
					'span',
					{ className: 'gbt-cardfoot' },
					locks.held.length > 0
						? h(
								'span',
								{
									className: 'gbt-lock',
									'data-state': 'held',
									title: locks.held.join('\n'),
								},
								'🔒 ' + String(locks.held.length),
							)
						: null,
					locks.waiting.length > 0
						? h(
								'span',
								{
									className: 'gbt-lock',
									'data-state': 'waiting',
									title: locks.waiting.join('\n'),
								},
								'⏳ ' + String(locks.waiting.length),
							)
						: null,
				)
			}

			/** One queue row: a wide inner button plus its own hover actions. */
			function Row(props) {
				const task = props.task
				const t = props.t
				const lease = leaseState(task, props.now, t)
				return h(
					'div',
					{ className: 'gbt-row' },
					h(
						'button',
						{
							type: 'button',
							className: 'gbt-rowmain',
							onClick: () => props.onOpen(task.id),
							'aria-label': task.id + ' ' + task.title,
						},
						h('span', { className: 'gbt-id' }, task.id),
						h('span', { className: 'gbt-rowtitle' }, task.title),
						h(Pill, { status: task.status, label: t(STATUS_KEY[task.status]) }),
						h(
							'span',
							{ className: 'gbt-who' },
							task.assignee ? task.assignee.name : t('unassigned'),
						),
						lease
							? h(
									'span',
									{
										className: 'gbt-lease',
										'data-warn': lease.warn || 'false',
									},
									lease.text,
								)
							: null,
						task.status === 'blocked' && task.blockedBy.length > 0
							? h(
									'span',
									{ className: 'gbt-flag' },
									t('dependsOn') + ' ' + task.blockedBy.join(', '),
								)
							: null,
						h(LockBadges, { locks: props.locks }),
					),
					props.actions ? h('div', { className: 'gbt-rowactions' }, props.actions) : null,
				)
			}

			/** One task as a card. */
			function Card(props) {
				const task = props.task
				const t = props.t
				const lease = leaseState(task, props.now, t)
				return h(
					'div',
					{ className: 'gbt-card' },
					h(
						'button',
						{
							type: 'button',
							className: 'gbt-cardmain',
							onClick: () => props.onOpen(task.id),
							'aria-label': task.id + ' ' + task.title,
						},
						h(
							'div',
							{ className: 'gbt-cardtop' },
							h('span', { className: 'gbt-id' }, task.id),
							h(Pill, { status: task.status, label: t(STATUS_KEY[task.status]) }),
						),
						h('span', { className: 'gbt-cardtitle' }, task.title),
						h(
							'div',
							{ className: 'gbt-cardfoot' },
							h(
								'span',
								{ className: 'gbt-who' },
								task.assignee ? task.assignee.name : t('unassigned'),
							),
							lease
								? h(
										'span',
										{
											className: 'gbt-lease',
											'data-warn': lease.warn || 'false',
										},
										lease.text,
									)
								: null,
							task.status === 'blocked' && task.blockedBy.length > 0
								? h(
										'span',
										{ className: 'gbt-flag' },
										t('dependsOn') + ' ' + task.blockedBy.join(', '),
									)
								: null,
						),
						h(LockBadges, { locks: props.locks }),
					),
				)
			}

			/** One board column: a status group holding its cards. */
			function Column(props) {
				const t = props.t
				const tasks = props.tasks
				const open = props.open
				return h(
					'div',
					{ className: 'gbt-col', 'data-collapsed': open ? 'false' : 'true' },
					h(
						'button',
						{
							type: 'button',
							className: 'gbt-colhead',
							'aria-expanded': open ? 'true' : 'false',
							onClick: () => props.onToggle(props.id),
						},
						h('span', null, (open ? '▾ ' : '▸ ') + t(GROUP_KEY[props.id])),
						h('span', { className: 'gbt-count' }, String(tasks.length)),
					),
					open
						? h(
								'div',
								{ className: 'gbt-cards' },
								tasks.map((task) =>
									h(Card, {
										key: task.id,
										task: task,
										t: t,
										now: props.now,
										locks: task.assignee
											? tcLocksOf(props.locks, task.assignee.name)
											: null,
										onOpen: props.onOpen,
									}),
								),
							)
						: null,
				)
			}

			/** Grouped board (and the archive, which renders flat). */
			function BoardView(props) {
				const t = props.t
				const snapshot = props.snapshot
				const groups = props.groups || TC_GROUPS
				const rowFor = (task) =>
					h(Row, {
						key: task.id,
						task: task,
						t: t,
						now: props.now,
						locks: task.assignee ? tcLocksOf(snapshot.locks, task.assignee.name) : null,
						onOpen: props.onOpen,
					})
				const byGroup = groups
					.map((group) => ({
						id: group.id,
						tasks: snapshot.tasks
							.filter((task) => group.statuses.indexOf(task.status) >= 0)
							.sort((a, b) => {
								if (a.status === 'queued' && b.status === 'queued') return a.order - b.order
								return b.updatedAt - a.updatedAt
							}),
					}))
					.filter((group) => group.tasks.length > 0)
				if (byGroup.length === 0) {
					return h(
						'div',
						{ className: 'gbt-empty' },
						h('h2', null, t('emptyTitle')),
						h('p', null, t('emptyBody')),
						h(
							'button',
							{
								type: 'button',
								className: 'gbt-btn',
								'data-variant': 'primary',
								onClick: props.onReset,
							},
							t('reset'),
						),
					)
				}
				// The archive is a flat list: a collapse header there would only
				// add a state the user has to notice before seeing anything, and
				// its group is collapsed on the board by default.
				if (props.flat === true) {
					return h(
						'div',
						null,
						byGroup.reduce((rows, group) => rows.concat(group.tasks), []).map(rowFor),
					)
				}
				return h(
					'div',
					{ className: 'gbt-board' },
					byGroup.map((group) =>
						h(Column, {
							key: group.id,
							id: group.id,
							tasks: group.tasks,
							t: t,
							now: props.now,
							locks: snapshot.locks,
							open: props.open[group.id] !== false,
							onToggle: props.onToggle,
							onOpen: props.onOpen,
						}),
					),
				)
			}

			/** Drafts awaiting release, then the queue in order. */
			function QueueView(props) {
				const t = props.t
				const snapshot = props.snapshot
				const drafts = snapshot.tasks.filter((task) => task.status === 'draft')
				const queued = snapshot.tasks
					.filter((task) => task.status === 'queued')
					.sort((a, b) => a.order - b.order)
				const selected = props.selection
				function toggle(id) {
					const next = new Set(selected)
					if (next.has(id)) next.delete(id)
					else next.add(id)
					props.onSelection(next)
				}
				const draftBlock =
					drafts.length === 0
						? null
						: h(
								'div',
								{ className: 'gbt-section' },
								h('h3', null, t('queueDrafts')),
								h('p', { className: 'gbt-help' }, t('queueDraftsHint')),
								h(
									'div',
									{ className: 'gbt-actions' },
									h(
										'button',
										{
											type: 'button',
											className: 'gbt-btn',
											'data-size': 'sm',
											onClick: () =>
												props.onSelection(
													selected.size === drafts.length
														? new Set()
														: new Set(drafts.map((task) => task.id)),
												),
										},
										t('selectAll'),
									),
									h(
										'button',
										{
											type: 'button',
											className: 'gbt-btn',
											'data-size': 'sm',
											'data-variant': 'primary',
											disabled: selected.size === 0,
											onClick: () => {
												props.onPublish(Array.from(selected))
												props.onSelection(new Set())
											},
										},
										t('releaseSelected') + (selected.size ? ' (' + selected.size + ')' : ''),
									),
								),
								drafts.map((task) =>
									h(
										'div',
										{ className: 'gbt-row', key: task.id },
										h(
											'label',
											{ className: 'gbt-rowmain', style: { cursor: 'pointer' } },
											h('input', {
												type: 'checkbox',
												checked: selected.has(task.id),
												onChange: () => toggle(task.id),
											}),
											h('span', { className: 'gbt-id' }, task.id),
											h('span', { className: 'gbt-rowtitle' }, task.title),
											h('span', { className: 'gbt-who' }, shortAgo(task.createdAt)),
										),
										h(
											'div',
											{ className: 'gbt-rowactions', style: { opacity: 1 } },
											h(
												'button',
												{
													type: 'button',
													className: 'gbt-btn',
													'data-size': 'sm',
													onClick: () => props.onOpen(task.id),
												},
												t('edit'),
											),
										),
									),
								),
							)
				const queueBlock =
					queued.length === 0
						? h('p', { className: 'gbt-help', style: { padding: '12px 8px' } }, t('queueEmpty'))
						: queued.map((task, index) =>
								h(Row, {
									key: task.id,
									task: task,
									t: t,
									now: props.now,
									locks: task.assignee
										? tcLocksOf(snapshot.locks, task.assignee.name)
										: null,
									onOpen: props.onOpen,
									actions: [
										h(
											'button',
											{
												key: 'up',
												type: 'button',
												className: 'gbt-btn',
												'data-size': 'sm',
												'data-variant': 'ghost',
												disabled: index === 0,
												title: t('moveUp'),
												onClick: () => props.onMove(task.id, 'up'),
											},
											'↑',
										),
										h(
											'button',
											{
												key: 'down',
												type: 'button',
												className: 'gbt-btn',
												'data-size': 'sm',
												'data-variant': 'ghost',
												disabled: index === queued.length - 1,
												title: t('moveDown'),
												onClick: () => props.onMove(task.id, 'down'),
											},
											'↓',
										),
										h(
											'button',
											{
												key: 'top',
												type: 'button',
												className: 'gbt-btn',
												'data-size': 'sm',
												'data-variant': 'ghost',
												disabled: index === 0,
												title: t('pinTop'),
												onClick: () => props.onMove(task.id, 'top'),
											},
											'⇤',
										),
										h(
											'button',
											{
												key: 'claim',
												type: 'button',
												className: 'gbt-btn',
												'data-size': 'sm',
												onClick: () => props.onClaim(task.id),
											},
											t('claim'),
										),
									],
								}),
							)
				return h(
					'div',
					null,
					draftBlock,
					h('div', { className: 'gbt-section' }, h('h3', null, t('queueQueued')), queueBlock),
				)
			}

			/** Task detail: actions, held file locks, fields, audit timeline. */
			function DetailView(props) {
				const t = props.t
				const task = props.task
				const snapshot = props.snapshot
				const lease = leaseState(task, props.now, t)
				const [evidence, setEvidence] = React.useState('')
				const [note, setNote] = React.useState('')
				// Whatever this task's agent currently holds, or is queued for.
				const agentLocks = task.assignee
					? tcLocksOf(snapshot.locks, task.assignee.name)
					: { held: [], waiting: [] }
				const actions = []
				function add(key, label, run, variant) {
					actions.push(
						h(
							'button',
							{
								key: key,
								type: 'button',
								className: 'gbt-btn',
								'data-variant': variant || null,
								onClick: run,
							},
							label,
						),
					)
				}
				if (task.status === 'draft') {
					add('publish', t('publish'), () => props.act.publish([task.id]), 'primary')
					add('edit', t('edit'), () => props.onEdit(task))
					add('remove', t('remove'), () => {
						props.act.remove(task.id)
						props.onBack()
					})
				} else if (task.status === 'queued') {
					add('claim', t('claim'), () => props.act.claim(task.id, '@you'), 'primary')
					add('unpublish', t('unpublish'), () => props.act.unpublish(task.id))
					add('edit', t('edit'), () => props.onEdit(task))
				} else if (task.status === 'claimed' || task.status === 'in_progress') {
					add('release', t('release'), () => props.act.release(task.id))
					add('block', t('block'), () => props.act.blocked(task.id, true, note || '人工标记阻塞'))
					add('edit', t('edit'), () => props.onEdit(task))
				} else if (task.status === 'blocked') {
					add('unblock', t('unblock'), () => props.act.blocked(task.id, false, '解除阻塞'), 'primary')
					add('edit', t('edit'), () => props.onEdit(task))
				} else if (task.status === 'review') {
					add('approve', t('approve'), () => props.act.setStatus(task.id, 'done', '验收通过'), 'primary')
					add('sendBack', t('sendBack'), () => props.act.setStatus(task.id, 'in_progress', '打回'))
					add('edit', t('edit'), () => props.onEdit(task))
				} else if (task.status === 'done') {
					add('reopen', t('reopen'), () => props.act.setStatus(task.id, 'queued', '重新打开'))
				} else if (task.status === 'cancelled') {
					add('reopen', t('reopen'), () => props.act.setStatus(task.id, 'draft', '重新打开'))
				}
				function section(title, body) {
					return h('div', { className: 'gbt-section' }, h('h3', null, title), body)
				}
				return h(
					'div',
					{ className: 'gbt-detail' },
					h(
						'button',
						{
							type: 'button',
							className: 'gbt-btn',
							'data-variant': 'ghost',
							'data-size': 'sm',
							onClick: props.onBack,
						},
						'← ' + t('back'),
					),
					h(
						'div',
						{ className: 'gbt-dhead' },
						h('span', { className: 'gbt-id' }, task.id),
						h('h2', { className: 'gbt-dtitle' }, task.title),
						h(Pill, { status: task.status, label: t(STATUS_KEY[task.status]) }),
					),
					h('div', { className: 'gbt-actions' }, actions),
					section(t('spec'), h('p', { className: 'gbt-prose' }, task.spec || t('noSpec'))),
					section(
						t('acceptance'),
						h('p', { className: 'gbt-prose' }, task.acceptance || t('noSpec')),
					),
					task.blockedBy.length > 0
						? section(
								t('depends'),
								h(
									'div',
									null,
									h('p', { className: 'gbt-help' }, t('blockedByHint')),
									task.blockedBy.map((id) =>
										h(
											'button',
											{
												key: id,
												type: 'button',
												className: 'gbt-chip',
												disabled: !snapshot.tasks.some((item) => item.id === id),
												onClick: () => props.onOpen(id),
											},
											id,
										),
									),
								),
							)
						: null,
					section(
						t('locks'),
						h(
							'div',
							null,
							h('p', { className: 'gbt-help' }, t('locksHint')),
							agentLocks.held.length === 0 && agentLocks.waiting.length === 0
								? h('p', { className: 'gbt-prose' }, t('locksNone'))
								: h(
										'div',
										null,
										agentLocks.held.map((path) =>
											h(
												'span',
												{ key: 'held-' + path, className: 'gbt-chip' },
												'🔒 ' + path,
											),
										),
										agentLocks.waiting.map((path) =>
											h(
												'span',
												{ key: 'wait-' + path, className: 'gbt-chip' },
												'⏳ ' + path,
											),
										),
									),
						),
					),
					section(
						t('owner'),
						h(
							'dl',
							{ className: 'gbt-kv' },
							h('dt', null, t('owner')),
							h(
								'dd',
								null,
								task.assignee
									? task.assignee.name + ' · ' + task.assignee.session
									: t('unassigned'),
								// Inert on purpose: jumping to the session needs the
								// Host half's session target, so the affordance is
								// shown disabled rather than faked.
								task.assignee
									? h(
											'button',
											{
												type: 'button',
												className: 'gbt-btn',
												'data-size': 'sm',
												'data-variant': 'ghost',
												style: { marginLeft: '8px' },
												disabled: true,
												title: t('openSessionHint'),
											},
											t('openSession'),
										)
									: null,
							),
							h('dt', null, t('lease')),
							h(
								'dd',
								null,
								lease ? lease.text : '—',
								lease && lease.warn === 'over'
									? h(
											'button',
											{
												type: 'button',
												className: 'gbt-btn',
												'data-size': 'sm',
												style: { marginLeft: '8px' },
												onClick: () => props.act.release(task.id),
											},
											t('reclaim'),
										)
									: null,
							),
							h('dt', null, t('createdAt')),
							h('dd', null, shortAgo(task.createdAt)),
							h('dt', null, t('updatedAt')),
							h('dd', null, shortAgo(task.updatedAt)),
							task.planRef
								? h('dt', { key: 'plan-k' }, t('plan'))
								: null,
							task.planRef
								? h('dd', { key: 'plan-v', className: 'gbt-code' }, task.planRef)
								: null,
						),
					),
					section(
						t('evidence'),
						h(
							'div',
							null,
							h('p', { className: 'gbt-prose' }, task.evidence || t('noSpec')),
							task.status === 'claimed' || task.status === 'in_progress'
								? h(
										'div',
										null,
										h('textarea', {
											className: 'gbt-area',
											placeholder: t('evidence'),
											value: evidence,
											onChange: (event) => setEvidence(event.target.value),
										}),
										h(
											'div',
											{ className: 'gbt-actions' },
											h(
												'button',
												{
													type: 'button',
													className: 'gbt-btn',
													'data-variant': 'primary',
													disabled: evidence.trim().length === 0,
													onClick: () => props.act.complete(task.id, evidence.trim()),
												},
												t('complete'),
											),
											h('input', {
												className: 'gbt-input',
												style: { maxWidth: '280px' },
												placeholder: t('block'),
												value: note,
												onChange: (event) => setNote(event.target.value),
											}),
										),
									)
								: null,
						),
					),
					section(
						t('history'),
						h(
							'ul',
							{ className: 'gbt-tl' },
							task.history
								.slice()
								.reverse()
								.map((item, index) =>
									h(
										'li',
										{ key: String(task.history.length - index) },
										h('time', null, shortAgo(item.at)),
										h(
											'span',
											null,
											(item.from ? t(STATUS_KEY[item.from]) + ' → ' : '') +
												(item.to ? t(STATUS_KEY[item.to]) : '') +
												' · ' +
												item.by +
												(item.note ? ' · ' + item.note : ''),
										),
									),
								),
						),
					),
				)
			}

			/** Create/edit form. Saving a new task always files a draft. */
			function FormView(props) {
				const t = props.t
				const task = props.task
				const [title, setTitle] = React.useState(task ? task.title : '')
				const [spec, setSpec] = React.useState(task ? task.spec : '')
				const [acceptance, setAcceptance] = React.useState(task ? task.acceptance : '')
				const [planRef, setPlanRef] = React.useState(task ? task.planRef : '')
				const [depends, setDepends] = React.useState(task ? task.blockedBy.join(', ') : '')
				const invalid = title.trim().length === 0
				function save() {
					if (invalid) return
					const input = {
						title: title.trim(),
						spec: spec.trim(),
						acceptance: acceptance.trim(),
						planRef: planRef.trim(),
						blockedBy: fromCommas(depends),
						priority: task ? task.priority : 'normal',
					}
					if (task) props.act.update(task.id, input)
					else props.act.create(input)
					props.onDone()
				}
				function field(key, label, control, help) {
					return h(
						'div',
						{ className: 'gbt-field', key: key },
						h('label', { className: 'gbt-label', htmlFor: 'gbt-' + key }, label),
						control,
						help ? h('p', { className: 'gbt-help' }, help) : null,
					)
				}
				return h(
					'div',
					{ className: 'gbt-form' },
					h('h2', { className: 'gbt-dtitle', style: { paddingBottom: '6px' } }, t(task ? 'formEdit' : 'formNew')),
					field(
						'title',
						t('formTitle'),
						h('input', {
							id: 'gbt-title',
							className: 'gbt-input',
							value: title,
							onChange: (event) => setTitle(event.target.value),
						}),
						invalid ? t('formRequired') : null,
					),
					field(
						'spec',
						t('formSpec'),
						h('textarea', {
							id: 'gbt-spec',
							className: 'gbt-area',
							value: spec,
							onChange: (event) => setSpec(event.target.value),
						}),
					),
					field(
						'acceptance',
						t('formAcceptance'),
						h('textarea', {
							id: 'gbt-acceptance',
							className: 'gbt-area',
							value: acceptance,
							onChange: (event) => setAcceptance(event.target.value),
						}),
					),
					field(
						'plan',
						t('formPlan'),
						h('input', {
							id: 'gbt-plan',
							className: 'gbt-input',
							value: planRef,
							onChange: (event) => setPlanRef(event.target.value),
						}),
					),
					field(
						'depends',
						t('formDepends'),
						h('input', {
							id: 'gbt-depends',
							className: 'gbt-input',
							value: depends,
							onChange: (event) => setDepends(event.target.value),
						}),
						t('formDependsHint'),
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
								disabled: invalid,
								onClick: save,
							},
							t('formSave'),
						),
						h(
							'button',
							{
								type: 'button',
								className: 'gbt-btn',
								onClick: props.onDone,
							},
							t('formCancel'),
						),
						invalid ? h('p', { className: 'gbt-problem' }, t('formRequired')) : null,
					),
				)
			}

			/**
			 * File locks: who is writing what, and who is waiting in line.
			 *
			 * The rule the agents follow is a protocol, not a kernel lock, so this
			 * view IS the enforcement story: a held file says so, and the wait
			 * list is visible to everyone before they start. The list is ordered
			 * contended-first, and the head of each queue is marked as the next
			 * winner, because "longest wait takes it" is the whole arbitration
			 * rule and it should be readable without knowing the rule.
			 */
			function FilesView(props) {
				const t = props.t
				const snapshot = props.snapshot
				const rank = (entry) =>
					entry.holder !== null && entry.queue.length > 0
						? 0
						: entry.holder !== null
							? 1
							: entry.queue.length > 0
								? 2
								: 3
				const paths = Object.keys(snapshot.locks).sort((a, b) => {
					const delta = rank(snapshot.locks[a]) - rank(snapshot.locks[b])
					return delta !== 0 ? delta : a.localeCompare(b)
				})
				return h(
					'div',
					{ className: 'gbt-detail' },
					h('h2', { className: 'gbt-dtitle' }, t('locks')),
					h('p', { className: 'gbt-help' }, t('locksPageHint')),
					paths.map((path) => {
						const entry = snapshot.locks[path]
						const waitlist = entry.queue.slice().sort((a, b) => a.since - b.since)
						return h(
							'div',
							{ className: 'gbt-lockrow', key: path },
							h('span', { className: 'gbt-lockpath' }, path),
							h(
								'div',
								{ className: 'gbt-lockmeta' },
								entry.holder !== null
									? h(
											'span',
											{ className: 'gbt-lock', 'data-state': 'held' },
											'🔒 ' +
												entry.holder +
												(entry.taskId ? ' · ' + entry.taskId : '') +
												' · ' +
												shortAgo(entry.since),
										)
									: h(
											'span',
											{ className: 'gbt-lock', 'data-state': 'free' },
											t('lockFree'),
										),
								waitlist.length > 0
									? h(
											'ul',
											{ className: 'gbt-waitlist' },
											waitlist.map((waiter, index) =>
												h(
													'li',
													{ key: waiter.who },
													(index === 0 ? '① ' : '· ') +
														waiter.who +
														(index === 0 ? ' ' + t('lockNext') : '') +
														' · ' +
														t('lockWaited') +
														' ' +
														shortAgo(waiter.since),
												),
											),
										)
									: null,
								h(
									'span',
									{ className: 'gbt-actions', style: { padding: '4px 0 0' } },
									entry.holder !== null
										? h(
												'button',
												{
													type: 'button',
													className: 'gbt-btn',
													'data-size': 'sm',
													onClick: () => props.onRelease(path, entry.holder),
												},
												t('lockRelease'),
											)
										: h(
												'button',
												{
													type: 'button',
													className: 'gbt-btn',
													'data-size': 'sm',
													onClick: () => props.onSimTake(path),
												},
												t('lockSimTake'),
											),
									entry.holder !== null
										? h(
												'button',
												{
													type: 'button',
													className: 'gbt-btn',
													'data-size': 'sm',
													'data-variant': 'ghost',
													title: t('lockForceHint'),
													onClick: () => props.onForce(path),
												},
												t('lockForce'),
											)
										: null,
								),
							),
						)
					}),
				)
			}

			/** Panel root: owns navigation state, renders one view at a time. */
			function TaskCenter() {
				const t = useTranslate()
				const snapshot = useTasks(store)
				const now = useNow(15000)
				const [view, setView] = React.useState('board')
				const [selectedId, setSelectedId] = React.useState(null)
				const [editing, setEditing] = React.useState(null)
				const [open, setOpen] = React.useState(TC_OPEN)
				const [selection, setSelection] = React.useState(() => new Set())

				const selected = snapshot.tasks.filter((task) => task.id === selectedId)[0] || null
				const counts = {
					queued: snapshot.tasks.filter((task) => task.status === 'queued').length,
					active: snapshot.tasks.filter(tcActive).length,
					blocked: snapshot.tasks.filter((task) => task.status === 'blocked').length,
					review: snapshot.tasks.filter((task) => task.status === 'review').length,
					done: snapshot.tasks.filter((task) => task.status === 'done').length,
				}
				function openTask(id) {
					setSelectedId(id)
					setEditing(null)
				}
				function toggleGroup(id) {
					setOpen(Object.assign({}, open, { [id]: open[id] === false }))
				}
				function tab(id, label) {
					return h(
						'button',
						{
							type: 'button',
							className: 'gbt-tab',
							'aria-current': view === id && selected === null && editing === null ? 'page' : null,
							onClick: () => {
								setView(id)
								setSelectedId(null)
								setEditing(null)
							},
						},
						label,
					)
				}
				/** Render the store's last event code as a sentence. */
				function eventText(event) {
					if (!event) return ''
					if (event.kind === 'claimed') return t('simClaimed') + ' ' + event.id
					if (event.kind === 'lease') return t('simLease') + ' ' + event.id
					if (event.kind === 'released') {
						return t('releaseSelected') + ' ' + (event.ids || []).join(', ')
					}
					if (event.kind === 'took') return t('lockTook') + ' ' + event.who + ' · ' + event.path
					if (event.kind === 'reserved') {
						return t('lockReserved') + ' ' + event.who + ' · ' + event.path
					}
					if (event.kind === 'granted') return t('lockGranted') + ' ' + event.who + ' · ' + event.path
					if (event.kind === 'freed') return t('lockFreed') + ' ' + event.path
					return t('simIdle')
				}
				let body = null
				if (editing !== null) {
					body = h(FormView, {
						t: t,
						task: editing === 'new' ? null : editing,
						act: store,
						onDone: () => {
							setEditing(null)
						},
					})
				} else if (selected !== null) {
					body = h(DetailView, {
						t: t,
						task: selected,
						snapshot: snapshot,
						now: now,
						act: store,
						onBack: () => setSelectedId(null),
						onOpen: openTask,
						onEdit: (task) => setEditing(task),
					})
				} else if (view === 'queue') {
					body = h(QueueView, {
						t: t,
						snapshot: snapshot,
						now: now,
						selection: selection,
						onSelection: setSelection,
						onOpen: openTask,
						onMove: (id, direction) => store.move(id, direction),
						onClaim: (id) => store.claim(id, '@you'),
						onPublish: (ids) => store.publish(ids),
					})
				} else if (view === 'files') {
					body = h(FilesView, {
						t: t,
						snapshot: snapshot,
						onRelease: (path, who) => store.releaseLock(path, who),
						onForce: (path) => store.forceRelease(path),
						onSimTake: (path) => store.acquireLock(path, '@sim-1', null),
					})
				} else if (view === 'archive') {
					body = h(BoardView, {
						t: t,
						snapshot: snapshot,
						now: now,
						open: open,
						flat: true,
						groups: TC_GROUPS.filter((group) => group.id === 'done'),
						onToggle: toggleGroup,
						onOpen: openTask,
						onReset: () => store.reset(),
					})
				} else {
					body = h(BoardView, {
						t: t,
						snapshot: snapshot,
						now: now,
						open: open,
						onToggle: toggleGroup,
						onOpen: openTask,
						onReset: () => store.reset(),
					})
				}
				return h(
					'div',
					{ className: 'gbt-root' },
					h(
						'div',
						{ className: 'gbt-head' },
						h('span', { className: 'gbt-title' }, t('nav')),
						h(
							'div',
							{ className: 'gbt-tabs', role: 'tablist' },
							tab('board', t('tabList')),
							tab('queue', t('tabQueue')),
							tab('files', t('tabFiles')),
							tab('archive', t('tabArchive')),
						),
						h('span', { className: 'gbt-spacer' }),
						h(
							'button',
							{
								type: 'button',
								className: 'gbt-btn',
								'data-size': 'sm',
								onClick: () => store.simulate(),
							},
							t('simulate'),
						),
						h(
							'button',
							{
								type: 'button',
								className: 'gbt-btn',
								'data-size': 'sm',
								'data-variant': 'ghost',
								onClick: () => store.reset(),
							},
							t('reset'),
						),
						h(
							'button',
							{
								type: 'button',
								className: 'gbt-btn',
								'data-variant': 'primary',
								onClick: () => {
									setSelectedId(null)
									setEditing('new')
								},
							},
							'+ ' + t('newTask'),
						),
					),
					h(
						'div',
						{ className: 'gbt-stats' },
						h('span', { className: 'gbt-stat' }, t('statQueued'), ' ', h('b', null, String(counts.queued))),
						h('span', { className: 'gbt-stat' }, t('statActive'), ' ', h('b', null, String(counts.active))),
						h('span', { className: 'gbt-stat' }, t('statBlocked'), ' ', h('b', null, String(counts.blocked))),
						h('span', { className: 'gbt-stat' }, t('statReview'), ' ', h('b', null, String(counts.review))),
						h('span', { className: 'gbt-stat' }, t('statDone'), ' ', h('b', null, String(counts.done))),
						h('span', { className: 'gbt-spacer' }),
						h('span', { className: 'gbt-scope', title: snapshot.scopePath }, snapshot.scopePath),
					),
					h(
						'div',
						{ className: 'gbt-note' },
						t('prototype') +
							(snapshot.lastEvent ? ' · ' + t('lastEvent') + ': ' + eventText(snapshot.lastEvent) : ''),
					),
					h('div', { className: 'gbt-body' }, body),
				)
			}

			/** Rail glyph: the host draws the button, so this is strokes only. */
			function Glyph(props) {
				const size = typeof props.size === 'number' ? props.size : 18
				const active = props.active === true
				return h(
					'svg',
					{
						className: 'gbt-glyph',
						width: size,
						height: size,
						viewBox: '0 0 16 16',
						fill: 'none',
						'aria-hidden': 'true',
					},
					h('rect', {
						x: 1.75,
						y: 2.25,
						width: 12.5,
						height: 11.5,
						rx: 2.25,
						stroke: 'currentColor',
						strokeWidth: active ? 1.6 : 1.3,
					}),
					h('path', {
						d: 'M5 6.4h6M5 9.6h3.6',
						stroke: 'currentColor',
						strokeWidth: 1.3,
						strokeLinecap: 'round',
					}),
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
			/** Cordis services this browser half needs; `slots` is mandatory here. */
			inject: ['slots', 'locale'],
			/**
			 * Register the bundle's configuration section while the runtime serves
			 * the 0.2 settings-form service, and keep the plugin's copy in the locale
			 * service for as long as the browser half is loaded.
			 * @param ctx - the browser plugin's context.
			 */
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
				// `configForms` exists only where the Plugins page can carry a settings
				// form (DSH 0.2+); without it this half stays inert instead of rendering
				// a form that could not save. `slots.inject` itself is a fiber-owned
				// effect, so unloading the row withdraws the section.
				ctx.inject(['configForms'], (forms) => {
					const scope = forms.configForms.get(ENTRY_NS)
					ctx.slots.inject('plugins.bundle.config', () =>
						ctx.slots.register(
							// Keyed by the bundle's package name: that is the key the page
							// dispatches when it opens this bundle's card.
							{ name: 'plugins.bundle.config', key: 'godot-bridge', locale: LOCALE_NS },
							formFor(scope),
						),
					)
				})

				// ── task center prototype ───────────────────────────────────
				// A rail glyph plus the keyed `main` occupant it selects. The
				// host draws the rail button (label, aria-label, aria-current,
				// hover) and calls `layout.selectPanel('task-center')` on click,
				// so this half supplies strokes and the panel body only. The
				// surviving `main` key set is derived from its own keyed entries
				// (ui-layout `retainMainPanels`), so the id cannot be reset out
				// from under us.
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
					// The store is created per activation, so unloading the plugin
					// never carries state across a reload.
					const store = createTaskStore()
					const views = createTaskCenterViews(ctx, store)
					const dropGlyph = ctx.slots.inject('sidebar.panellist', () =>
						ctx.slots.register(
							{
								name: 'sidebar.panellist',
								id: 'task-center',
								order: 30,
								// Rebound on every read, so the tooltip follows the locale.
								label: () => ctx.locale.bind(TC_NS)('nav'),
								locale: TC_NS,
							},
							views.Glyph,
						),
					)
					const dropPanel = ctx.slots.inject('main', () =>
						ctx.slots.register(
							{ name: 'main', key: 'task-center', locale: TC_NS },
							views.TaskCenter,
						),
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
