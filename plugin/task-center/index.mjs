/**
 * godot-bridge — the task-center row (`godot-bridge/task-center`).
 *
 * A second Loader row of this same package, inserted by this bundle's patch, so
 * the task center is a component of the godot-bridge plugin rather than an
 * independent bundle. A row module may be a subpath export and needs no identity
 * export of its own — `@deepseek-ai/dsh-plugin-manager/tools` in the shipped
 * composition exports only inject/apply, and the package entry owns the plugin
 * identity. Being a directory is what lets the Host half split by
 * responsibility: the board lives in `./board.mjs` and is imported relatively.
 *
 * This row carries the `/task` command: the human signal that a discussion has
 * converged and real tasks may now be created. It is a registered command
 * because an UNKNOWN slash line is rejected by the adapter instead of becoming a
 * prompt, and because a command ships no model message of its own — the signal
 * travels on the receiving Agent:
 *
 *   agent.steer(createUserMessage({ content, source: { kind: 'user' } }))
 *
 * `createUserMessage` lives in @deepseek-ai/dsh-llm and is imported dynamically,
 * so a runtime where that peer does not resolve degrades to a readable `/task`
 * error instead of failing this row.
 *
 * The signal carries a short digest of the project board, so the agent starts
 * from the real state instead of guessing. The digest is strictly best-effort:
 * every failure path becomes a sentence in the message, never a thrown handler,
 * because the signal is the point and the board is an accessory to it.
 */

import { readBoard } from './board.mjs'
import { projectPathOf, registerTaskTool } from './tool.mjs'
import { registerTaskRoutes } from './routes.mjs'
import { probeDispatch, watchAgentStatus, dispatchOne } from './dispatch.mjs'
import { createState } from './state.mjs'

/** Services this row needs: the board is read through the filesystem, the project
 * directory comes from the sandbox policy's session workspace, the
 * `task_center` tool registers in the tool registry, and the panel's routes are
 * registered on the browser's HTTP carrier. */
export const inject = ['fs', 'sandboxPolicy', 'tools', 'webServer']

/** How long the board digest may take before the signal goes out without it. */
const DIGEST_BUDGET_MS = 2000

/** Relative path reported to the agent, so it can read the file itself. */
const BOARD_RELATIVE = '.agents/tasks.json'

/** Minutes/hours/days since an ISO timestamp, for a one-line summary. */
function agoOf(iso) {
  const at = Date.parse(iso)
  if (!Number.isFinite(at)) return 'at an unknown time'
  const minutes = Math.max(0, Math.round((Date.now() - at) / 60000))
  if (minutes < 1) return 'just now'
  if (minutes < 60) return String(minutes) + 'm ago'
  const hours = Math.round(minutes / 60)
  return hours < 24 ? String(hours) + 'h ago' : String(Math.round(hours / 24)) + 'd ago'
}

/**
 * One or two lines of board state for the signal.
 *
 * Never throws and never blocks for longer than `DIGEST_BUDGET_MS`: a board
 * problem must not cost the user their `/task`.
 *
 * @param ctx - the row's context (`fs`, `sandboxPolicy`, `logger`).
 * @param agent - the receiving agent, whose session names the project.
 * @returns the digest line(s).
 */
