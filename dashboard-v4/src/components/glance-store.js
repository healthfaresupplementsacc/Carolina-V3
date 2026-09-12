/* glance-store — ponte entre a página Hoje e a barra do topo (Bruno 09-12).

   Bruno: "o quadro P&P / Produção deveria caber na barra, perto do Ponto, depois
   dos nomes de quem está trabalhando; só o importante à vista, e no clique
   aparece tudo o que estava no widget".

   A página Hoje é quem TEM os números (produção, P&P, pedidos, FNSKU, metas,
   revisão) e quem sabe desenhar cada widget inteiro. A barra do topo mora no
   Shell, fora dela. Em vez de a barra buscar tudo de novo (segunda verdade,
   segundo poll), a Hoje PUBLICA aqui, a cada render, a lista de chips com um
   `render()` que devolve o widget completo. A barra só assina.

   Item: { id, icon, label, value, unit, sub, tone, title, render }
*/
import React from 'react';

let current = [];
const subs = new Set();

export function publishGlance(items) {
  current = Array.isArray(items) ? items : [];
  subs.forEach((fn) => { try { fn(current); } catch (_) { /* assinante morto */ } });
}

export function useGlance() {
  const [items, setItems] = React.useState(current);
  React.useEffect(() => {
    subs.add(setItems);
    setItems(current);
    return () => { subs.delete(setItems); };
  }, []);
  return items;
}
