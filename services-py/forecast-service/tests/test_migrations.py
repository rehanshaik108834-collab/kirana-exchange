"""Tests verifying the integrity and completeness of Alembic migrations."""

import importlib.util
from pathlib import Path


def test_0001_init_forecast_schema_structure() -> None:
    migration_file = (
        Path(__file__).parent.parent / "alembic" / "versions" / "0001_init_forecast_schema.py"
    )
    assert migration_file.exists(), f"Migration file missing at {migration_file}"

    spec = importlib.util.spec_from_file_location("migration_0001", migration_file)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)

    assert mod.revision == "0001_init_forecast_schema"
    assert mod.down_revision is None
    assert callable(mod.upgrade)
    assert callable(mod.downgrade)

    content = migration_file.read_text(encoding="utf-8")
    expected_tables = [
        "sales_history_read_model",
        "batch_snapshot_read_model",
        "forecasts",
        "batch_risk_flags",
        "processed_messages",
        "outbox_events",
    ]
    for table in expected_tables:
        assert f'"{table}"' in content or f"'{table}'" in content, (
            f"Table {table} not defined in migration"
        )
