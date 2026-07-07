import { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import * as turf from '@turf/turf';
import polylabel from 'polylabel';
import { supabase } from '../lib/supabase';
import type { Report, SoilResult, CountyRule } from '../types/database';
import {
  ArrowLeft, CheckCircle, XCircle, AlertTriangle,
  RefreshCw, AlertCircle,
  ChevronDown, ChevronUp, Circle, Download, Link2, Check, ExternalLink, Compass,
} from 'lucide-react';
import { generateReportHTML, buildSeriesSummary, toTitleCase } from '../utils/generateReport';
import type { PercPinData } from '../utils/generateReport';

interface ReportDetailProps {
  reportId: string;
  onBack: () => void;
  isPublic?: boolean;
}

interface ScoreResult {
  conventional_score: number;
  alternative_score: number;
  confidence: number;
  data_depth_tier: 1 | 2 | 3 | 4;
  data_depth_note: string;
  explanation: string[];
  component_scores: Array<{
    map_unit_key: string;
    map_unit_name: string;
    pct_coverage: number;
    conventional_pts: number;
    alternative_pts: number;
  }>;
  nearby_tests_summary: {
    matching_within_5mi: number;
    matching_within_3mi: number;
    passing_within_1mi: number;
  };
  county_rules_applied: boolean;
}

type StepStatus = 'pending' | 'running' | 'done' | 'error' | 'skipped';

interface PipelineState {
  step1: StepStatus;
  step2: StepStatus;
  step3: StepStatus;
  error: string;
}

// ─── helpers ────────────────────────────────────────────────────────────────

function scoreColor(score: number | null): string {
  if (score === null) return '#6B7280';
  if (score >= 65) return '#22C55E';
  if (score >= 40) return '#F59E0B';
  return '#EF4444';
}

function scoreLabel(score: number | null): string {
  if (score === null) return 'Pending';
  if (score >= 65) return 'Suitable';
  if (score >= 40) return 'Marginal';
  return 'Unsuitable';
}


const _loggedBucketMukeys = new Set<string>();

// ─── Gating ceiling constants — tune here; logic is separate ─────────────────
// Each value is the maximum SI Score allowed when that condition is true.
// A gate only lowers the score; it never raises it.
// These thresholds must match the Site Alert conditions so a critical alert
// can never coexist with a Viable (>=65) score.
const GATE_CEIL = {
  WATER_TABLE_VERY_SHALLOW: 39,  // seasonal water table < 18 in  (< 45.72 cm)
  WATER_TABLE_SHALLOW:      55,  // seasonal water table 18–24 in (45.72–60.96 cm)
  WATER_TABLE_MODERATE:     64,  // seasonal water table 24–36 in (60.96–91.44 cm)
  BEDROCK_SHALLOW:          39,  // lithic / paralithic / cemented bedrock < 20 in (< 50.8 cm)
  CLAY_SHALLOW:             50,  // clay or non-bedrock restriction < 20 in — mound/LPP may work
  RESTRICTION_MODERATE:     64,  // any restriction 20–36 in (50.8–91.44 cm)
  FLOODING_FREQUENT:        39,  // SSURGO flodfreqcl "frequent" or "very frequent"
  FEMA_FLOOD_HIGH:          39,  // FEMA 100-yr flood spatial overlap > 25%
  FEMA_FLOOD_MODERATE:      64,  // FEMA 100-yr flood spatial overlap 10–25%
  WETLAND_HIGH:             39,  // NWI wetland spatial overlap > 25%
  WETLAND_MODERATE:         64,  // NWI wetland spatial overlap 10–25%
  KSAT_EXTREME:             39,  // ksat < 0.4 or > 150 µm/s
  SLOPE_SEVERE:             39,  // slope > 30%
  SLOPE_STEEP:              64,  // slope 15–30%
} as const;

// ─── Soil scoring engine (gated limiting-factor model) ────────────────────────

function getOverlapPercent(
  poly: turf.Feature<turf.Polygon | turf.MultiPolygon>,
  overlayUnion: turf.Feature<turf.Polygon | turf.MultiPolygon> | null,
  overlayArray: turf.Feature<turf.Polygon | turf.MultiPolygon>[],
): number {
  const polyArea = turf.area(poly);
  if (polyArea === 0) return 0;
  if (overlayUnion) {
    try {
      const intersection = turf.intersect(turf.featureCollection([poly, overlayUnion]));
      return intersection ? Math.min(1, turf.area(intersection) / polyArea) : 0;
    } catch { /* fall through to array method */ }
  }
  if (!overlayArray.length) return 0;
  let overlapArea = 0;
  for (const other of overlayArray) {
    try {
      const intersection = turf.intersect(turf.featureCollection([poly, other]));
      if (intersection) overlapArea += turf.area(intersection);
    } catch { continue; }
  }
  return Math.min(1, overlapArea / polyArea);
}

interface SoilScore {
  finalScore: number;
  qualityComposite: number;  // weighted average before gating — raw soil-quality signal
  ceiling: number;           // lowest gate ceiling that fired (100 = no gate)
  bucket: SoilBucket;
  drainageScore: number;
  ksatScore: number;
  slopeScore: number;
  watertableScore: number;
  pondingScore: number | null;
  restrictiveLayerScore: number | null;
  floodingScore: number | null;
  floodOverlapPct: number;
  wetlandOverlapPct: number;
}

function scoreSoilPolygon(
  props: Record<string, unknown>,
  mukey: string,
  floodUnion: turf.Feature<turf.Polygon | turf.MultiPolygon> | null,
  floodFeatures: turf.Feature<turf.Polygon | turf.MultiPolygon>[],
  wetlandUnion: turf.Feature<turf.Polygon | turf.MultiPolygon> | null,
  wetlandFeatures: turf.Feature<turf.Polygon | turf.MultiPolygon>[],
  geojson: turf.Feature<turf.Polygon | turf.MultiPolygon>,
): SoilScore {
  // ── Extract raw data ──────────────────────────────────────────────────────
  const drainagecl = (props.drainagecl ?? props.drain ?? props.drainageclass ?? null) as string | null;
  const muname = (props.muname ?? props.MUNAME ?? '') as string;

  const ksat = parseFloat(props.ksat_r as string)
    || parseFloat(props.ksat_h as string)
    || parseFloat(props.ksat_l as string)
    || null;

  // Resolved slope: DEM-derived zone median takes precedence over SSURGO county-averaged.
  // Both fields are set by buildSoilPolygons before calling this function.
  const rawSlopeSsurgoPct = parseFloat(props.rawSlopeSsurgoPct as string) || parseFloat(props.slope_h as string) || parseFloat(props.slope_r as string) || null;
  const zoneSlopeDemPct   = props.zoneSlopeDemPct != null && props.zoneSlopeDemPct !== 'null'
    ? (parseFloat(props.zoneSlopeDemPct as string) || null) : null;
  const slope = zoneSlopeDemPct ?? rawSlopeSsurgoPct;

  const watertable = parseFloat(props.wtdepannmin as string)
    || parseFloat(props.watertbl as string)
    || null;

  const pondfreqcl = (props.pondfreqcl ?? null) as string | null;
  const flodfreqcl = (props.flodfreqcl ?? null) as string | null;
  const resdept_r = props.resdept_r != null ? parseFloat(props.resdept_r as string) : null;
  const reskind = (props.reskind ?? null) as string | null;
  const clay40_depth_cm = props.clay40_depth_cm != null && props.clay40_depth_cm !== 'null'
    ? parseFloat(props.clay40_depth_cm as string) || null : null;

  if (!_loggedBucketMukeys.has(mukey)) {
    _loggedBucketMukeys.add(mukey);
    const slopeSource = zoneSlopeDemPct !== null ? 'DEM' : 'SSURGO';
    console.log('[score] mukey:', mukey, 'drain:', drainagecl, 'ksat:', ksat,
      'rawSlopeSsurgo:', rawSlopeSsurgoPct, 'zoneSlopeDem:', zoneSlopeDemPct,
      'slopeUsed:', slope, `(${slopeSource})`,
      'watertable:', watertable, 'ponding:', pondfreqcl, 'flooding:', flodfreqcl, 'resdept:', resdept_r, 'reskind:', reskind);
  }

  // ── Factor A: Drainage (35%) ──────────────────────────────────────────────
  const drainageScore = (() => {
    const d = (drainagecl ?? muname).toLowerCase();
    if (d.includes('well drained') && !d.includes('somewhat') && !d.includes('moderately')) return 90;
    if (d.includes('moderately well')) return 75;
    if (d.includes('somewhat excessively')) return 75;
    if (d.includes('excessively') && !d.includes('somewhat')) return 65;
    if (d.includes('somewhat poorly')) return 35;
    if (d.includes('very poorly')) return 0;
    if (d.includes('poorly') && !d.includes('somewhat')) return 10;
    if (d.includes('subaqueous')) return 0;
    return 50; // neutral if no data
  })();

  // ── Factor B: Ksat (25%) ─────────────────────────────────────────────────
  // Bands calibrated to perc-rate equivalents (mpi ≈ 425 / ksat µm/s).
  // Gate boundary: ksat < 0.4 or > 150 µm/s → ksat_extreme (ceiling 39).
  const ksatScore = (() => {
    if (ksat === null) return 55;                    // neutral when unknown
    if (ksat < 0.4) return 10;                       // >1000 mpi — clay, won't drain
    if (ksat < 4)   return 35;                       // 100–1000 mpi — conventional likely fails
    if (ksat < 7)   return 60;                       // 60–100 mpi — borderline, design-dependent
    if (ksat <= 30) return 90;                       // 15–60 mpi — IDEAL conventional range
    if (ksat <= 80) return 70;                       // 5–15 mpi — moderate-fast, treatment OK
    if (ksat <= 150) return 45;                      // 3–5 mpi — fast, treatment concerns
    return 10;                                       // <3 mpi — gravel, no treatment capacity
  })();

  // ── Factor C: Slope (20%) ────────────────────────────────────────────────
  const slopeScore = (() => {
    if (slope === null) return 60;
    if (slope <= 3) return 95;
    if (slope <= 8) return 85;
    if (slope <= 15) return 60;
    if (slope <= 25) return 30;
    if (slope <= 30) return 10;
    return 0;
  })();

  // ── Factor D: Water table (20%) ──────────────────────────────────────────
  // watertable comes from result.water_table_depth which soil-query stores in INCHES.
  const watertableScore = (() => {
    if (watertable === null) {
      const d = (drainagecl ?? '').toLowerCase();
      return d.includes('excessively drained') ? 85 : 55;
    }
    if (watertable >= 47) return 95;   // >= 47 in deep — no seasonal saturation risk
    if (watertable >= 35) return 80;   // 35–47 in
    if (watertable >= 24) return 60;   // 24–35 in — meets minimum for conventional
    if (watertable >= 12) return 30;   // 12–24 in — limiting
    if (watertable >= 0) return 5;     // < 12 in — very shallow
    return 55;
  })();

  // ── Factor E: Ponding frequency ───────────────────────────────────────────
  // null → no data for display (shown as unknown); no penalty applied to score
  const pondingScore: number | null = pondfreqcl === null ? null : (() => {
    const p = pondfreqcl.toLowerCase();
    if (p === 'none') return 100;
    if (p === 'rare') return 75;
    if (p === 'occasional') return 40;
    if (p === 'frequent') return 10;
    return 100;
  })();

  // ── Factor F: Depth to restrictive layer (cm) ─────────────────────────────
  // Primary source: corestrictions resdept_r. Fallback: clay horizon at >=35% clay AND ksat<1.0.
  // null resdept with a known limiting reskind → score 50 (unknown depth, not assumed deep).
  // null resdept, null clay, null reskind → null (no data at all).
  const LIMITING_RESKIND = ['bedrock', 'paralithic', 'fragipan', 'duripan', 'cemented', 'ortstein', 'permafrost'];
  const isLimitingKind = reskind !== null && LIMITING_RESKIND.some(k => reskind.toLowerCase().includes(k));
  // Effective restrictive depth in cm — use resdept_r first, clay40_depth_cm as fallback
  const effectiveResdeptCm = resdept_r !== null && !isNaN(resdept_r) ? resdept_r : clay40_depth_cm;
  const restrictiveLayerScore: number | null = (() => {
    if (effectiveResdeptCm !== null && !isNaN(effectiveResdeptCm)) {
      if (effectiveResdeptCm > 150) return 100;
      if (effectiveResdeptCm >= 100) return 90;
      if (effectiveResdeptCm >= 50) return 75;   // ~20 in — min for most conventional systems
      if (effectiveResdeptCm >= 36) return 20;   // ~14 in — severely limited, mound/alt needed
      if (effectiveResdeptCm >= 18) return 10;   // ~7 in  — very shallow, few options
      return 5;                                   // < 7 in — essentially none
    }
    // depth missing but a limiting layer type is recorded — neutral unknown, not "no problem"
    if (isLimitingKind) return 50;
    return null;
  })();

  // ── Factor G: Flooding frequency ─────────────────────────────────────────
  // null → no data for display; no penalty applied
  const floodingScore: number | null = flodfreqcl === null ? null : (() => {
    const f = flodfreqcl.toLowerCase();
    if (f === 'none') return 100;
    if (f === 'rare') return 80;
    if (f === 'occasional') return 45;
    if (f === 'frequent') return 10;
    return 100;
  })();

  // ── Quality composite: weighted average of the 4 soil-quality factors ────
  // This is the "how good is this soil" signal. Multipliers are gone — all
  // limiting conditions are handled as hard ceilings below.
  const qualityComposite = (drainageScore * 0.35) + (ksatScore * 0.25) + (slopeScore * 0.20) + (watertableScore * 0.20);

  // ── Spatial overlays (needed for gating and display) ────────────────────
  const floodOverlap   = (floodUnion   || floodFeatures.length)
    ? getOverlapPercent(geojson, floodUnion, floodFeatures) : 0;
  const wetlandOverlap = (wetlandUnion || wetlandFeatures.length)
    ? getOverlapPercent(geojson, wetlandUnion, wetlandFeatures) : 0;

  // ── Gating ceiling: each limiting condition fires a cap; lowest wins ────
  let ceiling = 100;
  const firedGates: string[] = [];

  // Water table gate — watertable in INCHES (water_table_depth; soil-query converts cm→in at storage)
  // Bands are half-open: exactly 18in hits the 18-24 band (ceiling 55), not the <18 band.
  if (watertable !== null) {
    if (watertable < 18) {            // < 18 in
      ceiling = Math.min(ceiling, GATE_CEIL.WATER_TABLE_VERY_SHALLOW);
      firedGates.push(`wt<18in→${GATE_CEIL.WATER_TABLE_VERY_SHALLOW}`);
    } else if (watertable < 24) {     // [18, 24)
      ceiling = Math.min(ceiling, GATE_CEIL.WATER_TABLE_SHALLOW);
      firedGates.push(`wt18-24in→${GATE_CEIL.WATER_TABLE_SHALLOW}`);
    } else if (watertable < 36) {     // [24, 36)
      ceiling = Math.min(ceiling, GATE_CEIL.WATER_TABLE_MODERATE);
      firedGates.push(`wt24-36in→${GATE_CEIL.WATER_TABLE_MODERATE}`);
    }
  }

  // Restrictive layer gate — effectiveResdeptCm in cm; reskind splits bedrock vs clay
  if (effectiveResdeptCm !== null && !isNaN(effectiveResdeptCm)) {
    const BEDROCK_KINDS = ['bedrock', 'lithic', 'paralithic', 'fragipan', 'duripan', 'cemented', 'ortstein', 'permafrost'];
    const isBedrock = reskind !== null && BEDROCK_KINDS.some(k => reskind.toLowerCase().includes(k));
    if (effectiveResdeptCm < 50.8) {                // < 20 in
      const cap = isBedrock ? GATE_CEIL.BEDROCK_SHALLOW : GATE_CEIL.CLAY_SHALLOW;
      ceiling = Math.min(ceiling, cap);
      firedGates.push(`restr<20in(${isBedrock ? 'bedrock' : 'clay'})→${cap}`);
    } else if (effectiveResdeptCm < 91.44) {         // 20–36 in
      ceiling = Math.min(ceiling, GATE_CEIL.RESTRICTION_MODERATE);
      firedGates.push(`restr20-36in→${GATE_CEIL.RESTRICTION_MODERATE}`);
    }
  }

  // SSURGO flooding frequency gate
  if (flodfreqcl !== null) {
    const f = flodfreqcl.toLowerCase();
    if (f === 'frequent' || f === 'very frequent') {
      ceiling = Math.min(ceiling, GATE_CEIL.FLOODING_FREQUENT);
      firedGates.push(`flodfreq→${GATE_CEIL.FLOODING_FREQUENT}`);
    }
  }

  // FEMA 100-yr flood spatial overlap gate
  // > 25% → severe; [10%, 25%] → moderate (exactly 25% is moderate, not severe)
  if (floodOverlap > 0.25) {
    ceiling = Math.min(ceiling, GATE_CEIL.FEMA_FLOOD_HIGH);
    firedGates.push(`fema>25%→${GATE_CEIL.FEMA_FLOOD_HIGH}`);
  } else if (floodOverlap >= 0.10) {
    ceiling = Math.min(ceiling, GATE_CEIL.FEMA_FLOOD_MODERATE);
    firedGates.push(`fema10-25%→${GATE_CEIL.FEMA_FLOOD_MODERATE}`);
  }

  // NWI wetland spatial overlap gate
  // > 25% → severe; [10%, 25%] → moderate (exactly 25% is moderate, not severe)
  if (wetlandOverlap > 0.25) {
    ceiling = Math.min(ceiling, GATE_CEIL.WETLAND_HIGH);
    firedGates.push(`wetland>25%→${GATE_CEIL.WETLAND_HIGH}`);
  } else if (wetlandOverlap >= 0.10) {
    ceiling = Math.min(ceiling, GATE_CEIL.WETLAND_MODERATE);
    firedGates.push(`wetland10-25%→${GATE_CEIL.WETLAND_MODERATE}`);
  }

  // ksat extreme gate
  if (ksat !== null && (ksat < 0.4 || ksat > 150)) {
    ceiling = Math.min(ceiling, GATE_CEIL.KSAT_EXTREME);
    firedGates.push(`ksat_extreme→${GATE_CEIL.KSAT_EXTREME}`);
  }

  // Slope gate — exactly 30% lands in steep (64), not severe (39); exactly 15% fires steep
  if (slope !== null) {
    if (slope > 30) {
      ceiling = Math.min(ceiling, GATE_CEIL.SLOPE_SEVERE);
      firedGates.push(`slope>30%→${GATE_CEIL.SLOPE_SEVERE}`);
    } else if (slope >= 15) {
      ceiling = Math.min(ceiling, GATE_CEIL.SLOPE_STEEP);
      firedGates.push(`slope15-30%→${GATE_CEIL.SLOPE_STEEP}`);
    }
  }

  const finalScore = Math.round(Math.min(qualityComposite, ceiling));

  // hasRealData: at least one SSURGO field came back with actual data (not just defaults)
  const hasRealData = ksat !== null || drainagecl !== null || watertable !== null || (resdept_r !== null && !isNaN(resdept_r));

  const bucket: SoilBucket = (() => {
    if (finalScore >= 65) return 'viable';
    if (finalScore >= 40) return 'engineering-needed';
    if (finalScore > 0 || hasRealData) return 'not-suitable';
    return 'no-data';
  })();

  console.log('[score] mukey:', mukey,
    'quality_composite:', qualityComposite.toFixed(1),
    'ceiling:', ceiling,
    'gates:', firedGates.length ? firedGates.join(' ') : 'none',
    'final_SI:', finalScore, 'bucket:', bucket);

  return {
    finalScore, qualityComposite: Math.round(qualityComposite), ceiling, firedGates, bucket,
    drainageScore, ksatScore, slopeScore, watertableScore,
    pondingScore, restrictiveLayerScore, floodingScore,
    floodOverlapPct: Math.round(floodOverlap * 100),
    wetlandOverlapPct: Math.round(wetlandOverlap * 100),
  };
}

const BUCKET_FILL = {
  'viable':       { fill: '#22C55E', fillOpacity: 0.50, stroke: '#22C55E' },
  'engineering-needed': { fill: '#F59E0B', fillOpacity: 0.50, stroke: '#F59E0B' },
  'not-suitable': { fill: '#EF4444', fillOpacity: 0.50, stroke: '#EF4444' },
  'no-data':      { fill: '#6B7280', fillOpacity: 0.25, stroke: '#6B7280' },
};

// ── Unified factor band copy ──────────────────────────────────────────────
// Single source of truth per named band: the factor bar AND the site alert for
// that band use the same text so they can never contradict each other.
type BandSev = 'good' | 'warning' | 'critical';
interface BandCopy {
  barSev: BandSev;
  barText: string;
  alertText?: string;           // omit when this band produces no site alert
  alertLevel?: 'critical' | 'warning';
}
const BAND: Record<string, BandCopy> = {
  // ── Slope ──
  slope_gentle:    { barSev: 'good',     barText: 'Gentle slope — unlikely to constrain septic placement.' },
  slope_moderate:  { barSev: 'warning',  barText: 'Moderate slope — generally workable; verify field conditions.' },
  slope_marginal:  { barSev: 'warning',  barText: 'Elevated slope — site-specific design likely needed.',
                     alertText: 'Elevated slope — site-specific design likely needed', alertLevel: 'warning' },
  slope_steep:     { barSev: 'critical', barText: 'Steep slope — exceeds typical drainfield limits.',
                     alertText: 'Steep slope — alternative design or alternate site required', alertLevel: 'critical' },
  // ── Water table ──
  wt_critical:     { barSev: 'critical', barText: 'Shallow water table — conventional system unlikely to pass nationally.',
                     alertText: 'Shallow water table — conventional system unlikely to pass nationally', alertLevel: 'critical' },
  wt_shallow:      { barSev: 'warning',  barText: 'Moderately shallow water table — investigate before ordering perc test.',
                     alertText: 'Moderately shallow water table — investigate before ordering perc test', alertLevel: 'warning' },
  wt_moderate:     { barSev: 'warning',  barText: 'Water table at moderate depth — verify seasonal high before ordering perc test.',
                     alertText: 'Water table at moderate depth — verify seasonal high before ordering perc test', alertLevel: 'warning' },
  wt_deep:         { barSev: 'good',     barText: 'Deep water table — no concerns for septic design.' },
  // ── Depth to restrictive layer ──
  restr_bedrock:   { barSev: 'critical', barText: 'Shallow restrictive layer — insufficient depth for standard installation.',
                     alertText: 'Shallow restrictive layer — insufficient depth for standard installation', alertLevel: 'critical' },
  restr_clay:      { barSev: 'critical', barText: 'Shallow clay horizon — conventional system unlikely without mound or alternative design.',
                     alertText: 'Shallow clay horizon — conventional system unlikely without mound or alternative design', alertLevel: 'critical' },
  restr_moderate:  { barSev: 'warning',  barText: 'Restrictive layer at moderate depth — may limit system options.',
                     alertText: 'Restrictive layer at moderate depth — may limit system options', alertLevel: 'warning' },
  restr_deep:      { barSev: 'good',     barText: 'No shallow restrictive layers detected.' },
  // ── Flooding (SSURGO flodfreqcl) ──
  flood_frequent:  { barSev: 'critical', barText: 'Frequent flooding — high flood risk, septic installation not recommended.',
                     alertText: 'High flood risk — septic installation not recommended', alertLevel: 'critical' },
  flood_occasional:{ barSev: 'warning',  barText: 'Occasional flooding possible — verify buildable area.' },
  flood_none:      { barSev: 'good',     barText: 'Flooding not expected — no concerns.' },
  // ── FEMA flood zone ──
  fema_high:       { barSev: 'critical', barText: 'High-risk flood zone — engineered system likely required.',
                     alertText: 'High-risk flood zone — engineered system likely required', alertLevel: 'critical' },
  fema_moderate:   { barSev: 'warning',  barText: 'Partial flood zone — engineered system may be required.',
                     alertText: 'Partial flood zone — engineered system may be required', alertLevel: 'warning' },
  // ── NWI wetland ──
  wetland_high:    { barSev: 'critical', barText: 'Significant wetland overlap — regulatory approval unlikely.',
                     alertText: 'Significant wetland overlap — regulatory approval unlikely', alertLevel: 'critical' },
  wetland_moderate:{ barSev: 'warning',  barText: 'Partial wetland overlap — verify boundaries before ordering test.',
                     alertText: 'Partial wetland overlap — verify boundaries before ordering test', alertLevel: 'warning' },
  // ── Permeability extreme ──
  ksat_extreme:    { barSev: 'critical', barText: 'Extreme permeability — effluent treatment not adequate.',
                     alertText: 'Extreme soil permeability — effluent treatment not adequate', alertLevel: 'critical' },
};

// Maps every fired-gate key string to the band that governs its alert + bar copy.
const GATE_BAND: Record<string, string> = {
  'wt<18in':             'wt_critical',
  'wt18-24in':           'wt_shallow',
  'wt24-36in':           'wt_moderate',
  'restr<20in(bedrock)': 'restr_bedrock',
  'restr<20in(clay)':    'restr_clay',
  'restr20-36in':        'restr_moderate',
  'flodfreq':            'flood_frequent',
  'fema>25%':            'fema_high',
  'fema10-25%':          'fema_moderate',
  'wetland>25%':         'wetland_high',
  'wetland10-25%':       'wetland_moderate',
  'ksat_extreme':        'ksat_extreme',
  'slope>30%':           'slope_steep',
  'slope15-30%':         'slope_marginal',
};

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) =>
      setTimeout(() => rej(new Error(`${label} timed out after ${ms / 1000}s`)), ms)
    ),
  ]);
}

function geojsonToWkt(geojson: Record<string, unknown>): string {
  const geo = (geojson?.type === 'Feature'
    ? (geojson.geometry as Record<string, unknown>)
    : geojson) ?? {};
  const type = geo.type as string;
  if (!type) throw new Error('No geometry type');
  if (type === 'Point') {
    const [pLng, pLat] = geo.coordinates as [number, number];
    const d = 0.002;
    return `POLYGON((${pLng - d} ${pLat - d}, ${pLng + d} ${pLat - d}, ${pLng + d} ${pLat + d}, ${pLng - d} ${pLat + d}, ${pLng - d} ${pLat - d}))`;
  }
  if (type === 'Polygon') {
    const coords = (geo.coordinates as number[][][])[0].map((pt) => `${pt[0]} ${pt[1]}`).join(', ');
    return `POLYGON((${coords}))`;
  }
  if (type === 'MultiPolygon') {
    const coords = (geo.coordinates as number[][][][])[0][0].map((pt) => `${pt[0]} ${pt[1]}`).join(', ');
    return `POLYGON((${coords}))`;
  }
  throw new Error(`Unsupported geometry type: ${type}`);
}

function buildBboxWkt(geometry: Record<string, unknown>): string {
  const geo = (geometry?.type === 'Feature'
    ? (geometry.geometry as Record<string, unknown>)
    : geometry) ?? {};
  const type = geo.type as string;
  const allCoords: number[][] = [];
  const flatten = (arr: unknown) => {
    const a = arr as number[][];
    if (a.length > 0 && typeof a[0][0] === 'number') {
      a.forEach(c => allCoords.push(c));
    } else {
      (a as unknown as unknown[][]).forEach(sub => flatten(sub));
    }
  };
  if (type === 'Polygon') flatten((geo.coordinates as number[][][]));
  else if (type === 'MultiPolygon') flatten((geo.coordinates as number[][][][]));
  else throw new Error(`Cannot build bbox for type: ${type}`);
  const lngs = allCoords.map(c => c[0]);
  const lats = allCoords.map(c => c[1]);
  const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats);
  console.log('[ssurgo] bbox covers extent:', minLng.toFixed(5), maxLng.toFixed(5), minLat.toFixed(5), maxLat.toFixed(5));
  return `POLYGON((${minLng} ${minLat}, ${maxLng} ${minLat}, ${maxLng} ${maxLat}, ${minLng} ${maxLat}, ${minLng} ${minLat}))`;
}

// Thin a POLYGON WKT string to at most maxPts coordinate pairs using uniform stride.
function thinWkt(wkt: string, maxPts = 150): string {
  const match = wkt.match(/^POLYGON\(\((.+)\)\)$/);
  if (!match) return wkt;
  const pairs = match[1].split(',').map(s => s.trim());
  if (pairs.length <= maxPts) return wkt;
  const step = (pairs.length - 1) / (maxPts - 1);
  const thinned: string[] = [];
  for (let i = 0; i < maxPts - 1; i++) thinned.push(pairs[Math.round(i * step)]);
  thinned.push(pairs[pairs.length - 1]); // keep closing coord identical to open
  return `POLYGON((${thinned.join(', ')}))`;
}

function extractCoords(geom: Record<string, unknown>): number[][] {
  const type = geom.type as string;
  const coords = geom.coordinates as unknown;
  if (type === 'Polygon') return (coords as number[][][]).flat();
  if (type === 'MultiPolygon') return (coords as number[][][][]).flat(2);
  return [];
}

// ─── Direct client-side parcel boundary lookup ───────────────────────────────

interface ParcelBoundaryResponse {
  geometry: Record<string, unknown>;
  source: string;
  isApproximate: boolean;
  apn: string | null;
  acreage: number | null;
  owner: string | null;
}

