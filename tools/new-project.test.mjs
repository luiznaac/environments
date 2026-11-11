import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { ConfigError, loadManifest, parseYamlLite } from "./template-check.mjs";
import {
  applyValueOverrides,
  fillValue,
  findTokenLeftovers,
  replaceJsonTokenValues,
  resolveCheckCommand,
  rewriteProjectManifest,
  sentinelText,
} from "./new-project.mjs";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SCRIPT = join(REPO_ROOT, "tools", "new-project.mjs");

function makeTree(files) {
  const root = mkdtempSync(join(tmpdir(), "new-project-"));
  for (const [rel, content] of Object.entries(files)) {
    const path = join(root, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  return root;
}

function manifest(text) {
  const root = makeTree({ "manifest.yml": text });
  return join(root, "manifest.yml");
}

// ---------------------------------------------------------------------------
// Manifest: the instantiate section
// ---------------------------------------------------------------------------

test("loadManifest: reads lane, check, keep and value overrides from instantiate", () => {
  const path = manifest(`
entries:
  vite.config.ts: owned
instantiate:
  name: template
  lane: frontend
  check: npm run check
  keep:
    - AGENTS.md
  values:
    basePath:
      replacements:
        vite.config.ts:
          - /template/
`);
  const { instantiate } = loadManifest(path);
  assert.equal(instantiate.name, "template");
  assert.equal(instantiate.lane, "frontend");
  assert.equal(instantiate.check, "npm run check");
  assert.deepEqual(instantiate.keep, ["AGENTS.md"]);
  assert.deepEqual(instantiate.values, {
    basePath: { replacements: { "vite.config.ts": ["/template/"] } },
  });
});

test("loadManifest: instantiate defaults to nulls and empty lists when absent", () => {
  const path = manifest("entries:\n  biome.json: owned\ninstantiate:\n  name: template\n");
  const { instantiate } = loadManifest(path);
  assert.deepEqual(instantiate, { name: "template", lane: null, check: null, keep: [], values: {} });
});

test("loadManifest: value defaults and styles are kept as declared", () => {
  const path = manifest(`
instantiate:
  name: template
  values:
    port:
      default: "8080"
      replacements:
        application.yaml:
          - "8080"
    image:
      style: whole
      replacements:
        .github/workflows/docker-publish.yml:
          - luiznaac/template
`);
  const { values } = loadManifest(path).instantiate;
  assert.deepEqual(values.port, { default: "8080", replacements: { "application.yaml": ["8080"] } });
  assert.deepEqual(values.image, {
    style: "whole",
    replacements: { ".github/workflows/docker-publish.yml": ["luiznaac/template"] },
  });
});

test("loadManifest: php-style instantiate with only a null name still loads", () => {
  const path = manifest("entries: {}\ninstantiate:\n  name: null\n  lane: null\n");
  const { instantiate } = loadManifest(path);
  assert.deepEqual(instantiate, { name: null, lane: null, check: null, keep: [], values: {} });
});

test("loadManifest: malformed instantiate fields are config errors", () => {
  const cases = [
    ["lane: [a]", /'instantiate\.lane' must be a string/],
    ["check:\n    - x", /'instantiate\.check' must be a string/],
    ["keep:\n    key: value", /'instantiate\.keep' must be a list/],
    ["keep:\n    - key: value", /'instantiate\.keep' must be a list of strings/],
    ["values: [a]", /'instantiate\.values' must be a map/],
    ["values:\n    port: [a]", /'instantiate\.values\.port' must be a map/],
    ["values:\n    port:\n      replacements: x", /'instantiate\.values\.port\.replacements' must be a map/],
    ["values:\n    port:\n      default: [a]", /'instantiate\.values\.port\.default' must be a string/],
    ["values:\n    port:\n      style: magic\n      replacements:\n        app.yaml:\n          - x", /'instantiate\.values\.port\.style' must be 'token' or 'whole'/],
    ["values:\n    port:\n      replacements:\n        app.yaml: x", /'instantiate\.values\.port\.replacements\.app\.yaml' must be a list of strings/],
    ["values:\n    port:\n      replacements:\n        app.yaml:\n          - key: value", /'instantiate\.values\.port\.replacements\.app\.yaml' must be a list of strings/],
    ["values:\n    port:\n      default: '8080'", /'instantiate\.values\.port' needs 'replacements'/],
    ["values:\n    port:\n      replacements: {}", /'instantiate\.values\.port' needs 'replacements'/],
    [
      "values:\n    mysqlPort:\n      replacements:\n        app.yaml:\n          - '{{value}}:3306'",
      /'instantiate\.values\.mysqlPort' uses '\{\{value\}\}' but declares no 'default'/,
    ],
  ];
  for (const [body, pattern] of cases) {
    const path = manifest(`instantiate:\n  name: template\n  ${body}\n`);
    assert.throws(
      () => loadManifest(path),
      (error) => error instanceof ConfigError && pattern.test(error.message),
      `expected ${JSON.stringify(body)} to fail with ${pattern}`,
    );
  }
});

// ---------------------------------------------------------------------------
// Rewrites: the token in text, in JSON values, and the value overrides
// ---------------------------------------------------------------------------

test("replaceJsonTokenValues: renames package-name values, leaves scoped dependency metadata", () => {
  const value = {
    name: "template-fe",
    version: "0.1.0",
    packages: {
      "": { name: "template-fe", version: "0.1.0" },
      "node_modules/@babel/template": {
        name: "@babel/template",
        resolved: "https://registry.npmjs.org/@babel/template/-/template-7.29.7.tgz",
      },
      "node_modules/@types/babel__template": { name: "@types/babel__template" },
      "node_modules/react": { name: "react" },
    },
  };
  const { value: out, changed } = replaceJsonTokenValues(value, "template", "widget");
  assert.equal(changed, true);
  assert.equal(out.name, "widget-fe");
  assert.equal(out.packages[""].name, "widget-fe");
  assert.equal(out.packages["node_modules/@babel/template"].name, "@babel/template");
  assert.equal(
    out.packages["node_modules/@babel/template"].resolved,
    "https://registry.npmjs.org/@babel/template/-/template-7.29.7.tgz",
  );
  assert.equal(out.packages["node_modules/@types/babel__template"].name, "@types/babel__template");
  assert.ok("node_modules/@babel/template" in out.packages, "keys are never rewritten");
});

test("replaceJsonTokenValues: an exact token value is a package name too", () => {
  const { value: out, changed } = replaceJsonTokenValues({ name: "template" }, "template", "widget");
  assert.equal(changed, true);
  assert.equal(out.name, "widget");
});

test("replaceJsonTokenValues: reports when nothing changed", () => {
  const input = { dependencies: { react: "^19.0.0" } };
  const { changed } = replaceJsonTokenValues(input, "template", "widget");
  assert.equal(changed, false);
});

test("resolveCheckCommand: Windows runs ./gradlew through PATHEXT, POSIX keeps it", () => {
  assert.equal(resolveCheckCommand("./gradlew clean build", "win32"), "gradlew clean build");
  assert.equal(resolveCheckCommand("cd x && ./gradlew test", "win32"), "cd x && gradlew test");
  assert.equal(resolveCheckCommand("./gradlew clean build", "linux"), "./gradlew clean build");
  assert.equal(resolveCheckCommand("uv run poe check", "win32"), "uv run poe check");
});

test("findTokenLeftovers: word hits in text, package metadata in JSON, keeps are exempt", () => {
  const root = makeTree({
    "src/template/app.py": "import template.util\n",
    "db/schema.sql": "USE template;\n",
    "package-lock.json": JSON.stringify(
      {
        name: "template-fe",
        packages: { "node_modules/@babel/template": { name: "@babel/template" } },
      },
      null,
      2,
    ),
    "AGENTS.md": "this file keeps the template word on purpose\n",
  });
  const leftovers = findTokenLeftovers(root, { token: "template", keep: ["AGENTS.md"] });
  assert.deepEqual(
    leftovers.map((hit) => `${hit.file}:${hit.line}`),
    ["db/schema.sql:1", "package-lock.json:2", "src/template/app.py:1"],
  );
  assert.match(leftovers[1].text, /template-fe/);
});

test("findTokenLeftovers: a clean tree reports nothing", () => {
  const root = makeTree({
    "src/widget/app.py": "import widget.util\n",
    "package-lock.json": JSON.stringify({ name: "widget-fe", packages: { "@babel/template": { name: "@babel/template" } } }),
  });
  assert.deepEqual(findTokenLeftovers(root, { token: "template", keep: [] }), []);
});

test("applyValueOverrides: swaps declared literals per file and leaves undeclared files alone", () => {
  const root = makeTree({
    "application.yaml": "ktor:\n  port: 8080\n",
    "docker-compose.yml": "- MYSQL_DATABASE=template\n",
    "uv.lock": 'url = "https://example.test/8080806c.whl"\n',
  });
  const applied = applyValueOverrides(root, {
    token: "template",
    values: {
      port: { default: "8080", replacements: { "application.yaml": ["8080"] } },
      db: { replacements: { "docker-compose.yml": ["MYSQL_DATABASE=template"] } },
    },
    overrides: { port: "9000", db: "widget_db" },
  });
  assert.deepEqual(applied, ["port", "db"]);
  assert.equal(readFileSync(join(root, "application.yaml"), "utf8"), "ktor:\n  port: 9000\n");
  assert.equal(readFileSync(join(root, "docker-compose.yml"), "utf8"), "- MYSQL_DATABASE=widget_db\n");
  assert.equal(readFileSync(join(root, "uv.lock"), "utf8"), 'url = "https://example.test/8080806c.whl"\n');
});

test("applyValueOverrides: no overrides means no writes", () => {
  const root = makeTree({ "application.yaml": "ktor:\n  port: 8080\n" });
  const applied = applyValueOverrides(root, {
    token: "template",
    values: { port: { default: "8080", replacements: { "application.yaml": ["8080"] } } },
    overrides: {},
  });
  assert.deepEqual(applied, []);
  assert.equal(readFileSync(join(root, "application.yaml"), "utf8"), "ktor:\n  port: 8080\n");
});

test("applyValueOverrides: {{value}} in a literal keeps the surrounding context", () => {
  const root = makeTree({ "docker-compose.yml": 'services:\n  mysql:\n    ports:\n      - "3306:3306"\n' });
  const applied = applyValueOverrides(root, {
    token: "template",
    values: { mysqlPort: { default: "3306", replacements: { "docker-compose.yml": ['"{{value}}:3306"'] } } },
    overrides: { mysqlPort: "8112" },
  });
  assert.deepEqual(applied, ["mysqlPort"]);
  assert.equal(
    readFileSync(join(root, "docker-compose.yml"), "utf8"),
    'services:\n  mysql:\n    ports:\n      - "8112:3306"\n',
  );
});

test("applyValueOverrides: a literal without {{value}} still replaces wholesale", () => {
  const root = makeTree({ "app.env": "API=8080\nPROXY=http://localhost:8080\n" });
  applyValueOverrides(root, {
    token: "template",
    values: { port: { default: "8080", replacements: { "app.env": ["8080"] } } },
    overrides: { port: "8110" },
  });
  assert.equal(readFileSync(join(root, "app.env"), "utf8"), "API=8110\nPROXY=http://localhost:8110\n");
});

test("applyValueOverrides: port values run before the other values", () => {
  const root = makeTree({ "migration.kt": "jdbc:mysql://localhost:3306/template\n" });
  applyValueOverrides(root, {
    token: "template",
    values: {
      db: { replacements: { "migration.kt": ["/template"] } },
      mysqlPort: { default: "3306", replacements: { "migration.kt": ["{{value}}/template"] } },
    },
    overrides: { db: "widget_db", mysqlPort: "8112" },
  });
  assert.equal(readFileSync(join(root, "migration.kt"), "utf8"), "jdbc:mysql://localhost:8112/widget_db\n");
});

test("applyValueOverrides: whole-style values replace the literal entirely", () => {
  const root = makeTree({ "docker-publish.yml": "images: luiznaac/template\n" });
  const applied = applyValueOverrides(root, {
    token: "template",
    values: { image: { style: "whole", replacements: { "docker-publish.yml": ["luiznaac/template"] } } },
    overrides: { image: "luiznaac/custom" },
  });
  assert.deepEqual(applied, ["image"]);
  assert.equal(readFileSync(join(root, "docker-publish.yml"), "utf8"), "images: luiznaac/custom\n");
});

// ---------------------------------------------------------------------------
// Manifest copy and sentinel
// ---------------------------------------------------------------------------

test("rewriteProjectManifest: keeps entries, drops instantiate, never leaves the token", () => {
  const entries = {
    "biome.json": { file: "biome.json", class: "owned" },
    "package.json": { file: "package.json", class: "pinned", pins: ["react", "@tanstack/react-query"] },
    "pyproject.toml": { file: "pyproject.toml", class: "merge", sections: ["tool.ruff", "tool.mypy"] },
  };
  const text = rewriteProjectManifest({ entries });
  const path = join(makeTree({ "manifest.yml": text }), "manifest.yml");
  assert.deepEqual(loadManifest(path).entries, entries);
  assert.doesNotMatch(text, /instantiate/);
  assert.doesNotMatch(text, /\btemplate\b/);
});

test("sentinelText: stamps source, lane and the creation revision with the scaffold sha", () => {
  const parsed = parseYamlLite(sentinelText({ source: "kotlin", lane: "backend", scaffoldSha: "9f3c1ab" }));
  assert.equal(parsed.source, "kotlin");
  assert.equal(parsed.lane, "backend");
  assert.equal(parsed.applied.revision, "1");
  assert.equal(parsed.applied.scaffold_sha, "9f3c1ab");
  assert.deepEqual(parsed.allow, []);
});

// ---------------------------------------------------------------------------
// CLI: creation end to end (fixture stack)
// ---------------------------------------------------------------------------

const MINI_MANIFEST = `
entries:
  src/app.py: owned
  package.json: pinned
instantiate:
  name: template
  lane: backend
  check: node -e "require('fs').writeFileSync('check-ran.txt', process.cwd())"
  keep:
    - gradlew
  values:
    db:
      replacements:
        db.txt:
          - MYSQL_DATABASE=template
    port:
      default: "8080"
      replacements:
        port.txt:
          - "8080"
`;

const MINI_FILES = {
  "src/template/app.py": "package template.app\n",
  "src/template/util/helper.py": "helper for template\n",
  "db.txt": "MYSQL_DATABASE=template\n",
  "port.txt": "port 8080\n",
  "gradlew": "generated from the Groovy template\n",
  "package.json": JSON.stringify(
    { name: "template-fe", dependencies: { "@babel/template": "^7.29.7", react: "^19.0.0" } },
    null,
    2,
  ),
  "AGENTS.md": "the scaffold doc mentions template in prose\n",
};

function git(dir, args) {
  const result = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function initGit(dir) {
  git(dir, ["init", "-q", "-b", "master"]);
  git(dir, ["add", "-A"]);
  git(dir, ["-c", "user.name=test", "-c", "user.email=test@example.test", "commit", "-q", "-m", "init"]);
  return git(dir, ["rev-parse", "HEAD"]);
}

// A self-contained code root: environments/mini scaffold, optional sibling project composes and
// an optional fake salgadinhos installer. The environments tree is a real git repo so the
// sentinel can pin its HEAD.
function miniCodeRoot({ manifest: manifestText = MINI_MANIFEST, files = MINI_FILES, siblings = {}, installer = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), "new-project-"));
  const write = (rel, content) => {
    const path = join(root, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  };
  write("environments/mini/.salgadinhos/manifest.yml", manifestText);
  for (const [rel, content] of Object.entries(files)) write(`environments/mini/${rel}`, content);
  for (const [name, content] of Object.entries(siblings)) write(`${name}/docker-compose.yml`, content);
  if (installer !== null) write("salgadinhos/adapters/install.mjs", installer);
  return { root, sha: initGit(join(root, "environments")) };
}

function runCli(codeRoot, args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: codeRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.test",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.test",
    },
  });
}

