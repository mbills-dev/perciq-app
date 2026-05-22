import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import type { Report } from '../types/database';
import { FileText, Search, CheckCircle, Clock, XCircle, AlertTriangle, ChevronRight } from 'lucide-react';

interface ReportsPageProps {
  onViewReport: (reportId: string) => void;
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; cls: string; icon: React.ReactNode }> = {
    complete: {
      label: 'Complete',
      cls: 'badge-pass',
      icon: <CheckCircle className="w-3 h-3" />,
    },
    processing: {
      label: 'Processing',
      cls: 'badge-marginal',
      icon: <Clock className="w-3 h-3 animate-pulse" />,
    },
    failed: {
      label: 'Failed',
      cls: 'badge-fail',
      icon: <XCircle className="w-3 h-3" />,
    },
    pending: {
      label: 'Pending',
      cls: 'badge-pending',
      icon: <Clock className="w-3 h-3" />,
    },
  };
  const { label, cls, icon } = map[status] ?? map.pending;
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border ${cls}`}>
      {icon}
      {label}
    </span>
  );
}

function ScorePill({ score, label }: { score: number | null; label: string }) {
  if (score === null) return <span className="text-white/25 text-xs">—</span>;
  const cls = score >= 70 ? 'badge-pass' : score >= 40 ? 'badge-marginal' : 'badge-fail';
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-bold border ${cls}`}>
      {score} <span className="ml-1 font-normal opacity-70">{label}</span>
    </span>
  );
}

export default function ReportsPage({ onViewReport }: ReportsPageProps) {
  const [reports, setReports] = useState<Report[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<'all' | 'complete' | 'pending' | 'processing' | 'failed'>('all');

  useEffect(() => {
    async function load() {
      const { data } = await supabase
        .from('reports')
        .select('*, parcels(*)')
        .order('created_at', { ascending: false });
      setReports((data as Report[]) ?? []);
      setLoading(false);
    }
    load();
  }, []);

  const filtered = reports.filter((r) => {
    const q = search.toLowerCase();
    const matchSearch =
      r.parcels?.address?.toLowerCase().includes(q) ||
      r.parcels?.apn?.toLowerCase().includes(q) ||
      r.parcels?.county?.toLowerCase().includes(q) ||
      r.parcels?.state?.toLowerCase().includes(q);
    const matchFilter = filter === 'all' || r.status === filter;
    return matchSearch && matchFilter;
  });

  const filterTabs = [
    { id: 'all', label: 'All', count: reports.length },
    { id: 'complete', label: 'Complete', count: reports.filter((r) => r.status === 'complete').length },
    { id: 'pending', label: 'Pending', count: reports.filter((r) => r.status === 'pending').length },
    { id: 'processing', label: 'Processing', count: reports.filter((r) => r.status === 'processing').length },
    { id: 'failed', label: 'Failed', count: reports.filter((r) => r.status === 'failed').length },
  ] as const;

  return (
    <div className="space-y-6 max-w-5xl">
      <div>
        <h2 className="text-xl font-semibold mb-1">Reports</h2>
        <p className="text-white/40 text-sm">All soil suitability analysis reports.</p>
      </div>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/30" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="input pl-9"
            placeholder="Search reports..."
          />
        </div>
        <div className="flex items-center gap-1 bg-navy-800 border border-white/10 rounded-lg p-1 flex-shrink-0">
          {filterTabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setFilter(tab.id)}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-all duration-150 flex items-center gap-1.5 ${
                filter === tab.id
                  ? 'bg-primary-500/20 text-primary-400 border border-primary-500/30'
                  : 'text-white/40 hover:text-white/70'
              }`}
            >
              {tab.label}
              <span className="opacity-60">{tab.count}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Reports list */}
      <div className="card overflow-hidden">
        {loading ? (
          <div className="p-5 space-y-3">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="h-20 bg-white/5 rounded-lg animate-pulse" />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <div className="w-12 h-12 bg-white/5 rounded-xl flex items-center justify-center mb-4">
              <FileText className="w-6 h-6 text-white/20" />
            </div>
            <p className="text-white/40 text-sm">
              {search || filter !== 'all' ? 'No reports match your filters.' : 'No reports yet.'}
            </p>
          </div>
        ) : (
          <div className="divide-y divide-white/5">
            {filtered.map((report) => (
              <button
                key={report.id}
                onClick={() => onViewReport(report.id)}
                className="w-full flex items-center gap-4 px-5 py-4 hover:bg-white/3 transition-colors text-left group"
              >
                <div className="flex-1 min-w-0 grid grid-cols-1 sm:grid-cols-3 gap-2 items-center">
                  <div className="sm:col-span-1">
                    <p className="text-sm font-medium text-white truncate">
                      {report.parcels?.address ?? report.parcels?.apn ?? 'Unknown Parcel'}
                    </p>
                    <p className="text-xs text-white/30 mt-0.5">
                      {[report.parcels?.county, report.parcels?.state].filter(Boolean).join(', ')}
                    </p>
                  </div>
                  <div className="flex items-center gap-3 sm:justify-center">
                    <StatusBadge status={report.status} />
                  </div>
                  <div className="flex items-center gap-3 sm:justify-end">
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-white/30">Conv.</span>
                      <ScorePill score={report.conventional_score} label="" />
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-white/30">Alt.</span>
                      <ScorePill score={report.alternative_score} label="" />
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-3 flex-shrink-0">
                  <span className="text-xs text-white/25">
                    {new Date(report.created_at).toLocaleDateString()}
                  </span>
                  <ChevronRight className="w-4 h-4 text-white/20 group-hover:text-white/50 transition-colors" />
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Legend */}
      <div className="flex items-center gap-6 text-xs text-white/30">
        <span className="flex items-center gap-1.5">
          <AlertTriangle className="w-3.5 h-3.5" />
          Score 0–100. Pass &ge;70, Marginal 40–69, Fail &lt;40
        </span>
      </div>
    </div>
  );
}
