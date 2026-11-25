"""Integration tests for SwapMatcherWorker HTTP snapshot fetch and swap.match.found.v1 emission."""

import json
import uuid
from datetime import date

import httpx

from matcher.worker import MATCH_FOUND_ROUTING_KEY, SwapMatcherWorker

LISTING_ID = "66666666-6666-4666-8666-666666666666"
SELLER_ID = "22222222-2222-4222-8222-222222222222"
BUYER_ID = "11111111-1111-4111-8111-111111111111"
BATCH_ID = "55555555-5555-4555-8555-555555555555"
PRODUCT_ID = "44444444-4444-4444-8444-444444444444"
SHORTAGE_ID = "77777777-7777-4777-8777-777777777777"
CORR_ID = "99999999-9999-4999-8999-999999999999"


async def test_worker_fetches_snapshot_and_publishes_contract_compliant_match_event():
    captured_headers: dict[str, str] = {}
    published: list[tuple[str, dict, dict]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        captured_headers.update(dict(request.headers))
        assert request.url.path == "/v1/swaps/internal/matching-snapshot"
        assert request.url.params.get("state") == "Telangana"
        return httpx.Response(
            200,
            json={
                "state": "Telangana",
                "generatedAt": "2026-04-01T00:00:00Z",
                "listings": [
                    {
                        "listingId": LISTING_ID,
                        "sellerShopId": SELLER_ID,
                        "batchId": BATCH_ID,
                        "productId": PRODUCT_ID,
                        "qty": 12,
                        "price": 78.5,
                        "costPrice": 90.0,
                        "batchExpiryDate": "2026-04-15",
                        "lat": 17.4126,
                        "lng": 78.4398,
                        "reputationScore": 96.0,
                    }
                ],
                "shortages": [
                    {
                        "shortageId": SHORTAGE_ID,
                        "buyerShopId": BUYER_ID,
                        "productId": PRODUCT_ID,
                        "reorderQty": 10,
                        "maxUnitPrice": 85.0,
                        "lat": 17.4200,
                        "lng": 78.4410,
                        "swapRadiusKm": 5.0,
                        "reputationScore": 92.0,
                    }
                ],
            },
        )

    async def fake_publish(routing_key: str, body: bytes, headers: dict) -> None:
        published.append((routing_key, json.loads(body.decode("utf-8")), headers))

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        worker = SwapMatcherWorker(
            swap_service_url="http://swap-service.local:3007",
            http_client=client,
            publisher=fake_publish,
        )
        matches = await worker.run_for_state(
            "Telangana",
            as_of_date=date(2026, 4, 1),
            correlation_id=CORR_ID,
        )

    assert captured_headers.get("x-internal-service") == "swap-matcher"
    assert captured_headers.get("x-correlation-id") == CORR_ID
    assert len(matches) == 1
    assert matches[0].matched_qty == 10

    assert len(published) == 1
    routing_key, envelope, headers = published[0]
    assert routing_key == MATCH_FOUND_ROUTING_KEY
    assert headers["x-correlation-id"] == CORR_ID

    # Verify strict compliance with libs/contracts/events/envelope.schema.json
    for key in ("id", "type", "version", "occurredAt", "correlationId", "producer", "payload"):
        assert key in envelope
    uuid.UUID(envelope["id"])
    assert envelope["type"] == "swap.match.found.v1"
    assert envelope["version"] == 1
    assert envelope["correlationId"] == CORR_ID
    assert envelope["producer"] == "swap-matcher"

    # Verify strict compliance with libs/contracts/events/swap.match.found.v1.json
    payload = envelope["payload"]
    assert payload["listingId"] == LISTING_ID
    assert payload["candidateShopId"] == BUYER_ID
    assert payload["productId"] == PRODUCT_ID
    assert isinstance(payload["distanceKm"], float) and payload["distanceKm"] < 2.0
    assert isinstance(payload["rankScore"], float) and 0.0 < payload["rankScore"] <= 1.0
    assert payload["offeredPrice"] == 78.5
