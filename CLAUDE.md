# CLAUDE.md — Kirana Exchange Project Brain

This file is the shared reference for Claude Code and the Claude Project. **Trust the code over this file.** If they disagree, verify in the code and then update this file.

## 1. Project Overview

Kirana Exchange is a web-first microservices platform for neighbourhood grocery shops (kiranas) in India:

1. **Forecasting:** weekly demand forecasts, safety-stock reorder suggestions, and dead-stock/expiry risk flags (`forecast-service`, Python/FastAPI, Croston/TSB + LightGBM).
2. **Peer-to-Peer Swaps:** same-state anonymised surplus-to-shortage matching (`swap-service` + `scipy` worker) and fault-tolerant transactions (`saga-orchestrator`).
3. **Group Buying:** consolidated virtual distributor buying windows with tiered landed-cost calculations (`groupbuy-service`).

Primary persona: Ramesh (48), 200 sq ft shop, WhatsApp user, prefers Telugu/Hindi, patchy connectivity, strict privacy (sales figures never exposed to neighbours).

### Docs index (read the relevant one at the start of each phase)

| Doc                                                                                                        | Contents                                                                                                                  |
| ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| [docs/project-plan.md](docs/project-plan.md)                                                               | Vision, users, scope, stack, Redis map, ML design, data/simulator plan, security, testing, risks, decisions               |
| [docs/phase-0-requirements.md](docs/phase-0-requirements.md)                                               | Glossary, US-01–US-40, quantified NFRs + verification methods, Definition of Done, pilot guide, scope freeze              |
| [docs/phase-1-architecture.md](docs/phase-1-architecture.md)                                               | Service boundaries, event catalogue, C4, swap & group-buy state machines, protocols, **ADR-001–005**, 4 failure scenarios |
| [docs/phase-2-data-model.md](docs/phase-2-data-model.md)                                                   | Data ownership, shared persistence patterns, ERD, index matrix (DDL: `infra/db/init/01-schemas.sql`)                      |
| [docs/execution-roadmap.md](docs/execution-roadmap.md)                                                     | Phases 6–17 tasks and "Done when" criteria, the 6 Go/No-Go gates, cut order                                               |
| [docs/error-catalogue.md](docs/error-catalogue.md), [docs/rate-limit-policy.md](docs/rate-limit-policy.md) | RFC 9457 problem types; rate-limit layers                                                                                 |

**Go/No-Go gates:** after Phases 2, 5, 8, 9, 11 and 13. **Phase 5 gate: PASSED (GO)**: `OutboxRelay` + RabbitMQ survive a relay killed mid-batch with 0 lost events and 0 duplicate consumer effects ([report](docs/phase-5-go-no-go.md)).

## 2. Build Status (18-Phase Roadmap)

- **[DONE] Phases 0–2:**
  - Frozen v1.0 scope; 13 glossary terms; 16 domain events in the catalogue.
  - Per-service DDL in [infra/db/init/01-schemas.sql](infra/db/init/01-schemas.sql), plus the RFC 9457 error catalogue and the rate-limit policy.
  - ADR-001–005, the C4 diagrams, both state machines and the 4 failure scenarios are in [docs/phase-1-architecture.md](docs/phase-1-architecture.md). `docs/adr/` stays empty.
  - OpenAPI covers **only** the inventory reserve endpoint ([libs/contracts/openapi/inventory-service.yaml](libs/contracts/openapi/inventory-service.yaml)).
- **[DONE] Phase 3:**
  - Docker Compose (`postgres:16`, `redis:7`, `rabbitmq:3-management`, `mailhog`, `prometheus`, `grafana`). Prometheus currently scrapes only itself.
  - `@kirana/common` `ProblemDetailsFilter`.
  - The CI workflow runs Prettier and Ruff only; there are no tests yet.
- **[DONE] Phase 4** (security gaps closed in Phase 5 Slice 4a):
  - Redis Lua rate limiter (token bucket + sliding window) in `@kirana/common`.
  - `apps/api-gateway` (port `3001`): JWT, Redis denylist, `X-Correlation-Id`, proxy.
  - `apps/auth-service` (port `3002`): Argon2id, brute-force lockout, rotating refresh tokens with family revocation on reuse.
  - `apps/shop-service` (port `3003`): profiles plus transactional outbox.
  - `apps/web-app`: **React 19**, Vite, Tailwind v4, TanStack Query, Leaflet map pin, single-flight token refresh.
