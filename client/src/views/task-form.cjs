/**
 * Task create/edit form view module.
 *
 * Extracted from the forms fragment; React, h, Modal, list/error helpers and
 * the panel store are injected by the build.
 */
function createTaskForm(deps) {
	const React = deps.React
	const h = deps.h
	const Modal = deps.Modal
	const tcParseList = deps.tcParseList
	const tcParseFiles = deps.tcParseFiles
	const tcErrorMessage = deps.tcErrorMessage
	const store = deps.store

	function TaskForm(props) {
		const t = props.t
		const task = props.task
		const title = React.useRef(null)
		const spec = React.useRef(null)
		const acceptance = React.useRef(null)
		const priority = React.useRef(null)
		const deps = React.useRef(null)
		const files = React.useRef(null)
		const note = React.useRef(null)
		const targetBranch = React.useRef(null)
		const [busy, setBusy] = React.useState(false)
		const [error, setError] = React.useState('')
		const running = task !== null && task.status === 'running'
		const suggestions = props.snapshot.tasks.filter(function (entry) {
			return task === null || entry.id !== task.id
		})

		function appendDependency(id) {
			if (deps.current === null) return
			const current = String(deps.current.value || '')
			const present = tcParseList(current)
			if (present.indexOf(id) >= 0) return
			deps.current.value = present.concat([id]).join(', ')
		}

		function save() {
			const value = title.current === null ? '' : String(title.current.value || '').trim()
			if (value === '') {
		setError(t('titleRequired'))
		return
			}
			const body = {
		title: value,
		spec: spec.current === null ? '' : String(spec.current.value || ''),
		acceptance: acceptance.current === null ? '' : String(acceptance.current.value || ''),
		priority: priority.current === null ? 0 : Number(priority.current.value || 0),
		// Empty clears back to the project default; a name pins this task's target.
		target: targetBranch.current === null ? '' : String(targetBranch.current.value || '').trim(),
			}
			if (!running) {
		body.dependsOn = tcParseList(deps.current === null ? '' : deps.current.value)
		body.writeFiles = tcParseFiles(files.current === null ? '' : files.current.value)
			}
			if (note.current !== null && String(note.current.value || '').trim() !== '') body.note = String(note.current.value).trim()
			setBusy(true)
			setError('')
			const action = task === null ? 'create' : 'update'
			if (task !== null) body.id = task.id
			void store.send(action, body).then(function (result) {
		setBusy(false)
		if (result.ok === true) {
			props.onSaved()
			return
		}
		const payload = result.payload === undefined || result.payload === null ? {} : result.payload
		setError(result.payload !== undefined && result.payload !== null ? tcErrorMessage(result.payload, t) : String((result.error && result.error.message) || t('error')))
			})
		}

		return h(
			Modal,
			{ title: task === null ? t('newTask') : t('edit'), onClose: props.onClose, t: t },
			h(
		'div',
		{ className: 'gbt-form' },
		h('div', { className: 'gbt-field' }, h('label', null, t('taskTitle')), h('input', { className: 'gbt-input', ref: title, defaultValue: task === null ? '' : task.title, placeholder: t('titleRequired') })),
		h('div', { className: 'gbt-row2' },
			h('div', { className: 'gbt-field' }, h('label', null, t('priority')), h('input', { className: 'gbt-input', ref: priority, type: 'number', defaultValue: task === null ? 0 : task.priority }))),
		h('div', { className: 'gbt-field' }, h('label', null, t('spec')), h('textarea', { className: 'gbt-area', ref: spec, defaultValue: task === null ? '' : task.spec })),
		h('div', { className: 'gbt-field' }, h('label', null, t('acceptance')), h('textarea', { className: 'gbt-area', ref: acceptance, defaultValue: task === null ? '' : task.acceptance })),
		h('div', { className: 'gbt-field' },
			h('label', null, t('dependencies')),
			h('input', { className: 'gbt-input', ref: deps, defaultValue: task === null ? '' : (task.dependsOn || []).join(', '), placeholder: t('dependsPlaceholder'), disabled: running }),
			running ? null : h('div', { className: 'gbt-cardmeta' }, suggestions.slice(0, 12).map(function (entry) { return h('button', { key: entry.id, type: 'button', className: 'gbt-chip', onClick: function () { appendDependency(entry.id) } }, entry.id + ' · ' + entry.title) }))),
		h('div', { className: 'gbt-field' }, h('label', null, t('files')), h('textarea', { className: 'gbt-area', ref: files, defaultValue: task === null ? '' : (task.writeFiles || []).join('\n'), placeholder: t('filesPlaceholder'), disabled: running })),
		h('div', { className: 'gbt-field' }, h('label', null, t('targetBranch')), h('input', { className: 'gbt-input', ref: targetBranch, 'data-field': 'target-branch', defaultValue: task === null || typeof task.target !== 'string' ? '' : task.target, placeholder: t('targetFollowDefault') })),
		h('div', { className: 'gbt-field' }, h('label', null, t('note')), h('input', { className: 'gbt-input', ref: note, placeholder: t('notePlaceholder') })),
		error === '' ? null : h('p', { className: 'gbt-footnote', style: { color: 'var(--dsw-alias-state-error-primary)' } }, error),
		h('div', { className: 'gbt-actions' },
			h('button', { type: 'button', className: 'gbt-btn', 'data-variant': 'primary', disabled: busy, onClick: save }, task === null ? t('create') : t('update')),
			h('button', { type: 'button', className: 'gbt-btn', onClick: props.onClose }, t('cancel'))),
			),
		)
	}


	return TaskForm
}

module.exports = { createTaskForm }
