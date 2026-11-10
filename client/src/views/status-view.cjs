/**
 * Status view module.
 *
 * Extracted from the status fragment; React, h, the status/worktree UI state,
 * shared labels and the merge/activity helpers are injected by the build.
 */
function createStatusView(deps) {
	const React = deps.React
	const h = deps.h
	const statusUiState = deps.statusUiState
	const worktreeCleanupUi = deps.worktreeCleanupUi
	const actorDisplay = deps.actorDisplay
	const mergeActorOf = deps.mergeActorOf
	const roleKindLabel = deps.roleKindLabel
	const testSummaryText = deps.testSummaryText
	const tcAgo = deps.tcAgo
	const tcMergeOf = deps.tcMergeOf
	const tcSessionIdInfo = deps.tcSessionIdInfo
	const tcStageQueued = deps.tcStageQueued
	const copyToClipboard = deps.copyToClipboard

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
		// T-154: the merge queue is the MERGER's real reading (active/queued/last).
		// snapshot.queue is the DISPATCH queue (ready cards) and must never be shown
		// as merges; a host without a merger answers null, and that is not zero.
		const mergeQueue = snapshot.mergeQueue !== null && snapshot.mergeQueue !== undefined && typeof snapshot.mergeQueue === 'object' ? snapshot.mergeQueue : null
		const mergeQueued = mergeQueue !== null && Number.isFinite(mergeQueue.queued) ? mergeQueue.queued : null
		const mergeActive = mergeQueue !== null && Number.isFinite(mergeQueue.active) ? mergeQueue.active : null
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
		h('div', { className: 'gbt-statuskvs' }, h('span', { className: 'gbt-statuskv', 'data-kv': 'concurrent' }, h('b', null, String(running.length)), h('span', null, '/ ' + String(maxConcurrent) + ' ' + t('statusConcurrent'))), h('span', { className: 'gbt-statuskv', 'data-kv': 'ready' }, h('b', null, String(ready)), h('span', null, t('statusReady'))), Number.isFinite(counts.investigating) && counts.investigating > 0 ? h('span', { className: 'gbt-statuskv', 'data-kv': 'investigating', 'data-kind': 'investigate' }, h('b', null, String(counts.investigating)), h('span', null, t('statusInvestigating'))) : null, h('span', { className: 'gbt-statuskv', 'data-kv': 'merge-queue', 'data-merge-queue': mergeQueued === null ? 'unavailable' : 'ready', title: mergeActive === null ? '' : String(mergeActive) }, h('b', null, mergeQueued === null ? '—' : String(mergeQueued)), h('span', null, t('statusMergeQueue')))),
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
			return String(entry.path) + ':' + (entry.active === true ? 'a' : '-')
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
		// T-146: /state only carries the inventory. Probe the stale checkouts
		// lazily (never an automatic cleanup dry run) when the card is shown.
		React.useEffect(function () {
			if (worktreeSignature === '') return
			if (worktreeCleanupUi.probeState === 'loading') return
			if (worktreeCleanupUi.probedSignature === worktreeSignature) return
			worktreeCleanupUi.probedSignature = worktreeSignature
			worktreeCleanupUi.probeState = 'loading'
			wtBump()
			const paths = staleWts.map(function (entry) { return entry.path })
			void store.loadWorktrees(paths).then(function (payload) {
		if (payload !== null && payload !== undefined && payload.ok === true) {
			worktreeCleanupUi.probe = payload
			worktreeCleanupUi.probeState = 'ready'
		} else {
			worktreeCleanupUi.probe = null
			worktreeCleanupUi.probeState = 'error'
		}
		wtBump()
			})
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
			cleanupUi.probe = null
			cleanupUi.probeState = 'idle'
			cleanupUi.probedSignature = null
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
		const probeEntries = cleanupUi.probe !== null && Array.isArray(cleanupUi.probe.worktrees) ? cleanupUi.probe.worktrees : []
		const probeByPath = {}
		probeEntries.forEach(function (entry) { if (entry !== null && typeof entry === 'object' && typeof entry.path === 'string') probeByPath[entry.path] = entry })
		const wtEffective = function (entry) { const probed = probeByPath[entry.path]; return probed === undefined ? entry : Object.assign({}, entry, probed) }
		const effectiveStale = staleWts.map(wtEffective)
		const safeCount = effectiveStale.filter(function (entry) { return entry.probed === true && entry.safe === true }).length
		const confirmCount = effectiveStale.filter(function (entry) { return entry.probed === true && entry.safe !== true }).length
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
			// T-146: dirty/merged arrive from the lazy probe, not /state.
			if (entry.probed !== true) {
		return h('span', { className: 'gbt-wtbadges', 'data-wt-probed': 'false' },
			h('span', { className: 'gbt-chip', 'data-tone': 'waiting' }, t(cleanupUi.probeState === 'loading' ? 'statusWtProbing' : cleanupUi.probeState === 'error' ? 'statusWtProbeFailed' : 'statusWtUnprobed')))
			}
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
			const effective = wtEffective(entry)
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
		actions = h('span', { className: 'gbt-wtactions' }, h('span', { className: 'gbt-statusnote' }, candidate !== undefined ? wtReasonLabel(String(candidate.why)) : effective.probed !== true ? t(cleanupUi.probeState === 'loading' ? 'statusWtProbing' : cleanupUi.probeState === 'error' ? 'statusWtProbeFailed' : 'statusWtUnprobed') : t('statusWtPreflightFirst')))
			}
			return h('div', { key: 'wt-stale-' + actionId, className: 'gbt-wtrow', 'data-worktree-stale': wtLabelOf(entry), 'data-path': entry.path, 'data-reason': String(effective.reason === undefined || effective.reason === null ? '' : effective.reason), 'data-wt-probed': effective.probed === true ? 'true' : 'false' },
		h('span', { className: 'gbt-wtlabel' }, h('b', null, wtLabelOf(entry)), h('span', { className: 'gbt-pill', 'data-wt-type': String(entry.type) }, wtTypeLabel(entry.type))),
		h('span', { className: 'gbt-wtpath gbt-mono', title: String(entry.path) }, wtBaseOf(entry.path)),
		h('span', { className: 'gbt-wtbranch gbt-mono', title: typeof entry.branch === 'string' ? entry.branch : '' }, typeof entry.branch === 'string' && entry.branch !== '' ? entry.branch : '—'),
		h('span', { className: 'gbt-wtsha gbt-mono' }, typeof effective.head === 'string' && effective.head !== '' ? effective.head.slice(0, 7) : '—'),
		wtBadges(effective),
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
	return StatusView
}

module.exports = { createStatusView }
