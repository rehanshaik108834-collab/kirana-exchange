# Phase 0: Requirements, Domain Glossary & Scope Baseline v1.0

## 1. Product Goal & Target Persona

Kirana Exchange connects neighbourhood grocery shops (kiranas) into a local network to:

1. Forecast weekly demand per shop and product to prevent overstocking slow items and running out of fast movers.
2. Swap surplus/near-expiry stock between nearby same-state shops via an automated, fault-tolerant saga.
3. Pool orders from multiple shops into consolidated virtual distributor buying windows to unlock volume pricing.

**Primary Persona:** Ramesh (48), runs a 200 sq ft neighbourhood shop, uses WhatsApp daily, prefers Telugu/Hindi UI labels, operates on patchy mobile connectivity, and requires strict privacy (private sales figures are never exposed to neighbours).

---

## 2. Canonical Domain Glossary

Use these exact identifiers across database columns, OpenAPI contracts, NestJS/FastAPI code, and React UI labels:

| Term                  | Canonical Identifier | Exact Definition                                                                                                                                                   |
| :-------------------- | :------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Product**           | `product` / `ean`    | A packaged retail item normalised in the master catalog and keyed by its unique barcode (`ean`), storing brand, pack size, category, MRP, and GST rate.            |
| **Batch**             | `batch`              | A physical lot of a single product held by a shop with a specific total quantity (`qty`), `cost_price`, and `expiry_date`.                                         |
| **Reserved Quantity** | `reserved_qty`       | Units within a batch locked for an active swap so they cannot be sold or promised to a second buyer (`0 <= reserved_qty <= qty`).                                  |
| **Days of Cover**     | `days_of_cover`      | Current available stock divided by the forecasted daily demand for that product at that shop.                                                                      |
| **At-Risk Batch**     | `at_risk_batch`      | A batch flagged for dead-stock risk (`days_of_cover` exceeds threshold) or expiry risk (expected sell-through before `expiry_date` is below current stock).        |
| **Listing**           | `listing`            | An anonymised surplus offer created from an at-risk batch specifying available quantity, suggested or chosen unit price, and expiry date.                          |
| **Shortage Request**  | `shortage_request`   | A shop's need for a specific product within a local radius, generated automatically from forecast shortages or posted manually.                                    |
| **Swap**              | `swap`               | A peer-to-peer stock transfer transaction between two same-state shops, coordinated by `saga-orchestrator` from offer acceptance to physical handover and billing. |
| **Handover Code**     | `handover_code`      | A short-lived, hashed one-time verification code confirmed by both seller and buyer when physical stock changes hands.                                             |
| **Window**            | `window`             | A scheduled group-buying period for a specific virtual distributor with a fixed `cutoff_at` timestamp and `min_order_value`.                                       |
| **Commitment**        | `commitment`         | A shop's pledged order quantity for a product inside an open group-buy window, editable until `cutoff_at`.                                                         |
| **Landed Cost**       | `landed_cost`        | The true per-unit cost to a shop in a group buy after applying volume price tiers, proportional delivery share, and minimum-order effects.                         |
| **Allocation**        | `allocation`         | A shop's final confirmed share of a consolidated group-buy order and its calculated `landed_cost`, executed via `saga-orchestrator`.                               |

---

## 3. Prioritized User Story Backlog (US-01 to US-40)

- **P0 (Core Architecture):** `api-gateway`, `auth-service`, `shop-service`, `catalog-service`, `inventory-service`, `forecast-service`, `swap-service` + Python worker, `saga-orchestrator`, Outbox + RabbitMQ, Redis, and offline React PWA (`web-app`).
- **P1 (Network & Evaluation):** `groupbuy-service`, `notification-service`, reputation & disputes, admin CQRS dashboard, and `analytics-simulator`.

### Accounts & Shops (FR-A)

- **US-01 (FR-A1) | P0 | Must:** Owner account registration with phone/email + Argon2 password hashing; returns JWT access & refresh tokens.
- **US-02 (FR-A1) | P0 | Must:** Login with brute-force lockout (5 consecutive failed attempts in 15 mins -> 6th returns HTTP 429 + `Retry-After`).
- **US-03 (FR-A2) | P0 | Must:** RBAC (`shop_owner`, `shop_staff`, `admin`) + cross-shop ownership isolation (HTTP 403 on unauthorized access).
- **US-04 (FR-A3) | P0 | Must:** Shop profile & Leaflet map pin (`lat`/`lng`, `state`, `gst_scheme`, `operating_hours`); emits `ShopCreated`/`ShopMoved` to update Redis `GEOADD`.
- **US-05 (FR-A4) | P0 | Must:** Rotating hashed refresh tokens with replay reuse detection (revokes entire session family) and Redis denylist on logout.

