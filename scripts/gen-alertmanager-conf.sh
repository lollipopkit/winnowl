#!/usr/bin/env bash
# Writes $SECRETS_DIR/alertmanager.yml (contains the SMTP password) from SMTP_* / MAIL_FROM / ALERT_EMAIL_TO in .env.
# Usage, from deploy/: bash ../scripts/gen-alertmanager-conf.sh
set -euo pipefail
ENV_FILE="${1:-./.env}"
[ -f "$ENV_FILE" ] || { echo "找不到 $ENV_FILE" >&2; exit 1; }
# shellcheck disable=SC1090
set -a; source "$ENV_FILE"; set +a
: "${SMTP_HOST:?需 SMTP_HOST}"; : "${SMTP_PASS:?需 SMTP_PASS}"; : "${MAIL_FROM:?需 MAIL_FROM}"; : "${ALERT_EMAIL_TO:?需 ALERT_EMAIL_TO}"
# Same rule as assertMailFrom (packages/notifications): `addr` or `Name <addr>`; a domain alone gets 550.
ADDR='[^[:space:]<>@]+@[^[:space:]<>@]+\.[^[:space:]<>@]+'
[[ "$MAIL_FROM" =~ ^($ADDR|[^\<\>@]*\<$ADDR\>)$ ]] \
  || { echo "MAIL_FROM 须是完整发件地址(如 winnowl@example.com 或 Name <winnowl@example.com>),当前不是" >&2; exit 1; }
OUT_DIR="${SECRETS_DIR:-./.secrets}"
mkdir -p "$OUT_DIR"
OUT="$OUT_DIR/alertmanager.yml"
TMP="$(mktemp)"
cat > "$TMP" <<CONF
# 由 scripts/gen-alertmanager-conf.sh 生成(含 SMTP 密码,勿入 git)。
global:
  smtp_smarthost: '${SMTP_HOST}:${SMTP_PORT:-587}'
  smtp_from: '${MAIL_FROM}'
  smtp_auth_username: '${SMTP_USER:-resend}'
  smtp_auth_password: '${SMTP_PASS}'
  smtp_require_tls: true
route:
  receiver: mail
  group_by: ['alertname']
  group_wait: 30s
  group_interval: 5m
  repeat_interval: 6h
receivers:
  - name: mail
    email_configs:
      - to: '${ALERT_EMAIL_TO}'
        send_resolved: true
CONF
# alertmanager runs as nobody (65534) in the container.
sudo install -m 600 -o 65534 -g 65534 "$TMP" "$OUT" 2>/dev/null || install -m 600 "$TMP" "$OUT"
rm -f "$TMP"
echo "已生成 $OUT"
