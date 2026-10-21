#!/usr/bin/env bash
# Deploy the web console of a commit to Cloudflare Pages.
#
#   scripts/deploy-pages.sh <commit> [--dry-run]
#
# The tree comes from `git archive <commit>`, never the working tree. The account-wide Cloudflare
# token stays in the macOS keychain (`cloudflare-api-token`, `cloudflare-account-id`) and reaches
# wrangler only via its environment.
#
# Env: PAGES_PROJECT (default winnowl), API_BASE (default https://winnowl-api.lollipopkit.com),
#      SITE_URL (default https://winnowl.lollipopkit.com).
set -euo pipefail

die() {
  printf 'deploy-pages: %s\n' "$*" >&2
  exit 1
}

COMMIT=""
DRY=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY=1 ;;
    -*) die "unknown option: $arg" ;;
    *) COMMIT="$arg" ;;
  esac
done
[[ -n "$COMMIT" ]] || die "usage: scripts/deploy-pages.sh <commit> [--dry-run]"
SHA="$(git rev-parse --verify --quiet "${COMMIT}^{commit}")" || die "commit not found locally: $COMMIT"

PROJECT="${PAGES_PROJECT:-winnowl}"
API_BASE="${API_BASE:-https://winnowl-api.lollipopkit.com}"
SITE_URL="${SITE_URL:-https://winnowl.lollipopkit.com}"
ROOT="$(git rev-parse --show-toplevel)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "building web console ${SHA:0:12} (API ${API_BASE})"
git -C "$ROOT" archive --format=tar "$SHA" | tar -x -C "$WORK"
(
  cd "$WORK"
  pnpm install --frozen-lockfile --filter @reviewbot/web-console... >/dev/null
  # Workspace packages the console imports are consumed from dist/.
  pnpm exec tsc -b packages/i18n packages/review-profile
  VITE_API_BASE="$API_BASE" VITE_SITE_URL="$SITE_URL" pnpm build:web
)
DIST="$WORK/apps/web-console/dist"
[[ -f "$DIST/200.html" && -f "$DIST/_headers" ]] || die "build output incomplete: $DIST"

if [[ "$DRY" == 1 ]]; then
  echo "dry run: would deploy $DIST to Pages project $PROJECT (branch main)"
  exit 0
fi
CLOUDFLARE_API_TOKEN="$(security find-generic-password -s cloudflare-api-token -w)" \
CLOUDFLARE_ACCOUNT_ID="$(security find-generic-password -s cloudflare-account-id -w)" \
  pnpm --dir "$WORK" dlx wrangler@4 pages deploy "$DIST" \
  --project-name "$PROJECT" --branch main --commit-hash "$SHA" --commit-dirty=false
