#!/usr/bin/env bash
# Recreate interchangeable instances one at a time, each healthy before the next goes down.
#
#   recreate-rolling.sh <service>... -- <compose command ... up ...>
#
# A failing healthcheck stops the roll with the other instance still serving.
set -euo pipefail
services=()
while [[ $# -gt 0 && "$1" != -- ]]; do
  services+=("$1")
  shift
done
[[ $# -gt 1 && ${#services[@]} -gt 0 ]] || { echo "usage: $0 <service>... -- <compose up command>" >&2; exit 2; }
shift
for svc in "${services[@]}"; do
  "$@" --no-deps --wait --wait-timeout 120 "$svc"
done
