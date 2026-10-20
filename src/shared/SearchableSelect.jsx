import React, { useState, useRef, useEffect, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';

// Options accept optional `sublabel` (secondary line under the main label,
// e.g. an Arabic description) and `meta`/`metaSub` (right-aligned column,
// e.g. a price/UM) for a richer two-line row -- lookups that don't supply
// these just render the plain single-line label as before.
export default function SearchableSelect({ value, options, onChange, placeholder = '', style = {}, disabled = false, openOnFocus = false }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [searchFocused, setSearchFocused] = useState(false);
  const wrapperRef = useRef(null);
  const dropdownRef = useRef(null);
  const [coords, setCoords] = useState({ left: 0, top: 0, width: 0, goesUp: false });
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const optionRefs = useRef([]);

  useEffect(() => {
    function handleClickOutside(event) {
      if (
        wrapperRef.current && !wrapperRef.current.contains(event.target) &&
        dropdownRef.current && !dropdownRef.current.contains(event.target)
      ) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const updateCoords = () => {
    if (wrapperRef.current) {
      const rect = wrapperRef.current.getBoundingClientRect();
      const spaceBelow = window.innerHeight - rect.bottom;
      const dropdownHeight = 300;
      const goesUp = spaceBelow < dropdownHeight && rect.top > dropdownHeight;

      // widen the dropdown past a narrow trigger so long labels stay readable,
      // but keep it inside the viewport
      const desired = Math.max(rect.width, 360);
      const width = Math.min(desired, window.innerWidth - 24);
      const left = Math.max(12, Math.min(rect.left, window.innerWidth - width - 12));
      setCoords({
        left,
        top: goesUp ? rect.top : rect.bottom,
        width,
        goesUp
      });
    }
  };

  useLayoutEffect(() => {
    if (open) {
      updateCoords();
      // A second pass on the next frame catches cases where the trigger's
      // real position only settles after this paint -- e.g. a row that was
      // just inserted into a scrollable list and the browser is still
      // scrolling it into view (focus-triggered scrollIntoView), which
      // otherwise leaves the dropdown anchored to a stale/initial rect.
      const raf = requestAnimationFrame(updateCoords);
      window.addEventListener('resize', updateCoords);
      window.addEventListener('scroll', updateCoords, true);
      return () => {
        cancelAnimationFrame(raf);
        window.removeEventListener('resize', updateCoords);
        window.removeEventListener('scroll', updateCoords, true);
      };
    }
  }, [open]);

  const selectedOpt = options.find(o => String(o.value) === String(value));
  const displayLabel = selectedOpt ? selectedOpt.label : '';

  const filtered = options.filter(o =>
    String(o.label).toLowerCase().includes(search.toLowerCase()) ||
    String(o.sublabel || '').toLowerCase().includes(search.toLowerCase()) ||
    String(o.value).toLowerCase().includes(search.toLowerCase())
  );

  useEffect(() => {
    setHighlightedIndex(0);
  }, [search]);

  useEffect(() => {
    optionRefs.current[highlightedIndex]?.scrollIntoView({ block: 'nearest' });
  }, [highlightedIndex]);

  const handleKeyDown = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlightedIndex(prev => Math.min(prev + 1, filtered.length));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlightedIndex(prev => Math.max(prev - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (highlightedIndex === 0) {
        onChange('');
        setOpen(false);
      } else if (filtered[highlightedIndex - 1]) {
        onChange(filtered[highlightedIndex - 1].value);
        setOpen(false);
      }
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  };

  return (
    <div ref={wrapperRef} style={{ position: 'relative', width: '100%', ...style }}>
      <div
        className="searchable-trigger"
        title={displayLabel || undefined}
        tabIndex={0}
        onClick={() => {
          if (disabled || open) return;
          setSearch('');
          setHighlightedIndex(0);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (disabled) return;
          if (!open && (e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault();
            setSearch('');
            setHighlightedIndex(0);
            setOpen(true);
          }
        }}
        onFocus={() => {
          if (disabled || !openOnFocus || open) return;
          setSearch('');
          setHighlightedIndex(0);
          setOpen(true);
        }}
        style={{
          width: '100%',
          padding: '4px 8px',
          border: '1px solid var(--border)',
          borderRadius: '4px',
          background: 'var(--bg)',
          cursor: disabled ? 'not-allowed' : 'pointer',
          opacity: disabled ? 0.6 : 1,
          minHeight: '28px',
          display: 'flex',
          alignItems: 'center',
          overflow: 'hidden',
          whiteSpace: 'nowrap',
          textOverflow: 'ellipsis',
          fontSize: '13px',
          color: displayLabel ? 'var(--text)' : 'var(--muted)'
        }}
      >
        {displayLabel || placeholder}
      </div>

      {open && createPortal(
        <div
          ref={dropdownRef}
          style={{
            position: 'fixed',
            top: coords.goesUp ? undefined : coords.top + 6,
            bottom: coords.goesUp ? window.innerHeight - coords.top + 6 : undefined,
            left: coords.left,
            width: coords.width,
            background: 'var(--bg)',
            border: '1px solid var(--border)',
            borderRadius: '10px',
            zIndex: 999999,
            maxHeight: '300px',
            display: 'flex',
            flexDirection: 'column',
            boxShadow: '0 10px 30px rgba(0,0,0,0.18)',
            overflow: 'hidden'
          }}
        >
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8, margin: 8, padding: '0 10px',
            height: 36, flexShrink: 0, borderRadius: 8, background: 'var(--surface)',
            border: '1.5px solid ' + (searchFocused ? 'var(--orange)' : 'var(--border)'),
            boxShadow: searchFocused ? '0 0 0 3px var(--orange-glow)' : 'none',
            transition: 'border-color 0.15s, box-shadow 0.15s'
          }}>
            <span style={{ fontSize: 13, color: searchFocused ? 'var(--orange)' : 'var(--muted)', flexShrink: 0 }}>🔍</span>
            <input
              autoFocus
              value={search}
              onChange={e => setSearch(e.target.value)}
              onFocus={() => setSearchFocused(true)}
              onBlur={() => setSearchFocused(false)}
              onKeyDown={(e) => {
                if (e.key === 'Tab') {
                  e.preventDefault();
                  setOpen(false);
                } else {
                  handleKeyDown(e);
                }
              }}
              placeholder="Search..."
              style={{
                flex: 1,
                border: 'none',
                background: 'transparent',
                color: 'var(--text)',
                outline: 'none',
                fontSize: '13px',
                height: '100%'
              }}
            />
          </div>
          <div style={{ overflowY: 'auto', flex: 1, padding: '2px 8px 8px' }}>
            <div
              ref={el => optionRefs.current[0] = el}
              onClick={() => { onChange(''); setOpen(false); }}
              onMouseEnter={() => setHighlightedIndex(0)}
              style={{
                padding: '8px 10px',
                cursor: 'pointer',
                color: 'var(--muted)',
                fontSize: '13px',
                borderRadius: 8,
                background: highlightedIndex === 0 ? 'var(--orange-soft)' : 'transparent'
              }}
            >
              —
            </div>
            {filtered.length === 0 ? <div style={{ padding: '10px', color: 'var(--muted)', fontSize: '13px', textAlign: 'center' }}>No results</div> : null}
            {filtered.map((opt, i) => {
              const isHighlighted = highlightedIndex === i + 1;
              const hasRichContent = opt.sublabel || opt.meta;
              return (
                <div
                  key={i}
                  ref={el => optionRefs.current[i + 1] = el}
                  onClick={() => { onChange(opt.value); setOpen(false); }}
                  onMouseEnter={() => setHighlightedIndex(i + 1)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 12,
                    padding: hasRichContent ? '10px 12px' : '8px 10px',
                    cursor: 'pointer',
                    borderRadius: 8,
                    background: isHighlighted ? 'var(--orange-soft)' : 'transparent'
                  }}
                >
                  <div style={{ minWidth: 0 }}>
                    <div style={{
                      fontSize: '13px', fontWeight: hasRichContent ? 700 : 400,
                      color: isHighlighted && hasRichContent ? 'var(--orange)' : 'var(--text)',
                      overflowWrap: 'anywhere'
                    }}>
                      {opt.optionLabel || opt.label}
                    </div>
                    {opt.sublabel && (
                      <div style={{ fontSize: '11.5px', color: 'var(--muted)', marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {opt.sublabel}
                      </div>
                    )}
                  </div>
                  {opt.meta && (
                    <div style={{ textAlign: 'right', flexShrink: 0 }}>
                      <div style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text)', whiteSpace: 'nowrap' }}>{opt.meta}</div>
                      {opt.metaSub && (
                        <div style={{ fontSize: '10.5px', color: 'var(--muted)', marginTop: 2, whiteSpace: 'nowrap' }}>{opt.metaSub}</div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
