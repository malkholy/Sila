# General API v2

ASP.NET Core 10 gateway with local ERP login, JWT issuance and SQL-backed sessions.
The React app and live SQL Server have not been changed by this implementation.
See [IIS deployment](IIS-DEPLOYMENT.md) for the signing-key setup, SQL adapter,
configuration and authentication endpoint examples. The gateway still needs SQL
integration validation and reviewed operation grants before application cutover.

## Run and test

Install the [.NET 10 SDK](https://learn.microsoft.com/en-us/dotnet/core/install/macos).
From the repository root:

```sh
dotnet restore api/Plus.Api.Tests/Plus.Api.Tests.csproj --locked-mode
dotnet test api/Plus.Api.Tests/Plus.Api.Tests.csproj --no-restore
ASPNETCORE_ENVIRONMENT=Development dotnet run --project api/Plus.Api --urls http://127.0.0.1:5180
```

`GET http://127.0.0.1:5180/health/live` returns `{"status":"alive"}`. This checks
the process only; it does not claim SQL or authentication is configured.
`POST /api/v2/exec` requires a signed access token even in Development. The
checked-in configuration has no trusted issuer, no database grants, and no
enabled operations. No database is contacted by the automated tests.

During initial implementation an SDK was installed temporarily at
`/tmp/prov1-dotnet/dotnet`, with packages at `/tmp/prov1-nuget`. This temporary
installation can be removed by macOS; install an SDK normally for ongoing work.

## Request contract

```http
POST /api/v2/exec
Authorization: Bearer <access-token>
Content-Type: application/json

{
  "database": "MEGA25",
  "proc": "Pls.APIPlusCashReceiveOperation",
  "operation": "View",
  "lineData": { "InternalID": 123 },
  "extraParams": { "LineMember": [{ "Amount": 10 }] }
}
```

This illustrates the transport shape, not an enabled or verified SQL operation.
`LineMember` can be structured JSON (serialized once) or an existing JSON string.
The selected operation must explicitly allow that parameter and the procedure
must declare it. `lineData` accepts objects, arrays or null. Omitted fields retain
SQL defaults; explicit null binds SQL NULL. Numeric/boolean SQL parameters accept
JSON numbers/booleans, not numeric strings. Dates use `yyyy-MM-dd`; timestamps use
ISO 8601; binary values use base64. Values outside supported .NET decimal range
are rejected rather than rounded.

The server supplies `@User`, `@IP`/`@ClientIP`, `@AccessZone`, and `@DbKey` where
declared. Client attempts to supply these, `SqlStatement`, status outputs or
unapproved extra parameters are rejected. Unknown top-level properties are also
rejected. `@Operation`, `@User` and an integer `@State OUTPUT` are required in every
enabled procedure. Required SQL inputs omitted by the caller fail in SQL before
the procedure runs; optional inputs keep their SQL defaults. Output parameters
are output-only; input/output contracts need an explicit future extension.

```json
{
  "ok": true,
  "state": 0,
  "message": "",
  "data": { "List0": [], "List1": [] },
  "outputs": { "State": 0, "Message": "" },
  "traceId": "request-correlation-id"
}
```

Result-set ordering and column names are preserved. Output `State != 0`, a
one-row result with exactly `State` + `Message` reporting failure, or a configured
`StatusResultSet` reporting failure makes the response unsuccessful. For other
status-row formats, configure the zero-based status result-set index after
reviewing that operation. A normal business `State` column alone is not status.
SQL failure messages and failed result payloads are redacted. There is no automatic
retry or legacy fallback. A timeout/cancel/disconnection can occur after a write
commits: verify the document before retrying.

HTTP statuses: `200` success, `400` invalid request, `401` invalid/missing token,
`403` denied, `422` procedure failure, `429` rate limited, `502` invalid/oversized
SQL result, `503` missing server configuration/contract, `504` SQL timeout, `500`
other execution errors. Responses include a trace ID; request bodies and SQL
exception text are not logged.

## Configure authentication and database access

To configure SQL credentials directly in the API project, copy
`Plus.Api/appsettings.Sql.example.json` to `Plus.Api/appsettings.Sql.local.json`
and replace `YOUR_SQL_SERVER`, `YOUR_SQL_USERNAME`, and `YOUR_SQL_PASSWORD`.
Adjust the database name and port as needed. A local template was created during
setup; it contains placeholders only. Use connection-string quoting for passwords
containing semicolons and JSON escaping for backslashes or double quotes.
The `MEGA25` connection name matches `Gateway:Databases:MEGA25:ConnectionStringName`.
Restart the API after editing. Database/user/operation grants remain separately
configured and are not enabled by adding credentials.

This local file is ignored by Git and excluded from build/publish output.
On a deployed host, supply it separately in the application's content directory
or use environment variables, which override it. Do not put real credentials in
the example file or React source.

Use `dotnet user-secrets --project api/Plus.Api ...` for local secrets or environment
variables on the host. Do not put credentials, private keys or real user mappings
in committed files. Environment keys use double underscores:

- `Authentication__Issuer`: exact trusted issuer.
- `Authentication__Audience`: `plus-api-v2` or your chosen API audience.
- `Authentication__Authority`: HTTPS OIDC authority with signing-key discovery;
  alternatively `Authentication__PublicKeyPem`: an RSA **public** verification key.
  Configure exactly one key source. The API does not need a private signing key.
- `ConnectionStrings__MEGA25`: server-controlled SQL connection string.
- `Gateway__...`: policies shown in [configuration.example.json](configuration.example.json).
- `AllowedHosts`: actual API hostnames; default configuration permits localhost only.

Tokens must be RS256-signed access tokens with `typ: at+jwt`, a stable `sub`,
matching `iss`/`aud`, and unexpired `exp`. Tokens marked
`force_password_change: "true"` cannot execute operations. Production configuration
now enables built-in ERP login, refresh, logout and password changes. It uses a
server-generated RSA key and a fixed SQL authentication adapter; no external JWT
service is needed. The API validates the SQL session on each authenticated request.
External OIDC/public-key mode remains available when `LocalLoginEnabled` is false.
Do not use the legacy browser login response as an access token.

External identity grants match **issuer + subject**, then map to a local SQL username
for that database. Local login instead creates a persistent subject in the selected
database and binds its session/token to that database and canonical ERP username.
A same-named account in another database grants no access: log in separately there.
Operation policies currently live in server configuration, not `PlusApiControl`.
Revoking a configured mapping takes effect on the next request after configuration
reload; environment changes require a process restart. Local session revocation is
SQL-backed, including refresh replay, logout and account/password state checks.

Every database and procedure/operation pair is denied unless enabled. The example
keeps both disabled intentionally. Before enabling any pair, verify SQL-side
page, query, row and operation permissions, and repair the legacy numeric-filter
SQL injection paths. Gateway authorization does not replace Query Master or ERP
permissions. `ExecuteScript`, legacy `Login`, `SaveSystemUser` and
`DeleteSystemUser` are hard-blocked. Authentication and user management need the
dedicated adapters described in the plan.

Connections force encryption. Certificate validation is enabled by default;
setting `TrustServerCertificate=True` in the server-side connection string skips
certificate verification for both authentication and business execution. This
keeps traffic encrypted but does not verify the SQL server's identity.
Grant the service SQL principal `EXECUTE` and `VIEW DEFINITION` only on reviewed
procedures. Dynamic SQL dependencies require reviewed module signing/explicit
least-privilege grants; do not grant `db_owner` to make the router work.
Metadata uses `system_type_id` (supports scalar alias types), correct Unicode/MAX
lengths, precision and scale, cached for ten minutes per database/procedure.
Restart after signature changes to invalidate it immediately. Table-valued,
CLR, variant and legacy LOB parameter types are rejected.

## Network and deployment policy

The socket IP determines the zone. All addresses are external unless they match
`InternalNetworks` (IPv4/IPv6 CIDRs). Both the database and operation must permit
external access. No proxy headers are trusted by default. Behind a reverse proxy,
configure its exact address in `KnownProxies`; only one forwarding hop is accepted.
The proxy must overwrite forwarded headers and the backend must not be publicly
reachable around it. Restart when changing proxy or CORS configuration.

Production requires an initialized signing key (or configured external JWT verification) and HTTPS (directly or from the
trusted proxy). Configure exact CORS origins. No wildcard origins or browser
credentials are allowed. Limits: 1 MiB request body, 120 requests/minute per IP
per process, 30-second SQL command timeout, 10,000 total result rows, 32 datasets,
8 MiB serialized row data. Result values are buffered before the size check, so
SQL queries must also bound large individual LOB values. Distributed deployments
need a shared/edge limiter and a durable audit-log sink.

Publish with:

```sh
dotnet publish api/Plus.Api/Plus.Api.csproj -c Release -o /tmp/plus-api-v2-publish
```

Do not expose this service to ERP users until the remaining work is complete.

## Remaining before ERP cutover

1. Deploy and validate `SQLScript/V1ApiAuthSetup.sql` against the actual ERP user
   schema. Confirm `IPRestriction` semantics; the current adapter accepts an empty
   value/0 or one exact IP and denies other formats. Validate counters, password
   expiry, password updates and cross-database permissions on a test account.
2. Initialize the signing key on IIS, verify the full login/refresh/logout flow
   against SQL and configure secure key backup/rotation and session cleanup.
3. Replace configuration-backed grants with `PlusApiControl` repositories and
   durable access logs. Keep the configuration mode for isolated tests.
4. Repair and audit the router/query builder and custom procedure permissions;
   verify each operation's SQL status contract on a non-production database.
5. Add SQL integration tests for alias types, permissions, multiple datasets,
   transaction failures, limits and cancellation. Existing tests use a fake SQL
   executor and do not establish live SQL compatibility.
6. Add the React v2 adapter and token handling behind an explicit cutover flag.
   Never fall back to v1 or retry a write automatically. Implement idempotency
   before introducing write retries.
7. Configure the real host, TLS, trusted proxy, CORS, secret storage and monitoring;
   deploy and verify deliberately. Nothing has been deployed by this change.

Design: [general-api-v2-plan.md](../docs/general-api-v2-plan.md).
JWT reference: [Microsoft JWT bearer configuration](https://learn.microsoft.com/en-us/aspnet/core/security/authentication/configure-jwt-bearer-authentication?view=aspnetcore-10.0).

## SQL-managed gateway permissions

The IIS production configuration uses `UseSqlOperationPermissions: true` for
MEGA25. Deploy `SQLScript/V1ApiOperationPermissions.sql` before this API version;
it creates `PLS.V1ApiOperationPermission` and seeds GetPagesAndGroups. Grant the
API database principal SELECT on that table. Admins can insert/update permission
rows in SQL; each execution reads the current row without a cache or IIS restart.
No JSON operation fallback occurs in SQL mode. This controls gateway exposure,
not ERP user/page/query permissions. See `IIS-DEPLOYMENT.md` for the upgrade steps
and SQL examples. Configuration-based grants remain available when the switch is
false (the default for existing non-production configurations).
