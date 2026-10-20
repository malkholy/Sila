# Printed Report Architecture (PlusV1)

## Golden rule

Every printed report is registered in **Report Master** first. Each report has a
type — **React Report** or **Fast Report**. React Reports are designed inside the
ERP system, then linked to a Form or a Grid before they can be used. No Print
button bypasses Report Master; no report runs arbitrary SQL from the client.

**React Report is the preferred method for all current and new development.**
Fast Report stays only for legacy / specifically-required cases.

## Report Master

Central registry of every printed report. `V1ReportMaster` (follow the repo's
`[PLS]` / `V1*` table + naming standards): `ReportID, ReportName, ReportCode,
ReportType (React|Fast), Description, IsActive, CreatedBy, CreatedDate,
LastMaintBy, LastMaintDate`. Typical React Reports: Purchase Order, Sales Order,
Invoice, Delivery Note, Payment Voucher, Receipt, Stock Transfer, Customer /
Vendor Statement, Transaction Listing.

## Workflow (mandatory)

```
Design report → Register in Report Master → Set Report Type → Configure layout
→ Link to Form or Grid → Assign / validate permission → Report available
```

## React Report designer (in-system, stored as metadata)

Configurable where applicable: report header/footer, page header/footer, data
fields, labels, text, images/logo, tables, column order / width / alignment,
font size / style, number format, date format, borders, totals, subtotals,
grouping, page size, orientation, margins. Layout config is system
metadata/configuration — not code, not an external designer.

## Data source

A React Report reads only an **approved system data source** — a query
registered in **Query Master**, subject to the same flow as everything else:

```
Report → registered Query / data source → permission validation → server operation → report data
```

Never arbitrary SQL from the frontend. Any query the report uses follows the
existing Query Master + authorization standards (page access,
`V1UserQueryPermissions`, field access).

## Form vs Grid linking

A report is used from a **Form** or a **Grid** — declared in its link config,
never assumed by the frontend.

- **Form report** — prints one transaction/document (Purchase Order Entry →
  "Purchase Order Print"). Parameter is the current form record's key.
- **Grid report** — prints a list from the grid's current context (Purchase
  Orders grid → "Purchase Order Listing"). The grid passes context (selected
  row / selected rows / current filters / search / date range / record key);
  the server re-validates every parameter.

Link config identifies: Report, Report Type, Form or Grid, Page, IsActive,
DisplayOrder, DisplayName. Form-report and grid-report mappings may be separate
tables. A Form/Grid may expose **several** reports (a `Print ▼` menu, e.g.
Purchase Order / without Prices / Internal / Vendor Copy) — each registered
individually in Report Master.

## Grid context scope

A grid-launched report's config **explicitly** states which records it prints:
current selected record · selected records · all currently filtered records ·
current page only · entire query result. The frontend must not decide this.

## Parameters

Reports may take parameters (`PurchaseOrderNumber`, `VendorNumber`, `FromDate`,
`ToDate`, `Warehouse`, `Status`, …). They come only from controlled sources —
current form record, selected grid row(s), an approved filter, validated user
input, page context — and every parameter is validated server-side before
execution.

## Permission (server-side, always)

A user only sees / runs reports they are authorized for. Before generating,
the server validates: Page access · Form/Grid access · **Report access** ·
Query / data-source access · access to the requested records · access to the
fields used in the report. Hiding a Print button is not authorization. A report
definition must never become a way to expose unauthorized data.

```
User → Form/Grid → Report Link → Report Master → permission validation → generate report
```

## Output

Print Preview · Print · PDF Export (more formats later if needed). The report
layout is independent of the browser grid display.

## Not the same as…

- **Data View** controls interactive page/grid presentation. A React Report has
  its own printable layout — the Data View columns do not define the printed
  document.
- **Grid Export** (e.g. Export to Excel) dumps the visible grid / Data View.
  A React Report uses its dedicated registered design. Do not treat Grid Export
  as a React Report.

## DO / DON'T

**DO** register every report in Report Master · set the Report Type · prefer
React Report for new work · design React Reports in-system · link every report to
a Form or Grid · validate permission server-side · use controlled queries +
parameters · allow multiple reports per Form/Grid.

**DON'T** hardcode reports inside Forms · make Print buttons that bypass Report
Master · run arbitrary SQL from a React Report · rely on frontend visibility for
security · allow unauthorized report execution · treat Grid Export as a React
Report · scatter unmanaged per-page reporting logic.

## Standard architecture

```
Report design → Report Master → Report Type → Form/Grid mapping
→ user permission → approved data source → React Report engine → Preview / Print / PDF
```
