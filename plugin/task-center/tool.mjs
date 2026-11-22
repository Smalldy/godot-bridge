/**
 * The task_center tool — the model's binding of the action API.
 *
 * It decides exactly three things: who is calling, where the project is, and
 * how a refusal is rendered. Every rule lives in api.mjs / service.mjs, shared
 * with the HTTP route, so the two surfaces cannot drift.
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { AGENT_ACTIONS, READ_ACTIONS } from './api.mjs'
import { SKILL_NAME } from './skill.mjs'
import { CARD_MODEL_LIMITS } from './schema.mjs'

/** A stable display label from the only identity the tool layer exposes. */
export function agentLabel(agent) {
  const raw = agent === undefined || agent === null ? '' : String(agent.id === undefined ? agent.session : agent.id)
  const short = raw.replace(/^session-/, '').replace(/[^0-9a-zA-Z]/g, '').slice(0, 8)
  return short === '' ? '@unknown' : '@' + short
}

/** The project directory from the sandbox policy's session workspace. */
export function projectPathOf(ctx, agent) {
  const policy = ctx === undefined || ctx === null ? undefined : ctx.sandboxPolicy
  if (policy === undefined || policy === null) return null
  const candidates = []
  if (agent !== undefined && agent !== null && agent.id !== undefined) candidates.push({ session: agent.id })
  if (agent !== undefined && agent !== null && agent.session !== undefined) candidates.push({ session: agent.session })
  candidates.push(undefined)
  for (const candidate of candidates) {
    try {
      const resolved = candidate === undefined ? policy.resolve() : policy.resolve(candidate)
      if (resolved && typeof resolved.workspaceRoot === 'string' && resolved.workspaceRoot.length > 0) {
        return resolved.workspaceRoot
      }
    } catch (error) {}
  }
  return null
}

/**
 * T-220: rebuild a tool answer as lossless JSON.
 *
 * The host walks the value a tool RETURNS before `output.render` gets to run
 * `JSON.stringify`, and refuses the entire call when it meets anything
 * `JSON.stringify` would quietly rewrite ("value is not lossless JSON", with no
 * field named). One stray value kills an otherwise valid answer: the board
 * snapshot puts `timings: undefined` on every answer, which is why
 * `openProject` and `board` died there while `get`/`list` — which never build
 * a snapshot — were fine.
 *
 * This walker RETURNS a copy (the api result may be shared or reused, so it is
 * never mutated) made of plain JSON data:
 * - `undefined` object properties are DROPPED, exactly like JSON.stringify;
 * - `undefined` array elements and array HOLES become `null` (positions survive);
 * - `NaN`, `Infinity`, `-Infinity` and `-0` become `null`/`0` (JSON cannot carry
 *   them, and the strict walker rejects every one);
 * - a `Date` becomes its ISO string (what JSON.stringify produces through toJSON);
 * - a `BigInt` becomes its decimal string instead of throwing;
 * - functions and symbols are dropped from objects and become `null` in arrays.
 * Everything that is ALREADY lossless round-trips unchanged, so a normal answer
 * still renders exactly as before.
 */
export function lossless(value, ancestors) {
  const seen = ancestors === undefined ? new Set() : ancestors
  if (value === null || value === undefined) return null
  const type = typeof value
  if (type === 'string' || type === 'boolean') return value
  if (type === 'number') return !Number.isFinite(value) ? null : Object.is(value, -0) ? 0 : value
  if (type === 'bigint') return value.toString()
  if (type === 'function' || type === 'symbol') return null
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString()
  // A cycle has no JSON form (JSON.stringify throws on it); degrade the back
  // reference instead of failing the whole call. Siblings that merely SHARE an
  // object are not cycles: the path set is unwound on the way out.
  if (seen.has(value)) return null
  seen.add(value)
  try {
    if (Array.isArray(value)) {
      const array = []
      for (let index = 0; index < value.length; index++) array.push(index in value ? lossless(value[index], seen) : null)
      return array
    }
    const entries = []
    for (const key of Object.keys(value)) {
      const field = value[key]
      if (field === undefined || typeof field === 'function' || typeof field === 'symbol') continue
      // fromEntries defines own DATA properties, so a literal "__proto__" key
      // from hand-edited board JSON stays data instead of rewriting the new
      // object's prototype (which the strict walker would reject as not plain).
      entries.push([key, lossless(field, seen)])
    }
    return Object.fromEntries(entries)
  } finally {
    seen.delete(value)
  }
}

