import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const apiPath = fileURLToPath(new URL('../../plugin/task-center/api.mjs', import.meta.url))
const api = readFileSync(apiPath, 'utf8')
assert.equal(api.includes("from './dispatch.mjs'"), false, 'the API no longer imports the dispatcher directly')
assert.equal(api.includes("from './dispatch-port.mjs'"), true, 'the API imports through the port')
assert.equal(api.includes('import { dispatchPort }'), true, 'the API receives one explicit port object')
assert.equal(api.includes('brief: {'), true, 'the API destructures capability groups')

const port = (await import('../../plugin/task-center/dispatch-port.mjs')).dispatchPort
const groups = {
  brief: ['briefFor', 'briefPartsFor', 'reviewBriefFor', 'reworkBriefFor', 'roleBriefFor', 'roleBriefPartsFor', 'roleContextPreview', 'roleTemplateValuesFor', 'testFailureBriefFor', 'testerBriefFor'],
  lead: ['agentSessionOf', 'sessionLastActiveAt'],
  roster: ['ROLE_SAMPLE_TASK'],
  workspace: ['isTransientEnvironmentCode', 'cleanupInvestigationCheckouts', 'probeWorktree', 'sessionOwnsProject', 'sessionWorkspaceOf'],
  task: ['REVIEW_MAX_ROUNDS', 'hostCheckEvidence', 'runHostCheck', 'verifyFingerprintFor', 'recordPhaseActivity', 'recordStageSlot', 'stageSlotOf'],
}
assert.deepEqual(Object.keys(port).sort(), Object.keys(groups).sort())
for (const [group, names] of Object.entries(groups)) {
  for (const name of names) {
    assert.ok(port[group][name] !== undefined, group + '.' + name + ' is exported')
  }
}
assert.equal(port.briefFor, undefined, 'the flat briefFor export is gone')
assert.equal(port.resolveLead, undefined, 'the flat resolveLead export is gone')
assert.equal(port.dispatch, undefined, 'the retired worker-pool dispatch group is gone')
assert.equal(port.roster.roleSlotOf, undefined, 'the retired role-slot helper is gone')
console.log('PASS  the API depends on the dispatcher through grouped capabilities')
