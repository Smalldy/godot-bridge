// legacy-team-absent: the Agent Teams roster layer is DELETED, not adapted.
//
// The card's acceptance is a whole-repo property, so this suite asserts it three
// ways: (1) no production source mentions a removed roster/slot/pool identifier;
// (2) the action table and the dispatch port expose no slot/roster surface;
// (3) a live call to /state returns no workers/teams/agents/team field. A
// capability probe or a legacy adapter would fail (1) by naming the old symbols.

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ACTIONS, USER_ONLY_ACTIONS, createApi } from '../../plugin/task-center/api.mjs'
import { dispatchPort } from '../../plugin/task-center/dispatch-port.mjs'
import { createFakeTaskAgents, createRig, PROJECT } from './support/fixtures.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
let failures = 0
function check(label, condition, detail) {
  if (!condition) failures++
  console.log((condition ? 'PASS' : 'FAIL') + '  ' + label + (condition || detail === undefined ? '' : '  -> ' + detail))
}

function filesUnder(relative, accept) {
  const out = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (accept(path)) out.push(path)
    }
  }
  walk(join(root, relative))
  return out
}

// The exact identifiers of the removed layer. Word boundaries matter: the v3
// helper roleKindOfAgentName is NOT the removed roleKindOf(roster name) probe.
const FORBIDDEN = [
  'agentTeams',
  'tryMembership',
  'listMembers',
  'spawnTeammate',
  'removeMember',
  'sendMemberMessage',
  'interruptMemberNamed',
  'interruptAssignee',
  'workerPool',
  'leadInventory',
  'leadInventoryText',
  'projectTeamState',
  'teamBootstrapStep',
  'teamsSnapshot',
  'roleRoster',
  'roleSlotName',
  'roleSlotOf',
  'roleSlotKey',
  'roleShortName',
  'isRoleName',
  'roleInstanceList',
  'roleMemberNamed',
  'liveRoleNames',
  'bootstrapTeam',
  'provisionRole',
  'ensureRole',
  'drainRole',
  'createRoleManager',
  'memberProjectOf',
  'rememberMemberProject',
  'resolveAnyLead',
  'resolveLead',
  'liveLeads',
  'no-team-service',
  'teamCapability',
  'legacyTeamApi',
  'legacyTeamCode',
  'rolesDrain',
  'rolesReplace',
  'rolesPrune',
]
const FORBIDDEN_PATTERNS = [
  { name: 'roleKindOf(', pattern: /\broleKindOf\(/ },
  { name: 'agentTeams service read', pattern: /get\(['"]agentTeams['"]\)|ctx\.agentTeams/ },
]

const production = filesUnder('plugin', (path) => path.endsWith('.mjs'))
const client = filesUnder('client/src', (path) => path.endsWith('.cjs') || path.endsWith('.part'))
const scanned = production.concat(client, [join(root, 'client', 'client.js')])
for (const identifier of FORBIDDEN) {
  const users = []
  for (const file of production) {
    const text = readFileSync(file, 'utf8')
    if (text.indexOf(identifier) >= 0) users.push(file.slice(root.length))
  }
  check('plugin source is free of "' + identifier + '"', users.length === 0, users.join(', '))
}
for (const entry of FORBIDDEN_PATTERNS) {
  const users = []
  for (const file of production) {
    if (entry.pattern.test(readFileSync(file, 'utf8'))) users.push(file.slice(root.length))
  }
  check('plugin source is free of ' + entry.name, users.length === 0, users.join(', '))
}
// A legacy adapter/probe in the browser half is the other way this layer comes
// back, so the shipped bundle is checked too (it is generated, never hand-edited).
for (const identifier of ['agentTeams', 'rolesReplace', 'rolesDrain', 'rolesPrune', 'legacy=0', 'workerPool', 'teamsSnapshot']) {
  const text = readFileSync(join(root, 'client', 'client.js'), 'utf8')
  check('client bundle is free of "' + identifier + '"', text.indexOf(identifier) < 0)
}

// The action vocabulary is the public contract: slot administration is gone and
// a bootstrapTeam action never existed in the table again.
for (const retired of ['rolesDrain', 'rolesReplace', 'rolesPrune', 'bootstrapTeam']) {
  check('the action table has no "' + retired + '" action', ACTIONS.indexOf(retired) < 0, ACTIONS.join(','))
}
check('the user-only surface exposes role CONFIG actions only', ['rolesList', 'rolesPreview', 'rolesCreate', 'rolesUpdate', 'rolesDelete', 'rolesBind', 'rolesReset'].every((name) => USER_ONLY_ACTIONS.indexOf(name) >= 0))

// The dispatch port is the API's only seam; a legacy group cannot reappear.
check('the dispatch port exposes no dispatch/roster legacy group', dispatchPort.dispatch === undefined && dispatchPort.roster.roleSlotOf === undefined && dispatchPort.lead.resolveLead === undefined)
check('the dispatch port keeps the subagent-era groups', ['brief', 'lead', 'roster', 'workspace', 'task'].every((group) => dispatchPort[group] !== undefined))

// A live snapshot must not carry the retired fields, even for a direct caller
// that opts into the full answer.
{
  const rig = createRig({ taskAgents: createFakeTaskAgents() })
  const payload = await rig.api.snapshot(rig.project, { full: true, sessionId: 'session-lead' })
  check('the snapshot answers', payload.ok === true && payload.project === PROJECT, JSON.stringify(payload).slice(0, 200))
  for (const field of ['workers', 'teams', 'agents', 'team']) {
    check('the snapshot has no "' + field + '" field', payload[field] === undefined, 'present: ' + String(payload[field]))
  }
  check('the snapshot still carries the live agent tree', payload.agentTree !== null && typeof payload.agentTree === 'object')
  // createApi must not accept a role-manager style "roles" option any more: an
  // object of legacy slot methods is simply ignored (there is nothing to call).
  const api = createApi(rig.ctx, { state: rig.state, scheduler: rig.scheduler, git: rig.git, roles: { ensure: () => { throw new Error('legacy slot manager called') } } })
  const listed = await api.perform('rolesList', {}, rig.user)
  check('a legacy role-manager option is ignored by rolesList', listed.ok === true && listed.instances === undefined, JSON.stringify(listed).slice(0, 200))
}

console.log(failures === 0 ? '\nPASS  the Agent Teams legacy layer is absent' : '\nFAIL  ' + String(failures) + ' legacy-absence check(s)')
process.exit(failures === 0 ? 0 : 1)
