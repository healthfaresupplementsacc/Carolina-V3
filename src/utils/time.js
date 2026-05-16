'use strict';
/**
 * BUG AMPM - single source of truth for rendering a clock time to the
 * humans (Florida admins use AM/PM day-to-day; military 24h confused
 * them). Everything stays timestamptz/UTC in the DB; this only changes
 * how an instant is DISPLAYED, always in America/New_York (ET).
 *
 *   formatTime(ts)                 -> "5:24 PM"  (12h, the default)
 *   formatTime(ts, {format:'24h'}) -> "17:24"    (military, opt-in)
 *
 * The format toggle lives in app_state ('time_format', default '12h')
 * and is surfaced in the Carolina config panel. Server callers pass the
 * resolved format in; the dashboard mirrors this logic client-side and
 * is fed the same toggle via the /api/dashboard payload.
 */

const ET = 'America/New_York';

function _toDate(input) {
  if (input == null || input === '') return null;
  if (input instanceof Date) return Number.isNaN(input.getTime()) ? null : input;
  const d = new Date(input);
  return Number.isNaN(d.getTime()) ? null : d;
}

function is24h(opts) {
  if (!opts) return false;
  return opts.format24 === true || opts.format === '24h' || opts.format === 24;
}

/**
 * @param {Date|string|number} input  an instant (ISO/Date/ms)
 * @param {{format?:'12h'|'24h', format24?:boolean, empty?:string}} [opts]
 * @returns {string} ET clock time; opts.empty (default "--") when unparsable
 */
function formatTime(input, opts = {}) {
  const d = _toDate(input);
  if (!d) return opts.empty != null ? opts.empty : '--';
  const h24 = is24h(opts);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: ET,
    hour: h24 ? '2-digit' : 'numeric',
    minute: '2-digit',
    hour12: !h24,
  }).format(d);
  // Node >= 18 inserts a NARROW NO-BREAK SPACE (U+202F) / NBSP before
  // AM/PM - normalize so "5:24 PM" compares and looks right everywhere.
  return parts.replace(/[  ]/g, ' ').trim();
}

module.exports = { formatTime, is24h, ET };
