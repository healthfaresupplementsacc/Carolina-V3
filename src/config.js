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
  // BUG TZ — single source of truth. The plant is in Florida; the whole
  // system is America/New_York (ET, DST-aware). DB stores timestamptz
  // (UTC); typed input is interpreted as ET; everything renders in ET.
  tz: process.env.TIMEZONE || 'America/New_York',
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
    'U0AU8N8FA00', // Production Line floor computer (Ana/Bruno Sarmento)
  ],
  // Known operator name tokens accepted as an inline prefix. Kept for the
  // legacy parser regex; FASE 1 resolve-operator derives the real matcher
  // from the operators table (name + aliases) — this is only the fallback
  // token list. Bruno→Bruno Sarmento, Vitor→Vitor Leite (the floor people).
  operators: ['Ana', 'Bruno Sarmento', 'Bruno', 'Vitor Leite', 'Vitor', 'Simone', 'Henrique'],
  // FASE 1 Passo 3 — account → default owner (Bruno's documented rule,
  // doc 10.3 / spec 2.2). The account→operator NAME mapping is the rule;
  // the name→operator_id resolution is data-driven via the operators
  // table (so no operator_id is ever hardcoded — honours spec 2.3).
  accountOwners: {
    U07FG34TMPF: 'Simone',
    U08JC85HMNE: 'Vitor Leite',
  },
  // Accounts that NEVER auto-attribute (shared, no default owner). The
  // floor PC is shared by Ana/Bruno Sarmento — a message with no prefix
  // and no recent context from here is AMBIGUOUS (Carolina asks admin).
  noOwnerAccounts: ['U0AU8N8FA00'],
  // (legacy) operator display names -> slack IDs (where known)
  operatorSlackIds: {
    Vitor: 'U08JC85HMNE',
    Simone: 'U07FG34TMPF',
  },
};
