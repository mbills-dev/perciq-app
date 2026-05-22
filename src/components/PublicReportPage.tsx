import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import type { Report, SoilResult } from '../types/database';
import { generateReportHTML, buildSeriesSummary } from '../utils/generateReport';
import type { ReportData, ZoneData, SeriesData } from '../utils/generateReport';
import { Layers, ExternalLink, Download } from 'lucide-react';

// ── Score helpers (mirrors the map-panel polygon scoring logic) ───────────────

function drainageScore(drainage: string | null): number {
  if (!drainage) return 50;
  const d = drainage.toLowerCase();
  if (d.includes('well') || d.includes('somewhat excessively')) return 90;
  if (d.includes('moderately well')) return 70;
  if (d.includes('somewhat poorly')) return 40;
  if (d.includes('poorly') || d.includes('very poorly')) return 15;
  return 50;
}

function ksatScore(ksat: number | null): number {
  if (!ksat || ksat <= 0) return 50;
  if (ksat >= 10 && ksat <= 100) return 90;
  if (ksat >= 1 && ksat < 10) return 70;
  if (ksat >= 0.1 && ksat < 1) return 45;
  if (ksat > 100) return 55;
  return 25;
}

function slopeScore(slopeHigh: number | null): number {
  if (slopeHigh === null) return 65;
  if (slopeHigh <= 6) return 90;
  if (slopeHigh <= 12) return 70;
  if (slopeHigh <= 20) return 45;
  return 20;
}

function waterTableScore(depthIn: number | null): number {
  if (depthIn === null) return 65;
  if (depthIn >= 48) return 90;
  if (depthIn >= 24) return 65;
  if (depthIn >= 12) return 40;
  return 20;
}

function computeSoilScore(sr: SoilResult): number {
  const d = drainageScore(sr.drainage_class);
  const k = ksatScore(sr.ksat_high);
  const sl = slopeScore(sr.slope_high);
  const wt = waterTableScore(sr.depth_water_table);
  return Math.round((d + k + sl + wt) / 4);
}

function scoreToBucket(score: number): 'viable' | 'engineering-needed' | 'not-suitable' {
  if (score >= 65) return 'viable';
  if (score >= 35) return 'engineering-needed';
  return 'not-suitable';
}

// ── Build ReportData from DB rows ─────────────────────────────────────────────

function buildReportData(report: Report, soilResults: SoilResult[]): ReportData {
  const parcel = report.parcels;

  // Score each soil result
  const scored = soilResults.map(sr => ({
    sr,
    score: computeSoilScore(sr),
    bucket: scoreToBucket(computeSoilScore(sr)),
  }));

  // Build fake GeoJSON polygons for buildSeriesSummary (no geometry = 0 acres)
  const fakePolygons = scored.map(({ sr, score, bucket }) => ({
    mukey: sr.map_unit_key ?? sr.id,
    geojson: {
      type: 'Feature' as const,
      geometry: { type: 'Polygon' as const, coordinates: [[]] },
      properties: {
        muname: sr.map_unit_name ?? 'Unknown',
        musym: sr.map_unit_key ?? '',
        drainagecl: sr.drainage_class ?? '',
        ksat_r: sr.ksat_high ?? 0,
        suitabilityScore: score,
      },
    },
    bucket,
    result: {
      map_unit_name: sr.map_unit_name,
      map_unit_key: sr.map_unit_key,
      drainage_class: sr.drainage_class,
      ksat_high: sr.ksat_high,
    },
  }));

  const soilSeries: SeriesData[] = buildSeriesSummary(fakePolygons).map(s => ({
    ...s,
    totalAcres: 0,
  }));

  // Top zones (best 3 unique series)
  const topZones: ZoneData[] = soilSeries
    .filter(s => s.bestScore >= 35)
    .slice(0, 3)
    .map((s, i) => {
      const sr = soilResults.find(r => (r.map_unit_name ?? 'Unknown') === s.name) ?? soilResults[i];
      return {
        rank: i + 1,
        name: s.name,
        series: s.series,
        mukey: s.mukeys[0] ?? '',
        score: s.bestScore,
        bucket: scoreToBucket(s.bestScore) as 'viable' | 'engineering' | 'not-suitable' | 'possible',
        drainage: drainageScore(s.drainage),
        permeability: ksatScore(s.ksat),
        slope: slopeScore(sr?.slope_high ?? null),
        waterTable: waterTableScore(sr?.depth_water_table ?? null),
        floodOverlap: 0,
        wetlandOverlap: 0,
        areaAcres: 0,
      };
    });

  const bestZoneScore = report.best_zone_score ?? (scored[0]?.score ?? 0);
  const parcelScore = report.parcel_score ?? bestZoneScore;

  const floodPct = (report.fema_feature_count ?? 0) > 0 ? 5 : 0;
  const wetlandPct = (report.nwi_feature_count ?? 0) > 0 ? 3 : 0;

  const verdict = bestZoneScore >= 70
    ? 'Viable — Conventional Septic Likely'
    : bestZoneScore >= 45
      ? 'Engineering Needed'
      : 'Not Suitable — Professional Evaluation Required';

  return {
    address: parcel?.address ?? 'Unknown Address',
    county: parcel?.county ?? '',
    state: parcel?.state ?? '',
    acreage: parcel?.acreage ?? 0,
    owner: (parcel as (typeof parcel & { owner?: string | null }))?.owner ?? '',
    generatedDate: new Date(report.created_at).toLocaleDateString('en-US', {
      month: 'long', day: 'numeric', year: 'numeric',
    }),
    bestZoneScore,
    parcelScore,
    floodPct,
    wetlandPct,
    floodZone: floodPct > 0 ? 'AE' : 'None',
    verdict,
    soilSeries,
    topZones,
    percPins: [],
    mapImageBase64: null,
  };
}

