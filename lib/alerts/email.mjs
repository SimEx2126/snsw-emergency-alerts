// Email Alerter — SMTP transport for hazard alerts.
// Same interface as TelegramAlerter/DiscordAlerter (isConfigured,
// evaluateAndAlert) so server.mjs treats all transports identically.
// Tiering is rule-based via hazard-rules.mjs; no LLM required.

import { createHash } from 'crypto';
import nodemailer from 'nodemailer';
import { evaluateHazardSignals } from './hazard-rules.mjs';

// FLASH gets a high hourly cap: an Emergency Warning email must never be
// rate-limited away. Per-signal cooldowns in MemoryManager already prevent
// the same incident re-alerting.
const TIER_CONFIG = {
  FLASH:    { color: '#d32f2f', label: 'FLASH',    cooldownMs: 0,                maxPerHour: 10 },
  PRIORITY: { color: '#f9a825', label: 'PRIORITY', cooldownMs: 15 * 60 * 1000,   maxPerHour: 4 },
  ROUTINE:  { color: '#1976d2', label: 'ROUTINE',  cooldownMs: 60 * 60 * 1000,   maxPerHour: 2 },
};

export class EmailAlerter {
  constructor({ host, port, secure, user, pass, from, to, dashboardUrl }) {
    this.from = from;
    this.to = Array.isArray(to) ? to : (to ? String(to).split(',').map(s => s.trim()).filter(Boolean) : []);
    this.dashboardUrl = dashboardUrl || null;
    this._alertHistory = [];
    this._contentHashes = {};

    this.transport = host ? nodemailer.createTransport({
      host,
      port: port || 587,
      secure: Boolean(secure),
      ...(user && pass ? { auth: { user, pass } } : {}),
    }) : null;
  }

  get isConfigured() {
    return Boolean(this.transport && this.from && this.to.length > 0);
  }

  async evaluateAndAlert(llmProvider, delta, memory) {
    if (!this.isConfigured) return false;
    if (!delta?.summary?.totalChanges) return false;

    const allSignals = [
      ...(delta.signals?.new || []),
      ...(delta.signals?.escalated || []),
    ];

    const newSignals = allSignals.filter(s => {
      const key = this._signalKey(s);
      if (typeof memory.isSignalSuppressed === 'function') {
        if (memory.isSignalSuppressed(key)) return false;
      } else if (memory.getAlertedSignals()[key]) {
        return false;
      }
      if (this._isSemanticDuplicate(s)) return false;
      return true;
    });

    if (newSignals.length === 0) return false;

    const evaluation = evaluateHazardSignals(newSignals, delta);
    if (!evaluation?.shouldAlert) {
      console.log('[Email] No alert —', evaluation?.reason || 'no qualifying signals');
      return false;
    }

    const tier = TIER_CONFIG[evaluation.tier] ? evaluation.tier : 'ROUTINE';
    if (!this._checkRateLimit(tier)) {
      console.log(`[Email] Rate limited for tier ${tier}`);
      return false;
    }

    const sent = await this.sendAlertEmail(evaluation, newSignals, tier);

    if (sent) {
      for (const s of newSignals) {
        memory.markAsAlerted(this._signalKey(s), new Date().toISOString());
        this._recordContentHash(s);
      }
      this._recordAlert(tier);
      console.log(`[Email] ${tier} alert sent to ${this.to.length} recipient(s): ${evaluation.headline}`);
    }

    return sent;
  }

  async sendAlertEmail(evaluation, signals, tier) {
    const cfg = TIER_CONFIG[tier];
    const subject = `[${cfg.label}] ${evaluation.headline}`.substring(0, 150);

    try {
      await this.transport.sendMail({
        from: this.from,
        to: this.to.join(', '),
        subject,
        text: this._formatText(evaluation, signals, tier),
        html: this._formatHtml(evaluation, signals, tier),
      });
      return true;
    } catch (err) {
      console.error('[Email] Send failed:', err.message);
      return false;
    }
  }

  // ─── Formatting ─────────────────────────────────────────────────────────

  _incidentRows(signals) {
    return signals
      .filter(s => s.item)
      .map(s => {
        const i = s.item;
        const label = s.reason || s.text || s.key;
        const link = i.link || null;
        const detail = [i.status, i.size, i.council].filter(Boolean).join(' · ');
        return { label, link, detail, severity: s.severity };
      });
  }

