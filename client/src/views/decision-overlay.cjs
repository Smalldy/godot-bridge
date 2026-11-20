/**
 * DecisionOverlay (T-208): the conversation-page entry for the Host's pending
 * decisions.
 *
 * Other plugins (dsh-plugin-opencode-usage) use the 'shell.overlay' list slot
 * for a floating entry beside the session content. The task center only
 * registered 'main' / 'sidebar.panellist' / 'plugins.bundle.config', so a
 * pending decision was invisible until the user opened the panel. This view is
 * registered into 'shell.overlay' by client/src/40-tail.part and renders:
 *
 *   - a "待决策 N" chip in the free corner of the session centre column,
 *     visible ONLY while the queue is non-empty;
 *   - on click, a compact docked card that reuses the decision modal's own
 *     answer form (DecisionModal.DecisionCard): headline/body/options/server
 *     countdown/free text/high-risk DELETE confirmation. ONE decision is shown
 *     at a time; answering advances the queue automatically.
 *
 * The queue comes from the SHARED task store: the full snapshot already carries
 * `decisions`, and store.loadDecisions() polls only the decision list, so the
 * conversation page never pulls the whole board every few seconds. An answer
 * goes through the same store.send('decisionAnswer') as the panel modal, and
 * the store's one-shot guard is what stops the two surfaces from
 * double-submitting the same request.
 *
 * Placement: like the existing shell overlays, the entry is anchored inside the
 * AppFrame's overlay layer at the session centre column's inline end. It is
 * lifted ABOVE the composer card ([data-composer-card]) whenever the
 * conversation is docked, so a narrow viewport can never cover the input box.
 * Without a measurable docked composer it falls back to the corner.
 *
 * Injected by the build: React, h, DecisionModal, store, useTranslate,
 * useSnapshot and tcErrorMessage.
 */
