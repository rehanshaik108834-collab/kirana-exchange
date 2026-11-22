import math
from dataclasses import dataclass
from datetime import date, timedelta

import numpy as np
import pandas as pd

from .calendar_signals import festival_multiplier, weather_multiplier
from .config import SimulatorConfig

DOMAIN_HUB = 1
DOMAIN_SHOP = 2
DOMAIN_DEMAND = 3
DOMAIN_CATALOG = 4

SHOP_SIZE_TIERS = ("SMALL", "MEDIUM", "LARGE")
SHOP_SIZE_WEIGHTS = (0.45, 0.40, 0.15)
SHOP_SIZE_MULTIPLIER = {"SMALL": 0.65, "MEDIUM": 1.0, "LARGE": 1.75}

SKU_CATEGORIES = (
    "Staples",
    "Snacks",
    "Beverages",
    "Dairy",
    "Instant Food",
    "Personal Care",
    "Home Care",
)

CATEGORY_BASE_MRP_RANGE: dict[str, tuple[float, float]] = {
    "Staples": (30.0, 180.0),
    "Snacks": (10.0, 70.0),
    "Beverages": (15.0, 95.0),
    "Dairy": (25.0, 85.0),
    "Instant Food": (12.0, 80.0),
    "Personal Care": (35.0, 220.0),
    "Home Care": (40.0, 260.0),
}

CATEGORY_SHELF_LIFE_DAYS: dict[str, tuple[int, int]] = {
    "Dairy": (7, 30),
    "Staples": (180, 365),
    "Snacks": (90, 180),
    "Beverages": (120, 270),
    "Instant Food": (180, 270),
    "Personal Care": (360, 720),
    "Home Care": (360, 720),
}


def stream_rng(root_seed: int, domain: int, *ids: int) -> np.random.Generator:
    """Spawn a deterministic, isolated PCG64 RNG stream."""
    return np.random.default_rng(np.random.SeedSequence([root_seed, domain, *ids]))


def calculate_ean13_check_digit(first_12_digits: str) -> str:
    """Calculate the standard mod-10 check digit for a 12-digit EAN prefix."""
    total = 0
    for i, char in enumerate(first_12_digits):
        weight = 1 if i % 2 == 0 else 3
        total += int(char) * weight
    remainder = total % 10
    check_digit = (10 - remainder) % 10
    return str(check_digit)


@dataclass(frozen=True)
class SimulatedDataset:
    shops: pd.DataFrame
    products: pd.DataFrame
    initial_batches: pd.DataFrame
    daily_sales: pd.DataFrame


