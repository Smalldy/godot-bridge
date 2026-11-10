/**
 * Workers/team view module.
 *
 * Extracted from the views fragment; React, h, selectors, label helpers and
 * clipboard are injected by the build. WORKER_ERROR is local to this view.
 */
function createWorkersView(deps) {
	// T-155: the session filter survives a remount (view switch).
	const workersUi = { sessionFilter: 'all' }

	const React = deps.React
	const h = deps.h
	const tcBaseName = deps.tcBaseName
	const tcSessionShort = deps.tcSessionShort
	const tcLeadText = deps.tcLeadText
	const copyToClipboard = deps.copyToClipboard
	const roleKindLabel = deps.roleKindLabel
	const workerStatusLabel = deps.workerStatusLabel
	const WORKER_ERROR = { 'no-team-service': 'workersErrNoService', 'no-lead': 'workersErrNoLead', 'roster-unreadable': 'workersErrRoster' }

	function WorkersView(props) {
		const t = props.t
		const snapshot = props.snapshot
		const workers = snapshot.workers
		const [copied, setCopied] = React.useState(null)
		const shell = function (child) { return h('div', { className: 'gbt-workersview' }, child) }
		const blocks = []
		const hint = h('p', { key: 'hint', className: 'gbt-footnote', 'data-worker-hint': 'true' }, t('workersHint'))
		if (snapshot.source === 'error') {
			return shell([hint, h('div', { key: 'offline', className: 'gbt-empty' }, t('workersUnavailable'))])
		}
		if (workers === null || workers === undefined) {
			return shell([hint, h('div', { key: 'unavailable', className: 'gbt-empty' }, t('workersUnavailable'))])
		}
		if (typeof workers.error === 'string' && workers.error !== '') {
			const errorKey = WORKER_ERROR[workers.error]
			const explanation = errorKey === undefined ? workers.error : t(errorKey) + ' (' + workers.error + ')'
			blocks.push(h('div', { key: 'error', className: 'gbt-banner', style: { margin: '0 0 12px' } }, h('span', null, t('workersError') + ': ' + explanation)))
		}
		const countText = function (value) { return Number.isFinite(value) ? String(value) : '—' }
		const members = Array.isArray(workers.members) ? workers.members : []
		const lead = typeof workers.lead === 'string' && workers.lead.length > 0 ? workers.lead : null
		const leadSession = lead !== null && /^session-/.test(lead) ? lead : workers.leadInfo !== null && workers.leadInfo !== undefined && typeof workers.leadInfo.session === 'string' ? workers.leadInfo.session : null
		const session = typeof workers.session === 'string' && workers.session !== '' ? workers.session : leadSession
		const teamProject = typeof workers.project === 'string' && workers.project !== '' ? workers.project : null
		const panelProject = typeof snapshot.project === 'string' && snapshot.project !== '' ? snapshot.project : null
		const dispatch = snapshot.dispatch !== null && snapshot.dispatch !== undefined ? snapshot.dispatch : {}
		const concurrent = Number.isFinite(dispatch.maxConcurrent) ? dispatch.maxConcurrent : null
		// 上限 is the hard pool ceiling (maxWorkAgents). workerCap is just a
		// fallback for hosts that predate it, so the head can read
		// "并发 3 · 上限 4" instead of collapsing both chips into the minimum.
		const cap = Number.isFinite(workers.cap) ? workers.cap : Number.isFinite(workers.workerCap) ? workers.workerCap : null
		const shortPath = function (value) { return typeof value === 'string' && value !== '' ? tcBaseName(value) : null }
		const sessionShort = tcSessionShort(session)
		const leadDisplay = tcLeadText(lead, t)
		const leadIsSession = lead !== null && /^session-/.test(lead)
		const copyValue = session === null ? leadSession : session
		const identity = h('div', { key: 'identity', className: 'gbt-workeridentity', 'data-worker-identity': 'true' },
			h('span', { key: 'project', className: 'gbt-workerid' }, h('span', { className: 'gbt-workeridlabel' }, t('workersProjectLabel')), h('b', { title: panelProject === null ? '' : panelProject }, panelProject === null ? '—' : shortPath(panelProject))),
			h('span', { key: 'team', className: 'gbt-workerid', 'data-worker-team-project': teamProject === null ? '' : teamProject }, h('span', { className: 'gbt-workeridlabel' }, t('workersTeamLabel')), h('span', { title: teamProject === null ? '' : teamProject }, teamProject === null ? '—' : '项目 ' + shortPath(teamProject))),
			h('span', { key: 'lead', className: 'gbt-workerid', 'data-worker-lead': lead === null ? '' : lead }, h('span', { className: 'gbt-workeridlabel' }, t('workersLead')), ' ', h('b', { title: leadIsSession ? lead : undefined }, leadDisplay)),
			h('span', { key: 'session', className: 'gbt-workerid', 'data-worker-session': session === null ? '' : session }, h('span', { className: 'gbt-workeridlabel' }, t('workersSessionLabel')), ' ', h('span', { className: 'gbt-mono', title: session === null ? '' : session }, sessionShort === null ? '—' : sessionShort)),
			copyValue === null
		? null
		: h('button', { type: 'button', className: 'gbt-btn', 'data-action': 'copy-session', 'data-session': copyValue, onClick: function () { void copyToClipboard(copyValue).then(function (ok) { setCopied(ok === true ? copyValue : 'failed') }) } }, copied === copyValue ? t('sessionCopied') : t('copySession')),
			copied === 'failed' ? h('span', { key: 'copy-failed', className: 'gbt-footnote' }, ' ' + t('copyFailed')) : null,
		)
		const chips = h('div', { key: 'chips', className: 'gbt-workerchips', 'data-worker-chips': 'true' },
			[	['concurrent', t('workersCapConcurrent'), countText(concurrent)],
		['cap', t('workersCap'), countText(cap)],
		['busy', t('workersBusy'), countText(workers.busy)],
		['idle', t('workersIdle'), countText(workers.idle)],
		['provisioning', t('workersProvisioning'), countText(workers.provisioning)],
		['failed', t('workersFailed'), countText(workers.failed)],
			].map(function (entry) {
		return h('span', { key: entry[0], className: 'gbt-count', 'data-worker-chip': entry[0] }, h('span', { className: 'gbt-workerchip-label' }, entry[1]), h('b', null, entry[2]))
			}))
		const headParts = [
			h('div', { key: 'title', className: 'gbt-workerheadtop' }, h('h3', { className: 'gbt-workertitle' }, t('workersTab'))),
			chips,
			identity,
		]
		if (workers.projectMatch === false && teamProject !== null && panelProject !== null) {
			headParts.push(h('div', { key: 'mismatch', className: 'gbt-banner', 'data-tone': 'warn', 'data-worker-mismatch': 'true', 'data-team-project': teamProject, 'data-panel-project': panelProject }, t('workersMismatch').replace('{team}', shortPath(teamProject)).replace('{panel}', shortPath(panelProject))))
		}
		blocks.push(h('div', { key: 'head', className: 'gbt-workerhead', 'data-worker-head': 'true' }, headParts))
		// T-155 §1/§8: every participating session with ITS OWN team and card count,
		// filterable. No primary session, no "project team".
		const scope = snapshot.scope !== null && snapshot.scope !== undefined && typeof snapshot.scope === 'object' ? snapshot.scope : null
		const sessionRows = scope !== null && Array.isArray(scope.sessionSummaries) ? scope.sessionSummaries.filter(function (row) { return row !== null && typeof row === 'object' }) : []
		const currentSession = scope !== null && typeof scope.panelSession === 'string' && scope.panelSession !== '' ? scope.panelSession : null
		const [sessionFilter, setSessionFilterState] = React.useState(workersUi.sessionFilter)
		const setSessionFilter = function (next) {
			workersUi.sessionFilter = next
			setSessionFilterState(next)
		}
		const sessionShortText = function (value) {
			const text = typeof value === 'string' ? value : ''
			return text.indexOf('session-') === 0 ? text.slice(8, 16) : text.slice(0, 8)
		}
		const sessionStatus = function (status) {
			return status === 'live' ? t('sessionsStatusLive') : status === 'stale' ? t('sessionsStatusStale') : t('sessionsStatusUnknown')
		}
		if (sessionRows.length > 0) {
			const visibleSessions = sessionFilter === 'all' ? sessionRows : sessionRows.filter(function (row) { return row.sessionId === sessionFilter })
			blocks.push(
				h(
					'div',
					{ key: 'sessions', className: 'gbt-sessionscards', 'data-worker-sessions': 'true' },
					h('div', { className: 'gbt-workerheadtop' }, h('h3', { className: 'gbt-workertitle' }, t('sessionCardTitle')), h('span', { className: 'gbt-footnote' }, t('sessionsHint'))),
					h(
						'label',
						{ className: 'gbt-sessionfilter' },
						t('sessionFilter'),
						h(
							'select',
							{
								'data-session-filter': 'true',
								value: sessionFilter,
								onChange: function (event) {
									setSessionFilter(event !== null && event !== undefined && event.target !== undefined ? String(event.target.value) : 'all')
								},
							},
							h('option', { value: 'all' }, t('sessionFilterAll')),
							sessionRows.map(function (row) { return h('option', { key: 'opt-' + String(row.sessionId), value: String(row.sessionId) }, sessionShortText(row.sessionId)) }),
						),
					),
					visibleSessions.map(function (row, index) {
						const team = row.team !== null && row.team !== undefined && typeof row.team === 'object' ? row.team : null
						const cards = row.cards !== null && row.cards !== undefined && typeof row.cards === 'object' ? row.cards : {}
						const stage = row.stageReady !== null && row.stageReady !== undefined && typeof row.stageReady === 'object' ? row.stageReady : {}
						return h(
							'div',
							{
								key: 'session-' + String(index),
								className: 'gbt-sessionsrow',
								'data-session': String(row.sessionId),
								'data-current': currentSession !== null && row.sessionId === currentSession ? 'true' : 'false',
								'data-dispatch-ready': row.dispatchReady === true ? 'true' : 'false',
							},
							h('span', { className: 'gbt-mono' }, sessionShortText(row.sessionId)),
							currentSession !== null && row.sessionId === currentSession ? h('span', { className: 'gbt-sessionnow' }, t('sessionsCurrent')) : null,
							team === null ? null : h('span', null, t('workersLead') + ' ' + (typeof team.lead === 'string' ? team.lead : '—')),
							h('span', { className: 'gbt-statusmeta' }, t('sessionsCards').replace('{n}', String(Number.isFinite(cards.owned) ? cards.owned : 0)) + ' · ' + t('sessionsActive').replace('{n}', String(Number.isFinite(cards.active) ? cards.active : 0))),
							h('span', { className: 'gbt-pill', 'data-session-status-pill': typeof row.status === 'string' ? row.status : 'unknown' }, sessionStatus(row.status)),
							h('span', { className: 'gbt-pill', 'data-dispatch-badge': row.dispatchReady === true ? 'true' : 'false' }, t('sessionsReadiness') + ' ' + (row.dispatchReady === true ? t('sessionsReady') : t('sessionsNotReady'))),
							h('span', { className: 'gbt-pill', 'data-stage-ready': stage.review === true ? 'true' : 'false' }, t('sessionsStageReview') + ' ' + (stage.review === true ? t('sessionsReady') : t('sessionsNotReady'))),
							h('span', { className: 'gbt-pill', 'data-stage-ready': stage.test === true ? 'true' : 'false' }, t('sessionsStageTest') + ' ' + (stage.test === true ? t('sessionsReady') : t('sessionsNotReady'))),
						)
					}),
				),
			)
		}
		// Role overview: three (or four on a merge team) compact cards with LIVE numbers only.
		const roleCounts = workers.roleCounts !== null && workers.roleCounts !== undefined && typeof workers.roleCounts === 'object' ? workers.roleCounts : null
		const kindOrder = ['worker', 'reviewer', 'tester', 'merger']
		const kindOfMember = function (member) { return typeof member.kind === 'string' && member.kind !== '' ? member.kind : 'worker' }
		const membersOf = function (kind) { return members.filter(function (member) { return kindOfMember(member) === kind }) }
		const queueOf = function (kind) { return membersOf(kind).reduce(function (sum, member) { return sum + (Number.isFinite(member.queue) ? member.queue : 0) }, 0) }
		const fallbackCounts = function (kind) {
			const own = membersOf(kind)
			const busy = own.filter(function (member) { return member.currentTask !== null && member.currentTask !== undefined }).length
			const failed = own.filter(function (member) { return member.status === 'failed' }).length
			const provisioning = own.filter(function (member) { return member.status === 'provisioning' }).length
			const running = own.filter(function (member) { return member.status === 'running' }).length
			return { running: running, idle: Math.max(0, own.length - busy - failed - provisioning), busy: busy }
		}
		const cardKinds = kindOrder.filter(function (kind) {
			return kind === 'worker' || kind === 'reviewer' || kind === 'tester' || membersOf(kind).length > 0 || (roleCounts !== null && roleCounts[kind] !== undefined)
		})
		if (cardKinds.length > 0) {
			blocks.push(h('div', { key: 'roles', className: 'gbt-rolecards', 'data-worker-roles': 'true' },
		cardKinds.map(function (kind) {
			const counts = roleCounts !== null && roleCounts[kind] !== undefined ? roleCounts[kind] : fallbackCounts(kind)
			const bound = workers.roles !== null && workers.roles !== undefined && workers.roles.bound !== null && workers.roles.bound !== undefined && typeof workers.roles.bound[kind] === 'string' ? workers.roles.bound[kind] : null
			return h('div', { key: 'role-card-' + kind, className: 'gbt-workercard', 'data-role-card': kind },
				h('div', { className: 'gbt-workercardhead' },
			h('span', { className: 'gbt-workercardname' }, roleKindLabel(kind, t)),
			h('span', { className: 'gbt-pill', 'data-role-badge': kind, title: bound === null ? t('roleUseDefault') : bound }, bound === null ? t('roleUseDefault') : bound)),
				h('div', { className: 'gbt-workercardline' },
			h('span', { 'data-role-metric': 'running' }, t('workersRoleRunning') + ' ' + String(counts.running || 0)),
			h('span', { 'data-role-metric': 'idle' }, t('workersRoleIdle') + ' ' + String(counts.idle || 0)),
			h('span', { 'data-role-metric': 'busy' }, t('workersRoleWithCard') + ' ' + String(counts.busy || 0)),
			h('span', { 'data-role-metric': 'queue' }, t('workersRoleQueue') + ' ' + String(queueOf(kind)))))
		})))
		}
		if (lead === null) blocks.push(h('div', { key: 'noteam', className: 'gbt-empty' }, t('workersNoTeam')))
		if (members.length === 0) {
			blocks.push(h('div', { key: 'empty', className: 'gbt-empty' }, t('workersEmpty')))
			return shell(blocks)
		}
		const rankOf = function (kind) { const rank = kindOrder.indexOf(kind); return rank === -1 ? kindOrder.length : rank }
		const sorted = members.slice().sort(function (left, right) {
			const leftKind = kindOfMember(left)
			const rightKind = kindOfMember(right)
			if (rankOf(leftKind) !== rankOf(rightKind)) return rankOf(leftKind) - rankOf(rightKind)
			const leftName = typeof left.name === 'string' ? left.name : ''
			const rightName = typeof right.name === 'string' ? right.name : ''
			return leftName < rightName ? -1 : leftName > rightName ? 1 : 0
		})
		const rows = sorted.map(function (member, index) {
			const kind = kindOfMember(member)
			const name = typeof member.name === 'string' && member.name !== '' ? member.name : typeof member.id === 'string' && member.id !== '' ? member.id : '—'
			const status = typeof member.status === 'string' ? member.status : null
			const current = member.currentTask !== null && member.currentTask !== undefined ? member.currentTask : null
			let task = '—'
			if (current !== null && typeof current.id === 'string' && current.id !== '') {
		task = typeof current.title === 'string' && current.title !== '' ? current.id + ' · ' + current.title : current.id
			} else if (status === 'idle' || status === 'inactive') {
		task = t('workerRoleIdle')
			}
			const queue = Number.isFinite(member.queue) ? member.queue : 0
			return h('tr', { key: member.id === undefined || member.id === null ? String(index) : String(member.id), 'data-worker': name, 'data-status': status === null ? '' : status, 'data-kind': kind, 'data-col-row': 'member' },
		h('td', { 'data-col': 'worker-kind' }, h('span', { className: 'gbt-pill', 'data-role-badge': kind }, roleKindLabel(kind, t))),
		h('td', { className: 'gbt-mono', 'data-col': 'worker-name' }, h('span', { className: 'gbt-workername', title: name }, name)),
		h('td', { 'data-col': 'worker-status' }, h('span', { className: 'gbt-pill', 'data-status': status === null ? '' : status }, status === null ? '—' : workerStatusLabel(status, t))),
		h('td', { 'data-col': 'worker-task', title: current === null ? undefined : typeof current.title === 'string' && current.title !== '' ? current.id + ' · ' + current.title : String(current.id) }, h('span', { className: 'gbt-workertask' }, task)),
		h('td', { className: 'gbt-mono', 'data-col': 'worker-queue' }, queue > 0 ? String(queue) : '—'))
		})
		blocks.push(h('div', { key: 'tablewrap', className: 'gbt-tablewrap' },
			h('table', { className: 'gbt-locktable gbt-workertable', 'data-worker-table': 'true' },
		h('thead', null, h('tr', null, h('th', null, t('workerRole')), h('th', null, t('workerMember')), h('th', null, t('workerStatus')), h('th', null, t('workerCurrent')), h('th', null, t('workersRoleQueue')))),
		h('tbody', null, rows))))
		return shell(blocks)
	}



	return WorkersView
}

module.exports = { createWorkersView }