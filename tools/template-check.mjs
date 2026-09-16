#!/usr/bin/env node
// Template drift check: compares the convention-sensitive files of every project that carries a
// `.salgadinhos/` sentinel against the scaffold it declares as its `source`, so a pattern landed
// in a scaffold (a pinned dependency, a Detekt rule, a Biome/Ruff setting) cannot silently go
// stale in the siblings.
//
// Sources of truth (nothing is hardcoded here):
//   - `environments/<stack>/.salgadinhos/manifest.yml` — `entries` (path -> class) and
//     `instantiate` (the scaffold's own name token).
//   - `<project>/.salgadinhos/<lane>.yml` — sentinel: `source`, `lane`, `applied`, `allow`.
//     Projects are discovered by globbing for these; `allow` divergence lives there too.
//
// What it compares, derived from each entry's class:
//   - `owned`:      whole-file equality after normalization (CRLF -> LF, trimmed, whitespace
//                   collapsed; JSON files are compared structurally).
//   - `pinned`:     a `pins` watchlist in a JSON dependency map, or every `[versions]` alias of
//                   a TOML version catalog.
//   - `merge`:      named `[tool.*]` sections of a TOML file, line-normalized.
//   - `judgment`:   not mechanical — skipped here; goes through the porting skill.
// Plus a restatement check: a normative line of salgadinhos/global/AGENTS.md must not appear
// verbatim in a project's own AGENTS.md (a restatement is a drift point).
//
// Read-only: it never applies anything, like `template-sync`. Findings are direction-aware —
// DRIFT (project behind scaffold), AHEAD (project ran ahead — port back, or record an `allow`
// in the sentinel with a reason), RESTATE. Exit codes: 0 clean, 1 blocking drift, 2 config error.
//
// Usage:
//   node tools/template-check.mjs [--code-root <dir>] [--project <name>] [--global-agents <file>]
//
// `--code-root` defaults to the parent of this checkout (the sibling project repos; scaffolds
// are then read from this checkout). `--global-agents` defaults to
// `<code-root>/salgadinhos/global/AGENTS.md`.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export class ConfigError extends Error {}

const CLASSES = new Set(["owned", "pinned", "merge", "judgment"]);

// ---------------------------------------------------------------------------
// YAML-lite: exactly the subset the manifests and sentinels use — nested maps
// by indentation, block sequences, inline flow sequences, quoted or plain
// scalars, comments, `{}` and `null`. No anchors, multi-line scalars, flow
// maps or explicit tags; keep the files within that subset.
// ---------------------------------------------------------------------------

function stripComment(line) {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (inDouble && char === "\\") {
      i++;
      continue;
    }
    if (char === "'" && !inDouble) inSingle = !inSingle;
    else if (char === '"' && !inSingle) inDouble = !inDouble;
    else if (char === "#" && !inSingle && !inDouble && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
  }
  return line;
}

function yamlError(line, message) {
  return new Error(`line ${line.number}: ${message}`);
}

// First `:` that separates a key from its value (outside quotes, followed by a space or EOL).
function findKeyColon(text) {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (inDouble && char === "\\") {
      i++;
      continue;
    }
    if (char === "'" && !inDouble) inSingle = !inSingle;
    else if (char === '"' && !inSingle) inDouble = !inDouble;
    else if (char === ":" && !inSingle && !inDouble && (i === text.length - 1 || text[i + 1] === " ")) return i;
  }
  return -1;
}

function unquote(token) {
  if (token.length >= 2 && token.startsWith('"') && token.endsWith('"')) return JSON.parse(token);
  if (token.length >= 2 && token.startsWith("'") && token.endsWith("'")) return token.slice(1, -1).replace(/''/g, "'");
  return token;
}

function parseScalar(token) {
  const value = token.trim();
  if (value === "null" || value === "~") return null;
  return unquote(value);
}

