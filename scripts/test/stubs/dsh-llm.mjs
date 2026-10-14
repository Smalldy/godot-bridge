// Stub for the one bare specifier the task-center row imports dynamically.
// Registered by the probe through node:module so the real modern-ESM resolution
// path is exercised rather than monkey-patched away.
export function createUserMessage(input) {
  return { kind: 'user-message', content: input.content, source: input.source }
}