const createArgs = (fix, extra = []) => ["--code-root", fix.root, "--stack", "mini", "--name", "widget", ...extra];

test("cli: creates the lane, renaming paths, contents and JSON package names", () => {
  const fix = miniCodeRoot();
  const result = runCli(fix.root, createArgs(fix, ["--skip-check", "--skip-guard"]));
  assert.equal(result.status, 0, result.stderr);
  const lane = join(fix.root, "widget", "backend");
  assert.ok(existsSync(join(lane, "src", "widget", "util", "helper.py")), "directories carrying the token are renamed");
  assert.equal(readFileSync(join(lane, "src", "widget", "app.py"), "utf8"), "package widget.app\n");
  assert.equal(readFileSync(join(lane, "db.txt"), "utf8"), "MYSQL_DATABASE=widget\n");
  assert.equal(readFileSync(join(lane, "gradlew"), "utf8"), "generated from the Groovy template\n", "keep files are untouched");
  assert.equal(readFileSync(join(lane, "AGENTS.md"), "utf8"), "the scaffold doc mentions widget in prose\n");
  const pkg = JSON.parse(readFileSync(join(lane, "package.json"), "utf8"));
  assert.equal(pkg.name, "widget-fe");
  assert.equal(pkg.dependencies["@babel/template"], "^7.29.7", "scoped dependency metadata is not a placeholder");
});

