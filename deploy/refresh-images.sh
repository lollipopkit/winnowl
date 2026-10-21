#!/usr/bin/env bash
# Daily image refresh on a live host (systemd user timer winnowl-refresh.timer). Rebuilds with
# ALPINE_REFRESH=<today>, pulls newer images, recreates only changed services that run on this host
# (the draining one in the background under the drain lock), then prunes.
set -euo pipefail

# Rootless docker when the user socket exists, the system daemon otherwise.
if [[ -S "/run/user/$(id -u)/docker.sock" ]]; then export DOCKER_HOST="unix:///run/user/$(id -u)/docker.sock"; fi
LOG_DIR="$HOME/winnowl-deploy-logs"
DEPLOY_LOCK="$LOG_DIR/deploy.lock"
DRAIN_LOCK="$LOG_DIR/drain-recreate.lock"
mkdir -p "$LOG_DIR"

# A deploy swaps ~/winnowl and builds the same image.
exec 8>"$DEPLOY_LOCK"
flock -w 1800 8 || { echo "a deploy holds $DEPLOY_LOCK; skipping this refresh" >&2; exit 0; }

cd "$HOME/winnowl/deploy"
case "$(cat ../DEPLOY_ROLE)" in
  api)
    DRAINED=runner-supervisor
    C=(docker compose -f docker-compose.yml -f docker-compose.live.yml -f docker-compose.split-api.yml)
    ;;
  sandbox)
    DRAINED=sandbox-agent
    C=(docker compose -f docker-compose.sandbox-host.yml)
    ;;
  *) echo "unknown role in ~/winnowl/DEPLOY_ROLE" >&2; exit 1 ;;
esac
mapfile -t running < <("${C[@]}" ps --services --status running)
[[ ${#running[@]} -gt 0 ]] || { echo "no running services"; exit 0; }
echo "$(date -u +%FT%TZ) refreshing: ${running[*]}"

"${C[@]}" build --pull --build-arg "ALPINE_REFRESH=$(date -u +%F)"
"${C[@]}" pull --ignore-buildable --quiet "${running[@]}"
# The validation image is not a compose service; refresh it only where it was already pulled.
img="$(sed -n 's/^VALIDATION_SANDBOX_IMAGE=//p' .env 2>/dev/null || true)"
if [[ -n "$img" ]] && docker image inspect "$img" >/dev/null 2>&1; then docker pull -q "$img"; fi

rolling=()
others=()
for s in "${running[@]}"; do
  case "$s" in
    "$DRAINED") ;;
    webhook-ingress | webhook-ingress-b) rolling+=("$s") ;;
    *) others+=("$s") ;;
  esac
done
[[ ${#others[@]} -eq 0 ]] || "${C[@]}" up -d --no-build "${others[@]}"
[[ ${#rolling[@]} -eq 0 ]] || bash recreate-rolling.sh "${rolling[@]}" -- "${C[@]}" up -d --no-build

if printf '%s\n' "${running[@]}" | grep -qx "$DRAINED"; then
  # A transient unit of its own: systemd kills everything left in this oneshot's cgroup on exit,
  # and setsid does not leave the cgroup.
  log="$LOG_DIR/$DRAINED-refresh-$(date -u +%Y%m%dT%H%M%SZ).log"
  systemd-run --user --collect --quiet --unit="winnowl-$DRAINED-refresh-$(date -u +%s)" \
    --working-directory="$PWD" ${DOCKER_HOST:+--setenv=DOCKER_HOST="$DOCKER_HOST"} \
    -p StandardOutput="append:$log" -p StandardError="append:$log" \
    /usr/bin/flock -n "$DRAIN_LOCK" /usr/bin/env bash recreate-drained.sh "$DRAINED" \
    "${C[@]}" up -d --no-build --no-deps "$DRAINED"
fi

docker image prune -f
docker builder prune -f --filter until=72h
find "$LOG_DIR" -name '*.log' -mtime +30 -delete
