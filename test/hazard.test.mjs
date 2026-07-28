// Tests for the alerting brain: delta detection, tiering and email dispatch.
// These cover the paths that decide whether a warning reaches a human, so
// they should fail loudly rather than be adjusted to match new behaviour.
//
//   npm test

import test from 'node:test';
import assert from 'node:assert/strict';
import { computeDelta } from '../lib/delta/engine.mjs';
import { evaluateHazardSignals } from '../lib/alerts/hazard-rules.mjs';
import { EmailAlerter } from '../lib/alerts/email.mjs';

// ─── Fixtures ────────────────────────────────────────────────────────────
const incident = (over = {}) => ({
  guid: 'inc/1', title: 'TEST FIRE, BREDBO', category: 'Advice',
  type: 'Bush Fire', status: 'Under control', council: 'Snowy Monaro', ...over,
});

const sweep = (over = {}) => ({
  meta: { timestamp: '2026-07-27T02:00:00Z', sourcesOk: 6, sourcesQueried: 6 },
  rfs: { total: 1, emergency: [], watchAct: [], advice: [], incidents: [incident()] },
  bom: { total: 0, summary: { flood: 0, storm: 0, severeWeather: 0, fireWeather: 0, other: 0 }, warnings: [] },
  quakes: { total: 0, maxMag: null, events: [] },
  thermal: [{ region: 'Southern NSW & ACT', det: 2, night: 0, hc: 1 }],
  news: { count: 10 },
  ...over,
});

// ─── Delta engine ────────────────────────────────────────────────────────

test('escalation Advice -> Emergency Warning is critical', () => {
  const before = sweep();
  const after = sweep({
    meta: { timestamp: '2026-07-27T02:05:00Z', sourcesOk: 6, sourcesQueried: 6 },
    rfs: { total: 1, emergency: [{ guid: 'inc/1' }], watchAct: [], advice: [],
           incidents: [incident({ category: 'Emergency Warning', status: 'Out of control' })] },
  });
  const d = computeDelta(after, before, {}, [before]);
  const esc = d.signals.escalated.find(s => s.key.startsWith('rfs_escalation:'));
  assert.ok(esc, 'escalation signal emitted');
  assert.equal(esc.severity, 'critical');
});

test('a brand new Watch and Act incident is reported as high', () => {
  const before = sweep();
  const after = sweep({
    rfs: { total: 2, emergency: [], watchAct: [{ guid: 'inc/2' }], advice: [],
           incidents: [incident(), incident({ guid: 'inc/2', title: 'NEW FIRE, TUMUT', category: 'Watch and Act' })] },
  });
  const d = computeDelta(after, before, {}, [before]);
  const created = d.signals.new.find(s => s.key === 'rfs:inc/2');
  assert.ok(created, 'new-incident signal emitted');
  assert.equal(created.severity, 'high');
});

test('an unchanged sweep produces no new or escalated signals', () => {
  const s = sweep();
  const d = computeDelta(s, s, {}, [s]);
  assert.equal(d.signals.new.length, 0);
  assert.equal(d.signals.escalated.length, 0);
});

test('the first sweep has no baseline, so no delta', () => {
  assert.equal(computeDelta(sweep(), null, {}, []), null);
});

test('config thresholds are honoured (they were once silently ignored)', () => {
  const before = sweep();
  const after = sweep({ thermal: [{ region: 'Southern NSW & ACT', det: 40, night: 12, hc: 30 }] });
  const withDefault = computeDelta(after, before, {}, [before]);
  assert.ok(withDefault.signals.escalated.some(s => s.key === 'thermal_total'));
  const raised = computeDelta(after, before, { count: { thermal_total: 100 } }, [before]);
  assert.ok(!raised.signals.escalated.some(s => s.key === 'thermal_total'));
});

// ─── Tiering ─────────────────────────────────────────────────────────────

const evalOf = (signals) => evaluateHazardSignals(signals, { summary: { totalChanges: signals.length } });

test('Emergency Warning is FLASH', () => {
  const e = evalOf([{ key: 'rfs:1', reason: 'Emergency Warning: X', severity: 'critical', item: {} }]);
  assert.equal(e.shouldAlert, true);
  assert.equal(e.tier, 'FLASH');
});

test('Watch and Act is PRIORITY', () => {
  assert.equal(evalOf([{ key: 'rfs:1', reason: 'Watch and Act: X', severity: 'high', item: {} }]).tier, 'PRIORITY');
});

