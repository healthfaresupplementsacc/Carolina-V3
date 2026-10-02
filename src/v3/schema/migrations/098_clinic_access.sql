-- 098 — ACESSO À ÁREA CLINIC (10-02).
-- A clínica é outro NEGÓCIO dentro da mesma página: banco próprio
-- (CLINIC_DATABASE_URL), telas próprias, cuidada por um projeto Claude separado.
-- Daqui sai só o controle de quem ENXERGA a seção; o conteúdo é do outro lado.
-- Ver "c:\Claude Projects\HealthFare Clinic\CONTRATO-CLINIC.md".
--
-- Ninguém ganha a função automaticamente: nem o cargo manager. Quem decide é o
-- admin, em Admin → Usuários & Acessos, pessoa por pessoa. Clínica é assunto
-- restrito e não deve vazar pra quem só trabalha no armazém.
INSERT INTO v3.app_functions (key, label, category) VALUES
  ('clinic_page', 'Área da clínica', 'clinic')
ON CONFLICT (key) DO NOTHING;
