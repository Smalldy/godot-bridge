#!/usr/bin/env node
// Build the browser half from client/src into client/client.js.
//
// The bundle is one classic script: the DSH module loader wraps a factory.
// Pure selectors and the Host-backed store are CommonJS modules so they can be
// unit-tested; this script inlines them into the factory scope with tiny
// wrappers. Everything else is still a .part fragment.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(ROOT, 'client', 'src')
const OUT = join(ROOT, 'client', 'client.js')
const VIEW_PARTS = [
  '30-views-core.part',
  '31-views-queue.part',
  '32-views-roles.part',
  '33-views-status.part',
  '34-views-detail.part',
  '35-views-forms.part',
  '36-views-shell.part',
]
const REQUIRED = ['00-head.part', '15-client-state.part'].concat(VIEW_PARTS).concat(['40-tail.part'])

const present = readdirSync(SRC).filter((name) => name.endsWith('.part')).sort()
const missing = REQUIRED.filter((name) => present.indexOf(name) < 0)
if (missing.length > 0) {
  console.error('build:client: missing part(s): ' + missing.join(', '))
  process.exit(1)
}

function read(name) {
  return readFileSync(join(SRC, name), 'utf8')
}

function exportedNames(source, label) {
  const match = source.match(/module\.exports\s*=\s*\{([\s\S]*?)\}/)
  if (match === null) {
    console.error('build:client: ' + label + ' has no module.exports')
    process.exit(1)
  }
  return match[1]
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0)
}

const selectors = read('selectors.cjs')
const selectorNames = exportedNames(selectors, 'selectors.cjs')
const selectorWrapper =
  '\nconst { ' +
  selectorNames.join(', ') +
  ' } = (function () {\n' +
  '\tconst module = { exports: {} }\n' +
  '\t;(function (module, exports) {\n' +
  selectors +
  '\n\t})(module, module.exports)\n' +
  '\treturn module.exports\n' +
  '})()\n'

const store = read('store.cjs')
const storeNames = exportedNames(store, 'store.cjs')
const depsMatch = store.match(/const \{([\s\S]*?)\} = deps/)
if (depsMatch === null) {
  console.error('build:client: store.cjs has no deps destructure')
  process.exit(1)
}
const storeDeps = depsMatch[1]
  .split(',')
  .map((name) => name.trim())
  .filter((name) => name.length > 0)
const storeWrapper =
  '\nconst createTaskStore = (function () {\n' +
  '\tconst module = { exports: {} }\n' +
  '\t;(function (module, exports) {\n' +
  store +
  '\n\t})(module, module.exports)\n' +
  '\tconst factory = module.exports.createTaskStore\n' +
  '\treturn function (t) {\n' +
  '\t\treturn factory(t, {\n' +
  storeDeps.map((name) => '\t\t\t' + name + ': ' + name + ',').join('\n') +
  '\n\t\t})\n' +
  '\t}\n' +
  '})()\n'

const taskCard = read('views/task-card.cjs')
const taskCardWrapper =
  '\t\t\tconst TaskCard = (function () {\n' +
  '\t\t\t\tconst module = { exports: {} }\n' +
  '\t\t\t\t;(function (module, exports) {\n' +
  taskCard +
  '\n\t\t\t\t})(module, module.exports)\n' +
  '\t\t\t\tconst factory = module.exports.createTaskCard\n' +
  '\t\t\t\treturn factory({\n' +
  '\t\t\t\t\tReact: React,\n' +
  '\t\t\t\t\th: h,\n' +
  '\t\t\t\t\ttcBaseName: tcBaseName,\n' +
  '\t\t\t\t\ttcIsInvestigation: tcIsInvestigation,\n' +
  '\t\t\t\t\ttcKindOf: tcKindOf,\n' +
  '\t\t\t\t\ttcLease: tcLease,\n' +
  '\t\t\t\t\ttcMergeLabel: tcMergeLabel,\n' +
  '\t\t\t\t\ttcMergeOf: tcMergeOf,\n' +
  '\t\t\t\t\ttcMergeTone: tcMergeTone,\n' +
  '\t\t\t\t\ttcPhaseLabel: tcPhaseLabel,\n' +
  '\t\t\t\t\ttcPhaseTone: tcPhaseTone,\n' +
  '\t\t\t\t\ttcReviewLabel: tcReviewLabel,\n' +
  '\t\t\t\t\ttcReviewOf: tcReviewOf,\n' +
  '\t\t\t\t\ttcReviewTone: tcReviewTone,\n' +
  '\t\t\t\t\ttcRound: tcRound,\n' +
  '\t\t\t\t\ttcStageQueued: tcStageQueued,\n' +
  '\t\t\t\t\ttcTestLabel: tcTestLabel,\n' +
  '\t\t\t\t\ttcTestOf: tcTestOf,\n' +
  '\t\t\t\t\ttcTestTone: tcTestTone,\n' +
  '\t\t\t\t\ttoneForDependency: toneForDependency,\n' +
  '\t\t\t\t\twaitingChip: waitingChip,\n' +
  '\t\t\t\t})\n' +
  '\t\t\t})()\n'
