# Kirana Exchange Analytics Simulator

Deterministic 7-layer synthetic grocery demand generator, benchmark data sampler, and bulk HTTP loader for Kirana Exchange (`US-37`).

## Capabilities

- **7-Layer Demand Engine:** Isolated PCG64 streams for base rates, weekend uplifts, Indian festivals, seasonal weather, intermittency, and stockouts.
- **Deterministic Exporter:** Canonical Parquet & CSV export with SHA-256 integrity manifests.
- **Benchmark Sampler:** Kaggle Store Sales / Favorita dataset sampling for Phase 8 ML backtesting.
- **Bulk HTTP Loader:** Asynchronous `/v1/...` API seeding across Catalog, Shop, and Inventory services with optimistic concurrency version tracking.

## Usage

```bash
# Generate Parquet dataset
simulator generate -c configs/preset_10.yaml -o data/generated/preset_10

# Verify dataset manifest
simulator verify -m data/generated/preset_10/manifest.json

# Sample Kaggle Favorita benchmark
simulator sample-benchmark -t data/raw/train.csv -o data/benchmarks/favorita

# Bulk seed running services
simulator seed -c configs/preset_10.yaml --gateway-url http://localhost:3000
```
