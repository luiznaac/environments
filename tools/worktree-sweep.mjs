// Worktree sweep — one self-contained module, vendored byte-for-byte into every
// family repo. A copy is GENERATED: never edit it in place. Change the canonical
// source in salgadinhos (`tools/worktree-sweep.mjs`) and re-vendor every repo with
// the family installer. See salgadinhos `docs/adr/0019`.
//
// Vendored copy marker: salgadinhos worktree-sweep.
//
// It imports only Node builtins and inlines the helpers a copy would otherwise
// borrow from another checkout — the git repository-pin scrub, the colour helper
// and the session-branch predicate. The canonical-only e2e test cross-checks each
// inlined copy against its canonical home (`adapters/git-env.mjs`,
// `adapters/color.mjs`, `adapters/opencode/lib/worktree-names.mjs`), so the two
// cannot drift while the copy stays standalone.
//
// Every session gets a tree under ../.worktrees/ and is supposed to remove it
// once its PR merges. In practice they pile up, and `git worktree list` — the
// natural way a later session finds naming precedents — grows into a token sink.
// This sweep reclaims every old session tree, merged, unmerged or dirty, without
// ever losing work:
//
//   - a dirty tree gets a `git add -A` + `git commit --no-verify` WIP snapshot
//     on its branch;
//   - a branch whose HEAD is not an ancestor of origin/<default> (as of the
//     last fetch) is pushed to origin before anything is removed;
//   - only then is the tree removed and its local branch deleted — never a
//     `prototype/*` or `master`/`main` branch;
//   - a failed snapshot or push keeps the tree and the branch, reported.
//
// It also prunes local session branches (`<repo>-<slug>-<7hex>`, the guard's
// naming) that are fully merged and have no worktree, so the local refs of
// reclaimed sessions do not pile up; non-session branches are never touched.
// The keep rules: the sweep's own directory, trees outside ../.worktrees/,
// locked, unreadable and fresh (< --older-than hours) ones stay, and so does a
// detached tree whose work the sweep could not push.
//
// Dry run by default; --apply acts, then `git worktree prune` clears metadata
// for trees whose directories are already gone.
//
// Usage, from the main checkout of the repo to sweep:
//   node tools/worktree-sweep.mjs [--apply] [--older-than <hours>]

import { execFileSync } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Planner — pure logic, no git or fs calls. The CLI injects the git predicates
// and the tests inject fakes.
// ---------------------------------------------------------------------------

const PROTECTED_BRANCHES = new Set(["master", "main"]);

export function isProtectedBranch(label) {
  return label !== null && (PROTECTED_BRANCHES.has(label) || label.startsWith("prototype/"));
}

function field(lines, key) {
  const line = lines.find((l) => l === key || l.startsWith(key + " "));
  if (line === undefined) return null;
  return line === key ? "" : line.slice(key.length + 1);
}

// One entry per `git worktree list --porcelain` block; the first entry is the
// main checkout (the CLI slices it off).
export function parseWorktrees(porcelain) {
  const entries = [];
  for (const block of String(porcelain ?? "").split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/).filter((line) => line.trim() !== "");
    const path = field(lines, "worktree");
    if (!path) continue;
    entries.push({
      path,
      sha: field(lines, "HEAD"),
      branch: field(lines, "branch"),
      detached: lines.includes("detached"),
      locked: lines.some((line) => line === "locked" || line.startsWith("locked ")),
    });
  }
  return entries;
}

export function worktreeLabel(entry) {
  if (entry.branch) return entry.branch.replace("refs/heads/", "");
  if (entry.detached) return `detached@${(entry.sha ?? "").slice(0, 7)}`;
  return basename(entry.path ?? "");
}

export function isInside(child, parent) {
  const fold = (p) => resolve(p).toLowerCase();
  const [a, b] = process.platform === "win32" ? [fold(child), fold(parent)] : [resolve(child), resolve(parent)];
  return a === b || a.startsWith(b + sep);
}

