/* Time + formatting helpers. Operates on minutes-from-midnight (NY) and a live
   NOW value that ticks every second so live events update.
   ESM (E0): importa React; exporta HFH e mantém window.HFH pra retro-compat
   com componentes que ainda acessam pelo global durante a migração.
*/
import React from 'react';

export const HFH = (() => {
  // Live anchor: real time of mount, plus fictional NOW base = 14:34
  const ANCHOR_NOW = window.HFData.NOW_MIN;
  const MOUNT_T = Date.now();

  // Ticking now: minutes (float). Use Math.floor for whole-minute calls.
  function liveNowMin() {
    const elapsedSec = (Date.now() - MOUNT_T) / 1000;
    return ANCHOR_NOW + elapsedSec / 60;
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
