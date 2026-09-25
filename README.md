# Organisation GitHub defaults

The shared assets of the organisation's delivery standard
(`01 - Governance/DELIVERY.md` in the MarvinaMiranda knowledge repository, §14).
Repositories inherit the issue forms and pull request template when they do not
provide their own.

Nothing here describes a product. This repository is public, so product
structure — areas, required checks, hot shared files — lives in each product
repository under `.github/governance/` (DELIVERY §6).

| Asset | Path |
|---|---|
| Issue forms: Epic, Task, Bug, Decision, Spike | `.github/ISSUE_TEMPLATE/` |
| Pull request template | `.github/pull_request_template.md` |
| Reusable PR governance workflow (`governance/issue-link`, areas check) | `.github/workflows/pr-governance.yml` |
| Issue-link matcher and its tests | `governance/issue-link.js`, `governance/tests/issue-link.test.js` |
| Areas checker and its tests | `governance/areas-check.js`, `governance/tests/areas-check.test.js` |
| How to find and prefactor hot shared files | `governance/HOTSPOTS-GUIDE.md` |
| Bootstrap: issue types, default branch, labels, rulesets, Project | `governance/bootstrap.sh` |
| Agent identities: App manifests, creation, tokens, posting a review | `governance/identity/` |

The issue forms set native issue types. Epic, Decision and Spike must exist as
organisation issue types first — run the bootstrap before these forms reach
the default branch, or those three forms open issues with no type.

## What an adopted repository carries

```text
.github/governance/areas.txt                 areas, as label lines plus path globs
.github/governance/required-checks.txt       CI checks required on test and main
.github/governance/required-checks.main.txt  extra checks required on main only
.github/governance/HOTSPOTS.md               its hot shared files (see HOTSPOTS-GUIDE.md)
.github/workflows/pr-governance.yml          the caller below
```

`areas.txt`:

```text
<name>|<label description, at most 100 characters>
#   path: <glob>     one or more; the first glob in the file that matches a file owns it
```

Globs: `*` within a path segment, `**` across segments, `{a,b}` either.

`required-checks.txt`: one check-run name per line, exactly as GitHub shows it,
`#` for comments. List only checks that **always** report on a pull request —
a required check that never starts is a merge freeze. Where a workflow is
path-filtered, require its always-running aggregator instead (DELIVERY §10).

## PR governance

The caller:

```yaml
name: PR governance

on:
  pull_request:
    branches: [test, main]
    types: [opened, edited, reopened, synchronize, ready_for_review]

permissions:
  checks: write
  contents: read
  issues: read

jobs:
  governance:
    uses: marvinamiranda/.github/.github/workflows/pr-governance.yml@test
    with:
      runs-on: '["self-hosted", "pool-linux"]'
```

- `edited` is what re-runs the issue-link check when only the body changes.
- No `paths:` filter: both jobs must report on every pull request.
- `runs-on` is required and has no default, because a required check on a
  runner that never starts is a merge freeze.
- Where the repository has an aggregating PR gate that wakes on `workflow_run`,
  add `PR governance` to its `workflow_run.workflows`: that makes the gate fire
  on every pull request, and stops it judging before governance has finished
  with nothing left to wake it.

### `governance/issue-link`

Fails unless the pull request body closes an issue with a closing keyword
(`close`, `closes`, `closed`, `fix`, `fixes`, `fixed`, `resolve`, `resolves`,
`resolved`), optionally followed by a colon, then one of `#123`,
`owner/repo#123` or `https://github.com/owner/repo/issues/123`. Text inside
HTML comments, fenced code and inline code does not count.

- **Release pull requests** (`test` → `main`) are exempt and pass.
- **`hotfix/*` pull requests** must close at least one issue whose type is
  **Bug**, readable with the workflow's token — in practice, in the same
  repository.

The job itself appears as `governance / issue-link`. The **required** context
is the check run it publishes, named exactly `governance/issue-link` and
created by the GitHub Actions app; the rulesets pin it to that app.

### `governance / areas`

Runs `governance/areas-check.js` against the pull request's merge commit and
fails when a tracked file has no area, an area owns nothing, or a glob can never
win. Locally:

```bash
node governance/areas-check.js <product checkout> [git-ref]
```

## Identities (DELIVERY §9, Appendix A)

Two organisation GitHub Apps, created once by the owner:

```bash
python3 governance/identity/create-app.py mm-agent      # builds, opens and merges PRs into test
python3 governance/identity/create-app.py mm-reviewer   # posts review/independent
```

Keys go to `~/.config/mm-agent/<name>/` (0600) and are never printed.

```bash
export GH_TOKEN="$(governance/identity/app-token.sh mm-agent)"      # a builder's session
governance/identity/post-review.sh owner/repo <sha> success "Matches the Task; tests seen failing first."
```

`post-review.sh` creates the `review/independent` check run as the Reviewer
App. The `test-integration` ruleset pins that context to the Reviewer App's id,
so the builder identity cannot satisfy it.

## Bootstrap

```bash
governance/bootstrap.sh --repo omni237 --repo omni237-ops --project            # dry run: reads only
governance/bootstrap.sh --repo omni237 --repo omni237-ops --project --apply    # owner only
```

Reads each repository's `.github/governance/` from `test` (`--config-dir
<dir>/<repo>/` overrides it for local testing). Dry run by default; idempotent;
never deletes — labels, rulesets and Project fields outside the standard are
reported for the owner to retire. `--help` lists the options.

- **`test-integration`**: pull request (squash only, no approvals), the repo's
  required checks + `governance/issue-link`, all pinned to the Actions app, plus
  `review/independent` pinned to the Reviewer App (`--reviewer-app-id`, or
  `~/.config/mm-agent/mm-reviewer/app.json`). Without that id it is omitted, with
  a loud warning, rather than left forgeable or blocking. No force push, no
  deletion, no bypass.
- **`main-release`**: restrict updates, with the organisation-admin role as the
  only bypass in pull-request mode; pull request (merge commits only, no
  approvals); required checks from both lists + `governance/issue-link`; no
  force push, no deletion.

## Tests

```bash
node governance/tests/issue-link.test.js
node governance/tests/areas-check.test.js
shellcheck governance/bootstrap.sh governance/identity/*.sh
```
