#!/usr/bin/env node
// Template propagation applier: takes a scaffold commit range recorded by each lane's
// `.salgadinhos/<lane>.yml` sentinel (`applied.scaffold_sha` -> the target commit) and applies the
// mechanical classes of that scaffold's manifest into the project — one PR per repo, never a push
// to the default branch.
//
// Class semantics (see environments/AGENTS.md, "Propagation: manifests, template-check and
// template-propagate"):
//   - `owned`:    overwrite the file with the scaffold's content (placeholder-substituted).
//   - `pinned`:   surgical edit — only the watched dependency pins / `[versions]` aliases move.
//   - `merge`:    replace only the listed TOML sections, leave the rest of the file untouched.
//   - `judgment`: outside the applier — reported so the porting skill can pick it up.
//
// A lane whose sentinel `allow`s an entry waives it: the entry is skipped and the pin still
// advances (renúncia), with `seen_in` stamped on the waiver the first time the applier sees it.
//
// `--bootstrap` is the other way a lane enters the flow: an existing project that predates the
// tooling has no sentinel on its default branch, so the lanes are named explicitly
// (`--project <name>` plus one `--lane <dir>=<source>` per lane) and the applier stamps each
// missing `.salgadinhos/<lane>.yml` (revision 1, pinned at the target commit, `allow: []`) on
// a branch of its own — one PR per repo, never a push to the default branch, and never a file
// outside `.salgadinhos/` touched. The bootstrap pins the lane at the target, so its queue
// starts empty and fills as the scaffold moves; re-runs find the sentinel already stamped and
// report the open PR instead of duplicating it.
//
// Flow per repo: clone -> branch -> apply every lane -> run each lane's declared fast check ->
// commit -> push branch -> open exactly one PR (`gh`). Dry-run (the default) stops before push.
//
// Usage:
//   node tools/template-propagate.mjs [--open-pr] [--dry-run] [--project <name>] [--to <sha>]
//                                     [--code-root <dir>] [--skip-check] [--keep-scratch]
//                                     [--check-timeout <seconds>]
//   node tools/template-propagate.mjs --bootstrap --open-pr --project <name>
//                                     --lane <dir>=<source> [--lane <dir>=<source> ...]
//
// Exit codes: 0 clean (including "nothing to propagate"), 1 a repo failed (fast check, push, PR),
// 2 global config error.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

import {
  ConfigError,
  applyPlaceholders,
  discoverProjects,
  loadManifest,
  loadSentinel,
  parseVersionCatalog,
  resolveRoots,
} from "./template-check.mjs";
import { sentinelText } from "./new-project.mjs";

export { ConfigError };

// ---------------------------------------------------------------------------
// Small text helpers
// ---------------------------------------------------------------------------

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const toLf = (text) => String(text).replace(/\r\n/g, "\n");

const dominantEol = (text) => (String(text).includes("\r\n") ? "\r\n" : "\n");

const withEol = (text, eol) => (eol === "\n" ? text : text.replace(/\n/g, "\r\n"));

const ensureTrailingNewline = (text) => (text === "" || text.endsWith("\n") ? text : `${text}\n`);

const shortSha = (sha) => sha.slice(0, 7);

// cmd.exe cannot run `./gradlew` (forward slashes are not a command-name path separator there);
// `gradlew` resolves to gradlew.bat through PATHEXT. POSIX keeps the `./`.
export function platformCommand(command) {
  if (process.platform === "win32" && command.startsWith("./")) return command.slice(2);
  return command;
}

// ---------------------------------------------------------------------------
// Class appliers: text -> text, plus a human summary of every change
// ---------------------------------------------------------------------------

function jsonPinPattern(pin) {
  return new RegExp(`"${escapeRegExp(pin)}"\\s*:\\s*("(?:[^"\\\\]|\\\\.)*")`);
}

function findJsonPin(text, pin) {
  const match = jsonPinPattern(pin).exec(text);
  return match ? JSON.parse(match[1]) : null;
}

function replaceJsonPin(text, pin, value) {
  return text.replace(jsonPinPattern(pin), (match, quoted) => match.replace(quoted, JSON.stringify(value)));
}

// Insert `"pin": "value"` as the first entry of the named JSON object, keeping the surrounding
// indentation. Returns null when the object cannot be located textually (caller reformats).
function insertJsonEntry(text, section, pin, value) {
  const header = new RegExp(`("${escapeRegExp(section)}"\\s*:\\s*\\{)`).exec(text);
  if (!header) return null;
  const after = text.slice(header.index + header[0].length);
  const firstEntry = after.match(/^\r?\n(\s+)"/);
  if (firstEntry) {
    const line = `${firstEntry[1]}${JSON.stringify(pin)}: ${JSON.stringify(value)},\n`;
    const insertAt = header.index + header[0].length + (after.startsWith("\r\n") ? 2 : 1);
    return text.slice(0, insertAt) + line + text.slice(insertAt);
  }
  const empty = after.match(/^\s*\}/);
  if (empty) {
    const lineStart = text.lastIndexOf("\n", header.index) + 1;
    const outerIndent = (text.slice(lineStart, header.index).match(/^[ \t]*/) ?? [""])[0];
    const innerIndent = `${outerIndent}  `;
    const openBrace = header.index + header[0].length - 1;
    const closeBrace = openBrace + 1 + empty[0].indexOf("}");
    const block = `{\n${innerIndent}${JSON.stringify(pin)}: ${JSON.stringify(value)}\n${outerIndent}}`;
    return text.slice(0, openBrace) + block + text.slice(closeBrace + 1);
  }
  return null;
}

