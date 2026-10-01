#!/usr/bin/env node
'use strict';

// Mutation proof for pr-governance.test.js, runner section
// (marvinamiranda/.github#34): each mutant is a deliberately broken copy of
// pr-governance.yml, and the suite must go red on it. A mutant that leaves the
// suite green means the suite cannot see that mistake.
//
//   node governance/tests/pr-governance.mutations.js

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const SOURCE = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'pr-governance.yml'), 'utf8');
const TEST = path.join(__dirname, 'pr-governance.test.js');
const LANE = "    runs-on: ${{ vars.PR_GOVERNANCE_LANE == 'dedicated' && fromJSON('[\"self-hosted\",\"governance-lane\"]') || fromJSON(inputs.runs-on) }}\n";
const lane = (expr) => `    runs-on: ${expr}\n`;

// [name, [from, to], count]: `from` must occur exactly `count` times; every
// occurrence is replaced.
const mutants = [
  ['the lane names gate-ephemeral (decision E)', ['"governance-lane"]', '"gate-ephemeral"]'], 2],
  ['the lane adds pool-linux (CI could take the runner)', ['"governance-lane"]', '"governance-lane","pool-linux"]'], 2],
  ['the lane is a hosted runner', ["fromJSON('[\"self-hosted\",\"governance-lane\"]')", "fromJSON('\"ubuntu-latest\"')"], 2],
  ['the lane switches on any value of the variable', ["vars.PR_GOVERNANCE_LANE == 'dedicated'", "vars.PR_GOVERNANCE_LANE != ''"], 2],
  ['the lane switches on an empty value (an unset variable)', ["vars.PR_GOVERNANCE_LANE == 'dedicated'", "vars.PR_GOVERNANCE_LANE == ''"], 2],
  ['the lane is the default and the variable turns it off', ["vars.PR_GOVERNANCE_LANE == 'dedicated'", "vars.PR_GOVERNANCE_LANE != 'off'"], 2],
  ['the labels come from a variable, not this file', ["fromJSON('[\"self-hosted\",\"governance-lane\"]')", 'fromJSON(vars.PR_GOVERNANCE_LABELS)'], 2],
  ['no fallback to the caller\'s runs-on', [LANE, lane("${{ fromJSON('[\"self-hosted\",\"governance-lane\"]') }}")], 2],
  ['only issue-link switches; areas stays on the caller\'s runner', [`${LANE}    timeout-minutes: 5\n    permissions:\n      contents: read\n`, `${lane('${{ fromJSON(inputs.runs-on) }}')}    timeout-minutes: 5\n    permissions:\n      contents: read\n`], 1],
  ['the jobs ignore the switch (the lane can never be turned on)', [LANE, lane('${{ fromJSON(inputs.runs-on) }}')], 2],
  ['runs-on gains a default', ["        description: Runner for the jobs, as JSON (a label string or a list of labels).\n        type: string\n        required: true\n", "        description: Runner for the jobs, as JSON (a label string or a list of labels).\n        type: string\n        required: false\n        default: '\"ubuntu-latest\"'\n"], 1],
];

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prg-mut-'));
const run = (file) => spawnSync('node', [TEST], { encoding: 'utf8', env: { ...process.env, PR_GOVERNANCE_WORKFLOW: file } });

const baseline = run(path.join(ROOT, '.github', 'workflows', 'pr-governance.yml'));
console.log(`baseline: exit ${baseline.status} (must be 0)`);
let bad = baseline.status !== 0 ? 1 : 0;

for (const [name, [from, to], expected] of mutants) {
  const count = SOURCE.split(from).length - 1;
  if (count !== expected) { bad += 1; console.log(`BROKEN MUTANT - ${name}: the anchor occurs ${count} times, expected ${expected}`); continue; }
  const file = path.join(dir, 'mutant.yml');
  fs.writeFileSync(file, SOURCE.split(from).join(to));
  const result = run(file);
  const red = result.status !== 0;
  const first = (result.stdout.split('\n').find((l) => l.startsWith('not ok')) || result.stderr.split('\n')[0] || '').slice(0, 110);
  if (!red) bad += 1;
  console.log(`${red ? 'killed  ' : 'SURVIVED'} - ${name}${red ? `  [${first}]` : ''}`);
}
fs.rmSync(dir, { recursive: true, force: true });
console.log(bad ? `\n${bad} problem(s)` : `\nall ${mutants.length} mutants killed`);
process.exit(bad ? 1 : 0);
