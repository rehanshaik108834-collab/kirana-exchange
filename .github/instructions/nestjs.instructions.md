---
applyTo:
  - 'apps/**/*.ts'
  - 'libs/**/*.ts'
---

# NestJS & TypeScript Rules

- Validate all incoming DTOs with `class-validator` (`whitelist: true`, `forbidNonWhitelisted: true`).
- Use TypeORM `@VersionColumn()` for optimistic concurrency and explicit database migrations (never `synchronize: true`).
- Log structured JSON with Pino including `correlationId` on every log line; never use `console.log`.
- Throw domain exceptions that map cleanly to the global RFC 9457 `application/problem+json` exception filter.
