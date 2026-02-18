#!/bin/bash
set -euo pipefail

# 04-auth-slack.sh — Validate Slack tokens in .env

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
LOG_FILE="$PROJECT_ROOT/logs/setup.log"

mkdir -p "$PROJECT_ROOT/logs"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] [auth-slack] $*" >> "$LOG_FILE"; }

log "Starting Slack authentication check"

# Read tokens from .env
SLACK_BOT_TOKEN=""
SLACK_APP_TOKEN=""
if [ -f "$PROJECT_ROOT/.env" ]; then
  SLACK_BOT_TOKEN=$(grep -E "^SLACK_BOT_TOKEN=" "$PROJECT_ROOT/.env" 2>/dev/null | head -1 | cut -d= -f2- | tr -d "'\"" || true)
  SLACK_APP_TOKEN=$(grep -E "^SLACK_APP_TOKEN=" "$PROJECT_ROOT/.env" 2>/dev/null | head -1 | cut -d= -f2- | tr -d "'\"" || true)
fi

AUTH_STATUS="not_configured"
BOT_USER_ID=""
TEAM=""

if [ -z "$SLACK_BOT_TOKEN" ] || [ -z "$SLACK_APP_TOKEN" ]; then
  log "Missing tokens: BOT_TOKEN=${SLACK_BOT_TOKEN:+set} APP_TOKEN=${SLACK_APP_TOKEN:+set}"
  AUTH_STATUS="missing_tokens"
else
  log "Testing Slack bot token..."
  RESPONSE=$(curl -s -H "Authorization: Bearer $SLACK_BOT_TOKEN" https://slack.com/api/auth.test 2>&1)
  log "auth.test response: $RESPONSE"

  OK=$(echo "$RESPONSE" | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));console.log(d.ok)" 2>/dev/null || echo "false")

  if [ "$OK" = "true" ]; then
    BOT_USER_ID=$(echo "$RESPONSE" | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));console.log(d.user_id||'')" 2>/dev/null || echo "")
    TEAM=$(echo "$RESPONSE" | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));console.log(d.team||'')" 2>/dev/null || echo "")
    AUTH_STATUS="authenticated"
    log "Slack auth OK: user=$BOT_USER_ID team=$TEAM"
  else
    ERROR=$(echo "$RESPONSE" | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));console.log(d.error||'unknown')" 2>/dev/null || echo "unknown")
    AUTH_STATUS="failed"
    log "Slack auth failed: $ERROR"
  fi
fi

log "Auth check complete: $AUTH_STATUS"

cat <<EOF
=== NANOCLAW SETUP: AUTH_SLACK ===
AUTH_STATUS: $AUTH_STATUS
BOT_USER_ID: $BOT_USER_ID
TEAM: $TEAM
LOG: logs/setup.log
=== END ===
EOF

if [ "$AUTH_STATUS" != "authenticated" ]; then
  exit 1
fi
