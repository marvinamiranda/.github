#!/usr/bin/env node
'use strict';

// Mutation proof for source-policy.test.js: the repository-identity gate in
// governance/source-policy.js is what stops a fork from naming a branch `dev`,
// `main` or `hotfix/*` and reading as the canonical promotion, back-merge or
// release into test or main. Each mutant below weakens that gate, and the suite
// must go red on it; a mutant that leaves the suite green means the adversarial
// cases cannot see that mistake.
//
//   node governance/tests/source-policy.mutations.js

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MODULE = path.join(__dirname, '..', 'source-policy.js');
const TEST = path.join(__dirname, 'source-policy.test.js');
const SOURCE = fs.readFileSync(MODULE, 'utf8');

// [name, [from, to]] -- `from` must occur exactly once in the module.
const mutants = [
  ['the identity gate is removed (test and main accept any repository)',
    ["  if (PROTECTED_BASES.has(base)) {\n    const problem = sameRepositoryProblem(base, repository, baseRepo, headRepo);\n    if (problem) return verdict(false, problem);\n  }\n", '']],
  ['the identity check always passes',
    ['const problem = sameRepositoryProblem(base, repository, baseRepo, headRepo);', "const problem = '';"]],
  ['the head repository is not compared to the canonical repository',
    ['if (!sameFullName(from, canonical) || !sameFullName(to, canonical)) {', 'if (!sameFullName(from, canonical)) {']],
  ['the base repository is not compared to the canonical repository',
    ['if (!sameFullName(from, canonical) || !sameFullName(to, canonical)) {', 'if (!sameFullName(to, canonical)) {']],
  ['a mismatched repository is accepted',
    ['if (!sameFullName(from, canonical) || !sameFullName(to, canonical)) {', 'if (false) {']],
  ['sameFullName treats every name as equal',
    ["const sameFullName = (a, b) => Boolean(a) && String(a).toLowerCase() === String(b == null ? '' : b).toLowerCase();", 'const sameFullName = (a, b) => Boolean(a);']],
  ['the canonical repository is not required (an empty repository is accepted)',
    ['  if (!canonical) {', '  if (false) {']],
  ['a missing head repository is accepted (only the base is required)',
    ['  if (!from || !to) {', '  if (!from) {']],
];

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-mut-'));
const run = (file) => spawnSync('node', [TEST], { encoding: 'utf8', env: { ...process.env, SOURCE_POLICY_MODULE: file } });

const baseline = run(MODULE);
console.log(`baseline: exit ${baseline.status} (must be 0)`);
let bad = baseline.status !== 0 ? 1 : 0;

for (const [name, [from, to]] of mutants) {
  const count = SOURCE.split(from).length - 1;
  if (count !== 1) { bad += 1; console.log(`BROKEN MUTANT - ${name}: the anchor occurs ${count} times, expected 1`); continue; }
  const file = path.join(dir, 'mutant.js');
  fs.writeFileSync(file, SOURCE.replace(from, () => to));
  const result = run(file);
  const red = result.status !== 0;
  const first = (result.stdout.split('\n').find((l) => l.startsWith('not ok')) || result.stderr.split('\n')[0] || '').slice(0, 110);
  if (!red) bad += 1;
  console.log(`${red ? 'killed  ' : 'SURVIVED'} - ${name}${red ? `  [${first}]` : ''}`);
}
fs.rmSync(dir, { recursive: true, force: true });
console.log(bad ? `\n${bad} problem(s)` : `\nall ${mutants.length} mutants killed`);
process.exit(bad ? 1 : 0);
