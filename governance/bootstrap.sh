#!/usr/bin/env bash
# Bootstrap the delivery standard (DELIVERY §14) for the marvinamiranda organisation.
#
#   governance/bootstrap.sh --repo omni237 --repo omni237-ops --project          # dry run
#   governance/bootstrap.sh --repo omni237 --repo omni237-ops --project --apply  # owner only
#
# DRY RUN BY DEFAULT: only read calls are made, and every call that would
# change something is printed instead. `--apply` executes them. Idempotent:
# each step reads the current state first and changes only what differs.
#
# Product structure lives in each product repository, never here (DELIVERY §6):
# it reads .github/governance/{areas.txt, required-checks.txt,
# required-checks.main.txt} from each repo's `test` branch, or from
# --config-dir <dir>/<repo>/ for local testing.
#
# What it does, in order:
#   a) org issue types Epic, Decision, Spike (Task and Bug must already exist;
#      Feature is left alone)
#   b) per repo: default branch -> test (closing keywords only act on merges
#      into the default branch, DELIVERY §4)
#   c) per repo: the §11 labels, plus area:* labels from areas.txt
#   d) per repo: rulesets `test-integration`, `main-owner-only` and
#      `main-checks`, created or updated by name (DELIVERY §9, §10)
#   e) with --project: the Project, its Status/Priority/Size fields, and a link
#      to each repo
#
# What it never does: delete a label, a ruleset, a field, a field option or an
# issue. Anything that exists and is not in the standard is REPORTED so the
# owner can retire it deliberately. Identities are GitHub Apps, created and
# installed by the owner (governance/identity/, DELIVERY Appendix A).
#
# Needs: gh (for --apply: an organisation owner with admin:org, repo and
# project scopes) and jq.
set -euo pipefail

ORG="marvinamiranda"
APPLY=0
REPOS=()
WANT_PROJECT=0
PROJECT_TITLE="Omni237 Delivery"
CONFIG_DIR=""
CONFIG_REF="test"
STRICT_UP_TO_DATE=false
REVIEWER_APP_ID=""
REVIEWER_APP_JSON="${MM_REVIEWER_APP_JSON:-$HOME/.config/mm-agent/mm-reviewer/app.json}"

# GitHub Actions' app id. Every required CI check and governance/issue-link is a
# check run created by this app; pinning the context to it means neither a
# personal token nor another App can satisfy the check. Measured, not assumed:
# `gh api repos/marvinamiranda/omni237/commits/<sha>/check-runs --jq '.check_runs[].app.id'`
# returns 15368 for every check on the last five merged pull requests of
# omni237 and omni237-ops (2026-09-25).
ACTIONS_APP_ID=15368

