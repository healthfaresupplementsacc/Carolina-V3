window.HF_DATA = {
 "generated_at": "2026-06-18T02:58:51.362Z",
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
     "orders_required": false
    },
    {
     "slug": "review",
     "label": "Revisão",
     "requires_product": true,
     "note_required": false,
     "orders_required": false
    },
    {
     "slug": "counting",
     "label": "Contagem",
     "requires_product": true,
     "note_required": false,
     "orders_required": false
    },
    {
     "slug": "line_changeover",
     "label": "Troca de linha",
     "requires_product": false,
     "note_required": false,
     "orders_required": false
    },
    {
     "slug": "production_line_other",
     "label": "✏️ Outro (Linha)",
     "requires_product": false,
     "note_required": true,
     "orders_required": false
    }
   ]
  },
  {
   "key": "formulacao",
   "icon": "🧪",
   "label": "Formulação",
   "types": [
    {
     "slug": "formulation",
     "label": "Formulação",
     "requires_product": true,
     "note_required": false,
     "orders_required": false
    },
    {
     "slug": "mixing",
     "label": "Mistura",
     "requires_product": true,
     "note_required": false,
     "orders_required": false
    },
    {
     "slug": "encapsulation",
     "label": "Cápsulas / Tablets",
     "requires_product": true,
     "note_required": false,
     "orders_required": false
    },
    {
     "slug": "material_handling",
     "label": "Preparo de material (peneira…)",
     "requires_product": false,
     "note_required": false,
     "orders_required": false
    },
    {
     "slug": "formulation_other",
     "label": "✏️ Outro (Formulação)",
     "requires_product": false,
     "note_required": true,
     "orders_required": false
    }
   ]
  },
  {
   "key": "limpeza",
   "icon": "🧹",
   "label": "Limpeza / Suporte",
   "types": [
    {
     "slug": "cleaning",
     "label": "Limpeza",
     "requires_product": false,
     "note_required": false,
     "orders_required": false
    },
    {
     "slug": "repair",
     "label": "Conserto de máquina",
     "requires_product": false,
     "note_required": false,
     "orders_required": false
    },
    {
     "slug": "facility_maintenance",
     "label": "Manutenção",
     "requires_product": false,
     "note_required": false,
     "orders_required": false
    },
    {
     "slug": "organization",
     "label": "Organização",
     "requires_product": false,
     "note_required": false,
     "orders_required": false
    },
    {
     "slug": "machine_downtime",
     "label": "Máquina parada",
     "requires_product": false,
     "note_required": true,
     "orders_required": false
    },
    {
     "slug": "label_change",
     "label": "🏷️ Troca de label",
     "requires_product": false,
     "note_required": true,
     "orders_required": false
    },
    {
     "slug": "label_repair",
     "label": "🔧 Conserto de label",
     "requires_product": false,
     "note_required": true,
     "orders_required": false
    },
    {
     "slug": "cleaning_other",
     "label": "✏️ Outro (Limpeza/Suporte)",
     "requires_product": false,
     "note_required": true,
     "orders_required": false
    }
   ]
  },
  {
   "key": "embalagem",
   "icon": "📦",
   "label": "Embalagem",
   "types": [
    {
     "slug": "orders",
     "label": "Ordens",
     "requires_product": false,
     "note_required": false,
     "orders_required": false
    },
    {
     "slug": "order_printing",
     "label": "Impressão de ordens",
     "requires_product": false,
     "note_required": true,
     "orders_required": true
    },
    {
     "slug": "order_printing_2",
     "label": "2ª impressão",
     "requires_product": false,
     "note_required": true,
     "orders_required": true
    },
    {
     "slug": "labeling",
     "label": "Colar labels",
     "requires_product": false,
     "note_required": false,
     "orders_required": false
    },
    {
     "slug": "packaging",
     "label": "Embalagem",
     "requires_product": false,
     "note_required": false,
     "orders_required": false
    },
    {
     "slug": "marketplace_prep",
     "label": "Trocar label / marketplace",
     "requires_product": false,
     "note_required": false,
     "orders_required": false
    },
    {
     "slug": "packaging_other",
     "label": "✏️ Outro (Embalagem)",
     "requires_product": false,
     "note_required": true,
     "orders_required": false
    }
   ]
  },
  {
   "key": "envio",
   "icon": "🚚",
   "label": "Envio",
   "types": [
    {
     "slug": "shipping_walmart",
     "label": "Envio Walmart",
     "requires_product": false,
     "note_required": false,
     "orders_required": false
    },
    {
     "slug": "shipping_amazon",
     "label": "Envio Amazon",
     "requires_product": false,
     "note_required": false,
     "orders_required": false
    },
    {
     "slug": "dc_shipment",
     "label": "Envio DC",
     "requires_product": false,
     "note_required": false,
     "orders_required": false
    },
    {
     "slug": "clinic_shipment",
     "label": "Envio Clínica",
     "requires_product": false,
     "note_required": false,
     "orders_required": false
    },
    {
     "slug": "box_closing",
     "label": "Fechar caixas",
     "requires_product": false,
     "note_required": false,
     "orders_required": false
    },
    {
     "slug": "shipping_other",
     "label": "✏️ Outro (Envio)",
     "requires_product": false,
     "note_required": true,
     "orders_required": false
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
     "orders_required": false
    },
    {
     "slug": "break",
     "label": "Pausa",
     "requires_product": false,
     "note_required": true,
     "orders_required": false
    },
    {
     "slug": "meeting",
     "label": "Reunião",
     "requires_product": false,
     "note_required": true,
     "orders_required": false
    },
    {
     "slug": "training",
     "label": "Treinamento",
     "requires_product": false,
     "note_required": true,
     "orders_required": false
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
   "last_used_at": "2026-05-26T19:00:44.042Z"
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
   "last_used_at": "2026-06-15T20:14:53.147Z"
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
   "last_used_at": "2026-05-27T18:28:31.200Z"
  },
  {
   "id": 18,
   "canonical_name": "Akkermansia",
   "aliases": [
    "akkermansia",
    "akkermansia muciniphila",
    "akkemansia"
   ],
   "last_used_at": "2026-06-17T16:25:40.933Z"
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
   "last_used_at": "2026-06-05T20:09:47.917Z"
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
   "id": 2,
   "canonical_name": "Benfotiamine",
   "aliases": [
    "benfotiamina",
    "benfo",
    "benfotiamine"
   ],
   "last_used_at": "2026-06-16T17:21:26.119Z"
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
   "last_used_at": "2026-06-10T15:08:56.201Z"
  },
  {
   "id": 3,
   "canonical_name": "Bilberry",
   "aliases": [
    "bilberry",
    "bilbery",
    "bilberry extract"
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
   "id": 26,
   "canonical_name": "Cayenne Pepper",
   "aliases": [
    "cayenne",
    "pimenta caiena",
    "cayenne pepper",
    "capsaicina",
    "capsaicin"
   ],
   "last_used_at": "2026-06-12T20:06:34.136Z"
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
   "last_used_at": "2026-06-17T18:34:56.976Z"
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
   "id": 31,
   "canonical_name": "Devils Claw",
   "aliases": [
    "devils claw",
    "garra do diabo",
    "harpagophytum",
    "devil claw"
   ],
   "last_used_at": "2026-06-17T22:11:20.696Z"
  },
  {
   "id": 32,
   "canonical_name": "Fadogia Agrestis",
   "aliases": [
    "fadogia",
    "fadogia agrestis"
   ],
   "last_used_at": "2026-06-16T14:09:03.804Z"
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
   "id": 35,
   "canonical_name": "Folic Acid",
   "aliases": [
    "acido folico",
    "folic acid",
    "folato",
    "folate",
    "folic"
   ],
   "last_used_at": "2026-06-17T19:43:53.769Z"
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
   "last_used_at": "2026-06-12T13:56:49.086Z"
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
   "id": 6,
   "canonical_name": "Graviola",
   "aliases": [
    "graviola",
    "soursop",
    "graviolla",
    "graviol",
    "graviola soursop"
   ],
   "last_used_at": "2026-05-26T18:25:34.961Z"
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
   "id": 40,
   "canonical_name": "Gymnema Sylvestre",
   "aliases": [
    "gymnema",
    "gymnema sylvestre",
    "gurmar"
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
   "id": 43,
   "canonical_name": "Hyaluronic Acid",
   "aliases": [
    "hyaluronic",
    "hialuronico",
    "acido hialuronico",
    "hyaluronic acid"
   ],
   "last_used_at": "2026-06-05T16:39:52.881Z"
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
   "last_used_at": "2026-05-21T20:44:37.529Z"
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
   "last_used_at": "2026-05-28T13:49:59.926Z"
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
   "last_used_at": "2026-06-17T19:24:13.163Z"
  },
  {
   "id": 49,
   "canonical_name": "Melatonin",
   "aliases": [
    "melatonina",
    "melatonin"
   ],
   "last_used_at": "2026-06-17T15:31:15.038Z"
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
   "last_used_at": "2026-06-17T19:27:22.092Z"
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
   "last_used_at": "2026-05-30T00:00:23.974Z"
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
   "last_used_at": "2026-06-16T19:44:03.029Z"
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
   "id": 13,
   "canonical_name": "Rhodiola",
   "aliases": [
    "rhodiola",
    "rodiola",
    "rhodiola rosea"
   ],
   "last_used_at": "2026-05-28T15:37:40.592Z"
  },
  {
   "id": 14,
   "canonical_name": "Rutin",
   "aliases": [
    "rutin",
    "rutim",
    "rutina"
   ],
   "last_used_at": "2026-06-04T19:01:07.290Z"
  },
  {
   "id": 60,
   "canonical_name": "Saw Palmetto",
   "aliases": [
    "saw palmetto",
    "palmeto",
    "sabal serrulata"
   ],
   "last_used_at": "2026-06-09T17:44:44.266Z"
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
   "last_used_at": "2026-05-22T14:36:19.250Z"
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
   "last_used_at": "2026-05-22T18:11:52.195Z"
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
   "id": 65,
   "canonical_name": "Valerian Root",
   "aliases": [
    "valerian",
    "valeriana",
    "valerian root"
   ],
   "last_used_at": "2026-06-09T19:01:55.868Z"
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
   "last_used_at": "2026-05-25T12:25:05.685Z"
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
   "last_used_at": "2026-06-18T00:08:43.288Z"
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
   "last_used_at": "2026-06-11T19:31:17.155Z"
  }
 ],
 "recent_batches": [
  {
   "batch_number": "0206",
   "product_id": 67,
   "last_used": "2026-06-18T00:08:43.288Z"
  },
  {
   "batch_number": "0216",
   "product_id": 31,
   "last_used": "2026-06-17T22:11:20.696Z"
  },
  {
   "batch_number": "BR-2026-0213",
   "product_id": 35,
   "last_used": "2026-06-17T19:43:53.769Z"
  },
  {
   "batch_number": "0217",
   "product_id": 56,
   "last_used": "2026-06-17T19:27:22.092Z"
  },
  {
   "batch_number": "0191",
   "product_id": 8,
   "last_used": "2026-06-17T19:24:13.163Z"
  },
  {
   "batch_number": "01",
   "product_id": 18,
   "last_used": "2026-06-17T16:25:40.933Z"
  },
  {
   "batch_number": "0215",
   "product_id": 49,
   "last_used": "2026-06-17T15:31:15.038Z"
  },
  {
   "batch_number": "0125",
   "product_id": 49,
   "last_used": "2026-06-17T14:50:25.597Z"
  },
  {
   "batch_number": "0192",
   "product_id": 8,
   "last_used": "2026-06-17T12:58:42.928Z"
  },
  {
   "batch_number": "BR-2026-0169",
   "product_id": 58,
   "last_used": "2026-06-16T19:44:03.029Z"
  },
  {
   "batch_number": "0211",
   "product_id": 67,
   "last_used": "2026-06-16T19:38:50.812Z"
  },
  {
   "batch_number": "BR-2026-0212",
   "product_id": 2,
   "last_used": "2026-06-16T17:21:26.119Z"
  },
  {
   "batch_number": "0205",
   "product_id": 67,
   "last_used": "2026-06-16T15:04:31.838Z"
  },
  {
   "batch_number": "0210",
   "product_id": 32,
   "last_used": "2026-06-16T14:09:03.804Z"
  },
  {
   "batch_number": "0199",
   "product_id": 16,
   "last_used": "2026-06-15T20:14:53.147Z"
  },
  {
   "batch_number": "BR-2026-0168",
   "product_id": 28,
   "last_used": "2026-06-15T15:16:05.221Z"
  },
  {
   "batch_number": "BR-2026-0207",
   "product_id": 56,
   "last_used": "2026-06-15T14:13:35.693Z"
  },
  {
   "batch_number": "BR-2026-0194",
   "product_id": 2,
   "last_used": "2026-06-12T20:39:41.056Z"
  },
  {
   "batch_number": "0207",
   "product_id": 56,
   "last_used": "2026-06-12T20:23:46.138Z"
  },
  {
   "batch_number": "0149",
   "product_id": 26,
   "last_used": "2026-06-12T20:06:34.136Z"
  },
  {
   "batch_number": "0208",
   "product_id": 56,
   "last_used": "2026-06-12T15:39:38.252Z"
  },
  {
   "batch_number": "0209",
   "product_id": 5,
   "last_used": "2026-06-12T13:56:49.086Z"
  },
  {
   "batch_number": "0201",
   "product_id": 69,
   "last_used": "2026-06-11T19:31:17.155Z"
  },
  {
   "batch_number": "BR-2026-0198",
   "product_id": 32,
   "last_used": "2026-06-11T19:06:13.825Z"
  },
  {
   "batch_number": "BR-2026-0184",
   "product_id": 56,
   "last_used": "2026-06-10T22:41:20.875Z"
  },
  {
   "batch_number": "0203",
   "product_id": 23,
   "last_used": "2026-06-10T15:08:56.201Z"
  },
  {
   "batch_number": "0165",
   "product_id": 49,
   "last_used": "2026-06-10T13:09:04.853Z"
  },
  {
   "batch_number": "BR-2026-0200",
   "product_id": 23,
   "last_used": "2026-06-09T20:12:08.720Z"
  },
  {
   "batch_number": "0200",
   "product_id": 23,
   "last_used": "2026-06-09T19:11:53.571Z"
  },
  {
   "batch_number": "BR-2026-0196",
   "product_id": 65,
   "last_used": "2026-06-09T19:01:55.868Z"
  },
  {
   "batch_number": "BR-2026-0195",
   "product_id": 60,
   "last_used": "2026-06-09T17:44:44.266Z"
  },
  {
   "batch_number": "BR-2026-0190",
   "product_id": 8,
   "last_used": "2026-06-09T17:29:37.417Z"
  },
  {
   "batch_number": "BR-2026-0197",
   "product_id": 23,
   "last_used": "2026-06-08T21:34:26.313Z"
  },
  {
   "batch_number": "0183",
   "product_id": 20,
   "last_used": "2026-06-05T20:09:47.917Z"
  },
  {
   "batch_number": "BR-2026-0187",
   "product_id": 43,
   "last_used": "2026-06-05T16:39:52.881Z"
  },
  {
   "batch_number": "BR-2026-0185",
   "product_id": 67,
   "last_used": "2026-06-05T13:58:47.390Z"
  },
  {
   "batch_number": "BR-2026-0167",
   "product_id": 23,
   "last_used": "2026-06-04T19:55:55.952Z"
  },
  {
   "batch_number": "BR-2026-0188",
   "product_id": 14,
   "last_used": "2026-06-04T19:01:07.290Z"
  },
  {
   "batch_number": "BR-2026-0182",
   "product_id": 20,
   "last_used": "2026-06-04T15:52:26.229Z"
  },
  {
   "batch_number": "BR-2026-0186",
   "product_id": 14,
   "last_used": "2026-06-03T22:39:06.119Z"
  }
 ]
};
