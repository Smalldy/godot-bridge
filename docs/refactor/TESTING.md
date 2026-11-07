# Testing

The repository uses a zero-dependency runner (`scripts/test/run.mjs`): every
`*.test.mjs` suite prints one line per assertion and exits non-zero on failure.
`npm run verify` runs the contract check, syntax check, client build and all
suites.

## Pyramid

| level | what it proves | examples |
| --- | --- | --- |
| unit | one module's contract in isolation | `board`, `locks`, `git`, `lease-registry`, `merge-journal`, `action-registry`, `client-selectors`, `client-store`, every `client-*.test.mjs` view test |
| integration | several modules against a real board/worktree/queue | `task-routes`, `task-tool`, `dispatch`, `merge-actions`, `merge-reconcile`, `onboard`, `harness` |
| process | two dispatchers / restart / crash windows | `lease-dual-process`, `merge-restart`, `merge-journal-integration` |
| bundle | the browser half still registers, renders Host data and follows the session | `client-bundle` |
| contract | repository and target-history rules, syntax, Godot command enums, structural coverage, line coverage, release metadata | `check-plugin-contract`, `check-target-history`, `check:syntax`, `godot-contract`, `view-test-coverage`, `release-gate`, `coverage` |

## Coverage

`npm run coverage` reruns the suites under `NODE_V8_COVERAGE`, maps V8 ranges
back to source lines and prints per-file coverage. It fails below
`GBT_COVERAGE_MIN`; CI sets 90. Current line coverage is 99.8%
(26181/26239). `view-test-coverage` is the separate structural gate that every
view module has a test requiring it. Branch coverage is not measured.

## Known gaps

- The Godot-engine e2e is a separate harness, not part of `npm test`: run
  `node scripts/test/setup-godot-e2e.mjs`, then start
  `.investigate/godot-e2e` with `godot_e2e.gd` through the plugin's
  `godot_run_headless` tool. It launches the real engine, connects to the
  in-game TCP server and asserts `eval return 1 + 1` -> 2. Verified 2026-11-08
  on Godot 4.7.1.
- The client views are real modules with per-view Node tests;
  `client-bundle` remains the integration backstop for the assembled classic
  script.
- The Windows process checker uses the host's `tasklist`; on a sandboxed host
  that command may be unavailable, in which case the checker answers "unknown"
  and the merge preflight refuses instead of guessing.
- Real DSH host restart / dual-dispatcher e2e is not in this repository; the
  process-level tests cover lease/journal restart semantics instead.

## Running one suite

```powershell
node scripts/test/task-routes.test.mjs
```

Use `GBT_TEST_TIMEOUT_MS` to change the per-suite limit (default 180000).
