/**
 * The single action registry.
 *
 * The old API had four parallel lists (ACTIONS, DEV_ONLY_ACTIONS,
 * USER_ONLY_ACTIONS, READ_ACTIONS) and the handler chain was a fifth place to
 * edit. This table is the one place a new action declares its name, scope and
 * flags; the exported arrays are derived views for the tool/skill/route, kept in
 * the same order as before.
 *
 * Handlers are still in api.mjs for now; moving them behind this table is the
 * next step. Keeping the table here first makes the metadata contract testable.
 */

const TABLE = [
  { name: 'board', scope: 'agent', readOnly: true, devOnly: false },
  { name: 'list', scope: 'agent', readOnly: true, devOnly: false },
  { name: 'get', scope: 'agent', readOnly: true, devOnly: false },
  { name: 'create', scope: 'agent', readOnly: false, devOnly: false },
  { name: 'update', scope: 'agent', readOnly: false, devOnly: false },
  { name: 'delete', scope: 'agent', readOnly: false, devOnly: false },
  { name: 'start', scope: 'agent', readOnly: false, devOnly: false },
  { name: 'pause', scope: 'agent', readOnly: false, devOnly: false },
  { name: 'settings', scope: 'user', readOnly: false, devOnly: false },
  { name: 'tick', scope: 'agent', readOnly: false, devOnly: false },
  { name: 'submit', scope: 'agent', readOnly: false, devOnly: false },
  { name: 'report', scope: 'agent', readOnly: false, devOnly: false },
  { name: 'approveReview', scope: 'agent', readOnly: false, devOnly: true },
  { name: 'requestChanges', scope: 'agent', readOnly: false, devOnly: true },
  { name: 'passTest', scope: 'agent', readOnly: false, devOnly: true },
  { name: 'failTest', scope: 'agent', readOnly: false, devOnly: true },
  { name: 'mergeRequest', scope: 'agent', readOnly: false, devOnly: true },
  { name: 'refreshMerge', scope: 'agent', readOnly: false, devOnly: true },
  { name: 'rejectMerge', scope: 'agent', readOnly: false, devOnly: true },
  { name: 'harnessStart', scope: 'agent', readOnly: false, devOnly: false },
  { name: 'harnessStop', scope: 'agent', readOnly: false, devOnly: false },
  { name: 'harnessRestart', scope: 'agent', readOnly: false, devOnly: false },
  { name: 'harnessStatus', scope: 'agent', readOnly: true, devOnly: false },
  { name: 'harnessSmoke', scope: 'agent', readOnly: false, devOnly: false },
  { name: 'rolesList', scope: 'user', readOnly: false, devOnly: false },
  { name: 'rolesPreview', scope: 'user', readOnly: false, devOnly: false },
  { name: 'rolesCreate', scope: 'user', readOnly: false, devOnly: false },
  { name: 'rolesUpdate', scope: 'user', readOnly: false, devOnly: false },
  { name: 'rolesDelete', scope: 'user', readOnly: false, devOnly: false },
  { name: 'rolesBind', scope: 'user', readOnly: false, devOnly: false },
  { name: 'rolesDrain', scope: 'user', readOnly: false, devOnly: false },
  { name: 'rolesReplace', scope: 'user', readOnly: false, devOnly: false },
  { name: 'rolesPrune', scope: 'user', readOnly: false, devOnly: false },
  { name: 'rolesReset', scope: 'user', readOnly: false, devOnly: false },
  { name: 'skillsCatalog', scope: 'user', readOnly: true, devOnly: false },
  { name: 'bootstrapTeam', scope: 'agent', readOnly: false, devOnly: false },
  { name: 'approveStart', scope: 'user', readOnly: false, devOnly: false },
  { name: 'rejectStart', scope: 'user', readOnly: false, devOnly: false },
  { name: 'cancelStartRequest', scope: 'agent', readOnly: false, devOnly: false },
  { name: 'cancel', scope: 'agent', readOnly: false, devOnly: false },
  { name: 'reopen', scope: 'agent', readOnly: false, devOnly: false },
  { name: 'block', scope: 'agent', readOnly: false, devOnly: false },
  { name: 'unblock', scope: 'agent', readOnly: false, devOnly: false },
  { name: 'retry', scope: 'agent', readOnly: false, devOnly: false },
  { name: 'locks', scope: 'agent', readOnly: true, devOnly: false },
  { name: 'worktreesCleanup', scope: 'user', readOnly: false, devOnly: false },
  { name: 'openProject', scope: 'agent', readOnly: false, devOnly: false },
  { name: 'onboard', scope: 'agent', readOnly: false, devOnly: false },
]

export const ACTION_TABLE = TABLE.map((entry) => Object.freeze(Object.assign({}, entry)))

export const ACTIONS = ACTION_TABLE.map((entry) => entry.name)

export const DEV_ONLY_ACTIONS = ACTION_TABLE.filter((entry) => entry.devOnly === true).map((entry) => entry.name)

// USER_ONLY/READ keep their pre-refactor presentation order; the table remains
// the source of truth for membership and flags.
const USER_ONLY_ORDER = [
  'approveStart',
  'rejectStart',
  'settings',
  'rolesList',
  'rolesPreview',
  'rolesCreate',
  'rolesUpdate',
  'rolesDelete',
  'rolesBind',
  'rolesDrain',
  'rolesReplace',
  'rolesPrune',
  'rolesReset',
  'skillsCatalog',
  'worktreesCleanup',
]
const READ_ORDER = ['board', 'list', 'get', 'locks', 'harnessStatus', 'skillsCatalog']
const BY_NAME = new Map(ACTION_TABLE.map((entry) => [entry.name, entry]))

export const USER_ONLY_ACTIONS = USER_ONLY_ORDER.filter((name) => BY_NAME.get(name) !== undefined && BY_NAME.get(name).scope === 'user')

export const AGENT_ACTIONS = ACTION_TABLE.filter((entry) => entry.scope !== 'user').map((entry) => entry.name)

export const READ_ACTIONS = READ_ORDER.filter((name) => BY_NAME.get(name) !== undefined && BY_NAME.get(name).readOnly === true)
