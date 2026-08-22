# Walmart (WFS) — mapa de SKU para produto

**Gerado em 2026-08-22 a partir do banco de produção.** Fonte de verdade: `v3.product_skus` (canal `veeqo`).

Os SKUs terminados em `-WFS` são listagens do **Walmart Fulfillment Services**. Fisicamente são a MESMA garrafa do SKU base: o estoque conta em unidades sob o produto pai (ver [[sku-parent-single-unit]]). Este arquivo existe para que a identificação sobreviva **mesmo se a conta da Veeqo for encerrada**.

- SKUs `-WFS` mapeados: **66**
- Todos com título e código de barras absorvidos (colunas `title` e `barcode`).
- Fotos e descrições: tabela `v3.product_images` e `v3.product_skus.description`.
- Leitura crua completa da conta: `v3.veeqo_snapshots` (últimos 8 retratos).

| SKU Walmart | Produto no sistema | # | SKU base | UPC | Título na Veeqo |
|---|---|---|---|---|---|
| `HF-CHAR-1200-WFS` | Activated Charcoal 1200mg | 71 | `HF-CHAR-1200` | 850031157262 | Healthfare Activated Charcoal Capsules 1200mg / 150 Capsules / Derived |
| `HF-ALOE-40000-WFS` | Aloe Vera 40,000mg | 74 | `HF-ALOE-40000` | 850054045140 | Healthfare Aloe Vera 40,000mg / 60 Capsules / Organic / Overall Health |
| `HF-APPL-3200-WFS` | Apple Cider Vinegar 3200mg | 75 | `HF-APPL-3200` | 850031157699 | Healthfare Apple Cider Vinegar 3,200mg / Maximum Strength ACV / Supple |
| `HF-BANA-3000-WFS` | Banaba Leaf | 21 | `HF-BANA-3000` | 850054045218 | Healthfare Banaba Leaf Extract Capsules 3000mg / 90 Capsules / Vegetar |
| `HF-BEET-2000-WFS` | Beet Root 2000mg | 78 | `HF-BEET-2000` | 850054045393 | Healthfare Beet Root 2000mg / 60 Veg Capsules / Organic Beetroot Powde |
| `HF-BENF-300-C2-WFS` | Benfotiamine 300mg | 79 | `HF-BENF-300` | 850031157590 | HealthFare Benfotiamine 300mg / 200 Capsules per Bottle (2-Pack) / Enh |
| `HF-BENF-300-WFS` | Benfotiamine 300mg | 79 | `HF-BENF-300` | 850031157187 | Benfotiamine 300mg 200 Veg Capsules Fat Soluble Thiamine Vitamin B1 He |
| `HF-BENF-600-WFS` | Benfotiamine 600mg | 81 | `HF-BENF-600` | 850054045355 | Healthfare Benfotiamine 600mg / 200 Veg Capsules / Enhanced Absorption |
| `HF-BERB-1500-WFS` | Berberine 2500mg | 82 | `HF-BERB-1500` | 850031157651 | HealthFare Berberine with Ceylon Cinnamon 2500mg / 60 Veg Capsules / P |
| `HF-HCL-5000-WFS` | Berberine Hcl 5000mg | 85 | `HF-HCL-5000` | 850054045430 | Healthfare Berberine HCL 5000mg / 120 Veg Capsules / Extra Strength He |
| `HF-BERB-5000-WFS` | Berberine with Ceylon Cinnamon Extract 6000mg | 226 | `-` | 850031157644 | HealthFare Berberine with Ceylon Cinnamon Extract 6000mg / 150 Veg Cap |
| `HF-BILB-5000-WFS` | Bilberry 5000mg | 86 | `HF-BILB-5000` | 850031157484 | Bilberry Extract Capsules 5000mg / 200 Count / Supports Eye Health / U |
| `HF-BITT-9500-WFS` | Bitter Melon 9500mg | 87 | `HF-BITT-9500` | 850031157453 | Healthfare Organic Bitter Melon Extract 9500mg / 200 Capsules / Ultra  |
| `HF-AGED-2000-WFS` | Black Garlic 2000mg | 88 | `HF-BLAC-2000` | 850031157279 | Healthfare Fermented Black Garlic Extract Dietary Supplement 2000mg /  |
| `HF-BUTC-2400-WFS` | Butcher's Broom 2400mg | 90 | `HF-BUTC-2400` | 850031157507 | Healthfare Butchers Broom Capsules / 2400mg / 120 Count / Supports Blo |
| `HF-CAYE-600-WFS` | Cayenne Pepper 600mg | 91 | `HF-CAYE-600` | 850054045232 | Healthfare Cayenne Pepper Capsules 600mg / 200 Capsules / 45,000 HU /  |
| `HF-SKUL-1000-WFS` | Chinese Skullcap 1000mg | 92 | `HF-SKUL-1000` | 850031157170 | Healthfare Skullcap 1000mg / 200 Capsules / Extra Strength Formula / N |
| `HF-CHLO-600-WFS` | Chlorophyll | 27 | `HF-CHLO-600` | 850054045300 | Healthfare Chlorophyll Capsules 600mg / 150 Veg Capsules / Premium Pla |
| `HF-CHRO-1000-WFS` | Chromium Picolinate 1000mcg | 94 | `HF-CHRO-1000` | 850031157552 | HealthFare Chromium Picolinate 1000mcg / 400 Vegan Tablets / High Abso |
| `HF-BERG-1200-WFS` | Citrus Bergamot 1200mg | 96 | `HF-BERG-1200` | 850054045492 | HealthFare Citrus Bergamot 1200mg / 150 Capsules / Non-GMO, Gluten-Fre |
| `HF-DASP-3000-WFS` | D-Aspartic Acid | 30 | `HF-DASP-3000` | 850031157477 | Healthfare D-Aspartic Acid (DAA) 3000mg / 200 Capsules / DAA Premium A |
| `HF-DEVI-2600-WFS` | Devil's Claw 2600mg | 98 | `HF-DEVI-2600` | 850031157514 | Healthfare Devils Claw Herbal Supplement / 2600mg / 120 Count / Suppor |
| `HF-FEM-600-C2-WFS` | Feminiva | 33 | `HF-FEM-600` | 850054045188 | HealthFare Feminiva Boric Acid / 2-Pack, 30 Vaginal Suppositories Each |
| `HF-FENU-6000-WFS` | Fenugreek 6000mg | 102 | `HF-FENU-6000` | 850054045201 | Healthfare Fenugreek Capsules 6000mg / 150 Capsules / Vegetarian / Non |
| `HF-FOTI-1000-WFS` | Fo-Ti 1000mg | 103 | `HF-FOTIH-1000` | 850031157545 | HealthFare Fo-Ti He Shou Wu 1000mg / 200 Count / Fo-Ti Herbal Suppleme |
| `HF-GING-4000-WFS` | Ginger Root 4000mg | 107 | `HF-GING-4000` | 850031157231 | Healthfare Ginger Root Capsules 4000mg / 200 Count / Ultra Strength Su |
| `HF-GINK-7500-WFS` | Ginkgo Biloba 7500mg | 108 | `HF-GINK-7500` | 850054045133 | Healthfare Ginkgo Biloba 7500mg (200 Capsules) Non-GMO Vegeterian |
| `HF-GLTH-1000-WFS` | Glutathione 1000mg | 109 | `HF-GLTH-1000` | 850054045126 | Healthfare Glutathione 1000mg GSH L-Glutathione (Reduced) (150 Capsule |
| `HF-GRAV-5000-WFS` | Graviola Soursop 5000mg | 110 | `HF-GRAV-5000` | 850031157316 | Healthfare Graviola Capsules 5000mg Leaf & Fruit Extract / 200 Capsule |
| `HF-GREE-2100-WFS` | Green Tea | 39 | `HF-GREE-2100` | 850031157460 | Healthfare ECGG Green Tea Extract / 200 Capsules / Standardized to Con |
| `HF-GYNM-4000-WFS` | Gymnema Sylvestre | 40 | `HF-GYSY-4000` | 850054045270 | Healthfare Gymnema Sylvestre Supplements, 4000mg / 200 Veg Capsules /  |
| `HF-HAWT-3000-WFS` | Hawthorn 3000mg | 114 | `HF-HAWT-3000` | 850054045287 | Healthfare Hawthorn Supplement, 3000mg / 200 Veg Capsules / Traditiona |
| `HF-LCAR-1500-WFS` | L-Carnitine 1500mg | 117 | `HF-LCAR-1500` | 850054045447 | Healthfare Acetyl L-Carnitine 1500mg / 120 Veg Capsules / High Potency |
| `HF-LGLU-1000-WFS` | L-Glutamine 1000mg | 118 | `HF-LGLU-1000` | 850031157620 | Healthfare L-Glutamine 1000mg / 240 Capsules / Amino Acid Fuel for Gut |
| `HF-LICO-900-WFS` | Licorice Root 600mg | 119 | `HF-LICO-900` | 850031157255 | Healthfare Ultra High Purity Licorice Root Capsules 900 mg / 360 Count |
| `HF-LITH-130-WFS` | Lithium Orotate 130mg 200tabs | 120 | `HF-LITH-130` | 850054045164 | HealthFare Lithium Orotate 130mg / 200 Tablets / Elemental Lithium / B |
| `HF-LTHE-400-WFS` | L-Theanine 400mg 150caps | 177 | `HF-LTHE-400` | 850054045553 | Healthfare L-Theanine / 150 Vegan Capsules / Non-GMO, Gluten-Free / Ma |
| `HF-GLYC-500-WFS` | Magnesium | 47 | `HF-GLYC-500` | 850054045317 | HealthFare Magnesium Glycinate 500mg / High-Absorption Chelated Magnes |
| `HF-TAUR-1500-WFS` | Magnesium | 47 | `HF-GLYC-500` | 850054045577 | HealthFare Magnesium Taurate 1500mg, 240 Capsules, Serving size 3 |
| `HF-MCIT-500-WFS` | Magnesium Citrate 500mg | 122 | `HF-MCIT-500` | 850054045294 | HealthFare Magnesium Citrate Capsules, 500mg / 90 Veg Capsules / Essen |
| `HF-MELA-5-WFS` | Melatonin Berry Flavor 5mg - Amazon | 126 | `HF-MELA-5` | 850054045478 | HealthFare Lithium Orotate 5mg / 200 Tablets / Trace Mineral Supplemen |
| `HF-MELA-20-WFS` | Melatonin Complex 20mg | 127 | `HF-MELA-20` | 850031157576 | Healthfare Melatonin 20mg / 150 Tablets / Complex with L-Theanine, Val |
| `HF-MELA-60-WFS` | Melatonin Fast Absorption 60mg | 128 | `HF-MELA-60` | 850031157583 | Healthfare Melatonin 60mg / 90 Tablets / Vegetarian Formula / Non-GMO  |
| `HF-MULL-3000-WFS` | Mullein Leaf | 50 | `HF-MULL-3000` | 850031157521 | Healthfare Mullein Leaf Capsules / 3000mg / 200 Count / Support Lung C |
| `HF-MYOI-2600-WFS` | Myo Inositol 2600mg | 133 | `HF-MYOI-2000` | 850031157330 | HealthFare Myo Inositol Supplement, 2600mg / 200 Veg Capsules / Ultra  |
| `HF-NAC-1000-WFS` | Nac 1000mg | 134 | `HF-NAC-1000` | 850054045423 | Healthfare NAC N-Acetyl L-Cysteine Supplement / 1000mg High Potency /  |
| `HF-NAC-1300-WFS` | Nac 1300mg | 135 | `HF-NAC-1300` | 850031157637 | Healthfare N-Acetyl L-Cysteine (NAC) / 1300mg / 240 Capsules / Traditi |
| `HF-CELL-10573-WFS` | Nad+ Celluvance 10,573mg 120 Caps | 137 | `HF-CELL-10573` | 850054045379 | HealthFare Celluvance NAD Supplement – NMN Alternative Liposomal Formu |
| `HF-PANT-500-WFS` | Pantothenic Acid | 54 | `-` | 850031157378 | Healthfare Pantothenic Acid (Vitamin B5) 500mg / 200 Capsules / Suppor |
| `HF-PLAN-2000-WFS` | Plant Sterols | 56 | `HF-PLAN-2000` | 850031157361 | Healthfare Plant Sterols 2000mg / 240 Count / Extra Strength Capsules  |
| `HF-POTA-130-C2-WFS` | Potassium Iodide | 57 | `HF-POTA-130` | 850031157415 | HealthFare Potassium Iodide 130mg / 120 Fast-Dissolving Tablets (2 Pac |
| `HF-POTA-130-C6-WFS` | Potassium Iodide | 57 | `HF-POTA-130` | 850031157422 | HealthFare Potassium Iodide 130mg / 360 Fast-Dissolving Tablets (6 Pac |
| `HF-PSYL-1500-WFS` | Psyllium Husk 1500mg | 146 | `HF-PSYL-1500` | 850054045225 | Healthfare Psyllium Husk Capsules 1500mg / 240 Count / Supports Digest |
| `HF-RHOD-1000-WFS` | Rhodiola | 13 | `HF-RHOD-1000` | 850054045324 | Healthfare Rhodiola Rosea Capsules 1000mg / 90 Veg Capsules / Premium  |
| `HF-RUTI-500-WFS` | Rutin 500mg | 149 | `HF-RUTI-500` | 850054045157 | Healthfare Rutin 500mg Rutoside Bioflavonoid and Antioxidant (200 Caps |
| `HF-SAWP-4000-WFS` | Saw Palmetto 4000mg | 150 | `HF-SAWP-4000` | 850031157606 | Healthfare Saw Palmetto Extract / 4000mg / 150 Capsules / Traditional  |
| `HF-STING-7500-WFS` | Stinging Nettle | 62 | `HF-STIN-7500` | 850031157354 | Healthfare Stinging Nettle Leaf Extract 7500mg / 200 Caps / Non-GMO /  |
| `HF-TRIB-32500-WFS` | Tribulus Terrestris 32,500mg | 152 | `HF-TRIB-32500` | 850031157682 | Healthfare Tribulus Terrestris Extract 32,500mg Maximum Strength (200  |
| `HF-TURK-110000-WFS` | Turkesterone | 64 | `-` | 850054045331 | HealthFare Turkesterone with Tongkat Ali Capsules 110,000mg / 150 Caps |
| `HF-UROL-1000-WFS` | Urolithin A | 70 | `HF-UROL-1000` | 850054045539 | HealthFare Urolithin A / 150 Vegan Capsules / Non-GMO, Gluten-Free / M |
| `HF-VALE-3000-WFS` | Valerian Root 3000mg | 154 | `HF-VALE-3000` | 850031157200 | Healthfare Valerian Root Capsules / 240 Pills / 3000mg / Ultra High Po |
| `HF-VTB1-100-WFS` | Vitamin B1 100mg | 155 | `HF-VIB1-100` | 850031157668 | HealthFare Vitamin B1 100mg / 60 Vegan Capsules / Thiamine Supplement  |
| `HF-VB12-5000-WFS` | Vitamin B12 (Methylcobalamin) | 175 | `HF-VB12-5000` | 850054045546 | Vitamin B12 (Methylcobalamin) - 5000mcg 240 Tablets (1 Daily) |
| `HF-VTB2-180-C2-WFS` | Vitamin B2 | 67 | `-` | 850031157989 | HealthFare Vitamin B2 Riboflavin 400mg / Pack of 2 / 180 Veg Capsules  |
| `HF-VTB2-180-WFS` | Vitamin B2 400mg | 157 | `HF-VTB2-400` | 850031157248 | Healthfare Vitamin B2 400mg / 180 Capsules / Riboflavin / Gluten Free  |
| `HF-WHIT-7500-WFS` | White Kidney Bean 7500mg | 159 | `HF-WHIT-7500` | 850031157224 | Healthfare White Kidney Bean Extract / 7,500 mg / 240 Capsules / Poten |

## Como reconstruir esta tabela

```sql
SELECT ps.sku, ps.title, ps.barcode, p.canonical_name, p.id
  FROM v3.product_skus ps JOIN v3.products p ON p.id = ps.product_id
 WHERE ps.sku ILIKE '%-WFS' ORDER BY p.canonical_name;
```

O worker `veeqo-sku-sync` (opt-in `WORKER_VEEQO_SKU_SYNC_ENABLED`) religa automaticamente qualquer `-WFS` novo pela raiz do SKU e avisa no Slack o que não conseguiu casar.
