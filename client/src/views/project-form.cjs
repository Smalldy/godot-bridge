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
		// Module-backed so a remount keeps the failure visible (the dialog must never
		// look like the click did nothing).
		const [error, setErrorState] = React.useState(projectFormState.error === undefined ? '' : projectFormState.error)
		function setError(next) {
			projectFormState.error = next
			setErrorState(next)
		}
		// T-155 §6: checking a project is a visible state (busy button), and a
		// not-ready answer keeps the dialog open with the missing checks listed and
		// the primary action turned into a re-check.
		const [busy, setBusy] = React.useState(false)
		const [missing, setMissingState] = React.useState(projectFormState.missing === undefined ? [] : projectFormState.missing)
		function setMissing(next) {
			projectFormState.missing = next
			setMissingState(next)
		}
		// The project the Host resolves right now (the session project when this
		// browser has not pinned one). It is what "use current project" fills in,
		// so returning to this project never needs a hand-typed path (T-90).
		const hostProject = typeof props.hostProject === 'string' && props.hostProject !== '' ? props.hostProject : null
		const draft = projectFormState.value !== null ? projectFormState.value : typeof props.project === 'string' ? props.project : hostProject === null ? '' : hostProject
		function useCurrent() {
			if (hostProject === null) return
			projectFormState.value = hostProject
			setError('')
			setMissing([])
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
			setBusy(true)
			setMissing([])
			void store.switchProject(value).then(function (result) {
		setBusy(false)
		if (result.ok === true) {
			projectFormState.value = null
			setError('')
			setMissing([])
			props.onClose()
			return
		}
		const payload = result.payload === undefined || result.payload === null ? {} : result.payload
		setError(tcErrorMessage(payload, t))
		// A not-ready project explains WHY: the preflight's failed checks are the
		// missing items (git repository / board / team...). Keep the dialog open.
		const preflight = payload.preflight !== null && payload.preflight !== undefined && typeof payload.preflight === 'object' ? payload.preflight : null
		const failed = preflight !== null && Array.isArray(preflight.failed) ? preflight.failed : []
		const labels = []
		for (const check of failed) {
			if (check !== null && typeof check === 'object' && typeof check.label === 'string' && check.label !== '') labels.push(check.label)
		}
		setMissing(labels)
			})
		}
		const primaryLabel = busy ? t('projectChecking') : missing.length > 0 ? t('projectCheck') : t('openProject')
		return h(
			Modal,
			{ title: t('project'), onClose: props.onClose, t: t },
			h(
		'div',
		{ className: 'gbt-form' },
		h('div', { className: 'gbt-field' }, h('label', null, t('project')), h('input', { className: 'gbt-input', ref: input, placeholder: t('projectPlaceholder'), defaultValue: draft, 'data-project-input': 'true' })),
		hostProject === null ? null : h('p', { className: 'gbt-footnote', 'data-host-project': hostProject }, t('useCurrentProjectHint') + ' · ' + hostProject),
		missing.length === 0
			? null
			: h('div', { className: 'gbt-banner', 'data-project-missing': 'true', style: { margin: '0 0 8px' } },
				h('strong', null, t('projectMissingTitle')),
				h('ul', { className: 'gbt-footnote', 'data-project-missing-list': 'true' }, missing.map(function (label, index) { return h('li', { key: 'missing-' + String(index) }, String(label)) }))),
		error === '' ? null : h('p', { className: 'gbt-footnote', 'data-project-error': 'true' }, error),
		h('div', { className: 'gbt-actions' },
			h('button', { type: 'button', className: 'gbt-btn', 'data-action': 'use-current-project', title: t('useCurrentProjectHint'), disabled: hostProject === null || busy, onClick: useCurrent }, '⌖ ' + t('useCurrentProject')),
			h('button', { type: 'button', className: 'gbt-btn', 'data-variant': 'primary', 'data-busy': busy ? 'true' : 'false', 'data-project-primary': missing.length > 0 ? 'check' : 'open', disabled: busy, onClick: open }, busy ? h('span', null, h('span', { className: 'gbt-spinner' }), primaryLabel) : primaryLabel),
			h('button', { type: 'button', className: 'gbt-btn', disabled: busy, onClick: props.onClose }, t('cancel'))),
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
