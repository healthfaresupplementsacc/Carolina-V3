'use strict';
/**
 * B8: "ajudando o Vitor na linha de producao" → auto-join open Linha de Produção
 * (no supplement question — Linha de Produção runs one supplement at a time).
 */

jest.mock('../db');
jest.mock('../slack/client');
jest.mock('../eod', () => ({ isAfterSixPmEt: () => false }));

const db = require('../db');
const slackClient = require('../slack/client');
const tasks = require('../tasks');
const { parseMessage } = require('../parser');

beforeEach(() => {
  jest.clearAllMocks();
  slackClient.postMessage = jest.fn().mockResolvedValue();
  slackClient.postToChannel = jest.fn().mockResolvedValue();
});

describe('B8 — parser detects join_producao intent', () => {
  test('"ajudando o Vitor na linha de producao" → join_producao', () => {
    const r = parseMessage({
      ts: '1700000000.000000',
      user: 'U0AU8N8FA00',
      text: 'Ana - ajudando o Vitor na linha de producao',
      username: 'production line',
    });
    expect(r.type).toBe('join_producao');
    expect(r.operator).toBe('Ana');
  });

  test('"to com Vitor na linha de produção" → join_producao', () => {
    const r = parseMessage({
      ts: '1700000000.000000',
      user: 'U07FG34TMPF',
      text: 'Simone - to com Vitor na linha de produção',
      username: 'simone',
    });
    expect(r.type).toBe('join_producao');
    expect(r.operator).toBe('Simone');
  });

  test('"linha de producao" alone (no joiner verb) is NOT join_producao', () => {
    const r = parseMessage({
      ts: '1700000000.000000',
      user: 'U08JC85HMNE',
      text: 'S: linha de producao Berberine 0119',
      username: 'vitor',
    });
    expect(r.type).not.toBe('join_producao');
  });
});

describe('B8 — handler adds joiner as helper', () => {
  test('adds operator to helpers when open Linha de Produção exists', async () => {
    db.query = jest.fn().mockImplementation((sql) => {
      if (/SELECT id, operator, supplement_name, helpers FROM tasks/.test(sql)) {
        return Promise.resolve({
          rows: [{ id: 5, operator: 'Vitor', supplement_name: 'Green Tea', helpers: null }],
        });
      }
      // closeOpenBreakFor lookup
      return Promise.resolve({ rows: [] });
    });

    const ok = await tasks.handleJoinProducao(
      { operator: 'Ana', ts: '1700000000.000000' },
      { ts: '1700000000.000000' }
    );
    expect(ok).toBe(true);

    const updateCall = db.query.mock.calls.find((c) =>
      /UPDATE tasks SET helpers/.test(c[0])
    );
    expect(updateCall).toBeTruthy();
    expect(updateCall[1][0]).toBe('Ana');
    expect(updateCall[1][1]).toBe(5);

    // Announcement posted
    expect(slackClient.postMessage).toHaveBeenCalled();
    const announce = slackClient.postMessage.mock.calls[0][0];
    expect(announce).toMatch(/Ana/);
    expect(announce).toMatch(/Vitor/);
    expect(announce).toMatch(/Green Tea/);
  });

  test('appends to existing helpers list', async () => {
    db.query = jest.fn().mockImplementation((sql) => {
      if (/SELECT id, operator, supplement_name, helpers FROM tasks/.test(sql)) {
        return Promise.resolve({
          rows: [{ id: 5, operator: 'Vitor', supplement_name: 'Saw Palmetto', helpers: 'Ana' }],
        });
      }
      return Promise.resolve({ rows: [] });
    });

    const ok = await tasks.handleJoinProducao(
      { operator: 'Simone', ts: '1700000000.000000' },
      { ts: '1700000000.000000' }
    );
    expect(ok).toBe(true);

    const updateCall = db.query.mock.calls.find((c) =>
      /UPDATE tasks SET helpers/.test(c[0])
    );
    expect(updateCall[1][0]).toBe('Ana, Simone');
  });

  test('no-op when no open Linha de Produção', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [] });

    const ok = await tasks.handleJoinProducao(
      { operator: 'Ana', ts: '1700000000.000000' },
      { ts: '1700000000.000000' }
    );
    expect(ok).toBe(false);
    expect(slackClient.postMessage).not.toHaveBeenCalled();
  });

  test('no-op when joiner is already the starter', async () => {
    db.query = jest.fn().mockImplementation((sql) => {
      if (/SELECT id, operator, supplement_name, helpers FROM tasks/.test(sql)) {
        return Promise.resolve({
          rows: [{ id: 5, operator: 'Ana', supplement_name: 'Green Tea', helpers: null }],
        });
      }
      return Promise.resolve({ rows: [] });
    });
    const ok = await tasks.handleJoinProducao(
      { operator: 'Ana', ts: '1700000000.000000' },
      { ts: '1700000000.000000' }
    );
    expect(ok).toBe(false);
  });

  test('no-op when joiner is already in helpers', async () => {
    db.query = jest.fn().mockImplementation((sql) => {
      if (/SELECT id, operator, supplement_name, helpers FROM tasks/.test(sql)) {
        return Promise.resolve({
          rows: [{ id: 5, operator: 'Vitor', supplement_name: 'Green Tea', helpers: 'Ana, Simone' }],
        });
      }
      return Promise.resolve({ rows: [] });
    });
    const ok = await tasks.handleJoinProducao(
      { operator: 'Ana', ts: '1700000000.000000' },
      { ts: '1700000000.000000' }
    );
    expect(ok).toBe(false);
  });
});
