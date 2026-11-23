"""Nightly forecast & batch risk engine runner with Redis cache-aside hydration."""

import json
import math
import time
import uuid
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
import structlog
from sqlalchemy import delete, select, text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from ..api.metrics import metrics
from ..config import settings
from ..db.models import (
    BatchRiskFlag,
    BatchSnapshotReadModel,
    Forecast,
    OutboxEvent,
    SalesHistoryReadModel,
)
from ..ml.artifact_store import load_production_forecaster
from ..ml.classifier import classify_panel
from ..ml.risk import BatchRiskResult, compute_reorder_qty, evaluate_batch_risks

logger = structlog.get_logger("forecast.worker.batch_runner")

CACHE_KEY_PREFIX = "forecast:shop:"
FORECAST_HORIZON_DAYS = 7
Z_SCORE_80_PCT = 1.28


def cache_key_for_shop(shop_id: uuid.UUID | str) -> str:
    return f"{CACHE_KEY_PREFIX}{shop_id}"


def _coerce_uuid(raw: str | uuid.UUID | None) -> uuid.UUID:
    if isinstance(raw, uuid.UUID):
        return raw
    if raw is not None:
        try:
            return uuid.UUID(str(raw))
        except ValueError:
            pass
    return uuid.uuid4()


def _to_date(val: Any) -> date:
    if isinstance(val, datetime):
        return val.date()
    if isinstance(val, date):
        return val
    return pd.to_datetime(val).date()


@dataclass(frozen=True)
class BatchRunSummary:
    as_of_date: date
    shops_processed: int
    forecasts_written: int
    risk_flags_written: int
    outbox_events_queued: int
    model_used: str
    fallback_active: bool
    duration_seconds: float
    cache_writes: int
    cache_errors: int


