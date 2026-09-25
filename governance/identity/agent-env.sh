#!/usr/bin/env bash
# Print the environment an agent session runs under, for `eval` (DELIVERY
# Appendix A):
#
#   eval "$(governance/identity/agent-env.sh mm-agent)"      # a builder's shell
#   eval "$(governance/identity/agent-env.sh mm-reviewer)"   # a reviewer's shell
#
# Everything it sets is exported, so every child process inherits it. An agent
# CLI that starts a fresh shell for each tool call (Claude Code does) needs the
# eval in every call, or must be started from a shell that has run it.
#
# What it sets, and why:
#   PATH            the identity's gh first: ~/.config/mm-agent/<name>/bin/gh,
#                   a launcher for gh-shim.sh. Every gh call, in this shell or
#                   any child, gets a token minted for it, and fails rather
#                   than fall back when none can be minted. It refuses
#                   `gh auth` (bar a plain `gh auth status`), so no command
#                   hands out a raw token.
#   GH_TOKEN, GITHUB_TOKEN, GH_PACKAGES_TOKEN
#                   unset. Nothing here exports a token, and one inherited from
#                   the owner's shell must not survive the eval.
#   GH_CONFIG_DIR   an EMPTY directory of this identity's, so the real gh, run
#                   by its absolute path, finds no stored login.
#   git identity    author and committer are the App's bot user.
#   git credentials for github.com: the helper list is reset, then one helper
#                   mints a token for each operation, and tells git to stop
#                   (quit=true) instead of trying another credential or
#                   prompting when it cannot.
#
# If anything fails, it prints an environment with NO GitHub identity rather
# than nothing, since `eval ""` would leave the shell on the owner's login:
# tokens unset, a gh that refuses everything, git told to quit, no commit
# identity, and a status that makes the eval fail.
#
# This is a strong default, not a sandbox. Agents run on the owner's machine,
# under the owner's user, and the owner's keyring login is one absolute path
# away (`/opt/homebrew/bin/gh auth token`). The rulesets are the backstop
# (DELIVERY §9).
set -euo pipefail

ROOT="$HOME/.config/mm-agent"
LOCK="$ROOT/locked"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
q() { printf '%q' "$1"; }

