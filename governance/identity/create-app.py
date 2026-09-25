#!/usr/bin/env python3
"""Register an organisation-owned GitHub App from a manifest (DELIVERY.md Appendix A).

The owner runs this once per identity. It serves a one-page form on localhost that
posts the manifest to GitHub; the owner clicks "Create GitHub App"; GitHub redirects
back here with a one-time code, which is exchanged for the App's id and private key.
The key is written to ~/.config/mm-agent/<app>/ with 0600 permissions and is never
printed.

    python3 governance/identity/create-app.py mm-agent
    python3 governance/identity/create-app.py mm-reviewer

Afterwards, install the App on the organisation from the URL it prints.
"""
import http.server
import json
import os
import pathlib
import secrets
import sys
import urllib.parse
import urllib.request
import webbrowser

ORG = "marvinamiranda"
PORT = 8765
HERE = pathlib.Path(__file__).resolve().parent

name = sys.argv[1] if len(sys.argv) > 1 else ""
manifest_path = HERE / f"{name}.manifest.json"
if not manifest_path.is_file():
    sys.exit(f"usage: create-app.py <mm-agent|mm-reviewer>  (no {manifest_path.name})")

manifest = json.loads(manifest_path.read_text())
manifest["redirect_url"] = f"http://127.0.0.1:{PORT}/callback"
state = secrets.token_urlsafe(16)
out_dir = pathlib.Path.home() / ".config" / "mm-agent" / name


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
            out_dir.mkdir(parents=True, exist_ok=True)
            os.chmod(out_dir.parent, 0o700)
            os.chmod(out_dir, 0o700)
            key = out_dir / "private-key.pem"
            key.write_text(app["pem"])
            os.chmod(key, 0o600)
            meta = {k: app[k] for k in ("id", "slug", "client_id", "html_url", "name")}
            meta_file = out_dir / "app.json"
            meta_file.write_text(json.dumps(meta, indent=2))
            os.chmod(meta_file, 0o600)
            install = f"https://github.com/apps/{app['slug']}/installations/new"
            self._send(
                f"<html><body style='font-family:sans-serif;max-width:40em;margin:3em auto'>"
                f"<h2>Created <code>{app['slug']}</code> (App id {app['id']})</h2>"
                f"<p>Private key saved to <code>{key}</code>. It was not shown anywhere.</p>"
                f"<p><b>Last step:</b> <a href='{install}'>install it on {ORG}</a> — choose "
                f"<i>All repositories</i>.</p></body></html>"
            )
            print(f"Created {app['slug']} (id {app['id']}). Key: {key}")
            print(f"Install: {install}")
            self.server.done = True
            return
        self._send("not found", 404)


server = http.server.HTTPServer(("127.0.0.1", PORT), Handler)
server.done = False
print(f"Opening http://127.0.0.1:{PORT}/ — click 'Continue to GitHub', then 'Create GitHub App'.")
webbrowser.open(f"http://127.0.0.1:{PORT}/")
while not server.done:
    server.handle_request()
