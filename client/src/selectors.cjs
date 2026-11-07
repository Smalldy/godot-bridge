		function tcTime(value) {
			if (typeof value !== 'string') return null
			const at = Date.parse(value)
			return Number.isFinite(at) ? at : null
		}

		function tcAgo(value, now) {
			const at = typeof value === 'number' ? value : tcTime(value)
			if (at === null) return '—'
			const seconds = Math.max(0, Math.round((now - at) / 1000))
			if (seconds < 60) return String(seconds) + 's'
			const minutes = Math.round(seconds / 60)
			if (minutes < 60) return String(minutes) + 'm'
			const hours = Math.round(minutes / 60)
			if (hours < 24) return String(hours) + 'h'
			return String(Math.round(hours / 24)) + 'd'
		}

		/**
		 * The lease chip. It prefers the host's own leaseRemaining/leaseExpired/
		 * leaseReminder (the host is the authority on liveness) and falls back to
		 * the raw leaseUntil for callers that only have the timestamp.
		 */
		function tcLease(value, now, t, task) {
			const record = task === undefined || task === null ? null : task
			const at = tcTime(value)
			const remaining = record !== null && Number.isFinite(record.leaseRemaining) ? record.leaseRemaining : at === null ? null : at - now
			if (remaining === null) return null
			if (remaining <= 0 || (record !== null && record.leaseExpired === true)) return { text: t('leaseExpired'), warn: true, expired: true }
			const minutes = Math.max(0, Math.ceil(remaining / 60000))
			const text = minutes < 60 ? String(minutes) + 'm' : String(Math.round(minutes / 60)) + 'h'
			const remind = record !== null && record.leaseReminder === true
			return { text: t('leaseLeft') + ' ' + text, warn: remind === true || minutes <= 3, remind: remind }
		}

		function tcStatusKey(status) {
			return 'status' + status.charAt(0).toUpperCase() + status.slice(1)
		}

		/** Merge/review/test vocabulary shared by the card and the detail drawer. */
		const MERGE_LABELS = { open: 'mergeOpen', merged: 'mergeMerged', conflict: 'mergeConflict', failed: 'mergeFailed', rejected: 'mergeRejected' }
		const MERGE_TONES = { open: 'running', merged: 'done', conflict: 'broken', failed: 'blocked', rejected: 'cancelled' }
		const REVIEW_LABELS = { pending: 'reviewPending', approved: 'reviewApproved', 'changes-requested': 'reviewChanges' }
		const REVIEW_TONES = { pending: 'waiting', approved: 'done', 'changes-requested': 'broken' }
		const TEST_LABELS = { pending: 'testPending', passed: 'testPassed', failed: 'testFailed' }
		const TEST_TONES = { pending: 'waiting', passed: 'done', failed: 'broken' }
		const PHASE_LABELS = {
			running: 'runningCol',
			reviewing: 'reviewingCol',
			testing: 'testingCol',
			done: 'doneCol',
			blocked: 'statusBlocked',
			cancelled: 'statusCancelled',
		}
		const PHASE_TONES = { running: 'running', reviewing: 'reviewing', testing: 'testing', done: 'done', blocked: 'blocked', cancelled: 'cancelled' }

		function tcMergeOf(task) {
			const merge = task === null || task === undefined ? null : task.merge
			return merge !== null && merge !== undefined && typeof merge === 'object' && !Array.isArray(merge) ? merge : null
		}

		function tcReviewOf(task) {
			const review = task === null || task === undefined ? null : task.review
			return review !== null && review !== undefined && typeof review === 'object' && !Array.isArray(review) ? review : null
		}

		function tcTestOf(task) {
			const test = task === null || task === undefined ? null : task.test
			return test !== null && test !== undefined && typeof test === 'object' && !Array.isArray(test) ? test : null
		}

		/**
		 * True only while the card is still WAITING for its current stage's slot. A
		 * delivered round (review.deliveredAt / test.deliveredAt set) is already being
		 * worked on, so the queued chip must be gone even if a stale queuePosition
		 * survives from the server.
		 */
		function tcStageQueued(task) {
			if (task === null || task === undefined) return false
			if (!Number.isFinite(task.queuePosition) || task.queuePosition <= 0) return false
			const review = tcReviewOf(task)
			const test = tcTestOf(task)
			if (task.status === 'reviewing') return !(review !== null && typeof review.deliveredAt === 'string' && review.deliveredAt !== '')
			if (task.status === 'testing') return !(test !== null && typeof test.deliveredAt === 'string' && test.deliveredAt !== '')
			return false
		}

		/**
		 * The current phase as the board shows it. A pending task is either READY
		 * or WAITING; that split is derived from the Host's dependency report, not
		 * guessed from the dependency list.
		 */
		function tcPhaseOf(task) {
			const status = task === null || task === undefined ? 'pending' : task.status
			if (status === 'pending') {
				const dependency = task.dependency
				return dependency !== undefined && dependency !== null && dependency.state === 'ready' ? 'ready' : 'waiting'
			}
			return typeof status === 'string' && PHASE_LABELS[status] !== undefined ? status : 'waiting'
		}

		/**
		 * T-132: a card is either mergeable work ('dev', the historical default) or an
		 * investigation that delivers a report. A stored/legacy card without the field
		 * reads as dev, exactly like the server-side normalisation.
		 */
		function tcKindOf(task) {
			return task !== null && task !== undefined && task.kind === 'investigate' ? 'investigate' : 'dev'
		}

		function tcIsInvestigation(task) {
			return tcKindOf(task) === 'investigate'
		}

		/**
		 * T-135: the first column that actually has cards, or null when every column
		 * is empty. The board scrolls there on data/filter changes so a done-only
		 * board does not open on a screenful of empty columns.
		 */
		function tcFirstNonEmptyColumn(groups) {
			if (!Array.isArray(groups)) return null
			for (let index = 0; index < groups.length; index += 1) {
				const group = groups[index]
				if (group !== null && group !== undefined && Array.isArray(group.tasks) && group.tasks.length > 0) return group.key
			}
			return null
		}

		/**
		 * T-144/T-147: render a report body as light, SAFE Markdown. No dependency and
		 * no innerHTML: every node carries plain text. Headings (#/## -> h3, ### -> h4),
		 * `- ` and `1. ` lists, `>` quotes, pipe tables (with :---/---: alignment),
		 * ``` / ~~~ fences and inline **bold** / *italic* / `code` are understood.
		 * Unrecognised lines stay paragraph text (nothing is dropped). Only an
		 * unterminated fence falls the whole body back to a <pre>.
		 */
		function tcReportInline(value) {
			const text = String(value === undefined || value === null ? '' : value)
			const nodes = []
			let buffer = ''
			let index = 0
			const flush = function () {
				if (buffer === '') return
				nodes.push(buffer)
				buffer = ''
			}
			while (index < text.length) {
				const char = text.charAt(index)
				if (char === '`') {
					const end = text.indexOf('`', index + 1)
					if (end > index + 1) {
						flush()
						nodes.push(h('code', { key: 'inline-code-' + String(nodes.length), className: 'gbt-reportinline' }, text.slice(index + 1, end)))
						index = end + 1
						continue
					}
				}
				if (char === '*' && text.charAt(index + 1) === '*') {
					const end = text.indexOf('**', index + 2)
					if (end > index + 2) {
						flush()
						nodes.push(h('strong', { key: 'bold-' + String(nodes.length) }, tcReportInlineChild(text.slice(index + 2, end))))
						index = end + 2
						continue
					}
				}
				if (char === '*') {
					const end = text.indexOf('*', index + 1)
					if (end > index + 1 && text.charAt(end + 1) !== '*') {
						flush()
						nodes.push(h('em', { key: 'em-' + String(nodes.length) }, tcReportInlineChild(text.slice(index + 1, end))))
						index = end + 1
						continue
					}
				}
				if (char === '_') {
					const end = text.indexOf('_', index + 1)
					if (end > index + 1 && /[A-Za-z0-9]/.test(index === 0 ? '' : text.charAt(index - 1)) === false && /[A-Za-z0-9]/.test(text.charAt(end + 1)) === false) {
						flush()
						nodes.push(h('em', { key: 'em-' + String(nodes.length) }, tcReportInlineChild(text.slice(index + 1, end))))
						index = end + 1
						continue
					}
				}
				buffer += char
				index += 1
			}
			flush()
			return nodes
		}
		function tcReportInlineChild(value) {
			const nodes = tcReportInline(value)
			if (nodes.length === 0) return ''
			return nodes.length === 1 && typeof nodes[0] === 'string' ? nodes[0] : nodes
		}
		function tcReportTableCells(line) {
			let value = String(line).trim()
			if (value.charAt(0) === '|') value = value.slice(1)
			if (value.charAt(value.length - 1) === '|') value = value.slice(0, -1)
			return value.split('|').map(function (cell) { return cell.trim() })
		}
		function tcReportTableSeparator(line) {
			const cells = tcReportTableCells(line)
			if (cells.length === 0) return null
			const alignments = []
			for (const cell of cells) {
				if (/^:?-{3,}:?$/.test(cell) === false) return null
				const left = cell.charAt(0) === ':'
				const right = cell.charAt(cell.length - 1) === ':'
				alignments.push(left && right ? 'center' : left ? 'left' : right ? 'right' : null)
			}
			return alignments
		}
		function tcReportFence(line) {
			const match = /^(`{3,}|~{3,})(.*)$/.exec(String(line))
			if (match === null) return null
			return { marker: match[1], char: match[1].charAt(0), length: match[1].length }
		}
		function tcReportBlocks(text) {
			try {
				const lines = String(text === undefined || text === null ? '' : text).replace(/\r\n/g, '\n').split('\n')
				const nodes = []
				let index = 0
				let paragraph = []
				const flushParagraph = function () {
					if (paragraph.length === 0) return
					nodes.push(h('p', { key: 'p-' + String(nodes.length), className: 'gbt-reportpara', 'data-report-block': 'paragraph' }, tcReportInlineChild(paragraph.join('\n'))))
					paragraph = []
				}
				while (index < lines.length) {
					const line = lines[index]
					const fence = tcReportFence(line)
					if (fence !== null) {
						flushParagraph()
						const code = []
						index += 1
						let terminated = false
						while (index < lines.length) {
							const close = String(lines[index]).trim()
							let sameChar = close.length >= fence.length
							if (sameChar) {
								for (let at = 0; at < close.length; at += 1) {
									if (close.charAt(at) !== fence.char) { sameChar = false; break }
								}
							}
							if (sameChar) { terminated = true; break }
							code.push(lines[index])
							index += 1
						}
						// Only an unterminated fence is a parse failure: the outer catch keeps the
						// whole body in a <pre> instead of guessing where the code ends.
						if (terminated !== true) throw new Error('unterminated code fence')
						index += 1
						nodes.push(h('pre', { key: 'code-' + String(nodes.length), className: 'gbt-reportcode', 'data-report-block': 'code' }, h('code', null, code.join('\n'))))
						continue
					}
					const heading = /^(#{1,3})\s+(.*)$/.exec(line)
					if (heading !== null) {
						flushParagraph()
						nodes.push(h(heading[1].length <= 2 ? 'h3' : 'h4', { key: 'h-' + String(nodes.length), className: 'gbt-reportheading', 'data-report-block': 'heading', 'data-report-level': String(heading[1].length) }, tcReportInlineChild(heading[2])))
						index += 1
						continue
					}
					if (line.indexOf('|') >= 0 && index + 1 < lines.length) {
						const alignments = tcReportTableSeparator(lines[index + 1])
						const header = tcReportTableCells(line)
						if (alignments !== null && header.length > 0 && alignments.length === header.length) {
							flushParagraph()
							const rows = []
							index += 2
							while (index < lines.length && String(lines[index]).indexOf('|') >= 0 && String(lines[index]).trim() !== '') {
								rows.push(tcReportTableCells(lines[index]))
								index += 1
							}
							const columnStyle = function (at) { return alignments[at] === null ? undefined : { textAlign: alignments[at] } }
							nodes.push(h('div', { key: 'table-' + String(nodes.length), className: 'gbt-reporttablescroll', 'data-report-block': 'table' },
								h('table', { className: 'gbt-reporttable gbt-reportmdtable' },
									h('thead', null, h('tr', null, header.map(function (cell, at) { return h('th', { key: 'h' + String(at), style: columnStyle(at) }, tcReportInlineChild(cell)) }))),
									h('tbody', null, rows.map(function (row, rowIndex) { return h('tr', { key: 'r' + String(rowIndex) }, header.map(function (cell, at) { return h('td', { key: 'c' + String(at), style: columnStyle(at) }, tcReportInlineChild(row[at] === undefined ? '' : row[at])) })) })),
								)));
							continue
						}
					}
					if (/^\s*[-*]\s+/.test(line)) {
						flushParagraph()
						const items = []
						while (index < lines.length && /^\s*[-*]\s+/.test(lines[index])) {
							items.push(lines[index].replace(/^\s*[-*]\s+/, ''))
							index += 1
						}
						nodes.push(h('ul', { key: 'ul-' + String(nodes.length), className: 'gbt-reportlist', 'data-report-block': 'list' }, items.map(function (item, at) { return h('li', { key: String(at), className: 'gbt-reportlistitem' }, tcReportInlineChild(item)) })))
						continue
					}
					if (/^\s*\d+[.)]\s+/.test(line)) {
						flushParagraph()
						const items = []
						while (index < lines.length && /^\s*\d+[.)]\s+/.test(lines[index])) {
							items.push(lines[index].replace(/^\s*\d+[.)]\s+/, ''))
							index += 1
						}
						nodes.push(h('ol', { key: 'ol-' + String(nodes.length), className: 'gbt-reportlist', 'data-report-block': 'ordered-list' }, items.map(function (item, at) { return h('li', { key: String(at), className: 'gbt-reportlistitem' }, tcReportInlineChild(item)) })))
						continue
					}
					if (/^\s*>\s?/.test(line)) {
						flushParagraph()
						const quoted = []
						while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
							quoted.push(lines[index].replace(/^\s*>\s?/, ''))
							index += 1
						}
						nodes.push(h('blockquote', { key: 'quote-' + String(nodes.length), className: 'gbt-reportquote', 'data-report-block': 'quote' }, tcReportInlineChild(quoted.join('\n'))))
						continue
					}
					if (line.trim() === '') {
						flushParagraph()
						index += 1
						continue
					}
					paragraph.push(line)
					index += 1
				}
				flushParagraph()
				return nodes.length === 0 ? [h('p', { key: 'empty', className: 'gbt-footnote', 'data-report-block': 'empty' }, '—')] : nodes
			} catch (error) {
				return [h('pre', { key: 'fallback', className: 'gbt-reportbody', 'data-report-block': 'fallback' }, String(text === undefined || text === null ? '' : text))]
			}
		}
				/** The phase word an investigation shows: 待调查 / 调查中 / 报告已交付. */
		function tcInvestigationPhaseLabel(task, t) {
			if (task.status === 'pending') return t('investigatePending')
			if (task.status === 'running') return t('statusInvestigating')
			if (task.status === 'done') return t('reportDelivered')
			return t(tcStatusKey(task.status))
		}

		function tcPhaseLabel(task, t) {
			if (tcIsInvestigation(task)) return tcInvestigationPhaseLabel(task, t)
			const phase = tcPhaseOf(task)
			if (phase === 'ready') return t('ready')
			if (phase === 'waiting') return t('waiting')
			return t(PHASE_LABELS[phase])
		}

		function tcPhaseTone(task) {
			const phase = tcPhaseOf(task)
			if (phase === 'ready') return 'ready'
			if (phase === 'waiting') return 'waiting'
			return PHASE_TONES[phase] || 'waiting'
		}

		function tcMergeLabel(status, t) {
			const key = MERGE_LABELS[status]
			return key === undefined ? String(status === undefined || status === null ? '—' : status) : t(key)
		}

		function tcMergeTone(status) {
			return MERGE_TONES[status] || 'waiting'
		}

		function tcReviewLabel(status, t) {
			const key = REVIEW_LABELS[status]
			return key === undefined ? String(status === undefined || status === null ? '—' : status) : t(key)
		}

		function tcReviewTone(status) {
			return REVIEW_TONES[status] || 'waiting'
		}

		function tcTestLabel(status, t) {
			const key = TEST_LABELS[status]
			return key === undefined ? String(status === undefined || status === null ? '—' : status) : t(key)
		}

		function tcTestTone(status) {
			return TEST_TONES[status] || 'waiting'
		}

		/** The round counter on a phase record; a missing count reads as round 0. */
		function tcRound(record) {
			const value = record === null || record === undefined ? 0 : record.attempt
			return Number.isFinite(value) ? Math.floor(value) : 0
		}

		/** The last max CHARACTERS (not UTF-16 units), so a surrogate pair survives. */
		function tcTail(text, max) {
			const value = String(text === undefined || text === null ? '' : text)
			const characters = Array.from(value)
			if (characters.length <= max) return { text: value, truncated: false }
			return { text: characters.slice(characters.length - max).join(''), truncated: true }
		}

		function tcBaseName(path) {
			const parts = String(path === undefined || path === null ? '' : path).split(/[\\/]/).filter(function (part) { return part !== '' })
			return parts.length === 0 ? String(path) : parts[parts.length - 1]
		}

		/** A session id's useful part: after the "session-" prefix, else the first 8 chars. */
		function tcSessionShort(value) {
			if (typeof value !== 'string' || value === '') return null
			return value.indexOf('session-') === 0 ? value.slice(8, 16) : value.slice(0, 8)
		}

		/** A Team Lead name as DISPLAY text: a raw session id never appears verbatim. */
		function tcLeadText(lead, t) {
			const value = lead === null || lead === undefined ? '' : String(lead)
			if (value === '') return '—'
			if (value.indexOf('session-') !== 0) return value
			const short = tcSessionShort(value)
			return t('workersLeadSelf') + (short === null || short === '' ? '' : ' · ' + short)
		}

		/** One labelled tail-only output block inside the drawer. */
		function outputBlock(key, label, text, t) {
			const tail = tcTail(text, 1200)
			return h(
				'div',
				{ key: key, className: 'gbt-outputblock' },
				h('div', { className: 'gbt-subhead' }, label),
				text === ''
					? h('p', { className: 'gbt-footnote' }, t('noOutput'))
					: h('pre', { className: 'gbt-output' }, (tail.truncated ? '… ' + t('outputTailHint') + '\n' : '') + tail.text),
			)
		}

		function tcParseList(text) {
			return String(text === undefined || text === null ? '' : text)
				.split(/[\s,]+/)
				.map(function (part) { return part.trim() })
				.filter(function (part) { return part.length > 0 })
		}

		function tcParseFiles(text) {
			return String(text === undefined || text === null ? '' : text)
				.split(/[\n,]+/)
				.map(function (part) { return part.trim() })
				.filter(function (part) { return part.length > 0 })
		}

		/**
		 * The client Context captured in apply(), so the session resolver can ask the
		 * DSH shell which session it is showing (T-99). Null in a build that never
		 * called apply (tests that only exercise a helper).
		 */
		let tcHostContext = null

		/**
		 * The REAL session id the Host UI is showing, or null when it does not say.
		 *
		 * DSH's browser shell keeps the shown session in two places, both owned by the
		 * Host: `uiWorkspace.selection` (a persisted snapshot store, localStorage key
		 * `dsh.sessions.current`, written whenever the main session is swapped) and
		 * `uiSession.current` (the main-view binding). They carry the SAME id the tool
		 * path receives as `agent.id`, which is what makes the panel share the session
		 * binding without any URL parameter.
		 *
		 * This is deliberately a read, never a guess: a missing service, an empty
		 * selection or a closed session returns null, and the caller falls back to the
		 * per-window id — never to "the most recently active session" or a global slot.
		 */
		

module.exports = {
  tcTime,
  tcAgo,
  tcLease,
  tcStatusKey,
  tcMergeOf,
  tcReviewOf,
  tcTestOf,
  tcStageQueued,
  tcPhaseOf,
  tcKindOf,
  tcIsInvestigation,
  tcFirstNonEmptyColumn,
  tcReportInline,
  tcReportInlineChild,
  tcReportTableCells,
  tcReportTableSeparator,
  tcReportFence,
  tcReportBlocks,
  tcInvestigationPhaseLabel,
  tcPhaseLabel,
  tcPhaseTone,
  tcMergeLabel,
  tcMergeTone,
  tcReviewLabel,
  tcReviewTone,
  tcTestLabel,
  tcTestTone,
  tcRound,
  tcTail,
  tcBaseName,
  tcSessionShort,
  tcLeadText,
  outputBlock,
  tcParseList,
  tcParseFiles,
}
