/**
 * Creates a platform admin. Self-registration can never create admins (RegisterDto), so this
 * operator-only script, which needs direct auth_db access, is the only path.
 *
 * Usage (after `pnpm --filter @kirana/auth-service build`):
 *   ADMIN_EMAIL=ops@example.com ADMIN_PASSWORD='long-secret' pnpm --filter @kirana/auth-service create-admin
 */
import * as argon2 from 'argon2';
import { Client } from 'pg';
import pino from 'pino';

const logger = pino({ name: 'create-admin' });

async function main(): Promise<void> {
  const email = process.env.ADMIN_EMAIL?.trim();
  const password = process.env.ADMIN_PASSWORD ?? '';
  if (!email || password.length < 12) {
    throw new Error('Set ADMIN_EMAIL and ADMIN_PASSWORD (at least 12 characters)');
  }

  const client = new Client({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 5432),
    user: process.env.DB_USER || 'kirana_admin',
    password: process.env.DB_PASSWORD || 'secretpassword',
    database: process.env.DB_NAME || 'auth_db',
  });
  await client.connect();
  try {
    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
    const result = await client.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role) VALUES ($1, $2, 'admin') RETURNING id`,
      [email, passwordHash],
    );
    logger.info({ correlationId: 'create-admin', userId: result.rows[0].id }, 'Admin created');
  } finally {
    await client.end();
  }
}

main().catch((err: Error & { code?: string }) => {
  logger.error(
    {
      correlationId: 'create-admin',
      err: err.code === '23505' ? 'A user with this email already exists' : err.message,
    },
    'Admin creation failed',
  );
  process.exit(1);
});
