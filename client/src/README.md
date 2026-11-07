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
| `views/task-card.cjs` | TaskCard (React + selectors injected; Node-testable) |
| `views/column.cjs` | Column (h + TaskCard injected; Node-testable) |
| `views/board.cjs` | Board (React + components + board UI state injected; Node-testable) |
| `views/done-all-drawer.cjs` | DoneAllDrawer (React + doneAllState + tcDayKey injected; Node-testable) |
| `views/queue.cjs` | QueueRow/QueueView (h injected; Node-testable) |
| `views/workers.cjs` | WorkersView (React + h + label helpers injected; Node-testable) |
| `views/agent-row.cjs` | AgentRow (React + h + role label + clipboard injected; Node-testable) |
| `views/role-create-form.cjs` | RoleCreateForm (React + h + tcSplitList + role label injected; Node-testable) |
| `views/roles-view.cjs` | RolesView (React + h + RolesEditor injected; Node-testable) |
| `views/roles-editor.cjs` | RolesEditor (React + role cards/forms/helpers/state injected; Node-testable) |
| `views/status-view.cjs` | StatusView (React + status/worktree state + labels/helpers injected; Node-testable) |
| `30-views-core.part` | hooks, Column, Board, DoneAllDrawer |
| `31-views-queue.part` | queue, workers, pagination |
| `32-views-roles.part` | roles editor and team views |
| `33-views-status.part` | status view and activity helpers |
| `34-views-detail.part` | detail drawer and history helpers |
| `35-views-forms.part` | task/settings/project forms |
| `36-views-shell.part` | TaskCenter shell and Glyph |
| `40-tail.part` | apply wiring and the module factory return |

They are not standalone JS: a part may open or close a function body owned by
another part. Do not run `node --check` on them directly; run
`npm run build:client` and check the generated bundle instead.

The split is the first step of the client refactor: the next steps move pure
selectors and the store into testable modules and leave only the React views in
the concatenated tail.
