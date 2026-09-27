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

MM_PROVENANCE_REPO="marvinamiranda/.github"
MM_PROVENANCE_URL="https://github.com/$MM_PROVENANCE_REPO.git"

mm_provenance() {
  local dir="$1" scratch="$2"
  PROVENANCE_HEAD=""
  PROVENANCE_TEST=""
  PROVENANCE_PROBLEM=""
  if ! git -C "$dir" rev-parse --git-dir >/dev/null 2>&1; then
    PROVENANCE_PROBLEM="this is not a git checkout, so its commit cannot be checked"
    return 0
  fi
  PROVENANCE_HEAD="$(git -C "$dir" rev-parse HEAD)"
  if [[ -n "$(git -C "$dir" status --porcelain -- .)" ]]; then
    PROVENANCE_PROBLEM="this checkout has uncommitted changes"
  elif ! PROVENANCE_TEST="$(git ls-remote "$MM_PROVENANCE_URL" refs/heads/test 2>"$scratch/ls-remote.err" | cut -f1)" \
      || [[ ! "$PROVENANCE_TEST" =~ ^[0-9a-f]{40}$ ]]; then
    PROVENANCE_PROBLEM="$MM_PROVENANCE_REPO test could not be read from $MM_PROVENANCE_URL: $(tr '\n' ' ' <"$scratch/ls-remote.err")"
  elif ! git -C "$dir" cat-file -e "$PROVENANCE_TEST^{commit}" 2>/dev/null \
      && ! git -C "$dir" fetch --quiet --no-tags "$MM_PROVENANCE_URL" "$PROVENANCE_TEST" 2>"$scratch/fetch.err"; then
    PROVENANCE_PROBLEM="$MM_PROVENANCE_REPO test (${PROVENANCE_TEST:0:12}) could not be fetched: $(tr '\n' ' ' <"$scratch/fetch.err")"
  elif ! git -C "$dir" merge-base --is-ancestor "$PROVENANCE_HEAD" "$PROVENANCE_TEST"; then
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
fi
