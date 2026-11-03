# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **Worktree card rebuilt as a list with safe cleanup (T-143)**: the status page's worktree card is now a header summary (`N worktrees · N active · N cleanable · N needs review`), a main-checkout row, the active task worktrees, and **every** stale checkout as its own row (task/type, path, branch, short HEAD, clean/dirty and merged/unmerged badges, per-row action) instead of a folded “stale worktrees” line with “cleanup is not available yet”. Safe rows offer 清理 with a checkbox for the batch action; dirty/unmerged rows offer 强制清理 and require a second confirmation click before anything is sent. The card preflights automatically through `worktreesCleanup { dryRun: true }` and drives availability/reason from the response's `candidates`/`wouldRemove` (not just `snapshot.safe`, so outside-root/unverified entries stay refused), previews the exact paths to be removed, executes `{ dryRun: false, paths: [...] }` only for the selected safe rows (or `{ force: true }` for a confirmed dirty/unmerged row), shows the removed/kept/failed result, reloads the snapshot on success and never removes a row optimistically. The list scrolls inside the card, the header scrolls with it, and all new styles use the T-133 tokens.
- **Worktree inventory classification + safe cleanup API (T-142)**: `/state.worktrees` now classifies every non-main checkout with `taskId` (derived from the directory or branch when the card is gone), `target`, `dirty` (`git status --porcelain` inside the checkout), `merged` (`merge-base --is-ancestor HEAD <target>`), `safe` and `reason` (`active` / `dirty` / `unmerged` / `safe`; an unverifiable probe degrades to `unverified` instead of guessing). The new user-only `worktreesCleanup` action previews by default: `{ dryRun: true }` returns `candidates` (each with `wouldRemove`/`why`), `removed`, `kept` and `failed` without touching anything; `dryRun: false` removes only non-main, non-active, clean+merged checkouts, deletes their merged branch, and prunes stale admin entries. A dirty or unmerged checkout is removed only with `force: true`, an unmerged branch is never deleted (only its checkout), and paths outside the project root, the main checkout and cards that are still running are always refused. The action is user-only — the model tool does not expose it, and a direct agent call is refused with `user-only`.
- **Button labels are centered (T-141)**: `.gbt-btn` is an inline-flex control that only had `align-items:center`, so after T-140 made the two verdict buttons equal halves (`flex:1 1 0`) their labels sat left-aligned inside each half and looked off-centre. The base rule now adds `justify-content:center` (icon buttons keep their `gap:5px`), and the verdict buttons also declare `text-align:center`. No DOM, action, size, colour or spacing change — plain buttons and icon buttons alike simply centre their label.
- **Executors page rebuilt around three explicit layers (T-137)**: the page now answers “which project / which team / who is doing what” at a glance. The head names the panel project, the session Team with its own project, the lead (a session-named lead renders as “本会话 Lead” with a short id and a copy button instead of the raw `session-…` string) and the short session id (full id only in `title`/copy); the global project-team line formats a session-shaped lead the same way, then shows dispatch-sized capacity chips — `并发 N` from `snapshot.dispatch.maxConcurrent` and `上限 N` from `workers.cap` (the `maxWorkAgents` hard ceiling; `workerCap` is only a fallback when a host lacks it) — plus live 执行中/空闲/启动中/失败 counters. When `workers.projectMatch === false` a restrained warning says the workers belong to the request session's team in another project, never silently. The five-column role table became three (plus merger when present) compact cards with live `执行中 / 空闲 / 有卡 / 队列` numbers and no “configured instances” — team size is a dispatch setting (T-138). The member list is one table: 角色 · 成员 · 状态 · 当前任务 · 队列, role badges from `member.kind`, mono truncated names with a full-name title, the queue as its own column, and idle members showing a single 待命 instead of the long process sentence. Cards and tables use T-133 tokens only, role cards reflow via `auto-fit`, and the table scrolls inside its wrapper so a ~579px panel never overflows. The role editor no longer has an instance-count field and the Roles page states that team size comes from the dispatch settings.
- **Executor team project made explicit (T-139)**: `/state` now decorates `workers` and `team` with `project` (the workspace root of the Lead session whose Team is shown, `null` when unknown) and `projectMatch` (`true` when it is the snapshot's project, `false` when it is another one, `null` when the session's project cannot be resolved). This keeps T-122/T-130 semantics — the member table is still the REQUEST session's Team, never switched by project and never cached — and only removes the silent ambiguity behind T-136: a panel pinned to project A with a session that belongs to project B now receives `workers.project = B`, `workers.projectMatch = false`, `team.project = B`, `team.projectMatch = false` instead of an unqualified Team. The decoration lives in the snapshot (`requesterRootOf`/`projectIdOf`); `workerPool` remains a pure session read with no project fields. The panel warning that consumes these fields belongs to T-137.
- **Team size moved out of role definitions (T-138)**: a role profile now describes BEHAVIOUR only (name/role/stage/prompt/skills/context/permissions) and carries no `instances`. The worker pool target is the dispatch cap — `min(dispatch.maxConcurrent, dispatch.maxWorkAgents)` — exposed as `workers.workerCap` / `workers.effectiveWorkerCap` next to `workers.cap` (the hard `maxWorkAgents` ceiling) and `workers.maxConcurrent`. Dispatch starts from one worker and grows the pool by exactly one slot per pass while a ready card waits and the cap allows it; a full pool answers `role-full` with cap/live/busy numbers. Review/test stay fixed at one instance per session/team (`ensureStageRoles` passes `count: 1`; stage queue capacity is 1), and `bootstrapTeam` still creates exactly one worker. `ensureRole(kind, { count })` now takes the size from the caller, and `workers.roles.desired` is derived from the dispatch caps instead of a profile. Old `.agents/roles.json` files still load — the `instances`/`concurrency` fields are dropped, never consulted, and reported as `deprecated: { instances: 'ignored', movedTo: 'dispatch.maxConcurrent / dispatch.maxWorkAgents' }`; the role config version is now 2, and a save persists the clean shape. The roles API accepts-but-ignores `instances` from old clients and reports the same `deprecated` marker.
- **Card verdict area styled as part of the card (T-140)**: the review/test verdict block on a board card now has its own separator and rhythm instead of two bare buttons under the meta row — a `0.5px` top border with `10px` padding, an 11px quiet heading, an actions row with an 8px gap, and two equal-width 30px buttons. Passing the review/test is the card's primary (brand-blue solid) action; the blocking verdict stays a red danger outline. Opening the reason form stacks a small secondary label, a full-width token-styled textarea (64px min-height, 8px radius, vertical resize) and the same equal-width submit/cancel row. The card itself gets `10px 11px` padding and a 7px gap so title, meta and verdict breathe together. Tokens only (T-133 palette), no interaction or DOM change.
- **Board scrolling in narrow panels (T-135)**: the board is now its own bounded horizontal scrollport — `.gbt-boardwrap` is a flex column with `height:100%`/`min-height:0`, `.gbt-board` scrolls its own overflow (`flex:1 1 auto;min-height:0;overflow:auto`, thin themed scrollbar), and `.gbt-cards` can shrink (`flex:1 1 auto;min-height:0`) so each column scrolls internally. The kind filter stays above the scrollport and is never scrolled away. A new `useEffect` with the pure `tcFirstNonEmptyColumn` helper parks the scrollport on the first column that has cards whenever the task count or the kind filter changes (an already-visible target is left alone, an all-empty board resets to the left), so a done-only board opens on the 131-card 完成 column instead of a screenful of empty columns.
- **Panel palette follows the DSH theme (T-133)**: the task center no longer invents theme tokens or ships hardcoded colours. In dark mode the kind filter is no longer a near-white band — the container is `transparent`, the selected pill uses `--dsw-alias-bg-module-platform` with `--dsw-alias-label-primary` and the hover uses `--dsw-alias-interactive-bg-hover`; tabs, chips, pills, count badges and selected rows use the module/hover/layer-2 tokens instead of the non-existent `--dsw-alias-bg-layer-4`; the investigation accent uses the brand blue `--dsw-alias-state-business-primary` instead of hardcoded teal; status tones map to `--dsw-alias-state-success-primary` / `--dsw-alias-state-warn-label` / `--dsw-alias-state-error-primary` on neutral module backgrounds, and error text uses `--dsw-alias-state-error-primary` instead of the missing `--dsw-alias-label-error`. Layout, spacing and behaviour are unchanged.

