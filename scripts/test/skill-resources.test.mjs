import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  SKILL_NAME,
  SKILL_RESOURCE_DIR,
  SKILL_RESOURCE_FILES,
  buildInitContent,
  buildReferenceContent,
  buildSkillContent,
} from '../../plugin/task-center/skill.mjs'
import { ACTIONS, AGENT_ACTIONS, READ_ACTIONS, USER_ONLY_ACTIONS } from '../../plugin/task-center/actions/registry.mjs'

const options = {
  actions: ACTIONS,
  agentActions: AGENT_ACTIONS,
  readActions: READ_ACTIONS,
  userOnlyActions: USER_ONLY_ACTIONS,
}

/**
 * T-157: line endings are an environment fact, not content. On Windows with
 * `core.autocrlf=true` the checked-out reference.md is CRLF while the generator
 * emits LF; comparing raw strings would fail a perfectly consistent resource.
 * Every content comparison in this file therefore normalises CRLF to LF first.
 */
const normaliseEol = (text) => String(text).replace(/\r\n/g, '\n')

assert.equal(SKILL_NAME, 'godot-bridge-task-center-init')
const init = buildInitContent(options)
assert.ok(init.includes('接入（onboard）'))
assert.ok(init.includes('onboard.next.code'))
assert.ok(init.includes('cards.md') && init.includes('run.md') && init.includes('gates.md') && init.includes('reference.md'))
assert.ok(Buffer.byteLength(init, 'utf8') < 5000, 'init body stays small: ' + Buffer.byteLength(init, 'utf8'))

for (const name of SKILL_RESOURCE_FILES) {
  const text = readFileSync(join(SKILL_RESOURCE_DIR, name), 'utf8')
  assert.ok(text.trim().length > 200, name + ' is non-empty')
}

const generatedReference = buildReferenceContent(options)
const reference = normaliseEol(readFileSync(join(SKILL_RESOURCE_DIR, 'reference.md'), 'utf8')).trim()
assert.equal(reference, normaliseEol(generatedReference), 'reference.md is generated from the live registry (after CRLF/LF normalisation)')
// Explicit cross-platform assertion: a CRLF copy of the generated resource must
// compare equal after normalisation, while the raw bytes differ (so this check
// really exercises the normaliser instead of being trivially true).
const crlfReference = generatedReference.replace(/\n/g, '\r\n')
assert.notEqual(crlfReference, generatedReference, 'the CRLF variant differs byte-wise from the LF generator output')
assert.equal(normaliseEol(crlfReference), normaliseEol(generatedReference), 'CRLF and LF copies compare equal after normalisation')
for (const action of ACTIONS) assert.ok(reference.includes('`' + action + '`'), 'reference names ' + action)

const cards = readFileSync(join(SKILL_RESOURCE_DIR, 'cards.md'), 'utf8')
const run = readFileSync(join(SKILL_RESOURCE_DIR, 'run.md'), 'utf8')
const gates = readFileSync(join(SKILL_RESOURCE_DIR, 'gates.md'), 'utf8')
assert.ok(cards.includes('调查卡（investigate）') && cards.includes('writeFiles'))
assert.ok(run.includes('start') && run.includes('taskId') && run.includes('worktree'))
assert.ok(gates.includes('reviewer') && gates.includes('tester') && gates.includes('mergeRequest'))

const combined = buildSkillContent(options)
assert.ok(combined.includes('worker-cannot-self-review'))
assert.ok(combined.includes('sandbox-crash'))
console.log('PASS  the task-center catalog has one init skill and four on-demand resources')
