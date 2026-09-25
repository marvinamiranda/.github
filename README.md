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
| Agent identities: App manifests, creation, tokens, the agent shell's `gh` shim, posting a review | `governance/identity/` |
| Tests of the workflow's pin check, the bootstrap and the identity scripts | `governance/tests/` |

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
- **The workflow checks the pin** before it fetches any governance code.
  `governance-ref` must equal `job.workflow_sha`, the commit the caller's
  `uses:` pinned (`github.workflow_sha` would be the caller's own commit), and
  that commit must be on this repository's `test` (GitHub's compare of
  `test...<sha>` says `identical` or `behind`). Otherwise `governance/issue-link`
  fails, and so does `governance / areas`. So a pin to an unmerged pull request
  commit, to a fork's commit, or to two different commits never judges
  anything. The check is inline in the workflow, because code fetched at
  `governance-ref` cannot vouch for `governance-ref`.
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
fails. GitHub parses the body after the event that starts the run, so an empty
first answer is asked again once, 5 seconds later. A pull request opened
before `test` became the default branch keeps the links GitHub parsed then:
edit its body and save it, and GitHub reads it again. A pull request
referencing only itself fails.

- **Release pull requests** (`test` → `main`) are exempt and pass.
- **`hotfix/*` pull requests** must close at least one issue **in the same
  repository** whose type is **Bug**, and not a pull request.

The job itself appears as `governance / issue-link`. The **required** context
is the check run it publishes, named exactly `governance/issue-link` and
created by the GitHub Actions app; the rulesets pin it to that app. That check
run carries the verdict, and the job does not fail on it, so a failed job left
by an older run cannot keep a pull request red after a later run passes.

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

`agent-env.sh` is a strong default, not a sandbox: agents run on the owner's
machine as the owner's user, and the owner's keyring login stays one absolute
path away (`/opt/homebrew/bin/gh auth token`). What it does:

- puts the identity's `gh` shim first on `PATH` (`gh-shim.sh`, through a
  launcher in `~/.config/mm-agent/<name>/bin/`), so every child process uses it
  too: scripts, `bash -c`, an agent CLI's tool shells;
- gives every `gh` call a token from `app-token.sh`, and fails without running
  `gh` when none can be minted;
- refuses `gh auth` except a plain `gh auth status`. `gh auth token --user
  <owner>` reads the owner's keyring login whatever `GH_TOKEN` holds, and a
  raw token copied into a variable is never renewed;
- unsets `GH_TOKEN`, `GITHUB_TOKEN` and `GH_PACKAGES_TOKEN`, and prints no
  token;
- points `GH_CONFIG_DIR` at an empty directory, so the real `gh` finds no
  stored login;
- gives git a github.com credential helper that mints a token per operation,
  and tells git to quit rather than fall back when it cannot;
- sets the App's bot as git author and committer.

If `agent-env.sh` itself fails, it prints an environment with no identity
(tokens unset, `gh` and git refusing, no commit identity, a failing status)
instead of nothing, which would leave the shell on the owner's login. An agent
CLI that starts a fresh shell for each tool call (Claude Code does) needs the
`eval` in every call, or must be started from a shell that ran it.

`app-token.sh` reuses a token for at most 5 minutes after minting it, so a
revoked or suspended installation's token is served for at most 5 minutes,
then the mint fails with GitHub's reason. Checking the cached token on every
use would add a round trip to every `gh` and `git` call (0.49 s from the
owner's machine), and GitHub does not document that a cheap endpoint reflects
a suspension.

`post-review.sh` creates the `review/independent` check run as the Reviewer
App, and the `test-integration` ruleset pins that context to the Reviewer App's
id. What that enforces: the check was posted by the Reviewer identity. On one
machine, keeping builder and reviewer sessions apart is procedural: both keys
sit under the same user. The known follow-up is to post reviews from a workflow
in a locked repository that holds the reviewer key as a secret.

## Bootstrap

Run it **from a merged commit**: check this repository out by the SHA of a
commit on its `test`. `--apply` refuses anything else. It refuses a commit
that is not on `test` as GitHub has it now, read from
`https://github.com/marvinamiranda/.github.git` and never from `origin`. It
also refuses a checkout with uncommitted changes, and files outside a git
checkout. It prints the commit it runs from. A dry run from anywhere else
warns and carries on.

In this order:

```bash
git checkout <merged sha>
governance/bootstrap.sh --repo <repo> ...                                  # 1. dry run: reads only
governance/bootstrap.sh --repo <repo> ... --no-rulesets --apply            # 2. stage an adoption
governance/bootstrap.sh --repo <repo> ... --probe --no-rulesets --apply    # 3. the Reviewer App probe
# 4. one Agent App squash-merge into test (proven: see below)
governance/bootstrap.sh --repo <repo> ... --apply                          # 5. rulesets, owner only
governance/bootstrap.sh --repo <repo> ... --project --project-title "<t>"  # also the Project
```

- **Step 3**, `--probe`, has the Reviewer App post a neutral
  `review/independent` on each `test` head, so a missing installation shows up
  now rather than on the first blocked pull request. Pass `--no-rulesets` with
  it: without it, the same run goes on to apply the rulesets, before step 4.
- **Step 4**: after step 5 a pull request that passes its checks is the only
  way into `test`, and agents' pull requests are merged by the Agent App, so
  its squash-merge must work first. It is proven:
  [omni237-ops#160](https://github.com/marvinamiranda/omni237-ops/pull/160) was
  squash-merged into `test` by `app/marvinamiranda-agent` (commit `2be0641`,
  2026-09-25 17:52 UTC).
- **Step 5** needs the Reviewer App's id (`--reviewer-app-id`, or
  `~/.config/mm-agent/mm-reviewer/app.json`). Without it the run stops before
  changing anything. This repository's own `test-integration` would otherwise
  require only `governance tests`, which a pull request here can rewrite.

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

- **`test-integration`**: pull request, no approvals. The repo's required
  checks + `governance/issue-link`, all pinned to the Actions app, plus
  `review/independent` pinned to the Reviewer App. Merge methods: squash, which
  is how every Task lands, and merge commit, which exists only to bring `main`
  back into `test` after a hotfix (a pull request from `main`), so the two
  branches keep one history. A ruleset cannot tie a merge method to a head
  branch, so using merge commits only for that is procedural. No force push,
  no deletion, no bypass. `require_extra_approval_for_unattributed_changes` is
  set to `false` explicitly, and compared. Merge methods compare as a set, and
  a rule without any counts as GitHub's default, all three.
- **`main-owner-only`**: restrict updates, with one user (the owner's account,
  by id) as the only bypass, in pull-request mode, and nothing else, because a
  bypass actor bypasses every rule of its ruleset. A user, not the
  organisation-admin role, which would extend to every admin.
- **`main-checks`**: pull request (merge commits only, no approvals); required
  checks from both lists + `governance/issue-link`; no force push, no
  deletion; no bypass, so the owner's merges pass the checks too.

## Tests

```bash
for t in governance/tests/*.test.js; do node "$t" || echo "FAILED: $t"; done   # one file per node
BOOTSTRAP_BASH=/bin/bash node governance/tests/bootstrap.test.js              # macOS bash 3.2
IDENTITY_BASH=/bin/bash node governance/tests/identity.test.js
shellcheck governance/bootstrap.sh governance/identity/*.sh
actionlint                                                                    # reads .github/actionlint.yaml
```

`node governance/tests/*.test.js` runs only the first file: node takes the
rest as its arguments. The bootstrap and identity tests run the scripts
against stubs of `gh` and `curl`, so they need no network and touch no login.
