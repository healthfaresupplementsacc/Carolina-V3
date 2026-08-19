/* Página "Configurações de Inventário" (Bruno 08-07).
   Duas seções, como o Bruno pediu:
     (A) ORDENS & IMPRESSÃO — tamanhos de envelope por cor, mistura preta+branca,
         suprimentos, mapa tamanho→suprimento, perguntas pendentes de embalagem.
     (B) INVENTÁRIO & ESTOQUE — bins, limiares (ainda não construído de verdade;
         mostra o estado atual e o que falta).
   Fonte: /api/v3/data/inventory-settings. Segue o STYLE-KIT (sem travessão). */
import React from 'react';
import { usePoll, apiPost } from '../adapters/from-api.js';
import * as wh from '../adapters/warehouse-api.js';
import { V4_ALLOW_WRITES } from '../flags.js';

/* Esta página nasceu (08-07) com uma CÓPIA dos tokens do kit e recipes .is-*
   próprias. Isso é o que a auditoria de 08-19 chamou de segundo design system:
   os valores eram quase iguais, então a diferença só aparecia quando o kit
   mudava e esta tela ficava pra trás.
   Agora sobra só o que é REALMENTE desta página (o layout do root e a caixa
   pontilhada de "ainda não construído"); tudo que existe no kit virou alias
   fino apontando pras mesmas variáveis de kit.css, sem redeclarar cor nenhuma.
   As classes .is-* ficam nos JSX pra não reescrever a página inteira: o que
   muda é de onde vem a aparência. */
const KIT = `
.is-root{ min-height:100%; padding:30px 26px 70px; font-family:var(--font); color:var(--ink); }
.is-eyebrow{font:500 10px var(--font-mono);letter-spacing:.14em;text-transform:uppercase;color:var(--green-d)}
.is-h1{font-family:var(--font-display);font-weight:400;font-size:clamp(26px,2.6vw,34px);color:var(--primary-deep);margin:4px 0 2px;line-height:1.12}
.is-h1 em{color:var(--green-d);font-style:italic}
.is-sub{color:var(--ink-dim);font-size:13.5px}
.is-sec{font-family:var(--font-display);font-weight:400;font-size:20px;color:var(--primary-deep);margin:26px 0 2px}
.is-secsub{color:var(--ink-dim);font-size:12.5px;margin-bottom:12px}
.is-card{background:var(--kit-surface);border:1px solid var(--line);border-radius:var(--r-lg);box-shadow:var(--shadow-card);padding:18px 20px;margin-bottom:14px}
.is-mlabel{font:500 10px var(--font-mono);letter-spacing:.14em;text-transform:uppercase;color:var(--ink-faint)}
.is-todo{background:var(--kit-surface-2);border:1px dashed var(--line-strong);border-radius:var(--r-md);padding:14px 16px;color:var(--ink-dim);font-size:13px}
`;

function Row({ children }) { return <tr>{children}</tr>; }

/* ── Taras padrão (S15 Fase 3) ────────────────────────────────────
   Tara = peso do recipiente vazio, em gramas. Sem ela a balança não vira
   contador: pesa bruto, tira a tara, divide pelo peso da garrafa.
   Aqui ficam os padrões reutilizáveis ("caixa grande", "bandeja azul"), pra
   não redigitar o mesmo peso em cada prateleira. O peso específico de uma
   prateleira ou caixa continua sendo editado na página Locais. */
