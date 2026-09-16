import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { spawnSync } from "node:child_process";

import { parseYamlLite } from "./template-check.mjs";
import {
  ConfigError,
  Gh,
  applyJsonPins,
  applyTomlCatalog,
  applyTomlSections,
  parseGitHubRepo,
  platformCommand,
  runPropagate,
  updateSentinelText,
} from "./template-propagate.mjs";

// ---------------------------------------------------------------------------
// platformCommand
// ---------------------------------------------------------------------------

test("platformCommand: leaves ordinary commands alone, rewrites ./ for cmd.exe", () => {
  assert.equal(platformCommand("npm run check"), "npm run check");
  const expected = process.platform === "win32" ? "gradlew detekt" : "./gradlew detekt";
  assert.equal(platformCommand("./gradlew detekt"), expected);
});

// ---------------------------------------------------------------------------
// applyJsonPins
// ---------------------------------------------------------------------------

const SCAFFOLD_PACKAGE = `${JSON.stringify(
  {
    name: "template-fe",
    dependencies: { react: "^19.0.0", "react-dom": "^19.0.0" },
    devDependencies: { "@biomejs/biome": "^1.9.4", typescript: "~5.7.2", vitest: "^5.0.0" },
  },
  null,
  2,
)}\n`;

const PROJECT_PACKAGE = `${JSON.stringify(
  {
    name: "chameidor-fe",
    dependencies: { react: "^18.2.0", "react-dom": "^19.0.0", "hanzi-writer": "^3.7.3" },
    devDependencies: { typescript: "~5.5.0" },
    scripts: { dev: "vite" },
  },
  null,
  2,
)}\n`;

test("applyJsonPins: updates existing pins in place and adds missing ones to the scaffold's section", () => {
  const { text, changes } = applyJsonPins(SCAFFOLD_PACKAGE, PROJECT_PACKAGE, [
    "react",
    "typescript",
    "vitest",
    "hanzi-writer",
  ]);
  assert.deepEqual(changes, [
    "react ^18.2.0 -> ^19.0.0",
    "typescript ~5.5.0 -> ~5.7.2",
    "vitest (added ^5.0.0)",
  ]);
  const parsed = JSON.parse(text);
  assert.deepEqual(parsed, {
    name: "chameidor-fe",
    dependencies: { react: "^19.0.0", "react-dom": "^19.0.0", "hanzi-writer": "^3.7.3" },
    devDependencies: { typescript: "~5.7.2", vitest: "^5.0.0" },
    scripts: { dev: "vite" },
  });
  // The addition must land inside the devDependencies block, not at the end of the file.
  assert.match(text, /"devDependencies": \{\n\s+"vitest": "\^5\.0\.0",\n\s+"typescript": "~5\.7\.2"\n\s+\}/);
  assert.ok(text.endsWith("\n"));
});

test("applyJsonPins: applying to an already-updated file is a no-op", () => {
  const first = applyJsonPins(SCAFFOLD_PACKAGE, PROJECT_PACKAGE, ["react", "typescript", "vitest"]);
  const second = applyJsonPins(SCAFFOLD_PACKAGE, first.text, ["react", "typescript", "vitest"]);
  assert.deepEqual(second.changes, []);
  assert.equal(second.text, first.text);
});

test("applyJsonPins: a missing project file is created from the watched pins", () => {
  const { text, changes } = applyJsonPins(SCAFFOLD_PACKAGE, "", ["react", "vitest"]);
  assert.deepEqual(changes, ["react (added ^19.0.0)", "vitest (added ^5.0.0)"]);
  const parsed = JSON.parse(text);
  assert.deepEqual(parsed.dependencies, { react: "^19.0.0" });
  assert.deepEqual(parsed.devDependencies, { vitest: "^5.0.0" });
});

// ---------------------------------------------------------------------------
// applyTomlCatalog
// ---------------------------------------------------------------------------

const SCAFFOLD_CATALOG = `[versions]
exposed = "1.0.0"
ktor = "3.3.1"

[libraries]
ktor-server = { module = "io.ktor:ktor-server", version.ref = "ktor" }
`;

const PROJECT_CATALOG = `[versions]
ktor = "3.2.0"
spring = "3.3.0"

[libraries]
ktor-server = { module = "io.ktor:ktor-server", version.ref = "ktor" }

[plugins]
spring-boot = { id = "org.springframework.boot", version.ref = "spring" }
`;

test("applyTomlCatalog: updates watched aliases and adds missing ones, leaving the rest alone", () => {
  const { text, changes } = applyTomlCatalog(SCAFFOLD_CATALOG, PROJECT_CATALOG);
  assert.deepEqual(changes, ["exposed (added 1.0.0)", "ktor 3.2.0 -> 3.3.1"]);
  const versions = Object.fromEntries(
    text
      .split("\n")
      .map((line) => line.match(/^([a-zA-Z0-9_-]+)\s*=\s*"([^"]+)"/))
      .filter(Boolean)
      .map((match) => [match[1], match[2]]),
  );
  assert.deepEqual(versions, { ktor: "3.3.1", exposed: "1.0.0", spring: "3.3.0" });
  assert.match(text, /\[plugins\]\nspring-boot = \{ id = "org\.springframework\.boot", version\.ref = "spring" \}/);
  const again = applyTomlCatalog(SCAFFOLD_CATALOG, text);
  assert.deepEqual(again.changes, []);
});