// `pinned` on a JSON dependency map: only the `pins` watchlist moves. A pin the project is
// missing is added to the scaffold's section (dependencies/devDependencies).
export function applyJsonPins(scaffoldText, projectText, pins) {
  const scaffold = JSON.parse(scaffoldText);
  const hadProject = projectText != null && projectText.trim() !== "";
  let text = hadProject ? toLf(projectText) : "";
  const changes = [];
  const additions = [];
  for (const pin of pins) {
    const section =
      scaffold.dependencies?.[pin] !== undefined ? "dependencies" : scaffold.devDependencies?.[pin] !== undefined ? "devDependencies" : null;
    if (section === null) continue;
    const value = scaffold[section][pin];
    const found = hadProject ? findJsonPin(text, pin) : null;
    if (found === null) {
      additions.push({ pin, section, value });
      changes.push(`${pin} (added ${value})`);
    } else if (found !== value) {
      text = replaceJsonPin(text, pin, value);
      changes.push(`${pin} ${found} -> ${value}`);
    }
  }
  if (additions.length > 0) {
    if (text === "") {
      const object = {};
      for (const { pin, section, value } of additions) (object[section] ??= {})[pin] = value;
      text = `${JSON.stringify(object, null, 2)}\n`;
    } else {
      let inserted = true;
      for (const { pin, section, value } of additions) {
        const next = insertJsonEntry(text, section, pin, value);
        if (next === null) {
          inserted = false;
          break;
        }
        text = next;
      }
      if (!inserted) {
        const object = JSON.parse(text || "{}");
        for (const { pin, section, value } of additions) (object[section] ??= {})[pin] = value;
        text = `${JSON.stringify(object, null, 2)}\n`;
      }
    }
  }
  return { text, changes };
}

function findTomlAlias(text, wanted) {
  let inVersions = false;
  for (const line of toLf(text).split("\n")) {
    const header = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (header) {
      inVersions = header[1].trim() === "versions";
      continue;
    }
    if (!inVersions) continue;
    const alias = line.match(/^\s*([a-zA-Z0-9_-]+)\s*=\s*"([^"]*)"\s*$/);
    if (alias && alias[1] === wanted) return alias[2];
  }
  return null;
}

function replaceTomlAlias(text, alias, value) {
  const lines = toLf(text).split("\n");
  let inVersions = false;
  for (let i = 0; i < lines.length; i++) {
    const header = lines[i].match(/^\s*\[([^\]]+)\]\s*$/);
    if (header) {
      inVersions = header[1].trim() === "versions";
      continue;
    }
    if (!inVersions) continue;
    const match = lines[i].match(/^(\s*)([a-zA-Z0-9_-]+)\s*=\s*"([^"]*)"\s*$/);
    if (match && match[2] === alias) {
      lines[i] = `${match[1]}${alias} = ${JSON.stringify(value)}`;
      break;
    }
  }
  return lines.join("\n");
}

