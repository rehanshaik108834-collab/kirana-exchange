import math
from pathlib import Path

from simulator.config import SimulatorConfig, load_config
from simulator.generator import run_simulation

CONFIGS_DIR = Path(__file__).resolve().parent.parent / "configs"


def haversine_distance_km(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    """Compute approximate distance in km using equirectangular projection."""
    dy = (lat1 - lat2) * 111.32
    mean_lat_rad = math.radians((lat1 + lat2) / 2.0)
    dx = (lng1 - lng2) * 111.32 * math.cos(mean_lat_rad)
    return math.hypot(dx, dy)


def test_1_bit_identical_reproducibility():
    """Test 1: Running run_simulation(cfg) twice with seed=42 yields DataFrame.equals() == True."""
    cfg = load_config(CONFIGS_DIR / "preset_10.yaml")

    sim1 = run_simulation(cfg)
    sim2 = run_simulation(cfg)

    assert sim1.shops.equals(sim2.shops), "shops DataFrame must be bit-identical"
    assert sim1.products.equals(sim2.products), "products DataFrame must be bit-identical"
    assert sim1.initial_batches.equals(sim2.initial_batches), (
        "initial_batches DataFrame must be bit-identical"
    )
    assert sim1.daily_sales.equals(sim2.daily_sales), "daily_sales DataFrame must be bit-identical"


def test_2_prefix_stream_isolation():
    """Test 2: shop_count=10 vs 20 with identical seed produces identical rows for shop_idx < 10."""
    cfg10 = load_config(CONFIGS_DIR / "preset_10.yaml")
    cfg20_dict = cfg10.model_dump()
    cfg20_dict["shop_count"] = 20
    cfg20 = SimulatorConfig.model_validate(cfg20_dict)

    sim10 = run_simulation(cfg10)
    sim20 = run_simulation(cfg20)

    # Filter sim20 for shop_idx < 10
    sales20_sub = sim20.daily_sales[sim20.daily_sales["shop_idx"] < 10].reset_index(drop=True)
    sales10 = sim10.daily_sales.reset_index(drop=True)

    assert sales10.equals(sales20_sub), (
        "Adding shops must not change the daily_sales of existing shops (prefix stream isolation)"
    )

    shops20_sub = sim20.shops[sim20.shops["shop_idx"] < 10].reset_index(drop=True)
    assert sim10.shops.reset_index(drop=True).equals(shops20_sub), (
        "Adding shops must not change the profiles of existing shops"
    )


def test_3_neighbourhood_clustering_and_radius_bound():
    """Test 3: Shops lie within radius_km, and mean intra-cluster < inter-cluster distance."""
    cfg = load_config(CONFIGS_DIR / "preset_10.yaml")
    sim = run_simulation(cfg)
    shops = sim.shops

    c_lat = cfg.city_center.lat
    c_lng = cfg.city_center.lng
    radius_km = cfg.city_center.radius_km

    # 1. Check all shops within radius_km
    for _, shop in shops.iterrows():
        dist = haversine_distance_km(c_lat, c_lng, shop["lat"], shop["lng"])
        assert dist <= radius_km + 1e-4, (
            f"Shop {shop['shop_idx']} dist {dist} km exceeds radius {radius_km} km"
        )

    # 2. Intra-cluster vs Inter-cluster distance
    intra_distances: list[float] = []
    inter_distances: list[float] = []

    shop_list = shops.to_dict(orient="records")
    for i in range(len(shop_list)):
        for j in range(i + 1, len(shop_list)):
            s1 = shop_list[i]
            s2 = shop_list[j]
            d = haversine_distance_km(s1["lat"], s1["lng"], s2["lat"], s2["lng"])
            if s1["cluster_id"] == s2["cluster_id"]:
                intra_distances.append(d)
            else:
                inter_distances.append(d)

    assert len(intra_distances) > 0, "Must have intra-cluster pairs"
    assert len(inter_distances) > 0, "Must have inter-cluster pairs"

    mean_intra = sum(intra_distances) / len(intra_distances)
    mean_inter = sum(inter_distances) / len(inter_distances)

    assert mean_intra < mean_inter, (
        f"Mean intra-cluster distance ({mean_intra:.2f} km) must be smaller than "
        f"mean inter-cluster distance ({mean_inter:.2f} km)"
    )


def test_4_weekend_and_festival_uplift():
    """Test 4: Mean recorded_sales weekends > weekdays, and festivals > non-festival days."""
    cfg = load_config(CONFIGS_DIR / "preset_10.yaml")
    sim = run_simulation(cfg)
    df = sim.daily_sales

    # Weekend vs Weekday
    mean_weekend = df[df["is_weekend"]]["recorded_sales"].mean()
    mean_weekday = df[~df["is_weekend"]]["recorded_sales"].mean()
    assert mean_weekend > mean_weekday, (
        f"Weekend sales ({mean_weekend:.3f}) must be higher than weekday sales ({mean_weekday:.3f})"
    )

    # Festival vs Non-Festival
    mean_festival = df[df["is_festival"]]["recorded_sales"].mean()
    mean_non_fest = df[~df["is_festival"]]["recorded_sales"].mean()
    assert mean_festival > mean_non_fest, (
        f"Festival sales ({mean_festival:.3f}) must be higher than non-fest ({mean_non_fest:.3f})"
    )


def test_5_slow_mover_intermittency():
    """Test 5: Slow-mover SKUs have a zero-sales day share near slow_mover_zero_prob (>= 0.65)."""
    cfg = load_config(CONFIGS_DIR / "preset_10.yaml")
    sim = run_simulation(cfg)
    df = sim.daily_sales

    slow_df = df[df["is_slow_mover"]]
    assert len(slow_df) > 0, "Must have slow mover records"

    zero_share = (slow_df["recorded_sales"] == 0).mean()
    assert zero_share >= 0.65, f"Slow mover zero-sales share ({zero_share:.3f}) should be >= 0.65"


def test_6_stockout_integrity():
    """Test 6: recorded_sales <= true_demand, on_hand_end >= 0, realistic stockout rate occurs."""
    cfg = load_config(CONFIGS_DIR / "preset_10.yaml")
    sim = run_simulation(cfg)
    df = sim.daily_sales

    # 1. recorded_sales <= true_demand everywhere
    assert (df["recorded_sales"] <= df["true_demand"]).all(), (
        "recorded_sales must never exceed true_demand"
    )

    # 2. on_hand_end >= 0 everywhere
    assert (df["on_hand_end"] >= 0).all(), "on_hand_end must never be negative"

    # 3. stockouts occur (> 0 rows)
    stockout_count = df["stockout_flag"].sum()
    assert stockout_count > 0, "Stockouts must occur in the simulation"

    # Stockout rate between 2% and 15% (naturally calibrates around 3% - 8%)
    stockout_rate = stockout_count / len(df)
    assert 0.02 <= stockout_rate <= 0.15, (
        f"Realistic stockout rate expected between 2% and 15%, got {stockout_rate:.3%}"
    )

    # 4. Every row where on_hand_end == 0 with unmet demand has stockout_flag == True
    unmet_zero_stock = df[(df["on_hand_end"] == 0) & (df["true_demand"] > df["recorded_sales"])]
    if len(unmet_zero_stock) > 0:
        assert unmet_zero_stock["stockout_flag"].all(), (
            "Every row with on_hand_end == 0 and unmet demand must have stockout_flag == True"
        )