test("cli: keeps an executable file's mode in the created lane", () => {
  const fix = miniCodeRoot();
  const environments = join(fix.root, "environments");
  git(environments, ["update-index", "--chmod=+x", "mini/gradlew"]);
  git(environments, ["-c", "user.name=test", "-c", "user.email=test@example.test", "commit", "-q", "-m", "chmod gradlew"]);
  assert.equal(runCli(fix.root, createArgs(fix, ["--skip-check", "--skip-guard"])).status, 0);
  if (process.platform !== "win32") {
    assert.match(git(join(fix.root, "widget", "backend"), ["ls-files", "-s", "--", "gradlew"]), /^100755 /);
  }
});

test("cli: the project manifest keeps the entries and drops instantiate", () => {
  const fix = miniCodeRoot();
  assert.equal(runCli(fix.root, createArgs(fix, ["--skip-check", "--skip-guard"])).status, 0);
  const copied = loadManifest(join(fix.root, "widget", "backend", ".salgadinhos", "manifest.yml"));
  const original = loadManifest(join(fix.root, "environments", "mini", ".salgadinhos", "manifest.yml"));
  assert.deepEqual(copied.entries, original.entries);
  assert.deepEqual(copied.instantiate, { name: null, lane: null, check: null, keep: [], values: {} });
  assert.doesNotMatch(readFileSync(join(fix.root, "widget", "backend", ".salgadinhos", "manifest.yml"), "utf8"), /\btemplate\b/);
});

