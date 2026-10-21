# Sila ERP — project contract

Standards every developer and AI agent MUST follow in this repo. The detail
lives in `.claude/skills/` — load the relevant skill before doing that kind of
work; this file is only the map.

## The golden rule

No page retrieves application data from an unmanaged query. Every dataset flows:

```
SQL View  →  Query Master  →  Page↔Query mapping  →  permission validation  →  Generic Operation (GetGridData)  →  frontend
```

The frontend never builds SQL, defines views, writes `GROUP BY`, bypasses Query
Master, or enforces authorization itself. Authorization is always server-side,
inside the query the Generic Operation runs. Hiding a field in the UI is not
security.

**No returned data without a permission check — even from a custom SP.** Every
dataset that leaves the server comes from a `V1QueryMaster`-registered query
with `V1UserPagePermissions` + `V1UserQueryPermissions` validated server-side
(admins bypass). A custom page-business SP resolves the registered query and
applies the same permission layering; it never free-hand `SELECT`s business rows.

**Every search lookup on a form/page is a `V1QueryFilter`, linked to that page,
served by `GetFilterOptions` with `V1UserFilterPermissions` enforced server-side.**
Vendor / Item / Warehouse / Buyer / Currency pickers included. The frontend never
issues the lookup query; a `QF` linked to another form is not usable until linked
here; form access is not lookup access.

**Every printed report is registered in Report Master (`V1ReportMaster`) and
linked to a Form or Grid before use.** Type is `React` (designed in-system —
preferred) or `Fast` (legacy). Data comes from a Query-Master query under the
normal permission flow; parameters and record scope are declared in config and
re-validated server-side; report + data-source + record + field access is checked
before generating. No Print button bypasses Report Master; a React Report is not
the Data View or Grid Export. See `query-engine/reference/printed-reports.md`.

**KPIs are configured centrally (`V1KPIMaster`), linked to a Page + Base query,
and calculated server-side against the grid's active Filter/Search.** Never
hardcode a KPI in a page; never create a `QV…Total` view per KPI. `GetKPIData`
wraps the page's Base query with one aggregate `SELECT` through the same
permission + filter pipeline as `GetGridData` (shared `PLS.V1BuildQueryPredicates`).
Fields are validated against `V1QueryFields`; Operation is a server enum.
See `query-engine` → "KPI framework".

## Skills (in `.claude/skills/`)

| Skill | Load it when… |
|---|---|
| **query-engine** | designing or reasoning about queries, pages, permissions, filters, operations, Group By, the `GetGridData` / `View` contract. Includes `reference/tables-and-sps.txt` — every table + SP operation and its objective. |
| **add-page** | adding a page, Base/Detail query, filter, operation, or Group By config — the step-by-step workflow + the column-suggestion ruleset. |
| **code-standards** | writing SQL or React in this repo — naming (`QV`/`QF`/`V1QD`), the router-SP deploy rule, idempotent DDL, "no arbitrary SQL from the client", React/theme/shared-component conventions, git rules. |
| **sila-db** | reading the Sila live DB (`SILA101`, behind :9201) via `[CHA].[APISilaOperationV1]`. Read-only; every run needs explicit approval. |
| **order-board** | giving a page the *Order Board* design (the Customer Order (ProV1) page design: Table + grouped views in a top filter panel, checklist filters, entity + party drawers, print / Preview) -- "use Order Board", "same design as Customer Order". |

## Non-negotiables (summary — see the skills for why)

- **Backend:** one router SP `Pls.APIPlusOperationV1` (`../ProV1/SQLScript/APIPlusOperationV1.sql` —
  Sila shares ProV1's backend; SQL scripts live in the ProV1 repo).
  Metadata in schema `[PLS]`, tables `V1*`. The SP is deployed **by a human in
  SSMS** — it cannot ALTER itself through `ExecuteScript`. All dynamic SQL is
  built from `V1*` metadata + server-side enums; never from a client string.
  `QUOTENAME` every dynamic identifier. DDL must be idempotent (`CREATE OR ALTER`,
  `IF OBJECT_ID(...) IS NULL`, `IF NOT EXISTS ... INSERT`).
- **Page business logic → its own SP.** `Pls.APIPlusOperationV1` is the generic
  engine + metadata + auth only. Any page-domain operation (create/update/delete
  a business record, approve, post, release, recalculate, generate a document,
  run a workflow) lives in a dedicated custom SP (e.g. `Pls.APIPurchaseOrderV1`),
  not a router branch — still permission-checked server-side and wired through
  `V1OperationMaster.Config`.
- **Views:** Base = `PLS.QV<Name>` (hand-authored). Filter = `PLS.QF<Name>`
  (built by `SaveQueryFilter`). Detail = `PLS.V1QD<name>` (built by
  `SaveQueryMaster`). Schema is always `PLS`.
- **Frontend:** React 18 function components + hooks, inline-style JSX, no CSS
  framework. Colours/spacing only via `var(--token)` from `src/index.css`.
  Server calls only via `apiCall(operation, lineData)` from `src/shared/api.js`.
  Reuse the shared components (`DataGrid`, `DynamicFilterBar`, `SearchableSelect`,
  `FieldAutocompleteInput`). Verify a `.jsx` file with
  `npx esbuild <file> --loader:.jsx=jsx --outfile=/dev/null`.
- **Query types:** every page-linked query is `Base` (one main dataset) or
  `Detail` (everything else). Group By is configuration over a Base query — never
  a new view.
- **Git:** branch off `main`; commit/push only when asked. Commit trailer
  `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`.

## Relationship to ProV1

Sila is a fresh shell carried over from ProV1: same API layer, gateway, shared
components, theme, and core admin screens (`src/pages/core`), but none of
ProV1's business pages. Skills under `.claude/skills/` are copied from ProV1;
where they reference `SQLScript/` or `docs/`, those live in `../ProV1/`.