/** T-207: the refusal codes that mean "the host is waiting for the user". */
const WAIT_FOR_USER_CODES = ['needs-decision', 'needs-consent']

/**
 * T-207: the pending decision id, whatever shape the refusal arrived in.
 *
 * The action API names it `decisionId`; a legacy dispatch-request refusal only
 * carries `request.id`. Both are the same question to the caller, so the tool
 * normalises them here instead of making the model dig through an object it did
 * not design.
 */
function decisionIdOf(result) {
  if (typeof result.decisionId === 'string' && result.decisionId !== '') return result.decisionId
  const decision = result.decision
  if (decision !== null && decision !== undefined && decision.id !== undefined && decision.id !== null) return String(decision.id)
  const decisions = Array.isArray(result.decisions) ? result.decisions : []
  const first = decisions[0]
  if (first !== null && first !== undefined && first.id !== undefined && first.id !== null) return String(first.id)
  const request = result.request
  if (request !== null && request !== undefined && request.id !== undefined && request.id !== null) return String(request.id)
  return null
}

/**
 * T-207: the ONE refusal envelope the model sees.
 *
 * A wait-for-the-user answer is a stable contract: `status`, `waitForUser`,
 * `retryable`, `decisionId`, `decision`, `decisions` and `next` always survive
 * the tool layer, so the model never has to infer "stop and wait" from an
 * opaque error string or, worse, from an empty object. `nextStep`/`team` keep
 * their T-110 meaning for panel-scope refusals.
 */
function refusalEnvelope(result) {
  const decisionId = decisionIdOf(result)
  const waitForUser =
    result.waitForUser === true || result.status === 'needs-decision' || WAIT_FOR_USER_CODES.indexOf(result.code) >= 0 || decisionId !== null
  const next =
    result.next === undefined || result.next === null
      ? waitForUser
        ? { code: 'await-decision', decisionId: decisionId, waitForUser: true, retryable: false }
        : null
      : result.next
  return {
    error: result.message,
    code: result.code,
    status: result.status === undefined ? (waitForUser ? 'needs-decision' : null) : result.status,
    waitForUser: waitForUser,
    retryable: waitForUser ? false : result.retryable === true,
    decisionId: decisionId,
    request: result.request === undefined ? null : result.request,
    // T-196: the pending question must survive the tool envelope: the model
    // reports it to the user (and the panel is already showing it).
    decision: result.decision === undefined ? null : result.decision,
    decisions: result.decisions === undefined ? null : result.decisions,
    // T-207: `next` is the one recommended follow-up; `nextStep` keeps the
    // panel-scope meaning T-110 gave it.
    next: next,
    // T-110: a refusal that tells the model what to DO must survive the tool
    // envelope, otherwise the instruction is lost on the way to the session.
    nextStep: result.nextStep === undefined ? null : result.nextStep,
    team: result.team === undefined ? null : result.team,
  }
}

/** T-207: an empty answer is a transport bug, never a silent success. */
function emptyResultEnvelope(action) {
  return {
    error: 'the task center returned no result for action ' + String(action) + '; nothing was created or changed. Do not retry blindly - read the board first.',
    code: 'empty-result',
    status: null,
    waitForUser: false,
    retryable: false,
    decisionId: null,
    request: null,
    decision: null,
    decisions: null,
    next: null,
    nextStep: null,
    team: null,
  }
}

