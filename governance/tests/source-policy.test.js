#!/usr/bin/env node
'use strict';

// governance/source-policy.js: which source branch may open a pull request into
// a protected branch of the dev -> test -> main model (DELIVERY §9.1).
//
//   node governance/tests/source-policy.test.js
//
// SOURCE_POLICY_MODULE points it at another copy of the module, which is how a
// deliberately broken copy is shown to turn this suite red.

const { spawnSync } = require('child_process');
const path = require('path');
const modulePath = process.env.SOURCE_POLICY_MODULE
  ? path.resolve(process.env.SOURCE_POLICY_MODULE)
  : path.join(__dirname, '..', 'source-policy.js');
const { evaluate } = require(modulePath);

let failed = 0;
let total = 0;
function ok(name, condition, detail = '') {
  total += 1;
  if (condition) console.log(`ok - ${name}`);
  else { failed += 1; console.log(`not ok - ${name}${detail ? `: ${detail}` : ''}`); }
}

const PR = 'pull_request';
// The repository every case runs in unless it overrides an identity; the
// adversarial cases below pass a fork, a deleted repository or a mismatch.
const REPO = 'marvinamiranda/omni237';

// [name, input, expected ok, expected check name]
const cases = [
  // dev is the integration default: any feature branch may enter it.
  ['dev accepts a Task branch', { baseRef: 'dev', headRef: '742-supplier-list', eventName: PR }, true, 'dev-source-policy'],
  ['dev accepts a nested feature branch', { baseRef: 'dev', headRef: 'feature/a/b', eventName: PR }, true, 'dev-source-policy'],
  ['dev accepts hotfix (all sources)', { baseRef: 'dev', headRef: 'hotfix/till-crash', eventName: PR }, true, 'dev-source-policy'],

  // test only takes a promotion, a hotfix, or the hotfix back-merge.
  ['test accepts the promotion from dev', { baseRef: 'test', headRef: 'dev', eventName: PR }, true, 'test-source-policy'],
  ['test accepts the back-merge from main', { baseRef: 'test', headRef: 'main', eventName: PR }, true, 'test-source-policy'],
  ['test accepts a hotfix branch', { baseRef: 'test', headRef: 'hotfix/till-crash', eventName: PR }, true, 'test-source-policy'],
  ['test accepts a nested hotfix name', { baseRef: 'test', headRef: 'hotfix/till/crash', eventName: PR }, true, 'test-source-policy'],
  ['test accepts a fully-qualified refs/heads/dev', { baseRef: 'refs/heads/test', headRef: 'refs/heads/dev', eventName: PR }, true, 'test-source-policy'],

  // main only takes a release from test or a hotfix.
  ['main accepts the release from test', { baseRef: 'main', headRef: 'test', eventName: PR }, true, 'main-source-policy'],
  ['main accepts a hotfix branch', { baseRef: 'main', headRef: 'hotfix/till-crash', eventName: PR }, true, 'main-source-policy'],

  // Wrong head: fail closed.
  ['test rejects a feature branch', { baseRef: 'test', headRef: '742-supplier-list', eventName: PR }, false, 'test-source-policy'],
  ['test rejects a second dev branch (exact name only)', { baseRef: 'test', headRef: 'dev2', eventName: PR }, false, 'test-source-policy'],
  ['test rejects a sub-branch of dev', { baseRef: 'test', headRef: 'dev/thing', eventName: PR }, false, 'test-source-policy'],
  ['test rejects Dev (refs are case-sensitive)', { baseRef: 'test', headRef: 'Dev', eventName: PR }, false, 'test-source-policy'],
  ['test rejects a bare hotfix/ with no name', { baseRef: 'test', headRef: 'hotfix/', eventName: PR }, false, 'test-source-policy'],
  ['test rejects hotfix without the slash', { baseRef: 'test', headRef: 'hotfix', eventName: PR }, false, 'test-source-policy'],
  ['test rejects a refs/heads/feature branch', { baseRef: 'test', headRef: 'refs/heads/742-supplier-list', eventName: PR }, false, 'test-source-policy'],
  ['main rejects dev', { baseRef: 'main', headRef: 'dev', eventName: PR }, false, 'main-source-policy'],
  ['main rejects a feature branch', { baseRef: 'main', headRef: '742-supplier-list', eventName: PR }, false, 'main-source-policy'],
  ['main rejects test2 (exact name only)', { baseRef: 'main', headRef: 'test2', eventName: PR }, false, 'main-source-policy'],
  ['main rejects a bare hotfix/', { baseRef: 'main', headRef: 'hotfix/', eventName: PR }, false, 'main-source-policy'],

  // A fork can name a branch dev, main or hotfix/*. Into test or main the base
  // and head repositories must be this same repository, as GitHub reports
  // them; a fork, a deleted repository or a mismatch fails closed.
  ['test rejects a fork whose head branch is dev', { baseRef: 'test', headRef: 'dev', eventName: PR, baseRepo: 'evil/.github', headRepo: 'evil/.github' }, false, 'test-source-policy'],
  ['test rejects a fork whose head is main (the back-merge)', { baseRef: 'test', headRef: 'main', eventName: PR, headRepo: 'evil/.github' }, false, 'test-source-policy'],
  ['test rejects a fork whose head is a hotfix branch', { baseRef: 'test', headRef: 'hotfix/till-crash', eventName: PR, headRepo: 'evil/.github' }, false, 'test-source-policy'],
  ['main rejects a fork whose head is test (the release)', { baseRef: 'main', headRef: 'test', eventName: PR, baseRepo: 'evil/.github', headRepo: 'evil/.github' }, false, 'main-source-policy'],
  ['test rejects a head repository that is missing (a deleted fork)', { baseRef: 'test', headRef: 'dev', eventName: PR, headRepo: null }, false, 'test-source-policy'],
  ['main rejects a base repository that is missing', { baseRef: 'main', headRef: 'test', eventName: PR, baseRepo: null }, false, 'main-source-policy'],
  ['test rejects a mismatched base repository', { baseRef: 'test', headRef: 'dev', eventName: PR, baseRepo: 'other/repo' }, false, 'test-source-policy'],
  ['main rejects a mismatched head repository', { baseRef: 'main', headRef: 'test', eventName: PR, headRepo: 'other/repo' }, false, 'main-source-policy'],
  ['test rejects an unknown canonical repository', { baseRef: 'test', headRef: 'dev', eventName: PR, repository: '' }, false, 'test-source-policy'],
  // dev is the integration default and still takes any source, fork included.
  ['dev still accepts a fork branch (the integration path)', { baseRef: 'dev', headRef: 'feature/x', eventName: PR, headRepo: 'evil/.github' }, true, 'dev-source-policy'],

  // Wrong base and missing refs: fail closed.
  ['an unknown base fails closed', { baseRef: 'feature', headRef: 'dev', eventName: PR }, false, 'source-policy'],
  ['an empty base fails closed', { baseRef: '', headRef: 'dev', eventName: PR }, false, 'source-policy'],
  ['a missing base fails closed', { headRef: 'dev', eventName: PR }, false, 'source-policy'],
  ['an empty head into test fails closed', { baseRef: 'test', headRef: '', eventName: PR }, false, 'test-source-policy'],
  ['a missing head into main fails closed', { baseRef: 'main', eventName: PR }, false, 'main-source-policy'],
  ['an empty head into dev fails closed', { baseRef: 'dev', headRef: '', eventName: PR }, false, 'dev-source-policy'],

  // Wrong event: fail closed.
  ['a push event fails closed', { baseRef: 'test', headRef: 'dev', eventName: 'push' }, false, 'test-source-policy'],
  ['a workflow_run event fails closed', { baseRef: 'main', headRef: 'test', eventName: 'workflow_run' }, false, 'main-source-policy'],
  ['a missing event fails closed', { baseRef: 'test', headRef: 'dev' }, false, 'test-source-policy'],
  ['a case-wrong event fails closed', { baseRef: 'test', headRef: 'dev', eventName: 'Pull_Request' }, false, 'test-source-policy'],

  // pull_request_target is the other pull-request event.
  ['pull_request_target into main is allowed', { baseRef: 'main', headRef: 'hotfix/x', eventName: 'pull_request_target' }, true, 'main-source-policy'],
  ['pull_request_target with a wrong head still fails', { baseRef: 'main', headRef: 'dev', eventName: 'pull_request_target' }, false, 'main-source-policy'],
];

