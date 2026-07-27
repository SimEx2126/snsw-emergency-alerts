// Hazard alert tiering — shared, deterministic rules for all transports.
// Maps delta signals from the hazard sources (NSW RFS, BOM, GA quakes, FIRMS)
// onto the FLASH / PRIORITY / ROUTINE tiers. Returns the same evaluation shape
// the LLM path produces, so alerters can use either interchangeably.
//
// Tier meanings for this system:
//   FLASH    — life-safety: RFS Emergency Warning, major flood, tsunami, M5+ quake
//   PRIORITY — prepare/act soon: Watch and Act, severe storm, moderate flood, M4+ quake
//   ROUTINE  — awareness: new Advice incident, minor flood, fire weather, M3+ quake

const HAZARD_PREFIXES = ['rfs', 'bom', 'quake'];

function isHazardSignal(s) {
  const key = s.key || '';
  return HAZARD_PREFIXES.some(p => key === p || key.startsWith(`${p}:`) || key.startsWith(`${p}_`));
}

function describe(s) {
  return s.reason || s.text || s.label || s.key;
}

export function evaluateHazardSignals(signals, delta) {
  // Per-incident signals are the ones worth alerting on; count metrics
  // (rfs_total, bom_flood…) corroborate but don't carry incident detail.
  const incidentSignals = signals.filter(s => isHazardSignal(s) && s.item);
  const criticals = incidentSignals.filter(s => s.severity === 'critical');
  const highs = incidentSignals.filter(s => s.severity === 'high');
  const moderates = incidentSignals.filter(s => s.severity === 'moderate');

  // Satellite corroboration — never escalates a tier on its own
  const thermalSpike = signals.find(s => s.key === 'thermal_total' && s.direction === 'up' && (s.severity === 'critical' || s.severity === 'high'));

  // ── FLASH: any life-safety critical (Emergency Warning, major flood,
  //    tsunami, M5+ quake — including escalations to those levels)
  if (criticals.length > 0) {
    const top = criticals[0];
    return {
      shouldAlert: true, tier: 'FLASH', confidence: 'HIGH',
      headline: describe(top),
      reason: criticals.length === 1
        ? `An official emergency-level warning is current for the region: ${describe(top)}`
        : `${criticals.length} emergency-level warnings are current for the region.`,
      actionable: 'Check the affected area against church/school/camp locations and activate the emergency contact procedure if any are nearby.',
      signals: criticals.map(describe).slice(0, 6),
      crossCorrelation: thermalSpike ? 'official warning + satellite fire detections' : 'official warning feed',
    };
  }

  // ── PRIORITY: Watch and Act, severe storm, moderate flood, M4+ quake
  if (highs.length > 0) {
    const top = highs[0];
    return {
      shouldAlert: true, tier: 'PRIORITY', confidence: 'HIGH',
      headline: describe(top),
      reason: highs.length === 1
        ? `A significant hazard warning is current for the region: ${describe(top)}`
        : `${highs.length} significant hazard warnings are current for the region.`,
      actionable: 'Review the affected areas and give nearby congregations early notice. Conditions may escalate.',
      signals: highs.map(describe).slice(0, 6),
      crossCorrelation: thermalSpike ? 'official warning + satellite fire detections' : 'official warning feed',
    };
  }

  // ── ROUTINE: new Advice-level incidents, minor floods, fire weather,
  //    M3+ quakes, or a standalone satellite fire spike
  if (moderates.length > 0 || thermalSpike) {
    const top = moderates[0] || thermalSpike;
    return {
      shouldAlert: true, tier: 'ROUTINE', confidence: 'MEDIUM',
      headline: describe(top),
      reason: moderates.length > 0
        ? `${moderates.length} new advice-level notice(s) for the region — no action required, worth awareness.`
        : 'Satellite fire detections in the region increased notably. No official warning is current.',
      actionable: 'Monitor',
      signals: [...moderates.map(describe), ...(thermalSpike ? [describe(thermalSpike)] : [])].slice(0, 6),
      crossCorrelation: 'single source',
    };
  }

  return {
    shouldAlert: false,
    reason: `${signals.length} signal(s), none hazard-alertable (news/source-health changes only).`,
  };
}
