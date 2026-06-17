'use strict';
/* Feature production_line: bottles obrigatório + exceção + métricas + resolve.
   Guards de source (sem DB) — o comportamento do endpoint /end está coberto
   behavioralmente em op-api.test.js; aqui garantimos migração, notificação de
   sistema, queries de métricas com COLUNAS REAIS e a UI admin. */
const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

describe('production_line exception — migração + backend + admin', () => {
  test('migration 031: exception_no_count + exception_reason + índice parcial + down', () => {
    const sql = read('v3/schema/migrations/031_production_line_exception.sql');
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS exception_no_count BOOLEAN/);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS exception_reason TEXT/);
    expect(sql).toContain('idx_events_exception');
    const down = read('v3/schema/migrations/031_production_line_exception.down.sql');
    expect(down).toContain('DROP COLUMN IF EXISTS exception_no_count');
    expect(down).toContain('DROP COLUMN IF EXISTS exception_reason');
  });

  test('op.js: validação + persistência + notificação SISTEMA (não Carolina) no canal produção', () => {
    const op = read('routes/op.js');
    expect(op).toContain('function notifyProductionException');
    expect(op).toContain("'C09UNBXFRKK'");                       // orders-and-inventory default
    expect(op).toContain("name: 'HealthFare Tracker (Sistema)'"); // voz do sistema
    expect(op).toContain(':package:');
    expect(op).toContain('exception_no_count = $3, exception_reason = $4'); // persiste flags
    expect(op).toContain("error: 'bottles_required'");
    expect(op).toContain("error: 'exception_reason_required'");
    expect(op).toContain("'event.end_with_exception'");
    expect(op).toContain('bottles_count'); // alias aceito
  });

  test('admin.js: métricas production-line com COLUNAS REAIS + resolve exceção', () => {
    const ad = read('routes/admin.js');
    expect(ad).toContain('/api/adminpanel/metrics/production-line');
    expect(ad).toContain('/api/adminpanel/exceptions/:eventId/resolve');
    expect(ad).toContain('pr.canonical_name');     // produto (NÃO display_name)
    expect(ad).toContain('SUM(pc.bottles)');        // bottles (NÃO count_value)
    expect(ad).toContain('reported_by_person_id');  // coluna real
    expect(ad).toContain("at.slug = 'production_line'");
    expect(ad).toContain("'exception.resolved'");
    expect(ad).toContain("error: 'not_an_exception'");
    expect(ad).toContain("error: 'already_counted'");
  });

  test('admin UI: aba Linha (4 cards) + resolver exceção + auto-refresh 60s', () => {
    const ui = read('admin/app.js');
    expect(ui).toContain("['linha', '🏭 Linha']");
    expect(ui).toContain('metrics/production-line');
    expect(ui).toContain('Metas em Curso');
    expect(ui).toContain('exceptions/${ex.id}/resolve');
    expect(ui).toContain('linhaTimer');
    expect(ui).toContain('60000'); // auto-refresh 60s
  });
});
