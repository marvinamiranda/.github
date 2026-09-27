#!/usr/bin/env python3
# Isolated mode (-I) and no site (-S), first, before any other import.
# Without -I, Python puts this script's directory first on sys.path and
# honours PYTHONPATH, PYTHONSTARTUP and user site-packages, so a planted
# secrets.py (or json.py, …) beside the script would run as the owner, with
# the key about to be handed over, before any check below. Without -S, every
# .pth file in site-packages runs at start-up, even under -I, and Homebrew's
# site-packages is writable by the owner's account. This check cannot stop
# code that loads before the script does (a .pth file, sitecustomize,
# usercustomize): that is exactly why -I -S is required and documented, not
# merely checked. `sys` is built into the interpreter, so importing it loads
# nothing from disk.
import sys

if not (sys.flags.isolated and sys.flags.no_site):
    sys.exit("create-app.py: refusing: run it isolated and without site-packages, so that nothing beside it, on "
             "PYTHONPATH or in a .pth file runs first: python3 -I -S governance/identity/create-app.py <name> [...]")

"""Register an organisation-owned GitHub App from a manifest (DELIVERY.md Appendix A).

The owner runs this once per identity. It serves a one-page form on localhost that
posts the manifest to GitHub; the owner clicks "Create GitHub App"; GitHub redirects
back here with a one-time code, which is exchanged for the App's id and private key.
The key is never printed. Where it goes depends on the identity (CUSTODY below):

    python3 -I -S governance/identity/create-app.py mm-agent
    python3 -I -S governance/identity/create-app.py mm-reviewer
        The key is written to ~/.config/mm-agent/<name>/private-key.pem (0600).

    python3 -I -S governance/identity/create-app.py mm-checks --to-environment \\
        --repo omni237 --repo omni237-ops
        The key goes straight into the environment secret CHECKS_APP_PRIVATE_KEY,
        and the client id into the variable CHECKS_APP_CLIENT_ID, of each
        repository's governance-checks environment. It reaches `gh secret set` on
        stdin and is never written to disk, passed as an argument or printed.
        Run it with the owner's credential (a one-day fine-grained token as
        GH_TOKEN; README "Identities" lists its permissions), never from an agent
        shell. Every target is checked before the page opens: the environment
        must exist and allow only the repository's default branch (bootstrap.sh
        creates it so), and must not hold the secret already unless --replace.

Run it from a merged commit: check this repository out by the SHA of a commit
on its test. It refuses anything else (governance/identity/provenance.sh, the
rule bootstrap.sh --apply uses): a commit that is not on test as GitHub has it
now, uncommitted changes under governance/ (by content), or files outside a
git checkout. It reads the manifest from that commit, not from the file.

Afterwards, install the App from the URL it prints.
"""
import argparse
import http.server
import json
import os
import pathlib
import re
import secrets
import subprocess
import urllib.parse
import urllib.request
import webbrowser

ORG = "marvinamiranda"
PORT = 8765
HERE = pathlib.Path(__file__).resolve().parent
AGENT_ROOT = pathlib.Path.home() / ".config" / "mm-agent"

# Where each identity's private key may go. An identity that is not listed is
# refused. "file": ~/.config/mm-agent/<name>/private-key.pem, readable by every
# agent session on the machine, which is acceptable for the identities agents
# themselves act as. "environment": only a GitHub environment secret, because
# that key can post merge-gating checks (marvinamiranda/.github#9).
CUSTODY = {
    "mm-agent": "file",
    "mm-reviewer": "file",
    "mm-checks": "environment",
}
ENVIRONMENT = "governance-checks"
KEY_SECRET = "CHECKS_APP_PRIVATE_KEY"
CLIENT_ID_VARIABLE = "CHECKS_APP_CLIENT_ID"


def refuse(message: str, code: int = 2):
    print(f"create-app.py: refusing: {message}", file=sys.stderr)
    sys.exit(code)


parser = argparse.ArgumentParser(
    prog="create-app.py",
    description="Register an organisation GitHub App from governance/identity/<name>.manifest.json.",
)
parser.add_argument("name", help=" | ".join(CUSTODY))
parser.add_argument("--to-environment", action="store_true",
                    help=f"mm-checks only, and required for it: load the key into each --repo's {ENVIRONMENT} environment")
