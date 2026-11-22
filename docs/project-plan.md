# Kirana Exchange: Project Plan (v1.0, 13 Nov 2026)

Web-first, full-stack microservices learning and portfolio build. All shop and sales data is **simulated**. Wholesalers are simulated as one or two virtual distributors.

Related documents: [phase-0-requirements.md](phase-0-requirements.md) · [phase-1-architecture.md](phase-1-architecture.md) · [phase-2-data-model.md](phase-2-data-model.md) · [execution-roadmap.md](execution-roadmap.md)

## 1. Summary

Kirana Exchange connects neighbourhood grocery shops (kiranas) into a local network. It does three things:

1. **Forecasts** demand per shop and product, so shops stop overstocking slow items and running out of fast ones.
2. **Swaps** surplus stock between nearby shops, so an item stuck on one shelf reaches a shop where it sells.
3. **Pools** orders from many shops into one wholesale order for better prices.

The engineering goal is to demonstrate microservices, Redis, rate limiting, Docker, cloud deployment, ML, system design and basic security in one coherent product.

## 2. Problem & Research Lessons

**The problem:**

- India has 12M+ kirana shops. Margins are thin and stock turns every 9–10 days, so cash tied up in unsold stock hurts fast.
- Shops buy by gut feeling, with notebook inventory. This creates dead stock and stockouts at the same time.
- Two shops 300 m apart can have opposite problems for the same item, with no way to find each other.
- Existing players (Jumbotail, Udaan, Flipkart Wholesale, ONDC DigiDukaan) connect shops **to suppliers**, not **to each other**. Peer exchange works for pharmacies (e.g. Medicycle, UK).

**Lessons that shape the design:**

- Apps must be simple, low-typing and tolerant of poor connectivity.
- Peer networks need **critical mass**, so we need an explicit cold-start strategy.
- Peer exchange works best for **branded, packaged items**, not loose commodities.
- Holding less stock only helps if replenishment is reliable, and shops should compare **total landed cost**.
- A swap is legally a supply of goods, so GST matters (§9).

## 3. Users

| User                    | Main needs                                                                                  |
| ----------------------- | ------------------------------------------------------------------------------------------- |
| Shop owner (primary)    | Know what to order, clear dead stock, find a neighbour who needs an item, get better prices |
| Shop assistant          | Fast, low-typing stock and sales entry                                                      |
| Distributor (simulated) | Receive consolidated orders                                                                 |
| Platform admin          | Monitor network health, manage the catalog, see impact metrics, handle disputes             |

**Persona:** Ramesh, 48, 200 sq ft shop. He uses WhatsApp all day, reads Telugu and Hindi more comfortably than English, has patchy mobile data, and is wary of tools that expose his sales numbers.

## 4. Scope

- **Core:**
  - Auth and shop profiles with location; barcode-normalised catalog.
  - Batch and expiry inventory with sales recording.
  - Forecasting and reorder suggestions; dead-stock and expiry risk.
  - Swap marketplace: listings, matching, price suggestion, saga, handover.
  - Group buy with landed cost.
  - Notifications and reputation.
  - Admin analytics and a with/without-Exchange simulator.
  - Dockerised cloud deployment, monitoring, CI/CD.
- **Stretch (only after the core is stable):** voice input and vernacular strings, Telegram bot, OCR of wholesaler bills, deeper offline-first sync, a learned swap-price model.
- **Out of scope:** real payments, logistics and distributor integration; digital khata and credit scoring; native mobile apps (we ship an installable PWA).

## 5. Non-Functional Requirements (summary)

- **Performance:** swap matching p95 < 300 ms; API p95 < 500 ms at 200 concurrent users.
- **Consistency:** stock is never double-allocated. 1,000 simultaneous claims on 30 units allocate exactly 30.
- **Availability:** services auto-restart, and one service failure does not take the system down (circuit breakers).
- **Scalability:** stateless services behind a load balancer; queue workers scale independently.
- **Usability:** mobile-first, minimal typing, large tap targets, plain language.
- **Resilience:** retry with backoff, DLQs, idempotent operations.
- **Privacy:** neighbours never see a shop's sales, only anonymised surplus and need lists.
- **Observability:** metrics, structured logs, correlation IDs, dashboards.

Full quantified targets are in [phase-0-requirements.md §4](phase-0-requirements.md).

## 6. Technology Stack

| Layer       | Choice                                                                                       |
| ----------- | -------------------------------------------------------------------------------------------- |
| Frontend    | React + Vite, Tailwind CSS, React Query, Leaflet, Recharts (installable PWA)                 |
| Backend     | Node.js + TypeScript (NestJS) for all Node services                                          |
| ML services | Python, FastAPI, pandas, statsmodels/statsforecast, LightGBM, scipy                          |
| Data        | PostgreSQL (database per service), Redis, RabbitMQ                                           |
| Gateway     | Custom NestJS gateway behind Nginx                                                           |
| Ops         | Docker + Compose, GitHub Actions, Prometheus + Grafana, structured JSON logs                 |
| Testing     | Jest/Vitest, Pytest, k6, Playwright                                                          |
| Cloud       | Cloud-neutral (plain containers, Postgres, Redis, object storage); provider chosen at deploy |

