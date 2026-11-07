import assert from 'node:assert/strict'
import { ACTIONS, AGENT_ACTIONS, DEV_ONLY_ACTIONS, READ_ACTIONS, USER_ONLY_ACTIONS } from '../../plugin/task-center/api.mjs'
import { ACTION_TABLE } from '../../plugin/task-center/actions/registry.mjs'

const EXPECTED_ACTIONS = [
  'board',
  'list',
  'get',
  'create',
  'update',
  'delete',
  'start',
  'pause',
  'settings',
  'tick',
  'submit',
  'report',
  'approveReview',
  'requestChanges',
  'passTest',
  'failTest',
  'mergeRequest',
  'refreshMerge',
  'rejectMerge',
  'harnessStart',
  'harnessStop',
  'harnessRestart',
  'harnessStatus',
  'harnessSmoke',
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
  'bootstrapTeam',
  'approveStart',
  'rejectStart',
  'cancelStartRequest',
  'cancel',
  'reopen',
  'block',
  'unblock',
  'retry',
  'locks',
  'worktreesCleanup',
  'openProject',
  'onboard',
]
const EXPECTED_DEV_ONLY = ['approveReview', 'requestChanges', 'passTest', 'failTest', 'mergeRequest', 'refreshMerge', 'rejectMerge']
const EXPECTED_USER_ONLY = [
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
const EXPECTED_READ = ['board', 'list', 'get', 'locks', 'harnessStatus', 'skillsCatalog']

assert.deepEqual(ACTIONS, EXPECTED_ACTIONS, 'the action order is the public contract')
assert.deepEqual(DEV_ONLY_ACTIONS, EXPECTED_DEV_ONLY)
assert.deepEqual(USER_ONLY_ACTIONS, EXPECTED_USER_ONLY)
assert.deepEqual(READ_ACTIONS, EXPECTED_READ)
assert.deepEqual(AGENT_ACTIONS, EXPECTED_ACTIONS.filter((name) => EXPECTED_USER_ONLY.indexOf(name) < 0))
assert.equal(new Set(ACTIONS).size, ACTIONS.length, 'action names are unique')
assert.equal(ACTION_TABLE.length, ACTIONS.length)
for (const entry of ACTION_TABLE) {
  assert.equal(typeof entry.name, 'string')
  assert.ok(entry.scope === 'agent' || entry.scope === 'user')
  assert.equal(typeof entry.readOnly, 'boolean')
  assert.equal(typeof entry.devOnly, 'boolean')
  assert.ok(ACTIONS.indexOf(entry.name) >= 0)
}
console.log('PASS  one action table preserves names, order, scopes and read/dev flags')
