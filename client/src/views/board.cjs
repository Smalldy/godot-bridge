/**
 * Board view module.
 *
 * Extracted from the views fragment; React, h, the two card/column components,
 * selectors and the mutable board UI state are injected by the build.
 */
function createBoard(deps) {
	const React = deps.React
	const h = deps.h
	const TaskCard = deps.TaskCard
	const Column = deps.Column
	const tcTime = deps.tcTime
	const tcKindOf = deps.tcKindOf
	const tcFirstNonEmptyColumn = deps.tcFirstNonEmptyColumn
	const tcColumnCollapsed = deps.tcColumnCollapsed
	const tcWriteColumnCollapsed = deps.tcWriteColumnCollapsed
	const DONE_COLUMN_PREVIEW = deps.DONE_COLUMN_PREVIEW
	const boardUiState = deps.boardUiState

	function Board(props) {
		// T-135: the board is its own horizontal scrollport; this ref lets the
		// effect below park it on the first column that actually has cards.
		const boardRef = React.useRef(null)
		const t = props.t
		const tasks = props.snapshot.tasks
		const counts = props.snapshot.counts === undefined || props.snapshot.counts === null ? {} : props.snapshot.counts
		// Recently finished work is the first thing a reader looks for; the done
		// and blocked columns are therefore newest-first. The other columns keep
		// the host's scheduling order (priority, then age).
		function recentFirst(left, right) {
			const leftAt = tcTime(left.updatedAt) === null ? tcTime(left.createdAt) : tcTime(left.updatedAt)
			const rightAt = tcTime(right.updatedAt) === null ? tcTime(right.createdAt) : tcTime(right.updatedAt)
			const delta = (rightAt === null ? 0 : rightAt) - (leftAt === null ? 0 : leftAt)
			return delta !== 0 ? delta : String(right.id).localeCompare(String(left.id))
		}
		// T-132: the kind filter narrows the whole board. The running note counts
		// the investigations the FILTERED board contains (under the Dev filter it
		// must not advertise investigations the filter hides), and the done column
		// count/footer follow the filter instead of the global host total.
		const kindFilter = boardUiState.kind === 'dev' || boardUiState.kind === 'investigate' ? boardUiState.kind : 'all'
		const filtered = kindFilter === 'all' ? tasks : tasks.filter(function (task) { return tcKindOf(task) === kindFilter })
		const investigatingRunning = filtered.filter(function (task) { return tcKindOf(task) === 'investigate' && task.status === 'running' }).length
		const visibleDone = filtered.filter(function (task) { return task.status === 'done' }).slice().sort(recentFirst)
		const doneCount = kindFilter === 'all' && Number.isFinite(counts.done) ? counts.done : visibleDone.length
		const groups = [
			{ key: 'ready', label: t('ready'), tasks: filtered.filter(function (task) { return task.status === 'pending' && task.dependency !== undefined && task.dependency.state === 'ready' }) },
			{ key: 'waiting', label: t('waiting'), tasks: filtered.filter(function (task) { return task.status === 'pending' && (task.dependency === undefined || task.dependency.state !== 'ready') }) },
			{ key: 'running', label: t('runningCol'), tasks: filtered.filter(function (task) { return task.status === 'running' }) },
			{ key: 'reviewing', label: t('reviewingCol'), tasks: filtered.filter(function (task) { return task.status === 'reviewing' }) },
			{ key: 'testing', label: t('testingCol'), tasks: filtered.filter(function (task) { return task.status === 'testing' }) },
			{ key: 'done', label: t('doneCol'), tasks: visibleDone },
			{
		key: 'blocked',
		label: t('blockedCol'),
		tasks: filtered.filter(function (task) { return task.status === 'blocked' || task.status === 'cancelled' }).slice().sort(recentFirst),
			},
		]
		// T-135: where the scrollport should sit. Computing it during render keeps
		// the attribute testable; the effect applies it only when the target is
		// not already fully visible, so manual panning is never fought.
		const scrollTarget = tcFirstNonEmptyColumn(groups)
		React.useEffect(function () {
			const board = boardRef.current
			if (board === null || board === undefined) return
			if (typeof board.scrollLeft !== 'number') return
			if (scrollTarget === null) {
		board.scrollLeft = 0
		return
			}
			if (typeof board.querySelector !== 'function') return
			const target = board.querySelector('[data-group="' + scrollTarget + '"]')
			if (target === null) return
			const scrollLeft = board.scrollLeft
			const clientWidth = typeof board.clientWidth === 'number' ? board.clientWidth : 0
			const left = typeof target.offsetLeft === 'number' ? target.offsetLeft : 0
			const width = typeof target.offsetWidth === 'number' ? target.offsetWidth : 0
			if (left >= scrollLeft && left + width <= scrollLeft + clientWidth) return
			board.scrollLeft = Math.max(0, left - 12)
		}, [tasks.length, boardUiState.kind, scrollTarget])
		const kindFilterBar = h(
			'div',
			{ className: 'gbt-kindfilter', 'data-kind-filter': kindFilter, title: t('kindFilterHint') },
			[
		['all', t('kindFilterAll')],
		['dev', t('kindDev')],
		['investigate', t('kindInvestigate')],
			].map(function (entry) {
		return h(
			'button',
			{
				key: entry[0],
				type: 'button',
				className: 'gbt-kindfilterbtn',
				'data-kind-filter': entry[0],
				'data-active': kindFilter === entry[0] ? 'true' : 'false',
				'aria-pressed': kindFilter === entry[0] ? 'true' : 'false',
				onClick: function () {
			boardUiState.kind = entry[0]
			if (typeof props.onKindFilterChange === 'function') props.onKindFilterChange()
				},
			},
			entry[1],
		)
			}),
		)
		if (tasks.length === 0) return h('div', { className: 'gbt-empty' }, t('emptyBoard'))
		function toggle(key) {
			tcWriteColumnCollapsed(key, !tcColumnCollapsed(key))
			if (props.onColumnToggle !== undefined) props.onColumnToggle()
		}
		const board = h(
			'div',
			{ className: 'gbt-board', ref: boardRef, 'data-scroll-target': scrollTarget === null ? '' : scrollTarget },
			groups.map(function (group) {
		const collapsed = tcColumnCollapsed(group.key)
		// The done column folds to the newest five cards, not to nothing:
		// the preview must stay readable while the archive stays out of the way.
		if (group.key === 'done') {
			const visible = collapsed ? group.tasks.slice(0, DONE_COLUMN_PREVIEW) : group.tasks
			return h(Column, {
				key: group.key,
				group: group,
				count: doneCount,
				visibleTasks: visible,
				collapsed: collapsed,
				allTasks: tasks,
				previewWhenCollapsed: true,
				t: t,
				now: props.now,
				selectedId: props.selectedId,
				onOpen: props.onOpen,
				onVerdict: props.onVerdict,
				onToggle: function () { toggle(group.key) },
				footer:
			doneCount === 0
				? null
				: h(
				'button',
				{
					type: 'button',
					className: 'gbt-linkbtn',
					'data-action': 'done-all',
					onClick: function () { if (props.onOpenDoneAll !== undefined) props.onOpenDoneAll() },
				},
				t('viewAllDone') + ' · ' + String(doneCount),
					),
			})
		}
		return h(Column, {
			key: group.key,
			group: group,
			collapsed: collapsed,
			allTasks: tasks,
			t: t,
			now: props.now,
			selectedId: props.selectedId,
			note: group.key === 'running' && investigatingRunning > 0 ? t('investigatingCount').replace('{n}', String(investigatingRunning)) : null,
		onOpen: props.onOpen,
		onVerdict: props.onVerdict,
		onToggle: function () { toggle(group.key) },
		})
			}),
		)
		return h('div', { className: 'gbt-boardwrap', 'data-board-kind': kindFilter }, kindFilterBar, board)
	}


	return Board
}

module.exports = { createBoard }
