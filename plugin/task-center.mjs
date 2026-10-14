/**
 * godot-bridge — the task-center row (`godot-bridge/task-center`).
 *
 * A second Loader row of this same package, inserted by this bundle's patch,
 * so the task center is a component of the godot-bridge plugin rather than an
 * independent bundle. A row module may be a subpath export and needs no
 * identity export of its own — `@deepseek-ai/dsh-plugin-manager/tools` in the
 * shipped composition exports only inject/apply, and the package entry owns
 * the plugin identity.
 *
 * This row carries the `/task` command: the human signal that a discussion has
 * converged and real tasks may now be created. It is a registered command
 * because an UNKNOWN slash line is rejected by the adapter instead of becoming
 * a prompt, and because a command ships no model message of its own — the
 * signal travels on the receiving Agent:
 *
 *   agent.steer(createUserMessage({ content, source: { kind: 'user' } }))
 *
 * `createUserMessage` lives in @deepseek-ai/dsh-llm and is imported dynamically,
 * so a runtime where that peer does not resolve degrades to a readable `/task`
 * error instead of failing this row. The Host-side board and the `task_center`
 * tool will land in sibling modules of this directory, imported relatively.
 */

export function apply(ctx) {
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
          handler: function (invocation) {
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
            agent.steer(
              createUserMessage({
                content: [
                  {
                    type: 'text',
                    text: extra === '' ? TASK_SIGNAL : TASK_SIGNAL + '\n\nThe user adds: ' + extra,
                  },
                ],
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
}
