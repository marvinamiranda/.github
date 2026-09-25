#!/usr/bin/env bash
# Print a short-lived (1 hour) installation token for an agent identity App.
#
#   export GH_TOKEN=$(governance/identity/app-token.sh mm-agent)      # builders
#   export GH_TOKEN=$(governance/identity/app-token.sh mm-reviewer)   # reviewers
#
# Reads ~/.config/mm-agent/<name>/{app.json,private-key.pem}, written by create-app.py.
# Caches the token until 5 minutes before it expires. Never echoes the private key.
set -euo pipefail

NAME=${1:?usage: app-token.sh <mm-agent|mm-reviewer>}
ORG=${ORG:-marvinamiranda}
DIR="$HOME/.config/mm-agent/$NAME"
KEY="$DIR/private-key.pem"
CACHE="$DIR/token.cache"
[[ -r "$KEY" && -r "$DIR/app.json" ]] || { echo "missing $DIR — run create-app.py $NAME first" >&2; exit 1; }

now=$(date +%s)
if [[ -r "$CACHE" ]]; then
  read -r exp tok < "$CACHE"
  if (( exp - 300 > now )); then printf '%s\n' "$tok"; exit 0; fi
fi

APP_ID=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["id"])' "$DIR/app.json")
b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }
header=$(printf '{"alg":"RS256","typ":"JWT"}' | b64url)
payload=$(printf '{"iat":%d,"exp":%d,"iss":"%s"}' $((now - 60)) $((now + 540)) "$APP_ID" | b64url)
sig=$(printf '%s.%s' "$header" "$payload" | openssl dgst -sha256 -sign "$KEY" -binary | b64url)
jwt="$header.$payload.$sig"

api() { curl -fsS -H "Authorization: Bearer $jwt" -H "Accept: application/vnd.github+json" "$@"; }
inst_json=$(api "https://api.github.com/orgs/$ORG/installation" 2>/dev/null) \
  || { echo "App $NAME is not installed on $ORG — install it first" >&2; exit 1; }
inst=$(printf '%s' "$inst_json" | python3 -c 'import json,sys;print(json.load(sys.stdin)["id"])')
resp=$(api -X POST "https://api.github.com/app/installations/$inst/access_tokens")
tok=$(printf '%s' "$resp" | python3 -c 'import json,sys;print(json.load(sys.stdin)["token"])')
exp=$(printf '%s' "$resp" | python3 -c 'import json,sys,datetime;print(int(datetime.datetime.fromisoformat(json.load(sys.stdin)["expires_at"].replace("Z","+00:00")).timestamp()))')
umask 077; printf '%s %s\n' "$exp" "$tok" > "$CACHE"
printf '%s\n' "$tok"
