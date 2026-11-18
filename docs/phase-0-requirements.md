# Phase 0 Requirements and Glossary

## Product goal

Kirana Exchange helps neighborhood shops reduce stock risk and coordinate inventory swaps through reliable, auditable services.

## Domain glossary

The canonical domain identifiers are: `product`, `ean`, `batch`, `reserved_qty`, `days_of_cover`, `at_risk_batch`, `listing`, `shortage_request`, `swap`, `handover_code`, `window`, `commitment`, `landed_cost`, and `allocation`.

## Core requirements

- Inventory reservations must never produce negative quantities or reserve more than available quantity.
- State-mutating requests are idempotent and safe to retry.
- Service data is isolated by database ownership; cross-service communication uses versioned REST APIs or RabbitMQ events.
- Every request and event carries a correlation ID for tracing.
- Errors use RFC 9457 `application/problem+json`.
- Domain changes and outbox records are committed atomically.
