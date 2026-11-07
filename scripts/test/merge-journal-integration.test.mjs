import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMergeJournal } from '../../plugin/task-center/merge-journal.mjs'
import { createMerger } from '../../plugin/task-center/merge.mjs'

const root = mkdtempSync(join(tmpdir(), 'gbt-merge-journal-integration-'))
const file = join(root, '.agents', 'merge-journal.json')
const journal = createMergeJournal({ file: file })
const merger = createMerger({ git: null, journalFor: () => journal })

try {
  const task = {
    id: 'T-1',
    target: 'main',
    branch: 'task/T-1',
    commit: 'head-1',
    merge: { base: 'base-1', head: 'head-1' },
  }
  const outcome = await merger.mergeRequest(task, '/project', {})
  assert.equal(outcome.ok, false)
  assert.equal(outcome.code, 'no-git-service')
  const status = journal.status()
  assert.equal(status.ok, true)
  assert.equal(status.counts.failed, 1)
  assert.equal(status.pending, 0)
  console.log('PASS  mergeRequest records a failed intent even when the merge cannot start')
} finally {
  rmSync(root, { recursive: true, force: true })
}
