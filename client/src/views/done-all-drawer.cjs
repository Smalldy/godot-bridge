/**
 * Completed-tasks drawer view module.
 *
 * Extracted from the views fragments; React, h, the mutable done-all state and
 * the local day bucket are injected by the build.
 */
function createDoneAllDrawer(deps) {
	const React = deps.React
	const h = deps.h
	const doneAllState = deps.doneAllState
	const tcDayKey = deps.tcDayKey

	function DoneAllDrawer(props) {
		const t = props.t
		const list = props.store
		const archived = props.archived === true
		const [, setVersion] = React.useState(0)
		const bump = function () { setVersion(function (value) { return value + 1 }) }
		const items = doneAllState.items
		const next = doneAllState.next
		const query = doneAllState.query
		const loading = doneAllState.loading
		const error = doneAllState.error
		const failedMore = doneAllState.failedMore
		const now = Date.now()

		function applyPage(payload, reset) {
			if (payload === null || payload === undefined || payload.ok !== true) {
		doneAllState.error = true
		doneAllState.loading = false
		bump()
		return false
			}
			const page = Array.isArray(payload.tasks) ? payload.tasks : []
			if (reset === true) {
		doneAllState.items = page
			} else {
		const seen = new Set(doneAllState.items.map(function (task) { return task.id }))
		doneAllState.items = doneAllState.items.concat(page.filter(function (task) { return !seen.has(task.id) }))
			}
			doneAllState.next = typeof payload.nextCursor === 'string' && payload.nextCursor !== '' ? payload.nextCursor : null
			doneAllState.error = false
			doneAllState.failedMore = false
			doneAllState.loading = false
			bump()
			return true
		}

		React.useEffect(function () {
			if (doneAllState.loadedQuery === query) return
			doneAllState.loadedQuery = query
			const token = doneAllState.token + 1
			doneAllState.token = token
			doneAllState.loading = true
			doneAllState.error = false
			doneAllState.failedMore = false
			const handle = setTimeout(function () {
		void list.listTasks({ status: 'done', q: query, limit: 50, archived: archived }).then(function (payload) {
			if (token !== doneAllState.token) return
			applyPage(payload, true)
		})
			}, query === '' ? 0 : 250)
			return function () { clearTimeout(handle) }
		}, [query])

		function loadMore() {
			if (next === null || doneAllState.busy === true) return
			doneAllState.busy = true
			doneAllState.loading = true
			bump()
			const token = doneAllState.token
			void list.listTasks({ status: 'done', q: query, cursor: next, limit: 50, archived: archived }).then(function (payload) {
		doneAllState.busy = false
		if (token !== doneAllState.token) return
		if (!applyPage(payload, false)) {
			doneAllState.failedMore = true
			bump()
		}
			})
		}

		function retry() {
			doneAllState.loadedQuery = null
			doneAllState.token += 1
			doneAllState.loading = true
			doneAllState.error = false
			bump()
			void list.listTasks({ status: 'done', q: query, limit: 50, archived: archived }).then(function (payload) {
		applyPage(payload, true)
			})
		}

		const buckets = { today: [], yesterday: [], earlier: [] }
		for (const task of items) buckets[tcDayKey(task.updatedAt, now)].push(task)
		const sections = [
			{ key: 'today', label: t('doneAllToday') },
			{ key: 'yesterday', label: t('doneAllYesterday') },
			{ key: 'earlier', label: t('doneAllEarlier') },
		].filter(function (section) { return buckets[section.key].length > 0 })

		return h(
			'div',
			{ className: 'gbt-detailoverlay', 'data-done-all-overlay': 'true' },
			h('div', { className: 'gbt-detailmask', onClick: props.onClose }),
			h(
		'div',
		{ className: 'gbt-detailpanel', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('doneAllTitle') },
		h(
			'div',
			{ className: 'gbt-drawerhead' },
			h('strong', null, t(archived ? 'archiveTitle' : 'doneAllTitle')),
			h('span', { className: 'gbt-muted' }, ' · ' + t('doneAllCount').replace('{n}', String(Number.isFinite(props.total) ? props.total : items.length))),
			h('span', { className: 'gbt-muted' }, ' · ' + t('doneAllLoaded').replace('{n}', String(items.length))),
			h('button', { type: 'button', className: 'gbt-iconbtn', onClick: props.onClose, 'aria-label': t('doneAllTitle') }, '×'),
		),
		h(
			'div',
			{ className: 'gbt-drawerbody', style: { display: 'flex', flexDirection: 'column' } },
			h('div', { className: 'gbt-donelist', style: { paddingBottom: 0 } }, h('input', {
				type: 'search',
				className: 'gbt-input',
				value: query,
				placeholder: t('doneAllSearch'),
				'aria-label': t('doneAllSearch'),
				onChange: function (event) {
			doneAllState.query = String(event.target.value)
			doneAllState.loadedQuery = null
			doneAllState.loading = true
			bump()
				},
			})),
			error === true && items.length === 0
				? h(
				'div',
				{ className: 'gbt-donelist' },
				h('div', { className: 'gbt-banner' }, t('doneAllError')),
				h('div', null, h('button', { type: 'button', className: 'gbt-btn', onClick: retry }, t('doneAllRetry'))),
			)
				: loading === true && items.length === 0
			? h(
					'div',
					{ className: 'gbt-donelist', 'data-done-all-loading': 'true' },
					Array.from({ length: 6 }).map(function (value, index) {
				return h('div', { key: 'skeleton-' + String(index), className: 'gbt-skel' })
					}),
				)
			: items.length === 0
				? h('div', { className: 'gbt-donelist' }, h('div', { className: 'gbt-empty' }, t(archived ? 'archiveEmpty' : 'doneAllEmpty')))
				: h(
				'div',
				{
					className: 'gbt-donelist',
					style: { overflow: 'auto', flex: '1', minHeight: 0 },
					onScroll: function (event) {
						const node = event.target
						if (node.scrollTop + node.clientHeight >= node.scrollHeight - 48) loadMore()
					},
				},
				sections.map(function (section) {
					return h(
						'div',
						{ key: section.key, 'data-done-group': section.key },
						h('div', { className: 'gbt-donetitle' }, section.label),
						buckets[section.key].map(function (task) {
					return h(
						'button',
						{
							key: task.id,
							type: 'button',
							className: 'gbt-donerow',
							'data-done-row': task.id,
							onClick: function () { props.onOpen(task.id) },
						},
						h('span', { className: 'gbt-id' }, task.id),
						h('span', { className: 'gbt-donetitletext' }, String(task.title === undefined ? '' : task.title)),
						h('span', { className: 'gbt-donewhen' }, task.updatedAt === null || task.updatedAt === undefined ? '' : String(task.updatedAt).slice(0, 10)),
					)
						}),
					)
				}),
				failedMore === true ? h('div', { className: 'gbt-banner' }, t('doneAllError')) : null,
				next === null
					? null
					: h(
					'div',
					{ style: { padding: '10px 0 4px' } },
					h('button', { type: 'button', className: 'gbt-btn', 'data-action': 'done-more', disabled: loading, onClick: loadMore }, loading ? t('doneAllLoading') : t('doneAllLoadMore')),
						),
					),
		),
			),
		)
	}

	/** One ready/waiting queue row: id, title, and summary-only chips. */

	return DoneAllDrawer
}

module.exports = { createDoneAllDrawer }
