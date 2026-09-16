#!/usr/bin/env node
// Template drift check: reads each project's `.salgadinhos/<lane>.yml` sentinel and compares the
// lane against its scaffold (`source` in the sentinel; manifest from this checkout). Detection
// has two views, both computed at each manifest entry's declared granularity:
//   - queue:  the scaffold at the applied pin vs the scaffold now — what the applier would bring
//             to the lane (DRIFT, blocking unless `allow`ed).
//   - lane:   the lane's files vs the scaffold at the applied pin — edits the lane made on its
//             own since it applied the pin (AHEAD, report-only: port back or declare an `allow`).
// Plus a restatement check: a normative line of salgadinhos/global/AGENTS.md must not appear
// verbatim in a project's own AGENTS.md (a restatement is a drift point).
//
// Sources of truth (nothing is hardcoded here):
//   - `environments/<stack>/.salgadinhos/manifest.yml` — `entries` (path -> class) and
//     `instantiate` (the scaffold's own name token).
//   - `<project>/.salgadinhos/<lane>.yml` — sentinel: `source`, `lane`, `applied` (the pin,
//     `scaffold_sha`), `allow`. Projects are discovered by globbing for these.
//   - The environments checkout's git history — the pin side of the queue and lane views.
//
// What it compares, derived from each entry's class:
//   - `owned`:      whole-file equality after normalization (CRLF -> LF, trimmed, whitespace
//                   collapsed; JSON files are compared structurally).
//   - `pinned`:     a `pins` watchlist in a JSON dependency map, or every `[versions]` alias of
//                   a TOML version catalog.
//   - `merge`:      named `[tool.*]` sections of a TOML file, line-normalized.
//   - `judgment`:   not mechanical — skipped here; goes through the porting skill.
//
// Read-only: it never applies anything, like `template-sync`. Findings are direction-aware —
// DRIFT (the propagation queue: scaffold moved since the applied pin), AHEAD (the lane diverged
// from its applied pin — port back, or record an `allow` in the sentinel with a reason),
// RESTATE. Exit codes: 0 clean, 1 blocking drift, 2 config error.
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
import { spawnSync } from "node:child_process";

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

// Deep-compare two JSON values. Returns structured items: paths present only on the left
// (`left-only`), only on the right (`right-only`) and value changes (`changed`), with both
// values attached so a view can render its own message.
export function jsonDiff(a, b, path = "", out = []) {
  if (JSON.stringify(a) === JSON.stringify(b)) return out;
  const bothObjects = a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) === !Array.isArray(b);
  if (!bothObjects) {
    out.push({
      path,
      kind: a === undefined ? "right-only" : b === undefined ? "left-only" : "changed",
      left: a === undefined ? null : a,
      right: b === undefined ? null : b,
    });
    return out;
  }
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    jsonDiff(a[k], b[k], path ? `${path}.${k}` : k, out);
  }
  return out;
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
      projects.push({ project: dirent.name, lane: sentinel.lane, source: sentinel.source, allow: sentinel.allow, applied: sentinel.applied, sentinelPath });
    }
  }
  projects.sort((a, b) => a.project.localeCompare(b.project) || a.lane.localeCompare(b.lane));
  return projects;
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------
// Detection reads two views per manifest entry, both at the entry's declared granularity:
//   - queue (pin vs scaffold head): what moved in the scaffold since the lane applied its pin —
//     the propagation queue the applier drains. Reported as DRIFT, blocking unless `allow`ed.
//   - lane (lane vs pin): what the lane itself edited since it applied the pin. Reported as
//     AHEAD, report-only: port back, or declare the divergence in the sentinel's `allow`.
// The pin side comes from `git show <pin>:<source>/<file>` in the environments checkout; the
// head side from the checkout itself.

function report(ctx, severity, message) {
  ctx.findings.push({ project: ctx.project, dir: ctx.dir, file: ctx.file, severity, message, allowed: ctx.isAllowed(ctx.file) });
}

const LANE_SUFFIX = " (local edit - port back, or declare it in allow)";

const json = (value) => JSON.stringify(value);

