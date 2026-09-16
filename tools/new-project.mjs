#!/usr/bin/env node
// New project creation: copies a scaffold into a new project lane, applies the renames declared
// in the scaffold's `.salgadinhos/manifest.yml` (`instantiate:`), stamps the lane sentinel, runs
// the stack's fast check and the zero-leftover assertion, then `git init`s and commits before
// installing the master guard. The judgment work around it (remote repo, CI, secrets, domain,
// first deploy) belongs to the creation skill in salgadinhos.
//
// The mechanical contract is entirely manifest data: `instantiate.name` is the token renamed to
// the project name (word-bounded in text and paths, package-name-shaped in JSON values),
// `instantiate.lane` the default lane dir, `check` the fast check, `keep` the files where the
// token is not a placeholder, and `values` the convention overrides (`db`, `port`, `image`,
// `basePath`) as file-scoped literal swaps.
//
// Usage:
//   node tools/new-project.mjs --stack <stack> --name <project> [--lane <dir>] [--to <dir>]
//       [--db <name>] [--port <n>] [--image <repo/name>] [--base-path </path/>]
//       [--code-root <dir>] [--skip-check] [--skip-guard] [--force]

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { ConfigError, applyPlaceholders, loadManifest, resolveRoots } from "./template-check.mjs";

// Creation failures that are not config errors: a red fast check, a leftover, a failed commit.
export class CreationError extends Error {}

// Generated trees and tool caches never carry placeholders that matter; skipping them keeps the
// rewrite and the leftover assertion away from build output.
const SKIP_DIRS = new Set([".git", "node_modules", ".venv", "__pycache__", "build", ".gradle", ".kotlin", "dist"]);

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const tokenWord = (token) => new RegExp(`\\b${escapeRegex(token)}\\b`);

// The token only names packages in JSON (package.json / package-lock.json): a whole string value
// equal to the token or `<token>-<suffix>`. Scoped dependency metadata (`@babel/template`,
// `@types/babel__template`) is data about third parties and is never touched.
export function replaceJsonTokenValues(value, token, name) {
  let changed = false;
  const visit = (node) => {
    if (typeof node === "string") {
      if (node === token || node.startsWith(`${token}-`)) {
        changed = true;
        return `${name}${node.slice(token.length)}`;
      }
      return node;
    }
    if (Array.isArray(node)) return node.map(visit);
    if (node && typeof node === "object") {
      const out = {};
      for (const [key, child] of Object.entries(node)) out[key] = visit(child);
      return out;
    }
    return node;
  };
  return { value: visit(value), changed };
}

function isKept(keep, rel) {
  return keep.some((item) => rel === item || rel.startsWith(`${item}/`));
}

function readText(abs) {
  const buffer = readFileSync(abs);
  if (buffer.includes(0)) return null;
  return buffer.toString("utf8");
}

// Every regular file under `rootDir`, in sorted order, minus the skipped dirs and `keep` entries.
function* walkFiles(rootDir, keep = [], current = "") {
  for (const entry of readdirSync(join(rootDir, current), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = current ? `${current}/${entry.name}` : entry.name;
    if (isKept(keep, rel)) continue;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      yield* walkFiles(rootDir, keep, rel);
    } else if (entry.isFile()) {
      yield rel;
    }
  }
}

function offendingJsonValues(node, token, found = []) {
  if (typeof node === "string") {
    if (node === token || node.startsWith(`${token}-`)) found.push(node);
    return found;
  }
  if (Array.isArray(node)) {
    for (const child of node) offendingJsonValues(child, token, found);
    return found;
  }
  if (node && typeof node === "object") {
    for (const child of Object.values(node)) offendingJsonValues(child, token, found);
  }
  return found;
}

function lineContaining(text, needle) {
  const lines = text.split(/\r?\n/);
  const index = lines.findIndex((line) => line.includes(needle));
  return index === -1 ? { line: 1, text: needle } : { line: index + 1, text: lines[index].trim() };
}

