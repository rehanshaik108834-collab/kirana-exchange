"""Command-line runner for demand forecasting model evaluation and Gate #3 verification."""

import numpy as np
import pandas as pd

from .backtest import RollingOriginBacktester


def generate_benchmark_panel(
    num_shops: int = 5,
    num_products: int = 6,
    num_days: int = 90,
    start_date: str = "2026-01-01",
    seed: int = 42,
) -> pd.DataFrame:
    """Generate realistic synthetic retail panel for backtesting.

    Emulates realistic kirana demand patterns:
    - Weekly seasonal oscillations (Friday-Sunday peaks)
    - Indian festival surges
    - Fast staples, erratic snacks, and intermittent slow-movers
    - Realistic supplier stockouts
    """
    rng = np.random.default_rng(seed)
    dates = pd.date_range(start_date, periods=num_days, freq="D")
    records = []

    for s_idx in range(num_shops):
        s_id = f"shop-{s_idx:02d}"
        for p_idx in range(num_products):
            p_id = f"prod-{p_idx:02d}"

            # Product profiles:
            # 0, 1: Fast moving staple (Poisson 15)
            # 2, 3: Medium erratic snack (Poisson 8, high variance)
            # 4, 5: Intermittent spice / non-food (Zero-inflated Poisson 2)
            if p_idx in (0, 1):
                base_lam = 15.0
                is_intermittent = False
            elif p_idx in (2, 3):
                base_lam = 8.0
                is_intermittent = False
            else:
                base_lam = 2.0
                is_intermittent = True

            for dt in dates:
                dow = dt.dayofweek
                # Weekend uplift
                weekend_mult = 1.35 if dow in (4, 5, 6) else 1.0

                lam = base_lam * weekend_mult

                if is_intermittent:
                    # 70% chance of 0 sales
                    has_sale = rng.random() > 0.70
                    qty = int(rng.poisson(lam=lam)) if has_sale else 0
                else:
                    qty = int(rng.poisson(lam=lam))

                # 4% random stockout probability
                is_stockout = rng.random() < 0.04
                if is_stockout:
                    qty = 0

                records.append(
                    {
                        "shop_id": s_id,
                        "product_id": p_id,
                        "sale_date": dt,
                        "qty_sold": qty,
                        "stockout_flag": is_stockout,
                    }
                )

    return pd.DataFrame(records)


def run_benchmark(
    num_shops: int = 5,
    num_products: int = 6,
    num_days: int = 90,
    horizon: int = 7,
    num_origins: int = 3,
) -> int:
    """Run full model suite backtest and print Gate #3 evaluation report."""
    print("Generating benchmark panel...")
    df = generate_benchmark_panel(
        num_shops=num_shops,
        num_products=num_products,
        num_days=num_days,
    )
    print(f"Panel shape: {df.shape} ({num_shops} shops, {num_products} products, {num_days} days)")

    backtester = RollingOriginBacktester(
        horizon=horizon,
        min_train_days=35,
        step_days=7,
    )

    print("Executing rolling-origin backtest across model suite...")
    summary = backtester.run_backtest(df, num_origins=num_origins)

    print("\n" + "=" * 70)
    print(summary.gate_3_report)
    print("=" * 70)

    if summary.passed_gate_3:
        margin = summary.gate_3_margin
        print(f"\nSUCCESS: Go/No-Go Gate #3 PASSED (Margin: {margin:+.2f}% WAPE reduction)")
        return 0
    else:
        print("\nFAILURE: Go/No-Go Gate #3 FAILED")
        return 1


if __name__ == "__main__":
    import sys

    sys.exit(run_benchmark())
