import json
from hashlib import sha256
from pathlib import Path
from typing import Literal

import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq
from pydantic import BaseModel

from .config import SimulatorConfig
from .generator import SimulatedDataset

ExportFormat = Literal["parquet", "csv"]


class FileArtifact(BaseModel):
    filename: str
    rows: int
    size_bytes: int
    sha256: str


class ExportManifest(BaseModel):
    version: str
    seed: int
    config_hash: str
    format: ExportFormat
    files: dict[str, FileArtifact]


def compute_config_hash(cfg: SimulatorConfig) -> str:
    """Canonical SHA-256 of the validated SimulatorConfig JSON (sorted keys, compact separators)."""
    canonical = json.dumps(cfg.model_dump(mode="json"), sort_keys=True, separators=(",", ":"))
    return sha256(canonical.encode("utf-8")).hexdigest()


def sha256_file(path: Path) -> str:
    """Stream-hash a file in 1 MB chunks so 4.5M-row preset_500 files stay memory-safe."""
    h = sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def _write_deterministic_frame(df: pd.DataFrame, path: Path, fmt: ExportFormat) -> None:
    """Write DataFrame deterministically:

    - For 'parquet': convert via pa.Table.from_pandas(df, preserve_index=False) and write with
      pq.write_table(..., version='2.6', compression='snappy', use_dictionary=True).
    - For 'csv': write with df.to_csv(path, index=False, lineterminator='\\n').
    """
    if fmt == "parquet":
        table = pa.Table.from_pandas(df, preserve_index=False)
        pq.write_table(
            table,
            path,
            version="2.6",
            compression="snappy",
            use_dictionary=True,
        )
    elif fmt == "csv":
        df.to_csv(path, index=False, lineterminator="\n")
    else:
        raise ValueError(f"Unsupported export format: {fmt}")


def export_dataset(
    cfg: SimulatorConfig,
    dataset: SimulatedDataset,
    output_dir: str | Path,
    fmt: ExportFormat = "parquet",
) -> ExportManifest:
    """Sort all 4 tables canonically, write them to `output_dir`, compute SHA-256 checksums,

    and write `manifest.json` (sorted keys, indent=2, trailing newline).
    """
    out = Path(output_dir)
    out.mkdir(parents=True, exist_ok=True)

    ext = "parquet" if fmt == "parquet" else "csv"

    # 1. Canonical sort on all 4 tables
    sorted_shops = dataset.shops.sort_values(by=["shop_idx"]).reset_index(drop=True)
    sorted_products = dataset.products.sort_values(by=["product_idx"]).reset_index(drop=True)
    sorted_batches = dataset.initial_batches.sort_values(
        by=["shop_idx", "product_idx"]
    ).reset_index(drop=True)
    sorted_sales = dataset.daily_sales.sort_values(
        by=["shop_idx", "product_idx", "date"]
    ).reset_index(drop=True)

    tables: dict[str, pd.DataFrame] = {
        "shops": sorted_shops,
        "products": sorted_products,
        "initial_batches": sorted_batches,
        "daily_sales": sorted_sales,
    }

    files: dict[str, FileArtifact] = {}

    for table_name, df in tables.items():
        filename = f"{table_name}.{ext}"
        target_path = out / filename
        _write_deterministic_frame(df, target_path, fmt)

        file_sha = sha256_file(target_path)
        size_bytes = target_path.stat().st_size
        files[table_name] = FileArtifact(
            filename=filename,
            rows=len(df),
            size_bytes=size_bytes,
            sha256=file_sha,
        )

    manifest = ExportManifest(
        version=cfg.version,
        seed=cfg.seed,
        config_hash=compute_config_hash(cfg),
        format=fmt,
        files=files,
    )

    manifest_json = json.dumps(manifest.model_dump(mode="json"), indent=2, sort_keys=True) + "\n"
    (out / "manifest.json").write_text(manifest_json, encoding="utf-8")

    return manifest


def verify_manifest(output_dir: str | Path) -> tuple[bool, list[str]]:
    """Load `manifest.json` from `output_dir`, verify every listed file exists and matches

    its recorded SHA-256 digest and byte size. Return (is_valid, error_messages).
    """
    out = Path(output_dir)
    manifest_path = out / "manifest.json"

    if not manifest_path.exists():
        return False, [f"Manifest file missing at {manifest_path}"]

    try:
        raw_manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest = ExportManifest.model_validate(raw_manifest)
    except Exception as exc:  # noqa: BLE001
        return False, [f"Failed to parse manifest.json: {exc}"]

    errors: list[str] = []

    for key, artifact in manifest.files.items():
        file_path = out / artifact.filename
        if not file_path.exists():
            errors.append(f"File {artifact.filename} ({key}) is missing")
            continue

        actual_size = file_path.stat().st_size
        if actual_size != artifact.size_bytes:
            errors.append(
                f"File {artifact.filename} size mismatch: expected {artifact.size_bytes}, "
                f"got {actual_size}"
            )

        actual_sha = sha256_file(file_path)
        if actual_sha != artifact.sha256:
            errors.append(
                f"File {artifact.filename} SHA-256 mismatch: expected {artifact.sha256}, "
                f"got {actual_sha}"
            )

    return len(errors) == 0, errors
