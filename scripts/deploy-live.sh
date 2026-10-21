#!/usr/bin/env bash
# Deploy a commit to the live hosts: one API host and any number of sandbox hosts.
#
#   scripts/deploy-live.sh <commit> [--now] [--dry-run]
#
# Roles:
#   api      data, keys and control plane (deploy/docker-compose.split-api.yml)
#   sandbox  sandbox-agent + egress/registry proxies only (deploy/docker-compose.sandbox-host.yml);
#            holds no DB credentials, KEK or app key
# Each host keeps ~/winnowl-secrets/deploy.env: PRIVATE_BIND and AGENT_SLOTS on sandbox hosts;
# SANDBOX_AGENT_SECRET and METRICS_TOKEN on the API host. Token hashes, SANDBOX_AGENTS, Prometheus
# targets, APP_VERSION and squid.conf are derived by the deploy.
#
# The tree comes from `git archive <commit>`, never the working tree (uncommitted files must not
# reach prod). Order: preflight all hosts, upload, build on the API host (generates squid.conf),
# then build + restart each sandbox host, then restart the API host.
# The draining services (sandbox-agent, runner-supervisor) let in-flight work finish:
#   default  recreated in the background; prints the log to follow
#   --now    stop at once (runner jobs are released to the queue), recreate in the foreground
#   --dry-run prints the commands and remote scripts instead of running them.
#
# Env: DEPLOY_API_HOST (default hskb), DEPLOY_SANDBOX_HOSTS (space-separated, default vie).
# Remote work is piped to `bash -s` because login shells may be fish. Secrets are never printed.
set -euo pipefail

usage() {
  sed -n '2,/^set -euo/p' "$0" | sed '$d; s/^# \{0,1\}//'
  exit "${1:-0}"
}

die() {
  printf 'deploy-live: %s\n' "$*" >&2
  exit 1
}

API_HOST="${DEPLOY_API_HOST:-hskb}"
read -r -a SANDBOX_HOSTS <<<"${DEPLOY_SANDBOX_HOSTS:-vie}"
NOW=0
DRY=0
COMMIT=""
for arg in "$@"; do
  case "$arg" in
    --now) NOW=1 ;;
    --dry-run) DRY=1 ;;
    -h | --help) usage 0 ;;
    -*) die "unknown option: $arg" ;;
    *)
      [[ -z "$COMMIT" ]] || die "only one commit may be given"
      COMMIT="$arg"
      ;;
  esac
