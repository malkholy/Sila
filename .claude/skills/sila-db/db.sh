#!/usr/bin/env bash
#
# Sila live-DB reader. Calls [CHA].[APISilaOperationV1] on the :9201 gateway
# (same transport/body as [CHA].[APITicketOperation]) and prints the JSON.
# Read-only by design: RunQuery/PreviewRows run as [SilaReader] server-side.
#
# Usage:
#   db.sh ping
#   db.sh objects [Schema] [Type] [Search]     Type: U V P FN IF TF TR ('' = any)
#   db.sh def     <Object>                      e.g. '[CHA].[APITicketOperation]'
#   db.sh cols    <Object>
#   db.sh params  <Object>
#   db.sh preview <Object> [Top]
#   db.sh query   'SELECT ...'                  or SQL on stdin
# Leading flags: --raw skips pretty-printing; --v2 goes through the new Sila
# API (SilaApi, https://sila.glcpaints.com:7400) instead of the legacy gateway:
# it signs in with a Sila account (~/.config/sila/api.json {"username","password"}
# or $SILA_API_USER / $SILA_API_PASSWORD), keeps the session in
# ~/.config/sila/api-session.json (mode 600) and calls /api/v2/exec with
# proc CHA.APISilaOperationV1. The ApiKey is still required by the SP.
#
# The API key is read from $SILA_DB_KEY or ~/.config/sila/db.key -- never
# from the repo. IMPORTANT: this hits the LIVE database; the skill requires
# explicit user approval in chat before every invocation.

set -euo pipefail

ENDPOINT="${SILA_DB_ENDPOINT:-https://sila.glcpaints.com:9201/GeneralAPI}"
SP_NAME="${SILA_DB_SP:-[CHA].[APISilaOperationV1]}"
DB_USER="${SILA_DB_USER:-claude}"
KEY="${SILA_DB_KEY:-}"
if [ -z "$KEY" ] && [ -f "$HOME/.config/sila/db.key" ]; then
  KEY="$(tr -d '[:space:]' < "$HOME/.config/sila/db.key")"
fi
if [ -z "$KEY" ]; then
  echo "db.sh: no API key (set SILA_DB_KEY or write it to ~/.config/sila/db.key)" >&2
  exit 2
fi

raw=0; v2=0
while [ "${1:-}" = "--raw" ] || [ "${1:-}" = "--v2" ]; do
  if [ "$1" = "--raw" ]; then raw=1; else v2=1; fi
  shift
done
V2_ENDPOINT="${SILA_API_ENDPOINT:-https://sila.glcpaints.com:7400}"
V2_DATABASE="${SILA_API_DATABASE:-SILA101}"
cmd="${1:-}"; shift || true

case "$cmd" in
  ping)    op=Ping ;;
  objects) op=ListObjects ;;
  def)     op=GetDefinition ;;
  cols)    op=GetColumns ;;
  params)  op=GetParameters ;;
  preview) op=PreviewRows ;;
  query)   op=RunQuery ;;
  *) echo "db.sh: unknown command '$cmd' (ping|objects|def|cols|params|preview|query)" >&2; exit 2 ;;
esac

sql=""
if [ "$op" = RunQuery ]; then
  sql="${1:-}"
  if [ -z "$sql" ]; then sql="$(cat)"; fi
  if [[ ! "$sql" =~ [^[:space:]] ]]; then echo "db.sh: no SQL provided" >&2; exit 2; fi
fi

PY="$(command -v python3 || true)"
if [ -z "$PY" ]; then echo "db.sh: python3 is required" >&2; exit 3; fi

OP="$op" SQL="$sql" A1="${1:-}" A2="${2:-}" A3="${3:-}" KEY="$KEY" \
ENDPOINT="$ENDPOINT" SP_NAME="$SP_NAME" DB_USER="$DB_USER" RAW="$raw" \
V2="$v2" V2_ENDPOINT="$V2_ENDPOINT" V2_DATABASE="$V2_DATABASE" "$PY" - <<'PYEOF'
import json, os, subprocess, sys

op, a1, a2, a3 = os.environ["OP"], os.environ["A1"], os.environ["A2"], os.environ["A3"]
line = {"ApiKey": os.environ["KEY"]}
if op == "ListObjects":
    for k, v in (("Schema", a1), ("Type", a2), ("Search", a3)):
        if v: line[k] = v
elif op in ("GetDefinition", "GetColumns", "GetParameters", "PreviewRows"):
    if not a1:
        print("db.sh: an object name is required", file=sys.stderr); sys.exit(2)
    line["Object"] = a1
    if op == "PreviewRows" and a2: line["Top"] = int(a2)
elif op == "RunQuery":
    line["Sql"] = os.environ["SQL"]

