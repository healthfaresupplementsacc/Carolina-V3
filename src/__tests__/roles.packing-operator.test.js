'use strict';
/*
 * CARGO packing_operator (Bruno 09-09): a Simone saiu e o nome dela estava
 * gravado como placeholder em mensagem, prompt, agendador e tela. Regra:
 * cargo, não nome. Este teste trava o contrato do módulo de cargos.
 */
const roles = require('../v3/roles');

/** db falso: `settings` = {key: value}, `persons` = [{id, display_name, slack_user_id, active, deleted_at}] */
function fakeDb({ settings = {}, persons = [] } = {}) {
  const calls = [];
  return {
    calls,
    query: async (sql, params = []) => {
      calls.push({ sql, params });
      // escritas primeiro: "DELETE FROM v3.settings WHERE key=$1" também casa o regex do SELECT
      if (/^INSERT INTO v3\.settings/m.test(sql.trim())) { settings[params[0]] = JSON.parse(params[1]); return { rowCount: 1, rows: [] }; }
      if (/^DELETE FROM v3\.settings/.test(sql.trim())) { delete settings[params[0]]; return { rowCount: 1, rows: [] }; }
      if (/FROM v3\.settings WHERE key=\$1/.test(sql)) {
        const v = settings[params[0]];
        return { rows: v ? [{ value: v }] : [] };
      }
      if (/FROM v3\.persons/.test(sql)) {
        const p = persons.find((x) => x.id === params[0] && x.active && !x.deleted_at);
        return { rows: p ? [p] : [] };
      }
      return { rows: [] };
    },
  };
}

const CAROLINE = { id: 9, display_name: 'Caroline Braga', slack_user_id: 'U0CARO', active: true, deleted_at: null };
const SIMONE = { id: 5, display_name: 'Simone', slack_user_id: 'U07FG34TMPF', active: false, deleted_at: null };

describe('cargo packing_operator', () => {
  test('ninguém designado → "pessoal do packing" (o genérico escolhido pelo Bruno)', async () => {
    const db = fakeDb();
    expect(await roles.getRoleHolder(db, 'packing_operator')).toBeNull();
    expect(await roles.addressRole(db, 'packing_operator')).toBe('pessoal do packing');
    expect(await roles.addressRole(db, 'packing_operator', { capitalize: true })).toBe('Pessoal do packing');
    // sem slack id não tem menção — cai no genérico, nunca em "<@null>"
    expect(await roles.addressRole(db, 'packing_operator', { mention: true })).toBe('pessoal do packing');
  });

  test('designa uma operadora → primeiro nome nas mensagens, <@id> quando é menção', async () => {
    const db = fakeDb({ persons: [CAROLINE] });
    const h = await roles.setRoleHolder(db, 'packing_operator', 9, { by: 'bruno' });
    expect(h).toMatchObject({ person_id: 9, name: 'Caroline Braga', slack_user_id: 'U0CARO', set_by: 'bruno' });
    expect(await roles.addressRole(db, 'packing_operator')).toBe('Caroline');
    expect(await roles.addressRole(db, 'packing_operator', { mention: true })).toBe('<@U0CARO>');
  });

  test('pessoa desativada continua na setting mas o cargo fica VAZIO (quem saiu não responde por nada)', async () => {
    // exatamente o caso Simone: a setting apontaria pra ela, mas ela está inativa
    const db = fakeDb({ settings: { 'role:packing_operator': { person_id: 5, name: 'Simone' } }, persons: [SIMONE] });
    expect(await roles.getRoleHolder(db, 'packing_operator')).toBeNull();
    expect(await roles.addressRole(db, 'packing_operator')).toBe('pessoal do packing');
  });

  test('esvaziar o cargo apaga a setting; designar pessoa inexistente/inativa falha', async () => {
    const db = fakeDb({ persons: [CAROLINE, SIMONE] });
    await roles.setRoleHolder(db, 'packing_operator', 9);
    expect(await roles.setRoleHolder(db, 'packing_operator', null)).toBeNull();
    expect(await roles.getRoleHolder(db, 'packing_operator')).toBeNull();
    await expect(roles.setRoleHolder(db, 'packing_operator', 5)).rejects.toMatchObject({ code: 'person_not_found' });
    await expect(roles.setRoleHolder(db, 'packing_operator', 999)).rejects.toMatchObject({ code: 'person_not_found' });
  });

  test('cargo desconhecido é erro de programação, não silêncio', async () => {
    const db = fakeDb();
    await expect(roles.getRoleHolder(db, 'ceo')).rejects.toThrow(/unknown_role/);
    expect(() => roles.addressFor(null, 'ceo')).toThrow(/unknown_role/);
  });

  test('nenhum código vivo grava mais "Simone" como quem recebe mensagem automática', () => {
    const fs = require('fs'); const path = require('path');
    const ROOT = path.join(__dirname, '..', '..');
    // os três lugares que FALAVAM com ela pelo nome (não comentários de histórico)
    const divergence = fs.readFileSync(path.join(ROOT, 'src', 'workers', 'print-divergence-watchdog.js'), 'utf8');
    expect(divergence).not.toMatch(/'Simone, hoje deu/);
    // _watch/ é local do PC do Bruno (gitignored): só confere onde existe
    const tasksPath = path.join(ROOT, 'scripts', 'analyst', '_watch', 'tasks.json');
    if (fs.existsSync(tasksPath)) expect(fs.readFileSync(tasksPath, 'utf8')).not.toMatch(/VIGIA SIMONE|DA SIMONE/);
    const falar = fs.readFileSync(path.join(ROOT, 'dashboard-v4', 'src', 'pages', 'CarolinaFalar.jsx'), 'utf8');
    expect(falar).not.toMatch(/name: 'Simone'/);
  });
});
