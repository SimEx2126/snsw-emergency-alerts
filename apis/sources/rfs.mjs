// NSW Rural Fire Service — Major Incidents feed
// No auth required. The authoritative source for bushfire and other
// emergency incidents in NSW, including the official public alert level.
// Feed: https://www.rfs.nsw.gov.au/feeds/majorIncidents.json (GeoJSON)

import { safeFetch } from '../utils/fetch.mjs';
import config from '../../crucix.config.mjs';

// RFS_FEED_URL override doubles as the drill mechanism: point it at a local
// fixture server to rehearse the full sweep → delta → email chain.
const FEED_URL = process.env.RFS_FEED_URL || 'https://www.rfs.nsw.gov.au/feeds/majorIncidents.json';

// Categories observed in the live feed. 'Planned Burn' entries are hazard
// reduction burns — tracked but never alert-worthy.
const ALERT_LEVELS = ['Emergency Warning', 'Watch and Act', 'Advice', 'Not Applicable', 'Planned Burn'];

function inRegion(lat, lon, region) {
  return lat != null && lon != null &&
    lat >= region.south && lat <= region.north &&
    lon >= region.west && lon <= region.east;
}

// Geometry is usually a GeometryCollection holding a Point (incident marker)
// and a nested GeometryCollection of Polygons (burnt area). Prefer the Point.
function extractPoint(geometry) {
  if (!geometry) return { lat: null, lon: null };
  if (geometry.type === 'Point') {
    const [lon, lat] = geometry.coordinates;
    return { lat, lon };
  }
  if (geometry.type === 'Polygon' && geometry.coordinates?.[0]?.length) {
    const coords = geometry.coordinates[0];
    return {
      lat: coords.reduce((s, c) => s + c[1], 0) / coords.length,
      lon: coords.reduce((s, c) => s + c[0], 0) / coords.length,
    };
  }
  if (geometry.type === 'GeometryCollection') {
    for (const g of geometry.geometries || []) {
      const p = extractPoint(g);
      if (p.lat != null) return p;
    }
  }
  return { lat: null, lon: null };
}

// description is "KEY: value <br />KEY: value ..." — parse to an object
function parseDescription(desc = '') {
  const fields = {};
  for (const part of desc.split(/<br\s*\/?>/i)) {
    const m = part.match(/^\s*([A-Z][A-Z /]+):\s*(.*)$/);
    if (m) fields[m[1].trim()] = m[2].trim();
  }
  return fields;
}

function compactIncident(feature) {
  const p = feature.properties || {};
  const fields = parseDescription(p.description);
  const { lat, lon } = extractPoint(feature.geometry);
  return {
    guid: p.guid,
    title: p.title,
    category: p.category,
    link: p.link,
    published: p.pubDate,
    lat: lat != null ? +lat.toFixed(4) : null,
    lon: lon != null ? +lon.toFixed(4) : null,
    location: fields['LOCATION'] || null,
    council: fields['COUNCIL AREA'] || null,
    status: fields['STATUS'] || null,
    type: fields['TYPE'] || null,
    fire: fields['FIRE'] === 'Yes',
    size: fields['SIZE'] || null,
    updated: fields['UPDATED'] || null,
  };
}

export async function briefing() {
  const region = config.region;
  const data = await safeFetch(FEED_URL, {
    headers: { 'Accept': 'application/json' },
  });

  if (data?.error || !Array.isArray(data?.features)) {
    return {
      source: 'NSW RFS',
      timestamp: new Date().toISOString(),
      status: 'error',
      message: data?.error || 'Unexpected feed shape',
      total: 0, statewideTotal: 0,
      emergency: [], watchAct: [], advice: [], incidents: [],
      signals: [],
    };
  }

  const statewide = data.features.map(compactIncident);
  const incidents = statewide.filter(i => inRegion(i.lat, i.lon, region));

  const byLevel = (level) => incidents.filter(i => i.category === level);
  const emergency = byLevel('Emergency Warning');
  const watchAct = byLevel('Watch and Act');
  const advice = byLevel('Advice');
  const unknownLevels = incidents.filter(i => !ALERT_LEVELS.includes(i.category));

  const signals = [];
  for (const i of emergency) signals.push(`EMERGENCY WARNING: ${i.title} (${i.council || i.location}) — ${i.type}, ${i.status}`);
  for (const i of watchAct) signals.push(`Watch and Act: ${i.title} (${i.council || i.location}) — ${i.type}, ${i.status}`);
  if (unknownLevels.length) signals.push(`Unrecognised RFS alert level on ${unknownLevels.length} incident(s) — check feed format`);

  return {
    source: 'NSW RFS',
    timestamp: new Date().toISOString(),
    status: 'ok',
    region: region.label,
    total: incidents.length,
    statewideTotal: statewide.length,
    emergency,
    watchAct,
    advice,
    incidents,
    signals,
  };
}

if (process.argv[1]?.endsWith('rfs.mjs')) {
  const data = await briefing();
  console.log(JSON.stringify(data, null, 2));
}
