/**
 * Agent row module.
 *
 * One member of the live execution tree: role, agent, status and the task it is
 * running. The root Agent is the same shape with isRoot set; there is no team
 * roster and no worker-pool slot behind this row.
 */
function createAgentRow(deps) {
	const h = deps.h
	const roleKindLabel = deps.roleKindLabel
	const tcAgentStatusKey = deps.tcAgentStatusKey

	function AgentRow(props) {
		const t = props.t
		const member = props.member === null || props.member === undefined ? {} : props.member
		const isRoot = props.isRoot === true
		const name = typeof member.name === 'string' && member.name !== '' ? member.name : typeof member.id === 'string' && member.id !== '' ? member.id : '—'
		const role = typeof member.role === 'string' && member.role !== '' ? member.role : null
		const status = typeof member.status === 'string' && member.status !== '' ? member.status : null
		const taskId = typeof member.taskId === 'string' && member.taskId !== '' ? member.taskId : null
		const roleText = isRoot ? t('agentRootRole') : role === null ? '—' : roleKindLabel(role, t)
		return h(
			'tr',
			{
				'data-agent': name,
				'data-agent-id': typeof member.id === 'string' ? member.id : '',
				'data-agent-role': isRoot ? 'root' : role === null ? '' : role,
				'data-agent-status': status === null ? '' : status,
				'data-agent-task': taskId === null ? '' : taskId,
				'data-agent-root': isRoot ? 'true' : undefined,
			},
			h('td', { 'data-col': 'agent-role' }, h('span', { className: 'gbt-pill', 'data-role-badge': isRoot ? 'root' : role === null ? '' : role }, roleText)),
			h('td', { className: 'gbt-mono', 'data-col': 'agent-name' }, h('span', { className: 'gbt-workername', title: name }, name)),
			h('td', { 'data-col': 'agent-status' }, status === null ? '—' : h('span', { className: 'gbt-pill', 'data-status': status }, t(tcAgentStatusKey(status)))),
			h('td', { className: 'gbt-mono', 'data-col': 'agent-task', title: taskId === null ? '' : taskId }, taskId === null ? '—' : taskId),
		)
	}

	return AgentRow
}

module.exports = { createAgentRow }
