import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

import {
  formatRun,
  isoWeekOf,
  parseCollect,
  renderAdvisory,
  renderCurrent,
  renderJudgmentIssue,
  runApply,
  runCollect,
} from "./sweep-advisory.mjs";

// ---------------------------------------------------------------------------
// Fixtures: a git-backed environments checkout (three scaffold commits), plain
// sibling project dirs carrying lane sentinels, and a fake in-memory gh.
// ---------------------------------------------------------------------------

const NOW = new Date("2026-09-16T12:00:00Z");

const TEST_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "sweep-test",
  GIT_AUTHOR_EMAIL: "sweep-test@example.com",
  GIT_COMMITTER_NAME: "sweep-test",
  GIT_COMMITTER_EMAIL: "sweep-test@example.com",
};

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

const MANIFEST = [
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
].join("\n");

// environments/react moves from pin (v1) to target (v2): two mechanical files,
// one judgment entry, one unclassified file. `advance()` adds a third commit so
// a second collect renders a different body.
function environmentsFixture(base) {
  const dir = join(base, "environments");
  writeFiles(dir, {
    "react/.salgadinhos/manifest.yml": MANIFEST,
    "react/package.json": `${JSON.stringify({ name: "template-fe", dependencies: { react: "^18.2.0" } }, null, 2)}\n`,
    "react/biome.json": '{ "formatter": { "lineWidth": 100 } }\n',
    "react/notes.md": "v1\n",
    "react/changelog.md": "old\n",
  });
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "scaffold v1"]);
  const pin = git(dir, ["rev-parse", "HEAD"]);
  writeFiles(dir, {
    "react/package.json": `${JSON.stringify({ name: "template-fe", dependencies: { react: "^19.0.0" } }, null, 2)}\n`,
    "react/biome.json": '{ "formatter": { "lineWidth": 120 } }\n',
    "react/notes.md": "v2\n",
    "react/changelog.md": "new\n",
  });
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "scaffold v2"]);
  const target = git(dir, ["rev-parse", "HEAD"]);
  const advance = () => {
    writeFiles(dir, { "react/biome.json": '{ "formatter": { "lineWidth": 130 } }\n' });
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-qm", "scaffold v3"]);
    return git(dir, ["rev-parse", "HEAD"]);
  };
  return { dir, pin, target, advance };
}

function sentinelText({ source = "react", lane = "frontend", scaffoldSha, allow = [] }) {
  let text = `source: ${source}\nlane: ${lane}\n`;
  if (scaffoldSha) text += `applied:\n  revision: 1\n  scaffold_sha: ${scaffoldSha}\n`;
  if (allow.length > 0) {
    text += "allow:\n";
    for (const item of allow) text += `  - entry: ${item.entry}\n    reason: ${JSON.stringify(item.reason)}\n`;
  }
  return text;
}

function projectFixture(base, { name, lanes, origin = `https://github.com/luiznaac/${name}.git` }) {
  const dir = join(base, name);
  const files = {};
  for (const lane of lanes) files[`.salgadinhos/${lane.name}.yml`] = lane.sentinel;
  writeFiles(dir, files);
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["remote", "add", "origin", origin]);
  return dir;
}

function fakeGh({ prs = {} } = {}) {
  const calls = [];
  let commentId = 100;
  let issueNumber = 40;
  const gh = {
    calls,
    issues: [],
    // repo -> [{ number, headRefName, title, _comments: [{ id, body }] }]
    listOpenPrs(repo) {
      calls.push(["listOpenPrs", repo]);
      return (prs[repo] ?? []).map(({ _comments, ...rest }) => rest);
    },
    prComments(repo, number) {
      calls.push(["prComments", repo, number]);
      return (prs[repo] ?? []).find((pr) => pr.number === number)?._comments ?? [];
    },
    createPrComment(repo, number, body) {
      calls.push(["createPrComment", repo, number]);
      const pr = prs[repo]?.find((pr) => pr.number === number);
      if (pr) pr._comments = [...(pr._comments ?? []), { id: ++commentId, body }];
      return commentId;
    },
    updatePrComment(repo, id, body) {
      calls.push(["updatePrComment", repo, id]);
      for (const pr of prs[repo] ?? []) {
        const comment = (pr._comments ?? []).find((comment) => comment.id === id);
        if (comment) comment.body = body;
      }
    },
    listIssues(repo, label) {
      calls.push(["listIssues", repo, label]);
      return gh.issues.filter((issue) => issue.label === label);
    },
    createIssue(repo, spec) {
      calls.push(["createIssue", repo, spec.title]);
      const number = ++issueNumber;
      gh.issues.push({ number, title: spec.title, body: spec.body, label: spec.label, url: `https://example.test/${repo}/issues/${number}` });
      return `https://example.test/${repo}/issues/${number}`;
    },
    ensureLabel(repo, label) {
      calls.push(["ensureLabel", repo, label]);
    },
  };
  return gh;
}

