#!/usr/bin/env node
'use strict';

// Mutation proof for issue-link.test.js: the repository-identity guard in
// isReleasePullRequest (governance/issue-link.js) is what stops a fork from
// naming a branch `dev` or `test` and reading as the canonical promotion
// (dev -> test) or release (test -> main), skipping the closing link. Each
// mutant below weakens that guard, and the suite must go red on it.
//
//   node governance/tests/issue-link.mutations.js

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MODULE = path.join(__dirname, '..', 'issue-link.js');
const TEST = path.join(__dirname, 'issue-link.test.js');
const SOURCE = fs.readFileSync(MODULE, 'utf8');

// [name, [from, to]] -- `from` must occur exactly once in the module.
const mutants = [
  ['the identity guard is removed (any branch pair is exempt)',
    ['if (!same(baseRepo) || !same(headRepo)) return false;', 'if (false) return false;']],
  ['the head repository is not compared (a fork head is exempt)',
    ['if (!same(baseRepo) || !same(headRepo)) return false;', 'if (!same(baseRepo)) return false;']],
  ['the base repository is not compared (a fork base is exempt)',
    ['if (!same(baseRepo) || !same(headRepo)) return false;', 'if (!same(headRepo)) return false;']],
  ['same() accepts every repository (identity is never checked)',
    ['  const same = (fullName) => Boolean(repository) && Boolean(fullName)\n    && String(fullName).toLowerCase() === String(repository).toLowerCase();', '  const same = (fullName) => Boolean(fullName);']],
  ['the repository names are not compared, only their presence',
    ['  const same = (fullName) => Boolean(repository) && Boolean(fullName)\n    && String(fullName).toLowerCase() === String(repository).toLowerCase();', '  const same = (fullName) => Boolean(repository) && Boolean(fullName);']],
];

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'il-mut-'));
const run = (file) => spawnSync('node', [TEST], { encoding: 'utf8', env: { ...process.env, ISSUE_LINK_MODULE: file } });

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
