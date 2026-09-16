#!/usr/bin/env node
// Sweep advisory: the pin-vs-target propagation queue of every discovered lane, rendered as
// (a) a per-PR sticky comment ("advisory", non-blocking: it never gates a merge) and (b) the
// weekly judgment issue (at most one open per week, marked with an HTML comment marker).
//
// The workflow (.github/workflows/template-sweep.yml) drives it in two phases:
//
//   node tools/sweep-advisory.mjs --collect --code-root <dir> --output <file>   # read-only
//   node tools/sweep-advisory.mjs --apply --input <file>                        # gh writes
//
// `runCollect` never writes: it reads sentinels from the sibling project checkouts, the
// manifests from the scaffolds, and computes each lane's queue as the scaffold's changes
// between the lane's pin and the target commit, classified by the manifest's class. `runApply`
// performs the only writes: sticky comments on open PRs (created or patched in place, matched
// by the marker line) and the weekly judgment issue.
//
// Exit codes: 0 clean (also when there is nothing to advise), 2 config error.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

import {
  ConfigError,
  discoverProjects,
  loadManifest,
  loadSentinel,
  resolveRoots,
} from "./template-check.mjs";
import {
  changedScaffoldFiles,
  isAncestor,
  parseGitHubRepo,
  resolveCommit,
} from "./template-propagate.mjs";

export { ConfigError };

export const ADVISORY_MARKER = "<!-- template-sweep advisory -->";
export const WEEKLY_MARKER = "<!-- template-sweep weekly -->";
export const JUDGMENT_LABEL = "template-sync";

const NO_PIN = "no applied.scaffold_sha — bootstrap pending";
const PIN_UNRESOLVABLE = "pin not resolvable in this checkout — scaffold history rewritten or too shallow?";

// ---------------------------------------------------------------------------
// Small git plumbing (read-only)
// ---------------------------------------------------------------------------

function git(cwd, args, { allowFailure = false, env = process.env } = {}) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", env, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  if (!allowFailure && result.status !== 0) {
    throw new ConfigError(`git ${args.join(" ")} failed in ${cwd}: ${(result.stderr || "").trim()}`);
  }
  return result;
}

function originOf(projectDir) {
  const result = git(projectDir, ["remote", "get-url", "origin"], { allowFailure: true });
  if (result.status !== 0) return null;
  return result.stdout.trim() || null;
}

function commitsBehind(environmentsPath, pin, target, source, gitEnv) {
  const result = git(environmentsPath, ["rev-list", "--count", `${pin}..${target}`, "--", `${source}/`], {
    env: gitEnv,
  });
  return Number(result.stdout.trim());
}

// ---------------------------------------------------------------------------
// ISO week (the judgment issue is keyed on it)
// ---------------------------------------------------------------------------

