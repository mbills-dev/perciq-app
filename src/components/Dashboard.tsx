import { useEffect, useState, useRef } from 'react';
import { supabase } from '../lib/supabase';
import type { Parcel, Report, PlanTier } from '../types/database';
import { PLAN_LIMITS } from '../types/database';
import {
  Plus, Search, Trash2, Map as MapIcon, ChevronDown, ChevronUp,
  AlertCircle, Loader2, ArrowRight, X, CheckCircle2, Zap,
} from 'lucide-react';
import CountyAutocomplete from './CountyAutocomplete';

interface DashboardProps {
  onViewReport: (reportId: string) => void;
  onCreateReport: (parcelId: string) => void;
  onNavigateSettings?: () => void;
}

// ─── Score helpers ────────────────────────────────────────────────────────────

function getDisplayScore(report: Report | null): number | null {
  if (!report) return null;
  return report.best_zone_score ?? report.conventional_score ?? null;
}

function getOverallScore(report: Report | null): number | null {
  if (!report) return null;
  return report.parcel_score ?? report.alternative_score ?? null;
}

type Category = 'suitable' | 'marginal' | 'unsuitable' | 'pending';

function getCategory(score: number | null): Category {
  if (score === null) return 'pending';
  if (score > 65) return 'suitable';
  if (score >= 35) return 'marginal';
  return 'unsuitable';
}

const CAT_COLOR: Record<Category, string> = {
  suitable: '#30D158',
  marginal: '#FF9F0A',
  unsuitable: '#FF453A',
  pending: 'rgba(255,255,255,0.25)',
};

const CAT_LABEL: Record<Category, string> = {
  suitable: 'Suitable',
  marginal: 'Marginal',
  unsuitable: 'Unsuitable',
  pending: 'Pending',
};

// ─── Types ────────────────────────────────────────────────────────────────────

interface ParcelRow {
  parcel: Parcel;
  report: Report | null;
  soilTypeCount: number;
}

type FilterTab = 'all' | 'suitable' | 'marginal' | 'unsuitable';

// ─── Sub-components ───────────────────────────────────────────────────────────

function ScoreBadge({ score, label }: { score: number | null; label: string }) {
  const cat = getCategory(score);
  const color = CAT_COLOR[cat];
  return (
    <div className="text-right">
      <p style={{ fontSize: 16, fontWeight: 800, color, letterSpacing: '-0.5px', lineHeight: 1.1 }}>
        {score ?? '—'}
      </p>
      <p style={{ fontSize: 9, color: 'rgba(255,255,255,0.35)', textTransform: 'uppercase', letterSpacing: '0.5px', marginTop: 1 }}>
        {label}
      </p>
    </div>
  );
}

