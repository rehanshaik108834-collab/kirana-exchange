# Execution Roadmap: Phases 6–17, ML/Simulator Specs & Go/No-Go Gates

> **Schedule & buffer rule:**
>
> - 18 phases (0–17) across 59 working days, about 12 weeks plus 1–2 weeks of buffer.
> - Build in vertical slices: DB migration, backend/worker, React UI and automated tests together.
> - If any phase slips by more than 30%, stop and apply the cut order in §3.
>
> Phases 0–5 are specified in [phase-0-requirements.md](phase-0-requirements.md), [phase-1-architecture.md](phase-1-architecture.md) and [phase-2-data-model.md](phase-2-data-model.md). Implementation status lives in [../CLAUDE.md](../CLAUDE.md).

---

## 1. Phase-by-Phase Blueprint (Phases 6–17)

### Phase 6: Offline-Capable PWA and Usability Layer (3 days)

**Goal:** make the owner web app installable and usable on patchy mobile connections by a non-technical shopkeeper (`US-13`, `US-14`, `US-15`).

**Tasks:**

1. Add a PWA manifest and a Workbox service worker (`vite-plugin-pwa`) that caches the app shell, so the app installs on a phone home screen.
2. Build an IndexedDB offline queue (`idb`) for sales and stock entries (`offline_mutation_queue`).
   - Attach a UUIDv4 `Idempotency-Key` to each entry.
   - Replay entries in order on reconnect.
3. Build a plain-language conflict-resolution screen for when an offline entry is rejected because of a server `version` mismatch.
4. Add a visible sync status indicator (`All saved`, `3 waiting`, `Offline`).
5. Add `react-i18next` scaffolding: English first, Telugu and Hindi string files, and a language switcher.
6. Usability and accessibility pass:
   - Large tap targets, and steppers/pickers instead of typing.
   - Browser barcode scanning with ZXing.
   - Clear cached private data on logout.

**Done when:**

- With the network offline, 20 sales entries queue in IndexedDB and sync exactly once on reconnect, even if sync triggers twice.
- Mobile Lighthouse Performance and Accessibility scores are ≥ 90.

### Phase 7: Simulator and Data Pipeline (3 days)

**Goal:** generate realistic, deterministic, seed-locked synthetic shop data for forecasting, swaps and experiments (`US-37`).

**Tasks (`services-py/analytics-simulator`):**

1. Define a Pydantic-validated YAML config schema:
   - shop count, city centre and radius, product mix;
   - demand parameters;
   - behaviour parameters (swap acceptance probability, price sensitivity);
   - root `seed`.
2. Build the 7-layer synthetic demand generator. Each `(shop, product)` pair gets its own deterministic RNG stream derived from the root seed, so adding shops never changes existing shops' history.
   - Layer 1: base rate per shop, by shop size and neighbourhood type.
   - Layer 2: weekly pattern (weekend uplift).
   - Layer 3: Indian public festival and seasonal uplift on real calendar dates.
   - Layer 4: gradual upward or downward trend.
   - Layer 5: intermittency (slow items sell 0 on most days, with small occasional bursts).
   - Layer 6: noise and stockouts. When stock hits 0, recorded sales = 0 and `stockout_flag = true`, so the ML model does not learn false lows.
   - Layer 7: product lifecycle (new items appear, older ones fade).
3. Cluster shop coordinates around neighbourhood centres rather than placing them uniformly at random.
4. Export outputs as Parquet/CSV with a manifest containing `config_hash`, `seed` and version.
5. Build a bulk HTTP loader (`httpx`) that seeds services through the public `/v1/...` APIs.
6. Add a script that samples a real public grocery dataset (Favorita or M5) for backtesting. The data is kept out of git, with a SHA checksum.

**Done when:**

- Running twice with the same seed produces identical file checksums.
- Statistical sanity tests (`pytest`) verify weekend uplift, festival uplift, the slow-item zero-sales share, and stockout flags.
- Loading 100 shops with 180 days of history through the public APIs completes in ≤ 10 minutes.

### Phase 8: ML Forecasting and Risk Service (5 days)

**Goal:** serve weekly demand forecasts, safety-stock reorder suggestions, and dead-stock/expiry risk flags (`US-16` to `US-20`).

**Tasks (`services-py/forecast-service`, FastAPI):**

1. Consume `inventory.sale.recorded.v1` and `inventory.stock.updated.v1` from RabbitMQ into `forecast_db.sales_history_read_model`, deduplicated via `processed_messages`.
2. Build a past-only feature pipeline: lags, rolling means, weekday, festival flags, price, `stockout_flag`.
   - A strict zero-leakage unit test fails if any feature touches `forecast_date` or later.
3. Classify each series as `SMOOTH`, `ERRATIC`, `INTERMITTENT` or `LUMPY` using Average Demand Interval (ADI) and coefficient of variation.
4. Train and compare Naive, Moving Average, Croston/TSB (`statsforecast`) and a global `LightGBM` model.
   - Use rolling-origin backtests.
   - Report WAPE and bias on both the Favorita/M5 sample and the simulated data.
