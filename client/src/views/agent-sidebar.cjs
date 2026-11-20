/**
 * Agent sidebar tab (T-209).
 *
 * The task center can open the AGENT behind a card in DSH's native right
 * sidebar. This module owns everything that needs the host's optional sidebar
 * services:
 *
 *   - one custom tab kind/id ('godot-bridge-agent' / 'godot-bridge/agent'),
 *     registered through `sidebarRightTabs`; the body and title are OUR React
 *     components registered into 'sidebar.right.pane.tab' and ...'.title';
 *   - `openIn(sessionId)`, the one call the card/detail entry uses, which
 *     forwards to `sidebarRight.openTabIn(sessionId, kind)`;
 *   - the tab body/title: agent name, role, status, task id, stage and the
 *     latest activity of the session, read from the SHARED task store.
 *
 * The host services are OPTIONAL. A shell without them never mounts, `available()`
 * stays false, `openIn()` returns false without throwing, and the card/detail
 * hide their entry instead of rendering a dead button.
 *
 * The session id is never minted here: it comes from the card's own
 * `assignee.session` (or the owning session when no executor is recorded).
 * The panel's window fallback session is deliberately NOT used.
 */
const AGENT_TAB_KIND = 'godot-bridge-agent'
const AGENT_TAB_ID = 'godot-bridge/agent'
const AGENT_TAB_BODY_SLOT = 'sidebar.right.pane.tab'
const AGENT_TAB_TITLE_SLOT = 'sidebar.right.pane.tab.title'
const AGENT_TAB_OPEN_ACTION = 'open-agent-sidebar'
const AGENT_TAB_GUIDE_ORDER = 60
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
	'.gbt-agenttabtitle{display:inline-flex;align-items:center;gap:5px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}\n'

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

/** The executor session recorded on the card, or null. */
function assignedSessionOf(task) {
	const assignee = isRecord(task) ? task.assignee : null
	return isRecord(assignee) ? textOf(assignee.session) : null
}

/**
 * The REAL host session a card belongs to: the executor's session when one was
 * recorded, else the owning session. Nothing is minted and no panel fallback
 * session is used, so a card without a recorded session has no entry.
 */
function agentSessionOf(task) {
	if (isRecord(task) !== true) return null
	const assigned = assignedSessionOf(task)
	if (assigned !== null) return assigned
	return textOf(task.ownerSession)
}

/** Every session the card names: worker, owner, and the review/test deliverers. */
function sessionsOfTask(task) {
	const ids = []
	const push = function (value) {
		const text = textOf(value)
		if (text !== null && ids.indexOf(text) < 0) ids.push(text)
	}
	if (isRecord(task) !== true) return ids
	push(assignedSessionOf(task))
	push(task.ownerSession)
	if (isRecord(task.review) && isRecord(task.review.deliveredTo)) push(task.review.deliveredTo.id)
	if (isRecord(task.test) && isRecord(task.test.deliveredTo)) push(task.test.deliveredTo.id)
	return ids
}

/** The most relevant card for a session: assigned first, active, then newest. */
function taskForSession(snapshot, sessionId) {
	if (snapshot === null || snapshot === undefined || Array.isArray(snapshot.tasks) !== true) return null
	const tasks = snapshot.tasks.filter(function (task) {
		return isRecord(task) && String(task.id === undefined || task.id === null ? '' : task.id) !== ''
	})
	const related = tasks.filter(function (task) { return sessionsOfTask(task).indexOf(sessionId) >= 0 })
	if (related.length === 0) return null
	const assigned = related.filter(function (task) { return assignedSessionOf(task) === sessionId })
	const active = related.filter(function (task) { return task.status === 'running' || task.status === 'reviewing' || task.status === 'testing' })
	const pool = assigned.length > 0 ? assigned : active.length > 0 ? active : related
	return pool.slice().sort(function (left, right) {
		return timeOf(right.updatedAt) - timeOf(left.updatedAt)
	})[0]
}

