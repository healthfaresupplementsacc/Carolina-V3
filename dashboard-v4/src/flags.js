/* Feature flags · V4
   V4_ALLOW_WRITES — default LIGADO (1) a partir do E5 (27/mai noite).
   Pra desligar e voltar V4 pra read-only: build com VITE_V4_ALLOW_WRITES=0
   (ou git revert deste commit). Toda escrita continua atrás de PIN (x-admin-pin
   no header) + audit em v3.audit_log + reversível via undo (POST /events/:id
   /restore, etc) — não é "live edit livre" sem rastro.
*/
export const V4_ALLOW_WRITES = String(import.meta.env?.VITE_V4_ALLOW_WRITES ?? "1") === "1";

if (typeof window !== 'undefined') window.V4_ALLOW_WRITES = V4_ALLOW_WRITES;
