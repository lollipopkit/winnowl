#!/usr/bin/env bash
# Disk-quota slots for sandboxes on a sandbox host (run once with sudo; again to change the layout).
#
#   sudo deploy/scratch-slots.sh <slots> <pool GiB> <GiB for workspaces> [owner] [max GiB per slot]
#
# A sparse image holds xfs with project quotas on a direct-I/O loop device (without direct I/O the
# double page cache drops writes to ~10 MB/s), mounted at /srv/winnowl-scratch by
# winnowl-scratch.service. Each `slot-<i>` is a project whose limit sandbox-agent sets per sandbox.
#
# Setting a limit needs root, so a socket-activated quota service on
# /var/lib/winnowl-scratch-quota.sock (owned by [owner]) accepts one line:
#   limit <slot> <MiB>   set a slot's limit (at most the max per slot)
#   report               `slot <i> <used KiB> <limit KiB>` per slot, then `hostfree <KiB>`
# and answers `ok` or `error <why>` last. Not under /run: rootless docker has its own /run, so a
# socket there could not be mounted into the agent.
# `workspaces` is one quota project for the agent's clones of untrusted repositories.
#
# Re-running grows the image (never shrinks); extra slots are removed only when empty.
set -euo pipefail

SLOTS="${1:?number of slots}"
POOL_GIB="${2:?GiB shared by the slots}"
WS_GIB="${3:?GiB for workspaces}"
OWNER="${4:-${SUDO_USER:-root}}"
MAX_GIB="${5:-$(( POOL_GIB < 40 ? POOL_GIB : 40 ))}"
IMG=/srv/winnowl-scratch.img
MNT=/srv/winnowl-scratch
UNIT=/etc/systemd/system/winnowl-scratch.service
CONF=/etc/winnowl-scratch.conf
QUOTA_BIN=/usr/local/libexec/winnowl-scratch-quota
[[ "$SLOTS" =~ ^[1-9][0-9]?$ && "$POOL_GIB" =~ ^[1-9][0-9]*$ && "$WS_GIB" =~ ^[1-9][0-9]*$ && "$MAX_GIB" =~ ^[1-9][0-9]*$ ]] || {
  echo "slots 1-99, sizes positive integers (GiB)" >&2
  exit 1
}
(( MAX_GIB <= POOL_GIB )) || { echo "max per slot cannot exceed the pool" >&2; exit 1; }
[[ $EUID -eq 0 ]] || { echo "run with sudo" >&2; exit 1; }
command -v mkfs.xfs >/dev/null || apt-get install -y -qq xfsprogs >/dev/null
OWNER_UID=$(id -u "$OWNER")

# Room for the pool and the workspaces at their limits, plus xfs metadata.
size=$(( POOL_GIB + WS_GIB + 2 ))G
if [[ ! -f "$IMG" ]]; then
  truncate -s "$size" "$IMG"
  mkfs.xfs -q "$IMG"
fi

cat >"$UNIT" <<UNIT_EOF
[Unit]
Description=winnowl sandbox scratch slots (xfs project quotas on a direct-I/O loop device)
DefaultDependencies=no
After=local-fs.target
Before=docker.service user@.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/sh -c 'mountpoint -q $MNT || { mkdir -p $MNT && dev=\$(losetup -f --show --direct-io=on $IMG) && mount -o prjquota \$dev $MNT; }'
ExecStop=/bin/sh -c 'dev=\$(findmnt -no SOURCE $MNT); umount $MNT && losetup -d \$dev'

[Install]
WantedBy=multi-user.target
UNIT_EOF
systemctl daemon-reload
systemctl enable --now winnowl-scratch.service >/dev/null

# Grow (never shrink) to fit the requested layout.
want=$(( (POOL_GIB + WS_GIB + 2) * 1024 * 1024 * 1024 ))
have=$(stat -c %s "$IMG")
if (( want > have )); then
  truncate -s "$want" "$IMG"
  losetup -c "$(findmnt -no SOURCE "$MNT")"
  xfs_growfs "$MNT" >/dev/null
fi

for ((i = 0; i < SLOTS; i++)); do
  dir="$MNT/slot-$i"
  mkdir -p "$dir"
  # 1777 like /tmp: the sandbox user writes, the sticky bit keeps one sandbox's files its own.
  chmod 1777 "$dir"
  xfs_quota -x -c "project -s -p $dir $((1000 + i))" "$MNT" >/dev/null
  # Until the agent sets a sandbox's own limit: nobody writes to a slot that is not handed out.
  xfs_quota -x -c "limit -p bhard=${MAX_GIB}g $((1000 + i))" "$MNT"
