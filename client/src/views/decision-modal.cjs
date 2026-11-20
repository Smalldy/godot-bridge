/**
 * DecisionRequest modal + compact card view modules (T-195, T-208).
 *
 * The host may ask ONE critical question at a time and queue the rest. This
 * module renders that queue front-to-back: the common modal copy from the
 * requirement packet (title, task/event subtitle, server countdown, queue
 * count, default badge), the options, an optional free-text answer, and the
 * DELETE confirmation for a destructive option. Event-specific copy is
 * supplied by the caller's eventLabel/body/title — this module knows nothing
 * about create/review/test.
 *
 * T-208: the answer form is ONE hook (useDecisionForm) rendered by two
 * surfaces — the panel's full modal (DecisionModal) and the shell overlay's
 * compact, docked card (DecisionCard). Both therefore show the same fields and
 * submit the same body (decisionAnswerPayload); the surfaces cannot drift.
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

	/** The option the form starts on: the marked default, when there is one. */
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
	 * The body the Host expects for one answer. Shared by the panel's modal and
	 * the shell overlay, so both post exactly the same fields (T-208 §8).
	 */
	function decisionAnswerPayload(decision, answer) {
		const source = answer === undefined || answer === null ? {} : answer
		const body = { decisionId: decision === null || decision === undefined ? '' : decision.id }
		if (source.option !== undefined) body.option = source.option
		if (typeof source.text === 'string' && source.text !== '') body.text = source.text
		if (typeof source.confirm === 'string' && source.confirm !== '') body.confirm = source.confirm
		return body
	}

	/**
	 * The ONE answer form (T-208). A hook rather than a nested element: the
	 * panel's modal root ('.gbt-decision') must stay the direct child of
	 * '.gbt-decisionoverlay' — the shipped CSS and the T-195 selectors key on
	 * that exact shape — while the overlay's compact card renders the same
	 * fields inside its own docked root.
	 *
	 * Returns null when there is no decision; the hooks above it still run so
	 * the count is stable between renders of the same mount.
	 */
	function useDecisionForm(current, t, props) {
		const safe = props === undefined || props === null ? {} : props
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
		if (current === null || current === undefined) return null
		// The one-second tick re-renders this form; read the clock then, so the
		// countdown keeps moving even while the parent's polling snapshot is idle.
		const now = Date.now()
		const chosenId = selected === null || selected === undefined ? decisionInitialOption(current) : selected
		const chosen = (Array.isArray(current.options) ? current.options : []).filter((option) => option.id === chosenId)[0] || null
		const danger = chosen !== null && chosen.danger === true
		const canConfirm = decisionCanConfirm(current, chosenId, text, confirmText)
		const submitting = safe.busy === true

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

		const openTask =
			typeof current.taskId === 'string' && current.taskId !== '' && typeof safe.onOpenTask === 'function'
				? h(
						'button',
						{
							type: 'button',
							className: 'gbt-btn',
							'data-decision-open-task': 'true',
							onClick: function () { safe.onOpenTask(current.taskId) },
						},
						t('decisionOpenTask'),
					)
				: null

		const error = typeof safe.error === 'string' && safe.error !== ''
			? h('p', { className: 'gbt-decisionerror', 'data-decision-error': 'true', role: 'alert' }, safe.error)
			: null

		return {
			canConfirm: canConfirm,
			danger: danger,
			nodes: [
				h('p', { key: 'subtitle', className: 'gbt-decisionsub', 'data-decision-subtitle': 'true' }, decisionSubtitle(current, t)),
				h('p', { key: 'countdown', className: 'gbt-decisioncountdown', 'data-decision-countdown': 'true' }, decisionCountdownText(current, safe.receivedAt, now, t)),
				current.title === '' ? null : h('p', { key: 'headline', className: 'gbt-decisionbody', 'data-decision-headline': 'true' }, current.title),
				current.body === '' ? null : h('p', { key: 'body', className: 'gbt-decisionbody', 'data-decision-body': 'true' }, current.body),
				optionNodes.length === 0 ? null : h('div', { key: 'options', className: 'gbt-decisionoptions', 'data-decision-options': 'true' }, optionNodes),
				h(
					'label',
					{ key: 'text', className: 'gbt-decisiontext' },
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
							{ key: 'highrisk', className: 'gbt-decisionhighrisk', 'data-decision-highrisk': 'true' },
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
				error,
				h(
					'div',
					{ key: 'foot', className: 'gbt-decisionfoot' },
					openTask,
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
								if (!canConfirm || typeof safe.onAnswer !== 'function') return
								safe.onAnswer(current, { option: chosenId, text: text, confirm: confirmText })
							},
						},
						submitting ? t('decisionAnswering') : t('decisionConfirm'),
					),
				),
			],
		}
	}

	/**
	 * The panel's full modal: the generic plugin view with one foregrounded
	 * decision, the queued count and the answer form. It never renders a close
	 * button — a question is resolved by answering one of its options (a
	 * "return"/"keep" option is one of them).
	 */
	function DecisionModal(props) {
		const safe = props === undefined || props === null ? {} : props
		const t = typeof safe.t === 'function' ? safe.t : function (key) { return key }
		const queue = Array.isArray(safe.queue) ? safe.queue : []
		const current = queue.length === 0 ? null : queue[0]
		// The form's hooks run even for an empty queue (it returns null), keeping
		// the hook order stable when the last decision is answered.
		const form = useDecisionForm(current, t, safe)
		if (current === null || form === null) return null
		const queueLeft = queue.length - 1
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
				form.nodes,
			),
		)
	}

	/**
	 * The shell overlay's compact card (T-208). Same form, same one-shot answer;
	 * the collapse control is the only thing the modal does not have, because a
	 * docked card may be put away without answering (the chip stays visible).
	 */
	function DecisionCard(props) {
		const safe = props === undefined || props === null ? {} : props
		const t = typeof safe.t === 'function' ? safe.t : function (key) { return key }
		const decision = safe.decision === undefined ? null : safe.decision
		const form = useDecisionForm(decision === undefined ? null : decision, t, safe)
		if (decision === null || decision === undefined || form === null) return null
		const queueLeft = Number.isFinite(safe.queueLeft) && safe.queueLeft > 0 ? Math.round(safe.queueLeft) : 0
		const dismiss = typeof safe.onDismiss === 'function' ? safe.onDismiss : null
		return h(
			'div',
			{ className: 'gbt-decision gbt-decisioncompact', role: 'dialog', 'aria-label': t('decisionTitle'), 'data-decision-card': 'true', 'data-decision-id': decision.id },
			h(
				'div',
				{ className: 'gbt-decisionhead' },
				h('h2', { 'data-decision-title': 'true' }, t('decisionTitle')),
				queueLeft > 0 ? h('span', { className: 'gbt-muted', 'data-decision-queue': 'true' }, t('decisionQueue').replace('{n}', String(queueLeft))) : null,
				dismiss === null
					? null
					: h(
							'button',
							{
								type: 'button',
								className: 'gbt-decisionclose',
								'data-decision-collapse': 'true',
								'aria-label': t('decisionOverlayCollapse'),
								title: t('decisionOverlayCollapse'),
								onClick: function () { dismiss() },
							},
							'×',
						),
			),
			form.nodes,
		)
	}

	DecisionModal.decisionRemainingSeconds = decisionRemainingSeconds
	DecisionModal.decisionSubtitle = decisionSubtitle
	DecisionModal.decisionInitialOption = decisionInitialOption
	DecisionModal.decisionCanConfirm = decisionCanConfirm
	DecisionModal.decisionCountdownText = decisionCountdownText
	DecisionModal.decisionDefaultOption = decisionDefaultOption
	DecisionModal.decisionAutoRunAllowed = decisionAutoRunAllowed
	DecisionModal.decisionAnswerPayload = decisionAnswerPayload
	DecisionModal.DecisionCard = DecisionCard
	DecisionModal.CONFIRM_WORD = CONFIRM_WORD
	return DecisionModal
}

module.exports = { createDecisionModal }