// ── Strip outer html/head/body tags, keep body content only ──────────────────

function extractBodyContent(fullHtml: string): string {
  const bodyMatch = fullHtml.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  return bodyMatch ? bodyMatch[1] : fullHtml;
}

function extractHeadStyles(fullHtml: string): string {
  const matches = [...fullHtml.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)];
  return matches.map(m => m[1]).join('\n');
}

// ── Component ─────────────────────────────────────────────────────────────────

interface PublicReportPageProps {
  reportId: string;
}

export default function PublicReportPage({ reportId }: PublicReportPageProps) {
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [reportHtml, setReportHtml] = useState('');
  const [reportStyles, setReportStyles] = useState('');
  const [address, setAddress] = useState('');
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [pdfLoading, setPdfLoading] = useState(false);
  const [isLoggedIn, setIsLoggedIn] = useState<boolean | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setIsLoggedIn(!!session);
    });
  }, []);

  useEffect(() => {
    async function load() {
      const [{ data: rep }, { data: soil }] = await Promise.all([
        supabase.from('reports').select('*, parcels(*)').eq('id', reportId).maybeSingle(),
        supabase.from('soil_results').select('*').eq('report_id', reportId).order('pct_coverage', { ascending: false }),
      ]);

      if (!rep) { setNotFound(true); setLoading(false); return; }

      const reportData = buildReportData(rep as Report, (soil as SoilResult[]) ?? []);
      setAddress(reportData.address);

      const publicReportUrl = `https://app.perciq.co/report/${reportId}`;
      const html = generateReportHTML(reportData, {
        shareUrl: publicReportUrl,
        publicReportUrl,
        filename: `PercIQ-${reportData.address.replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 40)}.pdf`,
      });

      setReportStyles(extractHeadStyles(html));
      // Strip the dl-bar (floating toolbar) from the inline view — we have our own footer
      const body = extractBodyContent(html).replace(/<div class="dl-bar">[\s\S]*?<\/div>\s*(?=<script)/i, '');
      setReportHtml(body);
      setLoading(false);
    }
    load();
  }, [reportId]);

  async function handleDownloadPdf() {
    if (pdfLoading) return;
    if (isLoggedIn === false) {
      window.location.href = 'https://app.perciq.co';
      return;
    }
    setPdfLoading(true);
    // Open the interactive report for the authenticated user
    window.open(`https://app.perciq.co/?report=${reportId}`, '_blank');
    setPdfLoading(false);
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-[#c8cfd8] flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <div className="w-8 h-8 border-2 border-white/30 border-t-[#22C55E] rounded-full animate-spin" />
          <p className="text-white/50 text-sm">Loading report...</p>
        </div>
      </div>
    );
  }

  if (notFound) {
    return (
      <div className="min-h-screen bg-[#c8cfd8] flex items-center justify-center">
        <div className="text-center">
          <p className="text-[#334155] font-semibold text-lg mb-2">Report not found</p>
          <p className="text-[#64748b] text-sm">This report may have been removed or the link is invalid.</p>
          <a href="https://app.perciq.co" className="inline-block mt-6 px-5 py-2.5 rounded-lg bg-[#22C55E] text-white text-sm font-bold">
            Go to PercIQ
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#c8cfd8]" style={{ paddingBottom: '80px' }}>
      {/* Inject report styles into the page */}
      <style dangerouslySetInnerHTML={{ __html: reportStyles }} />

      {/* Minimal public header */}
      <div
        style={{
          position: 'sticky', top: 0, zIndex: 100,
          background: 'rgba(10,15,30,0.92)',
          backdropFilter: 'blur(14px)',
          borderBottom: '1px solid rgba(255,255,255,0.06)',
          padding: '10px 20px',
          display: 'flex', alignItems: 'center', gap: 12,
        }}
      >
        <a
          href="https://app.perciq.co"
          style={{ display: 'flex', alignItems: 'center', gap: 8, textDecoration: 'none' }}
        >
          <div style={{
            width: 26, height: 26, background: 'rgba(34,197,94,0.18)',
            border: '1px solid rgba(34,197,94,0.4)', borderRadius: 7,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <Layers size={13} color="#22C55E" />
          </div>
          <span style={{ fontWeight: 900, fontSize: 14, color: '#fff', letterSpacing: '-0.02em' }}>PercIQ</span>
        </a>

        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={{
            fontSize: 11, color: 'rgba(255,255,255,0.45)', overflow: 'hidden',
            textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            Soil Suitability Report &nbsp;·&nbsp; {address}
          </p>
        </div>

        <button
          onClick={handleDownloadPdf}
          disabled={pdfLoading}
          style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '7px 14px', borderRadius: 8,
            background: '#22C55E', border: 'none',
            color: '#fff', fontSize: 12, fontWeight: 700,
            cursor: pdfLoading ? 'default' : 'pointer',
            opacity: pdfLoading ? 0.7 : 1,
            flexShrink: 0,
            letterSpacing: '0.01em',
          }}
        >
          <Download size={11} />
          {isLoggedIn ? 'Download PDF' : 'Sign in to Download'}
        </button>
      </div>

      {/* Report pages rendered inline */}
      <div
        dangerouslySetInnerHTML={{ __html: reportHtml }}
        style={{ fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, system-ui, sans-serif" }}
      />

      {/* Sticky CTA footer */}
      <div style={{
        position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 200,
        background: 'rgba(10,15,30,0.96)',
        backdropFilter: 'blur(16px)',
        borderTop: '1px solid rgba(34,197,94,0.2)',
        padding: '12px 20px',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
      }}>
        <div style={{ minWidth: 0 }}>
          <p style={{ fontSize: 13, fontWeight: 600, color: '#fff', letterSpacing: '-0.01em' }}>
            Run your own parcel analysis free at perciq.co
          </p>
          <p style={{ fontSize: 11, color: 'rgba(255,255,255,0.40)', marginTop: 1 }}>
            Soil suitability screening using USDA, FEMA &amp; NWI data — in minutes
          </p>
        </div>
        <a
          href="https://app.perciq.co"
          target="_blank"
          rel="noopener noreferrer"
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            padding: '9px 16px', borderRadius: 9,
            background: '#22C55E', color: '#fff',
            fontSize: 12, fontWeight: 700,
            textDecoration: 'none', whiteSpace: 'nowrap',
            flexShrink: 0, letterSpacing: '0.01em',
          }}
        >
          <ExternalLink size={11} />
          Get started free
        </a>
      </div>
    </div>
  );
}