/** The live tree agent for a session, when the host reports the tree. */
function treeAgentOf(snapshot, sessionId, tcAgentTreeOf) {
	if (typeof tcAgentTreeOf !== 'function' || snapshot === null || snapshot === undefined) return null
	let tree = null
	try {
		tree = tcAgentTreeOf(snapshot)
	} catch (error) {
		tree = null
	}
	if (!isRecord(tree)) return null
	if (isRecord(tree.root) && tree.root.id === sessionId) return tree.root
	const members = Array.isArray(tree.members) ? tree.members : []
	for (const member of members) {
		if (isRecord(member) && member.id === sessionId) return member
	}
	return null
}

function roleLabelOf(role, t) {
	if (role === 'lead' || role === 'root') return t('agentRootRole')
	const key = ROLE_LABEL_KEYS[role]
	if (key === undefined) return typeof role === 'string' && role !== '' ? role : '—'
	return t(key)
}

/** The role a card's stage makes the session responsible for (no roster guess). */
function roleOfSession(task, sessionId) {
	if (isRecord(task) !== true) return null
	if (assignedSessionOf(task) === sessionId) return 'worker'
	if (isRecord(task.review) && isRecord(task.review.deliveredTo) && task.review.deliveredTo.id === sessionId) return 'reviewer'
	if (isRecord(task.test) && isRecord(task.test.deliveredTo) && task.test.deliveredTo.id === sessionId) return 'tester'
	if (textOf(task.ownerSession) === sessionId) return 'lead'
	return null
}

