#!/usr/bin/env node
'use strict';

// governance/identity/ (agent-env.sh, gh-shim.sh, app-token.sh) against a fake
// GitHub. A stub `curl` first on PATH answers the App endpoints from a
// scenario file, and a stub "real gh" records the token and config directory
// it was run with. HOME is a throwaway directory holding a throwaway key, so
// nothing here reaches the network or the owner's login.
//
// The scripts run from a throwaway git checkout, because agent-env.sh refuses
// one whose scripts differ from its HEAD and warns when HEAD is not on
// marvinamiranda/.github test. That repository is a local bare one here: the
// fake HOME's ~/.gitconfig points https://github.com/marvinamiranda/.github.git
// at it (url.<bare>.insteadOf), so its `test` is whatever a case says.
//
// The fake HOME also holds zsh startup files shaped like the owner's: a
// .zprofile and a .zshrc that put a directory holding another "real" gh first
// on PATH (as `brew shellenv` does), and a .zshrc that exports
// GH_PACKAGES_TOKEN from `gh auth token`.
//
//   node governance/tests/identity.test.js
//
// IDENTITY_DIR points it at another copy of governance/identity/, which is how
// a deliberately broken copy is shown to turn this suite red. IDENTITY_BASH
// runs every script under that bash (for example /bin/bash, macOS bash 3.2).
// IDENTITY_REQUIRE_ZSH=1 (CI) makes a missing zsh a failure, not a skip.

const { spawnSync, execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const IDENTITY_SRC = process.env.IDENTITY_DIR
  ? path.resolve(process.env.IDENTITY_DIR)
  : path.join(__dirname, '..', 'identity');
const SCRIPTS = ['agent-env.sh', 'gh-shim.sh', 'app-token.sh'];
const NAME = 'mm-agent';
const SLUG = 'fake-agent';
const ORG = 'marvinamiranda';
const API = 'https://api.github.com';
const CANONICAL = `https://github.com/${ORG}/.github.git`;
const OWNER = 'gho_OWNERxOWNERxOWNERxOWNERxOWNERxOWNER1';
const PKG = `ghp_${'P'.repeat(36)}`;
const SENTINEL_RE = /^mm-agent-sentinel-not-a-token$/;

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
const gitHome = path.join(root, 'git-home'); // HOME for this file's own git commands
const stubBin = path.join(root, 'stub-bin'); // curl (and bash, with IDENTITY_BASH)
const realBin = path.join(root, 'real-bin'); // the gh the shim must hand off to
const brewBin = path.join(root, 'brew-bin'); // another real gh, which the owner's startup files put first
const scenarioFile = path.join(root, 'scenario.json');
const curlLog = path.join(root, 'curl.log');
const ghLog = path.join(root, 'real-gh.log');
const brewLog = path.join(root, 'brew-gh.log');
const src = path.join(root, 'src'); // the checkout the scripts run from
const canon = path.join(root, 'canon.git'); // stands in for marvinamiranda/.github
const IDENTITY = path.join(src, 'governance', 'identity');
const ROOT = path.join(home, '.config', 'mm-agent');
const DIR = path.join(ROOT, NAME);
const CACHE = path.join(DIR, 'token.cache');
const PACKAGES = path.join(ROOT, 'packages-token');
const REAL_GH = path.join(realBin, 'gh');

for (const d of [stubBin, realBin, brewBin, gitHome]) fs.mkdirSync(d, { recursive: true });

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

// The gh the owner's startup files put first (Homebrew's, on the owner's
// machine). Like the real one it answers `gh auth token` with GH_TOKEN when
// that is set, and otherwise, or with --user, with the keyring login: OWNER.
fs.writeFileSync(path.join(brewBin, 'gh'), `#!/bin/sh
echo "$*" >> ${JSON.stringify(brewLog)}
if [ "$1" = auth ] && [ "$2" = token ]; then
  case " $* " in *" --user "*) echo ${OWNER}; exit 0 ;; esac
  if [ -n "\${GH_TOKEN-}" ]; then echo "$GH_TOKEN"; else echo ${OWNER}; fi
  exit 0
fi
echo "brew gh ran: $*"
`, { mode: 0o755 });

if (process.env.IDENTITY_BASH) fs.symlinkSync(path.resolve(process.env.IDENTITY_BASH), path.join(stubBin, 'bash'));
const BASH = process.env.IDENTITY_BASH ? path.resolve(process.env.IDENTITY_BASH) : 'bash';

const { privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

// ---------------------------------------------- the checkout and its test ----
const gitEnv = { PATH: process.env.PATH, HOME: gitHome, GIT_CONFIG_NOSYSTEM: '1', LANG: 'C' };
const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.com',
  '-c', 'commit.gpgsign=false', ...a], { stdio: 'pipe', env: gitEnv }).toString().trim();
