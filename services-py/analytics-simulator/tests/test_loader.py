"""Unit and integration tests for BulkHttpLoader using httpx.MockTransport."""

import json
import uuid
from typing import Any

import httpx
import pandas as pd
import pytest

from simulator.config import CityCenterConfig, SimulatorConfig
from simulator.generator import SimulatedDataset, run_simulation
from simulator.loader import BulkHttpLoader, LoaderConfig


def make_mock_transport(handler: Any) -> httpx.MockTransport:
    return httpx.MockTransport(handler)


@pytest.fixture
def mini_dataset() -> SimulatedDataset:
    cfg = SimulatorConfig(
        seed=101,
        shop_count=2,
        days=5,
        skus_per_shop=2,
        city_center=CityCenterConfig(
            name="Hyderabad",
            state="Telangana",
            lat=17.385044,
            lng=78.486671,
            radius_km=5.0,
            cluster_count=2,
        ),
    )
    return run_simulation(cfg)


@pytest.mark.anyio
async def test_1_catalog_seeding_and_conflict_resolution() -> None:
    products_df = pd.DataFrame(
        [
            {
                "product_idx": 0,
                "ean": "8901234567890",
                "name": "Staples Rice",
                "brand": "Brand A",
                "category": "Staples",
                "mrp": 100.0,
                "shelf_life_days": 180,
            },
            {
                "product_idx": 1,
                "ean": "8909876543210",
                "name": "Snack Chips",
                "brand": "Brand B",
                "category": "Snacks",
                "mrp": 20.0,
                "shelf_life_days": 90,
            },
        ]
    )

    created_ids = {"8901234567890": str(uuid.uuid4()), "8909876543210": str(uuid.uuid4())}

    def handler(request: httpx.Request) -> httpx.Response:
        url_str = str(request.url)
        if request.method == "POST" and "/v1/catalog/products" in url_str:
            data = json.loads(request.content)
            ean = data["ean"]
            if ean == "8901234567890":
                return httpx.Response(
                    201, json={"id": created_ids[ean], "ean": ean, "name": data["name"]}
                )
            # Simulate 409 Conflict for second item
            return httpx.Response(409, json={"message": "Product already exists"})

        if request.method == "GET" and "/v1/catalog/products/ean/" in url_str:
            ean = url_str.split("/v1/catalog/products/ean/")[-1]
            return httpx.Response(200, json={"id": created_ids[ean], "ean": ean})

        return httpx.Response(404)

    transport = make_mock_transport(handler)
    async with httpx.AsyncClient(transport=transport) as client:
        loader = BulkHttpLoader(LoaderConfig(concurrency=2))
        resolved = await loader.seed_catalog(client, products_df)

    assert loader.summary.products_created == 1
    assert loader.summary.products_reused == 1
    assert resolved[0] == created_ids["8901234567890"]
    assert resolved[1] == created_ids["8909876543210"]


@pytest.mark.anyio
async def test_2_shop_seeding() -> None:
    shops_df = pd.DataFrame(
        [
            {
                "shop_idx": 0,
                "name": "Kirana Shop 0",
                "state": "Telangana",
                "lat": 17.385,
                "lng": 78.486,
                "gst_scheme": "REGULAR",
            },
            {
                "shop_idx": 1,
                "name": "Kirana Shop 1",
                "state": "Telangana",
                "lat": 17.390,
                "lng": 78.490,
                "gst_scheme": "COMPOSITION",
            },
        ]
    )

    shop_uuids = [str(uuid.uuid4()), str(uuid.uuid4())]
    call_count = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal call_count
        if request.method == "POST" and "/v1/shops" in str(request.url):
            data = json.loads(request.content)
            assert "name" in data
            assert data["gstScheme"] in ("REGULAR", "COMPOSITION")
            idx = call_count
            call_count += 1
            return httpx.Response(201, json={"id": shop_uuids[idx], **data})
        return httpx.Response(404)

    transport = make_mock_transport(handler)
    async with httpx.AsyncClient(transport=transport) as client:
        loader = BulkHttpLoader(LoaderConfig(concurrency=1))
        resolved = await loader.seed_shops(client, shops_df)

    assert loader.summary.shops_created == 2
    assert resolved[0] == shop_uuids[0]
    assert resolved[1] == shop_uuids[1]


@pytest.mark.anyio
async def test_3_batch_import_and_lookup() -> None:
    loader = BulkHttpLoader(LoaderConfig(concurrency=1))
    shop_uuid = str(uuid.uuid4())
    prod_uuid = str(uuid.uuid4())
    batch_uuid = str(uuid.uuid4())

    loader.shop_idx_to_id[0] = shop_uuid
    loader.product_idx_to_id[0] = prod_uuid

    batches_df = pd.DataFrame(
        [
            {
                "shop_idx": 0,
                "product_idx": 0,
                "initial_qty": 50,
                "cost_price": 45.0,
                "expiry_date": "2027-01-01",
            }
        ]
    )

    def handler(request: httpx.Request) -> httpx.Response:
        url_str = str(request.url)
        if request.method == "POST" and "/v1/inventory/batches/bulk-import" in url_str:
            data = json.loads(request.content)
            assert data["shopId"] == shop_uuid
            assert len(data["rows"]) == 1
            return httpx.Response(200, json={"importedCount": 1})

        if request.method == "GET" and "/v1/inventory/batches" in url_str:
            return httpx.Response(
                200,
                json=[
                    {
                        "id": batch_uuid,
                        "productId": prod_uuid,
                        "shopId": shop_uuid,
                        "version": 1,
                        "qty": 50,
                    }
                ],
            )

        return httpx.Response(404)

    transport = make_mock_transport(handler)
    async with httpx.AsyncClient(transport=transport) as client:
        lookup = await loader.seed_batches(client, batches_df)

    assert loader.summary.batches_imported == 1
    assert lookup[(0, 0)]["batchId"] == batch_uuid
    assert lookup[(0, 0)]["version"] == 1


