/**
 * Shared fixtures for the task-center tests.
 *
 * The fake filesystem has real FsVersion semantics, so a lost race can be
 * provoked. The fake team has a mutable roster, so a test can decide when a
 * WorkAgent becomes idle instead of hoping a real harness cooperates.
 */

import { join } from 'node:path'
import { boardPath } from '../../../plugin/task-center/board.mjs'
import { createState } from '../../../plugin/task-center/state.mjs'
import { createDispatcher } from '../../../plugin/task-center/dispatch.mjs'
import { createApi } from '../../../plugin/task-center/api.mjs'

export const PROJECT = join(process.cwd(), 'demo-project')

export function createFakeFs() {
  const files = new Map()
  const dirs = new Set()
  const hooks = { beforeWrite: null }
  let counter = 0
  const bump = () => 'v' + String(++counter)
  const fs = {
    files,
    dirs,
    hooks,
    async resolve(path) {
      return { targetKey: path, displayPath: path }
    },
    async stat(target) {
      const key = target.targetKey
      if (dirs.has(key)) return { type: 'directory', version: 'dir', size: 0 }
      const entry = files.get(key)
      return entry === undefined ? undefined : { version: entry.version, type: 'file', size: entry.text.length }
    },
    async readText(target) {
      const entry = files.get(target.targetKey)
      if (entry === undefined) throw new Error('ENOENT')
      return entry.text
    },
    async writeText(target, content, expected) {
      const key = target.targetKey
      const entry = files.get(key)
      if (expected !== undefined && expected.kind === 'createIfAbsent' && entry !== undefined) {
        throw Object.assign(new Error('FS_STALE_VERSION: exists'), { code: 'FS_STALE_VERSION' })
      }
      if (expected !== undefined && expected.kind === 'replaceIfVersion') {
        if (entry === undefined || entry.version !== expected.version) {
          throw Object.assign(new Error('FS_STALE_VERSION: moved'), { code: 'FS_STALE_VERSION' })
        }
      }
      if (hooks.beforeWrite !== null) {
        const verdict = hooks.beforeWrite({ key, content, write: (text) => files.set(key, { text, version: bump() }) })
        if (verdict === 'stale') throw Object.assign(new Error('FS_STALE_VERSION: lost the race'), { code: 'FS_STALE_VERSION' })
      }
      const version = bump()
      files.set(key, { text: content, version })
      return { operation: entry === undefined ? 'create' : 'update', version }
    },
  }
  return fs
}

export function seedBoard(fs, project, text) {
  fs.dirs.add(project)
  // A project root is a git checkout with a task board, so the resolver's walk
  // (nearest git root carrying .agents/ or project.godot) finds it.
  fs.dirs.add(join(project, '.git'))
  fs.dirs.add(join(project, '.agents'))
  fs.files.set(boardPath(project), { text, version: 'seed' })
}

export function boardText(fs, project) {
  const entry = fs.files.get(boardPath(project))
  return entry === undefined ? null : entry.text
}

export function boardJson(fs, project) {
  const text = boardText(fs, project)
  return text === null ? null : JSON.parse(text)
}

