#!/usr/bin/env node
'use strict';

// governance/identity/ (agent-env.sh, gh-shim.sh, app-token.sh) against a fake
// GitHub. A stub `curl` first on PATH answers the App endpoints from a
// scenario file, and a stub "real gh" records the token and config directory
// it was run with. HOME is a throwaway directory holding a throwaway key, so
// nothing here reaches the network or the owner's login.
//
//   node governance/tests/identity.test.js
//
// IDENTITY_DIR points it at another copy of governance/identity/, which is how
// a deliberately broken copy is shown to turn this suite red. IDENTITY_BASH
// runs every script under that bash (for example /bin/bash, macOS bash 3.2).

const { spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const IDENTITY = process.env.IDENTITY_DIR
  ? path.resolve(process.env.IDENTITY_DIR)
  : path.join(__dirname, '..', 'identity');
const NAME = 'mm-agent';
const SLUG = 'fake-agent';
const ORG = 'marvinamiranda';
const API = 'https://api.github.com';
const OWNER = 'gho_OWNERxOWNERxOWNERxOWNERxOWNERxOWNER1';

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

// ------------------------------------------------------------- the world ----
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-test-'));
const home = path.join(root, 'home');
const stubBin = path.join(root, 'stub-bin'); // curl (and bash, with IDENTITY_BASH)
const realBin = path.join(root, 'real-bin'); // the gh the shim must hand off to
const scenarioFile = path.join(root, 'scenario.json');
const curlLog = path.join(root, 'curl.log');
const ghLog = path.join(root, 'real-gh.log');
const ROOT = path.join(home, '.config', 'mm-agent');
const DIR = path.join(ROOT, NAME);
const CACHE = path.join(DIR, 'token.cache');
const REAL_GH = path.join(realBin, 'gh');

fs.mkdirSync(stubBin, { recursive: true });
fs.mkdirSync(realBin, { recursive: true });

// curl: answers "<METHOD> <URL>" from the scenario; an array is served in
// order, its last entry repeating. Understands the flags the scripts use.
fs.writeFileSync(path.join(stubBin, 'curl'), `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
let out = null, fmt = null, method = 'GET', fail = false, url = null;
const headers = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '-o') out = args[++i];
  else if (a === '-w') fmt = args[++i];
  else if (a === '-X') method = args[++i];
  else if (a === '-H') headers.push(args[++i]);
  else if (/^https?:/.test(a)) url = a;
  else if (/^-[A-Za-z]+$/.test(a) && a.includes('f')) fail = true;
}
const auth = (headers.find((h) => /^authorization:/i.test(h)) || '').replace(/^authorization:\\s*/i, '');
fs.appendFileSync(process.env.FAKE_CURL_LOG, JSON.stringify({ method, url, auth }) + '\\n');
const scenario = JSON.parse(fs.readFileSync(process.env.FAKE_GH_SCENARIO, 'utf8'));
const key = method + ' ' + url;
let r = scenario[key];
if (Array.isArray(r)) {
  const countFile = process.env.FAKE_GH_SCENARIO + '.count';
  const counts = fs.existsSync(countFile) ? JSON.parse(fs.readFileSync(countFile, 'utf8')) : {};
  const n = counts[key] || 0;
  counts[key] = n + 1;
  fs.writeFileSync(countFile, JSON.stringify(counts));
  r = r[Math.min(n, r.length - 1)];
}
if (!r) r = { status: 404, body: { message: 'Not Found (stub)' } };
const body = typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
if (fail && r.status >= 400) { process.stderr.write('curl: (22) The requested URL returned error: ' + r.status + '\\n'); process.exit(22); }
if (out) fs.writeFileSync(out, body); else process.stdout.write(body);
if (fmt) process.stdout.write(fmt.replace('%{http_code}', String(r.status)));
`, { mode: 0o755 });

// The "real" gh: records what it was given. Reaching it is the only way a
// command can act on GitHub, so every refusal is checked against this log.
fs.writeFileSync(REAL_GH, `#!/usr/bin/env node
require('fs').appendFileSync(process.env.FAKE_REAL_GH_LOG, JSON.stringify({
  token: process.env.GH_TOKEN === undefined ? null : process.env.GH_TOKEN,
  config: process.env.GH_CONFIG_DIR === undefined ? null : process.env.GH_CONFIG_DIR,
  args: process.argv.slice(2) }) + '\\n');
console.log('real gh ran: ' + process.argv.slice(2).join(' '));
`, { mode: 0o755 });

if (process.env.IDENTITY_BASH) fs.symlinkSync(path.resolve(process.env.IDENTITY_BASH), path.join(stubBin, 'bash'));
const BASH = process.env.IDENTITY_BASH ? path.resolve(process.env.IDENTITY_BASH) : 'bash';

const { privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const now = () => Math.floor(Date.now() / 1000);
const iso = (epoch) => new Date(epoch * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
const minted = (token) => (typeof token === 'object' ? token
  : { status: 201, body: { token, expires_at: iso(now() + 3600) } });

// A fresh HOME holding the App's id, slug and key, and a fresh GitHub.
function fresh({ installation = { status: 200, body: { id: 42 } }, tokens = ['ghs_T1'] } = {}) {
  fs.rmSync(home, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(DIR, 'app.json'), JSON.stringify({ id: 111, slug: SLUG, name: 'Fake Agent' }), { mode: 0o600 });
  fs.writeFileSync(path.join(DIR, 'private-key.pem'), privateKey, { mode: 0o600 });
  world({ installation, tokens });
}
// Change what GitHub answers, keeping HOME (a session whose App breaks).
function world({ installation = { status: 200, body: { id: 42 } }, tokens = ['ghs_T1'] } = {}) {
  fs.writeFileSync(scenarioFile, JSON.stringify({
    [`GET ${API}/orgs/${ORG}/installation`]: installation,
    [`POST ${API}/app/installations/42/access_tokens`]: tokens.map(minted),
    [`GET ${API}/users/${SLUG}%5Bbot%5D`]: { status: 200, body: { id: 99, login: `${SLUG}[bot]` } },
  }));
  fs.rmSync(`${scenarioFile}.count`, { force: true });
  fs.writeFileSync(curlLog, '');
  fs.writeFileSync(ghLog, '');
}
const records = (file) => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const mints = () => records(curlLog).filter((c) => c.method === 'POST' && /access_tokens$/.test(c.url)).length;
const ghRuns = () => records(ghLog);

// Cache line 1 is "<expiry> <token>" (what older copies of app-token.sh read);
// line 2, when present, is when the token was minted.
function writeCache({ token, mintedAgo = 0, expiresIn = 3600 - mintedAgo, oneLine = false }) {
  fs.mkdirSync(DIR, { recursive: true });
  const first = `${now() + expiresIn} ${token}\n`;
  fs.writeFileSync(CACHE, oneLine ? first : `${first}${now() - mintedAgo}\n`, { mode: 0o600 });
}

function env(extra = {}) {
  return {
    HOME: home,
    PATH: [stubBin, realBin, path.dirname(process.execPath), process.env.PATH].join(':'),
    TMPDIR: root,
    LANG: 'C',
    FAKE_GH_SCENARIO: scenarioFile,
    FAKE_CURL_LOG: curlLog,
    FAKE_REAL_GH_LOG: ghLog,
    ...extra,
  };
}
const run = (args, extra) => spawnSync(BASH, args, { env: env(extra), encoding: 'utf8' });
const agentEnv = (extra, name = NAME) => run([path.join(IDENTITY, 'agent-env.sh'), name], extra);
const appToken = () => run([path.join(IDENTITY, 'app-token.sh'), NAME]);
// Evaluate the printed environment in a child shell, then run `script` in a
// GRANDCHILD (bash -c), which sees only what the child exported: a tool shell,
// a script, a `bash -c`. "eval-rc=<n>" on stderr is the eval's own status.
const inChild = (printed, script, extra) =>
  run(['-c', 'eval "$1"; echo "eval-rc=$?" >&2; bash -c "$2"', '_', printed, script], extra);

const CRED = 'printf "protocol=https\\nhost=github.com\\npath=o/r.git\\n\\n" | git credential fill; echo "git-rc=$?"';
const rcOf = (out, label) => { const m = new RegExp(`${label}=(\\d+)`).exec(out); return m ? Number(m[1]) : null; };

// --------------------------------------------------- agent-env.sh (B1) ----
(function prints() {
  fresh({ tokens: ['ghs_SECRET1'] });
  const r = agentEnv();
  ok('agent-env.sh succeeds with a working App', r.status === 0, r.stderr.trim());
  ok('the printed environment holds no token', !r.stdout.includes('ghs_SECRET1'),
    r.stdout.split('\n').find((l) => l.includes('ghs_SECRET1')));

  const owner = { GH_TOKEN: OWNER, GITHUB_TOKEN: OWNER, GH_PACKAGES_TOKEN: OWNER };
  const printed = agentEnv(owner).stdout;
  const u = inChild(printed, 'echo "${GH_TOKEN-unset}/${GITHUB_TOKEN-unset}/${GH_PACKAGES_TOKEN-unset}"', owner);
  ok('GH_TOKEN, GITHUB_TOKEN and GH_PACKAGES_TOKEN inherited from the owner are unset', u.stdout.trim() === 'unset/unset/unset', u.stdout.trim());

  const w = inChild(printed, 'command -v gh');
  ok('a grandchild process resolves gh to the shim, not the real gh',
    w.stdout.trim().startsWith(`${DIR}/`) && w.stdout.trim() !== REAL_GH, w.stdout.trim() || w.stderr.trim());

  const old = run(['-c', 'gh() { echo OLD; }; eval "$1"; type -t gh', '_', printed]);
  ok('a gh() function left by an older agent-env.sh is replaced by the shim', old.stdout.trim() === 'file', old.stdout.trim());

  const z = spawnSync('zsh', ['-c', 'eval "$1" && command -v gh', '_', printed], { env: env(), encoding: 'utf8' });
  if (z.error && z.error.code === 'ENOENT') console.log('ok - # SKIP zsh not installed');
  else ok('the printed environment also evaluates under zsh', z.status === 0 && z.stdout.trim().startsWith(`${DIR}/`), (z.stdout + z.stderr).trim());
})();

(function refusals() {
  fresh();
  const printed = agentEnv().stdout;
  for (const [what, cmd] of [
    ['gh auth token', 'gh auth token'],
    ['gh auth token --user <owner> (reads the keyring whatever GH_TOKEN says)', 'gh auth token --user rodrigolmiranda'],
    ['gh auth status --show-token', 'gh auth status --show-token'],
    ['gh auth status -t', 'gh auth status -t'],
    ['gh auth git-credential', 'echo | gh auth git-credential get'],
    ['gh auth login', 'gh auth login --with-token </dev/null'],
    ['gh auth setup-git', 'gh auth setup-git'],
    ['gh alias set (could name a refused command)', 'gh alias set tk "auth token"'],
  ]) {
    fs.writeFileSync(ghLog, '');
    const r = inChild(printed, `${cmd}; echo "gh-rc=$?"`);
    ok(`${what} is refused in a grandchild and never reaches the real gh`,
      rcOf(r.stdout, 'gh-rc') !== 0 && /refused/.test(r.stderr) && ghRuns().length === 0,
      `rc=${rcOf(r.stdout, 'gh-rc')} real-gh=${JSON.stringify(ghRuns().map((g) => g.args))} ${r.stderr.trim().split('\n').pop()}`);
  }
  fs.writeFileSync(ghLog, '');
  const s = inChild(printed, 'gh auth status; echo "gh-rc=$?"');
  ok('a plain gh auth status still runs', rcOf(s.stdout, 'gh-rc') === 0 && ghRuns().length === 1, s.stderr.trim());
})();

(function mintsPerCall() {
  fresh({ tokens: ['ghs_T1', 'ghs_T2'] });
  const printed = agentEnv().stdout;
  fs.writeFileSync(ghLog, '');
  // Two gh calls in ONE grandchild; between them the cached token turns five
  // minutes old, as it does in a session that outlives it.
  const age = `printf '%s %s\\n%s\\n' "$(( $(date +%s) + 3000 ))" ghs_T1 "$(( $(date +%s) - 301 ))" > ${JSON.stringify(CACHE)}`;
  const r = inChild(printed, `gh api first; ${age}; gh api second`);
  const runs = ghRuns();
  ok('gh runs with a minted App token and the identity\'s empty GH_CONFIG_DIR',
    runs[0] && runs[0].token === 'ghs_T1' && runs[0].config === path.join(DIR, 'gh') && runs[0].args.join(' ') === 'api first',
    JSON.stringify(runs[0]) + r.stderr.trim());
  ok('a long-lived grandchild gets a re-minted token once the cached one is 5 minutes old',
    runs[1] && runs[1].token === 'ghs_T2', JSON.stringify(runs[1]));

  const g = inChild(printed, CRED);
  ok('git gets an App token from the credential helper',
    /username=x-access-token/.test(g.stdout) && /password=ghs_T2/.test(g.stdout) && rcOf(g.stdout, 'git-rc') === 0,
    (g.stdout + g.stderr).trim());
})();

(function failsClosed() {
  for (const [what, broken] of [
    ['no token can be minted (installation gone)', { installation: { status: 404, body: { message: 'Not Found' } } }],
    ['the minted token is empty', { tokens: [{ status: 201, body: { token: '', expires_at: iso(now() + 3600) } }] }],
    ['the minted token is not an installation token', { tokens: ['gho_NOTANAPPTOKEN'] }],
  ]) {
    fresh();
    const printed = agentEnv().stdout; // set up while the App works
    world(broken); // then the App breaks, and the cached token is gone
    fs.rmSync(CACHE, { force: true });
    const r = inChild(printed, 'gh api user; echo "gh-rc=$?"');
    ok(`gh fails closed when ${what}`, rcOf(r.stdout, 'gh-rc') !== 0 && ghRuns().length === 0,
      `rc=${rcOf(r.stdout, 'gh-rc')} real-gh=${JSON.stringify(ghRuns())}`);
    const g = inChild(printed, CRED);
    ok(`git fails closed when ${what}`, rcOf(g.stdout, 'git-rc') !== 0 && !/password=./.test(g.stdout),
      (g.stdout + g.stderr).trim().split('\n').slice(-3).join(' | '));
  }
})();

(function lockedOnFailure() {
  const owner = { GH_TOKEN: OWNER, GITHUB_TOKEN: OWNER, GH_PACKAGES_TOKEN: OWNER };
  const repo = path.join(root, 'repo');
  spawnSync('git', ['init', '-q', repo]);
  const COMMIT = `git -C ${JSON.stringify(repo)} -c user.name=Owner -c user.email=owner@example.com commit -q --allow-empty -m x; echo "commit-rc=$?"`;
  for (const [what, setup, name] of [
    ['its gh directory holds a login (hosts.yml)', () => { fs.mkdirSync(path.join(DIR, 'gh'), { recursive: true }); fs.writeFileSync(path.join(DIR, 'gh', 'hosts.yml'), 'github.com: {}\n'); }, NAME],
    ['the App was never created (no app.json)', () => fs.rmSync(path.join(DIR, 'app.json')), NAME],
    ['the identity is unknown', () => {}, 'mm-nobody'],
  ]) {
    fresh();
    setup();
    const r = agentEnv(owner, name);
    ok(`agent-env.sh exits non-zero when ${what}`, r.status !== 0, `status ${r.status}`);
    const c = inChild(r.stdout, `echo "tokens=\${GH_TOKEN-unset}/\${GITHUB_TOKEN-unset}/\${GH_PACKAGES_TOKEN-unset}"; gh api user; echo "gh-rc=$?"; ${CRED}; ${COMMIT}`, owner);
    ok(`...and what it printed leaves no identity: tokens unset, gh, git and commits refuse, the eval fails (${what})`,
      /tokens=unset\/unset\/unset/.test(c.stdout) && rcOf(c.stdout, 'gh-rc') !== 0 && ghRuns().length === 0
        && rcOf(c.stdout, 'git-rc') !== 0 && !/password=./.test(c.stdout) && rcOf(c.stdout, 'commit-rc') !== 0
        && rcOf(c.stderr, 'eval-rc') !== 0,
      `${c.stdout.trim().split('\n').join(' | ')} || eval-rc=${rcOf(c.stderr, 'eval-rc')}`);
  }
})();

// -------------------------------------------- app-token.sh (finding 10) ----
(function cache() {
  fresh({ tokens: ['ghs_NEW'] });
  writeCache({ token: 'ghs_CACHED', mintedAgo: 60 });
  let r = appToken();
  ok('a cached token minted a minute ago is reused without calling GitHub', r.stdout.trim() === 'ghs_CACHED' && records(curlLog).length === 0,
    `${r.stdout.trim()} calls=${records(curlLog).length} ${r.stderr.trim()}`);

  for (const [what, cache] of [
    ['a cached token minted over 5 minutes ago is not reused, though 55 minutes remain', { token: 'ghs_STALE', mintedAgo: 301, expiresIn: 3299 }],
    ['a one-line cache from an older copy (no mint time) is not trusted', { token: 'ghs_OLDFORMAT', oneLine: true, expiresIn: 3500 }],
    ['a cached token that is not an installation token is not served', { token: OWNER, mintedAgo: 10 }],
  ]) {
    fresh({ tokens: ['ghs_NEW'] });
    writeCache(cache);
    r = appToken();
    ok(what, r.stdout.trim() === 'ghs_NEW' && mints() === 1, `${r.stdout.trim()} mints=${mints()} ${r.stderr.trim()}`);
  }

  const first = fs.readFileSync(CACHE, 'utf8').split('\n')[0].split(' ');
  ok('after a mint the cache still starts "<expiry> <token>", the line older copies read',
    first.length === 2 && /^\d+$/.test(first[0]) && first[1] === 'ghs_NEW', first.join(' '));
  ok('the cache file is private (0600)', (fs.statSync(CACHE).mode & 0o777) === 0o600, (fs.statSync(CACHE).mode & 0o777).toString(8));

  for (const [what, broken] of [
    ['the installation is gone', { installation: { status: 404, body: { message: 'Not Found' } } }],
    ['GitHub mints an empty token', { tokens: [{ status: 201, body: { token: '', expires_at: iso(now() + 3600) } }] }],
  ]) {
    fresh(broken);
    r = appToken();
    ok(`app-token.sh prints nothing and fails when ${what}`, r.status !== 0 && r.stdout.trim() === '', `status ${r.status} stdout ${JSON.stringify(r.stdout)}`);
  }
})();

fs.rmSync(root, { recursive: true, force: true });
console.log(`\n${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