// The description is a ROUTER, not the manual: what this is, the action enum,
// and where to read the rest. The workflow, the role matrix, the pipeline
// details and the refusal codes live in the runtime skill (skill.mjs), whose
// body is generated from this very action registry — one source, no drift —
// while the enum below stays because the model routes on it before loading
// anything.
const DESCRIPTION =
  'Project task board with dependency-driven dispatch, file locks and a review/test/merge pipeline; every task runs in its own worktree. ' +
  // T-129: onboarding is the FIRST move, so it is named before the manual.
  'Start with action onboard: binds the project, returns a brief plus one next step. ' +
  'Read the skill "' + SKILL_NAME + '" first: workflow, actions, card rules, refusal codes. ' +
  'Actions: ' + AGENT_ACTIONS.join(', ') + '. ' +
  // T-131/T-132: the second lifecycle, named where the model routes; the skill
  // carries the full investigation chapter (when to use it, the report action,
  // the scratch/probe rules and the panel rendering).
  'kind investigate delivers a report, not code: finish it with report; submit/review/test/merge refuse it. ' +
  // T-207: the pre-decision answer is a stable, explicit contract, not an
  // opaque error. The model must STOP and wait for the user; retrying create
  // can only return the SAME pending decision and never makes a second card.
  'create/start/reopen/delete/cancel ask first (needs-decision, waitForUser:true, retryable:false, decisionId, next; start keeps needs-consent). STOP and wait for the panel; never retry create — a repeat returns the SAME decision. The host executes it and messages you. ' +
  // T-231: the read contract is named where the model routes, because "board"
  // used to answer the full 4.85 MB snapshot. A summary page is the read; the
  // full snapshot is an explicit diagnostic hatch; get is the only detail read.
  'Reads: board = paged TaskSummary (limit/cursor; view:"full" = diagnostic hatch); list = /list; get = detail; writes answer seq/affected/changed. ' +
  'Dependencies: B.dependsOn=[A] means A must be done and merged before B runs. ' +
  // T-195/T-196: the host may ask a human a question and wait non-blockingly.
  // The model reads the queue; a plain question may be answered here, while an
  // ACTION question (create/start/reopen/delete/cancel) is user-only.
  'Decisions: decisionList reads the queue; decisionAnswer takes decisionId + option/text; destructive need "DELETE".'

