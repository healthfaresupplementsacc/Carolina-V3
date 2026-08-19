# DESIGN-INTENT DIGEST: HealthFare Warehouse Inventory + P&P system

Sources read in full: the Obsidian notes listed (Centro de Estoque incl. §9/§9.1, Deep Study, Match Veeqo↔EMS, ESTADO ATUAL 08-06, Estação de Impressão contrato .28, Handoff, Build log grep + full entries 08-01→08-17), both CSVs, all 19 memory files, GENERATIONS G-I, STRUCTURE_INDEX S15, OPERATOR_PAGE.md. Also read because they are referenced as canonical by those sources: "Ideia do Bruno — página de impressão P&P (guardar).md", "P&P — MASTER TO-DO", "P&P — Shipping labels, pick list & TikTok", "Reference — P&P vs Linha", "Inventário — Controle de perda", UNCERTAINTIES U-27..U-32, migration 070, `src/op/app.js` workspace layer, `InventorySettingsPage.jsx`.

---

## 1. Bruno's stated model & decisions (chronological)

### 2026-06 (Handoff §1, §3, §5)
- Company: capsules/tablets; sells FBA/Amazon, Walmart, TikTok Shop, eBay. Team: 4 operators (Vitor, Simone, Ana, Bruno Sarmento), manager Henrique, owners Bruno Camp + Thassio. Portuguese BR, TZ America/New_York.
- Three flows: A Produção, **B Picking & Packing** ("Simone/Ana de manhã, deadline ~1pm (correio)"; P&P = only order_printing/labeling/packaging/marketplace_prep; "Fechar Caixas NÃO é P&P. Envio Clínica NÃO é P&P"), C Suporte.
- Non-negotiable principles incl. #5 "Nada se perde", #6 "Admin controla tudo (…auditado)", #9 "Shadow antes de active", #16 **REGRA #0: capturar tudo, NUNCA bloquear o operador**.

### 2026-07-07 (memory pp-vs-production-line, veeqo-integration-plan, usps-scan-form-automation; Reference — P&P vs Linha)
- **Two SEPARATE flows, "lei de domínio"**: ① Linha de Produção → fulfillment centers (FBA/WFS), FNSKU lives ONLY here, shipped by UPS. ② **P&P do dia / "Embalagem" (morning) → straight to customer**: Simone prints orders (TikTok, eBay, Amazon, Walmart, own site), picks bottles from "bins/caixas de estoque reservado pra sair direto do armazém pro comprador", ships USPS/DHL/UPS, every business day, **NO FNSKU**, separate physical shipping area. Only overlap = UPS.
- **Veeqo = primary source of truth for P&P** (multi-channel order manager); phased read-only → cross-check → auto-feed. Future vision: "warehouse inventory + auto-deduct on each Veeqo print; bins (which supplement per bin, how many); bottles-per-package (1/2/3); time per packaged bottle."
- USPS SCAN form: Bruno wants it auto-handled when Simone marks "P&P do dia concluído".

### 2026-07-16/17 (label-printing-station, contrato .28, print-alerts-rules)
- Print PC .28 must be "TOTALMENTE controlado": Windows inaccessible until PIN on `/print` (identical to /op check-in). Purpose: "responsabiliza quem imprime e deixa a gente trackear cada label". This is BOTTLE labels (flow ①), see §3.
- Print alerts: operator channel gets only "*produto* · Batch X · N labels"; never spam transitions; errors = incident state machine; weekend gate.

### 2026-08-01 (Deep Study; Build log "CENTRO DE ESTOQUE Fase A"; Centro de Estoque §1, §7; tiktok-shop-integration; Ideia do Bruno)
- Bruno's request in his words (Centro §1): track **quantidade, SKU, nº da caixa, local da caixa, BIN #, prateleira #, qtd no BIN**; bottles in bins on shelves; surplus in **numbered boxes on pallets by area**; bins refilled from boxes until box empties. Sold → **pick sheet "15 garrafas do bin X, prateleira Y"**. After P&P → **restock page** "prateleiras x,y,z precisam de reposição, as garrafas estão nas caixas x,y,z" and the restocker **records how much they placed**. Protections: "nunca confundir quantidade, nunca garrafa não contabilizada, nunca vender o que não temos". Low stock + EMS-aware alert in admin-orin ("rodar na linha ASAP" vs "colocar na lista de fabricação"). Entry: **admin decides FC-vs-warehouse split; operator records what was stored (bin or box)**. Known hole: bottle with bad label/seal set aside and never counted. **"P&P roda 9:30 → 13h. Nada pode deixar isso mais lento."** **Footer on EVERY shipping label**: nickname · local (Shelf·Bin·Pallet) · Picker ID + Packer ID. **"Fake inventory"/Momentum Guard**: don't let marketplace hit zero if product is made/in production/quick to produce.
- Bruno's own P&P print-page idea (verbatim, "Ideia do Bruno"): print orders from our system; connect TikTok + Shopify; page gives full picklist first, then product-by-product "now printing product X, it's in BIN # X SHelf Y", print button, auto-advance when the Rollo finishes, "a line of squares on the side keeps shows the last few locations", open question how picker confirms pick; must not slow shipping (9:30 → 1pm). **"THIS IS A VERY SERIOUS TASK BECAUSE WE CANNOT PRINT SOMETHING THAT WAS ALREADY SHIPPED OR PRINT AN ORDER THAT WAS CANCELLED… STRICT RULES."**
- Deep Study decisions with Bruno (§3.5, §13, Centro §7): **cost/valuation OUT of scope** ("isto é um sistema de ESTOQUE, não de lucro e prejuízo"); Excel discarded ("spreadsheets are backwards"); Salesforce and OSS rejected (second source of truth); native ledger in Postgres; camera never writes quantity; label-print as deduction trigger with idempotency by label identity; reservation "available = on_hand − reserved"; recommended stance "our ledger authoritative for on-hand; Veeqo authoritative for what shipped".
- TikTok real pain (memory tiktok): "o problema do TikTok NÃO é imprimir a label, é precisão de picking… risco de enviar item errado". Shipping labels print on **Simone's PC .246**, NOT .28. Package size tier = per **bottle COLOR**. `-C2/-C4` = casepack = bottle count.
- Zero-disruption condition: "operador não vê NADA até o launch" (Centro top note).