done
[[ -n "$COMMIT" ]] || usage 1
[[ ${#SANDBOX_HOSTS[@]} -gt 0 ]] || die "DEPLOY_SANDBOX_HOSTS is empty"
for host in "${SANDBOX_HOSTS[@]}"; do
  # The name is part of every sandbox handle and the input of the host's token.
  [[ "$host" =~ ^[a-z0-9][a-z0-9-]*$ ]] || die "sandbox host name must match [a-z0-9-]: $host"
done

SHA="$(git rev-parse --verify --quiet "${COMMIT}^{commit}")" ||
  die "commit not found locally: $COMMIT"

# Values are injected with %q so they are inert in bash.
prelude() {
  local host="$1" role="$2" kv
  shift 2
  printf 'SHA=%q\nNOW=%q\nHOST=%q\nROLE=%q\n' "$SHA" "$NOW" "$host" "$role"
  for kv in "$@"; do printf '%s=%q\n' "${kv%%=*}" "${kv#*=}"; done
  cat <<'EOF'
set -euo pipefail
# Rootless docker when the user socket exists, the system daemon otherwise.
if [[ -S "/run/user/$(id -u)/docker.sock" ]]; then export DOCKER_HOST="unix:///run/user/$(id -u)/docker.sock"; fi
LOG_DIR="$HOME/winnowl-deploy-logs"
LOCK="$LOG_DIR/drain-recreate.lock"
mkdir -p "$LOG_DIR"

if [[ "$ROLE" == api ]]; then
  DRAINED=runner-supervisor
  C=(docker compose -f docker-compose.yml -f docker-compose.live.yml -f docker-compose.split-api.yml)
else
  DRAINED=sandbox-agent
  C=(docker compose -f docker-compose.sandbox-host.yml)
fi

drained_ids() {
  docker ps -q \
    --filter label=com.docker.compose.project=winnowl \
    --filter "label=com.docker.compose.service=$DRAINED"
}

# The first SIGTERM starts the drain, the second forces the stop; SIGKILL only after 30s.
force_drained_stop() {
  local ids
  ids="$(drained_ids)"
  [[ -n "$ids" ]] || return 0
  echo "$HOST: stopping $DRAINED now (in-flight work is aborted)"
  for id in $ids; do docker kill -s TERM "$id" >/dev/null 2>&1 || true; done
  sleep 1
  for id in $ids; do docker kill -s TERM "$id" >/dev/null 2>&1 || true; done
  # shellcheck disable=SC2086
  docker stop -t 30 $ids >/dev/null || true
}
EOF
}

preflight_script() {
  prelude "$@"
  cat <<'EOF'
ENVF="$HOME/winnowl-secrets/deploy.env"
[[ -f "$ENVF" ]] || { echo "$HOST: ~/winnowl-secrets/deploy.env missing" >&2; exit 1; }
need() { grep -q "^$1=." "$ENVF" || { echo "$HOST: deploy.env has no $1" >&2; exit 1; }; }
if ! flock -n "$LOCK" true; then
  if [[ "$NOW" != 1 ]]; then
    echo "$HOST: an earlier deploy's $DRAINED recreate is still draining (logs: $LOG_DIR)." >&2
    echo "wait for it to finish, or rerun with --now to abort its drain." >&2
    exit 1
  fi
  echo "$HOST: an earlier deploy's $DRAINED is still draining; forcing it to stop"
  force_drained_stop
  flock -w 180 "$LOCK" true || { echo "$HOST: earlier recreate did not finish" >&2; exit 1; }
fi
if [[ "$ROLE" == sandbox ]]; then
  need PRIVATE_BIND
  need AGENT_SLOTS
  if grep -q '^AGENT_SCRATCH_SLOTS=.' "$ENVF"; then
    need AGENT_SCRATCH_POOL_MB
    [[ -S /var/lib/winnowl-scratch-quota.sock ]] || { echo "$HOST: no scratch quota service; run deploy/scratch-slots.sh with sudo" >&2; exit 1; }
  fi
  printf 'PREFLIGHT_AGENT=%s=http://%s:8790=%s\n' "$HOST" \
    "$(sed -n 's/^PRIVATE_BIND=//p' "$ENVF")" "$(sed -n 's/^AGENT_SLOTS=//p' "$ENVF")"
else
  need SANDBOX_AGENT_SECRET
  need METRICS_TOKEN
  need PRIVATE_BIND
  # Public addresses: everything else (OAuth redirect_uri, expected webhook URL) derives from these.
  need CONSOLE_BASE_URL
  need API_BASE_URL
  for key in CONSOLE_BASE_URL API_BASE_URL; do
    grep -q "^$key=https://" "$ENVF" || { echo "$HOST: deploy.env $key must be an https URL" >&2; exit 1; }
  done
  # TODO: remove once no deploy.env carries it.
  if grep -q '^GITHUB_WEBHOOK_URL=' "$ENVF"; then
    echo "$HOST: deploy.env still sets GITHUB_WEBHOOK_URL; it is derived from API_BASE_URL now, delete it" >&2
    exit 1
  fi
  # The secret and tokens stay on this host; only sha256s of the tokens are printed.
  ENVF="$ENVF" SANDBOX_NAMES="$SANDBOX_NAMES" python3 -c '
import hashlib, hmac, os
env = {}
for line in open(os.environ["ENVF"]).read().splitlines():
    if "=" in line and not line.startswith("#"):
        k, v = line.split("=", 1)
        env[k] = v.strip()
secret = env["SANDBOX_AGENT_SECRET"].encode()
for name in os.environ["SANDBOX_NAMES"].split():
    token = hmac.new(secret, name.encode(), hashlib.sha256).hexdigest()
    print("PREFLIGHT_TOKEN_HASH=%s:%s" % (name, hashlib.sha256(token.encode()).hexdigest()))
print("PREFLIGHT_METRICS_HASH=%s" % hashlib.sha256(env["METRICS_TOKEN"].encode()).hexdigest())
'
fi
rm -rf "$HOME/winnowl.new"
mkdir -p "$HOME/winnowl.new"
EOF
}

# Swap the tree in and build; no restarts.
build_script() {
  prelude "$@"
  cat <<'EOF'
NEW="$HOME/winnowl.new"
CUR="$HOME/winnowl"
OLD="$HOME/winnowl.old"
SECRETS="$HOME/winnowl-secrets"

[[ -f "$NEW/deploy/docker-compose.yml" ]] || { echo "upload incomplete: $NEW" >&2; exit 1; }
# refresh-images.sh rebuilds the same image in the same tree.
exec 8>"$LOG_DIR/deploy.lock"
flock -w 1800 8 || { echo "$HOST: the daily image refresh holds $LOG_DIR/deploy.lock" >&2; exit 1; }
cp "$SECRETS/deploy.env" "$NEW/deploy/.env"
chmod 600 "$NEW/deploy/.env"
printf '\n# Written by scripts/deploy-live.sh.\nAPP_VERSION=%s\n' "$SHA" >>"$NEW/deploy/.env"
printf '%s\n' "$SHA" >"$NEW/DEPLOYED_COMMIT"
printf '%s\n' "$ROLE" >"$NEW/DEPLOY_ROLE"
if [[ "$ROLE" == sandbox ]]; then
  printf '%s' "$SQUID_B64" | base64 -d >"$NEW/deploy/squid.conf"
  grep -q 'http_access deny all' "$NEW/deploy/squid.conf" || { echo "$HOST: squid.conf did not arrive" >&2; exit 1; }
  printf 'AGENT_TOKEN_SHA256=%s\nAGENT_METRICS_TOKEN_SHA256=%s\n' "$TOKEN_HASH" "$METRICS_HASH" >>"$NEW/deploy/.env"
  [[ -z "$VALIDATION_IMAGE" ]] || printf 'VALIDATION_SANDBOX_IMAGE=%s\n' "$VALIDATION_IMAGE" >>"$NEW/deploy/.env"
else
  printf 'SANDBOX_AGENTS=%s\n' "$SANDBOX_AGENTS" >>"$NEW/deploy/.env"
  # The relay only gets the sha256 of its admin token (HMAC of SANDBOX_AGENT_SECRET).
  ENVF="$SECRETS/deploy.env" python3 -c '
import hashlib, hmac, os
env = dict(l.split("=", 1) for l in open(os.environ["ENVF"]).read().splitlines() if "=" in l and not l.startswith("#"))
token = hmac.new(env["SANDBOX_AGENT_SECRET"].strip().encode(), b"llm-relay-admin", hashlib.sha256).hexdigest()
print("LLM_RELAY_PUBLIC_URL=http://%s:8793" % env["PRIVATE_BIND"].strip())
print("LLM_RELAY_ADMIN_SHA256=%s" % hashlib.sha256(token.encode()).hexdigest())
' >>"$NEW/deploy/.env"
  # shellcheck disable=SC2086
  printf '[{"targets": [%s]}]\n' "$(printf '"%s",' $AGENT_METRICS | sed 's/,$//')" >"$NEW/deploy/sandbox-agents.json"
fi

rm -rf "$OLD"
if [[ -d "$CUR" ]]; then mv "$CUR" "$OLD"; fi
mv "$NEW" "$CUR"
cd "$CUR/deploy"
echo "$HOST: ~/winnowl is now ${SHA:0:12} ($ROLE)"

"${C[@]}" build --pull --build-arg "ALPINE_REFRESH=$(date -u +%F)"

if [[ "$ROLE" == api ]]; then
  # Egress allowlist for every sandbox host.
  docker run --rm --env-file .env winnowl:latest node scripts/gen-squid-conf.mjs \
    >"$SECRETS/squid.conf.new" 2>/dev/null
  grep -q 'http_access deny all' "$SECRETS/squid.conf.new" || { echo "$HOST: squid.conf generation failed" >&2; exit 1; }
  mv "$SECRETS/squid.conf.new" "$SECRETS/squid.conf"
  printf 'SQUID_B64=%s\n' "$(base64 -w0 "$SECRETS/squid.conf")"
  printf 'VALIDATION_IMAGE=%s\n' "$(sed -n 's/^VALIDATION_SANDBOX_IMAGE=//p' .env | tail -n1)"
else
  docker run --rm winnowl:latest node scripts/gen-squid-conf.mjs --registry >squid-registry.conf 2>/dev/null
  grep -q 'http_access deny all' squid-registry.conf || { echo "$HOST: squid-registry.conf generation failed" >&2; exit 1; }
fi

mkdir -p "$HOME/.config/systemd/user"
cp "$CUR"/deploy/systemd/winnowl-refresh.{service,timer} "$HOME/.config/systemd/user/"
systemctl --user daemon-reload
systemctl --user enable --now winnowl-refresh.timer >/dev/null
EOF
}

# The draining service starts last.
up_script() {
  prelude "$@"
  cat <<'EOF'
cd "$HOME/winnowl/deploy"
exec 8>"$LOG_DIR/deploy.lock"
flock -w 1800 8 || { echo "$HOST: the daily image refresh holds $LOG_DIR/deploy.lock" >&2; exit 1; }
if [[ "$ROLE" == api ]]; then
  "${C[@]}" up -d postgres minio tempo otel-collector alertmanager grafana
  "${C[@]}" run --rm -T migrate
  "${C[@]}" up -d minio-init
  # prometheus too: bind-mounted config files stay pinned to the tree they were created from.
  "${C[@]}" up -d --force-recreate control-api prometheus
  # b first: on the first deploy it does not exist yet and is only created.
  bash recreate-rolling.sh webhook-ingress-b webhook-ingress -- "${C[@]}" up -d --force-recreate
  # Recreated only when its image changed: a restart drops in-flight model streams.
  "${C[@]}" up -d llm-relay
else
  # Recreated only when its allowlist changed: running sandboxes go out through it.
  for proxy in egress-proxy:squid.conf registry-proxy:squid-registry.conf; do
    svc="${proxy%%:*}"
    current="$(docker exec "winnowl-$svc-1" cat /etc/squid/squid.conf 2>/dev/null | sha256sum | cut -d' ' -f1 || true)"
    if [[ "$current" != "$(sha256sum "${proxy#*:}" | cut -d' ' -f1)" ]]; then
      "${C[@]}" up -d --force-recreate "$svc"
    else
      "${C[@]}" up -d "$svc"
    fi
  done
fi

if [[ "$NOW" == 1 ]]; then
  exec 9>"$LOCK"
  flock -w 180 9 || { echo "$HOST: recreate lock is held" >&2; exit 1; }
  force_drained_stop
  bash recreate-drained.sh "$DRAINED" "${C[@]}" up -d --force-recreate --no-deps "$DRAINED"
  echo "$HOST: $DRAINED recreated"
  exit 0
fi

LOG="$LOG_DIR/$DRAINED-$(date -u +%Y%m%dT%H%M%SZ)-${SHA:0:12}.log"
# Detached: compose blocks on the old container's drain. 8>&- releases the deploy lock meanwhile.
setsid nohup flock -n "$LOCK" bash recreate-drained.sh "$DRAINED" "${C[@]}" up -d --force-recreate --no-deps "$DRAINED" \
  >"$LOG" 2>&1 </dev/null 8>&- &
echo "$HOST: $DRAINED recreate started in the background (the old one drains first)."
echo "follow it: ssh $HOST tail -f $LOG"
EOF
}

# bash -s reads the script from stdin one command at a time, so a command reading stdin (docker
# compose run) would swallow the rest. A function is parsed whole before running.
wrap() {
  echo 'remote_main() {'
  "$@"
  echo '}'
  echo 'remote_main </dev/null'
}

# remote <host> <label> <script-fn> <prelude args…>
remote() {
  local host="$1" label="$2"
  shift 2
  if [[ "$DRY" == 1 ]]; then
    printf '\n### ssh %s bash -s   (%s)\n' "$host" "$label" >&2
    wrap "$@" >&2
  else
    wrap "$@" | ssh "$host" bash -s
  fi
}

upload() {
  local host="$1"
  if [[ "$DRY" == 1 ]]; then
    printf '\n### git archive --format=tar %s | ssh %s tar -x -C winnowl.new\n' "$SHA" "$host" >&2
  else
    # No shell syntax, so fish runs it as is.
    git archive --format=tar "$SHA" | ssh "$host" tar -x -C winnowl.new
  fi
}

echo "deploying ${SHA:0:12}: api=$API_HOST sandbox=${SANDBOX_HOSTS[*]}$([[ "$NOW" == 1 ]] && echo ' (--now)')"

AGENTS=()
METRICS=()
for host in "${SANDBOX_HOSTS[@]}"; do
  out="$(remote "$host" preflight preflight_script "$host" sandbox)"
  printf '%s\n' "$out" | grep -v '^PREFLIGHT_' || true
  agent="$(sed -n 's/^PREFLIGHT_AGENT=//p' <<<"$out")"
  [[ "$DRY" == 1 ]] && agent="${agent:-$host=http://dry-run:8790=1}"
  [[ -n "$agent" ]] || die "$host: preflight returned no agent address"
  AGENTS+=("$agent")
  url="${agent#*=}"
  url="${url%=*}"
  METRICS+=("${url#http://}")
done
out="$(remote "$API_HOST" preflight preflight_script "$API_HOST" api "SANDBOX_NAMES=${SANDBOX_HOSTS[*]}")"
printf '%s\n' "$out" | grep -v '^PREFLIGHT_' || true
METRICS_HASH="$(sed -n 's/^PREFLIGHT_METRICS_HASH=//p' <<<"$out")"
[[ "$DRY" == 1 || -n "$METRICS_HASH" ]] || die "$API_HOST: preflight returned no metrics token hash"

upload "$API_HOST"
for host in "${SANDBOX_HOSTS[@]}"; do upload "$host"; done

agents="$(IFS=,; echo "${AGENTS[*]}")"
API_ARGS=("SANDBOX_AGENTS=$agents" "AGENT_METRICS=${METRICS[*]}")
built="$(remote "$API_HOST" build build_script "$API_HOST" api "${API_ARGS[@]}")"
printf '%s\n' "$built" | grep -v -e '^SQUID_B64=' -e '^VALIDATION_IMAGE=' || true
SQUID_B64="$(sed -n 's/^SQUID_B64=//p' <<<"$built")"
VALIDATION_IMAGE="$(sed -n 's/^VALIDATION_IMAGE=//p' <<<"$built")"
[[ -z "$VALIDATION_IMAGE" || "$VALIDATION_IMAGE" =~ ^[a-z0-9][a-z0-9./:@_-]*$ ]] ||
  die "$API_HOST: VALIDATION_SANDBOX_IMAGE is not an image reference"
[[ "$DRY" == 1 || -n "$SQUID_B64" ]] || die "$API_HOST: no squid.conf generated"

# Sandbox hosts first: the new runner-supervisor places sandboxes only on agents of its own version.
for host in "${SANDBOX_HOSTS[@]}"; do
  hash="$(sed -n "s/^PREFLIGHT_TOKEN_HASH=$host://p" <<<"$out")"
  [[ "$DRY" == 1 || -n "$hash" ]] || die "$API_HOST: no token hash for $host"
  remote "$host" build build_script "$host" sandbox "TOKEN_HASH=$hash" "METRICS_HASH=$METRICS_HASH" "SQUID_B64=$SQUID_B64" \
    "VALIDATION_IMAGE=$VALIDATION_IMAGE"
  remote "$host" up up_script "$host" sandbox
done
remote "$API_HOST" up up_script "$API_HOST" api
