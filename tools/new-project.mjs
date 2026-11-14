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
// token is not a placeholder, and `values` the convention overrides (`db`, `port`, `mysqlPort`,
// `frontendDevPort`, `image`, `basePath`) as file-scoped literal swaps. A port role's literal may
// carry `{{value}}` (the role's computed number); the port roles run before the other values and
// every value runs before the name token.
//
// Creation also owns a project's port block: the lowest fully free 10-port base in 8100–8299,
// with occupancy read from family-repo literals, live listeners and `docker ps`, committed to
// `.salgadinhos/ports.json`. A later lane adopts that record; `--force` never reallocates it.
//
// Usage:
//   node tools/new-project.mjs --stack <stack> --name <project> [--lane <dir>] [--to <dir>]
//       [--db <name>] [--port <n>] [--web-port <n>] [--mysql-port <n>]
//       [--frontend-dev-port <n>] [--base <n>] [--image <repo/name>] [--base-path </path/>]
//       [--code-root <dir>] [--skip-check] [--skip-guard] [--force]

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  ConfigError,
  VALUE_PLACEHOLDER,
  applyPlaceholders,
  laneSidePath,
  loadManifest,
  modePermissions,
  resolveRoots,
} from "./template-check.mjs";

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

// Convention values (`db`, `port`, `mysqlPort`, `frontendDevPort`, `image`, `basePath`) with an
// override: swap the literals each value declares, in the files it declares them in. A literal may
// carry `{{value}}`, replaced with the override while the rest of the literal stays as context
// (`"{{value}}:3306"` -> `"8112:3306"`, `${MYSQL_PORT:-{{value}}}:3306` likewise). A literal
// without it is replaced wholesale (`8080` -> the override), unless style `token` (default) means
// the literal carries context around the token (`3306/template`, `MYSQL_DATABASE=template`) and
// the token in it becomes the override, keeping the context; `whole` means the override is the
// literal's full replacement (`luiznaac/template` -> the image reference). Called before the token
// pass, so paths still carry the token.
//
// The port roles, in block order: API first, then the rest. Their literals may carry
// `{{value}}`; they run before the other convention values, and every value runs before the name
// token.
const PORT_VALUE_KEYS = ["port", "mysqlPort", "frontendDevPort"];

export const fillValue = (literal, value) => literal.split(VALUE_PLACEHOLDER).join(value);

function orderedValueKeys(values) {
  const portKeys = PORT_VALUE_KEYS.filter((key) => key in values);
  const otherKeys = Object.keys(values).filter((key) => !PORT_VALUE_KEYS.includes(key));
  return [...portKeys, ...otherKeys];
}

