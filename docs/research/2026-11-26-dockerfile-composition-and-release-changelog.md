---
source: environments
branch: research/container-release-flow-sota
date: 2026-11-26
---

# Dockerfile composition and release/changelog mechanics — SOTA (2026-11-26)

## 0. Executive summary
Dockerfile composition: Docker has **no native `include`** (still only an open feature request in 2026). To let each stack own its build recipe and still build ONE image with no duplicated steps, use **Bake `target:` contexts** (GA since 2025-02): each stack keeps its own Dockerfile/target; the root runtime target composes them via `contexts = { backend = "target:backend-build", frontend = "target:frontend-build" }` and `docker buildx bake runtime` publishes the single image. The zero-Buildx alternative is **creation-time generation** (a generator splices per-stack stage fragments into one root Dockerfile, with a regenerate-and-`git diff --exit-code` drift gate). Avoid third-party `dockerfile-x`. Release/changelog: a git **tag is not a Release** — a bare tag shows under the Releases page's *Tags* tab, not *Releases*. To show entries on the project page you must create a **Release object**. For a **thorough in-repo changelog plus tag plus Release** with one human gate, **release-please** is the best fit; **semantic-release** is the fully automatic alternative; `gh release create <tag> --generate-notes` is the manual no-CHANGELOG path.

## 1. The Dockerfile constraint
Cite: Dockerfile supports only `syntax`, `escape`, `check` parser directives and has no `include` — https://docs.docker.com/reference/dockerfile/ ; the `INCLUDE` feature request is still open/triage — https://github.com/moby/buildkit/issues/5824 . A Dockerfile's `FROM`/`COPY --from`/`RUN --mount=from` resolve stages only within the same file, or an external image — https://docs.docker.com/build/building/multi-stage/ .

## 2. Mechanisms and the 2026 comparison

| Mechanism | stable in 2026 | avoids duplication | one final image | CI complexity | drift risk |
|---|---|---|---|---|---|
| single inline multi-stage (today) | yes | no — one file owns every stack's stages | yes | low | low (one file, but a shared edit surface) |
| named build contexts | yes | partial — stages still live in one file | yes | low | low |
| Bake `target:` contexts | yes (GA 2025-02) | yes — each stack owns its file/target | yes | medium (Buildx bake) | low (targets referenced, not copied) |
| prebuilt registry images | yes | yes — each stack builds its own image | no — composed at runtime, not one image | medium (two pipelines) | medium (two artifacts to keep in sync) |
| native include (does not exist) | no | n/a | n/a | n/a | n/a |
| third-party dockerfile-x | no (third-party frontend) | yes | yes | medium + network fetch | high (supply-chain / network access) |
| Compose build (per-service) | yes | partial | no — one image per service | low | medium (`service:` context couples services) |
| creation-time generation | yes | yes — fragments spliced at creation | yes | low (plain `docker build`) | medium (generated file must stay honest) |

Cite: named build contexts `--build-context name=path` — https://docs.docker.com/reference/cli/docker/buildx/build/#build-context ; Bake additional contexts `contexts = { x = "target:y" }` and only the tagged target is published — https://docs.docker.com/build/bake/contexts/ ; Bake GA 2025-02-05 — https://www.docker.com/blog/ga-launch-docker-bake/ ; Compose builds one image per service, `build.additional_contexts` incl. `service:` — https://docs.docker.com/compose/compose-file/build/ ; dockerfile-x third-party frontend, network access / supply-chain caveat — https://github.com/devthefuture-org/dockerfile-x ; Docker guidance: use Bake contexts only when recipes "can't be merged into one" — https://docs.docker.com/build/bake/contexts/ .

## 3. Recommendation: Bake target contexts (with a sketch)
Shape: `backend/Dockerfile` (kotlin or python target) and `frontend/Dockerfile` (react → static) each own their build; a root `docker-bake.hcl` defines `target "backend-build"`, `target "frontend-build"`, and `target "runtime"` whose `contexts` map the two, copying nginx/supervisord config from the root context; `docker buildx bake runtime` builds/pushes one image. Sketch:

```hcl
target "backend-build" {
  context = "backend"
  target  = "build"
}

target "frontend-build" {
  context = "frontend"
  target  = "build"
}

target "runtime" {
  context  = "."
  dockerfile = "Dockerfile"
  contexts = {
    backend  = "target:backend-build"
    frontend = "target:frontend-build"
  }
  tags = ["registry/name:${TAG}"]
}
```

CI must use `docker buildx bake` (not plain `docker build`) and pins Buildx. Rationale is the documented "recipes can't be merged into one" case — https://docs.docker.com/build/bake/contexts/ .

## 4. Alternative: creation-time generation (zero Buildx)
Each stack ships a stage fragment; a generator (in `new-project.mjs`) splices the chosen backend + frontend fragments plus shared runtime stages into one committed root `Dockerfile`; a CI step regenerates and fails on `git diff --exit-code` to catch drift. Pros: plain `docker build`, no Buildx runtime dependency. Cons: a generated file to keep honest.

