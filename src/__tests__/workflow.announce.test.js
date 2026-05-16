'use strict';
jest.mock('../slack/client', () => ({ postToChannel: jest.fn().mockResolvedValue('ts') }));
jest.mock('../config', () => ({ slack: { managerChannelId: 'C0B36DR5MP1' } }));
// C5: announce now sources variations via message-variations → db.
// Empty rows → resolveTemplates falls back to the code defaults.
jest.mock('../db', () => ({ query: jest.fn().mockResolvedValue({ rows: [] }) }));

const slack = require('../slack/client');
const announce = require('../workflow/announce');

beforeEach(() => { jest.clearAllMocks(); });

describe('announce — all alerts go to manager channel only', () => {
  test('prereqWarning posts to C0B36DR5MP1', async () => {
    await announce.prereqWarning({ operatorName: 'Ana', phaseName: 'Empacotar', missing: ['Imprimir ordens'] });
    expect(slack.postToChannel).toHaveBeenCalledWith('C0B36DR5MP1', expect.stringMatching(/Pré-requisito.*Ana.*Empacotar.*Imprimir ordens/s));
  });

  test('prereqWarning with empty missing → no post', async () => {
    await announce.prereqWarning({ operatorName: 'Ana', phaseName: 'X', missing: [] });
    expect(slack.postToChannel).not.toHaveBeenCalled();
  });

  test('duplicateBatch alert', async () => {
    await announce.duplicateBatch({ productName: 'Green Tea', batchNumber: '0098', count: 2 });
    expect(slack.postToChannel).toHaveBeenCalledWith('C0B36DR5MP1', expect.stringMatching(/Duplicado.*Green Tea.*0098/s));
  });

  test('adHocPending alert', async () => {
    await announce.adHocPending({ operatorName: 'Bruno', taskName: 'limpando' });
    expect(slack.postToChannel).toHaveBeenCalledWith('C0B36DR5MP1', expect.stringMatching(/limpando.*cat[áa]logo/s));
  });

  test('batchChanged alert', async () => {
    await announce.batchChanged({ entityType: 'phase_instance', entityId: 42, from: null, to: '0125', who: 'Vitor' });
    expect(slack.postToChannel).toHaveBeenCalledWith('C0B36DR5MP1', expect.stringMatching(/Vitor.*42.*0125.*review/s));
  });

  test('failed post never throws', async () => {
    slack.postToChannel.mockRejectedValueOnce(new Error('slack down'));
    await expect(announce.adHocPending({ operatorName: 'X', taskName: 'Y' })).resolves.toBeUndefined();
  });

  test('Bug 3 — breakTimeResolved always mirrors to admin (silent_text-safe)', async () => {
    // slack().postMessage is absent in this mock → channel post throws &
    // is swallowed; the admin mirror must still fire (so with
    // silent_text=true the confirmation lands in the admin chat).
    await announce.breakTimeResolved({ operatorName: 'Simone', when: '2026-05-16 13:30:00' });
    expect(slack.postToChannel).toHaveBeenCalledWith(
      'C0B36DR5MP1', expect.stringMatching(/Atualizei o break.*Simone.*13:30/s));
  });
});
