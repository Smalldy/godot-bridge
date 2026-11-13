/**
 * Settings form view module.
 *
 * Extracted from the forms fragment; React, h, Modal and the panel store are
 * injected by the build.
 *
 * Dispatch has ONE capacity knob: maxConcurrent. A card's executor is started
 * for the card and released afterwards; there is no persistent worker ceiling.
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
		const concurrent = React.useRef(null)
		const attempts = React.useRef(null)
		const defaultTarget = React.useRef(null)
		const [error, setError] = React.useState('')
		const currentConcurrent = Number.isFinite(dispatch.maxConcurrent) ? Math.max(1, Math.floor(dispatch.maxConcurrent)) : 3
		const currentAttempts = Number.isFinite(dispatch.maxAttempts) ? Math.max(1, Math.floor(dispatch.maxAttempts)) : 3

		function numberFrom(ref, fallback) {
			if (ref !== null && ref !== undefined && ref.current !== null && ref.current !== undefined && ref.current.value !== undefined) {
				const value = Number(ref.current.value)
				if (Number.isFinite(value)) return Math.floor(value)
			}
			return fallback
		}

		function save() {
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
			const targetValue = defaultTarget.current === null || defaultTarget.current === undefined ? '' : String(defaultTarget.current.value === undefined || defaultTarget.current.value === null ? '' : defaultTarget.current.value).trim()
			void store.send('settings', {
				maxConcurrent: concurrency,
				maxAttempts: maxAttempts,
				defaultTarget: targetValue,
			}).then(function (result) {
				if (result.ok === true) props.onClose()
				else setError(t('error'))
			})
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