test("applyTomlCatalog: a project without the versions section gets one", () => {
  const { text, changes } = applyTomlCatalog(SCAFFOLD_CATALOG, '[libraries]\nfoo = "bar"\n');
  assert.deepEqual(changes, ["exposed (added 1.0.0)", "ktor (added 3.3.1)"]);
  assert.match(text, /\[versions\]\nexposed = "1\.0\.0"\nktor = "3\.3\.1"\n/);
  assert.match(text, /\[libraries\]\nfoo = "bar"/);
});

// ---------------------------------------------------------------------------
// applyTomlSections
// ---------------------------------------------------------------------------

const SCAFFOLD_PYPROJECT = `[project]
name = "template"
requires-python = ">=3.12"

[tool.ruff]
line-length = 120
target-version = "py312"

[tool.ruff.lint]
select = ["E", "F", "I"]

[tool.mypy]
strict = true
`;

const PROJECT_PYPROJECT = `[project]
name = "shougong"
requires-python = ">=3.12"

[tool.ruff]
line-length = 100

[tool.ruff.lint]
select = ["E", "F"]

[tool.custom]
keep = "me"
`;

test("applyTomlSections: replaces the listed sections and appends the missing ones", () => {
  const { text, changes } = applyTomlSections(SCAFFOLD_PYPROJECT, PROJECT_PYPROJECT, [
    "tool.ruff",
    "tool.ruff.lint",
    "tool.mypy",
  ]);
  assert.deepEqual(changes, ["[tool.ruff] replaced", "[tool.ruff.lint] replaced", "[tool.mypy] added"]);
  assert.match(text, /\[tool\.ruff\]\nline-length = 120\ntarget-version = "py312"\n\n\[tool\.ruff\.lint\]/);
  assert.match(text, /\[tool\.mypy\]\nstrict = true\n/);
  assert.match(text, /\[project\]\nname = "shougong"/);
  assert.match(text, /\[tool\.custom\]\nkeep = "me"/);
  const again = applyTomlSections(SCAFFOLD_PYPROJECT, text, ["tool.ruff", "tool.ruff.lint", "tool.mypy"]);
  assert.deepEqual(again.changes, []);
});

test("applyTomlSections: CRLF in the project does not read as a change", () => {
  const sections = ["tool.ruff", "tool.ruff.lint", "tool.mypy"];
  const converged = applyTomlSections(SCAFFOLD_PYPROJECT, PROJECT_PYPROJECT, sections).text;
  const { changes } = applyTomlSections(SCAFFOLD_PYPROJECT, converged.replace(/\n/g, "\r\n"), sections);
  assert.deepEqual(changes, []);
});

// ---------------------------------------------------------------------------
// updateSentinelText
// ---------------------------------------------------------------------------

const SENTINEL = `source: react
lane: frontend
applied:
  revision: 1
  scaffold_sha: oldsha
allow:
  - entry: biome.json
    reason: "divergence by design"
  - entry: tsconfig.json
    reason: "stricter locally"
    seen_in: aaabbb
`;

test("updateSentinelText: bumps the applied pin and stamps observed waivers", () => {
  const updated = updateSentinelText(SENTINEL, { revision: 2, scaffoldSha: "newsha", observedAllows: ["biome.json"] });
  assert.equal(
    updated,
    `source: react
lane: frontend
applied:
  revision: 2
  scaffold_sha: newsha
allow:
  - entry: biome.json
    reason: "divergence by design"
    seen_in: newsha
  - entry: tsconfig.json
    reason: "stricter locally"
    seen_in: aaabbb
`,
  );
});

test("updateSentinelText: appends an applied block when the sentinel has none", () => {
  const updated = updateSentinelText("source: python\nlane: backend\n", { revision: 3, scaffoldSha: "ccc333" });
  assert.equal(updated, "source: python\nlane: backend\napplied:\n  revision: 3\n  scaffold_sha: ccc333\n");
});

test("updateSentinelText: keeps CRLF line endings", () => {
  const expected = `source: react
lane: frontend
applied:
  revision: 2
  scaffold_sha: newsha
allow:
  - entry: biome.json
    reason: "divergence by design"
    seen_in: newsha
  - entry: tsconfig.json
    reason: "stricter locally"
    seen_in: aaabbb
`;
  const updated = updateSentinelText(SENTINEL.replace(/\n/g, "\r\n"), {
    revision: 2,
    scaffoldSha: "newsha",
    observedAllows: ["biome.json"],
  });
  assert.equal(updated, expected.replace(/\n/g, "\r\n"));
});

// ---------------------------------------------------------------------------
// parseGitHubRepo
// ---------------------------------------------------------------------------

test("parseGitHubRepo: reads owner/repo from the remote url shapes git produces", () => {
  assert.equal(parseGitHubRepo("git@github.com:luiznaac/chameidor.git"), "luiznaac/chameidor");
  assert.equal(parseGitHubRepo("https://github.com/luiznaac/chameidor"), "luiznaac/chameidor");
  assert.equal(parseGitHubRepo("https://github.com/luiznaac/chameidor.git"), "luiznaac/chameidor");
  assert.equal(parseGitHubRepo("ssh://git@github.com/luiznaac/chameidor.git"), "luiznaac/chameidor");
  assert.equal(parseGitHubRepo("C:/code/remotes/chameidor.git"), null);
});

