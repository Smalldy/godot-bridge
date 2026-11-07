import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMergeJournal } from '../../plugin/task-center/merge-journal.mjs'

const root = mkdtempSync(join(tmpdir(), 'gbt-merge-journal-'))
const file = join(root, '.agents', 'merge-journal.json')
const now = 1000
const journal = createMergeJournal({ file: file, now: () => now })

try {
  const first = await journal.begin({ id: 'T-1', target: 'main', base: 'base-1', head: 'head-1', candidate: 'cand-1' })
  assert.equal(first.ok, true)
  assert.equal(first.action, 'started')
  const again = await journal.begin({ id: 'T-1', target: 'main', base: 'base-1', head: 'head-1' })
  assert.equal(again.ok, true)
  assert.equal(again.action, 'existing', 'same (id,base,head) is idempotent')
  assert.equal((await journal.pending()).entries.length, 1)

  const mergedPlan = journal.planReconcile({ targetHead: 'merge-1', isAncestor: (head, target) => head === 'head-1' && target === 'merge-1' })
  assert.equal(mergedPlan.actions[0].action, 'mark-merged')
  await journal.applyReconcile(mergedPlan)
  assert.equal((await journal.pending()).entries.length, 0)
  assert.equal((await journal.status()).counts.merged, 1)

  const second = await journal.begin({ id: 'T-2', target: 'main', base: 'base-2', head: 'head-2' })
  assert.equal(second.ok, true)
  const abandonedPlan = journal.planReconcile({ targetHead: 'base-2', isAncestor: () => false })
  assert.equal(abandonedPlan.actions[0].action, 'mark-abandoned')
  await journal.applyReconcile(abandonedPlan)

  const third = await journal.begin({ id: 'T-3', target: 'main', base: 'base-3', head: 'head-3' })
  assert.equal(third.ok, true)
  const stalePlan = journal.planReconcile({ targetHead: 'other-3', isAncestor: () => false })
  assert.equal(stalePlan.actions[0].action, 'mark-stale')
  await journal.applyReconcile(stalePlan)
  assert.equal((await journal.status()).counts.stale, 1)

  const unknown = await journal.finish('missing-key', { status: 'merged' })
  assert.equal(unknown.ok, false)
  assert.equal(unknown.code, 'unknown-intent')

  console.log('PASS  merge intents are idempotent and durable')
  console.log('PASS  reconcile classifies merged, abandoned and stale targets')
} finally {
  rmSync(root, { recursive: true, force: true })
}