fs.mkdirSync(IDENTITY, { recursive: true });
for (const f of SCRIPTS) {
  fs.copyFileSync(path.join(IDENTITY_SRC, f), path.join(IDENTITY, f));
  fs.chmodSync(path.join(IDENTITY, f), 0o755);
}
git(root, 'init', '-q', src);
git(src, 'add', '.');
git(src, 'commit', '-q', '-m', 'identity scripts');
const COMMIT = git(src, 'rev-parse', 'HEAD');
git(root, 'init', '-q', '--bare', canon);
git(canon, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
git(src, 'push', '-q', canon, 'HEAD:refs/heads/test');
const SHIM = (sha = COMMIT) => path.join(DIR, 'shim', sha);

// Where marvinamiranda/.github `test` is: 'head' (the checkout's commit),
// 'ahead' (a later commit the checkout does not have), 'elsewhere' (an
// unrelated commit), 'gone' (the repository cannot be read).
function canonTest(kind) {
  if (fs.existsSync(`${canon}.gone`)) fs.renameSync(`${canon}.gone`, canon);
  const head = git(src, 'rev-parse', 'HEAD');
  if (kind === 'head') git(src, 'push', '-q', '-f', canon, 'HEAD:refs/heads/test');
  if (kind === 'ahead') {
    const later = git(canon, 'commit-tree', `${head}^{tree}`, '-p', head, '-m', 'later');
    git(canon, 'update-ref', 'refs/heads/test', later);
  }
  if (kind === 'elsewhere') {
    const empty = git(canon, 'hash-object', '-t', 'tree', '-w', '/dev/null');
    git(canon, 'update-ref', 'refs/heads/test', git(canon, 'commit-tree', empty, '-m', 'unrelated'));
  }
  if (kind === 'gone') fs.renameSync(canon, `${canon}.gone`);
}

const now = () => Math.floor(Date.now() / 1000);
const iso = (epoch) => new Date(epoch * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
const minted = (token) => (typeof token === 'object' ? token
  : { status: 201, body: { token, expires_at: iso(now() + 3600) } });

// The owner's zsh startup files, shaped like the real ones.
function ownerShellFiles() {
  const w = (f, s) => fs.writeFileSync(path.join(home, f), s);
  w('.zshenv', 'export OWNER_ZSHENV=e OWNER_SAW_ZDOTDIR="${ZDOTDIR-}"\n');
  w('.zprofile', `export PATH=${JSON.stringify(brewBin)}":$PATH"\nexport OWNER_ZPROFILE=p\n`);
  w('.zshrc', [
    `export PATH=${JSON.stringify(brewBin)}":$PATH"`,
    '# SM360 GitHub Packages, as in the owner\'s .zshrc',
    'if token="$(gh auth token 2>/dev/null)" && [ -n "$token" ]; then',
    '  export GH_PACKAGES_TOKEN="$token"',
    'fi',
    'export OWNER_ZSHRC=r',
    '# an alias named gh, as a plugin might define: it would shadow any PATH',
    `alias gh='echo OWNER-ALIAS'`,
    '',
  ].join('\n'));
  w('.zlogin', 'export OWNER_ZLOGIN=l\n');
}

// A fresh HOME holding the App's id, slug and key, the owner's shell files and
// the git configuration that maps the canonical URL; and a fresh GitHub.
function fresh({ installation = { status: 200, body: { id: 42 } }, tokens = ['ghs_T1'] } = {}) {
  fs.rmSync(home, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(DIR, 'app.json'), JSON.stringify({ id: 111, slug: SLUG, name: 'Fake Agent' }), { mode: 0o600 });
  fs.writeFileSync(path.join(DIR, 'private-key.pem'), privateKey, { mode: 0o600 });
  fs.writeFileSync(path.join(home, '.gitconfig'), `[url "${canon}"]\n\tinsteadOf = ${CANONICAL}\n`);
  ownerShellFiles();
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
  for (const f of [curlLog, ghLog, brewLog]) fs.writeFileSync(f, '');
}
const readOr = (file, otherwise = '') => { try { return fs.readFileSync(file, 'utf8'); } catch (e) { return otherwise; } };
const listOr = (dir) => { try { return fs.readdirSync(dir); } catch (e) { return []; } };
const lines = (file) => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
const records = (file) => lines(file).map((l) => JSON.parse(l));
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
    GIT_CONFIG_NOSYSTEM: '1',
    FAKE_GH_SCENARIO: scenarioFile,
    FAKE_CURL_LOG: curlLog,
    FAKE_REAL_GH_LOG: ghLog,
    ...extra,
  };
}
const run = (args, extra) => spawnSync(BASH, args, { env: env(extra), encoding: 'utf8' });
const agentEnv = (extra, name = NAME, from = IDENTITY) => run([path.join(from, 'agent-env.sh'), name], extra);
const appToken = () => run([path.join(IDENTITY, 'app-token.sh'), NAME]);
// Evaluate the printed environment in a child shell, then run `script` in a
// GRANDCHILD (bash -c), which sees only what the child exported: a tool shell,
// a script, a `bash -c`. "eval-rc=<n>" on stderr is the eval's own status.
const inChild = (printed, script, extra) =>
  run(['-c', 'eval "$1"; echo "eval-rc=$?" >&2; bash -c "$2"', '_', printed, script], extra);
