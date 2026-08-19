/* Página Câmeras — as câmeras da produção dentro do dashboard (menu),
   com os mesmos recursos do widget: reconexão, tamanho, fullscreen, PIP.

   S15 Fase 2 (grupo C): cabeçalho no STYLE-KIT. A mecânica toda continua no
   componente CameraGrid, sem mudança de comportamento. */
import React from 'react';
import { CameraGrid } from '../components/CameraGrid.jsx';
import './pages-admin.css';

function CamerasPage() {
  return (
    <div data-page="cameras" style={{ paddingBottom: 60 }}>
      <div className="adm-head">
        <div className="lead">
          <span className="kit-eyebrow">● HEALTHFARE · CÂMERAS</span>
          <h1 className="kit-h1">A produção ao <em>vivo</em></h1>
          <p className="kit-sub">
            Arraste o cabeçalho pra reordenar, o canto pra redimensionar e a imagem pra escolher a área. Somente visualização.
          </p>
        </div>
      </div>
      <CameraGrid/>
      <div className="adm-note faint" style={{ marginTop: 12 }}>
        Dica: o botão ⧉ PIP abre a câmera numa janela flutuante que fica por cima de tudo. Funciona enquanto uma aba do
        dashboard estiver aberta, e dá pra minimizar o navegador.
      </div>
    </div>
  );
}

window.CamerasPage = CamerasPage;
export { CamerasPage };
