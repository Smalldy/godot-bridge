/**
 * Merge queue — one merge request at a time.
 *
 * A merge request is a task that is already `done` and whose `merge.status` is
 * `open`. Merging it is a small integration pipeline, never a push:
 *
 *   1. the main working tree must be clean and on the task's target branch;
 *   2. a throwaway integration worktree (`<root>/merge-<id>`, branch
 *      `merge/<id>`) is created from the target's HEAD;
 *   3. the candidate branch is merged into it with `--no-ff`;
 *   4. the project's verification command runs INSIDE that integration worktree;
 *   5. only when it is green is the target fast-forwarded to `merge/<id>`;
 *   6. anything red/conflicted aborts and removes the integration checkout and
 *      leaves the main checkout untouched. The task worktree is kept for repair.
 *
 * The queue is a promise chain: a second `mergeRequest` waits for the first, so
 * two merges can never interleave their git commands. Nothing here pushes,
 * rebases or rewrites history.
 */

import { join } from 'node:path'
import { normaliseVerdict } from './schema.mjs'

export const DEFAULT_VERIFY_COMMAND = 'npm run verify'

/** Keep a failed verification readable without letting the board grow forever. */
const MAX_OUTPUT_BYTES = 8 * 1024

/** Collect far more than we record: the diagnosis lives at the END of a long run. */
const MAX_COLLECT_BYTES = 4 * 1024 * 1024

/** Room reserved for the extracted failure lines at the head of the output body. */
const MAX_FAILURE_SUMMARY_BYTES = 2048
const MAX_FAILURE_LINES = 12

function failure(code, message) {
  return { ok: false, code: code, message: message }
}

function messageOf(result) {
  if (result === null || result === undefined) return 'git returned no result'
  const message = result.message === undefined || result.message === null ? '' : String(result.message)
  if (message !== '') return message
  return result.code === undefined || result.code === null ? 'git failed' : String(result.code)
}

function clip(text) {
  const value = String(text === undefined || text === null ? '' : text)
  if (Buffer.byteLength(value, 'utf8') <= MAX_OUTPUT_BYTES) return value
  // Byte-counted, but never split a surrogate pair mid-character.
  return Buffer.from(value, 'utf8').subarray(0, MAX_OUTPUT_BYTES).toString('utf8')
}

function bytesOf(text) {
  return Buffer.byteLength(String(text === undefined || text === null ? '' : text), 'utf8')
}

/**
 * The longest SUFFIX that fits a byte budget, starting on a UTF-8 code point.
 *
 * A buffer cut at an arbitrary byte offset can start inside a multi-byte
 * character (a 4-byte surrogate pair included), and decoding that produces
 * U+FFFD garbage. Stepping back over continuation bytes (10xxxxxx) lands on the
 * character's first byte, so the tail is always valid UTF-8.
 */
function tailOf(text, maxBytes) {
  const value = String(text === undefined || text === null ? '' : text)
  const buffer = Buffer.from(value, 'utf8')
  const total = buffer.length
  if (total <= maxBytes) return { text: value, truncated: false, total: total, kept: total }
  if (maxBytes <= 0) return { text: '', truncated: true, total: total, kept: 0 }
  let start = total - Math.floor(maxBytes)
  while (start > 0 && (buffer[start] & 0xc0) === 0x80) start--
  return { text: buffer.subarray(start).toString('utf8'), truncated: true, total: total, kept: total - start }
}

/** The diagnostic lines of a long run: FAIL/FAILED/Error, in order. */
function failureLines(text) {
  return String(text === undefined || text === null ? '' : text)
    .split(/\r?\n/)
    .filter((line) => /(FAIL|FAILED|Error)/.test(line))
}

/** A labelled tail section that never exceeds its byte budget. */
function tailSection(label, text, budget) {
  if (text === '' || budget <= 0) return ''
  const marker = '--- ' + label + ' (tail) ---\n'
  let tail = tailOf(text, Math.max(0, budget - bytesOf(marker)))
  if (tail.text === '') return ''
  if (tail.truncated) {
    const note = '… truncated: showing last ' + String(tail.kept) + ' of ' + String(tail.total) + ' bytes …\n'
    const contentBudget = Math.max(0, budget - bytesOf(marker) - bytesOf(note))
    tail = tailOf(text, contentBudget)
    if (tail.text === '') return ''
    return marker + note + tail.text
  }
  return marker + tail.text
}

/**
 * Format one verification run for the board.
 *
 * The pass/fail decision is the exit code and nothing else. What we RETAIN for
 * a human is the header (command + exit code), the last failure-looking lines,
 * and the TAILS of stdout and stderr — the head of a 20 MB PASS log is the one
 * part that never explains a failure.
 */
