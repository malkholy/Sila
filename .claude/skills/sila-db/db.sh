#!/usr/bin/env bash
#
# Sila live-DB reader. Calls [CHA].[APISilaOperationV1] on the :9101 gateway
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
# Add --raw as the first arg to skip pretty-printing.
#
# The API key is read from $SILA_DB_KEY or ~/.config/sila/db.key -- never
# from the repo. IMPORTANT: this hits the LIVE database; the skill requires
# explicit user approval in chat before every invocation.

set -euo pipefail

ENDPOINT="${SILA_DB_ENDPOINT:-https://sila.silasystem.com:9101/General/GeneralAPI}"
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

raw=0
if [ "${1:-}" = "--raw" ]; then raw=1; shift; fi
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
ENDPOINT="$ENDPOINT" SP_NAME="$SP_NAME" DB_USER="$DB_USER" RAW="$raw" "$PY" - <<'PYEOF'
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

if os.environ["RAW"] == "1":
    print(p.stdout)
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
