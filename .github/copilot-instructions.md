# Kirana Exchange — Repository Rules for GitHub Copilot

## 1. Learning & Explanation Mode (Mandatory)

- Before writing or modifying code across multiple files, output a brief 3-bullet plan naming the service boundary, database table, and invariant involved.
- After generating non-trivial logic (transactions, locks, queues, state machines, SQL), add a short "How This Works" summary explaining why it is safe under concurrency or crashes.
- Keep edits small and atomic (one vertical slice at a time). Never scaffold multiple services in one turn.

## 2. Canonical Domain Glossary (Use Exact Identifiers)

Use these exact names across database columns, OpenAPI DTOs, TypeScript/Python variables, and UI labels:

- `product`, `ean`, `batch`, `reserved_qty`, `days_of_cover`, `at_risk_batch`, `listing`, `shortage_request`, `swap`, `handover_code`, `window`, `commitment`, `landed_cost`, `allocation`.

## 3. Architecture & Data Ownership Invariants

- Strictly enforce database-per-service: NEVER import entities, repositories, or SQL tables from another service. Services communicate only via REST (`/v1/...`) or RabbitMQ events (`kirana.events` / `kirana.saga.commands`).
- Errors MUST follow RFC 9457 (`Content-Type: application/problem+json`) with `type`, `title`, `status`, `detail`, `instance`, and `correlationId`.
- Propagate `X-Correlation-Id` across all HTTP headers, Pino/Python JSON logs, and event envelopes (`id`, `type`, `version`, `occurredAt`, `correlationId`, `producer`, `payload`).

## 4. Concurrency, Outbox & Idempotency Rules

- Stock reservations in `inventory-service` MUST use PostgreSQL optimistic concurrency (`version` column) + `CHECK (qty >= 0 AND reserved_qty >= 0 AND reserved_qty <= qty)`. Redis `SET NX PX` locks are an optional fast path only, never the source of truth.
- All state-mutating endpoints require `Idempotency-Key` (Redis fast-path + PostgreSQL `UNIQUE (shop_id, idempotency_key)`).
- Domain mutations and `outbox_events` inserts MUST commit inside the same local PostgreSQL transaction. Consumers MUST deduplicate via `processed_messages` (`ON CONFLICT DO NOTHING`).