const column = read('views/column.cjs')
const columnWrapper =
  '\t\t\tconst Column = (function () {\n' +
  '\t\t\t\tconst module = { exports: {} }\n' +
  '\t\t\t\t;(function (module, exports) {\n' +
  column +
  '\n\t\t\t\t})(module, module.exports)\n' +
  '\t\t\t\tconst factory = module.exports.createColumn\n' +
  '\t\t\t\treturn factory({ h: h, TaskCard: TaskCard })\n' +
  '\t\t\t})()\n'
const board = read('views/board.cjs')
const boardWrapper =
  '\t\t\tconst Board = (function () {\n' +
  '\t\t\t\tconst module = { exports: {} }\n' +
  '\t\t\t\t;(function (module, exports) {\n' +
  board +
  '\n\t\t\t\t})(module, module.exports)\n' +
  '\t\t\t\tconst factory = module.exports.createBoard\n' +
  '\t\t\t\treturn factory({\n' +
  '\t\t\t\t\tReact: React,\n' +
  '\t\t\t\t\th: h,\n' +
  '\t\t\t\t\tTaskCard: TaskCard,\n' +
  '\t\t\t\t\tColumn: Column,\n' +
  '\t\t\t\t\ttcTime: tcTime,\n' +
  '\t\t\t\t\ttcKindOf: tcKindOf,\n' +
  '\t\t\t\t\ttcFirstNonEmptyColumn: tcFirstNonEmptyColumn,\n' +
  '\t\t\t\t\ttcColumnCollapsed: tcColumnCollapsed,\n' +
  '\t\t\t\t\ttcWriteColumnCollapsed: tcWriteColumnCollapsed,\n' +
  '\t\t\t\t\tDONE_COLUMN_PREVIEW: DONE_COLUMN_PREVIEW,\n' +
  '\t\t\t\t\tboardUiState: boardUiState,\n' +
  '\t\t\t\t})\n' +
  '\t\t\t})()\n'
const doneAll = read('views/done-all-drawer.cjs')
const doneAllWrapper =
  '\t\t\tconst DoneAllDrawer = (function () {\n' +
  '\t\t\t\tconst module = { exports: {} }\n' +
  '\t\t\t\t;(function (module, exports) {\n' +
  doneAll +
  '\n\t\t\t\t})(module, module.exports)\n' +
  '\t\t\t\tconst factory = module.exports.createDoneAllDrawer\n' +
  '\t\t\t\treturn factory({ React: React, h: h, doneAllState: doneAllState, tcDayKey: tcDayKey })\n' +
  '\t\t\t})()\n'
const queue = read('views/queue.cjs')
const queueWrapper =
  '\t\t\tconst { QueueRow, QueueView } = (function () {\n' +
  '\t\t\t\tconst module = { exports: {} }\n' +
  '\t\t\t\t;(function (module, exports) {\n' +
  queue +
  '\n\t\t\t\t})(module, module.exports)\n' +
  '\t\t\t\tconst factory = module.exports.createQueueViews\n' +
  '\t\t\t\treturn factory({ h: h })\n' +
  '\t\t\t})()\n'
const workers = read('views/workers.cjs')
const workersWrapper =
  '\t\t\tconst WorkersView = (function () {\n' +
  '\t\t\t\tconst module = { exports: {} }\n' +
  '\t\t\t\t;(function (module, exports) {\n' +
  workers +
  '\n\t\t\t\t})(module, module.exports)\n' +
  '\t\t\t\tconst factory = module.exports.createWorkersView\n' +
  '\t\t\t\treturn factory({ React: React, h: h, tcBaseName: tcBaseName, tcSessionShort: tcSessionShort, tcLeadText: tcLeadText, copyToClipboard: copyToClipboard, roleKindLabel: roleKindLabel, workerStatusLabel: workerStatusLabel })\n' +
  '\t\t\t})()\n'
const agentRow = read('views/agent-row.cjs')
const agentRowWrapper =
  '\t\t\tconst AgentRow = (function () {\n' +
  '\t\t\t\tconst module = { exports: {} }\n' +
  '\t\t\t\t;(function (module, exports) {\n' +
  agentRow +
  '\n\t\t\t\t})(module, module.exports)\n' +
  '\t\t\t\tconst factory = module.exports.createAgentRow\n' +
  '\t\t\t\treturn factory({ React: React, h: h, roleKindLabel: roleKindLabel, copyToClipboard: copyToClipboard })\n' +
  '\t\t\t})()\n'