- **[DONE] Phase 5** (verified 2026-11-22: build ✓, Prettier ✓, messaging 12/12, web unit 18/18, E2E 27/27, browser 13/13):
  - Slice 1 [DONE]: `apps/catalog-service` (port `3004`). `pg_trgm` GIN trigram search plus Redis cache-aside with O(1) epoch invalidation; 50k-product seed script.
  - Slice 2 [DONE]: `apps/inventory-service` (port `3005`). Optimistic concurrency `version` plus the `CHECK` stock guard, two-tier idempotency, and a 10k-row bulk import.
  - Slice 3 [DONE — GO/NO-GO PASSED]:
    - `OutboxRelay` (`FOR UPDATE SKIP LOCKED` + publisher confirms) and `IdempotentConsumerRunner` (per-tier retry queues `<q>.retry.<n>` at `5s → 30s → 300s`, then `.dlq`) in `libs/common/src/messaging/`. Gate report: [docs/phase-5-go-no-go.md](docs/phase-5-go-no-go.md); tests: `pnpm --filter @kirana/common test:int` (12/12: gate G1–G8 + workers).
    - Slice 3b: `OutboxRelayWorker` (libs/common) runs in `shop-service` and `inventory-service` (env `AMQP_URL`, `OUTBOX_RELAY_ENABLED=false` to disable); reconnects with backoff if RabbitMQ is down.
  - Slice 4a [DONE]: catalogue problem types; strict inventory/shop ownership; no self-registered admins (`create-admin` script); `shop.created.v1` carries `ownerId` and auth links `users.shop_id` via `RabbitConsumerWorker` (queue `auth.shop-linking`); `GET /v1/shops/me`; `GET /v1/catalog/products/by-ids`; DATE off-by-one fixed. E2E: `pnpm e2e:phase5` (27/27).
  - Slice 4b [DONE]: `apps/web-app` stock screens. Catalog search (name or EAN), add batch (Idempotency-Key reused across retries), stock list (available/reserved/days of cover, near-expiry badges), single-tap **Sell 1** (optimistic update with `expectedVersion`; rollback and refetch on conflict; network Retry reuses the same key). Route guards send users to /login, /shop-setup or /inventory; after shop creation the app polls refresh until the token carries `shopId`; sign-out revokes server-side.
- **[IN PROGRESS] Phase 6: Offline-capable PWA** (plan: client-side outbox in IndexedDB, single-flight sync, conflict screen, ZXing, EN/TE/HI, Lighthouse ≥ 90):
  - Slice 6.1 [DONE]: `vite-plugin-pwa` (generateSW, prompt-to-update, app-shell precache only, no API caching), generated icons + manifest, route-level code splitting (Leaflet only on shop setup). Unit 21/21; browser: SW active, offline reload and deep link served, 6/6.
  - Slice 6.2 [DONE]: IndexedDB (`idb`) stores `offline_mutation_queue` / `catalog_cache` / `query_cache`; allow-listed query persistence (server data only, never optimistic writes; 7-day max age); offline reload shows saved stock with an "Offline — saved at" note; offline catalog search from the cache; sign-out wipes IndexedDB. Unit 31/31; browser 6/6.
  - Slice 6.3 [DONE] (US-13): client-side outbox. Sell 1 / Add stock commit to `offline_mutation_queue` first; `SyncEngine` drains FIFO with each entry's own Idempotency-Key, single-flight in-tab + Web Locks across tabs; network/5xx/429 back off, 401 keeps the queue, other 4xx become `conflict` and later sales on that batch `blocked`; `projectBatches` = snapshot ⊕ queue (offline version chaining); header sync chip; inventory-service `soldAt` (device time, bounded 5 min future / 7 days, validated only for new sales). Unit 41/41; E2E 31/31; browser: 20 offline sales, 2 tabs, repeated triggers → exactly 20 server sales, qty −20, version +20, offline `sold_at` (12/12).
  - Next: 6.4 conflict screen (US-14), 6.5 ZXing, 6.6 i18n, 6.7 usability/privacy/Lighthouse.
