# Phase 1 Architecture, Events, and ADRs

## Service boundaries

TypeScript/NestJS services live under `apps/`; Python ML and simulation services live under `services-py/`. Shared contracts are kept in `libs/contracts/`, and reusable NestJS utilities in `libs/common/`. Infrastructure configuration lives in `infra/`.

Each service owns its database schema and tables. Services communicate through `/v1/...` REST endpoints or RabbitMQ exchanges `kirana.events` and `kirana.saga.commands`.

## Event envelope

Events use the following envelope:

```json
{
  "id": "event-id",
  "type": "domain.event",
  "version": 1,
  "occurredAt": "2026-01-01T00:00:00Z",
  "correlationId": "request-id",
  "producer": "service-name",
  "payload": {}
}
```

Consumers deduplicate through `processed_messages` and `ON CONFLICT DO NOTHING`. Mutating services write domain changes and `outbox_events` in one local PostgreSQL transaction.

## Architecture decisions

### ADR-001: Database per service

Each service owns its persistence model. This prevents hidden coupling and makes service boundaries enforceable.

### ADR-002: Optimistic inventory reservations

Inventory reservations use a PostgreSQL `version` column and the invariant `CHECK (qty >= 0 AND reserved_qty >= 0 AND reserved_qty <= qty)`. Redis locks may optimize contention but are never the source of truth.

### ADR-003: RFC 9457 errors and correlation IDs

HTTP errors use `application/problem+json` with `type`, `title`, `status`, `detail`, `instance`, and `correlationId`. `X-Correlation-Id` is propagated through HTTP, logs, and event envelopes.
