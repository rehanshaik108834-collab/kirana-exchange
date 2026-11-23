# Go/No-Go Gate #3: Demand Forecasting Model Evaluation Report

**Verification Result:** ✅ **PASSED**  
**Evaluation Strategy:** Rolling-Origin Backtesting  
**Temporal Origins:** `2026-03-11`, `2026-03-18`, `2026-03-25`  
**Forecast Horizon:** 7-Day Weekly Horizon ($H = 7$)  
**Benchmark Panel:** Multi-shop simulated catalog ($5\text{ shops} \times 6\text{ products} \times 90\text{ days} = 2,700\text{ observations}$)  
**Gate Criterion:** The ML demand forecasting model must strictly beat the Naive baseline on WAPE with zero feature leakage.

---

## 1. Executive Summary & Verification Gate Checklist

| Invariant / Requirement        | Target / Threshold                                     | Observed Result                                        |   Status    |
| :----------------------------- | :----------------------------------------------------- | :----------------------------------------------------- | :---------: |
| **WAPE Beating Naive**         | $\text{WAPE}_{\text{ML}} < \text{WAPE}_{\text{Naive}}$ | **$0.2974 < 0.4039$** (**+26.37%** relative reduction) | ✅ **PASS** |
| **Bias Bound**                 | $                                                      | \text{Bias}                                            |  \le 0.15$  | **$-0.0048$** ($-0.48\%$, virtually zero bias) | ✅ **PASS** |
| **Zero Feature Leakage**       | Bit-identical features at $t$ under future mutation    | Verified across 24 dynamic features at cutoff          | ✅ **PASS** |
| **Syntetos-Boylan Routing**    | Intermittent & Lumpy routed to Croston/TSB             | Validated via `classify_panel` integration             | ✅ **PASS** |
| **Deterministic Roll-Forward** | Autoregressive inference on rolling origins            | Verified across 3 rolling temporal folds               | ✅ **PASS** |

---

## 2. Model Suite Leaderboard

Evaluated across all test origin windows ($H = 7$ days per fold):

| Rank  | Model                               |    WAPE    |    Bias     |   MAE    |   RMSE   | Relative WAPE Reduction vs. Naive |
| :---: | :---------------------------------- | :--------: | :---------: | :------: | :------: | :-------------------------------: |
| **1** | **Global LightGBM**                 | **0.2974** | **-0.0048** | **2.60** | **3.90** |            **+26.37%**            |
| **2** | **Adaptive Ensemble (SBC Routing)** | **0.2998** | **+0.0034** | **2.62** | **3.89** |            **+25.77%**            |
| **3** | **Moving Average (14-day)**         |   0.3307   |   +0.0464   |   2.89   |   4.29   |              +18.12%              |
| **4** | **Croston SBA (Intermittent)**      |   0.3349   |   -0.0495   |   2.93   |   4.29   |              +17.08%              |
| **5** | **Seasonal Naive (7-day lag)**      |   0.4032   |   -0.0025   |   3.52   |   5.39   |              +0.17%               |
| **6** | **Last-Value Naive (Baseline)**     |   0.4039   |   -0.1329   |   3.53   |   5.19   |        _Baseline (0.00%)_         |

---

## 3. Analysis of Findings

### 3.1 Why LightGBM Beats Naive by 26.37%

- **Day-of-Week Seasonality:** Kirana stores experience dramatic Friday–Sunday demand spikes (35% uplift). Naive models blindly project the immediate previous day's demand ($y_t$), causing massive under-forecasting on Fridays and severe over-forecasting on Mondays. LightGBM leverages `day_of_week`, `is_weekend`, and `lag_7` to capture weekend surges accurately.
- **Stockout Resistance:** On days with supplier stockouts, Naive drops to 0 and propagates zero demand forward. LightGBM and our feature pipeline impute uncensored demand using past non-stockout rolling statistics, preventing false stockout spirals.

### 3.2 Adaptive Ensemble Routing

- For `SMOOTH` and `ERRATIC` products (fast-moving staples, snacks), LightGBM captures non-linear price and calendar signals.
- For `INTERMITTENT` and `LUMPY` products (seasonal spices, non-food household items with 70%+ zero-sales days), Croston SBA and TSB model the compound Poisson/inter-arrival distribution without over-fitting spurious zero-streaks.

### 3.3 Bias and Inventory Risk Protection

- Naive baseline exhibited severe negative bias ($-13.29\%$), which would systematically cause kirana stockouts during peak trading periods.
- LightGBM achieved a bias of **$-0.48\%$**, providing well-calibrated safety-stock recommendations.

---

## 4. Next Phase Progression: Slice 8.4

With Go/No-Go Gate #3 fulfilled:

1. **Batch Risk Engine (`days_of_cover` & Risk Flags):**
   - Calculate `days_of_cover = current_stock / forecast_daily_demand`.
   - Flag batches as `DEAD_STOCK` ($> 45$ days of cover) or `EXPIRY` (sell-through before expiration $< \text{current stock}$).
   - Attach the 3-step action ladder:
     1. `SWAP_TO_NEIGHBOUR`
     2. `BUNDLE_DISCOUNT`
     3. `RETURN_TO_DISTRIBUTOR`
2. **Nightly Batch Forecast Worker:**
   - Write forecasts to PostgreSQL `forecasts` and `batch_risk_flags`.
   - Populate Redis cache `forecast:shop:{shopId}` with TTL.
   - Maintain graceful fallback (`"model_used": "fallback"` via `MovingAverageForecaster`) if model artifacts are unavailable.
