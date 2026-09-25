#!/usr/bin/env node
'use strict';

// .github/workflows/pr-governance.yml: the pin check each job runs before it
// fetches any code of governance-ref, and the shape of the jobs around it.
//
//   node governance/tests/pr-governance.test.js
//
// The pin check is inline in the workflow, because code fetched at
// governance-ref cannot vouch for governance-ref. This test takes the block
// between `// BEGIN verify-pin` and `// END verify-pin` out of each job and
// runs it against a fake API client. Needs python3 with PyYAML (as the
// workflow's own YAML check does).
//
// PR_GOVERNANCE_WORKFLOW points it at another copy of the workflow, which is
// how a deliberately broken copy is shown to turn this suite red.

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const WORKFLOW = process.env.PR_GOVERNANCE_WORKFLOW
  ? path.resolve(process.env.PR_GOVERNANCE_WORKFLOW)
  : path.join(__dirname, '..', '..', '.github', 'workflows', 'pr-governance.yml');
const text = fs.readFileSync(WORKFLOW, 'utf8');
const parsed = spawnSync('python3', ['-c', 'import json,sys,yaml;print(json.dumps(yaml.safe_load(open(sys.argv[1]))))', WORKFLOW], { encoding: 'utf8' });
if (parsed.status !== 0) { console.log(`not ok - the workflow parses: ${parsed.stderr.trim()}`); process.exit(1); }
const workflow = JSON.parse(parsed.stdout);

let failed = 0;
let total = 0;
function ok(name, condition, detail = '') {
  total += 1;
  if (condition) console.log(`ok - ${name}`);
  else { failed += 1; console.log(`not ok - ${name}${detail ? `: ${detail}` : ''}`); }
}

const SHA = 'eded4bf1f05be3a33a354795bac37d77105bac16';
const OTHER = 'b2f0637eea5c71aa1bb09d0dd0d1b87c8eebc3d3';
const BEGIN = /\/\/ BEGIN verify-pin[^\n]*\n/;
const END = /\n[ \t]*\/\/ END verify-pin/;
const script = (step) => (step.with && typeof step.with.script === 'string' ? step.with.script : '');
const touchesGovernanceCode = (step) => (step.with && step.with.path === '.org-governance') || script(step).includes('.org-governance');

