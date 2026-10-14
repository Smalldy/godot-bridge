// Resolve hook used by task-row-probe.mjs: redirects @deepseek-ai/dsh-llm to a
// local stub so the row's dynamic import succeeds in plain Node.
export async function resolve(specifier, context, next) {
  if (specifier === '@deepseek-ai/dsh-llm') {
    return { url: new URL('./dsh-llm.mjs', import.meta.url).href, shortCircuit: true }
  }
  return next(specifier, context)
}
