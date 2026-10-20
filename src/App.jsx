import React, { useState, useCallback, useEffect, useRef } from 'react';
import { apiCall, clearApiCache } from './shared/api.js';
import { clearLookupCache } from './shared/LookupSelect.jsx';
import GenericMasterPage from './shared/GenericMasterPage.jsx';
import GridPage from './pages/core/GridPage.jsx';
import UserMaster from './pages/core/UserMaster.jsx';
import GroupPageMaster from './pages/core/GroupPageMaster.jsx';
import UserPagePermissions from './pages/core/UserPagePermissions.jsx';
import QueryMaster from './pages/core/QueryMaster.jsx';
import QueryFilterMaster from './pages/core/QueryFilterMaster.jsx';
import OperationMaster from './pages/core/OperationMaster.jsx';
import ReportMaster from './pages/core/ReportMaster.jsx';
import GroupByMaster from './pages/core/GroupByMaster.jsx';
import NotificationBell from './shared/NotificationBell.jsx';
import NotificationSettings from './pages/core/NotificationSettings.jsx';
import {
  Calculator, Layers, Coins, Settings, Package2, FolderTree, Search,
  ChevronDown, PanelLeftClose, PanelLeftOpen, Moon, Sun, LogOut, RefreshCw,
  Menu, X, Palette, Check, Eye, EyeOff, Droplets,
} from 'lucide-react';
import * as LucideIcons from 'lucide-react';