function DetailCard({
  label, value, borderColor, valueColor,
}: { label: string; value: string; borderColor: string; valueColor: string }) {
  return (
    <div style={{
      border: `1px solid ${borderColor}`,
      borderRadius: 8,
      padding: '10px 12px',
      background: 'transparent',
    }}>
      <p style={{ fontSize: 9, color: 'rgba(255,255,255,0.35)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 4 }}>
        {label}
      </p>
      <p style={{ fontSize: 13, fontWeight: 600, color: valueColor, lineHeight: 1.3 }}>
        {value}
      </p>
    </div>
  );
}

function ExpandedDetail({ row }: { row: ParcelRow }) {
  const { parcel, report } = row;
  const flood = report?.fema_feature_count != null
    ? (report.fema_feature_count > 0 ? `${Math.min(99, report.fema_feature_count * 5)}%` : '0%')
    : '—';
  const wetland = report?.nwi_feature_count != null
    ? (report.nwi_feature_count > 0 ? `${Math.min(99, report.nwi_feature_count * 4)}%` : '0%')
    : '—';

  const floodNum = report?.fema_feature_count != null ? Math.min(99, report.fema_feature_count * 5) : null;
  const wetlandNum = report?.nwi_feature_count != null ? Math.min(99, report.nwi_feature_count * 4) : null;

  function envColor(pct: number | null): { border: string; value: string } {
    if (pct === null) return { border: '#30D158', value: 'rgba(255,255,255,0.85)' };
    if (pct === 0) return { border: '#30D158', value: '#30D158' };
    if (pct <= 60) return { border: '#FF9F0A', value: '#FF9F0A' };
    return { border: '#FF453A', value: '#FF453A' };
  }

  const floodStyle = envColor(floodNum);
  const wetlandStyle = envColor(wetlandNum);
  const green = '#30D158';
  const defaultStyle = { border: green, value: 'rgba(255,255,255,0.85)' };

  const cards = [
    { label: 'Acreage', value: parcel.acreage != null ? `${parcel.acreage.toFixed(2)} ac` : '—', border: defaultStyle.border, valueColor: defaultStyle.value },
    { label: 'Owner', value: parcel.owner ?? '—', border: defaultStyle.border, valueColor: defaultStyle.value },
    { label: 'Flood coverage', value: flood, border: floodStyle.border, valueColor: floodStyle.value },
    { label: 'Wetland coverage', value: wetland, border: wetlandStyle.border, valueColor: wetlandStyle.value },
    { label: 'Soil types', value: row.soilTypeCount > 0 ? `${row.soilTypeCount} types` : '—', border: defaultStyle.border, valueColor: defaultStyle.value },
    { label: 'County', value: parcel.county ?? '—', border: defaultStyle.border, valueColor: defaultStyle.value },
    { label: 'APN', value: parcel.apn ?? '—', border: defaultStyle.border, valueColor: defaultStyle.value },
    { label: 'Added', value: new Date(parcel.created_at).toLocaleDateString(), border: defaultStyle.border, valueColor: defaultStyle.value },
  ];

  return (
    <div style={{ padding: '12px 20px 16px', borderTop: '1px solid rgba(255,255,255,0.06)' }}>
      <div className="grid grid-cols-2 sm:grid-cols-4" style={{ gap: 8 }}>
        {cards.map(c => (
          <DetailCard key={c.label} label={c.label} value={c.value} borderColor={c.border} valueColor={c.valueColor} />
        ))}
      </div>
    </div>
  );
}

// ─── Add Parcel Modal ─────────────────────────────────────────────────────────

type SearchMode = 'address' | 'apn' | 'owner' | 'gps';
type AddStep = { phase: 'idle' } | { phase: 'searching' } | { phase: 'results'; results: RegridResult[] } | { phase: 'creating' } | { phase: 'error'; message: string };

interface RegridResult {
  apn: string | null;
  owner: string | null;
  address: string | null;
  acreage: number | null;
  lat: number | null;
  lng: number | null;
  county: string | null;
  state: string | null;
  boundary: Record<string, unknown> | null;
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

function AddParcelModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (reportId: string) => void;
}) {
  const [mode, setMode] = useState<SearchMode>('address');
  const [step, setStep] = useState<AddStep>({ phase: 'idle' });

  // Address mode
  const [addressQuery, setAddressQuery] = useState('');
  // APN mode
  const [apnCountyDisplay, setApnCountyDisplay] = useState('');
  const [apnCounty, setApnCounty] = useState('');
  const [apnState, setApnState] = useState('');
  const [apnNumber, setApnNumber] = useState('');
  const apnNumberRef = useRef<HTMLInputElement>(null);
  // Owner mode
  const [ownerCountyDisplay, setOwnerCountyDisplay] = useState('');
  const [ownerCounty, setOwnerCounty] = useState('');
  const [ownerState, setOwnerState] = useState('');
  const [ownerName, setOwnerName] = useState('');
  const ownerNameRef = useRef<HTMLInputElement>(null);
  // GPS mode
  const [gpsRaw, setGpsRaw] = useState('');
  const [gpsLat, setGpsLat] = useState('');
  const [gpsLng, setGpsLng] = useState('');

  function parseGpsInput(raw: string): { lat: string; lng: string } | null {
    // Strip degree symbols, cardinal letters, and extra whitespace
    const cleaned = raw.replace(/[°'"]/g, ' ').replace(/[NSEW]/gi, ' ').replace(/\s+/g, ' ').trim();
    // Split on comma or whitespace
    const parts = cleaned.split(/[,\s]+/).filter(Boolean);
    if (parts.length < 2) return null;
    const lat = parseFloat(parts[0]);
    const lng = parseFloat(parts[1]);
    if (isNaN(lat) || isNaN(lng)) return null;
    return { lat: String(lat), lng: String(lng) };
  }

  function handleGpsRawChange(val: string) {
    setGpsRaw(val);
    const parsed = parseGpsInput(val);
    if (parsed) {
      setGpsLat(parsed.lat);
      setGpsLng(parsed.lng);
    } else {
      setGpsLat('');
      setGpsLng('');
    }
  }

  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setTimeout(() => inputRef.current?.focus(), 60);
  }, [mode]);

  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string;

  async function getAuthHeaders() {
    const { data: { session } } = await supabase.auth.getSession();
    return {
      Authorization: `Bearer ${session?.access_token ?? import.meta.env.VITE_SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json',
    };
  }

  async function handleAddressSearch(e: React.FormEvent) {
    e.preventDefault();
    if (!addressQuery.trim() || step.phase !== 'idle') return;
    setStep({ phase: 'searching' });
    try {
      const headers = await getAuthHeaders();
      const resp = await fetch(`${supabaseUrl}/functions/v1/lookup-parcel`, {
        method: 'POST', headers,
        body: JSON.stringify({ query: addressQuery.trim() }),
      });
      const result = await resp.json() as { report_id?: string; error?: string };
      if (!resp.ok) throw new Error(result.error ?? `Server error ${resp.status}`);
      onCreated(result.report_id!);
    } catch (e) {
      setStep({ phase: 'error', message: (e as Error).message });
    }
  }

  async function handleRegridSearch() {
    setStep({ phase: 'searching' });
    try {
      const headers = await getAuthHeaders();
      const body: Record<string, unknown> =
        mode === 'apn'
          ? { mode: 'apn', county: apnCounty, state: apnState, apn: apnNumber }
          : { mode: 'gps', lat: parseFloat(gpsLat), lng: parseFloat(gpsLng) };

      const resp = await fetch(`${supabaseUrl}/functions/v1/regrid-search`, {
        method: 'POST', headers,
        body: JSON.stringify(body),
      });
      const data = await resp.json() as { results?: RegridResult[]; error?: string };
      if (!resp.ok) throw new Error(data.error ?? `Server error ${resp.status}`);

      const results = data.results ?? [];
      if (results.length === 0) throw new Error('No parcels found matching your search.');

      // APN and GPS always return a single result — create directly
      await createFromRegrid(results[0]);
    } catch (e) {
      setStep({ phase: 'error', message: (e as Error).message });
    }
  }

  async function handleOwnerSearch() {
    setStep({ phase: 'searching' });
    try {
      // Fetch Regrid token from config
      const headers = await getAuthHeaders();
      const cfgResp = await fetch(`${supabaseUrl}/functions/v1/get-config`, { headers });
      const cfg = await cfgResp.json() as { regridToken?: string | null };
      const token = cfg.regridToken;
      if (!token) throw new Error('Regrid token not configured.');

      const stateAbbr = ownerState.toLowerCase();
      const countySlug = ownerCounty.toLowerCase().replace(/\s+county$/i, '').replace(/\s+/g, '-');
      const path = `/us/${stateAbbr}/${countySlug}`;

      const url =
        `https://app.regrid.com/api/v2/parcels/owner` +
        `?owner=${encodeURIComponent(ownerName.trim())}` +
        `&path=${encodeURIComponent(path)}` +
        `&limit=10` +
        `&token=${encodeURIComponent(token)}`;

      console.log('[owner-search] url:', url);
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`Regrid HTTP ${resp.status}`);
      const data = await resp.json() as { parcels?: { features?: unknown[] } };

      const features = data.parcels?.features ?? [];
      if (features.length === 0) throw new Error('No parcels found matching your search.');

      const results: RegridResult[] = (features as Array<{
        geometry?: { type: string; coordinates: unknown };
        properties?: {
          fields?: {
            owner?: string;
            address?: string;
            parcelnumb?: string;
            ll_gisacre?: number;
            lat?: string | number;
            lon?: string | number;
          };
          path?: string;
        };
      }>).map(f => {
        const fields = f.properties?.fields ?? {};
        const pathParts = (f.properties?.path ?? '').split('/').filter(Boolean);
        return {
          apn: fields.parcelnumb ?? null,
          owner: fields.owner ?? null,
          address: fields.address ?? null,
          acreage: fields.ll_gisacre ?? null,
          lat: fields.lat != null ? parseFloat(String(fields.lat)) : null,
          lng: fields.lon != null ? parseFloat(String(fields.lon)) : null,
          county: pathParts[2] ?? null,
          state: pathParts[1] ?? null,
          boundary: (f.geometry ?? null) as RegridResult['boundary'],
        };
      });

      setStep({ phase: 'results', results });
    } catch (e) {
      setStep({ phase: 'error', message: (e as Error).message });
    }
  }

  async function createFromRegrid(result: RegridResult) {
    setStep({ phase: 'creating' });
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      const boundary = result.boundary ?? (result.lat && result.lng ? {
        type: 'Polygon',
        coordinates: [[
          [result.lng - 0.001, result.lat - 0.001],
          [result.lng + 0.001, result.lat - 0.001],
          [result.lng + 0.001, result.lat + 0.001],
          [result.lng - 0.001, result.lat + 0.001],
          [result.lng - 0.001, result.lat - 0.001],
        ]],
      } : null);

      const { data: parcel, error: pe } = await supabase.from('parcels').insert({
        user_id: user.id,
        address: result.address,
        apn: result.apn,
        lat: result.lat,
        lng: result.lng,
        state: result.state,
        county: result.county?.replace(/ County$/i, ''),
        acreage: result.acreage,
        owner: result.owner,
        boundary_geojson: boundary,
      }).select().single();
      if (pe) throw new Error(pe.message);

      const { data: report, error: re } = await supabase.from('reports').insert({
        user_id: user.id,
        parcel_id: parcel.id,
        status: 'pending',
      }).select().single();
      if (re) throw new Error(re.message);

      onCreated(report.id);
    } catch (e) {
      setStep({ phase: 'error', message: (e as Error).message });
    }
  }

  const isRunning = step.phase === 'searching' || step.phase === 'creating';
  const modes: Array<{ id: SearchMode; label: string }> = [
    { id: 'address', label: 'Address' },
    { id: 'apn', label: 'Parcel # (APN)' },
    { id: 'owner', label: 'Owner' },
    { id: 'gps', label: 'GPS Coords' },
  ];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 backdrop-blur-sm"
      style={{ background: 'rgba(0,0,0,0.75)' }}
      onClick={(e) => { if (e.target === e.currentTarget && !isRunning) onClose(); }}
    >
      <div style={{
        background: '#141820',
        border: '1px solid rgba(255,255,255,0.12)',
        borderRadius: 16,
        width: '100%',
        maxWidth: 520,
        maxHeight: '85vh',
        overflowY: 'auto',
        padding: 24,
      }}>
        {/* Header */}
        <div className="flex items-center justify-between mb-5">
          <div>
            <h3 style={{ fontSize: 17, fontWeight: 700, color: '#fff', letterSpacing: '-0.2px' }}>Add New Parcel</h3>
            <p style={{ fontSize: 12, color: 'rgba(255,255,255,0.40)', marginTop: 3 }}>
              Search by address, parcel number, owner name, or GPS coordinates.
            </p>
          </div>
          <button
            onClick={() => { if (!isRunning) onClose(); }}
            style={{ color: 'rgba(255,255,255,0.35)', cursor: 'pointer', background: 'none', border: 'none', padding: 4 }}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Mode tabs */}
        <div className="flex gap-1.5 mb-5">
          {modes.map(m => (
            <button
              key={m.id}
              onClick={() => { if (!isRunning) { setMode(m.id); setStep({ phase: 'idle' }); } }}
              style={{
                flex: 1,
                padding: '7px 4px',
                borderRadius: 8,
                fontSize: 11,
                fontWeight: 600,
                border: '1px solid',
                borderColor: mode === m.id ? 'rgba(255,255,255,0.20)' : 'rgba(255,255,255,0.07)',
                background: mode === m.id ? 'rgba(255,255,255,0.10)' : 'transparent',
                color: mode === m.id ? '#fff' : 'rgba(255,255,255,0.40)',
                cursor: 'pointer',
                transition: 'all 0.15s',
                whiteSpace: 'nowrap',
              }}
            >
              {m.label}
            </button>
          ))}
        </div>

        {/* Address mode */}
        {mode === 'address' && (
          <form onSubmit={handleAddressSearch}>
            <label style={{ fontSize: 11, color: 'rgba(255,255,255,0.45)', display: 'block', marginBottom: 6, letterSpacing: '0.3px' }}>
              STREET ADDRESS
            </label>
            <div className="flex gap-2">
              <input
                ref={inputRef}
                type="text"
                value={addressQuery}
                onChange={e => {
                  const val = e.target.value;
                  // Auto-switch to GPS tab if coordinates are pasted
                  const parsed = parseGpsInput(val);
                  if (parsed) {
                    setMode('gps');
                    setGpsRaw(val);
                    setGpsLat(parsed.lat);
                    setGpsLng(parsed.lng);
                    setStep({ phase: 'idle' });
                    return;
                  }
                  setAddressQuery(val);
                  if (step.phase === 'error') setStep({ phase: 'idle' });
                }}
                style={{ ...INPUT_STYLE, flex: 1 }}
                placeholder="e.g. 1810 Terry Road, Durham, NC 27712"
                disabled={isRunning}
                autoComplete="off"
              />
              <button
                type="submit"
                disabled={!addressQuery.trim() || isRunning}
                style={{
                  background: '#30D158', color: '#000', border: 'none', borderRadius: 9,
                  padding: '10px 16px', fontWeight: 700, fontSize: 13, cursor: 'pointer',
                  display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0,
                  opacity: !addressQuery.trim() || isRunning ? 0.5 : 1,
                }}
              >
                {isRunning ? <Loader2 className="w-4 h-4 animate-spin" /> : <ArrowRight className="w-4 h-4" />}
                {isRunning ? 'Searching…' : 'Search'}
              </button>
            </div>
          </form>
        )}

        {/* APN mode */}
        {mode === 'apn' && (
          <div>
            <div className="mb-3">
              <label style={{ fontSize: 11, color: 'rgba(255,255,255,0.45)', display: 'block', marginBottom: 6, letterSpacing: '0.3px' }}>COUNTY, STATE</label>
              <CountyAutocomplete
                value={apnCountyDisplay}
                onChange={(display, county, state) => {
                  setApnCountyDisplay(display);
                  setApnCounty(county);
                  setApnState(state);
                }}
                disabled={isRunning}
                inputRef={inputRef}
                onConfirm={() => apnNumberRef.current?.focus()}
              />
            </div>
            <label style={{ fontSize: 11, color: 'rgba(255,255,255,0.45)', display: 'block', marginBottom: 6, letterSpacing: '0.3px' }}>PARCEL NUMBER (APN)</label>
            <div className="flex gap-2">
              <input ref={apnNumberRef} type="text" value={apnNumber} onChange={e => setApnNumber(e.target.value)}
                style={{ ...INPUT_STYLE, flex: 1 }} placeholder="e.g. 0861-04-58-1234" disabled={isRunning} />
              <button
                onClick={handleRegridSearch}
                disabled={!apnCounty.trim() || !apnState.trim() || !apnNumber.trim() || isRunning}
                style={{
                  background: '#30D158', color: '#000', border: 'none', borderRadius: 9,
                  padding: '10px 16px', fontWeight: 700, fontSize: 13, cursor: 'pointer',
                  display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0,
                  opacity: !apnCounty.trim() || !apnState.trim() || !apnNumber.trim() || isRunning ? 0.5 : 1,
                }}
              >
                {isRunning ? <Loader2 className="w-4 h-4 animate-spin" /> : <ArrowRight className="w-4 h-4" />}
                {isRunning ? 'Searching…' : 'Search'}
              </button>
            </div>
          </div>
        )}

        {/* Owner mode */}
        {mode === 'owner' && (
          <div>
            <div className="mb-3">
              <label style={{ fontSize: 11, color: 'rgba(255,255,255,0.45)', display: 'block', marginBottom: 6, letterSpacing: '0.3px' }}>COUNTY, STATE</label>
              <CountyAutocomplete
                value={ownerCountyDisplay}
                onChange={(display, county, state) => {
                  setOwnerCountyDisplay(display);
                  setOwnerCounty(county);
                  setOwnerState(state);
                }}
                disabled={isRunning}
                inputRef={inputRef}
                onConfirm={() => ownerNameRef.current?.focus()}
              />
            </div>
            <label style={{ fontSize: 11, color: 'rgba(255,255,255,0.45)', display: 'block', marginBottom: 6, letterSpacing: '0.3px' }}>OWNER NAME</label>
            <div className="flex gap-2">
              <input
                ref={ownerNameRef}
                type="text"
                value={ownerName}
                onChange={e => setOwnerName(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && ownerCounty.trim() && ownerName.trim().length >= 4 && !isRunning) handleOwnerSearch(); }}
                style={{ ...INPUT_STYLE, flex: 1 }}
                placeholder="e.g. COWAN, DAVID"
                disabled={isRunning}
              />
              <button
                onClick={handleOwnerSearch}
                disabled={!ownerCounty.trim() || ownerName.trim().length < 4 || isRunning}
                style={{
                  background: '#30D158', color: '#000', border: 'none', borderRadius: 9,
                  padding: '10px 16px', fontWeight: 700, fontSize: 13, cursor: 'pointer',
                  display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0,
                  opacity: !ownerCounty.trim() || ownerName.trim().length < 4 || isRunning ? 0.5 : 1,
                }}
              >
                {isRunning ? <Loader2 className="w-4 h-4 animate-spin" /> : <ArrowRight className="w-4 h-4" />}
                {isRunning ? 'Searching…' : 'Search'}
              </button>
            </div>
          </div>
        )}

        {/* GPS mode */}
        {mode === 'gps' && (
          <div>
            <div>
              <label style={{ fontSize: 11, color: 'rgba(255,255,255,0.45)', display: 'block', marginBottom: 6, letterSpacing: '0.3px' }}>GPS COORDINATES</label>
              <input
                ref={inputRef}
                type="text"
                value={gpsRaw}
                onChange={e => handleGpsRawChange(e.target.value)}
                style={INPUT_STYLE}
                placeholder="Paste coordinates, e.g. 36.1066, -78.9394"
                disabled={isRunning}
              />
              {gpsRaw.trim() !== '' && gpsLat && gpsLng && (
                <p style={{ fontSize: 11, color: 'rgba(255,255,255,0.35)', marginTop: 5 }}>
                  Lat: {gpsLat} &nbsp;·&nbsp; Lng: {gpsLng}
                </p>
              )}
              {gpsRaw.trim() !== '' && (!gpsLat || !gpsLng) && (
                <p style={{ fontSize: 11, color: 'rgba(239,68,68,0.7)', marginTop: 5 }}>
                  Could not parse coordinates. Try: 36.1066, -78.9394
                </p>
              )}
            </div>
            <button
              onClick={handleRegridSearch}
              disabled={!gpsLat.trim() || !gpsLng.trim() || isRunning}
              style={{
                background: '#30D158', color: '#000', border: 'none', borderRadius: 9,
                padding: '10px 18px', fontWeight: 700, fontSize: 13, cursor: 'pointer',
                display: 'flex', alignItems: 'center', gap: 6, marginTop: 12,
                opacity: !gpsLat.trim() || !gpsLng.trim() || isRunning ? 0.5 : 1,
              }}
            >
              {isRunning ? <Loader2 className="w-4 h-4 animate-spin" /> : <ArrowRight className="w-4 h-4" />}
              {isRunning ? 'Looking up…' : 'Look up parcel'}
            </button>
          </div>
        )}

        {/* Progress indicator */}
        {isRunning && (
          <div style={{ marginTop: 16, display: 'flex', alignItems: 'center', gap: 10 }}>
            <Loader2 className="w-4 h-4 animate-spin" style={{ color: '#30D158' }} />
            <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.50)' }}>
              {step.phase === 'creating' ? 'Creating parcel & report…' : 'Searching…'}
            </span>
          </div>
        )}

        {/* Error */}
        {step.phase === 'error' && (
          <div style={{ marginTop: 14, display: 'flex', alignItems: 'flex-start', gap: 10, padding: '10px 14px', background: 'rgba(255,69,58,0.08)', border: '1px solid rgba(255,69,58,0.35)', borderRadius: 8 }}>
            <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" style={{ color: '#FF453A' }} />
            <div>
              <p style={{ fontSize: 13, fontWeight: 600, color: '#FF453A', marginBottom: 2 }}>Search failed</p>
              <p style={{ fontSize: 12, color: 'rgba(255,255,255,0.55)' }}>{step.message}</p>
              <button
                onClick={() => setStep({ phase: 'idle' })}
                style={{ marginTop: 8, fontSize: 11, color: 'rgba(255,255,255,0.40)', cursor: 'pointer', background: 'none', border: 'none', padding: 0, textDecoration: 'underline' }}
              >
                Try again
              </button>
            </div>
          </div>
        )}

        {/* Owner search results picker */}
        {step.phase === 'results' && (
          <div style={{ marginTop: 14 }}>
            <p style={{ fontSize: 11, color: 'rgba(255,255,255,0.40)', marginBottom: 10, letterSpacing: '0.3px' }}>
              {step.results.length} parcel{step.results.length !== 1 ? 's' : ''} found — select one to add:
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 280, overflowY: 'auto' }}>
              {step.results.map((r, i) => (
                <div key={i} style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
                  padding: '10px 14px', borderRadius: 8,
                  border: '1px solid rgba(255,255,255,0.10)', background: 'rgba(255,255,255,0.03)',
                }}>
                  <div style={{ minWidth: 0 }}>
                    <p style={{ fontSize: 13, color: '#fff', fontWeight: 500, lineHeight: 1.3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {r.address ?? r.apn ?? 'Unknown'}
                    </p>
                    <p style={{ fontSize: 11, color: 'rgba(255,255,255,0.35)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {[r.owner, r.county, r.acreage != null ? `${r.acreage.toFixed(1)} ac` : null].filter(Boolean).join(' · ')}
                    </p>
                  </div>
                  <button
                    onClick={() => createFromRegrid(r)}
                    style={{
                      background: '#30D158', color: '#000', border: 'none', borderRadius: 7,
                      padding: '6px 14px', fontWeight: 700, fontSize: 12, cursor: 'pointer', flexShrink: 0,
                    }}
                  >
                    Select
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Main Dashboard ───────────────────────────────────────────────────────────

export default function Dashboard({ onViewReport, onCreateReport, onNavigateSettings }: DashboardProps) {
  const [rows, setRows] = useState<ParcelRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<FilterTab>('all');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showBulkDeleteModal, setShowBulkDeleteModal] = useState(false);
  const [bulkDeleteError, setBulkDeleteError] = useState<string | null>(null);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [showLimitModal, setShowLimitModal] = useState(false);
  const [showTrialLimitModal, setShowTrialLimitModal] = useState(false);
  const [userPlan, setUserPlan] = useState<PlanTier>('free');
  const [analysesUsed, setAnalysesUsed] = useState(0);
  const [planRenewalDate, setPlanRenewalDate] = useState<string | null>(null);

  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string;
  const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

  useEffect(() => { loadData(); loadUsage(); }, []);

  async function loadData() {
    setLoading(true);
    const [{ data: parcels }, { data: reports }, { data: soilResults }] = await Promise.all([
      supabase.from('parcels').select('*').order('created_at', { ascending: false }),
      supabase.from('reports').select('*').order('created_at', { ascending: false }),
      supabase.from('soil_results').select('report_id, map_unit_key'),
    ]);

    const reportByParcel = new Map<string, Report>();
    for (const r of (reports as Report[]) ?? []) {
      if (!reportByParcel.has(r.parcel_id)) reportByParcel.set(r.parcel_id, r);
    }

    const soilCountByReport = new Map<string, Set<string>>();
    for (const s of (soilResults ?? []) as { report_id: string; map_unit_key: string | null }[]) {
      if (!soilCountByReport.has(s.report_id)) soilCountByReport.set(s.report_id, new Set());
      if (s.map_unit_key) soilCountByReport.get(s.report_id)!.add(s.map_unit_key);
    }

    const built: ParcelRow[] = ((parcels as Parcel[]) ?? []).map(p => {
      const report = reportByParcel.get(p.id) ?? null;
      const soilTypeCount = report ? (soilCountByReport.get(report.id)?.size ?? 0) : 0;
      return { parcel: p, report, soilTypeCount };
    });

    setRows(built);
    setLoading(false);
  }

  async function loadUsage() {
    const { data } = await supabase
      .from('user_profiles')
      .select('plan, subscription_status, monthly_analyses_used, plan_renewal_date')
      .maybeSingle();
    if (data) {
      const plan = (data.plan ?? 'free') as PlanTier;
      setUserPlan(plan);
      setAnalysesUsed(data.monthly_analyses_used ?? 0);
      setPlanRenewalDate(data.plan_renewal_date ?? null);
    }
  }

  async function handleAddParcel() {
    const limit = PLAN_LIMITS[userPlan];
    if (limit !== null && analysesUsed >= limit) {
      setShowLimitModal(true);
      return;
    }
    // Call server-side increment before opening the modal — blocks if limit reached
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return;
    const resp = await fetch(`${supabaseUrl}/functions/v1/increment-analysis-count`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        apikey: supabaseAnonKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    if (resp.status === 403) {
      const body = await resp.json() as { reason?: string };
      if (body.reason === 'trial_limit') {
        setShowTrialLimitModal(true);
      } else {
        setShowLimitModal(true);
      }
      return;
    }
    if (resp.ok) {
      const result = await resp.json() as { monthly_analyses_used?: number };
      if (result.monthly_analyses_used !== undefined) {
        setAnalysesUsed(result.monthly_analyses_used);
      }
    }
    setShowModal(true);
  }

  function enterSelectionMode() {
    setSelectionMode(true);
    setSelectedIds(new Set());
    setBulkDeleteError(null);
  }

  function exitSelectionMode() {
    setSelectionMode(false);
    setSelectedIds(new Set());
    setBulkDeleteError(null);
  }

  function toggleSelect(id: string) {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleBulkDelete() {
    setBulkDeleting(true);
    setBulkDeleteError(null);
    try {
      const ids = Array.from(selectedIds);
      const { error } = await supabase.from('parcels').delete().in('id', ids);
      if (error) throw new Error(error.message);
      await loadData();
      setSelectedIds(new Set());
      setSelectionMode(false);
      setShowBulkDeleteModal(false);
    } catch (e) {
      setBulkDeleteError((e as Error).message);
    } finally {
      setBulkDeleting(false);
    }
  }

  function handleOpenMap(row: ParcelRow) {
    if (row.report) {
      onViewReport(row.report.id);
    } else {
      onCreateReport(row.parcel.id);
    }
  }

  // Filtered + searched rows
  const visible = rows.filter(row => {
    const q = search.toLowerCase();
    const matchesSearch = !q || [
      row.parcel.address, row.parcel.apn, row.parcel.owner, row.parcel.county,
    ].some(v => v?.toLowerCase().includes(q));

    if (!matchesSearch) return false;

    if (filter === 'all') return true;
    const cat = getCategory(getDisplayScore(row.report));
    return cat === filter;
  });

  // Stats
  const total = rows.length;
  const suitable = rows.filter(r => getCategory(getDisplayScore(r.report)) === 'suitable').length;
  const marginal = rows.filter(r => getCategory(getDisplayScore(r.report)) === 'marginal').length;
  const unsuitable = rows.filter(r => getCategory(getDisplayScore(r.report)) === 'unsuitable').length;

  const statCards = [
    { id: 'all' as FilterTab, label: 'Parcels', value: total, color: 'rgba(255,255,255,0.85)', border: 'rgba(255,255,255,0.80)' },
    { id: 'suitable' as FilterTab, label: 'Suitable', value: suitable, color: '#30D158', border: '#30D158' },
    { id: 'marginal' as FilterTab, label: 'Marginal', value: marginal, color: '#FF9F0A', border: '#FF9F0A' },
    { id: 'unsuitable' as FilterTab, label: 'Unsuitable', value: unsuitable, color: '#FF453A', border: '#FF453A' },
  ];

  const filterTabs: Array<{ id: FilterTab; label: string; tint: string; border: string; color: string }> = [
    { id: 'all', label: 'All', tint: 'rgba(255,255,255,0.07)', border: 'rgba(255,255,255,0.20)', color: 'rgba(255,255,255,0.85)' },
    { id: 'suitable', label: 'Suitable', tint: 'rgba(48,209,88,0.10)', border: 'rgba(48,209,88,0.40)', color: '#30D158' },
    { id: 'marginal', label: 'Marginal', tint: 'rgba(255,159,10,0.10)', border: 'rgba(255,159,10,0.40)', color: '#FF9F0A' },
    { id: 'unsuitable', label: 'Unsuitable', tint: 'rgba(255,69,58,0.10)', border: 'rgba(255,69,58,0.40)', color: '#FF453A' },
  ];

  const allVisibleSelected = visible.length > 0 && visible.every(r => selectedIds.has(r.parcel.id));
  const someVisibleSelected = visible.some(r => selectedIds.has(r.parcel.id));

  function toggleSelectAll() {
    if (allVisibleSelected) {
      setSelectedIds(prev => {
        const next = new Set(prev);
        visible.forEach(r => next.delete(r.parcel.id));
        return next;
      });
    } else {
      setSelectedIds(prev => {
        const next = new Set(prev);
        visible.forEach(r => next.add(r.parcel.id));
        return next;
      });
    }
  }

  // Score distribution
  const analyzed = rows.filter(r => r.report?.status === 'complete').length;

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto' }}>
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3 mb-6">
        <div>
          <h2 style={{ fontSize: 22, fontWeight: 700, color: '#fff', letterSpacing: '-0.3px', marginBottom: 4 }}>Dashboard</h2>
          <p style={{ fontSize: 13, color: 'rgba(255,255,255,0.40)' }}>Soil suitability across your land portfolio</p>
        </div>
        <button
          onClick={handleAddParcel}
          style={{
            background: '#30D158', color: '#000', border: 'none', borderRadius: 9,
            padding: '11px 18px', fontWeight: 700, fontSize: 13, cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7, flexShrink: 0,
            minHeight: 44,
          }}
        >
          <Plus className="w-4 h-4" />
          Add Parcel
        </button>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4" style={{ gap: 12, marginBottom: 16 }}>
        {statCards.map(card => {
          const isActive = filter === card.id;
          return (
            <button
              key={card.id}
              onClick={() => setFilter(card.id)}
              style={{
                background: 'rgba(255,255,255,0.03)',
                border: `1px solid ${isActive ? card.border : 'rgba(255,255,255,0.08)'}`,
                borderRadius: 12,
                padding: '16px 18px',
                textAlign: 'left',
                cursor: 'pointer',
                transition: 'all 0.2s',
                boxShadow: isActive ? `0 0 0 1px ${card.border}22` : 'none',
              }}
            >
              <p style={{ fontSize: 11, color: 'rgba(255,255,255,0.40)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 8 }}>
                {card.label}
              </p>
              <p style={{ fontSize: 28, fontWeight: 800, color: card.color, letterSpacing: '-1px', lineHeight: 1 }}>
                {loading ? '—' : card.value}
              </p>
            </button>
          );
        })}
      </div>

      {/* Score distribution bar */}
      {!loading && analyzed > 0 && (
        <div className="card p-4 mb-5">
          <div className="flex flex-col gap-2">
            <div style={{ height: 6, borderRadius: 3, background: 'rgba(255,255,255,0.06)', overflow: 'hidden', display: 'flex' }}>
              {suitable > 0 && <div style={{ height: '100%', width: `${(suitable / analyzed) * 100}%`, background: '#30D158', transition: 'width 0.7s' }} />}
              {marginal > 0 && <div style={{ height: '100%', width: `${(marginal / analyzed) * 100}%`, background: '#FF9F0A', transition: 'width 0.7s' }} />}
              {unsuitable > 0 && <div style={{ height: '100%', width: `${(unsuitable / analyzed) * 100}%`, background: '#FF453A', transition: 'width 0.7s' }} />}
            </div>
            <div className="flex flex-wrap items-center gap-3" style={{ fontSize: 11, color: 'rgba(255,255,255,0.45)' }}>
              <span className="flex items-center gap-1.5"><span style={{ width: 7, height: 7, borderRadius: '50%', background: '#30D158', display: 'inline-block' }} />Suitable {suitable}</span>
              <span className="flex items-center gap-1.5"><span style={{ width: 7, height: 7, borderRadius: '50%', background: '#FF9F0A', display: 'inline-block' }} />Marginal {marginal}</span>
              <span className="flex items-center gap-1.5"><span style={{ width: 7, height: 7, borderRadius: '50%', background: '#FF453A', display: 'inline-block' }} />Unsuitable {unsuitable}</span>
            </div>
          </div>
        </div>
      )}

      {/* Parcel list section */}
      <div className="card overflow-hidden">
        {/* Section header + search + filter tabs */}
        <div style={{ padding: '16px 20px 12px', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 mb-3">
            <div className="flex items-center gap-2 flex-shrink-0">
              {selectionMode && (
                <label
                  onClick={toggleSelectAll}
                  aria-label="Select all"
                  style={{
                    width: 20, height: 20, borderRadius: 6, flexShrink: 0, cursor: 'pointer',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    background: (allVisibleSelected || someVisibleSelected) ? '#34d399' : 'transparent',
                    border: `1.5px solid ${(allVisibleSelected || someVisibleSelected) ? '#34d399' : 'rgba(148,163,184,0.4)'}`,
                    transition: 'border-color 0.15s, background 0.15s',
                  }}
                >
                  {allVisibleSelected && (
                    <svg width="11" height="8" viewBox="0 0 11 8" fill="none">
                      <path d="M1 4L4 7L10 1" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                  )}
                  {someVisibleSelected && !allVisibleSelected && (
                    <svg width="10" height="2" viewBox="0 0 10 2" fill="none">
                      <path d="M1 1H9" stroke="white" strokeWidth="1.8" strokeLinecap="round"/>
                    </svg>
                  )}
                </label>
              )}
              <h3 style={{ fontSize: 14, fontWeight: 600, color: '#fff' }}>All parcels</h3>
              <span style={{
                fontSize: 11, fontWeight: 600, color: 'rgba(255,255,255,0.45)',
                background: 'rgba(255,255,255,0.08)', borderRadius: 20,
                padding: '2px 8px',
              }}>
                {loading ? '…' : `${visible.length} parcel${visible.length !== 1 ? 's' : ''}`}
              </span>
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              {selectionMode ? (
                <>
                  <button
                    onClick={() => setShowBulkDeleteModal(true)}
                    disabled={selectedIds.size === 0}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 6,
                      padding: '6px 12px', borderRadius: 8, fontSize: 12, fontWeight: 600,
                      background: selectedIds.size > 0 ? 'rgba(255,69,58,0.18)' : 'rgba(255,255,255,0.04)',
                      border: `1px solid ${selectedIds.size > 0 ? 'rgba(255,69,58,0.55)' : 'rgba(255,255,255,0.08)'}`,
                      color: selectedIds.size > 0 ? '#FF453A' : 'rgba(255,255,255,0.25)',
                      cursor: selectedIds.size > 0 ? 'pointer' : 'default',
                    }}
                  >
                    <Trash2 style={{ width: 13, height: 13 }} />
                    {selectedIds.size > 0 ? `Delete ${selectedIds.size} parcel${selectedIds.size !== 1 ? 's' : ''}` : 'Delete selected'}
                  </button>
                  <button
                    onClick={exitSelectionMode}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 5,
                      padding: '6px 12px', borderRadius: 8, fontSize: 12, fontWeight: 600,
                      background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.10)',
                      color: 'rgba(255,255,255,0.55)', cursor: 'pointer',
                    }}
                  >
                    <X style={{ width: 13, height: 13 }} />
                    Cancel
                  </button>
                </>
              ) : (
                <button
                  onClick={enterSelectionMode}
                  style={{
                    padding: '6px 12px', borderRadius: 8, fontSize: 12, fontWeight: 600,
                    background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.10)',
                    color: 'rgba(255,255,255,0.55)', cursor: 'pointer',
                  }}
                >
                  Manage
                </button>
              )}
            </div>
            {/* Search */}
            <div style={{ position: 'relative', width: '100%', maxWidth: 280 }}>
              <Search style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', width: 14, height: 14, color: 'rgba(255,255,255,0.30)' }} />
              <input
                type="text"
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search address, APN, owner…"
                style={{
                  ...INPUT_STYLE,
                  paddingLeft: 32,
                  fontSize: 12,
                  height: 34,
                  padding: '0 12px 0 32px',
                }}
              />
            </div>
          </div>
          {/* Filter tabs */}
          <div className="flex gap-1.5">
            {filterTabs.map(tab => {
              const isActive = filter === tab.id;
              return (
                <button
                  key={tab.id}
                  onClick={() => setFilter(tab.id)}
                  style={{
                    padding: '4px 12px', borderRadius: 20, fontSize: 11, fontWeight: 600,
                    border: `1px solid ${isActive ? tab.border : 'rgba(255,255,255,0.08)'}`,
                    background: isActive ? tab.tint : 'transparent',
                    color: isActive ? tab.color : 'rgba(255,255,255,0.40)',
                    cursor: 'pointer', transition: 'all 0.15s',
                  }}
                >
                  {tab.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Rows */}
        {loading ? (
          <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 10 }}>
            {[1, 2, 3].map(i => <div key={i} style={{ height: 64, background: 'rgba(255,255,255,0.04)', borderRadius: 8, animation: 'pulse 1.5s infinite' }} />)}
          </div>
        ) : visible.length === 0 ? (
          <div style={{ padding: '60px 20px', textAlign: 'center' }}>
            <p style={{ fontSize: 14, color: 'rgba(255,255,255,0.30)', marginBottom: 8 }}>
              {search || filter !== 'all' ? 'No parcels match your search.' : 'No parcels yet.'}
            </p>
            {!search && filter === 'all' && (
              <button
                onClick={handleAddParcel}
                style={{
                  background: '#30D158', color: '#000', border: 'none', borderRadius: 9,
                  padding: '10px 18px', fontWeight: 700, fontSize: 13, cursor: 'pointer',
                  display: 'inline-flex', alignItems: 'center', gap: 7,
                }}
              >
                <Plus className="w-4 h-4" />
                Add your first parcel
              </button>
            )}
          </div>
        ) : (
          <div>
            {visible.map(row => {
              const { parcel, report } = row;
              const zoneScore = getDisplayScore(report);
              const overallScore = getOverallScore(report);
              const cat = getCategory(zoneScore);
              const dotColor = CAT_COLOR[cat];
              const isExpanded = expandedId === parcel.id;
              const isSelected = selectedIds.has(parcel.id);

              return (
                <div
                  key={parcel.id}
                  style={{
                    borderBottom: '1px solid rgba(255,255,255,0.05)',
                    borderLeft: `2px solid ${isSelected ? '#30D158' : 'transparent'}`,
                    background: isSelected ? 'rgba(48,209,88,0.05)' : 'transparent',
                    transition: 'background 0.15s',
                  }}
                >
                  {/* Main row */}
                  <div
                    style={{ display: 'flex', alignItems: 'center', gap: 14, padding: selectionMode ? '14px 20px 14px 13px' : '14px 20px', cursor: 'pointer' }}
                    onClick={() => {
                      if (selectionMode) { toggleSelect(parcel.id); return; }
                      setExpandedId(isExpanded ? null : parcel.id);
                    }}
                  >
                    {/* Per-row selection checkbox — left edge, only in selection mode */}
                    {selectionMode && (
                      <label
                        onClick={e => { e.stopPropagation(); toggleSelect(parcel.id); }}
                        aria-label={`Select ${parcel.address ?? parcel.apn ?? 'parcel'}`}
                        style={{
                          width: 20, height: 20, borderRadius: 6, flexShrink: 0, cursor: 'pointer',
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          background: isSelected ? '#34d399' : 'transparent',
                          border: `1.5px solid ${isSelected ? '#34d399' : 'rgba(148,163,184,0.4)'}`,
                          transition: 'border-color 0.15s, background 0.15s',
                        }}
                        onMouseEnter={e => { if (!isSelected) (e.currentTarget as HTMLElement).style.borderColor = 'rgba(148,163,184,0.65)'; }}
                        onMouseLeave={e => { if (!isSelected) (e.currentTarget as HTMLElement).style.borderColor = 'rgba(148,163,184,0.4)'; }}
                      >
                        {isSelected && (
                          <svg width="11" height="8" viewBox="0 0 11 8" fill="none">
                            <path d="M1 4L4 7L10 1" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
                          </svg>
                        )}
                      </label>
                    )}
                    {/* Dot */}
                    <div style={{ width: 8, height: 8, borderRadius: '50%', background: dotColor, flexShrink: 0, boxShadow: `0 0 6px ${dotColor}80` }} />

                    {/* Address + meta */}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <p style={{ fontSize: 13, fontWeight: 600, color: 'rgba(255,255,255,0.90)', lineHeight: 1.3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {parcel.address ?? parcel.apn ?? 'Unknown parcel'}
                      </p>
                      <p style={{ fontSize: 11, color: 'rgba(255,255,255,0.35)', marginTop: 2, lineHeight: 1.3 }}>
                        {[
                          parcel.acreage != null ? `${parcel.acreage.toFixed(1)} ac` : null,
                          parcel.county ? `${parcel.county} Co.` : null,
                          parcel.owner,
                          new Date(parcel.created_at).toLocaleDateString(),
                        ].filter(Boolean).join(' · ')}
                      </p>
                    </div>

                    {/* Scores */}
                    <div className="hidden sm:flex items-center gap-5 flex-shrink-0">
                      <ScoreBadge score={zoneScore} label="Best Zone" />
                      <ScoreBadge score={overallScore} label="Overall" />
                    </div>

                    {/* Action buttons */}
                    <div className="hidden sm:flex items-center gap-2 flex-shrink-0" onClick={e => e.stopPropagation()}>
                      <button
                        onClick={() => handleOpenMap(row)}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 5,
                          background: 'rgba(48,209,88,0.12)',
                          border: '1px solid rgba(48,209,88,0.5)',
                          borderRadius: 7, padding: '6px 12px',
                          color: '#30D158', fontSize: 12, fontWeight: 600, cursor: 'pointer',
                        }}
                      >
                        <MapIcon className="w-3.5 h-3.5" />
                        Open map
                      </button>
                    </div>

                    {/* Expand chevron */}
                    <div style={{ color: 'rgba(255,255,255,0.25)', flexShrink: 0 }}>
                      {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                    </div>
                  </div>

                  {/* Mobile scores + action — shown inline below address on small screens */}
                  {isExpanded && (
                    <div className="flex sm:hidden items-center justify-between px-5 pb-3 gap-3" onClick={e => e.stopPropagation()}>
                      <div className="flex items-center gap-4">
                        <ScoreBadge score={zoneScore} label="Best Zone" />
                        <ScoreBadge score={overallScore} label="Overall" />
                      </div>
                      <button
                        onClick={() => handleOpenMap(row)}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 5,
                          background: 'rgba(48,209,88,0.12)',
                          border: '1px solid rgba(48,209,88,0.5)',
                          borderRadius: 7, padding: '8px 14px',
                          color: '#30D158', fontSize: 13, fontWeight: 600, cursor: 'pointer',
                          minHeight: 44,
                        }}
                      >
                        <MapIcon className="w-3.5 h-3.5" />
                        Open map
                      </button>
                    </div>
                  )}

                  {/* Expanded detail */}
                  {isExpanded && <ExpandedDetail row={row} />}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Add Parcel Modal */}
      {showModal && (
        <AddParcelModal
          onClose={() => setShowModal(false)}
          onCreated={async (reportId) => {
            setShowModal(false);
            loadData();
            onViewReport(reportId);
          }}
        />
      )}

      {/* Bulk delete confirmation modal */}
      {showBulkDeleteModal && (
        <div
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.70)', backdropFilter: 'blur(6px)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 20,
          }}
          onClick={() => { if (!bulkDeleting) { setShowBulkDeleteModal(false); setBulkDeleteError(null); } }}
        >
          <div
            style={{
              background: 'rgb(13,17,26)', border: '1px solid rgba(255,255,255,0.10)', borderRadius: 16,
              padding: 32, maxWidth: 400, width: '100%', textAlign: 'center',
            }}
            onClick={e => e.stopPropagation()}
          >
            <div style={{ width: 48, height: 48, borderRadius: 12, background: 'rgba(255,69,58,0.12)', border: '1px solid rgba(255,69,58,0.30)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px' }}>
              <Trash2 style={{ width: 20, height: 20, color: '#FF453A' }} />
            </div>
            <h3 style={{ fontSize: 17, fontWeight: 700, color: '#fff', marginBottom: 8 }}>
              Delete {selectedIds.size} parcel{selectedIds.size !== 1 ? 's' : ''}?
            </h3>
            <p style={{ fontSize: 13, color: 'rgba(255,255,255,0.45)', lineHeight: 1.6, marginBottom: 20 }}>
              This will also delete all associated reports and soil data. This cannot be undone.
            </p>
            {bulkDeleteError && (
              <div style={{ marginBottom: 16, padding: '10px 14px', borderRadius: 8, background: 'rgba(255,69,58,0.10)', border: '1px solid rgba(255,69,58,0.30)', display: 'flex', alignItems: 'flex-start', gap: 8, textAlign: 'left' }}>
                <AlertCircle style={{ width: 14, height: 14, color: '#FF453A', marginTop: 1, flexShrink: 0 }} />
                <p style={{ fontSize: 12, color: '#FF453A' }}>{bulkDeleteError}</p>
              </div>
            )}
            <div style={{ display: 'flex', gap: 10 }}>
              <button
                onClick={() => { setShowBulkDeleteModal(false); setBulkDeleteError(null); }}
                disabled={bulkDeleting}
                style={{ flex: 1, padding: '10px 0', borderRadius: 10, background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.10)', color: 'rgba(255,255,255,0.55)', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}
              >
                Cancel
              </button>
              <button
                onClick={handleBulkDelete}
                disabled={bulkDeleting}
                style={{ flex: 1, padding: '10px 0', borderRadius: 10, background: 'rgba(255,69,58,0.85)', border: 'none', color: '#fff', fontSize: 13, fontWeight: 700, cursor: bulkDeleting ? 'default' : 'pointer', opacity: bulkDeleting ? 0.7 : 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
              >
                {bulkDeleting && <Loader2 style={{ width: 14, height: 14, animation: 'spin 1s linear infinite' }} />}
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Usage limit modal */}
      {showLimitModal && (
        <div
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.65)', backdropFilter: 'blur(6px)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 20,
          }}
          onClick={() => setShowLimitModal(false)}
        >
          <div
            style={{
              background: 'rgb(13,17,26)', border: '1px solid rgba(255,255,255,0.10)', borderRadius: 16,
              padding: 32, maxWidth: 420, width: '100%', textAlign: 'center',
            }}
            onClick={e => e.stopPropagation()}
          >
            <div style={{ width: 52, height: 52, borderRadius: 14, background: 'rgba(34,197,94,0.12)', border: '1px solid rgba(34,197,94,0.30)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 18px' }}>
              <Zap style={{ width: 22, height: 22, color: '#22C55E' }} />
            </div>
            <h3 style={{ fontSize: 18, fontWeight: 700, color: '#fff', marginBottom: 8 }}>
              Monthly limit reached
            </h3>
            <p style={{ fontSize: 14, color: 'rgba(255,255,255,0.45)', lineHeight: 1.6, marginBottom: 24 }}>
              {`You've used all ${PLAN_LIMITS[userPlan] ?? '∞'} analyses for this month. Upgrade for a higher limit.`}
            </p>
            <div style={{ display: 'flex', gap: 10 }}>
              <button
                onClick={() => setShowLimitModal(false)}
                style={{ flex: 1, padding: '10px 0', borderRadius: 10, background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.10)', color: 'rgba(255,255,255,0.55)', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}
              >
                Cancel
              </button>
              <button
                onClick={() => { setShowLimitModal(false); onNavigateSettings?.(); }}
                style={{ flex: 2, padding: '10px 0', borderRadius: 10, background: '#22C55E', border: 'none', color: '#000', fontSize: 13, fontWeight: 700, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
              >
                <Zap style={{ width: 14, height: 14 }} />
                Upgrade Plan
                <ArrowRight style={{ width: 14, height: 14 }} />
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Trial analysis limit modal */}
      {showTrialLimitModal && (
        <div
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.65)', backdropFilter: 'blur(6px)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 20,
          }}
          onClick={() => setShowTrialLimitModal(false)}
        >
          <div
            style={{
              background: 'rgb(13,17,26)', border: '1px solid rgba(255,255,255,0.10)', borderRadius: 16,
              padding: 32, maxWidth: 440, width: '100%', textAlign: 'center',
            }}
            onClick={e => e.stopPropagation()}
          >
            <div style={{ width: 52, height: 52, borderRadius: 14, background: 'rgba(34,197,94,0.12)', border: '1px solid rgba(34,197,94,0.30)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 18px' }}>
              <Zap style={{ width: 22, height: 22, color: '#22C55E' }} />
            </div>
            <h3 style={{ fontSize: 18, fontWeight: 700, color: '#fff', marginBottom: 8 }}>
              Trial analysis limit reached
            </h3>
            <p style={{ fontSize: 14, color: 'rgba(255,255,255,0.45)', lineHeight: 1.6, marginBottom: 24 }}>
              {planRenewalDate
                ? `You've used all 3 trial analyses. Your full plan unlocks when your trial converts on ${new Date(planRenewalDate).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })} — or upgrade now to start immediately.`
                : `You've used all 3 trial analyses. Upgrade now to unlock your full plan immediately.`}
            </p>
            <div style={{ display: 'flex', gap: 10 }}>
              <button
                onClick={() => setShowTrialLimitModal(false)}
                style={{ flex: 1, padding: '10px 0', borderRadius: 10, background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.10)', color: 'rgba(255,255,255,0.55)', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}
              >
                Cancel
              </button>
              <button
                onClick={() => { setShowTrialLimitModal(false); onNavigateSettings?.(); }}
                style={{ flex: 2, padding: '10px 0', borderRadius: 10, background: '#22C55E', border: 'none', color: '#000', fontSize: 13, fontWeight: 700, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
              >
                <Zap style={{ width: 14, height: 14 }} />
                Upgrade Now
                <ArrowRight style={{ width: 14, height: 14 }} />
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
