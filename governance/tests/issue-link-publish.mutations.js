#!/usr/bin/env node
'use strict';

// Mutation proof for issue-link-publish.test.js: each mutant is a deliberately
// broken copy of the workflow, and the suite must go red on it. A mutant that
// leaves the suite green means the suite cannot see that mistake.
//
//   node governance/tests/issue-link-publish.mutations.js

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const SOURCE = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'issue-link-publish.yml'), 'utf8');
const TEST = path.join(__dirname, 'issue-link-publish.test.js');
const MINT_KEY = "          private-key: ${{ secrets.CHECKS_APP_PRIVATE_KEY }}\n";

// [name, [from, to]] -- `from` must occur exactly once in the workflow.
const mutants = [
  ['repositories: removed from the mint (a token for every repository)', ["          repositories: ${{ github.event.repository.name }}\n", '']],
  ['permission-checks removed from the mint (every permission the App has)', ["          permission-checks: write\n", '']],
  ['a second permission requested by the mint', ["          permission-checks: write\n", "          permission-checks: write\n          permission-contents: write\n"]],
  ['the event guard removed (any event mints a token)', ["    if: github.event_name == 'workflow_run' && github.event.workflow_run.event == 'pull_request'\n", '']],
  ['the event guard widened to every workflow_run', ["github.event.workflow_run.event == 'pull_request'", "github.event.workflow_run.event != ''"]],
  ['posting through github.rest.checks.create', ["await github.request('POST /repos/{owner}/{repo}/check-runs', {", "await github.rest.checks.create({"]],
  ['posting with the GITHUB_TOKEN (the post step loses the minted token)', ["          github-token: ${{ steps.checks-app.outputs.token }}\n", '']],
  ['posting with the GITHUB_TOKEN named explicitly', ["          github-token: ${{ steps.checks-app.outputs.token }}\n", "          github-token: ${{ github.token }}\n"]],
  ['a runs-on default of ubuntu-latest', ["        type: string\n        required: true\n      governance-ref:", "        type: string\n        required: true\n        default: '\"ubuntu-latest\"'\n      governance-ref:"]],
  ['a hosted label in the job', ["runs-on: ${{ fromJSON(inputs.runs-on) }}", "runs-on: ubuntu-latest"]],
  ['checks: write granted to the job', ["      contents: read\n      issues: read\n      pull-requests: read\n    steps:", "      checks: write\n      contents: read\n      issues: read\n      pull-requests: read\n    steps:"]],
  ['the environment removed (the key is not released)', ["    environment:\n      name: governance-checks\n", "    environment:\n      name: other\n"]],
  ['deployment: false removed', ["      deployment: false\n", '']],
  ['the pull request head checked out', ["          repository: marvinamiranda/.github\n          ref: ${{ inputs.governance-ref }}\n", "          ref: ${{ github.event.workflow_run.head_sha }}\n"]],
  ['the caller repository checked out beside the matcher', ["      # Holds only the read GITHUB_TOKEN.", "      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4\n        with:\n          persist-credentials: false\n\n      # Holds only the read GITHUB_TOKEN."]],
  ['a run: step added', ["      - name: Fetch the shared matcher\n", "      - name: Echo the title\n        run: echo \"${{ github.event.workflow_run.head_commit.message }}\"\n\n      - name: Fetch the shared matcher\n"]],
  ['an expression inside a script', ["const number = listed.length > 0 ? listed[0].number : undefined;", "const number = listed.length > 0 ? listed[0].number : ${{ github.event.workflow_run.id }};"]],
  ['an action pinned to a tag', ["actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1 # v3.2.0", "actions/create-github-app-token@v3"]],
  ['the pin check dropped from the judge order (fetch runs without the pin)', ["        if: steps.pin.outputs.ok == 'true'\n        uses: actions/checkout", "        uses: actions/checkout"]],
  ['the mint runs without a verdict', ["        if: steps.pin.outputs.ok == 'true' && steps.judge.outputs.judged == 'true'\n        uses: actions/create-github-app-token", "        if: steps.pin.outputs.ok == 'true'\n        uses: actions/create-github-app-token"]],
  ['the key handed to the judge step', ["        if: steps.pin.outputs.ok == 'true'\n        uses: actions/github-script@f28e40c7f34bde8b3046d885e986cb6290c5673b # v7\n        with:\n          script: |\n            const fs = require('fs');\n            const path = require('path');\n            const lib", "        if: steps.pin.outputs.ok == 'true'\n        uses: actions/github-script@f28e40c7f34bde8b3046d885e986cb6290c5673b # v7\n        with:\n          github-token: ${{ secrets.CHECKS_APP_PRIVATE_KEY }}\n          script: |\n            const fs = require('fs');\n            const path = require('path');\n            const lib"]],
  ['the verify-pin block drifts from pr-governance.yml', ["if (ref !== self) {", "if (ref === '') {"]],
  ['a failed pin posts a check instead of failing the job', ["              core.setFailed(problem);\n", "              await github.request('POST /repos/{owner}/{repo}/check-runs', { name: 'governance/issue-link', head_sha: 'x', conclusion: 'success' });\n"]],
  ['a judge error is swallowed (no failure verdict)', ["                ok: false,\n                title: 'The issue-link judge could not run',", "                ok: true,\n                title: 'The issue-link judge could not run',"]],
  ['a non-boolean ok counts as success', ["conclusion: verdict.ok === true ? 'success' : 'failure'", "conclusion: verdict.ok ? 'success' : 'failure'"]],
  ['the head sha is not validated before posting', ["            if (!/^[0-9a-f]{40}$/.test(verdict.headSha || '')) {", "            if (false) {"]],
  ['the head comes from the event, not the verdict', ["head_sha: verdict.headSha,", "head_sha: context.payload.workflow_run.head_sha,"]],
  ['a second job added', ["\njobs:\n  publish:", "\njobs:\n  extra:\n    runs-on: ${{ fromJSON(inputs.runs-on) }}\n    steps:\n      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4\n  publish:"]],
];

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ilp-mut-'));
const run = (file) => spawnSync('node', [TEST], { encoding: 'utf8', env: { ...process.env, ISSUE_LINK_PUBLISH_WORKFLOW: file } });

const baseline = run(path.join(ROOT, '.github', 'workflows', 'issue-link-publish.yml'));
console.log(`baseline: exit ${baseline.status} (must be 0)`);
let bad = baseline.status !== 0 ? 1 : 0;

for (const [name, [from, to]] of mutants) {
  const count = SOURCE.split(from).length - 1;
  if (count !== 1) { bad += 1; console.log(`BROKEN MUTANT - ${name}: the anchor occurs ${count} times, expected 1`); continue; }
  const file = path.join(dir, 'mutant.yml');
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
