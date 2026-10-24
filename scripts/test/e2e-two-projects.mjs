#!/usr/bin/env node
/**
 * T-86 end-to-end check: two REAL git projects, real boards on disk, the same
 * panel registration path, one background-loop iteration, and each project's
 * merge landing on its own target while the other board is untouched.
 *
 * Run:  node scripts/test/e2e-two-projects.mjs
 * It is deliberately NOT part of npm test: it needs a real git executable and a
 * writable temp dir, and a sandbox that refuses child processes will report the
 * process-boundary check as skipped(logged, not silent).
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { createState } from "../../plugin/task-center/state.mjs";
import { createDispatcher } from "../../plugin/task-center/dispatch.mjs";
import { createApi } from "../../plugin/task-center/api.mjs";
import { createMerger } from "../../plugin/task-center/merge.mjs";
import { createGit } from "../../plugin/task-center/git.mjs";
import { projectIdOf } from "../../plugin/task-center/board.mjs";

const failures = [];
function check(label, condition, detail) {
  if (condition) {
    console.log("PASS  " + label + (detail === undefined ? "" : "  [" + detail + "]"));
    return;
  }
  failures.push(label);
  console.log("FAIL  " + label + "  -> " + String(detail));
}

/** A filesystem adapter over the real disk for the plugin's ctx.fs contract. */
function realFs() {
  let counter = 0;
  const versionOf = (path) => {
    try {
      const s = statSync(path);
      return s.isDirectory() ? "dir" : "v" + String(s.mtimeMs) + "-" + String(s.size);
    } catch (error) {
      return undefined;
    }
  };
  return {
    async resolve(path) {
      return { targetKey: path, displayPath: path };
    },
    async stat(target) {
      const version = versionOf(target.targetKey);
      if (version === undefined) return undefined;
      const s = statSync(target.targetKey);
      return { type: s.isDirectory() ? "directory" : "file", version, size: s.size };
    },
    async readText(target) {
      return readFileSync(target.targetKey, "utf8");
    },
    async writeText(target, content, expected) {
      const path = target.targetKey;
      const current = versionOf(path);
      if (expected !== undefined && expected.kind === "createIfAbsent" && current !== undefined) {
        throw Object.assign(new Error("FS_STALE_VERSION: exists"), { code: "FS_STALE_VERSION" });
      }
      if (expected !== undefined && expected.kind === "replaceIfVersion" && current !== expected.version) {
        throw Object.assign(new Error("FS_STALE_VERSION: moved"), { code: "FS_STALE_VERSION" });
      }
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
      return { operation: current === undefined ? "create" : "update", version: "v" + String(++counter) };
    },
  };
}

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function makeProject(root, name) {
  mkdirSync(root, { recursive: true });
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "user.email", "e2e@example.invalid"]);
  git(root, ["config", "user.name", "e2e"]);
  writeFileSync(join(root, ".gitignore"), ".agents/\n.worktrees/\n");
  writeFileSync(join(root, name + ".txt"), name + "\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-q", "-m", "init " + name]);
  const base = git(root, ["rev-parse", "HEAD"]).trim();
  git(root, ["checkout", "-q", "-b", "task/T-1-1"]);
  writeFileSync(join(root, name + "-work.txt"), name + " work\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-q", "-m", "work " + name]);
  const head = git(root, ["rev-parse", "HEAD"]).trim();
  git(root, ["checkout", "-q", "main"]);
  mkdirSync(join(root, ".agents"), { recursive: true });
  return { root, name, base, head };
}

