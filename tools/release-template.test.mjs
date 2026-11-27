import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { parseYamlLite } from "./template-check.mjs";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TEMPLATE = join(REPO_ROOT, "project-template");
const WORKFLOW = join(TEMPLATE, ".github", "workflows", "docker-publish.yml");
const RELEASE_YML = join(TEMPLATE, ".github", "release.yml");
const SCRIPT = join(TEMPLATE, "scripts", "release.sh");

const loadWorkflow = () => parseYamlLite(readFileSync(WORKFLOW, "utf8"));

const findStep = (workflow, action) => workflow.jobs.publish.steps.find((step) => step.uses?.startsWith(action));

const tagLines = (workflow) => {
  const meta = findStep(workflow, "docker/metadata-action");
  assert.ok(meta, "the publish workflow has a docker/metadata-action step");
  return String(meta.with.tags)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
};

// ---------------------------------------------------------------------------
// Publish workflow: tag-driven publish, PR-only build, PR-only cancellation
// ---------------------------------------------------------------------------

test("publish workflow: a v* tag publishes, a PR validates, and dispatch allows a re-publish", () => {
  const workflow = loadWorkflow();

  assert.deepEqual(workflow.on.push.tags, ["v*"], "publishes on a v* tag push");
  assert.ok("pull_request" in workflow.on, "validates the image on pull requests");
  assert.ok("workflow_dispatch" in workflow.on, "a manual dispatch re-publishes a release");
});

test("publish workflow: tags semver, major.minor and short SHA, with latest only on a release", () => {
  const workflow = loadWorkflow();
  const meta = findStep(workflow, "docker/metadata-action");
  const lines = tagLines(workflow);

  assert.ok(lines.includes("type=semver,pattern={{version}}"), "semver tag");
  assert.ok(lines.includes("type=semver,pattern={{major}}.{{minor}}"), "major.minor tag");
  assert.ok(lines.includes("type=sha,format=short"), "short SHA tag");
  assert.ok(
    lines.includes("type=raw,value=latest,enable=${{ startsWith(github.ref, 'refs/tags/v') }}"),
    "latest moves only on a v* release tag",
  );
  assert.equal(String(meta.with.flavor).trim(), "latest=false", "the only latest tag is the guarded one");
});

test("publish workflow: never tags an image with github.run_number", () => {
  const lines = tagLines(loadWorkflow());
  assert.ok(lines.every((line) => !line.includes("run_number")), "no tag derives from run_number");
});

test("publish workflow: the build pushes only on a release tag, never on a PR", () => {
  const workflow = loadWorkflow();
  const build = findStep(workflow, "docker/build-push-action");
  assert.ok(build, "the publish workflow has a docker/build-push-action step");
  assert.equal(build.with.push, "${{ startsWith(github.ref, 'refs/tags/v') }}");
});

test("publish workflow: superseded PR runs cancel, publish runs do not", () => {
  const workflow = loadWorkflow();

  assert.match(workflow.concurrency.group, /github\.ref/, "a per-ref concurrency group");
  assert.equal(workflow.concurrency["cancel-in-progress"], "${{ github.event_name == 'pull_request' }}");
});

// ---------------------------------------------------------------------------
// Release notes categories
// ---------------------------------------------------------------------------

test("release.yml: generated notes group changes into categories with a catch-all", () => {
  const config = parseYamlLite(readFileSync(RELEASE_YML, "utf8"));
  const categories = config.changelog?.categories;
  assert.ok(Array.isArray(categories) && categories.length > 0, "changelog.categories is a non-empty list");

  const labels = categories.flatMap((category) => category.labels ?? []);
  assert.ok(labels.includes("*"), "an uncategorised change still lands somewhere");
  assert.ok(categories.every((category) => typeof category.title === "string" && category.title.length > 0));
});

test("release.yml: automated noise is excluded from the notes", () => {
  const config = parseYamlLite(readFileSync(RELEASE_YML, "utf8"));
  assert.ok(Array.isArray(config.changelog?.exclude?.labels));
  assert.ok(Array.isArray(config.changelog?.exclude?.authors));
});

// ---------------------------------------------------------------------------
// release.sh: the validation matrix
// ---------------------------------------------------------------------------

