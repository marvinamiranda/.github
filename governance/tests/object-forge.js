'use strict';

// Forges a checkout's object store, for the provenance drills in
// bootstrap.test.js and identity.test.js (marvinamiranda/.github#26).
//
// Git re-hashes an object only when it writes one. On read it trusts the pack
// index and the loose object file it finds under the object id, so a process
// that can write under .git can give an id other content:
//
//   forgePackParent(repo, victim, parent)
//       every object repacked into one pack whose index files a forged commit
//       (victim's tree, <parent> as its only parent, a date after everything
//       here) under victim's id. A walk that reaches victim then continues to
//       <parent>. Aimed at the parent of test's tip: merge-base re-hashes the
//       two commits it is named, not the ones it walks to. <parent> must be
//       dated before test's tip (BACKDATED, in the environment of the commit
//       that makes it): git 2.55 stops an ancestry walk at commits older than
//       the one it looks for. Whoever writes <parent> chooses its date.
//   forgeLooseObject(repo, id, type, content)
//       the loose object file for <id> replaced by one holding <content>.
//
// Both return a function that puts the object store back as it was.

const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const ENV = { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', LANG: 'C' };
const git = (repo, args, input) => execFileSync('git', ['-C', repo, ...args], { env: ENV, input, stdio: ['pipe', 'pipe', 'pipe'] }).toString();

function objectsDir(repo) {
  return path.join(git(repo, ['rev-parse', '--absolute-git-dir']).trim(), 'objects');
}

// A copy of the object store, and the function that restores it.
function keep(objects) {
  const saved = fs.mkdtempSync(path.join(os.tmpdir(), 'object-forge-'));
  fs.cpSync(objects, path.join(saved, 'objects'), { recursive: true });
  return () => {
    fs.rmSync(objects, { recursive: true, force: true });
    fs.cpSync(path.join(saved, 'objects'), objects, { recursive: true });
    fs.rmSync(saved, { recursive: true, force: true });
  };
}

function forgePackParent(repo, victim, parent) {
  const objects = objectsDir(repo);
  const restore = keep(objects);
  const tree = /^tree ([0-9a-f]{40})$/m.exec(git(repo, ['cat-file', '-p', victim]))[1];
  const forged = git(repo, ['hash-object', '-t', 'commit', '-w', '--stdin'],
    `tree ${tree}\nparent ${parent}\nauthor f <f@example.com> 4000000000 +0000\ncommitter f <f@example.com> 4000000000 +0000\n\nforged\n`).trim();
  const all = git(repo, ['cat-file', '--batch-all-objects', '--batch-check=%(objectname)']).split('\n').filter(Boolean);
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'object-forge-pack-'));
  const list = [...all.filter((o) => o !== victim && o !== forged), forged].join('\n') + '\n';
  const name = git(repo, ['pack-objects', '-q', path.join(out, 'p')], list).trim();
  const idxFile = path.join(out, `p-${name}.idx`);
  fs.chmodSync(idxFile, 0o644);

  // Index v2: magic, version, fan-out[256], names, CRCs, 4-byte offsets,
  // (no 8-byte offsets in a pack this small), pack checksum, index checksum.
  const b = fs.readFileSync(idxFile);
  const n = b.readUInt32BE(8 + 255 * 4);
  const base = 8 + 256 * 4;
  const entries = [];
  for (let i = 0; i < n; i++) {
    let id = b.subarray(base + 20 * i, base + 20 * i + 20);
    if (id.toString('hex') === forged) id = Buffer.from(victim, 'hex');
    entries.push({ id, crc: b.subarray(base + 20 * n + 4 * i, base + 20 * n + 4 * i + 4), off: b.subarray(base + 24 * n + 4 * i, base + 24 * n + 4 * i + 4) });
  }
  const tail = b.subarray(base + 28 * n);
  if (tail.length !== 40) throw new Error('object-forge: unexpected index layout');
  entries.sort((x, y) => Buffer.compare(x.id, y.id));
  const fanout = Buffer.alloc(256 * 4);
  for (let i = 0; i < 256; i++) fanout.writeUInt32BE(entries.filter((e) => e.id[0] <= i).length, i * 4);
  const body = Buffer.concat([b.subarray(0, 8), fanout, ...entries.map((e) => e.id), ...entries.map((e) => e.crc),
    ...entries.map((e) => e.off), tail.subarray(0, 20)]);
  fs.writeFileSync(idxFile, Buffer.concat([body, crypto.createHash('sha1').update(body).digest()]));
  for (const f of fs.readdirSync(out)) if (f.endsWith('.rev')) fs.rmSync(path.join(out, f));

  // Only the forged pack is left: no other pack, no loose object.
  fs.rmSync(path.join(objects, 'pack'), { recursive: true, force: true });
  fs.mkdirSync(path.join(objects, 'pack'));
  for (const d of fs.readdirSync(objects)) if (/^[0-9a-f]{2}$/.test(d)) fs.rmSync(path.join(objects, d), { recursive: true, force: true });
  for (const f of fs.readdirSync(out)) fs.copyFileSync(path.join(out, f), path.join(objects, 'pack', f));
  fs.rmSync(out, { recursive: true, force: true });
  return restore;
}

function forgeLooseObject(repo, id, type, content) {
  const objects = objectsDir(repo);
  const restore = keep(objects);
  const file = path.join(objects, id.slice(0, 2), id.slice(2));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.rmSync(file, { force: true });
  const data = Buffer.from(content);
  fs.writeFileSync(file, zlib.deflateSync(Buffer.concat([Buffer.from(`${type} ${data.length}\0`), data])));
  return restore;
}

// Author and committer dates for a commit made to look older than test's tip.
const BACKDATED = { GIT_AUTHOR_DATE: '1000000000 +0000', GIT_COMMITTER_DATE: '1000000000 +0000' };

module.exports = { forgePackParent, forgeLooseObject, BACKDATED };