export function planSweep(entries, { cwd, root, base, isClean, isAncestor, isOld }) {
  return entries.map((entry) => {
    const label = worktreeLabel(entry);
    const keep = (reason) => ({ path: entry.path, label, action: "keep", reason });
    const branch = entry.branch ? entry.branch.replace("refs/heads/", "") : null;

    // Tripwire: any tree on a protected default branch is kept and reported
    // (never removed, never snapshotted) — user story 10.
    if (branch === "master" || branch === "main") {
      return keep("on-default");
    }

    if (isInside(cwd, entry.path)) return keep("current");
    if (!isInside(entry.path, root)) return keep("outside");
    if (entry.locked) return keep("locked");
    const clean = isClean(entry.path);
    if (clean === null) return keep("missing");
    if (!isOld(entry.path)) return keep("fresh");

    const commit = !clean;
    const push = !entry.sha || !isAncestor(entry.sha, base);
    if (!branch && (commit || push)) return keep("detached");

    return {
      path: entry.path,
      label,
      action: "remove",
      reason: null,
      preserve: { commit, push },
      branch,
      deletable: branch !== null && !isProtectedBranch(branch),
    };
  });
}

// ---------------------------------------------------------------------------
// Inlined helpers — each mirrors a canonical module (see the header). Exported
// only so the canonical-only e2e test can cross-check the copy; a vendored copy
// never imports them.
// ---------------------------------------------------------------------------

export const GIT_REPO_PINS = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_NAMESPACE",
  "GIT_PREFIX",
  "GIT_CEILING_DIRECTORIES",
  "GIT_REFLOG_ACTION",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT",
];

export function gitEnvWithoutPins(env) {
  const clean = { ...env };
  for (const key of Object.keys(clean)) {
    if (GIT_REPO_PINS.indexOf(key) !== -1 || key.startsWith("GIT_CONFIG_KEY_") || key.startsWith("GIT_CONFIG_VALUE_")) {
      delete clean[key];
    }
  }
  return clean;
}

export function colorEnabled({ env = process.env, isTTY = Boolean(process.stdout?.isTTY) } = {}) {
  const force = env.FORCE_COLOR;
  if (force !== undefined && force !== "") return force !== "0";
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return false;
  if (env.TERM === "dumb") return false;
  return isTTY;
}

export function autoColors(stream = process.stdout, env = process.env) {
  const isTTY = typeof stream?.hasColors === "function" ? stream.hasColors() : Boolean(stream?.isTTY);
  return colors(colorEnabled({ env, isTTY }));
}

export function colors(enabled) {
  const wrap = (code) => (text) => (enabled ? `\u001b[${code}m${text}\u001b[0m` : String(text));
  return {
    red: wrap(31),
    green: wrap(32),
    yellow: wrap(33),
    bold: wrap(1),
    dim: wrap(2),
  };
}