function makeFamily(base) {
  const { dir, pin, target, advance } = environmentsFixture(base);
  projectFixture(base, {
    name: "chameidor",
    lanes: [{ name: "frontend", sentinel: sentinelText({ scaffoldSha: pin }) }],
  });
  projectFixture(base, {
    name: "portfolio-2",
    lanes: [{ name: "frontend", sentinel: sentinelText({ scaffoldSha: target }) }],
  });
  projectFixture(base, {
    name: "label-follower",
    lanes: [{ name: "backend", sentinel: sentinelText({ scaffoldSha: "not-a-ancestor" }) }],
  });
  projectFixture(base, {
    name: "shougong",
    lanes: [{ name: "frontend", sentinel: sentinelText({ scaffoldSha: null }) }],
  });
  return { environmentsPath: dir, codeRoot: base, pin, target, advance };
}

function collect(base, { to = null, sweepRepo = "luiznaac/environments" } = {}) {
  const family = makeFamily(base);
  const result = runCollect({
    environmentsPath: family.environmentsPath,
    codeRoot: family.codeRoot,
    target: to ?? family.target,
    sweepRepo,
    now: NOW,
  });
  return { family, result };
}

// ---------------------------------------------------------------------------
// isoWeekOf
// ---------------------------------------------------------------------------

test("isoWeekOf: anchors ISO weeks, including the year-boundary edge", () => {
  assert.equal(isoWeekOf(new Date("2026-09-16T12:00:00Z")), "2026-W38");
  assert.equal(isoWeekOf(new Date("2026-12-28T12:00:00Z")), "2026-W53");
  assert.equal(isoWeekOf(new Date("2027-01-01T12:00:00Z")), "2026-W53");
});

// ---------------------------------------------------------------------------
// runCollect
// ---------------------------------------------------------------------------

