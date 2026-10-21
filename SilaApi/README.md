# Sila API (gateway)

ASP.NET Core 10 API for Sila, copied from the PlusV1 API (`../../PlusV1/api`):
local login with signed tokens and SQL-backed sessions, and an allowlisted
stored-procedure gateway (`POST /api/v2/exec`). Same code as PlusV1; the
Sila-specific parts are the configuration and `SQLScript/APIPlusUserOperationV1.sql`.

| | |
|---|---|
| URL | `https://sila.glcpaints.com:7400` |
| Database key | `SILA101` |
| Settings | `Plus.Api/appsettings.Production.json`; SQL connection in `appsettings.Sql.local.json` beside the dll (git-ignored, never in the zip) |
| SQL objects | `SQLScript/V1ApiTables.sql`, `APIPlusUserOperationV1.sql`, `APIPlusAuthSessionOperation.sql`, `V1ApiOperationPermissionSeed.sql` |
| Server setup | [docs/IIS-DEPLOYMENT.md](docs/IIS-DEPLOYMENT.md) |
| Adding procedures | [docs/INTEGRATION.md](docs/INTEGRATION.md) |

Attachments (`/api/v2/attachments`) are in the code but stay off (503) until
an `Attachments` section is configured.

## Run, test, publish

Needs the [.NET 10 SDK](https://learn.microsoft.com/en-us/dotnet/core/install/macos). From the repository root:

```sh
dotnet test SilaApi/Plus.Api.slnx
ASPNETCORE_ENVIRONMENT=Development dotnet run --project SilaApi/Plus.Api --urls http://127.0.0.1:5180
dotnet publish SilaApi/Plus.Api/Plus.Api.csproj -p:PublishProfile=IIS   # -> SilaApi/IIS Publish/Plus.Api/
```

Then zip `SilaApi/IIS Publish/Plus.Api/` as `SilaApi/IIS Publish/Plus.Api-IIS.zip`
and copy it to the server.

## Request contract

```http
POST /api/v2/auth/login
{"database":"SILA101","username":"...","password":"..."}

POST /api/v2/exec
Authorization: Bearer <accessToken>
{"database":"SILA101","proc":"CHA.APISilaOperationV1","operation":"Ping","lineData":{"ApiKey":"..."}}
```

The server supplies `@User` (from the token), `@IP`/`@ClientIP`, `@AccessZone` and
`@DbKey`; a client can't. Every procedure + operation is denied unless it has an
enabled row in `PLS.V1ApiOperationPermission`. `ExecuteScript`, `Login`,
`SaveSystemUser`, `DeleteSystemUser` and the auth adapter are always blocked.

## Live channel (WebSocket)

`POST /api/v2/live/ticket {"database":"SILA101"}` with the Bearer token returns a
one-time `ticket` (30 s). Open `wss://sila.glcpaints.com:7400/api/v2/live?ticket=...`.
The socket says only "something changed" and who is online; data still comes
from `/api/v2/exec`. Frames: `hello {user, online[]}`, `presence {user, online}`,
`pong` (answer to `{"type":"ping"}`). The session is re-checked in SQL every
5 minutes; logout or a password change closes it with code 4401. Limits: 10
sockets per user, 4 KB frames, 20 frames / 10 s. Settings: `Live` section
(`Plus.Api/Live/LiveOptions.cs`); off unless `Live:Enabled` is true. One IIS
worker process only (no shared backplane yet).
