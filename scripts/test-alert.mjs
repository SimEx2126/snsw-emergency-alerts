#!/usr/bin/env node
// Alert drill — sends a synthetic alert of each tier (or one chosen tier)
// through the real EmailAlerter, exercising tiering, formatting and SMTP
// end-to-end without waiting for a real emergency.
//
// Usage:
//   npm run test:alert            # send FLASH + PRIORITY + ROUTINE test emails
//   npm run test:alert -- flash   # send a single tier
//
// Requires SMTP_* / ALERT_EMAIL_* configured in .env.

import config from '../crucix.config.mjs';
import { EmailAlerter } from '../lib/alerts/email.mjs';

const emailAlerter = new EmailAlerter({
  ...(config.email || {}),
  dashboardUrl: config.publicUrl || `http://localhost:${config.port}`,
});

if (!emailAlerter.isConfigured) {
  console.error('Email alerter is not configured.');
  console.error('Set SMTP_HOST, SMTP_USER, SMTP_PASS, ALERT_EMAIL_FROM and ALERT_EMAIL_TO in .env');
  process.exit(1);
}

// Stub memory: never suppress, never persist — test alerts must not pollute
// the real cooldown state in runs/memory/hot.json.
const stubMemory = {
  isSignalSuppressed: () => false,
  markAsAlerted: () => {},
  getAlertedSignals: () => ({}),
};

const SCENARIOS = {
  flash: {
    signals: {
      new: [{
        key: 'rfs:test-emergency-1',
        reason: 'Emergency Warning: TEST DRILL FIRE, BREDBO (Snowy Monaro Regional) — Bush Fire',
        severity: 'critical',
        item: {
          guid: 'test-emergency-1', category: 'Emergency Warning',
          title: 'TEST DRILL FIRE, BREDBO', council: 'Snowy Monaro Regional',
          type: 'Bush Fire', status: 'Out of control', size: '1200 ha',
          link: 'https://www.rfs.nsw.gov.au/fire-information/fires-near-me',
        },
      }],
      escalated: [], deescalated: [], unchanged: [],
    },
    summary: { totalChanges: 1, criticalChanges: 1, direction: 'risk-off' },
  },
  priority: {
    signals: {
      new: [{
        key: 'bom:TEST-IDN001',
        reason: 'TEST DRILL: Severe Thunderstorm Warning for the Riverina and South West Slopes',
        severity: 'high',
        item: {
          id: 'TEST-IDN001', type: 'storm',
          title: 'TEST DRILL: Severe Thunderstorm Warning for the Riverina and South West Slopes',
          link: 'https://www.bom.gov.au/nsw/warnings/',
        },
      }],
      escalated: [], deescalated: [], unchanged: [],
    },
    summary: { totalChanges: 1, criticalChanges: 0, direction: 'risk-off' },
  },
  routine: {
    signals: {
      new: [{
        key: 'rfs:test-advice-1',
        reason: 'Advice: TEST DRILL GRASS FIRE, WAGGA WAGGA (Wagga Wagga City) — Grass Fire',
        severity: 'moderate',
        item: {
          guid: 'test-advice-1', category: 'Advice',
          title: 'TEST DRILL GRASS FIRE, WAGGA WAGGA', council: 'Wagga Wagga City',
          type: 'Grass Fire', status: 'Under control', size: '2 ha',
          link: 'https://www.rfs.nsw.gov.au/fire-information/fires-near-me',
        },
      }],
      escalated: [], deescalated: [], unchanged: [],
    },
    summary: { totalChanges: 1, criticalChanges: 0, direction: 'mixed' },
  },
};

const requested = (process.argv[2] || '').toLowerCase();
const toRun = requested ? [requested] : ['flash', 'priority', 'routine'];

for (const name of toRun) {
  const scenario = SCENARIOS[name];
  if (!scenario) {
    console.error(`Unknown tier "${name}" — use flash | priority | routine`);
    process.exit(1);
  }
  const delta = {
    timestamp: new Date().toISOString(),
    previous: new Date(Date.now() - 300000).toISOString(),
    ...scenario,
  };
  process.stdout.write(`Sending ${name.toUpperCase()} test alert... `);
  const sent = await emailAlerter.evaluateAndAlert(null, delta, stubMemory);
  console.log(sent ? 'sent ✓' : 'NOT SENT ✗');
  if (!sent) process.exitCode = 1;
}

console.log(`\nRecipients: ${emailAlerter.to.join(', ')}`);
console.log('Check inboxes (and spam folders) for [FLASH]/[PRIORITY]/[ROUTINE] subjects.');
