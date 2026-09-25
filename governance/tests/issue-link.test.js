#!/usr/bin/env node
'use strict';

// Feeds sample pull request bodies to governance/issue-link.js — the same
// module the `governance/issue-link` check requires — and asserts the verdict.
//
//   node governance/tests/issue-link.test.js
//
// ISSUE_LINK_MODULE points it at another copy of the module, which is how a
// deliberately broken copy is shown to turn this suite red.

const path = require('path');
const fs = require('fs');

const modulePath = process.env.ISSUE_LINK_MODULE
  ? path.resolve(process.env.ISSUE_LINK_MODULE)
  : path.join(__dirname, '..', 'issue-link.js');
const { evaluate, isBug } = require(modulePath);

const REPO = 'marvinamiranda/omni237';
const template = fs.readFileSync(path.join(__dirname, '..', '..', '.github', 'pull_request_template.md'), 'utf8');

// [name, { body, head, base }, expected status, expected refs (keys), requireBug?]
const cases = [
  // Accepted forms
  ['same-repo Closes', { body: 'Closes #742' }, 'pass', ['marvinamiranda/omni237#742']],
  ['lower-case fixes', { body: 'fixes #1' }, 'pass', ['marvinamiranda/omni237#1']],
  ['every keyword', {
    body: 'close #1\nclosed #2\nfix #3\nfixed #4\nresolve #5\nresolves #6\nresolved #7\nCLOSES #8',
  }, 'pass', [1, 2, 3, 4, 5, 6, 7, 8].map((n) => `marvinamiranda/omni237#${n}`)],
  ['colon after keyword', { body: 'Resolves: #55' }, 'pass', ['marvinamiranda/omni237#55']],
  ['cross-repo short form', { body: 'Closes marvinamiranda/sm360-sdk#12' }, 'pass', ['marvinamiranda/sm360-sdk#12']],
  ['full issue URL', { body: 'Fixes https://github.com/marvinamiranda/omni237-ops/issues/160' }, 'pass', ['marvinamiranda/omni237-ops#160']],
  ['keyword mid-sentence', { body: 'This change closes #9 and nothing else.' }, 'pass', ['marvinamiranda/omni237#9']],
  ['duplicates collapse', { body: 'Closes #3\nCloses #3' }, 'pass', ['marvinamiranda/omni237#3']],
  ['filled-in template', { body: template.replace('Closes #\n', 'Closes #742\n') }, 'pass', ['marvinamiranda/omni237#742']],
  ['CRLF body', { body: 'Intro\r\nCloses #77\r\n' }, 'pass', ['marvinamiranda/omni237#77']],
  ['text after a closed fence counts', { body: '```\ncode\n```\nCloses #5' }, 'pass', ['marvinamiranda/omni237#5']],

  // Rejected forms
  ['empty body', { body: '' }, 'fail', []],
  ['null body', { body: null }, 'fail', []],
  ['untouched template', { body: template }, 'fail', []],
  ['bare reference, no keyword', { body: 'Implements #742' }, 'fail', []],
  ['non-closing keyword', { body: 'Refs #742\nSee #743\nPart of #744' }, 'fail', []],
  ['keyword glued to a word', { body: 'prefixes #12\nunfixed #13' }, 'fail', []],
  ['number glued to letters', { body: 'Closes #12abc' }, 'fail', []],
  ['no whitespace after keyword', { body: 'Closes#12' }, 'fail', []],
  ['pull request URL is not an issue', { body: 'Closes https://github.com/marvinamiranda/omni237/pull/757' }, 'fail', []],
  ['non-GitHub URL', { body: 'Closes https://example.com/marvinamiranda/omni237/issues/3' }, 'fail', []],
  ['inside an HTML comment', { body: '<!-- Closes #742 -->' }, 'fail', []],
  ['inside an unterminated comment', { body: '<!-- draft\nCloses #742' }, 'fail', []],
  ['inside a fenced block', { body: '```text\nCloses #742\n```' }, 'fail', []],
  ['inside a tilde fence', { body: '~~~\nFixes #742\n~~~' }, 'fail', []],
  ['inside inline code', { body: 'Write `Closes #742` in the body' }, 'fail', []],
  ['issue zero', { body: 'Closes #0' }, 'fail', []],

  // Branch rules
  ['release PR test → main is exempt', { body: '', head: 'test', base: 'main' }, 'exempt', []],
  ['test → other base is not exempt', { body: '', head: 'test', base: 'uat' }, 'fail', []],
  ['feature → main is not exempt', { body: '', head: '742-supplier-list', base: 'main' }, 'fail', []],
  ['hotfix without a link fails', { body: 'urgent', head: 'hotfix/till-crash', base: 'main' }, 'fail', [], true],
  ['hotfix with a link must confirm a Bug', { body: 'Fixes #901', head: 'hotfix/till-crash', base: 'main' }, 'pass', ['marvinamiranda/omni237#901'], true],
  ['ordinary branch needs no Bug', { body: 'Closes #1', head: '1-thing', base: 'test' }, 'pass', ['marvinamiranda/omni237#1'], false],
];

let failed = 0;
for (const [name, input, expectedStatus, expectedRefs, expectedRequireBug] of cases) {
  const verdict = evaluate({
    body: input.body,
    headRef: input.head || '742-supplier-list',
    baseRef: input.base || 'test',
    repository: REPO,
  });
  const refs = verdict.refs.map((r) => r.key);
  const problems = [];
  if (verdict.status !== expectedStatus) problems.push(`status ${verdict.status}, expected ${expectedStatus}`);
  if (JSON.stringify(refs) !== JSON.stringify(expectedRefs)) problems.push(`refs ${JSON.stringify(refs)}, expected ${JSON.stringify(expectedRefs)}`);
  if (expectedRequireBug !== undefined && verdict.requireBug !== expectedRequireBug) problems.push(`requireBug ${verdict.requireBug}, expected ${expectedRequireBug}`);
  if (expectedStatus === 'fail' && !/Closes #123/.test(verdict.message)) problems.push('failure message does not show the fix');
  if (problems.length) {
    failed += 1;
    console.log(`not ok - ${name}: ${problems.join('; ')}`);
  } else {
    console.log(`ok - ${name}`);
  }
}

// isBug: the hotfix check's second half, on issue objects as the REST API returns them.
const bugCases = [
  ['typed Bug', { type: { name: 'Bug' } }, true],
  ['typed Task', { type: { name: 'Task' } }, false],
  ['untyped issue', { type: null }, false],
  ['a pull request is never a Bug', { type: { name: 'Bug' }, pull_request: {} }, false],
  ['nothing', undefined, false],
];
for (const [name, issue, expected] of bugCases) {
  const actual = isBug(issue);
  if (actual !== expected) {
    failed += 1;
    console.log(`not ok - isBug ${name}: ${actual}, expected ${expected}`);
  } else {
    console.log(`ok - isBug ${name}`);
  }
}

const total = cases.length + bugCases.length;
console.log(`\n${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
