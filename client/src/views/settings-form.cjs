/**
 * Settings form view module.
 *
 * Extracted from the forms fragment; React, h, Modal and the panel store are
 * injected by the build.
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
 * The event list below mirrors plugin/task-center/schema.mjs DECISION_EVENT_CATALOG;
 * client-settings-form.test.mjs compares the two so they cannot drift.
 */
function createSettingsForm(deps) {
	const React = deps.React
	const h = deps.h
	const Modal = deps.Modal
	const store = deps.store

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

	// Module-scoped drafts: one per scope, reset only when the SAVED policy
	// changes (a poll carrying the same overrides never wipes typing).
	const policyState = {
		signature: null,
		scope: 'project',
		drafts: { global: null, project: null },
		baseline: { global: null, project: null },
		resets: { global: {}, project: {} },
		error: '',
	}

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
			timeoutSeconds: Number.isFinite(row.timeoutSeconds) ? row.timeoutSeconds : 0,
			limit: row.limit === undefined ? null : row.limit,
			autoRecover: row.autoRecover === undefined ? null : row.autoRecover,
		}
	}

	function policySignature(policy) {
		if (policy === null || policy === undefined || typeof policy !== 'object') return 'none'
		return JSON.stringify({ global: policy.overrides === undefined ? null : policy.overrides.global, project: policy.overrides === undefined ? null : policy.overrides.project })
	}

	function ensureState(policy) {
		const signature = policySignature(policy)
		if (policyState.signature === signature && policyState.drafts.project !== null) return
		policyState.signature = signature
		policyState.drafts = { global: {}, project: {} }
		policyState.baseline = { global: {}, project: {} }
		policyState.resets = { global: {}, project: {} }
		policyState.error = ''
		for (const scope of ['global', 'project']) {
			for (const view of DECISION_EVENT_VIEWS) {
				const copy = rowCopy(rowOf(policy, scope, view.key))
				policyState.drafts[scope][view.key] = copy
				policyState.baseline[scope][view.key] = Object.assign({}, copy)
			}
		}
	}

	/** What this scope inherits once its own override is cleared. */
	function inheritedRow(policy, scope, key) {
		if (scope === 'project') return rowCopy(rowOf(policy, 'global', key))
		const defaults = policy !== null && policy !== undefined && policy.defaults !== undefined && policy.defaults !== null ? policy.defaults[key] : null
		return defaults === undefined || defaults === null ? rowCopy(rowOf(policy, 'global', key)) : rowCopy(defaults)
	}

	function SettingsForm(props) {
		const t = props.t
		const dispatch = props.dispatch !== null && props.dispatch !== undefined ? props.dispatch : {}
		const policy = props.policy !== null && props.policy !== undefined ? props.policy : null
		const theme = props.theme === 'console' ? 'console' : 'dsh'
		const concurrent = React.useRef(null)
		const attempts = React.useRef(null)
		const defaultTarget = React.useRef(null)
		const [tick, setTick] = React.useState(0)
		// The failure text lives in the module state (like the drafts), so a modal
		// that stays open keeps it and a test render can read it back.
		const error = policyState.error
		const currentConcurrent = Number.isFinite(dispatch.maxConcurrent) ? Math.max(1, Math.floor(dispatch.maxConcurrent)) : 3
		const currentAttempts = Number.isFinite(dispatch.maxAttempts) ? Math.max(1, Math.floor(dispatch.maxAttempts)) : 3
		ensureState(policy)
		const scope = policyState.scope

		function rerender() {
			setTick(tick + 1)
		}

		function setError(next) {
			policyState.error = next
			rerender()
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
			policyState.resets[targetScope][key] = Object.assign({}, inherited)
			policyState.drafts[targetScope][key] = Object.assign({}, inherited)
			rerender()
		}

		function resetAll() {
			for (const view of DECISION_EVENT_VIEWS) resetEvent(policyState.scope, view.key)
		}

		function setScope(next) {
			policyState.scope = next === 'global' ? 'global' : 'project'
			rerender()
		}

		/** The sparse patch the server should store for the current scope. */
		function policyChanges() {
			const current = policyState.scope
			const events = {}
			for (const view of DECISION_EVENT_VIEWS) {
				const draft = policyState.drafts[current][view.key]
				const resetSnapshot = policyState.resets[current][view.key]
				const base = resetSnapshot === undefined ? policyState.baseline[current][view.key] : resetSnapshot
				const patch = {}
				if (draft.mode !== base.mode) patch.mode = draft.mode
				if (draft.defaultOption !== base.defaultOption) patch.defaultOption = draft.defaultOption
				if (draft.timeoutSeconds !== base.timeoutSeconds) patch.timeoutSeconds = draft.timeoutSeconds
				if (draft.limit !== base.limit) patch.limit = draft.limit
				if (draft.autoRecover !== base.autoRecover) patch.autoRecover = draft.autoRecover
				if (Object.keys(patch).length > 0) events[view.key] = patch
			}
			const reset = Object.keys(policyState.resets[current])
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

		function save() {
			policyState.error = ''
			const concurrency = numberFrom(concurrent, currentConcurrent)
			const maxAttempts = numberFrom(attempts, currentAttempts)
			if (concurrency < 1 || concurrency > 8) {
				setError(t('invalidConcurrency'))
				return
			}
			if (maxAttempts < 1 || maxAttempts > 10) {
				setError(t('invalidMaxAttempts'))
				return
			}
			const changes = policyChanges()
			for (const key of Object.keys(changes.events)) {
				const patch = changes.events[key]
				if (patch.timeoutSeconds !== undefined && (!Number.isFinite(patch.timeoutSeconds) || patch.timeoutSeconds < 0 || patch.timeoutSeconds > 86400)) {
					setError(t('err_invalid_policy_timeout'))
					return
				}
				for (const field of ['limit', 'autoRecover']) {
					const value = patch[field]
					if (value === undefined || value === null) continue
					if (!Number.isFinite(value) || value < 0 || value > 10) {
						setError(field === 'limit' ? t('err_invalid_policy_limit') : t('err_invalid_policy_auto_recover'))
						return
					}
				}
			}
			const targetValue = defaultTarget.current === null || defaultTarget.current === undefined ? '' : String(defaultTarget.current.value === undefined || defaultTarget.current.value === null ? '' : defaultTarget.current.value).trim()
			void store.send('settings', {
				maxConcurrent: concurrency,
				maxAttempts: maxAttempts,
				defaultTarget: targetValue,
			}).then(function (result) {
				if (result.ok !== true) {
					setError(t('error'))
					return
				}
				const changed = Object.keys(changes.events).length > 0 || changes.reset.length > 0
				if (changed !== true) {
					props.onClose()
					return
				}
				void store.send('decisionPolicy', changes).then(function (policyResult) {
					if (policyResult.ok === true) props.onClose()
					else setError(policyErrorText(policyResult.payload))
				})
			})
		}

		function fieldInput(view, field, options) {
			const draft = policyState.drafts[scope][view.key]
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
			const draft = policyState.drafts[scope][view.key]
			const fixed = view.fixedMode !== undefined
			const resetDisabled = overridesOf(scope, view.key) !== true && policyState.resets[scope][view.key] === undefined
			return h(
				'tr',
				{ key: view.key, 'data-policy-event': view.key },
				h('th', { scope: 'row' }, t(view.labelKey)),
				h('td', null, fieldInput(view, 'mode', {
					kind: 'select',
					name: 'mode',
					disabled: fixed,
					title: fixed ? t('decisionGuardDeleteWord') : undefined,
					choices: DECISION_MODES.map(function (mode) { return { value: mode, label: mode } }),
				})),
				h('td', null, fieldInput(view, 'defaultOption', {
					kind: 'select',
					name: 'default',
					choices: (function () {
						// Only a safe option can be a default. If the current value is not
						// in that list (an older file) it is still shown, never blank.
						const selectable = view.options.filter(function (option) { return option.noDefault !== true })
						const shown = selectable.some(function (option) { return option.id === draft.defaultOption }) ? selectable : view.options
						return shown.map(function (option) { return { value: option.id, label: t(option.labelKey) } })
					})(),
				})),
				h('td', null, fieldInput(view, 'timeoutSeconds', { name: 'timeout', min: 0, max: 86400 })),
				h('td', null, fieldInput(view, 'limit', { name: 'limit', min: 0, max: 10, nullable: true })),
				h('td', null, fieldInput(view, 'autoRecover', { name: 'auto-recover', min: 0, max: 10, nullable: true })),
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

		const storage = policy !== null && policy !== undefined && policy.storage !== undefined && policy.storage !== null ? policy.storage : null
		const policyErrors = policy !== null && policy !== undefined && Array.isArray(policy.errors) ? policy.errors : []

		return h(
			Modal,
			{ title: t('settingsTitle'), onClose: props.onClose, t: t },
			h(
				'div',
				{ className: 'gbt-form gbt-settingsform' },
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
						}),
					),
					h('p', { className: 'gbt-settingsnote' }, t('concurrencyHint')),
				),
				h(
					'div',
					{ className: 'gbt-settingsgroup', 'data-settings-group': 'retry' },
					h('div', { className: 'gbt-settingsgrouphead' }, t('settingsRetryGroup')),
					h(
						'div',
						{ className: 'gbt-field' },
						h('label', null, t('settingsMaxAttempts')),
						h('input', { className: 'gbt-input', type: 'number', min: 1, max: 10, step: 1, ref: attempts, defaultValue: String(currentAttempts), 'data-field': 'max-attempts' }),
					),
					h('p', { className: 'gbt-settingsnote' }, t('settingsRetryHint')),
				),
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
					}),
				),
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
									onClick: function () {
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
									onClick: function () {
										setScope('project')
									},
								},
								t('decisionScopeProject'),
							),
						),
						h(
							'button',
							{ type: 'button', className: 'gbt-btn', 'data-policy-reset-all': scope, onClick: resetAll },
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
				error === '' ? null : h('p', { className: 'gbt-settingsnote', style: { color: 'var(--dsw-alias-state-error-primary)' } }, error),
				h(
					'div',
					{ className: 'gbt-actions' },
					h('button', { type: 'button', className: 'gbt-btn', 'data-variant': 'primary', onClick: save }, t('apply')),
					h('button', { type: 'button', className: 'gbt-btn', onClick: props.onClose }, t('cancel')),
				),
			),
		)
	}

	// The catalog is part of the component's contract: the drift test compares it
	// with the server's DECISION_EVENT_CATALOG (keys, option ids and defaults).
	SettingsForm.decisionEvents = DECISION_EVENT_VIEWS
	return SettingsForm
}

module.exports = { createSettingsForm }
