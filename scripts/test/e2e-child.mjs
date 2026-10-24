#!/usr/bin/env node
/**
 * T-86 e2e child: a REAL separate process that must see the same project
 * registry the parent wrote. Args: <homeDir>. Prints one JSON line; exits
 * non-zero with an explicit error when the registry is missing/empty, so a
 * broken child is never mistaken for "no active projects".
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const home = process.argv[2];
if (typeof home !== "string" || home.length === 0) {
  console.log(JSON.stringify({ error: "missing-home-dir" }));
  process.exit(2);
}
const registryPath = join(home, ".dsh", "godot-bridge", "projects.json");
if (!existsSync(registryPath)) {
  console.log(JSON.stringify({ error: "registry-missing", registryPath }));
  process.exit(2);
}
const fs = {
  async resolve(path) {
    return { targetKey: path };
  },
  async stat(target) {
    try {
      const s = statSync(target.targetKey);
      return { type: s.isDirectory() ? "directory" : "file", version: "v" + String(s.mtimeMs) + "-" + String(s.size), size: s.size };
    } catch (error) {
      return undefined;
    }
  },
  async readText(target) {
    return readFileSync(target.targetKey, "utf8");
  },
  async writeText() {
    throw new Error("read-only child");
  },
};

const { createState } = await import("../../plugin/task-center/state.mjs");
const state = createState({ fs, get() { return undefined; } }, { homeDir: home });
await state.loadRegistry();
const projects = state.activeProjects(Date.now()).map((entry) => entry.root);
if (projects.length === 0) {
  console.log(JSON.stringify({ error: "empty-registry", registryPath }));
  process.exit(3);
}
console.log(JSON.stringify({ roots: projects }));
