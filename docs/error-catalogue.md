# Kirana Exchange Error Catalogue (RFC 9457)

All errors return `Content-Type: application/problem+json`.

| HTTP Status | Error Type (URI)                        | Title                           | Trigger Condition                                                                                  |
| :---------- | :-------------------------------------- | :------------------------------ | :------------------------------------------------------------------------------------------------- |
| **400**     | `/errors/validation-failed`             | Bad Request                     | DTO `class-validator` failure. The `errors` array lists offending fields.                          |
| **401**     | `/errors/unauthorized`                  | Unauthorized                    | Missing, expired, or invalid JWT access token in `api-gateway`.                                    |
| **403**     | `/errors/forbidden`                     | Forbidden                       | RBAC failure (e.g., `shop_staff` trying to change shop profile, or accessing another shop's data). |
| **409**     | `/errors/insufficient-unreserved-stock` | Insufficient Unreserved Stock   | `qty - reserved_qty < requested_qty` during a swap reservation or sale.                            |
| **409**     | `/errors/version-conflict`              | Optimistic Concurrency Conflict | Batch `version` mismatch during offline sync or concurrent edits.                                  |
| **409**     | `/errors/idempotency-conflict`          | Idempotency Key Reused          | Attempting to reuse an `Idempotency-Key` for a different payload.                                  |
| **429**     | `/errors/rate-limit-exceeded`           | Too Many Requests               | Redis Lua token bucket or sliding window limit exceeded. Includes `Retry-After` header.            |
| **503**     | `/errors/service-unavailable`           | Service Unavailable             | Circuit breaker tripped for a downstream service in `api-gateway`.                                 |