function parseFlowSequence(token, line) {
  const inner = token.slice(1, -1);
  const items = [];
  let current = "";
  let quote = null;
  for (const char of inner) {
    if (quote) {
      current += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === ",") {
      items.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (quote) throw yamlError(line, `unterminated string in ${token}`);
  items.push(current);
  return items
    .map((item) => item.trim())
    .filter((item) => item !== "")
    .map(parseScalar);
}

function splitKeyValue(text, line) {
  const colon = findKeyColon(text);
  if (colon === -1) throw yamlError(line, `expected 'key: value', got '${text}'`);
  return { key: unquote(text.slice(0, colon).trim()), rest: text.slice(colon + 1).trim() };
}

function resolveValue(rest, lines, state, parentIndent, line) {
  if (rest === "") {
    const next = lines[state.pos];
    if (next && next.indent > parentIndent) return parseNode(lines, state, next.indent);
    return null;
  }
  if (rest === "{}") return {};
  if (rest === "[]") return [];
  if (rest.startsWith("[")) return parseFlowSequence(rest, line);
  return parseScalar(rest);
}

function parseNode(lines, state, indent) {
  const first = lines[state.pos];
  if (!first || first.indent !== indent) throw yamlError(first ?? { number: "?" }, "expected an indented block");
  return first.text.startsWith("-") ? parseSequence(lines, state, indent) : parseMapping(lines, state, indent);
}

function parseMapping(lines, state, indent) {
  const map = {};
  while (state.pos < lines.length) {
    const line = lines[state.pos];
    if (line.indent < indent || line.text.startsWith("-")) break;
    if (line.indent > indent) throw yamlError(line, "unexpected indentation");
    const { key, rest } = splitKeyValue(line.text, line);
    state.pos++;
    map[key] = resolveValue(rest, lines, state, indent, line);
  }
  return map;
}

function parseSequence(lines, state, indent) {
  const items = [];
  while (state.pos < lines.length) {
    const line = lines[state.pos];
    if (line.indent < indent || !line.text.startsWith("-")) break;
    if (line.indent > indent) throw yamlError(line, "unexpected indentation");
    const content = line.text.slice(1).trim();
    state.pos++;
    if (content === "") {
      const next = lines[state.pos];
      if (!next || next.indent <= indent) throw yamlError(line, "list item without a value");
      items.push(parseNode(lines, state, next.indent));
      continue;
    }
    if (findKeyColon(content) !== -1) {
      const item = {};
      const { key, rest } = splitKeyValue(content, line);
      item[key] = resolveValue(rest, lines, state, indent, line);
      const next = lines[state.pos];
      if (next && next.indent > indent) Object.assign(item, parseMapping(lines, state, next.indent));
      items.push(item);
    } else {
      items.push(parseScalar(content));
    }
  }
  return items;
}

export function parseYamlLite(text) {
  const lines = [];
  const raw = String(text).replace(/\r\n/g, "\n").split("\n");
  for (let i = 0; i < raw.length; i++) {
    const withoutComment = stripComment(raw[i]);
    if (withoutComment.trim() === "") continue;
    lines.push({ indent: withoutComment.match(/^ */)[0].length, text: withoutComment.trim(), number: i + 1 });
  }
  if (lines.length === 0) return {};
  const state = { pos: 0 };
  const node = parseNode(lines, state, lines[0].indent);
  if (state.pos < lines.length) throw yamlError(lines[state.pos], "unexpected indentation");
  return node;
}

// ---------------------------------------------------------------------------
// Parsing helpers (ported from PR #33's template-check; message shapes are
// kept identical so the output stays comparable to that baseline)
// ---------------------------------------------------------------------------

export const norm = (text) =>
  text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .join("\n");

// Substitute the scaffold's own name token (e.g. the python scaffold's `template` package) with
// the project's name, word-bounded so `template` inside another word is left alone.
export function applyPlaceholders(text, token, projectName) {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(new RegExp(`\\b${escaped}\\b`, "g"), projectName);
}

// Deep-compare two JSON values. Returns [drift, ahead]: paths present only in the scaffold
// (project is behind) and paths present only in the project (project ran ahead of the scaffold).
export function jsonDiff(a, b, path = "", drift = [], ahead = []) {
  if (JSON.stringify(a) === JSON.stringify(b)) return [drift, ahead];
  const bothObjects = a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) === !Array.isArray(b);
  if (!bothObjects) {
    if (typeof a === "undefined") ahead.push(path);
    else if (typeof b === "undefined") drift.push(path);
    else drift.push(`${path} (scaffold ${JSON.stringify(a)} -> project ${JSON.stringify(b)})`);
    return [drift, ahead];
  }
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    jsonDiff(a[k], b[k], path ? `${path}.${k}` : k, drift, ahead);
  }
  return [drift, ahead];
}

