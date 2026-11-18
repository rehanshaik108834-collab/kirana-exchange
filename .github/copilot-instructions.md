# Kirana Exchange — Repository Rules

## 1. Architecture & Data Ownership Invariants
- Strictly enforce database-per-service: NEVER import entities, repositories, or SQL tables from another service. Services communicate only via REST (`/v1/...`) or RabbitMQ.
- Errors MUST follow RFC 9457 (`Content-Type: application/problem+json`) with `type`, `title`, `status`, `detail`, `instance`, and `correlationId`.
- Propagate `X-Correlation-Id` across all HTTP headers, Pino/Python JSON logs, and event envelopes.

## 2. Concurrency, Outbox & Idempotency Rules
- Stock reservations MUST use PostgreSQL optimistic concurrency (`version` column) + `CHECK (qty >= 0 AND reserved_qty >= 0 AND reserved_qty <= qty)`. Redis `SET NX PX` locks are an optional fast path only.
- All state-mutating endpoints require an `Idempotency-Key` header.
- Domain mutations and `outbox_events` inserts MUST commit inside the same local PostgreSQL transaction.