  _formatText(evaluation, signals, tier) {
    const lines = [
      `${tier} ALERT — ${evaluation.headline}`,
      '',
      evaluation.reason,
      '',
      'Details:',
      ...this._incidentRows(signals).map(r =>
        `  • ${r.label}${r.detail ? ` (${r.detail})` : ''}${r.link ? `\n    ${r.link}` : ''}`),
      '',
      `Recommended: ${evaluation.actionable}`,
    ];
    if (this.dashboardUrl) lines.push('', `Dashboard: ${this.dashboardUrl}`);
    lines.push('', '—', 'SNSW Emergency Monitor (automated). Always follow official RFS/SES/BOM instructions.');
    return lines.join('\n');
  }

  _formatHtml(evaluation, signals, tier) {
    const cfg = TIER_CONFIG[tier];
    const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const rows = this._incidentRows(signals).map(r => `
      <tr>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;">
          ${r.link ? `<a href="${esc(r.link)}" style="color:#1a237e;">${esc(r.label)}</a>` : esc(r.label)}
          ${r.detail ? `<br><span style="color:#666;font-size:13px;">${esc(r.detail)}</span>` : ''}
        </td>
      </tr>`).join('');

    return `
<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:640px;margin:0 auto;">
  <div style="background:${cfg.color};color:#fff;padding:14px 18px;border-radius:6px 6px 0 0;">
    <div style="font-size:12px;letter-spacing:2px;font-weight:700;">${cfg.label} ALERT — SNSW EMERGENCY MONITOR</div>
    <div style="font-size:19px;font-weight:600;margin-top:4px;">${esc(evaluation.headline)}</div>
  </div>
  <div style="border:1px solid #ddd;border-top:none;border-radius:0 0 6px 6px;padding:18px;">
    <p style="margin:0 0 12px;font-size:15px;color:#222;">${esc(evaluation.reason)}</p>
    ${rows ? `<table style="border-collapse:collapse;width:100%;margin:0 0 12px;">${rows}</table>` : ''}
    <p style="margin:0 0 12px;font-size:14px;color:#222;"><strong>Recommended:</strong> ${esc(evaluation.actionable)}</p>
    ${this.dashboardUrl ? `<p style="margin:0 0 12px;"><a href="${esc(this.dashboardUrl)}" style="background:#1a237e;color:#fff;text-decoration:none;padding:9px 16px;border-radius:4px;font-size:14px;display:inline-block;">Open live dashboard</a></p>` : ''}
    <p style="margin:12px 0 0;font-size:12px;color:#888;">Automated alert from the South NSW Conference emergency monitor.
    Always follow official instructions from the NSW RFS, NSW SES and the Bureau of Meteorology.</p>
  </div>
</div>`;
  }

  // ─── Dedup & Rate Limiting (mirrors TelegramAlerter) ────────────────────

  _contentHash(signal) {
    let content = '';
    if (signal.text) {
      content = signal.text.toLowerCase()
        .replace(/\d{1,2}:\d{2}/g, '')
        .replace(/\d+\.\d+%?/g, 'NUM')
        .replace(/\s+/g, ' ')
        .trim()
        .substring(0, 120);
    } else if (signal.label) {
      content = `${signal.label}:${signal.direction || 'none'}`;
    } else {
      content = signal.key || JSON.stringify(signal).substring(0, 80);
    }
    return createHash('sha256').update(content).digest('hex').substring(0, 16);
  }

  _isSemanticDuplicate(signal) {
    // Hazard signals carry stable per-incident keys — those are already
    // deduped via MemoryManager, so semantic dedup only applies to keyless
    // or text-only signals.
    if (signal.key && (signal.key.includes(':') || signal.key.includes('_'))) return false;
    const lastSeen = this._contentHashes[this._contentHash(signal)];
    if (!lastSeen) return false;
    return new Date(lastSeen).getTime() > Date.now() - 4 * 60 * 60 * 1000;
  }

  _recordContentHash(signal) {
    this._contentHashes[this._contentHash(signal)] = new Date().toISOString();
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const [h, ts] of Object.entries(this._contentHashes)) {
      if (new Date(ts).getTime() < cutoff) delete this._contentHashes[h];
    }
  }

  _signalKey(signal) {
    return signal.key || signal.label || `em:${this._contentHash(signal)}`;
  }

  _checkRateLimit(tier) {
    const cfg = TIER_CONFIG[tier];
    if (!cfg) return true;
    const now = Date.now();
    const lastSameTier = this._alertHistory.filter(a => a.tier === tier).pop();
    if (lastSameTier && (now - lastSameTier.timestamp) < cfg.cooldownMs) return false;
    const recentCount = this._alertHistory.filter(a => a.tier === tier && a.timestamp > now - 3600000).length;
    return recentCount < cfg.maxPerHour;
  }

  _recordAlert(tier) {
    this._alertHistory.push({ tier, timestamp: Date.now() });
    if (this._alertHistory.length > 50) this._alertHistory = this._alertHistory.slice(-50);
  }
}