export function isoWeekOf(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// The queue: what the scaffold gained since the lane's pin, classified
// ---------------------------------------------------------------------------

function emptyQueue() {
  return { applies: [], judgment: [], unclassified: [], waived: [] };
}

// changed scaffold files between the lane's pin and the target, classified by the manifest:
//   applies       mechanical classes the applier carries (owned / pinned / merge)
//   judgment      judgment-class entries — go through the porting skill, never the applier
//   unclassified  changed in the scaffold, not watched by the manifest (curation decision)
//   waived        declared divergence in the lane's sentinel (`allow`) — renúncia, excluded
export function classifyFiles(files, { manifest, allow = [] }) {
  const queue = emptyQueue();
  for (const file of files) {
    const waiver = allow.find((item) => item.entry === file);
    if (waiver) {
      queue.waived.push({ file, reason: waiver.reason ?? "no reason recorded" });
      continue;
    }
    const entry = manifest.entries[file];
    if (!entry) {
      queue.unclassified.push(file);
    } else if (entry.class === "judgment") {
      queue.judgment.push(file);
    } else {
      queue.applies.push({ file, class: entry.class });
    }
  }
  return queue;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function pluralCommits(behind) {
  return `${behind} commit${behind === 1 ? "" : "s"}`;
}

// A queue that drained since the last advisory: patched in place so a stale "N commits behind"
// never lingers on an open PR. Same marker, minimal body.
export function renderCurrent(result, project) {
  const repoLabel = result.sweepRepo ?? "environments";
  return [
    ADVISORY_MARKER,
    "",
    `## Scaffold propagation advisory — ${project.project}`,
    "",
    `Target \`${repoLabel}@${result.short}\` · ${result.week} · all lanes at their pin — nothing queued.`,
    "",
    "---",
    "advisory only — merging is not blocked. Opened/updated by the weekly template sweep.",
    "",
  ].join("\n");
}

// The sticky advisory comment for one project (repo = project.project on GitHub).
export function renderAdvisory(result, project) {
  const repoLabel = result.sweepRepo ?? "environments";
  const lines = [
    ADVISORY_MARKER,
    "",
    `## Scaffold propagation advisory — ${project.project}`,
    "",
    `Target \`${repoLabel}@${result.short}\` · ${result.week} · non-blocking.`,
    "",
  ];
  for (const lane of project.lanes) {
    if (lane.behind === 0 && !lane.stale) continue;
    lines.push(`### ${lane.lane} (${lane.source}) — ${lane.stale ? "pin not comparable" : `${pluralCommits(lane.behind)} behind the pin`}`, "");
    if (lane.stale) {
      lines.push(`- stale: ${lane.stale}`, "");
      continue;
    }
    if (lane.queue.applies.length > 0) {
      lines.push(`- mechanical: ${lane.queue.applies.map((apply) => `\`${apply.file}\` (${apply.class})`).join(", ")}`);
    }
    if (lane.queue.judgment.length > 0) {
      lines.push(`- judgment: ${lane.queue.judgment.map((file) => `\`${file}\``).join(", ")} — routes through the porting skill (\`template-sync\`), not the applier`);
    }
    if (lane.queue.waived.length > 0) {
      lines.push(`- waived (renúncia): ${lane.queue.waived.map((item) => `\`${item.file}\` — ${item.reason}`).join(", ")}`);
    }
    if (lane.queue.unclassified.length > 0) {
      lines.push(`- unclassified: ${lane.queue.unclassified.map((file) => `\`${file}\``).join(", ")} — not watched; add a manifest entry if it should converge`);
    }
    lines.push(
      "",
      "Apply the mechanical queue with, from the `environments` checkout:",
      "",
      "```",
      `node tools/template-propagate.mjs --open-pr --project ${project.project} --to ${result.short}`,
      "```",
      "",
    );
  }
  lines.push(
    "---",
    "advisory only — merging is not blocked. Opened/updated by the weekly template sweep; renúncia = an `allow` entry in the lane sentinel, always with a reason.",
    "",
  );
  return lines.join("\n");
}