test("cli: stamps the lane sentinel with source, lane, revision 1 and the scaffold sha", () => {
  const fix = miniCodeRoot();
  assert.equal(runCli(fix.root, createArgs(fix, ["--skip-check", "--skip-guard"])).status, 0);
  const parsed = parseYamlLite(readFileSync(join(fix.root, "widget", ".salgadinhos", "backend.yml"), "utf8"));
  assert.deepEqual(parsed, {
    source: "mini",
    lane: "backend",
    applied: { revision: "1", scaffold_sha: fix.sha },
    allow: [],
  });
});

test("cli: commits the created project as the first commit on master", () => {
  const fix = miniCodeRoot();
  assert.equal(runCli(fix.root, createArgs(fix, ["--skip-check", "--skip-guard"])).status, 0);
  const project = join(fix.root, "widget");
  assert.equal(git(project, ["rev-list", "--count", "HEAD"]), "1");
  assert.equal(git(project, ["rev-parse", "--abbrev-ref", "HEAD"]), "master");
  assert.match(git(project, ["log", "-1", "--format=%s"]), /widget/);
});

test("cli: text files are copied LF-canonical and batch files keep their ending", () => {
  const fix = miniCodeRoot({ files: { ...MINI_FILES, "crlf.txt": "a\r\nb\r\n", "run.bat": "@echo off\r\necho template\r\n" } });
  assert.equal(runCli(fix.root, createArgs(fix, ["--skip-check", "--skip-guard"])).status, 0);
  const lane = join(fix.root, "widget", "backend");
  assert.equal(readFileSync(join(lane, "crlf.txt"), "utf8"), "a\nb\n");
  assert.equal(readFileSync(join(lane, "run.bat"), "utf8"), "@echo off\r\necho widget\r\n");
});

