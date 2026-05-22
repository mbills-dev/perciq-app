import { useState, useRef, useEffect, useCallback } from 'react';
import { US_COUNTIES } from '../data/usCounties';

interface CountyAutocompleteProps {
  value: string;
  onChange: (display: string, county: string, state: string) => void;
  disabled?: boolean;
  inputRef?: React.RefObject<HTMLInputElement>;
  onConfirm?: () => void;
}

const INPUT_STYLE: React.CSSProperties = {
  width: '100%',
  background: 'rgba(255,255,255,0.05)',
  border: '1px solid rgba(255,255,255,0.10)',
  borderRadius: 8,
  padding: '10px 12px',
  color: '#fff',
  fontSize: 13,
  outline: 'none',
  boxSizing: 'border-box',
};

export default function CountyAutocomplete({
  value,
  onChange,
  disabled,
  inputRef: externalRef,
  onConfirm,
}: CountyAutocompleteProps) {
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const internalRef = useRef<HTMLInputElement>(null);
  const ref = externalRef ?? internalRef;
  const containerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const matches = value.trim().length >= 2
    ? US_COUNTIES.filter(c =>
        c.county.toLowerCase().startsWith(value.trim().toLowerCase()) ||
        `${c.county} county`.startsWith(value.trim().toLowerCase())
      ).slice(0, 8)
    : [];

  const select = useCallback((county: string, state: string) => {
    onChange(`${county} County, ${state}`, county, state);
    setOpen(false);
    setActiveIdx(0);
    onConfirm?.();
  }, [onChange, onConfirm]);

  useEffect(() => { setActiveIdx(0); }, [value]);

  useEffect(() => {
    if (!open) return;
    function handler(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  function handleKeyDown(e: React.KeyboardEvent) {
    if (!open || matches.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIdx(i => Math.min(i + 1, matches.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIdx(i => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const m = matches[activeIdx];
      if (m) select(m.county, m.state);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  }

  return (
    <div ref={containerRef} style={{ position: 'relative' }}>
      <input
        ref={ref}
        type="text"
        value={value}
        onChange={e => { onChange(e.target.value, '', ''); setOpen(true); }}
        onFocus={() => { if (matches.length > 0) setOpen(true); }}
        onKeyDown={handleKeyDown}
        style={INPUT_STYLE}
        placeholder="e.g. Durham County, NC"
        disabled={disabled}
        autoComplete="off"
      />
      {open && matches.length > 0 && (
        <ul
          ref={listRef}
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            right: 0,
            zIndex: 100,
            marginTop: 4,
            padding: '4px 0',
            background: '#1a2030',
            border: '1px solid rgba(255,255,255,0.12)',
            borderRadius: 8,
            listStyle: 'none',
            boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
            maxHeight: 240,
            overflowY: 'auto',
          }}
        >
          {matches.map((m, i) => (
            <li
              key={`${m.fips ?? m.county}-${m.state}`}
              onMouseDown={e => { e.preventDefault(); select(m.county, m.state); }}
              onMouseEnter={() => setActiveIdx(i)}
              style={{
                padding: '8px 12px',
                fontSize: 13,
                cursor: 'pointer',
                color: i === activeIdx ? '#000' : '#fff',
                background: i === activeIdx ? '#22C55E' : 'transparent',
                transition: 'background 0.1s',
              }}
            >
              {m.county} County, {m.state}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
