/* Página Câmeras — as 2 câmeras da produção dentro do dashboard (menu),
   com os mesmos recursos do widget: reconexão, tamanho, fullscreen, PIP. */
import React from 'react';
import { CameraGrid } from '../components/CameraGrid.jsx';

function CamerasPage() {
  return (
    <div>
      <CameraGrid/>
      <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 10, fontStyle: 'italic' }}>
        Dica: o botão ⧉ PIP abre a câmera numa janela flutuante que fica por cima de tudo
        (funciona enquanto uma aba do dashboard estiver aberta — pode minimizar o navegador).
      </div>
    </div>
  );
}

window.CamerasPage = CamerasPage;
export { CamerasPage };
