#!/usr/bin/env node
'use strict';

// governance/bootstrap.sh against a fake GitHub. A read-only stub `gh` first
// on PATH answers from fixtures, and records and refuses anything that would
// write. The script runs from a throwaway clone, and the canonical
// https://github.com/marvinamiranda/.github.git is a local bare repository
// (git's url.<local>.insteadOf), so its `test` branch is whatever a case says.
//
//   node governance/tests/bootstrap.test.js
//
// BOOTSTRAP_SCRIPT points it at another copy of bootstrap.sh, which is how a
// deliberately broken copy is shown to turn this suite red. BOOTSTRAP_BASH
// runs it under that bash (for example /bin/bash, macOS bash 3.2).

const { spawnSync, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SCRIPT = process.env.BOOTSTRAP_SCRIPT
  ? path.resolve(process.env.BOOTSTRAP_SCRIPT)
  : path.join(__dirname, '..', 'bootstrap.sh');
const BASH = process.env.BOOTSTRAP_BASH ? path.resolve(process.env.BOOTSTRAP_BASH) : 'bash';
const ORG = 'marvinamiranda';
const CANONICAL = `https://github.com/${ORG}/.github.git`;
const REVIEWER_ID = 5075711;

let failed = 0;
let total = 0;
function ok(name, condition, detail = '') {
  total += 1;
  if (condition) console.log(`ok - ${name}`);
  else { failed += 1; console.log(`not ok - ${name}${detail ? `: ${detail}` : ''}`); }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bootstrap-test-'));
const stubBin = path.join(root, 'bin');
const fixtureFile = path.join(root, 'fixtures.json');
const ghLog = path.join(root, 'gh.log');
const cfg = path.join(root, 'cfg');
const reviewerJson = path.join(root, 'reviewer-app.json');
fs.mkdirSync(stubBin);
fs.mkdirSync(path.join(root, 'home'));
fs.mkdirSync(path.join(cfg, 'prod'), { recursive: true });
fs.writeFileSync(path.join(cfg, 'prod', 'areas.txt'), 'core|Everything in this test repository\n#   path: **\n');
fs.writeFileSync(path.join(cfg, 'prod', 'required-checks.txt'), 'build\n');
fs.writeFileSync(reviewerJson, JSON.stringify({ id: REVIEWER_ID, slug: 'fake-reviewer' }));

// gh: `gh api [--paginate] <path> [--jq <expr>]` and `gh auth status` read
// fixtures; everything else, and any api call with a method or a body, is a
// write: recorded, and refused with exit 99.
fs.writeFileSync(path.join(stubBin, 'gh'), `#!/usr/bin/env node
const fs = require('fs');
const { execFileSync } = require('child_process');
const args = process.argv.slice(2);
const log = (kind) => fs.appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify({ kind, args }) + '\\n');
const fixtures = JSON.parse(fs.readFileSync(process.env.FAKE_GH_FIXTURES, 'utf8'));
if (args[0] === 'auth' && args[1] === 'status') {
  log('read');
  process.stderr.write("github.com\\n  - Token scopes: " + (process.env.FAKE_GH_SCOPES || "'admin:org', 'project', 'repo', 'workflow'") + "\\n");
  process.exit(0);
}
if (args[0] !== 'api') { log('write'); process.exit(99); }
let jq = null, target = null;
for (let i = 1; i < args.length; i++) {
  const a = args[i];
  if (['-X', '--method', '-f', '-F', '--field', '--raw-field', '--input'].includes(a) || /^--(method|input|field|raw-field)=/.test(a)) { log('write'); process.exit(99); }
  if (a === '--jq') jq = args[++i];
  else if (a === '-H') i++;
  else if (a === '--paginate') {}
  else target = a;
}
log('read');
if (!(target in fixtures)) { process.stderr.write('gh: Not Found (HTTP 404)\\n'); process.exit(1); }
const body = JSON.stringify(fixtures[target]);
process.stdout.write(jq ? execFileSync('jq', ['-r', jq], { input: body }) : body + '\\n');
`, { mode: 0o755 });

function labelsFromScript() {
  // The standard labels, exactly as bootstrap.sh defines them, plus the area.
  const src = fs.readFileSync(SCRIPT, 'utf8');
  const labels = [];
  for (const m of src.matchAll(/^\s+"([^|"]+)\|([0-9a-f]{6})\|([^"]*)"$/gm)) labels.push({ name: m[1], color: m[2], description: m[3] });
  labels.push({ name: 'area:core', color: '1d76db', description: 'Everything in this test repository' });
  return labels;
}
function fixtures(extra = {}) {
  const repo = (name) => ({ name, full_name: `${ORG}/${name}`, default_branch: 'test' });
  return {
    [`user/1245936`]: { login: 'rodrigolmiranda', id: 1245936 },
    user: { login: 'rodrigolmiranda', id: 1245936 },
    [`orgs/${ORG}/issue-types`]: ['Task', 'Bug', 'Epic', 'Decision', 'Spike'].map((name, id) => ({ id, name, is_enabled: true })),
    [`repos/${ORG}/prod`]: repo('prod'),
    [`repos/${ORG}/prod/labels?per_page=100`]: labelsFromScript(),
    [`repos/${ORG}/prod/branches/test`]: { name: 'test', commit: { sha: '1'.repeat(40) } },
    [`repos/${ORG}/.github/branches/test`]: { name: 'test', commit: { sha: '2'.repeat(40) } },
    [`repos/${ORG}/prod/rulesets?includes_parents=true&per_page=100`]: [],
    [`repos/${ORG}/.github/rulesets?includes_parents=true&per_page=100`]: [],
    ...extra,
  };
}

// A clone holding bootstrap.sh, and the canonical repository it is checked
// against. `on`: 'head' (test is this commit), 'ahead' (test has a later
// commit), 'elsewhere' (test is an unrelated commit), 'missing' (no canonical).
function checkout(on) {
  const dir = fs.mkdtempSync(path.join(root, 'co-'));
  const canon = path.join(dir, 'canon.git');
  const work = path.join(dir, 'work');
  const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { stdio: 'pipe' }).toString().trim();
  fs.mkdirSync(path.join(work, 'governance'), { recursive: true });
  fs.copyFileSync(SCRIPT, path.join(work, 'governance', 'bootstrap.sh'));
  fs.chmodSync(path.join(work, 'governance', 'bootstrap.sh'), 0o755);
  git(root, 'init', '-q', work);
  git(work, 'add', '.');
  git(work, 'commit', '-q', '-m', 'bootstrap');
  if (on !== 'missing') {
    git(root, 'init', '-q', '--bare', canon);
    git(canon, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
    if (on === 'head') git(work, 'push', '-q', canon, 'HEAD:refs/heads/test');
    if (on === 'ahead') {
      git(work, 'commit', '-q', '--allow-empty', '-m', 'later');
      git(work, 'push', '-q', canon, 'HEAD:refs/heads/test');
      git(work, 'reset', '-q', '--hard', 'HEAD~1');
    }
    if (on === 'elsewhere') {
      const branch = git(work, 'rev-parse', '--abbrev-ref', 'HEAD');
      git(work, 'checkout', '-q', '--orphan', 'other');
      git(work, 'commit', '-q', '--allow-empty', '-m', 'unrelated');
      git(work, 'push', '-q', canon, 'HEAD:refs/heads/test');
      git(work, 'checkout', '-q', '-f', branch);
      git(work, 'branch', '-q', '-D', 'other');
    }
  }
  return { script: path.join(work, 'governance', 'bootstrap.sh'), canon, work };
}

// `repo: false` runs without the default `--repo prod --config-dir <cfg>`.
function bootstrap(args, { on = 'head', reviewer = true, fx = fixtures(), where = null, repo = true, extraEnv = {} } = {}) {
  const co = where || checkout(on);
  fs.writeFileSync(fixtureFile, JSON.stringify(fx));
  fs.writeFileSync(ghLog, '');
  const r = spawnSync(BASH, [co.script, ...(repo ? ['--repo', 'prod', '--config-dir', cfg] : []), ...args], {
    encoding: 'utf8',
    env: {
      ...extraEnv,
      PATH: [stubBin, process.env.PATH].join(':'),
      HOME: path.join(root, 'home'),
      TMPDIR: root,
      LANG: 'C',
      FAKE_GH_FIXTURES: fixtureFile,
      FAKE_GH_LOG: ghLog,
      MM_REVIEWER_APP_JSON: reviewer ? reviewerJson : path.join(root, 'no-such-reviewer.json'),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: `url.${co.canon}.insteadOf`,
      GIT_CONFIG_VALUE_0: CANONICAL,
    },
  });
  const calls = fs.readFileSync(ghLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return { ...r, calls, writes: calls.filter((c) => c.kind === 'write'), co };
}
const tail = (r) => `exit ${r.status}; ${(r.stderr || '').trim().split('\n').slice(-2).join(' | ')}`;
const started = (r) => /== a\) Organisation issue types/.test(r.stdout);

// The ruleset payloads a dry run prints, by repository and name.
function planned(stdout) {
  const out = {};
  const re = /DRY-RUN would run: gh api -X (POST|PUT) repos\/[^/]+\/([^/\s]+)\/rulesets\S* --input - <<JSON\n([\s\S]*?)\n\s*JSON\n/g;
  for (const m of stdout.matchAll(re)) {
    try { const body = JSON.parse(m[3]); if (body.name) out[`${m[2]}/${body.name}`] = { method: m[1], body }; } catch (e) { /* not a ruleset body */ }
  }
  return out;
}
const pr = (rs) => (rs.rules.find((r) => r.type === 'pull_request') || {}).parameters || {};
const checks = (rs) => ((rs.rules.find((r) => r.type === 'required_status_checks') || {}).parameters || {}).required_status_checks || [];

// ------------------------------------------------ N6: the Reviewer App id ----
{
  let r = bootstrap([], { reviewer: false });
  ok('without a Reviewer App id, a run with rulesets aborts before it reads or plans anything',
    r.status !== 0 && /Reviewer App/.test(r.stderr) && !started(r) && r.calls.length === 0, tail(r));
  r = bootstrap(['--apply'], { reviewer: false });
  ok('...and so does --apply, before any write', r.status !== 0 && /Reviewer App/.test(r.stderr) && r.writes.length === 0 && !started(r), tail(r));
  r = bootstrap(['--no-rulesets'], { reviewer: false });
  ok('without a Reviewer App id, --no-rulesets still runs (no ruleset needs it)',
    r.status === 0 && /0 change\(s\) planned/.test(r.stdout), tail(r));
}

// ------------------------------------ N2: --apply only from a commit on test ----
{
  let r = bootstrap(['--no-rulesets', '--apply'], { on: 'elsewhere' });
  ok('--apply refuses a commit that is not on test as fetched now, before any gh call',
    r.status !== 0 && /Refusing --apply/.test(r.stderr) && /not on marvinamiranda\/\.github test/.test(r.stderr) && r.calls.length === 0, tail(r));
  r = bootstrap(['--no-rulesets', '--apply'], { on: 'head' });
  ok('--apply runs from the commit test points at', r.status === 0 && /0 change\(s\) applied/.test(r.stdout) && r.writes.length === 0, tail(r));
  r = bootstrap(['--no-rulesets', '--apply'], { on: 'ahead' });
  ok('--apply runs from an older commit of test', r.status === 0 && /0 change\(s\) applied/.test(r.stdout), tail(r));
  r = bootstrap(['--no-rulesets'], { on: 'elsewhere' });
  ok('a dry run from a commit not on test warns and carries on',
    r.status === 0 && /WARNING: .*not on marvinamiranda\/\.github test.*--apply would refuse/.test(r.stdout), tail(r));
  r = bootstrap(['--no-rulesets', '--apply'], { on: 'missing' });
  ok('--apply refuses when test cannot be read', r.status !== 0 && /Refusing --apply/.test(r.stderr) && r.calls.length === 0, tail(r));

  const co = checkout('head');
  fs.appendFileSync(co.script, '# a local edit\n');
  r = bootstrap(['--no-rulesets', '--apply'], { where: co });
  ok('--apply refuses a checkout with uncommitted changes', r.status !== 0 && /uncommitted/.test(r.stderr) && r.calls.length === 0, tail(r));

  const loose = fs.mkdtempSync(path.join(root, 'loose-'));
  fs.mkdirSync(path.join(loose, 'governance'));
  fs.copyFileSync(SCRIPT, path.join(loose, 'governance', 'bootstrap.sh'));
  r = bootstrap(['--no-rulesets', '--apply'], { where: { script: path.join(loose, 'governance', 'bootstrap.sh'), canon: path.join(root, 'none.git') } });
  ok('--apply refuses to run from outside a git checkout', r.status !== 0 && /Refusing --apply/.test(r.stderr) && r.calls.length === 0, tail(r));
}

// ------------------------------------------------------- the rulesets ----
{
  const r = bootstrap([]);
  const plan = planned(r.stdout);
  const t = plan['prod/test-integration'];
  const m = plan['prod/main-checks'];
  const self = plan['.github/test-integration'];
  ok('a dry run with rulesets plans them', r.status === 0 && t && m && self, `${tail(r)} planned=${Object.keys(plan)}`);
  ok('test-integration allows squash, and merge commits (to bring main back into test after a hotfix)',
    t && JSON.stringify([...pr(t.body).allowed_merge_methods].sort()) === '["merge","squash"]', t && JSON.stringify(pr(t.body).allowed_merge_methods));
  ok('main-checks still allows merge commits only', m && JSON.stringify(pr(m.body).allowed_merge_methods) === '["merge"]', m && JSON.stringify(pr(m.body).allowed_merge_methods));
  ok('.github\'s own test-integration requires governance tests and review/independent pinned to the Reviewer App',
    self && checks(self.body).some((c) => c.context === 'governance tests' && c.integration_id === 15368)
      && checks(self.body).some((c) => c.context === 'review/independent' && c.integration_id === REVIEWER_ID),
    self && JSON.stringify(checks(self.body)));

  if (t) {
    // What GitHub would return for the same ruleset, methods in another order.
    const existing = { ...t.body, id: 7, source_type: 'Repository',
      rules: t.body.rules.map((x) => (x.type === 'pull_request' ? { ...x, parameters: { ...x.parameters, allowed_merge_methods: ['merge', 'squash'] } } : x)) };
    let again = bootstrap([], { fx: fixtures({
      [`repos/${ORG}/prod/rulesets?includes_parents=true&per_page=100`]: [{ id: 7, name: 'test-integration', source_type: 'Repository' }],
      [`repos/${ORG}/prod/rulesets/7`]: existing }) });
    ok('an existing test-integration listing the same methods in another order is up to date (no PUT)',
      /Ruleset test-integration: up to date\./.test(again.stdout) && !planned(again.stdout)['prod/test-integration'], tail(again));

    const noMethods = { ...existing, rules: existing.rules.map((x) => (x.type === 'pull_request'
      ? { ...x, parameters: Object.fromEntries(Object.entries(x.parameters).filter(([k]) => k !== 'allowed_merge_methods')) } : x)) };
    again = bootstrap([], { fx: fixtures({
      [`repos/${ORG}/prod/rulesets?includes_parents=true&per_page=100`]: [{ id: 7, name: 'test-integration', source_type: 'Repository' }],
      [`repos/${ORG}/prod/rulesets/7`]: noMethods }) });
    ok('an existing test-integration with no allowed_merge_methods (GitHub\'s default: all three) differs, and is updated',
      again.status === 0 && /Ruleset test-integration \(id 7\) differs/.test(again.stdout)
        && planned(again.stdout)['prod/test-integration'] && planned(again.stdout)['prod/test-integration'].method === 'PUT', tail(again));
  }
}

// ---------------------------------------------- N5: probe without rulesets ----
{
  const r = bootstrap(['--probe', '--no-rulesets']);
  ok('--probe --no-rulesets plans the Reviewer App probe on each repository and no ruleset',
    r.status === 0 && /would post, as the Reviewer App \(5075711\): review\/independent=neutral on prod/.test(r.stdout)
      && /would post, as the Reviewer App \(5075711\): review\/independent=neutral on \.github/.test(r.stdout)
      && /== e\) Rulesets\n\s+skipped \(--no-rulesets\)/.test(r.stdout) && Object.keys(planned(r.stdout)).length === 0, tail(r));
}

// ------------------------------- R4: this repository's rulesets, on their own ----
{
  const touchesProd = (r) => r.calls.some((c) => c.args.some((a) => /\/prod(\/|$|\?)/.test(a)));
  let r = bootstrap(['--self-only'], { repo: false });
  const plan = planned(r.stdout);
  ok('--self-only needs no --repo and plans exactly this repository\'s three rulesets',
    r.status === 0 && JSON.stringify(Object.keys(plan).sort()) === JSON.stringify(['.github/main-checks', '.github/main-owner-only', '.github/test-integration']),
    `${tail(r)} planned=${Object.keys(plan)}`);
  ok('--self-only reads no product repository and skips issue types, default branches and labels',
    r.status === 0 && !touchesProd(r) && !r.calls.some((c) => c.args.includes(`orgs/${ORG}/issue-types`))
      && /== a\) Organisation issue types\n\s+skipped \(--self-only\)/.test(r.stdout),
    `${tail(r)} calls=${JSON.stringify(r.calls.map((c) => c.args.join(' ')))}`);
  const self = plan['.github/test-integration'];
  ok('--self-only: test-integration requires governance tests and review/independent from the Reviewer App',
    self && checks(self.body).some((c) => c.context === 'governance tests' && c.integration_id === 15368)
      && checks(self.body).some((c) => c.context === 'review/independent' && c.integration_id === REVIEWER_ID), self && JSON.stringify(checks(self.body)));

  for (const [what, args, says] of [
    ['--self-only with a --repo', ['--self-only', '--repo', 'prod'], /--self-only .*takes no --repo/],
    ['--self-only with --no-rulesets', ['--self-only', '--no-rulesets'], /--self-only applies rulesets/],
    ['--self-only with --project', ['--self-only', '--project', '--project-title', 'x'], /--self-only takes no --project/],
  ]) {
    r = bootstrap(args, { repo: false });
    ok(`${what} is a usage error, before any gh call`, r.status === 2 && says.test(r.stderr) && !/Unknown argument/.test(r.stderr) && r.calls.length === 0, tail(r));
  }
  r = bootstrap([], { repo: false });
  ok('no --repo and no --self-only is a usage error that names --self-only',
    r.status === 2 && /At least one --repo is required, or --self-only/.test(r.stderr) && r.calls.length === 0, tail(r));
  r = bootstrap(['--self-only'], { repo: false, reviewer: false });
  ok('--self-only without a Reviewer App id aborts before any gh call',
    r.status === 1 && /No Reviewer App id, so no rulesets/.test(r.stderr) && !/Unknown argument/.test(r.stderr) && r.calls.length === 0, tail(r));
  r = bootstrap(['--self-only', '--apply'], { repo: false, on: 'elsewhere' });
  ok('--self-only --apply refuses a commit that is not on test, before any gh call',
    r.status !== 0 && /Refusing --apply/.test(r.stderr) && r.calls.length === 0, tail(r));

  // --apply once this repository's rulesets are as planned: nothing to write.
  const listed = [];
  const extra = {};
  Object.values(plan).forEach(({ body }, i) => {
    listed.push({ id: 100 + i, name: body.name, source_type: 'Repository' });
    extra[`repos/${ORG}/.github/rulesets/${100 + i}`] = { ...body, id: 100 + i, source_type: 'Repository' };
  });
  extra[`repos/${ORG}/.github/rulesets?includes_parents=true&per_page=100`] = listed;
  r = bootstrap(['--self-only', '--apply'], { repo: false, fx: fixtures(extra) });
  ok('--self-only --apply from a commit on test, with the rulesets in place: up to date, nothing written',
    r.status === 0 && /0 change\(s\) applied/.test(r.stdout) && r.writes.length === 0 && (r.stdout.match(/up to date\./g) || []).length === 3, tail(r));

  r = bootstrap(['--self-only', '--probe'], { repo: false });
  ok('--self-only --probe plans the probe on this repository alone',
    r.status === 0 && /review\/independent=neutral on \.github/.test(r.stdout) && !/neutral on prod/.test(r.stdout), tail(r));

  // In a run with --repo too, this repository's rulesets come first.
  r = bootstrap([]);
  const order = [...r.stdout.matchAll(/^\s+\[([^\]]+)\]$/gm)].map((m) => m[1]);
  const rulesetsAt = r.stdout.indexOf('== e) Rulesets');
  const inE = [...r.stdout.slice(rulesetsAt).matchAll(/^\s+\[([^\]]+)\]$/gm)].map((m) => m[1]);
  ok('a run with --repo applies this repository\'s rulesets before any product repository\'s',
    r.status === 0 && inE[0] === '.github' && inE.includes('prod'), `${tail(r)} order=${JSON.stringify(inE)} all=${JSON.stringify(order)}`);
}