test("cli: runs the fast check in the created lane", () => {
  const fix = miniCodeRoot();
  const result = runCli(fix.root, createArgs(fix, ["--skip-guard"]));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(fix.root, "widget", "backend", "check-ran.txt"), "utf8"), join(fix.root, "widget", "backend"));
});

test("cli: a failing fast check aborts creation before the first commit", () => {
  const fix = miniCodeRoot({ manifest: MINI_MANIFEST.replace(/check: .*/, 'check: node -e "process.exit(3)"') });
  const result = runCli(fix.root, createArgs(fix, ["--skip-guard"]));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /fast check failed/);
  assert.ok(!existsSync(join(fix.root, "widget", ".git")), "nothing is committed when the check is not green");
});

test("cli: refuses an override the stack does not declare", () => {
  const fix = miniCodeRoot();
  const result = runCli(fix.root, createArgs(fix, ["--image", "luiznaac/widget", "--skip-check", "--skip-guard"]));
  assert.equal(result.status, 2);
  assert.match(result.stderr, /no 'image' value to override/);
});

test("cli: --lane overrides the manifest lane and names the sentinel after it", () => {
  const fix = miniCodeRoot();
  const result = runCli(fix.root, createArgs(fix, ["--lane", "apps/api", "--skip-check", "--skip-guard"]));
  assert.equal(result.status, 0, result.stderr);
  assert.ok(existsSync(join(fix.root, "widget", "apps", "api", "db.txt")));
  const parsed = parseYamlLite(readFileSync(join(fix.root, "widget", ".salgadinhos", "apps-api.yml"), "utf8"));
  assert.equal(parsed.lane, "apps/api");
});

test("cli: refuses a stack without an instantiate name (php deferred)", () => {
  const scratch = mkdtempSync(join(tmpdir(), "new-project-"));
  const result = runCli(REPO_ROOT, ["--stack", "php", "--name", "widget", "--to", join(scratch, "widget"), "--skip-check", "--skip-guard"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /no instantiate\.name/);
});

test("cli: refuses a non-empty target unless --force", () => {
  const fix = miniCodeRoot();
  mkdirSync(join(fix.root, "widget"), { recursive: true });
  writeFileSync(join(fix.root, "widget", "keep.txt"), "occupied\n");
  const refused = runCli(fix.root, createArgs(fix, ["--skip-check", "--skip-guard"]));
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /not empty/);
  const forced = runCli(fix.root, createArgs(fix, ["--skip-check", "--skip-guard", "--force"]));
  assert.equal(forced.status, 0, forced.stderr);
  assert.ok(existsSync(join(fix.root, "widget", "backend", "db.txt")));
});

test("cli: a host-port collision with a sibling app is refused unless --port overrides it", () => {
  const fix = miniCodeRoot({ siblings: { other: 'services:\n  app:\n    ports:\n      - "8080:8080"\n' } });
  const refused = runCli(fix.root, createArgs(fix, ["--skip-check", "--skip-guard"]));
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /8080/);
  assert.match(refused.stderr, /other/);
  const chosen = runCli(fix.root, createArgs(fix, ["--skip-check", "--skip-guard", "--port", "9000"]));
  assert.equal(chosen.status, 0, chosen.stderr);
  assert.equal(readFileSync(join(fix.root, "widget", "backend", "port.txt"), "utf8"), "port 9000\n");
});

test("cli: a lane compose with a long-form published port is a collision too", () => {
  const fix = miniCodeRoot();
  const lane = join(fix.root, "mono", "backend");
  mkdirSync(lane, { recursive: true });
  writeFileSync(join(lane, "docker-compose.yml"), 'services:\n  db:\n    ports:\n      - published: "8080"\n');
  const refused = runCli(fix.root, createArgs(fix, ["--skip-check", "--skip-guard"]));
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /mono/);
});

