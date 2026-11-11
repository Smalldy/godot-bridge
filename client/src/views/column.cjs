/**
 * Column view module.
 *
 * T-158: a lane head now carries the lane's count AND (for 待派发) the two
 * ready/waiting sub-counts, a done lane can carry an archive summary, and an
 * empty lane marks itself so the board can narrow it instead of stretching it.
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
		// T-159: an empty lane only becomes a narrow rail for 待派发 / 阻塞. The three
		// active lanes and 完成 keep their full share so a wide window is filled.
		const narrowable = group.key === 'dispatch' || group.key === 'blocked'
		const empty = narrowable && visible.length === 0 && (props.summary === undefined || props.summary === null)
		const subcounts = props.subcounts === undefined || props.subcounts === null ? null : props.subcounts
		const head = h(
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
			h('span', { className: 'gbt-colname' }, group.label),
			subcounts === null ? null : h('span', { className: 'gbt-colsubcounts', 'data-col-subcounts': 'true' }, [
				h(
					'span',
					{ key: 'ready', className: 'gbt-colsubcount', 'data-subcount': 'ready', title: t('readyCount').replace('{n}', String(subcounts.ready)) },
					h('span', { className: 'gbt-sublabel' }, t('ready')),
					h('b', { className: 'gbt-subnum' }, ' ' + String(subcounts.ready)),
				),
				h(
					'span',
					{ key: 'waiting', className: 'gbt-colsubcount', 'data-subcount': 'waiting', title: t('waitingCount').replace('{n}', String(subcounts.waiting)) },
					h('span', { className: 'gbt-sublabel' }, t('waiting')),
					h('b', { className: 'gbt-subnum' }, ' ' + String(subcounts.waiting)),
				),
			]),
			h('span', { className: 'gbt-colcount' }, String(count)),
			props.note === undefined || props.note === null ? null : h('span', { className: 'gbt-colnote', 'data-col-note': 'investigating' }, props.note),
		)

		return h(
			'section',
			{ className: 'gbt-col', 'data-group': group.key, 'data-collapsed': collapsed ? 'true' : 'false', 'data-empty': empty ? 'true' : 'false' },
			head,
			showBody === false
				? null
				: h(
					'div',
					{ className: 'gbt-cards' },
					props.summary === undefined || props.summary === null ? null : props.summary,
					visible.length === 0
						? h(
							'div',
							{ className: 'gbt-empty gbt-emptyslim', 'data-col-empty': group.key },
							props.emptyTitle === undefined || props.emptyTitle === null ? null : h('span', { className: 'gbt-emptytitle' }, props.emptyTitle),
							h('span', null, props.emptyHint === undefined || props.emptyHint === null ? t('noTasks') : props.emptyHint),
						)
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
