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

function sentinelYaml({ source, lane, allow = [], revision = 1 }) {
  let text = `source: ${source}\nlane: ${lane}\napplied:\n  revision: ${revision}\n  scaffold_sha: cade1a\n`;
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

// Builds a temp code root: an environments/ tree (manifest + scaffold files), the projects with
// their lane sentinels, and the salgadinhos global AGENTS.md (override with `globalAgentsMd`,
// or pass null to omit it).
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
  for (const [project, lanes] of Object.entries(projects)) {
    for (const [lane, spec] of Object.entries(lanes)) {
      files[`${project}/.salgadinhos/${lane}.yml`] = sentinelYaml({ source: spec.source, lane, allow: spec.allow });
      for (const [rel, content] of Object.entries(spec.files)) {
        files[`${project}/${lane}/${rel}`] = content;
      }
    }
  }
  if (globalAgentsMd != null) files["salgadinhos/global/AGENTS.md"] = globalAgentsMd;
  const root = makeTree(files);
  return {
    root,
    environments: join(root, "environments"),
    globalAgentsMd: join(root, "salgadinhos", "global", "AGENTS.md"),
  };
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
  assert.equal(manifest.instantiate.name, "template");
  assert.equal(manifest.check.command, "npm run check");
});

test("loadManifest: kotlin manifest watches detekt + the version catalog", () => {
  const manifest = loadManifest(join(REPO_ROOT, "kotlin", ".salgadinhos", "manifest.yml"));
  assert.equal(manifest.entries["config/detekt/config.yml"].class, "owned");
  assert.equal(manifest.entries["gradle/libs.versions.toml"].class, "pinned");
  assert.equal(manifest.instantiate.name, "template");
  assert.equal(manifest.check.command, "./gradlew compileKotlin compileTestKotlin detekt");
});

test("loadManifest: python manifest merges pyproject sections", () => {
  const manifest = loadManifest(join(REPO_ROOT, "python", ".salgadinhos", "manifest.yml"));
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

test("jsonDiff: keys only in scaffold are drift, keys only in project are ahead", () => {
  const [drift, ahead] = jsonDiff({ include: ["a"] }, { include: ["a", "b"] });
  assert.deepEqual(drift, []);
  assert.deepEqual(ahead, ["include.1"]);

  const [drift2, ahead2] = jsonDiff({ settings: { x: 1 } }, { settings: { y: 2 } });
  assert.deepEqual(ahead2, ["settings.y"]);
  assert.deepEqual(drift2, ["settings.x"]);

  const [drift3] = jsonDiff({ a: 1 }, { a: 2 });
  assert.deepEqual(drift3, ['a (scaffold 1 -> project 2)']);
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

test("runChecks: pinned deps report the PR #33 message shapes", () => {
  const fix = fixture({
    projects: {
      chameidor: {
        frontend: {
          source: "react",
          files: reactProject({
            "package.json": JSON.stringify(
              {
                dependencies: { react: "^19.0.0", "react-dom": "^19.0.0", "hanzi-writer": "^3.7.3" },
                devDependencies: { vitest: "^4.0.0" },
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
    [
      ["drift", "package.json", "@biomejs/biome: scaffold pins ^1.9.4, project does not have it"],
      ["drift", "package.json", "vitest: scaffold ^5.0.0 -> project ^4.0.0"],
    ],
  );
});

test("runChecks: owned JSON files diff structurally in both directions", () => {
  const fix = fixture({
    projects: {
      chameidor: {
        frontend: {
          source: "react",
          files: reactProject({
            "tsconfig.json": '{ "include": ["src"], "references": [{ "path": "./tsconfig.app.json" }] }\n',
            "tsconfig.node.json": '{ "include": [] }\n',
          }),
        },
      },
    },
  });
  const { findings } = check(fix);
  assert.deepEqual(
    findings.map((f) => [f.severity, f.file, f.message]),
    [
      ["ahead", "tsconfig.json", "project has references, scaffold does not (port back or add to scaffold)"],
      ["drift", "tsconfig.node.json", "scaffold has include.0, project does not"],
    ],
  );
});

test("runChecks: a missing watched file in the project is drift", () => {
  const files = reactProject();
  delete files["biome.json"];
  const fix = fixture({ projects: { shougong: { frontend: { source: "react", files } } } });
  const { findings } = check(fix);
  assert.deepEqual(
    findings.map((f) => [f.severity, f.file, f.message]),
    [["drift", "biome.json", "missing in project, present in scaffold"]],
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

test("runChecks: sentinel allow marks the finding but it stops blocking", () => {
  const fix = fixture({
    projects: {
      chameidor: {
        frontend: {
          source: "react",
          allow: [{ entry: "biome.json", reason: "divergence by design" }],
          files: reactProject({ "biome.json": '{ "formatter": { "lineWidth": 90 } }\n' }),
        },
      },
    },
  });
  const { findings } = check(fix);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].allowed, true);
  const formatted = formatFindings(findings);
  assert.equal(formatted.exitCode, 0);
  const output = formatted.lines.join("\n");
  assert.match(output, /\[DRIFT\] chameidor\/frontend\/biome\.json/);
  assert.match(output, /0 blocking, 1 allowed/);
});

test("runChecks: merge sections substitute the instantiate placeholder in the scaffold", () => {
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
  // A leftover placeholder in the project is drift: only the scaffold side is substituted.
  const leftover = check(make(scaffold));
  assert.equal(leftover.findings.length, 1);
  assert.match(leftover.findings[0].message, /^\[tool\.importlinter\] differs:/);

  const { findings } = check(make(diverged));
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /^\[tool\.importlinter\] differs:/);
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

  const missingScaffoldFile = fixture({
    projects: { chameidor: { frontend: { source: "react", files: reactProject() } } },
  });
  rmSync(join(missingScaffoldFile.environments, "react", "biome.json"));
  assert.throws(
    () => check(missingScaffoldFile),
    (error) => error instanceof ConfigError && /scaffold file missing/.test(error.message),
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

test("cli: reports findings, exits 1 on blocking drift and honors --project", () => {
  const fix = fixture({
    projects: {
      chameidor: { frontend: { source: "react", files: reactProject() } },
      shougong: {
        frontend: { source: "react", files: reactProject({ "biome.json": '{ "formatter": { "lineWidth": 90 } }\n' }) },
      },
    },
  });
  const blocked = runCli(["--code-root", fix.root, "--global-agents", fix.globalAgentsMd]);
  assert.equal(blocked.status, 1);
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