def generate_shops(cfg: SimulatorConfig) -> pd.DataFrame:
    """Generate neighbourhood-clustered shops inside `cfg.city_center.radius_km`.

    INVARIANT:
    1. Generate `cluster_count` hub centers inside 0.75 * radius_km using
       stream_rng(seed, DOMAIN_HUB, hub_idx).
    2. For each shop_idx in 0..shop_count-1, use stream_rng(seed, DOMAIN_SHOP, shop_idx):
       - Assign hub_idx = shop_idx % cluster_count.
       - Draw Gaussian offset (sigma = 0.18 * radius_km) around the hub.
       - Convert km offsets to degrees:
           lat_deg = dy / 111.32
           lng_deg = dx / (111.32 * cos(radians(center_lat)))
       - Clamp final distance from city_center strictly <= radius_km.
       - Sample size_tier, gst_scheme, swap_acceptance_prob, and price_sensitivity.
    3. Return DataFrame with columns:
       [shop_idx, shop_code, name, state, lat, lng, cluster_id, size_tier,
        gst_scheme, swap_acceptance_prob, price_sensitivity].
    """
    center_lat = cfg.city_center.lat
    center_lng = cfg.city_center.lng
    radius_km = cfg.city_center.radius_km
    cluster_count = cfg.city_center.cluster_count

    # 1. Generate well-separated hub centers inside 0.75 * radius_km
    hub_coords: list[tuple[float, float]] = []
    for hub_idx in range(cluster_count):
        rng_hub = stream_rng(cfg.seed, DOMAIN_HUB, hub_idx)
        base_angle = (2.0 * math.pi * hub_idx) / cluster_count
        angle = base_angle + rng_hub.uniform(-0.15, 0.15)
        r = rng_hub.uniform(0.35 * radius_km, 0.70 * radius_km)
        hub_dx = r * math.cos(angle)
        hub_dy = r * math.sin(angle)
        hub_coords.append((hub_dx, hub_dy))

    lat_cos = math.cos(math.radians(center_lat))

    gst_schemes = list(cfg.behaviour.gst_scheme_weights.keys())
    gst_weights = [cfg.behaviour.gst_scheme_weights[k] for k in gst_schemes]
    gst_weights_norm = [w / sum(gst_weights) for w in gst_weights]

    shops_data: list[dict] = []
    for shop_idx in range(cfg.shop_count):
        rng_shop = stream_rng(cfg.seed, DOMAIN_SHOP, shop_idx)
        cluster_id = shop_idx % cluster_count
        hub_dx, hub_dy = hub_coords[cluster_id]

        sigma = 0.18 * radius_km
        offset_dx = float(rng_shop.normal(0.0, sigma))
        offset_dy = float(rng_shop.normal(0.0, sigma))

        total_dx = hub_dx + offset_dx
        total_dy = hub_dy + offset_dy

        # Clamp strictly within radius_km
        dist_from_center = math.hypot(total_dx, total_dy)
        if dist_from_center > radius_km:
            scale = (radius_km * 0.98) / dist_from_center
            total_dx *= scale
            total_dy *= scale

        lat = center_lat + (total_dy / 111.32)
        lng = center_lng + (total_dx / (111.32 * lat_cos))

        size_tier = str(rng_shop.choice(list(SHOP_SIZE_TIERS), p=list(SHOP_SIZE_WEIGHTS)))
        gst_scheme = str(rng_shop.choice(gst_schemes, p=gst_weights_norm))
        swap_prob = float(
            np.clip(rng_shop.normal(cfg.behaviour.swap_acceptance_prob, 0.08), 0.05, 0.95)
        )
        price_sens = float(
            np.clip(rng_shop.normal(cfg.behaviour.price_sensitivity, 0.08), 0.05, 0.95)
        )

        shop_code = f"SHP{shop_idx:04d}"
        shops_data.append(
            {
                "shop_idx": shop_idx,
                "shop_code": shop_code,
                "name": f"Kirana Store {shop_code}",
                "state": cfg.city_center.state,
                "lat": round(lat, 6),
                "lng": round(lng, 6),
                "cluster_id": cluster_id,
                "size_tier": size_tier,
                "gst_scheme": gst_scheme,
                "swap_acceptance_prob": round(swap_prob, 4),
                "price_sensitivity": round(price_sens, 4),
            }
        )

    return pd.DataFrame(shops_data)


def generate_synthetic_skus(cfg: SimulatorConfig) -> pd.DataFrame:
    """Create a deterministic product pool (at least max(cfg.skus_per_shop, 60) SKUs)

    with synthetic EAN-13 codes, category, mrp, cost_price (72%-88% of mrp),
    shelf_life_days, and velocity_tier ('FAST' vs 'SLOW' per cfg.demand.slow_mover_share).
    """
    sku_count = max(cfg.skus_per_shop, 60)
    products_data: list[dict] = []

    for product_idx in range(sku_count):
        rng_prod = stream_rng(cfg.seed, DOMAIN_CATALOG, product_idx)
        category = SKU_CATEGORIES[product_idx % len(SKU_CATEGORIES)]

        # Velocity tier
        is_slow = bool(rng_prod.uniform(0.0, 1.0) < cfg.demand.slow_mover_share)
        velocity_tier = "SLOW" if is_slow else "FAST"

        # MRP and cost price
        mrp_min, mrp_max = CATEGORY_BASE_MRP_RANGE[category]
        mrp = round(float(rng_prod.uniform(mrp_min, mrp_max)), 2)
        cost_ratio = float(rng_prod.uniform(0.72, 0.88))
        cost_price = round(mrp * cost_ratio, 2)

        # Shelf life
        life_min, life_max = CATEGORY_SHELF_LIFE_DAYS[category]
        shelf_life_days = int(rng_prod.integers(life_min, life_max + 1))

        # EAN-13: 890 (India prefix) + 9-digit SKU id + check digit
        body_digits = f"890{product_idx:09d}"
        check_digit = calculate_ean13_check_digit(body_digits)
        ean = f"{body_digits}{check_digit}"

        brand_letter = chr(65 + (product_idx % 26))
        brand = f"Brand {brand_letter}"
        name = f"{category} {brand_letter}-{product_idx:03d}"

        products_data.append(
            {
                "product_idx": product_idx,
                "ean": ean,
                "name": name,
                "brand": brand,
                "category": category,
                "mrp": mrp,
                "cost_price": cost_price,
                "shelf_life_days": shelf_life_days,
                "velocity_tier": velocity_tier,
                "is_slow_mover": is_slow,
            }
        )

    return pd.DataFrame(products_data)


