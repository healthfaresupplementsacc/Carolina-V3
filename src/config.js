'use strict';
require('dotenv').config();

module.exports = {
  slack: {
    token: process.env.SLACK_BOT_TOKEN,
    channelId: process.env.SLACK_CHANNEL_ID || 'C09UNBXFRKK',
    bryceUserId: process.env.BRYCE_USER_ID || 'U09DQGJ1ES3',          // Carolina bot
    henriqueUserId: process.env.HENRIQUE_USER_ID || 'U085SDY3F4Z',     // Henrique (logistics)
    brunoUserId: process.env.BRUNO_USER_ID || 'U03URLL1D4L',           // Bruno Camp (owner)
    thassioUserId: process.env.THASSIO_USER_ID || 'U03S46L2EUA',       // Thassio (owner)
    productionLineAccountId: process.env.PRODUCTION_LINE_USER_ID || 'U0AU8N8FA00', // shared floor computer
    managerChannelId: process.env.MANAGER_CHANNEL_ID || 'C0B36DR5MP1',             // private manager channel
  },
  db: {
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  },
  app: {
    port: parseInt(process.env.PORT) || 3000,
    env: process.env.NODE_ENV || 'development',
    publicUrl: process.env.RAILWAY_STATIC_URL || process.env.RAILWAY_PUBLIC_DOMAIN
      ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
      : 'http://localhost:3000',
  },
  polling: {
    intervalMs: parseInt(process.env.POLL_INTERVAL_MS) || 30000,
  },
  eod: {
    hourEdt: parseInt(process.env.EOD_HOUR_EDT) || 19,
    timezone: process.env.TIMEZONE || 'America/New_York',
  },
  // Urgency thresholds (% of expected duration)
  urgency: {
    amber: 1.0,   // 100% -> amber + casual check-in
    red: 1.3,     // 130% -> red + stronger message
    critical: 1.6, // 160% -> red flashing + direct appeal
  },
  // Shared accounts that need "Name -" or "Name:" prefix
  sharedAccounts: [
    'U0AU8N8FA00', // Production Line floor computer (Ana/Bruno)
  ],
  // Known operators
  operators: ['Ana', 'Bruno', 'Vitor', 'Simone'],
  // Operator display names -> slack IDs (where known)
  operatorSlackIds: {
    Vitor: 'U08JC85HMNE',
    Simone: 'U07FG34TMPF',
  },
};
