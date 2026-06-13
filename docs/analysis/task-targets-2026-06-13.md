# Análise de Tempos por Task — Últimos 30 dias

Gerado: 2026-06-13T22:22:52.668Z · Período: 30d

## Resumo executivo
- Events processados: **743**
- Events válidos (sem outliers): **681**
- Outliers detectados: **62**
- Task types analisados: **25**

## Targets por método (minutos)

| Slug | Tarefa | Events | Limpos | P25 | P50 | P75 | M1 (P25 ind) | M2 (best) | M3 (híbrido) | Melhor operador |
|---|---|---|---|---|---|---|---|---|---|---|
| `encapsulation` | Encapsulação | 45 | 32 | 60.7 | 136.2 | 203.4 | 59.1 | 42.5 | 48.9 | Vitor |
| `mixing` | Mix | 6 | 3 | 76.6 | 83.6 | 170.7 | 76.6 | 76.6 | 88.1 | Bruno Sarmento |
| `formulation` | Formulação | 62 | 56 | 51.9 | 78 | 144.1 | 35.5 | 11.5 | 13.2 | Vitor |
| `orders` | Ordens (P&P) | 26 | 25 | 41.6 | 66.1 | 101.6 | 42.5 | 34.8 | 40 | Simone |
| `marketplace_prep` | Preparo p/ Marketplace (Contagem/FNSKU) | 17 | 17 | 36.3 | 63.4 | 101.4 | 37.7 | 7.1 | 8.2 | Simone |
| `production_line` | Linha de Produção | 151 | 136 | 24.7 | 52.5 | 83 | 24 | 5.3 | 6.1 | Bruno Sarmento |
| `dc_shipment` | Envio pro DC (FBA/WFS) | 15 | 13 | 18.4 | 46.6 | 55 | 30 | 18 | 20.7 | Vitor |
| `review` | Revisão | 95 | 90 | 24.8 | 46.3 | 72 | 26.3 | 15.2 | 17.5 | Ana |
| `lunch` | Almoço | 66 | 64 | 43.6 | 45.7 | 48.2 | 42.8 | 39.1 | 45 | Ana |
| `labeling` | Etiquetagem | 31 | 28 | 23.7 | 44.2 | 79.4 | 42.1 | 22.6 | 26 | Simone |
| `line_changeover` | Troca de Linha (Setup) | 13 | 12 | 26.7 | 42.9 | 51.3 | 30.4 | 24.8 | 28.5 | Bruno Sarmento |
| `counting` | Contagem | 5 | 5 | 21.9 | 34 | 44 | — | — | — | — |
| `repair` | Conserto | 11 | 11 | 8.4 | 29.6 | 36.6 | 9.2 | 9.2 | 10.6 | Bruno Sarmento |
| `machine_downtime` | Downtime da Máquina | 10 | 9 | 15.9 | 26 | 40.6 | 23.5 | 23.5 | 27 | Vitor |
| `cleaning` | Limpeza | 95 | 91 | 17.5 | 25.3 | 40.5 | 28.7 | 11.4 | 13.1 | Ana |
| `organization` | Organização | 19 | 19 | 17.5 | 24.8 | 31 | 20.2 | 18.7 | 21.5 | Vitor |
| `clinic_shipment` | Envio Injeções (clínica) | 9 | 9 | 7.1 | 24.7 | 49.7 | 7.1 | 7.1 | 8.2 | Simone |
| `order_printing` | Impressão de Ordens | 18 | 18 | 12.5 | 20.7 | 35.9 | 30.3 | 12.6 | 14.5 | Simone |
| `order_printing_2` | 2ª Impressão de Ordens | 10 | 10 | 15.6 | 20.6 | 29.5 | 16.3 | 16.3 | 18.7 | Simone |
| `facility_maintenance` | Manutenção da Fábrica | 4 | 4 | 15.5 | 20.3 | 24 | 15.5 | 15.5 | 17.8 | Bruno Sarmento |
| `packaging` | Empacotamento | 17 | 17 | 11.4 | 18.4 | 31.5 | 11.4 | 11.4 | 13.1 | Simone |
| `unknown` | — | 7 | 7 | 8.9 | 16.8 | 25.3 | 9.5 | 9.5 | 10.9 | Simone |
| `shipping` | Envio Pedidos (cliente) | 1 | 1 | 15.5 | 15.5 | 15.5 | — | — | — | — |
| `material_handling` | Recebimento/Expedição (Carga/Descarga) | 4 | 4 | 3.5 | 13.4 | 25.7 | 13 | 13 | 15 | Bruno Sarmento |
| `end_of_day` | Fim de Expediente | 6 | 0 | — | — | — | — | — | — | — |

