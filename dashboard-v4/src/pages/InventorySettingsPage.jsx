/* Página "Configurações de Inventário" (Bruno 08-07).
   Duas seções, como o Bruno pediu:
     (A) ORDENS & IMPRESSÃO — tamanhos de envelope por cor, mistura preta+branca,
         suprimentos, mapa tamanho→suprimento, perguntas pendentes de embalagem.
     (B) INVENTÁRIO & ESTOQUE — bins, limiares (ainda não construído de verdade;
         mostra o estado atual e o que falta).
   Fonte: /api/v3/data/inventory-settings. Segue o STYLE-KIT (sem travessão). */
import React from 'react';
import { usePoll, apiPost } from '../adapters/from-api.js';
import { V4_ALLOW_WRITES } from '../flags.js';

const KIT = `
.is-root{
  --primary:#1a3a6b; --primary-deep:#0d1f3c; --green-d:#2e8b3c;
  --ground:#f4f8fc; --surface:#fff; --surface-2:#f7fafd;
  --line:#d4e2f0; --line-strong:#b9cbe2; --dotline:#c6d7e8;
  --ink:#1c2b3a; --ink-dim:#54687c; --ink-faint:#6b7f92;
  --ok-bg:#e8f7ea; --ok-line:#c8ecce; --ok-deep:#1e6b2e;
  --warn-bg:#fdf6e3; --warn-line:#eeddad; --warn-deep:#6b4c07;
  --bad-bg:#fdeeec; --bad-line:#f5cdc7; --bad-deep:#a02c20;
  --neutral-bg:#eaf0fb; --neutral-line:#d4e2f0;
  --font:'DM Sans',system-ui,'Segoe UI',sans-serif;
  --font-display:'DM Serif Display','Iowan Old Style',Georgia,serif;
  --font-mono:'DM Mono','SFMono-Regular',ui-monospace,Consolas,monospace;
  font-family:var(--font); color:var(--ink);
  background:var(--ground); background-image:radial-gradient(circle,rgba(26,58,107,.06) 1px,transparent 1px); background-size:26px 26px;
  min-height:100%; padding:30px 26px 70px;
}
.is-eyebrow{font:500 10px var(--font-mono);letter-spacing:.14em;text-transform:uppercase;color:var(--green-d)}
.is-h1{font-family:var(--font-display);font-weight:400;font-size:clamp(24px,2.4vw,32px);color:var(--primary-deep);margin:4px 0 2px}
.is-h1 em{color:var(--green-d);font-style:italic}
.is-sub{color:var(--ink-dim);font-size:13px}
.is-sec{font-family:var(--font-display);font-size:20px;color:var(--primary-deep);margin:26px 0 2px}
.is-secsub{color:var(--ink-dim);font-size:12.5px;margin-bottom:12px}
.is-card{background:var(--surface);border:1px solid var(--line);border-radius:16px;box-shadow:0 1px 2px rgba(13,31,60,.03),0 10px 30px rgba(13,31,60,.05);padding:16px 18px;margin-bottom:14px}
.is-mlabel{font:500 10px var(--font-mono);letter-spacing:.12em;text-transform:uppercase;color:var(--ink-faint)}
.is-tbl{width:100%;border-collapse:collapse;font-size:13.5px}
.is-tbl th{text-align:left;font:500 10px var(--font-mono);letter-spacing:.08em;text-transform:uppercase;color:var(--ink-faint);padding:6px 8px;border-bottom:1px solid var(--line)}
.is-tbl td{padding:7px 8px;border-bottom:1px dotted var(--dotline)}
.is-in{padding:5px 8px;border-radius:8px;border:1px solid var(--line);background:#fff;color:var(--ink);font:500 13px var(--font-mono);width:70px}
.is-chip{display:inline-flex;align-items:center;height:21px;padding:0 9px;border-radius:999px;font:500 11px var(--font-mono)}
.is-chip.ok{background:var(--ok-bg);color:var(--ok-deep);box-shadow:inset 0 0 0 1px var(--ok-line)}
.is-chip.warn{background:var(--warn-bg);color:var(--warn-deep);box-shadow:inset 0 0 0 1px var(--warn-line)}
.is-chip.bad{background:var(--bad-bg);color:var(--bad-deep);box-shadow:inset 0 0 0 1px var(--bad-line)}
.is-chip.neutral{background:var(--neutral-bg);color:var(--primary);box-shadow:inset 0 0 0 1px var(--neutral-line)}
.is-btn{border:none;cursor:pointer;font:600 12.5px var(--font);border-radius:999px;height:32px;padding:0 15px;background:var(--primary-deep);color:#fff}
.is-btn.sec{background:#fff;color:var(--ink);border:1px solid var(--line)}
.is-todo{background:var(--surface-2);border:1px dashed var(--line-strong);border-radius:14px;padding:14px 16px;color:var(--ink-dim);font-size:13px}
`;

function Row({ children }) { return <tr>{children}</tr>; }

