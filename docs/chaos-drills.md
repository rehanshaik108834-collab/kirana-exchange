# Phase 11 Chaos Drills & Degraded-Mode Runbook

This runbook documents how Kirana Exchange behaves under infrastructure and service faults, along with the operator procedures to inspect and replay Dead-Letter Queues (DLQs).

## 1. Documented Degraded-Mode Matrix

| Fault Scenario                          | Expected System Behavior                                                                                                                                                                                                                                                                                                                                                                                                           | Automated Proof                                                                                                                                          |
| :-------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Redis Down**                          | `inventory-service` bypasses `lock:batch:*` and relies on PostgreSQL `version` + `CHECK` guards (0 over-reserves). `swap-service` falls back from `GEOSEARCH` to PostgreSQL Haversine distance filtering. `groupbuy-service` falls back from `gb:windows:cutoff` sorted set to PostgreSQL cutoff queries. `api-gateway` `JwtAuthGuard` fails closed with RFC 9457 `503` (or allows unexpired JWTs when `DENYLIST_FAIL_OPEN=true`). | `apps/inventory-service/test/saga-inventory.service.test.ts`, `apps/swap-service/test/geo.service.test.ts`, `apps/api-gateway/test/chaos-drills.test.ts` |
| **RabbitMQ Down**                       | Domain writes commit atomically to PostgreSQL with unpublished `outbox_events` rows (`published_at IS NULL`). `OutboxRelayWorker` and `SagaOutboxWorker` back off exponentially and drain 100% of buffered events with publisher confirms upon reconnect.                                                                                                                                                                          | `libs/common/test/chaos-drills.unit.test.ts`                                                                                                             |
| **Single Microservice Killed**          | `api-gateway`'s per-service `opossum` circuit breaker trips to `open` after repeated failures, returning `503 Service Unavailable` fast on both REST and SSE calls while unrelated microservices stay isolated (`closed`) and healthy. After `BREAKER_RESET_TIMEOUT_MS`, the breaker probes in `halfOpen` and automatically closes once healthy.                                                                                   | `apps/api-gateway/test/resilience.test.ts`, `apps/api-gateway/test/chaos-drills.test.ts`                                                                 |
| **Poison / Exhausted Consumer Message** | `IdempotentConsumerRunner` retries through per-tier TTL queues (`5s -> 30s -> 300s`), then parks the message in `<queue>.dlq` with `x-death-reason` and `x-last-error` headers while rolling back `processed_messages`.                                                                                                                                                                                                            | `libs/common/test/chaos-drills.unit.test.ts`, `libs/common/test/dlq-replay.unit.test.ts`                                                                 |
| **ML Forecast Artifact Missing**        | `forecast-service` serves 14-day moving average fallback estimates with `"model_used": "fallback"` and the React PWA displays a clear amber banner.                                                                                                                                                                                                                                                                                | `services-py/forecast-service/tests/`, `apps/web-app/src/features/forecasts/ForecastPage.test.tsx`                                                       |
| **Offline Mobile Client**               | React PWA commits sales and new batches to IndexedDB (`offline_mutation_queue`) with UUIDv4 `Idempotency-Key`s and replays sequentially upon reconnect.                                                                                                                                                                                                                                                                            | `apps/web-app/src/features/offline/sync-engine.test.ts`                                                                                                  |

## 2. DLQ Inspection & Safe Replay CLI

Build `@kirana/common` first if running locally:

```bash
pnpm --filter @kirana/common build
```

List all known service DLQ queues:

```bash
pnpm --filter @kirana/common dlq list
```

Inspect messages parked in a DLQ **non-destructively** (every peeked message is requeued):

```bash
pnpm --filter @kirana/common dlq inspect saga.orchestrator.events.dlq --limit 20
```

Dry-run a replay before mutating any queue:

```bash
pnpm --filter @kirana/common dlq replay saga.orchestrator.events.dlq --dry-run
```

Replay a single repaired message (resets `x-retry-count: 0`, strips `x-death-reason`, stamps `x-replayed-at` & `x-replayed-by`):

```bash
pnpm --filter @kirana/common dlq replay saga.orchestrator.events.dlq \
  --message-id <UUID> \
  --operator oncall-admin
```
