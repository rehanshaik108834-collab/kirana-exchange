"""Seeded paired With-Exchange vs. Without-Exchange experiment engine."""

import math
from decimal import Decimal
from typing import Any

from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import BehaviourParams, CityCenterConfig, SimulatorConfig
from ..exporter import compute_config_hash
from ..generator import run_simulation, stream_rng
from .models import SimulationRun

DOMAIN_EXPERIMENT = 99
EARTH_RADIUS_KM = 6371.0088


class PairedExperimentRequest(BaseModel):
    seed: int = Field(default=42, ge=0)
    shop_count: int = Field(default=10, ge=2, le=500)
    skus_per_shop: int = Field(default=20, ge=5, le=100)
    days: int = Field(default=60, ge=14, le=365)
    acceptance_rate: float = Field(default=0.45, ge=0.0, le=1.0)
    radius_km: float = Field(default=4.0, gt=0.0, le=25.0)
    state: str = "Telangana"


class ExperimentMetrics(BaseModel):
    dead_stock_value_inr: float
    expired_stock_loss_inr: float
    stockout_events: int
    stockout_rate_pct: float
    unmet_demand_units: int
    cash_released_inr: float
    swaps_completed: int
    units_swapped: int
    groupbuy_savings_inr: float


class PairedExperimentResult(BaseModel):
    config_hash: str
    seed: int
    shop_count: int
    days: int
    acceptance_rate: float
    radius_km: float
    without_exchange: ExperimentMetrics
    with_exchange: ExperimentMetrics
    deltas: dict[str, float]


