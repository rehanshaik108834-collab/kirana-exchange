---
applyTo:
  - 'services-py/**/*.py'
---

# Python, FastAPI & ML Rules

- Use Pydantic v2 models for all FastAPI request/response payloads and YAML simulator configs.
- In `forecast-service`, never compute features using rows from `forecast_date` or later (strict zero-leakage rule). If a trained model artifact is missing or stale, fall back to the moving-average baseline and set `"model_used": "fallback"`.
- In `analytics-simulator`, derive deterministic per-(shop, product) RNG streams from the root seed so adding shops never alters existing shop series.
