/**
 * Settings form view module.
 *
 * Extracted from the forms fragment; React, h and the panel store are injected
 * by the build.
 *
 * Dispatch has ONE capacity knob: maxConcurrent. A card's executor is started
 * for the card and released afterwards; there is no persistent worker ceiling.
 *
 * T-198 adds the DECISION POLICY editor (关键决策设置): one row per host event with
 * its mode (ask / notify / silent), default option, answer timeout, consecutive
 * limit and auto-recovery limit. The scope tabs switch between the user-wide
 * global default and this project's override; "恢复默认" clears the override in
 * the current scope. The fixed high-risk guards are rendered as disabled
 * checkboxes: the server enforces them, the panel only states them.
 *
 * T-205: this module no longer draws the modal shell. It renders the body of the
 * settings PAGE as one hidden/shown section per theme (常规 / 派发 / 重试 /
 * 关键决策 / Godot 引擎); the page owns the title, the left navigation, the
 * scrolling right column and the save/cancel footer. Keeping every section
 * MOUNTED (hidden, not unmounted) is deliberate: a half-typed field survives a
 * trip to another theme.
 *
 * The save/cancel footer lives in the page, so the component publishes its
 * save action on SettingsForm.actions. The action returns a promise resolving
 * { ok, error? } instead of closing anything: a page stays where it is.
 *
 * The event list below mirrors plugin/task-center/schema.mjs DECISION_EVENT_CATALOG;
 * client-settings-form.test.mjs compares the two so they cannot drift.
 */