parser.add_argument("--repo", action="append", default=[], metavar="REPO",
                    help=f"a repository in {ORG} to load the key into; one per repository")
parser.add_argument("--replace", action="store_true",
                    help=f"overwrite a {KEY_SECRET} already in the environment")
args = parser.parse_args()

name = args.name
custody = CUSTODY.get(name)
manifest_path = HERE / f"{name}.manifest.json"
if custody is None or not manifest_path.is_file():
    refuse(f"usage: create-app.py <{'|'.join(CUSTODY)}> (no custody rule or no {manifest_path.name} for {name!r})")
if args.to_environment and custody != "environment":
    refuse(f"--to-environment is only for mm-checks; {name}'s key is written to ~/.config/mm-agent/{name}/.")
if custody == "environment" and not args.to_environment:
    refuse(f"{name}'s key may only go into each repository's {ENVIRONMENT} environment, never onto disk: "
           f"pass --to-environment and one --repo per repository.")
if not args.to_environment and (args.repo or args.replace):
    refuse("--repo and --replace go with --to-environment.")

repos = []
if custody == "environment":
    if not args.repo:
        refuse("--to-environment needs at least one --repo.")
    for given in args.repo:
        owner, _, repo = given.rpartition("/")
        if owner not in ("", ORG) or not re.fullmatch(r"[A-Za-z0-9._-]+", repo) or repo in (".", ".."):
            refuse(f"--repo {given!r}: give a repository in {ORG}, as <name> or {ORG}/<name>.")
        if repo in repos:
            refuse(f"--repo {repo} is given twice.")
        repos.append(repo)

# Provenance: only merged code handles an App's private key. The same rule as
# bootstrap.sh --apply, from the same script: this checkout's HEAD must be on
# marvinamiranda/.github test as GitHub has it now, with nothing uncommitted
# under governance/. Checked before any gh call and before the page opens.
provenance = subprocess.run(["bash", str(HERE / "provenance.sh")], stdin=subprocess.DEVNULL, capture_output=True, text=True)
if provenance.returncode != 0:
    reason = provenance.stderr.strip() or f"provenance.sh exited {provenance.returncode}"
    refuse(f"{reason}. Check out a merged commit of {ORG}/.github by its SHA (git checkout <sha>) and run it from there.", 1)
print(provenance.stdout.strip())
checked = re.search(r"commit ([0-9a-f]{40})", provenance.stdout)
if not checked:
    refuse("provenance.sh did not name the commit it checked.", 1)
CHECKED_COMMIT = checked.group(1)


def gh(*argv, stdin_bytes=None):
    """Run the gh on PATH. The only call that sends stdin is the key's."""
    return subprocess.run(
        ["gh", *argv],
        input=stdin_bytes,
        stdin=None if stdin_bytes is not None else subprocess.DEVNULL,
        capture_output=True,
    )


def gh_get(path):
    """GET path: (json, None), or (None, 404) or (None, <error text>)."""
    r = gh("api", path)
    if r.returncode == 0:
        try:
            return json.loads(r.stdout), None
        except ValueError:
            return None, f"GET {path} returned something that is not JSON"
    err = r.stderr.decode(errors="replace").strip()
    return None, 404 if "HTTP 404" in err else f"GET {path} failed: {err}"


def not_the_owner():
    """Why this shell is an agent's rather than the owner's, or None."""
    for var in ("GH_TOKEN", "GITHUB_TOKEN"):
        token = os.environ.get(var, "")
        if re.fullmatch(r"mm-[a-z0-9-]+-sentinel-not-a-token", token):
            return f"{var} is an agent-env.sh sentinel (an agent shell)"
        if token.startswith("ghs_"):
            return f"{var} is a GitHub App installation token"
    config = os.environ.get("GH_CONFIG_DIR", "")
    if config:
        resolved = pathlib.Path(config).expanduser().resolve()
        if resolved == AGENT_ROOT.resolve() or AGENT_ROOT.resolve() in resolved.parents:
            return f"GH_CONFIG_DIR is an agent's ({config})"
    return None


