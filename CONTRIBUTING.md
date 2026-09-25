# Contributing

The rules are the organisation's delivery standard
(`01 - Governance/DELIVERY.md` in the MarvinaMiranda knowledge repository).
This page is the short form.

## Choose the issue type

Blank issues are disabled; every issue starts from a form.

- **Epic** — one capability a user recognises; 3–12 Tasks as sub-issues.
- **Task** — exactly one pull request, at most ~400 changed lines.
- **Bug** — behaviour that contradicts the docs or the tests; fixed with a test that failed first.
- **Decision** — a question only the owner may answer, titled `DECISION: <the question>`.
- **Spike** — at most a day's investigation, ending in a written finding in the docs.

Milestones are GitHub milestones, not issues.

## Delivery path

1. Start only a **Ready** Task with no open *blocked by*, whose `area:` has no other Task In progress.
2. Branch from current `test` as `<issue>-<slug>` (for example `742-supplier-list`). Hotfixes branch from `main` as `hotfix/<slug>`.
3. Commit with Conventional Commits: `feat(area): …`, `fix(area): …`, `test`, `docs`, `refactor`, `chore`.
4. Open the pull request into `test` with `Closes #n` in the body. Draft until it is a merge candidate.
5. The Agent App squash-merges when every required check and `review/independent` (posted by the Reviewer App) pass on the head commit.
6. `main` changes only by a pull request from `test` or `hotfix/*`, merged by the owner with a merge commit. The Agent App opens release pull requests. A hotfix is merged back into `test` the same day.

Never force-push or delete `test` or `main`, rewrite a pushed shared branch, or `git stash` in a shared checkout.
