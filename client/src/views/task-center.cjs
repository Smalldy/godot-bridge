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
	const SettingsForm = deps.SettingsForm
	const ProjectForm = deps.ProjectForm
	const useTranslate = deps.useTranslate
	const useSnapshot = deps.useSnapshot
	const useNow = deps.useNow
	const panelState = deps.panelState
	const projectFormState = deps.projectFormState
	const doneAllReset = deps.doneAllReset
	const projectMismatchOf = deps.projectMismatchOf
	const projectSourceKey = deps.projectSourceKey
	const projectSourceLabel = deps.projectSourceLabel
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
		const selected = selectedId === null ? null : tasks.filter(function (task) { return task.id === selectedId })[0] || null
		const editingTask = editing === null || editing === 'new' ? null : (function () {
			const base = tasks.filter(function (task) { return task.id === editing })[0]
			if (base === undefined) return null
			return Object.assign({}, base, snapshot.details[editing] === undefined ? {} : snapshot.details[editing].task)
		})()
		const queue = snapshot.queue === undefined || snapshot.queue === null ? [] : snapshot.queue
		const scheduler = snapshot.scheduler
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
					},
					h('span', { key: 'board', className: 'gbt-workspace', 'data-workspace': 'board' }, h('span', { className: 'gbt-workspacelabel' }, t('workspaceBoard')), h('b', { title: boardWorkspace === null ? '' : boardWorkspace }, baseNameOf(boardWorkspace) === null ? '—' : baseNameOf(boardWorkspace))),
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
		// The pill reports the live tree, not a team: a root Agent with N live
		// children, or a neutral "not reported" state when the Host sends no tree.
		const agentsState = agentTree.root !== null ? 'ready' : 'none'
		const agentsPillLabel = agentsState === 'ready' ? t('agentsPillRoot').replace('{n}', String(agentTree.members.length)) : t('agentsPillNone')
		const dispatchCap = dispatch.maxConcurrent === undefined || dispatch.maxConcurrent === null ? 3 : dispatch.maxConcurrent
		const sourceBadge =
			projectSourceLabel(projectSourceKey(snapshot), t) === null
				? null
				: h('span', { className: 'gbt-projectsource', 'data-project-source': projectSourceKey(snapshot), title: snapshot.projectWarning === null ? t('projectSourceHint') : snapshot.projectWarning }, projectSourceLabel(projectSourceKey(snapshot), t))
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
				'data-sessions-count': String(scopeSessions.length),
				'aria-haspopup': 'dialog',
				'aria-expanded': sessionsOpen ? 'true' : 'false',
				title: t('sessionsHint'),
				onClick: function () { setSessionsOpen(!sessionsOpen) },
			},
			scopeSessions.length === 0
				? null
				: h('span', { className: 'gbt-sessionsdots', 'aria-hidden': 'true' }, scopeSessions.slice(0, 5).map(function (row, index) { return h('i', { key: 'dot-' + String(index) }) })),
			h('span', null, t('sessionsPill').replace('{n}', String(scopeSessions.length))),
			h('span', { className: 'gbt-caret', 'aria-hidden': 'true' }, '▾'),
		)
		const currentPill =
			panelSessionId === null
				? null
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
				'data-agent-root': agentTree.root !== null && typeof agentTree.root.name === 'string' ? agentTree.root.name : '',
				'data-agent-live': String(agentTree.members.length),
				'aria-haspopup': 'dialog',
				'aria-expanded': agentsOpen ? 'true' : 'false',
				title: t('agentsPopoverTitle'),
				onClick: function () { setAgentsOpen(!agentsOpen) },
			},
			h('span', { className: 'gbt-dot', 'data-running': agentsState === 'ready' ? 'true' : 'false' }),
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
			['refresh', t('refresh'), function () { closePopovers(); void store.load() }],
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
		const refreshButton = h('button', { type: 'button', className: 'gbt-iconbtn', 'data-action': 'refresh', title: t('refresh'), onClick: function () { void store.load() } }, '↻')
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
			h('div', { className: 'gbt-topactions' }, newTaskButton, moreMenu),
		)
		const toolbarRow = h('div', { className: 'gbt-toolbar' }, tabsView, h('div', { className: 'gbt-toolbarright' }, refreshButton, kindFilterBar))
		const header = h('header', { className: 'gbt-header gbt-headertwo', 'data-header-rows': '2' }, topRow, toolbarRow)
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
		const banner =
			snapshot.source === 'error'
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

		return h(
			'div',
			{ className: 'gbt-root', 'data-panel': 'task-center', 'data-panel-root': 'task-center', 'data-tc-theme': theme },
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
			settingsOpen ? h(SettingsForm, { t: t, dispatch: dispatch, theme: theme, onThemeChange: setTheme, onClose: function () { setSettingsOpen(false) } }) : null,
			projectOpen ? h(ProjectForm, { t: t, project: snapshot.project, hostProject: snapshot.sessionProject, onClose: function () { setProjectOpen(false) } }) : null,
		)
	}


	return TaskCenter
}

module.exports = { createTaskCenter }
