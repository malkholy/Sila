import { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { apiCall } from './api.js';
import { computeStatement } from './customerStatement.js';

// Print menu. Resolves the reports available on a page for a Target (Form/Grid)
// through Report Master (GetPageReports -- permission-filtered server-side),
// then runs one via GetReportData and opens a print preview.
//
// Props:
//   pageGroupId  - the page
//   target       - 'Form' | 'Grid'
//   context      - { <ParamName or Field>: value, ... } source values
//   label        - button text (default "Print")
//   hidden       - no button: the report is started from code (a row's
//                  right-click menu) through runRequest
//   runRequest   - { code, nonce }: runs the page report with that ReportCode
//                  whenever nonce changes (context must already hold the row)
//   onError(msg) / onBusy(bool) - feedback for the hidden mode
//   compact      - icon-only button (e.g. a row's print icon); with a single
//                  report it prints straight away
//   reports      - the page's GetPageReports rows, when the caller already has
//                  them (one fetch for a whole Order Board instead of per row)
// Exports buildReportHTML / previewHTML for screens that render many prints
// themselves (the Order Board's stacked Preview).

const PO_FMT = (v, fmt) => {
  if (v == null) return '';
  if (fmt === 'date') return String(v).slice(0, 10);
  if (fmt === 'percent') {
    const n = Number(v);
    return Number.isFinite(n) ? (n * 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + '%' : String(v);
  }
  if (fmt && fmt.startsWith('number')) {
    const dp = Number((fmt.split(':')[1] ?? 2));
    const n = Number(v);
    return Number.isFinite(n) ? n.toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp }) : String(v);
  }
  return String(v);
};

// LayoutConfig.visibleWhen shows a report only for some records: { field,
// in: [values] } (e.g. a delivery permit only once the order is confirmed)
// and/or a numeric range { field, min, max } (e.g. every posted state
// 20..98). Display only -- GetReportData still checks access.
function isVisible(rep, context) {
  let vw = null;
  try { vw = rep.LayoutConfig ? JSON.parse(rep.LayoutConfig).visibleWhen : null; } catch { vw = null; }
  if (!vw || !vw.field) return true;
  const hasIn = Array.isArray(vw.in), hasMin = vw.min != null, hasMax = vw.max != null;
  if (!hasIn && !hasMin && !hasMax) return true;
  const v = context?.[vw.field];
  if (v == null || v === '') return false;
  if (hasIn && !vw.in.some(x => String(x) === String(v))) return false;
  if ((hasMin || hasMax) && !Number.isFinite(Number(v))) return false;
  if (hasMin && Number(v) < Number(vw.min)) return false;
  if (hasMax && Number(v) > Number(vw.max)) return false;
  return true;
}

function buildParams(paramConfig, context) {
  let cfg = [];
  try { cfg = typeof paramConfig === 'string' ? JSON.parse(paramConfig || '[]') : (paramConfig || []); } catch { cfg = []; }
  const out = {};
  cfg.forEach(p => {
    const key = p.Name;
    const v = context?.[p.Name] ?? context?.[p.Field] ?? '';
    if (v !== '' && v != null) out[key] = v;
  });
  return out;
}

