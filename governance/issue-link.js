'use strict';

// The matching logic behind the `governance/issue-link` required check
// (DELIVERY §9: "One Task, one PR — the PR body says `Closes #n`").
//
// One file, two callers: `.github/workflows/pr-governance.yml` requires it
// through actions/github-script, and `governance/tests/issue-link.test.js`
// feeds it sample bodies. Nothing here touches the network; the one question
// that needs the API (is the linked issue a Bug?) is asked by the workflow,
// using `isBug` below on the issue it fetched.

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

module.exports = { CLOSING_REF, stripNonProse, findClosingRefs, isReleasePullRequest, isHotfix, evaluate, isBug };

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
