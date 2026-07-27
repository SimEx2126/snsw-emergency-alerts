// Crucix Configuration — all settings with env var overrides

import "./apis/utils/env.mjs"; // Load .env first

export default {
  port: parseInt(process.env.PORT) || 3117,
  publicUrl: process.env.PUBLIC_URL || null,
  refreshIntervalMinutes: parseInt(process.env.REFRESH_INTERVAL_MINUTES) || 15,

  // Monitored area: southern NSW + ACT (South NSW Conference territory).
  // North edge sits below Sydney (Greater Sydney Conference); west reaches the SA border.
  region: {
    west: parseFloat(process.env.REGION_WEST) || 141.0,
    south: parseFloat(process.env.REGION_SOUTH) || -37.6,
    east: parseFloat(process.env.REGION_EAST) || 151.7,
    north: parseFloat(process.env.REGION_NORTH) || -34.0,
    label: process.env.REGION_LABEL || 'Southern NSW & ACT',
    // Earthquakes just outside the region are still felt inside it
    quakePaddingDegrees: 1.0,
  },

  llm: {
    provider: process.env.LLM_PROVIDER || null, // anthropic | openai | gemini | codex | openrouter | minimax | mistral | ollama | grok
    apiKey: process.env.LLM_API_KEY || null,
    model: process.env.LLM_MODEL || null,
    baseUrl: process.env.OLLAMA_BASE_URL || null,
  },

  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN || null,
    chatId: process.env.TELEGRAM_CHAT_ID || null,
    botPollingInterval: parseInt(process.env.TELEGRAM_POLL_INTERVAL) || 5000,
    channels: process.env.TELEGRAM_CHANNELS || null, // Comma-separated extra channel IDs
  },

  discord: {
    botToken: process.env.DISCORD_BOT_TOKEN || null,
    channelId: process.env.DISCORD_CHANNEL_ID || null,
    guildId: process.env.DISCORD_GUILD_ID || null, // Server ID (for instant slash command registration)
    webhookUrl: process.env.DISCORD_WEBHOOK_URL || null, // Fallback: webhook-only alerts (no bot needed)
  },

  // Delta engine thresholds — override defaults from lib/delta/engine.mjs.
  // These are the live tuning surface for alert sensitivity.
  delta: {
    thresholds: {
      numeric: {},
      count: {
        // Defaults shown; uncomment to change sensitivity:
        // rfs_emergency: 1,   // Emergency Warning count change
        // rfs_watch_act: 1,
        // rfs_total: 1,       // any incident appearing/resolving in region
        // bom_flood: 1,
        // bom_storm: 1,
        // bom_other: 1,       // severe/fire weather, tsunami
        // quake_events: 1,
        // thermal_total: 10,  // satellite fire detections in region
        // news_count: 5,
        // sources_ok: 2,      // raise to ignore more source flapping
      },
    },
  },
};
