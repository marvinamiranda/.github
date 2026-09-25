#!/usr/bin/env node
'use strict';

// governance/areas-check.js against throwaway git repositories.
//
//   node governance/tests/areas-check.test.js

const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// AREAS_CHECK_MODULE points at another copy, which is how a broken copy is shown to turn this red.
const CHECKER = process.env.AREAS_CHECK_MODULE
  ? path.resolve(process.env.AREAS_CHECK_MODULE)
  : path.join(__dirname, '..', 'areas-check.js');
const { globToRegex } = require(CHECKER);
let failed = 0;
let total = 0;

function ok(name, condition, detail = '') {
  total += 1;
  if (condition) {
    console.log(`ok - ${name}`);
  } else {
    failed += 1;
    console.log(`not ok - ${name}${detail ? `: ${detail}` : ''}`);
  }
}

// A git repository holding `files`, with `.github/governance/areas.txt` = areas.
function repo(files, areas) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'areas-check-'));
  const all = { ...files, '.github/governance/areas.txt': areas };
  for (const [file, body] of Object.entries(all)) {
    fs.mkdirSync(path.join(dir, path.dirname(file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), body);
  }
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' });
  git('init', '-q');
  git('add', '-A');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'fixture');
  return dir;
}

function check(dir, ...extra) {
  return spawnSync('node', [CHECKER, dir, ...extra], { encoding: 'utf8' });
}

const FILES = {
  'src/Inventory/Stock.cs': '',
  'src/Orders/Order.cs': '',
  'src/Shared/Kernel.cs': '',
  'test/stock_test.dart': '',
  'README.md': '',
};
const GOOD = `inventory|Stock
#   path: src/Inventory/**
#   path: {src,test}/**/*stock*
orders|Orders
#   path: src/Orders/**
kernel|Everything else in src
#   path: src/**
repo|Root files and governance
#   path: *.md
#   path: .github/**
`;

// Glob semantics
ok('** spans segments', globToRegex('src/**').test('src/a/b/c.cs'));
ok('**/ matches zero segments', globToRegex('lib/**/*sale*').test('lib/sale.dart'));
ok('* stays inside a segment', !globToRegex('*.md').test('docs/a.md'));
ok('{a,b} alternation', globToRegex('{lib,test}/**/*x*').test('test/a/x_test.dart')
  && !globToRegex('{lib,test}/**/*x*').test('tool/x.sh'));
ok('dots are literal', !globToRegex('a.md').test('aXmd'));

// The CLI
let r = check(repo(FILES, GOOD));
ok('a partition passes', r.status === 0, r.stdout);
ok('first match wins over a later broad glob', /area:inventory\s+2 files/.test(r.stdout), r.stdout);

r = check(repo({ ...FILES, 'tools/run.sh': '' }, GOOD));
ok('an unowned file fails', r.status === 1 && /tools\/run\.sh/.test(r.stdout), r.stdout);

r = check(repo(FILES, `${GOOD}#   path: src/Orders/Order.cs\n`));
ok('a shadowed glob fails', r.status === 1 && /own nothing/.test(r.stdout), r.stdout);

r = check(repo(FILES, `${GOOD}empty|Owns nothing\n#   path: nowhere/**\n`));
ok('an empty area fails', r.status === 1 && /Areas that own no file: empty/.test(r.stdout), r.stdout);

r = check(repo(FILES, `x|${'d'.repeat(101)}\n#   path: **\n`));
ok('a label description over 100 characters fails', r.status === 1, r.stdout);

const dir = repo(FILES, GOOD);
fs.rmSync(path.join(dir, '.github', 'governance', 'areas.txt'));
r = check(dir);
ok('a missing areas file fails', r.status === 1 && /No areas file/.test(r.stderr), r.stderr);

r = check(repo(FILES, GOOD), 'HEAD', '--areas', path.join(repo(FILES, 'only|One\n#   path: **\n'), '.github', 'governance', 'areas.txt'));
ok('--areas overrides the file', r.status === 0 && /area:only/.test(r.stdout), r.stdout);

console.log(`\n${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