// The same, where the grandchild is zsh started with `flags` (-lc, -lic, -ic),
// so it reads the startup files: the owner's, through ZDOTDIR.
const inZsh = (printed, flags, script, extra) =>
  run(['-c', `eval "$1"; exec zsh ${flags} "$2"`, '_', printed, script], extra);

const CRED = 'printf "protocol=https\\nhost=github.com\\npath=o/r.git\\n\\n" | git credential fill; echo "git-rc=$?"';
const rcOf = (out, label) => { const m = new RegExp(`${label}=(\\d+)`).exec(out); return m ? Number(m[1]) : null; };
const field = (out, label) => { const m = new RegExp(`^${label}=(.*)$`, 'm').exec(out); return m ? m[1] : null; };

const hasZsh = spawnSync('zsh', ['-c', 'true']).status === 0;
function zshOrSkip(what) {
  if (hasZsh) return true;
  if (process.env.IDENTITY_REQUIRE_ZSH) ok(`${what} (zsh is required here)`, false, 'zsh not installed');
  else console.log(`ok - # SKIP zsh not installed: ${what}`);
  return false;
}

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
  const [tok, ghub, pkg] = u.stdout.trim().split('/');
  ok('tokens inherited from the owner do not survive: GH_TOKEN is the sentinel, GITHUB_TOKEN and GH_PACKAGES_TOKEN are unset',
    SENTINEL_RE.test(tok) && ghub === 'unset' && pkg === 'unset', u.stdout.trim());

  // R1: a real gh reached some other way (PATH order, not an absolute path)
  // answers `gh auth token` with GH_TOKEN, so it hands out the sentinel.
  fs.writeFileSync(brewLog, '');
  const b = inChild(printed, `PATH=${JSON.stringify(brewBin)}:"$PATH" gh auth token`, owner);
  ok('a real gh reached through PATH order answers gh auth token with the sentinel, not the keyring login',
    SENTINEL_RE.test(b.stdout.trim()) && !b.stdout.includes(OWNER), b.stdout.trim());

  const w = inChild(printed, 'command -v gh');
  ok('a grandchild process resolves gh to the shim, not the real gh',
    w.stdout.trim().startsWith(`${DIR}/`) && w.stdout.trim() !== REAL_GH, w.stdout.trim() || w.stderr.trim());

  const old = run(['-c', 'gh() { echo OLD; }; eval "$1"; type -t gh', '_', printed]);
  ok('a gh() function left by an older agent-env.sh is replaced by the shim', old.stdout.trim() === 'file', old.stdout.trim());

  // zsh parses a whole eval before running it, with aliases expanded, so an
  // alias named gh is checked for too (as is one in an interactive bash).
  if (zshOrSkip('the printed environment evaluates under zsh with an alias named gh')) {
    const z = spawnSync('zsh', ['-c', 'alias gh="echo ALIAS"; eval "$1" && command -v gh', '_', printed], { env: env(), encoding: 'utf8' });
    ok('the printed environment also evaluates under zsh, with an alias named gh', z.status === 0 && z.stdout.trim().startsWith(`${DIR}/`), (z.stdout + z.stderr).trim());
  }
})();

