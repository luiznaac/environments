---
source: environments
branch: research/container-release-flow-sota
date: 2026-11-26
---

# Container release flow for the project family — SOTA and a recommendation (2026-11-26)

## 0. Executive summary
Recommendation: keep TRUNK-BASED DEVELOPMENT (merge small changes to master daily; do NOT add a long-lived WIP/develop branch) and change only WHEN an image is published. Publish on a deliberate release point (a semver git tag `v*`, optionally also `workflow_dispatch`), not on every merge. Tag with immutable semver + short git SHA (never `v${{ github.run_number }}`, never a bare moving `latest` for production). CI still builds/tests on every PR/merge (build with `push: false` to validate the Dockerfile) — that is the CI signal, distinct from release. "Not fully deployable" is fixed by validating before promotion (smoke/acceptance) and injecting config via env vars, deploying by digest.

## 1. Current state (observed 2026-11-26)
Three repos publish a Docker Hub image on every master merge with tags `latest` + `v${{ github.run_number }}`:
- chameidor: `docker-publish.yml` fires on `workflow_run` of CI (branches: [master]) — https://github.com/luiznaac/chameidor/blob/master/.github/workflows/docker-publish.yml
- hablator: same `workflow_run` pattern — https://github.com/luiznaac/hablator/blob/master/.github/workflows/docker-publish.yml
- label-follower: fires on `push: branches:[master]` with `paths` filters — https://github.com/luiznaac/label-follower/blob/master/.github/workflows/docker-publish.yml
Problem: version clutter, wasted Actions minutes, and images that are not release-grade.

## 2. Branching model — do not add a WIP branch
Cite: DORA trunk-based development capability ("three or fewer active branches … merge to trunk at least once a day … no code freezes and no integration phases", higher delivery AND operational performance) — https://dora.dev/capabilities/trunk-based-development/ ; trunkbaseddevelopment.com alternative-branching-models ("incompatible with Trunk-Based Development" re long-lived integration branches) — https://trunkbaseddevelopment.com/alternative-branching-models/ ; short-lived-feature-branches ("Any longer than two days … the antithesis of trunk-based development") — https://trunkbaseddevelopment.com/short-lived-feature-branches/ ; Fowler FeatureBranch (isolation prevents early problem detection, discourages refactoring) — https://martinfowler.com/bliki/FeatureBranch.html ; DORA continuous-integration (infrequent merges make failures hard to localize) — https://dora.dev/capabilities/continuous-integration/ ; DORA small batches (recommends feature toggles, dark launching, branch-by-abstraction over long-lived branches) — https://dora.dev/capabilities/working-in-small-batches/ . Conclusion: a long-lived WIP/develop branch is not a recognized SOTA practice and converts a release-trigger problem into a batch-size/CI-signal problem. Hide unfinished work with feature flags instead.

## 3. Build vs test vs release vs deploy
Cite: Humble continuous delivery vs deployment ("deployment does not imply release"; continuous deployment = releasing every good build, continuous delivery = always releasable, business chooses when) — https://continuousdelivery.com/2010/08/continuous-delivery-vs-continuous-deployment/ ; Humble decouple deployment and release — https://continuousdelivery.com/implementing/patterns/ ; 12-Factor build/release/run ("Releases are an append-only ledger … cannot be mutated"; each release = build + config, unique immutable id) — https://12factor.net/build-release-run ; DORA deployment automation ("Packages created by CI … should be deployable to any environment"; "Use the same packages for every environment") — https://dora.dev/devops-capabilities/technical/deployment-automation/ . Every commit can be a *candidate*; only a deliberate release point produces a *released* image.

