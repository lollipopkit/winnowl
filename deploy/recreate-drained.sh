#!/usr/bin/env bash
# Recreate the draining service; compose blocks on the old container's drain. Run detached under the drain lock.
#
#   recreate-drained.sh <service> <compose command ... up ...>
#
# A recreate killed midway leaves a `created` `<old id>_<name>` container; the next recreate would
# replace it instead of the running one and fail to take the name. Remove such leftovers first.
set -euo pipefail
svc="$1"
shift
docker ps -aq --filter status=created \
  --filter label=com.docker.compose.project=winnowl \
  --filter "label=com.docker.compose.service=$svc" | xargs -r docker rm
exec "$@"