// `alias = "1.2.3"` lines of the [versions] table, stopping at the next [section].
export function parseVersionCatalog(text) {
  const versions = {};
  let inVersions = false;
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    const header = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (header) {
      inVersions = header[1].trim() === "versions";
      continue;
    }
    if (!inVersions) continue;
    const alias = line.match(/^([a-zA-Z0-9_-]+)\s*=\s*"([^"]+)"/);
    if (alias) versions[alias[1]] = alias[2];
  }
  return versions;
}

// TOML-lite: map of section name -> normalized body lines.
export function parseTomlSections(text) {
  const sections = {};
  let current = null;
  for (const raw of text.replace(/\r\n/g, "\n").split("\n")) {
    const header = raw.match(/^\[(.+)\]\s*$/);
    if (header) {
      current = header[1].trim();
      sections[current] = [];
    } else if (current) {
      const line = raw.trim();
      if (line !== "" && !line.startsWith("#")) sections[current].push(line);
    }
  }
  for (const key of Object.keys(sections)) sections[key] = sections[key].join("\n");
  return sections;
}

// ---------------------------------------------------------------------------
// Manifest / sentinel loading
// ---------------------------------------------------------------------------

function parseFile(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new ConfigError(`${path}: ${error.message}`);
  }
  try {
    return parseYamlLite(text);
  } catch (error) {
    throw new ConfigError(`${path}: ${error.message}`);
  }
}

// Every instantiate field is either absent/null or a non-empty string; anything else is a
// config error (the manifest is data the creation tooling reads, not prose).
function instantiateString(value, manifestPath, key) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new ConfigError(`${manifestPath}: 'instantiate.${key}' must be a string or null`);
  return value;
}

// `instantiate.values` — per-value override targets: map of value name -> { default?, replacements }
// where `replacements` is a map of scaffold-relative path -> literal strings to swap when the
// creation tooling is given an override.
function parseInstantiateValues(raw, manifestPath) {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigError(`${manifestPath}: 'instantiate.values' must be a map`);
  }
  const values = {};
  for (const [key, spec] of Object.entries(raw)) {
    if (spec === null || typeof spec !== "object" || Array.isArray(spec)) {
      throw new ConfigError(`${manifestPath}: 'instantiate.values.${key}' must be a map`);
    }
    const value = {};
    if (spec.default !== undefined && spec.default !== null && spec.default !== "") {
      if (typeof spec.default !== "string") {
        throw new ConfigError(`${manifestPath}: 'instantiate.values.${key}.default' must be a string`);
      }
      value.default = spec.default;
    }
    if (spec.style !== undefined && spec.style !== null) {
      if (spec.style !== "token" && spec.style !== "whole") {
        throw new ConfigError(`${manifestPath}: 'instantiate.values.${key}.style' must be 'token' or 'whole'`);
      }
      value.style = spec.style;
    }
    const replacements = spec.replacements;
    if (replacements === undefined || replacements === null) {
      throw new ConfigError(`${manifestPath}: 'instantiate.values.${key}' needs 'replacements'`);
    }
    if (typeof replacements !== "object" || Array.isArray(replacements)) {
      throw new ConfigError(`${manifestPath}: 'instantiate.values.${key}.replacements' must be a map`);
    }
    if (Object.keys(replacements).length === 0) {
      throw new ConfigError(`${manifestPath}: 'instantiate.values.${key}' needs 'replacements'`);
    }
    value.replacements = {};
    for (const [file, literals] of Object.entries(replacements)) {
      if (!Array.isArray(literals) || literals.some((literal) => typeof literal !== "string" || literal === "")) {
        throw new ConfigError(`${manifestPath}: 'instantiate.values.${key}.replacements.${file}' must be a list of strings`);
      }
      value.replacements[file] = literals;
    }
    values[key] = value;
  }
  return values;
}

