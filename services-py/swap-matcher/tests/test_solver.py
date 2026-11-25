"""Unit tests for deterministic scipy min-cost bipartite matching and GST boundaries."""

from datetime import date

from matcher.models import ListingItem, ShortageItem
from matcher.solver import haversine_km, solve_bipartite_matches

PROD_A = "44444444-4444-4444-8444-444444444444"
PROD_B = "55555555-5555-4555-8555-555555555555"
AS_OF = date(2026, 4, 1)


def _listing(
    listing_id: str,
    seller_shop_id: str,
    *,
    lat: float,
    lng: float = 78.4400,
    state: str = "Telangana",
    product_id: str = PROD_A,
    qty: int = 10,
    price: float = 90.0,
    cost_price: float = 100.0,
    expiry: date = date(2026, 4, 20),
    reputation: float = 100.0,
) -> ListingItem:
    return ListingItem(
        listing_id=listing_id,
        seller_shop_id=seller_shop_id,
        batch_id=f"batch-{listing_id}",
        product_id=product_id,
        state=state,
        qty=qty,
        price=price,
        cost_price=cost_price,
        batch_expiry_date=expiry,
        lat=lat,
        lng=lng,
        reputation_score=reputation,
    )


def _shortage(
    shortage_id: str,
    buyer_shop_id: str,
    *,
    lat: float,
    lng: float = 78.4400,
    state: str = "Telangana",
    product_id: str = PROD_A,
    reorder_qty: int = 8,
    max_unit_price: float | None = 100.0,
    radius_km: float = 5.0,
) -> ShortageItem:
    return ShortageItem(
        shortage_id=shortage_id,
        buyer_shop_id=buyer_shop_id,
        product_id=product_id,
        state=state,
        reorder_qty=reorder_qty,
        max_unit_price=max_unit_price,
        lat=lat,
        lng=lng,
        swap_radius_km=radius_km,
    )


def test_bipartite_solver_beats_greedy_on_cardinality_and_global_cost():
    """Proves linear_sum_assignment finds 2 feasible matches where greedy finds only 1.

    Geometry along lng=78.4400 (~1.112 km per 0.01 deg latitude):
    - B1 (17.4100, r=5km), B2 (17.4350, r=3km)
    - L1 (17.4150): 0.56 km to B1 (feasible), 2.22 km to B2 (feasible)
    - L2 (17.4000): 1.11 km to B1 (feasible), 3.89 km to B2 (INFEASIBLE > 3km)
    Greedy would pick (L1, B1) leaving L2 & B2 unmatched.
    Optimal assignment MUST pick (L1, B2) and (L2, B1).
    """
    listings = [
        _listing("list-1", "seller-1", lat=17.4150),
        _listing("list-2", "seller-2", lat=17.4000),
    ]
    shortages = [
        _shortage("short-1", "buyer-1", lat=17.4100, radius_km=5.0),
        _shortage("short-2", "buyer-2", lat=17.4350, radius_km=3.0),
    ]

    matches = solve_bipartite_matches(listings, shortages, as_of_date=AS_OF)
    assert len(matches) == 2

    pairs = {(m.listing_id, m.buyer_shop_id) for m in matches}
    assert pairs == {("list-1", "buyer-2"), ("list-2", "buyer-1")}


def test_min_cost_assignment_minimizes_total_distance_over_all_feasible_matrix():
    """With all 4 edges feasible, chooses minimum total distance pairing (4.45 km vs 8.89 km)."""
    listings = [
        _listing("list-1", "seller-1", lat=17.4100),
        _listing("list-2", "seller-2", lat=17.4600),
    ]
    shortages = [
        _shortage("short-1", "buyer-1", lat=17.4000, radius_km=10.0),
        _shortage("short-2", "buyer-2", lat=17.4300, radius_km=10.0),
    ]

    matches = solve_bipartite_matches(listings, shortages, as_of_date=AS_OF)
    pairs = {(m.listing_id, m.buyer_shop_id) for m in matches}
    assert pairs == {("list-1", "buyer-1"), ("list-2", "buyer-2")}


def test_strict_same_state_gst_boundary_blocks_cross_state_border_shops():
    """Even if two shops are 0.1 km apart across a state border, zero cross-state swaps occur."""
    listings = [
        _listing("list-ts", "seller-ts", lat=17.0000, state="Telangana"),
        _listing("list-ap", "seller-ap", lat=17.0005, state="Andhra Pradesh"),
    ]
    shortages = [
        _shortage("short-ts", "buyer-ts", lat=17.0006, state="Telangana", radius_km=5.0),
    ]

    assert haversine_km(17.0005, 78.4400, 17.0006, 78.4400) < 0.05
    matches = solve_bipartite_matches(listings, shortages, as_of_date=AS_OF)
    assert len(matches) == 1
    assert matches[0].listing_id == "list-ts"
    assert matches[0].state == "Telangana"


def test_hard_constraints_self_swap_price_cap_expiry_and_product():
    shortages = [
        _shortage("s1", "shop-buyer", lat=17.4100, max_unit_price=85.0, radius_km=5.0),
    ]
    listings = [
        # Violates self-swap
        _listing("l-self", "shop-buyer", lat=17.4100, price=80.0),
        # Violates max_unit_price
        _listing("l-expensive", "seller-2", lat=17.4100, price=90.0),
        # Violates expiry (already expired on AS_OF)
        _listing("l-expired", "seller-3", lat=17.4100, price=70.0, expiry=date(2026, 4, 1)),
        # Violates product match
        _listing("l-wrong-sku", "seller-4", lat=17.4100, price=70.0, product_id=PROD_B),
    ]

    assert solve_bipartite_matches(listings, shortages, as_of_date=AS_OF) == []


def test_expiry_urgency_and_reputation_prioritization_and_determinism():
    """At equal distance & price, urgent-expiry high-reputation listing wins deterministically."""
    buyer = _shortage("s1", "buyer-1", lat=17.4100, radius_km=5.0)
    urgent_high_rep = _listing(
        "list-urgent",
        "seller-1",
        lat=17.4150,
        price=85.0,
        expiry=date(2026, 4, 6),
        reputation=98.0,
    )
    long_low_rep = _listing(
        "list-long",
        "seller-2",
        lat=17.4150,
        price=85.0,
        expiry=date(2026, 7, 15),
        reputation=65.0,
    )

    m1 = solve_bipartite_matches([urgent_high_rep, long_low_rep], [buyer], as_of_date=AS_OF)
    m2 = solve_bipartite_matches([long_low_rep, urgent_high_rep], [buyer], as_of_date=AS_OF)

    assert len(m1) == 1
    assert m1[0].listing_id == "list-urgent"
    assert m1 == m2
    assert 0.0 < m1[0].rank_score <= 1.0