const roleCreateForm = read('views/role-create-form.cjs')
const roleCreateFormWrapper =
  '\t\t\tconst RoleCreateForm = (function () {\n' +
  '\t\t\t\tconst module = { exports: {} }\n' +
  '\t\t\t\t;(function (module, exports) {\n' +
  roleCreateForm +
  '\n\t\t\t\t})(module, module.exports)\n' +
  '\t\t\t\tconst factory = module.exports.createRoleCreateForm\n' +
  '\t\t\t\treturn factory({ React: React, h: h, tcSplitList: tcSplitList, roleKindLabel: roleKindLabel })\n' +
  '\t\t\t})()\n'
const rolesView = read('views/roles-view.cjs')
const rolesViewWrapper =
  '\t\t\tconst RolesView = (function () {\n' +
  '\t\t\t\tconst module = { exports: {} }\n' +
  '\t\t\t\t;(function (module, exports) {\n' +
  rolesView +
  '\n\t\t\t\t})(module, module.exports)\n' +
  '\t\t\t\tconst factory = module.exports.createRolesView\n' +
  '\t\t\t\treturn factory({ React: React, h: h, RolesEditor: RolesEditor })\n' +
  '\t\t\t})()\n'
const rolesEditor = read('views/roles-editor.cjs')
const rolesEditorWrapper =
  '\t\t\tconst RolesEditor = (function () {\n' +
  '\t\t\t\tconst module = { exports: {} }\n' +
  '\t\t\t\t;(function (module, exports) {\n' +
  rolesEditor +
  '\n\t\t\t\t})(module, module.exports)\n' +
  '\t\t\t\tconst factory = module.exports.createRolesEditor\n' +
  '\t\t\t\treturn factory({\n' +
  '\t\t\t\t\tReact: React,\n' +
  '\t\t\t\t\th: h,\n' +
  '\t\t\t\t\troleResultBanner: roleResultBanner,\n' +
  '\t\t\t\t\ttableWrap: tableWrap,\n' +
  '\t\t\t\t\troleBoundProfile: roleBoundProfile,\n' +
  '\t\t\t\t\troleSelectableProfiles: roleSelectableProfiles,\n' +
  '\t\t\t\t\troleProfileCopy: roleProfileCopy,\n' +
  '\t\t\t\t\tAgentRow: AgentRow,\n' +
  '\t\t\t\t\tRoleCreateForm: RoleCreateForm,\n' +
  '\t\t\t\t\troleErrorText: roleErrorText,\n' +
  '\t\t\t\t\tworkerStatusLabel: workerStatusLabel,\n' +
  '\t\t\t\t\troleKindLabel: roleKindLabel,\n' +
  '\t\t\t\t\tactorLabel: actorLabel,\n' +
  '\t\t\t\t\ttcSplitList: tcSplitList,\n' +
  '\t\t\t\t\troleEditorState: roleEditorState,\n' +
  '\t\t\t\t\tROLE_EDITOR_KINDS: ROLE_EDITOR_KINDS,\n' +
  '\t\t\t\t\tROLE_EDITOR_STAGES: ROLE_EDITOR_STAGES,\n' +
  '\t\t\t\t\tcopyToClipboard: copyToClipboard,\n' +
  '\t\t\t\t})\n' +
  '\t\t\t})()\n'
const statusView = read('views/status-view.cjs')
const statusViewWrapper =
  '\t\t\tconst StatusView = (function () {\n' +
  '\t\t\t\tconst module = { exports: {} }\n' +
  '\t\t\t\t;(function (module, exports) {\n' +
  statusView +
  '\n\t\t\t\t})(module, module.exports)\n' +
  '\t\t\t\tconst factory = module.exports.createStatusView\n' +
  '\t\t\t\treturn factory({\n' +
  '\t\t\t\t\tReact: React,\n' +
  '\t\t\t\t\th: h,\n' +
  '\t\t\t\t\tstatusUiState: statusUiState,\n' +
  '\t\t\t\t\tworktreeCleanupUi: worktreeCleanupUi,\n' +
  '\t\t\t\t\tactorDisplay: actorDisplay,\n' +
  '\t\t\t\t\tmergeActorOf: mergeActorOf,\n' +
  '\t\t\t\t\troleKindLabel: roleKindLabel,\n' +
  '\t\t\t\t\ttestSummaryText: testSummaryText,\n' +
  '\t\t\t\t\ttcAgo: tcAgo,\n' +
  '\t\t\t\t\ttcMergeOf: tcMergeOf,\n' +
  '\t\t\t\t\ttcSessionIdInfo: tcSessionIdInfo,\n' +
  '\t\t\t\t\ttcStageQueued: tcStageQueued,\n' +
  '\t\t\t\t\tcopyToClipboard: copyToClipboard,\n' +
  '\t\t\t\t})\n' +
  '\t\t\t})()\n'
