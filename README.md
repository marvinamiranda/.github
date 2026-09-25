# Organisation GitHub defaults

The shared assets of the organisation's delivery standard
(`01 - Governance/DELIVERY.md` in the MarvinaMiranda knowledge repository, §14).
The issue forms and pull request template are the organisation default: they
apply to every repository that does not provide its own, immediately. Rulesets,
`AGENTS.md` and areas are adopted per repository, at that repository's reset.

This repository is public, so product structure (areas, required checks, hot
shared files) lives in each product repository under `.github/governance/`
(DELIVERY §6). Product names appear here only as examples.

**Every change here is `tier:senior` and needs an adversarial review**, and so
does any change to `.github/**` in an adopted repository, or to any script a job
with `checks: write` or a `workflow_run` trigger executes. The code in this
repository decides every other repository's required checks, and the Agent App
holds `workflows: write`.

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
  pull-requests: read

concurrency:
  group: pr-governance-${{ github.event.pull_request.number }}
  cancel-in-progress: true

jobs:
  governance:
    # A full commit SHA of this repository, never a branch: the code that
    # judges a pull request must be a reviewed commit.
    uses: marvinamiranda/.github/.github/workflows/pr-governance.yml@<40-char sha>
    with:
      runs-on: '["self-hosted", "pool-linux"]'   # runners are self-hosted
      governance-ref: <the same sha>
```

- **Pin by SHA, twice.** `uses:` and `governance-ref` name the same merged
  commit of this repository. A branch ref would let whoever can push to that
  branch change every repository's checks. Moving the pin is a `tier:senior`
  pull request in the adopting repository.
- `concurrency` cancels a superseded run, so an edit followed by a push cannot
  finish out of order and leave the older verdict on the head.
- `edited` is what re-runs the issue-link check when only the body changes.
- No `paths:` filter: both jobs must report on every pull request.
- `runs-on` is required and has no default, because a required check on a
  runner that never starts is a merge freeze.
- Where the repository has an aggregating PR gate that wakes on `workflow_run`,
  add `PR governance` to its `workflow_run.workflows`: that makes the gate fire
  on every pull request, and stops it judging before governance has finished
  with nothing left to wake it.

### `governance/issue-link`

The check reads the pull request at run time (not from the event payload). It
fails unless the pull request body closes an issue with a closing keyword
(`close`, `closes`, `closed`, `fix`, `fixes`, `fixed`, `resolve`, `resolves`,
`resolved`), optionally followed by a colon, then one of `#123`,
`owner/repo#123` or `https://github.com/owner/repo/issues/123`. Text inside
HTML comments, fenced code and inline code does not count. That regex is the
fast, offline layer. For a pull request into the **default branch** the
authority is GitHub's own parsing (GraphQL `closingIssuesReferences`), the same
parser that closes the issue on merge: if GitHub links no issue, the check
fails. A pull request referencing only itself fails.

- **Release pull requests** (`test` → `main`) are exempt and pass.
- **`hotfix/*` pull requests** must close at least one issue **in the same
  repository** whose type is **Bug**, and not a pull request.

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
eval "$(governance/identity/agent-env.sh mm-agent)"     # a builder's shell
eval "$(governance/identity/agent-env.sh mm-reviewer)"  # a reviewer's shell
governance/identity/post-review.sh owner/repo <sha> success "Matches the Task; tests seen failing first."
```

`agent-env.sh` points `GH_CONFIG_DIR` at an empty directory, so `gh` can never
fall back to the owner's login. It re-mints the one-hour token for every `gh`
and `git` call, and sets the App's bot as git author and committer.

`post-review.sh` creates the `review/independent` check run as the Reviewer
App, and the `test-integration` ruleset pins that context to the Reviewer App's
id. What that enforces: the check was posted by the Reviewer identity. On one
machine, keeping builder and reviewer sessions apart is procedural: both keys
sit under the same user. The known follow-up is to post reviews from a workflow
in a locked repository that holds the reviewer key as a secret.

## Bootstrap

Run it **from a reviewed commit**: check this repository out by the SHA of a
merged commit, never from a branch tip (not even `test`). `--apply` refuses to
run from a checkout with uncommitted changes, and prints the commit it runs
from.

```bash
git checkout <merged sha>
governance/bootstrap.sh --repo <repo> ...                                  # dry run: reads only
governance/bootstrap.sh --repo <repo> ... --no-rulesets --apply            # stage an adoption
governance/bootstrap.sh --repo <repo> ... --probe --apply                  # owner only: rulesets
governance/bootstrap.sh --repo <repo> ... --project --project-title "<t>"  # also the Project
```

Before the first `--apply` with rulesets: `--probe` has the Reviewer App post a
neutral `review/independent` on each `test` head, and one Agent App
squash-merge into `test` must be proven on a throwaway pull request. The
rulesets allow no other way in.

Reads each repository's `.github/governance/` from `test` (`--config-dir
<dir>/<repo>/` overrides it for local testing). Dry run by default; idempotent;
never deletes. Labels and Project fields outside the standard are reported for
the owner to retire; legacy rulesets on `test` or `main` are set to enforcement
`disabled`, never deleted. `--help` lists the options. Payloads are kept, and
their path printed, when a run fails.

The rulesets go on each `--repo` **and on this repository**: its `test` and
`main` hold the code every other repository's checks run, so they need a pull
request, `governance tests`, and (on `test`) `review/independent`, with no
bypass.

- **`test-integration`**: pull request (squash only, no approvals), the repo's
  required checks + `governance/issue-link`, all pinned to the Actions app, plus
  `review/independent` pinned to the Reviewer App (`--reviewer-app-id`, or
  `~/.config/mm-agent/mm-reviewer/app.json`). Without that id it is omitted, with
  a loud warning, rather than left forgeable or blocking. No force push, no
  deletion, no bypass. `require_extra_approval_for_unattributed_changes` is set
  to `false` explicitly, and compared.
- **`main-owner-only`**: restrict updates, with one user (the owner's account,
  by id) as the only bypass, in pull-request mode, and nothing else, because a
  bypass actor bypasses every rule of its ruleset. A user, not the
  organisation-admin role, which would extend to every admin.
- **`main-checks`**: pull request (merge commits only, no approvals); required
  checks from both lists + `governance/issue-link`; no force push, no
  deletion; no bypass, so the owner's merges pass the checks too.

## Tests

```bash
node governance/tests/issue-link.test.js
node governance/tests/areas-check.test.js
shellcheck governance/bootstrap.sh governance/identity/*.sh
/bin/bash -n governance/bootstrap.sh    # macOS bash 3.2
```
