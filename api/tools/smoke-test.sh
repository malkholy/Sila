#!/usr/bin/env bash
# End-to-end smoke test for Plus.Api (General API v2) with a REAL ERP account.
#
#   api/tools/smoke-test.sh [base-url] [database-key]
#   defaults: https://sila.silasystem.com:7400  MEGA25
#
# Prompts for the ERP username and password (the password is not echoed and
# is never written to disk). Steps:
#   login -> exec GetPagesAndGroups -> refresh -> exec with the new token ->
#   replay the OLD refresh token (must fail AND revoke the session) ->
#   exec with the revoked session's token (must fail) -> login again -> logout
#   -> exec after logout (must fail).
# Side effects: normal sign-in rows in PLS.V1ApiIdentity / V1ApiSession /
# V1ApiRefreshToken (two short sessions, both ended). It never sends a wrong
# password, so the account's failed-attempt counter is not touched.
# Requires: curl, python3.
set -u
BASE="${1:-https://sila.silasystem.com:7400}"
DB="${2:-MEGA25}"
PASS_COUNT=0; FAIL_COUNT=0
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

json() { python3 -c "import sys,json; d=json.load(open(sys.argv[1])); print(eval(sys.argv[2], {'d': d}))" "$1" "$2" 2>/dev/null; }
check() {  # check "<name>" <actual-http> <expected-http>
  if [ "$2" = "$3" ]; then PASS_COUNT=$((PASS_COUNT+1)); printf '  PASS  %-52s HTTP %s\n' "$1" "$2"
  else FAIL_COUNT=$((FAIL_COUNT+1)); printf '  FAIL  %-52s HTTP %s (expected %s)  %s\n' "$1" "$2" "$3" "$(head -c 160 "$TMP/body" 2>/dev/null)"; fi
}
post() {  # post <path> <json-body or ''> [token]  -> prints http code, body in $TMP/body
  local auth=(); [ -n "${3:-}" ] && auth=(-H "Authorization: Bearer $3")
  curl -s -m 30 -o "$TMP/body" -w '%{http_code}' -X POST "$BASE$1" \
    -H 'Content-Type: application/json' ${auth[@]+"${auth[@]}"} --data-binary "${2:-}"   # bash 3.2-safe empty array
}
login_body() { python3 -c "import json,sys; print(json.dumps({'database':sys.argv[1],'username':sys.argv[2],'password':sys.argv[3]}))" "$DB" "$USERNAME" "$PASSWORD"; }
EXEC_BODY="{\"database\":\"$DB\",\"proc\":\"PLS.APIPlusOperationV1\",\"operation\":\"GetPagesAndGroups\"}"

echo "Plus.Api smoke test -> $BASE (database $DB)"
code=$(curl -s -m 20 -o "$TMP/body" -w '%{http_code}' "$BASE/health/live"); check "health/live" "$code" 200

read -r -p "ERP username: " USERNAME
read -r -s -p "ERP password (hidden): " PASSWORD; echo

code=$(post /api/v2/auth/login "$(login_body)"); check "login" "$code" 200
[ "$code" = 200 ] || { echo "Login failed -- stopping (check the account, or ask an admin)."; exit 1; }
ACCESS=$(json "$TMP/body" "d['accessToken']"); REFRESH1=$(json "$TMP/body" "d['refreshToken']")
echo "        signed in as $(json "$TMP/body" "d['username']") ($(json "$TMP/body" "d['displayName']")), access token until $(json "$TMP/body" "d['expiresAt']"), mustChangePassword=$(json "$TMP/body" "d['mustChangePassword']")"
if [ "$(json "$TMP/body" "d['mustChangePassword']")" = "True" ]; then
  code=$(post /api/v2/exec "$EXEC_BODY" "$ACCESS"); check "exec blocked while password change is required" "$code" 403
  echo "Password change required -- change it via /api/v2/auth/change-password, then rerun."; exit 0
fi

code=$(post /api/v2/exec "$EXEC_BODY" "$ACCESS"); check "exec GetPagesAndGroups" "$code" 200
[ "$code" = 200 ] && echo "        ok=$(json "$TMP/body" "d['ok']"), List0 rows=$(json "$TMP/body" "len(d['data'].get('List0', []))")"

code=$(post /api/v2/exec "{\"database\":\"$DB\",\"proc\":\"PLS.APIPlusOperationV1\",\"operation\":\"ExecuteScript\"}" "$ACCESS")
check "exec blocked operation ExecuteScript" "$code" 403
code=$(post /api/v2/exec "{\"database\":\"$DB\",\"proc\":\"PLS.APIPlusOperationV1\",\"operation\":\"GetGridData\"}" "$ACCESS")
check "exec non-allow-listed operation" "$code" 403
code=$(post /api/v2/exec "{\"database\":\"$DB\",\"proc\":\"PLS.APIPlusOperationV1\",\"operation\":\"GetPagesAndGroups\",\"extraParams\":{\"User\":\"sysadmin\"}}" "$ACCESS")
check "exec spoofed User in extraParams" "$code" 400

code=$(post /api/v2/auth/refresh "{\"database\":\"$DB\",\"refreshToken\":\"$REFRESH1\"}"); check "refresh" "$code" 200
ACCESS2=$(json "$TMP/body" "d['accessToken']")
code=$(post /api/v2/exec "$EXEC_BODY" "$ACCESS2"); check "exec with refreshed token" "$code" 200

code=$(post /api/v2/auth/refresh "{\"database\":\"$DB\",\"refreshToken\":\"$REFRESH1\"}"); check "replay old refresh token (rejected)" "$code" 401
code=$(post /api/v2/exec "$EXEC_BODY" "$ACCESS2"); check "exec after replay (session revoked)" "$code" 401

code=$(post /api/v2/auth/login "$(login_body)"); check "login again" "$code" 200
ACCESS3=$(json "$TMP/body" "d['accessToken']")
code=$(curl -s -m 30 -o "$TMP/body" -w '%{http_code}' -X POST "$BASE/api/v2/auth/logout" -H "Authorization: Bearer $ACCESS3" -H 'Content-Length: 0')
check "logout" "$code" 204
code=$(post /api/v2/exec "$EXEC_BODY" "$ACCESS3"); check "exec after logout" "$code" 401

unset PASSWORD
echo "Result: $PASS_COUNT passed, $FAIL_COUNT failed"
[ "$FAIL_COUNT" = 0 ]