export function registerTaskTool(ctx, options) {
  const opts = options === undefined ? {} : options
  const api = opts.api

  const tool = defineTool({
    name: 'task_center',
    description: DESCRIPTION,
    parameters: {
      action: {
        type: 'string',
        required: true,
        description:
          'What to do. create/start/reopen/delete/cancel answer needs-decision (status needs-decision, waitForUser:true, retryable:false, decisionId, decision, next; start keeps needs-consent): STOP and wait for the user, and NEVER retry create.',
        enum: AGENT_ACTIONS,
      },
      id: { type: 'string', description: 'Task id, e.g. T-12.' },
      title: { type: 'string', description: 'Task title (create, update).' },
      spec: { type: 'string', description: 'What the task involves (create, update).' },
      acceptance: {
        type: 'string',
        description:
          'How completion is judged (create, update). A dev card is budgeted at ' + String(CARD_MODEL_LIMITS.acceptance) + ' criteria (one per line); split the card at design time instead of growing it.',
      },
      // T-131: 'report' needs structured evidence rows while submit/failTest take
      // a text summary, so the ONE parameter accepts both shapes.
      evidence: {
        description:
          'Submit/failTest: a text summary of what was done and how it was checked. Report: an array of rows { command, exitCode, outputTail } the investigator actually ran.',
        oneOf: [
          { type: 'string' },
          {
            type: 'array',
            description: 'Investigation evidence rows (report).',
            items: {
              type: 'object',
              additionalProperties: true,
              properties: {
                command: { type: 'string', description: 'The command that was run.' },
                exitCode: { type: 'number', description: 'Its exit code (omit when it never finished).' },
                outputTail: { type: 'string', description: 'The tail of its output (at most 4 KB is kept).' },
              },
            },
          },
        ],
      },
      kind: {
        type: 'string',
        enum: ['dev', 'investigate'],
        description:
          'Card kind (create only; update cannot change it). dev (default) runs work -> review -> test -> merge. investigate delivers a report: no review, test or merge; finish it with report.',
      },
      summary: { type: 'string', description: 'Investigation report headline (report); at most 4 KB.' },
      body: { type: 'string', description: 'Investigation report body (report); the full text is written to .agents/reports/<id>.md, the board keeps at most 64 KB.' },
      artifacts: {
        type: 'array',
        description:
          'Investigation report artifacts (report): project-relative paths you created or kept, e.g. the probe-<id>-* checkouts. Paths only, never file contents; the host removes those checkouts when the report lands.',
        items: { type: 'string' },
      },
      // T-191: review/test verdicts are STRUCTURED. The record is the only
      // channel a reviewer/tester has; a free-text-only verdict is refused.
      checked: {
        type: 'array',
        description:
          'ReviewRecord.checked (approveReview/requestChanges): the checks YOU ran, each { criterion, method, result }. approveReview refuses an empty list.',
        items: {
          type: 'object',
          additionalProperties: true,
          properties: {
            criterion: { type: 'string', description: 'What was verified.' },
            method: { type: 'string', description: 'How it was verified (command, file read).' },
            result: { type: 'string', description: 'What came back (pass, fail, not-checked).' },
          },
        },
      },
      findings: {
        type: 'array',
        description:
          'ReviewRecord.findings (approveReview/requestChanges): { severity: "blocking"|"non-blocking", file, line, text }. requestChanges refuses a record without at least one blocking finding.',
        items: {
          type: 'object',
          additionalProperties: true,
          properties: {
            severity: { type: 'string', enum: ['blocking', 'non-blocking'] },
            file: { type: 'string', description: 'Project-relative file (optional).' },
            line: { type: 'number', description: 'Line in that file (optional).' },
            text: { type: 'string', description: 'What is wrong / what to fix.' },
          },
        },
      },
      residualRisks: {
        type: 'array',
        description: 'ReviewRecord.residualRisks: what the reviewer could not close; the tester sees this as review scope.',
        items: { type: 'string' },
      },
      probes: {
        type: 'array',
        description:
          'TestRecord.probes (passTest/failTest): the commands YOU executed in the candidate, each { id, command, exitCode, tail }. An empty list is refused; every task-declared probe id must be present.',
        items: {
          type: 'object',
          additionalProperties: true,
          properties: {
            id: { type: 'string', description: 'Probe id (matches the artifact probe id it executes).' },
            command: { type: 'string', description: 'The command that ran.' },
            exitCode: { type: 'number', description: 'Its exit code (omit when it never finished).' },
            timedOut: { type: 'boolean', description: 'True when the command timed out instead of exiting.' },
            tail: { type: 'string', description: 'The output tail that explains the result.' },
          },
        },
      },
      adversarial: {
        type: 'array',
        description: 'TestRecord.adversarial: probes aimed at what the suite does not encode (same shape as probes).',
        items: { type: 'object', additionalProperties: true },
      },
      hostCheckRef: {
        type: 'string',
        description: 'TestRecord.hostCheckRef: the candidate fingerprint of the host baseline the tester used.',
      },
      notes: { type: 'string', description: 'TestRecord.notes: why the verdict, and why any host baseline was re-run.' },
      verification: {
        description:
          'Executable probes the task declares (create/update): { probes: [{ id, command, timeoutMs? }] }. The tester must execute each one and the TestRecord must contain its id. ' +
          'A NEW dev card must declare at least one: create refuses a dev card without probes (an investigation card needs none), and update cannot clear the last one. At most ' +
          String(CARD_MODEL_LIMITS.probes) + ' probes per card.',
        oneOf: [
          {
            type: 'object',
            additionalProperties: true,
            properties: {
              probes: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: true,
                  properties: {
                    id: { type: 'string', description: 'Stable probe id, e.g. "modern-team-service".' },
                    command: { type: 'string', description: 'Shell command to run, e.g. "node --test scripts/test/x.test.mjs".' },
                    timeoutMs: { type: 'number', description: 'Upper bound in milliseconds.' },
                  },
                },
              },
            },
          },
          { type: 'null', description: 'Clear the declared probes.' },
        ],
      },
      note: { type: 'string', description: 'A line for the task history.' },
      dependsOn: {
        type: 'array',
        description: 'Task ids this task waits for (create, update). An empty array clears them.',
        items: { type: 'string' },
      },
      writeFiles: {
        type: 'array',
        description:
          'Project-relative files this task will write; the scheduler locks them before dispatch. ' +
          'A dev card is budgeted at ' + String(CARD_MODEL_LIMITS.files) + ' production files (tests and the generated client/client.js do not count); split the card at design time instead of growing it.',
        items: { type: 'string' },
      },
      verify: {
        description:
          'Host-run mechanical verification (create, update). The HOST executes the command in the test candidate right after the review is approved, before any tester is involved; a non-zero exit (or a timeout) records a failed test by the host and returns the task to running with the command, exit code and output tail. ' +
          'Omitting it (or null) keeps the legacy flow where the tester runs the suite itself.',
        oneOf: [
          {
            type: 'object',
            additionalProperties: true,
            properties: {
              command: {
                type: 'string',
                description: 'The shell command to run, e.g. "npm run verify" (it may chain: "npm run verify && npm run e2e").',
              },
              timeoutMs: {
                type: 'number',
                description: 'Upper bound in milliseconds; defaults to 600000 (10 minutes).',
              },
            },
          },
          { type: 'null', description: 'Clear a previously declared verification.' },
        ],
      },
      priority: { type: 'number', description: 'Higher runs first among ready tasks.' },
      maxAttempts: { type: 'number', description: 'Dispatch attempts before the task blocks.' },
      maxConcurrent: { type: 'number', description: 'Concurrent running tasks (settings).' },
      allowSpawn: { type: 'boolean', description: 'Whether the scheduler may spawn a WorkAgent (settings).' },
      status: { type: 'string', description: 'Filter for list by task status (e.g. pending, done).' },
      // T-231: the read contract. board answers a page by default and `view` is
      // the only way back to the diagnostic full snapshot; list pages/searches
      // exactly like /list; get stays the ONE detail read.
      view: {
        type: 'string',
        enum: ['summary', 'full'],
        description:
          'board only: "summary" (default) answers a paged TaskSummary list plus counts/dispatch/locks/seq; "full" is the diagnostic escape hatch that answers the whole detail snapshot. Do not use "full" to browse.',
      },
      limit: { type: 'number', description: 'Page size for board/list (default 50, max 200).' },
      cursor: { type: 'string', description: 'Opaque page cursor: pass nextCursor from a previous board/list answer to read the next page.' },
      q: { type: 'string', description: 'list only: search text matched against id/title/spec/acceptance.' },
      archived: { type: 'boolean', description: 'list only: true reads the archive of done cards instead of the live board.' },
      taskId: { type: 'string', description: 'Task id for actions that accept it.' },
      // T-195: the decision surface. Only the panel normally answers, but the
      // same actions are reachable from a session (and from HTTP as role user).
      decisionId: { type: 'string', description: 'Decision id for decisionAnswer, e.g. DEC-3.' },
      decisionStatus: {
        type: 'string',
        enum: ['pending', 'answered', 'expired', 'cancelled', 'all'],
        description: 'Filter for decisionList (default: pending). "all" includes resolved requests.',
      },
      option: { type: 'string', description: 'The chosen option id (decisionAnswer).' },
      text: { type: 'string', description: 'Free-text answer or note for decisionAnswer (used when no option is chosen, or as a note).' },
      confirm: {
        type: 'string',
        description: 'High-risk confirmation for decisionAnswer: exactly "DELETE" to accept a destructive option.',
      },
      project: { type: 'string', description: 'Project directory; defaults to the session workspace.' },
      force: { type: 'boolean', description: 'Delete a referenced task and detach its dependents.' },
      path: { type: 'string', description: 'Project directory for openProject.' },
    },
    isConcurrencySafe: (args) => READ_ACTIONS.indexOf(args !== null && args !== undefined ? args.action : undefined) >= 0,
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: async function (args, exec) {
      const action = String(args.action || '')
      if (api === undefined || api === null) return lossless({ error: 'the task center API is not available' })
      const agent = exec === undefined ? undefined : exec.agent
      const me = agentLabel(agent)
      const projectPath = projectPathOf(ctx, agent)
      const context = { projectPath: projectPath, by: me, role: 'agent', agent: agent }
      // T-231: a TOOL openProject binds the project and needs its summary page +
      // preflight/registry — never the full detail + host-inventory snapshot the
      // API keeps for direct callers. The delivery is named, not inferred.
      if (action === 'openProject') context.snapshotDelivery = 'summary'
      const input = Object.assign({}, args)
      const result = await api.perform(action, input, context)
      // T-207: never answer `{}`. An empty/absent result is a transport bug, and a
      // caller that reads it as "nothing happened" is exactly how a blind retry
      // starts. Name it instead.
      let answer
      if (result === null || result === undefined || typeof result !== 'object' || Array.isArray(result) || Object.keys(result).length === 0) {
        answer = emptyResultEnvelope(action)
      } else if (result.ok !== true) {
        answer = refusalEnvelope(result)
      } else {
        // T-231: a write answer carries seq/affected/changed, never a board or a
        // snapshot. The route keeps the snapshot behind an explicit opt-in; the
        // tool answer must stay a bounded read-model page.
        if (result.board !== undefined) delete result.board
        if (result.snapshot !== undefined) delete result.snapshot
        answer = result
      }
      // T-220: every egress — success, refusal, empty — leaves through the
      // lossless walker. The host validates the return value BEFORE render's
      // JSON.stringify runs, so one undefined/non-finite value in the result
      // fails the whole tool call; render keeps serializing the cleaned answer.
      return lossless(answer)
    },
  })

  return ctx.tools.register(tool)
}