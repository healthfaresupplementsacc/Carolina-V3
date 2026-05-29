/* Bloco 28/mai noite Leva B (item 7) — porta o "Falar como Carolina"
 * do /dashboard atual pro V4.
 *
 * Backend reusado integralmente (mesmas rotas /api/v3/data/{send, react,
 * sender-profiles*, sent-history}). UI redesenhada no padrão V4:
 *   - FalarCarolina: componente puro com toda a UI (form + personas + hist).
 *     Usado tanto em FalarPage (página inteira) quanto em FloatingPopover
 *     via FalarCarolinaButton (topbar).
 *   - FalarCarolinaButton: botão pro topbar com FloatingPopover (above).
 *
 * Sem cortar features do original:
 *   - markdown buttons (B/I/code/strikethrough)
 *   - mention buttons (Vitor/Simone/Ana/Henrique)
 *   - imagem inline (max 8MB) com preview
 *   - thread reply (link Slack ou ts cru)
 *   - persona dropdown (sender_profiles) + CRUD personas
 *   - confirmação dupla (botão "Enviar" → "Confirmar envio")
 *   - histórico de envios (últimas 15)
 *   - react form (emoji reaction em msg existente)
 */
import React from 'react';
import { Icon } from '../components/Icons.jsx';
import { FloatingPopover } from '../components/FloatingPopover.jsx';
import { apiGet, apiPost, apiPatch, apiDelete } from '../adapters/from-api.js';

const CH_OPTIONS = [
  { value: 'production', label: 'Produção · #orders-and-inventory' },
  { value: 'admin',      label: 'Admin · #admin-orin' },
];

// Mentions hardcoded (mesma fonte do /dashboard atual). TODO E5+: pull do catálogo.
const MENTION_LIST = [
  { id: 'U08JC85HMNE', name: 'Vitor' },
  { id: 'U07FG34TMPF', name: 'Simone' },
  { id: 'U0AU8N8FA00', name: 'Ana' },
  { id: 'U085SDY3F4Z', name: 'Henrique' },
];

const MRKDWN_BTNS = [
  { label: 'B', wrap: '*', title: 'negrito *texto*' },
  { label: 'I', wrap: '_', title: 'itálico _texto_' },
  { label: '`', wrap: '`', title: 'código `texto`' },
  { label: 'S', wrap: '~', title: 'tachado ~texto~' },
];

function useFalarState(ack) {
  const [tick, setTick]           = React.useState(0);
  const [profiles, setProfiles]   = React.useState(null);
  const [history, setHistory]     = React.useState(null);
  const [loadingP, setLoadingP]   = React.useState(true);
  const [loadingH, setLoadingH]   = React.useState(true);
  const refresh = () => setTick((t) => t + 1);
  React.useEffect(() => {
    let alive = true;
    setLoadingP(true); setLoadingH(true);
    apiGet('/sender-profiles').then(
      (j) => { if (alive) { setProfiles((j && j.data && j.data.profiles) || []); setLoadingP(false); } },
      (e) => { if (alive) { setProfiles([]); setLoadingP(false); ack && ack('Erro carregando personas: ' + e.message); } },
    );
    apiGet('/sent-history?limit=15').then(
      (j) => { if (alive) { setHistory((j && j.data && j.data.posts) || []); setLoadingH(false); } },
      (e) => { if (alive) { setHistory([]); setLoadingH(false); ack && ack('Erro carregando histórico: ' + e.message); } },
    );
    return () => { alive = false; };
  }, [tick]);
  return { profiles, history, loadingP, loadingH, refresh };
}

/** Componente principal — a UI completa do Falar. Pode ser embutida na page
 *  inteira (FalarPage) ou dentro de FloatingPopover via FalarCarolinaButton. */
