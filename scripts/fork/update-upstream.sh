#!/usr/bin/env bash
# Merges an upstream release into the fork's main branch.
#
#   scripts/fork/update-upstream.sh <upstream ref>   e.g. v0.5.110 or upstream/master
#   scripts/fork/update-upstream.sh --finish         after resolving merge conflicts
#
# Steps: refuse refs younger than MIN_AGE_DAYS (default 14, supply-chain
# cooldown; ALLOW_YOUNG=1 to override), merge with --no-ff (never rebase: the
# history must keep our patches visible), regenerate the lockfile with
# dependencies no newer than the upstream ref, run the fork's tests.
# See FORK.md.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

# vitest path filters for the fork's own tests (substring match under tests/).
FORK_TESTS=(claude-stream-decloak claude-usage-cache-recovery quota-guard quota-auto-ping)

finish() {
  local ref_date="$1"
  echo "== Regenerating package-lock.json with dependencies published before ${ref_date}"
  npm install --package-lock-only --ignore-scripts --no-audit --no-fund --before="${ref_date}"
  if [[ -n "$(git status --porcelain package-lock.json)" ]]; then
    git add -f package-lock.json
    git commit -q -m "build: regenerate lockfile for the upstream merge (--before=${ref_date})"
  fi
  echo "== Installing and running the fork's tests"
  npm ci --ignore-scripts --no-audit --no-fund >/dev/null
  (cd tests && npm install --ignore-scripts --no-audit --no-fund --before="${ref_date}" >/dev/null \
    && npx vitest run "${FORK_TESTS[@]}")
  cat <<EOF

Next:
  1. Full suite vs upstream baseline (cd tests && npx vitest run) — compare failures with a
     worktree of the same upstream ref; only new failures matter.
  2. scripts/fork/build-image.sh, then tests/e2e (see tests/e2e/README.md).
  3. Update FORK.md (base version), then tag: git tag -a v<version> -m ...
EOF
}

if [[ "${1:-}" == "--finish" ]]; then
  if git rev-parse -q --verify MERGE_HEAD >/dev/null; then
    echo "Merge still in progress: resolve, git add, git commit, then rerun --finish." >&2
    exit 1
  fi
  merged_ref="$(git log -1 --format=%P HEAD | awk '{print $2}')"
  [[ -n "$merged_ref" ]] || { echo "HEAD is not a merge commit." >&2; exit 1; }
  finish "$(git log -1 --format=%cs "$merged_ref")"
  exit 0
fi

ref="${1:?usage: update-upstream.sh <upstream ref> | --finish}"
[[ -z "$(git status --porcelain)" ]] || { echo "Worktree has uncommitted changes." >&2; exit 1; }
[[ "$(git branch --show-current)" == "main" ]] || { echo "Run on the fork's main branch." >&2; exit 1; }

git fetch -q upstream --tags
git rev-parse -q --verify "${ref}^{commit}" >/dev/null || { echo "Unknown ref: ${ref}" >&2; exit 1; }

ref_ts="$(git log -1 --format=%ct "$ref")"
age_days=$(( ($(date +%s) - ref_ts) / 86400 ))
if (( age_days < ${MIN_AGE_DAYS:-14} )) && [[ "${ALLOW_YOUNG:-}" != "1" ]]; then
  echo "${ref} is ${age_days} days old (< ${MIN_AGE_DAYS:-14}). Wait, or rerun with ALLOW_YOUNG=1." >&2
  exit 1
fi

echo "== Merging ${ref} ($(git log -1 --format='%h %cs %s' "$ref"))"
if ! git merge --no-ff --no-edit -m "merge upstream ${ref}" "$ref"; then
  cat >&2 <<EOF

Merge conflicts. Resolve them keeping the fork patches listed in FORK.md, then:
  git add <files> && git commit --no-edit
  scripts/fork/update-upstream.sh --finish
EOF
  exit 2
fi
finish "$(git log -1 --format=%cs "$ref")"
