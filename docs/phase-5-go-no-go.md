# Phase 5 Go/No-Go Gate Report: Outbox Relay & Idempotent Consumer

**Gate question** ([execution-roadmap.md §2](execution-roadmap.md)): does `OutboxRelay` + RabbitMQ survive a relay killed mid-batch with 0 lost events and 0 duplicate consumer effects?

**Verdict: GO.**

- The core gate (G1, G2, G5, G6) passed on the **unchanged** Slice 3 code.
- The hardening tests found two real defects (G7, G8). Both were fixed and verified.
- The final suite passes 8/8, stable across three consecutive runs (2026-11-22).

## How to run

```bash
docker compose -f infra/docker-compose.yml up -d postgres rabbitmq
pnpm --filter @kirana/common test:int
```

Each run creates a throwaway database (`gate_<random>`) and uniquely named queues, and removes both afterwards. Tests: [libs/common/test/messaging.int.test.ts](../libs/common/test/messaging.int.test.ts).

**How duplicates are detected:**

- Every consumer side effect is written to `gate_effects(message_id, applied_count)` with `ON CONFLICT ... applied_count + 1`, so a duplicate effect shows up as `applied_count = 2` and is never silently absorbed.
- A separate **tap queue** bound to the same routing key counts every broker delivery, duplicates included.

## Results

| #   | Scenario                                                                                                                   | Pass criteria                                                                                                                                     | Original code        | Final |
| --- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | ----- |
| G1  | 100 outbox rows; relay crashes after 37 broker-confirmed publishes (`killAfterPublishCount: 37`); a restarted relay drains | 137 deliveries (37 re-published); 100 distinct ids; 0 unpublished rows; 100 effects, all `applied_count = 1`; 100 `processed_messages`; DLQ empty | ✅                   | ✅    |
| G2  | Two relays drain 500 rows concurrently                                                                                     | 500 deliveries, 500 distinct ids; both relays did work                                                                                            | ✅                   | ✅    |
| G3  | Handler fails once for 5 of 20 messages                                                                                    | All 20 applied exactly once; the 5 retried exactly once; DLQ empty                                                                                | n/a¹                 | ✅    |
| G4  | Handler always fails                                                                                                       | 4 attempts (1 + 3 retries), then DLQ with `x-retry-count = 3`; no effect, no `processed_messages` row                                             | n/a¹                 | ✅    |
| G5  | Malformed JSON                                                                                                             | Straight to DLQ, `x-death-reason = INVALID_JSON`; handler never called                                                                            | ✅                   | ✅    |
| G6  | Redelivery after a committed-but-unacked effect                                                                            | Detected as duplicate; handler not called; `applied_count` stays 1                                                                                | ✅                   | ✅    |
| G7  | Message B (200 ms retry) queued after message A is parked on a 3000 ms retry                                               | B is retried in under 1500 ms                                                                                                                     | ❌ 2904 ms²          | ✅    |
| G8  | Message with no `id` / `messageId`                                                                                         | Straight to DLQ, `x-death-reason = MISSING_MESSAGE_ID`; no retries                                                                                | ❌ burned 3 retries³ | ✅    |

¹ The original runner hard-coded 5 s / 30 s / 300 s delays. Making them injectable was the minimum change needed to test retries in seconds.
² **Head-of-line blocking:** RabbitMQ only expires per-message TTLs at the head of a queue, so a short retry waited behind a long one.
³ The `NOT NULL` insert into `processed_messages` failed on every attempt, so the message burned all its retries before reaching the DLQ.

## Library changes (`libs/common/src/messaging`)

1. **`IdempotentConsumerRunner`:**
   - New optional `{ retryDelaysMs }` constructor option (default `RETRY_DELAYS_MS` = 5 s, 30 s, 300 s). Its length is the max retry count.
   - Messages whose id is missing or not a UUID go straight to `.dlq` with `MISSING_MESSAGE_ID` / `INVALID_MESSAGE_ID`.
2. **Retry topology (fixes G7):**
   - `assertConsumerQueueTopology` now creates **one retry queue per delay tier**, `<queue>.retry.<attempt>`, each with a queue-level `x-message-ttl`. It returns `retryQueues: string[]` instead of `retryQueue`.
   - The runner publishes retries to `retryQueueName(queue, attempt)` without a per-message expiration.
   - Every message in a tier queue has the same TTL, so FIFO order equals expiry order and no head-of-line blocking is possible.

## How this works (why 0 lost and 0 duplicate effects)

- **Relay (at-least-once):**
  - It selects unpublished rows `FOR UPDATE SKIP LOCKED`, publishes each on a confirm channel, waits for broker confirms, then sets `published_at` **in the same transaction that holds the row locks**.
  - A crash before COMMIT rolls back `published_at`, so those rows are re-published. Nothing is lost; duplicates on the wire are possible (G1: 37).
  - `SKIP LOCKED` makes concurrent relays take disjoint rows (G2).
- **Consumer (exactly-once effect):**
  - Each message runs in one DB transaction: `INSERT INTO processed_messages ... ON CONFLICT DO NOTHING RETURNING`, then the handler's effect, then COMMIT, then ACK.
  - A duplicate either finds the row and is skipped (G1, G6), or rolls back together with its effect when the handler fails (G3, G4).
  - The effect and its dedup record are atomic, so the effect happens exactly once.

## Not yet covered (scheduled later)

- **Phase 5 Slice 3b:** services do not yet run a relay or consumers. That wiring is the next slice.
- **Metrics (Phase 11):** `rabbitmq_dlq_messages_total` is a process-local counter (`getDlqCount()`). A Prometheus metric and Grafana alert belong to Phase 11 hardening.
