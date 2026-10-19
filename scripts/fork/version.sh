#!/usr/bin/env bash
# Prints the fork version of HEAD: <upstream version>-fork.<n>.
#   upstream version = "version" in package.json, which the fork never edits
#                      (the build stamps the fork version instead).
#   n                = the fork tag on HEAD if there is one, else the next free
#                      number for this upstream version.
# See FORK.md.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

base="$(node -p "require('./package.json').version")"
tagged="$(git tag --points-at HEAD --list "v${base}-fork.*" | sort -V | tail -n1)"
if [[ -n "$tagged" ]]; then
  echo "${tagged#v}"
  exit 0
fi

last="$(git tag --list "v${base}-fork.*" | sort -V | tail -n1)"
n="${last##*.}"
[[ "$n" =~ ^[0-9]+$ ]] || n=0
echo "${base}-fork.$((n + 1))"