function formatVerificationOutput(command, code, result) {
  const header = '$ ' + command + '  (exit ' + String(code) + ')'
  const stdout = result !== null && result !== undefined && typeof result.stdout === 'string' ? result.stdout.trim() : ''
  const stderr = result !== null && result !== undefined && typeof result.stderr === 'string' ? result.stderr.trim() : ''
  const combined = stdout === '' ? stderr : stderr === '' ? stdout : stdout + '\n' + stderr
  // Reserve the header, its newline and the joins between up to three sections.
  const totalBudget = MAX_OUTPUT_BYTES - bytesOf(header) - 1 - 8
  if (totalBudget <= 0) return header
  if (bytesOf(combined) <= totalBudget) return combined === '' ? header : header + '\n' + combined

  const sections = []
  let used = 0
  const matched = failureLines(combined)
  if (matched.length > 0) {
    const summary = matched.slice(-MAX_FAILURE_LINES).join('\n')
    const budget = Math.min(MAX_FAILURE_SUMMARY_BYTES, Math.max(0, totalBudget - 1024))
    const section = tailSection('failure lines', summary, budget)
    sections.push(section)
    used += bytesOf(section)
  }
  let remaining = totalBudget - used
  if (stdout !== '' && stderr !== '' && remaining > 0) {
    // Give stderr a guaranteed share, then spend what is left on stdout.
    const stderrBudget = Math.min(remaining, Math.max(512, Math.floor(remaining * 0.45)))
    const stdoutSection = tailSection('stdout', stdout, remaining - stderrBudget)
    sections.push(stdoutSection)
    remaining -= bytesOf(stdoutSection)
    sections.push(tailSection('stderr', stderr, Math.max(0, remaining)))
  } else if (stderr !== '') {
    sections.push(tailSection('stderr', stderr, remaining))
  } else {
    sections.push(tailSection('stdout', stdout, remaining))
  }
  const body = sections.filter((section) => section !== '').join('\n')
  const output = body === '' ? header : header + '\n' + body
  if (bytesOf(output) <= MAX_OUTPUT_BYTES) return output
  // Safety net only: budgets should never get here; keep the header regardless.
  const kept = tailOf(body, Math.max(0, MAX_OUTPUT_BYTES - bytesOf(header) - 1))
  return kept.text === '' ? header : header + '\n' + kept.text
}

/**
 * The production verification runner: one unconfined subprocess, stdout/stderr
 * collected. A profile without the subprocess service answers null, and merge
 * requests refuse readably instead of pretending verification happened.
 */
export function verifyFor(ctx) {
  let subprocess = null
  try {
    subprocess = ctx.get('subprocess')
  } catch (error) {
    return null
  }
  if (subprocess === undefined || subprocess === null || typeof subprocess.spawn !== 'function') return null
  return async function verify(request) {
    const command = request !== undefined && typeof request.command === 'string' && request.command.trim() !== '' ? request.command : DEFAULT_VERIFY_COMMAND
    // The verification setting is a shell command ("npm run verify"), and on
    // Windows npm is a .cmd shim that must be run through the shell. One command
    // string is also what the output header reports.
    const argv =
      process.platform === 'win32'
        ? ['cmd.exe', '/d', '/s', '/c', command]
        : ['/bin/sh', '-c', command]
    let handle
    try {
      handle = subprocess.spawn({
        argv: argv,
        cwd: request === undefined ? undefined : request.cwd,
        stdio: {
          stdin: 'ignore',
          stdout: { collect: { maxBytes: MAX_COLLECT_BYTES } },
          stderr: { collect: { maxBytes: MAX_COLLECT_BYTES } },
        },
        graceMs: 120000,
      })
    } catch (error) {
      return { code: 1, stdout: '', stderr: String((error && error.message) || error) }
    }
    let outcome = null
    try {
      outcome = await handle.done
    } catch (error) {
      return { code: 1, stdout: '', stderr: String((error && error.message) || error) }
    }
    let stdout = ''
    let stderr = ''
    try {
      if (handle.collected && handle.collected.stdout && typeof handle.collected.stdout.readFrom === 'function') {
        stdout = handle.collected.stdout.readFrom(0).text || ''
      }
      if (handle.collected && handle.collected.stderr && typeof handle.collected.stderr.readFrom === 'function') {
        stderr = handle.collected.stderr.readFrom(0).text || ''
      }
    } catch (error) {
      // A missing collector only loses output, not the exit code.
    }
    const code = outcome !== null && outcome !== undefined && Number.isFinite(outcome.exitCode) ? outcome.exitCode : 1
    return { code: code, stdout: stdout, stderr: stderr }
  }
}