// ------------------------------------ R1: zsh login and interactive shells ----
// Claude Code builds its tool shells from a login, interactive zsh; the
// owner's .zprofile runs `brew shellenv`, which puts the real gh first again.
(function zshStartup() {
  if (!zshOrSkip('zsh login and interactive shells keep the shim first')) return;
  const probe = [
    'print -r -- "gh=$(command -v gh)"',
    'print -r -- "token=${GH_TOKEN-unset}"',
    'print -r -- "packages=${GH_PACKAGES_TOKEN-unset}"',
    'print -r -- "owner-files=${OWNER_ZSHENV-}${OWNER_ZPROFILE-}${OWNER_ZSHRC-}${OWNER_ZLOGIN-}"',
    'print -r -- "owner-saw-zdotdir=${OWNER_SAW_ZDOTDIR-}"',
    'print -r -- "histfile=${HISTFILE-}"',
    `print -r -- "brew-token=$(${JSON.stringify(path.join(brewBin, 'gh'))} auth token)"`,
    'gh auth token; print -r -- "gh-rc=$?"',
    'print -r -- "nested=$(zsh -lic \'command -v gh\' 2>/dev/null)"',
  ].join('; ');
  for (const [flags, files, withPackages] of [
    ['-lc', 'epl', false], ['-lic', 'eprl', false], ['-ic', 'er', false],
    ['-lc', 'epl', true], ['-lic', 'eprl', true], ['-ic', 'er', true],
  ]) {
    fresh();
    if (withPackages) fs.writeFileSync(PACKAGES, `${PKG}\n`, { mode: 0o600 });
    const owner = { GH_TOKEN: OWNER, GITHUB_TOKEN: OWNER, GH_PACKAGES_TOKEN: OWNER };
    const printed = agentEnv(owner).stdout;
    const z = inZsh(printed, flags, probe, owner);
    const out = z.stdout;
    const shimGh = path.join(SHIM(), 'bin', 'gh');
    const label = `zsh ${flags}${withPackages ? ', with a packages token' : ''}`;
    ok(`${label}: gh is the shim, though the owner's startup files put another gh first`,
      field(out, 'gh') === shimGh, `${field(out, 'gh')} ${z.stderr.trim().split('\n').slice(-2).join(' | ')}`);
    ok(`${label}: the owner's startup files still ran, with ZDOTDIR set to their own directory`,
      field(out, 'owner-files') === files && field(out, 'owner-saw-zdotdir') === home, `${field(out, 'owner-files')} saw ${field(out, 'owner-saw-zdotdir')}`);
    ok(`${label}: gh auth token is refused, GH_TOKEN is still the sentinel, and a real gh by path answers with the sentinel`,
      rcOf(out, 'gh-rc') !== 0 && /refused/.test(z.stderr) && SENTINEL_RE.test(field(out, 'token') || '')
        && SENTINEL_RE.test(field(out, 'brew-token') || ''), `rc=${rcOf(out, 'gh-rc')} token=${field(out, 'token')} brew=${field(out, 'brew-token')}`);
    ok(`${label}: GH_PACKAGES_TOKEN is what agent-env.sh set, not what the owner's .zshrc made of gh auth token`,
      field(out, 'packages') === (withPackages ? PKG : 'unset'), field(out, 'packages'));
    ok(`${label}: no zsh started inside it gets the owner's gh, and the owner's token appears nowhere`,
      field(out, 'nested') === shimGh && !out.includes(OWNER), `nested=${field(out, 'nested')}`);
    ok(`${label}: the history file stays where the owner's is`,
      !(field(out, 'histfile') || '').startsWith(path.join(DIR, 'shim')), field(out, 'histfile'));
  }
})();