// ---------------------------------------------------------------------------
// runPropagate: real git fixtures, a real bare remote, a fake `gh`
// ---------------------------------------------------------------------------

const TEST_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "propagate-test",
  GIT_AUTHOR_EMAIL: "propagate-test@example.com",
  GIT_COMMITTER_NAME: "propagate-test",
  GIT_COMMITTER_EMAIL: "propagate-test@example.com",
};

const OK_CHECK = "process.exit(0);\n";
const FAIL_CHECK = "process.exit(3);\n";

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", env: TEST_ENV, windowsHide: true });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function writeFiles(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const path = join(root, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
}

function prefixTree(prefix, files) {
  return Object.fromEntries(Object.entries(files).map(([rel, content]) => [`${prefix}/${rel}`, content]));
}

function treeSnapshot(root) {
  const files = {};
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else files[relative(root, path).split(sep).join("/")] = readFileSync(path, "utf8");
    }
  };
  walk(root);
  return files;
}

function commitAll(dir, message) {
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", message]);
  return git(dir, ["rev-parse", "HEAD"]);
}

function initRepo(dir, files, message = "init") {
  writeFiles(dir, files);
  git(dir, ["init", "-q", "-b", "main"]);
  return commitAll(dir, message);
}

function remoteRefs(remote) {
  const result = spawnSync("git", ["--git-dir", remote, "for-each-ref", "--format=%(refname)", "refs/heads"], {
    encoding: "utf8",
    env: TEST_ENV,
    windowsHide: true,
  });
  assert.equal(result.status, 0, `for-each-ref failed: ${result.stderr}`);
  return result.stdout.trim().split("\n").filter(Boolean);
}

// A scaffold repo (an `environments/` checkout) whose `react/` tree moved from `pin` to `target`.
function scaffoldFixture(base, changes) {
  const dir = join(base, "environments");
  const files = {
    "react/.salgadinhos/manifest.yml": [
      "entries:",
      "  package.json:",
      "    class: pinned",
      "    pins: [react]",
      "  biome.json: owned",
      "  notes.md: judgment",
      "check:",
      "  command: node check/ok.mjs",
      "instantiate:",
      "  name: template",
      "",
    ].join("\n"),
    "react/package.json": `${JSON.stringify({ name: "template-fe", dependencies: { react: "^18.2.0" } }, null, 2)}\n`,
    "react/biome.json": '{ "formatter": { "lineWidth": 100 } }\n',
    "react/notes.md": "v1\n",
    "react/changelog.md": "old\n",
    "react/check/ok.mjs": OK_CHECK,
  };
  writeFiles(dir, files);
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "scaffold v1"]);
  const pin = git(dir, ["rev-parse", "HEAD"]);
  writeFiles(
    dir,
    prefixTree("react", {
      "package.json": `${JSON.stringify({ name: "template-fe", dependencies: { react: "^19.0.0" } }, null, 2)}\n`,
      "biome.json": '{ "formatter": { "lineWidth": 120 } }\n',
      "notes.md": "v2\n",
      "changelog.md": "new\n",
      ...changes,
    }),
  );
  const target = commitAll(dir, "scaffold v2");
  return { dir, pin, target };
}

function sentinelText({ source = "react", lane = "frontend", revision = 1, scaffoldSha, allow = [] }) {
  let text = `source: ${source}\nlane: ${lane}\napplied:\n  revision: ${revision}\n  scaffold_sha: ${scaffoldSha}\n`;
  if (allow.length > 0) {
    text += "allow:\n";
    for (const item of allow) {
      text += `  - entry: ${item.entry}\n    reason: ${JSON.stringify(item.reason)}\n`;
      if (item.seenIn) text += `    seen_in: ${item.seenIn}\n`;
    }
  }
  return text;
}

// A sibling project checkout with an `origin` bare remote, like the writer machine has.
function projectFixture(base, { name = "chameidor", lanes }) {
  const dir = join(base, name);
  const files = {};
  for (const lane of lanes) {
    files[`.salgadinhos/${lane.lane}.yml`] = lane.sentinel;
    Object.assign(files, prefixTree(lane.lane, lane.files));
  }
  writeFiles(dir, files);
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "project"]);
  const remote = join(base, "remotes", `${name}.git`);
  mkdirSync(dirname(remote), { recursive: true });
  git(dirname(remote), ["init", "--bare", "-q", "-b", "main", remote]);
  git(dir, ["remote", "add", "origin", remote]);
  git(dir, ["push", "-q", "-u", "origin", "main"]);
  return { dir, remote };
}

function fakeGh({ repo = "test-org/chameidor", existingPr = null, defaultBranch = "main" } = {}) {
  const calls = [];
  return {
    calls,
    resolveRepo: (originUrl) => {
      calls.push({ method: "resolveRepo", originUrl });
      return repo;
    },
    defaultBranch: (ownerRepo) => {
      calls.push({ method: "defaultBranch", repo: ownerRepo });
      return defaultBranch;
    },
    findOpenPr: (ownerRepo, head) => {
      calls.push({ method: "findOpenPr", repo: ownerRepo, head });
      return existingPr;
    },
    createPr: (spec) => {
      calls.push({ method: "createPr", spec });
      return `https://example.test/${spec.repo}/pull/7`;
    },
  };
}

