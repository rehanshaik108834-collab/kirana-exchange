"""Determinism and counterfactual impact tests for With/Without-Exchange simulations."""

from simulator.analytics.experiment import PairedExperimentRequest, execute_paired_experiment


def test_paired_experiment_is_bit_reproducible_and_shows_positive_exchange_impact() -> None:
    req = PairedExperimentRequest(
        seed=42,
        shop_count=12,
        skus_per_shop=15,
        days=60,
        acceptance_rate=0.60,
        radius_km=6.0,
    )

    run1 = execute_paired_experiment(req)
    run2 = execute_paired_experiment(req)

    assert run1.model_dump() == run2.model_dump()
    assert run1.without_exchange.swaps_completed == 0
    assert run1.without_exchange.cash_released_inr == 0.0
    assert run1.without_exchange.groupbuy_savings_inr == 0.0

    assert run1.with_exchange.dead_stock_value_inr <= run1.without_exchange.dead_stock_value_inr
    assert run1.with_exchange.stockout_rate_pct <= run1.without_exchange.stockout_rate_pct
    assert run1.with_exchange.groupbuy_savings_inr > 0.0
    assert run1.with_exchange.swaps_completed > 0
    assert run1.with_exchange.cash_released_inr > 0.0
