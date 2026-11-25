/**
 * Settings page view module.
 *
 * T-205 turns the old "dispatch settings" modal into a real settings page: a
 * page title (设置), a fixed left navigation (常规 / 派发 / 重试 / 关键决策 /
 * Godot 引擎), an independently scrolling right column and a footer that holds
 * the save/cancel actions. The task center's settings entry and the plugin
 * bundle card (plugins.bundle.config) BOTH render this page - the card only
 * supplies the data the page needs (the shared task store, the config scope for
 * the engine path, the theme preference), so the two entry points cannot drift.
 *
 * Data scope: the page always reflects the CURRENT task-center project from the
 * snapshot (never a last-active one): an unbound session renders the
 * "未绑定项目" banner and disables the project-scoped themes (派发 / 重试 /
 * 关键决策), while the engine path (a config-scope value) stays editable.
 *
 * Every section stays MOUNTED inside the form; the page only changes which one
 * is visible, so a half-typed field survives a trip to another theme. The save
 * action is owned by SettingsForm (it holds the input refs and the drafts); it
 * publishes itself into a page-owned actions object on every render, so the
 * footer always calls THIS page's save closure (a second mounted page cannot
 * hijack it).
 *
 * Narrow layouts: CSS folds the left rail into a horizontal tab row above the
 * content (see TC_CSS, max-width 900px); the DOM order already reads nav-first.
 */
