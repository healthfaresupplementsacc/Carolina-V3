'use strict';
/**
 * Camera-system uptime monitor â€” runs HERE on Railway (always-on), INDEPENDENT of the office PC.
 *
 * Why this exists: the camera system's live view/control depends on the office PC being online.
 * On 2026-07-02 that PC shut down unexpectedly and was dead ~4h, and nobody knew until someone
 * looked. This closes the blind-spot: every couple minutes we pull ONE camera frame through the
 * Tailscale funnel; on a state change (up->down / down->up) we post to the manager Slack channel
 * and @-mention Bruno.
 *
 * The probe hits {CAM_TUNNEL_URL}/frame/warehouse (H.264 via go2rtc) â€” a REAL video byte proves the
 * whole chain: PC on -> funnel -> gateway -> go2rtc has streams -> camera reachable. So it catches
 * both a dead PC (timeout) AND the "page loads but tiles are black / go2rtc has 0 streams" case
 * (the gateway returns 503 because cam8_hd doesn't exist). Token stays server-side (env), never logged.
 *
 * Env: CAM_TUNNEL_URL + CAM_TOKEN (already set for the embed). Optional: CAM_ALERT_CHANNEL
 * (defaults to the manager channel), CAM_MONITOR_CRON (default every 2 min). Disabled if envs missing.
 */
const cron = require('node-cron');
const config = require('./config');
const slackClient = require('./slack/client');

const CRON_EXPR = process.env.CAM_MONITOR_CRON || '*/2 * * * *';        // every 2 minutes
const CHANNEL   = process.env.CAM_ALERT_CHANNEL || config.slack.managerChannelId;
const BRUNO     = config.slack.brunoUserId;

// null = unknown (first sample), true = up, false = down. fails = consecutive failures.
const state = { up: null, since: Date.now(), fails: 0 };

async function probe() {
  const base = process.env.CAM_TUNNEL_URL;
  if (!base) return { ok: false, why: 'CAM_TUNNEL_URL nao configurado' };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const r = await fetch(`${base.replace(/\/$/, '')}/frame/warehouse`, {
      headers: { 'X-Cam-Token': process.env.CAM_TOKEN || '' },
      signal: ctrl.signal,
    });
    if (!r.ok || !r.body) { clearTimeout(timer); try { r.body && r.body.cancel(); } catch (_) {} return { ok: false, why: 'HTTP ' + r.status }; }
    const buf = await r.arrayBuffer();               // /frame = UMA imagem completa (nao aborta stream no meio - o abort do /mp4 derrubava o go2rtc, panic conhecido 1.9.14)
    clearTimeout(timer);
    if (!buf || buf.byteLength < 100) return { ok: false, why: 'sem imagem (go2rtc/camera)' };
    return { ok: true };
  } catch (e) {
    clearTimeout(timer);
    return { ok: false, why: e.name === 'AbortError' ? 'timeout â€” PC/funnel fora do ar' : (e.code || e.message) };
  }
}

function human(ms) {
  const m = Math.round(ms / 60000);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)}h ${m % 60}min`;
}

async function tick() {
  const res = await probe();
  const now = Date.now();
  if (state.up === null) { state.up = res.ok; state.since = now; return; }   // first sample: just record

  if (res.ok && !state.up) {                       // recovered
    const downFor = human(now - state.since);
    state.up = true; state.since = now; state.fails = 0;
    try { await slackClient.postToChannel(CHANNEL, `ðŸŸ¢ *CÃ¢meras VOLTARAM* â€” sistema de cÃ¢meras online de novo (ficou fora ~${downFor}).`); } catch (_) {}
  } else if (!res.ok && state.up) {                // possibly down
    state.fails += 1;
    if (state.fails >= 2) {                         // ~4 min of failures before alerting (avoid false alarms)
      state.up = false; state.since = now;
      try { await slackClient.postToChannel(CHANNEL, `ðŸ”´ *CÃ¢meras OFFLINE* <@${BRUNO}> â€” o PC/relay das cÃ¢meras nÃ£o responde (${res.why}). Sem visualizaÃ§Ã£o atÃ© voltar.`); } catch (_) {}
    }
  } else if (res.ok) {
    state.fails = 0;
  }
}

function startCameraMonitor() {
  if (!process.env.CAM_TUNNEL_URL) {
    console.log('[CameraMonitor] desativado (CAM_TUNNEL_URL ausente)');
    return;
  }
  cron.schedule(CRON_EXPR, () => { tick().catch((e) => console.error('[CameraMonitor]', e.message)); });
  console.log(`[CameraMonitor] ativo â€” probe ${CRON_EXPR} via ${process.env.CAM_TUNNEL_URL}/frame/warehouse`);
}

module.exports = { startCameraMonitor, _probe: probe };
