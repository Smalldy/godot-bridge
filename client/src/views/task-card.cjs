/**
 * Task card view module.
 *
 * T-158 (夜航作战板): the face of a card is compact — short id + priority, a
 * two-line title, one meta row (owning session, dependency count, role) and one
 * state row (state dot + label on the left, elapsed time on the right). The
 * chips for review/test/merge/lease/waiting stay: they are the evidence a reader
 * opens the card for, only typeset smaller.
 */
function createTaskCard(deps) {
	/** A compact owning-session label; the full id stays in the title. */
	function ownerSessionShort(value) {
		const text = typeof value === 'string' ? value : ''
		return text.indexOf('session-') === 0 ? text.slice(8, 16) : text.slice(0, 8)
	}

	/** "12m" / "3h" / "2d" from the card's last change, or em dash. */
	function elapsedText(task, now) {
		const raw = typeof task.updatedAt === 'string' && task.updatedAt !== '' ? task.updatedAt : task.createdAt
		const at = typeof raw === 'string' ? Date.parse(raw) : NaN
		const current = typeof now === 'number' ? now : Date.now()
		if (!Number.isFinite(at)) return '—'
		const minutes = Math.max(0, Math.floor((current - at) / 60000))
		if (minutes < 1) return '—'
		if (minutes < 60) return String(minutes) + 'm'
		const hours = Math.floor(minutes / 60)
		if (hours < 24) return String(hours) + 'h'
		return String(Math.floor(hours / 24)) + 'd'
	}

	const React = deps.React
	const h = deps.h
	const tcBaseName = deps.tcBaseName
	const tcIsInvestigation = deps.tcIsInvestigation
	const tcKindOf = deps.tcKindOf
	const tcLease = deps.tcLease
	const tcMergeLabel = deps.tcMergeLabel
	const tcMergeOf = deps.tcMergeOf
	const tcPhaseLabel = deps.tcPhaseLabel
	const tcPhaseTone = deps.tcPhaseTone
	const tcMergeTone = deps.tcMergeTone
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
		const [verdictOpen, setVerdictOpen] = React.useState(null)
		const [verdictReason, setVerdictReason] = React.useState('')
		const verdictKind = task.status === 'reviewing' ? 'review' : task.status === 'testing' ? 'test' : null
		function recordVerdict(action, extra) {
			if (typeof props.onVerdict !== 'function') return
			props.onVerdict(action, task.id, extra === undefined ? {} : extra)
			setVerdictOpen(null)
			setVerdictReason('')
		}
		// The state row is what a reader scans first; it follows the phase, not the
		// verdict chips (those keep the round detail).
		let stateKey = 'waiting'
		let stateLabel = t('stateWaiting')
		if (task.status === 'running') {
			stateKey = 'running'
			stateLabel = t('stateRunning')
		} else if (task.status === 'reviewing') {
			stateKey = 'reviewing'
			stateLabel = t('stateReviewing')
		} else if (task.status === 'testing') {
			stateKey = 'testing'
			stateLabel = t('stateTesting')
		} else if (task.status === 'done') {
			stateKey = 'done'
			stateLabel = t('stateDone')
		} else if (task.status === 'blocked' || task.status === 'cancelled') {
			stateKey = 'blocked'
			stateLabel = t('stateBlocked')
		} else if (task.dependency !== undefined && task.dependency !== null && task.dependency.state === 'ready') {
			stateKey = 'ready'
			stateLabel = t('stateReady')
		}
		const children = []
		const topLeft = [h('span', { key: 'id', className: 'gbt-id' }, task.id)]
		if (investigate) {
			topLeft.push(h('span', { key: 'kind', className: 'gbt-chip', 'data-tone': 'investigating', 'data-kind': 'investigate', title: t('kindInvestigateHint') }, '🔍 ' + t('kindInvestigate')))
		}
		children.push(
			h(
				'div',
				{ key: 'top', className: 'gbt-cardtop' },
				h('div', { className: 'gbt-cardtopid' }, topLeft),
				task.priority !== 0 ? h('span', { key: 'prio', className: 'gbt-priority', title: t('priority') }, 'P' + String(task.priority)) : null,
			),
		)
		children.push(h('div', { key: 'title', className: 'gbt-cardtitle' }, task.title))
		const meta = []
		if (typeof task.ownerSession === 'string' && task.ownerSession !== '') {
			const ownerShort = ownerSessionShort(task.ownerSession)
			meta.push(h('span', { key: 'owner', className: 'gbt-chip gbt-ownerchip', 'data-owner-session': task.ownerSession, title: t('ownerSessionHint') + ' · ' + task.ownerSession }, h('i', { className: 'gbt-ownerdot', 'aria-hidden': 'true' }), ownerShort === '' ? task.ownerSession : ownerShort))
		}
		const depCount = deps.length
		if (depCount > 0 || task.status === 'pending') {
			meta.push(h('span', { key: 'deps', className: 'gbt-chip', title: depCount === 0 ? t('dependencyNone') : deps.join(', ') }, t('depCount').replace('{n}', String(depCount))))
		}
		// A recorded verdict stays visible wherever the card sits (a failed test on a
		// running card is a fact); a pending phase is only shown in that phase.
		if (!investigate && review !== null && (task.status === 'reviewing' || task.status === 'testing' || task.status === 'done' || review.status !== 'pending')) {
			meta.push(h('span', { key: 'review', className: 'gbt-chip', 'data-tone': tcReviewTone(review.status), title: t('reviewStatus') + ' · ' + t('reviewAttempt') + ' ' + String(tcRound(review)) }, '👁 ' + tcReviewLabel(review.status, t) + ' · #' + String(tcRound(review))))
			if (task.status !== 'done' && review.status !== 'pending' && typeof review.by === 'string' && review.by !== '') meta.push(h('span', { key: 'reviewer', className: 'gbt-chip', title: t('reviewer') }, review.by))
		}
		if (!investigate && test !== null && (task.status === 'testing' || task.status === 'done' || test.status !== 'pending')) {
			meta.push(h('span', { key: 'test', className: 'gbt-chip', 'data-tone': tcTestTone(test.status), title: t('testStatus') + ' · ' + t('testAttempt') + ' ' + String(tcRound(test)) }, '🧪 ' + tcTestLabel(test.status, t) + ' · #' + String(tcRound(test))))
			if (task.status !== 'done' && typeof test.by === 'string' && test.by !== '') meta.push(h('span', { key: 'tester', className: 'gbt-chip', title: t('tester') }, test.by))
		}
		if (!investigate && merge !== null && task.status === 'done') meta.push(h('span', { key: 'merge', className: 'gbt-chip', 'data-tone': tcMergeTone(merge.status), title: t('mergeTitle') }, '⇄ ' + tcMergeLabel(merge.status, t)))
		if (lease !== null) {
			meta.push(h('span', { key: 'lease', className: 'gbt-chip', 'data-tone': lease.warn ? 'blocked' : 'waiting', 'data-lease': lease.expired === true ? 'expired' : lease.remind === true ? 'reminder' : 'ok', title: lease.remind === true ? t('leaseReminder') : t('leaseLeft') }, lease.text))
		}
		if (fileCount > 0) meta.push(h('span', { key: 'files', className: 'gbt-chip', title: t('writeFiles') }, '🔒 ' + String(fileCount)))
		if (task.attempts > 0) meta.push(h('span', { key: 'attempts', className: 'gbt-chip', title: t('attempts') }, '↻ ' + String(task.attempts) + '/' + String(task.maxAttempts)))
		if (dispatchError !== null && task.status !== 'running') meta.push(h('span', { key: 'error', className: 'gbt-chip', 'data-tone': 'blocked', title: dispatchError }, t('dispatchError')))
		if (tcStageQueued(task)) meta.push(h('span', { key: 'queued', className: 'gbt-chip', 'data-tone': 'waiting', 'data-queue': String(task.queuePosition) }, t('queuedChip').replace('{n}', String(task.queuePosition))))
		const waiting = waitingChip(task, t, 'waiting')
		if (waiting !== null) meta.push(waiting)
		if (meta.length > 0) children.push(h('div', { key: 'meta', className: 'gbt-cardmeta' }, meta))
		children.push(
			h(
				'div',
				{ key: 'foot', className: 'gbt-cardfoot' },
				// The state label is a DIRECT text child: the card face is read by the
				// same text walker the panel tests use, and a nested dot element would
				// hide it. The dot is CSS ::before.
				h('span', { className: 'gbt-cardstate', 'data-state': stateKey, 'data-running': stateKey === 'running' || stateKey === 'ready' ? 'true' : 'false' }, stateLabel),
				h('span', { className: 'gbt-cardtime', title: typeof task.updatedAt === 'string' ? task.updatedAt : '' }, elapsedText(task, now)),
			),
		)
		// T-113: the user records the review/test verdict from the card.
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
							{ type: 'button', className: 'gbt-btn', 'data-variant': 'primary', 'data-verdict-action': passing, onClick: function (clickEvent) { if (clickEvent !== undefined && clickEvent !== null && typeof clickEvent.stopPropagation === 'function') clickEvent.stopPropagation(); recordVerdict(passing, verdictKind === 'test' ? { evidence: '' } : {}) } },
							verdictKind === 'review' ? t('verdictReviewPass') : t('verdictTestPass'),
						),
						h(
							'button',
							{ type: 'button', className: 'gbt-btn', 'data-variant': 'danger', 'data-verdict-action': blocking, 'data-verdict-needs-reason': 'true', onClick: function (clickEvent) { if (clickEvent !== undefined && clickEvent !== null && typeof clickEvent.stopPropagation === 'function') clickEvent.stopPropagation(); setVerdictOpen(blocking) } },
							verdictKind === 'review' ? t('verdictReviewReject') : t('verdictTestFail'),
						),
					),
					needsReason
						? h(
							'div',
							{ className: 'gbt-cardverdictform', 'data-verdict-form': 'true' },
							h('label', { className: 'gbt-footnote' }, t('verdictReasonLabel')),
							h('textarea', { rows: 3, value: verdictReason, 'data-verdict-reason': 'true', onInput: function (inputEvent) { setVerdictReason(String(inputEvent.target.value)) }, onClick: function (clickEvent) { if (clickEvent !== undefined && clickEvent !== null && typeof clickEvent.stopPropagation === 'function') clickEvent.stopPropagation() } }),
							h(
								'div',
								{ className: 'gbt-cardverdictactions' },
								h('button', { type: 'button', className: 'gbt-btn', 'data-variant': 'primary', 'data-verdict-submit': 'true', disabled: verdictReason.trim() === '', title: verdictReason.trim() === '' ? t('verdictReasonRequired') : undefined, onClick: function (clickEvent) { if (clickEvent !== undefined && clickEvent !== null && typeof clickEvent.stopPropagation === 'function') clickEvent.stopPropagation(); if (verdictReason.trim() !== '') recordVerdict(blocking, verdictKind === 'test' ? { evidence: verdictReason.trim() } : { reasons: verdictReason.trim() }) } }, t('verdictSubmit')),
								h('button', { type: 'button', className: 'gbt-btn', 'data-verdict-cancel': 'true', onClick: function () { setVerdictOpen(null); setVerdictReason('') } }, t('verdictCancel')),
							),
						)
						: null,
				),
			)
		}
		if (deps.length > 0) {
			children.push(
				h(
					'div',
					{ key: 'deps', className: 'gbt-cardmeta gbt-carddeps' },
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
