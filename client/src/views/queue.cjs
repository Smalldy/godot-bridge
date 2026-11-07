/**
 * Queue view module.
 *
 * Extracted from the views fragment; h is injected by the build.
 */
function createQueueViews(deps) {
	const h = deps.h

	function QueueRow(props) {
		const task = props.task
		const deps = Array.isArray(task.dependsOn) ? task.dependsOn : []
		const files = Array.isArray(task.writeFiles) ? task.writeFiles : null
		const fileCount = files !== null ? files.length : Number.isFinite(task.writeFileCount) ? task.writeFileCount : 0
		return h(
			'div',
			{ className: 'gbt-row', role: 'button', tabIndex: 0, onClick: function () { props.onOpen(task.id) } },
			h('span', { className: 'gbt-order' }, props.index === undefined ? '·' : String(props.index + 1)),
			h('span', { className: 'gbt-id' }, task.id),
			h(
		'div',
		null,
		h('div', { className: 'gbt-rowtitle' }, task.title),
		h(
			'div',
			{ className: 'gbt-cardmeta' },
			task.priority !== 0 ? h('span', { className: 'gbt-chip' }, 'P' + String(task.priority)) : null,
			deps.length > 0
				? h('span', { className: 'gbt-chip', 'data-tone': 'waiting' }, '↳ ' + deps.join(', '))
				: h('span', { className: 'gbt-chip', 'data-tone': 'ready' }, props.t('noDeps')),
			fileCount > 0 ? h('span', { className: 'gbt-chip' }, '🔒 ' + (files === null ? String(fileCount) : files.join(', '))) : null,
		),
			),
			h(
		'div',
		{ className: 'gbt-rowmeta' },
		props.stateLabel === undefined ? null : h('span', { className: 'gbt-chip', 'data-tone': props.tone }, props.stateLabel),
			),
		)
	}

	function QueueView(props) {
		const queue = props.snapshot.queue.slice()
		const waiting = props.snapshot.tasks.filter(function (task) {
			return task.status === 'pending' && (task.dependency === undefined || task.dependency.state !== 'ready')
		})
		const blocks = []
		blocks.push(h('p', { key: 'hint', className: 'gbt-footnote' }, props.t('queueHint')))
		blocks.push(h('div', { key: 'title', className: 'gbt-section' }, h('h3', null, props.t('queue') + ' · ' + String(queue.length))))
		blocks.push(
			queue.length === 0
		? h('div', { key: 'empty', className: 'gbt-empty' }, props.t('emptyQueue'))
		: h(
				'div',
				{ key: 'rows', className: 'gbt-rowlist' },
				queue.map(function (task, index) {
			return h(QueueRow, { key: task.id, task: task, index: index, t: props.t, onOpen: props.onOpen })
				}),
			),
		)
		if (waiting.length > 0) {
			blocks.push(h('div', { key: 'waiting-title', className: 'gbt-section', style: { marginTop: '18px' } }, h('h3', null, props.t('waiting') + ' · ' + String(waiting.length))))
			blocks.push(
		h(
			'div',
			{ key: 'waiting', className: 'gbt-rowlist' },
			waiting.map(function (task) {
				const broken = task.dependency !== undefined && task.dependency.state === 'broken'
				return h(QueueRow, {
			key: task.id,
			task: task,
			t: props.t,
			tone: broken ? 'broken' : 'waiting',
			stateLabel: broken
				? props.t('brokenOn') + ' ' + (task.dependency !== undefined && Array.isArray(task.dependency.brokenOn) ? task.dependency.brokenOn.join(', ') : '')
				: props.t('waitingOn') + ' ' + (task.dependency !== undefined && Array.isArray(task.dependency.waitingOn) ? task.dependency.waitingOn.join(', ') : ''),
			onOpen: props.onOpen,
				})
			}),
		),
			)
		}
		return h('div', null, blocks)
	}


	return { QueueRow: QueueRow, QueueView: QueueView }
}

module.exports = { createQueueViews }
