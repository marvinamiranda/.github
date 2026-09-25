'use strict';

// The matching logic behind the `governance/issue-link` required check
// (DELIVERY §9: "One Task, one PR — the PR body says `Closes #n`").
//
// One file, two callers: `.github/workflows/pr-governance.yml` requires it
// through actions/github-script and calls `judge`, and
// `governance/tests/issue-link.test.js` drives both the text matcher and
// `judge` (with a fake API client).
//
// Two layers, deliberately:
//   - `evaluate`: the regex. Fast, offline, and the only thing a local test
//     can run. It is NOT the authority for pull requests into the default
//     branch.
//   - `judge`: what the check publishes. For a pull request into the default
//     branch it asks GitHub itself (GraphQL `closingIssuesReferences`) — the
//     same parser that will close the issue on merge — so a reference the
//     regex accepts but GitHub does not (a pull request number, an issue that
//     does not exist, a repository it cannot see) fails here instead of
//     merging and closing nothing.

// GitHub's closing keywords, case-insensitive. Nothing else closes an issue.
const KEYWORD = '(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)';
const OWNER = '[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})';
const REPO = '[A-Za-z0-9._-]{1,100}';

// keyword, optional colon, whitespace, then one of:
//   #123 | owner/repo#123 | https://github.com/owner/repo/issues/123
// The keyword must start a word, and the number must end it, so "prefixes #1"
// and "#12abc" do not count.
const CLOSING_REF = new RegExp(
  `(?<![A-Za-z0-9_/-])${KEYWORD}\\s*:?\\s+` +
    `(?:` +
    `(?:(${OWNER})\\/(${REPO}))?#(\\d+)` +
    `|https:\\/\\/github\\.com\\/(${OWNER})\\/(${REPO})\\/issues\\/(\\d+)` +
    `)(?![0-9A-Za-z_])`,
  'gi',
);

// Text GitHub itself does not read as a closing reference: HTML comments
// (where the pull request template keeps its examples), fenced code blocks
// and inline code spans. Matching inside them would let the template's own
// instructions satisfy the check.
function stripNonProse(body) {
  const withoutComments = String(body || '')
    .replace(/\r\n?/g, '\n')
    // An unterminated comment hides the rest of the body, as it does on GitHub.
    .replace(/<!--[\s\S]*?(?:-->|$)/g, ' ');
  const kept = [];
  let fence = null; // the opening fence while inside a fenced block
  for (const line of withoutComments.split('\n')) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence === null && marker) {
      fence = marker[1];
      continue;
    }
    if (fence !== null) {
      const close = /^\s{0,3}(`{3,}|~{3,})\s*$/.exec(line);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) fence = null;
      continue;
    }
    kept.push(line.replace(/`[^`]*`/g, ' '));
  }
  return kept.join('\n');
}

function findClosingRefs(body, repository) {
  const [defaultOwner, defaultRepo] = String(repository || '/').split('/');
  const text = stripNonProse(body);
  const refs = [];
  const seen = new Set();
  for (const m of text.matchAll(CLOSING_REF)) {
    const owner = m[1] || m[4] || defaultOwner;
    const repo = m[2] || m[5] || defaultRepo;
    const number = Number(m[3] || m[6]);
    if (!owner || !repo || !Number.isInteger(number) || number < 1) continue;
    const key = `${owner}/${repo}#${number}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push({ owner, repo, number, key: `${owner}/${repo}#${number}`, keyword: m[0].split(/[\s:]/)[0] });
  }
  return refs;
}

function isReleasePullRequest(headRef, baseRef) {
  return headRef === 'test' && baseRef === 'main';
}

function isHotfix(headRef) {
  return typeof headRef === 'string' && headRef.startsWith('hotfix/');
}

// Returns the verdict for a pull request, before any API lookup.
//   status: 'exempt' | 'pass' | 'fail'
//   requireBug: the workflow must confirm one of `refs` is a Bug (hotfix/*)
function evaluate({ body, headRef, baseRef, repository }) {
  if (isReleasePullRequest(headRef, baseRef)) {
    return {
      status: 'exempt',
      refs: [],
      requireBug: false,
      message: 'Release pull request (test → main): exempt from issue linking.',
    };
  }
  const refs = findClosingRefs(body, repository);
  const requireBug = isHotfix(headRef);
  if (refs.length === 0) {
    return {
      status: 'fail',
      refs,
      requireBug,
      message:
        'The pull request body names no issue with a closing keyword. Add a line such as ' +
        '"Closes #123", "Closes owner/repo#123" or "Closes https://github.com/owner/repo/issues/123" ' +
        '(keywords: close, closes, closed, fix, fixes, fixed, resolve, resolves, resolved). ' +
        (requireBug ? 'A hotfix/* pull request must close a Bug. ' : '') +
        'Text inside HTML comments and code does not count.',
    };
  }
  return {
    status: 'pass',
    refs,
    requireBug,
    message: `Closes ${refs.map((r) => r.key).join(', ')}` + (requireBug ? ' (hotfix: one must be a Bug)' : ''),
  };
}

// The issue object from GET /repos/{owner}/{repo}/issues/{n}.
function isBug(issue) {
  return Boolean(issue && !issue.pull_request && issue.type && issue.type.name === 'Bug');
}