// Error Boundary to catch render crashes and display error info instead of a blank page
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null, errorInfo: null };
  }
  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }
  componentDidCatch(error, errorInfo) {
    this.setState({ errorInfo });
    console.error('ErrorBoundary caught:', error, errorInfo);
  }
  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: 32, color: '#dc2626', background: '#fef2f2', borderRadius: 12, margin: 16, fontFamily: 'monospace' }}>
          <h3 style={{ margin: '0 0 12px' }}>⚠️ Something went wrong</h3>
          <pre style={{ whiteSpace: 'pre-wrap', fontSize: 13 }}>{this.state.error?.toString()}</pre>
          <pre style={{ whiteSpace: 'pre-wrap', fontSize: 11, color: '#888', marginTop: 8 }}>{this.state.errorInfo?.componentStack}</pre>
          <button onClick={() => this.setState({ hasError: false, error: null, errorInfo: null })}
            style={{ marginTop: 16, padding: '8px 20px', background: 'var(--orange2)', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer' }}>
            Try Again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

// ─── Sidebar icon set ────────────────────────────────────────────────────────
// Groups resolve an icon by PageGroupID; anything not in this map falls back to
// a monogram chip built from the label, so nothing ever renders blank/broken.
const ICON_MAP = {
  accounting_group: Calculator,
  bom_group: Layers,
  costing_group: Coins,
  system_admin_group: Settings,
  inventory_group: Package2,
  accounts_master: FolderTree,
};

// Resolves a page's own V1PagesAndGroups.Icon value (set in Group & Page
// Master) into something renderable: an emoji/pictographic string renders
// as-is; an ASCII name ("AlertTriangle", "user-check", ...) is looked up
// against lucide-react's full icon set. Returns a component so callers can
// keep doing <Icon size={..}/> either way. Null when there's nothing usable
// -- the ICON_MAP / monogram fallbacks take over from there.
function resolveIcon(raw) {
  const trimmed = (raw || '').trim();
  if (!trimmed) return null;
  if (/[^\x00-\x7F]/.test(trimmed)) {
    return function EmojiIcon({ size = 14 }) {
      return <span style={{ fontSize: size, lineHeight: 1 }}>{trimmed}</span>;
    };
  }
  const pascal = trimmed.replace(/[-_\s]+(.)?/g, (_, c) => (c ? c.toUpperCase() : ''))
                         .replace(/^./, c => c.toUpperCase());
  return LucideIcons[pascal] || null;
}

function NavIcon({ pageId, icon, label, size = 14 }) {
  const Icon = resolveIcon(icon) || ICON_MAP[pageId];
  if (Icon) return <Icon size={size} strokeWidth={2} />;
  const mono = (label || '?').trim().slice(0, 2).toUpperCase();
  return <span style={{ fontSize: size * 0.6, fontWeight: 800, lineHeight: 1 }}>{mono}</span>;
}

// ─── Styles ──────────────────────────────────────────────────────────────────
const css = `
  :root {
    --bg: #f1f5f9;
    --surface: #ffffff;
    --soft: #f8fafc;
    --sb-bg: #0F172A;
    --sb-surface: #162033;
    --sb-card: #1E293B;
    --sb-border: #334155;
    --sb-text: #F8FAFC;
    --sb-text-muted: #94A3B8;
    --sb-orange: #ff650f;
    --sb-orange-hover: #ff7a28;
    --sb-orange-soft: rgba(255, 101, 15, 0.14);
    --sb-hover-bg: rgba(148, 163, 184, 0.10);
    --text: #0f172a;
    --muted: #64748b;
    --hint: #94a3b8;
    --border: #e2e8f0;
    --border2: #cbd5e1;
    --orange: #f97316;
    --orange2: #ea580c;
    --orange-dark: #c2410c;
    --orange-glow: rgba(249,115,22,.18);
    --orange-soft: #fff7ed;
    --green: #16a34a;
    --green-soft: #f0fdf4;
    --red: #dc2626;
    --red-soft: #fef2f2;
    --amber: #d97706;
    --amber-soft: #fffbeb;
    --blue: #2563eb;
    --blue-soft: #eff6ff;
    --radius: 14px;
    --radius-sm: 10px;
    --radius-xs: 7px;
    --font: 'Plus Jakarta Sans', sans-serif;
    --mono: 'JetBrains Mono', monospace;
    --shadow: 0 1px 3px rgba(0,0,0,.06), 0 4px 12px rgba(0,0,0,.05);
    --shadow-lg: 0 8px 28px rgba(0,0,0,.1);
    /* Aliases for shared/DataGrid.jsx's own token names -- it no longer
       injects its own :root block (see that file), so it inherits these
       instead of resetting the whole app's colors the moment a grid mounts. */
    --primary: var(--orange);
    --primary-dark: var(--orange2);
    --primary-soft: var(--orange-soft);
    /* Sidebar "selected" state -- a soft tint by default (every theme except
       Warm Ivory keeps this exact look); Warm Ivory overrides to a solid fill. */
    --sb-active-bg: color-mix(in srgb, var(--group-accent, var(--sb-orange)) 14%, transparent);
    --sb-active-icon-bg: color-mix(in srgb, var(--group-accent, var(--sb-orange)) 28%, transparent);
    --sb-active-text: var(--group-accent, var(--sb-orange));
  }
  .dark {
    --bg: #0d1117;
    --surface: #161b22;
    --soft: #1c2333;
    --text: #e6edf3;
    --muted: #8b949e;
    --hint: #484f58;
    --border: #30363d;
    --border2: #21262d;
    --orange: #fb923c;
    --orange2: #f97316;
    --orange-dark: #ea580c;
    --orange-soft: rgba(251,146,60,.1);
    --green-soft: rgba(22,163,74,.12);
    --red-soft: rgba(220,38,38,.12);
    --amber-soft: rgba(217,119,6,.12);
    --blue-soft: rgba(37,99,235,.12);
  }
  /* ── Warm Ivory ── a warm, low-contrast theme for long ERP sessions --
     avoids pure white / harsh contrast. Sidebar is light here (unlike the
     other two themes, which keep it dark navy), so its tokens are overridden
     too, including a solid-fill "selected" state per its own spec. */
  .warm-ivory {
    --bg: #F7F3EB;
    --surface: #FFFDFC;
    --soft: #F5EFE5;
    --text: #1F2937;
    --muted: #6B7280;
    --hint: #8A8175;
    --border: #E7DED0;
    --border2: #DACCB4;
    --orange: #FF5A0A;
    --orange2: #E94E00;
    --orange-dark: #C24900;
    --orange-glow: rgba(255,90,10,.18);
    --orange-soft: rgba(255,90,10,.10);
    --green-soft: rgba(22,163,74,.12);
    --red-soft: rgba(220,38,38,.12);
    --amber-soft: rgba(217,119,6,.12);
    --blue-soft: rgba(37,99,235,.12);
    --sb-bg: #F3EBDD;
    --sb-surface: #EFE4D2;
    --sb-card: #FFFDFC;
    --sb-border: #E7DED0;
    --sb-text: #1F2937;
    --sb-text-muted: #8A8175;
    --sb-orange: #FF5A0A;
    --sb-orange-hover: #E94E00;
    --sb-orange-soft: rgba(255,90,10,.14);
    --sb-hover-bg: rgba(31,41,55,.06);
    --sb-active-bg: #FF5A0A;
    --sb-active-icon-bg: rgba(255,255,255,.24);
    --sb-active-text: #ffffff;
  }
  /* ── Ocean Blue ── a cool, calm theme: soft blue-grey canvas, deep navy
     sidebar with a solid blue "selected" state, and a confident blue as the
     accent. The accent tokens keep their historical --orange* names (every
     component reads them), and --blue -- the "info" badge colour -- moves to
     teal so it stays distinct from the accent. */
  .ocean-blue {
    --bg: #F2F6FB;
    --surface: #FFFFFF;
    --soft: #EEF3FA;
    --text: #0F1E36;
    --muted: #5B6B82;
    --hint: #8A9AB0;
    --border: #DCE5F0;
    --border2: #C5D3E4;
    --orange: #1E63D6;
    --orange2: #174FB0;
    --orange-dark: #123F8C;
    --orange-glow: rgba(30,99,214,.18);
    --orange-soft: rgba(30,99,214,.09);
    --blue: #0E8FA3;
    --blue-soft: rgba(14,143,163,.10);
    --green-soft: rgba(22,163,74,.10);
    --red-soft: rgba(220,38,38,.09);
    --amber-soft: rgba(217,119,6,.10);
    --shadow: 0 1px 3px rgba(15,30,54,.06), 0 4px 12px rgba(15,30,54,.05);
    --shadow-lg: 0 8px 28px rgba(15,30,54,.12);
    --sb-bg: #0B1F3F;
    --sb-surface: #102A52;
    --sb-card: #16335F;
    --sb-border: #1E3F70;
    --sb-text: #EAF1FB;
    --sb-text-muted: #9DB2CF;
    --sb-orange: #4C8DF6;
    --sb-orange-hover: #6BA1F8;
    --sb-orange-soft: rgba(76,141,246,.16);
    --sb-hover-bg: rgba(157,178,207,.10);
    --sb-active-bg: #1E63D6;
    --sb-active-icon-bg: rgba(255,255,255,.20);
    --sb-active-text: #FFFFFF;
  }
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: var(--font); background: var(--bg); color: var(--text); font-size: 14px; line-height: 1.5; }

  /* ── LOGIN ── */
  .login-page { min-height: 100vh; display: flex; align-items: center; justify-content: center; background: var(--bg); padding: 24px; }
  .login-card { width: 100%; max-width: 400px; background: var(--surface); border: 1px solid var(--border); border-radius: 24px; padding: 36px; box-shadow: var(--shadow-lg); }
  .login-logo { width: 52px; height: 52px; border-radius: 16px; background: linear-gradient(135deg, var(--orange), var(--orange2)); color: #fff; font-size: 20px; font-weight: 800; display: flex; align-items: center; justify-content: center; margin-bottom: 20px; }
  .login-title { font-size: 22px; font-weight: 800; margin-bottom: 4px; }
  .login-sub { color: var(--muted); font-size: 13px; margin-bottom: 28px; }
  .login-api { text-align: center; margin-top: 16px; font-size: 11px; color: var(--hint); font-family: var(--mono); }
  .field { margin-bottom: 16px; }
  .field label { display: block; font-size: 11px; font-weight: 700; color: var(--muted); margin-bottom: 7px; letter-spacing: .08em; text-transform: uppercase; }
  .field input { width: 100%; height: 46px; border: 1.5px solid var(--border); border-radius: var(--radius-sm); padding: 0 14px; background: var(--soft); color: var(--text); font-family: var(--font); font-size: 14px; outline: none; transition: border-color .2s; }
  .field input:focus { border-color: var(--orange); }
  .field-pw-wrap { position: relative; }
  .field-pw-wrap input { padding-right: 42px; }
  .field-pw-toggle { position: absolute; right: 4px; top: 50%; transform: translateY(-50%); width: 34px; height: 34px; border: none; border-radius: 8px; background: transparent; color: var(--hint); cursor: pointer; display: flex; align-items: center; justify-content: center; transition: background .15s ease, color .15s ease; }
  .field-pw-toggle:hover { background: var(--border); color: var(--muted); }
  .field-remember { display: flex; align-items: center; gap: 8px; margin: -6px 0 16px; cursor: pointer; user-select: none; }
  .field-remember input { width: 15px; height: 15px; accent-color: var(--orange); cursor: pointer; }
  .field-remember span { font-size: 12.5px; font-weight: 600; color: var(--muted); }
  .btn-login { width: 100%; height: 48px; border: none; border-radius: var(--radius-sm); background: linear-gradient(135deg, var(--orange), var(--orange2)); color: #fff; font-family: var(--font); font-size: 15px; font-weight: 700; cursor: pointer; margin-top: 8px; transition: opacity .2s, transform .15s; }
  .btn-login:hover { opacity: .92; }
  .btn-login:active { transform: scale(.98); }
  .btn-login:disabled { opacity: .6; cursor: not-allowed; }
  .err-box { background: var(--red-soft); color: var(--red); border: 1px solid rgba(220,38,38,.2); border-radius: var(--radius-xs); padding: 10px 14px; font-size: 13px; margin-bottom: 14px; }

  /* ── LAYOUT ── */
  .app { display: flex; min-height: 100vh; }
  .sidebar { width: 264px; min-width: 264px; background: var(--sb-bg); display: flex; flex-direction: column; position: fixed; inset: 0 auto 0 0; overflow: hidden; border-right: 1px solid var(--sb-border); z-index: 20; transition: width .18s ease; }
  .sb-head { padding: 16px 14px 12px; background: var(--sb-surface); border-bottom: 1px solid var(--sb-border); }
  .sb-brand { display: flex; align-items: center; gap: 12px; cursor: pointer; user-select: none; min-width: 0; }
  .sb-logo { position: relative; width: 40px; height: 40px; border-radius: 11px; background: linear-gradient(135deg, var(--sb-orange), var(--sb-orange-hover)); color: #fff; font-size: 15px; font-weight: 800; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
  .sb-status-dot { position: absolute; bottom: -2px; right: -2px; width: 9px; height: 9px; border-radius: 50%; background: #22c55e; box-shadow: 0 0 0 2px var(--sb-surface), 0 0 6px 2px rgba(34,197,94,.55); }
  .sb-name { font-size: 15px; font-weight: 800; color: var(--sb-text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .sb-ver { font-size: 10px; color: var(--sb-text-muted); font-family: var(--mono); white-space: nowrap; }
  .sb-collapse-btn { flex-shrink: 0; width: 24px; height: 24px; border-radius: 50%; background: var(--sb-card); border: 1px solid var(--sb-border); color: var(--sb-text-muted); cursor: pointer; display: flex; align-items: center; justify-content: center; transition: background .18s ease, color .18s ease, border-color .18s ease; }
  .sb-collapse-btn:hover { background: var(--sb-orange); color: #fff; border-color: var(--sb-orange); }
  .sb-collapse-btn:focus-visible { outline: 2px solid var(--sb-orange); outline-offset: 2px; }

  .sb-search { position: relative; display: flex; align-items: center; margin: 10px 12px 4px; }
  .sb-search-icon { position: absolute; left: 10px; color: var(--sb-text-muted); pointer-events: none; }
  .sb-search-input { width: 100%; height: 32px; padding: 0 40px 0 30px; border-radius: 9px; border: 1px solid var(--sb-border); background: var(--sb-card); color: var(--sb-text); font-family: var(--font); font-size: 12px; outline: none; transition: border-color .18s ease; }
  .sb-search-input::placeholder { color: var(--sb-text-muted); }
  .sb-search-input:focus { border-color: var(--sb-orange); }
  .sb-search-kbd { position: absolute; right: 8px; padding: 1px 6px; font-size: 9.5px; font-weight: 700; letter-spacing: .02em; color: var(--sb-text-muted); background: var(--sb-bg); border: 1px solid var(--sb-border); border-radius: 5px; pointer-events: none; }

  .sb-nav { flex: 1; overflow-y: auto; overflow-x: hidden; padding: 8px 10px 12px; display: flex; flex-direction: column; }
  .sb-item { display: flex; align-items: center; gap: 12px; height: 46px; padding: 0 14px; border-radius: 11px; cursor: pointer; color: var(--sb-text-muted); font-size: 13px; font-weight: 500; transition: background .18s ease, color .18s ease, border-color .18s ease; margin-bottom: 3px; border: none; border-left: 3px solid transparent; background: transparent; width: 100%; text-align: left; font-family: var(--font); }
  .sb-item:hover { background: var(--sb-hover-bg); color: var(--sb-text); }
  .sb-item:focus-visible, .sb-sub-item:focus-visible, .sb-group-title:focus-visible { outline: 2px solid var(--sb-orange); outline-offset: -2px; }
  .sb-item.active { background: var(--sb-active-bg); color: var(--sb-active-text); font-weight: 700; border-left: 3px solid var(--group-accent, var(--sb-orange)); }
  .sb-icon { width: 26px; height: 26px; border-radius: 7px; background: color-mix(in srgb, var(--group-accent, var(--sb-orange)) 16%, transparent); display: flex; align-items: center; justify-content: center; flex-shrink: 0; color: var(--group-accent, var(--sb-orange)); transition: background .18s ease, color .18s ease; }
  .sb-item.active .sb-icon { background: var(--sb-active-icon-bg); color: var(--sb-active-text); }

  .sb-group { position: relative; margin-bottom: 4px; padding-left: 8px; }
  .sb-group-bar { position: absolute; left: 0; top: 2px; bottom: 2px; width: 3px; border-radius: 3px; background: var(--group-accent, var(--sb-orange)); opacity: .5; }
  .sb-group-title { display: flex; align-items: center; justify-content: space-between; padding: 8px 10px; margin-bottom: 2px; color: var(--sb-text); font-size: 10.5px; font-weight: 700; text-transform: uppercase; letter-spacing: .09em; user-select: none; cursor: pointer; border: none; background: transparent; width: 100%; text-align: left; font-family: var(--font); border-radius: 8px; transition: background .18s ease; }
  .sb-group-title:hover { background: var(--sb-hover-bg); }
  .sb-group-chevron { color: var(--sb-text-muted); transition: transform .18s ease; flex-shrink: 0; }
  .sb-group-items-wrap { display: grid; grid-template-rows: 1fr; transition: grid-template-rows .18s ease; }
  .sb-group-items-wrap.collapsed { grid-template-rows: 0fr; }
  .sb-group-items-wrap > .sb-group-items { overflow: hidden; min-height: 0; }
  .sb-sub-item { display: flex; align-items: center; gap: 12px; height: 44px; padding: 0 14px 0 22px; border-radius: 11px; cursor: pointer; color: var(--sb-text-muted); font-size: 13px; font-weight: 500; transition: background .18s ease, color .18s ease, border-color .18s ease; margin-bottom: 3px; border: none; border-left: 3px solid transparent; background: transparent; width: 100%; text-align: left; font-family: var(--font); }
  .sb-sub-item:hover { background: var(--sb-hover-bg); color: var(--sb-text); }
  .sb-sub-item.active { background: var(--sb-active-bg); color: var(--sb-active-text); font-weight: 700; border-left: 3px solid var(--group-accent, var(--sb-orange)); }
  .sb-sub-item.active .sb-icon { background: var(--sb-active-icon-bg); color: var(--sb-active-text); }

  .sb-foot { padding: 14px 10px; background: var(--sb-surface); border-top: 1px solid var(--sb-border); }
  .sb-profile { display: flex; align-items: center; gap: 12px; padding: 8px 10px; margin-bottom: 10px; }
  .sb-avatar { width: 34px; height: 34px; border-radius: 50%; background: linear-gradient(135deg, var(--sb-orange), var(--sb-orange-hover)); color: #fff; font-size: 12px; font-weight: 800; display: flex; align-items: center; justify-content: center; flex-shrink: 0; box-shadow: 0 0 0 2px var(--sb-surface), 0 0 0 4px var(--sb-orange); }
  .sb-uname { font-size: 13px; font-weight: 700; color: var(--sb-text); }
  .sb-urole-pill { display: inline-block; margin-top: 3px; padding: 1px 8px; border-radius: 999px; font-size: 9.5px; font-weight: 700; letter-spacing: .03em; background: color-mix(in srgb, var(--sb-orange) 18%, transparent); color: var(--sb-orange); }
  .sb-actions { display: flex; gap: 8px; }
  .sb-btn { flex: 1; height: 36px; border: 1px solid var(--sb-border); border-radius: 10px; background: var(--sb-card); color: var(--sb-text-muted); font-family: var(--font); font-size: 11.5px; font-weight: 600; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 6px; transition: background .18s ease, color .18s ease, border-color .18s ease; }
  .sb-btn:hover { background: var(--sb-border); color: var(--sb-text); }
  .sb-btn:focus-visible { outline: 2px solid var(--sb-orange); outline-offset: 2px; }
  .sb-btn.danger { border-color: var(--sb-orange); background: transparent; color: var(--sb-orange); }
  .sb-btn.danger:hover { background: var(--sb-orange); color: #fff; }

  /* ── COLLAPSIBLE SIDEBAR ── */
  .main { transition: margin-left 0.2s cubic-bezier(0.4, 0, 0.2, 1); }
  .sidebar.collapsed { width: 72px; min-width: 72px; }
  .sidebar.collapsed:hover { width: 264px; box-shadow: 10px 0 32px rgba(0,0,0,.4); z-index: 30; }
  .sidebar.collapsed:not(:hover) .sb-logo { margin: 0 auto; }
  .sidebar.collapsed:not(:hover) .sb-name,
  .sidebar.collapsed:not(:hover) .sb-ver,
  .sidebar.collapsed:not(:hover) .sb-uname,
  .sidebar.collapsed:not(:hover) .sb-urole-pill,
  .sidebar.collapsed:not(:hover) .sb-actions,
  .sidebar.collapsed:not(:hover) .sb-brand-text,
  .sidebar.collapsed:not(:hover) .sb-search,
  .sidebar.collapsed:not(:hover) .sb-group-bar,
  .sidebar.collapsed:not(:hover) .sb-group-title span span:last-child,
  .sidebar.collapsed:not(:hover) .sb-group-chevron,
  .sidebar.collapsed:not(:hover) .sb-item span:last-child,
  .sidebar.collapsed:not(:hover) .sb-sub-item span:last-child { display: none; }
  .sidebar.collapsed:not(:hover) .sb-group { padding-left: 0; }
  .sidebar.collapsed:not(:hover) .sb-group-items-wrap { grid-template-rows: 1fr !important; }
  .sidebar.collapsed:not(:hover) .sb-sub-item { padding: 0; justify-content: center; border-left: none; }
  .sidebar.collapsed:not(:hover) .sb-item { padding: 0; justify-content: center; border-left: none; }
  .sidebar.collapsed:not(:hover) .sb-group-title { justify-content: center; padding: 6px 0; }
  .sidebar.collapsed:not(:hover) .sb-foot { display: flex; flex-direction: column; align-items: center; justify-content: center; }
  .main.collapsed { margin-left: 72px; }

  /* ── MAIN ── */
  .main { margin-left: 264px; flex: 1; display: flex; flex-direction: column; height: 100vh; background: var(--bg); overflow: hidden; }
  .topbar { height: 50px; background: var(--surface); border-bottom: 1px solid var(--border); display: flex; align-items: flex-end; padding: 0 22px; position: sticky; top: 0; z-index: 10; overflow-x: auto; }
  .tabs { display: flex; gap: 3px; align-items: flex-end; height: 100%; }
  .tab-item { height: 36px; display: flex; align-items: center; gap: 7px; padding: 0 12px; border: 1px solid var(--border); border-bottom: none; border-radius: 9px 9px 0 0; background: var(--soft); color: var(--muted); font-size: 12.5px; font-weight: 600; cursor: pointer; white-space: nowrap; flex-shrink: 0; position: relative; transition: all .15s; font-family: var(--font); }
  .tab-item:hover { background: var(--surface); color: var(--text); }
  .tab-item.active { background: var(--surface); color: var(--text); }
  .tab-item.active::after { content: ''; position: absolute; top: 0; left: 12px; right: 12px; height: 2.5px; background: linear-gradient(90deg, var(--orange), var(--orange2)); border-radius: 999px; }
  .tab-close { font-size: 10px; color: var(--hint); margin-left: 2px; padding: 2px 4px; border-radius: 3px; border: none; background: none; cursor: pointer; font-family: var(--font); }
  .tab-close:hover { background: var(--border); color: var(--muted); }
  .page-area { flex: 1; padding: 24px; display: flex; flex-direction: column; overflow: hidden; }
  .page-area > div { display: flex; flex-direction: column; flex: 1; min-height: 0; height: 100%; }
  .flex-row-layout { display: flex; flex-direction: row; }

  /* ── MOBILE TOPBAR (hamburger) ── */
  .mobile-topbar { display: none; height: 50px; background: var(--surface); border-bottom: 1px solid var(--border); align-items: center; gap: 10px; padding: 0 14px; flex-shrink: 0; }
  .mobile-menu-btn { width: 34px; height: 34px; border-radius: 9px; border: 1px solid var(--border); background: var(--soft); color: var(--text); display: flex; align-items: center; justify-content: center; cursor: pointer; flex-shrink: 0; }
  .mobile-menu-btn:hover { background: var(--border); }
  .mobile-brand { font-size: 14px; font-weight: 800; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .sidebar-backdrop { display: none; }

  /* ── RESPONSIVE: app shell collapses to an off-canvas sidebar ── */
  @media (max-width: 860px) {
    .mobile-topbar { display: flex; }
    .main, .main.collapsed { margin-left: 0; }
    .sidebar, .sidebar.collapsed {
      width: 84vw; max-width: 300px; min-width: 0;
      transform: translateX(-100%);
      box-shadow: none;
      transition: transform .22s ease;
    }
    .sidebar.mobile-open, .sidebar.collapsed.mobile-open {
      transform: translateX(0);
      box-shadow: 10px 0 32px rgba(0,0,0,.35);
    }
    /* Ignore the desktop hover-to-expand rail behaviour on touch screens */
    .sidebar.collapsed:hover { width: 84vw; max-width: 300px; }
    .sidebar.collapsed:not(:hover) .sb-name,
    .sidebar.collapsed:not(:hover) .sb-ver,
    .sidebar.collapsed:not(:hover) .sb-uname,
    .sidebar.collapsed:not(:hover) .sb-urole-pill,
    .sidebar.collapsed:not(:hover) .sb-actions,
    .sidebar.collapsed:not(:hover) .sb-brand-text,
    .sidebar.collapsed:not(:hover) .sb-search,
    .sidebar.collapsed:not(:hover) .sb-group-bar,
    .sidebar.collapsed:not(:hover) .sb-group-title span span:last-child,
    .sidebar.collapsed:not(:hover) .sb-group-chevron,
    .sidebar.collapsed:not(:hover) .sb-item span:last-child,
    .sidebar.collapsed:not(:hover) .sb-sub-item span:last-child { display: revert; }
    .sb-collapse-btn { display: none; }
    .sidebar-backdrop.open { display: block; position: fixed; inset: 0; background: rgba(0,0,0,.4); z-index: 19; }
    .topbar { padding: 0 12px; }
    .page-area { padding: 14px; }
    .login-card { padding: 24px; }
  }

  /* ── SHARED PAGE ── */
  .page-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 22px; }
  .page-title { font-size: 20px; font-weight: 800; }
  .page-sub { font-size: 13px; color: var(--muted); margin-top: 3px; }
  .page-actions { display: flex; gap: 8px; align-items: center; }
  .btn-primary { height: 36px; padding: 0 16px; border: none; border-radius: var(--radius-xs); background: linear-gradient(135deg, var(--orange), var(--orange2)); color: #fff; font-family: var(--font); font-size: 13px; font-weight: 700; cursor: pointer; transition: opacity .15s; }
  .btn-primary:hover { opacity: .9; }
  .btn-secondary { height: 36px; padding: 0 14px; border: 1px solid var(--border); border-radius: var(--radius-xs); background: var(--surface); color: var(--text); font-family: var(--font); font-size: 13px; font-weight: 600; cursor: pointer; transition: all .15s; }
  .btn-secondary:hover { border-color: var(--border2); background: var(--soft); }
  .loading-wrap { text-align: center; padding: 48px; color: var(--muted); }
  .spinner { display: inline-block; width: 22px; height: 22px; border: 2.5px solid var(--border); border-top-color: var(--orange); border-radius: 50%; animation: spin .7s linear infinite; margin-bottom: 10px; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .err-page { background: var(--red-soft); color: var(--red); border: 1px solid rgba(220,38,38,.2); border-radius: var(--radius-xs); padding: 12px 16px; font-size: 13px; margin-bottom: 16px; }

  /* ── SCROLLBARS ── */
  * { scrollbar-width: thin; scrollbar-color: var(--border2, var(--border)) transparent; }
  *::-webkit-scrollbar { width: 10px; height: 10px; }
  *::-webkit-scrollbar-track { background: transparent; }
  *::-webkit-scrollbar-thumb { background: var(--border2, var(--border)); border-radius: 999px; border: 2px solid transparent; background-clip: padding-box; }
  *::-webkit-scrollbar-thumb:hover { background: var(--hint); background-clip: padding-box; }

  /* ── THEME SELECTOR ── */
  .sb-theme-wrap { position: relative; flex: 1; }
  .sb-theme-wrap .sb-btn { position: relative; gap: 6px; }
  .sb-theme-wrap .sb-btn:focus-visible { outline: none; }
  .sb-theme-trigger-open { background: var(--sb-border); color: var(--sb-text); }
  .sb-theme-trigger-chev { flex-shrink: 0; margin-left: -1px; opacity: .7; transition: transform .15s ease; }

  /* Fixed width, centered under the trigger -- NOT left:0/right:0, which
     would inherit .sb-theme-wrap's own narrow width (it's one of 3 equal
     flex:1 columns in .sb-actions, ~76px) and force every option's text to
     wrap/truncate. 224px comfortably fits inside the 264px sidebar either way. */
  .sb-theme-menu { position: absolute; bottom: calc(100% + 8px); left: 50%; transform: translateX(-50%); width: 224px; background: var(--sb-card); border: 1px solid var(--sb-border); border-radius: 14px; box-shadow: var(--shadow-lg); padding: 6px; z-index: 40; animation: sbThemeMenuIn .14s ease-out; }
  @keyframes sbThemeMenuIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }
  .sb-theme-menu-label { padding: 6px 8px 5px; font-size: 9.5px; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; color: var(--sb-text-muted); }
  .sb-theme-opt { display: flex; align-items: center; gap: 10px; width: 100%; padding: 7px 8px; border: 1px solid transparent; border-radius: 10px; background: transparent; color: var(--sb-text-muted); font-family: var(--font); cursor: pointer; text-align: left; margin-bottom: 2px; transition: background .12s ease, border-color .12s ease; }
  .sb-theme-opt:last-child { margin-bottom: 0; }
  .sb-theme-opt:hover { background: var(--sb-hover-bg); }
  .sb-theme-opt:focus-visible { outline: none; border-color: var(--sb-orange); }
  .sb-theme-opt.active { background: var(--sb-orange-soft); }
  .sb-theme-swatch { position: relative; width: 26px; height: 26px; border-radius: 8px; flex-shrink: 0; border: 1px solid rgba(0,0,0,.08); display: flex; align-items: flex-end; justify-content: flex-end; padding: 3px; overflow: hidden; }
  .sb-theme-swatch-dot { width: 9px; height: 9px; border-radius: 50%; box-shadow: 0 0 0 1.5px rgba(255,255,255,.7); }
  .sb-theme-opt-text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
  .sb-theme-opt-name { font-size: 12.5px; font-weight: 700; color: var(--sb-text); white-space: nowrap; }
  .sb-theme-opt-desc { font-size: 10.5px; font-weight: 500; color: var(--sb-text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .sb-theme-check { color: var(--sb-orange); flex-shrink: 0; }
`;

// ─── Inject styles ────────────────────────────────────────────────────────────
const styleEl = document.createElement('style');
styleEl.textContent = css;
document.head.appendChild(styleEl);

// Muted per-group accent colors (left-edge stripe only -- orange stays reserved for the active state)
const GROUP_ACCENTS = ['var(--sb-orange)', '#34d399', '#a78bfa', '#38bdf8', '#f472b6', '#94a3b8'];
function accentForGroup(index) {
  return GROUP_ACCENTS[index % GROUP_ACCENTS.length];
}

// ─── Nav tree ─────────────────────────────────────────────────────────────────
// The sidebar is built live from PLS.PagesAndGroups at login. In this V1 shell,
// the only pages that render are server-registered "Simple CRUD" pages (their
// PageGroupID appears in GetCrudPages) -- they route to GenericMasterPage.
// Add bespoke screens by dropping components in src/pages and registering them
// in PAGE_COMPONENTS below.
const PAGE_COMPONENTS = {
  // keyed by PageGroupID (V1PagesAndGroups). e.g. 3: PurchaseOrderPage
};

// Admin-only maintenance screens. These are NOT part of PLS.V1PagesAndGroups /
// the sidebar -- they are reached from the gear button next to the admin name.
const SETTINGS_VIEWS = [
  { key: 'user_master', label: 'User Master', icon: '👤', Component: UserMaster },
  { key: 'group_page_master', label: 'Group & Page Master', icon: '🗂️', Component: GroupPageMaster },
  { key: 'query_master', label: 'Query Master', icon: '🗄️', Component: QueryMaster },
  { key: 'query_filter_master', label: 'Query Filter', icon: '🔎', Component: QueryFilterMaster },
  { key: 'operation_master', label: 'Operation Master', icon: '⚙️', Component: OperationMaster },
  { key: 'group_by_master', label: 'Group By Master', icon: '∑', Component: GroupByMaster },
  { key: 'report_master', label: 'Report Master', icon: '🖨️', Component: ReportMaster },
  { key: 'user_permissions', label: 'User Permissions', icon: '🔐', Component: UserPagePermissions },
  { key: 'notification_settings', label: 'Notification Settings', icon: '🔔', Component: NotificationSettings },
];

const THEME_KEY = 'sila_theme';
const REMEMBER_KEY = 'sila_remember_username';
// swatchBg/swatchAccent drive the little two-tone preview dot in the theme
// menu -- literal hexes (not var(--...)) on purpose, so each option always
// shows its OWN colors regardless of which theme is currently active.
const THEMES = [
  { key: 'light', label: 'Light', desc: 'Bright & neutral', icon: Sun, swatchBg: '#ffffff', swatchAccent: '#f97316' },
  { key: 'dark', label: 'Dark', desc: 'Easy on the eyes at night', icon: Moon, swatchBg: '#161b22', swatchAccent: '#fb923c' },
  { key: 'warm-ivory', label: 'Warm Ivory', desc: 'Soft & warm for long sessions', icon: Palette, swatchBg: '#F7F3EB', swatchAccent: '#FF5A0A' },  { key: 'ocean-blue', label: 'Ocean Blue', desc: 'Cool & calm · navy sidebar, blue accent', icon: Droplets, swatchBg: '#F2F6FB', swatchAccent: '#1E63D6' },
];

// Settings opens as one in-app tab (not a browser tab); this is its tab id.
const SETTINGS_TAB_ID = '__settings__';

// The Settings tab body: a sub-tab bar over the maintenance screens. Closing is
// done from the topbar tab strip like any other tab.
function SettingsHub({ user, settingsView, setSettingsView }) {
  const key = settingsView || SETTINGS_VIEWS[0].key;
  const V = SETTINGS_VIEWS.find(v => v.key === key);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, width: '100%' }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, padding: '10px 16px',
        borderBottom: '1px solid var(--border)', flexShrink: 0, flexWrap: 'wrap',
      }}>
        <span style={{ fontSize: 13, fontWeight: 800, color: 'var(--text)', marginRight: 8 }}>⚙️ Settings</span>
        {SETTINGS_VIEWS.map(v => (
          <button key={v.key} onClick={() => setSettingsView(v.key)} style={{
            height: 30, padding: '0 12px', borderRadius: 8, fontSize: 12, fontWeight: 700, cursor: 'pointer',
            border: '1px solid var(--border)',
            background: key === v.key ? 'var(--orange)' : 'var(--soft)',
            color: key === v.key ? '#fff' : 'var(--muted)',
          }}>{v.icon} {v.label}</button>
        ))}
      </div>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 24, display: 'flex' }}>
        <ErrorBoundary>{V ? <V.Component user={user} /> : null}</ErrorBoundary>
      </div>
    </div>
  );
}

