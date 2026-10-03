'use strict';
/* Bruno 10-03: "Stop this warning, he already said it was made by mistake".
 * Fechar a linha com um motivo que JA EXPLICA a falta do total (tarefa/produto/
 * lote errado, nao fui eu, ainda rodando, outra pessoa fechou, almoco) nao pode
 * abrir a conversa "quantas unidades?". Os motivos abaixo sao TODOS os motivos
 * reais gravados em v3.events ate 10-03 (8 cobrancas, 0 numeros). */
const { reasonExplainsNoTotal, openFollowup } = require('../v3/production-total-followup');

const REAIS_QUE_EXPLICAM = [
  'Produto selecionado erroneamente',            // Vitor 10-03, o caso do pedido
  'Abertura errada da tarefa',
  'ainda ta passando na linha de producao',
  'Ana dando continuidade na linha, irei fazer a relacao das labels, conforme, solicitacao do Henrique.',
  'Carol Lancou no login dela.',
  'coloquei a fnusku',
  'depois so quando terminar de rodar toda linha',
  'entrei no lote errado',
  'era para continuar a revisao, me atrapalhei e coloqieo linha',
  'eu não fiquei até o final vou para a fórmula',
  'fui pegar o papel do fnsku',
  'indo para o almoco',
  'ja coloquei na aba anterior a quantidade que foi produzida, esse sistema abriu duas vezes a tarefa da linha de producao mas na anterior coloquei o valor',
  'nao estava',
  'NAO ESTAVA EM LINHHA E NEM ESTOU',
  'nao estou e nem estava',
  'Nao foi colocado FNSKU, parei para ver o maquianrio com o Thassio',
  'Nao foi iniciada na linha de producao',
  'Nao foi passado na linha de producao a formula toda',
  'Nao foi passado o produto completo',
  'O produto ainda esta sendo passado na linha de producao',
  'O produto nao foi passado todo na linha de producao',
  'o produto nao terminou de ser  passado na linha',
  'outra pessoa fez a conta',
  'Parando linha de producao para realizar troca de produtos na maquina de capsulas',
  'Parando pro almoco, Ana finalizando o final da formula.',
  'pausa para o almo;o, simone assumiu a linha',
  'produto ainda nao finalizado',
  'quando estava comecando fui falar com o Henrique no discord',
  'Saindo para Almoco, Ana dando continuidade na linha e ira colocar quantidade produzida.',
  'Simone não conseguiu fechar por algum motivo',
  'stava revisando, abri a tarefa errada.',
  'Tarefa aberta errada',
  'Voltei do almoco, Simone e Ana assumiram a linha.',
];
const LIXO_OU_VAZIO_COBRA = ['aaaaaaaaaaaaaaa', 'qaaaaaaaaa', '', null, 'ok', 'sei la o que houve'];

describe('production-total-followup: motivo que ja explica nao abre cobranca (Bruno 10-03)', () => {
  test.each(REAIS_QUE_EXPLICAM)('explica: %s', (r) => { expect(reasonExplainsNoTotal(r)).toBe(true); });
  test.each(LIXO_OU_VAZIO_COBRA)('NAO explica (cobra): %s', (r) => { expect(reasonExplainsNoTotal(r)).toBe(false); });

  test('openFollowup com motivo que explica: nao posta no Slack, nao insere followup, audita skipped', async () => {
    const calls = [];
    const db = { query: async (sql, args) => { calls.push({ sql, args }); return { rows: [] }; } };
    const slack = { postAs: async () => { throw new Error('NAO podia postar'); } };
    const r = await openFollowup({ db, slack, productionChannel: 'C1', ev: { id: 5208 }, reason: 'Produto selecionado erroneamente', s: { person_id: 4 }, detail: {} });
    expect(r).toBeNull();
    expect(calls.some((c) => /INSERT INTO v3.production_total_followups/.test(c.sql))).toBe(false);
    const audit = calls.find((c) => /production.total_followup.skipped/.test(c.sql));
    expect(audit).toBeTruthy();
    expect(audit.args[0]).toBe(5208);
  });

  test('openFollowup com motivo lixo: segue o fluxo antigo (posta e insere)', async () => {
    const calls = []; let posted = 0;
    const db = { query: async (sql, args) => { calls.push({ sql, args }); return { rows: [] }; } };
    const slack = { postAs: async () => { posted++; return { ts: '1.2' }; } };
    await openFollowup({ db, slack, productionChannel: 'C1', ev: { id: 1 }, reason: 'aaaaaaaaaaaaaaa', s: { person_id: 4, display_name: 'Vitor' }, detail: {} });
    expect(posted).toBe(1);
    expect(calls.some((c) => /INSERT INTO v3.production_total_followups/.test(c.sql))).toBe(true);
  });
});
