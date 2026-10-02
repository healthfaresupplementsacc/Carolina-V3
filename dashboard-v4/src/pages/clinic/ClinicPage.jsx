/* CLINIC — a casca. (10-02)

   ESTA PASTA É DE OUTRO PROJETO. O conteúdo da clínica (telas, dados, regras) é
   construído e mantido pelo Claude de "c:\Claude Projects\HealthFare Clinic",
   contra um banco PRÓPRIO (CLINIC_DATABASE_URL) — nunca o banco do armazém.

   O projeto do armazém entrega só isto: o lugar no menu, o controle de acesso
   (função clinic_page) e este ponto de encaixe. Daqui pra dentro, quem escreve é
   o outro lado. Ver CONTRATO-CLINIC.md. */
import React from 'react';

export function ClinicPage() {
  return (
    <div style={{ padding: '28px 30px', maxWidth: 760 }}>
      <div style={{ fontSize: 11, letterSpacing: '0.14em', textTransform: 'uppercase',
                    color: '#3D4FA1', fontWeight: 800, marginBottom: 6 }}>Clinic</div>
      <h1 style={{ margin: '0 0 14px', fontSize: 26, color: 'var(--text)', fontWeight: 700 }}>
        Área da clínica
      </h1>
      <div style={{ borderLeft: '3px solid #3D4FA1', paddingLeft: 14, color: 'var(--text-2)',
                    fontSize: 14.5, lineHeight: 1.7 }}>
        <p style={{ margin: '0 0 10px' }}>
          Esta área é um negócio separado do armazém: tem banco de dados próprio e é
          construída por um projeto à parte.
        </p>
        <p style={{ margin: 0 }}>
          Ainda não tem nada aqui dentro. O que aparecer nesta tela vem do projeto da
          clínica.
        </p>
      </div>
    </div>
  );
}
