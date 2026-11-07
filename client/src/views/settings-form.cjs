/**
 * Settings form view module.
 *
 * Extracted from the forms fragment; React, h, Modal and the panel store are
 * injected by the build.
 */
function createSettingsForm(deps) {
	const React = deps.React
	const h = deps.h
	const Modal = deps.Modal
	const store = deps.store

	function SettingsForm(props) {
		const t = props.t
		const dispatch = props.dispatch
		const concurrent = React.useRef(null)
		const defaultTarget = React.useRef(null)
		const [error, setError] = React.useState('')
		function save() {
			const raw = concurrent.current === null ? dispatch.maxConcurrent : concurrent.current.value
			const value = Number(raw)
			if (!Number.isFinite(value) || value < 1 || value > 8 || Math.floor(value) !== value) {
		setError(t('invalidConcurrency'))
		return
			}
			const targetValue = defaultTarget.current === null ? '' : String(defaultTarget.current.value || '').trim()
			void store.send('settings', { maxConcurrent: value, defaultTarget: targetValue }).then(function (result) {
		if (result.ok === true) props.onClose()
		else setError(t('error'))
			})
		}
		return h(
			Modal,
			{ title: t('settingsTitle'), onClose: props.onClose, t: t },
			h(
		'div',
		{ className: 'gbt-form' },
		h(
			'div',
			{ className: 'gbt-field' },
			h('label', null, t('maxConcurrent')),
			h('input', { className: 'gbt-input', type: 'number', min: 1, max: 8, step: 1, ref: concurrent, defaultValue: String(dispatch.maxConcurrent) }),
		),
		h(
			'div',
			{ className: 'gbt-field' },
			h('label', null, t('defaultTargetLabel')),
			h('input', { className: 'gbt-input', 'data-field': 'default-target', ref: defaultTarget, defaultValue: typeof dispatch.defaultTarget === 'string' ? dispatch.defaultTarget : '', placeholder: t('defaultTargetHint') }),
		),
		h('p', { className: 'gbt-footnote' }, t('concurrencyHint')),
		error === '' ? null : h('p', { className: 'gbt-footnote', style: { color: 'var(--dsw-alias-state-error-primary)' } }, error),
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
