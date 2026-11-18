# Kirana Exchange Rate-Limit Policy

These limits are enforced using Redis Lua token bucket and sliding window scripts. Exceeding a limit returns HTTP `429 Too Many Requests` with `Content-Type: application/problem+json` (`/errors/rate-limit-exceeded`) and a `Retry-After` header.

| Route Category  | Scope            | Limit Rule                        | Implementation       | Response               |
| :-------------- | :--------------- | :-------------------------------- | :------------------- | :--------------------- |
| Global IP limit | Per IP           | 100 req / minute (burst up to 30) | Redis Token Bucket   | 429 Too Many Requests  |
| Auth (Login)    | Per Account + IP | 5 failed attempts / 15 minutes    | Redis Sliding Window | 429 + Account lock out |
| State Mutating  | Per Shop         | 60 writes / minute                | Redis Token Bucket   | 429                    |
| Swap Offers     | Per Shop         | 20 new offers / hour (Anti-spam)  | Redis Sliding Window | 429                    |
