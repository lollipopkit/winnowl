#!/usr/bin/env bash
# Idempotently writes Langfuse secrets into .env (0600); values are never echoed.
#   LANGFUSE_ADMIN_EMAIL=you@example.com LANGFUSE_BASE_URL=https://<host>.exe.xyz bash gen-secrets.sh
# Existing keys are never replaced: changing ENCRYPTION_KEY / SALT invalidates already-encrypted data.
set -euo pipefail
ENV_FILE="${1:-./.env}"
[ -f "$ENV_FILE" ] || : > "$ENV_FILE"

: "${LANGFUSE_ADMIN_EMAIL:?需先 export LANGFUSE_ADMIN_EMAIL=you@example.com}"
: "${LANGFUSE_BASE_URL:?需先 export LANGFUSE_BASE_URL=https://<host>.exe.xyz}"

KEYS=(
  LANGFUSE_ENCRYPTION_KEY LANGFUSE_SALT LANGFUSE_NEXTAUTH_SECRET
  LANGFUSE_PG_PASSWORD LANGFUSE_CLICKHOUSE_PASSWORD LANGFUSE_REDIS_PASSWORD
  LANGFUSE_MINIO_PASSWORD LANGFUSE_ADMIN_PASSWORD
  LANGFUSE_PUBLIC_KEY LANGFUSE_SECRET_KEY LANGFUSE_ADMIN_EMAIL LANGFUSE_BASE_URL
)
missing=0
for k in "${KEYS[@]}"; do grep -qE "^${k}=" "$ENV_FILE" || missing=1; done
if [ "$missing" -eq 0 ]; then
  echo "Langfuse 密钥已齐,无改动。"
  exit 0
fi

# Ensure a trailing newline so appended keys do not join the last line.
[ -s "$ENV_FILE" ] && [ "$(tail -c 1 "$ENV_FILE" | wc -l)" -eq 0 ] && printf '\n' >> "$ENV_FILE"
printf '\n# --- Langfuse(gen-secrets.sh 生成,勿入 git)---\n' >> "$ENV_FILE"

# Values come via stdin to keep them out of argv; `$(cat)` strips the trailing newline.
put() {
  local key="$1" val
  val="$(cat)"
  if grep -qE "^${key}=" "$ENV_FILE"; then
    echo "  ${key} 已存在,跳过"
    return
  fi
  printf '%s=%s\n' "$key" "$val" >> "$ENV_FILE"
  echo "  ${key} 已生成"
}

echo "写入 $ENV_FILE:"
# ENCRYPTION_KEY must be 64 hex chars. Others drop =/+ so they are safe in .env and DATABASE_URL.
openssl rand -hex 32 | put LANGFUSE_ENCRYPTION_KEY
for k in LANGFUSE_SALT LANGFUSE_NEXTAUTH_SECRET LANGFUSE_PG_PASSWORD \
         LANGFUSE_CLICKHOUSE_PASSWORD LANGFUSE_REDIS_PASSWORD LANGFUSE_MINIO_PASSWORD \
         LANGFUSE_ADMIN_PASSWORD; do
  openssl rand -base64 32 | tr -d '\n=/+' | cut -c1-32 | put "$k"
done
# Project API keys (bootstrapped via LANGFUSE_INIT_*, also used for OTLP auth); pk-lf-/sk-lf- are Langfuse's prefixes.
{ printf 'pk-lf-'; openssl rand -hex 16; } | put LANGFUSE_PUBLIC_KEY
{ printf 'sk-lf-'; openssl rand -hex 16; } | put LANGFUSE_SECRET_KEY
printf '%s' "$LANGFUSE_ADMIN_EMAIL" | put LANGFUSE_ADMIN_EMAIL
printf '%s' "$LANGFUSE_BASE_URL" | put LANGFUSE_BASE_URL

chmod 600 "$ENV_FILE"
echo "完成。UI:$LANGFUSE_BASE_URL(注册已关,只有自举的这个账号能登)。"
echo "取管理员密码:grep '^LANGFUSE_ADMIN_PASSWORD=' $ENV_FILE"
echo "取 winnowl 侧要用的 OTLP 认证:grep -E '^LANGFUSE_(PUBLIC|SECRET)_KEY=' $ENV_FILE"