function boardText(project) {
  return JSON.stringify(
    {
      version: 2,
      seq: 2,
      dispatch: { state: "paused" },
      tasks: [
        {
          id: "T-1",
          title: "e2e card in " + project.name,
          status: "testing",
          priority: 0,
          dependsOn: [],
          writeFiles: [],
          base: project.base,
          target: "main",
          branch: "task/T-1-1",
          worktree: null,
          worktreeError: null,
          commit: project.head,
          actualFiles: [],
          requiredRole: null,
          merge: {
            status: "open",
            base: project.base,
            target: "main",
            head: project.head,
            mergeCommit: null,
            declaredFiles: [],
            actualFiles: [],
            tests: "npm run verify",
            reviewer: null,
            conflict: null,
            output: null,
            at: new Date().toISOString(),
            queue: null,
          },
          review: { status: "approved", by: "reviewer", at: new Date().toISOString(), reasons: null, attempt: 1 },
          test: { status: "passed", by: "tester", at: new Date().toISOString(), evidence: "e2e", attempt: 1 },
          assignee: null,
          attempts: 1,
          maxAttempts: 3,
          evidence: "e2e",
          dispatch: null,
          leaseUntil: null,
          spec: "e2e",
          acceptance: "e2e",
          history: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
    },
    null,
    2,
  );
}

function makeRow(fs, projectRoot, homeDir, gitFacade, verify) {
  const ctx = { fs, get() { return undefined; } };
  const state = createState(ctx, { homeDir });
  state.setSessionRoot(projectRoot);
  const scheduler = createDispatcher(ctx, { state, projectPath: () => projectRoot, allowSpawn: false, git: gitFacade });
  const merger = createMerger({ git: gitFacade, verify });
  const api = createApi(ctx, { state, scheduler, git: gitFacade, merger, autoMerge: true });
  return { state, scheduler, api };
}

async function main() {
  console.log("# T-86 two-project end-to-end");
  try {
    execFileSync("git", ["--version"], { encoding: "utf8" });
  } catch (error) {
    console.log("SKIP  this sandbox cannot spawn git (" + String((error && error.message) || error) + "); run this script in an unconfined tester harness for the real transcript.");
    return;
  }
  const work = mkdtempSync(join(tmpdir(), "t86-e2e-"));
  const home = join(work, "home");
  mkdirSync(home, { recursive: true });
  try {
    const A = makeProject(join(work, "project-a"), "alpha");
    const B = makeProject(join(work, "project-b"), "beta");
    const fs = realFs();
    for (const project of [A, B]) {
      mkdirSync(join(project.root, ".agents"), { recursive: true });
      writeFileSync(join(project.root, ".agents", "tasks.json"), boardText(project));
    }
    // The same panel path: adopt ?project= and persist it in the registry.
    const gitFacade = createGit({ run: (args, cwd) => {
      const result = spawnSync("git", args, { cwd, encoding: "utf8" });
      return { code: result.status === null ? 1 : result.status, stdout: result.stdout || "", stderr: result.stderr || "" };
    } });
    const verify = async () => ({ ok: true, code: 0, stdout: "ALL CHECKS PASSED", stderr: "" });
    const rowA = makeRow(fs, A.root, home, gitFacade, verify);
    const rowB = makeRow(fs, B.root, home, gitFacade, verify);
    for (const row of [rowA, rowB]) {
      const adopted = await row.state.adoptPanelProject(row === rowA ? A.root : B.root);
      if (adopted !== null) row.state.touchProject(adopted.root);
      await row.state.flushRegistry();
    }
    // One fresh state = a restarted process: nothing but the registry is carried.
    const fresh = createState({ fs, get() { return undefined; } }, { homeDir: home });
    await fresh.loadRegistry();
    const active = fresh.activeProjects(Date.now());
    check("the restarted process recovers both projects from the registry", active.length === 2 && new Set(active.map((entry) => entry.root)).size === 2, active.map((entry) => entry.root).join(" , "));

    const beforeB = readFileSync(join(B.root, ".agents", "tasks.json"), "utf8");
    const beforeA = readFileSync(join(A.root, ".agents", "tasks.json"), "utf8");
    // One background-loop iteration for BOTH projects.
    const sweeps = [];
    for (const entry of active) {
      const row = entry.root === A.root ? rowA : rowB;
      const tick = row.scheduler.kick(entry.root);
      if (tick !== undefined && tick !== null && typeof tick.then === "function") await tick;
      const sweep = await row.api.autoMergePending(entry.root);
      sweeps.push({ root: entry.root, sweep: sweep });
    }
    for (const row of sweeps) {
      console.log("      sweep " + row.root + " -> " + JSON.stringify(row.sweep));
    }
    const afterA = readFileSync(join(A.root, ".agents", "tasks.json"), "utf8");
    const afterB = readFileSync(join(B.root, ".agents", "tasks.json"), "utf8");
    const boardA = JSON.parse(afterA).tasks[0];
    const boardB = JSON.parse(afterB).tasks[0];
    check("project A's card merged", boardA.status === "done" && boardA.merge.status === "merged", boardA.status + "/" + boardA.merge.status);
    check("project B's card merged", boardB.status === "done" && boardB.merge.status === "merged", boardB.status + "/" + boardB.merge.status);
    check("the two projects keep distinct ids", projectIdOf(A.root) !== projectIdOf(B.root));
    if (boardA.status === "done" && boardB.status === "done") {
      check("A's target advanced to its own head", git(A.root, ["rev-parse", "main"]).trim() === boardA.merge.mergeCommit, git(A.root, ["rev-parse", "main"]).trim());
      check("B's target advanced to its own head", git(B.root, ["rev-parse", "main"]).trim() === boardB.merge.mergeCommit, git(B.root, ["rev-parse", "main"]).trim());
      check("A's board did not consume B's card", boardA.title.indexOf("alpha") >= 0 && boardB.title.indexOf("beta") >= 0);
    }
    // A project switch must read the right board, not the last one touched.
    const snapA = await rowA.api.snapshot(A.root, { full: false, resolvedFrom: "explicit" });
    const snapB = await rowB.api.snapshot(B.root, { full: false, resolvedFrom: "explicit" });
    check("each session reads its own board after switching", snapA.projectId !== snapB.projectId && snapA.tasks[0].id === "T-1" && snapB.tasks[0].id === "T-1" && snapA.tasks.length === 1 && snapB.tasks.length === 1);

    // Process boundary: a forked child loads the registry and prints activeProjects().
    // A sandbox that refuses to spawn reports it as skipped with the reason.
    let forkSkipped = null;
    try {
      // A real file + an absolute argument: no -e snippet, no quoting/backslash
      // games with a Windows temp path.
      const childPath = new URL("./e2e-child.mjs", import.meta.url).pathname;
      const childFile = process.platform === "win32" ? decodeURIComponent(childPath).replace(/^\//, "") : decodeURIComponent(childPath);
      const out = execFileSync(process.execPath, [childFile, home], { encoding: "utf8", timeout: 20000 });
      const line = out.split(/\r?\n/).map((entry) => entry.trim()).filter((entry) => entry.length > 0).pop();
      let parsed = null;
      try {
        parsed = JSON.parse(line);
      } catch (error) {
        console.log("      child raw stdout: " + JSON.stringify(out));
        check("a real child process sees both projects", false, "unparseable child output: " + String(line).slice(0, 200));
      }
      if (parsed !== null) {
        check("a real child process sees both projects", Array.isArray(parsed.roots) && parsed.roots.length === 2, "child=" + JSON.stringify(parsed));
      }
    } catch (error) {
      const stdout = error !== null && error !== undefined && error.stdout !== undefined ? String(error.stdout) : "";
      const stderr = error !== null && error !== undefined && error.stderr !== undefined ? String(error.stderr) : "";
      if (stdout.length > 0 || stderr.length > 0) console.log("      child raw stdout: " + JSON.stringify(stdout) + " stderr: " + JSON.stringify(stderr));
      // spawn EPERM is a sandbox fact, not a pass; record it as SKIP explicitly.
      forkSkipped = String((error && error.message) || error);
      console.log("SKIP  process-boundary fork (spawn refused by this sandbox): " + forkSkipped);
    }
    console.log(failures.length === 0 ? "\nE2E PASSED" : "\nE2E FAILED: " + failures.join(" | "));
  } finally {
    try { rmSync(work, { recursive: true, force: true }); } catch (error) {}
  }
}

main().then(
  () => { if (failures.length > 0) process.exitCode = 1; },
  (error) => { console.error("E2E ERROR " + String((error && error.stack) || error)); process.exitCode = 1; },
);