function createSettingsViews(deps) {
	const React = deps.React
	const h = deps.h
	const SettingsForm = deps.SettingsForm

	// The theme rail, in reading order. projectScoped themes write into the task
	// center project, so they are disabled while nothing is bound.
	// T-242: 'archive' is a PAGE-owned section (the done-card archive knobs); it
	// is rendered here, not by SettingsForm, because those settings are not
	// dispatch and have their own stats block.
	const SECTIONS = [
		{ key: 'general', labelKey: 'settingsNavGeneral', projectScoped: false },
		{ key: 'dispatch', labelKey: 'settingsNavDispatch', projectScoped: true },
		{ key: 'retry', labelKey: 'settingsNavRetry', projectScoped: true },
		{ key: 'decisions', labelKey: 'settingsNavDecisions', projectScoped: true },
		{ key: 'archive', labelKey: 'settingsNavArchive', projectScoped: true },
		{ key: 'engine', labelKey: 'settingsNavEngine', projectScoped: false },
	]

	const THEME_KEY = 'gbt-theme'

	/** The browser theme preference; a storage denial still lets the page render. */
	function readThemePreference() {
		try {
			const raw =
				typeof window !== 'undefined' && window !== null && window.localStorage !== undefined && typeof window.localStorage.getItem === 'function'
					? window.localStorage.getItem(THEME_KEY)
					: null
			return raw === 'console' ? 'console' : 'dsh'
		} catch (error) {
			return 'dsh'
		}
	}

	function writeThemePreference(value) {
		try {
			if (typeof window !== 'undefined' && window !== null && window.localStorage !== undefined && typeof window.localStorage.setItem === 'function') {
				window.localStorage.setItem(THEME_KEY, value)
			}
		} catch (error) {
			/* the in-memory theme still applies */
		}
	}

	function resolveSection(value) {
		if (typeof value !== 'string') return 'general'
		return SECTIONS.some(function (entry) { return entry.key === value }) ? value : 'general'
	}

	// ── T-242: the done-card archive section ─────────────────────────────────
	// The page owns this section (not SettingsForm): the archive knobs are project
	// settings with a stats block of their own, and they are saved through the
	// same 'settings' action the form uses. The defaults and bounds mirror
	// plugin/task-center/archive.mjs; the client only edits and pre-checks what it
	// shows — the server validates and never accepts an out-of-range value.
	const ARCHIVE_DEFAULT_SETTINGS = { enabled: true, doneAfterDays: 14, keepDone: 50, maxBoardBytes: 2 * 1024 * 1024 }
	const ARCHIVE_DAY_LIMIT = { min: 1, max: 3650 }
	const ARCHIVE_KEEP_LIMIT = { min: 0, max: 2000 }
	const ARCHIVE_BYTES_LIMIT = { min: 64 * 1024, max: 32 * 1024 * 1024 }

	function archiveSettingsOf(raw) {
		const source = raw !== null && raw !== undefined && typeof raw === 'object' ? raw : {}
		const pick = function (value, limit, fallback) {
			const number = Number(value)
			if (!Number.isFinite(number)) return fallback
			return Math.min(limit.max, Math.max(limit.min, Math.floor(number)))
		}
		return {
			enabled: typeof source.enabled === 'boolean' ? source.enabled : ARCHIVE_DEFAULT_SETTINGS.enabled,
			doneAfterDays: pick(source.doneAfterDays, ARCHIVE_DAY_LIMIT, ARCHIVE_DEFAULT_SETTINGS.doneAfterDays),
			keepDone: pick(source.keepDone, ARCHIVE_KEEP_LIMIT, ARCHIVE_DEFAULT_SETTINGS.keepDone),
			maxBoardBytes: pick(source.maxBoardBytes, ARCHIVE_BYTES_LIMIT, ARCHIVE_DEFAULT_SETTINGS.maxBoardBytes),
			lastSweepAt: typeof source.lastSweepAt === 'string' ? source.lastSweepAt : null,
			lastSweep: source.lastSweep !== null && typeof source.lastSweep === 'object' ? source.lastSweep : null,
		}
	}

	/** A byte count as MB text (two decimals at most), or null when unknown. */
	function megabytesOf(bytes) {
		if (!Number.isFinite(bytes)) return null
		return String(Math.round((bytes / (1024 * 1024)) * 100) / 100)
	}

	/**
	 * The archive section. It PUMPS its save into the page-owned actions slot
	 * like SettingsForm does, so the one footer drives both from a single render
	 * (and a second mounted page cannot hijack it).
	 */
	function ArchiveSection(props) {
		const t = props.t
		// Only the archive FACTS are handed in (never the whole snapshot): the page
		// must not leak the project object of another surface into this section.
		const settings = archiveSettingsOf(props.settings)
		const boardSize = props.boardSize !== null && props.boardSize !== undefined && typeof props.boardSize === 'object' ? props.boardSize : null
		const active = props.active === true
		const enabledRef = React.useRef(null)
		const daysRef = React.useRef(null)
		const keepRef = React.useRef(null)
		const bytesRef = React.useRef(null)

		function numberFrom(ref, fallback) {
			const node = ref !== null && ref !== undefined ? ref.current : null
			if (node === null || node === undefined) return fallback
			const raw = String(node.value === undefined || node.value === null ? '' : node.value).trim()
			if (raw === '') return fallback
			const value = Number(raw)
			return Number.isFinite(value) ? value : Number.NaN
		}

		/** Only the values the user really moved, so a save without edits is free. */
		function changedPatch() {
			const node = enabledRef.current
			const enabled = node === null || node === undefined ? settings.enabled : node.checked === true
			const doneAfterDays = Math.floor(numberFrom(daysRef, settings.doneAfterDays))
			const keepDone = Math.floor(numberFrom(keepRef, settings.keepDone))
			const maxBoardBytes = Math.round(numberFrom(bytesRef, settings.maxBoardBytes / (1024 * 1024)) * 1024 * 1024)
			const patch = {}
			if (enabled !== settings.enabled) patch.enabled = enabled
			if (doneAfterDays !== settings.doneAfterDays) patch.doneAfterDays = doneAfterDays
			if (keepDone !== settings.keepDone) patch.keepDone = keepDone
			if (maxBoardBytes !== settings.maxBoardBytes) patch.maxBoardBytes = maxBoardBytes
			return patch
		}

		function valid(patch) {
			if (
				patch.doneAfterDays !== undefined &&
				(!Number.isInteger(patch.doneAfterDays) || patch.doneAfterDays < ARCHIVE_DAY_LIMIT.min || patch.doneAfterDays > ARCHIVE_DAY_LIMIT.max)
			) {
				return false
			}
			if (patch.keepDone !== undefined && (!Number.isInteger(patch.keepDone) || patch.keepDone < ARCHIVE_KEEP_LIMIT.min || patch.keepDone > ARCHIVE_KEEP_LIMIT.max)) return false
			if (
				patch.maxBoardBytes !== undefined &&
				(!Number.isInteger(patch.maxBoardBytes) || patch.maxBoardBytes < ARCHIVE_BYTES_LIMIT.min || patch.maxBoardBytes > ARCHIVE_BYTES_LIMIT.max)
			) {
				return false
			}
			return true
		}

		/** Resolves { ok, error?, changed } — the page shows the outcome. */
		function save() {
			const patch = changedPatch()
			if (!valid(patch)) return Promise.resolve({ ok: false, error: t('invalidArchiveSetting') })
			if (Object.keys(patch).length === 0) return Promise.resolve({ ok: true, changed: 0 })
			const store = props.store
			if (store === null || store === undefined || typeof store.send !== 'function') return Promise.resolve({ ok: true, changed: 0 })
			return Promise.resolve(store.send('settings', { archive: patch })).then(
				function (result) {
					if (result !== null && result !== undefined && result.ok === true) return { ok: true, changed: Object.keys(patch).length }
					const payload = result !== null && result !== undefined ? result.payload : null
					const code = payload !== null && payload !== undefined && typeof payload.code === 'string' ? payload.code : ''
					return { ok: false, error: code === 'invalid-archive-setting' ? t('invalidArchiveSetting') : t('error') }
				},
				function () {
					return { ok: false, error: t('error') }
				},
			)
		}
		if (props.actions !== null && props.actions !== undefined && typeof props.actions === 'object') props.actions.save = save

		const archivedCount = Number.isFinite(props.archivedCount)
			? Math.floor(props.archivedCount)
			: Number.isFinite(props.archivedIndexCount)
				? Math.floor(props.archivedIndexCount)
				: null
		const boardBytes = boardSize !== null ? megabytesOf(boardSize.bytes) : null
		const boardLimit = boardSize !== null ? megabytesOf(boardSize.limit) : null
		const movedLast = settings.lastSweep !== null && Number.isFinite(settings.lastSweep.archived) ? Math.floor(settings.lastSweep.archived) : 0
		const stats = [
			t('settingsArchiveArchivedCount') + ': ' + (archivedCount === null ? t('settingsArchiveCountUnknown') : String(archivedCount)),
			t('settingsArchiveBoardSize') + ': ' + (boardBytes === null ? t('settingsArchiveCountUnknown') : boardBytes + ' MB' + (boardLimit === null ? '' : ' / ' + boardLimit + ' MB')),
			t('settingsArchiveLastSweep') +
				': ' +
				(settings.lastSweepAt === null
					? t('settingsArchiveNeverSwept')
					: settings.lastSweepAt.slice(0, 16).replace('T', ' ') + ' · ' + t('settingsArchiveSweepMoved') + ' ' + String(movedLast)),
		]

		function field(labelKey, hintKey, input) {
			return h('div', { className: 'gbt-field' }, h('label', null, t(labelKey)), input, h('p', { className: 'gbt-settingsnote' }, t(hintKey)))
		}

		return h(
			'section',
			{
				className: 'gbt-settingssection',
				'data-settings-section': 'archive',
				'data-archive-active': active ? 'true' : 'false',
				hidden: active ? undefined : true,
				'aria-hidden': active ? undefined : 'true',
			},
			h(
				'div',
				{ className: 'gbt-settingsgroup', 'data-settings-group': 'archive' },
				h('div', { className: 'gbt-settingsgrouphead' }, t('settingsArchiveGroup')),
				h('p', { className: 'gbt-settingsnote' }, t('settingsArchiveHint')),
				h(
					'div',
					{ className: 'gbt-settingsinline', 'data-archive-stats': 'true' },
					stats.map(function (text, index) {
						return h('span', { key: 'archive-stat-' + String(index), className: 'gbt-chip', 'data-archive-stat': String(index) }, text)
					}),
				),
				h(
					'label',
					{ className: 'gbt-policyguard', 'data-archive-field': 'enabled' },
					h('input', { type: 'checkbox', ref: enabledRef, defaultChecked: settings.enabled, 'data-archive-input': 'enabled' }),
					t('settingsArchiveEnabled'),
				),
				h('p', { className: 'gbt-settingsnote' }, t('settingsArchiveEnabledHint')),
				field(
					'settingsArchiveDoneAfterDays',
					'settingsArchiveDoneAfterDaysHint',
					h('input', {
						className: 'gbt-input',
						type: 'number',
						min: ARCHIVE_DAY_LIMIT.min,
						max: ARCHIVE_DAY_LIMIT.max,
						step: 1,
						ref: daysRef,
						defaultValue: String(settings.doneAfterDays),
						'data-archive-input': 'doneAfterDays',
					}),
				),
				field(
					'settingsArchiveKeepDone',
					'settingsArchiveKeepDoneHint',
					h('input', {
						className: 'gbt-input',
						type: 'number',
						min: ARCHIVE_KEEP_LIMIT.min,
						max: ARCHIVE_KEEP_LIMIT.max,
						step: 1,
						ref: keepRef,
						defaultValue: String(settings.keepDone),
						'data-archive-input': 'keepDone',
					}),
				),
				field(
					'settingsArchiveMaxBoardBytes',
					'settingsArchiveMaxBoardBytesHint',
					h('input', {
						className: 'gbt-input',
						type: 'number',
						min: 0.0625,
						max: 32,
						step: 0.5,
						ref: bytesRef,
						defaultValue: megabytesOf(settings.maxBoardBytes),
						'data-archive-input': 'maxBoardBytes',
					}),
				),
			),
		)
	}

	/**
	 * The page. Every data input is a prop so the same component can be mounted
	 * by the task center panel and by the plugin bundle card.
	 */
	function SettingsPage(props) {
		const t = props.t
		const snapshot = props.snapshot !== null && props.snapshot !== undefined && typeof props.snapshot === 'object' ? props.snapshot : {}
		const mode = props.mode === 'card' ? 'card' : 'panel'
		const theme = props.theme === 'console' ? 'console' : 'dsh'
		const store = props.store === undefined ? null : props.store
		// The page never looks for a last-active project: the snapshot's project is
		// the one the task center acts on, and null is the honest "unbound" state.
		const project = typeof snapshot.project === 'string' && snapshot.project !== '' ? snapshot.project : null
		const unbound = project === null
		// A per-page actions slot: the mounted form publishes its save into THIS
		// object, so a second mounted page (the plugin card) cannot hijack the
		// footer of the first one.
		const actionsRef = React.useRef(null)
		if (actionsRef.current === null || actionsRef.current === undefined) actionsRef.current = { save: null }
		// T-242: the archive section publishes into its own slot, so the footer can
		// drive BOTH saves (dispatch form + archive knobs) without either hijacking
		// the other.
		const archiveRef = React.useRef(null)
		if (archiveRef.current === null || archiveRef.current === undefined) archiveRef.current = { save: null }
		const [section, setSection] = React.useState(resolveSection(props.initialSection))
		const [status, setStatus] = React.useState(null)
		const active = resolveSection(section)
		const dispatch = snapshot.dispatch === null || snapshot.dispatch === undefined ? {} : snapshot.dispatch
		const policy = snapshot.decisionPolicy === undefined ? null : snapshot.decisionPolicy

		function choose(next) {
			const key = resolveSection(next)
			const entry = SECTIONS.filter(function (candidate) { return candidate.key === key })[0]
			if (unbound === true && entry !== undefined && entry.projectScoped === true) return
			setSection(key)
		}

		function save() {
			if (unbound === true) {
				setStatus({ kind: 'error', text: t('settingsUnboundHint') })
				return
			}
			const actions = actionsRef.current
			const archive = archiveRef.current
			// T-242: ONE footer save writes the dispatch/decision settings AND the
			// archive knobs. Either may decline to send (nothing changed); a refusal
			// from either is shown in the footer and reported first.
			const pending = []
			if (actions !== null && actions !== undefined && typeof actions.save === 'function') pending.push(actions.save())
			if (archive !== null && archive !== undefined && typeof archive.save === 'function') pending.push(archive.save())
			const running = pending.filter(function (entry) {
				return entry !== null && entry !== undefined && typeof entry.then === 'function'
			})
			if (running.length === 0) return
			return Promise.all(running).then(function (outcomes) {
				for (const outcome of outcomes) {
					if (outcome === null || outcome === undefined || outcome.ok === true) continue
					const text = typeof outcome.error === 'string' && outcome.error !== '' ? outcome.error : t('error')
					setStatus({ kind: 'error', text: text })
					return { ok: false, error: text }
				}
				setStatus({ kind: 'saved' })
				return { ok: true }
			})
		}

		const nav = h(
			'nav',
			{ className: 'gbt-settingsnav', 'data-settings-nav': 'true', role: 'navigation', 'aria-label': t('settingsNavLabel') },
			SECTIONS.map(function (entry) {
				const disabled = unbound === true && entry.projectScoped === true
				return h(
					'button',
					{
						key: entry.key,
						type: 'button',
						className: 'gbt-settingsnavitem',
						'data-settings-nav': entry.key,
						'data-active': active === entry.key ? 'true' : 'false',
						'aria-current': active === entry.key ? 'page' : undefined,
						disabled: disabled,
						onClick: function () {
							choose(entry.key)
						},
					},
					t(entry.labelKey),
				)
			}),
		)

		const head = h(
			'header',
			{ className: 'gbt-settingshead', 'data-settings-head': 'true' },
			h(
				'div',
				{ className: 'gbt-settingsheadtext' },
				h('h1', { className: 'gbt-settingspagetitle', 'data-settings-title': 'true' }, t('settingsPageTitle')),
				h(
					'p',
					{ className: 'gbt-settingssub' },
					unbound === true
						? t('settingsUnbound')
						: h('span', null, t('settingsProjectScope'), ' · ', h('b', { className: 'gbt-mono', title: project }, project)),
				),
			),
			mode === 'panel' && typeof props.onClose === 'function'
				? h(
						'button',
						{ type: 'button', className: 'gbt-iconbtn', 'data-action': 'settings-back', title: t('close'), 'aria-label': t('close'), onClick: props.onClose },
						'×',
					)
				: null,
		)

		const unboundBanner =
			unbound === true
				? h(
						'div',
						{ className: 'gbt-settingsunbound', 'data-settings-unbound': 'true', role: 'status' },
						h('b', null, t('settingsUnbound')),
						h('span', null, ' · ' + t('settingsUnboundHint')),
					)
				: null

		const statusText = status === null ? '' : status.kind === 'saved' ? t('settingsSaved') : String(status.text)

		const footer = h(
			'footer',
			{ className: 'gbt-settingsfooter', 'data-settings-footer': 'true' },
			h('p', { className: 'gbt-settingsstatus', 'data-settings-status': status === null ? '' : status.kind, role: 'status', 'aria-live': 'polite' }, statusText),
			h('button', { type: 'button', className: 'gbt-btn', 'data-variant': 'primary', 'data-settings-save': 'true', disabled: unbound === true, onClick: save }, t('apply')),
			typeof props.onClose === 'function'
				? h('button', { type: 'button', className: 'gbt-btn', 'data-settings-cancel': 'true', onClick: props.onClose }, t('cancel'))
				: null,
		)

		const form = h(SettingsForm, {
			t: t,
			actions: actionsRef.current,
			dispatch: dispatch,
			policy: policy,
			theme: theme,
			onThemeChange: props.onThemeChange,
			section: active,
			unbound: unbound,
			engineScope: props.engineScope === undefined ? null : props.engineScope,
			store: store,
		})

		return h(
			'div',
			{
				className: 'gbt-settingspage' + (mode === 'card' ? ' gbt-root' : ''),
				'data-settings-page': 'true',
				'data-settings-mode': mode,
				'data-settings-active': active,
				'data-settings-bound': unbound === true ? 'false' : 'true',
				'data-tc-theme': theme,
			},
			head,
			unboundBanner,
			h(
				'div',
				{ className: 'gbt-settingsbody' },
				nav,
				h(
					'div',
					{ className: 'gbt-settingspane' },
					h(
						'div',
						{ className: 'gbt-settingsscroll', 'data-settings-scroll': 'true' },
						// T-242: the archive section is PAGE-owned and always mounted (the nav
						// only shows/hides it), so a half-typed value survives a trip to
						// another theme. While it is the active theme the form's own sections
						// are hidden as a block: SettingsForm maps an unknown section back to
						// 'general', so leaving it visible would show two themes at once.
						h(ArchiveSection, {
							t: t,
							settings: snapshot.archiveSettings,
							archivedCount: snapshot.archivedCount,
							archivedIndexCount: snapshot.archivedIndexCount,
							boardSize: snapshot.boardSize,
							store: store,
							active: active === 'archive',
							actions: archiveRef.current,
						}),
						h('div', { hidden: active === 'archive' ? true : undefined, 'data-settings-formhost': 'true' }, form),
					),
					footer,
				),
			),
		)
	}

	/**
	 * The plugin bundle card: the SAME page, mounted from plugins.bundle.config.
	 * It resolves the shared task store (the current project, no last-active
	 * fallback) and the engine path's config scope, and keeps the browser theme
	 * preference; nothing else is card-specific.
	 */
	function createSettingsCard(cardDeps) {
		const opts = cardDeps === undefined || cardDeps === null ? {} : cardDeps
		const store = opts.store
		const engineScope = opts.engineScope === undefined ? null : opts.engineScope
		const locale = opts.locale
		const ns = typeof opts.ns === 'string' && opts.ns !== '' ? opts.ns : 'godotBridgeTaskCenter'

		function useTranslate() {
			const force = React.useReducer(function (count) { return count + 1 }, 0)[1]
			React.useEffect(function () {
				return locale.subscribe(force)
			}, [])
			return locale.bind(ns)
		}

		function SettingsCard() {
			const t = useTranslate()
			const snapshot = React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
			const [theme, setTheme] = React.useState(readThemePreference)
			// The host asks for one page load when the card opens; the panel keeps
			// polling, the card does not subscribe to a timer of its own.
			React.useEffect(function () {
				void store.load()
			}, [])
			function onThemeChange(next) {
				const value = next === 'console' ? 'console' : 'dsh'
				writeThemePreference(value)
				setTheme(value)
			}
			return h(SettingsPage, {
				t: t,
				mode: 'card',
				// The bundle card has always configured the engine path, so it opens
				// on that theme; the rest of the page stays one click away.
				initialSection: 'engine',
				snapshot: snapshot,
				store: store,
				engineScope: engineScope,
				theme: theme,
				onThemeChange: onThemeChange,
			})
		}

		return SettingsCard
	}

	return { SettingsPage: SettingsPage, createSettingsCard: createSettingsCard }
}

module.exports = { createSettingsViews }
