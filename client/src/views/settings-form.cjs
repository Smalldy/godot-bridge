/**
 * Settings form view module.
 *
 * Extracted from the forms fragment; React, h, Modal and the panel store are
 * injected by the build.
 *
 * T-167: task concurrency and the Worker-pool ceiling are two explicit knobs.
 * The form also shows the derived workerCap, the team the settings need, and
 * the current live/missing pool, so "concurrency 3" is never mistaken for
 * "three workers are available".
 */
function createSettingsForm(deps) {
	const React = deps.React
	const h = deps.h
	const Modal = deps.Modal
	const store = deps.store

	function SettingsForm(props) {
		const t = props.t
		const dispatch = props.dispatch !== null && props.dispatch !== undefined ? props.dispatch : {}
		const theme = props.theme === 'console' ? 'console' : 'dsh'
		// T-167: the panel already holds the live worker/scheduler snapshot; read it
		// through the injected store so the settings modal can show live/missing and
		// the last spawn failure without widening the task-center view's props.
		const snapshot = store !== null && store !== undefined && typeof store.getSnapshot === 'function' ? store.getSnapshot() : null
		const workers = snapshot !== null && snapshot.workers !== null && snapshot.workers !== undefined ? snapshot.workers : props.workers !== null && props.workers !== undefined ? props.workers : null
		const scheduler = snapshot !== null && snapshot.scheduler !== null && snapshot.scheduler !== undefined ? snapshot.scheduler : props.scheduler !== null && props.scheduler !== undefined ? props.scheduler : null
		const concurrent = React.useRef(null)
		const workerAgents = React.useRef(null)
		const attempts = React.useRef(null)
		const allowSpawn = React.useRef(null)
		const defaultTarget = React.useRef(null)
		const [error, setError] = React.useState('')
		const currentConcurrent = Number.isFinite(dispatch.maxConcurrent) ? Math.max(1, Math.floor(dispatch.maxConcurrent)) : 3
		const currentWorkerAgents = Number.isFinite(dispatch.maxWorkAgents) ? Math.max(1, Math.floor(dispatch.maxWorkAgents)) : Math.min(12, currentConcurrent + 1)
		const currentAttempts = Number.isFinite(dispatch.maxAttempts) ? Math.max(1, Math.floor(dispatch.maxAttempts)) : 3
		const [preview, setPreview] = React.useState({ concurrent: currentConcurrent, agents: currentWorkerAgents })
		const previewConcurrent = Number.isFinite(preview.concurrent) && preview.concurrent >= 1 ? preview.concurrent : currentConcurrent
		const previewAgents = Number.isFinite(preview.agents) && preview.agents >= 1 ? preview.agents : currentWorkerAgents
		const workerCap = Math.max(1, Math.min(previewConcurrent, previewAgents))
		const teamRequired = workerCap + 3
		// T-166/T-168: reuse the capacity fields the dispatcher already exposes
		// instead of re-deriving the pool from dispatch settings here.
		const lastCapacity = scheduler !== null && scheduler.lastCapacity !== null && scheduler.lastCapacity !== undefined ? scheduler.lastCapacity : null
		const roles = workers !== null && workers.roles !== null && workers.roles !== undefined ? workers.roles : null
		let liveWorkers = null
		if (lastCapacity !== null && Number.isFinite(lastCapacity.live)) {
			liveWorkers = Math.max(0, Math.floor(lastCapacity.live))
		} else if (roles !== null && roles.live !== null && roles.live !== undefined && Number.isFinite(roles.live.worker)) {
			liveWorkers = Math.max(0, Math.floor(roles.live.worker))
		} else if (workers !== null && Array.isArray(workers.members)) {
			liveWorkers = workers.members.filter(function (member) {
				return member !== null && typeof member === 'object' && member.kind === 'worker' && member.status !== 'failed'
			}).length
		}
		const missingWorkers = liveWorkers === null ? null : Math.max(0, workerCap - liveWorkers)
		const lastResults = scheduler !== null && Array.isArray(scheduler.lastResults) ? scheduler.lastResults : []
		const skippedCodes = new Set()
		lastResults.forEach(function (entry) {
			if (entry !== null && entry !== undefined && typeof entry.skipped === 'string' && entry.skipped !== '') skippedCodes.add(entry.skipped)
		})
		const workersError = workers !== null && typeof workers.error === 'string' && workers.error !== '' ? workers.error : null

		function numberFrom(ref, fallback) {
			if (ref !== null && ref !== undefined && ref.current !== null && ref.current !== undefined && ref.current.value !== undefined) {
				const value = Number(ref.current.value)
				if (Number.isFinite(value)) return Math.floor(value)
			}
			return fallback
		}

		function fill(template, values) {
			let out = String(template)
			Object.keys(values).forEach(function (key) {
				out = out.split('{' + key + '}').join(String(values[key]))
			})
			return out
		}

		function useSuggestion() {
			const concurrency = numberFrom(concurrent, currentConcurrent)
			const suggested = Math.min(12, Math.max(1, concurrency + 1))
			if (workerAgents.current !== null && workerAgents.current !== undefined) workerAgents.current.value = String(suggested)
			setPreview({ concurrent: concurrency, agents: suggested })
		}

		function save() {
			const concurrency = numberFrom(concurrent, currentConcurrent)
			const agents = numberFrom(workerAgents, currentWorkerAgents)
			const maxAttempts = numberFrom(attempts, currentAttempts)
			if (concurrency < 1 || concurrency > 8) {
				setError(t('invalidConcurrency'))
				return
			}
			if (agents < 1 || agents > 12) {
				setError(t('invalidWorkerAgents'))
				return
			}
			if (maxAttempts < 1 || maxAttempts > 10) {
				setError(t('invalidMaxAttempts'))
				return
			}
			const targetValue = defaultTarget.current === null || defaultTarget.current === undefined ? '' : String(defaultTarget.current.value === undefined || defaultTarget.current.value === null ? '' : defaultTarget.current.value).trim()
			const spawnOn = allowSpawn.current === null || allowSpawn.current === undefined ? dispatch.allowSpawn !== false : allowSpawn.current.checked === true
			// T-167: both capacity knobs are always sent, even when the user only
			// touched concurrency. The Host must never re-derive the worker ceiling
			// from concurrency and silently overwrite the stored value.
			void store.send('settings', {
				maxConcurrent: concurrency,
				maxWorkAgents: agents,
				maxAttempts: maxAttempts,
				allowSpawn: spawnOn,
				defaultTarget: targetValue,
			}).then(function (result) {
				if (result.ok === true) props.onClose()
				else setError(t('error'))
			})
		}

		const capacityRows = [
			h('p', { key: 'cap', className: 'gbt-settingsnote' }, fill(t('settingsCapacityLine'), { cap: workerCap, total: teamRequired })),
			h(
				'p',
				{ key: 'live', className: 'gbt-settingsnote', 'data-capacity-live': liveWorkers === null ? '' : String(liveWorkers), 'data-capacity-missing': missingWorkers === null ? '' : String(missingWorkers) },
				liveWorkers === null || missingWorkers === null
					? t('settingsCapacityUnknown')
					: fill(t('settingsCapacityLive'), { live: liveWorkers, missing: missingWorkers }),
			),
		]
		// T-166 error codes are the capacity vocabulary; surface the ones the last
		// tick actually reported instead of only a generic "pool is short" line.
		if (skippedCodes.has('spawn-failed')) {
			capacityRows.push(h('p', { key: 'spawn', className: 'gbt-settingswarning', 'data-settings-warning': 'spawn-failed' }, t('settingsSpawnFailWarn')))
		}
		if (skippedCodes.has('role-cap')) {
			capacityRows.push(h('p', { key: 'role-cap', className: 'gbt-settingswarning', 'data-settings-warning': 'role-cap' }, t('settingsRoleCapWarn')))
		}
		if (skippedCodes.has('role-full')) {
			capacityRows.push(h('p', { key: 'role-full', className: 'gbt-settingswarning', 'data-settings-warning': 'role-full' }, t('settingsRoleFullWarn')))
		}
		if (skippedCodes.has('no-idle-member')) {
			capacityRows.push(h('p', { key: 'no-idle', className: 'gbt-settingswarning', 'data-settings-warning': 'no-idle-member' }, t('settingsNoIdleWarn')))
		}
		if (missingWorkers !== null && missingWorkers > 0 && skippedCodes.size === 0) {
			capacityRows.push(
				h(
					'p',
					{ key: 'warn', className: 'gbt-settingswarning', 'data-settings-warning': 'worker-capacity' },
					fill(t('settingsCapacityWarn'), { cap: workerCap, live: liveWorkers, missing: missingWorkers }),
				),
			)
		}
		if (workersError !== null) {
			capacityRows.push(h('p', { key: 'no-team', className: 'gbt-settingswarning', 'data-settings-warning': 'workers-unavailable' }, t('settingsWorkersUnavailable')))
		}

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
						h('select', {
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
						h('option', { value: 'console' }, t('settingsThemeConsole'))),
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
							onChange: function (event) {
								const value = Number(event !== null && event !== undefined && event.target !== undefined ? event.target.value : NaN)
								setPreview({ concurrent: Number.isFinite(value) ? Math.floor(value) : currentConcurrent, agents: preview.agents })
							},
						}),
					),
					h('p', { className: 'gbt-settingsnote' }, t('concurrencyHint')),
				),
				h(
					'div',
					{ className: 'gbt-settingsgroup', 'data-settings-group': 'workers' },
					h('div', { className: 'gbt-settingsgrouphead' }, t('settingsWorkerGroup')),
					h(
						'div',
						{ className: 'gbt-field' },
						h('label', null, t('settingsWorkerCap')),
						h('input', {
							className: 'gbt-input',
							type: 'number',
							min: 1,
							max: 12,
							step: 1,
							ref: workerAgents,
							defaultValue: String(currentWorkerAgents),
							'data-field': 'max-work-agents',
							onChange: function (event) {
								const value = Number(event !== null && event !== undefined && event.target !== undefined ? event.target.value : NaN)
								setPreview({ concurrent: preview.concurrent, agents: Number.isFinite(value) ? Math.floor(value) : currentWorkerAgents })
							},
						}),
					),
					h(
						'div',
						{ className: 'gbt-settingsinline' },
						h('button', { type: 'button', className: 'gbt-btn', 'data-action': 'suggest-worker-cap', onClick: useSuggestion }, t('settingsUseSuggested')),
						h('span', { className: 'gbt-settingsnote' }, t('settingsWorkerSuggestionNote')),
					),
					h('p', { className: 'gbt-settingsnote' }, t('settingsWorkerCapHint')),
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
					h(
						'label',
						{ className: 'gbt-settingsinline' },
						h('input', { type: 'checkbox', ref: allowSpawn, defaultChecked: dispatch.allowSpawn !== false, 'data-field': 'allow-spawn' }),
						h('span', null, t('settingsAllowSpawn')),
					),
					h('p', { className: 'gbt-settingsnote' }, t('settingsAllowSpawnHint')),
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
					{
						className: 'gbt-settingscapacity',
						'data-settings-capacity': 'true',
						'data-worker-cap': String(workerCap),
						'data-team-required': String(teamRequired),
						'data-capacity-live': liveWorkers === null ? '' : String(liveWorkers),
						'data-capacity-missing': missingWorkers === null ? '' : String(missingWorkers),
					},
					h('div', { className: 'gbt-settingsgrouphead' }, t('settingsCapacityTitle')),
					capacityRows,
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

	return SettingsForm
}

module.exports = { createSettingsForm }