function parseInstantiate(raw, manifestPath) {
  const source = raw ?? {};
  if (typeof source !== "object" || Array.isArray(source)) {
    throw new ConfigError(`${manifestPath}: 'instantiate' must be a map`);
  }
  let keep = [];
  if (source.keep !== undefined && source.keep !== null) {
    if (!Array.isArray(source.keep)) throw new ConfigError(`${manifestPath}: 'instantiate.keep' must be a list`);
    if (source.keep.some((item) => typeof item !== "string" || item === "")) {
      throw new ConfigError(`${manifestPath}: 'instantiate.keep' must be a list of strings`);
    }
    keep = source.keep;
  }
  return {
    name: instantiateString(source.name, manifestPath, "name"),
    lane: instantiateString(source.lane, manifestPath, "lane"),
    check: instantiateString(source.check, manifestPath, "check"),
    keep,
    values: parseInstantiateValues(source.values, manifestPath),
  };
}

export function loadManifest(manifestPath) {
  if (!existsSync(manifestPath)) throw new ConfigError(`manifest missing: ${manifestPath}`);
  const parsed = parseFile(manifestPath);
  const rawEntries = parsed?.entries ?? {};
  if (typeof rawEntries !== "object" || Array.isArray(rawEntries)) {
    throw new ConfigError(`${manifestPath}: 'entries' must be a map of path -> class`);
  }
  const entries = {};
  for (const [file, value] of Object.entries(rawEntries)) {
    const entry = typeof value === "string" ? { file, class: value } : { file, ...(value ?? {}) };
    if (typeof entry.class !== "string" || !CLASSES.has(entry.class)) {
      throw new ConfigError(`${manifestPath}: entry '${file}' has unknown class '${entry.class}' (expected ${[...CLASSES].join(", ")})`);
    }
    if (entry.pins !== undefined && !Array.isArray(entry.pins)) {
      throw new ConfigError(`${manifestPath}: entry '${file}' needs 'pins' as a list of dependency names`);
    }
    if (entry.sections !== undefined && !Array.isArray(entry.sections)) {
      throw new ConfigError(`${manifestPath}: entry '${file}' needs 'sections' as a list of TOML section names`);
    }
    entries[file] = entry;
  }
  const rawCheck = parsed?.check;
  const check = { command: null, timeoutSeconds: null };
  if (rawCheck != null) {
    if (typeof rawCheck !== "object" || Array.isArray(rawCheck)) {
      throw new ConfigError(`${manifestPath}: 'check' must be a map with a 'command'`);
    }
    if (typeof rawCheck.command !== "string" || rawCheck.command === "") {
      throw new ConfigError(`${manifestPath}: 'check.command' must be a non-empty string`);
    }
    check.command = rawCheck.command;
    if (rawCheck.timeout_seconds != null) {
      const seconds = Number(rawCheck.timeout_seconds);
      if (!Number.isFinite(seconds) || seconds <= 0) {
        throw new ConfigError(`${manifestPath}: 'check.timeout_seconds' must be a positive number`);
      }
      check.timeoutSeconds = seconds;
    }
  }
  return { entries, instantiate: parseInstantiate(parsed?.instantiate, manifestPath), check };
}