/**
 * The merge queue over one injected git facade and one verification runner.
 *
 * @param options.git - a `createGit` result. Null means the profile cannot merge.
 * @param options.verify - async ({ cwd, command, task }) -> { code, stdout, stderr }.
 * @param options.verifyCommand - defaults to `npm run verify`.
 * @param options.now - clock injection for tests.
 */
export function createMerger(options) {
  const opts = options === undefined ? {} : options
  const git = opts.git === undefined ? null : opts.git
  const verify = typeof opts.verify === 'function' ? opts.verify : null
  const verifyCommand = typeof opts.verifyCommand === 'string' && opts.verifyCommand.trim() !== '' ? opts.verifyCommand : DEFAULT_VERIFY_COMMAND
  const clock = typeof opts.now === 'function' ? opts.now : Date.now
  let chain = Promise.resolve()

  /** Run one unit of merge work; every caller queues behind the previous one. */
  function enqueue(work) {
    const run = chain.then(work, work)
    chain = run.then(
      function () {},
      function () {},
    )
    return run
  }

  async function callGit(action, args) {
    if (git === null || typeof git[action] !== 'function') return failure('no-git-service', 'the git service does not provide ' + action)
    try {
      return await git[action].apply(git, args)
    } catch (error) {
      return failure(action + '-threw', String((error && error.message) || error))
    }
  }

  async function currentBranchOf(projectPath) {
    const result = await callGit('currentBranch', [projectPath])
    if (result !== null && result !== undefined && result.ok === true) return { ok: true, branch: result.branch }
    return { ok: false, message: messageOf(result) }
  }

  async function cleanOf(projectPath) {
    const result = await callGit('isClean', [projectPath])
    if (result !== null && result !== undefined && result.ok === true) return { ok: true, clean: result.clean === true }
    return { ok: false, message: messageOf(result) }
  }

  async function headOf(root) {
    const result = await callGit('head', [root])
    if (result !== null && result !== undefined && result.ok === true && typeof result.hash === 'string' && result.hash.length > 0) return result.hash
    return null
  }

  async function conflictedOf(checkout) {
    const result = await callGit('conflictedFiles', [checkout])
    if (result !== null && result !== undefined && result.ok === true && Array.isArray(result.files)) return result.files
    return []
  }

  /** Best-effort removal of the throwaway integration checkout and its branch. */
  async function discardIntegration(projectPath, integrationPath, mergeBranch) {
    await callGit('worktreeRemove', [projectPath, integrationPath, { force: true }])
    await callGit('deleteBranch', [projectPath, mergeBranch, { force: true }])
  }

  async function runVerification(checkout, task) {
    if (verify === null) return { ok: false, output: 'no verification runner is configured for this profile' }
    let result = null
    try {
      result = await verify({ cwd: checkout, command: verifyCommand, task: task })
    } catch (error) {
      return { ok: false, output: 'verification runner threw: ' + String((error && error.message) || error) }
    }
    if (result === null || result === undefined || typeof result !== 'object') {
      return { ok: false, output: 'verification runner returned no result' }
    }
    const code = Number.isFinite(result.code) ? Math.floor(result.code) : null
    if (code === null) return { ok: false, output: 'verification runner returned no exit code' }
    return { ok: code === 0, output: formatVerificationOutput(verifyCommand, code, result) }
  }

  /**
   * Run the integration pipeline for one open merge request.
   *
   * Returns a precondition refusal (`{ ok: false, code, message }`) when the
   * environment cannot start, or a completed outcome for the API to record:
   * `{ ok: true, status: 'merged'|'conflict'|'failed', mergeCommit, conflict, output }`.
   * It never writes the board and never touches the main checkout on a failure.
   */
  async function mergeRequest(task, projectPath, request) {
    const req = request === undefined || request === null ? {} : request
    if (git === null) return failure('no-git-service', 'the merge queue needs the git service, and this profile has none; merging is unavailable')
    if (typeof task.branch !== 'string' || task.branch.length === 0) return failure('missing-branch', task.id + ' has no candidate branch to merge')
    if (typeof task.target !== 'string' || task.target.length === 0) return failure('missing-target', task.id + ' has no target branch to merge into')
    if (verify === null) return failure('no-verifier', 'the merge queue needs a verification runner, and this profile has none; merging is unavailable')
    const current = await currentBranchOf(projectPath)
    if (current.ok !== true) return failure('branch-unreadable', 'could not read the branch of ' + projectPath + ': ' + current.message)
    if (current.branch !== task.target) {
      return failure(
        'target-mismatch',
        task.id + ' targets ' + task.target + ', but ' + projectPath + ' is on ' + (current.branch === null ? 'a detached HEAD' : current.branch) + '; check out the target branch and retry',
      )
    }
    const clean = await cleanOf(projectPath)
    if (clean.ok !== true) return failure('clean-unreadable', 'could not check whether ' + projectPath + ' is clean: ' + clean.message)
    if (clean.clean !== true) return failure('dirty-worktree', 'the main working tree is not clean; commit or stash it before merging ' + task.id)
    const targetHead = await headOf(projectPath)
    if (targetHead === null) return failure('head-unreadable', 'could not read the target HEAD of ' + projectPath)

    const root = typeof req.worktreeRoot === 'string' && req.worktreeRoot.length > 0 ? req.worktreeRoot : '.worktrees'
    const integrationPath = join(projectPath, root, 'merge-' + task.id)
    const mergeBranch = 'merge/' + task.id

    const added = await callGit('worktreeAdd', [projectPath, { path: integrationPath, branch: mergeBranch, base: targetHead }])
    if (added === null || added === undefined || added.ok !== true) {
      // A refused add may leave a stale integration checkout/branch behind from
      // an earlier crash; discard it so the next attempt can start clean.
      await discardIntegration(projectPath, integrationPath, mergeBranch)
      return { ok: true, status: 'failed', mergeCommit: null, conflict: null, output: clip('could not create the integration worktree: ' + messageOf(added)) }
    }

    const merged = await callGit('mergeNoFf', [projectPath, integrationPath, task.branch])
    if (merged === null || merged === undefined || merged.ok !== true) {
      const conflicted = merged !== null && merged !== undefined && merged.code === 'merge-conflict'
      let conflict = null
      if (conflicted) {
        const files = await conflictedOf(integrationPath)
        conflict = files.length > 0 ? 'conflicted files: ' + files.join(', ') : messageOf(merged)
      }
      await callGit('mergeAbort', [integrationPath])
      await discardIntegration(projectPath, integrationPath, mergeBranch)
      return {
        ok: true,
        status: conflicted ? 'conflict' : 'failed',
        mergeCommit: null,
        conflict: conflict,
        output: conflicted ? null : clip('the merge failed: ' + messageOf(merged)),
      }
    }

    const mergeCommit = (await headOf(integrationPath)) || (await headOf(projectPath))
    const verified = await runVerification(integrationPath, task)
    if (verified.ok !== true) {
      await callGit('resetHard', [integrationPath])
      await discardIntegration(projectPath, integrationPath, mergeBranch)
      return { ok: true, status: 'failed', mergeCommit: null, conflict: null, output: clip(verified.output) }
    }

    // Verify did not touch the main checkout, but a person or another tool could
    // have; never fast-forward a tree that stopped being the clean target.
    const stillClean = await cleanOf(projectPath)
    if (stillClean.ok !== true || stillClean.clean !== true) {
      await discardIntegration(projectPath, integrationPath, mergeBranch)
      return { ok: true, status: 'failed', mergeCommit: null, conflict: null, output: clip('the main working tree became dirty during verification; nothing was merged') }
    }
    const stillOnTarget = await currentBranchOf(projectPath)
    if (stillOnTarget.ok !== true || stillOnTarget.branch !== task.target) {
      await discardIntegration(projectPath, integrationPath, mergeBranch)
      return { ok: true, status: 'failed', mergeCommit: null, conflict: null, output: clip('the main checkout left ' + task.target + ' during verification; nothing was merged') }
    }

    const forwarded = await callGit('mergeFfOnly', [projectPath, mergeBranch])
    if (forwarded === null || forwarded === undefined || forwarded.ok !== true) {
      await discardIntegration(projectPath, integrationPath, mergeBranch)
      return { ok: true, status: 'failed', mergeCommit: null, conflict: null, output: clip('could not fast-forward ' + task.target + ': ' + messageOf(forwarded)) }
    }

    await callGit('worktreeRemove', [projectPath, integrationPath, { force: true }])
    await callGit('deleteBranch', [projectPath, mergeBranch, { force: false }])
    if (typeof task.worktree === 'string' && task.worktree.length > 0) {
      await callGit('worktreeRemove', [projectPath, task.worktree, { force: true }])
    }
    return { ok: true, status: 'merged', mergeCommit: mergeCommit, conflict: null, output: clip(verified.output) }
  }

  return { enqueue: enqueue, mergeRequest: mergeRequest, verifyCommand: verifyCommand, now: clock }
}

