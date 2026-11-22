from pathlib import Path

import pandas as pd
from simulator.benchmark_sampler import sample_favorita_benchmark
from simulator.cli import app
from simulator.config import load_config
from simulator.exporter import export_dataset, sha256_file, verify_manifest
from simulator.generator import run_simulation
from typer.testing import CliRunner

CONFIGS_DIR = Path(__file__).resolve().parent.parent / "configs"
runner = CliRunner()


def test_1_identical_parquet_sha256(tmp_path: Path):
    """Test 1: Exporting twice yields identical SHA-256 for all 4 .parquet files and manifest."""
    cfg = load_config(CONFIGS_DIR / "preset_10.yaml")
    dataset1 = run_simulation(cfg)
    dataset2 = run_simulation(cfg)

    dir1 = tmp_path / "run1"
    dir2 = tmp_path / "run2"

    manifest1 = export_dataset(cfg, dataset1, dir1, fmt="parquet")
    manifest2 = export_dataset(cfg, dataset2, dir2, fmt="parquet")

    assert manifest1.config_hash == manifest2.config_hash
    for key in ("shops", "products", "initial_batches", "daily_sales"):
        sha1 = manifest1.files[key].sha256
        sha2 = manifest2.files[key].sha256
        assert sha1 == sha2, f"Parquet SHA mismatch for {key}: {sha1} != {sha2}"

    # Verify manifest bytes are identical
    m1_bytes = (dir1 / "manifest.json").read_bytes()
    m2_bytes = (dir2 / "manifest.json").read_bytes()
    assert m1_bytes == m2_bytes, "manifest.json must be byte-for-byte identical"

    # Verify manifest self-check passes
    ok1, errs1 = verify_manifest(dir1)
    assert ok1, f"Manifest 1 verification failed: {errs1}"
    ok2, errs2 = verify_manifest(dir2)
    assert ok2, f"Manifest 2 verification failed: {errs2}"


def test_2_identical_csv_sha256(tmp_path: Path):
    """Test 2: Exporting twice with CSV yields identical SHA-256 digests and unix line-endings."""
    cfg = load_config(CONFIGS_DIR / "preset_10.yaml")
    dataset1 = run_simulation(cfg)
    dataset2 = run_simulation(cfg)

    dir1 = tmp_path / "csv1"
    dir2 = tmp_path / "csv2"

    manifest1 = export_dataset(cfg, dataset1, dir1, fmt="csv")
    manifest2 = export_dataset(cfg, dataset2, dir2, fmt="csv")

    for key in ("shops", "products", "initial_batches", "daily_sales"):
        sha1 = manifest1.files[key].sha256
        sha2 = manifest2.files[key].sha256
        assert sha1 == sha2, f"CSV SHA mismatch for {key}: {sha1} != {sha2}"

    # Confirm no carriage returns in generated CSVs (\n only)
    csv_bytes = (dir1 / "daily_sales.csv").read_bytes()
    assert b"\r" not in csv_bytes, "CSV files must use Unix LF newlines"

    ok, errs = verify_manifest(dir1)
    assert ok, f"CSV manifest verification failed: {errs}"


def test_3_tamper_detection(tmp_path: Path):
    """Test 3: Flipping 1 byte in daily_sales.parquet causes verify_manifest() to fail."""
    cfg = load_config(CONFIGS_DIR / "preset_10.yaml")
    dataset = run_simulation(cfg)

    dir_path = tmp_path / "tamper_test"
    export_dataset(cfg, dataset, dir_path, fmt="parquet")

    # Tamper with daily_sales.parquet by inverting a byte in the middle
    target_file = dir_path / "daily_sales.parquet"
    data = bytearray(target_file.read_bytes())
    pos = len(data) // 2
    data[pos] = data[pos] ^ 0xFF
    target_file.write_bytes(data)

    is_valid, errors = verify_manifest(dir_path)
    assert not is_valid, "verify_manifest must flag tampered file"
    err_str = " ".join(errors)
    assert "SHA-256 mismatch" in err_str, f"Expected SHA mismatch error, got {errors}"


