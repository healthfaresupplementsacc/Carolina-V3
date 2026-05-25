/* Feature flags · V4 (E0 setup)
   Lidos do env de build (VITE_*) com defaults seguros.

   V4_ALLOW_WRITES (default 0):
     Quando 0, qualquer interação que MUDA dado em prod (drag horizontal,
     resize de borda, drag vertical, merge, split, edit, delete, create) deve
     apenas atualizar preview/state local — NUNCA chamar a API.
     Liberação acontece em fases no E5/E6, controlada por env var no Railway.

   Hoje (E0) tudo é mock: nenhuma página chama API. Mas o gate fica semeado
   aqui pra quando o adapter (`from-api.js`) entrar no E2/E4 — basta importar
   `V4_ALLOW_WRITES` no callsite e gatear o fetch atrás dele.
*/
export const V4_ALLOW_WRITES = String(import.meta.env?.VITE_V4_ALLOW_WRITES ?? "0") === "1";

if (typeof window !== 'undefined') window.V4_ALLOW_WRITES = V4_ALLOW_WRITES;
