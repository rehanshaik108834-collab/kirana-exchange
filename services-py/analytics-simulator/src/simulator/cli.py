from pathlib import Path
from typing import Annotated

import typer
from rich.console import Console

from .benchmark_sampler import sample_favorita_benchmark
from .config import load_config
from .exporter import ExportFormat, export_dataset, verify_manifest
from .generator import run_simulation

app = typer.Typer(name="simulator", help="Kirana Exchange Analytics Simulator CLI")
console = Console()


@app.command()
def generate(
    config: Annotated[
        Path,
        typer.Option("--config", "-c", help="Path to YAML preset config file"),
    ],
    out: Annotated[
        Path,
        typer.Option("--out", "-o", help="Output directory for exported files"),
    ],
    format: Annotated[
        str,
        typer.Option("--format", "-f", help="Export format: parquet or csv"),
    ] = "parquet",
) -> None:
    """Generate synthetic kirana shop, SKU, and daily sales data and write with manifest."""
    if format not in ("parquet", "csv"):
        console.print(f"[bold red]Error: Invalid format '{format}'. Must be 'parquet' or 'csv'.[/]")
        raise typer.Exit(code=1)

    export_fmt: ExportFormat = "parquet" if format == "parquet" else "csv"

    console.print(f"[bold blue]Loading configuration from:[/] {config}")
    cfg = load_config(config)

    console.print(
        f"[bold blue]Running simulation:[/] {cfg.shop_count} shops, "
        f"{cfg.skus_per_shop} SKUs, {cfg.days} days (seed={cfg.seed})"
    )
    dataset = run_simulation(cfg)

    console.print(f"[bold blue]Exporting dataset ({format}) to:[/] {out}")
    manifest = export_dataset(cfg, dataset, out, fmt=export_fmt)

    console.print(
        f"[bold green]Generation complete![/] Config SHA-256: {manifest.config_hash[:12]}..."
    )
    for artifact in manifest.files.values():
        kb = artifact.size_bytes / 1024
        console.print(f"  - [cyan]{artifact.filename}[/]: {artifact.rows:,} rows ({kb:.1f} KB)")


@app.command()
def verify(
    dir: Annotated[
        Path,
        typer.Option("--dir", "-d", help="Directory containing dataset and manifest.json"),
    ],
) -> None:
    """Verify that all files in a dataset match their recorded SHA-256 digest and byte size."""
    console.print(f"[bold blue]Verifying dataset in:[/] {dir}")
    is_valid, errors = verify_manifest(dir)

    if not is_valid:
        console.print("[bold red]Manifest verification FAILED:[/]")
        for err in errors:
            console.print(f"  [red]✗ {err}[/]")
        raise typer.Exit(code=1)

    console.print(
        "[bold green]✓ Manifest verification PASSED: All files match SHA-256 checksums.[/]"
    )


@app.command("sample-benchmark")
def sample_benchmark(
    train: Annotated[
        Path,
        typer.Option("--train", "-t", help="Path to Favorita train.csv"),
    ],
    out: Annotated[
        Path,
        typer.Option("--out", "-o", help="Output directory for benchmark Parquet"),
    ],
    holidays: Annotated[
        Path | None,
        typer.Option("--holidays", help="Path to Favorita holidays_events.csv"),
    ] = None,
    max_series: Annotated[
        int,
        typer.Option("--max-series", help="Maximum series to sample"),
    ] = 50,
    min_days: Annotated[
        int,
        typer.Option("--min-days", help="Minimum day span required per series"),
    ] = 180,
    seed: Annotated[
        int,
        typer.Option("--seed", help="Random seed for deterministic sampling"),
    ] = 42,
) -> None:
    """Deterministically sample Kaggle Favorita / Store Sales data into Phase 8 backtest schema."""
    if not train.exists():
        console.print(f"[bold red]Error: Source training file not found at {train}[/]")
        raise typer.Exit(code=1)

    console.print(f"[bold blue]Sampling Favorita benchmark from:[/] {train}")
    manifest = sample_favorita_benchmark(
        train_csv=train,
        output_dir=out,
        holidays_csv=holidays,
        max_series=max_series,
        min_days=min_days,
        seed=seed,
    )

    console.print("[bold green]Benchmark sampling complete![/]")
    console.print(
        f"  - Sample: [cyan]{manifest['sample_filename']}[/] "
        f"({manifest['row_count']:,} rows, {manifest['series_count']} series)"
    )
    console.print(f"  - SHA-256: {manifest['sample_sha256']}")


if __name__ == "__main__":
    app()