### Product Master Catalog (FR-C)

- **US-06 (FR-C1, FR-C2) | P0 | Must:** Sub-100 ms barcode (`ean`) and partial-name trigram (`pg_trgm` + Redis cache-aside) search across 50,000 Open Food Facts + 200 Indian items.
- **US-07 (FR-C2) | P0 | Should:** Admin catalog add/edit/duplicate merge with immediate Redis cache invalidation.

### Inventory, Sales & Offline PWA (FR-I & Phase 6)

- **US-08 (FR-I1) | P0 | Must:** Add stock batch (`qty`, `cost_price`, `expiry_date`, `reserved_qty = 0`) and write `StockUpdated` to transactional outbox atomically.
- **US-09 (FR-I2) | P0 | Must:** Single-tap sales recording with optimistic concurrency (`version`) + `CHECK (reserved_qty >= 0 AND reserved_qty <= qty)` + `SaleRecorded` outbox event.
- **US-10 (FR-I2) | P0 | Must:** Bulk CSV stock and sales import (10,000 rows without timeout).
- **US-11 (FR-I3) | P0 | Must:** Inventory dashboard displaying available qty, `reserved_qty`, `days_of_cover`, and near-expiry warning badges.
- **US-12 (FR-I4) | P0 | Must:** Strict stock reservation guard (1,000 concurrent claims on 30 units allocate exactly 30 with zero over-reservation).
- **US-13 (Phase 6 PWA) | P0 | Must:** Offline IndexedDB mutation queue for sales/stock with `Idempotency-Key` replay (20 offline writes sync exactly once).
- **US-14 (Phase 6 PWA) | P0 | Should:** Plain-language offline version-conflict resolution screen on server version mismatch.
- **US-15 (Phase 6 PWA) | P0 | Should:** Installable PWA (Workbox/manifest) + English/Telugu/Hindi i18n switcher scaffold (Lighthouse Perf & A11y >= 90).

### Demand Forecasting & Risk (FR-F)

- **US-16 (FR-F1) | P0 | Must:** Weekly demand forecast per shop/product classifying series (`SMOOTH`, `ERRATIC`, `INTERMITTENT`, `LUMPY`) using Croston/TSB or global LightGBM (`<= 15 min` nightly batch for 500 shops; `< 200 ms` p95 cached reads; beats naive baseline on WAPE).
- **US-17 (FR-F1) | P0 | Must:** Graceful moving-average baseline fallback when trained model artifact is missing/stale (`model_used: "fallback"`).
- **US-18 (FR-F2) | P0 | Must:** Weekly "Order-This" reorder suggestions incorporating safety stock and uncertainty bands (`lower`, `upper`).
- **US-19 (FR-F3) | P0 | Must:** Dead-stock & expiry-risk detection ("Clear-This" list) emitting `BatchAtRisk` with ordered action ladder (`1. Swap to neighbour`, `2. Bundle discount`, `3. Return to distributor`).
- **US-20 (FR-F4) | P0 | Should:** Per-shop forecast accuracy history chart (Recharts predicted vs. actual + model version/training date).

### Swap Marketplace & Saga (FR-S)

- **US-21 (FR-S1) | P0 | Must:** Create surplus listing from `at_risk_batch` with rule-based suggested markdown price (`cost_price`, `days_of_cover`, days to expiry).
- **US-22 (FR-S2) | P0 | Must:** Anonymised nearby listings & shortage requests filtered strictly to same `state` (`< 300 ms` p95 across 500 shops; seller identity and sales numbers stripped).
- **US-23 (FR-S3) | P0 | Must:** Automated surplus-to-shortage matching via Redis `GEOSEARCH` + Python `scipy` min-cost assignment (distance, price fit, expiry penalty, reputation penalty).
- **US-24 (FR-S4) | P0 | Must:** Accept, counter, or reject swap offers with `Idempotency-Key`, auto-expiry, and `20 offers/hr` anti-spam rate limit (HTTP 429).
- **US-25 (FR-S5) | P0 | Must:** Saga stock reservation via RabbitMQ (`SET NX PX` fast-path + atomic Postgres update), persisted in `swap_transactions`/`swap_events`, streaming live status via SSE.
- **US-26 (FR-S5, FR-S6) | P0 | Must:** Two-sided hashed `handover_code` confirmation transferring stock to buyer batch (preserving `cost_price` and `expiry_date`), generating documented sale bill with GST disclaimer, and emitting `SwapCompleted`.
- **US-27 (FR-S7) | P0 | Must:** Fault-tolerant saga timeout (RabbitMQ TTL + DLX) & crash compensation releasing `reserved_qty` with zero leaked reservations.

