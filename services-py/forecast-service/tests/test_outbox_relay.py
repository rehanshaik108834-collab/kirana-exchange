"""Unit tests for the Python ForecastOutboxRelay including mid-batch crash recovery."""

import json
import uuid

import pytest
from forecast.db.models import Base, OutboxEvent
from forecast.messaging.outbox_relay import ForecastOutboxRelay
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine


@pytest.fixture
async def sqlite_session_factory():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(bind=engine, expire_on_commit=False)
    yield factory
    await engine.dispose()


async def test_outbox_relay_publishes_and_marks_published(sqlite_session_factory):
    corr_id = uuid.uuid4()
    batch_id = uuid.uuid4()
    async with sqlite_session_factory() as session:
        async with session.begin():
            session.add(
                OutboxEvent(
                    id=uuid.uuid4(),
                    aggregate_type="batch",
                    aggregate_id=batch_id,
                    event_type="forecast.batch.at_risk.v1",
                    version=1,
                    correlation_id=corr_id,
                    producer="forecast-service",
                    payload={"batchId": str(batch_id), "riskType": "EXPIRY"},
                )
            )

    published_msgs: list[tuple[str, dict]] = []

    async def fake_publish(routing_key: str, body: bytes, headers: dict) -> None:
        published_msgs.append((routing_key, json.loads(body.decode("utf-8"))))

    relay = ForecastOutboxRelay(sqlite_session_factory, publisher=fake_publish, batch_size=10)
    count = await relay.relay_once()
    assert count == 1
    assert len(published_msgs) == 1
    assert published_msgs[0][0] == "forecast.batch.at_risk.v1"
    assert published_msgs[0][1]["correlationId"] == str(corr_id)

    # Second poll finds nothing left
    assert await relay.relay_once() == 0


async def test_outbox_relay_mid_batch_crash_preserves_unpublished_rows(sqlite_session_factory):
    async with sqlite_session_factory() as session:
        async with session.begin():
            for _ in range(3):
                session.add(
                    OutboxEvent(
                        id=uuid.uuid4(),
                        aggregate_type="batch",
                        aggregate_id=uuid.uuid4(),
                        event_type="forecast.batch.at_risk.v1",
                        version=1,
                        correlation_id=uuid.uuid4(),
                        producer="forecast-service",
                        payload={"riskType": "DEAD_STOCK"},
                    )
                )

    published_ids: list[str] = []

    async def fake_publish(routing_key: str, body: bytes, headers: dict) -> None:
        published_ids.append(json.loads(body.decode("utf-8"))["id"])

    relay = ForecastOutboxRelay(sqlite_session_factory, publisher=fake_publish, batch_size=10)

    # Crash mid-batch after 2 events -> DB rolls back, 0 rows marked published
    with pytest.raises(RuntimeError, match="Simulated relay crash"):
        await relay.relay_once(kill_after_publish_count=2)

    async with sqlite_session_factory() as session:
        unpublished = list(
            (await session.execute(select(OutboxEvent).where(OutboxEvent.published_at.is_(None))))
            .scalars()
            .all()
        )
        assert len(unpublished) == 3

    # Recovery run delivers all 3 events with 0 lost
    recovered = await relay.relay_once()
    assert recovered == 3
    assert len(set(published_ids)) == 3
