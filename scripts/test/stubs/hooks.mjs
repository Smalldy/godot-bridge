// Resolve hook used by the task-center tests: redirects the bare specifiers the
// host half imports dynamically or statically to local stubs, so the modules load
// in plain Node.
export async function resolve(specifier, context, next) {
  if (specifier === '@deepseek-ai/dsh-llm') {
    return { url: new URL('./dsh-llm.mjs', import.meta.url).href, shortCircuit: true }
  }
  if (specifier === '@deepseek-ai/dsh-tools') {
    return { url: new URL('./dsh-tools.mjs', import.meta.url).href, shortCircuit: true }
  }
  return next(specifier, context)
}
