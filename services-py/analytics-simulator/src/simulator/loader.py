"""Bulk HTTP loader for seeding synthetic data into Kirana Exchange services via /v1/... APIs.

Supports both API Gateway routing and direct service communication with robust retries,
concurrency limits, and optimistic concurrency version tracking for sales.
"""

import asyncio
import logging
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Literal

import httpx
import pandas as pd
from pydantic import BaseModel, Field

from .generator import SimulatedDataset

logger = logging.getLogger("kirana.simulator.loader")

# Category mapping to standard pack sizes and GST slabs
CATEGORY_METADATA: dict[str, tuple[str, int]] = {
    "Staples": ("1 kg", 5),
    "Snacks": ("100 g", 12),
    "Beverages": ("750 ml", 18),
    "Dairy": ("500 ml", 5),
    "Instant Food": ("200 g", 12),
    "Personal Care": ("250 ml", 18),
    "Home Care": ("500 ml", 18),
}
DEFAULT_PACK_SIZE = "1 unit"
DEFAULT_GST_RATE = 18


class LoaderConfig(BaseModel):
    """Configuration for bulk HTTP data loader."""

    gateway_url: str = "http://localhost:3000"
    catalog_url: str = "http://localhost:3004"
    shop_url: str = "http://localhost:3003"
    inventory_url: str = "http://localhost:3005"
    auth_url: str = "http://localhost:3002"
    mode: Literal["gateway", "direct"] = "gateway"
    auth_token: str | None = None
    admin_user_id: str = "00000000-0000-0000-0000-000000000001"
    concurrency: int = Field(default=20, ge=1, le=100)
    request_timeout: float = Field(default=30.0, ge=1.0)
    max_retries: int = Field(default=3, ge=0)
    backoff_factor: float = Field(default=0.3, ge=0.0)
    skip_sales: bool = False
    sales_days: int | None = None
    batch_chunk_size: int = Field(default=500, ge=1, le=5000)


@dataclass
class LoadingSummary:
    """Summary metrics of a bulk load execution."""

    products_created: int = 0
    products_reused: int = 0
    shops_created: int = 0
    batches_imported: int = 0
    sales_recorded: int = 0
    failed_requests: int = 0
    elapsed_seconds: float = 0.0
    errors: list[str] = field(default_factory=list)


