# SHELL_QUEUE — operações de shell pendentes (Bash classifier fora do ar)

Construído em modo write-only durante outage do classificador de Bash. Quando o
Bash voltar (ou pra você, Bruno, rodar manualmente), executar **nesta ordem**.
Working dir: `c:\Claude Projects\Supplements Production Line\healthfare-tracker`.

## 0) Copiar assets do design pra dentro do repo
A pasta-fonte é irmã do repo: `../HealthFare Task Tracker Redesign/assets/`.
```bash
mkdir -p src/op/assets/bottles
cp "../HealthFare Task Tracker Redesign/assets/healthfare-logo.png" src/op/assets/
cp "../HealthFare Task Tracker Redesign/assets/bottles/"*.png src/op/assets/bottles/
# (otimização WEBP/thumbnail: PULADA — R6 zero deps novas / npm quebrado; usar loading=lazy + width/height no CSS)
```
Esperado: `src/op/assets/healthfare-logo.png` + 10 PNGs em `src/op/assets/bottles/`.

## 0b) Montar /shared no Express (index.v4 referencia /shared/hf-design.css|js)
Editar `src/v3/wire.js` (perto dos outros `express.static`), aditivo:
```js
app.use('/shared', express.static(path.join(process.cwd(), 'src', 'shared')));
```
Sem isso, `/shared/hf-design.css` dá 404. (Alternativa: copiar hf-design.* pra src/op
e referenciar /op/… — mas o mount mantém fonte única p/ admin/metrics/v4 também.)

## 1) Copiar a fonte do design pra referência permanente
```bash
cp "../HealthFare Task Tracker Redesign/HealthFare Linha.dc.html" docs/design/REDESIGN_SOURCE.html
```

## 2) Rodar tests (validação ANTES de qualquer commit — R4)
```bash
node node_modules/jest/bin/jest.js hf-design op-redesign 2>&1 | tail -15   # novos
node node_modules/jest/bin/jest.js 2>&1 | grep -E "Tests:|Test Suites:|FAIL" | tail -4  # full suite
```
Se vermelho → consertar antes de commitar.

## 3) Commits em chunks (R2: 1 commit por fase; aqui agrupado por outage)
```bash
git tag pre-redesign-noturno
git add src/shared/ docs/design/ src/__tests__/hf-design.test.js
git commit -m "design(fase 1): design system HF (tokens, helpers, docs)"

git add src/op/assets src/op/products.json src/op/sw.v4.js src/op/index.v4.html src/op/style.v4.css src/op/app.v4.js src/__tests__/op-redesign.test.js
git commit -m "design(fase 2-5): /op v4 (login/home/flow/overlays/settings) — arquivos .v4"
```

## 4) Deploy + smoke (R3 + R7: SÓ reporta sucesso com Build Logs URL)
```bash
railway up --detach 2>&1 | grep -iE "upload|build logs"   # CONFIRMAR que aparece "Build Logs:"
# poll até live (ex.: curl do /op/index.v4.html ou do asset)
curl -s -o /dev/null -w "%{http_code}\n" https://productionlineservice-production.up.railway.app/op/assets/healthfare-logo.png
```

## 5) TROCA v4 → ativo (só depois do smoke do .v4 passar; H8)
A página servida é `/op/index.html` (Express estático). Pra ativar o redesign:
```bash
cd src/op
mv index.html index.legacy.html && mv index.v4.html index.html
mv app.js app.legacy.js && mv app.v4.js app.js
mv style.css style.legacy.css && mv style.v4.css style.css
mv sw.js sw.legacy.js && mv sw.v4.js sw.js
cd ../..
# rodar suite de novo (op-api etc.) → garantir que o backend/endpoints seguem ok
node node_modules/jest/bin/jest.js op-api op.retroactive op.forgotten 2>&1 | tail -6
git add -A && git commit -m "design(op): ativar redesign v4 (swap dos arquivos)"
railway up --detach
```

## 6) Smoke prod completo (Fase 9) + push
```bash
# /op/ login (PIN Vitor), home, flow, overlays — manual ou puppeteer
git push origin v3-reset --tags
```

## 7) Ativar reskin /admin (Fase 6-7) — aditivo, reversível
Adicionar no `<head>` de `src/admin/index.html` (DEPOIS de style.css):
```html
<link rel="stylesheet" href="/admin/style.v4.css">
```
(cobre /admin + /admin/metrics, mesma SPA). Deploy + conferir login/abas/métricas.

## 8) Ativar reskin /dashboard-v4 (Fase 8) — SÓ após revisão
```js
// dashboard-v4/src/main.jsx: import './redesign-v4.css';
cd dashboard-v4 && node node_modules/vite/bin/vite.js build  # gera public/dashboard-v4
```
Conferir que o V4 não quebrou (layout/charts). Reskin é leve (fontes+accents).

## Pendências / decisões registradas
- **Otimização de imagem pulada** (R6). PNGs servidos como estão + `loading="lazy"`.
- **Fases 6–8** (/admin, /admin/metrics, /dashboard-v4): `style.v4.css` por surface — reskin aditivo, importa `hf-design.css`. Fazer depois do /op estável (S4).
- Backend/endpoints **intocados** (D8). app.v4.js usa os endpoints existentes:
  `/auth/login`, `/event/start`, `/event/retroactive`, `/event/:id/end`,
  `/active-operators`, `/voice/upload`, `/forgotten-checkout/resolve`, `/clock-out`.
- Dados reais vêm de `window.HF_DATA` (fuse-data.js) — o GROUPS/SUPPS hardcoded do
  dc.html era mock de design; v4 usa HF_DATA + o mapa de ícones/accents do design.
