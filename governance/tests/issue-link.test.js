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
const { evaluate, isBug, judge } = require(modulePath);

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

// judge: the published verdict, against a fake API client. `closing` is what
// GitHub links; `closingSeq` is what it links on each successive lookup.
function fakeGitHub({ body, head = '742-supplier-list', base = 'test', number = 761, defaultBranch = 'test',
  closing = [], closingSeq = null, issues = {} }) {
  const calls = [];
  let lookups = 0;
  return {
    calls,
    rest: {
      pulls: { get: async (a) => { calls.push(['pulls.get', a.pull_number]);
        return { data: { number, body, head: { ref: head, sha: 'a'.repeat(40) }, base: { ref: base } } }; } },
      repos: { get: async () => { calls.push(['repos.get']); return { data: { default_branch: defaultBranch } }; } },
      issues: { get: async (a) => { calls.push(['issues.get', a.owner, a.repo, a.issue_number]);
        const issue = issues[a.issue_number];
        if (!issue) { const e = new Error('Not Found'); e.status = 404; throw e; }
        return { data: issue }; } },
    },
    graphql: async (query, vars) => { calls.push(['graphql', vars.number]);
      const linked = closingSeq ? closingSeq[Math.min(lookups, closingSeq.length - 1)] : closing;
      lookups += 1;
      return { repository: { pullRequest: { closingIssuesReferences: {
        totalCount: linked.length,
        nodes: linked.map((n) => ({ number: n, repository: { nameWithOwner: 'marvinamiranda/omni237' } })) } } } }; },
  };
}
// judge waits before asking GitHub again; the test records the wait instead.
function fakeSleep(gh) {
  return async (ms) => { gh.calls.push(['sleep', ms]); };
}
const count = (gh, kind) => gh.calls.filter((c) => c[0] === kind).length;
const ctx = (number = 761) => ({ repo: { owner: 'marvinamiranda', repo: 'omni237' }, payload: { pull_request: { number, body: 'STALE' } } });

// [name, fake options, expected ok, extra assertion(verdict, gh) -> problem string or '']
const judgeCases = [
  ['default branch: GitHub confirms the link', { body: 'Closes #742', closing: [742] }, true,
    (v, gh) => (gh.calls.some((c) => c[0] === 'graphql') ? '' : 'did not ask GitHub')],
  ['default branch: regex matches but GitHub sees nothing (e.g. a PR number)', { body: 'Closes #740', closing: [] }, false, () => ''],
  ['the body is read at run time, not from the event payload', { body: 'Closes #742', closing: [742] }, true,
    (v, gh) => (gh.calls[0][0] === 'pulls.get' ? '' : 'payload body used')],
  ['a pull request cannot close itself', { body: 'Closes #761', closing: [] }, false,
    (v, gh) => (/itself/.test(v.title) && !gh.calls.some((c) => c[0] === 'graphql') ? '' : v.title)],
  ['own number alongside a real issue passes on the real one', { body: 'Closes #761\nCloses #742', closing: [742] }, true, () => ''],
  ['no link fails before any GraphQL', { body: 'nothing', closing: [742] }, false,
    (v, gh) => (gh.calls.some((c) => c[0] === 'graphql') ? 'asked GitHub needlessly' : '')],
  ['release test -> main is exempt', { body: '', head: 'test', base: 'main' }, true, () => ''],
  ['non-default base uses the regex (GitHub would not close anyway)', { body: 'Closes #5', base: 'main', head: 'x' }, true,
    (v, gh) => (gh.calls.some((c) => c[0] === 'graphql') ? 'asked GitHub on a non-default base' : '')],
  ['hotfix closes a Bug in this repo', { body: 'Fixes #901', head: 'hotfix/till', base: 'main', issues: { 901: { type: { name: 'Bug' } } } }, true, () => ''],
  ['hotfix: a Task is not a Bug', { body: 'Fixes #902', head: 'hotfix/till', base: 'main', issues: { 902: { type: { name: 'Task' } } } }, false, () => ''],
  ['hotfix: a pull request typed Bug is not an issue', { body: 'Fixes #903', head: 'hotfix/till', base: 'main', issues: { 903: { type: { name: 'Bug' }, pull_request: {} } } }, false, () => ''],
  ['hotfix: a Bug in another repository is never looked up', { body: 'Fixes marvinamiranda/sm360#9', head: 'hotfix/till', base: 'main' }, false,
    (v, gh) => (gh.calls.some((c) => c[0] === 'issues.get') ? 'looked outside the repository' : '')],

  // GitHub links closing issues when it parses the body, after the event that
  // started the run, so a first lookup can come back empty.
  ['GitHub links the issue at once: asked once, no wait', { body: 'Closes #742', closing: [742] }, true,
    (v, gh) => (count(gh, 'graphql') === 1 && count(gh, 'sleep') === 0 ? '' : `graphql ${count(gh, 'graphql')}, sleeps ${count(gh, 'sleep')}`)],
  ['GitHub links nothing at first, then the issue: passes on the one retry', { body: 'Closes #742', closingSeq: [[], [742]] }, true,
    (v, gh) => {
      const waits = gh.calls.filter((c) => c[0] === 'sleep').map((c) => c[1]);
      if (count(gh, 'graphql') !== 2) return `graphql ${count(gh, 'graphql')} times, expected 2`;
      if (waits.length !== 1 || waits[0] < 2000 || waits[0] > 10000) return `waits ${JSON.stringify(waits)}, expected one of a few seconds`;
      return /GitHub will close: marvinamiranda\/omni237#742/.test(v.summary) ? '' : v.summary;
    }],
  ['GitHub links nothing twice: fails after exactly one retry, and says how to make GitHub re-read the body', { body: 'Closes #742', closingSeq: [[], [], [742]] }, false,
    (v, gh) => {
      if (count(gh, 'graphql') !== 2) return `graphql ${count(gh, 'graphql')} times, expected 2`;
      if (!/default branch/i.test(v.summary) || !/(re-?save|save it again|edit the body)/i.test(v.summary)) return `summary lacks the re-save advice: ${v.summary}`;
      return '';
    }],
];

(async () => {
  for (const [name, opts, expectedOk, extra] of judgeCases) {
    const gh = fakeGitHub(opts);
    let problem = '';
    try {
      const v = await judge({ github: gh, context: ctx(opts.number), sleep: fakeSleep(gh) });
      if (v.ok !== expectedOk) problem = `ok ${v.ok}, expected ${expectedOk} (${v.title})`;
      else if (v.headSha !== 'a'.repeat(40)) problem = 'check not attached to the current head';
      else problem = extra(v, gh);
    } catch (e) {
      problem = `threw ${e.message}`;
    }
    if (problem) { failed += 1; console.log(`not ok - judge ${name}: ${problem}`); } else console.log(`ok - judge ${name}`);
  }
  const total = cases.length + bugCases.length + judgeCases.length;
  console.log(`\n${total - failed}/${total} passed`);
  process.exit(failed ? 1 : 0);
})();