// ------------------------------------------------------ refusals (B1, R3) ----
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
    ['gh alias import', 'echo "tk: auth token" | gh alias import -'],
    // R3: a flag ahead of the command hides it from a check of $1 alone.
    ['gh --help=false auth token (a flag ahead of the command)', 'gh --help=false auth token'],
    ['gh --help=false auth token --user <owner>', 'gh --help=false auth token --user rodrigolmiranda'],
    ['gh --help=false alias set', 'gh --help=false alias set tk "auth token"'],
    ['gh --version=false auth token', 'gh --version=false auth token'],
    ['gh -- auth token', 'gh -- auth token'],
    ['gh --help auth token (a root flag, but not on its own)', 'gh --help auth token'],
    ['gh alias --help=false set (a flag ahead of the subcommand)', 'gh alias --help=false set tk "auth token"'],
  ]) {
    fs.writeFileSync(ghLog, '');
    const r = inChild(printed, `${cmd}; echo "gh-rc=$?"`);
    ok(`${what} is refused in a grandchild and never reaches the real gh`,
      rcOf(r.stdout, 'gh-rc') !== 0 && /refused/.test(r.stderr) && ghRuns().length === 0,
      `rc=${rcOf(r.stdout, 'gh-rc')} real-gh=${JSON.stringify(ghRuns().map((g) => g.args))} ${r.stderr.trim().split('\n').pop()}`);
  }
  for (const [what, cmd, args] of [
    ['a plain gh auth status', 'gh auth status', 'auth status'],
    ['gh --help on its own', 'gh --help', '--help'],
    ['gh -h on its own', 'gh -h', '-h'],
    ['gh --version on its own', 'gh --version', '--version'],
    ['gh alias list', 'gh alias list', 'alias list'],
    ['a flag after the command (gh pr list --state open)', 'gh pr list --state open', 'pr list --state open'],
  ]) {
    fs.writeFileSync(ghLog, '');
    const s = inChild(printed, `${cmd}; echo "gh-rc=$?"`);
    ok(`${what} still runs`, rcOf(s.stdout, 'gh-rc') === 0 && ghRuns().length === 1 && ghRuns()[0].args.join(' ') === args,
      `${JSON.stringify(ghRuns().map((g) => g.args))} ${s.stderr.trim()}`);
  }
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
  const COMMIT_CMD = `git -C ${JSON.stringify(repo)} -c user.name=Owner -c user.email=owner@example.com commit -q --allow-empty -m x; echo "commit-rc=$?"`;
  for (const [what, setup, name] of [
    ['its gh directory holds a login (hosts.yml)', () => { fs.mkdirSync(path.join(DIR, 'gh'), { recursive: true }); fs.writeFileSync(path.join(DIR, 'gh', 'hosts.yml'), 'github.com: {}\n'); }, NAME],
    ['the App was never created (no app.json)', () => fs.rmSync(path.join(DIR, 'app.json')), NAME],
    ['the identity is unknown', () => {}, 'mm-nobody'],
  ]) {
    fresh();
    setup();
    const r = agentEnv(owner, name);
    ok(`agent-env.sh exits non-zero when ${what}`, r.status !== 0, `status ${r.status}`);
    const c = inChild(r.stdout, `echo "tokens=\${GH_TOKEN-unset}/\${GITHUB_TOKEN-unset}/\${GH_PACKAGES_TOKEN-unset}"; gh api user; echo "gh-rc=$?"; ${CRED}; ${COMMIT_CMD}`, owner);
    const toks = (field(c.stdout, 'tokens') || '').split('/');
    ok(`...and what it printed leaves no identity: the sentinel, gh, git and commits refuse, the eval fails (${what})`,
      SENTINEL_RE.test(toks[0] || '') && toks[1] === 'unset' && toks[2] === 'unset'
        && rcOf(c.stdout, 'gh-rc') !== 0 && ghRuns().length === 0
        && rcOf(c.stdout, 'git-rc') !== 0 && !/password=./.test(c.stdout) && rcOf(c.stdout, 'commit-rc') !== 0
        && rcOf(c.stderr, 'eval-rc') !== 0,
      `${c.stdout.trim().split('\n').join(' | ')} || eval-rc=${rcOf(c.stderr, 'eval-rc')}`);
  }

  // The same, where the shell has an alias named gh.
  fresh();
  fs.rmSync(path.join(DIR, 'app.json'));
  const printed = agentEnv(owner).stdout;
  const probe = 'echo "tokens=${GH_TOKEN-unset}/${GH_PACKAGES_TOKEN-unset}"; eval "gh api user"; echo "gh-rc=$?"';
  for (const [shell, args] of [
    ['zsh', ['-c', `alias gh="echo ALIAS"; eval "$1"; echo "eval-rc=$?"; ${probe}`, '_', printed]],
    ['bash (aliases on, as when interactive)', ['-c', `shopt -s expand_aliases; alias gh="echo ALIAS"; eval "$1"; echo "eval-rc=$?"; ${probe}`, '_', printed]],
  ]) {
    const bin = shell.startsWith('zsh') ? 'zsh' : BASH;
    if (bin === 'zsh' && !zshOrSkip('a failed run under zsh with an alias named gh')) continue;
    const a = spawnSync(bin, args, { env: env(owner), encoding: 'utf8' });
    const t = (field(a.stdout, 'tokens') || '').split('/');
    ok(`under ${shell} with an alias named gh, what a failed run printed still leaves no identity`,
      SENTINEL_RE.test(t[0] || '') && t[1] === 'unset' && rcOf(a.stdout, 'gh-rc') !== 0 && rcOf(a.stdout, 'eval-rc') !== 0 && !/ALIAS/.test(a.stdout),
      (a.stdout + a.stderr).trim().split('\n').join(' | '));
  }

  // R1 for the no-identity environment: a zsh login shell keeps its refusing gh first.
  if (zshOrSkip('a failed run keeps its refusing gh first in a zsh login shell')) {
    fs.writeFileSync(ghLog, '');
    const z = inZsh(printed, '-lic', `print -r -- "gh=$(command -v gh)"; gh api user; print -r -- "gh-rc=$?"; print -r -- "brew-token=$(${JSON.stringify(path.join(brewBin, 'gh'))} auth token)"`, owner);
    ok('a failed run keeps its refusing gh first in a zsh login shell, and a real gh by path answers with the sentinel',
      field(z.stdout, 'gh') === path.join(ROOT, 'locked', 'bin', 'gh') && rcOf(z.stdout, 'gh-rc') !== 0 && ghRuns().length === 0
        && SENTINEL_RE.test(field(z.stdout, 'brew-token') || ''),
      `${z.stdout.trim().split('\n').join(' | ')} ${z.stderr.trim().split('\n').slice(-1)}`);
  }
})();

