import pino from 'pino';
import type { GroupBuyService } from './groupbuy.service';

export class GroupBuySchedulerWorker {
  private readonly logger = pino({ name: 'groupbuy-scheduler' });
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;
  private stopped = true;

  constructor(
    private readonly groupBuyService: GroupBuyService,
    private readonly pollIntervalMs = 15_000,
  ) {}

  onApplicationBootstrap(): void {
    this.start();
  }

  async onApplicationShutdown(): Promise<void> {
    await this.stop();
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule(this.pollIntervalMs);
    this.logger.info({ pollIntervalMs: this.pollIntervalMs }, 'GroupBuy scheduler started');
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.inFlight?.catch(() => undefined);
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.inFlight = this.tick().finally(() => {
        this.inFlight = null;
      });
    }, delayMs);
  }

  private async tick(): Promise<void> {
    try {
      await this.groupBuyService.processDueWindows();
    } catch (err) {
      this.logger.warn({ err: (err as Error).message }, 'GroupBuy scheduler tick failed');
    }
    this.schedule(this.pollIntervalMs);
  }
}
