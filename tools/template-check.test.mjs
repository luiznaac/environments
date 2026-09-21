import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import {
  ConfigError,
  applyPlaceholders,
  discoverProjects,
  formatFindings,
  jsonDiff,
  loadManifest,
  loadSentinel,
  parseTomlSections,
  parseVersionCatalog,
  parseYamlLite,
  resolveRoots,
  runChecks,
} from "./template-check.mjs";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SCRIPT = join(REPO_ROOT, "tools", "template-check.mjs");

function makeTree(files) {
  const root = mkdtempSync(join(tmpdir(), "template-check-"));
  for (const [rel, content] of Object.entries(files)) {
    const path = join(root, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  return root;
}

function realManifest(stack) {
  return readFileSync(join(REPO_ROOT, stack, ".salgadinhos", "manifest.yml"), "utf8");
}

const FIXTURE_GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "template-check-test",
  GIT_AUTHOR_EMAIL: "template-check-test@example.com",
  GIT_COMMITTER_NAME: "template-check-test",
  GIT_COMMITTER_EMAIL: "template-check-test@example.com",
};

function gitIn(dir, args) {
  const result = spawnSync("git", args, { cwd: dir, encoding: "utf8", env: FIXTURE_GIT_ENV, windowsHide: true });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed in ${dir}: ${result.stderr}`);
  return result.stdout.trim();
}

function sentinelYaml({ source, lane, allow = [], revision = 1, scaffoldSha }) {
  let text = `source: ${source}\nlane: ${lane}\napplied:\n  revision: ${revision}\n  scaffold_sha: ${scaffoldSha}\n`;
  if (allow.length > 0) {
    text += "allow:\n";
    for (const item of allow) {
      text += `  - entry: ${item.entry}\n    reason: ${item.reason}\n`;
    }
  }
  return text;
}

const REACT_SCAFFOLD = {
  "package.json": JSON.stringify(
    {
      dependencies: { react: "^19.0.0", "react-dom": "^19.0.0" },
      devDependencies: { "@biomejs/biome": "^1.9.4", vitest: "^5.0.0" },
    },
    null,
    2,
  ),
  "biome.json": '{ "formatter": { "lineWidth": 100 } }\n',
  "tsconfig.json": '{ "include": ["src"] }\n',
  "tsconfig.app.json": '{ "compilerOptions": { "strict": true } }\n',
  "tsconfig.node.json": '{ "include": ["vite.config.ts"] }\n',
};

// A project generated from the react scaffold: every watched file matches unless overridden.
function reactProject(overrides = {}) {
  return { ...REACT_SCAFFOLD, ...overrides };
}

const GLOBAL_AGENTS = [
  "# global",
  "",
  "- Never commit secrets to the repository, and never print them in logs or summaries.",
  "- Use a worktree for every agent session; do not work in the main checkout.",
  "",
].join("\n");

// Builds a temp code root: an environments/ tree that is a real git repo (its first commit is the
// default sentinel pin — a lane spec may pass its own `pin`), the projects with their lane
// sentinels, and the salgadinhos global AGENTS.md (override with `globalAgentsMd`, or pass null
// to omit it).
function fixture({ manifests = { react: realManifest("react") }, scaffoldFiles = { react: REACT_SCAFFOLD }, projects = {}, globalAgentsMd = GLOBAL_AGENTS }) {
  const files = {};
  for (const [stack, content] of Object.entries(manifests)) {
    files[`environments/${stack}/.salgadinhos/manifest.yml`] = content;
  }
  for (const [stack, stackFiles] of Object.entries(scaffoldFiles)) {
    for (const [rel, content] of Object.entries(stackFiles)) {
      files[`environments/${stack}/${rel}`] = content;
    }
  }
  if (globalAgentsMd != null) files["salgadinhos/global/AGENTS.md"] = globalAgentsMd;
  const root = makeTree(files);
  const environments = join(root, "environments");
  gitIn(environments, ["init", "-q", "-b", "main"]);
  gitIn(environments, ["add", "-A"]);
  gitIn(environments, ["commit", "-qm", "scaffold v1"]);
  const pin = gitIn(environments, ["rev-parse", "HEAD"]);
  for (const [project, lanes] of Object.entries(projects)) {
    for (const [lane, spec] of Object.entries(lanes)) {
      const sentinelPath = join(root, project, ".salgadinhos", `${lane}.yml`);
      mkdirSync(dirname(sentinelPath), { recursive: true });
      writeFileSync(sentinelPath, sentinelYaml({ source: spec.source, lane, allow: spec.allow, revision: spec.revision ?? 1, scaffoldSha: spec.pin ?? pin }));
      for (const [rel, content] of Object.entries(spec.files)) {
        const path = join(root, project, lane, rel);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, content);
      }
    }
  }
  return { root, environments, globalAgentsMd: join(root, "salgadinhos", "global", "AGENTS.md"), pin };
}

// Moves the scaffold forward (new commit, new working tree): the sentinels still pinning the
// fixture's first commit now see a propagation queue.
function advanceScaffold(fix, stack, files, message = "scaffold v2") {
  for (const [rel, content] of Object.entries(files)) {
    const path = join(fix.environments, stack, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  gitIn(fix.environments, ["add", "-A"]);
  gitIn(fix.environments, ["commit", "-qm", message]);
  return gitIn(fix.environments, ["rev-parse", "HEAD"]);
}

function check(fix, options = {}) {
  return runChecks({
    environmentsPath: fix.environments,
    codeRoot: fix.root,
    globalAgentsMd: fix.globalAgentsMd,
    ...options,
  });
}

// ---------------------------------------------------------------------------
// YAML-lite
// ---------------------------------------------------------------------------

test("parseYamlLite: nested maps, bare classes, comments, flow sequences, null", () => {
  const parsed = parseYamlLite(`
# manifest comment
entries:
  package.json:
    class: pinned
    pins: [react, "@tanstack/react-query"] # trailing comment
  biome.json: owned
  empty: {}
instantiate:
  name: null
`);
  assert.deepEqual(parsed, {
    entries: {
      "package.json": { class: "pinned", pins: ["react", "@tanstack/react-query"] },
      "biome.json": "owned",
      empty: {},
    },
    instantiate: { name: null },
  });
});

test("parseYamlLite: block sequences of maps (sentinel allow)", () => {
  const parsed = parseYamlLite(`
source: react
lane: frontend
applied:
  revision: 1
  scaffold_sha: abc123
allow:
  - entry: biome.json
    reason: "divergence by design"
  - entry: AGENTS.md
    reason: keep the project's own wording
`);
  assert.equal(parsed.source, "react");
  assert.equal(parsed.lane, "frontend");
  assert.equal(parsed.applied.revision, "1");
  assert.deepEqual(parsed.allow, [
    { entry: "biome.json", reason: "divergence by design" },
    { entry: "AGENTS.md", reason: "keep the project's own wording" },
  ]);
});

test("parseYamlLite: quoted scalars keep colons, commas and hashes", () => {
  const parsed = parseYamlLite('a: "x: y, z # n"\nb: [ "p, q", r ]\n');
  assert.equal(parsed.a, "x: y, z # n");
  assert.deepEqual(parsed.b, ["p, q", "r"]);
});

// ---------------------------------------------------------------------------
// Committed manifests
// ---------------------------------------------------------------------------

test("loadManifest: react manifest declares the dependency watchlist and rename token", () => {
  const manifest = loadManifest(join(REPO_ROOT, "react", ".salgadinhos", "manifest.yml"));
  assert.deepEqual(manifest.entries["package.json"].pins, [
    "react",
    "react-dom",
    "react-router-dom",
    "@tanstack/react-query",
    "vite",
    "typescript",
    "@biomejs/biome",
    "tailwindcss",
    "vitest",
  ]);
  assert.equal(manifest.entries["biome.json"].class, "owned");
  assert.equal(manifest.entries[".env.example"].class, "judgment");
  assert.equal(manifest.instantiate.name, "template");
  assert.equal(manifest.check.command, "npm run check");
});

test("loadManifest: kotlin manifest watches detekt + the version catalog", () => {
  const manifest = loadManifest(join(REPO_ROOT, "kotlin", ".salgadinhos", "manifest.yml"));
  assert.equal(manifest.entries["config/detekt/config.yml"].class, "owned");
  assert.equal(manifest.entries["gradle/libs.versions.toml"].class, "pinned");
  assert.equal(manifest.entries[".env.example"].class, "judgment");
  assert.equal(manifest.instantiate.name, "template");
  assert.equal(manifest.check.command, "./gradlew compileKotlin compileTestKotlin detekt");
});

test("loadManifest: python manifest merges pyproject sections", () => {
  const manifest = loadManifest(join(REPO_ROOT, "python", ".salgadinhos", "manifest.yml"));
  assert.equal(manifest.entries[".env.example"].class, "judgment");
  assert.equal(manifest.entries["pyproject.toml"].class, "merge");
  assert.deepEqual(manifest.entries["pyproject.toml"].sections, [
    "tool.ruff",
    "tool.ruff.lint",
    "tool.mypy",
    "tool.importlinter",
  ]);
  assert.equal(manifest.check.command, "uv run poe check");
});

test("loadManifest: php manifest is empty and has no rename token yet", () => {
  const manifest = loadManifest(join(REPO_ROOT, "php", ".salgadinhos", "manifest.yml"));
  assert.deepEqual(manifest.entries, {});
  assert.equal(manifest.instantiate.name, null);
  assert.equal(manifest.check.command, null);
});

test("loadManifest: check declares the lane's fast check and its timeout", () => {
  const root = makeTree({ "manifest.yml": "entries: {}\ncheck:\n  command: npm run check\n  timeout_seconds: 900\n" });
  const manifest = loadManifest(join(root, "manifest.yml"));
  assert.deepEqual(manifest.check, { command: "npm run check", timeoutSeconds: 900 });
});

test("loadManifest: check without a command is a config error", () => {
  const root = makeTree({ "manifest.yml": "entries: {}\ncheck:\n  timeout_seconds: 60\n" });
  assert.throws(
    () => loadManifest(join(root, "manifest.yml")),
    (error) => error instanceof ConfigError && /check\.command/.test(error.message),
  );
});

test("loadSentinel: applied pin and allow seen_in are parsed", () => {
  const root = makeTree({
    "frontend.yml": [
      "source: react",
      "lane: frontend",
      "applied:",
      "  revision: 3",
      "  scaffold_sha: abc123",
      "allow:",
      "  - entry: biome.json",
      "    reason: divergence by design",
      "    seen_in: def456",
      "  - entry: tsconfig.json",
      "    reason: stricter here",
      "",
    ].join("\n"),
  });
  const sentinel = loadSentinel(join(root, "frontend.yml"));
  assert.deepEqual(sentinel.applied, { revision: 3, scaffoldSha: "abc123" });
  assert.deepEqual(sentinel.allow, [
    { entry: "biome.json", reason: "divergence by design", seenIn: "def456" },
    { entry: "tsconfig.json", reason: "stricter here", seenIn: null },
  ]);
});

test("loadSentinel: a malformed applied block is a config error", () => {
  const root = makeTree({ "frontend.yml": "source: react\napplied:\n  revision: not-a-number\n  scaffold_sha: abc\n" });
  assert.throws(
    () => loadSentinel(join(root, "frontend.yml")),
    (error) => error instanceof ConfigError && /applied\.revision/.test(error.message),
  );
});

test("loadManifest: unknown class is a config error", () => {
  const root = makeTree({ "manifest.yml": "entries:\n  a.json: ownedd\n" });
  assert.throws(
    () => loadManifest(join(root, "manifest.yml")),
    (error) => error instanceof ConfigError && /unknown class 'ownedd'/.test(error.message),
  );
});

// ---------------------------------------------------------------------------
// Parsing helpers (ported from PR #33, messages kept compatible)
// ---------------------------------------------------------------------------

test("jsonDiff: structured items carry path, kind and both values", () => {
  assert.deepEqual(jsonDiff({ include: ["a"] }, { include: ["a", "b"] }), [
    { path: "include.1", kind: "right-only", left: null, right: "b" },
  ]);
  assert.deepEqual(jsonDiff({ settings: { x: 1 } }, { settings: { y: 2 } }), [
    { path: "settings.x", kind: "left-only", left: 1, right: null },
    { path: "settings.y", kind: "right-only", left: null, right: 2 },
  ]);
  assert.deepEqual(jsonDiff({ a: 1 }, { a: 2 }), [{ path: "a", kind: "changed", left: 1, right: 2 }]);
});

test("parseVersionCatalog: reads the [versions] section and stops at the next header", () => {
  const text = '[versions]\n\nktor = "3.3.1"\nexposed="1.0.0-rc-1"\n\n[libraries]\nfoo = { module = "x" }\n';
  assert.deepEqual(parseVersionCatalog(text), { ktor: "3.3.1", exposed: "1.0.0-rc-1" });
});

test("parseTomlSections: maps section name to its normalized body", () => {
  const sections = parseTomlSections('[tool.ruff]\nline-length = 120\n\n[tool.mypy]\nstrict = true\n');
  assert.equal(sections["tool.ruff"], "line-length = 120");
  assert.equal(sections["tool.mypy"], "strict = true");
});

test("applyPlaceholders: replaces the token on word boundaries only", () => {
  assert.equal(applyPlaceholders("src/template and template-fe", "template", "shougong"), "src/shougong and shougong-fe");
  assert.equal(applyPlaceholders("Controllertemplate", "template", "shougong"), "Controllertemplate");
});

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

test("discoverProjects: one entry per lane, from sentinels, sorted", () => {
  const fix = fixture({
    projects: {
      chameidor: { frontend: { source: "react", files: reactProject() } },
      shougong: {
        backend: { source: "python", files: {} },
        frontend: { source: "react", files: reactProject() },
      },
    },
  });
  const projects = discoverProjects(fix.environments, fix.root);
  assert.deepEqual(
    projects.map((project) => [project.project, project.lane, project.source]),
    [
      ["chameidor", "frontend", "react"],
      ["shougong", "backend", "python"],
      ["shougong", "frontend", "react"],
    ],
  );
  assert.equal(projects[0].applied.scaffoldSha, fix.pin, "discovery carries the applied pin");
});

test("discoverProjects: sentinel without lane falls back to the file name", () => {
  const fix = fixture({
    projects: { chameidor: { frontend: { source: "react", files: reactProject() } } },
  });
  writeFileSync(join(fix.root, "chameidor", ".salgadinhos", "frontend.yml"), "source: react\n");
  const projects = discoverProjects(fix.environments, fix.root);
  assert.deepEqual(
    projects.map((project) => [project.project, project.lane]),
    [["chameidor", "frontend"]],
  );
});

test("discoverProjects: sentinel without source is a config error", () => {
  const fix = fixture({ projects: { chameidor: { frontend: { source: "react", files: reactProject() } } } });
  writeFileSync(join(fix.root, "chameidor", ".salgadinhos", "frontend.yml"), "lane: frontend\n");
  assert.throws(() => discoverProjects(fix.environments, fix.root), ConfigError);
});

// ---------------------------------------------------------------------------
// runChecks
// ---------------------------------------------------------------------------

test("runChecks: queue view — a watched pin that moved since the applied pin is blocking DRIFT", () => {
  const fix = fixture({
    projects: {
      chameidor: { frontend: { source: "react", files: reactProject() } },
    },
  });
  advanceScaffold(fix, "react", {
    "package.json": `${JSON.stringify(
      {
        dependencies: { react: "^19.0.0", "react-dom": "^19.0.0" },
        devDependencies: { "@biomejs/biome": "^1.9.4", vitest: "^6.0.0" },
      },
      null,
      2,
    )}\n`,
  });
  const { findings } = check(fix);
  assert.deepEqual(
    findings.map((f) => [f.severity, f.file, f.message]),
    [["drift", "package.json", "scaffold vitest: ^5.0.0 -> ^6.0.0 since the applied pin"]],
  );
  assert.equal(formatFindings(findings).exitCode, 1);
});

test("runChecks: queue view — a watched pin the scaffold gained is blocking DRIFT", () => {
  const fix = fixture({
    projects: {
      chameidor: { frontend: { source: "react", files: reactProject() } },
    },
  });
  advanceScaffold(fix, "react", {
    "package.json": `${JSON.stringify(
      {
        dependencies: { react: "^19.0.0", "react-dom": "^19.0.0", "react-router-dom": "^7.0.0" },
        devDependencies: { "@biomejs/biome": "^1.9.4", vitest: "^5.0.0" },
      },
      null,
      2,
    )}\n`,
  });
  const { findings } = check(fix);
  assert.deepEqual(
    findings.map((f) => [f.severity, f.file, f.message]),
    [["drift", "package.json", "scaffold added react-router-dom ^7.0.0 since the applied pin"]],
  );
});

test("runChecks: lane view — a local edit on a watched pin is AHEAD and does not block", () => {
  const fix = fixture({
    projects: {
      chameidor: {
        frontend: {
          source: "react",
          files: reactProject({
            "package.json": JSON.stringify(
              {
                dependencies: { react: "^19.0.0", "react-dom": "^19.0.0" },
                devDependencies: { "@biomejs/biome": "^1.9.4", vitest: "^4.0.0" },
              },
              null,
              2,
            ),
          }),
        },
      },
    },
  });
  const { findings } = check(fix);
  assert.deepEqual(
    findings.map((f) => [f.severity, f.file, f.message]),
    [["ahead", "package.json", "lane vitest: ^5.0.0 -> ^4.0.0 since the applied pin (local edit - port back, or declare it in allow)"]],
  );
  assert.equal(formatFindings(findings).exitCode, 0);
});

test("runChecks: lane view — dropping a watched pin the applied pin has is AHEAD", () => {
  const files = reactProject();
  files["package.json"] = JSON.stringify(
    {
      dependencies: { react: "^19.0.0", "react-dom": "^19.0.0" },
      devDependencies: { "@biomejs/biome": "^1.9.4" },
    },
    null,
    2,
  );
  const fix = fixture({ projects: { shougong: { frontend: { source: "react", files } } } });
  const { findings } = check(fix);
  assert.deepEqual(
    findings.map((f) => [f.severity, f.file, f.message]),
    [["ahead", "package.json", "lane dropped vitest ^5.0.0 since the applied pin (local edit - port back, or declare it in allow)"]],
  );
});

test("runChecks: owned JSON diffs are structural in both views", () => {
  const fix = fixture({
    projects: {
      chameidor: {
        frontend: {
          source: "react",
          files: reactProject({
            "tsconfig.json": '{ "include": [], "references": [{ "path": "./tsconfig.app.json" }] }\n',
          }),
        },
      },
    },
  });
  const { findings } = check(fix);
  assert.deepEqual(
    findings.map((f) => [f.severity, f.file, f.message]),
    [
      ["ahead", "tsconfig.json", "lane dropped include.0 since the applied pin (local edit - port back, or declare it in allow)"],
      ["ahead", "tsconfig.json", "lane added references since the applied pin (local edit - port back, or declare it in allow)"],
    ],
  );

  const moved = fixture({
    projects: { chameidor: { frontend: { source: "react", files: reactProject() } } },
  });
  advanceScaffold(moved, "react", { "tsconfig.node.json": '{ "include": ["vite.config.ts", "vitest.config.ts"] }\n' });
  const queue = check(moved).findings;
  assert.deepEqual(
    queue.map((f) => [f.severity, f.file, f.message]),
    [["drift", "tsconfig.node.json", "scaffold added include.1 since the applied pin"]],
  );
});

test("runChecks: both views at once — the scaffold moved and the lane edited the same entry", () => {
  const fix = fixture({
    projects: {
      chameidor: {
        frontend: { source: "react", files: reactProject({ "biome.json": '{ "formatter": { "lineWidth": 90 } }\n' }) },
      },
    },
  });
  advanceScaffold(fix, "react", { "biome.json": '{ "formatter": { "lineWidth": 120 } }\n' });
  const { findings } = check(fix);
  assert.deepEqual(
    findings.map((f) => [f.severity, f.file, f.message]),
    [
      ["drift", "biome.json", "scaffold formatter.lineWidth: 100 -> 120 since the applied pin"],
      ["ahead", "biome.json", "lane formatter.lineWidth: 100 -> 90 since the applied pin (local edit - port back, or declare it in allow)"],
    ],
  );
});

test("runChecks: a watched file removed from the lane since the pin is AHEAD", () => {
  const files = reactProject();
  delete files["biome.json"];
  const fix = fixture({ projects: { shougong: { frontend: { source: "react", files } } } });
  const { findings } = check(fix);
  assert.deepEqual(
    findings.map((f) => [f.severity, f.file, f.message]),
    [["ahead", "biome.json", "lane removed this file since the applied pin (local edit - port back, or declare it in allow)"]],
  );
});

test("runChecks: judgment entries are skipped", () => {
  const manifest = "entries:\n  src/index.css: judgment\ninstantiate:\n  name: template\n";
  const fix = fixture({
    manifests: { react: manifest },
    scaffoldFiles: { react: {} },
    projects: { chameidor: { frontend: { source: "react", files: {} } } },
  });
  assert.deepEqual(check(fix).findings, []);
});

test("runChecks: an allow on a queue entry keeps the finding visible but non-blocking", () => {
  const fix = fixture({
    projects: {
      chameidor: {
        frontend: {
          source: "react",
          allow: [{ entry: "biome.json", reason: "divergence by design" }],
          files: reactProject(),
        },
      },
    },
  });
  advanceScaffold(fix, "react", { "biome.json": '{ "formatter": { "lineWidth": 120 } }\n' });
  const { findings } = check(fix);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].allowed, true);
  const formatted = formatFindings(findings);
  assert.equal(formatted.exitCode, 0);
  const output = formatted.lines.join("\n");
  assert.match(output, /\[DRIFT\] chameidor\/frontend\/biome\.json/);
  assert.match(output, /0 blocking, 1 allowed/);
});

test("runChecks: merge sections substitute the token and report both views", () => {
  const pythonManifest = "entries:\n  pyproject.toml:\n    class: merge\n    sections:\n      - tool.importlinter\ninstantiate:\n  name: template\n";
  const scaffold = '[tool.importlinter]\nroot_package = "template"\ncontainers = ["template"]\n';
  const renamed = '[tool.importlinter]\nroot_package = "shougong"\ncontainers = ["shougong"]\n';
  const diverged = '[tool.importlinter]\nroot_package = "other"\ncontainers = ["other"]\n';
  const make = (projectPyproject) =>
    fixture({
      manifests: { python: pythonManifest },
      scaffoldFiles: { python: { "pyproject.toml": scaffold } },
      projects: { shougong: { backend: { source: "python", files: { "pyproject.toml": projectPyproject } } } },
    });

  assert.deepEqual(check(make(renamed)).findings, []);
  // A leftover placeholder in the lane is a local divergence: only the scaffold side is substituted.
  const leftover = check(make(scaffold));
  assert.equal(leftover.findings.length, 1);
  assert.match(leftover.findings[0].message, /^lane \[tool\.importlinter\] differs from the applied pin:/);
  assert.equal(leftover.findings[0].severity, "ahead");

  const { findings } = check(make(diverged));
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /^lane \[tool\.importlinter\] differs from the applied pin:/);
});

test("runChecks: merge — a section that moved since the pin is queue drift", () => {
  const pythonManifest = "entries:\n  pyproject.toml:\n    class: merge\n    sections:\n      - tool.importlinter\ninstantiate:\n  name: template\n";
  const scaffold = '[tool.importlinter]\nroot_package = "template"\ncontainers = ["template"]\n';
  const fix = fixture({
    manifests: { python: pythonManifest },
    scaffoldFiles: { python: { "pyproject.toml": scaffold } },
    projects: {
      shougong: { backend: { source: "python", files: { "pyproject.toml": '[tool.importlinter]\nroot_package = "shougong"\ncontainers = ["shougong"]\n' } } },
    },
  });
  advanceScaffold(fix, "python", { "pyproject.toml": '[tool.importlinter]\nroot_package = "template"\ncontainers = ["template", "extra"]\n' });
  const { findings } = check(fix);
  assert.deepEqual(
    findings.map((f) => [f.severity, f.file, f.message]),
    [["drift", "pyproject.toml", 'scaffold [tool.importlinter] changed since the applied pin: containers = ["shougong"] | containers = ["shougong", "extra"]']],
  );
});

test("runChecks: restatements of a global rule are reported once per project", () => {
  const restating = "# chameidor\n\nNever commit secrets to the repository, and never print them in logs or summaries.\n";
  const fix = fixture({
    projects: {
      chameidor: { frontend: { source: "react", files: { ...reactProject(), "AGENTS.md": restating } } },
    },
    globalAgentsMd: GLOBAL_AGENTS,
  });
  const { findings } = check(fix);
  assert.deepEqual(
    findings.map((f) => [f.severity, f.dir, f.file]),
    [["restatement", "chameidor/frontend", "AGENTS.md"]],
  );

  const pointer = fixture({
    projects: {
      chameidor: {
        frontend: { source: "react", files: { ...reactProject(), "AGENTS.md": "# chameidor\n\nSee global AGENTS.md.\n" } },
      },
    },
    globalAgentsMd: GLOBAL_AGENTS,
  });
  assert.deepEqual(check(pointer).findings, []);
});

test("runChecks: missing manifest or scaffold file are config errors", () => {
  const unknownStack = fixture({
    projects: { chameidor: { frontend: { source: "ruby", files: reactProject() } } },
  });
  assert.throws(
    () => check(unknownStack),
    (error) => error instanceof ConfigError && /manifest missing/.test(error.message),
  );

  // The scaffold file must be gone from the history too: a working-tree removal alone is not a
  // config error (the queue reads HEAD).
  const missingScaffoldFile = fixture({
    projects: { chameidor: { frontend: { source: "react", files: reactProject() } } },
  });
  gitIn(missingScaffoldFile.environments, ["rm", "-q", "react/biome.json"]);
  gitIn(missingScaffoldFile.environments, ["commit", "-qm", "drop biome.json"]);
  assert.throws(
    () => check(missingScaffoldFile),
    (error) => error instanceof ConfigError && /scaffold file missing/.test(error.message),
  );
});

test("runChecks: an uncommitted scaffold edit is not a queue item", () => {
  const fix = fixture({
    projects: { chameidor: { frontend: { source: "react", files: reactProject() } } },
  });
  // The working tree moves, HEAD does not: the applier drains commits, so nothing is queued.
  writeFileSync(join(fix.environments, "react", "biome.json"), '{ "formatter": { "lineWidth": 120 } }\n');
  assert.deepEqual(check(fix).findings, []);
});

test("runChecks: an uncommitted scaffold removal is not a config error", () => {
  const fix = fixture({
    projects: { chameidor: { frontend: { source: "react", files: reactProject() } } },
  });
  rmSync(join(fix.environments, "react", "biome.json"));
  // HEAD still has it (the working-tree removal is uncommitted): no error, no queue item.
  assert.deepEqual(check(fix).findings, []);
});

test("runChecks: a sentinel without applied.scaffold_sha is a config error", () => {
  const fix = fixture({
    projects: { chameidor: { frontend: { source: "react", files: reactProject() } } },
  });
  writeFileSync(join(fix.root, "chameidor", ".salgadinhos", "frontend.yml"), "source: react\nlane: frontend\n");
  assert.throws(
    () => check(fix),
    (error) => error instanceof ConfigError && /applied\.scaffold_sha/.test(error.message),
  );
});

test("runChecks: an unresolvable pin is a config error", () => {
  const fix = fixture({
    projects: { chameidor: { frontend: { source: "react", files: reactProject() } } },
  });
  writeFileSync(
    join(fix.root, "chameidor", ".salgadinhos", "frontend.yml"),
    "source: react\nlane: frontend\napplied:\n  revision: 1\n  scaffold_sha: deadbee\n",
  );
  assert.throws(
    () => check(fix),
    (error) => error instanceof ConfigError && /cannot resolve/.test(error.message),
  );
});

// ---------------------------------------------------------------------------
// formatFindings / CLI
// ---------------------------------------------------------------------------

test("resolveRoots: default reads scaffolds from this checkout, siblings one level up", () => {
  const roots = resolveRoots("C:/code/environments/tools/template-check.mjs", {});
  assert.equal(roots.environmentsPath.replace(/\\/g, "/"), "C:/code/environments");
  assert.equal(roots.codeRoot.replace(/\\/g, "/"), "C:/code");
});

test("resolveRoots: --code-root is a self-contained tree", () => {
  const roots = resolveRoots("C:/code/environments/tools/template-check.mjs", { codeRoot: "C:/scratch/fixture" });
  assert.equal(roots.environmentsPath.replace(/\\/g, "/"), "C:/scratch/fixture/environments");
  assert.equal(roots.codeRoot.replace(/\\/g, "/"), "C:/scratch/fixture");
});

test("formatFindings: no findings exits 0 with the PR #33 line", () => {
  const formatted = formatFindings([]);
  assert.equal(formatted.exitCode, 0);
  assert.deepEqual(formatted.lines, ["template-check: no drift found."]);
});

function runCli(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
}

test("cli: queue drift blocks (exit 1), lane divergence does not, --project narrows", () => {
  const fix = fixture({
    projects: {
      chameidor: { frontend: { source: "react", files: reactProject() } },
      shougong: { frontend: { source: "react", files: reactProject() } },
    },
  });
  const target = advanceScaffold(fix, "react", { "biome.json": '{ "formatter": { "lineWidth": 120 } }\n' });
  // chameidor already absorbed the move: its pin is the target and its file matches it. shougong
  // stays pinned at v1, so the moved biome.json is a queue item for it.
  writeFileSync(
    join(fix.root, "chameidor", ".salgadinhos", "frontend.yml"),
    sentinelYaml({ source: "react", lane: "frontend", scaffoldSha: target }),
  );
  writeFileSync(join(fix.root, "chameidor", "frontend", "biome.json"), '{ "formatter": { "lineWidth": 120 } }\n');
  const blocked = runCli(["--code-root", fix.root, "--global-agents", fix.globalAgentsMd]);
  assert.equal(blocked.status, 1, `stdout: ${blocked.stdout}\nstderr: ${blocked.stderr}`);
  assert.match(blocked.stdout, /\[DRIFT\] shougong\/frontend\/biome\.json/);

  const filtered = runCli(["--code-root", fix.root, "--global-agents", fix.globalAgentsMd, "--project", "chameidor"]);
  assert.equal(filtered.status, 0, `stdout: ${filtered.stdout}\nstderr: ${filtered.stderr}`);
  assert.match(filtered.stdout, /no drift found/);
});

test("cli: config errors exit 2", () => {
  const fix = fixture({ projects: { chameidor: { frontend: { source: "ruby", files: reactProject() } } } });
  const result = runCli(["--code-root", fix.root, "--global-agents", fix.globalAgentsMd]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /\[template-check\]/);
});