- **[UPCOMING] Phases 7–17:**
  - Phase 7: seeded YAML synthetic data simulator.
  - Phase 8: ML forecasting and risk service.
  - Phase 9: swap marketplace and saga orchestrator.
  - Phase 10: group buy, notifications, reputation, admin CQRS dashboard.
  - Phases 11–17: hardening, CI/CD, cloud deploy, k6/Playwright, with-vs-without experiments.

## 3. Non-Negotiable Architecture Invariants

- **Strict database-per-service (ADR-002):**
  - 10 isolated logical PostgreSQL databases: `auth_db`, `shop_db`, `catalog_db`, `inventory_db`, `forecast_db`, `swap_db`, `saga_db`, `groupbuy_db`, `notify_db`, `analytics_db`.
  - ZERO cross-service foreign keys or cross-service SQL. Services talk only via REST (`/v1/...`) or RabbitMQ (`kirana.events`, `kirana.saga.commands`).
- **Canonical domain identifiers:** always use these exact names: `product`, `ean`, `batch`, `reserved_qty`, `days_of_cover`, `at_risk_batch`, `listing`, `shortage_request`, `swap`, `handover_code`, `window`, `commitment`, `landed_cost`, `allocation`.
- **Transactional outbox (ADR-003):** domain mutations and `outbox_events` inserts MUST commit in one local PostgreSQL transaction. Consumers MUST deduplicate via `processed_messages` (`ON CONFLICT DO NOTHING`), in the same transaction as their effect.
- **Stock guard (ADR-004):**
  - The PostgreSQL `version` column plus `CHECK (qty >= 0 AND reserved_qty >= 0 AND reserved_qty <= qty)` is the sole authoritative stock guard.
  - Mutations are single conditional `UPDATE … WHERE version = $v AND (qty - reserved_qty) >= $n RETURNING *`.
  - Redis `SET NX PX` locks are an optional fast path only.
- **Two-tier idempotency:** state-mutating endpoints require an `Idempotency-Key` UUID.
  - Tier 1: Redis `idem:<svc>:<shop>:<key>`, storing the request hash and response for 24h.
  - Tier 2: PostgreSQL, either a per-table `UNIQUE (shop_id, idempotency_key)` or `inventory_db.idempotency_records`.
- **Trusted identity headers:** only the gateway injects `x-user-id`, `x-user-role` and `x-shop-id`, built from the verified JWT. Downstream services must never accept them from anywhere else.
- **Errors and tracing:**
  - Errors are RFC 9457 `application/problem+json` with `correlationId`.
  - `X-Correlation-Id` propagates across HTTP, Pino/Python logs, and the RabbitMQ envelope (`id`, `type`, `version`, `occurredAt`, `correlationId`, `producer`, `payload`).
- **Migrations, not sync:** TypeORM `synchronize: false`. Each service runs its own migration on startup (`migrationsRun: true`).

## 4. Repo Map

| Path                     | Contents                                                                                                   |
| ------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `apps/api-gateway`       | Stateless proxy: correlation ID, global IP token bucket, JWT guard, catalog-write admin RBAC               |
| `apps/auth-service`      | `users`, `refresh_tokens`, `audit_logs` (`auth_db`)                                                        |
| `apps/shop-service`      | `shops`, `disputes`, outbox (`shop_db`)                                                                    |
| `apps/catalog-service`   | `products`, audit, search cache, `/metrics`; `src/scripts/seed-catalog.ts`                                 |
| `apps/inventory-service` | `inventory_batches`, `sales_events`, `idempotency_records`, outbox (`inventory_db`)                        |
| `apps/web-app`           | React PWA: login/register, shop setup (map pin), stock list + Sell 1, add batch with catalog search        |
| `libs/common`            | `ProblemDetailsFilter`, `RateLimiterService`, `OutboxRelay`, `IdempotentConsumerRunner`, RabbitMQ topology |
| `libs/contracts`         | Event envelope + `MatchFound` JSON Schemas, inventory OpenAPI                                              |
| `infra`                  | Docker Compose, DB init scripts, Prometheus config                                                         |
| `docs`                   | Phase 0–2 specs, error catalogue, rate-limit policy                                                        |
| `services-py`            | Empty — future Python services (forecast, matching worker, simulator)                                      |

