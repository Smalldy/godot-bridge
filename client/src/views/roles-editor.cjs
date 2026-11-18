/**
 * Roles editor view module.
 *
 * Extracted from the roles fragment; React, h, the shared role cards/forms,
 * label helpers and the editor state are injected by the build.
 */
function createRolesEditor(deps) {
	const React = deps.React
	const h = deps.h
	const roleResultBanner = deps.roleResultBanner
	const tableWrap = deps.tableWrap
	const roleBoundProfile = deps.roleBoundProfile
	const roleSelectableProfiles = deps.roleSelectableProfiles
	const roleProfileCopy = deps.roleProfileCopy
	const RoleCreateForm = deps.RoleCreateForm
	const roleErrorText = deps.roleErrorText
	const tcSplitList = deps.tcSplitList
	const roleEditorState = deps.roleEditorState
	const ROLE_EDITOR_STAGES = deps.ROLE_EDITOR_STAGES
	const copyToClipboard = deps.copyToClipboard

	function RolesEditor(props) {
		const t = props.t
		const snapshot = props.snapshot
		const store = props.store
		const bump = props.bump
		const config = snapshot.roles
		const kind = roleEditorState.kind
		const stage = ROLE_EDITOR_STAGES[kind] || 'implement'
		const profiles = config !== null && config !== undefined && config.profiles !== null && config.profiles !== undefined && typeof config.profiles === 'object' ? config.profiles : {}
		const bound = roleBoundProfile(config, kind)
		const boundName = bound !== null && typeof bound.name === 'string' ? bound.name : null
		const draft = roleEditorState.draft
		const draftProfile = draft === null ? null : draft.profile
		const saved = roleEditorState.saved
		const options = roleSelectableProfiles(config, kind)
		// The selected name is honoured even before the host snapshot carries the
		// profile: a just-saved Fork must be targetable by Apply immediately,
		// without waiting for the next poll.
		const selectedName = draft !== null ? draft.name : roleEditorState.selected !== null ? roleEditorState.selected : boundName
		const target =
			draftProfile !== null
		? draftProfile
		: selectedName !== null && profiles[selectedName] !== undefined
			? profiles[selectedName]
			: saved !== null && saved.name === selectedName
				? saved.profile
				: null
		const builtin = selectedName === 'worker' || selectedName === 'reviewer' || selectedName === 'tester'
		// The "current use" selector: the stage's built-in default plus every
		// custom copy owning this stage. No bind/apply vocabulary is exposed.
		const useOptions = [kind].concat(options.filter(function (name) { return name !== kind }))
		if (selectedName !== null && useOptions.indexOf(String(selectedName)) < 0) useOptions.push(String(selectedName))
		// Only a profile the user owns (a saved copy or a fork draft) has a prompt
		// that can be edited here. Everything else is a clear empty state, never a
		// blank half-panel.
		const editablePrompt = !builtin && selectedName !== null && target !== null
		// The preview targets the SAVED profile: a fork draft does not exist on the
		// host yet, so its SOURCE profile is what the host would really inject.
		const previewProfileName = draft !== null ? draft.source : selectedName
		const preview = roleEditorState.preview !== null && roleEditorState.preview.kind === kind ? roleEditorState.preview : null
		const previewTasks = Array.isArray(snapshot.tasks) ? snapshot.tasks : []
		const templateText = target !== null && typeof target.prompt === 'string' ? target.prompt : ''
		const skillsText = target !== null && Array.isArray(target.skills) ? target.skills.join(', ') : ''
		const catalog = Array.isArray(roleEditorState.skills) ? roleEditorState.skills : []
		const allInstances = (Array.isArray(props.instances) ? props.instances : []).filter(function (entry) { return entry !== null && entry !== undefined && typeof entry.kind === 'string' })
		const instances = allInstances.filter(function (entry) { return entry.kind === kind })
		// The three stages, in dispatch order. The rail lists them as 01/02/03 and
		// they are the ONLY stage navigation on the page.
		const STAGE_SLOTS = [
			{ key: 'implement', kind: 'worker', num: '01', label: 'roleKindWorker', desc: 'roleStageImplementDesc' },
			{ key: 'review', kind: 'reviewer', num: '02', label: 'roleKindReviewer', desc: 'roleStageReviewDesc' },
			{ key: 'test', kind: 'tester', num: '03', label: 'roleKindTester', desc: 'roleStageTestDesc' },
		]
		const stageBoundProfile = function (stageKey) {
			const stages = config !== null && config !== undefined && config.stages !== null && config.stages !== undefined ? config.stages : {}
			return typeof stages[stageKey] === 'string' && stages[stageKey] !== '' ? stages[stageKey] : null
		}
		const templateRef = React.useRef(null)
		const skillsRef = React.useRef(null)
		// Real React reuses a host node across renders, so an uncontrolled control
		// only takes a new defaultValue when it REMOUNTS. The key carries the editor
		// identity AND whether the identity is still a draft: switching kind,
		// forking and a successful save all remount the controls on the right
		// profile instead of silently keeping the previous profile's text (which
		// would then be saved onto the wrong profile).
		const controlKey = kind + ':' + (draft !== null ? String(draft.name) : String(selectedName)) + ':' + (draft !== null ? 'draft' : 'saved')
		// What the selector shows as "in use": the draft's source while a draft is
		// open, otherwise the edited profile (falling back to the bound one).
		const useValue = draft !== null ? String(draft.source) : selectedName !== null ? String(selectedName) : String(kind)

		/**
		 * The identity a preview belongs to: kind + the saved profile + the chosen
		 * task. Changing any of them re-asks the host, so the right column can
		 * never show the injected text of a different identity.
		 */
		function previewKeyOf() {
			return kind + '|' + String(previewProfileName === null ? '' : previewProfileName) + '|' + String(roleEditorState.previewTaskId === undefined ? '' : roleEditorState.previewTaskId)
		}
		/** Ask the host for the injected text once per identity; a stale answer is dropped. */
		function ensurePreview() {
			if (roleEditorState.previewPending === true) return
			const key = previewKeyOf()
			if (roleEditorState.previewKey === key) return
			roleEditorState.previewKey = key
			roleEditorState.previewPending = true
			roleEditorState.previewError = null
			const body = { kind: kind }
			if (previewProfileName !== null) body.profile = String(previewProfileName)
			if (typeof roleEditorState.previewTaskId === 'string' && roleEditorState.previewTaskId !== '') body.taskId = roleEditorState.previewTaskId
			// Quiet: the preview is automatic, so its answer must never become the
			// panel's "your last action" result banner.
			Promise.resolve(store.send('rolesPreview', body, { quiet: true })).then(function (outcome) {
		const ok = outcome !== null && outcome !== undefined && outcome.ok === true
		const payload = outcome !== null && outcome !== undefined && outcome.payload !== undefined ? outcome.payload : null
		roleEditorState.previewPending = false
		if (roleEditorState.previewKey !== key) {
			bump()
			return
		}
		if (ok === true && payload !== null && typeof payload.text === 'string') {
			roleEditorState.preview = payload
			roleEditorState.previewError = null
		} else {
			roleEditorState.preview = null
			roleEditorState.previewError = payload !== null && typeof payload === 'object' ? payload : { code: 'preview-unavailable' }
		}
		bump()
			})
		}
		React.useEffect(function () {
			ensurePreview()
		})

		function currentTemplate() {
			const node = templateRef.current
			return node !== null && node !== undefined && typeof node.value === 'string' ? node.value : templateText
		}
		function currentSkills() {
			const node = skillsRef.current
			if (node !== null && node !== undefined && typeof node.value === 'string') return tcSplitList(node.value)
			return target !== null && Array.isArray(target.skills) ? target.skills.slice() : []
		}
		/** Discard a drop draft; nothing was ever written to the host. */
		function discardDraft() {
			roleEditorState.draft = null
			roleEditorState.saved = null
			roleEditorState.applySkipped = false
			roleEditorState.notice = null
			bump()
		}
		/** Fork is a DRAFT now: the user names it, then Save creates + applies it. */
		function fork() {
			if (target === null || selectedName === null) return
			let candidate = String(selectedName) + '-fork'
			let index = 2
			while (profiles[candidate] !== undefined || roleEditorState.used.has(candidate)) {
		candidate = String(selectedName) + '-fork-' + String(index)
		index += 1
			}
			roleEditorState.used.add(candidate)
			roleEditorState.draft = { source: String(selectedName), name: candidate, profile: roleProfileCopy(target) }
			roleEditorState.saved = null
			roleEditorState.applySkipped = false
			roleEditorState.notice = null
			bump()
		}
		// The editor reports its own outcome: a client-side refusal has no store
		// event, and the banner must survive the panel's re-render.
		function report(action, ok, payload) {
			roleEditorState.notice = { action: action, ok: ok, payload: payload }
			bump()
		}
		async function send(action, body) {
			const outcome = await store.send(action, body)
			const ok = outcome !== null && outcome !== undefined && outcome.ok === true
			const payload = outcome !== null && outcome !== undefined && outcome.payload !== undefined && outcome.payload !== null ? outcome.payload : null
			report(action, ok, payload)
			return { ok: ok, payload: payload }
		}
		/** Switch kind: an open draft blocks the switch (never a silent discard). */
		function switchKind(next) {
			if (draft !== null) {
		report('role-editor-kind', false, { code: 'role-unsaved' })
		return
			}
			roleEditorState.kind = next
			roleEditorState.draft = null
			roleEditorState.selected = null
			roleEditorState.saved = null
			roleEditorState.applySkipped = false
			roleEditorState.notice = null
			roleEditorState.preview = null
			roleEditorState.previewKey = null
			roleEditorState.previewPending = false
			roleEditorState.previewError = null
			bump()
		}
		/** Select a profile from the roster; an open draft blocks a silent switch. */
		function selectProfile(name, roleKind) {
			if (typeof name !== 'string' || name === '') return
			if (draft !== null && String(name) !== String(selectedName)) {
				report('role-editor-kind', false, { code: 'role-unsaved' })
				// The picker is controlled: the refused value never reaches it, and nothing
				// remounts, so a typed draft prompt/skills edit survives the refusal.
				return
			}
			roleEditorState.kind = typeof roleKind === 'string' && roleKind !== '' ? roleKind : kind
			roleEditorState.selected = name
			roleEditorState.saved = null
			roleEditorState.applySkipped = false
			roleEditorState.notice = null
			roleEditorState.preview = null
			roleEditorState.previewKey = null
			roleEditorState.previewPending = false
			roleEditorState.previewError = null
			bump()
		}
		/**
		 * ONE switch of "current use": bind the stage to the profile, then replace
		 * the running instances of this kind. With nothing live, only the binding
		 * changes and the panel says it takes effect on the next dispatch.
		 */
		async function applyProfile(name, roleKind) {
			// roleKind defaults to the stage being edited; a blank create can target a
			// different stage, so the caller passes the created profile's own kind.
			const profileKind = typeof roleKind === 'string' && ROLE_EDITOR_STAGES[roleKind] !== undefined ? roleKind : kind
			const profileStage = ROLE_EDITOR_STAGES[profileKind]
			roleEditorState.applySkipped = false
			const boundResult = await send('rolesBind', { stage: profileStage, profile: name })
			if (boundResult.ok !== true) {
		return false
			}
			roleEditorState.selected = name
			// Keep the optimistic copy of a just-created profile so the editor can
			// target it before the next host poll carries it.
			if (roleEditorState.saved !== null && roleEditorState.saved.name !== name) roleEditorState.saved = null
			// A profile change is configuration only: live children keep the prompt
			// they were started with, so there is nothing to drain or replace.
			roleEditorState.applySkipped = true
			bump()
			return true
		}
		/**
		 * The "current use" picker: one pick is one action. An open draft blocks the
		 * switch with a readable notice (never a silent discard); the controlled
		 * selector already shows the real value.
		 */
		async function chooseUse(name) {
			if (typeof name !== 'string' || name === '') return
			roleEditorState.notice = null
			if (draft !== null) {
		report('rolesBind', false, { code: 'role-unsaved' })
		return
			}
			if (name === boundName) {
		roleEditorState.selected = name
		roleEditorState.saved = null
		bump()
		return
			}
			await applyProfile(name)
		}
		/**
		 * Create the draft profile, then bind + replace it: Fork must take effect
		 * without a second click. A refused create keeps the draft for a retry.
		 */
		async function commitDraft(name, fromEditor) {
			const submitted = roleEditorState.draft
			if (submitted === null || submitted.name !== name) return
			// Fork copies the source profile as-is; a retry after a refused create
			// must keep whatever the user typed into the editor.
			const body = fromEditor === true
		? Object.assign({}, submitted.profile, { prompt: currentTemplate(), skills: currentSkills() })
		: Object.assign({}, submitted.profile)
			const outcome = await send('rolesCreate', { name: name, profile: body })
			if (outcome.ok !== true || roleEditorState.draft !== submitted) return
			roleEditorState.draft = null
			roleEditorState.selected = name
			roleEditorState.saved = { name: name, profile: Object.assign({}, body, { name: name }) }
			bump()
			await applyProfile(name)
		}
		async function save() {
			// A stale banner must never be read as this attempt's outcome; report() replaces it.
			roleEditorState.notice = null
			const template = currentTemplate()
			const skills = currentSkills()
			if (draft !== null) {
		// The draft name is validated here (kebab-case + uniqueness) exactly
		// like the host would: the same refusal codes are shown.
		const proposed = String(draft.name)
		if (!/^[a-z][a-z0-9-]{0,40}$/.test(proposed)) {
			report('rolesCreate', false, { code: 'invalid-role-name' })
			return
		}
		if (profiles[proposed] !== undefined) {
			report('rolesCreate', false, { code: 'role-exists' })
			return
		}
		await commitDraft(proposed, true)
		return
			}
			if (selectedName === null) return
			if (builtin) {
		// The built-in profiles are host defaults; fork a copy to change them.
		report('rolesUpdate', false, { code: 'builtin-profile-readonly' })
		return
			}
			const outcome = await send('rolesUpdate', { name: selectedName, profile: { prompt: template, skills: skills } })
			if (outcome.ok !== true) return
			// Keep the saved values visible until the host snapshot catches up.
			roleEditorState.saved = { name: selectedName, profile: Object.assign({}, target === null ? {} : target, { prompt: template, skills: skills }) }
			bump()
		}
		/** Delete this copy; if it was in use, the built-in default takes over at once. */
		async function remove() {
			roleEditorState.notice = null
			if (selectedName === null || builtin) return
			const name = selectedName
			const wasBound = name === boundName
			const outcome = await send('rolesDelete', { name: name })
			if (outcome.ok !== true) return
			roleEditorState.selected = null
			roleEditorState.saved = null
			roleEditorState.applySkipped = false
			bump()
			if (wasBound) await applyProfile(kind)
		}
		async function openSkills() {
			roleEditorState.skillsOpen = true
			roleEditorState.skillsError = null
			roleEditorState.skillsSelected = new Set(currentSkills())
			bump()
			const outcome = await store.send('skillsCatalog', {})
			const ok = outcome !== null && outcome !== undefined && outcome.ok === true
			const payload = outcome !== null && outcome !== undefined && outcome.payload !== undefined ? outcome.payload : null
			if (ok === true) {
		roleEditorState.skills = payload !== null && payload !== undefined && Array.isArray(payload.skills) ? payload.skills : []
		roleEditorState.skillsError = null
			} else {
		roleEditorState.skills = null
		roleEditorState.skillsError = payload === null || payload === undefined ? { code: 'skills-unavailable' } : payload
			}
			bump()
		}
		function toggleSkill(name) {
			if (roleEditorState.skillsSelected.has(name)) roleEditorState.skillsSelected.delete(name)
			else roleEditorState.skillsSelected.add(name)
			bump()
		}
		function saveSkills() {
			const names = Array.from(roleEditorState.skillsSelected)
			const node = skillsRef.current
			if (node !== null && node !== undefined) node.value = names.join(', ')
			if (draft !== null) draft.profile.skills = names.slice()
			roleEditorState.skillsOpen = false
			bump()
		}
		/** One line: every variable the template may use, with its value for this task. */
		function tokenLine() {
			const tokens = preview !== null && Array.isArray(preview.tokens) ? preview.tokens : []
			if (tokens.length === 0) return t('rolePreviewMissing')
			return tokens.map(function (token) {
		const raw = token.value === undefined || token.value === null ? '' : String(token.value)
		return '{{' + String(token.name) + '}} → ' + (raw === '' ? t('rolePreviewEmptyValue') : raw)
			}).join(' · ')
		}
		/** Choose the task the injected preview is generated for ('' means auto). */
		function choosePreviewTask(id) {
			const next = typeof id === 'string' ? id : ''
			if (roleEditorState.previewTaskId === next) return
			roleEditorState.previewTaskId = next
			roleEditorState.preview = null
			roleEditorState.previewKey = null
			roleEditorState.previewPending = false
			roleEditorState.previewError = null
			bump()
		}
		/** A section's user-language label: own text, task data or host copy. */
		function sectionGroupLabel(group) {
			if (group === 'role') return t('roleSectionRole')
			if (group === 'template') return builtin ? t('rolePreviewGroupBuiltin') : t('roleAnchorPrompt')
			if (group === 'task') return t('rolePreviewGroupTask')
			if (group === 'skills') return t('roleSkills')
			if (group === 'rules') return t('roleRules')
			if (group === 'fixed') return t('roleAnchorBoundary')
			return t('roleSectionRole')
		}
		/** The right-hand source note of a section (host-fixed / auto-filled / …). */
		function sectionSourceLabel(group) {
			if (group === 'role') return t('roleSourceHostFixed')
			if (group === 'task') return t('roleSourceAuto')
			if (group === 'skills') return t('roleSourceHostInjected')
			if (group === 'rules') return t('roleSourceHostFixed')
			if (group === 'fixed') return t('roleSourceUnoverridable')
			return builtin ? t('roleSourceHostFixed') : t('roleSourceAuto')
		}
		/** Left column: the profile prompt as written, with its literal {{TOKEN}}s. */
		function rawColumn() {
			return h('div', { className: 'gbt-rolecardbody', 'data-role-prompt': 'raw', 'data-role-raw-readonly': 'false', 'data-role-raw-reason': '' },
		h('textarea', { key: 'template-field:' + controlKey, ref: templateRef, className: 'gbt-input gbt-editorarea', 'data-field': 'template', rows: 10, defaultValue: templateText, placeholder: t('rolePromptEmpty'), spellCheck: false }),
		h('p', { className: 'gbt-footnote', 'data-role-tokens': 'true' }, tokenLine()))
		}
		/**
		 * Left column for a built-in role: its READABLE default prompt, shown
		 * read-only and with literal {{TOKEN}}s (no substitution), plus the note
		 * that it cannot be edited in place and the existing Fork action that
		 * copies it into an editable draft.
		 */
		function builtinDefaultColumn() {
			const defaultPrompt = target !== null && typeof target.prompt === 'string' ? target.prompt : ''
			return h('div', { className: 'gbt-rolecardbody', 'data-role-prompt': 'raw', 'data-role-raw-readonly': 'true', 'data-role-raw-reason': 'builtin', 'data-role-empty-state': 'builtin', 'data-role-default-prompt': defaultPrompt === '' ? 'false' : 'true' },
		defaultPrompt === ''
			? h('div', { className: 'gbt-promptempty', 'data-role-raw-empty': 'builtin' }, h('p', { className: 'gbt-footnote' }, t('rolePreviewBuiltinReadonly')))
			: h('pre', { className: 'gbt-promptpre gbt-builtinprompt', 'data-role-default-prompt-text': 'true' }, defaultPrompt),
		h('div', { className: 'gbt-promptactions' },
			h('span', { className: 'gbt-footnote', 'data-role-builtin-note': 'true' }, t('roleEmptyBuiltinTitle'))))
		}
		/** Right column: the exact text the host injects, section by section. */
		function injectedColumn() {
			const previewTask = preview !== null && preview.task !== undefined && preview.task !== null ? preview.task : null
			const sample = previewTask !== null && previewTask.sample === true
			const taskValue = typeof roleEditorState.previewTaskId === 'string' ? roleEditorState.previewTaskId : ''
			const sections = preview !== null && Array.isArray(preview.sections) ? preview.sections : []
			return h('div', { className: 'gbt-rolecardbody', 'data-role-prompt': 'injected' },
		h('div', { className: 'gbt-prompthead' },
			h('div', { className: 'gbt-subhead' }, t('rolePreviewInjectedTitle')),
			h('div', { className: 'gbt-prompttaskrow', 'data-role-taskrow': 'true' },
				h('label', { className: 'gbt-editor-select' }, t('rolePreviewTaskPick'),
			h('select', { key: 'preview-task:' + controlKey, className: 'gbt-input', 'data-field': 'preview-task', 'data-task-id': taskValue, defaultValue: taskValue, onChange: function (event) { choosePreviewTask(event !== null && event !== undefined && event.target !== undefined ? event.target.value : '') } },
				h('option', { key: 'auto', value: '' }, t('rolePreviewTaskAuto')),
				previewTasks.map(function (task) {
					return h('option', { key: String(task.id), value: String(task.id) }, String(task.id) + ' · ' + String(task.title))
				}))),
				previewTask === null
			? null
			: h('span', { className: 'gbt-pill', 'data-role-task-source': sample ? 'sample' : 'real', 'data-task-id': String(previewTask.id) }, sample ? t('rolePreviewSampleTask') : String(previewTask.id) + ' · ' + String(previewTask.title)))),
		preview === null
			? h('div', { className: 'gbt-footnote', 'data-role-preview-state': roleEditorState.previewPending === true ? 'loading' : 'unavailable' },
			roleEditorState.previewError !== null && roleEditorState.previewError !== undefined && typeof roleEditorState.previewError.code === 'string'
				? t('rolePreviewFailed') + ' (' + roleEditorState.previewError.code + ')'
				: roleEditorState.previewPending === true
					? t('rolePreviewLoading')
					: t('rolePreviewMissing'))
			: h('div', { className: 'gbt-prompttext', 'data-role-preview-text': 'true' }, (function () {
			let lastGroup = null
			return sections.map(function (section, index) {
				const key = String(section.key === undefined || section.key === null ? index : section.key)
				const group = String(section.group === undefined || section.group === null ? 'fixed' : section.group)
				const firstOfGroup = group !== lastGroup
				lastGroup = group
				return h('div', { key: key + ':' + String(index), className: 'gbt-promptsection', 'data-role-section': key, 'data-role-section-group': group },
					firstOfGroup
				? h('div', { className: 'gbt-secthead', 'data-role-section-head': 'true' },
						h('span', { className: 'gbt-sectlabel', 'data-role-section-label': group }, sectionGroupLabel(group)),
						h('span', { className: 'gbt-sectsource', 'data-role-section-source': group }, sectionSourceLabel(group)))
				: null,
					h('pre', { className: 'gbt-promptpre' }, typeof section.text === 'string' ? section.text : ''))
			})
				})()))
		}
		// APPLICATION / 当前使用: picking a profile binds the stage and replaces its
		// running instances (the binding control, not the editor's profile picker).
		const currentUseSelect = h('label', { className: 'gbt-editor-select gbt-rolescurrent' }, t('roleCurrentUse'),
			h('select', {
				key: 'current-use:' + controlKey,
				className: 'gbt-input',
				'data-role-use-select': 'true',
				'data-field': 'current-use',
				'data-stage': stage,
				'data-bound': boundName === null ? '' : String(boundName),
				value: useValue,
				onChange: function (event) { void chooseUse(event !== null && event !== undefined && event.target !== undefined ? String(event.target.value) : '') },
			},
			useOptions.length === 0
				? h('option', { key: 'none', value: '' }, t('roleEditorNoProfile'))
				: useOptions.map(function (name) { return h('option', { key: name, value: name }, name === kind ? t('roleUseDefault') : name) })))
		// ── Stage rail (A direction): the ONLY stage navigation. The old top
		// stage strip and the roster column are gone; a custom copy is picked from the
		// rail's profile selector and blank creation lives in its footer.
		const currentSlot = STAGE_SLOTS.filter(function (slot) { return slot.kind === kind })[0] || STAGE_SLOTS[0]
		function liveCountOfKind(roleKind) {
			return allInstances.filter(function (entry) { return entry.kind === roleKind && entry.status !== 'failed' }).length
		}
		/** The stage default is shown by its own name, a custom copy by its name. */
		function profileLabelOf(slot, name) {
			if (name === null || name === undefined) return t('roleUseDefault')
			return String(name) === slot.kind ? t('roleUseDefault') : String(name)
		}
		function stageStateOf(slot) {
			if (slot.kind === kind) return draft !== null ? t('roleEditorDraft') : t('roleStageCurrent')
			return stageBoundProfile(slot.key) === null ? t('roleStageUnbound') : t('roleStageEnabled')
		}
		// The page header reports whether THIS profile is applied: a draft, the one
		// in use, or a copy that is not bound to its stage right now.
		const headApplied = draft !== null ? 'draft' : selectedName !== null && boundName !== null && String(selectedName) === String(boundName) ? 'enabled' : 'idle'
		const headAppliedLabel = headApplied === 'draft' ? t('roleEditorDraft') : headApplied === 'enabled' ? t('roleStageEnabled') : t('roleStageUnbound')
		// The profile picker: the stage default plus every custom copy that owns this
		// stage. Picking one edits it; binding stays in APPLICATION, exactly as before.
		const pickerValue = draft !== null ? String(draft.source) : selectedName === null ? String(kind) : String(selectedName)
		const profilePicker = h('select', {
			key: 'profile-picker:' + controlKey,
			className: 'gbt-stageselect',
			'data-role-profile-select': 'true',
			'data-field': 'profile',
			'data-stage': stage,
			'data-kind': kind,
			value: pickerValue,
			onChange: function (event) {
				const next = event !== null && event !== undefined && event.target !== undefined ? String(event.target.value) : ''
				selectProfile(next === '' ? kind : next, kind)
			},
		}, useOptions.map(function (name) {
			return h('option', { key: name, value: name }, name === kind ? t('roleUseDefault') : name)
		}))
		const stageRail = h('aside', { className: 'gbt-rolestagerail', 'data-role-stage-rail': 'true', 'data-role-nav': 'stages', 'aria-label': t('roleStagesTitle') },
			h('div', { className: 'gbt-stageprofile', 'data-role-profile-picker': 'true' },
				h('span', { className: 'gbt-deckeyebrow' }, t('roleProfileEyebrow')),
				profilePicker),
			h('div', { className: 'gbt-rail-title' },
				h('span', null, t('roleStagesTitle')),
				h('em', { className: 'gbt-mono' }, '0' + String(STAGE_SLOTS.length))),
			h('ol', { className: 'gbt-stagelist', 'data-role-stage-list': 'true' }, STAGE_SLOTS.map(function (slot) {
				const boundProfile = stageBoundProfile(slot.key)
				const bound = boundProfile !== null && profiles[boundProfile] !== undefined ? boundProfile : null
				const live = liveCountOfKind(slot.kind)
				const active = slot.kind === kind
				return h('li', { key: 'stage-' + slot.key, className: 'gbt-stageli' },
					h('button', {
						type: 'button',
						className: 'gbt-stagerow',
						'data-action': 'role-editor-kind',
						'data-kind': slot.kind,
						'data-stage-slot': slot.key,
						'data-roles-stage': slot.kind,
						// Kept so the existing screenshot steps can still click a stage by
						// the attribute they always used; the rail is the only stage nav.
						'data-roles-tab': slot.kind,
						'data-active': active ? 'true' : 'false',
						'data-bound-profile': bound === null ? '' : String(bound),
						'data-live': String(live),
						'data-ready': bound === null ? 'false' : 'true',
						'aria-current': active ? 'step' : undefined,
						onClick: function () { switchKind(slot.kind) },
					},
						h('span', { className: 'gbt-stagenum gbt-mono', 'aria-hidden': 'true' }, slot.num),
						h('span', { className: 'gbt-stagebody' },
							h('span', { className: 'gbt-stagetitle' }, h('b', null, t(slot.label)), h('code', { className: 'gbt-mono' }, slot.kind)),
							h('span', { className: 'gbt-stagedesc' }, t(slot.desc)),
							h('span', { className: 'gbt-stagemeta' },
								h('span', { className: 'gbt-stagetag', 'data-role-stage-state': slot.key }, stageStateOf(slot)),
								h('span', { className: 'gbt-stagesub gbt-mono', 'data-role-stage-bound': slot.key, title: bound === null ? '' : String(bound) }, '\u00B7 ' + profileLabelOf(slot, bound)))),
						h('span', { className: 'gbt-stageside' },
							h('i', { className: 'gbt-deckdot', 'data-on': bound === null ? 'false' : 'true' }),
							h('em', { className: 'gbt-stagelive gbt-mono', 'data-role-stage-live': slot.key }, String(live))))
				)
			})),
			h('p', { className: 'gbt-stagenote', 'data-role-stages-hint': 'true' }, t('roleStagesHint')),
			h('div', { className: 'gbt-stagecreatewrap' },
				h('details', { key: 'roster-create', className: 'gbt-stagecreate', 'data-section': 'role-create-blank', 'data-role-create-entry': 'true' },
					h('summary', { 'data-role-create-summary': 'true' }, '＋ ' + t('roleEditorCreateBlank')),
					h('div', { className: 'gbt-stagecreatebody', 'data-role-create-body': 'true' }, h(RoleCreateForm, { t: t, defaultRole: kind, onCreate: createBlank, onInvalid: createBlankInvalid })))))
		const head = h('div', { className: 'gbt-rolehead', 'data-role-head': 'true' },
			h('div', { className: 'gbt-roleheadmain' },
				h('span', { className: 'gbt-deckeyebrow', 'data-role-head-stage': currentSlot.key }, 'STAGE ' + currentSlot.num + ' · ' + String(stage).toUpperCase()),
				h('h2', { className: 'gbt-roleheadtitle', 'data-role-head-title': 'true' },
					selectedName === null ? '—' : String(selectedName),
					h('span', { className: 'gbt-roleheadstage' }, '/ ' + t(currentSlot.label)))),
			h('div', { className: 'gbt-roleheadmeta' },
				h('span', { className: 'gbt-pill', 'data-role-head-state': headApplied }, headAppliedLabel),
				h('span', { className: 'gbt-footnote', 'data-role-head-bound': 'true' }, t('roleCurrentUse') + ' · ' + (boundName === null ? '—' : profileLabelOf(currentSlot, boundName)))))
		// IDENTITY is read-only: the role name, its stage and the context the host
		// resolves. Editing happens in BEHAVIOR/APPLICATION below, and in the rail
		// for stage and profile selection.
		const identityRow = h('div', { className: 'gbt-roleidentity', 'data-editor-identity': 'true', 'data-kind': kind, 'data-profile': selectedName === null ? '' : String(selectedName), 'data-bound': boundName === null ? '' : String(boundName), 'data-draft': draft === null ? 'false' : 'true' },
			h('div', { className: 'gbt-identitygrid' },
				h('label', { className: 'gbt-identityfield' }, h('span', null, t('roleName'), h('em', { className: 'gbt-identityhint' }, t('roleReadonly'))),
					h('input', { className: 'gbt-input gbt-readonlyfield', readOnly: true, tabIndex: -1, 'data-field': 'identity-name', value: selectedName === null ? '—' : String(selectedName) })),
				h('label', { className: 'gbt-identityfield' }, h('span', null, t('roleStageField')),
					h('input', { className: 'gbt-input gbt-readonlyfield', readOnly: true, tabIndex: -1, 'data-field': 'identity-stage', value: t(currentSlot.label) + ' / ' + String(stage) })),
				h('label', { className: 'gbt-identityfield' }, h('span', null, t('roleContext')),
					h('input', { className: 'gbt-input gbt-readonlyfield', readOnly: true, tabIndex: -1, 'data-field': 'identity-context', value: target !== null && typeof target.context === 'string' ? target.context : 'fresh' }))))
		const skillsRow = h('div', { className: 'gbt-editorskills', 'data-section': 'role-editor-skills' },
			h('label', { className: 'gbt-editorskills-field' }, t('roleSkills'), h('input', { key: 'skills-field:' + controlKey, ref: skillsRef, className: 'gbt-input', 'data-field': 'skills', defaultValue: skillsText, spellCheck: false })),
			h('button', { type: 'button', className: 'gbt-btn', 'data-action': 'role-editor-skills-manage', onClick: function () { void openSkills() } }, t('roleEditorSkillsManage')))
		/** The blank-create form reports in the same banner as every other action. */
		async function createBlank(name, fields) {
			const outcome = await send('rolesCreate', { name: name, profile: fields })
			if (outcome.ok !== true) return
			// The entry is stage-scoped, but the form may have picked another kind:
			// land the editor on the created kind and bind that stage, never the old one.
			const createdKind = fields !== null && fields !== undefined && ['worker', 'reviewer', 'tester'].indexOf(fields.role) >= 0 ? fields.role : kind
			roleEditorState.kind = createdKind
			roleEditorState.selected = name
			roleEditorState.saved = { name: name, profile: Object.assign({ name: name }, fields) }
			bump()
			await applyProfile(name, createdKind)
		}
		function createBlankInvalid(code) {
			report('rolesCreate', false, { code: code, message: '' })
		}
		const runningNames = instances.filter(function (entry) { return entry.kind === kind }).map(function (entry) { return entry.name })
		const runningRow = h('div', { className: 'gbt-footnote', 'data-role-running': 'true' },
			t('roleRunningNow') + ': ' + (runningNames.length === 0 ? t('roleNoneRunning') : runningNames.join(', ')) + ' · ' + (boundName === kind ? t('roleFromDefault') : t('roleFromCopy')))
		const stateHint = draft !== null
			? h('div', { className: 'gbt-footnote', 'data-role-draft-hint': 'true' }, t('roleDraftHint'))
			: roleEditorState.applySkipped === true
				? h('div', { className: 'gbt-footnote', 'data-editor-apply-skipped': 'true' }, t('roleUsePendingNextDispatch'))
				: null
		const sectionHead = function (eyebrow, title, note) {
			return h('div', { className: 'gbt-rolesectionhead' }, h('span', { className: 'gbt-deckeyebrow' }, eyebrow), h('h3', null, title), note === undefined ? null : h('span', { className: 'gbt-footnote gbt-sectionnote' }, note))
		}
		const leftPane = h('section', { className: 'gbt-rolespane gbt-roleseditorpane', 'data-roles-pane': 'raw' },
			h('section', { className: 'gbt-rolesection', 'data-role-section': 'identity' }, sectionHead('IDENTITY / 身份', t('roleSectionRole'), draft !== null ? t('roleEditorDraft') : builtin ? t('roleBuiltin') : t('roleCustom')), identityRow),
			h('section', { className: 'gbt-rolesection', 'data-role-section': 'behavior' }, sectionHead('BEHAVIOR / 行为', t('roleAnchorPrompt')),
				h('div', { className: 'gbt-rolecard', 'data-role-card': 'raw' },
					editablePrompt ? rawColumn() : builtinDefaultColumn(),
					h('div', { className: 'gbt-rolefields', 'data-section': 'role-editor-fields' }, skillsRow))),
			h('section', { className: 'gbt-rolesection', 'data-role-section': 'application' }, sectionHead('APPLICATION / 应用', t('roleCurrentUse')), currentUseSelect, h('div', { className: 'gbt-footnote', 'data-role-apply-hint': 'true' }, t('roleApplyHint')), runningRow),
			)
		const rightPane = h('section', { className: 'gbt-rolespane gbt-rolespreviewpane', 'data-roles-pane': 'injected' },
			h('div', { className: 'gbt-rolespreviewhead' }, h('span', { className: 'gbt-deckeyebrow' }, 'PREVIEW / 注入预览')),
			h('div', { className: 'gbt-rolecard', 'data-role-card': 'injected' }, injectedColumn()),
			stateHint)
		const draftNameRow = draft === null ? null : h('label', { className: 'gbt-editorfield', 'data-section': 'role-draft-name' }, t('roleDraftName'),
			h('input', { key: 'draft-name:' + controlKey, className: 'gbt-input', 'data-field': 'draft-name', defaultValue: draft.name, spellCheck: false, onChange: function (event) {
				const next = event !== null && event !== undefined && event.target !== undefined ? String(event.target.value) : ''
				if (roleEditorState.draft !== null) roleEditorState.draft.name = next
			} }))
		const modal = roleEditorState.skillsOpen === true
			? h('div', { className: 'gbt-overlay', 'data-modal': 'role-skills' },
				h('div', { className: 'gbt-modal' },
					h('div', { className: 'gbt-modalhead' },
						h('h2', null, t('roleEditorSkillsTitle') + (selectedName === null ? '' : ' · ' + String(selectedName))),
						h('button', { type: 'button', className: 'gbt-iconbtn', 'data-action': 'role-skills-close', onClick: function () { roleEditorState.skillsOpen = false; bump() } }, '×')),
					roleEditorState.skillsError !== null
						? h('div', { className: 'gbt-banner', 'data-tone': 'error', 'data-skills-unavailable': String(roleEditorState.skillsError.code === undefined || roleEditorState.skillsError.code === null ? 'skills-unavailable' : roleEditorState.skillsError.code) }, t('roleErrSkillsUnavailable') + '（' + String(roleEditorState.skillsError.code === undefined || roleEditorState.skillsError.code === null ? 'skills-unavailable' : roleEditorState.skillsError.code) + '）' + (typeof roleEditorState.skillsError.message === 'string' && roleEditorState.skillsError.message !== '' ? ' · ' + roleEditorState.skillsError.message : ''))
						: null,
					roleEditorState.skillsError === null && catalog.length === 0 ? h('div', { className: 'gbt-empty' }, t('roleEditorSkillsEmpty')) : null,
					catalog.map(function (skill) {
						const name = String(skill.name)
						return h('label', { key: name, className: 'gbt-check gbt-skillrow', 'data-skill-row': name },
							h('input', { type: 'checkbox', 'data-skill': name, checked: roleEditorState.skillsSelected.has(name), onChange: function () { toggleSkill(name) } }),
							h('span', { className: 'gbt-mono' }, name),
							h('span', { className: 'gbt-footnote' }, ' ' + String(skill.description === undefined || skill.description === null ? '' : skill.description)),
							skill.invocation !== null && skill.invocation !== undefined && skill.invocation.modelInvocable === false
								? h('span', { className: 'gbt-pill', 'data-skill-user-only': name }, t('roleEditorSkillUserOnly'))
								: null)
					}),
					h('div', { className: 'gbt-formactions' }, h('button', { type: 'button', className: 'gbt-btn', 'data-variant': 'primary', 'data-action': 'role-skills-save', onClick: saveSkills }, t('roleEditorSkillsSave')))))
			: null
		const saveButton = h('button', { type: 'button', className: 'gbt-btn', 'data-variant': 'primary', 'data-action': 'role-editor-save', onClick: function () { void save() } }, t('roleSave'))
		const discardButton = h('button', { type: 'button', className: 'gbt-btn', 'data-action': 'role-editor-discard', onClick: discardDraft }, t('roleDiscard'))
		const forkButton = builtin
			? h('button', { type: 'button', className: 'gbt-btn', 'data-action': 'role-editor-fork', 'data-role-empty-fork': 'true', onClick: fork }, t('roleEmptyCopy'))
			: null
		const deleteButton = draft === null && editablePrompt && selectedName !== null && profiles[selectedName] !== undefined
			? h('button', { type: 'button', className: 'gbt-btn', 'data-action': 'rolesDelete', 'data-role-delete-copy': 'true', onClick: function () { void remove() } }, t('roleDeleteThis'))
			: null
		const actionBar = h('div', { className: 'gbt-rolesactions', 'data-roles-actions': 'true' },
			h('div', { className: 'gbt-rolesactions-left' },
				draft !== null ? discardButton : null,
				draft !== null || (editablePrompt && selectedName !== null) ? saveButton : null,
				draftNameRow),
			h('div', { className: 'gbt-rolesactions-right' }, forkButton, deleteButton))
		return h('div', { className: 'gbt-roleeditor', 'data-editor': 'true', 'data-role-deck': 'true', 'data-kind': kind, 'data-draft': draft === null ? 'false' : 'true' },
			h('div', { className: 'gbt-rolesworkspace', 'data-role-workspace': 'true' },
				stageRail,
				h('div', { className: 'gbt-rolesmain', 'data-role-editor-main': 'true' },
					head,
					h('div', { className: 'gbt-roleseditscroll', 'data-roles-scroll': 'true' },
						h('div', { className: 'gbt-rolespanes', 'data-roles-panes': 'true', 'data-role-layout': 'split' }, leftPane, rightPane)),
					actionBar)),
			roleEditorState.notice === null ? null : roleResultBanner(roleEditorState.notice, t),
			modal)
	}

	/**
	 * The Roles tab: ONE card, the context editor. Reloading the profiles is an
	 * explicit action in the card header, and the batch actions (replace kind /
	 * reset defaults) live next to the primary editor actions. The old
	 * stand-alone stages/profiles/previews/create cards are gone — this editor
	 * replaced them.
	 */

	return RolesEditor
}

module.exports = { createRolesEditor }
