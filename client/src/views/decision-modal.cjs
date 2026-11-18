/**
 * DecisionRequest modal view module (T-195).
 *
 * The host may ask ONE critical question at a time and queue the rest. This view
 * renders that queue front-to-back: the common modal copy from the requirement
 * packet (title, task/event subtitle, server countdown, queue count, default
 * badge), the options, an optional free-text answer, and the DELETE confirmation
 * for a destructive option. Event-specific copy is supplied by the caller's
 * eventLabel/body/title — this module knows nothing about create/review/test.
 *
 * Countdown: the host sends remainingMs from ITS clock. The panel stores the
 * snapshot receipt time, so the rendered seconds are the server deadline minus
 * the local elapsed time; a browser clock offset cannot shorten or extend it.
 * Once a decision's deadline passes the PANEL still lets the user see it until
 * the next poll removes it, but the host refuses the late answer (decision-expired).
 *
 * Injected by the build: React (useState/useEffect/useRef) and h.
 */
function createDecisionModal(deps) {
	const React = deps.React
	const h = deps.h
	const CONFIRM_WORD = 'DELETE'

	/** Seconds left from the SERVER deadline (remainingMs at receipt time). */
	function decisionRemainingSeconds(decision, receivedAt, now) {
		if (decision === null || decision === undefined) return null
		const remaining = decision.remainingMs
		if (remaining === null || remaining === undefined || !Number.isFinite(remaining)) return null
		const received = Number.isFinite(receivedAt) ? receivedAt : now
		const elapsed = Number.isFinite(now) ? Math.max(0, now - received) : 0
		return Math.max(0, Math.ceil((remaining - elapsed) / 1000))
	}

	/** "{taskId} · {eventLabel}" — the packet's common subtitle. */
	function decisionSubtitle(decision, t) {
		if (decision === null || decision === undefined) return ''
		const label = typeof decision.eventLabel === 'string' && decision.eventLabel !== '' ? decision.eventLabel : t('decisionSubtitleFallback')
		const taskId = typeof decision.taskId === 'string' && decision.taskId !== '' ? decision.taskId : null
		return taskId === null ? label : taskId + ' · ' + label
	}

	/** The option object flagged as the default (the timeout choice). */
	function decisionDefaultOption(decision) {
		if (decision === null || decision === undefined || !Array.isArray(decision.options)) return null
		const wanted = typeof decision.defaultOption === 'string' ? decision.defaultOption : null
		const chosen = decision.options.filter((option) => option.default === true || (wanted !== null && option.id === wanted))[0]
		return chosen === undefined ? null : chosen
	}

	/** The label of the option flagged as the default (the timeout choice). */
	function decisionDefaultLabel(decision) {
		const chosen = decisionDefaultOption(decision)
		return chosen === null ? null : chosen.label
	}

	/**
	 * Would the SERVER auto-select the default at the deadline?
	 *
	 * The host refuses to auto-run a dangerous option (it expires the request
	 * "requires-manual"), so the countdown must not promise it. The server sends
	 * the policy as autoRunAllowed; a decision without that field is judged from
	 * its own default option (an older host or a test fixture).
	 */
	function decisionAutoRunAllowed(decision) {
		if (decision === null || decision === undefined) return false
		if (decision.autoRunAllowed === true) return true
		if (decision.autoRunAllowed === false) return false
		const chosen = decisionDefaultOption(decision)
		const hasDeadline = typeof decision.timeoutAt === 'string' && decision.timeoutAt !== ''
		return hasDeadline && chosen !== null && chosen.danger !== true
	}

	/** The countdown sentence, or the protected/no-deadline sentence. */
	function decisionCountdownText(decision, receivedAt, now, t) {
		const seconds = decisionRemainingSeconds(decision, receivedAt, now)
		if (seconds === null) return t('decisionNoCountdown')
		if (decisionAutoRunAllowed(decision) !== true) {
			const protectedLabel = decisionDefaultLabel(decision)
			if (protectedLabel === null) return t('decisionCountdownProtectedNoDefault').replace('{seconds}', String(seconds))
			return t('decisionCountdownProtected').replace('{seconds}', String(seconds)).replace('{defaultLabel}', protectedLabel)
		}
		const defaultLabel = decisionDefaultLabel(decision)
		if (defaultLabel === null) return t('decisionNoCountdown')
		return t('decisionCountdown').replace('{seconds}', String(seconds)).replace('{defaultLabel}', defaultLabel)
	}

	/** The option the modal starts on: the marked default, when there is one. */
	function decisionInitialOption(decision) {
		if (decision === null || decision === undefined) return null
		const wanted = typeof decision.defaultOption === 'string' ? decision.defaultOption : null
		if (wanted === null) return null
		const known = (Array.isArray(decision.options) ? decision.options : []).filter((option) => option.id === wanted)[0]
		return known === undefined ? null : known.id
	}

	/**
	 * Whether the confirm button may submit. A destructive option requires the
	 * exact DELETE word; with no options the free text must be non-empty.
	 */
	function decisionCanConfirm(decision, optionId, text, confirmText) {
		if (decision === null || decision === undefined) return false
		const option = (Array.isArray(decision.options) ? decision.options : []).filter((candidate) => candidate.id === optionId)[0]
		if (option === undefined) return typeof text === 'string' && text.trim() !== ''
		if (option.danger === true && confirmText !== CONFIRM_WORD) return false
		return true
	}

	/**
	 * The generic plugin view: one foregrounded decision, the queued count and
	 * the answer form. It never renders a close button — a question is resolved
	 * by answering one of its options (a "return"/"keep" option is one of them).
	 */
	function DecisionModal(props) {
		const t = props.t
		const queue = Array.isArray(props.queue) ? props.queue : []
		const current = queue.length === 0 ? null : queue[0]
		// A one-second local tick keeps the server countdown live between polls.
		const [tick, setTick] = React.useState(0)
		React.useEffect(function () {
			if (typeof setInterval !== 'function') return undefined
			const handle = setInterval(function () {
				setTick(function (value) { return value + 1 })
			}, 1000)
			return function () { clearInterval(handle) }
		}, [])
		const [selected, setSelected] = React.useState(current === null ? null : decisionInitialOption(current))
		const [text, setText] = React.useState('')
		const [confirmText, setConfirmText] = React.useState('')
		if (current === null) return null
		// The one-second tick re-renders this component; read the clock then, so the
		// countdown keeps moving even while the parent's polling snapshot is idle.
		const now = Date.now()
		const chosenId = selected === null || selected === undefined ? decisionInitialOption(current) : selected
		const chosen = (Array.isArray(current.options) ? current.options : []).filter((option) => option.id === chosenId)[0] || null
		const danger = chosen !== null && chosen.danger === true
		const canConfirm = decisionCanConfirm(current, chosenId, text, confirmText)
		const submitting = props.busy === true
		const queueLeft = queue.length - 1

		const optionNodes = (Array.isArray(current.options) ? current.options : []).map(function (option) {
			const isSelected = option.id === chosenId
			return h(
				'button',
				{
					key: option.id,
					type: 'button',
					className: 'gbt-decisionoption',
					'data-decision-option': option.id,
					'data-selected': isSelected ? 'true' : 'false',
					'data-danger': option.danger === true ? 'true' : 'false',
					disabled: submitting,
					onClick: function () {
						setSelected(option.id)
						setConfirmText('')
					},
				},
				h(
					'span',
					{ className: 'gbt-decisionoptionbody' },
					h('span', { className: 'gbt-decisionoptionlabel' }, option.label),
					typeof option.description === 'string' && option.description !== '' ? h('span', { className: 'gbt-decisionoptiondesc' }, option.description) : null,
				),
				option.default === true || option.id === current.defaultOption
					? h('span', { className: 'gbt-decisionbadge', 'data-decision-default': 'true' }, t('decisionDefaultBadge'))
					: null,
			)
		})

		return h(
			'div',
			{ className: 'gbt-decisionoverlay', 'data-decision-overlay': 'true' },
			h(
				'div',
				{ className: 'gbt-decision', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'gbt-decision-title', 'data-decision-id': current.id },
				h(
					'div',
					{ className: 'gbt-decisionhead' },
					h('h2', { id: 'gbt-decision-title', 'data-decision-title': 'true' }, t('decisionTitle')),
					h('span', { className: 'gbt-muted', 'data-decision-queue': 'true' }, queueLeft > 0 ? t('decisionQueue').replace('{n}', String(queueLeft)) : ''),
				),
				h('p', { className: 'gbt-decisionsub', 'data-decision-subtitle': 'true' }, decisionSubtitle(current, t)),
				h('p', { className: 'gbt-decisioncountdown', 'data-decision-countdown': 'true' }, decisionCountdownText(current, props.receivedAt, now, t)),
				current.title === '' ? null : h('p', { className: 'gbt-decisionbody', 'data-decision-headline': 'true' }, current.title),
				current.body === '' ? null : h('p', { className: 'gbt-decisionbody', 'data-decision-body': 'true' }, current.body),
				optionNodes.length === 0 ? null : h('div', { className: 'gbt-decisionoptions', 'data-decision-options': 'true' }, optionNodes),
				h(
					'label',
					{ className: 'gbt-decisiontext' },
					h('span', null, t('decisionTextLabel')),
					h('textarea', {
						className: 'gbt-input gbt-editorarea',
						style: { minHeight: '56px' },
						value: text,
						placeholder: current.eventKey === 'create' ? t('decisionCreateTextPlaceholder') : t('decisionTextPlaceholder'),
						'data-decision-text': 'true',
						disabled: submitting,
						onChange: function (event) { setText(String(event.target.value)) },
					}),
				),
				danger
					? h(
						'label',
						{ className: 'gbt-decisionhighrisk', 'data-decision-highrisk': 'true' },
						h('span', null, t('decisionHighRiskLabel')),
						h('input', {
							className: 'gbt-input gbt-decisionhighriskin',
							value: confirmText,
							placeholder: CONFIRM_WORD,
							'data-decision-confirm': 'true',
							disabled: submitting,
							onChange: function (event) { setConfirmText(String(event.target.value)) },
						}),
						h('span', { className: 'gbt-footnote' }, t('decisionHighRiskHint')),
					)
					: null,
				h(
					'div',
					{ className: 'gbt-decisionfoot' },
					typeof current.taskId === 'string' && current.taskId !== '' && typeof props.onOpenTask === 'function'
						? h('button', {
								type: 'button',
								className: 'gbt-btn',
								'data-decision-open-task': 'true',
								onClick: function () { props.onOpenTask(current.taskId) },
							}, t('decisionOpenTask'))
						: null,
					h(
						'button',
						{
							type: 'button',
							className: 'gbt-btn',
							'data-variant': 'primary',
							'data-decision-confirm-submit': 'true',
							disabled: !canConfirm || submitting,
							'data-decision-can-confirm': canConfirm ? 'true' : 'false',
							onClick: function () {
								if (!canConfirm || typeof props.onAnswer !== 'function') return
								props.onAnswer(current, { option: chosenId, text: text, confirm: confirmText })
							},
						},
						submitting ? t('decisionAnswering') : t('decisionConfirm'),
					),
				),
			),
		)
	}

	DecisionModal.decisionRemainingSeconds = decisionRemainingSeconds
	DecisionModal.decisionSubtitle = decisionSubtitle
	DecisionModal.decisionInitialOption = decisionInitialOption
	DecisionModal.decisionCanConfirm = decisionCanConfirm
	DecisionModal.decisionCountdownText = decisionCountdownText
	DecisionModal.decisionDefaultOption = decisionDefaultOption
	DecisionModal.decisionAutoRunAllowed = decisionAutoRunAllowed
	DecisionModal.CONFIRM_WORD = CONFIRM_WORD
	return DecisionModal
}

module.exports = { createDecisionModal }
