"""Deterministic min-cost bipartite matching solver using scipy.optimize.linear_sum_assignment.

Enforces strict same-state GST boundaries, radius caps, price ceilings, and expiry
validity before solving optimal one-to-one assignments within each (state, product_id)
sub-problem.
"""

import math
from collections import defaultdict
from datetime import UTC, date, datetime

import numpy as np
from scipy.optimize import linear_sum_assignment

from .models import ListingItem, MatchAssignment, ShortageItem

EARTH_RADIUS_KM: float = 6371.0088
INFEASIBLE_COST: float = 1e9

# Composite cost weights (sum = 1.00)
W_DISTANCE: float = 0.40
W_PRICE: float = 0.25
W_EXPIRY_URGENCY: float = 0.20
W_REPUTATION_PENALTY: float = 0.15

EXPIRY_HORIZON_DAYS: float = 90.0


def haversine_km(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    """Compute great-circle distance in km between two WGS-84 coordinates."""
    r_lat1, r_lng1, r_lat2, r_lng2 = map(math.radians, (lat1, lng1, lat2, lng2))
    d_lat = r_lat2 - r_lat1
    d_lng = r_lng2 - r_lng1
    a = (
        math.sin(d_lat / 2.0) ** 2
        + math.cos(r_lat1) * math.cos(r_lat2) * math.sin(d_lng / 2.0) ** 2
    )
    c = 2.0 * math.atan2(math.sqrt(a), math.sqrt(max(0.0, 1.0 - a)))
    return round(EARTH_RADIUS_KM * c, 3)


def compute_edge_cost(
    listing: ListingItem,
    shortage: ShortageItem,
    *,
    as_of_date: date,
    max_radius_km: float = 10.0,
) -> tuple[float, float] | None:
    """Evaluate feasibility and composite cost for pairing `listing` with `shortage`.

    Returns `(cost, distance_km)` if feasible, or `None` if any hard invariant is violated:
      1. Strict same-state GST boundary (`listing.state == shortage.state`, non-empty).
      2. Exact product match (`listing.product_id == shortage.product_id`).
      3. Distinct shops (`listing.seller_shop_id != shortage.buyer_shop_id`).
      4. Batch not expired (`batch_expiry_date > as_of_date`).
      5. Within radius (`distance_km <= min(shortage.swap_radius_km, max_radius_km)`).
      6. Price ceiling respected (`listing.price <= shortage.max_unit_price` when set).
    """
    if not listing.state or listing.state != shortage.state:
        return None
    if listing.product_id != shortage.product_id:
        return None
    if listing.seller_shop_id == shortage.buyer_shop_id:
        return None

    days_to_expiry = (listing.batch_expiry_date - as_of_date).days
    if days_to_expiry <= 0:
        return None

    if shortage.max_unit_price is not None and listing.price > shortage.max_unit_price:
        return None

    effective_radius = min(float(shortage.swap_radius_km), float(max_radius_km))
    distance_km = haversine_km(listing.lat, listing.lng, shortage.lat, shortage.lng)
    if distance_km > effective_radius:
        return None

    # Normalized [0, 1] cost components (lower is better)
    distance_norm = min(1.0, distance_km / max(effective_radius, 0.1))

    if shortage.max_unit_price is not None and shortage.max_unit_price > 0.0:
        price_norm = min(1.0, listing.price / shortage.max_unit_price)
    elif listing.cost_price > 0.0:
        price_norm = min(1.0, listing.price / listing.cost_price)
    else:
        price_norm = 0.5

    # Closer expiry -> lower cost -> prioritized first to prevent food/FMCG waste
    expiry_cost = min(float(days_to_expiry), EXPIRY_HORIZON_DAYS) / EXPIRY_HORIZON_DAYS

    # Higher seller reputation -> lower penalty
    reputation_penalty = max(0.0, min(1.0, (100.0 - float(listing.reputation_score)) / 100.0))

    total_cost = (
        W_DISTANCE * distance_norm
        + W_PRICE * price_norm
        + W_EXPIRY_URGENCY * expiry_cost
        + W_REPUTATION_PENALTY * reputation_penalty
    )
    return round(total_cost, 6), distance_km


def solve_bipartite_matches(
    listings: list[ListingItem],
    shortages: list[ShortageItem],
    *,
    as_of_date: date | None = None,
    max_radius_km: float = 10.0,
) -> list[MatchAssignment]:
    """Compute optimal deterministic min-cost bipartite matches per (state, product_id).

    Because infeasible edges carry a large finite penalty (`INFEASIBLE_COST = 1e9`),
    `scipy.optimize.linear_sum_assignment` simultaneously maximizes the number of
    feasible peer swaps and minimizes total composite cost among maximum-cardinality
    matchings.
    """
    if not listings or not shortages:
        return []

    ref_date = as_of_date or datetime.now(UTC).date()

    listings_by_bucket: dict[tuple[str, str], list[ListingItem]] = defaultdict(list)
    shortages_by_bucket: dict[tuple[str, str], list[ShortageItem]] = defaultdict(list)

    for item in listings:
        if item.state:
            listings_by_bucket[(item.state, item.product_id)].append(item)
    for req in shortages:
        if req.state:
            shortages_by_bucket[(req.state, req.product_id)].append(req)

    assignments: list[MatchAssignment] = []

    for bucket_key in sorted(set(listings_by_bucket.keys()) & set(shortages_by_bucket.keys())):
        # Canonical ordering guarantees deterministic tie-breaking across input permutations
        bucket_listings = sorted(listings_by_bucket[bucket_key], key=lambda x: x.listing_id)
        bucket_shortages = sorted(shortages_by_bucket[bucket_key], key=lambda x: x.shortage_id)

        m = len(bucket_listings)
        n = len(bucket_shortages)
        cost_matrix = np.full((m, n), INFEASIBLE_COST, dtype=np.float64)
        distances: dict[tuple[int, int], float] = {}

        has_feasible_edge = False
        for i, listing in enumerate(bucket_listings):
            for j, shortage in enumerate(bucket_shortages):
                evaluated = compute_edge_cost(
                    listing,
                    shortage,
                    as_of_date=ref_date,
                    max_radius_km=max_radius_km,
                )
                if evaluated is not None:
                    cost, dist_km = evaluated
                    cost_matrix[i, j] = cost
                    distances[(i, j)] = dist_km
                    has_feasible_edge = True

        if not has_feasible_edge:
            continue

        row_ind, col_ind = linear_sum_assignment(cost_matrix)
        for r, c in zip(row_ind, col_ind, strict=True):
            assigned_cost = float(cost_matrix[r, c])
            if assigned_cost >= INFEASIBLE_COST * 0.5:
                continue

            listing = bucket_listings[int(r)]
            shortage = bucket_shortages[int(c)]
            dist_km = distances[(int(r), int(c))]
            rank_score = round(max(0.0, min(1.0, 1.0 - assigned_cost)), 4)

            assignments.append(
                MatchAssignment(
                    listing_id=listing.listing_id,
                    seller_shop_id=listing.seller_shop_id,
                    buyer_shop_id=shortage.buyer_shop_id,
                    shortage_id=shortage.shortage_id,
                    product_id=listing.product_id,
                    state=listing.state,
                    matched_qty=min(listing.qty, shortage.reorder_qty),
                    offered_price=round(float(listing.price), 2),
                    distance_km=dist_km,
                    cost=round(assigned_cost, 6),
                    rank_score=rank_score,
                )
            )

    return sorted(
        assignments,
        key=lambda a: (-a.rank_score, a.distance_km, a.listing_id, a.buyer_shop_id),
    )