test("cli: a port literal carrying the token is substituted before the name pass", () => {
  const fix = miniCodeRoot({
    manifest: `
entries: {}
instantiate:
  name: template
  lane: backend
  values:
    db:
      replacements:
        conn.txt:
          - /template
    mysqlPort:
      default: "3306"
      replacements:
        conn.txt:
          - "{{value}}/template"
`,
    files: { "conn.txt": "jdbc:mysql://localhost:3306/template\n" },
  });
  const result = runCli(fix.root, createArgs(fix, ["--db", "widget_db", "--mysql-port", "8112", "--skip-check", "--skip-guard"]));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    readFileSync(join(fix.root, "widget", "backend", "conn.txt"), "utf8"),
    "jdbc:mysql://localhost:8112/widget_db\n",
  );
});

test("cli: a non-numeric port role override is refused", () => {
  const fix = miniCodeRoot({
    manifest: `
entries: {}
instantiate:
  name: template
  lane: backend
  values:
    mysqlPort:
      default: "3306"
      replacements:
        conn.txt:
          - "{{value}}"
`,
    files: { "conn.txt": "3306\n" },
  });
  const result = runCli(fix.root, createArgs(fix, ["--mysql-port", "abc", "--skip-check", "--skip-guard"]));
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--mysql-port must be a number/);
});

test("cli: installs the master guard through salgadinhos' installer after the commit", () => {
  const installer = 'import { writeFileSync } from "node:fs";\nwriteFileSync("ran.txt", process.argv.slice(2).join(" "));\n';
  const fix = miniCodeRoot({ installer });
  const result = runCli(fix.root, createArgs(fix, ["--skip-check"]));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(fix.root, "salgadinhos", "ran.txt"), "utf8"), `--install-repo ${join(fix.root, "widget")}`);
});

// ---------------------------------------------------------------------------
// Committed manifests and the real scaffolds
// ---------------------------------------------------------------------------

// The real scaffolds are read through a junction so the code root is a scratch dir with no
// siblings to collide with.
function realCodeRoot() {
  const root = mkdtempSync(join(tmpdir(), "new-project-real-"));
  symlinkSync(REPO_ROOT, join(root, "environments"), "junction");
  return root;
}

test("committed manifests: the live scaffolds declare the creation data", () => {
  const kotlin = loadManifest(join(REPO_ROOT, "kotlin", ".salgadinhos", "manifest.yml")).instantiate;
  assert.equal(kotlin.lane, "backend");
  assert.equal(kotlin.check, "./gradlew clean build");
  assert.deepEqual(kotlin.keep, [".salgadinhos/manifest.yml", "config/detekt/config.yml", "gradlew", "gradlew.bat"]);
  assert.deepEqual(Object.keys(kotlin.values).sort(), ["db", "image", "mysqlPort", "port"]);
  assert.deepEqual(kotlin.values.db.replacements[".env.example"], ["MYSQL_DATABASE=template"]);
  assert.equal(kotlin.values.port.default, "8080");
  assert.equal(kotlin.values.mysqlPort.default, "3306");
  assert.equal(kotlin.values.image.style, "whole", "the image override is the full image reference");

  const python = loadManifest(join(REPO_ROOT, "python", ".salgadinhos", "manifest.yml")).instantiate;
  assert.equal(python.lane, "backend");
  assert.equal(python.check, "uv run poe check");
  assert.deepEqual(python.keep, []);
  assert.deepEqual(Object.keys(python.values).sort(), ["db", "image", "mysqlPort", "port"]);
  assert.equal(python.values.port.default, "8080");
  assert.equal(python.values.mysqlPort.default, "3306");
  assert.equal(python.values.image.style, "whole");

  const react = loadManifest(join(REPO_ROOT, "react", ".salgadinhos", "manifest.yml")).instantiate;
  assert.equal(react.lane, "frontend");
  assert.equal(react.check, "npm ci && npm run check");
  assert.deepEqual(react.keep, []);
  assert.deepEqual(Object.keys(react.values), ["port", "frontendDevPort", "basePath"]);
  assert.equal(react.values.port.default, "8080");
  assert.equal(react.values.frontendDevPort.default, "5273");
  assert.equal(react.values.basePath.style, "whole", "the base path override is the full path");
});

