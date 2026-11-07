/**
 * Roles view module.
 *
 * Extracted from the roles fragment; React, h and RolesEditor are injected by
 * the build.
 */
function createRolesView(deps) {
	const React = deps.React
	const h = deps.h
	const RolesEditor = deps.RolesEditor

	function RolesView(props) {
		const t = props.t
		const snapshot = props.snapshot
		const store = props.store
		const [, bumpEditor] = React.useReducer(function (count) { return count + 1 }, 0)
		const config = snapshot.roles === undefined || snapshot.roles === null ? null : snapshot.roles
		const agents = snapshot.agents
		// T-122: the session's own team is the member source; the host inventory is separate.
		const teamView = snapshot.team !== null && snapshot.team !== undefined && Array.isArray(snapshot.team.members) ? snapshot.team.members : null
		const members = teamView !== null ? teamView : agents !== null && agents !== undefined && Array.isArray(agents.members) ? agents.members : []
		const instances = members
			.filter(function (member) {
		return member !== null && typeof member === 'object' && typeof member.name === 'string' && /^(worker|reviewer|tester)-\d+$/.test(member.name)
			})
			.map(function (member) {
		const match = /^(worker|reviewer|tester)-\d+$/.exec(member.name)
		return { name: member.name, kind: match === null ? 'worker' : match[1], status: typeof member.status === 'string' ? member.status : 'unknown' }
			})
		if (config === null) {
			return h('div', null, h('p', { className: 'gbt-footnote' }, t('rolesHint')), h('div', { className: 'gbt-empty' }, t('rolesUnavailable')))
		}
		return h(
			'div',
			{ className: 'gbt-rolesview' },
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