5. Compute `days_of_cover = available_stock / forecast_daily_demand`.
   - Flag batches as `BatchAtRisk`: `DEAD_STOCK`, or `EXPIRY` when expected sell-through before `expiry_date` is below current qty.
   - Attach the action ladder `1. SWAP_TO_NEIGHBOUR`, `2. BUNDLE_DISCOUNT`, `3. RETURN_TO_DISTRIBUTOR`.
6. Schedule a RabbitMQ-triggered nightly batch job.
   - It writes to `forecast_db.forecasts` and `batch_risk_flags`.
   - It caches `forecast:shop:{shopId}` in Redis with a TTL.
7. Graceful fallback: if the trained model artifact is missing or stale, serve the moving-average baseline and return `"model_used": "fallback"`.
8. React UI slice: weekly "Order-This" and "Clear-This" lists, risk badges, and a Recharts predicted-vs-actual accuracy chart.

**Done when:**

- The chosen model beats the naive baseline on WAPE, on both the real sample and the simulated data.
- The leakage test passes, and a missing model file triggers `"model_used": "fallback"`.
- Cached forecast reads respond at `p95 < 200 ms`, and the nightly batch for 500 shops finishes in `≤ 15 min`.

### Phase 9: Swap Marketplace and Saga Orchestrator (7 days)

**Goal:** build end-to-end surplus-to-shortage matching and fault-tolerant peer-to-peer stock transfers (`US-21` to `US-27`).

**Tasks (`apps/swap-service`, Python `scipy` worker, `apps/saga-orchestrator`):**

1. `swap-service`: create surplus listings from `at_risk_batch`, with a rule-based markdown price suggestion (`cost_price`, `days_of_cover`, days to expiry). Create shortage requests from forecasts.
2. Maintain Redis `geo:shops` (`GEOADD`) from `ShopCreated`/`ShopMoved` events.
   - Query candidates with `GEOSEARCH` within the shop's radius.
   - Strip all seller identity and sales numbers.
   - Enforce the **same-state restriction** (GST composition-scheme compliance).
3. Python matching worker: batch min-cost assignment (`scipy.optimize.linear_sum_assignment`) minimizing a composite cost of distance, price gap, expiry urgency and reputation penalty.
4. `saga-orchestrator`:
   - Persist the state machine in `saga_db.swap_transactions`, plus the audit trail in `swap_events`.
   - States: `INITIATED` → `RESERVING_STOCK` [30 s TTL] → `AWAITING_HANDOVER` [24 h TTL] → `HANDOVER_CONFIRMED` → `COMMITTING_TRANSFER` [60 s TTL] → `COMPLETED` | `FAILED` | `CANCELLED_COMPENSATED`.
5. Use RabbitMQ per-message TTL + `kirana.dlx` for step timeouts and automatic compensation (`ReleaseStockCmd`). Handlers are idempotent, keyed by `(transaction_id, step)`.
6. Handover and billing:
   - Store `handover_code` hashed (SHA-256) with an expiry.
   - Once both sides confirm, decrement the seller batch (`qty` and `reserved_qty`).
   - Create a buyer batch that keeps the original `cost_price` and `expiry_date`.
   - Generate a documented sale bill with the GST disclaimer, and emit `SwapCompleted`.
7. Stream live saga progress to the React UI via Server-Sent Events (SSE), fed by Redis Pub/Sub (`sse:swap:*`).

**Done when:**

- 1,000 concurrent reservation claims on 30 units allocate **exactly 30** (`0` over-reserved).
- Fault-injection tests that kill services at every saga step leave zero leaked reservations, and every saga reaches a terminal state.
- Candidate search responds at `p95 < 300 ms` across 500 shops.

**Open design points to resolve in Phase 9 planning:**

- The Phase 1 state machine includes `COMPENSATING`, `FAILED_NO_STOCK` and a `TransferCommitted` reply. The `swap_transactions.state` CHECK in Phase 2 allows only `FAILED`, so align them.
- The saga does not know the seller batch `version`, so the `ReserveStockCmd` handler must decide how the stock guard applies.

### Phase 10: Group Buy, Notifications, Reputation & Admin Dashboard (5 days)

**Goal:** complete the P1 network features and CQRS admin observability (`US-28` to `US-36`).

**Tasks (`apps/groupbuy-service`, `apps/notification-service`, `apps/shop-service`, `services-py/analytics-simulator`):**

1. `groupbuy-service`: schedule virtual distributor windows, indexed in the Redis sorted set `gb:windows:cutoff`. Commitments stay editable until `cutoff_at`.
2. Close windows using a PostgreSQL advisory lock (`pg_try_advisory_xact_lock`) plus an atomic `WHERE status IN ('OPEN', 'EXTENDED')` check.
   - If pooled demand is below `min_order_value`, apply the extend-once rule.
   - Otherwise calculate `landed_cost` (unit tier price plus proportional delivery share) and dispatch per-shop saga allocations.
