// Stub for @deepseek-ai/dsh-tools.
//
// The real defineTool builds the registry-ready definition and validates it; this
// returns the definition unchanged, which is enough to exercise the tool's own
// logic and lets a test assert on the declaration it hands over. Validation is
// the real module's job, and the same definition shape is already used by the
// tool row that ships and works.
export function defineTool(definition) {
  return definition
}