export function loadSentinel(sentinelPath) {
  const parsed = parseFile(sentinelPath);
  const source = parsed?.source;
  if (typeof source !== "string" || source === "") {
    throw new ConfigError(`sentinel ${sentinelPath}: missing 'source' (the scaffold this lane derives from)`);
  }
  const lane = typeof parsed?.lane === "string" && parsed.lane !== "" ? parsed.lane : basename(sentinelPath).replace(/\.ya?ml$/, "");
  const allow = [];
  if (parsed?.allow != null) {
    if (!Array.isArray(parsed.allow)) throw new ConfigError(`sentinel ${sentinelPath}: 'allow' must be a list`);
    for (const item of parsed.allow) {
      if (!item || typeof item.entry !== "string" || item.entry === "") {
        throw new ConfigError(`sentinel ${sentinelPath}: every 'allow' item needs an 'entry'`);
      }
      allow.push({
        entry: item.entry,
        reason: typeof item.reason === "string" ? item.reason : null,
        seenIn: typeof item.seen_in === "string" && item.seen_in !== "" ? item.seen_in : null,
      });
    }
  }
  const rawApplied = parsed?.applied;
  const applied = { revision: null, scaffoldSha: null };
  if (rawApplied != null) {
    if (typeof rawApplied !== "object" || Array.isArray(rawApplied)) {
      throw new ConfigError(`sentinel ${sentinelPath}: 'applied' must be a map with 'revision' and 'scaffold_sha'`);
    }
    if (rawApplied.revision != null) {
      applied.revision = Number(rawApplied.revision);
      if (!Number.isInteger(applied.revision) || applied.revision < 0) {
        throw new ConfigError(`sentinel ${sentinelPath}: applied.revision must be a non-negative integer`);
      }
    }
    if (rawApplied.scaffold_sha != null) {
      if (typeof rawApplied.scaffold_sha !== "string" || rawApplied.scaffold_sha === "") {
        throw new ConfigError(`sentinel ${sentinelPath}: applied.scaffold_sha must be a non-empty string (the scaffold commit)`);
      }
      applied.scaffoldSha = rawApplied.scaffold_sha;
    }
  }
  return { source, lane, allow, applied };
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

export function discoverProjects(environmentsPath, codeRoot) {
  const projects = [];
  for (const dirent of readdirSync(codeRoot, { withFileTypes: true })) {
    if (!dirent.isDirectory() || dirent.name.startsWith(".")) continue;
    const projectDir = join(codeRoot, dirent.name);
    if (resolve(projectDir) === resolve(environmentsPath)) continue;
    const sentinelDir = join(projectDir, ".salgadinhos");
    if (!existsSync(sentinelDir)) continue;
    const sentinels = readdirSync(sentinelDir)
      .filter((name) => /\.ya?ml$/.test(name) && name !== "manifest.yml")
      .sort();
    for (const file of sentinels) {
      const sentinelPath = join(sentinelDir, file);
      const sentinel = loadSentinel(sentinelPath);
      projects.push({ project: dirent.name, lane: sentinel.lane, source: sentinel.source, allow: sentinel.allow, sentinelPath });
    }
  }
  projects.sort((a, b) => a.project.localeCompare(b.project) || a.lane.localeCompare(b.lane));
  return projects;
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

function report(ctx, severity, message) {
  ctx.findings.push({ project: ctx.project, dir: ctx.dir, file: ctx.file, severity, message, allowed: ctx.isAllowed(ctx.file) });
}

const substitute = (ctx, text) => (ctx.placeholder ? applyPlaceholders(text, ctx.placeholder, ctx.project) : text);

function checkSame(ctx, entry) {
  // Both sides are substituted: a token the project legitimately carries (e.g. detekt's
  // `license.template`) must not read as drift. PR #33 did the same.
  const scaffoldText = substitute(ctx, readFileSync(ctx.scaffoldFile, "utf8"));
  const projectText = substitute(ctx, readFileSync(ctx.projectFile, "utf8"));
  // JSON files are compared structurally (formatting-only differences are not drift), and the
  // diff is direction-aware: keys only in the scaffold mean the project is behind, keys only in
  // the project mean it ran ahead.
  if (entry.file.endsWith(".json")) {
    try {
      const a = JSON.parse(scaffoldText);
      const b = JSON.parse(projectText);
      const [drift, ahead] = jsonDiff(a, b);
      for (const d of drift) report(ctx, "drift", `scaffold has ${d}, project does not`);
      for (const d of ahead) report(ctx, "ahead", `project has ${d}, scaffold does not (port back or add to scaffold)`);
      return;
    } catch {
      // falls through to text comparison
    }
  }
  if (norm(scaffoldText) !== norm(projectText)) {
    report(ctx, "drift", "differs from scaffold (normalized)");
  }
}

// Direction-aware comparison of two key -> pinned-value maps (dependency pins, version
// aliases). `labelOf` renders the key in the message; `staleNote` tailors the "missing in the
// project" case ("does not[ have it]").
function comparePinned(ctx, scaffold, project, labelOf, staleNote) {
  for (const key of new Set([...Object.keys(scaffold), ...Object.keys(project)])) {
    const inScaffold = scaffold[key];
    const inProject = project[key];
    if (inScaffold === undefined && inProject === undefined) continue;
    const label = labelOf(key);
    if (inScaffold !== undefined && inProject === undefined) {
      report(ctx, "drift", `${label}: scaffold pins ${inScaffold}, project does not${staleNote}`);
    } else if (inScaffold === undefined) {
      report(ctx, "ahead", `${label}: project pins ${inProject}, scaffold does not (port back or add to scaffold)`);
    } else if (inScaffold !== inProject) {
      report(ctx, "drift", `${label}: scaffold ${inScaffold} -> project ${inProject}`);
    }
  }
}

function checkDeps(ctx, entry) {
  const read = (path) => {
    let json;
    try {
      json = JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
      throw new ConfigError(`${path}: invalid JSON (${error.message})`);
    }
    const deps = { ...json.dependencies, ...json.devDependencies };
    return Object.fromEntries(entry.pins.filter((key) => key in deps).map((key) => [key, deps[key]]));
  };
  comparePinned(ctx, read(ctx.scaffoldFile), read(ctx.projectFile), (pin) => pin, " have it");
}

function checkVersions(ctx) {
  const scaffold = parseVersionCatalog(readFileSync(ctx.scaffoldFile, "utf8"));
  const project = parseVersionCatalog(readFileSync(ctx.projectFile, "utf8"));
  comparePinned(ctx, scaffold, project, (alias) => `version alias '${alias}'`, "");
}

function checkSections(ctx, entry) {
  // Only the scaffold side is substituted, matching PR #33: a leftover token in the project's
  // file is drift, not something to normalize away.
  const scaffold = parseTomlSections(substitute(ctx, readFileSync(ctx.scaffoldFile, "utf8")));
  const project = parseTomlSections(readFileSync(ctx.projectFile, "utf8"));
  for (const section of entry.sections) {
    const inScaffold = scaffold[section];
    const inProject = project[section];
    if (inScaffold === undefined && inProject === undefined) {
      report(ctx, "drift", `section [${section}] missing on both sides (stale config?)`);
    } else if (inScaffold !== undefined && inProject === undefined) {
      report(ctx, "drift", `section [${section}] exists in scaffold, missing in project`);
    } else if (inScaffold === undefined) {
      report(ctx, "ahead", `section [${section}] exists in project, not in scaffold (port back or add to scaffold)`);
    } else if (inScaffold !== inProject) {
      const a = inScaffold.split("\n");
      const b = inProject.split("\n");
      const diff = a.filter((line) => !b.includes(line)).concat(b.filter((line) => !a.includes(line)));
      report(ctx, "drift", `[${section}] differs: ${diff.slice(0, 6).join(" | ")}`);
    }
  }
}

function runEntry(ctx, entry, manifestPath) {
  if (entry.class === "judgment") return;
  if (!existsSync(ctx.scaffoldFile)) {
    throw new ConfigError(`scaffold file missing: ${ctx.scaffoldFile} (fix ${manifestPath})`);
  }
  if (!existsSync(ctx.projectFile)) {
    report(ctx, "drift", "missing in project, present in scaffold");
    return;
  }
  if (entry.class === "owned") return checkSame(ctx, entry);
  if (entry.class === "pinned") {
    if (Array.isArray(entry.pins)) return checkDeps(ctx, entry);
    if (entry.file.endsWith(".toml")) return checkVersions(ctx);
    throw new ConfigError(`entry '${entry.file}': pinned needs a 'pins' list or a TOML file`);
  }
  if (entry.class === "merge") {
    if (!Array.isArray(entry.sections) || entry.sections.length === 0) {
      throw new ConfigError(`entry '${entry.file}': merge needs a non-empty 'sections' list`);
    }
    return checkSections(ctx, entry);
  }
}

// A normative line of global/AGENTS.md copied verbatim into a project's AGENTS.md is a
// restatement: the project must hold at most a pointer back to the global.
function checkRestatements({ codeRoot, project, findings, allow, globalAgentsMd }) {
  if (!existsSync(globalAgentsMd)) {
    throw new ConfigError(`global AGENTS.md missing: ${globalAgentsMd} (pass --global-agents)`);
  }
  const globalLines = readFileSync(globalAgentsMd, "utf8")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(/^-\s*/, "").trim())
    .filter((line) => line.length >= 60 && /\b(never|must|always|do not)\b/i.test(line))
    .map((line) => line.toLowerCase());
  if (globalLines.length === 0) return;
  for (const agentsMd of [
    join(codeRoot, project, "AGENTS.md"),
    join(codeRoot, project, "backend", "AGENTS.md"),
    join(codeRoot, project, "frontend", "AGENTS.md"),
  ]) {
    if (!existsSync(agentsMd)) continue;
    const dir = relative(codeRoot, dirname(agentsMd)).split(sep).join("/");
    const relToProject = dir === project ? "AGENTS.md" : `${dir.slice(project.length + 1)}/AGENTS.md`;
    const isAllowed = () => allow.some((item) => item.entry === "AGENTS.md" || item.entry === relToProject);
    const body = readFileSync(agentsMd, "utf8").replace(/\r\n/g, "\n").toLowerCase();
    for (const line of globalLines) {
      if (body.includes(line)) {
        findings.push({
          project,
          dir,
          file: "AGENTS.md",
          severity: "restatement",
          message: `restates a global rule: "${line.slice(0, 70)}..." — keep a pointer, not a copy`,
          allowed: isAllowed(),
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export function runChecks({ environmentsPath, codeRoot, globalAgentsMd, onlyProject = null }) {
  const findings = [];
  let projects = discoverProjects(environmentsPath, codeRoot);
  if (onlyProject) projects = projects.filter((project) => project.project === onlyProject);

  const manifestCache = new Map();
  const manifestFor = (source) => {
    if (!manifestCache.has(source)) {
      const path = join(environmentsPath, source, ".salgadinhos", "manifest.yml");
      manifestCache.set(source, { path, manifest: loadManifest(path) });
    }
    return manifestCache.get(source);
  };

  let currentProject = null;
  for (const lane of projects) {
    if (lane.project !== currentProject) {
      currentProject = lane.project;
      const allow = projects.filter((project) => project.project === currentProject).flatMap((project) => project.allow);
      checkRestatements({ codeRoot, project: currentProject, findings, allow, globalAgentsMd });
    }
    const { path: manifestPath, manifest } = manifestFor(lane.source);
    for (const entry of Object.values(manifest.entries)) {
      runEntry(
        {
          project: lane.project,
          dir: lane.lane,
          file: entry.file,
          scaffoldFile: join(environmentsPath, lane.source, entry.file),
          projectFile: join(codeRoot, lane.project, lane.lane, entry.file),
          placeholder: manifest.instantiate.name,
          isAllowed: (file) => lane.allow.some((item) => item.entry === file),
          findings,
        },
        entry,
        manifestPath,
      );
    }
  }
  return { findings, projects };
}

const SEVERITY_TAG = { drift: "DRIFT", ahead: "AHEAD", restatement: "RESTATE" };

export function formatFindings(findings) {
  if (findings.length === 0) return { lines: ["template-check: no drift found."], exitCode: 0 };
  const blocking = findings.filter((finding) => finding.severity !== "ahead" && !finding.allowed);
  const allowed = findings.filter((finding) => finding.severity !== "ahead" && finding.allowed);
  const ahead = findings.filter((finding) => finding.severity === "ahead" && !finding.allowed);
  const lines = ["template-check findings:"];
  for (const finding of [...blocking, ...allowed, ...ahead]) {
    lines.push(`  [${SEVERITY_TAG[finding.severity]}] ${finding.project}/${finding.dir}/${finding.file}: ${finding.message}`);
  }
  lines.push("");
  lines.push(
    `  drift: ${blocking.length} blocking, ${allowed.length} allowed (see "allow" in the lane sentinel), ` +
      `${ahead.length} ahead-of-scaffold (report only)`,
  );
  lines.push("  For each finding decide: port scaffold -> project, port project -> scaffold, or allowlist with a reason.");
  return { lines, exitCode: blocking.length > 0 ? 1 : 0 };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = "usage: node tools/template-check.mjs [--code-root <dir>] [--project <name>] [--global-agents <file>]";

function parseArgs(argv) {
  const args = { codeRoot: null, project: null, globalAgentsMd: null };
  for (let i = 2; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--code-root") args.codeRoot = argv[++i];
    else if (flag === "--project") args.project = argv[++i];
    else if (flag === "--global-agents") args.globalAgentsMd = argv[++i];
    else if (flag === "--help" || flag === "-h") {
      console.log(USAGE);
      process.exit(0);
    } else {
      console.error(`[template-check] unknown argument '${flag}'`);
      console.error(USAGE);
      process.exit(2);
    }
  }
  return args;
}

// The code root holds this checkout as `environments/` plus the sibling project repos. Without
// --code-root the scaffolds come from this checkout itself and the code root is its parent;
// with it, the scratch tree is self-contained (`<code-root>/environments`).
export function resolveRoots(scriptPath, args) {
  const repoPath = dirname(dirname(scriptPath));
  if (args.codeRoot) {
    const codeRoot = resolve(args.codeRoot);
    return { codeRoot, environmentsPath: join(codeRoot, "environments") };
  }
  return { codeRoot: dirname(repoPath), environmentsPath: repoPath };
}

function main(argv) {
  const args = parseArgs(argv);
  const { codeRoot, environmentsPath } = resolveRoots(fileURLToPath(import.meta.url), args);
  const globalAgentsMd = args.globalAgentsMd ? resolve(args.globalAgentsMd) : join(codeRoot, "salgadinhos", "global", "AGENTS.md");
  try {
    const { findings, projects } = runChecks({ environmentsPath, codeRoot, globalAgentsMd, onlyProject: args.project });
    if (projects.length === 0) {
      console.log(`template-check: no project sentinels found under ${codeRoot} — nothing to check.`);
      process.exit(0);
    }
    const { lines, exitCode } = formatFindings(findings);
    for (const line of lines) console.log(line);
    process.exit(exitCode);
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`[template-check] ${error.message}`);
      process.exit(2);
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