def preflight(repo):
    """Refuse unless repo's environment is ready to hold the key, before any App exists."""
    full = f"{ORG}/{repo}"
    meta, err = gh_get(f"repos/{full}")
    if meta is None:
        refuse(f"{full}: cannot be read ({err}).", 1)
    branch = meta.get("default_branch")
    env_path = f"repos/{full}/environments/{ENVIRONMENT}"
    env, err = gh_get(env_path)
    if err == 404:
        refuse(f"{full} has no {ENVIRONMENT} environment. Create it first: "
               f"governance/bootstrap.sh --repo {repo} --no-rulesets --apply (README, Bootstrap).", 1)
    if env is None:
        refuse(f"{full}: {err}", 1)
    policy = env.get("deployment_branch_policy")
    if policy is None or policy.get("protected_branches") is not False or policy.get("custom_branch_policies") is not True:
        refuse(f"{full} {ENVIRONMENT}: deployment branches are {json.dumps(policy)}; only a custom policy is allowed "
               f"(protected_branches false, custom_branch_policies true). Re-run governance/bootstrap.sh --apply.", 1)
    rules, err = gh_get(f"{env_path}/deployment-branch-policies?per_page=100")
    if rules is None:
        refuse(f"{full} {ENVIRONMENT}: {err}", 1)
    listed = [(p.get("name"), p.get("type")) for p in rules.get("branch_policies", [])]
    if rules.get("total_count") != 1 or listed != [(branch, "branch")]:
        refuse(f"{full} {ENVIRONMENT}: deployment rules are {listed or 'none'} (total {rules.get('total_count')}); "
               f"the only rule allowed is the default branch, ({branch!r}, 'branch'). Anything else lets other refs "
               f"use the key. Re-run governance/bootstrap.sh --apply.", 1)
    _, err = gh_get(f"{env_path}/secrets/public-key")
    if err is not None:
        refuse(f"{full} {ENVIRONMENT}: this credential cannot read the environment's secrets "
               f"({'not found' if err == 404 else err}). It needs Environments: read and write.", 1)
    existing, err = gh_get(f"{env_path}/secrets/{KEY_SECRET}")
    if existing is not None and not args.replace:
        refuse(f"{full} {ENVIRONMENT} already holds {KEY_SECRET} (updated {existing.get('updated_at')}), another App's key. "
               f"Pass --replace to overwrite it.", 1)
    if existing is None and err != 404:
        refuse(f"{full} {ENVIRONMENT}: {err}", 1)
    print(f"{full}: {ENVIRONMENT} allows only {branch!r}; ready.")


def scrub(text: str, pem: str) -> str:
    """Whatever gh printed, without the key in it."""
    text = text.replace(pem.strip(), "[key removed]")
    return re.sub(r"-----BEGIN[^-]*-----.*?(-----END[^-]*-----|$)", "[key removed]", text, flags=re.S)


if custody == "environment":
    why = not_the_owner()
    if why:
        refuse(f"{why}, not the owner's credential. Load the key from a shell of the owner's with no agent "
               f"env file sourced, with a one-day fine-grained token as GH_TOKEN.", 1)
    for repo in repos:
        preflight(repo)

# From the commit provenance.sh checked, not from the file, which could change
# after the check. `cat-file blob` prints the committed bytes with no textconv
# or filter; `<commit>:./<file>` is relative to HERE.
# Replace refs and grafts ignored, as in provenance.sh: a refs/replace entry
# for the manifest's blob would otherwise hand cat-file other bytes.
committed = subprocess.run(["git", "-c", "advice.graftFileDeprecated=false", "cat-file", "blob",
                            f"{CHECKED_COMMIT}:./{manifest_path.name}"],
                           cwd=HERE, stdin=subprocess.DEVNULL, capture_output=True, text=True,
                           env={**os.environ, "GIT_NO_REPLACE_OBJECTS": "1", "GIT_GRAFT_FILE": "/dev/null"})
if committed.returncode != 0:
    refuse(f"{manifest_path.name} is not in commit {CHECKED_COMMIT[:12]}: {committed.stderr.strip()}", 1)
