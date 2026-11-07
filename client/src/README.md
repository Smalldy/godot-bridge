# Browser-half source parts

These files are fragments of one classic script. They are concatenated by
`scripts/build-client.mjs` into `client/client.js`, which is the file the DSH
module loader and the browser tests read.

Order:

| part | content |
| --- | --- |
| `00-head.part` | loader wrapper, constants, locales, CSS, settings form |
| `selectors.cjs` | pure task/board selectors and label helpers (testable CJS module) |
| `15-client-state.part` | session/project/column state helpers that use head constants |
| `store.cjs` | `createTaskStore` (Host-backed state, fetch, polling; testable CJS module) |
| `30-views.part` | React views (board, detail, team, worktrees, status) |
| `40-tail.part` | apply wiring and the module factory return |

They are not standalone JS: a part may open or close a function body owned by
another part. Do not run `node --check` on them directly; run
`npm run build:client` and check the generated bundle instead.

The split is the first step of the client refactor: the next steps move pure
selectors and the store into testable modules and leave only the React views in
the concatenated tail.
