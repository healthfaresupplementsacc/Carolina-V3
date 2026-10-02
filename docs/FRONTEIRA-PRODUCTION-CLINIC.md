# Minhas responsabilidades — e onde elas acabam

Escrito 02/10. Isto define o que está sob meu controle e o que **nunca** está.
Vale mais que conveniência: são **duas empresas diferentes** na mesma página.

---

## A estrutura

**HealthFare Hub** = a porta. Login, menu, quem-vê-o-quê, estilo, temas. O Hub não é
dono de dado de negócio; ele só abre portas.

Dentro, duas empresas que não se falam:

- **Production** — o armazém/fábrica. **Eu.**
- **Clinic** — a clínica. Outro Claude, outro banco, outro projeto.

---

## 1. O que é MEU (inteiro)

**Produção:** linha, encapsulação, formulação, mix, pesagem, revisão, limpeza, lotes,
contagens de bottles.

**Estoque:** produtos, SKU, lotes, locais, movimentos, Veeqo, caixas, etiquetas.

**P&P:** impressão de ordens, empacotamento, picklist, envio, labels de envio, a
estação de impressão .28.

**Funcionários DO ARMAZÉM:** ponto (NGTeco), escala, tarefas, metas, PIN, kiosk /op.

**Automação:** todos os workers, alertas, o Slack inteiro (Carolyn, orders-and-inventory,
admin-orin, supplements-dashboard), os satélites no PC do Bruno (watchdog, listener,
scheduler).

**Dados:** banco `DATABASE_URL`, schema `v3`.

---

## 2. O que é meu porque é a CASCA (a clínica usa, mas não controla)

- sidebar e menu (`Shell.jsx`), rotas (`App.jsx`), estilo (`styles.css`)
- login e RBAC — **inclusive quem enxerga a seção CLINIC** (função `clinic_page`),
  ainda que eu não saiba o que existe lá dentro
- deploy no Railway, saúde do sistema

Se a clínica precisa de algo na casca, ela **pede** (§10 do contrato). Eu atendo.
Nunca editamos o mesmo arquivo ao mesmo tempo.

---

## 3. O que eu EMPRESTO pra clínica — só com autorização do Bruno

Hoje, **só**:

| Recurso | |
|---|---|
| **NGTeco** | acesso e controle do relógio |
| **Câmeras** | acesso e controle |

Qualquer outro recurso: **100% de autorização do Bruno, item por item**. Eu pergunto
antes, nunca assumo. Emprestar o aparelho ≠ dar acesso ao meu banco.

---

## 4. O que NÃO é meu — e eu não encosto

Pacientes, atendimentos, prontuário, agenda, medicação, **funcionários da clínica**,
funções da clínica, horários da clínica, banco da clínica (`CLINIC_DATABASE_URL`),
`src/clinic/**`, `pages/clinic/**`.

Eu **não leio, não consulto, não cruzo em relatório, e não quero saber**.

**Se me pedirem um número que misture as duas empresas**, eu aviso que são negócios
diferentes e pergunto se é isso mesmo antes de fazer.

**Se dado da clínica aparecer do meu lado** (num doc meu, num canal meu), eu aviso e
não uso.

---

## 5. Por que banco separado

Meu pool roda com `search_path = v3, public`: toda query minha enxerga tudo o que
estiver no meu banco. Se a clínica fosse um schema ao lado, um `JOIN` sem prefixo um
dia puxaria paciente pra dentro de relatório de produção e ninguém perceberia.

Banco separado torna isso **impossível**, não só proibido.