for (const [name, input, expectedOk, expectedName] of cases) {
  // Every case is this repository's pull request unless it says otherwise; the
  // default identities are what the workflow would pass for a same-repo branch.
  const verdict = evaluate({
    ...input,
    repository: 'repository' in input ? input.repository : REPO,
    baseRepo: 'baseRepo' in input ? input.baseRepo : REPO,
    headRepo: 'headRepo' in input ? input.headRepo : REPO,
  });
  const problems = [];
  if (verdict.ok !== expectedOk) problems.push(`ok ${verdict.ok}, expected ${expectedOk}`);
  if (verdict.name !== expectedName) problems.push(`name ${JSON.stringify(verdict.name)}, expected ${expectedName}`);
  if (typeof verdict.message !== 'string' || !verdict.message) problems.push('no message');
  if (problems.length) console.log(`not ok - ${name}: ${problems.join('; ')}`);
  else console.log(`ok - ${name}`);
  total += 1;
  if (problems.length) failed += 1;
}

// The two required context names bootstrap pins, and nothing else for them.
{
  const names = new Set(cases.filter(([, , okv]) => okv).map(([n, i, , name]) => name));
  ok('the required context names are exactly test-source-policy and main-source-policy',
    names.has('test-source-policy') && names.has('main-source-policy'), [...names].join(', '));
}

