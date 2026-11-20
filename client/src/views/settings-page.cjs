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
	const SECTIONS = [
		{ key: 'general', labelKey: 'settingsNavGeneral', projectScoped: false },
		{ key: 'dispatch', labelKey: 'settingsNavDispatch', projectScoped: true },
		{ key: 'retry', labelKey: 'settingsNavRetry', projectScoped: true },
		{ key: 'decisions', labelKey: 'settingsNavDecisions', projectScoped: true },
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
			if (actions === null || actions === undefined || typeof actions.save !== 'function') return
			const pending = actions.save()
			if (pending === null || pending === undefined || typeof pending.then !== 'function') return
			pending.then(function (outcome) {
				const ok = outcome !== null && outcome !== undefined && outcome.ok === true
				if (ok) {
					setStatus({ kind: 'saved' })
					return
				}
				const text = outcome !== null && outcome !== undefined && typeof outcome.error === 'string' && outcome.error !== '' ? outcome.error : t('error')
				setStatus({ kind: 'error', text: text })
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
					h('div', { className: 'gbt-settingsscroll', 'data-settings-scroll': 'true' }, form),
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
