# Deploy the Sila API (v2) with built-in login

Target: `https://sila.glcpaints.com:7400`, database key `SILA101`.
Same code as the PlusV1 API; only the configuration and the user procedure differ.
The publish contains local JWT issuance; no external login service is required.

## One-time installation

1. Create an IIS site (or application) for this API with an HTTPS binding on
   port 7400 for `sila.glcpaints.com`, and a dedicated application pool with
   **No Managed Code**. The .NET 10 Hosting Bundle must be installed.
2. Stop only this API's pool and extract `Plus.Api-IIS.zip` into the site folder.
   On later upgrades keep `App_Data/` and `appsettings.Sql.local.json`; never
   delete and recreate the signing key.
3. In an elevated PowerShell in the site folder:

   ```powershell
   .\Setup-IIS.ps1 -AppPoolName "YOUR_API_POOL_NAME"
   ```

   It creates `App_Data/auth-signing-key.pem` (kept if it already exists) and
   gives the pool read access to it.
4. In SSMS, against `SILA101`, run these scripts from the `SQL/` folder, in order.
   All are idempotent (safe to re-run):
   1. `V1ApiTables.sql` -- `PLS.V1ApiIdentity`, `PLS.V1ApiSession`,
      `PLS.V1ApiRefreshToken`, `PLS.V1ApiOperationPermission`.
   2. `APIPlusUserOperationV1.sql` -- Sila's user procedure: checks passwords
      against `dbo.UserMaster` and logs attempts in `dbo.UserLoginHistory`.
   3. `APIPlusAuthSessionOperation.sql` -- the session adapter (login / refresh /
      validate / logout / change password).
   4. `V1ApiOperationPermissionSeed.sql` -- the operation allowlist.
5. Create `appsettings.Sql.local.json` beside `Plus.Api.dll` (it is not in the zip):

   ```json
   { "ConnectionStrings": { "SILA101": "Server=...;Database=SILA101;User ID=...;Password=...;Encrypt=True;TrustServerCertificate=True;" } }
   ```

   `TrustServerCertificate=True` keeps traffic encrypted but skips verifying the
   SQL server's certificate. Give the pool read access to the file.
6. Grant the API's SQL principal EXECUTE on `PLS.APIPlusAuthSessionOperation` and on
   each allowlisted procedure, and SELECT on `PLS.V1ApiOperationPermission`.
   Never `db_owner`.
7. Start the pool and open `https://sila.glcpaints.com:7400/health/live`.
   Expected: `{"status":"alive"}`. That checks startup only; a successful login
   checks the SQL side.

## Sign-in rules (Sila)

- Password = `DecryptByPassPhrase('key', UserMaster.hash)`, as in the legacy login.
  The legacy master passwords are **not** accepted.
- `IsNotActive` must be 0. A user whose `ChangePasswordDate` is NULL must change
  the password in the existing Sila app first.
- 5 failed attempts within 15 minutes block that user for 15 minutes.
- Normal sessions last seven days; access tokens five minutes.

## Endpoints

Login with the **Sila username and password**, not the SQL server login:

```http
POST /api/v2/auth/login
Content-Type: application/json

{"database":"SILA101","username":"SILA_USERNAME","password":"SILA_PASSWORD"}
```

Returns `accessToken`, `refreshToken`, `tokenType: "Bearer"`, `expiresAt`,
`sessionExpiresAt`, `database`, `username`, `displayName`, `mustChangePassword`.
Use `Authorization: Bearer <accessToken>` on execution, logout and password changes.
Tokens carry no password or SQL credentials. Refresh secrets are stored only as
SHA-256 hashes in SQL. Do not log tokens or save them in public/shared locations.

```http
POST /api/v2/auth/refresh
Content-Type: application/json

{"database":"SILA101","refreshToken":"PREVIOUS_REFRESH_TOKEN"}
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

Rebuild with `dotnet publish SilaApi/Plus.Api/Plus.Api.csproj -c Release -p:PublishProfile=IIS`.
Microsoft hosting reference: [Publish to IIS](https://learn.microsoft.com/en-us/aspnet/core/tutorials/publish-to-iis?view=aspnetcore-10.0).

## Manage gateway operation permissions in SQL

Deploy the updated API once, with `UseSqlOperationPermissions: true` under
`Gateway:Databases:SILA101` (included in the production configuration). Run
`SQL/V1ApiOperationPermissionSeed.sql` first. Preserve `App_Data` and
`appsettings.Sql.local.json` during the upgrade.

Each ERP database has its own `PLS.V1ApiOperationPermission` table. The API reads
it for every execution request without caching. No IIS recycle or JSON edit is
needed when changing rows. Requests already authorized may finish after a change.
Missing/disabled rows deny access; a SQL read failure stops execution. JSON
`Procedures` entries are ignored in SQL mode. Database connection settings,
local login and the database-level `AllowExternal` gate stay in server config.

```sql
USE [SILA101];
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