export function applyValueOverrides(rootDir, { token, values, overrides }) {
  const applied = [];
  for (const key of orderedValueKeys(values)) {
    const spec = values[key];
    if (overrides[key] === undefined) continue;
    for (const [file, literals] of Object.entries(spec.replacements)) {
      const abs = join(rootDir, file);
      if (!existsSync(abs)) throw new ConfigError(`instantiate.values.${key}: declared file does not exist in the scaffold: ${file}`);
      let text = readText(abs);
      if (text === null) throw new ConfigError(`instantiate.values.${key}: declared file is not text: ${file}`);
      for (const literal of literals) {
        const templated = literal.includes(VALUE_PLACEHOLDER);
        const search = templated ? fillValue(literal, spec.default) : literal;
        const replacement = templated
          ? fillValue(literal, overrides[key])
          : spec.style !== "whole" && tokenWord(token).test(literal)
            ? literal.replace(tokenWord(token), overrides[key])
            : overrides[key];
        text = text.split(search).join(replacement);
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
export function rewriteProjectManifest({ entries, token = null, name = null }) {
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
    const lanePath = token && name ? laneSidePath(entry.file, token, name) : entry.file;
    if (keys.length === 1 && keys[0] === "class") {
      lines.push(`  ${yamlScalar(lanePath)}: ${yamlScalar(fields.class)}`);
      continue;
    }
    lines.push(`  ${yamlScalar(lanePath)}:`);
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
export function sentinelText({ source, lane, name, scaffoldSha, revision = 1, note = "creation" }) {
  return [
    `# Lane lineage for the ${source} scaffold: written at ${note}, advanced only by propagation.`,
    "# `allow` records accepted divergences ({ entry, reason }).",
    `source: ${source}`,
    `lane: ${lane}`,
    ...(name ? [`name: ${name}`] : []),
    "applied:",
    `  revision: ${revision}`,
    `  scaffold_sha: ${scaffoldSha}`,
    "allow: []",
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Port blocks: the allocation range and the occupancy scan
// ---------------------------------------------------------------------------

// One 10-port block per generated project, base = API port. The range is inclusive and sits
// below the OS ephemeral range and clear of the scaffold defaults. The role table is the one
// source of each role's offset and CLI flag.
export const PORT_BLOCK = { start: 8100, end: 8299, step: 10, size: 10 };
const ROLE_SPEC = {
  api: { offset: 0, flag: "--port" },
  web: { offset: 1, flag: "--web-port" },
  mysql: { offset: 2, flag: "--mysql-port" },
  frontendDev: { offset: 3, flag: "--frontend-dev-port" },
};
export const PORT_ROLES = Object.keys(ROLE_SPEC);

export const blockForBase = (base) =>
  Object.fromEntries(PORT_ROLES.map((role) => [role, base + ROLE_SPEC[role].offset]));

const candidateBases = () => {
  const bases = [];
  for (let base = PORT_BLOCK.start; base + PORT_BLOCK.size - 1 <= PORT_BLOCK.end; base += PORT_BLOCK.step) bases.push(base);
  return bases;
};

export const blockIsFree = (base, occupied) => {
  for (let offset = 0; offset < PORT_BLOCK.size; offset++) if (occupied.has(base + offset)) return false;
  return true;
};

// The first fully free base, lowest first. `null` means the range is exhausted — the caller
// aborts loudly rather than borrowing above the range or reusing a freed block.
export function allocateBlock(occupied) {
  for (const base of candidateBases()) if (blockIsFree(base, occupied)) return blockForBase(base);
  return null;
}

export const blocksInUse = (occupied) => candidateBases().filter((base) => !blockIsFree(base, occupied));

// Any in-range integer counts, whatever file carries it: docs, IDE configs and runbooks are
// occupancy too, and a stray number costs one block step, never a silent collision. The
// lookarounds keep `18100` out while a `PORT_8100` identifier still counts (conservative).
const PORT_TOKEN = /(?<![0-9])8[12]\d{2}(?![0-9])/g;

export function portsFromText(text) {
  const ports = new Set();
  for (const match of String(text).matchAll(PORT_TOKEN)) ports.add(Number(match[0]));
  return ports;
}

// /proc/net/tcp: local_address is `HEXADDR:HEXPORT`, the state column `0A` is LISTEN.
export function parseProcNetTcp(text) {
  const ports = new Set();
  for (const line of String(text).split("\n").slice(1)) {
    const columns = line.trim().split(/\s+/);
    if (columns.length < 4 || columns[3] !== "0A") continue;
    const port = Number.parseInt(columns[1]?.split(":").pop() ?? "", 16);
    if (Number.isInteger(port)) ports.add(port);
  }
  return ports;
}

const addressPort = (token) => {
  const match = token.match(/:(\d+)$/);
  if (match) return Number(match[1]);
  const dotted = token.match(/\.(\d+)$/);
  return dotted ? Number(dotted[1]) : null;
};

// `netstat` for macOS (`127.0.0.1.8100`) and Windows (`0.0.0.0:8100`); only LISTEN rows count.
export function parseNetstatListeners(text) {
  const ports = new Set();
  for (const line of String(text).split("\n")) {
    if (!/\bLISTEN(?:ING)?\b/.test(line)) continue;
    const column = line.trim().split(/\s+/).find((token) => addressPort(token) !== null);
    const port = column ? addressPort(column) : null;
    if (port !== null) ports.add(port);
  }
  return ports;
}

// `docker ps --format '{{.Ports}}'`: the published side of each `host:port->container/port`.
export function parseDockerPorts(text) {
  const ports = new Set();
  for (const match of String(text).matchAll(/:(\d+)->/g)) ports.add(Number(match[1]));
  return ports;
}

const readTolerant = (abs) => {
  try {
    const buffer = readFileSync(abs);
    return buffer.includes(0) ? null : buffer.toString("utf8");
  } catch {
    return null;
  }
};

// Dependency lockfiles are machine-generated: their integrity hashes and wheel URLs contain hex
// fragments that read as in-range integers (e.g. a sha512 payload `...8192...`). They are never
// port bindings, so counting them would mark almost every block occupied and make allocation
// useless. The list is explicit on purpose — a generic `*.lock` rule would also drop a real file.
// Source, config, docs, runbooks and IDE files still count, as the spec requires.
const LOCKFILE_BASENAMES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "uv.lock",
  "poetry.lock",
  "Pipfile.lock",
  "Cargo.lock",
  "go.sum",
  "Gemfile.lock",
  "composer.lock",
  "gradle.lockfile",
  ".terraform.lock.hcl",
]);

// Gradle names a dependency lock after its configuration (`runtimeClasspath-gradle.lockfile`),
// so match the suffix as well as the bare name.
export const isDependencyLockfile = (file) => {
  const name = basename(file);
  return LOCKFILE_BASENAMES.has(name) || name.endsWith("-gradle.lockfile");
};

// A sibling repo's tracked text files (dependency lockfiles excluded), via `git grep` (the same
// source the propagation flow trusts). `null` means the directory is not a git checkout, so it
// contributes nothing.
export function scanRepoLiterals(repoDir) {
  const result = spawnSync(
    "git",
    ["-C", repoDir, "grep", "-I", "-l", "-E", "(^|[^0-9])8[12][0-9]{2}([^0-9]|$)"],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, windowsHide: true },
  );
  if (result.error || result.status === 128) return null;
  if (result.status === 1) return new Set();
  if (result.status !== 0) return null;
  const ports = new Set();
  for (const file of result.stdout.split("\n").map((line) => line.trim()).filter(Boolean)) {
    if (isDependencyLockfile(file)) continue;
    const text = readTolerant(join(repoDir, file));
    if (text === null) continue;
    for (const port of portsFromText(text)) ports.add(port);
  }
  return ports;
}

// Live OS listeners: /proc on Linux, `netstat` elsewhere. Only TCP LISTEN state counts.
export function liveListenerPorts(platform = process.platform) {
  const ports = new Set();
  if (platform === "linux") {
    let read = false;
    for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
      const text = readTolerant(file);
      if (text === null) continue;
      read = true;
      for (const port of parseProcNetTcp(text)) ports.add(port);
    }
    if (read) return ports;
  }
  const result = spawnSync("netstat", platform === "win32" ? ["-ano", "-p", "tcp"] : ["-an", "-p", "tcp"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  if (!result.error && result.status === 0) for (const port of parseNetstatListeners(result.stdout)) ports.add(port);
  return ports;
}

export function dockerPublishedPorts() {
  const result = spawnSync("docker", ["ps", "--format", "{{.Ports}}"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  if (result.error || result.status !== 0) return new Set();
  return parseDockerPorts(result.stdout);
}

// Every immediate child of the family root is an occupancy source (`salgadinhos` included); the
// environments checkout itself and the project being created are not.
export function scanOccupiedPorts({ codeRoot, environmentsPath, projectRoot }) {
  const occupied = new Set();
  const skip = [resolve(environmentsPath)];
  if (projectRoot) skip.push(resolve(projectRoot));
  for (const entry of readdirSync(codeRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const dir = join(codeRoot, entry.name);
    if (skip.includes(resolve(dir))) continue;
    const literals = scanRepoLiterals(dir);
    if (literals) for (const port of literals) occupied.add(port);
  }
  for (const port of liveListenerPorts()) occupied.add(port);
  for (const port of dockerPublishedPorts()) occupied.add(port);
  return occupied;
}

const portsRecordPath = (projectRoot) => join(projectRoot, ".salgadinhos", "ports.json");

// The committed block a project already owns. A lane created in the project adopts it verbatim;
// an explicit number that contradicts it refuses.
export function loadPortsRecord(projectRoot) {
  const path = portsRecordPath(projectRoot);
  if (!existsSync(path)) return null;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new ConfigError(`${path}: invalid JSON (${error.message})`);
  }
  const record = {};
  for (const role of PORT_ROLES) {
    const value = parsed?.[role];
    if (!Number.isInteger(value) || value <= 0) throw new ConfigError(`${path}: '${role}' must be a positive integer`);
    record[role] = value;
  }
  return record;
}

export const portsJsonText = (ports) =>
  `${JSON.stringify(Object.fromEntries(PORT_ROLES.map((role) => [role, ports[role]])), null, 2)}\n`;

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

// Every mode the scaffold commit records, keyed by path relative to the scaffold root. Creation
// reads these rather than the worktree: Windows has no executable bit to stat.
function scaffoldModes(environmentsPath, stack, sha) {
  const modes = new Map();
  const output = gitText(["ls-tree", "-r", sha, "--", stack], environmentsPath);
  for (const line of (output ?? "").split("\n")) {
    const match = line.match(/^(\d{6})\s+\S+\s+\S+\t(.+)$/);
    if (match && match[2].startsWith(`${stack}/`)) modes.set(match[2].slice(stack.length + 1), match[1]);
  }
  return modes;
}

function copyTree(src, dest, modes = new Map(), current = "") {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const from = join(src, entry.name);
    const to = join(dest, entry.name);
    const rel = current ? `${current}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      copyTree(from, to, modes, rel);
      continue;
    }
    if (!entry.isFile()) continue;
    const mode = modes.has(rel) ? modePermissions(modes.get(rel)) : statSync(from).mode & 0o777;
    const text = KEEP_EOL.test(entry.name) ? null : readText(from);
    if (text === null) writeFileSync(to, readFileSync(from));
    else writeFileSync(to, text.replace(/\r\n/g, "\n"), "utf8");
    // writeFileSync creates at the default mode, so a copied `gradlew` would not be runnable.
    // Carry the mode the scaffold commit records (or the worktree's when the file is untracked).
    chmodSync(to, mode);
  }
}

// Move a directory's contents into an existing one, replacing files but recursing into matched
// directories, so a forced re-run merges into the already-renamed tree instead of colliding.
function mergeDirectory(from, to) {
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const childFrom = join(from, entry.name);
    const childTo = join(to, entry.name);
    if (entry.isDirectory() && existsSync(childTo) && statSync(childTo).isDirectory()) {
      mergeDirectory(childFrom, childTo);
      continue;
    }
    rmSync(childTo, { recursive: true, force: true });
    renameSync(childFrom, childTo);
  }
  rmSync(from, { recursive: true, force: true });
}

// Rename each entry before recursing, so children are addressed through their new path. A
// forced re-run finds the target already there (the previous run renamed it): merge instead.
function renameTokenPaths(dir, token, name) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const from = join(dir, entry.name);
    const renamed = applyPlaceholders(entry.name, token, name);
    const target = renamed === entry.name ? from : join(dir, renamed);
    if (target !== from) {
      if (entry.isDirectory() && existsSync(target) && statSync(target).isDirectory()) {
        mergeDirectory(from, target);
      } else {
        rmSync(target, { recursive: true, force: true });
        renameSync(from, target);
      }
    }
    if (existsSync(target) && statSync(target).isDirectory()) renameTokenPaths(target, token, name);
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

// A block is free when all ten of its ports are clear; exhaustion is loud, never a borrow above
// the range and never a round-robin into a freed block.
function exhaustionError(occupied) {
  const bases = blocksInUse(occupied);
  return new CreationError(
    `no free port block in ${PORT_BLOCK.start}–${PORT_BLOCK.end}: blocks in use ${bases.join(", ")} — ` +
      "pass --base <n>, or --port/--web-port/--mysql-port/--frontend-dev-port to choose explicit numbers",
  );
}

const ROLE_FLAGS = Object.fromEntries(PORT_ROLES.map((role) => [role, ROLE_SPEC[role].flag]));

// The project's block: an existing record is authoritative (adopt, or refuse a contradiction);
// otherwise explicit choices fill the gap over an allocated free block. Any chosen port that
// lands on a committed or live one warns and proceeds — only a contradiction with the record
// refuses.
export function resolveProjectPorts({ projectRoot, explicitPorts, codeRoot, environmentsPath, log = () => {} }) {
  const record = loadPortsRecord(projectRoot);
  if (record) {
    for (const role of PORT_ROLES) {
      if (explicitPorts[role] !== undefined && explicitPorts[role] !== record[role]) {
        throw new ConfigError(
          `${ROLE_FLAGS[role]} ${explicitPorts[role]} contradicts ${portsRecordPath(projectRoot)} (${role} is ${record[role]}) — a later lane adopts the committed block`,
        );
      }
    }
    return record;
  }
  const occupied = scanOccupiedPorts({ codeRoot, environmentsPath, projectRoot });
  let chosen;
  if (explicitPorts.api !== undefined) {
    chosen = { ...blockForBase(explicitPorts.api), ...explicitPorts };
  } else {
    const allocated = allocateBlock(occupied);
    if (!allocated) throw exhaustionError(occupied);
    chosen = { ...allocated, ...explicitPorts };
  }
  if (Object.keys(explicitPorts).length > 0) {
    for (const role of PORT_ROLES) {
      if (occupied.has(chosen[role])) {
        log(`[new-project] note: explicit ${role} port ${chosen[role]} overlaps a committed or live port — proceeding`);
      }
    }
  }
  return chosen;
}

export function createProject({
  environmentsPath,
  codeRoot,
  stack,
  name,
  lane = null,
  to = null,
  overrides = {},
  ports = {},
  base = null,
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
  for (const role of PORT_ROLES) {
    if (ports[role] !== undefined && !/^[0-9]+$/.test(ports[role])) {
      throw new ConfigError(`${ROLE_FLAGS[role]} must be a number, got '${ports[role]}'`);
    }
  }
  if (base !== null && !/^[0-9]+$/.test(base)) throw new ConfigError(`--base must be a number, got '${base}'`);

  const projectRoot = resolve(to ?? join(codeRoot, name));
  const explicitPorts = base !== null ? blockForBase(Number(base)) : {};
  for (const role of PORT_ROLES) if (ports[role] !== undefined) explicitPorts[role] = Number(ports[role]);
  if (existsSync(projectRoot) && readdirSync(projectRoot).length > 0 && !force) {
    throw new ConfigError(`${projectRoot} exists and is not empty (pass --force to create inside it)`);
  }

  const chosenPorts = resolveProjectPorts({ projectRoot, explicitPorts, codeRoot, environmentsPath, log });

  const portOverrides = {};
  if (values.port) portOverrides.port = String(chosenPorts.api);
  if (values.mysqlPort) portOverrides.mysqlPort = String(chosenPorts.mysql);
  if (values.frontendDevPort) portOverrides.frontendDevPort = String(chosenPorts.frontendDev);

  const scaffoldSha = gitText(["rev-parse", "HEAD"], environmentsPath);
  if (!scaffoldSha) throw new ConfigError(`cannot resolve the scaffold commit in ${environmentsPath} (is it a git checkout?)`);
  const dirty = gitText(["status", "--porcelain", "--", stack], environmentsPath);
  if (dirty) log(`[new-project] warning: ${stack}/ has uncommitted changes; the sentinel pins ${scaffoldSha}, not your working copy`);

  const laneAbs = join(projectRoot, laneDir);
  copyTree(join(environmentsPath, stack), laneAbs, scaffoldModes(environmentsPath, stack, scaffoldSha));
  const appliedValues = applyValueOverrides(laneAbs, { token, values, overrides: { ...portOverrides, ...overrides } });
  renameTokenPaths(laneAbs, token, name);
  rewriteTokenContents(laneAbs, { token, name, keep });
  writeFileSync(
    join(laneAbs, ".salgadinhos", "manifest.yml"),
    rewriteProjectManifest({ entries: manifest.entries, token, name }),
    "utf8",
  );

  const sentinelPath = join(projectRoot, ".salgadinhos", `${sentinelFileName(laneDir)}.yml`);
  mkdirSync(dirname(sentinelPath), { recursive: true });
  writeFileSync(sentinelPath, sentinelText({ source: stack, lane: laneDir, name, scaffoldSha }), "utf8");
  writeFileSync(portsRecordPath(projectRoot), portsJsonText(chosenPorts), "utf8");

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
  // A forced re-run over an identical lane stages nothing; that is success, not a failure.
  const staged = git(["diff", "--cached", "--quiet"], projectRoot);
  if (staged.status !== 0) {
    requireGit(
      git(["commit", "-q", "-m", `Bootstrap ${name} from the ${stack} scaffold`, "-m", `Applied revision 1 of the ${stack} scaffold (${scaffoldSha}).`], projectRoot),
      "git commit",
    );
  }

  if (!skipGuard) {
    const installer = join(codeRoot, "salgadinhos", "adapters", "install.mjs");
    if (!existsSync(installer)) throw new CreationError(`master guard installer not found: ${installer} (pass --skip-guard to skip it)`);
    const result = spawnSync(process.execPath, [installer, "--install-repo", projectRoot], { cwd: dirname(dirname(installer)), stdio: "inherit" });
    if (result.error || result.status !== 0) throw new CreationError("master guard installation failed (pass --skip-guard to skip it)");
  }

  return { projectRoot, laneDir, laneAbs, sentinelPath, scaffoldSha, appliedValues, ports: chosenPorts, check, skippedCheck: skipCheck || !check, skippedGuard: skipGuard };
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
  --port <n>          the API port (default: the first free block's base)
  --web-port <n>      the web/UI host port (default: base+1)
  --mysql-port <n>    the MySQL host port (default: base+2)
  --frontend-dev-port <n>
                      the frontend dev port (default: base+3)
  --base <n>          fill all four ports from one block (api=base, web=base+1, ...)
  --image <repo/name> override the published image
  --base-path </p/>   override the SPA base path
  --skip-check        do not run the scaffold's fast check
  --skip-guard        do not install the master guard
  --force             create into an existing non-empty directory (never reallocates)
  --help              show this message`;

export function parseArgs(argv) {
  const args = {
    stack: null,
    name: null,
    lane: null,
    to: null,
    codeRoot: null,
    overrides: {},
    ports: {},
    base: null,
    skipCheck: false,
    skipGuard: false,
    force: false,
    help: false,
  };
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
    else if (flag === "--port") args.ports.api = value();
    else if (flag === "--web-port") args.ports.web = value();
    else if (flag === "--mysql-port") args.ports.mysql = value();
    else if (flag === "--frontend-dev-port") args.ports.frontendDev = value();
    else if (flag === "--base") args.base = value();
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
    console.log(
      `[new-project]   ports: api ${result.ports.api}, web ${result.ports.web}, mysql ${result.ports.mysql}, frontendDev ${result.ports.frontendDev} (.salgadinhos/ports.json)`,
    );
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