function createDecisionOverlay(deps) {
	const React = deps.React
	const h = deps.h
	const DecisionModal = deps.DecisionModal
	const DecisionCard = DecisionModal.DecisionCard
	const store = deps.store
	const useTranslate = deps.useTranslate
	const useSnapshot = deps.useSnapshot
	const tcErrorMessage = deps.tcErrorMessage
	// React.lazy/older runtimes may not expose useLayoutEffect in a test shim;
	// measuring after a normal effect is still correct, just one paint late.
	const useLayoutEffect = typeof React.useLayoutEffect === 'function' ? React.useLayoutEffect : React.useEffect

	/** How often the conversation page asks for the decision list. */
	const POLL_MS = 5000
	const EDGE = 12
	const CHIP_GAP = 8
	const CHIP_HEIGHT = 30
	const PANEL_MAX = 520

	// Like the panel's module-backed state, the expanded flag survives a slot
	// remount (the shell re-registers overlays when the layout changes).
	const state = { open: false }

	/** The pending queue, oldest first, exactly as the Host ordered it. */
	function decisionQueueOf(snapshot) {
		if (snapshot === null || snapshot === undefined || !Array.isArray(snapshot.decisions)) return []
		return snapshot.decisions.filter(function (entry) {
			if (entry === null || entry === undefined || typeof entry !== 'object') return false
			if (typeof entry.id !== 'string' || entry.id === '') return false
			if (typeof entry.status === 'string' && entry.status !== 'pending') return false
			return true
		})
	}

	/** The AppFrame overlay layer that owns this entry (data-shell-overlay). */
	function overlayLayerOf(node) {
		let current = node === null || node === undefined ? null : node.parentElement
		while (current !== null && current !== undefined) {
			if (typeof current.getAttribute === 'function' && current.getAttribute('data-shell-overlay') !== null) return current
			current = current.parentElement
		}
		return null
	}

	/**
	 * The session centre column inside the AppFrame. Walking up from the
	 * composer (or the conversation's data-phase root) is robust in drawer mode,
	 * where a mask element shifts the frame's children by one; the grid index
	 * (sidebar | centre | rightbar) is only the fallback.
	 */
	function centerColumnOf(frame) {
		if (frame === null || frame === undefined) return null
		const globalDocument = typeof document === 'undefined' ? null : document
		if (globalDocument !== null && typeof globalDocument.querySelector === 'function') {
			const anchors = ['[data-composer-card]', '[data-phase]']
			for (let index = 0; index < anchors.length; index += 1) {
				let node = globalDocument.querySelector(anchors[index])
				while (node !== null && node !== undefined && node.parentElement !== frame) node = node.parentElement
				if (node !== null && node !== undefined && node.parentElement === frame) return node
			}
		}
		if (frame.children === undefined || frame.children === null) return null
		// Drawer mode inserts a mask before the sidebar, shifting the grid index.
		let offset = 1
		if (globalDocument !== null && typeof globalDocument.querySelector === 'function') {
			const mask = globalDocument.querySelector('[data-sidebar-mask]')
			if (mask !== null && frame.children[0] === mask) offset = 2
		}
		return frame.children[offset] === undefined ? null : frame.children[offset]
	}

	/** The conversation's composer card, when this page has one. */
	function composerOf(center) {
		if (center === null || center === undefined || typeof center.querySelector !== 'function') return null
		try {
			return center.querySelector('[data-composer-card]')
		} catch (error) {
			return null
		}
	}

	/**
	 * Is the composer DOCKED at the bottom of the conversation (rather than the
	 * centred hero card)? The host marks the conversation phase; the geometric
	 * fallback covers hosts that predate it.
	 */
	function composerIsDocked(composer, composerRect, centerRect) {
		if (composer !== null && typeof composer.closest === 'function') {
			const phaseNode = composer.closest('[data-phase]')
			if (phaseNode !== null && typeof phaseNode.getAttribute === 'function') {
				const phase = phaseNode.getAttribute('data-phase')
				if (phase === 'hero') return false
				if (phase === 'active') return true
			}
		}
		if (centerRect === null || !(centerRect.height > 0) || composerRect === null) return true
		return composerRect.top > centerRect.top + centerRect.height * 0.5
	}

	/**
	 * Pixel placement of the chip inside the overlay layer, plus the height the
	 * docked card may use before it would run off the top of the viewport.
	 * Returns null when there is nothing measurable (tests, detached mounts).
	 */
	function computePlacement(root) {
		if (root === null || root === undefined || typeof root.getBoundingClientRect !== 'function') return null
		const layer = overlayLayerOf(root)
		if (layer === null) return null
		const layerRect = layer.getBoundingClientRect()
		if (!(layerRect.height > 0) || !(layerRect.width > 0)) return null
		const frame = layer.parentElement
		const center = centerColumnOf(frame)
		const centerRect = center !== null && center !== undefined && typeof center.getBoundingClientRect === 'function' ? center.getBoundingClientRect() : null
		const composer = composerOf(center)
		const composerRect = composer !== null && typeof composer.getBoundingClientRect === 'function' ? composer.getBoundingClientRect() : null
		// Inline end of the session centre column, mirroring the existing shell
		// overlays' bottom-left corner habit (this plugin takes the bottom-right
		// so the two chips never sit on top of each other).
		const anchorRight = centerRect === null || !(centerRect.width > 0) ? layerRect.right : Math.min(layerRect.right, centerRect.right)
		const right = Math.max(EDGE, Math.round(layerRect.right - anchorRight + EDGE))
		let bottom = EDGE + 4
		if (composerRect !== null && composerRect.height > 0 && composerIsDocked(composer, composerRect, centerRect)) {
			// 12px above the composer: the chip (and the card that opens upwards)
			// never covers the input box, however narrow the viewport is.
			bottom = Math.max(EDGE, Math.round(layerRect.bottom - composerRect.top + EDGE))
		}
		// A very tall composer must not push the chip into the middle of the page.
		const ceiling = Math.max(EDGE, Math.round(layerRect.height * 0.6))
		if (bottom > ceiling) bottom = ceiling
		const panelMax = Math.max(160, Math.min(PANEL_MAX, Math.round(layerRect.height - bottom - CHIP_HEIGHT - CHIP_GAP - EDGE)))
		return { right: right, bottom: bottom, maxHeight: panelMax }
	}

	/**
	 * The shell overlay entry: the chip, and (when expanded) the docked card for
	 * the oldest pending decision.
	 */
	function DecisionOverlay(props) {
		const t = useTranslate()
		const snapshot = useSnapshot()
		const queue = decisionQueueOf(snapshot)
		const count = queue.length
		const currentId = count === 0 ? null : queue[0].id
		const [open, setOpenState] = React.useState(function () {
			if (state.open) return true
			return props !== undefined && props !== null && props.initialOpen === true
		})
		const [error, setError] = React.useState('')
		const [submitting, setSubmitting] = React.useState(false)
		const [placement, setPlacement] = React.useState(null)
		const rootRef = React.useRef(null)
		const wasOpen = React.useRef(false)

		function setOpen(next) {
			state.open = next === true
			setOpenState(next === true)
		}

		function measure() {
			const next = computePlacement(rootRef.current)
			if (next === null) return
			setPlacement(function (previous) {
				if (previous !== null && previous.right === next.right && previous.bottom === next.bottom && previous.maxHeight === next.maxHeight) return previous
				return next
			})
		}

		// Poll ONLY the decision list (never the board) while the conversation
		// page is open: this is the lightweight queue refresh the task asks for.
		React.useEffect(function () {
			if (typeof store.loadDecisions === 'function') void store.loadDecisions()
			if (typeof setInterval !== 'function') return undefined
			const handle = setInterval(function () {
				if (typeof store.loadDecisions === 'function') void store.loadDecisions()
			}, POLL_MS)
			return function () { clearInterval(handle) }
		}, [])

		// A different foregrounded decision starts without the previous answer's
		// error; an empty queue collapses the card so a LATER decision does not
		// pop it open by itself.
		React.useEffect(function () {
			if (error !== '') setError('')
		}, [currentId])
		React.useEffect(function () {
			if (count > 0) return
			if (state.open) setOpen(false)
		}, [count])

		// Measure after every render: opening the card, the queue advancing and a
		// layout change all re-anchor the entry.
		useLayoutEffect(function () {
			measure()
		})

		React.useEffect(function () {
			const globalWindow = typeof window === 'undefined' ? null : window
			if (globalWindow === null) return undefined
			function onResize() { measure() }
			globalWindow.addEventListener('resize', onResize)
			let observer = null
			if (typeof ResizeObserver === 'function') {
				observer = new ResizeObserver(function () { measure() })
				const layer = overlayLayerOf(rootRef.current)
				const frame = layer !== null ? layer.parentElement : null
				const center = centerColumnOf(frame)
				if (center !== null) observer.observe(center)
				const composer = composerOf(center)
				if (composer !== null) observer.observe(composer)
			}
			return function () {
				globalWindow.removeEventListener('resize', onResize)
				if (observer !== null) observer.disconnect()
			}
		}, [open])

		// Move focus into the card on open and back to the chip on close, so a
		// keyboard user does not have to shift-Tab behind the trigger (the card is
		// rendered before the chip in DOM order).
		React.useEffect(function () {
			const root = rootRef.current
			if (root !== null && root !== undefined && typeof root.querySelector === 'function') {
				const target = open === true ? root.querySelector('[data-decision-collapse]') : wasOpen.current === true ? root.querySelector('[data-decision-chip]') : null
				if (target !== null && target !== undefined && typeof target.focus === 'function') target.focus()
			}
			wasOpen.current = open === true
		}, [open])

		// Escape and an outside click collapse the docked card (the host's own
		// popovers behave the same way).
		React.useEffect(function () {
			if (open !== true) return undefined
			if (typeof document === 'undefined') return undefined
			function onKey(event) {
				if (event !== null && event.key === 'Escape') setOpen(false)
			}
			function onPointer(event) {
				const root = rootRef.current
				if (root === null || typeof root.contains !== 'function') return
				if (event !== null && event.target !== null && root.contains(event.target) !== true) setOpen(false)
			}
			document.addEventListener('keydown', onKey)
			document.addEventListener('pointerdown', onPointer)
			return function () {
				document.removeEventListener('keydown', onKey)
				document.removeEventListener('pointerdown', onPointer)
			}
		}, [open])

		/**
		 * Answer the foregrounded decision through the SHARED store, then refresh
		 * the queue immediately: the next decision is shown without waiting for
		 * the poll. A duplicate (the panel modal answered first) is not an error —
		 * the refresh is the only thing left to do.
		 */
		function answer(decision, formAnswer) {
			if (decision === null || decision === undefined || submitting) return
			setSubmitting(true)
			setError('')
			const payload = DecisionModal.decisionAnswerPayload(decision, formAnswer)
			void store.send('decisionAnswer', payload).then(function (result) {
				setSubmitting(false)
				const ok = result !== null && result !== undefined && result.ok === true
				const duplicate = result !== null && result !== undefined && result.duplicate === true
				if (ok || duplicate) {
					if (typeof store.loadDecisions === 'function') void store.loadDecisions()
					return
				}
				const failed = result === null || result === undefined ? null : (result.payload === undefined ? null : result.payload)
				setError(typeof tcErrorMessage === 'function' ? tcErrorMessage(failed, t) : t('error'))
			})
		}

		if (count === 0) return null
		const current = queue[0]
		const storeBusy = snapshot.busy !== null && snapshot.busy !== undefined && snapshot.busy.action === 'decisionAnswer'
		const chipStyle = placement === null ? undefined : { right: placement.right + 'px', bottom: placement.bottom + 'px' }
		const panelStyle = placement === null ? undefined : { maxHeight: placement.maxHeight + 'px' }
		const chipLabel = t('decisionOverlayChip').replace('{n}', String(count))
		return h(
			'div',
			{
				ref: rootRef,
				className: 'gbt-decisiondock',
				'data-decision-dock': 'true',
				'data-decision-pending': String(count),
				style: chipStyle,
			},
			open
				? h(
						'section',
						{
							className: 'gbt-decisiondockpanel',
							'data-decision-dock-panel': 'true',
							role: 'dialog',
							'aria-label': t('decisionTitle'),
							style: panelStyle,
						},
						h(DecisionCard, {
							key: current.id,
							decision: current,
							queueLeft: count - 1,
							receivedAt: snapshot.receivedAt,
							t: t,
							busy: submitting || storeBusy,
							error: error,
							onAnswer: answer,
							onDismiss: function () { setOpen(false) },
						}),
					)
				: null,
			h(
				'button',
				{
					type: 'button',
					className: 'gbt-chipbtn gbt-decisionchip',
					'data-decision-chip': 'true',
					'aria-expanded': open ? 'true' : 'false',
					'aria-haspopup': 'dialog',
					'aria-label': chipLabel,
					title: t('decisionOverlayAria'),
					onClick: function () { setOpen(!open) },
				},
				h('span', { className: 'gbt-decisionchipdot', 'aria-hidden': 'true' }),
				h('span', { 'data-decision-chip-label': 'true' }, chipLabel),
			),
		)
	}

	DecisionOverlay.state = state
	DecisionOverlay.POLL_MS = POLL_MS
	DecisionOverlay.decisionQueueOf = decisionQueueOf
	DecisionOverlay.computePlacement = computePlacement
	return DecisionOverlay
}

module.exports = { createDecisionOverlay }
