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
	const tcLeadText = deps.tcLeadText
	const copyToClipboard = deps.copyToClipboard
	const store = deps.store

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
		// T-150: copy confirmation for the owning session id in the header.
		const [teamSessionCopied, setTeamSessionCopied] = React.useState(null)
		function openProjectDialog() {
			projectFormState.value = null
			setProjectOpen(true)
		}
		/** T-150: open the existing project dialog prefilled with the team's project. */
		function switchToTeamProject(path) {
			if (typeof path !== 'string' || path === '') return
			projectFormState.value = path
			setProjectOpen(true)
		}
		/** T-150: create the minimum roster for THIS session, then refresh. */
		function bootstrapTeamFromHeader() {
			void store.send('bootstrapTeam').then(function (result) {
		if (result !== null && result !== undefined && result.ok === true) void store.load()
			})
		}
		function copyTeamSession(value) {
			if (typeof value !== 'string' || value === '') return
			void copyToClipboard(value).then(function (ok) {
		setTeamSessionCopied(ok === true ? value : 'failed')
			})
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
		// One project-context decision for the whole header: a panel/session split
		// outranks a Team/project split, so the user is never offered two switches.
		const mismatchProject = projectMismatchOf(snapshot)
		// T-150: the Team is the request session's team, not automatically this
		// project's. Use the explicit project/projectMatch fields so another
		// project's Team is never presented as this one, and give each state an
		// action instead of a dead-end sentence.
		const headerTeamProject = projectTeam !== null && typeof projectTeam.project === 'string' && projectTeam.project !== '' ? projectTeam.project : null
		const headerPanelProject = typeof snapshot.project === 'string' && snapshot.project !== '' ? snapshot.project : null
		const headerTeamSession = projectTeam === null ? null : typeof projectTeam.session === 'string' && projectTeam.session !== '' ? projectTeam.session : typeof projectTeam.leadSession === 'string' && projectTeam.leadSession !== '' ? projectTeam.leadSession : null
		const headerTeamMismatch = projectTeam !== null && projectTeam.projectMatch === false && headerTeamProject !== null && headerPanelProject !== null
		const headerTeamAvailable = projectTeam !== null && projectTeam.available === false
		const headerTeamMissingRoles = projectTeam !== null && Array.isArray(projectTeam.missingRoles) ? projectTeam.missingRoles : []
		const headerTeamBuildable =
			projectTeam === null
		? headerPanelProject !== null
		: projectTeam.available !== false && projectTeam.projectMatch === true && (projectTeam.error === 'no-members' || headerTeamMissingRoles.length > 0)
		const headerTeamBuilding = isBusy('bootstrapTeam')
		const headerTeamBuildButton = function () {
			return h('button', {
		type: 'button',
		className: 'gbt-btn',
		'data-variant': 'primary',
		'data-action': 'bootstrap-team',
		'data-busy': headerTeamBuilding ? 'true' : 'false',
		disabled: headerTeamBuilding || busy !== null || snapshot.project === null || snapshot.source === 'error',
		onClick: bootstrapTeamFromHeader,
			}, headerTeamBuilding ? h('span', null, h('span', { className: 'gbt-spinner' }), t('projectTeamBuilding')) : t('projectTeamBuild'))
		}
		const projectTeamNotice = headerTeamMismatch && mismatchProject !== null
			? null
			: headerTeamMismatch
			? h('div', {
			className: 'gbt-projectsync',
			'data-project-mismatch': 'true',
			'data-team-project': headerTeamProject,
			'data-panel-project': headerPanelProject,
			'data-tone': 'warn',
		},
			h('span', { className: 'gbt-projectsynccopy' }, t('projectTeamMismatch').replace('{team}', headerTeamProject).replace('{panel}', headerPanelProject)),
			h('div', { className: 'gbt-actions' },
				h('button', {
			type: 'button',
			className: 'gbt-btn',
			'data-action': 'switch-team-project',
			'data-team-project': headerTeamProject,
			onClick: function () { switchToTeamProject(headerTeamProject) },
				}, t('projectTeamSwitch')),
				headerTeamSession === null
			? null
			: h('button', {
					type: 'button',
					className: 'gbt-btn',
					'data-action': 'copy-team-session',
					'data-session': headerTeamSession,
					title: headerTeamSession,
					onClick: function () { copyTeamSession(headerTeamSession) },
				}, teamSessionCopied === headerTeamSession ? t('projectTeamSessionCopied') : teamSessionCopied === 'failed' ? t('projectTeamCopyFailed') : t('projectTeamOpenSession')),
			),
		)
			: headerTeamAvailable
		? null
		: projectTeam === null
			? h('div', { className: 'gbt-projectsync', 'data-team-missing': 'true', 'data-tone': 'warn' },
			h('span', { className: 'gbt-projectsynccopy' }, t('projectTeamMissingTeam')),
			h('div', { className: 'gbt-actions' }, headerTeamBuildButton()))
			: headerTeamBuildable
				? h('div', { className: 'gbt-projectsync', 'data-team-build': 'true', 'data-tone': 'warn' },
				h('span', { className: 'gbt-projectsynccopy', 'data-team-scope-hint': 'true' }, t('projectTeamScopeHint')),
				h('div', { className: 'gbt-actions' }, headerTeamBuildButton()))
				: null

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
				t(headerTeamMismatch ? 'projectTeamCurrent' : 'projectTeam') + '：' +
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
			projectTeamNotice,
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
		// scheduler agree again (T-90). This is the only switch shown when the
		// session itself is the mismatching project.
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


	return TaskCenter
}

module.exports = { createTaskCenter }