## Top 10 tasks mais lentas (por P50)

1. `encapsulation` (Encapsulação) — P50 136.2min, P25 60.7min, 32 events limpos
2. `mixing` (Mix) — P50 83.6min, P25 76.6min, 3 events limpos
3. `formulation` (Formulação) — P50 78min, P25 51.9min, 56 events limpos
4. `orders` (Ordens (P&P)) — P50 66.1min, P25 41.6min, 25 events limpos
5. `marketplace_prep` (Preparo p/ Marketplace (Contagem/FNSKU)) — P50 63.4min, P25 36.3min, 17 events limpos
6. `production_line` (Linha de Produção) — P50 52.5min, P25 24.7min, 136 events limpos
7. `dc_shipment` (Envio pro DC (FBA/WFS)) — P50 46.6min, P25 18.4min, 13 events limpos
8. `review` (Revisão) — P50 46.3min, P25 24.8min, 90 events limpos
9. `lunch` (Almoço) — P50 45.7min, P25 43.6min, 64 events limpos
10. `labeling` (Etiquetagem) — P50 44.2min, P25 23.7min, 28 events limpos

## Por operador

| Operador | Events | Horas (limpas) | Dias ativos | Events/dia | Forgotten | Cross-lunch |
|---|---|---|---|---|---|---|
| Bruno Sarmento | 198 | 236.5 | 18 | 11 | 2 | 5 |
| Simone | 194 | 138.7 | 18 | 10.8 | 0 | 1 |
| Vitor | 176 | 155.3 | 18 | 9.8 | 1 | 7 |
| Ana | 175 | 149.4 | 18 | 9.7 | 0 | 4 |

## Por dia da semana

| Dia | Events | Minutos (limpos) |
|---|---|---|
| domingo | 0 | 0 |
| segunda | 132 | 8062.8 |
| terca | 125 | 7351.3 |
| quarta | 157 | 7564.2 |
| quinta | 178 | 8851.7 |
| sexta | 150 | 8915 |
| sabado | 1 | 46.2 |

## Outliers detectados (62)

