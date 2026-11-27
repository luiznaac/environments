// Standalone unit tests for the sweep's pure planner: porcelain parsing, labels,
// path containment, the keep-rule order and the preserve instructions a removal
// carries. This file is vendored byte-for-byte beside the module into every
// family repo, so it imports only Node builtins and the sweep module — never
// another checkout's file. The CLI's wiring (porcelain read, origin/<default>
// comparison, real commits, removals and branch deletion/retention) and the
// inlined-helper cross-checks are canonical-only in
// worktree-sweep.e2e.test.mjs.
//
// The sweep never touches origin: a removal preserves work by committing it
// locally and by RETAINING an unlanded branch. Only a branch whose work already
// landed (an ancestor of origin/<default>) is deleted.
//
// Vendored copy marker: salgadinhos worktree-sweep planner test.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, sep } from "node:path";
import { isProtectedBranch, parseWorktrees, planSweep, worktreeLabel, isInside } from "./worktree-sweep.mjs";

const SHA = (char) => char.repeat(40);

const PORCELAIN = [
  "worktree C:/repo",
  "HEAD " + SHA("1"),
  "branch refs/heads/master",
  "",
  "worktree C:/wts/merged",
  "HEAD " + SHA("2"),
  "branch refs/heads/chore/merged",
  "",
  "worktree C:/wts/detached",
  "HEAD " + SHA("3"),
  "detached",
  "",
  "worktree C:/wts/locked",
  "HEAD " + SHA("4"),
  "branch refs/heads/chore/locked",
  "locked",
  "",
].join("\n");

test("parseWorktrees reads path, sha, branch, detached and locked", () => {
  const entries = parseWorktrees(PORCELAIN);
  assert.equal(entries.length, 4);
  assert.deepEqual(entries[0], { path: "C:/repo", sha: SHA("1"), branch: "refs/heads/master", detached: false, locked: false });
  assert.deepEqual(entries[2], { path: "C:/wts/detached", sha: SHA("3"), branch: null, detached: true, locked: false });
  assert.equal(entries[3].locked, true);
});

test("worktreeLabel prefers the branch, then the detached sha, then the basename", () => {
  assert.equal(worktreeLabel({ branch: "refs/heads/chore/x", detached: false, sha: SHA("a"), path: "C:/wts/x" }), "chore/x");
  assert.equal(worktreeLabel({ branch: null, detached: true, sha: "abcdef1234", path: "C:/wts/x" }), "detached@abcdef1");
  assert.equal(worktreeLabel({ branch: null, detached: false, sha: null, path: "C:/wts/x" }), "x");
});

test("isInside is path containment, not a string prefix", () => {
  assert.equal(isInside("/wts", "/wts"), true);
  assert.equal(isInside("/wts" + sep + "a", "/wts"), true);
  assert.equal(isInside("/wts-old", "/wts"), false);
  assert.equal(isInside("/wts", "/wts" + sep + "a"), false);
});

test("isProtectedBranch keeps master/main and prototype branches out of deletion", () => {
  for (const name of ["master", "main", "prototype/config-shape", "prototype/launcher-ux"]) assert.equal(isProtectedBranch(name), true, name);
  for (const name of ["chore/x", "salgadinhos-implement-the-work-525409a", "docs/placement"]) assert.equal(isProtectedBranch(name), false, name);
});

const entry = (path, overrides = {}) => ({
  path,
  sha: SHA("f"),
  branch: "refs/heads/" + basename(path),
  detached: false,
  locked: false,
  ...overrides,
});

const base = { cwd: "/repo", root: "/wts", base: "origin/master", isClean: () => true, isAncestor: () => true, isOld: () => true };

test("planSweep removes a clean tree merged into the base, with nothing to preserve", () => {
  const plan = planSweep([entry("/wts/gone")], base);
  assert.deepEqual(plan, [
    {
      path: "/wts/gone",
      label: "gone",
      action: "remove",
      reason: null,
      preserve: { commit: false },
      branch: "gone",
      deletable: true,
      retain: false,
    },
  ]);
});

test("planSweep keeps the tree the sweep runs from, nested paths included", () => {
  assert.deepEqual(
    planSweep([entry("/repo")], { ...base, cwd: "/repo" }).map((item) => [item.action, item.reason]),
    [["keep", "current"]],
  );
  assert.deepEqual(
    planSweep([entry("/wts/here")], { ...base, cwd: "/wts/here/some/deeper" }).map((item) => [item.action, item.reason]),
    [["keep", "current"]],
  );
});

test("planSweep keeps worktrees outside the sweep's root", () => {
  const plan = planSweep([entry("/elsewhere/tree")], base);
  assert.deepEqual(plan.map((item) => [item.action, item.reason]), [["keep", "outside"]]);
});

test("planSweep keeps locked trees even when clean and merged", () => {
  const [item] = planSweep([entry("/wts/locked", { locked: true })], base);
  assert.deepEqual([item.action, item.reason], ["keep", "locked"]);
});