def generate_daily_series(
    cfg: SimulatorConfig,
    shop_idx: int,
    shop_size_tier: str,
    product_idx: int,
    category: str,
    is_slow_mover: bool,
    cost_price: float,
    shelf_life_days: int,
) -> tuple[dict, list[dict]]:
    """Simulate 7-layer daily demand + inventory replenishment for one (shop, product) pair.

    Uses isolated rng = stream_rng(cfg.seed, DOMAIN_DEMAND, shop_idx, product_idx).

    THE 7 LAYERS:
    1. Base rate:
       - Fast mover: rng.uniform(1.8, 7.0) * SHOP_SIZE_MULTIPLIER[shop_size_tier]
       - Slow mover: rng.uniform(0.8, 2.5) * SHOP_SIZE_MULTIPLIER[shop_size_tier]
    2. Weekly pattern:
       - Apply cfg.demand.weekend_uplift on Friday (4), Saturday (5), Sunday (6).
    3. Indian festival & seasonal weather uplift:
       - Multiply by festival_multiplier(day, cfg.demand.festival_uplift)
         * weather_multiplier(day, category, cfg.demand.weather_seasonality_strength).
    4. Gradual trend:
       - Draw annual_slope ~ Normal(0, cfg.demand.annual_trend_std), clipped to [-0.35, 0.35].
       - Apply max(0.2, 1.0 + annual_slope * (day_idx / 365.0)).
    5. Intermittency (slow movers only):
       - With probability cfg.demand.slow_mover_zero_prob, true_demand = 0.
       - Otherwise draw from Poisson(mu) (minimum 1 if burst occurs).
    6. Noise + Stockout & Replenishment State Machine:
       - Start with initial_stock = int(max(4, round(expected_daily_demand * rng.uniform(3, 7)))).
       - Maintain on_hand and a pending delivery (arrival_day, order_qty).
       - On each day:
         a) Receive pending delivery if arrival_day == day_idx.
         b) Draw true_demand.
         c) recorded_sales = min(true_demand, on_hand).
         d) stockout_flag = (on_hand == 0) or (true_demand > on_hand).
         e) on_hand -= recorded_sales.
         f) If no pending delivery and on_hand <= expected_daily_demand * reorder_point_days:
            schedule delivery for day_idx + reorder_lead_time_days (with 16% delay +2 days).
    7. Product lifecycle:
       - ~10% of series launch mid-window (active after launch_day with 14-day linear ramp).
       - ~5% of series fade out after fade_day (linear decay to 0 over 21 days).

    Returns:
      - initial_batch_record: dict
      - daily_rows: list of dicts
    """
    rng = stream_rng(cfg.seed, DOMAIN_DEMAND, shop_idx, product_idx)
    size_mult = SHOP_SIZE_MULTIPLIER.get(shop_size_tier, 1.0)

    # Layer 1: Base rate
    if is_slow_mover:
        base_rate = float(rng.uniform(0.8, 2.5)) * size_mult
    else:
        base_rate = float(rng.uniform(1.8, 7.0)) * size_mult

    # Layer 4: Trend parameter
    annual_slope = float(np.clip(rng.normal(0.0, cfg.demand.annual_trend_std), -0.35, 0.35))

    # Layer 7: Product lifecycle roll
    lifecycle_roll = float(rng.uniform(0.0, 1.0))
    is_new_launch = lifecycle_roll < 0.10
    is_fade_out = 0.10 <= lifecycle_roll < 0.15

    launch_day = int(rng.uniform(15, max(16, cfg.days - 30))) if is_new_launch else 0
    fade_day = int(rng.uniform(30, max(31, cfg.days - 15))) if is_fade_out else cfg.days + 1

    # Layer 6: Expected demand for inventory calibration
    if is_slow_mover:
        expected_daily_demand = base_rate * (1.0 - cfg.demand.slow_mover_zero_prob)
    else:
        expected_daily_demand = base_rate

    initial_stock = int(max(4, round(expected_daily_demand * float(rng.uniform(3.0, 7.0)))))
    on_hand = initial_stock

    expiry_date = cfg.start_date + timedelta(days=shelf_life_days)
    initial_batch_record = {
        "shop_idx": shop_idx,
        "product_idx": product_idx,
        "initial_qty": initial_stock,
        "cost_price": cost_price,
        "expiry_date": expiry_date,
    }

    pending_arrival_day = -1
    pending_qty = 0

    daily_rows: list[dict] = []

    for day_idx in range(cfg.days):
        current_date = cfg.start_date + timedelta(days=day_idx)

        # 6a: Replenishment arrival
        if pending_arrival_day == day_idx:
            on_hand += pending_qty
            pending_arrival_day = -1
            pending_qty = 0

        # Layer 7: Lifecycle multiplier
        lifecycle_mult = 1.0
        if is_new_launch:
            if day_idx < launch_day:
                lifecycle_mult = 0.0
            elif day_idx < launch_day + 14:
                lifecycle_mult = (day_idx - launch_day + 1) / 14.0
        elif is_fade_out:
            if day_idx >= fade_day + 21:
                lifecycle_mult = 0.0
            elif day_idx >= fade_day:
                lifecycle_mult = max(0.0, 1.0 - (day_idx - fade_day + 1) / 21.0)

        # Calendar attributes
        is_weekend = current_date.weekday() in (4, 5, 6)
        fest_mult, is_festival = festival_multiplier(current_date, cfg.demand.festival_uplift)

        if lifecycle_mult <= 0.0:
            true_demand = 0
        else:
            # Layer 2: Weekly pattern
            wknd_mult = cfg.demand.weekend_uplift if is_weekend else 1.0

            # Layer 3: Seasonal weather
            wthr_mult = weather_multiplier(
                current_date, category, cfg.demand.weather_seasonality_strength
            )

            # Layer 4: Trend
            trend_mult = max(0.2, 1.0 + annual_slope * (day_idx / 365.0))

            # Effective rate
            daily_rate = base_rate * wknd_mult * fest_mult * wthr_mult * trend_mult * lifecycle_mult

            # Layer 5: Intermittency
            if is_slow_mover:
                if rng.uniform(0.0, 1.0) < cfg.demand.slow_mover_zero_prob:
                    true_demand = 0
                else:
                    burst_demand = int(rng.poisson(daily_rate))
                    true_demand = max(1, burst_demand)
            else:
                true_demand = int(rng.poisson(daily_rate))

        # 6c: Recorded sales
        recorded_sales = min(true_demand, on_hand)

        # 6d: Stockout flag
        stockout_flag = bool((on_hand == 0) or (true_demand > on_hand))

        # 6e: Update on-hand inventory
        on_hand_end = on_hand - recorded_sales
        on_hand = on_hand_end

        # 6f: Reorder decision
        reorder_point = max(1.5, expected_daily_demand * (cfg.demand.reorder_point_days * 0.75))
        if pending_arrival_day == -1 and on_hand <= reorder_point:
            # 16% distributor delay (+2 days)
            distributor_delay = 2 if rng.uniform(0.0, 1.0) < 0.16 else 0
            lead_time = cfg.demand.reorder_lead_time_days + distributor_delay
            pending_arrival_day = day_idx + lead_time
            order_qty = int(max(6, round(expected_daily_demand * float(rng.uniform(4.0, 8.0)))))
            pending_qty = order_qty

        daily_rows.append(
            {
                "date": current_date,
                "shop_idx": shop_idx,
                "product_idx": product_idx,
                "true_demand": true_demand,
                "recorded_sales": recorded_sales,
                "on_hand_end": on_hand_end,
                "stockout_flag": stockout_flag,
                "is_festival": is_festival,
                "is_weekend": is_weekend,
                "is_slow_mover": is_slow_mover,
            }
        )

    return initial_batch_record, daily_rows