function propagate(base, options = {}) {
  return runPropagate({
    environmentsPath: join(base, "environments"),
    codeRoot: base,
    dryRun: true,
    gitEnv: TEST_ENV,
    scratchRoot: base,
    ...options,
  });
}

function cloneBranch(base, remote, branch, name) {
  const dir = join(base, name);
  git(base, ["clone", "-q", "--branch", branch, remote, dir]);
  return dir;
}

function lf(text) {
  return text.replace(/\r\n/g, "\n");
}

test("runPropagate: dry-run writes nothing; an open cycle opens exactly one PR", () => {
  const base = mkdtempSync(join(tmpdir(), "template-propagate-run-"));
  const scaffold = scaffoldFixture(base, {});
  const project = projectFixture(base, {
    lanes: [
      {
        lane: "frontend",
        sentinel: sentinelText({ scaffoldSha: scaffold.pin }),
        files: {
          "package.json": `${JSON.stringify({ name: "chameidor-fe", dependencies: { react: "^18.2.0" } }, null, 2)}\n`,
          "biome.json": '{ "formatter": { "lineWidth": 100 } }\n',
          "notes.md": "v1\n",
          "check/ok.mjs": OK_CHECK,
        },
      },
    ],
  });
  const before = treeSnapshot(project.dir);
  const gh = fakeGh();

  const dry = propagate(base, { gh });
  assert.equal(gh.calls.length, 0, "dry-run must not talk to gh");
  assert.deepEqual(treeSnapshot(project.dir), before, "dry-run must not write to the project checkout");
  assert.deepEqual(remoteRefs(project.remote), ["refs/heads/main"], "dry-run must not push");
  assert.equal(dry.failures, 0);
  const dryLane = dry.repos[0].lanes[0];
  assert.equal(dry.repos[0].status, "dry-run");
  assert.deepEqual(
    dryLane.applies.map((apply) => [apply.file, apply.class]),
    [
      ["biome.json", "owned"],
      ["package.json", "pinned"],
    ],
  );
  assert.deepEqual(
    dryLane.skipped.map((skip) => [skip.file, skip.reason]),
    [["notes.md", "judgment"]],
  );
  assert.deepEqual(dryLane.unclassified, ["changelog.md"]);
  assert.equal(dryLane.check.ok, true);

  const opened = propagate(base, { dryRun: false, gh });
  assert.equal(opened.failures, 0);
  const creates = gh.calls.filter((call) => call.method === "createPr");
  assert.equal(creates.length, 1, "one cycle must open exactly one PR");
  assert.equal(creates[0].spec.repo, "test-org/chameidor");
  assert.equal(creates[0].spec.base, "main");
  const branch = `salgadinhos/propagate-${scaffold.target.slice(0, 7)}`;
  assert.equal(creates[0].spec.head, branch);
  assert.equal(opened.repos[0].status, "pr-opened");
  assert.equal(opened.repos[0].prUrl, "https://example.test/test-org/chameidor/pull/7");
  assert.deepEqual(treeSnapshot(project.dir), before, "the project checkout must never be touched");

  const inspect = cloneBranch(base, project.remote, branch, "inspect");
  assert.equal(JSON.parse(lf(readFileSync(join(inspect, "frontend/package.json"), "utf8"))).dependencies.react, "^19.0.0");
  assert.equal(lf(readFileSync(join(inspect, "frontend/biome.json"), "utf8")), '{ "formatter": { "lineWidth": 120 } }\n');
  assert.equal(lf(readFileSync(join(inspect, "frontend/notes.md"), "utf8")), "v1\n", "judgment entries stay out of the applier");
  const sentinel = parseYamlLite(readFileSync(join(inspect, ".salgadinhos/frontend.yml"), "utf8"));
  assert.equal(sentinel.applied.revision, "2");
  assert.equal(sentinel.applied.scaffold_sha, scaffold.target);
  assert.deepEqual(
    remoteRefs(project.remote).sort(),
    ["refs/heads/main", `refs/heads/${branch}`].sort(),
  );
});