def curl(url, payload, headers=()):
    args = ["curl", "-sk", "--max-time", "90", "-X", "POST", url,
            "-H", "Content-Type: application/json", "-H", "Accept: application/json"]
    for h in headers: args += ["-H", h]
    # The body (passwords, refresh tokens) goes on stdin; only the 5-minute
    # access token appears in curl's arguments.
    p = subprocess.run(args + ["--data-binary", "@-", "-w", "\n%{http_code}"],
                       input=json.dumps(payload), capture_output=True, text=True)
    if p.returncode != 0:
        print(f"db.sh: curl failed ({p.returncode}): {p.stderr.strip()}", file=sys.stderr); sys.exit(1)
    body, _, code = p.stdout.rpartition("\n")
    return int(code or 0), body

def v2_session():
    import time, datetime
    cfg = os.path.expanduser("~/.config/sila")
    cache = os.path.join(cfg, "api-session.json")
    base, db = os.environ["V2_ENDPOINT"].rstrip("/"), os.environ["V2_DATABASE"]
    def save(tok):
        os.makedirs(cfg, exist_ok=True)
        fd = os.open(cache, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as f: json.dump(tok, f)
        return tok
    def fresh(tok):
        exp = datetime.datetime.fromisoformat(tok["expiresAt"].replace("Z", "+00:00"))
        return exp.timestamp() - time.time() > 30
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
        print("db.sh: --v2 needs a Sila account (~/.config/sila/api.json or SILA_API_USER/SILA_API_PASSWORD)", file=sys.stderr); sys.exit(2)
    code, body = curl(base + "/api/v2/auth/login", {"database": db, "username": user, "password": pw})
    if code != 200:
        print(f"db.sh: login failed (HTTP {code}): {body[:300]}", file=sys.stderr); sys.exit(1)
    return base, db, save(json.loads(body))["accessToken"]

if os.environ["V2"] == "1":
    base, db, access = v2_session()
    code, out = curl(base + "/api/v2/exec",
                     {"database": db, "proc": "CHA.APISilaOperationV1", "operation": op, "lineData": line},
                     [f"Authorization: Bearer {access}"])
    try:
        env = json.loads(out)
    except ValueError:
        print(out); print(f"\ndb.sh: non-JSON response (HTTP {code})", file=sys.stderr); sys.exit(1)
    # Same shape as the legacy gateway: List0..n + State/Message.
    parsed = dict(env.get("data") or {})
    parsed["State"] = env.get("state", 0 if env.get("ok") else code)
    parsed["Message"] = env.get("message", "")
    if not env.get("ok"):
        print(json.dumps(env, indent=2, ensure_ascii=False))
        print(f"\ndb.sh: {op} failed (HTTP {code}) -> {env.get('message')} [trace {env.get('traceId')}]", file=sys.stderr); sys.exit(1)
    p_stdout = json.dumps(parsed)
else:
    # Same body shape the ticket gateway already accepts for APITicketOperation.
    body = json.dumps({
        "operation": op,
        "User": os.environ["DB_USER"],
        "TicketID": 0,
        "ChannelID": 0,
        "LineData": json.dumps(line),
        "LastChatID": 0,
        "MinChatID": 0,
        "PlatForm": "web",
        "WebVersion": "17",
        "AndroidVersion": "13",
        "IOSVersion": "13",
        "DeskTopVerion": "13",
        "FireBaseToken": "",
    })
    p = subprocess.run(
        ["curl", "-sk", "--max-time", "90", "-X", "POST", os.environ["ENDPOINT"],
         "-H", "Content-Type: application/json",
         "-H", "Accept: application/json",
         "-H", f"sp_name: {os.environ['SP_NAME']}",
         "--data-binary", "@-"],
        input=body, capture_output=True, text=True)
    if p.returncode != 0:
        print(f"db.sh: curl failed ({p.returncode}): {p.stderr.strip()}", file=sys.stderr); sys.exit(1)

    try:
        parsed = json.loads(p.stdout)
    except ValueError:
        print(p.stdout); print("\ndb.sh: non-JSON response", file=sys.stderr); sys.exit(1)
    p_stdout = p.stdout

if os.environ["RAW"] == "1":
    print(p_stdout)
elif op == "GetDefinition" and isinstance(parsed.get("List0"), list) and parsed["List0"] and "Definition" in parsed["List0"][0]:
    print(parsed["List0"][0]["Definition"])   # print source as-is, not JSON-escaped
else:
    print(json.dumps(parsed, indent=2, ensure_ascii=False))

# Errors come back as a {State, Message} row while the envelope may say State 0.
err = None
if isinstance(parsed, dict):
    if parsed.get("State") not in (0, None, "0"):
        err = parsed.get("Message") or str(parsed.get("State"))
    l0 = parsed.get("List0")
    if not err and isinstance(l0, list) and l0 and isinstance(l0[0], dict) \
            and set(l0[0]) <= {"State", "Message"} and l0[0].get("State") not in (0, None, "0"):
        err = l0[0].get("Message")
if err:
    print(f"\ndb.sh: {op} failed -> {err}", file=sys.stderr); sys.exit(1)
PYEOF