class BulkHttpLoader:
    """Asynchronous HTTP bulk data loader for Kirana Exchange services."""

    def __init__(
        self,
        config: LoaderConfig,
        client: httpx.AsyncClient | None = None,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self.config = config
        self._custom_client = client
        self._custom_transport = transport
        self.product_idx_to_id: dict[int, str] = {}
        self.shop_idx_to_id: dict[int, str] = {}
        # Maps (shop_idx, product_idx) -> {"batchId": uuid, "version": int}
        self.batch_lookup: dict[tuple[int, int], dict[str, Any]] = {}
        self.summary = LoadingSummary()

    def _resolve_url(self, service: str, path: str) -> str:
        """Resolve target URL depending on gateway vs direct mode."""
        clean_path = path if path.startswith("/") else f"/{path}"
        if self.config.mode == "gateway":
            return f"{self.config.gateway_url.rstrip('/')}{clean_path}"

        service_urls = {
            "catalog": self.config.catalog_url,
            "shop": self.config.shop_url,
            "inventory": self.config.inventory_url,
            "auth": self.config.auth_url,
        }
        base_url = service_urls.get(service, self.config.gateway_url).rstrip("/")
        return f"{base_url}{clean_path}"

    def _build_headers(
        self,
        service: str,
        *,
        idempotency_key: str | None = None,
        correlation_id: str | None = None,
        user_role: str = "admin",
        user_id: str | None = None,
        shop_id: str | None = None,
    ) -> dict[str, str]:
        """Build request headers with proper auth and tracing."""
        headers: dict[str, str] = {
            "content-type": "application/json",
            "x-correlation-id": correlation_id or str(uuid.uuid4()),
        }

        if idempotency_key:
            headers["idempotency-key"] = idempotency_key

        if self.config.mode == "gateway":
            if self.config.auth_token:
                headers["authorization"] = f"Bearer {self.config.auth_token}"
        else:
            # Direct microservice headers
            headers["x-user-role"] = user_role
            headers["x-user-id"] = user_id or self.config.admin_user_id
            if shop_id:
                headers["x-shop-id"] = shop_id

        return headers

    async def _send_with_retry(
        self,
        client: httpx.AsyncClient,
        method: str,
        url: str,
        headers: dict[str, str],
        json_data: Any | None = None,
        params: dict[str, Any] | None = None,
    ) -> httpx.Response:
        """Send HTTP request with exponential backoff on retryable status/errors."""
        attempt = 0
        while True:
            try:
                response = await client.request(
                    method=method,
                    url=url,
                    headers=headers,
                    json=json_data,
                    params=params,
                )
                if (
                    response.status_code in (429, 502, 503, 504)
                    and attempt < self.config.max_retries
                ):
                    retry_after = response.headers.get("retry-after")
                    sleep_time = (
                        float(retry_after)
                        if retry_after and retry_after.isdigit()
                        else self.config.backoff_factor * (2**attempt)
                    )
                    attempt += 1
                    await asyncio.sleep(sleep_time)
                    continue

                return response
            except (httpx.ConnectError, httpx.ConnectTimeout, httpx.ReadTimeout) as exc:
                if attempt < self.config.max_retries:
                    attempt += 1
                    await asyncio.sleep(self.config.backoff_factor * (2**attempt))
                    continue
                self.summary.failed_requests += 1
                self.summary.errors.append(f"Network error on {method} {url}: {exc}")
                raise

    async def seed_catalog(
        self, client: httpx.AsyncClient, products_df: pd.DataFrame
    ) -> dict[int, str]:
        """Seed catalog products via POST /v1/catalog/products.

        If a product already exists (409 Conflict), falls back to GET
        /v1/catalog/products/ean/{ean} to resolve its existing UUID.
        """
        semaphore = asyncio.Semaphore(self.config.concurrency)

        async def _seed_single_product(row: pd.Series) -> None:
            product_idx = int(row["product_idx"])
            ean = str(row["ean"])
            category = str(row["category"])
            pack_size, default_gst = CATEGORY_METADATA.get(
                category, (DEFAULT_PACK_SIZE, DEFAULT_GST_RATE)
            )

            payload = {
                "ean": ean,
                "name": str(row["name"]),
                "brand": str(row["brand"]),
                "packSize": pack_size,
                "category": category,
                "mrp": float(row["mrp"]),
                "gstRate": default_gst,
                "shelfLifeDays": int(row["shelf_life_days"]),
            }

            url = self._resolve_url("catalog", "/v1/catalog/products")
            headers = self._build_headers("catalog", user_role="admin")

            async with semaphore:
                try:
                    res = await self._send_with_retry(
                        client, "POST", url, headers, json_data=payload
                    )
                    if res.status_code in (200, 201):
                        data = res.json()
                        self.product_idx_to_id[product_idx] = data["id"]
                        self.summary.products_created += 1
                    elif res.status_code == 409:
                        # Conflict: fetch by EAN
                        ean_url = self._resolve_url("catalog", f"/v1/catalog/products/ean/{ean}")
                        get_res = await self._send_with_retry(client, "GET", ean_url, headers)
                        if get_res.status_code == 200:
                            data = get_res.json()
                            self.product_idx_to_id[product_idx] = data["id"]
                            self.summary.products_reused += 1
                        else:
                            self.summary.failed_requests += 1
                            self.summary.errors.append(
                                f"Failed to retrieve existing product {ean}: {get_res.status_code}"
                            )
                    else:
                        self.summary.failed_requests += 1
                        self.summary.errors.append(
                            f"Create product {ean} failed ({res.status_code}): {res.text}"
                        )
                except Exception as exc:
                    self.summary.failed_requests += 1
                    self.summary.errors.append(f"Product {ean} exception: {exc}")

        tasks = [_seed_single_product(row) for _, row in products_df.iterrows()]
        await asyncio.gather(*tasks)
        return self.product_idx_to_id

    async def seed_shops(self, client: httpx.AsyncClient, shops_df: pd.DataFrame) -> dict[int, str]:
        """Seed shops via POST /v1/shops."""
        semaphore = asyncio.Semaphore(self.config.concurrency)

        async def _seed_single_shop(row: pd.Series) -> None:
            shop_idx = int(row["shop_idx"])
            name = str(row["name"])
            state = str(row["state"])
            gst_scheme = str(row["gst_scheme"]).upper()
            if gst_scheme not in ("REGULAR", "COMPOSITION", "UNREGISTERED"):
                gst_scheme = "UNREGISTERED"

            # Create synthetic owner UUID for direct mode
            owner_uuid = str(uuid.uuid5(uuid.NAMESPACE_DNS, f"shop-owner-{shop_idx}"))

            payload = {
                "name": name,
                "address": f"Plot {shop_idx + 1}, Main Market, {state}",
                "lat": float(row["lat"]),
                "lng": float(row["lng"]),
                "state": state,
                "gstScheme": gst_scheme,
                "swapRadiusKm": 3.0,
            }

            url = self._resolve_url("shop", "/v1/shops")
            headers = self._build_headers(
                "shop",
                user_role="shop_owner",
                user_id=owner_uuid,
            )

            async with semaphore:
                try:
                    res = await self._send_with_retry(
                        client, "POST", url, headers, json_data=payload
                    )
                    if res.status_code in (200, 201):
                        data = res.json()
                        self.shop_idx_to_id[shop_idx] = data["id"]
                        self.summary.shops_created += 1
                    else:
                        self.summary.failed_requests += 1
                        self.summary.errors.append(
                            f"Create shop {name} failed ({res.status_code}): {res.text}"
                        )
                except Exception as exc:
                    self.summary.failed_requests += 1
                    self.summary.errors.append(f"Shop {name} exception: {exc}")

        tasks = [_seed_single_shop(row) for _, row in shops_df.iterrows()]
        await asyncio.gather(*tasks)
        return self.shop_idx_to_id

    async def seed_batches(
        self, client: httpx.AsyncClient, initial_batches_df: pd.DataFrame
    ) -> dict[tuple[int, int], dict[str, Any]]:
        """Bulk import initial batches via POST /v1/inventory/batches/bulk-import."""
        semaphore = asyncio.Semaphore(self.config.concurrency)

        # Group by shop_idx
        grouped = initial_batches_df.groupby("shop_idx")

        async def _import_shop_batches(shop_idx_val: int, group: pd.DataFrame) -> None:
            shop_id = self.shop_idx_to_id.get(shop_idx_val)
            if not shop_id:
                self.summary.errors.append(f"No shop_id resolved for shop_idx {shop_idx_val}")
                return

            rows_payload = []
            for _, r in group.iterrows():
                p_idx = int(r["product_idx"])
                product_id = self.product_idx_to_id.get(p_idx)
                if not product_id:
                    continue

                expiry_str = (
                    r["expiry_date"].isoformat()
                    if hasattr(r["expiry_date"], "isoformat")
                    else str(r["expiry_date"])
                )

                rows_payload.append(
                    {
                        "productId": product_id,
                        "batchCode": f"B-{shop_idx_val:04d}-{p_idx:04d}",
                        "qty": int(r["initial_qty"]),
                        "costPrice": float(r["cost_price"]),
                        "expiryDate": expiry_str,
                        "idempotencyKey": str(
                            uuid.uuid5(uuid.NAMESPACE_DNS, f"batch-{shop_idx_val}-{p_idx}")
                        ),
                    }
                )

            if not rows_payload:
                return

            import_url = self._resolve_url("inventory", "/v1/inventory/batches/bulk-import")
            headers = self._build_headers(
                "inventory",
                user_role="admin",
                shop_id=shop_id,
            )

            async with semaphore:
                try:
                    res = await self._send_with_retry(
                        client,
                        "POST",
                        import_url,
                        headers,
                        json_data={"shopId": shop_id, "rows": rows_payload},
                    )
                    if res.status_code == 200:
                        data = res.json()
                        self.summary.batches_imported += data.get(
                            "importedCount", len(rows_payload)
                        )
                    else:
                        self.summary.failed_requests += 1
                        self.summary.errors.append(
                            f"Bulk import for shop {shop_id} failed ({res.status_code}): {res.text}"
                        )
                        return

                    # Query back the created batches to get batch UUID and starting version
                    list_url = self._resolve_url("inventory", "/v1/inventory/batches")
                    list_res = await self._send_with_retry(
                        client, "GET", list_url, headers, params={"shopId": shop_id}
                    )
                    if list_res.status_code == 200:
                        batch_list = list_res.json()
                        prod_to_batch = {
                            b["productId"]: {"batchId": b["id"], "version": b.get("version", 1)}
                            for b in batch_list
                        }
                        for _, r in group.iterrows():
                            p_idx = int(r["product_idx"])
                            pid = self.product_idx_to_id.get(p_idx)
                            if pid and pid in prod_to_batch:
                                self.batch_lookup[(shop_idx_val, p_idx)] = prod_to_batch[pid]
                    else:
                        self.summary.errors.append(
                            f"List batches for shop {shop_id} returned {list_res.status_code}"
                        )
                except Exception as exc:
                    self.summary.failed_requests += 1
                    self.summary.errors.append(f"Batch import shop {shop_idx_val} error: {exc}")

        tasks = [_import_shop_batches(int(s_idx), grp) for s_idx, grp in grouped]
        await asyncio.gather(*tasks)
        return self.batch_lookup

    async def seed_sales(self, client: httpx.AsyncClient, daily_sales_df: pd.DataFrame) -> int:
        """Seed daily sales sequentially per batch stream via POST /v1/inventory/sales."""
        if self.config.skip_sales:
            return 0

        sales_col = "recorded_sales" if "recorded_sales" in daily_sales_df.columns else "sales_qty"
        # Filter strictly positive sales
        sales_active = daily_sales_df[daily_sales_df[sales_col] > 0].copy()
        if self.config.sales_days is not None and not sales_active.empty:
            min_date = sales_active["date"].min()
            sales_active = sales_active[
                sales_active["date"] < min_date + pd.Timedelta(days=self.config.sales_days)
            ]

        if sales_active.empty:
            return 0

        semaphore = asyncio.Semaphore(self.config.concurrency)
        sales_url = self._resolve_url("inventory", "/v1/inventory/sales")

        # Group by (shop_idx, product_idx) to guarantee strict serial ordering per batch
        grouped = sales_active.groupby(["shop_idx", "product_idx"])

        async def _stream_batch_sales(key: tuple[int, int], group: pd.DataFrame) -> None:
            shop_idx_val, product_idx_val = key
            shop_id = self.shop_idx_to_id.get(shop_idx_val)
            batch_info = self.batch_lookup.get((shop_idx_val, product_idx_val))

            if not shop_id or not batch_info:
                return

            batch_id = batch_info["batchId"]
            current_version = batch_info["version"]

            # Sort chronologically
            sorted_sales = group.sort_values("date")

            for _, row in sorted_sales.iterrows():
                qty = int(row[sales_col])
                date_val = row["date"]
                date_str = date_val.isoformat() if hasattr(date_val, "isoformat") else str(date_val)
                sold_at = f"{date_str}T12:00:00.000Z"

                payload = {
                    "shopId": shop_id,
                    "batchId": batch_id,
                    "qty": qty,
                    "expectedVersion": current_version,
                    "soldAt": sold_at,
                }

                sale_idem_key = str(
                    uuid.uuid5(uuid.NAMESPACE_DNS, f"sale-{batch_id}-{date_str}-{qty}")
                )
                headers = self._build_headers(
                    "inventory",
                    user_role="admin",
                    shop_id=shop_id,
                    idempotency_key=sale_idem_key,
                )

                async with semaphore:
                    try:
                        res = await self._send_with_retry(
                            client, "POST", sales_url, headers, json_data=payload
                        )
                        if res.status_code in (200, 201):
                            data = res.json()
                            batch_data = data.get("batch", {})
                            current_version = batch_data.get("version", current_version + 1)
                            batch_info["version"] = current_version
                            self.summary.sales_recorded += 1
                        elif res.status_code == 409:
                            # Optimistic concurrency conflict; skip or fetch latest
                            self.summary.failed_requests += 1
                            self.summary.errors.append(
                                f"Sale 409 conflict on batch {batch_id} at date {date_str}"
                            )
                            break
                        else:
                            self.summary.failed_requests += 1
                            self.summary.errors.append(
                                f"Sale on batch {batch_id} failed ({res.status_code}): {res.text}"
                            )
                            break
                    except Exception as exc:
                        self.summary.failed_requests += 1
                        self.summary.errors.append(f"Sale exception on batch {batch_id}: {exc}")
                        break

        tasks = [_stream_batch_sales((int(k[0]), int(k[1])), grp) for k, grp in grouped]
        await asyncio.gather(*tasks)
        return self.summary.sales_recorded

    async def run(self, dataset: SimulatedDataset) -> LoadingSummary:
        """Run the full asynchronous pipeline to seed all datasets."""
        start_time = datetime.now(UTC)

        limits = httpx.Limits(
            max_connections=self.config.concurrency * 2,
            max_keepalive_connections=self.config.concurrency,
        )

        client_kwargs: dict[str, Any] = {
            "timeout": httpx.Timeout(self.config.request_timeout),
            "limits": limits,
        }
        if self._custom_transport is not None:
            client_kwargs["transport"] = self._custom_transport

        if self._custom_client is not None:
            client = self._custom_client
            close_client = False
        else:
            client = httpx.AsyncClient(**client_kwargs)
            close_client = True

        try:
            logger.info("Starting Catalog Seeding (%d SKUs)...", len(dataset.products))
            await self.seed_catalog(client, dataset.products)

            logger.info("Starting Shop Seeding (%d Shops)...", len(dataset.shops))
            await self.seed_shops(client, dataset.shops)

            logger.info(
                "Starting Inventory Batches Import (%d rows)...",
                len(dataset.initial_batches),
            )
            await self.seed_batches(client, dataset.initial_batches)

            if not self.config.skip_sales:
                logger.info(
                    "Starting Daily Sales Streaming (%d records)...",
                    len(dataset.daily_sales),
                )
                await self.seed_sales(client, dataset.daily_sales)

        finally:
            if close_client:
                await client.aclose()

        elapsed = (datetime.now(UTC) - start_time).total_seconds()
        self.summary.elapsed_seconds = round(elapsed, 3)
        return self.summary