// The zero-leftover assertion: no occurrence of the token that should not be there. Text files
// are checked word-boundedly, JSON files package-name-shapedly; `keep` files are exempt.
export function findTokenLeftovers(rootDir, { token, keep = [] }) {
  const hits = [];
  for (const rel of walkFiles(rootDir, keep)) {
    const text = readText(join(rootDir, rel));
    if (text === null) continue;
    if (rel.endsWith(".json")) {
      let parsed = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
      if (parsed !== null) {
        for (const value of offendingJsonValues(parsed, token)) {
          hits.push({ file: rel, ...lineContaining(text, JSON.stringify(value)) });
        }
        continue;
      }
    }
    for (const [index, line] of text.split(/\r?\n/).entries()) {
      if (tokenWord(token).test(line)) hits.push({ file: rel, line: index + 1, text: line.trim() });
    }
  }
  return hits.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

// Convention values (`db`, `port`, `image`, `basePath`) with an override: swap the literals each
// value declares, in the files it declares them in. Style `token` (default) means the literal
// carries context around the token (`3306/template`, `MYSQL_DATABASE=template`) and the token in
// it becomes the override, keeping the context; `whole` means the override is the literal's full
// replacement (`luiznaac/template` -> the image reference). A literal without the token (`8080`)
// is replaced wholesale either way. Called before the token pass, so paths still carry the token.
export function applyValueOverrides(rootDir, { token, values, overrides }) {
  const applied = [];
  for (const [key, spec] of Object.entries(values)) {
    if (overrides[key] === undefined) continue;
    for (const [file, literals] of Object.entries(spec.replacements)) {
      const abs = join(rootDir, file);
      if (!existsSync(abs)) throw new ConfigError(`instantiate.values.${key}: declared file does not exist in the scaffold: ${file}`);
      let text = readText(abs);
      if (text === null) throw new ConfigError(`instantiate.values.${key}: declared file is not text: ${file}`);
      for (const literal of literals) {
        const substitute = spec.style !== "whole" && tokenWord(token).test(literal);
        const replacement = substitute ? literal.replace(tokenWord(token), overrides[key]) : overrides[key];
        text = text.split(literal).join(replacement);
      }
      writeFileSync(abs, text, "utf8");
    }
    applied.push(key);
  }
  return applied;
}

const yamlScalar = (value) =>
  typeof value === "string" && /^[A-Za-z0-9_./-]+$/.test(value) ? value : JSON.stringify(value);

// The project's copy of the manifest is the classification only: `entries` is what the propagation
// flow watches; the creation-only `instantiate:` section does not belong in a project, and the
// lineage lives in the lane sentinel.
export function rewriteProjectManifest({ entries }) {
  const lines = [
    "# Propagation manifest copied at creation from the scaffold's manifest: `entries` maps each",
    "# watched path to owned | pinned | merge | judgment. The lane's lineage (source, applied,",
    "# allow) lives in the sibling sentinel under .salgadinhos/.",
    "entries:",
  ];
  for (const entry of Object.values(entries)) {
    const fields = { ...entry };
    delete fields.file;
    const keys = Object.keys(fields);
    if (keys.length === 1 && keys[0] === "class") {
      lines.push(`  ${yamlScalar(entry.file)}: ${yamlScalar(fields.class)}`);
      continue;
    }
    lines.push(`  ${yamlScalar(entry.file)}:`);
    for (const [key, value] of Object.entries(fields)) {
      if (Array.isArray(value)) {
        lines.push(`    ${key}:`);
        for (const item of value) lines.push(`      - ${yamlScalar(item)}`);
      } else {
        lines.push(`    ${key}: ${yamlScalar(value)}`);
      }
    }
  }
  return `${lines.join("\n")}\n`;
}

// One sentinel per lane; creation is revision 1, the scaffold_sha is the immutable pin. The
// `note` says who stamped it ("creation", or "bootstrap" when the applier stamps an existing
// project's lineage); only the applier ever advances `applied` afterwards.
export function sentinelText({ source, lane, scaffoldSha, revision = 1, note = "creation" }) {
  return [
    `# Lane lineage for the ${source} scaffold: written at ${note}, advanced only by propagation.`,
    "# `allow` records accepted divergences ({ entry, reason }).",
    `source: ${source}`,
    `lane: ${lane}`,
    "applied:",
    `  revision: ${revision}`,
    `  scaffold_sha: ${scaffoldSha}`,
    "allow: []",
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------

// cmd.exe has no `./`: on Windows a `./gradlew ...` check runs through PATHEXT (`gradlew` ->
// gradlew.bat), which is the wrapper the stack actually ships there.
export function resolveCheckCommand(check, platform = process.platform) {
  return platform === "win32" ? check.replace(/(^|\s)\.\//g, "$1") : check;
}

// Text is copied LF-canonical: the repos store LF and a Windows checkout smudges it to CRLF,
// which the stacks' formatters (Biome, Detekt) reject. Batch files keep their ending — cmd.exe
// wants CRLF.
const KEEP_EOL = /\.bat$/i;

function copyTree(src, dest) {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const from = join(src, entry.name);
    const to = join(dest, entry.name);
    if (entry.isDirectory()) {
      copyTree(from, to);
      continue;
    }
    if (!entry.isFile()) continue;
    const text = KEEP_EOL.test(entry.name) ? null : readText(from);
    if (text === null) writeFileSync(to, readFileSync(from));
    else writeFileSync(to, text.replace(/\r\n/g, "\n"), "utf8");
  }
}

// Rename each entry before recursing, so children are addressed through their new path.
function renameTokenPaths(dir, token, name) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const from = join(dir, entry.name);
    const renamed = applyPlaceholders(entry.name, token, name);
    const target = renamed === entry.name ? from : join(dir, renamed);
    if (renamed !== entry.name) renameSync(from, target);
    if (entry.isDirectory()) renameTokenPaths(target, token, name);
  }
}

function rewriteTokenContents(rootDir, { token, name, keep }) {
  for (const rel of walkFiles(rootDir, keep)) {
    const abs = join(rootDir, rel);
    const text = readText(abs);
    if (text === null) continue;
    if (rel.endsWith(".json")) {
      let parsed = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
      if (parsed !== null) {
        const { value, changed } = replaceJsonTokenValues(parsed, token, name);
        if (changed) writeFileSync(abs, `${JSON.stringify(value, null, 2)}\n`, "utf8");
        continue;
      }
    }
    const rewritten = applyPlaceholders(text, token, name);
    if (rewritten !== text) writeFileSync(abs, rewritten, "utf8");
  }
}

// The sentinel file a lane is named after (`backend` -> `backend.yml`, a root lane -> `root.yml`).
export const sentinelFileName = (lane) => (lane === "." ? "root" : lane.split(/[\\/]/).filter(Boolean).join("-"));

function git(args, cwd) {
  return spawnSync("git", args, { cwd, encoding: "utf8" });
}

function gitText(args, cwd) {
  const result = git(args, cwd);
  if (result.error || result.status !== 0) return null;
  return result.stdout.trim();
}

function requireGit(result, what) {
  if (result.error || result.status !== 0) {
    const detail = (result.stderr ?? result.error?.message ?? "").trim();
    throw new CreationError(`${what} failed${detail ? `: ${detail}` : ""}`);
  }
}

// A host port published by a sibling app collides with the new app. Scans the sibling's root
// compose and its lane composes, short (`- 8080:8080`) and long (`published: 8080`) forms.
function findPortCollisions(codeRoot, port, projectRoot) {
  const short = new RegExp(`^\\s*-\\s*["']?${escapeRegex(port)}:`, "m");
  const published = new RegExp(`^\\s*(-\\s*)?published:\\s*["']?${escapeRegex(port)}["']?\\s*$`, "m");
  const hits = [];
  for (const entry of readdirSync(codeRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "environments" || entry.name === "salgadinhos") continue;
    const sibling = join(codeRoot, entry.name);
    if (resolve(sibling) === resolve(projectRoot)) continue;
    const composes = [join(sibling, "docker-compose.yml")];
    for (const child of readdirSync(sibling, { withFileTypes: true })) {
      if (child.isDirectory() && !child.name.startsWith(".") && !SKIP_DIRS.has(child.name)) {
        composes.push(join(sibling, child.name, "docker-compose.yml"));
      }
    }
    for (const compose of composes) {
      if (!existsSync(compose)) continue;
      const text = readFileSync(compose, "utf8");
      if (short.test(text) || published.test(text)) {
        hits.push(entry.name);
        break;
      }
    }
  }
  return hits.sort();
}

export function createProject({
  environmentsPath,
  codeRoot,
  stack,
  name,
  lane = null,
  to = null,
  overrides = {},
  skipCheck = false,
  skipGuard = false,
  force = false,
  log = console.log,
}) {
  if (typeof name !== "string" || !/^[a-z][a-z0-9-]*$/.test(name)) {
    throw new ConfigError(`--name must be a lowercase project name ([a-z][a-z0-9-]*), got '${name}'`);
  }
  const manifestPath = join(environmentsPath, stack, ".salgadinhos", "manifest.yml");
  if (!existsSync(manifestPath)) {
    throw new ConfigError(`no scaffold manifest at ${manifestPath} — is '${stack}' a scaffold in ${environmentsPath}?`);
  }
  const manifest = loadManifest(manifestPath);
  const { name: token, lane: manifestLane, check, keep, values } = manifest.instantiate;
  if (!token) {
    throw new ConfigError(`stack '${stack}' declares no instantiate.name — creation is deferred for this scaffold`);
  }
  const laneDir = lane ?? manifestLane;
  if (!laneDir) throw new ConfigError(`stack '${stack}' declares no instantiate.lane — pass --lane <dir>`);
  for (const key of Object.keys(overrides)) {
    if (!values[key]) {
      const declared = Object.keys(values);
      throw new ConfigError(
        `stack '${stack}' declares no '${key}' value to override${declared.length > 0 ? ` (declared: ${declared.join(", ")})` : ""}`,
      );
    }
  }
  if (overrides.port !== undefined && !/^[0-9]+$/.test(overrides.port)) {
    throw new ConfigError(`--port must be a number, got '${overrides.port}'`);
  }

  const effectivePort = overrides.port ?? values.port?.default;
  const projectRoot = resolve(to ?? join(codeRoot, name));
  if (values.port && effectivePort) {
    const collisions = findPortCollisions(codeRoot, effectivePort, projectRoot);
    if (collisions.length > 0 && overrides.port === undefined) {
      throw new ConfigError(
        `port ${effectivePort} is already published by ${collisions.join(", ")} — pass --port <n> to pick another one`,
      );
    }
    if (collisions.length > 0) log(`[new-project] note: port ${effectivePort} is also published by ${collisions.join(", ")}`);
  }

  if (existsSync(projectRoot) && readdirSync(projectRoot).length > 0 && !force) {
    throw new ConfigError(`${projectRoot} exists and is not empty (pass --force to create inside it)`);
  }

  const scaffoldSha = gitText(["rev-parse", "HEAD"], environmentsPath);
  if (!scaffoldSha) throw new ConfigError(`cannot resolve the scaffold commit in ${environmentsPath} (is it a git checkout?)`);
  const dirty = gitText(["status", "--porcelain", "--", stack], environmentsPath);
  if (dirty) log(`[new-project] warning: ${stack}/ has uncommitted changes; the sentinel pins ${scaffoldSha}, not your working copy`);

  const laneAbs = join(projectRoot, laneDir);
  copyTree(join(environmentsPath, stack), laneAbs);
  const appliedValues = applyValueOverrides(laneAbs, { token, values, overrides });
  renameTokenPaths(laneAbs, token, name);
  rewriteTokenContents(laneAbs, { token, name, keep });
  writeFileSync(join(laneAbs, ".salgadinhos", "manifest.yml"), rewriteProjectManifest(manifest), "utf8");

  const sentinelPath = join(projectRoot, ".salgadinhos", `${sentinelFileName(laneDir)}.yml`);
  mkdirSync(dirname(sentinelPath), { recursive: true });
  writeFileSync(sentinelPath, sentinelText({ source: stack, lane: laneDir, scaffoldSha }), "utf8");

  const leftovers = findTokenLeftovers(laneAbs, { token, keep });
  if (leftovers.length > 0) {
    throw new CreationError(
      `creation left '${token}' placeholders behind:\n  ${leftovers.map((hit) => `${hit.file}:${hit.line}: ${hit.text}`).join("\n  ")}`,
    );
  }

  if (check && !skipCheck) {
    const command = resolveCheckCommand(check);
    const result = spawnSync(command, { cwd: laneAbs, shell: true, stdio: "inherit" });
    if (result.error || result.status !== 0) throw new CreationError(`fast check failed: ${command}\n  (left for inspection at ${projectRoot})`);
  }

  requireGit(git(["init", "-q", "-b", "master"], projectRoot), "git init");
  requireGit(git(["add", "-A"], projectRoot), "git add");
  requireGit(
    git(["commit", "-q", "-m", `Bootstrap ${name} from the ${stack} scaffold`, "-m", `Applied revision 1 of the ${stack} scaffold (${scaffoldSha}).`], projectRoot),
    "git commit",
  );

  if (!skipGuard) {
    const installer = join(codeRoot, "salgadinhos", "adapters", "install.mjs");
    if (!existsSync(installer)) throw new CreationError(`master guard installer not found: ${installer} (pass --skip-guard to skip it)`);
    const result = spawnSync(process.execPath, [installer, "--install-repo", projectRoot], { cwd: dirname(dirname(installer)), stdio: "inherit" });
    if (result.error || result.status !== 0) throw new CreationError("master guard installation failed (pass --skip-guard to skip it)");
  }

  return { projectRoot, laneDir, laneAbs, sentinelPath, scaffoldSha, appliedValues, check, skippedCheck: skipCheck || !check, skippedGuard: skipGuard };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `usage: node tools/new-project.mjs --stack <stack> --name <project> [options]

  --lane <dir>        lane directory (default: instantiate.lane)
  --to <dir>          project root to create (default: <code-root>/<name>)
  --code-root <dir>   family root holding environments/ and salgadinhos/
                      (default: the parent of this checkout)
  --db <name>         override the DB name (convention: the project name)
  --port <n>          override the app port (convention: 8080, collision-checked)
  --image <repo/name> override the published image
  --base-path </p/>   override the SPA base path
  --skip-check        do not run the scaffold's fast check
  --skip-guard        do not install the master guard
  --force             create into an existing non-empty directory
  --help              show this message`;

export function parseArgs(argv) {
  const args = { stack: null, name: null, lane: null, to: null, codeRoot: null, overrides: {}, skipCheck: false, skipGuard: false, force: false, help: false };
  for (let i = 2; i < argv.length; i++) {
    const flag = argv[i];
    const value = () => {
      if (i + 1 >= argv.length) throw new ConfigError(`'${flag}' requires a value`);
      return argv[++i];
    };
    if (flag === "--stack") args.stack = value();
    else if (flag === "--name") args.name = value();
    else if (flag === "--lane") args.lane = value();
    else if (flag === "--to") args.to = value();
    else if (flag === "--code-root") args.codeRoot = value();
    else if (flag === "--db") args.overrides.db = value();
    else if (flag === "--port") args.overrides.port = value();
    else if (flag === "--image") args.overrides.image = value();
    else if (flag === "--base-path") args.overrides.basePath = value();
    else if (flag === "--skip-check") args.skipCheck = true;
    else if (flag === "--skip-guard") args.skipGuard = true;
    else if (flag === "--force") args.force = true;
    else if (flag === "--help" || flag === "-h") args.help = true;
    else throw new ConfigError(`unknown argument '${flag}'`);
  }
  return args;
}

function main(argv) {
  try {
    const args = parseArgs(argv);
    if (args.help) {
      console.log(USAGE);
      process.exit(0);
    }
    if (!args.stack || !args.name) {
      console.error(USAGE);
      process.exit(2);
    }
    const { codeRoot, environmentsPath } = resolveRoots(fileURLToPath(import.meta.url), args);
    const result = createProject({ environmentsPath, codeRoot, ...args });
    console.log(`[new-project] created ${result.projectRoot}/${result.laneDir} from the '${args.stack}' scaffold`);
    console.log(`[new-project]   sentinel: ${result.sentinelPath} (revision 1, scaffold ${result.scaffoldSha})`);
    console.log(`[new-project]   overrides: ${result.appliedValues.length > 0 ? result.appliedValues.join(", ") : "none"}`);
    console.log(`[new-project]   fast check: ${result.skippedCheck ? "skipped" : result.check}`);
    console.log(`[new-project]   master guard: ${result.skippedGuard ? "skipped" : "installed"}`);
    console.log("[new-project] next: remote repo, CI, secrets, domain and first deploy — the creation skill drives them");
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`[new-project] ${error.message}`);
      process.exit(2);
    }
    if (error instanceof CreationError) {
      console.error(`[new-project] ${error.message}`);
      process.exit(1);
    }
    throw error;
  }
}

function isMainModule() {
  if (!process.argv[1]) return false;
  const invoked = pathToFileURL(resolve(process.argv[1])).href;
  return process.platform === "win32" ? invoked.toLowerCase() === import.meta.url.toLowerCase() : invoked === import.meta.url;
}

if (isMainModule()) main(process.argv);