function TarePresets({ ro, ack }) {
  const [st, setSt] = React.useState({ loading: true, tares: [], error: null });
  const [form, setForm] = React.useState({ name: '', kind: 'bin', tare_g: '' });
  const [busy, setBusy] = React.useState(false);

  const load = React.useCallback(() => {
    wh.getWeights().then(
      (j) => setSt({ loading: false, tares: (j.data && j.data.tares) || [], error: null }),
      (e) => setSt({ loading: false, tares: [], error: e }),
    );
  }, []);
  React.useEffect(() => { load(); }, [load]);

  async function add() {
    setBusy(true);
    try {
      await wh.setTarePreset({ name: form.name.trim(), kind: form.kind, tare_g: Number(form.tare_g) });
      ack('tara salva');
      setForm({ name: '', kind: 'bin', tare_g: '' });
      load();
    } catch (e) { ack('erro: ' + (e.message || e)); }
    finally { setBusy(false); }
  }

  async function update(t, patch) {
    try { await wh.setTarePreset({ name: t.name, kind: t.kind, tare_g: t.tare_g, ...patch }); ack('tara salva'); load(); }
    catch (e) { ack('erro: ' + (e.message || e)); }
  }

  const valid = form.name.trim() && Number(form.tare_g) > 0;

  return (
    <div className="is-card" data-section="taras">
      <div className="is-mlabel" style={{ marginBottom: 8 }}>Taras padrão (peso do recipiente vazio)</div>
      <div style={{ fontSize: 12.5, color: 'var(--ink-dim)', marginBottom: 10 }}>
        Pesar pra contar só funciona com a tara certa. Cadastre aqui os recipientes que se repetem e reaproveite
        em cada prateleira ou caixa, em vez de redigitar o peso toda vez.
      </div>

      {st.error && <div className="is-todo" style={{ marginBottom: 10 }}>Não deu pra carregar as taras: {st.error.message}</div>}

      <div style={{ overflowX: 'auto' }}>
        <table className="kit-table" data-table="taras">
          <thead><tr><th>Nome</th><th>Serve pra</th><th>Tara (g)</th><th>Status</th></tr></thead>
          <tbody>
            {st.tares.map((t) => (
              <Row key={t.id || t.name}>
                <td><b>{t.name}</b></td>
                <td><span className="kit-chip neutral">{t.kind === 'box' ? 'caixa' : 'prateleira'}</span></td>
                <td>
                  <input className="kit-input mono cell" defaultValue={t.tare_g} disabled={ro}
                         onBlur={(e) => { const v = Number(e.target.value); if (v && v !== Number(t.tare_g)) update(t, { tare_g: v }); }} />
                </td>
                <td>{t.active === false
                  ? <span className="kit-chip warn">desativada</span>
                  : <span className="kit-chip ok">em uso</span>}</td>
              </Row>
            ))}
            {!st.tares.length && !st.loading && (
              <tr><td colSpan={4} style={{ color: 'var(--ink-faint)' }}>
                Nenhuma tara cadastrada ainda. Pese um recipiente vazio e cadastre abaixo.
              </td></tr>
            )}
          </tbody>
        </table>
      </div>

      {!ro && (
        <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap', alignItems: 'center' }}>
          <input className="kit-input mono" style={{ width: 180 }} placeholder="nome, ex: bandeja azul" value={form.name}
                 onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <select className="kit-input mono" style={{ width: 120 }} value={form.kind}
                  onChange={(e) => setForm({ ...form, kind: e.target.value })}>
            <option value="bin">prateleira</option>
            <option value="box">caixa</option>
          </select>
          <input className="kit-input mono cell" type="number" placeholder="tara g" value={form.tare_g}
                 onChange={(e) => setForm({ ...form, tare_g: e.target.value })} />
          <button className="kit-btn sm primary" disabled={busy || !valid} onClick={add}>Adicionar tara</button>
        </div>
      )}
    </div>
  );
}

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
                <span className="kit-chip warn">perguntada {q.asked_count}x</span>
                {q.answer && <span className="kit-chip ok">respondida: {q.answer}</span>}
                <button className="kit-btn sm sec" onClick={() => toggleQuestion(q)}>Já resolvido, desligar</button>
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
          <table className="kit-table">
            <thead><tr><th>Cor</th><th>De</th><th>Até</th><th>Envelope</th></tr></thead>
            <tbody>
              {tiers.map((t) => (
                <Row key={t.id}>
                  <td><span className="kit-chip neutral">{t.bottle_color === 'black' ? 'preta' : t.bottle_color === 'white' ? 'branca' : t.bottle_color}</span></td>
                  <td><input className="kit-input mono cell" defaultValue={t.min_bottles} disabled={ro}
                    onBlur={(e) => { if (Number(e.target.value) !== t.min_bottles) saveTier(t, 'min_bottles', e.target.value); }} /></td>
                  <td><input className="kit-input mono cell" defaultValue={t.max_bottles == null ? '' : t.max_bottles} placeholder="∞" disabled={ro}
                    onBlur={(e) => { const v = e.target.value === '' ? null : Number(e.target.value); if (v !== t.max_bottles) saveTier(t, 'max_bottles', e.target.value); }} /></td>
                  <td><b className="mono" style={{ fontFamily: 'var(--font-mono)' }}>{t.package_size}</b>{t.is_box ? <span className="kit-chip neutral" style={{ marginLeft: 6 }}>caixa</span> : null}</td>
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
          <table className="kit-table">
            <thead><tr><th>Envelope</th><th>Pretas</th><th>Brancas (até)</th><th>Status</th></tr></thead>
            <tbody>
              {mix.map((m) => (
                <Row key={m.id}>
                  <td><b style={{ fontFamily: 'var(--font-mono)' }}>{m.package_size}</b></td>
                  <td className="mono">{m.black_qty}</td>
                  <td><input className="kit-input mono cell" defaultValue={m.white_max} disabled={ro}
                    onBlur={(e) => { if (Number(e.target.value) !== m.white_max) saveMix(m, e.target.value); }} /></td>
                  <td>{m.confirmed
                    ? <span className="kit-chip ok">confirmado</span>
                    : <span className="kit-chip warn" title={m.note || ''}>suposição</span>}</td>
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
            <table className="kit-table">
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
                      <td>{link ? <span className="kit-chip neutral">{link.package_size}</span> : <span className="kit-chip warn">sem ligação</span>}</td>
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
      <div className="is-secsub">Onde as garrafas ficam, quanto pesa cada recipiente e quando avisar que está acabando.</div>

      <TarePresets ro={ro} ack={ack} />

      <div className="is-card">
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
          <span className={'kit-chip ' + (nBins ? 'ok' : 'bad')}>{nBins} bins cadastrados</span>
          <span className={'kit-chip ' + (nThresholds ? 'ok' : 'neutral')}>{nThresholds} limiares de estoque</span>
        </div>
        <div className="is-todo">
          <b style={{ color: 'var(--ink)' }}>Onde cada coisa mora agora:</b>
          <ul style={{ margin: '8px 0 0 18px', padding: 0, lineHeight: 1.7 }}>
            <li><b>Bins, caixas e locais</b> — cadastro na página <a href="#estoque-locais">Locais</a>, com tara, capacidade, lote e lacre. É o que faz picklist e etiqueta mostrarem o local em vez de "a definir".</li>
            <li><b>Etiquetas de local</b> — <a href="#estoque-etiquetas">Etiquetas</a> imprime 4x6 com código grande, Code 128 e QR.</li>
            <li><b>Peso da garrafa</b> — coluna "Peso da unidade" no <a href="#produto-setup">Product Setup</a>, com Calibrar pela balança.</li>
            <li><b>Botão "peguei do estoque"</b> — já existe na página dos operadores, vira proposta e cai em <a href="#estoque-aprovacoes">Aprovações</a>.</li>
            <li><b>Limiares de estoque baixo</b> — por produto, quando avisar. Hoje o padrão é 25 garrafas ou menos que o necessário do dia.</li>
            <li><b>Reconciliação</b> — comparar o que saiu do físico com o que as etiquetas justificam. Ainda não construído.</li>
          </ul>
        </div>
      </div>
    </div>
  );
}
