"""CLI entrypoint for running the Kirana Swap Matcher RabbitMQ worker."""

import asyncio
import contextlib
import signal

import structlog

from .worker import SwapMatcherWorker

logger = structlog.get_logger("swap.matcher.main")


async def _serve() -> None:
    worker = SwapMatcherWorker()
    stop_event = asyncio.Event()
    loop = asyncio.get_running_loop()

    for sig in (signal.SIGINT, signal.SIGTERM):
        with contextlib.suppress(NotImplementedError):
            loop.add_signal_handler(sig, stop_event.set)

    await worker.start_consuming()
    logger.info("Swap matcher worker running")
    try:
        await stop_event.wait()
    finally:
        await worker.close()
        logger.info("Swap matcher worker stopped cleanly")


def main() -> None:
    with contextlib.suppress(KeyboardInterrupt):
        asyncio.run(_serve())


if __name__ == "__main__":
    main()