function insertTomlAliases(text, additions) {
  const newLines = additions.map(({ alias, value }) => `${alias} = ${JSON.stringify(value)}`);
  if (text === "") return `[versions]\n${newLines.join("\n")}\n`;
  const lines = toLf(text).split("\n");
  const start = lines.findIndex((line) => /^\s*\[versions\]\s*$/.test(line));
  if (start === -1) {
    const result = [...lines];
    if (result.length > 0 && result[result.length - 1].trim() !== "") result.push("");
    result.push("[versions]", ...newLines);
    return ensureTrailingNewline(result.join("\n"));
  }
  let end = start + 1;
  while (end < lines.length && !/^\s*\[/.test(lines[end])) end++;
  let insertAt = end;
  while (insertAt - 1 > start && lines[insertAt - 1].trim() === "") insertAt--;
  return [...lines.slice(0, insertAt), ...newLines, ...lines.slice(insertAt)].join("\n");
}

// `pinned` on a TOML version catalog: every `[versions]` alias of the scaffold moves.
export function applyTomlCatalog(scaffoldText, projectText) {
  const scaffold = parseVersionCatalog(scaffoldText);
  const hadProject = projectText != null && projectText.trim() !== "";
  let text = hadProject ? toLf(projectText) : "";
  const changes = [];
  const additions = [];
  for (const [alias, value] of Object.entries(scaffold)) {
    const found = hadProject ? findTomlAlias(text, alias) : null;
    if (found === null) {
      additions.push({ alias, value });
      changes.push(`${alias} (added ${value})`);
    } else if (found !== value) {
      text = replaceTomlAlias(text, alias, value);
      changes.push(`${alias} ${found} -> ${value}`);
    }
  }
  if (additions.length > 0) text = insertTomlAliases(text, additions);
  return { text, changes };
}

function findSection(lines, name) {
  const header = new RegExp(`^\\s*\\[\\s*${escapeRegExp(name)}\\s*\\]\\s*$`);
  const start = lines.findIndex((line) => header.test(line));
  if (start === -1) return null;
  let end = start + 1;
  while (end < lines.length && !/^\s*\[/.test(lines[end])) end++;
  return { start, end };
}

function sectionBody(lines, span) {
  const body = lines.slice(span.start + 1, span.end);
  while (body.length > 0 && body[body.length - 1].trim() === "") body.pop();
  return body;
}

// `merge`: replace the body of the listed TOML sections with the scaffold's; other sections,
// key order and comments outside them stay byte-for-byte.
export function applyTomlSections(scaffoldText, projectText, sections) {
  const scaffoldLines = toLf(scaffoldText).split("\n");
  let lines = toLf(projectText ?? "").split("\n");
  if (lines.length === 1 && lines[0] === "") lines = [];
  const changes = [];
  for (const name of sections) {
    const scaffoldSpan = findSection(scaffoldLines, name);
    if (!scaffoldSpan) throw new ConfigError(`manifest names section [${name}], scaffold has none`);
    const body = sectionBody(scaffoldLines, scaffoldSpan);
    const projectSpan = findSection(lines, name);
    if (!projectSpan) {
      if (lines.length > 0 && lines[lines.length - 1].trim() !== "") lines.push("");
      lines.push(`[${name}]`, ...body);
      changes.push(`[${name}] added`);
      continue;
    }
    if (body.join("\n") === sectionBody(lines, projectSpan).join("\n")) continue;
    const next = lines.slice(projectSpan.end);
    lines = [...lines.slice(0, projectSpan.start + 1), ...body];
    if (next.length > 0) lines.push("");
    lines.push(...next);
    changes.push(`[${name}] replaced`);
  }
  return { text: ensureTrailingNewline(lines.join("\n")), changes };
}

// ---------------------------------------------------------------------------
// Sentinel editing
// ---------------------------------------------------------------------------

// Bump `applied` (revision + scaffold_sha) in place and stamp `seen_in` on waivers the applier
// observed for the first time. Everything else in the sentinel is preserved byte-for-byte; only
// the creation tooling, the applier and (by renúncia) the project itself write this file.
export function updateSentinelText(text, { revision, scaffoldSha, observedAllows = [] }) {
  const eol = dominantEol(text);
  const lines = toLf(text).split("\n");
  const appliedStart = lines.findIndex((line) => /^applied\s*:\s*$/.test(line));
  if (appliedStart === -1) {
    while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    lines.push("applied:", `  revision: ${revision}`, `  scaffold_sha: ${scaffoldSha}`);
  } else {
    let end = appliedStart + 1;
    while (end < lines.length && /^\s+\S/.test(lines[end])) end++;
    const set = (key, value) => {
      const pattern = new RegExp(`^(\\s*)${key}\\s*:.*$`);
      const index = lines.findIndex((line, i) => i > appliedStart && i < end && pattern.test(line));
      if (index !== -1) lines[index] = `${pattern.exec(lines[index])[1]}${key}: ${value}`;
      else {
        lines.splice(end, 0, `  ${key}: ${value}`);
        end++;
      }
    };
    set("revision", revision);
    set("scaffold_sha", scaffoldSha);
  }
  for (const entry of observedAllows) {
    const start = lines.findIndex((line, i) => line.match(/^\s*-\s*entry\s*:/) && unquote(line.replace(/^\s*-\s*entry\s*:\s*/, "")) === entry);
    if (start === -1) continue;
    const indent = (lines[start].match(/^\s*/) ?? [""])[0].length;
    let end = start + 1;
    while (end < lines.length && lines[end].trim() !== "" && (lines[end].match(/^\s*/) ?? [""])[0].length > indent) end++;
    if (lines.slice(start + 1, end).some((line) => /^\s*seen_in\s*:/.test(line))) continue;
    const propertyIndent = end > start + 1 ? (lines[end - 1].match(/^\s*/) ?? [""])[0].length : indent + 2;
    lines.splice(end, 0, `${" ".repeat(propertyIndent)}seen_in: ${scaffoldSha}`);
  }
  return withEol(ensureTrailingNewline(lines.join("\n")), eol);
}

function unquote(value) {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

// ---------------------------------------------------------------------------
// GitHub remote helpers
// ---------------------------------------------------------------------------

export function parseGitHubRepo(remoteUrl) {
  const match = /(?:^|[@/])github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(String(remoteUrl).trim());
  return match ? `${match[1]}/${match[2]}` : null;
}

// ---------------------------------------------------------------------------
// git plumbing (the applier reads the scaffold history and works in a scratch
// clone; it never writes into a sibling checkout)
// ---------------------------------------------------------------------------

const DEFAULT_CHECK_TIMEOUT_SECONDS = 15 * 60;

function git(cwd, args, { env = process.env, allowFailure = false } = {}) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", env, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${(result.stderr || "").trim()}`);
  }
  return result;
}

function resolveCommit(environmentsPath, ref, env) {
  const result = git(environmentsPath, ["rev-parse", "--verify", `${ref}^{commit}`], { env, allowFailure: true });
  if (result.status !== 0) throw new ConfigError(`cannot resolve '${ref}' in ${environmentsPath}`);
  return result.stdout.trim();
}

function isAncestor(environmentsPath, ancestor, descendant, env) {
  const result = git(environmentsPath, ["merge-base", "--is-ancestor", ancestor, descendant], { env, allowFailure: true });
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw new ConfigError(`git merge-base failed: ${(result.stderr || "").trim()}`);
}

function changedScaffoldFiles(environmentsPath, source, pin, target, env) {
  const result = git(environmentsPath, ["diff", "--name-only", pin, target, "--", `${source}/`], { env });
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith(`${source}/`))
    .map((line) => line.slice(source.length + 1))
    .filter((file) => file !== "" && !file.startsWith(".salgadinhos/"));
}