export function InventorySettingsPage() {
  const st = usePoll('/inventory-settings', [], 0);
  const [msg, setMsg] = React.useState('');
  const [local, setLocal] = React.useState(null);
  const d = local || st.data || {};
  const ro = !V4_ALLOW_WRITES;
  const ack = (m) => { setMsg(m); setTimeout(() => setMsg(''), 2200); };

  async function saveTier(t, field, value) {
    if (ro) { ack('modo leitura'); return; }
    const body = { id: t.id }; body[field] = value === '' ? null : Number(value);
    const r = await apiPost('/inventory-settings/tier', body).catch((e) => ({ error: e.message }));
    if (r && !r.error) { ack('salvo'); setLocal(null); } else ack('erro: ' + (r && r.error));
  }
  async function saveMix(m, whiteMax) {
    if (ro) { ack('modo leitura'); return; }
    const r = await apiPost('/inventory-settings/mix', {
      package_size: m.package_size, black_qty: m.black_qty, white_max: Number(whiteMax), confirmed: true,
    }).catch((e) => ({ error: e.message }));
    if (r && !r.error) { ack('confirmado'); setLocal(null); } else ack('erro: ' + (r && r.error));
  }
  async function toggleQuestion(q) {
    if (ro) { ack('modo leitura'); return; }
    const r = await apiPost('/inventory-settings/question/' + q.id, { active: !q.active }).catch((e) => ({ error: e.message }));
    if (r && !r.error) { ack(q.active ? 'pergunta desligada' : 'pergunta ligada'); setLocal(null); } else ack('erro');
  }

  const tiers = d.tiers || [];
  const mix = d.mix || [];
  const supplies = d.supplies || [];
  const sizeSupply = d.size_supply || [];
  const questions = d.questions || [];
  const nBins = (d.bins && d.bins[0] && d.bins[0].n) || 0;
  const nThresholds = (d.thresholds && d.thresholds[0] && d.thresholds[0].n) || 0;

  return (
    <div className="is-root">
      <style>{KIT}</style>

      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 14, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 260 }}>
          <span className="is-eyebrow">● HEALTHFARE · CONFIGURAÇÕES</span>
          <h1 className="is-h1">Configurações de <em>inventário</em></h1>
          <p className="is-sub">Tudo que o sistema usa pra decidir embalagem, impressão e estoque.</p>
        </div>
        {msg && <span style={{ fontSize: 12.5, fontWeight: 700, color: msg.startsWith('erro') ? 'var(--bad-deep)' : 'var(--green-d)' }}>{msg}</span>}
      </div>

      {st.loading && !st.data && <div className="is-card" style={{ marginTop: 18, color: 'var(--ink-dim)' }}>Carregando…</div>}

      {/* ══ SEÇÃO A: ORDENS & IMPRESSÃO ══ */}
      <div className="is-sec">Ordens e impressão</div>
      <div className="is-secsub">Como o sistema escolhe o envelope e monta a picklist.</div>

      {/* perguntas pendentes primeiro (é o que precisa de ação) */}
      {questions.filter((q) => q.active).length > 0 && (
        <div className="is-card" style={{ borderColor: 'var(--warn-line)', background: 'var(--warn-bg)' }}>
          <div className="is-mlabel" style={{ marginBottom: 8 }}>Perguntas pendentes de embalagem</div>
          {questions.filter((q) => q.active).map((q) => (
            <div key={q.id} style={{ marginBottom: 8 }}>
              <div style={{ fontWeight: 700, fontSize: 13.5, color: 'var(--warn-deep)' }}>{q.question}</div>
              {q.context && <div style={{ fontSize: 12, color: 'var(--ink-dim)', marginTop: 2 }}>{q.context}</div>}
              <div style={{ marginTop: 6, display: 'flex', gap: 8, alignItems: 'center' }}>
                <span className="is-chip warn">perguntada {q.asked_count}x</span>
                {q.answer && <span className="is-chip ok">respondida: {q.answer}</span>}
                <button className="is-btn sec" onClick={() => toggleQuestion(q)}>Já resolvido, desligar</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* tamanhos por cor */}
      <div className="is-card">
        <div className="is-mlabel" style={{ marginBottom: 8 }}>Tamanho do envelope por cor de garrafa</div>
        <div style={{ fontSize: 12.5, color: 'var(--ink-dim)', marginBottom: 8 }}>
          Regra do saco perfeito: sempre o menor envelope que cabe. Clique no número pra editar.
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table className="is-tbl">
            <thead><tr><th>Cor</th><th>De</th><th>Até</th><th>Envelope</th></tr></thead>
            <tbody>
              {tiers.map((t) => (
                <Row key={t.id}>
                  <td><span className="is-chip neutral">{t.bottle_color === 'black' ? 'preta' : t.bottle_color === 'white' ? 'branca' : t.bottle_color}</span></td>
                  <td><input className="is-in" defaultValue={t.min_bottles} disabled={ro}
                    onBlur={(e) => { if (Number(e.target.value) !== t.min_bottles) saveTier(t, 'min_bottles', e.target.value); }} /></td>
                  <td><input className="is-in" defaultValue={t.max_bottles == null ? '' : t.max_bottles} placeholder="∞" disabled={ro}
                    onBlur={(e) => { const v = e.target.value === '' ? null : Number(e.target.value); if (v !== t.max_bottles) saveTier(t, 'max_bottles', e.target.value); }} /></td>
                  <td><b className="mono" style={{ fontFamily: 'var(--font-mono)' }}>{t.package_size}</b>{t.is_box ? <span className="is-chip neutral" style={{ marginLeft: 6 }}>caixa</span> : null}</td>
                </Row>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* mistura preta + branca */}
      <div className="is-card">
        <div className="is-mlabel" style={{ marginBottom: 8 }}>Mistura de cores no mesmo envelope</div>
        <div style={{ fontSize: 12.5, color: 'var(--ink-dim)', marginBottom: 8 }}>
          Quantas brancas cabem junto com N pretas. Linha amarela = suposição, precisa confirmar na prática.
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table className="is-tbl">
            <thead><tr><th>Envelope</th><th>Pretas</th><th>Brancas (até)</th><th>Status</th></tr></thead>
            <tbody>
              {mix.map((m) => (
                <Row key={m.id}>
                  <td><b style={{ fontFamily: 'var(--font-mono)' }}>{m.package_size}</b></td>
                  <td className="mono">{m.black_qty}</td>
                  <td><input className="is-in" defaultValue={m.white_max} disabled={ro}
                    onBlur={(e) => { if (Number(e.target.value) !== m.white_max) saveMix(m, e.target.value); }} /></td>
                  <td>{m.confirmed
                    ? <span className="is-chip ok">confirmado</span>
                    : <span className="is-chip warn" title={m.note || ''}>suposição</span>}</td>
                </Row>
              ))}
              {mix.length === 0 && <tr><td colSpan={4} style={{ color: 'var(--ink-faint)' }}>Nenhuma regra de mistura cadastrada.</td></tr>}
            </tbody>
          </table>
        </div>
        <div style={{ fontSize: 11.5, color: 'var(--ink-faint)', marginTop: 8 }}>
          Só o 9x12 tem regra de mistura hoje. Nos outros envelopes, pedido com cores misturadas cai em "a definir".
        </div>
      </div>

      {/* suprimentos */}
      <div className="is-card">
        <div className="is-mlabel" style={{ marginBottom: 8 }}>Suprimentos e mapa tamanho → suprimento</div>
        {supplies.length === 0 ? (
          <div className="is-todo">
            Nenhum envelope cadastrado ainda como suprimento. Cadastre os envelopes reais (4x8, 7x10, 9x12, 15x19, caixa)
            com quantidade e mínimo na aba Suprimentos da página Estoque, e ligue cada tamanho ao seu suprimento.
            Sem isso o sistema não consegue descontar envelope a cada label impressa nem avisar quando estiver acabando.
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="is-tbl">
              <thead><tr><th>Suprimento</th><th>Tipo</th><th>Qtd</th><th>Mínimo</th><th>Tamanho ligado</th></tr></thead>
              <tbody>
                {supplies.map((sp) => {
                  const link = sizeSupply.find((x) => x.supply_item_id === sp.id);
                  return (
                    <Row key={sp.id}>
                      <td><b>{sp.name}</b></td>
                      <td style={{ color: 'var(--ink-dim)' }}>{sp.kind}</td>
                      <td className="mono">{sp.qty}</td>
                      <td className="mono">{sp.min_qty}</td>
                      <td>{link ? <span className="is-chip neutral">{link.package_size}</span> : <span className="is-chip warn">sem ligação</span>}</td>
                    </Row>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ══ SEÇÃO B: INVENTÁRIO & ESTOQUE ══ */}
      <div className="is-sec">Inventário e estoque</div>
      <div className="is-secsub">Onde as garrafas ficam e quando avisar que está acabando. Ainda não construído.</div>

      <div className="is-card">
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
          <span className={'is-chip ' + (nBins ? 'ok' : 'bad')}>{nBins} bins cadastrados</span>
          <span className={'is-chip ' + (nThresholds ? 'ok' : 'neutral')}>{nThresholds} limiares de estoque</span>
        </div>
        <div className="is-todo">
          <b style={{ color: 'var(--ink)' }}>O que falta construir aqui:</b>
          <ul style={{ margin: '8px 0 0 18px', padding: 0, lineHeight: 1.7 }}>
            <li><b>Bins e locais</b> — cadastrar prateleira, bin e palete de cada produto. É o que falta pra picklist e etiqueta mostrarem o local em vez de "a definir".</li>
            <li><b>Limiares de estoque baixo</b> — por produto, quando avisar. Hoje o padrão é 25 garrafas ou menos que o necessário do dia.</li>
            <li><b>Contagem por bin (cycle counting)</b> — contar 1 ou 2 bins por dia em vez de um inventário gigante por ano.</li>
            <li><b>Botão "peguei do estoque"</b> — registrar saída fora do fluxo normal, com motivo.</li>
            <li><b>Reconciliação</b> — comparar o que saiu do físico com o que as etiquetas justificam.</li>
          </ul>
        </div>
      </div>
    </div>
  );
}
