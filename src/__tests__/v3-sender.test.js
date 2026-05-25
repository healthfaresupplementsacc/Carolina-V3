'use strict';
// HEALTHFARE V3 — testes do SenderService + helper postAs.
const { SenderService } = require('../v3/services/SenderService');
const { resolveChannel, extractPermalink, extractPubSecret, parseSlackTs } = require('../v3/slack/sender');

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
      if (/FROM v3\.audit_log\s+WHERE action IN \('manual_post\.sent'/.test(sql)
          || /FROM v3\.audit_log\s+WHERE action = 'manual_post\.sent'/.test(sql)) {
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

describe('V3 sender — parseSlackTs', () => {
  test('ts cru passa direto', () => {
    expect(parseSlackTs('1748121234.567890')).toBe('1748121234.567890');
  });
  test('link Slack vira ts no formato com ponto', () => {
    expect(parseSlackTs('https://workspace.slack.com/archives/C09ABC/p1748121234567890'))
      .toBe('1748121234.567890');
  });
  test('vazio / null → null', () => {
    expect(parseSlackTs(null)).toBeNull();
    expect(parseSlackTs('')).toBeNull();
    expect(parseSlackTs('   ')).toBeNull();
  });
  test('lixo → null', () => {
    expect(parseSlackTs('abc')).toBeNull();
    expect(parseSlackTs('https://workspace.slack.com/archives/C09ABC/lixo')).toBeNull();
  });
});

describe('V3 sender — extractPubSecret', () => {
  test('extrai do permalink_public típico', () => {
    expect(extractPubSecret('https://slack-files.com/T01-F02-abc123def456'))
      .toBe('abc123def456');
  });
  test('null/lixo → null', () => {
    expect(extractPubSecret(null)).toBeNull();
    expect(extractPubSecret('lixo')).toBeNull();
  });
});

describe('V3 sender — extractPermalink (handle SDK shapes)', () => {
  // o uploadV2 retorna file com id+permalink; testamos os 3 formatos
  test('SDK clássico: { file: { id, permalink } }', () => {
    expect(extractPermalink({ file: { id: 'F1', permalink: 'https://x/p1' } })).toBe('https://x/p1');
  });
  test('SDK uploadV2: { files: [{ id, permalink }] }', () => {
    expect(extractPermalink({ files: [{ id: 'F2', permalink: 'https://x/p2' }] })).toBe('https://x/p2');
  });
  test('SDK uploadV2 nested: { files: [{ files: [{ id, permalink }] }] }', () => {
    expect(extractPermalink({ files: [{ files: [{ id: 'F3', permalink: 'https://x/p3' }] }] })).toBe('https://x/p3');
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

  test('thread_ts no send é propagado pro postFn + audit', async () => {
    const db = makeFakeDb();
    const postFn = jest.fn(async () => ({ ok: true, ts: 't1', channel: 'C0', thread_ts: '1111.2222' }));
    const s = new SenderService({ db, postFn });
    await s.send({
      channel: 'production', text: 'resposta',
      sender: { name: 'Carolina' },
      thread_ts: 'https://x.slack.com/archives/C09/p1111222200000000',
    });
    expect(postFn.mock.calls[0][0].thread_ts).toMatch(/p1111222200000000$/);
    expect(db.audit[0].metadata.thread_ts).toBe('1111.2222');
  });

  test('image_inline + image_warning aparecem no audit', async () => {
    const db = makeFakeDb();
    const postFn = jest.fn(async () => ({
      ok: true, ts: 't1', channel: 'C0',
      image_inline: false, image_permalink: 'https://slack/p',
      image_warning: 'sharedPublicURL falhou: missing_scope',
    }));
    const s = new SenderService({ db, postFn });
    await s.send({
      channel: 'production', text: 'oi',
      sender: { name: 'Carolina' },
      image: { dataUrl: 'data:image/png;base64,AAAA', filename: 'foto.png' },
    });
    expect(db.audit[0].metadata).toMatchObject({
      has_image: true, image_inline: false,
      image_warning: expect.stringMatching(/missing_scope/),
    });
  });
});

describe('V3 SenderService.react', () => {
  test('valida + chama reactFn + grava audit manual_post.reacted', async () => {
    const db = makeFakeDb();
    const reactFn = jest.fn(async () => ({ ok: true, channel: 'C09', ts: '1.2', emoji: 'thumbsup' }));
    const s = new SenderService({ db, reactFn });

    await expect(s.react({ ts: '1.2', emoji: 'x' })).rejects.toThrow(/channel/);
    await expect(s.react({ channel: 'production', emoji: 'x' })).rejects.toThrow(/ts/);
    await expect(s.react({ channel: 'production', ts: '1.2' })).rejects.toThrow(/emoji/);

    const out = await s.react({ channel: 'production', ts: '1.2', emoji: 'thumbsup' });
    expect(reactFn).toHaveBeenCalledTimes(1);
    expect(out.audit_id).toBe(1);
    expect(db.audit[0].metadata).toMatchObject({ channel: 'C09', slack_ts: '1.2', emoji: 'thumbsup' });
  });
});
