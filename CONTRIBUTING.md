# Contributing

## Choose the correct work item

Create work through the guided issue forms. Blank issues are disabled.

- Initiative: large measurable outcome.
- Feature: coherent product capability.
- Story: smallest independently demonstrable value slice.
- Technical task: independently verifiable enabler owned by a story.
- Bug: observed deviation from approved behaviour.
- Hotfix: urgent production P0/P1 only.
- Data correction: controlled repair of existing data.
- Release acceptance: release-level evidence and sign-off.

## Normal delivery path

1. Begin only with an approved, Ready issue.
2. Branch from current `test` using `feature|fix|chore|refactor|docs/<issue>-<slug>`.
3. Run repository-required local checks and exercise affected behaviour.
4. Open a pull request to `test`; link the issue and provide evidence.
5. Resolve CI and review findings. Only a human approves or merges.
6. After merge, deploy the changed immutable artifact to the test environment.
7. Independently validate the running product and reconcile documentation/evidence.
8. Production release uses a human-approved `test` to `main` pull request.

Only `hotfix/<issue>-<slug>` may target `main` directly, and it must be reconciled back into `test` immediately.