// -------------------------------------- the credential for --apply ----
{
  // Advice to ADD a scope to the gh login (gh auth refresh ... -s <scope>).
  const addsScope = /gh auth refresh\b[^\n]*\s-s\s/;
  const noRefresh = (r) => !addsScope.test(r.stdout + r.stderr);
  let r = bootstrap(['--no-rulesets'], { extraEnv: { GH_TOKEN: 'github_pat_FAKE' } });
  ok('a fine-grained token in GH_TOKEN is named as such, with no scope warning (it has no scopes)',
    r.status === 0 && /fine-grained/.test(r.stdout) && !/WARNING/.test(r.stdout) && noRefresh(r), tail(r));
  r = bootstrap(['--no-rulesets', '--apply']);
  ok('--apply on the keyring login warns: a one-day fine-grained token as GH_TOKEN, never admin:org on the keyring login',
    r.status === 0 && /WARNING: .*keyring/.test(r.stdout) && /fine-grained/.test(r.stdout) && /admin:org/.test(r.stdout) && noRefresh(r), tail(r));
  r = bootstrap(['--no-rulesets'], { extraEnv: { FAKE_GH_SCOPES: "'repo'" } });
  ok('a dry run never advises adding admin:org to the gh login', r.status === 0 && noRefresh(r), tail(r));

  const help = spawnSync(BASH, [SCRIPT, '--help'], { encoding: 'utf8' });
  const text = help.stdout;
  ok('--help lists the fine-grained token\'s permissions for each step',
    help.status === 0 && /fine-grained/i.test(text) && /Issue Types: read and write/.test(text) && /Administration: read and write/.test(text)
      && /Contents: read/.test(text) && /Issues: read and write/.test(text) && /Projects: read and write/.test(text) && /Metadata: read/.test(text)
      && /Reviewer App/.test(text) && !addsScope.test(text), text.slice(0, 200));
  ok('--help says --no-rulesets (and every product step) runs after the adoption pull request has merged, and names --self-only',
    /--no-rulesets[\s\S]{0,300}after[\s\S]{0,60}adoption\s+pull\s+request\s+has\s+merged/.test(text) && /--self-only/.test(text)
      && !/stage an adoption/.test(text), '');
}

fs.rmSync(root, { recursive: true, force: true });
console.log(`\n${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
