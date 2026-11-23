		/**
		 * T-233: one DOMAIN of the client query cache.
		 *
		 * Every domain of the store (board, meta, detail) keeps its OWN
		 *   { data, status, receivedAt, error, generation, lastGood, scope }
		 * instead of sharing one snapshot. One failing endpoint can therefore never
		 * blank another domain, and an answer from an OLDER request can never
		 * overwrite a newer one:
		 *
		 *   begin(scope)                          start a request, return its token
		 *   current(token)                        is this answer still the newest?
		 *   succeed(token, data, status, error)   the answer landed (lastGood moves)
		 *   fail(token, error, status)            the request failed (lastGood stays)
		 *   invalidate()                          keep lastGood, bump generation
		 *   reset(scope)                          drop everything (project switch)
		 *   fresh()                               is data younger than staleTime?
		 *
		 * 'data' is what the view may show, 'lastGood' is the newest answer that
		 * ever landed, and 'status' says which of the two is on screen.
		 */
		function tcCreateDomainCache(options) {
			const o = options === undefined || options === null ? {} : options
			const now = typeof o.now === 'function' ? o.now : function () { return Date.now() }
			const staleTime = Number.isFinite(o.staleTime) && o.staleTime > 0 ? o.staleTime : 0
			const state = {
				name: typeof o.name === 'string' && o.name !== '' ? o.name : 'domain',
				data: null,
				// idle | loading | ready | degraded | error | stale
				status: 'idle',
				receivedAt: 0,
				error: null,
				generation: 0,
				lastGood: null,
				// The project key this domain's data DESCRIBES (null = not scoped yet).
				scope: null,
				staleTime: staleTime,
			}
			function begin(scope) {
				state.generation += 1
				state.scope = scope === undefined ? null : scope
				state.status = 'loading'
				state.error = null
				return { generation: state.generation, scope: state.scope }
			}
			function current(token) {
				return token !== null && token !== undefined && token.generation === state.generation
			}
			function succeed(token, data, status, error) {
				if (!current(token)) return false
				state.data = data
				state.lastGood = data
				state.status = typeof status === 'string' && status !== '' ? status : 'ready'
				state.error = error === undefined ? null : error
				state.receivedAt = now()
				return true
			}
			function fail(token, error, status) {
				if (!current(token)) return false
				// lastGood (and data, while it is the last good one) is kept: a failed
				// refresh must not turn a rendered board into an empty one.
				state.status = typeof status === 'string' && status !== '' ? status : 'error'
				state.error = error === undefined ? null : error
				return true
			}
			function invalidate() {
				state.generation += 1
				state.status = state.data === null ? 'idle' : 'stale'
				state.error = null
			}
			function reset(scope) {
				state.generation += 1
				state.data = null
				state.lastGood = null
				state.status = 'idle'
				state.receivedAt = 0
				state.error = null
				state.scope = scope === undefined ? null : scope
			}
			function fresh() {
				return state.data !== null && staleTime > 0 && now() - state.receivedAt < staleTime
			}
			return {
				state: function () { return state },
				begin: begin,
				current: current,
				succeed: succeed,
				fail: fail,
				invalidate: invalidate,
				reset: reset,
				fresh: fresh,
			}
		}

		/**
		 * T-233: the detail domain, keyed by card id.
		 *
		 * /task is the only request that carries a card's FULL detail, so it is
		 * cached per card and validated by the summary's updatedAt: a poll that did
		 * not change the card never refetches, a changed card does. The cache EPOCH
		 * invalidates every card at once on a project switch, so a detail answer for
		 * the old project can never land on the new board.
		 */
		function tcCreateDetailCache(options) {
			const o = options === undefined || options === null ? {} : options
			const now = typeof o.now === 'function' ? o.now : function () { return Date.now() }
			const entries = new Map()
			let epoch = 0
			function entryOf(id) {
				let entry = entries.get(id)
				if (entry === undefined) {
					entry = {
						id: id,
						data: null,
						status: 'idle',
						receivedAt: 0,
						error: null,
						generation: 0,
						lastGood: null,
						// The summary.updatedAt this detail was read for.
						updatedAt: null,
						epoch: epoch,
					}
					entries.set(id, entry)
				}
				return entry
			}
			/** Would a load for this card actually reach the Host? */
			function needs(id, summary) {
				const entry = entries.get(id)
				if (entry === undefined || entry.data === null) return true
				if (entry.epoch !== epoch) return true
				// An invalidated (stale) or failed detail is retried even when the card
				// itself did not move: an action or a transport blip owns that state.
				if (entry.status === 'stale' || entry.status === 'error') return true
				const updatedAt = summary === undefined || summary === null ? null : summary.updatedAt
				return entry.updatedAt !== (updatedAt === undefined ? null : updatedAt)
			}
			function begin(id, summaryUpdatedAt) {
				const entry = entryOf(id)
				entry.generation += 1
				entry.epoch = epoch
				entry.status = 'loading'
				entry.error = null
				entry.updatedAt = summaryUpdatedAt === undefined ? null : summaryUpdatedAt
				return { id: id, epoch: epoch, generation: entry.generation, updatedAt: entry.updatedAt }
			}
			function current(token) {
				const entry = entries.get(token.id)
				return entry !== undefined && token.epoch === epoch && token.generation === entry.generation
			}
			function succeed(token, task) {
				if (!current(token)) return false
				const entry = entries.get(token.id)
				entry.data = { task: task, updatedAt: token.updatedAt }
				entry.lastGood = entry.data
				entry.status = 'ready'
				entry.receivedAt = now()
				entry.error = null
				return true
			}
			function fail(token, error) {
				if (!current(token)) return false
				const entry = entries.get(token.id)
				// A failed /task keeps the last good detail of the card: the summary
				// the board already has stays rendered either way.
				entry.status = 'error'
				entry.error = error === undefined ? null : error
				return true
			}
			function invalidate(ids) {
				if (!Array.isArray(ids)) {
					epoch += 1
					entries.forEach(function (entry) { entry.generation += 1 })
					return
				}
				ids.forEach(function (id) {
					const entry = entries.get(id)
					if (entry === undefined) return
					entry.generation += 1
					if (entry.data !== null) entry.status = 'stale'
				})
			}
			/**
			 * T-234: drop ONE card for good (deleted / the host answered
			 * unknown-task). The generation bump makes a late answer for it unable to
			 * land, and the entry is gone so no reader can be handed it as lastGood.
			 */
			function forget(id) {
				const entry = entries.get(id)
				if (entry === undefined) return
				entry.generation += 1
				entries.delete(id)
			}
			function clear() {
				epoch += 1
				entries.clear()
			}
			/** The legacy { [id]: { task, updatedAt } } shape, only for cards that did not move on. */
			function compose(tasks) {
				const summaries = new Map()
				if (Array.isArray(tasks)) {
					for (const task of tasks) {
						if (task !== null && typeof task === 'object') summaries.set(task.id, task)
					}
				}
				const details = {}
				entries.forEach(function (entry) {
					if (entry.data === null || entry.epoch !== epoch) return
					if (entry.status === 'stale') return
					const summary = summaries.get(entry.id)
					// The card moved on since this detail was read: the older full detail
					// would silently contradict the newer summary, so it is not shown.
					if (summary !== undefined && summary.updatedAt !== entry.data.updatedAt) return
					details[entry.id] = { task: entry.data.task, updatedAt: entry.data.updatedAt }
				})
				return details
			}
			return {
				stateOf: function (id) { return entries.get(id) || null },
				entries: function () { return Array.from(entries.values()) },
				needs: needs,
				begin: begin,
				current: current,
				succeed: succeed,
				fail: fail,
				invalidate: invalidate,
				forget: forget,
				clear: clear,
				compose: compose,
			}
		}

		/**
		 * T-235: the DECISIONS domain — the ONE owner of the pending queue.
		 *
		 * Before this domain the queue had two independent writers: the 2.5 s /state
		 * poll and the shell overlay's own 5 s decisionList poll both assigned the same
		 * local array. Nothing ordered the two answers, so a slow /state that started
		 * before an answer could repaint a queue that was already newer, and the panel
		 * modal and the overlay each kept a request going.
		 *
		 *   begin/current   every list request owns a generation; a superseded answer
		 *                   (a project switch, a reset) never lands;
		 *   succeed         a list answer lands only when its server decisionRevision is
		 *                   NEWER than the shown one (equal is dropped: same queue);
		 *   seed            the ONE-WAY bootstrap. A /state (or action) snapshot fills an
		 *                   EMPTY domain; after the first queue the decisions cadence
		 *                   owns it and the board poll stops being a queue writer;
		 *   answered        an answer's new revision drops exactly that request, so an
		 *                   older list answer cannot resurrect it;
		 *   fail            a failed refresh keeps the last good queue (degraded).
		 *
		 * A Host that sends no decisionRevision keeps the pre-T-235 behaviour (newest
		 * answer wins): there is no ordering to compare, and the queue is still shared.
		 */
		function tcCreateDecisionCache(options) {
			const o = options === undefined || options === null ? {} : options
			const now = typeof o.now === 'function' ? o.now : function () { return Date.now() }
			const state = {
				name: typeof o.name === 'string' && o.name !== '' ? o.name : 'decisions',
				// The pending queue on screen (null = nothing answered yet).
				decisions: null,
				// The server decisionRevision this queue describes (null = the Host does not
				// advertise one; the queue then falls back to last-answer-wins).
				revision: null,
				// idle | loading | ready | degraded
				status: 'idle',
				error: null,
				receivedAt: 0,
				generation: 0,
				lastGood: null,
				// The pinned project this queue describes (null = not scoped yet).
				scope: null,
			}
			function begin(scope) {
				state.generation += 1
				state.scope = scope === undefined ? null : scope
				// With a queue on screen the ANSWER owns the status: a recorded 'degraded'
				// stays visible until a good answer replaces it with 'ready'.
				if (state.decisions === null) state.status = 'loading'
				state.error = null
				return { generation: state.generation, scope: state.scope }
			}
			function current(token) {
				return token !== null && token !== undefined && token.generation === state.generation
			}
			/** Is this answer NEWER than the queue already on screen? */
			function accepts(revision) {
				if (state.decisions === null) return true
				const next = Number.isFinite(revision) ? revision : null
				// A Host without revisions has no ordering: the last answer wins.
				if (next === null) return state.revision === null
				if (state.revision === null) return true
				// Equal is dropped too: it describes the very queue already on screen.
				return next > state.revision
			}
			function keep(status, error) {
				if (state.decisions !== null) state.lastGood = state.decisions
				state.status = status
				state.error = error === undefined ? null : error
			}
			/** A list answer landed (generation-checked, revision-checked). */
			function succeed(token, decisions, revision) {
				if (!current(token)) return false
				if (!accepts(revision)) return false
				state.decisions = decisions
				if (Number.isFinite(revision)) state.revision = revision
				state.receivedAt = now()
				keep('ready', null)
				return true
			}
			/**
			 * Bootstrap ONLY: a /state (or action) snapshot fills an EMPTY domain. Once a
			 * queue exists the decisions cadence owns it, so a routine board poll can never
			 * overwrite a newer list answer.
			 */
			function seed(decisions, revision) {
				if (state.decisions !== null) return false
				state.decisions = Array.isArray(decisions) ? decisions : []
				if (Number.isFinite(revision)) state.revision = revision
				state.receivedAt = now()
				keep('ready', null)
				return true
			}
			function fail(token, error, status) {
				if (!current(token)) return false
				// The last good queue is kept: a blipped poll must not empty the modal.
				keep(typeof status === 'string' && status !== '' ? status : 'degraded', error)
				return true
			}
			/**
			 * One answered request. The answer's revision is the EXACT invalidation: the
			 * request leaves the queue now, and any list answer that started before the
			 * answer carries the older revision and is dropped instead of resurrecting it.
			 */
			function answered(decisionId, revision) {
				if (typeof decisionId === 'string' && decisionId !== '' && state.decisions !== null) {
					state.decisions = state.decisions.filter(function (entry) {
						return entry === null || entry === undefined || entry.id !== decisionId
					})
				}
				if (Number.isFinite(revision) && (state.revision === null || revision > state.revision)) state.revision = revision
				// The queue receipt is NOT moved here: the surviving decisions keep the
				// remainingMs values of the answer that produced them, and their countdown
				// must keep running from THAT receipt. Only seed()/succeed() re-measure it.
				if (state.decisions !== null) keep('ready', null)
				return true
			}
			function reset(scope) {
				state.generation += 1
				state.decisions = null
				state.revision = null
				state.status = 'idle'
				state.receivedAt = 0
				state.error = null
				state.lastGood = null
				state.scope = scope === undefined ? null : scope
			}
			function view() {
				return {
					decisions: state.decisions === null ? [] : state.decisions,
					revision: state.revision,
					status: state.status,
					error: state.error,
					receivedAt: state.receivedAt === 0 ? null : state.receivedAt,
					scope: state.scope,
				}
			}
			return {
				state: function () { return state },
				begin: begin,
				current: current,
				accepts: accepts,
				succeed: succeed,
				seed: seed,
				fail: fail,
				answered: answered,
				reset: reset,
				view: view,
			}
		}

		function createTaskStore(t, deps) {
			const {
				TC_STATE_URL,
				TC_WORKTREES_URL,
				TC_TASK_URL,
				TC_LIST_URL,
				TC_ACTION_URL,
				tcSnapshot,
				tcPinnedProject,
				tcMergeSnapshot,
				tcErrorMessage,
				tcWithSession,
				tcSessionId,
				tcPinProject,
			} = deps
			// T-233: the client half of the /meta TTL. The host answers /meta from a
			// 10 s cache; the client must not even ASK more often than that, and the
			// routine 2.5 s board poll no longer drags /meta with it.
			const META_STALE_MS = 10000
			// Tests can inject a clock (deps.tcNow); the bundle has no such dep and
			// falls back to the wall clock.
			const clock = typeof deps.tcNow === 'function' ? deps.tcNow : function () { return Date.now() }
			// T-233: the board / meta / detail domains. Decisions, activity and the
			// banner stay store-level state until Phase 3 gives them their own owners.
			const boardDomain = tcCreateDomainCache({ name: 'board', now: clock })
			const metaDomain = tcCreateDomainCache({ name: 'meta', now: clock, staleTime: META_STALE_MS })
			const detailDomain = tcCreateDetailCache({ now: clock })
			// The first paint shows the pinned project when there is one; with an empty
			// pin it shows nothing yet and the first /state answers with the project the
			// session resolves to (no path to type, T-90).
			let boardFallback = tcSnapshot({
				ok: false,
				project: tcPinnedProject(),
				dispatch: { state: 'paused' },
				tasks: [],
				counts: {},
			}, 'loading', '')
			// T-235: the pending queue has ONE owner — the decisions domain. The
			// snapshot's decisions / decisionRevision / decisionsReceivedAt are
			// projections of it, and a /state answer only BOOTSTRAPS it (see
			// seedDecisions); it never re-measures the queue.
			const decisionDomain = tcCreateDecisionCache({ name: 'decisions', now: clock })
			// T-198: the resolved decision policy (settings page). Carried exactly
			// like the decision queue: server-owned, never derived in the browser.
			let decisionPolicy = null
			// The local arrival time of the last accepted snapshot: the decision
			// countdown corrects the SERVER's remainingMs with this receipt time.
			let receivedAt = clock()
			// T-111: the Host answers the activity timeline incrementally. Keep what we
			// already have and ask only for events after the last one we saw.
			let activityCursor = null
			let activityLog = []
			// The host advertises the light/meta split on every answer
			// (payload.metadata.split). An older host that omits it is never asked
			// for /meta: the full /state it answered already carries everything.
			let metaSupported = false
			// { key, refresh, promise } — one metadata request per project.
			let metaFlight = null
			// { scope, promise } — one board request per pinned project.
			let boardFlight = null
			let timer = null
			let visibilityHandler = null
			const listeners = new Set()
			const detailFlights = new Map()
			// T-234: cards the host has confirmed are GONE (deleted here or answered
			// unknown-task). Their detail is neither rendered nor re-read, so a
			// deleted card cannot come back as a cached card. Project-scoped.
			const missingDetails = new Set()
			let busy = null
			// T-208: a decision answer is one-shot and two surfaces can submit it
			// (the panel's modal and the conversation-page overlay). One store backs
			// both, so these two guards are what stop a double submit: an answer in
			// flight refuses a second one, and an id whose answer already landed is
			// refused even after the response. A FAILED send clears both, so a
			// transport error can still be retried.
			const answeringDecisions = new Set()
			const answeredDecisions = new Set()
			let decisionsLoading = null
			// T-211: did the conversation-page overlay actually mount? The Host may
			// not offer the optional 'shell.overlay' slot (or the registration may
			// throw). The task-center header reads this to offer its own clickable
			// fallback only when the floating entry can never be there.
			let decisionOverlayMounted = false
			// T-233: the banner stays store-level (Phase 3 owns its domain). 'action'
			// is the user's last ACTION outcome (a routine poll keeps it), 'state' is
			// the board endpoint's own failure (the next good /state clears it), null
			// means there is nothing to keep.
			let message = ''
			let messageKind = null
			// Did the LAST board answer fail? A poll retry in flight must not turn the
			// error state back into a healthy one before its own answer lands.
			let boardFailed = false
			let actionResult = null
			let actionError = null
			// T-211: a hung decision-list request must not wedge the queue forever.
			// After this long the poll gives up, releases the single-flight guard and
			// the next tick starts a fresh request.
			const DECISION_LOAD_TIMEOUT_MS = 15000
			const DECISION_LOAD_TIMEOUT = { timedOut: true }
			// T-235: ONE decision-queue cadence for the whole plugin. The panel and the
			// shell overlay both register on it (ref-counted), so two mounted surfaces
			// still issue one decisionList per tick instead of each polling on its own.
			const DECISION_POLL_MS = 5000
			let decisionTimer = null
			let decisionRefs = 0
			// T-182: "no project is bound to this session" is the EXPECTED answer
			// before the first project is opened. It is a SETUP state, not a failure:
			// routing it into the error banner put "操作失败" over a panel that was
			// correctly asking the user to pick a project. Its text is carried by the
			// empty state (open-project entry) instead.
			const UNBOUND_CODE = 'no-project-bound'
			// /meta is derived from /state so the two halves can never point at
			// different routes (the bundle has no second constant to keep in sync).
			const TC_META_URL = TC_STATE_URL.replace(/\/state\/?$/, '/meta')

			/** The host's expected "nothing is bound" refusal ({ ok:false, code }). */
			function isUnbound(payload) {
				return payload !== null && typeof payload === 'object' && payload.ok !== true && payload.code === UNBOUND_CODE
			}

			/** Does this Host advertise the split (/state light + /meta deferred)? */
			function isMetaSplit(payload) {
				return (
					payload !== null &&
					typeof payload === 'object' &&
					payload.metadata !== null &&
					typeof payload.metadata === 'object' &&
					payload.metadata.split === true
				)
			}

			/** One project identity, however the two sides spell the path. */
			function projectKeyOf(value) {
				if (typeof value !== 'string' || value === '') return null
				const text = String(value).replace(/\\/g, '/').replace(/\/+$/, '')
				return /^[A-Za-z]:\//.test(text) ? text.toLowerCase() : text
			}

			/**
			 * T-235: is this a real project SWITCH, or the first answer that merely RESOLVES
			 * the session project (null -> '/repo')?
			 *
			 * The distinction matters for the decisions domain: the 5 s list poll can seed
			 * the queue before the first /state answer knows the project, and that very
			 * project is what the unpinned list request already described. Resetting there
			 * would blank a live queue for up to one cadence interval. A switch between two
			 * KNOWN projects (or into 'no project') still clears it.
			 */
			function projectSwitched(previous, next) {
				if (previous === next) return false
				return !(previous === null && next !== null)
			}

			/** The board data on screen (the domain, or the first-paint fallback). */
			function boardData() {
				const data = boardDomain.state().data
				return data === null ? boardFallback : data
			}

			/** The project the panel currently DESCRIBES, or null. */
			function currentProject() {
				const project = boardData().project
				return typeof project === 'string' && project !== '' ? project : null
			}

			/** Accumulate the Host's incremental activity page (cursor + dedupe by key). */
			function absorbActivity(events) {
				if (events === null || events === undefined || !Array.isArray(events.entries)) return
				const known = new Set(activityLog.map(function (entry) { return entry.key }))
				events.entries.forEach(function (entry) {
					if (entry !== null && typeof entry === 'object' && typeof entry.key === 'string' && !known.has(entry.key)) activityLog.push(entry)
				})
				activityLog.sort(function (left, right) { return new Date(right.at).getTime() - new Date(left.at).getTime() })
				activityLog = activityLog.slice(0, 100)
				if (typeof events.cursor === 'string' && events.cursor !== '') activityCursor = events.cursor
			}

			/** The { available, source, entries, ... } page the status view renders. */
			function activityEventPage() {
				return {
					available: true,
					source: 'board',
					entries: activityLog.slice(0, 50),
					count: Math.min(activityLog.length, 50),
					total: activityLog.length,
					truncated: false,
					cursor: activityCursor,
				}
			}

			/** The resolved decision POLICY a snapshot carries (deferred /meta owns it otherwise). */
			function absorbDecisionPolicy(source) {
				if (source !== null && source !== undefined && source.decisionPolicy !== undefined && source.decisionPolicy !== null) decisionPolicy = source.decisionPolicy
			}

			/**
			 * T-235: a /state (or action) snapshot may BOOTSTRAP the decisions domain —
			 * never overwrite it.
			 *
			 * The routine 2.5 s board poll used to write the queue directly, which is
			 * exactly how an older /state answer could repaint a newer decisionList
			 * answer. After the first queue the decisions cadence owns it; the revision the
			 * snapshot carries is recorded so the next compare is a real one.
			 */
			function seedDecisions(source) {
				if (source === null || source === undefined || !Array.isArray(source.decisions)) return false
				const revision = Number.isFinite(source.decisionRevision) ? source.decisionRevision : null
				return decisionDomain.seed(source.decisions, revision) === true
			}

			/**
			 * T-210/T-233: merge the last GOOD metadata answer onto the view.
			 *
			 * A light /state answer carries the board and the light scope; the heavy
			 * blocks come from the meta domain (or from an older Host's full answer).
			 * A full board rebuild drops the heavy fields, so this re-applies the
			 * cached ones instead of flashing them to null. The metadata domain is
			 * only ever applied to a snapshot of the SAME project.
			 */
			function applyMetaBlocks(next, meta) {
				if (meta.scope !== undefined && meta.scope !== null) next.scope = meta.scope
				if (meta.agentTree !== undefined && meta.agentTree !== null) next.agentTree = meta.agentTree
				if (meta.worktrees !== undefined && meta.worktrees !== null) next.worktrees = meta.worktrees
				if (meta.environment !== undefined) next.environment = meta.environment
				if (meta.roles !== undefined) next.roles = meta.roles
				if (meta.rolePreviews !== undefined) next.rolePreviews = meta.rolePreviews
				if (meta.decisionPolicy !== undefined && meta.decisionPolicy !== null) next.decisionPolicy = meta.decisionPolicy
				if (meta.archivedCount !== undefined && meta.archivedCount !== null) next.archivedCount = meta.archivedCount
				if (meta.archiveRange !== undefined && meta.archiveRange !== null) next.archiveRange = meta.archiveRange
				if (meta.nextStep !== undefined) next.nextStep = meta.nextStep
			}

			/** How the meta domain's status reads to the panel (idle/loading/ready/degraded). */
			function metaViewStatus(state) {
				if (state.status === 'ready' || state.status === 'stale') return state.data === null ? 'idle' : 'ready'
				if (state.status === 'loading') return 'loading'
				if (state.status === 'degraded' || state.status === 'error') return 'degraded'
				return 'idle'
			}

			/**
			 * T-233: compose the COMPATIBILITY snapshot the existing views consume.
			 *
			 * The domains are the source of truth; this facade only projects them into
			 * the one shape the pre-refactor views already read (tasks/scope/agentTree/
			 * metadata/details/...), so no view had to change in Phase 2A.
			 */
			function compose() {
				const boardState = boardDomain.state()
				const next = Object.assign({}, boardState.data === null ? boardFallback : boardState.data)
				// A FAILED board poll keeps the last good board (its tasks, project and
				// counts) and only reports the failure, instead of blanking the lanes.
				if (boardFailed) next.source = 'error'
				next.message = message
				next.busy = busy
				next.actionResult = actionResult
				next.actionError = actionError
				next.receivedAt = receivedAt
				// T-235 review: the queue, the revision it describes and the receipt of the
				// answer that produced its remainingMs values. BOTH decision surfaces read
				// exactly these three fields; the countdown MUST use decisionsReceivedAt,
				// never the board receipt (a /state answer does not re-measure the queue).
				const decisionView = decisionDomain.view()
				next.decisions = decisionView.decisions
				next.decisionRevision = decisionView.revision
				next.decisionsReceivedAt = decisionView.receivedAt
				next.decisionPolicy = decisionPolicy
				next.details = detailDomain.compose(next.tasks)
				const project = projectKeyOf(next.project)
				const metaState = metaDomain.state()
				const metaMatches = project !== null && metaState.scope !== null && metaState.scope === project
				next.metadata = metaMatches
					? {
						status: metaViewStatus(metaState),
						errors: metaState.error === null || metaState.error === undefined ? {} : metaState.error,
						receivedAt: metaState.receivedAt === 0 ? null : metaState.receivedAt,
					}
					: { status: 'idle', errors: {}, receivedAt: null }
				if (metaMatches && metaState.data !== null) applyMetaBlocks(next, metaState.data)
				if (activityLog.length > 0) next.activityEvents = activityEventPage()
				return next
			}

			let snapshot = compose()

			function emit() {
				snapshot = compose()
				listeners.forEach(function (listener) {
					listener()
				})
			}

			function setBusy(next) {
				if (busy === next) return
				busy = next
				emit()
			}

			/** Drop the metadata domain when the panel starts describing another project. */
			function resetMetaDomain(project) {
				metaDomain.reset(projectKeyOf(project))
			}

			/** Drop every card detail AND the ids confirmed gone (both are project-scoped). */
			function clearDetails() {
				detailDomain.clear()
				missingDetails.clear()
			}

			/**
			 * T-234: a card the host confirmed is GONE. Its detail is dropped (no
			 * lastGood may repaint it) and the id is remembered so the sidebar's poll
			 * stops asking for it. A project switch clears the record.
			 */
			function forgetDetail(id) {
				if (typeof id !== 'string' || id === '') return
				detailDomain.forget(id)
				missingDetails.add(id)
			}

			async function fetchJson(url, options) {
				const response = await fetch(url, options)
				return await response.json()
			}

			/**
			 * The /meta URL for the project the panel is SHOWING (not the pin alone:
			 * during an openProject the pin still names the OLD project while the board
			 * already shows the new one). refresh=1 forces the host to rebuild.
			 */
			function metaUrlFor(project, refresh) {
				let url = TC_META_URL + '?project=' + encodeURIComponent(project)
				if (refresh === true) url += '&refresh=1'
				if (activityCursor !== null) url += '&activitySince=' + encodeURIComponent(activityCursor)
				return tcWithSession(url)
			}

			/**
			 * T-233: load the DEFERRED metadata. Single flight PER PROJECT, never
			 * awaited by the board's render path.
			 *
			 * Two callers may reach the network on their own: the board's FIRST paint
			 * for a project (no answer on hand yet) and an explicit/forced refresh. A
			 * routine board poll never calls this, and the 10 s staleTime answers a
			 * duplicate request from the domain instead of asking the host again. A
			 * failure degrades only the deferred blocks: the board keeps rendering and
			 * the last good metadata stays merged.
			 *
			 * T-234: the sidebar tab is the third caller, through ensureAgents(). It
			 * polls one card, so its /meta asks are bounded by the same 10 s staleTime,
			 * by this single flight, and by one extra rule: a RECORDED failure is not
			 * retried from a tab at all (ensureAgents returns before this call), which
			 * keeps N open tabs from multiplying a dead endpoint. An explicit refresh
			 * or a write that reports 'meta' owns that retry.
			 */
			async function loadMeta(options) {
				const o = options === undefined || options === null ? {} : options
				if (metaSupported !== true) return null
				const project = currentProject()
				if (project === null) return null
				const key = projectKeyOf(project)
				const refresh = o.refresh === true
				// A request for ANOTHER project invalidates the cached answer and the
				// reported status BEFORE it lands: nothing of the old board may be shown
				// as the new board's metadata.
				if (metaDomain.state().scope !== key) resetMetaDomain(project)
				// A forced refresh is never satisfied by a routine in-flight request.
				if (metaFlight !== null && metaFlight.key === key && (refresh !== true || metaFlight.refresh === true)) return metaFlight.promise
				// T-233: the client-side TTL. Within the window a non-forced caller is
				// answered by the domain, so a remount cannot re-request 10 s early.
				if (refresh !== true && metaDomain.fresh()) return { ok: true, cached: true }
				const token = metaDomain.begin(key)
				emit()
				const request = (async function () {
					try {
						const payload = await fetchJson(metaUrlFor(project, refresh), { headers: { accept: 'application/json' } })
						// A NEWER request (or a project switch) owns the domain now: this
						// answer describes a board that is no longer on screen.
						if (!metaDomain.current(token)) return { ok: false, stale: true }
						if (payload === null || payload === undefined || payload.ok !== true) {
							const errors =
								payload !== null && payload !== undefined && payload.errors !== null && typeof payload.errors === 'object'
									? payload.errors
									: payload !== null && payload !== undefined && typeof payload.message === 'string' && payload.message !== ''
										? { message: payload.message }
										: {}
							metaDomain.fail(token, errors, 'degraded')
							emit()
							return { ok: false, payload: payload === undefined ? null : payload }
						}
						if (isMetaSplit(payload)) metaSupported = true
						const meta = payload.meta !== undefined && payload.meta !== null && typeof payload.meta === 'object' ? payload.meta : null
						absorbActivity(meta === null ? null : meta.activityEvents)
						const errors = payload.errors !== undefined && payload.errors !== null && typeof payload.errors === 'object' ? payload.errors : {}
						const degraded = Object.keys(errors).length > 0
						metaDomain.succeed(token, meta, degraded ? 'degraded' : 'ready', degraded ? errors : null)
						emit()
						return { ok: true, payload: payload }
					} catch (error) {
						// A transport failure is a DEGRADED metadata state, never a board error.
						if (!metaDomain.current(token)) return { ok: false, stale: true }
						metaDomain.fail(token, { message: String((error && error.message) || error) }, 'degraded')
						emit()
						return { ok: false, error: error }
					} finally {
						if (metaFlight !== null && metaFlight.promise === request) metaFlight = null
					}
				})()
				metaFlight = { key: key, refresh: refresh, promise: request }
				return request
			}

			/**
			 * T-233: does the board's first paint for this project still need /meta?
			 * Only a project whose metadata was never answered (or was reset by a
			 * switch) asks; a recorded failure waits for an explicit refresh, so a
			 * dead /meta cannot be retried on every 2.5 s poll.
			 */
			function maybeLoadMeta(project) {
				if (metaSupported !== true) return
				const key = projectKeyOf(project)
				if (key === null) return
				const state = metaDomain.state()
				// T-233 review: the FIRST paint seeds the domain with the project the
				// board answer names. A pinned project EQUALS the board project from the
				// very first snapshot, so load()'s project-change branch never runs and
				// the domain would otherwise stay unscoped (and never ask for /meta).
				if (state.scope !== key) resetMetaDomain(project)
				if (state.data !== null) return
				// A recorded failure (degraded) is retried only by an explicit refresh,
				// and an in-flight request already owns this project.
				if (state.status !== 'idle') return
				void loadMeta()
			}

			/**
			 * T-234: the agents half of the metadata domain (/meta -> meta.agentTree).
			 *
			 * A sidebar tab needs the LIVE agent tree, not the board. Asking the meta
			 * domain keeps the tab's 5 s cadence from becoming a request every 5 s: its
			 * own single flight and 10 s staleTime answer a duplicate call from the
			 * cache. A shell that never advertised the split has no /meta, so the tab
			 * falls back to the tree the board snapshot carries.
			 */
			async function ensureAgents() {
				if (metaSupported !== true) return null
				if (currentProject() === null) return null
				// T-234 review: the tab is a ROUTINE poller, so a /meta failure that is
				// already recorded is NOT retried here — same policy as maybeLoadMeta().
				// The panel's explicit refresh (or a write that reports 'meta') owns the
				// retry, and N open tabs cannot multiply a dead endpoint into a request
				// every 5/10 s. The last good tree stays rendered meanwhile.
				const state = metaDomain.state()
				if (state.status === 'degraded' || state.status === 'error') return null
				return loadMeta()
			}

			/**
			 * T-234: the agents block a view renders from — the last GOOD tree, never a
			 * fabricated one. No project, no answer yet or a project switch all read as
			 * an empty block, so the previous project's agents can never be replayed.
			 */
			function agentsView() {
				const state = metaDomain.state()
				const project = currentProject()
				const matches = project !== null && state.scope !== null && state.scope === projectKeyOf(project)
				const meta = matches && state.data !== null ? state.data : null
				return {
					agentTree: meta !== null && meta.agentTree !== undefined && meta.agentTree !== null ? meta.agentTree : null,
					status: matches ? metaViewStatus(state) : 'idle',
					error: matches && state.error !== null && state.error !== undefined ? state.error : null,
					receivedAt: matches && state.receivedAt !== 0 ? state.receivedAt : null,
				}
			}

			/**
			 * T-233: one board poll.
			 *
			 * /state?light=1 is the light first paint AND the routine poll. Requests
			 * are single-flight per pinned project, every request owns a generation
			 * (an older answer is discarded), and the board domain's lastGood survives
			 * a failed poll. options.refresh is the panel's explicit refresh: it
			 * bypasses the single-flight and forces the deferred metadata to rebuild.
			 */
			async function load(options) {
				const o = options === undefined || options === null ? {} : options
				const refresh = o.refresh === true
				// No pin means NO ?project=: the Host resolves the session workspace and
				// answers with the project, which is the whole point of T-90.
				const pinned = tcPinnedProject()
				const scope = pinned === null ? '__session__' : projectKeyOf(pinned)
				if (refresh !== true && boardFlight !== null && boardFlight.scope === scope) return boardFlight.promise
				const token = boardDomain.begin(scope)
				const request = (async function () {
					try {
						let url = pinned === null ? TC_STATE_URL : TC_STATE_URL + '?project=' + encodeURIComponent(pinned)
						// T-210: the light first paint. The heavy metadata (agent tree,
						// worktrees, environment, activity timeline, roles, decision policy,
						// archive) is the meta domain's own request, so this answer is never
						// held up by a host inventory.
						url += (url.indexOf('?') >= 0 ? '&' : '?') + 'light=1'
						const previous = boardData()
						if (previous.seq !== null && previous.seq !== undefined) url += '&since=' + String(previous.seq)
						url = tcWithSession(url)
						const payload = await fetchJson(url, { headers: { accept: 'application/json' } })
						// An answer whose generation was superseded (a project switch, an
						// action invalidation) describes a board that is not on screen.
						if (!boardDomain.current(token)) return { ok: false, stale: true }
						if (isUnbound(payload) === true) {
							// No project yet — the expected pre-setup answer. Keep project null so
							// the view renders its open-project entry points, say nothing, and
							// leave no message behind for the binding to inherit.
							// T-203: the setup snapshot NAMES its source. 'unbound' is not a
							// project: it is "this session resolves to nothing", so the panel
							// never shows a last-active project as if the session owned it.
							const unbound = tcSnapshot(Object.assign({}, payload, { ok: true, project: null, projectRoot: null, tasks: [], resolvedFrom: 'unbound', sessionProject: null }), 'setup', '')
							absorbDecisionPolicy(payload)
							// T-235: no project means no queue at all (nothing of the old one survives).
							decisionDomain.reset(null)
							receivedAt = clock()
							decisionPolicy = null
							message = ''
							messageKind = null
							boardFailed = false
							// T-210/T-233: no project means no metadata and no detail.
							resetMetaDomain(null)
							clearDetails()
							activityLog = []
							activityCursor = null
							boardDomain.succeed(token, unbound)
							emit()
							return { ok: true, payload: payload }
						}
						if (payload && payload.ok === true && (Array.isArray(payload.tasks) || payload.full === false)) {
							// The Host's answer is NOT written to localStorage: only an explicit
							// switch pins a project, so "follow the session" stays the default.
							const previousProject = projectKeyOf(previous.project)
							const next = tcMergeSnapshot(previous, payload)
							// A GOOD answer is a host answer, whatever the previous poll failed
							// with (a delta answer must not inherit the error source forever).
							next.source = 'host'
							const nextProject = projectKeyOf(next.project)
							receivedAt = clock()
							// T-111/T-210/T-233/T-235: a project switch starts a new activity log and
							// invalidates EVERY other domain (metadata, details and the decisions queue
							// all describe the OLD project now).
							if (nextProject !== previousProject) {
								activityLog = []
								activityCursor = null
								resetMetaDomain(next.project)
								clearDetails()
								// T-235 review: reset only on a REAL switch; null -> '/repo' is the
								// first answer resolving the session project the queue already describes.
								if (projectSwitched(previousProject, nextProject)) decisionDomain.reset(nextProject)
								// T-208: decision ids are project-scoped; an id answered in project A
								// must not block the same id in project B.
								answeredDecisions.clear()
							}
							absorbDecisionPolicy(payload)
							// Bootstrap only: a project switch cleared the domain, so the NEW board's
							// queue seeds it; a routine poll cannot overwrite a newer list answer.
							seedDecisions(payload)
							// An OLDER Host answers /state with the activity timeline itself; a
							// split Host sends it from /meta (absorbed in loadMeta).
							if (payload.activityEvents !== undefined && payload.activityEvents !== null) absorbActivity(payload.activityEvents)
							if (isMetaSplit(payload)) metaSupported = true
							// A routine poll keeps the user's last ACTION outcome (only the board
							// data refreshes), but the transport's own text stops being true the
							// moment /state answers again: clear it, so neither the unbound notice
							// nor a real failure outlives the binding that fixes it.
							if (messageKind !== 'action') {
								message = ''
								messageKind = null
							}
							boardFailed = false
							boardDomain.succeed(token, next)
							emit()
							// T-233: the FIRST paint of a project asks for the deferred half; an
							// explicit refresh forces the host to rebuild it. A routine poll
							// never asks for /meta again.
							if (refresh === true) void loadMeta({ refresh: true })
							else maybeLoadMeta(next.project)
							return { ok: true, payload: payload }
						}
						// A real /state failure: keep the last good board (tasks, project,
						// counts) and report the failure on top of it.
						messageKind = 'state'
						message = tcErrorMessage(payload, t)
						boardFailed = true
						boardDomain.fail(token, payload === undefined ? null : payload, 'error')
						if (boardDomain.state().data === null) boardFallback = tcSnapshot(Object.assign({}, payload, { tasks: [] }), 'error', message)
						emit()
						return { ok: false, payload: payload === undefined ? null : payload }
					} catch (error) {
						if (boardDomain.current(token)) {
							messageKind = 'state'
							message = String((error && error.message) || error)
							boardFailed = true
							boardDomain.fail(token, error, 'error')
							if (boardDomain.state().data === null) boardFallback = tcSnapshot(Object.assign({}, boardFallback, { tasks: [] }), 'error', message)
							emit()
						}
						return { ok: false, error: error }
					} finally {
						if (boardFlight !== null && boardFlight.promise === request) boardFlight = null
					}
				})()
				boardFlight = { scope: scope, promise: request }
				return request
			}

			/**
			 * T-234 review: which cards a WRITE removed from the board, when its
			 * answer names them.
			 *
			 * A plain delete names the card itself; a DELETE-gated decision can purge a
			 * whole dependency tree and lists every removed id in its applied summary.
			 * Any other write is an UPDATE, whose affected ids must stay cached-but-stale
			 * (the next read refreshes them) — clearing those would blank a live card.
			 */
			function deletedIdsOf(action, applied, affectedIds) {
				const ids = []
				const push = function (id) {
					if (typeof id === 'string' && id !== '' && ids.indexOf(id) < 0) ids.push(id)
				}
				if (action === 'delete') {
					affectedIds.forEach(push)
					return ids
				}
				if (applied === null || applied === undefined || applied.executed !== true || applied.ok === false) return ids
				const summary = applied.summary !== null && applied.summary !== undefined && typeof applied.summary === 'object' ? applied.summary : null
				if (summary !== null && Array.isArray(summary.deleted)) {
					summary.deleted.forEach(push)
					return ids
				}
				// A single-card delete decision answers { summary: { taskId, deleted: true } }.
				if (applied.action === 'delete' && summary !== null && summary.deleted === true) push(summary.taskId)
				return ids
			}

			/**
			 * Send one action. options.quiet marks an AUTOMATIC call (the prompt
			 * preview): it may refresh data, but it never enters the
			 * action-result channel, so an automatic request can neither fake nor
			 * clear the banner of the user's last real action.
			 */
			async function send(action, body, options) {
				const opts = options === undefined || options === null ? {} : options
				const quiet = opts.quiet === true
				// T-208: serialize decision answers per request id. The panel modal and
				// the shell overlay both call this store; whichever submits second gets
				// a duplicate result instead of a second POST.
				const decisionId =
					action === 'decisionAnswer' && body !== undefined && body !== null && typeof body.decisionId === 'string' && body.decisionId !== ''
						? body.decisionId
						: null
				if (decisionId !== null) {
					if (answeredDecisions.has(decisionId)) return { ok: false, duplicate: true, payload: { ok: false, code: 'already-answered' } }
					if (answeringDecisions.has(decisionId)) return { ok: false, duplicate: true, payload: { ok: false, code: 'answer-in-flight' } }
					answeringDecisions.add(decisionId)
				}
				const payloadBody = Object.assign({ action: action }, body === undefined ? {} : body)
				payloadBody.session = tcSessionId()
				const project = tcPinnedProject()
				if (project !== null) payloadBody.project = project
				const token = { action: action, id: body !== undefined && body !== null && (body.id !== undefined ? body.id : body.requestId !== undefined ? body.requestId : body.taskId !== undefined ? body.taskId : body.path !== undefined ? body.path : null) }
				setBusy(token)
				try {
					const payload = await fetchJson(tcWithSession(TC_ACTION_URL), {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify(payloadBody),
					})
					if (payload && payload.ok === true) {
						// T-231: a WRITE answers { ok, seq, affected, changed } and no board;
						// an openProject (or an explicit includeSnapshot caller, or an older
						// host) still carries a light snapshot. Both are handled here.
						const host = payload.snapshot !== undefined && payload.snapshot !== null ? payload.snapshot : payload
						const changed = Array.isArray(payload.changed) ? payload.changed : null
						const affected = payload.affected !== null && typeof payload.affected === 'object' ? payload.affected : null
						const affectedIds = affected !== null && Array.isArray(affected.ids) ? affected.ids : []
						// T-196 review: the ANSWER landed but the host action it stood for
						// failed (the board moved on, the card is not deletable, ...). The
						// modal disappears with the decision, so the SAME banner a failed
						// action uses must explain that nothing happened. An intentional
						// 取消创建 is not a failure.
						const applied = payload.applied !== undefined && payload.applied !== null && typeof payload.applied === 'object' ? payload.applied : null
						const appliedFailed = applied !== null && applied.ok === false && applied.code !== 'decision-rejected'
						const previousProject = projectKeyOf(boardData().project)
						if (host !== null && host !== undefined && Array.isArray(host.tasks)) {
							const next = tcSnapshot(host, 'host', '', payload)
							const nextProject = projectKeyOf(next.project)
							const boardToken = boardDomain.begin(nextProject === null ? '__session__' : nextProject)
							// T-235: a snapshot action (openProject) answer is a fresh receipt.
							receivedAt = clock()
							boardFailed = false
							if (quiet) {
								// An automatic call never touches the user's banner or channel.
							} else if (appliedFailed) {
								messageKind = 'action'
								message = typeof applied.message === 'string' && applied.message !== '' ? applied.message : t('decisionAppliedFailed')
								actionResult = null
								actionError = applied
							} else {
								// A real action answered: whatever the banner said is no longer current.
								messageKind = null
								message = ''
								actionResult = payload
								actionError = null
							}
							if (decisionId !== null) {
								answeredDecisions.add(decisionId)
								// T-235: the answer's revision drops exactly that request from the shared
								// queue (the snapshot above is already post-answer on a T-231 host).
								decisionDomain.answered(decisionId, Number.isFinite(payload.decisionRevision) ? payload.decisionRevision : null)
							}
							// An action's answer (or openProject's full snapshot) also advertises
							// the split; learn it here so a panel that bound a project before its
							// first poll still asks for the deferred half.
							if (isMetaSplit(host) || isMetaSplit(payload)) metaSupported = true
							// T-210 review/T-233: the answer may describe ANOTHER project
							// (openProject). NOTHING of the old board may survive onto it.
							if (nextProject !== previousProject) {
								activityLog = []
								activityCursor = null
								resetMetaDomain(next.project)
								clearDetails()
								// T-235: decision ids are project-scoped, so a real switch drops the
								// queue (a first resolution of the session project does not).
								if (projectSwitched(previousProject, nextProject)) decisionDomain.reset(nextProject)
								answeredDecisions.clear()
							}
							absorbDecisionPolicy(host)
							// The switch cleared the domain: the NEW project's snapshot seeds its queue.
							seedDecisions(host)
							boardDomain.succeed(boardToken, next)
							emit()
							// switchProject() asks for the new project's metadata itself, right
							// after it pins the project: asking here would be a wasted request.
							if (action !== 'openProject') {
								if (changed === null) void loadMeta(quiet ? undefined : { refresh: true })
								else if (changed.indexOf('meta') >= 0) void loadMeta({ refresh: true })
							}
						} else if (changed !== null) {
							// T-231 write envelope. T-233: invalidate only the domains the host
							// says changed, then let that domain's own cadence refetch.
							if (!quiet) {
								if (appliedFailed) {
									messageKind = 'action'
									message = typeof applied.message === 'string' && applied.message !== '' ? applied.message : t('decisionAppliedFailed')
									actionResult = null
									actionError = applied
								} else {
									messageKind = null
									message = ''
									actionResult = payload
									actionError = null
								}
							}
							if (decisionId !== null) {
								answeredDecisions.add(decisionId)
								// T-235: the answer's revision drops EXACTLY this request from the shared
								// queue, so both surfaces advance at once. No full queue refresh follows:
								// a list answer that started before the answer carries the older revision
								// and loses the compare instead of resurrecting the request.
								decisionDomain.answered(decisionId, Number.isFinite(payload.decisionRevision) ? payload.decisionRevision : null)
								receivedAt = clock()
							}
							emit()
							if (changed.indexOf('board') >= 0) {
								boardDomain.invalidate()
								// The in-flight pre-action poll would answer with the OLD board;
								// abandon it (its generation no longer matches) and read now.
								boardFlight = null
								void load()
							}
							if (changed.indexOf('meta') >= 0) {
								metaDomain.invalidate()
								void loadMeta({ refresh: true })
							}
							if (changed.indexOf('detail') >= 0) {
								// T-234 review: a delete is not an invalidate. The removed cards are
								// dropped (never lastGood again) and their ids are not polled, while
								// the ids an UPDATE touched stay cached-but-stale for the next read.
								const removed = deletedIdsOf(action, applied, affectedIds)
								if (removed.length === 0) {
									detailDomain.invalidate(affectedIds)
								} else {
									const rest = affectedIds.filter(function (id) { return removed.indexOf(id) < 0 })
									if (rest.length > 0) detailDomain.invalidate(rest)
									removed.forEach(forgetDetail)
									emit()
								}
							}
						} else if (decisionId !== null) {
							// T-208/T-235: a host answer with neither a snapshot nor a changed list.
							// Drop the answered request (and apply its revision) right away anyway.
							answeredDecisions.add(decisionId)
							decisionDomain.answered(decisionId, Number.isFinite(payload.decisionRevision) ? payload.decisionRevision : null)
							receivedAt = clock()
							emit()
						}
						return { ok: true, payload: payload }
					}
					if (!quiet) {
						if (isUnbound(payload) === true) {
							// The action was refused because no project is bound yet: the same
							// setup state /state reports, not a failed operation.
							messageKind = null
							message = ''
							actionResult = null
							actionError = null
							const setup = Object.assign({}, boardData(), { source: 'setup' })
							const setupToken = boardDomain.begin(boardDomain.state().scope)
							boardDomain.succeed(setupToken, setup)
							emit()
						} else {
							messageKind = 'action'
							message = tcErrorMessage(payload, t)
							actionResult = null
							actionError = payload === undefined || payload === null ? null : payload
							emit()
						}
					}
					return { ok: false, payload: payload }
				} catch (error) {
					if (!quiet) {
						// A failed action is still an ACTION outcome: it survives polls like any
						// other, instead of being cleared by the next good /state.
						messageKind = 'action'
						message = String((error && error.message) || error)
						emit()
					}
					return { ok: false, error: error }
				} finally {
					if (decisionId !== null) answeringDecisions.delete(decisionId)
					if (busy === token) setBusy(null)
				}
			}

			/**
			 * T-208/T-235: refresh ONLY the pending decision queue, through the decisions
			 * domain.
			 *
			 * BOTH surfaces (the panel modal and the conversation-page overlay) call this
			 * through the store's ONE 5 s cadence, and the single flight below collapses
			 * whatever still overlaps into a single decisionList request. It reads and
			 * writes no other domain and never enters the action-result channel.
			 *
			 * The answer's decisionRevision decides whether it lands: an older (or equal)
			 * revision than the queue on screen is discarded, so a slow answer cannot
			 * repaint a newer queue. A failure keeps the last good queue (degraded).
			 */
			async function loadDecisions(options) {
				// T-211: SINGLE FLIGHT per queue refresh. Every surface shares this promise
				// instead of racing N decisionList requests, and a hung one cannot block the
				// next tick: the optional timeout releases the guard in finally.
				if (decisionsLoading !== null) return decisionsLoading
				const opts = options === undefined || options === null ? {} : options
				const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : DECISION_LOAD_TIMEOUT_MS
				const project = tcPinnedProject()
				const token = decisionDomain.begin(project === null ? '__session__' : projectKeyOf(project))
				decisionsLoading = (async function () {
					let timer = null
					try {
						const body = { action: 'decisionList', decisionStatus: 'pending', session: tcSessionId() }
						if (project !== null) body.project = project
						const request = fetchJson(tcWithSession(TC_ACTION_URL), {
							method: 'POST',
							headers: { 'content-type': 'application/json' },
							body: JSON.stringify(body),
						})
						let timeout = null
						if (typeof setTimeout === 'function') {
							timeout = new Promise(function (resolve) {
								timer = setTimeout(function () { resolve(DECISION_LOAD_TIMEOUT) }, timeoutMs)
							})
							// The race may settle on the timeout first; the late request must
							// not surface as an unhandled rejection.
							request.catch(function () {})
						}
						const payload = timeout === null ? await request : await Promise.race([request, timeout])
						// A reset (project switch) or a newer request owns the domain now.
						if (!decisionDomain.current(token)) return { ok: false, stale: true, payload: null }
						if (payload === DECISION_LOAD_TIMEOUT) {
							decisionDomain.fail(token, { message: 'the decision list timed out' }, 'degraded')
							emit()
							return { ok: false, timedOut: true, payload: null }
						}
						if (payload !== null && payload !== undefined && payload.ok === true && Array.isArray(payload.decisions)) {
							const revision = Number.isFinite(payload.decisionRevision) ? payload.decisionRevision : null
							// The queue carries its own receipt time for the countdown; every
							// other domain stays exactly as it is.
							const landed = decisionDomain.succeed(token, payload.decisions, revision)
							if (landed === true) receivedAt = clock()
							emit()
							if (landed !== true) return { ok: false, stale: true, revision: revision, decisions: payload.decisions }
							return { ok: true, decisions: payload.decisions, revision: revision }
						}
						decisionDomain.fail(token, payload === undefined ? null : payload, 'degraded')
						emit()
						return { ok: false, payload: payload === undefined ? null : payload }
					} catch (error) {
						// A failed refresh keeps the last good queue: the modal must not vanish.
						if (decisionDomain.current(token)) {
							decisionDomain.fail(token, error, 'degraded')
							emit()
						}
						return { ok: false, error: error }
					} finally {
						if (timer !== null && typeof clearTimeout === 'function') clearTimeout(timer)
						decisionsLoading = null
					}
				})()
				return decisionsLoading
			}

			/**
			 * T-211: the conversation-page overlay marks itself when it renders, so
			 * the panel header knows whether 'shell.overlay' really produced an
			 * entry. A missing slot never calls this, which is exactly the fallback
			 * condition.
			 */
			function markDecisionOverlayMounted() {
				decisionOverlayMounted = true
			}

			/** Is the shell overlay entry available in this Host shell? */
			function decisionOverlayAvailable() {
				return decisionOverlayMounted === true
			}

			/** One page of the server-side completed list (T-82 /list route). */
			async function listTasks(query) {
				const opts = query === undefined || query === null ? {} : query
				const params = []
				const project = tcPinnedProject()
				if (project !== null) params.push('project=' + encodeURIComponent(project))
				params.push('status=' + encodeURIComponent(opts.status === undefined ? 'done' : String(opts.status)))
				if (opts.archived === true) params.push('archived=1')
				if (typeof opts.q === 'string' && opts.q !== '') params.push('q=' + encodeURIComponent(opts.q))
				if (typeof opts.cursor === 'string' && opts.cursor !== '') params.push('cursor=' + encodeURIComponent(opts.cursor))
				params.push('limit=' + String(Number.isFinite(opts.limit) ? opts.limit : 50))
				try {
					// /list and /task need the same session identity as /state: the Host
					// only reads the requesting session's binding, so without it "follow
					// the session" would show an empty done/archive list forever.
					const listUrl = tcWithSession(TC_LIST_URL + '?' + params.join('&'))
					const payload = await fetchJson(listUrl, { headers: { accept: 'application/json' } })
					return payload === null || payload === undefined ? { ok: false, tasks: [], nextCursor: null } : payload
				} catch (error) {
					return { ok: false, tasks: [], nextCursor: null }
				}
			}

			/** The board summary of one card, or undefined (not on the board / no board). */
			function summaryOf(id) {
				const summaries = boardData().tasks
				return Array.isArray(summaries) ? summaries.filter(function (task) { return task !== null && task !== undefined && task.id === id })[0] : undefined
			}

			/** One /task request for a card: single flight per card, generation-safe. */
			function requestDetail(id, summary) {
				if (detailFlights.has(id)) return detailFlights.get(id)
				const token = detailDomain.begin(id, summary === undefined || summary === null ? null : summary.updatedAt)
				const request = (async function () {
					try {
						const project = tcPinnedProject()
						const url = tcWithSession(TC_TASK_URL + '?id=' + encodeURIComponent(id) + (project === null ? '' : '&project=' + encodeURIComponent(project)))
						const payload = await fetchJson(url, { headers: { accept: 'application/json' } })
						if (payload && payload.ok === true && payload.task !== undefined && payload.task !== null) {
							if (detailDomain.succeed(token, payload.task)) {
								missingDetails.delete(id)
								emit()
							}
						} else if (payload !== null && payload !== undefined && payload.ok !== true && payload.code === 'unknown-task') {
							// T-234 review: the host says this card no longer exists. Keeping it
							// as lastGood (and re-reading it every 5 s) would paint a deleted card
							// forever, so it is forgotten and its polling stops here.
							forgetDetail(id)
							emit()
						} else {
							detailDomain.fail(token, payload === undefined ? null : payload)
						}
						return payload
					} catch (error) {
						detailDomain.fail(token, error)
						return { ok: false, error: String((error && error.message) || error) }
					} finally {
						if (detailFlights.get(id) === request) detailFlights.delete(id)
					}
				})()
				detailFlights.set(id, request)
				return request
			}

			/**
			 * T-233: fetch one card's full detail on demand (drawer/form open).
			 *
			 * The detail domain caches per card and keyed by the summary's updatedAt:
			 * a poll that did not change the card never refetches, a changed card does.
			 * A failed /task keeps the last good detail; it never blanks the card. Only a
			 * card the board already shows is read here — the sidebar tab uses
			 * ensureTaskDetail(), which does not need the summary.
			 */
			async function loadDetail(id) {
				if (typeof id !== 'string' || id === '') return null
				const summary = summaryOf(id)
				if (summary === undefined) return null
				if (detailDomain.needs(id, summary) !== true) return null
				return requestDetail(id, summary)
			}

			/**
			 * T-234: the sidebar tab's unit of work — ONE card's detail read.
			 *
			 * This is a POLLER, so every call reads: the tab can be mounted while
			 * nothing polls the board at all (the user is on the agent's conversation),
			 * and a summary that never moves would otherwise gate out the very change
			 * the tab exists to show. The per-card single flight still collapses a tick
			 * that overlaps an in-flight read, and the summary, when there is one, is
			 * recorded on the entry so loadDetail()/compose() can compare it. A failed
			 * /task keeps the last good answer; a project switch clears it.
			 */
			async function ensureTaskDetail(id) {
				const key = typeof id === 'string' ? id.trim() : ''
				if (key === '') return null
				// A confirmed-gone card is not polled again (the id stays project-scoped).
				if (missingDetails.has(key)) return null
				return requestDetail(key, summaryOf(key))
			}

			/**
			 * T-234: has the host confirmed this card is GONE (deleted here, or the
			 * detail read answered unknown-task)? A view must not render it from a
			 * stale board copy; a project switch forgets the record.
			 */
			function isTaskGone(id) {
				const key = typeof id === 'string' ? id.trim() : ''
				return key !== '' && missingDetails.has(key)
			}

			/**
			 * T-234: the card's detail as a view reads it — the last GOOD answer (a
			 * failed refresh keeps it), the request status, and never a fabricated
			 * card. A project switch clears the domain, so this is empty again.
			 */
			function getTaskDetail(id) {
				const key = typeof id === 'string' ? id.trim() : ''
				if (key === '') return null
				// A card the host confirmed is gone is never handed back as lastGood.
				if (missingDetails.has(key)) return null
				const entry = detailDomain.stateOf(key)
				if (entry === null) return null
				const summary = summaryOf(key)
				const summaryUpdatedAt = summary === undefined || summary === null || summary.updatedAt === undefined ? null : summary.updatedAt
				// T-234 review: the board summary has ALREADY moved past this detail (a
				// write invalidated the domain). Letting the older card drive the stage
				// rows would offer a delivered reviewer/tester the board no longer names,
				// so the view gets no card and renders the summary until the next read
				// lands (the tab re-reads within its 5 s cadence).
				if (summary !== undefined && entry.data !== null && entry.data.updatedAt !== summaryUpdatedAt) {
					return {
						id: key,
						task: null,
						status: 'stale',
						error: entry.error === undefined ? null : entry.error,
						receivedAt: entry.receivedAt,
					}
				}
				return {
					id: key,
					task: entry.data === null ? null : entry.data.task,
					status: entry.status,
					error: entry.error === undefined ? null : entry.error,
					receivedAt: entry.receivedAt,
				}
			}

			/**
			 * Switch the panel's project (T-90). "Write is bind": the browser pin and
			 * the HOST binding move together — the pin alone would leave the panel on
			 * A while the scheduler keeps driving B. openProject proves the directory
			 * (and, since T-86, writes the project registry), so a failed switch pins
			 * nothing.
			 */
			async function switchProject(path, options) {
				const next = typeof path === 'string' ? path.trim() : ''
				if (next === '') return { ok: false, payload: { ok: false, code: 'missing-path' } }
				const opts = options === undefined || options === null ? {} : options
				// T-155: an AUTOMATIC workspace follow is quiet — it must not raise the
				// global action banner; the workspace scope bar carries its own error.
				const result = await send('openProject', { path: next }, opts.quiet === true ? { quiet: true } : undefined)
				if (result.ok !== true) return result
				tcPinProject(next)
				// T-208: decision ids are project-scoped (see load()).
				answeredDecisions.clear()
				// Binding ANSWERS the setup state, so the banner goes away with the project
				// it asked for. An AUTOMATIC follow (quiet) must not clear the user's last
				// real action outcome — that is the quiet contract.
				const explicit = opts.quiet !== true
				if (explicit) {
					message = ''
					messageKind = null
				}
				const current = boardData()
				const key = projectKeyOf(next)
				const switched = projectKeyOf(current.project) !== key
				const bound = Object.assign({}, current, {
					project: next,
					projectRoot: next,
					resolvedFrom: 'panel',
					source: current.source === 'setup' || current.source === 'error' ? 'host' : current.source,
				})
				const boardToken = boardDomain.begin(key)
				boardDomain.succeed(boardToken, bound)
				boardFailed = false
				// T-233: a project SWITCH invalidates EVERY domain: metadata, per-card
				// details and the activity timeline all describe the old board. Re-opening
				// the project already on screen keeps them (an explicit refresh of the
				// deferred half still follows below).
				if (switched) {
					resetMetaDomain(next)
					clearDetails()
					// T-235: a host that echoed no snapshot leaves the OLD project's queue
					// behind; the new project's own answers seed the domain again.
					decisionDomain.reset(key)
					activityLog = []
					activityCursor = null
				}
				emit()
				void loadMeta()
				return result
			}

			/**
			 * T-146: lazy dirty/merged probe. /state only carries the worktree
			 * inventory; the status card asks this endpoint for the checkouts it
			 * actually shows (one request, no snapshot attached).
			 */
			async function loadWorktrees(paths) {
				const params = []
				const pinned = tcPinnedProject()
				if (pinned !== null) params.push('project=' + encodeURIComponent(pinned))
				if (Array.isArray(paths)) {
					paths.forEach(function (path) {
						if (typeof path === 'string' && path !== '') params.push('path=' + encodeURIComponent(path))
					})
				}
				const url = tcWithSession(TC_WORKTREES_URL + (params.length === 0 ? '' : '?' + params.join('&')))
				try {
					const payload = await fetchJson(url, { headers: { accept: 'application/json' } })
					return payload === null || payload === undefined ? { ok: false } : payload
				} catch (error) {
					return { ok: false, error: String((error && error.message) || error) }
				}
			}

			/** Is the page hidden? A hidden tab stops polling instead of spending requests. */
			function pageHidden() {
				try {
					return typeof document !== 'undefined' && document !== null && document.visibilityState === 'hidden'
				} catch (error) {
					return false
				}
			}

			/** One visibility listener serves BOTH pollers (the board and the queue). */
			function ensureVisibilityHandler() {
				if (typeof document === 'undefined' || document === null || typeof document.addEventListener !== 'function') return
				if (visibilityHandler !== null) return
				visibilityHandler = function () {
					if (pageHidden()) return
					if (timer !== null) void load()
					if (decisionTimer !== null) void loadDecisions()
				}
				document.addEventListener('visibilitychange', visibilityHandler)
			}

			function releaseVisibilityHandler() {
				// The listener stays only while at least one poller still needs it.
				if (timer !== null || decisionTimer !== null) return
				if (visibilityHandler !== null && typeof document !== 'undefined' && document !== null && typeof document.removeEventListener === 'function') {
					document.removeEventListener('visibilitychange', visibilityHandler)
				}
				visibilityHandler = null
			}

			/**
			 * T-235: register a surface that needs the pending queue kept fresh. The panel
			 * (through startPolling) and the shell overlay both call this; the timer is
			 * started by the FIRST caller, kept alive by the others and stopped by the last
			 * one leaving, so two mounted surfaces never run two decisionList cadences.
			 */
			function startDecisionsPolling(ms) {
				decisionRefs += 1
				const interval = Number.isFinite(ms) && ms > 0 ? ms : DECISION_POLL_MS
				if (decisionTimer === null) {
					// The first paint asks at once; the interval then keeps it fresh.
					void loadDecisions()
					if (typeof setInterval === 'function') {
						decisionTimer = setInterval(function () {
							// T-233 / T-227: a hidden tab costs nothing and catches up on return.
							if (pageHidden()) return
							void loadDecisions()
						}, interval)
					}
					ensureVisibilityHandler()
				}
				return decisionRefs
			}

			/** Release one surface; the cadence stops with the LAST one. */
			function stopDecisionsPolling() {
				if (decisionRefs > 0) decisionRefs -= 1
				if (decisionRefs > 0) return decisionRefs
				if (decisionTimer !== null && typeof clearInterval === 'function') clearInterval(decisionTimer)
				decisionTimer = null
				releaseVisibilityHandler()
				return 0
			}

			function startPolling(ms) {
				if (timer !== null) return
				timer = setInterval(function () {
					// T-233 / T-227: the 2.5 s board poll runs only while the page is
					// visible; a hidden tab costs nothing and catches up on return.
					if (pageHidden()) return
					void load()
				}, ms)
				// T-235: a panel that polls the board also owns the pending-decision cadence
				// (a /state answer only bootstraps the queue now).
				startDecisionsPolling()
				ensureVisibilityHandler()
			}

			function stopPolling() {
				if (timer === null) return
				clearInterval(timer)
				timer = null
				stopDecisionsPolling()
				releaseVisibilityHandler()
			}

			return {
				subscribe(listener) {
					listeners.add(listener)
					return function () {
						listeners.delete(listener)
					}
				},
				getSnapshot() {
					return snapshot
				},
				// T-233: the query-cache domains (Phase 2B migrates views onto these
				// selectors instead of the compatibility snapshot).
				// T-235: `decisions` is the ONE owner of the pending queue: both decision
				// surfaces read it through the compatibility snapshot.
				domains: {
					board: boardDomain,
					meta: metaDomain,
					detail: detailDomain,
					decisions: decisionDomain,
				},
				META_STALE_MS: META_STALE_MS,
				load: load,
				loadMeta: loadMeta,
				loadDecisions: loadDecisions,
				// T-235: the ONE shared decision cadence (ref-counted by surface).
				startDecisionsPolling: startDecisionsPolling,
				stopDecisionsPolling: stopDecisionsPolling,
				DECISION_POLL_MS: DECISION_POLL_MS,
				// T-211: overlay presence, so the panel header can fall back when the
				// Host shell has no 'shell.overlay' slot.
				markDecisionOverlayMounted: markDecisionOverlayMounted,
				decisionOverlayAvailable: decisionOverlayAvailable,
				DECISION_LOAD_TIMEOUT_MS: DECISION_LOAD_TIMEOUT_MS,
				send: send,
				loadWorktrees: loadWorktrees,
				switchProject: switchProject,
				listTasks: listTasks,
				loadDetail: loadDetail,
				// T-234: the per-card detail and the agents block, so the sidebar tab reads
				// (and polls) ONE card instead of the whole board.
				ensureTaskDetail: ensureTaskDetail,
				getTaskDetail: getTaskDetail,
				isTaskGone: isTaskGone,
				ensureAgents: ensureAgents,
				agentsView: agentsView,
				startPolling: startPolling,
				stopPolling: stopPolling,
			}
		}

		module.exports = { createTaskStore }
