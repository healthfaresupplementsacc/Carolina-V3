'use strict';
// One-shot roadmap board sync (standing rule: keep cards updated with the whole project).
// Writes ONLY v3.roadmap_cards / v3.roadmap_comments. Idempotent-ish: updates by id, inserts new by title match.
const { Pool } = require('pg');
const p = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const D = new Date().toISOString().slice(0, 10);

const UPD = [
  [4,  'doing', 'urgent', 'EM ANDAMENTO (08-19). Locais no dashboard (Estoque → Locais) cadastra prateleiras e caixas; "Criar várias prateleiras" gera A01A1…A12C4 em lote; Etiquetas imprime Code 128 + QR em 4x6. Falta o Bruno cadastrar de verdade e colar as etiquetas.'],
  [20, 'done',  'high',   'FEITO (08-18/19). Hub Estoque: total = prateleira + caixa + a organizar; Veeqo CONFIRMA o total (drift = só alerta, contínuo a cada 10 min, worker stock-drift-alert ligado 08-19); Importar da Veeqo (delta positivo → A organizar, negativo nunca deduz sozinho). Controle da Veeqo (empurrar entradas/ajustes) = próxima etapa.'],
  [37, 'done',  'high',   'FEITO (08-18). Central de P&P → Registrar → "Peguei do estoque": vira proposta PENDENTE já descontada do disponível; admin aprova em Aprovações (vira pick prateleira→caixa) ou recusa (volta). Danificada vai direto pra Separadas.'],
  [38, 'doing', 'high',   'PARCIAL (08-19). Reconciliação Veeqo vs nosso total é contínua (10 min) com alerta no admin-orin + resumo 8h. Falta a camada "saiu sem registro" (comparar saídas registradas x dedução real) quando STOCK_DEDUCT_MODE=live.'],
  [39, 'done',  'normal', 'FEITO (08-19). Hub do operador (/op/estoque.html) → Contar: contagem CEGA por peso (peso unitário + tara) ou na mão, "está vazio" 1 toque; Tarefas de hoje sugere 2 bins/dia; divergência vira proposta pro admin.'],
  [19, 'done',  'high',   'FEITO (08-18). v3.stock_movements é o ledger (idempotente por source/source_ref, kinds store_in/pick/restock/adjust/damaged/count/place/move/import); StockService é o ÚNICO escritor; propostas em stock_change_requests.'],
  [44, 'done',  'urgent', 'FEITO (08-19). Central de P&P SEMPRE disponível pro operador (menu fixo Linha · Central de P&P · Estoque no /op); OP_WORKSPACE_ENABLED ligado em prod e default ON no código. Picklist + PRINT 4x6 + Registrar + Repor + falta de estoque.'],
  [25, 'done',  'high',   'FEITO (08-06, confirmado 08-19). Registrar "Impressão de ordens" no /op abre a Central com a picklist na hora; agora a Central também abre pelo menu sem tarefa (com convite pra registrar a tarefa).'],
  [18, 'doing', 'high',   'PARCIAL (08-19). Já tem: toda mudança de total do operador passa por aprovação; scan resolve bin/caixa/UPC (evita produto errado); contagem cega; toasts dizem o que aconteceu. Falta: scan-verify no pack (#24) e câmera+PIN (#40).'],
];