function mergeNote(outcome) {
  if (outcome.status === 'merged') return 'merge request merged' + (outcome.mergeCommit === null || outcome.mergeCommit === undefined ? '' : ' as ' + outcome.mergeCommit)
  if (outcome.status === 'conflict') return 'merge request conflicted; left for its owner: ' + String(outcome.conflict === null || outcome.conflict === undefined ? 'conflict' : outcome.conflict)
  if (outcome.status === 'failed') return 'merge verification failed; the target branch was not changed'
  if (outcome.status === 'rejected') return 'merge request rejected'
  return 'merge request ' + String(outcome.status)
}

/**
 * Record a merge-request outcome on the board. Pure: the API applies it through
 * the board's CAS. The merge fields the queue owns (`status`, `mergeCommit`,
 * `conflict`, `output`, `reviewer`, `at`) are replaced; candidate/base/head and
 * the declared/actual file lists are left as the submission recorded them.
 */
export function recordMergeResult(board, id, outcome, now, by) {
  const next = JSON.parse(JSON.stringify(board))
  const task = next.tasks.filter((candidate) => candidate.id === id)[0]
  if (task === undefined) return failure('unknown-task', 'no task with id ' + String(id))
  if (task.merge === null || typeof task.merge !== 'object' || Array.isArray(task.merge)) {
    return failure('no-merge-request', id + ' has no merge request to record')
  }
  const at = new Date(now).toISOString()
  const merge = Object.assign({}, task.merge, {
    status: outcome.status,
    reviewer: by,
    at: at,
  })
  if (outcome.mergeCommit !== undefined) merge.mergeCommit = outcome.mergeCommit
  if (outcome.conflict !== undefined) merge.conflict = outcome.conflict
  if (outcome.output !== undefined) merge.output = outcome.output
  task.merge = merge
  task.updatedAt = at
  task.history.push({
    at: at,
    by: by,
    from: task.status,
    to: task.status,
    note: mergeNote(outcome),
  })
  return { ok: true, board: next, events: [{ kind: 'merge', id: id, status: outcome.status }] }
}

