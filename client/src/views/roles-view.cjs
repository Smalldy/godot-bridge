/**
 * Roles view module.
 *
 * Extracted from the roles fragment; React, h, the agent-tree selector and
 * RolesEditor are injected by the build. Stage profiles are project-level: there
 * is no per-session team readiness to aggregate here.
 */
function createRolesView(deps) {
	const React = deps.React
	const h = deps.h
	const RolesEditor = deps.RolesEditor
	const tcAgentTreeOf = deps.tcAgentTreeOf

	function RolesView(props) {
		const t = props.t
		const snapshot = props.snapshot
		const store = props.store
		const [, bumpEditor] = React.useReducer(function (count) { return count + 1 }, 0)
		const config = snapshot.roles === undefined || snapshot.roles === null ? null : snapshot.roles
		// Live instances are the tree members whose role is one of the three stage
		// profiles. A member with no stage role (the root, a custom kind) is not a
		// role instance and is not counted here.
		const tree = tcAgentTreeOf(snapshot)
		const instances = tree.members
			.filter(function (member) {
				return member !== null && typeof member === 'object' && ['worker', 'reviewer', 'tester'].indexOf(member.role) >= 0
			})
			.map(function (member) {
				return {
					name: typeof member.name === 'string' && member.name !== '' ? member.name : typeof member.id === 'string' ? member.id : '—',
					kind: member.role,
					status: typeof member.status === 'string' ? member.status : 'unknown',
				}
			})
		if (config === null) {
			return h('div', { className: 'gbt-rolesview', 'data-roles-deck': 'true' }, h('p', { className: 'gbt-footnote' }, t('rolesHint')), h('div', { className: 'gbt-empty' }, t('rolesUnavailable')))
		}
		return h(
			'div',
			{ className: 'gbt-rolesview', 'data-roles-deck': 'true' },
			h(
				'section',
				{ className: 'gbt-rolesview-card', 'data-card': 'editor' },
				h('div', { className: 'gbt-rhead' },
					h('h3', { className: 'gbt-rtitle' }, t('roleEditor')),
					h('div', { className: 'gbt-footnote', 'data-role-scale-note': 'true' }, t('roleScaleNote'))),
				h('div', { className: 'gbt-rbody' }, h(RolesEditor, {
					t: t,
					snapshot: snapshot,
					store: store,
					instances: instances,
					bump: bumpEditor,
				})),
			),
		)
	}

	return RolesView
}

module.exports = { createRolesView }
