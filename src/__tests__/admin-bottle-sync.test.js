'use strict';
/* BUG CRÍTICO bottle sync — guard de fonte: "Produção Hoje" (byProduct) e
   bottles_today leem v3.production_counts kind='bottles' SEM derrubar contagens
   de lote/produto NULL (LEFT JOIN), e orders nunca vazam. */
const fs = require('fs');
const path = require('path');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'routes', 'admin.js'), 'utf8');

describe('bottle sync — fonte canônica /admin/metrics', () => {
  test('byProduct usa LEFT JOIN (não derruba lote/produto NULL) + kind=bottles', () => {
    const i = SRC.indexOf('const byProduct = await db.query(');
    const block = SRC.slice(i, i + 700);
    expect(block).toContain('LEFT JOIN v3.product_batches pb');
    expect(block).toContain('LEFT JOIN v3.products pr');
    expect(block).not.toContain('JOIN v3.product_batches pb ON pb.id = e.product_batch_id\n       JOIN v3.products pr'); // nada de INNER em sequência
    expect(block).toContain("pc.kind = 'bottles'"); // P&P (orders) não entra
    expect(block).toContain("COALESCE(pr.canonical_name, 'Sem produto vinculado')"); // não-linkado conta
  });
  test('bottles_today filtra kind=bottles (orders não vazam pra produção)', () => {
    const i = SRC.indexOf('AS bottles_today');
    const block = SRC.slice(i - 220, i + 20);
    expect(block).toContain("kind = 'bottles'");
  });
  test('WORK_SEC (duração desconta pausa) continua na base do bpm', () => {
    expect(SRC).toContain('const WORK_SEC =');
    expect(SRC).toContain('total_paused_seconds');
  });
});
