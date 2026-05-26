'use strict';
/**
 * Testes do /api/images/upload — isolados, sem rede Slack.
 * Mocka SlackClient.files.uploadV2. Cobertura: auth, body, sequência,
 * erro parcial, content-too-large não verificado (limit é Express).
 */
const express = require('express');
const http = require('http');
const { createImagesRouter, parseDataUrl, extractFileId } = require('../v3/images/router');

// Fake Slack client — capta calls + retorna shape do uploadV2
function makeFakeSlack(opts = {}) {
  const calls = [];
  return {
    calls,
    files: {
      uploadV2: jest.fn(async (params) => {
        calls.push(params);
        if (opts.fail) throw new Error('slack fake fail');
        return { ok: true, files: [{ id: 'F' + calls.length, permalink: 'p' }] };
      }),
    },
  };
}

// Sobe um express app em porta efêmera com o router → faz fetch real local
function appOn(deps) {
  const app = express();
  app.use('/', createImagesRouter(deps));
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function post(port, path, body, headers = {}) {
  const data = body == null ? '' : (typeof body === 'string' ? body : JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port, path, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...headers },
    }, (res) => {
      let chunks = '';
      res.on('data', (c) => { chunks += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(chunks); } catch (_) {}
        resolve({ status: res.statusCode, headers: res.headers, body: chunks, json });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// ── parseDataUrl unit ──────────────────────────────────────
describe('images/router — parseDataUrl', () => {
  test('decodifica jpeg base64 OK', () => {
    const { mime, buffer } = parseDataUrl('data:image/jpeg;base64,SGVsbG8=');
    expect(mime).toBe('image/jpeg');
    expect(buffer.toString()).toBe('Hello');
  });
  test('throws em formato inválido', () => {
    expect(() => parseDataUrl('lixo')).toThrow(/inválido/);
    expect(() => parseDataUrl('')).toThrow(/inválido/);
    expect(() => parseDataUrl(null)).toThrow(/inválido/);
  });
  test('throws em base64 que decodifica vazio', () => {
    expect(() => parseDataUrl('data:image/png;base64,')).toThrow(/inválido/);
  });
});

describe('images/router — extractFileId', () => {
  test('formato new SDK { files: [{ id }] }', () => {
    expect(extractFileId({ files: [{ id: 'F1' }] })).toBe('F1');
  });
  test('formato old SDK { file: { id } }', () => {
    expect(extractFileId({ file: { id: 'F2' } })).toBe('F2');
  });
  test('formato aninhado { files: [{ files: [{ id }] }] }', () => {
    expect(extractFileId({ files: [{ files: [{ id: 'F3' }] }] })).toBe('F3');
  });
  test('vazio → null', () => {
    expect(extractFileId(null)).toBeNull();
    expect(extractFileId({})).toBeNull();
  });
});

// ── HTTP integração ────────────────────────────────────────
describe('images/router — POST /api/images/upload', () => {
  let server, port;
  const fake = makeFakeSlack();
  beforeAll(async () => {
    ({ server, port } = await appOn({ expectedToken: 'SECRET', slackClient: fake }));
  });
  afterAll((done) => { server.close(done); });
  beforeEach(() => { fake.calls.length = 0; fake.files.uploadV2.mockClear(); });

  test('503 quando endpoint sem expectedToken e env unset', async () => {
    // Sobe outro app sem token configurado
    const { server: s2, port: p2 } = await appOn({ slackClient: fake });   // sem expectedToken
    const origEnv = process.env.IMAGES_UPLOAD_TOKEN;
    delete process.env.IMAGES_UPLOAD_TOKEN;
    try {
      const r = await post(p2, '/api/images/upload', { images: [] });
      expect(r.status).toBe(503);
      expect(r.json.error.code).toBe('disabled');
    } finally {
      if (origEnv) process.env.IMAGES_UPLOAD_TOKEN = origEnv;
      s2.close();
    }
  });

  test('401 quando token ausente', async () => {
    const r = await post(port, '/api/images/upload', { images: [{ filename: 'a.jpg', data_url: 'data:image/jpeg;base64,SGVsbG8=' }] });
    expect(r.status).toBe(401);
    expect(fake.files.uploadV2).not.toHaveBeenCalled();
  });

  test('401 quando token errado', async () => {
    const r = await post(port, '/api/images/upload?k=WRONG', { images: [{ filename: 'a.jpg', data_url: 'data:image/jpeg;base64,SGVsbG8=' }] });
    expect(r.status).toBe(401);
  });

  test('400 quando body.images vazio', async () => {
    const r = await post(port, '/api/images/upload?k=SECRET', { images: [] });
    expect(r.status).toBe(400);
  });

  test('200 quando 1 imagem OK — chama files.uploadV2 com channel_id correto', async () => {
    const r = await post(port, '/api/images/upload?k=SECRET', {
      images: [{ filename: 'foto-1.jpg', data_url: 'data:image/jpeg;base64,SGVsbG8=' }],
    });
    expect(r.status).toBe(200);
    expect(r.json.ok_count).toBe(1);
    expect(r.json.count).toBe(1);
    expect(r.json.channel).toBe('C0B6AQX6LJV');
    expect(r.json.uploaded[0].file_id).toBe('F1');
    expect(fake.files.uploadV2).toHaveBeenCalledTimes(1);
    expect(fake.calls[0].channel_id).toBe('C0B6AQX6LJV');
    expect(fake.calls[0].filename).toBe('foto-1.jpg');
    expect(fake.calls[0].file.toString()).toBe('Hello');
  });

  test('200 quando 3 imagens OK (loop sequencial)', async () => {
    const r = await post(port, '/api/images/upload?k=SECRET', {
      images: [
        { filename: 'a.jpg', data_url: 'data:image/jpeg;base64,QQ==' },     // 'A'
        { filename: 'b.jpg', data_url: 'data:image/jpeg;base64,Qg==' },     // 'B'
        { filename: 'c.jpg', data_url: 'data:image/jpeg;base64,Qw==' },     // 'C'
      ],
    });
    expect(r.status).toBe(200);
    expect(r.json.ok_count).toBe(3);
    expect(fake.files.uploadV2).toHaveBeenCalledTimes(3);
    expect(fake.calls.map((c) => c.filename)).toEqual(['a.jpg', 'b.jpg', 'c.jpg']);
  });

  test('header x-images-token também é aceito (alternativa ao query)', async () => {
    const r = await post(port, '/api/images/upload',
      { images: [{ filename: 'a.jpg', data_url: 'data:image/jpeg;base64,SGVsbG8=' }] },
      { 'x-images-token': 'SECRET' });
    expect(r.status).toBe(200);
  });

  test('Cache-Control: no-store nos headers (defensivo)', async () => {
    const r = await post(port, '/api/images/upload?k=SECRET',
      { images: [{ filename: 'a.jpg', data_url: 'data:image/jpeg;base64,SGVsbG8=' }] });
    expect(r.headers['cache-control']).toMatch(/no-store/);
  });

  test('200 parcial — segue mesmo se uma imagem dá erro', async () => {
    const r = await post(port, '/api/images/upload?k=SECRET', {
      images: [
        { filename: 'good.jpg', data_url: 'data:image/jpeg;base64,SGVsbG8=' },
        { filename: 'bad.jpg',  data_url: 'lixo-invalido' },
        { filename: 'good2.jpg', data_url: 'data:image/jpeg;base64,SGVsbG8=' },
      ],
    });
    expect(r.status).toBe(200);
    expect(r.json.count).toBe(3);
    expect(r.json.ok_count).toBe(2);
    expect(r.json.uploaded[1].ok).toBe(false);
    expect(r.json.uploaded[1].error).toMatch(/inválido/);
  });

  test('502 quando TODAS as imagens falham', async () => {
    const r = await post(port, '/api/images/upload?k=SECRET', {
      images: [
        { filename: 'a.jpg', data_url: 'lixo' },
        { filename: 'b.jpg', data_url: 'data:image/jpeg;base64,' },   // vazio
      ],
    });
    expect(r.status).toBe(502);
    expect(r.json.ok_count).toBe(0);
  });

  test('channel_id custom no body é respeitado (extensibilidade)', async () => {
    const r = await post(port, '/api/images/upload?k=SECRET', {
      channel_id: 'C9999XYZ',
      images: [{ filename: 'a.jpg', data_url: 'data:image/jpeg;base64,SGVsbG8=' }],
    });
    expect(r.status).toBe(200);
    expect(fake.calls[0].channel_id).toBe('C9999XYZ');
  });
});

describe('images/router — erro do Slack', () => {
  let server, port;
  const fakeFail = makeFakeSlack({ fail: true });
  beforeAll(async () => {
    ({ server, port } = await appOn({ expectedToken: 'SECRET', slackClient: fakeFail }));
  });
  afterAll((done) => { server.close(done); });

  test('502 quando Slack falha em todas', async () => {
    const r = await post(port, '/api/images/upload?k=SECRET', {
      images: [{ filename: 'a.jpg', data_url: 'data:image/jpeg;base64,SGVsbG8=' }],
    });
    expect(r.status).toBe(502);
    expect(r.json.uploaded[0].error).toMatch(/slack fake fail/);
  });
});
