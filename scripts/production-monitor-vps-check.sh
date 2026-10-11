#!/usr/bin/env bash
# Read-only, forced-command health probe for a dedicated monitoring SSH account.
# Install outside the app tree only after review/approval; never expose raw PM2/env output.
set -u

APP_PORT='5000'
export PATH='/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
export PM2_HOME='/root/.pm2'
if [[ "$(id -u)" -ne 0 ]]; then
  printf '{"nginx":"unknown","pm2":"unknown","diskUsedPercent":-1,"memoryAvailablePercent":-1,"memoryAvailableMb":-1,"database":"unknown"}\n'
  exit 0
fi

nginx_state="$(/usr/bin/systemctl is-active nginx 2>/dev/null || true)"
disk_used="$(/usr/bin/df -P / 2>/dev/null | /usr/bin/awk 'NR==2 { gsub(/%/, "", $5); print $5 }')"
memory="$(/usr/bin/free -b 2>/dev/null | /usr/bin/awk '/^Mem:/ { if ($2 > 0) printf "%.0f %.0f", ($7 / $2) * 100, $7 / 1048576 }')"
memory_percent="${memory%% *}"
memory_mb="${memory#* }"
pm2_state='offline'
if /usr/bin/pm2 status --no-color 2>/dev/null | /usr/bin/grep -E 'shopviomall.*online|online.*shopviomall' >/dev/null; then
  pm2_state='online'
fi
db_state='disconnected'
health="$(/usr/bin/curl -fsS --connect-timeout 3 --max-time 6 "http://127.0.0.1:${APP_PORT}/api/health" 2>/dev/null || true)"
if printf '%s' "$health" | /usr/bin/grep -Eq '"success"[[:space:]]*:[[:space:]]*true' \
  && printf '%s' "$health" | /usr/bin/grep -Eq '"status"[[:space:]]*:[[:space:]]*"ok"' \
  && printf '%s' "$health" | /usr/bin/grep -Eq '"database"[[:space:]]*:[[:space:]]*"connected"'; then
  db_state='connected'
fi

[[ "$disk_used" =~ ^[0-9]+$ ]] || disk_used='-1'
[[ "$memory_percent" =~ ^[0-9]+$ ]] || memory_percent='-1'
[[ "$memory_mb" =~ ^[0-9]+$ ]] || memory_mb='-1'
printf '{"nginx":"%s","pm2":"%s","diskUsedPercent":%s,"memoryAvailablePercent":%s,"memoryAvailableMb":%s,"database":"%s"}\n' \
  "$nginx_state" "$pm2_state" "$disk_used" "$memory_percent" "$memory_mb" "$db_state"
