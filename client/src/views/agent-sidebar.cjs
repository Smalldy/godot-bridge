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
 *   - the body's three stage rows (T-219), one each for the card's develop,
 *     review and test sessions; each row asks the host's
 *     `uiWorkspace.openSession(sessionId)` to switch the main view to THAT
 *     stage's subagent conversation.
 *
 * The host services are OPTIONAL. A shell without the sidebar services never
 * mounts, `available()` stays false, `openIn()` returns false without throwing,
 * and the card/detail hide their entry instead of rendering a dead button. A
 * mounted tab without `uiWorkspace` still renders its overview; the three stage
 * rows are then disabled with an explanation instead of disappearing.
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
 *   - the overview's conversation switch (T-219: one per stage row) switches
 *     the main session to the SUBAGENT, and the right sidebar then belongs to
 *     that new session. Tabs opened in the host session are not carried across
 *     sessions; the copy says so instead of promising a tab that stays visible.
 *
 * T-219 — three stage rows instead of one conversation switch:
 *
 *   - after the exact card is resolved, the develop/review/test rows take their
 *     sessions from `task.assignee.session`, `task.review.deliveredTo.id` and
 *     `task.test.deliveredTo.id`. A stage with no recorded session keeps its
 *     row but shows "not assigned" and a disabled action: no id is minted and
 *     no other card's session is borrowed;
 *   - each row shows the stage, the agent and the live status, and its "open
 *     conversation" action switches the main view to THAT row's session. One
 *     session may back two rows (a reused session); each row still opens its own
 *     stage's session, and a tab only ever reads ITS card;
 *   - the top (agent name, role, status, card, stage, latest activity) is
 *     unchanged. Without `uiWorkspace` the rows are disabled and a note says
 *     why, rather than silently dropping the entries.
 *
 * T-227 — a tab follows the board by itself:
 *
 *   - the body used to only SUBSCRIBE to the shared store, so a tab opened
 *     before a reviewer was delivered kept showing "not assigned" until some
 *     other surface polled. A mounted body now refreshes the shared store once
 *     at mount and then every 5 s while the document is visible: a hidden tab
 *     pauses its timer, and a tab that becomes visible again refreshes at once
 *     instead of waiting up to 5 s;
 *   - cleanup clears only the timer THIS tab created and never calls
 *     `store.stopPolling`: the panel's own poll is not this tab's to stop, and
 *     the tab is not a second global poller either;
 *   - a failed poll clears the board (`tasks: []`, `source: 'error'`) in two
 *     shapes: the offline/catch branch copies the last snapshot and keeps its
 *     project, while the payload branch is built from the host error body and
 *     has NO project. Rendering either literally erases the card, the stage
 *     rows and the delivered reviewer. The tab therefore renders the last GOOD
 *     snapshot for a failure of the project it already shows, and drops that
 *     snapshot as soon as another project is seen, so a project switch never
 *     replays the previous project's card.
 *
 * T-234 — the tab reads ONE card, never the board:
 *
 *   - a mounted body no longer refreshes the shared board through the store's
 *     load(). It asks the domain store for exactly what it renders:
 *     `ensureTaskDetail(taskId)` (the card's own /task detail) and
 *     `ensureAgents()` (the meta domain's agent tree), at mount and every 5 s
 *     while the document is visible. A hidden tab pauses;
 *     unmount clears only its own timer and visibility listener; the panel's
 *     poll is never started or stopped from here;
 *   - the card, the three stage rows and the title read the DETAIL first
 *     (`getTaskDetail(taskId)`), so a review/test deliveredTo that lands while
 *     the panel shows the agent conversation still reaches the tab, and a failed
 *     detail keeps the last good card. Nothing is minted: a card that left the
 *     board keeps its id with no stage;
 *   - the live agent tree comes from the agents domain (`agentsView()`), with the
 *     board snapshot as the fallback for a store without the domains or a tab
 *     opened before the agents answer landed.
 */
const AGENT_TAB_KIND = 'godot-bridge-agent'
const AGENT_TAB_ID = 'godot-bridge/agent'
const AGENT_TAB_BODY_SLOT = 'sidebar.right.pane.tab'
const AGENT_TAB_TITLE_SLOT = 'sidebar.right.pane.tab.title'
const AGENT_TAB_OPEN_ACTION = 'open-agent-sidebar'
const AGENT_TAB_GUIDE_ORDER = 60
// T-227/T-234: how often a VISIBLE tab refreshes its OWN domains (the card's
// detail and the agents block) on its own.
const AGENT_TAB_SYNC_MS = 5000
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
		agentStagesTitle: '阶段会话',
		agentStageDevelop: '开发',
		agentStageReview: '评审',
		agentStageTest: '测试',
		agentStageOpen: '打开对话',
		agentStageOpenHint: '在主页打开这个阶段的子代理对话；主会话会切到子代理，右侧栏属于新会话',
		agentStageNoSession: '未分配',
		agentStageNoSessionHint: '这个阶段还没有会话',
		agentStageUnavailable: '不可用',
		agentStageNoWorkspace: '当前宿主没有切换会话的服务，三行阶段入口都不可用',
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
		agentStagesTitle: 'Stage sessions',
		agentStageDevelop: 'Develop',
		agentStageReview: 'Review',
		agentStageTest: 'Test',
		agentStageOpen: 'Open conversation',
		agentStageOpenHint: 'Open this stage\'s subagent conversation in the main view; the main session switches to the subagent, so the sidebar belongs to the new session',
		agentStageNoSession: 'Not assigned',
		agentStageNoSessionHint: 'No session for this stage yet',
		agentStageUnavailable: 'Unavailable',
		agentStageNoWorkspace: 'This host cannot switch conversations, so the three stage entries are disabled',
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
	// T-219: three stage rows (develop/review/test), each with its own compact
	// action. The agent name is the only flexible cell: it ellipsizes, the pill is
	// capped and the row clips, so three rows never widen the tab.
	'.gbt-agenttabstages{display:flex;flex-direction:column;gap:4px;min-width:0}\n' +
	'.gbt-agenttabstage{display:flex;align-items:center;gap:6px;min-width:0;overflow:hidden;padding:4px 6px;border:0.5px solid var(--dsw-alias-border-l4);border-radius:8px;background:var(--dsw-alias-bg-layer-2)}\n' +
	'.gbt-agenttabstage[data-agent-stage-has-session="false"]{background:transparent;border-style:dashed}\n' +
	'.gbt-agenttabstagelabel{flex:none;font-size:11px;font-weight:600;color:var(--dsw-alias-label-secondary)}\n' +
	'.gbt-agenttabstagename{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11.5px}\n' +
	'.gbt-agenttabstagenone{font-weight:400;color:var(--dsw-alias-label-tertiary)}\n' +
	'.gbt-agenttabstage .gbt-pill{flex:none;max-width:72px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}\n' +
	'.gbt-agenttabstagebtn{flex:none;height:22px;padding:0 8px;border:0.5px solid var(--dsw-alias-border-l4);border-radius:6px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font:inherit;font-size:11px;cursor:pointer;white-space:nowrap}\n' +
	'.gbt-agenttabstagebtn:hover:not(:disabled){background:var(--dsw-alias-bg-module-platform)}\n' +
	'.gbt-agenttabstagebtn:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}\n' +
	'.gbt-agenttabstagebtn:disabled{cursor:not-allowed;opacity:.55}\n' +
	// T-218/T-219: a stage switch changes the main session, so the sidebar that
	// follows belongs to the subagent; the note spells that out instead of letting
	// the user expect this session's tab strip to travel along.
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

/** T-227: a background document must not keep polling; nobody is looking. */
function tabIsHidden() {
	return typeof document !== 'undefined' && document !== null && document.visibilityState === 'hidden'
}

/**
 * T-227: is this a failed poll? The shared store marks BOTH failure branches
 * with `source: 'error'` (client/src/store.cjs):
 *
 *   - the offline/catch branch copies the last snapshot, so it keeps the
 *     project and the previous `receivedAt`;
 *   - the payload branch builds a snapshot from the host error body, which has
 *     no project, and tcSnapshot only keeps a string project — so that shape has
 *     `project: null` (and the previous `receivedAt` too).
 *
 * Both clear `tasks`, which is why a literal render blanks the tab.
 */
function failedSnapshotOf(snapshot) {
	return isRecord(snapshot) && snapshot.source === 'error'
}

function projectOf(snapshot) {
	return isRecord(snapshot) ? textOf(snapshot.project) : null
}

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
 * T-219: one row per stage, in pipeline order. Each row carries the session the
 * card recorded FOR THAT STAGE — develop from `assignee.session`, review from
 * `review.deliveredTo.id`, test from `test.deliveredTo.id`. A stage without a
 * recorded session keeps its row with `session: null`: the row then says "not
 * assigned" instead of inventing an id, and the same session may legitimately
 * appear in two rows when one agent ran two stages.
 */
const AGENT_STAGE_ROWS = [
	{ stage: 'develop', labelKey: 'agentStageDevelop' },
	{ stage: 'review', labelKey: 'agentStageReview' },
	{ stage: 'test', labelKey: 'agentStageTest' },
]

function stageSessionsOf(task) {
	const card = isRecord(task) ? task : null
	return AGENT_STAGE_ROWS.map(function (row) {
		let session = null
		if (card !== null) {
			if (row.stage === 'develop') session = assignedSessionOf(card)
			else if (row.stage === 'review') session = reviewSessionOf(card)
			else session = testSessionOf(card)
		}
		return { stage: row.stage, labelKey: row.labelKey, session: session }
	})
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
 * T-234: the card's own DETAIL from the domain store, or null.
 *
 * The tab is usually the only surface still watching its card (the panel may be
 * showing the agent conversation and polling nothing), so it reads the detail
 * domain instead of a /state summary. `getTaskDetail` answers with the last GOOD
 * card: a failed refresh keeps the previous one, a project switch drops it.
 */
function detailTaskOf(store, taskId) {
	const id = textOf(taskId)
	if (id === null || store === null || store === undefined || typeof store.getTaskDetail !== 'function') return null
	let detail = null
	try {
		detail = store.getTaskDetail(id)
	} catch (error) {
		return null
	}
	return isRecord(detail) && isRecord(detail.task) ? detail.task : null
}

/** The agents block of the metadata domain, whether the store exposes it as a value or a call. */
function agentsBlockOf(store) {
	if (store === null || store === undefined) return null
	const read = store.agentsView
	if (typeof read === 'function') {
		let view = null
		try {
			view = read.call(store)
		} catch (error) {
			return null
		}
		return isRecord(view) ? view : null
	}
	return isRecord(read) ? read : null
}

/**
 * T-234: the snapshot a tab RENDERS from — the board snapshot with THIS card's
 * detail in place of its summary, and the live agent tree from the agents domain
 * when it has one. The board stays the fallback: a store without the domains, or
 * a tab opened before the detail landed, still resolves the exact card and the
 * tree it always did. Nothing is borrowed from another card.
 */
function tabViewOf(store, snapshot, taskId) {
	const board = isRecord(snapshot) ? snapshot : {}
	const id = textOf(taskId)
	const detail = detailTaskOf(store, id)
	const agents = agentsBlockOf(store)
	const tasks = Array.isArray(board.tasks) ? board.tasks.slice() : []
	if (detail !== null) {
		let replaced = false
		for (let index = 0; index < tasks.length; index += 1) {
			const entry = tasks[index]
			const entryId = isRecord(entry) ? String(entry.id === undefined || entry.id === null ? '' : entry.id) : ''
			if (entryId !== id) continue
			tasks[index] = detail
			replaced = true
			break
		}
		if (replaced !== true) tasks.unshift(detail)
	}
	const tree = agents !== null && agents.agentTree !== undefined && agents.agentTree !== null ? agents.agentTree : board.agentTree
	return {
		tasks: tasks,
		agentTree: tree === undefined ? null : tree,
		activityEvents: board.activityEvents === undefined ? null : board.activityEvents,
	}
}

/** The domain-store calls a mounted tab owns; null when the store offers neither. */
function syncApiOf(store) {
	if (store === null || store === undefined) return null
	const ensureTaskDetail = typeof store.ensureTaskDetail === 'function' ? function (id) { return store.ensureTaskDetail(id) } : null
	const ensureAgents = typeof store.ensureAgents === 'function' ? function () { return store.ensureAgents() } : null
	if (ensureTaskDetail === null && ensureAgents === null) return null
	return { ensureTaskDetail: ensureTaskDetail, ensureAgents: ensureAgents }
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

	/**
	 * T-227: the tab renders the last GOOD snapshot while a poll failure is on
	 * screen, whichever failure branch the store took.
	 *
	 * `receivedAt` identifies the snapshot generation: the store bumps it on every
	 * successful /state answer, and BOTH failure branches keep the value of the
	 * answer they failed after. So a failure reuses the cached card only when it is
	 * the same generation as that card.
	 *
	 * A failure carrying a project (the offline branch) must name the project the
	 * tab already shows. A failure with NO project (the payload branch: the host
	 * error body has none) cannot be checked that way, so the cache itself tracks
	 * the last seen project: the moment a snapshot of another project arrives, the
	 * cached card is dropped. A project switch therefore never replays the previous
	 * project's card, even if the new project's first load fails, and the cache is
	 * only replaced by a FRESH answer (same-generation switch snapshots are not
	 * cached, or the old board would be replayed under the new project id).
	 */
	function useStableSnapshot() {
		const snapshot = useSnapshot()
		const cache = React.useState(function () { return { good: null, receivedAt: null, project: null } })[0]
		const cached = cache.good
		const failed = failedSnapshotOf(snapshot)
		const project = projectOf(snapshot)
		// A failure with a known project may reuse the card only for THAT project;
		// a project-less payload failure relies on the cache being dropped once a
		// different project is seen (below).
		const compatible = project === null ? true : project === cache.project
		const fallback = failed === true && cached !== null && snapshot.receivedAt === cache.receivedAt && compatible === true ? cached : snapshot
		React.useEffect(function () {
			if (failed === true) return
			if (snapshot.receivedAt !== cache.receivedAt) {
				// A fresh answer is the new last-good for its project.
				cache.good = snapshot
				cache.receivedAt = snapshot.receivedAt
				cache.project = project
				return
			}
			// Same generation, another project: the store's switch snapshot keeps the
			// old board while only the project id changes. Drop the old card so no
			// failure can bring it back under the new project.
			if (project !== cache.project) {
				cache.good = null
				cache.project = project
			}
		})
		return fallback
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
	 * T-234: the tab's own sync — ONE card's detail plus the agents domain.
	 *
	 * T-227 made every tab refresh the WHOLE board through the store's load(), so
	 * a tab that only renders its card's review/test delivery and the live agent
	 * tree pulled a /state answer through the shared store on every tick. The tab
	 * now asks the domain store for exactly those two things at mount and every
	 * 5 s WHILE THE DOCUMENT IS VISIBLE:
	 *
	 * - a hidden document pauses the tab (no interval, no ensure); becoming
	 *   visible catches up at once and resumes the interval;
	 * - cleanup clears only this tab's timer and its visibility listener. It never
	 *   starts or stops the panel's poll: several open tabs share the store's
	 *   single-flight domains;
	 * - a failed ensure is swallowed: the detail domain keeps the last good card
	 *   and useStableSnapshot() keeps the last good BOARD for a store that still
	 *   reports a failure through its snapshot.
	 */
	function useTabSync(selection) {
		const store = context !== null ? context.store : null
		const sync = syncApiOf(store)
		const taskId = isRecord(selection) ? textOf(selection.taskId) : null
		React.useEffect(function () {
			if (sync === null) return undefined
			let handle = null
			function absorb(pending) {
				if (pending !== null && pending !== undefined && typeof pending.then === 'function') pending.then(noop, noop)
			}
			function refresh() {
				if (tabIsHidden()) return
				try {
					if (taskId !== null && sync.ensureTaskDetail !== null) absorb(sync.ensureTaskDetail(taskId))
					if (sync.ensureAgents !== null) absorb(sync.ensureAgents())
				} catch (error) {
					/* keep the last good domain answers; a failed poll never blanks the tab */
				}
			}
			function stopTimer() {
				if (handle === null) return
				if (typeof clearInterval === 'function') clearInterval(handle)
				handle = null
			}
			function startTimer() {
				if (handle !== null || tabIsHidden() || typeof setInterval !== 'function') return
				handle = setInterval(refresh, AGENT_TAB_SYNC_MS)
			}
			const globalDocument = typeof document === 'undefined' ? null : document
			function onVisibilityChange() {
				if (tabIsHidden()) {
					stopTimer()
					return
				}
				refresh()
				startTimer()
			}
			refresh()
			startTimer()
			if (globalDocument !== null && typeof globalDocument.addEventListener === 'function') {
				globalDocument.addEventListener('visibilitychange', onVisibilityChange)
			}
			return function () {
				stopTimer()
				if (globalDocument !== null && typeof globalDocument.removeEventListener === 'function') {
					globalDocument.removeEventListener('visibilitychange', onVisibilityChange)
				}
			}
		}, [taskId])
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
		const snapshot = useStableSnapshot()
		// T-216: the navigation session is the HOST session; the agent to show is
		// resolved from the params (or handed over directly by a mounted test).
		const selection = tabSelectionOf(props)
		const sessionId = selection.sessionId
		const taskId = selection.taskId
		// T-234: the title names the DETAIL card's agent, falling back to the board.
		const view = tabViewOf(context !== null ? context.store : null, snapshot, taskId)
		const label = sessionId === '' ? t('agentTabTitle') : agentInfoOf(view, sessionId, t, Date.now(), selectors, taskId).name
		return h('span', { className: 'gbt-agenttabtitle', 'data-agent-tab': 'title', 'data-agent-session': sessionId, 'data-agent-task': taskId === null ? '' : taskId }, h(AgentTabIcon, { size: 13 }), h('span', null, label))
	}

	function AgentTabBody(props) {
		const t = useTranslate()
		const snapshot = useStableSnapshot()
		const now = useNow()
		// Read the navigation params before any early return so the injected
		// tab-info hook is always called in the same order on every render.
		// T-216: the tab lives in the HOST session, so the agent it names comes
		// from the `agentSession` param; the navigation session is only the
		// fallback (a guide-opened tab, or a directly mounted body).
		const selection = tabSelectionOf(props)
		const sessionId = selection.sessionId
		const taskId = selection.taskId
		// T-234: keep THIS card's detail and the agents domain fresh (mount + a
		// visible-only 5 s tick), before the early return so the hook order never
		// changes between renders. The tab never pulls the board itself.
		useTabSync(selection)
		if (sessionId === '') {
			return h(
				'div',
				{ className: 'gbt-agenttab', 'data-agent-tab': 'body', 'data-agent-session': '' },
				h('div', { className: 'gbt-agenttabhead' }, h(AgentTabIcon, { size: 14 }), h('b', null, t('agentTabTitle'))),
				h('p', { className: 'gbt-footnote' }, t('agentTabNoSession')),
			)
		}
		// T-234: the tab renders the board with ITS card's detail (and the live
		// agent tree from the agents domain) layered on top.
		const view = tabViewOf(context !== null ? context.store : null, snapshot, taskId)
		const info = agentInfoOf(view, sessionId, t, now, selectors, taskId)
		// T-219: the three stage rows come from the EXACT card the tab was opened
		// from (never from the top agent's card, and never from another tab). A tab
		// without a taskId (the guide overview) has no card and therefore no rows.
		const card = taskId === null ? null : taskOfId(view, taskId)
		const stages = card === null ? [] : stageSessionsOf(card)
		const workspace = workspaceOf()
		const hasStageSwitch = workspace !== null && stages.some(function (row) { return row.session !== null })

		/** One stage row: stage label, agent name, live status, and its own action. */
		function stageRowOf(row) {
			const session = row.session
			const hasSession = session !== null
			const stageInfo = hasSession ? agentInfoOf(view, session, t, now, selectors, taskId) : null
			const canOpen = hasSession && workspace !== null
			const buttonTitle = hasSession === false
				? t('agentStageNoSessionHint')
				: workspace === null
					? t('agentStageNoWorkspace')
					: t('agentStageOpenHint')
			return h(
				'div',
				{
					key: row.stage,
					className: 'gbt-agenttabstage',
					'data-agent-stage': row.stage,
					'data-agent-stage-has-session': hasSession ? 'true' : 'false',
					'data-agent-stage-session': hasSession ? session : '',
				},
				h('span', { key: 'stage', className: 'gbt-agenttabstagelabel' }, t(row.labelKey)),
				hasSession
					? h('b', { key: 'name', className: 'gbt-agenttabstagename', title: stageInfo.name }, stageInfo.name)
					: h('span', { key: 'name', className: 'gbt-agenttabstagename gbt-agenttabstagenone', title: t('agentStageNoSessionHint') }, t('agentStageNoSession')),
				hasSession
					? h('span', { key: 'status', className: 'gbt-pill', 'data-status': stageInfo.statusPill, 'data-agent-stage-status': stageInfo.status }, t(stageInfo.statusLabelKey))
					: h('span', { key: 'status', className: 'gbt-pill', 'data-status': 'inactive', 'data-agent-stage-status': 'none' }, t('agentStageUnavailable')),
				h(
					'button',
					{
						key: 'open',
						type: 'button',
						className: 'gbt-agenttabstagebtn',
						'data-agent-action': 'open-stage-session',
						'data-agent-stage': row.stage,
						'data-agent-session': hasSession ? session : '',
						disabled: canOpen !== true,
						'aria-disabled': canOpen === true ? 'false' : 'true',
						title: buttonTitle,
						// openConversation() re-checks the session and the service: a
						// disabled row can never reach the host, and a missing stage
						// never opens anything.
						onClick: function () { openConversation(session) },
					},
					t('agentStageOpen'),
				),
			)
		}

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
			// T-219: the card's three stage entries. Each row names the stage, the
			// agent and the live status, and opens THAT stage's conversation. A
			// missing stage keeps its row (no session, disabled action); without
			// uiWorkspace every row is disabled and a note says why.
			stages.length === 0
				? null
				: h(
					'div',
					{ key: 'stages', className: 'gbt-agenttabstages', 'data-agent-section': 'stage-sessions' },
					h('div', { key: 'title', className: 'gbt-subhead' }, t('agentStagesTitle')),
					stages.map(function (row) { return stageRowOf(row) }),
					workspace === null
						? h('p', { key: 'noWorkspace', className: 'gbt-footnote', 'data-agent-note': 'no-workspace' }, t('agentStageNoWorkspace'))
						: null,
				),
			// T-218/T-219: a stage switch moves the MAIN session to the subagent, and
			// the right sidebar then belongs to that new session: tabs opened in the
			// host session are not carried over. Say it instead of letting them vanish.
			hasStageSwitch
				? h('p', { key: 'switchNote', className: 'gbt-footnote gbt-agenttabnote', 'data-agent-note': 'sidebar-scope' }, t('agentTabSwitchNote'))
				: null,
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
		// T-212/T-219: optional. The tab mounts and renders its overview without
		// it; the three stage rows are then disabled with an explanation.
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
	stageSessionsOf,
	agentInfoOf,
	createAgentSidebar,
	available,
	openIn,
	label,
}
