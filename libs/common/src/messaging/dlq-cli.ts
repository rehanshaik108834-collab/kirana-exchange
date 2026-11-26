import { connect } from 'amqplib';
import { inspectDlqMessages, KNOWN_DLQ_QUEUES, replayDlqMessages } from './dlq-replay';

function parseFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

async function runCli(argv: string[]): Promise<void> {
  const [command, queue, ...rest] = argv;

  if (!command || command === '--help' || command === '-h') {
    console.log(
      [
        'Kirana Exchange DLQ Inspection & Replay CLI',
        'Usage:',
        '  node dist/messaging/dlq-cli.js list',
        '  node dist/messaging/dlq-cli.js inspect <queue.dlq> [--limit 20]',
        '  node dist/messaging/dlq-cli.js replay <queue.dlq> [--limit 50] [--message-id <uuid>] [--event-type <type>] [--dry-run]',
      ].join('\n'),
    );
    return;
  }

  if (command === 'list') {
    console.log(JSON.stringify({ knownDlqQueues: KNOWN_DLQ_QUEUES }, null, 2));
    return;
  }

  if (!queue) {
    throw new Error(`Command '${command}' requires a <queue.dlq> argument`);
  }

  const amqpUrl = process.env.AMQP_URL || 'amqp://kirana_admin:secretpassword@127.0.0.1:5672';
  const connection = await connect(amqpUrl);

  try {
    if (command === 'inspect') {
      const channel = await connection.createChannel();
      const limitRaw = parseFlag(rest, '--limit');
      const items = await inspectDlqMessages(channel, queue, limitRaw ? Number(limitRaw) : 20);
      console.log(
        JSON.stringify({ dlqQueue: queue, count: items.length, messages: items }, null, 2),
      );
      await channel.close();
      return;
    }

    if (command === 'replay') {
      const channel = await connection.createConfirmChannel();
      const limitRaw = parseFlag(rest, '--limit');
      const summary = await replayDlqMessages(channel, queue, {
        limit: limitRaw ? Number(limitRaw) : 50,
        messageId: parseFlag(rest, '--message-id'),
        eventType: parseFlag(rest, '--event-type'),
        targetQueue: parseFlag(rest, '--target-queue'),
        replayedBy: parseFlag(rest, '--operator') || 'dlq-cli',
        dryRun: rest.includes('--dry-run'),
      });
      console.log(JSON.stringify(summary, null, 2));
      await channel.close();
      return;
    }

    throw new Error(`Unknown command '${command}'. Expected: list | inspect | replay`);
  } finally {
    await connection.close();
  }
}

runCli(process.argv.slice(2)).catch((err) => {
  console.error(`DLQ CLI error: ${(err as Error).message}`);
  process.exit(1);
});