manifest = json.loads(committed.stdout)
manifest["redirect_url"] = f"http://127.0.0.1:{PORT}/callback"
state = secrets.token_urlsafe(16)
out_dir = AGENT_ROOT / name


def private_dir():
    out_dir.mkdir(parents=True, exist_ok=True)
    os.chmod(out_dir.parent, 0o700)
    os.chmod(out_dir, 0o700)


def write_private(path: pathlib.Path, text: str):
    path.write_text(text)
    os.chmod(path, 0o600)


def to_file(app, pem):
    """mm-agent, mm-reviewer: the key in the identity's directory. Returns (page, rc)."""
    private_dir()
    key = out_dir / "private-key.pem"
    write_private(key, pem)
    meta = {k: app[k] for k in ("id", "slug", "client_id", "html_url", "name")}
    write_private(out_dir / "app.json", json.dumps(meta, indent=2))
    install = f"https://github.com/apps/{app['slug']}/installations/new"
    print(f"Created {app['slug']} (id {app['id']}). Key: {key}")
    print(f"Install: {install}")
    return (f"<p>Private key saved to <code>{key}</code>. It was not shown anywhere.</p>"
            f"<p><b>Last step:</b> <a href='{install}'>install it on {ORG}</a> — choose "
            f"<i>All repositories</i>.</p>"), 0


def to_environment(app, pem):
    """mm-checks: the key into each repository's environment secret, on stdin. Returns (page, rc)."""
    holding, loaded, failure = [], [], None
    try:
        for repo in repos:
            full = f"{ORG}/{repo}"
            r = gh("secret", "set", KEY_SECRET, "--env", ENVIRONMENT, "--repo", full, stdin_bytes=pem.encode())
            if r.returncode != 0:
                failure = f"loading {KEY_SECRET} into {full} failed: {scrub(r.stderr.decode(errors='replace').strip(), pem)}"
                break
            holding.append(full)
            r = gh("variable", "set", CLIENT_ID_VARIABLE, "--env", ENVIRONMENT, "--repo", full, "--body", str(app["client_id"]))
            if r.returncode != 0:
                failure = f"setting {CLIENT_ID_VARIABLE} in {full} failed: {scrub(r.stderr.decode(errors='replace').strip(), pem)}"
                break
            loaded.append(full)
            print(f"{full}: {KEY_SECRET} and {CLIENT_ID_VARIABLE} set in {ENVIRONMENT}.")
    except Exception as e:  # reported below, with the recovery; the exit code says it failed
        failure = f"{type(e).__name__} while loading the key: {scrub(str(e), pem)}"
    finally:
        # Whatever stopped the loop, including an exception or an interrupt: the
        # key dies with this process, so an incomplete load needs the owner to
        # delete this App and every copy of the key already uploaded.
        if len(loaded) != len(repos):
            settings = f"https://github.com/organizations/{ORG}/settings/apps/{app.get('slug')}/advanced"
            print(f"FAILED: {failure or 'interrupted before every repository was loaded'}", file=sys.stderr)
            print(f"These repositories hold the key: {', '.join(holding) or 'none'}. The key is not kept anywhere, "
                  f"so App {app.get('slug')} (id {app.get('id')}) cannot be completed: delete it at {settings}, "
                  f"delete {KEY_SECRET} from the environments of the repositories above, fix the cause and run this "
                  f"again.", file=sys.stderr)
    if len(loaded) != len(repos):
        return "<p>Loading the key failed. See the terminal: delete this App and run again.</p>", 1
    # The App's id and client id only, which T5 pins the checks to. No key, no secret.
    private_dir()
    meta = {k: app[k] for k in ("id", "slug", "client_id", "html_url", "name")}
    meta["key_custody"] = {"environment": ENVIRONMENT, "repositories": loaded}
    write_private(out_dir / "app.json", json.dumps(meta, indent=2))
    install = f"https://github.com/apps/{app['slug']}/installations/new"
    chosen = ", ".join(repos)
    print(f"Created {app['slug']} (id {app['id']}). Key: only in {ENVIRONMENT} of {', '.join(loaded)}; no file written.")
    print(f"Install: {install} (Only select repositories: {chosen})")
    return (f"<p>The private key went only into the <code>{ENVIRONMENT}</code> environment of "
            f"{', '.join(loaded)}. No file was written and it was not shown anywhere.</p>"
            f"<p><b>Last step:</b> <a href='{install}'>install it</a> — choose <i>Only select "
            f"repositories</i>: {chosen}.</p>"), 0


