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

**Go/No-Go gates:** after Phases 2, 5, 8, 9, 11 and 13. **Phase 5 gate:** `OutboxRelay` + RabbitMQ survive a relay killed mid-batch with 0 lost events and 0 duplicate consumer effects.

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
- **[DONE, with known security gaps — see §6] Phase 4:**
  - Redis Lua rate limiter (token bucket + sliding window) in `@kirana/common`.
  - `apps/api-gateway` (port `3001`): JWT, Redis denylist, `X-Correlation-Id`, proxy.
  - `apps/auth-service` (port `3002`): Argon2id, brute-force lockout, rotating refresh tokens with family revocation on reuse.
  - `apps/shop-service` (port `3003`): profiles plus transactional outbox.
  - `apps/web-app`: **React 19**, Vite, Tailwind v4, TanStack Query, Leaflet map pin, single-flight token refresh.
- **[IN PROGRESS] Phase 5:**
  - Slice 1 [DONE]: `apps/catalog-service` (port `3004`). `pg_trgm` GIN trigram search plus Redis cache-aside with O(1) epoch invalidation; 50k-product seed script.
  - Slice 2 [DONE]: `apps/inventory-service` (port `3005`). Optimistic concurrency `version` plus the `CHECK` stock guard, two-tier idempotency, and a 10k-row bulk import.
  - Slice 3 [LIBRARY BUILT — NOT WIRED, GO/NO-GO PENDING]:
    - `OutboxRelay` (`FOR UPDATE SKIP LOCKED` + publisher confirms) and `IdempotentConsumerRunner` (retries `5s → 30s → 300s`, then `.dlq`) in `libs/common/src/messaging/`.
    - **No service runs a relay or a consumer yet, so outbox rows are never published.**
  - Slice 4 [NEXT]: React catalog search, stock batch entry, and single-tap sales UI (`apps/web-app`).
- **[UPCOMING] Phases 6–17:**
  - Phase 6: offline PWA (IndexedDB mutation queue, ZXing barcode scanning, EN/TE/HI i18n).
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
| `apps/web-app`           | React PWA (login/register, shop setup with map pin)                                                        |
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
```

- Ports: gateway `3001`, auth `3002`, shop `3003`, catalog `3004`, inventory `3005`, web `5173`, Postgres `5432`, Redis `6379`, RabbitMQ `5672`/`15672`.
- Env vars (dev defaults in code): `DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME`, `REDIS_HOST/REDIS_PORT`, `JWT_SECRET`, `AUTH|SHOP|CATALOG|INVENTORY_SERVICE_URL`, `CORS_ORIGIN`, `PORT`, `VITE_API_BASE_URL`.

## 6. Known Gaps & Tech Debt (verify before relying on any feature)

1. **Outbox not wired:** no service runs `OutboxRelay` or a consumer, and none depends on `amqplib`.
2. **`shopId` never linked:** `users.shop_id` is only set at register; nothing updates it after `POST /v1/shops`, so JWTs carry `shopId: null`.
3. **Ownership bypass:** `assertShopOwnership` ([inventory.controller.ts](apps/inventory-service/src/inventory.controller.ts)) passes when `x-shop-id` is absent.
4. **Privilege escalation:** `RegisterDto` ([auth.dto.ts](apps/auth-service/src/dto/auth.dto.ts)) accepts `role: 'admin'` and any `shopId`.
5. **Shop endpoints unprotected:** `ownerId` comes from the request body, and there are no ownership checks on `GET /:id` or `PATCH /:id/location`.
6. **Problem `type` URIs:** `ProblemDetailsFilter` emits `/errors/<status>`, not the catalogue slugs (e.g. `/errors/version-conflict`), and `title` is the exception class name.
7. **Possible DATE off-by-one:** `mapRawBatch` ([inventory.service.ts](apps/inventory-service/src/inventory.service.ts)) calls `toISOString()` on node-postgres `Date`s from raw queries (wrong day in IST). Unconfirmed.
8. **Retry head-of-line blocking:** a single `.retry` queue with per-message TTL means a 300s retry can delay a 5s one.
9. **Drift:**
   - `01-schemas.sql` runs against the default DB, not the 10 service DBs; services rely on their own migrations.
   - `MatchFound` schema says `candidateShopId`, docs say `candidateShopIds`.
   - The README says React 18 and `pnpm build`.
   - The swap saga design (phase-1 §4.1) has `COMPENSATING`/`FAILED_NO_STOCK` states and a `TransferCommitted` reply. The `swap_transactions` CHECK has only `FAILED`. Resolve this in Phase 9.
   - Redis idempotency (phase-1 §5.3) specifies `SET ... "IN_PROGRESS" NX`. Inventory uses GET-then-SET, so concurrent duplicates fall through to the Postgres UNIQUE constraint, which is still safe.
   - `apps/web-app/tsconfig.tsbuildinfo` is committed.

## 7. Working Style & Collaboration Rules

- Always propose a concise 3-bullet plan (service boundary, DB/cache state, invariants) before editing files.
- Build in small vertical slices and verify each one with live tests (`pnpm -r build`, Prettier, integration scripts) before moving on.
- After writing non-trivial concurrency, locking, saga or ML logic, include a brief "How This Works" explanation so the developer understands every line.
- Never scaffold multiple services in one turn. Avoid new technologies without stated justification.
- Update this file's status (§2) and gaps (§6) whenever a slice lands.