test("planSweep keeps unreadable trees", () => {
  const [item] = planSweep([entry("/wts/missing")], { ...base, isClean: () => null });
  assert.deepEqual([item.action, item.reason], ["keep", "missing"]);
});

test("planSweep keeps fresh trees until they age past the cutoff", () => {
  const plan = planSweep([entry("/wts/fresh")], { ...base, isOld: () => false });
  assert.deepEqual(plan.map((item) => [item.action, item.reason]), [["keep", "fresh"]]);
});

test("planSweep keeps a fresh dirty tree fresh, not a removal candidate", () => {
  const [item] = planSweep([entry("/wts/fresh-dirty")], { ...base, isClean: () => false, isOld: () => false });
  assert.deepEqual([item.action, item.reason], ["keep", "fresh"]);
});

test("planSweep commits WIP and RETAINS the branch for a dirty tree, even when its HEAD landed", () => {
  // The snapshot adds a commit, so the branch is unlanded by definition and must
  // not be deleted.
  const [item] = planSweep([entry("/wts/dirty")], { ...base, isClean: () => false });
  assert.deepEqual(item, {
    path: "/wts/dirty",
    label: "dirty",
    action: "remove",
    reason: null,
    preserve: { commit: true },
    branch: "dirty",
    deletable: false,
    retain: true,
  });
});

test("planSweep removes an unmerged old tree but RETAINS its branch (never deleted)", () => {
  const [item] = planSweep([entry("/wts/unmerged")], { ...base, isAncestor: () => false });
  assert.equal(item.action, "remove");
  assert.deepEqual(item.preserve, { commit: false });
  assert.equal(item.deletable, false);
  assert.equal(item.retain, true);
});

test("planSweep commits WIP and retains the branch for a dirty unmerged tree", () => {
  const [item] = planSweep([entry("/wts/both")], { ...base, isClean: () => false, isAncestor: () => false });
  assert.equal(item.action, "remove");
  assert.deepEqual(item.preserve, { commit: true });
  assert.equal(item.deletable, false);
  assert.equal(item.retain, true);
});

test("planSweep keeps a dirty or unmerged detached tree — no branch to preserve the work on", () => {
  const dirty = planSweep([entry("/wts/wip", { branch: null, detached: true })], { ...base, isClean: () => false });
  assert.deepEqual(dirty.map((item) => [item.action, item.reason]), [["keep", "detached"]]);
  const unmerged = planSweep([entry("/wts/wip", { branch: null, detached: true })], { ...base, isAncestor: () => false });
  assert.deepEqual(unmerged.map((item) => [item.action, item.reason]), [["keep", "detached"]]);
});

test("planSweep removes a clean landed detached tree, with no branch to delete", () => {
  const [item] = planSweep([entry("/wts/detached", { branch: null, detached: true })], base);
  assert.deepEqual([item.action, item.branch, item.deletable, item.retain], ["remove", null, false, false]);
});

test("planSweep never marks a prototype branch deletable or retained", () => {
  const [item] = planSweep([entry("/wts/prototype", { branch: "refs/heads/prototype/config-shape" })], base);
  assert.equal(item.action, "remove");
  assert.equal(item.branch, "prototype/config-shape");
  assert.equal(item.deletable, false);
  assert.equal(item.retain, false);
});

test("planSweep keeps any tree on master/main with reason on-default (tripwire)", () => {
  for (const name of ["master", "main"]) {
    const [item] = planSweep([entry("/wts/default-branch", { branch: "refs/heads/" + name })], base);
    assert.equal(item.action, "keep", name);
    assert.equal(item.reason, "on-default", name);
  }
});

test("planSweep tripwire applies even to a dirty old tree on master/main", () => {
  const [item] = planSweep([entry("/wts/default-dirty", { branch: "refs/heads/master" })], { ...base, isClean: () => false });
  assert.equal(item.action, "keep");
  assert.equal(item.reason, "on-default");
});

test("planSweep tripwire does not keep non-protected branches (existing behavior unchanged)", () => {
  const [item] = planSweep([entry("/wts/chore", { branch: "refs/heads/chore/x" })], base);
  assert.equal(item.action, "remove");
  assert.equal(item.branch, "chore/x");
});

test("planSweep tripwire does not apply to detached trees (they were never on the branch)", () => {
  const [item] = planSweep([entry("/wts/detached-default", { branch: null, detached: true })], base);
  assert.equal(item.action, "remove");
  assert.equal(item.reason, null);
});

test("importing the module does not run the CLI", () => {
  const moduleUrl = new URL("./worktree-sweep.mjs", import.meta.url).href;
  // Run from a non-repository directory: a CLI that ran on import would fail
  // `git worktree list` there, so exit 0 with no output proves the guard.
  const result = spawnSync(process.execPath, ["-e", `import(${JSON.stringify(moduleUrl)})`], {
    cwd: tmpdir(),
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, FORCE_COLOR: "0" },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "", "the CLI printed nothing on import");
  assert.equal(result.stderr, "", "the CLI wrote nothing to stderr on import");
});