export function renderJudgmentIssue(result) {
  if (!result.judgment) return null;
  const lines = [
    WEEKLY_MARKER,
    "",
    `## Judgment sweep ${result.week}`,
    "",
    "The mechanical sweep found judgment-class and unclassified scaffold changes. Resolve them with the porting skill (`template-sync`): audit, decide, port (one PR per repo, origin and rationale in the body), verify, record.",
    "",
    ...result.judgment.lanes.map((item) => `- ${item.project} / ${item.lane}: \`${item.file}\` (${item.kind})`),
    "",
    "Close this issue once every item has landed as a PR or a declared waiver (sentinel `allow` with a reason).",
    "",
    `_Queue as of environments@${result.short}._`,
    "",
  ];
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Collect: read-only; never talks to GitHub
// ---------------------------------------------------------------------------

export function runCollect({
  environmentsPath,
  codeRoot,
  onlyProject = null,
  target = null,
  sweepRepo = null,
  now = new Date(),
  gitEnv = process.env,
}) {
  const resolvedTarget = resolveCommit(environmentsPath, target ?? "HEAD", gitEnv);
  const week = isoWeekOf(now);
  const result = {
    target: resolvedTarget,
    short: resolvedTarget.slice(0, 7),
    week,
    sweepRepo,
    projects: [],
    judgment: null,
  };
  const discovered = discoverProjects(environmentsPath, codeRoot);
  const selected = onlyProject ? discovered.filter((lane) => lane.project === onlyProject) : discovered;

  const manifestCache = new Map();
  const manifestFor = (source) => {
    if (!manifestCache.has(source)) {
      manifestCache.set(source, loadManifest(join(environmentsPath, source, ".salgadinhos", "manifest.yml")));
    }
    return manifestCache.get(source);
  };

  const byProject = new Map();
  for (const lane of selected) {
    if (!byProject.has(lane.project)) byProject.set(lane.project, []);
    byProject.get(lane.project).push(lane);
  }

  const judgmentItems = [];
  for (const [project, lanes] of byProject) {
    const repo = parseGitHubRepo(originOf(join(codeRoot, project)));
    const laneResults = [];
    for (const laneSpec of lanes) {
      const sentinel = loadSentinel(laneSpec.sentinelPath);
      const pin = sentinel.applied.scaffoldSha;
      const manifest = manifestFor(laneSpec.source);
      let behind = null;
      let stale = null;
      let queue = emptyQueue();
      if (!pin) {
        stale = NO_PIN;
      } else {
        let ancestor;
        try {
          ancestor = isAncestor(environmentsPath, pin, resolvedTarget, gitEnv);
        } catch {
          ancestor = false;
        }
        if (!ancestor) {
          stale = PIN_UNRESOLVABLE;
        } else {
          behind = commitsBehind(environmentsPath, pin, resolvedTarget, laneSpec.source, gitEnv);
          queue = classifyFiles(
            changedScaffoldFiles(environmentsPath, laneSpec.source, pin, resolvedTarget, gitEnv),
            { manifest, allow: laneSpec.allow },
          );
        }
      }
      for (const file of queue.judgment) {
        judgmentItems.push({ project, lane: laneSpec.lane, file, kind: "judgment" });
      }
      for (const file of queue.unclassified) {
        judgmentItems.push({ project, lane: laneSpec.lane, file, kind: "unclassified" });
      }
      laneResults.push({
        lane: laneSpec.lane,
        source: laneSpec.source,
        pin: pin ?? null,
        behind,
        stale,
        queue,
      });
    }
    const hasAdvice = laneResults.some(
      (lane) => lane.stale !== null || lane.behind > 0 || lane.queue.applies.length > 0 || lane.queue.judgment.length > 0 || lane.queue.unclassified.length > 0,
    );
    const projectResult = {
      project,
      repo,
      lanes: laneResults,
      commentBody: null,
    };
    if (hasAdvice && repo) projectResult.commentBody = renderAdvisory(result, projectResult);
    result.projects.push(projectResult);
  }

  if (judgmentItems.length > 0) {
    result.judgment = { week, title: `Judgment sweep ${week}`, lanes: judgmentItems };
  }
  return result;
}

// ---------------------------------------------------------------------------
// Apply: the only writes — sticky PR comments + the weekly judgment issue
// ---------------------------------------------------------------------------

function runGhDefault(args, input) {
  const result = spawnSync("gh", args, { encoding: "utf8", input, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) {
    throw new ConfigError(`gh ${args.slice(0, 3).join(" ")} failed (exit ${result.status}): ${(result.stderr || "").trim()}`);
  }
  return result.stdout ?? "";
}

export class SweepGh {
  constructor({ run = runGhDefault } = {}) {
    this.run = run;
  }

  listOpenPrs(repo) {
    return JSON.parse(this.run(["pr", "list", "--repo", repo, "--state", "open", "--json", "number,headRefName,title"]) || "[]");
  }

  prComments(repo, number) {
    const view = JSON.parse(this.run(["pr", "view", String(number), "--repo", repo, "--json", "comments"]) || "{}");
    return (view.comments ?? []).map((comment) => ({ id: comment.id, body: comment.body ?? "" }));
  }

  createPrComment(repo, number, body) {
    return this.run(["pr", "comment", String(number), "--repo", repo, "--body-file", "-"], body).trim();
  }

  updatePrComment(repo, commentId, body) {
    this.run(["api", "-X", "PATCH", `repos/${repo}/issues/comments/${commentId}`, "-F", "body=@-"], body);
  }

  listIssues(repo, label) {
    return JSON.parse(this.run(["issue", "list", "--repo", repo, "--label", label, "--state", "open", "--json", "number,title"]) || "[]");
  }

  createIssue(repo, { title, body, label }) {
    return this.run(["issue", "create", "--repo", repo, "--title", title, "--label", label, "--body-file", "-"], body).trim();
  }

  ensureLabel(repo, label) {
    this.run([
      "label",
      "create",
      label,
      "--repo",
      repo,
      "--color",
      "1d76db",
      "--description",
      "Weekly template-sweep work order for the template-sync porting skill",
      "--force",
    ]);
  }
}

export function runApply(result, { gh = new SweepGh(), openIssue = false } = {}) {
  const created = [];
  const updated = [];
  for (const project of result.projects) {
    if (!project.repo) continue;
    const prs = gh.listOpenPrs(project.repo).filter((pr) => !pr.headRefName.startsWith("salgadinhos/"));
    for (const pr of prs) {
      const sticky = gh.prComments(project.repo, pr.number).find((comment) => comment.body.includes(ADVISORY_MARKER));
      if (!sticky) {
        if (!project.commentBody) continue;
        gh.createPrComment(project.repo, pr.number, project.commentBody);
        created.push({ repo: project.repo, number: pr.number });
      } else {
        const body = project.commentBody ?? renderCurrent(result, project);
        if (sticky.body !== body) {
          gh.updatePrComment(project.repo, sticky.id, body);
          updated.push({ repo: project.repo, number: pr.number });
        }
      }
    }
  }

  let issue = { created: false, url: null };
  if (openIssue && result.judgment && result.sweepRepo) {
    const open = gh.listIssues(result.sweepRepo, JUDGMENT_LABEL);
    const existing = open.find((item) => item.title === result.judgment.title);
    if (!existing) {
      gh.ensureLabel(result.sweepRepo, JUDGMENT_LABEL);
      const url = gh.createIssue(result.sweepRepo, {
        title: result.judgment.title,
        body: renderJudgmentIssue(result),
        label: JUDGMENT_LABEL,
      });
      issue = { created: true, url };
    }
  }
  return { comments: { created, updated }, issue };
}

// ---------------------------------------------------------------------------
// Report / parsing
// ---------------------------------------------------------------------------

export function formatRun(result) {
  const lines = [`sweep-advisory: target environments@${result.short} (${result.week})`];
  for (const project of result.projects) {
    for (const lane of project.lanes) {
      if (lane.stale) {
        lines.push(`  ${project.project}/${lane.lane} (${lane.source}): ${lane.stale}`);
      } else if (lane.behind === 0) {
        lines.push(`  ${project.project}/${lane.lane} (${lane.source}): at the pin`);
      } else {
        lines.push(
          `  ${project.project}/${lane.lane} (${lane.source}): ${pluralCommits(lane.behind)} behind — ` +
            `mechanical ${lane.queue.applies.length}, judgment ${lane.queue.judgment.length}, unclassified ${lane.queue.unclassified.length}`,
        );
      }
    }
  }
  const laneCount = result.judgment ? new Set(result.judgment.lanes.map((item) => `${item.project}/${item.lane}`)).size : 0;
  lines.push(`judgment queue: ${laneCount} lane(s) with work — issue pending/created at apply`);
  return lines;
}

export function parseCollect(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ConfigError(`sweep-advisory: collect file is not JSON (${error.message})`);
  }
  if (!parsed || typeof parsed !== "object" || typeof parsed.target !== "string" || !Array.isArray(parsed.projects)) {
    throw new ConfigError("sweep-advisory: collect file is missing 'target' or 'projects'");
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = [
  "usage:",
  "  node tools/sweep-advisory.mjs --collect [--code-root <dir>] [--project <name>] [--to <sha>]",
  "                                    [--sweep-repo <owner/repo>] --output <file>",
  "  node tools/sweep-advisory.mjs --apply [--issue] --input <file>",
  "",
  "  --collect      read-only: compute the queue and render every advisory body",
  "  --apply        the writes: sticky comments (and with --issue, the weekly judgment issue)",
].join("\n");

function parseArgs(argv) {
  const args = { codeRoot: null, project: null, to: null, sweepRepo: null, output: null, input: null, collect: false, apply: false, issue: false };
  for (let i = 2; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--collect") args.collect = true;
    else if (flag === "--apply") args.apply = true;
    else if (flag === "--issue") args.issue = true;
    else if (flag === "--code-root") args.codeRoot = argv[++i];
    else if (flag === "--project") args.project = argv[++i];
    else if (flag === "--to") args.to = argv[++i];
    else if (flag === "--sweep-repo") args.sweepRepo = argv[++i];
    else if (flag === "--output") args.output = argv[++i];
    else if (flag === "--input") args.input = argv[++i];
    else if (flag === "--help" || flag === "-h") {
      console.log(USAGE);
      process.exit(0);
    } else {
      console.error(`[sweep-advisory] unknown argument '${flag}'`);
      console.error(USAGE);
      process.exit(2);
    }
  }
  if (args.collect === args.apply) {
    console.error("[sweep-advisory] exactly one of --collect or --apply is required");
    process.exit(2);
  }
  if (args.collect && !args.output) {
    console.error("[sweep-advisory] --collect needs --output <file>");
    process.exit(2);
  }
  if (args.apply && !args.input) {
    console.error("[sweep-advisory] --apply needs --input <file>");
    process.exit(2);
  }
  return args;
}

function main(argv) {
  const args = parseArgs(argv);
  const { codeRoot, environmentsPath } = resolveRoots(fileURLToPath(import.meta.url), args);
  try {
    if (args.collect) {
      const result = runCollect({
        environmentsPath,
        codeRoot,
        onlyProject: args.project,
        target: args.to,
        sweepRepo: args.sweepRepo ?? process.env.GITHUB_REPOSITORY ?? null,
      });
      writeFileSync(args.output, `${JSON.stringify(result, null, 2)}\n`);
      for (const line of formatRun(result)) console.log(line);
      process.exit(0);
    }
    const collect = parseCollect(readFileSync(args.input, "utf8"));
    const applied = runApply(collect, { gh: new SweepGh(), openIssue: args.issue });
    console.log(
      `sweep-advisory: comments created ${applied.comments.created.length}, updated ${applied.comments.updated.length}; ` +
        `judgment issue ${applied.issue.created ? `created ${applied.issue.url}` : "already open / none this week"}`,
    );
    process.exit(0);
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`[sweep-advisory] ${error.message}`);
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
