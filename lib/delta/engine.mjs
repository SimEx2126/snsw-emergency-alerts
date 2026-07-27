// Delta Engine v2 — compares two synthesized sweep results and produces structured changes
// Improvements: count metric thresholds, semantic TG dedup, configurable thresholds, null-safety

import { createHash } from 'crypto';

// ─── Default Thresholds ──────────────────────────────────────────────────────
// Override via config.delta.thresholds in crucix.config.mjs

const DEFAULT_NUMERIC_THRESHOLDS = {};

const DEFAULT_COUNT_THRESHOLDS = {
  rfs_emergency: 1,    // any change in Emergency Warning count matters
  rfs_watch_act: 1,
  rfs_total: 1,        // any new/resolved incident in region
  bom_flood: 1,
  bom_storm: 1,
  bom_other: 1,        // severe weather / fire weather / tsunami
  quake_events: 1,
  thermal_total: 10,   // ±10 satellite detections in a regional bbox is real
  news_count: 5,       // ±5 news items
  sources_ok: 2,       // with ~5 sources, single-source flapping is noise
};

// ─── Metric Definitions ──────────────────────────────────────────────────────
// `current` carries fresh synthesized data (arrays); `previous`/priorRuns carry
// compacted runs (counts). Extractors must accept both shapes.

function countOf(v) {
  return Array.isArray(v) ? v.length : (v || 0);
}

const NUMERIC_METRICS = [];

const COUNT_METRICS = [
  { key: 'rfs_emergency', extract: d => countOf(d.rfs?.emergency), label: 'RFS Emergency Warnings' },
  { key: 'rfs_watch_act', extract: d => countOf(d.rfs?.watchAct), label: 'RFS Watch and Act' },
  { key: 'rfs_total', extract: d => d.rfs?.total || 0, label: 'RFS Incidents (region)' },
  { key: 'bom_flood', extract: d => d.bom?.summary?.flood || 0, label: 'BOM Flood Warnings' },
  { key: 'bom_storm', extract: d => d.bom?.summary?.storm || 0, label: 'BOM Storm Warnings' },
  { key: 'bom_other', extract: d => (d.bom?.summary?.severeWeather || 0) + (d.bom?.summary?.fireWeather || 0) + (d.bom?.summary?.other || 0), label: 'BOM Other Warnings' },
  { key: 'quake_events', extract: d => d.quakes?.total || 0, label: 'Earthquakes (region)' },
  { key: 'thermal_total', extract: d => d.thermal?.reduce((s, t) => s + t.det, 0) || 0, label: 'Satellite Fire Detections' },
  { key: 'news_count', extract: d => (d.news?.length ?? d.news?.count) || 0, label: 'News Items' },
  { key: 'sources_ok', extract: d => d.meta?.sourcesOk || 0, label: 'Sources OK' },
];

// Risk-sensitive keys: used for determining overall direction
const RISK_KEYS = ['rfs_emergency', 'rfs_watch_act', 'rfs_total', 'bom_flood', 'bom_storm', 'bom_other', 'thermal_total', 'quake_events'];

// ─── Tracked hazard lists — per-item new/escalation signals ─────────────────
// These produce the signals that name actual incidents in alert emails.

const RFS_CATEGORY_RANK = { 'Advice': 1, 'Watch and Act': 2, 'Emergency Warning': 3 };
const FLOOD_CLASS_RANK = { minor: 1, moderate: 2, major: 3 };

const TRACKED_LISTS = [
  {
    prefix: 'rfs',
    items: d => d.rfs?.incidents || [],
    id: i => i.guid,
    describe: i => `${i.category}: ${i.title}${i.council ? ` (${i.council})` : ''}${i.type ? ` — ${i.type}` : ''}`,
    severity: i => i.category === 'Emergency Warning' ? 'critical'
      : i.category === 'Watch and Act' ? 'high' : 'moderate',
    // Planned burns and Not Applicable never generate signals
    alertable: i => Boolean(RFS_CATEGORY_RANK[i.category]),
    rank: i => RFS_CATEGORY_RANK[i.category] || 0,
  },
  {
    prefix: 'bom',
    items: d => d.bom?.warnings || [],
    id: w => w.id,
    describe: w => w.title,
    severity: w => (w.type === 'flood' && w.floodClass === 'major') || w.type === 'tsunami' ? 'critical'
      : w.type === 'storm' || (w.type === 'flood' && w.floodClass === 'moderate') ? 'high' : 'moderate',
    alertable: () => true,
    rank: w => w.type === 'flood' ? (FLOOD_CLASS_RANK[w.floodClass] || 0) : 0,
  },
  {
    prefix: 'quake',
    items: d => d.quakes?.events || [],
    id: e => e.id,
    describe: e => `M${e.mag} earthquake${e.place ? ` — ${e.place}` : ''}`,
    severity: e => e.mag >= 5 ? 'critical' : e.mag >= 4 ? 'high' : 'moderate',
    alertable: e => (e.mag ?? 0) >= 3,
    rank: () => 0, // quakes don't escalate
  },
];