### Added

- **Investigation cards in the panel, skill and docs (T-132)**: the board marks an investigation with an **Investigate** badge and a kind filter (All / Dev / Investigate) and shows "Investigating N" in the running column; the task detail renders only the **Run → Deliver** spine (no review/test/merge stages, no target/merge progress) plus the delivered report — summary, body, an evidence table (command / exit / output tail) and artifacts, with "Report not delivered" before that — and a running investigation never shows the submit box. The queue and workers views carry no reviewer/tester slots for it. The runtime skill gained a full 「调查卡（investigate）」 chapter (when to use it, `kind: "investigate"`, the `report` action and its size limits, the scratch/probe rules, no commit/submit/merge, the refusal codes and the panel rendering) inside the 6–10 KB budget, and both READMEs document the investigation lifecycle with `create` + `report` examples.
- **Investigation cards (`kind: 'investigate'`)**: a card can now deliver a REPORT instead of mergeable code. `create` (and the tool) accept `kind` (`dev` default; an unknown kind is refused with `invalid-kind`; `update` cannot change it and an old board without the field means `dev`). Dispatch builds a DETACHED scratch checkout from the target head (`.worktrees/<id>-<attempt>`, no branch, no `writeFiles` lock, no reviewer/tester), and hands a host-fixed investigation brief (investigate only; do NOT commit, do NOT submit; a second checkout is allowed only at `probe-<id>-*` and every such path must be listed under `artifacts`). The card completes with the new `report` action (assignee or user; `summary` at most 4 KB, `body` at most 64 KB on the board with the full text in `.agents/reports/<id>.md`, at most 20 evidence rows of `{command, exitCode, outputTail}` with 4 KB tails, artifacts as paths). It clears the lease/assignee/dispatch, releases locks, force-removes the scratch and every `probe-<id>-*`, records an accidental commit in the scratch as `probeCommits` and NEVER creates a merge request. `submit` answers `investigation-report-only`, the review/test/merge actions answer `not-a-dev-task`; reopening clears the report (and says so in history); a done investigation satisfies a dependent while a dev dependency still needs the merge; `counts` carries `investigating`, `list` carries `kind`/`reportSummary` and `get` carries the full report. Panel presentation is a separate card.
- **One-call onboarding (`onboard`)**: a project is now entered with a single action — it resolves the project root (explicit path, else the session workspace walked up to the nearest git project, accepting a `.git` FILE for worktrees), checks the git/Godot markers, binds the board through the same preflight as `openProject`, reads the compact board facts, bootstraps a missing Team, and returns a short brief plus ONE machine-readable `next` step. The stages (unusable / choose / setup / attention / active / empty / idle) and next codes cover a project without `git init`, a directory that is not a project, a blocked board, a pending approval, a hard-broken checkout and a paused dispatcher; it never guesses a path, never creates a card, never runs `git init`, never starts dispatch and stays under 20 KB. The skill's entrance section, the always-on rules and the tool description now route through it.
- **Team bootstrap creates only the worker slot**: `bootstrapTeam` (and therefore onboarding's team step) provisions the Lead + worker; the reviewer and tester slots are provisioned later by their own stage (review on submit, test on entering testing), so no three agents are spawned before a card exists. The worker wakes with a standby brief (no card: do not hunt for work, do not submit, do not edit) instead of a fake `bootstrap-team` card id, and the answer carries `deferred: ['reviewer', 'tester']`.
- **Runtime skill and always-on rules for the task center**: activating the row registers the skill `godot-bridge-task-center` (its body is generated from the action registry: positioning, workflow, action matrix, write-card rules, refusal codes, the Godot launch rule and the panel layout) and injects four always-on rules — `start` is only a request the user approves, verdicts belong to the matching role, task work never commits to the target, and `.agents/tasks.json` is never hand-edited. The `task_center` tool description is now a short router to that skill instead of a two-kilobyte API narrative. A host without the skill registry or system-prompt service skips both silently. The registration carries `source: 'runtime'`, which the registry validates when the skill is **loaded** (a missing source listed the skill and then failed the load).
- **Host mechanical verification (`verify`)**: a task can declare `verify: { command, timeoutMs? }` (a shell string that may chain). After an approval builds the test candidate the HOST runs it there through the unconfined subprocess service (default bound 10 minutes) and records `test.hostCheck` — command, exit code, timeout flag, duration, a ≤4 KB output tail and a timestamp. Exit 0 enters TESTING with the baseline in the tester's brief; a non-zero exit or a timeout is recorded as a failed test by the host, returns the task to running with the evidence, discards the candidate, notifies the owner and never opens a tester round or reaches the merge queue. A malformed declaration is refused with `invalid-verify` instead of being dropped. The tool exposes `verify` as an object parameter (`null` clears it), and a moved target re-runs the check on the rebuilt candidate.
- **Two-part tester evidence**: the tester brief carries the host baseline and requires the evidence to separate 【host baseline】 from 【my probes】 — the host run is a floor, not a ceiling, and the tester may re-run the same command (stating why) or run any other suite.
- **Named events and structured test rows**: activity rows and detail events show the member name the host wrote (`byName`; the user reads as "you") instead of depending on the live roster, falling back to the row's own role word (worker / reviewer / tester / merger) plus the label for an unresolvable id (「member <label>」 only for records without a role word). The status page header's 最近活动 timestamp now comes from the same event stream as the activity card, and a heartbeat-only board says it has nothing newer instead of showing a stale or blank line. A test event renders as a structured summary — 通过/失败 · exit N · Ns — with the full evidence behind a 查看全文 toggle, and each row keeps **the event's own verdict**, so a fail-then-pass history still shows the earlier failure.
- **Visual verification on the isolated instance**: `harnessStatus` mirrors `port` / `token` / `url` / `cookie` at the top level so a screenshot tool can open the token URL directly, and the panel exposes stable `data-*` hooks (`[data-panel-root]`, `[data-view]`, `[data-roles-tab]`, `[data-roles-pane]`, `[data-detail]`) for the navigation-and-shoot flow documented in the README and `.agents/notes/design/visual-check.md`.
- **Status page and task detail rebuilt**: the status tab is a one-line status plus dispatch, worktree and agent cards with a full-width activity stream whose events are localized sentences; the task detail is a wide, container-width-aware overlay with a dispatch → implement → review → test → merge stage spine (rounds and completion times), a "where it is now" body, a summary column, and the key events and latest rejection reasons up front. `rolesPreview` joins the action list so the panel can show the exact text the host would inject.

### Changed

- **Every card-affecting path follows the card's session/project (no any-Lead guess)**: stage roles are provisioned per `(role kind, ownerSession)` — two sessions with cards in the same stage get one reviewer each — and a legacy ownerless card is adopted only when exactly ONE live Lead runs in the project (0 or many is reported and skipped). `memberLiveness`, `interruptMemberNamed` (lease handover, stage blocks, review-round limit), the review/test timeout sweeps and the role panel (`rolesList`/`rolesReplace`/`rolesDrain`/`rolesReset`, the instance list, the roster and the preview Lead) all resolve the team through the card/panel session, so a same-named member of another team is never judged dead, never interrupted and never listed/replaced. Environment probes carry their project: the dispatcher reading and the per-card dirty streaks are project-scoped, so a dirty checkout in A can no longer show up in B (and a clean B never washes A). `state.memory.projectHint` stays a path/display base only, and a static guard asserts no team/lead resolution reads it.

- **The task-center state snapshot is slim, with on-demand detail, a paged list and `since` deltas**: `GET /state` now returns only the fields the panel renders (no spec / acceptance / evidence / full history), plus `seq` / `full` / `removed`; `GET /task?id=` serves one task's full detail (the drawer and the edit form fetch it on open and cache it per `updatedAt`), and `GET /list?status=&cursor=&limit=&q=` pages summaries with server-side search. `GET /state?since=<seq>` answers `{tasks: [changed], removed: [ids], full: false}`, while a missing / too-new cursor, a project switch or a gap in the bounded delta log falls back to `full: true`. The agent-facing `board` action is unchanged and still returns full details. Measured on this repository's real board (84 tasks, 81 done) served through the candidate route: 1,275,964 bytes of detail snapshot becomes 183,096 bytes of summary (well under the 200 KB target) - `merge.output` / `merge.tests` / the merge file arrays / `test.evidence` / `review.reasons` are no longer shipped at all (only status, round, timestamps and `declaredCount` / `actualCount` / `outputLength` / `testsLength` / `evidenceLength` remain; `/task?id=` keeps the strings). The panel polls with the delta cursor instead of resending details every 2.5 s.

- **The task-center skill now defines the Lead role and the entry flow, and corrects four misleading statements**: the body starts with 「你是谁：Lead」 (what the Lead does, the other roles, and the things the Lead must not do), then an entry flow (resolve the project root, `openProject`, read `board`, print the fixed brief, no side effects), documents `pause` as the dispatcher switch and `tick` as a settle-now diagnostic, replaces the "small changes can go straight to the target" advice with "never commit the target directly" (plus the hotfix-branch + guard-exception route), clarifies `unknown-project` as "not bound yet or wrong path, `openProject` first", adds the role-slot serialization (`queuePosition`, queue time not silence), the meaning of `merged` (the ref really advanced; `target-not-advanced` otherwise), per-card `target`, and the guard-exemption prohibition. Duplicated provisioning prose was merged and the read-only `skillsCatalog` wording tightened; the action lists are still generated from the live registry.

- **The sidebar entry names its plugin**: the task-center sidebar label is now `GodotBridge 任务中心` (English `GodotBridge Task Center`) instead of the bare `任务` / `Tasks`, so users can tell which plugin the UI entry comes from; the panel title stays `任务中心` / `Task Center`.

- **Watchdogs measure silence, not wall time**: every identifiable `task_center` call by the reviewer or tester renews that phase's activity clock (memory only, so a host restart can block a round that was already silent). A review is reminded at 10 minutes of silence, warned at 20, and blocked after a further 2-minute grace; a test round is reminded at 10 and blocked at 20 plus the grace, so a verdict landing on the boundary is not lost. `passTest`'s merge waits out the declared `verify` budget, because a moved target rebuilds the candidate and re-runs that check.
- **Role profiles are edited as copies**: the built-in worker / reviewer / tester profiles are immutable (`builtin-profile-immutable`); Fork creates a named draft copy, and Save creates it, binds its stage and replaces the running instances in one click. The panel no longer has a separate bind / apply / replace vocabulary — one "current use" picker — and the editor is two columns: the raw prompt and the exact text the host injects, produced by the real brief builders. Deleting the profile in use falls back to the built-in default immediately.
- **Panel navigation**: five tabs (board, queue, workers, status, roles). The tab strip carries no counts any more (the numbers live in the board header) and the file-lock tab is gone.

### Removed

- The manual file-lock surface: the `lock` / `unlock` / `forceUnlock` actions and the file-lock tab are gone. Locking is entirely automatic; `locks` stays as a read-only diagnostic.

### Fixed

- **The task-center panel localizes Host failures instead of showing English sentences**: the panel routes (`unknown-project`, `content-type`, `origin`, `bad-request`, `no-action`) now answer with a stable `code` and optional `params` instead of a hardcoded English sentence, and the browser half renders that code from the bilingual `TC_DICT` (`err_*` keys), falling back to the Host's own `message` for an unknown code so older/newer Hosts still say something truthful. Tool-facing errors for agents stay English by design (they are a different audience; the 500 `failed` message carries diagnostic exception text, not UI copy).

- The roles page could show a fake "saved ✓" banner after a refused save; the banner now reports the actual outcome.
- The roles editor could render an empty left column for built-in profiles, duplicate anchors and double card borders; the empty state, section grouping and single card are corrected, and the injected preview no longer shows a different identity's text.
- The task detail used to be a fixed 400 px drawer; it is now a wide overlay that adapts to the container width (full screen under 900 px).

## [0.3.0] - 2026-10-20

### Added

- **Task Center v2**: a project-level task board (`<project>/.agents/tasks.json`), dependency-driven dispatch with explicit start/pause and consent, priority ordering, concurrency and retry settings, file locks, and recovery of claims left by a previous host process.
- **Review/test phase machine**: every task walks `pending → running → reviewing → testing → done`, with `blocked`/`cancelled` as exits. `submit` commits the worktree and enters REVIEW; a reviewer approves or requests changes; an approval builds an independent test candidate and enters TESTING; a passed test merges and turns the task DONE. Each phase stores its own record (round, actor, verdict, reasons/evidence), and `reopen`/`retry` keep that history.
- **Roles system**: three fixed kinds — worker (implement), reviewer (review), tester (test) — each provisioned as an Agent Teams teammate slot (`worker-1`, `reviewer-1`, …) under the resolved Lead. Profiles live in `<project>/.agents/roles.json` (version 1; a normalised `worker`/`reviewer`/`tester` always exists): role kind, stage binding, instance count (1–8), permissions, fresh/fork context, skills and a prompt template. The host auto-provisions a missing stage role and replaces a dead or timed-out one; reviewer and tester are read-only independent contexts, and a worker can never review or test its own task.
- **Independent reviewer and candidate tester**: `approveReview` / `requestChanges` belong to the reviewer (or the user), `passTest` / `failTest` to the tester (or the user). Entering TESTING builds a throwaway candidate `<project>/.worktrees/test-<id>` on branch `test/<id>` from the current target head plus the task branch, and sends the tester a self-contained brief (acceptance criteria, candidate path/branch, runbook, evidence format). A worker never decides its own verdict.
- **Host-driven merge queue and auto-merge**: a five-second host sweep enqueues every tester-accepted request into one serialised merge queue. The queue integrates the accepted candidate in a throwaway `merge-<id>` worktree, refuses when the target head moved (the candidate is rebuilt from the new head and the test round restarts), records conflicts readably, and merges at most once per task — a repeated pass or a duplicated request cannot double-merge.
- **Review/test timeout policy**: an undecided review is reminded to the reviewer after 10 minutes and blocks the task for triage after another 10; an undecided test round is reminded after 10 minutes and blocks at 20. The review round cap is 3. A task blocked by either policy names its round, elapsed time, actor and candidate state instead of stranding silently.
- **Host action watchdog**: each async host action (candidate build, candidate merge, merge request, role provisioning, notification) is bounded at 2 minutes. A stuck action answers with `queue-timeout` / `action-timeout` and any late write from the abandoned unit is refused, so a hung await can never hold the action or the merge queue forever.
- **Roles and Status UI**: the panel has board / queue / workers / locks / status / roles tabs. The board is seven columns (ready, waiting, running, reviewing, testing, done, blocked); the status tab shows live agents, the worktree inventory and a host activity ring; the roles tab is a single **role context editor** card.
- **Role context editor**: one main card with segmented 实现/测试/评审 (worker/tester/reviewer) tabs, a read-only identity row plus the profile selector and stage binding, an editable context template with the host variable catalogue (insert chips + descriptions), the host-fixed blocks (duties, permission boundary, verdict schema — generated by the real brief builders and marked host-fixed), the SKILLS field with a catalog dialog, and FORK / SAVE / APPLY. A successful fork/save immediately retargets the editor and Apply (no waiting for the next poll); a failed save keeps the draft and its edits.
- **Role context templates and skill management**: a profile prompt is a template that may inject `{{TASK_ID}}`, `{{TASK_TITLE}}`, `{{SPEC}}`, `{{COMPLETIONS_DEF}}`, `{{GIT_INFO}}`, `{{PROJECT}}`, `{{LEAD}}`, `{{ROLE}}` and `{{STAGE}}`; a save naming any other variable is refused with `invalid-role-variable` and the allowed list, and an empty template is legal. The new user-only, read-only `skillsCatalog` action lists the host skill registry (`ctx.get('skills').list`) for the panel's skill picker and degrades to a readable `skills-unavailable`.
- **Isolated DSH test harness**: `harnessStart` / `harnessStatus` / `harnessSmoke` / `harnessRestart` / `harnessStop` (tester- or user-only) start a disposable DSH instance — its own `DSH_HOME`, profile, free port and project copy — install the candidate plugin into it and prove the page, health, plugin row and task-center routes answer, without touching the production profile, session or port. A version mismatch (or an unverifiable version) fails the smoke instead of passing.
- **Worktree creation robustness**: every `git worktree add` gets its own 180-second timeout instead of sharing the general git/subprocess budget; a timeout or a failed add rolls back what it may have registered (the worktree entry, the branch, the lock, pruned metadata), retries once, and creation is serialised per repository so two tasks never race the same worktree metadata. A project that cannot host worktrees still refuses dispatch up front with a readable reason.
- **Executor and lock visibility**: the workers view shows the lead, cap, busy/idle/provisioning/failed counts and each WorkAgent's current task; the locks view names the holder task/agent and the ready tasks that would wait on the file (advisory contention, not a FIFO queue).
- **Start consent**: an agent's `start` records `dispatch.request` instead of starting the scheduler; the panel shows who asked and why, with approve/reject. `pause` is immediate for either side.
- **GUI**: rewritten panel with the seven-column board, queue, workers, locks, status and roles views, dispatch settings, a pending-start banner and a 2.5-second host snapshot poll.

### Changed

- The board schema is version 2. A version-1 board is migrated on read (its old statuses collapse into the current vocabulary, `blockedBy` becomes `dependsOn`, a stale claim is released); a future version is refused rather than downgraded. Task ids are unique by construction, `seq` can never collide, and history is capped at 120 entries.
- **`submit` is no longer completion**: it enters REVIEW. A task reaches DONE only after an independent review AND an independent test pass (or the user/merger completes it manually). `accept`, `reject` and `requiresReview` are gone; a legacy `review` task migrates to `done`.
- **Lease semantics (final)**: a running task holds a 60-minute lease; every assignee activity renews it unconditionally and a fixed five-minute host heartbeat renews it too, so a long tool run never loses its claim. A lapsed lease is settled by liveness, not by the clock: a live holder keeps the task (bounded by a four-hour per-attempt cap, with a `lease-extended` event) and only a gone/failed session is handed over, after an interrupt. One task never has two live agents, and a handover adopts the previous attempt's worktree and branch when it left a commit. The board exposes `leaseRemaining` / `leaseReminder` and records `lease-handover` / `attempt-adopt` events.
- **Merge queue idempotency**: candidate merging is guarded per task and idempotent — the queue records one merge per task, refuses a request whose candidate is already merging or merged, and treats a moved target as "rebuild and retest" instead of merging stale trees.
- The browser half no longer contains a mock store. It fetches the host snapshot, sends one action and renders the answer, so a host failure can never reach a user as fabricated work.
- **Branch protection and hotfix traceability**: `scripts/check-target-history.mjs` (`npm run check:target`, wired into `npm run check`) refuses a target branch whose non-merge commits cannot be explained by a `task/`/`test/`/`merge/` merge, a done+merged board task, or a declared emergency exception; `scripts/setup-hooks.mjs` installs a `pre-commit` guard that blocks direct commits on the target unless `TASK_CENTER_MERGE=1`. The two merge-queue hotfixes are recorded as emergency exceptions — `1695506` (merge) and `2c895b4` (idempotent candidate merging + bounded git subprocesses), retro-covered by T-30's regression tests and the bounded host-action path the watchdog now enforces.
- The dispatch settings modal exposes a single value, maximum concurrency. The WorkAgent cap is derived as concurrency + 1, spawning is on, and the retry limit stays at its internal default of 3; the `settings` action still accepts the advanced knobs for tool and HTTP callers.
- Dispatch claims a task before anything leaves the process, records the delivery result, and blocks a task after the configured attempt budget instead of retrying into the void.
- **Role administration is user-only**: `rolesList` / `rolesCreate` / `rolesUpdate` / `rolesDelete` / `rolesBind` / `rolesDrain` / `rolesReplace` / `rolesReset` and `skillsCatalog` are hidden from the tool enum and refused for agents; a profile save is validated (name, kind, stage, instances, context, permissions, skills, bounded prompt and template variables) before it reaches `roles.json`.

### Fixed

- Dispatch ignored priority and could hand several ready tasks to the same idle teammate in one pass.
- WorkAgent submissions could be rejected because the board stored a Team member name while the tool measured the session id; the identity is now recorded on both sides.
- Expired task leases were never reaped, and the panel's create/release/submit/unblock/reopen actions did not match the host vocabulary.
- A dependency that was deleted or cancelled made its dependents wait forever without a visible reason; broken dependencies are now reported.
- Switching from the task center to the chat panel and back reset the view and the selected task to the board; both now survive the slot remount.
- A submitted task could sit in REVIEW or TESTING with no verdict forever; the timeout policy now reminds once and blocks for triage with the round and candidate state.
- A failed worktree creation could leave a registered worktree, a half-created branch or a stale lock behind and break every later dispatch in that repository; it now rolls back, retries once and serialises creation per repository.

### Removed

- The `/task` slash command and the `@deepseek-ai/dsh-llm` peer dependency.
- The sample store, seed board, simulate/reset controls and the `__fixture` test seam.
- The five-column submit-is-done board and the `verify-<id>` self-test worktree: the phase machine's independent candidate replaces them.

## [0.2.1] - 2026-10-24

### Fixed

- **eval no longer deadlocks under the local debugger (issue #13).** `godot_run_project` now starts **without** `-d` by default, so `godot_command eval` compiles user code without entering the interactive `debug>` prompt; a syntax error still reports its message and file:line in the captured output. `debug:true` is now explicitly **diagnostic mode**: the instance runs with the local debugger, the interaction server detects diagnostic mode from the `GODOT_BRIDGE_DEBUGGER=1` environment variable the bridge sets (an argv check alone cannot work: Godot consumes `-d` before `OS.get_cmdline_args()`, measured on 4.7.2) and **refuses eval** (no `reload()`) with a `next` step, and the bridge keeps a stdin pipe so that a detected `debug>`/`Debugger Break` writes exactly one `quit` (never `continue`), waits 3 s and then terminates the instance it started. The outcome is classified **by exit code, not by speed**: exit 0 → `diagnosis: "debugger-quit"`; any non-zero code → `diagnosis: "debugger-trap"` with `exitCode` and `crash: true`; still running after 3 s → `debugger-trap` with `killed: true`; all three carry a `debuggerTrace` (break reason, `*Frame N` frames with `file:line`, ≤4 KB tail). This is deliberately honest: on Godot 4.7.2-stable win64, writing `quit` exits in ~38 ms with **3221225477 (0xC0000005, ACCESS_VIOLATION)** and a C++ backtrace, so that run is a crash trap rather than a graceful exit. Measured baseline (minimal project + syntax-error script): no `-d` exits in ~372 ms with `SCRIPT ERROR … at: GDScript::reload`; `-d` with stdin at EOF prints **12089** break/prompt lines in 3 s (1.78 MB, ~590 KB/s) and must be killed (the issue #13 loop); `-d` with a stdin pipe prints one break/prompt (2.4 KB) because the debugger waits for input. `godot_command eval` timeouts now answer `{ error: "bridge timeout", diagnosis: "unresponsive", next }`, `godot_ping` reports `responsive: false` when the port accepts a connection but never answers instead of `game_running: false`, and an oversized `user://logs/godot.log` gets a warning (never deleted). Regression tests: `scripts/test/eval-guard.test.mjs` (self-contained, `node --test`) and `scripts/test/eval_guard.gd` (`godot_run_headless --script`).

- **The diagnostic-mode eval guard now actually fires (issue #13 follow-up).** The first cut sniffed `OS.get_cmdline_args()` for `-d`; Godot consumes engine flags, so on a real spawn that check was dead code and `eval` still reached `reload()` and fell into `debug>` (end-to-end run on 4.7.2: `Debugger Break, Reason: 'Parser Error…'`, then a `bridge timeout`). The bridge now passes `GODOT_BRIDGE_DEBUGGER=1` in the spawn environment, the server reads it (`is_local_debugger(args, debugger_flag)`), and a trap that still slips through is reported as `diagnosis: "debugger-trap"` with `debuggerTrace` instead of a bare timeout. Tests cover the env channel on both sides. Out-of-band commits: `745c7b0` (this guard correction) and `21459a5` (the release commit), both merged into the target via `90a5427` and declared as emergency exceptions in `scripts/check-target-history.mjs` (cards T-74/T-76).
## [0.2.0] - 2026-10-01

### Added

- **`Godot engine path` is now editable in the GUI.** The bundle ships a browser half (`client/client.js`, declared through `dsh.client` in the manifest) that registers this bundle's configuration section — the keyed slot `plugins.bundle.config`, keyed by the package name — so the `godot-bridge` card on the Plugins page shows the path field between its description and its row list, with a **Save** and a **Reset to default** for a path this profile overrides. (The per-row slot `plugins.row.config`, keyed `<package name>#<row id>`, would put the same form one level deeper behind a Configure control on the row; it becomes the right slot once a bundle has several independently configurable rows, which this one does not.) A save travels the same road as the rest of DSH's settings and lands on the same `cordis.patch.yml` row `godot_set_engine_path` writes, so the field, the tool, and a hand-written `config:` block are three views of one value — and a change applies without a restart. Switching that row off withdraws the section with it, because the browser half belongs to that row. This closes the 0.1.8 known limitation below.
- `npm run check` now verifies the browser half as well, so the class of mistake that leaves a bundle without its form fails the build instead of failing silently: the `dsh.client` declaration (its allowed members, `platform: 'web'`, string-array `inject`/`external`, boolean `immediately`), an `exports["./client"]` target that exists and is shipped by `files`, a `window.__ModuleLoader__.load({ id })` registration whose id is the package name, the `slots` service declaration, every `require()` specifier against the web client's platform seed modules plus `dsh.client.external`, a `plugins.bundle.config` key against this bundle's package name, and a `plugins.row.config` key against the rows the patch declares. Slot keys and module requests are read from code, so a comment cannot satisfy a check.

### Changed

- The browser half is inert where DSH cannot host it: 0.1.6–0.1.x already declares these slots but has no settings-form service to read the value through, so the registration sits behind `ctx.inject(['configForms'], …)` and those runtimes keep exactly the previous behaviour (no GUI field, `godot_set_engine_path` and `settings.yaml` as before). A runtime that never scans `dsh.client` (anything older than 0.1.0-rc.7) ignores the new manifest member.

## [0.1.8] - 2026-09-30

### Fixed

- The plugin could not load at all on DSH 0.2.x when installed as a `link:` dependency: the launcher's runtime resolution routes `@deepseek-ai/*` to the installation only for names a linked package declares in its own `peerDependencies` (it reads `peerDependencies` keys, not `dependencies`), and godot-bridge declared none — so `import '@deepseek-ai/dsh-tools'` failed with `ERR_MODULE_NOT_FOUND` and none of the seventeen `godot_*` tools registered. The manifest now declares `@deepseek-ai/dsh-tools` and `@deepseek-ai/schemastery`.
- `godotPath` no longer disappears on DSH 0.2.x: `@deepseek-ai/dsh-settings` dropped `register`, so the settings section silently degraded to a warning and `godot_set_engine_path` always answered that the settings service was unavailable.
- An engine path configured before the 0.1.x → 0.2.x upgrade is carried over automatically instead of silently falling back to `godot` on PATH (typically a version-manager shim, i.e. a different build than the one configured). See the migration note under **Changed**.

### Changed

- Configuration model: `godotPath` is a `.volatile()` field of the plugin's Config, so it appears on the plugin settings page and is read live (volatile fields are updated in place, without remounting the plugin). Writes persist through `ctx.configEditor.edit(...)` into the active profile's `cordis.patch.yml` and hot-recompose — no restart.
- `godot_set_engine_path` now checks that the target exists before writing and reports where it persisted: `persisted: 'profile-patch'` on DSH 0.2.x, `'settings'` on the legacy path.
- Legacy runtimes stay supported: on 0.1.6–0.1.x, where `settings.register` still exists, the plugin keeps using it (the `@deepseek-ai/dsh-tools` peer range is `>=0.1.6-0`). `peerDependenciesMeta.optional` keeps pnpm from installing harness packages from the registry.
- `settings.yaml` migration: DSH 0.2 imports leftover sections by plugin entry id, and this plugin's row id is `tool-godot-bridge`, so a `godot-bridge:` section written on 0.1.x is not carried over. When this runtime has no configured path, the plugin now reads that section and writes the recorded value back through the same profile-patch path as `godot_set_engine_path`, so the engine build configured before the upgrade is used again without re-entering it. An already-configured value is never overwritten, and a recorded path that no longer exists on disk is ignored (that case keeps the PATH fallback and its warning). The restore runs once per plugin load and is best-effort: a rejected write leaves the PATH fallback in place and logs a warning, and never disables a tool.

### Added

- `npm run check` — `scripts/check-plugin-contract.mjs`, a dependency-free static contract check: every bare `@deepseek-ai/*` import must be declared in `peerDependencies`/`dependencies`, `dsh.bundle.patch` must exist and reference the package, `main`/`exports` targets must exist and be covered by `files`, and the entry point must export `name`/`apply` without an `export default`.
- `scripts/diagnose-dsh-resolution.mjs` — a re-runnable diagnostic for the launcher's runtime resolution (bundle layers, skipped bundles, linked roots, per-import result, `--expect ok|fail`); development-only and never published.

### Documentation

- README: new "DSH 0.2+ compatibility and troubleshooting" section (resolution rules, the `link:` peer requirement, a symptom table, the `dsh plugin allow-version` fallback, verification commands) plus corrected config-location wording.
- install: a `link:` local-development section, a rewritten Config section (volatile field, profile-patch write path, legacy fallback, `settings.yaml` migration note), and maintenance steps for the check and diagnostic scripts.
- ARCHITECTURE: new "Dependency contract and runtime resolution" section with its layer diagram.

### Known limitation

- `godotPath` has **no GUI form field** on DSH 0.2. The Plugins page renders a row's configuration form only when that plugin ships a client component registering the keyed slot `plugins.row.config`; no built-in package registers it, and godot-bridge ships no client entry. The Host side is unaffected — `settings.describe()` still projects the field for the `tool-godot-bridge` row, and `godot_set_engine_path` (or a `config:` block on that row) sets it. Tracked as a separate feature request.

## [0.1.7] - 2026-09-07

### Fixed

- Stale autoload was silently defeating port routing: a project whose `autoload/mcp_interaction_server.gd` predated `GODOT_BRIDGE_PORT`/`get_instance_info` kept binding 9090 no matter what port `godot_run_project` requested — so a `port=9092` run reported success but every later `godot_command`/`godot_screenshot` could only find 9090 (issues #4). `ensureInteractionAutoload` now overwrites an out-of-date autoload with the vendored version (the file is plugin-managed infrastructure) and reports `upgraded` when it had to.
- `godot_ping` and error messages report the real probed port instead of a hardcoded `127.0.0.1:9090`.
- `writeProjectFile` scopes its fs policy to the target project directory instead of the session workspace, so autoload/project-file writes are legal for projects outside the workspace.
- Added a `sanitizeLossless` guard at every tool return so a stray `undefined`/`NaN` value degrades to a logged, fixed value instead of a silent `value is not lossless JSON` failure.

## [0.1.6] - 2026-09-01

### Added

- Instance ownership for `godot_run_project`: it probes the port first and ADOPTS an already-running instance of the same project (returns `external: true`) instead of spawning a duplicate that fails to bind — the exact scenario where a user starts a scene in the editor and the LLM then runs the project, which previously produced a silent mis-attach and an orphaned second process.
- A different project on the port triggers an automatic fallback to 9091+ (or the caller's `port` argument) instead of colliding.
- `mcp_interaction_server.gd` now reads `GODOT_BRIDGE_PORT` / `GODOT_BRIDGE_TOKEN` and exposes `get_instance_info` (pid/port/token/project) — the identity basis for ownership detection.
- `godot_stop_project` refuses to terminate adopted (user/editor-launched) instances and explains how to stop safely (F8 in the editor / in-game quit); the plugin never kills processes it did not start. New `godot-bridge:instance-ownership` system-prompt section with the same rule, also forbidding pwsh process-kill workarounds that would take the whole editor down.

### Fixed

- Compatibility with dsh-settings ≥ 0.1.2-alpha: the removed `settingsNamespace` export is gone from the plugin (the plain namespace string is passed to `ctx.settings.register`); settings and tool registration are wrapped defensively so future API drift degrades with a warning instead of failing the host boot.

## [0.1.5] - 2026-08-19

### Added

- `godot_run_headless` tool: bounded headless scene/logic/test runs through the unconfined subprocess service (`godot --headless --path <project> [--quit-after N] [--script <g>]` with a timeout kill), replacing the crash-prone practice of running `godot --headless` through a sandboxed pwsh/bash shell.

### Changed

- `godot_headless_op` / `godot_validate_script` / `godot_export_project` now attach a crash `diagnosis` (`sandbox-crash`, high/low confidence, actionable hint) instead of handing back raw stderr alone, so a sandbox crash can no longer masquerade as a project bug.
- New `godot-bridge:launch-channel` system-prompt section: Godot must always be started through the godot_* tools (unconfined subprocess), never through pwsh/bash (file-sandboxed, signal 11).
- `godot_run_project` description points at `godot_run_headless` for non-interactive headless runs.

### Fixed

- `godot_run_headless` returned `note: undefined` on the normal path; the DSH tool layer rejects any `undefined` property ("value is not lossless JSON") and discarded the entire result. `note` is now only present on timeout, and `exit_code` is normalized so every return field is lossless JSON.
- `godot_validate_script` error entries now use `null` (not `undefined`) for missing file/line locations.

## [0.1.4] - 2026-08-16

### Fixed

- Restore the `timer` injection dropped in 0.1.3: `ctx.timeout()` is a mixin of the timer service whose getter reads `ctx.timer`, so its removal broke `godot_run_project` / `godot_command` / `godot_screenshot` with `cannot get property "timer" without inject`.

## [0.1.3] - 2026-08-15

### Added

- `godot_set_engine_path` tool: the model asks the user for their Godot executable and persists it into settings (schema- and existence-validated, hot-reloaded — no restart), closing the "no engine configured" guidance loop.

### Changed

- `godotPath` is now a user-facing settings value (the Web plugin-config page or the `godot-bridge:` section of `settings.yaml`), not a `cordis.patch.yml` row config; the plugin author no longer presets a path (Godot is a portable exe that can live anywhere).
- Godot executable resolution order: per-tool `godot_path` argument → the `godotPath` setting → the `godot` command on PATH. Nothing to configure when `godot` is on PATH.
- Existence validation moved from an `apply`-time `throw` (which failed the whole fiber) to the settings `validate` hook, so a bad path can no longer disable the pure-file tools.

### Fixed

- Tool descriptions no longer mislabel the config location as `$DSH_HOME/settings.yaml`; they now point at the settings section the code actually reads.

### Removed

- Redundant `timer` injection and `console.log` noise (now `ctx.logger`).

## [0.1.2] - 2026-08-15

### Fixed

- The update notice now reliably reaches the model: `systemPrompt` is injected (was a lazy `ctx.get` that could miss the service) and the notice text is an explicit instruction to inform the user, so the model surfaces "update available: installed X, latest Y" in every session.
- `godot_ping` reports `plugin_version` / `latest_version` / `update_available` for on-demand checks.

## [0.1.1] - 2026-08-15

### Added

- Boot-time update notice: a best-effort version check against the repo's `main`-branch `package.json` (`raw.githubusercontent.com`, 5 s timeout, silent on failure/offline). When a newer release exists it registers a system-prompt section; the `repository` field in `package.json` redirects the check for forks.

### Fixed

- `godot_command`'s `timeout_ms` was a no-op: the one-shot node bridge hard-capped at 20 s. The timeout is now threaded through as `argv[3]` (fallback 20 s), so `godot_ping`, `godot_run_project`'s readiness poll, and async commands honor their timeouts.

### Changed

- Dropped stale headless-script fallback candidates (`<project>/tools/godot-bridge/`, `../godot-mcp/src/scripts/`) from the pre-bundle deployment; the module-relative copy is the only source.

## [0.1.0] - 2026-08-15

Initial release — a standard DSH bundle that replaces the godot-mcp MCP server with native agent tools.

### Added

- Fifteen `godot_*` tools:
  - process: `godot_run_project` / `godot_stop_project` / `godot_get_debug_output` / `godot_ping`
  - runtime control: `godot_command` (every interaction-server command), `godot_screenshot`
  - headless: `godot_headless_op` (16 ops) / `godot_validate_script`
  - project editing: `godot_set_project_setting` / `godot_manage_autoloads` / `godot_manage_input_map` / `godot_manage_export_presets` / `godot_create_script` / `godot_create_project` / `godot_export_project`
- Standard DSH bundle form: `defineTool` from `@deepseek-ai/dsh-tools` + `ctx.tools.register`; `dsh.bundle` manifest installs with `dsh plugin --profile web add github:Smalldy/godot-bridge`.
- Vendored game-side assets: `mcp_interaction_server.gd` (in-game TCP autoload), `godot_operations.gd`, `validate_script.gd`.
- Correct Godot 4 keycodes in `godot_manage_input_map` (fixes godot-mcp's Godot 3 baseline bug).
- Bilingual documentation (README / install / ARCHITECTURE / COVERAGE) incl. install and uninstall guides; `cordis.patch.yml` included in published `files`.

[0.3.0]: https://github.com/Smalldy/godot-bridge/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/Smalldy/godot-bridge/compare/v0.1.8...v0.2.0
[0.1.8]: https://github.com/Smalldy/godot-bridge/compare/v0.1.7...v0.1.8
[0.1.7]: https://github.com/Smalldy/godot-bridge/compare/v0.1.6...v0.1.7
[0.1.6]: https://github.com/Smalldy/godot-bridge/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/Smalldy/godot-bridge/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/Smalldy/godot-bridge/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/Smalldy/godot-bridge/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/Smalldy/godot-bridge/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/Smalldy/godot-bridge/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Smalldy/godot-bridge/releases/tag/v0.1.0
[0.2.1]: https://github.com/Smalldy/godot-bridge/compare/v0.2.0...v0.2.1
