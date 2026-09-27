#!/usr/bin/env bash
# Is this checkout merged code? The one provenance rule for the owner's tools
# that change the organisation or handle an App's private key
# (governance/bootstrap.sh --apply, governance/identity/create-app.py):
# run only from a commit that is on marvinamiranda/.github `test` as GitHub has
# it now, read from its canonical URL (never from whatever `origin` points at),
# with no uncommitted change under governance/. A commit that only exists in
# this clone, or on a pull request branch, could hold a change nobody reviewed.
#
# Sourced (bootstrap.sh): defines mm_provenance <dir> <scratch dir>, which sets
#   PROVENANCE_HEAD     the checkout's HEAD, or empty outside a git checkout
#   PROVENANCE_TEST     test's commit as read now, when it could be read
#   PROVENANCE_PROBLEM  why it is not merged code, or empty when it is
# and prints nothing.
#
# Run (create-app.py): checks the governance/ directory above this file. Prints
# the commit and exits 0 when it is on test; otherwise prints why on stderr and
# exits 1.
#
# Needs git and bash 3.2 or later. Makes no GitHub API call: it reads test with
# `git ls-remote` and, when this clone lacks that commit, fetches it.
#
# test is read with a clean git configuration and an empty environment, from
# outside any checkout: `env -i` keeps PATH alone, so no GIT_CONFIG_COUNT or
# GIT_CONFIG_PARAMETERS, no GIT_DIR, no proxy (HTTPS_PROXY, ALL_PROXY) and no
# CA override (SSL_CERT_FILE, SSL_CERT_DIR, GIT_SSL_*) reaches it; no global
# or system config either (GIT_CONFIG_NOSYSTEM=1 matters: Homebrew's system
# gitconfig is writable by the owner's account). GIT_TERMINAL_PROMPT=0: should
# the repository ever need credentials, the read fails instead of prompting. Otherwise a `url.<x>.insteadOf` anywhere in the
# owner's configuration (or the checkout's own), or a proxy with its own CA,
# could answer for the canonical URL with an unreviewed commit. The fetch of that
# exact commit may use the ordinary configuration: it is asked for by SHA, so a
# redirect can only fail to supply it.
#
# Every git call here ignores replace refs (refs/replace/*) and grafts
# (.git/info/grafts): either can give any commit, tree or blob a different
# history or content, so an unmerged commit could pass merge-base, or a file
# its content check. Git reads both from the checkout, so a process that can
# write there could plant them.
#
# "Uncommitted changes" is judged by content, not by `git status` alone:
# every file under the directory must hash to its blob in HEAD, so an edit
# hidden with skip-worktree or assume-unchanged still counts.

MM_PROVENANCE_REPO="marvinamiranda/.github"
MM_PROVENANCE_URL="https://github.com/$MM_PROVENANCE_REPO.git"

# git, with replace refs and grafts ignored. The graft advice is silenced: git
# prints it whenever it reads a graft file, /dev/null included.
mm_git() {
  GIT_NO_REPLACE_OBJECTS=1 GIT_GRAFT_FILE=/dev/null git -c advice.graftFileDeprecated=false "$@"
}

# The first file under $1 whose content is not its blob in HEAD, or nothing.
mm_provenance_changed() {
  local dir="$1" entry meta path mode type sha
  while IFS= read -r -d '' entry; do
    meta="${entry%%$'\t'*}"
    path="${entry#*$'\t'}"
    read -r mode type sha <<<"$meta"
    [[ "$type" == "blob" ]] || continue
    if [[ "$mode" == "120000" ]]; then
      [[ -L "$dir/$path" && "$(readlink "$dir/$path")" == "$(mm_git -C "$dir" cat-file blob "$sha")" ]] || { printf '%s' "$path"; return 0; }
    elif [[ -L "$dir/$path" || ! -f "$dir/$path" || "$(mm_git -C "$dir" hash-object -- "$path")" != "$sha" ]]; then
      printf '%s' "$path"
      return 0
    fi
  done < <(mm_git -C "$dir" ls-tree -r -z HEAD -- .)
  return 0
}

mm_provenance() {
  local dir="$1" scratch="$2"
  PROVENANCE_HEAD=""
  PROVENANCE_TEST=""
  PROVENANCE_PROBLEM=""
  if ! mm_git -C "$dir" rev-parse --git-dir >/dev/null 2>&1; then
    PROVENANCE_PROBLEM="this is not a git checkout, so its commit cannot be checked"
    return 0
  fi
  PROVENANCE_HEAD="$(mm_git -C "$dir" rev-parse HEAD)"
  local hidden=""
  if [[ -n "$(mm_git -C "$dir" status --porcelain --untracked-files=all -- .)" ]]; then
    PROVENANCE_PROBLEM="this checkout has uncommitted changes"
  elif hidden="$(mm_provenance_changed "$dir")" && [[ -n "$hidden" ]]; then
    PROVENANCE_PROBLEM="this checkout has uncommitted changes: $hidden differs from its commit, though git status does not show it"
  elif ! PROVENANCE_TEST="$(cd / && env -i PATH="$PATH" \
        GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_NO_REPLACE_OBJECTS=1 GIT_GRAFT_FILE=/dev/null \
        GIT_TERMINAL_PROMPT=0 git ls-remote "$MM_PROVENANCE_URL" refs/heads/test 2>"$scratch/ls-remote.err" | cut -f1)" \
      || [[ ! "$PROVENANCE_TEST" =~ ^[0-9a-f]{40}$ ]]; then
    PROVENANCE_PROBLEM="$MM_PROVENANCE_REPO test could not be read from $MM_PROVENANCE_URL: $(tr '\n' ' ' <"$scratch/ls-remote.err")"
  elif ! mm_git -C "$dir" cat-file -e "$PROVENANCE_TEST^{commit}" 2>/dev/null \
      && ! mm_git -C "$dir" fetch --quiet --no-tags "$MM_PROVENANCE_URL" "$PROVENANCE_TEST" 2>"$scratch/fetch.err"; then
    PROVENANCE_PROBLEM="$MM_PROVENANCE_REPO test (${PROVENANCE_TEST:0:12}) could not be fetched: $(tr '\n' ' ' <"$scratch/fetch.err")"
  elif ! mm_git -C "$dir" merge-base --is-ancestor "$PROVENANCE_HEAD" "$PROVENANCE_TEST"; then
    PROVENANCE_PROBLEM="commit ${PROVENANCE_HEAD:0:12} is not on $MM_PROVENANCE_REPO test (read now: ${PROVENANCE_TEST:0:12}), so it has not been merged"
  fi
  return 0
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  set -euo pipefail
  governance="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  scratch="$(mktemp -d "${TMPDIR:-/tmp}/mm-provenance.XXXXXX")"
  trap 'rm -rf "$scratch"' EXIT
  mm_provenance "$governance" "$scratch"
  if [[ -n "$PROVENANCE_PROBLEM" ]]; then
    echo "$PROVENANCE_PROBLEM" >&2
    exit 1
  fi
  echo "Running from $MM_PROVENANCE_REPO commit $PROVENANCE_HEAD, which is on test (read now: ${PROVENANCE_TEST:0:12})."
  if [[ "$PROVENANCE_HEAD" != "$PROVENANCE_TEST" ]]; then
    echo "WARNING: that is an older merged commit, not test's tip (${PROVENANCE_TEST:0:12}). Check out the tip unless you mean to run older code."
  fi
fi
