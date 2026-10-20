# Deploy API v2 with built-in ERP login

Target: `https://sila.silasystem.com:7400`, IIS physical folder `E:\API\APIV1`.
The publish contains local JWT issuance; no external login service is required.
The local tests exercise HTTP authentication with a fake SQL store. They do not
establish live SQL compatibility. No live database changes were made.

## One-time installation

1. Stop only this API's application pool and extract the publish ZIP contents into
   `E:\API\APIV1`. Keep the existing `App_Data` folder and SQL credentials on future
   upgrades. Do not delete and recreate the signing key when updating the app.
2. The .NET 10 Hosting Bundle must be installed. Use a dedicated application pool
   with No Managed Code, Integrated pipeline and an HTTPS binding on port 7400.
3. In an elevated PowerShell, replace `YOUR_API_POOL_NAME` with the pool assigned
   to this site in IIS Manager, then run:

   ```powershell
   cd E:\API\APIV1
   .\Setup-IIS.ps1 -AppPoolName "YOUR_API_POOL_NAME"
   ```

   The script creates `App_Data/auth-signing-key.pem` using .NET and grants read
   access to that pool identity. Administrators and SYSTEM retain full control.
   It preserves an existing key. If PowerShell policy blocks the script, follow
   your server's script-approval policy. The equivalent key creation command is
   `dotnet .\Plus.Api.dll --initialize-auth`, but you must still configure the
   directory ACL. Custom app-pool service identities need their own read grant.
4. Review and run the included `SQL/V1ApiAuthSetup.sql` in SSMS. It targets
   `ERPMega25` and reads `ERPManagement25.System.UserMaster`. It creates only the
   `PLS.V1ApiIdentity`, `PLS.V1ApiSession`, `PLS.V1ApiRefreshToken` tables/indexes
   and the dedicated `PLS.APIPlusAuthSessionOperation` adapter. It does not alter
   the generic router. Run a copy targeting each additional allowed ERP database.
5. Provide `appsettings.Sql.local.json` beside `Plus.Api.dll`, or set
   `ConnectionStrings__MEGA25` on the server. This file is intentionally excluded
   from the ZIP. The application pool needs read access. The SQL connection must
   use encryption. For this deployment, append `TrustServerCertificate=True;`
   to the `MEGA25` connection string to skip SQL certificate verification.
   Traffic remains encrypted, but the SQL server's identity is not verified.
6. Grant the API service principal EXECUTE on the auth adapter and reviewed access
   to its identity dependencies (or use module signing). The adapter reads user
   credentials/flags and updates `AttemptCounter`; password changes update `hash`,
   `PasswordExpired`, and `PasswordLastChangeDate`. Do not grant browser users
   access to this SP. It cannot be executed through the generic `/api/v2/exec`.
7. Run `SQL/V1ApiOperationPermissions.sql` in SSMS against each allowed ERP database.
   Grant the API database principal SELECT on `PLS.V1ApiOperationPermission`.
8. Start the pool and open `/health/live`. Expected response: `{"status":"alive"}`.
   Health checks startup only; a successful login separately verifies the adapter.

The included `appsettings.Production.json` sets the actual HTTPS issuer and allowed
hostname, enables local login to `MEGA25`, and permits external login. The production configuration enables SQL operation permissions. The setup script
seeds only `PLS.APIPlusOperationV1 / GetPagesAndGroups`; other operations need
reviewed rows in `PLS.V1ApiOperationPermission`.
Logging in authenticates an ERP user; it does not bypass SQL page/query/row/action
permissions. The existing React application still uses its previous API.

## Verify the ERP adapter before use

Required UserMaster columns: `Username`, `Name`, `hash`, `IsNotActive`,
`AttemptCounter`, `PasswordExpired`, `PasswordLastChangeDate`, `ExpiredDays`,
`IPRestriction`. The adapter preserves the existing `EncryptByPassPhrase('key', …)`
format for legacy compatibility. Password comparison is exact and case-sensitive.
The reversible legacy password format has not been upgraded by this change.

Accounts lock at five consecutive failed attempts, using the ERP `AttemptCounter`.
An administrator must unlock them through the existing ERP workflow. A successful
login clears the counter. Disabled accounts cannot log in or use existing sessions.
An expired password receives a restricted token and a ten-minute session for
password change/logout only. Normal sessions have a fixed seven-day expiry;
access tokens last at most five minutes.

`IPRestriction` is not fully documented in this repository. Current supported
values are empty/NULL/`0` (unrestricted), or one exact client IP. Lists and other
non-empty flags deny login. Confirm the actual semantics before enabling accounts
that use restrictions. Configure only trusted proxy addresses if hosting behind
an additional reverse proxy. Never accept an IP supplied in the request body.

Use a non-production/test account to verify: valid/invalid password; disabled and
locked users; password expiry/change; IP restrictions; canonical username; refresh
rotation and replay; logout; password reset invalidation; and concurrent refresh.
The SQL session and consumed refresh hashes survive IIS recycling. A password
change/reset invalidates earlier sessions when their credential stamp is checked.
Refreshing/logging out does not cancel SQL work that is already in flight.

## Endpoints

Login with the **ERP username and password**, not the SQL server login:

```http
POST /api/v2/auth/login
Content-Type: application/json

{"database":"MEGA25","username":"ERP_USERNAME","password":"ERP_PASSWORD"}
```

