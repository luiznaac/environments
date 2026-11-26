#!/usr/bin/env bash
# Cut a release: validate the repository state, then create the `v<version>` tag and its GitHub
# Release. A release is a deliberate, human-cut event — never a merge, and never automatic.
#
# Usage: scripts/release.sh <version> [notes-file]
#   <version>     the semver core to release, e.g. 1.2.3 (a leading `v` is accepted)
#   [notes-file]  authored release prose; when absent, GitHub generates the notes
#
# The script refuses, before touching the remote:
#   - a missing or non-semver version
#   - a dirty working tree
#   - a branch other than master
#   - a checkout behind origin/master
#   - a tag that already exists
#   - a version not greater than the last release
set -euo pipefail

die() {
  printf 'release: %s\n' "$*" >&2
  exit 1
}

is_semver_core() {
  [[ "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
}

# version_gt A B — true when core-semver A sorts above B. Numeric per component, so 1.10.0
# beats 1.9.0; pure bash, so no reliance on `sort -V` (absent from BSD/macOS sort).
version_gt() {
  local IFS=.
  local -a a=($1) b=($2)
  local i
  for i in 0 1 2; do
    if (( 10#${a[i]} > 10#${b[i]} )); then return 0; fi
    if (( 10#${a[i]} < 10#${b[i]} )); then return 1; fi
  done
  return 1
}

usage() {
  printf 'usage: scripts/release.sh <version> [notes-file]\n' >&2
  exit 2
}

version_arg="${1:-}"
notes_file="${2:-}"
[ -n "$version_arg" ] || usage

version="${version_arg#v}"
if ! is_semver_core "$version"; then
  die "version '$version_arg' is not a valid semver core (expected MAJOR.MINOR.PATCH, e.g. 1.2.3)"
fi
tag="v$version"

[ "$(git rev-parse --is-inside-work-tree 2>/dev/null || true)" = "true" ] || die "not inside a git repository"

if [ -n "$(git status --porcelain)" ]; then
  die "working tree is dirty — commit or stash your changes before releasing"
fi

branch="$(git rev-parse --abbrev-ref HEAD)"
[ "$branch" = "master" ] || die "releases are cut from master, not '$branch'"

git fetch --quiet origin "refs/heads/master:refs/remotes/origin/master" ||
  die "cannot fetch origin/master — check the remote and your network"

if [ "$(git rev-list --count HEAD..refs/remotes/origin/master)" -gt 0 ]; then
  die "local master is behind origin/master — pull before releasing"
fi

if git rev-parse -q --verify "refs/tags/$tag" >/dev/null 2>&1; then
  die "tag $tag already exists — choose a new version"
fi

latest=""
for candidate in $(git tag --list 'v*'); do
  candidate_version="${candidate#v}"
  is_semver_core "$candidate_version" || continue
  if [ -z "$latest" ] || version_gt "$candidate_version" "${latest#v}"; then
    latest="$candidate"
  fi
done
if [ -n "$latest" ] && ! version_gt "$version" "${latest#v}"; then
  die "version $version is not greater than the last release $latest"
fi

target="$(git rev-parse HEAD)"

# Authored prose is the sanctioned release-notes path (a file under the session scratch dir,
# never an inline body); with no authored file, GitHub generates the notes from merged PRs.
if [ -n "$notes_file" ]; then
  [ -f "$notes_file" ] || die "notes file not found: $notes_file"
  [ -s "$notes_file" ] || die "notes file is empty: $notes_file"
  gh release create "$tag" --target "$target" --notes-file "$notes_file"
else
  gh release create "$tag" --target "$target" --generate-notes
fi

printf 'release: created %s at %s\n' "$tag" "$target"