function slugify(text, { maxWords = 3, maxLen = 24, minWordLen = 2 } = {}) {
  const stripped = String(text ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  const words = (stripped.match(/[a-zA-Z0-9]+/g) ?? [])
    .map((w) => w.toLowerCase())
    .filter((w) => w.length >= minWordLen)
    .slice(0, maxWords);
  let slug = words.join("-");
  if (slug.length > maxLen) slug = slug.slice(0, maxLen).replace(/-+$/, "");
  return slug;
}

function repoSlug(repo) {
  return slugify(repo, { maxWords: 8, maxLen: 64, minWordLen: 1 }) || "repo";
}

export function isSessionBranch(label, repo) {
  return new RegExp(`^${repoSlug(repo)}-[a-z0-9]+(?:-[a-z0-9]+)*-[0-9a-f]{7}$`).test(String(label ?? ""));
}

// Run the CLI only when the file is executed directly, never on import (the
// planner exports stay importable). A symlinked entry point resolves to its
// realpath in `import.meta.url` while `process.argv[1]` keeps the symlink, so
// both sides are canonicalised before comparing.
function isMainModule(importMetaUrl, argv1) {
  if (!argv1) return false;
  try {
    return realpathSync(fileURLToPath(importMetaUrl)) === realpathSync(argv1);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main() {
  const c = autoColors();
  const e = autoColors(process.stderr);

  const apply = process.argv.includes("--apply");

  const olderThanAt = process.argv.indexOf("--older-than");
  const olderThanHours = olderThanAt === -1 ? 48 : Number(process.argv[olderThanAt + 1]);
  if (!Number.isFinite(olderThanHours) || olderThanHours < 0) {
    console.error(e.red("worktree-sweep: --older-than expects a non-negative number of hours"));
    process.exit(1);
  }
  const olderThanMs = olderThanHours * 60 * 60 * 1000;

  function run(args, opts = {}) {
    try {
      return { ok: true, out: execFileSync("git", args, { encoding: "utf8", windowsHide: true, ...opts, env: gitEnvWithoutPins(process.env) }).trim() };
    } catch (error) {
      const detail = String(error.stderr ?? error.message).trim().split(/\r?\n/)[0];
      return { ok: false, error: detail };
    }
  }

  function defaultRef() {
    const head = run(["symbolic-ref", "refs/remotes/origin/HEAD"]);
    if (head.ok && head.out.startsWith("refs/remotes/")) return head.out.slice("refs/remotes/".length);
    return "origin/master";
  }

  function isAncestor(sha, ref) {
    return run(["merge-base", "--is-ancestor", sha, ref]).ok;
  }

  function isClean(path) {
    const status = run(["status", "--porcelain"], { cwd: path });
    if (!status.ok) return null;
    return status.out === "";
  }

  function isOld(path) {
    try {
      return Date.now() - statSync(path).mtimeMs > olderThanMs;
    } catch {
      return false;
    }
  }

  function headOf(path) {
    const head = run(["rev-parse", "HEAD"], { cwd: path });
    return head.ok ? head.out : null;
  }

  // The preserve step: never remove a dirty tree before its WIP is a commit.
  // --no-verify keeps git hooks (codegen, guards) out of the sweep's path.
  function snapshot(path, label) {
    const add = run(["add", "-A"], { cwd: path });
    if (!add.ok) return add;
    return run(["commit", "--no-verify", "-m", `wip(${label}): sweep checkpoint`], { cwd: path });
  }

  const listed = run(["worktree", "list", "--porcelain"]);
  if (!listed.ok) {
    console.error(e.red(`worktree-sweep: git worktree list failed: ${listed.error}`));
    process.exit(1);
  }

  const [mainWorktree, ...linked] = parseWorktrees(listed.out);
  if (!mainWorktree) {
    console.error(e.red("worktree-sweep: git worktree list returned no worktrees"));
    process.exit(1);
  }
  const root = join(dirname(mainWorktree.path), ".worktrees");
  const base = defaultRef();
  const cwd = process.cwd();
  const deleteBranch = (name) => run(["branch", "-D", name], { cwd: mainWorktree.path });
  const plan = planSweep(linked, { cwd, root, base, isClean, isAncestor, isOld });

  let removed = 0;
  let preserved = 0;
  let pushed = 0;
  let pruned = 0;
  let failed = 0;
  const kept = new Map();
  const keep = (reason) => kept.set(reason, (kept.get(reason) ?? 0) + 1);
  const noteLine = (note) => (note.ok ? c.green : c.red)(`  ${note.text}`);

  console.log(`worktree-sweep: comparing against ${base} (as of last fetch)${apply ? "" : " — dry run"}`);

  // Paths the trees actually left behind: a failed removal keeps its tree, and
  // its branch stays attached for the stranded prune below. In a dry run every
  // planned removal counts, since the plan is what the run would execute.
  const removedPaths = new Set();
  // Branches still claimed by a surviving worktree, so the stranded prune below
  // cannot delete one. Main's branch is never a session branch, but it is
  // attached all the same.
  const attached = new Set();
  if (mainWorktree.branch) attached.add(mainWorktree.branch.replace("refs/heads/", ""));

  for (const item of plan) {
    if (item.action === "keep") {
      keep(item.reason);
      continue;
    }
    const short = basename(item.path);

    if (!apply) {
      console.log(c.green(`would remove  ${short}  (${item.label})`));
      if (item.preserve.commit) {
        preserved++;
        console.log(c.green("  would commit WIP"));
      }
      // A snapshot makes the branch unmerged by definition, so a dirty tree is
      // pushed even when its pre-snapshot HEAD was merged.
      if (item.branch && (item.preserve.push || item.preserve.commit)) {
        pushed++;
        console.log(c.green(`  would push ${item.branch}`));
      }
      if (item.deletable) {
        pruned++;
        console.log(c.green(`  would delete branch ${item.branch}`));
      }
      removed++;
      removedPaths.add(item.path);
      // The removal already accounts for this branch; it is not stranded.
      if (item.branch) attached.add(item.branch);
      continue;
    }

    const notes = [];
    let failure = null;
    if (item.preserve.commit) {
      const snap = snapshot(item.path, item.label);
      if (snap.ok) {
        preserved++;
        notes.push({ text: "committed WIP", ok: true });
      } else {
        failure = "snapshot failed";
        notes.push({ text: `snapshot failed: ${snap.error}`, ok: false });
      }
    }
    if (!failure && item.branch) {
      const head = headOf(item.path);
      if (!head || !isAncestor(head, base)) {
        const push = run(["push", "-u", "origin", item.branch], { cwd: item.path });
        if (push.ok) {
          pushed++;
          notes.push({ text: `pushed ${item.branch}`, ok: true });
        } else {
          failure = "push failed";
          notes.push({ text: `push failed: ${push.error}`, ok: false });
        }
      }
    }
    if (!failure) {
      const removal = run(["worktree", "remove", item.path]);
      if (!removal.ok) {
        failure = "remove failed";
        notes.push({ text: `remove failed: ${removal.error}`, ok: false });
      }
    }
    if (failure) {
      keep(failure);
      failed++;
      console.log(c.red(`kept  ${short}  (${item.label}): ${failure}`));
      for (const note of notes) console.log(noteLine(note));
      continue;
    }

    removed++;
    removedPaths.add(item.path);
    console.log(c.green(`removed  ${short}  (${item.label})`));
    // Recoverable by now: merged at the last fetch or just pushed. A protected
    // branch (prototype, master/main) is never a deletion target.
    if (item.deletable) {
      const del = deleteBranch(item.branch);
      if (del.ok) {
        pruned++;
        notes.push({ text: `deleted branch ${item.branch}`, ok: true });
      } else {
        failed++;
        notes.push({ text: `branch delete failed for ${item.branch}: ${del.error}`, ok: false });
      }
    }
    for (const note of notes) console.log(noteLine(note));
  }

  // Stranded session branches: local refs left behind by trees that are already
  // gone. Only the guard's `<repo>-<slug>-<7hex>` naming is a target — merged
  // into the base and attached to no surviving worktree.
  const repo = basename(mainWorktree.path);
  for (const entry of linked) {
    if (removedPaths.has(entry.path)) continue;
    if (entry.branch) attached.add(entry.branch.replace("refs/heads/", ""));
  }

  const branches = run(["for-each-ref", "--format=%(refname:short)", "refs/heads"]);
  if (branches.ok) {
    for (const name of branches.out.split(/\r?\n/).filter(Boolean)) {
      if (attached.has(name)) continue;
      if (!isSessionBranch(name, repo)) continue;
      if (!isAncestor(name, base)) continue;
      if (!apply) {
        pruned++;
        console.log(c.green(`would prune branch  ${name}`));
        continue;
      }
      const del = deleteBranch(name);
      if (del.ok) {
        pruned++;
        console.log(c.green(`pruned branch  ${name}`));
      } else {
        failed++;
        console.log(c.red(`branch prune failed for ${name}: ${del.error}`));
      }
    }
  }

  if (apply) {
    const metadata = run(["worktree", "prune"]);
    if (metadata.ok) {
      console.log(c.green("pruned stale worktree metadata"));
    } else {
      failed++;
      console.log(c.red(`worktree prune failed: ${metadata.error}`));
    }
  }

  const keptTotal = [...kept.values()].reduce((a, b) => a + b, 0);
  const detail = [...kept.entries()].map(([reason, count]) => `${reason} ${count}`).join(", ");
  const summaryColor = failed > 0 ? c.red : c.green;
  console.log(summaryColor(`${apply ? "removed" : "would remove"} ${removed}, kept ${keptTotal}${detail ? ` (${detail})` : ""}`));
  console.log(summaryColor(`summary: preserved ${preserved}, pushed ${pushed}, pruned ${pruned} branches, removed ${removed} trees`));
}

if (isMainModule(import.meta.url, process.argv[1])) main();
