import json
from pathlib import Path

import numpy as np
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq

from .exporter import sha256_file


def load_active_holiday_dates(holidays_csv: Path) -> set[pd.Timestamp]:
    """Parse Favorita `holidays_events.csv` and return actual celebrated holiday dates.

    INVARIANT:
    - Exclude rows where `transferred == True` (holiday moved to another date).
    - Exclude rows where `type == 'Work Day'` (make-up working Saturday, not a holiday).
    - Include `type in {'Holiday', 'Transfer', 'Additional', 'Bridge', 'Event'}`.
    """
    df = pd.read_csv(holidays_csv)

    # Normalize transferred column to boolean
    if "transferred" in df.columns:
        transferred = df["transferred"].astype(str).str.lower().isin(["true", "1"])
    else:
        transferred = pd.Series(False, index=df.index)

    holiday_types = {"Holiday", "Transfer", "Additional", "Bridge", "Event"}
    if "type" in df.columns:
        valid_type = df["type"].isin(holiday_types)
    else:
        valid_type = pd.Series(True, index=df.index)

    active_mask = (~transferred) & valid_type
    active_dates = pd.to_datetime(df.loc[active_mask, "date"]).dt.normalize()
    return set(active_dates)


def sample_favorita_benchmark(
    train_csv: Path,
    output_dir: Path,
    *,
    holidays_csv: Path | None = None,
    max_series: int = 50,
    min_days: int = 180,
    seed: int = 42,
) -> dict:
    """Deterministically sample a stratified slice of Kaggle Store Sales / Favorita `train.csv`

    into Phase 8's canonical backtest Parquet schema:
      [date, shop_id, sku_id, recorded_sales, onpromotion, is_festival, stockout_flag]
    """
    out = Path(output_dir)
    out.mkdir(parents=True, exist_ok=True)

    df_train = pd.read_csv(train_csv)

    # 1. Detect schema columns
    store_col = "store_nbr"
    if "family" in df_train.columns:
        sku_col = "family"
    elif "item_nbr" in df_train.columns:
        sku_col = "item_nbr"
    else:
        raise ValueError(f"Could not identify SKU column in {df_train.columns}")

    if "sales" in df_train.columns:
        sales_col = "sales"
    elif "unit_sales" in df_train.columns:
        sales_col = "unit_sales"
    else:
        raise ValueError(f"Could not identify sales column in {df_train.columns}")

    promo_col = "onpromotion" if "onpromotion" in df_train.columns else None

    # 2. Normalize types and clip returns
    df_train["date"] = pd.to_datetime(df_train["date"]).dt.normalize()
    df_train["shop_id"] = df_train[store_col].astype(str)
    df_train["sku_id"] = df_train[sku_col].astype(str)
    df_train["recorded_sales"] = (
        pd.to_numeric(df_train[sales_col], errors="coerce").fillna(0.0).clip(lower=0.0)
    )

    if promo_col:
        df_train["onpromotion"] = (
            pd.to_numeric(df_train[promo_col], errors="coerce").fillna(0).astype(int)
        )
    else:
        df_train["onpromotion"] = 0

    # 3. Identify qualified series having span >= min_days
    grouped = df_train.groupby(["shop_id", "sku_id"])["date"]
    series_spans = grouped.agg(["min", "max", "count"]).reset_index()
    series_spans["span_days"] = (series_spans["max"] - series_spans["min"]).dt.days + 1

    qualified = series_spans[series_spans["span_days"] >= min_days]
    if len(qualified) == 0:
        qualified = series_spans

    rng = np.random.default_rng(seed)
    if len(qualified) > max_series:
        chosen_indices = rng.choice(len(qualified), size=max_series, replace=False)
        sampled_series = qualified.iloc[chosen_indices][["shop_id", "sku_id"]]
    else:
        sampled_series = qualified[["shop_id", "sku_id"]]

    # 4. Filter to sampled series and build full date grid
    filtered = df_train.merge(sampled_series, on=["shop_id", "sku_id"], how="inner")

    active_holidays: set[pd.Timestamp] = set()
    if holidays_csv and Path(holidays_csv).exists():
        active_holidays = load_active_holiday_dates(Path(holidays_csv))

    grid_records: list[dict] = []
    for (s_id, p_id), group in filtered.groupby(["shop_id", "sku_id"]):
        s_min = group["date"].min()
        s_max = group["date"].max()
        full_dates = pd.date_range(s_min, s_max, freq="D").normalize()

        existing = group.set_index("date")

        for d in full_dates:
            if d in existing.index:
                row = existing.loc[d]
                if isinstance(row, pd.DataFrame):
                    rec_sales = float(row["recorded_sales"].sum())
                    promo = int(row["onpromotion"].max())
                else:
                    rec_sales = float(row["recorded_sales"])
                    promo = int(row["onpromotion"])
            else:
                rec_sales = 0.0
                promo = 0

            is_fest = d in active_holidays
            stockout = bool(promo > 0 and rec_sales == 0.0)

            grid_records.append(
                {
                    "date": d.date(),
                    "shop_id": str(s_id),
                    "sku_id": str(p_id),
                    "recorded_sales": float(rec_sales),
                    "onpromotion": int(promo),
                    "is_festival": is_fest,
                    "stockout_flag": stockout,
                }
            )

    out_df = pd.DataFrame(grid_records)
    out_df = out_df.sort_values(by=["shop_id", "sku_id", "date"]).reset_index(drop=True)

    # 5. Write Parquet deterministically
    parquet_path = out / "favorita_sample.parquet"
    table = pa.Table.from_pandas(out_df, preserve_index=False)
    pq.write_table(
        table,
        parquet_path,
        version="2.6",
        compression="snappy",
        use_dictionary=True,
    )

    out_sha = sha256_file(parquet_path)
    train_sha = sha256_file(train_csv)
    has_holidays = holidays_csv and Path(holidays_csv).exists()
    holidays_sha = sha256_file(holidays_csv) if has_holidays else None

    manifest = {
        "source_train_csv": str(train_csv.name),
        "source_train_sha256": train_sha,
        "source_holidays_csv": str(holidays_csv.name) if holidays_csv else None,
        "source_holidays_sha256": holidays_sha,
        "sample_filename": parquet_path.name,
        "sample_sha256": out_sha,
        "seed": seed,
        "series_count": len(sampled_series),
        "row_count": len(out_df),
        "min_date": str(out_df["date"].min()) if len(out_df) > 0 else None,
        "max_date": str(out_df["date"].max()) if len(out_df) > 0 else None,
    }

    manifest_path = out / "benchmark_manifest.json"
    manifest_str = json.dumps(manifest, indent=2, sort_keys=True) + "\n"
    manifest_path.write_text(manifest_str, encoding="utf-8")

    return manifest
