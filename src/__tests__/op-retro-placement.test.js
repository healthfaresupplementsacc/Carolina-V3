'use strict';
/* Guard: o retroactive vive DENTRO da tela Confirma (seção "Quando começou?"),
   NÃO na lista de tasks nem na home. Valida o source do /op/app.js (UI client). */
const fs = require('fs');
const path = require('path');

const APP = fs.readFileSync(path.join(__dirname, '..', 'op', 'app.js'), 'utf8');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'op', 'index.html'), 'utf8');

describe('retroactive — lugar correto (tela Confirma)', () => {
  test('renderConfirm tem a seção "Quando começou?"', () => {
    const conf = APP.slice(APP.indexOf('function renderConfirm'));
    expect(conf).toContain('Quando começou?');
    expect(conf).toContain('Agora');
    expect(conf).toContain('Esqueci de marcar');
    expect(conf).toContain('Já terminou'); // pergunta após COMEÇAR
  });
  test('renderPickType NÃO tem picker/forgot-link (lista de tasks limpa)', () => {
    const pick = APP.slice(APP.indexOf('function renderPickType'), APP.indexOf('function renderPickSupplement'));
    expect(pick).not.toContain('forgot-link');
    expect(pick).not.toContain('buildTimePicker');
    expect(pick).not.toContain('Task esquecida');
  });
  test('sem botão retroactive na home nem fluxo separado', () => {
    expect(HTML).not.toContain('btn-retro');
    expect(APP).not.toContain('showRetroactiveFlow');
    expect(APP).not.toContain('Adicionar task que esqueci');
  });
  test('Confirma usa /event/retroactive quando há override, senão /event/start', () => {
    const conf = APP.slice(APP.indexOf('function renderConfirm'));
    expect(conf).toContain('/api/v3/op/event/retroactive');
    expect(conf).toContain('/api/v3/op/event/start');
    expect(conf).toContain('startedOverride');
  });
});
