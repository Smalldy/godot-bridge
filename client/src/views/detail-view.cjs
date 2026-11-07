/**
 * Task detail view module.
 *
 * Extracted from the detail fragment; React, h, the detail UI state, shared
 * actor/merge helpers and the task selectors are injected by the build.
 */
function createDetailView(deps) {
	const React = deps.React
	const h = deps.h
	const detailUiState = deps.detailUiState
	const actorDisplay = deps.actorDisplay
	const mergeActorOf = deps.mergeActorOf
	const testSummaryText = deps.testSummaryText
	const toneForDependency = deps.toneForDependency
	const waitingChip = deps.waitingChip
	const tcAgo = deps.tcAgo
	const tcIsInvestigation = deps.tcIsInvestigation
	const tcMergeLabel = deps.tcMergeLabel
	const tcMergeOf = deps.tcMergeOf
	const tcPhaseLabel = deps.tcPhaseLabel
	const tcReportBlocks = deps.tcReportBlocks
	const tcReviewLabel = deps.tcReviewLabel
	const tcReviewOf = deps.tcReviewOf
	const tcRound = deps.tcRound
	const tcStatusKey = deps.tcStatusKey
	const tcTestLabel = deps.tcTestLabel
	const tcTestOf = deps.tcTestOf

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
		// T-132: an investigation is delivered as a REPORT. It has no review,
		// test or merge phase, and its scratch checkout is discarded on report.
		const investigate = tcIsInvestigation(task)
		const report =
			investigate && task.report !== null && task.report !== undefined && typeof task.report === 'object' && !Array.isArray(task.report) ? task.report : null
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
		}
		// T-122: names resolve against the session's team, not the host inventory.
		if (snapshot.team !== null && snapshot.team !== undefined && Array.isArray(snapshot.team.members)) {
			snapshot.team.members.forEach(function (member) { roster.push(member) })
		} else if (snapshot.agents !== null && snapshot.agents !== undefined && Array.isArray(snapshot.agents.members)) {
			snapshot.agents.members.forEach(function (member) { roster.push(member) })
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
		const devStages = h(
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
		// T-132: the investigation spine is exactly 执行 → 交付. Review, test and
		// merge do not exist for it, so they are not rendered as empty stages.
		const runState = interrupted ? 'interrupted' : task.status === 'pending' ? 'todo' : task.status === 'running' ? 'active' : 'done'
		const deliverAt = report !== null && typeof report.createdAt === 'string' ? report.createdAt : historyAt('done')
		const investigationStages = h(
			'div',
			{ className: 'gbt-detailstages', 'data-detail': 'stages', 'data-detail-kind': 'investigate', 'data-detail-stages': layout === 'single' ? 'wrap' : 'row' },
			[
		{ key: 'run', label: t('stageRun'), state: runState, at: historyAt('running') },
		{ key: 'deliver', label: t('stageDeliver'), state: task.status === 'done' ? 'done' : 'todo', at: deliverAt },
			].map(function (stage) {
		return h(
			'div',
			{ key: stage.key, className: 'gbt-detailstage', 'data-stage': stage.key, 'data-state': stage.state, 'data-at': stage.at === null ? '' : String(stage.at) },
			h('span', { className: 'gbt-detailstagebar' }),
			h('span', { className: 'gbt-detailstagelabel' }, h('b', null, stage.label), stage.at === null ? null : h('span', { className: 'gbt-detailstagetime' }, new Date(stage.at).toTimeString().slice(0, 5))),
		)
			}),
			interrupted ? h('div', { className: 'gbt-detailinterrupt', 'data-detail-interrupt': task.status }, t('interruptedAt') + ' ' + t(task.status === 'blocked' ? 'statusBlocked' : 'statusCancelled') + (interruptedReason === null ? '' : ' · ' + interruptedReason)) : null,
		)
		const stages = investigate ? investigationStages : devStages

		// ── "where is it now": one row per phase conclusion ──
		const events = []
		const submissions = history.filter(function (entry) { return entry.to === 'reviewing' })
		const sha = typeof task.commit === 'string' && task.commit !== '' ? task.commit.slice(0, 7) : null
		if (investigate !== true) submissions.forEach(function (entry, index) {
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
		if (investigate !== true && review !== null) {
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
		if (investigate !== true && test !== null) {
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
		if (investigate !== true && merge !== null) {
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
		// T-132: an investigation's only phase conclusion is the report itself.
		if (investigate === true) {
			events.unshift(
		h(
			'div',
			{ key: 'report', className: 'gbt-detailevent', 'data-detail-event': 'report', 'data-report-status': report === null ? 'missing' : 'delivered' },
			h('span', { className: 'gbt-detailpill', 'data-tone': report === null ? 'wait' : 'ok' }, report === null ? t('reportMissing') : t('reportDelivered')),
			h('b', null, t('stageDeliver')),
			h('span', { className: 'gbt-detailwho' }, report === null ? '—' : actorName(report.by, report.byName, 'actorRoleWorker') + (typeof report.createdAt === 'string' ? ' · ' + new Date(report.createdAt).toTimeString().slice(0, 5) : '')),
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
		// T-132: an investigation shows delivery status, never review/test rounds.
		const roundsLine = investigate
			? report === null
		? t('reportMissing')
		: t('reportDelivered') + (typeof report.createdAt === 'string' ? ' · ' + new Date(report.createdAt).toTimeString().slice(0, 5) : '')
			: t('stageReview') + ' ' + String(reviewRounds) + ' ' + t('roundUnit') + ' · ' + t('stageTest') + ' ' + String(testRounds) + ' ' + t('roundUnit')
		const compactSummary = h(
			'div',
			{ className: 'gbt-detailsummary gbt-detailsummary-one', 'data-detail': 'summary', 'data-detail-summary': 'one-line' },
			h('span', { className: 'gbt-detailstat' }, h('b', null, elapsedText), h('span', null, t('detailElapsed'))),
			h('span', { className: 'gbt-detailstatline' }, roundsLine),
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
		const summaryFacts = investigate
			? h(
			'div',
			{ 'data-detail-facts': 'investigate' },
			h('div', { className: 'gbt-detailkv' }, h('span', null, t('kindLabel')), h('b', { 'data-detail-kind': 'investigate' }, t('kindInvestigate'))),
			h('div', { className: 'gbt-detailkv' }, h('span', null, t('reportTitle')), h('b', { 'data-detail-report-fact': report === null ? 'missing' : 'delivered' }, report === null ? t('reportMissing') : t('reportDelivered'))),
			report === null ? null : h('div', { className: 'gbt-detailkv' }, h('span', null, t('reportEvidence')), h('b', null, String(Array.isArray(report.evidence) ? report.evidence.length : 0))),
			h('div', { className: 'gbt-detailstatline' }, t('attempts') + ' ' + String(task.attempts) + '/' + String(task.maxAttempts)),
		)
			: h(
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
			h('div', { className: 'gbt-detailstatline' }, roundsLine, ' · ', t('attempts') + ' ' + String(task.attempts) + '/' + String(task.maxAttempts)),
			investigate ? null : metricsNode,
			// T-132: a done investigation has no target/merge progress to show.
			investigate
		? null
		: h('div', { className: 'gbt-detailstatline', 'data-detail-target': 'true' }, t('targetBranch') + ': ' + (typeof task.target === 'string' && task.target !== '' ? task.target : t('targetDefaultLabel')) + (typeof task.base === 'string' && task.base !== '' ? ' · ' + String(task.base).slice(0, 10) + ' → ' + (typeof task.target === 'string' && task.target !== '' ? task.target : t('targetDefaultLabel')) : '')),
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

		// T-144: the delivered report is the investigation's product; the casebook renders
		// it in full (safe Markdown) with the evidence appendix after the body.
		const reportFileLine = t('reportFullHint').replace('{id}', task.id)
		const reportInner =
			report === null
		? h('p', { className: 'gbt-footnote', 'data-detail-report': 'missing' }, t('reportInvestigateHint'))
		: h(
			'div',
			{ className: 'gbt-reportcontent' },
			h('div', { className: 'gbt-subhead' }, t('reportSummary')),
			h('p', { className: 'gbt-prose', 'data-detail-report': 'summary' }, String(report.summary)),
			typeof report.body !== 'string' || report.body === ''
				? null
				: h(
			'div',
			null,
			h('div', { className: 'gbt-subhead' }, t('reportBody')),
			h('div', { className: 'gbt-reportbody', 'data-detail-report': 'body', 'data-report-format': 'markdown' }, tcReportBlocks(String(report.body))),
				),
			Array.isArray(report.evidence) && report.evidence.length > 0
				? h(
			'div',
			null,
			h('div', { className: 'gbt-subhead' }, t('reportEvidence')),
			h(
				'table',
				{ className: 'gbt-reporttable', 'data-detail-report': 'evidence' },
				h('thead', null, h('tr', null, h('th', null, t('reportCommand')), h('th', null, t('reportExit')), h('th', null, t('reportTail')))),
				h(
					'tbody',
					null,
					report.evidence.map(function (row, index) {
				return h(
					'tr',
					{ key: String(index), 'data-evidence-row': String(index) },
					h('td', { className: 'gbt-mono', 'data-evidence-command': 'true' }, String(row.command === undefined || row.command === null ? '' : row.command)),
					h('td', { 'data-evidence-exit': 'true' }, row.exitCode === undefined || row.exitCode === null ? '—' : String(row.exitCode)),
					h('td', null, h('pre', { className: 'gbt-reporttail' }, String(row.outputTail === undefined || row.outputTail === null ? '' : row.outputTail))),
				)
					}),
				),
			),
				)
			: null,
			Array.isArray(report.artifacts) && report.artifacts.length > 0
				? h(
			'div',
			null,
			h('div', { className: 'gbt-subhead' }, t('reportArtifacts')),
			h('ul', { className: 'gbt-reportartifacts', 'data-detail-report': 'artifacts' }, report.artifacts.map(function (path) { return h('li', { key: path, className: 'gbt-mono' }, String(path)) })),
				)
			: null,
			Array.isArray(report.probeCommits) && report.probeCommits.length > 0
				? h('p', { className: 'gbt-footnote', 'data-detail-report': 'probe-commits' }, t('reportProbeCommits') + ' ' + report.probeCommits.join(', '))
				: null,
			h('div', { className: 'gbt-casefile', 'data-report-file': 'paper' }, reportFileLine),
		)
		const reportPaper = h(
			'article',
			{ className: 'gbt-casepaper gbt-reportcard', 'data-detail-card': 'report', 'data-detail-report-card': report === null ? 'missing' : 'delivered', 'data-report-id': task.id },
			h(
		'div',
		{ className: 'gbt-detailcardhead' },
		t('reportTitle'),
		h('span', { className: 'gbt-pill', 'data-report-status': report === null ? 'missing' : 'delivered', 'data-kind': 'investigate' }, report === null ? t('reportMissing') : t('reportDelivered')),
			),
			reportInner,
		)
		const caseFacts = h(
			'dl',
			{ className: 'gbt-casefacts', 'data-detail-index': 'facts' },
			h('dt', null, t('casebookStatus')),
			h('dd', null, h('span', { className: 'gbt-pill', 'data-status': task.status }, tcPhaseLabel(task, t))),
			h('dt', null, t('casebookKind')),
			h('dd', null, t('kindInvestigate')),
			h('dt', null, t('casebookProject')),
			h('dd', { className: 'gbt-mono' }, typeof snapshot.project === 'string' && snapshot.project !== '' ? snapshot.project : '—'),
			h('dt', null, t('casebookExecutor')),
			h('dd', null, task.assignee !== null && task.assignee !== undefined ? actorName(task.assignee.name) : '—'),
			h('dt', null, t('casebookBase')),
			h('dd', { className: 'gbt-mono' }, typeof task.base === 'string' && task.base !== '' ? String(task.base).slice(0, 10) : '—'),
			h('dt', null, t('casebookTarget')),
			h('dd', { className: 'gbt-mono' }, typeof task.target === 'string' && task.target !== '' ? task.target : t('targetDefaultLabel')),
			h('dt', null, t('casebookElapsed')),
			h('dd', null, elapsedText),
			h('dt', null, t('casebookDelivered')),
			h('dd', null, deliverAt === null ? '—' : String(deliverAt).replace('T', ' ').slice(0, 16)),
			h('dt', null, t('casebookReportFile')),
			h('dd', { className: 'gbt-casefile', 'data-report-file': 'index' }, reportFileLine),
		)
		const caseIndex = h(
			'aside',
			{ className: 'gbt-caseindex', 'data-detail-index': 'casebook' },
			h(
		'div',
		{ className: 'gbt-caseindexhead' },
		h('span', { className: 'gbt-id gbt-mono' }, task.id),
		h('span', { className: 'gbt-pill', 'data-status': task.status }, tcPhaseLabel(task, t)),
		h('span', { className: 'gbt-pill', 'data-kind': 'investigate' }, t('kindInvestigate')),
			),
			h('div', { className: 'gbt-subhead' }, t('casebookIndex')),
			caseFacts,
			h('div', { className: 'gbt-subhead' }, t('casebookTimeline')),
			eventsBody,
		)
		const casebook = h('div', { key: 'casebook', className: 'gbt-casebook', 'data-detail': 'casebook', 'data-detail-layout': 'casebook' }, caseIndex, reportPaper)

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
		if (investigate) {
			// T-144: investigations render as a casebook: index aside + full report paper.
			blocks.push(casebook)
		} else {
			const eventsCard = h('section', { className: 'gbt-detailcard', 'data-detail-card': 'events' }, h('div', { className: 'gbt-detailcardhead' }, t('detailWhereNow')), eventsBody)
			blocks.push(h('div', { className: 'gbt-detailbody', 'data-detail-body': layout, 'data-detail-layout': layout }, layout === 'single' ? compactSummary : null, eventsCard, layout === 'single' ? summaryDetails : summary))
		}

		// An investigation never submits code: its completion action is report, so
		// the submit box must not invite a refused action.
		if (task.status === 'running' && investigate !== true) {
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
			// T-107: an owner session that differs from the dispatching Lead's session is a red flag, not noise.
			task.ownerSession !== null && task.ownerSession !== undefined && dispatch.leadSession !== null && dispatch.leadSession !== undefined && task.ownerSession !== dispatch.leadSession
				? h('p', { className: 'gbt-footnote', 'data-owner-mismatch': 'true' }, t('ownerMismatch').replace('{owner}', String(task.ownerSession)).replace('{lead}', String(dispatch.leadSession)))
				: null,
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
			h('div', { className: 'gbt-cardmeta' }, h('span', { className: 'gbt-id' }, task.id), h('span', { className: 'gbt-pill', 'data-status': task.status }, t(tcStatusKey(task.status))), investigate ? h('span', { className: 'gbt-pill', 'data-kind': 'investigate', title: t('kindInvestigateHint') }, t('kindInvestigate')) : null, Number.isFinite(task.queuePosition) && task.queuePosition > 0 ? h('span', { className: 'gbt-pill', 'data-queue': String(task.queuePosition) }, t('queuedChip').replace('{n}', String(task.queuePosition))) : null, waitingChip(task, t, 'waiting')),
			h('h2', { className: 'gbt-drawertitle' }, task.title),
			h('div', { className: 'gbt-detailmeta' }, h('span', null, t('assignee') + ' ' + (task.assignee === null || task.assignee === undefined ? '—' : task.assignee.name)), h('span', { className: 'gbt-detailspan' }, new Date(task.createdAt).toTimeString().slice(0, 5) + ' → ' + (finishedAt === null ? t('detailNow') : new Date(finishedAt).toTimeString().slice(0, 5)) + ' · ' + elapsedText)),
		),
		h('button', { type: 'button', className: 'gbt-iconbtn', onClick: props.onClose, 'aria-label': t('close') }, '×'),
			),
			h('div', { className: 'gbt-drawerbody' }, blocks),
			),
		)
	}


	return DetailView
}

module.exports = { createDetailView }