// ------------------------------------------ R6: GH_PACKAGES_TOKEN from a file ----
(function packagesToken() {
  const owner = { GH_TOKEN: OWNER, GITHUB_TOKEN: OWNER, GH_PACKAGES_TOKEN: OWNER };
  const other = path.join(root, 'elsewhere-token');
  for (const [what, setup, exported] of [
    ['a 0600 file holding a classic token', () => fs.writeFileSync(PACKAGES, `${PKG}\n`, { mode: 0o600 }), true],
    ['no file', () => {}, false],
    ['a world-readable file (0644)', () => { fs.writeFileSync(PACKAGES, `${PKG}\n`); fs.chmodSync(PACKAGES, 0o644); }, false],
    ['a group-readable file (0640)', () => { fs.writeFileSync(PACKAGES, `${PKG}\n`); fs.chmodSync(PACKAGES, 0o640); }, false],
    ['a file holding a gh login token (gho_), not a classic token', () => fs.writeFileSync(PACKAGES, `${OWNER}\n`, { mode: 0o600 }), false],
    ['a file holding two lines', () => fs.writeFileSync(PACKAGES, `${PKG}\n${PKG}\n`, { mode: 0o600 }), false],
    ['a symbolic link to a 0600 file', () => { fs.writeFileSync(other, `${PKG}\n`, { mode: 0o600 }); fs.symlinkSync(other, PACKAGES); }, false],
  ]) {
    fresh();
    fs.rmSync(other, { force: true });
    setup();
    const r = agentEnv(owner);
    const c = inChild(r.stdout, 'echo "packages=${GH_PACKAGES_TOKEN-unset}"', owner);
    const hint = r.stderr.split('\n').filter((l) => /GH_PACKAGES_TOKEN/.test(l));
    ok(`packages token, ${what}: agent-env.sh succeeds and never prints the token`,
      r.status === 0 && !r.stdout.includes(PKG) && !r.stderr.includes(PKG), `status ${r.status}`);
    ok(exported ? `packages token, ${what}: exported as GH_PACKAGES_TOKEN, with no hint`
      : `packages token, ${what}: GH_PACKAGES_TOKEN is unset, with a one-line hint`,
    exported ? field(c.stdout, 'packages') === PKG && hint.length === 0
      : field(c.stdout, 'packages') === 'unset' && hint.length === 1,
    `packages=${field(c.stdout, 'packages')} hint=${JSON.stringify(hint)}`);
  }
  fs.rmSync(other, { force: true });
})();

