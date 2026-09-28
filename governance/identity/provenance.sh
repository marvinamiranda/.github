#!/usr/bin/env bash
# Is this checkout merged code? The one provenance rule for the owner's tools
# that change the organisation or handle an App's private key
# (governance/bootstrap.sh --apply, governance/identity/create-app.py):
# run only from a commit that is on marvinamiranda/.github `test` as GitHub has
# it now, read from its canonical URL (never from whatever `origin` points at),
# with no uncommitted change under governance/. A commit that only exists in
# this clone, or on a pull request branch, could hold a change nobody reviewed.
#
# Sourced (bootstrap.sh, agent-env.sh): defines mm_provenance <dir> <scratch
# dir>, which sets
#   PROVENANCE_HEAD     the checkout's HEAD, or empty when it cannot be read
#   PROVENANCE_TEST     test's commit as read now, when it could be read
#   PROVENANCE_PROBLEM  why it is not merged code, or empty when it is
#   PROVENANCE_REPO     when it is: the scratch repository test was fetched into
#   PROVENANCE_PREFIX   when it is: <dir>'s path in the repository, "" or "a/b/"
# and prints nothing. <scratch dir> must be private to the caller.
#
# Run (create-app.py): checks the governance/ directory above this file. Prints
# the commit and exits 0 when it is on test; otherwise prints why on stderr and
# exits 1. With --emit <path under governance/> <file>, it also writes that
# file's bytes as test's history holds them at the checked commit to <file>.
#
# Needs git and bash 3.2 or later. Makes no GitHub API call: it fetches test.
#
# WHAT IS TRUSTED. Only two things come from the checkout: HEAD's commit id and
# the bytes of the files under <dir>. Everything under .git is writable by any
# process that can plant something there, and git acts on it: repo-local
# config runs code (core.fsmonitor, a clean filter, a hook), and the object
# store answers for an id with whatever is filed under it. Git re-hashes an
# object only when it writes it, so a replaced pack or loose object can give a
# commit that merge-base walks to another parent, or a blob other bytes, and
# replace refs, grafts and the commit-graph can do the same. So:
#   - no git process ever runs in the checkout. HEAD is read from the files
#     git keeps it in (.git/HEAD, then the loose ref or packed-refs line it
#     names; a .git file and a worktree's commondir are followed). Anything
#     else, a reftable repository for one, is refused rather than guessed;
#   - every decision is made in a bare repository this script creates and owns
#     under <scratch dir>, fetched from the canonical URL. Its objects come
#     from the network and are hashed as they arrive, so nothing in the
#     checkout's object store can reach it;
#   - "on test" is `merge-base --is-ancestor HEAD test` in that repository. A
#     HEAD test's history does not hold is not on test;
#   - "unchanged" is: every file of HEAD's tree under <dir> (that repository's
#     tree) is on disk with exactly its blob's bytes, hashed there with
#     --no-filters, and nothing else is under <dir>. So an edit hidden from
#     `git status` (skip-worktree, assume-unchanged) counts, and so does any
#     file the commit does not hold;
#   - create-app.py reads the manifest from that repository (--emit), never
#     from the checkout.
#
# No command this file runs is found through the caller's PATH as given, and
# none runs with its working directory in the checkout: bootstrap.sh sources
# it in the shell that exports the owner's token, and a PATH with an empty
# entry (":$PATH", from an unset variable), a relative entry, or an entry
# inside the checkout would find whatever the checkout holds under a
# command's name. MM_PROVENANCE_PATH is the caller's PATH with only its
# absolute entries outside the checkout; every external command runs from /
# under `env -i` with that PATH (mm_run, mm_scratch_git), and the rest is
# bash builtins.
#
# Every git call runs under `env -i` with that PATH alone: no GIT_DIR,
# GIT_CONFIG_COUNT or GIT_CONFIG_PARAMETERS, no proxy (HTTPS_PROXY, ALL_PROXY),
# no CA override (SSL_CERT_FILE, SSL_CERT_DIR, GIT_SSL_*), no token (GH_TOKEN,
# GITHUB_TOKEN: the repository is public). No global or system config either
# (GIT_CONFIG_NOSYSTEM=1 matters: Homebrew's system gitconfig is writable by
# the owner's account), so no `url.<x>.insteadOf` can answer for the canonical
# URL. GIT_TERMINAL_PROMPT=0: should the repository ever need credentials, the
# read fails instead of prompting. Replace refs, grafts and the commit-graph
# are ignored too, though a repository fetched a moment ago holds none.
#
# What this does not cover: a process that can write the working files
# themselves could change them after the check. The manifest is read from the
# scratch repository for that reason; the scripts are already running.

