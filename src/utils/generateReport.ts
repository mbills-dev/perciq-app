export interface ZoneData {
  rank: number;
  name: string;
  series: string;
  mukey: string;
  score: number;
  bucket: 'viable' | 'engineering' | 'not-suitable' | 'possible';
  drainage: number;
  permeability: number;
  slope: number;
  waterTable: number;
  floodOverlap: number;
  wetlandOverlap: number;
  areaAcres: number | string;
}

export interface SeriesData {
  name: string;
  series: string;
  mukeys: string[];
  slopeClasses?: string[];
  totalAcres: number;
  drainage: string;
  ksat: number;
  bestScore: number;
  bucket?: string;
}

export interface PercPinData {
  rank: number;
  lat: string;
  lng: string;
  zoneName: string;
  zoneSeries: string;
  zoneScore: number;
  edgeDist: string;
  confidence: 'High' | 'Medium' | 'Low';
}

export interface ReportData {
  address: string;
  county: string;
  state: string;
  acreage: number | string;
  owner: string;
  generatedDate: string;
  bestZoneScore: number;
  parcelScore: number;
  floodPct: number;
  wetlandPct: number;
  floodZone: string;
  verdict: string;
  soilSeries: SeriesData[];
  topZones: ZoneData[];
  percPins: PercPinData[];
  mapImageBase64: string | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function scoreColor(score: number): string {
  if (score >= 65) return '#22C55E';
  if (score >= 35) return '#FF9F09';
  return '#FF4539';
}

function bucketColor(bucket: string): string {
  if (bucket === 'viable') return '#22C55E';
  if (bucket === 'not-suitable') return '#FF4539';
  return '#FF9F09';
}

function bucketLabel(bucket: string): string {
  if (bucket === 'viable') return 'Viable \u2713';
  if (bucket === 'not-suitable') return 'Not Suitable';
  return 'Engineering Needed';
}

function wetlandGaugeColor(pct: number): string {
  if (pct === 0) return '#22C55E';
  if (pct < 10) return '#64748b';
  return '#FF9F09';
}

function zoneVerdictText(bucket: string): string {
  return bucketLabel(bucket);
}

function scoreChipClass(bucket: string): string {
  return bucket === 'viable' ? 'scc-g' : bucket === 'not-suitable' ? 'scc-r' : 'scc-a';
}

function factorBarClass(score: number): string {
  if (score >= 70) return 'ff-g';
  if (score >= 45) return 'ff-a';
  return 'ff-r';
}

function seriesOutlookPill(score: number): string {
  if (score >= 65) {
    return `<div style="font-size:10px;font-weight:700;color:#22C55E;background:rgba(34,197,94,0.08);border:1px solid rgba(34,197,94,0.2);border-radius:20px;padding:2px 8px;display:inline-block;white-space:nowrap">Viable</div>`;
  } else if (score >= 35) {
    return `<div style="font-size:10px;font-weight:700;color:#FF9F09;background:rgba(255,159,9,0.09);border:1px solid rgba(255,159,9,0.25);border-radius:20px;padding:2px 8px;display:inline-block;white-space:nowrap">Eng. Needed</div>`;
  } else {
    return `<div style="font-size:10px;font-weight:700;color:#FF4539;background:rgba(255,69,57,0.08);border:1px solid rgba(255,69,57,0.22);border-radius:20px;padding:2px 8px;display:inline-block;white-space:nowrap">Not Suitable</div>`;
  }
}

function badgeClass(rank: number): string {
  if (rank === 1) return 'zb-1';
  if (rank === 2) return 'zb-2';
  return 'zb-3';
}

function pinNumClass(rank: number): string {
  if (rank === 1) return 'pn-1';
  if (rank === 2) return 'pn-2';
  return 'pn-3';
}

function confBarWidth(conf: string): string {
  if (conf === 'High') return '85%';
  if (conf === 'Medium') return '60%';
  return '35%';
}

function confBarClass(conf: string): string {
  return conf === 'High' ? 'crf-g' : 'crf-a';
}

function confValClass(conf: string): string {
  return conf === 'High' ? 'crv-g' : 'crv-a';
}

function pinSiteLabel(rank: number): string {
  if (rank === 1) return 'Primary Site';
  if (rank === 2) return 'Secondary Site';
  return 'Tertiary Site';
}

// ── Series rows ───────────────────────────────────────────────────────────────

function buildSeriesRows(series: SeriesData[]): string {
  if (series.length === 0) return '';
  return series.map((s, i) => {
    const dot = scoreColor(s.bestScore);
    const isLast = i === series.length - 1;
    const rowBorder = isLast ? '' : 'border-bottom:1px solid var(--rule)';
    const descBorder = isLast ? '' : 'border-bottom:1px solid var(--rule)';
    const descBg = s.bestScore >= 70 ? 'rgba(34,197,94,0.02)' : 'rgba(255,159,9,0.02)';
    const mukeysStr = s.mukeys.slice(0, 3).join(', ');
    const slopeCount = s.slopeClasses ? s.slopeClasses.length : 1;
    const ksatDisplay = s.ksat > 0 ? s.ksat.toFixed(1) : '\u2014';
    const drainColor = s.bestScore >= 45 ? 'var(--g)' : '#FF9F09';
    return `
        <div style="display:grid;grid-template-columns:22px 1fr 80px 72px 60px 110px;align-items:center;padding:10px 14px;${rowBorder}">
          <div style="width:9px;height:9px;border-radius:50%;background:${dot};flex-shrink:0"></div>
          <div style="min-width:0">
            <div style="font-size:12px;font-weight:700;color:var(--ink);letter-spacing:-0.01em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${s.name}</div>
            <div style="font-size:11px;font-weight:400;color:var(--slate);margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">Series ${s.series}${mukeysStr ? ` \u00b7 ${mukeysStr}` : ''} \u00b7 ${slopeCount} class${slopeCount !== 1 ? 'es' : ''}</div>
          </div>
          <div style="text-align:center">
            <div style="font-size:9px;font-weight:700;color:var(--slate);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:2px">Drainage</div>
            <div style="font-size:11px;font-weight:700;color:${drainColor}">${s.drainage || '\u2014'}</div>
          </div>
          <div style="text-align:center">
            <div style="font-size:9px;font-weight:700;color:var(--slate);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:2px">Area</div>
            <div style="font-size:11px;font-weight:700;color:var(--ink)">${s.totalAcres > 0 ? s.totalAcres.toFixed(1) + ' ac' : '\u2014'}</div>
          </div>
          <div style="text-align:center">
            <div style="font-size:9px;font-weight:700;color:var(--slate);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:2px">ksat</div>
            <div style="font-size:11px;font-weight:700;color:var(--ink)">${ksatDisplay}</div>
          </div>
          <div style="text-align:center">
            <div style="font-size:9px;font-weight:700;color:var(--slate);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:2px">Outlook</div>
            ${seriesOutlookPill(s.bestScore)}
          </div>
        </div>
        <div style="padding:6px 14px 8px 44px;${descBorder};background:${descBg}">
          <div style="font-size:11px;font-weight:400;color:var(--ink3);line-height:1.5">Score: <strong style="color:${dot}">${Math.round(s.bestScore)}</strong> &nbsp;\u00b7&nbsp; ${s.drainage ? s.drainage + ' drainage' : 'Drainage data unavailable'}${s.ksat > 0 ? ` &nbsp;\u00b7&nbsp; ksat ${ksatDisplay} \u03bcm/s` : ''}</div>
        </div>`;
  }).join('');
}

// ── Zone cards ────────────────────────────────────────────────────────────────

function buildZoneCards(zones: ZoneData[]): string {
  if (zones.length === 0) return '<p style="color:var(--slate);text-align:center;padding:20px 0;">No scored zones available.</p>';
  return zones.map(z => {
    const color = bucketColor(z.bucket);
    const chipClass = scoreChipClass(z.bucket);
    const verdict = zoneVerdictText(z.bucket);
    const badge = badgeClass(z.rank);
    const areaDisplay = typeof z.areaAcres === 'number' ? (z.areaAcres as number).toFixed(1) + ' ac' : (z.areaAcres || '\u2014');
    const floodPct = typeof z.floodOverlap === 'number' ? Math.round(z.floodOverlap) : 0;
    const wetPct = typeof z.wetlandOverlap === 'number' ? Math.round(z.wetlandOverlap) : 0;
    const floodDisplay = floodPct + '%';
    const wetDisplay = wetPct + '%';
    const floodColor = floodPct > 0 ? '#FF9F09' : 'var(--g)';
    const wetStyle = wetPct > 0 ? ` style="color:#FF9F09"` : '';
    const wetClass = wetPct > 0 ? '' : ' zsv-g';

    const drainageScore = typeof z.drainage === 'number' ? z.drainage : 0;
    const permScore = typeof z.permeability === 'number' ? z.permeability : 0;
    const slopeScore = typeof z.slope === 'number' ? z.slope : 0;
    const wtScore = typeof z.waterTable === 'number' ? z.waterTable : 0;

    const insTagClass = z.bucket === 'viable' ? 'it-g' : 'it-a';
    const insLabel = z.bucket === 'viable' ? 'Good' : 'Note';
    const insText = z.bucket === 'viable'
      ? `<b>Strong overall profile.</b> Score of ${Math.round(z.score)} \u2014 viable for conventional septic${floodPct === 0 && wetPct === 0 ? ' with no flood or wetland overlap.' : '.'}`
      : `<b>Engineering review may be needed.</b> Score of ${Math.round(z.score)} ${verdict.toLowerCase()}${floodPct > 0 ? ` with ${floodDisplay} flood overlap` : ''}${wetPct > 0 ? ` and ${wetDisplay} wetland overlap` : ''}.`;

    return `
    <div class="zone-card">
      <div class="zc-head">
        <div class="zc-badge ${badge}">${z.rank}</div>
        <div class="zc-ng">
          <div class="zc-name">${z.name}</div>
          <div class="zc-series">Series ${z.series} \u00b7 mukey ${z.mukey}</div>
        </div>
        <div class="sc-chip ${chipClass}">${Math.round(z.score)} / 100</div><div class="zc-v">${verdict}</div>
      </div>
      <div class="zc-body">
        <div class="zc-factors">
          <div class="frow"><div class="ft"><span class="fn">Drainage</span><span class="fv">${Math.round(drainageScore)}</span></div><div class="fbar"><div class="ff ${factorBarClass(drainageScore)}" style="width:${Math.max(2, drainageScore)}%"></div></div></div>
          <div class="frow"><div class="ft"><span class="fn">Permeability</span><span class="fv">${Math.round(permScore)}</span></div><div class="fbar"><div class="ff ${factorBarClass(permScore)}" style="width:${Math.max(2, permScore)}%"></div></div></div>
          <div class="frow"><div class="ft"><span class="fn">Slope</span><span class="fv">${Math.round(slopeScore)}</span></div><div class="fbar"><div class="ff ${factorBarClass(slopeScore)}" style="width:${Math.max(2, slopeScore)}%"></div></div></div>
          <div class="frow"><div class="ft"><span class="fn">Water Table</span><span class="fv">${Math.round(wtScore)}</span></div><div class="fbar"><div class="ff ${factorBarClass(wtScore)}" style="width:${Math.max(2, wtScore)}%"></div></div></div>
        </div>
        <div class="zc-sep"></div>
        <div class="zc-ins">
          <div class="ins"><div class="ins-tag ${insTagClass}">${insLabel}</div><div class="ins-txt">${insText}</div></div>
        </div>
      </div>
      <div class="zc-stats">
        <div class="zc-stat"><div class="zsl">Zone Area</div><div class="zsv zsv-g">${areaDisplay}</div></div>
        <div class="zc-stat"><div class="zsl">Flood</div><div class="zsv" style="color:${floodColor}">${floodDisplay}</div></div>
        <div class="zc-stat"><div class="zsl">Wetland</div><div class="zsv${wetClass}"${wetStyle}>${wetDisplay}</div></div>
      </div>
    </div>`;
  }).join('');
}

// ── Pin cards ─────────────────────────────────────────────────────────────────

function buildPinCards(pins: PercPinData[]): string {
  if (pins.length === 0) return '<p style="color:var(--slate);text-align:center;padding:20px 0;grid-column:1/-1;">No perc test sites calculated.</p>';
  return pins.slice(0, 3).map(p => {
    const numClass = pinNumClass(p.rank);
    const siteLabel = pinSiteLabel(p.rank);
    const bw = confBarWidth(p.confidence);
    const bc = confBarClass(p.confidence);
    const vc = confValClass(p.confidence);
    const verdictLabel = zoneVerdictText(p.zoneScore).replace(' \u2713', '');
    return `
      <div class="pin-card">
        <div class="pc-head"><div class="pc-num ${numClass}">${p.rank}</div><span class="pc-lbl">${siteLabel}</span></div>
        <div class="pc-body">
          <div class="pc-row"><div class="pcrl">Coordinates</div><div class="pcrv">${p.lat}\u00b0N, ${p.lng}\u00b0W</div></div>
          <div class="pc-row"><div class="pcrl">Soil Zone</div><div class="pcrv">${p.zoneName}${p.zoneSeries ? ' \u2014 ' + p.zoneSeries : ''}</div><div class="pcrs">Score ${p.zoneScore} \u00b7 ${verdictLabel}</div></div>
          <div class="pc-row"><div class="pcrl">Edge Setback</div><div class="pcrv">${p.edgeDist}</div></div>
          <div class="conf-row"><span class="cr-lbl">Confidence</span><div class="cr-trk"><div class="cr-fill ${bc}" style="width:${bw}"></div></div><span class="cr-val ${vc}">${p.confidence}</span></div>
        </div>
      </div>`;
  }).join('');
}

// ── Assessment text ───────────────────────────────────────────────────────────

function buildAssessmentText(data: ReportData): string {
  const viableCount = data.topZones.filter(z => z.bucket === 'viable').length;
  const topName = data.topZones[0]?.name ?? 'unknown';
  const floodNote = data.floodPct > 0
    ? `${data.floodPct}% of the parcel falls within FEMA Zone ${data.floodZone}.`
    : 'No FEMA flood zone exposure detected.';
  const wetNote = data.wetlandPct > 10
    ? `Wetland coverage of ${data.wetlandPct}% requires setback review.`
    : data.wetlandPct > 0
      ? `Minor wetland coverage of ${data.wetlandPct}% \u2014 primary viable zones are unaffected.`
      : 'No wetland overlap detected.';
  return `This ${data.acreage}-acre ${data.county} County parcel contains ${viableCount} viable soil zone${viableCount !== 1 ? 's' : ''}, with a best zone score of ${data.bestZoneScore} out of 100. The highest-scoring area is ${topName}. ${floodNote} ${wetNote}`;
}

// ── Map slot ──────────────────────────────────────────────────────────────────

function buildMapSlot(base64: string | null, address: string): string {
  const imgContent = base64
    ? `<img src="${base64}" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;border-radius:12px" alt="Parcel map" />`
    : `<div class="ms-icon"><svg viewBox="0 0 36 36" fill="none"><rect width="36" height="36" rx="8" fill="#22C55E" fill-opacity="0.3"/><path d="M18 8L28 13V23L18 28L8 23V13L18 8Z" stroke="#16a34a" stroke-width="1.5"/><circle cx="18" cy="18" r="3" fill="#16a34a" fill-opacity="0.7"/></svg></div>
      <div class="ms-lbl">Parcel Map &amp; Soil Zones</div>
      <div class="ms-sub">Map image not available</div>`;
  return `<div class="map-slot" id="parcel-map-slot">
      ${imgContent}
      <div class="map-badge">${address}</div>
    </div>`;
}

// ── Risk card helpers ─────────────────────────────────────────────────────────

function floodRiskCard(data: ReportData): string {
  const pct = data.floodPct;
  const zone = data.floodZone || 'None';
  const isGood = pct < 5;
  const barClass = isGood ? 'rcb-g' : 'rcb-a';
  const dotClass = isGood ? 'rcd-g' : 'rcd-a';
  const metricClass = isGood ? 'rcm-g' : 'rcm-a';
  const verdictClass = isGood ? 'rcv-g' : 'rcv-a';
  const verdictText = isGood ? '\u2713 No restrictions apply' : `\u26a0 Zone ${zone} \u2014 review permit requirements`;
  const bodyText = isGood
    ? `<b>No flood zone exposure.</b> This parcel falls entirely outside any FEMA Special Flood Hazard Area \u2014 the best possible result. Flood zones make septic permitting dramatically harder and more expensive. This parcel has none of those complications.`
    : `<b>${pct.toFixed(0)}% of this parcel is within FEMA Zone ${zone}.</b> Flood zones make septic permitting harder and more expensive. Engineering review required and system placement should avoid flood-affected areas.`;
  return `
      <div class="risk-card">
        <div class="rc-bar ${barClass}"></div>
        <div class="rc-inner">
          <div class="rc-top"><div class="rc-tl"><div class="rc-dot ${dotClass}"></div><div class="rc-title">FEMA Flood Zone</div></div><div class="rc-metric ${metricClass}">${pct.toFixed(0)}%</div></div>
          <div class="rc-body">${bodyText}</div>
          <div class="rc-verdict ${verdictClass}">${verdictText}</div>
        </div>
      </div>`;
}

function wetlandRiskCard(data: ReportData): string {
  const pct = data.wetlandPct;
  const isGood = pct < 5;
  const barClass = isGood ? 'rcb-g' : 'rcb-a';
  const dotClass = isGood ? 'rcd-g' : 'rcd-a';
  const metricClass = isGood ? 'rcm-g' : 'rcm-a';
  const verdictClass = isGood ? 'rcv-g' : 'rcv-a';
  const verdictText = isGood ? '\u2713 Minimal wetland presence' : '\u26a0 Minor \u2014 setback review recommended';
  const bodyText = isGood
    ? `<b>Minimal wetland presence.</b> No significant NWI-mapped wetland boundaries overlap primary viable zones. Standard permitting process likely applies.`
    : `<b>Wetland coverage of ${pct.toFixed(0)}%.</b> NC requires a 50-foot setback from wetlands. Review which zones are affected before planning perc test placement.`;
  return `
      <div class="risk-card">
        <div class="rc-bar ${barClass}"></div>
        <div class="rc-inner">
          <div class="rc-top"><div class="rc-tl"><div class="rc-dot ${dotClass}"></div><div class="rc-title">Wetland Presence</div></div><div class="rc-metric ${metricClass}">${pct.toFixed(0)}%</div></div>
          <div class="rc-body">${bodyText}</div>
          <div class="rc-verdict ${verdictClass}">${verdictText}</div>
        </div>
      </div>`;
}

function systemTypeCard(data: ReportData): string {
  const score = data.bestZoneScore;
  const isGood = score >= 70;
  const barClass = isGood ? 'rcb-g' : 'rcb-a';
  const dotClass = isGood ? 'rcd-g' : 'rcd-a';
  const metricClass = isGood ? 'rcm-g' : 'rcm-a';
  const verdictClass = isGood ? 'rcv-g' : 'rcv-a';
  const metricText = isGood ? 'Conv.' : 'Eng.';
  const bodyText = isGood
    ? `<b>Conventional system appears likely.</b> The top zone profile aligns with NC criteria for Type I or Type II conventional septic. Engineering alternatives are not anticipated for the best zones.`
    : `<b>Engineered alternative may be required.</b> Best zone score of ${score} suggests that a conventional system may not be sufficient. A licensed evaluation will determine the appropriate system type.`;
  const verdictText = isGood ? '\u2713 Likely qualifies for conventional system' : '\u26a0 Engineering alternative may be needed';
  return `
      <div class="risk-card">
        <div class="rc-bar ${barClass}"></div>
        <div class="rc-inner">
          <div class="rc-top"><div class="rc-tl"><div class="rc-dot ${dotClass}"></div><div class="rc-title">Likely System Type</div></div><div class="rc-metric ${metricClass}">${metricText}</div></div>
          <div class="rc-body">${bodyText}</div>
          <div class="rc-verdict ${verdictClass}">${verdictText}</div>
        </div>
      </div>`;
}

// ── CSS string ────────────────────────────────────────────────────────────────

const CSS = `
*{box-sizing:border-box;margin:0;padding:0}

:root{
  --g:#22C55E;
  --g-dark:#16a34a;
  --g-deeper:#14532d;
  --g-bg:rgba(34,197,94,0.07);
  --g-border:rgba(34,197,94,0.2);
  --amber:#FF9F09;
  --amber-bg:rgba(255,159,9,0.09);
  --amber-border:rgba(255,159,9,0.25);
  --red:#FF4539;
  --red-bg:rgba(255,69,57,0.08);
  --red-border:rgba(255,69,57,0.22);
  --ink:#0a0f1e;
  --ink2:#1e293b;
  --ink3:#334155;
  --slate:#64748b;
  --rule:rgba(15,23,42,0.08);
  --surface:rgba(241,245,249,0.7);
  --glass:rgba(255,255,255,0.6);
  --glass-border:rgba(15,23,42,0.09);
  --page-w:816px;
  --page-h:1056px;
  --r:14px;
  --r-sm:9px;
  --r-xs:6px;
}

body{
  background:#c8cfd8;
  font-family:'Inter',-apple-system,BlinkMacSystemFont,system-ui,sans-serif;
  color:var(--ink);
  -webkit-font-smoothing:antialiased;
  -webkit-print-color-adjust:exact;
  print-color-adjust:exact;
}

.page{
  width:var(--page-w);
  min-height:var(--page-h);
  background:#fff;
  margin:24px auto;
  position:relative;overflow:hidden;
  page-break-after:always;
  box-shadow:0 8px 40px rgba(0,0,0,0.14);
}

.cover{display:flex;flex-direction:column;background:#fff}

.cov-nav{
  padding:26px 52px;
  display:flex;justify-content:space-between;align-items:center;
  border-bottom:1px solid var(--rule);
}
.wm{display:flex;align-items:center;gap:9px}
.wm-box{
  width:28px;height:28px;background:var(--g);
  border-radius:7px;display:flex;align-items:center;justify-content:center;
}
.wm-box svg{width:13px;height:13px;fill:none;stroke:#fff;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.wm-name{font-size:15px;font-weight:900;letter-spacing:-0.03em;color:var(--ink)}
.cov-doc{font-size:15px;font-weight:400;color:var(--slate);letter-spacing:0.03em}

.cov-hero{
  padding:44px 52px 36px;
  position:relative;
}
.cov-hero::before{
  content:'';position:absolute;
  top:-60px;right:-60px;
  width:320px;height:320px;border-radius:50%;
  background:radial-gradient(circle, rgba(34,197,94,0.12) 0%, transparent 65%);
  pointer-events:none;
}

.cov-eyebrow{
  display:inline-flex;align-items:center;gap:7px;
  margin-bottom:18px;
}
.cov-dot{width:7px;height:7px;border-radius:50%;background:var(--g)}
.cov-eyebrow-text{font-size:15px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:var(--g)}

.cov-headline{
  font-size:54px;font-weight:900;letter-spacing:-0.04em;
  line-height:1.0;color:var(--ink);margin-bottom:10px;
}
.cov-headline em{font-style:normal;color:var(--g)}

.cov-sub{
  font-size:16px;font-weight:400;color:var(--slate);
  letter-spacing:-0.01em;margin-bottom:36px;line-height:1.5;
}

.cov-scores{
  display:grid;grid-template-columns:repeat(3,1fr);
  gap:12px;margin-bottom:32px;
}
.sc-card{
  background:var(--surface);
  border:1px solid var(--glass-border);
  border-radius:var(--r);
  padding:18px 16px 16px;
  display:flex;flex-direction:column;align-items:center;
  gap:10px;
}
.gauge-wrap{position:relative;width:96px;height:96px;flex-shrink:0}
.gauge-wrap svg{width:96px;height:96px;transform:rotate(-90deg)}
.gauge-track{fill:none;stroke:rgba(15,23,42,0.07);stroke-width:7;stroke-linecap:round}
.gauge-fill{fill:none;stroke-width:7;stroke-linecap:round}
.gauge-center{
  position:absolute;inset:0;
  display:flex;flex-direction:column;align-items:center;justify-content:center;
}
.gauge-num{font-size:30px;font-weight:900;letter-spacing:-0.05em;line-height:1}
.gauge-num-g{color:var(--g)}
.gauge-num-a{color:#FF9F09}
.gauge-num-s{color:var(--ink2)}
.sc-label{font-size:15px;font-weight:600;color:var(--ink3);text-align:center;letter-spacing:0.01em}
.sc-sub{font-size:14px;font-weight:400;color:var(--slate);text-align:center;margin-top:-4px}

.cov-property{
  padding:0 52px;margin-bottom:24px;
  display:flex;justify-content:space-between;align-items:flex-start;
  padding-top:0;
}
.cp-addr{font-size:21px;font-weight:900;letter-spacing:-0.03em;color:var(--ink);margin-bottom:5px;line-height:1.1}
.cp-meta{font-size:14px;font-weight:400;color:var(--slate)}
.cp-right{display:flex;flex-direction:column;align-items:flex-end;gap:6px}
.verdict-pill{
  display:inline-flex;align-items:center;gap:7px;
  padding:7px 16px;
  border-radius:20px;
}
.vp-dot{width:6px;height:6px;border-radius:50%}
.vp-txt{font-size:14px;font-weight:700}
.cp-date{font-size:15px;font-weight:400;color:var(--slate)}

.cov-verdict{padding:0 52px;margin-bottom:24px}
.cv-inner{
  background:var(--surface);
  border:1px solid var(--glass-border);
  border-left:3px solid var(--g);
  border-radius:0 var(--r) var(--r) 0;
  padding:16px 22px;
}
.cv-lbl{font-size:15px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:var(--g);margin-bottom:6px}
.cv-txt{font-size:15px;font-weight:400;line-height:1.7;color:var(--ink3)}
.cv-txt strong{font-weight:700;color:var(--ink)}

.cov-chips{padding:0 52px;display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.chip-lbl{font-size:14px;font-weight:600;color:var(--slate);text-transform:uppercase;letter-spacing:0.06em}
.chip{
  display:inline-flex;align-items:center;gap:5px;
  padding:4px 10px;
  background:var(--surface);border:1px solid var(--glass-border);
  border-radius:20px;font-size:14px;font-weight:500;color:var(--ink3);
}
.chip-dot{width:5px;height:5px;border-radius:50%;background:var(--g)}

.cov-foot{
  margin-top:auto;padding:14px 52px 20px;
  display:flex;justify-content:space-between;align-items:center;
  border-top:1px solid var(--rule);
}
.cov-foot span{font-size:14px;font-weight:400;color:#94a3b8;letter-spacing:0.01em}

.pg{display:flex;flex-direction:column;min-height:var(--page-h)}
.pg-hdr{
  padding:26px 52px 0;
  display:flex;justify-content:space-between;align-items:flex-start;
  flex-shrink:0;
}
.pg-sec{font-size:14px;font-weight:700;letter-spacing:0.09em;text-transform:uppercase;color:var(--g);margin-bottom:4px}
.pg-title{font-size:22px;font-weight:900;letter-spacing:-0.03em;color:var(--ink)}
.pg-hdr-r{display:flex;flex-direction:column;align-items:flex-end;gap:3px;padding-top:2px}
.pg-wm{display:flex;align-items:center;gap:6px}
.pg-wm-box{width:17px;height:17px;background:var(--g);border-radius:4px;display:flex;align-items:center;justify-content:center}
.pg-wm-box svg{width:8px;height:8px;fill:none;stroke:#fff;stroke-width:2;stroke-linecap:round}
.pg-wm-name{font-size:15px;font-weight:900;letter-spacing:-0.02em;color:var(--ink)}
.pg-prop{font-size:14px;font-weight:400;color:var(--slate)}
.pg-rule{height:1px;background:var(--rule);margin:16px 52px 0;flex-shrink:0}
.pg-body{flex:1;padding:20px 52px;overflow:visible}
.pg-foot{
  padding:10px 52px 18px;
  display:flex;justify-content:space-between;align-items:center;
  flex-shrink:0;border-top:1px solid var(--rule);
}
.pg-foot span{font-size:14px;font-weight:400;color:#94a3b8}

.pg-intro{font-size:14px;font-weight:400;line-height:1.7;color:var(--slate);margin-bottom:16px;max-width:640px}

.zone-card{
  background:var(--surface);
  border:1px solid var(--glass-border);
  border-radius:var(--r);
  margin-bottom:11px;overflow:hidden;
}

.zc-head{
  display:flex;align-items:center;gap:11px;
  padding:11px 18px;
  background:rgba(15,23,42,0.03);
  border-bottom:1px solid var(--rule);
}
.zc-badge{
  width:22px;height:22px;border-radius:50%;
  display:flex;align-items:center;justify-content:center;
  font-size:14px;font-weight:900;flex-shrink:0;
}
.zb-1{background:var(--ink);color:#fff}
.zb-2{background:var(--ink3);color:#fff}
.zb-3{background:#94a3b8;color:var(--ink)}
.zc-ng{flex:1}
.zc-name{font-size:15px;font-weight:700;letter-spacing:-0.02em;color:var(--ink)}
.zc-series{font-size:14px;font-weight:400;color:var(--slate);margin-top:1px}

.sc-chip{
  padding:3px 11px;border-radius:20px;
  font-size:15px;font-weight:700;letter-spacing:-0.01em;
}
.scc-g{background:var(--g-bg);color:var(--g);border:1px solid var(--g-border)}
.scc-a{background:var(--amber-bg);color:#FF9F09;border:1px solid var(--amber-border)}
.zc-v{font-size:14px;font-weight:500;color:var(--slate);margin-left:2px}

.zc-body{display:grid;grid-template-columns:210px 1px 1fr}
.zc-factors{padding:14px 20px}
.frow{margin-bottom:11px}
.frow:last-child{margin-bottom:0}
.ft{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px}
.fn{font-size:15px;font-weight:500;color:var(--slate)}
.fv{font-size:14px;font-weight:700;color:var(--ink)}
.fbar{height:7px;background:rgba(15,23,42,0.07);border-radius:4px;overflow:hidden}
.ff{height:7px;border-radius:4px}
.ff-g{background:var(--g)}
.ff-a{background:#FF9F09}
.ff-r{background:var(--red)}

.zc-sep{background:var(--rule)}
.zc-ins{padding:12px 18px;display:flex;flex-direction:column;gap:8px}
.ins{display:flex;gap:8px;align-items:flex-start}
.ins-tag{
  flex-shrink:0;padding:2px 7px;border-radius:var(--r-xs);
  font-size:15px;font-weight:700;letter-spacing:0.04em;text-transform:uppercase;margin-top:1px;
}
.it-g{background:var(--g-bg);color:var(--g)}
.it-a{background:var(--amber-bg);color:#FF9F09}
.ins-txt{font-size:15px;font-weight:400;line-height:1.55;color:var(--ink3)}
.ins-txt b{font-weight:700;color:var(--ink)}

.zc-stats{display:grid;grid-template-columns:repeat(3,1fr);border-top:1px solid var(--rule)}
.zc-stat{padding:8px 18px;border-right:1px solid var(--rule)}
.zc-stat:last-child{border-right:none}
.zsl{font-size:15px;font-weight:600;color:var(--slate);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:2px}
.zsv{font-size:15px;font-weight:900;letter-spacing:-0.02em;color:var(--ink)}
.zsv-g{color:var(--g)}
.zsv-a{color:#FF9F09}

.risk-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px}

.risk-card{
  background:var(--surface);
  border:1px solid var(--glass-border);
  border-radius:var(--r);
  overflow:hidden;
}
.rc-bar{height:4px}
.rcb-g{background:var(--g)}
.rcb-a{background:#FF9F09}
.rcb-n{background:var(--slate)}

.rc-inner{padding:13px 16px}
.rc-top{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}
.rc-tl{display:flex;align-items:center;gap:7px}
.rc-dot{width:7px;height:7px;border-radius:50%;flex-shrink:0}
.rcd-g{background:var(--g)}
.rcd-a{background:#FF9F09}
.rcd-n{background:var(--slate)}
.rc-title{font-size:14px;font-weight:700;color:var(--ink);letter-spacing:-0.01em}
.rc-metric{font-size:22px;font-weight:900;letter-spacing:-0.03em}
.rcm-g{color:var(--g)}
.rcm-a{color:#FF9F09}
.rcm-n{color:var(--ink3)}

.rc-body{font-size:15px;font-weight:400;line-height:1.65;color:var(--ink3)}
.rc-body b{font-weight:700;color:var(--ink)}
.rc-verdict{
  display:inline-block;margin-top:9px;
  font-size:14px;font-weight:700;
  padding:3px 9px;border-radius:var(--r-xs);
}
.rcv-g{background:var(--g-bg);color:var(--g)}
.rcv-a{background:var(--amber-bg);color:#FF9F09}
.rcv-n{background:rgba(100,116,139,0.1);color:var(--ink3)}

.data-note{
  background:var(--surface);border:1px solid var(--glass-border);
  border-radius:var(--r-sm);padding:12px 16px;margin-top:10px;
}
.dn-t{font-size:15px;font-weight:700;letter-spacing:0.09em;text-transform:uppercase;color:var(--slate);margin-bottom:5px}
.dn-b{font-size:15px;font-weight:400;line-height:1.65;color:var(--slate)}

.map-slot{
  height:222px;border-radius:var(--r);margin-bottom:16px;
  border:1.5px dashed var(--g-border);
  background:var(--g-bg);
  position:relative;display:flex;
  align-items:center;justify-content:center;flex-direction:column;gap:8px;
}
.map-slot img{
  position:absolute;inset:0;width:100%;height:100%;
  object-fit:cover;border-radius:calc(var(--r) - 2px);
}
.ms-icon{width:36px;height:36px;opacity:0.35}
.ms-icon svg{width:36px;height:36px}
.ms-lbl{font-size:15px;font-weight:700;color:var(--g);text-align:center}
.ms-sub{font-size:14px;font-weight:400;color:var(--g);opacity:0.7;text-align:center}
.map-badge{
  position:absolute;bottom:10px;right:12px;
  background:rgba(10,15,30,0.65);
  border-radius:var(--r-xs);padding:4px 10px;
  font-size:14px;font-weight:500;color:#fff;letter-spacing:0.02em;
  backdrop-filter:blur(4px);
}

.pin-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:18px}
.pin-card{
  background:var(--surface);border:1px solid var(--glass-border);
  border-radius:var(--r);overflow:hidden;
}
.pc-head{
  padding:9px 14px;
  background:rgba(15,23,42,0.04);
  border-bottom:1px solid var(--rule);
  display:flex;align-items:center;gap:8px;
}
.pc-num{
  width:20px;height:20px;border-radius:50%;
  display:flex;align-items:center;justify-content:center;
  font-size:14px;font-weight:900;color:#fff;flex-shrink:0;
}
.pn-1{background:var(--ink)}
.pn-2{background:var(--ink3)}
.pn-3{background:#94a3b8;color:var(--ink)}
.pc-lbl{font-size:15px;font-weight:700;color:var(--ink);letter-spacing:-0.01em}
.pc-body{padding:11px 14px}
.pc-row{margin-bottom:7px}
.pcrl{font-size:15px;font-weight:600;color:var(--slate);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:2px}
.pcrv{font-size:15px;font-weight:700;color:var(--ink);letter-spacing:-0.01em}
.pcrs{font-size:14px;font-weight:400;color:var(--slate)}
.conf-row{display:flex;align-items:center;gap:6px;margin-top:8px}
.cr-lbl{font-size:15px;font-weight:500;color:var(--slate);flex-shrink:0}
.cr-trk{flex:1;height:7px;background:rgba(15,23,42,0.07);border-radius:4px}
.cr-fill{height:7px;border-radius:4px}
.crf-g{background:var(--g)}
.crf-a{background:#FF9F09}
.cr-val{font-size:14px;font-weight:700}
.crv-g{color:var(--g)}
.crv-a{color:#FF9F09}

.method-lbl{font-size:15px;font-weight:700;letter-spacing:0.09em;text-transform:uppercase;color:var(--slate);margin-bottom:9px}
.method-cols{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px}
.mc{background:var(--surface);border:1px solid var(--glass-border);border-radius:var(--r-sm);padding:13px 15px}
.mc-t{
  font-size:15px;font-weight:700;color:var(--ink);margin-bottom:5px;
  display:flex;align-items:center;gap:7px;
}
.mc-t::before{content:'';width:10px;height:2px;background:var(--g);border-radius:1px}
.mc-b{font-size:14px;font-weight:400;line-height:1.7;color:var(--slate)}
.disc{background:var(--surface);border:1px solid var(--glass-border);border-radius:var(--r-sm);padding:11px 15px}
.disc-t{font-size:15px;font-weight:700;letter-spacing:0.09em;text-transform:uppercase;color:var(--slate);margin-bottom:4px}
.disc-b{font-size:14px;font-weight:400;line-height:1.7;color:var(--slate)}

@media print {
  body{background:#fff}
  .page{
    box-shadow:none;
    margin:0;
    width:100%;
    min-height:auto;
    page-break-after:always;
    break-after:page;
  }
  .page:last-child{
    page-break-after:auto;
    break-after:auto;
  }
  .zone-card,
  .risk-card,
  .pin-card,
  .disc,
  .data-note,
  .mc,
  .method-cols{
    page-break-inside:avoid;
    break-inside:avoid;
  }
  .pg-hdr{
    page-break-after:avoid;
    break-after:avoid;
  }
  .dl-bar{display:none!important}
}

.dl-bar{
  position:fixed;bottom:0;left:0;right:0;z-index:9999;
  background:rgba(10,15,30,0.94);
  backdrop-filter:blur(14px);
  border-top:1px solid rgba(34,197,94,0.2);
  padding:12px 28px;
  display:flex;align-items:center;justify-content:space-between;gap:16px;
}
.dl-info{font-size:12px;color:rgba(255,255,255,0.45);letter-spacing:0.01em;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.dl-info strong{color:rgba(255,255,255,0.82);font-weight:600}
.dl-actions{display:flex;align-items:center;gap:8px;flex-shrink:0}
.dl-btn{
  display:inline-flex;align-items:center;gap:7px;
  padding:8px 18px;border-radius:8px;
  font-family:inherit;font-size:13px;font-weight:700;letter-spacing:0.01em;
  cursor:pointer;border:none;text-decoration:none;transition:opacity 0.15s;
  white-space:nowrap;
}
.dl-btn:hover{opacity:0.85}
.dl-btn-primary{background:#22C55E;color:#fff}
.dl-btn-ghost{background:rgba(255,255,255,0.07);color:rgba(255,255,255,0.6);border:1px solid rgba(255,255,255,0.14)!important}
.dl-copied{display:none}
`;

// ── Main HTML generator ───────────────────────────────────────────────────────

export function generateReportHTML(data: ReportData, meta?: { shareUrl?: string; filename?: string }): string {
  const circumference = 251.3;

  const bestColor = scoreColor(data.bestZoneScore);
  const bestFill = (Math.min(100, Math.max(0, data.bestZoneScore)) / 100) * circumference;
  const bestNumClass = data.bestZoneScore > 65 ? 'gauge-num-g' : data.bestZoneScore >= 35 ? 'gauge-num-a' : 'gauge-num-s';

  const parcelColor = scoreColor(data.parcelScore);
  const parcelFill = (Math.min(100, Math.max(0, data.parcelScore)) / 100) * circumference;
  const parcelNumClass = data.parcelScore > 65 ? 'gauge-num-g' : data.parcelScore >= 35 ? 'gauge-num-a' : 'gauge-num-s';

  const wetColor = wetlandGaugeColor(data.wetlandPct);
  const wetFill = (Math.min(100, data.wetlandPct) / 100) * circumference;

  const assessmentText = buildAssessmentText(data);
  const mapSlotHtml = buildMapSlot(data.mapImageBase64, data.address);
  const seriesRows = buildSeriesRows(data.soilSeries);
  const zoneCardsHtml = buildZoneCards(data.topZones);
  const pinCardsHtml = buildPinCards(data.percPins);

  const footerAddr = `${data.address}, ${data.county} ${data.state}`;

  const verdictScore = data.bestZoneScore;
  const verdictBgColor = verdictScore >= 65 ? '#22C55E' : verdictScore >= 35 ? '#FF9F09' : '#FF4539';
  const verdictBg = `background:${verdictBgColor};border:1px solid ${verdictBgColor}`;

  const bestSubLabel = data.bestZoneScore >= 65 ? 'Viable' : data.bestZoneScore >= 35 ? 'Engineering Needed' : 'Not Suitable';

  const shareUrl = meta?.shareUrl ?? '';
  const filename = meta?.filename ?? 'PercIQ-report.pdf';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>PercIQ \u2014 Soil Suitability Report</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;900&display=swap" rel="stylesheet">
<style>${CSS}</style>
</head>
<body>

<!-- ======= COVER ======= -->
<div class="page cover">

  <div class="cov-nav">
    <div class="wm">
      <div class="wm-box"><svg viewBox="0 0 14 14"><circle cx="7" cy="7" r="2.5"/><line x1="7" y1="1" x2="7" y2="3.5"/><line x1="7" y1="10.5" x2="7" y2="13"/><line x1="1" y1="7" x2="3.5" y2="7"/><line x1="10.5" y1="7" x2="13" y2="7"/></svg></div>
      <span class="wm-name">PercIQ</span>
    </div>
    <span class="cov-doc">Soil Suitability Report &nbsp;\u00b7&nbsp; Confidential</span>
  </div>

  <div class="cov-hero">
    <div class="cov-eyebrow">
      <div class="cov-dot"></div>
      <span class="cov-eyebrow-text">Pre-Screening Analysis</span>
    </div>
    <h1 class="cov-headline">Know before<br><em>you test.</em></h1>
    <p class="cov-sub">Septic system site intelligence for land professionals.</p>

    <div class="cov-scores">

      <div class="sc-card">
        <div class="gauge-wrap">
          <svg viewBox="0 0 96 96" xmlns="http://www.w3.org/2000/svg">
            <circle class="gauge-track" cx="48" cy="48" r="40" stroke-dasharray="251.3" stroke-dashoffset="0"/>
            <circle class="gauge-fill" cx="48" cy="48" r="40" stroke="${bestColor}"
              stroke-dasharray="${bestFill.toFixed(1)} 251.3" stroke-dashoffset="0"/>
          </svg>
          <div class="gauge-center">
            <div class="gauge-num ${bestNumClass}">${data.bestZoneScore}</div>
          </div>
        </div>
        <div class="sc-label">Best Zone Score</div>
        <div class="sc-sub">${bestSubLabel}</div>
      </div>

      <div class="sc-card">
        <div class="gauge-wrap">
          <svg viewBox="0 0 96 96" xmlns="http://www.w3.org/2000/svg">
            <circle class="gauge-track" cx="48" cy="48" r="40" stroke-dasharray="251.3" stroke-dashoffset="0"/>
            <circle class="gauge-fill" cx="48" cy="48" r="40" stroke="${parcelColor}"
              stroke-dasharray="${parcelFill.toFixed(1)} 251.3" stroke-dashoffset="0"/>
          </svg>
          <div class="gauge-center">
            <div class="gauge-num ${parcelNumClass}">${data.parcelScore}</div>
          </div>
        </div>
        <div class="sc-label">Parcel Overall</div>
        <div class="sc-sub">Area-weighted avg</div>
      </div>

      <div class="sc-card">
        <div class="gauge-wrap">
          <svg viewBox="0 0 96 96" xmlns="http://www.w3.org/2000/svg">
            <circle class="gauge-track" cx="48" cy="48" r="40" stroke-dasharray="251.3" stroke-dashoffset="0"/>
            <circle class="gauge-fill" cx="48" cy="48" r="40" stroke="${wetColor}"
              stroke-dasharray="${wetFill.toFixed(1)} 251.3" stroke-dashoffset="0"/>
          </svg>
          <div class="gauge-center">
            <div class="gauge-num gauge-num-s">${data.wetlandPct}%</div>
          </div>
        </div>
        <div class="sc-label">Wetland Coverage</div>
        <div class="sc-sub">${data.floodPct === 0 ? '0% flood zone' : data.floodPct + '% flood zone'}</div>
      </div>

    </div>
  </div>

  <div class="cov-property">
    <div>
      <div class="cp-addr">${data.address}</div>
      <div class="cp-meta">${data.county}, ${data.state} &nbsp;\u00b7&nbsp; ${data.acreage} acres${data.owner ? ` &nbsp;\u00b7&nbsp; Owner: ${data.owner}` : ''}</div>
    </div>
    <div class="cp-right">
      <div class="verdict-pill" style="${verdictBg}"><span class="vp-txt" style="color:#fff">${data.verdict}</span></div>
      <span class="cp-date">${data.generatedDate}</span>
    </div>
  </div>

  <div class="cov-verdict">
    <div class="cv-inner">
      <div class="cv-lbl">Overall Assessment</div>
      <div class="cv-txt">${assessmentText}</div>
    </div>
  </div>

  <div class="cov-chips" style="margin-top:20px">
    <span class="chip-lbl">Data</span>
    <div class="chip"><div class="chip-dot"></div>USDA SSURGO</div>
    <div class="chip"><div class="chip-dot"></div>FEMA NFHL</div>
    <div class="chip"><div class="chip-dot"></div>USFWS NWI</div>
    <div class="chip"><div class="chip-dot"></div>Regrid Parcels</div>
  </div>

  <div class="cov-foot">
    <span>perciq.com &nbsp;\u00b7&nbsp; Lumi\u00e8re Holdings LLC</span>
    <span>Directional pre-screen only \u2014 not a permit guarantee</span>
  </div>

</div>

<!-- ======= PAGE 2 \u2014 ZONES ======= -->
<div class="page"><div class="pg">
  <div class="pg-hdr">
    <div><div class="pg-sec">Section 01</div><h2 class="pg-title">Soil Zone Breakdown</h2></div>
    <div class="pg-hdr-r">
      <div class="pg-wm"><div class="pg-wm-box"><svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="2"/><line x1="5" y1="1" x2="5" y2="2.5"/><line x1="5" y1="7.5" x2="5" y2="9"/><line x1="1" y1="5" x2="2.5" y2="5"/><line x1="7.5" y1="5" x2="9" y2="5"/></svg></div><span class="pg-wm-name">PercIQ</span></div>
      <div class="pg-prop">${data.address} \u00b7 ${data.county}, ${data.state}</div>
    </div>
  </div>
  <div class="pg-rule"></div>
  <div class="pg-body">

    <div style="margin-bottom:18px">
      <div style="font-size:15px;font-weight:700;letter-spacing:0.09em;text-transform:uppercase;color:var(--slate);margin-bottom:9px">Soil Series on This Parcel</div>
      <p style="font-size:14px;font-weight:400;line-height:1.65;color:var(--slate);margin-bottom:11px;max-width:640px">${data.soilSeries.length} soil series identified across this ${data.acreage}-acre parcel. Each slope class is scored separately as an individual zone.</p>

      <div style="border:1px solid var(--glass-border);border-radius:var(--r);overflow:hidden;background:var(--surface)">
        ${seriesRows}
      </div>
    </div>

    <div style="font-size:15px;font-weight:700;letter-spacing:0.09em;text-transform:uppercase;color:var(--slate);margin-bottom:9px">Top Zones by Score \u2014 Where to Test First</div>
    ${zoneCardsHtml}

  </div>
  <div class="pg-foot"><span>${footerAddr}</span><span>perciq.com</span><span>Page 2 of 4 \u00b7 ${data.generatedDate}</span></div>
</div></div>

<!-- ======= PAGE 3 \u2014 RISK ======= -->
<div class="page"><div class="pg">
  <div class="pg-hdr">
    <div><div class="pg-sec">Section 02</div><h2 class="pg-title">Site Risk Summary</h2></div>
    <div class="pg-hdr-r">
      <div class="pg-wm"><div class="pg-wm-box"><svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="2"/><line x1="5" y1="1" x2="5" y2="2.5"/><line x1="5" y1="7.5" x2="5" y2="9"/><line x1="1" y1="5" x2="2.5" y2="5"/><line x1="7.5" y1="5" x2="9" y2="5"/></svg></div><span class="pg-wm-name">PercIQ</span></div>
      <div class="pg-prop">${data.address} \u00b7 ${data.county}, ${data.state}</div>
    </div>
  </div>
  <div class="pg-rule"></div>
  <div class="pg-body">
    <p class="pg-intro">Four risk factors determine whether a septic permit can realistically be obtained. Each one is translated from technical regulatory language into plain English \u2014 what it actually means for this property.</p>

    <div class="risk-grid">
      ${floodRiskCard(data)}
      ${wetlandRiskCard(data)}
    </div>

    <div class="risk-grid">
      <div class="risk-card">
        <div class="rc-bar ${data.bestZoneScore >= 45 ? 'rcb-g' : 'rcb-a'}"></div>
        <div class="rc-inner">
          <div class="rc-top"><div class="rc-tl"><div class="rc-dot ${data.bestZoneScore >= 45 ? 'rcd-g' : 'rcd-a'}"></div><div class="rc-title">Slope Conditions</div></div><div class="rc-metric ${data.bestZoneScore >= 70 ? 'rcm-g' : 'rcm-a'}">${data.bestZoneScore >= 70 ? 'Good' : 'Mod.'}</div></div>
          <div class="rc-body"><b>${data.bestZoneScore >= 70 ? 'Best zones have favorable slope.' : 'Slope conditions may be a factor.'}</b> The scored zones show gradients evaluated for NC Environmental Health approval. Slopes above 15% require engineered alternatives that add cost and time.</div>
          <div class="rc-verdict ${data.bestZoneScore >= 70 ? 'rcv-g' : 'rcv-a'}">${data.bestZoneScore >= 70 ? '\u2713 Within standard approval range' : '\u26a0 Verify slope during site evaluation'}</div>
        </div>
      </div>
      <div class="risk-card">
        <div class="rc-bar rcb-a"></div>
        <div class="rc-inner">
          <div class="rc-top"><div class="rc-tl"><div class="rc-dot rcd-a"></div><div class="rc-title">Seasonal Water Table</div></div><div class="rc-metric rcm-a">Mod.</div></div>
          <div class="rc-body"><b>Seasonal high water table present.</b> Most soil series in this region show moderate seasonal saturation. Most conventional systems handle this with adequate elevation. The Health Department will verify depth during the required site evaluation.</div>
          <div class="rc-verdict rcv-a">\u26a0 Verify depth during site evaluation</div>
        </div>
      </div>
    </div>

    <div class="risk-grid">
      <div class="risk-card">
        <div class="rc-bar rcb-n"></div>
        <div class="rc-inner">
          <div class="rc-top"><div class="rc-tl"><div class="rc-dot rcd-n"></div><div class="rc-title">${data.county} County Rules</div></div><div class="rc-metric rcm-n">Review</div></div>
          <div class="rc-body">${data.county} County follows NC DENR Rule 15A NCAC 18A .1900. A licensed soil scientist must complete a site evaluation before any permit is issued. Typical timeline: 4\u20138 weeks. No local perc test history is currently in the PercIQ database for this area.</div>
          <div class="rc-verdict rcv-n">\u2192 Local history not yet available</div>
        </div>
      </div>
      ${systemTypeCard(data)}
    </div>

    <div class="data-note">
      <div class="dn-t">Data Confidence</div>
      <div class="dn-b">This analysis is Tier 1 \u2014 based on USDA SSURGO federal soil survey data only. No local ${data.county} County Environmental Health perc test records are currently in the PercIQ database for this area. Scores are directional indicators. A licensed site evaluation is required before any permit application.</div>
    </div>
  </div>
  <div class="pg-foot"><span>${footerAddr}</span><span>perciq.com</span><span>Page 3 of 4 \u00b7 ${data.generatedDate}</span></div>
</div></div>

<!-- ======= PAGE 4 \u2014 SITES + METHOD ======= -->
<div class="page"><div class="pg">
  <div class="pg-hdr">
    <div><div class="pg-sec">Section 03</div><h2 class="pg-title">Recommended Test Sites</h2></div>
    <div class="pg-hdr-r">
      <div class="pg-wm"><div class="pg-wm-box"><svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="2"/><line x1="5" y1="1" x2="5" y2="2.5"/><line x1="5" y1="7.5" x2="5" y2="9"/><line x1="1" y1="5" x2="2.5" y2="5"/><line x1="7.5" y1="5" x2="9" y2="5"/></svg></div><span class="pg-wm-name">PercIQ</span></div>
      <div class="pg-prop">${data.address} \u00b7 ${data.county}, ${data.state}</div>
    </div>
  </div>
  <div class="pg-rule"></div>
  <div class="pg-body">
    <p class="pg-intro" style="margin-bottom:14px">Optimal starting points for a licensed soil scientist \u2014 selected to maximize distance from property edges, flood zones, and wetland boundaries while staying within the highest-scoring soil zones.</p>

    ${mapSlotHtml}

    <div class="pin-grid">
      ${pinCardsHtml}
    </div>

    <div class="method-lbl">Methodology</div>
    <div class="method-cols">
      <div class="mc"><div class="mc-t">Data Sources</div><div class="mc-b">Soil data from USDA SSURGO via Soil Data Access API. Flood zones from FEMA National Flood Hazard Layer. Wetland boundaries from USFWS National Wetlands Inventory. Parcel boundaries from Regrid national parcel database.</div></div>
      <div class="mc"><div class="mc-t">Score Calculation</div><div class="mc-b">Each soil unit is scored on drainage class (25%), hydraulic conductivity (25%), slope (25%), and water table depth (25%). Base score adjusted for flood overlap (up to \u201335%) and wetland overlap (up to \u201314%). Viable = 65+, Engineering Needed = 35\u201364, Not Suitable = &lt;35.</div></div>
    </div>

    <div class="disc">
      <div class="disc-t">Important Disclaimer</div>
      <div class="disc-b">This PercIQ report is generated from federal and public-domain geographic data and is a directional pre-screening tool only. It does not constitute a site evaluation, professional engineering assessment, or guarantee of septic permit approval. Actual on-site conditions can vary significantly from SSURGO predictions. A licensed site evaluation is required before any permit application. PercIQ and Lumi\u00e8re Holdings LLC make no warranties regarding permit outcomes. Report generated ${data.generatedDate} \u00b7 perciq.com</div>
    </div>

  </div>
  <div class="pg-foot"><span>${footerAddr}</span><span>perciq.com</span><span>Page 4 of 4 \u00b7 ${data.generatedDate}</span></div>
</div></div>

<div class="dl-bar">
  <div class="dl-info"><strong>${data.address}</strong> &nbsp;&middot;&nbsp; PercIQ Soil Suitability Report &nbsp;&middot;&nbsp; ${data.generatedDate}</div>
  <div class="dl-actions">
    ${shareUrl ? '<button class="dl-btn dl-btn-ghost" id="share-btn"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg> Share</button>' : ''}
    <button class="dl-btn dl-btn-primary" id="dl-btn"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> <span id="dl-label">Save as PDF</span></button>
  </div>
</div>

<script>
(function() {
  var shareUrl = ${JSON.stringify(shareUrl)};
  var filename = ${JSON.stringify(filename)};

  var shareBtn = document.getElementById('share-btn');
  if (shareBtn && shareUrl) {
    shareBtn.addEventListener('click', function() {
      navigator.clipboard.writeText(shareUrl).then(function() {
        shareBtn.textContent = 'Copied!';
        setTimeout(function() {
          shareBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg> Share';
        }, 2000);
      });
    });
  }

  var dlBtn = document.getElementById('dl-btn');
  var dlLabel = document.getElementById('dl-label');
  if (dlBtn && dlLabel) {
    dlBtn.addEventListener('click', function() {
      if (dlBtn.disabled) return;
      dlBtn.disabled = true;
      dlLabel.textContent = 'Building PDF\u2026';

      Promise.all([
        loadScript('https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js'),
        loadScript('https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js')
      ]).then(function() {
        var pages = Array.from(document.querySelectorAll('.page'));
        var pdfW = 816, pdfH = 1056;
        var jsPDFLib = window.jspdf || window.jsPDF;
        var pdf = new jsPDFLib.jsPDF({ unit: 'px', format: [pdfW, pdfH], compress: true });
        var chain = Promise.resolve();
        pages.forEach(function(page, i) {
          chain = chain.then(function() {
            return html2canvas(page, {
              scale: 2, useCORS: true, allowTaint: true,
              backgroundColor: '#ffffff',
              width: pdfW, height: pdfH,
              windowWidth: pdfW, windowHeight: pdfH,
            });
          }).then(function(canvas) {
            var imgData = canvas.toDataURL('image/jpeg', 0.92);
            if (i > 0) pdf.addPage([pdfW, pdfH], 'portrait');
            pdf.addImage(imgData, 'JPEG', 0, 0, pdfW, pdfH, undefined, 'FAST');
          });
        });
        return chain.then(function() {
          pdf.save(filename);
          dlLabel.textContent = 'Save as PDF';
          dlBtn.disabled = false;
        });
      }).catch(function(err) {
        console.error('PDF generation failed', err);
        dlLabel.textContent = 'Save as PDF';
        dlBtn.disabled = false;
        window.print();
      });
    });
  }

  function loadScript(src) {
    return new Promise(function(resolve, reject) {
      if (document.querySelector('script[src="' + src + '"]')) { resolve(); return; }
      var s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = reject;
      document.head.appendChild(s);
    });
  }
})();
</script>

</body>
</html>`;
}

// ── buildSeriesSummary helper (used in ReportDetail) ──────────────────────────

export interface RawPolygonProps {
  muname?: string;
  musym?: string;
  drainagecl?: string;
  drain?: string;
  drainageclass?: string;
  ksat_r?: number | string;
  ksat_h?: number | string;
  suitabilityScore?: number;
  bucket?: string;
  [key: string]: unknown;
}

export function buildSeriesSummary(polygons: Array<{ mukey: string; geojson: { properties: RawPolygonProps }; bucket: string; result: { map_unit_name?: string | null; map_unit_key?: string | null; drainage_class?: string | null; ksat_high?: number | null } | null }>): SeriesData[] {
  const seriesMap = new Map<string, SeriesData>();
  for (const poly of polygons) {
    const props = poly.geojson.properties;
    const muname = (props.muname ?? poly.result?.map_unit_name ?? 'Unknown') as string;
    const musym = (props.musym ?? poly.result?.map_unit_key ?? '') as string;
    const drainage = (props.drainagecl ?? props.drain ?? props.drainageclass ?? poly.result?.drainage_class ?? '') as string;
    const ksat = parseFloat(String(props.ksat_r || props.ksat_h || poly.result?.ksat_high || 0)) || 0;
    const score = (props.suitabilityScore as number) ?? 0;

    if (!seriesMap.has(muname)) {
      seriesMap.set(muname, {
        name: muname,
        series: musym.replace(/[A-Z]$/, ''),
        mukeys: [],
        slopeClasses: [],
        totalAcres: 0,
        drainage,
        ksat,
        bestScore: score,
        bucket: poly.bucket,
      });
    }
    const entry = seriesMap.get(muname)!;
    entry.mukeys.push(poly.mukey);
    entry.slopeClasses!.push(musym);
    entry.bestScore = Math.max(entry.bestScore, score);
  }
  return Array.from(seriesMap.values()).sort((a, b) => b.bestScore - a.bestScore);
}