## 5. Commands

```bash
docker compose -f infra/docker-compose.yml up -d     # Docker Desktop must be running
pnpm install
pnpm --filter @kirana/common build                   # build the shared lib first
pnpm -r build                                        # root has no "build" script
pnpm exec prettier --check "**/*.{ts,tsx,js,json,md,yml,yaml}"
pnpm --filter @kirana/<service> start                # after build
pnpm --filter @kirana/catalog-service seed           # 50k products (after build)
pnpm --filter @kirana/web-app dev                    # http://localhost:5173
pnpm --filter @kirana/common test:int                # messaging gate + worker tests (needs postgres+rabbitmq)
pnpm --filter @kirana/web-app test                   # web unit tests (vitest + jsdom)
pnpm e2e:phase5                                      # full-stack E2E through the gateway (after pnpm -r build)
```

- Ports: gateway `3001`, auth `3002`, shop `3003`, catalog `3004`, inventory `3005`, web `5173`, Postgres `5432`, Redis `6379`, RabbitMQ `5672`/`15672`.
- Env vars (dev defaults in code): `DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME`, `REDIS_HOST/REDIS_PORT`, `JWT_SECRET`, `AUTH|SHOP|CATALOG|INVENTORY_SERVICE_URL`, `CORS_ORIGIN`, `PORT`, `VITE_API_BASE_URL`.

## 6. Known Gaps & Tech Debt (verify before relying on any feature)

1. **Consumers:** only auth-service consumes events (`shop.created.v1`). Reusable `RabbitConsumerWorker` in libs/common for later services.
2. ~~shopId never linked~~ **Fixed (4a).** Known limitation: `shop_staff` has no invite flow yet, so staff never get a shopId and are denied all shop data.
3. ~~Ownership bypass~~ **Fixed (4a):** non-admins need a matching JWT `shopId`.
4. ~~Privilege escalation~~ **Fixed (4a):** registration allows only `shop_owner`/`shop_staff`; admins via `pnpm --filter @kirana/auth-service create-admin`.
5. ~~Shop endpoints unprotected~~ **Fixed (4a):** owner from `x-user-id`; only `shop_owner` creates; owner/admin only for `GET /:id` and `PATCH /:id/location`.
6. ~~Problem type URIs~~ **Fixed (4a):** catalogue slugs via `DomainProblemException` / status defaults; 500s no longer leak internal messages.
7. ~~DATE off-by-one~~ **Fixed (4a):** `toDateOnly()` uses local-time getters (E2E verifies expiry is preserved after a sale).
8. ~~Retry head-of-line blocking~~ **Fixed** (per-tier retry queues; gate test G7).
9. **Drift:**
   - `01-schemas.sql` runs against the default DB, not the 10 service DBs; services rely on their own migrations.
   - `MatchFound` schema says `candidateShopId`, docs say `candidateShopIds`.
   - The README says React 18 and `pnpm build`.
   - The swap saga design (phase-1 §4.1) has `COMPENSATING`/`FAILED_NO_STOCK` states and a `TransferCommitted` reply. The `swap_transactions` CHECK has only `FAILED`. Resolve this in Phase 9.
   - Redis idempotency (phase-1 §5.3) specifies `SET ... "IN_PROGRESS" NX`. Inventory uses GET-then-SET, so concurrent duplicates fall through to the Postgres UNIQUE constraint, which is still safe.

## 7. Working Style & Collaboration Rules

- Always propose a concise 3-bullet plan (service boundary, DB/cache state, invariants) before editing files.
- Build in small vertical slices and verify each one with live tests (`pnpm -r build`, Prettier, integration scripts) before moving on.
- After writing non-trivial concurrency, locking, saga or ML logic, include a brief "How This Works" explanation so the developer understands every line.
- Never scaffold multiple services in one turn. Avoid new technologies without stated justification.
- Update this file's status (§2) and gaps (§6) whenever a slice lands.