test('Advice is ROUTINE', () => {
  assert.equal(evalOf([{ key: 'rfs:1', reason: 'Advice: X', severity: 'moderate', item: {} }]).tier, 'ROUTINE');
});

test('news and source-count churn never alerts', () => {
  const e = evalOf([
    { key: 'news_count', label: 'News Items', severity: 'moderate', direction: 'up' },
    { key: 'sources_ok', label: 'Sources OK', severity: 'high', direction: 'down' },
  ]);
  assert.equal(e.shouldAlert, false);
});

test('satellite detections alone never exceed ROUTINE', () => {
  // FIRMS also sees hazard-reduction burns, so it must not drive the top tier
  const e = evalOf([{ key: 'thermal_total', label: 'Satellite Fire Detections', severity: 'critical', direction: 'up' }]);
  assert.equal(e.tier, 'ROUTINE');
});

test('a dark data source raises a PRIORITY alert', () => {
  const e = evalOf([{ key: 'source_down:BOM', sourceOutage: true, sourceName: 'BOM', severity: 'high', reason: 'BOM unreachable for 3 consecutive sweeps' }]);
  assert.equal(e.tier, 'PRIORITY');
  assert.match(e.headline, /BOM/);
});

test('a live emergency outranks a dark source', () => {
  const e = evalOf([
    { key: 'source_down:BOM', sourceOutage: true, sourceName: 'BOM', severity: 'high', reason: 'BOM unreachable' },
    { key: 'rfs:1', reason: 'Emergency Warning: X', severity: 'critical', item: {} },
  ]);
  assert.equal(e.tier, 'FLASH');
});

// ─── Email dispatch ──────────────────────────────────────────────────────

function stubAlerter() {
  const sent = [];
  const a = new EmailAlerter({ host: 'stub', from: 'monitor@example.org', to: 'a@example.org,b@example.org', dashboardUrl: 'http://localhost:3117' });
  a.transport = { sendMail: async (m) => { sent.push(m); } };
  return { a, sent };
}
const openMemory = { isSignalSuppressed: () => false, markAsAlerted: () => {}, getAlertedSignals: () => ({}) };
const flashDelta = () => ({
  signals: { new: [{ key: 'rfs:inc/9', reason: 'Emergency Warning: BIG FIRE, COOMA', severity: 'critical',
                     item: { guid: 'inc/9', title: 'BIG FIRE, COOMA', category: 'Emergency Warning', status: 'Out of control', link: 'https://example.org/x' } }],
             escalated: [], deescalated: [], unchanged: [] },
  summary: { totalChanges: 1, criticalChanges: 1, direction: 'risk-off' },
});

test('recipients parse from a comma-separated list', () => {
  const { a } = stubAlerter();
  assert.equal(a.isConfigured, true);
  assert.deepEqual(a.to, ['a@example.org', 'b@example.org']);
});

test('a FLASH email carries the tier, the incident and its link', async () => {
  const { a, sent } = stubAlerter();
  assert.equal(await a.evaluateAndAlert(null, flashDelta(), openMemory), true);
  assert.equal(sent.length, 1);
  assert.match(sent[0].subject, /^\[FLASH\]/);
  assert.match(sent[0].html, /BIG FIRE, COOMA/);
  assert.match(sent[0].html, /https:\/\/example\.org\/x/);
  assert.match(sent[0].text, /Out of control/);   // plain-text alternative present
});

test('a suppressed signal sends nothing', async () => {
  const { a, sent } = stubAlerter();
  const suppressed = { ...openMemory, isSignalSuppressed: () => true };
  assert.equal(await a.evaluateAndAlert(null, flashDelta(), suppressed), false);
  assert.equal(sent.length, 0);
});

test('an empty delta sends nothing', async () => {
  const { a, sent } = stubAlerter();
  await a.evaluateAndAlert(null, { signals: { new: [], escalated: [] }, summary: { totalChanges: 0 } }, openMemory);
  assert.equal(sent.length, 0);
});

test('FLASH is never cooldown-blocked, but is capped per hour', async () => {
  const { a, sent } = stubAlerter();
  for (let i = 0; i < 12; i++) {
    const d = flashDelta();
    d.signals.new[0].key = `rfs:inc/${100 + i}`;   // distinct incidents, no dedup
    await a.evaluateAndAlert(null, d, openMemory);
  }
  assert.equal(sent.length, 10, 'hourly FLASH cap applies');
});
