'use strict';
/**
 * Entrega 3 — App Home interactivity handler. Routes block_actions and
 * view_submission payloads to the workflow engine. Filled in commit 6.3.
 */

// Placeholder router — replaced by the full handler in 6.3.
async function handleInteraction(payload) {
  if (!payload || !payload.type) return;
  // 6.3 will dispatch payload.type === 'block_actions' / 'view_submission'
  console.log('[Interactive] received:', payload.type,
    payload.actions ? payload.actions.map((a) => a.action_id).join(',') : '');
}

module.exports = { handleInteraction };
