#!/usr/bin/env bash
# Runs `pnpm check` on a clean export of a commit (default HEAD). Incremental local builds can hide
# cross-package type errors that a clean tsc -b catches.
set -euo pipefail

rev="${1:-HEAD}"
sha="$(git rev-parse --verify "$rev^{commit}")"
dir="$(mktemp -d "${TMPDIR:-/tmp}/winnowl-check.XXXXXX")"
trap 'rm -rf "$dir"' EXIT

git archive "$sha" | tar -x -C "$dir"
cd "$dir"
# Some tests compare git ls-files with the tree on disk.
git init -q && git add -A
echo "check-clean: ${sha:0:12} in $dir"
pnpm install --frozen-lockfile --prefer-offline --silent
pnpm -s check