function reportHTML(meta, rows, layout) {
  const title = (layout && layout.title) || meta.ReportName || 'Report';
  const cols = (layout && Array.isArray(layout.columns) && layout.columns.length)
    ? layout.columns
    : (rows[0] ? Object.keys(rows[0]).map(k => ({ field: k, label: k })) : []);
  const totals = (layout && Array.isArray(layout.totals)) ? layout.totals : [];
  const orient = (layout && layout.orientation) === 'landscape' ? 'landscape' : 'portrait';
  const size = (layout && layout.pageSize) || 'A4';

  const th = cols.map(c => `<th style="text-align:${c.align || (String(c.format || '').startsWith('number') ? 'right' : 'left')}">${esc(c.label || c.field)}</th>`).join('');
  const cell = (r, c) => {
    const num = String(c.format || '').startsWith('number');
    const neg = num && layout && layout.negativeRed && Number(r[c.field]) < 0;
    return `<td style="text-align:${c.align || (num ? 'right' : 'left')}${neg ? ';color:#b91c1c' : ''}">${esc(PO_FMT(r[c.field], c.format))}</td>`;
  };
  const rowsHTML = (list) => list.map(r => '<tr>' + cols.map(c => cell(r, c)).join('') + '</tr>').join('');
  // a total row over `list` for the `fields` columns, labelled in the first column
  const sumRow = (list, fields, label, cls = 'tot') => {
    if (!fields.length) return '';
    return `<tr class="${cls}">` + cols.map((c, i) => {
      if (i === 0) return `<td><b>${esc(label)}</b></td>`;
      if (!fields.includes(c.field)) return '<td></td>';
      const v = list.reduce((s, r) => s + (Number(r[c.field]) || 0), 0);
      return `<td style="text-align:right${layout && layout.negativeRed && v < 0 ? ';color:#b91c1c' : ''}"><b>${esc(PO_FMT(v, c.format || 'number:2'))}</b></td>`;
    }).join('') + '</tr>';
  };

  // LayoutConfig.groupBy (optional): rows grouped by that field (in query
  // order), a heading row per group and a subtotal of `totals` per group;
  // `grandTotals` (fields) adds one overall row -- e.g. only the EGP-value
  // columns when the groups are currencies. Without groupBy: one total row.
  let body;
  if (layout && layout.groupBy) {
    const groups = [];
    rows.forEach(r => {
      const k = r[layout.groupBy] ?? '';
      let g = groups.find(x => x.key === k);
      if (!g) { g = { key: k, rows: [] }; groups.push(g); }
      g.rows.push(r);
    });
    const gl = layout.groupLabel || layout.groupBy;
    body = groups.map(g => `<tr class="grp"><td colspan="${cols.length}">${esc(gl)}: ${esc(g.key)} &middot; ${g.rows.length}</td></tr>`
      + rowsHTML(g.rows) + sumRow(g.rows, totals, `Total ${g.key}`)).join('')
      + sumRow(rows, Array.isArray(layout.grandTotals) ? layout.grandTotals : [], layout.grandTotalsLabel || 'Grand total', 'tot grand');
  } else {
    body = rowsHTML(rows) + sumRow(rows, totals, 'Total');
  }

  const accent = (layout && layout.accent) || '#0e639c';
  const accentSoft = (layout && layout.accentSoft) || 'rgba(14,99,156,.10)';
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
  @page { size: ${size} ${orient}; margin: 14mm; }
  html{-webkit-print-color-adjust:exact;print-color-adjust:exact}
  * { box-sizing: border-box; }
  body { font: 12px -apple-system, Segoe UI, Roboto, sans-serif; color: #1c2530; margin: 0; -webkit-print-color-adjust:exact; print-color-adjust:exact; }
  h1 { font-size: 18px; margin: 0 0 2px; color:${accent}; }
  .meta { color: #64748b; font-size: 11px; margin-bottom: 14px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { padding: 6px 8px; border-bottom: 1px solid #e5e9ef; }
  th { background: ${accent}; color:#fff; font-size: 9.5px; text-transform: uppercase; letter-spacing: .05em; }
  tbody tr:nth-child(even) td { background:${accentSoft}; }
  tr.tot td { border-top: 2px solid ${accent}; border-bottom: none; background:${accentSoft}; }
  tr.grp td { background:#f1f5f9; color:${accent}; font-weight:800; font-size:11px; padding-top:10px; }
  tr.grand td { border-top: 3px double ${accent}; }
  .foot { margin-top: 18px; color: #94a3b8; font-size: 10px; }
</style></head><body>
  ${layout && layout.headerHTML ? layout.headerHTML : ''}
  <h1>${esc(title)}</h1>
  <div class="meta">${layout && layout.subtitle ? esc(layout.subtitle) + ' &middot; ' : ''}${esc(meta.ReportName || '')} &middot; ${new Date().toLocaleString()} &middot; ${rows.length} row(s)</div>
  <table><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table>
  ${layout && layout.footerHTML ? layout.footerHTML : ''}
  <div class="foot">Generated from Report Master &middot; ${esc(meta.ReportCode || '')}</div>
  <script>window.onafterprint=function(){setTimeout(function(){window.close();},100);};window.onload=function(){setTimeout(function(){window.print();},250);};</script>
</body></html>`;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// LayoutConfig.kind === 'panels' -> a status card: N side-by-side columns, each
// a title key/value line, a section header, then label/value rows. One data row
// (head). Styled with the Sila theme (Plus Jakarta Sans, orange accent,
// rounded cards, slate palette). Mirrors the legacy "Customer Status" sheet.
function panelsHTML(meta, head, sections, layout, extraPages = []) {
  const title = layout.title || meta.ReportName || 'Report';
  const orient = layout.orientation === 'landscape' ? 'landscape' : 'portrait';
  const size = layout.pageSize || 'A4';
  const accent = layout.accent || '#ea580c';
  const accent2 = layout.accent2 || '#f97316';
  const tf = Array.isArray(layout.titleFields) ? layout.titleFields : [];
  const panels = Array.isArray(layout.panels) ? layout.panels : [];
  const n = Math.max(tf.length, panels.length, 1);

  // a row may be { heading: '...' } -- a sub-title inside the panel; the
  // zebra striping restarts under each heading
  const kvRows = (rows) => {
    let n = 0;
    return (rows || []).map((r) => {
      if (r.heading) { n = 0; return `<div class="kh">${esc(r.heading)}</div>`; }
      const cell = esc(PO_FMT(head[r.field], r.format));
      const st = r.color ? ` style="color:${esc(r.color)}"` : '';
      return `<div class="kv${n++ % 2 ? ' alt' : ''}"><span class="k">${esc(r.label)}</span><span class="v"${st}>${cell || '—'}</span></div>`;
    }).join('');
  };

  const col = (i) => {
    const t = tf[i], p = panels[i];
    return `<div class="col" style="--panel-column:${i + 1}">`
      // optional second line under the value: { subLabel, subField, subFormat } (e.g. the customer's Price Type)
      + (t ? `<div class="tcard"><div class="tl">${esc(t.label)}</div><div class="tv">${esc(PO_FMT(head[t.field], t.format)) || '—'}</div>`
          + (t.subField ? `<div class="ts"><span>${esc(t.subLabel || t.subField)}</span> ${esc(PO_FMT(head[t.subField], t.subFormat)) || '—'}</div>` : '')
          + `</div>` : '')
      + (p ? `<div class="panel"><div class="phead">${esc(p.title)}</div><div class="pbody">${kvRows(p.rows)}</div></div>` : '')
      + `</div>`;
  };

  const sectionCard = (s) => {
    const cols = Array.isArray(s.columns) ? s.columns : [];
    const th = cols.map(c => `<th style="text-align:${c.align || 'left'}">${esc(c.label || c.field)}</th>`).join('');
    const body = (s.data || []).map(r => '<tr>' + cols.map(c =>
      `<td style="text-align:${c.align || (String(c.format || '').startsWith('number') ? 'right' : 'left')}">${esc(PO_FMT(r[c.field], c.format))}</td>`
    ).join('') + '</tr>').join('');
    // optional totals row: s.totals = [field, ...] summed over the section's rows
    const tot = Array.isArray(s.totals) && s.totals.length && (s.data || []).length
      ? '<tfoot><tr>' + cols.map((c, ci) => {
          if (s.totals.includes(c.field)) {
            const sum = (s.data || []).reduce((a, r) => a + (Number(r[c.field]) || 0), 0);
            return `<td style="text-align:right">${esc(PO_FMT(sum, c.format || 'number:2'))}</td>`;
          }
          return ci === 0 ? `<td>${esc(s.totalsLabel || 'Total')}</td>` : '<td></td>';
        }).join('') + '</tr></tfoot>'
      : '';
    return `<div class="sec"><div class="sechead">${esc(s.title)}</div>`
      + `<table class="tbl"><thead><tr>${th}</tr></thead><tbody>`
      + (body || `<tr><td class="empty" colspan="${cols.length}">No records</td></tr>`)
      + `</tbody>${tot}</table></div>`;
  };
  const sectionsHTML = (sections || []).map(sectionCard).join('');
  // layout.extraPages (optional): pages printed AFTER the one-page sheet, each
  // on its own page and not shrunk with it -- see fetchPanelExtraPages()
  const extraHTML = (extraPages || []).map(pg => `<div class="xpage">
    <div class="rhead"><h1>${esc(pg.title || '')}</h1><div class="rule"></div>
    <div class="meta">${esc(pg.subtitleField ? (head[pg.subtitleField] ?? '') : '')}</div></div>
    ${(pg.sections || []).map(sectionCard).join('')}
  </div>`).join('');
  const availPx = orient === 'landscape' ? 718 : 1047;   // A4 content height @ 10mm margins

  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
  @page { size: ${size} ${orient}; margin: 10mm; }
  html{-webkit-print-color-adjust:exact;print-color-adjust:exact}
  *{box-sizing:border-box}
  body{font-family:'Plus Jakarta Sans',system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#0f172a;margin:0;font-size:14px;line-height:1.45}
  .sheet{padding:0}
  .rhead{text-align:center;margin-bottom:16px}
  .rhead h1{font-size:24px;font-weight:800;letter-spacing:-.01em;margin:0}
  .rhead .rule{width:60px;height:4px;border-radius:999px;background:linear-gradient(135deg,${accent2},${accent});margin:8px auto 5px}
  .rhead .meta{font-size:10.5px;color:#64748b;font-weight:600;text-transform:uppercase;letter-spacing:.08em}
  .cols{display:grid;grid-template-columns:repeat(${n},minmax(0,1fr));column-gap:16px;row-gap:10px;align-items:stretch}
  .col{display:contents}
  .col>.tcard{grid-column:var(--panel-column);grid-row:1;min-width:0}
  .col>.panel{grid-column:var(--panel-column);grid-row:2;min-width:0}
  .tcard{border:1px solid #e2e8f0;border-radius:10px;background:#f8fafc;padding:9px 13px}
  .tcard .tl{font-size:9.5px;font-weight:800;text-transform:uppercase;letter-spacing:.1em;color:#94a3b8}
  .tcard .tv{font-size:16px;font-weight:800;color:#0f172a;margin-top:2px}
  .tcard .ts{font-size:12px;font-weight:700;color:#334155;margin-top:3px}
  .tcard .ts span{font-size:9.5px;font-weight:800;text-transform:uppercase;letter-spacing:.1em;color:#94a3b8;margin-right:4px}
  .panel{border:1px solid #e2e8f0;border-radius:11px;overflow:hidden;display:flex;flex-direction:column}
  .phead{background:linear-gradient(135deg,${accent2},${accent});color:#fff;font-size:12px;font-weight:800;text-transform:uppercase;letter-spacing:.12em;padding:8px 13px}
  .pbody{background:#fff;display:flex;flex-direction:column;flex:1}
  .kv{display:flex;flex:1;justify-content:space-between;align-items:center;gap:12px;padding:6.5px 13px;border-top:1px solid #eef2f6}
  .kv:first-child{border-top:none}
  .kv.alt{background:#f8fafc}
  .kh{padding:7px 13px 4px;border-top:1px solid #e2e8f0;background:#fff7ed;font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.12em;color:${accent}}
  .pbody .kh:first-child{border-top:none}
  .kv .k{min-width:0;overflow-wrap:anywhere;font-size:12.5px;font-weight:600;color:#64748b}
  .kv .v{font-size:13px;font-weight:700;color:#0f172a;font-variant-numeric:tabular-nums;white-space:nowrap}
  .sec{margin-top:12px;border:1px solid #e2e8f0;border-radius:11px;overflow:hidden;break-inside:avoid}
  .sechead{background:linear-gradient(135deg,${accent2},${accent});color:#fff;font-size:12px;font-weight:800;text-transform:uppercase;letter-spacing:.12em;padding:8px 13px}
  table.tbl{width:100%;border-collapse:collapse;font-size:13.5px}
  table.tbl th{background:#f1f5f9;color:#475569;font-weight:700;text-transform:uppercase;letter-spacing:.03em;font-size:11px;padding:8px 12px;border-bottom:1px solid #e2e8f0}
  table.tbl td{padding:8px 12px;border-bottom:1px solid #eef2f6;color:#0f172a;font-variant-numeric:tabular-nums}
  table.tbl tbody tr:nth-child(even) td{background:#f8fafc}
  table.tbl td.empty{text-align:center;color:#94a3b8;font-style:italic}
  table.tbl tfoot td{font-weight:800;background:#fff7ed;border-top:2px solid #e2e8f0;padding:8px 12px;font-variant-numeric:tabular-nums}
  .xpage{break-before:page;page-break-before:always}
  .foot{margin-top:16px;padding-top:8px;border-top:1px solid #e2e8f0;color:#94a3b8;font-size:9.5px;font-weight:600;text-transform:uppercase;letter-spacing:.06em}
</style></head><body>
  <div class="sheet">
  ${layout.headerHTML || ''}
  <div class="rhead">
    <h1>${esc(title)}</h1>
    <div class="rule"></div>
    <div class="meta">${esc(meta.ReportName || '')} &middot; ${new Date().toLocaleDateString()}</div>
  </div>
  <div class="cols">${Array.from({ length: n }).map((_, i) => col(i)).join('')}</div>
  ${sectionsHTML}
  ${layout.footerHTML || ''}
  <div class="foot">Report Master &middot; ${esc(meta.ReportCode || '')} &middot; ${new Date().toLocaleString()}</div>
  </div>
  ${extraHTML}
  <script>
    window.onafterprint=function(){setTimeout(function(){window.close();},100);};
    window.onload=function(){
      try{
        // shrink only the one-page sheet to fit; extra pages print at full size
        var s=document.querySelector('.sheet'), h=s.scrollHeight, avail=${availPx};
        if(h>avail){ s.style.zoom=Math.max(0.5,(avail-6)/h).toFixed(3); }
      }catch(e){}
      setTimeout(function(){window.print();},500);
    };
  </script>
</body></html>`;
}

// LayoutConfig.kind === 'dashboard' -> a one-record KPI sheet (Cash Flow): title
// + subtitle field, a 4-across grid of `tiles`, an optional `targets` card of
// actual/target progress bars, then a 2-column grid of accent-bordered `panels`
// of label/value rows. A value/tile with `signed: true` gets a +/- sign and
// green/red colour; any other negative number is red. Portrait, flows onto
// further pages (cards never split).
function dashboardHTML(meta, head, layout) {
  const title = layout.title || meta.ReportName || 'Report';
  const orient = layout.orientation === 'landscape' ? 'landscape' : 'portrait';
  const size = layout.pageSize || 'A4';
  const RED = '#b91c1c', GREEN = '#16a34a', ORANGE = '#f97316';

  const val = (spec) => {
    const raw = head[spec.field];
    if (raw == null || raw === '') return '<span>—</span>';
    const n = Number(raw);
    let text = esc(PO_FMT(raw, spec.format));
    let color = '';
    if (Number.isFinite(n)) {
      if (spec.signed) { color = n > 0 ? GREEN : n < 0 ? RED : ''; if (n > 0) text = '+' + text; }
      else if (n < 0) color = RED;
    }
    return `<span${color ? ` style="color:${color}"` : ''}>${text}</span>`;
  };

  const tiles = (layout.tiles || []).map(t =>
    `<div class="tile"><div class="tl">${esc(t.icon || '')} ${esc(t.label)}</div><div class="tv">${val(t)}</div></div>`).join('');

  const tg = layout.targets;
  const targetsHTML = tg && Array.isArray(tg.items) && tg.items.length ? `
    <div class="card" style="border-left-color:${esc(tg.accent || ORANGE)}">
      <div class="chead">${esc(tg.icon || '')} ${esc(tg.title || 'Targets')}</div>
      <div class="tgrid">${tg.items.map(it => {
        const actual = Number(head[it.actualField]) || 0, target = Number(head[it.targetField]) || 0;
        const pct = target > 0 ? actual / target * 100 : null;
        const c = pct == null ? '#cbd5e1' : pct >= 100 ? GREEN : pct >= 75 ? ORANGE : RED;
        return `<div class="tg">
          <div class="tgtop"><b>${esc(it.label)}</b><span>${esc(PO_FMT(actual, 'number:2'))} <i>/</i> ${esc(PO_FMT(target, 'number:2'))}</span></div>
          <div class="bar"><div style="width:${pct == null ? 0 : Math.min(100, Math.max(0, pct))}%;background:${c}"></div></div>
          ${pct == null ? '' : `<div class="pct" style="color:${c}">${pct.toFixed(1)}% of target</div>`}
        </div>`;
      }).join('')}</div>
    </div>` : '';

  const panels = (layout.panels || []).map(p => `
    <div class="card" style="border-left-color:${esc(p.accent || ORANGE)}">
      <div class="chead">${esc(p.icon || '')} ${esc(p.title)}</div>
      <div class="cbody">${(p.rows || []).map(r => `<div class="kv"><span class="k">${esc(r.label)}</span><span class="v">${val(r)}</span></div>`).join('')}</div>
    </div>`).join('');

  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
  @page { size: ${size} ${orient}; margin: 10mm; }
  html{-webkit-print-color-adjust:exact;print-color-adjust:exact}
  *{box-sizing:border-box}
  body{font-family:Arial,Helvetica,system-ui,sans-serif;color:#111;margin:0;font-size:12px}
  .sheet{background:#f6f6f6;border-radius:6px;padding:18px 20px}
  h1{margin:0;font-size:22px;font-weight:800}
  .sub{margin:4px 0 18px;font-size:12.5px;color:#555}
  .tiles{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:18px}
  .tile{background:#f6f6f6;border:1px solid #ddd;border-radius:9px;padding:11px 13px;break-inside:avoid}
  .tile .tl{font-size:9.5px;font-weight:700;color:#666;text-transform:uppercase;letter-spacing:.04em;margin-bottom:5px}
  .tile .tv{font-size:17px;font-weight:800}
  .card{background:#fff;border:1px solid #ddd;border-left:4px solid ${ORANGE};border-radius:10px;overflow:hidden;break-inside:avoid;page-break-inside:avoid}
  .chead{padding:10px 16px;border-bottom:1px solid #ddd;font-size:10.5px;font-weight:800;color:#666;text-transform:uppercase;letter-spacing:.04em}
  .cbody{padding:10px 16px;display:flex;flex-direction:column;gap:9px}
  .kv{display:flex;justify-content:space-between;align-items:center;gap:12px}
  .kv .k{font-size:11.5px;color:#555}
  .kv .v{font-size:12.5px;font-weight:700;white-space:nowrap;font-variant-numeric:tabular-nums}
  .tgrid{padding:14px 16px;display:grid;grid-template-columns:1fr 1fr;gap:16px 28px}
  .tgtop{display:flex;justify-content:space-between;align-items:baseline;gap:10px;margin-bottom:6px;font-size:11px}
  .tgtop b{font-size:12px}
  .tgtop span{color:#555;white-space:nowrap}
  .tgtop i{opacity:.6;font-style:normal}
  .bar{height:7px;border-radius:999px;background:#eee;border:1px solid #ddd;overflow:hidden}
  .bar div{height:100%;border-radius:999px}
  .pct{text-align:right;font-size:10.5px;font-weight:700;margin-top:4px}
  .grid2{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:18px}
</style></head><body>
  <div class="sheet">
    <h1>${esc(title)}</h1>
    ${layout.subtitleField ? `<div class="sub">${esc(head[layout.subtitleField] ?? '')}</div>` : '<div class="sub"></div>'}
    ${tiles ? `<div class="tiles">${tiles}</div>` : ''}
    ${targetsHTML}
    <div class="grid2">${panels}</div>
  </div>
  <script>
    window.onafterprint=function(){setTimeout(function(){window.close();},100);};
    window.onload=function(){setTimeout(function(){window.print();},500);};
  </script>
</body></html>`;
}

// GLC Paints mark (approximation) -- used when LayoutConfig has no `logo`.
const GLC_LOGO = `<svg viewBox="0 0 128 40" width="128" height="40" xmlns="http://www.w3.org/2000/svg">
  <g transform="rotate(-24 16 20)">
    <path d="M16 7 A13 13 0 0 1 29 20" fill="none" stroke="#E1251B" stroke-width="7" stroke-linecap="round"/>
    <path d="M29 20 A13 13 0 0 1 16 33" fill="none" stroke="#3AAA35" stroke-width="7" stroke-linecap="round"/>
    <path d="M16 33 A13 13 0 0 1 3 20" fill="none" stroke="#0099D8" stroke-width="7" stroke-linecap="round"/>
    <path d="M3 20 A13 13 0 0 1 16 7" fill="none" stroke="#FDB913" stroke-width="7" stroke-linecap="round"/>
    <circle cx="16" cy="20" r="4.5" fill="#fff"/>
  </g>
  <text x="40" y="27" font-family="Arial, Helvetica, sans-serif" font-weight="900" font-size="23" fill="#E1251B">GLC</text>
  <text x="41" y="36" font-family="Arial, Helvetica, sans-serif" font-weight="700" font-size="7" letter-spacing="3.5" fill="#E1251B">PAINTS</text>
</svg>`;

// LayoutConfig.kind === 'invoice' -> an RTL Arabic-style document: a navy
// title band (title + order #), two side-by-side titled info panels, a
// centered section title, a line-items table, and one totals bar. Distinct
// visual template from 'document' (which is LTR, single header grid, corner
// totals box) -- built generic/config-driven like the others so any future
// Arabic customer-facing document can reuse it.
// layout.extraPages (optional): [{ title, linesTitle, queryId, keyField, columns, totals,
// totalsLabel, emptyText }] -- each prints on its own page after the main one (same band,
// table and totals bar), its rows fetched with the same key as the main lines. `extras` is
// [{ page, rows }] in the same order.
function invoiceHTML(meta, head, lines, layout, extras = []) {
  const title = layout.title || meta.ReportName || 'Document';
  const orient = layout.orientation === 'landscape' ? 'landscape' : 'portrait';
  const size = layout.pageSize || 'A4';
  const num = head[layout.numberField] ?? '';
  const accent = layout.accent || '#132a4c';
  const accent2 = layout.accent2 || '#d99a3d';

  const panel = (p) => {
    const rows = (p.rows || [])
      .filter(r => head[r.field] != null && String(head[r.field]).trim() !== '')
      .map(r => `<div class="prow"><span class="pl">${esc(r.label)}</span><span class="pv">${esc(PO_FMT(head[r.field], r.format))}</span></div>`)
      .join('');
    return `<div class="panel"><div class="phead">${esc(p.title)}</div><div class="pbody">${rows}</div></div>`;
  };
  const panels = (layout.panels || []).map(panel).join('');

  const lc = (layout.lines && layout.lines.columns) || [];
  const lth = lc.map(c => `<th style="text-align:${c.align || 'center'}${c.width ? ';width:' + c.width : ''}">${esc(c.label || c.field)}</th>`).join('');
  const ltr = lines.map(r => '<tr>' + lc.map(c =>
    `<td style="text-align:${c.align || (String(c.format || '').startsWith('number') ? 'right' : 'center')}">${esc(PO_FMT(r[c.field], c.format))}</td>`
  ).join('') + '</tr>').join('');

  const sumLine = f => lines.reduce((s, r) => s + (Number(r[f]) || 0), 0);
  const totalsHTML = `<span class="tl">${esc(layout.totalsLabel || 'Total')}</span>`
    + (layout.totals || [])
      .map(t => {
        const raw = t.lineField ? sumLine(t.lineField) : Number(head[t.field] || 0);
        return `<span class="tv">${esc(PO_FMT(raw, t.format || 'number:2'))}</span>`;
      })
      .join('');

  // Optional small header-level summary table (order value / discount / tax /
  // final value) below the cartons+net totals bar.
  const summaryHTML = Array.isArray(layout.summary) && layout.summary.length
    ? `<table class="summary">${layout.summary.map(s => {
        const raw = Number(head[s.field] || 0);
        const v = s.negate ? -raw : (s.abs ? Math.abs(raw) : raw);
        return `<tr${s.bold ? ' class="grand"' : ''}><td class="sl">${esc(s.label)}</td><td class="sv">${esc(PO_FMT(v, s.format || 'number:2'))}</td></tr>`;
      }).join('')}</table>`
    : '';

  return `<!doctype html><html dir="rtl" lang="ar"><head><meta charset="utf-8"><title>${esc(title)} ${esc(num)}</title>
<style>
  @page { size: ${size} ${orient}; margin: 12mm; }
  html{-webkit-print-color-adjust:exact;print-color-adjust:exact}
  *{box-sizing:border-box}
  body{font:13px Tahoma,Arial,sans-serif;color:#1c2530;margin:0;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  .band{background:${accent};color:#fff;padding:16px 22px;border-radius:8px}
  .band h1{font-size:20px;margin:0;letter-spacing:.3px}
  .band .no{display:inline-block;margin-top:8px;background:${accent2};color:#fff;font-weight:800;font-size:15px;padding:5px 16px;border-radius:6px;font-family:ui-monospace,Menlo,monospace}
  .panels{display:flex;gap:14px;margin-top:14px}
  .panel{flex:1;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden}
  .phead{background:${accent};color:#fff;font-size:12px;font-weight:800;padding:8px 14px}
  .pbody{background:#fff}
  .prow{display:flex;justify-content:space-between;gap:12px;padding:7px 14px;border-top:1px solid #eef2f6;font-size:12.5px}
  .prow:first-child{border-top:none}
  .pl{color:#64748b;font-weight:600}
  .pv{color:#1c2530;font-weight:700}
  .sec{text-align:center;font-size:15px;font-weight:800;color:${accent2};margin:20px 0 10px}
  table.lines{width:100%;border-collapse:collapse;font-size:${layout.linesFont || '11.5px'}}
  table.lines th{background:${accent};color:#fff;padding:7px 6px;font-size:10px;font-weight:800}
  table.lines td{padding:6px 6px;border-bottom:1px solid #e5e9ef}
  table.lines tbody tr:nth-child(even) td{background:#f8fafc}
  .totbar{margin-top:0;background:${accent2};color:#fff;border-radius:${summaryHTML ? '0' : '0 0 8px 8px'};display:flex;justify-content:center;align-items:baseline;gap:18px;padding:10px 14px}
  .totbar .tl{font-size:13px;font-weight:800;min-width:64px;text-align:center}
  .totbar .tv{font-size:15px;font-weight:800;font-variant-numeric:tabular-nums;min-width:84px;text-align:center}
  .summarywrap{display:flex;justify-content:center;background:#f8fafc;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 8px 8px;padding:12px 0}
  table.summary{border-collapse:collapse;width:300px;table-layout:fixed}
  table.summary td{padding:6px 4px;font-size:12.5px;vertical-align:middle}
  table.summary td.sl{width:58%;text-align:right;padding-right:14px;color:#64748b;font-weight:700}
  table.summary td.sv{width:42%;text-align:left;padding-left:14px;font-weight:700;color:#1c2530;font-variant-numeric:tabular-nums}
  table.summary tr.grand td{border-top:1.5px solid ${accent};padding-top:9px;font-size:14px}
  table.summary tr.grand td.sl{color:${accent}}
  table.summary tr.grand td.sv{color:${accent}}
  .foot{margin-top:18px;color:#94a3b8;font-size:9.5px;border-top:1px solid #e5e9ef;padding-top:6px;text-align:center}
</style></head><body>
  <div class="band"><h1>${esc(title)}</h1><div class="no">${esc(num)}</div></div>
  <div class="panels">${panels}</div>
  <div class="sec">${esc(layout.linesTitle || 'Lines')}</div>
  <table class="lines"><thead><tr>${lth}</tr></thead><tbody>${ltr || '<tr><td colspan="' + lc.length + '" style="color:#94a3b8;text-align:center">—</td></tr>'}</tbody></table>
  <div class="totbar">${totalsHTML}</div>
  ${summaryHTML ? `<div class="summarywrap">${summaryHTML}</div>` : ''}
  <div class="foot">${esc(meta.ReportName || '')} &middot; ${esc(meta.ReportCode || '')} &middot; ${new Date().toLocaleString()}</div>
  ${extras.map(({ page, rows: xr }) => {
    const xc = page.columns || [];
    const xth = xc.map(c => `<th style="text-align:${c.align || 'center'}${c.width ? ';width:' + c.width : ''}">${esc(c.label || c.field)}</th>`).join('');
    const xtr = (xr || []).map(r => '<tr>' + xc.map(c =>
      `<td style="text-align:${c.align || (String(c.format || '').startsWith('number') ? 'right' : 'center')}">${esc(PO_FMT(r[c.field], c.format))}</td>`
    ).join('') + '</tr>').join('');
    const xtot = `<span class="tl">${esc(page.totalsLabel || layout.totalsLabel || 'Total')}</span>`
      + (page.totals || []).map(t => `<span class="tv">${esc(PO_FMT((xr || []).reduce((sm, r) => sm + (Number(r[t.lineField]) || 0), 0), t.format || 'number:2'))}</span>`).join('');
    return `<div style="break-before:page;page-break-before:always">
  <div class="band"><h1>${esc(page.title || title)}</h1><div class="no">${esc(num)}</div></div>
  <div class="sec">${esc(page.linesTitle || page.title || 'Lines')}</div>
  <table class="lines"><thead><tr>${xth}</tr></thead><tbody>${xtr || '<tr><td colspan="' + xc.length + '" style="color:#94a3b8;text-align:center">' + esc(page.emptyText || '—') + '</td></tr>'}</tbody></table>
  <div class="totbar" style="border-radius:0 0 8px 8px">${xtot}</div>
</div>`;
  }).join('')}
  <script>window.onafterprint=function(){setTimeout(function(){window.close();},100);};window.onload=function(){setTimeout(function(){window.print();},300);};</script>
</body></html>`;
}

// LayoutConfig.kind === 'note' -> an RTL single-document voucher (Credit /
// Debit Note): logo + title + number/date/state header, two aligned info
// panels, full-width text blocks (reason, note), the lines table with the
// total inside it under the amount column, a totals box with the amount in
// words, signature boxes, and a DRAFT watermark while the state is draftValue.
// layout: title, numberField, dateField, stateField, draftValue, accent,
// currencyField, rateField, amountField, baseAmountField, panels [{ title,
// rows: [{ label, field, format }] }], textBlocks [{ label, field }],
// linesTitle, lines { queryId, keyField, columns: [{ field, label, width,
// format, subField }] } (a column whose cells are all empty is dropped),
// totalsLabel, signatures [label], hideLogo / logo.
function noteHTML(meta, head, lines, layout) {
  const title = layout.title || meta.ReportName || 'Document';
  const orient = layout.orientation === 'landscape' ? 'landscape' : 'portrait';
  const size = layout.pageSize || 'A4';
  const accent = layout.accent || '#132a4c';
  const has = v => v != null && String(v).trim() !== '';
  const num = head[layout.numberField] ?? '';
  const state = layout.stateField ? head[layout.stateField] : '';
  const draft = has(state) && layout.draftValue != null && String(state) === String(layout.draftValue);
  const currency = layout.currencyField ? head[layout.currencyField] || '' : '';
  const rate = Number(layout.rateField ? head[layout.rateField] : 1) || 1;
  const logo = layout.hideLogo ? '' : layout.logo
    ? `<img src="${esc(layout.logo)}" alt="logo" style="max-height:46px;max-width:180px;display:block">` : GLC_LOGO;
  const isNum = c => String(c.format || '').startsWith('number');

  const panel = p => {
    const rows = (p.rows || []).filter(r => has(head[r.field]))
      .map(r => `<div class="prow"><span class="pl">${esc(r.label)}</span><span class="pv${isNum(r) ? ' n' : ''}">${esc(PO_FMT(head[r.field], r.format))}</span></div>`).join('');
    return rows ? `<div class="panel"><div class="phead">${esc(p.title)}</div>${rows}</div>` : '';
  };
  const blocks = (layout.textBlocks || []).filter(b => has(head[b.field]))
    .map(b => `<div class="tblock"><span class="pl">${esc(b.label)}</span><div class="tv">${esc(head[b.field])}</div></div>`).join('');

  // lines: numbers sit on the left (the reading end in RTL), text on the right -- header and cells alike
  const cols = ((layout.lines && layout.lines.columns) || [])
    .filter(c => isNum(c) || lines.some(r => has(r[c.field]) || (c.subField && has(r[c.subField]))));
  const align = c => c.align || (isNum(c) ? 'left' : c.center ? 'center' : 'right');
  const th = cols.map(c => `<th style="text-align:${align(c)}${c.width ? ';width:' + c.width : ''}">${esc(c.label || c.field)}</th>`).join('');
  const tr = lines.map(r => '<tr>' + cols.map(c => {
    const main = esc(PO_FMT(r[c.field], c.format));
    const sub = c.subField && has(r[c.subField]) ? `<div class="sub">${esc(r[c.subField])}</div>` : '';
    return `<td class="${isNum(c) ? 'n' : ''}" style="text-align:${align(c)}">${main}${sub}</td>`;
  }).join('') + '</tr>').join('');
  const amountCol = cols.findIndex(c => c.field === layout.amountField);
  const lineSum = lines.reduce((s, r) => s + (Number(r[layout.amountField]) || 0), 0);
  const total = has(head[layout.amountField]) ? Number(head[layout.amountField]) : lineSum;
  const foot = amountCol > 0
    ? `<tfoot><tr><td colspan="${amountCol}" class="fl">${esc(layout.totalsLabel || 'Total')}</td><td class="n fv">${esc(PO_FMT(lineSum, 'number:2'))}</td>${cols.length - amountCol - 1 > 0 ? `<td colspan="${cols.length - amountCol - 1}"></td>` : ''}</tr></tfoot>`
    : '';

  const base = layout.baseAmountField && has(head[layout.baseAmountField]) ? Number(head[layout.baseAmountField]) : null;
  const sumRows = [
    [`${layout.totalsLabel || 'Total'}${currency ? ` (${currency})` : ''}`, PO_FMT(total, 'number:2'), base == null || rate === 1],
    ...(base != null && rate !== 1 ? [['الإجمالي بالعملة المحلية', PO_FMT(base, 'number:2'), true]] : []),
  ].map(([l, v, grand]) => `<div class="srow${grand ? ' grand' : ''}"><span>${esc(l)}</span><span class="n">${esc(v)}</span></div>`).join('');
  const words = amountToArabicWords(total, currency);
  const signs = (layout.signatures || []).map(s => `<div class="sign"><div class="sl2">${esc(s)}</div><div class="sline"></div></div>`).join('');
  const footBits = [meta.ReportName, head.CreatedBy ? `أنشئ بواسطة ${head.CreatedBy}` : '', new Date().toLocaleString()].filter(has);

  return `<!doctype html><html dir="rtl" lang="ar"><head><meta charset="utf-8"><title>${esc(title)} ${esc(num)}</title>
<style>
  @page { size: ${size} ${orient}; margin: 12mm; }
  html{-webkit-print-color-adjust:exact;print-color-adjust:exact}
  *{box-sizing:border-box}
  body{font:12.5px Tahoma,Arial,sans-serif;color:#1c2530;margin:0;position:relative}
  .n{font-variant-numeric:tabular-nums;direction:ltr;unicode-bidi:isolate}
  .top{display:flex;align-items:center;justify-content:space-between;gap:16px;padding-bottom:12px;border-bottom:3px solid ${accent}}
  .top h1{margin:0;font-size:24px;color:${accent};letter-spacing:.3px}
  .top .sub1{margin-top:4px;color:#64748b;font-size:11px}
  .meta{display:grid;grid-template-columns:auto auto;gap:4px 14px;font-size:12px;align-items:center}
  .meta .ml{color:#64748b;font-weight:600}
  .meta .mv{font-weight:800;text-align:left}
  .chip{display:inline-block;padding:2px 10px;border-radius:999px;font-size:11px;font-weight:800;background:${draft ? '#fef3c7' : '#e2e8f0'};color:${draft ? '#92400e' : '#334155'}}
  .panels{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:14px}
  .panel{border:1px solid #e2e8f0;border-radius:8px;overflow:hidden}
  .phead{background:#f1f5f9;color:${accent};font-size:11.5px;font-weight:800;padding:7px 12px;border-bottom:1px solid #e2e8f0}
  .prow{display:grid;grid-template-columns:110px 1fr;gap:10px;padding:6px 12px;border-top:1px solid #f1f5f9;align-items:baseline}
  .prow:nth-child(2){border-top:none}
  .pl{color:#64748b;font-weight:600;font-size:11.5px}
  .pv{font-weight:700;text-align:right}
  .pv.n{text-align:right}
  .tblock{margin-top:10px;border:1px solid #e2e8f0;border-radius:8px;padding:8px 12px;display:grid;grid-template-columns:110px 1fr;gap:10px;align-items:baseline}
  .tblock .tv{font-weight:700;line-height:1.6}
  .sec{font-size:13px;font-weight:800;color:${accent};margin:18px 0 8px;padding-right:8px;border-right:3px solid ${accent}}
  table.lines{width:100%;border-collapse:collapse;font-size:11.5px}
  table.lines th{background:${accent};color:#fff;padding:7px 8px;font-size:10.5px;font-weight:800}
  table.lines td{padding:7px 8px;border-bottom:1px solid #e5e9ef;vertical-align:top;line-height:1.5}
  table.lines tbody tr:nth-child(even) td{background:#f8fafc}
  table.lines td .sub{color:#64748b;font-size:10.5px;margin-top:2px}
  table.lines tfoot td{border-bottom:none;border-top:2px solid ${accent};font-weight:800;padding-top:8px}
  table.lines tfoot .fl{text-align:right;color:${accent}}
  table.lines tfoot .fv{text-align:left;font-size:13px}
  .after{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;margin-top:14px}
  .words{flex:1;background:#f8fafc;border:1px dashed #cbd5e1;border-radius:8px;padding:9px 12px;font-weight:700;line-height:1.6}
  .words .pl{display:block;margin-bottom:2px}
  .sumbox{width:46%;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden}
  .srow{display:flex;justify-content:space-between;gap:12px;padding:8px 12px;font-weight:700;border-top:1px solid #eef2f6}
  .srow:first-child{border-top:none}
  .srow.grand{background:${accent};color:#fff;font-size:14px}
  .signs{display:grid;grid-template-columns:repeat(${Math.max((layout.signatures || []).length, 1)},1fr);gap:24px;margin-top:40px}
  .sign{text-align:center}
  .sl2{font-weight:800;color:#334155;margin-bottom:34px}
  .sline{border-top:1px solid #94a3b8}
  .foot{margin-top:24px;color:#94a3b8;font-size:9.5px;border-top:1px solid #e5e9ef;padding-top:6px;text-align:center}
  .wm{position:fixed;top:40%;left:0;right:0;text-align:center;font-size:120px;font-weight:900;color:rgba(146,64,14,.07);transform:rotate(-24deg);pointer-events:none;z-index:0}
</style></head><body>
  ${draft ? `<div class="wm">${esc(state)}</div>` : ''}
  <div class="top">
    <div style="display:flex;align-items:center;gap:14px">${logo ? `<div dir="ltr">${logo}</div>` : ''}<div><h1>${esc(title)}</h1>${meta.ReportName ? `<div class="sub1">${esc(meta.ReportName)}</div>` : ''}</div></div>
    <div class="meta">
      <span class="ml">رقم المستند</span><span class="mv n">${esc(num)}</span>
      ${layout.dateField && has(head[layout.dateField]) ? `<span class="ml">التاريخ</span><span class="mv n">${esc(PO_FMT(head[layout.dateField], 'date'))}</span>` : ''}
      ${has(state) ? `<span class="ml">الحالة</span><span class="mv"><span class="chip">${esc(state)}</span></span>` : ''}
    </div>
  </div>
  <div class="panels">${(layout.panels || []).map(panel).join('')}</div>
  ${blocks}
  <div class="sec">${esc(layout.linesTitle || 'Lines')}</div>
  <table class="lines"><thead><tr>${th}</tr></thead><tbody>${tr || `<tr><td colspan="${cols.length || 1}" style="color:#94a3b8;text-align:center">—</td></tr>`}</tbody>${foot}</table>
  <div class="after">
    <div class="words"><span class="pl">المبلغ كتابة</span>${esc(words)}</div>
    <div class="sumbox">${sumRows}</div>
  </div>
  ${signs ? `<div class="signs">${signs}</div>` : ''}
  <div class="foot">${footBits.map(esc).join(' &middot; ')}</div>
  <script>window.onafterprint=function(){setTimeout(function(){window.close();},100);};window.onload=function(){setTimeout(function(){window.print();},300);};</script>
</body></html>`;
}

// Two-row table header: ungrouped columns span both rows; consecutive columns
// sharing a `group` get one group cell above their own labels.
function groupedHead(cols) {
  let top = '', sub = '';
  for (let i = 0; i < cols.length; i++) {
    const c = cols[i];
    if (!c.group) { top += `<th rowspan="2"${c.width ? ` style="width:${c.width}"` : ''}>${esc(c.label)}</th>`; continue; }
    let j = i;
    while (j + 1 < cols.length && cols[j + 1].group === c.group) j++;
    top += `<th colspan="${j - i + 1}">${esc(c.group)}</th>`;
    for (let k = i; k <= j; k++) sub += `<th${cols[k].width ? ` style="width:${cols[k].width}"` : ''}>${esc(cols[k].label)}</th>`;
    i = j;
  }
  return { top, sub };
}

// LayoutConfig.kind === 'journal' -> an RTL journal voucher (قيد يومية), the
// React port of the legacy "Journal Report.frx": centered title with the
// printed-at stamp, a header box of label/value columns (layout.header is an
// array of columns, each an array of { label, field, format, mono }), a lines
// table whose columns may share a two-row group header (column.group), a
// navy totals bar summing the `total: true` columns with its label spanning
// the `totalsLabelSpan` columns before them, and signature lines. Every data
// row carries the journal header fields, so the header reads rows[0].
function journalHTML(meta, rows, layout) {
  const head = rows[0] || {};
  const title = layout.title || meta.ReportName || 'Journal';
  const orient = layout.orientation === 'landscape' ? 'landscape' : 'portrait';
  const size = layout.pageSize || 'A4';
  const accent = layout.accent || '#1e2a4a';
  const cols = Array.isArray(layout.columns) ? layout.columns : [];
  const isNum = c => String(c.format || '').startsWith('number');
  const alignOf = c => c.align || (isNum(c) ? 'left' : 'center');

  const hdrCols = (layout.header || []).map(col => `<div class="hcol">${(col || []).map(f =>
    `<div class="hrow"><span class="hl">${esc(f.label)}</span><span class="hv${f.mono ? ' mono' : ''}">${esc(PO_FMT(head[f.field], f.format)) || '&nbsp;'}</span></div>`
  ).join('')}</div>`).join('');

  const { top, sub } = groupedHead(cols);

  const body = rows.map(r => '<tr>' + cols.map(c => {
    const v = r[c.field];
    const zero = isNum(c) && !Number(v);
    return `<td class="${isNum(c) ? 'n' : ''}${c.mono ? ' mono' : ''}${zero ? ' z' : ''}" style="text-align:${alignOf(c)}">${esc(PO_FMT(v, c.format))}</td>`;
  }).join('') + '</tr>').join('');

  const firstTot = cols.findIndex(c => c.total);
  let totRow = '';
  if (firstTot >= 0) {
    const span = Math.min(Number(layout.totalsLabelSpan) || 1, firstTot);
    const lead = firstTot - span;
    totRow = '<tr class="tot">'
      + (lead > 0 ? `<td class="blank" colspan="${lead}"></td>` : '')
      + (span > 0 ? `<td class="tl" colspan="${span}">${esc(layout.totalsLabel || 'Total')}</td>` : '')
      + cols.slice(firstTot).map(c => c.total
        ? `<td class="n" style="text-align:${alignOf(c)}">${esc(PO_FMT(rows.reduce((s, r) => s + (Number(r[c.field]) || 0), 0), c.format || 'number:2'))}</td>`
        : '<td></td>').join('')
      + '</tr>';
  }

  const sigs = (layout.signatures || []).map(s => `<div class="sig"><div class="sl">${esc(s)}</div><div class="line"></div></div>`).join('');

  return `<!doctype html><html dir="rtl" lang="ar"><head><meta charset="utf-8"><title>${esc(title)} ${esc(head[layout.header?.[0]?.[0]?.field] ?? '')}</title>
<style>
  @page { size: ${size} ${orient}; margin: 12mm; }
  html{-webkit-print-color-adjust:exact;print-color-adjust:exact}
  *{box-sizing:border-box}
  body{font:13px Tahoma,Arial,sans-serif;color:#1c2530;margin:0}
  .top{position:relative;border-bottom:3px solid ${accent};padding:6px 0 12px}
  .top h1{text-align:center;font-size:26px;margin:0;color:${accent}}
  .stamp{position:absolute;left:0;bottom:12px;text-align:left} .stamp .pl{font-size:10px;color:#94a3b8} .stamp .pv{font-size:13px;font-weight:700;direction:ltr}
  .hbox{display:flex;gap:24px;margin:14px 0;background:#f5f6f8;padding:10px 14px;border-radius:4px}
  .hcol{flex:1} .hrow{display:flex;gap:12px;align-items:center;padding:4px 0;min-height:34px}
  .hl{font-weight:700;width:96px;flex:0 0 96px;color:#1c2530} .hv{flex:1;background:#fff;padding:5px 12px;font-weight:700;text-align:right;min-height:26px}
  .hv.mono{direction:ltr;text-align:right}
  .mono{font-family:ui-monospace,Menlo,monospace;direction:ltr;unicode-bidi:embed}
  table.lines{width:100%;border-collapse:collapse;table-layout:fixed;font-size:12px}
  table.lines th{background:${accent};color:#fff;font-weight:700;padding:7px 10px;text-align:center;vertical-align:middle;border:1px solid rgba(255,255,255,.25)}
  table.lines td{padding:9px 10px;border-bottom:1px solid #e5e9ef;vertical-align:middle;overflow-wrap:anywhere}
  table.lines tbody tr:nth-child(even) td{background:#eef0f3}
  table.lines td.n{font-weight:700;font-variant-numeric:tabular-nums;direction:ltr}
  table.lines td.z{color:#5a9a6e;font-weight:400}
  table.lines tr.tot td{background:${accent};color:#fff;font-weight:800;border:none;padding:10px 10px}
  table.lines tr.tot td.tl{text-align:center}
  table.lines tr.tot td.blank{background:#fff}
  .sigs{display:flex;justify-content:space-around;margin-top:34px;break-inside:avoid}
  .sig{width:26%;text-align:center} .sig .sl{font-weight:800;margin-bottom:28px} .sig .line{border-bottom:1.5px solid ${accent}}
  .foot{margin-top:22px;color:#94a3b8;font-size:9.5px;text-align:center}
</style></head><body>
  <div class="top"><h1>${esc(title)}</h1><div class="stamp"><div class="pl">${esc(layout.printedLabel || 'Printed')}</div><div class="pv">${esc(new Date().toLocaleString())}</div></div></div>
  <div class="hbox">${hdrCols}</div>
  <table class="lines"><thead><tr>${top}</tr>${sub ? `<tr>${sub}</tr>` : ''}</thead>
    <tbody>${body || `<tr><td colspan="${cols.length}" style="color:#94a3b8">—</td></tr>`}${totRow}</tbody></table>
  <div class="sigs">${sigs}</div>
  <div class="foot">${esc([meta.ReportName, meta.ReportCode].filter(Boolean).join(' · '))}</div>
  <script>window.onafterprint=function(){setTimeout(function(){window.close();},100);};window.onload=function(){setTimeout(function(){window.print();},300);};</script>
</body></html>`;
}

// LayoutConfig.kind === 'statement' -> an RTL account statement (the React
// port of the legacy "Customer Statement - National.frx"): title + printed
// stamp, a header box (party number / name, From / To), an opening-balance
// row, the period's lines with a running balance, and a navy totals bar
// (debit, credit, closing balance). The rows are the party's posted lines
// (one exact-match report param -- the customer); the From / To window comes
// from the page context and is applied by computeStatement, the same
// function the page uses on screen. layout.columns: [{ field, label, width,
// format, mono, align }] where field 'Balance' is the running balance.
// The title + party / date strip sit inside the table's <thead>, so the browser
// repeats them -- with the column titles -- at the top of every printed page.
// Kept compact on purpose: Chrome stops repeating a <thead> taller than about
// a quarter of the page.
function statementHTML(meta, rows, layout, context) {
  const st = computeStatement(rows, context.FromDate, context.ToDate);
  const title = layout.title || meta.ReportName || 'Statement';
  const orient = layout.orientation === 'landscape' ? 'landscape' : 'portrait';
  const size = layout.pageSize || 'A4';
  const accent = layout.accent || '#1e2a4a';
  const cols = Array.isArray(layout.columns) ? layout.columns : [];
  const isNum = c => String(c.format || '').startsWith('number');
  const alignOf = c => c.align || (isNum(c) ? 'left' : 'center');
  const head = rows[0] || {};
  const partyNo = context[layout.partyField] ?? head[layout.partyField] ?? '';
  const partyName = context[layout.partyNameField] || head[layout.partyNameField] || '';
  const money = v => PO_FMT(v, 'number:2');
  const firstNum = cols.findIndex(c => c.field === 'DebitBook');
  const lead = firstNum >= 0 ? firstNum : Math.max(cols.length - 3, 0);

  const th = cols.map(c => `<th class="col" style="width:${c.width || 'auto'}">${esc(c.label || c.field)}</th>`).join('');
  const openRow = `<tr class="open"><td colspan="${cols.length - 1}" class="tl">${esc(layout.openingLabel || 'Opening balance')}</td><td class="n">${esc(money(st.opening))}</td></tr>`;
  const body = st.lines.map(r => '<tr>' + cols.map(c => {
    const v = r[c.field];
    const zero = isNum(c) && !Number(v) && c.field !== 'Balance';
    return `<td class="${isNum(c) ? 'n' : ''}${c.mono ? ' mono' : ''}${zero ? ' z' : ''}" style="text-align:${alignOf(c)}">${esc(zero ? '' : PO_FMT(v, c.format))}</td>`;
  }).join('') + '</tr>').join('');
  const totRow = '<tr class="tot">'
    + (lead > 0 ? `<td class="tl" colspan="${lead}">${esc(layout.totalsLabel || 'Total')}</td>` : '')
    + cols.slice(lead).map(c => `<td class="n" style="text-align:${alignOf(c)}">${esc(
        c.field === 'DebitBook' ? money(st.debit) : c.field === 'CreditBook' ? money(st.credit) : c.field === 'Balance' ? money(st.closing) : '')}</td>`).join('')
    + '</tr>';

  return `<!doctype html><html dir="rtl" lang="ar"><head><meta charset="utf-8"><title>${esc(title)} ${esc(partyNo)}</title>
<style>
  @page { size: ${size} ${orient}; margin: 12mm; }
  html{-webkit-print-color-adjust:exact;print-color-adjust:exact}
  *{box-sizing:border-box}
  body{font:13px Tahoma,Arial,sans-serif;color:#1c2530;margin:0}
  .top{position:relative;border-bottom:2px solid ${accent};padding:2px 0 6px}
  .top h1{text-align:center;font-size:19px;margin:0;color:${accent}}
  .stamp{position:absolute;left:0;bottom:6px;text-align:left;font-size:10px;color:#64748b;direction:ltr}
  .hstrip{display:flex;gap:10px;margin:6px 0 6px;background:#f5f6f8;padding:5px 10px;border-radius:4px;font-size:11.5px}
  .hf{display:flex;gap:6px;align-items:center;flex:1 1 auto;min-width:0}
  .hf.wide{flex:3 1 0} .hl{font-weight:700;white-space:nowrap} .hv{flex:1;background:#fff;padding:3px 8px;font-weight:700;text-align:right;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .mono{font-family:ui-monospace,Menlo,monospace;direction:ltr;unicode-bidi:isolate}
  table.lines{width:100%;border-collapse:collapse;table-layout:fixed;font-size:11.5px}
  table.lines thead{display:table-header-group} table.lines tfoot{display:table-footer-group}
  table.lines tr{break-inside:avoid;page-break-inside:avoid}
  table.lines th.cap{background:#fff;padding:0;border:none;text-align:inherit;font-weight:400;color:#1c2530}
  table.lines th.col{background:${accent};color:#fff;font-weight:700;padding:7px 8px;text-align:center;border:1px solid rgba(255,255,255,.25)}
  table.lines td{padding:7px 8px;border-bottom:1px solid #e5e9ef;vertical-align:middle;overflow-wrap:anywhere}
  table.lines tbody tr:nth-child(even) td{background:#eef0f3}
  table.lines td.n{font-weight:700;font-variant-numeric:tabular-nums;direction:ltr}
  table.lines td.z{color:#94a3b8}
  table.lines tr.open td{background:#e8edf5 !important;font-weight:800}
  table.lines tr.open td.tl, table.lines tr.tot td.tl{text-align:center}
  table.lines tr.tot td{background:${accent} !important;color:#fff;font-weight:800;border:none;padding:9px 8px}
  .foot{margin-top:22px;color:#94a3b8;font-size:9.5px;text-align:center}
</style></head><body>
  <table class="lines"><thead>
    <tr><th class="cap" colspan="${cols.length}">
      <div class="top"><h1>${esc(title)}</h1><div class="stamp">${esc(layout.printedLabel || 'Printed')} ${esc(new Date().toLocaleString())}</div></div>
      <div class="hstrip">
        <div class="hf"><span class="hl">${esc(layout.partyLabel || 'No')}</span><span class="hv"><bdi dir="ltr" class="mono">${esc(partyNo)}</bdi></span></div>
        <div class="hf wide"><span class="hl">${esc(layout.partyNameLabel || 'Name')}</span><span class="hv">${esc(partyName)}</span></div>
        <div class="hf"><span class="hl">${esc(layout.fromLabel || 'From')}</span><span class="hv"><bdi dir="ltr" class="mono">${esc(String(context.FromDate || '').slice(0, 10))}</bdi></span></div>
        <div class="hf"><span class="hl">${esc(layout.toLabel || 'To')}</span><span class="hv"><bdi dir="ltr" class="mono">${esc(String(context.ToDate || '').slice(0, 10))}</bdi></span></div>
      </div>
    </th></tr>
    <tr>${th}</tr></thead><tbody>${openRow}${body}${totRow}</tbody></table>
  <div class="foot">${esc([meta.ReportName, meta.ReportCode].filter(Boolean).join(' · '))}</div>
  <script>window.onafterprint=function(){setTimeout(function(){window.close();},100);};window.onload=function(){setTimeout(function(){window.print();},300);};</script>
</body></html>`;
}

// Amount in Arabic words (the legacy report's AmountToWord / ToWord):
// "فقط <amount> <currency> و <fraction> <sub-unit> لا غير". Absolute value, so
// a return prints the same words as its positive.
const AR_ONES = ['', 'واحد', 'اثنان', 'ثلاثة', 'أربعة', 'خمسة', 'ستة', 'سبعة', 'ثمانية', 'تسعة', 'عشرة',
  'أحد عشر', 'اثنا عشر', 'ثلاثة عشر', 'أربعة عشر', 'خمسة عشر', 'ستة عشر', 'سبعة عشر', 'ثمانية عشر', 'تسعة عشر'];
const AR_TENS = ['', '', 'عشرون', 'ثلاثون', 'أربعون', 'خمسون', 'ستون', 'سبعون', 'ثمانون', 'تسعون'];
const AR_HUNDREDS = ['', 'مائة', 'مائتان', 'ثلاثمائة', 'أربعمائة', 'خمسمائة', 'ستمائة', 'سبعمائة', 'ثمانمائة', 'تسعمائة'];
const AR_SCALES = [
  null,
  { one: 'ألف', two: 'ألفان', few: 'آلاف', many: 'ألف' },
  { one: 'مليون', two: 'مليونان', few: 'ملايين', many: 'مليون' },
  { one: 'مليار', two: 'ملياران', few: 'مليارات', many: 'مليار' },
];
const AR_CURRENCY = {
  EGP: ['جنيه مصري', 'قرش'], USD: ['دولار أمريكي', 'سنت'], EUR: ['يورو', 'سنت'], GBP: ['جنيه إسترليني', 'بنس'],
};
function arBelow1000(n) {
  const h = Math.floor(n / 100), r = n % 100, parts = [];
  if (h) parts.push(AR_HUNDREDS[h]);
  if (r) parts.push(r < 20 ? AR_ONES[r] : (r % 10 ? `${AR_ONES[r % 10]} و${AR_TENS[Math.floor(r / 10)]}` : AR_TENS[Math.floor(r / 10)]));
  return parts.join(' و');
}
function arInteger(n) {
  if (n === 0) return 'صفر';
  const groups = [];
  for (let i = 0; n > 0 && i < AR_SCALES.length; i++, n = Math.floor(n / 1000)) {
    const g = n % 1000;
    if (!g) continue;
    const sc = AR_SCALES[i];
    groups.unshift(!sc ? arBelow1000(g)
      : g === 1 ? sc.one : g === 2 ? sc.two
      : g <= 10 ? `${arBelow1000(g)} ${sc.few}` : `${arBelow1000(g)} ${sc.many}`);
  }
  return groups.join(' و');
}
function amountToArabicWords(amount, currency) {
  const v = Math.abs(Number(amount) || 0);
  let whole = Math.floor(v), frac = Math.round((v - whole) * 100);
  if (frac === 100) { whole += 1; frac = 0; }
  const [main, sub] = AR_CURRENCY[String(currency || 'EGP').toUpperCase()] || [String(currency || ''), ''];
  return `فقط ${arInteger(whole)} ${main}${frac ? ` و${arInteger(frac)} ${sub}` : ''} لا غير`;
}

// LayoutConfig.kind === 'salesInvoice' -> the RTL customer invoice (the React
// port of "Template Invoice.frx", legacy data PFX.ACR500_1 / _2): title by
// tax / sign (فاتورة, فاتورة مرتجع, مطالبة, مرتجع), customer + invoice panels,
// the lines (item code / barcode, Arabic description, qty, unit, gross price,
// discount % and value, net value) under a header repeated on every page, a
// totals box (total value, discount, net value, VAT, freight, amount due), the
// amount in words, notes and the company tax fields. layout: lines { queryId,
// keyField, sortField }, notes [], companyTax [{label, value}], and
// hidePartyPrefix -- customers whose number starts with it (cash sales) print
// without number / address, as in the legacy HideMemo.
function salesInvoiceTitle(head) {
  const tax = Number(head.TotalTaxAmount) || 0, amt = Number(head.TotalFinalAmountBase) || 0;
  if (tax !== 0) return amt > 0 ? 'فاتورة' : 'فاتورة مرتجع';
  return amt > 0 ? 'مطالبة' : 'مرتجع';
}
function salesInvoiceHTML(meta, head, rawLines, layout) {
  const sf = layout.lines && layout.lines.sortField;
  const lines = sf ? [...rawLines].sort((a, b) => (Number(a[sf]) || 0) - (Number(b[sf]) || 0)) : rawLines;
  const accent = layout.accent || '#1e2a4a';
  const money = v => PO_FMT(v, 'number:2');
  const qty = v => { const n = Number(v); return Number.isFinite(n) ? n.toLocaleString(undefined, { maximumFractionDigits: 3 }) : ''; };
  const title = salesInvoiceTitle(head);
  const docNo = `${head.DoucmentPrefix || ''}${head.DoucmentNumber || ''}`;
  const cash = layout.hidePartyPrefix && String(head.CustomerNumber ?? '').startsWith(String(layout.hidePartyPrefix));
  const prow = (label, value, mono) => `<div class="prow"><span class="pl">${esc(label)}</span><span class="pv">${mono ? `<bdi dir="ltr" class="mono">${esc(value)}</bdi>` : esc(value)}</span></div>`;
  const totals = [
    ['إجمالي القيمة', head.TotalItemAmount], ['قيمة الخصم', head.TotalDiscount], ['صافي القيمة', head.TotalTaxtableAmount],
    ['ضريبة القيمة المضافة', head.TotalTaxAmount], ['قيمة النولون', head.TotalFreightAmount], ['القيمة المطلوب سدادها', head.TotalFinalAmountTransaction],
  ];
  const body = lines.map((r, i) => {
    const disc = Number(r.LineAmountTransaction) ? -100 * (Number(r.LineDiscountTransaction) || 0) / Number(r.LineAmountTransaction) : 0;
    return `<tr>
      <td class="c">${esc(r.InvoiceLine ?? i + 1)}</td>
      <td class="c mono">${esc(r.ItemCode || '')}${r.Barcode ? `<div class="sub">${esc(r.Barcode)}</div>` : ''}</td>
      <td class="d">${esc(r.ItemExtraDescription || r.ItemDescription || '')}</td>
      <td class="n">${esc(qty(r.InvoicedQuantity))}</td>
      <td class="c">${esc(r.StockingUnitofMeasure || '')}</td>
      <td class="n">${esc(money(r.Price))}</td>
      <td class="n">${disc ? esc(`${disc.toLocaleString(undefined, { maximumFractionDigits: 2 })} %`) : ''}</td>
      <td class="n">${Number(r.LineDiscountTransaction) ? esc(money(r.LineDiscountTransaction)) : ''}</td>
      <td class="n b">${esc(money(r.LineTaxtableAmount))}</td>
    </tr>`;
  }).join('');
  const user = (typeof sessionStorage !== 'undefined' && (sessionStorage.getItem('Username') || sessionStorage.getItem('FullName'))) || '';

  return `<!doctype html><html dir="rtl" lang="ar"><head><meta charset="utf-8"><title>${esc(title)} ${esc(docNo)}</title>
<style>
  @page { size: ${layout.pageSize || 'A4'} ${layout.orientation === 'landscape' ? 'landscape' : 'portrait'}; margin: 10mm; }
  html{-webkit-print-color-adjust:exact;print-color-adjust:exact}
  *{box-sizing:border-box}
  body{font:12px Tahoma,Arial,sans-serif;color:#1c2530;margin:0}
  .mono{font-family:ui-monospace,Menlo,monospace;direction:ltr;unicode-bidi:isolate}
  .top{display:flex;align-items:flex-end;justify-content:space-between;border-bottom:3px solid ${accent};padding-bottom:6px}
  .top h1{margin:0;font-size:26px;color:${accent}}
  .top .stamp{font-size:10px;color:#64748b;direction:ltr;text-align:left}
  .panels{display:flex;gap:14px;margin:10px 0 8px}
  .panel{flex:1;border:1px solid #d5dbe5;border-radius:6px;padding:8px 12px}
  .panel.wide{flex:1.6}
  .panel h3{margin:0 0 6px;font-size:13px;color:${accent};border-bottom:2px solid ${accent};display:inline-block;padding-bottom:2px}
  .prow{display:flex;gap:10px;padding:3px 0;font-size:12px}
  .pl{color:#64748b;font-weight:700;min-width:105px}
  .pv{font-weight:700;flex:1}
  table.lines{width:100%;border-collapse:collapse;table-layout:fixed;font-size:11px}
  table.lines thead{display:table-header-group}
  table.lines tr{break-inside:avoid;page-break-inside:avoid}
  table.lines th{background:${accent};color:#fff;font-weight:700;padding:6px 4px;border:1px solid rgba(255,255,255,.25);text-align:center}
  table.lines td{padding:5px 4px;border-bottom:1px solid #e5e9ef;vertical-align:middle;overflow-wrap:anywhere}
  table.lines tbody tr:nth-child(even) td{background:#f3f5f8}
  td.c{text-align:center} td.d{text-align:right} td.n{text-align:left;direction:ltr;font-variant-numeric:tabular-nums}
  td.b{font-weight:800}
  .sub{font-size:9.5px;color:#64748b}
  .foot{display:flex;gap:14px;margin-top:12px;break-inside:avoid;page-break-inside:avoid}
  .notes{flex:1.3;border:1px solid #d5dbe5;border-radius:6px;padding:8px 12px;font-size:11.5px}
  .notes h3{margin:0 0 6px;font-size:13px;color:${accent}}
  .notes p{margin:0 0 4px}
  .notes .tax{margin-top:10px;border-top:1px dashed #cbd5e1;padding-top:6px}
  .sumcol{flex:1}
  table.tot{width:100%;border-collapse:collapse;font-size:12px}
  table.tot td{border:1px solid #cbd5e1;padding:5px 8px}
  table.tot td.v{text-align:left;direction:ltr;font-weight:800;font-variant-numeric:tabular-nums;width:45%}
  table.tot tr.hl td{background:#d9dee8;font-weight:800}
  table.tot tr.due td{background:${accent};color:#fff}
  .words{margin-top:6px;border:1px solid #d5dbe5;border-radius:6px;padding:6px 10px;font-weight:700;font-size:12px;background:#f7f8fa}
  .printed{margin-top:10px;font-size:9.5px;color:#94a3b8;display:flex;justify-content:space-between}
</style></head><body>
  <div class="top"><h1>${esc(title)}</h1><div class="stamp">${esc(new Date().toLocaleString())}</div></div>
  <div class="panels">
    <div class="panel wide"><h3>معلومات العميل</h3>
      ${prow('اسم العميل', head.CustomerExtraName || head.CustomerName || '')}
      ${cash ? '' : prow('رقم العميل', head.CustomerNumber ?? '', true)}
      ${head.TaxRegistration ? prow('رقم التسجيل الضريبي', head.TaxRegistration, true) : ''}
      ${cash ? '' : prow('العنوان', head.ShipToAddressDisplay || head.ShipToAddress || '')}
    </div>
    <div class="panel"><h3>تفاصيل الفاتورة</h3>
      ${prow('تاريخ الإصدار', String(head.InvoiceDate || '').slice(0, 10), true)}
      ${prow('رقم مرجعي', docNo, true)}
    </div>
  </div>
  <table class="lines">
    <colgroup><col style="width:5%"><col style="width:13%"><col style="width:26%"><col style="width:8%"><col style="width:7%"><col style="width:9%"><col style="width:8%"><col style="width:10%"><col style="width:14%"></colgroup>
    <thead><tr><th>م</th><th>رقم الصنف<br>باركود الصنف</th><th>اسم الصنف</th><th>الكمية</th><th>الوحدة</th><th>السعر</th><th>نسبة الخصم</th><th>قيمة الخصم</th><th>صافي القيمة</th></tr></thead>
    <tbody>${body || '<tr><td colspan="9" class="c">—</td></tr>'}</tbody>
  </table>
  <div class="foot">
    <div class="notes"><h3>ملاحظات</h3>
      ${(layout.notes || []).map(n => `<p>${esc(n)}</p>`).join('')}
      ${(layout.companyTax || []).length ? `<div class="tax">${layout.companyTax.map(t => prow(t.label, t.value || '', true)).join('')}</div>` : ''}
    </div>
    <div class="sumcol">
      <table class="tot">${totals.map(([l, v], i) => `<tr class="${i === 0 ? 'hl' : i === totals.length - 1 ? 'due' : ''}"><td>${esc(l)}</td><td class="v">${esc(money(v))}</td></tr>`).join('')}</table>
      <div class="words">${esc(amountToArabicWords(head.TotalFinalAmountTransaction, head.Currency))}</div>
    </div>
  </div>
  <div class="printed"><span>${esc(user)}</span><span>${esc([meta.ReportName, meta.ReportCode].filter(Boolean).join(' · '))}</span></div>
  <script>window.onafterprint=function(){setTimeout(function(){window.close();},100);};window.onload=function(){setTimeout(function(){window.print();},300);};</script>
</body></html>`;
}

// LayoutConfig.kind === 'accountStatement' -> the RTL account statement (the
// React port of the legacy "AccountStatment.frx", كشف حساب): one block per
// Account (split by any Group-by dimension the page picked), each with a
// header band, the opening balance, the period's lines with running Book
// (local) and Transaction (foreign) balances, and a totals / closing row; a
// navy grand-total bar when there is more than one block. The blocks are the
// ones the Account Statement page already built (buildAccountStatement, from
// its permission-checked GetGridData calls) and passes as
// context.accountStatement -- the report's own GetReportData call only
// validates access (report params are exact-match, so a date window can't be
// sent). The title + account / date strip print once on top; each block is
// its own table, starting on a new page, whose <thead> holds the block card
// above the column titles, so both repeat on every page the block continues onto (kept compact -- see
// statementHTML).
function accountStatementHTML(meta, layout, s) {
  const title = layout.title || meta.ReportName || 'Account Statement';
  const orient = layout.orientation === 'landscape' ? 'landscape' : 'portrait';
  const size = layout.pageSize || 'A4';
  const accent = layout.accent || '#1e2a4a';
  const money = v => PO_FMT(v, 'number:2');
  const amt = v => (Number(v) ? money(v) : '');
  const rate = v => (Number(v) ? Number(v).toLocaleString(undefined, { maximumFractionDigits: 4 }) : '');
  const t = s.totals;
  const acct = s.accountTo && s.accountTo !== s.accountFrom ? `${s.accountFrom} – ${s.accountTo}` : s.accountFrom;
  const acctName = s.accountTo && s.accountTo !== s.accountFrom ? '' : (s.groups[0]?.accountDescription || s.accountName || '');
  const N = 11;

  const colgroup = `<colgroup><col style="width:8%"><col style="width:9%"><col style="width:21%"><col style="width:5%"><col style="width:5%">
      <col style="width:8.6%"><col style="width:8.6%"><col style="width:8.8%"><col style="width:8.6%"><col style="width:8.6%"><col style="width:8.8%"></colgroup>`;
  const colHead = `<tr><th class="col" rowspan="2">تاريخ الحركة</th><th class="col" rowspan="2">رقم المستند</th><th class="col" rowspan="2">وصف الحركة</th>
      <th class="col" rowspan="2">العملة</th><th class="col" rowspan="2">المعدل</th>
      <th class="col" colspan="3">${esc(layout.bookLabel || 'Book')}</th><th class="col" colspan="3">${esc(layout.transLabel || 'Transaction')}</th></tr>
    <tr><th class="col">مدين</th><th class="col">دائن</th><th class="col">الرصيد</th><th class="col">مدين</th><th class="col">دائن</th><th class="col">الرصيد</th></tr>`;
  const block = (g, last) => {
    const trans = g.currency !== 'mixed';
    // block header (legacy style): the account, its cost centres (the segments
    // this block is grouped by) as labelled tiles, and the opening / current
    // balance -- Transaction too when the block is one foreign currency
    const fx = trans && g.currency && g.currency !== 'EGP' ? g.currency : '';
    const tiles = g.dims.map(d => `<div class="tile"><div class="glbl">${esc(d.ar || d.label)}</div><div class="tn">${esc(d.name || (d.code ? '' : '—'))}</div>${d.code ? `<div class="tc mono">${esc(d.code)}</div>` : ''}</div>`).join('');
    const bal = (label, b, tv, main) => `<div class="bx${main ? ' main' : ''}"><div class="glbl">${esc(label)}</div><div class="bv${b < -0.004 ? ' neg' : ''}">${esc(money(b))}</div>${fx ? `<div class="bt">${esc(money(tv))} ${esc(fx)}</div>` : ''}</div>`;
    const head = `<tr class="gh"><td colspan="${N}"><div class="gcard">
      <div class="gacct"><div class="glbl">${esc(layout.accountLabel || 'Account')}</div><div class="gval"><bdi dir="ltr" class="mono">${esc(g.account)}</bdi><span>${esc(g.accountDescription)}</span></div></div>
      ${tiles ? `<div class="gcc"><div class="glbl">${esc(layout.costCentresLabel || 'مراكز التكلفة')}</div><div class="tiles">${tiles}</div></div>` : ''}
      <div class="gbal">${bal(layout.openingLabel || 'Opening', g.openB, g.openT, false)}${bal(layout.closingLabel || 'Closing', g.closeB, g.closeT, true)}</div>
    </div></td></tr>`;
    const lines = g.lines.map(r => `<tr>
      <td class="c mono">${esc(String(r.JournalDate || '').slice(0, 10))}</td>
      <td class="c mono">${esc(r.JournalNumber || '')}<div class="ev">${esc(r.EventNo ?? '')}</div></td>
      <td class="d">${esc(r.LineDescription || '')}</td>
      <td class="c">${esc(r.LineCurrency || '')}</td><td class="n">${esc(rate(r.LineExchangeRate))}</td>
      <td class="n">${esc(amt(r.DebitBook))}</td><td class="n">${esc(amt(r.CreditBook))}</td><td class="n b">${esc(money(r.BalanceBook))}</td>
      <td class="n">${esc(amt(r.DebitTransaction))}</td><td class="n">${esc(amt(r.CreditTransaction))}</td><td class="n b">${trans ? esc(money(r.BalanceTrans)) : ''}</td>
    </tr>`).join('');
    return `<table class="lines blk">${colgroup}<thead>${head}${colHead}</thead><tbody>
      <tr class="open"><td colspan="7" class="tl">${esc(layout.openingLabel || 'Opening balance')}</td><td class="n">${esc(money(g.openB))}</td><td colspan="2"></td><td class="n">${trans ? esc(money(g.openT)) : ''}</td></tr>
      ${lines}
      <tr class="${last && s.groups.length === 1 ? 'tot' : 'gtot'}"><td colspan="5" class="tl">${esc(layout.totalsLabel || 'Totals')} · ${esc(layout.closingLabel || 'Closing')}</td>
        <td class="n">${esc(money(g.debitB))}</td><td class="n">${esc(money(g.creditB))}</td><td class="n">${esc(money(g.closeB))}</td>
        <td class="n">${esc(money(g.debitT))}</td><td class="n">${esc(money(g.creditT))}</td><td class="n">${trans ? esc(money(g.closeT)) : ''}</td></tr>
    </tbody></table>`;
  };
  const grand = s.groups.length > 1 ? `<table class="lines">${colgroup}<tbody><tr class="tot"><td colspan="5" class="tl">${esc(layout.grandLabel || 'Statement total')}</td>
      <td class="n">${esc(money(t.debitB))}</td><td class="n">${esc(money(t.creditB))}</td><td class="n">${esc(money(t.closeB))}</td>
      <td class="n">${t.currency !== 'mixed' ? esc(money(t.debitT)) : ''}</td><td class="n">${t.currency !== 'mixed' ? esc(money(t.creditT)) : ''}</td><td class="n">${t.currency !== 'mixed' ? esc(money(t.closeT)) : ''}</td></tr></tbody></table>` : '';
  const empty = s.groups.length ? '' : `<table class="lines">${colgroup}<tbody><tr><td colspan="${N}" class="tl">—</td></tr></tbody></table>`;

  return `<!doctype html><html dir="rtl" lang="ar"><head><meta charset="utf-8"><title>${esc(title)} ${esc(acct)}</title>
<style>
  @page { size: ${size} ${orient}; margin: 11mm; }
  html{-webkit-print-color-adjust:exact;print-color-adjust:exact}
  *{box-sizing:border-box}
  body{font:12px Tahoma,Arial,sans-serif;color:#1c2530;margin:0}
  .top{position:relative;border-bottom:2px solid ${accent};padding:2px 0 6px}
  .top h1{text-align:center;font-size:19px;margin:0;color:${accent}}
  .stamp{position:absolute;left:0;bottom:6px;text-align:left;font-size:10px;color:#64748b;direction:ltr}
  .hstrip{display:flex;gap:10px;margin:6px 0;background:#f5f6f8;padding:5px 10px;border-radius:4px;font-size:11.5px}
  .hf{display:flex;gap:6px;align-items:center;flex:1 1 auto;min-width:0}
  .hf.wide{flex:3 1 0} .hl{font-weight:700;white-space:nowrap} .hv{flex:1;background:#fff;padding:3px 8px;font-weight:700;text-align:right;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .mono{font-family:ui-monospace,Menlo,monospace;direction:ltr;unicode-bidi:isolate}
  table.lines{width:100%;border-collapse:collapse;table-layout:fixed;font-size:10.5px;margin-top:10px}
  table.blk + table.blk{break-before:page;page-break-before:always}
  table.lines thead{display:table-header-group}
  table.lines tr{break-inside:avoid;page-break-inside:avoid}
  table.lines th.col{background:${accent};color:#fff;font-weight:700;padding:5px 6px;text-align:center;border:1px solid rgba(255,255,255,.25)}
  table.lines td{padding:5px 6px;border-bottom:1px solid #e5e9ef;vertical-align:middle;overflow-wrap:anywhere}
  table.lines td.c{text-align:center} table.lines td.d{text-align:right}
  table.lines td.n{text-align:left;font-weight:700;font-variant-numeric:tabular-nums;direction:ltr}
  table.lines td.b{background:#f7f8fa}
  .ev{font-size:9px;color:#64748b}
  table.lines tr.gh td{background:#fff !important;border:none;padding:10px 0 6px}
  .gcard{display:flex;gap:12px;align-items:stretch;border:1px solid #cfd6e2;border-top:3px solid ${accent};border-radius:6px;padding:8px 10px;background:#f7f9fc}
  .glbl{font-size:9.5px;color:#64748b;font-weight:700;margin-bottom:3px;white-space:nowrap}
  .gacct{min-width:20%;max-width:30%} .gval{font-size:13px;font-weight:800;color:${accent};display:flex;gap:8px;align-items:baseline;flex-wrap:wrap}
  .gcc{flex:1;border-right:1px solid #dbe1ea;padding-right:12px;min-width:0}
  .tiles{display:flex;flex-wrap:wrap;gap:6px}
  .tile{background:#fff;border:1px solid #e2e7ef;border-right:3px solid #c2410c;border-radius:4px;padding:3px 9px;min-width:110px}
  .tile .glbl{margin-bottom:1px} .tn{font-weight:800;font-size:11px} .tc{font-size:10px;color:#475569}
  .gbal{display:flex;gap:6px;margin-right:auto}
  .bx{background:#fff;border:1px solid #e2e7ef;border-radius:4px;padding:4px 10px;min-width:118px;text-align:left}
  .bx .glbl{text-align:right} .bx.main{background:${accent};border-color:${accent};color:#fff} .bx.main .glbl{color:#cbd5e1}
  .bv{font-size:13px;font-weight:800;direction:ltr;font-variant-numeric:tabular-nums} .bv.neg{color:#b42318} .bx.main .bv.neg{color:#fecaca}
  .bt{font-size:9.5px;direction:ltr;opacity:.8}
  table.lines tr.open td{background:#eef1f6 !important;font-weight:800}
  table.lines td.tl{text-align:center}
  table.lines tr.gtot td{background:#e3e8f0 !important;font-weight:800;border-bottom:2px solid ${accent}}
  table.lines tr.tot td{background:${accent} !important;color:#fff;font-weight:800;border:none;padding:8px 6px}
</style></head><body>
  <div class="top"><h1>${esc(title)}</h1><div class="stamp">${esc(layout.printedLabel || 'Printed')} ${esc(new Date().toLocaleString())}</div></div>
  <div class="hstrip">
    <div class="hf"><span class="hl">${esc(layout.accountLabel || 'Account')}</span><span class="hv"><bdi dir="ltr" class="mono">${esc(acct)}</bdi></span></div>
    <div class="hf wide"><span class="hv">${esc(acctName)}</span></div>
    <div class="hf"><span class="hl">${esc(layout.fromLabel || 'From')}</span><span class="hv"><bdi dir="ltr" class="mono">${esc(String(s.from || '').slice(0, 10))}</bdi></span></div>
    <div class="hf"><span class="hl">${esc(layout.toLabel || 'To')}</span><span class="hv"><bdi dir="ltr" class="mono">${esc(String(s.to || '').slice(0, 10))}</bdi></span></div>
  </div>
  ${s.groups.map((g, i) => block(g, i === s.groups.length - 1)).join('')}${grand}${empty}
  <script>window.onafterprint=function(){setTimeout(function(){window.close();},100);};window.onload=function(){setTimeout(function(){window.print();},300);};</script>
</body></html>`;
}

// LayoutConfig.kind === 'permit' -> RTL warehouse permits (the React port of
// the legacy "NEW RELEASE REPORT.frx"): one record + its detail lines printed
// as one or more A4 pages (layout.pages), each with a centered title, a header
// box (columns of { label, field, format, mono }), a lines table (columns of
// { label, field, format, divisorField, group, width, align, total }) and
// optional declaration paragraphs (statements: [{ title, text }]), hand-written
// notes and signature lines. A header field or column
// with no `field` prints blank for filling in by hand (driver, actual qty…);
// `rowHeight` makes the lines tall enough to write in. The lines come from the
// Detail query in layout.lines (optionally ordered by lines.sortField, and
// lines.nonZeroField drops rows where that field is 0 -- e.g. unshipped),
// fetched once and shared by every page.
function permitHTML(meta, head, rawLines, layout) {
  const sf = layout.lines && layout.lines.sortField;
  const nz = layout.lines && layout.lines.nonZeroField;
  const kept = nz ? rawLines.filter(r => Number(r[nz]) !== 0) : rawLines;
  const lines = sf ? [...kept].sort((a, b) => (Number(a[sf]) || 0) - (Number(b[sf]) || 0)) : kept;
  const orient = layout.orientation === 'landscape' ? 'landscape' : 'portrait';
  const size = layout.pageSize || 'A4';
  const accent = layout.accent || '#1e2a4a';
  const isNum = c => String(c.format || '').startsWith('number');
  const cellVal = (r, c) => {
    if (!c.field) return null;
    if (!c.divisorField) return r[c.field];
    return Number(r[c.divisorField]) > 0 ? Number(r[c.field] || 0) / Number(r[c.divisorField]) : null;
  };
  const printed = new Date().toLocaleString();
  const pages = Array.isArray(layout.pages) && layout.pages.length ? layout.pages : [layout];

  const pageHTML = p => {
    const cols = Array.isArray(p.columns) ? p.columns : [];
    // numbers centered under their (centered) headers, like the legacy .frx
    const alignOf = c => c.align || 'center';
    const hdrCols = (p.header || []).map(col => `<div class="hcol">${(col || []).map(f =>
      `<div class="hrow"><span class="hl">${esc(f.label)}</span><span class="hv${f.mono ? ' mono' : ''}${f.field ? '' : ' fill'}">${f.field ? (esc(PO_FMT(head[f.field], f.format)) || '&nbsp;') : '&nbsp;'}</span></div>`
    ).join('')}</div>`).join('');
    const { top, sub } = groupedHead(cols);
    const rh = p.rowHeight ? ` style="height:${esc(p.rowHeight)}"` : '';
    const body = lines.map(r => `<tr${rh}>` + cols.map(c => {
      const v = cellVal(r, c);
      return `<td class="${isNum(c) ? 'n' : ''}${c.mono ? ' mono' : ''}" style="text-align:${alignOf(c)}">${esc(PO_FMT(v, c.format))}</td>`;
    }).join('') + '</tr>').join('');
    const firstTot = cols.findIndex(c => c.total);
    const totRow = firstTot < 0 ? '' : '<tr class="tot">'
      + (firstTot > 0 ? `<td class="tl" colspan="${firstTot}">${esc(p.totalsLabel || 'Total')}</td>` : '')
      + cols.slice(firstTot).map(c => c.total
        ? `<td class="n" style="text-align:${alignOf(c)}">${esc(PO_FMT(lines.reduce((s, r) => s + (Number(cellVal(r, c)) || 0), 0), c.format || 'number:2'))}</td>`
        : '<td></td>').join('')
      + '</tr>';
    const stmts = (p.statements || []).map(t => `<div class="stmt">${t.title ? `<div class="stt">${esc(t.title)}</div>` : ''}<div class="stx">${esc(t.text)}</div></div>`).join('');
    const notes = (p.notes || []).map(n => `<div class="wn"><span class="wl">${esc(n)}</span><span class="wline"></span></div>`).join('');
    const sigs = (p.signatures || []).map(s => `<div class="sig"><div class="sl">${esc(s)}</div><div class="line"></div></div>`).join('');
    return `<section class="pg">
    <div class="top"><h1>${esc(p.title || meta.ReportName || '')}</h1>${p.subtitle ? `<div class="subt">${esc(p.subtitle)}</div>` : ''}
      <div class="stamp"><div class="pl">${esc(layout.printedLabel || 'Printed')}</div><div class="pv">${esc(printed)}</div></div></div>
    <div class="hbox">${hdrCols}</div>
    <table class="lines"><thead><tr>${top}</tr>${sub ? `<tr>${sub}</tr>` : ''}</thead>
      <tbody>${body || `<tr><td colspan="${cols.length}" style="color:#94a3b8">—</td></tr>`}${totRow}</tbody></table>
    ${stmts ? `<div class="stmts">${stmts}</div>` : ''}
    ${notes ? `<div class="notes">${notes}</div>` : ''}
    ${sigs ? `<div class="sigs">${sigs}</div>` : ''}
    <div class="foot">${esc([meta.ReportName, meta.ReportCode].filter(Boolean).join(' · '))}</div>
  </section>`;
  };

  const docNo = head[layout.numberField] ?? '';
  return `<!doctype html><html dir="rtl" lang="ar"><head><meta charset="utf-8"><title>${esc(meta.ReportName || pages[0].title || 'Permit')} ${esc(docNo)}</title>
<style>
  @page { size: ${size} ${orient}; margin: 12mm; }
  html{-webkit-print-color-adjust:exact;print-color-adjust:exact}
  *{box-sizing:border-box}
  body{font:13px Tahoma,Arial,sans-serif;color:#1c2530;margin:0}
  .pg{break-after:page;page-break-after:always}
  .pg:last-child{break-after:auto;page-break-after:auto}
  @media screen { .pg + .pg{margin-top:28px;padding-top:28px;border-top:2px dashed #cbd5e1} }
  .top{position:relative;border-bottom:3px solid ${accent};padding:2px 0 8px}
  .top h1{text-align:center;font-size:22px;margin:0;color:${accent}}
  .top .subt{text-align:center;font-size:13px;font-weight:700;color:#475569;margin-top:4px}
  .stamp{position:absolute;left:0;bottom:8px;text-align:left} .stamp .pl{font-size:9px;color:#94a3b8} .stamp .pv{font-size:11px;font-weight:700;direction:ltr}
  .hbox{display:flex;gap:18px;margin:10px 0;background:#f5f6f8;padding:6px 10px;border-radius:4px;font-size:11.5px}
  .hcol{flex:1} .hrow{display:flex;gap:8px;align-items:center;padding:2px 0;min-height:24px}
  .hl{font-weight:700;width:92px;flex:0 0 92px;color:#1c2530} .hv{flex:1;background:#fff;padding:2px 8px;font-weight:700;text-align:right;min-height:20px;overflow-wrap:anywhere}
  .hv.fill{background:transparent;border-bottom:1.5px dotted #64748b}
  .hv.mono{direction:ltr;text-align:right}
  .mono{font-family:ui-monospace,Menlo,monospace;direction:ltr;unicode-bidi:embed}
  table.lines{width:100%;border-collapse:collapse;table-layout:fixed;font-size:12px}
  table.lines thead{display:table-header-group}
  table.lines tr{break-inside:avoid}
  table.lines th{background:${accent};color:#fff;font-weight:700;padding:7px 10px;text-align:center;vertical-align:middle;border:1px solid rgba(255,255,255,.25)}
  table.lines td{padding:8px 10px;border:1px solid #d7dce3;vertical-align:middle;overflow-wrap:anywhere}
  table.lines tbody tr:nth-child(even) td{background:#f3f5f8}
  table.lines td.n{font-weight:700;font-variant-numeric:tabular-nums;direction:ltr}
  table.lines tbody tr.tot td{background:${accent};color:#fff;font-weight:800;border:none;padding:10px 10px}
  table.lines tbody tr.tot td.tl{text-align:center}
  .stmts{display:flex;gap:16px;margin-top:18px;break-inside:avoid}
  .stmt{flex:1;border:1px solid #d7dce3;border-right:3px solid ${accent};border-radius:4px;padding:8px 12px;font-size:11.5px;line-height:1.7}
  .stmt .stt{font-weight:800;color:${accent};margin-bottom:2px}
  .notes{margin-top:22px;break-inside:avoid}
  .wn{display:flex;align-items:flex-end;gap:12px;margin-top:18px} .wl{font-weight:800;white-space:nowrap} .wline{flex:1;border-bottom:1.5px dotted #64748b;height:18px}
  .sigs{display:flex;justify-content:space-around;margin-top:34px;break-inside:avoid}
  .sig{width:30%;text-align:center} .sig .sl{font-weight:800;margin-bottom:34px} .sig .line{border-bottom:1.5px solid ${accent}}
  .foot{margin-top:22px;color:#94a3b8;font-size:9.5px;text-align:center}
</style></head><body>
  ${pages.map(pageHTML).join('')}
  <script>window.onafterprint=function(){setTimeout(function(){window.close();},100);};window.onload=function(){setTimeout(function(){window.print();},300);};</script>
</body></html>`;
}

// LayoutConfig.kind === 'document' -> a header/lines/totals document (PO, invoice…).
// `head` is the single primary row; `lines` is the fetched detail dataset.
function documentHTML(meta, head, lines, layout) {
  const title = layout.title || meta.ReportName || 'Document';
  const orient = layout.orientation === 'landscape' ? 'landscape' : 'portrait';
  const size = layout.pageSize || 'A4';
  const ccy = head[layout.currencyField || 'OrderCurrency'] || '';
  const num = head[layout.numberField] ?? '';

  const hdrFields = (layout.header || [])
    .filter(f => head[f.field] != null && String(head[f.field]).trim() !== '')
    .map(f => {
      const sub = f.sub && head[f.sub] != null && String(head[f.sub]).trim() !== ''
        ? `<div class="hsub">${esc((f.subPrefix || '') + PO_FMT(head[f.sub], f.subFormat))}</div>` : '';
      return `<div class="hf"><div class="hl">${esc(f.label)}</div><div class="hv">${esc(PO_FMT(head[f.field], f.format))}</div>${sub}</div>`;
    })
    .join('');

  const lc = (layout.lines && layout.lines.columns) || [];
  const lth = lc.map(c => `<th style="text-align:${c.align || 'left'}${c.width ? ';width:' + c.width : ''}">${esc(c.label || c.field)}</th>`).join('');
  const ltr = lines.map(r => '<tr>' + lc.map(c => {
    const raw = c.divisorField
      ? (Number(r[c.divisorField]) > 0 ? Number(r[c.field] || 0) / Number(r[c.divisorField]) : null)
      : r[c.field];
    const em = (c.emphasize === 'pos' && Number(raw) > 0) || (c.emphasize === 'neg' && Number(raw) < 0)
      ? ';color:#dc2626;font-weight:700' : '';
    return `<td style="text-align:${c.align || (String(c.format || '').startsWith('number') ? 'right' : 'left')}${em}">${esc(PO_FMT(raw, c.format))}</td>`;
  }).join('') + '</tr>').join('');

  const sumLine = f => lines.reduce((s, r) => s + (Number(r[f]) || 0), 0);
  const totals = (layout.totals || [])
    .map(t => {
      const raw = t.lineField ? sumLine(t.lineField) : Number(head[t.field] || 0);
      if (t.hideZero && raw === 0) return '';
      const v = t.negate ? -raw : raw;
      const cst = t.color ? ` style="color:${esc(t.color)}"` : '';
      return `<tr${t.bold ? ' class="grand"' : ''}><td>${esc(t.label)}</td><td class="n"${cst}>${esc(PO_FMT(v, t.format || 'number:2'))} ${esc(ccy)}</td></tr>`;
    })
    .join('');

  const note = layout.noteField && head[layout.noteField]
    ? `<div class="note"><div class="nl">Note</div>${esc(head[layout.noteField])}</div>` : '';

  // Terms & conditions. Sources, first non-empty wins:
  //   termsField  -> a data column (raw HTML when termsMode==='html', else escaped)
  //   termsHtml   -> static rich markup in the layout
  //   terms       -> static plain text (newlines kept)
  const stripScript = h => String(h).replace(/<\s*script[\s\S]*?<\s*\/\s*script\s*>/gi, '');
  const fieldVal = layout.termsField ? head[layout.termsField] : null;
  const termsBody =
    (fieldVal != null && String(fieldVal).trim() !== ''
      ? (layout.termsMode === 'html' ? stripScript(fieldVal) : esc(fieldVal))
      : '')
    || (layout.termsHtml ? stripScript(layout.termsHtml) : '')
    || (layout.terms ? esc(layout.terms) : '');
  const terms = termsBody
    ? `<div class="sec">${esc(layout.termsLabel || 'Terms & Conditions')}</div><div class="terms">${termsBody}</div>` : '';

  // state -> chip colour
  const st = String((layout.stateField && head[layout.stateField]) || '').toLowerCase();
  const stTone = /clos|cancel|reject/.test(st) ? 'red'
    : /releas|approv|complet/.test(st) ? 'green'
    : /await|partial|pend|un-?rel|hold/.test(st) ? 'amber' : 'blue';
  const stateChip = layout.stateField && head[layout.stateField]
    ? `<span class="chip ${stTone}">${esc(head[layout.stateField])}</span>` : '';
  const typeChip = layout.typeField && head[layout.typeField]
    ? `<span class="chip line">${esc(head[layout.typeField])}</span>` : '';

  const accent = layout.accent || '#0e639c';
  const accentSoft = layout.accentSoft || 'rgba(14,99,156,.10)';
  const logo = layout.hideLogo
    ? ''
    : layout.logo
      ? `<img src="${esc(layout.logo)}" alt="logo" style="max-height:46px;max-width:180px;display:block">`
      : GLC_LOGO;

  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)} ${esc(num)}</title>
<style>
  @page { size: ${size} ${orient}; margin: 12mm; }
  html{-webkit-print-color-adjust:exact;print-color-adjust:exact}
  *{box-sizing:border-box}
  body{font:12px -apple-system,Segoe UI,Roboto,sans-serif;color:#1c2530;margin:0;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  .band{background:${accent};color:#fff;padding:14px 20px;border-radius:8px;display:flex;justify-content:space-between;align-items:flex-start;gap:16px}
  .band .logo{background:#fff;border-radius:6px;padding:6px 10px;display:inline-block;flex:0 0 auto}
  .band h1{font-size:20px;margin:8px 0 0;letter-spacing:.3px}
  .band .sub{font-size:11px;opacity:.9;margin-top:3px}
  .idbox{text-align:right}
  .idbox .lbl{font-size:9px;font-weight:800;text-transform:uppercase;letter-spacing:1.4px;opacity:.85}
  .idbox .no{font-size:24px;font-weight:800;font-family:ui-monospace,Menlo,monospace;letter-spacing:.5px;line-height:1.1;margin-top:1px}
  .idbox .chips{margin-top:6px}
  .idbox .dt{font-size:11px;opacity:.9;margin-top:5px}
  .chip{display:inline-block;font-size:10px;font-weight:800;border-radius:999px;padding:3px 9px;margin-left:6px;text-transform:uppercase;letter-spacing:.4px}
  .chip.line{background:rgba(255,255,255,.18);color:#fff;border:1px solid rgba(255,255,255,.5)}
  .chip.green{background:#dcfce7;color:#166534} .chip.red{background:#fee2e2;color:#991b1b}
  .chip.amber{background:#fef3c7;color:#92400e} .chip.blue{background:#dbeafe;color:#1e40af}
  .sec{font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.6px;color:${accent};margin:18px 0 8px}
  .hgrid{display:grid;grid-template-columns:repeat(${Number(layout.headerCols) || 2},1fr);gap:7px 16px;padding:11px 14px;background:${accentSoft};border:1px solid ${accentSoft};border-left:3px solid ${accent};border-radius:6px}
  .hf .hl{font-size:9px;font-weight:800;text-transform:uppercase;color:#64748b}
  .hf .hv{font-size:12px;font-weight:600;color:#1c2530}
  .hf .hsub{font-size:10.5px;color:#64748b;margin-top:1px}
  .note{margin:12px 0 4px;padding:9px 12px;background:#fffbeb;border:1px solid #fde68a;border-left:3px solid #f59e0b;border-radius:6px;white-space:pre-wrap}
  .note .nl{font-size:9px;font-weight:800;text-transform:uppercase;color:#92400e;margin-bottom:2px}
  table.lines{width:100%;border-collapse:collapse;margin-top:2px;font-size:${layout.linesFont || '11.5px'};table-layout:fixed}
  table.lines th{background:${accent};color:#fff;padding:6px 6px;font-size:9px;text-transform:uppercase;letter-spacing:.3px;font-weight:800}
  table.lines td{padding:5px 6px;border-bottom:1px solid #e5e9ef;overflow-wrap:anywhere}
  table.lines tbody tr:nth-child(even) td{background:${accentSoft}}
  .totwrap{display:flex;justify-content:flex-end;margin-top:14px}
  table.tot{border-collapse:collapse;min-width:300px}
  table.tot td{padding:5px 10px} table.tot td.n{text-align:right;font-variant-numeric:tabular-nums}
  table.tot tr td:first-child{color:#64748b;font-weight:700;font-size:11px;text-transform:uppercase;letter-spacing:.3px}
  table.tot tr.grand td{background:${accent};color:#fff;font-weight:800;font-size:14px}
  table.tot tr.grand td:first-child{color:#fff}
  .terms{margin-top:2px;font-size:10.5px;color:#334155;line-height:1.5;white-space:pre-wrap;border:1px solid #e5e9ef;border-radius:6px;padding:10px 12px;background:#fafbfc}
  .foot{margin-top:24px;color:#94a3b8;font-size:9.5px;border-top:1px solid #e5e9ef;padding-top:6px}
</style></head><body>
  <div class="band">
    <div>
      ${logo ? `<span class="logo">${logo}</span>` : ''}
      <h1>${esc(title)}</h1>
      <div class="sub">${esc(head[layout.subField || 'VendorName'] || '')}${(() => { const x = head[layout.subExtraField || 'VendorExtraName']; return x && x !== head[layout.subField || 'VendorName'] ? ' — ' + esc(x) : ''; })()}</div>
    </div>
    <div class="idbox">
      <div class="lbl">${esc(layout.numberLabel || title)}</div>
      <div class="no">${esc(num)}</div>
      ${(typeChip || stateChip) ? `<div class="chips">${typeChip}${stateChip}</div>` : ''}
      ${layout.dateField && head[layout.dateField] != null ? `<div class="dt">${esc((layout.dateLabel ? layout.dateLabel + ' ' : '') + PO_FMT(head[layout.dateField], layout.dateFormat || 'date'))}</div>` : ''}
    </div>
  </div>
  <div class="sec">Order details</div>
  <div class="hgrid">${hdrFields}</div>
  ${note}
  <div class="sec">Lines</div>
  <table class="lines"><thead><tr>${lth}</tr></thead><tbody>${ltr || '<tr><td colspan="' + lc.length + '" style="color:#94a3b8">No lines</td></tr>'}</tbody></table>
  <div class="totwrap"><table class="tot">${totals}</table></div>
  ${terms}
  <div class="foot">${esc(meta.ReportName || '')} &middot; ${esc(meta.ReportCode || '')} &middot; printed ${new Date().toLocaleString()}</div>
  <script>window.onafterprint=function(){setTimeout(function(){window.close();},100);};window.onload=function(){setTimeout(function(){window.print();},300);};</script>
</body></html>`;
}

// Runs one report (GetReportData + the layout's own permissioned View
// fetches) and renders its printable HTML. Shared by the Print menu and by
// screens that preview many records at once (an Order Board's stacked
// Preview -- see the order-board skill). `opts.pageSize` / `opts.orientation`
// override the layout's. Throws Error(message) with `.server = true` when the
// server refuses the report or the record has nothing to print.
export async function buildReportHTML(rep, pageGroupId, context = {}, opts = {}) {
  const { pageSize, orientation } = opts || {};
  const fail = (message) => Object.assign(new Error(message), { server: true });
  const params = buildParams(rep.ParamConfig, context);
  const res = await apiCall('GetReportData', {
    ReportID: rep.ReportID, PageGroupID: pageGroupId, Params: params,
  }, {}, 'plus');
  if (res.State !== 0) throw fail(res.Message || 'Report failed');
  const meta = (res.List1 || [])[0] || rep;
  let layout = null;
  try { layout = meta.LayoutConfig ? JSON.parse(meta.LayoutConfig) : null; } catch { layout = null; }
  if (pageSize || orientation) layout = { ...layout, ...(pageSize ? { pageSize } : {}), ...(orientation ? { orientation } : {}) };
  const rows = res.List0 || [];

  let html;
  if (layout && layout.kind === 'panels') {
    let sections = [];
    if (Array.isArray(layout.sections) && layout.sections.length) {
      const keyVal = (layout.keyField && context[layout.keyField] != null)
        ? context[layout.keyField]
        : (Object.values(params)[0] ?? (layout.keyField && rows[0] ? rows[0][layout.keyField] : undefined));
      sections = await Promise.all(layout.sections.map(async s => {
        if (!s.queryId || keyVal == null) return { ...s, data: [] };
        try {
          const r = await apiCall('View', {
            PageGroupID: pageGroupId, QueryID: s.queryId,
            KeyField: s.keyField, KeyValue: String(keyVal),
          }, {}, 'plus');
          let list = r.List0 || [];
          if (s.limit) list = list.slice(0, s.limit);
          return { ...s, data: list };
        } catch { return { ...s, data: [] }; }
      }));
    }
    // extra pages: only those whose showWhen matches the record, e.g.
    // { field: 'CustomerSalesPerson', startsWith: '4' } or { field, in: [..] }
    const head0 = rows[0] || {};
    const showPage = (w) => {
      if (!w || !w.field) return true;
      const v = head0[w.field];
      if (v == null || v === '') return false;
      if (w.startsWith != null && !String(v).startsWith(String(w.startsWith))) return false;
      if (Array.isArray(w.in) && !w.in.some(x => String(x) === String(v))) return false;
      return true;
    };
    const extraKey = layout.keyField ? (head0[layout.keyField] ?? context[layout.keyField]) : undefined;
    const extraPages = Array.isArray(layout.extraPages)
      ? await Promise.all(layout.extraPages.filter(pg => showPage(pg.showWhen)).map(async pg => ({
        ...pg,
        sections: await Promise.all((pg.sections || []).map(async s => {
          if (!s.queryId || extraKey == null) return { ...s, data: [] };
          try {
            const r = await apiCall('View', { PageGroupID: pageGroupId, QueryID: s.queryId, KeyField: s.keyField, KeyValue: String(extraKey) }, {}, 'plus');
            return { ...s, data: r.List0 || [] };
          } catch { return { ...s, data: [] }; }
        })),
      })))
      : [];
    html = panelsHTML(meta, head0, sections, layout, extraPages);
  } else if (layout && layout.kind === 'dashboard') {
    if (!rows.length) throw fail('No data found for this record.');
    html = dashboardHTML(meta, rows[0], layout);
  } else if (layout && layout.kind === 'statement') {
    html = statementHTML(meta, rows, layout, context);
  } else if (layout && layout.kind === 'salesInvoice') {
    const head = rows[0];
    if (!head) throw fail('Invoice not found.');
    const keyVal = head[layout.keyField || 'InternalID'] ?? Object.values(params)[0];
    let lines = [];
    if (layout.lines && layout.lines.queryId && keyVal != null) {
      const lr = await apiCall('View', {
        PageGroupID: pageGroupId, QueryID: layout.lines.queryId,
        KeyField: layout.lines.keyField, KeyValue: String(keyVal),
      }, {}, 'plus');
      lines = lr.List0 || [];
    }
    html = salesInvoiceHTML(meta, head, lines, layout);
  } else if (layout && layout.kind === 'accountStatement') {
    if (!context.accountStatement) throw fail('Generate the statement first.');
    html = accountStatementHTML(meta, layout, context.accountStatement);
  } else if (layout && layout.kind === 'journal') {
    if (!rows.length) throw fail('No journal lines found for this document.');
    html = journalHTML(meta, rows, layout);
  } else if (layout && (layout.kind === 'document' || layout.kind === 'invoice' || layout.kind === 'permit' || layout.kind === 'note')) {
    // a permit may print another number (LoadNumber) than the lines' key
    const keyVal = (layout.kind === 'permit' && layout.lines ? (rows[0] || context)[layout.lines.keyField] : undefined)
      ?? context[layout.numberField] ?? context.PurchaseOrderNumber ?? Object.values(params)[0];
    let lines = [];
    if (layout.lines && layout.lines.queryId && keyVal != null) {
      const lr = await apiCall('View', {
        PageGroupID: pageGroupId, QueryID: layout.lines.queryId,
        KeyField: layout.lines.keyField, KeyValue: keyVal,
      }, {}, 'plus');
      lines = lr.List0 || [];
    }
    // invoice layout: optional extra pages, each fetched with the same key as the lines
    const extras = layout.kind === 'invoice' && Array.isArray(layout.extraPages) && keyVal != null
      ? await Promise.all(layout.extraPages.map(async page => {
          if (!page.queryId) return { page, rows: [] };
          try {
            const xr = await apiCall('View', { PageGroupID: pageGroupId, QueryID: page.queryId, KeyField: page.keyField, KeyValue: keyVal }, {}, 'plus');
            return { page, rows: xr.List0 || [] };
          } catch { return { page, rows: [] }; }
        }))
      : [];
    html = layout.kind === 'invoice' ? invoiceHTML(meta, rows[0] || {}, lines, layout, extras)
      : layout.kind === 'note' ? noteHTML(meta, rows[0] || {}, lines, layout)
      : layout.kind === 'permit' ? permitHTML(meta, rows[0] || {}, lines, layout)
      : documentHTML(meta, rows[0] || {}, lines, layout);
  } else {
    html = reportHTML(meta, rows, layout);
  }

  return { html, layout, meta, params };
}

// The in-app version of a report page: no auto-print / auto-close, framed on
// a dark background at paper size. `bg` / `pad` tune the frame (a stacked
// previewer uses a lighter, tighter one).
export function previewHTML(html, layout, { bg = '#292929', pad = 24 } = {}) {
  return html
    .replace(/window\.onafterprint=function\(\)\{setTimeout\(function\(\)\{window\.close\(\);\},100\);\};/g, '')
    .replace(/setTimeout\(function\(\)\{window\.print\(\);\},\d+\);/g, '')
    .replace('</head>', `<style>@media screen { html { background:${bg}; padding:${pad}px; } body { background:white; padding:32px; width:${layout?.pageSize === 'A4' ? (layout.orientation === 'landscape' ? '297mm' : '210mm') : 'auto'}; max-width:${layout?.pageSize === 'A4' ? 'none' : '1100px'}; min-height:${layout?.pageSize === 'A4' ? (layout.orientation === 'landscape' ? '210mm' : '297mm') : '90vh'}; margin:0 auto; box-shadow:0 2px 18px #0005; } }</style></head>`);
}

export default function ReportMenu({ pageGroupId, target = 'Form', context = {}, label = 'Print', pageSize, orientation, hidden = false, runRequest, onError, onBusy, compact = false, reports: givenReports = null }) {
  const [fetchedReports, setReports] = useState([]);
  const reports = givenReports || fetchedReports;
  const [preview, setPreview] = useState(null);
  const [previewReady, setPreviewReady] = useState(false);
  const previewFrame = useRef(null);
  const [open, setOpen] = useState(false);
  const [running, setRunning] = useState(null);
  const [err, setErr] = useState(null);
  const ref = useRef(null);

  useEffect(() => {
    if (givenReports) { setReportsLoaded(true); return undefined; }   // the caller fetched them (e.g. once per Order Board)
    let alive = true;
    apiCall('GetPageReports', { PageGroupID: pageGroupId, Target: target }, {}, 'plus')
      .then(r => { if (alive && r.State === 0) setReports(r.List0 || []); })
      .catch(() => {})
      .finally(() => { if (alive) setReportsLoaded(true); });
    return () => { alive = false; };
  }, [pageGroupId, target, givenReports]);

  useEffect(() => {
    if (!open) return;
    const h = e => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);

  // hidden mode: run the requested report as soon as the page's reports are known
  const lastRun = useRef(null);
  const [reportsLoaded, setReportsLoaded] = useState(false);
  useEffect(() => {
    if (!runRequest || runRequest.nonce == null || runRequest.nonce === lastRun.current || !reportsLoaded) return;
    lastRun.current = runRequest.nonce;
    const rep = reports.find(r => r.ReportCode === runRequest.code && isVisible(r, context));
    if (!rep) { onError?.('That report is not available to you on this page.'); return; }
    run(rep);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runRequest, reportsLoaded, reports]);
  useEffect(() => { if (hidden && err) onError?.(err); }, [err]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (hidden) onBusy?.(running != null); }, [running]);   // eslint-disable-line react-hooks/exhaustive-deps

  async function run(rep) {
    setRunning(rep.ReportID); setErr(null); setOpen(false);
    try {
      const { html, layout, meta } = await buildReportHTML(rep, pageGroupId, context, { pageSize, orientation });
      setPreviewReady(false);
      setPreview({ html: previewHTML(html, layout), orientation: layout?.orientation, title: `${rep.DisplayName || meta.ReportName || 'Report'}${context.OrderNumber ? ` — Order ${context.OrderNumber}` : ''}` });
    } catch (e) { setErr(e.server ? e.message : 'Connection error: ' + e.message); }
    setRunning(null);
  }

  const shown = reports.filter(r => isVisible(r, context));
  if (shown.length === 0 && !hidden) return null;

  return (
    <div ref={ref} style={{ position: 'relative', display: hidden ? 'none' : 'inline-block' }}>
      {!hidden && compact && (
        // icon-only (a row's print cell): one report prints straight away
        <button type="button" onClick={(e) => { e.stopPropagation(); if (shown.length === 1) run(shown[0]); else setOpen(o => !o); }}
          disabled={running != null} title={running != null ? 'Preparing…' : (shown.length === 1 ? `Print ${shown[0].DisplayName}` : label)}
          aria-label={label} style={{
            width: 30, height: 28, borderRadius: 7, border: '1px solid var(--border)', background: 'var(--surface)',
            color: 'var(--text)', cursor: running != null ? 'wait' : 'pointer', display: 'inline-flex', alignItems: 'center',
            justifyContent: 'center', padding: 0, fontSize: 14, opacity: running != null ? 0.6 : 1,
          }}>{running != null ? '…' : '🖨️'}</button>
      )}
      {!hidden && !compact && <button onClick={() => setOpen(o => !o)} disabled={running != null} style={{
        height: 32, padding: '0 12px', borderRadius: 8, border: '1px solid var(--border)',
        background: 'var(--bg)', color: 'var(--text)', fontSize: 12, fontWeight: 700, cursor: 'pointer',
        display: 'inline-flex', alignItems: 'center', gap: 6,
      }}>
        🖨️ {running != null ? 'Preparing…' : label} <span style={{ fontSize: 9 }}>▼</span>
      </button>}
      {preview && createPortal(
        <div style={{ position: 'fixed', inset: 0, zIndex: 10050, padding: 16, background: 'rgba(0,0,0,.6)', display: 'flex' }}>
          <section role="dialog" aria-modal="true" aria-label={preview.title} style={{ width: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden', borderRadius: 14, background: 'var(--surface)', boxShadow: 'var(--shadow-lg)' }}>
            <header style={{ padding: '14px 20px', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12, borderBottom: '1px solid var(--border)' }}>
              <h2 style={{ flex: 1, margin: 0, fontSize: 15, color: 'var(--text)' }}>{preview.title}</h2>
              <button disabled={!previewReady} onClick={() => { previewFrame.current?.contentWindow?.focus(); previewFrame.current?.contentWindow?.print(); }} style={{ padding: '10px 18px', border: 0, borderRadius: 8, background: 'var(--orange)', color: '#fff', fontWeight: 700, cursor: 'pointer' }}>Print / Save PDF</button>
              <button autoFocus aria-label="Close report preview" onClick={() => setPreview(null)} style={{ width: 36, height: 36, border: 0, borderRadius: '50%', background: 'var(--soft)', color: 'var(--text)', fontSize: 22, cursor: 'pointer' }}>×</button>
            </header>
            <iframe ref={previewFrame} title={preview.title} srcDoc={preview.html} onLoad={() => setPreviewReady(true)} style={{ width: '100%', flex: 1, minHeight: 0, border: 0, background: '#292929' }} />
          </section>
        </div>, document.body
      )}
      {err && <div style={{ position: 'absolute', top: '110%', right: 0, background: 'var(--red-soft)', color: 'var(--red)', border: '1px solid var(--border)', borderRadius: 6, padding: '6px 10px', fontSize: 11, whiteSpace: 'nowrap', zIndex: 20 }}>{err}</div>}
      {open && (
        <div style={{
          position: 'absolute', top: '110%', right: 0, minWidth: 220, background: 'var(--bg)',
          border: '1px solid var(--border)', borderRadius: 8, boxShadow: '0 10px 30px rgba(0,0,0,.18)', zIndex: 20, padding: 4,
        }}>
          {shown.map(rep => (
            <button key={rep.LinkID} onClick={() => run(rep)} style={{
              display: 'block', width: '100%', textAlign: 'left', padding: '8px 10px', border: 'none',
              background: 'none', color: 'var(--text)', fontSize: 12.5, cursor: 'pointer', borderRadius: 6,
            }}
              onMouseEnter={e => e.currentTarget.style.background = 'var(--soft)'}
              onMouseLeave={e => e.currentTarget.style.background = 'none'}>
              {rep.DisplayName}
              {rep.ReportType === 'Fast' && <span style={{ fontSize: 9, color: 'var(--muted)', marginLeft: 6 }}>Fast</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