test("committed manifests: compose and env files are judgment entries and stale literals are gone", () => {
  for (const stack of ["kotlin", "python"]) {
    const manifest = loadManifest(join(REPO_ROOT, stack, ".salgadinhos", "manifest.yml"));
    assert.equal(manifest.entries["docker-compose.yml"].class, "judgment", `${stack}: compose is a judgment entry`);
    assert.equal(manifest.entries[".env.example"].class, "judgment", `${stack}: the env example is a judgment entry`);
  }
  const kotlin = loadManifest(join(REPO_ROOT, "kotlin", ".salgadinhos", "manifest.yml")).instantiate;
  assert.ok(
    !("integrationTest/src/test/kotlin/dev/agner/template/integrationTest/config/HttpRequestService.kt" in
      kotlin.values.port.replacements),
    "the harness derives its port now, so the HttpRequestService literal is gone",
  );
  const python = loadManifest(join(REPO_ROOT, "python", ".salgadinhos", "manifest.yml")).instantiate;
  assert.ok(!("Dockerfile" in python.values.port.replacements), "the container-internal Dockerfile port is gone");
  assert.ok(!("pyproject.toml" in python.values.port.replacements), "the stale pyproject --port literal is gone");
});

test("committed manifests: every declared literal exists in the file it names", () => {
  for (const stack of ["kotlin", "python", "react"]) {
    const { values } = loadManifest(join(REPO_ROOT, stack, ".salgadinhos", "manifest.yml")).instantiate;
    for (const [key, spec] of Object.entries(values)) {
      for (const [file, literals] of Object.entries(spec.replacements)) {
        const abs = join(REPO_ROOT, stack, file);
        assert.ok(existsSync(abs), `${stack}: values.${key} names a missing file ${file}`);
        const text = readFileSync(abs, "utf8");
        for (const literal of literals) {
          const searchable =
            literal.includes("{{value}}") && spec.default !== undefined
              ? fillValue(literal, spec.default)
              : literal;
          assert.ok(text.includes(searchable), `${stack}: values.${key} declares '${literal}', absent from ${file}`);
        }
      }
    }
  }
});

test("real scaffold: kotlin creates a renamed lane with the manifest copy and the sentinel", () => {
  const root = realCodeRoot();
  const result = runCli(root, ["--code-root", root, "--stack", "kotlin", "--name", "widget", "--skip-check", "--skip-guard"]);
  assert.equal(result.status, 0, result.stderr);
  const lane = join(root, "widget", "backend");
  assert.match(readFileSync(join(lane, "settings.gradle.kts"), "utf8"), /rootProject\.name = "widget"/);
  assert.match(readFileSync(join(lane, "build.gradle.kts"), "utf8"), /group = "dev\.agner\.widget"/);
  assert.match(readFileSync(join(lane, "docker-compose.yml"), "utf8"), /MYSQL_DATABASE=widget/);
  assert.match(readFileSync(join(lane, ".env.example"), "utf8"), /MYSQL_DATABASE=widget/);
  assert.ok(existsSync(join(lane, "usecase", "src", "main", "kotlin", "dev", "agner", "widget", "usecase", "commons", "CommonExtensions.kt")));
  assert.match(readFileSync(join(lane, "config", "detekt", "config.yml"), "utf8"), /licenseTemplateFile: 'license\.template'/, "keep files are untouched");
  assert.match(readFileSync(join(lane, "gradlew"), "utf8"), /Groovy template/, "keep files are untouched");
  if (process.platform !== "win32") {
    assert.notEqual(statSync(join(lane, "gradlew")).mode & 0o111, 0, "the committed wrapper is executable");
  }
  assert.deepEqual(
    loadManifest(join(lane, ".salgadinhos", "manifest.yml")).entries,
    loadManifest(join(REPO_ROOT, "kotlin", ".salgadinhos", "manifest.yml")).entries,
  );
  assert.equal(readFileSync(join(root, "widget", ".salgadinhos", "backend.yml"), "utf8").includes("source: kotlin"), true);
});