MM_PROVENANCE_REPO="marvinamiranda/.github"
MM_PROVENANCE_URL="https://github.com/$MM_PROVENANCE_REPO.git"
MM_PROVENANCE_WRAP=() # never taken from the environment

# The caller's PATH with its empty and relative entries dropped, and, given the
# checkout's top <top>, every entry at or under it. Builtins only.
mm_provenance_safe_path() {
  local entry real out=""
  local -a entries=()
  IFS=: read -r -a entries <<<"$PATH"
  for entry in ${entries[@]+"${entries[@]}"}; do
    [[ "$entry" == /* ]] || continue
    if [[ -n "${1:-}" ]]; then
      real="$(cd "$entry" 2>/dev/null && pwd -P)" || real="$entry"
      if [[ "$real" == "$1" || "$real" == "$1"/* || "$entry" == "$1" || "$entry" == "$1"/* ]]; then continue; fi
    fi
    out="${out:+$out:}$entry"
  done
  printf '%s' "${out:-/usr/bin:/bin}"
}
MM_PROVENANCE_PATH="$(mm_provenance_safe_path)" # refined once the checkout is known

# <command...> from /, with an empty environment but MM_PROVENANCE_PATH.
mm_run() {
  (cd / && PATH="$MM_PROVENANCE_PATH" && exec env -i PATH="$MM_PROVENANCE_PATH" LC_ALL=C "$@")
}

# git in the repository <git dir> that provenance made: an empty environment
# but PATH, no global or system config, run from /, no prompt, no replace refs,
# grafts or commit-graph. MM_PROVENANCE_WRAP, when a caller sets it, is a
# command git runs under (a time limit).
mm_scratch_git() {
  local gitdir="$1"
  shift
  (cd / && PATH="$MM_PROVENANCE_PATH" && exec env -i PATH="$MM_PROVENANCE_PATH" GIT_DIR="$gitdir" GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 \
    GIT_NO_REPLACE_OBJECTS=1 GIT_GRAFT_FILE=/dev/null GIT_TERMINAL_PROMPT=0 GIT_ATTR_NOSYSTEM=1 \
    ${MM_PROVENANCE_WRAP[@]+"${MM_PROVENANCE_WRAP[@]}"} git -c core.commitGraph=false -c advice.graftFileDeprecated=false "$@")
}

# The first line of <file>, whether or not it ends in a newline.
mm_provenance_line() {
  local line=""
  IFS= read -r line <"$1" 2>/dev/null || [[ -n "$line" ]] || return 1
  printf '%s' "$line"
}

# The checkout's top: the nearest directory at or above <dir> holding .git.
mm_provenance_top() {
  local d
  d="$(cd "$1" 2>/dev/null && pwd -P)" || return 1
  while [[ ! -e "$d/.git" ]]; do
    [[ "$d" != "/" && -n "$d" ]] || return 1
    d="${d%/*}"
    [[ -n "$d" ]] || d=/
  done
  printf '%s' "$d"
}

# The git directory of the checkout at <top>, and (second line) the common
# directory its refs and objects live in.
mm_provenance_gitdirs() {
  local top="$1" gitdir common line
  if [[ -d "$top/.git" ]]; then
    gitdir="$top/.git"
  else
    line="$(mm_provenance_line "$top/.git")" || return 1
    [[ "$line" == "gitdir: "?* ]] || return 1
    gitdir="${line#gitdir: }"
    [[ "$gitdir" == /* ]] || gitdir="$top/$gitdir"
  fi
  common="$gitdir"
  if [[ -f "$gitdir/commondir" ]]; then
    line="$(mm_provenance_line "$gitdir/commondir")" || return 1
    if [[ "$line" == /* ]]; then common="$line"; else common="$gitdir/$line"; fi
  fi
  printf '%s\n%s\n' "$gitdir" "$common"
}

# HEAD's commit id, read from the files git keeps it in: a detached HEAD, or a
# branch as a loose ref or a packed-refs line. Anything else fails.
mm_provenance_head() {
  local gitdir common line ref sha="" re_ref='^ref: (refs/[A-Za-z0-9._/-]+)$' re_sha='^[0-9a-f]{40}$'
  { IFS= read -r gitdir && IFS= read -r common; } <<<"$(mm_provenance_gitdirs "$1")" || return 1
  [[ -n "$gitdir" && -n "$common" ]] || return 1
  line="$(mm_provenance_line "$gitdir/HEAD")" || return 1
  if [[ "$line" =~ $re_sha ]]; then
    printf '%s' "$line"
    return 0
  fi
  [[ "$line" =~ $re_ref ]] || return 1
  ref="${BASH_REMATCH[1]}"
  [[ "$ref" != *..* && "$ref" != */ ]] || return 1
  if [[ -f "$common/$ref" ]]; then
    sha="$(mm_provenance_line "$common/$ref")" || return 1
  elif [[ -f "$common/packed-refs" ]]; then
    local id name
    while IFS=' ' read -r id name; do
      if [[ "$name" == "$ref" ]]; then sha="$id"; break; fi
    done <"$common/packed-refs"
  fi
  [[ "$sha" =~ $re_sha ]] || return 1
  printf '%s' "$sha"
}

