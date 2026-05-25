'use strict';
// HEALTHFARE V3 — testes do SenderService + helper postAs.
const { SenderService } = require('../v3/services/SenderService');
const { resolveChannel, extractPermalink } = require('../v3/slack/sender');

function makeFakeDb() {
  const audit = [];
  return {
    audit,
    query: jest.fn(async (sql, params) => {
      if (/INSERT INTO v3\.audit_log/.test(sql)) {
        const meta = params[2] ? JSON.parse(params[2]) : null;
        audit.push({ actor_type: params[0], actor_person_id: params[1], metadata: meta });
        return { rows: [{ id: audit.length }] };
      }
      if (/FROM v3\.audit_log\s+WHERE action = 'manual_post.sent'/.test(sql)) {
        return { rows: audit.map((a, i) => ({
          id: i + 1, created_at: new Date(), actor_type: a.actor_type,
          actor_person_id: a.actor_person_id, metadata: a.metadata,
        })) };
      }
      return { rows: [] };
    }),
  };
}

describe('V3 sender — resolveChannel', () => {
  test('aliases conhecidos', () => {
    expect(resolveChannel('production')).toMatch(/^C/);
    expect(resolveChannel('admin')).toMatch(/^C/);
  });
  test('aceita id Slack cru', () => {
    expect(resolveChannel('C0B36DR5MP1')).toBe('C0B36DR5MP1');
    expect(resolveChannel('G1234567890')).toBe('G1234567890');
  });
  test('rejeita lixo', () => {
    expect(() => resolveChannel('Z123')).toThrow(/inválido/);
    expect(() => resolveChannel('')).toThrow();
    expect(() => resolveChannel(null)).toThrow();
  });
});

describe('V3 sender — extractPermalink (handle SDK shapes)', () => {
  test('SDK clássico: { file: { permalink } }', () => {
    expect(extractPermalink({ file: { permalink: 'https://x/p1' } })).toBe('https://x/p1');
  });
  test('SDK uploadV2: { files: [{ permalink }] }', () => {
    expect(extractPermalink({ files: [{ permalink: 'https://x/p2' }] })).toBe('https://x/p2');
  });
  test('SDK uploadV2 nested: { files: [{ files: [{ permalink }] }] }', () => {
    expect(extractPermalink({ files: [{ files: [{ permalink: 'https://x/p3' }] }] })).toBe('https://x/p3');
  });
  test('vazio → null', () => {
    expect(extractPermalink(null)).toBeNull();
    expect(extractPermalink({})).toBeNull();
  });
});

describe('V3 SenderService.send', () => {
  test('valida campos obrigatórios', async () => {
    const db = makeFakeDb();
    const s = new SenderService({ db, postFn: jest.fn() });
    await expect(s.send({ channel: 'production', sender: { name: 'X' } })).rejects.toThrow(/text ou image/);
    await expect(s.send({ channel: 'production', text: 'oi' })).rejects.toThrow(/sender\.name/);
    await expect(s.send({ text: 'oi', sender: { name: 'X' } })).rejects.toThrow(/channel/);
  });

  test('happy path: chama postFn e grava audit manual_post.sent', async () => {
    const db = makeFakeDb();
    const postFn = jest.fn(async () => ({ ok: true, ts: '1111.2222', channel: 'C09UNBXFRKK' }));
    const s = new SenderService({ db, postFn });
    const out = await s.send({
      channel: 'production', text: 'olá time',
      sender: { name: 'Carolina', icon: ':wave:' },
    });
    expect(postFn).toHaveBeenCalledTimes(1);
    expect(postFn.mock.calls[0][0]).toMatchObject({
      channel: 'production',
      text: 'olá time',
      sender: { name: 'Carolina', icon: ':wave:' },
    });
    expect(out.ts).toBe('1111.2222');
    expect(out.audit_id).toBe(1);
    expect(db.audit).toHaveLength(1);
    expect(db.audit[0].actor_type).toBe('admin');
    expect(db.audit[0].metadata).toMatchObject({
      channel: 'C09UNBXFRKK',
      slack_ts: '1111.2222',
      sender_name: 'Carolina',
      sender_icon: ':wave:',
      has_image: false,
      text_len: 8,
    });
  });

  test('com imagem: metadata captura has_image + permalink', async () => {
    const db = makeFakeDb();
    const postFn = jest.fn(async () => ({
      ok: true, ts: '2222.3333', channel: 'C0B36DR5MP1',
      image_permalink: 'https://slack/img.png',
    }));
    const s = new SenderService({ db, postFn });
    await s.send({
      channel: 'admin', text: null,
      sender: { name: 'Carolina' },
      image: { dataUrl: 'data:image/png;base64,AAAA', filename: 'foto.png' },
    });
    expect(db.audit[0].metadata).toMatchObject({
      has_image: true, image_filename: 'foto.png',
      image_permalink: 'https://slack/img.png',
    });
  });

  test('falha no Slack NÃO grava audit (rastro só de posts efetivos)', async () => {
    const db = makeFakeDb();
    const postFn = jest.fn(async () => { throw new Error('rate_limited'); });
    const s = new SenderService({ db, postFn });
    await expect(s.send({
      channel: 'production', text: 'oi',
      sender: { name: 'Carolina' },
    })).rejects.toThrow('rate_limited');
    expect(db.audit).toHaveLength(0);
  });

  test('recentPosts lê audit_log filtrado por action', async () => {
    const db = makeFakeDb();
    const postFn = jest.fn(async () => ({ ok: true, ts: 't1', channel: 'C0' }));
    const s = new SenderService({ db, postFn });
    await s.send({ channel: 'production', text: 'a', sender: { name: 'Carolina' } });
    await s.send({ channel: 'admin', text: 'b', sender: { name: 'Carolina' } });
    const hist = await s.recentPosts(10);
    expect(hist.posts).toHaveLength(2);
  });
});
