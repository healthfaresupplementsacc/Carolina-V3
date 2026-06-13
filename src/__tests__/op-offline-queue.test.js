'use strict';
/* Fase F — fila offline (módulo puro, UMD → node). */
const Q = require('../op/offline-queue');

function fakeStore() {
  let data = {};
  return { getItem: (k) => (k in data ? data[k] : null), setItem: (k, v) => { data[k] = String(v); }, _data: () => data };
}

describe('Fase F — offline queue', () => {
  test('enqueue acumula e size reflete', () => {
    const st = fakeStore();
    expect(Q.size(st)).toBe(0);
    Q.enqueue({ path: '/api/v3/op/event/start', body: { activity_slug: 'cleaning' }, sessionToken: 't' }, st);
    Q.enqueue({ path: '/api/v3/op/note', body: { text: 'x' }, sessionToken: 't' }, st);
    expect(Q.size(st)).toBe(2);
    const items = Q.read(st);
    expect(items[0].path).toContain('/event/start');
    expect(items[0].id).toBeTruthy();
    expect(items[0].ts).toBeTruthy();
  });

  test('flush envia em ordem e esvazia quando tudo OK', async () => {
    const st = fakeStore();
    Q.enqueue({ path: '/a', body: { i: 1 }, sessionToken: 't' }, st);
    Q.enqueue({ path: '/b', body: { i: 2 }, sessionToken: 't' }, st);
    const sentPaths = [];
    const res = await Q.flush(async (path) => { sentPaths.push(path); }, st);
    expect(res.sent).toBe(2);
    expect(res.remaining).toBe(0);
    expect(sentPaths).toEqual(['/a', '/b']);
    expect(Q.size(st)).toBe(0);
  });

  test('flush PARA no primeiro erro e preserva o resto (ordem mantida)', async () => {
    const st = fakeStore();
    Q.enqueue({ path: '/a', body: {}, sessionToken: 't' }, st);
    Q.enqueue({ path: '/b', body: {}, sessionToken: 't' }, st);
    Q.enqueue({ path: '/c', body: {}, sessionToken: 't' }, st);
    let n = 0;
    const res = await Q.flush(async () => { n += 1; if (n === 2) throw new Error('offline'); }, st);
    expect(res.sent).toBe(1);
    expect(res.remaining).toBe(2);
    const rest = Q.read(st);
    expect(rest.map((x) => x.path)).toEqual(['/b', '/c']); // /a saiu, ordem preservada
  });

  test('clear esvazia', () => {
    const st = fakeStore();
    Q.enqueue({ path: '/x', body: {} }, st);
    Q.clear(st);
    expect(Q.size(st)).toBe(0);
  });

  test('localStorage corrompido → read retorna [] (não quebra)', () => {
    const st = fakeStore();
    st.setItem(Q.KEY, 'isso não é json{');
    expect(Q.read(st)).toEqual([]);
  });
});
