#!/usr/bin/env bash
# Print the environment an agent session runs under, for `eval` (DELIVERY
# Appendix A):
#
#   eval "$(governance/identity/agent-env.sh mm-agent)"      # a builder's shell
#   eval "$(governance/identity/agent-env.sh mm-reviewer)"   # a reviewer's shell
#
# What it sets, and why:
#   GH_CONFIG_DIR   an EMPTY directory owned by this identity. gh reads its
#                   login from here, so with no hosts.yml it can never fall back
#                   to the owner's keyring login — a missing GH_TOKEN is an
#                   error, not a silent switch to the owner.
#   GH_TOKEN        a fresh installation token, for tools that read it once.
#   gh()            a shell function that re-mints GH_TOKEN for every gh
#                   command (app-token.sh caches it until 5 minutes before
#                   expiry), so a session outliving the one-hour token keeps
#                   working.
#   git identity    author and committer are the App's bot user.
#   git credentials a credential helper that re-mints the token for every git
#                   operation against github.com, and nothing else.
#
# This is a strong default, not a sandbox: agents run on the owner's machine.
# The rulesets are the backstop (DELIVERY §9).
set -euo pipefail

NAME=${1:?usage: agent-env.sh <mm-agent|mm-reviewer>}
case "$NAME" in mm-agent|mm-reviewer) ;; *) echo "unknown identity: $NAME" >&2; exit 2 ;; esac
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOKEN_CMD="$HERE/app-token.sh"
DIR="$HOME/.config/mm-agent/$NAME"
APP_JSON="$DIR/app.json"
[[ -r "$APP_JSON" ]] || { echo "missing $APP_JSON — run create-app.py $NAME first" >&2; exit 1; }

GH_DIR="$DIR/gh"
mkdir -p "$GH_DIR"
chmod 700 "$GH_DIR"
if [[ -e "$GH_DIR/hosts.yml" ]]; then
  echo "$GH_DIR/hosts.yml exists: this directory must hold no login. Remove it." >&2
  exit 1
fi

token="$("$TOKEN_CMD" "$NAME")"
slug="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["slug"])' "$APP_JSON")"
bot="${slug}[bot]"
bot_id="$(curl -fsS -H "Authorization: Bearer $token" -H "Accept: application/vnd.github+json" \
  "https://api.github.com/users/${slug}%5Bbot%5D" | python3 -c 'import json,sys;print(json.load(sys.stdin)["id"])')" \
  || { echo "could not look up the bot user ${bot}" >&2; exit 1; }
email="${bot_id}+${bot}@users.noreply.github.com"

q() { printf '%q' "$1"; }
helper="!f(){ test \"\$1\" = get || exit 0; echo username=x-access-token; echo \"password=\$($(q "$TOKEN_CMD") $NAME)\"; }; f"

cat <<EOF
export GH_CONFIG_DIR=$(q "$GH_DIR")
export GH_TOKEN=$(q "$token")
gh() { GH_TOKEN="\$($(q "$TOKEN_CMD") $NAME)" command gh "\$@"; }
export GIT_AUTHOR_NAME=$(q "$bot") GIT_COMMITTER_NAME=$(q "$bot")
export GIT_AUTHOR_EMAIL=$(q "$email") GIT_COMMITTER_EMAIL=$(q "$email")
export GIT_CONFIG_COUNT=2
export GIT_CONFIG_KEY_0=credential.https://github.com.helper GIT_CONFIG_VALUE_0=
export GIT_CONFIG_KEY_1=credential.https://github.com.helper GIT_CONFIG_VALUE_1=$(q "$helper")
EOF
