#!/usr/bin/env bash
# The gh an agent shell runs. agent-env.sh writes a launcher that execs this,
# ~/.config/mm-agent/<name>/bin/gh, and puts it first on PATH, so child
# processes (scripts, `bash -c`, an agent CLI's tool shells) run it too:
#
#   gh-shim.sh <mm-agent|mm-reviewer> <real gh> [gh arguments...]
#
# Every call takes its token from app-token.sh (minted, or reused for at most
# 5 minutes) and runs the real gh with that token and with the identity's
# empty GH_CONFIG_DIR. When no installation token comes back it fails and gh
# never runs, so nothing falls back to the owner's login.
#
# It refuses `gh auth`, except a plain `gh auth status`. `gh auth token` would
# hand out a raw token, which a variable then keeps past its minutes, and
# `gh auth token --user <owner>` reads the owner's keyring login whatever
# GH_TOKEN holds. It refuses `gh alias set|import`, which could run one of
# those under another name.
#
# A strong default, not a sandbox: the real gh is one absolute path away.
set -uo pipefail

usage='usage: gh-shim.sh <identity> <real gh> [gh arguments...]'
NAME="${1:?$usage}"
REAL="${2:?$usage}"
shift 2
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

refuse() {
  printf 'gh (%s agent shell): refused: %s\n' "$NAME" "$1" >&2
  exit 1
}

case "${1:-}" in
  auth)
    if [[ $# -ne 2 || "$2" != status ]]; then
      refuse "gh $*. An agent shell hands out no token and holds no login: run gh and git directly, and each call gets a fresh token. Only a plain 'gh auth status' is allowed."
    fi
    ;;
  alias)
    case "${2:-}" in
      set|import) refuse "gh alias $2: an alias could run a refused command under another name." ;;
    esac
    ;;
esac

token="$("$HERE/app-token.sh" "$NAME")" \
  || refuse "no $NAME token could be minted (app-token.sh said why, above), so gh was not run."
[[ "$token" == ghs_?* ]] || refuse "app-token.sh returned no installation token, so gh was not run."

GH_TOKEN="$token" GH_CONFIG_DIR="$HOME/.config/mm-agent/$NAME/gh" exec "$REAL" "$@"