async def build_shop_forecast_payload(
    session: AsyncSession,
    shop_id: uuid.UUID,
) -> dict[str, Any]:
    """Assemble the canonical API + Redis cache payload for a single shop."""
    # 1. Fetch latest forecast_date for horizon_days=7
    latest_date_stmt = (
        select(Forecast.forecast_date)
        .where(Forecast.shop_id == shop_id, Forecast.horizon_days == FORECAST_HORIZON_DAYS)
        .order_by(Forecast.forecast_date.desc())
        .limit(1)
    )
    latest_date = (await session.execute(latest_date_stmt)).scalar_one_or_none()

    weekly_rows: list[Forecast] = []
    if latest_date is not None:
        weekly_stmt = (
            select(Forecast)
            .where(
                Forecast.shop_id == shop_id,
                Forecast.horizon_days == FORECAST_HORIZON_DAYS,
                Forecast.forecast_date == latest_date,
            )
            .order_by(Forecast.reorder_qty.desc(), Forecast.predicted_qty.desc())
        )
        weekly_rows = list((await session.execute(weekly_stmt)).scalars().all())

    # 2. Fetch batch snapshots to expose live available_qty & expiry metadata
    batches_stmt = select(BatchSnapshotReadModel).where(BatchSnapshotReadModel.shop_id == shop_id)
    batch_rows = list((await session.execute(batches_stmt)).scalars().all())

    available_by_product: dict[uuid.UUID, int] = {}
    batch_by_id: dict[uuid.UUID, BatchSnapshotReadModel] = {}
    for b in batch_rows:
        batch_by_id[b.batch_id] = b
        avail = max(0, int(b.qty) - max(0, int(b.reserved_qty)))
        available_by_product[b.product_id] = available_by_product.get(b.product_id, 0) + avail

    # 3. Fetch active batch risk flags
    risk_stmt = (
        select(BatchRiskFlag)
        .where(BatchRiskFlag.shop_id == shop_id)
        .order_by(BatchRiskFlag.expected_unsold_qty.desc(), BatchRiskFlag.days_of_cover.desc())
    )
    risk_rows = list((await session.execute(risk_stmt)).scalars().all())

    # 4. Build predicted-vs-actual accuracy series (last 30 days of horizon_days=1 vs sales)
    daily_preds_stmt = (
        select(Forecast.product_id, Forecast.forecast_date, Forecast.predicted_qty)
        .where(Forecast.shop_id == shop_id, Forecast.horizon_days == 1)
        .order_by(Forecast.forecast_date.desc())
        .limit(1500)
    )
    daily_pred_rows = (await session.execute(daily_preds_stmt)).all()

    pred_by_date: dict[date, float] = {}
    for _, f_date, p_qty in daily_pred_rows:
        dt = _to_date(f_date)
        pred_by_date[dt] = pred_by_date.get(dt, 0.0) + float(p_qty)

    accuracy_series: list[dict[str, Any]] = []
    if pred_by_date:
        min_dt = min(pred_by_date.keys())
        max_dt = max(pred_by_date.keys())
        actual_stmt = select(
            SalesHistoryReadModel.sale_date,
            SalesHistoryReadModel.qty_sold,
        ).where(
            SalesHistoryReadModel.shop_id == shop_id,
            SalesHistoryReadModel.sale_date >= min_dt,
            SalesHistoryReadModel.sale_date <= max_dt,
        )
        actual_rows = (await session.execute(actual_stmt)).all()
        actual_by_date: dict[date, int] = {}
        for s_date, qty in actual_rows:
            dt = _to_date(s_date)
            actual_by_date[dt] = actual_by_date.get(dt, 0) + int(qty)

        for dt in sorted(pred_by_date.keys()):
            if dt in actual_by_date:
                accuracy_series.append(
                    {
                        "date": dt.isoformat(),
                        "actualQty": actual_by_date[dt],
                        "predictedQty": round(pred_by_date[dt], 2),
                    }
                )
        accuracy_series = accuracy_series[-30:]

    # 5. Shape Order-This & Clear-This lists
    order_this = [
        {
            "productId": str(row.product_id),
            "forecastDate": _to_date(row.forecast_date).isoformat(),
            "horizonDays": int(row.horizon_days),
            "predictedQty": round(float(row.predicted_qty), 2),
            "lowerBound": round(float(row.lower_bound), 2),
            "upperBound": round(float(row.upper_bound), 2),
            "demandClass": row.demand_class,
            "modelUsed": row.model_used,
            "reorderQty": int(row.reorder_qty),
            "availableQty": available_by_product.get(row.product_id, 0),
        }
        for row in weekly_rows
    ]

    clear_this = []
    for rf in risk_rows:
        snap = batch_by_id.get(rf.batch_id)
        avail = max(0, int(snap.qty) - max(0, int(snap.reserved_qty))) if snap else 0
        clear_this.append(
            {
                "batchId": str(rf.batch_id),
                "productId": str(rf.product_id),
                "riskType": rf.risk_type,
                "daysOfCover": round(float(rf.days_of_cover), 2),
                "expectedUnsoldQty": int(rf.expected_unsold_qty),
                "recommendedAction": rf.recommended_action,
                "availableQty": avail,
                "expiryDate": _to_date(snap.expiry_date).isoformat() if snap else None,
                "flaggedAt": rf.flagged_at.isoformat() if rf.flagged_at else None,
            }
        )

    model_used = weekly_rows[0].model_used if weekly_rows else "none"
    fallback_active = model_used == "fallback"

    return {
        "shopId": str(shop_id),
        "generatedAt": datetime.now(UTC).isoformat(),
        "forecastDate": latest_date.isoformat() if latest_date else None,
        "modelUsed": model_used,
        "fallbackActive": fallback_active,
        "summary": {
            "orderThisCount": sum(1 for item in order_this if item["reorderQty"] > 0),
            "clearThisCount": len(clear_this),
            "totalReorderUnits": sum(item["reorderQty"] for item in order_this),
            "totalAtRiskUnits": sum(item["expectedUnsoldQty"] for item in clear_this),
        },
        "orderThis": order_this,
        "clearThis": clear_this,
        "accuracySeries": accuracy_series,
    }