const detailView = read('views/detail-view.cjs')
const detailViewWrapper =
  '\t\t\tconst DetailView = (function () {\n' +
  '\t\t\t\tconst module = { exports: {} }\n' +
  '\t\t\t\t;(function (module, exports) {\n' +
  detailView +
  '\n\t\t\t\t})(module, module.exports)\n' +
  '\t\t\t\tconst factory = module.exports.createDetailView\n' +
  '\t\t\t\treturn factory({\n' +
  '\t\t\t\t\tReact: React,\n' +
  '\t\t\t\t\th: h,\n' +
  '\t\t\t\t\tdetailUiState: detailUiState,\n' +
  '\t\t\t\t\tactorDisplay: actorDisplay,\n' +
  '\t\t\t\t\tmergeActorOf: mergeActorOf,\n' +
  '\t\t\t\t\ttestSummaryText: testSummaryText,\n' +
  '\t\t\t\t\ttoneForDependency: toneForDependency,\n' +
  '\t\t\t\t\twaitingChip: waitingChip,\n' +
  '\t\t\t\t\ttcAgo: tcAgo,\n' +
  '\t\t\t\t\ttcIsInvestigation: tcIsInvestigation,\n' +
  '\t\t\t\t\ttcMergeLabel: tcMergeLabel,\n' +
  '\t\t\t\t\ttcMergeOf: tcMergeOf,\n' +
  '\t\t\t\t\ttcPhaseLabel: tcPhaseLabel,\n' +
  '\t\t\t\t\ttcReportBlocks: tcReportBlocks,\n' +
  '\t\t\t\t\ttcReviewLabel: tcReviewLabel,\n' +
  '\t\t\t\t\ttcReviewOf: tcReviewOf,\n' +
  '\t\t\t\t\ttcRound: tcRound,\n' +
  '\t\t\t\t\ttcStatusKey: tcStatusKey,\n' +
  '\t\t\t\t\ttcTestLabel: tcTestLabel,\n' +
  '\t\t\t\t\ttcTestOf: tcTestOf,\n' +
  '\t\t\t\t})\n' +
  '\t\t\t})()\n'
const viewsCore = read('30-views-core.part')
  .replace(/\t+\/\* TASK_CARD_MODULE \*\//, taskCardWrapper)
  .replace(/\t+\/\* COLUMN_MODULE \*\//, columnWrapper)
  .replace(/\t+\/\* BOARD_MODULE \*\//, boardWrapper)

const bundle =
  read('00-head.part') +
  selectorWrapper +
  read('15-client-state.part') +
  storeWrapper +
  VIEW_PARTS.map((name) => {
    if (name === '30-views-core.part') return viewsCore
    if (name === '32-views-roles.part') return read(name).replace(/\t+\/\* AGENT_ROW_MODULE \*\//, agentRowWrapper).replace(/\t+\/\* ROLE_CREATE_FORM_MODULE \*\//, roleCreateFormWrapper).replace(/\t+\/\* ROLES_EDITOR_MODULE \*\//, rolesEditorWrapper).replace(/\t+\/\* ROLES_VIEW_MODULE \*\//, rolesViewWrapper).replace(/\t+\/\* STATUS_VIEW_MODULE \*\//, statusViewWrapper)
    if (name === '34-views-detail.part') return read(name).replace(/\t+\/\* DETAIL_VIEW_MODULE \*\//, detailViewWrapper)
    return read(name)
  }).join('').replace(/\t+\/\* DONE_ALL_MODULE \*\//, doneAllWrapper).replace(/\t+\/\* QUEUE_VIEWS_MODULE \*\//, queueWrapper).replace(/\t+\/\* WORKERS_VIEW_MODULE \*\//, workersWrapper) +
  read('40-tail.part')

const check = process.argv.indexOf('--check') >= 0
if (check) {
  const current = readFileSync(OUT, 'utf8')
  if (current !== bundle) {
    console.error('build:client: client/client.js is out of date; run npm run build:client')
    process.exit(1)
  }
  console.log('build:client: client/client.js is up to date (' + String(bundle.length) + ' chars)')
} else {
  writeFileSync(OUT, bundle)
  console.log('build:client: wrote client/client.js (' + String(bundle.length) + ' chars)')
}
