'use strict';
/**
 * CARGOS (roles) — Bruno 09-09: "o sistema tem que ser por cargo, não por nome".
 *
 * Nasceu quando a Simone saiu: o nome dela estava gravado como placeholder em
 * mensagem automática, prompt da Carolyn, tarefa do agendador e texto de tela.
 * Trocar por outro nome repetiria o erro. A partir daqui, tudo que precisa
 * falar com "quem faz X" pergunta ao CARGO, e o cargo aponta pra uma pessoa
 * (ou pra ninguém).
 *
 * Armazenamento: v3.settings, key `role:<cargo>` → { person_id, name,
 * slack_user_id, set_by, at }. Mesmo padrão do `print_station_operator`.
 * Sem tabela nova: quando o RBAC completo vier (Users + permissões), isto
 * migra pra uma tabela própria sem mudar quem chama.
 *
 * Regras:
 *  - getRoleHolder RE-LÊ v3.persons: pessoa desativada/apagada = cargo vazio,
 *    mesmo com a setting antiga lá (ninguém fica "responsável" depois de sair).
 *  - addressFor devolve como a mensagem deve CHAMAR a pessoa: primeiro nome,
 *    ou <@slack> quando `mention`, ou o texto genérico do cargo se vazio.
 *  - O genérico é em português e serve pra 1 ou várias pessoas ("pessoal do
 *    packing", escolha do Bruno 09-09) — as mensagens são em PT.
 */

const ROLES = {
  packing_operator: {
    label_pt: 'Responsável pelo P&P',
    label_en: 'Packing Operator',
    fallback: 'pessoal do packing',
    description: 'quem imprime e empacota os pedidos do dia (P&P)',
  },
};

const settingKey = (role) => 'role:' + role;

function assertRole(role) {
  if (!ROLES[role]) throw new Error('unknown_role: ' + role);
  return ROLES[role];
}

/** Quem ocupa o cargo AGORA (null = ninguém designado ou a pessoa saiu). */
async function getRoleHolder(db, role) {
  assertRole(role);
  const st = (await db.query('SELECT value FROM v3.settings WHERE key=$1', [settingKey(role)])).rows[0];
  const v = st && st.value;
  const pid = v && parseInt(v.person_id, 10);
  if (!pid) return null;
  const p = (await db.query(
    `SELECT id, display_name, slack_user_id FROM v3.persons
      WHERE id=$1 AND active=true AND deleted_at IS NULL`, [pid])).rows[0];
  if (!p) return null;                                   // saiu/desativada → cargo vazio
  return {
    person_id: p.id, name: p.display_name, slack_user_id: p.slack_user_id || null,
    set_by: v.set_by || null, at: v.at || null,
  };
}

/** Designa (personId) ou esvazia (null) o cargo. Devolve o holder novo. */
async function setRoleHolder(db, role, personId, { by } = {}) {
  assertRole(role);
  if (personId == null || personId === '') {
    await db.query('DELETE FROM v3.settings WHERE key=$1', [settingKey(role)]);
    return null;
  }
  const pid = parseInt(personId, 10);
  const p = (await db.query(
    `SELECT id, display_name, slack_user_id FROM v3.persons
      WHERE id=$1 AND active=true AND deleted_at IS NULL`, [pid])).rows[0];
  if (!p) throw Object.assign(new Error('person_not_found'), { code: 'person_not_found' });
  const value = { person_id: p.id, name: p.display_name, slack_user_id: p.slack_user_id || null,
    set_by: by || null, at: new Date().toISOString() };
  await db.query(
    `INSERT INTO v3.settings (key, value, description)
       VALUES ($1, $2::jsonb, $3)
     ON CONFLICT (key) DO UPDATE SET value=$2::jsonb, updated_at=NOW()`,
    [settingKey(role), JSON.stringify(value), 'cargo ' + role + ' — ' + ROLES[role].description]);
  return { person_id: p.id, name: p.display_name, slack_user_id: p.slack_user_id || null, set_by: value.set_by, at: value.at };
}

/**
 * Como a mensagem chama quem ocupa o cargo.
 *   holder + mention + slack_user_id → "<@U…>"
 *   holder                            → primeiro nome ("Caroline")
 *   vazio                             → genérico ("pessoal do packing" / "Pessoal do packing")
 */
function addressFor(holder, role, { mention = false, capitalize = false } = {}) {
  const def = assertRole(role);
  if (holder && holder.name) {
    if (mention && holder.slack_user_id) return '<@' + holder.slack_user_id + '>';
    return String(holder.name).trim().split(/\s+/)[0];
  }
  const txt = def.fallback;
  return capitalize ? txt.charAt(0).toUpperCase() + txt.slice(1) : txt;
}

/** Atalho: lê o cargo e já devolve o tratamento. */
async function addressRole(db, role, opts) {
  return addressFor(await getRoleHolder(db, role), role, opts);
}

module.exports = { ROLES, getRoleHolder, setRoleHolder, addressFor, addressRole, settingKey };