usage() {
  sed -n '2,35p' "$0" | sed 's/^# \{0,1\}//'
  cat <<EOF

Options:
  --repo <name>            Repository in $ORG to configure. Repeatable. Required.
  --apply                  Execute the changes. Without it nothing is written.
  --project                Also ensure the Project and link the repos to it.
  --project-title <t>      Project title (default: "$PROJECT_TITLE").
  --reviewer-app-id <id>   The Reviewer App's id, which review/independent is pinned to.
                           Default: "id" in $REVIEWER_APP_JSON.
  --config-dir <dir>       Read <dir>/<repo>/areas.txt etc. instead of the repo's
                           .github/governance/ on $CONFIG_REF (local testing).
  --strict-up-to-date      Require branches to be up to date with the base before merge.
  -h, --help               This text.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply) APPLY=1 ;;
    --repo) [[ $# -ge 2 ]] || { echo "--repo needs a value" >&2; exit 2; }; REPOS+=("$2"); shift ;;
    --project) WANT_PROJECT=1 ;;
    --project-title) [[ $# -ge 2 ]] || { echo "--project-title needs a value" >&2; exit 2; }; PROJECT_TITLE="$2"; shift ;;
    --reviewer-app-id) [[ $# -ge 2 && "$2" =~ ^[0-9]+$ ]] || { echo "--reviewer-app-id needs a numeric id" >&2; exit 2; }; REVIEWER_APP_ID="$2"; shift ;;
    --config-dir) [[ $# -ge 2 ]] || { echo "--config-dir needs a value" >&2; exit 2; }; CONFIG_DIR="$(cd "$2" && pwd)"; shift ;;
    --strict-up-to-date) STRICT_UP_TO_DATE=true ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

[[ ${#REPOS[@]} -gt 0 ]] || { echo "At least one --repo is required." >&2; usage >&2; exit 2; }
command -v gh >/dev/null || { echo "gh is required" >&2; exit 1; }
command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/mm-bootstrap.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

# ---------------------------------------------------------------- output ----
section() { printf '\n== %s\n' "$*"; }
info()    { printf '   %s\n' "$*"; }
warn()    { printf '   WARNING: %s\n' "$*"; }
PLANNED=0

# Run a mutating command, or print it in a dry run. Arguments are the command.
mutate() {
  PLANNED=$((PLANNED + 1))
  if [[ $APPLY -eq 1 ]]; then
    printf '   APPLY: %s\n' "$(printf '%q ' "$@")"
    "$@"
  else
    printf '   DRY-RUN would run: %s\n' "$(printf '%q ' "$@")"
  fi
}

# Same, for a gh api call with a JSON body in a file; prints the body too.
mutate_json() {
  local method="$1" path="$2" file="$3"
  PLANNED=$((PLANNED + 1))
  if [[ $APPLY -eq 1 ]]; then
    printf '   APPLY: gh api -X %s %s --input <payload>\n' "$method" "$path"
    gh api -X "$method" "$path" --input "$file" >/dev/null
  else
    printf '   DRY-RUN would run: gh api -X %s %s --input - <<JSON\n' "$method" "$path"
    jq . "$file" | sed 's/^/      /'
    printf '      JSON\n'
  fi
}

# Read-only GET into $BODY. Returns 0, or 4 on a 404, and aborts on anything
# else, so a permissions or network failure is never mistaken for "does not
# exist, create it". Call it directly, never inside $(...): the abort and
# $BODY must reach this shell.
BODY=""
fetch() {
  local path="$1"
  if gh api "$path" >"$WORK/body" 2>"$WORK/err"; then
    BODY="$(cat "$WORK/body")"
    return 0
  fi
  BODY=""
  if grep -q 'HTTP 404' "$WORK/err"; then
    return 4
  fi
  echo "GET $path failed:" >&2
  cat "$WORK/err" >&2
  exit 1
}

# Paginated read-only GET of a JSON array, merged into one array.
get_all() {
  gh api --paginate "$1" | jq -s 'add // []'
}

# Non-comment, non-blank lines of a config file.
config_lines() {
  grep -v '^[[:space:]]*#' "$1" | sed 's/[[:space:]]*$//' | grep -v '^[[:space:]]*$' || true
}

# ------------------------------------------------------------- preflight ----
section "Preflight"
if [[ $APPLY -eq 1 ]]; then
  info "Mode: APPLY — changes will be made."
else
  info "Mode: DRY RUN — read calls only; mutating calls are printed."
fi
info "Organisation: $ORG"
info "Repositories: ${REPOS[*]}"
if [[ -n "$CONFIG_DIR" ]]; then
  info "Product config: $CONFIG_DIR/<repo>/ (local override)"
else
  info "Product config: each repo's .github/governance/ on $CONFIG_REF"
fi
viewer="$(gh api user --jq .login)"
info "Authenticated as: $viewer"
scopes="$(gh auth status 2>&1 | sed -n "s/.*Token scopes: //p" | head -1)"
info "Token scopes: ${scopes:-unknown}"
if [[ "$scopes" != *"admin:org"* ]]; then
  warn "token lacks admin:org — --apply will fail on the organisation issue types."
  warn "grant it with: gh auth refresh -h github.com -s admin:org"
fi
if [[ $WANT_PROJECT -eq 1 && "$scopes" != *"project"* ]]; then
  warn "token lacks the project scope — --apply will fail on the Project."
fi

# The Reviewer App id that review/independent is pinned to.
if [[ -z "$REVIEWER_APP_ID" && -r "$REVIEWER_APP_JSON" ]]; then
  REVIEWER_APP_ID="$(jq -r '.id // empty' "$REVIEWER_APP_JSON")"
  [[ "$REVIEWER_APP_ID" =~ ^[0-9]+$ ]] || REVIEWER_APP_ID=""
fi
if [[ -n "$REVIEWER_APP_ID" ]]; then
  info "Reviewer App id: $REVIEWER_APP_ID (review/independent is pinned to it)"
else
  printf '\n'
  printf '   !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!\n'
  printf '   !! NO REVIEWER APP ID. review/independent is OMITTED from test-integration.\n'
  printf '   !! Requiring it unpinned would let any writer post it; requiring it with\n'
  printf '   !! no reviewer would block every pull request. Neither is acceptable, so\n'
  printf '   !! independent review is NOT enforced until you create the Reviewer App\n'
  printf '   !! (governance/identity/create-app.py mm-reviewer) and re-run this with\n'
  printf '   !! --reviewer-app-id <id> or with %s present.\n' "$REVIEWER_APP_JSON"
  printf '   !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!\n\n'
fi

# Materialise each repo's product config into $WORK/cfg/<repo>/.
load_config() {
  local repo="$1" file="$2" required="$3" dest="$WORK/cfg/$1/$2"
  mkdir -p "$WORK/cfg/$repo"
  if [[ -n "$CONFIG_DIR" ]]; then
    if [[ -f "$CONFIG_DIR/$repo/$file" ]]; then
      cp "$CONFIG_DIR/$repo/$file" "$dest"
      return 0
    fi
  else
    local err="$WORK/cfg-err"
    if gh api -H 'Accept: application/vnd.github.raw' \
        "repos/$ORG/$repo/contents/.github/governance/$file?ref=$CONFIG_REF" >"$dest" 2>"$err"; then
      return 0
    fi
    rm -f "$dest"
    grep -q 'HTTP 404' "$err" || { echo "Reading $repo .github/governance/$file failed:" >&2; cat "$err" >&2; exit 1; }
  fi
  if [[ "$required" == "required" ]]; then
    echo "$ORG/$repo has no .github/governance/$file on $CONFIG_REF${CONFIG_DIR:+ (nor $CONFIG_DIR/$repo/$file)}." >&2
    echo "Adopt the repository first (DELIVERY §14 step 2)." >&2
    exit 1
  fi
  : >"$dest"
}

for repo in "${REPOS[@]}"; do
  fetch "repos/$ORG/$repo" || { echo "Repository $ORG/$repo not found" >&2; exit 1; }
  load_config "$repo" areas.txt required
  load_config "$repo" required-checks.txt required
  load_config "$repo" required-checks.main.txt optional
  info "$repo: $(config_lines "$WORK/cfg/$repo/areas.txt" | wc -l | tr -d ' ') areas, $(config_lines "$WORK/cfg/$repo/required-checks.txt" | wc -l | tr -d ' ') required checks (+$(config_lines "$WORK/cfg/$repo/required-checks.main.txt" | wc -l | tr -d ' ') on main)"
done

# ------------------------------------------------------ a) issue types ----
section "a) Organisation issue types"
fetch "orgs/$ORG/issue-types"
types_json="$BODY"
info "Existing: $(jq -r '[.[] | .name + (if .is_enabled then "" else " (disabled)" end)] | join(", ")' <<<"$types_json")"
for required in Task Bug; do
  if ! jq -e --arg n "$required" 'any(.[]; .name == $n)' <<<"$types_json" >/dev/null; then
    warn "issue type $required does not exist; the $required form will not set a type until it does."
  fi
done
ensure_issue_type() {
  local name="$1" color="$2" description="$3" existing
  existing="$(jq -c --arg n "$name" 'map(select(.name == $n)) | first // empty' <<<"$types_json")"
  if [[ -z "$existing" ]]; then
    jq -n --arg n "$name" --arg c "$color" --arg d "$description" \
      '{name: $n, color: $c, description: $d, is_enabled: true}' >"$WORK/type-$name.json"
    mutate_json POST "orgs/$ORG/issue-types" "$WORK/type-$name.json"
  elif [[ "$(jq -r .is_enabled <<<"$existing")" != "true" ]]; then
    jq -n --arg n "$name" '{name: $n, is_enabled: true}' >"$WORK/type-$name.json"
    mutate_json PUT "orgs/$ORG/issue-types/$(jq -r .id <<<"$existing")" "$WORK/type-$name.json"
  else
    info "$name: present"
  fi
}
ensure_issue_type Epic purple "One capability a user recognises; 3-12 Tasks as sub-issues"
ensure_issue_type Decision orange "A question only the owner may answer (DECISION: <the question>)"
ensure_issue_type Spike green "A time-boxed investigation, at most a day, whose output is a written finding"

# ---------------------------------------------------- b) default branch ----
section "b) Default branch"
for repo in "${REPOS[@]}"; do
  fetch "repos/$ORG/$repo"
  current_default="$(jq -r .default_branch <<<"$BODY")"
  if [[ "$current_default" == "test" ]]; then
    info "$repo: test"
    continue
  fi
  fetch "repos/$ORG/$repo/branches/test" || { warn "$repo has no test branch; default branch left as '$current_default'."; continue; }
  info "$repo: '$current_default' -> 'test'. Closing keywords only act on merges into the default branch (DELIVERY §4); workflow_run and schedule workflows will run test's copies."
  jq -n '{default_branch: "test"}' >"$WORK/default-$repo.json"
  mutate_json PATCH "repos/$ORG/$repo" "$WORK/default-$repo.json"
done

# ---------------------------------------------------------- c) labels ----
# name|color|description — DELIVERY §11. archived-<date> is created by a reset, not here.
STANDARD_LABELS=(
  "tier:mechanical|0e8a16|Copies an existing golden example; no design choice left"
  "tier:standard|fbca04|Ordinary multi-file work with normal engineering judgement"
  "tier:senior|b60205|Touches a risk surface; needs a second, adversarial review"
  "security|d93f0b|Security-relevant; adversarial review before merge"
  "later|cfd3d7|Not in any milestone; revisit at planning"
  "needs-owner|5319e7|Waiting on the owner; see the linked Decision issue"
)
AREA_COLOR="1d76db"

section "c) Labels"
for repo in "${REPOS[@]}"; do
  info "[$repo]"
  current="$(get_all "repos/$ORG/$repo/labels?per_page=100")"
  wanted="$WORK/labels-$repo.tsv"
  : >"$wanted"
  for spec in "${STANDARD_LABELS[@]}"; do
    printf '%s\n' "$spec" >>"$wanted"
  done
  while IFS= read -r line; do
    name="${line%%|*}"
    desc="${line#*|}"
    [[ "$line" == *"|"* ]] || { echo "Malformed line in $repo .github/governance/areas.txt: $line" >&2; exit 1; }
    [[ "$name" =~ ^[a-z0-9][a-z0-9-]*$ ]] || { echo "Area name must be lower-case kebab: $name" >&2; exit 1; }
    [[ ${#desc} -le 100 ]] || { echo "Area description over 100 characters (GitHub limit): $name" >&2; exit 1; }
    printf 'area:%s|%s|%s\n' "$name" "$AREA_COLOR" "$desc" >>"$wanted"
  done < <(config_lines "$WORK/cfg/$repo/areas.txt")

  while IFS='|' read -r name color desc; do
    have="$(jq -c --arg n "$name" 'map(select((.name | ascii_downcase) == ($n | ascii_downcase))) | first // empty' <<<"$current")"
    if [[ -z "$have" ]]; then
      mutate gh label create "$name" -R "$ORG/$repo" --color "$color" --description "$desc"
    elif [[ "$(jq -r '.color | ascii_downcase' <<<"$have")" != "$color" || "$(jq -r '.description // ""' <<<"$have")" != "$desc" || "$(jq -r .name <<<"$have")" != "$name" ]]; then
      mutate gh label edit "$(jq -r .name <<<"$have")" -R "$ORG/$repo" --name "$name" --color "$color" --description "$desc"
    else
      info "  $name: present"
    fi
  done <"$wanted"

  extras="$(jq -r --rawfile w "$wanted" '
      ($w | split("\n") | map(select(length > 0) | split("|")[0] | ascii_downcase)) as $want
      | map(.name) | map(select((ascii_downcase | IN($want[]) | not) and (startswith("archived-") | not))) | .[]' <<<"$current")"
  if [[ -n "$extras" ]]; then
    info "  Not in DELIVERY §11 (reported, never deleted by this script): $(tr '\n' ' ' <<<"$extras")"
  fi
done

# -------------------------------------------------------- d) rulesets ----
# required_status_checks entries: every Actions check pinned to the Actions app,
# plus review/independent pinned to the Reviewer App when its id is known.
required_checks_json() {
  local with_review="$1"; shift
  {
    for f in "$@"; do config_lines "$f"; done
    echo "governance/issue-link"
  } | awk '!seen[$0]++' | jq -R -s --argjson app "$ACTIONS_APP_ID" '
      split("\n") | map(select(length > 0) | {context: ., integration_id: $app})' >"$WORK/checks.json"
  if [[ "$with_review" == "review" && -n "$REVIEWER_APP_ID" ]]; then
    jq --argjson rid "$REVIEWER_APP_ID" '. + [{context: "review/independent", integration_id: $rid}]' "$WORK/checks.json"
  else
    cat "$WORK/checks.json"
  fi
}

# test-integration (DELIVERY §9): pull request, squash only, no approvals (the
# review is the pinned review/independent check), required checks, no force
# push, no deletion, no bypass for anyone.
test_ruleset() {
  jq -n --argjson checks "$1" --argjson strict "$STRICT_UP_TO_DATE" '{
    name: "test-integration", target: "branch", enforcement: "active",
    bypass_actors: [],
    conditions: {ref_name: {include: ["refs/heads/test"], exclude: []}},
    rules: [
      {type: "deletion"},
      {type: "non_fast_forward"},
      {type: "pull_request", parameters: {
        required_approving_review_count: 0, dismiss_stale_reviews_on_push: true,
        require_code_owner_review: false, require_last_push_approval: false,
        required_review_thread_resolution: false, allowed_merge_methods: ["squash"]}},
      {type: "required_status_checks", parameters: {
        strict_required_status_checks_policy: $strict, do_not_enforce_on_create: false,
        required_status_checks: $checks}}
    ]}'
}

# main is guarded by TWO rulesets, split so that the owner's bypass cannot
# reach the checks (DELIVERY §9). A bypass actor bypasses every rule of the
# ruleset it is listed on, so the one bypass lives alone:
#
# main-owner-only: nobody may update main except an organisation admin, and
# only through a pull request — `update` (restrict updates) with the
# OrganizationAdmin role as the only bypass, in pull_request mode. Nothing else.
main_owner_ruleset() {
  jq -n '{
    name: "main-owner-only", target: "branch", enforcement: "active",
    bypass_actors: [{actor_id: 1, actor_type: "OrganizationAdmin", bypass_mode: "pull_request"}],
    conditions: {ref_name: {include: ["refs/heads/main"], exclude: []}},
    rules: [
      {type: "update", parameters: {update_allows_fetch_and_merge: false}}
    ]}'
}

# main-checks: what every change to main must pass, the owner's included —
# no bypass. Merge commits only: releases squashed onto main left test and main
# with different histories, and omni237-ops pull requests 113, 115, 118, 121
# and 126 were spent re-syncing them ("MERGE WITH A MERGE COMMIT — … stop this
# recurring").
main_checks_ruleset() {
  jq -n --argjson checks "$1" --argjson strict "$STRICT_UP_TO_DATE" '{
    name: "main-checks", target: "branch", enforcement: "active",
    bypass_actors: [],
    conditions: {ref_name: {include: ["refs/heads/main"], exclude: []}},
    rules: [
      {type: "deletion"},
      {type: "non_fast_forward"},
      {type: "pull_request", parameters: {
        required_approving_review_count: 0, dismiss_stale_reviews_on_push: true,
        require_code_owner_review: false, require_last_push_approval: false,
        required_review_thread_resolution: false, allowed_merge_methods: ["merge"]}},
      {type: "required_status_checks", parameters: {
        strict_required_status_checks_policy: $strict, do_not_enforce_on_create: false,
        required_status_checks: $checks}}
    ]}'
}

# Normalises a ruleset (desired or fetched) so the two can be diffed.
normalise_ruleset() {
  jq -S '{name, target, enforcement,
          bypass_actors: (.bypass_actors // [] | map({actor_type, bypass_mode} + (if .actor_type == "OrganizationAdmin" then {} else {actor_id} end))),
          conditions: {ref_name: .conditions.ref_name},
          rules: (.rules | map(
            if .type == "pull_request" then {type, parameters: (.parameters | {required_approving_review_count, dismiss_stale_reviews_on_push, require_code_owner_review, require_last_push_approval, required_review_thread_resolution, allowed_merge_methods: (.allowed_merge_methods | sort)})}
            elif .type == "required_status_checks" then {type, parameters: (.parameters | {strict_required_status_checks_policy, do_not_enforce_on_create: (.do_not_enforce_on_create // false), required_status_checks: (.required_status_checks | map({context} + (if .integration_id then {integration_id} else {} end)) | sort_by(.context))})}
            elif .type == "update" then {type, parameters: {update_allows_fetch_and_merge: (.parameters.update_allows_fetch_and_merge // false)}}
            else {type} end) | sort_by(.type))}'
}

section "d) Rulesets"
for repo in "${REPOS[@]}"; do
  info "[$repo]"
  existing="$(get_all "repos/$ORG/$repo/rulesets?includes_parents=true&per_page=100")"
  info "Existing rulesets (as they are now):"
  if [[ "$(jq length <<<"$existing")" -eq 0 ]]; then
    info "  none"
  fi
  while IFS= read -r id; do
    [[ -n "$id" ]] || continue
    fetch "repos/$ORG/$repo/rulesets/$id"
    detail="$BODY"
    jq '{id, name, source_type, enforcement, conditions, bypass_actors, rules}' <<<"$detail" | sed 's/^/      /'
    rs_name="$(jq -r .name <<<"$detail")"
    if [[ "$rs_name" != "test-integration" && "$rs_name" != "main-owner-only" && "$rs_name" != "main-checks" ]] && jq -e '.bypass_actors | length > 0' <<<"$detail" >/dev/null; then
      warn "ruleset '$rs_name' has bypass actors. Rulesets layer, so it cannot weaken the ones below, but it is not the standard; retire it deliberately."
    fi
  done < <(jq -r '.[].id' <<<"$existing")

  cfg="$WORK/cfg/$repo"
  test_ruleset "$(required_checks_json review "$cfg/required-checks.txt")" >"$WORK/rs-test-$repo.json"
  main_owner_ruleset >"$WORK/rs-main-owner-$repo.json"
  main_checks_ruleset "$(required_checks_json none "$cfg/required-checks.txt" "$cfg/required-checks.main.txt")" >"$WORK/rs-main-checks-$repo.json"
  if [[ -z "$REVIEWER_APP_ID" ]]; then
    warn "$repo test-integration: review/independent OMITTED (no Reviewer App id) — independent review is not enforced."
  fi

  for payload in "$WORK/rs-test-$repo.json" "$WORK/rs-main-owner-$repo.json" "$WORK/rs-main-checks-$repo.json"; do
    name="$(jq -r .name "$payload")"
    id="$(jq -r --arg n "$name" 'map(select(.name == $n and .source_type == "Repository")) | first | .id // empty' <<<"$existing")"
    if [[ -z "$id" ]]; then
      info "Ruleset $name: absent — will be created."
      mutate_json POST "repos/$ORG/$repo/rulesets" "$payload"
    else
      fetch "repos/$ORG/$repo/rulesets/$id"
      normalise_ruleset <<<"$BODY" >"$WORK/have.json"
      normalise_ruleset <"$payload" >"$WORK/want.json"
      if diff -q "$WORK/have.json" "$WORK/want.json" >/dev/null; then
        info "Ruleset $name: up to date."
      else
        info "Ruleset $name (id $id) differs:"
        diff -u "$WORK/have.json" "$WORK/want.json" | sed 's/^/      /' || true
        mutate_json PUT "repos/$ORG/$repo/rulesets/$id" "$payload"
      fi
    fi
  done
done

# --------------------------------------------------------- e) project ----
if [[ $WANT_PROJECT -eq 1 ]]; then
  section "e) Project \"$PROJECT_TITLE\""
  projects="$(gh project list --owner "$ORG" --limit 200 --format json)"
  number="$(jq -r --arg t "$PROJECT_TITLE" '[.projects[] | select(.title == $t and (.closed | not))] | first | .number // empty' <<<"$projects")"
  created=0
  if [[ -z "$number" ]]; then
    info "Project absent — will be created."
    if [[ $APPLY -eq 1 ]]; then
      PLANNED=$((PLANNED + 1))
      printf '   APPLY: gh project create --owner %s --title %q\n' "$ORG" "$PROJECT_TITLE"
      number="$(gh project create --owner "$ORG" --title "$PROJECT_TITLE" --format json | jq -r .number)"
      created=1
    else
      mutate gh project create --owner "$ORG" --title "$PROJECT_TITLE"
    fi
  else
    info "Project #$number exists: https://github.com/orgs/$ORG/projects/$number"
  fi

  # name|options (comma-separated, in order)|colours for Status options
  STATUS_OPTIONS="Backlog,Ready,In progress,In review,Done"
  FIELD_SPECS=("Priority|P0,P1,P2" "Size|S,M,L")

  if [[ -n "$number" ]]; then
    fields="$(gh project field-list "$number" --owner "$ORG" --limit 100 --format json)"
    field_opts() { jq -r --arg n "$1" '.fields[] | select(.name == $n) | [.options[]?.name] | join(",")' <<<"$fields"; }

    have_status="$(field_opts Status)"
    if [[ "$have_status" == "$STATUS_OPTIONS" ]]; then
      info "Status: $have_status"
    elif [[ $created -eq 1 ]]; then
      # A project created by this run has no items, so replacing the options clears nothing.
      status_id="$(jq -r '.fields[] | select(.name == "Status") | .id' <<<"$fields")"
      # shellcheck disable=SC2016  # GraphQL variables, not shell
      mutate gh api graphql -f query='mutation($f:ID!){updateProjectV2Field(input:{fieldId:$f,singleSelectOptions:[
        {name:"Backlog",color:GRAY,description:"Written, not yet meeting Ready"},
        {name:"Ready",color:BLUE,description:"Meets the Definition of Ready"},
        {name:"In progress",color:YELLOW,description:"Assigned; a branch exists"},
        {name:"In review",color:PURPLE,description:"Pull request open, not draft"},
        {name:"Done",color:GREEN,description:"Merged to test"}]}){projectV2Field{... on ProjectV2SingleSelectField{name}}}}' -f f="$status_id"
    else
      warn "Status options are '$have_status', the standard is '$STATUS_OPTIONS'. NOT changed: replacing single-select options clears the Status of every item holding a removed option. Map the items first, then change the options — an owner decision."
    fi

    for spec in "${FIELD_SPECS[@]}"; do
      fname="${spec%%|*}"
      fopts="${spec#*|}"
      have="$(field_opts "$fname")"
      if ! jq -e --arg n "$fname" 'any(.fields[]; .name == $n)' <<<"$fields" >/dev/null; then
        mutate gh project field-create "$number" --owner "$ORG" --name "$fname" --data-type SINGLE_SELECT --single-select-options "$fopts"
      elif [[ "$have" == "$fopts" ]]; then
        info "$fname: $have"
      else
        warn "$fname options are '$have', the standard is '$fopts'. NOT changed, for the same reason as Status."
      fi
    done

    extra_fields="$(jq -r '[.fields[].name | select(length > 0) | select(IN("Title","Assignees","Status","Labels","Linked pull requests","Milestone","Repository","Reviewers","Parent issue","Sub-issues progress","Created","Updated","Closed","Tracks","Tracked by","Type","Priority","Size") | not)] | join(", ")' <<<"$fields")"
    [[ -z "$extra_fields" ]] || info "Custom fields not in DELIVERY §11 (reported, not deleted): $extra_fields"

    # shellcheck disable=SC2016  # GraphQL variables, not shell
    linked="$(gh api graphql -f query='query($o:String!,$n:Int!){organization(login:$o){projectV2(number:$n){repositories(first:100){nodes{name}}}}}' -f o="$ORG" -F n="$number" --jq '[.data.organization.projectV2.repositories.nodes[].name]')"
    for repo in "${REPOS[@]}"; do
      if jq -e --arg r "$repo" 'index($r) != null' <<<"$linked" >/dev/null; then
        info "$repo: linked"
      else
        mutate gh project link "$number" --owner "$ORG" --repo "$ORG/$repo"
      fi
    done
  else
    info "Fields: Status ($STATUS_OPTIONS), Priority (P0,P1,P2), Size (S,M,L) would be set on the new project."
    for repo in "${REPOS[@]}"; do
      info "DRY-RUN would run: gh project link <new> --owner $ORG --repo $ORG/$repo"
    done
  fi
  info "Views (Frontier, By milestone, By Epic, In flight, Decisions) have no API; create them in the Project UI."
fi

section "Summary"
if [[ $APPLY -eq 1 ]]; then
  info "$PLANNED change(s) applied."
else
  info "$PLANNED change(s) planned. Nothing was written. Re-run with --apply to make them."
fi
