# Task-center module layout (refactor)

This is the map the 2026-11 refactor converged on. The public behaviour did not
change; the seams did.

## Host half

```
plugin/task-center/
  api.mjs                 composition root: createApi, perform/performResolved,
                          exports (actions/readActions)
  dispatch-port.mjs       the ONLY dispatcher dependency: one dispatchPort object
  actions/
    registry.mjs          one action table -> ACTIONS/AGENT_ACTIONS/... sets
    read.mjs              board/list/get/locks
    harness.mjs           harnessStart/Stop/Restart/Status/Smoke
    control.mjs           pause/settings/tick
    lifecycle.mjs         cancel/reopen/unblock/retry/block
    roles.mjs             10 role-administration actions
    merge.mjs             mergeRequest/rejectMerge/refreshMerge
    report.mjs            investigation report
    submit.mjs            submit
    review-verdicts.mjs   approveReview/requestChanges
    test-verdicts.mjs     passTest/failTest
    project.mjs           openProject/resolveIncoming
    onboard.mjs           onboard
    task-admin.mjs        create/update/delete/start/approveStart/rejectStart/
                          cancelStartRequest
    project-admin.mjs     skillsCatalog/worktreesCleanup/bootstrapTeam
  kernel/
    action-preflight.mjs  heartbeat, stopped-card, phase activity, dev-only guard
    gates.mjs             roleAdmin/merge/harness/wrongProject refusals
    verdict-gate.mjs      verdictRefusal (roster + agent-registry fallback)
    caller-helpers.mjs    identifiers/role-kind/roster-summary/is-assignee
    caller-lookup.mjs     callerLookup + callerMemberOf/callerRole/ownerOf/
                          assigneeMatches
```

Dependency rules:

- `api.mjs` may import `dispatch-port.mjs`, actions and kernel; actions receive
  their helpers through a deps object, so they do not import `api.mjs`.
- `dispatch-port.mjs` is one object grouped by capability: `brief`, `lead`,
  `roster`, `workspace`, `task`, `dispatch`. The API destructures the groups it
  uses; a flat field on the port is a test failure.
- `kernel/` contains gates/preflight/caller resolution; it has no React and no
  HTTP route.
- The domain modules (`board`, `service`, `schema`, `merge`, `merge-journal`,
  `merge-reconcile`, `workspace`, `doctor`, `lease-*`, `dispatch`, `harness`)
  stay outside both actions and kernel.

## Browser half

```
client/
  client.js               generated bundle (the DSH loader reads this)
  src/
    00-head.part          loader wrapper, constants, locales, CSS, settings form
    selectors.cjs         pure selectors (35 functions; Node-testable)
    15-client-state.part  session/project/column state helpers
    store.cjs             createTaskStore(t, deps) (Node-testable)
    views/task-card.cjs   TaskCard (React + selectors injected; Node-testable)
    views/column.cjs      Column (h + TaskCard injected; Node-testable)
    views/board.cjs       Board (React + components + board UI state injected)
    views/done-all-drawer.cjs  DoneAllDrawer (React + doneAllState + tcDayKey injected)
    views/queue.cjs       QueueRow/QueueView (h injected)
    views/workers.cjs     WorkersView (React + label helpers injected)
    30-views-core.part    hooks, TaskCard, Column, Board, DoneAllDrawer
    31-views-queue.part   queue/workers/pagination
    32-views-roles.part   roles editor/team
    33-views-status.part  status + activity helpers
    34-views-detail.part  detail drawer/history
    35-views-forms.part   task/settings/project forms
    36-views-shell.part   TaskCenter shell + Glyph
    40-tail.part          apply wiring + factory return
  scripts/build-client.mjs  no-dependency concatenation; --check for CI
```

Rules:

- `selectors.cjs` and `store.cjs` are real CJS modules with unit tests; the
  build inlines them into the classic-script factory.
- `.part` files are fragments, not standalone JS; `check:syntax` only sees the
  generated `client.js`.
- Views are split by domain but still concatenated; per-view React tests are a
  known gap (see `docs/refactor/TESTING.md`).

## Tests and CI

`npm run verify` = contract check + syntax check + client build + every
`scripts/test/*.test.mjs` suite. CI runs the same command on windows-latest.
The pyramid and known gaps are in `docs/refactor/TESTING.md`.
