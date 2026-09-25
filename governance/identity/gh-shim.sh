#!/usr/bin/env bash
# The gh an agent shell runs. agent-env.sh copies this file, with
# app-token.sh, out of a commit into ~/.config/mm-agent/<name>/shim/<commit>/,
# and puts a launcher for the copy first on PATH, so child processes (scripts,
# `bash -c`, zsh through its ZDOTDIR) run it too:
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
# GH_TOKEN holds. It refuses `gh alias` except `list` and `delete`, since an
# alias could run a refused command under another name. And it refuses any
# flag ahead of the command: gh parses flags wherever they are, so
# `gh --help=false auth token` runs `gh auth token`, and
# `gh alias --help=false set` runs `gh alias set`. gh's only root flags are
# --help (-h) and --version, which are accepted on their own.
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
  -*)
    if [[ $# -ne 1 || ( "$1" != --help && "$1" != -h && "$1" != --version ) ]]; then
      refuse "gh $1 ...: a flag ahead of the command, which could hide the command from these checks. Put flags after the command; only --help, -h or --version is accepted there, on its own."
    fi
    ;;
  auth)
    if [[ $# -ne 2 || "$2" != status ]]; then
      refuse "gh $*. An agent shell hands out no token and holds no login: run gh and git directly, and each call gets a fresh token. Only a plain 'gh auth status' is allowed."
    fi
    ;;
  alias)
    case "${2:-}" in
      "" | list | delete) ;;
      *) refuse "gh alias ${2}: an alias could run a refused command under another name, so only 'gh alias list' and 'gh alias delete' are allowed." ;;
    esac
    ;;
esac

token="$("$HERE/app-token.sh" "$NAME")" \
  || refuse "no $NAME token could be minted (app-token.sh said why, above), so gh was not run."
[[ "$token" == ghs_?* ]] || refuse "app-token.sh returned no installation token, so gh was not run."

GH_TOKEN="$token" GH_CONFIG_DIR="$HOME/.config/mm-agent/$NAME/gh" exec "$REAL" "$@"