const CLOSING_QUERY = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      closingIssuesReferences(first: 50) {
        totalCount
        nodes { number repository { nameWithOwner } }
      }
    }
  }
}`;

// GitHub links closing issues when it parses the body, and the event that
// starts a run can arrive before it has: an empty first answer is asked again
// once, this long after.
const RELOOK_MS = 5000;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The verdict the `governance/issue-link` check publishes.
//   github:  an Octokit client (actions/github-script's `github`)
//   context: the Actions context of a pull_request event
//   sleep:   waits before the second lookup (tests pass a recorder)
// Returns { ok, title, summary, headSha }.
async function judge({ github, context, sleep = pause }) {
  const { owner, repo } = context.repo;
  const repository = `${owner}/${repo}`;
  const number = context.payload.pull_request.number;
  // Read the pull request NOW, not from the event payload: the body may have
  // been edited, or the head pushed, since the event that started this run.
  const { data: pr } = await github.rest.pulls.get({ owner, repo, pull_number: number });
  const headSha = pr.head.sha;
  const done = (ok, title, summary) => ({ ok, title: title.slice(0, 255), summary, headSha });

  const verdict = evaluate({ body: pr.body || '', headRef: pr.head.ref, baseRef: pr.base.ref, repository });
  if (verdict.status === 'exempt') return done(true, 'Release pull request: exempt', verdict.message);
  if (verdict.status === 'fail') return done(false, 'No closing issue link', verdict.message);

  // A pull request cannot close itself.
  const isSelf = (r) => `${r.owner}/${r.repo}`.toLowerCase() === repository.toLowerCase() && r.number === number;
  const refs = verdict.refs.filter((r) => !isSelf(r));
  if (refs.length === 0) {
    return done(false, 'The pull request only references itself',
      `#${number} is this pull request. Close the Task or Bug it delivers instead.`);
  }

  const lines = [];
  const { data: repoData } = await github.rest.repos.get({ owner, repo });
  if (pr.base.ref === repoData.default_branch) {
    // GitHub's own parsing is the authority: it is what closes the issue.
    const lookup = async () => (await github.graphql(CLOSING_QUERY, { owner, repo, number }))
      .repository.pullRequest.closingIssuesReferences;
    let closing = await lookup();
    if (!closing || closing.totalCount === 0) {
      await sleep(RELOOK_MS);
      closing = await lookup();
    }
    if (!closing || closing.totalCount === 0) {
      return done(false, 'GitHub sees no issue this pull request closes',
        `The body mentions ${refs.map((r) => r.key).join(', ')}, but GitHub links no issue to close on merge ` +
        `(asked twice, ${RELOOK_MS / 1000} s apart). ` +
        'Check the number is an issue (not a pull request), that it exists, and that the keyword and reference are written as in the template. ' +
        `If this pull request was opened before ${repoData.default_branch} became the default branch, GitHub still holds the links it ` +
        'parsed then: edit the body and save it again (any change will do), and GitHub re-reads it.');
    }
    lines.push(`GitHub will close: ${closing.nodes.map((n) => `${n.repository.nameWithOwner}#${n.number}`).join(', ') || `${closing.totalCount} issue(s)`}`);
  } else {
    lines.push(`Closes ${refs.map((r) => r.key).join(', ')} (base ${pr.base.ref} is not the default branch, so GitHub will not close it on merge)`);
  }

  if (verdict.requireBug) {
    // Only issues in this repository: the workflow token can read nothing else,
    // and a hotfix's Bug belongs where the fix lands.
    const local = refs.filter((r) => `${r.owner}/${r.repo}`.toLowerCase() === repository.toLowerCase());
    const notes = [];
    let bug = null;
    for (const r of local) {
      try {
        const { data } = await github.rest.issues.get({ owner, repo, issue_number: r.number });
        if (isBug(data)) { bug = r; break; }
        notes.push(`${r.key} is ${data.pull_request ? 'a pull request' : `of type ${data.type ? data.type.name : 'none'}`}`);
      } catch (error) {
        notes.push(`${r.key} could not be read (HTTP ${error.status || '?'})`);
      }
    }
    if (!bug) {
      return done(false, 'A hotfix must close a Bug in this repository',
        `A hotfix/* pull request must close an issue of type Bug in ${repository}. ${notes.join('; ') || 'No reference to this repository.'}`);
    }
    lines.push(`Hotfix closes Bug ${bug.key}`);
  }
  return done(true, lines[0], lines.join('\n'));
}

module.exports = { CLOSING_REF, CLOSING_QUERY, stripNonProse, findClosingRefs, isReleasePullRequest, isHotfix, evaluate, isBug, judge };

// CLI, for local use:  node governance/issue-link.js --head <ref> --base <ref> --repo owner/repo < body.md
if (require.main === module) {
  const args = process.argv.slice(2);
  const opt = (name, fallback) => {
    const i = args.indexOf(name);
    return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
  };
  const body = require('fs').readFileSync(0, 'utf8');
  const verdict = evaluate({
    body,
    headRef: opt('--head', 'feature'),
    baseRef: opt('--base', 'test'),
    repository: opt('--repo', 'owner/repo'),
  });
  process.stdout.write(JSON.stringify(verdict, null, 2) + '\n');
  process.exit(verdict.status === 'fail' ? 1 : 0);
}