### Group Buy, Notifications, Reputation & Admin (FR-G, FR-N, FR-R, FR-D)

- **US-28 (FR-G1) | P1 | Should:** Open virtual distributor buying windows indexed by `cutoff_at` in Redis sorted set (`gb:windows:cutoff`).
- **US-29 (FR-G2) | P1 | Should:** Commit and edit product quantities before `cutoff_at`, showing pooled progress toward volume price tiers.
- **US-30 (FR-G3, FR-G5) | P1 | Should:** Exactly-once window closure (Postgres advisory lock + atomic `status = 'OPEN'` check), `landed_cost` calculation, and per-shop saga allocations.
- **US-31 (FR-G4) | P1 | Could:** Minimum order extend-once rule (extends `cutoff_at` once if unextended, else cancels with notification).
- **US-32 (FR-N1) | P1 | Should:** In-app SSE & SMTP email notifications with Redis per-shop daily caps and alert batching.
- **US-33 (FR-R1) | P1 | Could:** Idempotent `reputation_score` calculation from `SwapCompleted`, timeouts, and cancellations.
- **US-34 (FR-R2) | P1 | Could:** Swap dispute reporting and admin review queue with audit trail.
- **US-35 (FR-D1) | P1 | Should:** Admin live Leaflet map reading from CQRS `shop_map_projection`.
- **US-36 (FR-D2) | P1 | Should:** Admin CQRS impact metrics dashboard (`network_metrics_projection`).
- **US-37 (FR-D3, Phase 7) | P1 | Must:** Reproducible YAML-driven synthetic data generator (10, 100, 500 shop presets; deterministic seed checksums; bulk API loader `<= 10 min` for 100 shops x 180 days).
- **US-38 (FR-D3, Phase 14) | P1 | Must:** Paired With/Without-Exchange & Cold-Start experiments across >= 3 seeds, sizes (10, 50, 200), acceptance rates (20%, 40%, 60%), and radii (0.5, 1, 2 km).
- **US-39 (Stretch) | P1 | Won't (Until Core Complete):** Telegram bot webhook via `api-gateway` (#1 on cut list).
- **US-40 (Out of Scope) | N/A | Won't:** Real payments, physical delivery logistics, live distributor ERPs, digital khata/credit scoring, native mobile apps.

---

## 4. Quantified Non-Functional Requirements & Global DoD

| Category                  | Metric / Scenario                                  | Target                                                                         | Verification Method                                    |
| :------------------------ | :------------------------------------------------- | :----------------------------------------------------------------------------- | :----------------------------------------------------- |
| **API Latency**           | General API at 200 concurrent users                | `p95 < 500 ms`                                                                 | k6 browse-heavy and write-heavy profiles               |
| **Geo Matching**          | Candidate search & ranking across 500 shops        | `p95 < 300 ms`                                                                 | k6 swap-burst profile against swap-service             |
| **Catalog Search**        | Barcode or trigram lookup across 50,000 products   | `< 100 ms`                                                                     | Automated integration benchmark on catalog-service     |
| **Forecasting**           | Cached read / Nightly batch (500 shops)            | `p95 < 200 ms` / `<= 15 min`                                                   | Prometheus latency histogram & batch job timer         |
| **Bulk Ingestion**        | CSV 10,000 rows / API loader (100 shops, 180 days) | `10,000 rows succeed` / `<= 10 min`                                            | Integration test & simulator loader benchmark          |
| **Stock Consistency**     | 1,000 simultaneous claims on 30 units              | Exactly `30` allocated, `0` over-reserved, `0` negative                        | Custom high-concurrency contention script              |
| **Messaging Durability**  | Outbox relay or service killed mid-saga            | `0` lost events, `0` duplicates, `0` leaked reservations                       | Fault-injection & chaos drill test suite               |
| **Rate Limiting**         | Global IP / Login / Writes / Swap Offers           | `100/min (burst 30)` / `5/15m` / `60/min` / `20/hr` (HTTP 429 + `Retry-After`) | 50-parallel-request unit test + k6 burst test          |
| **PWA & Offline**         | Mobile Lighthouse / 20 offline writes              | `>= 90` Perf & A11y / `20/20` synced once                                      | Lighthouse mobile audit & Playwright offline test      |
| **Security & Containers** | Auth unit coverage / Container privileges / CVEs   | `>= 80%` / `100%` non-root / `0` unmitigated critical CVEs                     | Coverage report, Trivy, npm audit, pip-audit, gitleaks |
| **Reproducibility**       | Clean-room setup / Simulator seed determinism      | `< 30 min` setup / identical SHA checksums per seed                            | Fresh-VM clean-room test & Pytest sanity suite         |