// ─── Semantic Hashing for Telegram Posts ─────────────────────────────────────

/**
 * Produce a normalized semantic hash of a post's content.
 * This is intentionally lossy and is only safe as a fallback when a stable
 * post identity is unavailable.
 */
function contentHash(text) {
  if (!text) return '';
  const normalized = text
    .toLowerCase()
    .replace(/\d{1,2}:\d{2}(:\d{2})?/g, '')       // strip times
    .replace(/\d+/g, 'N')                           // normalize all numbers
    .replace(/[^\w\s]/g, '')                         // strip punctuation
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 100);
  return createHash('sha256').update(normalized).digest('hex').substring(0, 12);
}

function stablePostKey(post) {
  if (!post) return '';

  const sourceId = post.postId || post.messageId || '';
  const channelId = post.channel || post.chat || '';
  const date = post.date || '';
  const text = (post.text || '').trim().substring(0, 200);

  if (sourceId) return `id:${sourceId}`;
  if (channelId && date) {
    return createHash('sha256')
      .update(`${channelId}|${date}|${text}`)
      .digest('hex')
      .substring(0, 16);
  }

  return `semantic:${contentHash(post.text)}`;
}

// ─── Core Delta Computation ──────────────────────────────────────────────────

/**
 * @param {object} current - current sweep's synthesized data
 * @param {object|null} previous - previous sweep's synthesized data (null on first run)
 * @param {object} [thresholdOverrides] - optional: { numeric: {...}, count: {...} }
 * @param {Array<object>} [priorRuns] - optional compacted prior runs for broader dedup
 */
