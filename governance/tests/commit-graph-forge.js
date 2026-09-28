'use strict';

// Forges a checkout's commit-graph (.git/objects/info/commit-graph), for the
// provenance drills in bootstrap.test.js and identity.test.js.
//
// The graph is written for real (v1 generation numbers, so no GDAT chunk
// overrides the level patched here), then one commit's entry in its CDAT chunk
// is patched:
//   parent  the commit's only parent becomes <parent>, at topological level
//           1000 (above any real commit here, so no generation cut-off stops a
//           walk short of it);
//   tree    the commit's root tree becomes <tree>.
// Git trusts the graph for every commit it parses from it, and never checks
// the trailing hash on read. It lives under .git, where no content check
// looks. The graph must be SHA-1 v1 (git's default object format).

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const HASH = 20;
const CDAT_ENTRY = HASH + 16; // tree, parent 1, parent 2, generation + time
const NO_PARENT = 0x70000000;

function forgeCommitGraph(repo, victim, { parent = null, tree = null } = {}) {
  const env = { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', LANG: 'C' };
  const gitDir = execFileSync('git', ['-C', repo, 'rev-parse', '--absolute-git-dir'], { env }).toString().trim();
  execFileSync('git', ['-C', repo, '-c', 'commitGraph.generationVersion=1', 'commit-graph', 'write', '--reachable'], { env, stdio: 'pipe' });
  const file = path.join(gitDir, 'objects', 'info', 'commit-graph');
  fs.chmodSync(file, 0o644); // git writes it read-only
  const b = fs.readFileSync(file);
  if (b.toString('latin1', 0, 4) !== 'CGPH' || b[4] !== 1 || b[5] !== 1) throw new Error('a SHA-1 commit-graph v1 was expected');
  const chunks = {};
  for (let i = 0; i <= b[6]; i += 1) {
    const at = 8 + 12 * i;
    chunks[b.toString('latin1', at, at + 4)] = Number(b.readBigUInt64BE(at + 4));
  }
  const { OIDL: oidl, CDAT: cdat } = chunks;
  const count = (cdat - oidl) / HASH;
  const index = (sha) => {
    for (let i = 0; i < count; i += 1) if (b.toString('hex', oidl + HASH * i, oidl + HASH * (i + 1)) === sha) return i;
    throw new Error(`${sha} is not in the commit-graph`);
  };
  const e = cdat + CDAT_ENTRY * index(victim);
  if (tree) Buffer.from(tree, 'hex').copy(b, e);
  if (parent) {
    b.writeUInt32BE(index(parent), e + HASH);
    b.writeUInt32BE(NO_PARENT, e + HASH + 4);
    b.writeUInt32BE(((1000 << 2) | (b.readUInt32BE(e + HASH + 8) & 3)) >>> 0, e + HASH + 8);
  }
  fs.writeFileSync(file, b);
  return file;
}

module.exports = { forgeCommitGraph };
