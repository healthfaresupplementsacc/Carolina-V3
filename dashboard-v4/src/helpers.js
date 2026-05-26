/* Time + formatting helpers. Opera em minutos-desde-meia-noite NY com leitura
   DINÂMICA do relógio (E7-refine3 — fix do bug "2:36 PM quando NY é 11:36 AM").
   ESM (E0): importa React; exporta HFH e mantém window.HFH pra retro-compat.
*/
import React from 'react';
import nyTime from './utils/ny-time.cjs';

export const HFH = (() => {
  // Antes: anchor capturado UMA vez do mock window.HFData.NOW_MIN (14:34) +
  // elapsed since module-load → off por horas. Agora: lê wall clock NY real
  // do Date.now() absoluto via Intl. Independente da TZ do navegador do user.
  function liveNowMin() {
    return nyTime.nyNowMinutes();
  }

  function pad(n) { return n < 10 ? "0" + n : "" + n; }

  // 12h clock
  function fmtClock(min) {
    if (min == null) return "--:--";
    const totalMin = Math.floor(min);
    let h = Math.floor(totalMin / 60) % 24;
    const m = totalMin % 60;
    const ampm = h >= 12 ? "PM" : "AM";
    h = h % 12; if (h === 0) h = 12;
    return `${h}:${pad(m)} ${ampm}`;
  }

  function fmtClockShort(min) {
    const totalMin = Math.floor(min);
    let h = Math.floor(totalMin / 60) % 24;
    const m = totalMin % 60;
    const ampm = h >= 12 ? "p" : "a";
    h = h % 12; if (h === 0) h = 12;
    return m ? `${h}:${pad(m)}${ampm}` : `${h}${ampm}`;
  }

  // Duration in minutes -> "1h 23m" or "23m" or "45s" if <1m
  function fmtDur(min) {
    if (min == null) return "--";
    if (min < 1) {
      const s = Math.max(0, Math.floor(min * 60));
      return `${s}s`;
    }
    const totalMin = Math.floor(min);
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    if (h === 0) return `${m}m`;
    return `${h}h ${pad(m)}m`;
  }

  // Live cronômetro: h:mm:ss
  function fmtCron(minFloat) {
    if (minFloat == null || minFloat < 0) return "0:00:00";
    const totalSec = Math.floor(minFloat * 60);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    return `${h}:${pad(m)}:${pad(s)}`;
  }

  // Color helpers
  function flowColor(flow) {
    return window.HFData.FLOWS[flow]?.color || "var(--flow-prod)";
  }
  function flowColor2(flow) {
    return window.HFData.FLOWS[flow]?.color2 || "var(--flow-prod-2)";
  }

  // Range overlap (foreground events)
  function rangesOverlap(a1, a2, b1, b2) {
    return Math.max(a1, b1) < Math.min(a2, b2);
  }

  // useNow hook — ticks per second when active
  function useNow(active = true, intervalMs = 1000) {
    const [t, setT] = React.useState(liveNowMin());
    React.useEffect(() => {
      if (!active) return;
      const id = setInterval(() => setT(liveNowMin()), intervalMs);
      return () => clearInterval(id);
    }, [active, intervalMs]);
    return t;
  }

  return { liveNowMin, fmtClock, fmtClockShort, fmtDur, fmtCron, flowColor, flowColor2, rangesOverlap, useNow, pad };
})();

if (typeof window !== 'undefined') window.HFH = HFH;