### 2026-08-01→08-04 (Centro §7 "Decisões travadas")
- Initial load: **operator counts and records**. Thresholds: **velocity AND admin** (both). Negative stock: **allow + loud alarm** (never block, RULE #0). Zero-disruption until Bruno flips the flag.

### 2026-08-02/03 (Build log; merge-safety-rules; shipping-label-footer)
- Mergeable orders: merge = same customer/same address/same day; **never trust Veeqo `mergeable_id`** (ZIP-only, groups strangers); freight forwarders = hard no-merge; "NUNCA pode acontecer".
- Product Setup requested as "fundação do RODAPÉ": nickname (strip `HF-`/`HFC-`, keep casepack), bottle color Black/White/Other, **eBay/Amazon/TikTok may have DIFFERENT SKUs for the same product → must connect multi-channel**.
- **KEY ARCHITECTURE DECISION 08-03**: label PDF never reaches our server today (Simone prints from Veeqo browser UI). Chosen path = **print from OUR system**: gather labels, compile one PDF (footers + by-product ordering + dividers), print at .246. Not spooler-intercept.
- Supplies (envelopes/boxes) = own inventory; **1 supply per package SIZE, deduct 1 per label** ("3 garrafas pretas = envelope maior, não 3×"). Bruno: "caixa BX / envelope A/B/Y não são nomes reais, eu que devia adicionar um a um, não você seedar."
- Menu: "o sistema tá muito confuso… coisas conectadas deviam ficar sob um menu principal, clica → submenu aparece."
- **RBAC**: "o sistema tem que ser por CARGO/função, não por nome" (Admin 150000 sees all; Henrique 510510 manager, no admin).

### 2026-08-04 (Build log "EDITAR estoque → grava no VEEQO"; "Estoque Veeqo VISÍVEL")
- Bruno: "por que Product Setup e Estoque·armazém não mostram o estoque de cada produto do EMS/Veeqo?" → Veeqo is the stock source (EMS has no sellable stock).
- **Column model corrected by Bruno: Armazém/Bins/Caixas SUM into total; Veeqo is SEPARATE, AFTER the total, does NOT sum.**
- Editing stock must be protected against wrong SKU/product and write TO Veeqo (only warehouse 108841).
- Discovery (ESTADO ATUAL): "o Veeqo já deduz sozinho nas vendas dele… Então NÃO construímos dedução própria pros canais Veeqo (seria contagem dupla); a nossa dedução vale só pro armazém físico (bins/caixas) e pros suprimentos."
- TikTok Partner route dead ("não vamos conseguir conectar pelo TikTok Partner"); interim CSV, encapsulated so API swap later "sem o sistema se confundir".

### 2026-08-05/06 (shipping-label-footer; ESTADO ATUAL; Build log 08-06; inventory-shrinkage-control)
- Bruno 08-05: PicklistPage = "the COMPUTER (on-screen) VERSION, not the printable one".
- Bruno exploded (twice) over A/Y/B: they were EXAMPLES, not real envelope names. "NEVER treat Bruno's illustrative examples as real config values."
- **PICKLIST RULE: print EVERYTHING allocated to HealthFare Warehouse that day, NEVER filter the queue** (FBA-pattern SKUs included; unusual SKU → warn admin-orin, item stays).
- **PICKER/PACKER DECIDED**: footer `Pick: ID Pack: ID` using dashboard employee ID (`v3.persons.id`), derived from active P&P tasks (printing task = Picker, packing task = Packer); undefined = blank, never guess.
- Catalog rules: FBA/WFS ≠ dup (warehouse allocation); C2/C3/C4 = legit casepacks; different MG = different product; **read SKU + title, never group by base name**; product with no SKU/no sales = "deixa eles quieto".
- Requests 08-06: operator page controlling stock/printing; picklist with SKU/Title/Location/QTY; own 4x6 print; watchdog comparing Simone's typed total vs Veeqo (ask only if |diff|>20, cite only the difference); no reason required on Impressão de ordens, only quantity.
- **Shrinkage scenario + 4 layers chosen by Bruno**: (1) quick "peguei do estoque" button (PIN+product+qty+motivo, ~3s), (2) automatic reconciliation physical-out vs labels/sales → incident admin-orin, (3) cycle counting 1–2 bins/day, (4) link every exit to camera + PIN. Philosophy RULE #0: never block, register, alert later.

### 2026-08-07/08 (envelope-sizes; merge-safety-rules "SKU é a fonte da verdade")
- Envelope 9x12 white capacity corrected 6→8; mixed rules for 9x12 (1P+6B, 2P+4B confirmed; 3P+?B PENDING); tie-break criterion: "se eu disse que é MAIS do que você calculou, eu tava certo; se VOCÊ calculou mais…, você tava certo". System should ask the operator on the spot then notify admin-orin; remove question when confirmed. Table editable in "Configurações de Inventário".
- **SKU is the source of truth for everything.** `HF-BENF-300` ≠ `-C2` ≠ `-C4`: different products, different stocks; never sum base + casepack; duplicates only if SKU identical.
- How to find a bottle's color: look at the EMS photo (`internal_sku` + `image_url`), inherit by SKU base, then spreadsheet.

### 2026-08-10 (message-writing-style) — all automated messages short, direct, human, no em-dash, max 1 emoji only for grave alerts.

### 2026-08-14 (rule-2) — RULE #2: any system change must be reflected in the Mermaid map + Obsidian, same session.

### 2026-08-17 (Centro §9; warehouse-inventory-model; S15)
- **Warehouse Inventory becomes a SYSTEM OF ITS OWN** (map S15) with **own ADMIN page and own OPERATOR page**; it is where **order shipment (P&P, flow ②) runs**; **completely unlinked from "fulfilled" inventory** (FBA/FC, flow ①).
- Model in plain words: (1) production finishes a batch → total bottles of X = a specific number → **added to warehouse inventory of X**; (2) admin decides how many go to **SHELVES** (next to P&P operator) vs **BOXES** (extra storage); (3) **Warehouse total of X = shelf qty + box qty, two numbers always visible**; (4) shelf empties → take from box, reorganize shelf (restock); (5) order needs X and shelf empty → go straight to box; (6) sold (order arrives) → qty **RESERVED automatically**; (7) **shipping label printed → qty DEDUCTED automatically**.
- **Target ADMIN menu, all under ONE section "Warehouse Inventory / Estoque & Produtos"**: Ver estoque · Stock | Estoque detalhado · Stock (detailed) | Product Setup | Configurações · Inventory Settings | **P&P subsection:** Pick & Pack · Picklist · Amazon · eBay · TikTok · End Of Day Shipment · 4x6 Printer Settings. Bruno: "talvez a gente reajuste esse menu depois, mas tem que ficar tudo junto no mesmo lugar."

### 2026-08-18 (Centro §9.1; UNCERTAINTIES U-27..U-32; S15.10–S15.15) — LOCKED
- **Reservation per PRODUCT.** Total = shelf + box is THE control number ("dá pra suprir os pedidos?"). Shelf/box only organize physically (**shelf ≈ 48 bottles max, box > 110**). Reserved = open Veeqo order lines (already in `pnp_order_lines`) → **available = total − reserved**. No manual reserve.
- **Deduction on "label printed" = Veeqo order shipped, ONLY Veeqo for now** (TikTok later). Mirror into our ledger **shelf first, box second, idempotent per line** (`veeqo-order-sync` + `StockService.pick`, `STOCK_DEDUCT_MODE=live`). We do NOT write to Veeqo on print (Veeqo already deducts). **Physical .28 print event is NOT a stock signal.**
- Manual adjustment on shelf or box OK; shelf + box always = product total.
- **Only ADMIN/MANAGER enters quantity into the warehouse.** Operators may propose; **every operator change needs admin approval** (approval queue). **Nuance:** shelf↔box moves apply IMMEDIATELY (total unchanged; logged; admin can revert). Add/remove from total, count corrections, RETURNS re-entering stock, "separadas" back to sellable → proposal, waits approval.
- **Channel inventories (Amazon/eBay/Walmart/TikTok) DEFERRED**: "focar em organizar o nosso estoque real". (S15.10: channel pages deferred; P&P + Picklist together in P&P subsection.)
- Later: our system ADDS to Veeqo after production and REMOVES on adjustments (`veeqo-api.setStock`, wh 108841) + **nightly reconciliation Veeqo × our total; DECIDED: alerts only, nothing auto-overwrites; our ledger = physical truth, Veeqo = sales truth** (U-32).
- **Damaged/problem = SECONDARY inventory per product** = `v3.stock_issues` "Separadas" (exists: damaged() moves qty there; statuses separated→relabeled/restocked/discarded); add reason 'return' (returns land here first); back-to-sellable and discard require approval; **never counted in sellable total**.
- Planejamento = placeholder (never built), Produto = production-per-product view + catalog list → **DECIDED (U-31): both stay untouched and move to Operação next to "Metas"** (Centro §9.1 phrases this as "recomendação… aguardando Bruno"; UNCERTAINTIES says DECIDED, see §7).
- Still open: `STOCK_DEDUCT_MODE` value in Railway; dedicated operator page vs /op panel (U-30 "Bruno picks when the operator page is designed").

---

## 2. Every page / screen / button described or built

### Admin dashboard-v4 (nav group "Estoque & Produtos", built 08-03; STRUCTURE S15.03)
- **Ver estoque** (`#estoque-geral`, StockOverviewPage, 08-04): per product **Veeqo · Bins · Caixas · Armazém(=total)**, Veeqo shown SEPARATE with left border (does not sum); filter "só baixo"; total chips; BAIXO flag (≤10); **"editar" button per product → PROTECTED modal**: shows PRODUCT + exact SKU + current stock, choose Contar(=)/Somar(+), preview of new value (239→340), 2 steps Revisar→Confirmar (button repeats "SKU → novo valor"); writes to Veeqo warehouse 108841 only; guard: SKU must be mapped to THAT product in channel veeqo (else 400); audited `veeqo_stock_set`.
- **Estoque detalhado** (`#inventory`, InventoryPage extended 08-01): tabs **Estoque** (per product bins+caixas, from /stock-overview), **Bins** (with RESTOCK), **Caixas**, **Planner** (dias de estoque, lead time EMS, zona PLANEJAR/baixo/zerado, batch EMS; lazy-loaded), **Separadas** (resolve: volta / label ok / descarte), **Suprimentos** (qty per supply, min, BAIXO status, buttons reabastecer/contar/mín, chip "Suprimentos baixos"; form "adicionar suprimento" name + type envelope/caixa/outro; section "qual suprimento cada tamanho usa" dropdown), **SKUs** (old matcher with **CONFIRMAR** button writing `product_skus`; -C2/-C3 → units auto; chip "confirmados/total"), + button **"⬆ TikTok CSV"** (Seller Center export upload; shows imported + unmapped count). Banner "carregando SKUs do Veeqo…" (SWR).
- **Product Setup** (`#produto-setup`, 08-03/04): searchable table SKU · produto · título · nickname (inline edit + "usar sugestão") · cor (dropdown Black/White/Other→text) · SKUs = channel-colored chips +/×; **SkuPicker**: pick channel → dropdown of ALL SKUs of that channel (SKU + title), filter by contains, SKU already linked elsewhere struck "já → produto" not clickable, Enter picks first free, fallback "+ usar 'texto' como SKU novo"; column **Estoque Veeqo**; column **Validade (rótulo)** (amber <12mo, red <6, tooltip caps/porções); badge **HOLD — NÃO IMPRIMIR**. Writes behind `V4_ALLOW_WRITES`.
- **Configurações de inventário** (`#config-estoque`, InventorySettingsPage): h1 "Configurações de *inventário*", sub "Tudo que o sistema usa pra decidir embalagem, impressão e estoque." Section A **Ordens e impressão**: card **Perguntas pendentes de embalagem** (question, context, "perguntada Nx", answer chip, button "Já resolvido, desligar"), **Tamanho do envelope por cor de garrafa** ("Regra do saco perfeito… Clique no número pra editar"), **Mistura de cores no mesmo envelope** (chip "suposição" for unconfirmed), **Suprimentos e mapa tamanho → suprimento**. Section B **Inventário e estoque**.
- **Planejamento** (`#planejamento`, placeholder) and **Produto** (`#produto`) currently in this group; decided to move to Operação next to Metas.
- **Operação → P&P** (`#pp`) and **Operação → Picklist** (`#picklist`, PicklistPage, 08-04, first STYLE-KIT page): eyebrow green, h1 "O que *separar hoje*", 3 KPIs Pedidos/Garrafas/Produtos, per-product divider (nickname serif large + local + amber "NO FIM: N pedidos ×2"), order rows (nº + canal + bottle chip, multi amber), customer names from Veeqo (~106/108), button "Imprimir / Baixar (4×6)" (browser print-to-PDF, `@page 4in 6in`, one product per label). Bruno: this is the on-screen version.
- **Card "P&P DO DIA"** in CommandCenter: ordens digitadas vs Veeqo vs diferença (green/amber/red); P&P cutoff turns RED "vencido" after 1PM. **Card "Pedidos hoje · Veeqo"** (07-08): total orders, units, channel pills, units per supplement.
- **Impressão** page (PrintingPage, 07-17): live physical status per printer, spooler SSE, day stats, ink CMYK bars, maintenance box, incidents card, problem history (bottle-label printer .28).
- **Usuários & Acessos** (RBAC): logins CRUD + roles×functions matrix (functions include view_stock, do_pnp, print_labels).
- **Roadmap board** (Operação → Roadmap): kanban of whole system, areas base_data/pnp/printing/inventory/employee/dashboard/tiktok/usps; standing rule to keep updated.
- **/cameras/tag**: Bruno drew 10 zones (5 packaging + 5 warehouse) with notes (camera_zones, mig 061).

### Operator /op workspace "Central de P&P & Estoque" (built 08-06, sandbox only, `OP_WORKSPACE_ENABLED` OFF; app.js)
- Opens automatically when registering "Impressão de ordens"; **fixed banner at top of check-in while task open**; button also in Limpeza/Organização and **Envio De Pacotes** menu ("Organização de Stock"). Header: "● HEALTHFARE P&P · CENTRAL", title "Central de *P&P & Estoque*", "← Voltar", sandbox chip "sandbox · não conta no estoque real", **"🖨 PRINT"** button.
- Full-width card **"Falta de estoque pro P&P de hoje"** (chips "N zerado(s)" / "N baixo(s)", stock-gaps list).
- Column 1 **"Imprimir ordem · picklist de hoje"** + "Atualizar": chips pedidos/garrafas/produtos; **Envelopes:** per size counts (BX last) + "+N sem tamanho"; per product card **SKU: · QTY: · Title: · Location:** ("local a definir" when no bin).
- Column 2 **"Registrar saída de estoque"**: "Pegou garrafa fora de um pedido? Registra aqui em 3 segundos. Nunca trava, só registra." Search supplement → qty → reason placeholder "motivo · ex.: extra pro pedido 12-345 (opcional)" / "o que aconteceu? (opcional)"; buttons **"Peguei do estoque"** / **"Danificada"** → "Registrar saída"; toasts "Saída registrada — obrigado!" / "Garrafa danificada registrada"; recent list with chip "danificada".
- **Does not close by itself** while task open (auto-logoff, deploy reload, day rollover held); closes only on task completion ("Tarefa concluída — Central fechada"). No mantra on screen.
- Server-only kiosk endpoints (STOCK_UI_ENABLED/allowlist): stock/context, store (entrada bin/caixa with "autorizado por"), restock (with found_bin/found_box reconciliation "de carona"), damaged (2 taps), count, take, recent, picklist, stock-gaps. Screens for entrada/restock/count NOT built.
- OPERATOR_PAGE.md (base /op): PIN 4 digits, "➕ Iniciar Tarefa", groups incl. "📦 Embalagem / Ordens · 🚚 Envio", "📋 Minhas tarefas ✔ Finalizar", "👥 Tasks da equipe agora 🤝 Entrar", voice notes, "Sair (fim do dia)".

### 4x6 paper picklist (approved 08-06)
- Header "PICKLIST · date · N ORDENS · N BOTTLES"; **envelopes to separate at top** (1 envelope per ORDER, computed by color + bottle count); per product: line 1 = `SKU + NOME COMPLETO mg/caps` small (e.g. `BENFOTIAMINE 300mg/200caps`, from `product_catalog.content_desc`), middle line **LOCATION** and **QTY** big uppercase (17px/22px, weight 900) "feito pra ser difícil de errar"; no order numbers; `@page 4in 6in`. Bruno's next step: "imprimir de novo e ver se ficou bom".

### Shipping label footer + label layout (Phase 2 pending; shipping-label-footer, tiktok memory, P&P shipping doc)
- Footer stamped in white strip (never over barcode/postage/address): **nickname ×qtd · package size (7×10… or BX) · local Shelf·Bin·Pallet · Pick: ID Pack: ID**.
- Labels grouped **by product**, groups in walking order (shelf→bin→pallet), **single-bottle first, multi at end**; **4×6 DIVIDER label** per product: NAME big · LOCAL big (SHELF X BIN Y) · multi warning "AT THE END: 3 orders ×2, 1 order ×6". Print from our page at .246 in picklist order; deduct supply per label (`consumeForSize`, source_ref = label id).
- Compact 4×6 doc for TikTok: stamped label per order + strip (#seq · nickname ×qtd · 📍local · buyer · order#); picklist ~8–12 lines/page.

### P&P Cockpit (Fase B, planned; Centro §6, Ideia do Bruno)
- Hub inside /op: **presence = task** (open "Imprimir & Coletar" opens `order_printing`; "quantas ordens?" question disappears because Veeqo has the number); permanent icon for other tasks. Full picklist → product-by-product with BIN/SHELF on screen while Rollo prints → auto-advance → **strip of recent locations**. **Strict state machine**: print only `picklisted`, re-verify at source API before printing, `printed` terminal (reprint = supervisor PIN), cancelled leaves list, **catalog HOLD BLOCKS printing**. Deadline assistant "23/47 produtos · ETA 12:38" vs 13h. Rollout: sandbox → shadow ≥1 week → "5 dias seguidos, zero divergência" → small slice → cutover with kill-switch (<1 min back to Veeqo).

### Print station .28 (bottle labels, built)
- `/print` kiosk: PIN pad identical to /op, **OTHER** button (non-employee says who + what → Slack #admin-orin), auto-lock 10 min, opens task "Impressão de Labels"; Windows lock app; unlock signals (`document.title = HF-PRINT-UNLOCKED`, `#unlocked`, `window.HF_PRINT_UNLOCKED`); `POST /api/print-event`; EPSON counter for exact labels.

### Planned but not existing (S15.10–S15.14): pages Amazon/eBay/TikTok (deferred), **End Of Day Shipment**, **4x6 Printer Settings**, dedicated operator warehouse page, approval queue UI, returns concept, reservation.

---

## 3. Physical reality (constraints on UI)

- **Shelves/bins**: bins on shelves next to P&P operator; 1 product per bin (`stock_bins`: bin_code, shelf_code, área, min_qty, cam/overlay); **shelf ≈ 48 bottles max** (Centro §9.1). **0 bins registered** today.
- **Boxes**: numbered boxes on **pallets by area** (`stock_boxes`: box_number, product, qty, área, status in_storage/empty); **box > 110 bottles**. 0 registered.
- Location levels: Shelf · Bin · Pallet ("pallet só se aplica"; open question "usa shelf+bin+pallet ou só shelf+bin?").
- Deep Study §10 recommendations: flat location table, codes like `A03-2-C` (≤8–10 chars, `A-Z 0-9 -` only, number in gaps, never encode product, deprecate not reuse), fixed homes for pick face, `allow_mixed_lots=false` on pick bins, USB HID wedge scanners on kiosks, Code 128 locations, DataMatrix products, audible feedback, granularity never beyond scan discipline.
- **Envelopes** (real, memory envelope-sizes 08-06/07): 4x8 = 1 white; 7x10 = 1 black or 4 white; 9x12 = 3 black / **8** white (ESTADO ATUAL and build log still say 6, see §7); 15x19 = 12 black / 24 white; beyond = BX box. Perfect-bag rule = smallest that fits. Mixed only 9x12: 0P+8B, 1P+6B ✓, 2P+4B ✓, 3P+?B PENDING (ask operator, notify admin-orin). Other envelopes: mixed = "a definir". Supplies registered: **0**.
- **Bottle color** Black/White/Other per product (124/173 filled); casepack inherits base color; clinic/service no color; Mushroom Blend blank.
- **Printers**: **.28** (DESKTOP-SUB8JL6, EPSON CW-C8000u roll) = **bottle/supplement labels ONLY**, kiosk-locked; **.246** (Simone, AMABILE, user 19546) = **shipping labels**, prints from Veeqo browser UI today; "Rollo label printer" mentioned by Bruno for shipping labels; SCAN form needs a full-page letter printer (TBD). No print-submit pipeline exists on .246 yet.
- **NGTeco** clock ON (memory index): checkout = authoritative; not directly in inventory but presence gates alerts.
- **Cameras**: cam8 warehouse, cam9 packaging; gateway `/frame/<cam>`; hard-off outside 07:00–20:30 Mon–Fri; **never write quantities** (~21% exact-count accuracy); use for empty-shelf alarm, banded corroboration, photo evidence, movement-without-record; 10 tagged zones exist.
- **Time box**: P&P 9:30 → 13:00 (mail cutoff, red "vencido" after 1PM); operators Simone/Ana in the morning; ~8:00–18:30 shift; Friday cleaning day.
- Warehouse ZIP 33309 Fort Lauderdale (CBT-eligible zone). Veeqo single account (clinic + supplements, distinguished by SKU pattern), 2 warehouses (108841 HealthFare Warehouse + Rosa Neciosup Castro), 9 channels.

---

## 4. Data & integrations

- **Veeqo**: REST `api.veeqo.com`, `x-api-key` Railway secret `VEEQO_API_KEY` server-only, key rotated 07-27. Channels seen: Amazon, eBay, Walmart, Shopify HealthFare, NaturWel, CSV, Merged (Veeqo does NOT see TikTok USPS). Warehouse **108841** only writable; #598954 Rosa (all zeros, 77 false low flags) needs decision. Three-tier Product→Sellable→Stock Entry (physical/allocated/available/incoming); live probe 48,287 units / 372 sellables; 479 sellables with stock. **No webhooks**, polling; 5 req/s blind 429; **shipped = label printed** (not carrier-scanned); pagination caps = incident; stock write `PUT /sellables/{id}/warehouses/{wh}/stock_entry` (POST 404), plan-gated silent-200 risk, kits not writable; `mergeable_id` = ZIP only (never trust); cancellation on eBay not exposed; `collection_manifest_id` reconstructs manifest; SCAN form API 404 on our key. Workers: `veeqo_orders` (5 min, mirror lines, deduct dry), `veeqo-mergeable-alert` (morning, admin-orin), `veeqo-dup-shipment-detector` (afternoon), `print_divergence` (12h NY, ask if |diff|>20), `unusual_sku`.
- **`pnp_order_lines`** (mig 059): per-line mirror all channels, status `pending→picklisted→printed→shipped/cancelled` never regresses, order_date NY, deducted_at; 6,201 shipped + 4 open + 15 cancelled (08-04); 489 quarantined (unmapped SKU, mostly clinic). Customer name not stored (08-04 gap; later pulled live from Veeqo).
- **EMS**: read-only API; `/products` = id, name, internal_sku, amazon_sku, amazon_asin, walmart_sku, **image_url** (105/105 photos), variation_type, pack_quantity; `/formulas` = units_per_bottle etc. **No color/size/label size, no sellable stock.** Pipeline stages (yield_review, to_count, label_printing…); `actual_yield_bottles` mostly NULL. Match Veeqo↔EMS 08-01: 276 matched (94 sku:internal, 173 base casepack, 4 walmart, 1 amazon, 4 name); EMS 100/105 covered; 203 Veeqo unmatched mostly `HF-PLN-*` clinic.
- **product_skus** (mig 058): SKU↔product per channel (veeqo/amazon/ebay/walmart/tiktok/shopify), units_per_pack, barcode, confirmed_at; 141 imported, **3 confirmed**; 3 known WRONG (Aloe↔Collagen, B1↔B2, Lithium↔Melatonin); double-suffix `-C2-C4` confirm per SKU. Only CONFIRMED SKUs move stock; unmapped = quarantine.
- **product_catalog** (mig 066): 98 SKUs, validade printed on label art (not physical lot expiry), lote, porção, potência, Supplement Facts, HOLD (1); 6 unmatched (GlucoBalance, LibiDoer, Mushroom Blend, NaturElixir, NaturMinerals, NaturShrooms); 37–40 raw material COAs.
- **Nickname/color/tier**: `products.nickname` (strip HF-/HFC-, keep casepack), `products.bottle_color`, `bottle_size_tiers` (per color), `envelope_mix` + `packing_questions` (mig 070), `supply_items` / `package_size_supply` / `supply_movements` (mig 064), `SupplyService.consumeForSize` ready, no production caller.
- **StockService** (single write door): storeIn/pick/restock/adjust/damaged/count; movement + qty same tx; idempotent (source, source_ref); floor-at-0 + incident; `is_test`. Known bypass: raw INSERT at `op.js:324` (R076).
- **TikTok**: 2026 rule = USPS labels must be bought via TikTok (API or Seller Center); Veeqo can't do USPS for TikTok; API can generate/fetch labels; Partner route stalled (no account manager); interim `tiktok-source.js` CSV → `ingestLines` (`TIKTOK_SOURCE=csv|api`); alternatives: seller in-house developer, ERP docking email tts.partner.product@tiktok.com, printmon on .246 (needs Bruno OK), last resort drop USPS; CBT ~40% cheaper; Packing List has SKU+photo (Tier 0).
- **USPS SCAN form**: no Veeqo API; plan = store `/api/scan-form` + manual upload + "P&P do dia concluído" trigger + AI browser agent on .28 + failure alert; letter printer TBD.
- **Flags**: STOCK_UI_ENABLED, STOCK_UI_ALLOWLIST, STOCK_ALERTS_CHANNEL, WORKER_VEEQO_ORDERS_ENABLED=true, WORKER_STOCK_ALERTS_ENABLED (off), STOCK_DEDUCT_MODE=dry|live, TIKTOK_SOURCE, OP_WORKSPACE_ENABLED (off), V4_ALLOW_WRITES.
- **RBAC** (mig 065): app_functions (16 incl. view_stock, do_pnp, print_labels, manage_users), app_roles admin/manager/operator, app_logins (Admin 150000, Henrique 510510).
- **CSVs**: `Estoque - Match Veeqo-EMS.csv` = 275 data rows (+header), columns `veeqo_sku, veeqo_title, veeqo_stock, ems_name, ems_internal_sku, matched_on` (matched_on: base:internal 173, sku:internal 94, sku:walmart 4, name 4, sku:amazon 1). `Estoque - Merges perdidos (semana 07-26 a 08-03).csv` = 60 data rows, columns `patient, city, preventable, order, channel, made, shipped, tracking`; 30 distinct patients; preventable true 8 / false 53 (rows split: eBay 28, Walmart 24, Amazon 9). Doc conclusion: 30 groups shipped separately but only 4 truly preventable (overlapping [created, shipped] windows); sequential repeat buyers are not errors.

---

## 5. Known blockers & data gaps

- **0 bins / 0 boxes / 0 movements** ("o mundo físico ainda não entrou"; the single blocker) → picklist/paper show "LOCAL A DEFINIR", no walking order, no footer location, no cycle counting, no reconciliation. Bruno must provide bins (code, shelf, product) + boxes (number, pallet area, product, qty) + initial operator count; proposed quick registration screen.
- Colors 124/173 (~49 missing), nicknames 133/173 (40 missing); Mushroom Blend not in system.
- Supplies registered 0 (real envelopes + qty + min + size→supply map).
- SKUs: 141 imported, 3 confirmed; 3 known wrong; double-suffix ambiguity; 6 catalog products without product row; 489 quarantined lines.
- No reservation state anywhere; no automatic production→warehouse add (store-in manual); shelf-vs-box not modeled at pick time (pick targets bin/box explicitly); no approval queue; no returns; no operator warehouse page; kiosk screens for entrada/restock/count not built; `OP_WORKSPACE_ENABLED` and `STOCK_UI_ENABLED` OFF; `STOCK_DEDUCT_MODE` unknown in Railway; `stock_alerts` OFF.
- Shipping label footer Phase 2: no PDF compile, no print pipeline at .246, supply deduction not wired, customer name/picker/packer not on picklist paper.
- TikTok API blocked (account manager); printmon on .246 needs Bruno OK; USPS SCAN form printer undecided; 9x12 3P+?B pending; mixed rules for other envelopes undefined.
- Deep Study open questions: authority Veeqo vs ledger (now decided alerts-only), wh #598954, consumables catalog, opening count date, Veeqo write test, camera experiment, FC quantity capture, printmon duplicate fix approval.
- Structural: raw stock INSERT in op.js; two order ledgers (public.orders_sessions vs production_counts kind=orders); V4_ALLOW_WRITES gating; everything runs against production (no staging).

---

## 6. UX / style rules Bruno insists on

- **STYLE-KIT** (`HealthFare/STYLE-KIT.html`, Kinto editorial): light blue ground `#f4f8fc` with dot grid, floating white pill navbar, cards 18px radius soft shadow, DM Serif Display titles with ONE italic green word (`#2e8b3c`), DM Sans body, DM Mono uppercase eyebrows, navy pills `#1a3a6b`, semantic colors only for status (green/amber/red/purple), tonal chips, **no em dashes in UI text**, AA contrast, light-only; scope tokens per page root (`.pl-*`, `.is-*`) and import DM fonts. Picklist, Central de P&P, InventorySettings and Roadmap already follow it.
- **Design port fidelity**: copy exact inline styles + ambient verbatim; verify with screenshot; two /op redesigns rejected for drifting.
- **Message style** (all automatic messages Slack/op/admin): short, direct, human, no em-dash, max 1 emoji only for grave alerts, bold only for name/number, full display_name, concrete.
- **RBAC roles-not-names**: everything keys on role/function (Picker/Packer/P&P handler), people are profiles.
- **Open files for Bruno** proactively (`start ""` / explorer) whenever referencing a deliverable.
- **RULE #0** record reality, never block (negative stock allowed + alarm; "Nunca trava, só registra"); **RULE #1** synchronize everything (one change → every tab/section/watchdog; Slack+/op+/admin+dashboard = one system); **RULE #2** map + Obsidian sync same session; Roadmap board kept current; process registry updated; no test messages in operator channels; smokes match real backend.
- Bruno's other explicit UX asks: connected things under one menu with submenus; the "editar" flow must show product + exact SKU + preview + confirm; picklist paper "difícil de errar" (big LOCATION/QTY); no inspirational mantra in the workspace; the workspace must not close under the operator; watchdog asks only the difference, never totals; never seed placeholder names as real config; "always the smallest bag that fits"; nothing may slow the 9:30→13:00 window; ask the operator on the spot when a packing rule is unknown and notify admin.

---

## 7. Contradictions between sources (flagged)

1. **9x12 white capacity**: ESTADO ATUAL 08-06 and Build log 08-06 say "9x12 = até 3 pretas / 6 brancas"; memory envelope-sizes (08-07) says Bruno corrected to **8 white**. Use 8 (later).
2. **Envelope tier letters**: Deep Study/tiktok memory/mig 063 seed use "1→A, 2–6→Y, 7–9→B, 10+→BX"; shipping-label-footer and Build log 08-06 state A/Y/B were **placeholders, deleted**; real tiers are 4x8/7x10/9x12/15x19/BX.
3. **Deduction trigger**: Deep Study §10.5 and Ideia do Bruno make **label print** (our cockpit / printer hook) the deduction trigger with label-identity idempotency; 08-18 decision = **Veeqo shipped status only**, .28 print event NOT a stock signal, TikTok later. Also Deep Study §3.4 proposes reservation "at pick-list print" while 08-18 says reservation = open order lines automatically on sale, no manual reserve.
4. **Ledger shape**: Deep Study designs `stock_moves` double-entry + `stock_balances` + `StockLedgerService` (add/remove/count/move/merge); built version = `stock_movements` single-entry with qty on bins/boxes + `StockService` (storeIn/pick/restock/adjust/damaged/count). Centro §2 acknowledges "≠ nomes do estudo". MASTER TO-DO E2 still lists building `stock_moves`.
5. **Who does initial load / who enters quantity**: Centro §7 (08-01→04): "Carga inicial: operador conta e lança"; Centro §1 item 6: operator records what was stored. 08-18: **only ADMIN/MANAGER enters quantity**, operator changes need approval (shelf↔box moves immediate). Deep Study §14.4: operators count but never approve their own adjustment (consistent with 08-18).
6. **Veeqo write-back / two-way**: ESTADO ATUAL 08-06 "não construímos dedução própria pros canais Veeqo (contagem dupla)… nossa dedução vale só pro armazém físico"; 08-18 says our ledger mirrors Veeqo shipped (that is deduction of the physical warehouse, consistent) AND later we ADD to Veeqo after production / REMOVE on adjustments. Deep Study warns write is plan-gated silent-200 and kits not writable; Build log 08-04 shows a real write worked (637→637 no-op + add-0) but never a real value change verified beyond "round-trip real" per ESTADO ATUAL.
7. **Planejamento/Produto placement**: Centro §9.1 says "recomendação: tirar as duas da seção Warehouse (aguardando Bruno)"; UNCERTAINTIES U-31 and S15.10 say "DECIDED 08-18: both stay untouched and move to Operação next to Metas".
8. **Target menu channel pages**: warehouse-inventory-model / Centro §9 list Amazon · eBay · TikTok in the P&P subsection (Walmart questioned); S15.10 says channel pages (Amazon · eBay · Walmart · TikTok) DEFERRED per 08-18.
9. **Print PC for shipping labels**: earlier tiktok memory paragraphs say "print-submit no .28"; the memory itself and P&P shipping doc correct this: shipping labels = **.246 (Simone)**, .28 = bottle labels only. USPS SCAN form memory still hosts the browser agent on .28 (fine, account-wide) but printer undecided.
10. **Picker/packer source**: tiktok memory 08-01 lists "PENDENTE definir" (1 person both / roster / login on .28); shipping-label-footer 08-06 says DECIDED (dashboard employee ID from active P&P tasks). MASTER TO-DO (08-05) still lists B1 as pending.
11. **Picklist scope**: Deep Study/early notes exclude clinic per-patient sellables and quarantine unmapped; Bruno 08-06 rule: picklist prints EVERYTHING allocated to HealthFare Warehouse, never filter, only warn (unmapped SKUs still appear in the P&P queue).
12. **Veeqo shipped counts**: Centro §3 (08-04) "6.201 linhas shipped + 4 abertas + 15 canceladas"; centro-de-estoque-phase-a memory (08-01) "4,319 shipped / 234 open / 1 cancelled". Different snapshot dates, not an error, but numbers in the design should not be hard-coded.
13. **Total column model**: 08-04 "Veeqo separate, doesn't sum into total" vs Deep Study/stock_alerts formula "dias de estoque = (armazém + marketplace) ÷ velocidade" which adds them; and 08-18 "total = shelf + box is THE control number" (Veeqo excluded). Design should treat Veeqo as a comparison column only.
14. **Envelope count basis**: 4x6 paper says "1 envelope por ORDEM" while supply rule says "deduct 1 per LABEL"; equivalent only if 1 label per order (merged orders / multi-package orders would differ).
