/**
 * Roles view module.
 *
 * Extracted from the roles fragment; React, h and RolesEditor are injected by
 * the build.
 */
function createRolesView(deps) {
	// T-155: the session filter survives a remount (view switch).
	const rolesUi = { sessionFilter: 'all' }

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
		// T-172: project-scoped instance names look like worker-pb58f7-1,
		// not only worker-1; stage live counts must see both.
		return member !== null && typeof member === 'object' && typeof member.name === 'string' && /^(worker|reviewer|tester)(?:-[a-z0-9]+)*?-\d+$/.test(member.name)
			})
			.map(function (member) {
		const match = /^(worker|reviewer|tester)(?:-[a-z0-9]+)*?-\d+$/.exec(member.name)
		return { name: member.name, kind: match === null ? 'worker' : match[1], status: typeof member.status === 'string' ? member.status : 'unknown' }
			})
		// T-155 §1/§8: sessions are aggregated per participant, with their OWN team
		// readiness. The current chat session is highlighted, never primary.
		const scope = snapshot.scope !== null && snapshot.scope !== undefined && typeof snapshot.scope === 'object' ? snapshot.scope : null
		const sessionRows = scope !== null && Array.isArray(scope.sessionSummaries) ? scope.sessionSummaries.filter(function (row) { return row !== null && typeof row === 'object' }) : []
		const currentSession = scope !== null && typeof scope.panelSession === 'string' && scope.panelSession !== '' ? scope.panelSession : null
		// Rendering tests may inject a minimal React without hooks; the module state
		// still carries the filter, so a no-op setter is a safe fallback.
		const useState = typeof React.useState === 'function' ? React.useState : function (initial) { return [initial, function () {}] }
		const [sessionFilter, setSessionFilterState] = useState(rolesUi.sessionFilter)
		const setSessionFilter = function (next) {
			rolesUi.sessionFilter = next
			setSessionFilterState(next)
		}
		const sessionShortText = function (value) {
			const text = typeof value === 'string' ? value : ''
			return text.indexOf('session-') === 0 ? text.slice(8, 16) : text.slice(0, 8)
		}
		const sessionStatusText = function (status) {
			return status === 'live' ? t('sessionsStatusLive') : status === 'stale' ? t('sessionsStatusStale') : t('sessionsStatusUnknown')
		}
		const stageLabel = function (ready) {
			return ready === true ? t('sessionsReady') : t('sessionsNotReady')
		}
		const sessionsSection = sessionRows.length === 0
			? null
			: (function () {
				const visibleSessions = sessionFilter === 'all' ? sessionRows : sessionRows.filter(function (row) { return row.sessionId === sessionFilter })
				return h(
					'section',
					{ className: 'gbt-rolesready', 'data-roles-sessions': 'true' },
					h('div', { className: 'gbt-rolesreadyhead' },
						h('span', { className: 'gbt-deckeyebrow' }, 'READY / 参与会话'),
						h('h3', null, t('sessionCardTitle')),
						h('span', { className: 'gbt-rolesreadymeta' }, String(sessionRows.length) + ' ' + t('sessionsLabel')),
						h('label', { className: 'gbt-sessionfilter' }, t('sessionFilter'),
							h('select', { 'data-session-filter': 'true', value: sessionFilter, onChange: function (event) { setSessionFilter(event !== null && event !== undefined && event.target !== undefined ? String(event.target.value) : 'all') } },
								h('option', { value: 'all' }, t('sessionFilterAll')),
								sessionRows.map(function (row) { return h('option', { key: 'opt-' + String(row.sessionId), value: String(row.sessionId) }, sessionShortText(row.sessionId)) })))),
					h('div', { className: 'gbt-rolesreadyrows', 'data-sessions-list': 'true' }, visibleSessions.map(function (row, index) {
						const team = row.team !== null && row.team !== undefined && typeof row.team === 'object' ? row.team : null
						const stage = row.stageReady !== null && row.stageReady !== undefined && typeof row.stageReady === 'object' ? row.stageReady : {}
						const cards = row.cards !== null && row.cards !== undefined && typeof row.cards === 'object' ? row.cards : {}
						const current = currentSession !== null && row.sessionId === currentSession
						return h('div', {
							key: 'session-' + String(index), className: 'gbt-rolesreadyrow',
							'data-session': String(row.sessionId), 'data-current': current ? 'true' : 'false', 'data-dispatch-ready': row.dispatchReady === true ? 'true' : 'false',
							'data-session-status': typeof row.status === 'string' ? row.status : 'unknown',
						},
							h('span', { className: 'gbt-rolesreadyid gbt-mono' }, sessionShortText(row.sessionId)),
							current ? h('span', { className: 'gbt-sessionnow' }, t('sessionsCurrent')) : null,
							h('span', { className: 'gbt-rolesreadystatus' }, h('i', { className: 'gbt-deckdot', 'data-on': row.status === 'live' ? 'true' : 'false' }), sessionStatusText(row.status)),
							h('span', { className: 'gbt-rolesreadylead', title: team === null ? '' : String(team.lead) }, team === null ? '—' : team.lead),
							h('span', { className: 'gbt-rolesreadyready', 'data-dispatch-badge': row.dispatchReady === true ? 'true' : 'false' }, h('i', { className: 'gbt-deckdot', 'data-on': row.dispatchReady === true ? 'true' : 'false' }), t('sessionsReadiness') + ' ' + (row.dispatchReady === true ? t('sessionsReady') : t('sessionsNotReady'))),
							h('span', { className: 'gbt-footnote', 'data-stage-ready': stage.review === true ? 'true' : 'false' }, t('sessionsStageReview') + ' ' + stageLabel(stage.review === true)),
							h('span', { className: 'gbt-footnote', 'data-stage-ready': stage.test === true ? 'true' : 'false' }, t('sessionsStageTest') + ' ' + stageLabel(stage.test === true)),
							h('span', { className: 'gbt-rolesreadycards gbt-mono' }, String(Number.isFinite(cards.owned) ? cards.owned : 0)))
					}))
				)
			})()
		if (config === null) {
			// T-155: even without a role config the per-session readiness list is useful.
			return h('div', { className: 'gbt-rolesview', 'data-roles-deck': 'true' }, sessionsSection, h('p', { className: 'gbt-footnote' }, t('rolesHint')), h('div', { className: 'gbt-empty' }, t('rolesUnavailable')))
		}
		return h(
			'div',
			{ className: 'gbt-rolesview', 'data-roles-deck': 'true' },
			sessionsSection,
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
