#!/usr/bin/env node
'use strict';

// Proves a product repository's areas file partitions it: every tracked file
// belongs to exactly one area, so two Tasks in different areas never edit the
// same file (DELIVERY §6).
//
//   node governance/areas-check.js <product checkout> [git-ref] [--areas <file>]
//
// The areas file defaults to <checkout>/.github/governance/areas.txt; the ref
// to HEAD. The reusable PR governance workflow runs this on every pull request.
//
// Areas file format (also read by bootstrap.sh, which only needs line 1):
//   <name>|<label description, ≤100 characters>
//   #   path: <glob>          one or more, owned by the area above
// Globs: `*` matches within one path segment, `**` across segments, `{a,b}`
// either alternative. A file is
// owned by the FIRST glob in the file that matches it, so specific globs come
// before broad ones and ownership is never ambiguous.
//
// Exit 1 when a file has no owner, an area owns nothing, or a glob can never
// win (every file it matches is claimed earlier) — each is a mistake in the
// areas file, not in the repository.

const { execFileSync } = require('child_process');
const fs = require('fs');

function globToRegex(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      // `**/` matches zero or more whole segments; a trailing `**` matches the rest.
      if (glob[i + 2] === '/') {
        re += '(?:.*/)?';
        i += 2;
      } else {
        re += '.*';
        i += 1;
      }
    } else if (c === '*') {
      re += '[^/]*';
    } else if (c === '?') {
      re += '[^/]';
    } else if (c === '{') {
      // {a,b,c} — alternation of plain text alternatives (no nesting).
      const end = glob.indexOf('}', i);
      if (end < 0) throw new Error(`unclosed { in ${glob}`);
      const alts = glob.slice(i + 1, end).split(',').map((alt) => globToRegex(alt).source.slice(1, -1));
      re += `(?:${alts.join('|')})`;
      i = end;
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

function parseAreas(text) {
  const areas = [];
  const rules = [];
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    const path = /^#\s+path:\s+(\S+)\s*$/.exec(line);
    if (path) {
      if (!areas.length) throw new Error(`path before any area: ${line}`);
      rules.push({ area: areas[areas.length - 1].name, glob: path[1], re: globToRegex(path[1]), wins: 0 });
      continue;
    }
    if (!line || line.startsWith('#')) continue;
    const bar = line.indexOf('|');
    if (bar < 1) throw new Error(`malformed area line: ${line}`);
    areas.push({ name: line.slice(0, bar), description: line.slice(bar + 1), files: 0 });
  }
  return { areas, rules };
}

// Checks one checkout. Returns { ok, report } and never exits, so the PR
// governance workflow can call it through actions/github-script (whose Node the
// runner always carries) as well as from the command line.
function checkAreas({ checkout, ref = 'HEAD', areasFile }) {
  const file = areasFile || require('path').join(checkout, '.github', 'governance', 'areas.txt');
  if (!fs.existsSync(file)) {
    return { ok: false, report: `No areas file at ${file}. An adopted repository defines its areas there (DELIVERY §6).` };
  }
  const { areas, rules } = parseAreas(fs.readFileSync(file, 'utf8'));
  const files = execFileSync('git', ['-C', checkout, 'ls-tree', '-r', '--name-only', ref], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  }).split('\n').filter(Boolean);

  const unowned = [];
  const byArea = new Map(areas.map((a) => [a.name, a]));
  for (const f of files) {
    const rule = rules.find((r) => r.re.test(f));
    if (!rule) {
      unowned.push(f);
      continue;
    }
    rule.wins += 1;
    byArea.get(rule.area).files += 1;
  }

  const out = [];
  let problems = 0;
  out.push(`${files.length} tracked files at ${ref}, ${areas.length} areas, ${rules.length} globs`, '');
  for (const a of areas) {
    out.push(`  area:${a.name.padEnd(16)} ${String(a.files).padStart(5)} files  ${a.description.length > 100 ? '(DESCRIPTION OVER 100)' : ''}`);
    if (a.files === 0) problems += 1;
    if (a.description.length > 100) problems += 1;
  }
  const dead = rules.filter((r) => r.wins === 0);
  if (dead.length) {
    problems += dead.length;
    out.push('', 'Globs that own nothing (misspelt, or shadowed by an earlier glob):');
    for (const r of dead) out.push(`  area:${r.area}  ${r.glob}`);
  }
  if (unowned.length) {
    problems += 1;
    out.push('', `${unowned.length} files with no area:`);
    for (const f of unowned.slice(0, 50)) out.push(`  ${f}`);
    if (unowned.length > 50) out.push(`  … and ${unowned.length - 50} more`);
  }
  const empty = areas.filter((a) => a.files === 0).map((a) => a.name);
  if (empty.length) out.push('', `Areas that own no file: ${empty.join(', ')}`);
  out.push('', problems ? `FAIL: ${problems} problem(s)` : 'OK: every file has exactly one area');
  return { ok: problems === 0, report: out.join('\n') };
}

function main() {
  const args = process.argv.slice(2);
  const flag = args.indexOf('--areas');
  const areasFile = flag >= 0 ? args.splice(flag, 2)[1] : null;
  const [checkout, ref = 'HEAD'] = args;
  if (!checkout || (flag >= 0 && !areasFile)) {
    console.error('usage: areas-check.js <product checkout> [git-ref] [--areas <file>]');
    process.exit(2);
  }
  const { ok, report } = checkAreas({ checkout, ref, areasFile });
  (report.startsWith("No areas file") ? console.error : console.log)(report);
  process.exit(ok ? 0 : 1);
}

module.exports = { globToRegex, parseAreas, checkAreas };
if (require.main === module) main();
