import { useEffect, useState, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import type { Report, SoilResult } from '../types/database';
import { generateReportHTML, buildSeriesSummary } from '../utils/generateReport';
import type { ReportData, ZoneData, SeriesData } from '../utils/generateReport';
import { Layers, ExternalLink, Download, Link2, Check, RefreshCw } from 'lucide-react';

// ── Fallback score helpers (used only when report_data is not yet cached) ─────

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

// ── Fallback builder — used only when report_data has not been cached yet ─────

function buildFallbackReportData(report: Report, soilResults: SoilResult[]): ReportData {
  const parcel = report.parcels;

  const scored = soilResults.map(sr => ({
    sr,
    score: computeSoilScore(sr),
    bucket: scoreToBucket(computeSoilScore(sr)),
  }));

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
  const [fullHtml, setFullHtml] = useState('');
  const [filename, setFilename] = useState('PercIQ-report.pdf');
  const [pdfLoading, setPdfLoading] = useState(false);
  const [pdfError, setPdfError] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);

  useEffect(() => {
    async function load() {
      const { data: rep } = await supabase
        .from('reports')
        .select('*, parcels(*)')
        .eq('id', reportId)
        .maybeSingle();

      if (!rep) { setNotFound(true); setLoading(false); return; }

      const report = rep as Report & { report_data?: ReportData | null; map_snapshot_url?: string | null };
      const mapSnapshotUrl = report.map_snapshot_url ?? null;

      let reportData: ReportData;

      if (report.report_data) {
        // Use the exact ReportData saved when the authenticated user generated the report.
        reportData = {
          ...report.report_data,
          mapImageBase64: null,
          mapImageUrl: mapSnapshotUrl,
        };
      } else {
        // report_data not yet written — fall back to reconstructing from stored DB fields.
        const { data: soil } = await supabase
          .from('soil_results')
          .select('*')
          .eq('report_id', reportId)
          .order('pct_coverage', { ascending: false });
        reportData = {
          ...buildFallbackReportData(report, (soil as SoilResult[]) ?? []),
          mapImageUrl: mapSnapshotUrl,
        };
      }

      setAddress(reportData.address);

      const publicReportUrl = `https://app.perciq.co/report/${reportId}`;
      const slug = reportData.address.replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 40);
      const pdfFilename = `PercIQ-${slug}.pdf`;
      const html = generateReportHTML(reportData, {
        shareUrl: publicReportUrl,
        publicReportUrl,
        filename: pdfFilename,
      });

      setFullHtml(html);
      setFilename(pdfFilename);
      setReportStyles(extractHeadStyles(html));
      // Strip the inline dl-bar (we provide our own action bar)
      const body = extractBodyContent(html).replace(/<div class="dl-bar">[\s\S]*?<\/div>\s*(?=<script)/i, '');
      setReportHtml(body);
      setLoading(false);
    }
    load();
  }, [reportId]);

  const handleDownloadPdf = useCallback(async () => {
    if (pdfLoading || !fullHtml) return;
    setPdfLoading(true);
    setPdfError(false);
    try {
      const response = await fetch('/api/generate-pdf', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ html: fullHtml, filename }),
      });
      if (!response.ok) throw new Error(`API ${response.status}`);
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 15000);
    } catch (err) {
      console.error('[public-report] PDF download failed:', err);
      setPdfError(true);
    } finally {
      setPdfLoading(false);
    }
  }, [pdfLoading, fullHtml, filename]);

  const handleCopyLink = useCallback(() => {
    const url = `https://app.perciq.co/report/${reportId}`;
    navigator.clipboard.writeText(url).then(() => {
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 2000);
    });
  }, [reportId]);

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
      <style dangerouslySetInnerHTML={{ __html: reportStyles + '\n@media print{.public-action-bar,.public-cta-bar{display:none!important}}' }} />

      {/* Action bar — hidden in print */}
      <div
        className="public-action-bar"
        style={{
          position: 'sticky', top: 0, zIndex: 100,
          background: 'rgba(10,15,30,0.92)',
          backdropFilter: 'blur(14px)',
          borderBottom: '1px solid rgba(255,255,255,0.06)',
          padding: '10px 16px',
          display: 'flex', alignItems: 'center', gap: 10,
        }}
      >
        <a
          href="https://app.perciq.co"
          style={{ display: 'flex', alignItems: 'center', gap: 7, textDecoration: 'none', flexShrink: 0 }}
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

        <div style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>
          <p style={{
            fontSize: 11, color: 'rgba(255,255,255,0.45)', overflow: 'hidden',
            textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {address}
          </p>
        </div>

        {/* Copy share link */}
        <button
          onClick={handleCopyLink}
          title="Copy shareable link"
          style={{
            display: 'flex', alignItems: 'center', gap: 5,
            padding: '8px 12px', borderRadius: 8,
            background: 'transparent',
            border: `1px solid ${linkCopied ? 'rgba(34,197,94,0.5)' : 'rgba(255,255,255,0.14)'}`,
            color: linkCopied ? '#22C55E' : 'rgba(255,255,255,0.55)',
            fontSize: 12, fontWeight: 600,
            cursor: 'pointer',
            flexShrink: 0,
            letterSpacing: '0.01em',
            minHeight: 36,
            whiteSpace: 'nowrap',
            transition: 'border-color 150ms, color 150ms',
          }}
        >
          {linkCopied ? <Check size={11} /> : <Link2 size={11} />}
          {linkCopied ? 'Copied!' : 'Share'}
        </button>

        {/* Download PDF */}
        <button
          onClick={handleDownloadPdf}
          disabled={pdfLoading || !fullHtml}
          title={pdfError ? 'Download failed — try again' : 'Download as PDF'}
          style={{
            display: 'flex', alignItems: 'center', gap: 5,
            padding: '8px 14px', borderRadius: 8,
            background: pdfError ? 'rgba(255,69,57,0.15)' : '#22C55E',
            border: pdfError ? '1px solid rgba(255,69,57,0.4)' : 'none',
            color: pdfError ? '#FF4539' : '#fff',
            fontSize: 12, fontWeight: 700,
            cursor: (pdfLoading || !fullHtml) ? 'default' : 'pointer',
            opacity: (pdfLoading || !fullHtml) ? 0.7 : 1,
            flexShrink: 0,
            letterSpacing: '0.01em',
            minHeight: 36,
            whiteSpace: 'nowrap',
            transition: 'opacity 150ms',
          }}
        >
          {pdfLoading ? <RefreshCw size={11} className="animate-spin" /> : <Download size={11} />}
          {pdfLoading ? 'Generating…' : pdfError ? 'Retry PDF' : 'Download PDF'}
        </button>
      </div>

      <div
        dangerouslySetInnerHTML={{ __html: reportHtml }}
        style={{ fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, system-ui, sans-serif" }}
      />

      <div className="public-cta-bar" style={{
        position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 200,
        background: 'rgba(10,15,30,0.96)',
        backdropFilter: 'blur(16px)',
        borderTop: '1px solid rgba(34,197,94,0.2)',
        padding: '10px 16px',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
      }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <p style={{ fontSize: 12, fontWeight: 600, color: '#fff', letterSpacing: '-0.01em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            Run your own parcel analysis free
          </p>
          <p style={{ fontSize: 10, color: 'rgba(255,255,255,0.40)', marginTop: 1 }}>
            Soil screening using USDA, FEMA &amp; NWI data
          </p>
        </div>
        <a
          href="https://app.perciq.co"
          target="_blank"
          rel="noopener noreferrer"
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 5,
            padding: '9px 14px', borderRadius: 9,
            background: '#22C55E', color: '#fff',
            fontSize: 12, fontWeight: 700,
            textDecoration: 'none', whiteSpace: 'nowrap',
            flexShrink: 0, letterSpacing: '0.01em',
            minHeight: 44,
          }}
        >
          <ExternalLink size={11} />
          Get started
        </a>
      </div>
    </div>
  );
}