function scaffoldTextAt(environmentsPath, target, source, file, env) {
  const result = git(environmentsPath, ["show", `${target}:${source}/${file}`], { env, allowFailure: true });
  if (result.status !== 0) throw new ConfigError(`scaffold file missing at ${shortSha(target)}: ${source}/${file}`);
  if (result.stdout.includes("\u0000")) throw new ConfigError(`${source}/${file} is binary; not a propagation candidate`);
  return toLf(result.stdout);
}

function originHead(cloneDir, env) {
  const result = git(cloneDir, ["rev-parse", "--abbrev-ref", "origin/HEAD"], { env, allowFailure: true });
  if (result.status !== 0) return null;
  const value = result.stdout.trim();
  return value.startsWith("origin/") ? value.slice("origin/".length) : value;
}

function runCheck({ command, cwd, timeoutSeconds, env }) {
  const startedAt = Date.now();
  const result = spawnSync(platformCommand(command), {
    cwd,
    shell: true,
    encoding: "utf8",
    timeout: timeoutSeconds * 1000,
    windowsHide: true,
    env,
  });
  const output = [result.stdout, result.stderr, result.error?.message].filter(Boolean).join("").trim();
  return {
    command,
    ok: result.status === 0,
    status: result.status ?? result.error?.code ?? "error",
    durationMs: Date.now() - startedAt,
    output,
  };
}

function tail(text, lines) {
  const all = String(text ?? "").split("\n");
  return all.slice(Math.max(0, all.length - lines));
}

// ---------------------------------------------------------------------------
// gh: the only remote-writing surface — one branch push and one PR per repo
// ---------------------------------------------------------------------------

