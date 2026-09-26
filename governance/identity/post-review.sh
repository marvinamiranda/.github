#!/usr/bin/env bash
# Post the review/independent check on a commit, as the Reviewer App (DELIVERY §10).
#
#   governance/identity/post-review.sh <owner/repo> <sha> <success|failure> <summary>
#
# The token comes from app-token.sh mm-reviewer, so the check run is created by
# the Reviewer App — the only source the test-integration ruleset accepts for
# review/independent. A new push has no check run for its new head, which is
# what resets the review. Findings belong in review comments on the pull
# request; <summary> is the one-paragraph verdict.
# Requires MM_REAL_GH_BIN and an isolated GH_CONFIG_DIR from agent-env.sh; PATH
# may begin with the mm-agent identity shim and is never used to choose gh.
set -euo pipefail

usage() { echo "usage: post-review.sh <owner/repo> <sha> <success|failure> <summary>" >&2; exit 2; }
[[ $# -eq 4 ]] || usage
REPO="$1" SHA="$2" CONCLUSION="$3" SUMMARY="$4"
[[ "$REPO" =~ ^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$ ]] || { echo "not owner/repo: $REPO" >&2; usage; }
[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "not a full 40-character commit sha: $SHA" >&2; usage; }
case "$CONCLUSION" in success|failure) ;; *) echo "conclusion must be success or failure" >&2; usage ;; esac
[[ -n "$SUMMARY" ]] || { echo "summary is empty" >&2; usage; }

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REAL_GH="${MM_REAL_GH_BIN:-}"
if [[ "$REAL_GH" != /* || ! -f "$REAL_GH" || ! -x "$REAL_GH" ]]; then
  echo "post-review.sh: no verified real GitHub CLI path; eval agent-env.sh and retry" >&2
  exit 1
fi
if ! MM_ROOT_CANON="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$HOME/.config/mm-agent" 2>/dev/null)" \
    || [[ "$MM_ROOT_CANON" != /* ]]; then
  echo "post-review.sh: cannot resolve the mm-agent directory for real gh verification" >&2
  exit 1
fi
if ! REAL_GH_CANON="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$REAL_GH" 2>/dev/null)" \
    || [[ "$REAL_GH_CANON" != /* || ! -f "$REAL_GH_CANON" || ! -x "$REAL_GH_CANON" ]]; then
  echo "post-review.sh: cannot verify the real GitHub CLI path" >&2
  exit 1
fi
case "$REAL_GH_CANON" in
  "$MM_ROOT_CANON" | "$MM_ROOT_CANON"/*)
    echo "post-review.sh: MM_REAL_GH_BIN resolves inside the mm-agent identity directory" >&2
    exit 1
    ;;
esac
REAL_GH="$REAL_GH_CANON"
case "${GH_CONFIG_DIR:-}" in
  "$HOME"/.config/mm-agent/*/gh) ;;
  *) echo "post-review.sh: no isolated agent GH_CONFIG_DIR; eval agent-env.sh and retry" >&2; exit 1 ;;
esac
if [[ ! -d "$GH_CONFIG_DIR" || -e "$GH_CONFIG_DIR/hosts.yml" ]]; then
  echo "post-review.sh: agent GH_CONFIG_DIR is missing or contains a login; eval agent-env.sh and retry" >&2
  exit 1
fi

GH_TOKEN="$("$HERE/app-token.sh" mm-reviewer)"
export GH_TOKEN
unset GITHUB_TOKEN

title="Independent review: $CONCLUSION"
jq -n --arg sha "$SHA" --arg c "$CONCLUSION" --arg t "$title" --arg s "$SUMMARY" '{
    name: "review/independent",
    head_sha: $sha,
    status: "completed",
    conclusion: $c,
    output: {title: $t, summary: $s}
  }' | "$REAL_GH" api -X POST "repos/$REPO/check-runs" --input - --jq '"posted review/independent=\(.conclusion) on \(.head_sha[0:12]) as \(.app.slug): \(.html_url)"'
