# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack
Vanilla HTML, CSS, JavaScript, with bundled D3.js (web/vendor/d3.min.js), OpenResty/Nginx proxy cache, Playwright smoke tests, Node.js unit tests.

## Users
Internal software & AI engineers evaluating foundation models and agent frameworks on Terminal-Bench 4.0 within a LAN environment.

## Product Purpose
Answer the core engineering decision question: "When per-task cost does not exceed $X, what is the highest score Terminal-Bench 4.0 can buy?"

## Positioning
An interactive Pareto frontier workbench combining official Terminal-Bench 4.0 measured per-task cost and task accuracy with budget ladders (≤$5, ≤$10, ≤$15), plus a supplementary view for alternative models with unit pricing.

## Operating Context
LAN browser tool, desktop and mobile responsive (360px to 1300px+), light/dark/system themes, keyboard-driven, offline-first without external CDN or Google Fonts.

## Capabilities and Constraints
- Official View: Accuracy vs measured per-task cost (or output tokens, latency). Pareto frontier staircase and budget ladders (≤$5, ≤$10, ≤$15).
- Supplementary View: Alternative benchmark score vs log-scaled output price ($/M token) with ◆ markers for models present in official benchmark and excluded unpriced models note.
- Live sync: 4 feedback states (updated, unchanged, cooling down with countdown, failure with retry), stale data warnings (>48h).
- Data semantics in viewmodel.js, api.js, freshness.js are frozen.
- No horizontal scroll on entire page; internal scroll in chart if wider on mobile, focusing on the low-cost/frontier side first.
- Strict no external network requests (no Google Fonts, no CDN).

## Brand Commitments
Internal engineer utility workbench. Factual, high density, calm, precise. Replaces the legacy "price tag / chalk gray / ledger green / Barlow Condensed" design with a clean, high-craft, dedicated data workbench.

## Evidence on Hand
- Official leaderboard fixture: tests/fixtures/leaderboard.json (27 rows, 330 trials/row)
- Supplementary models & pricing fixtures: tests/fixtures/models.json, tests/fixtures/pricing.json
- Model mapping table: web/data/model-map.json
- Full unit test suite (102 tests) and Playwright smoke test suite (29 tests).

## Product Principles
1. Decision first: The budget ladder and Pareto frontier are the primary answers, not secondary decoration.
2. Honest data: Exact labels, confidence intervals on hover, clear distinction between per-task cost and token unit price.
3. Dense yet scannable: Workbench density with disciplined typography and zero visual noise.
4. Resilient & offline: Full functionality offline, robust error recovery, zero layout shift or horizontal spill.