// One directional comparison at the entry's granularity. `left` is the reference side (the
// applied pin), `right` the moving side (scaffold head, or the lane). Messages say which view
// they belong to: the queue view keeps the DRIFT phrasing, the lane view appends LANE_SUFFIX.
function compareOwned(entry, view, left, right, emit) {
  const side = view === "lane" ? "lane" : "scaffold";
  const suffix = view === "lane" ? LANE_SUFFIX : "";
  if (left == null && right != null) return emit(`${side} added this file since the applied pin${suffix}`);
  if (left != null && right == null) {
    return emit(view === "lane" ? `lane removed this file since the applied pin${LANE_SUFFIX}` : `scaffold dropped this file since the applied pin`);
  }
  if (left == null) return;
  if (entry.file.endsWith(".json")) {
    let a = null;
    let b = null;
    try {
      a = JSON.parse(left);
      b = JSON.parse(right);
    } catch {
      // falls through to text comparison
    }
    if (a !== null && b !== null) {
      for (const item of jsonDiff(a, b)) {
        if (item.kind === "right-only") emit(`${side} added ${item.path} since the applied pin${suffix}`);
        else if (item.kind === "left-only") emit(`${side} dropped ${item.path} since the applied pin${suffix}`);
        else emit(`${side} ${item.path}: ${json(item.left)} -> ${json(item.right)} since the applied pin${suffix}`);
      }
      return;
    }
  }
  if (norm(left) !== norm(right)) {
    emit(view === "lane" ? `lane diverged from the applied pin${LANE_SUFFIX}` : "scaffold changed since the applied pin");
  }
}

// Direction-aware comparison of two key -> value maps (dependency pins, version aliases) at the
// view's granularity. `labelOf` renders the key in the message.
function comparePinned(view, left, right, labelOf, emit) {
  const side = view === "lane" ? "lane" : "scaffold";
  const suffix = view === "lane" ? LANE_SUFFIX : "";
  for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
    const inLeft = left[key];
    const inRight = right[key];
    if (inLeft === undefined && inRight === undefined) continue;
    const label = labelOf(key);
    if (inLeft !== undefined && inRight === undefined) emit(`${side} dropped ${label} ${inLeft} since the applied pin${suffix}`);
    else if (inLeft === undefined) emit(`${side} added ${label} ${inRight} since the applied pin${suffix}`);
    else if (inLeft !== inRight) emit(`${side} ${label}: ${inLeft} -> ${inRight} since the applied pin${suffix}`);
  }
}

function sectionDiff(leftLines, rightLines) {
  return leftLines.filter((line) => !rightLines.includes(line)).concat(rightLines.filter((line) => !leftLines.includes(line)));
}

function compareMerge(view, leftSections, rightSections, sections, emit) {
  const side = view === "lane" ? "lane" : "scaffold";
  const suffix = view === "lane" ? LANE_SUFFIX : "";
  for (const section of sections) {
    const inLeft = leftSections[section];
    const inRight = rightSections[section];
    if (inLeft === undefined && inRight === undefined) {
      if (view === "queue") emit(`[${section}] missing on both sides (stale config?)`);
      continue;
    }
    if (inLeft === undefined) emit(`${side} added [${section}] since the applied pin${suffix}`);
    else if (inRight === undefined) emit(`${side} dropped [${section}] since the applied pin${suffix}`);
    else if (inLeft !== inRight) {
      const detail = sectionDiff(inLeft.split("\n"), inRight.split("\n")).slice(0, 6).join(" | ");
      emit(
        view === "lane"
          ? `lane [${section}] differs from the applied pin: ${detail}${LANE_SUFFIX}`
          : `scaffold [${section}] changed since the applied pin: ${detail}`,
      );
    }
  }
}

function parsePinnedDeps(text, path) {
  if (text == null) return {};
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ConfigError(`${path}: invalid JSON (${error.message})`);
  }
  return { ...parsed.dependencies, ...parsed.devDependencies };
}