function FalarCarolina({ ack, compact = false }) {
  const { profiles, history, loadingP, loadingH, refresh } = useFalarState(ack);
  const [text, setText]       = React.useState('');
  const [channel, setChannel] = React.useState('production');
  const [senderId, setSenderId] = React.useState('');
  const [imageData, setImageData] = React.useState(null);
  const [threadTs, setThreadTs]   = React.useState('');
  const [confirming, setConfirming] = React.useState(false);
  const [sending, setSending] = React.useState(false);
  const [err, setErr]         = React.useState(null);
  const [editingProfile, setEditingProfile] = React.useState(null);  // 'new' | profile
  const textRef = React.useRef(null);

  const profileList = profiles || [];
  const selectedProfile = profileList.find((p) => String(p.id) === String(senderId))
    || profileList.find((p) => p.is_default)
    || profileList[0];

  React.useEffect(() => {
    if (!senderId && selectedProfile) setSenderId(String(selectedProfile.id));
  }, [selectedProfile, senderId]);

  function onPickImage(e) {
    const f = e.target.files && e.target.files[0];
    if (!f) { setImageData(null); return; }
    if (f.size > 8 * 1024 * 1024) { setErr('imagem grande demais (max 8MB).'); return; }
    const reader = new FileReader();
    reader.onload = () => setImageData({
      dataUrl: reader.result, filename: f.name, sizeKB: Math.round(f.size / 1024),
    });
    reader.readAsDataURL(f);
    setErr(null);
  }

  async function onSend() {
    if (!selectedProfile) return setErr('Escolha uma persona.');
    if (!text && !imageData) return setErr('Texto ou imagem obrigatório.');
    if (!confirming) { setConfirming(true); return; }
    setSending(true); setErr(null);
    try {
      const payload = {
        channel,
        sender_name: selectedProfile.name,
        sender_icon: selectedProfile.icon || null,
        text: text || null,
        image: imageData ? { dataUrl: imageData.dataUrl, filename: imageData.filename } : null,
        thread_ts: threadTs.trim() || null,
      };
      const r = await apiPost('/send', payload);
      const d = (r && r.data) || {};
      let msg = `Enviado como "${selectedProfile.name}" em ${channel}. ts=${d.ts || '?'}`;
      if (d.thread_ts) msg += ' (em thread)';
      if (imageData && !d.image_inline) msg += ' ⚠ imagem como link';
      ack && ack(msg);
      if (d.image_warning) console.warn('[falar]', d.image_warning);
      setText(''); setImageData(null); setThreadTs(''); setConfirming(false);
      refresh();
    } catch (e) { setErr(e.message); setConfirming(false); }
    finally { setSending(false); }
  }

  function insertAtCursor(snippet) {
    const ta = textRef.current;
    if (!ta) { setText((t) => t + snippet); return; }
    const start = ta.selectionStart || 0;
    const end   = ta.selectionEnd   || 0;
    const before = text.slice(0, start);
    const after  = text.slice(end);
    setText(before + snippet + after);
    requestAnimationFrame(() => {
      ta.focus();
      const p = start + snippet.length;
      try { ta.setSelectionRange(p, p); } catch (_) { /* ok */ }
    });
  }
  function wrapSelection(wrap) {
    const ta = textRef.current;
    if (!ta) { insertAtCursor(wrap + wrap); return; }
    const start = ta.selectionStart || 0;
    const end   = ta.selectionEnd   || 0;
    const sel = text.slice(start, end);
    const before = text.slice(0, start);
    const after  = text.slice(end);
    if (sel) {
      setText(before + wrap + sel + wrap + after);
      requestAnimationFrame(() => {
        ta.focus();
        try { ta.setSelectionRange(start + wrap.length, end + wrap.length); } catch (_) { /* ok */ }
      });
    } else {
      insertAtCursor(wrap + wrap);
    }
  }

  const labelStyle = { display: 'block', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.06, color: 'var(--text-3)', marginBottom: 4 };
  const fieldGap   = { marginBottom: 10 };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: compact ? 8 : 12 }}>
      {/* Form ─────────────────────────────────────── */}
      <form onSubmit={(e) => { e.preventDefault(); onSend(); }}
            style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, ...fieldGap }}>
          <label>
            <span style={labelStyle}>Persona</span>
            <select className="input" value={senderId} disabled={loadingP}
                    onChange={(e) => { setSenderId(e.target.value); setConfirming(false); }}>
              {profileList.length === 0 && <option>(carregando…)</option>}
              {profileList.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}{p.is_default ? ' ★' : ''}{p.icon ? ' ' + p.icon : ''}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span style={labelStyle}>Canal</span>
            <select className="input" value={channel}
                    onChange={(e) => { setChannel(e.target.value); setConfirming(false); }}>
              {CH_OPTIONS.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
            </select>
          </label>
        </div>

        <div style={fieldGap}>
          <span style={labelStyle}>
            Texto <span style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0, color: 'var(--text-3)' }}>
              · mrkdwn: *negrito* _itálico_ `code`
            </span>
          </span>
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 4 }}>
            {MRKDWN_BTNS.map((b) => (
              <button key={b.label} type="button" className="btn sm ghost"
                      title={b.title} onClick={() => wrapSelection(b.wrap)}
                      style={{ minWidth: 28, padding: '2px 8px', fontWeight: 700 }}>
                {b.label}
              </button>
            ))}
            <span style={{ alignSelf: 'center', color: 'var(--text-3)', fontSize: 11, margin: '0 4px' }}>@:</span>
            {MENTION_LIST.map((u) => (
              <button key={u.id} type="button" className="btn sm ghost"
                      title={'menciona ' + u.name + ' (insere <@' + u.id + '>)'}
                      onClick={() => insertAtCursor('<@' + u.id + '> ')}
                      style={{ padding: '2px 8px' }}>
                {u.name}
              </button>
            ))}
          </div>
          <textarea ref={textRef} rows={compact ? 3 : 4} className="input"
                    value={text} onChange={(e) => { setText(e.target.value); setConfirming(false); }}
                    placeholder="escreva a mensagem — *bold* _itálico_ <@USER>…"/>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, ...fieldGap }}>
          <label>
            <span style={labelStyle}>Imagem (opcional · max 8MB)</span>
            <input type="file" accept="image/*" onChange={onPickImage}
                   style={{ fontSize: 12 }}/>
            {imageData && (
              <div style={{ fontSize: 10.5, color: 'var(--text-3)', marginTop: 2 }}>
                {imageData.filename} · {imageData.sizeKB} KB · {' '}
                <a href="#" onClick={(e) => { e.preventDefault(); setImageData(null); }}>remover</a>
              </div>
            )}
          </label>
          <label>
            <span style={labelStyle}>Thread (link Slack ou ts cru — opcional)</span>
            <input type="text" className="input" value={threadTs}
                   onChange={(e) => { setThreadTs(e.target.value); setConfirming(false); }}
                   placeholder="https://…/p1748… ou 1748121234.567890"/>
          </label>
        </div>

        {/* PREVIEW */}
        {(text || imageData) && selectedProfile && (
          <div style={{
            border: '1px dashed var(--border)', borderRadius: 8, padding: 10, marginBottom: 10,
            background: 'var(--surface-2)',
          }}>
            <div style={{ fontSize: 10, color: 'var(--text-3)', marginBottom: 4 }}>preview:</div>
            <div>
              <b style={{ fontSize: 12.5 }}>{selectedProfile.name}</b>
              {selectedProfile.icon && <span style={{ color: 'var(--text-3)', fontSize: 11, marginLeft: 4 }}>{selectedProfile.icon}</span>}
            </div>
            {text && (
              <pre style={{ margin: '4px 0', whiteSpace: 'pre-wrap', fontFamily: 'inherit', fontSize: 12 }}>{text}</pre>
            )}
            {imageData && (
              <img src={imageData.dataUrl} alt="" style={{ maxWidth: '100%', maxHeight: 200, borderRadius: 6, marginTop: 6 }}/>
            )}
            <div style={{ fontSize: 10, color: 'var(--text-3)', marginTop: 4 }}>
              → {CH_OPTIONS.find((c) => c.value === channel).label}
            </div>
          </div>
        )}

        {err && (
          <div style={{ padding: 8, background: 'rgba(220,38,38,0.08)', borderRadius: 6, fontSize: 12, color: 'var(--bad)', marginBottom: 8 }}>
            erro: {err}
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button type="submit" className={`btn primary${confirming ? ' warn' : ''}`}
                  disabled={sending}
                  style={confirming ? { background: 'var(--warn, #d97706)', borderColor: 'var(--warn, #d97706)' } : undefined}>
            {sending ? '…' : (confirming ? '✓ Confirmar envio' : 'Enviar')}
          </button>
          {confirming && (
            <button type="button" className="btn ghost" disabled={sending}
                    onClick={() => setConfirming(false)}>Cancelar</button>
          )}
          <span style={{ flex: 1 }}/>
          <span style={{ fontSize: 10.5, color: 'var(--text-3)', fontStyle: 'italic' }}>
            envio é manual + audited
          </span>
        </div>
      </form>

      {/* PERSONAS — só no full-page; compact esconde */}
      {!compact && (
        <div style={{ borderTop: '1px solid var(--border)', paddingTop: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <b style={{ fontSize: 12 }}>Personas</b>
            <span style={{ flex: 1 }}/>
            <button className="btn sm primary" onClick={() => setEditingProfile('new')}>+ nova</button>
          </div>
          {loadingP
            ? <div style={{ fontSize: 11, color: 'var(--text-3)' }}>carregando…</div>
            : profileList.length === 0
              ? <div style={{ fontSize: 11, color: 'var(--text-3)' }}>nenhuma persona</div>
              : (
                <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {profileList.map((p) => (
                    <li key={p.id} style={{
                      display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px',
                      background: 'var(--surface-2)', borderRadius: 6, fontSize: 12,
                    }}>
                      <b>{p.name}</b>
                      {p.is_default && <span title="default" style={{ color: 'var(--hf-leaf-600)' }}>★</span>}
                      {p.icon && <span style={{ color: 'var(--text-3)', fontSize: 11 }}>{p.icon}</span>}
                      <span style={{ flex: 1 }}/>
                      {!p.is_default && (
                        <button className="btn sm ghost" style={{ padding: '2px 6px', fontSize: 11 }}
                                onClick={async () => {
                                  try { await apiPost(`/sender-profiles/${p.id}/set-default`, {}); refresh(); }
                                  catch (e) { ack && ack('erro: ' + e.message); }
                                }}>★ default</button>
                      )}
                      <button className="btn sm ghost" style={{ padding: '2px 6px', fontSize: 11 }}
                              onClick={() => setEditingProfile(p)}>editar</button>
                      {!p.is_default && (
                        <button className="btn sm ghost" style={{ padding: '2px 6px', fontSize: 11, color: 'var(--bad)' }}
                                onClick={async () => {
                                  if (!window.confirm(`Apagar persona "${p.name}"?`)) return;
                                  try { await apiDelete(`/sender-profiles/${p.id}`); refresh();
                                    ack && ack(`Persona "${p.name}" apagada`); }
                                  catch (e) { ack && ack('erro: ' + e.message); }
                                }}>apagar</button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
        </div>
      )}

      {/* REAGIR — só no full-page */}
      {!compact && <ReactForm ack={ack} refresh={refresh}/>}

      {/* HISTÓRICO */}
      <div style={{ borderTop: '1px solid var(--border)', paddingTop: 10 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: 0.06, marginBottom: 6 }}>
          Histórico (últimos 15)
        </div>
        {loadingH
          ? <div style={{ fontSize: 11, color: 'var(--text-3)' }}>carregando…</div>
          : (history || []).length === 0
            ? <div style={{ fontSize: 11, color: 'var(--text-3)', fontStyle: 'italic' }}>nada enviado ainda</div>
            : (
              <div style={{ maxHeight: compact ? 180 : 320, overflow: 'auto', border: '1px solid var(--border)', borderRadius: 6 }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                  <thead>
                    <tr style={{ background: 'var(--surface-2)', position: 'sticky', top: 0 }}>
                      <th style={{ padding: '4px 6px', textAlign: 'left' }}>quando</th>
                      <th style={{ padding: '4px 6px', textAlign: 'left' }}>tipo</th>
                      <th style={{ padding: '4px 6px', textAlign: 'left' }}>persona</th>
                      <th style={{ padding: '4px 6px', textAlign: 'left' }}>canal</th>
                      <th style={{ padding: '4px 6px', textAlign: 'left' }}>texto/emoji</th>
                      <th style={{ padding: '4px 6px' }}>img</th>
                      <th style={{ padding: '4px 6px' }}>thr</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(history || []).map((p) => {
                      const m = p.metadata || {};
                      const isReact = p.action === 'manual_post.reacted';
                      return (
                        <tr key={p.id} style={{ borderTop: '1px solid var(--border)' }}>
                          <td style={{ padding: '3px 6px', color: 'var(--text-3)', whiteSpace: 'nowrap' }}>
                            {new Date(p.created_at).toLocaleString('pt-BR', { hour12: false, dateStyle: 'short', timeStyle: 'short' })}
                          </td>
                          <td style={{ padding: '3px 6px' }}>{isReact ? '⚛' : '✉'}</td>
                          <td style={{ padding: '3px 6px' }}>{m.sender_name || (isReact ? '—' : '?')}</td>
                          <td style={{ padding: '3px 6px', color: 'var(--text-3)' }}>{(m.channel || '').slice(0, 11)}</td>
                          <td style={{ padding: '3px 6px', maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                              title={m.text_preview || m.emoji || ''}>
                            {isReact ? ':' + (m.emoji || '?') + ':' : (m.text_preview || '').slice(0, 80)}
                          </td>
                          <td style={{ padding: '3px 6px', textAlign: 'center' }}>
                            {m.has_image ? (m.image_inline ? '🖼' : (m.image_permalink ? <a href={m.image_permalink} target="_blank" rel="noreferrer">📎</a> : '📎')) : '—'}
                          </td>
                          <td style={{ padding: '3px 6px', textAlign: 'center' }}>{m.thread_ts ? '🧵' : '—'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
      </div>

      {editingProfile && (
        <PersonaEditModal
          profile={editingProfile === 'new' ? null : editingProfile}
          onClose={() => setEditingProfile(null)}
          onDone={(msg) => { setEditingProfile(null); refresh(); ack && ack(msg); }}/>
      )}
    </div>
  );
}

/* Reagir a uma msg existente — emoji reaction (não permite persona override
 * porque reactions.add é só com bot real; bem útil pra "confirmar visto"). */
function ReactForm({ ack, refresh }) {
  const [channel, setChannel] = React.useState('production');
  const [ts, setTs]   = React.useState('');
  const [emoji, setEmoji] = React.useState('white_check_mark');
  const [busy, setBusy]   = React.useState(false);
  const [err, setErr]     = React.useState(null);

  async function go(e) {
    e && e.preventDefault();
    if (!ts.trim()) return setErr('cola o link da msg ou o ts cru.');
    if (!emoji.trim()) return setErr('escolhe um emoji.');
    setBusy(true); setErr(null);
    try {
      const r = await apiPost('/react', {
        channel, ts: ts.trim(), emoji: emoji.replace(/^:|:$/g, '').trim(),
      });
      const d = (r && r.data) || {};
      ack && ack(`Reagiu :${d.emoji || emoji}: em ${channel} (ts=${d.ts || '?'})`);
      setTs(''); refresh();
    } catch (e2) { setErr(e2.message); }
    finally { setBusy(false); }
  }
  const labelStyle = { display: 'block', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.06, color: 'var(--text-3)', marginBottom: 4 };

  return (
    <div style={{ borderTop: '1px solid var(--border)', paddingTop: 10 }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: 0.06, marginBottom: 6 }}>
        Reagir com emoji
      </div>
      <form onSubmit={go} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          <label>
            <span style={labelStyle}>Canal</span>
            <select className="input" value={channel} onChange={(e) => setChannel(e.target.value)}>
              {CH_OPTIONS.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
            </select>
          </label>
          <label>
            <span style={labelStyle}>Emoji (sem dois-pontos)</span>
            <input type="text" className="input" value={emoji}
                   onChange={(e) => setEmoji(e.target.value)}
                   placeholder="white_check_mark"/>
          </label>
        </div>
        <label>
          <span style={labelStyle}>Mensagem alvo (link Slack ou ts)</span>
          <input type="text" className="input" value={ts}
                 onChange={(e) => setTs(e.target.value)}
                 placeholder="https://…/p1748… ou 1748121234.567890"/>
        </label>
        {err && <div style={{ fontSize: 11, color: 'var(--bad)' }}>{err}</div>}
        <div>
          <button type="submit" className="btn sm primary" disabled={busy}>
            {busy ? '…' : 'Reagir'}
          </button>
          <span style={{ fontSize: 10.5, color: 'var(--text-3)', marginLeft: 8, fontStyle: 'italic' }}>
            (reação aparece como bot real — Slack não permite override no reactions.add)
          </span>
        </div>
      </form>
    </div>
  );
}

/** Modal CRUD pra criar/editar persona. Usa FloatingPopover padrão. */
function PersonaEditModal({ profile, onClose, onDone }) {
  const isNew = !profile;
  const [name, setName] = React.useState(profile ? profile.name : '');
  const [icon, setIcon] = React.useState(profile ? (profile.icon || '') : '');
  const [busy, setBusy] = React.useState(false);
  const [err, setErr]   = React.useState(null);
  // Centro da tela como anchor (sem click anchor — é modal de fluxo)
  const anchor = React.useMemo(() => ({ x: window.innerWidth / 2 - 180, y: 120 }), []);

  async function go(e) {
    e && e.preventDefault();
    if (!name.trim()) { setErr('nome obrigatório'); return; }
    setBusy(true); setErr(null);
    try {
      if (isNew) {
        await apiPost('/sender-profiles', { name: name.trim(), icon: icon.trim() || null });
        onDone(`Persona "${name}" criada`);
      } else {
        await apiPatch(`/sender-profiles/${profile.id}`, { name: name.trim(), icon: icon.trim() || null });
        onDone(`Persona "${name}" atualizada`);
      }
    } catch (e2) { setErr(e2.message); setBusy(false); }
  }

  return (
    <FloatingPopover open anchor={anchor} width={380} onClose={onClose}
                     draggable
                     header={(
                       <>
                         <b style={{ flex: 1, fontSize: 12.5 }}>{isNew ? 'Nova persona' : `Editar "${profile.name}"`}</b>
                         <button className="icon-btn" onClick={onClose} style={{ padding: 4 }}>
                           <Icon name="x" size={11}/>
                         </button>
                       </>
                     )}>
      <form onSubmit={go} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <label>
          <span style={{ display: 'block', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.06, color: 'var(--text-3)', marginBottom: 4 }}>
            Nome (vira o username no Slack)
          </span>
          <input type="text" className="input" value={name} onChange={(e) => setName(e.target.value)}
                 required maxLength={80}/>
        </label>
        <label>
          <span style={{ display: 'block', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.06, color: 'var(--text-3)', marginBottom: 4 }}>
            Ícone (opcional · :emoji: ou URL)
          </span>
          <input type="text" className="input" value={icon} onChange={(e) => setIcon(e.target.value)}
                 placeholder=":wave: ou https://…/avatar.png"/>
        </label>
        {err && <div style={{ fontSize: 11, color: 'var(--bad)' }}>{err}</div>}
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="submit" className="btn primary" disabled={busy}>{busy ? '…' : 'Salvar'}</button>
          <button type="button" className="btn ghost" onClick={onClose} disabled={busy}>Cancelar</button>
        </div>
      </form>
    </FloatingPopover>
  );
}

/** Botão pra TopBar — abre o Falar dentro de FloatingPopover (compact mode). */
function FalarCarolinaButton({ ack }) {
  const [open, setOpen]     = React.useState(false);
  const [anchor, setAnchor] = React.useState(null);
  const onClick = (e) => {
    setAnchor({ x: e.clientX, y: e.clientY });
    setOpen((o) => !o);
  };
  return (
    <>
      <button className="btn ghost falar-trigger-btn"
              title="Falar como Carolina · porta de saída manual"
              onClick={onClick}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
        <Icon name="chat" size={14}/>
        <span style={{ fontSize: 12, fontWeight: 600 }}>Carolina</span>
      </button>
      <FloatingPopover
        open={open} anchor={anchor} width={520}
        onClose={() => setOpen(false)}
        anchorSelector=".falar-trigger-btn"
        draggable above
        header={(
          <>
            <Icon name="chat" size={14}/>
            <b style={{ flex: 1, fontSize: 12.5 }}>Falar como Carolina · porta manual</b>
            <button className="icon-btn" onClick={() => setOpen(false)} style={{ padding: 4 }}>
              <Icon name="x" size={11}/>
            </button>
          </>
        )}>
        <FalarCarolina ack={ack} compact/>
      </FloatingPopover>
    </>
  );
}

export { FalarCarolina, FalarCarolinaButton };