async function fetchParcelBoundary(
  lat: number,
  lng: number,
  _county: string | null,
  _state: string | null,
  authToken: string,
  regridToken: string | null,
): Promise<ParcelBoundaryResponse> {
  // STEP 1: parcel-boundary edge function — uses Regrid v1 which returns full-resolution geometry.
  // v1 returns higher coord counts than v2's generalized responses.
  try {
    const supabaseUrl = (window as unknown as Record<string, unknown>).__SUPABASE_URL__ as string
      ?? import.meta.env.VITE_SUPABASE_URL as string;
    const edgeUrl = `${supabaseUrl}/functions/v1/parcel-boundary`;
    console.log('[regrid v1] calling parcel-boundary edge function');
    const edgeRes = await withTimeout(
      fetch(edgeUrl, {
        method: 'POST',
        headers: { Authorization: `Bearer ${authToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ lat, lng }),
      }),
      20_000, 'parcel-boundary'
    );
    console.log('[regrid v1] status:', edgeRes.status);
    if (edgeRes.ok) {
      const edgeData = await edgeRes.json() as ParcelBoundaryResponse & { geometry?: { type: string } };
      const geom = edgeData.geometry;
      if (geom?.type === 'Polygon' || geom?.type === 'MultiPolygon') {
        const coords = geom.type === 'Polygon'
          ? (geom as unknown as { coordinates: number[][][] }).coordinates[0]
          : (geom as unknown as { coordinates: number[][][][] }).coordinates[0][0];
        console.log('[regrid v1] SUCCESS - coords:', coords.length, 'source:', edgeData.source);
        if (!edgeData.isApproximate) return edgeData;
      }
    }
  } catch (e) {
    console.log('[regrid v1] error:', (e as Error).message);
  }

  // STEP 2: Regrid v2 — direct browser call, lower-resolution geometry but still real boundary
  if (regridToken) {
    try {
      const regridUrl = `https://app.regrid.com/api/v2/parcels/point?lat=${lat}&lon=${lng}&token=${regridToken}&return_geometry=true&limit=1`;
      console.log('[regrid v2] calling point API directly from browser');
      const regridRes = await withTimeout(fetch(regridUrl), 20_000, 'regrid');
      console.log('[regrid v2] status:', regridRes.status);
      const regridText = await regridRes.text();
      console.log('[regrid v2] response preview:', regridText.slice(0, 300));

      if (regridRes.ok) {
        const regridData = JSON.parse(regridText) as {
          parcels?: { features?: Array<{ geometry?: { type: string; coordinates: unknown }; properties?: { fields?: Record<string, unknown> } & Record<string, unknown> }> };
          features?: Array<{ geometry?: { type: string; coordinates: unknown }; properties?: { fields?: Record<string, unknown> } & Record<string, unknown> }>;
        };
        const features = regridData.parcels?.features ?? regridData.features ?? [];
        console.log('[regrid v2] features:', features.length);

        if (features.length > 0) {
          const feature = features[0];
          const geometry = feature.geometry;
          const props = feature.properties?.fields ?? feature.properties ?? {};
          console.log('[regrid v2] geometry type:', geometry?.type);

          if (geometry?.type === 'Polygon' || geometry?.type === 'MultiPolygon') {
            console.log('[regrid v2] SUCCESS - returning real boundary');
            return {
              geometry: geometry as Record<string, unknown>,
              source: 'regrid',
              isApproximate: false,
              apn: (props.parcelnumb as string | null) ?? null,
              acreage: (props.ll_gisacre as number | null) ?? (props.gisacre as number | null) ?? null,
              owner: (props.owner as string | null) ?? null,
            };
          }
        }
      }
    } catch (e) {
      console.log('[regrid v2] error:', (e as Error).message);
    }
  } else {
    console.log('[regrid v2] NO TOKEN - skipping');
  }

  // STEP 2: FCC census block bbox fallback
  console.log('[fcc] trying fallback');
  try {
    const fccUrl = `https://geo.fcc.gov/api/census/block/find?latitude=${lat}&longitude=${lng}&format=json&showall=true`;
    const fccRes = await withTimeout(fetch(fccUrl), 10_000, 'fcc');
    const fccData = await fccRes.json() as { Block?: { bbox?: number[] } };
    if (fccData.Block?.bbox && fccData.Block.bbox.length >= 4) {
      const [minLng, minLat, maxLng, maxLat] = fccData.Block.bbox;
      console.log('[fcc] returning bbox fallback');
      return {
        geometry: {
          type: 'Polygon',
          coordinates: [[[minLng, minLat],[maxLng, minLat],[maxLng, maxLat],[minLng, maxLat],[minLng, minLat]]],
        },
        source: 'fcc-census-block',
        isApproximate: true,
        apn: null, acreage: null, owner: null,
      };
    }
  } catch (e) {
    console.log('[fcc] error:', (e as Error).message);
  }

  // STEP 3: tiny bbox final fallback
  const d = 0.002;
  console.log('[fallback] using tiny bbox');
  return {
    geometry: {
      type: 'Polygon',
      coordinates: [[[lng - d, lat - d],[lng + d, lat - d],[lng + d, lat + d],[lng - d, lat + d],[lng - d, lat - d]]],
    },
    source: 'point-fallback',
    isApproximate: true,
    apn: null, acreage: null, owner: null,
  };
}

// ─── Summarize explanations into max 6 categorized bullets ──────────────────

interface ExplanationGroups {
  positive: string[];
  concerns: string[];
  gaps: string[];
}

function categorizeExplanations(explanations: string[], nearbyCount: number): ExplanationGroups {
  const positive: string[] = [];
  const concerns: string[] = [];
  const gaps: string[] = [];

  const seen = new Set<string>();
  const dedup = (s: string) => {
    // Collapse similar messages by key phrase
    const key = s.toLowerCase().slice(0, 40);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  };

  for (const exp of explanations) {
    if (!dedup(exp)) continue;
    const l = exp.toLowerCase();
    const isGap = /not available|no data|unknown|neutral score|no nearby|no local|no county/i.test(exp);
    const isPos = /ideal|well drained|well drain|favorable|above|not limited|slight|passing|permit.*allow/i.test(exp);
    const isNeg = /very limited|severe|unsuitable|very slow|too slow|too fast|inadequate|very fast|poorly drained|shallow|below|capped|not permit|not allow/i.test(exp);

    if (isGap) {
      gaps.push(exp);
    } else if (isPos) {
      positive.push(exp);
    } else if (isNeg) {
      concerns.push(exp);
    } else {
      concerns.push(exp);
    }
  }

  if (nearbyCount === 0 && !gaps.some(g => /nearby|local test/i.test(g))) {
    gaps.push('No nearby perc test history on file for this county yet');
  }

  return {
    positive: positive.slice(0, 2),
    concerns: concerns.slice(0, 3),
    gaps: gaps.slice(0, 2),
  };
}

// ─── Generate plain-English summary paragraph ────────────────────────────────

function generateSummary(
  convScore: number | null,
  altScore: number | null,
  soilResults: SoilResult[],
  scoreResult: ScoreResult | null,
  county: string | null,
): string {
  if (convScore === null || altScore === null) return '';

  const countyName = county ? `${county} County` : 'this county';

  // Dominant drainage class
  const dominant = soilResults[0];
  const drainage = dominant?.drainage_class?.toLowerCase() ?? '';
  const drainagePhrase = drainage.includes('well') ? 'drains well'
    : drainage.includes('poor') || drainage.includes('very poor') ? 'drains poorly'
    : drainage.includes('somewhat poor') ? 'has marginal drainage'
    : 'has moderate drainage';

  // Permeability note
  const ksat = dominant?.ksat_r ?? dominant?.ksat_high ?? dominant?.ksat_low ?? null;
  let permPhrase = '';
  if (ksat !== null) {
    if (ksat > 14) permPhrase = 'Permeability is faster than ideal, which can reduce effluent treatment effectiveness.';
    else if (ksat < 0.42) permPhrase = 'The soil has slow permeability, limiting absorption capacity.';
    else permPhrase = 'Permeability is within a suitable range for septic systems.';
  }

  // Recommendation
  let rec = '';
  if (convScore > 65) {
    rec = 'A conventional system is likely feasible.';
  } else if (convScore >= 35 && altScore >= 35) {
    rec = 'A conventional system is possible but not guaranteed. An alternative system (mound or drip) may be the more reliable path.';
  } else if (altScore >= 35) {
    rec = 'A conventional system faces significant limitations. An alternative system (mound or drip) should be explored.';
  } else {
    rec = 'Both conventional and alternative systems face significant limitations at this site.';
  }

  const nearby = scoreResult?.nearby_tests_summary?.matching_within_5mi ?? 0;
  const nearbyNote = nearby > 0
    ? `${nearby} nearby parcel${nearby > 1 ? 's' : ''} with similar soils have been tested in this area.`
    : 'No nearby perc test history is available for comparison.';

  return `This parcel in ${countyName} shows ${convScore > 65 ? 'generally favorable' : convScore >= 35 ? 'mixed' : 'challenging'} septic suitability. The soil ${drainagePhrase}. ${permPhrase} ${rec} ${nearbyNote} A formal site evaluation by a licensed soil scientist is recommended before purchase or development.`.trim();
}

// ─── Wetland/water detection from soil drainage data ─────────────────────────

function detectWetlandFlag(soilResults: SoilResult[]): boolean {
  const poorDrainageClasses = ['very poorly drained', 'poorly drained'];
  const wetCoverage = soilResults
    .filter(r => poorDrainageClasses.includes((r.drainage_class ?? '').toLowerCase().trim()))
    .reduce((sum, r) => sum + (r.pct_coverage ?? 0), 0);
  return wetCoverage > 20;
}

// ─── ScoreGauge ─────────────────────────────────────────────────────────────

function ScoreGauge({ score, label, verdict, animate }: { score: number | null; label: string; verdict?: string; animate?: boolean }) {
  const [display, setDisplay] = useState(animate ? 0 : (score ?? 0));

  useEffect(() => {
    if (!animate || score === null) {
      setDisplay(score ?? 0);
      return;
    }
    const duration = 1200;
    const steps = 60;
    const interval = duration / steps;
    let step = 0;
    const timer = setInterval(() => {
      step++;
      const eased = 1 - Math.pow(1 - step / steps, 3);
      setDisplay(Math.round(score * eased));
      if (step >= steps) { clearInterval(timer); setDisplay(score); }
    }, interval);
    return () => clearInterval(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [animate, score]);

  const pct = score != null ? Math.min(100, Math.max(0, display)) : 0;
  const color = scoreColor(score);
  const radius = 56;
  const circ = 2 * Math.PI * radius;
  const offset = circ - (pct / 100) * circ;

  return (
    <div className="flex flex-col items-center gap-2 flex-1">
      <div className="relative w-36 h-36">
        <svg className="w-36 h-36 -rotate-90" viewBox="0 0 128 128">
          <circle cx="64" cy="64" r={radius} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="11" />
          <circle
            cx="64" cy="64" r={radius} fill="none"
            stroke={color} strokeWidth="11"
            strokeLinecap="round"
            strokeDasharray={circ}
            strokeDashoffset={score !== null ? offset : circ}
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          {score !== null ? (
            <>
              <span className="text-4xl font-bold tracking-tight" style={{ color }}>{display}</span>
              <span className="text-xs font-semibold mt-0.5 uppercase tracking-wide" style={{ color, opacity: 0.85 }}>{scoreLabel(score)}</span>
            </>
          ) : (
            <span className="text-white/25 text-sm">—</span>
          )}
        </div>
      </div>
      <div className="text-center px-1">
        <p className="text-xs font-semibold text-white/70">{label}</p>
        {verdict && <p className="text-[11px] text-white/35 leading-snug mt-1">{verdict}</p>}
      </div>
    </div>
  );
}

function ScoreGaugeSkeleton({ label }: { label: string }) {
  return (
    <div className="flex flex-col items-center gap-2 flex-1">
      <div className="relative w-36 h-36">
        <svg className="w-36 h-36 -rotate-90" viewBox="0 0 128 128">
          <circle cx="64" cy="64" r="56" fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="11" />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <div style={{ width: 72, height: 72, borderRadius: '50%', border: '2px solid rgba(255,255,255,0.10)', background: 'rgba(255,255,255,0.05)' }} />
        </div>
      </div>
      <div className="text-center px-1">
        <p className="text-xs font-semibold text-white/70">{label}</p>
        <p className="text-white/25 text-lg font-bold mt-0.5">--</p>
      </div>
    </div>
  );
}

// ─── RatingCell ──────────────────────────────────────────────────────────────

function ratingToBucket(nrcsRating: string | null): SoilBucket {
  if (!nrcsRating) return 'no-data';
  const l = nrcsRating.toLowerCase();
  if (l.includes('not limited') || l.includes('slight') || l.includes('suit') || l.includes('good')) return 'viable';
  if (l.includes('somewhat') || l.includes('moderate')) return 'engineering-needed';
  if (l.includes('very limited') || l.includes('poor') || l.includes('severe') || l.includes('unsuitable')) return 'not-suitable';
  return 'no-data';
}

function RatingCell({ rating }: { rating: string | null }) {
  const bucket = ratingToBucket(rating);
  const cls = {
    'viable':             'bg-primary-500/15 text-primary-400 border-primary-500/30',
    'engineering-needed': 'bg-amber-500/15 text-amber-400 border-amber-500/30',
    'not-suitable':       'bg-danger-500/15 text-danger-400 border-danger-500/30',
    'no-data':            'bg-white/5 text-white/20 border-white/10',
  }[bucket];
  const label = rating ?? 'Not rated';
  const title = rating ? undefined : 'NC septic suitability rating not available for this soil unit';
  return (
    <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium border ${cls}`} title={title}>
      {label}
    </span>
  );
}

// ─── Pipeline progress ───────────────────────────────────────────────────────

function StepIcon({ status }: { status: StepStatus }) {
  if (status === 'done') return <CheckCircle className="w-4 h-4 text-primary-400" />;
  if (status === 'error') return <XCircle className="w-4 h-4 text-danger-400" />;
  if (status === 'skipped') return <AlertTriangle className="w-4 h-4 text-amber-400" />;
  if (status === 'running') return <RefreshCw className="w-4 h-4 text-amber-400 animate-spin" />;
  return <Circle className="w-4 h-4 text-white/15" />;
}

function PipelineProgress({ pipeline }: { pipeline: PipelineState }) {
  const steps = [
    { status: pipeline.step1, label: 'Locating parcel & geocoding address' },
    { status: pipeline.step2, label: 'Querying USDA soil database (SSURGO)' },
    { status: pipeline.step3, label: 'Calculating suitability scores' },
  ];
  return (
    <div className="flex flex-col items-center justify-center flex-1 py-16 px-8 space-y-6">
      <div className="w-14 h-14 bg-amber-500/10 rounded-2xl flex items-center justify-center mb-2">
        <RefreshCw className="w-7 h-7 text-amber-400 animate-spin" />
      </div>
      <div className="text-center">
        <h3 className="text-base font-semibold mb-1">Analyzing Parcel</h3>
        <p className="text-white/40 text-sm">This usually takes 15–30 seconds</p>
      </div>
      <div className="w-full max-w-xs space-y-4">
        {steps.map(({ status, label }, i) => (
          <div key={i} className="flex items-start gap-3">
            <div className="mt-0.5 flex-shrink-0"><StepIcon status={status} /></div>
            <span className={`text-sm leading-snug transition-colors ${
              status === 'done' || status === 'skipped' ? 'text-white/40' :
              status === 'running' ? 'text-white' :
              status === 'error' ? 'text-danger-400' : 'text-white/25'
            }`}>{label}</span>
          </div>
        ))}
      </div>
      {pipeline.error && (
        <div className="w-full max-w-xs bg-danger-500/10 border border-danger-500/30 rounded-xl p-3">
          <p className="text-xs text-danger-400 text-center">{pipeline.error}</p>
        </div>
      )}
    </div>
  );
}

// ─── Soil overlay computation ─────────────────────────────────────────────────

type SoilBucket = 'viable' | 'engineering-needed' | 'not-suitable' | 'no-data';

interface SoilPolygon {
  geojson: turf.Feature<turf.Polygon | turf.MultiPolygon>;       // clipped to parcel — used for scoring
  displayGeojson: turf.Feature<turf.Polygon | turf.MultiPolygon>; // full SSURGO polygon — used for display
  fill: string;
  fillOpacity: number;
  bucket: SoilBucket;
  result: SoilResult | null; // null = no tabular data matched
  mukey: string;
}

interface ExclusionResult {
  geojson: turf.Feature<turf.Polygon | turf.MultiPolygon> | null;
  hasWet: boolean;
  hasSteep: boolean;
}

interface BestZone {
  label: 'Primary' | 'Alternative' | 'Third';
  centroid: [number, number];
  geojson: turf.Feature<turf.Polygon | turf.MultiPolygon>;
  soilName: string;
  drainageText: string;
  bucket: SoilBucket;
  areaSqM: number;
  fill: string;
  mukey: string;
}

// Convert SSURGO WFS feature's mukey (stored in properties)
function getMukey(props: Record<string, unknown>): string {
  return String(props.mukey ?? props.MUKEY ?? props.Mukey ?? '');
}

function toParcelFeature(boundary: Record<string, unknown>): turf.Feature<turf.Polygon | turf.MultiPolygon> {
  const t = boundary.type as string;
  if (t === 'Feature') return boundary as unknown as turf.Feature<turf.Polygon | turf.MultiPolygon>;
  return turf.feature(boundary as unknown as turf.Polygon | turf.MultiPolygon);
}

function drainageToPlain(dc: string | null): string {
  if (!dc) return 'unknown drainage';
  const l = dc.toLowerCase();
  if (l.includes('well drained') && !l.includes('mod') && !l.includes('some')) return 'good drainage';
  if (l.includes('moderately well')) return 'adequate drainage';
  if (l.includes('somewhat poorly')) return 'marginal drainage';
  if (l.includes('poorly')) return 'poor drainage — challenging';
  return dc.toLowerCase();
}

// Returns direction label from centroid relative to parcel bbox center
function relativeDirection(centroid: [number, number], parcelFeature: turf.Feature<turf.Polygon | turf.MultiPolygon>): string {
  const bbox = turf.bbox(parcelFeature);
  const cx = (bbox[0] + bbox[2]) / 2;
  const cy = (bbox[1] + bbox[3]) / 2;
  const dx = centroid[0] - cx;
  const dy = centroid[1] - cy;
  const threshold = 0.0001;
  if (Math.abs(dx) < threshold && Math.abs(dy) < threshold) return 'central';
  const ns = dy > 0 ? 'northern' : 'southern';
  const ew = dx > 0 ? 'eastern' : 'western';
  if (Math.abs(dy) > Math.abs(dx) * 1.5) return ns;
  if (Math.abs(dx) > Math.abs(dy) * 1.5) return ew;
  return `${ns}-${ew}`;
}

// ---------------------------------------------------------------------------
// DEM / terrain helpers — module-level so buildSoilPolygons can call them.
// Pure: only touch their map/coordinate parameters, no component state.
// ---------------------------------------------------------------------------

async function waitForDEM(map: mapboxgl.Map, timeoutMs = 5000): Promise<{ ready: boolean; wasActive: boolean }> {
  if (!map.getSource('mapbox-dem')) {
    map.addSource('mapbox-dem', {
      type: 'raster-dem',
      url: 'mapbox://mapbox.mapbox-terrain-dem-v1',
      tileSize: 512,
      maxzoom: 14,
    });
  }
  const wasActive = !!map.getTerrain();
  if (!wasActive) {
    map.setTerrain({ source: 'mapbox-dem', exaggeration: 1 });
  }
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const test = map.queryTerrainElevation(map.getCenter().toArray() as [number, number]);
    if (test !== null && test !== 0) return { ready: true, wasActive };
    await new Promise(r => setTimeout(r, 150));
  }
  return { ready: false, wasActive };
}

function cleanupDEM(map: mapboxgl.Map, wasActive: boolean) {
  if (!wasActive) {
    map.setTerrain(null);
  }
}

function getActualSlope(map: mapboxgl.Map, lng: number, lat: number): number | null {
  try {
    const center = map.queryTerrainElevation([lng, lat]);
    const north  = map.queryTerrainElevation([lng, lat + 0.00009]);
    const south  = map.queryTerrainElevation([lng, lat - 0.00009]);
    const east   = map.queryTerrainElevation([lng + 0.00011, lat]);
    const west   = map.queryTerrainElevation([lng - 0.00011, lat]);
    if (center === null || north === null || south === null || east === null || west === null) return null;
    const rise_ns = Math.abs(north - south);
    const rise_ew = Math.abs(east - west);
    const maxRise = Math.max(rise_ns, rise_ew);
    return (maxRise / 20) * 100;
  } catch {
    return null;
  }
}

// Sample a grid of candidate points inside a polygon for DEM slope estimation.
// Returns [lng, lat] pairs that fall within the polygon geometry.
function samplePointsInPolygon(
  poly: turf.Feature<turf.Polygon | turf.MultiPolygon>,
  gridN = 3,
): [number, number][] {
  const [minLng, minLat, maxLng, maxLat] = turf.bbox(poly);
  const pts: [number, number][] = [];
  for (let r = 0; r < gridN; r++) {
    for (let c = 0; c < gridN; c++) {
      const lng = minLng + (maxLng - minLng) * ((c + 0.5) / gridN);
      const lat = minLat + (maxLat - minLat) * ((r + 0.5) / gridN);
      try {
        if (turf.booleanPointInPolygon(turf.point([lng, lat]), poly)) pts.push([lng, lat]);
      } catch { /* skip bad geometry */ }
    }
  }
  return pts;
}

async function buildSoilPolygons(
  wfsFeatures: turf.Feature[],
  parcelBoundary: Record<string, unknown>,
  soilResults: SoilResult[],
  floodFeatures: turf.Feature<turf.Polygon | turf.MultiPolygon>[],
  wetlandFeatures: turf.Feature<turf.Polygon | turf.MultiPolygon>[],
  floodUnion: turf.Feature<turf.Polygon | turf.MultiPolygon> | null,
  wetlandUnion: turf.Feature<turf.Polygon | turf.MultiPolygon> | null,
  map: mapboxgl.Map | null = null,
): Promise<SoilPolygon[]> {
  if (!wfsFeatures.length) return [];

  const resultByMukey = new Map<string, SoilResult>();
  for (const r of soilResults) {
    if (r.map_unit_key) resultByMukey.set(r.map_unit_key, r);
  }

  // ── DEM slope availability check ─────────────────────────────────────────
  // Attempt to activate DEM with a 3s timeout (shorter than perc-pin's 5s since
  // this runs during the background scoring pass, not a user-triggered action).
  // If DEM isn't ready in time, all zones fall back to SSURGO slope gracefully.
  let slopeFromDem: ((lng: number, lat: number) => number | null) | null = null;
  if (map) {
    const { ready: demReady } = await waitForDEM(map, 3000);
    if (demReady) {
      slopeFromDem = (lng, lat) => getActualSlope(map, lng, lat);
      console.log('[score] DEM ready — zone slopes will use DEM sampling');
    } else {
      console.log('[score] DEM not ready within 3s — zone slopes will use SSURGO fallback');
    }
  } else {
    console.log('[score] no map instance — zone slopes will use SSURGO fallback');
  }

  const parcelFeature = toParcelFeature(parcelBoundary);
  const bbox = turf.bbox(parcelFeature);
  // Rewind the full parcel feature once (supports both Polygon and MultiPolygon).
  const parcelClipFeature = turf.rewind(
    parcelFeature as turf.Feature<turf.Polygon | turf.MultiPolygon>,
    { reverse: false, mutate: false }
  );
  console.log('[clip] using full MultiPolygon for intersection — sub-polygon iteration removed');
  console.log('[bbox] parcel geometry type:', parcelFeature.geometry.type);
  console.log('[bbox] parcel bbox:', bbox);
  const polygons: SoilPolygon[] = [];
  let bboxPassCount = 0;
  let intersectCount = 0;

  const t0 = performance.now();

  for (let idx = 0; idx < wfsFeatures.length; idx++) {
    // Yield every 10 iterations to keep the UI responsive
    if (idx > 0 && idx % 10 === 0) {
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      console.log('[perf] yielded at polygon', idx, 'of', wfsFeatures.length);
    }

    const feat = wfsFeatures[idx];
    if (!feat.geometry) continue;
    try {
      const soilF = feat.type === 'Feature'
        ? feat as turf.Feature<turf.Polygon | turf.MultiPolygon>
        : turf.feature(feat as unknown as turf.Polygon | turf.MultiPolygon, feat.properties ?? {});

      const [fMinX, fMinY, fMaxX, fMaxY] = turf.bbox(soilF);
      const passesBbox = !(fMaxX < bbox[0] || fMinX > bbox[2] || fMaxY < bbox[1] || fMinY > bbox[3]);
      if (idx < 100) {
        const featMukey = (feat.properties as Record<string,unknown>)?.mukey;
        console.log('[bbox] idx:', idx, 'mukey:', featMukey, 'geomType:', soilF.geometry.type,
          'featureBbox:', [fMinX, fMinY, fMaxX, fMaxY], 'passes:', passesBbox);
      }
      if (!passesBbox) continue;
      bboxPassCount++;

      // Explode SSURGO MultiPolygon into individual Polygon features.
      // turf.intersect only accepts Polygon input — MultiPolygon silently fails or throws.
      const mukey = (feat.properties as Record<string,unknown>)?.mukey;
      const ssurgoPolygons: turf.Feature<turf.Polygon>[] = [];
      if (soilF.geometry.type === 'MultiPolygon') {
        (soilF.geometry.coordinates as number[][][][]).forEach(coords => {
          ssurgoPolygons.push(turf.polygon(coords, soilF.properties ?? {}));
        });
        console.log('[clip] SSURGO MultiPolygon — exploded to', ssurgoPolygons.length, 'parts for mukey:', mukey);
      } else {
        ssurgoPolygons.push(soilF as turf.Feature<turf.Polygon>);
      }

      let clipped: turf.Feature<turf.Polygon | turf.MultiPolygon> | null = null;

      // Intersect each SSURGO polygon piece against the full parcel feature (Polygon or MultiPolygon).
      // Union all intersecting patches so a multi-part mukey is preserved as a proper MultiPolygon
      // rather than dropping all patches after the first.
      for (const ssurgoPoly of ssurgoPolygons) {
        const cleanSoil = turf.rewind(ssurgoPoly, { reverse: false });
        try {
          const candidate = turf.intersect(turf.featureCollection([parcelClipFeature, cleanSoil]));
          if (!candidate) continue;
          if (clipped === null) {
            clipped = candidate;
          } else {
            const unioned = turf.union(turf.featureCollection([clipped, candidate]));
            if (unioned) clipped = unioned;
          }
        } catch (e) {
          console.log('[clip] intersect error for mukey:', mukey, (e as Error).message);
        }
      }
      if (ssurgoPolygons.length > 1) {
        console.log('[clip] multi-part mukey:', mukey, 'patches:', ssurgoPolygons.length,
          '→ clipped type:', clipped?.geometry.type ?? 'null');
      }
      if (!clipped) continue;
      intersectCount++;
      clipped.properties = { ...(feat.properties ?? {}) };

      const props = (feat.properties ?? {}) as Record<string, unknown>;
      const mukeyStr = getMukey(props);
      const result = resultByMukey.get(mukeyStr) ?? null;

      // Merge SSURGO tabular data into polygon properties for scorer
      if (result) {
        const raw = (result.raw_ssurgo ?? {}) as Record<string, unknown>;
        clipped.properties = {
          ...clipped.properties,
          drainagecl: result.drainage_class ?? props.drainagecl,
          ksat_r: result.ksat_r ?? result.ksat_high ?? props.ksat_r,
          ksat_h: result.ksat_high ?? props.ksat_h,
          ksat_l: result.ksat_low ?? props.ksat_l,
          slope_h: result.slope_high ?? props.slope_h,
          slope_r: result.slope_high ?? props.slope_r,
          // water_table_depth = true seasonal high water table (cosoilmoist); DO NOT use depth_water_table here
          wtdepannmin: result.water_table_depth ?? props.wtdepannmin,
          pondfreqcl: raw.pondfreqcl ?? props.pondfreqcl ?? null,
          flodfreqcl: raw.flodfreqcl ?? props.flodfreqcl ?? null,
          resdept_r: raw.resdept_r ?? props.resdept_r ?? null,
          reskind: raw.reskind ?? props.reskind ?? null,
          clay40_depth_cm: result.clay40_depth_cm ?? null,
        };
      }

      // ── Zone-level DEM slope ──────────────────────────────────────────────
      // Sample DEM at a grid of points inside this polygon and take the median.
      // Median is robust against single-cell outliers (cliff edges, data holes).
      let zoneSlopeDemPct: number | null = null;
      if (slopeFromDem) {
        const pts = samplePointsInPolygon(clipped);
        const slopes = pts
          .map(([lng, lat]) => slopeFromDem!(lng, lat))
          .filter((s): s is number => s !== null);
        if (slopes.length > 0) {
          slopes.sort((a, b) => a - b);
          zoneSlopeDemPct = slopes[Math.floor(slopes.length / 2)];
        }
      }
      const rawSlopeSsurgoPct = clipped.properties.slope_h != null
        ? parseFloat(clipped.properties.slope_h as string) || null : null;
      // Store both slope values on properties so scoreSoilPolygon can read them
      clipped.properties.zoneSlopeDemPct = zoneSlopeDemPct;
      clipped.properties.rawSlopeSsurgoPct = rawSlopeSsurgoPct;

      const scored = scoreSoilPolygon(clipped.properties as Record<string, unknown>, mukeyStr, floodUnion, floodFeatures, wetlandUnion, wetlandFeatures, clipped);
      const { bucket, finalScore, ceiling: scoredCeiling, firedGates: scoredGates, drainageScore, ksatScore, slopeScore, watertableScore, pondingScore, restrictiveLayerScore, floodingScore, floodOverlapPct, wetlandOverlapPct } = scored;

      clipped.properties.suitabilityScore = finalScore;
      clipped.properties.bucket = bucket;
      clipped.properties.drainageScore = drainageScore;
      clipped.properties.ksatScore = ksatScore;
      clipped.properties.slopeScore = slopeScore;
      clipped.properties.watertableScore = watertableScore;
      clipped.properties.pondingScore = pondingScore;
      clipped.properties.restrictiveLayerScore = restrictiveLayerScore;
      clipped.properties.floodingScore = floodingScore;
      clipped.properties.floodOverlapPct = floodOverlapPct;
      clipped.properties.wetlandOverlapPct = wetlandOverlapPct;
      clipped.properties.mukey = mukeyStr;
      // Gate output stored for site alerts — single source of truth
      clipped.properties.firedGates = JSON.stringify(scoredGates);
      clipped.properties.gatingCeiling = scoredCeiling;
      // raw values preserved for factor bar display (NOT used by site alerts)
      // wtdepannmin is set to result.water_table_depth (inches) by enrichment above, or null if no data
      clipped.properties.rawWatertableInches = clipped.properties.wtdepannmin != null ? parseFloat(clipped.properties.wtdepannmin as string) || null : null;
      clipped.properties.rawResdeptCm = clipped.properties.resdept_r != null ? parseFloat(clipped.properties.resdept_r as string) || null : null;
      clipped.properties.rawFlodfreqcl = clipped.properties.flodfreqcl ?? null;
      clipped.properties.rawSlopePct = clipped.properties.rawSlopeSsurgoPct ?? (clipped.properties.slope_h != null ? parseFloat(clipped.properties.slope_h as string) || null : null);
      // zoneSlopeDemPct already stored on properties before scoreSoilPolygon was called
      clipped.properties.clay40DepthCm = clipped.properties.clay40_depth_cm != null && clipped.properties.clay40_depth_cm !== 'null'
        ? parseFloat(clipped.properties.clay40_depth_cm as string) || null : null;
      clipped.properties.rawKsat = clipped.properties.ksat_r != null ? parseFloat(clipped.properties.ksat_r as string) || null
        : clipped.properties.ksat_h != null ? parseFloat(clipped.properties.ksat_h as string) || null : null;
      console.log('[alerts] mukey', mukeyStr, 'gates_fired:', scoredGates.length ? scoredGates.join(' ') : 'none', 'ceiling:', scoredCeiling);

      // Copy scoring properties onto a display copy of the full unclipped SSURGO polygon.
      // Large parcels often have many small clipped slivers that leave visual gaps — the full
      // polygon is masked to the parcel boundary by the world mask layer added below.
      const displayGeojson: turf.Feature<turf.Polygon | turf.MultiPolygon> = {
        ...soilF,
        properties: { ...clipped.properties },
      };

      polygons.push({
        geojson: clipped,
        displayGeojson,
        fill: BUCKET_FILL[bucket].fill,
        fillOpacity: BUCKET_FILL[bucket].fillOpacity,
        bucket,
        result,
        mukey: mukeyStr,
      });
    } catch { continue; }
  }

  const t1 = performance.now();
  console.log('[perf] bbox pass count:', bboxPassCount, 'of', wfsFeatures.length);
  console.log('[perf] actual intersects:', intersectCount);
  console.log('[perf] scoring complete:', Math.round(t1 - t0) + 'ms');
  const geomTypeCounts = wfsFeatures.reduce((acc, f) => {
    const t = (f as {geometry?: {type?: string}}).geometry?.type ?? 'null';
    acc[t] = (acc[t] ?? 0) + 1;
    return acc;
  }, {} as Record<string, number>);
  console.log('[bbox] geometry type counts in full WFS response:', geomTypeCounts);

  const totalArea = polygons.reduce((s, p) => s + turf.area(p.geojson), 0);
  const weightedSum = polygons.reduce((s, p) => {
    const score = (p.geojson.properties as Record<string, unknown>)?.suitabilityScore as number ?? 0;
    return s + score * turf.area(p.geojson);
  }, 0);
  const parcelScore = totalArea > 0 ? Math.round(weightedSum / totalArea) : 0;
  console.log('[buildSoilPolygons] clipped results:', polygons.length, '/ total:', wfsFeatures.length);
  console.log('[score] parcel overall:', parcelScore, 'from', polygons.length, 'polygons');

  // Build per-mukey DEM slope map so the caller can pass it to the edge function.
  const demSlopeByMukey: Record<string, number | null> = {};
  for (const poly of polygons) {
    const rawDem = poly.geojson.properties?.zoneSlopeDemPct;
    demSlopeByMukey[poly.mukey] = rawDem != null && rawDem !== 'null' ? Number(rawDem) : null;
  }
  console.log('[score] demSlopeByMukey:', JSON.stringify(demSlopeByMukey));

  return { polygons, demSlopeByMukey };
}

// Build exclusion zone overlay
function buildExclusionZone(
  parcelBoundary: Record<string, unknown>,
  soilResults: SoilResult[],
): ExclusionResult {
  const parcelFeature = toParcelFeature(parcelBoundary);
  const exclusionParts: turf.Feature<turf.Polygon | turf.MultiPolygon>[] = [];
  let hasWet = false;
  let hasSteep = false;

  // A) Property line setback — 5ft visual inset only
  try {
    const inset = turf.buffer(parcelFeature, -5, { units: 'feet' });
    if (inset) {
      const setback = turf.difference(turf.featureCollection([parcelFeature, inset]));
      if (setback) exclusionParts.push(setback);
    }
  } catch { /* ignore */ }

  // B) Poorly-drained soils — only flag if they cover >15% of parcel
  const poorDrainClasses = ['very poorly drained', 'poorly drained'];
  const totalPct = soilResults.reduce((s, r) => s + (r.pct_coverage ?? 0), 0);
  const wetPct = soilResults
    .filter(r => poorDrainClasses.includes((r.drainage_class ?? '').toLowerCase().trim()))
    .reduce((s, r) => s + (r.pct_coverage ?? 0), 0);
  if (totalPct > 0 && (wetPct / totalPct) > 0.15) hasWet = true;

  // C) Steep slope exclusion — only flag if slope_h > 30%
  for (const r of soilResults) {
    if ((r.slope_high ?? 0) > 30) hasSteep = true;
  }

  if (exclusionParts.length === 0) return { geojson: null, hasWet, hasSteep };

  let merged: turf.Feature<turf.Polygon | turf.MultiPolygon> | null = null;
  try {
    if (exclusionParts.length === 1) {
      merged = exclusionParts[0];
    } else {
      let acc = exclusionParts[0];
      for (let i = 1; i < exclusionParts.length; i++) {
        const u = turf.union(turf.featureCollection([acc, exclusionParts[i]]));
        if (u) acc = u;
      }
      merged = acc;
    }
  } catch { /* ignore */ }

  return { geojson: merged, hasWet, hasSteep };
}

// Find best viable zones from soil polygons — always returns something if any polygon exists
function computeBestZones(
  soilPolygons: SoilPolygon[],
  parcelBoundary: Record<string, unknown>,
  floodPolygons: turf.Feature<turf.Polygon | turf.MultiPolygon>[] = [],
  silent = false,
): { zones: BestZone[]; isFallbackZone: boolean } {
  const parcelFeature = toParcelFeature(parcelBoundary);
  const zones: BestZone[] = [];

  const getScore = (p: SoilPolygon): number =>
    (p.geojson.properties as Record<string, unknown>)?.suitabilityScore as number ?? 0;

  const pushZone = (cand: SoilPolygon, label: 'Primary' | 'Alternative' | 'Third') => {
    const areaSqM = turf.area(cand.geojson);
    let centroid: [number, number];
    try {
      // Subtract flood polygons to find a flood-free sub-region for pin placement
      let pinTarget: turf.Feature<turf.Polygon | turf.MultiPolygon> = cand.geojson;
      if (floodPolygons.length > 0) {
        try {
          let remainder: turf.Feature<turf.Polygon | turf.MultiPolygon> = cand.geojson;
          for (const fp of floodPolygons) {
            const diff = turf.difference(turf.featureCollection([remainder, fp]));
            if (diff) remainder = diff;
          }
          const cleanArea = turf.area(remainder);
          const origArea = turf.area(cand.geojson);
          if (cleanArea / origArea >= 0.20) {
            pinTarget = remainder;
            console.log('[pin] using flood-free remainder for centroid:', Math.round(cleanArea), 'sqm');
          } else {
            console.log('[pin] flood-free area too small, using full polygon');
          }
        } catch (e) {
          console.warn('[pin] difference failed:', (e as Error).message);
        }
      }
      const c = turf.centroid(pinTarget);
      const isInside = turf.booleanPointInPolygon(c, cand.geojson);
      console.log('[pin] best zone pin inside polygon:', isInside, 'using:', isInside ? 'centroid' : 'pointOnFeature');
      const pin = isInside ? c : turf.pointOnFeature(pinTarget);
      centroid = pin.geometry.coordinates as [number, number];
    } catch { return; }
    const r = cand.result;
    const soilName = r?.map_unit_name ?? r?.map_unit_key ?? 'Soil unit';
    const drainageText = drainageToPlain(r?.drainage_class ?? null);
    const direction = relativeDirection(centroid, parcelFeature);
    zones.push({
      label, centroid, geojson: cand.geojson, soilName, drainageText,
      bucket: cand.bucket, areaSqM, fill: cand.fill, direction,
      mukey: cand.mukey,
    } as BestZone & { direction: string });
  };

  const MIN_SQM = 70;
  const MIN_ZONE_AREA_SQM = 300; // filter out SSURGO boundary slivers; 300 sqm supports small parcels

  // Sort by suitabilityScore desc, tiebreak by area — never pick not-suitable or no-data
  const candidates = soilPolygons
    .filter(p => p.bucket === 'viable' || p.bucket === 'engineering-needed')
    .filter(p => turf.area(p.geojson) >= MIN_SQM)
    .sort((a, b) => {
      const scoreDiff = getScore(b) - getScore(a);
      return scoreDiff !== 0 ? scoreDiff : turf.area(b.geojson) - turf.area(a.geojson);
    });

  const labelOrder: ('Primary' | 'Alternative' | 'Third')[] = ['Primary', 'Alternative', 'Third'];
  for (const cand of candidates) {
    if (zones.length >= 3) break;
    const candArea = turf.area(cand.geojson);
    if (candArea < MIN_ZONE_AREA_SQM) {
      console.log('[zones] skipping zone — area too small for badge:', Math.round(candArea), 'sqm (min', MIN_ZONE_AREA_SQM, ')');
      continue;
    }
    pushZone(cand, labelOrder[zones.length]);
    console.log('[zones] best zone score:', getScore(cand), 'bucket:', cand.bucket, 'area:', Math.round(candArea), 'sqm');
  }

  if (zones.length > 0) return { zones, isFallbackZone: false };

  if (!silent) console.log('[zones] no viable zones found — parcel is not suitable');
  return { zones: [], isFallbackZone: false };
}

// ─── MapPanel ────────────────────────────────────────────────────────────────

interface EnvironmentalCoverage {
  nwiPct: number;           // wetland % of parcel
  floodPct: number;         // FEMA flood zone % of parcel
  floodZone: string;        // dominant FLD_ZONE label
  femaFeatureCount: number; // raw features returned by FEMA source
  nwiFeatureCount: number;  // raw features returned by NWI source
}

interface SoilHoverData {
  mukey: string;
  bucket: string;
  finalScore: number;
  floodOverlapPct: number;
  wetlandOverlapPct: number;
  drainScore: number;
  ksatScore: number;
  slopeScore: number;
  wtScore: number;
  pondingScore: number | null;
  restrictiveLayerScore: number | null;
  floodingScore: number | null;
  soilName: string;
  // Gate output — single source of truth for site alerts
  firedGates: string[];
  gatingCeiling: number;
  // raw values for factor bar display only (not used for alert logic)
  rawWatertableInches: number | null;
  rawResdeptCm: number | null;
  rawFlodfreqcl: string | null;
  rawSlopePct: number | null;        // SSURGO county-averaged slope (fallback)
  zoneSlopeDemPct: number | null;    // DEM-derived zone median slope (preferred)
  clay40DepthCm: number | null;
  rawKsat: number | null;
}

interface MapPanelProps {
  reportId: string;
  cachedOverlayGeojson: { femaFeatures: unknown[]; nwiFeatures: unknown[] } | null;
  parcelBoundary: Record<string, unknown> | null;
  isBboxFallback: boolean;
  boundarySource: string | null;
  soilResults: SoilResult[];
  lat: number | null;
  lng: number | null;
  onMapReady: (map: mapboxgl.Map) => void;
  onCoverageUpdate?: (coverage: EnvironmentalCoverage) => void;
  onSoilPolygonsReady?: (polygons: SoilPolygon[]) => void;
  onDemSlopeReady?: (slopes: Record<string, number | null>) => void;
  onAllLayersReady?: () => void;
  onCanvasReady?: (canvas: HTMLCanvasElement) => void;
  requestCaptureRef?: React.MutableRefObject<(() => Promise<HTMLCanvasElement>) | null>;
  onBestZoneInFlood?: (inFlood: boolean) => void;
  onPercFallback?: (exhausted: boolean) => void;
  onPercPinsReady?: (pins: PercPinData[]) => void;
  onTokenReady?: (token: string) => void;
  onSoilHover?: (data: SoilHoverData | null) => void;
  onSoilClick?: (data: SoilHoverData) => void;
  activeTab?: ZoneTab;
}

function safeRemovePopup(popup: mapboxgl.Popup | null) {
  if (!popup) return;
  try {
    const el = popup.getElement();
    if (el && document.activeElement && el.contains(document.activeElement)) {
      (document.activeElement as HTMLElement).blur();
    }
  } catch { /* ignore */ }
  popup.remove();
}

function isMapAlive(map: mapboxgl.Map): boolean {
  return !!(map && !(map as unknown as Record<string, unknown>)['_removed'] && map.getContainer());
}

function clearSoilOverlay(map: mapboxgl.Map, overlayIds: string[]) {
  if (!isMapAlive(map)) { overlayIds.length = 0; return; }
  for (const id of [...overlayIds]) {
    try { if (map.getLayer(id)) map.removeLayer(id); } catch { /* ignore */ }
  }
  const seen = new Set<string>();
  for (const id of [...overlayIds]) {
    const src = id.replace(/-fill$|-outline$|-line$|-excl$|-glow$|-stroke$|-hit$/, '').replace(/-source$/, '');
    if (!seen.has(src)) { seen.add(src); try { if (map.getSource(src)) map.removeSource(src); } catch { /* ignore */ } }
  }
  overlayIds.length = 0;
}

function setSoilOverlayVisibility(map: mapboxgl.Map, visible: boolean, overlayIds: string[]) {
  const vis = visible ? 'visible' : 'none';
  for (const id of overlayIds) {
    try { if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', vis); } catch { /* ignore */ }
  }
}

function addOrUpdateBoundary(map: mapboxgl.Map, boundary: Record<string, unknown>, isFallback: boolean) {
  const data = {
    type: 'Feature',
    geometry: boundary as mapboxgl.GeoJSON,
    properties: {},
  } as mapboxgl.GeoJSONSourceSpecification['data'];

  if (map.getSource('parcel')) {
    (map.getSource('parcel') as mapboxgl.GeoJSONSource).setData(data);
    return;
  }

  map.addSource('parcel', { type: 'geojson', data });

  if (isFallback) {
    // Approximate boundary — dashed border, no fill, clearly provisional
    map.addLayer({
      id: 'parcel-outline',
      type: 'line',
      source: 'parcel',
      paint: {
        'line-color': '#FFFFFF',
        'line-width': 1.5,
        'line-opacity': 0.5,
        'line-dasharray': [4, 3],
      },
    });
  } else {
    // Real parcel boundary — green fill + solid white outline
    map.addLayer({
      id: 'parcel-fill',
      type: 'fill',
      source: 'parcel',
      paint: { 'fill-color': '#22C55E', 'fill-opacity': 0.10 },
    });
    map.addLayer({
      id: 'parcel-outline',
      type: 'line',
      source: 'parcel',
      paint: { 'line-color': '#FFFFFF', 'line-width': 2, 'line-opacity': 0.85 },
    });
  }
}

function zoomFromBbox(boundary: Record<string, unknown>): number {
  try {
    const coords = extractCoords(boundary);
    if (!coords.length) return 16;
    let minLng = Infinity, maxLng = -Infinity, minLat = Infinity, maxLat = -Infinity;
    for (const c of coords) {
      const [lo, la] = c as [number, number];
      if (lo < minLng) minLng = lo;
      if (lo > maxLng) maxLng = lo;
      if (la < minLat) minLat = la;
      if (la > maxLat) maxLat = la;
    }
    const span = Math.max(maxLng - minLng, maxLat - minLat);
    if (span > 0.05) return 14;
    if (span < 0.02) return 17;
    return 16;
  } catch (_) { return 16; }
}

function fitToBoundary(map: mapboxgl.Map, boundary: Record<string, unknown>) {
  try {
    const coords = extractCoords(boundary);
    if (!coords.length) return;
    const bounds = coords.reduce(
      (b, c) => b.extend(c as [number, number]),
      new mapboxgl.LngLatBounds(coords[0] as [number, number], coords[0] as [number, number])
    );
    map.fitBounds(bounds, { padding: 60, maxZoom: 18, duration: 1200 });
  } catch (_) { /* ignore */ }
}

function MapPanel({ reportId, cachedOverlayGeojson, parcelBoundary, isBboxFallback, boundarySource, soilResults, lat, lng, onMapReady, onCoverageUpdate, onSoilPolygonsReady, onDemSlopeReady, onAllLayersReady, onCanvasReady, requestCaptureRef, onBestZoneInFlood, onPercFallback, onPercPinsReady, onTokenReady, onSoilHover, onSoilClick, activeTab }: MapPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const markerRef = useRef<mapboxgl.Marker | null>(null);
  const zoneMarkersRef = useRef<mapboxgl.Marker[]>([]);
  const zoneBadgeMarkersRef = useRef<mapboxgl.Marker[]>([]);
  const percMarkersRef = useRef<mapboxgl.Marker[]>([]);
  const noZoneBadgeRef = useRef<mapboxgl.Marker | null>(null);
  const soilPopupRef = useRef<mapboxgl.Popup | null>(null);
  const soilClickRegisteredRef = useRef(false);
  const [mapError, setMapError] = useState('');
  const [sdaError, setSdaError] = useState(false);
  const [sdaRetrying, setSdaRetrying] = useState(false);
  const sdaRetryTriggerRef = useRef(0);
  const [tokenReady, setTokenReady] = useState(false);
  const [soilVisible, setSoilVisible] = useState(true);
  const [floodVisible, setFloodVisible] = useState(true);
  const [wetlandVisible, setWetlandVisible] = useState(true);
  const [percVisible, setPercVisible] = useState(true);
  const [zoneLabelsVisible, setZoneLabelsVisible] = useState(true);
  // Bucket colors for the 3 ranked zones — updated when zones are computed
  const [zoneBadgeColors, setZoneBadgeColors] = useState<string[]>(['#22C55E', '#22C55E', '#22C55E']);
  const [layersOpen, setLayersOpen] = useState(false);
  const [terrain3D, setTerrain3D] = useState(false);
  const initialCameraRef = useRef<{ zoom: number; center: mapboxgl.LngLatLike; bearing: number; pitch: number } | null>(null);
  const [soilReady, setSoilReady] = useState(false);
  const [femaReady, setFemaReady] = useState(false);
  const [nwiReady, setNwiReady] = useState(false);
  const [overlayFading, setOverlayFading] = useState(false);
  const [overlayGone, setOverlayGone] = useState(false);
  const [loadingTextIdx, setLoadingTextIdx] = useState(0);
  const activeTabRef = useRef(activeTab);
  activeTabRef.current = activeTab;
  const zoneLabelsVisibleRef = useRef(zoneLabelsVisible);
  zoneLabelsVisibleRef.current = zoneLabelsVisible;

  const handleZoneLabelsToggle = (visible: boolean) => {
    console.log('[zones] toggle:', visible, 'markers:', zoneBadgeMarkersRef.current.length);
    zoneBadgeMarkersRef.current.forEach(m => {
      (m.getElement() as HTMLElement).style.display = visible ? 'block' : 'none';
    });
    setZoneLabelsVisible(visible);
  };

  const setZoneBadgeColorsRef = useRef(setZoneBadgeColors);
  setZoneBadgeColorsRef.current = setZoneBadgeColors;
  const onAllLayersReadyRef = useRef(onAllLayersReady);
  onAllLayersReadyRef.current = onAllLayersReady;
  const onCanvasReadyRef = useRef(onCanvasReady);
  onCanvasReadyRef.current = onCanvasReady;
  const onPercPinsReadyRef = useRef(onPercPinsReady);
  onPercPinsReadyRef.current = onPercPinsReady;
  const setSoilReadyRef = useRef(setSoilReady);
  setSoilReadyRef.current = setSoilReady;
  const setFemaReadyRef = useRef(setFemaReady);
  setFemaReadyRef.current = setFemaReady;
  const setNwiReadyRef = useRef(setNwiReady);
  setNwiReadyRef.current = setNwiReady;
  const wfsFallbackRef = useRef(false);
  const soilLoadingRef = useRef(false);
  const tokenRef = useRef<string>('');
  const regridTokenRef = useRef<string>('');
  const supabaseUrlRef = useRef(import.meta.env.VITE_SUPABASE_URL as string);
  const anonKeyRef = useRef(import.meta.env.VITE_SUPABASE_ANON_KEY as string);
  const onMapReadyRef = useRef(onMapReady);
  onMapReadyRef.current = onMapReady;
  const onCoverageUpdateRef = useRef(onCoverageUpdate);
  onCoverageUpdateRef.current = onCoverageUpdate;
  const onSoilPolygonsReadyRef = useRef(onSoilPolygonsReady);
  onSoilPolygonsReadyRef.current = onSoilPolygonsReady;
  const onDemSlopeReadyRef = useRef(onDemSlopeReady);
  onDemSlopeReadyRef.current = onDemSlopeReady;
  const onBestZoneInFloodRef = useRef(onBestZoneInFlood);
  onBestZoneInFloodRef.current = onBestZoneInFlood;
  const onPercFallbackRef = useRef(onPercFallback);
  onPercFallbackRef.current = onPercFallback;
  const onSoilHoverRef = useRef(onSoilHover);
  onSoilHoverRef.current = onSoilHover;
  const onSoilClickRef = useRef(onSoilClick);
  onSoilClickRef.current = onSoilClick;
  // Per-instance overlay layer/source ID list — avoids module-level state pollution
  const overlayIdsRef = useRef<string[]>([]);
  // Stop function for the primary-zone glow RAF loop; replaced each render cycle
  const stopGlowRef = useRef<(() => void) | null>(null);
  // Hard lock: prevents a second applyFullOverlay from wiping the map after a successful render
  const soilRenderedRef = useRef(false);
  const femaRenderedRef = useRef(false);
  const nwiRenderedRef = useRef(false);
  // Tracks how many soil results were used for the last committed render.
  // A new call with more results can refresh the source data via setData even after soilRenderedRef is set.
  const soilResultsCountRef = useRef(0);
  // Holds the latest soilResults array so an in-flight scoring run can re-score with fresh data after it yields.
  const latestSoilResultsRef = useRef<SoilResult[]>([]);
  const retrySoilLoadRef = useRef<(() => void) | null>(null);
  // Prevents zone selection from running more than once per parcel load
  const bestZoneRef = useRef<{ zones: BestZone[]; isFallbackZone: boolean } | null>(null);
  // Tracks the last boundary+results key that was rendered to prevent duplicate runs
  const lastOverlayKeyRef = useRef<string>('');

  function applyZoneMarkerTabFilter(el: HTMLElement, tab: string) {
    if (!el.dataset.zoneBucket) return;
    const bucket = el.dataset.zoneBucket;
    const active = tab === 'not-suitable' ? 'not-suitable' : tab;
    el.style.opacity = (active === 'parcel' || !active || bucket === active) ? '1' : '0';
  }

  // Load config tokens
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      fetch(`${supabaseUrlRef.current}/functions/v1/get-config`, {
        headers: { Authorization: `Bearer ${session?.access_token ?? anonKeyRef.current}` },
      })
        .then(r => r.json())
        .then((json: { mapboxToken?: string | null; regridToken?: string | null }) => {
          if (json.mapboxToken) { tokenRef.current = json.mapboxToken; setTokenReady(true); onTokenReady?.(json.mapboxToken); }
          else setMapError('Mapbox token not found in project secrets');
          if (json.regridToken) regridTokenRef.current = json.regridToken;
        })
        .catch(() => setMapError('Could not load map configuration'));
    });
  }, []);

  // Convert parcel polygon to WKT for SDA tabular query


  function wktStringToGeometry(wkt: string): turf.Polygon | turf.MultiPolygon | null {
    const parseRing = (ringStr: string): number[][] => {
      const coords = ringStr.split(',').map(p => {
        const parts = p.trim().split(/\s+/);
        return [parseFloat(parts[0]), parseFloat(parts[1])];
      }).filter(c => !isNaN(c[0]) && !isNaN(c[1]));
      if (coords.length >= 3) {
        const first = coords[0], last = coords[coords.length - 1];
        if (first[0] !== last[0] || first[1] !== last[1]) coords.push([...first]);
      }
      return coords;
    };
    const upper = wkt.trim().toUpperCase();
    if (upper.startsWith('MULTIPOLYGON')) {
      const inner = wkt.replace(/^MULTIPOLYGON\s*\(\s*/i, '').replace(/\s*\)\s*$/, '');
      const polyGroups = inner.split(/\)\s*\)\s*,\s*\(\s*\(/);
      const coordinates = polyGroups.map(group => {
        const clean = group.replace(/^\s*\(\s*\(\s*/, '').replace(/\s*\)\s*\)\s*$/, '');
        return clean.split(/\)\s*,\s*\(/).map(r => parseRing(r.replace(/^\s*\(/, '').replace(/\)\s*$/, '')));
      }).filter(poly => poly.length > 0 && poly[0].length >= 4);
      if (coordinates.length === 0) return null;
      return { type: 'MultiPolygon', coordinates } as turf.MultiPolygon;
    }
    if (upper.startsWith('POLYGON')) {
      const inner = wkt.replace(/^POLYGON\s*\(\s*/i, '').replace(/\s*\)\s*$/, '');
      const coordinates = inner.split(/\)\s*,\s*\(/).map(r => parseRing(r.replace(/^\s*\(/, '').replace(/\)\s*$/, '')));
      if (coordinates.length === 0 || coordinates[0].length < 4) return null;
      return { type: 'Polygon', coordinates } as turf.Polygon;
    }
    return null;
  }

  // Smoothly fade a layer from 0 to targetOpacity over ~600ms
  const fadeInLayer = (map: mapboxgl.Map, layerId: string, targetOpacity: number, delayMs = 0, paintProp = 'fill-opacity') => {
    setTimeout(() => {
      if (!map.getLayer(layerId)) return;
      let opacity = 0;
      const step = targetOpacity / 20;
      const id = setInterval(() => {
        opacity = Math.min(opacity + step, targetOpacity);
        try { map.setPaintProperty(layerId, paintProp, opacity); } catch { clearInterval(id); }
        if (opacity >= targetOpacity) clearInterval(id);
      }, 30);
    }, delayMs);
  };

  // Build soil polygon overlay from stored DB results, then fetch FEMA/NWI and render all layers
  const applyFullOverlay = async (map: mapboxgl.Map, boundary: Record<string, unknown>, results: SoilResult[], visible: boolean) => {
    if (!isMapAlive(map)) return;

    // Belt-and-suspenders guard: if this exact (boundary, results) combination was already
    // fully rendered, return immediately before touching any state or markers.
    const invocationKey = `${JSON.stringify(boundary).slice(0, 80)}-${results.length}`;
    if (
      lastOverlayKeyRef.current === invocationKey &&
      soilRenderedRef.current === true &&
      femaRenderedRef.current === true &&
      nwiRenderedRef.current === true
    ) {
      console.log('[applyFullOverlay] key unchanged + all layers complete — skipping redundant call');
      return;
    }

    console.log('[applyFullOverlay] called, soil=', soilRenderedRef.current, 'fema=', femaRenderedRef.current, 'nwi=', nwiRenderedRef.current, 'visible=', visible, 'results=', results.length, 'last results count:', soilResultsCountRef.current);
    // Always keep latestSoilResultsRef current so an in-flight scoring run can use the freshest data.
    if (results.length > latestSoilResultsRef.current.length) {
      latestSoilResultsRef.current = results;
    }
    // Skip soil re-render if already done AND results haven't grown since the last commit.
    // If more results arrived (pipeline step 2 completed after scoring started), allow a setData refresh.
    // Never start a new full render while scoring is still in progress — when it finishes it will
    // call setData using latestSoilResultsRef to incorporate any results that arrived mid-flight.
    const moreResultsAvailable = results.length > soilResultsCountRef.current;
    if (soilLoadingRef.current && moreResultsAvailable) {
      console.log('[applyFullOverlay] scoring in progress — stored', results.length, 'results for post-scoring refresh');
      return;
    }
    const skipSoilRender = soilRenderedRef.current === true && !moreResultsAvailable;
    // But NEVER skip FEMA/NWI fetches unless they already returned data
    const skipOverlayFetch = femaRenderedRef.current === true && nwiRenderedRef.current === true;
    if (skipSoilRender && skipOverlayFetch) {
      console.log('[applyFullOverlay] all layers already rendered, skipping');
      return;
    }
    if (!skipSoilRender) soilRenderedRef.current = true;
    soilLoadingRef.current = true;
    let soilFeatures: turf.Feature[] = [];

    const originalParcelFeature = toParcelFeature(boundary);
    {
      const g = originalParcelFeature.geometry;
      console.log('[boundary] original Regrid coords:', g.type === 'Polygon' ? g.coordinates[0].length : g.coordinates[0][0].length);
    }

    // ── SOIL POLYGON CACHE: reconstruct soilFeatures from stored soil_polygon_geojson ──
    // Geometry is saved to soil_results after the first live WFS fetch. On re-opens, skip the
    // soil-polygons edge function call if every result has geometry stored. If any are missing,
    // fall through to the live fetch — a fresh fetch is better than rendering zero polygons.
    const anyCachedGeometry = results.some(r => r.soil_polygon_geojson != null);
    const allHaveGeometry = results.length > 0 && results.every(r => r.soil_polygon_geojson != null);

    if (allHaveGeometry) {
      console.log('[sda tabular] using cached soil_polygon_geojson from DB — skipping soil-polygons fetch');
      let cached = 0, missing = 0;
      for (const r of results) {
        try {
          const geo = r.soil_polygon_geojson as Record<string, unknown> | null;
          const mukey = r.map_unit_key ?? '';
          const muname = r.map_unit_name ?? '';
          if (!geo) { missing++; continue; }
          if (geo.type === 'FeatureCollection') {
            // Multiple fragments stored — push each as a separate feature
            const fc = geo as unknown as turf.FeatureCollection;
            for (const f of fc.features) {
              soilFeatures.push(turf.feature(
                f.geometry as turf.Polygon | turf.MultiPolygon,
                { mukey, musym: mukey, muname, ...(f.properties ?? {}) }
              ));
            }
          } else {
            const feature = geo.type === 'Feature'
              ? turf.feature(
                  (geo.geometry ?? geo) as turf.Polygon | turf.MultiPolygon,
                  { mukey, musym: mukey, muname, ...(geo.properties as Record<string, unknown> ?? {}) }
                )
              : turf.feature(geo as unknown as turf.Polygon | turf.MultiPolygon, { mukey, musym: mukey, muname });
            soilFeatures.push(feature);
          }
          cached++;
        } catch (e) {
          console.warn('[sda tabular] failed to reconstruct cached polygon for', r.map_unit_key, e);
          missing++;
        }
      }
      console.log('[sda tabular] reconstructed', cached, 'soil features from cache,', missing, 'had no geometry');
    } else {
      if (anyCachedGeometry) {
        console.log('[sda tabular] partial cache — some geometries missing, fetching fresh from WFS');
      }
      // ── LIVE FETCH from soil-polygons edge function (first analysis or cache missing) ──
      try {
        // For SDA WKT queries, MultiPolygon must be reduced to a single POLYGON.
        // Extract the largest sub-polygon by area and use it for the query boundary.
        // The full MultiPolygon is still used for mask, outline, and FEMA/NWI clipping.
        let queryParcelFeature: turf.Feature<turf.Polygon | turf.MultiPolygon> = originalParcelFeature;
        const isMultiPolygon = originalParcelFeature.geometry.type === 'MultiPolygon';
        if (isMultiPolygon) {
          const subPolygons = (originalParcelFeature.geometry.coordinates as number[][][][]).map(
            coords => turf.polygon(coords)
          );
          const largest = subPolygons.reduce((best, cur) =>
            turf.area(cur) > turf.area(best) ? cur : best
          );
          queryParcelFeature = largest;
          console.log('[boundary] MultiPolygon detected —', subPolygons.length, 'sub-polygons, using largest (', turf.area(largest).toFixed(0), 'sqm) for SDA query');
        }

        // For MultiPolygon parcels use bbox WKT for the WFS soil-polygons fetch so ALL sub-polygons
        // are covered. Client-side clipping below filters results to the actual parcel boundary.
        const wfsQueryWKT = isMultiPolygon
          ? buildBboxWkt(parcelBoundary)
          : geojsonToWkt(queryParcelFeature as unknown as Record<string, unknown>);
        const originalWKT = wfsQueryWKT;
        const origArea = turf.area(isMultiPolygon ? originalParcelFeature : queryParcelFeature);
        const MAX_WKT_LENGTH = 800;

        // Find a valid simplified WKT: no self-intersections, area within 5% of original.
        // Finer tolerances first so we keep as much detail as possible.
        let parcelWKT = originalWKT;
        let usedSimplified = false;

        if (originalWKT.length > MAX_WKT_LENGTH) {
          const tolerances = [0.00005, 0.0001, 0.0002, 0.0005, 0.001, 0.002, 0.005, 0.01];
          for (const tolerance of tolerances) {
            try {
              const candidate = turf.simplify(queryParcelFeature, { tolerance, highQuality: true });
              const candidateWKT = geojsonToWkt(candidate as unknown as Record<string, unknown>);
              const hasKinks = turf.kinks(candidate as turf.Feature<turf.Polygon>).features.length > 0;
              const areaRatio = turf.area(candidate) / origArea;
              const areaOk = areaRatio >= 0.90 && areaRatio <= 1.10;
              console.log('[ssurgo] tolerance:', tolerance, 'length:', candidateWKT.length, 'kinks:', hasKinks, 'areaRatio:', areaRatio.toFixed(3));
              if (!hasKinks && areaOk && candidateWKT.length < originalWKT.length) {
                parcelWKT = candidateWKT;
                usedSimplified = true;
                if (parcelWKT.length <= MAX_WKT_LENGTH) break;
              }
            } catch { console.warn('[ssurgo] simplify failed at tolerance:', tolerance); }
          }
        }
        console.log('[ssurgo] original:', originalWKT.length, 'using:', usedSimplified ? `simplified (${parcelWKT.length})` : 'original');
        console.log('[sda tabular] posting WKT query via edge function, parcel WKT length:', parcelWKT.length);
        const { data: { session } } = await supabase.auth.getSession();

        const parcelBboxForQuery = turf.bbox(originalParcelFeature) as [number, number, number, number];
        const makeSDAFetch = (wkt: string) => withTimeout(
          fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/soil-polygons`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${session?.access_token ?? import.meta.env.VITE_SUPABASE_ANON_KEY}`,
              'Apikey': import.meta.env.VITE_SUPABASE_ANON_KEY,
            },
            body: JSON.stringify({ wkt, bbox: parcelBboxForQuery }),
          }),
          90_000, 'sda-tabular'
        );

        const fetchWithRetry = async (wkt: string): Promise<Response | null> => {
          for (let attempt = 0; attempt < 2; attempt++) {
            try {
              if (attempt > 0) {
                console.log('[sda tabular] retrying after timeout...');
                setSdaRetrying(true);
                await new Promise(r => setTimeout(r, 2000));
              }
              const resp = await makeSDAFetch(wkt);
              setSdaRetrying(false);
              return resp;
            } catch (err) {
              console.warn(`[sda tabular] attempt ${attempt + 1} failed:`, (err as Error).message);
              setSdaRetrying(false);
            }
          }
          return null;
        };

        type SDAFeature = { properties: { mukey: string; musym: string; muname: string }; geometry: unknown };
        const parseSDAFeatures = (resp: Response): Promise<SDAFeature[]> =>
          resp.json().then((j: { features?: SDAFeature[] }) => j.features ?? []);

        let sdaResp = await fetchWithRetry(parcelWKT);

        if (sdaResp === null) {
          setSdaError(true);
        } else {
          setSdaError(false);
          console.log('[sda tabular] status:', sdaResp.status);
          if (sdaResp.ok) {
            let features = await parseSDAFeatures(sdaResp);
            console.log('[sda tabular] features:', features.length);

            // FIX 3: if simplified polygon returned 0 features, retry with original boundary
            if (features.length === 0 && usedSimplified) {
              console.log('[ssurgo] zero features with simplified polygon — retrying with original boundary');
              const retryResp = await fetchWithRetry(originalWKT);
              if (retryResp?.ok) {
                features = await parseSDAFeatures(retryResp);
                console.log('[ssurgo] original boundary retry features:', features.length);
              }
            }

            const uniqueMukeys = new Set<string>();
            for (const f of features) {
              const { mukey, musym, muname } = f.properties;
              if (!mukey) continue;
              uniqueMukeys.add(mukey);
              soilFeatures.push(turf.feature(f.geometry as turf.Polygon, { mukey, musym, muname }));
            }
            console.log('[ssurgo] mukeys returned:', uniqueMukeys.size, [...uniqueMukeys]);
            console.log('[sda tabular] parsed features:', soilFeatures.length);

            if (soilFeatures.length > 0) {
              const allBboxes = soilFeatures.map(f => turf.bbox(f));
              const lngs0 = allBboxes.map(b => b[0]), lngs2 = allBboxes.map(b => b[2]);
              const lats1 = allBboxes.map(b => b[1]), lats3 = allBboxes.map(b => b[3]);
              console.log('[wfs] extent of returned features:',
                Math.min(...lngs0).toFixed(4), Math.min(...lats1).toFixed(4),
                Math.max(...lngs2).toFixed(4), Math.max(...lats3).toFixed(4));
              const pb = turf.bbox(originalParcelFeature);
              console.log('[wfs] parcel bbox:',
                pb[0].toFixed(4), pb[1].toFixed(4), pb[2].toFixed(4), pb[3].toFixed(4));
              const mukeyFeatureCount = soilFeatures.reduce((acc, f) => {
                const mk = String((f.properties as Record<string,unknown>)?.mukey ?? 'unknown');
                acc[mk] = (acc[mk] ?? 0) + 1;
                return acc;
              }, {} as Record<string, number>);
              console.log('[wfs] feature count by mukey:', JSON.stringify(mukeyFeatureCount));
            }
          }
        }
      } catch (e) {
        console.warn('[sda tabular] fetch failed:', (e as Error).message);
      }
    }

    // ── PERSIST SOIL POLYGON GEOMETRY: save WFS geometry back to soil_results for future cache hits ──
    // Only runs after a live fetch (when cache was missing). Fire-and-forget — does not block rendering.
    if (!allHaveGeometry && soilFeatures.length > 0) {
      // Group features by mukey — a single mukey can have multiple polygon features (fragmented soil units).
      // We merge them into a GeometryCollection so all fragments are preserved in one DB row.
      const geomByMukey: Record<string, turf.Feature[]> = {};
      for (const f of soilFeatures) {
        const mk = String((f.properties as Record<string, unknown>)?.mukey ?? '');
        if (!mk) continue;
        if (!geomByMukey[mk]) geomByMukey[mk] = [];
        geomByMukey[mk].push(f);
      }

      const saveGeometries = async () => {
        const { data: { session } } = await supabase.auth.getSession();
        if (!session) return;
        for (const [mukey, features] of Object.entries(geomByMukey)) {
          try {
            // Store as FeatureCollection so multiple fragments per mukey are preserved
            const storedGeo = features.length === 1
              ? features[0].geometry
              : { type: 'FeatureCollection', features };
            await supabase
              .from('soil_results')
              .update({ soil_polygon_geojson: storedGeo as unknown as Record<string, unknown> })
              .eq('report_id', reportId)
              .eq('map_unit_key', mukey);
          } catch (e) {
            console.warn('[sda tabular] failed to persist geometry for mukey', mukey, e);
          }
        }
        console.log('[sda tabular] persisted geometry for', Object.keys(geomByMukey).length, 'mukeys');
      };
      saveGeometries().catch(e => console.warn('[sda tabular] geometry persist error:', e));
    }

    console.log('[zones] using REAL soil polygons:', soilFeatures.length);
    wfsFallbackRef.current = soilFeatures.length === 0;

    const [minLng, minLat, maxLng, maxLat] = turf.bbox(originalParcelFeature);
    const parcelArea = turf.area(originalParcelFeature);

    // Clip helper — shared by live fetch and cache restore paths
    const clipToParcel = (f: turf.Feature): turf.Feature<turf.Polygon | turf.MultiPolygon> | null => {
      try {
        if (!f?.geometry) return null;
        const feat = f.type === 'Feature' ? f as turf.Feature<turf.Polygon | turf.MultiPolygon> : turf.feature(f as unknown as turf.Polygon | turf.MultiPolygon);
        return turf.intersect(turf.featureCollection([originalParcelFeature, feat]));
      } catch { return null; }
    };

    let wetlandFeatures: turf.Feature<turf.Polygon | turf.MultiPolygon>[] = [];
    let floodFeatures: turf.Feature<turf.Polygon | turf.MultiPolygon>[] = [];
    let nwiPct = 0;
    let floodPct = 0;
    let dominantFloodZone = '';
    let nwiRawCount = 0;
    let femaRawCount = 0;

    // ── FEMA/NWI CACHE: load clipped features from reports.overlay_geojson ──────
    const cachedOverlay = cachedOverlayGeojson;
    if (cachedOverlay && Array.isArray(cachedOverlay.femaFeatures) && Array.isArray(cachedOverlay.nwiFeatures)) {
      console.log('[overlay] loading FEMA/NWI from cache — skipping Esri fetch');

      for (const f of cachedOverlay.nwiFeatures as turf.Feature[]) {
        try {
          const feat = f as turf.Feature<turf.Polygon | turf.MultiPolygon>;
          if (feat?.geometry) wetlandFeatures.push(feat);
        } catch { /* skip */ }
      }
      const wetlandArea = wetlandFeatures.reduce((s, f) => s + turf.area(f), 0);
      nwiPct = Math.round((wetlandArea / parcelArea) * 100);
      nwiRawCount = wetlandFeatures.length;

      const zoneCounts: Record<string, number> = {};
      for (const f of cachedOverlay.femaFeatures as turf.Feature[]) {
        try {
          const feat = f as turf.Feature<turf.Polygon | turf.MultiPolygon>;
          if (feat?.geometry) {
            const zone = (feat.properties as Record<string, unknown>)?.FLD_ZONE as string ?? '';
            floodFeatures.push(feat);
            zoneCounts[zone] = (zoneCounts[zone] ?? 0) + turf.area(feat);
          }
        } catch { /* skip */ }
      }
      const floodArea = floodFeatures.reduce((s, f) => s + turf.area(f), 0);
      floodPct = Math.round((floodArea / parcelArea) * 100);
      femaRawCount = floodFeatures.length;
      dominantFloodZone = Object.entries(zoneCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';

      console.log('[overlay] cache restored — fema:', femaRawCount, 'nwi:', nwiRawCount);
    } else {
      // ── LIVE FETCH from Esri ArcGIS REST (first analysis or cache missing) ─────
      const femaParams = new URLSearchParams({
        geometry: `${minLng},${minLat},${maxLng},${maxLat}`,
        geometryType: 'esriGeometryEnvelope',
        inSR: '4326',
        spatialRel: 'esriSpatialRelIntersects',
        where: "FLD_ZONE IN ('A','AE','AH','AO','VE','V')",
        outFields: 'FLD_ZONE,SFHA_TF',
        returnGeometry: 'true',
        outSR: '4326',
        resultRecordCount: '500',
        f: 'geojson',
      });
      const femaUrl = `https://services.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/USA_Flood_Hazard_Reduced_Set_gdb/FeatureServer/0/query?${femaParams}`;

      const nwiParams = new URLSearchParams({
        geometry: `${minLng},${minLat},${maxLng},${maxLat}`,
        geometryType: 'esriGeometryEnvelope',
        inSR: '4326',
        spatialRel: 'esriSpatialRelIntersects',
        where: '1=1',
        outFields: 'ATTRIBUTE,WETLAND_TYPE',
        returnGeometry: 'true',
        outSR: '4326',
        resultRecordCount: '500',
        f: 'geojson',
      });
      const nwiUrl = `https://services.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/USA_Wetlands/FeatureServer/0/query?${nwiParams}`;

      console.log('[fema] arcgis url:', femaUrl.slice(0, 120));
      console.log('[nwi]  arcgis url:', nwiUrl.slice(0, 120));
      console.log('[overlay] reached Promise.allSettled — about to fetch fema and nwi');
      const [nwiResult, femaResult] = await Promise.allSettled([
        fetch(nwiUrl, { signal: AbortSignal.timeout(15_000) }),
        fetch(femaUrl, { signal: AbortSignal.timeout(15_000) }),
      ]);
      console.log('[overlay] Promise.allSettled completed, nwiResult status:', nwiResult.status, 'femaResult status:', femaResult.status);

      if (nwiResult.status === 'fulfilled') {
        try {
          console.log('[nwi] response status:', nwiResult.value.status);
          const nwiData = await nwiResult.value.json() as { features?: turf.Feature[] };
          const nwiCount = nwiData.features?.length ?? 0;
          nwiRawCount = nwiCount;
          console.log('[nwi] raw feature count:', nwiCount);
          if (nwiCount === 0) console.log('[nwi] full response:', JSON.stringify(nwiData).slice(0, 200));
          for (const f of nwiData.features ?? []) {
            const clipped = clipToParcel(f);
            if (clipped) wetlandFeatures.push(clipped);
          }
          console.log('[nwi] clipped wetland polygons:', wetlandFeatures.length);
          const wetlandArea = wetlandFeatures.reduce((s, f) => s + turf.area(f), 0);
          nwiPct = Math.round((wetlandArea / parcelArea) * 100);
          console.log('[nwi] wetland coverage:', nwiPct + '%');
        } catch (e) { console.warn('[nwi] parse error:', (e as Error).message); }
      } else {
        console.warn('[nwi] unavailable:', nwiResult.reason);
      }

      if (femaResult.status === 'fulfilled') {
        try {
          if (!femaResult.value.ok) throw new Error(`FEMA status: ${femaResult.value.status}`);
          const femaData = await femaResult.value.json() as { features?: turf.Feature[]; error?: { message?: string } };
          if (femaData.error) throw new Error(`FEMA error: ${femaData.error.message ?? JSON.stringify(femaData.error)}`);
          const femaCount = femaData.features?.length ?? 0;
          femaRawCount = femaCount;
          console.log('[fema] flood zone features:', femaCount);
          if (femaCount === 0) console.log('[fema] full response:', JSON.stringify(femaData).slice(0, 200));
          const zoneCounts: Record<string, number> = {};
          for (const f of femaData.features ?? []) {
            const zone = (f.properties as Record<string, unknown>)?.FLD_ZONE as string ?? '';
            const clipped = clipToParcel(f);
            if (clipped) {
              clipped.properties = { ...clipped.properties, FLD_ZONE: zone };
              floodFeatures.push(clipped);
              zoneCounts[zone] = (zoneCounts[zone] ?? 0) + turf.area(clipped);
            }
          }
          const floodArea = floodFeatures.reduce((s, f) => s + turf.area(f), 0);
          floodPct = Math.round((floodArea / parcelArea) * 100);
          dominantFloodZone = Object.entries(zoneCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
          console.log('[fema] flood zone coverage:', floodPct + '%', 'zone:', dominantFloodZone);
        } catch (e) {
          console.warn('[fema] fetch failed:', (e as Error).message);
        }
      } else {
        console.warn('[fema] request rejected:', femaResult.reason);
      }

      // Persist clipped features to DB so future opens skip Esri entirely
      supabase.from('reports').update({
        overlay_geojson: { femaFeatures: floodFeatures, nwiFeatures: wetlandFeatures },
      }).eq('id', reportId).then(({ error }) => {
        if (error) console.warn('[overlay] failed to cache overlay_geojson:', error.message);
        else console.log('[overlay] cached fema/nwi to reports.overlay_geojson');
      });
    }

    nwiRenderedRef.current = true;
    setNwiReadyRef.current(true);
    femaRenderedRef.current = true;
    setFemaReadyRef.current(true);

    onCoverageUpdateRef.current?.({ nwiPct, floodPct, floodZone: dominantFloodZone, femaFeatureCount: femaRawCount, nwiFeatureCount: nwiRawCount });

    // Union overlay arrays once — reused by scorer and perc pin checks (N×M → N×2)
    const unionFeatures = (
      features: turf.Feature<turf.Polygon | turf.MultiPolygon>[],
      label: string,
    ): turf.Feature<turf.Polygon | turf.MultiPolygon> | null => {
      if (features.length === 0) return null;
      if (features.length === 1) return features[0];
      try {
        let acc = features[0];
        for (let i = 1; i < features.length; i++) {
          const u = turf.union(turf.featureCollection([acc, features[i]]));
          if (u) acc = u;
        }
        console.log('[perf]', label, 'union: input', features.length, 'features → 1 geometry');
        return acc;
      } catch (e) {
        console.warn('[perf]', label, 'union failed, using array:', (e as Error).message);
        return null;
      }
    };
    const floodUnion = unionFeatures(floodFeatures, 'fema');
    const wetlandUnion = unionFeatures(wetlandFeatures, 'nwi');

    const countVertices = (geom: turf.Feature<turf.Polygon | turf.MultiPolygon> | null): number => {
      if (!geom?.geometry) return 0;
      const str = JSON.stringify(geom.geometry.coordinates);
      return (str.match(/\[[\d.-]/g) || []).length;
    };
    const femaVertexCount = countVertices(floodUnion);
    const nwiVertexCount = countVertices(wetlandUnion);
    console.log('[perf] nwi vertices:', nwiVertexCount, 'fema vertices:', femaVertexCount);

    const shouldSimplify = nwiVertexCount > 2000 || femaVertexCount > 1000;
    const femaScoring = (shouldSimplify && floodUnion)
      ? (() => { try { return turf.simplify(floodUnion, { tolerance: 0.0001, highQuality: false }); } catch { return floodUnion; } })()
      : floodUnion;
    const nwiScoring = (shouldSimplify && wetlandUnion)
      ? (() => { try { return turf.simplify(wetlandUnion, { tolerance: 0.0001, highQuality: false }); } catch { return wetlandUnion; } })()
      : wetlandUnion;
    console.log('[perf] simplification:', shouldSimplify ? 'applied — complex geometry' : 'skipped — geometry is simple');

    // Build soil data — scoring loop uses simplified unions (femaScoring/nwiScoring) when geometry is complex.
    // Original floodUnion/wetlandUnion are preserved for pin point-in-polygon checks below.
    // Use latestSoilResultsRef.current so that if pipeline step 2 completed while FEMA/NWI were fetching,
    // the scorer always uses the freshest tabular data (not the stale snapshot captured at call time).
    const scoringResults = latestSoilResultsRef.current.length >= results.length
      ? latestSoilResultsRef.current : results;
    console.log('[buildSoilPolygons] scoring with', scoringResults.length, 'tabular results (call had', results.length, ')');
    console.log('[clip] parcel geometry type passed in:', originalParcelFeature.geometry.type);
    const { polygons: soilPolygons, demSlopeByMukey } = await buildSoilPolygons(soilFeatures, originalParcelFeature as unknown as Record<string, unknown>, scoringResults, floodFeatures, wetlandFeatures, femaScoring, nwiScoring, mapRef.current);
    onDemSlopeReadyRef.current?.(demSlopeByMukey);
    if (soilPolygons.length > 0) onSoilPolygonsReadyRef.current?.(soilPolygons);
    const exclusion = buildExclusionZone(boundary, results);
    if (!soilPolygons?.length) {
      console.log('[zones] no soil polygons — skipping zone selection');
    } else if (bestZoneRef.current !== null) {
      console.log('[zones] zone selection already run — skipping');
    } else {
      bestZoneRef.current = computeBestZones(soilPolygons, boundary, floodFeatures);
    }
    const { zones: bestZones, isFallbackZone } = bestZoneRef.current ?? { zones: [], isFallbackZone: false };

    console.log(`[zones] soil polygons: ${soilPolygons.length}, best zones: ${bestZones.length}, fallback: ${isFallbackZone}`);
    if (exclusion.geojson) console.log('[zones] exclusion area:', turf.area(exclusion.geojson).toFixed(0), 'sqm');

    // ── Render layers bottom-to-top: soil → FEMA → wetland → exclusion → best zones
    // Each addLayer(layer, 'parcel-outline') inserts below parcel-outline.
    // Last added = closest to parcel-outline = on top visually.
    const overlayIds = overlayIdsRef.current;
    stopGlowRef.current?.();
    stopGlowRef.current = null;
    clearSoilOverlay(map, overlayIds);
    if (!isMapAlive(map)) return;
    const vis = visible ? 'visible' : 'none';
    const beforeParcel = map.getLayer('parcel-outline') ? 'parcel-outline' : undefined;

    const soilSuitabilityText = (bucket: SoilBucket, score: number | null): string => {
      if (bucket === 'viable') return `Viable — good candidate for conventional septic${score !== null ? ` (score: ${score})` : ''}`;
      if (bucket === 'engineering-needed') return `Engineering Needed — mound or drip system may work${score !== null ? ` (score: ${score})` : ''}`;
      if (bucket === 'not-suitable') return 'Not suitable — poor drainage or other limiting factors';
      return 'Insufficient data — soil survey does not have complete data for this unit. On-site evaluation required.';
    };

    // 1. Soil polygons — render clipped polygons (p.geojson) so fills stay within the parcel.
    // displayGeojson (full SSURGO) is only for reference; rendering it bleeds outside the boundary.
    // Sort no-data → not-suitable → engineering-needed → viable so higher buckets paint on top.
    try {
      const BUCKET_Z: Record<string, number> = { 'no-data': 0, 'not-suitable': 1, 'engineering-needed': 2, 'viable': 3 };
      const sortedPolygons = soilPolygons.slice().sort(
        (a, b) => (BUCKET_Z[a.bucket] ?? 0) - (BUCKET_Z[b.bucket] ?? 0)
      );
      const displayFeatures: turf.Feature[] = sortedPolygons.map((p, i) => {
        const src = p.geojson;
        const finalScore = (src.properties?.suitabilityScore as number) ?? null;
        return {
          ...src,
          properties: {
            ...(src.properties ?? {}),
            mukey: p.mukey,
            bucket: p.bucket,
            finalScore,
            _idx: i,
          },
        };
      });

      const viableCount = sortedPolygons.filter(p => p.bucket === 'viable').length;
      const engCount = sortedPolygons.filter(p => p.bucket === 'engineering-needed').length;
      const notSuitCount = sortedPolygons.filter(p => p.bucket === 'not-suitable').length;
      console.log('[soil display] rendering', displayFeatures.length, 'scored polygons — viable:', viableCount, 'engineering:', engCount, 'not-suitable:', notSuitCount, 'excluded', soilFeatures.length - displayFeatures.length, 'unscored');
      // Geometry integrity check: log type and ring count for every rendered feature.
      // A Polygon with rings from two disjoint patches would show an unexpectedly high ring count.
      displayFeatures.forEach((f, i) => {
        const g = (f as turf.Feature).geometry as turf.Polygon | turf.MultiPolygon;
        const ringInfo = g.type === 'Polygon'
          ? `rings=${(g as turf.Polygon).coordinates.length}`
          : g.type === 'MultiPolygon'
            ? `parts=${(g as turf.MultiPolygon).coordinates.length} rings=${(g as turf.MultiPolygon).coordinates.map(p => p.length).join('+')}`
            : 'unknown';
        console.log(`[soil render] [${i}] mukey=${f.properties?.mukey} bucket=${f.properties?.bucket} geom=${g.type} ${ringInfo}`);
      });

      soilResultsCountRef.current = scoringResults.length;

      const geojsonData = { type: 'FeatureCollection' as const, features: displayFeatures };
      const existingSource = map.getSource('soil-polygons') as mapboxgl.GeoJSONSource | undefined;
      if (existingSource) {
        // Source already exists from a prior (stale) render — update data in place.
        // Layers are already bound to this source, so skip addLayer.
        // This happens when pipeline step 2 completed after scoring started with cached results.
        console.log('[soil display] setData called with', displayFeatures.length, 'features (refreshing existing source)');
        existingSource.setData(geojsonData);
      } else {
        console.log('[soil display] setData called with', displayFeatures.length, 'features (new source)');
        map.addSource('soil-polygons', {
          type: 'geojson',
          data: geojsonData as mapboxgl.GeoJSONSourceSpecification['data'],
        });
        map.addLayer({
          id: 'soil-fill',
          type: 'fill',
          source: 'soil-polygons',
          paint: {
            'fill-color': ['match', ['get', 'bucket'], 'viable', '#22C55E', 'engineering-needed', '#F59E0B', 'not-suitable', '#EF4444', '#6B7280'],
            'fill-opacity': 0.55,
          },
          layout: { visibility: vis },
        }, beforeParcel);
        map.addLayer({
          id: 'soil-outline',
          type: 'line',
          source: 'soil-polygons',
          paint: {
            'line-color': ['match', ['get', 'bucket'], 'viable', '#22C55E', 'engineering-needed', '#F59E0B', 'not-suitable', '#EF4444', '#6B7280'],
            'line-width': 2,
            'line-opacity': 0.6,
          },
          layout: { visibility: vis },
        }, beforeParcel);
      }

      if (!existingSource) overlayIds.push('soil-fill', 'soil-outline', 'soil-polygons');
    } catch (e) { console.warn('[soil] source/layer error:', (e as Error).message); }

    // 1b. World mask — dim everything outside the parcel so soil fills read cleanly.
    // Uses originalParcelFeature = toParcelFeature(boundary) — original unmodified boundary, never simplified.
    try {
      const geom = originalParcelFeature.geometry;
      // Collect all outer rings — one for Polygon, one per sub-polygon for MultiPolygon.
      const allRings: number[][][] = geom.type === 'Polygon'
        ? [geom.coordinates[0] as number[][]]
        : (geom.coordinates as number[][][][]).map(poly => poly[0] as number[][]);

      if (allRings.length > 0) {
        // Outer ring (world bbox) counter-clockwise; each parcel hole clockwise (reversed).
        const outerRing = [[-180, -85], [-180, 85], [180, 85], [180, -85], [-180, -85]];
        const holeRings = allRings.map(ring => ring.slice().reverse());
        const maskFeature = {
          type: 'Feature' as const,
          geometry: {
            type: 'Polygon' as const,
            coordinates: [outerRing as [number, number][], ...holeRings as [number, number][][]],
          },
          properties: {},
        };
        map.addSource('parcel-world-mask', { type: 'geojson', data: maskFeature });
        map.addLayer({
          id: 'parcel-mask-fill',
          type: 'fill',
          source: 'parcel-world-mask',
          paint: { 'fill-color': '#000000', 'fill-opacity': 0.5 },
          layout: { visibility: vis },
        }, beforeParcel);
        overlayIds.push('parcel-mask-fill', 'parcel-world-mask');
        console.log('[mask] sub-polygon rings:', allRings.length, 'coords:', allRings.map(r => r.length).join('+'));
      }
    } catch (e) { console.warn('[mask] world mask error:', (e as Error).message); }
    setSoilReadyRef.current(true);

    // 2. FEMA flood zones (above soil — subtle tint)
    if (floodFeatures.length > 0) {
      console.log('[fema] adding to map:', floodFeatures.length, 'clipped features');
      try {
        map.addSource('flood-zones', { type: 'geojson', data: { type: 'FeatureCollection', features: floodFeatures } as mapboxgl.GeoJSONSourceSpecification['data'] });
        map.addLayer({ id: 'flood-fill', type: 'fill', source: 'flood-zones', paint: { 'fill-color': '#818CF8', 'fill-opacity': 0.25 }, layout: { visibility: vis } }, beforeParcel);
        map.addLayer({ id: 'flood-outline', type: 'line', source: 'flood-zones', paint: { 'line-color': '#6366F1', 'line-width': 1.5 }, layout: { visibility: vis } }, beforeParcel);
        overlayIds.push('flood-fill', 'flood-outline', 'flood-zones');
        map.on('click', 'flood-fill', (e) => {
          if (!e.features?.length) return;
          const zone = (e.features[0].properties as Record<string, unknown>)?.FLD_ZONE as string ?? 'AE';
          safeRemovePopup(soilPopupRef.current);
          soilPopupRef.current = new mapboxgl.Popup({ closeButton: true, closeOnClick: true, className: 'soil-tooltip', offset: 8, maxWidth: '260px' })
            .setLngLat(e.lngLat)
            .setHTML(`<div style="background:#111827;border:1px solid rgba(255,255,255,0.12);border-radius:8px;padding:10px 14px;color:#fff;font-family:inherit;min-width:200px;"><div style="font-weight:600;font-size:13px;margin-bottom:4px;color:#818CF8;">FEMA Zone ${zone} Flood Zone</div><div style="color:rgba(255,255,255,0.55);font-size:11px;line-height:1.5;">This area is in a special flood hazard zone. Septic permits may require special engineering or may be denied by the county.</div></div>`)
            .addTo(map);
          setTimeout(() => { const btn = document.querySelector('.mapboxgl-popup-close-button'); if (btn) btn.removeAttribute('aria-hidden'); }, 0);
        });
        map.on('mouseenter', 'flood-fill', () => { map.getCanvas().style.cursor = 'pointer'; });
        map.on('mouseleave', 'flood-fill', () => { map.getCanvas().style.cursor = ''; });
      } catch (e) { console.warn('[fema] map render error:', (e as Error).message); }
    }

    // 3. NWI wetlands (above FEMA)
    if (wetlandFeatures.length > 0) {
      console.log('[nwi] adding to map:', wetlandFeatures.length, 'clipped features');
      try {
        map.addSource('wetlands', { type: 'geojson', data: { type: 'FeatureCollection', features: wetlandFeatures } as mapboxgl.GeoJSONSourceSpecification['data'] });
        map.addLayer({ id: 'wetland-fill', type: 'fill', source: 'wetlands', paint: { 'fill-color': '#38BDF8', 'fill-opacity': 0.35 }, layout: { visibility: vis } }, beforeParcel);
        map.addLayer({ id: 'wetland-outline', type: 'line', source: 'wetlands', paint: { 'line-color': '#0EA5E9', 'line-width': 1.2 }, layout: { visibility: vis } }, beforeParcel);
        overlayIds.push('wetland-fill', 'wetland-outline', 'wetlands');
        map.on('click', 'wetland-fill', (e) => {
          if (!e.features?.length) return;
          safeRemovePopup(soilPopupRef.current);
          soilPopupRef.current = new mapboxgl.Popup({ closeButton: true, closeOnClick: true, className: 'soil-tooltip', offset: 8, maxWidth: '260px' })
            .setLngLat(e.lngLat)
            .setHTML(`<div style="background:#111827;border:1px solid rgba(255,255,255,0.12);border-radius:8px;padding:10px 14px;color:#fff;font-family:inherit;min-width:200px;"><div style="font-weight:600;font-size:13px;margin-bottom:4px;color:#38BDF8;">Wetland Area (NWI)</div><div style="color:rgba(255,255,255,0.55);font-size:11px;line-height:1.5;margin-top:4px;">Wetland soils are typically saturated and may not support a conventional septic system.</div></div>`)
            .addTo(map);
          setTimeout(() => { const btn = document.querySelector('.mapboxgl-popup-close-button'); if (btn) btn.removeAttribute('aria-hidden'); }, 0);
        });
        map.on('mouseenter', 'wetland-fill', () => { map.getCanvas().style.cursor = 'pointer'; });
        map.on('mouseleave', 'wetland-fill', () => { map.getCanvas().style.cursor = ''; });
      } catch (e) { console.warn('[nwi] map render error:', (e as Error).message); }
    }

    // 4. Exclusion zone
    if (exclusion.geojson) {
      try {
        map.addSource('excl-zone', { type: 'geojson', data: exclusion.geojson as mapboxgl.GeoJSONSourceSpecification['data'] });
        map.addLayer({ id: 'excl-zone-fill', type: 'fill', source: 'excl-zone', paint: { 'fill-color': '#0A1628', 'fill-opacity': 0.58 }, layout: { visibility: vis } }, beforeParcel);
        overlayIds.push('excl-zone-fill', 'excl-zone');
      } catch { /* ignore */ }
    }

    // 5. Best zones — added after flood/wetland so they render on top of those layers
    // Both primary and secondary use the same solid green outline + static soft glow.
    // Amber is strictly reserved for bucket:possible soil fill — never used here.
    bestZones.forEach((zone, i) => {
      const isPrimary = zone.label === 'Primary';
      const srcId = `best-zone-${i}`;
      const zoneColor = zone.bucket === 'engineering-needed' ? '#F59E0B' : zone.bucket === 'not-suitable' ? '#EF4444' : '#22C55E';
      const zoneGlow  = zone.bucket === 'engineering-needed' ? '#F59E0B' : zone.bucket === 'not-suitable' ? '#EF4444' : '#30D158';
      try {
        map.addSource(srcId, { type: 'geojson', data: zone.geojson as mapboxgl.GeoJSONSourceSpecification['data'] });
        map.addLayer({ id: `${srcId}-fill`, type: 'fill', source: srcId, paint: { 'fill-color': zoneColor, 'fill-opacity': 0.55 }, layout: { visibility: vis } }, beforeParcel);
        if (isPrimary) {
          map.addLayer({ id: `${srcId}-glow`, type: 'line', source: srcId, paint: { 'line-color': zoneGlow, 'line-width': 6, 'line-opacity': 0.2, 'line-blur': 3 }, layout: { visibility: vis } }, beforeParcel);
          map.addLayer({ id: `${srcId}-outline`, type: 'line', source: srcId, paint: { 'line-color': zoneGlow, 'line-width': 2.5, 'line-opacity': 1.0 }, layout: { visibility: vis } }, beforeParcel);
          overlayIds.push(`${srcId}-fill`, `${srcId}-glow`, `${srcId}-outline`, srcId);
        } else {
          map.addLayer({ id: `${srcId}-glow`, type: 'line', source: srcId, paint: { 'line-color': zoneGlow, 'line-width': 6, 'line-opacity': 0.2, 'line-blur': 3 }, layout: { visibility: vis } }, beforeParcel);
          map.addLayer({ id: `${srcId}-outline`, type: 'line', source: srcId, paint: { 'line-color': zoneGlow, 'line-width': 2.5, 'line-opacity': 1.0 }, layout: { visibility: vis } }, beforeParcel);
          overlayIds.push(`${srcId}-fill`, `${srcId}-glow`, `${srcId}-outline`, srcId);
        }
      } catch { /* ignore */ }
    });

    soilLoadingRef.current = false;

    // If fresher soil results arrived while scoring was running, re-run the full overlay now.
    // This fixes the race where applyFullOverlay fires with stale cached results (e.g. 5 units)
    // while the bbox query is still in flight, then the new results (e.g. 14 units) arrive and
    // are stored in latestSoilResultsRef but never re-trigger scoring because soilLoadingRef was true.
    if (latestSoilResultsRef.current.length > scoringResults.length) {
      console.log('[applyFullOverlay] fresher results arrived during scoring (', scoringResults.length, '→', latestSoilResultsRef.current.length, ') — re-running overlay with fresh data');
      soilRenderedRef.current = false;
      bestZoneRef.current = null;
      soilResultsCountRef.current = 0;
      await applyFullOverlay(map, boundary, latestSoilResultsRef.current, visible);
      return;
    }

    // Soil click/hover — wired to the single soil-fill layer (register only once per map instance)
    if (!soilClickRegisteredRef.current) try {
      soilClickRegisteredRef.current = true;
      console.log('[click] registering soil zone click handler on layer:', 'soil-fill');
      map.on('mouseenter', 'soil-fill', () => { map.getCanvas().style.cursor = 'pointer'; });
      map.on('mouseleave', 'soil-fill', () => {
        map.getCanvas().style.cursor = '';
        onSoilHoverRef.current?.(null);
      });
      map.on('mousemove', 'soil-fill', (e) => {
        if (!e.features?.length) return;
        const p = e.features[0].properties as Record<string, unknown>;
        const bucket = String(p.bucket ?? 'no-data');
        const hasScore = bucket !== 'no-data' && p.suitabilityScore != null && p.suitabilityScore !== 'null';
        onSoilHoverRef.current?.({
          mukey: String(p.mukey ?? ''),
          bucket,
          finalScore: hasScore ? Number(p.suitabilityScore) : 0,
          floodOverlapPct: Number(p.floodOverlapPct ?? 0),
          wetlandOverlapPct: Number(p.wetlandOverlapPct ?? 0),
          drainScore: hasScore ? Number(p.drainageScore ?? 50) : 0,
          ksatScore: hasScore ? Number(p.ksatScore ?? 50) : 0,
          slopeScore: hasScore ? Number(p.slopeScore ?? 60) : 0,
          wtScore: hasScore ? Number(p.watertableScore ?? 55) : 0,
          pondingScore: hasScore && p.pondingScore != null && p.pondingScore !== 'null' ? Number(p.pondingScore) : null,
          restrictiveLayerScore: hasScore && p.restrictiveLayerScore != null && p.restrictiveLayerScore !== 'null' ? Number(p.restrictiveLayerScore) : null,
          floodingScore: hasScore && p.floodingScore != null && p.floodingScore !== 'null' ? Number(p.floodingScore) : null,
          soilName: String(p.muname ?? p.musym ?? `Soil unit ${p.mukey ?? ''}`),
          firedGates: (() => { try { return JSON.parse(String(p.firedGates ?? '[]')) as string[]; } catch { return []; } })(),
          gatingCeiling: p.gatingCeiling != null && p.gatingCeiling !== 'null' ? Number(p.gatingCeiling) : 100,
          rawWatertableInches: p.rawWatertableInches != null && p.rawWatertableInches !== 'null' ? Number(p.rawWatertableInches) : null,
          rawResdeptCm: p.rawResdeptCm != null && p.rawResdeptCm !== 'null' ? Number(p.rawResdeptCm) : null,
          rawFlodfreqcl: p.rawFlodfreqcl != null && p.rawFlodfreqcl !== 'null' ? String(p.rawFlodfreqcl) : null,
          rawSlopePct: p.rawSlopePct != null && p.rawSlopePct !== 'null' ? Number(p.rawSlopePct) : null,
          zoneSlopeDemPct: p.zoneSlopeDemPct != null && p.zoneSlopeDemPct !== 'null' ? Number(p.zoneSlopeDemPct) : null,
          clay40DepthCm: p.clay40DepthCm != null && p.clay40DepthCm !== 'null' ? Number(p.clay40DepthCm) : null,
          rawKsat: p.rawKsat != null && p.rawKsat !== 'null' ? Number(p.rawKsat) : null,
        });
      });
      map.on('click', 'soil-fill', (e) => {
        console.log('[click] soil zone clicked:', e.features);
        if (!e.features?.length) return;
        const p = e.features[0].properties as Record<string, unknown>;
        const bucket = String(p.bucket ?? 'no-data');
        const hasScore = bucket !== 'no-data' && p.suitabilityScore != null && p.suitabilityScore !== 'null';
        onSoilClickRef.current?.({
          mukey: String(p.mukey ?? ''),
          bucket,
          finalScore: hasScore ? Number(p.suitabilityScore) : 0,
          floodOverlapPct: Number(p.floodOverlapPct ?? 0),
          wetlandOverlapPct: Number(p.wetlandOverlapPct ?? 0),
          drainScore: hasScore ? Number(p.drainageScore ?? 50) : 0,
          ksatScore: hasScore ? Number(p.ksatScore ?? 50) : 0,
          slopeScore: hasScore ? Number(p.slopeScore ?? 60) : 0,
          wtScore: hasScore ? Number(p.watertableScore ?? 55) : 0,
          pondingScore: hasScore && p.pondingScore != null && p.pondingScore !== 'null' ? Number(p.pondingScore) : null,
          restrictiveLayerScore: hasScore && p.restrictiveLayerScore != null && p.restrictiveLayerScore !== 'null' ? Number(p.restrictiveLayerScore) : null,
          floodingScore: hasScore && p.floodingScore != null && p.floodingScore !== 'null' ? Number(p.floodingScore) : null,
          soilName: String(p.muname ?? p.musym ?? `Soil unit ${p.mukey ?? ''}`),
          firedGates: (() => { try { return JSON.parse(String(p.firedGates ?? '[]')) as string[]; } catch { return []; } })(),
          gatingCeiling: p.gatingCeiling != null && p.gatingCeiling !== 'null' ? Number(p.gatingCeiling) : 100,
          rawWatertableInches: p.rawWatertableInches != null && p.rawWatertableInches !== 'null' ? Number(p.rawWatertableInches) : null,
          rawResdeptCm: p.rawResdeptCm != null && p.rawResdeptCm !== 'null' ? Number(p.rawResdeptCm) : null,
          rawFlodfreqcl: p.rawFlodfreqcl != null && p.rawFlodfreqcl !== 'null' ? String(p.rawFlodfreqcl) : null,
          rawSlopePct: p.rawSlopePct != null && p.rawSlopePct !== 'null' ? Number(p.rawSlopePct) : null,
          zoneSlopeDemPct: p.zoneSlopeDemPct != null && p.zoneSlopeDemPct !== 'null' ? Number(p.zoneSlopeDemPct) : null,
          clay40DepthCm: p.clay40DepthCm != null && p.clay40DepthCm !== 'null' ? Number(p.clay40DepthCm) : null,
          rawKsat: p.rawKsat != null && p.rawKsat !== 'null' ? Number(p.rawKsat) : null,
        });
      });
    } catch { /* ignore interaction setup errors */ } // end soil click/hover registration

    // Zone markers + perc pins
    zoneMarkersRef.current.forEach(m => m.remove());
    zoneMarkersRef.current = [];
    percMarkersRef.current.forEach(m => m.remove());
    percMarkersRef.current = [];
    noZoneBadgeRef.current?.remove();
    noZoneBadgeRef.current = null;

    // Zone rank badges — compact "Best" / "2nd" / "3rd" at polylabel center
    zoneBadgeMarkersRef.current.forEach(m => m.remove());
    zoneBadgeMarkersRef.current = [];

    const BADGE_PIN_CLEAR_PX = 40;
    const zoneBadgeEntries: { marker: mapboxgl.Marker; poly: turf.Feature<turf.Polygon | turf.MultiPolygon> }[] = [];

    const zoneBadgeConfigs: { label: BestZone['label']; rank: string }[] = [
      { label: 'Primary',     rank: 'Best' },
      { label: 'Alternative', rank: '2nd'  },
      { label: 'Third',       rank: '3rd'  },
    ];
    const renderedBadgeColors: string[] = [];

    for (const { label, rank } of zoneBadgeConfigs) {
      const zone = bestZones.find(z => z.label === label);
      if (!zone) continue;
      const zoneScore = (zone.geojson.properties as Record<string, unknown>)?.suitabilityScore as number ?? null;
      const zoneBucket = (zone.geojson.properties as Record<string, unknown>)?.bucket as string ?? zone.bucket;
      const borderColor = zoneBucket === 'viable' ? '#22C55E' : zoneBucket === 'engineering-needed' ? '#FF9F09' : '#FF4539';

      // Use largest sub-polygon for MultiPolygon
      let badgePoly: turf.Feature<turf.Polygon | turf.MultiPolygon> = zone.geojson;
      if (zone.geojson.geometry.type === 'MultiPolygon') {
        const subPolys = zone.geojson.geometry.coordinates.map(coords => turf.polygon(coords));
        const largest = subPolys.sort((a, b) => turf.area(b) - turf.area(a))[0];
        if (largest) badgePoly = { ...zone.geojson, geometry: largest.geometry };
      }

      // Polylabel anchor — unchanged from previous implementation
      let badgeLngLat: [number, number] = zone.centroid;
      try {
        const anchorGeom = badgePoly.geometry.type === 'Polygon'
          ? badgePoly.geometry
          : (badgePoly.geometry as turf.MultiPolygon).coordinates
              .map(c => turf.polygon(c))
              .sort((a, b) => turf.area(b) - turf.area(a))[0]?.geometry ?? badgePoly.geometry;
        const rings = anchorGeom.type === 'Polygon' ? anchorGeom.coordinates : anchorGeom.coordinates[0];
        const pt = polylabel(rings as number[][][], 0.0001);
        badgeLngLat = [pt[0], pt[1]];
        console.log('[zones] polylabel anchor for mukey', zone.mukey, ':', badgeLngLat);
      } catch { /* keep original centroid */ }

      // Skip badge if anchor falls outside parcel boundary — prevents off-map labels
      if (boundary) {
        try {
          const anchorPt = turf.point(badgeLngLat);
          const parcelFeat = toParcelFeature(boundary);
          if (!turf.booleanPointInPolygon(anchorPt, parcelFeat)) {
            console.log('[zones] badge anchor outside parcel — skipping zone', zone.mukey);
            continue;
          }
        } catch { /* keep rendering if check fails */ }
      }

      const areaSqM = zone.areaSqM ?? turf.area(zone.geojson);
      const tooltipText = `Score ${zoneScore ?? '—'} · ${Math.round(areaSqM).toLocaleString()} sqm`;

      // Build badge element. The outer div must have no layout-affecting CSS so Mapbox
      // can correctly measure it for anchor offset calculation before the first paint.
      const el = document.createElement('div');
      el.className = 'zone-marker';
      el.dataset.zoneBucket = zoneBucket;
      el.style.cssText = 'cursor:default;transition:opacity 300ms;';

      const badgeDiv = document.createElement('div');
      badgeDiv.className = 'zone-badge';
      badgeDiv.style.cssText = `
        display:inline-flex;align-items:center;gap:5px;
        background:rgba(15,23,41,0.85);border:1px solid ${borderColor};
        border-radius:4px;padding:4px 8px;font-size:11px;font-weight:600;
        color:#fff;white-space:nowrap;backdrop-filter:blur(8px);user-select:none;
        position:relative;
      `.replace(/\s+/g, ' ');

      const dot = document.createElement('span');
      dot.style.cssText = `width:6px;height:6px;border-radius:50%;background:${borderColor};flex-shrink:0;display:inline-block;`;

      const rankSpan = document.createElement('span');
      rankSpan.textContent = rank;

      const tip = document.createElement('span');
      tip.className = 'zone-badge-tooltip';
      tip.style.cssText = `
        display:none;position:absolute;bottom:calc(100% + 6px);left:50%;
        transform:translateX(-50%);background:rgba(10,14,26,0.95);
        border:1px solid rgba(255,255,255,0.12);border-radius:4px;
        padding:3px 7px;font-size:10px;font-weight:500;color:rgba(255,255,255,0.75);
        white-space:nowrap;pointer-events:none;z-index:10;
      `.replace(/\s+/g, ' ');
      tip.textContent = tooltipText;

      badgeDiv.appendChild(dot);
      badgeDiv.appendChild(rankSpan);
      badgeDiv.appendChild(tip);
      el.appendChild(badgeDiv);

      badgeDiv.addEventListener('mouseenter', () => { tip.style.display = 'block'; });
      badgeDiv.addEventListener('mouseleave', () => { tip.style.display = 'none'; });

      if (!visible || !zoneLabelsVisibleRef.current) el.style.display = 'none';
      el.style.zIndex = '1'; // perc pin DOM markers use z-index 10 and must stack above these
      const marker = new mapboxgl.Marker({ element: el, anchor: 'center' }).setLngLat(badgeLngLat).addTo(map);
      zoneMarkersRef.current.push(marker);
      zoneBadgeMarkersRef.current.push(marker);
      zoneBadgeEntries.push({ marker, poly: badgePoly });
      renderedBadgeColors.push(borderColor);
      applyZoneMarkerTabFilter(el, activeTabRef.current ?? 'parcel');
    }

    // Update legend dots to reflect actual bucket colors of rendered zones
    if (renderedBadgeColors.length > 0) {
      const colors = ['#22C55E', '#22C55E', '#22C55E'].map((def, i) => renderedBadgeColors[i] ?? def);
      setZoneBadgeColorsRef.current(colors);
    }


    // ── Possible Perc Site pins — distributed across best zones up to MAX_PERC_PINS ──
    const MAX_PERC_PINS = 3;
    if (bestZones.length > 0) {
      try {
        const primaryZone = bestZones.find(z => z.label === 'Primary') ?? bestZones[0];

        // ─── Placement constants ──────────────────────────────────────────────
        const SETBACK_M = 3;
        const CLEARANCE_FLOOR_FRAC = 0.6;
        const W_CLEAR = 0.5;
        const W_FLAT = 0.5;
        const ROWS = 8, COLS = 8;
        const MIN_PIN_SPACING_M = 15;

        type ScoredPoint = {
          pt: turf.Feature<turf.Point>;
          ptScore: number;
          inFlood: boolean;
          inWetland: boolean;
          slope: number | null;
          distToEdge: number;
          actualSlope: number | null;
          demSlopeScore: number;
          clearance?: number;
          isFallback?: boolean;
          zoneLabel: string;
          zoneMukey: string;
          zonePercMethod: string;
          zonePoly: turf.Feature<turf.Polygon | turf.MultiPolygon>;
        };

        const selectFromPool = (pool: ScoredPoint[], spacing: number, limit: number): ScoredPoint[] => {
          const ranked = pool
            .filter(p => p.ptScore > 0)
            .sort((a, b) => {
              if (b.ptScore !== a.ptScore) return b.ptScore - a.ptScore;
              if (a.actualSlope !== null && b.actualSlope !== null) return a.actualSlope - b.actualSlope;
              return b.distToEdge - a.distToEdge;
            });
          const out: ScoredPoint[] = [];
          for (const candidate of ranked) {
            const tooClose = out.some(s => turf.distance(candidate.pt, s.pt, { units: 'meters' }) < spacing);
            if (!tooClose) out.push(candidate);
            if (out.length === limit) break;
          }
          return out;
        };

        // Build a line from parcel boundary for edge-distance scoring (shared across zones)
        let parcelLine: turf.Feature<turf.LineString | turf.MultiLineString> | null = null;
        try { parcelLine = turf.polygonToLine(toParcelFeature(boundary)) as turf.Feature<turf.LineString | turf.MultiLineString>; } catch { /* skip */ }

        // Scale edge-distance thresholds to parcel size (shared across zones)
        const parcelAreaSqM = (() => { try { return turf.area(toParcelFeature(boundary)); } catch { return turf.area(primaryZone.geojson); } })();
        const parcelRadiusM = Math.sqrt(parcelAreaSqM / Math.PI);
        const MIN_EXCLUSION_EDGE_DIST_M = parcelAreaSqM < 500 ? 5 : 20;
        const EDGE_BONUS_HI_M = Math.max(parcelRadiusM * 0.6, 10);
        const EDGE_BONUS_LO_M = Math.max(parcelRadiusM * 0.3, 5);

        const distToExclusionEdge = (pt: turf.Feature<turf.Point>, geom: turf.Feature<turf.Polygon | turf.MultiPolygon>): number => {
          try {
            const line = turf.polygonToLine(geom) as turf.Feature<turf.LineString | turf.MultiLineString>;
            const nearest = turf.nearestPointOnLine(line, pt, { units: 'meters' });
            return nearest.properties.dist ?? 999;
          } catch { return 999; }
        };

        // Await DEM once before iterating zones
        const { ready: demAvailable, wasActive: demWasActive } = mapRef.current
          ? await waitForDEM(mapRef.current)
          : { ready: false, wasActive: false };
        if (demAvailable) console.log('[perc] DEM ready — using real elevation slope');
        else console.log('[perc] DEM timed out after 5000ms — using SSURGO fallback');

        // Accumulated pins across all zones, plus shared state
        const allSelected: ScoredPoint[] = [];
        let fromExpandedSearch = false;
        let bestZoneEntirelyInFlood = false;
        let totalCandidates = 0;

        const zoneOrderLabel: Record<string, string> = { Primary: 'best', Alternative: '2nd', Third: '3rd' };

        // ── Zone loop: fill slots in rank order (best → 2nd → 3rd) ────────────
        for (const zone of bestZones) {
          if (allSelected.length >= MAX_PERC_PINS) break;
          const remainingSlots = MAX_PERC_PINS - allSelected.length;
          const zoneLabel = zoneOrderLabel[zone.label] ?? zone.label;
          const zonePoly = zone.geojson;
          console.log('[perc] processing zone:', zoneLabel, 'mukey:', zone.mukey, 'remaining slots:', remainingSlots);
          console.log('[perc] clipping against geometry type:', zonePoly?.geometry?.type);

          // For MultiPolygon, extract the largest sub-polygon as the sampling base
          let samplingPolygon: turf.Feature<turf.Polygon | turf.MultiPolygon> = zonePoly;
          if (zonePoly.geometry.type === 'MultiPolygon') {
            const subPolys = zonePoly.geometry.coordinates.map(coords => turf.polygon(coords));
            const largest = subPolys.sort((a, b) => turf.area(b) - turf.area(a))[0];
            if (largest) {
              samplingPolygon = { ...zonePoly, geometry: largest.geometry };
              console.log('[perc] MultiPolygon — using largest sub-polygon:', Math.round(turf.area(largest)), 'sqm from', subPolys.length, 'total parts');
            }
          }

          // Subtract flood zone from sampling area to prefer flood-free locations
          let samplingZone: turf.Feature<turf.Polygon | turf.MultiPolygon> = samplingPolygon;
          let zoneEntirelyInFlood = false;
          if (floodFeatures.length > 0) {
            try {
              let clean: turf.Feature<turf.Polygon | turf.MultiPolygon> = samplingPolygon;
              for (const fp of floodFeatures) {
                const diff = turf.difference(turf.featureCollection([clean, fp]));
                if (diff) clean = diff;
              }
              const cleanArea = turf.area(clean);
              const origArea = turf.area(samplingPolygon);
              if (cleanArea / origArea >= 0.20) {
                samplingZone = clean;
                console.log('[perc] sampling from flood-free zone:', Math.round(cleanArea), 'sqm');
              } else {
                zoneEntirelyInFlood = true;
                console.log('[perc] zone entirely in flood zone — using full polygon as fallback with warning flag');
              }
            } catch (e) {
              console.warn('[perc] zone difference failed:', (e as Error).message);
            }
          }
          if (zone.label === 'Primary' && zoneEntirelyInFlood) {
            bestZoneEntirelyInFlood = true;
            onBestZoneInFloodRef.current?.(true);
          }

          // Decompose samplingZone into simple Polygon pieces
          const zonePolygons: turf.Feature<turf.Polygon>[] = [];
          if (samplingZone.geometry.type === 'MultiPolygon') {
            for (const coords of samplingZone.geometry.coordinates) {
              try { zonePolygons.push(turf.polygon(coords)); } catch { /* skip degenerate ring */ }
            }
          } else {
            zonePolygons.push(samplingZone as turf.Feature<turf.Polygon>);
          }
          const isInsideZone = (pt: turf.Feature<turf.Point>): boolean =>
            zonePolygons.some(poly => { try { return turf.booleanPointInPolygon(pt, poly); } catch { return false; } });

          // Dynamic spacing and per-zone pin cap (also capped by remaining global budget)
          const samplingArea = turf.area(samplingZone);
          const fullZoneArea = zone.areaSqM ?? turf.area(zonePoly);
          const rawSpacing = Math.sqrt(samplingArea / Math.PI) * 0.4;
          const minSpacing = Math.max(Math.min(rawSpacing, 40), 8);
          const areaBasedMax = fullZoneArea < 2000 ? 1 : fullZoneArea < 8000 ? 2 : 3;
          const maxPins = Math.min(areaBasedMax, remainingSlots);
          console.log('[perc] zone area (full):', Math.round(fullZoneArea), 'sqm flood-free:', Math.round(samplingArea), 'sqm max pins:', maxPins);

          // 2D bbox grid — 8×8 cells, center of each cell as candidate point
          const [minLng, minLat, maxLng, maxLat] = turf.bbox(samplingZone);
          const stepLat = (maxLat - minLat) / ROWS;
          const stepLng = (maxLng - minLng) / COLS;
          const insidePoints: turf.Feature<turf.Point>[] = [];
          for (let row = 0; row < ROWS; row++) {
            for (let col = 0; col < COLS; col++) {
              const pLat = minLat + stepLat * (row + 0.5);
              const pLng = minLng + stepLng * (col + 0.5);
              const pt = turf.point([pLng, pLat]);
              if (isInsideZone(pt)) insidePoints.push(pt);
            }
          }
          totalCandidates += insidePoints.length;
          console.log('[perc] candidate points in flood-free zone:', insidePoints.length);

          // ─── STEP 1: buildable = (zone ∩ parcel) buffered inward by SETBACK_M ──
          let buildable: turf.Feature<turf.Polygon> | null = null;
          let buildableLine: turf.Feature<turf.LineString | turf.MultiLineString> | null = null;
          let polylabelPt: turf.Feature<turf.Point> | null = null;
          let percPinMethod = 'legacy';
          try {
            const parcelPoly = toParcelFeature(boundary);
            let base: turf.Feature<turf.Polygon | turf.MultiPolygon>;
            try {
              const inter = turf.intersect(turf.featureCollection([
                zonePoly as turf.Feature<turf.Polygon | turf.MultiPolygon>,
                parcelPoly as turf.Feature<turf.Polygon>,
              ]));
              base = (inter && (inter.geometry.type === 'Polygon' || inter.geometry.type === 'MultiPolygon'))
                ? inter as turf.Feature<turf.Polygon | turf.MultiPolygon>
                : samplingZone as turf.Feature<turf.Polygon | turf.MultiPolygon>;
            } catch {
              base = samplingZone as turf.Feature<turf.Polygon | turf.MultiPolygon>;
            }
            // Inward buffer — negative distance shrinks polygon
            const shrunk = turf.buffer(base, -SETBACK_M, { units: 'meters' });
            if (!shrunk || !shrunk.geometry) throw new Error('inward buffer returned empty geometry');
            // Keep largest ring if MultiPolygon
            let best: turf.Feature<turf.Polygon>;
            if (shrunk.geometry.type === 'MultiPolygon') {
              const parts = (shrunk.geometry.coordinates as number[][][][]).map(c => turf.polygon(c));
              parts.sort((a, b) => turf.area(b) - turf.area(a));
              if (parts.length === 0) throw new Error('no polygon parts after inward buffer');
              best = parts[0];
            } else {
              best = shrunk as turf.Feature<turf.Polygon>;
            }
            buildable = best;
            buildableLine = turf.polygonToLine(buildable) as turf.Feature<turf.LineString | turf.MultiLineString>;
            // polylabel — deepest interior point, guaranteed to survive clearance floor
            const rings = buildable.geometry.coordinates as number[][][];
            const plResult = polylabel(rings, 0.0001);
            polylabelPt = turf.point([plResult[0], plResult[1]]);
            console.log('[perc-pin] buildable area:', Math.round(turf.area(buildable)), 'sqm setback_m:', SETBACK_M);
          } catch (e) {
            console.warn('[perc-pin] buildable construction failed:', (e as Error).message, '— zone pins will be suppressed');
            buildable = null; buildableLine = null; polylabelPt = null;
          }

          // ─── STEP 2: Filter grid to buildable interior; inject polylabel ──────
          let candidatePoints: turf.Feature<turf.Point>[] = insidePoints;
          if (buildable) {
            const filtered = insidePoints.filter(pt => {
              try { return turf.booleanPointInPolygon(pt, buildable!); } catch { return false; }
            });
            // polylabel always enters candidate set when buildable exists
            candidatePoints = polylabelPt ? [...filtered, polylabelPt] : filtered;
            console.log('[perc-pin] inside buildable:', filtered.length, '+ polylabel =', candidatePoints.length, 'candidates setback_m:', SETBACK_M);
          }

          let exclusionEdgeDiscardCount = 0;

          const scoredPoints: ScoredPoint[] = candidatePoints.map(pt => {
            const [pLng, pLat] = pt.geometry.coordinates;
            const inFlood = floodUnion
              ? (() => { try { return turf.booleanPointInPolygon(pt, floodUnion); } catch { return false; } })()
              : floodFeatures.some(f => { try { return turf.booleanPointInPolygon(pt, f); } catch { return false; } });
            const inWetland = wetlandUnion
              ? (() => { try { return turf.booleanPointInPolygon(pt, wetlandUnion); } catch { return false; } })()
              : wetlandFeatures.some(w => { try { return turf.booleanPointInPolygon(pt, w); } catch { return false; } });

            // Discard candidates within MIN_EXCLUSION_EDGE_DIST_M of any wetland or flood boundary
            if (!inWetland && wetlandUnion) {
              if (distToExclusionEdge(pt as turf.Feature<turf.Point>, wetlandUnion) < MIN_EXCLUSION_EDGE_DIST_M) {
                exclusionEdgeDiscardCount++;
                return { pt: pt as turf.Feature<turf.Point>, ptScore: -999, inFlood, inWetland, slope: null, distToEdge: 0, actualSlope: null, demSlopeScore: 0, zoneLabel, zoneMukey: zone.mukey, zonePercMethod: percPinMethod, zonePoly };
              }
            }
            if (!inFlood && floodUnion) {
              if (distToExclusionEdge(pt as turf.Feature<turf.Point>, floodUnion) < MIN_EXCLUSION_EDGE_DIST_M) {
                exclusionEdgeDiscardCount++;
                return { pt: pt as turf.Feature<turf.Point>, ptScore: -999, inFlood, inWetland, slope: null, distToEdge: 0, actualSlope: null, demSlopeScore: 0, zoneLabel, zoneMukey: zone.mukey, zonePercMethod: percPinMethod, zonePoly };
              }
            }

            let distToEdge = 999;
            if (parcelLine) {
              try { distToEdge = turf.nearestPointOnLine(parcelLine, pt as turf.Feature<turf.Point>, { units: 'meters' }).properties.dist ?? 999; } catch { /* keep 999 */ }
            }
            const edgeBonus = distToEdge > EDGE_BONUS_HI_M ? 20 : distToEdge > EDGE_BONUS_LO_M ? 5 : 0;

            // STEP 3: clearance = distance from candidate to buildable boundary
            let clearance = distToEdge;
            if (buildableLine) {
              try { clearance = turf.nearestPointOnLine(buildableLine, pt as turf.Feature<turf.Point>, { units: 'meters' }).properties.dist ?? distToEdge; } catch { /* keep fallback */ }
            }

            // Slope: prefer DEM-derived actual slope; fall back to SSURGO slope_h
            const parentPoly = soilPolygons.find(p => { try { return turf.booleanPointInPolygon(pt, p.geojson); } catch { return false; } });
            const ssurgoSlope = parentPoly ? (parseFloat(parentPoly.geojson.properties?.slope_h as string) || null) : null;
            const actualSlope = demAvailable && mapRef.current ? getActualSlope(mapRef.current, pLng, pLat) : null;

            if (actualSlope !== null && actualSlope > 15) {
              return { pt: pt as turf.Feature<turf.Point>, ptScore: -999, inFlood, inWetland, slope: ssurgoSlope, distToEdge: Math.round(distToEdge), actualSlope, demSlopeScore: 0, zoneLabel, zoneMukey: zone.mukey, zonePercMethod: percPinMethod, zonePoly };
            }

            const demSlopeScore = actualSlope === null ? 0
              : actualSlope <= 5 ? 100
              : actualSlope <= 8 ? 85
              : actualSlope <= 12 ? 65
              : 45;

            const slopePenalty = actualSlope !== null
              ? (actualSlope <= 5 ? 0 : actualSlope <= 8 ? -15 : actualSlope <= 12 ? -35 : -55)
              : (ssurgoSlope === null ? 0 : ssurgoSlope <= 8 ? 0 : ssurgoSlope <= 15 ? -10 : ssurgoSlope <= 25 ? -30 : -999);

            const ptScore = (inFlood ? 0 : 40) + (inWetland ? 0 : 40) + edgeBonus + slopePenalty;
            return { pt: pt as turf.Feature<turf.Point>, ptScore, inFlood, inWetland, slope: ssurgoSlope, distToEdge: Math.round(distToEdge), actualSlope, demSlopeScore, clearance: Math.round(clearance), zoneLabel, zoneMukey: zone.mukey, zonePercMethod: percPinMethod, zonePoly };
          });

          console.log('[perc] discarded', exclusionEdgeDiscardCount, 'candidates — too close to wetland/flood edge (<20m)');
          let zoneSelected = selectFromPool(scoredPoints, minSpacing, maxPins);

          // ─── STEP 4 + 5: Clearance floor → flatness ranking ────────────────────
          if (buildable && zoneSelected.length > 0) {
            const isPolylabelPt = (sp: ScoredPoint): boolean =>
              polylabelPt !== null &&
              Math.abs(sp.pt.geometry.coordinates[0] - polylabelPt.geometry.coordinates[0]) < 1e-8 &&
              Math.abs(sp.pt.geometry.coordinates[1] - polylabelPt.geometry.coordinates[1]) < 1e-8;

            // Ensure polylabel is in the pool — it bypasses all hard gates per spec
            const polylabelInSelected = zoneSelected.some(isPolylabelPt);
            if (!polylabelInSelected && polylabelPt) {
              const [plLng, plLat] = polylabelPt.geometry.coordinates;
              const plActualSlope = demAvailable && mapRef.current ? getActualSlope(mapRef.current, plLng, plLat) : null;
              let plDistToEdge = 0;
              if (parcelLine) { try { plDistToEdge = Math.round(turf.nearestPointOnLine(parcelLine, polylabelPt, { units: 'meters' }).properties.dist ?? 0); } catch { /* keep 0 */ } }
              let plClearance = 0;
              if (buildableLine) { try { plClearance = Math.round(turf.nearestPointOnLine(buildableLine, polylabelPt, { units: 'meters' }).properties.dist ?? 0); } catch { /* keep 0 */ } }
              const plDemSlopeScore = plActualSlope === null ? 0 : plActualSlope <= 5 ? 100 : plActualSlope <= 8 ? 85 : plActualSlope <= 12 ? 65 : 45;
              const plSlopePenalty = plActualSlope === null ? 0 : plActualSlope <= 5 ? 0 : plActualSlope <= 8 ? -15 : plActualSlope <= 12 ? -35 : -55;
              const plPtScore = 40 + 40 + (plDistToEdge > EDGE_BONUS_HI_M ? 20 : plDistToEdge > EDGE_BONUS_LO_M ? 5 : 0) + plSlopePenalty;
              zoneSelected = [...zoneSelected, { pt: polylabelPt, ptScore: plPtScore, inFlood: false, inWetland: false, slope: null, distToEdge: plDistToEdge, actualSlope: plActualSlope, demSlopeScore: plDemSlopeScore, clearance: plClearance, zoneLabel, zoneMukey: zone.mukey, zonePercMethod: percPinMethod, zonePoly }];
            }

            // Step 4: hard clearance floor — polylabel always survives, others must clear it
            const maxClearance = Math.max(...zoneSelected.map(s => s.clearance ?? 0));
            const clearanceFloor = CLEARANCE_FLOOR_FRAC * maxClearance;
            const survivors = zoneSelected.filter(s => isPolylabelPt(s) || (s.clearance ?? 0) >= clearanceFloor);

            // Step 5: rank survivors by flatness + clearance
            const allSlopesNull = survivors.every(s => s.actualSlope === null);
            if (allSlopesNull) {
              percPinMethod = 'polylabel-no-dem';
              survivors.sort((a, b) => (b.clearance ?? 0) - (a.clearance ?? 0));
            } else {
              percPinMethod = 'polylabel-flat';
              const clears = survivors.map(s => s.clearance ?? 0);
              const minC = Math.min(...clears);
              const maxC = Math.max(...clears);
              const cRange = maxC - minC || 1;
              const validSlopes = survivors.filter(s => s.actualSlope !== null).map(s => s.actualSlope!);
              const minS = Math.min(...validSlopes);
              const maxS = Math.max(...validSlopes);
              const sRange = maxS - minS || 1;
              survivors.sort((a, b) => {
                const cNormA = ((a.clearance ?? 0) - minC) / cRange;
                const cNormB = ((b.clearance ?? 0) - minC) / cRange;
                // null actualSlope → worst-case slopeNorm = 1
                const sNormA = a.actualSlope !== null ? (a.actualSlope - minS) / sRange : 1;
                const sNormB = b.actualSlope !== null ? (b.actualSlope - minS) / sRange : 1;
                const rankA = W_CLEAR * cNormA + W_FLAT * (1 - sNormA);
                const rankB = W_CLEAR * cNormB + W_FLAT * (1 - sNormB);
                return rankB - rankA;
              });
            }

            // Sequential spacing gate: skip any survivor within MIN_PIN_SPACING_M of
            // an already-chosen pin in this zone. Zones too small to fit two well-spaced
            // pins yield fewer pins here; remaining slots fall to the next zone.
            const spacingPassed: ScoredPoint[] = [];
            let spacingDiscarded = 0;
            for (const sp of survivors) {
              const tooClose = spacingPassed.some(placed =>
                turf.distance(placed.pt, sp.pt, { units: 'meters' }) < MIN_PIN_SPACING_M
              );
              if (tooClose) { spacingDiscarded++; } else { spacingPassed.push(sp); }
              if (spacingPassed.length >= maxPins) break;
            }
            console.log(`[perc-pin] zone: ${zoneLabel} mukey: ${zone.mukey} spacing_filter_discarded: ${spacingDiscarded}`);
            zoneSelected = spacingPassed.map(sp => ({ ...sp, zonePercMethod: percPinMethod }));

            for (let rank = zoneSelected.length + 1; rank <= maxPins; rank++) {
              console.log(`[perc-pin] rank: ${allSelected.length + rank} zone: ${zoneLabel} mukey: ${zone.mukey} suppressed: true reason: no-interior-after-setback`);
            }
          } else if (!buildable) {
            for (let rank = 1; rank <= maxPins; rank++) {
              console.log(`[perc-pin] rank: ${allSelected.length + rank} zone: ${zoneLabel} mukey: ${zone.mukey} suppressed: true reason: error`);
            }
            zoneSelected = [];
          }

          allSelected.push(...zoneSelected);
        } // end zone loop

        // ─── Expanded search: all best zones gave 0 pins — try remaining viable polygons ──
        if (allSelected.length === 0) {
          const expandedPolygons = soilPolygons.filter(p => {
            if (p.bucket !== 'viable' && p.bucket !== 'engineering-needed') return false;
            const floodOvr = (p.geojson.properties?.floodOverlapPct as number) ?? 0;
            const wetOvr = (p.geojson.properties?.wetlandOverlapPct as number) ?? 0;
            return floodOvr < 50 && wetOvr < 50;
          }).sort((a, b) => {
            const sa = (a.geojson.properties?.suitabilityScore as number) ?? 0;
            const sb = (b.geojson.properties?.suitabilityScore as number) ?? 0;
            return sb - sa;
          });

          console.log('[perc] expanded search trying zones in order:',
            expandedPolygons.map(z => z.mukey + ':' + ((z.geojson.properties?.suitabilityScore as number) ?? 0) + ':' + z.bucket).join(', '));

          for (const sp of expandedPolygons) {
            const parts: turf.Feature<turf.Polygon>[] = [];
            if (sp.geojson.geometry.type === 'MultiPolygon') {
              for (const coords of sp.geojson.geometry.coordinates) {
                try { parts.push(turf.polygon(coords)); } catch { /* skip */ }
              }
            } else {
              parts.push(sp.geojson as turf.Feature<turf.Polygon>);
            }
            if (parts.length === 0) continue;

            const isInZone = (pt: turf.Feature<turf.Point>) =>
              parts.some(poly => { try { return turf.booleanPointInPolygon(pt, poly); } catch { return false; } });

            const [zMinLng, zMinLat, zMaxLng, zMaxLat] = turf.bbox(turf.featureCollection(parts));
            const zStepLat = (zMaxLat - zMinLat) / ROWS;
            const zStepLng = (zMaxLng - zMinLng) / COLS;
            const zonePoints: turf.Feature<turf.Point>[] = [];
            for (let row = 0; row < ROWS; row++) {
              for (let col = 0; col < COLS; col++) {
                const pt = turf.point([zMinLng + zStepLng * (col + 0.5), zMinLat + zStepLat * (row + 0.5)]);
                if (isInZone(pt)) zonePoints.push(pt);
              }
            }

            const zoneScored: ScoredPoint[] = zonePoints.map(pt => {
              const [pLng, pLat] = pt.geometry.coordinates;
              const inFlood = floodUnion
                ? (() => { try { return turf.booleanPointInPolygon(pt, floodUnion); } catch { return false; } })()
                : floodFeatures.some(f => { try { return turf.booleanPointInPolygon(pt, f); } catch { return false; } });
              const inWetland = wetlandUnion
                ? (() => { try { return turf.booleanPointInPolygon(pt, wetlandUnion); } catch { return false; } })()
                : wetlandFeatures.some(w => { try { return turf.booleanPointInPolygon(pt, w); } catch { return false; } });
              let distToEdge = 999;
              if (parcelLine) {
                try { distToEdge = turf.nearestPointOnLine(parcelLine, pt as turf.Feature<turf.Point>, { units: 'meters' }).properties.dist ?? 999; } catch { /* keep 999 */ }
              }
              const edgeBonus = distToEdge > EDGE_BONUS_HI_M ? 20 : distToEdge > EDGE_BONUS_LO_M ? 5 : 0;
              const ssurgoSlope = parseFloat(sp.geojson.properties?.slope_h as string) || null;
              const actualSlope = demAvailable && mapRef.current ? getActualSlope(mapRef.current, pLng, pLat) : null;

              if (actualSlope !== null && actualSlope > 15) {
                return { pt: pt as turf.Feature<turf.Point>, ptScore: -999, inFlood, inWetland, slope: ssurgoSlope, distToEdge: Math.round(distToEdge), actualSlope, demSlopeScore: 0, zoneLabel: 'expanded', zoneMukey: sp.mukey, zonePercMethod: 'expanded', zonePoly: sp.geojson };
              }

              const demSlopeScore = actualSlope === null ? 0
                : actualSlope <= 5 ? 100
                : actualSlope <= 8 ? 85
                : actualSlope <= 12 ? 65
                : 45;

              const slopePenalty = actualSlope !== null
                ? (actualSlope <= 5 ? 0 : actualSlope <= 8 ? -15 : actualSlope <= 12 ? -35 : -55)
                : (ssurgoSlope === null ? 0 : ssurgoSlope <= 8 ? 0 : ssurgoSlope <= 15 ? -10 : ssurgoSlope <= 25 ? -30 : -999);

              const ptScore = (inFlood ? 0 : 40) + (inWetland ? 0 : 40) + edgeBonus + slopePenalty;
              return { pt: pt as turf.Feature<turf.Point>, ptScore, inFlood, inWetland, slope: ssurgoSlope, distToEdge: Math.round(distToEdge), actualSlope, demSlopeScore, zoneLabel: 'expanded', zoneMukey: sp.mukey, zonePercMethod: 'expanded', zonePoly: sp.geojson };
            });

            const candidates = selectFromPool(zoneScored, 8, MAX_PERC_PINS);
            if (candidates.length > 0) {
              allSelected.push(...candidates);
              fromExpandedSearch = true;
              console.log('[perc] expanded search placed pins in zone', sp.mukey, 'score', (sp.geojson.properties?.suitabilityScore as number) ?? 0, 'bucket', sp.bucket);
              break;
            }
          }
        }

        const demDiscarded = allSelected.filter(p => p.actualSlope !== null && p.actualSlope > 15).length;
        if (demDiscarded > 0) console.log(`[perc] discarded ${demDiscarded} candidates — DEM slope > 15%`);
        allSelected.forEach((s, i) => {
          if (s.actualSlope !== null) {
            console.log(`[perc] pin ${i + 1} — DEM slope: ${s.actualSlope.toFixed(1)}% score: ${s.demSlopeScore} (was SSURGO: ${s.slope ?? 'unknown'})`);
          }
        });
        console.log('[perc] selected pins:', allSelected.length,
          'scores:', allSelected.map(s => s.ptScore).join(', '),
          'flood:', allSelected.map(s => s.inFlood).join(', '),
          'wetland:', allSelected.map(s => s.inWetland).join(', '),
          'slope:', allSelected.map(s => s.actualSlope !== null ? s.actualSlope.toFixed(1) + '% (DEM)' : (s.slope ?? 'unknown') + '% (SSURGO)').join(', '),
          'edge dist:', allSelected.map(s => s.distToEdge + 'm').join(', '),
          fromExpandedSearch ? '(expanded search)' : '');

        // True fallback: all zones exhausted — place on primary zone centroid
        if (allSelected.length === 0) {
          const fallbackZonePoly = primaryZone.geojson;
          const fallbackPin = turf.pointOnFeature(fallbackZonePoly);
          const fbPt = fallbackPin as turf.Feature<turf.Point>;
          const [fbLng, fbLat] = fbPt.geometry.coordinates;
          const fbInFlood = floodUnion
            ? (() => { try { return turf.booleanPointInPolygon(fbPt, floodUnion); } catch { return false; } })()
            : floodFeatures.some(f => { try { return turf.booleanPointInPolygon(fbPt, f); } catch { return false; } });
          const fbInWetland = wetlandUnion
            ? (() => { try { return turf.booleanPointInPolygon(fbPt, wetlandUnion); } catch { return false; } })()
            : wetlandFeatures.some(w => { try { return turf.booleanPointInPolygon(fbPt, w); } catch { return false; } });
          const fbActualSlope = demAvailable && mapRef.current ? getActualSlope(mapRef.current, fbLng, fbLat) : null;
          const fbParentPoly = soilPolygons.find(p => { try { return turf.booleanPointInPolygon(fbPt, p.geojson); } catch { return false; } });
          const fbSsurgoSlope = fbParentPoly ? (parseFloat(fbParentPoly.geojson.properties?.slope_h as string) || null) : null;
          const fbDemSlopeScore = fbActualSlope === null ? 0 : fbActualSlope <= 5 ? 100 : fbActualSlope <= 8 ? 85 : fbActualSlope <= 12 ? 65 : 45;
          let fbDistToEdge = 0;
          if (parcelLine) { try { fbDistToEdge = Math.round(turf.nearestPointOnLine(parcelLine, fbPt, { units: 'meters' }).properties.dist ?? 0); } catch { /* keep 0 */ } }
          const fbPtScore = (fbInFlood ? 0 : 40) + (fbInWetland ? 0 : 40);
          allSelected.push({ pt: fbPt, ptScore: fbPtScore, inFlood: fbInFlood, inWetland: fbInWetland, slope: fbSsurgoSlope, distToEdge: fbDistToEdge, actualSlope: fbActualSlope, demSlopeScore: fbDemSlopeScore, isFallback: true, zoneLabel: 'best', zoneMukey: primaryZone.mukey, zonePercMethod: 'fallback', zonePoly: fallbackZonePoly });
          console.log('[perc] fallback pin used — all viable/possible zones exhausted');
          onPercFallbackRef.current?.(true);
        } else if (fromExpandedSearch) {
          onPercFallbackRef.current?.(false);
        }

        // Build per-feature tooltip HTML stored as a property so click handler can retrieve it
        const percFeatures = allSelected.map(({ pt, inFlood, inWetland, slope, ptScore, distToEdge, actualSlope, isFallback, clearance: pinClearance, zoneLabel, zoneMukey, zonePercMethod }, i) => {
          const pinNumber = i + 1;
          const pinColor = '#FFFFFF';
          const rankLabels = ['Best Site', 'Alt Site 2', 'Alt Site 3'];
          const slopeStr = actualSlope !== null ? ` · ~${actualSlope.toFixed(0)}% slope` : '';
          const pinTitle = isFallback
            ? `Perc Site #${pinNumber} — Evaluation Required`
            : `${rankLabels[i] ?? `Alt Site ${pinNumber}`} · Score ${ptScore}${slopeStr}`;

          const rows: string[] = [];
          if (!isFallback) {
            rows.push(inFlood
              ? `<div style="color:#FCD34D;margin-bottom:3px;">&#9888; Within FEMA flood zone</div>`
              : `<div style="color:#86EFAC;margin-bottom:3px;">&#10003; Outside flood zone</div>`);
            rows.push(inWetland
              ? `<div style="color:#FCD34D;margin-bottom:3px;">&#9888; Within wetland area</div>`
              : `<div style="color:#86EFAC;margin-bottom:3px;">&#10003; Outside wetland area</div>`);
            if (!inFlood && !inWetland && distToEdge > 30) {
              rows.push(`<div style="color:#86EFAC;margin-bottom:3px;">&#10003; Interior location</div>`);
            } else if (distToEdge <= 30) {
              rows.push(`<div style="color:#FCD34D;margin-bottom:3px;">&#9888; Near parcel boundary</div>`);
            }
          }

          let note = '';
          if (isFallback) {
            note = 'No suitable location found — on-site evaluation required.';
          } else if (ptScore >= 80) {
            note = 'Start your perc test here. This location has the best combination of soil quality and site conditions.';
          } else if (!inFlood && !inWetland && distToEdge <= 30) {
            note = 'Good candidate — confirm setback requirements with the county before testing.';
          } else if (inFlood && !inWetland) {
            note = 'Soil may still perc but the county may require special engineering or deny the permit. Verify with Environmental Health before scheduling a test.';
          } else if (!inFlood && inWetland) {
            note = 'Wetland soils are typically saturated and unlikely to pass. Avoid this spot unless the boundary is verified to exclude this area on-site.';
          } else {
            note = 'This location is unlikely to be permitted. A licensed soil scientist should evaluate the full parcel before proceeding.';
          }

          const tooltipHtml = `<div style="background:rgba(10,15,25,0.95);border:1px solid rgba(255,255,255,0.1);border-radius:8px;padding:12px 16px;color:#fff;font-family:inherit;max-width:260px;"><div style="color:#f1f5f9;font-weight:700;font-size:13px;margin-bottom:8px;">${pinTitle}</div><div style="font-size:12px;line-height:1.6;">${rows.join('')}${note ? `<div style="color:rgba(255,255,255,0.65);margin-top:6px;font-size:11px;line-height:1.5;border-top:1px solid rgba(255,255,255,0.08);padding-top:6px;">${note}</div>` : ''}</div></div>`;

          console.log(`[perc] pin ${pinNumber} at`, pt.geometry.coordinates, 'score:', ptScore, 'flood:', inFlood, 'wetland:', inWetland, 'slope:', slope ?? 'unknown', 'edge dist:', Math.round(distToEdge) + 'm');
          console.log(`[perc-pin] rank: ${pinNumber} zone: ${zoneLabel} mukey: ${zoneMukey} method: ${isFallback ? 'fallback' : zonePercMethod} setback_m: ${SETBACK_M} clearance_floor: ${CLEARANCE_FLOOR_FRAC} clearance_m: ${pinClearance ?? 0} slope_pct: ${actualSlope !== null ? actualSlope.toFixed(1) : 'null'} coord: [${pt.geometry.coordinates[0].toFixed(6)},${pt.geometry.coordinates[1].toFixed(6)}]`);

          const iconId = isFallback ? 'perc-circle-fallback' : `perc-circle-${pinNumber}`;

          return turf.feature(pt.geometry as turf.Point, {
            rank: pinNumber,
            iconId,
            pinColor,
            tooltipHtml,
          });
        });

        // Capture perc pins for report generation — per-pin zone info
        const pins = allSelected.map(({ pt, ptScore, distToEdge, zonePoly: pinZonePoly }, i) => {
          const zoneProps = (pinZonePoly?.properties ?? {}) as Record<string, unknown>;
          const zoneName = (zoneProps?.muname ?? zoneProps?.MUNAME ?? 'Unknown Zone') as string;
          const zoneSeries = ((zoneProps?.musym ?? '') as string).replace(/[A-Z]$/, '');
          const zoneScore = (zoneProps?.suitabilityScore as number) ?? 0;
          return {
            rank: i + 1,
            lat: pt.geometry.coordinates[1].toFixed(4),
            lng: pt.geometry.coordinates[0].toFixed(4),
            zoneName,
            zoneSeries,
            zoneScore,
            edgeDist: `${Math.round(distToEdge)}m`,
            confidence: (ptScore >= 80 ? 'High' : ptScore >= 60 ? 'Medium' : 'Low') as 'High' | 'Medium' | 'Low',
          };
        });
        onPercPinsReadyRef.current?.(pins);

        // Perc pins as DOM Markers — stacks above the zone-badge DOM markers (z-index 10 vs 1).
        // Remove any legacy symbol layer left from a previous session (percMarkersRef already
        // cleared at the top of applyFullOverlay — do NOT clear again here).
        try { if (map.getLayer('perc-pins-layer')) map.removeLayer('perc-pins-layer'); } catch { /* ignore */ }
        try { if (map.getSource('perc-pins')) map.removeSource('perc-pins'); } catch { /* ignore */ }

        const drawPinCanvas = (num: number, fill: string, border: string): HTMLCanvasElement => {
          const size = 26, PAD = 4, canvasSize = size + PAD * 2;
          const canvas = document.createElement('canvas');
          canvas.width = canvasSize; canvas.height = canvasSize;
          const ctx = canvas.getContext('2d')!;
          const cx = canvasSize / 2, cy = canvasSize / 2, radius = size / 2 - 2;
          ctx.shadowColor = 'rgba(0,0,0,0.5)'; ctx.shadowBlur = 4; ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 2;
          ctx.beginPath(); ctx.arc(cx, cy, radius, 0, Math.PI * 2); ctx.fillStyle = fill; ctx.fill();
          ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
          ctx.beginPath(); ctx.arc(cx, cy, radius, 0, Math.PI * 2); ctx.strokeStyle = border; ctx.lineWidth = 2.5; ctx.stroke();
          ctx.fillStyle = border; ctx.font = `bold ${Math.round(size * 0.42)}px Arial,sans-serif`;
          ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(String(num), cx, cy + 0.5);
          return canvas;
        };

        try {
          percFeatures.forEach(feature => {
            const props = feature.properties as { rank: number; iconId: string; tooltipHtml: string };
            const [lng, lat] = (feature.geometry as turf.Point).coordinates as [number, number];
            const isFallbackPin = props.iconId === 'perc-circle-fallback';
            const fill = isFallbackPin ? '#9ca3af' : '#FFFFFF';
            const border = isFallbackPin ? '#374151' : '#1a1a2e';
            const pinCanvas = drawPinCanvas(props.rank, fill, border);

            const wrapper = document.createElement('div');
            wrapper.style.cssText = 'cursor:pointer;z-index:10;';
            wrapper.style.display = percVisible ? 'block' : 'none';
            wrapper.appendChild(pinCanvas);

            wrapper.addEventListener('click', () => {
              safeRemovePopup(soilPopupRef.current);
              soilPopupRef.current = new mapboxgl.Popup({ closeButton: true, closeOnClick: true, offset: [0, -20], maxWidth: '280px', className: 'soil-tooltip' })
                .setLngLat([lng, lat]).setHTML(props.tooltipHtml).addTo(map) as mapboxgl.Popup;
              setTimeout(() => { const btn = document.querySelector('.mapboxgl-popup-close-button'); if (btn) btn.removeAttribute('aria-hidden'); }, 0);
            });
            wrapper.addEventListener('mouseenter', () => { map.getCanvas().style.cursor = 'pointer'; });
            wrapper.addEventListener('mouseleave', () => { map.getCanvas().style.cursor = ''; });

            const marker = new mapboxgl.Marker({ element: wrapper, anchor: 'center' }).setLngLat([lng, lat]).addTo(map);
            percMarkersRef.current.push(marker);
          });
        } catch (markerErr) { console.warn('[perc] marker error:', (markerErr as Error).message); }

        // Nudge each zone badge away from any perc pin within BADGE_PIN_CLEAR_PX.
        // When badge and pin are at the same pixel (dist < 1), go straight to cardinal
        // directions. If no in-polygon position is found at any fraction, nudge to the
        // zone edge so the label is at least visually separated from the pin.
        for (const { marker: badgeMarker, poly: badgePoly } of zoneBadgeEntries) {
          if (percMarkersRef.current.length === 0) break;
          let { lng: bLng, lat: bLat } = badgeMarker.getLngLat();
          let nudged = false;
          for (const pinMarker of percMarkersRef.current) {
            const { lng: pLng, lat: pLat } = pinMarker.getLngLat();
            const bPx = map.project([bLng, bLat] as [number, number]);
            const pPx = map.project([pLng, pLat] as [number, number]);
            const dx = bPx.x - pPx.x;
            const dy = bPx.y - pPx.y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            console.log('[zones] nudge dist px:', dist.toFixed(2), '— threshold:', BADGE_PIN_CLEAR_PX);
            if (dist < BADGE_PIN_CLEAR_PX) {
              const maxClearDist = BADGE_PIN_CLEAR_PX + 6;
              const hasDirection = dist >= 1;
              const nx = hasDirection ? dx / dist : 0;
              const ny = hasDirection ? dy / dist : -1;
              // Pass 1: try in-polygon positions at progressively smaller clearances
              const distSteps = [maxClearDist, maxClearDist * 0.75, maxClearDist * 0.5, maxClearDist * 0.33];
              let placed = false;
              outer: for (const clearDist of distSteps) {
                const pxCandidates: [number, number][] = [
                  [pPx.x + nx * clearDist, pPx.y + ny * clearDist],
                  [pPx.x,                  pPx.y - clearDist],
                  [pPx.x,                  pPx.y + clearDist],
                  [pPx.x - clearDist,      pPx.y            ],
                  [pPx.x + clearDist,      pPx.y            ],
                ];
                for (const [cx, cy] of pxCandidates) {
                  try {
                    const cand = map.unproject([cx, cy] as [number, number]);
                    const candPt = turf.point([cand.lng, cand.lat]);
                    if (!badgePoly || turf.booleanPointInPolygon(candPt, badgePoly)) {
                      bLng = cand.lng; bLat = cand.lat; placed = true; nudged = true;
                      console.log('[zones] badge nudged (in-polygon) at', clearDist.toFixed(0), 'px');
                      break outer;
                    }
                  } catch { /* skip bad candidate */ }
                }
              }
              // Pass 2: zone too small — nudge to edge without polygon check
              if (!placed) {
                const fallbackDist = maxClearDist * 0.33;
                const pxCandidates: [number, number][] = [
                  [pPx.x + nx * fallbackDist, pPx.y + ny * fallbackDist],
                  [pPx.x,                     pPx.y - fallbackDist],
                  [pPx.x - fallbackDist,      pPx.y               ],
                  [pPx.x + fallbackDist,      pPx.y               ],
                ];
                for (const [cx, cy] of pxCandidates) {
                  try {
                    const cand = map.unproject([cx, cy] as [number, number]);
                    bLng = cand.lng; bLat = cand.lat; placed = true; nudged = true;
                    console.log('[zones] badge nudged (edge fallback) at', fallbackDist.toFixed(0), 'px');
                    break;
                  } catch { /* skip bad candidate */ }
                }
              }
              if (!placed) console.log('[zones] badge nudge: all candidates failed');
            }
          }
          if (nudged) badgeMarker.setLngLat([bLng, bLat]);
        }

        console.log(`[perc] ${allSelected.length} perc site pin(s) placed from ${totalCandidates} candidate points`);

        // Deactivate terrain if we enabled it only for elevation querying
        if (mapRef.current) cleanupDEM(mapRef.current, demWasActive);
      } catch (e) { console.warn('[perc] pin generation failed:', (e as Error).message); }
    }
  };

  // Init map
  useEffect(() => {
    if (!tokenReady || !containerRef.current || mapRef.current) return;
    if (typeof mapboxgl === 'undefined') { setMapError('Mapbox GL JS failed to load'); return; }

    mapboxgl.accessToken = tokenRef.current;
    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: 'mapbox://styles/mapbox/satellite-streets-v12',
      center: [lng ?? -79.5, lat ?? 35.5],
      zoom: 16,
      attributionControl: false,
      preserveDrawingBuffer: true,
    });
    map.addControl(new mapboxgl.AttributionControl({ compact: true }), 'bottom-right');
    map.addControl(new mapboxgl.NavigationControl({ showCompass: false }), 'top-right');
    mapRef.current = map;

    if (lat !== null && lng !== null) {
      const el = document.createElement('div');
      el.style.cssText = 'width:12px;height:12px;border-radius:50%;background:#EF4444;border:2px solid #fff;box-shadow:0 0 0 4px rgba(239,68,68,0.25);';
      markerRef.current = new mapboxgl.Marker({ element: el }).setLngLat([lng, lat]).addTo(map);
    }

    map.on('load', async () => {
      console.log('MAP READY — notifying pipeline');
      onMapReadyRef.current(map);

      // Load DEM source silently for queryTerrainElevation — no terrain rendering
      if (!map.getSource('mapbox-dem')) {
        map.addSource('mapbox-dem', {
          type: 'raster-dem',
          url: 'mapbox://mapbox.mapbox-terrain-dem-v1',
          tileSize: 512,
          maxzoom: 14,
        });
      }

      if (regridTokenRef.current) {
        map.addSource('regrid-parcels', { type: 'vector', tiles: [`https://tiles.regrid.com/api/v1/parcel/{z}/{x}/{y}.mvt?token=${regridTokenRef.current}`], minzoom: 12, maxzoom: 20 });
        map.addLayer({ id: 'regrid-parcel-lines', type: 'line', source: 'regrid-parcels', 'source-layer': 'parcels', minzoom: 12, paint: { 'line-color': '#FFFFFF', 'line-width': 1, 'line-opacity': 0.5 } });
      }

      if (parcelBoundary) {
        addOrUpdateBoundary(map, parcelBoundary, isBboxFallback);
        if (!isBboxFallback) { fitToBoundary(map, parcelBoundary); markerRef.current?.remove(); markerRef.current = null; }
        else map.easeTo({ zoom: zoomFromBbox(parcelBoundary), duration: 800 });
        if (soilResults.length > 0) {
          const key = `${JSON.stringify(parcelBoundary).slice(0, 80)}-${soilResults.length}`;
          if (lastOverlayKeyRef.current !== key) {
            lastOverlayKeyRef.current = key;
            soilRenderedRef.current = false;
            femaRenderedRef.current = false;
            nwiRenderedRef.current = false;
            bestZoneRef.current = null;
            soilResultsCountRef.current = 0;
            latestSoilResultsRef.current = soilResults;
            await applyFullOverlay(map, parcelBoundary, soilResults, soilVisible);
          }
        }
      }
    });

    return () => {
      zoneMarkersRef.current.forEach(m => m.remove());
      zoneMarkersRef.current = [];
      zoneBadgeMarkersRef.current = [];
      percMarkersRef.current.forEach(m => m.remove());
      percMarkersRef.current = [];
      noZoneBadgeRef.current?.remove();
      noZoneBadgeRef.current = null;
      markerRef.current?.remove();
      safeRemovePopup(soilPopupRef.current);
      soilClickRegisteredRef.current = false;
      map.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tokenReady]);

  // Apply tab bucket filter to soil layer colors
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;
    if (!map.getLayer('soil-fill')) return;

    const COLORS: Record<string, string> = { viable: '#22C55E', 'engineering-needed': '#F59E0B', 'not-suitable': '#EF4444', 'no-data': '#6B7280' };
    const DIM = '#374151';

    if (activeTab === 'parcel' || !activeTab) {
      map.setPaintProperty('soil-fill', 'fill-color',
        ['match', ['get', 'bucket'], 'viable', COLORS.viable, 'engineering-needed', COLORS['engineering-needed'], 'not-suitable', COLORS['not-suitable'], DIM]);
      map.setPaintProperty('soil-fill', 'fill-opacity', 0.55);
      map.setPaintProperty('soil-outline', 'line-color',
        ['match', ['get', 'bucket'], 'viable', COLORS.viable, 'engineering-needed', COLORS['engineering-needed'], 'not-suitable', COLORS['not-suitable'], DIM]);
      map.setPaintProperty('soil-outline', 'line-opacity', 0.6);
      zoneMarkersRef.current.forEach(m => {
        const el = m.getElement() as HTMLElement;
        if (!zoneLabelsVisibleRef.current) { el.style.opacity = '0'; return; }
        applyZoneMarkerTabFilter(el, 'parcel');
      });
    } else {
      const active = activeTab === 'not-suitable' ? 'not-suitable' : activeTab;
      map.setPaintProperty('soil-fill', 'fill-color',
        ['match', ['get', 'bucket'], active, COLORS[active] ?? DIM, DIM]);
      map.setPaintProperty('soil-fill', 'fill-opacity',
        ['match', ['get', 'bucket'], active, 0.65, 0.12]);
      map.setPaintProperty('soil-outline', 'line-color',
        ['match', ['get', 'bucket'], active, COLORS[active] ?? DIM, DIM]);
      map.setPaintProperty('soil-outline', 'line-opacity',
        ['match', ['get', 'bucket'], active, 0.75, 0.15]);
      zoneMarkersRef.current.forEach(m => {
        const el = m.getElement() as HTMLElement;
        if (!zoneLabelsVisibleRef.current) { el.style.opacity = '0'; return; }
        applyZoneMarkerTabFilter(el, active);
      });
    }
  }, [activeTab]);

  // React to boundary / soil results updates
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !parcelBoundary) return;
    const apply = async () => {
      addOrUpdateBoundary(map, parcelBoundary, isBboxFallback);
      if (!isBboxFallback) { fitToBoundary(map, parcelBoundary); markerRef.current?.remove(); markerRef.current = null; }
      else map.easeTo({ zoom: zoomFromBbox(parcelBoundary), duration: 800 });
      if (soilResults.length > 0) {
        const key = `${JSON.stringify(parcelBoundary).slice(0, 80)}-${soilResults.length}`;
        if (lastOverlayKeyRef.current !== key) {
          lastOverlayKeyRef.current = key;
          soilRenderedRef.current = false;
          femaRenderedRef.current = false;
          nwiRenderedRef.current = false;
          bestZoneRef.current = null;
          soilResultsCountRef.current = 0;
          latestSoilResultsRef.current = soilResults;
        }
        // Always register a retry handler pointing at the current boundary/results
        retrySoilLoadRef.current = () => {
          soilRenderedRef.current = false;
          lastOverlayKeyRef.current = '';
          setSdaError(false);
          applyFullOverlay(map, parcelBoundary, soilResults, soilVisible);
        };
        await applyFullOverlay(map, parcelBoundary, soilResults, soilVisible);
      }
    };
    map.isStyleLoaded() ? apply() : map.once('load', apply);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parcelBoundary, isBboxFallback, soilResults]);

  // Toggle soil overlay + zone badge visibility
  useEffect(() => {
    const map = mapRef.current;
    // Soil layer visibility needs an active style; marker DOM updates do not
    if (map?.isStyleLoaded()) {
      setSoilOverlayVisibility(map, soilVisible, overlayIdsRef.current);
    }
    zoneMarkersRef.current.forEach(m => {
      const el = m.getElement() as HTMLElement;
      if (!soilVisible || !zoneLabelsVisible) { el.style.opacity = '0'; return; }
      applyZoneMarkerTabFilter(el, activeTab ?? 'parcel');
    });
    if (noZoneBadgeRef.current) {
      (noZoneBadgeRef.current.getElement() as HTMLElement).style.opacity = soilVisible ? '1' : '0';
    }
  }, [soilVisible, zoneLabelsVisible, activeTab]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;
    const vis = floodVisible ? 'visible' : 'none';
    ['flood-fill', 'flood-outline'].forEach(id => {
      try { if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', vis); } catch { /* ignore */ }
    });
  }, [floodVisible]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;
    const vis = wetlandVisible ? 'visible' : 'none';
    ['wetland-fill', 'wetland-outline'].forEach(id => {
      try { if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', vis); } catch { /* ignore */ }
    });
  }, [wetlandVisible]);

  useEffect(() => {
    const display = percVisible ? 'block' : 'none';
    percMarkersRef.current.forEach(m => { const el = m.getElement(); if (el) el.style.display = display; });
  }, [percVisible]);

  const allReady = soilReady && femaReady && nwiReady;
  const [timedOut, setTimedOut] = useState(false);
  const [stillLoadingBanner, setStillLoadingBanner] = useState(false);

  // Cycle loading text while not ready
  useEffect(() => {
    if (allReady) return;
    const id = setInterval(() => setLoadingTextIdx(i => (i + 1) % 4), 1500);
    return () => clearInterval(id);
  }, [allReady]);

  // Safety timeout — complex parcels (500+ original coords) get 60s, others 45s.
  // On timeout, shows a non-blocking "still loading" banner rather than hard-dismissing the overlay,
  // so the user knows the map is still working on a large parcel.
  const allReadyRef = useRef(allReady);
  allReadyRef.current = allReady;
  useEffect(() => {
    const coordCount = (() => {
      if (!parcelBoundary) return 0;
      try {
        const geo = (parcelBoundary.type === 'Feature'
          ? (parcelBoundary as Record<string, unknown>).geometry
          : parcelBoundary) as { type: string; coordinates: unknown };
        if (geo?.type === 'Polygon') return ((geo.coordinates as number[][][])[0] ?? []).length;
        if (geo?.type === 'MultiPolygon') return ((geo.coordinates as number[][][][])[0]?.[0] ?? []).length;
      } catch { /* ignore */ }
      return 0;
    })();
    const loadingTimeout = coordCount > 500 ? 60_000 : 45_000;
    const id = setTimeout(() => {
      if (!allReadyRef.current) {
        console.warn('[loading] timeout reached — forcing overlay dismiss');
        setTimedOut(true);
        setStillLoadingBanner(true);
        setSoilReadyRef.current(true);
        setFemaReadyRef.current(true);
        setNwiReadyRef.current(true);
      }
    }, loadingTimeout);
    return () => clearTimeout(id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Returns a Promise that resolves to the composited map canvas after a fresh
  // flat north-up fitBounds capture. Safe to call any time after the map is ready.
  const triggerCapture = useCallback((): Promise<HTMLCanvasElement> => {
    return new Promise((resolve, reject) => {
      const map = mapRef.current;
      if (!map) { reject(new Error('map not ready')); return; }

      map.jumpTo({ pitch: 0, bearing: 0 });

      if (parcelBoundary) {
        try {
          const coords = extractCoords(parcelBoundary);
          if (coords.length) {
            const bounds = coords.reduce(
              (b, c) => b.extend(c as [number, number]),
              new mapboxgl.LngLatBounds(coords[0] as [number, number], coords[0] as [number, number])
            );
            map.fitBounds(bounds, { padding: 48, maxZoom: 18, duration: 0 });
          }
        } catch { /* ignore */ }
      }

      map.once('idle', () => {
        const mapCanvas = map.getCanvas();
        const out = document.createElement('canvas');
        out.width = mapCanvas.width;
        out.height = mapCanvas.height;
        const ctx = out.getContext('2d')!;
        ctx.drawImage(mapCanvas, 0, 0);

        // Pin styling: rank 1 dark fill + white text, rank 2 slate + white text, rank 3 light slate + dark text
        const PIN_FILLS = ['#0A0F1E', '#334155', '#94A3B8'];
        const PIN_TEXT_COLORS = ['#FFFFFF', '#FFFFFF', '#0A0F1E'];
        const PIN_RING = '#FFFFFF';
        const dpr = window.devicePixelRatio || 1;
        const pinRadius = 16 * dpr;
        const ringWidth = 3 * dpr;
        const fontSize = Math.round(13 * dpr);

        percMarkersRef.current.forEach((marker, idx) => {
          const lngLat = marker.getLngLat();
          const pt = map.project(lngLat);
          const px = pt.x * dpr;
          const py = pt.y * dpr;
          const fill = PIN_FILLS[idx] ?? '#0A0F1E';
          const textColor = PIN_TEXT_COLORS[idx] ?? '#FFFFFF';

          ctx.save();
          ctx.shadowColor = 'rgba(0,0,0,0.55)';
          ctx.shadowBlur = 6 * dpr;
          ctx.shadowOffsetY = 3 * dpr;
          ctx.beginPath();
          ctx.arc(px, py, pinRadius, 0, Math.PI * 2);
          ctx.fillStyle = fill;
          ctx.fill();
          ctx.shadowColor = 'transparent';
          ctx.shadowBlur = 0;
          ctx.shadowOffsetY = 0;
          ctx.beginPath();
          ctx.arc(px, py, pinRadius, 0, Math.PI * 2);
          ctx.lineWidth = ringWidth;
          ctx.strokeStyle = PIN_RING;
          ctx.stroke();
          ctx.fillStyle = textColor;
          ctx.font = `bold ${fontSize}px Arial,sans-serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(String(idx + 1), px, py + 0.5 * dpr);
          ctx.restore();
        });

        onCanvasReadyRef.current?.(out);
        resolve(out);
      });
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parcelBoundary]);

  // Expose triggerCapture via requestCaptureRef so the parent can call it on demand
  useEffect(() => {
    if (requestCaptureRef) requestCaptureRef.current = triggerCapture;
  }, [requestCaptureRef, triggerCapture]);

  // Trigger fade-out once all layers ready; also dismiss the still-loading banner
  useEffect(() => {
    if (!allReady) return;
    setStillLoadingBanner(false);
    setOverlayFading(true);
    onAllLayersReadyRef.current?.();

    // Small delay to ensure layers are painted before we refit + capture
    const captureTimer = setTimeout(() => { triggerCapture().catch(() => {}); }, 200);

    const id = setTimeout(() => {
      setOverlayGone(true);
      if (map && !initialCameraRef.current) {
        initialCameraRef.current = {
          zoom: map.getZoom(),
          center: map.getCenter(),
          bearing: map.getBearing(),
          pitch: map.getPitch(),
        };
      }
    }, timedOut ? 2420 : 420);
    return () => { clearTimeout(captureTimer); clearTimeout(id); };
  }, [allReady, timedOut, parcelBoundary]);

  if (mapError) {
    return (
      <div className="w-full h-full flex flex-col items-center justify-center bg-navy-800 gap-3">
        <MapPin className="w-8 h-8 text-white/20" />
        <p className="text-white/30 text-sm text-center px-6">{mapError}</p>
        <p className="text-white/15 text-xs text-center px-6">Set MAPBOX_TOKEN in your Supabase project secrets to enable the map</p>
      </div>
    );
  }

  function toggle3D() {
    const map = mapRef.current;
    if (!map || !overlayGone) return;
    try {
      if (!terrain3D) {
        if (!map.getSource('mapbox-dem')) {
          map.addSource('mapbox-dem', {
            type: 'raster-dem',
            url: 'mapbox://mapbox.mapbox-terrain-dem-v1',
            tileSize: 512,
            maxzoom: 14,
          });
        }
        map.setTerrain({ source: 'mapbox-dem', exaggeration: 1.5 });
        map.easeTo({ pitch: 60, bearing: -20, duration: 800 });
        if (!map.getLayer('sky')) {
          map.addLayer({
            id: 'sky',
            type: 'sky',
            paint: {
              'sky-type': 'atmosphere',
              'sky-atmosphere-sun': [0.0, 90.0],
              'sky-atmosphere-sun-intensity': 15,
            },
          } as mapboxgl.AnyLayer);
        }
        setTerrain3D(true);
      } else {
        map.setTerrain(null);
        if (map.getLayer('sky')) map.removeLayer('sky');
        const cam = initialCameraRef.current;
        map.easeTo({
          pitch: 0,
          bearing: 0,
          zoom: cam?.zoom ?? map.getZoom(),
          center: cam?.center ?? map.getCenter(),
          duration: 1200,
          easing: (t) => t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t,
        });
        setTerrain3D(false);
      }
    } catch (err) {
      console.warn('[3D terrain] toggle error:', err);
    }
  }

  return (
    <div className="relative w-full h-full">
      <style>{`
        @keyframes zone-pin-pulse {
          0%, 100% { box-shadow: 0 2px 10px rgba(0,0,0,0.55), 0 0 0 4px rgba(34,197,94,0.25); }
          50% { box-shadow: 0 2px 10px rgba(0,0,0,0.55), 0 0 0 8px rgba(34,197,94,0.1); }
        }
        @keyframes soil-loading-pulse { 0%, 100% { opacity: 0.7; } 50% { opacity: 1; } }
        @keyframes map-spinner { to { transform: rotate(360deg); } }
        @keyframes zone-score-in { 0% { opacity: 0; transform: translateY(4px) scale(0.85); } 100% { opacity: 1; transform: translateY(0) scale(1); } }
        .zone-marker { transition: opacity 300ms ease; }
        .soil-tooltip .mapboxgl-popup-content { background: transparent !important; padding: 0 !important; box-shadow: 0 4px 20px rgba(0,0,0,0.5) !important; border-radius: 8px !important; }
        .soil-tooltip .mapboxgl-popup-tip { display: none !important; }
        .mapboxgl-popup { pointer-events: none !important; }
        .mapboxgl-popup-content { pointer-events: auto !important; }
        .mapboxgl-popup-close-button { pointer-events: auto !important; }
      `}</style>
      <div ref={containerRef} className="w-full h-full" />

      {/* Loading overlay — hidden once all layers are ready */}
      {!overlayGone && (
        <div
          className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none"
          style={{
            background: 'rgba(10,15,25,0.88)',
            transition: 'opacity 420ms ease',
            opacity: overlayFading ? 0 : 1,
            zIndex: 10,
          }}
        >
          {/* Spinner */}
          <div style={{
            width: 44, height: 44, borderRadius: '50%',
            border: '3px solid rgba(34,197,94,0.15)',
            borderTopColor: '#22C55E',
            animation: 'map-spinner 0.85s linear infinite',
            marginBottom: 16,
          }} />
          <p style={{ color: timedOut ? '#F59E0B' : '#22C55E', fontSize: 13, fontWeight: 600, letterSpacing: '0.02em', maxWidth: 220, textAlign: 'center' }}>
            {timedOut
              ? 'Some data took too long to load. Showing available results.'
              : (['Fetching soil data...', 'Analyzing flood zones...', 'Calculating best zones...', 'Building your report...'] as const)[loadingTextIdx]}
          </p>
        </div>
      )}

      {/* Layer toggle panel — collapsed by default */}
      <div
        className="absolute top-3 right-12 shadow-xl select-none"
        style={{
          background: 'rgba(15,20,30,0.92)',
          backdropFilter: 'blur(10px)',
          border: '1px solid rgba(255,255,255,0.10)',
          borderRadius: '10px',
          minWidth: '168px',
          overflow: 'hidden',
        }}
      >
        {/* Header — always visible, click to toggle */}
        <button
          onClick={() => setLayersOpen(v => !v)}
          className="flex items-center justify-between w-full"
          style={{
            padding: '8px 12px',
            cursor: 'pointer',
            background: 'transparent',
            border: 'none',
            gap: 8,
          }}
        >
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
              gap: 2,
              width: 12,
              height: 12,
              flexShrink: 0,
            }}>
              {(['#22C55E','#818CF8','#38BDF8','#F59E0B'] as const).map((c, i) => (
                <span key={i} style={{ width: 5, height: 5, borderRadius: 1, background: c, opacity: 0.85 }} />
              ))}
            </span>
            <span style={{ color: 'rgba(255,255,255,0.70)', fontSize: '11px', fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
              Layers
            </span>
          </span>
          <span style={{
            color: 'rgba(255,255,255,0.40)',
            display: 'flex',
            alignItems: 'center',
            transform: layersOpen ? 'rotate(180deg)' : 'rotate(0deg)',
            transition: 'transform 280ms cubic-bezier(0.4,0,0.2,1)',
          }}>
            <ChevronDown size={13} />
          </span>
        </button>

        {/* Collapsible body */}
        <div style={{
          maxHeight: layersOpen ? '240px' : '0px',
          opacity: layersOpen ? 1 : 0,
          overflow: 'hidden',
          transition: 'max-height 300ms cubic-bezier(0.4,0,0.2,1), opacity 220ms ease',
        }}>
          <div style={{ padding: '2px 12px 10px' }}>
            <div style={{ height: 1, background: 'rgba(255,255,255,0.07)', marginBottom: 8 }} />
            {([
              { key: 'soil',    label: 'Soil Zones',       dot: <span style={{ width: 10, height: 10, borderRadius: 2, background: '#22C55E', display: 'inline-block', flexShrink: 0 }} />, on: soilVisible,    set: setSoilVisible },
              { key: 'flood',   label: 'FEMA Flood Zone',  dot: <span style={{ width: 10, height: 10, borderRadius: 2, background: '#818CF8', display: 'inline-block', flexShrink: 0 }} />, on: floodVisible,   set: setFloodVisible },
              { key: 'wetland', label: 'Wetland Areas',    dot: <span style={{ width: 10, height: 10, borderRadius: 2, background: '#38BDF8', display: 'inline-block', flexShrink: 0 }} />, on: wetlandVisible, set: setWetlandVisible },
              { key: 'perc', label: 'Perc Sites', dot: (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, flexShrink: 0 }}>
                  {[{ n: 1, s: 10 }, { n: 2, s: 8 }, { n: 3, s: 8 }].map(({ n, s }) => (
                    <span key={n} style={{ width: s, height: s, borderRadius: '50%', background: '#FFFFFF', border: '1.5px solid #1a1a2e', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
                      <span style={{ color: '#1a1a2e', fontSize: 5, fontWeight: 800, lineHeight: 1 }}>{n}</span>
                    </span>
                  ))}
                </span>
              ), on: percVisible, set: setPercVisible },
            ] as const).map(({ key, label, on, set, dot }) => (
              <div key={key} className="flex items-center gap-2 cursor-pointer" style={{ marginBottom: '7px' }} onClick={() => set(v => !v)}>
                <span style={{ opacity: on ? 1 : 0.3, transition: 'opacity 150ms' }}>{dot}</span>
                <span style={{ flex: 1, fontSize: '11px', color: on ? 'rgba(255,255,255,0.80)' : 'rgba(255,255,255,0.28)', transition: 'color 150ms', whiteSpace: 'nowrap' }}>{label}</span>
                <span style={{
                  width: 28, height: 16, borderRadius: 8, display: 'inline-flex', alignItems: 'center',
                  background: on ? '#22C55E' : '#374151',
                  padding: '2px', transition: 'background 200ms', flexShrink: 0,
                }}>
                  <span style={{
                    width: 12, height: 12, borderRadius: '50%', background: '#fff',
                    transform: on ? 'translateX(12px)' : 'translateX(0)',
                    transition: 'transform 200ms', display: 'block',
                  }} />
                </span>
              </div>
            ))}
            {/* Zone Labels toggle — uses handleZoneLabelsToggle for direct ref access */}
            <div className="flex items-center gap-2 cursor-pointer" onClick={() => handleZoneLabelsToggle(!zoneLabelsVisible)}>
              <span style={{ opacity: zoneLabelsVisible ? 1 : 0.3, transition: 'opacity 150ms', display: 'inline-flex', alignItems: 'center', gap: 3, flexShrink: 0 }}>
                {(['Best', '2nd', '3rd'] as const).map((t, idx) => {
                  const c = zoneBadgeColors[idx] ?? '#22C55E';
                  return (
                    <span key={idx} style={{ display: 'inline-flex', alignItems: 'center', gap: 2, background: 'rgba(15,23,41,0.85)', border: `1px solid ${c}`, borderRadius: 2, padding: '1px 3px' }}>
                      <span style={{ width: 4, height: 4, borderRadius: '50%', background: c }} />
                      <span style={{ color: '#fff', fontSize: 5, fontWeight: 700 }}>{t}</span>
                    </span>
                  );
                })}
              </span>
              <span style={{ flex: 1, fontSize: '11px', color: zoneLabelsVisible ? 'rgba(255,255,255,0.80)' : 'rgba(255,255,255,0.28)', transition: 'color 150ms', whiteSpace: 'nowrap' }}>Zone Labels</span>
              <span style={{
                width: 28, height: 16, borderRadius: 8, display: 'inline-flex', alignItems: 'center',
                background: zoneLabelsVisible ? '#22C55E' : '#374151',
                padding: '2px', transition: 'background 200ms', flexShrink: 0,
              }}>
                <span style={{
                  width: 12, height: 12, borderRadius: '50%', background: '#fff',
                  transform: zoneLabelsVisible ? 'translateX(12px)' : 'translateX(0)',
                  transition: 'transform 200ms', display: 'block',
                }} />
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Still-loading banner — shown after timeout fires on large/complex parcels */}
      {stillLoadingBanner && !allReady && (
        <div
          className="absolute flex items-center gap-2 px-3 py-2 rounded-lg shadow-lg select-none"
          style={{
            top: 48, left: '50%', transform: 'translateX(-50%)',
            background: 'rgba(10,18,30,0.92)', backdropFilter: 'blur(8px)',
            border: '1px solid rgba(255,255,255,0.10)',
            color: 'rgba(255,255,255,0.60)', fontSize: 12, fontWeight: 500,
            zIndex: 30, whiteSpace: 'nowrap',
          }}
        >
          <RefreshCw className="w-3.5 h-3.5 animate-spin" style={{ color: 'rgba(255,255,255,0.40)' }} />
          <span>Still analyzing large parcel — this may take a moment...</span>
        </div>
      )}

      {/* SDA timeout error banner */}
      {(sdaError || sdaRetrying) && (
        <div
          className="absolute flex items-center gap-2 px-3 py-2 rounded-lg shadow-lg select-none"
          style={{
            top: 48, left: '50%', transform: 'translateX(-50%)',
            background: 'rgba(20,12,4,0.92)', backdropFilter: 'blur(8px)',
            border: '1px solid rgba(255,159,9,0.40)',
            color: '#FF9F09', fontSize: 12, fontWeight: 500,
            zIndex: 30, whiteSpace: 'nowrap',
          }}
        >
          {sdaRetrying ? (
            <>
              <RefreshCw className="w-3.5 h-3.5 animate-spin" style={{ color: '#FF9F09' }} />
              <span>Retrying USDA soil query...</span>
            </>
          ) : (
            <>
              <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
              <span style={{ color: 'rgba(255,255,255,0.70)' }}>Soil data unavailable — USDA server timeout.</span>
              <button
                onClick={() => retrySoilLoadRef.current?.()}
                style={{
                  marginLeft: 4, padding: '2px 8px', borderRadius: 4,
                  background: 'rgba(255,159,9,0.18)', border: '1px solid rgba(255,159,9,0.45)',
                  color: '#FF9F09', fontSize: 11, fontWeight: 600, cursor: 'pointer',
                }}
              >
                Reload soil data
              </button>
            </>
          )}
        </div>
      )}

      {/* Soil data loading indicator */}
      {soilLoadingRef.current && (
        <div
          className="absolute top-3 left-3 flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium pointer-events-none select-none"
          style={{ background: 'rgba(10,16,28,0.82)', backdropFilter: 'blur(6px)', border: '1px solid rgba(255,255,255,0.12)', color: 'rgba(255,255,255,0.7)', animation: 'soil-loading-pulse 1.4s ease-in-out infinite' }}
        >
          <RefreshCw className="w-3 h-3 animate-spin" style={{ opacity: 0.7 }} />
          Analyzing soil data...
        </div>
      )}

      {isBboxFallback && parcelBoundary && (
        boundarySource === 'fcc-census-block' ? (
          <div className="absolute top-3 left-1/2 -translate-x-1/2 bg-amber-500/90 backdrop-blur-sm border border-amber-400/50 rounded-full px-3 py-1 pointer-events-none shadow-lg">
            <p className="text-[11px] text-amber-950 font-medium text-center whitespace-nowrap">
              &#9888; Approximate area — exact parcel boundary unavailable for this county
            </p>
          </div>
        ) : (
          <div className="absolute top-3 left-1/2 -translate-x-1/2 bg-black/60 backdrop-blur-sm border border-white/15 border-dashed rounded-full px-3 py-1 pointer-events-none">
            <p className="text-[11px] text-white/50 text-center whitespace-nowrap">
              Approximate boundary — parcel data unavailable for this county
            </p>
          </div>
        )
      )}

      {/* Reset view button — bottom-right, above 3D button */}
      {overlayGone && (
        <button
          onClick={() => {
            const map = mapRef.current;
            const cam = initialCameraRef.current;
            if (!map) return;
            map.easeTo({
              bearing: 0,
              pitch: 0,
              zoom: cam?.zoom ?? map.getZoom(),
              center: cam?.center ?? map.getCenter(),
              duration: 1000,
              easing: (t) => t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t,
            });
          }}
          title="Reset view"
          style={{
            position: 'absolute',
            bottom: 130,
            right: 10,
            width: 29,
            height: 29,
            borderRadius: 4,
            border: 'none',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'rgba(15,20,30,0.92)',
            color: 'rgba(255,255,255,0.85)',
            boxShadow: '0 1px 4px rgba(0,0,0,0.45)',
            zIndex: 5,
          }}
        >
          <Compass size={15} strokeWidth={2} />
        </button>
      )}

      {/* 3D terrain toggle — bottom-right, above zoom controls */}
      {overlayGone && (
        <button
          onClick={toggle3D}
          title={terrain3D ? 'Switch to 2D' : 'Switch to 3D terrain'}
          style={{
            position: 'absolute',
            bottom: 96,
            right: 10,
            width: 29,
            height: 29,
            borderRadius: 4,
            border: 'none',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontFamily: 'inherit',
            fontSize: 12,
            fontWeight: 700,
            letterSpacing: '0.02em',
            background: terrain3D ? '#22C55E' : 'rgba(15,20,30,0.92)',
            color: terrain3D ? '#000' : 'rgba(255,255,255,0.85)',
            boxShadow: '0 1px 4px rgba(0,0,0,0.45)',
            transition: 'background 200ms ease, color 200ms ease',
            zIndex: 5,
          }}
        >
          {terrain3D ? '2D' : '3D'}
        </button>
      )}

      {/* Soil rating legend — compact, bottom-left */}
      <div className="absolute bottom-8 left-3 pointer-events-none" style={{ background: 'rgba(15,20,30,0.80)', backdropFilter: 'blur(6px)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '7px', padding: '7px 10px' }}>
        <p style={{ color: 'rgba(255,255,255,0.3)', fontSize: '9px', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: '5px' }}>Soil Rating</p>
        {([
          { color: '#22C55E', label: 'Viable' },
          { color: '#F59E0B', label: 'Engineering needed' },
          { color: '#EF4444', label: 'Not suitable' },
          { color: '#6B7280', label: 'No data' },
        ] as const).map(({ color, label }) => (
          <div key={label} className="flex items-center gap-1.5" style={{ marginBottom: 3 }}>
            <div style={{ width: 9, height: 9, borderRadius: 2, background: color, opacity: 0.85, flexShrink: 0 }} />
            <span style={{ fontSize: '10px', color: 'rgba(255,255,255,0.45)' }}>{label}</span>
          </div>
        ))}
        {wfsFallbackRef.current && soilResults.length > 0 && (
          <p style={{ fontSize: '9px', color: 'rgba(255,255,255,0.2)', marginTop: 4 }}>* Locations approximate</p>
        )}
      </div>
    </div>
  );
}

// ─── Collapsible section wrapper ─────────────────────────────────────────────

function CollapsibleSection({
  title, defaultOpen = false, children,
}: { title: string; defaultOpen?: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded-xl border border-white/8 overflow-hidden">
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center justify-between px-4 py-3 bg-white/3 hover:bg-white/5 transition-colors"
      >
        <span className="text-xs font-semibold text-white/60 uppercase tracking-wider">{title}</span>
        {open ? <ChevronUp className="w-4 h-4 text-white/30" /> : <ChevronDown className="w-4 h-4 text-white/30" />}
      </button>
      {open && <div>{children}</div>}
    </div>
  );
}

// ─── Main component ──────────────────────────────────────────────────────────

export default function ReportDetail({ reportId, onBack, isPublic = false }: ReportDetailProps) {
  const [report, setReport] = useState<Report | null>(null);
  const [soilResults, setSoilResults] = useState<SoilResult[]>([]);
  const [countyRule, setCountyRule] = useState<CountyRule | null>(null);
  const [loading, setLoading] = useState(true);
  const [scoreResult, setScoreResult] = useState<ScoreResult | null>(null);
  const [reanalysing, setReanalysing] = useState(false);

  const [pipeline, setPipeline] = useState<PipelineState>({
    step1: 'pending', step2: 'pending', step3: 'pending', error: '',
  });

  const [activeBoundary, setActiveBoundary] = useState<Record<string, unknown> | null>(null);
  const [isBboxFallback, setIsBboxFallback] = useState(false);
  const [boundarySource, setBoundarySource] = useState<string | null>(null);

  // Stable prop references for MapPanel — new object/array identity only when actual content
  // changes, not on every parent re-render. Prevents applyFullOverlay from firing redundantly
  // when downstream state setters (setZoneBadgeColors etc.) cause a parent re-render.
  const stableParcelBoundary = useMemo(
    () => activeBoundary,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [report?.id, boundarySource, isBboxFallback],
  );
  const stableSoilResults = useMemo(
    () => soilResults,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [report?.id, soilResults.length],
  );
  const [envCoverage, setEnvCoverage] = useState<EnvironmentalCoverage | null>(null);
  const [bestZoneInFloodWarning, setBestZoneInFloodWarning] = useState(false);
  const [percFallbackWarning, setPercFallbackWarning] = useState<'exhausted' | 'expanded' | null>(null);
  const [hudHover, setHudHover] = useState<SoilHoverData | null>(null);
  const [hudLocked, setHudLocked] = useState<SoilHoverData | null>(null);
  type ZoneTab = 'viable' | 'engineering-needed' | 'not-suitable' | 'parcel';
  const [activeTab, setActiveTab] = useState<ZoneTab>('parcel');
  const handleCoverageUpdate = useCallback((coverage: EnvironmentalCoverage) => {
    setEnvCoverage(coverage);
    if (reportId) {
      supabase.from('reports').update({
        fema_feature_count: coverage.femaFeatureCount,
        nwi_feature_count: coverage.nwiFeatureCount,
      }).eq('id', reportId).then(({ error }) => {
        if (error) console.warn('[pipeline] failed to write overlay cache fields:', error.message);
        else console.log('[pipeline] wrote overlay cache fields — fema:', coverage.femaFeatureCount, 'nwi:', coverage.nwiFeatureCount);
      });
    }
  }, [reportId]);
  const [mapSoilPolygons, setMapSoilPolygons] = useState<SoilPolygon[]>([]);
  const [mapLayersReady, setMapLayersReady] = useState(false);
  const [isGeneratingPdf, setIsGeneratingPdf] = useState(false);
  const [shareCopied, setShareCopied] = useState(false);
  const scoreWrittenRef = useRef(false);

  const mapRef = useRef<mapboxgl.Map | null>(null);
  const mapCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const mapboxTokenRef = useRef<string>('');
  const mapSnapshotRef = useRef<string | null>(null);
  const percPinsRef = useRef<PercPinData[]>([]);
  const [demSlopeByMukey, setDemSlopeByMukey] = useState<Record<string, number | null>>({});
  const demSlopeByMukeyRef = useRef<Record<string, number | null>>({});
  demSlopeByMukeyRef.current = demSlopeByMukey;
  const pipelineRanRef = useRef<string | null>(null);
  const boundaryFetchedRef = useRef(false);
  const isFetchingBoundaryRef = useRef(false);
  const parcelComplexRef = useRef(false);
  const requestCaptureRef = useRef<(() => Promise<HTMLCanvasElement>) | null>(null);
  // Tracks the in-flight storage upload so handleDownloadReport can await it.
  const snapshotUploadRef = useRef<Promise<string | null>>(Promise.resolve(null));
  const mapSnapshotUrlRef = useRef<string | null>(null);

  const loadReport = useCallback(async () => {
    const [{ data: rep }, { data: soil }] = await Promise.all([
      supabase.from('reports').select('*, parcels(*)').eq('id', reportId).maybeSingle(),
      supabase.from('soil_results').select('*').eq('report_id', reportId).order('pct_coverage', { ascending: false }),
    ]);
    const r = rep as Report | null;
    setReport(r);
    // Seed the URL ref from the stored value so buildReportData can use it immediately.
    if (r?.map_snapshot_url) mapSnapshotUrlRef.current = r.map_snapshot_url;
    setSoilResults((soil as SoilResult[]) ?? []);
    if (r?.parcels?.state && r.parcels.county) {
      const { data: rule } = await supabase.from('county_rules').select('*')
        .eq('state', r.parcels.state).eq('county', r.parcels.county).maybeSingle();
      setCountyRule(rule as CountyRule | null);
    }
    return r;
  }, [reportId]);

  useEffect(() => {
    loadReport().finally(() => setLoading(false));
  }, [loadReport]);

  // Write best_zone_score and parcel_score back to the DB once the map layers are
  // ready and we have scored polygons — so the dashboard reflects the same values.
  useEffect(() => {
    if (!mapLayersReady || mapSoilPolygons.length === 0 || scoreWrittenRef.current) return;

    // Mirror computeBestZones candidate filter exactly: viable/engineering-needed, area >= 300 sqm
    const MIN_ZONE_AREA_SQM = 300;
    let best = 0;
    for (const poly of mapSoilPolygons) {
      if (poly.bucket !== 'viable' && poly.bucket !== 'engineering-needed') continue;
      try { if (turf.area(poly.geojson) < MIN_ZONE_AREA_SQM) continue; } catch { continue; }
      const s = (poly.geojson.properties as Record<string, unknown>)?.suitabilityScore as number ?? 0;
      if (s > best) best = s;
    }
    if (best === 0) return;

    const BUCKET_SCORE: Record<string, number> = { viable: 80, possible: 45, 'not-suitable': 10, 'no-data': 30 };
    let weightedSum = 0;
    let totalArea = 0;
    for (const poly of mapSoilPolygons) {
      try {
        const area = turf.area(poly.geojson);
        const score = (poly.geojson.properties as Record<string, unknown>)?.suitabilityScore as number
          ?? BUCKET_SCORE[poly.bucket] ?? 30;
        weightedSum += score * area;
        totalArea += area;
      } catch { /* skip degenerate */ }
    }
    const baseParcelScore = totalArea > 0 ? weightedSum / totalArea : best;
    const floodFrac = (envCoverage?.floodPct ?? 0) / 100;
    const wetlandFrac = (envCoverage?.nwiPct ?? 0) / 100;
    const computedParcelScore = Math.round(Math.min(100, Math.max(0,
      baseParcelScore * (1 - floodFrac * 0.75) * (1 - wetlandFrac * 0.85)
    )));

    scoreWrittenRef.current = true;
    supabase.from('reports').update({
      best_zone_score: best,
      parcel_score: computedParcelScore,
    }).eq('id', reportId).then(({ error }) => {
      if (error) console.warn('[scores] failed to write back zone/parcel scores:', error.message);
      else console.log('[scores] wrote back best_zone_score:', best, 'parcel_score:', computedParcelScore);
    });
  }, [mapLayersReady, mapSoilPolygons, envCoverage, reportId]);

  const runPipeline = useCallback(async (r: Report) => {
    if (pipelineRanRef.current === r.id) {
      console.log('[pipeline] already running for this report — skipping');
      return;
    }
    pipelineRanRef.current = r.id;

    const parcel = r.parcels;
    if (!parcel) {
      setPipeline(p => ({ ...p, step1: 'error', error: 'No parcel data found for this report.' }));
      return;
    }

    const address = parcel.address ?? parcel.apn ?? '';
    const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string;
    const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

    // ── STEP 1a: Mapbox + Regrid tokens ─────────────────────────────────────
    console.log('[pipeline] fetching config tokens');
    let mapboxToken: string;
    let regridToken: string | null = null;
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const cfgResp = await withTimeout(
        fetch(`${supabaseUrl}/functions/v1/get-config`, {
          headers: { Authorization: `Bearer ${session?.access_token ?? anonKey}` },
        }),
        8_000, 'get-config'
      );
      const cfg = await cfgResp.json() as { mapboxToken?: string | null; regridToken?: string | null };
      if (!cfg.mapboxToken) throw new Error('Mapbox token missing from project secrets');
      mapboxToken = cfg.mapboxToken;
      regridToken = cfg.regridToken ?? null;
      console.log('[pipeline] regridToken present:', !!regridToken, 'prefix:', regridToken?.slice(0, 15));
    } catch (e) {
      setPipeline(p => ({ ...p, step1: 'error', error: `Could not load Mapbox token: ${(e as Error).message}` }));
      return;
    }

    // ── STEP 1b: Geocode ─────────────────────────────────────────────────────
    setPipeline(p => ({ ...p, step1: 'running' }));
    let lat: number, lng: number;

    if (parcel.lat != null && parcel.lng != null) {
      lat = parcel.lat; lng = parcel.lng;
      console.log('[pipeline] using stored coords:', lat, lng);
    } else {
      try {
        if (!address || address.trim() === '') {
          setPipeline(p => ({ ...p, step1: 'error', error: 'Please enter an address' }));
          return;
        }
        console.log('[geocode] address value:', address);
        const geoUrl = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(address)}.json?country=US&access_token=${mapboxToken}`;
        const geoResp = await withTimeout(fetch(geoUrl), 10_000, 'Mapbox geocoding');
        const geoJson = await geoResp.json() as {
          features?: Array<{
            center: [number, number];
            place_type?: string[];
            properties?: { category?: string };
            text?: string;
          }>;
        };
        console.log('GEOCODE RESULT:', geoJson);
        if (!geoJson.features?.length) throw new Error('No results for this address');
        const geoFeature = geoJson.features[0];
        [lng, lat] = geoFeature.center;
        console.log('[pipeline] geocoded to:', lat, lng);

        // Water body check — warn if place_type is POI with water-related category
        const placeTypes = geoFeature.place_type ?? [];
        const category = geoFeature.properties?.category ?? '';
        const featureText = (geoFeature.text ?? '').toLowerCase();
        const waterKeywords = ['lake', 'river', 'creek', 'pond', 'reservoir', 'ocean', 'bay', 'sound', 'swamp', 'wetland', 'stream'];
        const isWaterPoi = placeTypes.includes('poi') && (
          waterKeywords.some(k => category.toLowerCase().includes(k)) ||
          waterKeywords.some(k => featureText.includes(k))
        );
        if (isWaterPoi) {
          console.warn('[pipeline] geocode suggests water body:', geoFeature.text, category);
          setPipeline(p => ({
            ...p,
            error: 'This address appears to be near or within a water body. Please verify the address is a valid land parcel.',
          }));
        }
      } catch (e) {
        setPipeline(p => ({ ...p, step1: 'error', error: `Could not geocode address: ${(e as Error).message}` }));
        return;
      }
    }

    // Fly map immediately
    if (mapRef.current) {
      mapRef.current.flyTo({ center: [lng, lat], zoom: 16, duration: 1200 });
    }

    // ── STEP 1c: Parcel boundary ─────────────────────────────────────────────
    const storedGeo = parcel.boundary_geojson;
    const storedSource = parcel.boundary_source ?? null;
    const storedType = storedGeo?.type === 'Feature'
      ? (storedGeo.geometry as Record<string, unknown>)?.type
      : storedGeo?.type;
    const storedIsPolygon = storedType === 'Polygon' || storedType === 'MultiPolygon';

    let boundary: Record<string, unknown>;
    let usedFallback = false;

    // Count stored boundary coords — v2-sourced boundaries may have few points (low-res generalization).
    // If too low, force a fresh v1 fetch to get full-precision geometry.
    const storedCoordCount = (() => {
      if (!storedGeo) return 0;
      const geo = storedGeo.type === 'Feature'
        ? (storedGeo.geometry as Record<string, unknown>)
        : storedGeo;
      if (!geo) return 0;
      try {
        if (geo.type === 'Polygon') return ((geo.coordinates as number[][][])[0] ?? []).length;
        if (geo.type === 'MultiPolygon') return ((geo.coordinates as number[][][][])[0]?.[0] ?? []).length;
      } catch { /* ignore */ }
      return 0;
    })();
    parcelComplexRef.current = storedCoordCount > 200;

    if (storedIsPolygon && storedSource === 'regrid') {
      // Trust any stored Regrid boundary — it was previously fetched and persisted
      boundary = storedGeo!;
      setBoundarySource(storedSource);
      console.log('[pipeline] using stored Regrid boundary — coords:', storedCoordCount, '— skipping fetch');
    } else {
      // Any other source (fcc-census-block, point-fallback, null) — fetch fresh from Regrid
      if (isFetchingBoundaryRef.current) {
        console.log('[boundary] already fetching, skipping');
        boundary = storedGeo ?? {
          type: 'Polygon',
          coordinates: [[[lng - 0.002, lat - 0.002],[lng + 0.002, lat - 0.002],[lng + 0.002, lat + 0.002],[lng - 0.002, lat + 0.002],[lng - 0.002, lat - 0.002]]],
        };
        usedFallback = !storedIsPolygon;
      } else {
        isFetchingBoundaryRef.current = true;
        boundaryFetchedRef.current = true;
        console.log('[pipeline] stored boundary source:', storedSource, '— fetching fresh from Regrid');

        try {
          const { data: { session } } = await supabase.auth.getSession();
          const token = session?.access_token ?? anonKey;
          const boundaryResp = await fetchParcelBoundary(lat, lng, parcel.county ?? null, parcel.state ?? null, token, regridToken);
          boundary = boundaryResp.geometry;
          usedFallback = boundaryResp.isApproximate;
          setBoundarySource(boundaryResp.source);
          console.log('[pipeline] boundary source:', boundaryResp.source, 'approximate:', usedFallback);

          // Persist geometry + enriched metadata + source back to parcel
          const parcelUpdate: Record<string, unknown> = {
            boundary_geojson: boundary,
            boundary_source: boundaryResp.source,
            lat, lng,
          };
          if (boundaryResp.apn) parcelUpdate.apn = boundaryResp.apn;
          if (boundaryResp.acreage != null) parcelUpdate.acreage = boundaryResp.acreage;
          if (boundaryResp.owner) parcelUpdate.owner = boundaryResp.owner;
          supabase.from('parcels').update(parcelUpdate).eq('id', parcel.id)
            .then(() => console.log('[pipeline] saved boundary + metadata to parcel, source:', boundaryResp.source));

          // Record boundary coverage on the county_rules row for this county
          if (parcel.county && parcel.state) {
            const hasRealBoundary = !boundaryResp.isApproximate;
            supabase.from('county_rules')
              .update({ has_parcel_boundary: hasRealBoundary })
              .eq('state', parcel.state.toUpperCase())
              .eq('county', parcel.county)
              .then(() => console.log('[pipeline] updated county boundary coverage:', parcel.county, hasRealBoundary));
          }
        } catch (e) {
          console.warn('[pipeline] boundary edge function failed:', (e as Error).message, '— using tiny bbox');
          const d = 0.002;
          boundary = {
            type: 'Polygon',
            coordinates: [[[lng - d, lat - d],[lng + d, lat - d],[lng + d, lat + d],[lng - d, lat + d],[lng - d, lat - d]]],
          };
          usedFallback = true;
        } finally {
          isFetchingBoundaryRef.current = false;
        }
      }
    }

    setIsBboxFallback(usedFallback);
    setActiveBoundary(boundary);

    if (mapRef.current?.isStyleLoaded()) {
      addOrUpdateBoundary(mapRef.current, boundary, usedFallback);
      if (!usedFallback) {
        fitToBoundary(mapRef.current, boundary);
      } else {
        const zoom = zoomFromBbox(boundary);
        console.log('[pipeline] fallback bbox zoom:', zoom);
        mapRef.current.easeTo({ zoom, duration: 800 });
      }
    }

    if (!parcel.lat) {
      await supabase.from('parcels').update({ lat, lng }).eq('id', parcel.id);
    }

    setPipeline(p => ({ ...p, step1: 'done' }));
    console.log('[pipeline] step 1 complete');

    // ── STEP 2: SSURGO ───────────────────────────────────────────────────────
    setPipeline(p => ({ ...p, step2: 'running' }));

    // For MultiPolygon parcels use the full bbox WKT — it covers all sub-polygons in one
    // query and client-side clipping filters results to the actual boundary afterward.
    // For single Polygon parcels use the thinned polygon WKT as before.
    let polygonWkt: string;
    let bboxWkt: string;
    try {
      const geo = (boundary?.type === 'Feature' ? (boundary.geometry as Record<string,unknown>) : boundary) as { type?: string; coordinates?: unknown };
      bboxWkt = buildBboxWkt(boundary);
      if (geo?.type === 'MultiPolygon') {
        polygonWkt = bboxWkt;
        console.log('[ssurgo] MultiPolygon — using full bbox for soil query to capture all sub-polygon mukeys');
      } else {
        polygonWkt = thinWkt(geojsonToWkt(boundary));
      }
      console.log('[ssurgo] polygon WKT length:', polygonWkt.length, 'bbox WKT:', bboxWkt);
    } catch (e) {
      setPipeline(p => ({ ...p, step2: 'error', error: `Geometry conversion failed: ${(e as Error).message}` }));
      return;
    }

    const callSoilQuery = async (wkt: string): Promise<boolean> => {
      const { data: { session } } = await supabase.auth.getSession();
      const hdrs = { Authorization: `Bearer ${session?.access_token ?? anonKey}`, 'Content-Type': 'application/json' };
      const soilResp = await withTimeout(
        fetch(`${supabaseUrl}/functions/v1/soil-query`, {
          method: 'POST', headers: hdrs,
          body: JSON.stringify({ report_id: reportId, geometry: boundary, wkt_override: wkt }),
        }),
        60_000, 'soil-query'
      );
      const soilText = await soilResp.text();
      console.log('[pipeline] soil-query response:', soilResp.status, soilText.slice(0, 400));
      if (!soilResp.ok) {
        const soilErr = JSON.parse(soilText) as { error?: string };
        throw new Error(soilErr.error ?? `soil-query HTTP ${soilResp.status}`);
      }
      return true;
    };

    try {
      let soilOk = false;
      try {
        soilOk = await callSoilQuery(polygonWkt);
      } catch (e) {
        console.warn('[ssurgo] polygon WKT query failed:', (e as Error).message, '— retrying with bbox');
        console.log('[ssurgo] bbox WKT:', bboxWkt);
        soilOk = await callSoilQuery(bboxWkt);
        console.log('[ssurgo] bbox fallback succeeded — clipping will filter results to parcel boundary');
      }
      if (soilOk) {
        const { data: soilRows } = await supabase.from('soil_results').select('*')
          .eq('report_id', reportId).order('pct_coverage', { ascending: false });
        setSoilResults((soilRows as SoilResult[]) ?? []);
        console.log('[pipeline] soil results loaded:', (soilRows ?? []).length, 'units');
        setPipeline(p => ({ ...p, step2: 'done' }));
      }
    } catch (e) {
      console.error('[pipeline] soil query failed:', e);
      setPipeline(p => ({ ...p, step2: 'skipped', error: `Soil query failed: ${(e as Error).message}. Scores will be limited.` }));
    }

    // ── STEP 3: Scores ───────────────────────────────────────────────────────
    setPipeline(p => ({ ...p, step3: 'running', error: '' }));

    try {
      const { data: { session } } = await supabase.auth.getSession();
      const hdrs = { Authorization: `Bearer ${session?.access_token ?? anonKey}`, 'Content-Type': 'application/json' };
      const scoreResp = await withTimeout(
        fetch(`${supabaseUrl}/functions/v1/calculate-score`, {
          method: 'POST', headers: hdrs,
          body: JSON.stringify({ report_id: reportId, demSlopeByMukey: demSlopeByMukeyRef.current }),
        }),
        30_000, 'calculate-score'
      );
      const scoreText = await scoreResp.text();
      console.log('[pipeline] calculate-score response:', scoreResp.status, scoreText.slice(0, 400));
      if (!scoreResp.ok) {
        const scoreErr = JSON.parse(scoreText) as { error?: string };
        throw new Error(scoreErr.error ?? `calculate-score HTTP ${scoreResp.status}`);
      }
      const scoreJson = JSON.parse(scoreText) as ScoreResult;
      setScoreResult(scoreJson);
      setPipeline(p => ({ ...p, step3: 'done' }));
      console.log('[pipeline] scores:', scoreJson.conventional_score, '/', scoreJson.alternative_score);
      await loadReport();
    } catch (e) {
      console.error('[pipeline] scoring failed:', e);
      setPipeline(p => ({ ...p, step3: 'error', error: `Scoring failed: ${(e as Error).message}` }));
    }
  }, [reportId, loadReport]);

  // Reset map layers ready flag whenever the report (parcel) changes
  useEffect(() => {
    setMapLayersReady(false);
    console.log('[pipeline] reset mapLayersReady for report:', reportId);
  }, [reportId]);

  useEffect(() => {
    if (!report) return;
    // Guard: only act once per report ID regardless of how many times state updates cause re-fires
    if (pipelineRanRef.current === report.id) return;
    if (report.status === 'complete' && report.conventional_score !== null) {
      // Cache is valid if we have overlay data (either the new overlay_geojson or legacy fema/nwi counts)
      const hasOverlayCache = report.overlay_geojson != null ||
        (report.fema_feature_count != null && report.nwi_feature_count != null);
      if (!hasOverlayCache) {
        console.log('[pipeline] cache stale — no overlay data, running full pipeline');
        runPipeline(report);
        return;
      }
      console.log('[pipeline] cache valid — loading boundary from DB, skipping pipeline');
      pipelineRanRef.current = report.id;
      setPipeline({ step1: 'done', step2: 'done', step3: 'done', error: '' });
      const stored = report.parcels?.boundary_geojson;
      const src = report.parcels?.boundary_source ?? null;
      if (stored) {
        const t = stored.type === 'Feature' ? (stored.geometry as Record<string, unknown>)?.type : stored.type;
        const isReal = t === 'Polygon' || t === 'MultiPolygon';
        setActiveBoundary(stored);
        setIsBboxFallback(!isReal);
        setBoundarySource(src);
      }
    } else {
      runPipeline(report);
    }
  }, [report, runPipeline]);

  async function handleReanalyse() {
    pipelineRanRef.current = null;
    boundaryFetchedRef.current = false;
    isFetchingBoundaryRef.current = false;
    setScoreResult(null);
    setReanalysing(true);
    setPipeline({ step1: 'pending', step2: 'pending', step3: 'pending', error: '' });
    // Clear cached scores so the pipeline condition doesn't skip to cache path.
    await supabase.from('reports').update({
      conventional_score: null,
      alternative_score: null,
      status: 'pending',
    }).eq('id', reportId);
    const r = await loadReport();
    setReanalysing(false);
    if (r) runPipeline(r);
  }

  // ── Derived scores — must be before any early returns to satisfy Rules of Hooks ──
  const { zoneScore, parcelScore } = useMemo(() => {
    const convScore = report?.conventional_score ?? scoreResult?.conventional_score ?? null;
    if (convScore === null) return { zoneScore: null, parcelScore: null };

    // Best zone score: highest finalScore among viable/engineering-needed polygons only,
    // applying the same MIN_ZONE_AREA_SQM filter that computeBestZones uses so the
    // displayed score matches the zone actually selected as Primary.
    const MIN_ZONE_AREA_SQM = 300;
    let zoneScore: number | null = null;
    if (mapSoilPolygons.length > 0) {
      let best = 0;
      for (const poly of mapSoilPolygons) {
        if (poly.bucket !== 'viable' && poly.bucket !== 'engineering-needed') continue;
        try { if (turf.area(poly.geojson) < MIN_ZONE_AREA_SQM) continue; } catch { continue; }
        const s = (poly.geojson.properties as Record<string, unknown>)?.suitabilityScore as number ?? 0;
        if (s > best) best = s;
      }
      zoneScore = best > 0 ? best : null;
    }

    // Parcel score: area-weighted average of suitabilityScore stored on polygon properties
    const BUCKET_SCORE: Record<SoilBucket, number> = { 'viable': 80, 'engineering-needed': 45, 'not-suitable': 10, 'no-data': 30 };
    let weightedSum = 0;
    let totalArea = 0;
    for (const poly of mapSoilPolygons) {
      try {
        const area = turf.area(poly.geojson);
        const score = (poly.geojson.properties as Record<string, unknown>)?.suitabilityScore as number
          ?? poly.result?.conventional_score
          ?? BUCKET_SCORE[poly.bucket];
        weightedSum += score * area;
        totalArea += area;
      } catch { /* skip degenerate polygons */ }
    }
    const baseParcelScore = totalArea > 0 ? weightedSum / totalArea : convScore;

    // Each polygon's finalScore already has flood/wetland gates baked in via
    // scoreSoilPolygon — no additional penalty is applied here.
    const parcelScore = Math.round(Math.min(100, Math.max(0, baseParcelScore)));

    // Invariant: Best Zone score = max(final_SI); Parcel Overall = area-weighted mean.
    // max >= mean always — only check when a zone was actually placed (zoneScore non-null).
    if (zoneScore !== null && parcelScore !== null) {
      if (zoneScore < parcelScore) {
        console.warn('[score] INVARIANT VIOLATED: Best Zone', zoneScore, '< Parcel Overall', parcelScore);
      } else {
        console.log('[score] Best Zone:', zoneScore, '>= Parcel Overall:', parcelScore, '✓');
      }
    } else {
      console.log('[score] Best Zone: none placed — skipping invariant check. Parcel Overall:', parcelScore);
    }
    console.log('[score] parcel weighted base:', baseParcelScore.toFixed(1), 'final parcel score:', parcelScore);

    return { zoneScore, parcelScore };
  }, [report, scoreResult, mapSoilPolygons, envCoverage]);

  // ── Upload composited canvas to Supabase Storage and persist URL ──
  // Returns the public URL, or null on failure. Designed to be called from onCanvasReady
  // so uploads happen automatically on every fresh capture (initial load + re-runs).
  const uploadSnapshot = useCallback((canvas: HTMLCanvasElement): Promise<string | null> => {
    return new Promise((resolve) => {
      canvas.toBlob(async (blob) => {
        if (!blob) { resolve(null); return; }
        const path = `${reportId}.jpg`;
        const { error: uploadError } = await supabase.storage
          .from('report-maps')
          .upload(path, blob, { contentType: 'image/jpeg', upsert: true });
        if (uploadError) {
          console.warn('[map] snapshot upload failed:', uploadError.message);
          resolve(null);
          return;
        }
        const { data: { publicUrl } } = supabase.storage.from('report-maps').getPublicUrl(path);
        mapSnapshotUrlRef.current = publicUrl;
        // Persist the URL to the reports row so the public page and PDF route can use it.
        await supabase.from('reports').update({ map_snapshot_url: publicUrl }).eq('id', reportId);
        resolve(publicUrl);
      }, 'image/jpeg', 0.92);
    });
  }, [reportId]);

  // ── Build report data object (shared between download and preview) ──
  const buildReportData = useCallback((overrideMapImage?: string | null) => {
    const _parcel = report?.parcels;
    const _parcelCast = _parcel as (typeof _parcel & { owner?: string | null });

    let mapImageBase64: string | null = overrideMapImage ?? null;
    if (mapImageBase64 === null && mapCanvasRef.current) {
      mapImageBase64 = mapCanvasRef.current.toDataURL('image/jpeg', 0.92);
    }

    const seriesWithArea = mapSoilPolygons.map(poly => ({
      ...poly,
      _acres: (() => { try { return turf.area(poly.geojson) / 4046.86; } catch { return 0; } })(),
    }));
    const rawSeries = buildSeriesSummary(seriesWithArea);
    const seriesMap = new Map(rawSeries.map(s => [s.name, s]));
    for (const poly of seriesWithArea) {
      const muname = (poly.geojson.properties?.muname ?? poly.result?.map_unit_name ?? 'Unknown') as string;
      const entry = seriesMap.get(muname);
      if (entry) entry.totalAcres += poly._acres;
    }
    const soilSeries = Array.from(seriesMap.values()).sort((a, b) => b.bestScore - a.bestScore);

    const topZones = mapSoilPolygons
      .map(poly => {
        const props = poly.geojson.properties as Record<string, unknown>;
        const score = (props.suitabilityScore as number) ?? 0;
        return {
          rank: 0,
          name: (props.muname ?? poly.result?.map_unit_name ?? 'Unknown') as string,
          series: ((props.musym ?? '') as string).replace(/[A-Z]$/, ''),
          mukey: poly.mukey,
          score,
          bucket: poly.bucket as 'viable' | 'engineering-needed' | 'not-suitable',
          drainage: (props.drainageScore as number) ?? 0,
          permeability: (props.ksatScore as number) ?? 0,
          slope: (props.slopeScore as number) ?? 0,
          waterTable: (props.watertableScore as number) ?? 0,
          floodOverlap: (props.floodOverlapPct as number) ?? 0,
          wetlandOverlap: (props.wetlandOverlapPct as number) ?? 0,
          areaAcres: (() => { try { return turf.area(poly.geojson) / 4046.86; } catch { return 0; } })(),
        };
      })
      .filter(z => z.score > 0 && z.bucket !== 'not-suitable')
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
      .map((z, i) => ({ ...z, rank: i + 1 }));

    const convScore = zoneScore ?? 0;
    const verdict = convScore >= 70
      ? 'Viable — Conventional Septic Likely'
      : convScore >= 45
        ? 'Engineering Needed'
        : 'Not Suitable — Professional Evaluation Required';

    return {
      address: _parcel?.address ?? 'Unknown Address',
      county: _parcel?.county ?? '',
      state: _parcel?.state ?? '',
      acreage: _parcel?.acreage ?? 0,
      owner: _parcelCast?.owner ?? '',
      generatedDate: new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }),
      bestZoneScore: zoneScore ?? 0,
      parcelScore: parcelScore ?? 0,
      floodPct: envCoverage?.floodPct ?? 0,
      wetlandPct: envCoverage?.nwiPct ?? 0,
      floodZone: envCoverage?.floodZone ?? 'None',
      verdict,
      soilSeries,
      topZones,
      percPins: percPinsRef.current,
      mapImageBase64,
      mapImageUrl: mapSnapshotUrlRef.current ?? null,
      mapImageWidth: mapCanvasRef.current?.width ?? null,
      mapImageHeight: mapCanvasRef.current?.height ?? null,
    };
  }, [envCoverage, mapSoilPolygons, report, parcelScore, zoneScore]);

  // Build the report HTML + slug from current state, capturing a fresh map snapshot.
  const buildReportHtml = useCallback(async (): Promise<{ html: string; slug: string }> => {
    let freshSnapshot: string | null = mapSnapshotRef.current;
    if (requestCaptureRef.current) {
      try {
        const canvas = await requestCaptureRef.current();
        freshSnapshot = canvas.toDataURL('image/jpeg', 0.92);
        mapSnapshotRef.current = freshSnapshot;
        mapCanvasRef.current = canvas;
        // onCanvasReady already kicked off the upload; re-assign so we await the latest one.
        snapshotUploadRef.current = uploadSnapshot(canvas);
      } catch (e) {
        console.warn('[report] fresh capture failed, falling back to cached snapshot:', e);
      }
    }

    // Await the storage upload so map_snapshot_url is written before we navigate.
    // If the upload fails we still proceed — the base64 in the HTML is the fallback.
    await snapshotUploadRef.current.catch(() => null);

    const reportData = buildReportData(freshSnapshot);
    const shareUrl = (() => {
      const u = new URL(window.location.href);
      u.searchParams.set('report', reportId);
      return u.toString();
    })();
    const publicReportUrl = `https://app.perciq.co/report/${reportId}`;
    const slug = (reportData.address ?? 'report').replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 40);
    const html = generateReportHTML(reportData, { shareUrl, publicReportUrl, filename: `PercIQ-${slug}.pdf` });

    // Persist report data (without map image) for public/shared pages.
    const { mapImageBase64: _img, ...reportDataWithoutImage } = reportData;
    supabase.from('reports').update({ report_data: reportDataWithoutImage }).eq('id', reportId).then(({ error }) => {
      if (error) console.warn('[report] failed to cache report_data:', error.message);
    });

    return { html, slug };
  }, [buildReportData, reportId]);

  // ── View Report: capture fresh snapshot, persist report_data, open public URL ──
  const handleDownloadReport = useCallback(async () => {
    if (isGeneratingPdf) return;
    setIsGeneratingPdf(true);
    try {
      // Run capture + persist so the public page has up-to-date report_data.
      await buildReportHtml();
      const publicUrl = `https://app.perciq.co/report/${reportId}`;
      window.open(publicUrl, '_blank');
    } catch (err) {
      console.error('[report] view report failed:', err);
    } finally {
      setIsGeneratingPdf(false);
    }
  }, [isGeneratingPdf, buildReportHtml, reportId]);

  // ── Share: copy report URL to clipboard ──
  const handleShare = useCallback(() => {
    const url = new URL(window.location.href);
    url.searchParams.set('report', reportId);
    navigator.clipboard.writeText(url.toString()).then(() => {
      setShareCopied(true);
      setTimeout(() => setShareCopied(false), 2000);
    });
  }, [reportId]);

  // ── Site Alerts helper — hoisted above early returns so the siteAlerts useMemo
  // can reference it without hitting the temporal dead zone. Uses only its argument
  // and module-level constants (BAND, GATE_BAND), no component state.
  const getSiteAlerts = (data: SoilHoverData | null): { criticals: string[]; warnings: string[] } => {
    if (!data) return { criticals: [], warnings: [] };
    const criticals: string[] = [];
    const warnings: string[] = [];
    for (const gate of data.firedGates) {
      const key = gate.split('→')[0];
      const band = BAND[GATE_BAND[key]];
      if (!band?.alertText || !band?.alertLevel) continue;
      if (band.alertLevel === 'critical') criticals.push(band.alertText);
      else warnings.push(band.alertText);
    }
    console.log('[alerts] mukey', data.mukey, 'gates_fired:', data.firedGates.join(' ') || 'none', 'alerts_emitted:', [...criticals, ...warnings].join(' | ') || 'none');
    return { criticals, warnings };
  };

  // ── HUD derived state ─────────────────────────────────────────────────────
  // Memoized so getSiteAlerts (and the [alerts] log) only re-execute when the
  // inputs that actually determine the displayed soil zone change — not on every
  // unrelated state update (setZoneBadgeColors, setDemSlopeByMukey, etc.).
  // tabPolygon is computed inside the factory so its object identity doesn't
  // become an unstable dep; mapSoilPolygons and activeTab are stable state refs.
  const hudData: SoilHoverData | null = useMemo(() => {
    if (hudHover) return hudHover;
    if (hudLocked) return hudLocked;
    // Tab-selection path: pick highest-scoring polygon for the active bucket
    if (activeTab === 'parcel') return null;
    const byBucket = mapSoilPolygons.filter(p => p.bucket === activeTab);
    if (!byBucket.length) return null;
    const tabPolygon = byBucket.reduce((best, p) => {
      const s = (p.geojson.properties as Record<string, unknown>)?.suitabilityScore as number ?? 0;
      const bs = (best.geojson.properties as Record<string, unknown>)?.suitabilityScore as number ?? 0;
      return s > bs ? p : best;
    });
    const props = tabPolygon.geojson.properties as Record<string, unknown>;
    return {
      mukey: tabPolygon.mukey,
      bucket: tabPolygon.bucket,
      finalScore: Number(props.suitabilityScore ?? 0),
      floodOverlapPct: Number(props.floodOverlapPct ?? 0),
      wetlandOverlapPct: Number(props.wetlandOverlapPct ?? 0),
      drainScore: Number(props.drainageScore ?? 50),
      ksatScore: Number(props.ksatScore ?? 50),
      slopeScore: Number(props.slopeScore ?? 60),
      wtScore: Number(props.watertableScore ?? 55),
      pondingScore: props.pondingScore != null && props.pondingScore !== 'null' ? Number(props.pondingScore) : null,
      restrictiveLayerScore: props.restrictiveLayerScore != null && props.restrictiveLayerScore !== 'null' ? Number(props.restrictiveLayerScore) : null,
      floodingScore: props.floodingScore != null && props.floodingScore !== 'null' ? Number(props.floodingScore) : null,
      soilName: String(props.muname ?? props.musym ?? `Soil ${tabPolygon.mukey}`),
      firedGates: (() => { try { return JSON.parse(String(props.firedGates ?? '[]')) as string[]; } catch { return []; } })(),
      gatingCeiling: props.gatingCeiling != null && props.gatingCeiling !== 'null' ? Number(props.gatingCeiling) : 100,
      rawWatertableInches: props.rawWatertableInches != null && props.rawWatertableInches !== 'null' ? Number(props.rawWatertableInches) : null,
      rawResdeptCm: props.rawResdeptCm != null && props.rawResdeptCm !== 'null' ? Number(props.rawResdeptCm) : null,
      rawFlodfreqcl: props.rawFlodfreqcl != null && props.rawFlodfreqcl !== 'null' ? String(props.rawFlodfreqcl) : null,
      rawSlopePct: props.rawSlopePct != null && props.rawSlopePct !== 'null' ? Number(props.rawSlopePct) : null,
      zoneSlopeDemPct: props.zoneSlopeDemPct != null && props.zoneSlopeDemPct !== 'null' ? Number(props.zoneSlopeDemPct) : null,
      clay40DepthCm: props.clay40DepthCm != null && props.clay40DepthCm !== 'null' ? Number(props.clay40DepthCm) : null,
      rawKsat: props.rawKsat != null && props.rawKsat !== 'null' ? Number(props.rawKsat) : null,
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hudHover, hudLocked, mapSoilPolygons, activeTab]);

  // Memoized: getSiteAlerts (and its [alerts] log) only re-runs when hudData identity changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const siteAlerts = useMemo(() => getSiteAlerts(hudData), [hudData]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full py-32">
        <div className="w-6 h-6 border-2 border-white/20 border-t-primary-400 rounded-full animate-spin" />
      </div>
    );
  }

  if (!report) {
    return (
      <div className="text-center py-20">
        <p className="text-white/40">Report not found.</p>
        <button onClick={onBack} className="btn-ghost mt-4 text-sm">Go Back</button>
      </div>
    );
  }

  const parcel = report.parcels;
  const pipelineDone = pipeline.step1 === 'done'
    && (pipeline.step2 === 'done' || pipeline.step2 === 'skipped')
    && (pipeline.step3 === 'done' || pipeline.step3 === 'error');
  const pipelineError = pipeline.step1 === 'error';
  const tier = (scoreResult?.data_depth_tier ?? report?.data_depth_tier ?? 1) as 1 | 2 | 3 | 4;
  const dataNote = (() => {
    const base = scoreResult?.data_depth_note ?? report?.data_depth_note ?? 'Score and zone estimates based on USDA soil survey data.';
    const county = parcel?.county ?? null;
    const nearby = scoreResult?.nearby_tests_summary?.matching_within_5mi ?? 0;
    if (nearby === 0 && county) return `${base} No local perc test history available for ${county} County yet.`;
    return base;
  })();
  const parcelOwner = (parcel as (typeof parcel & { owner?: string | null }))?.owner;
  const convScore = report.conventional_score ?? scoreResult?.conventional_score ?? null;
  const altScore = report.alternative_score ?? scoreResult?.alternative_score ?? null;

  const nearbyCount = scoreResult?.nearby_tests_summary?.matching_within_5mi ?? 0;

  // Parcel-level stats for bottom strip
  const floodPct = envCoverage?.floodPct ?? 0;
  const nwiPct = envCoverage?.nwiPct ?? 0;
  const viableAcres = (() => {
    const total = mapSoilPolygons.filter(p => p.bucket === 'viable').reduce((s, p) => { try { return s + turf.area(p.geojson); } catch { return s; } }, 0);
    return (total / 4047).toFixed(1);
  })();

  // HUD verdict logic
  const getVerdict = (data: SoilHoverData | null, precomputedAlerts?: { criticals: string[]; warnings: string[] }): { title: string; body: string; color: string; bg: string; border: string } => {
    if (!data) {
      const acreage = parcel?.acreage?.toFixed(0) ?? '?';
      const floodZone = envCoverage?.floodZone ?? 'AE';
      return {
        title: 'Showing full parcel summary',
        body: `${floodPct}% of this ${acreage}ac parcel is in FEMA Zone ${floodZone}. Best zone scores ${zoneScore ?? '—'}. Investigate the viable zone first.`,
        color: 'rgba(255,255,255,0.75)',
        bg: 'rgba(255,255,255,0.04)',
        border: 'rgba(255,255,255,0.12)',
      };
    }
    if (data.bucket === 'viable') {
      const alerts = precomputedAlerts ?? getSiteAlerts(data);
      const hasCriticals = alerts.criticals.length > 0;
      const warnCount = alerts.warnings.length;
      const title = hasCriticals
        ? 'Viable soil but critical site alert detected — review before proceeding'
        : warnCount > 0
          ? `Good candidate for septic — ${warnCount} factor${warnCount > 1 ? 's' : ''} worth investigating`
          : 'Good candidate for septic — no critical factors detected';
      return {
        title,
        body: `${data.soilName}. SI score reflects soil permeability, drainage, and slope. Site alerts above are independent checks.`,
        color: '#30D158', bg: 'rgba(48,209,88,0.07)', border: 'rgba(48,209,88,0.25)',
      };
    }
    if (data.bucket === 'engineering-needed') {
      const alerts = precomputedAlerts ?? getSiteAlerts(data);
      const hasCriticals = alerts.criticals.length > 0;
      return {
        title: hasCriticals
          ? 'Marginal soil with critical site alert — engineering required'
          : 'Marginal soil — engineering evaluation recommended',
        body: 'Soil factors indicate engineering evaluation is needed. Review site alerts above for additional constraints.',
        color: '#FF9F0A', bg: 'rgba(255,159,10,0.07)', border: 'rgba(255,159,10,0.25)',
      };
    }
    if (data.bucket === 'not-suitable') {
      return {
        title: 'Not recommended for conventional septic',
        body: 'Severe soil limitations detected. Multiple factors indicate this zone is unlikely to support a conventional or alternative septic system.',
        color: '#FF453A', bg: 'rgba(255,69,58,0.07)', border: 'rgba(255,69,58,0.25)',
      };
    }
    return {
      title: 'Insufficient data',
      body: 'No soil data matched for this polygon. Contact a licensed soil scientist.',
      color: 'rgba(255,255,255,0.45)', bg: 'rgba(255,255,255,0.04)', border: 'rgba(255,255,255,0.10)',
    };
  };

  const getFlags = (data: SoilHoverData | null): Array<{ color: string; text: string }> => {
    const county = parcel?.county ?? 'County';
    if (!data) {
      const flags: Array<{ color: string; text: string }> = [];
      if (floodPct > 5) flags.push({ color: '#FF453A', text: `${floodPct}% of parcel within FEMA Zone ${envCoverage?.floodZone ?? 'AE'}` });
      if (nwiPct > 0) flags.push({ color: '#FF9F0A', text: `${nwiPct}% wetland coverage detected` });
      if (zoneScore !== null) flags.push({ color: '#30D158', text: `Best zone scores ${zoneScore} — investigate first` });
      if (parseFloat(viableAcres) > 0) flags.push({ color: '#FF9F0A', text: `Viable area estimated at ~${viableAcres} acres` });
      if (percFallbackWarning === 'exhausted') flags.push({ color: '#FF9F0A', text: 'Best zone area is fully flood/wetland impacted. Perc pins shown from next-best available zones. On-site evaluation recommended.' });
      return flags;
    }
    if (data.bucket === 'viable') return [
      { color: data.floodOverlapPct < 5 ? '#30D158' : '#FF9F0A', text: data.floodOverlapPct < 5 ? 'Outside FEMA flood zone' : `${data.floodOverlapPct}% within FEMA Zone AE` },
      { color: data.wetlandOverlapPct < 5 ? '#30D158' : '#FF9F0A', text: data.wetlandOverlapPct < 5 ? 'Outside NWI wetland boundary' : `${data.wetlandOverlapPct}% wetland overlap` },
      { color: '#FF9F0A', text: `${county} rules not yet verified` },
    ];
    if (data.bucket === 'engineering-needed') return [
      { color: '#FF9F0A', text: `${data.floodOverlapPct}% of zone within FEMA Zone AE` },
      ...(data.wetlandOverlapPct < 5 ? [{ color: '#30D158', text: 'No wetland overlap detected' }] : [{ color: '#FF9F0A', text: `${data.wetlandOverlapPct}% wetland overlap` }]),
      { color: '#FF9F0A', text: 'Seasonal high water table detected' },
    ];
    return [
      { color: '#FF453A', text: `${data.floodOverlapPct}% within FEMA Zone AE` },
      { color: '#FF453A', text: 'Insufficient edge setback likely' },
      { color: '#FF453A', text: 'Do not order a perc test here' },
    ];
  };

  const verdict = getVerdict(hudData, siteAlerts);
  const flags = getFlags(hudData);
  const isHovering = !!hudHover;
  const isLocked = !!hudLocked && !hudHover;
  const activeSource = hudData ?? { drainScore: 0, ksatScore: 0, slopeScore: 0, wtScore: 0, pondingScore: null as number | null, restrictiveLayerScore: null as number | null, floodingScore: null as number | null, floodOverlapPct: 0, wetlandOverlapPct: 0, soilName: '—', finalScore: 0, bucket: 'no-data' as const, mukey: '', rawWatertableInches: null as number | null, rawResdeptCm: null as number | null, rawFlodfreqcl: null as string | null, rawSlopePct: null as number | null, zoneSlopeDemPct: null as number | null, clay40DepthCm: null as number | null, rawKsat: null as number | null };

  const barColor = (v: number) => v >= 70 ? '#30D158' : v >= 45 ? '#FF9F0A' : '#FF453A';
  const bucketColor = (b: string) => b === 'viable' ? '#22C55E' : b === 'not-suitable' ? '#FF4539' : b === 'engineering-needed' ? '#FF9F09' : '#6B7280';

  const tabConfig: Array<{ key: ZoneTab; label: string; color: string; tint: string; border: string }> = [
    { key: 'viable', label: 'Viable', color: '#30D158', tint: 'rgba(48,209,88,0.10)', border: 'rgba(48,209,88,0.35)' },
    { key: 'engineering-needed', label: 'Engineering Needed', color: '#FF9F0A', tint: 'rgba(255,159,10,0.10)', border: 'rgba(255,159,10,0.35)' },
    { key: 'not-suitable', label: 'Not suitable', color: '#FF453A', tint: 'rgba(255,69,58,0.10)', border: 'rgba(255,69,58,0.35)' },
    { key: 'parcel', label: 'Full parcel', color: 'rgba(255,255,255,0.7)', tint: 'rgba(255,255,255,0.07)', border: 'rgba(255,255,255,0.18)' },
  ];

  const rightPanel = (
    <div className="h-full overflow-y-auto" style={{ fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Display', system-ui, sans-serif" }}>
      {/* Header */}
      <div className="px-5 pt-5 pb-4 border-b border-white/5">
        <div className="flex items-start gap-3">
          {!isPublic && (
            <button onClick={onBack} className="mt-0.5 text-white/30 hover:text-white transition-colors flex-shrink-0">
              <ArrowLeft className="w-4 h-4" />
            </button>
          )}
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold leading-snug truncate text-white" style={{ letterSpacing: '-0.2px' }}>
              {(() => {
                const addr = toTitleCase(parcel?.address ?? parcel?.apn ?? 'Parcel Report');
                const parts = addr.split(',').map((s: string) => s.trim());
                return parts.length >= 3 ? parts.slice(0, 3).join(', ') : addr;
              })()}
            </h2>
            <p className="text-[11px] text-white/35 mt-1 truncate leading-relaxed">
              {[
                parcel?.acreage != null ? `${parcel.acreage.toFixed(2)} ac` : null,
                parcelOwner ? parcelOwner.toUpperCase() : null,
                parcel?.county ? `${toTitleCase(parcel.county)} Co.` : null,
                parcel?.state ? parcel.state.toUpperCase() : null,
              ].filter(Boolean).join(' · ')}
            </p>
          </div>
        </div>
      </div>

      {/* Pipeline progress */}
      {(!pipelineDone || reanalysing) && !pipelineError && (
        <PipelineProgress pipeline={pipeline} />
      )}

      {/* Hard failure */}
      {pipelineError && (
        <div className="px-6 py-10 flex flex-col items-center text-center gap-4">
          <div className="w-12 h-12 bg-danger-500/10 rounded-xl flex items-center justify-center">
            <AlertCircle className="w-6 h-6 text-danger-400" />
          </div>
          <div>
            <h3 className="font-semibold mb-1">Analysis Failed</h3>
            <p className="text-white/40 text-sm max-w-xs">{pipeline.error}</p>
          </div>
          {!isPublic && <button onClick={handleReanalyse} className="btn-primary text-sm">Try Again</button>}
        </div>
      )}

      {/* Complete report */}
      {pipelineDone && !reanalysing && (
        <div className="flex flex-col" style={{ minHeight: 0 }}>
          <div className="px-5 py-4 space-y-4">

          {/* Score gauges — show skeletons until BOTH map layers ready AND polygons scored */}
          <div className="flex items-start justify-around gap-3 pt-1">
            {mapLayersReady && mapSoilPolygons.length > 0 ? (
              <>
                <ScoreGauge score={zoneScore} label="Best Zone" verdict="Best possible septic location on this parcel" animate />
                <ScoreGauge score={parcelScore} label="Parcel Overall" verdict="Whole parcel accounting for all risk factors" animate />
              </>
            ) : (
              <>
                <ScoreGaugeSkeleton label="Best Zone" />
                <ScoreGaugeSkeleton label="Parcel Overall" />
              </>
            )}
          </div>

          {/* Soil step warning */}
          {pipeline.step2 === 'skipped' && (
            <div className="flex items-start gap-2.5 bg-amber-500/10 border border-amber-500/30 rounded-xl p-3">
              <AlertTriangle className="w-4 h-4 text-amber-400 flex-shrink-0 mt-0.5" />
              <p className="text-xs text-amber-400/80">{pipeline.error}</p>
            </div>
          )}

          {/* Data Sources — compressed strip */}
          <div className="flex flex-wrap items-center gap-3" style={{ minHeight: 28 }}>
            <div className="flex items-center gap-1.5">
              <CheckCircle className="w-3 h-3 flex-shrink-0" style={{ color: '#30D158' }} />
              <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.38)', letterSpacing: '0.3px' }}>SSURGO</span>
            </div>
            <div className="flex items-center gap-1.5">
              {tier >= 2
                ? <CheckCircle className="w-3 h-3 flex-shrink-0" style={{ color: '#30D158' }} />
                : <AlertCircle className="w-3 h-3 flex-shrink-0" style={{ color: '#FF9F0A' }} />
              }
              <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.38)', letterSpacing: '0.3px' }}>
                {parcel?.county ? `${toTitleCase(parcel.county)} EH` : 'County EH'}
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              <AlertCircle className="w-3 h-3 flex-shrink-0" style={{ color: '#FF9F0A' }} />
              <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.38)', letterSpacing: '0.3px' }}>No local history</span>
            </div>
            {!isPublic && (
              <div className="ml-auto">
                <button
                  onClick={handleReanalyse}
                  disabled={reanalysing}
                  className="flex items-center gap-1 transition-colors hover:opacity-80"
                  style={{ color: 'rgba(255,255,255,0.45)', fontSize: 10 }}
                  title="Re-run full analysis"
                >
                  <RefreshCw className={`w-3 h-3 ${reanalysing ? 'animate-spin' : ''}`} />
                  <span>Re-run</span>
                </button>
              </div>
            )}
          </div>

          {/* Download + Share buttons */}
          {!isPublic && mapLayersReady && mapSoilPolygons.length > 0 && (
            <div style={{ display: 'flex', gap: 6 }}>
              <button
                onClick={handleDownloadReport}
                disabled={isGeneratingPdf}
                style={{
                  flex: 1,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 6,
                  padding: '8px 0',
                  borderRadius: 9,
                  background: isGeneratingPdf ? 'rgba(34,197,94,0.10)' : '#22C55E',
                  border: 'none',
                  color: isGeneratingPdf ? '#22C55E' : '#fff',
                  fontSize: 12,
                  fontWeight: 700,
                  cursor: isGeneratingPdf ? 'default' : 'pointer',
                  opacity: isGeneratingPdf ? 0.7 : 1,
                  transition: 'background 150ms, opacity 150ms',
                  letterSpacing: '0.02em',
                }}
              >
                {isGeneratingPdf ? (
                  <RefreshCw size={11} className="animate-spin" />
                ) : (
                  <ExternalLink size={11} />
                )}
                {isGeneratingPdf ? 'Preparing…' : 'View Report'}
              </button>
              <button
                onClick={handleShare}
                title="Copy shareable link"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 5,
                  padding: '8px 12px',
                  borderRadius: 9,
                  background: 'transparent',
                  border: `1px solid ${shareCopied ? 'rgba(34,197,94,0.5)' : 'rgba(255,255,255,0.12)'}`,
                  color: shareCopied ? '#22C55E' : 'rgba(255,255,255,0.50)',
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: 'pointer',
                  transition: 'border-color 150ms, color 150ms',
                  letterSpacing: '0.02em',
                  whiteSpace: 'nowrap',
                  flexShrink: 0,
                }}
              >
                {shareCopied ? <Check size={11} /> : <Link2 size={11} />}
                {shareCopied ? 'Copied!' : 'Share'}
              </button>
            </div>
          )}

          {/* Zone tabs */}
          <div className="flex flex-wrap gap-1.5">
            {tabConfig.map(tab => {
              const isActive = activeTab === tab.key && !hudHover;
              return (
                <button
                  key={tab.key}
                  onClick={() => setActiveTab(tab.key)}
                  style={{
                    padding: '4px 10px',
                    borderRadius: 20,
                    fontSize: 10,
                    fontWeight: 600,
                    letterSpacing: '0.3px',
                    border: `1px solid ${isActive ? tab.border : 'rgba(255,255,255,0.09)'}`,
                    background: isActive ? tab.tint : 'rgba(255,255,255,0.03)',
                    color: isActive ? tab.color : 'rgba(255,255,255,0.40)',
                    transition: 'all 0.2s ease',
                    cursor: 'pointer',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {tab.label}
                </button>
              );
            })}
          </div>

          </div>{/* end px-5 py-4 */}

          {/* Live HUD — main section */}
          <div className="px-5 pb-5 space-y-3 flex-1">

            {/* Hint line */}
            <p style={{ fontSize: 9, textTransform: 'uppercase', letterSpacing: '0.7px', color: 'rgba(255,255,255,0.30)', lineHeight: 1.4 }}>
              {isHovering
                ? `previewing ${hudData?.bucket ?? ''} zone · click to lock`
                : isLocked
                  ? `locked · ${hudLocked?.soilName?.split(' ').slice(0,2).join(' ')} · click map to unlock`
                  : (hudData ? `showing ${activeTab} zone` : 'hover a soil zone · click to lock · or tap a zone above')}
            </p>

            {/* Inline stats row */}
            <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr', alignItems: 'stretch', background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 8, overflow: 'hidden' }}>
              {[
                { label: 'Soil series', value: hudData ? hudData.soilName.split(' ').slice(0, 3).join(' ') : (mapSoilPolygons[0] ? String((mapSoilPolygons[0].geojson.properties as Record<string,unknown>)?.muname ?? '—').split(' ').slice(0,3).join(' ') : '—') },
                { label: 'Flood', value: hudData ? `${hudData.floodOverlapPct}%` : `${floodPct}%` },
                { label: 'Wetland', value: hudData ? `${hudData.wetlandOverlapPct}%` : `${nwiPct}%` },
                { label: 'Zone area', value: hudData ? (() => {
                    const polys = mapSoilPolygons.filter(p => p.mukey === hudData.mukey);
                    if (!polys.length) return '—';
                    try {
                      const totalSqM = polys.reduce((s, p) => s + turf.area(p.geojson), 0);
                      return `${(totalSqM / 4047).toFixed(1)} ac`;
                    } catch { return '—'; }
                  })() : `${viableAcres} ac viable` },
              ].map(({ label, value }, i, arr) => (
                <div key={label} style={{
                  padding: '6px 8px',
                  borderRight: i < arr.length - 1 ? '1px solid rgba(255,255,255,0.06)' : 'none',
                  minWidth: 0,
                  overflow: 'hidden',
                }}>
                  <p style={{ fontSize: 8, color: 'rgba(255,255,255,0.30)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 2, whiteSpace: 'nowrap' }}>{label}</p>
                  <p style={{ fontSize: 11, fontWeight: 700, color: 'rgba(255,255,255,0.82)', letterSpacing: '-0.2px', lineHeight: 1.2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{value}</p>
                </div>
              ))}
            </div>

            {/* Site Alerts banner */}
            {hudData && (() => {
              const hasCriticals = siteAlerts.criticals.length > 0;
              const hasWarnings = siteAlerts.warnings.length > 0;
              if (!hasCriticals && !hasWarnings) {
                return (
                  <div style={{
                    display: 'flex', alignItems: 'center', gap: 7,
                    padding: '7px 11px', borderRadius: 8,
                    background: 'rgba(48,209,88,0.08)', border: '1px solid rgba(48,209,88,0.25)',
                  }}>
                    <span style={{ fontSize: 13, lineHeight: 1 }}>✅</span>
                    <span style={{ fontSize: 11, color: '#30D158', fontWeight: 600 }}>No site alerts detected</span>
                  </div>
                );
              }
              if (hasCriticals) {
                return (
                  <div style={{
                    borderRadius: 8, overflow: 'hidden',
                    border: '1px solid rgba(255,69,58,0.40)',
                    background: 'rgba(255,69,58,0.07)',
                  }}>
                    <div style={{
                      display: 'flex', alignItems: 'center', gap: 7,
                      padding: '7px 11px',
                      background: 'rgba(255,69,58,0.12)',
                      borderBottom: siteAlerts.criticals.length > 0 ? '1px solid rgba(255,69,58,0.20)' : 'none',
                    }}>
                      <span style={{ fontSize: 13, lineHeight: 1 }}>⛔</span>
                      <span style={{ fontSize: 11, color: '#FF453A', fontWeight: 700 }}>Critical site alert — review before ordering perc test</span>
                    </div>
                    <div style={{ padding: '6px 11px 8px', display: 'flex', flexDirection: 'column', gap: 4 }}>
                      {siteAlerts.criticals.map((msg, i) => (
                        <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
                          <span style={{ fontSize: 10, color: '#FF453A', flexShrink: 0, marginTop: 1 }}>⛔</span>
                          <span style={{ fontSize: 11, color: 'rgba(255,120,110,0.90)', lineHeight: 1.45 }}>{msg}</span>
                        </div>
                      ))}
                      {siteAlerts.warnings.map((msg, i) => (
                        <div key={`w${i}`} style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
                          <span style={{ fontSize: 10, color: '#FF9F0A', flexShrink: 0, marginTop: 1 }}>⚠️</span>
                          <span style={{ fontSize: 11, color: 'rgba(255,159,10,0.85)', lineHeight: 1.45 }}>{msg}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              }
              // warnings only
              return (
                <div style={{
                  borderRadius: 8, overflow: 'hidden',
                  border: '1px solid rgba(255,159,10,0.35)',
                  background: 'rgba(255,159,10,0.07)',
                }}>
                  <div style={{
                    display: 'flex', alignItems: 'center', gap: 7,
                    padding: '7px 11px',
                    background: 'rgba(255,159,10,0.10)',
                    borderBottom: '1px solid rgba(255,159,10,0.18)',
                  }}>
                    <span style={{ fontSize: 13, lineHeight: 1 }}>⚠️</span>
                    <span style={{ fontSize: 11, color: '#FF9F0A', fontWeight: 700 }}>
                      {siteAlerts.warnings.length} site warning{siteAlerts.warnings.length > 1 ? 's' : ''} — review before ordering perc test
                    </span>
                  </div>
                  <div style={{ padding: '6px 11px 8px', display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {siteAlerts.warnings.map((msg, i) => (
                      <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
                        <span style={{ fontSize: 10, color: '#FF9F0A', flexShrink: 0, marginTop: 1 }}>⚠️</span>
                        <span style={{ fontSize: 11, color: 'rgba(255,159,10,0.85)', lineHeight: 1.45 }}>{msg}</span>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })()}

            {/* Verdict + Zone score — side by side */}
            <div style={{
              display: 'flex',
              gap: 0,
              borderRadius: 10,
              background: verdict.bg,
              border: `1px solid ${isLocked ? verdict.color : verdict.border}`,
              transition: 'all 0.35s ease',
              boxShadow: isLocked ? `0 0 0 1px ${verdict.color}33` : 'none',
              overflow: 'hidden',
            }}>
              {/* Zone score — compact left column */}
              {hudData && (
                <div style={{
                  flexShrink: 0,
                  width: 76,
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  padding: '12px 8px',
                  borderRight: `1px solid ${bucketColor(hudData.bucket)}22`,
                  background: `${bucketColor(hudData.bucket)}08`,
                  transition: 'background 0.35s ease, border-color 0.35s ease',
                  gap: 4,
                }}>
                  <p style={{ fontSize: 8, textTransform: 'uppercase', letterSpacing: '0.7px', color: 'rgba(255,255,255,0.30)', lineHeight: 1 }}>
                    SI Score
                  </p>
                  <span
                    key={hudData.mukey}
                    style={{
                      fontSize: 36,
                      fontWeight: 800,
                      color: bucketColor(hudData.bucket),
                      letterSpacing: '-2px',
                      lineHeight: 1,
                      textShadow: `0 0 20px ${bucketColor(hudData.bucket)}55`,
                      animation: 'zone-score-in 0.35s cubic-bezier(0.34,1.56,0.64,1) both',
                    }}
                  >
                    {hudData.finalScore}
                  </span>
                  <span style={{ fontSize: 9, color: 'rgba(255,255,255,0.40)', lineHeight: 1.2, textAlign: 'center' }}>
                    {hudData.bucket === 'viable' ? 'Viable' : hudData.bucket === 'engineering-needed' ? 'Engineering Needed' : hudData.bucket === 'not-suitable' ? 'Not suitable' : 'No data'}
                  </span>
                </div>
              )}
              {/* Verdict — takes remaining space */}
              <div style={{ flex: 1, padding: '12px 14px', minWidth: 0 }}>
                <p style={{ fontSize: 13, fontWeight: 700, color: verdict.color, letterSpacing: '-0.2px', marginBottom: 5, lineHeight: 1.3 }}>
                  {verdict.title}
                </p>
                <p style={{ fontSize: 11, color: 'rgba(255,255,255,0.60)', lineHeight: 1.6 }}>
                  {verdict.body}
                </p>
              </div>
            </div>

            {/* Soil factor bars */}
            {hudData && (() => {
              type Sev = 'good' | 'warning' | 'critical';
              const NULL_COLOR = 'rgba(255,255,255,0.22)';
              const sevColor = (s: Sev) => s === 'good' ? '#22C55E' : s === 'warning' ? '#FF9F0A' : '#FF453A';
              const sevIcon  = (s: Sev) => s === 'good' ? '✓' : '⚠';
              // Score-only severity (for bar fill minimum)
              const scoreSev = (v: number): Sev => v >= 75 ? 'good' : v >= 45 ? 'warning' : 'critical';
              // Per-condition messages — gated factors dispatch through BAND via GATE_BAND so the
              // bar text and site alert text come from the same named band constant.
              const firedKeys = (hudData?.firedGates ?? []).map(g => g.split('→')[0]);
              const bandFor = (key: string): BandCopy | undefined => BAND[GATE_BAND[key]];
              const firstFiredBand = (keys: string[]): BandCopy | undefined => {
                for (const k of keys) { const b = bandFor(k); if (b) return b; }
                return undefined;
              };
              const factorMsg = (label: string, v: number | null): { text: string; sev: Sev } | null => {
                if (v === null) return null;
                if (label === 'Drainage') {
                  if (v >= 90) return { sev: 'good',     text: 'Well drained — favorable conditions for septic.' };
                  if (v >= 75) return { sev: 'good',     text: 'Moderately well drained — adequate for most conventional systems.' };
                  if (v >= 65) return { sev: 'warning',  text: 'Somewhat excessively drained — drains very fast; effluent may receive limited treatment. Verify perc rate isn\'t too rapid.' };
                  if (v >= 45) return { sev: 'warning',  text: 'Somewhat poorly drained — seasonal saturation limits system options.' };
                  return                { sev: 'critical', text: 'Poorly drained — high risk of system failure.' };
                }
                if (label === 'Permeability') {
                  // ksat_extreme gate (ksat < 0.4 or > 150 µm/s): distinguish slow vs fast via raw ksat
                  if (firedKeys.includes('ksat_extreme')) {
                    const rawKsat = hudData.rawKsat;
                    if (rawKsat !== null && rawKsat < 0.4) return { sev: 'critical', text: 'Very slow permeability — conventional septic will not function; engineered treatment required.' };
                    return { sev: 'critical', text: 'Very fast permeability — effluent will not be treated; engineered system or alternate site required.' };
                  }
                  // Score-band copy — ordered highest to lowest to match ksatScore tiers
                  if (v >= 85) return { sev: 'good',     text: 'Ideal permeability — favorable range for conventional septic absorption (~15–60 min/inch perc rate).' };
                  if (v >= 65) return { sev: 'good',     text: 'Moderate-fast permeability — works for conventional systems; treatment adequate.' };
                  if (v >= 55) return { sev: 'warning',  text: 'Borderline-slow permeability — conventional may pass but design-dependent; verify with local health department.' };
                  if (v >= 40) return { sev: 'warning',  text: 'Fast permeability — treatment may be reduced before reaching groundwater; engineered system may be required.' };
                  return                { sev: 'warning',  text: 'Slow permeability — likely fails conventional perc; engineered or alternative design needed.' };
                }
                if (label === 'Slope') {
                  // Determine slope source for annotation shown in the bar text
                  const demSlope  = hudData.zoneSlopeDemPct;
                  const ssurgoSlope = hudData.rawSlopePct;
                  const resolvedSlope = demSlope ?? ssurgoSlope;
                  const slopeSource  = demSlope !== null ? 'DEM-derived' : 'county-averaged';
                  const slopeAnnotation = resolvedSlope !== null ? ` (${resolvedSlope.toFixed(1)}%, ${slopeSource})` : '';
                  const sb = firstFiredBand(['slope>30%', 'slope15-30%'].filter(k => firedKeys.includes(k)));
                  if (sb) return { sev: sb.barSev, text: sb.barText + slopeAnnotation };
                  if (v >= 80) return { sev: BAND.slope_gentle.barSev,   text: BAND.slope_gentle.barText + slopeAnnotation };
                  return               { sev: BAND.slope_moderate.barSev, text: BAND.slope_moderate.barText + slopeAnnotation };
                }
                if (label === 'Water table') {
                  const wb = firstFiredBand(['wt<18in', 'wt18-24in', 'wt24-36in'].filter(k => firedKeys.includes(k)));
                  if (wb) return { sev: wb.barSev, text: wb.barText };
                  return { sev: BAND.wt_deep.barSev, text: BAND.wt_deep.barText };
                }
                if (label === 'Ponding') {
                  if (v >= 80) return { sev: 'good',     text: 'Standing water not expected — favorable condition.' };
                  if (v >= 40) return { sev: 'warning',  text: 'Occasional ponding possible — evaluate buildable area.' };
                  return                { sev: 'critical', text: 'Frequent ponding likely — high risk for system failure.' };
                }
                if (label === 'Depth to restriction') {
                  const rb = firstFiredBand(['restr<20in(bedrock)', 'restr<20in(clay)', 'restr20-36in'].filter(k => firedKeys.includes(k)));
                  if (rb) {
                    // For inferred clay, show measured depth in the bar text
                    const isClayInferred = hudData.rawResdeptCm === null && hudData.clay40DepthCm !== null;
                    if (isClayInferred && hudData.clay40DepthCm !== null && (firedKeys.includes('restr<20in(clay)') || firedKeys.includes('restr20-36in'))) {
                      const depthIn = Math.round(hudData.clay40DepthCm * 0.394);
                      return { sev: rb.barSev, text: `Inferred clay restriction at ~${depthIn} inches — ${rb.barSev === 'critical' ? 'conventional system unlikely without mound or alternative design.' : 'verify on site.'}` };
                    }
                    return { sev: rb.barSev, text: rb.barText };
                  }
                  return { sev: BAND.restr_deep.barSev, text: BAND.restr_deep.barText };
                }
                if (label === 'Flooding') {
                  const fb = firstFiredBand(['flodfreq'].filter(k => firedKeys.includes(k)));
                  if (fb) return { sev: fb.barSev, text: fb.barText };
                  if (v >= 80) return { sev: BAND.flood_none.barSev,      text: BAND.flood_none.barText };
                  if (v >= 40) return { sev: BAND.flood_occasional.barSev, text: BAND.flood_occasional.barText };
                  return               { sev: BAND.flood_frequent.barSev,  text: BAND.flood_frequent.barText };
                }
                return null;
              };
              // Resolved severity: worst of score-derived and message-declared
              const resolveSev = (v: number | null, label: string): Sev | null => {
                if (v === null) return null;
                const msg = factorMsg(label, v);
                const fromScore = scoreSev(v);
                if (!msg) return fromScore;
                const rank: Record<Sev, number> = { good: 0, warning: 1, critical: 2 };
                return rank[msg.sev] >= rank[fromScore] ? msg.sev : fromScore;
              };
              const factors: Array<{ label: string; value: number | null }> = [
                { label: 'Drainage',      value: hudData.drainScore },
                { label: 'Permeability',  value: hudData.ksatScore },
                { label: 'Slope',         value: hudData.slopeScore },
                // Show null (→ "—") when rawWatertableInches is null — wtScore=55 is a scoring neutral,
                // not an observed depth, so displaying it as "Moderate depth" would be misleading.
                { label: 'Water table',   value: hudData.rawWatertableInches !== null ? hudData.wtScore : null },
                { label: 'Ponding',       value: hudData.pondingScore },
                { label: 'Depth to restriction', value: hudData.restrictiveLayerScore },
                { label: 'Flooding',      value: hudData.floodingScore },
              ];
              return (
                <div>
                  <p style={{ fontSize: 9, textTransform: 'uppercase', letterSpacing: '0.7px', color: 'rgba(255,255,255,0.30)', marginBottom: 8 }}>
                    Soil factors
                  </p>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    {factors.map(({ label, value }) => {
                      const isNull = value === null;
                      const sev = resolveSev(value, label);
                      const color = sev ? sevColor(sev) : NULL_COLOR;
                      const msg = value !== null ? factorMsg(label, value) : null;
                      return (
                        <div key={label}>
                          <div className="flex items-center gap-2" style={{ marginBottom: 3 }}>
                            <span style={{ fontSize: 10, color: isNull ? NULL_COLOR : 'rgba(255,255,255,0.45)', width: 72, flexShrink: 0 }}>{label}</span>
                            <div style={{ flex: 1, height: 3, borderRadius: 2, background: 'rgba(255,255,255,0.08)', overflow: 'hidden' }}>
                              <div style={{
                                height: '100%',
                                width: isNull ? '0%' : `${value}%`,
                                borderRadius: 2,
                                background: color,
                                transition: 'width 0.45s ease, background 0.45s ease',
                              }} />
                            </div>
                            <span style={{ fontSize: 10, color, width: 24, textAlign: 'right', fontWeight: 600 }}>{isNull ? '—' : value}</span>
                          </div>
                          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 4, paddingLeft: 76 }}>
                            {isNull
                              ? <span style={{ fontSize: 11, color: NULL_COLOR, lineHeight: 1.45 }}>No data available — field verification recommended</span>
                              : <>
                                  {sev !== 'good' && <span style={{ fontSize: 11, color, lineHeight: 1, flexShrink: 0, marginTop: 1 }}>{sevIcon(sev!)}</span>}
                                  <span style={{ fontSize: 11, color, lineHeight: 1.45 }}>{msg?.text ?? ''}</span>
                                </>
                            }
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })()}

            {/* Site flags */}
            <div>
              <p style={{ fontSize: 9, textTransform: 'uppercase', letterSpacing: '0.7px', color: 'rgba(255,255,255,0.30)', marginBottom: 8 }}>
                Site flags
              </p>
              <div className="space-y-2">
                {flags.map((flag, i) => (
                  <div key={i} className="flex items-start gap-2">
                    <div style={{ width: 5, height: 5, borderRadius: '50%', background: flag.color, flexShrink: 0, marginTop: 4 }} />
                    <p style={{ fontSize: 11, color: 'rgba(255,255,255,0.60)', lineHeight: 1.5 }}>{flag.text}</p>
                  </div>
                ))}
              </div>
            </div>


          </div>{/* end Live HUD */}

          {/* Bottom pill strip — always parcel-level */}
          <div className="px-5 pb-4 border-t border-white/5 pt-3">
            <div className="flex flex-wrap gap-1.5">
              {[
                { dot: '#30D158', text: `Best: ${zoneScore ?? '—'}` },
                { dot: 'rgba(255,255,255,0.40)', text: `Overall: ${parcelScore ?? '—'}` },
                { dot: '#818CF8', text: `Flood: ${floodPct}%` },
                { dot: '#38BDF8', text: `Wetland: ${nwiPct}%` },
                { dot: '#30D158', text: `Viable: ~${viableAcres}ac` },
              ].map(pill => (
                <div key={pill.text} style={{
                  display: 'flex', alignItems: 'center', gap: 5,
                  background: 'rgba(255,255,255,0.05)',
                  border: '1px solid rgba(255,255,255,0.09)',
                  borderRadius: 20, padding: '3px 9px',
                }}>
                  <div style={{ width: 5, height: 5, borderRadius: '50%', background: pill.dot, flexShrink: 0 }} />
                  <span style={{ fontSize: 9, color: 'rgba(255,255,255,0.55)', letterSpacing: '0.3px' }}>{pill.text}</span>
                </div>
              ))}
            </div>
          </div>

        </div>
      )}

      {/* Public CTA banner */}
      {isPublic && (
        <div style={{
          margin: '0 20px 20px',
          padding: '14px 16px',
          borderRadius: 12,
          background: 'linear-gradient(135deg, rgba(34,197,94,0.10) 0%, rgba(34,197,94,0.05) 100%)',
          border: '1px solid rgba(34,197,94,0.25)',
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
        }}>
          <div>
            <p style={{ fontSize: 12, fontWeight: 700, color: '#22C55E', letterSpacing: '-0.1px', marginBottom: 3 }}>
              Run your own parcel analysis
            </p>
            <p style={{ fontSize: 11, color: 'rgba(255,255,255,0.55)', lineHeight: 1.5 }}>
              PercIQ screens any parcel for septic suitability using USDA soil data, FEMA flood zones, and wetland boundaries — in minutes.
            </p>
          </div>
          <a
            href="https://app.perciq.co"
            target="_blank"
            rel="noopener noreferrer"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 6,
              padding: '8px 14px',
              borderRadius: 8,
              background: '#22C55E',
              color: '#fff',
              fontSize: 12,
              fontWeight: 700,
              textDecoration: 'none',
              letterSpacing: '0.02em',
              transition: 'opacity 150ms',
            }}
            onMouseEnter={e => (e.currentTarget.style.opacity = '0.85')}
            onMouseLeave={e => (e.currentTarget.style.opacity = '1')}
          >
            Get your free analysis at perciq.co
          </a>
        </div>
      )}
    </div>
  );

  return (
    <div className="flex flex-col md:flex-row overflow-hidden" style={{ height: 'calc(100vh - 3.5rem)' }}>
      {/* Map — single instance, responsive: 250px tall full-width on mobile, 60% wide full-height on desktop */}
      <div className="w-full shrink-0 md:w-[60%] h-[250px] md:h-full" data-mobile-map>
        <div className="w-full h-full">
          <MapPanel
            reportId={reportId}
            cachedOverlayGeojson={report?.overlay_geojson ?? null}
            parcelBoundary={stableParcelBoundary}
            isBboxFallback={isBboxFallback}
            boundarySource={boundarySource}
            soilResults={stableSoilResults}
            lat={parcel?.lat ?? null}
            lng={parcel?.lng ?? null}
            onMapReady={(map) => {
              mapRef.current = map;
              console.log('MAP READY — stored reference');
            }}
            onCoverageUpdate={handleCoverageUpdate}
            onSoilPolygonsReady={setMapSoilPolygons}
            onDemSlopeReady={setDemSlopeByMukey}
            onAllLayersReady={() => {
              console.log('[map] all layers ready — overlay dismissed');
              setMapLayersReady(true);
            }}
            requestCaptureRef={requestCaptureRef}
            onCanvasReady={(canvas) => {
              mapCanvasRef.current = canvas;
              try {
                mapSnapshotRef.current = canvas.toDataURL('image/jpeg', 0.92);
              } catch (e) {
                console.warn('[map] composited snapshot failed:', e);
              }
              // Upload to Supabase Storage; store the Promise so "View Report" can await it.
              snapshotUploadRef.current = uploadSnapshot(canvas);
            }}
            onBestZoneInFlood={setBestZoneInFloodWarning}
            onPercFallback={(exhausted) => setPercFallbackWarning(exhausted ? 'exhausted' : 'expanded')}
            onPercPinsReady={(pins) => { percPinsRef.current = pins; }}
            onTokenReady={(token) => { mapboxTokenRef.current = token; }}
            onSoilHover={setHudHover}
            onSoilClick={(data) => {
              setHudLocked(prev => prev?.mukey === data.mukey ? null : data);
            }}
            activeTab={activeTab}
          />
        </div>
      </div>
      {/* Right panel: on mobile full-width scrollable, on desktop fixed 40% */}
      <div className="bg-navy-800 md:border-l border-t md:border-t-0 border-white/5 flex flex-col w-full md:w-auto md:flex-none overflow-y-auto" style={{ '--panel-w': '40%' } as React.CSSProperties}>
        <div className="md:w-[40vw] md:min-w-[320px] md:h-full">
          {rightPanel}
        </div>
      </div>
    </div>
  );
}