@pytest.mark.anyio
async def test_4_sequential_sales_streaming_and_versioning() -> None:
    loader = BulkHttpLoader(LoaderConfig(concurrency=1))
    shop_uuid = str(uuid.uuid4())
    batch_uuid = str(uuid.uuid4())

    loader.shop_idx_to_id[0] = shop_uuid
    loader.batch_lookup[(0, 0)] = {"batchId": batch_uuid, "version": 1}

    sales_df = pd.DataFrame(
        [
            {"shop_idx": 0, "product_idx": 0, "date": "2026-01-01", "sales_qty": 2},
            {"shop_idx": 0, "product_idx": 0, "date": "2026-01-02", "sales_qty": 3},
            {"shop_idx": 0, "product_idx": 0, "date": "2026-01-03", "sales_qty": 1},
        ]
    )

    versions_received: list[int] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "POST" and "/v1/inventory/sales" in str(request.url):
            data = json.loads(request.content)
            exp_ver = data["expectedVersion"]
            versions_received.append(exp_ver)
            new_ver = exp_ver + 1
            return httpx.Response(
                200,
                json={
                    "sale": {"id": str(uuid.uuid4()), "qty": data["qty"]},
                    "batch": {"id": batch_uuid, "version": new_ver},
                },
            )
        return httpx.Response(404)

    transport = make_mock_transport(handler)
    async with httpx.AsyncClient(transport=transport) as client:
        recorded = await loader.seed_sales(client, sales_df)

    assert recorded == 3
    # Verifies strict optimistic concurrency sequential version increments
    assert versions_received == [1, 2, 3]
    assert loader.batch_lookup[(0, 0)]["version"] == 4


@pytest.mark.anyio
async def test_5_retry_and_backoff_on_transient_error() -> None:
    attempt = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal attempt
        attempt += 1
        if attempt == 1:
            return httpx.Response(429, headers={"retry-after": "0.01"})
        return httpx.Response(201, json={"id": "prod-1", "ean": "123456789012"})

    transport = make_mock_transport(handler)
    async with httpx.AsyncClient(transport=transport) as client:
        loader = BulkHttpLoader(LoaderConfig(max_retries=2, backoff_factor=0.01))
        res = await loader._send_with_retry(
            client, "POST", "http://test/v1/catalog/products", headers={}
        )

    assert res.status_code == 201
    assert attempt == 2


@pytest.mark.anyio
async def test_6_full_end_to_end_mock_pipeline(mini_dataset: SimulatedDataset) -> None:
    product_map: dict[str, str] = {}
    shop_map: dict[str, str] = {}
    batch_map: dict[str, dict] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        url_str = str(request.url)
        # Catalog
        if request.method == "POST" and "/v1/catalog/products" in url_str:
            data = json.loads(request.content)
            pid = str(uuid.uuid4())
            product_map[data["ean"]] = pid
            return httpx.Response(201, json={"id": pid, **data})

        # Shop
        if request.method == "POST" and "/v1/shops" in url_str:
            data = json.loads(request.content)
            sid = str(uuid.uuid4())
            shop_map[data["name"]] = sid
            return httpx.Response(201, json={"id": sid, **data})

        # Batches Bulk Import
        if request.method == "POST" and "/v1/inventory/batches/bulk-import" in url_str:
            data = json.loads(request.content)
            sid = data["shopId"]
            if sid not in batch_map:
                batch_map[sid] = []
            for r in data["rows"]:
                bid = str(uuid.uuid4())
                batch_map[sid].append({"id": bid, "productId": r["productId"], "version": 1})
            return httpx.Response(200, json={"importedCount": len(data["rows"])})

        # List batches
        if request.method == "GET" and "/v1/inventory/batches" in url_str:
            sid = request.url.params["shopId"]
            return httpx.Response(200, json=batch_map.get(sid, []))

        # Sales
        if request.method == "POST" and "/v1/inventory/sales" in url_str:
            data = json.loads(request.content)
            return httpx.Response(
                200,
                json={
                    "sale": {"id": str(uuid.uuid4()), "qty": data["qty"]},
                    "batch": {"id": data["batchId"], "version": data["expectedVersion"] + 1},
                },
            )

        return httpx.Response(404)

    transport = make_mock_transport(handler)
    loader = BulkHttpLoader(
        LoaderConfig(concurrency=4, skip_sales=False),
        transport=transport,
    )
    summary = await loader.run(mini_dataset)

    assert summary.products_created == len(mini_dataset.products)
    assert summary.shops_created == len(mini_dataset.shops)
    assert summary.batches_imported == len(mini_dataset.initial_batches)
    assert summary.failed_requests == 0
    assert summary.sales_recorded > 0
    assert summary.elapsed_seconds >= 0.0