test("runPropagate: one PR per repo with two lanes, merge sections respected", () => {
  const base = mkdtempSync(join(tmpdir(), "template-propagate-merge-"));
  const environments = join(base, "environments");
  writeFiles(environments, {
    "react/.salgadinhos/manifest.yml": "entries:\n  package.json:\n    class: pinned\n    pins: [react]\ncheck:\n  command: node check/ok.mjs\ninstantiate:\n  name: template\n",
    "react/package.json": `${JSON.stringify({ name: "template-fe", dependencies: { react: "^18.2.0" } }, null, 2)}\n`,
    "react/check/ok.mjs": OK_CHECK,
    "python/.salgadinhos/manifest.yml": "entries:\n  pyproject.toml:\n    class: merge\n    sections:\n      - tool.ruff\ncheck:\n  command: node check/ok.mjs\ninstantiate:\n  name: template\n",
    "python/pyproject.toml": '[project]\nname = "template"\n\n[tool.ruff]\nline-length = 100\n',
    "python/check/ok.mjs": OK_CHECK,
  });
  git(environments, ["init", "-q", "-b", "main"]);
  const pinReact = commitAll(environments, "react v1");
  const pinPython = pinReact;
  writeFiles(environments, {
    "react/package.json": `${JSON.stringify({ name: "template-fe", dependencies: { react: "^19.0.0" } }, null, 2)}\n`,
    "python/pyproject.toml": '[project]\nname = "template"\n\n[tool.ruff]\nline-length = 120\n',
  });
  const target = commitAll(environments, "scaffold v2");

  const project = projectFixture(base, {
    lanes: [
      {
        lane: "frontend",
        sentinel: sentinelText({ source: "react", scaffoldSha: pinReact }),
        files: {
          "package.json": `${JSON.stringify({ name: "chameidor-fe", dependencies: { react: "^18.2.0" } }, null, 2)}\n`,
          "check/ok.mjs": OK_CHECK,
        },
      },
      {
        lane: "backend",
        sentinel: sentinelText({ source: "python", lane: "backend", scaffoldSha: pinPython }),
        files: { "pyproject.toml": '[project]\nname = "chameidor"\nrequires-python = ">=3.12"\n\n[tool.ruff]\nline-length = 100\n', "check/ok.mjs": OK_CHECK },
      },
    ],
  });
  const gh = fakeGh();
  const result = propagate(base, { dryRun: false, gh });
  assert.equal(result.failures, 0);
  assert.equal(gh.calls.filter((call) => call.method === "createPr").length, 1, "two lanes must still be one PR");
  const branch = `salgadinhos/propagate-${target.slice(0, 7)}`;
  const inspect = cloneBranch(base, project.remote, branch, "inspect-merge");
  assert.equal(JSON.parse(lf(readFileSync(join(inspect, "frontend/package.json"), "utf8"))).dependencies.react, "^19.0.0");
  const pyproject = lf(readFileSync(join(inspect, "backend/pyproject.toml"), "utf8"));
  assert.match(pyproject, /\[project\]\nname = "chameidor"\nrequires-python = ">=3.12"/);
  assert.match(pyproject, /\[tool\.ruff\]\nline-length = 120\n/);
  assert.equal(parseYamlLite(readFileSync(join(inspect, ".salgadinhos/frontend.yml"), "utf8")).applied.revision, "2");
  assert.equal(parseYamlLite(readFileSync(join(inspect, ".salgadinhos/backend.yml"), "utf8")).applied.revision, "2");
});

test("runPropagate: a sentinel allow waives the entry and advances the pin (renúncia)", () => {
  const base = mkdtempSync(join(tmpdir(), "template-propagate-allow-"));
  const scaffold = scaffoldFixture(base, {});
  const project = projectFixture(base, {
    lanes: [
      {
        lane: "frontend",
        sentinel: sentinelText({ scaffoldSha: scaffold.pin, allow: [{ entry: "biome.json", reason: "divergence by design" }] }),
        files: {
          "package.json": `${JSON.stringify({ name: "chameidor-fe", dependencies: { react: "^18.2.0" } }, null, 2)}\n`,
          "biome.json": '{ "formatter": { "lineWidth": 90 } }\n',
          "check/ok.mjs": OK_CHECK,
        },
      },
    ],
  });
  const gh = fakeGh();
  const result = propagate(base, { dryRun: false, gh });
  assert.equal(result.failures, 0);
  const lane = result.repos[0].lanes[0];
  assert.deepEqual(lane.skipped, [
    { file: "biome.json", reason: "allow", note: "divergence by design" },
    { file: "notes.md", reason: "judgment" },
  ]);
  const branch = `salgadinhos/propagate-${scaffold.target.slice(0, 7)}`;
  const inspect = cloneBranch(base, project.remote, branch, "inspect-allow");
  assert.equal(lf(readFileSync(join(inspect, "frontend/biome.json"), "utf8")), '{ "formatter": { "lineWidth": 90 } }\n');
  const sentinel = parseYamlLite(readFileSync(join(inspect, ".salgadinhos/frontend.yml"), "utf8"));
  assert.equal(sentinel.applied.revision, "2");
  assert.equal(sentinel.applied.scaffold_sha, scaffold.target);
  assert.deepEqual(sentinel.allow, [{ entry: "biome.json", reason: "divergence by design", seen_in: scaffold.target }]);
});

test("runPropagate: a failing fast check stops the repo before any push or PR", () => {
  const base = mkdtempSync(join(tmpdir(), "template-propagate-check-"));
  const scaffold = scaffoldFixture(base, {
    "check/ok.mjs": FAIL_CHECK,
  });
  const project = projectFixture(base, {
    lanes: [
      {
        lane: "frontend",
        sentinel: sentinelText({ scaffoldSha: scaffold.pin }),
        files: {
          "package.json": `${JSON.stringify({ name: "chameidor-fe", dependencies: { react: "^18.2.0" } }, null, 2)}\n`,
          "biome.json": '{ "formatter": { "lineWidth": 100 } }\n',
          "check/ok.mjs": FAIL_CHECK,
        },
      },
    ],
  });
  const gh = fakeGh();
  const result = propagate(base, { dryRun: false, gh });
  assert.equal(result.failures, 1);
  assert.equal(result.repos[0].status, "check-failed");
  assert.equal(result.repos[0].lanes[0].check.ok, false);
  assert.equal(gh.calls.filter((call) => call.method === "createPr").length, 0);
  assert.deepEqual(remoteRefs(project.remote), ["refs/heads/main"]);
});

