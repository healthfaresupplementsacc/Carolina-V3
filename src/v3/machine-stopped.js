'use strict';
/**
 * MÁQUINA PARADA NA SAÍDA (Bruno 09-28).
 *
 * Antes, quem saía pra almoço/pausa/fim do dia com uma tarefa de máquina aberta
 * SEMPRE tinha que apontar um substituto ("Vitor saiu e apontou Larissa..."),
 * mesmo com a máquina desligada e ninguém na frente dela. Agora o /op pergunta
 * primeiro "a máquina está rodando?": SIM → aponta alguém (fluxo antigo);
 * NÃO → chama isto aqui: fecha a(s) tarefa(s) da máquina e deixa a pessoa ir.
 * Sem substituto, sem mensagem no grupo dos operadores.
 *
 *  mine = tarefas de máquina abertas da pessoa (myRunningMachines em op.js)
 */
async function closeStoppedMachines({ db, audit, personId, mine, leaveLabel }) {
  const slugs = [];
  for (const m of mine || []) {
    await db.query(
      "UPDATE v3.events SET ended_at = NOW(), closed_reason = 'machine_stopped', updated_at = NOW() WHERE id = $1 AND ended_at IS NULL",
      [m.id]);
    slugs.push(m.act_name || m.slug);
  }
  if (audit) {
    try { await audit('machine.stopped_on_leave', 'person', personId, { slugs, leave: leaveLabel || null, events: (mine || []).map((m) => m.id) }, personId); } catch (_) {}
  }
  return { slugs };
}

module.exports = { closeStoppedMachines };