function runGhDefault(args, input) {
  const result = spawnSync("gh", args, { encoding: "utf8", input, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) {
    throw new Error(`gh ${args.slice(0, 3).join(" ")} failed (exit ${result.status}): ${(result.stderr || "").trim()}`);
  }
  return result.stdout ?? "";
}

export class Gh {
  constructor({ run = runGhDefault } = {}) {
    this.run = run;
  }

  resolveRepo(originUrl) {
    const repo = parseGitHubRepo(originUrl);
    if (!repo) throw new ConfigError(`origin is not a GitHub remote (${originUrl}); the applier cannot open a PR there`);
    return repo;
  }

  defaultBranch(repo) {
    return this.run(["repo", "view", repo, "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"]).trim();
  }

  findOpenPr(repo, head) {
    const output = this.run(["pr", "list", "--repo", repo, "--head", head, "--state", "open", "--json", "url", "--jq", ".[0].url"]);
    return output.trim() || null;
  }

  createPr({ repo, base, head, title, body }) {
    const output = this.run(["pr", "create", "--repo", repo, "--base", base, "--head", head, "--title", title, "--body-file", "-"], body);
    return output.trim().split("\n").filter(Boolean).pop() ?? null;
  }
}

// ---------------------------------------------------------------------------
// Planning and applying a lane
// ---------------------------------------------------------------------------

function transformEntry({ entry, scaffoldText, projectText, token, name }) {
  const projectLf = projectText == null ? null : toLf(projectText);
  const scaffoldLf = toLf(scaffoldText);
  const substitute = (text) => (token ? applyPlaceholders(text, token, name) : text);
  if (entry.class === "owned") {
    const rendered = substitute(scaffoldLf);
    return projectLf === rendered ? { text: null, changes: [] } : { text: rendered, changes: ["overwrite"] };
  }
  const result =
    entry.class === "pinned" && entry.pins
      ? applyJsonPins(scaffoldLf, projectText, entry.pins)
      : entry.class === "pinned"
        ? applyTomlCatalog(scaffoldLf, projectText)
        : entry.class === "merge"
          ? applyTomlSections(substitute(scaffoldLf), projectText, entry.sections)
          : null;
  if (result === null) throw new ConfigError(`unknown class '${entry.class}'`);
  return result.changes.length > 0 ? result : { text: null, changes: [] };
}

// Mirror of the creation tooling's rule for naming a lane's sentinel file.
function sentinelFileName(lane) {
  return lane === "." ? "root" : lane.split(/[\\/]/).filter(Boolean).join("-");
}

function planLane({ laneSpec, cloneDir, environmentsPath, target, manifestFor, projectName, gitEnv, bootstrap = false }) {
  const sentinelPath = join(cloneDir, ".salgadinhos", laneSpec.sentinelFile);
  if (bootstrap) {
    if (existsSync(sentinelPath)) return null;
    manifestFor(laneSpec.source); // a bogus source must not get a stamped lineage
    return {
      lane: laneSpec.lane,
      source: laneSpec.source,
      sentinelFile: laneSpec.sentinelFile,
      pin: null,
      target,
      revision: 1,
      applies: [],
      skipped: [],
      unclassified: [],
      observedAllows: [],
      check: null,
      bootstrapped: true,
    };
  }
  if (!existsSync(sentinelPath)) {
    throw new ConfigError(`sentinel .salgadinhos/${laneSpec.sentinelFile} is not on the default branch — push the sentinel before propagating`);
  }
  const sentinel = loadSentinel(sentinelPath);
  const pin = sentinel.applied.scaffoldSha;
  if (!pin) throw new ConfigError(`sentinel .salgadinhos/${laneSpec.sentinelFile}: missing applied.scaffold_sha`);
  if (!isAncestor(environmentsPath, pin, target, gitEnv)) {
    throw new ConfigError(`pin ${shortSha(pin)} is not an ancestor of ${shortSha(target)} — scaffold history was rewritten?`);
  }
  const manifest = manifestFor(sentinel.source);
  const plan = {
    lane: laneSpec.lane,
    source: sentinel.source,
    sentinelFile: laneSpec.sentinelFile,
    pin,
    target,
    revision: (sentinel.applied.revision ?? 0) + 1,
    applies: [],
    skipped: [],
    unclassified: [],
    observedAllows: [],
    check: null,
  };
  if (pin === target) return plan;
  for (const file of changedScaffoldFiles(environmentsPath, sentinel.source, pin, target, gitEnv)) {
    const entry = manifest.entries[file];
    if (!entry) {
      plan.unclassified.push(file);
      continue;
    }
    const waiver = sentinel.allow.find((item) => item.entry === file);
    if (waiver) {
      if (!waiver.reason) throw new ConfigError(`sentinel allow for '${file}' needs a 'reason' — renúncia must say why`);
      plan.skipped.push({ file, reason: "allow", note: waiver.reason });
      if (!waiver.seenIn) plan.observedAllows.push(file);
      continue;
    }
    if (entry.class === "judgment") {
      plan.skipped.push({ file, reason: "judgment" });
      continue;
    }
    if (entry.class === "pinned" && !entry.pins && !file.endsWith(".toml")) {
      throw new ConfigError(`entry '${file}': pinned needs a 'pins' list or a TOML file`);
    }
    if (entry.class === "merge" && (!Array.isArray(entry.sections) || entry.sections.length === 0)) {
      throw new ConfigError(`entry '${file}': merge needs a non-empty 'sections' list`);
    }
    const scaffoldText = scaffoldTextAt(environmentsPath, target, sentinel.source, file, gitEnv);
    const projectPath = join(cloneDir, laneSpec.lane, file);
    const projectText = existsSync(projectPath) ? readFileSync(projectPath, "utf8") : null;
    const transformed = transformEntry({ entry, scaffoldText, projectText, token: manifest.instantiate.name, name: projectName });
    if (transformed.text === null) continue;
    mkdirSync(dirname(projectPath), { recursive: true });
    writeFileSync(projectPath, withEol(transformed.text, dominantEol(projectText ?? "")));
    plan.applies.push({ file, class: entry.class, changes: transformed.changes });
  }
  return plan;
}

function updateLaneSentinel(plan, cloneDir, target) {
  const sentinelPath = join(cloneDir, ".salgadinhos", plan.sentinelFile);
  const text = readFileSync(sentinelPath, "utf8");
  writeFileSync(sentinelPath, updateSentinelText(text, { revision: plan.revision, scaffoldSha: target, observedAllows: plan.observedAllows }));
}

function prBody(target, plans) {
  const lines = [`Propagated from environments@${shortSha(target)}.`, ""];
  for (const plan of plans) {
    if (plan.pin === target) continue;
    lines.push(`## ${plan.lane} (${plan.source})`, "");
    for (const apply of plan.applies) lines.push(`- \`${apply.file}\` — ${apply.class}: ${apply.changes.join(", ")}`);
    for (const skip of plan.skipped) {
      const note = skip.reason === "allow" ? `allowed${skip.note ? `: ${skip.note}` : ""}` : "judgment — route through the porting skill";
      lines.push(`- skipped \`${skip.file}\` — ${note}`);
    }
    for (const file of plan.unclassified) {
      lines.push(`- unclassified change \`${file}\` — not propagated; add a manifest entry if it should converge`);
    }
    if (plan.check?.command) lines.push("", `Fast check: \`${plan.check.command}\` — ${plan.check.ok ? "passed" : "FAILED"}.`);
    lines.push("");
  }
  lines.push(
    "---",
    "",
    "Opened by `tools/template-propagate.mjs` (one PR per repo; roll back by closing this PR).",
    "The applier never pushes to the base branch directly.",
    "",
  );
  return lines.join("\n");
}

// The bootstrap PR only adds sentinels; the body names each stamped lane and its pin.
function bootstrapPrBody(target, plans) {
  const lines = [
    `Lane sentinels stamped from environments@${shortSha(target)}: the baseline pin each lane's propagation queue starts from.`,
    "",
  ];
  for (const plan of plans) {
    lines.push(`## ${plan.lane} (${plan.source})`, "");
    lines.push(`- stamped \`.salgadinhos/${plan.sentinelFile}\` (revision 1, scaffold ${shortSha(target)})`, "");
  }
  lines.push(
    "---",
    "",
    "Opened by `tools/template-propagate.mjs --bootstrap` (one PR per repo; roll back by closing this PR).",
    "The applier never pushes to the base branch directly.",
    "",
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Repo / run orchestration
// ---------------------------------------------------------------------------

function runRepo({ project, lanes, environmentsPath, codeRoot, target, dryRun, skipCheck, checkTimeoutSeconds, gh, scratchDir, gitEnv, bootstrap = false }) {
  const report = { project, status: "no-op", originUrl: null, branch: null, base: null, prUrl: null, error: null, lanes: [] };
  const siblingDir = join(codeRoot, project);
  report.originUrl = git(siblingDir, ["remote", "get-url", "origin"], { env: gitEnv }).stdout.trim();
  const cloneDir = join(scratchDir, project);
  git(scratchDir, ["clone", "--quiet", report.originUrl, cloneDir], { env: gitEnv });

  const manifests = new Map();
  const manifestFor = (source) => {
    if (!manifests.has(source)) {
      manifests.set(source, loadManifest(join(environmentsPath, source, ".salgadinhos", "manifest.yml")));
    }
    return manifests.get(source);
  };

  // A re-run lands on the branch the previous run pushed (the clone carries every remote head),
  // so its sentinels are the ones to plan against: already-applied lanes read as at-target and
  // the push stays a fast-forward instead of being rejected as non-fast-forward.
  report.branch = bootstrap ? "salgadinhos/bootstrap-sentinels" : `salgadinhos/propagate-${shortSha(target)}`;
  report.base = originHead(cloneDir, gitEnv);
  const branchExists = git(cloneDir, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${report.branch}`], { env: gitEnv, allowFailure: true }).status === 0;
  if (branchExists) git(cloneDir, ["checkout", "--quiet", "-B", report.branch, `origin/${report.branch}`], { env: gitEnv });
  else git(cloneDir, ["checkout", "--quiet", "-b", report.branch], { env: gitEnv });

  const plans = lanes
    .map((laneSpec) => planLane({ laneSpec, cloneDir, environmentsPath, target, manifestFor, projectName: project, gitEnv, bootstrap }))
    .filter((plan) => plan !== null);
  report.lanes = plans;
  if (plans.every((plan) => plan.pin === target)) {
    if (branchExists && !dryRun) {
      const repo = gh.resolveRepo(report.originUrl);
      report.prUrl = gh.findOpenPr(repo, report.branch);
      report.status = report.prUrl ? "pr-exists" : "no-op";
    }
    return report;
  }
  for (const plan of plans) {
    if (plan.bootstrapped) {
      const sentinelPath = join(cloneDir, ".salgadinhos", plan.sentinelFile);
      mkdirSync(dirname(sentinelPath), { recursive: true });
      writeFileSync(sentinelPath, sentinelText({ source: plan.source, lane: plan.lane, scaffoldSha: target, note: "bootstrap" }), "utf8");
    } else {
      updateLaneSentinel(plan, cloneDir, target);
    }
  }

  let failed = false;
  for (const plan of plans) {
    if (plan.pin === target || plan.applies.length === 0) continue;
    const manifest = manifestFor(plan.source);
    if (skipCheck || !manifest.check.command) {
      plan.check = { command: manifest.check.command, ok: true, skipped: true, status: 0, durationMs: 0, output: "" };
      continue;
    }
    const timeoutSeconds = checkTimeoutSeconds ?? manifest.check.timeoutSeconds ?? DEFAULT_CHECK_TIMEOUT_SECONDS;
    plan.check = runCheck({ command: manifest.check.command, cwd: join(cloneDir, plan.lane), timeoutSeconds, env: process.env });
    if (!plan.check.ok) failed = true;
  }
  if (failed) {
    report.status = "check-failed";
    return report;
  }

  git(cloneDir, ["add", "-A"], { env: gitEnv });
  if (git(cloneDir, ["diff", "--cached", "--name-only"], { env: gitEnv }).stdout.trim() === "") return report;
  const title = bootstrap ? `Bootstrap lane sentinels (environments@${shortSha(target)})` : `Propagate scaffold updates (environments@${shortSha(target)})`;
  const body = bootstrap ? bootstrapPrBody(target, plans) : prBody(target, plans);
  git(cloneDir, ["commit", "--quiet", "-m", title, "-m", body], { env: gitEnv });
  if (dryRun) {
    report.status = "dry-run";
    return report;
  }

  git(cloneDir, ["push", "--quiet", "origin", `HEAD:refs/heads/${report.branch}`], { env: gitEnv });
  const repo = gh.resolveRepo(report.originUrl);
  report.base = report.base ?? gh.defaultBranch(repo);
  const existing = gh.findOpenPr(repo, report.branch);
  if (existing) {
    report.status = "pr-exists";
    report.prUrl = existing;
  } else {
    report.prUrl = gh.createPr({ repo, base: report.base, head: report.branch, title, body });
    report.status = "pr-opened";
  }
  return report;
}

export function runPropagate(options = {}) {
  const {
    environmentsPath,
    codeRoot,
    target: targetRef = null,
    onlyProject = null,
    bootstrapLanes = null,
    dryRun = true,
    skipCheck = false,
    checkTimeoutSeconds = null,
    scratchRoot = tmpdir(),
    keepScratch = false,
    gh = new Gh(),
    gitEnv = process.env,
  } = options;
  if (!environmentsPath || !codeRoot) throw new ConfigError("runPropagate needs environmentsPath and codeRoot");
  if (bootstrapLanes) {
    if (!onlyProject) throw new ConfigError("--bootstrap needs --project <name>");
    if (bootstrapLanes.length === 0) throw new ConfigError("--bootstrap needs at least one --lane <dir>=<source>");
  }
  const target = resolveCommit(environmentsPath, targetRef ?? "HEAD", gitEnv);
  const byProject = new Map();
  if (bootstrapLanes) {
    byProject.set(onlyProject, bootstrapLanes.map(({ dir, source }) => ({ lane: dir, source, sentinelFile: `${sentinelFileName(dir)}.yml` })));
  } else {
    const discovered = discoverProjects(environmentsPath, codeRoot);
    const selected = onlyProject ? discovered.filter((lane) => lane.project === onlyProject) : discovered;
    for (const lane of selected) {
      if (!byProject.has(lane.project)) byProject.set(lane.project, []);
      byProject.get(lane.project).push({ lane: lane.lane, sentinelFile: basename(lane.sentinelPath) });
    }
  }

  const scratchDir = mkdtempSync(join(scratchRoot, "template-propagate-"));
  const repos = [];
  for (const [project, lanes] of byProject) {
    try {
      repos.push(runRepo({ project, lanes, environmentsPath, codeRoot, target, dryRun, skipCheck, checkTimeoutSeconds, gh, scratchDir, gitEnv, bootstrap: bootstrapLanes != null }));
    } catch (error) {
      repos.push({ project, status: "error", originUrl: null, branch: null, base: null, prUrl: null, error: error.message, lanes: [] });
    }
  }
  const failures = repos.filter((repo) => repo.status === "error" || repo.status === "check-failed").length;
  const keep = keepScratch || failures > 0;
  if (!keep) rmSync(scratchDir, { recursive: true, force: true });
  return { target: { sha: target, short: shortSha(target) }, repos, failures, dryRun, scratch: keep ? scratchDir : null };
}

export function formatRun(result) {
  const lines = [`template-propagate: target environments@${result.target.short}${result.dryRun ? " (dry run)" : ""}`];
  if (result.repos.length === 0) lines.push("  no lane sentinels found — nothing to propagate.");
  for (const repo of result.repos) {
    lines.push(`${repo.project}:`);
    if (repo.status === "error") {
      lines.push(`  [FAIL] ${repo.error}`);
      continue;
    }
    if (repo.status === "no-op") {
      lines.push("  everything already at the target.");
      continue;
    }
    for (const lane of repo.lanes) {
      if (lane.bootstrapped) {
        lines.push(`  stamp  .salgadinhos/${lane.sentinelFile} (${lane.source}, revision 1, scaffold ${result.target.short})`);
        continue;
      }
      if (lane.pin === result.target.sha) continue;
      lines.push(`  ${lane.lane} (${lane.source}, revision ${lane.revision}):`);
      for (const apply of lane.applies) lines.push(`    apply  ${apply.file} (${apply.class}: ${apply.changes.join(", ")})`);
      for (const skip of lane.skipped) lines.push(`    skip   ${skip.file} (${skip.reason}${skip.note ? `: ${skip.note}` : ""})`);
      for (const file of lane.unclassified) lines.push(`    report ${file} (changed in the scaffold, not in the manifest)`);
      if (lane.check) {
        const detail = lane.check.skipped ? "skipped" : lane.check.ok ? `ok, ${lane.check.durationMs}ms` : `FAILED (exit ${lane.check.status})`;
        lines.push(`    check  ${lane.check.command ?? "(none declared)"} (${detail})`);
        if (!lane.check.ok && !lane.check.skipped) {
          for (const line of tail(lane.check.output, 20)) lines.push(`    | ${line}`);
        }
      }
    }
    if (repo.status === "dry-run") lines.push(`  would open PR ${repo.branch} -> ${repo.base ?? "default"}`);
    else if (repo.status === "pr-opened") lines.push(`  opened PR ${repo.prUrl}`);
    else if (repo.status === "pr-exists") lines.push(`  PR already open: ${repo.prUrl}`);
    else if (repo.status === "check-failed") lines.push("  [FAIL] fast check failed — no push, no PR.");
  }
  lines.push(`template-propagate: ${result.failures} failure(s)${result.scratch ? `; scratch kept at ${result.scratch}` : ""}.`);
  return lines;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE =
  "usage: node tools/template-propagate.mjs [--open-pr] [--dry-run] [--project <name>] [--to <sha>] " +
  "[--code-root <dir>] [--skip-check] [--keep-scratch] [--check-timeout <seconds>]\n" +
  "       node tools/template-propagate.mjs --bootstrap --open-pr --project <name> --lane <dir>=<source> [--lane ...]\n\n" +
  "  --open-pr        push the propagation branch and open one PR per repo (default: dry run)\n" +
  "  --dry-run        apply + fast check in a scratch clone, open nothing\n" +
  "  --to <sha>       scaffold commit to propagate up to (default: this checkout's HEAD)\n" +
  "  --project <name> only this sibling project\n" +
  "  --code-root <dir>  project family checkout (default: this repo's parent)\n" +
  "  --skip-check     skip the lane fast checks declared in the manifest\n" +
  "  --check-timeout <seconds>  override check.timeout_seconds / the 15 min default\n" +
  "  --keep-scratch   keep the scratch clones (failures keep them anyway)\n" +
  "  --bootstrap      stamp .salgadinhos/<lane>.yml for a project that has none (one PR per repo;\n" +
  "                   never touches anything outside .salgadinhos/)\n" +
  "  --lane <dir>=<source>  a lane to bootstrap (repeatable; needs --bootstrap)";

function parseLaneSpec(value) {
  const eq = value.indexOf("=");
  if (eq <= 0 || eq === value.length - 1) return null;
  return { dir: value.slice(0, eq), source: value.slice(eq + 1) };
}

function parseArgs(argv) {
  const args = { codeRoot: null, project: null, to: null, dryRun: true, skipCheck: false, keepScratch: false, checkTimeoutSeconds: null, bootstrap: false, lanes: [] };
  let openPr = false;
  let explicitDryRun = false;
  for (let i = 2; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--code-root") args.codeRoot = argv[++i];
    else if (flag === "--project") args.project = argv[++i];
    else if (flag === "--to") args.to = argv[++i];
    else if (flag === "--open-pr") openPr = true;
    else if (flag === "--dry-run") explicitDryRun = true;
    else if (flag === "--skip-check") args.skipCheck = true;
    else if (flag === "--keep-scratch") args.keepScratch = true;
    else if (flag === "--check-timeout") args.checkTimeoutSeconds = Number(argv[++i]);
    else if (flag === "--bootstrap") args.bootstrap = true;
    else if (flag === "--lane") {
      const spec = parseLaneSpec(argv[++i]);
      if (spec === null) {
        console.error("[template-propagate] --lane needs <dir>=<source>, e.g. --lane backend=kotlin");
        process.exit(2);
      }
      args.lanes.push(spec);
    } else if (flag === "--help" || flag === "-h") {
      console.log(USAGE);
      process.exit(0);
    } else {
      console.error(`[template-propagate] unknown argument '${flag}'`);
      console.error(USAGE);
      process.exit(2);
    }
  }
  if (openPr && explicitDryRun) {
    console.error("[template-propagate] --open-pr and --dry-run are mutually exclusive");
    process.exit(2);
  }
  if (args.checkTimeoutSeconds !== null && (!Number.isFinite(args.checkTimeoutSeconds) || args.checkTimeoutSeconds <= 0)) {
    console.error("[template-propagate] --check-timeout needs a positive number of seconds");
    process.exit(2);
  }
  if (args.lanes.length > 0 && !args.bootstrap) {
    console.error("[template-propagate] --lane needs --bootstrap");
    process.exit(2);
  }
  if (args.bootstrap && !args.project) {
    console.error("[template-propagate] --bootstrap needs --project <name>");
    process.exit(2);
  }
  if (args.bootstrap && args.lanes.length === 0) {
    console.error("[template-propagate] --bootstrap needs at least one --lane <dir>=<source>");
    process.exit(2);
  }
  args.dryRun = !openPr;
  return args;
}

function main(argv) {
  const args = parseArgs(argv);
  const { codeRoot, environmentsPath } = resolveRoots(fileURLToPath(import.meta.url), args);
  try {
    const result = runPropagate({
      environmentsPath,
      codeRoot,
      target: args.to,
      onlyProject: args.project,
      bootstrapLanes: args.bootstrap ? args.lanes : null,
      dryRun: args.dryRun,
      skipCheck: args.skipCheck,
      keepScratch: args.keepScratch,
      checkTimeoutSeconds: args.checkTimeoutSeconds,
    });
    for (const line of formatRun(result)) console.log(line);
    process.exit(result.failures > 0 ? 1 : 0);
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`[template-propagate] ${error.message}`);
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
