Closes #

<!--
One Task, one pull request. The line above must name the Task or Bug:
"Closes #n" in the same repository, "Closes owner/repo#n" across repositories,
or "Closes" followed by the full issue URL. The governance/issue-link check fails
without it. A hotfix/* pull request must close a Bug.
A pull request that is still gathering evidence, or has a known gap, is a draft.
-->

## What changed

-

## How verified

<!-- The exact commands run and their results. Numbers and names, not a story. -->

```text
$
```

## Tests added

<!-- File and test name, level (unit, integration, end-to-end, browser, widget, golden). -->

- [ ] Each new behaviour has at least one test that I saw failing before the change

-

## Regression surface run

<!-- The regression surface named in the Task, with the command and its result. -->

-

## Screenshots

<!-- User-visible change: the changed screen, light and dark where the product has both. Write "Not user-visible" otherwise. -->

## Risk surfaces touched

<!-- Tick every one that applies. Any tick means a second, adversarial review before merge. -->

- [ ] Security
- [ ] Tenancy / RLS
- [ ] Migration of live data
- [ ] Money
- [ ] Concurrency
- [ ] Offline sync
- [ ] Cross-repository contract
- [ ] Deployment
- [ ] None of the above

## Docs updated

<!-- The docs the Task names, updated in this pull request. Path, or "None named by the Task". -->

-
