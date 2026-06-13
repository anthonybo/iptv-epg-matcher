#!/usr/bin/env bash
#
# grab-x-cookies.sh — copy X_COOKIES from the running StormWire backend
# into this project's backend/.env, so the multiview "Live chatter" feed
# can authenticate to X without a paid API.
#
# Why this exists: X_COOKIES is set as an exported shell env var when you
# launch StormWire (it's not stored in any file), so it lives only in the
# running process. This pulls it from that process and writes it here.
# The cookie value is never printed — only a length + sanity check.
#
# Usage:
#   bash backend/scripts/grab-x-cookies.sh
#
set -uo pipefail

# .env sits one level up from this scripts/ dir, regardless of where you
# run the script from.
ENV_FILE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/.env"

echo "Target: $ENV_FILE"

if grep -q '^X_COOKIES=' "$ENV_FILE" 2>/dev/null; then
  echo "✅ X_COOKIES is already set in backend/.env — nothing to do."
  echo "   (Delete that line first if you want to replace it.)"
  exit 0
fi

# Walk StormWire's running processes and grab X_COOKIES from the first one
# whose environment exposes it. The sed cut stops at the next UPPERCASE
# env var — cookie segment names (auth_token, ct0, …) are lowercase, so
# they won't trigger an early cut even though the value contains spaces.
VAL=""
for PID in $(pgrep -f 'stormwire|tsx watch' 2>/dev/null); do
  VAL=$(ps eww -p "$PID" -o command= 2>/dev/null \
        | grep -oE 'X_COOKIES=.*' \
        | sed -E 's/ [A-Z_][A-Z0-9_]*=.*//; s/^X_COOKIES=//')
  [ -n "$VAL" ] && break
done

if [ -z "$VAL" ]; then
  echo "❌ Could not read X_COOKIES from any StormWire process."
  echo "   (Either StormWire isn't running, or macOS is hiding the env.)"
  echo
  echo "   Browser fallback — always works:"
  echo "   1. On x.com → DevTools (F12) → Application → Cookies → https://x.com"
  echo "   2. Copy the auth_token and ct0 values"
  echo "   3. Add this one line to backend/.env:"
  echo '        X_COOKIES="auth_token=PASTE; ct0=PASTE"'
  exit 1
fi

HAS_AUTH=$(printf '%s' "$VAL" | grep -c 'auth_token=')
HAS_CT0=$(printf '%s' "$VAL" | grep -c 'ct0=')

if [ "$HAS_AUTH" -lt 1 ] || [ "$HAS_CT0" -lt 1 ]; then
  echo "⚠️  Retrieved ${#VAL} chars but it's missing auth_token or ct0"
  echo "    (auth_token:$HAS_AUTH ct0:$HAS_CT0) — looks truncated, NOT writing."
  echo "    Use the browser fallback instead (see DevTools → Cookies → x.com)."
  exit 1
fi

printf 'X_COOKIES="%s"\n' "$VAL" >> "$ENV_FILE"
echo "✅ Wrote X_COOKIES to backend/.env (${#VAL} chars, auth_token + ct0 present)."
echo "   Value was not printed. Tell Claude 'done' to reload the backend + verify."
