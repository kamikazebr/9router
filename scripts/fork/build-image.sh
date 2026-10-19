#!/usr/bin/env bash
# Builds the fork image from a clean worktree, stamped with its provenance:
#   9router:<version>                 (and $IMAGE_REPO:<version> when set)
#   labels: image version, our commit, upstream version and upstream commit.
# Usage: scripts/fork/build-image.sh            # build only
#        IMAGE_REPO=ghcr.io/<owner>/9router scripts/fork/build-image.sh
# Tag the commit (git tag -a v<version>) only after the image passed the tests.
# See FORK.md.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Worktree has uncommitted changes; commit them first so the image matches a commit." >&2
  exit 1
fi

version="$(scripts/fork/version.sh)"
upstream_version="$(node -p "require('./package.json').version")"
upstream_commit="$(git merge-base HEAD upstream/master)"
revision="$(git rev-parse HEAD)"

tags=(-t "9router:${version}")
[[ -n "${IMAGE_REPO:-}" ]] && tags+=(-t "${IMAGE_REPO}:${version}")

echo "Building 9router ${version} (upstream ${upstream_version} @ ${upstream_commit:0:9}, fork @ ${revision:0:9})"
DOCKER_BUILDKIT=1 docker build \
  --build-arg APP_VERSION="${version}" \
  --build-arg UPSTREAM_VERSION="${upstream_version}" \
  --build-arg UPSTREAM_COMMIT="${upstream_commit}" \
  --build-arg VCS_REF="${revision}" \
  "${tags[@]}" .

echo
echo "Built: ${tags[*]//-t /}"
echo "After the tests pass: git tag -a v${version} -m \"9router ${version} (upstream ${upstream_version})\""