## 4. Image tagging — immutable and meaningful
Cite: Docker build best practices ("tags are mutable"; pin by digest) — https://docs.docker.com/build/building/best-practices/#pin-base-image-versions ; Docker Hub immutable tags ("once pushed … cannot be overwritten or deleted"; "must use a new tag name for each new image version") — https://docs.docker.com/docker-hub/repos/manage/hub-images/immutable-tags/ ; docker/metadata-action `type=semver` (needs a valid semver tag; `{{version}}`→1.2.3, `{{major}}.{{minor}}`→1.2; pre-release suppresses major/minor and latest) — https://github.com/docker/metadata-action#typesemver ; `type=sha` → `sha-<7hex>` — https://github.com/docker/metadata-action#typesha ; `flavor: latest=auto` — https://github.com/docker/metadata-action#latest-tag ; GitHub `run_number` is a per-workflow counter starting at 1, unchanged on re-run, encodes neither content nor semver — https://docs.github.com/en/actions/reference/workflows-and-actions/contexts#github-context ; Flux warns a bare `latest` lets a restart silently change running software — https://fluxcd.io/flux/guides/image-update/#following-latest-tags ; Argo CD treats digest pinning as the most restrictive production-grade tracking — https://argo-cd.readthedocs.io/en/stable/user-guide/tracking_strategies/ .

## 5. Trigger mechanics (GitHub Actions)
Cite: `on.push.tags`/`branches` are disjoint and path filters are ignored on tag pushes, read tag via `github.ref_name` — https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax-for-github-actions#onpushbranchestagsbranches-ignoretags-ignore ; `on.release: types:[published]` sets GITHUB_REF to the release tag — https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#release ; `workflow_dispatch` runs a default-branch workflow with `inputs` — https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow ; `workflow_run` runs in the DEFAULT-branch context, so checkout must use `github.event.workflow_run.head_sha` — https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_run ; `concurrency` + `cancel-in-progress` cancels superseded runs (use on PR/branch CI, not publish) — https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency ; official GitHub publish-Docker tutorial triggers on `on: release: types:[published]` — https://docs.github.com/en/actions/tutorials/publish-packages/publish-docker-images ; build-push-action `push` defaults to false, so PR builds validate only — https://github.com/docker/build-push-action#inputs .

## 6. Build once, promote the same digest (GitOps)
Cite: OpenGitOps principles (immutable, versioned desired state; agents reconcile) — https://opengitops.dev/ ; Flux production flow (build `app:v1.0.1` in CI, CD updates the manifest tag to promote) and digest pinning — https://fluxcd.io/flux/guides/image-update/ ; Argo CD tracking strategies — https://argo-cd.readthedocs.io/en/stable/user-guide/tracking_strategies/ ; DORA deployment automation — https://dora.dev/devops-capabilities/technical/deployment-automation/ . GitOps declares a release (tag/digest bump in git); it never rebuilds per environment. The release point is a reviewable git event.

## 7. "Not fully deployable" — validate before promotion
Cite: DORA deployment automation requires a deployment/smoke test and environment-specific config — https://dora.dev/devops-capabilities/technical/deployment-automation/ ; Docker best practices: build and test images in CI — https://docs.docker.com/build/building/best-practices/#build-and-test-your-images-in-ci ; 12-Factor config via env vars, not baked into the artifact — https://12factor.net/config . An image is deployable when it passed a smoke/acceptance gate and takes its config from the environment; deploying a mutable `latest` from a mid-feature merge is what makes it look non-deployable.

## 8. Options matrix
- (a) Long-lived WIP/develop branch — REJECTED: not SOTA, increases batch size and merge cost, weakens CI signal (§2).
- (b) Tag-driven release — RECOMMENDED: publish on a semver `v*` tag (or GitHub Release), immutable semver + sha tags (§4–6).
- (c) On-demand `workflow_dispatch` publish — ACCEPTABLE VARIANT: native and simple (DORA endorses "deploy any version on demand"), but weaker audit trail; best combined with (b) as a manual re-publish/hotfix path (§5, §6).
- (d) Per-merge "candidate" image — OPTIONAL: tag by short SHA (`type=sha`), never overwrite `latest`; useful for previews but not a release.

## 9. Concrete recommended workflow (sketch)
```yaml
# docker-publish.yml (sketch — each repo's image name/context differ)
on:
  push:
    tags: ["v*"]
  workflow_dispatch: {}   # optional manual re-publish / hotfix path

permissions:
  contents: read
  packages: write

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: docker/metadata-action@v5
        id: meta
        with:
          images: <owner>/<image>
          tags: |
            type=semver,pattern={{version}}
            type=semver,pattern={{major}}.{{minor}}
            type=sha,format=short
            type=raw,value=latest,enable=${{ startsWith(github.ref, 'refs/tags/v') }}
          flavor: |
            latest=auto
      - uses: docker/build-push-action@v6
        with:
          context: .
          push: true
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
          cache-from: type=gha
          cache-to: type=gha,mode=max
```