export function createTeam(options) {
  const opts = options === undefined ? {} : options
  const calls = []
  const roster =
    opts.roster === undefined
      ? [
          { id: 'session-lead', name: 'lead', role: 'lead', status: 'running' },
          { id: 'session-idle', name: 'fixer', role: 'teammate', status: 'inactive' },
        ]
      : opts.roster.map((member) => Object.assign({}, member))
  const team = {
    calls,
    roster,
    setStatus(name, status) {
      const member = roster.filter((entry) => entry.name === name)[0]
      if (member !== undefined) member.status = status
    },
    tryMembership(candidate) {
      return { role: candidate.id === 'session-lead' ? 'lead' : 'teammate', name: candidate.id }
    },
    listMembers() {
      return roster.map((member) => Object.assign({}, member))
    },
    async spawnTeammate(caller, request) {
      calls.push({ kind: 'spawn', caller: caller.id, name: request.name, text: request.prompt.map((block) => block.text).join('\n') })
      if (opts.spawnThrows === true) throw new Error('spawn refused')
      const member = {
        id: 'session-' + request.name,
        name: request.name,
        role: 'teammate',
        status: opts.spawnedStatus === undefined ? 'running' : opts.spawnedStatus,
      }
      roster.push(member)
      return { member: member }
    },
    async sendMessage(caller, request) {
      calls.push({ kind: 'send', caller: caller.id, target: request.target, text: request.content[0].text })
      if (opts.sendThrows === true) throw new Error('mailbox full')
      if (opts.markRunningOnSend !== false) {
        const member = roster.filter((entry) => entry.name === request.target)[0]
        if (member !== undefined) member.status = 'running'
      }
      return { status: 'accepted', messageId: 'message-' + String(calls.length) }
    },
  }
  return team
}

/**
 * A git facade for tests: a clean repository by default, with the refusals a
 * test needs behind options. Dispatch now REQUIRES a usable worktree
 * environment, so every rig gets one unless it explicitly asks for a broken
 * one — scheduling tests should fail on scheduling, not on git.
 *
 * Options: repo:false (not a repository), clean:false (dirty tree),
 * addFails:true (worktree add refused), commitFails:true /
 * nothingToCommit:true (submit), base/branch/commitHash/diffFiles (values).
 */
export function createFakeGit(options) {
  const opts = options === undefined ? {} : options
  const calls = []
  const record = (name, detail) => {
    calls.push({ name: name, detail: detail })
  }
  let lastRoot = opts.project === undefined ? null : opts.project
  return {
    calls: calls,
    async raw(root, args) {
      record('raw', args)
      lastRoot = root
      if (args[0] === 'rev-parse' && args[1] === '--git-path') {
        return { ok: true, code: 0, stdout: String(root).replace(/[\\/]+$/, '') + '/.git/' + args[2] + '\n', stderr: '' }
      }
      if (args[0] === 'check-ignore') {
        const wanted = args.slice(2)
        let ignored = wanted
        if (opts.fs !== undefined && lastRoot !== null) {
          const key = String(lastRoot).replace(/[\\/]+$/, '') + '/.git/info/exclude'
          const entry = opts.fs.files.get(key)
          const text = entry === undefined ? '' : entry.text
          ignored = wanted.filter((path) => text.indexOf('/' + path + '/') >= 0)
        } else if (opts.ignored === false) {
          ignored = []
        }
        return { ok: ignored.length > 0, code: ignored.length > 0 ? 0 : 1, stdout: ignored.map((path) => path + '\n').join(''), stderr: '' }
      }
      return { ok: true, code: 0, stdout: '', stderr: '' }
    },
    async gitPath(root, name) {
      lastRoot = root
      return { ok: true, path: String(root).replace(/[\\/]+$/, '') + '/.git/' + name }
    },
    async checkIgnore(root, paths) {
      const result = await this.raw(root, ['check-ignore', '--', ...paths])
      const ignored = String(result.stdout).split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0)
      return { ok: true, ignored: ignored, notIgnored: paths.filter((path) => ignored.indexOf(path) < 0) }
    },
    async isRepo() {
      record('isRepo')
      return { ok: true, repo: opts.repo !== false }
    },
    async isClean() {
      record('isClean')
      return { ok: true, clean: opts.clean !== false }
    },
    async head() {
      record('head')
      return { ok: true, hash: opts.base === undefined ? 'base-sha' : opts.base }
    },
    async currentBranch() {
      record('currentBranch')
      return { ok: true, branch: opts.branch === undefined ? 'main' : opts.branch }
    },
    async worktreeAdd(root, input) {
      record('worktreeAdd', input)
      if (opts.addFails === true) {
        return { ok: false, code: 'worktree-add-failed', message: 'fatal: could not create work tree' }
      }
      return { ok: true, path: input.path, branch: input.branch, base: input.base }
    },
    async worktreeRemove(root, path) {
      record('worktreeRemove', path)
      return { ok: true, path: path }
    },
    async worktreeList() {
      record('worktreeList')
      return { ok: true, worktrees: [] }
    },
    async commitAll(cwd, message) {
      record('commitAll', { cwd: cwd, message: message })
      if (opts.commitFails === true) return { ok: false, code: 'commit-failed', message: 'fatal: commit refused' }
      if (opts.nothingToCommit === true) return { ok: false, code: 'nothing-to-commit', message: 'nothing to commit' }
      return { ok: true, hash: opts.commitHash === undefined ? 'commit-sha' : opts.commitHash }
    },
    async diffNameOnly(cwd, base, head) {
      record('diffNameOnly', { cwd: cwd, base: base, head: head })
      return { ok: true, files: Array.isArray(opts.diffFiles) ? opts.diffFiles.slice() : [] }
    },
    async revParse(root, ref) {
      record('revParse', ref)
      return { ok: true, hash: opts.base === undefined ? 'base-sha' : opts.base }
    },
    async branchExists() {
      return { ok: true, exists: false }
    },
    async mergeNoFf() {
      return { ok: true }
    },
    async mergeAbort() {
      return { ok: true }
    },
    async rebaseOnto() {
      return { ok: true }
    },
  }
}

