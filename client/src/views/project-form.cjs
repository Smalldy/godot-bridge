/**
 * Project form view module.
 *
 * Extracted from the forms fragment; React, h, Modal, the project draft state,
 * the panel store and tcErrorMessage are injected by the build.
 */
function createProjectForm(deps) {
	const React = deps.React
	const h = deps.h
	const Modal = deps.Modal
	const projectFormState = deps.projectFormState
	const store = deps.store
	const tcErrorMessage = deps.tcErrorMessage

	function ProjectForm(props) {
		const t = props.t
		const input = React.useRef(null)
		const [error, setError] = React.useState('')
		// The project the Host resolves right now (the session project when this
		// browser has not pinned one). It is what "use current project" fills in,
		// so returning to this project never needs a hand-typed path (T-90).
		const hostProject = typeof props.hostProject === 'string' && props.hostProject !== '' ? props.hostProject : null
		const draft = projectFormState.value !== null ? projectFormState.value : typeof props.project === 'string' ? props.project : hostProject === null ? '' : hostProject
		function useCurrent() {
			if (hostProject === null) return
			projectFormState.value = hostProject
			setError('')
			if (input.current !== null && input.current !== undefined) input.current.value = hostProject
		}
		function open() {
			const typed = input.current === null || input.current === undefined ? null : String(input.current.value || '').trim()
			// Nothing typed: the prefilled draft (Host project or the pinned one) is
			// the value — "open project" on the dialog's own suggestion is valid.
			const value = typed !== null && typed !== '' ? typed : typeof draft === 'string' ? draft.trim() : ''
			if (value === '') {
		setError(t('projectRequired'))
		return
			}
			// Write = bind: the pin and the Host's openProject move together.
			void store.switchProject(value).then(function (result) {
		if (result.ok === true) {
			projectFormState.value = null
			props.onClose()
			return
		}
		const payload = result.payload === undefined || result.payload === null ? {} : result.payload
		setError(tcErrorMessage(payload, t))
			})
		}
		return h(
			Modal,
			{ title: t('project'), onClose: props.onClose, t: t },
			h(
		'div',
		{ className: 'gbt-form' },
		h('div', { className: 'gbt-field' }, h('label', null, t('project')), h('input', { className: 'gbt-input', ref: input, placeholder: t('projectPlaceholder'), defaultValue: draft, 'data-project-input': 'true' })),
		hostProject === null ? null : h('p', { className: 'gbt-footnote', 'data-host-project': hostProject }, t('useCurrentProjectHint') + ' · ' + hostProject),
		error === '' ? null : h('p', { className: 'gbt-footnote' }, error),
		h('div', { className: 'gbt-actions' },
			h('button', { type: 'button', className: 'gbt-btn', 'data-action': 'use-current-project', title: t('useCurrentProjectHint'), disabled: hostProject === null, onClick: useCurrent }, '⌖ ' + t('useCurrentProject')),
			h('button', { type: 'button', className: 'gbt-btn', 'data-variant': 'primary', onClick: open }, t('openProject')),
			h('button', { type: 'button', className: 'gbt-btn', onClick: props.onClose }, t('cancel'))),
			),
		)
	}

	/**
	 * Where the Host got the project on screen (T-90): 'session' means it came
	 * from the session workspace walk-up, 'manual' from a path this browser or
	 * a caller pinned, 'registry' from the project registry.
	 */

	return ProjectForm
}

module.exports = { createProjectForm }
