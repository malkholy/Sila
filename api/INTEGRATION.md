# Plus.Api — integration guide (using the API in another project)

`Plus.Api` is a small ASP.NET Core (.NET 10) gateway that lets a browser or app call
**allow-listed SQL Server stored procedures** safely:

- The caller signs in and gets a short-lived **JWT**.
- Every call names a **database key**, a **procedure** and an **operation**.
- The gateway checks that combination against an allowlist.
- It binds **typed** parameters from the procedure's own metadata and fills the
  identity fields itself (the user, the IP, internal or external).
- It returns every result set in one standard **envelope**.

Nothing in the gateway is specific to this ERP. To reuse it you provide:
1. the configuration;
2. stored procedures that follow the [procedure contract](#3-the-stored-procedure-contract);
3. rows in the [operation allowlist](#4-the-operation-allowlist);
4. an [auth adapter](#5-authentication) for *your* user table, or an external identity provider.

> **Status (2026-09-26):** built and unit-tested with a fake SQL layer; **not yet
> validated against a live SQL Server and not yet in use by the ERP**. See
> [README.md → Remaining before ERP cutover](README.md#remaining-before-erp-cutover).
> Run it against a test database first.

Related: [README.md](README.md) (build, run, full request rules) ·
[IIS-DEPLOYMENT.md](IIS-DEPLOYMENT.md) (this ERP's IIS deployment) ·
[design plan](../docs/general-api-v2-plan.md).

---

## 1. How a request flows

```
POST /api/v2/exec  (Bearer JWT)
  │
  ├─ HTTPS required (outside Development) · 1 MiB body · 120 req/min per IP
  ├─ JWT validated: RS256, issuer, audience, lifetime, typ = at+jwt
  │    └─ built-in login: session re-checked in SQL on every request
  │       (revoked/expired/disabled user or changed password → 401)
  ├─ zone = internal | external, from the socket IP vs InternalNetworks
  ├─ database key known + Enabled; external → database.AllowExternal
  ├─ operation found in the allowlist + Enabled; external → operation.AllowExternal
  ├─ parameters: typed from sys.parameters; identity fields set by the server
  ├─ EXEC procedure (30 s timeout) → result sets List0..List31
  └─ envelope { ok, state, message, data, outputs, traceId }
       ok = false when output @State ≠ 0 or a State/Message row reports failure
```

---

## 2. Setting it up for a new project

### 2.1 Configuration (`appsettings.json` + environment)

```json
{
  "AllowedHosts": "api.myproject.com",
  "Authentication": {
    "LocalLoginEnabled": true,
    "Issuer": "https://api.myproject.com",
    "Audience": "plus-api-v2",
    "SigningKeyPath": "App_Data/auth-signing-key.pem"
  },
  "Gateway": {
    "CommandTimeoutSeconds": 30,
    "MaxResultRows": 10000,
    "MaxResultBytes": 8388608,
    "InternalNetworks": ["192.168.1.0/24", "203.0.113.10/32"],
    "KnownProxies": [],
    "CorsOrigins": ["https://app.myproject.com"],
    "Databases": {
      "MAIN": {
        "DisplayName": "My Project",
        "ConnectionStringName": "MAIN",
        "Enabled": true,
        "AllowExternal": true,
        "LocalLoginEnabled": true,
        "UseSqlOperationPermissions": true
      }
    }
  }
}
```

| Setting | Meaning |
|---|---|
| `Databases.<KEY>` | A **database key** that clients send as `"database"`. It is never the real database name. One entry per database or company. |
| `ConnectionStringName` | The name under `ConnectionStrings`. **Put the connection string outside git**: `appsettings.Sql.local.json` beside the DLL, or the environment variable `ConnectionStrings__MAIN`. Encryption is forced. |
| `Enabled` / `AllowExternal` | Database-level switches. An external caller needs `AllowExternal` on **both** the database and the operation. |
| `InternalNetworks` | CIDRs counted as "internal". Everything else is external. Include the office's **public** IP if users reach the API through its public name. |
| `KnownProxies` | Exact IP of a reverse proxy, if there is one. Forwarded headers are trusted **only** from these addresses, and only for one hop. |
| `CorsOrigins` | Exact browser origins; wildcards aren't allowed. Methods are GET/POST; headers are `Authorization` and `Content-Type`. |
| `UseSqlOperationPermissions` | `true`: the allowlist is a SQL table, read on every call (§4). `false`: it comes from `Procedures` in the configuration. |
| `LocalLoginEnabled` | `true`: the built-in login endpoints work for this database (§5.1). |

Configuration is validated at startup, and a bad value stops the app.
Changing `KnownProxies` or `CorsOrigins` needs a restart.

### 2.2 Signing key (built-in login only)

```sh
dotnet Plus.Api.dll --initialize-auth      # creates App_Data/auth-signing-key.pem (RSA 3072)
```

On IIS, `Setup-IIS.ps1 -AppPoolName "<pool>"` does the same and sets the ACL.
Back the key up. Replacing it signs everyone out. Multiple instances must share the same
key and the same SQL session tables.

### 2.3 SQL principal

Grant the API's SQL login **only** what it needs:

```sql
GRANT EXECUTE, VIEW DEFINITION ON OBJECT::dbo.MyProcedure TO [api_user];   -- per reviewed procedure
GRANT SELECT ON OBJECT::PLS.V1ApiOperationPermission TO [api_user];        -- read-only allowlist
GRANT EXECUTE ON OBJECT::PLS.APIPlusAuthSessionOperation TO [api_user];     -- built-in login only
```

Never grant `db_owner`. Procedures that build **dynamic SQL** lose ownership
chaining, so give them reviewed module signing or explicit least-privilege grants.

---

## 3. The stored-procedure contract

Any schema-qualified procedure (`Schema.Name`) can be exposed if it declares:

| Parameter | Required | Filled by |
|---|---|---|
| `@Operation` (text) | **yes** | the request's `operation` |
| `@User` (text) | **yes** | **the server**: the signed-in username. Never taken from the client. |
| `@State INT OUTPUT` | **yes** | the procedure: `0` = success, anything else = failure |
| `@Message ... OUTPUT` | optional | the procedure: returned in `outputs` on success |
| `@LineData` (nvarchar) | optional | the request's `lineData` (object or array → JSON text) |
| `@IP` / `@ClientIP` | optional | **server**: the caller's socket IP |
| `@AccessZone` | optional | **server**: `internal` / `external` |
| `@DbKey` | optional | **server**: the database key used |
| any other input | optional | `extraParams.<Name>`, **only** if the operation allows that name (§4) |

**Parameter types** (read from `sys.parameters`, cached for 10 minutes per database
and procedure; restart after changing a signature):

| SQL type | JSON value sent |
|---|---|
| `(n)varchar/(n)char` | string. An object or array is sent as its JSON text (so structured `LineMember` works). Length is enforced. |
| `int/bigint/smallint/tinyint` | JSON **number** (not `"12"`) |
| `bit` | JSON `true` / `false` |
| `decimal/numeric/money/smallmoney` | number. Precision and scale are enforced; values are **rejected, not rounded** |
| `float/real` | number |
| `date` | `"yyyy-MM-dd"` |
| `datetime/datetime2/smalldatetime/datetimeoffset` | ISO 8601 |
| `time` | `"hh:mm:ss"` |
| `uniqueidentifier` | GUID string |
| `binary/varbinary` | base64 |
| table-valued, CLR, `sql_variant`, `text/ntext/image`, `xml`, `timestamp` | **not supported**: the procedure is refused (503) |

A field you **omit** keeps its SQL default. An explicit `null` binds SQL `NULL`.
Output parameters are output-only; input/output parameters aren't supported.

**Reporting status.** A call is successful only when `@State OUTPUT = 0` **and**:
- no result set is exactly one row with exactly the columns `State` + `Message` and a
  non-zero `State` (the classic `CATCH` block pattern);
- and, if the operation sets `StatusResultSet = n`, row 1 of `List<n>` has `State = 0`.

On failure the gateway returns `ok:false`, **no data**, and a generic message.
SQL error text is never sent to the client, so log details in SQL if you need them.

Minimal template:

```sql
CREATE OR ALTER PROCEDURE app.APIOrders
    @Operation VARCHAR(100),
    @User      NVARCHAR(100),
    @LineData  NVARCHAR(MAX) = NULL,
    @ClientIP  VARCHAR(45)   = NULL,
    @State     INT           OUTPUT,
    @Message   NVARCHAR(500) OUTPUT
AS
BEGIN
    SET NOCOUNT ON; SET @State = 0; SET @Message = '';
    BEGIN TRY
        -- your own per-user permission check goes here (the gateway does not do it)
        IF @Operation = 'GetOrder'
        BEGIN
            SELECT OrderId, Customer, Total FROM app.Orders
            WHERE OrderId = TRY_CAST(JSON_VALUE(@LineData, '$.OrderId') AS INT);
            RETURN;
        END
        SET @State = 1; SET @Message = 'Unknown operation';
    END TRY
    BEGIN CATCH
        SET @State = ERROR_NUMBER(); SET @Message = 'Failed';
    END CATCH
END
```

---

## 4. The operation allowlist

**Nothing is callable until a database key + procedure + operation is explicitly enabled.**

SQL mode (`UseSqlOperationPermissions: true`): run `SQLScript/V1ApiOperationPermissions.sql`
in each database. It creates `PLS.V1ApiOperationPermission`:

| Column | Meaning |
|---|---|
| `ProcedureName` + `OperationName` (PK, binary collation) | exact spelling used in requests, e.g. `app.APIOrders` / `GetOrder` |
| `Enabled` | 0 = denied (the default) |
| `AllowExternal` | also allow callers outside `InternalNetworks` |
| `AllowedParametersJson` | extra parameter names the client may send, e.g. `["LineMember"]` (default `[]`) |
| `StatusResultSet` | zero-based index of a status dataset, or NULL (§3) |

```sql
INSERT PLS.V1ApiOperationPermission (ProcedureName, OperationName, Enabled, AllowExternal, AllowedParametersJson)
VALUES (N'app.APIOrders', N'GetOrder', 1, 0, N'[]');
```

- The table is read on **every** call, with no cache and no restart needed.
- A missing or disabled row, or a failed read, denies the call.
- In SQL mode there is no fallback to the configuration file.
- Configuration mode (`false`): the same fields live under
  `Databases.<KEY>.Procedures.<proc>.Operations.<op>`.

**Always blocked, whatever the allowlist says:** the operations `ExecuteScript`,
`Login`, `SaveSystemUser`, `DeleteSystemUser`, and the procedure
`PLS.APIPlusAuthSessionOperation`.
**Reserved names** that can't be sent as `extraParams`: `User, Username, IP, ClientIP,
AccessZone, DbKey, Database, Operation, LineData, SqlStatement, State, Message`.

> The allowlist controls **which calls reach SQL**. It is not a per-user permission
> system: user, page and row permissions must still be enforced **inside** your
> procedures, using the server-supplied `@User`.

---

## 5. Authentication

### 5.1 Built-in login (per database, against your own user table)

Set `LocalLoginEnabled: true` (globally and on the database), create the signing key
(§2.2), and deploy an **auth adapter** in that database. `SQLScript/V1ApiAuthSetup.sql`
is the reference implementation for this ERP. It reads
`ERPManagement25.System.UserMaster`.

**To use a different user table, keep the contract and rewrite only the user-table
parts** (where it reads the user and password, and where it updates the attempt
counter and password):

```sql
PLS.APIPlusAuthSessionOperation
    @Operation VARCHAR(30),          -- Login | Validate | Refresh | Logout | ChangePassword
    @ClientIP VARCHAR(45),
    @Username NVARCHAR(100) = NULL,  @Password NVARCHAR(100) = NULL,
    @NewPassword NVARCHAR(100) = NULL,
    @SessionId UNIQUEIDENTIFIER = NULL,
    @RefreshHash BINARY(32) = NULL,  @NewRefreshHash BINARY(32) = NULL
-- Success: return ONE row
--   SubjectId UNIQUEIDENTIFIER, SessionId UNIQUEIDENTIFIER, Username NVARCHAR,
--   DisplayName NVARCHAR, ForcePasswordChange BIT, ExpiresAt DATETIME2 (UTC)
-- Failure: return NO row (the gateway answers 401 and never says why)
```

Keep the three tables it uses (`PLS.V1ApiIdentity`, `PLS.V1ApiSession`,
`PLS.V1ApiRefreshToken`). Keep this behaviour so the gateway's guarantees still hold:
- deny inactive, locked-out (5 failed attempts in the reference) or IP-restricted users, and count each failure;
- store only the **hashes** of refresh tokens; a reused refresh token revokes the whole session;
- store a **credential stamp** on each session, so a password change invalidates all sessions;
- give an expired password a short "change-only" session (`ForcePasswordChange = 1`).

The reference keeps this ERP's legacy reversible password format
(`EncryptByPassPhrase`) for compatibility. **A new project should hash passwords
instead**, e.g. PBKDF2 or Argon2 computed in the application tier, or salted SHA-512 at minimum.

### 5.2 External identity provider (instead of built-in login)

Set `Authentication:Authority` (OIDC metadata) **or** `Authentication:PublicKeyPem`,
plus `Issuer` and `Audience`, and leave `LocalLoginEnabled` false. Tokens must be
RS256 with `typ: at+jwt`. Map each token identity to a database username:

```json
"Users": [ { "Issuer": "https://login.example.com", "Subject": "<sub claim>", "Username": "jsmith", "Enabled": true } ]
```

(under `Gateway:Databases:<KEY>`). An unmapped subject is denied.

---

## 6. Calling it from a client

### 6.1 Endpoints

| Method + path | Auth | Body | Returns |
|---|---|---|---|
| `GET /health/live` | none | — | `{"status":"alive"}` (process only) |
| `POST /api/v2/auth/login` | none, 10/min/IP | `{database, username, password}` | token response |
| `POST /api/v2/auth/refresh` | none, 10/min/IP | `{database, refreshToken}` | new token pair |
| `POST /api/v2/auth/logout` | Bearer | — | `204`, revokes this session |
| `POST /api/v2/auth/change-password` | Bearer | `{currentPassword, newPassword}` (12–100 chars, different) | `200`, then sign in again |
| `POST /api/v2/exec` | Bearer | `{database, proc, operation, lineData?, extraParams?}` | envelope |

Token response:

```json
{ "accessToken": "…", "refreshToken": "…", "tokenType": "Bearer",
  "expiresAt": "…", "sessionExpiresAt": "…",
  "database": "MAIN", "username": "jsmith", "displayName": "John Smith",
  "mustChangePassword": false }
```

- Access tokens last **up to 5 minutes**. Sessions last **7 days**, or 10 minutes when a password change is forced.
- A session is **bound to one database key**. To use another database, log in again.
- With `mustChangePassword: true`, the token can only change the password, refresh or log out. `/exec` returns 403.

### 6.2 Execute

```http
POST /api/v2/exec
Authorization: Bearer <accessToken>
Content-Type: application/json

{ "database": "MAIN", "proc": "app.APIOrders", "operation": "GetOrder",
  "lineData": { "OrderId": 42 } }
```

```json
{ "ok": true, "state": 0, "message": "",
  "data": { "List0": [ { "OrderId": 42, "Customer": "ACME", "Total": 150.00 } ] },
  "outputs": { "State": 0, "Message": "" },
  "traceId": "0HN…" }
```

Unknown top-level properties are rejected (400). Result-set order and column names
are kept exactly as SQL returns them.

### 6.3 HTTP status codes

| Code | Meaning | Client action |
|---|---|---|
| 200 | success (`ok: true`) | use `data` |
| 400 | invalid request, parameter or value | fix the call |
| 401 | missing, expired or revoked token | refresh once, else sign in |
| 403 | database, operation or zone denied, or password change required | don't retry |
| 422 | procedure reported failure (`ok: false`) | show a generic error with the `traceId` |
| 429 | rate limited | back off |
| 499 | request cancelled | verify the outcome before retrying |
| 502 | result too large or invalid | narrow the filters |
| 503 | server or procedure not configured, or the procedure doesn't follow the contract | fix setup |
| 504 | SQL timeout | **verify the outcome before retrying** (a write may have committed) |
| 500 | other error | verify the outcome before retrying |

Every error body is an envelope with `ok: false` and a `traceId`. Quote the traceId when reporting a problem.

### 6.4 Minimal JavaScript client

```js
export function createPlusApi({ baseUrl, database }) {
  let session = null;          // token response from login/refresh
  let refreshing = null;       // serialize refreshes: a reused refresh token kills the session

  const post = (path, body, token) => fetch(baseUrl + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  async function login(username, password) {
    const res = await post('/api/v2/auth/login', { database, username, password });
    if (!res.ok) throw new Error((await res.json()).message);
    session = await res.json();
    return session;            // check session.mustChangePassword
  }

  function refresh() {
    refreshing ??= (async () => {
      const res = await post('/api/v2/auth/refresh', { database, refreshToken: session?.refreshToken });
      if (!res.ok) { session = null; throw new Error('Session expired. Sign in again.'); }
      session = await res.json();
    })().finally(() => { refreshing = null; });
    return refreshing;
  }

  async function exec(proc, operation, lineData, extraParams) {
    const body = { database, proc, operation, lineData, ...(extraParams ? { extraParams } : {}) };
    let res = await post('/api/v2/exec', body, session?.accessToken);
    if (res.status === 401 && session) {        // expired access token: refresh once, then repeat
      await refresh();
      res = await post('/api/v2/exec', body, session.accessToken);
    }
    const envelope = await res.json();
    if (!envelope.ok) throw Object.assign(new Error(envelope.message), { status: res.status, traceId: envelope.traceId });
    return envelope;                             // envelope.data.List0 …
  }

  const logout = () => post('/api/v2/auth/logout', undefined, session?.accessToken).finally(() => { session = null; });
  return { login, refresh, exec, logout };
}
```

The 401 retry above is safe: a 401 is returned **before** the procedure runs.
Don't retry automatically after 5xx, 499 or a network failure, because a write may already have committed.
Keep tokens in memory, or at most in `sessionStorage`. Never put them in URLs or logs.

---

## 7. Limits (per process)

| Limit | Value |
|---|---|
| Request body | 1 MiB |
| Requests | 120/min per IP (login, refresh and change-password: 10/min per IP) |
| SQL command timeout | 30 s (`CommandTimeoutSeconds`, 1–120) |
| Result | ≤ 32 datasets, ≤ 10,000 rows in total, ≤ 8 MiB serialized |
| Account lockout (reference adapter) | 5 failed attempts, shared across instances through SQL |

Rate limits are per process. For several instances, add an edge or shared limiter.

---

## 8. New-project checklist

- [ ] Host with .NET 10 and HTTPS (IIS: see [IIS-DEPLOYMENT.md](IIS-DEPLOYMENT.md)).
- [ ] `appsettings.json`: `Issuer`, `Audience`, `AllowedHosts`, `CorsOrigins`, `InternalNetworks`, `KnownProxies`, `Databases`.
- [ ] Connection strings outside git (`appsettings.Sql.local.json` or `ConnectionStrings__<NAME>`).
- [ ] Signing key initialized and backed up (or an external IdP configured).
- [ ] Auth adapter deployed and tested on a test account: valid and invalid password, disabled, locked, expired password, refresh, reuse of a consumed refresh token, logout.
- [ ] Procedures follow §3 and enforce per-user permissions themselves.
- [ ] `PLS.V1ApiOperationPermission` created; only reviewed operations enabled; `AllowExternal` set deliberately.
- [ ] SQL principal has least privilege (§2.3).
- [ ] `GET /health/live` answers; one read and one write operation verified end to end on a test database.