export function createRig(options) {
  const opts = options === undefined ? {} : options
  const project = opts.project === undefined ? PROJECT : opts.project
  const fs = createFakeFs()
  fs.dirs.add(project)
  fs.dirs.add(join(project, '.git'))
  fs.dirs.add(join(project, '.agents'))
  const team = opts.team === undefined ? createTeam(opts.teamOptions) : opts.team
  const agents = opts.agents === undefined ? { list: () => [{ id: 'session-lead' }] } : opts.agents
  const subagents = { list: () => ['spawn'] }
  const ctx = {
    fs,
    sandboxPolicy: { resolve: () => ({ workspaceRoot: project }) },
    get(key) {
      if (key === 'agents') return agents
      if (key === 'agentTeams') return team
      if (key === 'subagents') return subagents
      return undefined
    },
  }
  const state = createState(ctx, { now: opts.now })
  // A rig is one session on one project: the resolver's session workspace is
  // this project unless a test clears it to exercise no-project-bound.
  // Every rig is one session; tests pass ?session=test-session on HTTP calls.
  state.setSessionRoot('test-session', project)
  // Worktrees are mandatory, so a rig that does not name a git facade gets a
  // working fake one; pass { git: null } (or a broken createFakeGit) to test
  // the refusal path.
  const git = opts.git === undefined ? createFakeGit(opts.gitOptions) : opts.git
  const scheduler = createDispatcher(ctx, {
    state: state,
    projectPath: () => project,
    allowSpawn: opts.allowSpawn !== false,
    git: git,
    // T-43: tests bound ONE worktree creation (a hanging git must not hang the
    // pass). Production uses the dispatcher default.
    worktreeDeadlineMs: opts.worktreeDeadlineMs,
  })
  const api = createApi(ctx, { state: state, scheduler: scheduler, git: git, now: opts.now })
  const user = { projectPath: project, by: '@user', role: 'user', agent: null }
  async function action(name, body) {
    return api.perform(name, body === undefined ? {} : body, user)
  }
  async function settle() {
    return scheduler.settle(project)
  }
  return { project, fs, team, ctx, state, scheduler, api, git, user, action, settle }
}

export async function createTask(rig, input) {
  const result = await rig.action('create', input)
  if (result.ok !== true) throw new Error('create failed: ' + JSON.stringify(result))
  return result.task
}

export async function submitAsUser(rig, id, evidence) {
  return rig.action('submit', { id: id, evidence: evidence === undefined ? 'done' : evidence })
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}