def run_simulation(cfg: SimulatorConfig) -> SimulatedDataset:
    """Orchestrate shop, SKU, initial batch, and 7-layer daily sales generation.

    Uses high-performance columnar lists to ensure preset_500 (4.5M rows)
    remains fast and memory-safe.
    """
    # 1. Generate shops & SKUs
    shops_df = generate_shops(cfg)
    products_df = generate_synthetic_skus(cfg)

    # 2. Extract SKU metadata for fast lookup
    skus_to_simulate = products_df.head(cfg.skus_per_shop)
    product_records = skus_to_simulate.to_dict(orient="records")
    shop_records = shops_df.to_dict(orient="records")

    initial_batches_list: list[dict] = []

    # Columnar accumulator for daily sales
    col_date: list[date] = []
    col_shop_idx: list[int] = []
    col_product_idx: list[int] = []
    col_true_demand: list[int] = []
    col_recorded_sales: list[int] = []
    col_on_hand_end: list[int] = []
    col_stockout_flag: list[bool] = []
    col_is_festival: list[bool] = []
    col_is_weekend: list[bool] = []
    col_is_slow_mover: list[bool] = []

    for shop in shop_records:
        s_idx = shop["shop_idx"]
        s_tier = shop["size_tier"]

        for prod in product_records:
            p_idx = prod["product_idx"]
            p_cat = prod["category"]
            p_slow = prod["is_slow_mover"]
            p_cost = prod["cost_price"]
            p_shelf = prod["shelf_life_days"]

            init_batch, series_rows = generate_daily_series(
                cfg=cfg,
                shop_idx=s_idx,
                shop_size_tier=s_tier,
                product_idx=p_idx,
                category=p_cat,
                is_slow_mover=p_slow,
                cost_price=p_cost,
                shelf_life_days=p_shelf,
            )

            initial_batches_list.append(init_batch)

            for row in series_rows:
                col_date.append(row["date"])
                col_shop_idx.append(row["shop_idx"])
                col_product_idx.append(row["product_idx"])
                col_true_demand.append(row["true_demand"])
                col_recorded_sales.append(row["recorded_sales"])
                col_on_hand_end.append(row["on_hand_end"])
                col_stockout_flag.append(row["stockout_flag"])
                col_is_festival.append(row["is_festival"])
                col_is_weekend.append(row["is_weekend"])
                col_is_slow_mover.append(row["is_slow_mover"])

    daily_sales_df = pd.DataFrame(
        {
            "date": col_date,
            "shop_idx": col_shop_idx,
            "product_idx": col_product_idx,
            "true_demand": col_true_demand,
            "recorded_sales": col_recorded_sales,
            "on_hand_end": col_on_hand_end,
            "stockout_flag": col_stockout_flag,
            "is_festival": col_is_festival,
            "is_weekend": col_is_weekend,
            "is_slow_mover": col_is_slow_mover,
        }
    )

    initial_batches_df = pd.DataFrame(initial_batches_list)

    return SimulatedDataset(
        shops=shops_df,
        products=products_df,
        initial_batches=initial_batches_df,
        daily_sales=daily_sales_df,
    )
