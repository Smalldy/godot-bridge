/**
 * Agent row view module.
 *
 * Extracted from the roles fragment; React, h, the kind label and clipboard are
 * injected by the build.
 */
function createAgentRow(deps) {
	const React = deps.React
	const h = deps.h
	const roleKindLabel = deps.roleKindLabel
	const copyToClipboard = deps.copyToClipboard

	function AgentRow(props) {
		const t = props.t
		const member = props.member
		const isLead = props.isLead === true
		const [copied, setCopied] = React.useState(null)
		const name = typeof member.name === 'string' && member.name !== '' ? member.name : typeof member.id === 'string' ? member.id : '—'
		const kind = isLead === true ? 'lead' : typeof member.kind === 'string' ? member.kind : 'teammate'
		const session = typeof member.session === 'string' && member.session !== '' ? member.session : typeof member.id === 'string' && member.id !== '' ? member.id : ''
		const status = typeof member.status === 'string' ? member.status : 'unknown'
		const current = member.currentTask !== null && member.currentTask !== undefined ? member.currentTask : null
		let task = '—'
		if (current !== null && typeof current.id === 'string' && current.id !== '') {
			task = typeof current.title === 'string' && current.title !== '' ? current.id + ' · ' + current.title : current.id
		} else if (status === 'inactive') {
			task = t('workersIdle')
		}
		return h(
			'tr',
			{ 'data-agent': name, 'data-kind': kind, 'data-status': status },
			h('td', { className: 'gbt-mono', 'data-col': 'agent-name' }, isLead ? name + ' · ' + t('statusLead') : name),
			h('td', { 'data-col': 'agent-kind' }, roleKindLabel(kind, t)),
			h('td', { 'data-col': 'agent-description' }, typeof member.description === 'string' && member.description !== '' ? member.description : '—'),
			h(
		'td',
		{ 'data-col': 'agent-session' },
		session === '' ? '—' : h('code', { className: 'gbt-mono' }, session),
		session === ''
			? null
			: h(
			'button',
			{
				type: 'button',
				className: 'gbt-btn',
				style: { marginLeft: '6px' },
				'data-action': 'copy-session',
				'data-session': session,
				onClick: function () {
					void copyToClipboard(session).then(function (ok) {
				setCopied(ok === true ? session : 'failed')
					})
				},
			},
			copied === session ? t('sessionCopied') : t('copySession'),
				),
		copied === 'failed' ? h('span', { className: 'gbt-footnote' }, ' ' + t('copyFailed')) : null,
			),
			h('td', { 'data-col': 'agent-task' }, task),
		)
	}

	/** One stage binding row: current profile plus a bind control. */
	/**
	 * The blank-create form. Fork is the primary path to a new profile; this
	 * stays as the secondary entry for one that is not a copy of anything.
	 * It lives inside the editor card, collapsed.
	 */

	return AgentRow
}

module.exports = { createAgentRow }
