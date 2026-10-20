# Sila

Fresh React + Vite shell carried over from ProV1 — API layer, shared UI/UX
components, theme, and core admin screens only. No business pages.

## What's included

| Area | Files |
|------|-------|
| API | `src/shared/api.js` (`apiCall`), `vite.config.js` dev proxy |
| Shared UI | `src/shared/` — `DataGrid`, `DynamicFilterBar`, `FilterPanel`, `SearchableSelect`, `LookupSelect`, `ReportMenu`, `GenericMasterPage`, `ConfirmDialog`, … |
| Admin screens | `src/pages/core/` — User Master, Group & Page Master, Query / Query Filter / Operation / Group By / Report Master, User Permissions, Notification Settings |
| Auth / perms | `src/shared/permissions.js` (`hasOperation`) |
| Theme | `src/index.css` + the CSS variable set / layout injected from `src/App.jsx` |
| Shell | `src/App.jsx` — login, collapsible sidebar, tab bar, themes, ErrorBoundary. Sidebar is built live from `GetPagesAndGroups`; server-registered Simple CRUD pages render via `GenericMasterPage`. |
| Gateway | `api/` — the .NET gateway (`Plus.Api`), same as ProV1 |

## Getting started

```bash
npm install
npm run dev
```

The dev server proxies `/api` to `sila.silasystem.com:7103` (see `vite.config.js`).
Every operation goes through one stored procedure, `Pls.APIPlusOperationV1`
(source in `../ProV1/SQLScript/`).

## Adding a page

1. Drop the component in `src/pages/`.
2. Register it in `PAGE_COMPONENTS` in `src/App.jsx` keyed by its `PageGroupID`.