**Deployment:**

- Phase A: Docker Compose on a single cloud VM.
- Phase B (optional): managed Postgres/Redis plus orchestration.

## 7. Redis Usage Map

| Use                    | Feature                           | Key / detail                             |
| ---------------------- | --------------------------------- | ---------------------------------------- |
| Nearby shop search     | `GEOADD` / `GEOSEARCH`            | `geo:shops`                              |
| Stock reservation lock | `SET NX PX`                       | `lock:batch:*` (fast path only, ADR-004) |
| Rate limiting          | Lua token bucket + sliding window | `rl:*`, `auth:lockout:*`                 |
| Idempotency            | `SET NX` with expiry              | `idem:<service>:<shop>:<key>`            |
| Group-buy windows      | Sorted set                        | `gb:windows:cutoff`                      |
| Forecast cache         | Strings/hashes with TTL           | `forecast:shop:*`                        |
| Token revocation       | Set with TTL                      | `auth:denylist:<jti>`                    |
| Live updates           | Pub/Sub or Streams                | `sse:swap:*`, `sse:notify:*`             |
| Surplus index          | Sets per product                  | `surplus:product:*`                      |

Rate-limit layers are in [rate-limit-policy.md](rate-limit-policy.md). Notifications also have a per-shop daily cap with batching, and heavy ML endpoints get low concurrency limits with queueing.

## 8. Machine Learning Design

| Model                  | Method                                                                                                                             | Evaluation                                                          |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Demand forecast        | Croston and TSB baselines; global LightGBM; optional two-stage (occurrence classifier + quantity regressor) for the sparsest items | Rolling-origin backtest, WAPE and bias vs. naive and moving average |
| Dead-stock/expiry risk | Rules on `days_of_cover` and sell-through; a calibrated classifier as an upgrade                                                   | Precision/recall on simulated outcomes                              |
| Swap matching          | Redis geo candidate generation, then `scipy` min-cost assignment on distance, price, expiry and reputation costs                   | Match rate, average distance, fill rate                             |
| Swap price suggestion  | Rule-based first (cost, cover, expiry); optional learned acceptance model trained on simulator data                                | Acceptance rate vs. margin                                          |

**Forecast pipeline:**

1. Aggregate sales into daily and weekly series per shop and product.
2. Classify each series (smooth, erratic, intermittent, lumpy) by average demand interval and variability.
3. Use Croston/TSB for intermittent series. Use LightGBM for the rest, with lag, rolling, weekday, festival, price and stockout features.
4. Output expected demand with an uncertainty band, then a reorder quantity including safety stock.
5. Store results in Postgres and cache them in Redis.

**Principles:**

- Start with simple baselines and report honest results.
- No deep learning where gradient boosting fits small, sparse retail data better.
- The README states that training data is synthetic.

## 9. GST Note

A swap is a supply of goods. Composition-scheme dealers cannot issue tax invoices or make inter-state supplies, so the system:

- restricts swaps to **same-state** shops;
- records each swap as a documented sale;
- shows a disclaimer telling shops to confirm tax treatment with their accountant.

This is not tax advice.

## 10. Data Plan

| Data                         | Source                                                                  | Real/simulated              |
| ---------------------------- | ----------------------------------------------------------------------- | --------------------------- |
| Product catalog              | Open Food Facts + about 200 hand-built Indian packaged items (MRP, GST) | Real base, cleaned          |
| Forecast validation          | Favorita and M5 (Kaggle)                                                | Real                        |
| Shop locations               | Random points clustered around a real city's neighbourhoods             | Simulated                   |
| Daily sales                  | Layered simulator (below)                                               | Simulated                   |
| Batches and expiry           | Simulator, using shelf life by category                                 | Simulated                   |
| Swaps, offers, commitments   | Simulator behaviour rules                                               | Simulated                   |
| Distributor price tiers      | Hand-made lists for 1–2 virtual distributors                            | Simulated                   |
| Festival and weekday effects | Public Indian festival calendar with assumed uplifts                    | Real dates, assumed effects |

**Simulator demand layers:**

1. Base rate (shop size, neighbourhood).
2. Weekly pattern.
3. Festival and seasonal uplift.
4. Trend.
5. Intermittency.
6. Noise and stockouts (stockout days are flagged).
7. Product lifecycle.

Every run uses a fixed seed. A loader seeds the services **through their public APIs**, and each dataset is stored with its config and seed.

**Honesty rules:**

- Simulated results show the system works under stated assumptions; they don't prove real savings.
- Run sensitivity tests on behaviour parameters (acceptance 20/40/60%).
- Report relative improvement, not real-world savings figures.
- Check and cite dataset licences, and list every assumption in the README.