function buildNavTree(rows /* , crudPageIds */) {
  // Every group/page registered in PLS.V1PagesAndGroups is shown. A page with no
  // component (PAGE_COMPONENTS) and no Simple-CRUD binding still appears -- it
  // just opens a "no screen bound yet" placeholder.
  const topLevel = rows
    .filter(r => !r.ParentID)
    .slice()
    .sort((a, b) => a.SortOrder - b.SortOrder);

  return topLevel
    .map(r => {
      if (r.IsGroup) {
        const children = rows
          .filter(c => !c.IsGroup && c.ParentID === r.PageGroupID)
          .sort((a, b) => a.SortOrder - b.SortOrder)
          .map(c => ({
            id: c.PageGroupID, label: c.Label, icon: c.Icon, desc: c.Description,
            requireGroupBy: c.RequireGroupBy === 1 || c.RequireGroupBy === true,
          }));
        return {
          id: r.PageGroupID, label: r.Label, icon: r.Icon, desc: r.Description,
          isGroup: true, children
        };
      }
      return {
        id: r.PageGroupID, label: r.Label, icon: r.Icon, desc: r.Description,
        requireGroupBy: r.RequireGroupBy === 1 || r.RequireGroupBy === true,
      };
    });
}

// ─── App ─────────────────────────────────────────────────────────────────────
export default function App() {
  const [user, setUser] = useState(null);
  const mobileParams = new URLSearchParams(window.location.search);
  const mobileCashPayable = mobileParams.get('mobile') === 'cash-payable';
  const mobileCashPageId = Number(mobileParams.get('page')) || 46;
  // Theme: 'light' | 'dark' | 'warm-ivory'. Persisted so it survives a
  // logout/login or a plain browser refresh (see the effect below).
  const [theme, setTheme] = useState(() => {
    try { return localStorage.getItem(THEME_KEY) || 'warm-ivory'; } catch { return 'warm-ivory'; }
  });
  const [themeMenuOpen, setThemeMenuOpen] = useState(false);
  const themeMenuRef = useRef(null);
  const [openTabs, setOpenTabs] = useState([]);
  const [activeTab, setActiveTab] = useState(null);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [isMobileNavOpen, setIsMobileNavOpen] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState(() => new Set());
  const [navFilter, setNavFilter] = useState('');
  const searchInputRef = useRef(null);

  const [allowedPages, setAllowedPages] = useState([]);
  const [nav, setNav] = useState([]);
  const [crudPageIds, setCrudPageIds] = useState(new Set());
  const [settingsView, setSettingsView] = useState(null); // null | SETTINGS_VIEWS[i].key

  // login
  const [un, setUn] = useState(() => {
    try { return localStorage.getItem(REMEMBER_KEY) || ''; } catch { return ''; }
  });
  const [pw, setPw] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [rememberMe, setRememberMe] = useState(true);
  const [loginErr, setLoginErr] = useState('');
  const [loginLoading, setLoginLoading] = useState(false);
  const [reloadingWs, setReloadingWs] = useState(false);
  const [wsError, setWsError] = useState(null);   // the sidebar / permissions could not be loaded
  // api.js retries slow / empty reads and announces it -- show a short note
  const [retryNote, setRetryNote] = useState(null);
  useEffect(() => {
    let timer;
    const on = () => { setRetryNote('Server is slow — retrying…'); clearTimeout(timer); timer = setTimeout(() => setRetryNote(null), 5000); };
    window.addEventListener('sila:api-retry', on);
    return () => { window.removeEventListener('sila:api-retry', on); clearTimeout(timer); };
  }, []);
  // a save got no answer (api.js 'sila:write-unknown'): warn before anyone retries it
  const [writeUnknown, setWriteUnknown] = useState(null);
  useEffect(() => {
    const on = (e) => setWriteUnknown({ operation: e.detail?.operation || 'the action' });
    window.addEventListener('sila:write-unknown', on);
    return () => window.removeEventListener('sila:write-unknown', on);
  }, []);

  // Keep ?settings=<key> in sync while the Settings tab is open so a refresh
  // (or a shared link) restores it.
  useEffect(() => {
    const hasParam = new URLSearchParams(window.location.search).has('settings');
    const wantParam = settingsView != null;
    if (!hasParam && !wantParam) return;
    const url = wantParam
      ? `${window.location.pathname}?settings=${settingsView}`
      : window.location.pathname;
    window.history.replaceState(null, '', url);
  }, [settingsView]);

  useEffect(() => {
    function handleKeyDown(e) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        searchInputRef.current?.focus();
      }
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, []);

  const toggleGroup = (id) => {
    setCollapsedGroups(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  // Keep <body>'s theme class (and localStorage) in sync with `theme`. Body,
  // not just the .app div, so login-page/full-page states are themed too.
  useEffect(() => {
    document.body.classList.remove('dark', 'warm-ivory', 'ocean-blue');
    if (theme !== 'light') document.body.classList.add(theme);
    try { localStorage.setItem(THEME_KEY, theme); } catch { /* private mode, quota, ... */ }
  }, [theme]);

  const applyTheme = useCallback((next) => {
    setTheme(next);
    setThemeMenuOpen(false);
    // drop focus so the trigger button's focus ring doesn't linger visibly
    // after picking an option
    document.activeElement?.blur?.();
  }, []);

  useEffect(() => {
    if (!themeMenuOpen) return;
    const onClick = (e) => {
      if (themeMenuRef.current && !themeMenuRef.current.contains(e.target)) setThemeMenuOpen(false);
    };
    const onKey = (e) => { if (e.key === 'Escape') { setThemeMenuOpen(false); document.activeElement?.blur?.(); } };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [themeMenuOpen]);

  const openPage = useCallback((id, currentAllowed = allowedPages, currentUser = user, currentNav = nav) => {
    if (currentUser) {
      const isAdmin = currentUser.IsAdmin === 1 || currentUser.IsAdmin === true || (currentUser.Username || '').toLowerCase() === 'sysadmin';
      if (!isAdmin) {
        const isAllowed = currentAllowed.some(ap => String(ap.PageGroupID) === String(id));
        if (!isAllowed) return;
      }
    }
    setActiveTab(id);
    setOpenTabs(prev => {
      if (prev.find(t => t.id === id)) return prev;
      let tabDef = currentNav.find(n => n.id === id);
      if (!tabDef) {
        for (const n of currentNav) {
          if (n.isGroup && n.children) {
            const child = n.children.find(c => c.id === id);
            if (child) { tabDef = child; break; }
          }
        }
      }
      return [...prev, { id, ...(tabDef || {}) }];
    });
    setIsMobileNavOpen(false); // dismiss the off-canvas sidebar on phone/tablet after picking a page
  }, [allowedPages, user, nav]);

  // Open Settings as an in-app tab (never a browser tab).
  const openSettings = useCallback((key) => {
    const isAdmin = user && (user.IsAdmin === 1 || user.IsAdmin === true
      || (user.Username || '').toLowerCase() === 'sysadmin');
    if (!isAdmin) return;
    setSettingsView(SETTINGS_VIEWS.some(v => v.key === key) ? key : SETTINGS_VIEWS[0].key);
    setActiveTab(SETTINGS_TAB_ID);
    setOpenTabs(prev => prev.some(t => t.id === SETTINGS_TAB_ID)
      ? prev
      : [...prev, { id: SETTINGS_TAB_ID, label: 'Settings', icon: '⚙️' }]);
  }, [user]);

  // Restore the Settings tab when the app is loaded with ?settings=<key>.
  useEffect(() => {
    if (!user) return;
    const key = new URLSearchParams(window.location.search).get('settings');
    if (key) openSettings(key);
  }, [user, openSettings]);

  // Load the allowed-pages / sidebar / operation grants for the signed-in user.
  // Used both right after login and by the sidebar "Reload" button so newly
  // granted pages / operations show up without logging out.
  const fetchWorkspace = useCallback(async () => {
    let allowed = [];
    let builtNav = [];
    let crudIds = new Set();
    let allowedOperations = [];
    // The gateway sometimes stalls for a minute or more: each call gets its
    // own time limit and up to 3 attempts, and they no longer wait on each
    // other -- one slow call must not leave the menu empty.
    const call = async (op, tries = 3, ms = 20000) => {
      let last;
      for (let i = 0; i < tries; i++) {
        try {
          const res = await Promise.race([
            apiCall(op, {}, {}, 'plus'),
            new Promise((_, rej) => setTimeout(() => rej(new Error(`${op} timed out`)), ms)),
          ]);
          if (res && res.State === 0) return res;
          last = new Error(res?.Message || `${op} failed`);
        } catch (e) { last = e; }
      }
      throw last;
    };
    const settled = await Promise.allSettled(['GetUserAllowedPages', 'GetPagesAndGroups', 'GetCrudPages', 'GetUserAllowedOperations'].map(op => call(op)));
    const [allowedRes, pagesRes, crudRes, allowedOpsRes] = settled.map(r => (r.status === 'fulfilled' ? r.value : { State: -1, List0: [] }));
    const failed = settled.filter(r => r.status === 'rejected').map(r => r.reason?.message || 'request failed');
    if (allowedRes.State === 0) allowed = allowedRes.List0 || [];
    if (crudRes.State === 0) crudIds = new Set((crudRes.List0 || []).map(r => r.PageGroupID));
    if (pagesRes.State === 0) builtNav = buildNavTree(pagesRes.List0 || [], crudIds);
    if (allowedOpsRes.State === 0) allowedOperations = (allowedOpsRes.List0 || []).map(r => {
      let cfg = {};
      try { cfg = { ...JSON.parse(r.Config || '{}'), ...JSON.parse(r.ConfigOverride || '{}') }; } catch { /* keep {} */ }
      return {
        pageGroupId: r.PageGroupID, operationKey: r.OperationKey,
        backendOperation: r.BackendOperation, queryId: r.QueryID, config: cfg,
      };
    });
    return { allowed, builtNav, crudIds, allowedOperations, failed };
  }, []);

  const applyWorkspace = useCallback(({ allowed, builtNav, crudIds, allowedOperations, failed = [] }, { resetCollapsed = false } = {}) => {
    setWsError(failed.length ? failed.join(' · ') : null);
    setAllowedPages(allowed);
    setNav(builtNav);
    if (resetCollapsed) setCollapsedGroups(new Set(builtNav.filter(n => n.isGroup).map(n => n.id)));
    setCrudPageIds(crudIds);
    setUser(prev => prev ? { ...prev, AllowedOperations: allowedOperations } : prev);
  }, []);

  const reloadWorkspace = useCallback(async () => {
    if (!user || reloadingWs) return;
    setReloadingWs(true);
    // permissions may have changed -- lookup lists are permission-filtered, so
    // drop them (and the cached page settings); every picker / filter list /
    // page refetches on its next open
    clearLookupCache();
    clearApiCache();
    try {
      const ws = await fetchWorkspace();
      applyWorkspace(ws);
    } catch (err) {
      console.error('Reload workspace failed:', err);
    }
    setReloadingWs(false);
  }, [user, reloadingWs, fetchWorkspace, applyWorkspace]);

  const handleLogin = async (e) => {
    e?.preventDefault();
    if (!un || !pw) { setLoginErr('Enter username and password'); return; }
    setLoginLoading(true); setLoginErr('');
    try {
      const d = await apiCall('Login', { Username: un, Password: pw }, {}, { spName: 'Pls.APIPlusUserOperationV1' });
      if (d.State === 0 && d.List0?.length) {
        const u = d.List0[0];
        try {
          if (rememberMe) localStorage.setItem(REMEMBER_KEY, u.Username || un);
          else localStorage.removeItem(REMEMBER_KEY);
        } catch { /* private mode, quota, ... -- just skip remembering */ }
        clearLookupCache();   // lookup lists are per-user (filter permissions)
        clearApiCache();      // and so are the cached page settings
        sessionStorage.setItem('FullName', u.Username || un);
        setUser({ Username: u.Username || un, Name: u.Name || un, IsAdmin: u.IsAdmin, AllowedOperations: [] });
        try {
          const ws = await fetchWorkspace();
          applyWorkspace(ws, { resetCollapsed: true });
        } catch (err) {
          console.error('Failed to load user allowed pages / sidebar:', err);
        }
        // No page is auto-opened on login -- the user picks one from the sidebar.
      } else {
        setLoginErr(d.Message || 'Invalid username or password');
      }
    } catch (e) {
      setLoginErr('Connection error: ' + e.message);
    }
    setLoginLoading(false);
  };

  const handleLogout = () => {
    clearLookupCache();
    clearApiCache();
    sessionStorage.removeItem('FullName');
    setUser(null); setOpenTabs([]); setActiveTab(null);
    setAllowedPages([]);
    setWsError(null);
  };

  const closeTab = (id, e) => {
    e.stopPropagation();
    if (id === SETTINGS_TAB_ID) setSettingsView(null);
    setOpenTabs(prev => {
      const next = prev.filter(t => t.id !== id);
      if (activeTab === id) setActiveTab(next.length ? next[next.length - 1].id : null);
      return next;
    });
  };

  const getDefForId = (id) => {
    let def = nav.find(n => n.id === id);
    if (!def) {
      for (const n of nav) {
        if (n.isGroup && n.children) {
          const child = n.children.find(c => c.id === id);
          if (child) return child;
        }
      }
    }
    return def;
  };

  if (!user) {
    return (
      <div className="login-page">
        <div className="login-card">
          <div className="login-logo">P1</div>
          <div className="login-title">Sila</div>
          {mobileCashPayable && <p style={{ color: 'var(--muted)', marginBottom: 20 }}>Sign in to Cash Payable</p>}
          {loginErr && <div className="err-box">{loginErr}</div>}
          <div className="field">
            <label>Username</label>
            <input value={un} onChange={e => setUn(e.target.value)} placeholder="Enter username" autoFocus />
          </div>
          <div className="field">
            <label>Password</label>
            <div className="field-pw-wrap">
              <input type={showPw ? 'text' : 'password'} value={pw} onChange={e => setPw(e.target.value)}
                placeholder="Enter password" onKeyDown={e => e.key === 'Enter' && handleLogin()} />
              <button type="button" className="field-pw-toggle" onClick={() => setShowPw(s => !s)}
                tabIndex={-1} title={showPw ? 'Hide password' : 'Show password'}>
                {showPw ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </div>
          <label className="field-remember">
            <input type="checkbox" checked={rememberMe} onChange={e => setRememberMe(e.target.checked)} />
            <span>Remember me</span>
          </label>
          <button className="btn-login" onClick={handleLogin} disabled={loginLoading}>
            {loginLoading ? 'Signing in…' : 'Sign In'}
          </button>
          <div className="login-api">sila.silasystem.com:7103</div>
        </div>
      </div>
    );
  }

  if (mobileCashPayable) return <CashPayableMobilePage user={user} pageGroupId={mobileCashPageId}
    allowedPages={allowedPages} ready={!loginLoading} onLogout={handleLogout} />;

  const initials = (user.Name || user.Username).split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
  const isUserAdmin = user.IsAdmin === 1 || user.IsAdmin === true || (user.Username || '').toLowerCase() === 'sysadmin';

  return (
    <div className={`app${theme !== 'light' ? ' ' + theme : ''}`}>
      {/* Sidebar */}
      <div className={`sidebar-backdrop${isMobileNavOpen ? ' open' : ''}`} onClick={() => setIsMobileNavOpen(false)} />
      <aside className={`sidebar${isSidebarCollapsed ? ' collapsed' : ''}${isMobileNavOpen ? ' mobile-open' : ''}`}>
        <div className="sb-head">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <div className="sb-brand" title="Sila">
              <div className="sb-logo">
                P1
                <div className="sb-status-dot" />
              </div>
              <div className="sb-brand-text">
                <div className="sb-name">Sila</div>
                <div className="sb-ver">v0.1.0</div>
              </div>
            </div>
            <button
              className="sb-collapse-btn"
              onClick={() => setIsSidebarCollapsed(!isSidebarCollapsed)}
              title={isSidebarCollapsed ? 'Expand Sidebar' : 'Collapse Sidebar'}
            >
              {isSidebarCollapsed ? <PanelLeftOpen size={13} /> : <PanelLeftClose size={13} />}
            </button>
          </div>
        </div>
        <div className="sb-search">
          <Search size={13} className="sb-search-icon" />
          <input
            ref={searchInputRef}
            className="sb-search-input"
            placeholder="Quick jump..."
            value={navFilter}
            onChange={e => setNavFilter(e.target.value)}
          />
          {!navFilter && <span className="sb-search-kbd">⌘K</span>}
        </div>
        <nav className="sb-nav">
          {wsError && (
            <div role="alert" style={{ margin: '4px 2px 10px', padding: '10px 12px', borderRadius: 8, background: 'var(--red-soft)', color: 'var(--red)', fontSize: 12, fontWeight: 600, lineHeight: 1.4 }}>
              {nav.length ? 'Some permissions could not be loaded.' : 'The menu could not be loaded -- the server did not answer in time.'}
              <button onClick={reloadWorkspace} disabled={reloadingWs} style={{ display: 'block', marginTop: 8, height: 28, padding: '0 12px', borderRadius: 6, border: '1px solid var(--red)', background: 'var(--surface)', color: 'var(--red)', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>
                {reloadingWs ? 'Retrying…' : '↻ Retry'}
              </button>
            </div>
          )}
          {nav.map((n, idx) => {
            const isAdmin = isUserAdmin;
            const filterQuery = navFilter.trim().toLowerCase();
            const matchesFilter = (label) => !filterQuery || (label || '').toLowerCase().includes(filterQuery);
            if (n.isGroup) {
              const allowedChildren = n.children.filter(c => isAdmin || allowedPages.some(ap => String(ap.PageGroupID) === String(c.id)));
              if (allowedChildren.length === 0) return null;

              let visibleChildren = allowedChildren;
              if (filterQuery) {
                const directMatches = allowedChildren.filter(c => matchesFilter(c.label));
                visibleChildren = directMatches.length > 0 || !matchesFilter(n.label) ? directMatches : allowedChildren;
                if (visibleChildren.length === 0) return null;
              }

              const accent = accentForGroup(idx);
              const isGroupCollapsed = filterQuery ? false : collapsedGroups.has(n.id);
              return (
                <div key={n.id} className="sb-group" style={{ '--group-accent': accent }}>
                  <div className="sb-group-bar" />
                  <button
                    type="button"
                    className="sb-group-title"
                    onClick={() => toggleGroup(n.id)}
                    aria-expanded={!isGroupCollapsed}
                    title={n.label}
                  >
                    <span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                      <span className="sb-icon"><NavIcon pageId={n.id} icon={n.icon} label={n.label} size={13} /></span>
                      <span>{n.label}</span>
                    </span>
                    <ChevronDown size={13} className="sb-group-chevron" style={{ transform: isGroupCollapsed ? 'rotate(0deg)' : 'rotate(180deg)' }} />
                  </button>
                  <div className={`sb-group-items-wrap${isGroupCollapsed ? ' collapsed' : ''}`}>
                    <div className="sb-group-items">
                      {visibleChildren.map(c => (
                        <button key={c.id} className={`sb-sub-item${activeTab === c.id ? ' active' : ''}`} onClick={() => openPage(c.id)} title={c.label}>
                          <span className="sb-icon"><NavIcon pageId={c.id} icon={c.icon} label={c.label} size={13} /></span>
                          <span>{c.label}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              );
            }
            const isItemAllowed = isAdmin || allowedPages.some(ap => String(ap.PageGroupID) === String(n.id));
            if (!isItemAllowed) return null;
            if (filterQuery && !matchesFilter(n.label)) return null;
            return (
              <button key={n.id} className={`sb-item${activeTab === n.id ? ' active' : ''}`} onClick={() => openPage(n.id)} title={n.label}>
                <span className="sb-icon"><NavIcon pageId={n.id} icon={n.icon} label={n.label} size={14} /></span>
                <span>{n.label}</span>
              </button>
            );
          })}
          {nav.length === 0 && (
            <div style={{ padding: '16px 12px', color: 'var(--sb-text-muted)', fontSize: 12 }}>
              No pages registered yet.
            </div>
          )}
        </nav>
        <div className="sb-foot">
          <div className="sb-profile">
            <div className="sb-avatar">{initials}</div>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div className="sb-uname">{user.Name || user.Username}</div>
              {isUserAdmin && <span className="sb-urole-pill">Admin</span>}
            </div>
            <NotificationBell user={user} onNavigateToPage={openPage} />
            {isUserAdmin && (
              <button
                className="sb-btn"
                style={{ width: 30, height: 30, padding: 0, flex: 'none', justifyContent: 'center' }}
                title="Settings"
                onClick={() => openSettings(SETTINGS_VIEWS[0].key)}
              >
                <Settings size={14} />
              </button>
            )}
          </div>
          <div className="sb-actions">
            <button className="sb-btn" onClick={reloadWorkspace} disabled={reloadingWs}
              title="Reload pages & permissions without logging out">
              <RefreshCw size={14} style={reloadingWs ? { animation: 'spin 0.8s linear infinite' } : undefined} />
              <span>{reloadingWs ? 'Reloading…' : 'Reload'}</span>
            </button>
            <div className="sb-theme-wrap" ref={themeMenuRef}>
              <button className={`sb-btn${themeMenuOpen ? ' sb-theme-trigger-open' : ''}`}
                onClick={() => setThemeMenuOpen(o => !o)} title="Change theme"
                aria-haspopup="true" aria-expanded={themeMenuOpen} style={{ width: '100%' }}>
                {(() => { const Icon = THEMES.find(t => t.key === theme)?.icon || Sun; return <Icon size={14} />; })()}
                <span>Theme</span>
                <ChevronDown size={12} className="sb-theme-trigger-chev" style={{ transform: themeMenuOpen ? 'rotate(180deg)' : undefined }} />
              </button>
              {themeMenuOpen && (
                <div className="sb-theme-menu" role="menu">
                  <div className="sb-theme-menu-label">Appearance</div>
                  {THEMES.map(t => (
                    <button key={t.key} role="menuitemradio" aria-checked={theme === t.key}
                      className={`sb-theme-opt${theme === t.key ? ' active' : ''}`} onClick={() => applyTheme(t.key)}>
                      <span className="sb-theme-swatch" style={{ background: t.swatchBg }}>
                        <span className="sb-theme-swatch-dot" style={{ background: t.swatchAccent }} />
                      </span>
                      <span className="sb-theme-opt-text">
                        <span className="sb-theme-opt-name">{t.label}</span>
                        <span className="sb-theme-opt-desc">{t.desc}</span>
                      </span>
                      {theme === t.key && <Check size={14} className="sb-theme-check" />}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <button className="sb-btn danger" onClick={handleLogout}><LogOut size={14} /><span>Logout</span></button>
          </div>
        </div>
      </aside>

      {/* Main */}
      <section className={`main${isSidebarCollapsed ? ' collapsed' : ''}`}>
        <div className="mobile-topbar">
          <button className="mobile-menu-btn" onClick={() => setIsMobileNavOpen(o => !o)} title="Menu">
            {isMobileNavOpen ? <X size={18} /> : <Menu size={18} />}
          </button>
          <span className="mobile-brand">Sila</span>
        </div>
        {openTabs.length > 0 && (
          <header className="topbar">
            <div className="tabs">
              {openTabs.map(t => (
                <div key={t.id} className={`tab-item${t.id === activeTab ? ' active' : ''}`} onClick={() => openPage(t.id)}>
                  <span>{t.icon || '📝'}</span> {t.label || 'Tab'}
                  <button className="tab-close" onClick={e => closeTab(t.id, e)}>✕</button>
                </div>
              ))}
            </div>
          </header>
        )}
        <div className="page-area">
          {openTabs.length === 0 && (
            <div style={{ textAlign: 'center', padding: '48px', color: 'var(--muted)' }}>Select a page from the sidebar</div>
          )}
          {openTabs.map(t => {
            const shown = t.id === activeTab;
            if (t.id === SETTINGS_TAB_ID) {
              return (
                <div key={t.id} style={{ display: shown ? 'flex' : 'none', flex: 1 }}>
                  <ErrorBoundary>
                    <SettingsHub user={user} settingsView={settingsView} setSettingsView={setSettingsView} />
                  </ErrorBoundary>
                </div>
              );
            }
            const def = getDefForId(t.id);
            const TabPage = PAGE_COMPONENTS[t.id] || (crudPageIds.has(t.id) ? GenericMasterPage : null);
            return (
              <div key={t.id} style={{ display: shown ? 'flex' : 'none', flex: 1 }}>
                <ErrorBoundary>
                  {TabPage
                    ? <TabPage user={user} def={def} />
                    : <GridPage user={user} def={def} />}
                </ErrorBoundary>
              </div>
            );
          })}
        </div>
      </section>
      {writeUnknown && (
        <div role="alertdialog" aria-modal="true" aria-labelledby="wu-title" style={{
          position: 'fixed', inset: 0, zIndex: 20001, background: 'var(--overlay, rgba(0,0,0,.42))',
          display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
        }}>
          <div style={{
            width: 'min(440px, 100%)', background: 'var(--surface)', border: '1px solid var(--amber)',
            borderRadius: 14, boxShadow: '0 24px 60px rgba(0,0,0,.32)', padding: 22,
          }}>
            <div id="wu-title" style={{ fontSize: 15, fontWeight: 800, color: 'var(--amber)', marginBottom: 8 }}>⚠ Not confirmed — please check</div>
            <div style={{ fontSize: 12.5, color: 'var(--text)', lineHeight: 1.6 }}>
              The server did not answer <b>{writeUnknown.operation}</b>. It may have been saved anyway.
              <br />Reload the list or reopen the record to see whether it went through <b>before</b> trying again —
              repeating it blindly could save it twice.
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 20 }}>
              <button autoFocus onClick={() => setWriteUnknown(null)} style={{
                height: 34, padding: '0 18px', borderRadius: 8, fontSize: 12.5, fontWeight: 700, cursor: 'pointer',
                border: 'none', background: 'var(--amber)', color: '#fff',
              }}>OK, I'll check</button>
            </div>
          </div>
        </div>
      )}
      {retryNote && (
        <div role="status" style={{
          position: 'fixed', bottom: 18, right: 18, zIndex: 20000, padding: '8px 14px', borderRadius: 8,
          background: 'var(--amber-soft)', border: '1px solid var(--amber)', color: 'var(--amber)', fontSize: 12.5, fontWeight: 700,
        }}>⏳ {retryNote}</div>
      )}
    </div>
  );
}