# PATH without any directory of ours (a previous eval's shim), so evals do not
# stack, and the gh found here is the real one, never a shim.
clean_path=""
real_gh=""
IFS=: read -r -a path_dirs <<<"$PATH"
for d in ${path_dirs[@]+"${path_dirs[@]}"}; do
  case "$d" in "$ROOT" | "$ROOT"/*) continue ;; esac
  clean_path="${clean_path:+$clean_path:}$d"
  if [[ -z "$real_gh" && "$d" == /* && -f "$d/gh" && -x "$d/gh" ]]; then real_gh="$d/gh"; fi
done

PRINTED=0
locked() {
  PRINTED=1
  mkdir -p "$LOCK/bin" "$LOCK/gh" 2>/dev/null || true
  chmod 700 "$ROOT" "$LOCK" "$LOCK/gh" 2>/dev/null || true
  local tmp
  if tmp="$(mktemp "$LOCK/bin/.gh.XXXXXX" 2>/dev/null)"; then
    if ! { { printf '#!/bin/sh\n'
             printf 'echo "gh: refused: this shell has no GitHub identity, because governance/identity/agent-env.sh failed. Fix what it said, then eval it again." >&2\n'
             printf 'exit 1\n'; } >"$tmp" && chmod 755 "$tmp" && mv -f "$tmp" "$LOCK/bin/gh"; }; then
      rm -f "$tmp"
    fi
  fi
  cat <<EOF
unset GH_TOKEN GITHUB_TOKEN GH_PACKAGES_TOKEN
unset -f gh 2>/dev/null || true; unalias gh 2>/dev/null || true
gh() { echo "gh: refused: this shell has no GitHub identity, because agent-env.sh failed." >&2; return 1; }
export GH_CONFIG_DIR=$(q "$LOCK/gh")
export PATH=$(q "$LOCK/bin${clean_path:+:$clean_path}")
hash -r 2>/dev/null || true
export GIT_AUTHOR_NAME= GIT_COMMITTER_NAME=
export GIT_CONFIG_COUNT=2
export GIT_CONFIG_KEY_0=credential.https://github.com.helper GIT_CONFIG_VALUE_0=
export GIT_CONFIG_KEY_1=credential.https://github.com.helper GIT_CONFIG_VALUE_1=$(q '!f(){ echo quit=true; }; f')
echo $(q "agent-env.sh: $1") >&2
echo 'agent-env.sh: this shell now has NO GitHub identity: gh, git pushes and commits refuse until agent-env.sh succeeds.' >&2
false
EOF
  exit 1
}
# Any failure not caught below still prints the environment with no identity.
on_exit() {
  local rc=$?
  if [[ $rc -ne 0 && $PRINTED -eq 0 ]]; then locked "stopped (exit $rc) before it finished"; fi
}
trap on_exit EXIT

[[ $# -eq 1 ]] || locked "usage: agent-env.sh <mm-agent|mm-reviewer>"
NAME="$1"
case "$NAME" in mm-agent | mm-reviewer) ;; *) locked "unknown identity: $NAME (mm-agent or mm-reviewer)" ;; esac
DIR="$ROOT/$NAME"
APP_JSON="$DIR/app.json"
GH_DIR="$DIR/gh"
BIN="$DIR/bin"
TOKEN_CMD="$HERE/app-token.sh"
[[ -r "$APP_JSON" ]] || locked "missing $APP_JSON; run create-app.py $NAME first"
[[ -x "$HERE/gh-shim.sh" && -x "$TOKEN_CMD" ]] || locked "gh-shim.sh or app-token.sh is missing beside $0"
[[ -n "$real_gh" ]] || locked "no gh on PATH"
if ! { mkdir -p "$GH_DIR" "$BIN" && chmod 700 "$ROOT" "$DIR" "$GH_DIR" "$BIN"; }; then
  locked "cannot create $GH_DIR and $BIN"
fi
[[ ! -e "$GH_DIR/hosts.yml" ]] || locked "$GH_DIR/hosts.yml exists: this directory must hold no login. Remove it."

# The launcher sits at a fixed path outside any checkout. If the checkout it
# points into loses gh-shim.sh (an older commit checked out), exec fails: it
# never falls through to the real gh.
tmp="$(mktemp "$BIN/.gh.XXXXXX")" || locked "cannot write $BIN/gh"
if ! { printf '#!/usr/bin/env bash\n# Written by %s; rewritten on every run.\nexec %s %s %s "$@"\n' \
         "$(q "$HERE/agent-env.sh")" "$(q "$HERE/gh-shim.sh")" "$(q "$NAME")" "$(q "$real_gh")" >"$tmp" \
       && chmod 700 "$tmp" && mv -f "$tmp" "$BIN/gh"; }; then
  rm -f "$tmp"
  locked "cannot write $BIN/gh"
fi

slug="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["slug"])' "$APP_JSON")" \
  || locked "no slug in $APP_JSON"
bot="${slug}[bot]"
# The bot user's id never changes: it is looked up once, then read back, so an
# eval needs no network.
bot_id=""
if [[ -r "$DIR/bot-id" ]]; then read -r bot_id <"$DIR/bot-id" || true; fi
if [[ ! "$bot_id" =~ ^[0-9]+$ ]]; then
  token="$("$TOKEN_CMD" "$NAME")" \
    || locked "no $NAME token could be minted to look up its bot user (app-token.sh said why, above)"
  bot_id="$(curl -fsS -H "Authorization: Bearer $token" -H "Accept: application/vnd.github+json" \
    "https://api.github.com/users/${slug}%5Bbot%5D" | python3 -c 'import json,sys;print(json.load(sys.stdin)["id"])')" \
    || locked "could not look up the bot user $bot"
  unset token
  [[ "$bot_id" =~ ^[0-9]+$ ]] || locked "unexpected id for $bot: $bot_id"
  printf '%s\n' "$bot_id" >"$DIR/bot-id"
fi
email="${bot_id}+${bot}@users.noreply.github.com"

# For `get`: a fresh token, or quit=true when there is none, so git neither
# prompts nor tries another credential.
# shellcheck disable=SC2016  # git's shell expands these when it runs the helper
helper='!f(){ test "$1" = get || exit 0; t=$('"$(q "$TOKEN_CMD") $(q "$NAME")"') || t=; case "$t" in ghs_?*) printf "username=x-access-token\npassword=%s\n" "$t";; *) echo quit=true;; esac; }; f'

cat <<EOF
unset GH_TOKEN GITHUB_TOKEN GH_PACKAGES_TOKEN
unset -f gh 2>/dev/null || true; unalias gh 2>/dev/null || true
export GH_CONFIG_DIR=$(q "$GH_DIR")
export PATH=$(q "$BIN${clean_path:+:$clean_path}")
hash -r 2>/dev/null || true
export GIT_AUTHOR_NAME=$(q "$bot") GIT_COMMITTER_NAME=$(q "$bot")
export GIT_AUTHOR_EMAIL=$(q "$email") GIT_COMMITTER_EMAIL=$(q "$email")
export GIT_CONFIG_COUNT=2
export GIT_CONFIG_KEY_0=credential.https://github.com.helper GIT_CONFIG_VALUE_0=
export GIT_CONFIG_KEY_1=credential.https://github.com.helper GIT_CONFIG_VALUE_1=$(q "$helper")
EOF
PRINTED=1