const NEW = [
  ['inventory', 'done', 'high', 'Warehouse Inventory S15 (hub admin, Aprovações, Locais, Etiquetas, Product Setup, Configurações)', 'FEITO 08-18/19 (fases 1-3, tudo no ar). Hub #estoque no STYLE-KIT: total/prateleira/caixa/a organizar/reservado/disponível/separadas/dias de estoque; Importar da Veeqo; painel de drift; famílias de SKU (kits Veeqo); Aprovações; Locais (tara/capacidade/lote/lacre + criar várias); Etiquetas Code128+QR; peso unitário + Calibrar; presets de tara.'],
  ['employee',  'done', 'high', 'Hub do operador de estoque + celular como scanner + pesar pra contar', 'FEITO 08-19. /op/estoque.html: Organizar · Contar (cega, peso ou mão) · Repor · Caixa nova (chegou da produção) · Devolução · Danificada · Parear celular (QR → /scan/ → SSE) · Tarefas de hoje · Registrado hoje. Scanner USB também funciona. Passada de UX: 1 ação por tela, toasts com consequência, erros em português.'],
  ['base_data', 'todo', 'urgent', 'Importar da Veeqo (carga inicial) e organizar o físico', 'PRÓXIMO PASSO DO BRUNO (08-19): Estoque → Importar da Veeqo (2 passos) → tudo entra em "A organizar" → operador guarda pelo hub (Organizar). Antes: cadastrar Locais e imprimir Etiquetas.'],
  ['base_data', 'todo', 'high', 'Calibrar peso unitário dos produtos (10 garrafas na balança)', 'PRÓXIMO PASSO DO BRUNO (08-19): Product Setup → Calibrar por produto (quantas garrafas, quanto marcou, tara). Sem isso a contagem por peso não funciona (só na mão). Presets de tara em Configurações.'],
  ['dashboard', 'backlog', 'high', 'Página do admin só pra celular (iPhone): inventário + impressão inteiros', 'PLANEJADO (Bruno 08-19). Backend preparado (auth do dashboard reutilizada, endpoints listados em docs/architecture/study/S15-MOBILE-ADMIN-PLAN.md, S15.29). Construir depois que o sistema atual estiver 100% em uso.'],
  ['inventory', 'todo', 'high', 'Controle da Veeqo pelo nosso sistema (etapa 1: dedução live; etapa 2: empurrar entradas/ajustes)', 'DEPOIS da carga inicial (08-19). Etapa 1: STOCK_DEDUCT_MODE=live (Veeqo shipped → pick prateleira→caixa). Etapa 2: produção entra na Veeqo (SKU base) + ajustes empurrados. Depende de Locais + Importar + confiança nos números.'],
  ['dashboard', 'doing', 'normal', 'Aposentar páginas antigas de estoque (Ver estoque / Estoque detalhado)', 'EM ANDAMENTO 08-19: saíram do menu, ainda abrem pelo link com aviso "página antiga". Remover de vez quando o hub tiver 2 semanas de uso.'],
];

(async () => {
  const areas = {};
  for (const r of (await p.query('SELECT id,key FROM v3.roadmap_areas')).rows) areas[r.key] = r.id;
  let u = 0, n = 0, s = 0;
  for (const [id, status, priority, summary] of UPD) {
    const q = await p.query(
      `UPDATE v3.roadmap_cards SET status=$2, priority=$3, summary=$4,
         done_at = CASE WHEN $2='done' THEN COALESCE(done_at, NOW()) ELSE NULL END, updated_at=NOW()
       WHERE id=$1 AND NOT archived RETURNING id`, [id, status, priority, summary]);
    if (q.rowCount) u++; else s++;
  }
  for (const [area, status, priority, title, summary] of NEW) {
    const ex = await p.query('SELECT id FROM v3.roadmap_cards WHERE title=$1 AND NOT archived', [title]);
    if (ex.rowCount) {
      await p.query(`UPDATE v3.roadmap_cards SET status=$2, priority=$3, summary=$4, updated_at=NOW(),
        done_at = CASE WHEN $2='done' THEN COALESCE(done_at, NOW()) ELSE NULL END WHERE id=$1`, [ex.rows[0].id, status, priority, summary]);
      u++; continue;
    }
    await p.query(
      `INSERT INTO v3.roadmap_cards (area_id,title,detail,status,priority,created_by,summary,done_at)
       VALUES ($1,$2,$3,$4,$5,'claude',$6, CASE WHEN $4='done' THEN NOW() ELSE NULL END)`,
      [areas[area], title, summary, status, priority, summary]);
    n++;
  }
  console.log(`roadmap sync ${D}: updated ${u}, inserted ${n}, skipped ${s}`);
  await p.end();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
