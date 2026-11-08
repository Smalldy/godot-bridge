import assert from 'node:assert/strict'
import { recordCandidate } from '../../plugin/task-center/merge.mjs'

function boardWith(actualFiles) {
  return {
    version: 2,
    tasks: [{
      id: 'T-1',
      title: 'candidate',
      status: 'reviewing',
      base: 'old-base',
      actualFiles: actualFiles.slice(),
      merge: {
        status: 'open',
        base: 'old-base',
        target: 'main',
        head: 'old-head',
        mergeCommit: null,
        declaredFiles: ['new.gd'],
        actualFiles: actualFiles.slice(),
        tests: null,
        reviewer: null,
        conflict: null,
        output: null,
        at: null,
      },
      history: [],
      updatedAt: null,
    }],
  }
}

const result = recordCandidate(boardWith(['old.gd']), 'T-1', {
  base: 'new-base',
  head: 'new-head',
  actualFiles: ['new.gd', 'docs/new.md'],
}, 1000, { by: '@reviewer' })
assert.equal(result.ok, true)
const task = result.board.tasks[0]
assert.equal(task.base, 'new-base')
assert.deepEqual(task.actualFiles, ['new.gd', 'docs/new.md'])
assert.deepEqual(task.merge.actualFiles, ['new.gd', 'docs/new.md'])
assert.equal(task.merge.mergeCommit, 'new-head')
console.log('PASS  a rebuilt candidate refreshes both actualFiles records')

const kept = recordCandidate(boardWith(['old.gd']), 'T-1', {
  base: 'new-base',
  head: 'new-head',
}, 1001, { by: '@reviewer' })
assert.equal(kept.ok, true)
assert.deepEqual(kept.board.tasks[0].actualFiles, ['old.gd'])
assert.deepEqual(kept.board.tasks[0].merge.actualFiles, ['old.gd'])
console.log('PASS  a candidate without a file list leaves the recorded list intact')