const posixOnly = { skip: process.platform === "win32" ? "release.sh is a POSIX shell script" : false };

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), "release-template-"));
  const origin = join(root, "origin.git");
  mkdirSync(origin);
  git(origin, ["init", "--bare", "-q"]);
  git(origin, ["symbolic-ref", "HEAD", "refs/heads/master"]);

  const work = join(root, "work");
  git(root, ["clone", "-q", origin, work]);
  git(work, ["config", "user.email", "test@example.com"]);
  git(work, ["config", "user.name", "Release Test"]);
  writeFileSync(join(work, "README.md"), "hello\n");
  git(work, ["add", "-A"]);
  git(work, ["commit", "-q", "-m", "initial"]);
  git(work, ["push", "-q", "-u", "origin", "master"]);

  const bin = join(root, "bin");
  mkdirSync(bin);
  const argsFile = join(root, "gh-args.txt");
  writeFileSync(join(bin, "gh"), `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${argsFile}"\n`);
  chmodSync(join(bin, "gh"), 0o755);

  return { root, origin, work, bin, argsFile };
}

function runRelease(repo, args) {
  return spawnSync("bash", [SCRIPT, ...args], {
    cwd: repo.work,
    encoding: "utf8",
    env: { ...process.env, PATH: `${repo.bin}${process.platform === "win32" ? ";" : ":"}${process.env.PATH}` },
  });
}

const ghArgs = (repo) => readFileSync(repo.argsFile, "utf8").split("\n").filter(Boolean);

test("release.sh: refuses a missing or non-semver version", posixOnly, () => {
  const repo = makeRepo();

  const missing = runRelease(repo, []);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /usage/i);

  const invalid = runRelease(repo, ["banana"]);
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /not a valid semver/i);
});

test("release.sh: refuses a dirty tree", posixOnly, () => {
  const repo = makeRepo();
  writeFileSync(join(repo.work, "scratch.txt"), "uncommitted\n");

  const result = runRelease(repo, ["1.0.0"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /dirty/i);
});

test("release.sh: refuses a branch other than master", posixOnly, () => {
  const repo = makeRepo();
  git(repo.work, ["checkout", "-q", "-b", "feature"]);

  const result = runRelease(repo, ["1.0.0"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /master/);
});

test("release.sh: refuses a checkout behind origin/master", posixOnly, () => {
  const repo = makeRepo();
  const other = join(repo.root, "other");
  git(repo.root, ["clone", "-q", repo.origin, other]);
  git(other, ["config", "user.email", "test@example.com"]);
  git(other, ["config", "user.name", "Release Test"]);
  writeFileSync(join(other, "ahead.txt"), "ahead\n");
  git(other, ["add", "-A"]);
  git(other, ["commit", "-q", "-m", "ahead"]);
  git(other, ["push", "-q", "origin", "master"]);

  const result = runRelease(repo, ["1.0.0"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /behind origin\/master/i);
});

test("release.sh: refuses an already-used tag", posixOnly, () => {
  const repo = makeRepo();
  git(repo.work, ["tag", "v1.0.0"]);

  const result = runRelease(repo, ["1.0.0"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /already exists/i);
});

test("release.sh: refuses a version not greater than the last release", posixOnly, () => {
  const repo = makeRepo();
  git(repo.work, ["tag", "v2.0.0"]);

  const result = runRelease(repo, ["1.5.0"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not greater than/i);
});

test("release.sh: compares versions numerically, not lexically", posixOnly, () => {
  const repo = makeRepo();
  git(repo.work, ["tag", "v1.9.0"]);

  const result = runRelease(repo, ["1.10.0"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(ghArgs(repo)[2], "v1.10.0");
});

test("release.sh: a valid state cuts the release with generated notes when none are authored", posixOnly, () => {
  const repo = makeRepo();

  const result = runRelease(repo, ["1.0.0"]);
  assert.equal(result.status, 0, result.stderr);

  const args = ghArgs(repo);
  assert.deepEqual(args.slice(0, 3), ["release", "create", "v1.0.0"]);
  assert.ok(args.includes("--generate-notes"), "falls back to generated notes");
  assert.ok(!args.includes("--notes-file"), "no authored notes file was passed");
  assert.ok(args.includes("--target"), "pins the tag to the validated commit");
});

test("release.sh: a valid state publishes the authored notes file when one is present", posixOnly, () => {
  const repo = makeRepo();
  const notes = join(repo.root, "notes.md");
  writeFileSync(notes, "## What changed\n\n- a thing\n");

  const result = runRelease(repo, ["1.0.0", notes]);
  assert.equal(result.status, 0, result.stderr);

  const args = ghArgs(repo);
  assert.ok(args.includes("--notes-file"), "uses the authored notes file");
  assert.ok(args.includes(notes), "points at the authored file");
  assert.ok(!args.includes("--generate-notes"), "does not also generate notes");
});

test("release.sh: accepts a leading v on the version", posixOnly, () => {
  const repo = makeRepo();

  const result = runRelease(repo, ["v1.2.3"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(ghArgs(repo)[2], "v1.2.3");
});
