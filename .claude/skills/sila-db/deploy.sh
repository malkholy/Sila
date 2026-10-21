#!/usr/bin/env bash
#
# Sila deploy tool. Sends a SQL script to [CHA].[APISilaDeployV1] through the
# Sila API (SilaApi /api/v2/exec, signed in -- same session as db.sh --v2),
# one GO-separated batch per call, stopping at the first failure.
#
# Usage:
#   deploy.sh ping                       which DB answers + create permissions
#   deploy.sh <file.sql> [label]         deploy a script (label goes to the log)
#
# Batches that are only USE / SET ANSI_NULLS / SET QUOTED_IDENTIFIER are
# skipped: the API connection already runs with ANSI_NULLS and
# QUOTED_IDENTIFIER ON, and USE is refused server-side.
#
# Server side: each batch runs in its own transaction, is checked against a
# guardrail (security / data-loss / self-modifying statements are refused --
# run those in SSMS) and is logged in dbo.SilaDeployLog.
#
# The deploy key (Scope 'deploy', bound to the signed-in user) is read from
# $SILA_DEPLOY_KEY or ~/.config/sila/deploy.key -- never from the repo.
# IMPORTANT: this CHANGES the live database; every run needs the user's
# explicit approval in chat.

set -euo pipefail

KEY="${SILA_DEPLOY_KEY:-}"
if [ -z "$KEY" ] && [ -f "$HOME/.config/sila/deploy.key" ]; then
  KEY="$(tr -d '[:space:]' < "$HOME/.config/sila/deploy.key")"
fi
if [ -z "$KEY" ]; then
  echo "deploy.sh: no deploy key (set SILA_DEPLOY_KEY or write it to ~/.config/sila/deploy.key)" >&2
  exit 2
fi

target="${1:-}"
label="${2:-}"
if [ -z "$target" ]; then
  echo "usage: deploy.sh ping | deploy.sh <file.sql> [label]" >&2; exit 2
fi
if [ "$target" != "ping" ] && [ ! -f "$target" ]; then
  echo "deploy.sh: no such file: $target" >&2; exit 2
fi

PY="$(command -v python3 || true)"
if [ -z "$PY" ]; then echo "deploy.sh: python3 is required" >&2; exit 3; fi

TARGET="$target" LABEL="$label" KEY="$KEY" \
V2_ENDPOINT="${SILA_API_ENDPOINT:-https://sila.glcpaints.com:7400}" \
V2_DATABASE="${SILA_API_DATABASE:-SILA101}" "$PY" - <<'PYEOF'
import json, os, re, subprocess, sys, time, datetime

PROC = "CHA.APISilaDeployV1"
target, label, key = os.environ["TARGET"], os.environ["LABEL"], os.environ["KEY"]

def curl(url, payload, headers=()):
    args = ["curl", "-sk", "--max-time", "180", "-X", "POST", url,
            "-H", "Content-Type: application/json", "-H", "Accept: application/json"]
    for h in headers: args += ["-H", h]
    p = subprocess.run(args + ["--data-binary", "@-", "-w", "\n%{http_code}"],
                       input=json.dumps(payload), capture_output=True, text=True)
    if p.returncode != 0:
        print(f"deploy.sh: curl failed ({p.returncode}): {p.stderr.strip()}", file=sys.stderr); sys.exit(1)
    body, _, code = p.stdout.rpartition("\n")
    return int(code or 0), body

