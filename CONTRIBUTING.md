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
2. Branch from current `dev` as `<issue>-<slug>` (for example `742-supplier-list`). Hotfixes branch from `main` as `hotfix/<slug>`.
3. Commit with Conventional Commits: `feat(area): …`, `fix(area): …`, `test`, `docs`, `refactor`, `chore`.
4. Open the pull request into `dev` with `Closes #n` in the body. Draft until it is a merge candidate.
5. The Agent App merges when every required check and `review/independent` (posted by the Reviewer App) pass on the head commit. `dev` is the integration default.
6. `test` is acceptance, entered only by a promotion pull request from `dev` (or a hotfix), and `main` is production, entered only by a release from `test` or a `hotfix/*`. The `test-source-policy` and `main-source-policy` checks enforce those sources. The Agent App opens the promotion and release pull requests; every branch moves by merge commits only. A hotfix is merged back into `test` the same day by a pull request from `main`.

Never force-push or delete `dev`, `test` or `main`, rewrite a pushed shared branch, or `git stash` in a shared checkout.