test("runCollect: queues pin..target changes per lane, classified by manifest class", () => {
  const base = mkdtempSync(join(tmpdir(), "sweep-advisory-"));
  try {
    const { result } = collect(base);
    assert.equal(result.projects.length, 4);
    const chameidor = result.projects.find((project) => project.project === "chameidor");
    assert.equal(chameidor.repo, "luiznaac/chameidor");
    const lane = chameidor.lanes[0];
    assert.equal(lane.lane, "frontend");
    assert.equal(lane.source, "react");
    assert.equal(lane.behind, 1);
    assert.deepEqual(
      lane.queue.applies.map((apply) => [apply.file, apply.class]),
      [
        ["biome.json", "owned"],
        ["package.json", "pinned"],
      ],
    );
    assert.deepEqual(lane.queue.judgment, ["notes.md"]);
    assert.deepEqual(lane.queue.unclassified, ["changelog.md"]);
    assert.ok(chameidor.commentBody, "a project with a GitHub remote gets an advisory body");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("runCollect: a project whose origin is not a GitHub remote gets no advisory comment", () => {
  const base = mkdtempSync(join(tmpdir(), "sweep-advisory-noremote-"));
  try {
    const family = makeFamily(base);
    rmSync(join(base, "chameidor"), { recursive: true, force: true });
    rmSync(join(base, "portfolio-2"), { recursive: true, force: true });
    rmSync(join(base, "label-follower"), { recursive: true, force: true });
    rmSync(join(base, "shougong"), { recursive: true, force: true });
    projectFixture(base, {
      name: "chameidor",
      origin: "git@example.com:elsewhere/chameidor.git",
      lanes: [{ name: "frontend", sentinel: sentinelText({ scaffoldSha: family.pin }) }],
    });
    const result = runCollect({
      environmentsPath: family.environmentsPath,
      codeRoot: family.codeRoot,
      target: family.target,
      sweepRepo: "luiznaac/environments",
      now: NOW,
    });
    const chameidor = result.projects.find((project) => project.project === "chameidor");
    assert.equal(chameidor.repo, null, "a non-GitHub origin cannot receive comments");
    assert.equal(chameidor.commentBody, null);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("runCollect: waived entries are renúncia, not mechanical work", () => {
  const base = mkdtempSync(join(tmpdir(), "sweep-advisory-waive-"));
  try {
    const family = makeFamily(base);
    rmSync(join(base, "chameidor"), { recursive: true, force: true });
    rmSync(join(base, "portfolio-2"), { recursive: true, force: true });
    rmSync(join(base, "label-follower"), { recursive: true, force: true });
    rmSync(join(base, "shougong"), { recursive: true, force: true });
    projectFixture(base, {
      name: "chameidor",
      lanes: [{ name: "frontend", sentinel: sentinelText({ scaffoldSha: family.pin, allow: [{ entry: "biome.json", reason: "divergence by design" }] }) }],
    });
    const result = runCollect({
      environmentsPath: family.environmentsPath,
      codeRoot: family.codeRoot,
      target: family.target,
      sweepRepo: "luiznaac/environments",
      now: NOW,
    });
    const lane = result.projects[0].lanes[0];
    assert.deepEqual(lane.queue.applies, [["package.json", "pinned"]].map(([file, clas]) => ({ file, class: clas })));
    assert.deepEqual(lane.queue.waived, [{ file: "biome.json", reason: "divergence by design" }]);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("runCollect: renders the advisory body with the queue, the applier command and the marker", () => {
  const base = mkdtempSync(join(tmpdir(), "sweep-advisory-"));
  try {
    const { result } = collect(base);
    assert.equal(result.short, result.target.slice(0, 7));
    const chameidor = result.projects.find((project) => project.project === "chameidor");
    const body = renderAdvisory(result, chameidor);
    assert.match(body, /<!-- template-sweep advisory -->/);
    assert.match(body, /## Scaffold propagation advisory — chameidor/);
    assert.match(body, /environments@[0-9a-f]{7}/);
    assert.match(body, /### frontend \(react\) — 1 commit behind the pin/);
    assert.match(body, /- mechanical: `biome\.json` \(owned\), `package\.json` \(pinned\)/);
    assert.match(body, /- judgment: `notes\.md`/);
    assert.match(body, /- unclassified: `changelog\.md`/);
    assert.match(body, /node tools\/template-propagate\.mjs --open-pr --project chameidor --to [0-9a-f]{7}/);
    assert.match(body, /advisory only — merging is not blocked/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("runCollect: a lane at the pin has nothing queued and projects with no findings get no comment", () => {
  const base = mkdtempSync(join(tmpdir(), "sweep-advisory-"));
  try {
    const { result } = collect(base);
    const portfolio = result.projects.find((project) => project.project === "portfolio-2");
    assert.equal(portfolio.lanes[0].behind, 0);
    assert.deepEqual(portfolio.lanes[0].queue.applies, []);
    assert.equal(portfolio.commentBody, null, "nothing queued — no advisory comment");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("runCollect: stale and missing pins are reported as such instead of failing the sweep", () => {
  const base = mkdtempSync(join(tmpdir(), "sweep-advisory-"));
  try {
    const { result } = collect(base);
    const label = result.projects.find((project) => project.project === "label-follower");
    const shougong = result.projects.find((project) => project.project === "shougong");
    assert.equal(label.lanes[0].stale, "pin not resolvable in this checkout — scaffold history rewritten or too shallow?");
    assert.deepEqual(label.lanes[0].queue.applies, []);
    assert.equal(shougong.lanes[0].stale, "no applied.scaffold_sha — bootstrap pending");
    assert.equal(shougong.lanes[0].behind, null);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("runCollect: the weekly judgment issue carries judgment and unclassified work only", () => {
  const base = mkdtempSync(join(tmpdir(), "sweep-advisory-"));
  try {
    const { result } = collect(base);
    const body = renderJudgmentIssue(result);
    assert.match(body, /<!-- template-sweep weekly -->/);
    assert.match(body, /## Judgment sweep 2026-W38/);
    assert.match(body, /chameidor \/ frontend: `notes\.md` \(judgment\)/);
    assert.match(body, /chameidor \/ frontend: `changelog\.md` \(unclassified\)/);
    assert.doesNotMatch(body, /biome\.json/);
    assert.match(body, /template-sync/);
    assert.match(body, /Close this issue/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("runCollect: a week with no judgment or unclassified work renders no issue body", () => {
  const base = mkdtempSync(join(tmpdir(), "sweep-advisory-"));
  try {
    const family = makeFamily(base);
    // Only the at-pin project remains: nothing mechanical, nothing judgment.
    rmSync(join(base, "chameidor"), { recursive: true, force: true });
    rmSync(join(base, "label-follower"), { recursive: true, force: true });
    rmSync(join(base, "shougong"), { recursive: true, force: true });
    const result = runCollect({
      environmentsPath: family.environmentsPath,
      codeRoot: family.codeRoot,
      target: family.target,
      sweepRepo: "luiznaac/environments",
      now: NOW,
    });
    assert.equal(result.judgment, null);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// runApply
// ---------------------------------------------------------------------------

test("runApply: creates sticky comments per open PR and the weekly issue, then is idempotent", () => {
  const base = mkdtempSync(join(tmpdir(), "sweep-advisory-"));
  try {
    const gh = fakeGh({
      prs: {
        "luiznaac/chameidor": [
          { number: 7, headRefName: "dependabot/npm_and_yarn/react-19", title: "Bump react" },
          { number: 9, headRefName: "salgadinhos/propagate-deadbee", title: "Propagate scaffold updates" },
        ],
      },
    });
    const { result } = collect(base);

    const first = runApply(result, { gh, openIssue: true });
    assert.deepEqual(first.comments.created, [{ repo: "luiznaac/chameidor", number: 7 }]);
    assert.deepEqual(first.comments.updated, []);
    assert.equal(first.issue.created, true);
    assert.match(first.issue.url, /issues\/\d+/);
    assert.ok(gh.calls.some((call) => call[0] === "ensureLabel"));

    const second = runApply(result, { gh, openIssue: true });
    assert.deepEqual(second.comments.created, []);
    assert.deepEqual(second.comments.updated, []);
    assert.equal(second.issue.created, false, "one open judgment issue per week — do not duplicate");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("runApply: patches the sticky comment when the queue moves", () => {
  const base = mkdtempSync(join(tmpdir(), "sweep-advisory-"));
  try {
    const gh = fakeGh({
      prs: { "luiznaac/chameidor": [{ number: 7, headRefName: "feature", title: "Feature" }] },
    });
    const family = makeFamily(base);
    const collectOptions = { environmentsPath: family.environmentsPath, codeRoot: family.codeRoot, sweepRepo: "luiznaac/environments", now: NOW };
    const first = runCollect({ ...collectOptions, target: family.target });
    runApply(first, { gh });

    const moved = runCollect({ ...collectOptions, target: family.advance() });
    const second = runApply(moved, { gh });
    assert.deepEqual(second.comments.created, []);
    assert.deepEqual(second.comments.updated, [{ repo: "luiznaac/chameidor", number: 7 }]);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("runApply: a drained queue patches the sticky comment to 'current'", () => {
  const base = mkdtempSync(join(tmpdir(), "sweep-advisory-drained-"));
  try {
    const gh = fakeGh({
      prs: {
        "luiznaac/chameidor": [
          { number: 7, headRefName: "feature", title: "Feature", _comments: [{ id: 101, body: "<!-- template-sweep advisory -->\nold stale advisory" }] },
        ],
      },
    });
    const result = {
      target: "abc1234".padEnd(40, "0"),
      short: "abc1234",
      week: "2026-W38",
      sweepRepo: "luiznaac/environments",
      projects: [
        {
          project: "chameidor",
          repo: "luiznaac/chameidor",
          commentBody: null,
          lanes: [{ lane: "frontend", source: "react", behind: 0, stale: null, queue: { applies: [], judgment: [], unclassified: [], waived: [] } }],
        },
      ],
      judgment: null,
    };
    const applied = runApply(result, { gh });
    assert.deepEqual(applied.comments.created, []);
    assert.deepEqual(applied.comments.updated, [{ repo: "luiznaac/chameidor", number: 7 }]);
    const comment = gh.prComments("luiznaac/chameidor", 7).find((comment) => comment.id === 101);
    assert.ok(comment.body.includes("<!-- template-sweep advisory -->"));
    assert.match(comment.body, /all lanes at their pin — nothing queued/);
    const clean = renderCurrent(result, result.projects[0]);
    assert.equal(comment.body, clean);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// formatRun / parseCollect
// ---------------------------------------------------------------------------

test("formatRun: one summary block per project plus the judgment line", () => {
  const base = mkdtempSync(join(tmpdir(), "sweep-advisory-"));
  try {
    const { result } = collect(base);
    const lines = formatRun(result);
    assert.equal(lines[0], `sweep-advisory: target environments@${result.short} (2026-W38)`);
    assert.ok(lines.some((line) => line.includes("chameidor/frontend (react): 1 commit behind")));
    assert.ok(lines.some((line) => line.includes("mechanical 2, judgment 1, unclassified 1")));
    assert.ok(lines.some((line) => line.includes("portfolio-2/frontend (react): at the pin")));
    assert.ok(lines.some((line) => line.includes("judgment queue: 1 lane(s) with work — issue pending/created at apply")));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("parseCollect: round-trips a written collect file", () => {
  const base = mkdtempSync(join(tmpdir(), "sweep-advisory-"));
  try {
    const { result } = collect(base);
    const path = join(base, "collect.json");
    writeFileSync(path, JSON.stringify(result));
    const parsed = parseCollect(readFileSync(path, "utf8"));
    assert.equal(parsed.target, result.target);
    assert.equal(parsed.projects.length, result.projects.length);
    assert.deepEqual(parsed.projects[0].lanes[0].queue, result.projects[0].lanes[0].queue);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