**Real-shop pilot:** get feedback from one or two shops, plus optional anonymised sales to calibrate the simulator. The plan does not depend on it.

## 11. Security Measures

- **Authentication:** JWT access tokens (~15 min) with rotating, hashed refresh tokens. Logout revokes via the Redis denylist.
- **Passwords:** Argon2, with lockout after repeated failures.
- **Authorisation:** role checks **plus ownership checks** (a shop can change only its own stock).
- **Input safety:** schema validation on every endpoint; parameterised queries or the ORM.
- **Transport:** HTTPS through Nginx, CORS allow-list, security headers (Helmet).
- **Secrets:** env vars locally, a cloud secret store in deployment, never committed.
- **Service trust:** only the gateway is exposed publicly, and internal calls carry a **signed service token**.
- **Handover codes:** one-time, hashed, short expiry.
- **Privacy by design:** anonymised listings and data minimisation.
- **Auditability:** an append-only audit log for sensitive actions and every saga step.
- **Supply chain:** `npm audit`, `pip-audit`, image scanning in CI, and an OWASP Top 10 checklist in the README.

## 12. Operations

- **Containers:** one multi-stage, non-root Dockerfile per service with health checks. One Compose file runs Nginx, the gateway, all services, Postgres, Redis, RabbitMQ, Prometheus and Grafana.
- **CI/CD:** lint → unit tests → build images → vulnerability scan → Compose integration tests → push → deploy on merge to main.
- **Observability:**
  - Every service exposes `/metrics` and `/health`.
  - Grafana shows request rate, latency, error rate, queue depth, rate-limit rejections and saga outcomes.
  - Logs are JSON with a correlation ID.

## 13. Evaluation Plan & Success Criteria

**Evaluation:**

- Simulate 100–500 shops over the same months, **without** the Exchange (habit-based reordering) and **with** it (forecasts, swaps, group buys).
- Compare dead-stock value, stockout rate, expired-stock loss, cash tied up, swap success rate, and group-buy savings including landed cost.
- Also run:
  - the concurrency test (1,000 claims);
  - a k6 load test;
  - a cold-start study (10/50/200 shops).

**Success criteria:**

- Measurable dead-stock reduction.
- Forecast WAPE better than the naive baseline.
- Zero double-allocation.
- The rate limiter blocks bursts while p95 stays on target.
- A live demo of a full swap from listing to handover.

## 14. Testing Strategy

| Level        | Tools               | Focus                                                       |
| ------------ | ------------------- | ----------------------------------------------------------- |
| Unit         | Jest/Vitest, Pytest | Business rules, price suggestion, matching cost function    |
| Integration  | Compose-based       | Service-to-service calls, outbox, queues                    |
| Contract     | OpenAPI checks      | Stable gateway and service contracts                        |
| Saga/failure | Fault injection     | Timeouts, crashed workers, duplicate messages, compensation |
| Concurrency  | Custom scripts      | Locking and reservation correctness                         |
| Load         | k6                  | Latency, throughput, rate limits                            |
| End-to-end   | Playwright          | Owner and admin journeys                                    |
| ML           | Pytest + backtests  | Leakage checks, accuracy vs. baselines                      |

## 15. Risks & Mitigations

| Risk                               | Mitigation                                                                        |
| ---------------------------------- | --------------------------------------------------------------------------------- |
| Cold start / critical mass         | Forecasting has standalone value; the simulator shows network effects; seed shops |
| Scope creep toward a mobile app    | Web-first; voice, bot and OCR are stretch goals only                              |
| Too many services for the time     | P0/P1 split; shared service template                                              |
| Synthetic data weakens credibility | State assumptions, use realistic patterns, backtest honestly                      |
| GST and legal complexity           | Same-state restriction, documented bills, disclaimer                              |
| Logistics of moving stock          | Walking-distance pairs and handover codes; logistics out of scope                 |
| Cloud cost                         | Single VM with Compose; shut down when idle                                       |
| Distributed bugs                   | Correlation IDs, event log, fault-injection tests                                 |

**Buffer rule:**

- Cut stretch goals first, then reputation/disputes, then OCR and voice.
- **Never cut** the saga, locking, rate limiting or the simulator, because they carry the engineering story.

## 16. Decisions

| Decision       | Choice                                                           |
| -------------- | ---------------------------------------------------------------- |
| Backend        | NestJS (TypeScript) for Node services; FastAPI for ML services   |
| Frontend       | React + Vite                                                     |
| Message broker | RabbitMQ (ADR-001)                                               |
| Cloud provider | Open until deployment (Phase 13)                                 |
| Notifications  | In-app + email for the core; Telegram is a stretch goal          |
| Pilot          | 1–2 real shops for feedback and optional calibration data        |
| Team           | Solo developer; P1 modules are cut from the bottom if time slips |