| ev | Operador | Slug | Duração (min) | Flags | Início | Fim |
|---|---|---|---|---|---|---|
| 104 | Ana | `cleaning` | 934.8 | extreme_outlier | 2026-05-21 18:10 | 2026-05-22 09:45 |
| 185 | Bruno Sarmento | `cleaning` | 0 | spurious | 2026-05-25 19:57 | 2026-05-25 19:57 |
| 662 | Bruno Sarmento | `cleaning` | 0.9 | spurious | 2026-06-09 19:37 | 2026-06-09 19:38 |
| 747 | Bruno Sarmento | `cleaning` | 0.8 | spurious | 2026-06-11 19:33 | 2026-06-11 19:33 |
| 136 | Vitor | `dc_shipment` | 1364.2 | extreme_outlier | 2026-05-22 15:27 | 2026-05-23 14:11 |
| 174 | Vitor | `dc_shipment` | 0 | spurious | 2026-05-25 15:40 | 2026-05-25 15:40 |
| 47 | Bruno Sarmento | `encapsulation` | -5.5 | spurious | 2026-05-20 18:45 | 2026-05-20 18:40 |
| 184 | Bruno Sarmento | `encapsulation` | 0 | spurious | 2026-05-25 19:38 | 2026-05-25 19:38 |
| 321 | Bruno Sarmento | `encapsulation` | 453.3 | extreme_outlier | 2026-05-29 13:26 | 2026-05-29 21:00 |
| 367 | Bruno Sarmento | `encapsulation` | 324.3 | forgotten_eod | 2026-06-01 13:45 | 2026-06-01 19:09 |
| 444 | Bruno Sarmento | `encapsulation` | 246.9 | cross_lunch_no_pause | 2026-06-03 11:19 | 2026-06-03 15:26 |
| 490 | Bruno Sarmento | `encapsulation` | 451.3 | extreme_outlier | 2026-06-04 12:30 | 2026-06-04 20:01 |
| 717 | Bruno Sarmento | `encapsulation` | 292.1 | cross_lunch_no_pause | 2026-06-11 12:21 | 2026-06-11 17:13 |
| 757 | Bruno Sarmento | `encapsulation` | 604.9 | cross_lunch_no_pause, extreme_outlier | 2026-06-12 09:58 | 2026-06-12 20:03 |
| 770 | Bruno Sarmento | `encapsulation` | 428.8 | extreme_outlier | 2026-06-12 12:54 | 2026-06-12 20:03 |
| 153 | Vitor | `encapsulation` | 407.6 | forgotten_eod, cross_lunch_no_pause, extreme_outlier | 2026-05-25 12:12 | 2026-05-25 19:00 |
| 445 | Vitor | `encapsulation` | 572.9 | cross_lunch_no_pause, extreme_outlier | 2026-06-03 11:27 | 2026-06-03 21:00 |
| 569 | Vitor | `encapsulation` | 338 | cross_lunch_no_pause | 2026-06-08 09:49 | 2026-06-08 15:27 |
| 678 | Vitor | `encapsulation` | 601.5 | cross_lunch_no_pause, extreme_outlier | 2026-06-10 10:58 | 2026-06-10 21:00 |
| 108 | Bruno Sarmento | `end_of_day` | 0 | spurious | 2026-05-21 20:32 | 2026-05-21 20:32 |
| 305 | Bruno Sarmento | `end_of_day` | 0 | spurious | 2026-05-28 18:46 | 2026-05-28 18:46 |
| 663 | Bruno Sarmento | `end_of_day` | 0 | spurious | 2026-06-09 19:38 | 2026-06-09 19:38 |
| 698 | Bruno Sarmento | `end_of_day` | 0 | spurious | 2026-06-10 19:41 | 2026-06-10 19:41 |
| 748 | Bruno Sarmento | `end_of_day` | 0 | spurious | 2026-06-11 19:33 | 2026-06-11 19:33 |
| 107 | Vitor | `end_of_day` | 0 | spurious | 2026-05-21 20:08 | 2026-05-21 20:08 |
| 48 | Bruno Sarmento | `formulation` | -1.7 | spurious | 2026-05-20 18:40 | 2026-05-20 18:38 |
| 160 | Bruno Sarmento | `formulation` | 342.5 | forgotten_eod | 2026-05-25 13:17 | 2026-05-25 19:00 |
| 208 | Bruno Sarmento | `formulation` | 378 | extreme_outlier | 2026-05-26 14:41 | 2026-05-26 21:00 |
| 405 | Bruno Sarmento | `formulation` | 521.6 | cross_lunch_no_pause, extreme_outlier | 2026-06-02 12:18 | 2026-06-02 21:00 |
| 345 | Vitor | `formulation` | 751 | cross_lunch_no_pause, extreme_outlier | 2026-06-01 08:29 | 2026-06-01 21:00 |
| 431 | Vitor | `formulation` | 768.4 | cross_lunch_no_pause, extreme_outlier | 2026-06-03 08:11 | 2026-06-03 21:00 |
| 25 | Ana | `labeling` | -212.2 | spurious | 2026-05-20 20:43 | 2026-05-20 17:10 |
| 680 | Bruno Sarmento | `labeling` | 262.7 | cross_lunch_no_pause | 2026-06-10 11:15 | 2026-06-10 15:37 |
| 1 | Simone | `labeling` | 531.3 | cross_lunch_no_pause, extreme_outlier | 2026-05-20 09:35 | 2026-05-20 18:26 |
| 566 | Vitor | `line_changeover` | 0.3 | spurious | 2026-06-08 09:02 | 2026-06-08 09:02 |
| 20 | Ana | `lunch` | 0 | spurious | 2026-05-20 19:57 | 2026-05-20 19:57 |
| 18 | Bruno Sarmento | `lunch` | -263.2 | spurious | 2026-05-20 19:50 | 2026-05-20 15:27 |
| 334 | Bruno Sarmento | `machine_downtime` | 0.2 | spurious | 2026-05-29 17:31 | 2026-05-29 17:32 |
| 87 | Bruno Sarmento | `mixing` | 0.4 | spurious | 2026-05-21 14:59 | 2026-05-21 14:59 |
| 493 | Bruno Sarmento | `mixing` | 501.7 | extreme_outlier | 2026-06-04 12:38 | 2026-06-04 21:00 |
| 38 | Simone | `mixing` | -30.9 | spurious | 2026-05-20 18:33 | 2026-05-20 18:02 |
| 72 | Simone | `orders` | -55.3 | spurious | 2026-05-21 12:27 | 2026-05-21 11:32 |
| 32 | Ana | `production_line` | -72.3 | spurious | 2026-05-20 18:23 | 2026-05-20 17:10 |
| 6 | Ana | `production_line` | -10 | spurious | 2026-05-20 18:34 | 2026-05-20 18:24 |
| 52 | Ana | `production_line` | 842.5 | extreme_outlier | 2026-05-20 19:35 | 2026-05-21 09:38 |
| 50 | Ana | `production_line` | 0 | spurious | 2026-05-20 19:35 | 2026-05-20 19:35 |
| 74 | Ana | `production_line` | -21.5 | spurious | 2026-05-21 12:35 | 2026-05-21 12:14 |
| 170 | Ana | `production_line` | 0.7 | spurious | 2026-05-25 15:11 | 2026-05-25 15:12 |
| 192 | Ana | `production_line` | 211.4 | cross_lunch_no_pause | 2026-05-26 11:29 | 2026-05-26 15:00 |
| 281 | Ana | `production_line` | 154.4 | cross_lunch_no_pause | 2026-05-28 12:23 | 2026-05-28 14:57 |
| 448 | Ana | `production_line` | 145.8 | cross_lunch_no_pause | 2026-06-03 12:12 | 2026-06-03 14:38 |
| 51 | Bruno Sarmento | `production_line` | 1088.7 | extreme_outlier | 2026-05-20 18:38 | 2026-05-21 12:47 |
| 41 | Simone | `production_line` | -12.3 | spurious | 2026-05-20 18:33 | 2026-05-20 18:21 |
| 55 | Simone | `production_line` | 745.9 | extreme_outlier | 2026-05-20 19:50 | 2026-05-21 08:16 |
| 101 | Simone | `production_line` | 981.9 | extreme_outlier | 2026-05-21 17:16 | 2026-05-22 09:38 |
| 210 | Simone | `production_line` | 360.1 | extreme_outlier | 2026-05-26 14:59 | 2026-05-26 21:00 |
| 311 | Vitor | `production_line` | 317.6 | cross_lunch_no_pause | 2026-05-29 10:04 | 2026-05-29 15:22 |
| 7 | Ana | `review` | -2 | spurious | 2026-05-20 18:24 | 2026-05-20 18:22 |
| 768 | Ana | `review` | 153.7 | cross_lunch_no_pause | 2026-06-12 12:06 | 2026-06-12 14:40 |
| 545 | Bruno Sarmento | `review` | 394.2 | extreme_outlier | 2026-06-05 14:25 | 2026-06-05 21:00 |
| 42 | Simone | `review` | -12.3 | spurious | 2026-05-20 18:33 | 2026-05-20 18:21 |
| 27 | Simone | `review` | -33.2 | spurious | 2026-05-20 18:35 | 2026-05-20 18:02 |

## Recomendação de método

- **M3 (híbrido, best×1.15)** é o default sugerido pra seed de `task_targets`: ambicioso mas alcançável (o operador mais rápido já bate, com folga de 15%).
- Slugs com poucos dados por operador (sem M1/M2) usam o **fallback P25 agregado**.
- Bruno pode sobrescrever por slug na aba 📊 Targets (Fase 5).

_Estimativas Claude.ai vs SQL: coluna a preencher quando o handoff tiver a seção de estimativas (TODO)._