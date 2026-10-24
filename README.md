**English** | [中文](README.zh-CN.md)

# godot-bridge

[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)
[![Listed on DSH Directory](https://dsh.directory/badges/listed.svg)](https://dsh.directory/plugins/smalldy/godot-bridge)

Native **DeepSeek Harness (DSH)** plugin that launches and drives a running **Godot 4.x** game through its in-game TCP interaction server — replacing the [`godot-mcp`](https://github.com/tugcantopaloglu/godot-mcp) MCP server with first-class agent tools.

No MCP protocol, no Python server, no editor addon. The game side is untouched: `McpInteractionServer` (the `mcp_interaction_server.gd` autoload) already listens on `127.0.0.1:9090` and speaks newline-delimited JSON — godot-bridge speaks the same protocol natively from inside the DSH host.

## Tools

`godot_run_project` starts **without** the local debugger (`-d`) by default, so `godot_command eval` works normally. `debug:true` is **diagnostic mode**: the instance runs with the local debugger, the interaction server **refuses `eval`** (it learns this from the `GODOT_BRIDGE_DEBUGGER=1` environment variable the bridge sets at spawn — Godot consumes `-d` before `OS.get_cmdline_args()` can see it, measured on 4.7.2, so an argv check alone never fires) (a syntax error would otherwise enter the interactive `debug>` prompt and deadlock, issue #13), and a script error returns a `debuggerTrace` (break reason, `*Frame N` stack frames with `file:line`, ≤4 KB raw tail) plus a `next` step and ends that run. In diagnostic mode the bridge watches stdout for the debugger and writes exactly one `quit` (never `continue`), then classifies the outcome **by exit code**: exit 0 → `diagnosis: "debugger-quit"`; any non-zero code → `diagnosis: "debugger-trap"` with `exitCode` and `crash: true`; still running after 3 s → `debugger-trap` with `killed: true`. The classification is deliberately honest: on Godot 4.7.2-stable win64 writing `quit` exits in ~38 ms with **3221225477 (0xC0000005, ACCESS_VIOLATION)** and a C++ backtrace, so that run is reported as a crash trap, not as a graceful exit. Measured regression baseline (minimal project + syntax-error script): without `-d` the process exits in ~372 ms with `SCRIPT ERROR … at: GDScript::reload`; with `-d` and stdin at EOF it prints **12089** `Debugger Break`/`debug>` lines in 3 s (1.78 MB, ~590 KB/s) and must be killed — the issue #13 loop; with `-d` and a stdin pipe only one break/prompt appears (2.4 KB) because the debugger waits for input. To run code under the debugger, use `godot_run_headless --script`.

| Tool | Replaces (godot-mcp) | Purpose |
| --- | --- | --- |
| `godot_run_project` | `run_project` | Launch the project (`godot --path …`, **no local debugger by default**), wait for port 9090. `debug:true` = diagnostic mode (`-d`, eval disabled, script errors return `debuggerTrace`) |
| `godot_stop_project` | `stop_project` | Terminate the game process (tree-scoped kill) |
| `godot_get_debug_output` | `get_debug_output` | Incremental stdout/stderr of the launched process |
| `godot_command` | all `game_*` (~105) | Send any interaction-server command: `get_scene_tree`, `get_ui_elements`, `eval`, `get/set_property`, `call_method`, `click`, `key_press`, `screenshot`, `raycast`, `serialize_state`, `ui_*`, … |
| `godot_screenshot` | `game_screenshot` | Viewport capture as base64 PNG |
| `godot_ping` | — | Probe whether the game answers on 9090 (also reports installed/latest plugin version, and `responsive:false` when the port accepts but never answers) |
| `godot_set_engine_path` | — | Persist the Godot engine executable path into the plugin's config (the model asks the user for it, then saves it here; hot-reloaded — reports `persisted: 'profile-patch'` on DSH 0.2.x, `'settings'` on the legacy path) |
| `godot_headless_op` | `read_scene`, `modify_scene_node`, `remove_scene_node`, `attach_script`, `create_resource`, `save_scene`, `create_scene`, `add_node`, `get_uid`, `manage_scene_signals`, … | Headless static operations (`godot --headless --script godot_operations.gd`): 16 ops, no running game needed |
| `godot_run_headless` | — | Bounded **non-interactive** run of the project, a scene, or a test script (`godot --headless --path … [--quit-after N] [--script …]`) through the unconfined subprocess service; returns stdout/stderr and flags a sandbox-crash diagnosis |
| `godot_validate_script` | `validate_script` | Headless GDScript compile-check via `validate_script.gd` → `{valid, errors}` |
| `godot_set_project_setting` | `modify_project_settings`, `set_main_scene`, `manage_layers`, `manage_plugins`, `manage_translations` | Set a typed key in any project.godot section (`PackedStringArray(...)` / `Vector2i(...)` / bool / …) |
| `godot_manage_autoloads` | `manage_autoloads` | List / add / remove autoload singletons (`Name="*res://…"`) |
| `godot_manage_input_map` | `manage_input_map` | List / add / remove input actions — **correct Godot 4 keycodes** (fixes godot-mcp's Godot 3 baseline bug) |
| `godot_manage_export_presets` | `manage_export_presets` | List / add / remove export presets (`export_presets.cfg`) |
| `godot_create_script` | `create_script` | GDScript template (extends / class_name / method stubs / source) |
| `godot_create_project` | `create_project` / `create_csharp_script` | Project scaffold, optional Godot .NET `.csproj` |
| `godot_export_project` | `export_project` | Headless export (`--export-release` / `--export-debug <preset> <output>`) |

The remaining godot-mcp tools were implemented in the MCP server's own Node process: pure file/editor operations are covered by DSH's native file tools, while a handful carry **Godot-specific write logic** (`manage_input_map`, `manage_export_presets`, `modify_project_settings`, project/script templates) that a generic edit replaces only with format knowledge — see [COVERAGE.md](COVERAGE.md) for the full breakdown.

## Task Center

The panel's current project is bound **per session**: `/state`, `/task`, `/list` and every action carry `?session=<id>`, and the Host reads only that session's binding (`state.sessionRootOf(id)` is the single reader — there is no process-global project slot). A request without a session id is unbound and never borrows another session's project.

The same package mounts a second component row, `godot-bridge/task-center`: a project task board, a phase-driven dispatcher with independent review and testing, file locks, a role system, and a centre-column GUI panel (sidebar entry “Tasks”).

### Execution flow

Every task runs in its own git worktree — `<project>/.worktrees/<taskId>-<attempt>` on branch `task/<taskId>-<attempt>`, created when the task is claimed. A task is never dispatched into the shared checkout; if the project cannot host a worktree, dispatch refuses to start instead. Each task walks one phase machine — `pending → running → reviewing → testing → done`, with `blocked` / `cancelled` as exits:

1. **Work**: the assignee edits only that checkout, runs the project tests there, and may load the skills its role profile lists.
2. **Submit**: `submit` commits the worktree, records the base..head diff and moves the task to REVIEW. Submitting is not completion.
3. **Review**: the host provisions the reviewer role (a read-only, independent context) and sends it a per-round brief — spec and acceptance criteria, the diff, declared vs actual files, the worker evidence and the review checklist. The brief also carries the mechanical evidence the host has already collected (the declared vs actual file lists from git, plus the previous round's `verify` result), so the reviewer judges instead of re-running the suite to check its own list. `approveReview` moves the task to TESTING; `requestChanges` returns it to running with concrete reasons. Three rounds without approval block the task; an undecided review is reminded and then blocked by the watchdog below.
4. **Test**: an approval builds a throwaway candidate `<project>/.worktrees/test-<id>` on branch `test/<id>` from the current target head plus the task branch. **Before any tester exists**, the host runs the task's declared `verify` command in that candidate (see *Host mechanical verification* below). A green check enters TESTING with the candidate's brief carrying the host baseline; a red one is a host-recorded failure and never reaches a tester. The tester then records `passTest` or `failTest` with evidence; a failure returns the task to running with that evidence. The brief is explicit that the host baseline is **not** the tester's verdict: the tester must design and run their own probes for what the suite cannot encode, split the evidence into 【host baseline】 / 【my probes】, and may re-run the same command (stating why) or run any other suite — the host run is a floor, not a ceiling.
5. **Merge**: a passed test is merged by the host's serial merge queue (a five-second sweep) — one accepted candidate per task, integrated in a throwaway `merge-<id>` worktree and merged at most once. If the target head moved after the verdict, the candidate is rebuilt from the new head, the host re-runs the declared verification on the rebuilt tree, and the test round restarts instead of merging a stale tree.
6. **Exceptions**: a conflict or a moved target marks the request and notifies the owner; the target branch is never touched. `mergeRequest` / `rejectMerge` / `refreshMerge` stay available to the user or the `merger` teammate for manual integration, audit or repair.

- **Board**: `<project>/.agents/tasks.json`. Schema v2; a v1 board migrates on read (old statuses collapse into the current vocabulary, `blockedBy` becomes `dependsOn`, a stale claim is released). Duplicate ids, malformed entries and future versions are refused instead of overwritten. Add the file to the project's `.gitignore` — it is working state, not source.
- **Action API**: the `task_center` tool and `POST /godot-bridge/task-center/action` share one vocabulary: `create / update / delete / list / get / board / start / pause / approveStart / rejectStart / cancelStartRequest / settings / tick / submit / approveReview / requestChanges / passTest / failTest / mergeRequest / refreshMerge / rejectMerge / cancel / reopen / block / unblock / retry / locks / openProject / rolesList / rolesPreview / rolesCreate / rolesUpdate / rolesDelete / rolesBind / rolesDrain / rolesReplace / rolesReset / skillsCatalog / harnessStart / harnessStatus / harnessSmoke / harnessRestart / harnessStop`. `verify` is a task field rather than an action: `create` / `update` take it, and the tool exposes it as an object parameter (`null` clears it).
- **Runtime skill and always-on rules**: activating the row registers the skill `godot-bridge-task-center` with the host skill catalog. Its body is generated from the action registry (governance: what the board is, when to use it, the minimum workflow, the action matrix, write-card rules, refusal codes, the Godot launch rule and the panel layout), so it cannot drift from the API. Four always-on rules ride the system prompt: `start` is only a request that the user approves; review/test verdicts belong to the matching role; task work stays in the task worktree and never commits to the target; never hand-edit `.agents/tasks.json`. The `task_center` tool description is deliberately a short router to that skill. A host without a skill registry or system-prompt service silently skips both and still gets the tool, the routes and the scheduler.
- **Dependencies**: `B.dependsOn = [A]` means B runs only after A is done **and merged**. Ready tasks are ordered by `priority` descending, then creation time. `A <- B <- C`, `D`, `E <- F` dispatch A, D, E first; A's completion dispatches B, E's completion dispatches F.
- **Dispatch**: start/pause is a project-level state persisted in the board. The GUI exposes one number, **maximum concurrency**: at most that many tasks run at once; the WorkAgent cap is derived as concurrency + 1, a worker is spawned when none is idle, and a task blocks after 3 consecutive failures (the advanced `settings` action can still override these). Every dispatch claims the task first (a 60-minute lease that any assignee activity renews, plus a fixed host heartbeat), then hands it to Agent Teams — `sendMessage` to an idle member, otherwise `spawnTeammate`.
- **Leases and liveness**: a running task holds a **60-minute lease**. Every `task_center` call by the assignee renews it **unconditionally**, and a host heartbeat in every pass renews it on a fixed five-minute cadence, so a long tool run cannot lose its claim. A lapsed lease is settled by **liveness**, not by the clock: a live holder keeps the task (bounded by a four-hour per-attempt cap) and only a gone/failed session is handed over, after an interrupt. One task never has two live agents, and a handover adopts the previous attempt's worktree and branch when it left a commit. The board exposes `leaseRemaining` / `leaseReminder` and records `lease-extended` / `lease-handover` / `attempt-adopt` events.
- **Host restarts refund the attempt (`interruptions` vs `attempts`)**: a claim found to belong to a previous host process (restart / plugin reload) is an infrastructure event, not a worker failure. `interruptDispatch` **refunds** the attempt the claim charged (`attempts` returns to its pre-claim value), increments a separate `interruptions` counter, retires the executor ledger entry and writes `interrupted by worker lost (host restart); attempt refunded` to the history — so a development host that reloads five times cannot block a healthy task. Genuine failures (delivery error, timeout, bad submission) still consume `maxAttempts`; a submission or a genuine failure resets the streak. Five **consecutive** interruptions with nothing ever committed block the task with `interrupted-too-often` instead of retrying forever. `get` / `board` expose `interruptions`, the bounded `executors` ledger and `liveExecutors`, and a re-dispatch retires/interrupts the previous executor before claiming — if an alive executor refuses to stop, the pass skips with `already-dispatched` and a history row, so one task never runs two live executors. A retry reuses the previous attempt's worktree when it is **clean and has no commit** (a dirty checkout is never inherited), and the attempt slot (`attempts + interruptions + 1`) keeps worker names and checkout paths unique across refunds.
- **Roles**: `<project>/.agents/roles.json` (version 1; the normalised `worker` / `reviewer` / `tester` profiles always exist). A profile names one of the three fixed kinds, its stage binding (implement / review / test), 1–8 instances, allowed permissions, a fresh-or-fork context, the skills to load and a prompt **template**. The host provisions a missing stage role through the live Lead and replaces a dead or timed-out instance; reviewer and tester are read-only independent contexts and a worker can never decide its own verdict.
  - The three built-in profiles are **immutable** (their readable default prompts ship with the plugin; editing one answers `builtin-profile-immutable`). To change behaviour, **Fork** a built-in — the fork is a named *draft* copy, and saving it creates the profile, binds its stage and replaces the running instances in one click. There is no separate bind/apply/replace vocabulary in the panel any more: one "current use" picker and one Save; deleting the profile in use falls back to the built-in default immediately.
  - The editor is two columns: the **raw prompt** on the left (editable for a custom profile, read-only with a Fork hint for a built-in) and the exact text the host would inject on the right, fetched through `rolesPreview` from the real brief builders — never panel copy. The identity row owns the profile selection and the current-use picker; instances and skills sit in the same card, and the skills picker reads `skillsCatalog`. `rolesList` / `rolesPreview` / `rolesCreate` / `rolesUpdate` / `rolesDelete` / `rolesBind` / `rolesDrain` / `rolesReplace` / `rolesReset` expose the same operations over the action API. All role administration and `skillsCatalog` are **user-only** (hidden from the tool enum, refused for agents).
  - A template may inject `{{TASK_ID}}`, `{{TASK_TITLE}}`, `{{SPEC}}`, `{{COMPLETIONS_DEF}}`, `{{GIT_INFO}}`, `{{PROJECT}}`, `{{LEAD}}`, `{{ROLE}}` and `{{STAGE}}`. Any other `{{NAME}}` is refused at save time with `invalid-role-variable` and the allowed list; an empty template is legal. The fixed header, the task data and the duties / permission-boundary / verdict sections are host-generated and never template output.
- **File locks (automatic only)**: `writeFiles` declares what a task will write. The scheduler acquires all of them atomically before dispatch and releases them on completion, block, cancel or lease handover. There are **no manual lock actions**: an agent can neither take nor drop a lock, and the panel has no file-lock tab; `locks` remains as a read-only diagnostic action (holder task/agent and the ready tasks that would wait on a path). Paths canonicalise to project-relative POSIX paths; a directory lock conflicts with every child path.
- **Host mechanical verification (`verify`)**: a task may declare `verify: { command, timeoutMs? }` on `create` / `update` (the `task_center` tool exposes it as an object parameter; `null` clears it). `command` is a shell string — it may chain (`npm run verify && npm run e2e`) and runs as-is through the unconfined subprocess service in the candidate checkout, bounded by `timeoutMs` (default 10 minutes). The outcome is recorded on the task as `test.hostCheck` (`command`, `exitCode`, `timedOut`, `durationMs`, a ≤4 KB `tail` of the output, `at`). Exit 0 enters TESTING normally with the baseline in the tester's brief. A non-zero exit or a timeout is a **host-recorded failed test** (`by: host`, evidence = command + exit code + tail): the task returns to running, no tester round is opened, the candidate is discarded, the owner is notified, and the task can never reach the merge queue. A malformed declaration is refused with `invalid-verify` instead of being silently dropped. A task without `verify` keeps the historical flow in which the tester runs the suite.
- **GUI**: five tabs — **board** (seven columns: ready, waiting, running, reviewing, testing, done, blocked), **queue**, **workers**, **status** and **roles**. Tabs carry no counts of their own; the numbers live in the board header. The workers view shows the lead, cap, busy/idle/provisioning/failed counts and each WorkAgent's current task. The **status page** is a one-line status (dispatch state, open work, what is landing) with the dispatch controls, then three cards — dispatch, worktrees and agents — and a full-width **activity stream** below them. Every event there is a readable sentence in the panel language (dispatch, submit, review round, test round, merge, host check, lease events) instead of a raw kind, and it names the acting member from the host-written `byName` (the user reads as "you"), so a row no longer depends on the live roster — an unresolvable id falls back to the row's own role word (执行者 / 评审者 / 测试者 / 合并者) followed by the label (an older record without a role word falls back to 「member <label>」). The header's 最近活动 line reads the same event stream as this card and shows its newest timestamp (a heartbeat-only board says so instead of going blank). A test event is a **structured summary** — 通过/失败 · exit N · Ns — never a dump of the evidence, and each event keeps **its own verdict**: in a fail-then-pass history the earlier row still reads failed even though the task's current test record is a pass. The **task detail** is a wide overlay laid out by *container* width: two columns when the content area is ≥900 px (a window of roughly 996 px and wider, so a 1024 px window is still the narrower two-column form), a compact form at 700–900 px of content, a single column below, and the overlay itself is full screen under 900 px of viewport. It carries a stage spine (dispatch → implement → review → test → merge) with rounds and completion times, a "where it is now" body, a summary column, and the key events and latest rejection reasons up front; the full evidence text of a test round sits behind a 查看全文 / "view full" toggle. The roles view is the two-column role context editor described above. A pending start request appears as a banner with approve/reject. It polls the host snapshot every 2.5 s.
- **Project binding (the panel follows the session)**: with no browser pin the panel sends **no** project at all — the Host resolves the session workspace (walking up to the nearest git project) and answers with that ProjectRef, so a fresh browser never has to type a path. A badge beside the title names the source: **Session** (the workspace walk-up), **Manual** (a path this browser or a caller pinned) or **Registry**. The project dialog offers **Use current project**, which fills in the path the Host resolves right now instead of asking for one. When the panel's pin differs from the session project, a bar reads "Panel: A · Session: B" with a **switch** action that pins B *and* calls `openProject` — the GUI switch and the scheduler binding are one action, so a hand-pinned path can no longer leave the panel on A while dispatch drives B. A manually typed project still works (remote / non-workspace projects) and is labelled Manual.
- **Panel session identity (how the panel knows which session it is)**: the panel speaks as the session the DSH shell is showing. It reads the Host's own services — `uiWorkspace.selection` (the persisted `dsh.sessions.current` store, written whenever the main session is swapped) and, as a second source, `uiSession.current` (the main-view binding) — and sends that id on `/state`, `/list`, `/task` and every action body, which is the same id the tool path receives as `agent.id`. The panel therefore follows the session with no URL parameter and no hand-typed path, and a session switch is picked up immediately (the selection subscription reloads instead of waiting for the next poll). Degradation is explicit and never a guess: an explicit `?session=` on the page URL wins; with no Host identity the panel mints a per-window id (sessionStorage) and says so; an empty selection is never read as "the most recently active session" and there is no global slot to borrow. The status page always names the id and its source (host / URL / this window).
- **Consent**: an agent's `start` records `dispatch.request`; it does not start the scheduler. The panel shows the request, and only the user's `approveStart` runs it. `pause` is immediate for either side; `settings` is user-only.
- **Timeouts and the host watchdog**: the watchdog measures **silence, not elapsed wall time** — every identifiable `task_center` call by the reviewer or tester renews that phase's activity clock (memory-only: a host restart can block a round that was already silent). A review undecided after 10 minutes of silence gets one reminder, an "about to block" notice at 20, and is blocked for triage only after a further 2-minute grace; a test round is reminded at 10 and blocked at 20 plus the same grace, so a verdict landing on the boundary is not thrown away; three review rounds without approval also block. Every async host action (candidate build, candidate merge, merge request, role provisioning, notification) is bounded at 2 minutes: a stuck action answers `queue-timeout` / `action-timeout` and late writes from the abandoned unit are refused, so one hung await cannot hold the action or the merge queue. A `passTest` merge waits out the declared `verify` budget, because a moved target rebuilds the candidate and re-runs that check.
- **Leaving `running` stops the worker**: when a task is cancelled, blocked, has its start request withdrawn, loses its lease or is blocked by a timeout, the host interrupts the teammate that was working on it through the Agent Teams `interrupt` edge (called as the Lead). `interrupt` takes effect at the **next step boundary** — it stops the worker before it starts another step, so this is "stop as soon as possible", never "cut the tool call in progress". The interrupt is sent only to a member that is still `running` (an idle member and a task without an assignee are skipped), at most once per task/status/member, releases the task's file locks and leaves a readable inbox note ("… is cancelled/blocked; stop and discard uncommitted changes"). The soft half backs it up: while the task stays cancelled or blocked, the worker that held it — recognised through the retained last owner (`lastAssignee`), because `cancel`/`block` clear the live assignee — has its `task_center` calls (`get`, `submit`, verdict actions, …) refused with `task-cancelled` / `task-blocked` and the message "stop working on it now"; other agents and the user can still read or repair the task.
- **Worktree robustness**: each `git worktree add` has its own 180-second timeout (it does not share the general git/subprocess budget); a timeout or failure rolls back what it may have registered (worktree entry, branch, lock, pruned metadata), retries once, and creation is serialised per repository so two tasks cannot race the same worktree metadata.
- **Safety**: HTTP writes require `application/json` and a same-origin `Origin`; `?project=` is only a read hint, while switching projects goes through `openProject` (which verifies the directory).

### Known limitations

- There is no session-jump API: the status view can copy a session id, but opening that session stays a manual step in the Team list.
- Godot must be launched through the `godot_*` tools, never through the shell tools (the file sandbox crashes it — see Pitfalls).
- The isolated harness needs `dshCommand` (and usually `dshArgs`) configured; without a working CLI the smoke reports a readable failure instead of passing.
- One project at a time and one Team/Lead at a time: the shared state keeps a single project hint and dispatch resolves the first live Lead. Without the Agent Teams services, tasks stay pending with an explicit reason.
- **Merged means advanced, and the ref is the source of truth**: a merge advances the target through its fully-qualified ref (`refs/heads/<target>`) and then re-reads it; if the ref is not at the expected merge commit the merge is refused with `target-not-advanced` (git's stderr is included in the message), the task stays in testing and nothing is recorded as merged. A short target name can be ambiguous to git (e.g. `fix/eval-debugger-trap`), which is why the host never passes one. Boards that already show a merged task whose ref never moved cannot be repaired automatically — reopen/retry it (or use `refreshMerge` + `mergeRequest`) and verify the target ref by hand.
- A target branch that moves between the test verdict and the merge forces a rebuild + retest (including the host's mechanical check) by design; the merge is never applied to a stale tree.
- A card whose previous executor is alive and refuses to be interrupted stays `pending` for triage: the `already-dispatched` refusal consumes neither an attempt nor an interruption, so the dispatcher retries it every pass (with an activity row) instead of handing the card to a second executor. The five-interruption anti-loop rule covers interrupted claims only, not this refusal.
- On a **historical** test event the exit code and duration are read from the task's latest test record (the board keeps only the current round), so an older failure row can show the numbers of a later round. The verdict label itself is the event's own, the failed round's evidence text survives as that history entry's note (the activity row carries it as its hover text), and the detail's 查看全文 toggle shows the current round's full evidence.

```sh
# create a task from outside the GUI (any HTTP client)
curl -s -X POST http://127.0.0.1:<port>/godot-bridge/task-center/action \
  -H 'content-type: application/json' \
  -d '{"action":"create","project":"/path/to/game","title":"A","writeFiles":["scripts/a.gd"],"verify":{"command":"npm run verify"}}'
# start / pause dispatch
curl -s -X POST http://127.0.0.1:<port>/godot-bridge/task-center/action \
  -H 'content-type: application/json' -d '{"action":"start","project":"/path/to/game"}'
curl -s -X POST http://127.0.0.1:<port>/godot-bridge/task-center/action \
  -H 'content-type: application/json' -d '{"action":"pause","project":"/path/to/game"}'
```

`npm test` covers board, service, locks, dispatch, git, harness, routes, tool, activation, target history and the browser half.

### Candidate drift: automatic vs. manual

The candidate is built at review time, but the merge happens after the tests; the target usually advances in between. The host sweep (not the worker) handles drift:

- **Base-only drift** (target moved, the branch head still equals the verified commit): the sweep rebuilds the candidate against the current target head and merges it directly. Evidence records "only the base changed, diff identical to the verified commit"; **no new review or test round** is created.
- **Build-time conflict**: a candidate that conflicts with the target is no longer thrown back as candidate-conflict. The card is marked candidate-stale with the conflicted file list and rebuilt automatically; a second conflict becomes needs-rebase (file list kept) and waits for the worker/Lead, while other cards keep running.
- **Changed content** (the branch moved past the verified commit): the drift is never merged blindly. The card is marked candidate-stale ("diff changed") and refreshMerge re-opens review, so review + tests run again.
- **Known boundary**: automatic drift detection only recognises real hex commit bases; synthetic labels such as "base-sha" in fixtures or hand-written boards keep the historical behaviour. Real repositories always carry hex commits.
- The conflicted files are kept in the task's waitingDetail, so the panel can show exactly why a card is waiting.

## Isolated DSH test harness

The task center also ships a real-DSH smoke for the candidate plugin: `plugin/task-center/harness.mjs` starts a **disposable DSH instance** and proves that the candidate loads and answers — without touching the production profile, session or port. Only the tester role (or the user) drives it through `task_center` `harnessStart` / `harnessStatus` / `harnessSmoke` / `harnessRestart` / `harnessStop`; `POST /godot-bridge/task-center/action` exposes the same actions to the GUI.

One `harnessStart` creates, under a single OS-temp root that `harnessStop` removes:

- its own `DSH_HOME` (`<root>/home`) and a fresh `web` profile, with the candidate plugin installed via `dsh plugin --profile web add <candidatePlugin>`;
- its own copy of the project (`<root>/project`, without `.git`, `.worktrees`, `node_modules`, `dist`, `coverage`);
- its own free port from `portBase` (a configured `productionPort` is never a candidate) and a fresh web process token.

### Configuration

`<project>/.agents/test-harness.json` holds machine-local paths (like the module's default `dshSource`); every field is optional and `DSH_TEST_HARNESS_*` environment variables win:

| Field | Env | Meaning |
| --- | --- | --- |
| `dshSource` | `DSH_TEST_HARNESS_SOURCE` | DSH checkout whose `package.json` version is compared with the running install |
| `dshCommand` | `DSH_TEST_HARNESS_DSH` | The CLI executable (`argv[0]`). It is spawned **without a shell**, so an absolute path containing spaces is fine; a `.cmd` shim is not — point at the real executable |
| `dshArgs` | `DSH_TEST_HARNESS_DSH_ARGS` | Prefix argv for that executable, e.g. `["--import", "<tsx loader>", "<checkout>/apps/cli/src/bin.ts"]` or `["<checkout>/apps/cli/lib/bin.js"]`. The env form is a JSON array |
| `dshEnv` | `DSH_TEST_HARNESS_DSH_ENV` | Extra environment for both CLI calls (JSON object). `DSH_HOME`/`DSH_PROFILE` are always set per instance |
| `candidatePlugin` | `DSH_TEST_HARNESS_CANDIDATE` | Package installed into the test profile; defaults to this package |
| `profile` | `DSH_TEST_HARNESS_PROFILE` | Profile name (default `web`) |
| `portBase` / `portRange` | `DSH_TEST_HARNESS_PORT_BASE` / `…_PORT_RANGE` | Port search window (default 39000 + 100) |
| `healthPath` / `healthTimeoutMs` / `healthIntervalMs` | matching `…_HEALTH_*` | Readiness probe and its budget |
| `installTimeoutMs` / `stopTimeoutMs` | `DSH_TEST_HARNESS_INSTALL_TIMEOUT_MS` / `…_STOP_TIMEOUT_MS` | `dsh plugin add` budget and terminate/wait budget |
| `productionPort` / `productionVersion` | `DSH_TEST_HARNESS_PRODUCTION_PORT` / `…_PRODUCTION_VERSION` | The port to never take, and an explicit production version override |

### The web contract it speaks

A real `dsh web` is **token-gated**: the launcher prints `dsh web: http://127.0.0.1:<port>/?token=<one-shot>`; that URL answers **303 + Set-Cookie**, and `/` answers 401 without the cookie. Node's `fetch` keeps no cookie jar, so the harness copies the token out of the collected stdout, performs the exchange itself and then polls health/page with the cookie. The task-center plugin routes are not gated, so the smoke reaches them directly. Production version detection is explicit config → `DSH_VERSION` → a packaged manifest → the Electron `app.asar` header (plain `fs` cannot follow a path *through* an asar); when none answers, the result is `unknown` and the smoke **fails** rather than passing.

### Visual verification

The isolated instance is also the place where panel/UI work is verified against real renders — the production page is never used for screenshots. `harnessStatus` mirrors `port`, `token`, `url` and `cookie` at the top level so a screenshot tool can be pointed straight at the instance without digging into the nested record:

1. `harnessStart` (tester or user) and take `url` — `http://127.0.0.1:<port>/?token=<one-shot>` — plus `cookie`.
2. Open the page: the token URL answers 303 + `Set-Cookie`, and the plugin panel is what loads behind it.
3. Navigate with stable selectors: click `[data-panel="task-center"]`, wait for `[data-panel-root="task-center"]`, switch with `[data-view="board|queue|workers|status|roles"]`, and inside roles with `[data-roles-tab="worker|tester|reviewer"]` / `[data-roles-pane="raw|injected"]`. Task detail overlays are marked `[data-detail]`.
4. Capture at 1440×900. Every screenshot tool that opens a fresh page loses the panel's in-memory view, so re-walk the navigation prefix for **each** shot; write shots to a normal (non-hidden) directory.
5. `harnessStop` when done.

A first-launch dialog may sit in front of the panel: close the "preview / continue" variant with `click text="继续"`, or focus-then-Escape the login variant with `click text="开始使用"; key Escape`. See `.agents/notes/design/visual-check.md` for the full runbook.

### Real smoke evidence (this workspace)

The source checkout at `J:\workspace\HARNESS\deepseek-harness` is `0.2.1-rc.2`, but its built `apps/cli/lib` predates the multi-patch bundle manifest (`@deepseek-ai/dsh-web-app` declares an array `dsh.bundle.patch`), so `node apps/cli/lib/bin.js --profile web` dies in `loadProfileDirectory`; the source-through-tsx variant also hits that checkout's missing `semver`. `.agents/test-harness.json` therefore drives the **installed runtime CLI** explicitly — the same entry the desktop app's own `dsh.cmd` uses — so no PATH shim (the broken `npm\dsh.ps1`) is involved. After a successful `pnpm run build` in that checkout, `dshCommand: "node"` plus `dshArgs: ["<checkout>/apps/cli/lib/bin.js"]` is the simpler choice.

```text
POST …/action {"action":"harnessStart","project":"J:\…\godot-bridge"}
{"ok":true,"status":"running","port":39000,
 "home":"C:\Users\…\Temp\godot-bridge-harness-Uid58s\home",
 "projectCopy":"C:\Users\…\Temp\godot-bridge-harness-Uid58s\project",
 "profile":"web","pluginInstalled":true,
 "sourceVersion":"0.2.1-rc.2","productionVersion":"0.2.1-rc.2","versionStatus":"match",
 "token":"<printed>","cookie":true,"healthUrl":"http://127.0.0.1:39000/"}

POST …/action {"action":"harnessSmoke"}
{"ok":true,"versionStatus":"match",
 "checks":{"page":{"ok":true,"status":200,"html":true,"token":true,"cookie":true},
           "health":{"ok":true,"status":200},
           "pluginRow":{"ok":true,"status":200},
           "taskCenterAction":{"ok":true,"status":200}}}

POST …/action {"action":"harnessStop"}
{"ok":true,"stopped":true,"processExited":true}
```

Isolation checks run around that sequence: the nested port has no listener after stop, the temp root is removed, the production port still answers, the production `~/.dsh/profiles` mtimes are unchanged and no instance process survives (`netstat`/process sweep). A version mismatch (or an unverifiable version) makes `harnessSmoke` return `ok:false, code:"version-mismatch"` naming both sides; an unreachable instance returns `health-timeout` with the last health status and log tail — never a pass.

## How it works

```
DSH session
  └─ godot-bridge (Host plugin)
       ├─ godot_run_project ──────► subprocess.spawn(Godot -d --path <project>)
       ├─ godot_get_debug_output ─► collect-mode output (incremental offsets)
       └─ godot_command / godot_screenshot / godot_ping
            └─ subprocess.spawn(node -e <bridge> <command> <paramsJson>)
                 └─ TCP 127.0.0.1:9090 ◄── in-game McpInteractionServer autoload
```

- The in-game protocol (`{command, params, id}` + newline) is **identical** to godot-mcp, so the game side and any existing workflows keep working.
- Each command spawns a one-shot `node -e` bridge that connects, sends one line, prints the first response line, and exits. The game server is single-connection/single-command (`_busy`), so short-lived connections are a perfect fit.
- Spawning uses the harness's raw `subprocess` service (not the sandboxed shell executor), so Godot can write its `user://` files without the DSH file sandbox killing it (see Pitfalls).

## Requirements

- DeepSeek Harness (a session with a host runtime)
- A Godot 4.x project with the `McpInteractionServer` autoload registered. If your project does not have it yet, copy `plugin/mcp_interaction_server.gd` to the project root and register it as an autoload named `McpInteractionServer` (godot-mcp projects already have this). **`godot_run_project` also auto-installs it when missing** (copies the vendored file into `autoload/` and registers it in `project.godot`), so no manual setup is needed — and non-Godot projects are completely unaffected.
- `node` on PATH
- Godot executable — resolved in this order: the `godot_path` tool argument → the **`godotPath` plugin setting** (the config of the `tool-godot-bridge` row: the `Godot engine path` field on the godot-bridge card's Plugins page on DSH 0.2.x, the `godot_set_engine_path` tool, or the plugin settings section on 0.1.x) → the `godot` command on PATH. Nothing to configure when `godot` is on PATH; otherwise set your engine path (the plugin author does not preset it — Godot is a portable exe that can live anywhere). Use the **real exe full path**, never a version-manager shim (see Pitfalls).

## Install

**Recommended — one command** (requires the `dsh` CLI):

```sh
dsh plugin --profile web add github:Smalldy/godot-bridge
```

`dsh plugin` is a pnpm forwarder: it installs the package into the profile's `node_modules` and — because the package declares `dsh.bundle` (its `cordis.patch.yml` inserts the `tool-godot-bridge` row) — appends it to the profile's `dsh.profile.bundles` layer list. The `web` profile is the standard one the Web app already boots from, so this simply adds the tools to standard mode — **no new profile is created**. After a restart, the seventeen `godot_*` tools are available in every session on that profile. Listed in the [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) community registry (topic: `dsh-plugin`).

The same command installs a local checkout or tarball (`dsh plugin --profile web add ./path/to/godot-bridge`).

> The plugin is a standard DSH bundle module: it imports `defineTool` from `@deepseek-ai/dsh-tools` and registers via `ctx.tools.register`. It must be installed through the bundle mechanism above. DSH supplies `@deepseek-ai/*` from its own installation through the launcher's runtime resolution: a package installed into the profile resolves them automatically, while a `link:`/symlinked checkout does so only for the names it declares in its own `peerDependencies` (godot-bridge ≥ 0.1.8 declares them — see [DSH 0.2+ compatibility](#dsh-02-compatibility-and-troubleshooting)). Do not copy the file into a user agent preset (`~/.dsh/.agent-presets/...`); that location is outside every resolution scope and cannot resolve `@deepseek-ai/dsh-tools`.

### Uninstall

```sh
dsh plugin --profile web remove godot-bridge
```

Removes the package and its `godot-bridge` bundle layer from the profile — after a restart the seventeen `godot_*` tools are gone from sessions on that profile. The standard `web` profile itself is untouched (this never creates or removes a profile). Stop any running game first with `godot_stop_project`; the plugin's unload cleanup also terminates a Godot child it started. Reinstall any time with the `add` command above.

## DSH 0.2+ compatibility and troubleshooting

DSH 0.2 replaced the old physical module-fallback layer with an in-process **runtime resolution** that the launcher installs into Node's ESM and CommonJS resolvers. The resolver decides, per importing module, whether a bare `@deepseek-ai/*` specifier is routed to the installation's own copy — which is what a plugin importing harness packages depends on:

- **Installed inside the profile** (`dsh plugin add github:…`, a tarball, or any copy under `$DSH_HOME/profiles/<name>/node_modules`): harness packages resolve from the installation automatically. Nothing to declare.
- **Installed as a `link:` dependency** (a symlinked local checkout): the plugin's real path lives outside the profiles tree, and Node's ESM loader resolves symlinks before importing. Such a *linked root* gets harness packages routed **only for names the plugin declares in its own `peerDependencies`** — the resolver reads `peerDependencies` keys, not `dependencies`. godot-bridge ≥ 0.1.8 declares `@deepseek-ai/dsh-tools` and `@deepseek-ai/schemastery`, both marked optional so pnpm never tries to install harness packages from the registry.

### Symptoms

| Symptom | What it means | What to do |
| --- | --- | --- |
| All seventeen `godot_*` tools are missing and the launcher log shows `ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/dsh-tools' imported from …/godot-bridge.mjs` | Harness packages were not routed to the installation copy. For a `link:` install this is a missing `peerDependencies` entry (the 0.1.7-and-earlier failure mode) | Update to godot-bridge ≥ 0.1.8, or install without a symlink (`dsh plugin … add ./godot-bridge-<version>.tgz`) |
| The launcher prints `dsh: skipping profile bundle "godot-bridge": …` and the plugin page lists an error | The declared DSH peer range does not match the running runtime version. A **missing** peer imposes no constraint, so it never produces this message | Update the plugin, or accept the risk explicitly: `dsh plugin --profile <profile> allow-version godot-bridge@<version> --dsh-version <runtime> --accept-risk` |
| `godotPath` is absent from the plugin settings page and `godot_set_engine_path` says the settings service is unavailable | A pre-0.1.8 build on DSH 0.2.x, where the legacy `settings.register` API no longer exists | Update to godot-bridge ≥ 0.1.8 |
| The **godot-bridge card** shows no `Godot engine path` field | The browser half that registers this bundle's configuration section (keyed slot `plugins.bundle.config`, keyed by the package name) is not loaded: this bundle's only row is switched off, the host was not restarted after the update, or the installed copy predates the browser half (≤ 0.1.8). On DSH 0.1.6–0.1.x the runtime has no settings-form service, so the field is absent there by design | Update to godot-bridge ≥ 0.2.0 and restart DSH — the update replaces the installed files, and the `dsh.client` scan is cached per Loader row until a restart. If the row is switched off, switch it on. Otherwise set the path with `godot_set_engine_path`, or add a `config:` block to the row (see [install](install.md#gui-field-on-dsh-02)) |
| After upgrading from 0.1.x the tools run a **different Godot build** than the one configured | The pre-0.2 `settings.yaml` section is not migrated (DSH imports it by plugin entry id, and this row's id is `tool-godot-bridge`), so resolution fell back to `godot` on PATH — typically a version-manager shim | Nothing to do on godot-bridge ≥ 0.1.8: on first start the recorded value is written back automatically (only when the field is empty and the file still exists). If a warning names a dropped value instead, the restore did not take effect (the recorded path is gone, or the write was rejected) — set it again with `godot_set_engine_path` |

### Verifying

```sh
npm run check                                                              # static contract check — no DSH needed
node scripts/diagnose-dsh-resolution.mjs --profile <profile> --expect ok   # uses the installed DSH app
```

`npm run check` fails when a bare `@deepseek-ai/*` import is not declared in the manifest, when the bundle patch is missing or does not reference the package, when the entry point loses its named exports, or when the browser half breaks its own contract (a `dsh.client` member the host does not read, a platform other than `web`, an `exports["./client"]` target that is missing or unshipped, a `__ModuleLoader__` id that is not the package name, a `require()` outside the platform seed modules, a `plugins.bundle.config` key that is not this bundle's package name, or a `plugins.row.config` key that names no row the patch declares). The diagnostic prints the profile's bundle layers, skipped bundles, detected linked roots, and the resolution result for each harness import the plugin makes — run it before and after a fix, or when DSH changes its resolution rules again.

Then restart DSH (or reload the profile from the Plugins page) and confirm that a new session lists the seventeen `godot_*` tools.

## Update notices

On load the plugin does a **best-effort** version check: it fetches the repo's `main`-branch `package.json` (`raw.githubusercontent.com`, 5s timeout, silent on failure/offline) and compares it with the installed version. When a newer version exists it registers a system-prompt section, so the model surfaces **"godot-bridge update available: installed X, latest Y"** in every session until the plugin is updated (`dsh plugin --profile web update godot-bridge`, then restart DSH). `godot_ping` additionally reports `plugin_version` / `latest_version` / `update_available` for on-demand checks.

**To publish an update**: bump `version` in `package.json` (the release marker) and push — an unchanged version triggers no notice. Forks: set `repository` in `package.json` and the check follows the fork automatically.

Known limitations: the notice is a system-prompt section, so presets whose persona is complete/suppressing (e.g. 极简模式 / `minimal`) do not show it; the check needs network access at boot.

## Usage

```text
godot_run_project            # start the game (default: current workspace)
godot_ping                   # confirm 9090 answers
godot_command get_scene_tree # inspect the scene graph
godot_command get_ui_elements
godot_command eval {code: "return get_tree().current_scene.name"}
godot_command click {x: 576, y: 300}
godot_screenshot             # view the game
godot_get_debug_output       # read the boot log
godot_stop_project           # done
```

Godot executable resolution: per-tool `godot_path` argument → the `godotPath` plugin setting (the `tool-godot-bridge` row's config: the `Godot engine path` field on the godot-bridge card's page on DSH 0.2.x, the `godot_set_engine_path` tool, or the plugin settings section on 0.1.x) → the `godot` command on PATH. Nothing to configure when `godot` is on PATH; otherwise set the engine path and point at the **real exe**, never a shim.

## Pitfalls (learned the hard way)

- **DSH file sandbox vs Godot `user://`**: launching Godot through the sandboxed shell executor (pwsh/bash tool) propagates a restricted token and Godot crashes at startup (`Failed to open 'user://logs/…'`, signal 11). godot-bridge spawns via the raw `subprocess` service, which is not file-confined — this is why it works.
- **`node -e` argv**: with `node -e <script> <cmd> <json>`, extra args land at `process.argv[1]`/`[2]` (not `[2]`/`[3]`).
- **eval in debug mode**: a compile error in `eval` code pauses the game at the debugger (same as godot-mcp). Use dynamic access (`p.get("global_position")`) to dodge static typing, and `godot_stop_project` + `godot_run_project` to recover.
- **Real exe, not a version-manager shim**: a shim exits immediately and orphans the real Godot; process management misjudges it as dead.

## Project layout

```
plugin/godot-bridge.mjs           # the plugin entry (standard DSH module, named exports name/inject/apply)
plugin/task-center/               # task center host half (schema / board / service / locks / dispatch / merge / git / api / state / tool / routes / skill / harness / index)
client/client.js                  # browser half: engine-path form + task center panel (dsh.client)
plugin/mcp_interaction_server.gd  # vendored from godot-mcp (MIT) — in-game TCP server autoload
plugin/godot_operations.gd        # vendored from godot-mcp (MIT) — headless ops script
plugin/validate_script.gd         # vendored from godot-mcp (MIT) — GDScript compile-check
package.json                      # dsh.bundle + dsh.client manifest (for `dsh plugin add`)
cordis.patch.yml                  # bundle patch layer (inserts the tool row)
install.md / install.zh-CN.md     # detailed install & maintenance
ARCHITECTURE.md / ARCHITECTURE.zh-CN.md  # how it replaces godot-mcp + protocol details
COVERAGE.md / COVERAGE.zh-CN.md   # full tool-by-tool comparison vs godot-mcp
CHANGELOG.md / CHANGELOG.zh-CN.md  # release history
scripts/check-plugin-contract.mjs  # static dependency-contract check (`npm run check`)
scripts/check-target-history.mjs   # branch-protection history guard (`npm run check:target`)
scripts/setup-hooks.mjs            # installs the pre-commit target guard (`npm run hooks:install`)
scripts/diagnose-dsh-resolution.mjs  # re-runnable DSH runtime-resolution diagnostic (dev only)
```

The task center writes project-local runtime files under `<project>/.agents/`: `tasks.json` (the board), `roles.json` (role profiles) and, optionally, `test-harness.json` (machine-local harness paths). They are working state, not source — gitignore them.

`mcp_interaction_server.gd`, `godot_operations.gd` and `validate_script.gd` are vendored from [godot-mcp](https://github.com/tugcantopaloglu/godot-mcp) (MIT). The plugin locates the headless scripts relative to the module (`import.meta.url`); pass an explicit `ops_script` / `validate_script` argument to override.

## License

MIT