export function computeDelta(current, previous, thresholdOverrides = {}, priorRuns = []) {
  if (!previous) return null;
  if (!current) return null;

  const numThresholds = { ...DEFAULT_NUMERIC_THRESHOLDS, ...(thresholdOverrides.numeric || {}) };
  const cntThresholds = { ...DEFAULT_COUNT_THRESHOLDS, ...(thresholdOverrides.count || {}) };

  const signals = { new: [], escalated: [], deescalated: [], unchanged: [] };
  let criticalChanges = 0;

  // ─── Numeric metrics: track % change ─────────────────────────────────

  for (const m of NUMERIC_METRICS) {
    const curr = m.extract(current);
    const prev = m.extract(previous);
    if (curr == null || prev == null) continue;

    const threshold = numThresholds[m.key] ?? 5;
    const pctChange = prev !== 0 ? ((curr - prev) / Math.abs(prev)) * 100 : 0;

    if (Math.abs(pctChange) > threshold) {
      const entry = {
        key: m.key, label: m.label, from: prev, to: curr,
        pctChange: parseFloat(pctChange.toFixed(2)),
        direction: pctChange > 0 ? 'up' : 'down',
        severity: Math.abs(pctChange) > threshold * 3 ? 'critical' : Math.abs(pctChange) > threshold * 2 ? 'high' : 'moderate',
      };
      if (pctChange > 0) signals.escalated.push(entry);
      else signals.deescalated.push(entry);
      if (Math.abs(pctChange) > 10) criticalChanges++;
    } else {
      signals.unchanged.push(m.key);
    }
  }

  // ─── Count metrics: track absolute change (with minimum thresholds) ──

  for (const m of COUNT_METRICS) {
    const curr = m.extract(current);
    const prev = m.extract(previous);
    const diff = curr - prev;
    const threshold = cntThresholds[m.key] ?? 1;

    if (Math.abs(diff) >= threshold) {
      const pctChange = prev > 0 ? ((diff / prev) * 100) : (diff > 0 ? 100 : 0);
      const entry = {
        key: m.key, label: m.label, from: prev, to: curr,
        change: diff, direction: diff > 0 ? 'up' : 'down',
        pctChange: parseFloat(pctChange.toFixed(1)),
        severity: Math.abs(diff) >= threshold * 5 ? 'critical' : Math.abs(diff) >= threshold * 2 ? 'high' : 'moderate',
      };
      if (diff > 0) signals.escalated.push(entry);
      else signals.deescalated.push(entry);
      // Count metrics only critical if the change is extreme
      if (entry.severity === 'critical') criticalChanges++;
    } else {
      signals.unchanged.push(m.key);
    }
  }

  // ─── Tracked hazard items: new incidents + escalations ───────────────

  // Dedup against all recent runs (not just the last one) so an incident that
  // drops out of one sweep and reappears in a later one is not re-alerted.
  const sources = priorRuns.length > 0 ? priorRuns : [previous];

  for (const list of TRACKED_LISTS) {
    // Prior identity → the most recent prior version of that item (runs are
    // ordered newest-first, so first write wins).
    const prevItems = new Map();
    for (const run of sources) {
      for (const item of list.items(run || {})) {
        const id = list.id(item);
        if (id && !prevItems.has(id)) prevItems.set(id, item);
      }
    }

    for (const item of list.items(current)) {
      const id = list.id(item);
      if (!id || !list.alertable(item)) continue;
      const prev = prevItems.get(id);

      if (!prev) {
        const severity = list.severity(item);
        signals.new.push({
          key: `${list.prefix}:${id}`,
          text: list.describe(item),
          reason: list.describe(item),
          severity,
          item,
        });
        if (severity === 'critical') criticalChanges++;
        continue;
      }

      // Escalation: alert level rose since we last saw this item
      // (e.g. RFS Advice → Watch and Act → Emergency Warning, or a flood
      // warning upgraded minor → moderate → major). Keyed on the new level so
      // a further escalation is never suppressed by the previous alert.
      const prevRank = list.rank(prev);
      const currRank = list.rank(item);
      if (currRank > prevRank && prevRank >= 0) {
        const severity = list.severity(item);
        signals.escalated.push({
          key: `${list.prefix}_escalation:${id}:${currRank}`,
          label: list.describe(item),
          reason: `ESCALATED: ${list.describe(item)}`,
          from: list.describe(prev),
          to: list.describe(item),
          direction: 'up',
          severity,
          item,
        });
        criticalChanges++;
      } else if (currRank < prevRank) {
        signals.deescalated.push({
          key: `${list.prefix}_deescalation:${id}:${currRank}`,
          label: list.describe(item),
          direction: 'down',
          severity: 'moderate',
        });
      }
    }
  }

  // ─── Source health degradation ───────────────────────────────────────

  const currSourcesDown = current.health?.filter(s => s.err).length || 0;
  const prevSourcesDown = previous.health?.filter(s => s.err).length || 0;
  if (currSourcesDown > prevSourcesDown + 2) {
    signals.new.push({
      key: 'source_degradation',
      reason: `${currSourcesDown - prevSourcesDown} additional sources failing (${currSourcesDown} total down)`,
      severity: currSourcesDown > 5 ? 'critical' : 'moderate',
    });
  }

  // ─── Overall direction ───────────────────────────────────────────────

  let direction = 'mixed';
  const riskUp = signals.escalated.filter(s => RISK_KEYS.includes(s.key)).length;
  const riskDown = signals.deescalated.filter(s => RISK_KEYS.includes(s.key)).length;
  if (riskUp > riskDown + 1) direction = 'risk-off';
  else if (riskDown > riskUp + 1) direction = 'risk-on';

  return {
    timestamp: current.meta?.timestamp || new Date().toISOString(),
    previous: previous.meta?.timestamp || null,
    signals,
    summary: {
      totalChanges: signals.new.length + signals.escalated.length + signals.deescalated.length,
      criticalChanges,
      direction,
      signalBreakdown: {
        new: signals.new.length,
        escalated: signals.escalated.length,
        deescalated: signals.deescalated.length,
        unchanged: signals.unchanged.length,
      },
    },
  };
}

// Export thresholds for external config
export { DEFAULT_NUMERIC_THRESHOLDS, DEFAULT_COUNT_THRESHOLDS };
