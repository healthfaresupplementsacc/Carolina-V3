'use strict';
/**
 * FASE 1 P9 — pure decision helper for the retroactive operator cleanup.
 *
 * Kept separate from the ops script so the "should I reassign?" rule is
 * unit-tested without a DB. The rule is deliberately CONSERVATIVE: only
 * reassign when the unified resolveOperator (Part 2) reached the new
 * operator via an EXPLICIT name PREFIX (via='prefix') and that differs
 * from who the row is currently attributed to. Account-owner / context
 * resolutions are NOT auto-corrected retroactively (too weak a signal
 * for a destructive change — those stay for Bruno to eyeball).
 */

function shouldReassign({ currentOperatorId, resolved }) {
  if (!resolved || resolved.ambiguous) return false;
  if (resolved.via !== 'prefix') return false; // only explicit-prefix corrections
  if (!resolved.operatorId) return false;
  if (currentOperatorId == null) return false; // null → handled by disambiguation, not here
  return Number(currentOperatorId) !== Number(resolved.operatorId);
}

module.exports = { shouldReassign };