# Why a file under <dir> is not exactly the tree of <commit> in <repo> under
# <prefix>, or nothing. <work> is a private directory for lists.
mm_provenance_changed() {
  local dir="$1" prefix="$2" commit="$3" repo="$4" work="$5" entry meta path rel mode type sha have
  if ! mm_scratch_git "$repo" ls-tree -r -z --full-tree "$commit" -- ${prefix:+"$prefix"} >"$work/tree" 2>/dev/null; then
    printf 'the tree of commit %s could not be read' "${commit:0:12}"
    return 0
  fi
  : >"$work/tracked"
  while IFS= read -r -d '' entry; do
    meta="${entry%%$'\t'*}"
    path="${entry#*$'\t'}"
    rel="${path#"$prefix"}"
    read -r mode type sha <<<"$meta"
    printf '%s\n' "$rel" >>"$work/tracked"
    [[ "$type" == "blob" ]] || continue
    if [[ "$mode" == "120000" ]]; then
      if [[ ! -L "$dir/$rel" ]] || [[ "$(mm_run readlink "$dir/$rel")" != "$(mm_scratch_git "$repo" cat-file blob "$sha")" ]]; then
        printf '%s differs from its commit' "$path"
        return 0
      fi
    elif [[ -L "$dir/$rel" || ! -f "$dir/$rel" ]]; then
      printf '%s differs from its commit (it is missing, or not a regular file)' "$path"
      return 0
    elif ! have="$(mm_scratch_git "$repo" hash-object --no-filters --stdin <"$dir/$rel")" || [[ "$have" != "$sha" ]]; then
      printf '%s differs from its commit' "$path"
      return 0
    fi
  done <"$work/tree"
  # Anything else under <dir>, listed by absolute path from /: a name holding
  # a line break cannot be listed line by line, so it is reported as such.
  local present entry_path
  if ! mm_run find "$dir" -path "$dir/.git" -prune -o ! -type d -print >"$work/present" 2>/dev/null; then
    printf 'the files under %s could not be listed' "$dir"
    return 0
  fi
  if [[ -n "$(mm_run find "$dir" -path "$dir/.git" -prune -o -name "*"$'\n'"*" -print 2>/dev/null)" ]]; then
    printf 'a file under %s has a line break in its name' "$dir"
    return 0
  fi
  : >"$work/present.rel"
  while IFS= read -r entry_path; do
    printf '%s\n' "${entry_path#"$dir/"}" >>"$work/present.rel"
  done <"$work/present"
  present="$(mm_run grep -Fxv -f "$work/tracked" "$work/present.rel")" || true
  rel="${present%%$'\n'*}"
  if [[ -n "$rel" ]]; then
    printf '%s%s is not in its commit' "$prefix" "$rel"
  fi
  return 0
}

# Init <repo> and fetch test into it from the canonical URL. Sets
# PROVENANCE_TEST, or PROVENANCE_PROBLEM. MM_PROVENANCE_TIMEOUT (seconds), when
# set and perl is there, bounds the fetch: perl's alarm survives its exec.
mm_provenance_fetch() {
  local repo="$1" out re_sha='^[0-9a-f]{40}$'
  local -a MM_PROVENANCE_WRAP=()
  if ! out="$(mm_scratch_git "$repo" init --quiet --bare --template= 2>&1)"; then
    PROVENANCE_PROBLEM="a scratch repository to check $MM_PROVENANCE_REPO test in could not be made: ${out//$'\n'/ }"
    return 0
  fi
  if [[ "${MM_PROVENANCE_TIMEOUT:-}" =~ ^[1-9][0-9]{0,3}$ ]] && PATH="$MM_PROVENANCE_PATH" command -v perl >/dev/null 2>&1; then
    MM_PROVENANCE_WRAP=(perl -e 'alarm shift @ARGV; exec @ARGV or exit 127' "$MM_PROVENANCE_TIMEOUT")
  fi
  if ! out="$(mm_scratch_git "$repo" fetch --quiet --no-tags "$MM_PROVENANCE_URL" "+refs/heads/test:refs/heads/test" 2>&1)" \
      || ! PROVENANCE_TEST="$(mm_scratch_git "$repo" rev-parse --verify --quiet 'refs/heads/test^{commit}' 2>/dev/null)" \
      || [[ ! "$PROVENANCE_TEST" =~ $re_sha ]]; then
    PROVENANCE_TEST=""
    PROVENANCE_PROBLEM="$MM_PROVENANCE_REPO test could not be read from $MM_PROVENANCE_URL: ${out//$'\n'/ }"
  fi
  return 0
}

