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

// T-193: the splitting / parallelism rules belong in the always-loaded entry,
// and cards.md must draw the dependsOn / writeFiles boundary explicitly instead
// of presenting dependsOn as "everything must merge first".
{
  const vocabulary = ['不变量', '契约', '不按文件数', '逻辑前序', 'writeFiles', '纯模块卡', '集成卡', 'acceptance/probes']
  assert.ok(init.includes('## 拆卡前检查'), 'the init body carries the pre-split checklist')
  assert.ok(vocabulary.every((needle) => init.includes(needle)), 'the init splitting rules keep their vocabulary: ' + vocabulary.filter((needle) => init.indexOf(needle) < 0).join(','))
  assert.ok(/dependsOn`?[^。\n]*逻辑前序/.test(init), 'the init ties dependsOn to logical precedence')
  assert.ok(init.includes('不用于解决文件重叠'), 'the init refuses dependsOn as a file-overlap serialiser')
  assert.ok(init.includes('锁串行'), 'the init sends file overlap to the writeFiles lock')

  assert.ok(cards.includes('## 拆卡与并行'), 'cards.md carries the splitting chapter')
  assert.ok(cards.includes('不变量') && cards.includes('不按文件数') && cards.includes('逻辑前序'), 'cards.md splits by invariant/file count and explains logical precedence')
  assert.ok(!cards.includes('dependsOn 表示前序必须 **done + merged**'), 'cards.md drops the over-strong dependsOn wording')
  assert.ok(cards.includes('writeFiles') && cards.includes('锁') && cards.includes('不要') && cards.includes('加 dependsOn'), 'cards.md sends file overlap to the writeFiles lock')
  assert.ok(cards.includes('纯模块卡') && cards.includes('集成卡') && cards.includes('stage-contract.mjs'), 'cards.md documents the pure-module + integration split')
  assert.ok(cards.includes('acceptance/probes') && cards.includes('worktree'), 'cards.md keeps acceptance/probes executable inside one card worktree')
}

// T-213: the always-loaded entry carries a six-point pre-split checklist and an
// explicit resource trigger table; the long-form guide stays on demand in
// cards.md, which must spell out the integration-card boundary, the
// anti-patterns and the parallelism / critical-path check.
{
  const checklistStart = init.indexOf('## 拆卡前检查')
  const checklistEnd = init.indexOf('## 触发表')
  assert.ok(checklistStart >= 0 && checklistEnd > checklistStart, 'the pre-split checklist precedes the trigger table')
  const checklist = init.slice(checklistStart, checklistEnd)
  const items = checklist.split('\n').filter((line) => /^\d+\. /.test(line))
  assert.equal(items.length, 6, 'the pre-split checklist has exactly six items')
  items.forEach((line, index) => assert.ok(line.startsWith(String(index + 1) + '. '), 'checklist numbering stays sequential: ' + line))
  for (const needle of ['独立可验收', '不变量', '并行', '逻辑前序', 'writeFiles', '纯模块卡', '集成卡', 'acceptance/probes']) {
    assert.ok(checklist.includes(needle), 'the pre-split checklist keeps ' + needle)
  }

  // Four explicit triggers: which chapter to read before which action.
  const triggers = [
    ['写卡/拆卡前', 'cards.md', '拆卡与并行'],
    ['派发/worktree', 'run.md', null],
    ['评审/测试/合并/drift', 'gates.md', null],
    ['动作/拒绝码', 'reference.md', null],
  ]
  for (const [scenario, resource, section] of triggers) {
    const line = init.split('\n').find((entry) => entry.includes(scenario) && entry.includes(resource))
    assert.ok(line !== undefined, 'the trigger table names ' + scenario + ' → ' + resource)
    if (section !== null) assert.ok(line.includes(section), 'the ' + resource + ' trigger names its section: ' + section)
  }
  assert.ok(init.split('\n').find((entry) => entry.includes('写卡/拆卡前')).includes('必须先读'), 'the cards trigger is mandatory before writing/splitting cards')

  // The init body stays a pointer: it must not inline the on-demand chapter.
  assert.ok(!init.includes('### 拆卡前检查'), 'init does not inline the cards.md sub-sections')
  assert.ok(!init.includes('调查卡（investigate）'), 'init does not inline the on-demand cards chapter')
  assert.ok(!normaliseEol(init).includes(normaliseEol(cards).trim()), 'init never embeds cards.md verbatim')

  // cards.md: full guide, integration-card boundary, anti-patterns, parallelism check.
  assert.ok(cards.includes('### 拆卡前检查') && cards.includes('### 子卡 + 集成卡'), 'cards.md carries the full pre-split guide')
  for (const needle of ['一张卡一个独立可验收的产物', '实现 + 集成 + E2E + 迁移', '至少两张子卡能并行']) {
    assert.ok(cards.includes(needle), 'cards.md keeps the splitting rule: ' + needle)
  }
  for (const needle of ['只做接线、E2E、跨卡验收', '不重做子卡', '不吞剩余修复', '没有独立集成产物就不建 dev 总卡']) {
    assert.ok(cards.includes(needle), 'cards.md states the integration-card boundary: ' + needle)
  }
  assert.ok(cards.includes('### 反模式') && cards.includes('集成卡吞剩余修复'), 'cards.md lists the anti-patterns')
  assert.ok(cards.includes('### 并行度与关键路径') && cards.includes('关键路径 = 最长 dependsOn 链'), 'cards.md checks parallelism and the critical path')

  // gates.md: root-Agent coordination reference; stage agents follow their brief.
  assert.ok(gates.includes('根 Agent 参考'), 'gates.md marks itself as the root Agent reference')
  assert.ok(gates.includes('阶段 brief 为准'), 'gates.md defers stage agents to their brief')
  assert.ok(gates.includes('不要求子代理加载根技能'), 'gates.md does not require subagents to load the root skill')
}

const combined = buildSkillContent(options)
assert.ok(combined.includes('worker-cannot-self-review'))
assert.ok(combined.includes('sandbox-crash'))
console.log('PASS  the task-center catalog has one init skill and four on-demand resources')
