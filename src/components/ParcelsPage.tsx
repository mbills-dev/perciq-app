import { useEffect, useState, useRef } from 'react';
import { supabase } from '../lib/supabase';
import type { Parcel } from '../types/database';
import {
  Plus, MapPin, Search, Trash2, FileText,
  AlertCircle, X, ArrowRight, Loader2, CheckCircle2, Pencil,
} from 'lucide-react';

interface ParcelsPageProps {
  onCreateReport: (reportId: string) => void;
  onViewParcel: (parcelId: string) => void;
}

type AddStep =
  | { phase: 'idle' }
  | { phase: 'geocoding' }
  | { phase: 'boundary' }
  | { phase: 'saving' }
  | { phase: 'error'; message: string };

interface LookupResult {
  parcel_id: string;
  report_id: string;
  address: string;
  lat: number;
  lng: number;
  state: string | null;
  county: string | null;
  apn: string | null;
  acreage: number | null;
  owner: string | null;
  has_boundary: boolean;
}

export default function ParcelsPage({ onCreateReport, onViewParcel }: ParcelsPageProps) {
  const [parcels, setParcels] = useState<Parcel[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [tableSearch, setTableSearch] = useState('');
  const [query, setQuery] = useState('');
  const [step, setStep] = useState<AddStep>({ phase: 'idle' });
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [editId, setEditId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { loadParcels(); }, []);

  useEffect(() => {
    if (showModal) {
      setQuery('');
      setStep({ phase: 'idle' });
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [showModal]);

  async function loadParcels() {
    setLoading(true);
    const { data } = await supabase
      .from('parcels')
      .select('*')
      .order('created_at', { ascending: false });
    setParcels((data as Parcel[]) ?? []);
    setLoading(false);
  }

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    if (!query.trim() || step.phase !== 'idle') return;

    setStep({ phase: 'geocoding' });

    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('Not authenticated');

      // Geocode step visible to user
      const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string;
      const headers = {
        'Authorization': `Bearer ${session.access_token}`,
        'Content-Type': 'application/json',
      };

      setStep({ phase: 'boundary' });

      const resp = await fetch(`${supabaseUrl}/functions/v1/lookup-parcel`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ query: query.trim() }),
      });

      const result = await resp.json() as LookupResult & { error?: string };

      if (!resp.ok) {
        throw new Error(result.error ?? `Server error ${resp.status}`);
      }

      setStep({ phase: 'saving' });

      await loadParcels();
      setShowModal(false);
      onCreateReport(result.report_id);
    } catch (e) {
      setStep({ phase: 'error', message: (e as Error).message });
    }
  }

  async function handleDelete(parcelId: string) {
    await supabase.from('parcels').delete().eq('id', parcelId);
    setParcels((prev) => prev.filter((p) => p.id !== parcelId));
    setDeleteId(null);
    setEditId(null);
  }

  const filtered = parcels.filter((p) => {
    const q = tableSearch.toLowerCase();
    return (
      p.address?.toLowerCase().includes(q) ||
      p.apn?.toLowerCase().includes(q) ||
      p.owner?.toLowerCase().includes(q) ||
      p.county?.toLowerCase().includes(q) ||
      p.state?.toLowerCase().includes(q)
    );
  });

  const isRunning = step.phase === 'geocoding' || step.phase === 'boundary' || step.phase === 'saving';

  const stepLabel: Record<string, string> = {
    geocoding: 'Looking up address...',
    boundary: 'Fetching parcel boundary...',
    saving: 'Creating report...',
  };

  return (
    <div className="space-y-6 max-w-5xl">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold mb-1">Parcels</h2>
          <p className="text-white/40 text-sm">Manage land parcels for soil analysis.</p>
        </div>
        <button
          onClick={() => setShowModal(true)}
          className="btn-primary flex items-center gap-2"
        >
          <Plus className="w-4 h-4" />
          Add Parcel
        </button>
      </div>

      {/* Table search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/30" />
        <input
          type="text"
          value={tableSearch}
          onChange={(e) => setTableSearch(e.target.value)}
          className="input pl-9 max-w-sm"
          placeholder="Search by address, APN, county..."
        />
      </div>

      {/* Parcels table */}
      <div className="card overflow-hidden">
        {loading ? (
          <div className="p-5 space-y-3">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-16 bg-white/5 rounded-lg animate-pulse" />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-center px-6">
            <div className="w-12 h-12 bg-white/5 rounded-xl flex items-center justify-center mb-4">
              <MapPin className="w-6 h-6 text-white/20" />
            </div>
            <p className="text-white/40 text-sm mb-1">
              {tableSearch ? 'No parcels match your search.' : 'No parcels yet.'}
            </p>
            {!tableSearch && (
              <p className="text-white/25 text-xs">Add a parcel to begin soil analysis.</p>
            )}
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-white/5">
                <th className="text-left px-5 py-3 text-xs font-medium text-white/40 uppercase tracking-wide">Address / APN</th>
                <th className="text-left px-5 py-3 text-xs font-medium text-white/40 uppercase tracking-wide hidden md:table-cell">Location</th>
                <th className="text-left px-5 py-3 text-xs font-medium text-white/40 uppercase tracking-wide hidden lg:table-cell">Owner</th>
                <th className="text-left px-5 py-3 text-xs font-medium text-white/40 uppercase tracking-wide hidden lg:table-cell">Acreage</th>
                <th className="px-5 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {filtered.map((parcel) => (
                <tr key={parcel.id} className="hover:bg-white/3 transition-colors">
                  <td className="px-5 py-4">
                    <p className="font-medium text-white">
                      {parcel.address ?? <span className="text-white/30 italic">No address</span>}
                    </p>
                    {parcel.apn && (
                      <p className="text-xs text-white/40 mt-0.5">APN: {parcel.apn}</p>
                    )}
                  </td>
                  <td className="px-5 py-4 hidden md:table-cell">
                    <p className="text-white/70">
                      {[parcel.county, parcel.state].filter(Boolean).join(', ') || (
                        <span className="text-white/30 italic">Unknown</span>
                      )}
                    </p>
                  </td>
                  <td className="px-5 py-4 hidden lg:table-cell">
                    <p className="text-white/60 text-xs">
                      {parcel.owner ?? <span className="text-white/20">—</span>}
                    </p>
                  </td>
                  <td className="px-5 py-4 hidden lg:table-cell">
                    <p className="text-white/70">
                      {parcel.acreage != null
                        ? `${parcel.acreage.toFixed(2)} ac`
                        : <span className="text-white/30">—</span>}
                    </p>
                  </td>
                  <td className="px-5 py-4">
                    <div className="flex items-center gap-2 justify-end">
                      {editId === parcel.id ? (
                        <>
                          <button
                            onClick={() => setDeleteId(parcel.id)}
                            className="flex items-center gap-1.5 text-xs text-danger-400 hover:text-danger-300 font-medium transition-colors"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                            <span className="hidden sm:inline">Delete</span>
                          </button>
                          <button
                            onClick={() => setEditId(null)}
                            className="text-white/30 hover:text-white transition-colors p-1"
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            onClick={() => onViewParcel(parcel.id)}
                            className="flex items-center gap-1.5 text-xs text-primary-400 hover:text-primary-300 font-medium transition-colors"
                          >
                            <FileText className="w-3.5 h-3.5" />
                            <span className="hidden sm:inline">View</span>
                          </button>
                          <button
                            onClick={() => setEditId(parcel.id)}
                            className="text-white/20 hover:text-white/60 transition-colors p-1"
                          >
                            <Pencil className="w-3.5 h-3.5" />
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Add Parcel Modal — single search input */}
      {showModal && (
        <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4 backdrop-blur-sm">
          <div className="card w-full max-w-lg p-6">
            <div className="flex items-center justify-between mb-6">
              <div>
                <h3 className="font-semibold text-lg">Add New Parcel</h3>
                <p className="text-sm text-white/40 mt-0.5">
                  Enter an address — we'll find the boundary and run the analysis automatically.
                </p>
              </div>
              <button
                onClick={() => { if (!isRunning) setShowModal(false); }}
                className="text-white/30 hover:text-white transition-colors"
                disabled={isRunning}
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSearch}>
              <div className="relative">
                <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-white/30" />
                <input
                  ref={inputRef}
                  type="text"
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    if (step.phase === 'error') setStep({ phase: 'idle' });
                  }}
                  className="input pl-10 pr-24 text-base py-3"
                  placeholder="123 Rural Route, Chatham County, NC"
                  disabled={isRunning}
                  autoComplete="off"
                />
                <button
                  type="submit"
                  disabled={!query.trim() || isRunning}
                  className="absolute right-2 top-1/2 -translate-y-1/2 btn-primary text-sm py-1.5 px-3 flex items-center gap-1.5 disabled:opacity-40"
                >
                  {isRunning ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <ArrowRight className="w-3.5 h-3.5" />
                  )}
                  {isRunning ? 'Working' : 'Search'}
                </button>
              </div>
            </form>

            {/* Progress steps */}
            {isRunning && (
              <div className="mt-5 space-y-2">
                {(
                  [
                    { key: 'geocoding', label: 'Looking up address' },
                    { key: 'boundary', label: 'Fetching parcel boundary from Regrid' },
                    { key: 'saving', label: 'Creating parcel & report' },
                  ] as const
                ).map(({ key, label }) => {
                  const phases = ['geocoding', 'boundary', 'saving'];
                  const currentIdx = phases.indexOf(step.phase);
                  const thisIdx = phases.indexOf(key);
                  const isDone = currentIdx > thisIdx;
                  const isActive = step.phase === key;

                  return (
                    <div key={key} className="flex items-center gap-3">
                      <div className={`w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0 transition-colors ${
                        isDone
                          ? 'bg-primary-500/20'
                          : isActive
                          ? 'bg-amber-500/20'
                          : 'bg-white/5'
                      }`}>
                        {isDone ? (
                          <CheckCircle2 className="w-3 h-3 text-primary-400" />
                        ) : isActive ? (
                          <Loader2 className="w-3 h-3 text-amber-400 animate-spin" />
                        ) : (
                          <div className="w-1.5 h-1.5 rounded-full bg-white/20" />
                        )}
                      </div>
                      <span className={`text-sm ${
                        isDone
                          ? 'text-white/50 line-through decoration-white/20'
                          : isActive
                          ? 'text-white'
                          : 'text-white/25'
                      }`}>
                        {label}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Error */}
            {step.phase === 'error' && (
              <div className="mt-4 flex items-start gap-2.5 bg-danger-500/10 border border-danger-500/30 rounded-lg p-3">
                <AlertCircle className="w-4 h-4 text-danger-400 mt-0.5 flex-shrink-0" />
                <div>
                  <p className="text-sm text-danger-400 font-medium">Something went wrong</p>
                  <p className="text-xs text-danger-400/70 mt-0.5">{step.message}</p>
                </div>
              </div>
            )}

            {/* Hint */}
            {step.phase === 'idle' && (
              <p className="mt-3 text-xs text-white/25">
                Try: "455 Dillard Rd, Macon County, NC" or an APN like "7612-00-3829"
              </p>
            )}
          </div>
        </div>
      )}

      {/* Delete confirm */}
      {deleteId && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
          <div className="card w-full max-w-sm p-6 text-center">
            <div className="w-12 h-12 bg-danger-500/10 rounded-xl flex items-center justify-center mx-auto mb-4">
              <Trash2 className="w-6 h-6 text-danger-400" />
            </div>
            <h3 className="font-semibold mb-2">Delete Parcel?</h3>
            <p className="text-white/40 text-sm mb-5">
              This will also delete all associated reports and soil data. This cannot be undone.
            </p>
            <div className="flex gap-3">
              <button onClick={() => setDeleteId(null)} className="btn-ghost flex-1">Cancel</button>
              <button
                onClick={() => handleDelete(deleteId)}
                className="flex-1 bg-danger-500 hover:bg-danger-600 text-white font-medium px-4 py-2 rounded-lg transition-colors"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