function createSettingsForm(deps) {
	const React = deps.React
	const h = deps.h
	const store = deps.store

	/** The config field the engine-path section edits, as the host Config declares it. */
	const ENGINE_FIELD = 'godotPath'

	const DECISION_MODES = ['ask', 'notify', 'silent']

	// One entry per host event, in the aligned copy order (packet §5).
	const DECISION_EVENT_VIEWS = [
		{ key: 'create', labelKey: 'decisionEvent_create', options: [{ id: 'create', labelKey: 'decisionOpt_create_create' }, { id: 'cancel', labelKey: 'decisionOpt_create_cancel' }] },
		{
			key: 'dispatch',
			labelKey: 'decisionEvent_dispatch',
			options: [
				{ id: 'approve', labelKey: 'decisionOpt_dispatch_approve' },
				{ id: 'hold', labelKey: 'decisionOpt_dispatch_hold' },
				{ id: 'withdraw', labelKey: 'decisionOpt_dispatch_withdraw' },
			],
		},
		{
			key: 'dev-timeout',
			labelKey: 'decisionEvent_dev_timeout',
			options: [
				{ id: 'continue', labelKey: 'decisionOpt_dev_timeout_continue' },
				// Destructive options are NEVER a policy default (the server refuses
				// them); the row still shows them so the option list mirrors the modal.
				{ id: 'retry-dev', labelKey: 'decisionOpt_dev_timeout_retry_dev', noDefault: true },
				{ id: 'cancel', labelKey: 'decisionOpt_dev_timeout_cancel' },
				{ id: 'cancel-tree', labelKey: 'decisionOpt_dev_timeout_cancel_tree', noDefault: true },
			],
		},
		{
			key: 'review-timeout',
			labelKey: 'decisionEvent_review_timeout',
			options: [
				{ id: 'continue', labelKey: 'decisionOpt_review_timeout_continue' },
				{ id: 'replace', labelKey: 'decisionOpt_review_timeout_replace' },
				{ id: 'block', labelKey: 'decisionOpt_review_timeout_block' },
				{ id: 'cancel', labelKey: 'decisionOpt_review_timeout_cancel' },
			],
		},
		{
			key: 'test-timeout',
			labelKey: 'decisionEvent_test_timeout',
			options: [
				{ id: 'continue', labelKey: 'decisionOpt_test_timeout_continue' },
				{ id: 'replace', labelKey: 'decisionOpt_test_timeout_replace' },
				{ id: 'block', labelKey: 'decisionOpt_test_timeout_block' },
				{ id: 'cancel', labelKey: 'decisionOpt_test_timeout_cancel' },
			],
		},
		{
			key: 'reopen',
			labelKey: 'decisionEvent_reopen',
			options: [
				{ id: 'reopen', labelKey: 'decisionOpt_reopen_reopen' },
				{ id: 'keep', labelKey: 'decisionOpt_reopen_keep' },
			],
		},
		{
			key: 'delete',
			labelKey: 'decisionEvent_delete',
			// The delete guard: the mode is fixed to ask (the server refuses to store
			// anything else), so the select is disabled but still shows the truth.
			fixedMode: 'ask',
			options: [
				{ id: 'keep', labelKey: 'decisionOpt_delete_keep' },
				{ id: 'delete', labelKey: 'decisionOpt_delete_delete', noDefault: true },
			],
		},
		{
			key: 'cancel',
			labelKey: 'decisionEvent_cancel',
			options: [
				{ id: 'return', labelKey: 'decisionOpt_cancel_return' },
				{ id: 'confirm', labelKey: 'decisionOpt_cancel_confirm' },
			],
		},
		{
			key: 'host-verify-fail',
			labelKey: 'decisionEvent_host_verify_fail',
			options: [
				{ id: 'return-dev', labelKey: 'decisionOpt_host_verify_fail_return_dev' },
				{ id: 'block', labelKey: 'decisionOpt_host_verify_fail_block' },
				{ id: 'cancel', labelKey: 'decisionOpt_host_verify_fail_cancel' },
			],
		},
		{
			key: 'merge-conflict',
			labelKey: 'decisionEvent_merge_conflict',
			options: [
				{ id: 'return-dev', labelKey: 'decisionOpt_merge_conflict_return_dev' },
				{ id: 'block', labelKey: 'decisionOpt_merge_conflict_block' },
				{ id: 'cancel', labelKey: 'decisionOpt_merge_conflict_cancel' },
			],
		},
		{
			key: 'worker-lost',
			labelKey: 'decisionEvent_worker_lost',
			options: [
				{ id: 'redispatch', labelKey: 'decisionOpt_worker_lost_redispatch' },
				{ id: 'block', labelKey: 'decisionOpt_worker_lost_block' },
				{ id: 'cancel', labelKey: 'decisionOpt_worker_lost_cancel' },
			],
		},
		{
			key: 'target-drift',
			labelKey: 'decisionEvent_target_drift',
			options: [
				{ id: 'rebuild-retest', labelKey: 'decisionOpt_target_drift_rebuild_retest' },
				{ id: 'block', labelKey: 'decisionOpt_target_drift_block' },
				{ id: 'cancel', labelKey: 'decisionOpt_target_drift_cancel' },
			],
		},
		{
			key: 'review-rounds-exhausted',
			labelKey: 'decisionEvent_review_rounds_exhausted',
			options: [
				{ id: 'block', labelKey: 'decisionOpt_review_rounds_exhausted_block' },
				{ id: 'cancel', labelKey: 'decisionOpt_review_rounds_exhausted_cancel' },
			],
		},
	]

	const SECTION_KEYS = ['general', 'dispatch', 'retry', 'decisions', 'engine']

	// One drafts/baseline/resets bundle PER MOUNTED FORM, keyed by React.useId().
	// The page explicitly allows the panel page and the plugin card to be mounted
	// in the same document, so a module-scoped bundle would let the unsaved drafts
	// of one page leak into the other. The entry is dropped when the form unmounts.
	const policyStates = new Map()

	function policyStateOf(instanceId) {
		let state = policyStates.get(instanceId)
		if (state === undefined) {
			state = { signature: null, scope: 'project', drafts: { global: null, project: null }, baseline: { global: null, project: null }, resets: { global: {}, project: {} } }
			policyStates.set(instanceId, state)
		}
		return state
	}

	// The page's footer drives this: each render publishes the current save
	// closure (it owns the input refs and this instance's drafts). The page also
	// passes its own actions object; this registry is the direct-test seam.
	const formActions = { save: null }

	function rowOf(policy, scope, key) {
		const bucket = policy === null || policy === undefined ? null : scope === 'global' ? policy.global : policy.project
		const row = bucket !== null && bucket !== undefined ? bucket[key] : undefined
		if (row === undefined || row === null) return { mode: 'ask', defaultOption: '', timeoutSeconds: 120, limit: null, autoRecover: null }
		return row
	}

	function rowCopy(row) {
		return {
			mode: row.mode,
			defaultOption: row.defaultOption,
			// null = "the built-in fallback" (a notify event shows an empty field, as
			// the packet's "—"); 0 keeps its meaning: no deadline.
			timeoutSeconds: Number.isFinite(row.timeoutSeconds) ? row.timeoutSeconds : null,
			limit: row.limit === undefined ? null : row.limit,
			autoRecover: row.autoRecover === undefined ? null : row.autoRecover,
		}
	}

	function policySignature(policy) {
		if (policy === null || policy === undefined || typeof policy !== 'object') return 'none'
		return JSON.stringify({ global: policy.overrides === undefined ? null : policy.overrides.global, project: policy.overrides === undefined ? null : policy.overrides.project })
	}

	function ensureState(state, policy) {
		const signature = policySignature(policy)
		if (state.signature === signature && state.drafts.project !== null) return
		state.signature = signature
		state.drafts = { global: {}, project: {} }
		state.baseline = { global: {}, project: {} }
		state.resets = { global: {}, project: {} }
		for (const scope of ['global', 'project']) {
			for (const view of DECISION_EVENT_VIEWS) {
				const copy = rowCopy(rowOf(policy, scope, view.key))
				state.drafts[scope][view.key] = copy
				state.baseline[scope][view.key] = Object.assign({}, copy)
			}
		}
	}

	/** What this scope inherits once its own override is cleared. */
	function inheritedRow(policy, scope, key) {
		if (scope === 'project') return rowCopy(rowOf(policy, 'global', key))
		const defaults = policy !== null && policy !== undefined && policy.defaults !== undefined && policy.defaults !== null ? policy.defaults[key] : null
		return defaults === undefined || defaults === null ? rowCopy(rowOf(policy, 'global', key)) : rowCopy(defaults)
	}

	/** The host's plain text for the value a config scope projects. */
	function textOf(value) {
		return typeof value === 'string' ? value : ''
	}

	/**
	 * The engine-path section: the same config scope the plugin settings card
	 * has always edited, rendered in the page instead of in the card's own form.
	 */
	function EngineSection(props) {
		const t = props.t
		const scope = props.scope === undefined ? null : props.scope
		const inputId = typeof props.inputId === 'string' && props.inputId !== '' ? props.inputId : 'godot-bridge-engine-path'
		const input = React.useRef(null)
		const [busy, setBusy] = React.useState(false)
		const [dirty, setDirty] = React.useState(false)
		const [outcome, setOutcome] = React.useState(null)
		const [seenRevision, setSeenRevision] = React.useState(undefined)
		// A save's own answer must survive the revision bump it causes: the host
		// folds the new value in (moving revision) before this component reads
		// the accepted flag back.
		const keepOutcome = React.useRef(false)
		const subscribe = React.useMemo(
			function () {
				return function (listener) {
					if (scope === null || typeof scope.subscribe !== 'function') return function () {}
					return scope.subscribe(listener)
				}
			},
			[scope],
		)
		const read = React.useMemo(
			function () {
				return function () {
					return scope === null || typeof scope.getSnapshot !== 'function' ? null : scope.getSnapshot()
				}
			},
			[scope],
		)
		const state = React.useSyncExternalStore(subscribe, read, read)

		if (scope === null || scope === undefined) {
			return h('p', { className: 'gbt-settingsnote', 'data-settings-engine': 'unavailable', role: 'status' }, t('settingsEngineUnavailable'))
		}
		if (state === undefined || state === null || state.status === 'unavailable') {
			return h('p', { className: 'gbt-settingsnote', 'data-settings-engine': 'unavailable', role: 'status' }, t('settingsEngineUnavailable'))
		}
		// The settings document has not arrived yet; showing "unavailable" here
		// would be a lie, and the section fills in on its own.
		if (state.status !== 'ready') return null

		const revision = state.revision
		// A host revision means the document moved under us: the staged draft is
		// stale, so the next render starts from the stored value again.
		if (seenRevision !== revision) {
			setSeenRevision(revision)
			setDirty(false)
			if (keepOutcome.current) keepOutcome.current = false
			else setOutcome(null)
		}

		const projected = state.value === undefined || state.value === null ? undefined : state.value[ENGINE_FIELD]
		const value = textOf(projected)
		const overridden = state.user !== undefined && state.user !== null && Object.hasOwn(state.user, ENGINE_FIELD)
		const writable = state.writable === true

		/** Queue one field write and report whether the host accepted it. */
		function commit(write) {
			setBusy(true)
			setOutcome(null)
			return Promise.resolve()
				.then(function () {
					return write()
				})
				.then(
					function (accepted) {
						const ok = accepted === true
						if (ok) keepOutcome.current = true
						setBusy(false)
						setOutcome(ok ? 'saved' : 'failed')
						return ok
					},
					function () {
						setBusy(false)
						setOutcome('failed')
						return false
					},
				)
		}

		/** Store what the input holds; an empty draft clears the profile override. */
		function save() {
			const node = input.current
			const next = node === null || node === undefined ? '' : String(node.value === undefined || node.value === null ? '' : node.value)
			if (next === '') return commit(function () { return scope.unset(ENGINE_FIELD) })
			return commit(function () { return scope.set(ENGINE_FIELD, next) })
		}

		return h(
			'div',
			{ 'data-settings-engine': 'ready', 'data-settings-engine-overridden': overridden ? 'true' : 'false' },
			writable ? null : h('p', { className: 'gbt-settingsnote', role: 'status' }, t('settingsEngineReadOnly')),
			h(
				'div',
				{ className: 'gbt-field' },
				h(
					'div',
					{ className: 'gbt-settingsinline', style: { justifyContent: 'space-between' } },
					h('label', { htmlFor: inputId }, t('settingsEngineLabel')),
					overridden ? h('span', { className: 'gbt-chip' }, t('settingsEngineOverridden')) : null,
				),
				h('input', {
					id: inputId,
					className: 'gbt-input',
					key: 'revision-' + String(revision),
					ref: input,
					type: 'text',
					defaultValue: value,
					disabled: !writable || busy,
					spellCheck: false,
					autoComplete: 'off',
					'data-settings-engine-input': 'true',
					onInput: function () {
						setDirty(true)
						setOutcome(null)
					},
				}),
				h('p', { className: 'gbt-settingsnote' }, t('settingsEngineHint')),
			),
			h(
				'div',
				{ className: 'gbt-settingsinline' },
				h(
					'button',
					{
						type: 'button',
						className: 'gbt-btn',
						'data-variant': 'primary',
						'data-settings-engine-save': 'true',
						disabled: !writable || busy || !dirty,
						onClick: save,
					},
					busy ? t('settingsEngineSaving') : t('save'),
				),
				overridden
					? h(
							'button',
							{
								type: 'button',
								className: 'gbt-btn',
								'data-settings-engine-reset': 'true',
								disabled: !writable || busy,
								onClick: function () {
									return commit(function () { return scope.unset(ENGINE_FIELD) })
								},
							},
							t('settingsEngineReset'),
						)
					: null,
				outcome === null
					? null
					: h(
							'p',
							{ className: 'gbt-settingsnote', 'data-settings-engine-status': outcome, role: 'status' },
							outcome === 'saved' ? t('settingsEngineSaved') : t('settingsEngineFailed'),
						),
			),
		)
	}

	function SettingsForm(props) {
		// Hooks first: the id keys this instance's drafts AND the engine input id,
		// so two mounted pages can neither share drafts nor duplicate a DOM id.
		const instanceId = React.useId()
		const t = props.t
		const dispatch = props.dispatch !== null && props.dispatch !== undefined ? props.dispatch : {}
		const policy = props.policy !== null && props.policy !== undefined ? props.policy : null
		const theme = props.theme === 'console' ? 'console' : 'dsh'
		const concurrent = React.useRef(null)
		const attempts = React.useRef(null)
		const defaultTarget = React.useRef(null)
		const [tick, setTick] = React.useState(0)
		const unbound = props.unbound === true
		const active = typeof props.section === 'string' && SECTION_KEYS.indexOf(props.section) >= 0 ? props.section : 'general'
		const currentConcurrent = Number.isFinite(dispatch.maxConcurrent) ? Math.max(1, Math.floor(dispatch.maxConcurrent)) : 3
		const currentAttempts = Number.isFinite(dispatch.maxAttempts) ? Math.max(1, Math.floor(dispatch.maxAttempts)) : 3
		const state = policyStateOf(instanceId)
		React.useEffect(function () {
			return function () {
				policyStates.delete(instanceId)
			}
		}, [instanceId])
		ensureState(state, policy)
		const scope = state.scope

		function rerender() {
			setTick(tick + 1)
		}

		function numberFrom(ref, fallback) {
			if (ref !== null && ref !== undefined && ref.current !== null && ref.current !== undefined && ref.current.value !== undefined) {
				const value = Number(ref.current.value)
				if (Number.isFinite(value)) return Math.floor(value)
			}
			return fallback
		}

		function overridesOf(targetScope, key) {
			const overrides = policy === null || policy === undefined || policy.overrides === undefined ? null : policy.overrides[targetScope]
			return overrides !== null && overrides !== undefined && overrides[key] !== undefined
		}

		function resetEvent(targetScope, key) {
			// Remember what the scope inherits: a PURE reset sends no patch (the
			// override disappears); an edit after the reset is sent against this
			// inherited row, so the new value is explicit.
			const inherited = inheritedRow(policy, targetScope, key)
			state.resets[targetScope][key] = Object.assign({}, inherited)
			state.drafts[targetScope][key] = Object.assign({}, inherited)
			rerender()
		}

		function resetAll() {
			for (const view of DECISION_EVENT_VIEWS) resetEvent(state.scope, view.key)
		}

		function setScope(next) {
			state.scope = next === 'global' ? 'global' : 'project'
			rerender()
		}

		/** The sparse patch the server should store for the current scope. */
		function policyChanges() {
			const current = state.scope
			const events = {}
			for (const view of DECISION_EVENT_VIEWS) {
				const draft = state.drafts[current][view.key]
				const resetSnapshot = state.resets[current][view.key]
				const base = resetSnapshot === undefined ? state.baseline[current][view.key] : resetSnapshot
				const patch = {}
				if (draft.mode !== base.mode) patch.mode = draft.mode
				if (draft.defaultOption !== base.defaultOption) patch.defaultOption = draft.defaultOption
				if (draft.timeoutSeconds !== base.timeoutSeconds) patch.timeoutSeconds = draft.timeoutSeconds
				if (draft.limit !== base.limit) patch.limit = draft.limit
				if (draft.autoRecover !== base.autoRecover) patch.autoRecover = draft.autoRecover
				if (Object.keys(patch).length > 0) events[view.key] = patch
			}
			const reset = Object.keys(state.resets[current])
			return { scope: current, events: events, reset: reset }
		}

		function policyErrorText(result) {
			const code = result !== null && result !== undefined && typeof result.code === 'string' ? result.code : ''
			if (code !== '') {
				const key = 'err_' + code.replace(/[^A-Za-z0-9]+/g, '_').toLowerCase()
				const localized = t(key)
				if (typeof localized === 'string' && localized !== '' && localized !== key) return localized
			}
			return t('error')
		}

		/**
		 * Save the project-scoped settings and, only when the policy was edited,
		 * the decision policy. Resolves { ok, error? }: the page shows the outcome
		 * in its footer and stays where it is (a page is not a modal).
		 */
		function save() {
			if (unbound === true) return Promise.resolve({ ok: false, error: t('settingsUnboundHint') })
			const concurrency = numberFrom(concurrent, currentConcurrent)
			const maxAttempts = numberFrom(attempts, currentAttempts)
			if (concurrency < 1 || concurrency > 8) return Promise.resolve({ ok: false, error: t('invalidConcurrency') })
			if (maxAttempts < 1 || maxAttempts > 10) return Promise.resolve({ ok: false, error: t('invalidMaxAttempts') })
			const changes = policyChanges()
			for (const key of Object.keys(changes.events)) {
				const patch = changes.events[key]
				if (
					patch.timeoutSeconds !== undefined &&
					patch.timeoutSeconds !== null &&
					(!Number.isFinite(patch.timeoutSeconds) || patch.timeoutSeconds < 0 || patch.timeoutSeconds > 86400)
				) {
					return Promise.resolve({ ok: false, error: t('err_invalid_policy_timeout') })
				}
				for (const field of ['limit', 'autoRecover']) {
					const value = patch[field]
					if (value === undefined || value === null) continue
					if (!Number.isFinite(value) || value < 0 || value > 10) {
						return Promise.resolve({ ok: false, error: field === 'limit' ? t('err_invalid_policy_limit') : t('err_invalid_policy_auto_recover') })
					}
				}
			}
			const targetValue = defaultTarget.current === null || defaultTarget.current === undefined ? '' : String(defaultTarget.current.value === undefined || defaultTarget.current.value === null ? '' : defaultTarget.current.value).trim()
			return store
				.send('settings', {
					maxConcurrent: concurrency,
					maxAttempts: maxAttempts,
					defaultTarget: targetValue,
				})
				.then(function (result) {
					if (result.ok !== true) return { ok: false, error: t('error') }
					const changed = Object.keys(changes.events).length > 0 || changes.reset.length > 0
					if (changed !== true) return { ok: true }
					return store.send('decisionPolicy', changes).then(function (policyResult) {
						if (policyResult.ok === true) return { ok: true }
						return { ok: false, error: policyErrorText(policyResult.payload) }
					})
				})
		}

		// Publish the save action twice: the module registry is what the form tests
		// drive directly, while the page passes its OWN actions object so two
		// mounted settings pages (panel + plugin card) can never call each other's
		// save closure — and therefore never read each other's input refs.
		formActions.save = save
		if (props.actions !== null && props.actions !== undefined && typeof props.actions === 'object') props.actions.save = save

		function fieldInput(view, field, options) {
			const draft = state.drafts[scope][view.key]
			const value = draft[field]
			if (options.kind === 'select') {
				return h(
					'select',
					{
						className: 'gbt-input',
						'data-policy-field': options.name,
						'data-policy-event': view.key,
						value: value === undefined || value === null ? '' : String(value),
						disabled: options.disabled === true,
						title: options.title,
						onChange: function (event) {
							draft[field] = String(event.target.value)
							rerender()
						},
					},
					options.choices.map(function (choice) {
						return h('option', { key: choice.value, value: choice.value }, choice.label)
					}),
				)
			}
			const nullable = options.nullable === true
			return h('input', {
				className: 'gbt-input',
				type: 'number',
				min: options.min,
				max: options.max,
				step: 1,
				'data-policy-field': options.name,
				'data-policy-event': view.key,
				value: value === null || value === undefined ? '' : String(value),
				disabled: options.disabled === true,
				onChange: function (event) {
					const raw = String(event.target.value === undefined || event.target.value === null ? '' : event.target.value).trim()
					if (raw === '') {
						if (nullable === true) draft[field] = null
						else draft[field] = 0
						rerender()
						return
					}
					const parsed = Number(raw)
					if (Number.isFinite(parsed)) {
						draft[field] = Math.floor(parsed)
						rerender()
					}
				},
			})
		}

		function eventRow(view) {
			const draft = state.drafts[scope][view.key]
			const fixed = view.fixedMode !== undefined
			const resetDisabled = unbound === true || (overridesOf(scope, view.key) !== true && state.resets[scope][view.key] === undefined)
			return h(
				'tr',
				{ key: view.key, 'data-policy-event': view.key },
				h('th', { scope: 'row' }, t(view.labelKey)),
				h('td', null, fieldInput(view, 'mode', {
					kind: 'select',
					name: 'mode',
					disabled: fixed === true || unbound === true,
					title: fixed ? t('decisionGuardDeleteWord') : undefined,
					choices: DECISION_MODES.map(function (mode) { return { value: mode, label: mode } }),
				})),
				h('td', null, fieldInput(view, 'defaultOption', {
					kind: 'select',
					name: 'default',
					disabled: unbound === true,
					choices: (function () {
						// Only a safe option can be a default. If the current value is not
						// in that list (an older file) it is still shown, never blank.
						const selectable = view.options.filter(function (option) { return option.noDefault !== true })
						const shown = selectable.some(function (option) { return option.id === draft.defaultOption }) ? selectable : view.options
						return shown.map(function (option) { return { value: option.id, label: t(option.labelKey) } })
					})(),
				})),
				h('td', null, fieldInput(view, 'timeoutSeconds', { name: 'timeout', min: 0, max: 86400, nullable: true, disabled: unbound === true })),
				h('td', null, fieldInput(view, 'limit', { name: 'limit', min: 0, max: 10, nullable: true, disabled: unbound === true })),
				h('td', null, fieldInput(view, 'autoRecover', { name: 'auto-recover', min: 0, max: 10, nullable: true, disabled: unbound === true })),
				h(
					'td',
					null,
					h(
						'button',
						{
							type: 'button',
							className: 'gbt-btn',
							'data-policy-reset': view.key,
							disabled: resetDisabled,
							onClick: function () {
								resetEvent(scope, view.key)
							},
						},
						t('decisionResetEvent'),
					),
				),
			)
		}

		/** One page section: mounted so drafts survive, hidden when not selected. */
		function sectionPanel(key, children) {
			const hidden = active !== 'all' && active !== key
			return h(
				'section',
				{
					key: key,
					className: 'gbt-settingssection',
					'data-settings-section': key,
					hidden: hidden ? true : undefined,
					'aria-hidden': hidden ? 'true' : undefined,
				},
				children,
			)
		}

		const storage = policy !== null && policy !== undefined && policy.storage !== undefined && policy.storage !== null ? policy.storage : null
		const policyErrors = policy !== null && policy !== undefined && Array.isArray(policy.errors) ? policy.errors : []

		const themePanel = sectionPanel('general', [
			h(
				'div',
				{ className: 'gbt-settingsgroup', 'data-settings-group': 'theme' },
				h('div', { className: 'gbt-settingsgrouphead' }, t('settingsThemeGroup')),
				h(
					'div',
					{ className: 'gbt-field' },
					h('label', null, t('settingsTheme')),
					h(
						'select',
						{
							className: 'gbt-input',
							'data-field': 'ui-theme',
							'data-tc-theme-select': 'true',
							value: theme,
							onChange: function (event) {
								const next = event !== null && event !== undefined && event.target !== undefined ? String(event.target.value) : 'dsh'
								if (typeof props.onThemeChange === 'function') props.onThemeChange(next)
							},
						},
						h('option', { value: 'dsh' }, t('settingsThemeDsh')),
						h('option', { value: 'console' }, t('settingsThemeConsole')),
					),
				),
				h('p', { className: 'gbt-settingsnote' }, t('settingsThemeHint')),
			),
		])

		const dispatchPanel = sectionPanel('dispatch', [
			h(
				'div',
				{ className: 'gbt-settingsgroup', 'data-settings-group': 'concurrency' },
				h('div', { className: 'gbt-settingsgrouphead' }, t('settingsConcurrencyGroup')),
				h(
					'div',
					{ className: 'gbt-field' },
					h('label', null, t('maxConcurrent')),
					h('input', {
						className: 'gbt-input',
						type: 'number',
						min: 1,
						max: 8,
						step: 1,
						ref: concurrent,
						defaultValue: String(currentConcurrent),
						'data-field': 'max-concurrent',
						disabled: unbound === true,
					}),
				),
				h('p', { className: 'gbt-settingsnote' }, t('concurrencyHint')),
			),
			h(
				'div',
				{ className: 'gbt-settingsgroup', 'data-settings-group': 'default-target' },
				h(
					'div',
					{ className: 'gbt-field' },
					h('label', null, t('defaultTargetLabel')),
					h('input', {
						className: 'gbt-input',
						'data-field': 'default-target',
						ref: defaultTarget,
						defaultValue: typeof dispatch.defaultTarget === 'string' ? dispatch.defaultTarget : '',
						placeholder: t('defaultTargetHint'),
						disabled: unbound === true,
					}),
				),
			),
		])

		const retryPanel = sectionPanel('retry', [
			h(
				'div',
				{ className: 'gbt-settingsgroup', 'data-settings-group': 'retry' },
				h('div', { className: 'gbt-settingsgrouphead' }, t('settingsRetryGroup')),
				h(
					'div',
					{ className: 'gbt-field' },
					h('label', null, t('settingsMaxAttempts')),
					h('input', { className: 'gbt-input', type: 'number', min: 1, max: 10, step: 1, ref: attempts, defaultValue: String(currentAttempts), 'data-field': 'max-attempts', disabled: unbound === true }),
				),
				h('p', { className: 'gbt-settingsnote' }, t('settingsRetryHint')),
			),
		])

		const decisionsPanel = sectionPanel('decisions', [
			h(
				'div',
				{ className: 'gbt-settingsgroup', 'data-settings-group': 'decisions' },
				h('div', { className: 'gbt-settingsgrouphead' }, t('decisionSettingsTitle')),
				h('p', { className: 'gbt-settingsnote' }, t('decisionSettingsHint')),
				h(
					'div',
					{ className: 'gbt-settingsinline' },
					h('span', null, t('decisionScope')),
					h(
						'div',
						{ className: 'gbt-policyscopes' },
						h(
							'button',
							{
								type: 'button',
								className: 'gbt-policyscope',
								'data-policy-scope': 'global',
								'data-active': scope === 'global' ? 'true' : 'false',
								disabled: unbound === true,
								onClick: function () {
									if (unbound === true) return
									setScope('global')
								},
							},
							t('decisionScopeGlobal'),
						),
						h(
							'button',
							{
								type: 'button',
								className: 'gbt-policyscope',
								'data-policy-scope': 'project',
								'data-active': scope === 'project' ? 'true' : 'false',
								disabled: unbound === true,
								onClick: function () {
									if (unbound === true) return
									setScope('project')
								},
							},
							t('decisionScopeProject'),
						),
					),
					h(
						'button',
						{ type: 'button', className: 'gbt-btn', 'data-policy-reset-all': scope, disabled: unbound === true, onClick: resetAll },
						t('decisionResetAll'),
					),
				),
				h('p', { className: 'gbt-settingsnote' }, t('decisionScopeHint')),
				storage !== null && storage.global === 'workspace' ? h('p', { className: 'gbt-settingsnote', 'data-policy-storage': 'workspace' }, t('decisionPolicyWorkspaceNote')) : null,
				policyErrors.length > 0
					? h(
							'p',
							{ className: 'gbt-settingsnote', 'data-policy-errors': 'true' },
							policyErrors.map(function (entry) { return String(entry.scope) + ': ' + String(entry.code) }).join(', '),
						)
					: null,
				h('div', { className: 'gbt-tablewrap' }, h(
					'table',
					{ className: 'gbt-policytable', 'data-decision-policy-table': 'true' },
					h(
						'thead',
						null,
						h(
							'tr',
							null,
							h('th', null, t('decisionEventColumn')),
							h('th', null, t('decisionModeLabel')),
							h('th', null, t('decisionDefaultLabel')),
							h('th', null, t('decisionTimeoutLabel')),
							h('th', null, t('decisionLimitLabel')),
							h('th', null, t('decisionAutoRecoverLabel')),
							h('th', null, ''),
						),
					),
					h('tbody', null, DECISION_EVENT_VIEWS.map(eventRow)),
				)),
				h(
					'div',
					{ 'data-policy-guards': 'true' },
					h('div', { className: 'gbt-settingsgrouphead' }, t('decisionGuardsTitle')),
					h(
						'label',
						{ className: 'gbt-policyguard' },
						h('input', { type: 'checkbox', checked: true, disabled: true, readOnly: true, 'data-policy-guard': 'delete-word' }),
						t('decisionGuardDeleteWord'),
					),
					h(
						'label',
						{ className: 'gbt-policyguard' },
						h('input', { type: 'checkbox', checked: true, disabled: true, readOnly: true, 'data-policy-guard': 'timeout-no-delete' }),
						t('decisionGuardTimeoutDelete'),
					),
					h('p', { className: 'gbt-settingsnote' }, t('decisionGuardHint')),
				),
			),
		])

		const enginePanel = sectionPanel('engine', [
			h('div', { className: 'gbt-settingsgroup', 'data-settings-group': 'engine' }, h(EngineSection, { t: t, scope: props.engineScope === undefined ? null : props.engineScope, inputId: 'godot-bridge-engine-path-' + instanceId })),
		])

		return h(
			'div',
			{ className: 'gbt-settingssections', 'data-settings-sections': 'true', 'data-settings-active': active, 'data-settings-bound': unbound === true ? 'false' : 'true' },
			themePanel,
			dispatchPanel,
			retryPanel,
			decisionsPanel,
			enginePanel,
		)
	}

	// The catalog is part of the component's contract: the drift test compares it
	// with the server's DECISION_EVENT_CATALOG (keys, option ids and defaults).
	SettingsForm.decisionEvents = DECISION_EVENT_VIEWS
	// The page's footer drives this; the form keeps the input refs and drafts.
	SettingsForm.actions = formActions
	SettingsForm.sections = SECTION_KEYS
	return SettingsForm
}

module.exports = { createSettingsForm }