def not_the_manifests(app):
    """Why the App GitHub created is not the one the manifest describes, or []."""
    problems = []
    owner = (app.get("owner") or {}).get("login")
    if owner != ORG:
        problems.append(f"it is owned by {owner!r}, not {ORG!r}")
    if app.get("name") != manifest["name"]:
        problems.append(f"it is named {app.get('name')!r}, not {manifest['name']!r}")
    if app.get("permissions") != manifest["default_permissions"]:
        problems.append(f"its permissions are {json.dumps(app.get('permissions'), sort_keys=True)}, "
                        f"not {json.dumps(manifest['default_permissions'], sort_keys=True)}")
    return problems


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def _send(self, body: str, code: int = 200):
        data = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        url = urllib.parse.urlparse(self.path)
        if url.path == "/":
            action = f"https://github.com/organizations/{ORG}/settings/apps/new?state={state}"
            value = json.dumps(manifest).replace("&", "&amp;").replace('"', "&quot;")
            self._send(
                f"<html><body style='font-family:sans-serif;max-width:40em;margin:3em auto'>"
                f"<h2>Create the <code>{name}</code> GitHub App for {ORG}</h2>"
                f"<p>{manifest['description']}</p>"
                f"<form action='{action}' method='post'>"
                f"<input type='hidden' name='manifest' value=\"{value}\">"
                f"<button style='font-size:1.2em;padding:.5em 1em'>Continue to GitHub</button></form>"
                f"</body></html>"
            )
            return
        if url.path == "/callback":
            q = urllib.parse.parse_qs(url.query)
            if q.get("state", [""])[0] != state or "code" not in q:
                self._send("<p>State mismatch or missing code. Nothing was saved.</p>", 400)
                return
            req = urllib.request.Request(
                f"https://api.github.com/app-manifests/{q['code'][0]}/conversions",
                method="POST",
                headers={"Accept": "application/vnd.github+json", "User-Agent": "mm-governance"},
            )
            with urllib.request.urlopen(req) as resp:
                app = json.load(resp)
            # The conversion returns the key, the client secret and the webhook
            # secret once. Only the key is used, and only as custody says.
            pem = app.pop("pem")
            for unused in ("client_secret", "webhook_secret"):
                app.pop(unused, None)
            # Before the key goes anywhere: the App must be the manifest's, in
            # this organisation. Otherwise the key is dropped unused.
            problems = not_the_manifests(app)
            if problems:
                del pem
                settings = f"https://github.com/organizations/{ORG}/settings/apps/{app.get('slug')}/advanced"
                print(f"FAILED: the App GitHub created is not the one the manifest describes: {'; '.join(problems)}. "
                      f"Its key was discarded: nothing was written or loaded. Check it, then delete it at {settings} "
                      f"(or wherever it was created) and run this again.", file=sys.stderr)
                page, rc = "<p>The App created is not the one the manifest describes. See the terminal.</p>", 1
            else:
                page, rc = (to_environment if custody == "environment" else to_file)(app, pem)
                del pem
            self._send(
                f"<html><body style='font-family:sans-serif;max-width:40em;margin:3em auto'>"
                f"<h2>Created <code>{app['slug']}</code> (App id {app['id']})</h2>{page}</body></html>"
            )
            self.server.rc = rc
            self.server.done = True
            return
        self._send("not found", 404)


server = http.server.HTTPServer(("127.0.0.1", PORT), Handler)
server.done = False
server.rc = 0
print(f"Opening http://127.0.0.1:{PORT}/ — click 'Continue to GitHub', then 'Create GitHub App'.")
webbrowser.open(f"http://127.0.0.1:{PORT}/")
while not server.done:
    server.handle_request()
sys.exit(server.rc)
