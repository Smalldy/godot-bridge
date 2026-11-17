/**
 * Roles view module.
 *
 * Extracted from the roles fragment; React, h, the agent-tree selector and
 * RolesEditor are injected by the build. Stage profiles are project-level: there
 * is no per-session team readiness to aggregate here.
 *
 * A direction: this view owns no header of its own. The editor renders the one
 * page header (stage + profile) and the stage rail; adding a second title card
 * here would put a second navigation/heading layer above it.
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
			return h('div', { className: 'gbt-rolesview', 'data-roles-deck': 'true' },
				h('div', { className: 'gbt-rolesview-empty', 'data-roles-unavailable': 'true' },
					h('p', { className: 'gbt-footnote' }, t('rolesHint')),
					h('div', { className: 'gbt-empty' }, t('rolesUnavailable'))))
		}
		return h('div', { className: 'gbt-rolesview', 'data-roles-deck': 'true' },
			h(RolesEditor, {
				t: t,
				snapshot: snapshot,
				store: store,
				instances: instances,
				bump: bumpEditor,
			}))
	}

	return RolesView
}

module.exports = { createRolesView }