test("runPropagate: re-running over an open PR is idempotent, not a duplicate", () => {
  const base = mkdtempSync(join(tmpdir(), "template-propagate-existing-"));
  const scaffold = scaffoldFixture(base, {});
  const project = projectFixture(base, {
    lanes: [
      {
        lane: "frontend",
        sentinel: sentinelText({ scaffoldSha: scaffold.pin }),
        files: {
          "package.json": `${JSON.stringify({ name: "chameidor-fe", dependencies: { react: "^18.2.0" } }, null, 2)}\n`,
          "biome.json": '{ "formatter": { "lineWidth": 100 } }\n',
          "check/ok.mjs": OK_CHECK,
        },
      },
    ],
  });
  const first = propagate(base, { dryRun: false, gh: fakeGh() });
  assert.equal(first.repos[0].status, "pr-opened");
  const branch = `salgadinhos/propagate-${scaffold.target.slice(0, 7)}`;
  const tip = git(base, ["--git-dir", project.remote, "rev-parse", `refs/heads/${branch}`]);

  const gh = fakeGh({ existingPr: "https://example.test/test-org/chameidor/pull/7" });
  const result = propagate(base, { dryRun: false, gh });
  assert.equal(result.repos[0].status, "pr-exists");
  assert.equal(result.repos[0].prUrl, "https://example.test/test-org/chameidor/pull/7");
  assert.equal(gh.calls.filter((call) => call.method === "createPr").length, 0);
  assert.equal(gh.calls.filter((call) => call.method === "findOpenPr").length, 1);
  assert.equal(git(base, ["--git-dir", project.remote, "rev-parse", `refs/heads/${branch}`]), tip, "the branch must not grow a new commit");
});

test("Gh: drives gh through the injected runner", () => {
  const calls = [];
  const gh = new Gh({
    run: (args, input) => {
      calls.push({ args, input });
      if (args[0] === "repo") return "main\n";
      if (args[1] === "list") return "\n";
      return "https://example.test/test-org/chameidor/pull/9\n";
    },
  });
  assert.equal(gh.defaultBranch("test-org/chameidor"), "main");
  assert.equal(gh.findOpenPr("test-org/chameidor", "branch"), null);
  assert.equal(gh.createPr({ repo: "test-org/chameidor", base: "main", head: "branch", title: "t", body: "the body" }), "https://example.test/test-org/chameidor/pull/9");
  assert.deepEqual(calls[0].args, ["repo", "view", "test-org/chameidor", "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"]);
  assert.deepEqual(calls[1].args, ["pr", "list", "--repo", "test-org/chameidor", "--head", "branch", "--state", "open", "--json", "url", "--jq", ".[0].url"]);
  assert.deepEqual(calls[2].args, ["pr", "create", "--repo", "test-org/chameidor", "--base", "main", "--head", "branch", "--title", "t", "--body-file", "-"]);
  assert.equal(calls[2].input, "the body");
});

test("runPropagate: a lane already at the target is a no-op", () => {
  const base = mkdtempSync(join(tmpdir(), "template-propagate-noop-"));
  const scaffold = scaffoldFixture(base, {});
  const project = projectFixture(base, {
    lanes: [
      {
        lane: "frontend",
        sentinel: sentinelText({ scaffoldSha: scaffold.target }),
        files: {
          "package.json": `${JSON.stringify({ name: "chameidor-fe", dependencies: { react: "^19.0.0" } }, null, 2)}\n`,
          "biome.json": '{ "formatter": { "lineWidth": 120 } }\n',
          "check/ok.mjs": OK_CHECK,
        },
      },
    ],
  });
  const gh = fakeGh();
  const result = propagate(base, { dryRun: false, gh });
  assert.equal(result.failures, 0);
  assert.equal(result.repos[0].status, "no-op");
  assert.equal(gh.calls.length, 0);
  assert.deepEqual(remoteRefs(project.remote), ["refs/heads/main"]);
});

test("runPropagate: a sentinel without applied.scaffold_sha is a repo error", () => {
  const base = mkdtempSync(join(tmpdir(), "template-propagate-badsentinel-"));
  scaffoldFixture(base, {});
  projectFixture(base, {
    lanes: [
      {
        lane: "frontend",
        sentinel: "source: react\nlane: frontend\n",
        files: { "package.json": "{}\n", "biome.json": "{}\n", "check/ok.mjs": OK_CHECK },
      },
    ],
  });
  const result = propagate(base, { dryRun: false, gh: fakeGh() });
  assert.equal(result.failures, 1);
  assert.equal(result.repos[0].status, "error");
  assert.match(result.repos[0].error, /applied\.scaffold_sha/);
});

