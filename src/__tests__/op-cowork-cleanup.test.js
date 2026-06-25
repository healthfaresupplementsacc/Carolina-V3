'use strict';
/**
 * REGRA ANTI-REGRESSÃO (Bruno 06-24): o cowork NÃO pode ficar "fantasma".
 *
 * Bug recorrente: quando alguém SAI de um cowork (almoço, troca de task, fim), o
 * colega seguia "em grupo / Já junto" com quem já tinha saído (cowork_with órfão),
 * e a tarefa do que saiu não aparecia direito. Esse teste trava a correção em 3
 * frentes pra qualquer update futuro não quebrar de novo:
 *   1) existe a limpeza geral cleanupCoworkGroup (não só P&P);
 *   2) ela é chamada em TODO fim de cowork: /end + auto-close do start (almoço/troca);
 *   3) o "Equipe agora" (active-operators) deriva o cowork AO VIVO (quem está aberto
 *      no mesmo grupo agora), não do cowork_with armazenado (que pode estar órfão).
 */
const fs = require('fs');
const path = require('path');
const OP = fs.readFileSync(path.join(__dirname, '..', 'routes', 'op.js'), 'utf8');

describe('cowork — limpeza ao sair (anti-regressão)', () => {
  test('1) existe cleanupCoworkGroup (limpeza geral, não só P&P)', () => {
    expect(OP).toContain('async function cleanupCoworkGroup(');
    // recomputa membros vivos do grupo e limpa quando sobra <2
    expect(OP).toMatch(/cowork_group_id = \$1 AND ended_at IS NULL/);
    expect(OP).toContain("cowork_with = '{}'::int[], cowork_group_id = NULL");
  });

  test('2) chamada no /end de qualquer cowork', () => {
    expect(OP).toContain('if (ev.cowork_group_id) await cleanupCoworkGroup(ev.cowork_group_id)');
  });

  test('3) chamada no auto-close do start (almoço + troca de task)', () => {
    expect(OP).toContain('const cleanupGids =');
    // almoço e troca de task fecham tarefas e limpam o cowork dos colegas
    expect(OP).toMatch(/await cleanupGids\(toClose\)/);
    expect(OP).toMatch(/await cleanupGids\(oids\)/);
  });

  test('4) active-operators deriva o cowork AO VIVO (não do cowork_with armazenado)', () => {
    const block = OP.slice(OP.indexOf('active-operators'));
    // current_cowork vem de eventos abertos no MESMO grupo agora
    expect(block).toMatch(/array_agg\(DISTINCT e3\.person_id\)[\s\S]*e3\.cowork_group_id = ce\.cowork_group_id[\s\S]*AS current_cowork/);
    // e NÃO mais o cru "ce.cowork_with AS current_cowork"
    expect(block).not.toContain('ce.cowork_with AS current_cowork');
  });
});
