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
			// T-111: the Host answers the activity timeline incrementally. Keep what we
			// already have and ask only for events after the last one we saw.
			let activityCursor = null
			let activityLog = []
			const listeners = new Set()
			let loading = null
			let timer = null
			let busy = null

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

			async function fetchJson(url, options) {
				const response = await fetch(url, options)
				return await response.json()
			}

			async function load() {
				if (loading !== null) return loading
				// No pin means NO ?project=: the Host resolves the session workspace and
				// answers with the project, which is the whole point of T-90.
				const pinned = tcPinnedProject()
				let url = pinned === null ? TC_STATE_URL : TC_STATE_URL + '?project=' + encodeURIComponent(pinned)
				if (snapshot.seq !== null && snapshot.seq !== undefined) url += (url.indexOf('?') >= 0 ? '&' : '?') + 'since=' + String(snapshot.seq)
				if (activityCursor !== null) url += (url.indexOf('?') >= 0 ? '&' : '?') + 'activitySince=' + encodeURIComponent(activityCursor)
				url = tcWithSession(url)
				loading = (async function () {
					try {
						const payload = await fetchJson(url, { headers: { accept: 'application/json' } })
						if (payload && payload.ok === true && (Array.isArray(payload.tasks) || payload.full === false)) {
							// The Host's answer is NOT written to localStorage: only an explicit
							// switch pins a project, so "follow the session" stays the default.
							// A routine poll keeps the outcome of the user's last action until
							// the next action replaces it; only the board data is refreshed.
							const next = tcMergeSnapshot(snapshot, payload)
							// T-111: accumulate the incremental activity page. A project switch
							// starts a new log (the old project's events no longer apply).
							if (next.project !== snapshot.project) {
								activityLog = []
								activityCursor = null
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
							next.message = snapshot.message
							emit(next)
						} else {
							const failed = tcSnapshot(Object.assign({}, payload, { tasks: [] }), 'error', tcErrorMessage(payload, t))
							failed.actionResult = snapshot.actionResult
							failed.actionError = snapshot.actionError
							emit(failed)
						}
					} catch (error) {
						const offline = tcSnapshot(Object.assign({}, snapshot, { tasks: [] }), 'error', String((error && error.message) || error))
						offline.actionResult = snapshot.actionResult
						offline.actionError = snapshot.actionError
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
							const next = tcSnapshot(host, 'host', '', payload)
							if (quiet) {
								next.actionResult = snapshot.actionResult
								next.actionError = snapshot.actionError
								next.message = snapshot.message
							}
							emit(next)
						}
						return { ok: true, payload: payload }
					}
					if (!quiet) {
						emit(Object.assign({}, snapshot, { message: tcErrorMessage(payload, t), actionResult: null, actionError: payload === undefined || payload === null ? null : payload }))
					}
					return { ok: false, payload: payload }
				} catch (error) {
					if (!quiet) emit(Object.assign({}, snapshot, { message: String((error && error.message) || error) }))
					return { ok: false, error: error }
				} finally {
					if (busy === token) setBusy(null)
				}
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
			async function switchProject(path) {
				const next = typeof path === 'string' ? path.trim() : ''
				if (next === '') return { ok: false, payload: { ok: false, code: 'missing-path' } }
				const result = await send('openProject', { path: next })
				if (result.ok !== true) return result
				tcPinProject(next)
				emit(Object.assign({}, snapshot, { project: next, projectRoot: next, resolvedFrom: 'panel' }))
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