async function boardDigest(ctx, agent, state) {
  // One implementation of "where is the project", shared with the tool, so the
  // digest and the tool can never disagree about which board they mean.
  const projectPath = projectPathOf(ctx, agent)
  if (projectPath === null) {
    return 'Board (' + BOARD_RELATIVE + '): the project directory is unknown, so its state was not read.'
  }
  if (state !== undefined) state.noteProject(projectPath)
  let timer = null
  const budget = new Promise(function (resolve) {
    timer = setTimeout(function () {
      resolve('Board (' + BOARD_RELATIVE + '): reading it took too long, so the state was skipped.')
    }, DIGEST_BUDGET_MS)
  })
  const read = (async function () {
    try {
      const result = await readBoard({ fs: ctx.fs }, { projectPath: projectPath })
      if (!result.ok) {
        return (
          'Board (' + BOARD_RELATIVE + '): ' + result.code + ' — ' + result.message +
          ' Do NOT overwrite that file; ask the user how to proceed.'
        )
      }
      if (!result.existed) return 'Board (' + BOARD_RELATIVE + '): not created yet; create it there.'
      const tasks = result.board.tasks
      const count = function (status) {
        return tasks.filter(function (task) {
          return task.status === status
        }).length
      }
      let line =
        'Board (' + BOARD_RELATIVE + '): ' + String(tasks.length) + ' tasks — queued ' + String(count('queued')) +
        ' · claimed/in progress ' + String(count('claimed') + count('in_progress')) +
        ' · blocked ' + String(count('blocked')) + ' · review ' + String(count('review')) +
        ' · done ' + String(count('done'))
      if (result.board.updatedAt !== null) line += ' · updated ' + agoOf(result.board.updatedAt)
      const queued = tasks.filter(function (task) {
        return task.status === 'queued'
      })
      if (queued.length > 0) {
        const head = queued
          .slice(0, 3)
          .map(function (task) {
            return String(task.id) + ' ' + String(task.title || '')
          })
          .join('; ')
        line += '\nQueue head: ' + head + (queued.length > 3 ? ' (+' + String(queued.length - 3) + ' more)' : '')
      }
      return line
    } catch (error) {
      return 'Board (' + BOARD_RELATIVE + '): reading it failed (' + String((error && error.message) || error) + ').'
    }
  })()
  try {
    return await Promise.race([read, budget])
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}

export function apply(ctx) {
  // ONE state for both surfaces. The locks are host memory, so two copies would
  // mean the tool and the panel each seeing half the truth — and two agents both
  // believing they hold the same file.
  const state = createState(ctx)
  /**
   * The project the panel shows: whichever one an agent last resolved a board in.
   *
   * Deliberately NOT `policy.resolve()` with no session. Measured live, that
   * answers with the PROFILE directory (`…/.dsh/profiles/desktop`), so the panel
   * would quietly hunt for a board inside the profile and show an empty one — a
   * wrong answer that looks like a right one. With no project known the route says
   * so, and the next tool call or `/task` establishes it. A profile-level "which
   * project does the panel watch" setting is the proper next step.
   */
  const panelProject = () => state.memory.projectHint

  // The dispatch edge's probe. Subscribing records whether this row RECEIVES
  // `agent/status` — the one part of the design that is inferred rather than
  // measured — and it costs nothing when nothing dispatches.
  const statusWatcher = watchAgentStatus(ctx)

  // ── /task: the human signal that authorises real task creation ───────────
  // A slash command cannot reach the model by itself: dsh-commands executes a
  // known command on the Host and ships no model message, and an UNKNOWN slash
  // line is rejected by the adapter instead of becoming a prompt. The sanctioned
  // way to hand the agent a signal is the receiving Agent, and the shipped
  // precedent is dsh-plan-mode's `/plan <message>`:
  //
  //   agent.steer(createUserMessage({ content, source: { kind: 'user' } }))
  //
  // So `/task` does exactly one thing: it steers a user-voiced message into the
  // agent saying the discussion has converged and real tasks may be created.
  // The command's own result text stays in the UI and never reaches the model,
  // which is why the signal travels in the steered message instead.
  //
  // `createUserMessage` lives in @deepseek-ai/dsh-llm and is imported
  // DYNAMICALLY, so a runtime where that peer does not resolve degrades to a
  // clear `/task` error instead of failing this whole plugin's module load.
  // Registering the command stays synchronous, so `/task` is discoverable in
  // the composer whether or not the import has settled yet.
  const TASK_SIGNAL = [
    'The user considers this discussion settled and authorises creating real tasks now.',
    '',
    'How to proceed:',
    '- If you think it helps, list the tasks you intend to create and wait for the user to confirm before writing anything; the user may also ask you to create first and report after.',
    '- Create tasks as DRAFTS. They enter the queue only when the user releases them in the task center.',
    '- Record on each task which proposal it came from. If this discussion has no written conclusion yet, write that conclusion down first, then decompose.',
    '',
    '中文：用户认为本次讨论已经收敛，允许创建真实任务了。',
    '- 如果你认为有必要，先把打算创建的任务列出来让用户确认，再落盘；用户也可能要求你先建后报。',
    '- 任务以草稿状态创建；只有在用户在任务中心里发布之后，它们才进入队列。',
    '- 每个任务都要记录它来自哪份方案。如果这次讨论还没有形成书面结论，先把结论写下来，再拆解。',
  ].join('\n')
  ctx.inject(['commands'], function (commandCtx) {
    let createUserMessage = null
    ctx.effect(function () {
      let abandoned = false
      import('@deepseek-ai/dsh-llm')
        .then(function (mod) {
          if (!abandoned && mod && typeof mod.createUserMessage === 'function') {
            createUserMessage = mod.createUserMessage
          }
        })
        .catch(function () {})
      return function () {
        abandoned = true
      }
    }, 'godot-bridge: /task message factory')
    ctx.effect(function () {
      try {
        return commandCtx.commands.register({
          name: 'task',
          description:
            '表示讨论已收敛、允许创建真实任务（本命令会把一条用户消息交给 agent，命令自身的返回文本不进模型） / Tell the agent the discussion has converged and it may create real tasks',
          input: { hint: '[extra instruction]' },
          handler: async function (invocation) {
            const agent = invocation.agent
            // Both checks answer with a readable error instead of throwing: a
            // thrown handler settles as a generic failure, and this command's
            // whole job is to be diagnosable when the runtime differs.
            if (typeof agent.steer !== 'function') {
              return {
                kind: 'error',
                text: 'This runtime does not expose Agent.steer, so /task cannot hand the signal to the agent.',
              }
            }
            if (typeof createUserMessage !== 'function') {
              return {
                kind: 'error',
                text: '@deepseek-ai/dsh-llm could not be resolved, so /task cannot build the user message.',
              }
            }
            const extra = String(invocation.rawInput || '').trim()
            const opening = extra === '' ? TASK_SIGNAL : TASK_SIGNAL + '\n\nThe user adds: ' + extra
            // The digest is awaited but never allowed to fail or to stall: the
            // signal is what the agent cannot get any other way.
            const digest = await boardDigest(ctx, agent, state)
            agent.steer(
              createUserMessage({
                content: [{ type: 'text', text: opening + '\n\n' + digest }],
                source: { kind: 'user' },
              }),
            )
            return {
              kind: 'success',
              text: '已告知 agent：讨论收敛，可以创建真实任务。/ Told the agent the discussion is settled and real tasks may be created.',
            }
          },
        })
      } catch (e) {
        // A name collision (this scope already has `/task`) must degrade, not
        // take the whole plugin down with it.
        try {
          ctx.logger.warn('[godot-bridge] /task registration skipped: ' + String((e && e.message) || e))
        } catch (e2) {}
        return function () {}
      }
    }, 'godot-bridge: /task command')
  })

  // ── the agent-facing tool ─────────────────────────────────────────────────
  // The write end of the loop: `/task` authorises creating tasks, this is how
  // one gets created. Registration is guarded for the same reason the command's
  // is — a failure here must cost the task center, not the whole plugin.
  ctx.effect(function () {
    try {
      return registerTaskTool(ctx, { state: state })
    } catch (e) {
      try {
        ctx.logger.warn('[godot-bridge] task_center tool registration skipped: ' + String((e && e.message) || e))
      } catch (e2) {}
      return function () {}
    }
  }, 'godot-bridge: task_center tool')

  // ── the panel's surface ───────────────────────────────────────────────────
  // Same state, same model functions, opposite permissions: what the tool refuses
  // is exactly what this route accepts, because its caller is the person at the
  // GUI. Guarded like the others so two bad routes cannot cost the plugin.
  ctx.effect(function () {
    try {
      return registerTaskRoutes(ctx, {
        state: state,
        projectPath: panelProject,
        dispatchProbe: function () {
          return probeDispatch(ctx, statusWatcher)
        },
        dispatchOne: function (taskId, body) {
          // Spawning is ON by default: a pool that only moves while a WorkAgent
          // happens to be idle is a pool that depends on a human being present. The
          // caller can opt out for one dispatch with `{ spawn: false }`, and the
          // ceiling in dispatch.mjs bounds how many agents this can ever create.
          return dispatchOne(
            ctx,
            {
              state: state,
              projectPath: panelProject(),
              now: state.clock(),
              allowSpawn: body === undefined || body === null || body.spawn !== false,
            },
            taskId,
          )
        },
      })
    } catch (e) {
      try {
        ctx.logger.warn('[godot-bridge] task center routes skipped: ' + String((e && e.message) || e))
      } catch (e2) {}
      return function () {}
    }
  }, 'godot-bridge: task center routes')
}