// ------------------------------------------------------------ structure ----
const jobs = workflow.jobs || {};
const blocks = [];
for (const name of ['issue-link', 'areas']) {
  const steps = (jobs[name] && jobs[name].steps) || [];
  const at = steps.findIndex((s) => BEGIN.test(script(s)));
  const firstCode = steps.findIndex(touchesGovernanceCode);
  ok(`${name}: a step verifies the pin`, at >= 0);
  if (at < 0) continue;
  const verify = steps[at];
  ok(`${name}: the pin is verified before any code of governance-ref is fetched or run`, firstCode < 0 || at < firstCode,
    `verify is step ${at}, governance code first at step ${firstCode}`);
  ok(`${name}: the pinned commit comes from job.workflow_sha (the commit of this file), not the caller's github.workflow_sha`,
    verify.env && verify.env.SELF_SHA === '${{ job.workflow_sha }}' && verify.env.SELF_REPOSITORY === '${{ job.workflow_repository }}'
      && verify.env.GOVERNANCE_REF === '${{ inputs.governance-ref }}', JSON.stringify(verify.env));
  const body = script(verify).split(BEGIN)[1];
  blocks.push(body ? body.split(END)[0] : '');
  if (name === 'issue-link') {
    const later = steps.slice(at + 1).filter(touchesGovernanceCode);
    ok('issue-link: nothing of governance-ref is fetched or run unless the pin verified',
      later.length > 0 && later.every((s) => /steps\.pin\.outputs\.ok\s*==\s*'true'/.test(s.if || '') && verify.id === 'pin'),
      JSON.stringify(later.map((s) => s.if)));
    ok('issue-link: no step fails the job; the published governance/issue-link check carries the verdict',
      steps.every((s) => !/core\.setFailed/.test(script(s))), 'core.setFailed found');
  } else {
    ok('areas: a pin problem fails the job, whose status is the verdict', /if \(problem\) core\.setFailed\(problem\)/.test(script(verify)));
  }
}
ok('the workflow never reads github.workflow_sha or GITHUB_WORKFLOW_SHA (in a called workflow, the caller\'s commit)',
  !/\$\{\{[^}]*github\.workflow_sha/.test(text) && !/GITHUB_WORKFLOW_SHA/.test(text));
const norm = (b) => b.split('\n').map((l) => l.trim()).join('\n').trim();
ok('both jobs run the identical pin check', blocks.length === 2 && norm(blocks[0]) === norm(blocks[1]));

// ------------------------------------------------------------ behaviour ----
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
const verifyPin = blocks[0] ? new AsyncFunction('github', 'env', `${blocks[0]}\nreturn verifyPin({ github, env });`) : null;

function fakeGitHub(status) {
  const calls = [];
  return {
    calls,
    rest: { repos: { compareCommitsWithBasehead: async (a) => {
      calls.push(a);
      if (typeof status === 'number') { const e = new Error('HTTP error'); e.status = status; throw e; }
      return { data: { status, ahead_by: 0, behind_by: 3 } };
    } } },
  };
}
const env = (o = {}) => ({ SELF_SHA: SHA, SELF_REPOSITORY: 'marvinamiranda/.github', GOVERNANCE_REF: SHA, ...o });

// [name, env, compare status or HTTP error, pass?, text the problem must contain, may compare?]
const cases = [
  ['the pin is test\'s head (identical): passes', env(), 'identical', true, '', true],
  ['the pin is an older commit of test (behind): passes', env(), 'behind', true, '', true],
  ['the pin is ahead of test (an unmerged pull request commit): fails', env(), 'ahead', false, 'not on marvinamiranda/.github test', true],
  ['the pin diverged from test (another branch, or a fork\'s commit): fails', env(), 'diverged', false, 'not on marvinamiranda/.github test', true],
  ['governance-ref names another commit than uses: fails, without asking GitHub', env({ GOVERNANCE_REF: OTHER }), 'identical', false, 'governance-ref', false],
  ['governance-ref is a branch name: fails', env({ GOVERNANCE_REF: 'test' }), 'identical', false, 'governance-ref', false],
  ['governance-ref is empty: fails', env({ GOVERNANCE_REF: '' }), 'identical', false, 'governance-ref', false],
  ['GitHub reports no workflow commit: fails closed', env({ SELF_SHA: '' }), 'identical', false, 'job.workflow_sha', false],
  ['the workflow runs from a copy in another repository: fails', env({ SELF_REPOSITORY: 'someone/.github' }), 'identical', false, 'not marvinamiranda/.github', false],
  ['the commit is unknown to GitHub (404): fails', env(), 404, false, 'HTTP 404', true],
];

(async () => {
  for (const [name, e, status, pass, needle, mayCompare] of cases) {
    if (!verifyPin) { ok(`pin check: ${name}`, false, 'no verify-pin block'); continue; }
    const gh = fakeGitHub(status);
    let problem;
    try { problem = await verifyPin(gh, e); } catch (error) { problem = `threw ${error.message}`; }
    const issues = [];
    if (pass && problem !== '') issues.push(`expected a pass, got: ${problem}`);
    if (!pass && !(typeof problem === 'string' && problem.includes(needle))) issues.push(`expected a problem naming "${needle}", got: ${JSON.stringify(problem)}`);
    if (!mayCompare && gh.calls.length) issues.push('asked GitHub although the pin was already wrong');
    if (gh.calls.length && !(gh.calls[0].owner === 'marvinamiranda' && gh.calls[0].repo === '.github' && gh.calls[0].basehead === `test...${e.SELF_SHA}`)) {
      issues.push(`compared the wrong thing: ${JSON.stringify(gh.calls[0])}`);
    }
    ok(`pin check: ${name}`, issues.length === 0, issues.join('; '));
  }
  console.log(`\n${total - failed}/${total} passed`);
  process.exit(failed ? 1 : 0);
})();
