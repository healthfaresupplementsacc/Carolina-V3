'use strict';
/**
 * HEALTHFARE — Hub SSE do spooler ao vivo (Bruno 07-16).
 *
 * Server-Sent Events: o dashboard assina `GET /api/v3/data/print-stream` (EventSource)
 * e recebe PUSH em tempo real do progresso das impressões — em vez de ficar
 * consultando. O poller do .28 manda o progresso pro `/api/print-progress`, que
 * chama broadcast() aqui; o print-event (fim do job) também. Simples, HTTP puro,
 * passa por proxy/Railway (pesquisa Bruno pediu: SSE é o certo pra progresso).
 */
const clients = new Set();

/** Registra uma resposta SSE (chamado pelo endpoint /print-stream). */
function addClient(res) {
  clients.add(res);
  res.on('close', () => clients.delete(res));
  return () => clients.delete(res);
}

/** Empurra um evento pra todos os dashboards conectados. */
function broadcast(event, data) {
  if (!clients.size) return;
  const msg = 'event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n';
  for (const res of clients) {
    try { res.write(msg); } catch (_) { clients.delete(res); }
  }
}

function clientCount() { return clients.size; }

module.exports = { addClient, broadcast, clientCount };
