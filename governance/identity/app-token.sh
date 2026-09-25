#!/usr/bin/env bash
# Print a short-lived (1 hour) installation token for an agent identity App.
#
#   export GH_TOKEN=$(governance/identity/app-token.sh mm-agent)      # builders
#   export GH_TOKEN=$(governance/identity/app-token.sh mm-reviewer)   # reviewers
#
# Prefer governance/identity/agent-env.sh, which also isolates gh from the
# owner's login and re-mints the token per command.
#
# Reads ~/.config/mm-agent/<name>/{app.json,private-key.pem}, written by create-app.py.
# Caches the token until 5 minutes before it expires. Never echoes the private
# key or a token on failure; a failed call prints its HTTP status and GitHub's
# message, and a 401 discards the cache so the next call mints afresh.
set -euo pipefail

NAME=${1:?usage: app-token.sh <mm-agent|mm-reviewer>}
ORG=${ORG:-marvinamiranda}
DIR="$HOME/.config/mm-agent/$NAME"
KEY="$DIR/private-key.pem"
CACHE="$DIR/token.cache"
[[ -r "$KEY" && -r "$DIR/app.json" ]] || { echo "missing $DIR — run create-app.py $NAME first" >&2; exit 1; }

now=$(date +%s)
if [[ -r "$CACHE" ]]; then
  read -r exp tok < "$CACHE" || true
  if [[ -n "${exp:-}" && -n "${tok:-}" ]] && (( exp - 300 > now )); then printf '%s\n' "$tok"; exit 0; fi
fi

APP_ID=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["id"])' "$DIR/app.json")
b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }
header=$(printf '{"alg":"RS256","typ":"JWT"}' | b64url)
payload=$(printf '{"iat":%d,"exp":%d,"iss":"%s"}' $((now - 60)) $((now + 540)) "$APP_ID" | b64url)
sig=$(printf '%s.%s' "$header" "$payload" | openssl dgst -sha256 -sign "$KEY" -binary | b64url)
jwt="$header.$payload.$sig"

BODY_FILE="$(mktemp "${TMPDIR:-/tmp}/app-token.XXXXXX")"
trap 'rm -f "$BODY_FILE"' EXIT

# api <what> <curl args...>: prints the response body; on a non-2xx status
# prints the status and GitHub's message to stderr and fails.
api() {
  local what="$1"; shift
  local status
  status=$(curl -sS -o "$BODY_FILE" -w '%{http_code}' \
    -H "Authorization: Bearer $jwt" -H "Accept: application/vnd.github+json" \
    -H "X-GitHub-Api-Version: 2022-11-28" "$@") || { echo "$what: request failed (network)" >&2; return 1; }
  if [[ "$status" != 2* ]]; then
    local message
    message=$(python3 -c 'import json,sys
try: print(json.load(open(sys.argv[1])).get("message",""))
except Exception: print(open(sys.argv[1]).read()[:300])' "$BODY_FILE")
    echo "$what: HTTP $status — $message" >&2
    if [[ "$status" == 401 ]]; then rm -f "$CACHE"; echo "(token cache discarded)" >&2; fi
    return 1
  fi
  cat "$BODY_FILE"
}

inst_json=$(api "App $NAME installation on $ORG" "https://api.github.com/orgs/$ORG/installation") \
  || { echo "Is $NAME installed on $ORG, and is its key current?" >&2; exit 1; }
inst=$(printf '%s' "$inst_json" | python3 -c 'import json,sys;print(json.load(sys.stdin)["id"])')
resp=$(api "Installation token for $NAME" -X POST "https://api.github.com/app/installations/$inst/access_tokens") || exit 1
tok=$(printf '%s' "$resp" | python3 -c 'import json,sys;print(json.load(sys.stdin)["token"])')
exp=$(printf '%s' "$resp" | python3 -c 'import json,sys,datetime;print(int(datetime.datetime.fromisoformat(json.load(sys.stdin)["expires_at"].replace("Z","+00:00")).timestamp()))')
umask 077; printf '%s %s\n' "$exp" "$tok" > "$CACHE"
printf '%s\n' "$tok"