/**
 * Refresh an open merge request to the task branch's current head AND current
 * base. Pure: the API applies it through the board's CAS after reading the
 * branch head, the target head and the diff itself.
 *
 * A submit records the base and head it saw; if the branch moves, or the target
 * branch advances (or the branch merges the target in while resolving a
 * conflict), that record goes stale. This is the explicit repair: it re-bases
 * the request on the target's current head, re-points it at the branch's real
 * head, refreshes the changed-file list, re-opens a failed/conflicted request
 * and clears the previous outcome. It never commits, merges or pushes.
 *
 * @param base - the commit the diff was taken from (the API passes the target's
 *   current head, or the request's old base when the task has no target).
 * @param verdict - the verdict to record: a fresh `pending` one when independent
 *   testing is on (a new head invalidates any earlier pass), or null in self
 *   mode.
 */
export function refreshMergeRequest(board, id, base, head, actualFiles, verdict, now, by) {
  const next = JSON.parse(JSON.stringify(board))
  const task = next.tasks.filter((candidate) => candidate.id === id)[0]
  if (task === undefined) return failure('unknown-task', 'no task with id ' + String(id))
  if (task.merge === null || typeof task.merge !== 'object' || Array.isArray(task.merge)) {
    return failure('no-merge-request', id + ' has no merge request to refresh')
  }
  if (typeof base !== 'string' || base.length === 0) return failure('missing-base', id + ' has no base commit to record')
  if (typeof head !== 'string' || head.length === 0) return failure('missing-head', id + ' has no branch head to record')
  const at = new Date(now).toISOString()
  const files = Array.isArray(actualFiles) ? actualFiles.slice() : []
  const previousBase = typeof task.merge.base === 'string' ? task.merge.base : null
  const previousHead = typeof task.merge.head === 'string' ? task.merge.head : null
  task.commit = head
  task.actualFiles = files.slice()
  task.merge = Object.assign({}, task.merge, {
    status: 'open',
    base: base,
    head: head,
    actualFiles: files.slice(),
    mergeCommit: null,
    conflict: null,
    output: null,
    reviewer: null,
    verdict: normaliseVerdict(verdict),
    at: at,
  })
  task.updatedAt = at
  task.history.push({
    at: at,
    by: by,
    from: task.status,
    to: task.status,
    note: 'merge request refreshed: base ' + String(previousBase) + ' -> ' + base + ', head ' + String(previousHead) + ' -> ' + head,
  })
  return { ok: true, board: next, events: [{ kind: 'merge-refreshed', id: id, base: base, head: head }] }
}
