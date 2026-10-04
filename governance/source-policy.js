'use strict';

// The matching logic behind the `test-source-policy` and `main-source-policy`
// required checks (DELIVERY §9.1). The dev -> test -> main model: dev is the
// integration default, test is the acceptance branch, main is production.
// `test` and `main` may only be entered from a named source branch, so a
// feature branch cannot be merged straight past integration into acceptance or
// production:
//
//   into test: dev (promotion), main (the hotfix back-merge) or hotfix/*
//   into main: test (release) or hotfix/*
//
// dev takes any source: it is the integration branch every Task targets.
//
// The policy is a pure function of the base ref, the head ref and the event,
// so this repository's tests drive it offline. `.github/workflows/source-policy.yml`
// fetches it at governance-ref and publishes its verdict as a check run named
// exactly `test-source-policy` or `main-source-policy`; governance/bootstrap.sh
// requires those contexts on the test and main rulesets. The policy fails
// closed: a wrong base, a wrong head, an empty ref or a non-pull-request event
// is a failure, so a skipped or misfired run can never read as a pass.

// The pull-request events this check runs on. Anything else fails closed.
const PR_EVENTS = new Set(['pull_request', 'pull_request_target']);

const isHotfix = (head) => head.startsWith('hotfix/') && head.length > 'hotfix/'.length;

// One entry per protected base. `name` is the required check context; `allow`
// decides the head; `sources` is the human list used in messages.
const POLICIES = {
  dev: {
    name: 'dev-source-policy',
    allow: () => true,
    sources: 'any branch (dev is the integration default)',
  },
  test: {
    name: 'test-source-policy',
    allow: (head) => head === 'dev' || head === 'main' || isHotfix(head),
    sources: 'dev, main or hotfix/*',
  },
  main: {
    name: 'main-source-policy',
    allow: (head) => head === 'test' || isHotfix(head),
    sources: 'test or hotfix/*',
  },
};

// The check context a verdict is published under. An unknown base has no
// required context: the workflow fails the job instead of posting it.
const checkName = (base) => (POLICIES[base] ? POLICIES[base].name : 'source-policy');

// Event payloads name a branch by its short ref (`dev`); a fully-qualified
// `refs/heads/dev` is accepted too, so a caller that passes one is not failed
// on spelling. Comparison stays case-sensitive, as git refs are.
const shortRef = (ref) => String(ref == null ? '' : ref).replace(/^refs\/heads\//, '');

// Returns { ok, name, base, head, event, message }.
function evaluate({ baseRef, headRef, eventName } = {}) {
  const base = shortRef(baseRef);
  const head = shortRef(headRef);
  const event = String(eventName == null ? '' : eventName);
  const name = checkName(base);
  const verdict = (ok, message) => ({ ok, name, base, head, event, message });

  if (!PR_EVENTS.has(event)) {
    return verdict(false, `Source policy is a pull-request check; it ran on ${event || 'no event'}, so it fails closed.`);
  }
  const policy = POLICIES[base];
  if (!policy) {
    return verdict(false, `No source policy for base "${base || '(none)'}": a pull request may only target dev, test or main.`);
  }
  if (!head) {
    return verdict(false, `A pull request into ${base} names no head branch, so it fails closed.`);
  }
  if (!policy.allow(head)) {
    return verdict(false, `A pull request into ${base} may only come from ${policy.sources}; "${head}" is not allowed.`);
  }
  return verdict(true, `"${head}" into "${base}" is an allowed source (${policy.sources}).`);
}

module.exports = { PR_EVENTS, POLICIES, checkName, shortRef, evaluate };

// CLI, for local use:  node governance/source-policy.js --base <ref> --head <ref> --event pull_request
if (require.main === module) {
  const args = process.argv.slice(2);
  const opt = (name, fallback) => {
    const i = args.indexOf(name);
    return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
  };
  const verdict = evaluate({
    baseRef: opt('--base', ''),
    headRef: opt('--head', ''),
    eventName: opt('--event', 'pull_request'),
  });
  process.stdout.write(JSON.stringify(verdict, null, 2) + '\n');
  process.exit(verdict.ok ? 0 : 1);
}
