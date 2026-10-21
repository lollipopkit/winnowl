#!/usr/bin/env bash
# Compressed swap cache on a sandbox host so sandbox memory peaks (`swapMb`) do not become disk I/O.
# Applied now and at every boot (systemd-tmpfiles).
#
#   sudo deploy/zswap.sh [max pool %]
set -euo pipefail
POOL="${1:-25}"
[[ "$POOL" =~ ^[1-9][0-9]?$ ]] || { echo "max pool % must be 1-99" >&2; exit 1; }
[[ $EUID -eq 0 ]] || { echo "run with sudo" >&2; exit 1; }
P=/sys/module/zswap/parameters
[[ -d $P ]] || { echo "this kernel has no zswap" >&2; exit 1; }
swapon --show=NAME --noheadings | grep -q . || echo "warning: no swap device; zswap needs one behind it" >&2
# zstd compresses best; fall back to lz4, then the kernel's default.
comp=$(cat $P/compressor)
for c in zstd lz4; do
  if modprobe -q "$c" 2>/dev/null || grep -qw "$c" /proc/crypto; then comp=$c; break; fi
done
cat >/etc/tmpfiles.d/winnowl-zswap.conf <<CONF
w $P/compressor - - - - $comp
w $P/max_pool_percent - - - - $POOL
w $P/enabled - - - - Y
CONF
systemd-tmpfiles --create /etc/tmpfiles.d/winnowl-zswap.conf
echo "zswap: enabled=$(cat $P/enabled) compressor=$(cat $P/compressor) max_pool_percent=$(cat $P/max_pool_percent)"
