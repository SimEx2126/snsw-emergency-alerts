// Geoscience Australia — recent earthquakes (last 7 days)
// No auth required. WFS GeoJSON from earthquakes.ga.gov.au.
// The feed contains occasional non-display/test records (display_flag !== 'Y',
// far-future origin_time) which must be filtered out.

import { safeFetch } from '../utils/fetch.mjs';
import config from '../../crucix.config.mjs';

const WFS_URL = process.env.GA_QUAKES_URL ||
  'https://earthquakes.ga.gov.au/geoserver/earthquakes/ows' +
  '?service=WFS&version=1.0.0&request=GetFeature' +
  '&typeName=earthquakes:earthquakes_seven_days&outputFormat=application/json';

export async function briefing() {
  const region = config.region;
  const pad = region.quakePaddingDegrees ?? 1.0;
  const box = {
    west: region.west - pad,
    south: region.south - pad,
    east: region.east + pad,
    north: region.north + pad,
  };

  const data = await safeFetch(WFS_URL, { timeout: 20000 });

  if (data?.error || !Array.isArray(data?.features)) {
    return {
      source: 'GA Earthquakes',
      timestamp: new Date().toISOString(),
      status: 'error',
      message: data?.error || 'Unexpected WFS response shape',
      total: 0, maxMag: null, events: [],
      signals: [],
    };
  }

  const now = Date.now();
  const events = data.features
    .map(f => {
      const p = f.properties || {};
      const [lon, lat] = f.geometry?.coordinates || [null, null];
      return {
        id: String(p.earthquake_id ?? f.id),
        mag: p.preferred_magnitude != null ? +p.preferred_magnitude.toFixed(1) : null,
        magType: p.preferred_magnitude_type || null,
        place: p.description || null,
        time: p.origin_time || null,
        depth: p.depth ?? null,
        felt: p.felt_reports_count || 0,
        lat, lon,
        displayFlag: p.display_flag,
      };
    })
    .filter(e =>
      e.displayFlag === 'Y' &&
      e.time && new Date(e.time).getTime() <= now + 3600000 &&
      e.lat != null && e.lon != null &&
      e.lat >= box.south && e.lat <= box.north &&
      e.lon >= box.west && e.lon <= box.east
    )
    .map(({ displayFlag, ...e }) => e)
    .sort((a, b) => (b.mag ?? 0) - (a.mag ?? 0));

  const maxMag = events.length ? events[0].mag : null;
  const signals = [];
  for (const e of events) {
    if (e.mag >= 5) signals.push(`SIGNIFICANT EARTHQUAKE: M${e.mag} ${e.place}`);
    else if (e.mag >= 4) signals.push(`Earthquake: M${e.mag} ${e.place}`);
    else if (e.mag >= 3) signals.push(`Minor earthquake: M${e.mag} ${e.place}`);
  }

  return {
    source: 'GA Earthquakes',
    timestamp: new Date().toISOString(),
    status: 'ok',
    region: `${config.region.label} (+${pad}° padding)`,
    total: events.length,
    maxMag,
    events,
    signals,
  };
}

if (process.argv[1]?.endsWith('ga-quakes.mjs')) {
  const data = await briefing();
  console.log(JSON.stringify(data, null, 2));
}
