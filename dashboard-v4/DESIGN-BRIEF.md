# HealthFare Dashboard — Redesign Brief for Claude Design

**Goal:** completely redesign the layout of the "Hoje" (Today) page — a live factory production dashboard. Design BOTH a **light** and a **dark** version. Keep every section/data below (you may re-arrange, re-group, re-prioritize, and restyle freely — but each live data piece must have a home in the new design).

This is an **internal admin dashboard** (managers watch the supplement factory in real time). It is data-dense and glanceable — someone should understand the day's state in 3 seconds, then drill in.

---

## Brand & identity
- **HealthFare** — supplement manufacturing. Logo is "Health" (navy) + "Fare" (green leaf).
- **Primary navy:** `#1e3f8c` (the "H"). **Primary green:** `#22b35d` (the "FARE" leaf).
- Feel: clean, trustworthy, modern, calm. Not playful. A serious operations console.

## Flow colors (semantic — keep these meanings)
- **Production line** (making bottles) → navy `#1e3f8c`
- **P&P / Pick&Pack** (packing orders) → amber `#d97706`
- **Support / other** → purple `#7c5cd6`
- **OK** `#16a34a` · **Warning** `#d97706` · **Bad/urgent** `#dc2626` · **Info** `#2563eb`

## Current theme surfaces (you can evolve these, keep the vibe)
- **Light:** bg `#f4f6fb`, surface white-ish, subtle green grain top-right.
- **Dark:** bg `#0a1124` (deep navy), surface `#131c36`, glass panels, green glow top-right.

---

## THE SECTIONS (in current priority order — reorder as you see fit)

### 1. Alert boxes (top, only appear when there's a problem)
- **Incidents box** — red/urgent. Ex: "Duplicate count detected: Ana registered 574 bottles twice." Shows what/where/who + a "resolve" action.
- **Pending totals box** — a production line was closed WITHOUT a final count. Red if escalated. Ex: "Vitor closed NAC line (batch BR-2026-0313) without a total." Has an input to register the number + a "foi engano" (was a mistake) dismiss button.
- These are exceptions — most days they're hidden. When present, they must grab attention.

### 2. Ponto (Attendance strip)
A horizontal row of small person-cards, one per operator. Each shows:
- Name + a status dot (green=working, amber=on break, gray=left/absent)
- Status text: "entrou 08:13" / "EM PAUSA 45min" / "saiu 18:36" / "sem ponto hoje"
- Two small admin buttons on hover: **⨯ deslogar** (log off) and **🏁 saída** (register checkout)
- Real example people: Ana, Vitor, Simone, Bruno Sarmento

### 3. KPI cards (the day's numbers — the heart of the glance)
A row/grid of big-number stat cards:
- **Produção hoje** (Production today) — e.g. "1,461 bottles" + sub "vs média 1,493/dia"
- **Revisão (dia)** (Review) — e.g. "94% aprovado"
- **Metas em curso** (Goals in progress) — e.g. "2 metas · 500x Vitamin D"
- **P&P do dia** (Pick & Pack) — e.g. "181 ordens · 21s/ordem"
- **Pedidos hoje** (Orders shipped, from Veeqo) — e.g. "181 shipped"
- **FNSKU hoje** (FNSKU labels) — e.g. "340 labels"
Each KPI has a label, big value, small unit/sub, and a flow color accent. Some are clickable to drill in.

### 4. Timeline (the biggest, richest section)
A per-person horizontal timeline of the whole day. One row per operator; along each row, colored bars = tasks (colored by flow: navy production, amber P&P, purple support). Plus attendance markers on the row: ▸check-in, 🍽lunch, ◼check-out. Idle gaps show as empty. Clicking a bar opens a detail panel (product, batch, duration, bottle count, who did it). This is where a manager reads "what happened today, by whom."

### 5. Cameras
A grid of live camera feeds (the factory floor + the encapsulation machine). Compact tiles, expandable.

### 6. Notifications
A card listing the day's system notifications/events (feed style), toggleable.

---

## Interactions to preserve
- **Widgets are reorderable/toggleable** — the manager can hide/reorder sections (there's a little gear menu).
- **Theme toggle** (sun/moon) switches light↔dark.
- **Date picker** — can view past days.
- Cards/bars are **clickable → detail popovers**.
- **PIN gate** — it's admin-only (login screen not part of this redesign).

## What to deliver
1. A **light** layout and a **dark** layout (full page).
2. Show the sections with **realistic data** (use the examples above — real names, real numbers), not placeholders.
3. Keep it **responsive** — it's viewed on desktop mostly, but should not break narrow.
4. You can radically change structure, hierarchy, spacing, card style, typography — that's the point. Just keep every section's *content/data* represented.

---

*Note for the engineer (Bruno's Claude Code): the live page is `dashboard-v4/src/pages/CommandCenter.jsx` (layout) + `dashboard-v4/src/styles.css` (light+dark vars). Port the design there, keep all data wiring.*

---

## Folder / directory (where the redesign gets ported)

```
=== DASHBOARD-V4 DIRECTORY (design-relevant) ===
  src/App.jsx
  src/adapters/adapt-to-hfdata.cjs
  src/adapters/admin-api.js
  src/adapters/from-api.js
  src/adapters/writes.js
  src/components/CameraGrid.jsx
  src/components/FloatingPopover.jsx
  src/components/Icons.jsx
  src/components/NotificationsPanel.jsx
  src/components/PinGate.jsx
  src/components/Primitives.jsx
  src/components/SearchOverlay.jsx
  src/components/Shell.jsx
  src/components/SidePanel.jsx
  src/components/Timeline.jsx
  src/data.js
  src/extras.css
  src/flags.js
  src/helpers.js
  src/main.jsx
  src/pages/AdminPanel.jsx
  src/pages/CamerasPage.jsx
  src/pages/CarolinaFalar.jsx
  src/pages/CommandCenter.jsx
  src/pages/FloorDisplay.jsx
  src/pages/InventoryPage.jsx
  src/pages/OtherPages.jsx
  src/pages/PicklistPage.jsx
  src/pages/PrintingPage.jsx
  src/pages/ProductSetupPage.jsx
  src/pages/RoadmapPage.jsx
  src/pages/StockOverviewPage.jsx
  src/pages/SystemHealthPage.jsx
  src/pages/UsersPage.jsx
  src/redesign-v4.css
  src/styles.css
  src/timeline.css
  src/tweaks-panel.jsx
  src/utils/day-stats.cjs
  src/utils/ny-time.cjs

=== KEY FILES FOR REDESIGN ===
  ★ src/pages/CommandCenter.jsx   → THE PAGE LAYOUT (all sections composed here)
  ★ src/styles.css                → LIGHT + DARK theme colors (:root + [data-theme=dark])
  ★ src/extras.css                → extra theme overrides
  ★ src/App.jsx                   → theme toggle (data-theme on <html>), routing, PIN
  ★ src/components/Shell.jsx      → top bar, nav, theme button
  ★ src/components/Primitives.jsx → KPI cards, CapBar, FlowDot (reusable UI)
  ★ src/components/Timeline.jsx   → the per-person day timeline
  ★ src/components/CameraGrid.jsx → live camera tiles
  ★ src/components/NotificationsPanel.jsx → notifications feed card
```
