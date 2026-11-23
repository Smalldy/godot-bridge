/**
 * Task center shell view module.
 *
 * Extracted from the forms/shell fragments; React, h, the board/status/roles
 * views, the forms, the panel hooks/state and the project/header helpers are
 * injected by the build.
 *
 * T-228: the top navigation is 看板 / 状态 / 角色. The retired queue and agents
 * pages were folded into the status page (queue rows + agent table), so a
 * persisted view that still names them falls back to status instead of
 * rendering a page the nav no longer exposes.
 */
function createTaskCenter(deps) {
	const React = deps.React
	const h = deps.h
	const Board = deps.Board
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
		// T-228: three views only. A rendering test may pin one; the production
		// slot passes no props. The retired queue/workers names (in the props or in
		// a panelState persisted before T-228) land on the status page, which now
		// owns the queue rows and the agent table.
		function normalizeView(value) {
			if (value === 'queue' || value === 'workers') return 'status'
			return value === 'board' || value === 'status' || value === 'roles' ? value : 'board'
		}
		const initialView = normalizeView(props !== undefined && props !== null && props.initialView !== undefined ? props.initialView : panelState.view)
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
		// T-228: 看板 / 状态 / 角色. Queue and agents are cards on the status page,
		// not separate destinations.
		const tabs = [
			{ key: 'board', label: t('boardTab') },
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
		: view === 'status'
			? h(StatusView, {
				snapshot: snapshot,
				t: t,
				now: now,
				store: store,
				// T-228: a queue row on the status page opens the same task detail as
				// a board card; the status page owns no routing of its own.
				onOpen: openTask,
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
			// T-235 review: the countdown baseline is the receipt of the QUEUE that
			// produced remainingMs (a board poll does not re-measure it), never the
			// board receipt — otherwise the countdown stops moving.
			receivedAt: snapshot.decisionsReceivedAt === undefined || snapshot.decisionsReceivedAt === null ? snapshot.receivedAt : snapshot.decisionsReceivedAt,
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
