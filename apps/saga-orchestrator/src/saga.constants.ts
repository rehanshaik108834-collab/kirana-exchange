export const SAGA_EVENTS_QUEUE = 'saga.orchestrator.events';
export const SAGA_CONSUMER_NAME = 'saga-orchestrator-consumer';

// Domain events consumed from swap-service & inventory-service
export const EVT_OFFER_ACCEPTED = 'swap.offer.accepted.v1';
export const EVT_STOCK_RESERVED = 'inventory.stock.reserved.v1';
export const EVT_STOCK_RESERVE_FAILED = 'inventory.stock.reserve_failed.v1';
export const EVT_STOCK_RELEASED = 'inventory.stock.released.v1';
export const EVT_TRANSFER_COMMITTED = 'inventory.transfer.committed.v1';
export const EVT_TRANSFER_FAILED = 'inventory.transfer.failed.v1';

// Commands dispatched to inventory-service via kirana.saga.commands
export const CMD_RESERVE_STOCK = 'inventory.cmd.reserve_stock.v1';
export const CMD_RELEASE_STOCK = 'inventory.cmd.release_stock.v1';
export const CMD_COMMIT_TRANSFER = 'inventory.cmd.commit_transfer.v1';

// Delayed step timeout messages routed via RabbitMQ TTL + DLX back into SAGA_EVENTS_QUEUE
export const EVT_TIMEOUT_RESERVE = 'saga.timeout.reserve.v1';
export const EVT_TIMEOUT_HANDOVER = 'saga.timeout.handover.v1';
export const EVT_TIMEOUT_COMMIT = 'saga.timeout.commit.v1';

export const TIMEOUT_QUEUE_RESERVE = 'saga.timeout.reserve';
export const TIMEOUT_QUEUE_HANDOVER = 'saga.timeout.handover';
export const TIMEOUT_QUEUE_COMMIT = 'saga.timeout.commit';

export const RESERVE_TIMEOUT_MS = Number(process.env.SAGA_RESERVE_TIMEOUT_MS || 30_000);
export const HANDOVER_TIMEOUT_MS = Number(process.env.SAGA_HANDOVER_TIMEOUT_MS || 86_400_000);
export const COMMIT_TIMEOUT_MS = Number(process.env.SAGA_COMMIT_TIMEOUT_MS || 60_000);

// Outbound domain events published on kirana.events
export const EVT_HANDOVER_READY = 'saga.handover.ready.v1';
export const EVT_HANDOVER_CONFIRMED = 'saga.handover.confirmed.v1';
export const EVT_SWAP_COMPLETED = 'saga.swap.completed.v1';
export const EVT_SWAP_CANCELLED = 'saga.swap.cancelled.v1';

export const SAGA_EVENT_BINDING_KEYS = [
  EVT_OFFER_ACCEPTED,
  EVT_STOCK_RESERVED,
  EVT_STOCK_RESERVE_FAILED,
  EVT_STOCK_RELEASED,
  EVT_TRANSFER_COMMITTED,
  EVT_TRANSFER_FAILED,
];

export const SSE_SWAP_CHANNEL_PREFIX = 'sse:swap:';
export const PIN_CACHE_PREFIX = 'saga:handover_pin:';