// A failure message must name the offending base or head, so a blocked author
// can act without reading the workflow.
{
  const wrongHead = evaluate({ baseRef: 'test', headRef: '742-supplier-list', eventName: PR });
  const wrongBase = evaluate({ baseRef: 'feature', headRef: 'dev', eventName: PR });
  ok('a wrong head names the branch and the allowed sources',
    /742-supplier-list/.test(wrongHead.message) && /dev/.test(wrongHead.message) && /hotfix/.test(wrongHead.message) && /main/.test(wrongHead.message),
    wrongHead.message);
  ok('a wrong base names the base and the branches a pull request may target',
    /feature/.test(wrongBase.message) && /dev/.test(wrongBase.message), wrongBase.message);
}

// An identity failure must name the repository that could not enter, so a
// blocked author can act without reading the workflow.
{
  const fork = evaluate({ baseRef: 'test', headRef: 'dev', eventName: PR, repository: REPO, baseRepo: REPO, headRepo: 'evil/.github' });
  ok('a fork promotion names the head repository and fails closed',
    fork.ok === false && /evil\/\.github/.test(fork.message) && /fails closed/.test(fork.message), fork.message);
  const missing = evaluate({ baseRef: 'main', headRef: 'test', eventName: PR, repository: REPO, baseRepo: REPO, headRepo: null });
  ok('a missing head repository names the base and fails closed',
    missing.ok === false && /main/.test(missing.message) && /missing|deleted/i.test(missing.message), missing.message);
  const unknown = evaluate({ baseRef: 'test', headRef: 'dev', eventName: PR, repository: '' });
  ok('an unknown canonical repository fails closed with a message',
    unknown.ok === false && /unknown/.test(unknown.message), unknown.message);
}

// The CLI fails with a status a shell can branch on: 0 pass, 1 policy failure.
{
  const run = (args) => spawnSync(process.execPath, [modulePath, ...args], { encoding: 'utf8' });
  const sameRepo = ['--repository', REPO, '--base-repo', REPO, '--head-repo', REPO];
  const pass = run(['--base', 'test', '--head', 'dev', '--event', PR, ...sameRepo]);
  let body = {};
  try { body = JSON.parse(pass.stdout); } catch (error) { /* reported below */ }
  ok('CLI: an allowed source exits 0 and prints the verdict as JSON',
    pass.status === 0 && body.ok === true && body.name === 'test-source-policy', `status=${pass.status} stdout=${pass.stdout} stderr=${pass.stderr}`);
  const fail = run(['--base', 'main', '--head', 'dev', '--event', PR, ...sameRepo]);
  ok('CLI: a rejected source exits 1', fail.status === 1, `status=${fail.status} stdout=${fail.stdout} stderr=${fail.stderr}`);
  const wrongEvent = run(['--base', 'test', '--head', 'dev', '--event', 'push', ...sameRepo]);
  ok('CLI: a wrong event exits 1 (fail closed)', wrongEvent.status === 1, `status=${wrongEvent.status} stdout=${wrongEvent.stdout}`);
  const fork = run(['--base', 'test', '--head', 'dev', '--event', PR, '--repository', REPO, '--base-repo', REPO, '--head-repo', 'evil/.github']);
  ok('CLI: a fork promotion exits 1 (fail closed)', fork.status === 1, `status=${fork.status} stdout=${fork.stdout}`);
  const noIdentity = run(['--base', 'test', '--head', 'dev', '--event', PR]);
  ok('CLI: a promotion with no repository identity exits 1 (fail closed)', noIdentity.status === 1, `status=${noIdentity.status} stdout=${noIdentity.stdout}`);
}

console.log(`\n${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
