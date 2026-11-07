import assert from 'node:assert/strict'
import { createMerger } from '../../plugin/task-center/merge.mjs'

const task = {
  id: 'T-1',
  target: 'main',
  branch: 'task/T-1',
  merge: { base: 'base-1', head: 'head-1' },
}

const blocked = createMerger({
  git: {},
  workspace: {
    plan: async () => ({ ok: true, action: 'manual-check', reasons: ['no process checker'] }),
  },
})
const blockedOutcome = await blocked.mergeRequest(task, '/project', {})
assert.equal(blockedOutcome.ok, false)
assert.equal(blockedOutcome.code, 'workspace-blocked')
assert.match(blockedOutcome.message, /manual-check/)

let applied = 0
const recovering = createMerger({
  git: { isClean: async () => ({ ok: true, clean: false }) },
  workspace: {
    plan: async () => ({ ok: true, action: 'remove-stale-index-lock', reasons: [] }),
    apply: async () => {
      applied += 1
      return { ok: true, action: 'renamed' }
    },
  },
})
const recoveredOutcome = await recovering.mergeRequest(task, '/project', {})
assert.equal(applied, 1, 'the stale lock is renamed before the clean probe')
assert.equal(recoveredOutcome.ok, false)
assert.equal(recoveredOutcome.code, 'dirty-worktree')

console.log('PASS  a blocked workspace stops the merge with a readable code')
console.log('PASS  a recoverable stale lock is renamed before the clean probe')