// --------------------------------- the launcher runs copies, not the checkout ----
(function launcher() {
  fresh();
  canonTest('head');
  const printed = agentEnv().stdout;
  const shim = SHIM();
  const launcherText = readOr(path.join(shim, 'bin', 'gh'));
  ok('the launcher runs copies kept under ~/.config/mm-agent/<name>/shim/<commit>/, not the checkout',
    launcherText.includes(path.join(shim, 'libexec', 'gh-shim.sh')) && !launcherText.includes(src), launcherText.trim());
  ok('the copies are exactly the committed gh-shim.sh and app-token.sh',
    ['gh-shim.sh', 'app-token.sh'].every((f) => readOr(path.join(shim, 'libexec', f), null)
      === git(src, 'show', `HEAD:governance/identity/${f}`) + '\n'), listOr(path.join(shim, 'libexec')).join(','));
  ok('the helpers are not on PATH: only gh is in the directory PATH gets',
    listOr(path.join(shim, 'bin')).join(',') === 'gh', listOr(path.join(shim, 'bin')).join(','));
  const helper = inChild(printed, 'git config --get-all credential.https://github.com.helper | tail -1');
  ok('the git credential helper also runs the copy', helper.stdout.includes(path.join(shim, 'libexec', 'app-token.sh')) && !helper.stdout.includes(src), helper.stdout.trim());

  // The checkout changes under a running session: it keeps its copies.
  const shimFile = path.join(IDENTITY, 'gh-shim.sh');
  const original = fs.readFileSync(shimFile);
  fs.writeFileSync(shimFile, '#!/usr/bin/env bash\nREAL="$2"; shift 2; exec "$REAL" "$@"\n');
  fs.writeFileSync(ghLog, '');
  let t = inChild(printed, 'gh auth token; echo "gh-rc=$?"');
  ok('a checkout that changes after the eval does not change the session: gh auth token is still refused',
    rcOf(t.stdout, 'gh-rc') !== 0 && ghRuns().length === 0, `rc=${rcOf(t.stdout, 'gh-rc')} ${JSON.stringify(ghRuns())}`);
  fs.writeFileSync(shimFile, original);

  fs.renameSync(src, `${src}.moved`);
  fs.writeFileSync(ghLog, '');
  t = inChild(printed, 'gh api user; echo "gh-rc=$?"');
  fs.renameSync(`${src}.moved`, src);
  ok('a checkout that is gone after the eval leaves the session working', rcOf(t.stdout, 'gh-rc') === 0 && ghRuns().length === 1,
    `${t.stdout.trim()} ${t.stderr.trim()}`);
})();

// ------------------------------------------- a dirty source is refused ----
(function dirtySource() {
  const rel = (f) => `governance/identity/${f}`;
  for (const [what, dirty] of [
    ['an uncommitted change to gh-shim.sh', () => fs.appendFileSync(path.join(IDENTITY, 'gh-shim.sh'), '# local\n')],
    ['an uncommitted change to app-token.sh', () => fs.appendFileSync(path.join(IDENTITY, 'app-token.sh'), '# local\n')],
    ['an uncommitted change to agent-env.sh', () => fs.appendFileSync(path.join(IDENTITY, 'agent-env.sh'), '# local\n')],
    ['a change hidden by git update-index --assume-unchanged', () => {
      git(src, 'update-index', '--assume-unchanged', rel('gh-shim.sh'));
      fs.appendFileSync(path.join(IDENTITY, 'gh-shim.sh'), '# hidden\n');
    }],
  ]) {
    fresh();
    dirty();
    const r = agentEnv();
    fs.writeFileSync(ghLog, '');
    const c = inChild(r.stdout, 'gh api user; echo "gh-rc=$?"');
    ok(`agent-env.sh refuses ${what}, installs nothing, and what it printed leaves no identity`,
      r.status !== 0 && /differs from commit/.test(c.stderr) && rcOf(c.stdout, 'gh-rc') !== 0 && ghRuns().length === 0
        && !fs.existsSync(path.join(DIR, 'shim')),
      `status ${r.status} ${c.stderr.trim().split('\n').slice(0, 2).join(' | ')}`);
    git(src, 'update-index', '--no-assume-unchanged', rel('gh-shim.sh'));
    git(src, 'checkout', '-q', '--', '.');
  }

  fresh();
  const loose = fs.mkdtempSync(path.join(root, 'loose-'));
  for (const f of SCRIPTS) fs.copyFileSync(path.join(IDENTITY, f), path.join(loose, f));
  const r = agentEnv({}, NAME, loose);
  const c = inChild(r.stdout, 'gh api user; echo "gh-rc=$?"');
  ok('agent-env.sh refuses to run from files outside a git checkout', r.status !== 0 && /not in a git checkout/.test(c.stderr)
    && rcOf(c.stdout, 'gh-rc') !== 0, `status ${r.status} ${c.stderr.trim().split('\n')[0]}`);
})();