## 5. Tags vs Releases
Cite: Releases API "does not include regular Git tags that have not been associated with a release" — https://docs.github.com/en/rest/releases/releases ; viewing releases and tags (Tags vs Releases tabs) — https://docs.github.com/en/repositories/releasing-projects-on-github/viewing-your-repositorys-releases-and-tags ; about releases — https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases .

## 6. Changelog options
Cite:
- GitHub auto-generated notes are PR-derived, `.github/release.yml` categories/exclude, no in-repo file — https://docs.github.com/en/repositories/releasing-projects-on-github/automatically-generated-release-notes
- `gh release create --generate-notes` is the sanctioned no-authored-body path; `--notes-file`/`--notes`/`--notes-start-tag`/`--verify-tag`/`--target`/`--draft`/`--prerelease` — https://cli.github.com/manual/gh_release_create
- release-please creates a release PR, updates `CHANGELOG.md`, tags the commit, creates a GitHub Release — https://github.com/googleapis/release-please
- semantic-release determines version from commits, tags, and publishes a GitHub release via `@semantic-release/github` — https://github.com/semantic-release/semantic-release and https://github.com/semantic-release/github
- git-cliff generates changelogs only (no tag, no Release; its Action sets release notes) — https://git-cliff.org/docs/ and https://git-cliff.org/docs/github-actions/git-cliff-action
- Conventional Commits (`fix`→PATCH, `feat`→MINOR, `!`/`BREAKING CHANGE`→MAJOR) — https://www.conventionalcommits.org/en/v1.0.0/ ; Keep a Changelog shape — https://keepachangelog.com/en/1.1.0/

| Option | effort | commit discipline | changelog thoroughness | tag on Releases page |
|---|---|---|---|---|
| (a) manual `release.sh` + `gh --generate-notes` | low to set up, manual each release | none | thin, PR-derived only, no in-repo file | yes (creates a Release) |
| (b) release-please | low (bot PR), one merge gate | Conventional Commits + squash-merge | thorough, persistent `CHANGELOG.md` | yes (tags + Release) |
| (c) semantic-release | fully automatic | Conventional Commits | thorough, generated at release | yes (tags + Release) |

## 7. Recommendation
(b) release-please satisfies BOTH requirements — a tag visible on the Releases page plus a persistent commit-derived `CHANGELOG.md` — with one human gate (merge the bot's release PR), at the cost of adopting Conventional Commits and squash-merge. (a) is right if no in-repo CHANGELOG is wanted; (c) if the family wants zero human touch. This REPLACES the earlier hand-rolled `release.sh <version>` idea if a CHANGELOG file is desired.

## 8. References
- https://docs.docker.com/reference/dockerfile/ — Dockerfile reference; only `syntax`/`escape`/`check` directives, no `include`.
- https://github.com/moby/buildkit/issues/5824 — open/triage feature request for `INCLUDE` in Dockerfiles.
- https://docs.docker.com/build/building/multi-stage/ — multi-stage builds; `FROM`/`COPY --from`/`RUN --mount=from` resolve within one file or an external image.
- https://docs.docker.com/reference/cli/docker/buildx/build/#build-context — `docker buildx build --build-context name=path`.
- https://docs.docker.com/build/bake/contexts/ — Bake additional contexts incl. `target:y`, only the tagged target published, guidance on when to use.
- https://www.docker.com/blog/ga-launch-docker-bake/ — Docker Bake GA announcement (2025-02-05).
- https://docs.docker.com/compose/compose-file/build/ — Compose builds one image per service; `build.additional_contexts` incl. `service:`.
- https://github.com/devthefuture-org/dockerfile-x — third-party Dockerfile frontend; network access / supply-chain caveat.
- https://docs.github.com/en/rest/releases/releases — Releases API excludes regular Git tags not associated with a release.
- https://docs.github.com/en/repositories/releasing-projects-on-github/viewing-your-repositorys-releases-and-tags — the Tags vs Releases tabs.
- https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases — what a release is.
- https://docs.github.com/en/repositories/releasing-projects-on-github/automatically-generated-release-notes — PR-derived auto notes, `.github/release.yml`, no in-repo file.
- https://cli.github.com/manual/gh_release_create — `gh release create` flags incl. `--generate-notes`.
- https://github.com/googleapis/release-please — release PR, `CHANGELOG.md`, tag, GitHub Release.
- https://github.com/semantic-release/semantic-release — version from commits, tag, publish.
- https://github.com/semantic-release/github — `@semantic-release/github` publishes the GitHub release.
- https://git-cliff.org/docs/ — git-cliff generates changelogs only (no tag, no Release).
- https://git-cliff.org/docs/github-actions/git-cliff-action — the git-cliff Action sets release notes.
- https://www.conventionalcommits.org/en/v1.0.0/ — Conventional Commits spec (fix→PATCH, feat→MINOR, `!`/`BREAKING CHANGE`→MAJOR).
- https://keepachangelog.com/en/1.1.0/ — Keep a Changelog shape.