test("runPropagate: a waiver without a reason is a repo error (renúncia must say why)", () => {
  const base = mkdtempSync(join(tmpdir(), "template-propagate-noreason-"));
  const scaffold = scaffoldFixture(base, {});
  projectFixture(base, {
    lanes: [
      {
        lane: "frontend",
        sentinel: sentinelText({ scaffoldSha: scaffold.pin, allow: [{ entry: "biome.json", reason: null }] }),
        files: {
          "package.json": `${JSON.stringify({ name: "chameidor-fe", dependencies: { react: "^18.2.0" } }, null, 2)}\n`,
          "biome.json": '{ "formatter": { "lineWidth": 90 } }\n',
          "check/ok.mjs": OK_CHECK,
        },
      },
    ],
  });
  const result = propagate(base, { dryRun: false, gh: fakeGh() });
  assert.equal(result.failures, 1);
  assert.equal(result.repos[0].status, "error");
  assert.match(result.repos[0].error, /needs a 'reason'/);
});

test("runPropagate: a merge entry without sections is a clear repo error", () => {
  const base = mkdtempSync(join(tmpdir(), "template-propagate-badsection-"));
  const environments = join(base, "environments");
  writeFiles(environments, {
    "python/.salgadinhos/manifest.yml": "entries:\n  pyproject.toml:\n    class: merge\ncheck:\n  command: node check/ok.mjs\ninstantiate:\n  name: template\n",
    "python/pyproject.toml": '[project]\nname = "template"\n\n[tool.ruff]\nline-length = 100\n',
  });
  git(environments, ["init", "-q", "-b", "main"]);
  const pin = commitAll(environments, "scaffold v1");
  writeFiles(environments, { "python/pyproject.toml": '[project]\nname = "template"\n\n[tool.ruff]\nline-length = 120\n' });
  commitAll(environments, "scaffold v2");
  projectFixture(base, {
    lanes: [
      {
        lane: "backend",
        sentinel: sentinelText({ source: "python", lane: "backend", scaffoldSha: pin }),
        files: { "pyproject.toml": '[project]\nname = "chameidor"\n\n[tool.ruff]\nline-length = 100\n', "check/ok.mjs": OK_CHECK },
      },
    ],
  });
  const result = propagate(base, { dryRun: false, gh: fakeGh() });
  assert.equal(result.failures, 1);
  assert.equal(result.repos[0].status, "error");
  assert.match(result.repos[0].error, /merge needs a non-empty 'sections' list/);
});

// ---------------------------------------------------------------------------
// Bootstrap: stamping the lane sentinels of a project that has none
// ---------------------------------------------------------------------------

function bootstrapFixture(base) {
  const environments = join(base, "environments");
  writeFiles(environments, {
    "react/.salgadinhos/manifest.yml": "entries:\n  package.json:\n    class: pinned\n    pins: [react]\ninstantiate:\n  name: template\n",
    "react/package.json": `${JSON.stringify({ name: "template-fe", dependencies: { react: "^18.2.0" } }, null, 2)}\n`,
    "kotlin/.salgadinhos/manifest.yml": "entries:\n  gradle/libs.versions.toml:\n    class: pinned\ninstantiate:\n  name: template\n",
    "kotlin/gradle/libs.versions.toml": "[versions]\nktor = \"3.3.1\"\n",
  });
  git(environments, ["init", "-q", "-b", "main"]);
  git(environments, ["add", "-A"]);
  git(environments, ["commit", "-qm", "scaffold v1"]);
  const pin = git(environments, ["rev-parse", "HEAD"]);
  writeFiles(environments, {
    "react/package.json": `${JSON.stringify({ name: "template-fe", dependencies: { react: "^19.0.0" } }, null, 2)}\n`,
  });
  git(environments, ["add", "-A"]);
  git(environments, ["commit", "-qm", "scaffold v2"]);
  const target = git(environments, ["rev-parse", "HEAD"]);
  return { environments, pin, target };
}

// A sibling project whose default branch carries no .salgadinhos/ at all.
function bareProjectFixture(base, { name = "chameidor", files }) {
  const dir = join(base, name);
  writeFiles(dir, files);
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "project"]);
  const remote = join(base, "remotes", `${name}.git`);
  mkdirSync(dirname(remote), { recursive: true });
  git(dirname(remote), ["init", "--bare", "-q", "-b", "main", remote]);
  git(dir, ["remote", "add", "origin", remote]);
  git(dir, ["push", "-q", "-u", "origin", "main"]);
  return { dir, remote };
}

const BOOTSTRAP_LANES = [
  { dir: "frontend", source: "react" },
  { dir: "backend", source: "kotlin" },
];

function runBootstrap(base, options = {}) {
  return runPropagate({
    environmentsPath: join(base, "environments"),
    codeRoot: base,
    dryRun: true,
    bootstrapLanes: BOOTSTRAP_LANES,
    onlyProject: "chameidor",
    gitEnv: TEST_ENV,
    scratchRoot: base,
    ...options,
  });
}