mm_provenance() {
  local dir="$1" scratch="$2" top prefix repo reason
  PROVENANCE_HEAD=""
  PROVENANCE_TEST=""
  PROVENANCE_PROBLEM=""
  PROVENANCE_REPO=""
  PROVENANCE_PREFIX=""
  if ! top="$(mm_provenance_top "$dir")"; then
    PROVENANCE_PROBLEM="this is not a git checkout, so its commit cannot be checked"
    return 0
  fi
  dir="$(cd "$dir" && pwd -P)"
  MM_PROVENANCE_PATH="$(mm_provenance_safe_path "$top")"
  if ! scratch="$(cd "$scratch" 2>/dev/null && pwd -P)"; then
    PROVENANCE_PROBLEM="the scratch directory ${2} cannot be used"
    return 0
  fi
  prefix="${dir#"$top"}"
  prefix="${prefix#/}"
  [[ -z "$prefix" ]] || prefix="$prefix/"
  if ! PROVENANCE_HEAD="$(mm_provenance_head "$top")"; then
    PROVENANCE_HEAD=""
    PROVENANCE_PROBLEM="the commit of the checkout at $top could not be read from its HEAD file (a detached HEAD, or a branch in a loose or packed ref, is needed; git is never run in the checkout). Check out a merged commit by its SHA"
    return 0
  fi
  repo="$scratch/canonical.git"
  mm_provenance_fetch "$repo"
  [[ -z "$PROVENANCE_PROBLEM" ]] || return 0
  if ! mm_scratch_git "$repo" cat-file -e "$PROVENANCE_HEAD^{commit}" 2>/dev/null \
      || ! mm_scratch_git "$repo" merge-base --is-ancestor "$PROVENANCE_HEAD" "$PROVENANCE_TEST" 2>/dev/null; then
    PROVENANCE_PROBLEM="commit ${PROVENANCE_HEAD:0:12} is not on $MM_PROVENANCE_REPO test (read now: ${PROVENANCE_TEST:0:12}), so it has not been merged"
    return 0
  fi
  reason="$(mm_provenance_changed "$dir" "$prefix" "$PROVENANCE_HEAD" "$repo" "$scratch")"
  if [[ -n "$reason" ]]; then
    PROVENANCE_PROBLEM="this checkout has uncommitted changes: $reason"
    return 0
  fi
  PROVENANCE_REPO="$repo"
  PROVENANCE_PREFIX="$prefix"
  return 0
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  set -euo pipefail
  emit_path=""
  emit_to=""
  if [[ $# -gt 0 ]]; then
    if [[ $# -ne 3 || "$1" != "--emit" || -z "$2" || -z "$3" ]]; then
      echo "usage: provenance.sh [--emit <path under governance/> <file>]" >&2
      exit 2
    fi
    emit_path="$2"
    emit_to="$3"
  fi
  here="${BASH_SOURCE[0]%/*}"
  [[ "$here" != "${BASH_SOURCE[0]}" ]] || here=.
  governance="$(cd "$here/.." && pwd)"
  # This process's own commands too: the caller's PATH, as for the rule.
  if top="$(mm_provenance_top "$governance")"; then MM_PROVENANCE_PATH="$(mm_provenance_safe_path "$top")"; fi
  PATH="$MM_PROVENANCE_PATH"
  scratch="$(mktemp -d "${TMPDIR:-/tmp}/mm-provenance.XXXXXX")"
  trap 'rm -rf "$scratch"' EXIT
  mm_provenance "$governance" "$scratch"
  if [[ -n "$PROVENANCE_PROBLEM" ]]; then
    echo "$PROVENANCE_PROBLEM" >&2
    exit 1
  fi
  if [[ -n "$emit_path" ]] && ! mm_scratch_git "$PROVENANCE_REPO" cat-file blob "$PROVENANCE_HEAD:$PROVENANCE_PREFIX$emit_path" >"$emit_to" 2>/dev/null; then
    echo "$PROVENANCE_PREFIX$emit_path is not in commit ${PROVENANCE_HEAD:0:12}" >&2
    exit 1
  fi
  echo "Running from $MM_PROVENANCE_REPO commit $PROVENANCE_HEAD, which is on test (read now: ${PROVENANCE_TEST:0:12})."
  if [[ "$PROVENANCE_HEAD" != "$PROVENANCE_TEST" ]]; then
    echo "WARNING: that is an older merged commit, not test's tip (${PROVENANCE_TEST:0:12}). Check out the tip unless you mean to run older code."
  fi
fi
