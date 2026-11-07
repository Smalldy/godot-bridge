/**
 * Role create form view module.
 *
 * Extracted from the roles fragment; React, h, tcSplitList and roleKindLabel
 * are injected by the build.
 */
function createRoleCreateForm(deps) {
	const React = deps.React
	const h = deps.h
	const tcSplitList = deps.tcSplitList
	const roleKindLabel = deps.roleKindLabel

	function RoleCreateForm(props) {
		const t = props.t
		const nameRef = React.useRef(null)
		const roleRef = React.useRef(null)
		const skillsRef = React.useRef(null)
		const contextRef = React.useRef(null)
		const permissionsRef = React.useRef(null)
		const promptRef = React.useRef(null)
		function valueOf(ref, fallback) {
			if (ref.current === null || ref.current === undefined) return fallback
			return typeof ref.current.value === 'string' ? ref.current.value : fallback
		}
		function submit() {
			const name = valueOf(nameRef, '').trim()
			if (name === '') {
		props.onInvalid('invalid-role-name')
		return
			}
			props.onCreate(name, {
		role: valueOf(roleRef, 'reviewer'),
		skills: tcSplitList(valueOf(skillsRef, '')),
		context: valueOf(contextRef, 'fresh'),
		permissions: tcSplitList(valueOf(permissionsRef, 'read-only')),
		prompt: valueOf(promptRef, ''),
			})
		}
		return h(
			'div',
			{ className: 'gbt-formgrid', 'data-form': 'role-create' },
			h('label', null, t('roleName'), h('input', { ref: nameRef, className: 'gbt-input', 'data-field': 'name', defaultValue: '', spellCheck: false })),
			h('label', null, t('roleKind'), h('select', { ref: roleRef, defaultValue: 'reviewer', 'data-field': 'role' }, ['worker', 'reviewer', 'tester'].map(function (kind) { return h('option', { key: kind, value: kind }, roleKindLabel(kind, t)) }))),
			h('label', null, t('roleSkills'), h('input', { ref: skillsRef, className: 'gbt-input', 'data-field': 'skills', defaultValue: '', spellCheck: false })),
			h('label', null, t('roleContext'), h('select', { ref: contextRef, defaultValue: 'fresh', 'data-field': 'context' }, [h('option', { key: 'fresh', value: 'fresh' }, 'fresh'), h('option', { key: 'fork', value: 'fork' }, 'fork')])),
			h('label', null, t('rolePermissions'), h('input', { ref: permissionsRef, className: 'gbt-input', 'data-field': 'permissions', defaultValue: 'read-only', spellCheck: false })),
			h('label', { className: 'gbt-formwide' }, t('rolePrompt'), h('textarea', { ref: promptRef, className: 'gbt-input', 'data-field': 'prompt', defaultValue: '', rows: 3 })),
			h('div', { className: 'gbt-formactions' }, h('button', { type: 'button', className: 'gbt-btn', 'data-variant': 'primary', 'data-action': 'rolesCreate', onClick: submit }, t('roleCreate'))),
		)
	}

	/**
	 * The banner of the user's LAST action. A successful payload this panel
	 * cannot describe (an action it does not own, or an empty answer) renders
	 * NOTHING: claiming "saved" for an unrecognised success would be a lie.
	 */

	return RoleCreateForm
}

module.exports = { createRoleCreateForm }