# Same session handling (and cache file) as db.sh --v2.
def v2_session():
    cfg = os.path.expanduser("~/.config/sila")
    cache = os.path.join(cfg, "api-session.json")
    base, db = os.environ["V2_ENDPOINT"].rstrip("/"), os.environ["V2_DATABASE"]
    def save(tok):
        os.makedirs(cfg, exist_ok=True)
        fd = os.open(cache, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as f: json.dump(tok, f)
        return tok
    def fresh(tok):
        # .NET sends 7 fractional digits; Python < 3.11 fromisoformat accepts at most 6
        stamp = re.sub(r"(\.\d{6})\d+", r"\1", tok["expiresAt"].replace("Z", "+00:00"))
        return datetime.datetime.fromisoformat(stamp).timestamp() - time.time() > 30
    tok = None
    if os.path.exists(cache):
        try: tok = json.load(open(cache))
        except ValueError: tok = None
    if tok and tok.get("database") == db and fresh(tok):
        return base, db, tok["accessToken"]
    if tok and tok.get("database") == db and tok.get("refreshToken"):
        code, body = curl(base + "/api/v2/auth/refresh", {"database": db, "refreshToken": tok["refreshToken"]})
        if code == 200:
            return base, db, save(json.loads(body))["accessToken"]
        os.remove(cache)   # refresh tokens are single-use: never retry one
    user, pw = os.environ.get("SILA_API_USER", ""), os.environ.get("SILA_API_PASSWORD", "")
    cred = os.path.join(cfg, "api.json")
    if (not user or not pw) and os.path.exists(cred):
        c = json.load(open(cred)); user, pw = c.get("username", ""), c.get("password", "")
    if not user or not pw:
        print("deploy.sh: needs a Sila account (~/.config/sila/api.json or SILA_API_USER/SILA_API_PASSWORD)", file=sys.stderr); sys.exit(2)
    code, body = curl(base + "/api/v2/auth/login", {"database": db, "username": user, "password": pw})
    if code != 200:
        print(f"deploy.sh: login failed (HTTP {code}): {body[:300]}", file=sys.stderr); sys.exit(1)
    return base, db, save(json.loads(body))["accessToken"]

def call(operation, line):
    base, db, access = v2_session()
    code, out = curl(base + "/api/v2/exec",
                     {"database": db, "proc": PROC, "operation": operation, "lineData": {"ApiKey": key, **line}},
                     [f"Authorization: Bearer {access}"])
    try:
        env = json.loads(out)
    except ValueError:
        return False, f"non-JSON response (HTTP {code}): {out[:300]}", {}
    # the SP's @Message comes back under outputs when the envelope message is empty
    msg = env.get("message") or (env.get("outputs") or {}).get("Message") or f"HTTP {code}"
    return bool(env.get("ok")), msg, env.get("data") or {}

if target == "ping":
    ok, msg, data = call("Ping", {})
    print(json.dumps(data, indent=2, ensure_ascii=False))
    if not ok:
        print(f"\ndeploy.sh: ping failed -> {msg}", file=sys.stderr); sys.exit(1)
    sys.exit(0)

text = open(target, encoding="utf-8-sig").read()
parts = re.split(r'(?im)^[ \t]*GO(?:[ \t]+\d+)?[ \t]*$', text)
SKIP = re.compile(r'(?is)^\s*(?:(?:--[^\n]*\n\s*)*)(USE\s+\[?\w+\]?|SET\s+(ANSI_NULLS|QUOTED_IDENTIFIER)\s+ON)\s*;?\s*$')
batches, skipped = [], 0
for p in parts:
    body = p.strip()
    if not body: continue
    # a batch of only comments
    if not re.sub(r'(?m)--[^\n]*$', '', body).strip(): skipped += 1; continue
    if SKIP.match(body + "\n"): skipped += 1; continue
    batches.append(body)

name = label or os.path.basename(target)
print(f"deploy.sh: {target} -> {len(batches)} batch(es) to run, {skipped} skipped (USE / SET / comments)")
for i, b in enumerate(batches, 1):
    first = next((l.strip() for l in b.splitlines() if l.strip() and not l.strip().startswith('--')), '')[:90]
    ok, msg, data = call("Deploy", {"Sql": b, "Label": f"{name} [{i}/{len(batches)}]"})
    print(f"  [{i}/{len(batches)}] {'ok  ' if ok else 'FAIL'} {first}")
    for k in sorted(data):
        for row in data[k]: print("        ", json.dumps(row, ensure_ascii=False, default=str))
    if not ok:
        print(f"\ndeploy.sh: batch {i} failed -> {msg}", file=sys.stderr)
        print("deploy.sh: earlier batches stay applied; this one was rolled back.", file=sys.stderr)
        sys.exit(1)
    print(f"        {msg}")
print("deploy.sh: done")
PYEOF
