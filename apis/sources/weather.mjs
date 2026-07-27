// Open-Meteo — current conditions + 7-day forecast for key towns across the
// conference territory. No auth, generous free tier. Drives the dashboard's
// weather centre; carries no alert weight (BOM warnings are the authority).

import { safeFetch } from '../utils/fetch.mjs';

export const TOWNS = [
  { name: 'Canberra',     lat: -35.28, lon: 149.13 },
  { name: 'Wagga Wagga',  lat: -35.11, lon: 147.37 },
  { name: 'Wollongong',   lat: -34.42, lon: 150.89 },
  { name: 'Cooma',        lat: -36.23, lon: 149.13 },
  { name: 'Batemans Bay', lat: -35.71, lon: 150.18 },
  { name: 'Goulburn',     lat: -34.75, lon: 149.72 },
];

const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const AIR_URL = 'https://air-quality-api.open-meteo.com/v1/air-quality';

export async function briefing() {
  const lats = TOWNS.map(t => t.lat).join(',');
  const lons = TOWNS.map(t => t.lon).join(',');

  const forecastParams = new URLSearchParams({
    latitude: lats, longitude: lons,
    current: 'temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m,wind_direction_10m',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,uv_index_max,sunrise,sunset',
    hourly: 'visibility',
    forecast_days: '7',
    timezone: 'Australia/Sydney',
  });
  const airParams = new URLSearchParams({
    latitude: lats, longitude: lons,
    current: 'us_aqi',
    timezone: 'Australia/Sydney',
  });

  const [forecastRaw, airRaw] = await Promise.all([
    safeFetch(`${FORECAST_URL}?${forecastParams}`, { timeout: 20000 }),
    safeFetch(`${AIR_URL}?${airParams}`, { timeout: 20000 }),
  ]);

  const forecasts = Array.isArray(forecastRaw) ? forecastRaw : (forecastRaw?.current ? [forecastRaw] : null);
  if (!forecasts || forecastRaw?.error) {
    return {
      source: 'Open-Meteo',
      timestamp: new Date().toISOString(),
      status: 'error',
      message: forecastRaw?.error || 'Unexpected forecast response shape',
      towns: [],
      signals: [],
    };
  }
  const air = Array.isArray(airRaw) ? airRaw : (airRaw?.current ? [airRaw] : []);

  const towns = TOWNS.map((town, i) => {
    const f = forecasts[i] || {};
    const c = f.current || {};
    const d = f.daily || {};
    // Visibility: value at the current hour (hourly series is local time)
    let visibilityKm = null;
    if (f.hourly?.time && f.hourly?.visibility && c.time) {
      const idx = f.hourly.time.findIndex(t => t >= c.time.slice(0, 13));
      const v = f.hourly.visibility[idx >= 0 ? idx : 0];
      if (v != null) visibilityKm = +(v / 1000).toFixed(1);
    }
    const days = (d.time || []).map((date, j) => ({
      date,
      code: d.weather_code?.[j] ?? null,
      max: d.temperature_2m_max?.[j] ?? null,
      min: d.temperature_2m_min?.[j] ?? null,
      rainChance: d.precipitation_probability_max?.[j] ?? null,
    }));
    return {
      name: town.name,
      lat: town.lat, lon: town.lon,
      current: {
        time: c.time ?? null,
        temp: c.temperature_2m ?? null,
        feelsLike: c.apparent_temperature ?? null,
        humidity: c.relative_humidity_2m ?? null,
        precipitation: c.precipitation ?? null,
        code: c.weather_code ?? null,
        windKmh: c.wind_speed_10m ?? null,
        windDir: c.wind_direction_10m ?? null,
        visibilityKm,
        aqi: air[i]?.current?.us_aqi ?? null,
      },
      today: {
        uvMax: d.uv_index_max?.[0] ?? null,
        rainChance: d.precipitation_probability_max?.[0] ?? null,
        sunrise: d.sunrise?.[0] ?? null,
        sunset: d.sunset?.[0] ?? null,
      },
      days,
    };
  });

  return {
    source: 'Open-Meteo',
    timestamp: new Date().toISOString(),
    status: 'ok',
    towns,
    signals: [],
  };
}

if (process.argv[1]?.endsWith('weather.mjs')) {
  const data = await briefing();
  console.log(JSON.stringify(data, null, 2));
}
