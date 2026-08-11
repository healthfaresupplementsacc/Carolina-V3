window.HF_DATA = {
 "generated_at": "2026-08-07T00:37:16.580Z",
 "groups": [
  {
   "key": "linha",
   "icon": "🏭",
   "label": "Linha de Produção",
   "types": [
    {
     "slug": "production_line",
     "label": "Linha de produção",
     "requires_product": true,
     "note_required": false,
     "orders_required": false,
     "requires_order_count": false,
     "counts_as_pp": false
    },
    {
     "slug": "review",
     "label": "Revisão",
     "requires_product": true,
     "note_required": false,
     "orders_required": false,
     "requires_order_count": false,
     "counts_as_pp": false
    },
    {
     "slug": "labeling",
     "label": "Colocar labels",
     "requires_product": false,
     "note_required": false,
     "orders_required": false,
     "requires_order_count": false,
     "counts_as_pp": false
    },
    {
     "slug": "fnsku_labeling",
     "label": "Colocando FNSKU / Código de Barras",
     "requires_product": false,
     "note_required": false,
     "orders_required": false,
     "requires_order_count": false,
     "counts_as_pp": false
    },
    {
     "slug": "counting",
     "label": "Contagem",
     "requires_product": true,
     "note_required": false,
     "orders_required": false,
     "requires_order_count": false,
     "counts_as_pp": false
    },
    {
     "slug": "line_changeover",
     "label": "Troca de linha",
     "requires_product": false,
     "note_required": false,
     "orders_required": false,
     "requires_order_count": false,
     "counts_as_pp": false
    },
    {
     "slug": "production_line_other",
     "label": "✏️ Outro (Linha)",
     "requires_product": false,
     "note_required": true,
     "orders_required": false,
     "requires_order_count": false,
     "counts_as_pp": false
    }
   ]
  },
  {
   "key": "formulacao",
   "icon": "🧪",
   "label": "Formulação",
   "types": [
    {
     "slug": "separating",
     "label": "Separando ingredientes",
     "requires_product": true,
     "note_required": false,
     "orders_required": false,
     "requires_order_count": false,
     "counts_as_pp": false
    },
    {
     "slug": "weighing",
     "label": "Weighing (Pesagem)",
     "requires_product": true,
     "note_required": false,
     "orders_required": false,
     "requires_order_count": false,
     "counts_as_pp": false
    },
    {
     "slug": "mixing",
     "label": "Mixing (Mistura)",
     "requires_product": true,
     "note_required": false,
     "orders_required": false,
     "requires_order_count": false,
     "counts_as_pp": false
    },
    {
     "slug": "encapsulation",
     "label": "Encapsulation / Tablet",
     "requires_product": true,
     "note_required": false,
     "orders_required": false,
     "requires_order_count": false,
     "counts_as_pp": false
    },
    {
     "slug": "material_handling",
     "label": "Material prep",
     "requires_product": false,
     "note_required": false,
     "orders_required": false,
     "requires_order_count": false,
     "counts_as_pp": false
    },
    {
     "slug": "formulation_other",
     "label": "✏️ Outro (Formulação)",
     "requires_product": false,
     "note_required": true,
     "orders_required": false,
     "requires_order_count": false,
     "counts_as_pp": false
    }
   ]
  },
  {
   "key": "limpeza",
   "icon": "🧹",
   "label": "Limpeza / Organização",
   "types": [
    {
     "slug": "cleaning",
     "label": "Limpeza",
     "requires_product": false,
     "note_required": false,
     "orders_required": false,
     "requires_order_count": false,
     "counts_as_pp": false
    },
    {
     "slug": "repair",
     "label": "Conserto de máquina",
     "requires_product": false,
     "note_required": true,
     "orders_required": false,
     "requires_order_count": false,
     "counts_as_pp": false
    },
    {
     "slug": "facility_maintenance",
     "label": "Manutenção",
     "requires_product": false,
     "note_required": false,
     "orders_required": false,
     "requires_order_count": false,
     "counts_as_pp": false
    },
    {
     "slug": "organization",
     "label": "Organização do Warehouse",
     "requires_product": false,
     "note_required": false,
     "orders_required": false,
     "requires_order_count": false,
     "counts_as_pp": false
    },
    {
     "slug": "stock_organization",
     "label": "Organização de Stock (Inventário)",
     "requires_product": false,
     "note_required": false,
     "orders_required": false,
     "requires_order_count": false,
     "counts_as_pp": false
    },
    {
     "slug": "machine_downtime",
     "label": "Máquina parada",
     "requires_product": false,
     "note_required": true,
     "orders_required": false,
     "requires_order_count": false,
     "counts_as_pp": false
    },
    {
     "slug": "label_change",
     "label": "🏷️ Troca/Ajuste de Label",
     "requires_product": false,
     "note_required": true,
     "orders_required": false,
     "requires_order_count": false,
     "counts_as_pp": false
    },
    {
     "slug": "cleaning_other",
     "label": "✏️ Outro (Limpeza/Suporte)",
     "requires_product": false,
     "note_required": true,
     "orders_required": false,
     "requires_order_count": false,
     "counts_as_pp": false
    }
   ]
  },
  {
   "key": "embalagem",
   "icon": "📦",
   "label": "Envio De Pacotes",
   "types": [
    {
     "slug": "order_printing",
     "label": "Impressão de ordens",
     "requires_product": false,
     "note_required": false,
     "orders_required": true,
     "requires_order_count": true,
     "counts_as_pp": true
    },
    {
     "slug": "order_printing_2",
     "label": "2ª impressão",
     "requires_product": false,
     "note_required": false,
     "orders_required": true,
     "requires_order_count": true,
     "counts_as_pp": true
    },
    {
     "slug": "stock_organization",
     "label": "Organização de Stock (Inventário)",
     "requires_product": false,
     "note_required": false,
     "orders_required": false,
     "requires_order_count": false,
     "counts_as_pp": false
    },
    {
     "slug": "packaging",
     "label": "Empacotando Suplementos",
     "requires_product": false,
     "note_required": false,
     "orders_required": false,
     "requires_order_count": false,
     "counts_as_pp": true
    },
    {
     "slug": "marketplace_prep",
     "label": "Trocar label",
     "requires_product": false,
     "note_required": false,
     "orders_required": false,
     "requires_order_count": true,
     "counts_as_pp": true
    },
    {
     "slug": "clinic_shipment",
     "label": "Envio Clínica",
     "requires_product": false,
     "note_required": false,
     "orders_required": false,
     "requires_order_count": true,
     "counts_as_pp": false
    },
    {
     "slug": "packaging_other",
     "label": "✏️ Outro (Embalagem)",
     "requires_product": false,
     "note_required": true,
     "orders_required": false,
     "requires_order_count": false,
     "counts_as_pp": true
    }
   ]
  },
  {
   "key": "envio",
   "icon": "🚚",
   "label": "Envio De Caixas",
   "types": [
    {
     "slug": "box_closing",
     "label": "Fechando caixas",
     "requires_product": false,
     "note_required": false,
     "orders_required": false,
     "requires_order_count": false,
     "counts_as_pp": false
    },
    {
     "slug": "fnsku_labeling",
     "label": "Colocando FNSKU / Código de Barras",
     "requires_product": false,
     "note_required": false,
     "orders_required": false,
     "requires_order_count": false,
     "counts_as_pp": false
    },
    {
     "slug": "shipping_walmart",
     "label": "Envio Walmart",
     "requires_product": false,
     "note_required": false,
     "orders_required": false,
     "requires_order_count": false,
     "counts_as_pp": false
    },
    {
     "slug": "shipping_amazon",
     "label": "Envio Amazon",
     "requires_product": false,
     "note_required": false,
     "orders_required": false,
     "requires_order_count": false,
     "counts_as_pp": false
    },
    {
     "slug": "dc_shipment",
     "label": "Envio Distribution Center",
     "requires_product": false,
     "note_required": false,
     "orders_required": false,
     "requires_order_count": false,
     "counts_as_pp": false
    },
    {
     "slug": "clinic_shipment",
     "label": "Envio Clínica",
     "requires_product": false,
     "note_required": false,
     "orders_required": false,
     "requires_order_count": true,
     "counts_as_pp": false
    },
    {
     "slug": "shipping_other",
     "label": "✏️ Outro (Envio)",
     "requires_product": false,
     "note_required": true,
     "orders_required": false,
     "requires_order_count": false,
     "counts_as_pp": false
    }
   ]
  },
  {
   "key": "outros",
   "icon": "⋯",
   "label": "Outros",
   "types": [
    {
     "slug": "special_task",
     "label": "✨ Algo Especial",
     "requires_product": false,
     "note_required": true,
     "orders_required": false,
     "requires_order_count": false,
     "counts_as_pp": false
    },
    {
     "slug": "break",
     "label": "Pausa",
     "requires_product": false,
     "note_required": true,
     "orders_required": false,
     "requires_order_count": false,
     "counts_as_pp": false
    },
    {
     "slug": "meeting",
     "label": "Reunião",
     "requires_product": false,
     "note_required": true,
     "orders_required": false,
     "requires_order_count": false,
     "counts_as_pp": false
    },
    {
     "slug": "training",
     "label": "Treinamento",
     "requires_product": false,
     "note_required": true,
     "orders_required": false,
     "requires_order_count": false,
     "counts_as_pp": false
    }
   ]
  }
 ],
 "quick": [
  {
   "slug": "lunch",
   "label": "Almoço",
   "icon": "🍽️",
   "requires_product": false,
   "note_required": false,
   "orders_required": false
  }
 ],
 "supplements": [
  {
   "id": 15,
   "canonical_name": "Acetyl L-Carnitine",
   "aliases": [
    "acetyl l-carnitine",
    "acetil carnitina",
    "alcar",
    "l-carnitine",
    "carnitine",
    "acetil l-carnitina"
   ],
   "last_used_at": "2026-07-21T19:51:09.265Z"
  },
  {
   "id": 16,
   "canonical_name": "Activated Charcoal",
   "aliases": [
    "charcoal",
    "carvao ativado",
    "carvao",
    "activated charcoal",
    "carbon ativado"
   ],
   "last_used_at": null
  },
  {
   "id": 71,
   "canonical_name": "Activated Charcoal 1200mg",
   "aliases": [
    "HF-CHAR-1200",
    "HEAFA-2010-150-FBA",
    "HF-CHAR-1200-WFS"
   ],
   "last_used_at": null
  },
  {
   "id": 72,
   "canonical_name": "Activated Charcoal 1200mg C2",
   "aliases": [
    "HF-CHAR-1200-C2",
    "HEAFA-2010-150-FBA-C2",
    "HF-CHAR-1200-C2-WFS"
   ],
   "last_used_at": null
  },
  {
   "id": 17,
   "canonical_name": "Aged Black Garlic",
   "aliases": [
    "aged black garlic",
    "black garlic",
    "alho negro",
    "alho preto",
    "garlic",
    "alho"
   ],
   "last_used_at": "2026-07-29T14:01:33.328Z"
  },
  {
   "id": 18,
   "canonical_name": "Akkermansia",
   "aliases": [
    "akkermansia",
    "akkermansia muciniphila",
    "akkemansia"
   ],
   "last_used_at": "2026-07-08T22:07:35.335Z"
  },
  {
   "id": 162,
   "canonical_name": "Akkermansia + Inulin",
   "aliases": [
    "HFC-AKKERMANSIA-INULIN"
   ],
   "last_used_at": null
  },
  {
   "id": 73,
   "canonical_name": "Akkermansia Municiphila Probiotic 300bi Afu",
   "aliases": [
    "HF-AKKE-300",
    "HEAFA-2057-90-FBA",
    "HF-AKKE-300-WFS"
   ],
   "last_used_at": null
  },
  {
   "id": 19,
   "canonical_name": "Aloe Vera",
   "aliases": [
    "aloe",
    "aloe vera",
    "babosa",
    "gel de aloe"
   ],
   "last_used_at": null
  },
  {
   "id": 74,
   "canonical_name": "Aloe Vera 40,000mg",
   "aliases": [
    "HF-ALOE-40000",
    "HEAFA-2050-90-FBA",
    "HF-ALOE-40000-WFS"
   ],
   "last_used_at": null
  },
  {
   "id": 20,
   "canonical_name": "Apple Cider Vinegar",
   "aliases": [
    "apple cider vinegar",
    "apple cider",
    "cider",
    "acv vinegar",
    "vinagre de maca",
    "acv",
    "vinagre",
    "cider vinegar"
   ],
   "last_used_at": "2026-08-04T20:34:12.424Z"
  },
  {
   "id": 75,
   "canonical_name": "Apple Cider Vinegar 3200mg",
   "aliases": [
    "HF-APPL-3200",
    "HEAFA-2043-150-FBA",
    "HF-APPL-3200-WFS"
   ],
   "last_used_at": null
  },
  {
   "id": 76,
   "canonical_name": "Ashwagandha 500mg",
   "aliases": [
    "HF-ASHW-500",
    "HEAFA-2085-120-FBA ",
    "HF-ASHW-500-WFS"
   ],
   "last_used_at": null
  },
  {
   "id": 21,
   "canonical_name": "Banaba Leaf",
   "aliases": [
    "banaba",
    "banaba leaf",
    "lagerstroemia"
   ],
   "last_used_at": null
  },
  {
   "id": 77,
   "canonical_name": "Banaba Leaf 3000mg",
   "aliases": [
    "HF-BANA-3000",
    "HEAFA-2053-90-FBA",
    "HF-BANA-3000-WFS"
   ],
   "last_used_at": null
  },
  {
   "id": 22,
   "canonical_name": "Beet Root",
   "aliases": [
    "beet root",
    "beterraba",
    "beet",
    "beetroot",
    "red beet"
   ],
   "last_used_at": null
  },
  {
   "id": 78,
   "canonical_name": "Beet Root 2000mg",
   "aliases": [
    "HF-BEET-2000",
    "HEAFA-2072-60-FBA",
    "HF-BEET-2000-WFS"
   ],
   "last_used_at": null
  },
  {
   "id": 2,
   "canonical_name": "Benfotiamine",
   "aliases": [
    "benfotiamina",
    "benfo",
    "benfotiamine"
   ],
   "last_used_at": "2026-08-06T20:47:24.273Z"
  },
  {
   "id": 79,
   "canonical_name": "Benfotiamine 300mg",
   "aliases": [
    "HF-BENF-300",
    "HEAFA-2002-200-FBA",
    "HF-BENF-300-WFS"
   ],
   "last_used_at": null
  },
  {
   "id": 80,
   "canonical_name": "Benfotiamine 300mg - C2",
   "aliases": [
    "HF-BENF-300-C2",
    "HEAFA-2002-200-FBA-C2",
    "HF-BENF-300-C2-WFS"
   ],
   "last_used_at": "2026-08-06T21:53:21.838Z"
  },
  {
   "id": 81,
   "canonical_name": "Benfotiamine 600mg",
   "aliases": [
    "HF-BENF-600",
    "HEAFA-2002-600-FBA",
    "HF-BENF-600-WFS"
   ],
   "last_used_at": null
  },
  {
   "id": 23,
   "canonical_name": "Berberine",
   "aliases": [
    "berberina",
    "berberine",
    "berberine ceylon",
    "berberine cinnamon",
    "berberin",
    "berberine cinnamon ceylon"
   ],
   "last_used_at": "2026-07-29T21:08:01.988Z"
  },
  {
   "id": 82,
   "canonical_name": "Berberine 2500mg",
   "aliases": [
    "HF-BERB-1500",
    " HEAFA-2039-60-FBA",
    "HF-BERB-1500-WFS"
   ],
   "last_used_at": null
  },
  {
   "id": 83,
   "canonical_name": "Berberine 6000mg",
   "aliases": [
    "HF-BERB-6000",
    " HEAFA-2038-150-FBA",
    "HF-BERB-5000-WFS"
   ],
   "last_used_at": null
  },
  {
   "id": 84,
   "canonical_name": "Berberine Ceylon Cinnamon 6000mg",
   "aliases": [
    "HF-BERB-5000",
    "HEAFA-2038-150-FBA",
    "HF-BERB-5000-WFS"
   ],
   "last_used_at": null
  },
  {
   "id": 85,
   "canonical_name": "Berberine Hcl 5000mg",
   "aliases": [
    "HF-HCL-5000",
    "HEAFA-2076-120-FBA",
    "HF-HCL-5000-WFS"
   ],
   "last_used_at": "2026-07-09T19:13:56.114Z"
  },
  {
   "id": 3,
   "canonical_name": "Bilberry",
   "aliases": [
    "bilberry",
    "bilbery",
    "bilberry extract"
   ],
   "last_used_at": "2026-07-24T19:40:58.019Z"
  },
  {
   "id": 86,
   "canonical_name": "Bilberry 5000mg",
   "aliases": [
    "HF-BILB-5000",
    "HEAFA-2024-200-FBA",
    "HF-BILB-5000-WFS"
   ],
   "last_used_at": null
  },
  {
   "id": 24,
   "canonical_name": "Bitter Melon",
   "aliases": [
    "bitter melon",
    "melao amargo",
    "karela",
    "bitter melon extract"
   ],
   "last_used_at": "2026-07-15T17:31:14.950Z"
  },
  {
   "id": 87,
   "canonical_name": "Bitter Melon 9500mg",
   "aliases": [
    "HF-BITT-9500",
    "HEAFA-2021-200-FBA",
    "HF-BITT-9500-WFS"
   ],
   "last_used_at": null
  },
  {
   "id": 88,
   "canonical_name": "Black Garlic 2000mg",
   "aliases": [
    "HF-BLAC-2000",
    "HEAFA-2011-90-FBA",
    "HF-BLAC-2000-WFS"
   ],
   "last_used_at": "2026-07-29T17:24:35.595Z"
  },
  {
   "id": 89,
   "canonical_name": "Black Garlic 2000mg - C2",
   "aliases": [
    "HF-BLAC-2000-C2",
    "HEAFA-2011-90-FBA-C2",
    "HF-BLAC-2000-C2-WFS"
   ],
   "last_used_at": null
  },
  {
   "id": 163,
   "canonical_name": "Bloom",
   "aliases": [
    "HFC-BLOOM-HAIR-GROWTH"
   ],
   "last_used_at": null
  },
  {
   "id": 164,
   "canonical_name": "Burn XLR8 (Fat Burner) Supplement - 30 Capsules",
   "aliases": [
    "HF-BURN"
   ],
   "last_used_at": null
  },
  {
   "id": 25,
   "canonical_name": "Butchers Broom",
   "aliases": [
    "butchers broom",
    "vassoura de acougueiro",
    "ruscus",
    "butcher broom"
   ],
   "last_used_at": null
  },
  {
   "id": 90,
   "canonical_name": "Butcher's Broom 2400mg",
   "aliases": [
    "HF-BUTC-2400",
    "HEAFA-2026-120-FBA",
    "HF-BUTC-2400-WFS"
   ],
   "last_used_at": null
  },
  {
   "id": 26,
   "canonical_name": "Cayenne Pepper",
   "aliases": [
    "cayenne",
    "pimenta caiena",
    "cayenne pepper",
    "capsaicina",
    "capsaicin"
   ],
   "last_used_at": null
  },
  {
   "id": 165,
   "canonical_name": "Cayenne Pepper 45,000 HU - 600mg 200 Capsules",
   "aliases": [
    "HEAFA-2055-200"
   ],
   "last_used_at": null
  },
  {
   "id": 91,
   "canonical_name": "Cayenne Pepper 600mg",
   "aliases": [
    "HF-CAYE-600",
    "HEAFA-2055-200-FBA",
    "HF-CAYE-600-WFS"
   ],
   "last_used_at": null
  },
  {
   "id": 92,
   "canonical_name": "Chinese Skullcap 1000mg",
   "aliases": [
    "HF-SKUL-1000",
    " HEAFA-2025-200-FBA",
    "HF-SKUL-1000-WFS"
   ],
   "last_used_at": null
  },
  {
   "id": 27,
   "canonical_name": "Chlorophyll",
   "aliases": [
    "clorofila",
    "chlorophyll",
    "chlorophyl",
    "clorofill"
   ],
   "last_used_at": "2026-07-27T16:00:45.799Z"
  },
  {
   "id": 93,
   "canonical_name": "Chlorophyll 600mg",
   "aliases": [
    "HF-CHLO-600",
    "HEAFA-2061-150-FBA",
    "HF-CHLO-600-WFS"
   ],
   "last_used_at": null
  },
  {
   "id": 28,
   "canonical_name": "Chromium Picolinate",
   "aliases": [
    "chromium",
    "cromo",
    "picolinato",
    "chromium picolinate",
    "picolinato de cromo"
   ],
   "last_used_at": "2026-07-28T18:47:10.432Z"
  },
  {
   "id": 94,
   "canonical_name": "Chromium Picolinate 1000mcg",
   "aliases": [
    "HF-CHRO-1000",
    "HEAFA-2031-400-FBA",
    "HF-CHRO-1000-WFS"
   ],
   "last_used_at": null
  },
  {
   "id": 95,
   "canonical_name": "Chromium Picolinate 1000mcg - C2",
   "aliases": [
    "HF-CHRO-1000-C2",
    "HEAFA-2031-400-FBA-C2"
   ],
   "last_used_at": null
  },
  {
   "id": 29,
   "canonical_name": "Citrus Bergamot",
   "aliases": [
    "citrus bergamot",
    "citrus",
    "bergamot",
    "bergamota",
    "bergamotto"
   ],
   "last_used_at": null
  },
  {
   "id": 96,
   "canonical_name": "Citrus Bergamot 1200mg",
   "aliases": [
    "HF-BERG-1200",
    "HEAFA-2082-150-FBA",
    "HF-BERG-1200-WFS"
   ],
   "last_used_at": null
  },
  {
   "id": 30,
   "canonical_name": "D-Aspartic Acid",
   "aliases": [
    "d-aspartic",
    "d aspartic",
    "aspartic acid",
    "acido aspartico",
    "daa"
   ],
   "last_used_at": null
  },
  {
   "id": 97,
   "canonical_name": "D-Aspartic Acid 3000mg",
   "aliases": [
    "HF-DASP-3000",
    "HEAFA-2022-200-FBA",
    "HF-DASP-3000-WFS"
   ],
   "last_used_at": null
  },
  {
   "id": 166,
   "canonical_name": "Detox+",
   "aliases": [
    "HFC-DETOX-PLUS"
   ],
   "last_used_at": null
  },
  {
   "id": 31,
   "canonical_name": "Devils Claw",
   "aliases": [
    "devils claw",
    "garra do diabo",
    "harpagophytum",
    "devil claw"
   ],
   "last_used_at": null
  },
  {
   "id": 98,
   "canonical_name": "Devil's Claw 2600mg",
   "aliases": [
    "HF-DEVI-2600",
    "HEAFA-2027-120-FBA",
    "HF-DEVI-2600-WFS"
   ],
   "last_used_at": null
  },
  {
   "id": 167,
   "canonical_name": "Digestive+ Cleanse",
   "aliases": [
    "HFC-DIGESTIVE-PLUS-CLEANSE"
   ],
   "last_used_at": null
  },
  {
   "id": 32,
   "canonical_name": "Fadogia Agrestis",
   "aliases": [
    "fadogia",
    "fadogia agrestis"
   ],
   "last_used_at": null
  },
  {
   "id": 99,
   "canonical_name": "Fadogia Agrestis 600mg",
   "aliases": [
    "HF-FADO-600",
    "HEAFA-2056-200-FBA",
    "HF-FADO-600-WFS"
   ],
   "last_used_at": null
  },
  {
   "id": 33,
   "canonical_name": "Feminiva",
   "aliases": [
    "feminiva"
   ],
   "last_used_at": null
  },
  {
   "id": 100,
   "canonical_name": "Feminiva Boric Acid 600mg",
   "aliases": [
    "HF-FEM-600",
    "HEAFA-1000-FBA",
    "HF-FEM-600-WFS"
   ],
   "last_used_at": null
  },
  {
   "id": 101,
   "canonical_name": "Feminiva Boric Acid 600mg - C2",
   "aliases": [
    "HF-FEM-600-C2",
    "HEAFA-1000-FBA-C2",
    "HF-FEM-600-C2-WFS"
   ],
   "last_used_at": null
  },
  {
   "id": 34,
   "canonical_name": "Fenugreek",
   "aliases": [
    "fenugreco",
    "fenugrek",
    "fenngreff",
    "fenugreek",
    "fenugr",
    "fenugreek seed",
    "methi"
   ],
   "last_used_at": null
  },
  {
   "id": 102,
   "canonical_name": "Fenugreek 6000mg",
   "aliases": [
    "HF-FENU-6000",
    "HEAFA-2052-150-FBA",
    "HF-FENU-6000-WFS"
   ],
   "last_used_at": null
  },
  {
   "id": 35,
   "canonical_name": "Folic Acid",
   "aliases": [
    "acido folico",
    "folic acid",
    "folato",
    "folate",
    "folic"
   ],
   "last_used_at": "2026-07-08T20:15:38.989Z"
  },
  {
   "id": 104,
   "canonical_name": "Folic Acid 1000mcg",
   "aliases": [
    "HF-FOLI-1000",
    "HEAFA-2044-300-FBA",
    "HF-FOLI-1000-WFS"
   ],
   "last_used_at": null
  },
  {
   "id": 105,
   "canonical_name": "Folic Acid 400mcg",
   "aliases": [
    "HF-FOLI-400",
    "HEAFA-2045-300-FBA",
    "HF-FOLI-400-WFS"
   ],
   "last_used_at": null
  },
  {
   "id": 103,
   "canonical_name": "Fo-Ti 1000mg",
   "aliases": [
    "HF-FOTI-1000",
    "HEAFA-2030-200-FBA",
    "HF-FOTI-1000-WFS"
   ],
   "last_used_at": null
  },
  {
   "id": 106,
   "canonical_name": "French Maritime Pine Bark 6000mg",
   "aliases": [
    "HF-PINE-6000",
    "HEAFA-2018-200-FBA",
    "HF-PINE-6000-WFS"
   ],
   "last_used_at": null
  },
  {
   "id": 5,
   "canonical_name": "Ginger Root",
   "aliases": [
    "ginger",
    "gengibre",
    "ginger root",
    "gengibre root"
   ],
   "last_used_at": "2026-07-25T15:15:10.751Z"
  },
  {
   "id": 107,
   "canonical_name": "Ginger Root 4000mg",
   "aliases": [
    "HF-GING-4000",
    "HEAFA-2007-200-FBA",
    "HF-GING-4000-WFS"
   ],
   "last_used_at": null
  },
  {
   "id": 36,
   "canonical_name": "Ginkgo Biloba",
   "aliases": [
    "ginkgo",
    "ginkgo biloba",
    "biloba",
    "ginko"
   ],
   "last_used_at": "2026-07-25T20:22:17.978Z"
  },
  {
   "id": 108,
   "canonical_name": "Ginkgo Biloba 7500mg",
   "aliases": [
    "HF-GINK-7500",
    "HEAFA-2047-200-FBA",
    "HF-GINK-7500-WFS"
   ],
   "last_used_at": null
  },
  {
   "id": 37,
   "canonical_name": "Ginseng Ginkgo",
   "aliases": [
    "ginseng",
    "panax ginseng",
    "ginseng ginkgo",
    "panax ginseng ginkgo",
    "ginseng e ginkgo"
   ],
   "last_used_at": null
  },
  {
   "id": 38,
   "canonical_name": "Glutathione",
   "aliases": [
    "glutationa",
    "glutation",
    "glutathione"
   ],
   "last_used_at": null
  },
  {
   "id": 109,
   "canonical_name": "Glutathione 1000mg",
   "aliases": [
    "HF-GLTH-1000",
    "HEAFA-2046-150-FBA",
    "HF-GLTH-1000-WFS"
   ],
   "last_used_at": null
  },
  {
   "id": 6,
   "canonical_name": "Graviola",
   "aliases": [
    "graviola",
    "soursop",
    "graviolla",
    "graviol",
    "graviola soursop"
   ],
   "last_used_at": null
  },
  {
   "id": 110,
   "canonical_name": "Graviola Soursop 5000mg",
   "aliases": [
    "HF-GRAV-5000",
    "HEAFA-2015-200-FBA",
    "HF-GRAV-5000-WFS"
   ],
   "last_used_at": null
  },
  {
   "id": 111,
   "canonical_name": "Graviola Soursop 5000mg - C2",
   "aliases": [
    "HF-GRAV-5000-C2",
    "HEAFA-2015-200-FBA-C2"
   ],
   "last_used_at": null
  },
  {
   "id": 39,
   "canonical_name": "Green Tea",
   "aliases": [
    "green tea",
    "cha verde",
    "te verde",
    "egcg",
    "green tea extract"
   ],
   "last_used_at": null
  },
  {
   "id": 112,
   "canonical_name": "Green Tea 2100mg",
   "aliases": [
    "HF-GREE-2100",
    "HEAFA-2023-200-FBA",
    "HF-GREE-2100-WFS"
   ],
   "last_used_at": null
  },
  {
   "id": 40,
   "canonical_name": "Gymnema Sylvestre",
   "aliases": [
    "gymnema",
    "gymnema sylvestre",
    "gurmar"
   ],
   "last_used_at": "2026-08-04T15:35:32.091Z"
  },
  {
   "id": 113,
   "canonical_name": "Gymnema Sylvestre 4000mg",
   "aliases": [
    "HF-GYSY-4000",
    "HEAFA-2058-200-FBA",
    "HF-GYNM-4000-WFS"
   ],
   "last_used_at": null
  },
  {
   "id": 114,
   "canonical_name": "Hawthorn 3000mg",
   "aliases": [
    "HF-HAWT-3000",
    "HEAFA-2059-200-FBA",
    "HF-HAWT-3000-WFS"
   ],
   "last_used_at": null
  },
  {
   "id": 41,
   "canonical_name": "Hawthorn Berry",
   "aliases": [
    "hawthorn",
    "hawthorn berry",
    "espinheiro",
    "cratego",
    "crataegus"
   ],
   "last_used_at": null
  },
  {
   "id": 168,
   "canonical_name": "HealthFare Clinic Services (YNL)",
   "aliases": [
    "70"
   ],
   "last_used_at": null
  },
  {
   "id": 42,
   "canonical_name": "He Shou Wu",
   "aliases": [
    "he shou wu",
    "fo-ti",
    "fo ti",
    "heshouwu",
    "poligonum",
    "fallopia multiflora"
   ],
   "last_used_at": null
  },
  {
   "id": 115,
   "canonical_name": "HF-BERB-1500-WFS",
   "aliases": [
    "HF-BERB-1500",
    "HEAFA-2039-60-FBA",
    "HF-BERB-1500-WFS"
   ],
   "last_used_at": null
  },
  {
   "id": 43,
   "canonical_name": "Hyaluronic Acid",
   "aliases": [
    "hyaluronic",
    "hialuronico",
    "acido hialuronico",
    "hyaluronic acid"
   ],
   "last_used_at": "2026-08-04T14:54:23.680Z"
  },
  {
   "id": 116,
   "canonical_name": "Hyaluronic Acid With Vitamin C 250mg",
   "aliases": [
    "HF-HYAL-250",
    "HEAFA-2005-210-FBA",
    "HF-HYAL-250-WFS"
   ],
   "last_used_at": null
  },
  {
   "id": 117,
   "canonical_name": "L-Carnitine 1500mg",
   "aliases": [
    "HF-LCAR-1500",
    "HEAFA-2077-120-FBA",
    "HF-LCAR-1500-WFS"
   ],
   "last_used_at": null
  },
  {
   "id": 44,
   "canonical_name": "L-Glutamine",
   "aliases": [
    "glutamina",
    "l-glutamine",
    "glutamine",
    "l glutamine"
   ],
   "last_used_at": "2026-07-09T12:30:32.193Z"
  },
  {
   "id": 118,
   "canonical_name": "L-Glutamine 1000mg",
   "aliases": [
    "HF-LGLU-1000",
    "HEAFA-2037-200-FBA",
    "HF-LGLU-1000-WFS"
   ],
   "last_used_at": null
  },
  {
   "id": 45,
   "canonical_name": "Licorice Root",
   "aliases": [
    "licorice",
    "alcacuz",
    "licorice root",
    "regaliz",
    "glycyrrhiza"
   ],
   "last_used_at": null
  },
  {
   "id": 119,
   "canonical_name": "Licorice Root 600mg",
   "aliases": [
    "HF-LICO-900",
    "HEAFA-2009-360-FBA",
    "HF-LICO-900-WFS"
   ],
   "last_used_at": null
  },
  {
   "id": 169,
   "canonical_name": "Lipobalance",
   "aliases": [
    "LIPOBALANCE"
   ],
   "last_used_at": null
  },
  {
   "id": 46,
   "canonical_name": "Lithium Orotate",
   "aliases": [
    "lithium",
    "litio",
    "litium",
    "orotato de litio",
    "lithium orotate",
    "litio orotato"
   ],
   "last_used_at": null
  },
  {
   "id": 120,
   "canonical_name": "Lithium Orotate 130mg 200tabs",
   "aliases": [
    "HF-LITH-130",
    "HEAFA-2001-200-FBA",
    "HF-LITH-130-WFS"
   ],
   "last_used_at": "2026-07-28T18:47:08.835Z"
  },
  {
   "id": 121,
   "canonical_name": "Lithium Orotate 5mg",
   "aliases": [
    "HF-LITH-5",
    "HEAFA-2079-200-FBA",
    "HF-MELA-5-WFS"
   ],
   "last_used_at": null
  },
  {
   "id": 177,
   "canonical_name": "L-Theanine 400mg 150caps",
   "aliases": [
    "HF-LTHE-400",
    "HF-LTHE-400-WFS"
   ],
   "last_used_at": "2026-07-17T14:58:29.182Z"
  },
  {
   "id": 47,
   "canonical_name": "Magnesium",
   "aliases": [
    "magnesio",
    "magnesium",
    "mag"
   ],
   "last_used_at": null
  },
  {
   "id": 48,
   "canonical_name": "Magnesium Citrate",
   "aliases": [
    "magnesium citrate",
    "citrato de magnesio",
    "mag citrate",
    "citrate",
    "citrato"
   ],
   "last_used_at": "2026-07-28T16:09:34.326Z"
  },
  {
   "id": 122,
   "canonical_name": "Magnesium Citrate 500mg",
   "aliases": [
    "HF-MCIT-500",
    "HEAFA-2060-90-FBA",
    "HF-MCIT-500-WFS"
   ],
   "last_used_at": null
  },
  {
   "id": 8,
   "canonical_name": "Magnesium Glycinate",
   "aliases": [
    "magnesium glycinate",
    "glicinato",
    "glycinate",
    "mag glycinate",
    "glycinote",
    "glicinate",
    "bisglicinato",
    "bisglycinate"
   ],
   "last_used_at": "2026-07-28T13:11:58.629Z"
  },
  {
   "id": 123,
   "canonical_name": "Magnesium Glycinate 500mg",
   "aliases": [
    "HF-GLYC-500",
    "HEAFA-2062-240-FBA",
    "HF-GLYC-500-WFS"
   ],
   "last_used_at": null
  },
  {
   "id": 124,
   "canonical_name": "Magnesium Oxide 500mg",
   "aliases": [
    "HF-OXID-500",
    "HEAFA-2069-250-FBA",
    "HF-OXID-500-WFS"
   ],
   "last_used_at": "2026-07-21T20:16:20.648Z"
  },
  {
   "id": 49,
   "canonical_name": "Melatonin",
   "aliases": [
    "melatonina",
    "melatonin"
   ],
   "last_used_at": "2026-07-29T12:36:17.427Z"
  },
  {
   "id": 125,
   "canonical_name": "Melatonin Berry Flavor 10mg",
   "aliases": [
    "HF-MELA-10",
    "HEAFA-2078-300-FBA",
    "HF-MELA-CH-10-WFS"
   ],
   "last_used_at": null
  },
  {
   "id": 126,
   "canonical_name": "Melatonin Berry Flavor 5mg - Amazon",
   "aliases": [
    "HF-MELA-5",
    "HEAFA-2080-300-FBA"
   ],
   "last_used_at": null
  },
  {
   "id": 178,
   "canonical_name": "Melatonin Berry Flavor 5mg - Older",
   "aliases": [
    "HF-MELA-5",
    "HF-MELA-CH-5-WFS"
   ],
   "last_used_at": null
  },
  {
   "id": 170,
   "canonical_name": "Melatonin Berry Flavor 5mg - Wallmart",
   "aliases": [
    "HF-MELA-5",
    "HF-MELA-CH-5-WFS"
   ],
   "last_used_at": null
  },
  {
   "id": 127,
   "canonical_name": "Melatonin Complex 20mg",
   "aliases": [
    "HF-MELA-20",
    "HEAFA-2033-120-FBA",
    "HF-MELA-20-WFS"
   ],
   "last_used_at": null
  },
  {
   "id": 128,
   "canonical_name": "Melatonin Fast Absorption 60mg",
   "aliases": [
    "HF-MELA-60",
    "HEAFA-2034-90-FBA",
    "HF-MELA-60-WFS"
   ],
   "last_used_at": "2026-07-27T19:44:02.302Z"
  },
  {
   "id": 129,
   "canonical_name": "Melatonin Fast Absorption 60mg - C2",
   "aliases": [
    "HF-MELA-60-C2",
    "HEAFA-2034-90-FBA-C2"
   ],
   "last_used_at": null
  },
  {
   "id": 50,
   "canonical_name": "Mullein Leaf",
   "aliases": [
    "mullein",
    "mulein",
    "verbasco",
    "mullein leaf",
    "mullein extract"
   ],
   "last_used_at": "2026-07-23T19:55:18.836Z"
  },
  {
   "id": 130,
   "canonical_name": "Mullein Leaf 3000mg",
   "aliases": [
    "HF-MULL-3000",
    "HEAFA-2028-200-FBA",
    "HF-MULL-3000-WFS"
   ],
   "last_used_at": null
  },
  {
   "id": 51,
   "canonical_name": "Multi Collagen",
   "aliases": [
    "colageno",
    "collagen",
    "collagen peptides",
    "multi collagen",
    "collag"
   ],
   "last_used_at": null
  },
  {
   "id": 131,
   "canonical_name": "Multi Collagen 1600mg",
   "aliases": [
    "HF-COLL-1600",
    "HEAFA-2050-90-FBA",
    "HF-COLL-1600-WFS"
   ],
   "last_used_at": null
  },
  {
   "id": 171,
   "canonical_name": "Multi Collagen Peptides - 90 Capsules",
   "aliases": [
    "HEAFA-2050-90"
   ],
   "last_used_at": null
  },
  {
   "id": 132,
   "canonical_name": "Multi Collagen Protein",
   "aliases": [
    "HF-MCOL-2000",
    "HEAFA-2083-180-FBA",
    "HF-MCOL-2000-WFS"
   ],
   "last_used_at": null
  },
  {
   "id": 10,
   "canonical_name": "Myo Inositol",
   "aliases": [
    "inositol",
    "myo-inositol",
    "mioinositol",
    "myo inositol"
   ],
   "last_used_at": null
  },
  {
   "id": 133,
   "canonical_name": "Myo Inositol 2600mg",
   "aliases": [
    "HF-MYOI-2000",
    "HEAFA-2017-200-FBA",
    "HF-MYOI-2600-WFS"
   ],
   "last_used_at": null
  },
  {
   "id": 52,
   "canonical_name": "NAC",
   "aliases": [
    "nac",
    "n-acetyl",
    "n acetyl",
    "n-acetil",
    "acetil cisteina",
    "cysteine",
    "n-acetylcysteine",
    "acetyl cysteine"
   ],
   "last_used_at": "2026-07-31T15:56:22.135Z"
  },
  {
   "id": 134,
   "canonical_name": "Nac 1000mg",
   "aliases": [
    "HF-NAC-1000",
    "HEAFA-2075-240-FBA",
    "HF-NAC-1000-WFS"
   ],
   "last_used_at": null
  },
  {
   "id": 135,
   "canonical_name": "Nac 1300mg",
   "aliases": [
    "HF-NAC-1300",
    "HEAFA-2036-240-FBA",
    "HF-NAC-1300-WFS"
   ],
   "last_used_at": null
  },
  {
   "id": 136,
   "canonical_name": "Nac 600mg",
   "aliases": [
    "HF-NAC-600",
    "HEAFA-2074-200-FBA",
    "HF-NAC-600-WFS"
   ],
   "last_used_at": null
  },
  {
   "id": 53,
   "canonical_name": "NAD",
   "aliases": [
    "nad",
    "nad+",
    "nmn",
    "nicotinamide",
    "nad supplement"
   ],
   "last_used_at": null
  },
  {
   "id": 172,
   "canonical_name": "NAD+ Celluvance",
   "aliases": [
    "HFC-NAD-CELLUVANCE"
   ],
   "last_used_at": "2026-07-31T20:41:23.721Z"
  },
  {
   "id": 137,
   "canonical_name": "Nad+ Celluvance 10,573mg 120 Caps",
   "aliases": [
    "HF-CELL-10573",
    "HEAFA-2070-120-FBA",
    "HF-CELL-10573-WFS"
   ],
   "last_used_at": null
  },
  {
   "id": 139,
   "canonical_name": "Naturwell Libidor",
   "aliases": [
    "NATURWELL-LIBIDOR",
    " NATUR-3005-FBA"
   ],
   "last_used_at": null
  },
  {
   "id": 140,
   "canonical_name": "Naturwell Mushrooms",
   "aliases": [
    "NATURWELL-MUSHROOMS",
    "NATUR-3020-FBA"
   ],
   "last_used_at": null
  },
  {
   "id": 138,
   "canonical_name": "Naturwel (Rosa) Elixir",
   "aliases": [
    "NATURWEL-ROSA-ELIXIR",
    "NATUR-3015-FBA"
   ],
   "last_used_at": null
  },
  {
   "id": 173,
   "canonical_name": "NeuroCalm",
   "aliases": [
    "NEUROCALM"
   ],
   "last_used_at": null
  },
  {
   "id": 11,
   "canonical_name": "Panax",
   "aliases": [
    "panax ginseng",
    "panax",
    "pana",
    "ginsen",
    "ginseng",
    "panas"
   ],
   "last_used_at": null
  },
  {
   "id": 141,
   "canonical_name": "Panax Ginseng & Ginkgo Biloba 7500mg",
   "aliases": [
    "HF-GSEG-7500",
    "HEAFA-2051-150-FBA",
    "HF-GSEG-7500-WFS"
   ],
   "last_used_at": null
  },
  {
   "id": 54,
   "canonical_name": "Pantothenic Acid",
   "aliases": [
    "pantotenico",
    "pantotenic",
    "pantothenic",
    "b5",
    "vit b5",
    "vitamina b5",
    "acido pantotenico"
   ],
   "last_used_at": null
  },
  {
   "id": 142,
   "canonical_name": "Pantothenic Acid 500mg",
   "aliases": [
    "HF-PTHO-500",
    "HEAFA-2003-200-FBA",
    "HF-PANT-500-WFS"
   ],
   "last_used_at": null
  },
  {
   "id": 174,
   "canonical_name": "Pantothenic Acid (Vitamin B5) - 500mg 200 Capsules",
   "aliases": [
    "HF-PANT-500"
   ],
   "last_used_at": null
  },
  {
   "id": 55,
   "canonical_name": "Pine Bark",
   "aliases": [
    "pine bark",
    "french maritime",
    "casca de pinho",
    "pycnogenol",
    "pine bark extract"
   ],
   "last_used_at": null
  },
  {
   "id": 56,
   "canonical_name": "Plant Sterols",
   "aliases": [
    "plant sterols",
    "plant sterol",
    "sterols",
    "esterois",
    "fitosterois",
    "phytosterols",
    "plant"
   ],
   "last_used_at": "2026-08-06T20:01:26.463Z"
  },
  {
   "id": 143,
   "canonical_name": "Plant Sterols 2000mg",
   "aliases": [
    "HF-PLAN-2000",
    "HEAFA-2020-240-FBA",
    "HF-PLAN-2000-WFS"
   ],
   "last_used_at": null
  },
  {
   "id": 57,
   "canonical_name": "Potassium Iodide",
   "aliases": [
    "potassium iodide",
    "potassium",
    "potassio",
    "iodide",
    "iodeto",
    "iodo de potassio",
    "potassium iodide 130"
   ],
   "last_used_at": null
  },
  {
   "id": 144,
   "canonical_name": "Potassium Iodide 130mg - C2",
   "aliases": [
    "HF-POTA-130-C2",
    "HEAFA-2000-130-60-2-FBA",
    "HF-POTA-130-C2-WFS"
   ],
   "last_used_at": null
  },
  {
   "id": 145,
   "canonical_name": "Potassium Iodide 130mg - C6",
   "aliases": [
    "HF-POTA-130-C6",
    "HEAFA-2000-130-60-6-FBA",
    "HF-POTA-130-C6-WFS"
   ],
   "last_used_at": null
  },
  {
   "id": 58,
   "canonical_name": "Psyllium Husk",
   "aliases": [
    "psyllium",
    "psyllium husk",
    "casca de psyllium",
    "psilio",
    "ispagula"
   ],
   "last_used_at": "2026-07-27T13:46:01.018Z"
  },
  {
   "id": 146,
   "canonical_name": "Psyllium Husk 1500mg",
   "aliases": [
    "HF-PSYL-1500",
    "HEAFA-2054-240-FBA",
    "HF-PSYL-1500-WFS"
   ],
   "last_used_at": null
  },
  {
   "id": 59,
   "canonical_name": "Pygeum",
   "aliases": [
    "pygeum",
    "pigeum",
    "pygenum",
    "pygeum africanum"
   ],
   "last_used_at": null
  },
  {
   "id": 147,
   "canonical_name": "Pygeum 4500mg",
   "aliases": [
    "HF-PYGE-4500",
    "HEAFA-2012-240-FBA",
    "HF-PYGE-4500-WFS"
   ],
   "last_used_at": null
  },
  {
   "id": 13,
   "canonical_name": "Rhodiola",
   "aliases": [
    "rhodiola",
    "rodiola",
    "rhodiola rosea"
   ],
   "last_used_at": null
  },
  {
   "id": 148,
   "canonical_name": "Rhodiola Rosea 1000mg",
   "aliases": [
    "HF-RHOD-1000",
    "HEAFA-2063-90-FBA",
    "HF-RHOD-1000-WFS"
   ],
   "last_used_at": null
  },
  {
   "id": 14,
   "canonical_name": "Rutin",
   "aliases": [
    "rutin",
    "rutim",
    "rutina"
   ],
   "last_used_at": "2026-07-08T15:05:03.172Z"
  },
  {
   "id": 149,
   "canonical_name": "Rutin 500mg",
   "aliases": [
    "HF-RUTI-500",
    "HEAFA-2049-200-FBA",
    "HF-RUTI-500-WFS"
   ],
   "last_used_at": null
  },
  {
   "id": 60,
   "canonical_name": "Saw Palmetto",
   "aliases": [
    "saw palmetto",
    "palmeto",
    "sabal serrulata"
   ],
   "last_used_at": "2026-07-23T18:08:54.835Z"
  },
  {
   "id": 150,
   "canonical_name": "Saw Palmetto 4000mg",
   "aliases": [
    "HF-SAWP-4000",
    "HEAFA-2035-150-FBA",
    "HF-SAWP-4000-WFS"
   ],
   "last_used_at": null
  },
  {
   "id": 61,
   "canonical_name": "Skullcap",
   "aliases": [
    "skullcap",
    "skull cap",
    "escutelaria",
    "chinese skullcap"
   ],
   "last_used_at": null
  },
  {
   "id": 62,
   "canonical_name": "Stinging Nettle",
   "aliases": [
    "nettle",
    "urtiga",
    "stinging nettle",
    "nettle leaf",
    "nettle root",
    "stinging nettle root",
    "stinging nettle leaf"
   ],
   "last_used_at": null
  },
  {
   "id": 151,
   "canonical_name": "Stinging Nettle 7500mg",
   "aliases": [
    "HF-STIN-7500-R",
    "HEAFA-2071-200-FBA",
    "HF-STING-7500-WFS"
   ],
   "last_used_at": null
  },
  {
   "id": 63,
   "canonical_name": "Tribulus Terrestris",
   "aliases": [
    "tribulus",
    "tribulo",
    "tribulus terrestris",
    "trib"
   ],
   "last_used_at": "2026-07-28T16:48:59.258Z"
  },
  {
   "id": 152,
   "canonical_name": "Tribulus Terrestris 32,500mg",
   "aliases": [
    "HF-TRIB-32500",
    "HEAFA-2042-200-FBA",
    "HF-TRIB-32500-WFS"
   ],
   "last_used_at": null
  },
  {
   "id": 64,
   "canonical_name": "Turkesterone",
   "aliases": [
    "turkesterone",
    "tongkat ali",
    "turk",
    "turkersterone",
    "eurycoma"
   ],
   "last_used_at": null
  },
  {
   "id": 153,
   "canonical_name": "Turkesterone With Tongkat Ali 110,000mg",
   "aliases": [
    "HF-TURK-110000",
    "HEAFA-2065-150-FBA",
    "HF-TURK-110000-WFS"
   ],
   "last_used_at": null
  },
  {
   "id": 70,
   "canonical_name": "Urolithin A",
   "aliases": [
    "HF-UROL-1000",
    "urolithin",
    "urolithin a"
   ],
   "last_used_at": "2026-08-06T18:47:25.480Z"
  },
  {
   "id": 65,
   "canonical_name": "Valerian Root",
   "aliases": [
    "valerian",
    "valeriana",
    "valerian root"
   ],
   "last_used_at": "2026-07-15T15:26:06.943Z"
  },
  {
   "id": 154,
   "canonical_name": "Valerian Root 3000mg",
   "aliases": [
    "HF-VALE-3000",
    "HEAFA-2004-240-FBA",
    "HF-VALE-3000-WFS"
   ],
   "last_used_at": null
  },
  {
   "id": 66,
   "canonical_name": "Vitamin B1",
   "aliases": [
    "vitamina b1",
    "thiamine",
    "tiamina",
    "vit b1",
    "b1",
    "vitamin b1"
   ],
   "last_used_at": "2026-07-30T19:13:07.583Z"
  },
  {
   "id": 155,
   "canonical_name": "Vitamin B1 100mg",
   "aliases": [
    "HF-VTB1-100-WFS",
    "HEAFA-2040-60-FBA",
    "HF-VIB1-100-WFS"
   ],
   "last_used_at": null
  },
  {
   "id": 175,
   "canonical_name": "Vitamin B12 (Methylcobalamin)",
   "aliases": [
    "HF-VB12-5000 ",
    "HF-VB12-5000-WFS "
   ],
   "last_used_at": "2026-07-30T19:11:04.719Z"
  },
  {
   "id": 156,
   "canonical_name": "Vitamin B1 500mg",
   "aliases": [
    "HF-VTB1-500",
    "HEAFA-2041-200-FBA",
    "HF-VTB2-180-WFS"
   ],
   "last_used_at": null
  },
  {
   "id": 67,
   "canonical_name": "Vitamin B2",
   "aliases": [
    "vitamina b2",
    "riboflavin",
    "riboflavina",
    "vit b2",
    "b2",
    "vitamin b2",
    "vita b2",
    "vitab2"
   ],
   "last_used_at": "2026-07-28T18:38:12.504Z"
  },
  {
   "id": 157,
   "canonical_name": "Vitamin B2 400mg",
   "aliases": [
    "HF-VTB2-400",
    "HEAFA-2008-180-FBA",
    "HF-VTB2-180-WFS"
   ],
   "last_used_at": null
  },
  {
   "id": 158,
   "canonical_name": "Vitamin B2 400mg - C2",
   "aliases": [
    "HF-VTB2-400-C2",
    "HEAFA-2008-180-FBA-C2",
    "HF-VTB2-180-C2-WFS"
   ],
   "last_used_at": null
  },
  {
   "id": 68,
   "canonical_name": "White Kidney Bean",
   "aliases": [
    "white kidney bean",
    "kidney bean",
    "feijao branco",
    "kidney",
    "white kidney"
   ],
   "last_used_at": "2026-08-03T14:57:26.886Z"
  },
  {
   "id": 159,
   "canonical_name": "White Kidney Bean 7500mg",
   "aliases": [
    "HF-WHIT-7500",
    "HEAFA-2006-240-FBA",
    "HF-WHIT-7500-WFS"
   ],
   "last_used_at": null
  },
  {
   "id": 176,
   "canonical_name": "XLR8 Burn",
   "aliases": [
    "HFC-XLR8-BURN"
   ],
   "last_used_at": null
  },
  {
   "id": 69,
   "canonical_name": "Yohimbine",
   "aliases": [
    "yohimbina",
    "yohimbine",
    "yohimbine hcl",
    "yoimbina",
    "iombina"
   ],
   "last_used_at": null
  },
  {
   "id": 160,
   "canonical_name": "Yohimbine 10mg",
   "aliases": [
    "HF-YOHI-10",
    "HEAFA-2032-240-FBA",
    "HF-YOHI-10-WFS"
   ],
   "last_used_at": "2026-07-08T22:07:37.892Z"
  },
  {
   "id": 161,
   "canonical_name": "Yohimbine 5mg",
   "aliases": [
    "HF-YOHI-5",
    "HEAFA-2081-240-FBA",
    "HF-YOHI-5-WFS"
   ],
   "last_used_at": null
  }
 ],
 "recent_batches": [
  {
   "batch_number": "BR-2026-0320",
   "product_id": 80,
   "last_used": "2026-08-06T21:53:21.838Z"
  },
  {
   "batch_number": "BR-2026-0318",
   "product_id": 2,
   "last_used": "2026-08-06T20:47:24.273Z"
  },
  {
   "batch_number": "BR-2026-0306",
   "product_id": 56,
   "last_used": "2026-08-06T20:01:26.463Z"
  },
  {
   "batch_number": "BR-2026-0308",
   "product_id": 56,
   "last_used": "2026-08-06T19:21:15.183Z"
  },
  {
   "batch_number": "BR-2026-0316",
   "product_id": 70,
   "last_used": "2026-08-06T18:47:25.480Z"
  },
  {
   "batch_number": "BR-2026-0315",
   "product_id": 70,
   "last_used": "2026-08-06T14:57:07.250Z"
  },
  {
   "batch_number": "BR-2026-0319",
   "product_id": 80,
   "last_used": "2026-08-06T12:24:21.816Z"
  },
  {
   "batch_number": "BR-2026-0314",
   "product_id": 70,
   "last_used": "2026-08-05T19:15:01.073Z"
  },
  {
   "batch_number": "BR-2026-0303",
   "product_id": 20,
   "last_used": "2026-08-04T20:34:12.424Z"
  },
  {
   "batch_number": "BR-2026-0307",
   "product_id": 56,
   "last_used": "2026-08-04T19:13:58.655Z"
  },
  {
   "batch_number": "BR-2026-0212",
   "product_id": 2,
   "last_used": "2026-08-04T17:05:05.196Z"
  },
  {
   "batch_number": "BR-2026-0267",
   "product_id": 40,
   "last_used": "2026-08-04T15:35:32.091Z"
  },
  {
   "batch_number": "BR-2026-0304",
   "product_id": 56,
   "last_used": "2026-08-04T15:24:03.092Z"
  },
  {
   "batch_number": "BR-2026-0187",
   "product_id": 43,
   "last_used": "2026-08-04T14:54:23.680Z"
  },
  {
   "batch_number": "BR-2026-0302",
   "product_id": 20,
   "last_used": "2026-08-04T14:33:57.961Z"
  },
  {
   "batch_number": "BR-2026-0305",
   "product_id": 56,
   "last_used": "2026-08-03T19:05:41.907Z"
  },
  {
   "batch_number": "BR-2026-0301",
   "product_id": 20,
   "last_used": "2026-08-03T15:11:29.155Z"
  },
  {
   "batch_number": "BR-2026-0289",
   "product_id": 68,
   "last_used": "2026-08-03T14:57:26.886Z"
  },
  {
   "batch_number": "BR-2026-0313",
   "product_id": 70,
   "last_used": "2026-08-01T16:13:01.018Z"
  },
  {
   "batch_number": "BR-2026-0317",
   "product_id": 172,
   "last_used": "2026-07-31T20:41:23.721Z"
  },
  {
   "batch_number": "BR-2026-0309",
   "product_id": 52,
   "last_used": "2026-07-31T15:56:22.135Z"
  },
  {
   "batch_number": "BR-2026-0148",
   "product_id": 66,
   "last_used": "2026-07-30T19:13:07.583Z"
  },
  {
   "batch_number": "BR-2026-0295",
   "product_id": 175,
   "last_used": "2026-07-30T19:11:04.719Z"
  },
  {
   "batch_number": "BR-2026-0270",
   "product_id": 23,
   "last_used": "2026-07-29T21:08:01.988Z"
  },
  {
   "batch_number": "BR-2026-0296",
   "product_id": 88,
   "last_used": "2026-07-29T17:24:35.595Z"
  },
  {
   "batch_number": "BR-2026-0224",
   "product_id": 17,
   "last_used": "2026-07-29T14:01:33.328Z"
  },
  {
   "batch_number": "BR-2026-0293",
   "product_id": 49,
   "last_used": "2026-07-29T12:36:17.427Z"
  },
  {
   "batch_number": "BR-2026-0294",
   "product_id": 49,
   "last_used": "2026-07-28T21:22:33.960Z"
  },
  {
   "batch_number": "BR-2026-0292",
   "product_id": 28,
   "last_used": "2026-07-28T18:47:10.432Z"
  },
  {
   "batch_number": "BR-2026-0311",
   "product_id": 120,
   "last_used": "2026-07-28T18:47:08.835Z"
  },
  {
   "batch_number": "0211",
   "product_id": 67,
   "last_used": "2026-07-28T18:38:12.504Z"
  },
  {
   "batch_number": "BR-2026-0145",
   "product_id": 63,
   "last_used": "2026-07-28T16:48:59.258Z"
  },
  {
   "batch_number": "BR-2026-0310",
   "product_id": 48,
   "last_used": "2026-07-28T16:09:34.326Z"
  },
  {
   "batch_number": "BR-2026-0254",
   "product_id": 8,
   "last_used": "2026-07-28T13:11:58.629Z"
  },
  {
   "batch_number": "BR-2026-0266",
   "product_id": 128,
   "last_used": "2026-07-27T19:44:02.302Z"
  },
  {
   "batch_number": "BR-2026-0225",
   "product_id": 27,
   "last_used": "2026-07-27T16:00:45.799Z"
  },
  {
   "batch_number": "BR-2026-0287",
   "product_id": 58,
   "last_used": "2026-07-27T13:46:01.018Z"
  },
  {
   "batch_number": "BR-2026-0268",
   "product_id": 36,
   "last_used": "2026-07-25T20:22:17.978Z"
  },
  {
   "batch_number": "BR-2026-0290",
   "product_id": 5,
   "last_used": "2026-07-25T15:15:10.751Z"
  },
  {
   "batch_number": "BR-2026-0286",
   "product_id": 3,
   "last_used": "2026-07-24T19:40:58.019Z"
  }
 ]
};
