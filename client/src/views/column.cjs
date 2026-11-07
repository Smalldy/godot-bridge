/**
 * Column view module.
 *
 * Extracted from the views fragment; h and TaskCard are injected by the build.
 */
function createColumn(deps) {
	const h = deps.h
	const TaskCard = deps.TaskCard

	function Column(props) {
		const t = props.t
		const group = props.group
		const collapsed = props.collapsed === true
		const count = typeof props.count === 'number' ? props.count : group.tasks.length
		const visible = props.visibleTasks !== undefined ? props.visibleTasks : group.tasks
		const showBody = collapsed !== true || props.previewWhenCollapsed === true
		return h(
			'section',
			{ className: 'gbt-col', 'data-group': group.key, 'data-collapsed': collapsed ? 'true' : 'false' },
			h(
		'div',
		{
			className: 'gbt-colhead',
			role: 'button',
			tabIndex: 0,
			'data-collapsible': 'true',
			title: collapsed ? t('expandColumn') : t('collapseColumn'),
			onClick: props.onToggle,
		},
		h('span', { className: 'gbt-colchev', 'aria-hidden': 'true' }, collapsed ? '▸' : '▾'),
		h('span', null, group.key === 'done' ? group.label + ' · ' : group.label),
		h('span', { className: 'gbt-colcount' }, String(count)),
		props.note === undefined || props.note === null ? null : h('span', { className: 'gbt-colnote', 'data-col-note': 'investigating' }, props.note),
			),
			showBody === false
		? null
		: h(
				'div',
				{ className: 'gbt-cards' },
				visible.length === 0
			? h('div', { className: 'gbt-empty' }, t('noTasks'))
			: visible.map(function (task) {
					return h(TaskCard, {
				key: task.id,
				task: task,
				allTasks: props.allTasks,
				t: t,
				now: props.now,
				selected: props.selectedId === task.id,
				onOpen: props.onOpen,
				onVerdict: props.onVerdict,
					})
				}),
			),
			props.footer === undefined || props.footer === null ? null : h('div', { className: 'gbt-colfoot' }, props.footer),
		)
	}


	return Column
}

module.exports = { createColumn }