test("real scaffold: python creates a renamed lane", () => {
  const root = realCodeRoot();
  const result = runCli(root, ["--code-root", root, "--stack", "python", "--name", "widget", "--skip-check", "--skip-guard"]);
  assert.equal(result.status, 0, result.stderr);
  const lane = join(root, "widget", "backend");
  assert.ok(existsSync(join(lane, "src", "widget", "application", "boot.py")));
  const pyproject = readFileSync(join(lane, "pyproject.toml"), "utf8");
  assert.match(pyproject, /^name = "widget"/m);
  assert.match(pyproject, /packages = \["src\/widget"\]/);
  assert.match(pyproject, /root_package = "widget"/);
  assert.match(readFileSync(join(lane, "uv.lock"), "utf8"), /^name = "widget"$/m);
  assert.match(readFileSync(join(lane, ".env.example"), "utf8"), /MYSQL__DATABASE=widget/);
  assert.match(readFileSync(join(lane, "Dockerfile"), "utf8"), /uvicorn", "widget\.application\.boot:app"/);
});

test("real scaffold: react creates a renamed lane with scoped dependency metadata and the sandbox install pointer", () => {
  const root = realCodeRoot();
  const result = runCli(root, ["--code-root", root, "--stack", "react", "--name", "widget", "--skip-check", "--skip-guard"]);
  assert.equal(result.status, 0, result.stderr);
  const lane = join(root, "widget", "frontend");
  assert.equal(JSON.parse(readFileSync(join(lane, "package.json"), "utf8")).name, "widget-fe");
  assert.equal(JSON.parse(readFileSync(join(lane, "package-lock.json"), "utf8")).name, "widget-fe");
  assert.match(readFileSync(join(lane, "package-lock.json"), "utf8"), /"@babel\/template"/);
  assert.match(readFileSync(join(lane, "vite.config.ts"), "utf8"), /"\/widget\/"/);
  assert.match(readFileSync(join(lane, ".env.example"), "utf8"), /VITE_API_TARGET=http:\/\/localhost:8080/);
  assert.match(readFileSync(join(lane, "index.html"), "utf8"), /<title>widget<\/title>/);
  const agents = readFileSync(join(lane, "AGENTS.md"), "utf8");
  assert.ok(
    agents.includes(
      "node <salgadinhos>/adapters/sandbox/run.mjs --stack node --workspace <repo-root> -- npm --prefix frontend ci",
    ),
    "the generated lane carries the sandbox install command",
  );
  assert.equal(readFileSync(join(root, "widget", ".salgadinhos", "frontend.yml"), "utf8").includes("source: react"), true);
});

test("real scaffold: kotlin takes --port and --mysql-port into every host-side literal", () => {
  const root = realCodeRoot();
  const result = runCli(root, [
    "--code-root", root, "--stack", "kotlin", "--name", "widget",
    "--port", "8110", "--mysql-port", "8112", "--skip-check", "--skip-guard",
  ]);
  assert.equal(result.status, 0, result.stderr);
  const lane = join(root, "widget", "backend");
  const env = readFileSync(join(lane, ".env.example"), "utf8");
  assert.match(env, /^KTOR_PORT=8110$/m);
  assert.match(env, /^MYSQL_PORT=8112$/m);
  const app = readFileSync(join(lane, "application", "src", "main", "resources", "application.yaml"), "utf8");
  assert.match(app, /\$\{KTOR_PORT:8110\}/);
  assert.match(app, /\$\{MYSQL_PORT:8112\}/);
  assert.match(readFileSync(join(lane, "docker-compose.yml"), "utf8"), /\$\{MYSQL_PORT:-8112\}:3306/);
  const endpoint = join(lane, "persistence", "src", "main", "kotlin", "dev", "agner", "widget", "persistence", "configuration", "MySqlEndpoint.kt");
  assert.match(readFileSync(endpoint, "utf8"), /DEFAULT_MYSQL_PORT = 8112/);
  const endpointTest = join(lane, "persistence", "src", "test", "kotlin", "dev", "agner", "widget", "persistence", "configuration", "MySqlEndpointTest.kt");
  assert.match(readFileSync(endpointTest, "utf8"), /shouldBe 8112/);
});

test("real scaffold: python takes --port and --mysql-port into every host-side literal", () => {
  const root = realCodeRoot();
  const result = runCli(root, [
    "--code-root", root, "--stack", "python", "--name", "widget",
    "--port", "8130", "--mysql-port", "8132", "--skip-check", "--skip-guard",
  ]);
  assert.equal(result.status, 0, result.stderr);
  const lane = join(root, "widget", "backend");
  const env = readFileSync(join(lane, ".env.example"), "utf8");
  assert.match(env, /^HTTP_PORT=8130$/m);
  assert.match(env, /^MYSQL__PORT=8132$/m);
  assert.match(env, /GATEWAYS__APP__HOST=http:\/\/localhost:8130/);
  const settings = readFileSync(join(lane, "src", "widget", "application", "settings.py"), "utf8");
  assert.match(settings, /http_port: int = 8130/);
  assert.match(settings, /port: int = 8132/);
  assert.match(readFileSync(join(lane, "docker-compose.yml"), "utf8"), /\$\{MYSQL__PORT:-8132\}:3306/);
  const testHost = readFileSync(join(lane, "tests", "unit", "test_app_host.py"), "utf8");
  assert.match(testHost, /settings.http_port == 8130/);
  assert.match(testHost, /settings.mysql.port == 8132/);
});

test("real scaffold: react takes --port and --frontend-dev-port into the Vite config", () => {
  const root = realCodeRoot();
  const result = runCli(root, [
    "--code-root", root, "--stack", "react", "--name", "widget",
    "--port", "8110", "--frontend-dev-port", "8113", "--skip-check", "--skip-guard",
  ]);
  assert.equal(result.status, 0, result.stderr);
  const lane = join(root, "widget", "frontend");
  const env = readFileSync(join(lane, ".env.example"), "utf8");
  assert.match(env, /VITE_API_TARGET=http:\/\/localhost:8110/);
  assert.match(env, /^FRONTEND_DEV_PORT=8113$/m);
  const vite = readFileSync(join(lane, "vite.config.ts"), "utf8");
  assert.match(vite, /FRONTEND_DEV_PORT \?\? 8113/);
  assert.match(vite, /VITE_API_TARGET \?\? "http:\/\/localhost:8110"/);
});