/** A status only when the card's own stage records prove the session is live. */
function stageStatusOf(task, sessionId) {
	if (isRecord(task) !== true) return 'unknown'
	if (task.status === 'running' && assignedSessionOf(task) === sessionId) return 'running'
	if (task.status === 'reviewing' && isRecord(task.review) && isRecord(task.review.deliveredTo) && task.review.deliveredTo.id === sessionId) return 'running'
	if (task.status === 'testing' && isRecord(task.test) && isRecord(task.test.deliveredTo) && task.test.deliveredTo.id === sessionId) return 'running'
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
 */
function agentInfoOf(snapshot, sessionId, t, now, helpers) {
	const tool = isRecord(helpers) ? helpers : {}
	const tcAgentTreeOf = tool.tcAgentTreeOf
	const tcPhaseLabel = typeof tool.tcPhaseLabel === 'function' ? tool.tcPhaseLabel : function (task) { return task !== null && task !== undefined && typeof task.status === 'string' ? task.status : '—' }
	const tcAgo = typeof tool.tcAgo === 'function' ? tool.tcAgo : function () { return '—' }
	const tcAgentStatusKey = typeof tool.tcAgentStatusKey === 'function' ? tool.tcAgentStatusKey : function () { return 'agentStatusUnknown' }
	const treeAgent = treeAgentOf(snapshot, sessionId, tcAgentTreeOf)
	let task = taskForSession(snapshot, sessionId)
	if (treeAgent !== null && typeof treeAgent.taskId === 'string' && treeAgent.taskId !== '' && snapshot !== null && snapshot !== undefined && Array.isArray(snapshot.tasks)) {
		const linked = snapshot.tasks.filter(function (entry) { return isRecord(entry) && entry.id === treeAgent.taskId })[0]
		if (linked !== undefined) task = linked
	}
	const assigned = task !== null && isRecord(task.assignee) ? task.assignee : null
	const assignedName = assigned !== null && assigned.session === sessionId ? textOf(assigned.name) : null
	let name = treeAgent !== null ? textOf(treeAgent.name) : null
	if (name === null) name = assignedName
	if (name === null) name = sessionShort(sessionId)
	let role = treeAgent !== null ? textOf(treeAgent.role) : null
	if (role === null) role = roleOfSession(task, sessionId)
	const reported = treeAgent !== null ? textOf(treeAgent.status) : null
	const status = reported !== null ? reported : stageStatusOf(task, sessionId)
	const taskId = task !== null && task.id !== undefined && task.id !== null ? String(task.id) : treeAgent !== null && typeof treeAgent.taskId === 'string' ? treeAgent.taskId : null
	return {
		sessionId: sessionId,
		sessionShort: sessionShort(sessionId),
		name: name,
		role: role,
		roleLabel: roleLabelOf(role, t),
		status: status,
		statusPill: statusPillOf(status),
		statusLabelKey: tcAgentStatusKey(status),
		taskId: taskId,
		taskTitle: task !== null && typeof task.title === 'string' ? task.title : '',
		stage: task !== null ? tcPhaseLabel(task, t) : t('agentTabNoTask'),
		activity: activityOf(snapshot, task, now, tcAgo),
	}
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
		const sessionId = props !== null && props !== undefined && typeof props.sessionId === 'string' ? props.sessionId.trim() : ''
		const label = sessionId === '' ? t('agentTabTitle') : agentInfoOf(snapshot, sessionId, t, Date.now(), selectors).name
		return h('span', { className: 'gbt-agenttabtitle', 'data-agent-tab': 'title', 'data-agent-session': sessionId }, h(AgentTabIcon, { size: 13 }), h('span', null, label))
	}

	function AgentTabBody(props) {
		const t = useTranslate()
		const snapshot = useSnapshot()
		const now = useNow()
		const sessionId = props !== null && props !== undefined && typeof props.sessionId === 'string' ? props.sessionId.trim() : ''
		if (sessionId === '') {
			return h(
				'div',
				{ className: 'gbt-agenttab', 'data-agent-tab': 'body', 'data-agent-session': '' },
				h('div', { className: 'gbt-agenttabhead' }, h(AgentTabIcon, { size: 14 }), h('b', null, t('agentTabTitle'))),
				h('p', { className: 'gbt-footnote' }, t('agentTabNoSession')),
			)
		}
		const info = agentInfoOf(snapshot, sessionId, t, now, selectors)
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
		const slots = isRecord(scope) && isRecord(scope.slots) ? scope.slots : isRecord(opts.slots) ? opts.slots : null
		if (!isRecord(sidebar) || typeof sidebar.openTabIn !== 'function') return noop
		if (!isRecord(tabs) || typeof tabs.register !== 'function') return noop
		if (!isRecord(slots) || typeof slots.inject !== 'function' || typeof slots.register !== 'function') return noop
		context = {
			store: opts.store === undefined ? null : opts.store,
			locale: opts.locale === undefined ? null : opts.locale,
			ns: typeof opts.ns === 'string' ? opts.ns : '',
			taskNs: typeof opts.taskNs === 'string' ? opts.taskNs : '',
		}
		runtime = { sidebar: sidebar }
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

	function openIn(sessionId) {
		const value = typeof sessionId === 'string' ? sessionId.trim() : ''
		if (value === '' || mounted !== true || disposed === true) return false
		const sidebar = runtime !== null ? runtime.sidebar : null
		if (!isRecord(sidebar) || typeof sidebar.openTabIn !== 'function') return false
		try {
			sidebar.openTabIn(value, AGENT_TAB_KIND)
			return true
		} catch (error) {
			return false
		}
	}

	const api = {
		kind: AGENT_TAB_KIND,
		id: AGENT_TAB_ID,
		action: AGENT_TAB_OPEN_ACTION,
		sessionOf: agentSessionOf,
		infoOf: function (snapshot, sessionId, t, now) {
			return agentInfoOf(snapshot, sessionId, t, now, selectors)
		},
		Title: AgentTabTitle,
		Body: AgentTabBody,
		mount: mount,
		dispose: dispose,
		isMounted: function () {
			return mounted === true && disposed !== true && bound === api
		},
		openIn: openIn,
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

/** Open the agent tab for a REAL session; false (never a throw) when unavailable. */
function openIn(sessionId) {
	return bound === null ? false : bound.openIn(sessionId)
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