def test_4_favorita_holiday_and_schema_normalization(tmp_path: Path):
    """Test 4: Favorita sampler normalizes holidays, clips returns, and fills zero-sale gaps."""
    # 1. Create a synthetic holidays_events.csv
    # - 2026-01-05: Holiday, transferred=True (should be EXCLUDED)
    # - 2026-01-07: Transfer, transferred=False (should be INCLUDED)
    # - 2026-01-10: Work Day, transferred=False (should be EXCLUDED)
    holidays_df = pd.DataFrame(
        [
            {"date": "2026-01-05", "type": "Holiday", "transferred": True},
            {"date": "2026-01-07", "type": "Transfer", "transferred": False},
            {"date": "2026-01-10", "type": "Work Day", "transferred": False},
        ]
    )
    holidays_csv = tmp_path / "holidays_events.csv"
    holidays_df.to_csv(holidays_csv, index=False)

    # 2. Create synthetic train.csv (Store Sales schema: store_nbr, family, sales, onpromotion)
    train_df = pd.DataFrame(
        [
            {
                "date": "2026-01-05",
                "store_nbr": 1,
                "family": "GROCERY",
                "sales": -10.0,
                "onpromotion": 0,
            },
            {
                "date": "2026-01-07",
                "store_nbr": 1,
                "family": "GROCERY",
                "sales": 20.0,
                "onpromotion": 1,
            },
            {
                "date": "2026-01-10",
                "store_nbr": 1,
                "family": "GROCERY",
                "sales": 5.0,
                "onpromotion": 0,
            },
        ]
    )
    train_csv = tmp_path / "train.csv"
    train_df.to_csv(train_csv, index=False)

    out_dir = tmp_path / "favorita_out"
    manifest = sample_favorita_benchmark(
        train_csv=train_csv,
        output_dir=out_dir,
        holidays_csv=holidays_csv,
        max_series=10,
        min_days=1,
        seed=42,
    )

    sample_parquet = out_dir / "favorita_sample.parquet"
    assert sample_parquet.exists()
    assert sha256_file(sample_parquet) == manifest["sample_sha256"]

    sample_df = pd.read_parquet(sample_parquet)

    # Invariant: 6 total calendar days (Jan 5 through Jan 10)
    assert len(sample_df) == 6

    # Invariant: Negative sales clipped to 0.0
    jan5_row = sample_df[sample_df["date"] == pd.to_datetime("2026-01-05").date()].iloc[0]
    assert jan5_row["recorded_sales"] == 0.0, "Returns must be clipped to 0.0"
    assert not jan5_row["is_festival"], "Transferred holiday date must not be marked is_festival"

    # Invariant: Transfer date marked festival
    jan7_row = sample_df[sample_df["date"] == pd.to_datetime("2026-01-07").date()].iloc[0]
    assert jan7_row["recorded_sales"] == 20.0
    assert jan7_row["is_festival"], "Transferred destination date must be marked is_festival"

    # Invariant: Missing dates filled with 0.0
    jan6_row = sample_df[sample_df["date"] == pd.to_datetime("2026-01-06").date()].iloc[0]
    assert jan6_row["recorded_sales"] == 0.0, "Gaps must be filled with 0.0 sales"

    # Invariant: Work Day not marked festival
    jan10_row = sample_df[sample_df["date"] == pd.to_datetime("2026-01-10").date()].iloc[0]
    assert not jan10_row["is_festival"], "Work Day must not be marked is_festival"


def test_5_cli_smoke_test(tmp_path: Path):
    """Test 5: CLI runner executes generate and verify end-to-end with exit code 0."""
    out_dir = tmp_path / "cli_out"
    cfg_file = CONFIGS_DIR / "preset_10.yaml"

    # 1. Run generate command
    res_gen = runner.invoke(
        app,
        ["generate", "--config", str(cfg_file), "--out", str(out_dir), "--format", "parquet"],
    )
    assert res_gen.exit_code == 0, f"Generate CLI failed: {res_gen.stdout}"
    assert (out_dir / "manifest.json").exists()
    assert (out_dir / "daily_sales.parquet").exists()

    # 2. Run verify command
    res_ver = runner.invoke(app, ["verify", "--dir", str(out_dir)])
    assert res_ver.exit_code == 0, f"Verify CLI failed: {res_ver.stdout}"
    assert "PASSED" in res_ver.stdout