test("runPropagate: bootstrap stamps one sentinel per lane via a single PR, without touching the project", () => {
  const base = mkdtempSync(join(tmpdir(), "template-propagate-bootstrap-"));
  bootstrapFixture(base);
  const project = bareProjectFixture(base, {
    files: {
      "frontend/package.json": `${JSON.stringify({ name: "chameidor-fe", dependencies: { react: "^18.2.0" } }, null, 2)}\n`,
      "backend/build.gradle.kts": "plugins {}\n",
    },
  });
  const before = treeSnapshot(project.dir);
  const gh = fakeGh();

  const dry = runBootstrap(base, { gh });
  assert.equal(dry.failures, 0);
  assert.equal(gh.calls.length, 0, "bootstrap dry-run must not talk to gh");
  assert.deepEqual(treeSnapshot(project.dir), before, "bootstrap dry-run must not write to the project checkout");
  assert.deepEqual(remoteRefs(project.remote), ["refs/heads/main"], "bootstrap dry-run must not push");
  assert.equal(dry.repos[0].status, "dry-run");

  const opened = runBootstrap(base, { dryRun: false, gh });
  assert.equal(opened.failures, 0);
  const creates = gh.calls.filter((call) => call.method === "createPr");
  assert.equal(creates.length, 1, "one bootstrap must open exactly one PR");
  assert.equal(creates[0].spec.repo, "test-org/chameidor");
  assert.equal(creates[0].spec.base, "main");
  assert.equal(creates[0].spec.head, "salgadinhos/bootstrap-sentinels");
  assert.equal(opened.repos[0].status, "pr-opened");
  assert.deepEqual(treeSnapshot(project.dir), before, "the project checkout must never be touched");

  const inspect = cloneBranch(base, project.remote, "salgadinhos/bootstrap-sentinels", "inspect-bootstrap");
  const frontend = parseYamlLite(readFileSync(join(inspect, ".salgadinhos/frontend.yml"), "utf8"));
  assert.equal(frontend.source, "react");
  assert.equal(frontend.lane, "frontend");
  assert.equal(frontend.applied.revision, "1");
  assert.equal(frontend.applied.scaffold_sha, dry.target.sha);
  assert.deepEqual(frontend.allow, []);
  const backend = parseYamlLite(readFileSync(join(inspect, ".salgadinhos/backend.yml"), "utf8"));
  assert.equal(backend.source, "kotlin");
  assert.equal(backend.applied.scaffold_sha, dry.target.sha);
  assert.deepEqual(
    remoteRefs(project.remote).sort(),
    ["refs/heads/main", "refs/heads/salgadinhos/bootstrap-sentinels"].sort(),
  );
});

test("runPropagate: bootstrap honors --to for the pin", () => {
  const base = mkdtempSync(join(tmpdir(), "template-propagate-bootstrap-to-"));
  const { environments, pin } = bootstrapFixture(base);
  const project = bareProjectFixture(base, {
    files: { "frontend/package.json": "{}\n" },
  });
  const gh = fakeGh();
  const result = runBootstrap(base, { dryRun: false, gh, target: pin });
  assert.equal(result.failures, 0);
  assert.equal(result.repos[0].status, "pr-opened");
  const inspect = cloneBranch(base, project.remote, "salgadinhos/bootstrap-sentinels", "inspect-to");
  const sentinel = parseYamlLite(readFileSync(join(inspect, ".salgadinhos/frontend.yml"), "utf8"));
  assert.equal(sentinel.applied.scaffold_sha, pin);
});

test("runPropagate: a bootstrap re-run over the open PR is a no-op, not a duplicate", () => {
  const base = mkdtempSync(join(tmpdir(), "template-propagate-bootstrap-idem-"));
  bootstrapFixture(base);
  const project = bareProjectFixture(base, {
    files: { "frontend/package.json": "{}\n" },
  });
  const first = runBootstrap(base, { dryRun: false, gh: fakeGh() });
  assert.equal(first.repos[0].status, "pr-opened");
  const tip = git(base, ["--git-dir", project.remote, "rev-parse", "refs/heads/salgadinhos/bootstrap-sentinels"]);

  const gh = fakeGh({ existingPr: "https://example.test/test-org/chameidor/pull/7" });
  const result = runBootstrap(base, { dryRun: false, gh });
  assert.equal(result.failures, 0);
  assert.equal(result.repos[0].status, "pr-exists");
  assert.equal(gh.calls.filter((call) => call.method === "createPr").length, 0);
  assert.equal(git(base, ["--git-dir", project.remote, "rev-parse", "refs/heads/salgadinhos/bootstrap-sentinels"]), tip, "the branch must not grow a new commit");
});

test("runPropagate: bootstrap with an unknown scaffold source is a repo error", () => {
  const base = mkdtempSync(join(tmpdir(), "template-propagate-bootstrap-badsource-"));
  bootstrapFixture(base);
  const project = bareProjectFixture(base, {
    files: { "frontend/package.json": "{}\n" },
  });
  const result = runBootstrap(base, { dryRun: false, gh: fakeGh(), bootstrapLanes: [{ dir: "backend", source: "ruby" }] });
  assert.equal(result.failures, 1);
  assert.equal(result.repos[0].status, "error");
  assert.match(result.repos[0].error, /manifest missing/);
  assert.deepEqual(remoteRefs(project.remote), ["refs/heads/main"]);
});

test("runPropagate: bootstrap without --project is a config error", () => {
  const base = mkdtempSync(join(tmpdir(), "template-propagate-bootstrap-noproj-"));
  bootstrapFixture(base);
  assert.throws(
    () => runPropagate({ environmentsPath: join(base, "environments"), codeRoot: base, bootstrapLanes: BOOTSTRAP_LANES, dryRun: true, gitEnv: TEST_ENV }),
    (error) => error instanceof ConfigError && /bootstrap needs --project/.test(error.message),
  );
});
