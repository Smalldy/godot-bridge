import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { createDoctor } from '../../plugin/task-center/doctor.mjs'

const NOW = 1000000
const PROJECT = resolve('/repo')

function fakeGit(overrides) {
  const base = {
    isRepo: async () => ({ ok: true, repo: true }),
    currentBranch: async () => ({ ok: true, branch: 'main' }),
    head: async () => ({ ok: true, hash: 'abc123' }),
    isClean: async () => ({ ok: true, clean: true }),
    worktreeList: async () => ({ ok: true, worktrees: [{ path: PROJECT, branch: 'main' }] }),
    gitPath: async (root, name) => ({ ok: true, path: resolve(PROJECT, '.git', name) }),
  }
  return Object.assign(base, overrides === undefined ? {} : overrides)
}

function fakeFs(files) {
  return {
    statSync: (path) => {
      if (!files.has(path)) {
        const error = new Error('ENOENT')
        error.code = 'ENOENT'
        throw error
      }
      return files.get(path)
    },
  }
}

const staleLock = resolve(PROJECT, '.git', 'index.lock')
const mergeHead = resolve(PROJECT, '.git', 'MERGE_HEAD')

const files = new Map()
files.set(staleLock, { mtimeMs: NOW - 10 * 60 * 1000, size: 0 })
files.set(mergeHead, { mtimeMs: NOW - 1000, size: 41 })

const merger = {
  status: () => ({
    active: 0,
    queued: 0,
    chains: 1,
    last: { ok: false, code: 'merge-failed', message: 'index.lock exists' },
  }),
}

const doctor = createDoctor({ git: fakeGit({ isClean: async () => ({ ok: true, clean: false }) }), fs: fakeFs(files), now: () => NOW, staleLockMs: 5 * 60 * 1000, merger })
const result = await doctor.inspect(PROJECT)

assert.equal(result.status, 'warn')
assert.equal(result.git.repo, true)
assert.equal(result.locks['index.lock'].exists, true)
assert.equal(result.locks['index.lock'].suspectedStale, true)
assert.equal(result.locks['MERGE_HEAD'].exists, true)
assert.equal(result.worktrees.count, 1)
assert.equal(result.merge.last.code, 'merge-failed')
assert.ok(result.checks.some((entry) => entry.id === 'index-lock' && entry.status === 'warn'))
assert.ok(result.checks.some((entry) => entry.id === 'merge-state' && entry.status === 'warn'))
assert.ok(result.checks.some((entry) => entry.id === 'working-tree' && entry.status === 'warn'))
assert.ok(result.checks.some((entry) => entry.id === 'merge-queue' && entry.status === 'warn'))

const cleanFiles = new Map()
const cleanDoctor = createDoctor({ git: fakeGit(), fs: fakeFs(cleanFiles), now: () => NOW })
const clean = await cleanDoctor.inspect(PROJECT)
assert.equal(clean.status, 'ok')
assert.equal(clean.locks['index.lock'].exists, false)
assert.ok(clean.checks.every((entry) => entry.status === 'ok'))

console.log('PASS  doctor reports stale lock, merge state, dirty tree and merge failure')
console.log('PASS  doctor is ok on a clean workspace')