// ------------------------------------ provenance: warn when not on test ----
(function provenance() {
  const warned = (r) => r.stderr.split('\n').filter((l) => /WARNING/.test(l));
  for (const [what, where, warn] of [
    ['on test', 'head', null],
    ['older than test (test has moved on, and this checkout has not fetched it)', 'ahead', null],
    ['not on test', 'elsewhere', /not on marvinamiranda\/\.github test/],
    ['unknown, because test cannot be read', 'gone', /could not be read/],
  ]) {
    fresh();
    canonTest(where);
    const r = agentEnv();
    const w = warned(r);
    ok(warn ? `a commit ${what}: agent-env.sh warns, once, and still sets the identity`
      : `a commit ${what}: agent-env.sh sets the identity with no warning`,
    r.status === 0 && (warn ? w.length === 1 && warn.test(w[0]) : w.length === 0),
    `status ${r.status} ${JSON.stringify(w)}`);
  }
  canonTest('head');
  fresh();
  agentEnv();
  const remembered = fs.existsSync(path.join(SHIM(), 'on-test'));
  canonTest('elsewhere');
  const again = agentEnv();
  ok('a commit found on test once is remembered, and not asked about again',
    remembered && again.status === 0 && warned(again).length === 0, `remembered=${remembered} ${JSON.stringify(warned(again))}`);

  // Every tool command opens with the eval, so a commit that is NOT on test
  // must not cost a network call each time: that verdict is kept 10 minutes.
  fresh();
  canonTest('elsewhere');
  agentEnv();
  canonTest('gone');
  const cached = agentEnv();
  ok('a commit found not on test is not asked about again within 10 minutes: the warning is repeated without reading test',
    cached.status === 0 && warned(cached).length === 1 && /not on marvinamiranda\/\.github test/.test(warned(cached)[0]), JSON.stringify(warned(cached)));
  const verdict = path.join(SHIM(), 'not-on-test');
  const [, ...rest] = readOr(verdict).split('\n');
  try { fs.writeFileSync(verdict, [String(now() - 601), ...rest].join('\n')); } catch (e) { /* no verdict was kept */ }
  const expired = agentEnv();
  ok('...and is asked again once 10 minutes have passed',
    expired.status === 0 && warned(expired).length === 1 && /could not be read/.test(warned(expired)[0]), JSON.stringify(warned(expired)));
  canonTest('head');
})();

// ---------------------- two sessions from two commits keep their own shims ----
(function isolation() {
  fresh();
  const printedA = agentEnv().stdout;
  fs.appendFileSync(path.join(IDENTITY, 'gh-shim.sh'), '# a later commit\n');
  git(src, 'commit', '-q', '-am', 'later');
  const B = git(src, 'rev-parse', 'HEAD');
  canonTest('head');
  const printedB = agentEnv().stdout;
  const a = inChild(printedA, 'command -v gh').stdout.trim();
  const b = inChild(printedB, 'command -v gh').stdout.trim();
  ok('two sessions evaluated from different commits each keep their own shim',
    a === path.join(SHIM(COMMIT), 'bin', 'gh') && b === path.join(SHIM(B), 'bin', 'gh'), `${a} / ${b}`);
  fs.writeFileSync(ghLog, '');
  const t = inChild(printedA, 'gh api user; echo "gh-rc=$?"');
  ok('...and the first still works after the second eval', rcOf(t.stdout, 'gh-rc') === 0 && ghRuns().length === 1, t.stderr.trim());
  git(src, 'reset', '-q', '--hard', COMMIT);
  canonTest('head');
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
