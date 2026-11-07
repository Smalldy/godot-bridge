/**
 * Task card view module.
 *
 * Extracted from the views fragment; the build injects React, h, selectors and
 * the two board-local helpers. The component keeps its exact rendering.
 */
function createTaskCard(deps) {
	const React = deps.React
	const h = deps.h
	const tcBaseName = deps.tcBaseName
	const tcIsInvestigation = deps.tcIsInvestigation
	const tcKindOf = deps.tcKindOf
	const tcLease = deps.tcLease
	const tcMergeLabel = deps.tcMergeLabel
	const tcMergeOf = deps.tcMergeOf
	const tcMergeTone = deps.tcMergeTone
	const tcPhaseLabel = deps.tcPhaseLabel
	const tcPhaseTone = deps.tcPhaseTone
	const tcReviewLabel = deps.tcReviewLabel
	const tcReviewOf = deps.tcReviewOf
	const tcReviewTone = deps.tcReviewTone
	const tcRound = deps.tcRound
	const tcStageQueued = deps.tcStageQueued
	const tcTestLabel = deps.tcTestLabel
	const tcTestOf = deps.tcTestOf
	const tcTestTone = deps.tcTestTone
	const toneForDependency = deps.toneForDependency
	const waitingChip = deps.waitingChip

	function TaskCard(props) {
		const task = props.task
		const t = props.t
		const now = props.now
		// T-132: investigations are a distinct card kind on the board.
		const investigate = tcIsInvestigation(task)
		const lease = task.status === 'running' ? tcLease(task.leaseUntil, now, t, task) : null
		const deps = Array.isArray(task.dependsOn) ? task.dependsOn : []
		const files = Array.isArray(task.writeFiles) ? task.writeFiles : null
		const fileCount = files !== null ? files.length : Number.isFinite(task.writeFileCount) ? task.writeFileCount : 0
		const dispatchError = task.dispatch !== null && task.dispatch !== undefined ? task.dispatch.error : null
		const merge = tcMergeOf(task)
		const review = tcReviewOf(task)
		const test = tcTestOf(task)
		const branch = typeof task.branch === 'string' ? task.branch : ''
		const commit = typeof task.commit === 'string' ? task.commit : ''
		const worktree = typeof task.worktree === 'string' ? task.worktree : ''
		// T-113: the user can record the review/test verdict from the card. The
		// server still decides permissions; this is only the missing entry point.
		const [verdictOpen, setVerdictOpen] = React.useState(null)
		const [verdictReason, setVerdictReason] = React.useState('')
		const verdictKind = task.status === 'reviewing' ? 'review' : task.status === 'testing' ? 'test' : null
		function recordVerdict(action, extra) {
			if (typeof props.onVerdict !== 'function') return
			props.onVerdict(action, task.id, extra === undefined ? {} : extra)
			setVerdictOpen(null)
			setVerdictReason('')
		}
		function verdictEvent(event, work) {
			return function (clickEvent) {
		if (clickEvent !== undefined && clickEvent !== null && typeof clickEvent.stopPropagation === 'function') clickEvent.stopPropagation()
		work(clickEvent)
			}
		}
		const children = []
		const top = [h('span', { key: 'id', className: 'gbt-id' }, task.id)]
		if (investigate) {
			top.push(h('span', { key: 'kind', className: 'gbt-chip', 'data-tone': 'investigating', 'data-kind': 'investigate', title: t('kindInvestigateHint') }, '🔍 ' + t('kindInvestigate')))
		}
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
		// T-132: an investigation has no review/test/merge phase, so those chips
		// are never rendered for it — not even from a stale hand-written record.
		if (!investigate && review !== null) {
			meta.push(
		h('span', { key: 'review', className: 'gbt-chip', 'data-tone': tcReviewTone(review.status), title: t('reviewStatus') + ' · ' + t('reviewAttempt') + ' ' + String(tcRound(review)) }, '👁 ' + tcReviewLabel(review.status, t) + ' · #' + String(tcRound(review))),
			)
			if (review.status !== 'pending' && typeof review.by === 'string' && review.by !== '') {
		meta.push(h('span', { key: 'reviewer', className: 'gbt-chip', title: t('reviewer') }, '👤 ' + review.by))
			}
		}
		if (!investigate && test !== null) {
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
		if (fileCount > 0) meta.push(h('span', { key: 'files', className: 'gbt-chip' }, '🔒 ' + String(fileCount)))
		if (!investigate && merge !== null) {
			meta.push(h('span', { key: 'merge', className: 'gbt-chip', 'data-tone': tcMergeTone(merge.status), title: t('mergeTitle') }, '⇄ ' + tcMergeLabel(merge.status, t)))
		}
		if (!investigate && typeof task.target === 'string' && task.target !== '') meta.push(h('span', { key: 'target', className: 'gbt-chip', 'data-target-branch': task.target, title: t('targetBranch') }, '🎯 ' + task.target))
		if (branch !== '') meta.push(h('span', { key: 'branch', className: 'gbt-chip', title: branch }, '⎇ ' + branch))
		if (commit !== '') meta.push(h('span', { key: 'commit', className: 'gbt-chip', title: commit }, '● ' + commit.slice(0, 10)))
		if (worktree !== '') meta.push(h('span', { key: 'worktree', className: 'gbt-chip', title: worktree }, '🌿 ' + tcBaseName(worktree)))
		if (dispatchError !== null && task.status !== 'running') meta.push(h('span', { key: 'error', className: 'gbt-chip', 'data-tone': 'blocked', title: dispatchError }, '⚠ ' + t('dispatchError')))
		if (tcStageQueued(task)) {
			meta.push(h('span', { key: 'queued', className: 'gbt-chip', 'data-tone': 'waiting', 'data-queue': String(task.queuePosition) }, '⏳ ' + t('queuedChip').replace('{n}', String(task.queuePosition))))
		}
		const waiting = waitingChip(task, t, 'waiting')
		if (waiting !== null) meta.push(waiting)
		if (meta.length > 0) children.push(h('div', { key: 'meta', className: 'gbt-cardmeta' }, meta))
		if (verdictKind !== null) {
			const title = verdictKind === 'review' ? t('verdictReviewTitle') : t('verdictTestTitle')
			const passing = verdictKind === 'review' ? 'approveReview' : 'passTest'
			const blocking = verdictKind === 'review' ? 'requestChanges' : 'failTest'
			const needsReason = verdictOpen === blocking
			children.push(
		h(
			'div',
			{ key: 'verdict', className: 'gbt-cardverdict', 'data-verdict-phase': verdictKind },
			h('div', { className: 'gbt-cardverdicthead' }, title),
			h(
				'div',
				{ className: 'gbt-cardverdictactions' },
				h(
			'button',
			{
				type: 'button',
				className: 'gbt-btn',
				// T-140: the positive verdict is the card's primary action;
				// the blocking one stays a danger outline.
				'data-variant': 'primary',
				'data-verdict-action': passing,
				onClick: function (clickEvent) {
					if (clickEvent !== undefined && clickEvent !== null && typeof clickEvent.stopPropagation === 'function') clickEvent.stopPropagation()
					recordVerdict(passing, verdictKind === 'test' ? { evidence: '' } : {})
				},
			},
			verdictKind === 'review' ? t('verdictReviewPass') : t('verdictTestPass'),
				),
				h(
			'button',
			{
				type: 'button',
				className: 'gbt-btn',
				'data-variant': 'danger',
				'data-verdict-action': blocking,
				// The blocking verdict needs a reason before it can be recorded.
				'data-verdict-needs-reason': 'true',
				onClick: function (clickEvent) {
					if (clickEvent !== undefined && clickEvent !== null && typeof clickEvent.stopPropagation === 'function') clickEvent.stopPropagation()
					setVerdictOpen(blocking)
				},
			},
			verdictKind === 'review' ? t('verdictReviewReject') : t('verdictTestFail'),
				),
			),
			needsReason
				? h(
			'div',
			{ className: 'gbt-cardverdictform', 'data-verdict-form': 'true' },
			h('label', { className: 'gbt-footnote' }, t('verdictReasonLabel')),
			h('textarea', {
				rows: 3,
				value: verdictReason,
				'data-verdict-reason': 'true',
				onInput: function (inputEvent) { setVerdictReason(String(inputEvent.target.value)) },
				onClick: function (clickEvent) { if (clickEvent !== undefined && clickEvent !== null && typeof clickEvent.stopPropagation === 'function') clickEvent.stopPropagation() },
			}),
			h(
				'div',
				{ className: 'gbt-cardverdictactions' },
				h(
					'button',
					{
				type: 'button',
				className: 'gbt-btn',
				'data-variant': 'primary',
				'data-verdict-submit': 'true',
				disabled: verdictReason.trim() === '',
				title: verdictReason.trim() === '' ? t('verdictReasonRequired') : undefined,
				onClick: function (clickEvent) {
					if (clickEvent !== undefined && clickEvent !== null && typeof clickEvent.stopPropagation === 'function') clickEvent.stopPropagation()
					if (verdictReason.trim() !== '') recordVerdict(blocking, verdictKind === 'test' ? { evidence: verdictReason.trim() } : { reasons: verdictReason.trim() })
				},
					},
					t('verdictSubmit'),
				),
				h('button', { type: 'button', className: 'gbt-btn', 'data-verdict-cancel': 'true', onClick: function () { setVerdictOpen(null); setVerdictReason('') } }, t('verdictCancel')),
			),
			)
				: null,
			)
		)
		}
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
		'data-kind': tcKindOf(task),
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


	return TaskCard
}

module.exports = { createTaskCard }