async def run_nightly_batch(
    session_factory: async_sessionmaker[AsyncSession],
    *,
    redis_client: Any | None = None,
    artifact_dir: str | Path | None = None,
    as_of_date: date | None = None,
    shop_ids: list[uuid.UUID] | None = None,
    correlation_id: str | uuid.UUID | None = None,
    cache_ttl_seconds: int | None = None,
    chunk_size: int = 25,
) -> BatchRunSummary:
    """Execute the nightly demand forecast & batch risk computation across shops.

    1. Loads production model artifact (gracefully falling back to MovingAverage with
       model_used='fallback' if missing, corrupt, or stale).
    2. Computes strictly past-only 7-day demand forecasts (sale_date < as_of_date).
    3. Computes safety-stock reorder_qty and EXPIRY/DEAD_STOCK risk flags per batch.
    4. Atomically writes forecasts, batch_risk_flags, and forecast.batch.at_risk.v1
       outbox_events per shop chunk.
    5. Hydrates Redis cache-aside keys `forecast:shop:{shopId}` with TTL.
    """
    started = time.perf_counter()
    target_date = as_of_date or datetime.now(UTC).date()
    corr_uuid = _coerce_uuid(correlation_id)
    effective_artifact_dir = Path(artifact_dir or settings.model_artifact_dir)
    ttl = (
        cache_ttl_seconds if cache_ttl_seconds is not None else settings.forecast_cache_ttl_seconds
    )

    loaded = load_production_forecaster(
        effective_artifact_dir,
        max_age_days=settings.model_max_age_days,
    )
    metrics.set_fallback_active(loaded.is_fallback)

    # 1. Load historical sales (< target_date) and current batch snapshots
    async with session_factory() as read_session:
        sales_stmt = select(SalesHistoryReadModel).where(
            SalesHistoryReadModel.sale_date < target_date
        )
        batch_stmt = select(BatchSnapshotReadModel)
        if shop_ids:
            sales_stmt = sales_stmt.where(SalesHistoryReadModel.shop_id.in_(shop_ids))
            batch_stmt = batch_stmt.where(BatchSnapshotReadModel.shop_id.in_(shop_ids))

        sales_rows = list((await read_session.execute(sales_stmt)).scalars().all())
        batch_rows = list((await read_session.execute(batch_stmt)).scalars().all())

    all_shop_ids: list[uuid.UUID] = sorted(
        {r.shop_id for r in sales_rows} | {b.shop_id for b in batch_rows},
        key=str,
    )

    if not all_shop_ids:
        duration = time.perf_counter() - started
        metrics.record_batch_run(duration, 0)
        return BatchRunSummary(
            as_of_date=target_date,
            shops_processed=0,
            forecasts_written=0,
            risk_flags_written=0,
            outbox_events_queued=0,
            model_used=loaded.model_name,
            fallback_active=loaded.is_fallback,
            duration_seconds=round(duration, 4),
            cache_writes=0,
            cache_errors=0,
        )

    # 2. Build DataFrames and run ML forecasting + Syntetos-Boylan classification
    demand_class_map: dict[tuple[str, str], str] = {}
    daily_preds_by_series: dict[tuple[str, str], list[tuple[date, float]]] = {}
    hist_std_map: dict[tuple[str, str], float] = {}

    if sales_rows:
        sales_df = pd.DataFrame(
            [
                {
                    "shop_id": str(r.shop_id),
                    "product_id": str(r.product_id),
                    "sale_date": pd.Timestamp(_to_date(r.sale_date)),
                    "qty_sold": int(r.qty_sold),
                    "stockout_flag": bool(r.stockout_flag),
                }
                for r in sales_rows
            ]
        )

        # Historical per-series std for prediction intervals
        for (s_str, p_str), grp in sales_df.groupby(["shop_id", "product_id"]):
            hist_std_map[(str(s_str), str(p_str))] = float(
                np.std(grp["qty_sold"].to_numpy(dtype=float), ddof=0)
            )

        classified = classify_panel(sales_df, cutoff_date=target_date)
        for _, crow in classified.iterrows():
            demand_class_map[(str(crow["shop_id"]), str(crow["product_id"]))] = str(
                crow["demand_class"]
            )

        preds_df = loaded.model.predict(
            sales_df,
            horizon=FORECAST_HORIZON_DAYS,
            start_date=target_date,
        )
        for _, prow in preds_df.iterrows():
            key = (str(prow["shop_id"]), str(prow["product_id"]))
            daily_preds_by_series.setdefault(key, []).append(
                (_to_date(prow["forecast_date"]), max(0.0, float(prow["predicted_qty"])))
            )

    # 3. Group batches by shop and (shop, product)
    batches_by_shop: dict[uuid.UUID, list[BatchSnapshotReadModel]] = {}
    available_by_series: dict[tuple[str, str], int] = {}
    series_by_shop: dict[uuid.UUID, set[uuid.UUID]] = {sid: set() for sid in all_shop_ids}

    for r in sales_rows:
        series_by_shop[r.shop_id].add(r.product_id)

    for b in batch_rows:
        batches_by_shop.setdefault(b.shop_id, []).append(b)
        series_by_shop[b.shop_id].add(b.product_id)
        avail = max(0, int(b.qty) - max(0, int(b.reserved_qty)))
        key = (str(b.shop_id), str(b.product_id))
        available_by_series[key] = available_by_series.get(key, 0) + avail

    # 4. Persist forecasts, risk flags, and outbox events atomically per shop chunk
    forecasts_written = 0
    risk_flags_written = 0
    outbox_events_queued = 0

    for offset in range(0, len(all_shop_ids), chunk_size):
        shop_chunk = all_shop_ids[offset : offset + chunk_size]

        async with session_factory() as session:
            async with session.begin():
                bind = session.bind
                is_sqlite = bind is not None and bind.dialect.name == "sqlite"
                now_fn = "CURRENT_TIMESTAMP" if is_sqlite else "NOW()"

                forecast_params: list[dict[str, Any]] = []
                risk_results_chunk: list[BatchRiskResult] = []
                daily_demand_lookup: dict[tuple[str, str], float] = {}

                for sid in shop_chunk:
                    s_str = str(sid)
                    for pid in sorted(series_by_shop.get(sid, set()), key=str):
                        p_str = str(pid)
                        key = (s_str, p_str)

                        daily_list = daily_preds_by_series.get(key)
                        if not daily_list:
                            daily_list = [
                                (target_date + timedelta(days=step), 0.0)
                                for step in range(FORECAST_HORIZON_DAYS)
                            ]

                        pred_7d = round(sum(v for _, v in daily_list), 2)
                        daily_mean = pred_7d / float(FORECAST_HORIZON_DAYS)
                        daily_demand_lookup[key] = daily_mean

                        sigma_daily = max(
                            hist_std_map.get(key, 0.0),
                            math.sqrt(max(daily_mean, 0.25)),
                        )
                        sigma_7d = math.sqrt(FORECAST_HORIZON_DAYS) * sigma_daily
                        lower_7d = round(max(0.0, pred_7d - Z_SCORE_80_PCT * sigma_7d), 2)
                        upper_7d = round(pred_7d + Z_SCORE_80_PCT * sigma_7d, 2)

                        d_class = demand_class_map.get(key, "INTERMITTENT")
                        avail_qty = available_by_series.get(key, 0)
                        reorder_qty = compute_reorder_qty(
                            predicted_7d_qty=pred_7d,
                            upper_bound_7d_qty=upper_7d,
                            total_available_qty=avail_qty,
                        )

                        # Weekly aggregate row (horizon_days = 7)
                        forecast_params.append(
                            {
                                "id": str(uuid.uuid4()) if is_sqlite else uuid.uuid4(),
                                "shop_id": s_str if is_sqlite else sid,
                                "product_id": p_str if is_sqlite else pid,
                                "forecast_date": target_date,
                                "horizon_days": FORECAST_HORIZON_DAYS,
                                "predicted_qty": pred_7d if is_sqlite else Decimal(str(pred_7d)),
                                "lower_bound": lower_7d if is_sqlite else Decimal(str(lower_7d)),
                                "upper_bound": upper_7d if is_sqlite else Decimal(str(upper_7d)),
                                "demand_class": d_class,
                                "model_used": loaded.model_name,
                                "reorder_qty": reorder_qty,
                            }
                        )

                        # Daily point rows (horizon_days = 1) for predicted-vs-actual chart
                        for f_dt, d_val in daily_list:
                            d_low = round(max(0.0, d_val - Z_SCORE_80_PCT * sigma_daily), 2)
                            d_high = round(d_val + Z_SCORE_80_PCT * sigma_daily, 2)
                            forecast_params.append(
                                {
                                    "id": str(uuid.uuid4()) if is_sqlite else uuid.uuid4(),
                                    "shop_id": s_str if is_sqlite else sid,
                                    "product_id": p_str if is_sqlite else pid,
                                    "forecast_date": f_dt,
                                    "horizon_days": 1,
                                    "predicted_qty": (
                                        round(d_val, 2)
                                        if is_sqlite
                                        else Decimal(str(round(d_val, 2)))
                                    ),
                                    "lower_bound": d_low if is_sqlite else Decimal(str(d_low)),
                                    "upper_bound": d_high if is_sqlite else Decimal(str(d_high)),
                                    "demand_class": d_class,
                                    "model_used": loaded.model_name,
                                    "reorder_qty": 0,
                                }
                            )

                    # Evaluate every batch owned by this shop
                    for b in batches_by_shop.get(sid, []):
                        key = (str(b.shop_id), str(b.product_id))
                        flags = evaluate_batch_risks(
                            batch_id=str(b.batch_id),
                            shop_id=str(b.shop_id),
                            product_id=str(b.product_id),
                            qty=int(b.qty),
                            reserved_qty=int(b.reserved_qty),
                            expiry_date=_to_date(b.expiry_date),
                            forecast_daily_demand=daily_demand_lookup.get(key, 0.0),
                            as_of_date=target_date,
                        )
                        risk_results_chunk.extend(flags)

                if forecast_params:
                    upsert_forecast_sql = text(
                        f"""
                        INSERT INTO forecasts
                            (id, shop_id, product_id, forecast_date, horizon_days,
                             predicted_qty, lower_bound, upper_bound, demand_class,
                             model_used, reorder_qty, created_at)
                        VALUES
                            (:id, :shop_id, :product_id, :forecast_date, :horizon_days,
                             :predicted_qty, :lower_bound, :upper_bound, :demand_class,
                             :model_used, :reorder_qty, {now_fn})
                        ON CONFLICT (shop_id, product_id, forecast_date, horizon_days) DO UPDATE SET
                            predicted_qty = EXCLUDED.predicted_qty,
                            lower_bound = EXCLUDED.lower_bound,
                            upper_bound = EXCLUDED.upper_bound,
                            demand_class = EXCLUDED.demand_class,
                            model_used = EXCLUDED.model_used,
                            reorder_qty = EXCLUDED.reorder_qty,
                            created_at = {now_fn}
                        """
                    )
                    await session.execute(upsert_forecast_sql, forecast_params)
                    forecasts_written += len(forecast_params)

                # Clear stale risk flags for this shop chunk and upsert fresh flags + outbox
                await session.execute(
                    delete(BatchRiskFlag).where(BatchRiskFlag.shop_id.in_(shop_chunk))
                )

                if risk_results_chunk:
                    risk_params = [
                        {
                            "id": str(uuid.uuid4()) if is_sqlite else uuid.uuid4(),
                            "batch_id": (rf.batch_id if is_sqlite else uuid.UUID(rf.batch_id)),
                            "shop_id": rf.shop_id if is_sqlite else uuid.UUID(rf.shop_id),
                            "product_id": (
                                rf.product_id if is_sqlite else uuid.UUID(rf.product_id)
                            ),
                            "risk_type": rf.risk_type,
                            "days_of_cover": (
                                rf.days_of_cover if is_sqlite else Decimal(str(rf.days_of_cover))
                            ),
                            "expected_unsold_qty": rf.expected_unsold_qty,
                            "recommended_action": rf.recommended_action,
                        }
                        for rf in risk_results_chunk
                    ]
                    upsert_risk_sql = text(
                        f"""
                        INSERT INTO batch_risk_flags
                            (id, batch_id, shop_id, product_id, risk_type,
                             days_of_cover, expected_unsold_qty, recommended_action, flagged_at)
                        VALUES
                            (:id, :batch_id, :shop_id, :product_id, :risk_type,
                             :days_of_cover, :expected_unsold_qty, :recommended_action, {now_fn})
                        ON CONFLICT (batch_id, risk_type) DO UPDATE SET
                            days_of_cover = EXCLUDED.days_of_cover,
                            expected_unsold_qty = EXCLUDED.expected_unsold_qty,
                            recommended_action = EXCLUDED.recommended_action,
                            flagged_at = {now_fn}
                        """
                    )
                    await session.execute(upsert_risk_sql, risk_params)
                    risk_flags_written += len(risk_params)

                    # Atomic outbox event per flagged batch (ADR-003)
                    for rf in risk_results_chunk:
                        session.add(
                            OutboxEvent(
                                id=uuid.uuid4(),
                                aggregate_type="batch",
                                aggregate_id=uuid.UUID(rf.batch_id),
                                event_type="forecast.batch.at_risk.v1",
                                version=1,
                                correlation_id=corr_uuid,
                                producer="forecast-service",
                                payload={
                                    "batchId": rf.batch_id,
                                    "shopId": rf.shop_id,
                                    "productId": rf.product_id,
                                    "riskType": rf.risk_type,
                                    "daysOfCover": rf.days_of_cover,
                                    "expectedUnsoldQty": rf.expected_unsold_qty,
                                    "recommendedAction": rf.recommended_action,
                                    "asOfDate": target_date.isoformat(),
                                },
                            )
                        )
                    outbox_events_queued += len(risk_results_chunk)

    # 5. Hydrate Redis cache-aside keys post-commit (degrade silently if Redis is down)
    cache_writes = 0
    cache_errors = 0
    if redis_client is not None:
        async with session_factory() as cache_session:
            for sid in all_shop_ids:
                payload = await build_shop_forecast_payload(cache_session, sid)
                try:
                    await redis_client.set(
                        cache_key_for_shop(sid),
                        json.dumps(payload),
                        ex=ttl,
                    )
                    cache_writes += 1
                except Exception as exc:
                    cache_errors += 1
                    logger.warning(
                        "Failed to hydrate Redis forecast cache",
                        shop_id=str(sid),
                        error=str(exc),
                    )

    duration = time.perf_counter() - started
    metrics.record_batch_run(duration, risk_flags_written)
    logger.info(
        "Nightly forecast batch completed",
        shops=len(all_shop_ids),
        forecasts=forecasts_written,
        risk_flags=risk_flags_written,
        outbox_events=outbox_events_queued,
        model_used=loaded.model_name,
        duration_seconds=round(duration, 4),
    )

    return BatchRunSummary(
        as_of_date=target_date,
        shops_processed=len(all_shop_ids),
        forecasts_written=forecasts_written,
        risk_flags_written=risk_flags_written,
        outbox_events_queued=outbox_events_queued,
        model_used=loaded.model_name,
        fallback_active=loaded.is_fallback,
        duration_seconds=round(duration, 4),
        cache_writes=cache_writes,
        cache_errors=cache_errors,
    )