3. `notification-service`:
   - Consume events and deliver in-app SSE (`sse:notify:*`) and SMTP email (MailHog in dev).
   - Enforce Redis daily caps (`notify:cap:*`) and alert batching (`notify:batch:*`).
4. `shop-service`: update `reputation_score` idempotently on `SwapCompleted`/`SwapCancelled`, and provide swap dispute submission plus an admin resolution queue.
5. Admin dashboard (`web-app`): live Leaflet network map and Recharts impact metrics, reading exclusively from `analytics_db` CQRS projections.

**Done when:**

- Two concurrent scheduler instances close each group-buy window **exactly once**.
- Landed-cost outputs match hand-calculated test cases.
- MailHog receives the emails.
- Admin CQRS metrics match raw transactional totals.

### Phases 11–17: Hardening, CI/CD, Cloud & Experimental Proof (17 days + parallel pilot)

- **Phase 11, Hardening (3 days):**
  - Timeouts, exponential retries and circuit breakers (`opossum`) on inter-service calls.
  - DLQ inspection and replay tool.
  - OWASP Top 10 audit and cross-shop authorization tests; signed internal service tokens.
  - `npm audit`, `pip-audit`, `Trivy`, `gitleaks`.
  - Chaos drills that stop Redis, RabbitMQ and individual services, to verify the documented degraded behaviour.
- **Phase 12, Containerisation & CI/CD (2 days):**
  - Multi-stage, pinned, non-root Dockerfiles with `/health` checks.
  - Nginx reverse proxy: TLS, gzip, security headers, SPA static hosting.
  - GitHub Actions pipeline that builds, scans with Trivy, runs Compose integration tests, and pushes SHA-tagged images to GHCR.
- **Phase 13, Cloud Deployment (2 days):**
  - Single cloud VM running Docker Compose behind Nginx with Let's Encrypt HTTPS.
  - Scheduled `pg_dump` backups to object storage, with a tested restore.
  - Rehearsed image-tag rollback, authenticated Grafana, and a budget alert.
- **Phase 14, System Testing, Load & Experiments (4 days):**
  - `k6` load tests (browse-heavy, write-heavy, swap-burst) verifying `p95 < 500 ms` and rate-limit enforcement.
  - Playwright end-to-end suite.
  - Paired **With-Exchange vs. Without-Exchange** experiments across ≥ 3 seeds, measuring dead-stock reduction, stockout rate, expired-stock loss, cash released, swap success rate and group-buy savings.
  - Sensitivity sweeps (acceptance `20%, 40%, 60%`; radius `0.5, 1, 2 km`) and a cold-start study (`10, 50, 200` shops).
- **Phase 15, Optimisation (2 days):**
  - Profile the bottlenecks found in Phase 14: `EXPLAIN ANALYZE`, connection pools, RabbitMQ prefetch, vectorised ML features, Vite bundle split.
  - Record before/after benchmarks.
- **Phase 16, Real-Shop Pilot & Polish (parallel from Week 7):**
  - Shadow 1–2 local shopkeepers with a task script and fix the top 3–5 UX friction points.
  - Optionally build the Telegram bot webhook (`US-39`) if ahead of schedule.
- **Phase 17, Documentation & Delivery (4 days):**
  - Finalize `README.md` with results charts, plus Swagger UI docs and a runbook.
  - 5-minute and 15-minute demo scripts and a viva Q&A sheet.
  - A clean-room setup test on a fresh machine that completes in under 30 minutes.

---

## 2. Six Mandatory Go/No-Go Gates

1. **After Phase 2:** do the OpenAPI and DB contracts cover every screen and event?
2. **After Phase 5:** does `OutboxRelay` + RabbitMQ survive a relay killed mid-batch with 0 lost events and 0 duplicate consumer effects?
3. **After Phase 8:** does the ML forecast model beat the naive baseline on WAPE? Never pad results.
4. **After Phase 9:** does the swap saga pass the kill-at-each-step fault tests and the 1,000-claim concurrency test?
5. **After Phase 11:** is the OWASP/Trivy/secret audit clean, and has the degraded behaviour under chaos been verified?
6. **After Phase 13:** is the system live over HTTPS, with tested `pg_dump` backups and rollback?

---

## 3. Pre-Approved Cut Order (If Any Phase Slips > 30%)

Cut strictly from top to bottom. Never cut contracts, auth/rate limiting, the outbox, the saga, DB stock guards, the simulator, forecast backtests, deployment or the README.

1. Telegram bot stretch goal (`US-39`).
2. Full Telugu and Hindi translations beyond the `react-i18next` scaffold.
3. Reputation scores and the admin dispute review flow.
4. Group-buy extend-once rule and notification alert batching.
5. Two-stage forecast variant for ultra-sparse items.
6. 500-shop simulator preset (keep the 10-shop and 100-shop presets).
