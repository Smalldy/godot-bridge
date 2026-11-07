# Testing

The repository uses a zero-dependency runner (`scripts/test/run.mjs`): every
`*.test.mjs` suite prints one line per assertion and exits non-zero on failure.
`npm run verify` runs the contract check, syntax check, client build and all
suites.

## Pyramid

| level | what it proves | examples |
| --- | --- | --- |
| unit | one module's contract in isolation | `board`, `locks`, `git`, `lease-registry`, `merge-journal`, `action-registry`, `client-selectors`, `client-store` |
| integration | several modules against a real board/worktree/queue | `task-routes`, `task-tool`, `dispatch`, `merge-actions`, `merge-reconcile`, `onboard`, `harness` |
| process | two dispatchers / restart / crash windows | `lease-dual-process`, `merge-restart`, `merge-journal-integration` |
| bundle | the browser half still registers, renders Host data and follows the session | `client-bundle` |
| contract | repository and target-history rules, syntax | `check-plugin-contract`, `check-target-history`, `check:syntax` |

## Known gaps

- No Godot-engine end-to-end test in this branch: the suite exercises the host
  and browser halves, not a live Godot scene.
- The client views are section fragments, so there is no per-view React test;
  `client-bundle` is the integration backstop.
- The Windows process checker uses the host's `tasklist`; on a sandboxed host
  that command may be unavailable, in which case the checker answers "unknown"
  and the merge preflight refuses instead of guessing.

## Running one suite

```powershell
node scripts/test/task-routes.test.mjs
```

Use `GBT_TEST_TIMEOUT_MS` to change the per-suite limit (default 180000).
