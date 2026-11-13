/**
 * Agents view module.
 *
 * The live execution tree: the root Agent of this session plus every live child
 * the Host reports in snapshot.agentTree. There is no team roster, no worker
 * pool and no "Lead + members" framing; a Host that reports no tree renders a
 * neutral unavailable state instead of an invented membership.
 */
function createWorkersView(deps) {
	const React = deps.React
	const h = deps.h
	const tcBaseName = deps.tcBaseName
	const tcAgentTreeOf = deps.tcAgentTreeOf
	const AgentRow = deps.AgentRow
	const copyToClipboard = deps.copyToClipboard

	function WorkersView(props) {
		const t = props.t
		const snapshot = props.snapshot
		const [copied, setCopied] = React.useState(null)
		const tree = tcAgentTreeOf(snapshot)
		const shell = function (child) { return h('div', { className: 'gbt-workersview', 'data-agent-tree-view': 'true' }, child) }
		const hint = h('p', { key: 'hint', className: 'gbt-footnote', 'data-agent-hint': 'true' }, t('agentsHint'))
		if (snapshot.source === 'error' || snapshot.agentTree === null || snapshot.agentTree === undefined || tree.available !== true) {
			return shell([
				hint,
				h('div', { key: 'unavailable', className: 'gbt-empty', 'data-agent-unavailable': 'true' }, t('agentsUnavailable')),
				tree.error === null ? null : h('p', { key: 'error', className: 'gbt-footnote', 'data-agent-error': tree.error }, tree.error),
			])
		}
		const root = tree.root
		const rootName = root !== null && typeof root.name === 'string' && root.name !== '' ? root.name : root !== null && typeof root.id === 'string' && root.id !== '' ? root.id : null
		const rootSession = root !== null && typeof root.id === 'string' && root.id !== '' ? root.id : null
		const project = typeof snapshot.project === 'string' && snapshot.project !== '' ? snapshot.project : null
		const identity = h(
			'div',
			{ key: 'identity', className: 'gbt-workeridentity', 'data-agent-identity': 'true' },
			h('span', { key: 'project', className: 'gbt-workerid', 'data-agent-project': project === null ? '' : project },
				h('span', { className: 'gbt-workeridlabel' }, t('agentsProject')),
				h('b', { title: project === null ? '' : project }, project === null ? '—' : tcBaseName(project))),
			h('span', { key: 'root', className: 'gbt-workerid', 'data-agent-root': rootSession === null ? '' : rootSession },
				h('span', { className: 'gbt-workeridlabel' }, t('agentsRoot')), ' ',
				h('b', { className: 'gbt-mono', title: rootSession === null ? '' : rootSession }, rootName === null ? '—' : rootName)),
			h('span', { key: 'live', className: 'gbt-workerid', 'data-agent-live': String(tree.members.length) },
				h('span', { className: 'gbt-workeridlabel' }, t('agentsLive')), ' ',
				h('b', null, String(tree.members.length))),
			rootSession === null
				? null
				: h('button', { key: 'copy', type: 'button', className: 'gbt-btn', 'data-action': 'copy-session', 'data-session': rootSession, onClick: function () { void copyToClipboard(rootSession).then(function (ok) { setCopied(ok === true ? rootSession : 'failed') }) } }, copied === rootSession ? t('sessionCopied') : t('copySession')),
			copied === 'failed' ? h('span', { key: 'copy-failed', className: 'gbt-footnote' }, ' ' + t('copyFailed')) : null,
		)
		const head = h(
			'div',
			{ key: 'head', className: 'gbt-workerhead', 'data-agent-head': 'true' },
			h('div', { key: 'title', className: 'gbt-workerheadtop' }, h('h3', { className: 'gbt-workertitle' }, t('agentsTitle'))),
			identity,
		)
		const blocks = [hint, head]
		if (root === null) {
			blocks.push(h('div', { key: 'noroot', className: 'gbt-empty', 'data-agent-empty': 'noroot' }, t('agentsNoRoot')))
			return shell(blocks)
		}
		const rows = [h(AgentRow, { key: 'agent-root', member: root, isRoot: true, t: t })].concat(
			tree.members.map(function (member, index) {
				return h(AgentRow, { key: 'agent-' + (typeof member.id === 'string' && member.id !== '' ? member.id : String(index)), member: member, isRoot: false, t: t })
			}),
		)
		blocks.push(
			h('div', { key: 'tablewrap', className: 'gbt-tablewrap' },
				h('table', { className: 'gbt-locktable gbt-workertable', 'data-agent-table': 'true' },
					h('thead', null, h('tr', null, h('th', null, t('agentRole')), h('th', null, t('agentName')), h('th', null, t('agentStatus')), h('th', null, t('agentTask')))),
					h('tbody', null, rows))),
		)
		if (tree.members.length === 0) blocks.push(h('div', { key: 'empty', className: 'gbt-empty', 'data-agent-empty': 'no-children' }, t('agentsNoChildren')))
		return shell(blocks)
	}

	return WorkersView
}

module.exports = { createWorkersView }
