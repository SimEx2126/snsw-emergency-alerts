// Bureau of Meteorology — NSW/ACT weather warnings
// No auth required, but BOM rejects non-browser User-Agents.
// Feed: IDZ00054.warnings_nsw.xml covers NSW *and* the ACT (flood, severe
// thunderstorm, severe weather, fire weather, marine, agricultural warnings).

import { safeFetch } from '../utils/fetch.mjs';
import config from '../../crucix.config.mjs';

const FEED_URL = process.env.BOM_FEED_URL || 'https://www.bom.gov.au/fwo/IDZ00054.warnings_nsw.xml';

// BOM 403s generic clients — a browser-like UA is required
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

// Forecast districts inside / overlapping the monitored region, used to
// filter statewide noise (e.g. Northern Rivers floods). Off by default until
// tuned against a real warning cycle: set BOM_DISTRICT_FILTER=on to enable.
// Warnings that name no district are always kept — better a false positive
// than a missed flood.
const DISTRICT_FILTER_ON = process.env.BOM_DISTRICT_FILTER === 'on';
const REGION_DISTRICTS = [
  'act', 'australian capital territory',
  'illawarra', 'south coast', 'southern tablelands', 'monaro',
  'snowy mountains', 'riverina', 'south west slopes',
  'lower western', 'upper western', 'central tablelands',
];

const TYPE_PATTERNS = [
  { type: 'flood', re: /flood/i },
  { type: 'storm', re: /thunderstorm|tornado|damaging wind|destructive wind/i },
  { type: 'severe-weather', re: /severe weather/i },
  { type: 'fire-weather', re: /fire weather|fire danger/i },
  { type: 'tsunami', re: /tsunami/i },
  { type: 'marine', re: /marine|gale|strong wind|hurricane force|storm force|damaging waves|high tide/i },
  { type: 'agriculture', re: /graziers|frost|bushwalk|driving/i },
];

function classify(title) {
  for (const { type, re } of TYPE_PATTERNS) {
    if (re.test(title)) return type;
  }
  return 'other';
}

function floodClass(title) {
  if (/major/i.test(title)) return 'major';
  if (/moderate/i.test(title)) return 'moderate';
  if (/minor/i.test(title)) return 'minor';
  return null;
}

function decodeEntities(s) {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n))
    .replace(/&amp;/g, '&');
}

// Minimal RSS <item> parser (same regex approach as dashboard/inject.mjs)
function parseItems(xml) {
  const items = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRe.exec(xml)) !== null) {
    const block = m[1];
    const pick = (tag) => {
      const t = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`));
      return t ? decodeEntities(t[1]).replace(/\s+/g, ' ').trim() : null;
    };
    items.push({ title: pick('title'), link: pick('link'), guid: pick('guid'), pubDate: pick('pubDate') });
  }
  return items;
}

function inRegionDistricts(title) {
  const t = title.toLowerCase();
  const named = REGION_DISTRICTS.some(d => t.includes(d));
  // Titles that name *some* district we don't monitor → out of region.
  // Titles naming no district at all (statewide products) → keep.
  const namesAnyDistrict = /forecast district|district/i.test(t);
  return named || !namesAnyDistrict;
}

export async function briefing() {
  const raw = await safeFetch(FEED_URL, {
    parse: 'text',
    headers: { 'User-Agent': BROWSER_UA, 'Accept': 'application/rss+xml, application/xml, text/xml' },
  });

  const xml = typeof raw === 'string' ? raw : null;
  if (!xml || raw?.error) {
    return {
      source: 'BOM',
      timestamp: new Date().toISOString(),
      status: 'error',
      message: raw?.error || 'Empty or non-XML response',
      total: 0, statewideTotal: 0, warnings: [],
      summary: { flood: 0, storm: 0, severeWeather: 0, fireWeather: 0, other: 0 },
      signals: [],
    };
  }

  const all = parseItems(xml)
    .filter(i => i.title)
    .map(i => {
      const type = classify(i.title);
      // Product ID (e.g. IDN21037) from the link is the stable identity
      const idMatch = (i.link || i.guid || '').match(/ID[A-Z]\d+/);
      return {
        id: idMatch ? idMatch[0] : (i.guid || i.link || i.title),
        title: i.title,
        link: i.link,
        published: i.pubDate,
        type,
        floodClass: type === 'flood' ? floodClass(i.title) : null,
        inRegion: inRegionDistricts(i.title),
      };
    });

  // Marine + agricultural products are dashboard noise for an inland-hazard
  // system; keep land hazard types only.
  const landHazards = all.filter(w => !['marine', 'agriculture'].includes(w.type));
  const warnings = DISTRICT_FILTER_ON ? landHazards.filter(w => w.inRegion) : landHazards;

  const count = (type) => warnings.filter(w => w.type === type).length;
  const signals = [];
  for (const w of warnings) {
    if (w.type === 'flood' && w.floodClass === 'major') signals.push(`MAJOR FLOOD WARNING: ${w.title}`);
    else if (w.type === 'flood') signals.push(`Flood warning (${w.floodClass || 'unclassified'}): ${w.title}`);
    else if (w.type === 'storm') signals.push(`Severe thunderstorm warning: ${w.title}`);
    else if (w.type === 'severe-weather') signals.push(`Severe weather warning: ${w.title}`);
    else if (w.type === 'tsunami') signals.push(`TSUNAMI WARNING: ${w.title}`);
  }

  return {
    source: 'BOM',
    timestamp: new Date().toISOString(),
    status: 'ok',
    region: config.region.label,
    total: warnings.length,
    statewideTotal: all.length,
    warnings,
    summary: {
      flood: count('flood'),
      storm: count('storm'),
      severeWeather: count('severe-weather'),
      fireWeather: count('fire-weather'),
      other: count('other') + count('tsunami'),
    },
    signals,
  };
}

if (process.argv[1]?.endsWith('bom.mjs')) {
  const data = await briefing();
  console.log(JSON.stringify(data, null, 2));
}