In `ci.yml`, add a build-only validation on PRs and gate concurrency (not on the publish workflow):

```yaml
# ci.yml (sketch)
concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true
# ...
      - uses: docker/build-push-action@v6
        with:
          context: .
          push: false        # validate the Dockerfile, publish nothing on PRs
```

Note the `workflow_run` pitfall: if a `workflow_run` trigger is kept, the checkout must use `github.event.workflow_run.head_sha`, because the run executes in the default-branch context. This whole section is a sketch; each repo's image name/context differ.

## 10. References
- https://github.com/luiznaac/chameidor/blob/master/.github/workflows/docker-publish.yml — chameidor current publish workflow (workflow_run on master CI).
- https://github.com/luiznaac/hablator/blob/master/.github/workflows/docker-publish.yml — hablator current publish workflow (workflow_run on master CI).
- https://github.com/luiznaac/label-follower/blob/master/.github/workflows/docker-publish.yml — label-follower current publish workflow (push to master with path filters).
- https://dora.dev/capabilities/trunk-based-development/ — DORA trunk-based development capability.
- https://trunkbaseddevelopment.com/alternative-branching-models/ — long-lived integration branches are incompatible with TBD.
- https://trunkbaseddevelopment.com/short-lived-feature-branches/ — feature branches should live under two days.
- https://martinfowler.com/bliki/FeatureBranch.html — Fowler on feature-branch isolation costs.
- https://dora.dev/capabilities/continuous-integration/ — DORA continuous integration capability.
- https://dora.dev/capabilities/working-in-small-batches/ — DORA small batches; feature flags over long branches.
- https://continuousdelivery.com/2010/08/continuous-delivery-vs-continuous-deployment/ — Humble: continuous delivery vs continuous deployment.
- https://continuousdelivery.com/implementing/patterns/ — Humble: decouple deployment and release.
- https://12factor.net/build-release-run — 12-Factor build/release/run (immutable releases).
- https://dora.dev/devops-capabilities/technical/deployment-automation/ — DORA deployment automation (same package everywhere, smoke test).
- https://docs.docker.com/build/building/best-practices/#pin-base-image-versions — Docker: tags are mutable; pin by digest.
- https://docs.docker.com/docker-hub/repos/manage/hub-images/immutable-tags/ — Docker Hub immutable tags.
- https://github.com/docker/metadata-action#typesemver — metadata-action semver tag type.
- https://github.com/docker/metadata-action#typesha — metadata-action sha tag type.
- https://github.com/docker/metadata-action#latest-tag — metadata-action `flavor: latest=auto`.
- https://docs.github.com/en/actions/reference/workflows-and-actions/contexts#github-context — GitHub `run_number` semantics.
- https://fluxcd.io/flux/guides/image-update/#following-latest-tags — Flux on the pitfalls of following `latest`.
- https://argo-cd.readthedocs.io/en/stable/user-guide/tracking_strategies/ — Argo CD tracking strategies (digest = most restrictive).
- https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax-for-github-actions#onpushbranchestagsbranches-ignoretags-ignore — `on.push` branches/tags are disjoint; no path filters on tags.
- https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#release — `on.release` event and GITHUB_REF.
- https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow — `workflow_dispatch` inputs.
- https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_run — `workflow_run` default-branch context and head_sha.
- https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency — `concurrency` / `cancel-in-progress`.
- https://docs.github.com/en/actions/tutorials/publish-packages/publish-docker-images — official GitHub publish-Docker tutorial (release-triggered).
- https://github.com/docker/build-push-action#inputs — build-push-action `push` defaults to false.
- https://opengitops.dev/ — OpenGitOps principles (declarative, versioned, immutable state).
- https://fluxcd.io/flux/guides/image-update/ — Flux image-update promotion flow and digest pinning.
- https://12factor.net/config — 12-Factor config via environment variables.
