/**
 * Board view module.
 *
 * T-158 (夜航作战板): six lanes instead of seven. ready + waiting collapse into
 * one 待派发 lane whose head carries BOTH counts; the done lane always shows the
 * newest cards plus the archive entry point, and an empty lane narrows instead of
 * stretching. The kind filter lives in the panel toolbar now, so the board only
 * reads props.kind.
 */
function createBoard(deps) {
	const React = deps.React
	const h = deps.h
	const Column = deps.Column
	const tcTime = deps.tcTime
	const tcKindOf = deps.tcKindOf
	const tcFirstNonEmptyColumn = deps.tcFirstNonEmptyColumn
	const tcColumnCollapsed = deps.tcColumnCollapsed
	const tcWriteColumnCollapsed = deps.tcWriteColumnCollapsed
	const DONE_COLUMN_PREVIEW = deps.DONE_COLUMN_PREVIEW
	const boardUiState = deps.boardUiState

	function Board(props) {
		// T-135: the board is its own scrollport and parks on the first lane with
		// cards; T-158 keeps that behaviour for the six-lane layout.
		const boardRef = React.useRef(null)
		const t = props.t
		const tasks = props.snapshot.tasks
		const counts = props.snapshot.counts === undefined || props.snapshot.counts === null ? {} : props.snapshot.counts
		function recentFirst(left, right) {
			const leftAt = tcTime(left.updatedAt) === null ? tcTime(left.createdAt) : tcTime(left.updatedAt)
			const rightAt = tcTime(right.updatedAt) === null ? tcTime(right.createdAt) : tcTime(right.updatedAt)
			const delta = (rightAt === null ? 0 : rightAt) - (leftAt === null ? 0 : leftAt)
			return delta !== 0 ? delta : String(right.id).localeCompare(String(left.id))
		}
		const kindFilter = props.kind === 'dev' || props.kind === 'investigate' ? props.kind : 'all'
		const filtered = kindFilter === 'all' ? tasks : tasks.filter(function (task) { return tcKindOf(task) === kindFilter })
		const investigatingRunning = filtered.filter(function (task) { return tcKindOf(task) === 'investigate' && task.status === 'running' }).length
		const visibleDone = filtered.filter(function (task) { return task.status === 'done' }).slice().sort(recentFirst)
		const doneCount = kindFilter === 'all' && Number.isFinite(counts.done) ? counts.done : visibleDone.length
		const pending = filtered.filter(function (task) { return task.status === 'pending' })
		const readyTasks = pending.filter(function (task) { return task.dependency !== undefined && task.dependency !== null && task.dependency.state === 'ready' })
		const waitingTasks = pending.filter(function (task) { return !(task.dependency !== undefined && task.dependency !== null && task.dependency.state === 'ready') })
		// T-158: six lanes. 待派发 covers BOTH ready and waiting cards; its head
		// shows the two numbers so the split stays readable without a seventh lane.
		const groups = [
			{ key: 'dispatch', label: t('dispatchCol'), tasks: readyTasks.concat(waitingTasks), subcounts: { ready: readyTasks.length, waiting: waitingTasks.length } },
			{ key: 'running', label: t('runningCol'), tasks: filtered.filter(function (task) { return task.status === 'running' }) },
			{ key: 'reviewing', label: t('reviewingCol'), tasks: filtered.filter(function (task) { return task.status === 'reviewing' }) },
			{ key: 'testing', label: t('testingCol'), tasks: filtered.filter(function (task) { return task.status === 'testing' }) },
			{ key: 'done', label: t('doneCol'), tasks: visibleDone },
			{ key: 'blocked', label: t('blockedCol'), tasks: filtered.filter(function (task) { return task.status === 'blocked' || task.status === 'cancelled' }).slice().sort(recentFirst) },
		]
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
		}, [tasks.length, kindFilter, scrollTarget])
		if (tasks.length === 0) return h('div', { className: 'gbt-empty' }, t('emptyBoard'))
		function toggle(key) {
			tcWriteColumnCollapsed(key, !tcColumnCollapsed(key))
			if (props.onColumnToggle !== undefined) props.onColumnToggle()
		}
		const donePreview = visibleDone.slice(0, DONE_COLUMN_PREVIEW)
		const doneSummary = h(
			'div',
			{ className: 'gbt-done-summary', 'data-done-summary': 'true' },
			h('span', null, t('doneAllSummary').replace('{total}', String(doneCount)).replace('{recent}', String(donePreview.length))),
			h('button', { type: 'button', className: 'gbt-linkbtn', 'data-action': 'done-all', onClick: function () { if (props.onOpenDoneAll !== undefined) props.onOpenDoneAll() } }, t('viewArchive')),
		)
		const board = h(
			'div',
			{ className: 'gbt-board', ref: boardRef, 'data-scroll-target': scrollTarget === null ? '' : scrollTarget },
			groups.map(function (group) {
				const collapsed = tcColumnCollapsed(group.key)
				if (group.key === 'done') {
					return h(Column, {
						key: group.key,
						group: group,
						count: doneCount,
						visibleTasks: collapsed ? donePreview : visibleDone,
						summary: doneSummary,
						collapsed: collapsed,
						allTasks: tasks,
						previewWhenCollapsed: true,
						t: t,
						now: props.now,
						selectedId: props.selectedId,
						onOpen: props.onOpen,
						onVerdict: props.onVerdict,
						onToggle: function () { toggle(group.key) },
					})
				}
				if (group.key === 'blocked') {
					return h(Column, {
						key: group.key,
						group: group,
						collapsed: collapsed,
						allTasks: tasks,
						t: t,
						now: props.now,
						selectedId: props.selectedId,
						emptyTitle: t('noBlockedTitle'),
						emptyHint: t('noBlockedHint'),
						onOpen: props.onOpen,
						onVerdict: props.onVerdict,
						onToggle: function () { toggle(group.key) },
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
					subcounts: group.subcounts === undefined ? null : group.subcounts,
					note: group.key === 'running' && investigatingRunning > 0 ? t('investigatingCount').replace('{n}', String(investigatingRunning)) : null,
					onOpen: props.onOpen,
					onVerdict: props.onVerdict,
					onToggle: function () { toggle(group.key) },
				})
			}),
		)
		return h('div', { className: 'gbt-boardwrap', 'data-board-kind': kindFilter }, board)
	}

	return Board
}

module.exports = { createBoard }
