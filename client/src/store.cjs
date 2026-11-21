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
			// First paint: fire a core /state (board + counts, no host inventory)
			// alongside the full snapshot. Whichever arrives first renders; the
			// full answer then replaces/merges it. This keeps the panel usable
			// while the scope/session metadata is still loading.
			let coreTried = false
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
			// T-211: did the conversation-page overlay actually mount? The Host may
			// not offer the optional 'shell.overlay' slot (or the registration may
			// throw). The task-center header reads this to offer its own clickable
			// fallback only when the floating entry can never be there.
			let decisionOverlayMounted = false
			// T-211: a hung decision-list request must not wedge the queue forever.
			// After this long the poll gives up, releases the single-flight guard and
			// the next tick starts a fresh request.
			const DECISION_LOAD_TIMEOUT_MS = 15000
			const DECISION_LOAD_TIMEOUT = { timedOut: true }
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
				snapshot = Object.assign({}, next, { busy: busy })
				listeners.forEach(function (listener) {
					listener()
				})
			}

			function setBusy(next) {
				if (busy === next) return
				busy = next
				emit(snapshot)
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

			async function load() {
				if (loading !== null) return loading
				// No pin means NO ?project=: the Host resolves the session workspace and
				// answers with the project, which is the whole point of T-90.
				const pinned = tcPinnedProject()
				// The v3 panel consumes agentTree/scope; the snapshot no longer carries
				// any Team inventory, so there is no opt-out to ask for.
				let url = pinned === null ? TC_STATE_URL : TC_STATE_URL + '?project=' + encodeURIComponent(pinned)
				if (snapshot.seq !== null && snapshot.seq !== undefined) url += (url.indexOf('?') >= 0 ? '&' : '?') + 'since=' + String(snapshot.seq)
				if (activityCursor !== null) url += (url.indexOf('?') >= 0 ? '&' : '?') + 'activitySince=' + encodeURIComponent(activityCursor)
				url = tcWithSession(url)
				// Core first paint runs in parallel with the full request. It only
				// lands while the panel is still on its initial skeleton.
				if (!coreTried && snapshot.source === 'loading' && typeof window !== 'undefined' && window !== null) {
					coreTried = true
					const coreUrl = url + (url.indexOf('?') >= 0 ? '&' : '?') + 'core=1'
					void (async function () {
						try {
							const corePayload = await fetchJson(coreUrl, { headers: { accept: 'application/json' } })
							if (snapshot.source !== 'loading') return
							if (corePayload && corePayload.ok === true && Array.isArray(corePayload.tasks)) {
								// Never paint an empty core board over a known non-empty board:
								// a zero-task delta/edge answer is not useful as first paint.
								const total = corePayload.counts !== null && corePayload.counts !== undefined && Number.isFinite(corePayload.counts.total) ? corePayload.counts.total : 0
								if (corePayload.tasks.length === 0 && total > 0) return
								emit(withDecisions(tcSnapshot(corePayload, 'host', ''), corePayload))
							}
						} catch (error) {
							/* the full request below is the fallback */
						}
					})()
				}
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
								// T-208: decision ids are project-scoped; an id answered in project A
								// must not block the same id in project B.
								answeredDecisions.clear()
							}
							if (payload.activityEvents !== undefined && payload.activityEvents !== null && Array.isArray(payload.activityEvents.entries)) {
								const known = new Set(activityLog.map(function (entry) { return entry.key }))
								payload.activityEvents.entries.forEach(function (entry) {
									if (entry !== null && typeof entry === 'object' && typeof entry.key === 'string' && !known.has(entry.key)) activityLog.push(entry)
								})
								activityLog.sort(function (left, right) { return new Date(right.at).getTime() - new Date(left.at).getTime() })
								activityLog = activityLog.slice(0, 100)
								if (typeof payload.activityEvents.cursor === 'string' && payload.activityEvents.cursor !== '') activityCursor = payload.activityEvents.cursor
							}
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
							emit(next)
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
			async function loadDecisions(options) {
				// T-211: SINGLE FLIGHT per queue refresh. Every surface (the panel and
				// the conversation overlay) shares this promise instead of racing N
				// decisionList requests, and a hung one cannot block the next tick:
				// the optional timeout releases the guard in `finally`.
				if (decisionsLoading !== null) return decisionsLoading
				const opts = options === undefined || options === null ? {} : options
				const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : DECISION_LOAD_TIMEOUT_MS
				decisionsLoading = (async function () {
					let timer = null
					try {
						const body = { action: 'decisionList', decisionStatus: 'pending', session: tcSessionId() }
						const project = tcPinnedProject()
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
						if (payload === DECISION_LOAD_TIMEOUT) return { ok: false, timedOut: true, payload: null }
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
				emit(bound)
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
				loadDecisions: loadDecisions,
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
				startPolling: startPolling,
				stopPolling: stopPolling,
			}
		}

		module.exports = { createTaskStore }
