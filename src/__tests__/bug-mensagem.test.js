'use strict';
// BUG MENSAGEM — Carolina lied ("só consigo ler lá") when asked to post
// in the production channel. She CAN (greeting/EOD/announcements). New
// tool post_to_production_channel wires it, honours silent_text, audits
// ai_admin_posted_to_channel, posts verbatim (persona stays human).
jest.mock('../db');
const at = require('../ai/admin-tools');
const fs = require('fs');
const path = require('path');

function deps(postReturn) {
  const posted = [];
  return {
    _posted: posted,
    auditAction: jest.fn().mockResolvedValue(),
    slackClient: { postMessage: jest.fn((t) => { posted.push(t); return Promise.resolve(postReturn); }) },
  };
}

describe('BUG MENSAGEM — post_to_production_channel tool', () => {
  test('registered as a channel tool + in TOOL_DEFS', () => {
    expect(at.CHANNEL_TOOLS.has('post_to_production_channel')).toBe(true);
    const def = at.TOOL_DEFS.find((t) => t.name === 'post_to_production_channel');
    expect(def).toBeTruthy();
    expect(def.input_schema.required).toContain('message_text');
  });

  test('silent_text=false → posts to the real channel, audits', async () => {
    const d = deps('1718900000.001'); // real slack ts
    const r = await at.runTool('post_to_production_channel',
      { message_text: 'Pessoal, desculpa a confusão de mais cedo!' }, d);
    expect(r).toMatchObject({ posted: true, silent: false, channel: 'production' });
    expect(r.confirmation).toMatch(/Mandei lá/);
    // posted VERBATIM — no AI/admin-revealing prefix
    expect(d._posted).toEqual(['Pessoal, desculpa a confusão de mais cedo!']);
    expect(d.auditAction).toHaveBeenCalledWith(expect.objectContaining({
      action: 'ai_admin_posted_to_channel', entityType: 'slack_channel',
    }));
  });

  test('silent_text=true → goes to silent_log, admin gets the silent confirmation', async () => {
    const d = deps('silent-1718900000'); // client.postMessage marker
    const r = await at.runTool('post_to_production_channel', { message_text: 'oi' }, d);
    expect(r).toMatchObject({ posted: false, silent: true });
    expect(r.confirmation).toMatch(/modo silencioso, foi pro log/i);
    expect(d.auditAction).toHaveBeenCalledWith(expect.objectContaining({
      action: 'ai_admin_posted_to_channel',
      after: expect.objectContaining({ silent: true, ts: null }),
    }));
  });

  test('per-type toggle marker also counts as silent', async () => {
    const d = deps('toggled-1718900000');
    const r = await at.runTool('post_to_production_channel', { message_text: 'x' }, d);
    expect(r.silent).toBe(true);
  });

  test('empty message → no post', async () => {
    const d = deps('1718900000.002');
    const r = await at.runTool('post_to_production_channel', { message_text: '   ' }, d);
    expect(r.posted).toBe(false);
    expect(d.slackClient.postMessage).not.toHaveBeenCalled();
  });

  test('cron/autonomous path cannot post (allowMutations:false)', async () => {
    const d = deps('1718900000.003'); d.allowMutations = false;
    await expect(at.runTool('post_to_production_channel', { message_text: 'x' }, d))
      .rejects.toThrow(/ordem explícita/);
  });
});

describe('BUG MENSAGEM — prompt forbids the "só leio lá" refusal', () => {
  test('prompt tells Carolina she CAN post and to use the tool', () => {
    const dm = fs.readFileSync(path.join(__dirname, '..', 'slack', 'dm-handler.js'), 'utf8');
    expect(dm).toMatch(/POSTAR NO CANAL/);
    expect(dm).toMatch(/post_to_production_channel/);
    expect(dm).toMatch(/NUNCA diga "não tenho\s+acesso"/);
    expect(dm).toMatch(/Mandei lá|modo silencioso/);
  });
});
