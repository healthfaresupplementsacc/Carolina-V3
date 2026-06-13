'use strict';
/* Fase 0.7 — aba 🎤 Voices no admin: lista filtrável, stream, soft-delete + audit. */
const express = require('express');
const { createAdminRouter } = require('../routes/admin');

const PW = 'test-admin-password';
const resp = (rows) => ({ rows, rowCount: rows.length });

function makeMem() {
  return {
    voices: [
      { id: 1, event_id: 900, person_id: 4, person: 'Vitor', audio_mime: 'audio/webm', audio_duration_seconds: 5, audio_size_bytes: 1234, transcript: 'comecei a linha', transcript_language: 'pt-BR', deleted_at: null, audio_bytes: Buffer.from('AAA') },
      { id: 2, event_id: null, person_id: 7, person: 'Bruno Sarmento', audio_mime: 'audio/webm', audio_duration_seconds: 9, audio_size_bytes: 4321, transcript: 'algo especial', transcript_language: 'pt-BR', deleted_at: null, audio_bytes: Buffer.from('BBB') },
    ],
    audits: [],
  };
}

function makeDb(mem) {
  return {
    query: jest.fn(async (sql, params = []) => {
      const s = String(sql).replace(/\s+/g, ' ').trim();
      if (/INSERT INTO v3\.audit_log/.test(s)) {
        // action/target_type são literais no SQL ('voice_deleted','voice'); target_id = $1
        const m = s.match(/VALUES \('admin', NULL, '([^']+)', '([^']+)', \$1/);
        mem.audits.push({ action: m ? m[1] : params[0], target_type: m ? m[2] : params[3], target_id: m ? params[0] : params[4] });
        return resp([]);
      }
      // stream de 1 gravação
      if (/SELECT audio_bytes, audio_mime FROM v3\.voice_recordings WHERE id = \$1/.test(s)) {
        const v = mem.voices.find((x) => x.id === params[0] && !x.deleted_at);
        return resp(v ? [{ audio_bytes: v.audio_bytes, audio_mime: v.audio_mime }] : []);
      }
      // soft-delete
      if (/UPDATE v3\.voice_recordings SET deleted_at = NOW\(\) WHERE id = \$1/.test(s)) {
        const v = mem.voices.find((x) => x.id === params[0] && !x.deleted_at);
        if (!v) return resp([]);
        v.deleted_at = new Date();
        return resp([{ id: v.id, person_id: v.person_id }]);
      }
      // lista filtrável
      if (/FROM v3\.voice_recordings v JOIN v3\.persons p/.test(s)) {
        let list = mem.voices.filter((v) => !v.deleted_at);
        const me = s.match(/v\.event_id = \$(\d+)/); if (me) list = list.filter((v) => v.event_id === params[+me[1] - 1]);
        const mp = s.match(/v\.person_id = \$(\d+)/); if (mp) list = list.filter((v) => v.person_id === params[+mp[1] - 1]);
        list.sort((a, b) => b.id - a.id);
        return resp(list.map((v) => ({
          id: v.id, event_id: v.event_id, person_id: v.person_id, person: v.person,
          audio_mime: v.audio_mime, audio_duration_seconds: v.audio_duration_seconds, audio_size_bytes: v.audio_size_bytes,
          transcript: v.transcript, transcript_language: v.transcript_language, created_edt: '06-13 02:00 AM',
        })));
      }
      return resp([]);
    }),
  };
}

let server, base, mem, db, token;
async function get(path, tok) {
  const r = await fetch(base + path, { headers: tok ? { Authorization: 'Bearer ' + tok } : {} });
  let j = null; const ct = r.headers.get('content-type') || '';
  if (ct.includes('application/json')) { try { j = await r.json(); } catch (_) {} }
  return { status: r.status, body: j, ct };
}
async function del(path, tok) {
  const r = await fetch(base + path, { method: 'DELETE', headers: { Authorization: 'Bearer ' + tok } });
  let j = null; try { j = await r.json(); } catch (_) {}
  return { status: r.status, body: j };
}

beforeEach(async () => {
  if (server) await new Promise((r) => server.close(r));
  mem = makeMem(); db = makeDb(mem);
  const app = express();
  app.use('/', createAdminRouter({ db, slack: { postAs: jest.fn() }, adminPassword: PW }));
  server = await new Promise((resolve) => { const x = app.listen(0, '127.0.0.1', () => resolve(x)); });
  base = `http://127.0.0.1:${server.address().port}`;
  const r = await fetch(base + '/api/adminpanel/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PW }) });
  token = (await r.json()).token;
});
afterAll(async () => { if (server) await new Promise((r) => server.close(r)); });

describe('admin voices — Fase 0.7', () => {
  test('sem token → 401', async () => {
    expect((await get('/api/adminpanel/voice')).status).toBe(401);
  });
  test('lista todas as gravações (sem filtro)', async () => {
    const r = await get('/api/adminpanel/voice', token);
    expect(r.status).toBe(200);
    expect(r.body.voice).toHaveLength(2);
    expect(r.body.voice[0].id).toBe(2); // ordem DESC
  });
  test('filtra por person_id', async () => {
    const r = await get('/api/adminpanel/voice?person_id=4', token);
    expect(r.status).toBe(200);
    expect(r.body.voice).toHaveLength(1);
    expect(r.body.voice[0].person).toBe('Vitor');
  });
  test('filtra por event_id (admin vê voz de qualquer operador)', async () => {
    const r = await get('/api/adminpanel/voice?event_id=900', token);
    expect(r.status).toBe(200);
    expect(r.body.voice).toHaveLength(1);
    expect(r.body.voice[0].event_id).toBe(900);
  });
  test('stream retorna áudio com Content-Type correto', async () => {
    const r = await fetch(base + '/api/adminpanel/voice/1', { headers: { Authorization: 'Bearer ' + token } });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('audio/webm');
    const buf = Buffer.from(await r.arrayBuffer());
    expect(buf.toString()).toBe('AAA');
  });
  test('DELETE soft-deleta + grava audit voice_deleted', async () => {
    const r = await del('/api/adminpanel/voice/1', token);
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(mem.voices.find((v) => v.id === 1).deleted_at).toBeTruthy();
    expect(mem.audits.some((a) => a.action === 'voice_deleted' && a.target_type === 'voice' && a.target_id === 1)).toBe(true);
    // não aparece mais na lista
    const list = await get('/api/adminpanel/voice', token);
    expect(list.body.voice.some((v) => v.id === 1)).toBe(false);
  });
  test('DELETE de gravação inexistente → 404', async () => {
    expect((await del('/api/adminpanel/voice/999', token)).status).toBe(404);
  });
});
