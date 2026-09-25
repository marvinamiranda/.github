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
set -euo pipefail

usage() { echo "usage: post-review.sh <owner/repo> <sha> <success|failure> <summary>" >&2; exit 2; }
[[ $# -eq 4 ]] || usage
REPO="$1" SHA="$2" CONCLUSION="$3" SUMMARY="$4"
[[ "$REPO" =~ ^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$ ]] || { echo "not owner/repo: $REPO" >&2; usage; }
[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "not a full 40-character commit sha: $SHA" >&2; usage; }
case "$CONCLUSION" in success|failure) ;; *) echo "conclusion must be success or failure" >&2; usage ;; esac
[[ -n "$SUMMARY" ]] || { echo "summary is empty" >&2; usage; }

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GH_TOKEN="$("$HERE/app-token.sh" mm-reviewer)"
export GH_TOKEN

title="Independent review: $CONCLUSION"
jq -n --arg sha "$SHA" --arg c "$CONCLUSION" --arg t "$title" --arg s "$SUMMARY" '{
    name: "review/independent",
    head_sha: $sha,
    status: "completed",
    conclusion: $c,
    output: {title: $t, summary: $s}
  }' | gh api -X POST "repos/$REPO/check-runs" --input - --jq '"posted review/independent=\(.conclusion) on \(.head_sha[0:12]) as \(.app.slug): \(.html_url)"'