Returns `accessToken`, `refreshToken`, `tokenType: "Bearer"`, `expiresAt`,
`sessionExpiresAt`, `database`, `username`, `displayName`, `mustChangePassword`.
Use `Authorization: Bearer <accessToken>` on execution, logout and password changes.
Tokens carry no password or SQL credentials. Refresh secrets are stored only as
SHA-256 hashes in SQL. Do not log tokens or save them in public/shared locations.

```http
POST /api/v2/auth/refresh
Content-Type: application/json

{"database":"MEGA25","refreshToken":"PREVIOUS_REFRESH_TOKEN"}
```

Refresh returns a new access/refresh pair. Serialize refresh requests: reusing a
consumed token revokes that entire session, including the most recent access token.
Do not automatically retry refresh after a lost response; sign in again. Sessions
and tokens are bound to the login database; log in separately for another database.

`POST /api/v2/auth/logout` takes a Bearer access token and no body. It returns 204
and revokes that session. Other devices' sessions remain active.

```http
POST /api/v2/auth/change-password
Authorization: Bearer <accessToken>
Content-Type: application/json

{"currentPassword":"OLD_PASSWORD","newPassword":"A_DIFFERENT_PASSWORD"}
```

The new password must be different and 12–100 characters long. Successful change
requires a new login and invalidates existing sessions. Forced-change access tokens
can call this endpoint, logout and refresh, but cannot execute business operations.
Invalid credentials return 401; invalid fields return 400; denied databases return
403; SQL/setup errors return a redacted failure with a trace ID.

## Operations and maintenance

- All public endpoints are HTTPS-only in Production. Login/refresh/password-change
  endpoints share a 10 requests/minute/IP limit per process; account lockout is in
  SQL and shared across processes. Add an edge limiter for multiple instances.
- Back up the signing key securely. Multiple IIS instances must share the same
  signing key and database session tables. A replacement key invalidates access
  tokens; for an emergency global logout, also revoke sessions in SQL. Dual-key
  rollover/JWKS publication is not implemented.
- Preserve consumed refresh hashes until their sessions expire to detect replay.
  Schedule cleanup of expired sessions' tokens first, then their session rows.
  Subject mappings should be retired when ERP accounts are deleted; account
  lifecycle administration is not implemented in this gateway.
- Check Windows Event Viewer/Application or run `dotnet .\Plus.Api.dll` from the
  publish folder for startup errors. Missing key: run setup. Missing SQL adapter
  affects login, not health. Never switch to Development to bypass verification.

Rebuild with `dotnet publish api/Plus.Api/Plus.Api.csproj -c Release -p:PublishProfile=IIS`.
Microsoft hosting reference: [Publish to IIS](https://learn.microsoft.com/en-us/aspnet/core/tutorials/publish-to-iis?view=aspnetcore-10.0).

## Manage gateway operation permissions in SQL

Deploy the updated API once, with `UseSqlOperationPermissions: true` under
`Gateway:Databases:MEGA25` (included in the production configuration). Run
`SQL/V1ApiOperationPermissions.sql` first. Preserve `App_Data` and
`appsettings.Sql.local.json` during the upgrade.

Each ERP database has its own `PLS.V1ApiOperationPermission` table. The API reads
it for every execution request without caching. No IIS recycle or JSON edit is
needed when changing rows. Requests already authorized may finish after a change.
Missing/disabled rows deny access; a SQL read failure stops execution. JSON
`Procedures` entries are ignored in SQL mode. Database connection settings,
local login and the database-level `AllowExternal` gate stay in server config.

```sql
USE [ERPMega25];
SELECT * FROM PLS.V1ApiOperationPermission;

-- Enable or disable the seeded read operation:
UPDATE PLS.V1ApiOperationPermission
SET Enabled = 1, AllowExternal = 1
WHERE ProcedureName = N'PLS.APIPlusOperationV1'
  AND OperationName = N'GetPagesAndGroups';

-- Example: allow another reviewed operation without replacing existing settings.
IF NOT EXISTS (SELECT 1 FROM PLS.V1ApiOperationPermission
    WHERE ProcedureName = N'PLS.APIPlusOperationV1'
      AND OperationName = N'GetUserAllowedPages')
INSERT PLS.V1ApiOperationPermission
    (ProcedureName, OperationName, Enabled, AllowExternal, AllowedParametersJson)
VALUES (N'PLS.APIPlusOperationV1', N'GetUserAllowedPages', 1, 1, N'[]');
```

Use the exact procedure/operation spelling in requests and table rows. `Enabled`
permits execution; `AllowExternal` additionally permits clients outside configured
internal networks. `AllowedParametersJson` is an array of extra parameter names,
e.g. `["LineMember"]`; `lineData` is already supported and server-owned parameters
cannot be overridden. Keep `StatusResultSet` NULL unless the operation explicitly
returns a status dataset; otherwise it is that dataset's zero-based index.

Only database administrators should modify this table. Give the API principal
SELECT, not write permissions, on it. This is a gateway exposure allowlist, not a
per-user ERP permission table: existing user/page/query/action checks remain the
responsibility of the executed procedure. ExecuteScript, legacy Login,
SaveSystemUser, DeleteSystemUser and the auth adapter remain blocked by API code.