// The entry's reference side (the applied pin) and its two moving sides (scaffold head, lane),
// substituted where the class expects it, compared in both views.
function compareEntryViews(ctx, entry, { pin, head, project }) {
  const substitute = (text) => (text != null && ctx.placeholder ? applyPlaceholders(text, ctx.placeholder, ctx.project) : text);
  const queue = [];
  const lane = [];
  const emit = (view) => (message) => (view === "queue" ? queue : lane).push(message);

  if (entry.class === "owned") {
    compareOwned(entry, "queue", substitute(pin), substitute(head), emit("queue"));
    compareOwned(entry, "lane", substitute(pin), substitute(project), emit("lane"));
  } else if (entry.class === "pinned") {
    if (Array.isArray(entry.pins)) {
      const watched = (text, label) => {
        const deps = parsePinnedDeps(text, label);
        return Object.fromEntries(entry.pins.filter((key) => key in deps).map((key) => [key, deps[key]]));
      };
      comparePinned("queue", watched(pin, `${ctx.scaffoldFile}@pin`), watched(head, ctx.scaffoldFile), (key) => key, emit("queue"));
      comparePinned("lane", watched(pin, `${ctx.scaffoldFile}@pin`), watched(project, ctx.projectFile), (key) => key, emit("lane"));
    } else if (entry.file.endsWith(".toml")) {
      comparePinned("queue", parseVersionCatalog(pin ?? ""), parseVersionCatalog(head ?? ""), (alias) => `version alias '${alias}'`, emit("queue"));
      comparePinned("lane", parseVersionCatalog(pin ?? ""), parseVersionCatalog(project ?? ""), (alias) => `version alias '${alias}'`, emit("lane"));
    } else {
      throw new ConfigError(`entry '${entry.file}': pinned needs a 'pins' list or a TOML file`);
    }
  } else if (entry.class === "merge") {
    if (!Array.isArray(entry.sections) || entry.sections.length === 0) {
      throw new ConfigError(`entry '${entry.file}': merge needs a non-empty 'sections' list`);
    }
    compareMerge("queue", parseTomlSections(substitute(pin) ?? ""), parseTomlSections(substitute(head) ?? ""), entry.sections, emit("queue"));
    compareMerge("lane", parseTomlSections(substitute(pin) ?? ""), parseTomlSections(project ?? ""), entry.sections, emit("lane"));
  } else {
    throw new ConfigError(`entry '${entry.file}': unknown class '${entry.class}'`);
  }
  return { queue, lane };
}

function runEntry(ctx, entry, manifestPath) {
  if (entry.class === "judgment") return;
  if (!existsSync(ctx.scaffoldFile)) {
    throw new ConfigError(`scaffold file missing: ${ctx.scaffoldFile} (fix ${manifestPath})`);
  }
  const head = readFileSync(ctx.scaffoldFile, "utf8");
  const pin = ctx.readAtPin(entry.file);
  const project = existsSync(ctx.projectFile) ? readFileSync(ctx.projectFile, "utf8") : null;
  const { queue, lane } = compareEntryViews(ctx, entry, { pin, head, project });
  for (const message of queue) report(ctx, "drift", message);
  for (const message of lane) report(ctx, "ahead", message);
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

export function runChecks({ environmentsPath, codeRoot, globalAgentsMd, onlyProject = null, gitEnv = process.env }) {
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

  // The pin side of both views: the scaffold content at the commit the sentinel applied, read
  // from the environments checkout's history.
  const pinCache = new Map();
  const showCache = new Map();
  const gitShow = (args) => spawnSync("git", args, { cwd: environmentsPath, encoding: "utf8", env: gitEnv, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  const pinReader = {
    resolve(pin) {
      if (!pinCache.has(pin)) {
        const result = gitShow(["rev-parse", "--verify", `${pin}^{commit}`]);
        if (result.status !== 0) {
          throw new ConfigError(`cannot resolve the applied pin '${pin}' in ${environmentsPath} (scaffold history rewritten?)`);
        }
        pinCache.set(pin, result.stdout.trim());
      }
      return pinCache.get(pin);
    },
    show(pin, rel) {
      const key = `${pin}:${rel}`;
      if (!showCache.has(key)) {
        const result = gitShow(["show", `${pin}:${rel}`]);
        showCache.set(key, result.status === 0 ? result.stdout : null);
      }
      return showCache.get(key);
    },
  };

  let currentProject = null;
  for (const lane of projects) {
    if (lane.project !== currentProject) {
      currentProject = lane.project;
      const allow = projects.filter((project) => project.project === currentProject).flatMap((project) => project.allow);
      checkRestatements({ codeRoot, project: currentProject, findings, allow, globalAgentsMd });
    }
    const { path: manifestPath, manifest } = manifestFor(lane.source);
    const pin = lane.applied?.scaffoldSha;
    if (!pin) {
      throw new ConfigError(`sentinel ${lane.sentinelPath}: detection needs applied.scaffold_sha (the applier stamps it)`);
    }
    pinReader.resolve(pin);
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
          readAtPin: (file) => pinReader.show(pin, `${lane.source}/${file}`),
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
      `${ahead.length} lane divergence (report only)`,
  );
  lines.push("  For each finding decide: drain the queue with the applier, port back, or allowlist with a reason.");
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