**Global Definition of Done.** A user story or phase is Done only when all of these hold:

1. **Contract conformance:** OpenAPI 3.1 and JSON Schema event definitions pass Spectral linting with zero drift between backend DTOs and frontend TypeScript clients.
2. **Vertical slice completeness:** the backend endpoint or worker, the DB migration with explicit constraints and indexes, and the mobile-first React UI slice are wired together.
3. **Observability built in:** structured JSON logs carry `correlationId`, errors return `application/problem+json`, and `/health` and `/metrics` are scraped by Prometheus.
4. **Automated verification:** unit, integration and phase-specific fault/concurrency tests pass in GitHub Actions CI.
5. **Documentation updated:** relevant ADRs, event catalogue entries or runbook notes are committed alongside the code.

---

## 5. Shopkeeper Pilot Discovery Guide

Use this 15–20 minute guide when visiting or shadowing 1–2 local kirana shops. The goal is to **validate assumptions**, not to collect feature requests.

```markdown
# Pilot Discovery Interview & Observation Log

- **Shop Alias / Area:** [e.g., Shop #1 — Neighbourhood General Store, ~200 sq ft]
- **Date & Duration:** [YYYY-MM-DD | 15–20 mins]
- **Interviewee Role:** [Owner / Assistant]
- **Status:** [Completed / Scheduled for YYYY-MM-DD (Pending)]

## 1. Silent Observation (5 minutes)

- How are sales and stock recorded during a customer rush? (Notebook / mental / billing app)
- Phone type and connectivity reliability inside the shop
- Comfort with English vs. Telugu / Hindi labels on mobile screens

## 2. Five Core Discovery Questions (10–15 minutes)

1. **Reordering habit:** "How do you decide what and how much to buy from the wholesaler each week?"
2. **Unsold & expiring stock:** "Which packaged items usually get stuck or expire before selling? What do you do with them now?"
3. **Neighbour swap willingness:** "If a kirana 300–500 m away needed an item you have too much of, would you sell it to them? Should your shop name stay hidden until you agree?"
4. **Discount & handover rules:** "What discount off wholesale/MRP makes a swap worthwhile, and who would carry the boxes over?"
5. **Notification preference:** "When a nearby offer or group-buy window is closing, how often and where do you want to be alerted?"

## 3. Parameter Calibration (feeds Phases 1, 7 & 9)

- **Acceptable swap radius (km):** [default 0.5 – 2.0 km]
- **Minimum markdown % for surplus:** [default rule: cost, days of cover, days to expiry]
- **Preferred handover method:** [buyer runner / seller drop-off + one-time handover code]
- **Daily notification cap:** [max alerts/day before fatigue]
```

---

## 6. Scope Freeze v1.0 & Pre-Approved Cut Order

- **Included (P0):** api-gateway, auth, shop, catalog, inventory, forecast (Croston, TSB, LightGBM), swap + Python matching worker (`scipy`), saga-orchestrator, Outbox + RabbitMQ backbone, Redis geo/locks/rate-limiting/caching, offline-capable React PWA.
- **Included (P1):** groupbuy, notification, reputation & disputes, admin CQRS dashboard, analytics-simulator (with/without-Exchange and cold-start experiments).
- **Excluded from v1.0:** real payments, delivery logistics, live distributor ERPs, digital khata, native apps, Kafka, Kubernetes, MongoDB, GraphQL, deep-learning forecasters.
- **Cut order** (triggered if any phase slips by more than 30%):
  1. Telegram bot stretch goal
  2. Full Telugu/Hindi translations beyond the i18n scaffold
  3. Reputation scores and admin dispute flow
  4. Group-buy extend-once rule and notification batching
  5. Two-stage forecast variant for ultra-sparse items
  6. 500-shop simulator preset (keep the 10-shop and 100-shop presets)
- **Change control:** no new functional requirements may be added to v1.0. Record any scope change in `docs/CHANGELOG.md` with its date, reason and impact on the 59-day schedule.
