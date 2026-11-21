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
			// The first paint shows the pinned project when there is one; with an empty
			// pin it shows nothing yet and the first /state answers with the project the
			// session resolves to (no path to type, T-90).
			let snapshot = tcSnapshot({
				ok: false,
				project: tcPinnedProject(),
				dispatch: { state: 'paused' },
				tasks: [],
				counts: {},
			}, 'loading', '')
			// T-195: the host's pending decisions and the local arrival time of the
			// snapshot they came with. The modal counts down from the SERVER's
			// remainingMs, corrected by this receipt time.
			snapshot.decisions = []
			// T-198: the resolved decision policy (settings page). Carried exactly
			// like the decision queue: server-owned, never derived in the browser.
			snapshot.decisionPolicy = null
			snapshot.receivedAt = Date.now()
			// T-111: the Host answers the activity timeline incrementally. Keep what we
			// already have and ask only for events after the last one we saw.
			let activityCursor = null
			let activityLog = []
			// T-210: the deferred metadata (agent tree, worktrees, environment, the
			// activity timeline, roles, decision policy, archive) is its own request.
			// `light=1` /state answers with the board AND the light session scope, so
			// the cards and the header are ready immediately; the metadata is merged
			// in when it arrives and NEVER blocks the board or the ready state.
			//
			// /meta is derived from /state so the two halves can never point at
			// different routes (the bundle has no second constant to keep in sync).
			const TC_META_URL = TC_STATE_URL.replace(/\/state\/?$/, '/meta')
			// The host advertises the split on every answer (`metadata.split`). An
			// older host that omits it is never asked for /meta: the full /state it
			// answered already carries everything.
			let metaSupported = false
			let metaCache = null
			let metaErrors = {}
			// idle | loading | ready | degraded — the view reports it as
			// data-metadata-state so 'header ready' never means 'inventory done'.
			let metaStatus = 'idle'
			let metaAt = 0
			// The project the cached answer DESCRIBES. A metadata answer is only ever
			// merged onto a snapshot of the same project (a project switch must never
			// paint project A's agent tree onto project B's board).
			let metaProject = null
			// { key, refresh, promise } — one metadata request per project.
			let metaFlight = null
			// The newest metadata request owns the snapshot; an older answer is
			// discarded instead of overwriting it.
			let metaSeq = 0
			const listeners = new Set()
			let loading = null
			let timer = null
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
			// T-182: "no project is bound to this session" is the EXPECTED answer
			// before the first project is opened. It is a SETUP state, not a failure:
			// routing it into the error banner put "操作失败" over a panel that was
			// correctly asking the user to pick a project. Its text is carried by the
			// empty state (open-project entry) instead.
			const UNBOUND_CODE = 'no-project-bound'
			// Where the current banner text came from, so the next poll knows whether
			// it may drop it: 'action' is the user's last action outcome (a routine
			// poll keeps it), 'state' is this endpoint's own failure (the next good
			// /state clears it), null means there is nothing to keep.
			let messageKind = null

			/** The host's expected "nothing is bound" refusal ({ ok:false, code }). */
			function isUnbound(payload) {
				return payload !== null && typeof payload === 'object' && payload.ok !== true && payload.code === UNBOUND_CODE
			}

			function emit(next) {
				snapshot = applyMetadata(Object.assign({}, next, { busy: busy }))
				listeners.forEach(function (listener) {
					listener()
				})
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

			function setBusy(next) {
				if (busy === next) return
				busy = next
				emit(snapshot)
			}

			/**
			 * T-210: merge the last GOOD metadata answer onto a snapshot.
			 *
			 * A light /state answer carries the board and the light scope; the heavy
			 * blocks come from /meta (or from an older Host's full answer). A full
			 * rebuild drops the heavy fields, so this re-applies the cached ones
			 * instead of flashing them to null. A FAILED metadata request changes
			 * nothing here: the board keeps rendering and `metadata.status` says
			 * 'degraded', so the view can word the affected pill instead of spinning.
			 */
			function applyMetadata(next) {
				// T-210 review: NEVER merge an answer that describes another project.
				// The status is scoped the same way, so a switch shows "loading" for the
				// new board instead of the old board's ready/degraded state.
				const project = projectKeyOf(next.project)
				const projectMatches = project !== null && metaProject !== null && project === metaProject
				next.metadata = projectMatches
					? { status: metaStatus, errors: metaErrors, receivedAt: metaAt === 0 ? null : metaAt }
					: { status: 'idle', errors: {}, receivedAt: null }
				if (metaCache === null || !projectMatches) return next
				if (metaCache.scope !== undefined && metaCache.scope !== null) next.scope = metaCache.scope
				if (metaCache.agentTree !== undefined && metaCache.agentTree !== null) next.agentTree = metaCache.agentTree
				if (metaCache.worktrees !== undefined && metaCache.worktrees !== null) next.worktrees = metaCache.worktrees
				if (metaCache.environment !== undefined) next.environment = metaCache.environment
				if (metaCache.roles !== undefined) next.roles = metaCache.roles
				if (metaCache.rolePreviews !== undefined) next.rolePreviews = metaCache.rolePreviews
				if (metaCache.decisionPolicy !== undefined && metaCache.decisionPolicy !== null) next.decisionPolicy = metaCache.decisionPolicy
				if (metaCache.archivedCount !== undefined && metaCache.archivedCount !== null) next.archivedCount = metaCache.archivedCount
				if (metaCache.archiveRange !== undefined && metaCache.archiveRange !== null) next.archiveRange = metaCache.archiveRange
				if (metaCache.nextStep !== undefined) next.nextStep = metaCache.nextStep
				if (activityLog.length > 0) {
					next.activityEvents = {
						available: true,
						source: 'board',
						entries: activityLog.slice(0, 50),
						count: Math.min(activityLog.length, 50),
						total: activityLog.length,
						truncated: false,
						cursor: activityCursor,
					}
				}
				return next
			}

			/**
			 * T-195: carry the pending decision queue onto a snapshot. The server
			 * sends each request's remainingMs, so the countdown is measured from
			 * the server deadline; receivedAt turns it into a local elapsed time.
			 */
			function withDecisions(next, payload) {
				const host =
					payload !== null && payload !== undefined && payload.snapshot !== undefined && payload.snapshot !== null
						? payload.snapshot
						: payload
				if (host !== null && host !== undefined && Array.isArray(host.decisions)) next.decisions = host.decisions
				else if (!Array.isArray(next.decisions)) next.decisions = []
				// T-198: the policy rides the same snapshot; a payload without one (a
				// delta, or an older Host) keeps the last known policy instead of
				// blanking the settings page.
				if (host !== null && host !== undefined && host.decisionPolicy !== undefined && host.decisionPolicy !== null) next.decisionPolicy = host.decisionPolicy
				else if (next.decisionPolicy === undefined) next.decisionPolicy = null
				next.receivedAt = Date.now()
				return next
			}

			async function fetchJson(url, options) {
				const response = await fetch(url, options)
				return await response.json()
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

			/** One project identity, however the two sides spell the path. */
			function projectKeyOf(value) {
				if (typeof value !== 'string' || value === '') return null
				const text = String(value).replace(/\\/g, '/').replace(/\/+$/, '')
				return /^[A-Za-z]:\//.test(text) ? text.toLowerCase() : text
			}

			/**
			 * The /meta URL for the project the panel is SHOWING (not the pin alone:
			 * during an openProject the pin still names the OLD project while the board
			 * already shows the new one). `refresh` forces the host to rebuild.
			 */
			function metaUrlFor(project, refresh) {
				let url = TC_META_URL + '?project=' + encodeURIComponent(project)
				if (refresh === true) url += '&refresh=1'
				if (activityCursor !== null) url += '&activitySince=' + encodeURIComponent(activityCursor)
				return tcWithSession(url)
			}

			/**
			 * Drop the cached metadata when the panel starts describing another project.
			 * The NEW project becomes the expected owner of the next answer.
			 */
			function resetMeta(project) {
				metaCache = null
				metaErrors = {}
				metaStatus = 'idle'
				metaAt = 0
				metaProject = projectKeyOf(project)
			}

			/**
			 * T-210: load the DEFERRED metadata. Single flight PER PROJECT, never
			 * awaited by the board's render path. A failure degrades only the deferred
			 * blocks: the snapshot keeps its board, its light scope and its 'ready'
			 * state. `options.refresh` asks the host to rebuild (used after an action);
			 * a forced refresh is never satisfied by a routine in-flight request.
			 */
			async function loadMeta(options) {
				const o = options === undefined || options === null ? {} : options
				if (metaSupported !== true) return null
				const project = typeof snapshot.project === 'string' && snapshot.project !== '' ? snapshot.project : null
				if (project === null) return null
				const key = projectKeyOf(project)
				const refresh = o.refresh === true
				// A request for ANOTHER project invalidates the cached answer and the
				// reported status BEFORE it lands: nothing of the old board may be shown
				// as the new board's metadata.
				if (metaProject !== key) {
					metaCache = null
					metaErrors = {}
					metaAt = 0
					metaProject = key
					metaStatus = 'idle'
				}
				if (metaFlight !== null && metaFlight.key === key && (refresh !== true || metaFlight.refresh === true)) return metaFlight.promise
				if (metaStatus === 'idle' || (refresh === true && metaStatus !== 'loading')) {
					metaStatus = 'loading'
					emit(snapshot)
				}
				const seq = ++metaSeq
				const request = (async function () {
					try {
						const payload = await fetchJson(metaUrlFor(project, refresh), { headers: { accept: 'application/json' } })
						// A NEWER request (or a project switch) owns the snapshot now: this
						// answer describes a board that is no longer on screen, so discard it.
						if (seq !== metaSeq || projectKeyOf(snapshot.project) !== key) return { ok: false, stale: true }
						if (payload === null || payload === undefined || payload.ok !== true) {
							metaStatus = 'degraded'
							metaErrors =
								payload !== null && payload !== undefined && payload.errors !== null && typeof payload.errors === 'object'
									? payload.errors
									: payload !== null && payload !== undefined && typeof payload.message === 'string' && payload.message !== ''
										? { message: payload.message }
										: {}
							metaProject = key
							emit(snapshot)
							return { ok: false, payload: payload === undefined ? null : payload }
						}
						if (isMetaSplit(payload)) metaSupported = true
						const meta = payload.meta !== undefined && payload.meta !== null && typeof payload.meta === 'object' ? payload.meta : null
						absorbActivity(meta === null ? null : meta.activityEvents)
						metaCache = meta
						metaErrors = payload.errors !== undefined && payload.errors !== null && typeof payload.errors === 'object' ? payload.errors : {}
						metaAt = Date.now()
						metaProject = key
						metaStatus = Object.keys(metaErrors).length > 0 ? 'degraded' : 'ready'
						emit(snapshot)
						return { ok: true, payload: payload }
					} catch (error) {
						// A transport failure is a DEGRADED metadata state, never a board error.
						if (seq !== metaSeq || projectKeyOf(snapshot.project) !== key) return { ok: false, stale: true }
						metaStatus = 'degraded'
						metaErrors = { message: String((error && error.message) || error) }
						metaProject = key
						emit(snapshot)
						return { ok: false, error: error }
					} finally {
						if (metaFlight !== null && metaFlight.promise === request) metaFlight = null
					}
				})()
				metaFlight = { key: key, refresh: refresh, promise: request }
				return request
			}

			/**
			 * One poll. `options.refresh` forces the deferred metadata to be rebuilt
			 * (the panel's refresh action); the routine 2.5 s poll keeps the host's
			 * short-TTL answer.
			 */
			async function load(options) {
				const o = options === undefined || options === null ? {} : options
				if (loading !== null) return loading
				// No pin means NO ?project=: the Host resolves the session workspace and
				// answers with the project, which is the whole point of T-90.
				const pinned = tcPinnedProject()
				// The v3 panel consumes agentTree/scope; the snapshot no longer carries
				// any Team inventory, so there is no opt-out to ask for.
				let url = pinned === null ? TC_STATE_URL : TC_STATE_URL + '?project=' + encodeURIComponent(pinned)
				// T-210: the light first paint. The heavy metadata (agent tree, worktrees,
				// environment, activity timeline, roles, decision policy, archive) is a
				// SEPARATE request, so this answer is never held up by a host inventory.
				url += (url.indexOf('?') >= 0 ? '&' : '?') + 'light=1'
				if (snapshot.seq !== null && snapshot.seq !== undefined) url += '&since=' + String(snapshot.seq)
				url = tcWithSession(url)
				// T-210: NO second first-paint request. `light=1` IS the first paint.
				loading = (async function () {
					try {
						const payload = await fetchJson(url, { headers: { accept: 'application/json' } })
						if (isUnbound(payload) === true) {
							// No project yet — the expected pre-setup answer. Keep project null so
							// the view renders its open-project entry points, say nothing, and
							// leave no message behind for the binding to inherit.
							// T-203: the setup snapshot NAMES its source. 'unbound' is not a
							// project: it is "this session resolves to nothing", so the panel
							// never shows a last-active project as if the session owned it. An
							// older Host that omits the field is read the same way.
							const unbound = tcSnapshot(Object.assign({}, payload, { ok: true, project: null, projectRoot: null, tasks: [], resolvedFrom: 'unbound', sessionProject: null }), 'setup', '')
							withDecisions(unbound, payload)
							unbound.actionResult = snapshot.actionResult
							unbound.actionError = snapshot.actionError
							messageKind = null
							// T-210: no project means no metadata to show (and none from the
							// project the panel was on before).
							resetMeta(null)
							activityLog = []
							activityCursor = null
							emit(unbound)
						} else if (payload && payload.ok === true && (Array.isArray(payload.tasks) || payload.full === false)) {
							// The Host's answer is NOT written to localStorage: only an explicit
							// switch pins a project, so "follow the session" stays the default.
							// Only an ACTION's outcome survives a routine poll (see below); what
							// refreshes here is the board data.
							const next = withDecisions(tcMergeSnapshot(snapshot, payload), payload)
							// T-111: accumulate the incremental activity page. A project switch
							// starts a new log (the old project's events no longer apply).
							if (next.project !== snapshot.project) {
								activityLog = []
								activityCursor = null
								// T-210: the deferred blocks describe the OLD project; drop them.
								resetMeta(next.project)
								// T-208: decision ids are project-scoped; an id answered in project A
								// must not block the same id in project B.
								answeredDecisions.clear()
							}
							// An OLDER Host answers /state with the activity timeline itself; a
							// split Host sends it from /meta (absorbed in loadMeta).
							if (payload.activityEvents !== undefined && payload.activityEvents !== null) absorbActivity(payload.activityEvents)
							if (isMetaSplit(payload)) metaSupported = true
							if (next.activityEvents !== null && next.activityEvents !== undefined) {
								next.activityEvents = Object.assign({}, next.activityEvents, { entries: activityLog.slice(0, 50) })
							}
							next.actionResult = snapshot.actionResult
							next.actionError = snapshot.actionError
							// A routine poll keeps the user's last ACTION outcome (only the board
							// data refreshes), but the transport's own text stops being true the
							// moment /state answers again: clear it, so neither the unbound notice
							// nor a real failure outlives the binding that fixes it.
							next.message = messageKind === 'action' ? snapshot.message : ''
							if (messageKind !== 'action') messageKind = null
							emit(next)
							// T-210: the board (and the header's base facts) are painted; the
							// deferred metadata is refreshed in the BACKGROUND and can fail
							// without touching the board or the ready state.
							void loadMeta(o.refresh === true ? { refresh: true } : undefined)
						} else {
							const failed = tcSnapshot(Object.assign({}, payload, { tasks: [] }), 'error', tcErrorMessage(payload, t))
							failed.decisions = snapshot.decisions
							failed.decisionPolicy = snapshot.decisionPolicy
							failed.receivedAt = snapshot.receivedAt
							failed.actionResult = snapshot.actionResult
							failed.actionError = snapshot.actionError
							messageKind = 'state'
							emit(failed)
						}
					} catch (error) {
						const offline = tcSnapshot(Object.assign({}, snapshot, { tasks: [] }), 'error', String((error && error.message) || error))
						offline.decisions = snapshot.decisions
						offline.decisionPolicy = snapshot.decisionPolicy
						offline.receivedAt = snapshot.receivedAt
						offline.actionResult = snapshot.actionResult
						offline.actionError = snapshot.actionError
						messageKind = 'state'
						emit(offline)
					} finally {
						loading = null
					}
				})()
				return loading
			}

			/**
			 * Send one action. options.quiet marks an AUTOMATIC call (the prompt
			 * preview): it may refresh board data, but it never enters the
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
						const host = payload.snapshot !== undefined && payload.snapshot !== null ? payload.snapshot : payload
						if (host && Array.isArray(host.tasks)) {
							const next = withDecisions(tcSnapshot(host, 'host', '', payload), host)
							// T-196 review: the ANSWER landed but the host action it stood for
							// failed (the board moved on, the card is not deletable, ...). The
							// modal disappears with the decision, so the SAME banner a failed
							// action uses must explain that nothing happened. An intentional
							// 取消创建 is not a failure.
							const applied = payload.applied !== undefined && payload.applied !== null && typeof payload.applied === 'object' ? payload.applied : null
							const appliedFailed = applied !== null && applied.ok === false && applied.code !== 'decision-rejected'
							if (quiet) {
								next.actionResult = snapshot.actionResult
								next.actionError = snapshot.actionError
								next.message = snapshot.message
							} else if (appliedFailed) {
								messageKind = 'action'
								next.message = typeof applied.message === 'string' && applied.message !== '' ? applied.message : t('decisionAppliedFailed')
								next.actionResult = null
								next.actionError = applied
							} else {
								// A real action answered: whatever the banner said is no longer current.
								messageKind = null
							}
							if (decisionId !== null) answeredDecisions.add(decisionId)
							// An action's answer (or openProject's full snapshot) also advertises
							// the split; learn it here so a panel that bound a project before its
							// first poll still asks for the deferred half.
							if (isMetaSplit(host) || isMetaSplit(payload)) metaSupported = true
							// T-210 review: the answer may describe ANOTHER project (openProject).
							// The metadata of the old board must not survive onto the new one, and
							// the next /meta must describe the project the board now shows.
							if (projectKeyOf(next.project) !== projectKeyOf(snapshot.project)) resetMeta(next.project)
							emit(next)
							// T-210: an action changes host state (worktrees, environment, roles).
							// Refresh the deferred blocks in the background; the action answer
							// itself only carried the light board. A real action forces a rebuild
							// so the panel never shows pre-action worktrees/environment/roles for
							// up to the cache TTL; a QUIET automatic call may reuse the cache.
							void loadMeta(quiet ? undefined : { refresh: true })
						} else if (decisionId !== null) {
							// T-208: the answer response carries no snapshot. Drop the answered
							// request from the queue right away so BOTH surfaces advance to the
							// next decision without waiting for the next poll (which the caller
							// still asks for to confirm the canonical list).
							answeredDecisions.add(decisionId)
							emit(Object.assign({}, snapshot, {
								decisions: (Array.isArray(snapshot.decisions) ? snapshot.decisions : []).filter(function (entry) { return entry === null || entry === undefined || entry.id !== decisionId }),
								receivedAt: Date.now(),
							}))
						}
						return { ok: true, payload: payload }
					}
					if (!quiet) {
						if (isUnbound(payload) === true) {
							// The action was refused because no project is bound yet: the same
							// setup state /state reports, not a failed operation.
							messageKind = null
							emit(Object.assign({}, snapshot, { source: 'setup', message: '', actionResult: null, actionError: null }))
						} else {
							messageKind = 'action'
							emit(Object.assign({}, snapshot, { message: tcErrorMessage(payload, t), actionResult: null, actionError: payload === undefined || payload === null ? null : payload }))
						}
					}
					return { ok: false, payload: payload }
				} catch (error) {
					if (!quiet) {
						// A failed action is still an ACTION outcome: it survives polls like any
						// other, instead of being cleared by the next good /state.
						messageKind = 'action'
						emit(Object.assign({}, snapshot, { message: String((error && error.message) || error) }))
					}
					return { ok: false, error: error }
				} finally {
					if (decisionId !== null) answeringDecisions.delete(decisionId)
					if (busy === token) setBusy(null)
				}
			}

			/**
			 * T-208: refresh ONLY the pending decision queue. The conversation-page
			 * overlay polls this instead of /state, so a shell overlay never pulls the
			 * whole board every few seconds. It reads and writes no other snapshot
			 * field and never enters the action-result channel (a background poll must
			 * not raise the task-center banner).
			 */
			async function loadDecisions() {
				if (decisionsLoading !== null) return decisionsLoading
				decisionsLoading = (async function () {
					const body = { action: 'decisionList', decisionStatus: 'pending', session: tcSessionId() }
					const project = tcPinnedProject()
					if (project !== null) body.project = project
					try {
						const payload = await fetchJson(tcWithSession(TC_ACTION_URL), {
							method: 'POST',
							headers: { 'content-type': 'application/json' },
							body: JSON.stringify(body),
						})
						if (payload !== null && payload !== undefined && payload.ok === true && Array.isArray(payload.decisions)) {
							// withDecisions carries the queue and the receipt time the countdown
							// needs; every other field (tasks, project, banner) stays as it is.
							emit(withDecisions(Object.assign({}, snapshot), payload))
							return { ok: true, decisions: payload.decisions }
						}
						return { ok: false, payload: payload === undefined ? null : payload }
					} catch (error) {
						return { ok: false, error: error }
					} finally {
						decisionsLoading = null
					}
				})()
				return decisionsLoading
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

			/**
			 * Fetch one task's full detail on demand (drawer/view open). Cached per
			 * task updatedAt, so a poll that did not change the card never refetches;
			 * a changed card drops its cache entry in tcMergeSnapshot.
			 */
			const detailInFlight = new Set()
			async function loadDetail(id) {
				const summary = snapshot.tasks.filter(function (task) { return task.id === id })[0]
				if (summary === undefined) return
				const cached = snapshot.details[id]
				if (cached !== undefined && cached.updatedAt === summary.updatedAt) return
				if (detailInFlight.has(id)) return
				detailInFlight.add(id)
				try {
					const project = tcPinnedProject()
					const url = tcWithSession(TC_TASK_URL + '?id=' + encodeURIComponent(id) + (project === null ? '' : '&project=' + encodeURIComponent(project)))
					const payload = await fetchJson(url, { headers: { accept: 'application/json' } })
					if (payload && payload.ok === true && payload.task !== undefined && payload.task !== null) {
						emit(Object.assign({}, snapshot, {
							details: Object.assign({}, snapshot.details, { [id]: { task: payload.task, updatedAt: summary.updatedAt } }),
						}))
					}
				} catch (error) {
					// A failed detail fetch must not blank the card: the summary stays.
				} finally {
					detailInFlight.delete(id)
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
				if (explicit) messageKind = null
				const bound = Object.assign({}, snapshot, {
					project: next,
					projectRoot: next,
					resolvedFrom: 'panel',
					source: snapshot.source === 'setup' || snapshot.source === 'error' ? 'host' : snapshot.source,
				})
				if (explicit) bound.message = ''
				// T-210: the metadata cache belongs to the OLD project. The pin is already
				// set, so the request below names the NEW project explicitly.
				if (metaProject !== projectKeyOf(next)) resetMeta(next)
				emit(bound)
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

			function startPolling(ms) {
				if (timer !== null) return
				timer = setInterval(function () {
					void load()
				}, ms)
			}

			function stopPolling() {
				if (timer !== null) clearInterval(timer)
				timer = null
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
				load: load,
				// T-210: the deferred metadata can also be refreshed on its own (the
				// panel's refresh action calls load(), which polls both halves).
				loadMeta: loadMeta,
				loadDecisions: loadDecisions,
				send: send,
				loadWorktrees: loadWorktrees,
				switchProject: switchProject,
				listTasks: listTasks,
				loadDetail: loadDetail,
				startPolling: startPolling,
				stopPolling: stopPolling,
			}
		}

		module.exports = { createTaskStore }