done
for dir in "$MNT"/slot-*; do
  n="${dir##*-}"
  if (( n >= SLOTS )) && [[ -z "$(ls -A "$dir")" ]]; then rmdir "$dir"; fi
done
mkdir -p "$MNT/workspaces"
chown "$OWNER" "$MNT/workspaces"
chmod 755 "$MNT/workspaces"
xfs_quota -x -c "project -s -p $MNT/workspaces 999" "$MNT" >/dev/null
xfs_quota -x -c "limit -p bhard=${WS_GIB}g 999" "$MNT"
chown "$OWNER" "$MNT"

cat >"$CONF" <<CONF_EOF
SLOTS=$SLOTS
MAX_SLOT_MB=$(( MAX_GIB * 1024 ))
MNT=$MNT
IMG=$IMG
CONF_EOF
install -d -m 755 "$(dirname "$QUOTA_BIN")"
cat >"$QUOTA_BIN" <<'QUOTA_EOF'
#!/usr/bin/env bash
# One request per connection (socket-activated, stdin/stdout = the socket). See deploy/scratch-slots.sh.
set -uo pipefail
source /etc/winnowl-scratch.conf
fail() { echo "error $*"; exit 0; }
read -r -t 5 cmd a b rest || fail "no request"
[[ -z "${rest:-}" ]] || fail "unexpected arguments"
case "$cmd" in
  limit)
    [[ "$a" =~ ^[0-9]{1,2}$ ]] && (( 10#$a < SLOTS )) || fail "slot out of range"
    [[ "$b" =~ ^[0-9]{1,9}$ ]] && (( 10#$b >= 1 && 10#$b <= MAX_SLOT_MB )) || fail "limit must be 1..$MAX_SLOT_MB MiB"
    xfs_quota -x -c "limit -p bhard=$((10#$b))m $((1000 + 10#$a))" "$MNT" >/dev/null 2>&1 || fail "xfs_quota failed"
    echo ok
    ;;
  report)
    [[ -z "$a" ]] || fail "report takes no arguments"
    xfs_quota -x -c 'report -p -N -b' "$MNT" 2>/dev/null |
      awk -v slots="$SLOTS" '{ id = $1; sub(/^#/, "", id); if (id >= 1000 && id < 1000 + slots) print "slot", id - 1000, $2, $4 }'
    echo "hostfree $(df -k --output=avail "$(dirname "$IMG")" | tail -1 | tr -d ' ')"
    echo ok
    ;;
  *) fail "unknown command" ;;
esac
QUOTA_EOF
chmod 755 "$QUOTA_BIN"
cat >/etc/systemd/system/winnowl-scratch-quota.socket <<SOCK_EOF
[Unit]
Description=winnowl scratch quota service (set a slot's disk limit, report usage)
After=winnowl-scratch.service
Requires=winnowl-scratch.service

[Socket]
ListenStream=/var/lib/winnowl-scratch-quota.sock
SocketUser=$OWNER_UID
SocketMode=0600
Accept=yes
MaxConnections=16

[Install]
WantedBy=sockets.target
SOCK_EOF
cat >/etc/systemd/system/winnowl-scratch-quota@.service <<SVC_EOF
[Unit]
Description=winnowl scratch quota request

[Service]
ExecStart=$QUOTA_BIN
StandardInput=socket
StandardOutput=socket
StandardError=journal
RuntimeMaxSec=30
PrivateNetwork=yes
PrivateTmp=yes
NoNewPrivileges=yes
ProtectHome=yes
ProtectSystem=strict
ReadWritePaths=$MNT
SVC_EOF
systemctl daemon-reload
systemctl enable --now winnowl-scratch-quota.socket >/dev/null
systemctl restart winnowl-scratch-quota.socket

echo "scratch: $SLOTS slots sharing ${POOL_GIB} GiB (at most ${MAX_GIB} GiB each) + ${WS_GIB} GiB workspaces at $MNT ($(du -h "$IMG" | cut -f1) used on disk)"
echo "agent env: AGENT_SCRATCH_SLOTS=$SLOTS AGENT_SCRATCH_POOL_MB=$(( POOL_GIB * 1024 )) AGENT_SCRATCH_MAX_SLOT_MB=$(( MAX_GIB * 1024 ))"