def _haversine_km(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    r_lat1, r_lng1, r_lat2, r_lng2 = map(math.radians, (lat1, lng1, lat2, lng2))
    d_lat = r_lat2 - r_lat1
    d_lng = r_lng2 - r_lng1
    a = (
        math.sin(d_lat / 2.0) ** 2
        + math.cos(r_lat1) * math.cos(r_lat2) * math.sin(d_lng / 2.0) ** 2
    )
    c = 2.0 * math.atan2(math.sqrt(a), math.sqrt(max(0.0, 1.0 - a)))
    return EARTH_RADIUS_KM * c


def execute_paired_experiment(req: PairedExperimentRequest) -> PairedExperimentResult:
    """Run deterministic paired With-Exchange vs. Without-Exchange evaluation on the same seed."""
    cluster_count = max(1, min(6, req.shop_count // 3))
    cfg = SimulatorConfig(
        seed=req.seed,
        shop_count=req.shop_count,
        skus_per_shop=req.skus_per_shop,
        days=req.days,
        city_center=CityCenterConfig(
            state=req.state,
            radius_km=max(req.radius_km * 1.5, 4.0),
            cluster_count=cluster_count,
        ),
        behaviour=BehaviourParams(swap_acceptance_prob=req.acceptance_rate),
    )
    config_hash = compute_config_hash(cfg)
    dataset = run_simulation(cfg)

    shops_df = dataset.shops
    products_df = dataset.products
    batches_df = dataset.initial_batches
    sales_df = dataset.daily_sales

    # Product lookups
    prod_cost = {int(r["product_idx"]): float(r["cost_price"]) for _, r in products_df.iterrows()}
    prod_shelf = {
        int(r["product_idx"]): int(r["shelf_life_days"]) for _, r in products_df.iterrows()
    }
    prod_slow = {int(r["product_idx"]): bool(r["is_slow_mover"]) for _, r in products_df.iterrows()}
    init_qty_map = {
        (int(r["shop_idx"]), int(r["product_idx"])): int(r["initial_qty"])
        for _, r in batches_df.iterrows()
    }

    # Same-state neighbor graph within req.radius_km
    shop_rows = shops_df.to_dict(orient="records")
    neighbors: dict[int, set[int]] = {int(s["shop_idx"]): set() for s in shop_rows}
    for i in range(len(shop_rows)):
        s1 = shop_rows[i]
        for j in range(i + 1, len(shop_rows)):
            s2 = shop_rows[j]
            if s1["state"] != s2["state"]:
                continue
            if _haversine_km(s1["lat"], s1["lng"], s2["lat"], s2["lng"]) <= req.radius_km:
                neighbors[int(s1["shop_idx"])].add(int(s2["shop_idx"]))
                neighbors[int(s2["shop_idx"])].add(int(s1["shop_idx"]))

    # Aggregate per (shop_idx, product_idx)
    sales_df = sales_df.copy()
    sales_df["unmet"] = (sales_df["true_demand"] - sales_df["recorded_sales"]).clip(lower=0)

    total_rows = max(1, len(sales_df))
    base_stockout_events = int(sales_df["stockout_flag"].sum())
    base_unmet_units = int(sales_df["unmet"].sum())

    grouped = (
        sales_df.groupby(["shop_idx", "product_idx"], sort=True)
        .agg(
            total_sales=("recorded_sales", "sum"),
            unmet_units=("unmet", "sum"),
            stockout_days=("stockout_flag", "sum"),
            final_on_hand=("on_hand_end", "last"),
        )
        .reset_index()
    )

    base_dead_stock_val = 0.0
    base_expired_loss_val = 0.0
    surplus_by_prod: dict[int, list[dict[str, Any]]] = {}
    shortage_by_prod: dict[int, list[dict[str, Any]]] = {}
    total_fast_replenish_value = 0.0

    for _, row in grouped.iterrows():
        s_idx = int(row["shop_idx"])
        p_idx = int(row["product_idx"])
        cost = prod_cost.get(p_idx, 50.0)
        shelf = prod_shelf.get(p_idx, 180)
        is_slow = prod_slow.get(p_idx, False)

        final_qty = int(row["final_on_hand"])
        total_sales = int(row["total_sales"])
        unmet = int(row["unmet_units"])
        stockout_days = int(row["stockout_days"])
        avg_daily = total_sales / float(req.days)
        days_of_cover = (final_qty / avg_daily) if avg_daily > 1e-6 else 999.0

        # Dead stock: slow-movers or > 45 days of cover holding leftover units
        is_dead_or_excess = final_qty > 0 and (is_slow or days_of_cover > 45.0)
        if is_dead_or_excess:
            base_dead_stock_val += final_qty * cost

        # Expired stock loss when shelf life <= simulation horizon and initial stock wasn't cleared
        expired_units = 0
        if shelf <= req.days:
            init_qty = init_qty_map.get((s_idx, p_idx), 0)
            sold_by_expiry = round(avg_daily * shelf)
            expired_units = max(0, init_qty - sold_by_expiry)
            base_expired_loss_val += expired_units * cost

        surplus_units = max(final_qty if is_dead_or_excess else 0, expired_units)
        if surplus_units > 0:
            surplus_by_prod.setdefault(p_idx, []).append(
                {
                    "shop_idx": s_idx,
                    "units": surplus_units,
                    "expired_units": expired_units,
                    "cost": cost,
                }
            )

        if unmet > 0:
            shortage_by_prod.setdefault(p_idx, []).append(
                {
                    "shop_idx": s_idx,
                    "unmet": unmet,
                    "stockout_days": stockout_days,
                }
            )

        if not is_slow and total_sales > 0:
            total_fast_replenish_value += total_sales * cost

    # Counterfactual With-Exchange matching
    rng = stream_rng(
        req.seed,
        DOMAIN_EXPERIMENT,
        round(req.acceptance_rate * 1000),
        round(req.radius_km * 100),
    )

    swaps_completed = 0
    units_swapped = 0
    dead_stock_reduced_val = 0.0
    expired_loss_reduced_val = 0.0
    cash_released_val = 0.0
    stockouts_avoided_days = 0
    unmet_avoided_units = 0

    for p_idx in sorted(set(surplus_by_prod.keys()) & set(shortage_by_prod.keys())):
        sellers = surplus_by_prod[p_idx]
        buyers = shortage_by_prod[p_idx]

        for seller in sellers:
            if seller["units"] <= 0:
                continue
            seller_neighbors = neighbors.get(seller["shop_idx"], set())
            for buyer in buyers:
                if buyer["unmet"] <= 0 or seller["units"] <= 0:
                    continue
                if buyer["shop_idx"] not in seller_neighbors:
                    continue
                if float(rng.uniform(0.0, 1.0)) > req.acceptance_rate:
                    continue

                transfer = min(seller["units"], buyer["unmet"])
                if transfer <= 0:
                    continue

                cost = seller["cost"]
                swap_price = round(cost * 0.90, 2)
                swaps_completed += 1
                units_swapped += transfer
                dead_stock_reduced_val += transfer * cost
                cash_released_val += transfer * swap_price

                if seller["expired_units"] > 0:
                    saved_exp = min(seller["expired_units"], transfer)
                    expired_loss_reduced_val += saved_exp * cost
                    seller["expired_units"] -= saved_exp

                # Avoided stockout days proportional to resolved unmet demand
                resolved_ratio = transfer / max(1, buyer["unmet"])
                avoided_days = max(1, round(buyer["stockout_days"] * resolved_ratio))
                avoided_days = min(avoided_days, buyer["stockout_days"])

                stockouts_avoided_days += avoided_days
                unmet_avoided_units += transfer

                seller["units"] -= transfer
                buyer["unmet"] -= transfer
                buyer["stockout_days"] -= avoided_days

    # Pooled group-buy tier discount (~5.5% landed savings on connected cluster replenishment)
    connected_shops = sum(1 for nbrs in neighbors.values() if len(nbrs) > 0)
    connectivity_ratio = connected_shops / float(max(1, len(shop_rows)))
    groupbuy_savings_val = round(total_fast_replenish_value * 0.055 * connectivity_ratio, 2)

    without_metrics = ExperimentMetrics(
        dead_stock_value_inr=round(base_dead_stock_val, 2),
        expired_stock_loss_inr=round(base_expired_loss_val, 2),
        stockout_events=base_stockout_events,
        stockout_rate_pct=round((base_stockout_events / total_rows) * 100.0, 3),
        unmet_demand_units=base_unmet_units,
        cash_released_inr=0.0,
        swaps_completed=0,
        units_swapped=0,
        groupbuy_savings_inr=0.0,
    )

    with_stockouts = max(0, base_stockout_events - stockouts_avoided_days)
    with_dead_stock = max(0.0, base_dead_stock_val - dead_stock_reduced_val)
    with_expired_loss = max(0.0, base_expired_loss_val - expired_loss_reduced_val)

    with_metrics = ExperimentMetrics(
        dead_stock_value_inr=round(with_dead_stock, 2),
        expired_stock_loss_inr=round(with_expired_loss, 2),
        stockout_events=with_stockouts,
        stockout_rate_pct=round((with_stockouts / total_rows) * 100.0, 3),
        unmet_demand_units=max(0, base_unmet_units - unmet_avoided_units),
        cash_released_inr=round(cash_released_val, 2),
        swaps_completed=swaps_completed,
        units_swapped=units_swapped,
        groupbuy_savings_inr=groupbuy_savings_val,
    )

    dead_stock_reduction_pct = (
        round(((base_dead_stock_val - with_dead_stock) / base_dead_stock_val) * 100.0, 2)
        if base_dead_stock_val > 0
        else 0.0
    )
    stockout_reduction_pct = (
        round(((base_stockout_events - with_stockouts) / base_stockout_events) * 100.0, 2)
        if base_stockout_events > 0
        else 0.0
    )

    return PairedExperimentResult(
        config_hash=config_hash,
        seed=req.seed,
        shop_count=req.shop_count,
        days=req.days,
        acceptance_rate=req.acceptance_rate,
        radius_km=req.radius_km,
        without_exchange=without_metrics,
        with_exchange=with_metrics,
        deltas={
            "deadStockReductionPct": dead_stock_reduction_pct,
            "stockoutReductionPct": stockout_reduction_pct,
            "cashReleasedInr": with_metrics.cash_released_inr,
            "groupbuySavingsInr": with_metrics.groupbuy_savings_inr,
            "swapsCompleted": float(swaps_completed),
        },
    )


async def run_paired_experiment(
    session: AsyncSession,
    req: PairedExperimentRequest,
) -> PairedExperimentResult:
    """Execute paired With/Without-Exchange experiment and persist both rows in simulation_runs."""
    result = execute_paired_experiment(req)

    for enabled, metrics_obj in (
        (False, result.without_exchange),
        (True, result.with_exchange),
    ):
        existing = (
            await session.execute(
                select(SimulationRun).where(
                    SimulationRun.config_hash == result.config_hash,
                    SimulationRun.seed == result.seed,
                    SimulationRun.exchange_enabled == enabled,
                )
            )
        ).scalar_one_or_none()

        payload = metrics_obj.model_dump()
        if existing is not None:
            existing.metrics_summary = payload
            existing.shop_count = result.shop_count
            existing.acceptance_rate = Decimal(f"{result.acceptance_rate:.2f}")
            existing.radius_km = Decimal(f"{result.radius_km:.2f}")
        else:
            session.add(
                SimulationRun(
                    config_hash=result.config_hash,
                    seed=result.seed,
                    shop_count=result.shop_count,
                    exchange_enabled=enabled,
                    acceptance_rate=Decimal(f"{result.acceptance_rate:.2f}"),
                    radius_km=Decimal(f"{result.radius_km:.2f}"),
                    metrics_summary=payload,
                )
            )

    await session.commit()
    return result
